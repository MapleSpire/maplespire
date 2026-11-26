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

// `PostgresStorageAdapter.compactToSnapshot` (G4-16f) against real PostgreSQL
// and real Repos: the rows a document's storage is reduced to, what a fresh
// Repo then loads, crash atomicity, the exact-version delete, the fence, and
// the durable-heads memo entry it leaves. Every "mutant" test names the change
// to the code it kills; each was checked RED against that change.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter, StaleSyncCellWriteError } from './automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { ensureReadModelSchema } from './readModel/schema.js'
import { ensureSyncCellOwnershipSchema } from './syncCells/ownership.js'
import { prepareDocumentWatermarkProofs } from './readModel/arrivalWatermark.js'
import { durableHeadsDecoder } from './readModel/durableHeadsDecoder.js'
import { DurableHeadsMemo, durableHeadsScopeSql, type ScopedRowVersion } from './readModel/durableHeadsMemo.js'
import { snapshotStorageKey } from './storageSnapshotCompaction.js'

const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WORKSPACE = { landscapeId: 'snapshot-compaction', versionId: 'v1' }
type Shard = { objects: Record<string, { id: string; name: string; description: string }> }

async function database(name: string): Promise<IsolatedSchemaDb> {
  const db = await createIsolatedSchemaDb(connection!, `snapshot_compaction_${name}`)
  try {
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)`)
    await db.pool.query(`CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [WORKSPACE.landscapeId, 'Compaction'])
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:x')`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId])
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
    return db
  } catch (error) {
    await db.teardown()
    throw error
  }
}

/** A base-shard-like document written by a Repo the way the fold writes it:
 * one snapshot (the first save), then one incremental row per flushed edit. */
async function writtenShard(db: IsolatedSchemaDb, edits: number, saveDebounceRate = 0) {
  const writer = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate })
  const objects: Shard['objects'] = {}
  for (let i = 0; i < 60; i += 1) objects[`o${i}`] = { id: `o${i}`, name: `object ${i}`, description: `a description long enough to matter ${i}` }
  const handle = writer.create<Shard>({ objects })
  await writer.flush()
  for (let e = 0; e < edits; e += 1) {
    handle.change((d) => { d.objects[`o${e % 60}`]!.name = `edit ${e}` })
    await writer.flush()
  }
  return { writer, handle, documentId: String(handle.documentId) }
}

async function storedRows(db: IsolatedSchemaDb, documentId: string): Promise<Array<ScopedRowVersion & { data: Uint8Array }>> {
  const { rows } = await db.pool.query<{ key: string; arrival_seq: string | null; data: Buffer; durable_scope: string }>(
    `SELECT key, arrival_seq::text AS arrival_seq, data, ${durableHeadsScopeSql('automerge_storage')} AS durable_scope
     FROM automerge_storage WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
     ORDER BY CASE split_part(key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END, key`, [documentId])
  return rows.map((row) => ({ key: row.key, arrivalSeq: row.arrival_seq, octets: row.data.byteLength, scope: row.durable_scope, data: new Uint8Array(row.data) }))
}

/** The STRICT decode of the stored rows: what the proof's worker computes. */
async function strictHeads(db: IsolatedSchemaDb, documentId: string): Promise<readonly string[]> {
  return durableHeadsDecoder.decode(documentId, (await storedRows(db, documentId)).map((row) => row.data))
}

/** The memo's ORACLE: whatever the memo answers for the CURRENT rows is the strict
 * decode of exactly those rows. Holds in every test below. */
async function expectMemoSound(db: IsolatedSchemaDb, memo: DurableHeadsMemo, documentId: string): Promise<readonly string[] | undefined> {
  const rows = await storedRows(db, documentId)
  const hits = memo.hits
  const misses = memo.misses
  const answer = memo.lookup(documentId, rows)
  memo.hits = hits
  memo.misses = misses
  if (answer) expect([...answer].sort()).toEqual([...await strictHeads(db, documentId)].sort())
  return answer
}

