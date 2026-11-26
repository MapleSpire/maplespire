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

// The durable-heads memo against real PostgreSQL, a real Repo and the patched
// StorageSubsystem.loadDoc (patch-automerge-strict-decode.mjs). Every binding
// here comes from an actual extraction-style load (`repo.find` on a Repo that
// has never seen the document), never from a hand-filled memo.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { getWorkspaceProjectionFreshness } from './health.js'
import { prepareDocumentWatermarkProofs, recordSampledDocumentWatermark } from './arrivalWatermark.js'
import { durableHeadsDecoder } from './durableHeadsDecoder.js'
import { DurableHeadsMemo, durableHeadsMemo, durableHeadsScopeSql } from './durableHeadsMemo.js'
import { startReadModelProjector, awaitInitialDiagramProbe } from './projectorService.js'
import type { Queryable } from './types.js'

const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const key = { landscapeId: 'heads-memo', versionId: 'v1' }
type Shard = { objects: { x: { id: string; name: string; type?: string } } }

async function database(name: string): Promise<IsolatedSchemaDb> {
  const db = await createIsolatedSchemaDb(connection!, `heads_memo_${name}`)
  try {
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
    return db
  } catch (error) {
    await db.teardown()
    throw error
  }
}

/** One document written by a first Repo, then a SECOND Repo on the same
 * storage that has never seen it: its `find` is the extraction-style load. */
async function fixture(name: string) {
  const db = await database(name)
  const memo = new DurableHeadsMemo()
  const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
  const writer = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
  const handle = writer.create<Shard>({ objects: { x: { id: 'x', name: 'H0' } } })
  await writer.flush()
  const h0 = handle.doc()
  await writer.shutdown()
  const reader = new Repo({ storage: adapter, network: [], saveDebounceRate: 0 })
  const documentId = handle.documentId
  const change = (from: A.Doc<Shard>, name: string) => A.change(A.clone(from), doc => { doc.objects.x.name = name })
  const target = () => [{ documentId, drainPendingSaves: () => reader.storageSubsystem!.drainDocumentSaves(documentId) }]
  const load = async () => (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
  const rowVersions = async () => (await db.pool.query<{ key: string; seq: string | null }>(
    `SELECT key, arrival_seq::text AS seq FROM automerge_storage WHERE split_part(key,'/',1)=$1 ORDER BY key`, [documentId])).rows
  return {
    db, memo, adapter, reader, documentId, url: handle.url, h0, change, target, load, rowVersions,
    async teardown() { await reader.shutdown(); await db.teardown() },
  }
}

afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { await durableHeadsDecoder.close() })

