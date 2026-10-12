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

import { useModelStore } from '../../stores/modelStore'
import type { C4Object, Connection, Group, Diagram, Flow } from '../../types'
import type { KvStore } from './kvStore'
import {
  indexAllObjects, indexAllConnections, indexChildrenOfMany, indexConnectionsTouching,
  indexModelEntityCount, indexObjectsByIds, indexTagEntityIds, indexTechnologyEntityIds,
} from './modelIndex'
import { useModelIndexVersion } from './indexSync'
import {
  hasObjectOnlyFilter, isModelObjectFilterActive, matchesModelObjectFilter,
  matchesTagFilter, matchesTechnologyFilter,
} from './modelObjectFilter'
import type {
  ConnectionRow, ConnectionRowsOpts, ConnectionRowsResult,
  PickerEntry, PickerOpts, PickerResult,
  ModelObjectRow, ModelObjectRowsOpts,
} from './types'

/**
 * The heavy-view paged reads. Each table routes through
 * `getModelQuery()`; the work is a pure CORE (filter + sort + tree-build + enrich)
 * fed two ways:
 *
 *  - `*FromStore` (resident backend): the whole model is in the Zustand store, so
 *    the core reads the store arrays — cached by store-array identity.
 *  - `*FromIndex` (paged backend, used when the store is WINDOWED): objects +
 *    connections come from the complete IndexedDB index (the windowed store only
 *    holds the active diagram), while groups/diagrams/flows stay fully resident in
 *    the store. Cached by the index version + those resident refs.
 *
 * Both feed the SAME core, so the windowed tables show the exact same rows as the
 * full-store tables (pinned by the agreement test).
 */

export type HeavyData = { objects: C4Object[]; connections: Connection[]; groups: Group[]; diagrams: Diagram[]; flows: Flow[] }

/** Element-wise identity compare of two cache tokens (array refs / version ids). */
function sameTokens(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── index-array memo ──────────────────────────────────────────────────────────
// Enumerating the whole index (`indexAllObjects`/`indexAllConnections`) is an
// O(all-keys) IndexedDB scan (~50k entries at 20k objects). The compute cores are
// already memoized by token, but the SCAN ran on every heavy-view call — so each
// expand/collapse, search keystroke, page or table re-mount re-read the entire
// index, which is the "expand is a bit slow" cost. Memoize the scans by the index
// version (store the PROMISE → concurrent callers share one in-flight scan); a build
// or incremental update bumps the version and invalidates them.
let idxObjectsMemo: { store: KvStore; v: number; p: Promise<C4Object[]> } | null = null
let idxConnectionsMemo: { store: KvStore; v: number; p: Promise<Connection[]> } | null = null

export function cachedIndexObjects(store: KvStore): Promise<C4Object[]> {
  const v = useModelIndexVersion.getState().version
  if (!idxObjectsMemo || idxObjectsMemo.store !== store || idxObjectsMemo.v !== v)
    idxObjectsMemo = { store, v, p: indexAllObjects(store) }
  return idxObjectsMemo.p
}
export function cachedIndexConnections(store: KvStore): Promise<Connection[]> {
  const v = useModelIndexVersion.getState().version
  if (!idxConnectionsMemo || idxConnectionsMemo.store !== store || idxConnectionsMemo.v !== v)
    idxConnectionsMemo = { store, v, p: indexAllConnections(store) }
  return idxConnectionsMemo.p
}

/** Pre-warm the index-array memo off the critical path (e.g. right after a cold
 * build) so the FIRST heavy-view read — the first Model Objects / Connections open —
 * doesn't pay the full O(all-keys) IndexedDB scan inline. */
export function prewarmIndexArrays(store: KvStore): Promise<void> {
  return Promise.all([cachedIndexObjects(store), cachedIndexConnections(store)]).then(() => {})
}

/** Test hook: drop the index-array memo. */
export function __resetIndexArrayMemo(): void {
  idxObjectsMemo = null
  idxConnectionsMemo = null
}

function flowCountByPair(flows: Flow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const f of flows) {
    const pairs = new Set<string>()
    for (const s of f.steps) if (s.type === 'message') pairs.add(`${s.fromObjectId}→${s.toObjectId}`)
    for (const p of pairs) m.set(p, (m.get(p) ?? 0) + 1)
  }
  return m
}
function connDiagramCount(diagrams: Diagram[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const d of diagrams) for (const cid of d.connectionIds) m.set(cid, (m.get(cid) ?? 0) + 1)
  return m
}

