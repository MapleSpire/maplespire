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

interface DiagramCacheCursor extends Record<string, unknown> {
  id: string
}

export interface DiagramCacheManifest {
  diagramId: string
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

/**
 * Small, cursor-paged diagram composition feed used by an explicit complete
 * offline download. It deliberately stores references only; objects, groups
 * and connections continue to live once in their normalized IndexedDB stores.
 */
export async function roDiagramCachePage(
  db: Queryable,
  key: WorkspaceKey,
  opts: { after?: string | null; limit?: number } = {},
): Promise<{
  projectionGeneration: number
  items: DiagramCacheManifest[]
  nextCursor: string | null
  total?: number
}> {
  const limit = Math.min(500, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 500))
  const queryHash = readModelQueryHash({
    kind: 'diagram-cache', landscapeId: key.landscapeId, versionId: key.versionId,
  })
  const after = opts.after
    ? decodeReadModelCursor<DiagramCacheCursor>(opts.after, { kind: 'diagram-cache', queryHash })
    : null
  if (after && typeof after.id !== 'string') throw new ReadModelCursorError('Invalid diagram-cache cursor')

  const params: unknown[] = [key.landscapeId, key.versionId]
  const afterSql = after ? 'AND id > $3' : ''
  if (after) params.push(after.id)
  params.push(limit + 1)
  const [pageResult, generationResult, totalResult] = await Promise.all([
    db.query<{
      id: string
      object_ids: unknown
      data: Record<string, unknown>
    }>(
      `SELECT id, object_ids, data
       FROM ro_diagrams
       WHERE landscape_id = $1 AND version_id = $2 ${afterSql}
       ORDER BY id
       LIMIT $${params.length}`,
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
        `SELECT count(*) AS total FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2`,
        [key.landscapeId, key.versionId],
      ),
  ])

  const page = pageResult.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    projectionGeneration: Number(generationResult.rows[0]?.projected_generation ?? 0),
    items: page.map((row) => ({
      diagramId: row.id,
      objectIds: stringIds(row.object_ids),
      connectionIds: stringIds(row.data?.connectionIds),
      groupIds: stringIds(row.data?.groupIds),
    })),
    nextCursor: pageResult.rows.length > limit && last
      ? encodeReadModelCursor({ kind: 'diagram-cache', queryHash, id: last.id })
      : null,
    ...(totalResult ? { total: Number(totalResult.rows[0]?.total ?? 0) } : {}),
  }
}
