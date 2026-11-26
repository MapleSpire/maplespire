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
import type { PoolClient } from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { protocolFixtureQuery, withProtocolFixture } from '../testing/protocolFixture.js'
import { ensureReadModelSchema } from './schema.js'
import {
  commitForwardedHeads,
  loadOrdinaryHeadRetirements,
  readOrdinaryHeadRetirement,
} from './ordinaryHeadForwarding.js'
import { commitOrdinaryHeadRetirement } from './ordinaryHeadRotator.js'
import { recordOrdinaryChainFold } from './ordinaryChainFold.js'
import { markStaticReadModelWorkspace } from './staticWorkspace.js'
import { compactionSegmentRefusal, settleCompactedOrdinarySegments } from './workspaceCompaction.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16i: `settleCompactedOrdinarySegments` and `compactionSegmentRefusal`
 * driven DIRECTLY over a real PostgreSQL schema, one branch per test. The
 * end-to-end file (`compactionOrdinaryFold.integration.test.ts`) only reaches
 * the "current head without a row" and "fold product, first settle" branches;
 * every other branch of the settle was a survivor of a mutation battery.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-scs', versionId: 'v1' }
let db: IsolatedSchemaDb

const seg = (documentId: string, heads: string[], current = false) => ({ documentId, heads, current })
/** The write fence the settle asserts: the projector instance the pass detached. */
const FENCE = 'cell-a-projector'
const rowsIn = async () => loadOrdinaryHeadRetirements(db.pool, WS)
const rowOf = (collection: OverlayCollection, documentId: string) => readOrdinaryHeadRetirement(db.pool, WS, collection, documentId)
const retire = (collection: OverlayCollection, documentId: string, heads: string[]) =>
  withProtocolFixture(db.pool, (client) => commitOrdinaryHeadRetirement(client, WS, collection, documentId, heads))

/** A fold of `sources` (already retired rows) into `product`, recorded the way
 * the fold writer records it: sources `folded`, the product a `retired` row
 * whose origin is `fold-product`. */
async function fold(collection: OverlayCollection, product: string, sources: string[], productHeads = ['p0']) {
  for (const source of sources) await retire(collection, source, [`${source}-h`])
  await withProtocolFixture(db.pool, (client) => recordOrdinaryChainFold(client, WS, {
    collection, productDocumentId: product, productHeads, currentDocumentId: 'cur-head',
    sources: sources.map((documentId) => ({ documentId, forwardedHeads: null })),
    retainUntil: new Date(Date.now() + 86_400_000),
  }))
}

/** A client that records every statement, and can run a hook after the first
 * read of the retirement rows (a concurrent writer landing between the settle's
 * read and its compare-and-set). */
async function spiedClient(afterRowsRead?: () => Promise<void>) {
  const client = await db.pool.connect()
  const sql: string[] = []
  let hooked = false
  const proxy = new Proxy(client, {
    get(subject, name) {
      if (name === 'query') {
        return async (text: unknown, values?: unknown[]) => {
          if (typeof text === 'string') sql.push(text)
          const result = await (subject.query as (t: unknown, v?: unknown[]) => Promise<unknown>).call(subject, text, values)
          if (!hooked && afterRowsRead && typeof text === 'string' && text.includes('SELECT collection, document_id, retirement_heads')) {
            hooked = true
            await afterRowsRead()
          }
          return result
        }
      }
      const value = Reflect.get(subject, name, subject)
      return typeof value === 'function' ? value.bind(subject) : value
    },
  }) as unknown as PoolClient
  return { client: proxy, raw: client, sql }
}
/** `true` when this session is NOT inside a transaction: its transaction started
 * with this very statement. */
const outsideTransaction = async (client: PoolClient) => (await client.query<{ fresh: boolean }>(
  'SELECT xact_start = query_start AS fresh FROM pg_stat_activity WHERE pid = pg_backend_pid()',
)).rows[0]!.fresh

