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

interface DecisionCursor extends Record<string, unknown> {
  createdAt: string
  id: string
}

export interface DecisionRecordSummaryPayload {
  id: string
  number: number
  title: string
  summary: string
  status: string
  author: string
  createdAt: string
  updatedAt: string
}

interface DecisionRecordSummaryRow extends Record<string, unknown> {
  id: string
  adr_number: number | null
  title: string
  summary: string
  status: string
  author: string
  sort_created_at: string
  created_at: string
  updated_at: string
  page_total: string | number
}

function likePattern(query: string): string {
  return `%${query.replace(/([%_\\])/g, '\\$1')}%`
}

export async function roDecisionRecordPage(
  db: Queryable,
  key: WorkspaceKey,
  optionsOrOffset: {
    query?: string
    status?: string
    relatedTargetId?: string
    relatedType?: string
    after?: string | null
    limit?: number
    offset?: number
  } | number = {},
  legacyLimit?: number,
): Promise<{
  paged: true
  serverFiltered: true
  total: number
  offset: number
  limit: number
  nextOffset: number | null
  nextCursor: string | null
  detailsIncluded: false
  items: DecisionRecordSummaryPayload[]
}> {
  const options = typeof optionsOrOffset === 'number'
    ? { offset: optionsOrOffset, limit: legacyLimit }
    : optionsOrOffset
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
  const query = options.query?.trim().toLocaleLowerCase().slice(0, 256) ?? ''
  const status = options.status?.slice(0, 128) ?? ''
  const relatedTargetId = options.relatedTargetId?.trim().slice(0, 256) ?? ''
  const relatedType = options.relatedType?.trim().slice(0, 64) ?? ''
  const queryHash = readModelQueryHash({
    kind: 'decision-records', landscapeId: key.landscapeId, versionId: key.versionId,
    query, status, relatedTargetId, relatedType,
  })
  const after = options.after
    ? decodeReadModelCursor<DecisionCursor>(options.after, { kind: 'decision-record-page', queryHash })
    : null
  if (after && (typeof after.createdAt !== 'string' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid decision-record cursor')
  }

  const params: unknown[] = [key.landscapeId, key.versionId]
  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }
  const baseWhere = ['record.landscape_id = $1', 'record.version_id = $2']
  if (query) baseWhere.push(`record.search_document LIKE ${add(likePattern(query))} ESCAPE '\\'`)
  if (status) baseWhere.push(`record.status = ${add(status)}`)
  if (relatedTargetId) {
    baseWhere.push(`record.data @> ${add(JSON.stringify({
      related: [{
        targetId: relatedTargetId,
        ...(relatedType ? { type: relatedType } : {}),
      }],
    }))}::jsonb`)
  }
  const countParams = [...params]
  const pageWhere = [...baseWhere]
  if (after) {
    const createdParam = add(after.createdAt)
    const idParam = add(after.id)
    pageWhere.push(`(record.created_at COLLATE "C", record.id COLLATE "C")
      < (${createdParam}::text COLLATE "C", ${idParam}::text COLLATE "C")`)
  }
  params.push(limit + 1)
  const hasFilters = Boolean(query || status || relatedTargetId)
  const totalExpression = hasFilters
    ? `(SELECT count(*) FROM ro_decision_records record WHERE ${baseWhere.join(' AND ')})`
    : `COALESCE((SELECT decision_record_count FROM ro_workspace_stats
                 WHERE landscape_id = $1 AND version_id = $2), 0)`
  const pageResult = await db.query<DecisionRecordSummaryRow>(
      `SELECT record.id, record.adr_number,
              left(record.title, 512) AS title,
              left(COALESCE(record.data->>'summary', ''), 1024) AS summary,
              left(record.status, 64) AS status,
              left(COALESCE(record.data->>'author', ''), 256) AS author,
              record.created_at AS sort_created_at,
              left(record.created_at, 64) AS created_at,
              left(record.updated_at, 64) AS updated_at,
              ${totalExpression} AS page_total
       FROM ro_decision_records record
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY record.created_at COLLATE "C" DESC, record.id COLLATE "C" DESC
       LIMIT $${params.length}`,
      params,
    )
  const total = pageResult.rows[0]?.page_total ?? (await db.query<{ total: string | number }>(
    `SELECT ${totalExpression} AS total`,
    countParams,
  )).rows[0]?.total
  const page = pageResult.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    paged: true,
    serverFiltered: true,
    total: Number(total ?? 0),
    offset: 0,
    limit,
    nextOffset: null,
    detailsIncluded: false,
    nextCursor: pageResult.rows.length > limit && last
      ? encodeReadModelCursor({
          kind: 'decision-record-page', queryHash,
          createdAt: last.sort_created_at, id: last.id,
        })
      : null,
    items: page.map((row) => ({
      id: row.id,
      number: Number(row.adr_number ?? 0),
      title: row.title,
      summary: row.summary,
      status: row.status,
      author: row.author,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

/** Full ADR payload for the selected record. List pages deliberately omit the
 * potentially large markdown, link and history collections. */
export async function roDecisionRecordDetail(
  db: Queryable,
  key: WorkspaceKey,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await db.query<{ data: Record<string, unknown> }>(
    `SELECT record.data
     FROM ro_decision_records record
     WHERE record.landscape_id = $1 AND record.version_id = $2 AND record.id = $3
     LIMIT 1`,
    [key.landscapeId, key.versionId, id],
  )
  return result.rows[0]?.data
}
