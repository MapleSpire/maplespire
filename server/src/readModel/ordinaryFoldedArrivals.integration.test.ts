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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import {
  advanceFoldedArrivalWatermark,
  arrivalAbove,
  databaseNow,
  documentContentArrivals,
  documentContentChunks,
  foldedHeadsWithArrivals,
  HANDOVER_RECHECK_PERMITS,
  handoverBarrierBlockers,
  handoverRecheckDelay,
  laterArrival,
  ordinaryFoldArrivalPollMs,
  ordinaryHandoverBarrierMaxWaitMs,
  ordinaryHandoverRecheckMs,
  withHandoverRecheckPermit,
  ordinaryRetiredHeadParkMs,
  parkedStampWait,
  PARKED_STAMP_MAX_WAITS,
} from './ordinaryFoldedArrivals.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16b phase 4 step 4, the SQL of `ordinaryFoldedArrivals.ts` against real
 * PostgreSQL, one predicate per case. The end-to-end tests drive ONE folded
 * head in ONE workspace, so every predicate that only excludes something
 * (another workspace, an expired row already carried, an equal arrival) is invisible there.
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ofa', versionId: 'v1' }
const OTHER: WorkspaceKey = { landscapeId: 'ls-ofa', versionId: 'v2' }

describe('ordinaryFoldArrivalPollMs (AM_ORDINARY_FOLD_ARRIVAL_POLL_MS)', () => {
  // LITERALS, never derived from the module (review-lenses §1).
  it('defaults to 5 s, accepts 0 (disabled), clamps at 10 min, and rejects garbage to the default', () => {
    expect(ordinaryFoldArrivalPollMs({})).toBe(5_000)
    expect(ordinaryFoldArrivalPollMs({ AM_ORDINARY_FOLD_ARRIVAL_POLL_MS: '0' })).toBe(0)
    expect(ordinaryFoldArrivalPollMs({ AM_ORDINARY_FOLD_ARRIVAL_POLL_MS: '250' })).toBe(250)
    expect(ordinaryFoldArrivalPollMs({ AM_ORDINARY_FOLD_ARRIVAL_POLL_MS: '700000' })).toBe(600_000)
    expect(ordinaryFoldArrivalPollMs({ AM_ORDINARY_FOLD_ARRIVAL_POLL_MS: '-1' })).toBe(5_000)
    expect(ordinaryFoldArrivalPollMs({ AM_ORDINARY_FOLD_ARRIVAL_POLL_MS: 'abc' })).toBe(5_000)
  })
})

describe('ordinaryRetiredHeadParkMs (AM_ORDINARY_RETIRED_HEAD_PARK_MS)', () => {
  it('defaults to 10 min, accepts 0 (disabled), clamps at 24 h, and rejects garbage to the default', () => {
    expect(ordinaryRetiredHeadParkMs({})).toBe(600_000)
    expect(ordinaryRetiredHeadParkMs({ AM_ORDINARY_RETIRED_HEAD_PARK_MS: '0' })).toBe(0)
    expect(ordinaryRetiredHeadParkMs({ AM_ORDINARY_RETIRED_HEAD_PARK_MS: '300' })).toBe(300)
    expect(ordinaryRetiredHeadParkMs({ AM_ORDINARY_RETIRED_HEAD_PARK_MS: '90000000' })).toBe(86_400_000)
    expect(ordinaryRetiredHeadParkMs({ AM_ORDINARY_RETIRED_HEAD_PARK_MS: '-1' })).toBe(600_000)
    expect(ordinaryRetiredHeadParkMs({ AM_ORDINARY_RETIRED_HEAD_PARK_MS: 'abc' })).toBe(600_000)
  })
})