suite('settleCompactedOrdinarySegments / compactionSegmentRefusal — real PostgreSQL, one branch per test (G4-16i)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'settle_compacted_segments')
    await ensureReadModelSchema(db.pool)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds, read_model_static_workspaces, read_model_projection_state CASCADE')
    await db.pool.query(
      'INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)',
      [WS.landscapeId, WS.versionId, FENCE],
    )
  })

  it.each([
    ['held by another instance (a lease that moved: another cell cold-built)', 'cell-b-projector', FENCE],
    ['a lifecycle fence (a promotion)', 'lifecycle:promote:x', FENCE],
    ['no resident instance could be named', FENCE, null],
  ] as const)('the WRITE FENCE is asserted inside the transaction — %s: refused, nothing written, out of the transaction', async (_case, held, asked) => {
    await retire('object', 'anchor', ['x1'])
    await db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId, held])
    const { client, raw } = await spiedClient()
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [seg('rowless', ['r1']), seg('cur', ['c1'], true)], asked))
        .rejects.toThrow()
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    expect(await rowOf('object', 'cur')).toBeUndefined()
    expect(await rowOf('object', 'rowless')).toBeUndefined()
    // Control: the fence it names, and the same segments settle.
    await db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId, FENCE])
    const client2 = await db.pool.connect()
    try {
      expect((await settleCompactedOrdinarySegments(client2, WS, 'object', [seg('rowless', ['r1']), seg('cur', ['c1'], true)], FENCE)).retired)
        .toEqual(['cur'])
    } finally { client2.release() }
  })

  it('the fence is asserted BEFORE the row writes (every protocol writer\'s lock order, adoptState.ts) and its row is locked FOR UPDATE until COMMIT (a takeover\'s fence CAS waits for the settle)', async () => {
    await retire('object', 'anchor', ['x1'])
    let moved: Promise<unknown> | null = null
    const raw = await db.pool.connect()
    const order: string[] = []
    const client = new Proxy(raw, {
      get(subject, name) {
        if (name === 'query') {
          return async (text: unknown, values?: unknown[]) => {
            const sql = typeof text === 'string' ? text : ''
            if (sql.includes('read_model_projection_state') && sql.includes('FOR UPDATE')) order.push('fence')
            else if (/INSERT INTO read_model_ordinary_head_retirements|UPDATE read_model_ordinary_head_retirements/.test(sql)) order.push('row-write')
            const result = await (subject.query as (t: unknown, v?: unknown[]) => Promise<unknown>).call(subject, text, values)
            if (!moved && sql.includes('read_model_projection_state') && sql.includes('FOR UPDATE')) {
              // After the fence check, in the same transaction, a takeover
              // tries to move the fence: it must wait for the COMMIT.
              moved = db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
                [WS.landscapeId, WS.versionId, 'cell-b-projector'])
              const raced = await Promise.race([moved.then(() => 'moved'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 300))])
              expect(raced).toBe('waiting')
            }
            return result
          }
        }
        const value = Reflect.get(subject, name, subject)
        return typeof value === 'function' ? value.bind(subject) : value
      },
    }) as unknown as PoolClient
    try {
      expect((await settleCompactedOrdinarySegments(client, WS, 'object', [seg('cur', ['c1'], true)], FENCE)).retired).toEqual(['cur'])
    } finally { raw.release() }
    await moved
    expect(order).toEqual(['fence', 'row-write'])
    expect(await rowOf('object', 'cur')).toMatchObject({ status: 'retired' })
  })

  it('a fence mismatch refuses BEFORE any row write, and the transaction is rolled back', async () => {
    await retire('object', 'anchor', ['x1'])
    await db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId, 'cell-b-projector'])
    const { client, raw, sql } = await spiedClient()
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [seg('rowless', ['r1']), seg('cur', ['c1'], true)], FENCE))
        .rejects.toThrow()
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    // Witness: the fence WAS checked, and no row write was issued after it.
    expect(sql.some((text) => text.includes('read_model_projection_state') && text.includes('FOR UPDATE'))).toBe(true)
    expect(sql.some((text) => text.includes('INSERT INTO read_model_ordinary_head_retirements'))).toBe(false)
    expect(await rowOf('object', 'cur')).toBeUndefined()
    expect(await rowOf('object', 'rowless')).toBeUndefined()
  })

  it('a workspace with NO retirement row at all is left exactly as before: nothing written (legacy rotation-off path)', async () => {
    const client = await db.pool.connect()
    try {
      const settled = await settleCompactedOrdinarySegments(client, WS, 'object', [seg('a', ['a1']), seg('cur', ['c1'], true)], FENCE)
      expect(settled).toEqual({ retired: [], forwarded: [], adopted: [] })
    } finally { client.release() }
    expect((await rowsIn()).size).toBe(0)
  })

  it('the guard is WORKSPACE-wide: rows in the CONNECTION collection only still retire the OBJECT head this pass replaces', async () => {
    await retire('connection', 'conn-old', ['k1'])
    const client = await db.pool.connect()
    try {
      const settled = await settleCompactedOrdinarySegments(client, WS, 'object', [seg('cur', ['c1'], true)], FENCE)
      expect(settled).toEqual({ retired: ['cur'], forwarded: [], adopted: [] })
    } finally { client.release() }
    expect(await rowOf('object', 'cur')).toMatchObject({ status: 'retired', retirementHeads: ['c1'] })
  })

  it('the CURRENT head is retired at its post-clear heads and a rowless NON-current head is ADOPTED, in the pass\'s own collection', async () => {
    await retire('object', 'anchor', ['x1'])
    const client = await db.pool.connect()
    try {
      const settled = await settleCompactedOrdinarySegments(client, WS, 'object', [seg('rowless', ['r1']), seg('cur', ['c1'], true)], FENCE)
      expect(settled).toEqual({ retired: ['cur'], forwarded: [], adopted: ['rowless'] })
    } finally { client.release() }
    expect(await rowOf('object', 'rowless')).toMatchObject({ status: 'retired', retirementHeads: ['r1'], forwardedHeads: null })
    expect(await rowOf('object', 'cur')).toMatchObject({ status: 'retired', retirementHeads: ['c1'] })
    expect(await rowOf('connection', 'rowless')).toBeUndefined()
    expect(await rowOf('connection', 'cur')).toBeUndefined()
  })

  it('a fold PRODUCT whose heads moved has forwarded_heads advanced by compare-and-set — a second time from a NON-null value — and an unmoved one is left alone', async () => {
    await fold('object', 'prod', ['s1', 's2'], ['p0'])
    const settle = async (heads: string[]) => {
      const client = await db.pool.connect()
      try { return await settleCompactedOrdinarySegments(client, WS, 'object', [seg('prod', heads)], FENCE) } finally { client.release() }
    }
    expect((await settle(['p1'])).forwarded).toEqual(['prod'])
    expect(await rowOf('object', 'prod')).toMatchObject({ status: 'retired', forwardedHeads: ['p1'], retirementHeads: ['p0'] })
    // Same heads as forwarded_heads: nothing to record.
    expect((await settle(['p1'])).forwarded).toEqual([])
    // Moved again, from a forwarded_heads that is not null.
    expect((await settle(['p2'])).forwarded).toEqual(['prod'])
    expect(await rowOf('object', 'prod')).toMatchObject({ forwardedHeads: ['p2'] })
  })

  it('a fold product in the CONNECTION collection is found by its own collection\'s key (not retired over, not skipped)', async () => {
    await fold('connection', 'cprod', ['cs1'], ['p0'])
    const client = await db.pool.connect()
    try {
      const settled = await settleCompactedOrdinarySegments(client, WS, 'connection', [seg('cprod', ['p1'])], FENCE)
      expect(settled).toEqual({ retired: [], forwarded: ['cprod'], adopted: [] })
    } finally { client.release() }
    expect(await rowOf('connection', 'cprod')).toMatchObject({ forwardedHeads: ['p1'], retirementHeads: ['p0'] })
  })

  it('a retired head that is NOT a fold product is left alone even when its heads moved (the forwarder carries its clear)', async () => {
    await retire('object', 'plain', ['a0'])
    const client = await db.pool.connect()
    try {
      const settled = await settleCompactedOrdinarySegments(client, WS, 'object', [seg('plain', ['a1'])], FENCE)
      expect(settled).toEqual({ retired: [], forwarded: [], adopted: [] })
    } finally { client.release() }
    expect(await rowOf('object', 'plain')).toMatchObject({ retirementHeads: ['a0'], forwardedHeads: null })
  })

  it('a product CAS that does not move THROWS, and nothing of the pass is committed — the session is out of its transaction', async () => {
    await fold('object', 'prod', ['s1'], ['p0'])
    await retire('object', 'older', ['o0'])
    const { client, raw } = await spiedClient(async () => {
      // A concurrent writer moves the product's forwarded_heads after the
      // read. Every protocol writer takes the fence row FIRST and the adopt
      // triggers take it too (`adoptState.ts`, THE LOCK ORDER), so one that
      // follows the order WAITS for this settle and never lands here; the
      // CAS is the belt for one that does not. Here: triggers off for that
      // one session, the only way left to write under the settle's lock.
      const other = await db.pool.connect()
      try {
        await other.query('BEGIN')
        await other.query('SET LOCAL session_replication_role = replica')
        expect(await commitForwardedHeads(other, WS, 'object', 'prod', null, ['elsewhere'])).toBe(true)
        await other.query('COMMIT')
      } finally {
        other.release()
      }
    })
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [
        seg('cur', ['c1'], true), seg('prod', ['p1']),
      ], FENCE)).rejects.toThrow(/forwarded_heads moved under the pass/)
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    // The current head's row was written BEFORE the product in the same
    // transaction: it must have rolled back with it.
    expect(await rowOf('object', 'cur')).toBeUndefined()
    expect(await rowOf('object', 'prod')).toMatchObject({ forwardedHeads: ['elsewhere'] })
  })

  it('BATCHED: many segments settle in at most TWO protocol statements, each row by its OWN compare-and-set (null, non-null and unsorted expected states all match)', async () => {
    await fold('object', 'pa', ['sa'], ['a0'])
    await fold('object', 'pb', ['sb'], ['b0'])
    await fold('object', 'pc', ['sc'], ['c0'])
    // pb already forwarded once (a non-null expected state), pc to two heads.
    await withProtocolFixture(db.pool, (client) => commitForwardedHeads(client, WS, 'object', 'pb', null, ['b1']))
    await withProtocolFixture(db.pool, (client) => commitForwardedHeads(client, WS, 'object', 'pc', null, ['c2', 'c1']))
    const { client, raw, sql } = await spiedClient()
    let settled
    try {
      settled = await settleCompactedOrdinarySegments(client, WS, 'object', [
        seg('cur', ['k1'], true), seg('rowless-1', ['r1']), seg('rowless-2', ['r2']),
        seg('pa', ['a9']), seg('pb', ['b9']), seg('pc', ['c9', 'c8']),
      ], FENCE)
    } finally { raw.release() }
    expect(settled).toEqual({ retired: ['cur'], forwarded: ['pa', 'pb', 'pc'], adopted: ['rowless-1', 'rowless-2'] })
    const writes = sql.filter((text) => /^\s*(?:INSERT|UPDATE|DELETE)\b[\s\S]*read_model_ordinary_head_retirements/.test(text))
    expect(writes, writes.join('\n---\n')).toHaveLength(2)
    expect(await rowOf('object', 'pa')).toMatchObject({ forwardedHeads: ['a9'] })
    expect(await rowOf('object', 'pb')).toMatchObject({ forwardedHeads: ['b9'] })
    expect(await rowOf('object', 'pc')).toMatchObject({ forwardedHeads: ['c8', 'c9'] })
    for (const id of ['cur', 'rowless-1', 'rowless-2']) expect((await rowOf('object', id))?.status, id).toBe('retired')
    expect(await rowOf('object', 'rowless-2')).toMatchObject({ retirementHeads: ['r2'], forwardedHeads: null })
  })

  it('BATCHED, partial match: ONE product of three moved under the pass — the settle throws naming it, and NOTHING of the pass (the other two products, the retirements) is committed', async () => {
    await fold('object', 'pa', ['sa'], ['a0'])
    await fold('object', 'pb', ['sb'], ['b0'])
    await fold('object', 'pc', ['sc'], ['c0'])
    const { client, raw } = await spiedClient(async () => {
      // As in the single-product arm: triggers off for that one session.
      const other = await db.pool.connect()
      try {
        await other.query('BEGIN')
        await other.query('SET LOCAL session_replication_role = replica')
        expect(await commitForwardedHeads(other, WS, 'object', 'pb', null, ['elsewhere'])).toBe(true)
        await other.query('COMMIT')
      } finally {
        other.release()
      }
    })
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [
        seg('cur', ['c1'], true), seg('pa', ['a1']), seg('pb', ['b1']), seg('pc', ['c1']),
      ], FENCE)).rejects.toThrow(/fold product pb: forwarded_heads moved under the pass/)
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    expect(await rowOf('object', 'cur')).toBeUndefined()
    expect(await rowOf('object', 'pa')).toMatchObject({ forwardedHeads: null })
    expect(await rowOf('object', 'pb')).toMatchObject({ forwardedHeads: ['elsewhere'] })
    expect(await rowOf('object', 'pc')).toMatchObject({ forwardedHeads: null })
  })

  it('BATCHED: a current head whose row is FOLDED is refused by the batched upsert, naming it, and nothing is committed', async () => {
    await fold('object', 'prod', ['gone'], ['p0'])
    const client = await db.pool.connect()
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [
        seg('fresh', ['f1']), seg('gone', ['g1'], true),
      ], FENCE)).rejects.toThrow(/ordinary head object gone of .* is folded; it cannot be retired again/)
    } finally { client.release() }
    expect(await rowOf('object', 'fresh')).toBeUndefined()
    expect((await rowOf('object', 'gone'))?.status).toBe('folded')
  })

  it('a segment with NO heads refuses (an empty H_r would forward the whole history), and writes nothing', async () => {
    await retire('object', 'anchor', ['x1'])
    const { client, raw } = await spiedClient()
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [seg('cur', ['c1'], true), seg('bare', [])], FENCE))
        .rejects.toThrow(/no heads/)
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    expect(await rowOf('object', 'cur')).toBeUndefined()
    expect(await rowOf('object', 'bare')).toBeUndefined()
  })

  it('a STATIC-plane workspace is refused inside the settle transaction, nothing written; the BEGIN carries a lock_timeout', async () => {
    await retire('object', 'anchor', ['x1'])
    await markStaticReadModelWorkspace(db.pool, WS, 'test')
    const { client, raw, sql } = await spiedClient()
    try {
      await expect(settleCompactedOrdinarySegments(client, WS, 'object', [seg('cur', ['c1'], true)], FENCE)).rejects.toThrow()
      expect(await outsideTransaction(raw)).toBe(true)
    } finally { raw.release() }
    expect(sql[0]).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout/)
    expect(await rowOf('object', 'cur')).toBeUndefined()
  })

  describe('compactionSegmentRefusal', () => {
    const refuse = (collection: OverlayCollection, segments: ReturnType<typeof seg>[]) =>
      compactionSegmentRefusal(db.pool, WS, collection, segments)

    it.each(['object', 'connection'] as const)('a listed %s source folded and not published refuses ordinary_fold_unpublished, and that reason wins over a pending retired head', async (collection) => {
      await fold(collection, 'prod', ['src'], ['p0'])
      await retire(collection, 'late', ['l0'])
      const answer = await refuse(collection, [seg('src', ['src-h']), seg('late', ['l1']), seg('cur', ['c1'], true)])
      expect(answer).toEqual({ reason: 'ordinary_fold_unpublished', segments: ['src'] })
      // Control: without the folded source, the SAME segments are plain pending.
      expect(await refuse(collection, [seg('late', ['l1']), seg('cur', ['c1'], true)])).toEqual(['late'])
    })

    it('a rotation-retired (not folded) head with unmoved heads is not unpublished', async () => {
      await retire('object', 'quiet', ['q0'])
      expect(await refuse('object', [seg('quiet', ['q0']), seg('cur', ['c1'], true)])).toEqual([])
    })

    it('a fold PRODUCT whose heads moved is not pending — by its origin, even when its fold record is gone', async () => {
      await fold('object', 'prod', ['s1'], ['p0'])
      expect(await refuse('object', [seg('prod', ['p9']), seg('cur', ['c1'], true)])).toEqual([])
      await protocolFixtureQuery(db.pool, 'DELETE FROM read_model_ordinary_chain_folds')
      expect(await refuse('object', [seg('prod', ['p9']), seg('cur', ['c1'], true)])).toEqual([])
    })

    it('a product row without the origin column (older row) is recognised by its fold record', async () => {
      await fold('object', 'prod', ['s1'], ['p0'])
      await protocolFixtureQuery(db.pool, `UPDATE read_model_ordinary_head_retirements SET origin = NULL WHERE document_id = 'prod'`)
      expect(await refuse('object', [seg('prod', ['p9']), seg('cur', ['c1'], true)])).toEqual([])
    })

    it('a retired head that is not a product and moved IS pending (the exclusion is for products only)', async () => {
      await retire('object', 'plain', ['a0'])
      expect(await refuse('object', [seg('plain', ['a1']), seg('cur', ['c1'], true)])).toEqual(['plain'])
    })
  })
})
