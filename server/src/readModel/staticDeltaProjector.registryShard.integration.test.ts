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
 * The registry WRITE HEAD as a projectable document.
 *
 * On a summary workspace, creating a diagram writes a `DiagramDoc` plus one
 * entry in the write head, and NOTHING into the model. Without the
 * `registry-shard` branch of `project()`, that write would reach no server
 * table: the diagram would be durable, openable from the nav menu, and
 * invisible to the Diagrams page, the search, "linked diagrams",
 * `diagram-render` and every other client.
 *
 * WHY THESE ASSERTIONS ARE AGAINST REAL ROWS, not against emitted SQL. The
 * three dangerous faults here are all about WHICH rows move:
 *
 *  - upsert-only (T3) trades an invisible diagram for an INDESTRUCTIBLE one —
 *    a card no client filter can remove, because a diagram created in-session
 *    never receives a ModelMeta tombstone (`diagramTombstonePlan.ts`, by
 *    design).
 *  - resurrecting a tombstoned id (T4) breaks `diagram-tombstone-honoured`,
 *    an invariant that is already executable in `npm run fsck`.
 *  - an unscoped reconciliation (T5) deletes the whole workspace. The shape is
 *    one call away: `syncDiagrams` does `DELETE … WHERE id <> ALL($3)` over the
 *    workspace, and on slope-target that is 9 988 rows destroyed by a diagram
 *    CREATION.
 *
 * A SQL-shape oracle would pass on code that emits the right statement
 * against the wrong rows. Counting surviving rows cannot.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo, generateAutomergeUrl, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL

const LANDSCAPE = 'ls-registry-head'
const VERSION = 'v1'

interface ShardDoc {
  diagrams: Record<string, {
    id: string
    name?: string
    type?: string
    docUrl?: string
    objectIds?: string[]
    connectionIds?: string[]
    groupIds?: string[]
  }>
}