suite('durable heads memo (real PostgreSQL, Repo and patched loadDoc)', () => {
  it('an extraction load binds, and the proof then answers without re-reading data or decoding', async () => {
    const f = await fixture('binds')
    try {
      const i1 = f.change(f.h0, 'H1')
      await f.adapter.save([f.documentId, 'incremental', 'qa-i1'], A.saveSince(i1, A.getHeads(f.h0)))
      const loaded = await f.load()
      expect(A.getHeads(loaded.doc())).toEqual(A.getHeads(i1))
      expect(f.memo.size).toBe(1)
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const statements: string[] = []
      const observed: Queryable = { query: (async (sql: string, values?: unknown[]) => {
        statements.push(sql)
        return f.db.pool.query(sql, values)
      }) as Queryable['query'] }
      const prepared = await prepareDocumentWatermarkProofs(observed, f.target(), f.memo)
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      expect(f.memo.hits).toBe(1)
      expect(decode).not.toHaveBeenCalled()
      // capture + metadata only: no statement selected the bytes.
      expect(statements).toHaveLength(2)
      expect(statements.filter(sql => /octet_length\(storage\.data\)/.test(sql))).toHaveLength(1)
      expect(statements.filter(sql => /storage\.data(?!\))/.test(sql))).toHaveLength(0)
      // Control: without the memo the same proof reads and decodes.
      const control = await prepareDocumentWatermarkProofs(f.db.pool, f.target())
      expect(control.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      expect(decode).toHaveBeenCalledTimes(1)
    } finally { await f.teardown() }
  })

  it('the same key rewritten with different bytes of the same length decodes again', async () => {
    const f = await fixture('upsert')
    try {
      const i1 = f.change(f.h0, 'H1')
      const other = f.change(f.h0, 'Hz')
      const first = A.saveSince(i1, A.getHeads(f.h0))
      const second = A.saveSince(other, A.getHeads(f.h0))
      // The precondition that makes arrival_seq the only discriminator.
      expect(second.byteLength).toBe(first.byteLength)
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(false)
      await f.adapter.save([f.documentId, 'incremental', 'qa-k'], first)
      await f.load()
      expect(f.memo.size).toBe(1)
      const before = await f.rowVersions()
      await f.adapter.save([f.documentId, 'incremental', 'qa-k'], second)
      const after = await f.rowVersions()
      expect(after.map(row => row.key)).toEqual(before.map(row => row.key))
      expect(after.find(row => row.key.endsWith('qa-k'))!.seq).not.toBe(before.find(row => row.key.endsWith('qa-k'))!.seq)
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const prepared = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(other))
      expect(decode).toHaveBeenCalledTimes(1)
    } finally { await f.teardown() }
  })

  it('a compaction overlapping the proof (new snapshot, then old chunks deleted) falls back both times', async () => {
    const f = await fixture('compaction')
    try {
      const i1 = f.change(f.h0, 'H1')
      const i2 = f.change(i1, 'H2')
      await f.adapter.save([f.documentId, 'incremental', 'qa-i1'], A.saveSince(i1, A.getHeads(f.h0)))
      await f.load()
      expect(f.memo.size).toBe(1)
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      // Mid-compaction: the new snapshot is durable, the old chunks are not yet
      // removed — a SUPERSET of the remembered set.
      await f.adapter.save([f.documentId, 'snapshot', 'qa-s2'], A.save(i2))
      const mid = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(mid.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i2))
      expect(decode).toHaveBeenCalledTimes(1)
      for (const row of await f.rowVersions()) {
        if (!row.key.endsWith('qa-s2')) await f.adapter.remove(row.key.split('/'))
      }
      const after = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(after.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i2))
      expect(decode).toHaveBeenCalledTimes(2)
    } finally { await f.teardown() }
  })

  it('a foreign insert of an incremental falls back to a decode', async () => {
    const f = await fixture('foreign')
    try {
      await f.load()
      expect(f.memo.size).toBe(1)
      const i1 = f.change(f.h0, 'H1')
      await f.db.pool.query('INSERT INTO automerge_storage(key,data) VALUES($1,$2)',
        [`${f.documentId}/incremental/qa-foreign`, Buffer.from(A.saveSince(i1, A.getHeads(f.h0)))])
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const prepared = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      expect(decode).toHaveBeenCalledTimes(1)
    } finally { await f.teardown() }
  })

  it('a trailing-garbage chunk takes the loadIncremental fallback and binds nothing; the proof still refuses', async () => {
    const f = await fixture('garbage')
    try {
      const i1 = f.change(f.h0, 'H1')
      await f.adapter.save([f.documentId, 'incremental', 'qa-i1'], A.saveSince(i1, A.getHeads(f.h0)))
      // Inserted last, so loadRange (no ORDER BY: heap order here) returns it
      // last and it is TRAILING garbage — the shape only the fallback opens.
      await f.adapter.save([f.documentId, 'incremental', 'qa-garbage'], new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let fallbackWarnings = 0
      let name: string
      try {
        name = (await f.load()).doc().objects.x.name
        fallbackWarnings = warn.mock.calls.filter(call => call.some(part => String(part).includes('falling back to incremental'))).length
      } finally { warn.mockRestore() }
      // Presence first: the fallback path WAS taken and the document opened.
      // (Measured here: it opens at H0 — the fallback is permissive, which is
      // exactly why it must never bind.)
      expect(fallbackWarnings).toBe(1)
      expect(name).toBe('H0')
      expect(f.memo.size).toBe(0)
      await expect(prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)).rejects.toThrow(/magic bytes|parse/)
    } finally { await f.teardown() }
  })

  it('a dependency-less incremental binds nothing and the proof refuses', async () => {
    const f = await fixture('missing_deps')
    try {
      const i1 = f.change(f.h0, 'H1')
      const i2 = f.change(i1, 'H2')
      await f.adapter.save([f.documentId, 'incremental', 'qa-i2'], A.saveSince(i2, A.getHeads(i1)))
      const loaded = await f.load()
      // Presence first: A.load accepted the readable prefix.
      expect(A.getHeads(loaded.doc())).toEqual(A.getHeads(f.h0))
      expect(f.memo.size).toBe(0)
      await expect(prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)).rejects.toThrow(/incomplete durable document dependencies/)
    } finally { await f.teardown() }
  })

  it('a NULL arrival_seq row binds nothing and every proof decodes', async () => {
    const f = await fixture('null_seq')
    try {
      await f.db.pool.query(`UPDATE automerge_storage SET arrival_seq=NULL WHERE split_part(key,'/',1)=$1`, [f.documentId])
      await f.load()
      expect(f.memo.size).toBe(0)
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      for (let round = 0; round < 2; round++) {
        const prepared = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
        expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(f.h0))
      }
      expect(decode).toHaveBeenCalledTimes(2)
      expect(f.memo.size).toBe(0)
    } finally { await f.teardown() }
  })

  it('a row minted above watermarkPost still refuses the certificate', async () => {
    const f = await fixture('above_post')
    try {
      const loaded = await f.load()
      expect(f.memo.size).toBe(1)
      const sampled = A.getHeads(loaded.doc())
      const i1 = f.change(f.h0, 'H1')
      let inserted = false
      // The foreign arrival lands after the capture, before the metadata read.
      const racing: Queryable = { query: (async (sql: string, values?: unknown[]) => {
        const result = await f.db.pool.query(sql, values)
        if (!inserted && /nextval\('automerge_arrival_seq'\)/.test(sql)) {
          inserted = true
          await f.db.pool.query('INSERT INTO automerge_storage(key,data) VALUES($1,$2)',
            [`${f.documentId}/incremental/qa-late`, Buffer.from(A.saveSince(i1, A.getHeads(f.h0)))])
        }
        return result
      }) as Queryable['query'] }
      const prepared = await prepareDocumentWatermarkProofs(racing, f.target(), f.memo)
      expect(inserted).toBe(true)
      const late = (await f.rowVersions()).find(row => row.key.endsWith('qa-late'))!
      expect(BigInt(late.seq!)).toBeGreaterThan(BigInt(prepared.watermarkPost))
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      await recordSampledDocumentWatermark(f.db.pool, key, f.documentId, sampled, () => sampled, prepared)
      const stamp = (await f.db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [f.documentId])).rows[0].stamp
      expect(stamp).toBe('0')
    } finally { await f.teardown() }
  })

  /** A real cold build: the reader Repo's adapter reads on `db.pool`, the
   * projector's proof on `projectorPool(db)`. */
  async function coldBuild(name: string, projectorPool: (db: IsolatedSchemaDb) => pg.Pool | Promise<pg.Pool>) {
    const db = await database(name)
    const writer = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
    let reader: Repo | undefined
    let stop: (() => void) | undefined
    try {
      const shard = writer.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
      const meta = writer.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
      const root = writer.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await writer.flush()
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        [shard.documentId, key.landscapeId, key.versionId])
      await writer.shutdown()
      const proofPool = await projectorPool(db)
      durableHeadsMemo.clear()
      const hitsBefore = durableHeadsMemo.hits
      // The production default: the adapter feeds the process-wide memo, and
      // the projector's proof reads it.
      reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      stop = await startReadModelProjector(reader, root.url, proofPool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
      const stamp = (await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0]?.stamp
      expect(BigInt(stamp ?? '0')).toBeGreaterThan(0n)
      expect(durableHeadsMemo.hits - hitsBefore).toBeGreaterThanOrEqual(1)
      expect(decode.mock.calls.filter(([documentId]) => documentId === shard.documentId)).toHaveLength(0)
    } finally {
      stop?.()
      await reader?.shutdown()
      durableHeadsMemo.clear()
      await db.teardown()
    }
  }

  it('a real cold build certifies its shard through extraction-load hits, without a durable decode', async () => {
    await coldBuild('cold_build', db => db.pool)
  })

  // Production's shape: the sync Repo's adapter reads on `pool`, the fleet's
  // projector on `readModelPool` — two Pool objects, one database
  // (`index.ts`, `dbConfig.ts` readModelDatabasePoolConfig). Scoping the memo
  // by Pool object (or giving the projector a memo of its own) loses only
  // SPEED — the proof decodes instead — and this is the test that sees it.
  it('a cold build on a SECOND pool of the same schema still certifies through the adapter\'s hits', async () => {
    let second: pg.Pool | undefined
    try {
      await coldBuild('cold_build_two_pools', db => {
        second = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 3, options: `-c search_path=${db.schema}` }),
          'heads-memo:second-pool')
        return second
      })
    } finally { await second?.end() }
  })
})