/** A Pool whose clients run `before` ahead of each statement `match` names
 * (by default the compaction statement). */
function interceptingPool(pool: pg.Pool, before: (sql: string) => Promise<void>, match = (sql: string) => sql.includes('compaction_insert')): pg.Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async () => {
        const client = await target.connect()
        return new Proxy(client, {
          get(c, p) {
            if (p === 'query') {
              return async (sql: unknown, params?: unknown[]) => {
                if (typeof sql === 'string' && match(sql)) await before(sql)
                return (c.query as (s: unknown, v?: unknown[]) => Promise<unknown>)(sql, params)
              }
            }
            const value = Reflect.get(c, p)
            return typeof value === 'function' ? value.bind(c) : value
          },
        })
      }
    },
  }) as pg.Pool
}

afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { await durableHeadsDecoder.close() })

suite('compactToSnapshot (G4-16f, real PostgreSQL)', () => {
  it('reduces a snapshot + incrementals to ONE snapshot; a fresh Repo loads the same document', async () => {
    const db = await database('reduce')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 6)
      const before = await storedRows(db, documentId)
      expect(before.length).toBe(7)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      const doc = handle.doc()!
      const outcome = await adapter.compactToSnapshot(documentId, doc)
      expect(outcome).toMatchObject({ outcome: 'compacted', rowsBefore: 7, removed: 7, kept: 0, remembered: true })
      const after = await storedRows(db, documentId)
      expect(after.map((row) => row.key)).toEqual([snapshotStorageKey(documentId, A.getHeads(doc)).join('/')])
      const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
      const loaded = (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
      expect(A.getHeads(loaded.doc()!)).toEqual(A.getHeads(doc))
      expect(A.toJS(loaded.doc()!)).toEqual(A.toJS(doc))
      await reader.shutdown()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('the proof hits the memo on the compacted row, with the heads a strict decode gives, without decoding', async () => {
    const db = await database('proof')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 4)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      const doc = handle.doc()!
      await adapter.compactToSnapshot(documentId, doc)
      const decode = vi.spyOn(durableHeadsDecoder, 'decode')
      const prepared = await prepareDocumentWatermarkProofs(db.pool, [{ documentId, drainPendingSaves: async () => {} }], memo)
      expect(prepared.durableHeadsById.get(documentId)).toEqual(A.getHeads(doc))
      expect(memo.hits).toBe(1)
      expect(decode).not.toHaveBeenCalled()
      decode.mockRestore()
      expect(await expectMemoSound(db, memo, documentId)).toEqual(A.getHeads(doc))
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('mutant "remember the set left beside the snapshot": a row the document lacks is KEPT and the memo never certifies the set', async () => {
    const db = await database('foreign')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const doc = handle.doc()!
      // A change the compacting document does not have (another writer's),
      // stored as an incremental row.
      const fork = A.change(A.clone(doc, { actor: 'ab'.repeat(16) }), (d) => { d.objects.o1!.name = 'foreign' })
      const raw = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null })
      await raw.save([documentId, 'incremental', 'foreign-row'], A.saveSince(fork, A.getHeads(doc)))
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      const outcome = await adapter.compactToSnapshot(documentId, doc)
      // `remembered` only when nothing is left beside the snapshot.
      expect(outcome).toMatchObject({ outcome: 'compacted', rowsBefore: 5, removed: 4, kept: 1, remembered: false })
      expect(memo.size).toBe(0)
      const after = await storedRows(db, documentId)
      expect(after.map((row) => row.key)).toContain(`${documentId}/incremental/foreign-row`)
      // The remembered entry is the snapshot row alone: the CURRENT set (two
      // rows) misses, and the strict decode includes the foreign change.
      expect(await expectMemoSound(db, memo, documentId)).toBeUndefined()
      const prepared = await prepareDocumentWatermarkProofs(db.pool, [{ documentId, drainPendingSaves: async () => {} }], memo)
      expect(prepared.durableHeadsById.get(documentId)).toEqual(A.getHeads(A.merge(A.clone(doc), fork)))
      const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
      const loaded = (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
      expect(loaded.doc()!.objects.o1!.name).toBe(A.merge(A.clone(doc), fork).objects.o1!.name)
      await reader.shutdown()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('a covered row REWRITTEN between the check and the statement is not deleted (exact-version delete)', async () => {
    const db = await database('rewritten')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const rewritten = (await storedRows(db, documentId)).find((row) => row.key.split('/')[1] === 'incremental')!.key
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({
        db: db.pool,
        writeDb: interceptingPool(db.pool, async () => {
          // Committed by another session before the statement takes its snapshot.
          await db.pool.query(`UPDATE automerge_storage SET arrival_seq = nextval('automerge_arrival_seq') WHERE key = $1`, [rewritten])
        }),
        durableHeadsMemo: memo,
      })
      const outcome = await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(outcome).toMatchObject({ outcome: 'compacted', rowsBefore: 4, removed: 3, kept: 1 })
      expect((await storedRows(db, documentId)).map((row) => row.key)).toContain(rewritten)
      expect(await expectMemoSound(db, memo, documentId)).toBeUndefined()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('a covered row whose BYTES change while key, arrival_seq and length stay is not deleted (md5 in the delete)', async () => {
    const db = await database('digest')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const target = (await storedRows(db, documentId)).find((row) => row.key.split('/')[1] === 'incremental')!.key
      const adapter = new PostgresStorageAdapter({
        db: db.pool,
        writeDb: interceptingPool(db.pool, async () => {
          // Same length, same sequence (a direct write, not through the adapter).
          await db.pool.query(`UPDATE automerge_storage
            SET data = set_byte(data, octet_length(data) - 1, 255 - get_byte(data, octet_length(data) - 1)) WHERE key = $1`, [target])
        }),
        durableHeadsMemo: new DurableHeadsMemo(),
      })
      const outcome = await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(outcome).toMatchObject({ outcome: 'compacted', removed: 3, kept: 1 })
      expect((await storedRows(db, documentId)).map((row) => row.key)).toContain(target)
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('its OWN snapshot changed in place (same key, sequence, length) is not taken as its own, and is kept', async () => {
    const db = await database('ownbytes')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 2)
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: new DurableHeadsMemo() })
      await adapter.compactToSnapshot(documentId, handle.doc()!)
      const ownKey = (await storedRows(db, documentId))[0]!.key
      // A direct write: the adapter's sequence is not minted.
      await db.pool.query(`UPDATE automerge_storage
        SET data = set_byte(data, octet_length(data) - 1, 255 - get_byte(data, octet_length(data) - 1)) WHERE key = $1`, [ownKey])
      handle.change((d) => { d.objects.o7!.name = 'after the edit in place' })
      await writer.flush()
      const outcome = await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(outcome).toMatchObject({ outcome: 'compacted', kept: 1 })
      expect((await storedRows(db, documentId)).map((row) => row.key)).toContain(ownKey)
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  /** The ONE snapshot row the compaction wrote, and the strict heads of its bytes alone. */
  async function writtenSnapshot(db: IsolatedSchemaDb, documentId: string, key: string) {
    const row = (await storedRows(db, documentId)).find((r) => r.key === key)!
    const heads = await durableHeadsDecoder.decode(documentId, [row.data])
    return { row, heads }
  }
  const isRead = (sql: string) => sql.includes('CASE WHEN key = $2')

  it('the handle changes DURING the read — key, bytes, own record and memo are all the state passed in', async () => {
    const db = await database('pinned')
    try {
      // No autosave during the test: the edit reaches storage only at the
      // explicit flush below.
      const { writer, handle, documentId } = await writtenShard(db, 3, 600_000)
      const passed = handle.doc()!
      const h0 = A.getHeads(passed)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({
        db: interceptingPool(db.pool, async () => {
          // The passed value becomes OUTDATED: its live wasm state moves on.
          handle.change((d) => { d.objects.o5!.name = 'during the read' })
        }, isRead),
        durableHeadsMemo: memo,
      })
      const outcome = await adapter.compactToSnapshot(documentId, passed)
      expect(outcome).toMatchObject({ outcome: 'compacted', kept: 0 })
      expect(A.getHeads(handle.doc()!)).not.toEqual(h0)
      const key = snapshotStorageKey(documentId, h0).join('/')
      const { row, heads } = await writtenSnapshot(db, documentId, key)
      // The key names the heads its bytes decode to, and those are H0.
      expect(snapshotStorageKey(documentId, heads).join('/')).toBe(key)
      expect([...heads].sort()).toEqual([...h0].sort())
      // The memo entry is that row alone (the Repo may have saved the edit
      // as a second row by now): it answers the strict heads of the row.
      expect([...memo.lookup(documentId, [row])!].sort()).toEqual([...heads].sort())
      // The own record names H0 too: a later edit (and its row) is not
      // taken as covered by it.
      await writer.flush()
      const second = await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(second).toMatchObject({ outcome: 'compacted', kept: 0 })
      const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
      const loaded = (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
      expect(loaded.doc()!.objects.o5!.name).toBe('during the read')
      await reader.shutdown()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('a row SAVED during the read with changes past the passed state is kept, nothing lost', async () => {
    const db = await database('pinnedsave')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const passed = handle.doc()!
      const h0 = A.getHeads(passed)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({
        db: interceptingPool(db.pool, async () => {
          handle.change((d) => { d.objects.o6!.name = 'saved during the read' })
          await writer.flush()
        }, isRead),
        durableHeadsMemo: memo,
      })
      const outcome = await adapter.compactToSnapshot(documentId, passed)
      // The new incremental is read, and NOT covered by the pinned state.
      expect(outcome).toMatchObject({ outcome: 'compacted', rowsBefore: 5, removed: 4, kept: 1 })
      const key = snapshotStorageKey(documentId, h0).join('/')
      const { heads } = await writtenSnapshot(db, documentId, key)
      expect([...heads].sort()).toEqual([...h0].sort())
      expect(await expectMemoSound(db, memo, documentId)).toBeUndefined()
      const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
      const loaded = (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
      expect(A.getHeads(loaded.doc()!)).toEqual(A.getHeads(handle.doc()!))
      expect(loaded.doc()!.objects.o6!.name).toBe('saved during the read')
      await reader.shutdown()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('crash atomicity: a statement that fails after the snapshot insert leaves exactly the old rows', async () => {
    const db = await database('atomic')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const before = await storedRows(db, documentId)
      await db.pool.query(`CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated crash inside the compaction statement'; END $$`)
      await db.pool.query(`CREATE TRIGGER refuse_delete BEFORE DELETE ON automerge_storage FOR EACH ROW EXECUTE FUNCTION refuse_delete()`)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      await expect(adapter.compactToSnapshot(documentId, handle.doc()!)).rejects.toThrow(/simulated crash/)
      const after = await storedRows(db, documentId)
      expect(after.map((row) => [row.key, row.arrivalSeq])).toEqual(before.map((row) => [row.key, row.arrivalSeq]))
      expect(memo.size).toBe(0)
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('fenced: a stale token refuses, changes nothing and remembers nothing; the owner compacts', async () => {
    const db = await database('fenced')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      await db.pool.query('INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)',
        [documentId, WORKSPACE.landscapeId, WORKSPACE.versionId])
      await db.pool.query(`INSERT INTO sync_workspace_ownership (landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at)
        VALUES ($1, $2, 'cell-2', 2, NOW() + INTERVAL '1 minute', NULL)`, [WORKSPACE.landscapeId, WORKSPACE.versionId])
      const before = await storedRows(db, documentId)
      const staleMemo = new DurableHeadsMemo()
      const stale = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: staleMemo, ownership: { fencingToken: () => '1' } })
      await expect(stale.compactToSnapshot(documentId, handle.doc()!)).rejects.toBeInstanceOf(StaleSyncCellWriteError)
      expect((await storedRows(db, documentId)).map((row) => row.arrivalSeq)).toEqual(before.map((row) => row.arrivalSeq))
      expect(staleMemo.size).toBe(0)
      const memo = new DurableHeadsMemo()
      const owner = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo, ownership: { fencingToken: () => '2' } })
      expect(await owner.compactToSnapshot(documentId, handle.doc()!)).toMatchObject({ outcome: 'compacted', removed: 4, kept: 0 })
      expect(await expectMemoSound(db, memo, documentId)).toEqual(A.getHeads(handle.doc()!))
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('the Repo keeps writing after a compaction it did not see: later saves, its own compaction, nothing lost', async () => {
    const db = await database('afterwards')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 3)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      await adapter.compactToSnapshot(documentId, handle.doc()!)
      // The writer's StorageSubsystem still lists the deleted rows. Enough
      // edits for its own size rule to compact (incrementals >= snapshot).
      for (let e = 0; e < 80; e += 1) {
        handle.change((d) => { d.objects[`o${e % 60}`]!.description = `rewritten ${e} ${'x'.repeat(40)}` })
        await writer.flush()
      }
      expect(await expectMemoSound(db, memo, documentId)).toBeUndefined()
      const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: null }), network: [], saveDebounceRate: 0 })
      const loaded = (await reader.find<Shard>(handle.url)) as DocHandle<Shard>
      expect(A.getHeads(loaded.doc()!)).toEqual(A.getHeads(handle.doc()!))
      expect(A.toJS(loaded.doc()!)).toEqual(A.toJS(handle.doc()!))
      // And a second compaction recognises its own snapshot row, if still there.
      const again = await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(again.outcome).toBe('compacted')
      expect((await storedRows(db, documentId)).length).toBe(1)
      expect(await expectMemoSound(db, memo, documentId)).toEqual(A.getHeads(handle.doc()!))
      await reader.shutdown()
      await writer.shutdown()
    } finally { await db.teardown() }
  })

  it('skips: one snapshot already, a missing dependency (nothing remembered), no rows', async () => {
    const db = await database('skips')
    try {
      const { writer, handle, documentId } = await writtenShard(db, 2)
      const memo = new DurableHeadsMemo()
      const adapter = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: memo })
      await adapter.compactToSnapshot(documentId, handle.doc()!)
      expect(await adapter.compactToSnapshot(documentId, handle.doc()!)).toMatchObject({ outcome: 'skipped', reason: 'already-compact' })
      // Mutant "remember whatever the document says": a document with a
      // queued change (missing dependency) is refused before any write.
      const base = handle.doc()!
      const step1 = A.change(A.clone(base), (d) => { d.objects.o2!.name = 'one' })
      const step2 = A.change(A.clone(step1), (d) => { d.objects.o2!.name = 'two' })
      const gapped = A.loadIncremental(A.clone(base), A.saveSince(step2, A.getHeads(step1)))
      expect(A.getMissingDeps(gapped, []).length).toBeGreaterThan(0)
      const fresh = new DurableHeadsMemo()
      const other = new PostgresStorageAdapter({ db: db.pool, durableHeadsMemo: fresh })
      expect(await other.compactToSnapshot(documentId, gapped)).toMatchObject({ outcome: 'skipped', reason: 'missing-deps' })
      expect(fresh.size).toBe(0)
      const neverStored = String(new Repo({ network: [] }).create({ x: 1 }).documentId)
      expect(await other.compactToSnapshot(neverStored, base)).toMatchObject({ outcome: 'skipped', reason: 'no-rows' })
      await writer.shutdown()
    } finally { await db.teardown() }
  })
})
