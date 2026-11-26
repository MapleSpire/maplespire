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
 * T-DIAGDEF, the second hardening round of the static plane's diagram
 * resurrection. Each case is labelled; its tests carry the label:
 *
 *  - I-A the repair re-reads the tombstones UNDER the mutex: a tombstone
 *        lifted (and the diagram re-created) between its candidate read and
 *        its transaction does not delete the re-created diagram;
 *  - I-B the repair is SCHEDULED, never inline: a slow one does not hold the
 *        reload tick;
 *  - I-D the write-head index is PARTIAL, both readers use it (EXPLAIN), it is
 *        built by the baseline on an empty table and by 0008 elsewhere, a lock
 *        wait defers it instead of failing the boot;
 *  - M-1 the ModelMeta pass re-opens, durably, a DiagramDoc whose diagram has
 *        no row and is neither tombstoned nor retired — no memory needed;
 *  - M-2 a refused pass leaves no reset and no generation (the verdict is the
 *        publish's gate, in its tail slot);
 *  - M-3 a baseline diagram whose DiagramDoc was replaced (a repair, a
 *        repoint) is not `superseded` for ever;
 *  - M-4 a baseline-listed id is not re-judged, nor the baselines re-resolved,
 *        on every tick.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema, ensureStaticMembershipHeadIndex, STATIC_MEMBERSHIP_HEAD_INDEX } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import * as projectorService from './projectorService.js'
import { vi } from 'vitest'

const CONNECTION = process.env.TEST_DATABASE_URL
const LANDSCAPE = 'ls-diagram-review2'
const VERSION = 'v1'
const WS = { landscapeId: LANDSCAPE, versionId: VERSION }

interface ShardDoc { diagrams: Record<string, { id: string; name?: string; type?: string; docUrl?: string }> }
interface DiagramDoc { id: string; name: string; type: string; objectIds: string[]; connectionIds: string[]; groupIds: string[] }
interface MetaDoc { deletedDiagramIds: string[]; groups: Record<string, never> }

