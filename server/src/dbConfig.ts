// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import type { PoolConfig } from 'pg'

type DatabaseEnvironment = Readonly<Record<string, string | undefined>>

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
function sslConfig(mode: string | undefined): PoolConfig['ssl'] {
  switch ((mode ?? 'disable').toLowerCase()) {
    case 'disable':
      return false
    case 'require':
      // Cloud providers use publicly trusted certificates. Keep verification on;
      // callers with a private CA should add it to the container trust store.
      return { rejectUnauthorized: true }
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      throw new Error(`Unsupported DB_SSL_MODE: ${mode}`)
  }
}

/**
 * Build a node-postgres PoolConfig without forcing a provider-specific secret
 * shape. DATABASE_URL remains the local/self-hosted shortcut. Managed runtimes
 * can inject individual DB_* values from their secret manager without ever
 * assembling a credential-bearing URL in an IaC state file.
 */
export function databasePoolConfig(env: DatabaseEnvironment = process.env): PoolConfig {
  const common: PoolConfig = {
    max: positiveInteger(env.DB_POOL_MAX, 10),
    idleTimeoutMillis: positiveInteger(env.DB_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECTION_TIMEOUT_MS, 10_000),
    keepAlive: true,
    ssl: sslConfig(env.DB_SSL_MODE),
  }

  if (env.DATABASE_URL) {
    return { ...common, connectionString: env.DATABASE_URL }
  }

  return {
    ...common,
    host: env.DB_HOST ?? 'localhost',
    port: positiveInteger(env.DB_PORT, 5432),
    database: env.DB_NAME ?? 'maplespire',
    user: env.DB_USER ?? 'maplespire',
    password: env.DB_PASSWORD ?? 'maplespire',
  }
}

/**
 * Keep projection checkpoints and read-model publication out of the FIFO used
 * by Automerge chunk persistence. During a failover hundreds of reconnecting
 * peers can enqueue storage writes at once; sharing the same node-postgres pool
 * made a tiny ModelMeta lookup wait more than a second behind that burst.
 *
 * This is a connection-pool bulkhead, not a second database. Four connections
 * are enough for the bounded projector concurrency and keep the total per cell
 * predictable. Operators can tune it independently when PostgreSQL capacity is
 * known.
 */
export function readModelDatabasePoolConfig(
  env: DatabaseEnvironment = process.env,
): PoolConfig {
  return databasePoolConfig({
    ...env,
    DB_POOL_MAX: env.DB_READ_MODEL_POOL_MAX ?? '4',
  })
}

/**
 * The sync-cell coordinator's own pool, bounded by PostgreSQL itself.
 *
 * ── WHY A SECOND BULKHEAD ───────────────────────────────────────────────────
 *
 * `performReconcile` chains several queries, and `reconcileNow` is
 * single-flight over a promise whose `.finally` cannot run while it is pending.
 * Without a ceiling, one statement blocked on a lock freezes every later pass,
 * silently (`ready` stays true, `errorCount` stays 0).
 *
 * Sharing the primary pool makes that worse. `DB_POOL_MAX` defaults to 10 and
 * `SYNC_CELL_OWNERSHIP_CONCURRENCY` to 16, so the coordinator alone can fan out
 * past the whole pool, and a wedged statement would starve every other borrower
 * (HTTP routes, Automerge storage). Four connections of its own removes that
 * coupling.
 *
 * ── WHY THE BOUND LIVES HERE AND NOT AT THE CALL SITES ──────────────────────
 *
 * node-postgres puts `statement_timeout` and `lock_timeout` in the STARTUP
 * PACKET (`pg/lib/client.js`), so they are the session's defaults from
 * the first byte: zero round trips, and — unlike a mid-session `SET` — nothing
 * a later borrower can inherit, because every connection in this pool is born
 * with them.
 *
 * A per-statement `BEGIN` / `SET LOCAL` / statement / `COMMIT` wrapper is the
 * rejected alternative: it cost x2–x4 on the warm pass and lengthened the cold
 * pass by ~50 %, and on failure it must hand back a client after a `ROLLBACK`
 * that may itself fail, which `pg-pool` neither rolls back nor resets (see
 * `db/statementTimeout.ts`).
 *
 * ── THE TWO CEILINGS ARE DIFFERENT QUESTIONS ────────────────────────────────
 *
 * `lock_timeout` bounds waiting for a LOCK (`55P03`); `statement_timeout` bounds
 * the statement itself (`57014`). The typical wedge is a lock wait, which the
 * smaller of the two clears. Keeping them separate means a legitimately slow
 * cold-start statement still gets the large budget while contention resolves in
 * about two seconds.
 *
 * `statement_timeout` is 30 s against a slowest SINGLE statement of ~181 ms at
 * 10 000 versions (not to be confused with the ~28 s cold PASS, which is
 * thousands of statements). The headroom is deliberately lopsided:
 * too low kills a cold-start statement and the cell never acquires a lease, a
 * total outage; too high leaves a wedge one ceiling longer, degraded and
 * self-healing.
 *
 * NOT applied to DDL. `ensureSyncCellOwnershipSchema` runs on the primary pool
 * on purpose: `CREATE INDEX CONCURRENTLY` legitimately outlives any ceiling
 * worth setting here, and bounding it would turn a slow index build into a boot
 * failure.
 */
