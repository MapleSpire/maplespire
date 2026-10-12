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

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations, type Migration } from './migrations.js'
import { guardIdleClientErrors } from './poolErrorGuard.js'

/**
 * Against a real Postgres, because two of the three things this module claims
 * are properties of Postgres rather than of the function body: `pg_advisory_lock`
 * actually serialising two connections, and a failed migration rolling back with
 * its ledger row. A fake pool would agree with any implementation.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
const SCHEMA = 'migrations_test'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL,
    max: 4,
    connectionTimeoutMillis: 4000,
    options: `-c search_path=${SCHEMA}`,
  }), 'migrations:p')
  try {
    const bootstrap = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 4000 }), 'migrations:bootstrap')
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    } finally {
      await bootstrap.end().catch(() => {})
    }
    await p.query('SELECT 1')
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[migrations] no Postgres at ${URL} — skipping`)

const silent = () => {}

suite('schema migration runner', () => {
  beforeEach(async () => {
    await pool!.query(`DROP TABLE IF EXISTS schema_migrations, widget, gadget`)
  })

  afterAll(async () => {
    const client = await pool!.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      client.release()
      await pool!.end()
    }
  })

  it('applies pending migrations in order and records them', async () => {
    const order: string[] = []
    const migrations: Migration[] = [
      { id: '0001-a', run: async (c) => { order.push('a'); await c.query('CREATE TABLE widget (id INT)') } },
      { id: '0002-b', run: async (c) => { order.push('b'); await c.query('CREATE TABLE gadget (id INT)') } },
    ]

    const outcome = await runMigrations(pool!, migrations, { log: silent })

    expect(order).toEqual(['a', 'b'])
    expect(outcome.applied).toEqual(['0001-a', '0002-b'])
    const { rows } = await pool!.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')
    expect(rows.map((row) => row.id)).toEqual(['0001-a', '0002-b'])
  })

  it('does not re-run a recorded migration', async () => {
    let runs = 0
    const migrations: Migration[] = [{ id: '0001-a', run: async () => { runs += 1 } }]

    await runMigrations(pool!, migrations, { log: silent })
    const second = await runMigrations(pool!, migrations, { log: silent })

    expect(runs).toBe(1)
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toEqual(['0001-a'])
  })

  it('re-runs a repeatable migration every time, and refreshes its ledger row', async () => {
    // The property the baseline depends on: `ensure*Schema` running on every
    // boot is how columns get added, so recording it applied-once would
    // silently disable the next `ADD COLUMN IF NOT EXISTS` someone writes.
    let runs = 0
    const migrations: Migration[] = [{ id: '0001-baseline', repeatable: true, run: async () => { runs += 1 } }]

    await runMigrations(pool!, migrations, { log: silent })
    const first = await pool!.query<{ applied_at: Date }>('SELECT applied_at FROM schema_migrations')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await runMigrations(pool!, migrations, { log: silent })

    expect(runs).toBe(2)
    expect(second.repeated).toEqual(['0001-baseline'])
    expect(second.applied).toEqual([])
    const after = await pool!.query<{ applied_at: Date }>('SELECT applied_at FROM schema_migrations')
    expect(after.rows[0].applied_at.getTime()).toBeGreaterThan(first.rows[0].applied_at.getTime())
  })

  it('a failed migration rolls back and is NOT recorded', async () => {
    // The ledger must never claim work that did not land, or the next deploy
    // skips a migration that never ran — which is worse than failing to boot.
    const migrations: Migration[] = [
      { id: '0001-a', run: async (c) => { await c.query('CREATE TABLE widget (id INT)') } },
      { id: '0002-boom', run: async (c) => {
        await c.query('CREATE TABLE gadget (id INT)')
        throw new Error('backfill exploded')
      } },
    ]

    await expect(runMigrations(pool!, migrations, { log: silent })).rejects.toThrow('migration 0002-boom failed')

    const recorded = await pool!.query<{ id: string }>('SELECT id FROM schema_migrations')
    expect(recorded.rows.map((row) => row.id)).toEqual(['0001-a'])
    // …and its DDL went with it.
    const gadget = await pool!.query<{ exists: string | null }>(`SELECT to_regclass('${SCHEMA}.gadget')::text AS exists`)
    expect(gadget.rows[0].exists).toBeNull()
  })

  it('serialises concurrent runners, so only one applies each migration', async () => {
    // Two servers booting together is the ordinary case in a rolling deploy, and
    // concurrent DDL against the same catalog can hit 'deadlock detected'.
    let runs = 0
    const slow: Migration[] = [{
      id: '0001-slow',
      run: async (c) => {
        runs += 1
        await c.query('CREATE TABLE widget (id INT)')
        await new Promise((resolve) => setTimeout(resolve, 250))
      },
    }]

    const [first, second] = await Promise.all([
      runMigrations(pool!, slow, { log: silent }),
      runMigrations(pool!, slow, { log: silent }),
    ])

    expect(runs).toBe(1)
    // Whichever lost the race saw it already applied rather than doing it again.
    const appliedCount = first.applied.length + second.applied.length
    expect(appliedCount).toBe(1)
    expect(first.alreadyApplied.length + second.alreadyApplied.length).toBe(1)
  })

  it('releases the advisory lock even when a migration throws', async () => {
    // A lock left held wedges every future deploy, and the failure looks like
    // "Postgres not ready" — a boot hang with a misleading message.
    const boom: Migration[] = [{ id: '0001-boom', run: async () => { throw new Error('nope') } }]
    await expect(runMigrations(pool!, boom, { log: silent })).rejects.toThrow()

    // From a SEPARATE connection, deliberately. Advisory locks are session
    // level and re-entrant, so asking the same pooled connection whether the
    // lock is free answers yes even while it still holds it.
    const observer = new pg.Client({ connectionString: URL })
    await observer.connect()
    try {
      const { rows } = await observer.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [MIGRATION_ADVISORY_LOCK_KEY],
      )
      expect(rows[0].acquired).toBe(true)
      await observer.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
    } finally {
      await observer.end().catch(() => {})
    }

    const ok: Migration[] = [{ id: '0001-ok', run: async () => {} }]
    await expect(runMigrations(pool!, ok, { log: silent })).resolves.toMatchObject({ applied: ['0001-ok'] })
  })

  it('reports ledger rows this build does not know about', async () => {
    // An older server booting against a newer database — normal for seconds
    // during a rolling deploy, a real signal if it persists or follows a rollback.
    await runMigrations(pool!, [{ id: '0001-a', run: async () => {} }, { id: '0002-b', run: async () => {} }], { log: silent })

    const older = await runMigrations(pool!, [{ id: '0001-a', run: async () => {} }], { log: silent })

    expect(older.unknown).toEqual(['0002-b'])
  })

  it('refuses a duplicate id instead of silently running one of them', async () => {
    const migrations: Migration[] = [
      { id: '0001-a', run: async () => {} },
      { id: '0001-a', run: async () => {} },
    ]
    await expect(runMigrations(pool!, migrations, { log: silent })).rejects.toThrow('duplicate migration id: 0001-a')
  })

  it('runs a non-transactional migration and records it', async () => {
    // CREATE INDEX CONCURRENTLY cannot run inside a transaction block — the
    // baseline needs this, and a runner that wraps everything in BEGIN would
    // fail on it at boot.
    const migrations: Migration[] = [{
      id: '0001-concurrent',
      transactional: false,
      run: async (c) => {
        await c.query('CREATE TABLE widget (id INT)')
        await c.query('CREATE INDEX CONCURRENTLY widget_id_idx ON widget (id)')
      },
    }]

    const outcome = await runMigrations(pool!, migrations, { log: silent })
    expect(outcome.applied).toEqual(['0001-concurrent'])
  })
})