describe.skipIf(!CONNECTION)('#41 — projecting the registry write head', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'registry_head_projection')
    await ensureReadModelSchema(database.pool)
    // Minimal shape of the admission table (its real DDL lives in db.ts):
    // `registerStaticReadModelDocuments` writes the workspace assignment too,
    // and a diagram document registered without one would never be admitted.
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
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root')
       ON CONFLICT DO NOTHING`,
      [LANDSCAPE, VERSION],
    )
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    // network: [] — an adapter with no peer makes repo.find() never settle.
    repo = new Repo({ network: [] })
    projector = new StaticDeltaProjector(repo, database.pool)
    for (const table of [
      'ro_diagrams', 'ro_diagram_summaries', 'ro_diagram_objects', 'ro_diagram_groups',
      'ro_diagram_connections', 'ro_connection_flows', 'read_model_static_documents',
      'read_model_static_membership_deltas', 'ro_workspace_stats',
    ]) {
      await database.pool.query(
        `DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`,
        [LANDSCAPE, VERSION],
      )
    }
    // The workspace must actually BE static: registering static DOCUMENTS
    // without the workspace row is a shortcut no production path takes
    // (`markStaticReadModelWorkspace` writes the workspace row before the
    // allow-list, and later callers of `registerStaticReadModelDocuments` only
    // run against a workspace that already has one). Without it the plane
    // check correctly refuses every publication here.
    await markStaticReadModelWorkspace(database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  /** A diagram the read model already serves — a BASE row of the workspace,
   * the 9 988 on slope-target. Never referenced by the write head. */
  async function seedBaseDiagram(id: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [LANDSCAPE, VERSION, id, JSON.stringify({ id, name: `base ${id}`, type: 'context' })],
    )
  }

  function writeHead(diagrams: ShardDoc['diagrams']): DocHandle<ShardDoc> {
    return repo.create<ShardDoc>({ diagrams })
  }

  function descriptorFor(handle: DocHandle<ShardDoc>) {
    return {
      landscapeId: LANDSCAPE,
      versionId: VERSION,
      documentId: handle.documentId,
      kind: 'registry-shard',
      entityId: null,
      orgId: null,
    }
  }

  /** Drive the REAL dispatch — `project()`, not the branch directly. A test
   * that called the branch would pass even if `project()`'s `else` swallowed
   * every `registry-shard` document. */
  async function project(handle: DocHandle<ShardDoc>): Promise<void> {
    const internal = projector as unknown as {
      project(descriptor: ReturnType<typeof descriptorFor>, handle: DocHandle<ShardDoc>): Promise<void>
    }
    await internal.project(descriptorFor(handle), handle)
  }

  async function diagramIds(): Promise<string[]> {
    const { rows } = await database.pool.query<{ id: string }>(
      `SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
      [LANDSCAPE, VERSION],
    )
    return rows.map((row) => row.id)
  }

  /**
   * The tombstones, POSED WHERE PRODUCTION HOLDS THEM: in a real ModelMeta
   * document, registered as a real descriptor and loaded by the real descriptor
   * loader.
   *
   * Never set `overlayState.deletedDiagramIds` directly: that field means
   * "tombstones this PROCESS has applied" — seeded empty, advanced only after a
   * publish — so posing it produces a state production does not have after a
   * restart, and would hide a branch that resurrects deleted diagrams on a
   * cold projector.
   */
  async function tombstone(...ids: string[]): Promise<void> {
    const handle = repo.create<{ deletedDiagramIds: string[] }>({ deletedDiagramIds: ids })
    await registerStaticReadModelDocuments(
      database.pool, { landscapeId: LANDSCAPE, versionId: VERSION },
      [{ documentId: handle.documentId, kind: 'model-meta' }],
    )
    await (projector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
  }

  // ── T1 ────────────────────────────────────────────────────────────────────
  it('T1 — projette dans ro_diagrams un diagramme ajouté à la tête d\'écriture', async () => {
    // A `registry-shard` document carrying a brand-new diagram must reach
    // `ro_diagrams`.
    const handle = writeHead({
      'dg-new': { id: 'dg-new', name: 'Nouveau contexte', type: 'context', docUrl: 'automerge:abc' },
    })

    await project(handle)

    expect(await diagramIds()).toEqual(['dg-new'])
    const { rows } = await database.pool.query<{ data: { name: string } }>(
      `SELECT data FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'dg-new'`,
      [LANDSCAPE, VERSION],
    )
    expect(rows[0].data.name).toBe('Nouveau contexte')
    // The page reads `ro_diagram_summaries`, not `ro_diagrams` — a projection
    // that stopped at the first table would leave the list empty.
    const summaries = await database.pool.query(
      `SELECT 1 FROM ro_diagram_summaries WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'dg-new'`,
      [LANDSCAPE, VERSION],
    )
    expect(summaries.rowCount).toBe(1)
  })

  it('T1b — enregistre le DiagramDoc, ce qui débloque le rattrapage par entity_id', async () => {
    // `reloadDescriptors` fills `entity_id` for `kind='diagram'` rows by joining
    // `ro_diagrams` on `data->>'docUrl'`, and `project()` ignores a diagram
    // descriptor whose `entityId` is null. For a brand-new diagram that join
    // has nothing to match, so the catch-up path would presuppose the row it
    // should create. Registering the doc here breaks that cycle.
    const handle = writeHead({
      'dg-new': { id: 'dg-new', name: 'N', type: 'context', docUrl: 'automerge:2NQQ4T7BeECW3X5tXf6tGVgLJazr' },
    })

    await project(handle)

    const { rows } = await database.pool.query<{ kind: string; entity_id: string }>(
      `SELECT kind, entity_id FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = '2NQQ4T7BeECW3X5tXf6tGVgLJazr'`,
      [LANDSCAPE, VERSION],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('diagram')
    expect(rows[0].entity_id).toBe('dg-new')
  })

  // ── T3 ────────────────────────────────────────────────────────────────────
  it('T3 — un diagramme retiré de la tête d\'écriture perd sa ligne ro_diagrams', async () => {
    // THE trap. `writeSummaryLocalRegistry` really does
    // `delete shard.diagrams[id]` when the user deletes a diagram created in
    // the same client session, and `planDiagramTombstones` deliberately writes NO
    // ModelMeta tombstone for it — so `deletedDiagramIds` never carries the id
    // and the client's one and only filter cannot hide the card.
    //
    // An upsert-only branch would therefore trade an invisible diagram for an
    // indestructible one. The first has a workaround (the nav menu); the second
    // has none. That is why this projection is a RECONCILIATION of the shard,
    // never an upsert.
    const handle = writeHead({
      'dg-keep': { id: 'dg-keep', name: 'Gardé', type: 'context' },
      'dg-drop': { id: 'dg-drop', name: 'Supprimé', type: 'context' },
    })
    await project(handle)
    expect(await diagramIds()).toEqual(['dg-drop', 'dg-keep'])

    handle.change((doc) => { delete doc.diagrams['dg-drop'] })
    await project(handle)

    expect(await diagramIds()).toEqual(['dg-keep'])
    const summaries = await database.pool.query(
      `SELECT 1 FROM ro_diagram_summaries WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'dg-drop'`,
      [LANDSCAPE, VERSION],
    )
    expect(summaries.rowCount).toBe(0)
  })

  // ── T4 ────────────────────────────────────────────────────────────────────
  it('T4 — ne ressuscite pas un id présent dans ModelMeta.deletedDiagramIds', async () => {
    // `diagram-tombstone-honoured` is ALREADY executable (`npm run fsck`), so a
    // branch that upserts without consulting the tombstones does not merely
    // misbehave — it breaks a check that will report it. The race is real: the
    // shard entry and the ModelMeta tombstone are two documents and arrive in
    // either order.
    await tombstone('dg-tombed')
    const handle = writeHead({
      'dg-live': { id: 'dg-live', name: 'Vivant', type: 'context' },
      'dg-tombed': { id: 'dg-tombed', name: 'Sous pierre tombale', type: 'context' },
    })

    await project(handle)

    expect(await diagramIds()).toEqual(['dg-live'])
  })

  // ── T5 ────────────────────────────────────────────────────────────────────
  it('T5 — projeter la tête d\'écriture ne supprime AUCUN diagramme de base', async () => {
    // The most expensive possible fault, and the reason the reconciliation
    // is scoped to the SHARD and never to the workspace. `syncDiagrams` is one
    // call away and does `DELETE FROM ro_diagrams … WHERE id <> ALL($3)` over
    // the whole workspace: on slope-target that is 9 988 rows destroyed by a
    // diagram CREATION. Scaled down here to three, which is the same statement.
    await seedBaseDiagram('base-1')
    await seedBaseDiagram('base-2')
    await seedBaseDiagram('base-3')
    const handle = writeHead({ 'dg-head': { id: 'dg-head', name: 'Tête', type: 'context' } })

    await project(handle)

    expect(await diagramIds()).toEqual(['base-1', 'base-2', 'base-3', 'dg-head'])

    // And again after a REMOVAL from the head — the delete arm is the one that
    // can go unscoped, so it is exercised with base rows present.
    handle.change((doc) => { delete doc.diagrams['dg-head'] })
    await project(handle)

    expect(await diagramIds()).toEqual(['base-1', 'base-2', 'base-3'])
  })

  it('T5b — deux têtes d\'écriture ne se suppriment pas l\'une l\'autre', async () => {
    // The scoping is per-DOCUMENT, not per-workspace: a workspace whose shards
    // rolled over has more than one, and a diff that read "everything not in
    // THIS shard" would make each projection delete the others' diagrams —
    // an alternating wipe that no single-shard fixture can see.
    const first = writeHead({ 'dg-a': { id: 'dg-a', name: 'A', type: 'context' } })
    const second = writeHead({ 'dg-b': { id: 'dg-b', name: 'B', type: 'context' } })

    await project(first)
    await project(second)
    await project(first)

    expect(await diagramIds()).toEqual(['dg-a', 'dg-b'])
  })

  it('T5c — reprojeter une tête inchangée est idempotent', async () => {
    // The counter behind the page footer (`ro_workspace_stats.diagram_count`)
    // is a RUNNING total clamped at zero, so a projection that re-counted its
    // own rows on every pass would drift the total up for ever.
    const handle = writeHead({ 'dg-one': { id: 'dg-one', name: 'Un', type: 'context' } })

    await project(handle)
    await project(handle)
    await project(handle)

    expect(await diagramIds()).toEqual(['dg-one'])
    const { rows } = await database.pool.query<{ diagram_count: string }>(
      `SELECT diagram_count FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2`,
      [LANDSCAPE, VERSION],
    )
    expect(Number(rows[0]?.diagram_count ?? 0)).toBe(1)
  })
})

