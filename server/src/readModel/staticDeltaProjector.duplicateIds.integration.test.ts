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

/**
 * G4-16f C7: the STATIC projector with a duplicate id — one
 * inner id under two map keys of one overlay segment (or of ModelMeta's
 * groups). `updateStaticOverlaySegment` keys its effective view by MAP KEY,
 * so both copies reached `upsertObjects` / `upsertConnections` in one
 * ON CONFLICT DO UPDATE and raised 21000 on every delta, the first-ready
 * full pass included; the static ModelMeta pass did the same through
 * `upsertGroups`. The fix keeps the last occurrence (`lastOccurrenceById`)
 * and counts the drop as the ordinary live passes do.
 *
 * WHICH COPY. The twin is written LAST under a key that sorts FIRST
 * ('aa-twin'), and every document is handed to the projector the way a
 * server meets a stored one: LOADED from its bytes (`repo.import`). An
 * Automerge map materialised by a load lists its keys in KEY order, so the
 * last copy in `Object.values` order is the ORIGINAL — a "most recently
 * written copy" rule would serve the twin and fail here. (A map built up in
 * one process lists keys in the order that process applied them instead,
 * which is write order for local writes: see `liveDuplicateIds`'s header.)
 *
 * ROW LEVEL. A delta is per map key; a row is per inner id.
 * Deleting key `o1` of a twin pair must not delete row o1 while the twin
 * still renders, and editing only the losing copy must not make the row
 * follow that edit. Every inner id a delta touches is re-derived from all
 * the segments (`resolveStaticOverlayInnerIds`): the arms below delete one
 * key, edit the loser, delete both keys, and put the twin in another
 * segment, first-ready pass included.
 *
 * Real Automerge repo, real StaticDeltaProjector dispatch (`project()`),
 * real PostgreSQL in an isolated schema; skips without TEST_DATABASE_URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { liveDuplicateIdDropCount, verifyWorkspaceIntegrity } from './projectionIntegrity.js'
import { digestOfIds } from './contentDigest.js'
import { roConnection, roGroup, roObject } from './queries.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-static-dup', versionId: 'v1' }

type Named = { id: string; name?: string; label?: string }
/** The copy the last-wins rule keeps: the last in `Object.values` order. */
const lastCopy = (map: Record<string, Named>, id: string): Named =>
  Object.values(map).filter((entity) => entity.id === id).at(-1)!

