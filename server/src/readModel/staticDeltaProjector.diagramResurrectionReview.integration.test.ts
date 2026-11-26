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
 * T-DIAGDEF, the `projectDiagram` guard hardened (each case labelled below):
 *
 *  - I4  a row an EARLIER resurrection left is repaired — by the next pass of
 *        its DiagramDoc, and durably by the reload tick's sweep, which needs
 *        no save at all; never a baseline-listed diagram, never a sparse
 *        draft's DiagramDoc-first row (R3);
 *  - I5  ModelMeta is needed only when the row is ABSENT (only an insert
 *        resurrects); absent + unresolvable ModelMeta abstains;
 *  - M1  an id that comes back (undo) re-opens its DiagramDoc: the membership
 *        returns without a new save of the document;
 *  - M2  a DiagramDoc the registry no longer names never overwrites the one it
 *        names;
 *  - M3  a refused pass publishes no reset and no generation;
 *  - M4  the membership index migration.
 *
 * Every pass through the projector's real dispatch (`project()`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo, generateAutomergeUrl, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema, ensureStaticMembershipHeadIndex, STATIC_MEMBERSHIP_HEAD_INDEX } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector, StaticDescriptorMap } from './staticDeltaProjector.js'
import { schemaMigrations } from '../db/schemaMigrations.js'

const CONNECTION = process.env.TEST_DATABASE_URL

const LANDSCAPE = 'ls-diagram-review'
const VERSION = 'v1'
const WS = { landscapeId: LANDSCAPE, versionId: VERSION }

interface ShardDoc {
  diagrams: Record<string, { id: string; name?: string; type?: string; docUrl?: string }>
}
interface DiagramDoc { id: string; name: string; type: string; objectIds: string[]; connectionIds: string[]; groupIds: string[] }

