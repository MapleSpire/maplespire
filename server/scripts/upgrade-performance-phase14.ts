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
 * Upgrade an existing editable performance workspace with the Phase-14
 * adversarial fixtures without regenerating 30,000 DiagramDocs.
 *
 * Safety contract:
 * - stop the API/sync cell before running;
 * - create + flush + admit the dense child before publishing it in ModelMeta;
 * - keep the original 300k reference connections untouched and append 20k
 *   dedicated connections for one 500-shape Canvas;
 * - update the static relational baseline in bounded, idempotent batches;
 * - never publish a partially written read model generation.
 */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import type { PoolClient } from 'pg'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../src/modelMeta.js'
import { preparePerformanceCatalog } from '../src/performanceSeed/catalog.js'
import { PerformanceSeedPlan } from '../src/performanceSeed/generator.js'
import { performanceTeamIds, seedPerformancePrincipals } from '../src/performanceSeed/principals.js'
import { performanceDiagramRecord } from '../src/performanceSeed/readModel.js'
import { FULL_PERFORMANCE_SEED_SCALE, type PerformanceConnection } from '../src/performanceSeed/types.js'
import { rebuildReadModelDerivedStats } from '../src/readModel/derivedStats.js'
import {
  connectionToRow,
  objectTagRows,
  objectTeamRows,
  objectTechnologyRows,
  objectToRow,
  type WorkspaceKey,
} from '../src/readModel/projector.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { registerStaticReadModelDocuments } from '../src/readModel/staticWorkspace.js'
import { synchronizeOverlaySegments } from '../src/readModel/overlayHistoryStore.js'
import type { ConnectionInput, DiagramInput, ObjectInput } from '../src/readModel/types.js'

const OBJECT_BATCH = 1_000
const CONNECTION_BATCH = 1_000
const PHASE14_SCHEMA = 1

interface RootLike {
  modelMetaUrl?: string
}

interface Phase14FixtureMarker {
  schema: number
  diagramId: string
  connectionStart: number
  connectionCount: number
}

interface ConnectionOverlayLike {
  connections: Record<string, PerformanceConnection>
  writeBatchIds?: string[]
  writeHeadVersion?: number
  phase14Fixture?: Phase14FixtureMarker
}

interface MetaLike {
  staticBaseline?: boolean
  connectionShardUrls?: string[]
  editsConnectionShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsOverlayWriteHeadVersion?: number
}

interface DiagramDocLike extends Record<string, unknown> {
  name?: string
  type?: string
  description?: string
  domainId?: string
  parentObjectId?: string
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  layouts?: Record<string, unknown>
  comments?: Record<string, unknown>
  flows?: Record<string, unknown>
  connectionHighlightStyle?: string
  connectionAnimationsEnabled?: boolean
  defaultConnectionShape?: string
  skinId?: string
  checkpoints?: unknown[]
  phase14Fixture?: Phase14FixtureMarker
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

const documentIdOf = (url: string): string => url.replace(/^automerge:/, '').split('?')[0]
const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))]
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function resolve<T>(repo: Repo, url: string): Promise<DocHandle<T>> {
  if (!isValidAutomergeUrl(url)) throw new Error(`Invalid Automerge URL: ${url}`)
  const handle = await repo.find<T>(url as AutomergeUrl)
  await handle.whenReady()
  if (!handle.doc()) throw new Error(`Automerge document unavailable: ${url}`)
  return handle
}

function markerMatches(
  marker: Phase14FixtureMarker | undefined,
  expected: Phase14FixtureMarker,
): boolean {
  return marker?.schema === expected.schema
    && marker.diagramId === expected.diagramId
    && marker.connectionStart === expected.connectionStart
    && marker.connectionCount === expected.connectionCount
}

