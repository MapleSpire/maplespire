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

import type { Pool } from 'pg'
import type { ConnectionInput, DiagramInput, ObjectInput } from '../readModel/types.js'
import {
  upsertConnections,
  upsertDiagrams,
  upsertObjects,
  insertDiagramFlowIndex,
  type FlowIndexInput,
  type WorkspaceKey,
} from '../readModel/projector.js'
import { markStaticReadModelWorkspace } from '../readModel/staticWorkspace.js'
import { rebuildReadModelDerivedStats, upsertDecisionRecords } from '../readModel/derivedStats.js'
import type { PerformanceSeedPlan } from './generator.js'
import type { PerformanceWorkspaceResult } from './workspace.js'

const ENTITY_BATCH = 1_000
const DIAGRAM_BATCH = 100
const POSTING_BATCH = 5_000

export interface PerformanceReadModelProgress {
  phase: 'read_model_objects' | 'read_model_connections' | 'read_model_decision_records' | 'read_model_diagrams'
  completed: number
  total: number
  message: string
}

export interface MaterializePerformanceReadModelOptions {
  db: Pool
  key: WorkspaceKey
  orgId: string
  plan: PerformanceSeedPlan
  /** Diagram-document URLs ordered by the plan's zero-based diagram index. */
  diagramDocumentUrls: readonly string[]
  /** Core Automerge documents required by the server-paged client boot. */
  staticDocumentUrls?: readonly { url: string; kind: string }[]
  onProgress?: (progress: PerformanceReadModelProgress) => void
}

export function performanceEditableDocuments(
  coreDocuments: readonly { url: string; kind: string }[],
  diagramDocumentUrls: readonly string[],
  diagramIds: readonly string[] = [],
): { documentId: string; kind: string; entityId?: string }[] {
  const documents = new Map<string, { kind: string; entityId?: string }>()
  for (const document of coreDocuments) {
    documents.set(document.url.replace(/^automerge:/, ''), { kind: document.kind })
  }
  for (const [index, url] of diagramDocumentUrls.entries()) {
    documents.set(url.replace(/^automerge:/, ''), {
      kind: 'diagram',
      ...(diagramIds[index] ? { entityId: diagramIds[index] } : {}),
    })
  }
  return [...documents].map(([documentId, value]) => ({ documentId, ...value }))
}

/**
 * Complete transport/GC manifest for a static performance workspace.
 *
 * Base shards stay lazy: the storage adapter only queues mutable kinds for
 * projection. They must still be authorized on explicit client request and
 * retained by global GC, otherwise an editable (non boot-from-server) client
 * fails with "Document unavailable" while materializing the model.
 */
export function performanceWorkspaceTransportDocuments(
  workspace: PerformanceWorkspaceResult,
): { url: string; kind: string }[] {
  const without = (urls: readonly string[], excluded: string) => urls.filter((url) => url !== excluded)
  return [
    { url: workspace.rootUrl, kind: 'root' },
    { url: workspace.modelUrl, kind: 'model-legacy' },
    { url: workspace.modelMetaUrl, kind: 'model-meta' },
    ...without(workspace.objectShardUrls, workspace.objectOverlayUrl)
      .map((url) => ({ url, kind: 'object-base' })),
    { url: workspace.objectOverlayUrl, kind: 'object-overlay' },
    ...without(workspace.connectionShardUrls, workspace.connectionOverlayUrl)
      .map((url) => ({ url, kind: 'connection-base' })),
    { url: workspace.connectionOverlayUrl, kind: 'connection-overlay' },
    ...workspace.decisionRecordShardUrls.map((url) => ({ url, kind: 'decision-record-base' })),
    ...without(workspace.registryShardUrls, workspace.registryWriteUrl)
      .map((url) => ({ url, kind: 'registry' })),
    // The write head is NOT baseline. The baseline write fence
    // (`isBaselineDocumentKind`, rbac/docScope.ts) drops inbound mutations of
    // every 'registry'-kind document, so labelling the write head 'registry'
    // would freeze diagram creation/rename. 'registry-shard' is the writable
    // kind, the same label other producers give their write heads.
    { url: workspace.registryWriteUrl, kind: 'registry-shard' },
  ]
}

