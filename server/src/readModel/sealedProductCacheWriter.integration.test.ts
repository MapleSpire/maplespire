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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { rowVersionSet } from './durableHeadsMemo.js'
import { HEADS_MOVED_ATTEMPTS, SealedProductCacheWriter, sealedRowsDigest } from './sealedProductCache.js'
import { DecodeWaitAbandoned, DurableDecodeError, durableHeadsDecoder, type DecodeWait } from './durableHeadsDecoder.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f C3: the sealed-product cache WRITER, against a real PostgreSQL,
 * documents written by a real Repo through the real storage adapter, and the
 * real strict decoder worker. Isolated schema, TEST_DATABASE_URL; skips
 * without one.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-spcw', versionId: 'v1' }

let db: IsolatedSchemaDb
let repo: Repo

type Product = { objects: Record<string, Record<string, unknown>> }

function storageRepo() {
  return new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })
}

/** A product of `n` entities with nested values (written in two changes, so
 * it has more than one content row). */
async function product(tag: string, n = 6, shape?: (id: string, at: number) => Record<string, unknown>): Promise<DocHandle<Product>> {
  const handle = repo.create<Product>({ objects: {} })
  handle.change((doc) => {
    for (let at = 0; at < n; at += 1) {
      const id = `${tag}-${at}`
      doc.objects[id] = shape ? shape(id, at) : { id, name: `N${at}`, type: 'system', zeta: at, alpha: { list: [at, 'x'], nested: { b: true } } }
    }
  })
  await repo.flush([handle.documentId])
  return handle
}

const task = (handle: DocHandle<Product>) =>
  ({ kind: 'object' as const, documentId: String(handle.documentId), heads: [...A.getHeads(handle.doc() as A.Doc<unknown>)] })