async function assertApiStopped(key: WorkspaceKey): Promise<void> {
  const result = await pool.query<{ active: string }>(
    `SELECT count(*)::text AS active
     FROM sync_workspace_ownership
     WHERE landscape_id = $1 AND version_id = $2
       AND released_at IS NULL AND lease_observed_expires_at > now()`,
    [key.landscapeId, key.versionId],
  )
  if (Number(result.rows[0]?.active ?? 0) > 0) {
    throw new Error('The target sync cell still owns this workspace; stop the API and wait for lease release')
  }
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function updateGovernedObjectBatch(
  key: WorkspaceKey,
  orgId: string,
  objects: ObjectInput[],
): Promise<void> {
  const objectRows = objects.map((object) => objectToRow(key, orgId, object))
  const tagRows = objects.flatMap((object) => objectTagRows(key, orgId, object))
  const technologyRows = objects.flatMap((object) => objectTechnologyRows(key, orgId, object))
  const teamRows = objects.flatMap((object) => objectTeamRows(key, orgId, object))
  await withTransaction(async (client) => {
    const updated = await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($3::jsonb) AS row(
           id text, type text, name text, description text, technology text,
           domain_id text, parent_id text, effective_parent_id text,
           scope text, status text, data jsonb
         )
       )
       UPDATE ro_objects object SET
         type = input.type, name = input.name, description = input.description,
         technology = input.technology, domain_id = input.domain_id,
         parent_id = input.parent_id, effective_parent_id = input.effective_parent_id,
         scope = input.scope, status = input.status, data = input.data
       FROM input
       WHERE object.landscape_id = $1 AND object.version_id = $2
         AND object.id = input.id`,
      [key.landscapeId, key.versionId, JSON.stringify(objectRows)],
    )
    if (updated.rowCount !== objects.length) {
      throw new Error(`Governance batch updated ${updated.rowCount}/${objects.length} expected objects`)
    }
    const objectIds = objects.map((object) => object.id)
    await client.query(
      `DELETE FROM ro_object_tags
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
      [key.landscapeId, key.versionId, objectIds],
    )
    await client.query(
      `DELETE FROM ro_object_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
      [key.landscapeId, key.versionId, objectIds],
    )
    await client.query(
      `DELETE FROM ro_object_teams
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
      [key.landscapeId, key.versionId, objectIds],
    )
    if (tagRows.length) {
      await client.query(
        `INSERT INTO ro_object_tags (
           landscape_id, version_id, org_id, object_id, tag_id, ordinal
         )
         SELECT landscape_id, version_id, org_id, object_id, tag_id, ordinal
         FROM jsonb_to_recordset($1::jsonb) AS row(
           landscape_id text, version_id text, org_id text, object_id text,
           tag_id text, ordinal integer
         )`,
        [JSON.stringify(tagRows)],
      )
    }
    if (technologyRows.length) {
      await client.query(
        `INSERT INTO ro_object_technologies (
           landscape_id, version_id, org_id, object_id, usage_id,
           technology_id, catalog_revision, used_version, role, snapshot
         )
         SELECT landscape_id, version_id, org_id, object_id, usage_id,
                technology_id, catalog_revision, used_version, role, snapshot
         FROM jsonb_to_recordset($1::jsonb) AS row(
           landscape_id text, version_id text, org_id text, object_id text,
           usage_id text, technology_id text, catalog_revision integer,
           used_version text, role text, snapshot jsonb
         )`,
        [JSON.stringify(technologyRows)],
      )
    }
    if (teamRows.length) {
      await client.query(
        `INSERT INTO ro_object_teams (
           landscape_id, version_id, org_id, object_id, team_id
         )
         SELECT landscape_id, version_id, org_id, object_id, team_id
         FROM jsonb_to_recordset($1::jsonb) AS row(
           landscape_id text, version_id text, org_id text, object_id text, team_id text
         )`,
        [JSON.stringify(teamRows)],
      )
    }
  })
}

async function upsertDenseConnectionBatch(
  key: WorkspaceKey,
  orgId: string,
  connections: ConnectionInput[],
): Promise<void> {
  const rows = connections.map((connection) => connectionToRow(key, orgId, connection))
  await pool.query(
    `INSERT INTO ro_connections (
       landscape_id, version_id, org_id, id, from_id, to_id, label, kind, data
     )
     SELECT landscape_id, version_id, org_id, id, from_id, to_id, label, kind, data
     FROM jsonb_to_recordset($1::jsonb) AS row(
       landscape_id text, version_id text, org_id text, id text,
       from_id text, to_id text, label text, kind text, data jsonb
     )
     ON CONFLICT (landscape_id, version_id, id) DO UPDATE SET
       org_id = EXCLUDED.org_id, from_id = EXCLUDED.from_id, to_id = EXCLUDED.to_id,
       label = EXCLUDED.label, kind = EXCLUDED.kind, data = EXCLUDED.data`,
    [JSON.stringify(rows)],
  )
}

