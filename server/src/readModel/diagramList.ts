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

type Json = Record<string, unknown>

interface DiagramCursor extends Record<string, unknown> {
  name: string
  id: string
}

interface DiagramSummaryRow extends Record<string, unknown> {
  diagram_id: string
  normalized_name: string
  object_count: number
  connection_count: number
  group_count: number
  preview_object_ids: string[]
  preview_object_types: string[]
  data: Json
  page_total: string | number
}

function likePattern(query: string): string {
  return `%${query.replace(/([%_\\])/g, '\\$1')}%`
}

export async function roDiagramListPage(
  db: Queryable,
  key: WorkspaceKey,
  options: {
    /** Kept in the response contract during rollout; navigation itself is keyset-only. */
    offset?: number
    limit?: number
    query?: string
    type?: string
    domainId?: string
    after?: string | null
  } = {},
): Promise<{
  total: number
  offset: number
  limit: number
  nextOffset: number | null
  nextCursor: string | null
  items: Json[]
}> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 60)))
  const query = options.query?.trim().toLocaleLowerCase().slice(0, 256) ?? ''
  const type = options.type?.slice(0, 128) ?? ''
  const domainId = options.domainId?.slice(0, 256) ?? ''
  const queryHash = readModelQueryHash({
    kind: 'diagram-list', landscapeId: key.landscapeId, versionId: key.versionId,
    query, type, domainId,
  })
  const after = options.after
    ? decodeReadModelCursor<DiagramCursor>(options.after, { kind: 'diagram-list-page', queryHash })
    : null
  if (after && (typeof after.name !== 'string' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid diagram-list cursor')
  }

  const params: unknown[] = [key.landscapeId, key.versionId]
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }
  const where = ['summary.landscape_id = $1', 'summary.version_id = $2']
  if (query) where.push(`summary.normalized_name LIKE ${add(likePattern(query))} ESCAPE '\\'`)
  if (type) where.push(`summary.type = ${add(type)}`)
  if (domainId) where.push(`summary.domain_id = ${add(domainId)}`)
  const countParams = [...params]
  if (after) {
    const nameParam = add(after.name)
    const idParam = add(after.id)
    where.push(`(summary.normalized_name COLLATE "C", summary.diagram_id COLLATE "C")
      > (${nameParam}::text COLLATE "C", ${idParam}::text COLLATE "C")`)
  }
  params.push(limit + 1)
  const hasFilters = Boolean(query || type || domainId)
  const totalExpression = hasFilters
    ? `(SELECT count(*) FROM ro_diagram_summaries summary
        WHERE ${where.filter((clause) => !clause.includes('summary.diagram_id COLLATE')).join(' AND ')})`
    : `COALESCE((SELECT diagram_count FROM ro_workspace_stats
                 WHERE landscape_id = $1 AND version_id = $2), 0)`

  const pageResult = await db.query<DiagramSummaryRow>(
      `SELECT summary.diagram_id, summary.normalized_name, summary.object_count,
              summary.connection_count, summary.group_count,
              summary.preview_object_ids, summary.preview_object_types, summary.data,
              ${totalExpression} AS page_total
       FROM ro_diagram_summaries summary
       WHERE ${where.join(' AND ')}
       ORDER BY summary.normalized_name COLLATE "C", summary.diagram_id COLLATE "C"
       LIMIT $${params.length}`,
      params,
    )
  // Populated pages carry their exact total in the same snapshot and consume
  // one pool slot. Only a legitimately empty page needs the bounded metadata
  // fallback.
  const total = pageResult.rows[0]?.page_total ?? (await db.query<{ total: string | number }>(
    `SELECT ${totalExpression} AS total`,
    countParams,
  )).rows[0]?.total
  const page = pageResult.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    total: Number(total ?? 0),
    offset: 0,
    limit,
    nextOffset: null,
    nextCursor: pageResult.rows.length > limit && last
      ? encodeReadModelCursor({
          kind: 'diagram-list-page', queryHash,
          name: last.normalized_name, id: last.diagram_id,
        })
      : null,
    items: page.map((row) => ({
      ...row.data,
      objectCount: Number(row.object_count),
      connectionCount: Number(row.connection_count),
      groupCount: Number(row.group_count),
      previewObjectIds: row.preview_object_ids,
      previewObjectTypes: row.preview_object_types,
      // Transitional compact aliases: old clients still see arrays, but never
      // receive the full 500-shape membership through this list endpoint.
      objectIds: row.preview_object_ids,
      connectionIds: [],
      groupIds: [],
    })),
  }
}