// ── connection rows ─────────────────────────────────────────────────────────
interface ConnCache {
  token: unknown[]
  objMap: Map<string, C4Object>
  diagCount: Map<string, number>
  flowCount: Map<string, number>
  key: string
  sorted: Connection[]
}
let connCache: ConnCache | null = null

export function computeConnectionRows(data: HeavyData, token: unknown[], opts: ConnectionRowsOpts): ConnectionRowsResult {
  const { search = '', domainId = null, sortBy = 'name', sortAsc = true, offset = 0, limit = 100 } = opts
  const tokenFresh = sameTokens(connCache?.token ?? null, token)
  const key = `${search} ${domainId} ${sortBy} ${sortAsc}`

  const objMap = tokenFresh ? connCache!.objMap : new Map(data.objects.map((o) => [o.id, o]))
  const diagCount = tokenFresh ? connCache!.diagCount : connDiagramCount(data.diagrams)
  const flowCount = tokenFresh ? connCache!.flowCount : flowCountByPair(data.flows)
  const nameOf = (id: string) => objMap.get(id)?.name ?? 'Unknown'

  let sorted: Connection[]
  if (tokenFresh && connCache!.key === key) {
    sorted = connCache!.sorted
  } else {
    let filtered = data.connections
    const q = search.trim().toLowerCase()
    if (q) {
      filtered = filtered.filter(
        (c) => (c.label ?? '').toLowerCase().includes(q) || nameOf(c.fromId).toLowerCase().includes(q) || nameOf(c.toId).toLowerCase().includes(q)
      )
    }
    if (domainId) {
      filtered = filtered.filter((c) => objMap.get(c.fromId)?.domainId === domainId || objMap.get(c.toId)?.domainId === domainId)
    }
    const flowKey = (c: Connection) => `${c.fromId}→${c.toId}`
    sorted = [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortBy) {
        case 'name': cmp = (a.label ?? '').localeCompare(b.label ?? ''); break
        case 'sender': cmp = nameOf(a.fromId).localeCompare(nameOf(b.fromId)); break
        case 'receiver': cmp = nameOf(a.toId).localeCompare(nameOf(b.toId)); break
        case 'diagrams': cmp = (diagCount.get(a.id) ?? 0) - (diagCount.get(b.id) ?? 0); break
        case 'flows': cmp = (flowCount.get(flowKey(a)) ?? 0) - (flowCount.get(flowKey(b)) ?? 0); break
      }
      return sortAsc ? cmp : -cmp
    })
    connCache = { token, objMap, diagCount, flowCount, key, sorted }
  }

  const rows: ConnectionRow[] = sorted.slice(offset, offset + limit).map((conn) => {
    const from = objMap.get(conn.fromId)
    const to = objMap.get(conn.toId)
    return {
      connection: conn,
      fromName: from?.name || 'Unknown', fromIcon: from?.icon, fromType: from?.type, fromDomainId: from?.domainId,
      toName: to?.name || 'Unknown', toIcon: to?.icon, toType: to?.type, toDomainId: to?.domainId,
      diagramCount: diagCount.get(conn.id) ?? 0,
      flowCount: flowCount.get(`${conn.fromId}→${conn.toId}`) ?? 0,
    }
  })
  return { rows, total: sorted.length }
}

export function connectionRowsFromStore(opts: ConnectionRowsOpts): ConnectionRowsResult {
  const s = useModelStore.getState()
  return computeConnectionRows(
    { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows },
    [s.objects, s.connections, s.diagrams, s.flows],
    opts
  )
}

