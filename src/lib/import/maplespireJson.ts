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

import type {
  C4Object, C4Type, Connection, Diagram, Domain, Flow, Group, ObjectScope, Tag,
  TechnologyRole, TechnologyShapeType, TechnologyUsage,
} from '../../types'
import { generateId } from '../utils'
import { sanitizeSceneDecor } from '../../canvas3d/decor/decorSpec'
import { defaultShapeSize } from '../shapeDefaults'

/** Keep only `'internal'|'external'` entries for objects on the diagram. */
function sanitizeObjectScopes(raw: unknown, objectIds: readonly string[]): Record<string, ObjectScope> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const onDiagram = new Set(objectIds)
  const out: Record<string, ObjectScope> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (onDiagram.has(id) && (value === 'internal' || value === 'external')) out[id] = value
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Parse + plan an import of a `maplespire-model` JSON export (the Share →
 * Export → JSON file). Pure module — the modal applies the resulting plan via
 * `modelStore.applyJsonImport`.
 *
 * Merge semantics (per spec): an entity whose id ALREADY EXISTS in the target
 * is reused as-is — its properties (technology usages, tags, …) are NOT updated.
 * Only new entities are created. Diagrams are ALWAYS created (a colliding
 * diagram id gets a fresh one), so an import never silently edits an existing
 * diagram; their flows come along, remapped to the new diagram ids.
 */

export interface MapleSpireExport {
  format: 'maplespire-model'
  version: 3
  landscape: string
  scope?: 'landscape' | 'diagram'
  domains: Domain[]
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  tags: Tag[]
  flows: Flow[]
  diagrams: Diagram[]
}

