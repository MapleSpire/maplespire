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

import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { FLOW_INDEX_VERSION, technologyText } from './projector.js'
import { getWorkspaceProjectionFreshness, type ReadModelWorkspaceStatus } from './health.js'

/**
 * Read-model query functions — the server side of the ModelQuery contract. They
 * mirror the client's resident/paged semantics exactly so the agreement suite
 * (`resident == paged == server`) holds:
 *  - incoming/outgoing exclude self-loops, peer = the other endpoint.
 *  - connectionCount counts a self-loop once.
 *  - descendants = transitive children (excludes self).
 *  - search: SQL filters (trigram-accelerated substring), Node ranks with the SAME
 *    score weights + localeCompare tie-break the client uses (same V8 → identical).
 *
 * Every query takes a `WorkspaceKey` and scopes its SQL by
 * (landscape_id, version_id) — the composite PK's leading columns — so two
 * concurrently-projected workspaces never leak rows into each other's results.
 */

type Json = Record<string, unknown>

export interface PeerEdgeRow {
  connection: Json
  peerId: string
}

export type SearchHitRow =
  | { type: 'object'; object: Json }
  | { type: 'connection'; connection: Json; fromName: string; toName: string }

const SEARCH_MIN_CHARS = 3
const SEARCH_LIMIT = 12

export async function roObject(db: Queryable, key: WorkspaceKey, id: string): Promise<Json | undefined> {
  const { rows } = await db.query<{ data: Json }>(
    `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [key.landscapeId, key.versionId, id]
  )
  return rows[0]?.data
}

export async function roGroup(db: Queryable, key: WorkspaceKey, id: string): Promise<Json | undefined> {
  const { rows } = await db.query<{ data: Json }>(
    `SELECT data FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [key.landscapeId, key.versionId, id]
  )
  return rows[0]?.data
}

export async function roConnection(db: Queryable, key: WorkspaceKey, id: string): Promise<Json | undefined> {
  const { rows } = await db.query<{ data: Json }>(
    `SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [key.landscapeId, key.versionId, id],
  )
  return rows[0]?.data
}

/** Batch-resolve ids to objects and/or groups (objects win on the impossible id
 * collision), matching the client's lookupMany. */
export async function roLookupMany(db: Queryable, key: WorkspaceKey, ids: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>()
  if (!ids.length) return out
  const [objs, grps] = await Promise.all([
    db.query<{ id: string; data: Json }>(
      `SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
      [key.landscapeId, key.versionId, ids]
    ),
    db.query<{ id: string; data: Json }>(
      `SELECT id, data FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
      [key.landscapeId, key.versionId, ids]
    ),
  ])
  for (const r of grps.rows) out.set(r.id, r.data)
  for (const r of objs.rows) out.set(r.id, r.data) // object wins
  return out
}

/**
 * Batched durability witness for the client's crash-journal replay: objects AND
 * connections in one round trip (roLookupMany covers objects+groups only). An id
 * absent from the result means "not in the projection" — whether that counts as
 * proof of ABSENCE is the caller's decision, taken from the projection-freshness
 * signal served alongside (`getWorkspaceProjectionFreshness`), never from the
 * 404-shaped absence alone.
 */
export async function roDurabilityWitness(
  db: Queryable,
  key: WorkspaceKey,
  objectIds: string[],
  connectionIds: string[],
): Promise<{ objects: Record<string, Json>; connections: Record<string, Json> }> {
  const empty = Promise.resolve({ rows: [] as Array<{ id: string; data: Json }> })
  const [objs, conns] = await Promise.all([
    objectIds.length
      ? db.query<{ id: string; data: Json }>(
        `SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, objectIds]
      )
      : empty,
    connectionIds.length
      ? db.query<{ id: string; data: Json }>(
        `SELECT id, data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, connectionIds]
      )
      : empty,
  ])
  // Null-prototype accumulators: ids are arbitrary strings (JSON import keeps
  // external ids verbatim), and `obj['__proto__'] = data` on a plain object
  // does not create an own property — it reassigns the prototype.
  const objects: Record<string, Json> = Object.create(null) as Record<string, Json>
  const connections: Record<string, Json> = Object.create(null) as Record<string, Json>
  for (const row of objs.rows) objects[row.id] = row.data
  for (const row of conns.rows) connections[row.id] = row.data
  return { objects, connections }
}

export interface DurabilityWitnessPayload {
  landscapeId: string
  versionId: string
  absenceProvable: boolean
  caughtUp: boolean
  status: ReadModelWorkspaceStatus
  projectionGeneration: number
  objects: Record<string, Json>
  connections: Record<string, Json>
}

/**
 * The COMPLETE body of POST /api/model/durability-witness, assembled here so
 * the contract is testable without an HTTP harness — a route that silently
 * dropped `absenceProvable` would fail SAFE (the client's strict read defers
 * everything) but SILENTLY, so it needs a detector. Order matters and is part
 * of the contract: freshness FIRST, entities SECOND (the TOCTOU direction). The
 * echoed landscapeId/versionId are the RESOLVED workspace; the client refuses
 * the whole payload when they differ from what it asked.
 */
export async function durabilityWitnessPayload(
  db: Queryable,
  key: WorkspaceKey,
  objectIds: string[],
  connectionIds: string[],
): Promise<DurabilityWitnessPayload> {
  const freshness = await getWorkspaceProjectionFreshness(db, key)
  const entities = await roDurabilityWitness(db, key, objectIds, connectionIds)
  return {
    landscapeId: key.landscapeId,
    versionId: key.versionId,
    absenceProvable: freshness.absenceProvable,
    caughtUp: freshness.caughtUp,
    status: freshness.status,
    projectionGeneration: freshness.projectedGeneration,
    objects: entities.objects,
    connections: entities.connections,
  }
}

export async function roIncoming(db: Queryable, key: WorkspaceKey, focusId: string): Promise<PeerEdgeRow[]> {
  const { rows } = await db.query<{ data: Json; from_id: string }>(
    `SELECT data, from_id FROM ro_connections
     WHERE landscape_id = $1 AND version_id = $2 AND to_id = $3 AND from_id <> $3`,
    [key.landscapeId, key.versionId, focusId]
  )
  return rows.map((r) => ({ connection: r.data, peerId: r.from_id }))
}

export async function roOutgoing(db: Queryable, key: WorkspaceKey, focusId: string): Promise<PeerEdgeRow[]> {
  const { rows } = await db.query<{ data: Json; to_id: string }>(
    `SELECT data, to_id FROM ro_connections
     WHERE landscape_id = $1 AND version_id = $2 AND from_id = $3 AND to_id <> $3`,
    [key.landscapeId, key.versionId, focusId]
  )
  return rows.map((r) => ({ connection: r.data, peerId: r.to_id }))
}

export async function roConnectionCount(db: Queryable, key: WorkspaceKey, id: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ro_connections
     WHERE landscape_id = $1 AND version_id = $2 AND (from_id = $3 OR to_id = $3)`,
    [key.landscapeId, key.versionId, id]
  )
  return Number(rows[0]?.n ?? 0)
}

