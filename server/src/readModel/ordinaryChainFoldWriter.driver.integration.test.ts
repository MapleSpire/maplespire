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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { foldOrdinaryChain, type FoldOrdinaryChainArgs } from './ordinaryChainFoldWriter.js'
import { ORDINARY_FOLD_SOURCES_FIELD, readOrdinaryChainFold, recordOrdinaryChainFold } from './ordinaryChainFold.js'
import { readOrdinaryHeadRetirement, recordOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { acquireOverlayRotationLock, overlayRotationLockKey, releaseOverlayRotationLock } from './overlayRotationLock.js'
import type { WorkspaceKey } from './projector.js'
import type { PoolClient } from 'pg'

/**
 * G4-16b phase 4 step 3, from the QA lens's kill tests: `foldOrdinaryChain` DRIVEN DIRECTLY
 * over real PostgreSQL, with in-memory Automerge documents for ModelMeta and
 * the segments, so each guard can be reached by the input that selects it.
 * Every test asserts a positive witness (the outcome) before any negative.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ocfw-drv', versionId: 'v1' }
let db: IsolatedSchemaDb

type Seg = { objects?: Record<string, unknown>; writeBatchIds: string[] }
type Meta = {
  objectShardUrls: string[]; editsObjectShardUrls: string[]; editsObjectShardUrl: string
  connectionShardUrls: string[]; editsConnectionShardUrls: string[]; editsConnectionShardUrl: string
}

interface Fixture {
  repo: Repo
  meta: DocHandle<Meta>
  base: DocHandle<Seg>
  heads: DocHandle<Seg>[]
  cur: DocHandle<Seg>
  lines: Array<Record<string, unknown>>
  flush: ReturnType<typeof vi.fn>
  products: DocHandle<Seg>[]
  args: (over?: Partial<FoldOrdinaryChainArgs>) => FoldOrdinaryChainArgs
}

async function retire(h: DocHandle<Seg>, status: 'retired' | 'admitted' = 'retired') {
  await recordOrdinaryHeadRetirement(db.pool, WS, {
    collection: 'object', documentId: h.documentId, retirementHeads: A.getHeads(h.doc() as A.Doc<unknown>), status,
  })
}

/** base, n retired+settled heads h0..h(n-1), and an empty current head. */
async function fixture(n = 3, opts: { retire?: boolean } = {}): Promise<Fixture> {
  const repo = new Repo({})
  const base = repo.create<Seg>({ objects: { b: { id: 'b', name: 'B' } }, writeBatchIds: [] })
  const heads = Array.from({ length: n }, (_, i) =>
    repo.create<Seg>({ objects: { n0: { id: 'n0', name: `h${i}` }, [`only${i}`]: { id: `only${i}` } }, writeBatchIds: [] }))
  const cur = repo.create<Seg>({ objects: {}, writeBatchIds: [] })
  const conn = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, ...heads.map((h) => h.url), cur.url],
    editsObjectShardUrls: [...heads.map((h) => h.url), cur.url],
    editsObjectShardUrl: cur.url,
    connectionShardUrls: [conn.url], editsConnectionShardUrls: [conn.url], editsConnectionShardUrl: conn.url,
  })
  if (opts.retire !== false) for (const h of heads) await retire(h)
  const lines: Array<Record<string, unknown>> = []
  const flush = vi.fn(async () => undefined)
  const products: DocHandle<Seg>[] = []
  const args = (over: Partial<FoldOrdinaryChainArgs> = {}): FoldOrdinaryChainArgs => ({
    key: WS,
    collection: 'object',
    meta: {
      documentId: meta.documentId,
      doc: () => meta.doc() as unknown as Record<string, unknown>,
      change: (fn) => meta.change((d) => fn(d as unknown as Record<string, unknown>)),
    },
    minChain: 2,
    budget: 8,
    retainMs: 86_400_000,
    mayWrite: () => true,
    watched: () => true,
    assertAuthority: async () => undefined,
    connect: async () => {
      const client = await db.pool.connect()
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      foldSessions.add(rows[0]!.pid)
      return client
    },
    assertTransactionAuthority: async () => undefined,
    segment: async (url) => {
      const h = await repo.find(url as AutomergeUrl)
      return { documentId: h.documentId, doc: () => h.doc() }
    },
    createProduct: async (entities, fields) => {
      const h = repo.create<Seg>({ ...fields, objects: entities, writeBatchIds: [] })
      products.push(h)
      return { url: h.url, documentId: h.documentId, doc: () => h.doc() }
    },
    flush,
    log: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>) },
    ...over,
  })
  return { repo, meta, base, heads, cur, lines, flush, products, args }
}