/** Index-backed (windowed store): objects + connections from the complete index;
 * diagrams + flows from the resident store. */
export async function connectionRowsFromIndex(store: KvStore, opts: ConnectionRowsOpts): Promise<ConnectionRowsResult> {
  const s = useModelStore.getState()
  const [objects, connections] = await Promise.all([cachedIndexObjects(store), cachedIndexConnections(store)])
  const token = ['idx', useModelIndexVersion.getState().version, s.diagrams, s.flows]
  return computeConnectionRows({ objects, connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows }, token, opts)
}

// ── model objects tree ────────────────────────────────────────────────────────
// The tree builds only the VISIBLE rows (root + expanded subtrees), so it is
// O(visible) — but the per-node counts need maps over the WHOLE model. Those maps
// (objMap / childrenByParent / connection-count / diagram-count) are the only
// O(model) cost, so we cache them by the data token: expand/collapse, search and
// filter reuse them and only the cheap visible-tree walk re-runs.
interface MoCache {
  token: unknown[]
  objMap: Map<string, C4Object>
  childrenByParent: Map<string, C4Object[]>
  connCount: Map<string, number>
  diagCount: Map<string, number>
  rootObjects: C4Object[]
}
let moCache: MoCache | null = null

const ROOT_SORT: Record<string, number> = { group: 0, system: 1, actor: 2, app: 3, store: 4, component: 5 }