/** A diagram registry entry (the projected DiagramMeta stub: name + composition) — the
 * server-side view of the diagram doc. Undefined for an unknown diagram. */
export async function roDiagramMeta(db: Queryable, key: WorkspaceKey, id: string): Promise<Json | undefined> {
  const { rows } = await db.query<{ data: Json }>(
    `SELECT data FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [key.landscapeId, key.versionId, id]
  )
  return rows[0]?.data
}

/** Transitive descendant object ids (excludes self) via a recursive CTE over
 * parent_id, scoped to one workspace — matches the client's `ch:` BFS. */
export async function roDescendants(db: Queryable, key: WorkspaceKey, objectId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE d AS (
       SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND parent_id = $3
       UNION
       SELECT o.id FROM ro_objects o JOIN d ON o.parent_id = d.id
       WHERE o.landscape_id = $1 AND o.version_id = $2
     )
     SELECT id FROM d`,
    [key.landscapeId, key.versionId, objectId]
  )
  return rows.map((r) => r.id)
}

export interface RelatedDiagrams {
  detail: Json[]
  reference: Json[]
  parent: Json[]
  totals: { detail: number; reference: number; parent: number }
  limit: number
  truncated: boolean
}

export interface RelatedDiagramOptions {
  query?: string
  limit?: number
}

/**
 * Diagrams related to an object, mirroring the client's getRelatedDiagrams:
 *   reference = diagrams whose object_ids contains the object,
 *   detail    = diagrams whose parent_object_id = the object,
 *   parent    = diagrams whose parent_object_id = the object's parent.
 * The active diagram is excluded; reference takes precedence over detail/parent
 * (an id already picked is not repeated). All lookups scoped to one workspace.
 */