describe('ordinaryHandoverRecheckMs (AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS, G4-16d)', () => {
  it('defaults to 2 min, accepts 0 (disabled), clamps at 1 h, and rejects garbage to the default', () => {
    expect(ordinaryHandoverRecheckMs({})).toBe(120_000)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: '0' })).toBe(0)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: '8000' })).toBe(8_000)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: '4000000' })).toBe(3_600_000)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: '-1' })).toBe(120_000)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: 'abc' })).toBe(120_000)
    expect(ordinaryHandoverRecheckMs({ AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS: '1.5' })).toBe(120_000)
  })
  it('the barrier max wait (AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS) defaults to 5 min, at least 1 s, at most 1 h', () => {
    expect(ordinaryHandoverBarrierMaxWaitMs({})).toBe(300_000)
    expect(ordinaryHandoverBarrierMaxWaitMs({ AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS: '2000' })).toBe(2_000)
    expect(ordinaryHandoverBarrierMaxWaitMs({ AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS: '0' })).toBe(300_000)
    expect(ordinaryHandoverBarrierMaxWaitMs({ AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS: '9000000' })).toBe(3_600_000)
  })
  it('the delay jitter adds up to half the knob, at most 60 s', () => {
    expect(handoverRecheckDelay(120_000, 0)).toBe(120_000)
    expect(handoverRecheckDelay(120_000, 1)).toBe(180_000)
    expect(handoverRecheckDelay(600_000, 1)).toBe(660_000)
    expect(handoverRecheckDelay(300, 0.5)).toBe(375)
    expect(handoverRecheckDelay(300, 7)).toBe(450) // clamped
  })
  it('at most HANDOVER_RECHECK_PERMITS re-check merges run at once in the process', async () => {
    expect(HANDOVER_RECHECK_PERMITS).toBe(4)
    let running = 0
    let peak = 0
    await Promise.all(Array.from({ length: 10 }, () => withHandoverRecheckPermit(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running -= 1
    })))
    expect(peak).toBe(4)
    // A throw gives its permit back.
    await expect(withHandoverRecheckPermit(async () => { throw new Error('x') })).rejects.toThrow('x')
    let after = 0
    await Promise.all(Array.from({ length: 4 }, () => withHandoverRecheckPermit(async () => { after += 1 })))
    expect(after).toBe(4)
  })
})

describe('the barrier scan is shared by the process, never older than the asker\'s attach', () => {
  function fakeDb(takenUs: () => string) {
    const scans: string[] = []
    const db = {
      query: async (sql: string) => {
        if (sql.includes('pg_stat_activity')) {
          scans.push(sql)
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { rows: [
            { pid: 1, xact_us: '100', xact_start: 't100', taken_us: takenUs() },
            { pid: 2, xact_us: '300', xact_start: 't300', taken_us: takenUs() },
          ] }
        }
        return { rows: [{ now: takenUs() }] }
      },
    }
    return { db: db as never, scans }
  }
  it('concurrent askers share ONE scan and each filters it by its own attach', async () => {
    const { db, scans } = fakeDb(() => '1000')
    const [early, late] = await Promise.all([
      handoverBarrierBlockers(db, '200', 'own-a'),
      handoverBarrierBlockers(db, '400', 'own-a'),
    ])
    expect(scans).toHaveLength(1)
    expect(early).toEqual({ pids: [1], oldest: 't100' })
    expect(late).toEqual({ pids: [1, 2], oldest: 't100' })
  })
  it('a scan taken before the asker\'s attach is not reused: a fresh one is', async () => {
    let now = 150
    const { db, scans } = fakeDb(() => String(now))
    await handoverBarrierBlockers(db, '100', 'own-b')
    now = 900
    const later = await handoverBarrierBlockers(db, '500', 'own-b')
    expect(scans).toHaveLength(2)
    expect(later.pids).toEqual([1, 2])
  })
  it('A03: a transaction started exactly AT the attach is not a blocker (strictly older only)', async () => {
    const { db } = fakeDb(() => '1000')
    expect((await handoverBarrierBlockers(db, '300', 'own-c')).pids).toEqual([1])
    expect((await handoverBarrierBlockers(db, '301', 'own-d')).pids).toEqual([1, 2])
  })
  it('A06: the clock is read IN the scan\'s own statement, with the tag filter and the own-name exclusion', async () => {
    const { db, scans } = fakeDb(() => '1000')
    await handoverBarrierBlockers(db, '500', 'own-e')
    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatch(/extract\(epoch FROM now\(\)\)/)
    expect(scans[0]).toMatch(/FROM pg_stat_activity/)
    expect(scans[0]).toMatch(/starts_with\(application_name, \$1\) AND application_name <> \$2/)
  })
})

