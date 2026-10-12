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
