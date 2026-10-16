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

import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'
import { decodeReadModelCursor, encodeReadModelCursor, readModelQueryHash, ReadModelCursorError } from './cursor.js'
import { servedRowsChangedBy, type ServedRowChanges } from './servedRowDigest.js'

export interface OfflineCacheEstimate {
  objectCount: number
  groupCount: number
  connectionCount: number
  diagramCount?: number
  diagramMembershipCount?: number
  rawPayloadBytes: number
  searchCharacters: number
  estimatedBytes: number
}

export function estimateBrowserCacheBytes(input: Omit<OfflineCacheEstimate, 'estimatedBytes'>): number {
  const entityCount = input.objectCount + input.groupCount
  // IndexedDB records carry JS-structured key/value overhead. Search postings are
  // the dominant multiplier: one bounded name trigram posting is roughly 96 bytes
  // after workspace/generation/id metadata. Keep a 25% safety margin for browser
  // implementation differences and B-tree pages.
  const modeled = input.rawPayloadBytes
    + input.searchCharacters * 96
    + entityCount * 512
    + input.connectionCount * 384
    + (input.diagramCount ?? 0) * 384
    + (input.diagramMembershipCount ?? 0) * 48
  return Math.ceil(modeled * 1.25)
}

export async function roOfflineCacheEstimate(db: Queryable, key: WorkspaceKey): Promise<OfflineCacheEstimate> {
  const { rows } = await db.query<{
    object_count: string | number
    group_count: string | number
    connection_count: string | number
    diagram_count: string | number
    diagram_membership_count: string | number
    payload_bytes: string | number
    search_characters: string | number
  }>(
    `SELECT
       (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2) AS object_count,
       (SELECT count(*) FROM ro_groups WHERE landscape_id = $1 AND version_id = $2) AS group_count,
       (SELECT count(*) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2) AS connection_count,
       (SELECT count(*) FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2) AS diagram_count,
       COALESCE((SELECT sum(cardinality(object_ids)
                         + jsonb_array_length(COALESCE(data->'connectionIds', '[]'::jsonb))
                         + jsonb_array_length(COALESCE(data->'groupIds', '[]'::jsonb)))
                 FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2), 0)
         AS diagram_membership_count,
       COALESCE((SELECT sum(pg_column_size(data)) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2), 0)
         + COALESCE((SELECT sum(pg_column_size(data)) FROM ro_groups WHERE landscape_id = $1 AND version_id = $2), 0)
         + COALESCE((SELECT sum(pg_column_size(data)) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2), 0)
         + COALESCE((SELECT sum(pg_column_size(data)) FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2), 0)
         AS payload_bytes,
       COALESCE((SELECT sum(length(name)) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2), 0)
         + COALESCE((SELECT sum(length(name)) FROM ro_groups WHERE landscape_id = $1 AND version_id = $2), 0)
         AS search_characters`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  const base = {
    objectCount: Number(row?.object_count ?? 0),
    groupCount: Number(row?.group_count ?? 0),
    connectionCount: Number(row?.connection_count ?? 0),
    diagramCount: Number(row?.diagram_count ?? 0),
    diagramMembershipCount: Number(row?.diagram_membership_count ?? 0),
    rawPayloadBytes: Number(row?.payload_bytes ?? 0),
    searchCharacters: Number(row?.search_characters ?? 0),
  }
  return { ...base, estimatedBytes: estimateBrowserCacheBytes(base) }
}

interface ConnectionCacheCursor extends Record<string, unknown> {
  id: string
}

export interface ConnectionCacheInput {
  connection: Record<string, unknown>
  fromName: string
  fromIcon?: string
  fromType?: string
  fromDomainId?: string
  toName: string
  toIcon?: string
  toType?: string
  toDomainId?: string
  diagramCount: number
  flowCount: number
}

interface ConnectionCacheSqlRow extends Record<string, unknown> {
  id: string
  data: Record<string, unknown>
  from_name: string
  from_icon: string | null
  from_type: string | null
  from_domain_id: string | null
  to_name: string
  to_icon: string | null
  to_type: string | null
  to_domain_id: string | null
  diagram_count: string | number
  flow_count: string | number
}

function mapConnectionCacheRow(row: ConnectionCacheSqlRow): ConnectionCacheInput {
  return {
    connection: row.data,
    fromName: row.from_name,
    ...(row.from_icon ? { fromIcon: row.from_icon } : {}),
    ...(row.from_type ? { fromType: row.from_type } : {}),
    ...(row.from_domain_id ? { fromDomainId: row.from_domain_id } : {}),
    toName: row.to_name,
    ...(row.to_icon ? { toIcon: row.to_icon } : {}),
    ...(row.to_type ? { toType: row.to_type } : {}),
    ...(row.to_domain_id ? { toDomainId: row.to_domain_id } : {}),
    diagramCount: Number(row.diagram_count),
    flowCount: Number(row.flow_count),
  }
}

const connectionCacheSelect = (pageSql: string) => `WITH page AS (${pageSql})
  SELECT page.id, page.data,
         COALESCE(from_object.name, from_group.name, 'Unknown') AS from_name,
         COALESCE(from_object.data->>'icon', from_group.data->>'icon') AS from_icon,
         from_object.type AS from_type,
         COALESCE(from_object.domain_id, from_group.data->>'domainId') AS from_domain_id,
         COALESCE(to_object.name, to_group.name, 'Unknown') AS to_name,
         COALESCE(to_object.data->>'icon', to_group.data->>'icon') AS to_icon,
         to_object.type AS to_type,
         COALESCE(to_object.domain_id, to_group.data->>'domainId') AS to_domain_id,
         (SELECT count(*) FROM ro_diagram_connections dc
          WHERE dc.landscape_id = $1 AND dc.version_id = $2 AND dc.connection_id = page.id)::int AS diagram_count,
         (SELECT count(DISTINCT cf.flow_id) FROM ro_connection_flows cf
          WHERE cf.landscape_id = $1 AND cf.version_id = $2 AND cf.connection_id = page.id)::int AS flow_count
  FROM page
  LEFT JOIN ro_objects from_object ON from_object.landscape_id = $1
    AND from_object.version_id = $2 AND from_object.id = page.from_id
  LEFT JOIN ro_groups from_group ON from_group.landscape_id = $1
    AND from_group.version_id = $2 AND from_group.id = page.from_id
  LEFT JOIN ro_objects to_object ON to_object.landscape_id = $1
    AND to_object.version_id = $2 AND to_object.id = page.to_id
  LEFT JOIN ro_groups to_group ON to_group.landscape_id = $1
    AND to_group.version_id = $2 AND to_group.id = page.to_id
  ORDER BY page.id`

/** The row `roConnectionCacheByIds` serves, for ids `$3`. ONE text for the
 * endpoint and for `servedConnectionRowsChangedBy`, which decides which ids a
 * connection-feed event names. */
const CONNECTION_CACHE_ROWS_BY_IDS_SQL = connectionCacheSelect(
  `SELECT c.id, c.from_id, c.to_id, c.data
   FROM ro_connections c
   WHERE c.landscape_id = $1 AND c.version_id = $2 AND c.id = ANY($3::text[])`,
)

/** Run `write` through `tx` and return what it did to the served connection
 * cache rows of `candidates`. A connection's served row moves with its own
 * data, its endpoints' name/icon/type/domain, and its diagram and flow counts.
 * Endpoint changes are NOT candidates here: an objects event already makes a
 * cache refresh the connections adjacent to the ids it names
 * (`fetchAdjacentConnections`), so the connection feed covers the rest. */
export function servedConnectionRowsChangedBy(
  tx: Queryable,
  key: WorkspaceKey,
  candidates: readonly string[] | (() => Promise<readonly string[]>),
  write: () => Promise<void>,
): Promise<ServedRowChanges> {
  return servedRowsChangedBy(tx, key, CONNECTION_CACHE_ROWS_BY_IDS_SQL, candidates, write)
}

/** Per connection, the two served columns `connectionCacheSelect` derives from
 * diagram membership and flows — `diagram_count` and `flow_count`, computed
 * the same way — for every connection that has either. A full sync of the
 * diagram registry rewrites both tables for the whole workspace and moves NO
 * other served column (data and endpoints come from shards and objects), so
 * the difference of two of these maps IS the set of connection rows it moved.
 * Keep the two expressions in step with `connectionCacheSelect`. */
export async function connectionMembershipCounts(db: Queryable, key: WorkspaceKey): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; diagram_count: string | number; flow_count: string | number }>(
    `SELECT id, sum(diagram_count)::int AS diagram_count, sum(flow_count)::int AS flow_count FROM (
       SELECT connection_id AS id, count(*) AS diagram_count, 0 AS flow_count
       FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2
       GROUP BY connection_id
       UNION ALL
       SELECT connection_id AS id, 0 AS diagram_count, count(DISTINCT flow_id) AS flow_count
       FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2
       GROUP BY connection_id
     ) AS counts GROUP BY id`,
    [key.landscapeId, key.versionId],
  )
  return new Map(rows.map((row) => [row.id, `${Number(row.diagram_count)}:${Number(row.flow_count)}`]))
}

