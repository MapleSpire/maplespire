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

import type { C4Object, Connection, Diagram, Group, SelectedItem } from '../../types'
import type { Placement } from '../history/modelDiff'
import type { CanvasClipboardPayload } from './canvasClipboard'

/**
 * What Ctrl+V does with a clipboard payload, decided as data.
 *
 * A C4 workspace is ONE model drawn by many views, so a paste has two honest
 * meanings and the planner picks between them:
 *
 * - **reference** — the copied elements exist in this workspace and are not
 *   drawn on the target diagram yet: they are added to it, same ids. Copying a
 *   system from the context diagram into a container diagram shows that system
 *   there; it does not mint a second "Payments" in the model. Cut then paste
 *   moves elements between views and keeps their identity, connections and
 *   documentation.
 * - **copy** — new elements with fresh ids, named "… (copy)". Used when a view
 *   cannot draw the same element twice (pasting where the originals already
 *   are — the plain duplicate), when an element no longer exists, when the
 *   payload comes from another workspace, and always for "Paste as copy"
 *   (Ctrl+Shift+V) and Duplicate (Ctrl+D).
 *
 * One mode per paste, never mixed: a half-referenced, half-copied paste would
 * leave the user unable to tell which shapes are the originals.
 */

export type PasteMode = 'copy' | 'reference'

export interface PasteContext {
  workspaceKey: string
  target: Diagram
  /** Existence in the MODEL (not just the resident window). */
  objectExists: (id: string) => boolean
  groupExists: (id: string) => boolean
  connectionExists: (id: string) => boolean
  /** Tag ids of the target workspace. Only consulted for a cross-workspace
   * paste, whose tag assignments name another registry. */
  knownTagIds: ReadonlySet<string>
  defaultDomainId?: string
  forceCopy: boolean
  /** World-space translation applied to every placement. */
  offset: { x: number; y: number }
  mintId: () => string
  copyName: (name: string) => string
}

export interface PastePlan {
  mode: PasteMode
  newObjects: C4Object[]
  newGroups: Group[]
  newConnections: Connection[]
  /** Existing elements to add to the target diagram (reference mode). */
  addObjectIds: string[]
  addGroupIds: string[]
  addConnectionIds: string[]
  /** Final placement by FINAL id (new or referenced). */
  placements: Record<string, Placement>
  selection: SelectedItem[]
}

export function pasteMode(payload: CanvasClipboardPayload, ctx: PasteContext): PasteMode {
  if (ctx.forceCopy || payload.workspaceKey !== ctx.workspaceKey) return 'copy'
  const onObjects = new Set(ctx.target.objectIds)
  const onGroups = new Set(ctx.target.groupIds)
  for (const o of payload.objects) if (onObjects.has(o.id) || !ctx.objectExists(o.id)) return 'copy'
  for (const g of payload.groups) if (onGroups.has(g.id) || !ctx.groupExists(g.id)) return 'copy'
  return 'reference'
}

