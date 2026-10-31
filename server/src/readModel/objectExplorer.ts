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
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
  ReadModelCursorError,
  readModelQueryHash,
} from './cursor.js'
import { servedRowsChangedBy, type ServedRowChanges } from './servedRowDigest.js'
import type { ReadModelChangePayload } from './changeFeed.js'
import { externalOnDiagramSql, externalOnSomeDiagramSql } from './objectScopeUsage.js'

const MAX_PAGE = 50
const MAX_HIERARCHY_DEPTH = 64

export interface ObjectExplorerFilter {
  types?: string[]
  scope?: string
  technologyIds?: string[]
  tagIds?: string[]
  statuses?: string[]
  teamIds?: string[]
  hasDescription?: boolean
  inDiagram?: boolean
  /** Objects that resolve external on at least one diagram they appear on
   * (false: on none). Per-diagram scope, `objectScopeUsage.ts`. */
  externalOnSomeDiagram?: boolean
  domainId?: string
}

export interface ObjectExplorerRow {
  id: string
  name: string
  kind: 'object' | 'group'
  type: string
  /** The explorer's navigation parent (`effective_parent_id`: group first). */
  parentId: string | null
  /** The Model Viewer's level parent (`c4_parent_id`), so the browser cache
   * can file a working-set row on its C4 level (see ObjectCacheInput). */
  c4ParentId: string | null
  childCount: number
  hasChildren: boolean
  canAcceptChildren: boolean
  scope?: string
  status?: string
  icon?: string
  iconAssignment?: unknown
  domainId?: string
  appCount: number
  storeCount: number
  componentCount: number
  connectionCount: number
  diagramCount: number
  /** Of `diagramCount`, the diagrams on which the object resolves external
   * (override, C4 boundary rule, default). Always 0 for a group. */
  externalDiagramCount: number
  inDiagram: boolean
  breadcrumb: Array<{ id: string; name: string }>
  matchKind?: 'exact' | 'prefix' | 'word_prefix' | 'contains' | 'filter'
}

export interface ObjectExplorerPage {
  projectionGeneration: number
  items: ObjectExplorerRow[]
  nextCursor: string | null
  total: number
}

interface ExplorerSqlRow extends Record<string, unknown> {
  id: string
  name: string
  kind: 'object' | 'group'
  type: string
  parent_id: string | null
  c4_parent_id: string | null
  child_count: string | number
  scope: string | null
  status: string | null
  icon: string | null
  icon_assignment: unknown
  domain_id: string | null
  in_diagram: boolean
  sort_order: string | number
  normalized_name: string
  score?: string | number
}

interface ExplorerMetrics {
  appCount: number
  storeCount: number
  componentCount: number
  connectionCount: number
  diagramCount: number
  externalDiagramCount: number
}

function emptyMetrics(): ExplorerMetrics {
  return { appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0, externalDiagramCount: 0 }
}