describe('laterArrival (a re-checked watermark is never lowered)', () => {
  it('is the later of two BIGINT texts, null being below every arrival', () => {
    expect(laterArrival('9', '10')).toBe('10') // text order says '9'
    expect(laterArrival('10', '9')).toBe('10')
    expect(laterArrival('9007199254740992', '9007199254740993')).toBe('9007199254740993')
    expect(laterArrival(null, '0')).toBe('0')
    expect(laterArrival('5', null)).toBe('5')
    expect(laterArrival(null, null)).toBeNull()
  })
})

describe('parkedStampWait (a stamp keyed by a parked head is not waited on for ever)', () => {
  it('waits only while the target is the current head and the waits are under the cap; drops otherwise', () => {
    expect(PARKED_STAMP_MAX_WAITS).toBe(5)
    expect(parkedStampWait(0, true)).toBe('wait')
    expect(parkedStampWait(PARKED_STAMP_MAX_WAITS - 1, true)).toBe('wait')
    // A target whose projection never consumes it (consumed by nobody): the
    // head would stay leased and re-trigger every poll.
    expect(parkedStampWait(PARKED_STAMP_MAX_WAITS, true)).toBe('drop')
    expect(parkedStampWait(1_000, true)).toBe('drop')
    // A target that is itself retired: its forward answering `nothing`
    // re-keys nothing, so waiting is waiting for ever.
    expect(parkedStampWait(0, false)).toBe('drop')
    expect(parkedStampWait(2, true, 2)).toBe('drop')
  })
})

describe('arrivalAbove (a parked head\'s in-memory watermark)', () => {
  it('compares as BIGINTs, not as text or as doubles; a null watermark is below every arrival; a null arrival is above nothing', () => {
    expect(arrivalAbove('10', '9')).toBe(true) // text order says no
    expect(arrivalAbove('9', '10')).toBe(false)
    expect(arrivalAbove('7', '7')).toBe(false)
    expect(arrivalAbove('9007199254740993', '9007199254740992')).toBe(true) // equal as doubles
    expect(arrivalAbove('0', null)).toBe(true) // a head parked before any content chunk
    expect(arrivalAbove(null, null)).toBe(false)
    expect(arrivalAbove(null, '5')).toBe(false)
  })
})

let db: IsolatedSchemaDb

