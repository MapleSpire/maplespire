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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureModelEpochOverrideSchema, overrideActorsOfUser, USER_OVERRIDE_ACTORS_MAX } from './modelEpochOverrides.js'
import { deleteEpochUserRowsOfWorkspace, EPOCH_WORKSPACE_USER_TABLES } from './modelEpochQuarantine.js'

/**
 * The override
 * ACTORS table is bounded and cleaned — the most recent 1 024 actors per
 * (workspace, user), refreshed on each sight; nothing recorded unless asked
 * to (the route asks for a writer only); emptied with the workspace and with
 * the user's account. Real PostgreSQL.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS = { landscapeId: 'ls-actors', versionId: 'v1' }
let db: IsolatedSchemaDb

const actor = (i: number) => i.toString(16).padStart(8, '0')
const count = async (userId: string) => Number((await db.pool.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM read_model_model_epoch_override_actors WHERE user_id = $1', [userId])).rows[0]!.n)

suite('the override actors table, bounded and cleaned', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_override_actors')
    // The auth schema's `users`, enough for the foreign key.
    await db.pool.query(`CREATE TABLE users (id TEXT PRIMARY KEY)`)
    await db.pool.query(`INSERT INTO users VALUES ('marie'), ('paul')`)
    await ensureModelEpochOverrideSchema(db.pool)
    await ensureModelEpochOverrideSchema(db.pool) // idempotent
  })
  afterAll(async () => { await db?.teardown() })

  it('keeps the 1 024 most recent per (workspace, user), a re-sighted actor refreshed, the user\'s only', async () => {
    expect(USER_OVERRIDE_ACTORS_MAX).toBe(1_024)
    await overrideActorsOfUser(db.pool, WS, 'paul', ['ffffffff'])
    await overrideActorsOfUser(db.pool, WS, 'marie', [actor(0)])
    await overrideActorsOfUser(db.pool, WS, 'marie', [actor(1)])
    // 1 022 more, in batches of 256 (the route's cap), each later than the first two.
    for (let start = 2; start < 1_024; start += 256) {
      await overrideActorsOfUser(db.pool, WS, 'marie', Array.from({ length: Math.min(256, 1_024 - start) }, (_, i) => actor(start + i)))
    }
    expect(await count('marie')).toBe(1_024)
    // actor 0 seen again: now the most recent.
    await overrideActorsOfUser(db.pool, WS, 'marie', [actor(0)])
    // The 1 025th prunes the OLDEST (actor 1), not the refreshed actor 0.
    const listed = await overrideActorsOfUser(db.pool, WS, 'marie', [actor(5_000)])
    expect(await count('marie')).toBe(1_024)
    expect(listed).toContain(actor(0))
    expect(listed).not.toContain(actor(1))
    expect(listed.length).toBe(1_024)
    // Another user's actors are neither counted nor pruned.
    expect(await count('paul')).toBe(1)
    expect(await overrideActorsOfUser(db.pool, WS, 'paul', [])).toEqual(['ffffffff'])
  })

  it('records nothing when not asked to (a reader): it is listed by what it asked and what it had', async () => {
    const before = await count('paul')
    expect(await overrideActorsOfUser(db.pool, WS, 'paul', ['abababab'], false)).toEqual(['abababab', 'ffffffff'])
    expect(await count('paul')).toBe(before)
  })

  it('is a workspace-user table: dropped with the workspace', async () => {
    expect(EPOCH_WORKSPACE_USER_TABLES).toContain('read_model_model_epoch_override_actors')
    const out = await deleteEpochUserRowsOfWorkspace(db.pool, WS.landscapeId, WS.versionId)
    expect(out.read_model_model_epoch_override_actors).toBe(1_025)
    expect(await count('marie') + await count('paul')).toBe(0)
  })

  it('goes with the user\'s account (foreign key, ON DELETE CASCADE)', async () => {
    await overrideActorsOfUser(db.pool, WS, 'marie', ['aaaaaaaa'])
    await overrideActorsOfUser(db.pool, WS, 'paul', ['bbbbbbbb'])
    await db.pool.query(`DELETE FROM users WHERE id = 'marie'`)
    expect(await count('marie')).toBe(0)
    expect(await count('paul')).toBe(1)
  })

  it('a session of an account just deleted — the record violates the foreign key (23503): nothing recorded, nothing logged, the rows still listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await overrideActorsOfUser(db.pool, WS, 'gone', ['cccccccc'])).toEqual(['cccccccc'])
      expect(await count('gone')).toBe(0)
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })
})

suite('the foreign key\'s ensure reads ITS schema only', () => {
  let other: IsolatedSchemaDb
  let mine: IsolatedSchemaDb
  beforeAll(async () => {
    // ANOTHER schema of the same database (a parallel test file, another
    // tenant of a shared base) already has the table and its key.
    other = await createIsolatedSchemaDb(connection!, 'model_epoch_override_actors_other')
    await other.pool.query(`CREATE TABLE users (id TEXT PRIMARY KEY)`)
    await ensureModelEpochOverrideSchema(other.pool)
    mine = await createIsolatedSchemaDb(connection!, 'model_epoch_override_actors_mine')
    await mine.pool.query(`CREATE TABLE users (id TEXT PRIMARY KEY)`)
  })
  afterAll(async () => {
    await mine?.teardown()
    await other?.teardown()
  })

  it('a key of the same name in another schema does not stop this schema\'s from being added', async () => {
    const elsewhere = await mine.pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'read_model_model_epoch_override_actors_user_fk'`)
    expect(elsewhere.rowCount).toBeGreaterThan(0)
    await ensureModelEpochOverrideSchema(mine.pool)
    const fk = await mine.pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'read_model_model_epoch_override_actors_user_fk'
      AND conrelid = (current_schema() || '.read_model_model_epoch_override_actors')::regclass`)
    expect(fk.rowCount).toBe(1)
  })
})

suite('the foreign key added over existing rows', () => {
  let legacy: IsolatedSchemaDb
  beforeAll(async () => {
    legacy = await createIsolatedSchemaDb(connection!, 'model_epoch_override_actors_legacy')
    // A base from an earlier build: the table without the key, rows of a deleted account in it.
    await legacy.pool.query(`CREATE TABLE users (id TEXT PRIMARY KEY)`)
    await legacy.pool.query(`INSERT INTO users VALUES ('marie')`)
    await legacy.pool.query(`
      CREATE TABLE read_model_model_epoch_override_actors (
        landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, user_id TEXT NOT NULL, actor TEXT NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (landscape_id, version_id, user_id, actor))`)
    await legacy.pool.query(`INSERT INTO read_model_model_epoch_override_actors (landscape_id, version_id, user_id, actor)
      VALUES ('ls', 'v', 'marie', 'aa'), ('ls', 'v', 'deleted-account', 'bb')`)
  })
  afterAll(async () => { await legacy?.teardown() })

  it('the boot purges the orphans, then adds the key — it does not fail on them', async () => {
    await ensureModelEpochOverrideSchema(legacy.pool)
    const { rows } = await legacy.pool.query<{ user_id: string }>('SELECT user_id FROM read_model_model_epoch_override_actors ORDER BY user_id')
    expect(rows.map((r) => r.user_id)).toEqual(['marie'])
    // This schema's own constraint (another schema of the database may have one too).
    const fk = await legacy.pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'read_model_model_epoch_override_actors_user_fk'
      AND conrelid = (current_schema() || '.read_model_model_epoch_override_actors')::regclass`)
    expect(fk.rowCount).toBe(1)
  })
})
