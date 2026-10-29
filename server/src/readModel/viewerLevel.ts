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
  /** 1 when the object has at least one child level entry, else 0 — not a count. */
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

/** A bounded renderer window for one C4 level, keyed by the maintained
 * `c4_parent_id`: the C4 `parent_id` when that parent exists, else NULL — so an
 * object whose parent was deleted is a root, as in resident mode and the client
 * model (`src/lib/modelViewer/levels.ts`). Served in page order by
 * `idx_ro_objects_c4_name_c_page`. */
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
  // The Model Viewer follows the C4 hierarchy — system ▸ container ▸ component —
  // like the resident implementation (the offline worker still follows the
  // explorer tree).
  // NOT `effective_parent_id`: that is the Model objects explorer's NAVIGATION
  // tree, where Group membership outranks the parent. An object inside a boundary
  // group (the system boundary a container diagram draws) would vanish from its
  // real level and its parent would report no children — no drill-down possible.
  // NOT raw `parent_id` either: a dangling one would put its object at no level.
  // (`$3::text IS NULL` keeps $3 referenced at the root: a statement whose
  // highest placeholder is $5 must still mention every placeholder before it.)
  const parentPredicate = parentId === null
    ? '(object.c4_parent_id IS NULL AND $3::text IS NULL)'
    : 'object.c4_parent_id = $3'
  // ORDER BY leads with `c4_parent_id`, constant within a level, so the sort
  // matches idx_ro_objects_c4_name_c_page. Without it the ROOT level sorts: an
  // `IS NULL` qual is not an equality the planner can drop from the ordering,
  // so it read all 6 021 roots and top-N sorted them (543 ms cold on 200 000
  // objects); with it, 201 rows straight off the index in 2.2 ms, and a deep
  // cursor becomes an index condition. Measured with
  // server/scripts/measure-viewer-level-c4.ts.
  const afterSql = after
    ? `AND (object.normalized_name COLLATE "C", object.id COLLATE "C")
         > ($6::text COLLATE "C", $7::text COLLATE "C")`
    : ''
  if (after) params.push(after.name, after.id)
  params.push(limit + 1)
  const hasFilters = Boolean(query || domainIds.length)
  // The placeholders the total/generation statements actually mention. The
  // empty-page fallback below is a separate statement: binding it more
  // parameters than it references is a protocol error (HTTP 500 on any empty
  // level — a childless object, a brand-new landscape).
  const metadataParams = hasFilters ? params.slice(0, 5) : parentId ? params.slice(0, 3) : params.slice(0, 2)
  const totalExpression = hasFilters
    ? `(SELECT count(*) FROM ro_objects object
        WHERE object.landscape_id = $1 AND object.version_id = $2
          AND ${parentPredicate}
          AND ($4 = '' OR object.normalized_name LIKE $4 ESCAPE '\\')
          AND (cardinality($5::text[]) = 0 OR object.domain_id = ANY($5::text[])))`
    : parentId
      ? `(SELECT count(*) FROM ro_objects object
          WHERE object.landscape_id = $1 AND object.version_id = $2 AND object.c4_parent_id = $3)`
      : `(SELECT count(*) FROM ro_objects object
          WHERE object.landscape_id = $1 AND object.version_id = $2 AND object.c4_parent_id IS NULL)`
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
    // child_count is 0 or 1 — EXISTENCE, not a count. The viewer only asks
    // whether a tile expands (`hasChildren` in src/lib/modelViewer/levels.ts),
    // and a count over a 200-tile page of hub objects would read every child of
    // every tile; EXISTS stops at the first index entry.
    `SELECT object.id, object.normalized_name, object.data,
            (EXISTS (
               SELECT 1 FROM ro_objects child
               WHERE child.landscape_id = object.landscape_id
                 AND child.version_id = object.version_id AND child.c4_parent_id = object.id
             ))::integer AS child_count,
            ${totalExpression} AS page_total,
            ${generationExpression} AS projected_generation
     FROM ro_objects object
     WHERE object.landscape_id = $1 AND object.version_id = $2
       AND ${parentPredicate}
       AND ($4 = '' OR object.normalized_name LIKE $4 ESCAPE '\\')
       AND (cardinality($5::text[]) = 0 OR object.domain_id = ANY($5::text[]))
       ${afterSql}
     ORDER BY object.c4_parent_id, object.normalized_name COLLATE "C", object.id COLLATE "C"
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
           SELECT id, c4_parent_id, data, 0 AS depth
           FROM ro_objects
           WHERE landscape_id = $1 AND version_id = $2 AND id = $3
           UNION ALL
           SELECT parent.id, parent.c4_parent_id, parent.data, child.depth + 1
           FROM ro_objects parent
           JOIN ancestors child ON child.c4_parent_id = parent.id
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
