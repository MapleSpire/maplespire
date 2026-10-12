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

import type { Pool, PoolClient } from 'pg'

/**
 * Ordered, recorded, single-writer schema migrations.
 *
 * Idempotent `ensure*Schema()` functions (`CREATE TABLE IF NOT EXISTS`) cannot,
 * on their own:
 *
 *  - **record what ran**, so there is no way to tell a database that is behind
 *    this build from one that is ahead of it;
 *  - **serialise concurrent boots** — two servers issuing the same DDL against
 *    the same catalog can hit 'deadlock detected';
 *  - **host a non-idempotent change**, such as a three-phase migration (add +
 *    backfill, dual-write, switch the read) whose deploys must each know which
 *    phase the database is in.
 *
 * The existing DDL is adopted as a BASELINE rather than rewritten: migration
 * `0001-baseline` (see `schemaMigrations.ts`) calls those `ensure*Schema`
 * functions. On an existing database it is a no-op that writes a ledger row; on
 * a fresh one it builds everything.
 */

/**
 * Stable, arbitrary. Changing it would let two versions migrate concurrently.
 *
 * Exported so a test can assert the lock is FREE from another connection: a
 * session-level advisory lock is re-entrant, so a leak checked from the same
 * pooled connection re-acquires happily and reports success.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 7_243_119_001

export interface Migration {
  /** Ordered and unique, e.g. `0002-projector-instances`. Never renamed once
   * shipped: the id IS the ledger key, so renaming re-runs it. */
  id: string
  run: (client: PoolClient) => Promise<void>
  /**
   * Set for DDL Postgres refuses to run inside a transaction — `CREATE INDEX
   * CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`. The ledger row is then written
   * AFTER the migration commits, so a crash in between re-runs it: a
   * non-transactional migration MUST be idempotent, and there is no way to make
   * that the runner's problem instead of the author's.
   */
  transactional?: boolean
  /**
   * Runs on EVERY boot instead of once. For idempotent bootstrap DDL only.
   *
   * The baseline `ensure*Schema` functions must keep running every boot: adding
   * an `ADD COLUMN IF NOT EXISTS` inside one of them is how columns get added,
   * and recording them as applied-once would silently skip that new DDL.
   * Non-idempotent changes get their own numbered, run-once migration. The
   * ledger row is upserted so `applied_at` reflects the last run.
   */
  repeatable?: boolean
}

export interface MigrationOutcome {
  applied: string[]
  alreadyApplied: string[]
  /** Repeatable migrations re-run this boot. */
  repeated: string[]
  /** Ledger rows this build does not know about — the database is AHEAD of this
   * server. Normal for a few seconds during a rolling deploy, and a real signal
   * if it persists or appears after a rollback. */
  unknown: string[]
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL,
      applied_by TEXT
    )
  `)
}

/**
 * Apply every migration the database has not recorded, under an advisory lock.
 *
 * The lock is held on ONE dedicated connection for the whole run, so a second
 * booting server blocks here instead of issuing the same DDL concurrently, and
 * proceeds afterwards seeing every migration already applied. It is released in
 * a `finally`; a process killed mid-run drops it with the connection, so a lock
 * can never outlive its holder and wedge future deploys.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[],
  options: { appliedBy?: string; log?: (message: string) => void } = {},
): Promise<MigrationOutcome> {
  const log = options.log ?? ((message: string) => console.log(message))
  const duplicate = migrations.find((migration, index) => migrations.findIndex((m) => m.id === migration.id) !== index)
  if (duplicate) {
    // Two migrations sharing an id means one of them silently never runs, so
    // fail at boot.
    throw new Error(`duplicate migration id: ${duplicate.id}`)
  }

  const client = await pool.connect()
  const applied: string[] = []
  const alreadyApplied: string[] = []
  const repeated: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
    try {
      await ensureLedger(client)
      const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations')
      const recorded = new Set(rows.map((row) => row.id))
      const known = new Set(migrations.map((migration) => migration.id))
      const unknown = [...recorded].filter((id) => !known.has(id)).sort()
      if (unknown.length > 0) {
        log(`[migrations] database has ${unknown.length} migration(s) this build does not know: ${unknown.join(', ')}`)
      }

      for (const migration of migrations) {
        const seen = recorded.has(migration.id)
        if (seen && !migration.repeatable) {
          alreadyApplied.push(migration.id)
          continue
        }
        const startedAt = Date.now()
        const record = `INSERT INTO schema_migrations (id, duration_ms, applied_by) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET applied_at = now(), duration_ms = EXCLUDED.duration_ms,
                                            applied_by = EXCLUDED.applied_by`
        if (migration.transactional !== false) {
          // The migration and its ledger row commit together, so the ledger can
          // never claim a migration that rolled back.
          await client.query('BEGIN')
          try {
            await migration.run(client)
            await client.query(record, [migration.id, Date.now() - startedAt, options.appliedBy ?? null])
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw new Error(`migration ${migration.id} failed`, { cause: error })
          }
        } else {
          try {
            await migration.run(client)
          } catch (error) {
            throw new Error(`migration ${migration.id} failed`, { cause: error })
          }
          await client.query(record, [migration.id, Date.now() - startedAt, options.appliedBy ?? null])
        }
        if (migration.repeatable) {
          repeated.push(migration.id)
        } else {
          applied.push(migration.id)
          log(`[migrations] applied ${migration.id} in ${Date.now() - startedAt}ms`)
        }
      }
      return { applied, alreadyApplied, repeated, unknown }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {})
    }
  } finally {
    client.release()
  }
}