export function computeModelObjectRows(data: HeavyData, token: unknown[], opts: ModelObjectRowsOpts): { rows: ModelObjectRow[]; total: number } {
  const { expandedIds, search = '', filter = {}, domainId = null } = opts
  const { objects, groups, connections, diagrams } = data
  const fresh = sameTokens(moCache?.token ?? null, token)

  let objMap: Map<string, C4Object>
  let childrenByParent: Map<string, C4Object[]>
  let connCount: Map<string, number>
  let diagCount: Map<string, number>
  let rootObjects: C4Object[]
  if (fresh) {
    ;({ objMap, childrenByParent, connCount, diagCount, rootObjects } = moCache!)
  } else {
    objMap = new Map(objects.map((o) => [o.id, o]))
    childrenByParent = new Map()
    for (const o of objects) {
      if (!o.parentId) continue
      const arr = childrenByParent.get(o.parentId)
      if (arr) arr.push(o); else childrenByParent.set(o.parentId, [o])
    }
    connCount = new Map()
    for (const c of connections) {
      connCount.set(c.fromId, (connCount.get(c.fromId) ?? 0) + 1)
      connCount.set(c.toId, (connCount.get(c.toId) ?? 0) + 1)
    }
    diagCount = new Map()
    for (const d of diagrams) for (const oid of d.objectIds) diagCount.set(oid, (diagCount.get(oid) ?? 0) + 1)
    rootObjects = objects.filter((o) => !o.parentId || !objMap.has(o.parentId))
    rootObjects.sort((a, b) => {
      const oa = ROOT_SORT[a.type] ?? 99, ob = ROOT_SORT[b.type] ?? 99
      return oa !== ob ? oa - ob : a.name.localeCompare(b.name)
    })
    moCache = { token, objMap, childrenByParent, connCount, diagCount, rootObjects }
  }

  const childrenOf = (parentId: string) => childrenByParent.get(parentId) ?? []
  const getConnCount = (id: string) => connCount.get(id) ?? 0
  const getDiagCount = (id: string) => diagCount.get(id) ?? 0
  const getGroupDiagCount = (group: Group) => {
    const memberIds = new Set(group.objectIds)
    let n = 0
    for (const d of diagrams) if (d.objectIds.some((oid) => memberIds.has(oid))) n++
    return n
  }

  const q = search.trim().toLowerCase()
  const safeTypes = filter.types ?? []
  const seen = new Set<string>()
  const matchesFilters = (item: C4Object | Group, isGroup: boolean): boolean => {
    if (q && !item.name.toLowerCase().includes(q)) return false
    if (isGroup) {
      if (safeTypes.length > 0 && !safeTypes.includes('group')) return false
      if (hasObjectOnlyFilter(filter)) return false
      if (!matchesTechnologyFilter(item as Group, filter.technologyIds)) return false
      if (!matchesTagFilter(item as Group, filter.tagIds)) return false
      if (domainId && (item as Group).domainId !== domainId) return false
      if (filter.inDiagram !== undefined) {
        const inDiagram = getGroupDiagCount(item as Group) > 0
        if (inDiagram !== filter.inDiagram) return false
      }
      return true
    }
    return matchesModelObjectFilter(item as C4Object, filter, {
      domainId,
      diagramCount: getDiagCount(item.id),
    })
  }

  // Search/filter behaves like the left-sidebar tree (AddShapePanel.buildSubtree): when a
  // search OR any filter is active we FORCE descent into expandable subtrees and KEEP any
  // ancestor that has a matching descendant. Without this the page only ever matched
  // top-level names, so a component nested inside a System could never be found via search.
  const searchActive =
    q !== '' ||
    isModelObjectFilterActive(filter) ||
    !!domainId
  // Unlike free text, structured facets/domain scope are strict predicates.
  // Manual expansion may expose matching descendants and their ancestor chain,
  // but must never weaken a predicate by revealing unrelated siblings.
  const strictStructuredFilter = isModelObjectFilterActive(filter) || !!domainId

  // `parentRevealed` = an ancestor of this node is MANUALLY expanded, so this node is shown
  // regardless of whether it matches the search (expansion reveals a level at a time, exactly
  // like the construction flow: search a System, expand it, see/add its children). Search adds
  // to that — it surfaces nested matches with their ancestors — without taking expansion away.
  const buildSubtree = (item: C4Object | Group, level: number, isGroup: boolean, parentRevealed: boolean): ModelObjectRow[] => {
    const id = item.id
    if (seen.has(id)) return []
    const obj = isGroup ? null : (item as C4Object)
    const childObjs = isGroup
      ? (item as Group).objectIds.map((objectId) => objMap.get(objectId)).filter((child): child is C4Object => !!child)
      : childrenOf(id)
    const isExpandable = isGroup
      ? childObjs.length > 0
      : !!obj && (obj.type === 'system' || obj.type === 'app' || obj.type === 'store')
    const selfMatch = matchesFilters(item, isGroup)
    const expanded = isExpandable && expandedIds.includes(id)

    // First occurrence wins (group member before root). If this subtree is later
    // discarded, release the id so another structural location may still show it.
    seen.add(id)

    let appCount = 0, storeCount = 0, componentCount = 0
    if (isGroup) {
      const members = (item as Group).objectIds.map((oid) => objMap.get(oid)).filter(Boolean) as C4Object[]
      appCount = members.filter((o) => o.type === 'app').length
      storeCount = members.filter((o) => o.type === 'store').length
      componentCount = members.filter((o) => o.type === 'component').length
    } else if (obj) {
      if (obj.type === 'system') {
        appCount = childObjs.filter((o) => o.type === 'app').length
        storeCount = childObjs.filter((o) => o.type === 'store').length
      }
      if (obj.type === 'app' || obj.type === 'store') {
        componentCount = childObjs.filter((o) => o.type === 'component').length
      } else if (obj.type === 'system') {
        const appsAndStores = childObjs.filter((o) => o.type === 'app' || o.type === 'store')
        componentCount = appsAndStores.reduce((sum, app) => sum + childrenOf(app.id).filter((o) => o.type === 'component').length, 0)
      }
    }

    const selfRow: ModelObjectRow = {
      id,
      name: item.name,
      type: isGroup ? 'group' : (item as C4Object).type,
      scope: isGroup ? undefined : (item as C4Object).scope,
      status: isGroup ? undefined : (item as C4Object).status,
      description: item.name,
      level,
      childCount: childObjs.length,
      isExpandable,
      appCount, storeCount, componentCount,
      connectionCount: getConnCount(id),
      diagramCount: isGroup ? getGroupDiagCount(item as Group) : getDiagCount(id),
      domainId: isGroup ? (item as Group).domainId : (item as C4Object).domainId,
      isGroup,
      icon: isGroup ? (item as Group).icon : (item as C4Object).icon,
      iconAssignment: item.iconAssignment,
    }

    // Descend to show a manually-expanded node's children, OR to hunt for nested matches under
    // an active search/filter. The expensive count maps above stay cached by token; only this
    // visible-tree walk widens under search.
    const descend = isExpandable && (expanded || searchActive)
    const childRows: ModelObjectRow[] = []
    if (descend) {
      // A child is "revealed" (shown regardless of its own match) when THIS node is manually
      // expanded during a permissive text search. Structured facets remain strict.
      const revealDirectChildren = expanded && !strictStructuredFilter
      childObjs.forEach((child) => childRows.push(...buildSubtree(child, level + 1, false, revealDirectChildren)))
    }

    // Keep this node if it matches itself, has a kept descendant (ancestor retention, so the
    // System/Container above a matched nested child are shown with it), OR its parent is
    // manually expanded (so expanding a node reveals all its children even when searching).
    if (!selfMatch && childRows.length === 0 && !parentRevealed) {
      seen.delete(id)
      return []
    }

    // Inline 'add child' affordances render only when the node is manually expanded (search or
    // not) — they never keep a node alive on their own (the check above runs first).
    const inlineAdd: ModelObjectRow[] = []
    if (expanded && !strictStructuredFilter) {
      if (obj?.type === 'system') {
        inlineAdd.push({ id: `inline-add-${id}`, name: '', type: 'app', level: level + 1, childCount: 0, isExpandable: false, appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0, isGroup: false, isInlineAdd: true, parentId: id, addTypes: ['app', 'store'] })
      }
      if (obj?.type === 'app' || obj?.type === 'store') {
        inlineAdd.push({ id: `inline-add-component-${id}`, name: '', type: 'component', level: level + 1, childCount: 0, isExpandable: false, appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0, isGroup: false, isInlineAdd: true, parentId: id, addTypes: ['component'] })
      }
    }
    return [selfRow, ...inlineAdd, ...childRows]
  }

  const result: ModelObjectRow[] = []
  const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name))
  sortedGroups.forEach((g) => result.push(...buildSubtree(g, 0, true, false)))
  rootObjects.forEach((o) => result.push(...buildSubtree(o, 0, false, false)))

  // total = the WHOLE model (objects + groups), so the footer count is correct even
  // when the resident store is windowed and the rows come from the index.
  return { rows: result, total: objects.length + groups.length }
}