export function syncCellDatabasePoolConfig(
  env: DatabaseEnvironment = process.env,
): PoolConfig {
  return {
    // 5 = the 4 working connections every measurement of this pool used (M2,
    // TB4q) + the one LISTEN checkout each ownership coordinator now pins for
    // its whole life (placed mode: placement changes; hash mode, since
    // 2026-10-11: workspace_version_created — ownership.ts `versionCreation`).
    ...databasePoolConfig({ ...env, DB_POOL_MAX: env.SYNC_CELL_DB_POOL_MAX ?? '5' }),
    statement_timeout: positiveInteger(env.SYNC_CELL_STATEMENT_TIMEOUT_MS, 30_000),
    lock_timeout: positiveInteger(env.SYNC_CELL_LOCK_TIMEOUT_MS, 2_000),
  }
}

/**
 * The lifecycle apply lock's own pool.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * `acquireLifecycleApplyLock` pins a client for the whole apply, and
 * `promoteSummaryWorkspace` waits out `BASELINE_FENCE_ARMING_BOUND_MS` (15 s, a
 * pure timer) while holding it, so the holds are long even with Redis healthy.
 * Under eight concurrent promotions on the primary pool, seven clients sat on
 * the lock statement and three more are permanently checked out by `LISTEN`
 * clients (`readModel/changeNotifications.ts`, `auth/wsAuth.ts`,
 * `rbac/workspaceCacheInvalidation.ts`) — 10, the primary `DB_POOL_MAX`
 * default. The promotions' own storage writes then failed to get a connection
 * and answered 500 after `connectionTimeoutMillis`.
 *
 * ── WHY A POOL AND NOT A SEMAPHORE ─────────────────────────────────────────
 *
 * A counter would need releasing on four paths (connect throws, lock refused,
 * lock granted then handed off, client destroyed after a failed query), and a
 * leaked permit is a PERMANENT refusal. A pool does the same accounting with no
 * bookkeeping to leak.
 *
 * `maintenance/degenerateRootRepair.ts` still takes its lock client from the
 * primary pool, because that path runs statements ON the lock session and is
 * reached from an ordinary user request; the reason is in
 * `acquireLifecycleApplyLock`'s docstring.
 *
 * ── THE TWO NUMBERS ────────────────────────────────────────────────────────
 *
 * `max` 4: promotions are platform-admin lifecycle operations, not user traffic.
 * The fifth is REFUSED rather than queued behind the primary pool.
 *
 * `connectionTimeoutMillis` 2 000, against the primary pool's 10 000: fail fast.
 * `acquireLifecycleApplyLock` converts a refusal into
 * `LifecycleApplyRefusedError('pool-exhausted')`, which `routeErrors.ts`
 * answers 503 + `Retry-After: 5` + `retryable: true`.
 *
 * IT ALSO BOUNDS COLD CONNECTION ESTABLISHMENT, not only the queue wait. `pg-pool`
 * applies `connectionTimeoutMillis` to both, and this pool is COLD on nearly
 * every promotion — `min` is 0 and `idleTimeoutMillis` is 30 s, while
 * promotions are rare — so each one pays TCP + TLS + auth inside 2 s where the
 * primary pool has always allowed 10. On a managed Postgres with
 * `DB_SSL_MODE=require` that margin is real, and
 * `LIFECYCLE_APPLY_DB_CONNECTION_TIMEOUT_MS` exists for exactly that deployment.
 * The refusal message says "saturated OR UNREACHABLE" because the two
 * conditions are not distinguishable from the outside.
 */
export function lifecycleApplyDatabasePoolConfig(
  env: DatabaseEnvironment = process.env,
): PoolConfig {
  // SPREAD-AND-OVERRIDE, not a cloned env. Passing
  // `DB_POOL_MAX: env.LIFECYCLE_APPLY_DB_POOL_MAX ?? '4'` would send the value
  // through `positiveInteger(value, 10)`, whose fallback is the PRIMARY pool's
  // default, so a typo (`=0`, `=four`) would silently give this bulkhead the
  // primary pool's numbers. Overriding the resulting config means each knob
  // falls back to ITS OWN default.
  return {
    ...databasePoolConfig(env),
    max: positiveInteger(env.LIFECYCLE_APPLY_DB_POOL_MAX, 4),
    connectionTimeoutMillis: positiveInteger(env.LIFECYCLE_APPLY_DB_CONNECTION_TIMEOUT_MS, 2_000),
  }
}

/** Integer ≥ 0 (0 is PostgreSQL's "no limit"), else the fallback. */
function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/** Every storage-write backend's `application_name` starts with this. */
export const STORAGE_WRITE_APPLICATION_PREFIX = 'ms-storage:'
/** PostgreSQL keeps NAMEDATALEN - 1 bytes of `application_name`. */
const APPLICATION_NAME_MAX = 63