async function updateDenseDiagramReadModel(
  key: WorkspaceKey,
  orgId: string,
  diagram: DiagramInput,
): Promise<void> {
  const objectIds = [...new Set(diagram.objectIds ?? [])]
  const connectionIds = [...new Set(diagram.connectionIds ?? [])]
  const flowRows = Object.values((diagram.flows ?? {}) as Record<string, { id: string; steps?: Array<{ connectionId?: string }> }>)
    .flatMap((flow) => [...new Set((flow.steps ?? []).flatMap((step) => step.connectionId ? [step.connectionId] : []))]
      .map((connectionId) => ({
        landscape_id: key.landscapeId,
        version_id: key.versionId,
        org_id: orgId,
        diagram_id: diagram.id,
        flow_id: flow.id,
        connection_id: connectionId,
      })))
  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE ro_diagrams SET
         org_id = $3, parent_object_id = $4, object_ids = $5, data = $6::jsonb
       WHERE landscape_id = $1 AND version_id = $2 AND id = $7`,
      [key.landscapeId, key.versionId, orgId, diagram.parentObjectId ?? null,
        objectIds, JSON.stringify(diagram), diagram.id],
    )
    if (updated.rowCount !== 1) throw new Error(`Dense diagram ${diagram.id} is missing from the read model`)
    await client.query(
      `DELETE FROM ro_diagram_objects
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagram.id],
    )
    await client.query(
      `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
       SELECT $1, $2, $3, $4, object_id FROM unnest($5::text[]) AS object_id`,
      [key.landscapeId, key.versionId, orgId, diagram.id, objectIds],
    )
    await client.query(
      `DELETE FROM ro_diagram_connections
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagram.id],
    )
    await client.query(
      `INSERT INTO ro_diagram_connections (
         landscape_id, version_id, org_id, diagram_id, connection_id
       )
       SELECT $1, $2, $3, $4, connection_id FROM unnest($5::text[]) AS connection_id`,
      [key.landscapeId, key.versionId, orgId, diagram.id, connectionIds],
    )
    await client.query(
      `DELETE FROM ro_connection_flows
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagram.id],
    )
    if (flowRows.length) {
      await client.query(
        `INSERT INTO ro_connection_flows (
           landscape_id, version_id, org_id, diagram_id, flow_id, connection_id
         )
         SELECT landscape_id, version_id, org_id, diagram_id, flow_id, connection_id
         FROM jsonb_to_recordset($1::jsonb) AS row(
           landscape_id text, version_id text, org_id text, diagram_id text,
           flow_id text, connection_id text
         )`,
        [JSON.stringify(flowRows)],
      )
    }
  })
}

async function existingPhase14Overlay(
  repo: Repo,
  meta: MetaLike,
  marker: Phase14FixtureMarker,
): Promise<DocHandle<ConnectionOverlayLike> | undefined> {
  for (const url of unique(meta.editsConnectionShardUrls ?? [])) {
    try {
      const handle = await resolve<ConnectionOverlayLike>(repo, url)
      if (markerMatches(handle.doc()?.phase14Fixture, marker)) return handle
    } catch {
      // A retired URL may already have been collected. It cannot be the
      // durable Phase-14 fixture and is ignored; the verifier catches gaps.
    }
  }
  return undefined
}

async function ensureDenseOverlay(
  repo: Repo,
  key: WorkspaceKey,
  metaHandle: DocHandle<MetaLike>,
  marker: Phase14FixtureMarker,
  connections: PerformanceConnection[],
): Promise<{ handle: DocHandle<ConnectionOverlayLike>; created: boolean }> {
  const before = metaHandle.doc()!
  const existing = await existingPhase14Overlay(repo, before, marker)
  if (existing) return { handle: existing, created: false }

  const oldCurrentUrl = before.editsConnectionShardUrl
  const batchId = `maintenance/phase14/${key.landscapeId}/${key.versionId}`
  const handle = repo.create<ConnectionOverlayLike>({
    connections: Object.fromEntries(connections.map((connection) => [connection.id, connection])),
    writeBatchIds: [batchId],
    writeHeadVersion: 1,
    phase14Fixture: marker,
  })
  await handle.whenReady()
  await repo.flush([handle.documentId])
  await registerStaticReadModelDocuments(pool, key, [{
    documentId: handle.documentId,
    kind: 'connection-overlay',
  }])
  // A post-admission revision proves the child can be recovered from a cold
  // repo before ModelMeta publishes the URL.
  handle.change((doc) => { doc.writeHeadVersion = 2 })
  await repo.flush([handle.documentId])

  metaHandle.change((meta) => {
    meta.editsConnectionShardUrls = unique([...(meta.editsConnectionShardUrls ?? []), handle.url])
    meta.connectionShardUrls = unique([...(meta.connectionShardUrls ?? []), handle.url])
    meta.editsConnectionShardUrl = handle.url
    // The meta's protocol version, which is a DIFFERENT field from the child's
    // `writeHeadVersion = 2` above — that one is only a forced post-admission
    // Automerge revision, matching server rotation. The constant is used
    // rather than a literal so a protocol bump cannot leave this behind.
    meta.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
  })
  await repo.flush([metaHandle.documentId])
  const published = metaHandle.doc()!
  await synchronizeOverlaySegments(
    pool,
    key,
    'connection',
    published.editsConnectionShardUrls ?? [handle.url],
    published.editsConnectionShardUrl,
  )
  if (oldCurrentUrl && documentIdOf(oldCurrentUrl) !== handle.documentId) {
    await pool.query(
      `INSERT INTO read_model_overlay_rotations (
         landscape_id, version_id, collection, old_document_id,
         new_document_id, new_segment_url, status, published_at
       ) VALUES ($1, $2, 'connection', $3, $4, $5, 'published', now())
       ON CONFLICT (landscape_id, version_id, collection, new_document_id) DO UPDATE SET
         status = 'published', published_at = COALESCE(read_model_overlay_rotations.published_at, now())`,
      [key.landscapeId, key.versionId, documentIdOf(oldCurrentUrl), handle.documentId, handle.url],
    )
  }
  return { handle, created: true }
}