async function metricsForRows(
  db: Queryable,
  key: WorkspaceKey,
  rows: ExplorerSqlRow[],
): Promise<Map<string, ExplorerMetrics>> {
  const objectIds = rows.filter((row) => row.kind === 'object').map((row) => row.id)
  const groupIds = rows.filter((row) => row.kind === 'group').map((row) => row.id)
  const allIds = [...objectIds, ...groupIds]
  const result = new Map<string, ExplorerMetrics>()
  for (const row of rows) result.set(`${row.kind}:${row.id}`, emptyMetrics())
  if (!rows.length) return result

  const [children, connections, diagrams] = await Promise.all([
    db.query<{ kind: 'object' | 'group'; id: string; app_count: string | number; store_count: string | number; component_count: string | number }>(
      `SELECT 'object'::text AS kind, child.effective_parent_id AS id,
              count(*) FILTER (WHERE child.type = 'app') AS app_count,
              count(*) FILTER (WHERE child.type = 'store') AS store_count,
              count(*) FILTER (WHERE child.type = 'component') AS component_count
       FROM ro_objects child
       WHERE child.landscape_id = $1 AND child.version_id = $2 AND child.effective_parent_id = ANY($3::text[])
       GROUP BY child.effective_parent_id
       UNION ALL
       SELECT 'group'::text AS kind, membership.group_id AS id,
              count(*) FILTER (WHERE child.type = 'app') AS app_count,
              count(*) FILTER (WHERE child.type = 'store') AS store_count,
              count(*) FILTER (WHERE child.type = 'component') AS component_count
       FROM ro_group_objects membership
       JOIN ro_objects child ON child.landscape_id = membership.landscape_id
         AND child.version_id = membership.version_id AND child.id = membership.object_id
       WHERE membership.landscape_id = $1 AND membership.version_id = $2 AND membership.group_id = ANY($4::text[])
       GROUP BY membership.group_id`,
      [key.landscapeId, key.versionId, objectIds, groupIds],
    ),
    db.query<{ id: string; connection_count: string | number }>(
      `SELECT endpoint_id AS id, count(DISTINCT connection_id) AS connection_count
       FROM (
         SELECT from_id AS endpoint_id, id AS connection_id FROM ro_connections
         WHERE landscape_id = $1 AND version_id = $2 AND from_id = ANY($3::text[])
         UNION ALL
         SELECT to_id AS endpoint_id, id AS connection_id FROM ro_connections
         WHERE landscape_id = $1 AND version_id = $2 AND to_id = ANY($3::text[])
       ) endpoints GROUP BY endpoint_id`,
      [key.landscapeId, key.versionId, allIds],
    ),
    db.query<{ kind: 'object' | 'group'; id: string; diagram_count: string | number; external_count: string | number }>(
      // LEFT JOINs: the total stays exactly the membership count it always
      // was; a membership row whose diagram or object row is missing simply
      // has no override / focus / default to make it external.
      `SELECT 'object'::text AS kind, m.object_id AS id, count(*) AS diagram_count,
              count(*) FILTER (WHERE o.id IS NOT NULL AND ${externalOnDiagramSql('m', 'd', 'o')}) AS external_count
       FROM ro_diagram_objects m
       LEFT JOIN ro_diagrams d ON d.landscape_id = m.landscape_id AND d.version_id = m.version_id AND d.id = m.diagram_id
       LEFT JOIN ro_objects o ON o.landscape_id = m.landscape_id AND o.version_id = m.version_id AND o.id = m.object_id
       WHERE m.landscape_id = $1 AND m.version_id = $2 AND m.object_id = ANY($3::text[])
       GROUP BY m.object_id
       UNION ALL
       SELECT 'group'::text AS kind, group_id AS id, count(*) AS diagram_count, 0 AS external_count
       FROM ro_diagram_groups
       WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($4::text[])
       GROUP BY group_id`,
      [key.landscapeId, key.versionId, objectIds, groupIds],
    ),
  ])
  for (const metric of children.rows) {
    const value = result.get(`${metric.kind}:${metric.id}`)
    if (value) Object.assign(value, {
      appCount: Number(metric.app_count), storeCount: Number(metric.store_count), componentCount: Number(metric.component_count),
    })
  }
  for (const metric of connections.rows) {
    for (const kind of ['object', 'group'] as const) {
      const value = result.get(`${kind}:${metric.id}`)
      if (value) value.connectionCount = Number(metric.connection_count)
    }
  }
  for (const metric of diagrams.rows) {
    const value = result.get(`${metric.kind}:${metric.id}`)
    if (value) {
      value.diagramCount = Number(metric.diagram_count)
      value.externalDiagramCount = Number(metric.external_count)
    }
  }
  return result
}

interface ExplorerCursor extends Record<string, unknown> {
  sortOrder?: number
  score?: number
  name: string
  id: string
}

interface CacheCursor extends Record<string, unknown> {
  sortOrder: number
  id: string
}

export interface ObjectCacheInput {
  id: string
  kind: 'object' | 'group'
  name: string
  type: string
  /** The explorer's navigation parent (`effective_parent_id`: group first). */
  parentId: string | null
  /** The Model Viewer's level parent (`c4_parent_id`): the C4 parent when that
   * row exists, else null — groups play no part and a dangling parent reads as
   * a root. The offline worker indexes its levels on it. */
  c4ParentId: string | null
  childCount: number
  searchText: string
  payload: Record<string, unknown>
}

function normalizeCacheIds(ids: string[], limit = 500): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
    .slice(0, limit)
}

function mapObjectCacheRow(row: {
  id: string
  kind: 'object' | 'group'
  name: string
  type: string
  parent_id: string | null
  c4_parent_id: string | null
  child_count: string | number
  data: Record<string, unknown>
}): ObjectCacheInput {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    c4ParentId: row.c4_parent_id,
    childCount: Number(row.child_count),
    // Governed facets have dedicated postings. Keeping this bounded to the
    // identity avoids a multiplicative trigram index at 100k objects.
    searchText: row.name,
    payload: row.data,
  }
}

/** The row `roObjectCacheByIds` serves, for ids `$3` of workspace `$1`/`$2`.
 * ONE text for two readers: the endpoint, and `servedObjectRowsChangedBy`, which
 * decides which ids the change feed lists. If they could drift, the feed could
 * omit an id whose served row changed and a cache would keep the stale one. */