export async function roRelatedDiagrams(
  db: Queryable,
  key: WorkspaceKey,
  objectId: string,
  currentDiagramId: string | null,
  options: RelatedDiagramOptions = {},
): Promise<RelatedDiagrams> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const query = options.query?.trim()
  const queryPattern = query ? `%${query.replace(/([%_\\])/g, '\\$1')}%` : null
  const { rows } = await db.query<{
    category: 'detail' | 'reference' | 'parent'
    data: Json
    total: string | number
  }>(
    `WITH focus AS MATERIALIZED (
       SELECT parent_id FROM ro_objects
       WHERE landscape_id = $1 AND version_id = $2 AND id = $3
     ), candidates AS (
       SELECT diagram.id, diagram.data, 'reference'::text AS category, 1 AS priority
       FROM ro_diagram_objects membership
       JOIN ro_diagrams diagram
         ON diagram.landscape_id = membership.landscape_id
        AND diagram.version_id = membership.version_id
        AND diagram.id = membership.diagram_id
       WHERE membership.landscape_id = $1 AND membership.version_id = $2
         AND membership.object_id = $3
       UNION ALL
       SELECT diagram.id, diagram.data, 'detail'::text, 2
       FROM ro_diagrams diagram JOIN focus ON true
       WHERE diagram.landscape_id = $1 AND diagram.version_id = $2
         AND diagram.parent_object_id = $3
       UNION ALL
       SELECT diagram.id, diagram.data, 'parent'::text, 3
       FROM ro_diagrams diagram JOIN focus ON focus.parent_id IS NOT NULL
       WHERE diagram.landscape_id = $1 AND diagram.version_id = $2
         AND diagram.parent_object_id = focus.parent_id
     ), deduplicated AS (
       SELECT DISTINCT ON (id) id, data, category
       FROM candidates
       WHERE ($4::text IS NULL OR id <> $4)
       ORDER BY id, priority
     ), filtered AS (
       SELECT id, data, category FROM deduplicated
       WHERE ($5::text IS NULL OR COALESCE(data->>'name', '') ILIKE $5 ESCAPE '\\')
     ), ranked AS (
       SELECT id, data, category,
              count(*) OVER (PARTITION BY category) AS total,
              row_number() OVER (
                PARTITION BY category
                ORDER BY lower(COALESCE(data->>'name', '')) COLLATE "C", id COLLATE "C"
              ) AS ordinal
       FROM filtered
     )
     SELECT category, data, total FROM ranked
     WHERE ordinal <= $6
     ORDER BY category, ordinal`,
    [key.landscapeId, key.versionId, objectId, currentDiagramId, queryPattern, limit],
  )
  const result: RelatedDiagrams = {
    detail: [], reference: [], parent: [],
    totals: { detail: 0, reference: 0, parent: 0 },
    limit,
    truncated: false,
  }
  for (const row of rows) {
    result[row.category].push(row.data)
    result.totals[row.category] = Number(row.total)
  }
  result.truncated = (['detail', 'reference', 'parent'] as const)
    .some((category) => result.totals[category] > result[category].length)
  return result
}

/** Batch companion to roRelatedDiagrams for canvas affordances. Returns only
 * the requested object ids that have at least one non-current reference,
 * detail, or parent diagram, keeping large canvases to one indexed query. */
export async function roRelatedDiagramObjectIds(
  db: Queryable,
  key: WorkspaceKey,
  objectIds: string[],
  currentDiagramId: string | null,
): Promise<string[]> {
  const boundedObjectIds = [...new Set(objectIds.filter(Boolean))].slice(0, 2_000)
  if (boundedObjectIds.length === 0) return []

  const { rows } = await db.query<{ id: string }>(
    `WITH requested AS MATERIALIZED (
       SELECT DISTINCT unnest($4::text[]) AS id
     ), focus AS MATERIALIZED (
       SELECT requested.id, object.parent_id
       FROM requested
       LEFT JOIN ro_objects object
         ON object.landscape_id = $1
        AND object.version_id = $2
        AND object.id = requested.id
     )
     SELECT focus.id
     FROM focus
     WHERE EXISTS (
       SELECT 1
       FROM ro_diagram_objects membership
       WHERE membership.landscape_id = $1
         AND membership.version_id = $2
         AND membership.object_id = focus.id
         AND ($3::text IS NULL OR membership.diagram_id <> $3)
     ) OR EXISTS (
       SELECT 1
       FROM ro_diagrams diagram
       WHERE diagram.landscape_id = $1
         AND diagram.version_id = $2
         AND ($3::text IS NULL OR diagram.id <> $3)
         AND (
           diagram.parent_object_id = focus.id
           OR (focus.parent_id IS NOT NULL AND diagram.parent_object_id = focus.parent_id)
         )
     )
     ORDER BY focus.id COLLATE "C"`,
    [key.landscapeId, key.versionId, currentDiagramId, boundedObjectIds],
  )
  return rows.map((row) => row.id)
}

export interface EntityFlows {
  flows: Array<{ id: string; diagramId: string; name: string }>
  /** Distinct (diagram, flow) pairs; may exceed `flows.length` (bounded). */
  total: number
  /** False when a diagram holding the entity has no CURRENT coverage witness
   * (`ro_diagram_flow_index` at FLOW_INDEX_VERSION): its flows were never
   * projected into the index, so `total` is a floor, not a count. */
  complete: boolean
}