describe.skipIf(!CONNECTION)('T-DIAGDEF second hardening round — the static plane', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'diagram_review2')
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`, [LANDSCAPE, VERSION],
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
  afterEach(async () => { vi.restoreAllMocks(); await projector?.stop() })

  const descriptor = (documentId: string, kind: string, entityId: string | null = null) => ({
    landscapeId: LANDSCAPE, versionId: VERSION, documentId, kind, entityId, orgId: null,
  })
  type Internal = {
    project(d: ReturnType<typeof descriptor>, h: DocHandle<unknown>): Promise<void>
    reloadDescriptors(): Promise<void>
    recoverChangedDocuments(): Promise<void>
    repairRetiredDiagramRows(): Promise<void>
    repairRetiredDiagramRowsOf(attached: unknown): Promise<void>
    retiredDiagramRowCandidates(...args: unknown[]): Promise<{ tombstoned: string[]; leftHead: string[] }>
  }
  const internal = () => projector as unknown as Internal
  const project = (handle: DocHandle<unknown>, kind: string, entityId: string | null = null) =>
    internal().project(descriptor(handle.documentId, kind, entityId), handle)
  async function owe(documentId: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = read_model_static_document_queue.revision + 1`,
      [LANDSCAPE, VERSION, documentId],
    )
  }
  async function projectMeta(handle: DocHandle<unknown>): Promise<void> {
    await owe(handle.documentId)
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
  const generation = () => count('SELECT COALESCE(max(observed_generation), 0) AS n FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2')
  async function plantRow(id: string, docUrl: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [LANDSCAPE, VERSION, id, JSON.stringify({ id, name: 'planted', type: 'context', docUrl })],
    )
  }
  async function registerMeta(deletedDiagramIds: string[]): Promise<DocHandle<MetaDoc>> {
    const meta = repo.create<MetaDoc>({ deletedDiagramIds, groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await internal().reloadDescriptors()
    await projectMeta(meta)
    return meta
  }

  // ── I-A ─────────────────────────────────────────────────────────────────
  it('I-A — a tombstone LIFTED (and the diagram re-created) between the candidate read and the transaction is not deleted', async () => {
    const meta = await registerMeta(['dg-lift'])
    const doc = diagramDoc('dg-lift', ['obj-1'])
    await plantRow('dg-lift', doc.url) // the orphan the sweep will find
    await internal().reloadDescriptors()
    // The interleaving, deterministic: right after the sweep read its
    // candidates on the pool, the user's undo lifts the tombstone and the
    // diagram is projected again.
    const original = internal().retiredDiagramRowCandidates.bind(projector)
    let interleaved = false
    vi.spyOn(internal(), 'retiredDiagramRowCandidates').mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args)
      if (!interleaved) {
        interleaved = true
        meta.change((m) => { m.deletedDiagramIds.splice(0) })
        await projectMeta(meta)
      }
      return result
    })

    await internal().repairRetiredDiagramRows()

    expect(interleaved).toBe(true)
    expect(await rows('dg-lift')).toBe(1)
  })

  // ── I-B ─────────────────────────────────────────────────────────────────
  it('I-B — a SLOW repair does not hold the reload tick', async () => {
    // A registered document, so the workspace is ATTACHED and its repair runs.
    const head = repo.create<ShardDoc>({ diagrams: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: head.documentId, kind: 'registry-shard' }])
    await projector.stop()
    projector = new StaticDeltaProjector(repo, database.pool, 1_000_000, 50)
    let repairs = 0
    let release!: () => void
    const hanging = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(internal(), 'repairRetiredDiagramRowsOf').mockImplementation(() => { repairs += 1; return hanging })
    let reloads = 0
    const reload = internal().reloadDescriptors.bind(projector)
    vi.spyOn(internal(), 'reloadDescriptors').mockImplementation(async () => { reloads += 1; await reload() })

    await projector.start()
    const atStart = reloads
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(repairs).toBeGreaterThanOrEqual(1) // the slow repair did start
    expect(reloads - atStart).toBeGreaterThanOrEqual(3)
    release()
  })

  // ── M-1 ─────────────────────────────────────────────────────────────────
  it('M-1 — the ModelMeta pass re-opens, from SQL alone, a DiagramDoc whose live diagram has no row', async () => {
    // A DiagramDoc registered for a diagram neither tombstoned nor retired,
    // whose row is absent and whose queue row says "projected" — the state a
    // lift across a restart, or a failed publish, leaves.
    const doc = diagramDoc('dg-lost', ['obj-1', 'obj-2'])
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: doc.documentId, kind: 'diagram', entityId: 'dg-lost' }])
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
       VALUES ($1, $2, $3, 3, 3) ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = 3, projected_revision = 3`,
      [LANDSCAPE, VERSION, doc.documentId],
    )
    // A FRESH projector: nothing in memory knows of any lift. The durable
    // re-open is the repair TICK's (the first one after a start), no longer
    // every ModelMeta pass's
    // (`staticDeltaProjector.diagramResurrectionReview3.integration.test.ts`).
    await registerMeta([])
    await internal().repairRetiredDiagramRows()
    const owed = await count(
      `SELECT count(*) AS n FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3 AND revision > projected_revision`, [doc.documentId],
    )
    expect(owed).toBe(1)

    await internal().reloadDescriptors()
    await internal().recoverChangedDocuments()
    for (let i = 0; i < 50 && await members('dg-lost') !== 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rows('dg-lost')).toBe(1)
    expect(await members('dg-lost')).toBe(2)

    // Idempotent: the next ModelMeta pass re-opens nothing more.
    const revision = await count(`SELECT max(revision) AS n FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [doc.documentId])
    const meta2 = repo.create<MetaDoc>({ deletedDiagramIds: [], groups: { } as Record<string, never> })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta2.documentId, kind: 'model-meta' }])
    await projectMeta(meta2)
    await internal().repairRetiredDiagramRows()
    expect(await count(`SELECT max(revision) AS n FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [doc.documentId])).toBe(revision)
  })

  it('M-1 — never a tombstoned nor a head-retired diagram', async () => {
    const tombed = diagramDoc('dg-tombed', ['obj-1'])
    const retired = diagramDoc('dg-retired', ['obj-1'])
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-retired': { id: 'dg-retired', name: 'r', docUrl: retired.url } } })
    await project(head, 'registry-shard')
    head.change((shard) => { delete shard.diagrams['dg-retired'] })
    await project(head, 'registry-shard')
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: tombed.documentId, kind: 'diagram', entityId: 'dg-tombed' }])
    await database.pool.query(`DELETE FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2`, [LANDSCAPE, VERSION])

    const meta = repo.create<MetaDoc>({ deletedDiagramIds: ['dg-tombed'], groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await internal().reloadDescriptors()
    await projectMeta(meta)
    await internal().repairRetiredDiagramRows()

    expect(await count(
      `SELECT count(*) AS n FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`, [[tombed.documentId, retired.documentId]],
    )).toBe(0)
  })

  // ── M-2 ─────────────────────────────────────────────────────────────────
  it('M-2 — the verdict is the gate: a pass the registry retires while it is queued takes no generation', async () => {
    const doc = diagramDoc('dg-gate', ['obj-1'])
    const entry = { id: 'dg-gate', name: 'g', docUrl: doc.url }
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-gate': entry } })
    await project(head, 'registry-shard')
    await project(doc, 'diagram', 'dg-gate')
    // The registry pass that retires the id is started RIGHT AFTER the
    // DiagramDoc pass's verdict said `live` (it gets up to 300 ms to commit).
    // Verdict and projection in two tail slots (the earlier design), the removal
    // commits in between and the DiagramDoc pass then publishes a generation
    // that writes nothing. Verdict as the publish's gate (M-2), the removal
    // waits behind the pass: every published generation wrote something.
    head.change((shard) => { delete shard.diagrams['dg-gate'] })
    doc.change((d) => { d.name = 'late' })
    const settle = (projector as unknown as { settleRefusedDiagramDoc: (...a: unknown[]) => Promise<unknown> })
    const original = settle.settleRefusedDiagramDoc.bind(projector)
    let removal: Promise<void> | null = null
    vi.spyOn(settle, 'settleRefusedDiagramDoc').mockImplementation(async (...args: unknown[]) => {
      const verdict = await original(...args)
      if (!removal) {
        removal = project(head, 'registry-shard')
        await Promise.race([removal, new Promise((resolve) => setTimeout(resolve, 300))])
      }
      return verdict
    })
    await project(doc, 'diagram', 'dg-gate')
    await removal

    expect(await rows('dg-gate')).toBe(0)
    // The last generation published is the one that last moved the diagram:
    // no generation published WITHOUT a write (an empty reset).
    const render = await count(
      `SELECT COALESCE(max(render_generation), 0) AS n FROM read_model_diagram_render_generations
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'dg-gate'`,
    )
    expect(render).toBe(await generation())
  })

  // ── M-3 ─────────────────────────────────────────────────────────────────
  it('M-3 — a BASELINE diagram whose DiagramDoc was replaced (repair, repoint) projects; it is not superseded for ever', async () => {
    const replaced = diagramDoc('dg-base', ['obj-1', 'obj-2'])
    // The row of a baseline diagram keeps the FROZEN baseline's docUrl (an
    // older document); no write head lists it.
    await plantRow('dg-base', 'automerge:2NQQ4T7BeECW3X5tXf6tGVgLJazr')
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: replaced.documentId, kind: 'diagram', entityId: 'dg-base' }])

    await project(replaced, 'diagram', 'dg-base')

    expect(await members('dg-base')).toBe(2)
  })

  // ── M-4 ─────────────────────────────────────────────────────────────────
  it('M-4 — a baseline-listed id is remembered: the baselines are not re-resolved on the next tick', async () => {
    const doc = diagramDoc('dg-listed', ['obj-1'])
    const head = repo.create<ShardDoc>({ diagrams: { 'dg-listed': { id: 'dg-listed', name: 'l', docUrl: doc.url } } })
    await project(head, 'registry-shard')
    head.change((shard) => { delete shard.diagrams['dg-listed'] })
    await project(head, 'registry-shard')
    await plantRow('dg-listed', doc.url)
    const baseline = repo.create<ShardDoc>({ diagrams: { 'dg-listed': { id: 'dg-listed', name: 'base', docUrl: doc.url } } })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: baseline.documentId, kind: 'registry' }])
    await internal().reloadDescriptors()
    const resolves = vi.spyOn(projectorService, 'resolveHandleWithRetry')

    await internal().repairRetiredDiagramRows()
    const first = resolves.mock.calls.length
    await internal().repairRetiredDiagramRows()
    await internal().repairRetiredDiagramRows()

    expect(first).toBeGreaterThanOrEqual(1)
    expect(resolves.mock.calls.length).toBe(first)
    expect(await rows('dg-listed')).toBe(1)

    // A baseline registered later invalidates the memo.
    const other = repo.create<ShardDoc>({ diagrams: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: other.documentId, kind: 'registry' }])
    await internal().reloadDescriptors()
    await internal().repairRetiredDiagramRows()
    expect(resolves.mock.calls.length).toBeGreaterThan(first)
  })

  // ── I-D ─────────────────────────────────────────────────────────────────
  it('I-D — the index is PARTIAL, built by the baseline on an empty table, and both readers use it', async () => {
    const { rows: indexes } = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [STATIC_MEMBERSHIP_HEAD_INDEX],
    )
    expect(indexes).toHaveLength(1)
    expect(indexes[0].indexdef).toMatch(/\(landscape_id, version_id, entity_id\) WHERE \(membership_kind = 'registry_shard_diagram'::text\)/)
    // Enough rows of OTHER kinds for the planner to prefer an index.
    await database.pool.query(
      `INSERT INTO read_model_static_membership_deltas (landscape_id, version_id, membership_kind, owner_id, entity_id, generation)
       SELECT $1, $2, 'diagram_object', 'dg-' || (n % 500), 'obj-' || n, 1 FROM generate_series(1, 20000) AS n`,
      [LANDSCAPE, VERSION],
    )
    await database.pool.query(
      `INSERT INTO read_model_static_membership_deltas (landscape_id, version_id, membership_kind, owner_id, entity_id, tombstone, generation)
       SELECT $1, $2, 'registry_shard_diagram', 'head', 'dg-' || n, n % 2 = 0, 1 FROM generate_series(1, 200) AS n`,
      [LANDSCAPE, VERSION],
    )
    await database.pool.query('ANALYZE read_model_static_membership_deltas')
    const client = await database.pool.connect()
    try {
      await client.query('SET enable_seqscan = off')
      const plans: string[] = []
      for (const sql of [
        `EXPLAIN SELECT bool_or(NOT tombstone), bool_or(tombstone) FROM read_model_static_membership_deltas
          WHERE landscape_id = $1 AND version_id = $2 AND membership_kind = 'registry_shard_diagram' AND entity_id = 'dg-7'`,
        `EXPLAIN SELECT membership.entity_id FROM read_model_static_membership_deltas membership
          WHERE membership.landscape_id = $1 AND membership.version_id = $2
            AND membership.membership_kind = 'registry_shard_diagram'
          GROUP BY membership.entity_id HAVING bool_and(membership.tombstone)`,
      ]) {
        const { rows: plan } = await client.query<{ 'QUERY PLAN': string }>(sql, [LANDSCAPE, VERSION])
        plans.push(plan.map((row) => row['QUERY PLAN']).join('\n'))
      }
      console.log(JSON.stringify({ event: 'tdiagdef.review2_explain', plans }))
      // The per-diagram verdict needs the partial index: the primary key
      // (…, membership_kind, owner_id, entity_id, …) cannot reach an entity
      // without its owner.
      expect(plans[0]).toContain(`Index Scan using ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
      // The sweep's GROUP BY is bounded to the HEAD rows either way: by the
      // partial index, or — what the planner picks here — by the primary key's
      // (landscape_id, version_id, membership_kind) prefix. Never every
      // membership of the workspace.
      expect(plans[1]).toMatch(new RegExp(
        `${STATIC_MEMBERSHIP_HEAD_INDEX}|Index Cond: \\(\\(landscape_id = [^)]*\\) AND \\(version_id = [^)]*\\) AND \\(membership_kind = 'registry_shard_diagram'::text\\)\\)`,
      ))
      expect(plans[1]).not.toContain('Seq Scan')
    } finally {
      await client.query('RESET enable_seqscan').catch(() => undefined)
      client.release()
    }
  })

  it('I-D — 0008 rebuilds a LOST index, drops the first version\'s full one, and DEFERS on a lock wait instead of failing', async () => {
    const client = await database.pool.connect()
    const holder = await database.pool.connect()
    try {
      await client.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_membership_deltas_entity
        ON read_model_static_membership_deltas (landscape_id, version_id, membership_kind, entity_id)`)
      expect((await ensureStaticMembershipHeadIndex(client)).deferred).toEqual([])
      const { rows: names } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'idx_read_model_static_membership_deltas_%'`,
      )
      expect(names.map((row) => row.indexname)).toContain(STATIC_MEMBERSHIP_HEAD_INDEX)
      expect(names.map((row) => row.indexname)).not.toContain('idx_read_model_static_membership_deltas_entity')

      // A transaction holding a conflicting lock: the build waits at most
      // its bound, retries, then defers — the boot is not failed.
      await client.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE read_model_static_membership_deltas IN SHARE ROW EXCLUSIVE MODE')
      const lines: string[] = []
      const outcome = await ensureStaticMembershipHeadIndex(client, { attempts: 2, retryMs: 10, log: (line) => lines.push(line) })
      expect(outcome.deferred).toEqual([STATIC_MEMBERSHIP_HEAD_INDEX])
      expect(lines.some((line) => line.includes('read_model.static_membership_index_deferred'))).toBe(true)
      await holder.query('ROLLBACK')
      expect((await ensureStaticMembershipHeadIndex(client)).deferred).toEqual([])
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      client.release()
    }
  }, 30_000)
})