describe.skipIf(!CONNECTION)('static projector with a duplicate id (Automerge → Postgres)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'static_duplicate_ids')
    await ensureReadModelSchema(database.pool)
    // The admission tables' minimal shape, as in
    // `staticDeltaProjector.registryShard.integration.test.ts`.
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    repo = new Repo({ network: [] })
    projector = new StaticDeltaProjector(repo, database.pool)
    for (const table of ['ro_objects', 'ro_connections', 'ro_groups', 'ro_group_objects', 'read_model_static_documents', 'read_model_static_document_queue', 'ro_workspace_stats']) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    }
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  /** `initial`, then `twin` written in a LATER change, saved and loaded back
   * into the repo: the document as a server reads it from storage. */
  function loadedWithTwin<T>(initial: T, twin: (doc: T) => void): DocHandle<T> {
    const written = A.change(A.from(initial as Record<string, unknown>) as A.Doc<T>, twin)
    return repo.import<T>(A.save(written))
  }

  async function project(handle: DocHandle<unknown>, kind: string, through = projector): Promise<void> {
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: handle.documentId, kind: kind as 'object-overlay' }])
    const internal = through as unknown as {
      project(descriptor: Record<string, unknown>, handle: DocHandle<unknown>): Promise<void>
    }
    await internal.project({ ...WS, documentId: handle.documentId, kind, entityId: null, orgId: null }, handle)
  }

  /** `project`, returning the `duplicate id(s)` warn lines it logged —
   * captured INSIDE the try: `mockRestore()` clears `mock.calls`. */
  async function projectLogged(handle: DocHandle<unknown>, kind: string, through = projector): Promise<string[]> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await project(handle, kind, through)
      return warn.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('duplicate id(s)'))
    } finally {
      warn.mockRestore()
    }
  }

  /** The line `noteLiveDuplicateIds` writes for one dropped `entity` copy of
   * `id`, from the overlay `handle`, under `source`. */
  const dropLine = (source: string, handle: DocHandle<unknown>, entity: string, id: string) =>
    `[read-model] ${source} automerge:${handle.documentId} for ${WS.landscapeId}/${WS.versionId} holds 1 `
    + `duplicate id(s); the last occurrence was projected: ${source}/duplicate-id=1 [${entity} "${id}"]`

  /** The state a ModelMeta pass leaves for an object chain [older, newer]
   * with no current write head named (so neither segment forwards): both
   * listed, neither materialised. Each segment's own projection then fills
   * it, and the second to arrive is the first-ready pass. */
  function listObjectSegments(documentIds: string[]): void {
    const internal = projector as unknown as { overlayState: Map<string, unknown> }
    internal.overlayState.set(`${WS.landscapeId}\u0000${WS.versionId}`, {
      objectDocumentIds: documentIds,
      connectionDocumentIds: [],
      deletedObjectIds: new Set(),
      deletedDiagramIds: new Set(),
      deletedConnectionIds: new Set(),
      objectSegments: new Map(),
      connectionSegments: new Map(),
      effectiveObjects: new Map(),
      effectiveConnections: new Map(),
    })
  }

  type ObjectHead = { objects: Record<string, Named>; writeHeadVersion: number; writeBatchIds: string[] }
  /** One segment, `o1` and its twin `aa-twin` (written last, sorting first)
   * and `o2`, loaded from bytes: keys ['aa-twin', 'o1', 'o2'], so the copy
   * the rule serves is o1's ('ORIGINAL'). */
  function twinPairHead(): DocHandle<ObjectHead> {
    const head = loadedWithTwin<ObjectHead>(
      { objects: { o1: { id: 'o1', name: 'ORIGINAL' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] },
      (doc) => { doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' } },
    )
    // CONTROL: the pair is there, in key order.
    expect(Object.keys(head.doc()!.objects)).toEqual(['aa-twin', 'o1', 'o2'])
    return head
  }

  const rowCount = async (table: string) => Number((await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId],
  )).rows[0].n)

  it('an object overlay: the first-ready full pass and a later delta succeed, the last copy wins, the drop is counted', async () => {
    type Head = { objects: Record<string, Named>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = loadedWithTwin<Head>(
      { objects: { o1: { id: 'o1', name: 'ORIGINAL' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] },
      (doc) => { doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' } },
    )
    const objects = head.doc()!.objects
    // CONTROL: the pair is there, and the loaded map lists keys in key order,
    // so key order and write order name different copies.
    expect(Object.keys(objects)).toEqual(['aa-twin', 'o1', 'o2'])
    expect(lastCopy(objects, 'o1').name).toBe('ORIGINAL')

    const before = liveDuplicateIdDropCount()
    // The source label, exactly: an object overlay's drop is an
    // `object-shard` one, in the line and in its summary.
    expect(await projectLogged(head, 'object-overlay')).toEqual([dropLine('object-shard', head, 'object', 'o1')])
    expect(liveDuplicateIdDropCount() - before, 'first-ready pass').toBe(1)
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('ORIGINAL')
    expect(await rowCount('ro_objects')).toBe(2)

    // A later delta touching both copies (no key added, so the order holds).
    head.change((doc) => { doc.objects.o1.name = 'ORIGINAL 2'; doc.objects['aa-twin'].name = 'TWIN 2' })
    expect(Object.keys(head.doc()!.objects)).toEqual(['aa-twin', 'o1', 'o2'])
    const middle = liveDuplicateIdDropCount()
    await project(head, 'object-overlay')
    expect(liveDuplicateIdDropCount() - middle, 'delta').toBe(1)
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('ORIGINAL 2')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('a connection overlay: the first-ready full pass succeeds, the last copy wins, the drop is counted', async () => {
    type Head = { connections: Record<string, Named & { fromId: string; toId: string }>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = loadedWithTwin<Head>(
      { connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'ORIGINAL' } }, writeHeadVersion: 1, writeBatchIds: [] },
      (doc) => { doc.connections['aa-twin'] = { id: 'c1', fromId: 'o1', toId: 'o2', label: 'TWIN' } },
    )
    const connections = head.doc()!.connections
    expect(Object.keys(connections)).toEqual(['aa-twin', 'c1'])
    expect(lastCopy(connections, 'c1').label).toBe('ORIGINAL')

    const before = liveDuplicateIdDropCount()
    // `connection-shard`, not the object branch's label.
    expect(await projectLogged(head, 'connection-overlay')).toEqual([dropLine('connection-shard', head, 'connection', 'c1')])
    expect(liveDuplicateIdDropCount() - before).toBe(1)
    expect((await roConnection(database.pool, WS, 'c1'))?.label).toBe('ORIGINAL')
    expect(await rowCount('ro_connections')).toBe(1)
  }, 30_000)

  it('a ModelMeta pass with a duplicate group: succeeds, the last copy wins, the drop is counted', async () => {
    type Meta = { groups: Record<string, Named & { objectIds: string[] }>; deletedDiagramIds: string[] }
    const meta = loadedWithTwin<Meta>(
      { groups: { g1: { id: 'g1', name: 'ORIGINAL', objectIds: [] } }, deletedDiagramIds: [] },
      (doc) => { doc.groups['aa-twin'] = { id: 'g1', name: 'TWIN', objectIds: [] } },
    )
    const groups = meta.doc()!.groups
    expect(Object.keys(groups)).toEqual(['aa-twin', 'g1'])
    expect(lastCopy(groups, 'g1').name).toBe('ORIGINAL')

    // A ModelMeta pass publishes only a revision the queue says is not yet
    // projected (`metaSourceAlreadyProjected`); in production a storage
    // write enqueues it. Without this row the pass short-circuits and
    // projects nothing at all.
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision)
       VALUES ($1, $2, $3, 1)`,
      [WS.landscapeId, WS.versionId, meta.documentId],
    )
    const before = liveDuplicateIdDropCount()
    expect(await projectLogged(meta, 'model-meta')).toEqual([dropLine('model-meta', meta, 'group', 'g1')])
    expect(liveDuplicateIdDropCount() - before).toBe(1)
    expect((await roGroup(database.pool, WS, 'g1'))?.name).toBe('ORIGINAL')
    expect(await rowCount('ro_groups')).toBe(1)
  }, 30_000)

  it('A: deleting one key of a twin pair keeps the row, with the surviving twin\'s data', async () => {
    const head = twinPairHead()
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name, 'control: the rule served o1\'s copy').toBe('ORIGINAL')

    // The client deletes by key (`delete objects[id]`): the twin stays in
    // the document and still renders.
    head.change((doc) => { delete doc.objects.o1 })
    expect(Object.values(head.doc()!.objects).filter((object) => object.id === 'o1').map((object) => object.name))
      .toEqual(['TWIN'])
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('TWIN')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('A, one change: the twin edited and the other key deleted together keeps the row (no upsert-then-delete)', async () => {
    const head = twinPairHead()
    await project(head, 'object-overlay')
    head.change((doc) => { doc.objects['aa-twin'].name = 'TWIN 2'; delete doc.objects.o1 })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('TWIN 2')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('B: editing only the LOSING copy leaves the winner served', async () => {
    const head = twinPairHead()
    await project(head, 'object-overlay')
    head.change((doc) => { doc.objects['aa-twin'].name = 'TWIN 2' })
    // CONTROL: the edit added no key, so the winner is still o1's copy.
    expect(Object.keys(head.doc()!.objects)).toEqual(['aa-twin', 'o1', 'o2'])
    const before = liveDuplicateIdDropCount()
    expect(await projectLogged(head, 'object-overlay')).toEqual([dropLine('object-shard', head, 'object', 'o1')])
    expect(liveDuplicateIdDropCount() - before).toBe(1)
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('ORIGINAL')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('deleting BOTH keys deletes the row, and only then', async () => {
    const head = twinPairHead()
    await project(head, 'object-overlay')
    head.change((doc) => { delete doc.objects['aa-twin'] })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name, 'one key left').toBe('ORIGINAL')
    expect(await rowCount('ro_objects')).toBe(2)
    head.change((doc) => { delete doc.objects.o1 })
    await project(head, 'object-overlay')
    expect(await roObject(database.pool, WS, 'o1')).toBeUndefined()
    expect(await rowCount('ro_objects')).toBe(1)
  }, 30_000)

  it('a twin CREATED after the first pass takes the row when the rule says so, and leaving it restores the original', async () => {
    const head = repo.create<ObjectHead>({ objects: { o1: { id: 'o1', name: 'ORIGINAL' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name, 'control').toBe('ORIGINAL')
    // In-session, the new key is listed LAST (write order), so it is the
    // last occurrence here.
    head.change((doc) => { doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' } })
    expect(Object.keys(head.doc()!.objects)).toEqual(['o1', 'o2', 'aa-twin'])
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('TWIN')
    head.change((doc) => { delete doc.objects['aa-twin'] })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('ORIGINAL')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('a connection twin: deleting one key keeps the row with the twin\'s data', async () => {
    type Head = { connections: Record<string, Named & { fromId: string; toId: string }>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = loadedWithTwin<Head>(
      { connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'ORIGINAL' } }, writeHeadVersion: 1, writeBatchIds: [] },
      (doc) => { doc.connections['aa-twin'] = { id: 'c1', fromId: 'o1', toId: 'o2', label: 'TWIN' } },
    )
    await project(head, 'connection-overlay')
    expect((await roConnection(database.pool, WS, 'c1'))?.label, 'control').toBe('ORIGINAL')
    head.change((doc) => { delete doc.connections.c1 })
    await project(head, 'connection-overlay')
    expect((await roConnection(database.pool, WS, 'c1'))?.label).toBe('TWIN')
    expect(await rowCount('ro_connections')).toBe(1)
  }, 30_000)

  it('a CROSS-SEGMENT twin, first-ready with the newer segment arriving first, then each copy edited and removed', async () => {
    // [older, newer]: o1 in the older segment, its twin under 'aa-twin' in
    // the newer. First appearance across the ordered segments lists o1 then
    // aa-twin, so the rule serves the TWIN — whatever order they arrive in.
    const older = repo.create<ObjectHead>({ objects: { o1: { id: 'o1', name: 'ORIGINAL' } }, writeHeadVersion: 1, writeBatchIds: [] })
    const newer = repo.create<ObjectHead>({ objects: { 'aa-twin': { id: 'o1', name: 'TWIN' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] })
    listObjectSegments([older.documentId, newer.documentId])

    await project(newer, 'object-overlay')
    expect(await rowCount('ro_objects'), 'control: one segment is not ready').toBe(0)
    const before = liveDuplicateIdDropCount()
    expect(await projectLogged(older, 'object-overlay')).toEqual([dropLine('object-shard', older, 'object', 'o1')])
    expect(liveDuplicateIdDropCount() - before, 'first-ready pass').toBe(1)
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('TWIN')
    expect(await rowCount('ro_objects')).toBe(2)

    // B across segments: the losing copy edited, the winner still served.
    older.change((doc) => { doc.objects.o1.name = 'ORIGINAL 2' })
    await project(older, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('TWIN')

    // A across segments: the winning key removed, the other segment's copy
    // takes the row.
    newer.change((doc) => { delete doc.objects['aa-twin'] })
    await project(newer, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('ORIGINAL 2')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('a DELETE-ONLY object delta (a lone object, no twin) deletes its row', async () => {
    const head = repo.create<ObjectHead>({ objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] })
    await project(head, 'object-overlay')
    expect(await rowCount('ro_objects'), 'control').toBe(2)
    head.change((doc) => { delete doc.objects.o2 })
    await project(head, 'object-overlay')
    expect(await roObject(database.pool, WS, 'o2')).toBeUndefined()
    expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('A')
    expect(await rowCount('ro_objects')).toBe(1)
  }, 30_000)

  it('a DELETE-ONLY connection delta (the only connection) deletes its row', async () => {
    type Head = { connections: Record<string, Named & { fromId: string; toId: string }>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = repo.create<Head>({ connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'A' } }, writeHeadVersion: 1, writeBatchIds: [] })
    await project(head, 'connection-overlay')
    expect(await rowCount('ro_connections'), 'control').toBe(1)
    head.change((doc) => { delete doc.connections.c1 })
    await project(head, 'connection-overlay')
    expect(await roConnection(database.pool, WS, 'c1')).toBeUndefined()
    expect(await rowCount('ro_connections')).toBe(0)
  }, 30_000)

  it('a plain key RENAME (key and inner id both change) deletes the old row and inserts the new one', async () => {
    const head = repo.create<ObjectHead>({ objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name, 'control').toBe('A')
    head.change((doc) => {
      delete doc.objects.o1
      doc.objects.o9 = { id: 'o9', name: 'A' }
    })
    await project(head, 'object-overlay')
    expect(await roObject(database.pool, WS, 'o1')).toBeUndefined()
    expect((await roObject(database.pool, WS, 'o9'))?.name).toBe('A')
    expect(await rowCount('ro_objects')).toBe(2)
  }, 30_000)

  it('an id TOMBSTONED by ModelMeta while a segment still holds it: the row is deleted, and an edit of that segment does not serve it again', async () => {
    const head = repo.create<ObjectHead>({ objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [] })
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o1'))?.name, 'control').toBe('A')

    // The ModelMeta that lists the head as an object segment and tombstones
    // o1 (`delete objects[id]` never reached this segment: it still holds it).
    type Meta = { groups: Record<string, Named & { objectIds: string[] }>; editsObjectShardUrls: string[]; deletedObjectIds: string[]; deletedDiagramIds: string[] }
    const meta = repo.create<Meta>({ groups: {}, editsObjectShardUrls: [head.url], deletedObjectIds: ['o1'], deletedDiagramIds: [] })
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision)
       VALUES ($1, $2, $3, 1)`,
      [WS.landscapeId, WS.versionId, meta.documentId],
    )
    await project(meta, 'model-meta')
    expect(await roObject(database.pool, WS, 'o1'), 'the ModelMeta pass deleted the row').toBeUndefined()

    head.change((doc) => { doc.objects.o1.name = 'A2'; doc.objects.o2.name = 'B2' })
    expect(head.doc()!.objects.o1.name, 'control: the segment still holds o1').toBe('A2')
    await project(head, 'object-overlay')
    expect((await roObject(database.pool, WS, 'o2'))?.name, 'control: the edit was projected').toBe('B2')
    expect(await roObject(database.pool, WS, 'o1'), 'the tombstoned id is not served').toBeUndefined()
    expect(await rowCount('ro_objects')).toBe(1)
  }, 30_000)

  it('a publish that did not own the workspace counts and logs nothing', async () => {
    // Ownership on, no fencing token: `publish` returns having applied nothing.
    const unowned = new StaticDeltaProjector(repo, database.pool, 250, 10_000, () => true, {
      enabled: true, fencingToken: () => null,
    })
    try {
      const head = twinPairHead()
      const before = liveDuplicateIdDropCount()
      expect(await projectLogged(head, 'object-overlay', unowned)).toEqual([])
      expect(liveDuplicateIdDropCount() - before).toBe(0)
      expect(await rowCount('ro_objects'), 'control: nothing was applied').toBe(0)

      // CONTROL: the same document through an owning projector counts.
      expect(await projectLogged(head, 'object-overlay')).toEqual([dropLine('object-shard', head, 'object', 'o1')])
      expect(liveDuplicateIdDropCount() - before).toBe(1)
    } finally {
      await unowned.stop()
    }
  }, 30_000)

  it('a ModelMeta publish whose transaction gave up (the mutex held elsewhere) counts and logs nothing', async () => {
    type Meta = { groups: Record<string, Named & { objectIds: string[] }>; deletedDiagramIds: string[] }
    const meta = loadedWithTwin<Meta>(
      { groups: { g1: { id: 'g1', name: 'ORIGINAL', objectIds: [] } }, deletedDiagramIds: [] },
      (doc) => { doc.groups['aa-twin'] = { id: 'g1', name: 'TWIN', objectIds: [] } },
    )
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision)
       VALUES ($1, $2, $3, 1)`,
      [WS.landscapeId, WS.versionId, meta.documentId],
    )
    // Another writer holds the workspace's projection mutex
    // (`projectionMutexKey`): the publish's transaction times out on it,
    // rolls back, and `publish` returns without throwing.
    const holder = await database.pool.connect()
    let logged: string[]
    const before = liveDuplicateIdDropCount()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`read-model-projection:${WS.landscapeId}:${WS.versionId}`])
      logged = await projectLogged(meta, 'model-meta')
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect(logged).toEqual([])
    expect(liveDuplicateIdDropCount() - before).toBe(0)
    expect(await rowCount('ro_groups'), 'control: the transaction rolled back').toBe(0)
  }, 30_000)

  it('G4-16f C6a: a static overlay publish leaves the object seal NOT comparable, never a stale match', async () => {
    // The static plane does not maintain the object/connection seals (no
    // recorder is bound to its transaction and it stamps nothing). That is
    // only safe because its publish ADVANCES `projected_generation`, which
    // un-dates any seal: this pins that half.
    type Head = { objects: Record<string, Named>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = loadedWithTwin<Head>(
      { objects: { o1: { id: 'o1', name: 'A' } }, writeHeadVersion: 1, writeBatchIds: [] },
      (doc) => { doc.objects.o2 = { id: 'o2', name: 'B' } },
    )
    await project(head, 'object-overlay')
    expect(await rowCount('ro_objects')).toBe(2)
    // A seal over exactly these rows, dated at the current generation — what
    // an ordinary projection would have left before a promotion.
    await database.pool.query(
      `UPDATE read_model_projection_state
          SET content_digest = jsonb_build_object('object', jsonb_build_object('n', $3::bigint, 'x', $4::text, 'g', projected_generation))
        WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId, 2, digestOfIds(['o1', 'o2']).x],
    )
    const sealed = await verifyWorkspaceIntegrity(database.pool, WS)
    expect(sealed.verdicts.find((v) => v.kind === 'object')?.outcome, 'control: the planted seal matches').toBe('match')

    head.change((doc) => { doc.objects.o3 = { id: 'o3', name: 'C' } })
    await project(head, 'object-overlay')
    expect(await rowCount('ro_objects')).toBe(3)
    const after = await verifyWorkspaceIntegrity(database.pool, WS)
    const object = after.verdicts.find((v) => v.kind === 'object')
    expect(after.projectedGeneration).toBeGreaterThan(sealed.projectedGeneration!)
    expect(object?.outcome).toBe('not-verifiable')
    expect(object?.expected?.g).toBe(sealed.projectedGeneration)
  }, 30_000)
})