async function clearWorkspace(db: Pool, key: WorkspaceKey): Promise<void> {
  const client = await db.connect()
  const params = [key.landscapeId, key.versionId]
  const tables = [
    'ro_diagram_summaries', 'ro_connection_stats', 'ro_object_child_stats', 'ro_workspace_stats',
    'read_model_diagram_render_generations',
    'ro_object_technologies', 'ro_group_technologies', 'ro_object_tags', 'ro_group_tags',
    'ro_object_teams', 'ro_group_objects', 'ro_diagram_objects', 'ro_diagram_groups',
    'ro_diagram_connections', 'ro_connection_flows',
    'ro_flows', 'ro_flow_objects', 'ro_diagram_flow_index', 'ro_objects', 'ro_connections',
    'ro_groups', 'ro_diagrams', 'ro_decision_records',
  ]
  let rollbackFailure: Error | true | undefined
  try {
    await client.query('BEGIN')
    // Delete the workspace row FIRST. `assertReadModelPlane` takes
    // `FOR KEY SHARE` on it, and a static publish holds that row for its whole
    // transaction before writing `ro_*`. Deleting `ro_*` first would deadlock
    // (ABBA) against a resident static projector when re-seeding a fixture.
    // Global lock order: `read_model_static_workspaces` →
    // `automerge_document_workspace` → `read_model_static_documents` →
    // `read_model_projection_state`.
    //
    // This DELETE cascades to `read_model_static_documents` via
    // `read_model_static_documents_workspace_fk`; the re-mark re-inserts the
    // allow-list afterwards.
    await client.query(
      'DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
      params,
    )
    for (const table of tables) {
      await client.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, params)
    }
    await client.query('COMMIT')
  } catch (error) {
    // If ROLLBACK itself fails, release WITH that failure so the pool destroys
    // the connection. A client returned still inside its transaction hands its
    // row locks — including the `read_model_static_workspaces` row every
    // projection key-shares — to the next borrower, wedging every projection
    // of that workspace behind a lock with no visible holder.
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rollbackFailure = rollbackError instanceof Error ? rollbackError : true
    })
    throw error
  } finally {
    client.release(rollbackFailure)
  }
}

async function insertMembershipRows(
  db: Pool,
  table: 'ro_diagram_objects' | 'ro_diagram_connections' | 'ro_connection_flows',
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += POSTING_BATCH) {
    const batch = rows.slice(offset, offset + POSTING_BATCH)
    if (table === 'ro_diagram_objects') {
      await db.query(
        `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
         SELECT landscape_id, version_id, org_id, diagram_id, object_id
         FROM jsonb_to_recordset($1::jsonb) AS x(
           landscape_id text, version_id text, org_id text, diagram_id text, object_id text
         ) ON CONFLICT DO NOTHING`,
        [JSON.stringify(batch)],
      )
    } else if (table === 'ro_diagram_connections') {
      await db.query(
        `INSERT INTO ro_diagram_connections (landscape_id, version_id, org_id, diagram_id, connection_id)
         SELECT landscape_id, version_id, org_id, diagram_id, connection_id
         FROM jsonb_to_recordset($1::jsonb) AS x(
           landscape_id text, version_id text, org_id text, diagram_id text, connection_id text
         ) ON CONFLICT DO NOTHING`,
        [JSON.stringify(batch)],
      )
    } else {
      await db.query(
        `INSERT INTO ro_connection_flows (
           landscape_id, version_id, org_id, diagram_id, flow_id, connection_id
         )
         SELECT landscape_id, version_id, org_id, diagram_id, flow_id, connection_id
         FROM jsonb_to_recordset($1::jsonb) AS x(
           landscape_id text, version_id text, org_id text, diagram_id text,
           flow_id text, connection_id text
         ) ON CONFLICT DO NOTHING`,
        [JSON.stringify(batch)],
      )
    }
  }
}

export function performanceDiagramRecord(plan: PerformanceSeedPlan, index: number, docUrl: string): DiagramInput {
  const diagram = plan.diagramAt(index)
  return {
    ...diagram,
    docUrl,
  }
}