/**
 * Restart, cache and provisioning paths. What separates these from T4 above is
 * where the state comes from: T4 POSES the tombstone set, which cannot model a
 * restart. Everything below goes through the real path.
 */
describe.skipIf(!CONNECTION)('#41 — la revue : ce que les fixtures posées à la main ne voyaient pas', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'registry_head_review')
    await ensureReadModelSchema(database.pool)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    // `arrival_seq` and its sequence are part of the REAL table (db.ts): the
    // storage adapter writes them on every save, so a stub without them makes
    // the m4 pair fail for a reason that has nothing to do with the queue.
    await database.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root')
       ON CONFLICT DO NOTHING`,
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
      'read_model_diagram_render_generations', 'read_model_static_document_queue',
      'read_model_static_workspaces',
    ]) {
      await database.pool.query(
        `DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`,
        [LANDSCAPE, VERSION],
      )
    }
    await database.pool.query('DELETE FROM automerge_document_workspace WHERE landscape_id = $1', [LANDSCAPE])
    // See the note on the first `beforeEach`: this hook DELETEs
    // `read_model_static_workspaces`, so it must restore the workspace row or
    // the workspace would be an ordinary one.
    await markStaticReadModelWorkspace(database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  interface MetaDoc { deletedDiagramIds: string[] }
  interface RootDoc { registryWriteUrl?: string; shardUrls: string[] }

  const meta = (id: string) => ({ id, name: id, type: 'context' })

  function writeHead(diagrams: ShardDoc['diagrams']): DocHandle<ShardDoc> {
    return repo.create<ShardDoc>({ diagrams })
  }

  function descriptorFor(documentId: string, kind: string, orgId: string | null = null) {
    return {
      landscapeId: LANDSCAPE, versionId: VERSION, documentId, kind,
      entityId: null, orgId,
    }
  }

  /** The REAL dispatch, as in the suite above. */
  async function project(
    handle: DocHandle<unknown>, kind = 'registry-shard', orgId: string | null = null,
  ): Promise<void> {
    const internal = projector as unknown as {
      project(descriptor: ReturnType<typeof descriptorFor>, handle: DocHandle<unknown>): Promise<void>
    }
    await internal.project(descriptorFor(handle.documentId, kind, orgId), handle)
  }

  /** The production descriptor loader, which is how a freshly started process
   * learns what it owns. Using it (rather than poking `descriptors`) is what
   * makes the restart below a restart and not a mock of one. */
  async function reloadDescriptors(): Promise<void> {
    await (projector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
  }

  async function registerDocuments(documents: { documentId: string; kind: string }[]): Promise<void> {
    await registerStaticReadModelDocuments(
      database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, documents,
    )
  }

  async function diagramIds(): Promise<string[]> {
    const { rows } = await database.pool.query<{ id: string }>(
      `SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
      [LANDSCAPE, VERSION],
    )
    return rows.map((row) => row.id)
  }

  async function renderGeneration(diagramId: string): Promise<number> {
    const { rows } = await database.pool.query<{ render_generation: string }>(
      `SELECT render_generation FROM read_model_diagram_render_generations
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [LANDSCAPE, VERSION, diagramId],
    )
    return Number(rows[0]?.render_generation ?? 0)
  }

  async function staticDocumentKind(documentId: string): Promise<string | null> {
    const { rows } = await database.pool.query<{ kind: string }>(
      `SELECT kind FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [LANDSCAPE, VERSION, documentId],
    )
    return rows[0]?.kind ?? null
  }

  // ── M1 ────────────────────────────────────────────────────────────────────
  it('M1 — apres un REDEMARRAGE, ne ressuscite pas un diagramme supprime en session anterieure', async () => {
    // Walked end to end through the real path; nothing is posed.
    //
    // `overlayState.deletedDiagramIds` means "tombstones this PROCESS has
    // applied" — seeded empty, filled only AFTER a publish, and short-circuited
    // before that on every untouched ModelMeta. So after any restart it is
    // empty, while the write head keeps the deleted diagram's meta for ever
    // (`writeSummaryLocalRegistry` walks only `summaryLocalDiagramIds`, module
    // state that dies with the page). A branch reading that set would bring the
    // diagram back on the next creation — breaking `diagram-tombstone-honoured`
    // with no repair, because the ModelMeta that would fix it has no reason to
    // change again.
    const metaHandle = repo.create<MetaDoc>({ deletedDiagramIds: [] })
    await registerDocuments([{ documentId: metaHandle.documentId, kind: 'model-meta' }])
    const head = writeHead({ 'dg-gone': meta('dg-gone'), 'dg-old': meta('dg-old') })
    await reloadDescriptors()

    // Session 1 — both diagrams are created and projected.
    await project(head)
    expect(await diagramIds()).toEqual(['dg-gone', 'dg-old'])

    // Session 2, after a reload — `dg-gone` is no longer session-local, so the
    // delete goes through a ModelMeta tombstone, and NOTHING removes the entry
    // from the write head. The ModelMeta pass drops the row.
    metaHandle.change((doc) => { doc.deletedDiagramIds = ['dg-gone'] })
    await database.pool.query(
      `DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'dg-gone'`,
      [LANDSCAPE, VERSION],
    )

    // RESTART. A new process: empty overlayState, and a ModelMeta whose
    // `projected_revision` is already caught up, so its pass short-circuits
    // without ever filling the applied-tombstone set.
    await projector.stop()
    projector = new StaticDeltaProjector(repo, database.pool)
    await reloadDescriptors()

    // The user creates one more diagram. The head changes; the whole shard is
    // reconciled.
    head.change((doc) => { doc.diagrams['dg-new'] = meta('dg-new') })
    await project(head)

    expect(await diagramIds()).toEqual(['dg-new', 'dg-old'])
  })

  it('M1c — le fait ModelMeta MIS EN CACHE est honore, pas seulement celui relu a froid', async () => {
    // M1 covers the COLD projector: no `overlayState` entry, so
    // `durableDeletedDiagramIds` falls through to the document. That is the
    // restart path. The path a running server spends all its time on is the
    // other one — a ModelMeta pass HAS run, `metaDeletedDiagramIds` is filled,
    // and the cached set is returned without touching the document:
    //
    //     const known = ...?.metaDeletedDiagramIds
    //     if (known) return known
    //
    // An EMPTY set is truthy, so if the cache is ever filled with the wrong
    // value there is no fallback — the branch confidently reports "no
    // tombstones" and the write head resurrects every deleted diagram it still
    // carries. Other tests reach the document path instead, so only this one
    // exercises the cached set.
    const metaHandle = repo.create<MetaDoc>({ deletedDiagramIds: ['dg-gone'] })
    await registerDocuments([{ documentId: metaHandle.documentId, kind: 'model-meta' }])
    const head = writeHead({ 'dg-gone': meta('dg-gone'), 'dg-ok': meta('dg-ok') })
    await reloadDescriptors()

    // The ModelMeta pass runs FIRST, exactly as it does on a live server, and
    // it is what fills the cache this test is about.
    await project(metaHandle, 'model-meta')

    await project(head)

    expect(
      await diagramIds(),
      'the write head reprojection took its tombstones from a cache that no longer carried the '
      + 'ModelMeta fact, and resurrected a deleted diagram — with no fallback, because an empty '
      + 'set short-circuits the durable read',
    ).toEqual(['dg-ok'])
  })

  it('M1b — un ModelMeta enregistre mais irresoluble fait ABSTENIR, jamais deviner', async () => {
    // The third outcome, and the one worth a test of its own: guessing "no
    // tombstones" costs a resurrected diagram that never repairs itself, while
    // abstaining costs one retry. A rejection here leaves the durable queue
    // un-acknowledged, so the projection comes back.
    const absent = generateAutomergeUrl()
    await registerDocuments([
      { documentId: absent.replace(/^automerge:/, ''), kind: 'model-meta' },
    ])
    const head = writeHead({ 'dg-any': meta('dg-any') })
    await reloadDescriptors()

    await expect(project(head)).rejects.toThrow()

    expect(await diagramIds()).toEqual([])
  }, 30_000)

  // ── M2 ────────────────────────────────────────────────────────────────────
  it('M2 — ne bouscule la generation de rendu que pour le DELTA, pas pour toute la tete', async () => {
    // `diagramRenderGeneration.ts` states the contract: "Only a dependency
    // mutation bumps this token; unrelated workspace projections deliberately
    // do not." Bumping every id the head carries would invalidate the render
    // cache of every diagram on the workspace each time one was created.
    const head = writeHead({ 'dg-a': meta('dg-a'), 'dg-b': meta('dg-b') })
    await project(head)
    const untouched = await renderGeneration('dg-b')
    expect(untouched).toBeGreaterThan(0)

    head.change((doc) => { doc.diagrams['dg-c'] = meta('dg-c') })
    await project(head)

    expect(await renderGeneration('dg-b')).toBe(untouched)
    expect(await renderGeneration('dg-c')).toBeGreaterThan(0)

    // And a real change to an existing entry still bumps it — otherwise this
    // test would be satisfied by a branch that bumps nothing at all.
    head.change((doc) => { doc.diagrams['dg-b'].name = 'renomme' })
    await project(head)
    expect(await renderGeneration('dg-b')).toBeGreaterThan(untouched)
  })

  // ── q3 ────────────────────────────────────────────────────────────────────
  it('M2b — un diagramme RETIRE de la tete voit sa generation de rendu bousculee', async () => {
    // M2 pins the "do not bump the untouched" half of the delta; this is the
    // other half (`...removed` in the bump), which M2 cannot see.
    //
    // Without it `diagramRenderRedisCache` keeps serving a cached render of a
    // diagram that no longer exists — the same reason the ModelMeta tombstone
    // pass bumps its explicit `diagramIds`.
    const head = writeHead({ 'dg-keep': meta('dg-keep'), 'dg-drop': meta('dg-drop') })
    await project(head)
    const before = await renderGeneration('dg-drop')
    expect(before).toBeGreaterThan(0)

    head.change((doc) => { delete doc.diagrams['dg-drop'] })
    await project(head)

    expect(await diagramIds()).toEqual(['dg-keep'])
    expect(
      await renderGeneration('dg-drop'),
      'the removed diagram kept its render generation, so the render cache goes on serving a '
      + 'diagram that no longer has a row',
    ).toBeGreaterThan(before)
  })

  it('M2c — une ligne sous un AUTRE org est reecrite meme si son contenu est identique', async () => {
    // The `changed` filter is what makes the reconciliation O(changed) instead
    // of O(head), and it has two arms: the row is missing, or the row sits
    // under another org. This test exercises the org arm.
    // `descriptor.orgId` is loaded per document row
    // (`reloadDescriptors`), while `ro_diagrams.org_id` is whatever the last
    // write left, so a workspace whose org was assigned after its rows were
    // projected carries the drift — and org_id is what the row-level policies
    // read. The sibling path repairs it unconditionally: `projectDiagram` ends
    // in `upsertDiagrams(tx, descriptor, descriptor.orgId ?? current…, …)` with
    // no skip at all. This arm is what keeps the two writers of the same column
    // in agreement; without it the head path alone would preserve the drift for
    // ever, because the CONTENT matches and nothing else forces a write.
    await database.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, org_id, id, data)
       VALUES ($1, $2, 'org-ancien', 'dg-a', $3::jsonb)`,
      [LANDSCAPE, VERSION, JSON.stringify(meta('dg-a'))],
    )
    const head = writeHead({ 'dg-a': meta('dg-a') })

    // Same content, so the fingerprint says "unchanged"; only the org differs.
    await project(head, 'registry-shard', 'org-nouveau')

    const { rows } = await database.pool.query<{ org_id: string | null }>(
      `SELECT org_id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'dg-a'`,
      [LANDSCAPE, VERSION],
    )
    expect(
      rows[0]?.org_id,
      'the row kept the old org because its CONTENT was unchanged — the head path stopped '
      + 'repairing org drift that every other writer of this column repairs',
    ).toBe('org-nouveau')
  })

  it('q3 — la CLE de la carte est identite, celle par laquelle le pont supprime', async () => {
    // Three parties addressed a write-head entry three ways: the bridge deletes
    // by KEY, fsck reads `Object.keys`, and this projection read `meta.id`. They
    // agree for everything the bridge writes, so this is not a live defect —
    // but where they diverged the row would be created under one name and
    // deleted under another, which is the indestructible card T3 exists to
    // prevent. Aligning on the deleter's address removes the divergence.
    const head = writeHead({ 'dg-key': meta('dg-stale') })

    await project(head)
    expect(await diagramIds()).toEqual(['dg-key'])

    head.change((doc) => { delete doc.diagrams['dg-key'] })
    await project(head)
    expect(await diagramIds()).toEqual([])
  })

  // ── M4 ────────────────────────────────────────────────────────────────────
  it('M4 — une tete ecriture provisionnee par le CLIENT est enregistree et projetee', async () => {
    // `read_model_static_documents` is written by promotion and by the offline
    // repairs — never by a live path. But the bridge provisions a head of its
    // own when the declared one is unresolved at the first write (a degraded or
    // offline boot), and publishes it by repointing `root.registryWriteUrl`.
    // With no row for that document the queue filter would match nothing AND
    // `attach()` would return before it could listen: every diagram written
    // into it would be invisible on every server surface, permanently.
    const head = writeHead({ 'dg-deferred': meta('dg-deferred') })
    const root = repo.create<RootDoc>({ registryWriteUrl: head.url, shardUrls: [head.url] })
    await registerDocuments([{ documentId: root.documentId, kind: 'root' }])
    await reloadDescriptors()

    // The premise: the head is unknown to the server. If this ever stops being
    // true the test is measuring something else.
    expect(await staticDocumentKind(head.documentId)).toBeNull()

    await project(root, 'root')

    expect(await staticDocumentKind(head.documentId)).toBe('registry-shard')
    // The registration alone would be an admission row nobody acts on. The
    // oracle is the ROW the user's diagram gets.
    await expect.poll(() => diagramIds(), { timeout: 15_000, interval: 100 }).toEqual(['dg-deferred'])
  }, 40_000)

  // ── m4 ─────────────────────────────────────────────────────────────
  it('m4 — une ECRITURE REELLE sur la tete produit une ligne de file, pas seulement le bon texte SQL', async () => {
    // The adapter's own tests assert the TEXT of the statement it emits. That
    // pins the filter and nothing else; this proves a save on a real write
    // head produces a real queue row.
    const head = writeHead({ 'dg-any': meta('dg-any') })
    await markStaticReadModelWorkspace(
      database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, 'test',
      [{ documentId: head.documentId, kind: 'registry-shard' }],
    )
    const adapter = new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true })

    await adapter.save([head.documentId, 'incremental', 'chunk-1'], new Uint8Array([1, 2, 3]))

    const { rows } = await database.pool.query<{ revision: string; projected_revision: string }>(
      `SELECT revision, projected_revision FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [LANDSCAPE, VERSION, head.documentId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].revision)).toBeGreaterThan(Number(rows[0].projected_revision))
  })

  it('m4b — un registre de base immuable reste HORS de la file', async () => {
    // The boundary of the same filter, asserted against a real write rather
    // than against a string: `registry` documents are never written, and
    // enqueueing them would add work for nothing.
    const baseline = writeHead({ 'dg-base': meta('dg-base') })
    await markStaticReadModelWorkspace(
      database.pool, { landscapeId: LANDSCAPE, versionId: VERSION }, 'test',
      [{ documentId: baseline.documentId, kind: 'registry' }],
    )
    const adapter = new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true })

    await adapter.save([baseline.documentId, 'incremental', 'chunk-1'], new Uint8Array([1, 2, 3]))

    const { rows } = await database.pool.query(
      `SELECT 1 FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [LANDSCAPE, VERSION, baseline.documentId],
    )
    expect(rows).toHaveLength(0)
  })

  it('M4c — une tete DEJA enregistree n est jamais re-etiquetee par la racine', async () => {
    // The reason this branch acts only on an ABSENT row: a static workspace
    // that is not summary can have its `root.registryWriteUrl` registered as
    // `registry` — an immutable baseline. A branch that
    // re-registered it as `registry-shard` would `ON CONFLICT DO UPDATE SET
    // kind` a baseline document onto the incremental projection path, for no
    // defect. The repair for a missing row must not become a rewrite of a
    // present one.
    const head = writeHead({ 'dg-base': meta('dg-base') })
    await registerDocuments([{ documentId: head.documentId, kind: 'registry' }])
    const root = repo.create<RootDoc>({ registryWriteUrl: head.url, shardUrls: [head.url] })
    await registerDocuments([{ documentId: root.documentId, kind: 'root' }])
    await reloadDescriptors()

    await project(root, 'root')

    expect(await staticDocumentKind(head.documentId)).toBe('registry')
  })

  it('M4d — une tete presente en BASE mais absente du MEMO n est pas re-etiquetee', async () => {
    // M4c above proves the guard for a head the memo carries. But the memo is
    // `descriptors`, filled by `reloadDescriptors` — a SNAPSHOT of the
    // registration record, not the record itself. Promotion, the static
    // baseline build, the offline repairs and the sparse draft all write
    // `read_model_static_documents` from outside this projector, so a row
    // written after its last reload is present in the database and absent from
    // the memo. Checked against the memo alone, the branch would relabel a
    // `registry` baseline to `registry-shard` through `ON CONFLICT DO UPDATE
    // SET kind` — the damage M4c forbids, through the other door.
    const head = writeHead({ 'dg-base': meta('dg-base') })
    const root = repo.create<RootDoc>({ registryWriteUrl: head.url, shardUrls: [head.url] })
    await registerDocuments([{ documentId: root.documentId, kind: 'root' }])
    await reloadDescriptors()
    // Registered AFTER the reload: the database knows, the memo does not.
    await registerDocuments([{ documentId: head.documentId, kind: 'registry' }])

    await project(root, 'root')

    expect(
      await staticDocumentKind(head.documentId),
      'the root branch relabelled an immutable baseline registry onto the incremental '
      + 'projection path because it asked its own memo instead of the registration record',
    ).toBe('registry')
  })

  it('M4b — une racine sans tete ecriture enregistre rien', async () => {
    // A monolith root names no write head. Registering something for it would
    // put a document on the live projection path for a workspace that has none.
    const root = repo.create<RootDoc>({ shardUrls: [] })
    await registerDocuments([{ documentId: root.documentId, kind: 'root' }])
    await reloadDescriptors()

    await project(root, 'root')

    const { rows } = await database.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND kind = 'registry-shard'`,
      [LANDSCAPE, VERSION],
    )
    expect(Number(rows[0].count)).toBe(0)
  })
})