/** Bounded point lookup used by the incremental cache feed. The same enriched
 * row contract as the snapshot feed prevents the main thread from resolving
 * endpoint names or scanning connection membership after a change. */
export async function roConnectionCacheByIds(
  db: Queryable,
  key: WorkspaceKey,
  ids: string[],
): Promise<{ projectionGeneration: number; items: ConnectionCacheInput[] }> {
  const boundedIds = [...new Set(ids.filter(Boolean))].slice(0, 500)
  const generationPromise = db.query<{ projected_generation: string | number }>(
    `SELECT projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  if (!boundedIds.length) {
    const generationResult = await generationPromise
    return { projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0), items: [] }
  }
  const [{ rows }, generationResult] = await Promise.all([
    db.query<ConnectionCacheSqlRow>(CONNECTION_CACHE_ROWS_BY_IDS_SQL, [key.landscapeId, key.versionId, boundedIds]),
    generationPromise,
  ])
  return {
    projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0),
    items: rows.map(mapConnectionCacheRow),
  }
}

/** Refresh every cached connection whose endpoint metadata may have changed
 * after an object/group rename, icon change or deletion. It is cursor-paged so
 * a hub with tens of thousands of edges remains a bounded operation. */
export async function roConnectionCacheByEndpointIds(
  db: Queryable,
  key: WorkspaceKey,
  ids: string[],
  opts: { after?: string | null; limit?: number } = {},
): Promise<{
  projectionGeneration: number
  items: ConnectionCacheInput[]
  nextCursor: string | null
}> {
  const endpointIds = [...new Set(ids.filter(Boolean))].sort().slice(0, 100)
  const limit = Math.min(500, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 500))
  const queryHash = readModelQueryHash({
    kind: 'connection-cache-by-endpoints',
    landscapeId: key.landscapeId,
    versionId: key.versionId,
    endpointIds,
  })
  const after = opts.after
    ? decodeReadModelCursor<ConnectionCacheCursor>(opts.after, { kind: 'connection-cache-by-endpoints', queryHash })
    : null
  if (after && typeof after.id !== 'string') throw new ReadModelCursorError('Invalid endpoint connection-cache cursor')
  const generationPromise = db.query<{ projected_generation: string | number }>(
    `SELECT projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  if (!endpointIds.length) {
    const generationResult = await generationPromise
    return {
      projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0),
      items: [],
      nextCursor: null,
    }
  }
  const params: unknown[] = [key.landscapeId, key.versionId, endpointIds]
  const afterSql = after ? `AND c.id > $4` : ''
  if (after) params.push(after.id)
  params.push(limit + 1)
  const [{ rows }, generationResult] = await Promise.all([
    db.query<ConnectionCacheSqlRow>(connectionCacheSelect(
      `SELECT c.id, c.from_id, c.to_id, c.data
       FROM ro_connections c
       WHERE c.landscape_id = $1 AND c.version_id = $2
         AND (c.from_id = ANY($3::text[]) OR c.to_id = ANY($3::text[]))
         ${afterSql}
       ORDER BY c.id
       LIMIT $${params.length}`,
    ), params),
    generationPromise,
  ])
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0),
    items: page.map(mapConnectionCacheRow),
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({ kind: 'connection-cache-by-endpoints', queryHash, id: last.id })
      : null,
  }
}

