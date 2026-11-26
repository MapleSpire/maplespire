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
 * T-DIAGDEF, the re-open of unprojected DiagramDocs on the static plane:
 *
 *  - the durable re-open of unprojected DiagramDocs runs on the FIRST repair
 *    tick of a workspace after a start, then at most every
 *    `unprojectedReopenIntervalMs` — no longer on every tick (10 s);
 *  - a registered DiagramDoc whose Automerge document is MISSING (no durable
 *    content, not resident) and whose row is absent is not re-opened: before,
 *    it was made owed for good, and every reload tick then spent ~1.25 s
 *    failing to resolve it (five tries, 250 ms apart) and logged an error —
 *    while catching-up, the certificates and `absenceProvable` must not move.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { getWorkspaceProjectionFreshness } from './health.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const LANDSCAPE = 'ls-diagram-review4'
const VERSION = 'v1'
const WS = { landscapeId: LANDSCAPE, versionId: VERSION }

interface DiagramDoc { id: string; name: string; type: string; objectIds: string[]; connectionIds: string[]; groupIds: string[] }
interface MetaDoc { deletedDiagramIds: string[]; groups: Record<string, never> }

describe.skipIf(!CONNECTION)('T-DIAGDEF — the re-open of unprojected DiagramDocs', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'diagram_review4')
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
      'ro_diagrams', 'ro_diagram_summaries', 'ro_diagram_objects', 'read_model_static_documents',
      'read_model_static_membership_deltas', 'read_model_static_document_queue', 'read_model_change_events',
      'read_model_projection_state', 'read_model_document_watermarks', 'read_model_static_workspaces',
      'automerge_document_workspace',
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
    unprojectedDiagramIds(...args: unknown[]): Promise<string[]>
    unprojectedReopenIntervalMs: number
  }
  const internal = () => projector as unknown as Internal
  async function owe(documentId: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = read_model_static_document_queue.revision + 1`,
      [LANDSCAPE, VERSION, documentId],
    )
  }
  async function registerMeta(deletedDiagramIds: string[]): Promise<DocHandle<MetaDoc>> {
    const meta = repo.create<MetaDoc>({ deletedDiagramIds, groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await internal().reloadDescriptors()
    await owe(meta.documentId)
    await internal().project(descriptor(meta.documentId, 'model-meta'), meta)
    // T-ZEROWM-4: and the ModelMeta pass its `attach` started during the call
    // above (the pass's scan attaches the ModelMeta itself), which runs AFTER
    // it now — one pass of a document at a time. Its own scan attaches every
    // resident document: run later than a DiagramDoc made below, it attached
    // that one too, and the re-open's commit hook then re-ran its pass, which
    // projected it — the walk below had nothing left to find. A microtask
    // decided which came first (red 10/10 and green on two versions one
    // await apart): so the DiagramDocs are made once that pass has settled.
    const inFlight = (projector as unknown as { inFlightRuns: Set<Promise<void>> }).inFlightRuns
    while (inFlight.size) await Promise.allSettled([...inFlight])
    return meta
  }
  /** A DiagramDoc registered, its queue row "projected", its row absent —
   * the state a lift across a restart, or a failed publish, leaves. */
  async function registerLost(documentId: string, entityId: string): Promise<void> {
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId, kind: 'diagram', entityId }])
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
       VALUES ($1, $2, $3, 3, 3) ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = 3, projected_revision = 3`,
      [LANDSCAPE, VERSION, documentId],
    )
  }
  const owed = async (documentId: string): Promise<boolean> => (await database.pool.query<{ owed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM read_model_static_document_queue
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3 AND revision > projected_revision) AS owed`,
    [LANDSCAPE, VERSION, documentId],
  )).rows[0]!.owed

  it('the walk runs on the first tick after a start, then only past its interval', async () => {
    await registerMeta([])
    const lost = repo.create<DiagramDoc>({ id: 'dg-lost', name: 'lost', type: 'context', objectIds: [], connectionIds: [], groupIds: [] })
    await registerLost(lost.documentId, 'dg-lost')
    await internal().reloadDescriptors()
    const walk = vi.spyOn(projector as unknown as Internal, 'unprojectedDiagramIds')

    await internal().repairRetiredDiagramRows() // the first tick: walked, re-opened
    const firstTick = walk.mock.calls.length // the pool read, then its re-read under the mutex
    expect(firstTick).toBeGreaterThan(0)
    expect(await owed(lost.documentId)).toBe(true)
    // Projected again, so the walk WOULD find it again.
    await database.pool.query(
      `UPDATE read_model_static_document_queue SET projected_revision = revision
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [LANDSCAPE, VERSION, lost.documentId])
    await internal().repairRetiredDiagramRows()
    await internal().repairRetiredDiagramRows()
    expect(walk).toHaveBeenCalledTimes(firstTick) // before: walked on every tick (every 10 s)
    expect(await owed(lost.documentId)).toBe(false)

    internal().unprojectedReopenIntervalMs = 0 // the interval has passed
    await internal().repairRetiredDiagramRows()
    expect(walk.mock.calls.length).toBeGreaterThan(firstTick)
    expect(await owed(lost.documentId)).toBe(true)
  })

  it('a DiagramDoc whose document is MISSING is not made owed; recovery, freshness and certificates do not move', async () => {
    await registerMeta([])
    // A document id nothing holds: neither this Repo nor the storage.
    const missing = new Repo({ network: [] }).create<DiagramDoc>({
      id: 'dg-missing', name: 'missing', type: 'context', objectIds: [], connectionIds: [], groupIds: [],
    }).documentId
    await registerLost(missing, 'dg-missing')
    await internal().reloadDescriptors()
    // The ModelMeta pass's generation settled first (its publish is followed
    // by deferred work): the state compared below is a quiet one.
    let freshnessBefore = await getWorkspaceProjectionFreshness(database.pool, WS)
    for (let i = 0; i < 60 && freshnessBefore.status !== 'healthy'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      freshnessBefore = await getWorkspaceProjectionFreshness(database.pool, WS)
    }
    expect(freshnessBefore.status).toBe('healthy')
    const zeroBefore = projector.zeroCertificateSweepSnapshot()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await internal().repairRetiredDiagramRows()
    expect(await owed(missing)).toBe(false) // before: owed for good

    const startedAt = performance.now()
    await internal().recoverChangedDocuments()
    const recoveryMs = performance.now() - startedAt
    console.log(JSON.stringify({ event: 'tdiagdef.missing_diagram_doc_recovery', recoveryMs: Math.round(recoveryMs), errors: errors.mock.calls.length }))
    expect(recoveryMs).toBeLessThan(500) // before: ~1.25 s per such document, per tick
    expect(errors).not.toHaveBeenCalled()

    expect(await getWorkspaceProjectionFreshness(database.pool, WS)).toEqual(freshnessBefore)
    expect(projector.zeroCertificateSweepSnapshot()).toEqual(zeroBefore)
    const { rows: certificates } = await database.pool.query(
      `SELECT document_id, projected_watermark FROM read_model_document_watermarks
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [LANDSCAPE, VERSION, missing])
    expect(certificates).toEqual([])
  })

  it('control: the same DiagramDoc, PRESENT in storage but not resident, is re-opened', async () => {
    await registerMeta([])
    const other = new Repo({ network: [] })
    const present = other.create<DiagramDoc>({ id: 'dg-present', name: 'p', type: 'context', objectIds: [], connectionIds: [], groupIds: [] })
    await database.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, '\\x00'::bytea)`, [`${present.documentId}/snapshot/x`],
    )
    try {
      await registerLost(present.documentId, 'dg-present')
      await internal().reloadDescriptors()
      await internal().repairRetiredDiagramRows()
      expect(await owed(present.documentId)).toBe(true)
    } finally {
      await database.pool.query(`DELETE FROM automerge_storage WHERE key = $1`, [`${present.documentId}/snapshot/x`])
    }
  })
})
