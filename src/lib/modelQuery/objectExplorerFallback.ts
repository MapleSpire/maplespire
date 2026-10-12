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
import type { DiagramIndex } from '../../stores/modelStore'
import type { C4Object, Group, ShapeIconAssignment } from '../../types'
import type {
  ObjectExplorerPage,
  ObjectExplorerRow,
  ObjectSearchPageOpts,
  ObjectTreePageOpts,
} from './types'

const TYPE_ORDER: Record<string, number> = {
  group: 0, system: 1, actor: 2, app: 3, store: 4, component: 5,
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function pageOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0
  const match = /^local:(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : 0
}

function boundedLimit(value: number | undefined): number {
  return Math.min(50, Math.max(1, Number.isFinite(value) ? Math.floor(value!) : 50))
}

function canAcceptChildren(kind: 'object' | 'group', type: string): boolean {
  return kind === 'group' || type === 'system' || type === 'app' || type === 'store'
}

function iconFields(entity: C4Object | Group): { icon?: string; iconAssignment?: ShapeIconAssignment } {
  const candidate = entity as C4Object & { iconAssignment?: ShapeIconAssignment }
  return {
    ...(candidate.icon ? { icon: candidate.icon } : {}),
    ...(candidate.iconAssignment ? { iconAssignment: candidate.iconAssignment } : {}),
  }
}

/** Shared empty children list — callers only ever read it. */
const NO_CHILDREN: readonly C4Object[] = []

/**
 * Row metrics served from the store's prebuilt DiagramIndex instead of a scan
 * per row. The previous implementation cost O(C + D·|objectIds|) PER ROW — with
 * C=4.8k connections and D=608 diagrams (whose `.includes` is itself linear)
 * that was the dominant term of an 8.5s diagram load.
 */
function metrics(
  id: string,
  kind: 'object' | 'group',
  children: readonly C4Object[],
  idx: DiagramIndex,
) {
  let appCount = 0
  let storeCount = 0
  let componentCount = 0
  for (const child of children) {
    if (child.type === 'app') appCount += 1
    else if (child.type === 'store') storeCount += 1
    else if (child.type === 'component') componentCount += 1
  }
  // The endpoint reverse maps record a self-loop in BOTH directions, while the
  // `fromId === id || toId === id` filter this replaced counted it once.
  const from = idx.connectionsByFromId.get(id)
  const to = idx.connectionsByToId.get(id)
  let connectionCount = (from?.length ?? 0) + (to?.length ?? 0)
  if (from) for (const connection of from) if (connection.toId === id) connectionCount -= 1
  // object/groupToDiagramIds are keyed by ENTITY id -> the set of diagrams
  // containing it (DiagramIndex's JSDoc describes them the other way round).
  // Deliberately NOT the store's getGroupDiagramCount, which counts diagrams
  // holding a group's MEMBERS — a different number from `groupIds.includes(id)`.
  const diagramIds = kind === 'group'
    ? idx.groupToDiagramIds.get(id)
    : idx.objectToDiagramIds.get(id)
  return { appCount, storeCount, componentCount, connectionCount, diagramCount: diagramIds?.size ?? 0 }
}

function rowForObject(
  object: C4Object,
  idx: DiagramIndex,
  inDiagram: ReadonlySet<string>,
): ObjectExplorerRow {
  const children = idx.childrenByParentId.get(object.id) ?? NO_CHILDREN
  return {
    id: object.id,
    name: object.name,
    kind: 'object',
    type: object.type,
    parentId: object.parentId ?? null,
    childCount: children.length,
    hasChildren: children.length > 0,
    canAcceptChildren: canAcceptChildren('object', object.type),
    scope: object.scope,
    status: object.status,
    ...(object.domainId ? { domainId: object.domainId } : {}),
    ...iconFields(object),
    ...metrics(object.id, 'object', children, idx),
    inDiagram: inDiagram.has(object.id),
    breadcrumb: [],
  }
}

function rowForGroup(group: Group, idx: DiagramIndex, inDiagram: ReadonlySet<string>): ObjectExplorerRow {
  // Members that no longer resolve are dropped — the dangling-member case the
  // previous `objects.find(...)` + `objectIds.has(...)` pair also dropped.
  const children: C4Object[] = []
  for (const id of group.objectIds) {
    const member = idx.objectById.get(id)
    if (member) children.push(member)
  }
  return {
    id: group.id,
    name: group.name,
    kind: 'group',
    type: 'group',
    parentId: null,
    childCount: children.length,
    hasChildren: children.length > 0,
    canAcceptChildren: true,
    ...iconFields(group),
    ...((group as Group & { domainId?: string }).domainId
      ? { domainId: (group as Group & { domainId?: string }).domainId }
      : {}),
    ...metrics(group.id, 'group', children, idx),
    inDiagram: inDiagram.has(group.id),
    breadcrumb: [],
  }
}

/**
 * A tree entry before its row is materialised. Sorting only reads type/name/id,
 * so the page can be ordered and sliced first and the expensive row built for
 * the <=50 survivors — instead of building ~1.6k rows to return 50.
 *
 * `sortType` MUST be 'group' for groups: `Group` carries no `type` field (it is
 * synthesised by rowForGroup), so sorting raw entities would score groups
 * `TYPE_ORDER[undefined] ?? 9` and sink them BELOW every object.
 */
type TreeCandidate =
  | { kind: 'object'; id: string; name: string; sortType: string; object: C4Object }
  | { kind: 'group'; id: string; name: string; sortType: 'group'; group: Group }

function objectCandidate(object: C4Object): TreeCandidate {
  return { kind: 'object', id: object.id, name: object.name, sortType: object.type, object }
}

function groupCandidate(group: Group): TreeCandidate {
  return { kind: 'group', id: group.id, name: group.name, sortType: 'group', group }
}

function sortCandidates(a: TreeCandidate, b: TreeCandidate): number {
  return (TYPE_ORDER[a.sortType] ?? 9) - (TYPE_ORDER[b.sortType] ?? 9)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.id.localeCompare(b.id)
}

function paginate(
  rows: ObjectExplorerRow[],
  cursor: string | null | undefined,
  limitValue: number | undefined,
  total = rows.length,
): ObjectExplorerPage {
  const offset = pageOffset(cursor)
  const limit = boundedLimit(limitValue)
  const items = rows.slice(offset, offset + limit)
  return {
    projectionGeneration: 0,
    items,
    nextCursor: offset + items.length < rows.length ? `local:${offset + items.length}` : null,
    total,
    coverage: 'full',
  }
}

export async function residentObjectTreePage(opts: ObjectTreePageOpts): Promise<ObjectExplorerPage> {
  const state = useModelStore.getState()
  const idx = getDiagramIndex()
  const diagram = state.diagrams.find((candidate) => candidate.id === opts.diagramId)
  const diagramObjects = new Set(diagram?.objectIds ?? [])
  const diagramGroups = new Set(diagram?.groupIds ?? [])
  const group = opts.parentId ? idx.groupById.get(opts.parentId) : undefined
  let candidates: TreeCandidate[]

  if (group) {
    candidates = []
    for (const id of group.objectIds) {
      const member = idx.objectById.get(id)
      if (member) candidates.push(objectCandidate(member))
    }
  } else if (opts.parentId) {
    candidates = (idx.childrenByParentId.get(opts.parentId) ?? NO_CHILDREN).map(objectCandidate)
  } else {
    const grouped = new Set<string>()
    for (const candidate of state.groups) for (const id of candidate.objectIds) grouped.add(id)
    candidates = state.groups.map(groupCandidate)
    for (const object of state.objects) {
      if (grouped.has(object.id)) continue
      if (object.parentId && idx.objectById.has(object.parentId)) continue
      candidates.push(objectCandidate(object))
    }
  }

  // Order first, slice, and only then pay for rows — same result as building
  // every row and paginating, without materialising the ~1.6k discarded ones.
  candidates.sort(sortCandidates)
  const offset = pageOffset(opts.cursor)
  const limit = boundedLimit(opts.limit)
  const items = candidates.slice(offset, offset + limit).map((candidate) => candidate.kind === 'group'
    ? rowForGroup(candidate.group, idx, diagramGroups)
    : rowForObject(candidate.object, idx, diagramObjects))
  return {
    projectionGeneration: 0,
    items,
    nextCursor: offset + items.length < candidates.length ? `local:${offset + items.length}` : null,
    total: state.objects.length + state.groups.length,
    coverage: 'full',
  }
}

function technologyIds(object: C4Object): string[] {
  return Object.values(object.technologyUsages ?? {}).map((usage) => usage.technologyId)
}

function breadcrumbFor(object: C4Object, byId: ReadonlyMap<string, C4Object>): Array<{ id: string; name: string }> {
  const result: Array<{ id: string; name: string }> = []
  const seen = new Set([object.id])
  let parentId = object.parentId
  while (parentId && result.length < 64 && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    result.unshift({ id: parent.id, name: parent.name })
    parentId = parent.parentId
  }
  return result
}

export async function residentObjectSearchPage(opts: ObjectSearchPageOpts): Promise<ObjectExplorerPage> {
  const state = useModelStore.getState()
  const diagram = state.diagrams.find((candidate) => candidate.id === opts.diagramId)
  const diagramObjects = new Set(diagram?.objectIds ?? [])
  const diagramGroups = new Set(diagram?.groupIds ?? [])
  const idx = getDiagramIndex()
  const byId = idx.objectById
  const query = normalize(opts.query ?? '')
  const types = new Set(opts.filter?.types ?? [])
  const selectedTechnologies = new Set(opts.filter?.technologyIds ?? [])
  const selectedTags = new Set(opts.filter?.tagIds ?? [])
  const selectedStatuses = new Set(opts.filter?.statuses ?? (opts.filter?.status ? [opts.filter.status] : []))
  const selectedTeams = new Set(opts.filter?.teamIds ?? [])
  const rows: Array<ObjectExplorerRow & { score: number }> = []

  const score = (name: string, searchText: string): number => {
    if (!query) return 1
    const normalizedName = normalize(name)
    if (normalizedName === query) return 4
    if (normalizedName.startsWith(query)) return 3
    if (normalizedName.includes(` ${query}`)) return 2
    return normalize(searchText).includes(query) ? 1 : 0
  }

  for (const object of state.objects) {
    if (types.size && !types.has(object.type)) continue
    if (opts.filter?.scope && object.scope !== opts.filter.scope) continue
    if (selectedTechnologies.size && !technologyIds(object).some((id) => selectedTechnologies.has(id))) continue
    if (selectedTags.size && !Object.keys(object.tagAssignments ?? {}).some((id) => selectedTags.has(id))) continue
    if (selectedStatuses.size && !selectedStatuses.has(object.status)) continue
    if (selectedTeams.size && ![...(object.ownerTeamIds ?? []), ...(object.teamIds ?? [])].some((id) => selectedTeams.has(id))) continue
    if (opts.filter?.hasDescription !== undefined && Boolean(object.description?.trim()) !== opts.filter.hasDescription) continue
    if (opts.filter?.inDiagram !== undefined && diagramObjects.has(object.id) !== opts.filter.inDiagram) continue
    if (opts.domainId && object.domainId !== opts.domainId) continue
    const technologyText = Object.values(object.technologyUsages ?? {}).map((usage) => usage.snapshot.name).join(' ')
    const value = score(object.name, `${object.name} ${object.description ?? ''} ${technologyText}`)
    if (query && !value) continue
    const row = rowForObject(object, idx, diagramObjects)
    row.breadcrumb = breadcrumbFor(object, byId)
    row.matchKind = query ? value === 4 ? 'exact' : value === 3 ? 'prefix' : value === 2 ? 'word_prefix' : 'contains' : 'filter'
    rows.push({ ...row, score: value })
  }
  const groupOnlyFiltersSupported = !opts.filter?.scope && !selectedStatuses.size && !selectedTeams.size
    && opts.filter?.hasDescription === undefined
  if (groupOnlyFiltersSupported && (!types.size || types.has('group'))) {
    for (const group of state.groups) {
      const groupTechnologies = Object.values(group.technologyUsages ?? {}).map((usage) => usage.technologyId)
      if (selectedTechnologies.size && !groupTechnologies.some((id) => selectedTechnologies.has(id))) continue
      if (selectedTags.size && !Object.keys(group.tagAssignments ?? {}).some((id) => selectedTags.has(id))) continue
      if (opts.filter?.inDiagram !== undefined && diagramGroups.has(group.id) !== opts.filter.inDiagram) continue
      if (opts.domainId && (group as Group & { domainId?: string }).domainId !== opts.domainId) continue
      const value = score(group.name, group.name)
      if (query && !value) continue
      const row = rowForGroup(group, idx, diagramGroups)
      row.matchKind = query ? value === 4 ? 'exact' : value === 3 ? 'prefix' : value === 2 ? 'word_prefix' : 'contains' : 'filter'
      rows.push({ ...row, score: value })
    }
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
  return paginate(rows, opts.cursor, opts.limit, state.objects.length + state.groups.length)
}