export function modelObjectRowsFromStore(opts: ModelObjectRowsOpts): { rows: ModelObjectRow[]; total: number } {
  const s = useModelStore.getState()
  return computeModelObjectRows(
    { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows },
    [s.objects, s.connections, s.diagrams, s.groups],
    opts
  )
}

/** Index-backed (windowed store): objects + connections from the index; groups +
 * diagrams from the resident store. */
export async function modelObjectRowsFromIndex(store: KvStore, opts: ModelObjectRowsOpts): Promise<{ rows: ModelObjectRow[]; total: number }> {
  const s = useModelStore.getState()
  const technologyIds = opts.filter?.technologyIds?.filter(Boolean) ?? []
  const tagIds = opts.filter?.tagIds?.filter(Boolean) ?? []
  if (technologyIds.length || tagIds.length) {
    const [technologyEntityIds, tagEntityIds] = await Promise.all([
      technologyIds.length ? indexTechnologyEntityIds(store, technologyIds) : Promise.resolve<string[] | null>(null),
      tagIds.length ? indexTagEntityIds(store, tagIds) : Promise.resolve<string[] | null>(null),
    ])
    const tagEntityIdSet = tagEntityIds ? new Set(tagEntityIds) : null
    const directIds = technologyEntityIds && tagEntityIdSet
      ? technologyEntityIds.filter((id) => tagEntityIdSet.has(id))
      : (technologyEntityIds ?? tagEntityIds ?? [])
    const byId = new Map((await indexObjectsByIds(store, directIds)).map((object) => [object.id, object]))

    // Walk upward from matches only. These objects are retained by the core as
    // context, without reintroducing unrelated descendants.
    let frontier = [...byId.values()]
    while (frontier.length) {
      const parentIds = [...new Set(frontier.map((object) => object.parentId).filter((id): id is string => !!id && !byId.has(id)))]
      if (!parentIds.length) break
      const parents = await indexObjectsByIds(store, parentIds)
      frontier = []
      for (const parent of parents) {
        if (byId.has(parent.id)) continue
        byId.set(parent.id, parent)
        frontier.push(parent)
      }
    }

    // Bounded support rows preserve direct-child/component counts and the
    // existing "manual expansion reveals one level" behavior. Reads use ch: keys,
    // never o:* enumeration.
    const context = [...byId.values()]
    const directChildren = await indexChildrenOfMany(store, context.map((object) => object.id))
    for (const child of directChildren) byId.set(child.id, child)
    const nestedParents = directChildren.filter((object) => object.type === 'app' || object.type === 'store')
    const nestedChildren = await indexChildrenOfMany(store, nestedParents.map((object) => object.id))
    for (const child of nestedChildren) byId.set(child.id, child)

    const objects = [...byId.values()]
    const connections = await indexConnectionsTouching(store, objects.map((object) => object.id))
    const token = [
      'idx-postings', useModelIndexVersion.getState().version,
      [...new Set(technologyIds)].sort().join('\u0000'),
      [...new Set(tagIds)].sort().join('\u0000'), s.diagrams, s.groups,
    ]
    const result = computeModelObjectRows(
      { objects, connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows },
      token,
      opts
    )
    return { rows: result.rows, total: await indexModelEntityCount(store) }
  }
  const [objects, connections] = await Promise.all([cachedIndexObjects(store), cachedIndexConnections(store)])
  const token = ['idx', useModelIndexVersion.getState().version, s.diagrams, s.groups]
  return computeModelObjectRows({ objects, connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows }, token, opts)
}