const OBJECT_CACHE_ROWS_BY_IDS_SQL = `
       SELECT g.id, 'group'::text AS kind, g.name, 'group'::text AS type,
              NULL::text AS parent_id, NULL::text AS c4_parent_id,
              (SELECT count(*) FROM ro_group_objects go
               WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id
                 AND go.group_id = g.id)::int AS child_count,
              g.data
       FROM ro_groups g
       WHERE g.landscape_id = $1 AND g.version_id = $2 AND g.id = ANY($3::text[])
       UNION ALL
       SELECT o.id, 'object'::text AS kind, o.name, o.type,
              o.effective_parent_id AS parent_id, o.c4_parent_id,
              (SELECT count(*) FROM ro_objects child
               WHERE child.landscape_id = o.landscape_id AND child.version_id = o.version_id
                 AND child.effective_parent_id = o.id)::int AS child_count,
              o.data
       FROM ro_objects o
       WHERE o.landscape_id = $1 AND o.version_id = $2 AND o.id = ANY($3::text[])`

/** The ids whose served row a write to `ids` can move WITHOUT being one of
 * them, read from the rows as they stand — so before the write:
 *  - children (`parent_id` in `ids`, any shard): `refreshEffectiveParents`
 *    re-roots them when a parent appears or goes;
 *  - the current effective parents of `ids`: their `child_count` moves when
 *    a child leaves, including a shared id another shard last parented;
 *  - the structural parents of `ids`: group membership takes precedence over
 *    `parent_id`, so a member leaving its group (or the group going) falls
 *    back to its parent, whose `child_count` rises — a parent that is nobody's
 *    EFFECTIVE parent before the write;
 *  - the groups holding `ids`: deleting a member drops their `child_count`.
 * A projection's own snapshot cannot name these: they live in other shards. */
export async function objectCacheNeighbourIds(
  db: Queryable,
  key: WorkspaceKey,
  ids: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (!uniqueIds.length) return []
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2 AND parent_id = ANY($3::text[])
     UNION
     SELECT effective_parent_id FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[]) AND effective_parent_id IS NOT NULL
     UNION
     SELECT parent_id FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[]) AND parent_id IS NOT NULL
     UNION
     SELECT group_id FROM ro_group_objects
     WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return rows.map((row) => row.id)
}

/** An `objects` change widened to the served cache rows its write can move
 * WITHOUT naming them (`objectCacheNeighbourIds`), read through `tx` BEFORE the
 * write. For a writer that publishes the ids it touched rather than a served-row
 * diff — the static projector. Without it, deleting or re-creating a parent
 * there moves its children's `c4ParentId` (and `parentId`) in `ro_objects`
 * while the change feed never names them, and an offline cache keeps every
 * child on its old level. Over-listing is harmless: the client refetches the
 * listed rows by id. */
export async function objectChangeWithCacheNeighbours(
  tx: Queryable,
  key: WorkspaceKey,
  change: Extract<ReadModelChangePayload, { kind: 'objects' }>,
): Promise<Extract<ReadModelChangePayload, { kind: 'objects' }>> {
  const neighbours = await objectCacheNeighbourIds(tx, key, [...change.upsertIds, ...change.deleteIds])
  const deleted = new Set(change.deleteIds)
  return {
    ...change,
    upsertIds: [...new Set([...change.upsertIds, ...neighbours.filter((id) => !deleted.has(id))])],
  }
}

/** Run `write` through `tx` and return what it did to the served object/group
 * cache rows of `seeds` (what the write names) and their neighbours. The ONE
 * place an object-feed event learns its ids, so the projection paths cannot
 * disagree about which rows they look at (`servedRowDigest.ts`). */
export function servedObjectRowsChangedBy(
  tx: Queryable,
  key: WorkspaceKey,
  seeds: readonly string[],
  write: () => Promise<void>,
): Promise<ServedRowChanges> {
  return servedRowsChangedBy(tx, key, OBJECT_CACHE_ROWS_BY_IDS_SQL,
    async () => [...seeds, ...await objectCacheNeighbourIds(tx, key, seeds)], write)
}

/** Fetch a bounded set of changed object/group identities for the incremental
 * browser cache. Missing IDs are intentional tombstones and are therefore not
 * represented in the result. Child counts are recomputed here so parent rows
 * included by the projector event refresh their disclosure chevron correctly. */
export async function roObjectCacheByIds(
  db: Queryable,
  key: WorkspaceKey,
  ids: string[],
): Promise<{ projectionGeneration: number; items: ObjectCacheInput[] }> {
  const boundedIds = normalizeCacheIds(ids)
  if (!boundedIds.length) {
    return { projectionGeneration: await projectionGeneration(db, key), items: [] }
  }
  const [{ rows }, generation] = await Promise.all([
    db.query<{
      id: string
      kind: 'object' | 'group'
      name: string
      type: string
      parent_id: string | null
      c4_parent_id: string | null
      child_count: string | number
      data: Record<string, unknown>
    }>(
      `${OBJECT_CACHE_ROWS_BY_IDS_SQL}
       ORDER BY id`,
      [key.landscapeId, key.versionId, boundedIds],
    ),
    projectionGeneration(db, key),
  ])
  return { projectionGeneration: generation, items: rows.map(mapObjectCacheRow) }
}

