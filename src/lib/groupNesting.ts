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

import type { Group } from '../types'

/**
 * The groups an AUTO-SIZED standard group is drawn around, besides its own
 * members: every other group whose on-diagram members are a subset of its own.
 *
 * A group has no parent pointer, so nesting is read from membership. Drawn
 * around its members alone, an auto-sized group's box coincided with a group
 * nested in it whenever the nested one held its top member, and the two titles
 * were painted on one border. Equal member sets: an auto-sized group is drawn
 * around every equal group that is not auto-sized (a stored box, a wrapper), and
 * around an auto-sized one with a larger id — by id, not list order, because the
 * renderers receive groups in different orders (the canvas in store order, the
 * layout in `diagram.groupIds` order) and must agree. graph.ts `nestGroups`
 * plans the same order; ordering mixed pairs by id instead made three equal
 * groups (two stored, one auto-sized) nest in a cycle (review lens, 2026-10-25).
 *
 * Shared by CanvasEngine, Scene3D and the auto-layout's box derivation, so the
 * three nest groups by the same relation (each keeps its own padding).
 */
export function autoSizedInnerGroupIds(
  group: Group,
  groups: Iterable<Group>,
  isOnDiagram: (objectId: string) => boolean,
): string[] {
  if (group.parentObjectId || group.autoSize === false) return []
  const mine = new Set(group.objectIds.filter(isOnDiagram))
  if (mine.size === 0) return []
  const inner: string[] = []
  for (const other of groups) {
    if (other.id === group.id) continue
    const theirs = new Set(other.objectIds.filter(isOnDiagram))
    if (theirs.size === 0 || theirs.size > mine.size) continue
    let subset = true
    for (const id of theirs) {
      if (!mine.has(id)) {
        subset = false
        break
      }
    }
    if (!subset) continue
    if (theirs.size === mine.size && isAutoSized(other) && !(other.id > group.id)) continue
    inner.push(other.id)
  }
  return inner
}

/** A standard group whose box is derived from its members (and nested groups),
 *  not stored. */
export function isAutoSized(group: Group): boolean {
  return !group.parentObjectId && group.autoSize !== false
}

/**
 * The stored-box groups that travel with `group` when it is dragged: every other
 * standard group drawn at its stored box (`autoSize: false`) whose on-diagram
 * members all belong to `group`. An auto-sized or wrapper group follows its
 * members by itself; a stored box stays where it was — and an auto-sized group
 * drawn around it then stretched from its new place back to the box left behind.
 */
export function storedGroupsCarriedBy(
  group: Group,
  groups: Iterable<Group>,
  isOnDiagram: (objectId: string) => boolean,
): string[] {
  const mine = new Set(group.objectIds.filter(isOnDiagram))
  if (mine.size === 0) return []
  const carried: string[] = []
  for (const other of groups) {
    if (other.id === group.id || other.parentObjectId || other.autoSize !== false || !other.position) continue
    const theirs = other.objectIds.filter(isOnDiagram)
    if (theirs.length > 0 && theirs.every((id) => mine.has(id))) carried.push(other.id)
  }
  return carried
}