const C4_TYPES: C4Type[] = ['actor', 'system', 'app', 'store', 'component']
// The editor's box for a new shape, for every type — see `shapeDefaults.ts`.
const DEFAULT_SIZE: Record<C4Type, { width: number; height: number }> = {
  actor: defaultShapeSize(),
  system: defaultShapeSize(),
  app: defaultShapeSize(),
  store: defaultShapeSize(),
  component: defaultShapeSize(),
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

const TECHNOLOGY_ROLES = new Set<TechnologyRole>([
  'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
  'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other',
])
const TECHNOLOGY_SHAPE_TYPES = new Set<TechnologyShapeType>([
  'system', 'app', 'store', 'component', 'group',
])

/** Also the clipboard's gate (`lib/clipboard/canvasClipboard`): a usage that
 * fails it would be written to the model and crash every renderer reading it. */
export function validatedTechnologyUsages(
  value: unknown,
  entityKind: 'Object' | 'Group',
  entityId: string,
): Record<string, TechnologyUsage> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${entityKind} "${entityId}" has invalid technologyUsages — expected an id-keyed object.`)
  }
  const usages = value as Record<string, Partial<TechnologyUsage>>
  for (const [key, usage] of Object.entries(usages)) {
    const recommendations = usage?.snapshot?.recommendedShapeTypes
    if (!usage || usage.id !== key || typeof usage.technologyId !== 'string'
      || !Number.isInteger(usage.catalogRevision) || (usage.catalogRevision ?? 0) < 1
      || usage.snapshot?.schemaVersion !== 1 || typeof usage.snapshot.name !== 'string'
      || (usage.role !== undefined && !TECHNOLOGY_ROLES.has(usage.role))
      || (usage.snapshot.defaultRole !== undefined && !TECHNOLOGY_ROLES.has(usage.snapshot.defaultRole))
      || (recommendations !== undefined && (!Array.isArray(recommendations)
        || recommendations.length < 1
        || recommendations.length > TECHNOLOGY_SHAPE_TYPES.size
        || new Set(recommendations).size !== recommendations.length
        || recommendations.some((type) => !TECHNOLOGY_SHAPE_TYPES.has(type))))) {
      throw new Error(`${entityKind} "${entityId}" has an invalid technology usage "${key}".`)
    }
  }
  return usages as Record<string, TechnologyUsage>
}

function validatedTagAssignments(
  raw: Record<string, unknown>,
  entityKind: 'Object' | 'Group',
  entityId: string,
): Pick<C4Object, 'tagAssignments' | 'tagOrder'> {
  if ('tags' in raw) {
    throw new Error(`${entityKind} "${entityId}" uses the removed name-based Tag format; export it again as version 3.`)
  }
  if (!raw.tagAssignments || typeof raw.tagAssignments !== 'object' || Array.isArray(raw.tagAssignments)) {
    throw new Error(`${entityKind} "${entityId}" has invalid tagAssignments — expected an id-keyed object.`)
  }
  const assignments = raw.tagAssignments as Record<string, { tagId?: unknown }>
  for (const [key, assignment] of Object.entries(assignments)) {
    if (!assignment || assignment.tagId !== key) {
      throw new Error(`${entityKind} "${entityId}" has an invalid Tag assignment "${key}".`)
    }
  }
  const order = asArray<string>(raw.tagOrder)
  if (order.some((tagId) => typeof tagId !== 'string') || new Set(order).size !== order.length
    || order.some((tagId) => !assignments[tagId])) {
    throw new Error(`${entityKind} "${entityId}" has an invalid tagOrder.`)
  }
  const missing = Object.keys(assignments).filter((tagId) => !order.includes(tagId)).sort()
  return {
    tagAssignments: assignments as C4Object['tagAssignments'],
    tagOrder: [...order, ...missing],
  }
}

const TAG_COLOR = /^#[0-9A-Fa-f]{6}$/

function containsUnsafeCatalogText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) return true
  }
  return false
}

function validatedTagSnapshots(value: unknown): Tag[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('Invalid Tag snapshots — expected an array.')
  }

  const snapshots: Tag[] = []
  const seen = new Set<string>()
  for (const [index, rawSnapshot] of value.entries()) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) {
      throw new Error(`Invalid Tag snapshot at index ${index}.`)
    }
    const snapshot = rawSnapshot as Record<string, unknown>
    const tagId = typeof snapshot.tagId === 'string' ? snapshot.tagId.trim() : ''
    const groupId = typeof snapshot.groupId === 'string' ? snapshot.groupId.trim() : ''
    const tagValue = typeof snapshot.value === 'string' ? snapshot.value.trim() : ''
    const groupName = typeof snapshot.groupName === 'string' ? snapshot.groupName.trim() : ''
    const color = typeof snapshot.color === 'string' ? snapshot.color : ''

    if (!tagId || tagId.length > 200 || containsUnsafeCatalogText(tagId)
      || !groupId || groupId.length > 200 || containsUnsafeCatalogText(groupId)
      || !tagValue || tagValue.length > 256 || containsUnsafeCatalogText(tagValue)
      || !groupName || groupName.length > 256 || containsUnsafeCatalogText(groupName)
      || !TAG_COLOR.test(color)
      || !Number.isInteger(snapshot.catalogRevision) || (snapshot.catalogRevision as number) < 1) {
      throw new Error(`Invalid Tag snapshot "${tagId || index}".`)
    }
    if (seen.has(tagId)) {
      throw new Error(`Duplicate Tag snapshot id "${tagId}".`)
    }
    seen.add(tagId)
    snapshots.push({
      tagId,
      value: tagValue,
      color: color.toUpperCase(),
      groupId,
      groupName,
      catalogRevision: snapshot.catalogRevision as number,
    })
  }
  return snapshots
}

/** Parse + validate the pasted/uploaded text. Throws a user-facing message. */
export function parseMapleSpireJson(text: string): MapleSpireExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON — paste the file produced by Share → Export → JSON.')
  }
  const doc = raw as Record<string, unknown>
  if (!doc || typeof doc !== 'object' || doc.format !== 'maplespire-model') {
    throw new Error('Not a MapleSpire model export — expected `"format": "maplespire-model"` (Share → Export → JSON).')
  }
  if (doc.version !== 3) {
    throw new Error(`Unsupported export version ${String(doc.version)} — this build reads version 3.`)
  }

  // Normalise objects defensively: a hand-edited file must not crash the canvas.
  const rawObjects = asArray<Record<string, unknown>>(doc.objects)
  for (const object of rawObjects) {
    if ('technology' in object || 'technologies' in object) {
      throw new Error(`Object "${String(object.id ?? '?')}" uses the removed technology format; export it again as version 2.`)
    }
  }
  const objects = rawObjects
    .filter((o) => o && typeof o.id === 'string' && typeof o.name === 'string')
    .map((o): C4Object => {
      const type: C4Type = C4_TYPES.includes(o.type as C4Type) ? (o.type as C4Type) : 'app'
      const technologyUsages = validatedTechnologyUsages(o.technologyUsages, 'Object', o.id as string)
      const tagFields = validatedTagAssignments(o, 'Object', o.id as string)
      return {
        ...(o as unknown as Partial<C4Object>),
        id: o.id as string,
        name: o.name as string,
        type,
        position: (o.position as C4Object['position'] | undefined) ?? { x: 0, y: 0 },
        size: (o.size as C4Object['size'] | undefined) ?? { ...DEFAULT_SIZE[type] },
        ...tagFields,
        scope: o.scope === 'external' ? 'external' : 'internal',
        status: (o.status as C4Object['status'] | undefined) ?? 'live',
        properties: (o.properties as Record<string, string> | undefined) ?? {},
        ...(technologyUsages ? { technologyUsages } : {}),
      }
    })

  const connections = asArray<Partial<Connection>>(doc.connections)
    .filter((c) => c && typeof c.id === 'string' && typeof c.fromId === 'string' && typeof c.toId === 'string')
    .map((c): Connection => ({ ...c, id: c.id!, fromId: c.fromId!, toId: c.toId!, type: c.type ?? 'solid' }))

  const diagrams = asArray<Partial<Diagram>>(doc.diagrams)
    .filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
    .map((d): Diagram => {
      const dg: Diagram = {
        ...d,
        id: d.id!,
        name: d.name!,
        type: d.type === 'container' || d.type === 'component' ? d.type : 'context',
        objectIds: asArray<string>(d.objectIds),
        connectionIds: asArray<string>(d.connectionIds),
        groupIds: asArray<string>(d.groupIds),
      }
      // Imported decor is untrusted — sanitize or strip entirely (never keep
      // a key holding undefined: Automerge rejects undefined values).
      const sceneDecor = sanitizeSceneDecor(d.sceneDecor)
      if (sceneDecor) dg.sceneDecor = sceneDecor
      else delete dg.sceneDecor
      // Per-diagram scope overrides are untrusted too: keep only known values
      // for objects on this diagram (a non-object here would make the store's
      // override write throw).
      const objectScopes = sanitizeObjectScopes(d.objectScopes, dg.objectIds)
      if (objectScopes) dg.objectScopes = objectScopes
      else delete dg.objectScopes
      return dg
    })

  const rawGroups = asArray<Record<string, unknown>>(doc.groups)
  for (const group of rawGroups) {
    if ('technology' in group || 'technologies' in group) {
      throw new Error(`Group "${String(group.id ?? '?')}" uses the removed technology format; export it again as version 2.`)
    }
  }
  const groups = rawGroups
    .filter((group) => group && typeof group.id === 'string')
    .map((group): Group => {
      const technologyUsages = validatedTechnologyUsages(group.technologyUsages, 'Group', group.id as string)
      const tagFields = validatedTagAssignments(group, 'Group', group.id as string)
      return {
        ...(group as unknown as Partial<Group>),
        id: group.id as string,
        name: typeof group.name === 'string' ? group.name : 'Group',
        color: typeof group.color === 'string' ? group.color : '#888888',
        objectIds: asArray<string>(group.objectIds),
        ...tagFields,
        ...(technologyUsages ? { technologyUsages } : {}),
      }
    })

  return {
    format: 'maplespire-model',
    version: 3,
    landscape: typeof doc.landscape === 'string' ? doc.landscape : 'Imported landscape',
    scope: doc.scope === 'diagram' ? 'diagram' : 'landscape',
    domains: asArray<Domain>(doc.domains).filter((d) => d && typeof d.id === 'string'),
    objects,
    connections,
    groups,
    tags: validatedTagSnapshots(doc.tags),
    flows: asArray<Flow>(doc.flows).filter((f) => f && typeof f.id === 'string' && typeof f.diagramId === 'string'),
    diagrams,
  }
}

/** Ids already present in the target workspace (existing entities win). */
export interface ExistingIds {
  objectIds: Set<string>
  connectionIds: Set<string>
  groupIds: Set<string>
  domainIds: Set<string>
  tagIds: Set<string>
  diagramIds: Set<string>
  flowIds: Set<string>
}

export interface JsonImportPlan {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  domains: Domain[]
  tags: Tag[]
  diagrams: Diagram[]
  flows: Flow[]
  entryDiagramId: string | null
  stats: {
    newObjects: number
    existingObjects: number
    newConnections: number
    existingConnections: number
    droppedConnections: number
    newGroups: number
    newDomains: number
    newTags: number
    diagrams: number
    flows: number
  }
}

export interface PlanOptions {
  /** Injectable id factory (tests pass a deterministic counter). */
  idFactory?: () => string
}

/**
 * Compute what an import creates in a target workspace. Existing ids are
 * reused untouched; diagrams/flows always import under fresh ids on collision.
 */
export function planJsonImport(parsed: MapleSpireExport, existing: ExistingIds, opts: PlanOptions = {}): JsonImportPlan {
  const newId = opts.idFactory ?? generateId

  const newObjects = parsed.objects.filter((o) => !existing.objectIds.has(o.id))
  // Every object id resolvable after the import (existing ∪ imported).
  const knownObjects = new Set<string>(existing.objectIds)
  for (const o of parsed.objects) knownObjects.add(o.id)

  // Strip references that resolve to nothing so the canvas never chases them.
  const objects = newObjects.map((o) => {
    const out = { ...o }
    if (out.parentId && !knownObjects.has(out.parentId)) delete out.parentId
    return out
  })

  const newConnections: Connection[] = []
  let existingConnections = 0
  let droppedConnections = 0
  for (const c of parsed.connections) {
    if (existing.connectionIds.has(c.id)) {
      existingConnections++
      continue
    }
    if (!knownObjects.has(c.fromId) || !knownObjects.has(c.toId)) {
      droppedConnections++
      continue
    }
    newConnections.push(c)
  }
  const knownConnections = new Set<string>(existing.connectionIds)
  for (const c of newConnections) knownConnections.add(c.id)

  const newGroups = parsed.groups
    .filter((g) => !existing.groupIds.has(g.id))
    .map((g) => {
      const out = { ...g, objectIds: g.objectIds.filter((id) => knownObjects.has(id)) }
      if (out.parentObjectId && !knownObjects.has(out.parentObjectId)) delete out.parentObjectId
      return out
    })
  const knownGroups = new Set<string>(existing.groupIds)
  for (const g of newGroups) knownGroups.add(g.id)

  const newDomains = parsed.domains.filter((d) => !existing.domainIds.has(d.id))
  // Snapshots dedupe by stable id. Display values are not identities and may
  // legitimately repeat across governed Tag groups.
  const newTags = parsed.tags.filter((snapshot) => !existing.tagIds.has(snapshot.tagId))

  // Diagrams are always created; remap colliding ids (and their flows).
  const diagramIdMap = new Map<string, string>()
  const diagrams = parsed.diagrams.map((d) => {
    const id = existing.diagramIds.has(d.id) ? newId() : d.id
    diagramIdMap.set(d.id, id)
    return {
      ...d,
      id,
      objectIds: d.objectIds.filter((oid) => knownObjects.has(oid)),
      connectionIds: d.connectionIds.filter((cid) => knownConnections.has(cid)),
      groupIds: d.groupIds.filter((gid) => knownGroups.has(gid)),
    }
  })

  const flows = parsed.flows
    .filter((f) => diagramIdMap.has(f.diagramId))
    .map((f) => ({
      ...f,
      id: existing.flowIds.has(f.id) ? newId() : f.id,
      diagramId: diagramIdMap.get(f.diagramId)!,
    }))

  const entry = diagrams.find((d) => d.type === 'context') ?? diagrams[0] ?? null

  return {
    objects,
    connections: newConnections,
    groups: newGroups,
    domains: newDomains,
    tags: newTags,
    diagrams,
    flows,
    entryDiagramId: entry?.id ?? null,
    stats: {
      newObjects: objects.length,
      existingObjects: parsed.objects.length - newObjects.length,
      newConnections: newConnections.length,
      existingConnections,
      droppedConnections,
      newGroups: newGroups.length,
      newDomains: newDomains.length,
      newTags: newTags.length,
      diagrams: diagrams.length,
      flows: flows.length,
    },
  }
}

/** Snapshot the target workspace's ids from the resident model store state. */
export function existingIdsFromState(s: {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  domains: Domain[]
  tags: Tag[]
  diagrams: Diagram[]
  flows: Flow[]
}): ExistingIds {
  return {
    objectIds: new Set(s.objects.map((o) => o.id)),
    connectionIds: new Set(s.connections.map((c) => c.id)),
    groupIds: new Set(s.groups.map((g) => g.id)),
    domainIds: new Set(s.domains.map((d) => d.id)),
    tagIds: new Set(s.tags.map((snapshot) => snapshot.tagId)),
    diagramIds: new Set(s.diagrams.map((d) => d.id)),
    flowIds: new Set(s.flows.map((f) => f.id)),
  }
}