suite('ordinaryFoldedArrivals SQL — real PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_folded_arrivals')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('TRUNCATE automerge_storage, read_model_ordinary_head_retirements')
  })

  async function row(
    ws: WorkspaceKey, documentId: string,
    opts: { collection?: 'object' | 'connection'; status?: 'folded' | 'retired'; retainMs?: number; watermark?: number | null } = {},
  ) {
    const status = opts.status ?? 'folded'
    await db.pool.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, forwarded_heads, status,
          folded_into, retain_until, arrival_watermark)
       VALUES ($1, $2, $3, $4, ARRAY['h']::text[], ARRAY['h']::text[], $5,
          CASE WHEN $5 = 'folded' THEN 'product' END,
          CASE WHEN $5 = 'folded' THEN now() + ($6::bigint * interval '1 millisecond') END,
          $7::bigint)`,
      [ws.landscapeId, ws.versionId, opts.collection ?? 'object', documentId, status,
        opts.retainMs ?? 86_400_000, opts.watermark ?? null],
    )
  }
  const chunk = (key: string, seq: number | null) => db.pool.query(
    'INSERT INTO automerge_storage (key, data, arrival_seq) VALUES ($1, $2, $3)', [key, Buffer.from([1]), seq],
  )
  const watermark = async (documentId: string, collection = 'object') => (await db.pool.query<{ w: string | null }>(
    `SELECT arrival_watermark::text AS w FROM read_model_ordinary_head_retirements
      WHERE landscape_id = $3 AND version_id = $4 AND document_id = $1 AND collection = $2`,
    [documentId, collection, WS.landscapeId, WS.versionId],
  )).rows[0]?.w ?? null

  it('lists exactly the folded heads of THIS workspace with a CONTENT arrival strictly above the watermark, expired or not', async () => {
    await row(WS, 'nullwm');                       await chunk('nullwm/incremental/a', 10)
    await row(WS, 'conn', { collection: 'connection' }); await chunk('conn/snapshot/a', 11)
    await row(WS, 'above', { watermark: 20 });     await chunk('above/incremental/a', 20); await chunk('above/incremental/b', 21)
    await row(WS, 'equal', { watermark: 30 });     await chunk('equal/incremental/a', 30)
    // Past retain_until and not carried: still polled (G4-16c), GC keeps it.
    await row(WS, 'expired', { retainMs: -1_000 }); await chunk('expired/incremental/a', 40)
    // Past retain_until and carried: nothing to poll.
    await row(WS, 'expiredcarried', { retainMs: -1_000, watermark: 45 }); await chunk('expiredcarried/incremental/a', 45)
    await row(WS, 'retired', { status: 'retired' }); await chunk('retired/incremental/a', 41)
    await row(OTHER, 'otherws');                   await chunk('otherws/incremental/a', 42)
    await row(WS, 'synconly');                     await chunk('synconly/sync-state/peer', 43)
    await row(WS, 'prefix');                       await chunk('prefixed/incremental/a', 44)
    await row(WS, 'nochunk')

    const hits = await foldedHeadsWithArrivals(db.pool, WS)
    expect(hits).toEqual([
      { collection: 'object', documentId: 'nullwm', arrivalSeq: '10', watermark: null, expired: false },
      { collection: 'connection', documentId: 'conn', arrivalSeq: '11', watermark: null, expired: false },
      { collection: 'object', documentId: 'above', arrivalSeq: '21', watermark: '20', expired: false },
      { collection: 'object', documentId: 'expired', arrivalSeq: '40', watermark: null, expired: true },
    ])
  })

  it('a watermark of 0 still sees arrival 1; an arrival 0 under a NULL watermark is seen', async () => {
    await row(WS, 'zero', { watermark: 0 }); await chunk('zero/incremental/a', 1)
    await row(WS, 'fresh');                  await chunk('fresh/incremental/a', 0)
    expect((await foldedHeadsWithArrivals(db.pool, WS)).map((hit) => hit.documentId)).toEqual(['fresh', 'zero'])
  })

  it('a head named for the handover re-check is listed whatever its watermark, retained or not; the other predicates still hold', async () => {
    await row(WS, 'equal', { watermark: 30 });      await chunk('equal/incremental/a', 30)
    await row(WS, 'below', { watermark: 30 });      await chunk('below/incremental/a', 12)
    await row(WS, 'unnamed', { watermark: 30 });    await chunk('unnamed/incremental/a', 13)
    await row(WS, 'expired', { retainMs: -1_000, watermark: 30 }); await chunk('expired/incremental/a', 14)
    await row(WS, 'nochunk')
    await row(WS, 'synconly', { watermark: 30 });   await chunk('synconly/sync-state/peer', 15)
    await row(OTHER, 'otherws', { watermark: 30 }); await chunk('otherws/incremental/a', 16)
    const named = ['equal', 'below', 'expired', 'nochunk', 'synconly', 'otherws']
    // An EXPIRED owed head is listed too (G4-16c: past retain_until is still
    // polled; the handover leftover sits below the watermark, so only the
    // owed list names it).
    expect((await foldedHeadsWithArrivals(db.pool, WS, named)).map((hit) => [hit.documentId, hit.arrivalSeq, hit.watermark, hit.expired]))
      .toEqual([['below', '12', '30', false], ['expired', '14', '30', true], ['equal', '30', '30', false]])
    // Nothing named: exactly the ordinary question.
    expect(await foldedHeadsWithArrivals(db.pool, WS)).toEqual([])
  })

  it('documentContentChunks: every CONTENT chunk of exactly that document, snapshots first, and the highest arrival among them', async () => {
    await db.pool.query('INSERT INTO automerge_storage (key, data, arrival_seq) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)', [
      'd/incremental/a', Buffer.from([1]), 9, 'd/snapshot/z', Buffer.from([2]), 4, 'd/incremental/b', Buffer.from([3]), 21,
    ])
    await chunk('d/sync-state/peer', 99)
    await chunk('dd/incremental/a', 50) // shares the prefix, not the id
    const read = await documentContentChunks(db.pool, 'd')
    expect(read.maxSeq).toBe('21')
    expect(read.chunks.map((data) => [...data])).toEqual([[2], [1], [3]])
    expect(await documentContentChunks(db.pool, 'absent')).toEqual({ chunks: [], maxSeq: null })
    // The highest arrival on a SNAPSHOT row (a compaction's) is the max too.
    await chunk('e/incremental/a', 3); await chunk('e/snapshot/s', 40)
    expect((await documentContentChunks(db.pool, 'e')).maxSeq).toBe('40')
  })

  it('handoverBarrierBlockers: only OTHER processes\' storage-write backends in a transaction older than `since`', async () => {
    const tagged = (name: string) => guardIdleClientErrors(new pg.Pool({
      connectionString: connection!, max: 1, application_name: name, options: `-c search_path=${db.schema}`,
    }), `barrier-test:${name}`)
    const own = `ms-storage:self:${randomUUID()}`
    const pools = {
      old: tagged(`ms-storage:old:${randomUUID()}`),
      own: tagged(own),
      unrelated: tagged('pg_dump'),
      late: tagged(`ms-storage:late:${randomUUID()}`),
    }
    const clients: pg.PoolClient[] = []
    const open = async (pool: pg.Pool) => {
      const client = await pool.connect()
      clients.push(client)
      await client.query('BEGIN')
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid, txid_current()')
      return rows[0]!.pid
    }
    try {
      const oldPid = await open(pools.old)
      const ownPid = await open(pools.own)
      const unrelatedPid = await open(pools.unrelated)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const since = await databaseNow(db.pool)
      const latePid = await open(pools.late)
      const blockers = await handoverBarrierBlockers(db.pool, since, own)
      expect(blockers.pids).toContain(oldPid)
      for (const pid of [ownPid, unrelatedPid, latePid]) expect(blockers.pids).not.toContain(pid)
      expect(blockers.oldest).not.toBeNull()
      // Visible under the app role: same role as the asking session.
      await clients[0]!.query('COMMIT')
      // A scan serves the process for 250 ms: a backend that just ended can
      // show for one more (the conservative direction).
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect((await handoverBarrierBlockers(db.pool, since, own)).pids).not.toContain(oldPid)
    } finally {
      for (const client of clients) { await client.query('ROLLBACK').catch(() => undefined); client.release() }
      for (const pool of Object.values(pools)) await pool.end()
    }
  })

  it('documentContentArrivals: the highest CONTENT arrival of exactly the named documents, null for none', async () => {
    await chunk('p/incremental/a', 5); await chunk('p/snapshot/b', 12); await chunk('p/sync-state/peer', 99)
    await chunk('pp/incremental/a', 50) // shares the prefix, not the id
    await chunk('q/sync-state/peer', 7) // no content chunk at all
    await chunk('unnamed/incremental/a', 70)
    const arrivals = await documentContentArrivals(db.pool, ['p', 'q', 'absent'])
    expect([...arrivals.entries()].sort()).toEqual([['absent', null], ['p', '12'], ['q', null]])
    expect(await documentContentArrivals(db.pool, [])).toEqual(new Map())
  })

  it('the advance is a CAS on (workspace, collection, document, folded, expected watermark), and writes `next`', async () => {
    await row(WS, 'd')
    await row(WS, 'd', { collection: 'connection' })
    await row(OTHER, 'd')
    await row(WS, 'r', { status: 'retired' })

    expect(await advanceFoldedArrivalWatermark(db.pool, WS, 'object', 'd', null, '7')).toBe(true)
    expect(await watermark('d')).toBe('7')
    // Same collection, other one untouched; other workspace untouched.
    expect(await watermark('d', 'connection')).toBeNull()
    expect((await db.pool.query(
      `SELECT arrival_watermark FROM read_model_ordinary_head_retirements WHERE version_id = 'v2'`,
    )).rows[0]!.arrival_watermark).toBeNull()
    // A stale expectation loses: a concurrent poll already moved it.
    expect(await advanceFoldedArrivalWatermark(db.pool, WS, 'object', 'd', null, '9')).toBe(false)
    expect(await watermark('d')).toBe('7')
    expect(await advanceFoldedArrivalWatermark(db.pool, WS, 'object', 'd', '7', '9')).toBe(true)
    expect(await watermark('d')).toBe('9')
    // A row that is not folded is never advanced.
    expect(await advanceFoldedArrivalWatermark(db.pool, WS, 'object', 'r', null, '5')).toBe(false)
    expect(await watermark('r')).toBeNull()
  })
})
