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

import { getDiagramIndex, useModelStore } from '../../stores/modelStore'
import { workspaceKvStore, type KvStore } from './kvStore'
import {
  indexIncoming, indexOutgoing, indexObject, indexGroup, indexConnection, indexLookupMany,
  indexConnectionCount, indexDescendants, indexSearch,
  indexModelObjectFacets,
} from './modelIndex'
import { connectionRowsFromIndex, pickerEntriesFromIndex, modelObjectRowsFromIndex, cachedIndexObjects, cachedIndexConnections } from './heavyViews'
import { warnWholeModelRead } from './wholeModelGuard'
import type { Diagram } from '../../types'
import type { ModelQuery } from './types'
import { isServerReadModelEnabled } from './tierFlag'
import { serverModelQuery } from './server'
import { residentObjectSearchPage, residentObjectTreePage } from './objectExplorerFallback'
import { workerObjectSearchPage, workerObjectTreePage } from './objectExplorerWorker'
import { workerConnectionPage } from './connectionExplorerWorker'
import { workerDependencyPage } from './dependencyExplorerWorker'
import { buildResidentDependencyPage } from './dependencyFallback'
import { workerViewerLevel } from './viewerLevelWorker'
import { residentModelQuery } from './resident'
import { boundRelatedDiagrams, emptyRelatedDiagrams } from './relatedDiagrams'
import type { RelatedDiagramsOptions, RelatedDiagramsResult } from './types'

/**
 * The paged ModelQuery: adjacency/lookup served from the persisted
 * IndexedDB index instead of the resident store, so global queries work without
 * the whole graph in JS. The index is built + kept fresh by the bridge
 * (./indexSync) whenever paging is enabled. `currentDiagramId` stays resident
 * (local, not part of the paged-out model), so it's read from the store.
 *
 * `store()` resolves the ACTIVE WORKSPACE's namespaced index on every call (not
 * cached at module scope) so a workspace switch is picked up immediately without an
 * explicit reset — `workspaceKvStore()` itself memoizes per workspace, so this stays
 * cheap and preserves the heavyViews index-array memo (same object per workspace).
 *
 * NOT every method here has the server → worker/index → resident ladder (the gaps
 * are invisible at a glance and each one is a different promise):
 *
 *  - `connection`, `connectionCount`, `descendants`, `incoming`, `outgoing`,
 *    `search`, `connectionRows`, `pickerEntries`, `modelObjectRows`,
 *    `modelObjectFacets` go STRAIGHT to the persisted index — no server rung and
 *    no resident rung. Under the summary contract that index is never filled
 *    (`syncModelIndex` is skipped for the session), so they answer empty rather
 *    than wrong; callers that must not be truncated use the laddered pages.
 *  - `allObjects` / `allConnections` are whole-model reads behind
 *    `warnWholeModelRead` and have no ladder ON PURPOSE — there is no bounded
 *    server answer to give them.
 *  - `relatedDiagrams` / `relatedDiagramObjectIds` fall back to the RESIDENT
 *    diagrams registry (`relatedDiagramsFromRegistry`), never to the index's
 *    diagram postings; see that function for why.
 */
let storeOverride: KvStore | null = null
const store = (): KvStore => storeOverride ?? workspaceKvStore()

/** Test hook: back the paged query with an in-memory store (pass null to restore
 * the per-workspace IndexedDB store). */
export function __setPagedStoreForTest(s: KvStore | null): void {
  storeOverride = s
}

/**
 * Related diagrams, answered from the RESIDENT diagrams registry rather than the
 * persisted `dpo:`/`od:` index.
 *
 * The IndexedDB diagram index is NOT refreshed when a diagram is created/edited
 * under boot-from-server (`syncModelIndex` is skipped and `applyOffWindowEditsToIndex`
 * only touches objects/connections), so a freshly-created detail/reference diagram
 * would be missing from `indexRelatedDiagrams` and the shape would not link to it.
 *
 * The resident registry is the better of the two, NOT a complete one. Under the
 * SUMMARY contract `useModelStore.diagrams`
 * is a bounded window (`summaryRegistryMetas`: the server page plus the local
 * write shard), so a related diagram outside that window is missed here. The
 * complete answer for that mode is `serverModelQuery.relatedDiagrams`, which the
 * rung above this one reaches whenever the tier is on and the client is online;
 * this is the offline floor, and it degrades by omission, never by inventing a
 * link.
 *
 * The object's `parentId` (needed for the "parent" bucket) still comes from the
 * index so off-window objects resolve. Semantics mirror the resident
 * `getRelatedDiagrams`: reference takes precedence over detail/parent, and the
 * current diagram is excluded.
 */
