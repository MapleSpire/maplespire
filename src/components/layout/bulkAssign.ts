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

import { assignTag, unassignTag } from '../../lib/tags/assignments'
import { assignTechnologyUsages, removeTechnologyUsage } from '../../lib/technologyUsage'
import type { C4Object, TechnologyUsage } from '../../types'

/**
 * One tag or technology onto MANY shapes.
 *
 * The pickers' basket lands N items on one shape. This is the mirror job — one
 * item onto N shapes — and the two store actions that look like the answer are
 * not:
 *
 *  - `addTagToSelected(tagId)` calls `assignTag` and stops. The single-shape
 *    path (`addTagToObject`) also calls `rememberTagSnapshot`, without which a
 *    tag the workspace registry has never seen renders as "unavailable" until
 *    the catalog is re-fetched.
 *  - `addTechnologyToSelected(usage)` writes `technologyUsages[usage.id]`
 *    directly: no `technologyUsageOrder` entry, no derived icon, a different
 *    de-duplication rule from `assignTechnologyUsage` (it compares the whole
 *    role/version tuple where the real path compares `technologyId`), and the
 *    SAME usage id on every shape it touches.
 *
 * Applying either would give a bulk apply that quietly differs from doing the
 * same thing one shape at a time. So these plan the writes with the exact
 * helpers the single-shape path uses, and the caller commits them through
 * `updateEntitiesBatch` — one store write, one sync sweep, for the whole
 * selection.
 */

/** Shaped for `updateEntitiesBatch({ objects })`. */
export interface BulkObjectUpdate {
  id: string
  data: Partial<C4Object>
}

/**
 * How many of the selected shapes carry each tag.
 *
 * Drives the "on some, not all" marker. Showing only the tags common to every
 * shape would hide the partial ones entirely — including from the remove
 * button — and showing the union unmarked would claim they are on all of them.
 */
export function tagCoverage(objects: readonly C4Object[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const object of objects) {
    for (const tagId of Object.keys(object.tagAssignments ?? {})) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
    }
  }
  return counts
}

/** A tag-carrying slice of an object, cloned so the helpers can mutate it. */
function tagDraft(object: C4Object) {
  return {
    tagAssignments: { ...(object.tagAssignments ?? {}) },
    tagOrder: [...(object.tagOrder ?? [])],
  }
}

/**
 * Assign every tag in `tagIds` to every shape that does not already carry it.
 *
 * Takes the WHOLE basket, not one tag, and that is load-bearing. `TagPicker`
 * commits a staged basket by replaying its single-add callback once per tag,
 * which is safe for the single-shape call sites because those mutate a live
 * immer draft incrementally. This plans a complete `tagAssignments`/`tagOrder`
 * map from the objects it was handed — and all the replays land in one tick,
 * before React re-renders, so each would read the same pre-update objects and
 * clobber the one before it. A three-tag basket applied exactly one tag.
 *
 * Shapes that already carry everything produce NO update. That is not just
 * economy: each write re-runs the sync bridge's model sweep, and an assignment
 * that changes nothing would still mark the object edited for every peer.
 */
export function planBulkTagAssign(
  objects: readonly C4Object[],
  tagIds: readonly string[],
): BulkObjectUpdate[] {
  const updates: BulkObjectUpdate[] = []
  for (const object of objects) {
    const missing = tagIds.filter((tagId) => !object.tagAssignments?.[tagId])
    if (missing.length === 0) continue
    const draft = tagDraft(object)
    for (const tagId of missing) assignTag(draft, tagId)
    updates.push({ id: object.id, data: draft })
  }
  return updates
}

/** Remove `tagId` from every shape that carries it. */
export function planBulkTagRemove(objects: readonly C4Object[], tagId: string): BulkObjectUpdate[] {
  const updates: BulkObjectUpdate[] = []
  for (const object of objects) {
    if (!object.tagAssignments?.[tagId]) continue
    const draft = tagDraft(object)
    unassignTag(draft, tagId)
    updates.push({ id: object.id, data: draft })
  }
  return updates
}

