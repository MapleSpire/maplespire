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

import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import type { C4Object, Connection, Group } from '../../types'
import type { ModelQuery, PeerEdge } from './types'
import { rankSearch, SEARCH_LIMIT, SEARCH_MIN_CHARS } from './search'
import { connectionRowsFromStore, pickerEntriesFromStore, modelObjectRowsFromStore } from './heavyViews'
import { warnWholeModelRead } from './wholeModelGuard'
import { residentObjectSearchPage, residentObjectTreePage } from './objectExplorerFallback'
import { buildResidentDependencyPage } from './dependencyFallback'
import { boundRelatedDiagrams } from './relatedDiagrams'

/**
 * The default ModelQuery: served entirely from the resident Zustand store + the
 * module-level DiagramIndex. Methods are async to match the interface but resolve
 * immediately (the data is already in memory), so behavior is unchanged.
 */
export const residentModelQuery: ModelQuery = {
  objectTreePage: (opts) => residentObjectTreePage(opts),
  objectSearchPage: (opts) => residentObjectSearchPage(opts),
  connectionPage: async (opts) => {
    const offset = opts.cursor?.startsWith('local:') ? Number(opts.cursor.slice(6)) || 0 : 0
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
    const result = connectionRowsFromStore({ ...opts, offset, limit })
    return {
      items: result.rows,
      nextCursor: offset + result.rows.length < result.total ? `local:${offset + result.rows.length}` : null,
      total: result.total,
      projectionGeneration: 0,
      coverage: 'full',
    }
  },
  dependencyPage: async (opts) => {
    const edges = opts.direction === 'incoming'
      ? await residentModelQuery.incoming(opts.focusId)
      : await residentModelQuery.outgoing(opts.focusId)
    const entities = await residentModelQuery.lookupMany([...new Set(edges.map((edge) => edge.peerId))])
    return buildResidentDependencyPage(edges, entities, opts)
  },
  viewerLevel: async (opts) => {
    const index = getDiagramIndex()
    const query = (opts.query ?? '').trim().toLocaleLowerCase()
    const domainIds = new Set(opts.domainIds ?? [])
    const all = useModelStore.getState().objects.filter((object) => {
      const atLevel = opts.parentId
        ? object.parentId === opts.parentId
        : !object.parentId || !index.objectById.has(object.parentId)
      return atLevel
        && (!query || object.name.toLocaleLowerCase().includes(query))
        && (!domainIds.size || Boolean(object.domainId && domainIds.has(object.domainId)))
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const offset = opts.cursor?.startsWith('local:') ? Number(opts.cursor.slice(6)) || 0 : 0
    const limit = Math.min(250, Math.max(1, opts.limit ?? 200))
    const objects = all.slice(offset, offset + limit)
    const visibleIds = new Set(objects.map((object) => object.id))
    const connectionLimit = Math.min(2_000, Math.max(1, opts.connectionLimit ?? 1_000))
    const matchingConnections = useModelStore.getState().connections.filter((connection) =>
      connection.kind !== 'lower' && connection.fromId !== connection.toId
      && visibleIds.has(connection.fromId) && visibleIds.has(connection.toId))
    const ancestors: C4Object[] = []
    let cursor = opts.parentId ? index.objectById.get(opts.parentId) : undefined
    for (let depth = 0; cursor && depth < 64; depth += 1) {
      ancestors.unshift(cursor)
      cursor = cursor.parentId ? index.objectById.get(cursor.parentId) : undefined
    }
    return {
      ancestors,
      objects: objects.map((object) => ({
        object,
        childCount: index.childrenByParentId.get(object.id)?.length ?? 0,
      })),
      connections: matchingConnections.slice(0, connectionLimit),
      nextCursor: offset + objects.length < all.length ? `local:${offset + objects.length}` : null,
      totalObjects: all.length,
      connectionsTruncated: matchingConnections.length > connectionLimit,
      projectionGeneration: 0,
      coverage: 'full' as const,
    }
  },
  async incoming(focusId) {
    const conns = getDiagramIndex().connectionsByToId.get(focusId)
    if (!conns) return []
    const out: PeerEdge[] = []
    for (const c of conns) if (c.fromId !== focusId) out.push({ connection: c, peerId: c.fromId })
    return out
  },
  async outgoing(focusId) {
    const conns = getDiagramIndex().connectionsByFromId.get(focusId)
    if (!conns) return []
    const out: PeerEdge[] = []
    for (const c of conns) if (c.toId !== focusId) out.push({ connection: c, peerId: c.toId })
    return out
  },
  async object(id) {
    return getDiagramIndex().objectById.get(id)
  },
  async group(id) {
    return getDiagramIndex().groupById.get(id)
  },
  async connection(id) {
    return getDiagramIndex().connectionById.get(id) ?? useModelStore.getState().connections.find((c) => c.id === id)
  },
  async connectionsMany(ids) {
    const idx = getDiagramIndex()
    const connections = useModelStore.getState().connections
    const m = new Map<string, Connection>()
    for (const id of ids) {
      const c = idx.connectionById.get(id) ?? connections.find((candidate) => candidate.id === id)
      if (c) m.set(id, c)
    }
    return m
  },
  async lookupMany(ids) {
    const idx = getDiagramIndex()
    const m = new Map<string, C4Object | Group>()
    for (const id of ids) {
      const e = idx.objectById.get(id) ?? idx.groupById.get(id)
      if (e) m.set(id, e)
    }
    return m
  },
  async connectionCount(id) {
    return useModelStore.getState().getObjectConnectionCount(id)
  },
  async descendants(objectId) {
    return useModelStore.getState().getDescendantObjects(objectId)
  },
  async allObjects() {
    warnWholeModelRead('resident.allObjects')
    return useModelStore.getState().objects
  },
  async allConnections() {
    warnWholeModelRead('resident.allConnections')
    return useModelStore.getState().connections
  },
  async relatedDiagrams(objectId, options) {
    return boundRelatedDiagrams(
      useModelStore.getState().getRelatedDiagrams(objectId, { includeCurrent: options?.includeCurrent }),
      options,
    )
  },
  async entityFlows() {
    return null
  },
  async entityDiagrams() {
    return null
  },
  async relatedDiagramObjectIds(objectIds) {
    const state = useModelStore.getState()
    return [...new Set(objectIds)].filter((objectId) => {
      const related = state.getRelatedDiagrams(objectId)
      return related.detail.length + related.reference.length + related.parent.length > 0
    })
  },
  async search(query, limit = SEARCH_LIMIT) {
    const q = query.trim().toLowerCase()
    if (q.length < SEARCH_MIN_CHARS) return []
    const idx = getDiagramIndex()
    const nameOf = (id: string) => idx.objectById.get(id)?.name ?? idx.groupById.get(id)?.name ?? 'Unknown'
    const s = useModelStore.getState()
    return rankSearch(s.objects, s.connections, q, limit, nameOf)
  },
  async connectionRows(opts) {
    return connectionRowsFromStore(opts)
  },
  async pickerEntries(opts) {
    return pickerEntriesFromStore(opts)
  },
  async modelObjectRows(opts) {
    return modelObjectRowsFromStore(opts)
  },
  async modelObjectFacets() {
    return { teamIds: getDiagramIndex().teamIds }
  },
}