describe.skipIf(!CONNECTION)('T-DIAGDEF — the DiagramDoc guard, hardened', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'diagram_review')
    await ensureReadModelSchema(database.pool)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await database.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`,
      [LANDSCAPE, VERSION],
    )
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    repo = new Repo({ network: [] })
    projector = new StaticDeltaProjector(repo, database.pool)
    for (const table of [
      'ro_diagrams', 'ro_diagram_summaries', 'ro_diagram_objects', 'ro_diagram_groups',
      'ro_diagram_connections', 'ro_connection_flows', 'read_model_static_documents',
      'read_model_static_membership_deltas', 'ro_workspace_stats', 'read_model_static_document_queue',
      'read_model_change_events', 'read_model_projection_state', 'read_model_diagram_render_generations',
      'read_model_static_workspaces',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [LANDSCAPE, VERSION])
    }
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  const descriptor = (documentId: string, kind: string, entityId: string | null = null) => ({
    landscapeId: LANDSCAPE, versionId: VERSION, documentId, kind, entityId, orgId: null,
  })
  const internal = () => projector as unknown as {
    project(d: ReturnType<typeof descriptor>, h: DocHandle<unknown>): Promise<void>
    reloadDescriptors(): Promise<void>
    recoverChangedDocuments(): Promise<void>
    repairRetiredDiagramRows(): Promise<void>
  }
  const project = (handle: DocHandle<unknown>, kind: string, entityId: string | null = null) =>
    internal().project(descriptor(handle.documentId, kind, entityId), handle)
  /** A ModelMeta pass at revision 0 counts as already projected
   * (`metaSourceAlreadyProjected`): give it an owed queue revision, as a save does. */
  async function projectMeta(handle: DocHandle<unknown>): Promise<void> {
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = read_model_static_document_queue.revision + 1`,
      [LANDSCAPE, VERSION, handle.documentId],
    )
    await project(handle, 'model-meta')
  }

  const diagramDoc = (id: string, objectIds: string[], name = `Diagram ${id}`) =>
    repo.create<DiagramDoc>({ id, name, type: 'context', objectIds, connectionIds: [], groupIds: [] })

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await database.pool.query<{ n: string }>(sql, [LANDSCAPE, VERSION, ...params])
    return Number(rows[0].n)
  }
  const rows = (id: string) => count('SELECT count(*) AS n FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [id])
  const members = (id: string) => count('SELECT count(*) AS n FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3', [id])
  const changeEvents = () => count('SELECT count(*) AS n FROM read_model_change_events WHERE landscape_id = $1 AND version_id = $2')
  const generation = () => count('SELECT COALESCE(max(observed_generation), 0) AS n FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2')
  const diagramCount = () => count('SELECT COALESCE(max(diagram_count), 0) AS n FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2')

  /** Create a diagram in a write head (row + DiagramDoc registered + membership), then remove it from the head. */
  async function createThenRemove(id: string): Promise<{ head: DocHandle<ShardDoc>; doc: DocHandle<DiagramDoc>; entry: ShardDoc['diagrams'][string] }> {
    const doc = diagramDoc(id, ['obj-1'])
    const entry = { id, name: id, type: 'context', docUrl: doc.url }
    const head = repo.create<ShardDoc>({ diagrams: { [id]: entry } })
    await project(head, 'registry-shard')
    await project(doc, 'diagram', id)
    head.change((shard) => { delete shard.diagrams[id] })
    await project(head, 'registry-shard')
    return { head, doc, entry }
  }

  /** What a resurrection on an OLDER build left: the row (and its membership) back, the head still without it. */
  async function plantOrphan(id: string, docUrl: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [LANDSCAPE, VERSION, id, JSON.stringify({ id, name: 'orphan', type: 'context', docUrl })],
    )
    await database.pool.query(
      `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id) VALUES ($1, $2, $3, 'obj-1')`,
      [LANDSCAPE, VERSION, id],
    )
    await database.pool.query(
      `INSERT INTO ro_workspace_stats (landscape_id, version_id, diagram_count) VALUES ($1, $2, 1)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET diagram_count = ro_workspace_stats.diagram_count + 1`,
      [LANDSCAPE, VERSION],
    )
  }

  // ── I4 ──────────────────────────────────────────────────────────────────
  it('I4a — the next DiagramDoc pass DELETES a row an earlier resurrection left, and the counter follows', async () => {
    const { doc } = await createThenRemove('dg-orphan')
    expect(await rows('dg-orphan')).toBe(0)
    await plantOrphan('dg-orphan', doc.url)
    expect(await diagramCount()).toBe(1)

    doc.change((d) => { d.name = 'a later save' })
    await project(doc, 'diagram', 'dg-orphan')

    expect(await rows('dg-orphan')).toBe(0)
    expect(await members('dg-orphan')).toBe(0)
    expect(await diagramCount()).toBe(0)
  })

  it('I4b — the reload tick repairs a pre-existing orphan WITHOUT any save of its DiagramDoc, idempotently', async () => {
    const { doc } = await createThenRemove('dg-orphan')
    await plantOrphan('dg-orphan', doc.url)
    await internal().reloadDescriptors()

    await internal().repairRetiredDiagramRows()
    expect(await rows('dg-orphan')).toBe(0)
    expect(await members('dg-orphan')).toBe(0)
    expect(await diagramCount()).toBe(0)

    const eventsAfterRepair = await changeEvents()
    await internal().repairRetiredDiagramRows()
    expect(await changeEvents()).toBe(eventsAfterRepair)
  })

  it('I4c — the tick repairs a ModelMeta-tombstoned row too, once that fact is cached', async () => {
    await plantOrphan('dg-tomb', generateAutomergeUrl())
    const meta = repo.create<{ deletedDiagramIds: string[]; groups: Record<string, never> }>({ deletedDiagramIds: ['dg-tomb'], groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await internal().reloadDescriptors()
    await projectMeta(meta)
    // The ModelMeta pass itself deletes a tombstone it had not applied; put
    // the row back as an older cell would have.
    await plantOrphan('dg-tomb', generateAutomergeUrl())

    await internal().repairRetiredDiagramRows()

    expect(await rows('dg-tomb')).toBe(0)
  })

  it('I4d — never a diagram a BASELINE registry still lists, never a sparse draft\'s DiagramDoc-first row (R3)', async () => {
    const { doc } = await createThenRemove('dg-in-base')
    await plantOrphan('dg-in-base', doc.url)
    const baseline = repo.create<ShardDoc>({ diagrams: { 'dg-in-base': { id: 'dg-in-base', name: 'base', docUrl: doc.url } } })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: baseline.documentId, kind: 'registry' }])
    const early = diagramDoc('dg-draft-early', ['obj-1'])
    await project(early, 'diagram', 'dg-draft-early')
    await internal().reloadDescriptors()

    await internal().repairRetiredDiagramRows()

    expect(await rows('dg-in-base')).toBe(1)
    expect(await rows('dg-draft-early')).toBe(1)
    expect(await members('dg-draft-early')).toBe(1)
  })

  // ── I5 ──────────────────────────────────────────────────────────────────
  it('I5a — a PRESENT row projects without ModelMeta, even an unresolvable one', async () => {
    const doc = diagramDoc('dg-present', ['obj-1'])
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-present': { id: 'dg-present', name: 'p', docUrl: doc.url } } })
    await project(head, 'registry-shard')
    // A ModelMeta registered whose document this Repo never sees.
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: generateAutomergeUrl().slice('automerge:'.length), kind: 'model-meta' }])
    await internal().reloadDescriptors()

    doc.change((d) => { d.objectIds.push('obj-2') })
    await project(doc, 'diagram', 'dg-present')

    expect(await members('dg-present')).toBe(2)
  })

  it('I5b — an ABSENT row with an unresolvable ModelMeta abstains (no row, the revision stays owed)', async () => {
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: generateAutomergeUrl().slice('automerge:'.length), kind: 'model-meta' }])
    await internal().reloadDescriptors()
    const doc = diagramDoc('dg-absent', ['obj-1'])

    await expect(project(doc, 'diagram', 'dg-absent')).rejects.toThrow()
    expect(await rows('dg-absent')).toBe(0)
  }, 20_000)

  it('I5c — a present row of a tombstoned id is deleted by the ModelMeta pass that carries the tombstone', async () => {
    const doc = diagramDoc('dg-later-tomb', ['obj-1'])
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-later-tomb': { id: 'dg-later-tomb', name: 'p', docUrl: doc.url } } })
    await project(head, 'registry-shard')
    await project(doc, 'diagram', 'dg-later-tomb')
    const meta = repo.create<{ deletedDiagramIds: string[]; groups: Record<string, never> }>({ deletedDiagramIds: ['dg-later-tomb'], groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await internal().reloadDescriptors()

    await projectMeta(meta)

    expect(await rows('dg-later-tomb')).toBe(0)
  })

  it('I5d — the ModelMeta descriptor index answers in O(1) and survives removals (StaticDescriptorMap)', () => {
    const map = new StaticDescriptorMap()
    const d = (documentId: string, kind: string, versionId = VERSION) => ({ ...descriptor(documentId, kind), versionId })
    map.set('a', d('a', 'diagram'))
    expect(map.modelMetaOf(WS)).toBeUndefined()
    map.set('m1', d('m1', 'model-meta'))
    map.set('m2', d('m2', 'model-meta'))
    map.set('x', d('x', 'model-meta', 'other'))
    expect(map.modelMetaOf(WS)?.documentId).toBe('m1')
    map.delete('m1')
    expect(map.modelMetaOf(WS)?.documentId).toBe('m2')
    map.set('m2', d('m2', 'registry'))
    expect(map.modelMetaOf(WS)).toBeUndefined()
    expect(map.modelMetaOf({ landscapeId: LANDSCAPE, versionId: 'other' })?.documentId).toBe('x')
  })

  // ── M1 ──────────────────────────────────────────────────────────────────
  it('M1 (R4 bis) — refused, then the id comes back, NO new save: the membership is restored', async () => {
    const { head, doc, entry } = await createThenRemove('dg-back')
    // The refused pass (the DiagramDoc's late save, while retired).
    doc.change((d) => { d.objectIds.push('obj-2') })
    await project(doc, 'diagram', 'dg-back')
    expect(await rows('dg-back')).toBe(0)

    head.change((shard) => { shard.diagrams['dg-back'] = entry })
    await project(head, 'registry-shard')
    expect(await rows('dg-back')).toBe(1)
    expect(await members('dg-back')).toBe(0)

    // The DiagramDoc is owed again, durably (the queue the recovery tick reads)…
    expect(await count(
      `SELECT count(*) AS n FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3 AND revision > projected_revision`,
      [doc.documentId],
    )).toBe(1)
    // …and with no change to the DiagramDoc, the recovery tick projects it
    // (its pass is started, not awaited, by `recoverChangedDocuments`).
    await internal().reloadDescriptors()
    await internal().recoverChangedDocuments()
    for (let i = 0; i < 50 && await members('dg-back') !== 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 100))

    expect(await members('dg-back')).toBe(2)
  })

  // ── M2 ──────────────────────────────────────────────────────────────────
  it('M2 — an OLD DiagramDoc the registry no longer names never overwrites the current one', async () => {
    const old = diagramDoc('dg-re', ['obj-old'], 'old document')
    const current = diagramDoc('dg-re', ['obj-new'], 'current document')
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-re': { id: 'dg-re', name: 'current document', docUrl: current.url } } })
    await project(head, 'registry-shard')
    await project(current, 'diagram', 'dg-re')

    old.change((d) => { d.name = 'old document, saved late' })
    await project(old, 'diagram', 'dg-re')

    const { rows: data } = await database.pool.query<{ name: string }>(
      `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'dg-re'`, [LANDSCAPE, VERSION],
    )
    expect(data[0]?.name).toBe('current document')
    expect(await count(
      `SELECT count(*) AS n FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'dg-re' AND object_id = 'obj-old'`,
    )).toBe(0)
  })

  // ── M3 ──────────────────────────────────────────────────────────────────
  it('M3 — a refused pass publishes no reset and no generation', async () => {
    const { doc } = await createThenRemove('dg-quiet')
    const events = await changeEvents()
    const before = await generation()

    doc.change((d) => { d.name = 'late' })
    await project(doc, 'diagram', 'dg-quiet')

    expect(await changeEvents()).toBe(events)
    expect(await generation()).toBe(before)
  })

  // ── M4 ──────────────────────────────────────────────────────────────────
  // The index has since become PARTIAL and 0008 repeatable — the partial
  // shape, the deferral and the EXPLAIN are in
  // `staticDeltaProjector.diagramResurrectionReview2.integration.test.ts`.
  it('M4 — migration 0008 builds the write-head index, and rebuilds an INVALID one', async () => {
    expect(schemaMigrations(database.pool).map((migration) => migration.id)).toContain('0008-static-membership-entity-index')
    const entry = schemaMigrations(database.pool).find((migration) => migration.id === '0008-static-membership-entity-index')!
    expect(entry.transactional).toBe(false)
    const client = await database.pool.connect()
    try {
      await ensureStaticMembershipHeadIndex(client)
      await ensureStaticMembershipHeadIndex(client)
      const { rows: indexes } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [STATIC_MEMBERSHIP_HEAD_INDEX],
      )
      expect(indexes).toHaveLength(1)
      expect(indexes[0].indexdef).toMatch(/\(landscape_id, version_id, entity_id\)/)
      // An interrupted CONCURRENTLY build leaves it INVALID: forced here.
      await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass`, [STATIC_MEMBERSHIP_HEAD_INDEX])
      await ensureStaticMembershipHeadIndex(client)
      const { rows: valid } = await client.query<{ indisvalid: boolean }>(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass`, [STATIC_MEMBERSHIP_HEAD_INDEX],
      )
      expect(valid[0].indisvalid).toBe(true)
    } finally {
      client.release()
    }
  })
})