async function relatedDiagramsFromRegistry(
  s: KvStore,
  objectId: string,
  options: RelatedDiagramsOptions = {},
): Promise<RelatedDiagramsResult> {
  const obj = await indexObject(s, objectId)
  if (!obj) return emptyRelatedDiagrams(options.limit)

  const state = useModelStore.getState()
  const currentDiagramId = state.currentDiagramId
  const detail: Diagram[] = []
  const reference: Diagram[] = []
  const parent: Diagram[] = []
  const seen = new Set<string>()

  for (const diagram of state.diagrams) {
    if (diagram.id === currentDiagramId || seen.has(diagram.id)) continue

    // reference takes precedence (a diagram that both contains the object AND is
    // its detail diagram counts as reference, matching the resident scan order).
    if (diagram.objectIds.includes(objectId)) {
      reference.push(diagram)
      seen.add(diagram.id)
      continue
    }
    if (diagram.parentObjectId === objectId) {
      detail.push(diagram)
      seen.add(diagram.id)
      continue
    }
    if (obj.parentId && diagram.parentObjectId === obj.parentId) {
      parent.push(diagram)
      seen.add(diagram.id)
    }
  }

  return boundRelatedDiagrams({ detail, reference, parent }, options)
}

export const pagedModelQuery: ModelQuery = {
  objectTreePage: async (opts, signal) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.objectTreePage(opts, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    try {
      const page = await workerObjectTreePage(opts, signal)
      if (page.coverage === 'full' || page.projectionGeneration > 0 || page.items.length > 0) return page
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    }
    const page = await residentObjectTreePage(opts)
    return { ...page, coverage: 'working-set' }
  },
  objectSearchPage: async (opts, signal) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.objectSearchPage(opts, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    const filtered = Boolean(
      opts.filter?.types?.length || opts.filter?.scope || opts.filter?.technologyIds?.length
      || opts.filter?.tagIds?.length || opts.filter?.statuses?.length || opts.filter?.status
      || opts.filter?.teamIds?.length || opts.filter?.hasDescription !== undefined
      || opts.filter?.inDiagram !== undefined || opts.domainId,
    )
    if (!filtered) {
      try {
        const page = await workerObjectSearchPage(opts, signal)
        if (page.coverage === 'full' || page.projectionGeneration > 0 || page.items.length > 0) return page
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    const page = await residentObjectSearchPage(opts)
    return { ...page, coverage: 'working-set' }
  },
  connectionPage: async (opts, signal) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.connectionPage(opts, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    try {
      const page = await workerConnectionPage(opts, signal)
      if (page.coverage === 'full' || page.projectionGeneration > 0 || page.items.length > 0) return page
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    }
    const offset = opts.cursor?.startsWith('local:') ? Number(opts.cursor.slice(6)) || 0 : 0
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
    const result = await connectionRowsFromIndex(store(), { ...opts, offset, limit })
    return {
      items: result.rows,
      nextCursor: offset + result.rows.length < result.total ? `local:${offset + result.rows.length}` : null,
      total: result.total,
      projectionGeneration: 0,
      // `working-set`, like every other last rung here — never `full`. The
      // IndexedDB index holds the whole model only when something FILLS it, and
      // under the summary contract nothing does (`syncModelIndex` is skipped for
      // the whole session). Claiming `full` would suppress ConnectionsTable's
      // partial-offline warning over an empty table. The flag describes what
      // this rung can promise, not what the index promises when it is warm.
      coverage: 'working-set',
    }
  },
  dependencyPage: async (opts, signal) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.dependencyPage(opts, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    try {
      return await workerDependencyPage(opts, signal)
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    }
    // Last-resort compatibility path for browsers that cannot start a Worker.
    // It is bounded to the already-resident/windowed model and disclosed as a
    // working set; it never triggers an IndexedDB allObjects/allConnections scan.
    const index = getDiagramIndex()
    const connections = opts.direction === 'incoming'
      ? index.connectionsByToId.get(opts.focusId) ?? []
      : index.connectionsByFromId.get(opts.focusId) ?? []
    const edges = connections.flatMap((connection) => {
      const peerId = opts.direction === 'incoming' ? connection.fromId : connection.toId
      return peerId === opts.focusId ? [] : [{ connection, peerId }]
    })
    const entities = new Map([...new Set(edges.map((edge) => edge.peerId))].flatMap((id) => {
      const entity = index.objectById.get(id) ?? index.groupById.get(id)
      return entity ? [[id, entity] as const] : []
    }))
    return { ...buildResidentDependencyPage(edges, entities, opts), coverage: 'working-set' }
  },
  viewerLevel: async (opts, signal) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.viewerLevel(opts, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    try {
      return await workerViewerLevel(opts, signal)
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    }
    const page = await residentModelQuery.viewerLevel(opts, signal)
    return { ...page, coverage: 'working-set' }
  },
  incoming: (focusId) => indexIncoming(store(), focusId),
  outgoing: (focusId) => indexOutgoing(store(), focusId),
  object: async (id) => {
    // Canvas drops and whole-model sidebars can reference an entity outside the
    // resident/indexed working set. Resolve it from the server tier first so the
    // caller can seed it into the editable window, then fall back offline.
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        const remote = await serverModelQuery.object(id)
        if (remote) return remote
      } catch {
        // Offline-first fallback below.
      }
    }
    return indexObject(store(), id)
  },
  group: async (id) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        const remote = await serverModelQuery.group(id)
        if (remote) return remote
      } catch {
        // Offline-first fallback below.
      }
    }
    return indexGroup(store(), id)
  },
  connection: (id) => indexConnection(store(), id),
  lookupMany: async (ids) => {
    // The server tier is the zero-wait source for off-window entities. The
    // persisted index may contain only a working set (for example after opening
    // the Dependencies page directly), so resolving a picker selection from the
    // index alone can incorrectly turn a valid focus into "missing".
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        const remote = await serverModelQuery.lookupMany(ids)
        if (remote.size === ids.length) return remote
        const local = await indexLookupMany(store(), ids.filter((id) => !remote.has(id)))
        for (const [id, entity] of local) remote.set(id, entity)
        return remote
      } catch {
        // Offline-first fallback: the local index remains authoritative whenever
        // the server is unavailable.
      }
    }
    return indexLookupMany(store(), ids)
  },
  connectionCount: (id) => indexConnectionCount(store(), id),
  descendants: (objectId) => indexDescendants(store(), objectId),
  allObjects: () => {
    warnWholeModelRead('paged.allObjects')
    return cachedIndexObjects(store())
  },
  allConnections: () => {
    warnWholeModelRead('paged.allConnections')
    return cachedIndexConnections(store())
  },
  relatedDiagrams: async (objectId, options) => {
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.relatedDiagrams(objectId, options)
      } catch (error) {
        if (options?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    return relatedDiagramsFromRegistry(store(), objectId, options)
  },
  relatedDiagramObjectIds: async (objectIds, options) => {
    const uniqueObjectIds = [...new Set(objectIds)]
    if (isServerReadModelEnabled() && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        return await serverModelQuery.relatedDiagramObjectIds(uniqueObjectIds, options)
      } catch (error) {
        if (options?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    }
    const relatedObjectIds: string[] = []
    for (const objectId of uniqueObjectIds) {
      const related = await relatedDiagramsFromRegistry(store(), objectId)
      if (related.detail.length + related.reference.length + related.parent.length > 0) {
        relatedObjectIds.push(objectId)
      }
    }
    return relatedObjectIds
  },
  search: (query, limit) => indexSearch(store(), query, limit),
  // The heavy-view tables read the persisted index (objects + connections)
  // rather than the resident store, so they are not limited to the active
  // diagram's window — WHEN the index is filled. It is not under the summary
  // contract (`syncModelIndex` is skipped for the session), and these three have
  // no server rung, so there they answer from whatever the offline download left
  // behind. Callers that must not be truncated go through `connectionPage` /
  // `objectTreePage`, which do have one.
  connectionRows: (opts) => connectionRowsFromIndex(store(), opts),
  pickerEntries: (opts) => pickerEntriesFromIndex(store(), opts),
  modelObjectRows: (opts) => modelObjectRowsFromIndex(store(), opts),
  modelObjectFacets: () => indexModelObjectFacets(store()),
}