export interface EntityFlowsOptions {
  limit?: number
  /** Leave this diagram out of hits AND coverage. The client passes the OPEN
   * diagram, whose flows it holds live (and may hold unsynced or newer than
   * the projection), and adds them itself. */
  excludeDiagramId?: string | null
}

/**
 * The flows whose steps use an object (process step on it, message sent or
 * received by it), or that travel over a connection, across the WHOLE model.
 *
 * Hits: `ro_flow_objects` for objects, `ro_connection_flows` for connections
 * (the Connections table's flow source); both only on diagrams that still
 * exist. Completeness, for BOTH kinds: every diagram holding the entity
 * (`ro_diagram_objects` / `ro_diagram_connections`) carries a current coverage
 * witness. A cold build wipes every flow row and the per-diagram flow pass
 * runs after it, unawaited — without the witness test a connection would read
 * "0 flows, exact" through that whole window.
 *
 * Assumes a flow only references entities placed on its own diagram: a stale
 * step on an entity that has since left an UNCOVERED diagram is neither
 * counted nor flagged.
 */
export async function roEntityFlows(
  db: Queryable,
  key: WorkspaceKey,
  kind: 'object' | 'connection',
  id: string,
  options: EntityFlowsOptions = {},
): Promise<EntityFlows> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const postings = kind === 'object'
    ? { table: 'ro_flow_objects', column: 'object_id' }
    : { table: 'ro_connection_flows', column: 'connection_id' }
  const membership = kind === 'object'
    ? { table: 'ro_diagram_objects', column: 'object_id' }
    : { table: 'ro_diagram_connections', column: 'connection_id' }
  const { rows } = await db.query<{ uncovered: string | number; total: string | number; items: EntityFlows['flows'] }>(
    // No DISTINCT: both posting tables' primary keys end in (…, flow_id,
    // <entity>_id), so with the entity fixed each (diagram, flow) is already
    // one row — a DISTINCT here could never change the answer.
    `WITH hits AS MATERIALIZED (
       SELECT posting.diagram_id, posting.flow_id
       FROM ${postings.table} posting
       WHERE posting.landscape_id = $1 AND posting.version_id = $2 AND posting.${postings.column} = $3
         AND ($5::text IS NULL OR posting.diagram_id <> $5)
         AND EXISTS (
           SELECT 1 FROM ro_diagrams diagram
           WHERE diagram.landscape_id = $1 AND diagram.version_id = $2 AND diagram.id = posting.diagram_id)
     )
     SELECT (SELECT count(*) FROM ${membership.table} member
             WHERE member.landscape_id = $1 AND member.version_id = $2 AND member.${membership.column} = $3
               AND ($5::text IS NULL OR member.diagram_id <> $5)
               AND NOT EXISTS (
                 SELECT 1 FROM ro_diagram_flow_index covered
                 WHERE covered.landscape_id = $1 AND covered.version_id = $2
                   AND covered.diagram_id = member.diagram_id AND covered.index_version = $6)) AS uncovered,
            (SELECT count(*) FROM hits) AS total,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('id', page.flow_id, 'diagramId', page.diagram_id, 'name', page.name)
                               ORDER BY page.ordinal)
              FROM (
                SELECT hit.flow_id, hit.diagram_id, COALESCE(flow.name, '') AS name,
                       row_number() OVER (
                         ORDER BY lower(COALESCE(flow.name, '')) COLLATE "C", hit.diagram_id COLLATE "C", hit.flow_id COLLATE "C"
                       ) AS ordinal
                FROM hits hit
                LEFT JOIN ro_flows flow
                  ON flow.landscape_id = $1 AND flow.version_id = $2
                 AND flow.diagram_id = hit.diagram_id AND flow.flow_id = hit.flow_id
              ) page
              WHERE page.ordinal <= $4
            ), '[]'::jsonb) AS items`,
    [key.landscapeId, key.versionId, id, limit, options.excludeDiagramId ?? null, FLOW_INDEX_VERSION],
  )
  const row = rows[0]
  return {
    flows: row?.items ?? [],
    total: Number(row?.total ?? 0),
    complete: Number(row?.uncovered ?? 0) === 0,
  }
}

export interface EntityDiagrams {
  /** Name-sorted diagram stubs, bounded by `limit`. */
  diagrams: Json[]
  total: number
}

/** Diagrams placing a group or a connection — `ro_diagram_groups` /
 * `ro_diagram_connections`, the sources of the Model Objects group row and the
 * Connections table's diagram column on this tier. The client's diagram
 * registry can be a bounded window under the summary contract, so it is not
 * a substitute. */