async function updateDenseDiagramDocument(
  repo: Repo,
  docUrl: string,
  diagram: DiagramInput,
  marker: Phase14FixtureMarker,
): Promise<void> {
  const handle = await resolve<DiagramDocLike>(repo, docUrl)
  const payload = plain(diagram)
  handle.change((doc) => {
    doc.name = payload.name
    doc.type = payload.type
    doc.description = payload.description as string | undefined
    doc.domainId = payload.domainId as string | undefined
    if (payload.parentObjectId) doc.parentObjectId = payload.parentObjectId
    else delete doc.parentObjectId
    doc.objectIds = [...(payload.objectIds ?? [])]
    doc.connectionIds = [...(payload.connectionIds ?? [])]
    doc.groupIds = [...(payload.groupIds ?? [])]
    doc.layouts = plain((payload.layouts ?? {}) as Record<string, unknown>)
    doc.comments = plain((payload.comments ?? {}) as Record<string, unknown>)
    doc.flows = plain((payload.flows ?? {}) as Record<string, unknown>)
    doc.connectionHighlightStyle = payload.connectionHighlightStyle as string | undefined
    doc.connectionAnimationsEnabled = payload.connectionAnimationsEnabled as boolean | undefined
    doc.defaultConnectionShape = payload.defaultConnectionShape as string | undefined
    doc.skinId = payload.skinId as string | undefined
    doc.checkpoints = []
    doc.phase14Fixture = marker
  })
  assertDenseDiagramDocument(handle.doc(), diagram, marker, 'in-memory change')
  await repo.flush([handle.documentId])

  // A referenced DiagramDoc can be absent from an interrupted historical
  // seed. Repo.find() then exposes an empty document, which is writable, but a
  // successful flush must never be inferred from the relational rows we write
  // below. Reopen it through an independent Repo so publication is gated on
  // what a cold server/client will actually load from durable storage.
  const verifier = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })
  try {
    const persisted = await resolve<DiagramDocLike>(verifier, docUrl)
    assertDenseDiagramDocument(persisted.doc(), diagram, marker, 'durable reload')
  } finally {
    await verifier.shutdown().catch(() => undefined)
  }
}

function assertDenseDiagramDocument(
  doc: DiagramDocLike | undefined,
  diagram: DiagramInput,
  marker: Phase14FixtureMarker,
  source: string,
): void {
  const objectCount = Array.isArray(doc?.objectIds) ? doc.objectIds.length : -1
  const connectionCount = Array.isArray(doc?.connectionIds) ? doc.connectionIds.length : -1
  if (objectCount !== (diagram.objectIds?.length ?? 0)
      || connectionCount !== (diagram.connectionIds?.length ?? 0)
      || !markerMatches(doc?.phase14Fixture, marker)) {
    throw new Error(
      `Dense DiagramDoc ${source} verification failed: objects=${objectCount}, connections=${connectionCount}`,
    )
  }
}

