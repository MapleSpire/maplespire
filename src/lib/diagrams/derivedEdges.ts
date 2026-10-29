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

import type { Connection, Diagram } from '../../types'
import { getModelQuery } from '../modelQuery'
import type { ModelQuery } from '../modelQuery/types'
import { residentModelQuery } from '../modelQuery/resident'
import { fetchDiagramRender, readCachedDiagramRender, type DiagramRenderResult } from '../modelQuery/diagramRender'
import { buildLocalDiagramRender, computeLowerConnections } from '../modelQuery/diagramRenderLocal'
import { isIndexReady } from '../modelQuery/offlineIndex'
import { workspaceKvStore } from '../modelQuery/kvStore'
import { useModelStore } from '../../stores/modelStore'

export type DerivedComposition = Pick<Diagram, 'objectIds'> & Partial<Pick<Diagram, 'groupIds' | 'connectionIds'>>

export interface DerivedEdgeSources {
  /** The whole model is in the store (the resident tier). */
  resident: () => boolean
  /** The store's model, for the resident roll-up. */
  model: () => Pick<ReturnType<typeof useModelStore.getState>, 'objects' | 'connections' | 'groups'>
  /** The server's render of the diagram. Throws when unreachable; `undefined` for a 404. */
  fetchRender: (diagramId: string) => Promise<DiagramRenderResult | undefined>
  /** What the browser kept of an earlier render, or rebuilds from its own index. */
  offlineRender: (diagramId: string) => Promise<DiagramRenderResult | undefined>
}

export const defaultDerivedEdgeSources: DerivedEdgeSources = {
  resident: () => getModelQuery() === residentModelQuery,
  model: () => useModelStore.getState(),
  fetchRender: fetchDiagramRender,
  offlineRender: async (diagramId) => {
    const cached = await readCachedDiagramRender(diagramId)
    if (cached) return cached
    return isIndexReady() ? buildLocalDiagramRender(workspaceKvStore(), diagramId) : undefined
  },
}

/** A connection's ends, each with every ancestor above it (self first). */
export interface EdgeEnds {
  from: string[]
  to: string[]
}

/** Deeper than any C4 nesting; bounds a parent cycle in bad data. */
const MAX_DEPTH = 8

/**
 * Each connection's ends as ancestor-or-self chains, read through the
 * ModelQuery seam: one batched connection read, then one batched lookup per
 * level of nesting. `null` for a connection that cannot be read (deleted, or
 * the read failed). Never rejects.
 */
export async function readEdgeEnds(
  connectionIds: readonly string[],
  query: Pick<ModelQuery, 'connectionsMany' | 'lookupMany'>,
): Promise<Map<string, EdgeEnds | null>> {
  const out = new Map<string, EdgeEnds | null>(connectionIds.map((id) => [id, null]))
  try {
    const connections = await query.connectionsMany([...connectionIds])
    const parentOf = new Map<string, string | undefined>()
    let frontier = [...new Set([...connections.values()].flatMap((c) => [c.fromId, c.toId]))]
    for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth++) {
      const found = await query.lookupMany(frontier)
      const next: string[] = []
      for (const id of frontier) {
        const entity = found.get(id) as { parentId?: string } | undefined
        const parent = entity?.parentId ?? undefined
        parentOf.set(id, parent)
        if (parent && !parentOf.has(parent)) next.push(parent)
      }
      frontier = [...new Set(next)]
    }
    const chain = (id: string): string[] => {
      const ids = [id]
      for (let at = parentOf.get(id); at && !ids.includes(at); at = parentOf.get(at)) ids.push(at)
      return ids
    }
    for (const [id, connection] of connections) {
      out.set(id, { from: chain(connection.fromId), to: chain(connection.toId) })
    }
  } catch (error) {
    console.warn('inline expansion: changed edges unreadable', error)
  }
  return out
}

const lowerOnly = (connections: readonly Connection[]): Connection[] =>
  connections.filter((connection) => connection.kind === 'lower')

/**
 * The derived (`kind: 'lower'`) edges a diagram draws: a relationship between
 * shapes that are NOT on it, rolled up to their nearest ancestors that are.
 *
 * Under boot-from-server they are computed for a render and never stored in
 * the diagram's `connectionIds`, so a diagram that is not the active one — a
 * layout-less stub in the index — does not list them. On a Structurizr import
 * they carry most of a container view (`mobileApp -> orderService.orderApi` is
 * drawn as Mobile App -> Order Service), and an inline expansion read from the
 * stub alone drew 2 of its 13 edges (2026-10-16, FoodDash).
 *
 * On the RESIDENT tier the store's lower sync does list them (under the same
 * `lower:<from>→<to>` ids since 2026-10-22, generated ids before), so the stub
 * may already carry them: the planner matches roll-ups by their two ends, not
 * their id. There the roll-up is computed from the store,
 * which is complete and current (unsynced local edits included) — never from a
 * cached render, which offline could be older than the store.
 *
 * Elsewhere, the active diagram's sources (`loadDiagramRenderForProjection`):
 * the server's render, else the cached render or one rebuilt from the local
 * index when the server is unreachable.
 *
 * `undefined` = not known this time (offline with nothing cached, or a diagram
 * the server does not know); the caller keeps what it knew. Never rejects.
 */
export async function readDerivedEdges(
  diagramId: string,
  composition: DerivedComposition,
  sources: DerivedEdgeSources = defaultDerivedEdgeSources,
): Promise<Connection[] | undefined> {
  try {
    if (!sources.resident()) {
      let render: DiagramRenderResult | undefined
      try {
        render = await sources.fetchRender(diagramId)
      } catch (error) {
        console.warn(`inline expansion: render of ${diagramId} unreachable, trying the offline copy`, error)
        render = await sources.offlineRender(diagramId)
      }
      return render ? lowerOnly(render.connections) : undefined
    }
    const { objects, connections, groups } = sources.model()
    const parentOf = new Map(objects.map((object) => [object.id, object.parentId ?? undefined]))
    const groupObjectIds = new Map(groups.map((group) => [group.id, group.objectIds ?? []]))
    const direct = connections.filter((connection) => connection.kind !== 'lower')
    return computeLowerConnections(
      { objectIds: composition.objectIds, groupIds: composition.groupIds ?? [], connectionIds: composition.connectionIds },
      parentOf,
      groupObjectIds,
      direct,
    ) as unknown as Connection[]
  } catch (error) {
    console.warn(`inline expansion: derived edges of ${diagramId} unavailable`, error)
    return undefined
  }
}
