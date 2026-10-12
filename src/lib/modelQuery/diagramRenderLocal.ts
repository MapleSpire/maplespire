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

import type { C4Object, Connection, Group } from '../../types'
import type { KvStore } from './kvStore'
import { indexDiagram, indexLookupMany } from './modelIndex'
import type { DiagramRenderResult } from './diagramRender'

/**
 * OFFLINE diagram render (fallback for boot-from-server).
 *
 * When the server `/api/model/diagram-render` is unreachable (offline / backend
 * down), the active diagram's EXISTING (server-rendered) content would otherwise
 * vanish — `projectActiveFromServer` proceeds with an empty render and the canvas
 * shows only locally-created shapes. This rebuilds the SAME render from the local
 * IndexedDB read-model index (the complete model a warm client already holds on
 * disk), so existing content stays visible + editable offline.
 *
 * It mirrors the server's `roDiagramRender` (server/src/readModel/diagramRender.ts)
 * byte-for-byte: the diagram's own objects/groups/direct connections PLUS the
 * derived "lower" (rolled-up) connections, computed by the same pure algorithm
 * with deterministic `lower:<from>→<to>` ids. The pure `computeLowerConnections`
 * here is the client twin of the server's and is parity-tested against it.
 */

interface MiniConn {
  id: string
  fromId: string
  toId: string
}
interface LowerConnection {
  id: string
  fromId: string
  toId: string
  kind: 'lower'
  type: 'dashed'
  label: ''
}
interface DiagramComposition {
  objectIds: string[]
  groupIds: string[]
}

/**
 * Derive the lower (rolled-up) connections a diagram needs — the client twin of the
 * server's `computeLowerConnections` and the resident `syncLowerConnections`:
 *  - `findVisible(id)` = the id itself if on the diagram, else the nearest ancestor
 *    on the diagram (walk parentId), else the containing group IF that group is on
 *    the diagram, else null.
 *  - for every connection: roll both endpoints up; skip when an endpoint has no
 *    visible representative, when BOTH endpoints are already directly visible, or
 *    when the rolled-up endpoints coincide (self-loop); first connection to map to a
 *    given visible (from→to) pair wins (one lower per pair).
 *
 * Ids are deterministic (`lower:<from>→<to>`); lower connections are never persisted
 * (recomputed on load), so the id is internal and only from/to/kind matter.
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

/** One IndexedDB pass → all objects (by id, for parentOf) + all persisted (non-lower)
 * connections (for the roll-up scan). `o:`/`c:` record prefixes are unambiguous (the
 * key always has `:` at index 1), so they never collide with `out:`/`od:`/`ch:`/`tg:`. */
async function scanGraph(store: KvStore): Promise<{ objects: Map<string, C4Object>; connections: MiniConn[] }> {
  const all = await store.scanPrefix<unknown>('')
  const objects = new Map<string, C4Object>()
  const connections: MiniConn[] = []
  for (const [k, v] of all) {
    if (k.startsWith('o:')) {
      const o = v as C4Object
      objects.set(o.id, o)
    } else if (k.startsWith('c:')) {
      const c = v as Connection
      connections.push({ id: c.id, fromId: c.fromId, toId: c.toId })
    }
  }
  return { objects, connections }
}

/**
 * Everything a client needs to render `diagramId` WITHOUT the server, read from the
 * local index. Returns undefined when the diagram isn't in the index (cold offline —
 * the index never built), so the caller keeps its empty-render behavior.
 *
 * Cost: one full index scan for the roll-up inputs (the offline analogue of the
 * server paying an O(model) read so the client pays O(diagram)). Runs only on the
 * offline fallback path, so the online boot win is untouched.
 */
export async function buildLocalDiagramRender(
  store: KvStore,
  diagramId: string
): Promise<DiagramRenderResult | undefined> {
  const diagram = await indexDiagram(store, diagramId)
  if (!diagram) return undefined

  const objectIds = diagram.objectIds ?? []
  const connectionIds = diagram.connectionIds ?? []
  const groupIds = diagram.groupIds ?? []

  // The diagram's own objects + groups (entities ↔ groups share the lookup space).
  const lookup = await indexLookupMany(store, [...objectIds, ...groupIds])
  const objects: C4Object[] = []
  for (const id of objectIds) {
    const e = lookup.get(id)
    if (e && !('objectIds' in e)) objects.push(e as C4Object)
  }
  const groups: Group[] = []
  const groupObjectIds = new Map<string, string[]>()
  for (const id of groupIds) {
    const g = lookup.get(id) as Group | undefined
    if (g && 'objectIds' in g) {
      groups.push(g)
      groupObjectIds.set(g.id, g.objectIds ?? [])
    }
  }

  // The diagram's direct (persisted, non-lower) connections. Lower ids that may sit
  // in connectionIds aren't persisted → absent from the index → naturally filtered.
  const directConns: Connection[] = []
  if (connectionIds.length) {
    const recs = await store.getMany<Connection>(connectionIds.map((id) => `c:${id}`))
    for (const c of recs) if (c) directConns.push(c)
  }

  // Lower roll-ups: need every object's parent chain + every non-lower edge.
  const graph = await scanGraph(store)
  const parentOf = new Map<string, string | undefined>()
  for (const o of graph.objects.values()) parentOf.set(o.id, o.parentId ?? undefined)
  const lower = computeLowerConnections({ objectIds, groupIds }, parentOf, groupObjectIds, graph.connections)

  return {
    // Legacy fallback is not tied to the normalized read-model projection. It is
    // used only when no generation-bound Worker render exists.
    projectionGeneration: 0,
    objects,
    connections: [...directConns, ...(lower as unknown as Connection[])],
    groups,
  }
}