/**
 * Assign `usages` to every selected shape, through `assignTechnologyUsages` —
 * so ordering, de-duplication and the derived icon behave exactly as they do
 * for a single shape.
 *
 * Every shape gets its OWN usage ids. A usage id names one assignment, and
 * `assertTechnologyUsageIdentityPreserved` exists precisely to stop one being
 * reused for different content; sharing an id across shapes would make two
 * unrelated assignments indistinguishable to anything that keys on it.
 *
 * `mintUsageId` is injected rather than imported so the ids are deterministic
 * under test.
 */
export function planBulkTechnologyAssign(
  objects: readonly C4Object[],
  usages: readonly TechnologyUsage[],
  mintUsageId: () => string,
): BulkObjectUpdate[] {
  if (usages.length === 0) return []
  const updates: BulkObjectUpdate[] = []
  for (const object of objects) {
    const fresh = usages.map((usage) => ({ ...usage, id: mintUsageId() }))
    const next = assignTechnologyUsages(object, fresh)
    // Every incoming technology was already on this shape — nothing to write,
    // and the minted ids are simply discarded.
    if (next.addedCount === 0) continue
    updates.push({
      id: object.id,
      data: {
        technologyUsages: next.technologyUsages,
        technologyUsageOrder: next.technologyUsageOrder,
        ...(next.icon ? { icon: next.icon } : {}),
        ...(next.iconAssignment ? { iconAssignment: next.iconAssignment } : {}),
      },
    })
  }
  return updates
}

/** How many of the selected shapes carry each technology, by technology id. */
export function technologyCoverage(
  objects: readonly C4Object[],
): Map<string, { count: number; name: string }> {
  const counts = new Map<string, { count: number; name: string }>()
  for (const object of objects) {
    const seen = new Set<string>()
    for (const usage of Object.values(object.technologyUsages ?? {})) {
      if (seen.has(usage.technologyId)) continue
      seen.add(usage.technologyId)
      const entry = counts.get(usage.technologyId)
      if (entry) entry.count += 1
      else counts.set(usage.technologyId, { count: 1, name: usage.snapshot.name })
    }
  }
  return counts
}

/**
 * Remove every usage of `technologyId` from every selected shape.
 *
 * Returns the shapes it could NOT do rather than skipping them quietly: a
 * technology that supplies a shape's explicitly chosen icon is refused by
 * `removeTechnologyUsage` unless the caller says otherwise, exactly as in the
 * single-shape flow, and the caller has to ask before overriding.
 *
 * Unlike the assign path, `icon` and `iconAssignment` are written
 * UNCONDITIONALLY. `removeTechnologyUsage` signals "this shape now has no icon"
 * by omitting the key; spreading it conditionally would turn that into "leave
 * the icon alone", and the shape would keep an icon whose technology is gone.
 */
export function planBulkTechnologyRemove(
  objects: readonly C4Object[],
  technologyId: string,
  options: { allowExplicitIconRemoval?: boolean } = {},
): { updates: BulkObjectUpdate[]; blockedIds: string[] } {
  const updates: BulkObjectUpdate[] = []
  const blockedIds: string[] = []
  for (const object of objects) {
    const usageIds = Object.values(object.technologyUsages ?? {})
      .filter((usage) => usage.technologyId === technologyId)
      .map((usage) => usage.id)
    if (usageIds.length === 0) continue

    // A shape can carry the same technology more than once (different roles),
    // so fold the removals rather than taking only the first.
    let state: {
      technologyUsages?: Record<string, TechnologyUsage>
      technologyUsageOrder?: string[]
      icon?: string
      iconAssignment?: C4Object['iconAssignment']
    } = object
    let blocked = false
    for (const usageId of usageIds) {
      const step = removeTechnologyUsage(state, usageId, options)
      if (step.blocked) { blocked = true; break }
      state = step
    }
    if (blocked) { blockedIds.push(object.id); continue }

    updates.push({
      id: object.id,
      data: {
        technologyUsages: state.technologyUsages,
        technologyUsageOrder: state.technologyUsageOrder,
        icon: state.icon,
        iconAssignment: state.iconAssignment,
      },
    })
  }
  return { updates, blockedIds }
}
