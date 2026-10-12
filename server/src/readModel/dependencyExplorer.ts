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
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
  readModelQueryHash,
  ReadModelCursorError,
} from './cursor.js'

export type DependencyDirection = 'incoming' | 'outgoing'

export interface DependencyPeerRow {
  peerId: string
  peerKind: 'object' | 'group' | 'unknown'
  peer: Record<string, unknown>
  representativeConnection: Record<string, unknown>
  connectionCount: number
  directCount: number
  lowerCount: number
}

interface DependencyCursor extends Record<string, unknown> {
  connectionCount: number
  name: string
  id: string
}

function searchLiteral(value: string | undefined): string {
  const normalized = (value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  return normalized ? `%${normalized.replace(/([%_\\])/g, '\\$1')}%` : ''
}

/**
 * Aggregate a focus node's fan-out inside PostgreSQL. Only one representative
 * connection and one peer payload cross the network; exact counts remain
 * server-side, so the client never materializes every incident edge.
 */
export async function roDependencyPeerPage(
  db: Queryable,
  key: WorkspaceKey,
  opts: {
    focusId: string
    direction: DependencyDirection
    search?: string
    globalSearch?: string
    domainId?: string | null
    after?: string | null
    limit?: number
  },
): Promise<{
  projectionGeneration: number
  items: DependencyPeerRow[]
  nextCursor: string | null
  totalPeers: number
  totalConnections: number
}> {
  const limit = Math.min(50, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 10))
  const focusId = opts.focusId.slice(0, 256)
  const search = searchLiteral(opts.search)
  const globalSearch = searchLiteral(opts.globalSearch)
  const domainId = opts.domainId?.slice(0, 256) || null
  const queryHash = readModelQueryHash({
    kind: 'dependency-peers',
    landscapeId: key.landscapeId,
    versionId: key.versionId,
    focusId,
    direction: opts.direction,
    search,
    globalSearch,
    domainId,
  })
  const after = opts.after
    ? decodeReadModelCursor<DependencyCursor>(opts.after, { kind: 'dependency-peers', queryHash })
    : null
  if (after && (
    typeof after.connectionCount !== 'number'
    || typeof after.name !== 'string'
    || typeof after.id !== 'string'
  )) throw new ReadModelCursorError('Invalid dependency cursor')

  const peerColumn = opts.direction === 'incoming' ? 'c.from_id' : 'c.to_id'
  const focusPredicate = opts.direction === 'incoming'
    ? 'c.to_id = $3 AND c.from_id <> $3'
    : 'c.from_id = $3 AND c.to_id <> $3'
  const params: unknown[] = [key.landscapeId, key.versionId, focusId, search, globalSearch, domainId]
  const afterSql = after
    ? `WHERE connection_count < $7
       OR (connection_count = $7 AND (normalized_name, peer_id) > ($8, $9))`
    : ''
  if (after) params.push(after.connectionCount, after.name, after.id)
  params.push(limit + 1)

  const { rows } = await db.query<{
      peer_id: string
      peer_kind: 'object' | 'group' | 'unknown'
      peer_data: Record<string, unknown>
      representative_connection: Record<string, unknown>
      connection_count: string | number
      direct_count: string | number
      lower_count: string | number
      normalized_name: string
      total_peers: string | number
      total_connections: string | number
      projected_generation: string | number
    }>(
      `WITH edges AS (
         SELECT c.id, c.data, c.label, c.kind, ${peerColumn} AS peer_id
         FROM ro_connections c
         WHERE c.landscape_id = $1 AND c.version_id = $2 AND ${focusPredicate}
       ), aggregated AS (
         SELECT e.peer_id,
                CASE WHEN o.id IS NOT NULL THEN 'object'
                     WHEN g.id IS NOT NULL THEN 'group' ELSE 'unknown' END AS peer_kind,
                COALESCE(o.data, g.data,
                  jsonb_build_object('id', e.peer_id, 'name', 'Unknown')) AS peer_data,
                lower(COALESCE(o.name, g.name, 'Unknown')) AS normalized_name,
                count(*)::int AS connection_count,
                count(*) FILTER (WHERE e.kind IS DISTINCT FROM 'lower')::int AS direct_count,
                count(*) FILTER (WHERE e.kind = 'lower')::int AS lower_count,
                (array_agg(e.data ORDER BY CASE WHEN e.kind = 'lower' THEN 1 ELSE 0 END, e.id))[1]
                  AS representative_connection
         FROM edges e
         LEFT JOIN ro_objects o ON o.landscape_id = $1 AND o.version_id = $2 AND o.id = e.peer_id
         LEFT JOIN ro_groups g ON g.landscape_id = $1 AND g.version_id = $2 AND g.id = e.peer_id
         WHERE ($6::text IS NULL OR COALESCE(o.domain_id, g.data->>'domainId') = $6)
         GROUP BY e.peer_id, o.id, o.data, o.name, g.id, g.data, g.name
         HAVING ($4 = '' OR lower(COALESCE(o.name, g.name, 'Unknown')) LIKE $4 ESCAPE '\\'
                           OR bool_or(lower(COALESCE(e.label, '')) LIKE $4 ESCAPE '\\'))
            AND ($5 = '' OR lower(COALESCE(o.name, g.name, 'Unknown')) LIKE $5 ESCAPE '\\'
                           OR bool_or(lower(COALESCE(e.label, '')) LIKE $5 ESCAPE '\\'))
       ), ranked AS (
         SELECT *, count(*) OVER ()::int AS total_peers,
                   sum(connection_count) OVER ()::bigint AS total_connections
         FROM aggregated
       )
       SELECT ranked.*,
              COALESCE((SELECT projected_generation
                        FROM read_model_projection_state
                        WHERE landscape_id = $1 AND version_id = $2), 0)
                AS projected_generation
       FROM ranked
       ${afterSql}
       ORDER BY connection_count DESC, normalized_name, peer_id
       LIMIT $${params.length}`,
      params,
    )
  const projectionGeneration = rows[0]?.projected_generation ?? (await db.query<{
    projected_generation: string | number
  }>(
      `SELECT projected_generation FROM read_model_projection_state
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    )).rows[0]?.projected_generation
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    projectionGeneration: Number(projectionGeneration ?? 0),
    items: page.map((row) => ({
      peerId: row.peer_id,
      peerKind: row.peer_kind,
      peer: row.peer_data,
      representativeConnection: row.representative_connection,
      connectionCount: Number(row.connection_count),
      directCount: Number(row.direct_count),
      lowerCount: Number(row.lower_count),
    })),
    nextCursor: rows.length > limit && last
      ? encodeReadModelCursor({
        kind: 'dependency-peers',
        queryHash,
        connectionCount: Number(last.connection_count),
        name: last.normalized_name,
        id: last.peer_id,
      })
      : null,
    totalPeers: Number(rows[0]?.total_peers ?? 0),
    totalConnections: Number(rows[0]?.total_connections ?? 0),
  }
}
