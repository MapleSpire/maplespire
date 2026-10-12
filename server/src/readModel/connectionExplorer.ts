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
import { decodeReadModelCursor, encodeReadModelCursor, readModelQueryHash, ReadModelCursorError } from './cursor.js'

export type ConnectionExplorerSort = 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows'

interface ConnectionCursor extends Record<string, unknown> {
  value: string | number
  id: string
}

export interface ConnectionExplorerRow {
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

export interface ConnectionExplorerPage {
  items: ConnectionExplorerRow[]
  nextCursor: string | null
  total: number
  projectionGeneration: number
}

export interface ConnectionExplorerTiming {
  measure<T>(name: string, operation: () => Promise<T>): Promise<T>
}

interface ConnectionExplorerSqlRow extends Record<string, unknown> {
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
  sort_text: string | null
  sort_number: string | number | null
  page_total: string | number
  projected_generation: string | number
}

function mapConnectionRow(row: ConnectionExplorerSqlRow): ConnectionExplorerRow {
  return {
    connection: row.data,
    fromName: row.from_name || 'Unknown',
    ...(row.from_icon ? { fromIcon: row.from_icon } : {}),
    ...(row.from_type ? { fromType: row.from_type } : {}),
    ...(row.from_domain_id ? { fromDomainId: row.from_domain_id } : {}),
    toName: row.to_name || 'Unknown',
    ...(row.to_icon ? { toIcon: row.to_icon } : {}),
    ...(row.to_type ? { toType: row.to_type } : {}),
    ...(row.to_domain_id ? { toDomainId: row.to_domain_id } : {}),
    diagramCount: Number(row.diagram_count),
    flowCount: Number(row.flow_count),
  }
}

function normalizeSort(value: string | undefined): ConnectionExplorerSort {
  return value === 'sender' || value === 'receiver' || value === 'diagrams' || value === 'flows' ? value : 'name'
}

function likeLiteral(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1')
}

export async function roConnectionExplorerPage(
  db: Queryable,
  key: WorkspaceKey,
  opts: {
    query?: string
    domainId?: string | null
    sortBy?: ConnectionExplorerSort
    sortAsc?: boolean
    after?: string | null
    limit?: number
  } = {},
  timing?: ConnectionExplorerTiming,
): Promise<ConnectionExplorerPage> {
  const query = (opts.query ?? '').trim().toLocaleLowerCase().slice(0, 256)
  const domainId = opts.domainId?.slice(0, 256) ?? null
  const sortBy = normalizeSort(opts.sortBy)
  const sortAsc = opts.sortAsc !== false
  const limit = Math.min(100, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 50))
  const queryHash = readModelQueryHash({
    kind: 'connections', landscapeId: key.landscapeId, versionId: key.versionId,
    query, domainId, sortBy, sortAsc,
  })
  const after = opts.after
    ? decodeReadModelCursor<ConnectionCursor>(opts.after, { kind: 'connection-page', queryHash })
    : null
  const numericSort = sortBy === 'diagrams' || sortBy === 'flows'
  if (after && (typeof after.id !== 'string' || (numericSort ? typeof after.value !== 'number' : typeof after.value !== 'string'))) {
    throw new ReadModelCursorError('Invalid connection cursor payload')
  }