/**
 * The `application_name` of THIS process's storage-write connections:
 * `ms-storage:<cell>:<boot id>`. The boot id (a UUID, `processIdentity.ts`)
 * is what tells two processes apart, including a restart of one cell; the cell
 * id (`SYNC_CELL_ID`, else the host name) is there for the operator, cut to
 * what fits in 63 bytes. What reads it: the handover barrier
 * (`readModel/ordinaryFoldedArrivals.ts`), which waits for the OTHER
 * processes' storage writes only.
 */
export function storageWriteApplicationName(bootId: string, env: DatabaseEnvironment = process.env): string {
  const room = APPLICATION_NAME_MAX - STORAGE_WRITE_APPLICATION_PREFIX.length - 1 - bootId.length
  const cell = (env.SYNC_CELL_ID?.trim() || env.HOSTNAME?.trim() || 'cell')
    .toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, Math.max(0, room)) || 'cell'
  return `${STORAGE_WRITE_APPLICATION_PREFIX}${cell}:${bootId}`.slice(0, APPLICATION_NAME_MAX)
}

/**
 * The Automerge storage adapter's WRITE pool (`PostgresStorageAdapter`'s
 * `writeDb`, wired in `automergeServer.ts`): every chunk save and removal of
 * the sync server, and nothing else. Reads stay on the primary pool.
 *
 * ── WHY A POOL OF ITS OWN (G4-16d) ──────────────────────────────────────────
 *
 * After an ownership handover the new owner's projector must know when the
 * OLD owner's in-flight saves have ended (`ordinaryFoldedArrivals.ts`, THE
 * HANDOVER RESIDUAL). Two things make that knowable, and both need these
 * connections apart from the primary pool's:
 *   - `application_name` (`storageWriteApplicationName`) marks them, so the
 *     new owner waits for them and for nothing else — not `pg_dump`, a
 *     migration's `CREATE INDEX CONCURRENTLY`, a `psql` session or another
 *     service;
 *   - the three ceilings BOUND them, in the startup packet (as
 *     `syncCellDatabasePoolConfig` does, for the reasons written there):
 *     `statement_timeout` (`AM_STORAGE_WRITE_STATEMENT_TIMEOUT_MS`) a save's
 *     statement, `lock_timeout` (`AM_STORAGE_WRITE_LOCK_TIMEOUT_MS`) its lock
 *     waits, and `idle_in_transaction_session_timeout`
 *     (`AM_STORAGE_WRITE_IDLE_IN_TRANSACTION_TIMEOUT_MS`) a transaction left
 *     open by a paused or partitioned client (the test seam's legacy path sets
 *     a shorter one of its own). 0 disables each, as in PostgreSQL. On the
 *     primary pool they would bound every route and every migration.
 *     NOT bounded by any of them: the wait for the commit record's WAL flush
 *     and for synchronous replication — PostgreSQL does not cancel a commit;
 *     and a backend blocked SENDING to a dead client, which only the server's
 *     TCP keepalives (`tcp_keepalives_*`, `tcp_user_timeout`) end.
 *
 * THE VALUES, and what they must clear. The barrier waits at most
 * `AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS` (300 s) for these writes,
 * so a save must end well inside that: 120 s for the statement, 10 s for any
 * one lock wait inside it, 30 s idle in a transaction (a save is ONE
 * autocommit statement; only the test seam's legacy path holds a transaction
 * open). 120 s is far above what a save is expected to take — a chunk upsert
 * is one row — and is the ceiling for the slowest one, a large FIRST save (an
 * import's snapshot, a new fold product) written in one statement: one that
 * outlives it fails, is counted
 * (`maplespire_automerge_storage_write_ceiling_total`, alert
 * `AutomergeStorageWriteCeiling`), and is retried by the adapter, a bounded
 * number of times (`automergeStorage.ts`, `scheduleCeilingRetry`).
 *
 * SIZING: `max` is the adapter's mutation bound (`DEFAULT_STORAGE_DB_CONCURRENCY`,
 * 4, `automergeStorage.ts`), so the number of concurrent writes is what it was
 * on the primary pool; the process holds up to four more connections in all,
 * and the primary pool's four no longer go to writes. Raising
 * `AM_STORAGE_WRITE_DB_POOL_MAX` raises that bound with it (the adapter's
 * permit gate on a dedicated write pool is the pool's own `max`).
 */
export function storageWritePoolConfig(
  applicationName: string,
  env: DatabaseEnvironment = process.env,
): PoolConfig {
  return {
    ...databasePoolConfig(env),
    max: positiveInteger(env.AM_STORAGE_WRITE_DB_POOL_MAX, 4),
    application_name: applicationName,
    statement_timeout: nonNegativeInteger(env.AM_STORAGE_WRITE_STATEMENT_TIMEOUT_MS, 120_000),
    lock_timeout: nonNegativeInteger(env.AM_STORAGE_WRITE_LOCK_TIMEOUT_MS, 10_000),
    idle_in_transaction_session_timeout: nonNegativeInteger(env.AM_STORAGE_WRITE_IDLE_IN_TRANSACTION_TIMEOUT_MS, 30_000),
  }
}