export async function roEntityDiagrams(
  db: Queryable,
  key: WorkspaceKey,
  kind: 'group' | 'connection',
  id: string,
  options: { limit?: number } = {},
): Promise<EntityDiagrams> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const membership = kind === 'group'
    ? { table: 'ro_diagram_groups', column: 'group_id' }
    : { table: 'ro_diagram_connections', column: 'connection_id' }
  const { rows } = await db.query<{ data: Json; total: string | number }>(
    `SELECT diagram.data, count(*) OVER () AS total
     FROM ${membership.table} member
     JOIN ro_diagrams diagram
       ON diagram.landscape_id = member.landscape_id AND diagram.version_id = member.version_id
      AND diagram.id = member.diagram_id
     WHERE member.landscape_id = $1 AND member.version_id = $2 AND member.${membership.column} = $3
     ORDER BY lower(COALESCE(diagram.data->>'name', '')) COLLATE "C", diagram.id COLLATE "C"
     LIMIT $4`,
    [key.landscapeId, key.versionId, id, limit],
  )
  if (rows.length) return { diagrams: rows.map((row) => row.data), total: Number(rows[0].total) }
  return { diagrams: [], total: 0 }
}

// ── search (SQL filter + Node rank for exact parity) ──────────────────────────

function scoreObject(o: Json, q: string): number {
  if (String(o.name ?? '').toLowerCase().includes(q)) return 4
  if (technologyText(o as { technology?: string; technologies?: { name?: string }[] }).toLowerCase().includes(q)) return 3
  if (String(o.description ?? '').toLowerCase().includes(q)) return 2
  return 0
}
function scoreConnection(c: Json, q: string): number {
  return String(c.label ?? '').toLowerCase().includes(q) ? 1 : 0
}

/** Escape LIKE wildcards so a query containing % or _ matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/([%_\\])/g, '\\$1')}%`
}

export async function roSearch(db: Queryable, key: WorkspaceKey, query: string, limit = SEARCH_LIMIT): Promise<SearchHitRow[]> {
  const q = query.trim().toLowerCase()
  if (q.length < SEARCH_MIN_CHARS) return []
  const like = likePattern(q)

  const [objRes, connRes] = await Promise.all([
    db.query<{ data: Json }>(
      `SELECT data FROM ro_objects
       WHERE landscape_id = $1 AND version_id = $2
         AND (lower(name) LIKE $3 ESCAPE '\\'
          OR lower(technology) LIKE $3 ESCAPE '\\'
          OR lower(description) LIKE $3 ESCAPE '\\')`,
      [key.landscapeId, key.versionId, like]
    ),
    db.query<{ data: Json }>(
      `SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND lower(label) LIKE $3 ESCAPE '\\'`,
      [key.landscapeId, key.versionId, like]
    ),
  ])

  // Resolve connection endpoint names (objects + groups) in one batch.
  const endpoints = new Set<string>()
  for (const r of connRes.rows) {
    if (scoreConnection(r.data, q) > 0) {
      endpoints.add(String(r.data.fromId))
      endpoints.add(String(r.data.toId))
    }
  }
  const names = await roLookupMany(db, key, [...endpoints])
  const nameOf = (id: string) => String(names.get(id)?.name ?? 'Unknown')

  interface Scored { hit: SearchHitRow; score: number; sortKey: string; id: string }
  const scored: Scored[] = []
  for (const r of objRes.rows) {
    const score = scoreObject(r.data, q)
    if (score > 0) scored.push({ hit: { type: 'object', object: r.data }, score, sortKey: String(r.data.name ?? '').toLowerCase(), id: String(r.data.id) })
  }
  for (const r of connRes.rows) {
    const score = scoreConnection(r.data, q)
    if (score > 0) {
      scored.push({
        hit: { type: 'connection', connection: r.data, fromName: nameOf(String(r.data.fromId)), toName: nameOf(String(r.data.toId)) },
        score,
        sortKey: String(r.data.label ?? '').toLowerCase(),
        id: String(r.data.id),
      })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id))
  return scored.slice(0, limit).map((s) => s.hit)
}

// ── paging (keyset by id — stable, O(limit) on the PK index, within a workspace) ──

export interface ObjectPage {
  objects: Json[]
  nextCursor: string | null
}

export async function roPageObjects(
  db: Queryable,
  key: WorkspaceKey,
  opts: { after?: string | null; limit?: number; domainId?: string | null } = {}
): Promise<ObjectPage> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const params: unknown[] = [key.landscapeId, key.versionId]
  const where: string[] = ['landscape_id = $1', 'version_id = $2']
  if (opts.after) {
    params.push(opts.after)
    where.push(`id > $${params.length}`)
  }
  if (opts.domainId) {
    params.push(opts.domainId)
    where.push(`domain_id = $${params.length}`)
  }
  params.push(limit + 1)
  const { rows } = await db.query<{ id: string; data: Json }>(
    `SELECT id, data FROM ro_objects WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`,
    params
  )
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null
  return { objects: page.map((r) => r.data), nextCursor }
}

export interface ConnectionPage {
  connections: Json[]
  nextCursor: string | null
  total?: number
}

export async function roPageConnections(
  db: Queryable,
  key: WorkspaceKey,
  opts: { after?: string | null; limit?: number } = {}
): Promise<ConnectionPage> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const params: unknown[] = [key.landscapeId, key.versionId]
  const where: string[] = ['landscape_id = $1', 'version_id = $2']
  if (opts.after) {
    params.push(opts.after)
    where.push(`id > $${params.length}`)
  }
  params.push(limit + 1)
  const [{ rows }, countResult] = await Promise.all([
    db.query<{ id: string; data: Json }>(
      `SELECT id, data FROM ro_connections WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`,
      params
    ),
    opts.after
      ? Promise.resolve(null)
      : db.query<{ total: string | number }>(
        `SELECT count(*) AS total FROM ro_connections WHERE landscape_id = $1 AND version_id = $2`,
        [key.landscapeId, key.versionId],
      ),
  ])
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null
  return {
    connections: page.map((r) => r.data),
    nextCursor,
    ...(countResult ? { total: Number(countResult.rows[0]?.total ?? 0) } : {}),
  }
}

// ── faceted object filtering ──────────────────────────────────────────────────

/** Shared filter semantics: OR within each populated facet, AND between facets.
 * IDs (technology/team/tag) are compared as opaque stable identifiers. */
