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

import { Pool } from 'pg'
import {
  databasePoolConfig,
  lifecycleApplyDatabasePoolConfig,
  readModelDatabasePoolConfig,
  syncCellDatabasePoolConfig,
} from './dbConfig.js'
import { guardIdleClientErrors } from './db/poolErrorGuard.js'

export const pool = guardIdleClientErrors(new Pool(databasePoolConfig()), 'primary')
export const readModelPool = guardIdleClientErrors(new Pool(readModelDatabasePoolConfig()), 'read-model')
/**
 * The sync-cell coordinator's pool. Separate from `pool` for two
 * reasons, and only the second is about isolation.
 *
 * It carries `statement_timeout` and `lock_timeout` in the connection's startup
 * packet, so every statement the coordinator issues is bounded by PostgreSQL
 * from its first byte. Putting those on `pool` would impose them on the whole
 * application — including `CREATE INDEX CONCURRENTLY` in the migrations, which
 * legitimately outlives any ceiling worth setting here.
 *
 * And it is a bulkhead: `DB_POOL_MAX` defaults to 10 while
 * `SYNC_CELL_OWNERSHIP_CONCURRENCY` defaults to 16, so the coordinator alone can
 * ask for more connections than the primary pool has. A blocked reconcile would
 * otherwise hold primary clients while HTTP routes and Automerge storage fail
 * `connectionTimeoutMillis` at 10 s.
 */
export const syncCellPool = guardIdleClientErrors(new Pool(syncCellDatabasePoolConfig()), 'sync-cell')

/**
 * The lifecycle apply lock's pool. On the primary pool, eight concurrent
 * promotions pinned seven clients on the advisory-lock statement (the pin is
 * a 15 s timer, `BASELINE_FENCE_ARMING_BOUND_MS`, not an outage) while LISTEN
 * clients held the rest, and the promotions' own `repo.flush(...)` then
 * failed `connectionTimeoutMillis` and answered 500.
 *
 * The sizing derivation and the rejected semaphore alternative are on
 * `lifecycleApplyDatabasePoolConfig` in `dbConfig.ts`.
 */
export const lifecycleApplyPool = guardIdleClientErrors(
  new Pool(lifecycleApplyDatabasePoolConfig()),
  'lifecycle-apply',
)

// An error on an *idle* pooled client (DB restart, dropped socket, network
// blip) is emitted on the POOL. Without a listener, node-postgres lets it
// bubble up as an uncaught exception and crashes the process. pg already
// discards the bad client; we just log, so a transient blip can't take the
// server down.
//
// `guardIdleClientErrors` is that policy, applied AT CONSTRUCTION so that "is
// this pool guarded" is answerable by reading one expression — which is what
// the gate in `db/poolErrorGuard.test.ts` checks. Every new pool must be
// wrapped the same way.

// Connection-level failures that are safe to retry once with a fresh
// connection: the dead client is discarded by the pool, and a retry transparently
// acquires (or opens) a healthy one. Covers transient TCP resets plus Postgres
// admin/shutdown SQLSTATEs.
const TRANSIENT_DB_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08006', // connection_failure
  '08003', // connection_does_not_exist
])

