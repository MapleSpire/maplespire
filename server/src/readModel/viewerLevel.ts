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

interface ViewerCursor extends Record<string, unknown> {
  name: string
  id: string
}

export interface ViewerLevelObject {
  object: Record<string, unknown>
  childCount: number
}

export interface ViewerLevelResult {
  projectionGeneration: number
  ancestors: Record<string, unknown>[]
  objects: ViewerLevelObject[]
  connections: Record<string, unknown>[]
  nextCursor: string | null
  totalObjects: number
  connectionsTruncated: boolean
}

function likeLiteral(value: string | undefined): string {
  const normalized = (value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  return normalized ? `%${normalized.replace(/([%_\\])/g, '\\$1')}%` : ''
}

/** A bounded renderer window for one C4 level. The indexed effective parent
 * already incorporates group precedence and dangling-parent repair. */
export async function roViewerLevel(
  db: Queryable,
  key: WorkspaceKey,
  opts: {
    parentId?: string | null
    query?: string
    domainIds?: string[]
    after?: string | null
    limit?: number
    connectionLimit?: number
  } = {},
): Promise<ViewerLevelResult> {
  const parentId = opts.parentId?.slice(0, 256) || null
  const query = likeLiteral(opts.query)
  const domainIds = [...new Set((opts.domainIds ?? []).filter(Boolean))].slice(0, 100)
  const limit = Math.min(250, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 200))
  const connectionLimit = Math.min(2_000, Math.max(1, Number.isFinite(opts.connectionLimit) ? Math.floor(opts.connectionLimit!) : 1_000))
  const queryHash = readModelQueryHash({
    kind: 'viewer-level', landscapeId: key.landscapeId, versionId: key.versionId,
    parentId, query, domainIds,
  })
  const after = opts.after
    ? decodeReadModelCursor<ViewerCursor>(opts.after, { kind: 'viewer-level', queryHash })
    : null
  if (after && (typeof after.name !== 'string' || typeof after.id !== 'string')) {
    throw new ReadModelCursorError('Invalid viewer-level cursor')
  }

  const params: unknown[] = [key.landscapeId, key.versionId, parentId, query, domainIds]
  const metadataParams = [...params]
  const parentPredicate = parentId === null
    ? '(object.effective_parent_id IS NULL AND $3::text IS NULL)'
    : 'object.effective_parent_id = $3'
  const afterSql = after
    ? `AND (object.normalized_name COLLATE "C", object.id COLLATE "C")
         > ($6::text COLLATE "C", $7::text COLLATE "C")`
    : ''
  if (after) params.push(after.name, after.id)
  params.push(limit + 1)
  const hasFilters = Boolean(query || domainIds.length)
  const totalExpression = hasFilters
    ? `(SELECT count(*) FROM ro_objects object
        WHERE object.landscape_id = $1 AND object.version_id = $2
          AND ${parentPredicate}
          AND ($4 = '' OR object.normalized_name LIKE $4 ESCAPE '\\')
          AND (cardinality($5::text[]) = 0 OR object.domain_id = ANY($5::text[])))`
    : parentId
      ? `COALESCE((SELECT child_count FROM ro_object_child_stats
                   WHERE landscape_id = $1 AND version_id = $2 AND object_id = $3), 0)`
      : `COALESCE((SELECT root_object_count FROM ro_workspace_stats
                   WHERE landscape_id = $1 AND version_id = $2), 0)`
  const generationExpression = `COALESCE((SELECT projected_generation
      FROM read_model_projection_state
      WHERE landscape_id = $1 AND version_id = $2), 0)`
  const objectResult = await db.query<{
    id: string
    normalized_name: string
    data: Record<string, unknown>
    child_count: string | number
    page_total: string | number
    projected_generation: string | number
  }>(
    `SELECT object.id, object.normalized_name, object.data,
            COALESCE(children.child_count, 0)::integer AS child_count,
            ${totalExpression} AS page_total,
            ${generationExpression} AS projected_generation
     FROM ro_objects object
     LEFT JOIN ro_object_child_stats children
       ON children.landscape_id = object.landscape_id
      AND children.version_id = object.version_id AND children.object_id = object.id
     WHERE object.landscape_id = $1 AND object.version_id = $2
       AND ${parentPredicate}
       AND ($4 = '' OR object.normalized_name LIKE $4 ESCAPE '\\')
       AND (cardinality($5::text[]) = 0 OR object.domain_id = ANY($5::text[]))
       ${afterSql}
     ORDER BY object.normalized_name COLLATE "C", object.id COLLATE "C"
     LIMIT $${params.length}`,
    params,
  )
  const page = objectResult.rows.slice(0, limit)
  const objectIds = page.map((row) => row.id)
  // The HTTP route provides one checked-out client so all rows belong to the
  // same read-only snapshot. Keep that client's statements explicit and
  // sequential: pg does not run concurrent statements on one connection and
  // pg@9 removes the deprecated implicit client-side query queue.
  const ancestorResult = parentId
    ? await db.query<{ data: Record<string, unknown>; depth: number }>(
        `WITH RECURSIVE ancestors AS (
           SELECT id, effective_parent_id, data, 0 AS depth
           FROM ro_objects
           WHERE landscape_id = $1 AND version_id = $2 AND id = $3
           UNION ALL
           SELECT parent.id, parent.effective_parent_id, parent.data, child.depth + 1
           FROM ro_objects parent
           JOIN ancestors child ON child.effective_parent_id = parent.id
           WHERE parent.landscape_id = $1 AND parent.version_id = $2 AND child.depth < 63
         )
         SELECT data, depth FROM ancestors ORDER BY depth DESC`,
        [key.landscapeId, key.versionId, parentId],
      )
    : { rows: [] }
  const connectionResult = objectIds.length
    ? await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM ro_connections
         WHERE landscape_id = $1 AND version_id = $2
           AND kind IS DISTINCT FROM 'lower'
           AND from_id = ANY($3::text[]) AND to_id = ANY($3::text[])
           AND from_id <> to_id
         ORDER BY id COLLATE "C"
         LIMIT $4`,
        [key.landscapeId, key.versionId, objectIds, connectionLimit + 1],
      )
    : { rows: [] }
  const metadata = objectResult.rows[0] ?? (await db.query<{
    page_total: string | number
    projected_generation: string | number
  }>(
    `SELECT ${totalExpression} AS page_total,
            ${generationExpression} AS projected_generation`,
    metadataParams,
  )).rows[0]
  const last = page.at(-1)
  return {
    projectionGeneration: Number(metadata?.projected_generation ?? 0),
    ancestors: ancestorResult.rows.map((row) => row.data),
    objects: page.map((row) => ({ object: row.data, childCount: Number(row.child_count) })),
    connections: connectionResult.rows.slice(0, connectionLimit).map((row) => row.data),
    nextCursor: objectResult.rows.length > limit && last
      ? encodeReadModelCursor({ kind: 'viewer-level', queryHash, name: last.normalized_name, id: last.id })
      : null,
    totalObjects: Number(metadata?.page_total ?? 0),
    connectionsTruncated: connectionResult.rows.length > connectionLimit,
  }
}
