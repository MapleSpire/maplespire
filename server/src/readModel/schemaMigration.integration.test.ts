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

import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * Legacy-schema migration: `ro_*` is a DERIVED projection (never
 * authoritative), so a legacy install — `ro_objects` present WITHOUT a
 * `landscape_id` column — must be dropped and recreated on `ensureReadModelSchema`,
 * not ALTERed/backfilled (there is no row worth preserving; the projector
 * cold-builds the replacement on its next `ensure()`). Isolated schema; skips
 * when no DB is reachable.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=schemamigration_test,public' }), 'schemaMigration')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS schemamigration_test')
      await c.query('CREATE EXTENSION IF NOT EXISTS pg_trgm') // resolves gin_trgm_ops via public
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

/** DROP the ro_* tables SCHEMA-QUALIFIED, never bare. With `public` still in
 * search_path (needed for pg_trgm's operator class), a bare `DROP TABLE
 * ro_objects` issued BEFORE `schemamigration_test.ro_objects` exists yet would
 * resolve to — and destroy — the REAL `public.ro_objects` every other suite
 * shares. Explicit qualification makes that impossible regardless of ordering. */
async function dropLocalTables(): Promise<void> {
  await pool!.query(
    `DROP TABLE IF EXISTS schemamigration_test.ro_objects, schemamigration_test.ro_connections,
       schemamigration_test.ro_groups, schemamigration_test.ro_diagrams,
       schemamigration_test.ro_object_technologies, schemamigration_test.ro_group_technologies,
       schemamigration_test.ro_object_tags, schemamigration_test.ro_group_tags,
       schemamigration_test.ro_object_teams, schemamigration_test.read_model_projection_state`
  )
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[schema migration] no Postgres at ${URL} — skipping`)

async function columnNames(table: string): Promise<Set<string>> {
  const { rows } = await pool!.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'schemamigration_test' AND table_name = $1`,
    [table]
  )
  return new Set(rows.map((r) => r.column_name))
}

async function primaryKeyColumns(table: string): Promise<string[]> {
  const { rows } = await pool!.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'schemamigration_test' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [table]
  )
  return rows.map((r) => r.column_name)
}

suite('read-model schema migration (R6 legacy → workspace-keyed)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS schemamigration_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })

  it('drops and recreates a pre-R6 ro_objects (no landscape_id) into the workspace-keyed shape', async () => {
    // Build the EXACT legacy shape (single-column id PK, no workspace columns)
    // and seed a row — the row must NOT survive; this is a rebuildable
    // projection, not something worth an ALTER+backfill migration.
    await dropLocalTables()
    await pool!.query(`
      CREATE TABLE schemamigration_test.ro_objects (
        id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', technology TEXT NOT NULL DEFAULT '',
        domain_id TEXT, parent_id TEXT, scope TEXT, status TEXT, data JSONB NOT NULL
      )
    `)
    await pool!.query(`INSERT INTO schemamigration_test.ro_objects (id, name, data) VALUES ('legacy1', 'Legacy', '{"id":"legacy1"}'::jsonb)`)
    expect((await columnNames('ro_objects')).has('landscape_id')).toBe(false)

    await ensureReadModelSchema(pool!)

    const cols = await columnNames('ro_objects')
    expect(cols.has('landscape_id')).toBe(true)
    expect(cols.has('version_id')).toBe(true)
    expect(cols.has('org_id')).toBe(true)
    expect(await primaryKeyColumns('ro_objects')).toEqual(['landscape_id', 'version_id', 'id'])

    // The legacy row is GONE (drop+recreate, not preserved) — the table is
    // simply empty, ready for the projector's next cold build.
    const { rows } = await pool!.query(`SELECT * FROM schemamigration_test.ro_objects`)
    expect(rows).toEqual([])
  })

  it('is a no-op (no drop) when the schema is already workspace-keyed', async () => {
    await dropLocalTables()
    await ensureReadModelSchema(pool!) // creates the R6 shape fresh
    await pool!.query(
      `INSERT INTO schemamigration_test.ro_objects (landscape_id, version_id, id, name, data)
       VALUES ('ls1', 'v1', 'o1', 'Kept', '{"id":"o1"}'::jsonb)`
    )

    await ensureReadModelSchema(pool!) // second call must NOT drop existing rows

    const { rows } = await pool!.query(`SELECT id, name FROM schemamigration_test.ro_objects`)
    expect(rows).toEqual([{ id: 'o1', name: 'Kept' }])
  })

  it('every ro_* table gets the composite (landscape_id, version_id, id) primary key', async () => {
    await dropLocalTables()
    await ensureReadModelSchema(pool!)
    for (const table of ['ro_objects', 'ro_connections', 'ro_groups', 'ro_diagrams']) {
      expect(await primaryKeyColumns(table)).toEqual(['landscape_id', 'version_id', 'id'])
    }
    expect(await primaryKeyColumns('ro_object_technologies')).toEqual([
      'landscape_id', 'version_id', 'object_id', 'usage_id',
    ])
    expect(await primaryKeyColumns('ro_group_technologies')).toEqual([
      'landscape_id', 'version_id', 'group_id', 'usage_id',
    ])
    expect(await primaryKeyColumns('ro_object_tags')).toEqual([
      'landscape_id', 'version_id', 'object_id', 'tag_id',
    ])
    expect(await primaryKeyColumns('ro_group_tags')).toEqual([
      'landscape_id', 'version_id', 'group_id', 'tag_id',
    ])
    expect(await primaryKeyColumns('ro_object_teams')).toEqual([
      'landscape_id', 'version_id', 'object_id', 'team_id',
    ])
    const fk = await pool!.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema = 'schemamigration_test'
         AND table_name IN ('ro_object_technologies', 'ro_group_technologies')
         AND constraint_type = 'FOREIGN KEY'`
    )
    expect(fk.rows).toEqual([])
  })
})
