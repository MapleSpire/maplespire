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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { listLateWriteSources, modelEpochGcRoots, sqlEpochRowStore } from './modelEpochStore.js'
import { EpochRollContended } from './modelEpochRoll.js'

/**
 * G4-16f epochs — the SQL predicates of `modelEpochStore.ts` against a real
 * PostgreSQL (`gc.test.ts` drives GC through a fake that answers what these
 * queries select; this file pins what they DO select):
 *
 *  - the schema's constraints: one roll in flight, one published epoch, a
 *    `pinned` row names its pin, a non-live row is superseded;
 *  - GC roots: marked epoch states only, `live`/`pinned` documents only,
 *    retained metas = superseded metas only, a deleted version pins nothing;
 *  - late-write sources: superseded AND live, never a carried document.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS = { landscapeId: 'ls-epoch', versionId: 'v-epoch' }
let db: IsolatedSchemaDb

const epoch = (no: number, kind: string, state: string, metaUrl: string | null, slots: unknown[] = [], workspace = WS) =>
  db.pool.query(
    `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, slots)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [workspace.landscapeId, workspace.versionId, no, kind, state, kind === 'legacy' ? null : no - 1, metaUrl, JSON.stringify(slots)],
  )
const doc = (id: string, role: string, created: number, superseded: number | null, state = 'live', pinnedBy: string | null = null, workspace = WS) =>
  db.pool.query(
    `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch, state, pinned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, workspace.landscapeId, workspace.versionId, created, role, superseded, state, pinnedBy],
  )

suite('modelEpochStore (G4-16f)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_store')
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await db.pool.query(`CREATE TABLE versions (
      id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, root_url TEXT NOT NULL)`)
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`INSERT INTO landscapes (id, name) VALUES ('ls-epoch', 'e'), ('ls-gone', 'g')`)
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('v-epoch', 'ls-epoch', 'v', 'automerge:root')`)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('DELETE FROM read_model_model_epochs')
    await db.pool.query('DELETE FROM read_model_model_epoch_docs')
  })

  it('ensureReadModelSchema is idempotent with the epoch tables', async () => {
    await ensureReadModelSchema(db.pool)
    await ensureReadModelSchema(db.pool)
  })

  it('at most one roll in flight, exactly one published epoch per workspace', async () => {
    await epoch(0, 'legacy', 'published', 'automerge:m0')
    await epoch(1, 'full', 'preparing', null)
    await expect(epoch(2, 'full', 'prepared', null)).rejects.toThrow(/idx_read_model_model_epochs_in_flight/)
    await expect(epoch(2, 'full', 'published', 'automerge:m2')).rejects.toThrow(/idx_read_model_model_epochs_published/)
    // A second workspace is independent.
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('v-other', 'ls-epoch', 'o', 'automerge:r2')`)
    await epoch(0, 'legacy', 'published', 'automerge:o0', [], { landscapeId: 'ls-epoch', versionId: 'v-other' })
  })

  it('constraints: a published row names its meta, a pinned doc names its pin, a non-live doc is superseded', async () => {
    await expect(epoch(0, 'legacy', 'published', null)).rejects.toThrow(/check/i)
    // A non-legacy epoch must name its predecessor, and only a legacy one may not.
    await expect(db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state)
       VALUES ('ls-epoch', 'v-epoch', 3, 'full', 'preparing')`)).rejects.toThrow(/check/i)
    await expect(db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch)
       VALUES ('ls-epoch', 'v-epoch', 3, 'full', 'preparing', 3)`)).rejects.toThrow(/check/i)
    await expect(doc('d1', 'base', 0, 1, 'pinned', null)).rejects.toThrow(/check/i)
    await expect(doc('d2', 'base', 0, null, 'retiring')).rejects.toThrow(/check/i)
    await expect(doc('d3', 'legacy', 0, null)).rejects.toThrow(/check/i) // no `legacy` role
    await expect(doc('d4', 'base', 2, 1)).rejects.toThrow(/check/i) // superseded before created
  })

  it('GC roots: only marked epoch states, only live/pinned docs, retained metas = superseded metas', async () => {
    await epoch(0, 'legacy', 'retained', 'automerge:m0', [{ slot: 0, url: 'automerge:b0' }])
    await epoch(1, 'meta', 'published', 'automerge:m1')
    await epoch(2, 'full', 'abandoned', 'automerge:m2x', [{ slot: 0, url: 'automerge:b2x' }])
    await doc('m0', 'meta', 0, 1)
    await doc('b0', 'base', 0, null) // CARRIED by the meta-only epoch 1
    await doc('m1', 'meta', 1, null)
    await doc('r0', 'base', 0, 1, 'retiring')
    await doc('p0', 'base', 0, 1, 'pinned', 'landscape_versions:snap1')
    await doc('x0', 'base', 0, 1, 'retired')
    const roots = await modelEpochGcRoots(db.pool)
    expect(new Set(roots.urls)).toEqual(new Set([
      'automerge:m0', 'automerge:b0', 'automerge:m1', // rows retained + published
      'automerge:m0', 'automerge:b0', 'automerge:m1', 'automerge:p0', // live + pinned docs
    ]))
    expect(roots.urls).not.toContain('automerge:m2x') // abandoned row
    expect(roots.urls).not.toContain('automerge:r0')
    expect(roots.urls).not.toContain('automerge:x0')
    expect(roots.retainedMetaUrls).toEqual(['automerge:m0'])
  })

  it('GC roots: a deleted version pins nothing', async () => {
    const gone = { landscapeId: 'ls-gone', versionId: 'v-gone' }
    await epoch(0, 'legacy', 'retained', 'automerge:g0', [], gone)
    await doc('g0', 'meta', 0, 1, 'live', null, gone)
    const roots = await modelEpochGcRoots(db.pool)
    expect(roots.urls).toEqual([])
    expect(roots.retainedMetaUrls).toEqual([])
  })

  it('sqlEpochRowStore: the roll\'s operations, in the order the roll issues them', async () => {
    const rows = sqlEpochRowStore((fn) => fn(db.pool), WS)
    expect(await rows.published()).toBeNull()
    expect(await rows.maxEpochNo()).toBe(-1)
    await rows.recordLegacy('automerge:meta0', ['automerge:base0a', 'automerge:base0b'])
    await rows.recordLegacy('automerge:meta0', ['automerge:base0a', 'automerge:base0b']) // idempotent
    const legacy = await rows.published()
    expect(legacy).toMatchObject({ epochNo: 0, kind: 'legacy', metaUrl: 'automerge:meta0' })
    expect(legacy!.slots).toEqual([{ slot: 0, url: 'automerge:base0a' }, { slot: 1, url: 'automerge:base0b' }])
    await rows.insertPreparing({ epochNo: 1, kind: 'full', predecessor: 0, cutHeads: { 'automerge:meta0': ['h0'] }, instanceId: 'i' })
    await expect(rows.insertPreparing({ epochNo: 2, kind: 'full', predecessor: 0, cutHeads: {}, instanceId: 'j' }))
      .rejects.toThrow(EpochRollContended)
    await rows.recordSlots(1, [{ slot: 0, url: 'automerge:base1a' }])
    await rows.recordMeta(1, 'automerge:meta1')
    expect(await rows.setState(1, ['preparing'], 'prepared')).toBe(true)
    expect(await rows.setState(1, ['preparing'], 'prepared')).toBe(false) // compare-and-set
    expect(await rows.setState(1, ['prepared'], 'repointing')).toBe(true)
    expect((await rows.inFlight())!.state).toBe('repointing')
    // `repointing` is still in flight: a second roll cannot start.
    await expect(rows.insertPreparing({ epochNo: 2, kind: 'full', predecessor: 0, cutHeads: {}, instanceId: 'k' }))
      .rejects.toThrow(EpochRollContended)
    const publish = {
      epochNo: 1, predecessor: 0,
      created: [{ url: 'automerge:meta1', role: 'meta' as const, slot: null }, { url: 'automerge:base1a', role: 'base' as const, slot: 0 }],
      superseded: [{ url: 'automerge:meta0', cutHeads: ['h0'] }, { url: 'automerge:base0a', cutHeads: ['h1'] }],
    }
    await rows.publish(publish)
    await rows.publish(publish) // idempotent
    expect((await rows.published())!.epochNo).toBe(1)
    expect(await rows.inFlight()).toBeNull()
    expect(await rows.maxEpochNo()).toBe(1)
    await rows.recordServerChangeHashes(1, ['hashA'])
    await rows.recordServerChangeHashes(1, ['hashA', 'hashB'])
    const { rows: hashes } = await db.pool.query<{ server_change_hashes: string[] }>(
      `SELECT server_change_hashes FROM read_model_model_epochs WHERE epoch_no = 1`)
    expect([...hashes[0]!.server_change_hashes].sort()).toEqual(['hashA', 'hashB'])
    const sources = await listLateWriteSources(db.pool, WS)
    // Ordered by superseded epoch, then document id.
    expect(sources.map((s) => [s.documentId, s.forwardCursor])).toEqual([['base0a', ['h1']], ['meta0', ['h0']]])
    // base0b was not in `superseded` (the roll decides what an epoch no longer
    // lists): it stays current, and is no source.
    const { rows: retained } = await db.pool.query<{ state: string }>(`SELECT state FROM read_model_model_epochs WHERE epoch_no = 0`)
    expect(retained[0]!.state).toBe('retained')
    // A document is superseded ONCE: a later epoch naming it again leaves its
    // superseded epoch and its cursor as the first one set them.
    await rows.insertPreparing({ epochNo: 2, kind: 'meta', predecessor: 1, cutHeads: {}, instanceId: 'i' })
    await rows.recordMeta(2, 'automerge:meta2')
    await rows.setState(2, ['preparing'], 'repointing')
    await rows.publish({ epochNo: 2, predecessor: 1, created: [{ url: 'automerge:meta2', role: 'meta', slot: null }],
      superseded: [{ url: 'automerge:base0a', cutHeads: ['later'] }, { url: 'automerge:meta1', cutHeads: ['m1'] }] })
    const { rows: once } = await db.pool.query<{ superseded_epoch: number; forward_cursor: string[] }>(
      `SELECT superseded_epoch, forward_cursor FROM read_model_model_epoch_docs WHERE document_id = 'base0a'`)
    expect(once[0]).toEqual({ superseded_epoch: 1, forward_cursor: ['h1'] })
    expect((await rows.published())!.epochNo).toBe(2)
  })

  it('adoptRoot — one transaction, the stuck and published rows retained, the adopted epoch published, its documents superseded or carried', async () => {
    const store = sqlEpochRowStore((fn) => fn(db.pool), WS)
    await epoch(0, 'legacy', 'published', 'automerge:m0')
    await doc('m0', 'meta', 0, null)
    await doc('b0', 'base', 0, null)
    await epoch(1, 'full', 'repointing', 'automerge:m1', [{ slot: 0, url: 'automerge:b1' }])
    const args = {
      stuck: 1, predecessor: 0, epochNo: 2, metaUrl: 'automerge:x', cutHeads: { 'automerge:x': ['hx'] },
      docs: [
        { url: 'automerge:m0', role: 'meta' as const, slot: null, createdEpoch: 0, supersededCursor: ['cut-m0'] },
        { url: 'automerge:m1', role: 'meta' as const, slot: null, createdEpoch: 1, supersededCursor: ['birth-m1'] },
        { url: 'automerge:b1', role: 'base' as const, slot: 0, createdEpoch: 1, supersededCursor: ['birth-b1'] },
        { url: 'automerge:x', role: 'meta' as const, slot: null, createdEpoch: 2, supersededCursor: null },
      ],
    }
    await store.adoptRoot(args)
    const { rows: epochs } = await db.pool.query<{ epoch_no: number; state: string; kind: string; resolution: string | null; predecessor_epoch: number | null }>(
      `SELECT epoch_no, state, kind, resolution, predecessor_epoch FROM read_model_model_epochs WHERE landscape_id = $1 ORDER BY epoch_no`, [WS.landscapeId])
    expect(epochs).toEqual([
      { epoch_no: 0, state: 'retained', kind: 'legacy', resolution: null, predecessor_epoch: null },
      { epoch_no: 1, state: 'retained', kind: 'full', resolution: 'adopt-root', predecessor_epoch: 0 },
      { epoch_no: 2, state: 'published', kind: 'meta', resolution: 'adopt-root', predecessor_epoch: 1 },
    ])
    const { rows: docs } = await db.pool.query<{ document_id: string; created_epoch: number; superseded_epoch: number | null; forward_cursor: string[] | null }>(
      `SELECT document_id, created_epoch, superseded_epoch, forward_cursor FROM read_model_model_epoch_docs ORDER BY document_id`)
    expect(docs).toEqual([
      { document_id: 'b0', created_epoch: 0, superseded_epoch: null, forward_cursor: null }, // carried
      { document_id: 'b1', created_epoch: 1, superseded_epoch: 2, forward_cursor: ['birth-b1'] },
      { document_id: 'm0', created_epoch: 0, superseded_epoch: 2, forward_cursor: ['cut-m0'] },
      { document_id: 'm1', created_epoch: 1, superseded_epoch: 2, forward_cursor: ['birth-m1'] },
      { document_id: 'x', created_epoch: 2, superseded_epoch: null, forward_cursor: null },
    ])
    // Not stuck any more: a second adoption refuses, whole — of `x` (now an
    // epoch document) and of any other meta (no row repointing).
    await expect(store.adoptRoot({ ...args, epochNo: 3 })).rejects.toThrow(/already an epoch document/)
    await expect(store.adoptRoot({ ...args, epochNo: 3, metaUrl: 'automerge:y', docs: [] })).rejects.toThrow(/no longer repointing/)
    await store.recordResolution(2, 'repoint')
  })

  it('adoptRoot REFUSES a meta that already has an epoch-document row — nothing written', async () => {
    // The refusal comes BEFORE the first write: nothing to roll back even unfenced.
    const store = sqlEpochRowStore((fn) => fn(db.pool), WS)
    await epoch(0, 'legacy', 'published', 'automerge:m0')
    await doc('m0', 'meta', 0, null)
    await doc('old', 'meta', 0, 1) // an older epoch meta, superseded
    await epoch(1, 'full', 'repointing', 'automerge:m1')
    expect(await store.isEpochDocument('automerge:old')).toBe(true)
    expect(await store.isEpochDocument('automerge:never')).toBe(false)
    await expect(store.adoptRoot({
      stuck: 1, predecessor: 0, epochNo: 2, metaUrl: 'automerge:old', cutHeads: { 'automerge:old': ['h'] },
      docs: [{ url: 'automerge:old', role: 'meta', slot: null, createdEpoch: 2, supersededCursor: null }],
    })).rejects.toThrow(/already an epoch document/)
    const { rows } = await db.pool.query<{ epoch_no: number; state: string }>(
      `SELECT epoch_no, state FROM read_model_model_epochs WHERE landscape_id = $1 ORDER BY epoch_no`, [WS.landscapeId])
    expect(rows).toEqual([{ epoch_no: 0, state: 'published' }, { epoch_no: 1, state: 'repointing' }])
    const { rows: old } = await db.pool.query<{ superseded_epoch: number | null }>(
      `SELECT superseded_epoch FROM read_model_model_epoch_docs WHERE document_id = 'old'`)
    expect(old[0]!.superseded_epoch).toBe(1)
  })

  it('late-write sources: superseded AND live; a carried document never is one', async () => {
    await doc('m0', 'meta', 0, 1)
    await doc('b0', 'base', 0, null) // carried
    await doc('m1', 'meta', 1, null) // current
    await doc('r0', 'base', 0, 1, 'retiring')
    await doc('p0', 'base', 0, 1, 'pinned', 'journal:j1')
    await doc('a1', 'adopted', 1, 2)
    const sources = await listLateWriteSources(db.pool, WS)
    expect(sources.map((s) => s.documentId)).toEqual(['m0', 'a1'])
  })
})
