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

/**
 * Server-side diagram render.
 *
 * A C4 diagram shows its own (persisted, non-"lower") connections PLUS derived
 * "lower" connections — deep edges (e.g. component→component) rolled up onto the
 * nearest visible ancestor on the diagram. The client computes these in
 * `syncLowerConnections` (src/stores/modelStore.ts) by scanning the WHOLE
 * connection set, which is why a top-level diagram needs ~the entire model
 * resident even though it shows only ~80 objects.
 *
 * Computing the roll-up HERE lets a client fetch a diagram's render-ready
 * objects + connections in one request and draw it without materializing the
 * whole model, which keeps boot cheap. `computeLowerConnections` is pure +
 * unit-tested for byte-parity with the client algorithm; `roDiagramRender` wires
 * it to the read-model tables.
 */

type Json = Record<string, unknown>

export interface MiniConn {
  id: string
  fromId: string
  toId: string
}
export interface LowerConnection {
  id: string
  fromId: string
  toId: string
  kind: 'lower'
  type: 'dashed'
  label: ''
}
export interface DiagramComposition {
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
}

/**
 * Derive the lower (rolled-up) connections a diagram needs — mirrors the client's
 * `syncLowerConnections` exactly:
 *  - `findVisible(id)` = the id itself if on the diagram, else the nearest ancestor
 *    on the diagram (walk parentId), else the containing group IF that group is on
 *    the diagram, else null.
 *  - for every NON-lower connection: roll both endpoints up; skip when an endpoint
 *    has no visible representative, when BOTH endpoints are already directly visible,
 *    or when the rolled-up endpoints coincide (self-loop); first connection to map to
 *    a given visible (from→to) pair wins (one lower per pair).
 *
 * Ids are deterministic (`lower:<from>→<to>`) — unlike the client's random ids, but
 * lower connections are never persisted (recomputed on load), so the id is internal
 * and only from/to/kind matter for rendering.
 */
export function computeLowerConnections(
  diagram: DiagramComposition,
  parentOf: Map<string, string | undefined>,
  groupObjectIds: Map<string, string[]>,
  allNonLowerConnections: MiniConn[]
): LowerConnection[] {
  const visible = new Set(diagram.objectIds)

  // objectId → containing group, but only for the groups placed on this diagram.
  const objectToGroup = new Map<string, string>()
  for (const gid of diagram.groupIds) {
    for (const oid of groupObjectIds.get(gid) ?? []) objectToGroup.set(oid, gid)
  }

  const findVisible = (objectId: string): string | null => {
    if (visible.has(objectId)) return objectId
    let cur = parentOf.get(objectId)
    while (cur) {
      if (visible.has(cur)) return cur
      cur = parentOf.get(cur)
    }
    return objectToGroup.get(objectId) ?? null
  }

  const seen = new Set<string>()
  const lower: LowerConnection[] = []
  for (const c of allNonLowerConnections) {
    const vf = findVisible(c.fromId)
    const vt = findVisible(c.toId)
    if (!vf || !vt) continue
    if (vf === c.fromId && vt === c.toId) continue // both directly visible
    if (vf === vt) continue // self-loop after roll-up
    const key = `${vf}→${vt}`
    if (seen.has(key)) continue
    seen.add(key)
    lower.push({ id: `lower:${key}`, fromId: vf, toId: vt, kind: 'lower', type: 'dashed', label: '' })
  }
  return lower
}

export interface DiagramRender {
  /** Read-model generation from the same database snapshot as the payload. The
   * client keys its durable render cache by this value so a stale render is never
   * silently promoted to the current projection. */
  projectionGeneration: number
  objects: Json[]
  connections: Json[]
  groups: Json[]
}

export interface FirstPaintDiagramRender extends DiagramRender {
  schemaVersion: 1
  renderGeneration: number
  deferredObjectFields: readonly ['links', 'properties', 'technologyEditorMetadata']
}

