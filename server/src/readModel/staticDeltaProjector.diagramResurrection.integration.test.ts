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
 * T-DIAGDEF (3) — a DiagramDoc projected AFTER its diagram left the registry
 * must not bring the `ro_diagrams` row back.
 *
 * The race a manual test found (summary workspace, ~2 runs in 6): create a diagram, delete it
 * from its card at once. The write head loses the entry, the registry-shard
 * pass deletes the row (220–430 ms) — and a few hundred ms later the row is
 * back, for ever: `deletedDiagramIds` does not carry the id (an in-session
 * deletion never writes a ModelMeta tombstone, by design) and the registry does
 * not either, so nothing will ever delete it again. The DiagramDoc is still
 * registered (`read_model_static_documents`, `entity_id` set by the registry
 * pass), so its next save — the editor's last debounced flush, the reload's
 * sync — reaches `projectDiagram`, which UPSERTED unconditionally.
 *
 * DETERMINISTIC, not timed: the interleaving is driven pass by pass through the
 * projector's real dispatch (`project()`), in the order the race produces.
 * The projection mutex serialises the passes, so the order is the whole race.
 *
 * And the two orders that MUST keep writing: a DiagramDoc projected BEFORE its
 * registry entry (a sparse draft registers both documents in one commit) and a
 * diagram whose id came BACK into the head (undo).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL

const LANDSCAPE = 'ls-diagram-resurrection'
const VERSION = 'v1'

interface ShardDoc {
  diagrams: Record<string, { id: string; name?: string; type?: string; docUrl?: string; objectIds?: string[] }>
}
interface DiagramDoc { id: string; name: string; type: string; objectIds: string[]; connectionIds: string[]; groupIds: string[] }