const status = async (h: DocHandle<Seg>) => (await readOrdinaryHeadRetirement(db.pool, WS, 'object', h.documentId))?.status
/** Backends the fold connected through (`args().connect`): other suites
 * running in parallel against the same server have their own sessions idle in
 * transaction, which say nothing about this one. */
const foldSessions = new Set<number>()
/** Fold sessions left inside a transaction. No bound parameter: with one, the extended protocol can make
 * `now()` and `statement_timestamp()` differ outside any transaction. The pool hands the most recently
 * released client out first, so the probe may itself run ON the leaked
 * session: there `now()` (transaction start) precedes `statement_timestamp()`. */
const idleInTransaction = async () => Number((await db.pool.query<{ n: string }>(
  `SELECT (SELECT count(*) FROM pg_stat_activity
            WHERE pid IN (${[...foldSessions, 0].join(", ")}) AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%')
        + (CASE WHEN now() <> statement_timestamp() THEN 1 ELSE 0 END) AS n`,
)).rows[0]!.n)

suite('foldOrdinaryChain driven directly — PostgreSQL, in-memory documents', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ocfw_driver')
    await ensureReadModelSchema(db.pool)
    // The fold-row sweep asks storage whether a source holds an uncarried
    // late write (`foldedArrivalPendingSql`). The documents here live in
    // memory, so the table stays empty: nothing is ever pending.
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds')
  })

  it('control: folds the run, records it, substitutes BOTH lists, flushes ModelMeta', async () => {
    const f = await fixture(3)
    const result = await foldOrdinaryChain(f.args())
    expect(result).toMatchObject({ outcome: 'folded', recovered: false, sources: f.heads.map((h) => h.url) })
    const product = f.products[0]!
    expect(f.meta.doc()!.objectShardUrls).toEqual([f.base.url, product.url, f.cur.url])
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([product.url, f.cur.url])
    // The record is COMMITTED: visible on another connection.
    for (const h of f.heads) expect(await status(h)).toBe('folded')
    expect(f.flush).toHaveBeenCalledWith([f.meta.documentId])
    expect(await idleInTransaction()).toBe(0)
  })

  // F1: the lock licence.
  it('a held overlay-rotation key: lock-refused, nothing created, nothing changed', async () => {
    const f = await fixture(3)
    const holder = await db.pool.connect()
    const key = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    const state = await acquireOverlayRotationLock(holder as unknown as PoolClient, key)
    expect(state).toBe('acquired')
    try {
      const before = JSON.stringify(f.meta.doc())
      expect(await foldOrdinaryChain(f.args())).toEqual({ outcome: 'lock-refused', state: 'refused' })
      expect(f.products).toEqual([])
      expect(JSON.stringify(f.meta.doc())).toBe(before)
    } finally {
      await releaseOverlayRotationLock(holder as unknown as PoolClient, key, state)
    }
  })

  // F2, F3, F5, F4: ownership at each of its four checks, by call index.
  it.each([
    [1, { outcome: 'not-owner' }, false],
    [2, { outcome: 'not-owner' }, false],
    [3, { outcome: 'superseded', stage: 'before-record' }, false],
    [4, { outcome: 'superseded', stage: 'after-record' }, true],
  ])('ownership lost at check #%i', async (lostAt, expected, recorded) => {
    const f = await fixture(3)
    let calls = 0
    const connect = vi.fn(() => db.pool.connect())
    const before = JSON.stringify(f.meta.doc())
    const result = await foldOrdinaryChain(f.args({ connect, mayWrite: () => { calls += 1; return calls < lostAt } }))
    expect(result).toMatchObject(expected)
    expect(calls).toBe(lostAt)
    expect(JSON.stringify(f.meta.doc())).toBe(before)
    expect(await status(f.heads[0]!)).toBe(recorded ? 'folded' : 'retired')
    if (lostAt === 1) expect(connect).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })

  // F6: the fence/plane read happens before anything (here: before connect).
  it('assertAuthority throwing: nothing connects, nothing is created', async () => {
    const f = await fixture(3)
    const connect = vi.fn(() => db.pool.connect())
    await expect(foldOrdinaryChain(f.args({ connect, assertAuthority: async () => { throw new Error('fence lost') } })))
      .rejects.toThrow('fence lost')
    expect(connect).not.toHaveBeenCalled()
    expect(f.products).toEqual([])
  })

  // F7 + C3: in-transaction authority throws -> no record, the transaction is
  // rolled back (no session left idle in transaction), the lock is free.
  it('assertTransactionAuthority throwing: no record, the transaction rolled back, the key free again', async () => {
    const f = await fixture(3)
    const assertTransactionAuthority = vi.fn(async (tx: { query: (sql: string) => Promise<unknown> }) => {
      // Something in the transaction a missing ROLLBACK would leave open.
      await tx.query('SELECT txid_current()')
      throw new Error('plane moved')
    })
    await expect(foldOrdinaryChain(f.args({ assertTransactionAuthority: assertTransactionAuthority as never })))
      .rejects.toThrow('plane moved')
    expect(assertTransactionAuthority).toHaveBeenCalledTimes(1)
    expect(await status(f.heads[0]!)).toBe('retired')
    expect(await idleInTransaction()).toBe(0)
    // The next pass gets the key and folds.
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded' })
  })

  // C1: a CAS conflict rolls the transaction back.
  it('a forward overtaking the read: conflict, nothing published, no session idle in transaction', async () => {
    const f = await fixture(3)
    const result = await foldOrdinaryChain(f.args({
      createProduct: async (entities, fields) => {
        // Between the sample and the record: a forward moves h0's row.
        await db.pool.query(
          `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = retirement_heads WHERE document_id = $1`,
          [f.heads[0]!.documentId],
        )
        const h = f.repo.create<Seg>({ ...fields, objects: entities, writeBatchIds: [] })
        return { url: h.url, documentId: h.documentId, doc: () => h.doc() }
      },
    }))
    expect(result).toMatchObject({ outcome: 'conflict' })
    expect(f.lines.map((l) => l.event)).toContain('read_model.ordinary_chain_fold_conflict')
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([...f.heads.map((h) => h.url), f.cur.url])
    expect(await idleInTransaction()).toBe(0)
  })

  // U1 / U2: the current head moves between the record and the publish.
  it.each(['a source', 'the product'])('the current head becoming %s after the record: superseded after-record, ModelMeta untouched', async (which) => {
    const f = await fixture(3)
    const result = await foldOrdinaryChain(f.args({
      assertTransactionAuthority: async () => {
        // The record's transaction, not the sweep's earlier one.
        if (!f.products.length) return
        const next = which === 'a source' ? f.heads[1]!.url : f.products[0]!.url
        f.meta.change((d) => { d.editsObjectShardUrl = next })
      },
    }))
    expect(result).toMatchObject({ outcome: 'superseded', stage: 'after-record' })
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([...f.heads.map((h) => h.url), f.cur.url])
    expect(f.flush).not.toHaveBeenCalled()
  })

  // T1 / U6: an unsettled head is not foldable, and the skip says why.
  it('a retired head with a write past its H_r is not folded: sources-not-settled', async () => {
    const f = await fixture(2)
    f.heads[1]!.change((d) => { d.objects!.late = { id: 'late' } })
    expect(await foldOrdinaryChain(f.args())).toEqual({ outcome: 'skipped', reason: 'sources-not-settled' })
    expect(f.products).toEqual([])
  })

  // T2: settled is judged against forwarded_heads when there is one.
  it('a head whose late write has been FORWARDED is settled (forwarded_heads, not H_r)', async () => {
    const f = await fixture(2)
    f.heads[1]!.change((d) => { d.objects!.late = { id: 'late' } })
    await db.pool.query(
      'UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $2::text[] WHERE document_id = $1',
      [f.heads[1]!.documentId, [...A.getHeads(f.heads[1]!.doc() as A.Doc<unknown>)].sort()],
    )
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded' })
    expect(Object.keys(f.products[0]!.doc()!.objects!)).toContain('late')
  })

  // T3: an `admitted` row is not foldable.
  it('heads whose rows are admitted, not retired, are never folded', async () => {
    const f = await fixture(3, { retire: false })
    for (const h of f.heads) await retire(h, 'admitted')
    expect(await foldOrdinaryChain(f.args())).toEqual({ outcome: 'skipped', reason: 'chain-below-threshold' })
    expect(f.products).toEqual([])
  })

  // The seal and the window, from sizes the fold reads itself.
  it('a head at the entity ceiling is SEALED, and one pass merges at most the window', async () => {
    const f = await fixture(4)
    // Each head holds 2 entities. Ceiling 2 seals them all.
    expect(await foldOrdinaryChain(f.args({ segmentCeiling: 2 }))).toEqual({ outcome: 'skipped', reason: 'chain-below-threshold' })
    // Window 5: h0 + h1 (4), and h2 would make 6.
    expect(await foldOrdinaryChain(f.args({ windowEntities: 5 })))
      .toMatchObject({ outcome: 'folded', sources: [f.heads[0]!.url, f.heads[1]!.url] })
  })

  // T4: the entity-shape guard.
  it('a retired head with no entity map is skipped, and the rest still folds', async () => {
    const f = await fixture(3, { retire: false })
    f.heads[0]!.change((d) => { delete d.objects })
    for (const h of f.heads) await retire(h)
    const result = await foldOrdinaryChain(f.args())
    expect(result).toMatchObject({ outcome: 'folded', sources: [f.heads[1]!.url, f.heads[2]!.url] })
  })

  // Recovery: R3 (ModelMeta order, not the record's), R4 (flush).
  it('recovers a recorded fold whose record lists its sources out of ModelMeta order, and flushes', async () => {
    const f = await fixture(2)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [], [ORDINARY_FOLD_SOURCES_FIELD]: f.heads.map((h) => h.url) } as Seg)
    await recordByHand(product, [f.heads[1]!, f.heads[0]!], f.cur)
    const result = await foldOrdinaryChain(f.args())
    expect(result).toEqual({
      outcome: 'folded', productUrl: product.url, sources: [f.heads[0]!.url, f.heads[1]!.url], recovered: true,
    })
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([product.url, f.cur.url])
    expect(f.flush).toHaveBeenCalledWith([f.meta.documentId])
  })

  // R2, step 5: a record with a source ModelMeta no longer lists cannot be
  // published; once retainMs old it is undone, and the listed source folds again.
  it('a recorded fold with a source gone from ModelMeta is abandoned (sources-unlisted): its listed source folds again', async () => {
    const f = await fixture(3)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    const ghost = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await retire(ghost)
    await recordByHand(product, [ghost, f.heads[0]!], f.cur)
    await ageRecord(product)
    const result = await foldOrdinaryChain(f.args())
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_abandoned', product: product.documentId, reason: 'sources-unlisted',
      reverted: [ghost.documentId, f.heads[0]!.documentId].sort(),
    }))
    expect(result).toMatchObject({ outcome: 'folded', recovered: false, sources: f.heads.map((h) => h.url) })
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', product.documentId)).toBeUndefined()
    expect(await status(product)).toBeUndefined()
  })

  // A record none of whose sources is listed is abandoned too once old
  // enough: nothing else would ever end it (it stops being the newest).
  it('a recorded fold none of whose sources is listed is kept while young, abandoned once retainMs old', async () => {
    const f = await fixture(2)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    const ghost = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await retire(ghost)
    await recordByHand(product, [ghost], f.cur)
    const result = await foldOrdinaryChain(f.args())
    expect(result).toMatchObject({ outcome: 'folded', recovered: false, sources: f.heads.map((h) => h.url) })
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_unpublished', product: product.documentId, reason: 'sources-unlisted',
    }))
    expect(f.lines.filter((line) => line.event === 'read_model.ordinary_chain_fold_abandoned')).toEqual([])
    expect(await status(ghost)).toBe('folded')
    // A newer record exists now; the old one is still examined.
    await ageRecord(product)
    await foldOrdinaryChain(f.args())
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_abandoned', product: product.documentId, reverted: [ghost.documentId],
    }))
    expect(await status(ghost)).toBe('retired')
  })

  // B1 of the step-5 review: "not listed here" is not "never published". A
  // splice that reached a client before its flush comes back with the
  // client; within retainMs the record and its rows are still there for it.
  it('a YOUNG unpublishable record is not undone: its rows and record stay, and a resurrected listing still vouches', async () => {
    const f = await fixture(2)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await recordByHand(product, [f.heads[0]!, f.heads[1]!], f.cur)
    f.heads[1]!.change((d) => { delete d.objects!.n0 })
    const result = await foldOrdinaryChain(f.args())
    expect(result).toMatchObject({ outcome: 'skipped' })
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_unpublished', product: product.documentId, reason: 'sources-changed',
      abandonAfterMs: 86_400_000,
    }))
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await status(product)).toBe('retired')
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', product.documentId)).toBeTruthy()
  })

  // A recorded fold that cannot be published is REPORTED ABANDONED and undone
  // (step 5), and the pass goes on: left `folded`, its listed sources would
  // split every run that crosses them for ever.
  it('a recorded fold whose sources are listed but not contiguous: abandoned, undone, and the pass folds them', async () => {
    const f = await fixture(4)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await recordByHand(product, [f.heads[0]!, f.heads[2]!], f.cur)
    await ageRecord(product)
    const result = await foldOrdinaryChain(f.args())
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_abandoned', product: product.documentId, reason: 'run-not-publishable',
      reverted: [f.heads[0]!.documentId, f.heads[2]!.documentId].sort(),
    }))
    expect(result).toMatchObject({ outcome: 'folded', recovered: false, sources: f.heads.map((h) => h.url) })
    expect(f.meta.doc()!.editsObjectShardUrls).not.toContain(product.url)
    // The next pass does not examine the abandoned record again.
    await foldOrdinaryChain(f.args())
    expect(f.lines.filter((line) => line.event === 'read_model.ordinary_chain_fold_abandoned')).toHaveLength(1)
  })

  // Recovery refuses a source that CHANGED since the record (a compaction's
  // clear, say): publishing would serve values older than the source's own.
  it('a recorded fold whose source changed since the record is NOT published: abandoned, sources-changed', async () => {
    const f = await fixture(2)
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await recordByHand(product, [f.heads[0]!, f.heads[1]!], f.cur)
    await ageRecord(product)
    f.heads[1]!.change((d) => { delete d.objects!.n0 })
    const before = JSON.stringify(f.meta.doc())
    const result = await foldOrdinaryChain(f.args())
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_abandoned', product: product.documentId, reason: 'sources-changed',
    }))
    // Undone: both retired again; h1 holds a write its row has not seen, so
    // nothing folds until it is forwarded.
    expect(result).toEqual({ outcome: 'skipped', reason: 'sources-not-settled' })
    expect(await status(f.heads[0]!)).toBe('retired')
    expect(await status(f.heads[1]!)).toBe('retired')
    expect(JSON.stringify(f.meta.doc())).toBe(before)
    expect(f.flush).not.toHaveBeenCalled()
  })

  // Step 5: the sweep runs in the pass and leaves what a cold build reads.
  it('a pass sweeps the expired rows of a product folded again, and logs it', async () => {
    const f = await fixture(3)
    expect(await foldOrdinaryChain(f.args({ budget: 2 }))).toMatchObject({ outcome: 'folded' })
    const first = f.products[0]!
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded', sources: [first.url, f.heads[2]!.url] })
    await db.pool.query(
      `UPDATE read_model_ordinary_head_retirements
          SET retain_until = now() - interval '1 second', updated_at = now() - interval '1 hour'
       WHERE status = 'folded'`,
    )
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'skipped' })
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_rows_swept', rows: 2, records: 1,
    }))
    expect(await status(f.heads[0]!)).toBeUndefined()
    expect(await status(f.heads[1]!)).toBeUndefined()
    expect(await status(first)).toBe('folded')
    expect(await status(f.heads[2]!)).toBe('folded')
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', first.documentId)).toBeUndefined()
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', f.products[1]!.documentId)).toBeTruthy()
  })

  // G4-16d: an old owner's late save sits BELOW a folded head's watermark,
  // where the pending probe cannot see it; only the projector's handover
  // re-check finds it, from the head's row. The sweep holds until that
  // re-check has run, then keeps the rows of the heads it still owes.
  it('the sweep is HELD while the handover re-check has not run, then keeps the rows of owed heads', async () => {
    const f = await fixture(3)
    expect(await foldOrdinaryChain(f.args({ budget: 2 }))).toMatchObject({ outcome: 'folded' })
    const first = f.products[0]!
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded', sources: [first.url, f.heads[2]!.url] })
    await db.pool.query(
      `UPDATE read_model_ordinary_head_retirements
          SET retain_until = now() - interval '1 second', updated_at = now() - interval '1 hour'
       WHERE status = 'folded'`,
    )
    // Held: nothing swept, and said so.
    let keep: { hold: boolean; documentIds: string[] } = { hold: true, documentIds: [] }
    expect(await foldOrdinaryChain({ ...f.args(), sweepKeep: () => keep })).toMatchObject({ outcome: 'skipped' })
    expect(f.lines).toContainEqual(expect.objectContaining({
      event: 'read_model.ordinary_chain_fold_rows_sweep_held', reason: 'handover-recheck-pending',
    }))
    expect(f.lines.filter((line) => line.event === 'read_model.ordinary_chain_fold_rows_swept')).toEqual([])
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await status(f.heads[1]!)).toBe('folded')
    // Run: the owed head's row stays, the other goes (and the record with
    // it only once no row is folded into its product).
    keep = { hold: false, documentIds: [String(f.heads[0]!.documentId)] }
    expect(await foldOrdinaryChain({ ...f.args(), sweepKeep: () => keep })).toMatchObject({ outcome: 'skipped' })
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await status(f.heads[1]!)).toBeUndefined()
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', first.documentId)).toBeTruthy()
    // Owed no more: the next pass takes it.
    keep = { hold: false, documentIds: [] }
    await foldOrdinaryChain({ ...f.args(), sweepKeep: () => keep })
    expect(await status(f.heads[0]!)).toBeUndefined()
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', first.documentId)).toBeUndefined()
  })

  // The QA lens's kill tests (phase 4 step 5), each pinning a check the
  // tests above could not fail on.

  /** h0 -> an aged record with a ghost source ModelMeta does not list: abandonable (sources-unlisted). */
  const abandonable = async (f: Fixture) => {
    const product = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    const ghost = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await retire(ghost)
    await recordByHand(product, [ghost, f.heads[0]!], f.cur)
    await ageRecord(product)
    return { product, ghost }
  }

  // Ownership lost between the lock and the undo: not-owner, record left alone.
  it('ownership lost before an abandon: not-owner, the record and its sources untouched', async () => {
    const f = await fixture(3)
    const { product, ghost } = await abandonable(f)
    let calls = 0
    const result = await foldOrdinaryChain(f.args({ mayWrite: () => ++calls <= 2 }))
    expect(result).toEqual({ outcome: 'not-owner' })
    expect(calls).toBe(3)
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', product.documentId)).toBeTruthy()
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await status(ghost)).toBe('folded')
    expect(f.lines.filter((line) => line.event === 'read_model.ordinary_chain_fold_abandoned')).toEqual([])
  })

  // The FIRST in-transaction check of this pass is the abandon's: it throwing
  // leaves the record whole and no session in a transaction.
  it('assertTransactionAuthority throwing in the ABANDON\'s transaction: nothing undone, rolled back', async () => {
    const f = await fixture(3)
    const { product, ghost } = await abandonable(f)
    const assertTransactionAuthority = vi.fn(async () => { throw new Error('plane moved') })
    await expect(foldOrdinaryChain(f.args({ assertTransactionAuthority }))).rejects.toThrow('plane moved')
    expect(assertTransactionAuthority).toHaveBeenCalledTimes(1)
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', product.documentId)).toBeTruthy()
    expect(await status(product)).toBe('retired')
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await status(ghost)).toBe('folded')
    expect(await idleInTransaction()).toBe(0)
  })

  // Nothing to fold and nothing pending, so the sweep's check is the only one
  // in the pass.
  it('assertTransactionAuthority throwing in the SWEEP\'s transaction: nothing swept, rolled back', async () => {
    const f = await fixture(3)
    await foldOrdinaryChain(f.args({ budget: 2 }))
    await foldOrdinaryChain(f.args())
    await db.pool.query(`UPDATE read_model_ordinary_head_retirements
        SET retain_until = now() - interval '1 second', updated_at = now() - interval '1 hour'
      WHERE status = 'folded'`)
    const assertTransactionAuthority = vi.fn(async () => { throw new Error('plane moved') })
    await expect(foldOrdinaryChain(f.args({ assertTransactionAuthority }))).rejects.toThrow('plane moved')
    expect(assertTransactionAuthority).toHaveBeenCalledTimes(1)
    expect(await status(f.heads[0]!)).toBe('folded')
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', f.products[0]!.documentId)).toBeTruthy()
    expect(f.lines.filter((line) => line.event === 'read_model.ordinary_chain_fold_rows_swept')).toEqual([])
    expect(await idleInTransaction()).toBe(0)
    // Control: the same pass with authority sweeps.
    await foldOrdinaryChain(f.args())
    expect(await status(f.heads[0]!)).toBeUndefined()
  })

  // A first pass has nothing to sweep, so the RECORD's check is the only one
  // it makes (the hook throws only once the product exists, as the
  // superseded tests' does).
  it('assertTransactionAuthority throwing only in the RECORD\'s transaction: no record, nothing published', async () => {
    const f = await fixture(3)
    let calls = 0
    const assertTransactionAuthority = vi.fn(async () => {
      calls += 1
      if (f.products.length) throw new Error('plane moved')
    })
    await expect(foldOrdinaryChain(f.args({ assertTransactionAuthority }))).rejects.toThrow('plane moved')
    expect(calls).toBe(1)
    expect(f.products).toHaveLength(1)
    expect(await readOrdinaryChainFold(db.pool, WS, 'object', f.products[0]!.documentId)).toBeUndefined()
    for (const h of f.heads) expect(await status(h)).toBe('retired')
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([...f.heads.map((h) => h.url), f.cur.url])
    expect(await idleInTransaction()).toBe(0)
  })

  it('a pass that sweeps nothing logs no sweep line', async () => {
    const f = await fixture(3)
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded' })
    expect(f.lines.map((line) => line.event)).not.toContain('read_model.ordinary_chain_fold_rows_swept')
  })

  // Only the LATEST record is a recovery candidate.
  it('an older recorded fold is never re-examined once a newer one exists', async () => {
    const f = await fixture(4)
    const older = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await recordByHand(older, [f.heads[0]!, f.heads[1]!], f.cur)
    const newer = f.repo.create<Seg>({ objects: {}, writeBatchIds: [] })
    await recordByHand(newer, [f.heads[2]!, f.heads[3]!], f.cur)
    const result = await foldOrdinaryChain(f.args())
    expect(result).toMatchObject({ outcome: 'folded', recovered: true, productUrl: newer.url })
    expect(f.meta.doc()!.editsObjectShardUrls).toEqual([f.heads[0]!.url, f.heads[1]!.url, newer.url, f.cur.url])
  })

  // Steps 7: SPLICED in place, so a concurrent append to the read-order list
  // (a client's new base shard, made offline) survives the merge.
  it('the substitution splices in place: a concurrent append to objectShardUrls survives the merge', async () => {
    const f = await fixture(2)
    const fork = A.clone(f.meta.doc() as A.Doc<Meta>)
    const clientShard = 'automerge:2Xm4Wb1vD3Q2zK5Lq7R8tY9uP1'
    const offline = A.change(fork, (d) => { d.objectShardUrls.push(clientShard) })
    expect(await foldOrdinaryChain(f.args())).toMatchObject({ outcome: 'folded' })
    f.meta.update((d) => A.merge(d, offline))
    const product = f.products[0]!
    expect(f.meta.doc()!.objectShardUrls).toEqual([f.base.url, product.url, f.cur.url, clientShard])
  })

  // A fold never takes a head the projector has not attached; one being
  // attached is pending, so the skip is the retried one.
  it('a retired head the projector does not WATCH is not folded, and the skip is retried', async () => {
    const f = await fixture(3)
    const result = await foldOrdinaryChain(f.args({ watched: (url) => url !== f.heads[1]!.url }))
    expect(result).toEqual({ outcome: 'skipped', reason: 'sources-not-settled' })
    expect(f.products).toEqual([])
  })
})

/** Make a record older than the default retainMs, so the writer may abandon it. */
async function ageRecord(product: DocHandle<Seg>) {
  await db.pool.query(
    `UPDATE read_model_ordinary_chain_folds SET created_at = now() - interval '2 days' WHERE product_document_id = $1`,
    [product.documentId],
  )
}

async function recordByHand(product: DocHandle<Seg>, sources: DocHandle<Seg>[], cur: DocHandle<Seg>) {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    await recordOrdinaryChainFold(client, WS, {
      collection: 'object',
      productDocumentId: product.documentId,
      productHeads: A.getHeads(product.doc() as A.Doc<unknown>),
      currentDocumentId: cur.documentId,
      sources: sources.map((s) => ({ documentId: s.documentId, forwardedHeads: null })),
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  expect(await readOrdinaryChainFold(db.pool, WS, 'object', product.documentId)).toBeTruthy()
}