function compactTechnologyUsages(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value as Record<string, Json>).map(([id, usage]) => {
    const snapshot = usage.snapshot && typeof usage.snapshot === 'object' && !Array.isArray(usage.snapshot)
      ? usage.snapshot as Json
      : {}
    return [id, {
      id: usage.id,
      technologyId: usage.technologyId,
      catalogRevision: usage.catalogRevision,
      ...(usage.role === undefined ? {} : { role: usage.role }),
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        name: snapshot.name,
        ...(snapshot.iconLightPath === undefined ? {} : { iconLightPath: snapshot.iconLightPath }),
        ...(snapshot.iconDarkPath === undefined ? {} : { iconDarkPath: snapshot.iconDarkPath }),
      },
    }]
  }))
}

/** Additive opt-in DTO. It preserves all fields read by the 2D/3D canvas while
 * deferring right-sidebar data. A future client can hydrate an object on demand
 * through the existing `/api/model/object/:id` endpoint. */
export function toFirstPaintDiagramRender(render: DiagramRender, renderGeneration: number): FirstPaintDiagramRender {
  const compactEntity = (entity: Json): Json => {
    const { links: _links, properties: _properties, ...paint } = entity
    if (paint.technologyUsages !== undefined) {
      paint.technologyUsages = compactTechnologyUsages(paint.technologyUsages)
    }
    return paint
  }
  return {
    schemaVersion: 1,
    projectionGeneration: render.projectionGeneration,
    renderGeneration,
    deferredObjectFields: ['links', 'properties', 'technologyEditorMetadata'],
    objects: render.objects.map(compactEntity),
    connections: render.connections,
    groups: render.groups.map(compactEntity),
  }
}

/** Cheap authoritative token used to address the process-local render cache.
 * It is read again inside roDiagramRender's repeatable-read transaction, so a
 * projector commit racing these two operations can never mislabel the body. */