const refusal = async (documentId: string) => (await db.pool.query<{ refused_reason: string | null; entity_count: number; rows_digest: string }>(
  `SELECT refused_reason, entity_count, rows_digest FROM read_model_sealed_product_extracts
    WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND product_document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]
/** A writer whose structured lines are kept. */
function loggedWriter(options: Partial<ConstructorParameters<typeof SealedProductCacheWriter>[0]> = {}) {
  const lines: Array<Record<string, unknown>> = []
  const keep = (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>) }
  const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, log: keep, warn: keep, ...options })
  return { writer, lines, events: (event: string) => lines.filter((line) => line.event === event) }
}
const header = async (documentId: string) => (await db.pool.query<{
  rows_digest: string; heads: string[]; max_arrival_seq: string; extraction_version: number; entity_count: number
}>(
  `SELECT rows_digest, heads, max_arrival_seq::text AS max_arrival_seq, extraction_version, entity_count
     FROM read_model_sealed_product_extracts
    WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND product_document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]
const entities = async (documentId: string) => Object.fromEntries((await db.pool.query<{ entity_id: string; value: unknown }>(
  `SELECT entity_id, value FROM read_model_sealed_product_entities
    WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND product_document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows.map((row) => [row.entity_id, row.value]))
/** What the projector serves for a product: `indexSealedProduct`'s copy. */
const servedCopy = (handle: DocHandle<Product>) => JSON.parse(JSON.stringify(handle.doc().objects)) as Record<string, unknown>
const currentVersions = async (documentId: string) => (await db.pool.query<{ key: string; arrival_seq: string; octets: number }>(
  `SELECT key, arrival_seq::text AS arrival_seq, octet_length(data) AS octets FROM automerge_storage
    WHERE split_part(key, '/', 1) = $1`, [documentId],
)).rows.map((row) => ({ key: row.key, arrivalSeq: row.arrival_seq, octets: Number(row.octets) }))

/** The test pool, `before` offered each query (pool-level and on a client
 * from `connect()`) BEFORE it runs. (Copied: a test file imports no other.) */
function poolBeforeQuery(before: (text: string) => Promise<void> | void) {
  const wrapQuery = (target: { query: (...a: unknown[]) => unknown }) => async (...args: unknown[]) => {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
    await before(text)
    return target.query(...args)
  }
  return new Proxy(db.pool, {
    get(target, prop) {
      if (prop === 'query') return wrapQuery(target as never)
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(c, p) {
              if (p === 'query') return wrapQuery(c as never)
              const value = Reflect.get(c, p, c) as unknown
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
            },
          })
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as IsolatedSchemaDb['pool']
}

suite('G4-16f C3 — the sealed-product cache writer (real PostgreSQL, Repo, strict decoder)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'sealed_product_cache_writer')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    repo = storageRepo()
  })
  afterAll(async () => { await repo?.shutdown(); await db?.teardown() })
  let restore: () => void = () => {}
  beforeEach(async () => {
    await db.pool.query('TRUNCATE read_model_sealed_product_extracts, read_model_sealed_product_entities')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    restore = () => spy.mockRestore()
  })
  afterEach(() => restore())

  it('W1: writes the header (digest of the exact current row versions, heads, max arrival, extraction version 1, count) and exactly the served entity map', async () => {
    const p = await product('w1')
    const decodes = vi.spyOn(durableHeadsDecoder, 'decodeField')
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10 })
    writer.enqueue(task(p))
    await writer.idle()
    // Through the process-wide decoder, at BACKGROUND priority (it yields
    // to a waiting projection's proof).
    expect(decodes.mock.calls.map((call) => [call[0], call[3]])).toEqual([[String(p.documentId), 'background']])
    decodes.mockRestore()
    const versions = await currentVersions(String(p.documentId))
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(await header(String(p.documentId))).toEqual({
      rows_digest: sealedRowsDigest(rowVersionSet(versions)!),
      heads: [...A.getHeads(p.doc() as A.Doc<unknown>)],
      max_arrival_seq: versions.map((v) => BigInt(v.arrivalSeq)).reduce((a, b) => (a > b ? a : b)).toString(),
      extraction_version: 1,
      entity_count: 6,
    })
    expect(await entities(String(p.documentId))).toEqual(servedCopy(p))
    expect(writer.stats.written).toBe(1)
  }, 60_000)

  it('W2: rows that changed between the extraction and the write (the heads moved) write nothing', async () => {
    const p = await product('w2')
    const sampled = task(p)
    p.change((doc) => { doc.objects['w2-0']!.name = 'moved after the extraction' })
    await repo.flush([p.documentId])
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, retryDelayMs: 20 })
    writer.enqueue(sampled)
    await writer.idle()
    expect(await header(String(p.documentId))).toBeUndefined()
    expect(await entities(String(p.documentId))).toEqual({})
    // Tried again, and given up after a bound (a literal: three in all).
    expect(HEADS_MOVED_ATTEMPTS).toBe(3)
    expect(writer.stats.skipped['heads-moved']).toBe(3)
    // Control: the same writer caches it at the heads it now has.
    writer.enqueue(task(p))
    await writer.idle()
    expect((await header(String(p.documentId)))?.entity_count).toBe(6)
  }, 60_000)

  it('W3: bytes the strict decoder refuses, and a row without an arrival sequence, write nothing', async () => {
    await db.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ('garbage/incremental/1', decode('0001020304', 'hex'))`)
    await db.pool.query(`INSERT INTO automerge_storage (key, data, arrival_seq) VALUES ('noseq/incremental/1', decode('00', 'hex'), NULL)`)
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10 })
    writer.enqueue({ kind: 'object', documentId: 'garbage', heads: [] })
    writer.enqueue({ kind: 'object', documentId: 'noseq', heads: [] })
    writer.enqueue({ kind: 'object', documentId: 'absent', heads: [] })
    await writer.idle()
    expect(writer.stats.skipped).toEqual({ 'decode-refused': 1, 'no-arrival-seq': 1, 'no-rows': 1 })
    // The refusal is a header with no entity, against the rows it decided;
    // the two without a digest leave nothing.
    expect((await db.pool.query<{ id: string; reason: string; n: number }>(
      'SELECT product_document_id AS id, refused_reason AS reason, entity_count AS n FROM read_model_sealed_product_extracts')).rows)
      .toEqual([{ id: 'garbage', reason: 'decode-refused', n: 0 }])
    expect((await db.pool.query('SELECT 1 FROM read_model_sealed_product_entities')).rowCount).toBe(0)
  }, 60_000)

  it('W4: a rewrite is idempotent and REPLACES what is there (a corrupted value and a stray entity are gone)', async () => {
    const p = await product('w4')
    const id = String(p.documentId)
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10 })
    writer.enqueue(task(p))
    await writer.idle()
    const first = await header(id)
    await db.pool.query(`UPDATE read_model_sealed_product_entities SET value = '{"corrupt":true}'::jsonb WHERE entity_id = 'w4-0'`)
    await db.pool.query(`INSERT INTO read_model_sealed_product_entities (landscape_id, version_id, collection, product_document_id, entity_id, value)
      VALUES ($1, $2, 'object', $3, 'stray', '{}'::jsonb)`, [WS.landscapeId, WS.versionId, id])
    writer.enqueue(task(p))
    await writer.idle()
    expect(await header(id)).toEqual(first)
    expect(await entities(id)).toEqual(servedCopy(p))
    expect(writer.stats.written).toBe(2)
  }, 60_000)

  it('W5: the rate limit — a pause of the interval between two products', async () => {
    const products = [await product('w5a'), await product('w5b'), await product('w5c')]
    const written: number[] = []
    const pool = poolBeforeQuery((text) => {
      if (text.includes('INSERT INTO read_model_sealed_product_extracts')) written.push(performance.now())
    })
    const writer = new SealedProductCacheWriter({ db: pool, key: WS, intervalMs: 300 })
    for (const p of products) writer.enqueue(task(p))
    await writer.idle()
    expect(written).toHaveLength(3)
    // A literal, below 300 only by timer slack.
    for (let at = 1; at < written.length; at += 1) expect(written[at]! - written[at - 1]!).toBeGreaterThanOrEqual(290)
  }, 60_000)

  it('W6: stop() during a write rolls it back and gives the client back; it resolves once the write has unwound', async () => {
    const p = await product('w6')
    let releaseInsert!: () => void
    const insertHeld = new Promise<void>((resolve) => { releaseInsert = resolve })
    let reached!: () => void
    const insertReached = new Promise<void>((resolve) => { reached = resolve })
    const pool = poolBeforeQuery(async (text) => {
      if (!text.includes('INSERT INTO read_model_sealed_product_entities')) return
      reached()
      await insertHeld
    })
    // One batch: the stop lands during the LAST statement before COMMIT.
    const writer = new SealedProductCacheWriter({ db: pool, key: WS, intervalMs: 10, batchSize: 1_000 })
    writer.enqueue(task(p))
    await insertReached
    // Held inside its transaction: one client checked out.
    expect(db.pool.totalCount - db.pool.idleCount).toBe(1)
    let stopped = false
    const stopping = writer.stop().then(() => { stopped = true })
    await new Promise((r) => setTimeout(r, 100))
    // It waits for the write in flight.
    expect(stopped).toBe(false)
    releaseInsert()
    await stopping
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0)
    expect(await header(String(p.documentId))).toBeUndefined()
    expect(writer.stats.written).toBe(0)
    // Ignored once stopped.
    writer.enqueue(task(p))
    await writer.idle()
    expect(await header(String(p.documentId))).toBeUndefined()
  }, 60_000)

  it('W7: the pause comes BEFORE every job, the first after an idle queue included; stop() during it resolves at once and drops the queue', async () => {
    const [a, b] = [await product('w7a'), await product('w7b')]
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 60_000 })
    writer.enqueue(task(a))
    writer.enqueue(task(b))
    await new Promise((r) => setTimeout(r, 500))
    // Nothing yet: the first job waits out its pause too.
    expect(writer.stats.written).toBe(0)
    const startedAt = performance.now()
    await writer.stop()
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(await header(String(a.documentId))).toBeUndefined()
    expect(await header(String(b.documentId))).toBeUndefined()
  }, 60_000)

  it('W8: the first job after an idle queue waits the interval — the writer that just drained does not write the next park at once', async () => {
    const [a, b] = [await product('w8a'), await product('w8b')]
    const written: Array<{ id: string; at: number }> = []
    const pool = poolBeforeQuery((text) => {
      if (text.includes('INSERT INTO read_model_sealed_product_extracts')) written.push({ id: 'x', at: performance.now() })
    })
    const writer = new SealedProductCacheWriter({ db: pool, key: WS, intervalMs: 400 })
    const enqueuedA = performance.now()
    writer.enqueue(task(a))
    await writer.idle()
    // Idle now; the next product (a mid-session park) still waits.
    const enqueuedB = performance.now()
    writer.enqueue(task(b))
    await writer.idle()
    expect(written).toHaveLength(2)
    // Literals, below 400 only by timer slack.
    expect(written[0]!.at - enqueuedA).toBeGreaterThanOrEqual(390)
    expect(written[1]!.at - enqueuedB).toBeGreaterThanOrEqual(390)
  }, 60_000)

  it('W9: a heads-moved product whose rows catch up (the park\'s release flush) is written on a retry', async () => {
    const p = await product('w9')
    p.change((doc) => { doc.objects['w9-0']!.name = 'parked at these heads, not durable yet' })
    // The task names the NEW heads; the rows hold the old ones until the flush.
    const parked = task(p)
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, retryDelayMs: 300 })
    writer.enqueue(parked)
    for (let i = 0; i < 200 && !writer.stats.skipped['heads-moved']; i += 1) await new Promise((r) => setTimeout(r, 10))
    expect(writer.stats.skipped['heads-moved']).toBe(1)
    await repo.flush([p.documentId])
    await writer.idle()
    expect(writer.stats.written).toBe(1)
    expect(await entities(String(p.documentId))).toEqual(servedCopy(p))
  }, 60_000)

  it('W10: more entities than one batch are all written', async () => {
    const p = await product('w10', 7)
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, batchSize: 3 })
    writer.enqueue(task(p))
    await writer.idle()
    expect(writer.stats.written).toBe(1)
    expect((await header(String(p.documentId)))?.entity_count).toBe(7)
    expect(await entities(String(p.documentId))).toEqual(servedCopy(p))
  }, 60_000)

  it('W11: a product queued twice behind another job is decoded and written once', async () => {
    const [a, b] = [await product('w11a'), await product('w11b')]
    const decoded: string[] = []
    const writer = new SealedProductCacheWriter({
      db: db.pool, key: WS, intervalMs: 10,
      decode: async (documentId, chunks, field) => { decoded.push(documentId); return durableHeadsDecoder.decodeField(documentId, chunks, field) },
    })
    writer.enqueue(task(a))
    writer.enqueue(task(b))
    writer.enqueue(task(b))
    writer.enqueue(task(b))
    await writer.idle()
    expect(decoded.filter((id) => id === String(b.documentId))).toHaveLength(1)
    expect(writer.stats.written).toBe(2)
  }, 60_000)

  it('W12: a job queued after the drain\'s last check but before it settles is not stranded', async () => {
    const [a, b] = [await product('w12a'), await product('w12b')]
    const writer = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10 })
    let written = 0
    let armed = true
    // On the last bookkeeping of the first job: two microtask hops later the
    // drain has returned and its `finally` has not run yet.
    Object.defineProperty(writer.stats, 'written', {
      get: () => written,
      set: (value: number) => {
        written = value
        if (armed) { armed = false; queueMicrotask(() => queueMicrotask(() => writer.enqueue(task(b)))) }
      },
    })
    writer.enqueue(task(a))
    await writer.idle()
    await new Promise((r) => setTimeout(r, 300))
    await writer.idle()
    expect(written).toBe(2)
  }, 60_000)

  it('W13: a failing write rolls back whole (no header), gives its client back, and the next product is still written', async () => {
    const [a, b] = [await product('w13a'), await product('w13b')]
    let failed = false
    const pool = poolBeforeQuery((text) => {
      if (!failed && text.includes('INSERT INTO read_model_sealed_product_entities')) {
        failed = true
        throw new Error('test: injected insert failure')
      }
    })
    const writer = new SealedProductCacheWriter({ db: pool, key: WS, intervalMs: 10 })
    writer.enqueue(task(a))
    writer.enqueue(task(b))
    await writer.idle()
    expect(writer.stats.failed).toBe(1)
    expect(writer.stats.written).toBe(1)
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0)
    expect((await db.pool.query<{ id: string }>('SELECT product_document_id AS id FROM read_model_sealed_product_extracts')).rows
      .map((row) => row.id)).toEqual([String(b.documentId)])
  }, 60_000)

  it('W23 (G4-16f C5): onWritten fires once per product written, AFTER its commit (another connection sees the header), with the task and the header\'s digest — never for a heads-moved skip, a refusal or a rolled-back write', async () => {
    const [ok, moved, failing] = [await product('w23a'), await product('w23b'), await product('w23c')]
    const movedTask = task(moved)
    moved.change((doc) => { doc.objects['w23b-0']!.name = 'moved after the extraction' })
    await repo.flush([moved.documentId])
    await db.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ('w23garbage/incremental/1', decode('0001020304', 'hex'))`)
    const failingNow = { value: false }
    /** COMMITs issued through the writer's pool so far. */
    const commits = { value: 0 }
    const pool = poolBeforeQuery((text) => {
      if (text.trim().toUpperCase() === 'COMMIT') commits.value += 1
      if (text.includes('INSERT INTO read_model_sealed_product_entities') && failingNow.value) {
        failingNow.value = false
        throw new Error('test: injected insert failure')
      }
    })
    const calls: Array<{
      documentId: string; heads: readonly string[]; digest: string; commitsAtCall: number; seen: Promise<string | undefined>
    }> = []
    const writer = new SealedProductCacheWriter({
      db: pool, key: WS, intervalMs: 10, retryDelayMs: 20,
      onWritten: (written, digest) => {
        calls.push({ documentId: written.documentId, heads: written.heads, digest, commitsAtCall: commits.value,
          // From ANOTHER connection, at the moment of the call.
          seen: header(written.documentId).then((row) => row?.rows_digest) })
      },
    })
    writer.enqueue(task(ok))
    writer.enqueue(movedTask)
    writer.enqueue({ kind: 'object', documentId: 'w23garbage', heads: [] })
    await writer.idle()
    failingNow.value = true
    writer.enqueue(task(failing))
    await writer.idle()
    expect(writer.stats.written).toBe(1)
    expect(writer.stats.failed).toBe(1)
    expect(writer.stats.skipped['heads-moved']).toBe(3)
    expect(writer.stats.skipped['decode-refused']).toBe(1)
    expect(calls.map((call) => call.documentId)).toEqual([String(ok.documentId)])
    // The first job's own COMMIT had been issued (and awaited) when it fired.
    expect(calls[0]!.commitsAtCall).toBe(1)
    const stored = await header(String(ok.documentId))
    expect(calls[0]!.digest).toBe(stored?.rows_digest)
    expect(calls[0]!.heads).toEqual(stored?.heads)
    expect(await calls[0]!.seen).toBe(stored?.rows_digest)
    // A callback that throws is logged and changes nothing about the write.
    const { writer: throwing, events } = loggedWriter({ onWritten: () => { throw new Error('test: callback failure') } })
    const again = await product('w23d')
    throwing.enqueue(task(again))
    await throwing.idle()
    expect(throwing.stats.written).toBe(1)
    expect((await header(String(again.documentId)))?.entity_count).toBe(6)
    expect(events('read_model.sealed_product_cache_on_written_failed')).toHaveLength(1)
  }, 60_000)

  it('W14: a NUL in a string is refused by the JSONB insert — remembered against its rows, not retried; a lone surrogate is written', async () => {
    const nul = await product('w14nul', 2, (id) => ({ id, name: 'a\u0000b' }))
    const lone = await product('w14lone', 2, (id) => ({ id, name: 'a\uD800b' }))
    const { writer, events } = loggedWriter()
    writer.enqueue(task(nul))
    writer.enqueue(task(lone))
    await writer.idle()
    expect(writer.stats.skipped['insert-refused']).toBe(1)
    expect(writer.stats.written).toBe(1)
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0)
    const versions = await currentVersions(String(nul.documentId))
    expect(await refusal(String(nul.documentId))).toEqual({
      refused_reason: 'insert-refused', entity_count: 0, rows_digest: sealedRowsDigest(rowVersionSet(versions)!),
    })
    expect(events('read_model.sealed_product_cache_refused').map((line) => line.reason)).toEqual(['insert-refused'])
    expect(await entities(String(lone.documentId))).toEqual(servedCopy(lone))
    // The next cold build hands it over again: skipped unread, no insert tried.
    const inserts: string[] = []
    const pool = poolBeforeQuery((text) => { if (text.includes('INSERT INTO read_model_sealed_product_entities')) inserts.push(text) })
    const again = new SealedProductCacheWriter({
      db: pool, key: WS, intervalMs: 10,
      decode: async () => { throw new Error('test: a remembered refusal must not be decoded again') },
    })
    again.enqueue(task(nul))
    await again.idle()
    expect(again.stats.skipped).toEqual({ 'refused-before': 1 })
    expect(inserts).toEqual([])
    // New rows are a new digest: tried again.
    nul.change((doc) => { doc.objects['w14nul-0']!.name = 'clean now' ; doc.objects['w14nul-1']!.name = 'clean too' })
    await repo.flush([nul.documentId])
    const fresh = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10 })
    fresh.enqueue(task(nul))
    await fresh.idle()
    expect(fresh.stats.written).toBe(1)
    expect((await refusal(String(nul.documentId)))?.refused_reason).toBeNull()
  }, 60_000)

  it('W15: an integer beyond 2^53 (a BigInt the entity map cannot serialise) is refused as not-serializable, logged, and remembered', async () => {
    const big = await product('w15', 1, (id) => ({ id, value: 1152921504606846976 }))
    const { writer, events } = loggedWriter()
    writer.enqueue(task(big))
    await writer.idle()
    expect(writer.stats.skipped).toEqual({ 'not-serializable': 1 })
    expect((await refusal(String(big.documentId)))?.refused_reason).toBe('not-serializable')
    expect(events('read_model.sealed_product_cache_refused').map((line) => line.reason)).toEqual(['not-serializable'])
  }, 60_000)

  it('W16: a decoder that FAILS (no answer about the bytes) is logged and NOT remembered: the next attempt decodes', async () => {
    const p = await product('w16')
    const { writer, events } = loggedWriter({ decode: async () => { throw new Error('test: the worker crashed') } })
    writer.enqueue(task(p))
    await writer.idle()
    expect(writer.stats.skipped).toEqual({ 'decoder-failed': 1 })
    expect(await refusal(String(p.documentId))).toBeUndefined()
    expect(events('read_model.sealed_product_cache_refused').map((line) => line.reason)).toEqual(['decoder-failed'])
    // A strict refusal of the bytes, by contrast, IS a fact about them.
    const refused = loggedWriter({ decode: async () => { throw new DurableDecodeError('test: refused', 'refused') } })
    refused.writer.enqueue(task(p))
    await refused.writer.idle()
    expect(refused.writer.stats.skipped).toEqual({ 'decode-refused': 1 })
    expect((await refusal(String(p.documentId)))?.refused_reason).toBe('decode-refused')
  }, 60_000)

  it('W16b: the decode WAIT carries the writer\'s stop signal and a deadline; stop() ends a wait the queue would hold for ever', async () => {
    const p = await product('w16b')
    const waits: DecodeWait[] = []
    let waiting!: () => void
    const entered = new Promise<void>((resolve) => { waiting = resolve })
    // A decoder that never frees (another workspace's long proof): only the wait's own bounds end it.
    const { writer } = loggedWriter({
      maxDecodeWaitMs: 12_345,
      decode: (_id, _chunks, _field, wait) => new Promise((_resolve, reject) => {
        waits.push(wait)
        waiting()
        wait.signal?.addEventListener('abort', () => reject(new DecodeWaitAbandoned('aborted')), { once: true })
      }),
    })
    writer.enqueue(task(p))
    await entered
    expect(waits[0]?.maxWaitMs).toBe(12_345)
    expect(waits[0]?.signal?.aborted).toBe(false)
    const startedAt = performance.now()
    await writer.stop()
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    expect(waits[0]?.signal?.aborted).toBe(true)
    expect(writer.stats.written).toBe(0)
    expect(await refusal(String(p.documentId))).toBeUndefined()
  }, 60_000)

  it('W16d: the DEFAULT decode wait deadline (the option unset) is 30 s', async () => {
    const p = await product('w16d')
    const waits: DecodeWait[] = []
    let waiting!: () => void
    const entered = new Promise<void>((resolve) => { waiting = resolve })
    const { writer } = loggedWriter({
      decode: (_id, _chunks, _field, wait) => new Promise((_resolve, reject) => {
        waits.push(wait)
        waiting()
        wait.signal?.addEventListener('abort', () => reject(new DecodeWaitAbandoned('aborted')), { once: true })
      }),
    })
    writer.enqueue(task(p))
    await entered
    expect(waits[0]?.maxWaitMs).toBe(30_000)
    await writer.stop()
  }, 60_000)

  it('W16c: a decode wait past its deadline is skipped (decoder-busy), NOT remembered, and retried (bounded) until it decodes', async () => {
    const p = await product('w16c')
    let calls = 0
    const { writer } = loggedWriter({
      retryDelayMs: 20,
      decode: async (documentId, chunks, field) => {
        calls += 1
        if (calls === 1) throw new DecodeWaitAbandoned('timeout')
        return durableHeadsDecoder.decodeField(documentId, chunks, field)
      },
    })
    writer.enqueue(task(p))
    await writer.idle()
    expect(writer.stats.skipped).toEqual({ 'decoder-busy': 1 })
    expect(writer.stats.written).toBe(1)
    expect(calls).toBe(2)
    expect((await refusal(String(p.documentId)))?.refused_reason).toBeNull()
    // Always busy: HEADS_MOVED_ATTEMPTS tries in all, then given up; nothing remembered.
    const q = await product('w16c-busy')
    let busyCalls = 0
    const busy = loggedWriter({ retryDelayMs: 20, decode: async () => { busyCalls += 1; throw new DecodeWaitAbandoned('timeout') } })
    busy.writer.enqueue(task(q))
    await busy.writer.idle()
    expect(busyCalls).toBe(HEADS_MOVED_ATTEMPTS)
    expect(await refusal(String(q.documentId))).toBeUndefined()
  }, 60_000)

  it('W20: a remembered refusal of ANOTHER extraction version is not honoured (the writer decodes and writes)', async () => {
    const p = await product('qv1')
    const first = loggedWriter()
    first.writer.enqueue(task(p))
    await first.writer.idle()
    expect(first.writer.stats.written).toBe(1)
    // The same rows, a refusal remembered by code of another extraction version.
    await db.pool.query(`UPDATE read_model_sealed_product_extracts SET refused_reason = 'decode-refused', extraction_version = 0, entity_count = 0
      WHERE product_document_id = $1`, [String(p.documentId)])
    const second = loggedWriter()
    second.writer.enqueue(task(p))
    await second.writer.idle()
    expect(second.writer.stats.skipped['refused-before']).toBeUndefined()
    expect(second.writer.stats.written).toBe(1)
    expect((await refusal(String(p.documentId)))?.refused_reason).toBeNull()
  }, 60_000)

  it('W21: a table created before refused_reason existed gets the column (and its CHECK) on the next ensureReadModelSchema', async () => {
    await db.pool.query('ALTER TABLE read_model_sealed_product_extracts DROP COLUMN refused_reason')
    try {
      await ensureReadModelSchema(db.pool)
      const column = await db.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'read_model_sealed_product_extracts' AND column_name = 'refused_reason'`)
      expect(column.rowCount).toBe(1)
      await expect(db.pool.query(`INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
        rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
        VALUES ('l', 'v', 'object', 'bad', 'd', ARRAY[]::text[], 1, 1, 0, 'not-a-reason')`)).rejects.toMatchObject({ code: '23514' })
    } finally {
      // Whatever happened above, the suite's other tests need the column.
      await db.pool.query(`ALTER TABLE read_model_sealed_product_extracts ADD COLUMN IF NOT EXISTS refused_reason TEXT
        CHECK (refused_reason IN ('decode-refused', 'not-serializable', 'insert-refused'))`)
    }
  }, 60_000)

  it('W22: a header a plain write leaves reads as no refusal (refused_reason NULL, never a refused-before skip)', async () => {
    const p = await product('qv3')
    const w = loggedWriter()
    w.writer.enqueue(task(p))
    await w.writer.idle()
    expect((await refusal(String(p.documentId)))?.refused_reason).toBeNull()
    const again = loggedWriter()
    again.writer.enqueue(task(p))
    await again.writer.idle()
    expect(again.writer.stats.skipped['refused-before']).toBeUndefined()
    expect(again.writer.stats.written).toBe(1)
  }, 60_000)

  it('W17: every drain ends with ONE structured line of what it wrote and skipped, by reason — a writer that writes nothing says so', async () => {
    const p = await product('w17')
    const { writer, events } = loggedWriter()
    writer.enqueue(task(p))
    writer.enqueue({ kind: 'object', documentId: 'absent', heads: [] })
    await writer.idle()
    const drained = events('read_model.sealed_product_cache_drained')
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({
      workspace: `${WS.landscapeId}/${WS.versionId}`, written: 1, failed: 0, skipped: { 'no-rows': 1 },
      total: { written: 1, skipped: { 'no-rows': 1 } },
    })
    writer.enqueue({ kind: 'object', documentId: 'absent-too', heads: [] })
    await writer.idle()
    expect(events('read_model.sealed_product_cache_drained')[1]).toMatchObject({ written: 0, skipped: { 'no-rows': 1 }, total: { written: 1, skipped: { 'no-rows': 2 } } })
  }, 60_000)

  it('W18: HELD, nothing runs until start(); a held writer that is never started never writes', async () => {
    const [a, b] = [await product('w18a'), await product('w18b')]
    const held = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, held: true })
    held.enqueue(task(a))
    await new Promise((r) => setTimeout(r, 300))
    await held.idle()
    expect(held.stats.written).toBe(0)
    expect(await header(String(a.documentId))).toBeUndefined()
    held.start()
    await held.idle()
    expect(held.stats.written).toBe(1)
    const never = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, held: true })
    never.enqueue(task(b))
    await new Promise((r) => setTimeout(r, 300))
    expect(await header(String(b.documentId))).toBeUndefined()
  }, 60_000)

  it('W19: it waits while the workspace\'s foreground work is in flight, and writes once it ends', async () => {
    const p = await product('w19')
    let busy = true
    const written: number[] = []
    const pool = poolBeforeQuery((text) => {
      if (text.startsWith('SELECT key, arrival_seq::text AS arrival_seq, data FROM automerge_storage')) written.push(performance.now())
    })
    const writer = new SealedProductCacheWriter({ db: pool, key: WS, intervalMs: 10, foregroundBusy: () => busy })
    writer.enqueue(task(p))
    await new Promise((r) => setTimeout(r, 400))
    // Not even its first read while the foreground is busy.
    expect(written).toEqual([])
    const freedAt = performance.now()
    busy = false
    await writer.idle()
    expect(writer.stats.written).toBe(1)
    expect(written[0]!).toBeGreaterThanOrEqual(freedAt)
    expect(writer.stats.yieldedMs).toBeGreaterThanOrEqual(350)
    // Bounded: a foreground that never ends does not starve it for ever.
    const q = await product('w19b')
    const bounded = new SealedProductCacheWriter({ db: db.pool, key: WS, intervalMs: 10, foregroundBusy: () => true, maxYieldMs: 200 })
    bounded.enqueue(task(q))
    await bounded.idle()
    expect(bounded.stats.written).toBe(1)
  }, 60_000)
})