/** World-space bounding box of the copied shapes, as they were shown. */
export function payloadBounds(payload: Pick<CanvasClipboardPayload, 'placements'>): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { position, size } of Object.values(payload.placements)) {
    minX = Math.min(minX, position.x)
    minY = Math.min(minY, position.y)
    maxX = Math.max(maxX, position.x + size.width)
    maxY = Math.max(maxY, position.y + size.height)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function moved(placement: Placement, offset: { x: number; y: number }): Placement {
  return {
    position: { x: placement.position.x + offset.x, y: placement.position.y + offset.y },
    size: { ...placement.size },
  }
}

function filterTags<T extends { tagAssignments?: Record<string, unknown>; tagOrder?: string[] }>(entity: T, known: ReadonlySet<string>): T {
  if (!entity.tagAssignments) return entity
  const tagAssignments = Object.fromEntries(Object.entries(entity.tagAssignments).filter(([id]) => known.has(id)))
  const tagOrder = (entity.tagOrder ?? []).filter((id) => known.has(id))
  return { ...entity, tagAssignments, tagOrder }
}

/** The C4 parent a NEW element gets on `target` — `addObject`'s rule: an
 * app/store on a container diagram, or a component on a component diagram,
 * belongs to the element that diagram details. */
export function parentForPaste(type: C4Object['type'], target: Diagram, sourceParentId: string | undefined): string | undefined {
  if (target.parentObjectId) {
    if (target.type === 'container' && (type === 'app' || type === 'store')) return target.parentObjectId
    if (target.type === 'component' && type === 'component') return target.parentObjectId
  }
  return sourceParentId
}

export function planPaste(payload: CanvasClipboardPayload, ctx: PasteContext): PastePlan {
  const mode = pasteMode(payload, ctx)
  const plan: PastePlan = {
    mode,
    newObjects: [], newGroups: [], newConnections: [],
    addObjectIds: [], addGroupIds: [], addConnectionIds: [],
    placements: {}, selection: [],
  }

  if (mode === 'reference') {
    const onConnections = new Set(ctx.target.connectionIds)
    for (const o of payload.objects) {
      plan.addObjectIds.push(o.id)
      plan.selection.push({ id: o.id, type: 'object' })
    }
    for (const g of payload.groups) {
      plan.addGroupIds.push(g.id)
      plan.selection.push({ id: g.id, type: 'group' })
    }
    for (const c of payload.connections) {
      if (ctx.connectionExists(c.id) && !onConnections.has(c.id)) plan.addConnectionIds.push(c.id)
    }
    for (const [id, placement] of Object.entries(payload.placements)) plan.placements[id] = moved(placement, ctx.offset)
    return plan
  }

  const crossWorkspace = payload.workspaceKey !== ctx.workspaceKey
  const idMap = new Map<string, string>()
  for (const o of payload.objects) idMap.set(o.id, ctx.mintId())
  for (const g of payload.groups) idMap.set(g.id, ctx.mintId())

  for (const source of payload.objects) {
    const id = idMap.get(source.id)!
    const placement = payload.placements[source.id]
      ? moved(payload.placements[source.id], ctx.offset)
      : moved({ position: source.position, size: source.size }, ctx.offset)
    let copy: C4Object = {
      ...source,
      id,
      name: ctx.copyName(source.name),
      position: placement.position,
      size: placement.size,
      parentId: parentForPaste(source.type, ctx.target, crossWorkspace ? undefined : source.parentId),
    }
    if (copy.parentId === undefined) delete copy.parentId
    if (crossWorkspace) {
      copy = filterTags(copy, ctx.knownTagIds)
      if (ctx.defaultDomainId) copy.domainId = ctx.defaultDomainId
      else delete copy.domainId
    }
    plan.newObjects.push(copy)
    plan.placements[id] = placement
    plan.selection.push({ id, type: 'object' })
  }

  for (const source of payload.groups) {
    const id = idMap.get(source.id)!
    let copy: Group = {
      ...source,
      id,
      objectIds: source.objectIds.flatMap((member) => {
        const mapped = idMap.get(member)
        return mapped ? [mapped] : []
      }),
    }
    delete copy.parentObjectId
    delete copy.innerWrapperIds
    const placement = payload.placements[source.id]
    if (placement) {
      const p = moved(placement, ctx.offset)
      copy.position = p.position
      copy.size = p.size
      plan.placements[id] = p
    }
    if (crossWorkspace) {
      copy = filterTags(copy, ctx.knownTagIds)
      if (ctx.defaultDomainId) copy.domainId = ctx.defaultDomainId
      else delete copy.domainId
    }
    plan.newGroups.push(copy)
    plan.selection.push({ id, type: 'group' })
  }

  for (const source of payload.connections) {
    const fromId = idMap.get(source.fromId)
    const toId = idMap.get(source.toId)
    if (!fromId || !toId) continue
    let copy: Connection = { ...source, id: ctx.mintId(), fromId, toId }
    delete copy.kind
    // Bend points are absolute: they move with the shapes, or the copy's line
    // would route back through the originals.
    const shift = (points: Connection['waypoints']) =>
      points?.map((p) => ({ x: p.x + ctx.offset.x, y: p.y + ctx.offset.y }))
    if (copy.waypoints) copy.waypoints = shift(copy.waypoints)
    if (copy.waypoints3d) copy.waypoints3d = shift(copy.waypoints3d)
    if (crossWorkspace) copy = filterTags(copy, ctx.knownTagIds)
    plan.newConnections.push(copy)
  }
  return plan
}