/** Sequential snapshot feed used only to populate the browser Worker cache.
 * It is bounded, signed, workspace-scoped, and returns normalized rows so the
 * main thread never needs to assemble the whole graph to calculate children. */
export async function roObjectCachePage(
  db: Queryable,
  key: WorkspaceKey,
  opts: { after?: string | null; limit?: number } = {},
): Promise<{ projectionGeneration: number; items: ObjectCacheInput[]; nextCursor: string | null; total?: number }> {
  const limit = Math.min(500, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 500))
  const queryHash = readModelQueryHash({
    kind: 'object-cache', landscapeId: key.landscapeId, versionId: key.versionId,
  })
  const after = opts.after
    ? decodeReadModelCursor<CacheCursor>(opts.after, { kind: 'object-cache', queryHash })
    : null
  if (after && (typeof after.sortOrder !== 'number' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid object-cache cursor payload')
  }
  const params: unknown[] = [key.landscapeId, key.versionId]
  const afterSql = after
    ? `WHERE (sort_order, id) > ($3::int, $4::text)`
    : ''
  if (after) params.push(after.sortOrder, after.id)
  params.push(limit + 1)
  const { rows } = await db.query<{
    id: string
    kind: 'object' | 'group'
    name: string
    type: string
    parent_id: string | null
    c4_parent_id: string | null
    child_count: string | number
    search_text: string
    data: Record<string, unknown>
    sort_order: string | number
  }>(
    `WITH candidates AS (
       SELECT g.id, 'group'::text AS kind, g.name, 'group'::text AS type,
              NULL::text AS parent_id, NULL::text AS c4_parent_id,
              (SELECT count(*) FROM ro_group_objects go
               WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id
                 AND go.group_id = g.id)::int AS child_count,
              g.name AS search_text, g.data, 0 AS sort_order
       FROM ro_groups g
       WHERE g.landscape_id = $1 AND g.version_id = $2
       UNION ALL
       SELECT o.id, 'object'::text AS kind, o.name, o.type,
              o.effective_parent_id AS parent_id, o.c4_parent_id,
              (SELECT count(*) FROM ro_objects child
               WHERE child.landscape_id = o.landscape_id AND child.version_id = o.version_id
                 AND child.effective_parent_id = o.id)::int AS child_count,
              o.search_document AS search_text, o.data, 1 AS sort_order
       FROM ro_objects o
       WHERE o.landscape_id = $1 AND o.version_id = $2
     )
     SELECT id, kind, name, type, parent_id, c4_parent_id, child_count, search_text, data, sort_order
     FROM candidates ${afterSql}
     ORDER BY sort_order, id
     LIMIT $${params.length}`,
    params,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const [generation, total] = await Promise.all([
    projectionGeneration(db, key),
    after ? Promise.resolve(undefined) : workspaceEntityTotal(db, key),
  ])
  return {
    projectionGeneration: generation,
    items: page.map(mapObjectCacheRow),
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({ kind: 'object-cache', queryHash, sortOrder: Number(last.sort_order), id: last.id })
      : null,
    ...(total !== undefined ? { total } : {}),
  }
}

function clampLimit(value: number | undefined): number {
  return Math.min(MAX_PAGE, Math.max(1, Number.isFinite(value) ? Math.floor(value!) : MAX_PAGE))
}

function normalizeQuery(value: string | undefined): string {
  // Keep this byte-for-byte compatible with the generated PostgreSQL column
  // (`lower(name)`). Accent folding requires the optional unaccent extension;
  // applying it on only one side would make cursor ordering and prefix matches
  // disagree for non-ASCII names.
  return (value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function likeLiteral(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1')
}

async function projectionGeneration(db: Queryable, key: WorkspaceKey): Promise<number> {
  const { rows } = await db.query<{ projected_generation: string | number }>(
    `SELECT projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return Number(rows[0]?.projected_generation ?? 0)
}

async function workspaceEntityTotal(db: Queryable, key: WorkspaceKey): Promise<number> {
  const { rows } = await db.query<{ total: string | number }>(
    `SELECT
       (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2)
       + (SELECT count(*) FROM ro_groups WHERE landscape_id = $1 AND version_id = $2) AS total`,
    [key.landscapeId, key.versionId],
  )
  return Number(rows[0]?.total ?? 0)
}

function mapExplorerRow(row: ExplorerSqlRow, metrics: ExplorerMetrics = emptyMetrics()): ObjectExplorerRow {
  const childCount = Number(row.child_count)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    type: row.type,
    parentId: row.parent_id,
    c4ParentId: row.c4_parent_id,
    childCount,
    hasChildren: childCount > 0,
    canAcceptChildren: row.kind === 'group' || row.type === 'system' || row.type === 'app' || row.type === 'store',
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.icon_assignment ? { iconAssignment: row.icon_assignment } : {}),
    ...(row.domain_id ? { domainId: row.domain_id } : {}),
    ...metrics,
    inDiagram: Boolean(row.in_diagram),
    breadcrumb: [],
  }
}

export async function roObjectTreeChildren(
  db: Queryable,
  key: WorkspaceKey,
  opts: { parentId?: string | null; diagramId?: string | null; after?: string | null; limit?: number } = {},
): Promise<ObjectExplorerPage> {
  const limit = clampLimit(opts.limit)
  const queryHash = readModelQueryHash({
    kind: 'tree',
    landscapeId: key.landscapeId,
    versionId: key.versionId,
    parentId: opts.parentId ?? null,
    diagramId: opts.diagramId ?? null,
  })
  const after = opts.after
    ? decodeReadModelCursor<ExplorerCursor>(opts.after, { kind: 'object-tree', queryHash })
    : null
  if (after && (typeof after.sortOrder !== 'number' || typeof after.name !== 'string' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid object-tree cursor payload')
  }

  const params: unknown[] = [key.landscapeId, key.versionId, opts.diagramId ?? null]
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  let candidatesSql: string
  if (!opts.parentId) {
    candidatesSql = `
      SELECT g.id, g.name, 'group'::text AS kind, 'group'::text AS type,
             NULL::text AS parent_id, NULL::text AS c4_parent_id,
             (SELECT count(*) FROM ro_group_objects go
              WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id AND go.group_id = g.id)::int AS child_count,
             NULL::text AS scope, NULL::text AS status, g.data->>'domainId' AS domain_id,
             g.data->>'icon' AS icon, g.data->'iconAssignment' AS icon_assignment,
             CASE WHEN $3::text IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM ro_group_objects go
               JOIN ro_diagram_objects dio ON dio.landscape_id = go.landscape_id AND dio.version_id = go.version_id
                 AND dio.object_id = go.object_id AND dio.diagram_id = $3
               WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id AND go.group_id = g.id
             ) END AS in_diagram,
             0 AS sort_order, g.normalized_name
      FROM ro_groups g
      WHERE g.landscape_id = $1 AND g.version_id = $2
      UNION ALL
      SELECT o.id, o.name, 'object'::text AS kind, o.type, o.effective_parent_id AS parent_id, o.c4_parent_id,
             (SELECT count(*) FROM ro_objects child
              WHERE child.landscape_id = o.landscape_id AND child.version_id = o.version_id AND child.effective_parent_id = o.id)::int AS child_count,
             o.scope, o.status, o.domain_id, o.data->>'icon' AS icon, o.data->'iconAssignment' AS icon_assignment,
             CASE WHEN $3::text IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM ro_diagram_objects dio
               WHERE dio.landscape_id = o.landscape_id AND dio.version_id = o.version_id
                 AND dio.object_id = o.id AND dio.diagram_id = $3
             ) END AS in_diagram,
             o.tree_sort_order AS sort_order,
             o.normalized_name
      FROM ro_objects o
      WHERE o.landscape_id = $1 AND o.version_id = $2
        AND o.effective_parent_id IS NULL`
  } else {
    const parent = add(opts.parentId)
    candidatesSql = `
      SELECT o.id, o.name, 'object'::text AS kind, o.type, o.effective_parent_id AS parent_id, o.c4_parent_id,
             (SELECT count(*) FROM ro_objects child
              WHERE child.landscape_id = o.landscape_id AND child.version_id = o.version_id AND child.effective_parent_id = o.id)::int AS child_count,
             o.scope, o.status, o.domain_id, o.data->>'icon' AS icon, o.data->'iconAssignment' AS icon_assignment,
             CASE WHEN $3::text IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM ro_diagram_objects dio
               WHERE dio.landscape_id = o.landscape_id AND dio.version_id = o.version_id
                 AND dio.object_id = o.id AND dio.diagram_id = $3
             ) END AS in_diagram,
             o.tree_sort_order AS sort_order,
             o.normalized_name
      FROM ro_objects o
      WHERE o.landscape_id = $1 AND o.version_id = $2
        AND o.effective_parent_id = ${parent}`
  }

  const afterSql = after
    ? `WHERE (sort_order > ${add(after.sortOrder)} OR
       (sort_order = ${add(after.sortOrder)} AND (normalized_name, id) > (${add(after.name)}, ${add(after.id)})))`
    : ''
  params.push(limit + 1)
  const { rows } = await db.query<ExplorerSqlRow>(
    `WITH candidates AS (${candidatesSql})
     SELECT id, name, kind, type, parent_id, c4_parent_id, child_count, scope, status, domain_id, icon,
            icon_assignment, in_diagram, sort_order, normalized_name
     FROM candidates ${afterSql}
     ORDER BY sort_order, normalized_name, id
     LIMIT $${params.length}`,
    params,
  )
  const page = rows.slice(0, limit)
  const [metrics, generation, total] = await Promise.all([
    metricsForRows(db, key, page),
    projectionGeneration(db, key),
    workspaceEntityTotal(db, key),
  ])
  const last = page.at(-1)
  return {
    projectionGeneration: generation,
    total,
    items: page.map((row) => mapExplorerRow(row, metrics.get(`${row.kind}:${row.id}`))),
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({
          kind: 'object-tree', queryHash,
          sortOrder: Number(last.sort_order), name: last.normalized_name, id: last.id,
        })
      : null,
  }
}

function technologyPredicate(
  tableAlias: string,
  postingTable: 'ro_object_technologies' | 'ro_group_technologies',
  entityColumn: 'object_id' | 'group_id',
  add: (value: unknown) => string,
  technologyIds: string[],
): string {
  const ids = add(technologyIds)
  return `EXISTS (
    SELECT 1 FROM ${postingTable} tech
    WHERE tech.landscape_id = ${tableAlias}.landscape_id AND tech.version_id = ${tableAlias}.version_id
      AND tech.${entityColumn} = ${tableAlias}.id
      AND (
        tech.technology_id = ANY(${ids}::text[])
        OR EXISTS (SELECT 1 FROM technology_redirects redirect
          WHERE redirect.source_technology_id = tech.technology_id AND redirect.target_technology_id = ANY(${ids}::text[]))
        OR EXISTS (SELECT 1 FROM technology_redirects redirect
          WHERE redirect.target_technology_id = tech.technology_id AND redirect.source_technology_id = ANY(${ids}::text[]))
      )
  )`
}

function tagPredicate(
  tableAlias: string,
  postingTable: 'ro_object_tags' | 'ro_group_tags',
  entityColumn: 'object_id' | 'group_id',
  add: (value: unknown) => string,
  tagIds: string[],
): string {
  const ids = add(tagIds)
  return `EXISTS (
    SELECT 1 FROM ${postingTable} tag
    WHERE tag.landscape_id = ${tableAlias}.landscape_id AND tag.version_id = ${tableAlias}.version_id
      AND tag.${entityColumn} = ${tableAlias}.id
      AND (
        tag.tag_id = ANY(${ids}::text[])
        OR EXISTS (SELECT 1 FROM tag_redirects redirect
          WHERE redirect.source_tag_id = tag.tag_id AND redirect.target_tag_id = ANY(${ids}::text[]))
        OR EXISTS (SELECT 1 FROM tag_redirects redirect
          WHERE redirect.target_tag_id = tag.tag_id AND redirect.source_tag_id = ANY(${ids}::text[]))
      )
  )`
}

async function breadcrumbs(
  db: Queryable,
  key: WorkspaceKey,
  objectIds: string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  if (!objectIds.length) return new Map()
  const { rows } = await db.query<{ origin_id: string; id: string; name: string; depth: number }>(
    `WITH RECURSIVE chain(origin_id, id, parent_id, name, depth, path) AS (
       SELECT o.id, o.id, o.parent_id, o.name, 0, ARRAY[o.id]::text[]
       FROM ro_objects o
       WHERE o.landscape_id = $1 AND o.version_id = $2 AND o.id = ANY($3::text[])
       UNION ALL
       SELECT chain.origin_id, parent.id, parent.parent_id, parent.name, chain.depth + 1, chain.path || parent.id
       FROM chain
       JOIN ro_objects parent ON parent.landscape_id = $1 AND parent.version_id = $2 AND parent.id = chain.parent_id
       WHERE chain.depth < $4 AND NOT parent.id = ANY(chain.path)
     )
     SELECT origin_id, id, name, depth FROM chain WHERE depth > 0 ORDER BY origin_id, depth DESC`,
    [key.landscapeId, key.versionId, objectIds, MAX_HIERARCHY_DEPTH],
  )
  const result = new Map<string, Array<{ id: string; name: string }>>()
  for (const row of rows) {
    const values = result.get(row.origin_id) ?? []
    values.push({ id: row.id, name: row.name })
    result.set(row.origin_id, values)
  }
  return result
}

export async function roObjectSearchPage(
  db: Queryable,
  key: WorkspaceKey,
  opts: {
    query?: string
    diagramId?: string | null
    filter?: ObjectExplorerFilter
    after?: string | null
    limit?: number
  } = {},
): Promise<ObjectExplorerPage> {
  const query = normalizeQuery(opts.query)
  const filter = opts.filter ?? {}
  const types = [...new Set(filter.types?.filter(Boolean) ?? [])].sort()
  const technologyIds = [...new Set(filter.technologyIds?.filter(Boolean) ?? [])].sort()
  const tagIds = [...new Set(filter.tagIds?.filter(Boolean) ?? [])].sort()
  const statuses = [...new Set(filter.statuses?.filter(Boolean) ?? [])].sort()
  const teamIds = [...new Set(filter.teamIds?.filter(Boolean) ?? [])].sort()
  const queryHash = readModelQueryHash({
    kind: 'search', landscapeId: key.landscapeId, versionId: key.versionId,
    query, diagramId: opts.diagramId ?? null, types, scope: filter.scope ?? null, technologyIds,
    tagIds, statuses, teamIds, hasDescription: filter.hasDescription ?? null,
    inDiagram: filter.inDiagram ?? null, domainId: filter.domainId ?? null,
    // Only when set: an absent facet keeps every pre-existing cursor's hash.
    ...(filter.externalOnSomeDiagram !== undefined ? { externalOnSomeDiagram: filter.externalOnSomeDiagram } : {}),
  })
  const after = opts.after
    ? decodeReadModelCursor<ExplorerCursor>(opts.after, { kind: 'object-search', queryHash })
    : null
  if (after && (typeof after.score !== 'number' || typeof after.name !== 'string' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid object-search cursor payload')
  }
  const limit = clampLimit(opts.limit)
  const params: unknown[] = [key.landscapeId, key.versionId, opts.diagramId ?? null]
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }
  const objectWhere = ['o.landscape_id = $1', 'o.version_id = $2']
  const groupWhere = ['g.landscape_id = $1', 'g.version_id = $2']
  const objectTypes = types.filter((type) => type !== 'group')
  if (types.length) {
    objectWhere.push(objectTypes.length ? `o.type = ANY(${add(objectTypes)}::text[])` : 'false')
    if (!types.includes('group')) groupWhere.push('false')
  }
  if (filter.scope) {
    objectWhere.push(`o.scope = ${add(filter.scope)}`)
    groupWhere.push('false')
  }
  if (technologyIds.length) {
    objectWhere.push(technologyPredicate('o', 'ro_object_technologies', 'object_id', add, technologyIds))
    groupWhere.push(technologyPredicate('g', 'ro_group_technologies', 'group_id', add, technologyIds))
  }
  if (tagIds.length) {
    objectWhere.push(tagPredicate('o', 'ro_object_tags', 'object_id', add, tagIds))
    groupWhere.push(tagPredicate('g', 'ro_group_tags', 'group_id', add, tagIds))
  }
  if (statuses.length) {
    objectWhere.push(`o.status = ANY(${add(statuses)}::text[])`)
    groupWhere.push('false')
  }
  if (teamIds.length) {
    const ids = add(teamIds)
    objectWhere.push(`EXISTS (SELECT 1 FROM ro_object_teams team
      WHERE team.landscape_id = o.landscape_id AND team.version_id = o.version_id
        AND team.object_id = o.id AND team.team_id = ANY(${ids}::text[]))`)
    groupWhere.push('false')
  }
  if (filter.hasDescription !== undefined) {
    objectWhere.push(filter.hasDescription ? `length(btrim(o.description)) > 0` : `length(btrim(o.description)) = 0`)
    groupWhere.push('false')
  }
  if (filter.inDiagram !== undefined) {
    const objectExists = `EXISTS (SELECT 1 FROM ro_diagram_objects membership
      WHERE membership.landscape_id = o.landscape_id AND membership.version_id = o.version_id
        AND membership.object_id = o.id)`
    const groupExists = `EXISTS (SELECT 1 FROM ro_diagram_groups membership
      WHERE membership.landscape_id = g.landscape_id AND membership.version_id = g.version_id
        AND membership.group_id = g.id)`
    objectWhere.push(filter.inDiagram ? objectExists : `NOT ${objectExists}`)
    groupWhere.push(filter.inDiagram ? groupExists : `NOT ${groupExists}`)
  }
  if (filter.externalOnSomeDiagram !== undefined) {
    const external = externalOnSomeDiagramSql('o')
    objectWhere.push(filter.externalOnSomeDiagram ? external : `NOT ${external}`)
    // Scope is an object property; a group is never external.
    if (filter.externalOnSomeDiagram) groupWhere.push('false')
  }
  if (filter.domainId) {
    objectWhere.push(`o.domain_id = ${add(filter.domainId)}`)
    groupWhere.push(`g.data->>'domainId' = ${add(filter.domainId)}`)
  }

  let objectScore = '1'
  let groupScore = '1'
  if (query) {
    const exact = add(query)
    const prefix = add(`${likeLiteral(query)}%`)
    const wordPrefix = add(`% ${likeLiteral(query)}%`)
    objectScore = `CASE WHEN o.normalized_name = ${exact} THEN 4
      WHEN o.normalized_name LIKE ${prefix} ESCAPE '\\' THEN 3
      WHEN o.normalized_name LIKE ${wordPrefix} ESCAPE '\\' THEN 2 ELSE 1 END`
    groupScore = `CASE WHEN g.normalized_name = ${exact} THEN 4
      WHEN g.normalized_name LIKE ${prefix} ESCAPE '\\' THEN 3
      WHEN g.normalized_name LIKE ${wordPrefix} ESCAPE '\\' THEN 2 ELSE 1 END`
    if (query.length === 2) {
      objectWhere.push(`o.normalized_name LIKE ${prefix} ESCAPE '\\'`)
      groupWhere.push(`g.normalized_name LIKE ${prefix} ESCAPE '\\'`)
    } else {
      const contains = add(`%${likeLiteral(query)}%`)
      objectWhere.push(`o.search_document LIKE ${contains} ESCAPE '\\'`)
      groupWhere.push(`g.normalized_name LIKE ${contains} ESCAPE '\\'`)
    }
  }

  const candidates = `
    SELECT o.id, o.name, 'object'::text AS kind, o.type, o.effective_parent_id AS parent_id, o.c4_parent_id,
           (SELECT count(*) FROM ro_objects child
            WHERE child.landscape_id = o.landscape_id AND child.version_id = o.version_id AND child.effective_parent_id = o.id)::int AS child_count,
           o.scope, o.status, o.domain_id, o.data->>'icon' AS icon, o.data->'iconAssignment' AS icon_assignment,
           CASE WHEN $3::text IS NULL THEN false ELSE EXISTS (
             SELECT 1 FROM ro_diagram_objects dio
             WHERE dio.landscape_id = o.landscape_id AND dio.version_id = o.version_id
               AND dio.object_id = o.id AND dio.diagram_id = $3
           ) END AS in_diagram,
           ${objectScore} AS score, o.normalized_name
    FROM ro_objects o WHERE ${objectWhere.join(' AND ')}
    UNION ALL
    SELECT g.id, g.name, 'group'::text AS kind, 'group'::text AS type, NULL::text AS parent_id, NULL::text AS c4_parent_id,
           (SELECT count(*) FROM ro_group_objects go
            WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id AND go.group_id = g.id)::int AS child_count,
           NULL::text AS scope, NULL::text AS status, g.data->>'domainId' AS domain_id, g.data->>'icon' AS icon, g.data->'iconAssignment' AS icon_assignment,
           CASE WHEN $3::text IS NULL THEN false ELSE EXISTS (
             SELECT 1 FROM ro_group_objects go
             JOIN ro_diagram_objects dio ON dio.landscape_id = go.landscape_id AND dio.version_id = go.version_id
               AND dio.object_id = go.object_id AND dio.diagram_id = $3
             WHERE go.landscape_id = g.landscape_id AND go.version_id = g.version_id AND go.group_id = g.id
           ) END AS in_diagram,
           ${groupScore} AS score, g.normalized_name
    FROM ro_groups g WHERE ${groupWhere.join(' AND ')}`
  const afterSql = after
    ? `WHERE (score < ${add(after.score)} OR
       (score = ${add(after.score)} AND (normalized_name, id) > (${add(after.name)}, ${add(after.id)})))`
    : ''
  params.push(limit + 1)
  const { rows } = await db.query<ExplorerSqlRow>(
    `WITH candidates AS (${candidates})
     SELECT id, name, kind, type, parent_id, c4_parent_id, child_count, scope, status, domain_id, icon,
            icon_assignment, in_diagram, score, normalized_name
     FROM candidates ${afterSql}
     ORDER BY score DESC, normalized_name, id
     LIMIT $${params.length}`,
    params,
  )
  const page = rows.slice(0, limit)
  const [crumbs, metrics, generation, total] = await Promise.all([
    breadcrumbs(db, key, page.filter((row) => row.kind === 'object').map((row) => row.id)),
    metricsForRows(db, key, page),
    projectionGeneration(db, key),
    workspaceEntityTotal(db, key),
  ])
  const items = page.map((row) => {
    const item = mapExplorerRow(row, metrics.get(`${row.kind}:${row.id}`))
    item.breadcrumb = crumbs.get(row.id) ?? []
    const score = Number(row.score ?? 1)
    item.matchKind = query
      ? score === 4 ? 'exact' : score === 3 ? 'prefix' : score === 2 ? 'word_prefix' : 'contains'
      : 'filter'
    return item
  })
  const last = page.at(-1)
  return {
    projectionGeneration: generation,
    total,
    items,
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({
          kind: 'object-search', queryHash,
          score: Number(last.score ?? 1), name: last.normalized_name, id: last.id,
        })
      : null,
  }
}