export async function roProjectionGeneration(db: Queryable, key: WorkspaceKey): Promise<number> {
  const { rows } = await db.query<{ projected_generation: string | number }>(
    `SELECT projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId]
  )
  return Number(rows[0]?.projected_generation ?? 0)
}

/**
 * Everything a client needs to render a diagram without the rest of the model:
 * its objects, its groups, and its connections (persisted non-lower + computed
 * lower roll-ups). Returns undefined for an unknown diagram.
 *
 * Cost: O(objects + connections) per call (the roll-up scans the whole edge set),
 * but only id+parent / id+from+to are read for the bulk — the heavy `data` JSONB
 * is fetched only for the diagram's own objects/connections/groups. This is the
 * server paying an O(model) read so the CLIENT pays O(diagram). Every query is
 * scoped to one workspace's rows so the "whole edge set" scan never crosses
 * into another workspace's data.
 */
export async function roDiagramRender(
  db: Queryable,
  key: WorkspaceKey,
  diagramId: string,
  options: { computeLowerConnections?: boolean } = {},
): Promise<DiagramRender | undefined> {
  const wsParams = [key.landscapeId, key.versionId]
  if (options.computeLowerConnections === false) {
    const { rows } = await db.query<{
      diagram_data: Json
      projection_generation: string | number
      object_data: Json[]
      connection_data: Json[]
      group_data: Json[]
    }>(
      `SELECT diagram.data AS diagram_data,
              COALESCE(state.projected_generation, 0) AS projection_generation,
              COALESCE((
                SELECT jsonb_agg(object.data)
                FROM ro_objects object
                WHERE object.landscape_id = diagram.landscape_id
                  AND object.version_id = diagram.version_id
                  AND object.id = ANY(diagram.object_ids)
              ), '[]'::jsonb) AS object_data,
              COALESCE((
                SELECT jsonb_agg(connection.data)
                FROM ro_connections connection
                WHERE connection.landscape_id = diagram.landscape_id
                  AND connection.version_id = diagram.version_id
                  AND connection.id IN (
                    SELECT jsonb_array_elements_text(
                      COALESCE(diagram.data->'connectionIds', '[]'::jsonb)
                    )
                  )
              ), '[]'::jsonb) AS connection_data,
              COALESCE((
                SELECT jsonb_agg(group_row.data)
                FROM ro_groups group_row
                WHERE group_row.landscape_id = diagram.landscape_id
                  AND group_row.version_id = diagram.version_id
                  AND group_row.id IN (
                    SELECT jsonb_array_elements_text(
                      COALESCE(diagram.data->'groupIds', '[]'::jsonb)
                    )
                  )
              ), '[]'::jsonb) AS group_data
       FROM ro_diagrams diagram
       LEFT JOIN read_model_projection_state state
         ON state.landscape_id = diagram.landscape_id
        AND state.version_id = diagram.version_id
       WHERE diagram.landscape_id = $1 AND diagram.version_id = $2 AND diagram.id = $3`,
      [...wsParams, diagramId],
    )
    const row = rows[0]
    if (!row) return undefined
    const stub = row.diagram_data as {
      layouts?: Record<string, { position?: Json; size?: Json }>
    }
    const applyDiagramLayout = (data: Json): Json => {
      const entity = data as { id?: string }
      const layout = entity.id ? stub.layouts?.[entity.id] : undefined
      return layout
        ? { ...(data as Record<string, Json>), position: layout.position, size: layout.size }
        : data
    }
    return {
      projectionGeneration: Number(row.projection_generation),
      objects: row.object_data.map(applyDiagramLayout),
      connections: row.connection_data,
      groups: row.group_data.map(applyDiagramLayout),
    }
  }
  const [dRes, generationRes] = await Promise.all([
    db.query<{ object_ids: string[]; data: Json }>(
      `SELECT object_ids, data FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
      [...wsParams, diagramId]
    ),
    db.query<{ projected_generation: string | number }>(
      `SELECT projected_generation FROM read_model_projection_state
       WHERE landscape_id = $1 AND version_id = $2`,
      wsParams
    ),
  ])
  if (dRes.rows.length === 0) return undefined
  const stub = dRes.rows[0].data as {
    connectionIds?: string[]
    groupIds?: string[]
    layouts?: Record<string, { position?: Json; size?: Json }>
  }
  const objectIds = dRes.rows[0].object_ids ?? []
  const connectionIds = stub.connectionIds ?? []
  const groupIds = stub.groupIds ?? []
  const applyDiagramLayout = (data: Json): Json => {
    const entity = data as { id?: string }
    const layout = entity.id ? stub.layouts?.[entity.id] : undefined
    return layout
      ? { ...(data as Record<string, Json>), position: layout.position, size: layout.size }
      : data
  }

  const [parentRows, edgeRows, visObjRows, dirConnRows, groupRows] = await Promise.all([
    db.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`, wsParams
    ),
    db.query<{ id: string; from_id: string; to_id: string }>(
      `SELECT id, from_id, to_id FROM ro_connections WHERE landscape_id = $1 AND version_id = $2`, wsParams
    ),
    db.query<{ data: Json }>(
      `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
      [...wsParams, objectIds]
    ),
    connectionIds.length
      ? db.query<{ data: Json }>(
          `SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
          [...wsParams, connectionIds]
        )
      : Promise.resolve({ rows: [] as { data: Json }[] }),
    db.query<{ id: string; data: Json }>(
      `SELECT id, data FROM ro_groups WHERE landscape_id = $1 AND version_id = $2`, wsParams
    ),
  ])

  const parentOf = new Map<string, string | undefined>()
  for (const r of parentRows.rows) parentOf.set(r.id, r.parent_id ?? undefined)

  const groupObjectIds = new Map<string, string[]>()
  for (const r of groupRows.rows) {
    groupObjectIds.set(r.id, ((r.data as { objectIds?: string[] }).objectIds) ?? [])
  }

  const allConns: MiniConn[] = edgeRows.rows.map((r) => ({ id: r.id, fromId: r.from_id, toId: r.to_id }))
  const lower = computeLowerConnections({ objectIds, connectionIds, groupIds }, parentOf, groupObjectIds, allConns)

  const groupIdSet = new Set(groupIds)
  return {
    projectionGeneration: Number(generationRes.rows[0]?.projected_generation ?? 0),
    objects: visObjRows.rows.map((r) => applyDiagramLayout(r.data)),
    connections: [...dirConnRows.rows.map((r) => r.data), ...(lower as unknown as Json[])],
    groups: groupRows.rows.filter((r) => groupIdSet.has(r.id)).map((r) => applyDiagramLayout(r.data)),
  }
}
