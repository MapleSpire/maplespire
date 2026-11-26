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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { compactOverlay } from './compaction.js'
import { declinedOverrideWrites, overlayClearScanStore } from './overlayClearRematerialize.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16k: the scan store the production compaction passes
 * (`workspaceCompaction.ts`, `overlayClearScanStore`), on PostgreSQL. The
 * table is created by `ensureReadModelSchema`; a row records where a
 * segment's scan stopped, per workspace and collection; the next pass reads
 * from there and finds the late edit that arrived after it — including on a
 * segment the meta no longer names as an overlay once its head rotated.
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ocr', versionId: 'v1' }
const OTHER: WorkspaceKey = { landscapeId: 'ls-ocr-other', versionId: 'v1' }

type Obj = { id: string; name: string }
type ObjShard = { objects: Record<string, Obj> }

let db: IsolatedSchemaDb

suite('overlay clear rematerialization on PostgreSQL (G4-16k)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'overlay_clear_rematerialize')
    await ensureReadModelSchema(db.pool)
    // Idempotent, as every boot runs it.
    await ensureReadModelSchema(db.pool)
  })
  afterAll(async () => { await db?.teardown() })

  it('records scans per workspace and collection, and replaces a row on the next save', async () => {
    const store = overlayClearScanStore(db.pool, WS)
    await store.save('object', [{ documentId: 'doc-a', heads: ['h1', 'h2'] }, { documentId: 'doc-b', heads: [] }])
    await store.save('connection', [{ documentId: 'doc-a', heads: ['c1'] }])
    await overlayClearScanStore(db.pool, OTHER).save('object', [{ documentId: 'doc-z', heads: ['z'] }])
    expect([...(await store.load('object'))]).toEqual([['doc-a', { heads: ['h1', 'h2'], lateSeen: {}, done: [] }]])
    expect([...(await store.load('connection'))]).toEqual([['doc-a', { heads: ['c1'], lateSeen: {}, done: [] }]])
    await store.save('object', [{ documentId: 'doc-a', heads: ['h3'] }])
    expect([...(await store.load('object'))]).toEqual([['doc-a', { heads: ['h3'], lateSeen: {}, done: [] }]])
    // A parked segment's handled changes round-trip, and go with the next save.
    await store.save('object', [{ documentId: 'doc-a', heads: ['h3'], done: ['c1', 'c2'] }])
    expect((await store.load('object')).get('doc-a')?.done).toEqual(['c1', 'c2'])
    await store.save('object', [{ documentId: 'doc-a', heads: ['h4'] }])
    expect((await store.load('object')).get('doc-a')?.done).toEqual([])
  })

  it('the grace clock round-trips, rows come back least recently saved first, a first sighting never moves a row, a gone segment is purged', async () => {
    const key: WorkspaceKey = { landscapeId: 'ls-ocr-p10', versionId: 'v1' }
    const store = overlayClearScanStore(db.pool, key)
    await store.save('object', [{ documentId: 'doc-old', heads: ['o1'], lateSeen: { c1: 1_900_000_000_000 } }])
    await store.save('object', [{ documentId: 'doc-new', heads: ['n1'] }])
    expect([...(await store.load('object'))]).toEqual([
      ['doc-old', { heads: ['o1'], lateSeen: { c1: 1_900_000_000_000 }, done: [] }],
      ['doc-new', { heads: ['n1'], lateSeen: {}, done: [] }],
    ])
    // Saved again: it goes to the back.
    await store.save('object', [{ documentId: 'doc-old', heads: ['o2'] }])
    expect([...(await store.load('object')).keys()]).toEqual(['doc-new', 'doc-old'])
    // A first sighting (`onlyNew`) inserts, never replaces.
    await store.save('object', [{ documentId: 'doc-new', heads: ['moved'] }, { documentId: 'doc-first', heads: ['f1'] }], { onlyNew: true })
    const rows = await store.load('object')
    expect(rows.get('doc-new')?.heads).toEqual(['n1'])
    expect(rows.get('doc-first')?.heads).toEqual(['f1'])
    await store.purge('object', ['doc-old', 'doc-first'])
    expect([...(await store.load('object')).keys()]).toEqual(['doc-new'])
    // And it goes with its workspace.
    const { deleteEpochUserRowsOfWorkspace } = await import('./modelEpochQuarantine.js')
    const deleted = await deleteEpochUserRowsOfWorkspace(db.pool, key.landscapeId, key.versionId)
    expect(deleted.read_model_overlay_clear_scans).toBe(1)
    expect((await store.load('object')).size).toBe(0)
  })

  it('the declined writes are the DISMISSED override rows of the entity, path relative to it, with their value', async () => {
    const insert = (id: string, entityId: string, path: unknown[], value: unknown, state: string, kind = 'object') => db.pool.query(
      `INSERT INTO read_model_model_epoch_overrides
         (id, landscape_id, version_id, journal_id, source_doc, target_doc, entity_kind, entity_id, path, reason,
          late_value, current_value_at_forward, current_heads_at_forward, late_actors, state)
       VALUES ($1, $2, $3, 'j', 's', 't', $4, $5, $6::jsonb, 'leaf', $7::jsonb, 'null'::jsonb, '{}', '{}', $8)`,
      [id, WS.landscapeId, WS.versionId, kind, entityId, JSON.stringify(path), JSON.stringify(value), state])
    await insert('r1', 'o1', ['objects', 'o1', 'name'], 'hers', 'dismissed')
    await insert('r2', 'o1', ['objects', 'o1', 'description'], 'pending one', 'pending')
    await insert('r3', 'o1', ['objects', 'o1', 'properties', 'k'], 'v', 'reapplied')
    await insert('r4', 'o2', ['objects', 'o2', 'name'], 'other', 'dismissed')
    await insert('r5', 'o1', ['connections', 'o1', 'label'], 'conn', 'dismissed', 'connection')
    const got = await declinedOverrideWrites(db.pool, WS, 'object', ['o1'])
    // A PENDING row holds its field back too.
    expect(got.get('o1')?.slice().sort((a, b) => String(a.path[0]).localeCompare(String(b.path[0])))).toEqual([
      { path: ['description'], value: 'pending one', pending: true },
      { path: ['name'], value: 'hers' },
    ])
    expect([...got.keys()]).toEqual(['o1'])
    expect([...(await declinedOverrideWrites(db.pool, OTHER, 'object', ['o1']))]).toEqual([])
  })

  it('a pass with the store finds the late edit the clear erased, on a segment only the store still names', async () => {
    const repo = new Repo({})
    const base = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'A' } } })
    const overlay = repo.create<ObjShard>({ objects: { o1: { id: 'o1', name: 'v1' } } })
    const meta = repo.create({ objectShardUrls: [base.url, overlay.url], connectionShardUrls: [] as string[], editsObjectShardUrl: overlay.url })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, overlay, meta, root].map((h) => h.whenReady()))
    const marie = A.clone(overlay.doc() as A.Doc<ObjShard>)
    const key: WorkspaceKey = { landscapeId: 'ls-ocr-pass', versionId: 'v1' }
    const clearScans = overlayClearScanStore(db.pool, key)

    await compactOverlay(repo, root.url, { mode: 'apply', clearScans })
    const { rows } = await db.pool.query<{ document_id: string }>(
      `SELECT document_id FROM read_model_overlay_clear_scans WHERE landscape_id = $1 AND collection = 'object'`, [key.landscapeId])
    expect(rows.map((row) => row.document_id)).toContain(String(overlay.documentId))

    const edited = A.change(marie, (d) => { d.objects.o1.name = 'hers' })
    overlay.update((doc) => A.merge(doc, edited))
    const second = await compactOverlay(repo, root.url, { mode: 'apply', clearScans })
    expect(second.objectsRematerialized).toBe(1)
    const homes = (meta.doc() as { objectShardUrls: string[] }).objectShardUrls
      .map((url) => Object.values(repo.handles).find((h) => h.url === url) as DocHandle<ObjShard> | undefined)
      .map((h) => h?.doc()?.objects?.o1?.name).filter(Boolean)
    expect(homes.at(-1)).toBe('hers')
  })
})