export interface ReadModelObjectFilter {
  technologyIds?: string[]
  types?: string[]
  tagIds?: string[]
  statuses?: string[]
  teamIds?: string[]
  scope?: string
  hasDescription?: boolean
  inDiagram?: boolean
}

export interface FilteredObjectTree {
  /** Direct matches plus their ancestors, ordered parent-before-child. */
  objects: Json[]
  /** Direct matches only, so callers can style ancestors as context. */
  matchedIds: string[]
  /** Directly matching groups. Kept separate from objects so existing clients
   * never need to discriminate mixed entity payloads. */
  groups: Json[]
  matchedGroupIds: string[]
}

/** Complete object-filter facets from normalized postings. The covering team
 * index keeps this bounded by the number of distinct teams, not object count. */
export async function roModelObjectFacets(
  db: Queryable,
  key: WorkspaceKey
): Promise<{ teamIds: string[] }> {
  const { rows } = await db.query<{ team_id: string }>(
    `SELECT DISTINCT team_id FROM ro_object_teams
     WHERE landscape_id = $1 AND version_id = $2
     ORDER BY team_id`,
    [key.landscapeId, key.versionId]
  )
  return { teamIds: rows.map((row) => row.team_id) }
}

/** Filter objects with indexed technology postings and retain ancestors as tree
 * context. The recursive branch walks only parents of the matched set; it never
 * expands the whole workspace hierarchy. */