  const params: unknown[] = [key.landscapeId, key.versionId]
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }
  const baseWhere = ['c.landscape_id = $1', 'c.version_id = $2']
  const pattern = query ? add(`%${likeLiteral(query)}%`) : null
  // A three-or-more-character substring has selective trigrams. Express each
  // searchable column as its own indexed arm, then de-duplicate the small ID
  // set before enriching it. Using the joined predicate for one/two
  // characters avoids asking pg_trgm to return virtually the whole index for
  // patterns that contain no complete trigram.
  const indexedSearch = Boolean(pattern && query.length >= 3)
  if (pattern && !indexedSearch) {
    baseWhere.push(`(c.normalized_label LIKE ${pattern} ESCAPE '\\'
      OR s.normalized_from_name LIKE ${pattern} ESCAPE '\\'
      OR s.normalized_to_name LIKE ${pattern} ESCAPE '\\')`)
  }
  let domainParam: string | null = null
  if (domainId) {
    domainParam = add(domainId)
    baseWhere.push(`(s.from_domain_id = ${domainParam} OR s.to_domain_id = ${domainParam})`)
  }
  const countParams = [...params]
  const searchCte = indexedSearch
    ? `WITH matched_connections AS MATERIALIZED (
         SELECT search_connection.id AS connection_id
         FROM ro_connections search_connection
         WHERE search_connection.landscape_id = $1 AND search_connection.version_id = $2
           AND lower(search_connection.label) LIKE ${pattern} ESCAPE '\\'
         UNION
         SELECT search_stats.connection_id
         FROM ro_connection_stats search_stats
         WHERE search_stats.landscape_id = $1 AND search_stats.version_id = $2
           AND search_stats.normalized_from_name LIKE ${pattern} ESCAPE '\\'
         UNION
         SELECT search_stats.connection_id
         FROM ro_connection_stats search_stats
         WHERE search_stats.landscape_id = $1 AND search_stats.version_id = $2
           AND search_stats.normalized_to_name LIKE ${pattern} ESCAPE '\\'
       )`
    : ''
  const sortExpression: Record<ConnectionExplorerSort, string> = {
    name: 'c.normalized_label',
    sender: 's.normalized_from_name',
    receiver: 's.normalized_to_name',
    diagrams: 's.diagram_count',
    flows: 's.flow_count',
  }
  const sortValue = sortExpression[sortBy]
  const pageWhere = [...baseWhere]
  if (after) {
    const valueParam = add(after.value)
    const idParam = add(after.id)
    const comparison = sortAsc ? '>' : '<'
    pageWhere.push(numericSort
      ? `(${sortValue}, c.id COLLATE "C") ${comparison}
         (${valueParam}::integer, ${idParam}::text COLLATE "C")`
      : `(${sortValue} COLLATE "C", c.id COLLATE "C") ${comparison}
         (${valueParam}::text COLLATE "C", ${idParam}::text COLLATE "C")`)
  }
  params.push(limit + 1)
  const direction = sortAsc ? 'ASC' : 'DESC'
  const order = numericSort
    ? `${sortValue} ${direction}, c.id COLLATE "C" ${direction}`
    : `${sortValue} COLLATE "C" ${direction}, c.id COLLATE "C" ${direction}`
  const hasFilters = Boolean(query || domainId)
  const totalExpression = indexedSearch
    ? domainParam
      ? `(SELECT count(*)
          FROM matched_connections count_match
          JOIN ro_connection_stats count_stats
            ON count_stats.landscape_id = $1 AND count_stats.version_id = $2
           AND count_stats.connection_id = count_match.connection_id
          WHERE count_stats.from_domain_id = ${domainParam}
             OR count_stats.to_domain_id = ${domainParam})`
      : `(SELECT count(*) FROM matched_connections)`
    : hasFilters
      ? `(SELECT count(*)
        FROM ro_connections c JOIN ro_connection_stats s
          ON s.landscape_id = c.landscape_id AND s.version_id = c.version_id
         AND s.connection_id = c.id
        WHERE ${baseWhere.join(' AND ')})`
      : `COALESCE((SELECT connection_count FROM ro_workspace_stats
                 WHERE landscape_id = $1 AND version_id = $2), 0)`
  const generationExpression = `COALESCE((SELECT projected_generation
      FROM read_model_projection_state
      WHERE landscape_id = $1 AND version_id = $2), 0)`

  const measure = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
    timing ? timing.measure(name, operation) : operation()
  // The production route passes one checked-out client. Populated pages carry
  // page, total and generation in this one statement, so no transaction or
  // overlapping client-side query queue is needed. Only an empty page performs
  // the bounded metadata fallback below.
  const pageResult = await measure('page_sql', () =>
    db.query<ConnectionExplorerSqlRow>(
      `${searchCte}
       SELECT c.id, c.data,
              s.from_name, s.from_icon, s.from_type, s.from_domain_id,
              s.to_name, s.to_icon, s.to_type, s.to_domain_id,
              s.diagram_count, s.flow_count,
              ${numericSort ? 'NULL::text' : `${sortValue}::text`} AS sort_text,
              ${numericSort ? `${sortValue}::integer` : 'NULL::integer'} AS sort_number,
              ${totalExpression} AS page_total,
              ${generationExpression} AS projected_generation
       FROM ${sortBy === 'name' ? 'ro_connections c JOIN ro_connection_stats s' : 'ro_connection_stats s JOIN ro_connections c'}
         ON s.landscape_id = c.landscape_id AND s.version_id = c.version_id
        AND s.connection_id = c.id
       ${indexedSearch ? 'JOIN matched_connections matched ON matched.connection_id = c.id' : ''}
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY ${order}
       LIMIT $${params.length}`,
      params,
    ))
  // A normal page needs one PostgreSQL statement. When a
  // cursor/filter produces an empty page, fetch the same two scalar values in
  // one bounded fallback statement so empty results retain an exact total and
  // projection generation.
  const metadata = pageResult.rows[0] ?? (await measure('metadata_sql', () =>
    db.query<{ page_total: string | number; projected_generation: string | number }>(
      `${searchCte}
       SELECT ${totalExpression} AS page_total,
              ${generationExpression} AS projected_generation`,
      countParams,
    ))).rows[0]
  const page = pageResult.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(mapConnectionRow),
    nextCursor: pageResult.rows.length > limit && last
      ? encodeReadModelCursor({
          kind: 'connection-page', queryHash,
          value: numericSort ? Number(last.sort_number) : (last.sort_text ?? ''), id: last.id,
        })
      : null,
    total: Number(metadata?.page_total ?? 0),
    projectionGeneration: Number(metadata?.projected_generation ?? 0),
  }
}