/** ID-keyset snapshot feed. Unlike the interactive connection table query, the
 * expensive endpoint/count enrichment runs only for the current page, never for
 * all 300k connections on every cursor. */
export async function roConnectionCachePage(
  db: Queryable,
  key: WorkspaceKey,
  opts: { after?: string | null; limit?: number } = {},
): Promise<{
  projectionGeneration: number
  items: ConnectionCacheInput[]
  nextCursor: string | null
  total?: number
}> {
  const limit = Math.min(500, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 500))
  const queryHash = readModelQueryHash({
    kind: 'connection-cache', landscapeId: key.landscapeId, versionId: key.versionId,
  })
  const after = opts.after
    ? decodeReadModelCursor<ConnectionCacheCursor>(opts.after, { kind: 'connection-cache', queryHash })
    : null
  if (after && typeof after.id !== 'string') throw new ReadModelCursorError('Invalid connection-cache cursor')
  const params: unknown[] = [key.landscapeId, key.versionId]
  const afterSql = after ? `AND c.id > $3` : ''
  if (after) params.push(after.id)
  params.push(limit + 1)
  const [{ rows }, generationResult, totalResult] = await Promise.all([
    db.query<ConnectionCacheSqlRow>(
      connectionCacheSelect(`
         SELECT c.id, c.from_id, c.to_id, c.data
         FROM ro_connections c
         WHERE c.landscape_id = $1 AND c.version_id = $2 ${afterSql}
         ORDER BY c.id
         LIMIT $${params.length}
      `),
      params,
    ),
    db.query<{ projected_generation: string | number }>(
      `SELECT projected_generation FROM read_model_projection_state
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    ),
    after
      ? Promise.resolve(null)
      : db.query<{ total: string | number }>(
        `SELECT count(*) AS total FROM ro_connections WHERE landscape_id = $1 AND version_id = $2`,
        [key.landscapeId, key.versionId],
      ),
  ])
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0),
    items: page.map(mapConnectionCacheRow),
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({ kind: 'connection-cache', queryHash, id: last.id })
      : null,
    ...(totalResult ? { total: Number(totalResult.rows[0]?.total ?? 0) } : {}),
  }
}