// ── dependency focus picker (objects + groups) ────────────────────────────────
interface PickerCache { token: unknown[]; q: string; entries: PickerEntry[] }
let pickerCache: PickerCache | null = null

export function computePickerEntries(data: HeavyData, token: unknown[], opts: PickerOpts): PickerResult {
  const { search = '', offset = 0, limit = 100 } = opts
  const q = search.trim().toLowerCase()
  const fresh = sameTokens(pickerCache?.token ?? null, token) && pickerCache!.q === q

  let entries: PickerEntry[]
  if (fresh) {
    entries = pickerCache!.entries
  } else {
    const objEntries: PickerEntry[] = data.objects.map((o) => ({ id: o.id, name: o.name, kind: 'object', type: o.type, icon: o.icon, iconAssignment: o.iconAssignment, domainId: o.domainId }))
    const grpEntries: PickerEntry[] = data.groups.map((g) => ({ id: g.id, name: g.name, kind: 'group', icon: g.icon, iconAssignment: g.iconAssignment }))
    let all = [...objEntries, ...grpEntries]
    if (q) all = all.filter((e) => e.name.toLowerCase().includes(q))
    all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    entries = all
    pickerCache = { token, q, entries }
  }
  return { entries: entries.slice(offset, offset + limit), total: entries.length }
}

export function pickerEntriesFromStore(opts: PickerOpts): PickerResult {
  const s = useModelStore.getState()
  return computePickerEntries(
    { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows },
    [s.objects, s.groups],
    opts
  )
}

/** Index-backed (windowed store): objects from the index; groups from the store. */
export async function pickerEntriesFromIndex(store: KvStore, opts: PickerOpts): Promise<PickerResult> {
  const s = useModelStore.getState()
  const objects = await cachedIndexObjects(store)
  const token = ['idx', useModelIndexVersion.getState().version, s.groups]
  return computePickerEntries({ objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams, flows: s.flows }, token, opts)
}