export async function roFilteredObjectTree(
  db: Queryable,
  key: WorkspaceKey,
  filter: ReadModelObjectFilter,
  opts: { search?: string; domainId?: string | null } = {}
): Promise<FilteredObjectTree> {
  const params: unknown[] = [key.landscapeId, key.versionId]
  const where: string[] = ['o.landscape_id = $1', 'o.version_id = $2']
  let technologyCte = ''
  let tagCte = ''
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  if (filter.technologyIds?.length) {
    const p = add(filter.technologyIds)
    technologyCte = `selected_canonical_technologies AS MATERIALIZED (
       SELECT DISTINCT COALESCE(redirect.target_technology_id, selected.technology_id) AS technology_id
       FROM unnest(${p}::text[]) selected(technology_id)
       LEFT JOIN technology_redirects redirect
         ON redirect.source_technology_id = selected.technology_id
     ), matching_technology_ids AS MATERIALIZED (
       SELECT technology_id FROM selected_canonical_technologies
       UNION
       SELECT redirect.source_technology_id
       FROM technology_redirects redirect
       JOIN selected_canonical_technologies selected
         ON selected.technology_id = redirect.target_technology_id
     ),`
    where.push(`EXISTS (
      SELECT 1
      FROM matching_technology_ids selected
      JOIN ro_object_technologies t ON t.technology_id = selected.technology_id
      WHERE t.landscape_id = o.landscape_id AND t.version_id = o.version_id
        AND t.object_id = o.id
    )`)
  }
  if (filter.types?.length) where.push(`o.type = ANY(${add(filter.types)}::text[])`)
  if (filter.statuses?.length) where.push(`o.status = ANY(${add(filter.statuses)}::text[])`)
  if (filter.tagIds?.length) {
    const p = add(filter.tagIds)
    tagCte = `selected_tag_walk(requested_id, tag_id, path) AS (
       SELECT selected.tag_id, selected.tag_id, ARRAY[selected.tag_id]::text[]
       FROM unnest(${p}::text[]) selected(tag_id)
       UNION
       SELECT walk.requested_id, redirect.target_tag_id, walk.path || redirect.target_tag_id
       FROM selected_tag_walk walk
       JOIN tag_redirects redirect ON redirect.source_tag_id = walk.tag_id
       WHERE NOT redirect.target_tag_id = ANY(walk.path) AND cardinality(walk.path) < 64
     ), selected_canonical_tags AS MATERIALIZED (
       SELECT DISTINCT walk.tag_id
       FROM selected_tag_walk walk
       WHERE NOT EXISTS (
         SELECT 1 FROM tag_redirects redirect WHERE redirect.source_tag_id = walk.tag_id
       )
     ), matching_tag_ids(tag_id) AS (
       SELECT tag_id FROM selected_canonical_tags
       UNION
       SELECT redirect.source_tag_id
       FROM tag_redirects redirect
       JOIN matching_tag_ids matching ON redirect.target_tag_id = matching.tag_id
     ),`
    where.push(`EXISTS (
      SELECT 1
      FROM matching_tag_ids selected
      JOIN ro_object_tags t ON t.tag_id = selected.tag_id
      WHERE t.landscape_id = o.landscape_id AND t.version_id = o.version_id
        AND t.object_id = o.id
    )`)
  }
  if (filter.teamIds?.length) {
    const p = add(filter.teamIds)
    where.push(`(COALESCE(o.data->'ownerTeamIds', '[]'::jsonb) ?| ${p}::text[]
      OR COALESCE(o.data->'teamIds', '[]'::jsonb) ?| ${p}::text[])`)
  }
  if (filter.scope) where.push(`o.scope = ${add(filter.scope)}`)
  if (filter.hasDescription !== undefined) {
    where.push(filter.hasDescription ? `length(btrim(o.description)) > 0` : `length(btrim(o.description)) = 0`)
  }
  if (filter.inDiagram !== undefined) {
    const exists = `EXISTS (
      SELECT 1 FROM ro_diagrams d
      WHERE d.landscape_id = o.landscape_id AND d.version_id = o.version_id
        AND d.object_ids @> ARRAY[o.id]::text[]
    )`
    where.push(filter.inDiagram ? exists : `NOT ${exists}`)
  }
  if (opts.domainId) where.push(`o.domain_id = ${add(opts.domainId)}`)
  const q = opts.search?.trim().toLowerCase()
  if (q) where.push(`lower(o.name) LIKE ${add(likePattern(q))} ESCAPE '\\'`)

  const { rows } = await db.query<{ id: string; data: Json; direct_match: boolean; depth: number }>(
    `WITH RECURSIVE ${technologyCte}${tagCte} tree AS (
       SELECT o.id, o.parent_id, o.data, true AS direct_match, 0 AS depth,
              ARRAY[o.id]::text[] AS path
       FROM ro_objects o
       WHERE ${where.join(' AND ')}
       UNION ALL
       SELECT p.id, p.parent_id, p.data, false AS direct_match, tree.depth + 1,
              tree.path || p.id
       FROM ro_objects p
       JOIN tree ON tree.parent_id = p.id
       WHERE p.landscape_id = $1 AND p.version_id = $2
         AND NOT p.id = ANY(tree.path)
     ), collapsed AS (
       SELECT id, (array_agg(data ORDER BY depth))[1] AS data,
              bool_or(direct_match) AS direct_match, max(depth) AS depth
       FROM tree GROUP BY id
     )
     SELECT id, data, direct_match, depth FROM collapsed
     ORDER BY depth DESC, id`,
    params
  )

  // Groups are root entities, so they need no recursive ancestor walk. Build a
  // separate, indexed predicate set and return them additively rather than
  // mixing them into the established `objects` response.
  const groupParams: unknown[] = [key.landscapeId, key.versionId]
  const groupWhere: string[] = ['g.landscape_id = $1', 'g.version_id = $2']
  const groupCtes: string[] = []
  let groupFrom = 'ro_groups g'
  const addGroup = (value: unknown): string => {
    groupParams.push(value)
    return `$${groupParams.length}`
  }
  if (filter.technologyIds?.length) {
    const p = addGroup(filter.technologyIds)
    // Materialize the sparse, covering-index lookup first. Starting from every
    // group and probing by group_id makes PostgreSQL prefer the wrong index at
    // 50k-catalog scale even though the selected technology set is tiny.
    groupCtes.push(`matching_technology_groups AS MATERIALIZED (
      WITH selected_canonical_technologies AS MATERIALIZED (
        SELECT DISTINCT COALESCE(redirect.target_technology_id, selected.technology_id) AS technology_id
        FROM unnest(${p}::text[]) selected(technology_id)
        LEFT JOIN technology_redirects redirect
          ON redirect.source_technology_id = selected.technology_id
      ), matching_technology_ids AS MATERIALIZED (
        SELECT technology_id FROM selected_canonical_technologies
        UNION
        SELECT redirect.source_technology_id
        FROM technology_redirects redirect
        JOIN selected_canonical_technologies selected
          ON selected.technology_id = redirect.target_technology_id
      )
      SELECT DISTINCT t.group_id
      FROM matching_technology_ids selected
      JOIN ro_group_technologies t
        ON t.landscape_id = $1 AND t.version_id = $2
       AND t.technology_id = selected.technology_id
    )`)
    groupFrom = `matching_technology_groups mtg
      JOIN ro_groups g ON g.id = mtg.group_id
        AND g.landscape_id = $1 AND g.version_id = $2`
  }
  if (filter.tagIds?.length) {
    const p = addGroup(filter.tagIds)
    groupCtes.push(`selected_group_tag_walk(requested_id, tag_id, path) AS (
      SELECT selected.tag_id, selected.tag_id, ARRAY[selected.tag_id]::text[]
      FROM unnest(${p}::text[]) selected(tag_id)
      UNION
      SELECT walk.requested_id, redirect.target_tag_id, walk.path || redirect.target_tag_id
      FROM selected_group_tag_walk walk
      JOIN tag_redirects redirect ON redirect.source_tag_id = walk.tag_id
      WHERE NOT redirect.target_tag_id = ANY(walk.path) AND cardinality(walk.path) < 64
    )`)
    groupCtes.push(`selected_canonical_group_tags AS MATERIALIZED (
      SELECT DISTINCT walk.tag_id
      FROM selected_group_tag_walk walk
      WHERE NOT EXISTS (
        SELECT 1 FROM tag_redirects redirect WHERE redirect.source_tag_id = walk.tag_id
      )
    )`)
    groupCtes.push(`matching_group_tag_ids(tag_id) AS (
      SELECT tag_id FROM selected_canonical_group_tags
      UNION
      SELECT redirect.source_tag_id
      FROM tag_redirects redirect
      JOIN matching_group_tag_ids matching ON redirect.target_tag_id = matching.tag_id
    )`)
    groupWhere.push(`EXISTS (
      SELECT 1
      FROM matching_group_tag_ids selected
      JOIN ro_group_tags t ON t.tag_id = selected.tag_id
      WHERE t.landscape_id = g.landscape_id AND t.version_id = g.version_id
        AND t.group_id = g.id
    )`)
  }
  if (filter.types?.length && !filter.types.includes('group')) groupWhere.push('FALSE')
  // These facets are defined only on C4 objects in the current shared contract.
  if (filter.statuses?.length || filter.teamIds?.length
    || filter.scope || filter.hasDescription !== undefined) groupWhere.push('FALSE')
  if (filter.inDiagram !== undefined) {
    const exists = `EXISTS (
      SELECT 1 FROM ro_diagrams d
      WHERE d.landscape_id = g.landscape_id AND d.version_id = g.version_id
        AND (
          COALESCE(d.data->'groupIds', '[]'::jsonb) ? g.id
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(g.data->'objectIds', '[]'::jsonb)) member(id)
            WHERE member.id = ANY(d.object_ids)
          )
        )
    )`
    groupWhere.push(filter.inDiagram ? exists : `NOT ${exists}`)
  }
  if (opts.domainId) groupWhere.push(`g.data->>'domainId' = ${addGroup(opts.domainId)}`)
  if (q) groupWhere.push(`lower(g.name) LIKE ${addGroup(likePattern(q))} ESCAPE '\\'`)

  const { rows: groupRows } = await db.query<{ id: string; data: Json }>(
    `${groupCtes.length ? `WITH RECURSIVE ${groupCtes.join(',\n')}` : ''}
     SELECT g.id, g.data FROM ${groupFrom}
     WHERE ${groupWhere.join(' AND ')}
     ORDER BY lower(g.name), g.id`,
    groupParams,
  )
  return {
    objects: rows.map((row) => row.data),
    matchedIds: rows.filter((row) => row.direct_match).map((row) => row.id),
    groups: groupRows.map((row) => row.data),
    matchedGroupIds: groupRows.map((row) => row.id),
  }
}