async function publishReadModelGeneration(key: WorkspaceKey, orgId: string): Promise<number> {
  return withTransaction(async (client) => {
    const state = await client.query<{ generation: string }>(
      `SELECT (GREATEST(observed_generation, projected_generation) + 1)::text AS generation
       FROM read_model_projection_state
       WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
      [key.landscapeId, key.versionId],
    )
    const generation = Number(state.rows[0]?.generation ?? 1)
    await client.query(
      `INSERT INTO read_model_diagram_render_generations (
         landscape_id, version_id, diagram_id, render_generation, updated_at
       )
       SELECT $1, $2, id, $3, now() FROM ro_diagrams
       WHERE landscape_id = $1 AND version_id = $2
       ON CONFLICT (landscape_id, version_id, diagram_id) DO UPDATE SET
         render_generation = GREATEST(
           read_model_diagram_render_generations.render_generation,
           EXCLUDED.render_generation
         ), updated_at = now()`,
      [key.landscapeId, key.versionId, generation],
    )
    await client.query(
      `INSERT INTO read_model_projection_state (
         landscape_id, version_id, org_id, observed_generation, projected_generation,
         last_projected_at, last_duration_ms, projector_attached, last_projection_kind
       ) VALUES ($1, $2, $3, $4, $4, now(), 0, false, 'metadata')
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         observed_generation = EXCLUDED.observed_generation,
         projected_generation = EXCLUDED.projected_generation,
         last_projected_at = now(), last_duration_ms = 0,
         last_error_at = NULL, last_error_generation = NULL, last_error_code = NULL,
         consecutive_failures = 0, projector_attached = false,
         projector_instance_id = NULL, last_projection_kind = 'metadata', updated_at = now()`,
      [key.landscapeId, key.versionId, orgId, generation],
    )
    return generation
  })
}

async function verifyUpgrade(
  key: WorkspaceKey,
  tagId: string,
  teamId: string,
  diagramId: string,
): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2)::text AS objects,
       (SELECT count(*) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2)::text AS connections,
       (SELECT count(*) FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2
          AND diagram_id = $5)::text AS diagram_objects,
       (SELECT count(*) FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2
          AND diagram_id = $5)::text AS diagram_connections,
       (SELECT count(DISTINCT object_id) FROM ro_object_tags
          WHERE landscape_id = $1 AND version_id = $2 AND tag_id = $3)::text AS governed_tag_objects,
       (SELECT count(DISTINCT object_id) FROM ro_object_technologies
          WHERE landscape_id = $1 AND version_id = $2
            AND snapshot->>'name' = 'Prometheus')::text AS prometheus_objects,
       (SELECT count(*) FROM team_members WHERE team_id = $4)::text AS dense_team_members`,
    [key.landscapeId, key.versionId, tagId, teamId, diagramId],
  )
  const counts = Object.fromEntries(Object.entries(result.rows[0] ?? {}).map(([name, value]) => [name, Number(value)]))
  const expected = {
    objects: FULL_PERFORMANCE_SEED_SCALE.objects,
    connections: FULL_PERFORMANCE_SEED_SCALE.connections,
    diagram_objects: 500,
    diagram_connections: FULL_PERFORMANCE_SEED_SCALE.denseDiagramConnections,
    governed_tag_objects: 160_000,
    prometheus_objects: 160_000,
    dense_team_members: 10_000,
  }
  for (const [name, minimum] of Object.entries(expected)) {
    if ((counts[name] ?? 0) < minimum) throw new Error(`Phase-14 verification failed: ${name}=${counts[name] ?? 0} < ${minimum}`)
  }
  return counts
}

async function main(): Promise<void> {
  if (process.env.PERFORMANCE_SEED !== 'on') throw new Error('PERFORMANCE_SEED=on is required')
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-upgrade-phase14')) {
    throw new Error('--confirm-upgrade-phase14 is required')
  }
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')
  const actorEmail = valueAfter(args, '--actor-email').trim().toLowerCase()
  const key = { landscapeId, versionId }

  await initSchema()
  await ensureReadModelSchema(pool)
  await assertApiStopped(key)
  const targetResult = await pool.query<{
    root_url: string
    source: string
    org_id: string
    actor_user_id: string
  }>(
    `SELECT version.root_url, workspace.source, landscape.org_id, actor.id AS actor_user_id
     FROM versions version
     JOIN landscapes landscape ON landscape.id = version.landscape_id
     JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id AND workspace.version_id = version.id
     JOIN users actor ON lower(actor.email) = $3
     JOIN org_members member ON member.org_id = landscape.org_id AND member.user_id = actor.id
     WHERE version.landscape_id = $1 AND version.id = $2`,
    [landscapeId, versionId, actorEmail],
  )
  const target = targetResult.rows[0]
  if (!target || !isValidAutomergeUrl(target.root_url)
      || target.source !== 'performance-seed-editable') {
    throw new Error('Editable static performance workspace or actor membership was not found')
  }

  const tags = await preparePerformanceCatalog(pool, target.org_id, target.actor_user_id)
  const principals = await seedPerformancePrincipals(pool, target.org_id, FULL_PERFORMANCE_SEED_SCALE)
  const teamIds = performanceTeamIds(target.org_id, FULL_PERFORMANCE_SEED_SCALE.teams)
  const plan = new PerformanceSeedPlan({
    scale: FULL_PERFORMANCE_SEED_SCALE,
    tags,
    teamIds,
  })
  const denseDiagram = plan.diagramAt(plan.denseDiagramIndex)
  const marker: Phase14FixtureMarker = {
    schema: PHASE14_SCHEMA,
    diagramId: denseDiagram.id,
    connectionStart: plan.denseConnectionStart,
    connectionCount: plan.denseConnectionCount,
  }
  const denseConnections = Array.from(
    { length: plan.denseConnectionCount },
    (_, offset) => plan.connectionAt(plan.denseConnectionStart + offset),
  )

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool, trackStaticReadModel: true }),
    network: [],
    saveDebounceRate: 0,
  })
  try {
    const rootHandle = await resolve<RootLike>(repo, target.root_url)
    const metaUrl = rootHandle.doc()?.modelMetaUrl
    if (!metaUrl) throw new Error('Performance ModelMeta URL is missing')
    const metaHandle = await resolve<MetaLike>(repo, metaUrl)
    if (metaHandle.doc()?.staticBaseline !== true) throw new Error('ModelMeta is not a static baseline')

    const overlay = await ensureDenseOverlay(repo, key, metaHandle, marker, denseConnections)
    console.log(`[phase14] dense overlay ${overlay.created ? 'created' : 'reused'}: ${overlay.handle.url}`)

    for (let start = 0; start < plan.denseGovernanceObjectCount; start += OBJECT_BATCH) {
      const count = Math.min(OBJECT_BATCH, plan.denseGovernanceObjectCount - start)
      const globalStart = plan.tierCounts.actors + start
      const objects = Array.from({ length: count }, (_, offset) => (
        plan.objectAt(globalStart + offset) as unknown as ObjectInput
      ))
      await updateGovernedObjectBatch(key, target.org_id, objects)
      const completed = start + count
      if (completed % 10_000 === 0 || completed === plan.denseGovernanceObjectCount) {
        console.log(`[phase14] governed objects ${completed.toLocaleString('en-CA')} / ${plan.denseGovernanceObjectCount.toLocaleString('en-CA')}`)
      }
    }

    for (let start = 0; start < denseConnections.length; start += CONNECTION_BATCH) {
      const batch = denseConnections.slice(start, start + CONNECTION_BATCH) as unknown as ConnectionInput[]
      await upsertDenseConnectionBatch(key, target.org_id, batch)
    }

    const diagramRow = await pool.query<{ doc_url: string }>(
      `SELECT data->>'docUrl' AS doc_url FROM ro_diagrams
       WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
      [landscapeId, versionId, denseDiagram.id],
    )
    const docUrl = diagramRow.rows[0]?.doc_url
    if (!docUrl || !isValidAutomergeUrl(docUrl)) throw new Error(`Dense DiagramDoc is missing: ${denseDiagram.id}`)
    const diagram = performanceDiagramRecord(plan, plan.denseDiagramIndex, docUrl)
    await updateDenseDiagramDocument(repo, docUrl, diagram, marker)
    await updateDenseDiagramReadModel(key, target.org_id, diagram)

    await rebuildReadModelDerivedStats(pool, key, target.org_id)
    const generation = await publishReadModelGeneration(key, target.org_id)
    const counts = await verifyUpgrade(key, tags[0].tagId, teamIds[0], denseDiagram.id)
    console.log(JSON.stringify({
      status: 'complete',
      landscapeId,
      versionId,
      diagramId: denseDiagram.id,
      generation,
      overlayUrl: overlay.handle.url,
      overlayCreated: overlay.created,
      principals: {
        teams: principals.teams,
        users: principals.users,
        memberships: principals.memberships,
        denseTeamId: principals.teamIds[0],
      },
      counts,
    }, null, 2))
  } finally {
    await repo.shutdown().catch(() => undefined)
  }
}

main()
  .catch((error) => {
    console.error('[performance-phase14-upgrade] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