export async function materializePerformanceDecisionRecords(
  db: Pool,
  key: WorkspaceKey,
  orgId: string,
  plan: PerformanceSeedPlan,
  onProgress?: (progress: PerformanceReadModelProgress) => void,
): Promise<void> {
  await db.query(
    'DELETE FROM ro_decision_records WHERE landscape_id = $1 AND version_id = $2',
    [key.landscapeId, key.versionId],
  )
  await db.query(
    `UPDATE ro_workspace_stats SET decision_record_count = 0, updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  for (let start = 0; start < plan.scale.decisionRecords; start += ENTITY_BATCH) {
    const count = Math.min(ENTITY_BATCH, plan.scale.decisionRecords - start)
    const rows = Array.from({ length: count }, (_, offset) => plan.decisionRecordAt(start + offset))
    await upsertDecisionRecords(db, key, orgId, rows)
    const completed = start + count
    onProgress?.({
      phase: 'read_model_decision_records', completed, total: plan.scale.decisionRecords,
      message: `read-model ADRs: ${completed.toLocaleString('en-CA')} / ${plan.scale.decisionRecords.toLocaleString('en-CA')}`,
    })
  }
}

export async function materializePerformanceDiagramData(
  db: Pool,
  key: WorkspaceKey,
  orgId: string,
  plan: PerformanceSeedPlan,
  diagramDocumentUrls: readonly string[],
  onProgress?: (progress: PerformanceReadModelProgress) => void,
): Promise<void> {
  if (diagramDocumentUrls.length !== plan.diagramCount) {
    throw new Error(`Expected ${plan.diagramCount} diagram document URLs; got ${diagramDocumentUrls.length}`)
  }
  for (let start = 0; start < plan.diagramCount; start += DIAGRAM_BATCH) {
    const count = Math.min(DIAGRAM_BATCH, plan.diagramCount - start)
    const diagrams = Array.from({ length: count }, (_, offset) =>
      performanceDiagramRecord(plan, start + offset, diagramDocumentUrls[start + offset]))
    await upsertDiagrams(db, key, orgId, diagrams)
    const completed = start + count
    onProgress?.({
      phase: 'read_model_diagrams', completed, total: plan.diagramCount,
      message: `read-model diagrams: ${completed.toLocaleString('en-CA')} / ${plan.diagramCount.toLocaleString('en-CA')}`,
    })
  }
}

/**
 * Stream a deterministic performance plan into the relational read model. The
 * benchmark remains fully represented in Automerge, but interactive reads never
 * need to materialize all source shards in one process.
 */
export async function materializePerformanceReadModel(
  options: MaterializePerformanceReadModelOptions,
): Promise<void> {
  const { db, key, orgId, plan, diagramDocumentUrls, staticDocumentUrls = [], onProgress } = options
  if (diagramDocumentUrls.length !== plan.diagramCount) {
    throw new Error(`Expected ${plan.diagramCount} diagram document URLs; got ${diagramDocumentUrls.length}`)
  }
  await clearWorkspace(db, key)

  for (let start = 0; start < plan.scale.objects; start += ENTITY_BATCH) {
    const count = Math.min(ENTITY_BATCH, plan.scale.objects - start)
    const objects = Array.from({ length: count }, (_, offset) => plan.objectAt(start + offset))
    await upsertObjects(db, key, orgId, objects as unknown as ObjectInput[])
    const completed = start + count
    onProgress?.({
      phase: 'read_model_objects', completed, total: plan.scale.objects,
      message: `read-model objects: ${completed.toLocaleString('en-CA')} / ${plan.scale.objects.toLocaleString('en-CA')}`,
    })
  }
  // Some children are inserted before their parent batch. Refresh the complete
  // hierarchy once after all objects are present.
  await db.query(
    `UPDATE ro_objects object SET effective_parent_id = CASE WHEN EXISTS (
       SELECT 1 FROM ro_objects parent
       WHERE parent.landscape_id = object.landscape_id
         AND parent.version_id = object.version_id AND parent.id = object.parent_id
     ) THEN object.parent_id ELSE NULL END,
     c4_parent_id = CASE WHEN EXISTS (
       SELECT 1 FROM ro_objects parent
       WHERE parent.landscape_id = object.landscape_id
         AND parent.version_id = object.version_id AND parent.id = object.parent_id
     ) THEN object.parent_id ELSE NULL END
     WHERE object.landscape_id = $1 AND object.version_id = $2`,
    [key.landscapeId, key.versionId],
  )

  for (let start = 0; start < plan.scale.connections; start += ENTITY_BATCH) {
    const count = Math.min(ENTITY_BATCH, plan.scale.connections - start)
    const connections = Array.from({ length: count }, (_, offset) => plan.connectionAt(start + offset))
    await upsertConnections(db, key, orgId, connections as unknown as ConnectionInput[])
    const completed = start + count
    onProgress?.({
      phase: 'read_model_connections', completed, total: plan.scale.connections,
      message: `read-model connections: ${completed.toLocaleString('en-CA')} / ${plan.scale.connections.toLocaleString('en-CA')}`,
    })
  }

  await materializePerformanceDecisionRecords(db, key, orgId, plan, onProgress)

  for (let start = 0; start < plan.diagramCount; start += DIAGRAM_BATCH) {
    const count = Math.min(DIAGRAM_BATCH, plan.diagramCount - start)
    const diagrams = Array.from({ length: count }, (_, offset) =>
      performanceDiagramRecord(plan, start + offset, diagramDocumentUrls[start + offset]))
    await upsertDiagrams(db, key, orgId, diagrams)

    const objectRows: Record<string, unknown>[] = []
    const connectionRows: Record<string, unknown>[] = []
    const flowRows: Record<string, unknown>[] = []
    const flowIndexEntries: Array<{ diagramId: string; flows: FlowIndexInput[] }> = []
    for (let offset = 0; offset < count; offset += 1) {
      const index = start + offset
      const full = plan.diagramAt(index)
      const common = {
        landscape_id: key.landscapeId,
        version_id: key.versionId,
        org_id: orgId,
        diagram_id: full.id,
      }
      for (const object_id of new Set(full.objectIds)) objectRows.push({ ...common, object_id })
      for (const connection_id of new Set(full.connectionIds)) connectionRows.push({ ...common, connection_id })
      for (const flow of Object.values(full.flows)) {
        for (const connection_id of new Set((flow.steps ?? []).flatMap((step) => step.connectionId ? [step.connectionId] : []))) {
          flowRows.push({ ...common, flow_id: flow.id, connection_id })
        }
      }
      flowIndexEntries.push({ diagramId: full.id, flows: Object.values(full.flows) })
    }
    await insertMembershipRows(db, 'ro_diagram_objects', objectRows)
    await insertMembershipRows(db, 'ro_diagram_connections', connectionRows)
    await insertMembershipRows(db, 'ro_connection_flows', flowRows)
    // Flow names, object postings and the coverage witness, from the same
    // `full.flows` — without them every seeded diagram reads as unindexed and
    // the panel could only ever say "at least N flows" on this workspace.
    await insertDiagramFlowIndex(db, key, orgId, flowIndexEntries)
    const completed = start + count
    onProgress?.({
      phase: 'read_model_diagrams', completed, total: plan.diagramCount,
      message: `read-model diagrams: ${completed.toLocaleString('en-CA')} / ${plan.diagramCount.toLocaleString('en-CA')}`,
    })
  }

  // One authoritative set-based pass after the streamed writes. Incremental
  // maintenance keeps subsequent edits bounded; the seed itself avoids 30k
  // repeated count refreshes while memberships are still being loaded.
  await rebuildReadModelDerivedStats(db, key, orgId)

  await db.query(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, observed_generation, projected_generation,
       last_projected_at, last_duration_ms, projector_attached, last_projection_kind
     ) VALUES ($1, $2, $3, 1, 1, now(), 0, false, 'cold_build')
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = EXCLUDED.org_id,
       observed_generation = 1,
       projected_generation = 1,
       last_projected_at = now(),
       last_duration_ms = 0,
       last_error_at = NULL,
       last_error_generation = NULL,
       last_error_code = NULL,
       consecutive_failures = 0,
       -- The seed asserts a freshly, fully projected workspace, so the degraded
       -- triple has to go with the error triple above. It used to be omitted,
       -- and the residue was invisible three ways at once: the row reads idle
       -- (projector_attached = false outranks degraded in the status ladder),
       -- so no gauge or alert names it; nothing re-derives a mark, so no
       -- projector retracts it; and the next attach flips the fixture to
       -- degraded, carrying an error code from a workspace state that no longer
       -- exists.
       degraded_since = NULL,
       degraded_kind = NULL,
       degraded_error_code = NULL,
       projector_attached = false,
       projector_instance_id = NULL,
       last_projection_kind = 'cold_build',
       updated_at = now()`,
    [key.landscapeId, key.versionId, orgId],
  )
  await markStaticReadModelWorkspace(
    db,
    key,
    'performance-seed-editable',
    performanceEditableDocuments(
      staticDocumentUrls,
      diagramDocumentUrls,
      diagramDocumentUrls.map((_, index) => plan.diagramAt(index).id),
    ),
  )
}