/**
 * EXPORTED because a caller that hands work to `withDbRetry` must be able to
 * agree with it about which failures are retryable.
 *
 * `PostgresStorageAdapter` releases its client back to the pool in a `finally`.
 * `pg-pool`'s own `Pool.query` releases WITH the error, which discards the
 * client; a bare `release()` puts it back on the idle list, where the very
 * next `connect()` picks it up. That matters for exactly these codes: a
 * server-sent `57P01` arrives through `pg`'s `_handleErrorMessage`, which —
 * unlike `_handleErrorEvent` — does NOT clear `_queryable`. So the dead client
 * looks healthy, and `withDbRetry`'s second attempt would draw the same one.
 *
 * The adapter therefore uses THIS predicate to decide whether to poison the
 * client on release. Sharing the predicate is the point: "we will retry it" and
 * "we must discard the connection first" have to be the same set, and two
 * hand-written lists would drift.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && TRANSIENT_DB_CODES.has(code)
}

/**
 * Run a DB operation, retrying once if the first attempt fails with a transient
 * connection error. The pool discards the dead client before the retry, so the
 * second attempt runs on a healthy connection. Use for self-contained units of
 * work (e.g. a single transaction) that are safe to re-run.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isTransientDbError(err)) throw err
    console.warn('Transient Postgres error; retrying once:', (err as Error).message)
    return await fn()
  }
}

export async function initSchema(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_version ON entities(version)
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_state (
        client_id TEXT PRIMARY KEY,
        last_synced_version INTEGER NOT NULL DEFAULT 0,
        last_synced_at TIMESTAMPTZ
      )
    `)
    // Community theme gallery. Stores untrusted theme source + the
    // base skin config; the code is only ever executed client-side in the worker
    // sandbox, never on the server.
    await client.query(`
      CREATE TABLE IF NOT EXISTS theme_plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        version TEXT NOT NULL,
        sdk_version TEXT NOT NULL,
        code TEXT NOT NULL,
        base_config JSONB NOT NULL,
        price INTEGER NOT NULL DEFAULT 0,
        installs INTEGER NOT NULL DEFAULT 0,
        reports INTEGER NOT NULL DEFAULT 0,
        hidden BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Migrate older installs that predate these columns.
    await client.query(`ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS reports INTEGER NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false`)
    // Public read-only share links. The client materialises a self-contained JSON
    // snapshot of the diagram (or landscape) and stores it here; the server never
    // reads Automerge to serve a share, so only the explicitly-shared subset is
    // ever exposed. The token is the capability — there is no auth on the public
    // GET. `mode='latest'` snapshots are re-published in place; `mode='pinned'`
    // ones are frozen at a checkpoint's heads.
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_links (
        token            TEXT PRIMARY KEY,
        mode             TEXT NOT NULL DEFAULT 'latest',
        scope            TEXT NOT NULL DEFAULT 'diagram',
        diagram_id       TEXT,
        limit_to_diagram BOOLEAN NOT NULL DEFAULT true,
        enabled          BOOLEAN NOT NULL DEFAULT true,
        checkpoint_id    TEXT,
        checkpoint_label TEXT,
        heads            JSONB,
        snapshot         JSONB NOT NULL,
        view_count       INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at       TIMESTAMPTZ
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shared_links_diagram ON shared_links(diagram_id)`)
    // Landscape VERSIONS — named restore points for a whole landscape. A version is
    // a head-MANIFEST (each workspace doc's Automerge heads), captured + restored
    // client-side; the server is a dumb store (opaque JSONB manifest), exactly like
    // shared_links. Scoped by landscape_id.
    await client.query(`
      CREATE TABLE IF NOT EXISTS landscape_versions (
        id           TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        label        TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'named',
        manifest     JSONB NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_landscape_versions_landscape ON landscape_versions(landscape_id, created_at DESC)`
    )
    // Multi-landscape registry. A LANDSCAPE has many editable VERSIONS;
    // each version is its own Automerge root (its own model + diagrams), so you can
    // work in any version independently. `default_version_id` is a pointer to the
    // landscape's primary version — changing it (set-default) removes nothing. The
    // legacy single workspace migrates to the 'default' landscape's 'Main' version.
    await client.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Org ownership. Plain TEXT, no FK: `orgs` belongs to
    // auth/schema.ts and this schema must keep booting without it. NULL means
    // "pre-org row" — backfilled to the Default Org at boot
    // (landscapes.ts backfillLandscapeOrgs); new rows always stamp it.
    await client.query(`ALTER TABLE landscapes ADD COLUMN IF NOT EXISTS org_id TEXT`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_landscapes_org ON landscapes(org_id)`)
    // THE COLUMN THE CELL SOLVER READS.
    //
    // On `landscapes`, NOT on `orgs`: the noisy neighbour cell placement
    // isolates is ONE LANDSCAPE, not an organisation. Under an org-level rule,
    // an org with one large landscape and thirty small ones would earn a
    // dedicated cell for all thirty-one.
    //
    // Two values and nothing else — the solver needs only a hard/soft
    // distinction; billing fields do not belong here. The allowed values are
    // asserted from the CHECK constraint itself in
    // `syncCells/landscapeTier.integration.test.ts` rather than retyped there.
    await client.query(
      `ALTER TABLE landscapes ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard'
         CONSTRAINT landscapes_tier_check CHECK (tier IN ('standard', 'enterprise'))`,
    )
    // A version is normally a real branch (`kind='version'`). A DRAFT is the same
    // row shape with `kind='draft'`: a fork of the landscape's default version that
    // is edited in isolation, has a lifecycle `status` (active=In-progress / merged /
    // discarded=Deleted / archived), and stores `base_manifest` — the PARENT's
    // per-doc heads captured at fork time, the 3-way-merge base.
    await client.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Migrate installs that predate the draft columns.
    await client.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'version'`)
    await client.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`)
    await client.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS base_manifest JSONB`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_versions_landscape ON versions(landscape_id, created_at)`)
    // Automerge document storage. The repo persists each doc as binary chunks
    // (snapshots + incremental changes) keyed by a path-like StorageKey. We store
    // the key as a '/'-joined string (key segments never contain '/') and the
    // chunk as BYTEA. This makes the Postgres server a durable Automerge peer.
    await client.query(`
      CREATE TABLE IF NOT EXISTS automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Existing installations predate GC age admission. Backfill with NOW so
    // every pre-migration chunk receives a full grace period before it can be
    // considered by the global worker.
    await client.query(
      'ALTER TABLE automerge_storage ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'
    )
    await client.query(
      'ALTER TABLE automerge_storage ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'
    )
    const { rows: nullableStorageAgeColumns } = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'automerge_storage'
        AND column_name IN ('created_at', 'updated_at')
        AND is_nullable = 'YES'
    `)
    // Only a partially applied pre-release migration can enter this branch.
    // Avoid a full-table UPDATE and NOT NULL validation on every normal boot.
    if (nullableStorageAgeColumns.length > 0) {
      await client.query(`
        UPDATE automerge_storage
        SET created_at = COALESCE(created_at, NOW()), updated_at = COALESCE(updated_at, NOW())
        WHERE created_at IS NULL OR updated_at IS NULL
      `)
      await client.query('ALTER TABLE automerge_storage ALTER COLUMN created_at SET DEFAULT NOW()')
      await client.query('ALTER TABLE automerge_storage ALTER COLUMN created_at SET NOT NULL')
      await client.query('ALTER TABLE automerge_storage ALTER COLUMN updated_at SET DEFAULT NOW()')
      await client.query('ALTER TABLE automerge_storage ALTER COLUMN updated_at SET NOT NULL')
    }
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automerge_storage_doc_updated
      ON automerge_storage ((split_part(key, '/', 1)), updated_at)
    `)
    // The ARRIVAL WATERMARK clock: a global monotone
    // sequence stamped on every durable chunk write. Unlike updated_at (a
    // transaction-START wall clock), consuming nextval yields an ORDER the
    // read model's absence proof can compare against the value a projection
    // captured at SAMPLING time. Existing rows keep NULL on purpose — they
    // predate the clock and fall back to the timestamp clause until their
    // document is projected once with a watermark.
    await client.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    // ADD then SET DEFAULT, deliberately in two steps: a VOLATILE default on
    // ADD COLUMN makes Postgres rewrite the whole table and stamp every
    // EXISTING row — destroying the "NULL = predates the clock" semantics the
    // fallback depends on, and rewriting a table that can hold millions of
    // chunks on a routine boot. SET DEFAULT applies to future inserts only.
    await client.query(`
      ALTER TABLE automerge_storage ADD COLUMN IF NOT EXISTS arrival_seq BIGINT
    `)
    // Guarded: SET DEFAULT takes an ACCESS EXCLUSIVE lock on the storage
    // table, and replaying it unconditionally would take that lock on EVERY
    // boot.
    const { rows: arrivalDefault } = await client.query<{ column_default: string | null }>(`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'automerge_storage' AND column_name = 'arrival_seq'
    `)
    if (!arrivalDefault[0]?.column_default) {
      await client.query(`
        ALTER TABLE automerge_storage
        ALTER COLUMN arrival_seq SET DEFAULT nextval('automerge_arrival_seq')
      `)
    }
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automerge_storage_doc_arrival
      ON automerge_storage ((split_part(key, '/', 1)), arrival_seq DESC NULLS LAST)
    `)
    // Small key/value store for Automerge bookkeeping — notably the URL of the
    // single shared ROOT document, so every browser opens the same workspace
    // instead of each creating its own and diverging.
    await client.query(`
      CREATE TABLE IF NOT EXISTS automerge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  } finally {
    client.release()
  }
}
