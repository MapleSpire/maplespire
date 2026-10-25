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

// A group's platform on the 3D board, and what dragging one moves. Scene3D only
// dispatches the results; the rules live here, in 2D world coordinates, so they
// can be tested without a WebGL scene.

import type { C4Object, Group } from '../types'
import { autoSizedInnerGroupIds, storedGroupsCarriedBy } from '../lib/groupNesting'
import type { Rect } from './connectionPath'

type Point = { x: number; y: number }

/**
 * The 2D computeGroupBounds contract with the board's own padding: a parent
 * wrapper always hugs its members; a standalone group honours stored geometry
 * only when autoSize is OFF; any other group derives its box from its members —
 * so moving a member re-hugs the platform live — and from the groups nested in
 * it (lib/groupNesting.ts), or a nested platform shares its edge and title.
 * `memo` is shared by one call's recursion: the inner list is transitive, so
 * without it a chain of d nested groups costs 2^(d-1) calls.
 */
export function groupPlatformRect(
  g: Group,
  groups: readonly Group[],
  objects: readonly C4Object[],
  onDiagram: ReadonlySet<string>,
  memo: Map<string, Rect> = new Map(),
): Rect {
  const known = memo.get(g.id)
  if (known) return known
  const isParentWrapper = !!g.parentObjectId
  const stored = g.position && g.size ? { x: g.position.x, y: g.position.y, w: g.size.width, h: g.size.height } : null
  if (g.autoSize === false && stored && !isParentWrapper) return stored
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of g.objectIds) {
    const o = objects.find((x) => x.id === id)
    if (!o) continue
    minX = Math.min(minX, o.position.x)
    minY = Math.min(minY, o.position.y)
    maxX = Math.max(maxX, o.position.x + o.size.width)
    maxY = Math.max(maxY, o.position.y + o.size.height)
  }
  if (!isFinite(minX)) {
    // No members on this diagram: stored geometry, else the 2D default 240x160
    // drop-target box at the group's position (or the origin).
    if (stored) return stored
    const pos = g.position ?? { x: 0, y: 0 }
    return { x: pos.x, y: pos.y, w: g.size?.width ?? 240, h: g.size?.height ?? 160 }
  }
  for (const innerId of autoSizedInnerGroupIds(g, groups, (id) => onDiagram.has(id))) {
    const inner = groups.find((x) => x.id === innerId)
    if (!inner) continue
    const r = groupPlatformRect(inner, groups, objects, onDiagram, memo)
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  const rect = { x: minX - 30, y: minY - 46, w: maxX - minX + 60, h: maxY - minY + 76 }
  memo.set(g.id, rect)
  return rect
}

/** Where a platform drag starts from (the 2D group-drag contract): the platform,
 *  the group's stored position, its members, and the stored-box groups nested in
 *  it, which ride along. */
export interface GroupDragStart {
  rect: Rect
  groupPos: Point | null
  members: Map<string, Point>
  carried: Map<string, Point>
}

export function startGroupDrag(
  group: Group | undefined,
  rect: Rect,
  groups: readonly Group[],
  objects: readonly C4Object[],
  onDiagram: ReadonlySet<string>,
): GroupDragStart {
  const members = new Map<string, Point>()
  for (const id of group?.objectIds ?? []) {
    const o = objects.find((x) => x.id === id)
    if (o) members.set(id, { x: o.position.x, y: o.position.y })
  }
  const carried = new Map<string, Point>()
  for (const id of group ? storedGroupsCarriedBy(group, groups, (oid) => onDiagram.has(oid)) : []) {
    const g = groups.find((x) => x.id === id)
    if (g?.position) carried.set(id, { x: g.position.x, y: g.position.y })
  }
  return {
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    groupPos: group?.position ? { x: group.position.x, y: group.position.y } : null,
    members,
    carried,
  }
}

/** Every position a platform drag to `pos` writes: each member and each carried
 *  group by the drag delta, then the group's stored position (an empty group
 *  without one follows `pos`). `snap` is the drop's grid snap, applied ONCE — to
 *  one anchor (the first member, which people align on the grid; else the stored
 *  position — a group carries nested boxes only when it has members) — and its
 *  correction added to
 *  everything: snapping each piece on its own moved them by different amounts,
 *  so they drifted apart on every drop. */
export function groupDragMoves(
  groupId: string,
  start: GroupDragStart,
  pos: Point,
  snap: (p: Point) => Point = (p) => p,
): { objects: Array<[string, Point]>; groups: Array<[string, Point]> } {
  let dx = pos.x - start.rect.x
  let dy = pos.y - start.rect.y
  const anchor = start.members.values().next().value ?? start.groupPos
  if (anchor) {
    const landed = { x: anchor.x + dx, y: anchor.y + dy }
    const snapped = snap(landed)
    dx += snapped.x - landed.x
    dy += snapped.y - landed.y
  }
  const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy })
  const objects = [...start.members].map(([id, p]): [string, Point] => [id, shift(p)])
  const groups = [...start.carried].map(([id, p]): [string, Point] => [id, shift(p)])
  if (start.groupPos) groups.push([groupId, shift(start.groupPos)])
  else if (start.members.size === 0) groups.push([groupId, snap(pos)])
  return { objects, groups }
}
