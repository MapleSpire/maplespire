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

export interface DiagramRenderDependencies {
  diagramIds?: readonly string[]
  objectIds?: readonly string[]
  connectionIds?: readonly string[]
  groupIds?: readonly string[]
}

/** The render cache needs both tokens before every lookup. Fetch them through
 * one pool checkout so a burst of identical renders cannot consume two
 * PostgreSQL connections per HTTP request. */
export async function roDiagramRenderContext(
  db: Queryable,
  key: WorkspaceKey,
): Promise<{ projectionGeneration: number; staticBaselineEpoch?: string }> {
  const { rows } = await db.query<{
    projection_generation: string | number
    static_baseline_epoch: string | null
  }>(
    `SELECT
       COALESCE((SELECT projected_generation
                 FROM read_model_projection_state
                 WHERE landscape_id = $1 AND version_id = $2), 0)
         AS projection_generation,
       (SELECT created_at::text
        FROM read_model_static_workspaces
        WHERE landscape_id = $1 AND version_id = $2)
         AS static_baseline_epoch`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  return {
    projectionGeneration: Number(row?.projection_generation ?? 0),
    ...(row?.static_baseline_epoch ? { staticBaselineEpoch: row.static_baseline_epoch } : {}),
  }
}

export class DiagramRenderContextLoader {
  private readonly pending = new Map<string, Promise<{
    projectionGeneration: number
    staticBaselineEpoch?: string
  }>>()

  constructor(private readonly db: Queryable) {}

  load(key: WorkspaceKey): Promise<{ projectionGeneration: number; staticBaselineEpoch?: string }> {
    const id = JSON.stringify([key.landscapeId, key.versionId])
    const existing = this.pending.get(id)
    if (existing) return existing
    const running = roDiagramRenderContext(this.db, key).finally(() => {
      if (this.pending.get(id) === running) this.pending.delete(id)
    })
    this.pending.set(id, running)
    return running
  }
}

/** Immutable static baselines start at zero. Only a dependency mutation bumps
 * this token; unrelated workspace projections deliberately do not. */
export async function roDiagramRenderGeneration(
  db: Queryable,
  key: WorkspaceKey,
  diagramId: string,
): Promise<number> {
  const { rows } = await db.query<{ render_generation: string | number }>(
    `SELECT render_generation FROM read_model_diagram_render_generations
     WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
    [key.landscapeId, key.versionId, diagramId],
  )
  return Number(rows[0]?.render_generation ?? 0)
}

/** Must run before deleting entity memberships so the affected diagrams remain
 * discoverable. The caller invokes it in the same projector transaction as the
 * ro_* mutation and global generation publication. */
export async function bumpDiagramRenderGenerations(
  db: Queryable,
  key: WorkspaceKey,
  generation: number,
  dependencies: DiagramRenderDependencies,
): Promise<number> {
  const diagramIds = [...new Set(dependencies.diagramIds ?? [])]
  const objectIds = [...new Set(dependencies.objectIds ?? [])]
  const connectionIds = [...new Set(dependencies.connectionIds ?? [])]
  const groupIds = [...new Set(dependencies.groupIds ?? [])]
  if (!diagramIds.length && !objectIds.length && !connectionIds.length && !groupIds.length) return 0
  const result = await db.query(
    `INSERT INTO read_model_diagram_render_generations (
       landscape_id, version_id, diagram_id, render_generation, updated_at
     )
     SELECT $1, $2, affected.diagram_id, $3, now()
     FROM (
       SELECT unnest($4::text[]) AS diagram_id
       UNION SELECT diagram_id FROM ro_diagram_objects
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($5::text[])
       UNION SELECT diagram_id FROM ro_diagram_connections
         WHERE landscape_id = $1 AND version_id = $2 AND connection_id = ANY($6::text[])
       UNION SELECT diagram_id FROM ro_diagram_groups
         WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($7::text[])
     ) affected
     ON CONFLICT (landscape_id, version_id, diagram_id) DO UPDATE SET
       render_generation = GREATEST(read_model_diagram_render_generations.render_generation, EXCLUDED.render_generation),
       updated_at = now()`,
    [key.landscapeId, key.versionId, generation, diagramIds, objectIds, connectionIds, groupIds],
  )
  return result.rowCount ?? 0
}

export function selectDiagramRenderCacheGeneration(input: {
  staticReadModel: boolean
  dependencyScoped: boolean
  workspaceGeneration: number
  diagramGeneration: number
}): number {
  return input.staticReadModel && input.dependencyScoped
    ? input.diagramGeneration
    : input.workspaceGeneration
}