/** Insert `bytes` under `key` in `db`; returns the row's arrival_seq. */
async function insertRow(db: IsolatedSchemaDb, rowKey: string, bytes: Uint8Array): Promise<string> {
  return (await db.pool.query<{ s: string }>('INSERT INTO automerge_storage(key,data) VALUES($1,$2) RETURNING arrival_seq::text AS s',
    [rowKey, Buffer.from(bytes)])).rows[0].s
}

/** Two documents with the same byte length and different heads: the
 * precondition that leaves the table as the only discriminator. */
function twoRevisions() {
  const h0 = A.from({ n: 0 })
  const a1 = A.change(A.clone(h0), doc => { doc.n = 1 })
  const a2 = A.change(A.clone(h0), doc => { doc.n = 2 })
  const bytes1 = A.save(a1), bytes2 = A.save(a2)
  expect(bytes1.byteLength).toBe(bytes2.byteLength)
  expect(A.getHeads(a1)).not.toEqual(A.getHeads(a2))
  return { a1, a2, bytes1, bytes2 }
}

suite('durable heads memo: the scope and its edge cases (P1-P10)', () => {
  it('P8 two tables, same document id, same key/seq/length, different bytes: the second proof is not certified with the first\'s heads', async () => {
    const one = await database('p8a')
    const two = await database('p8b')
    try {
      const { a1, a2, bytes1, bytes2 } = twoRevisions()
      const seq1 = await insertRow(one, 'same/snapshot/s', bytes1)
      const seq2 = await insertRow(two, 'same/snapshot/s', bytes2)
      // Presence: the row versions really collide (per-schema sequences).
      expect(seq2).toBe(seq1)
      const memo = new DurableHeadsMemo()
      const target = [{ documentId: 'same', drainPendingSaves: async () => {} }]
      const p1 = await prepareDocumentWatermarkProofs(one.pool, target, memo)
      expect(p1.durableHeadsById.get('same')).toEqual(A.getHeads(a1))
      expect(memo.size).toBe(1)
      const p2 = await prepareDocumentWatermarkProofs(two.pool, target, memo)
      expect(p2.durableHeadsById.get('same')).toEqual(A.getHeads(a2))
      expect(memo.hits).toBe(0)
      // Each table then answers from its own entry.
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      expect((await prepareDocumentWatermarkProofs(one.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a1))
      expect((await prepareDocumentWatermarkProofs(two.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a2))
      expect(memo.hits).toBe(2)
      expect(decode).not.toHaveBeenCalled()
    } finally { await one.teardown(); await two.teardown() }
  })

  it('P8b the same collision fed by an ADAPTER load in one table cannot certify the proof in the other', async () => {
    const one = await database('p8c')
    const two = await database('p8d')
    try {
      const { a1, a2, bytes1, bytes2 } = twoRevisions()
      expect(await insertRow(two, 'same/snapshot/s', bytes2)).toBe(await insertRow(one, 'same/snapshot/s', bytes1))
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: one.pool, durableHeadsMemo: memo })
      // What the patched loadDoc does after a strict A.load of these chunks.
      const chunks = await adapter.loadRange(['same'])
      expect(chunks).toHaveLength(1)
      adapter.noteStrictDecode('same', chunks, A.getHeads(a1))
      expect(memo.size).toBe(1)
      const target = [{ documentId: 'same', drainPendingSaves: async () => {} }]
      // Control: the adapter's entry DOES answer the proof in its own table.
      expect((await prepareDocumentWatermarkProofs(one.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a1))
      expect(memo.hits).toBe(1)
      expect((await prepareDocumentWatermarkProofs(two.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a2))
      expect(memo.hits).toBe(1)
    } finally { await one.teardown(); await two.teardown() }
  })

  it('a dropped and recreated table restarts its sequence under a new scope', async () => {
    const db = await database('recreated')
    try {
      const { a1, a2, bytes1, bytes2 } = twoRevisions()
      const scopeOfTable = async () => (await db.pool.query<{ scope: string }>(
        `SELECT ${durableHeadsScopeSql('storage')} AS scope FROM automerge_storage AS storage LIMIT 1`)).rows[0].scope
      const seq1 = await insertRow(db, 'same/snapshot/s', bytes1)
      const memo = new DurableHeadsMemo()
      const target = [{ documentId: 'same', drainPendingSaves: async () => {} }]
      expect((await prepareDocumentWatermarkProofs(db.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a1))
      const before = await scopeOfTable()
      await db.pool.query('DROP TABLE automerge_storage')
      await db.pool.query(`ALTER SEQUENCE automerge_arrival_seq RESTART WITH ${seq1}`)
      await db.pool.query(`CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
      expect(await insertRow(db, 'same/snapshot/s', bytes2)).toBe(seq1)
      expect(await scopeOfTable()).not.toBe(before)
      expect((await prepareDocumentWatermarkProofs(db.pool, target, memo)).durableHeadsById.get('same')).toEqual(A.getHeads(a2))
    } finally { await db.teardown() }
  })

  it('P1 a pending save is drained BEFORE the metadata read: the proof sees the new row', async () => {
    const f = await fixture('p1')
    try {
      const loaded = await f.load()
      expect(f.memo.size).toBe(1)
      const realSave = f.adapter.save.bind(f.adapter)
      let delayed = 0
      f.adapter.save = async (k, d) => { delayed++; await new Promise(r => setTimeout(r, 300)); return realSave(k, d) }
      loaded.change(doc => { doc.objects.x.name = 'PENDING' })
      await new Promise(r => setTimeout(r, 50))
      // Presence: the save is in flight when the proof starts.
      expect(delayed).toBeGreaterThan(0)
      const prepared = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(loaded.doc()))
      expect(A.getHeads(loaded.doc())).not.toEqual(A.getHeads(f.h0))
    } finally { await f.teardown() }
  })

  it('P2 a row landing between the metadata and the data statements: this proof decodes it, the NEXT proof hits', async () => {
    const f = await fixture('p2')
    try {
      const i1 = f.change(f.h0, 'H1')
      let inserted = false
      const racing: Queryable = { query: (async (sql: string, values?: unknown[]) => {
        const result = await f.db.pool.query(sql, values)
        if (!inserted && /octet_length\(storage\.data\)/.test(sql)) {
          inserted = true
          await f.db.pool.query('INSERT INTO automerge_storage(key,data) VALUES($1,$2)',
            [`${f.documentId}/incremental/qa-late`, Buffer.from(A.saveSince(i1, A.getHeads(f.h0)))])
        }
        return result
      }) as Queryable['query'] }
      const first = await prepareDocumentWatermarkProofs(racing, f.target(), f.memo)
      expect(inserted).toBe(true)
      expect(first.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const second = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(second.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(i1))
      expect(decode).not.toHaveBeenCalled()
    } finally { await f.teardown() }
  })

  it('P3 a sync-state row beside the content rows does not defeat the hit', async () => {
    const f = await fixture('p3')
    try {
      await f.load()
      await f.db.pool.query('INSERT INTO automerge_storage(key,data,arrival_seq) VALUES($1,$2,NULL)',
        [`${f.documentId}/sync-state/peer`, Buffer.from([1, 2, 3])])
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const prepared = await prepareDocumentWatermarkProofs(f.db.pool, f.target(), f.memo)
      expect(prepared.durableHeadsById.get(f.documentId)).toEqual(A.getHeads(f.h0))
      expect(f.memo.hits).toBe(1)
      expect(decode).not.toHaveBeenCalled()
    } finally { await f.teardown() }
  })

  it('P4a removeRange forgets the document', async () => {
    const f = await fixture('p4a')
    try {
      await f.load()
      expect(f.memo.size).toBe(1)
      await f.adapter.removeRange([f.documentId, 'incremental'])
      expect(f.memo.size).toBe(0)
    } finally { await f.teardown() }
  })

  it('P4b a refused bind (a chunk this adapter never read) forgets an existing entry', async () => {
    const f = await fixture('p4b')
    try {
      await f.load()
      expect(f.memo.size).toBe(1)
      f.adapter.noteStrictDecode(f.documentId, [{ key: [f.documentId, 'snapshot', 'never-read'], data: new Uint8Array(3) }], ['h'])
      expect(f.memo.size).toBe(0)
    } finally { await f.teardown() }
  })

  it('P7 a document whose id is a prefix of another keeps its own set', async () => {
    const db = await database('p7')
    try {
      const h0 = A.from({ n: 0 })
      for (const id of ['dA', 'dAB']) await insertRow(db, `${id}/snapshot/s`, A.save(h0))
      const memo = new DurableHeadsMemo()
      const targets = ['dA', 'dAB'].map(documentId => ({ documentId, drainPendingSaves: async () => {} }))
      await prepareDocumentWatermarkProofs(db.pool, targets, memo)
      expect(memo.size).toBe(2)
      const prepared = await prepareDocumentWatermarkProofs(db.pool, targets, memo)
      expect(memo.hits).toBe(2)
      expect(prepared.durableHeadsById.get('dA')).toEqual(A.getHeads(h0))
      expect(prepared.durableHeadsById.get('dAB')).toEqual(A.getHeads(h0))
    } finally { await db.teardown() }
  })

  it('P10a a chunk whose key disagrees with the row version binds nothing; the real chunks do', async () => {
    const f = await fixture('p10a')
    try {
      const chunks = await f.adapter.loadRange([f.documentId])
      expect(chunks.length).toBeGreaterThan(0)
      f.adapter.noteStrictDecode(f.documentId, chunks.map(c => ({ ...c, key: [c.key[0], c.key[1], 'renamed'] })), ['h'])
      expect(f.memo.size).toBe(0)
      f.adapter.noteStrictDecode(f.documentId, chunks, ['h'])
      expect(f.memo.size).toBe(1)
    } finally { await f.teardown() }
  })

  it('P10b a chunk of another document binds nothing', async () => {
    const f = await fixture('p10b')
    try {
      const chunks = await f.adapter.loadRange([f.documentId])
      expect(chunks.length).toBeGreaterThan(0)
      f.adapter.noteStrictDecode('someoneElse', chunks, ['h'])
      expect(f.memo.size).toBe(0)
      // Control: the same chunks under their own document do bind.
      f.adapter.noteStrictDecode(f.documentId, chunks, ['h'])
      expect(f.memo.size).toBe(1)
    } finally { await f.teardown() }
  })
})