describe.skipIf(!CONNECTION)('T-DIAGDEF (3) — a late DiagramDoc projection never resurrects a retired diagram', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'diagram_resurrection')
    await ensureReadModelSchema(database.pool)
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
      'read_model_static_membership_deltas', 'ro_workspace_stats',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [LANDSCAPE, VERSION])
    }
    await markStaticReadModelWorkspace(database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  const descriptor = (documentId: string, kind: string, entityId: string | null = null) => ({
    landscapeId: LANDSCAPE, versionId: VERSION, documentId, kind, entityId, orgId: null,
  })

  /** The REAL dispatch (`project()`), never a branch called directly. */
  async function project(handle: DocHandle<unknown>, kind: string, entityId: string | null = null): Promise<void> {
    const internal = projector as unknown as {
      project(d: ReturnType<typeof descriptor>, h: DocHandle<unknown>): Promise<void>
    }
    await internal.project(descriptor(handle.documentId, kind, entityId), handle)
  }

  function diagramDoc(id: string, objectIds: string[]): DocHandle<DiagramDoc> {
    return repo.create<DiagramDoc>({ id, name: `Diagram ${id}`, type: 'context', objectIds, connectionIds: [], groupIds: [] })
  }

  async function rowCount(table: 'ro_diagrams' | 'ro_diagram_objects' | 'ro_diagram_summaries', id: string): Promise<number> {
    const column = table === 'ro_diagrams' ? 'id' : 'diagram_id'
    const { rows } = await database.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND ${column} = $3`,
      [LANDSCAPE, VERSION, id],
    )
    return Number(rows[0].n)
  }

  async function diagramCount(): Promise<number> {
    const { rows } = await database.pool.query<{ diagram_count: string }>(
      `SELECT diagram_count FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2`,
      [LANDSCAPE, VERSION],
    )
    return Number(rows[0]?.diagram_count ?? 0)
  }

  it('R1 — create, delete from the write head, THEN the DiagramDoc save: the row stays gone', async () => {
    const doc = diagramDoc('dg-race', ['obj-1'])
    const head = repo.create<ShardDoc>({ diagrams: {
      'dg-race': { id: 'dg-race', name: 'New context diagram', type: 'context', docUrl: doc.url },
    } })
    // Creation: the head pass writes the row and registers the DiagramDoc, the
    // DiagramDoc pass writes its membership.
    await project(head, 'registry-shard')
    await project(doc, 'diagram', 'dg-race')
    expect(await rowCount('ro_diagrams', 'dg-race')).toBe(1)
    expect(await rowCount('ro_diagram_objects', 'dg-race')).toBe(1)

    // The in-session delete: `writeSummaryLocalRegistry` removes the entry.
    head.change((shard) => { delete shard.diagrams['dg-race'] })
    await project(head, 'registry-shard')
    expect(await rowCount('ro_diagrams', 'dg-race')).toBe(0)

    // The DiagramDoc's late save (still registered, entity id still set).
    doc.change((d) => { d.name = 'last debounced flush' })
    await project(doc, 'diagram', 'dg-race')

    expect(await rowCount('ro_diagrams', 'dg-race')).toBe(0)
    expect(await rowCount('ro_diagram_summaries', 'dg-race')).toBe(0)
    expect(await rowCount('ro_diagram_objects', 'dg-race')).toBe(0)
    expect(await diagramCount()).toBe(0)
  })

  it('R2 — a ModelMeta-tombstoned diagram is not re-inserted by its DiagramDoc', async () => {
    const meta = repo.create<{ deletedDiagramIds: string[] }>({ deletedDiagramIds: ['dg-tomb'] })
    await registerStaticReadModelDocuments(database.pool, { landscapeId: LANDSCAPE, versionId: VERSION },
      [{ documentId: meta.documentId, kind: 'model-meta' }])
    await (projector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
    const doc = diagramDoc('dg-tomb', ['obj-1'])

    await project(doc, 'diagram', 'dg-tomb')

    expect(await rowCount('ro_diagrams', 'dg-tomb')).toBe(0)
    expect(await rowCount('ro_diagram_objects', 'dg-tomb')).toBe(0)
  })

  it('R3 — a DiagramDoc projected BEFORE its registry entry still creates the row (sparse-draft order)', async () => {
    const doc = diagramDoc('dg-early', ['obj-1', 'obj-2'])

    await project(doc, 'diagram', 'dg-early')

    expect(await rowCount('ro_diagrams', 'dg-early')).toBe(1)
    expect(await rowCount('ro_diagram_objects', 'dg-early')).toBe(2)
  })

  it('R4 — an id that came BACK into the head (undo) is projected again, membership included', async () => {
    const doc = diagramDoc('dg-undo', ['obj-1'])
    const entry = { id: 'dg-undo', name: 'Undone', type: 'context', docUrl: doc.url }
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-undo': entry } })
    await project(head, 'registry-shard')
    head.change((shard) => { delete shard.diagrams['dg-undo'] })
    await project(head, 'registry-shard')
    head.change((shard) => { shard.diagrams['dg-undo'] = entry })
    await project(head, 'registry-shard')

    doc.change((d) => { d.objectIds.push('obj-2') })
    await project(doc, 'diagram', 'dg-undo')

    expect(await rowCount('ro_diagrams', 'dg-undo')).toBe(1)
    expect(await rowCount('ro_diagram_objects', 'dg-undo')).toBe(2)
  })

  it('R5 — a diagram moved to ANOTHER head (left one, live in the other) keeps projecting', async () => {
    const doc = diagramDoc('dg-moved', ['obj-1'])
    const entry = { id: 'dg-moved', name: 'Moved', type: 'context', docUrl: doc.url }
    const first = repo.create<ShardDoc>({ diagrams: { 'dg-moved': entry } })
    const second = repo.create<ShardDoc>({ diagrams: {} })
    await project(first, 'registry-shard')
    second.change((shard) => { shard.diagrams['dg-moved'] = entry })
    await project(second, 'registry-shard')
    first.change((shard) => { delete shard.diagrams['dg-moved'] })
    await project(first, 'registry-shard')

    doc.change((d) => { d.objectIds.push('obj-2') })
    await project(doc, 'diagram', 'dg-moved')

    expect(await rowCount('ro_diagram_objects', 'dg-moved')).toBe(2)
  })
})
