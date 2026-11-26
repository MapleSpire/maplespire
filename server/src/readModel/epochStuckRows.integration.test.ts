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

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import {
  CLIENT_DEADLINE_CODE, EpochStuckRowsSampler, STUCK_REPOINTING_SQL, queryWithStatementTimeout, stuckRepointingRows,
} from './epochStuckRows.js'
import { ensureReadModelSchema } from './schema.js'

/**
 * G4-16j (decision b): the stuck-repointing query on PostgreSQL — the state,
 * the age, and the index it is served by. Isolated schema,
 * TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
let db: IsolatedSchemaDb

suite('stuckRepointingRows on PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'epoch_stuck_rows')
    await ensureReadModelSchema(db.pool)
    // The core table's shape for this query (`db.ts`: `id` is the key).
    await db.pool.query('CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL)')
    for (const landscape of ['stuck', 'young', 'preparing', 'done']) {
      await db.pool.query('INSERT INTO versions (id, landscape_id) VALUES ($1, $2)', [`${landscape}-V`, landscape])
    }
    const insert = (landscape: string, epoch: number, state: string, ageMinutes: number, kind = 'full') => db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, updated_at)
       VALUES ($1, $1 || '-V', $2, $3, $4, $5, $6, now() - make_interval(mins => $7))`,
      [landscape, epoch, kind, state, kind === 'legacy' ? null : epoch - 1, `automerge:${landscape}${epoch}`, ageMinutes])
    await insert('stuck', 0, 'published', 120, 'legacy')
    await insert('stuck', 1, 'repointing', 25)
    await insert('young', 1, 'repointing', 2)
    await insert('preparing', 1, 'preparing', 60)
    await insert('done', 1, 'published', 60)
    // A version deleted while its roll was stuck (`landscapes.ts`
    // deletes the version, not its epoch rows) — no versions row.
    await insert('orphan', 0, 'published', 120, 'legacy')
    await insert('orphan', 1, 'repointing', 25)
  })
  afterAll(async () => { await db?.teardown() })

  it('returns the repointing rows past ten minutes only, of versions that exist, with their age', async () => {
    const rows = await stuckRepointingRows(db.pool)
    expect(rows.map((r) => `${r.landscapeId}/${r.epochNo}`)).toEqual(['stuck/1'])
    expect(rows[0]!.metaUrl).toBe('automerge:stuck1')
    expect(rows[0]!.stuckSeconds).toBeGreaterThan(24 * 60)
    expect(rows[0]!.stuckSeconds).toBeLessThan(26 * 60)
  })

  it('is served by the in-flight partial index (sequential scans off)', async () => {
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      // The SHIPPED text, EXISTS included.
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${STUCK_REPOINTING_SQL}`, [600])
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(plan).toMatch(/idx_read_model_model_epochs_in_flight/)
      expect(plan).toMatch(/versions_pkey/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('a sample waiting on a lock gives up at its statement timeout and gives its client back', async () => {
    const locker = await db.pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE read_model_model_epochs IN ACCESS EXCLUSIVE MODE')
      const startedAt = Date.now()
      const error = await stuckRepointingRows(db.pool).then(() => null, (e: unknown) => e)
      expect((error as { code?: string } | null)?.code).toBe('57014')
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      expect(db.pool.totalCount - db.pool.idleCount).toBe(1) // only the locker is checked out
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
  }, 30_000)

  it('the client given back has statement_timeout at its default, after a success and after a 57014', async () => {
    // ONE client, so the one checked is the one the query used.
    const single = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${db.schema}` }), 'test-single')
    try {
      const timeoutOf = async () => (await single.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]!.statement_timeout
      const before = await timeoutOf()
      await stuckRepointingRows(single)
      expect(await timeoutOf()).toBe(before)
      const locker = await db.pool.connect()
      try {
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE read_model_model_epochs IN ACCESS EXCLUSIVE MODE')
        await expect(stuckRepointingRows(single)).rejects.toMatchObject({ code: '57014' })
      } finally {
        await locker.query('ROLLBACK')
        locker.release()
      }
      expect(await timeoutOf()).toBe(before)
    } finally {
      await single.end()
    }
  }, 30_000)

  it('a server that does not answer in time: the CLIENT gives up at its deadline and destroys the client', async () => {
    // The server's own ceiling raised past the client's: pg_sleep stands for
    // a backend that does not answer.
    // The production pools carry the same guard (`db.ts`): a client destroyed
    // at the deadline emits its error on the pool.
    const single = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1 }), 'test-deadline')
    try {
      const startedAt = Date.now()
      const error = await queryWithStatementTimeout(single, 'SELECT pg_sleep(5)', [], 30_000, 500).then(() => null, (e: unknown) => e)
      expect((error as { code?: string } | null)?.code).toBe(CLIENT_DEADLINE_CODE)
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      expect(single.totalCount).toBe(0) // released WITH an error: removed from the pool
      // The pool still works, on a new client.
      expect((await single.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]!.ok).toBe(1)
    } finally {
      await single.end()
    }
  }, 30_000)

  it('the sampler reports it, and a schema without the table reads as none', async () => {
    const sampler = new EpochStuckRowsSampler(db.pool, () => true, () => undefined)
    await sampler.sample()
    expect(sampler.snapshot().stuck).toBe(1)
    const bare = await createIsolatedSchemaDb(connection!, 'epoch_stuck_rows_bare')
    try {
      expect(await stuckRepointingRows(bare.pool)).toEqual([])
    } finally {
      await bare.teardown()
    }
  })
})
