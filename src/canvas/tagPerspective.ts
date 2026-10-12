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

import type { Connection, Tag, TagAssignment } from '../types'
import { orderedTagIds } from '../lib/tags/assignments'

type TagAssignable = {
  tagAssignments?: Record<string, TagAssignment>
  tagOrder?: string[]
}

export interface PinnedTagPresentation {
  outline: Tag | null
  labels: Tag[]
  overflowCount: number
}

/**
 * Multiple pins keep their functional assignment order for labels, while the
 * most recently pinned matching Tag owns the dotted outline.
 */
export function resolvePinnedTagPresentation(
  entity: TagAssignable,
  tags: readonly Tag[],
  pinnedTagIds: readonly string[],
  maxLabels = 3,
): PinnedTagPresentation {
  const byId = new Map(tags.map((tag) => [tag.tagId, tag]))
  const pinned = new Set(pinnedTagIds)
  const matching = orderedTagIds(entity)
    .filter((tagId) => pinned.has(tagId))
    .map((tagId) => byId.get(tagId))
    .filter((tag): tag is Tag => Boolean(tag))
  let outline: Tag | null = null
  for (let index = pinnedTagIds.length - 1; index >= 0; index -= 1) {
    const tagId = pinnedTagIds[index]
    if (!entity.tagAssignments?.[tagId]) continue
    outline = byId.get(tagId) ?? null
    if (outline) break
  }
  return {
    outline,
    labels: matching.slice(0, maxLabels),
    overflowCount: Math.max(0, matching.length - maxLabels),
  }
}

export interface HiddenTagState {
  hidden: boolean
  temporarilyRevealed: boolean
}

export interface TagFocusMembership {
  /** false when the focused stable id is absent from the local Tag snapshot. */
  resolved: boolean
  matchingObjectIds: ReadonlySet<string>
  connectedObjectIds: ReadonlySet<string>
}

/**
 * Resolve the focus subgraph in one O(objects + connections) pass. Only object
 * endpoints participate: group endpoints are intentionally not expanded into
 * every group member, matching the editor's existing focus contract.
 */
export function resolveTagFocusMembership(
  objects: readonly (TagAssignable & { id: string })[],
  connections: readonly Pick<Connection, 'fromId' | 'toId'>[],
  tags: readonly Tag[],
  focusedTagId: string | null,
): TagFocusMembership {
  const matchingObjectIds = new Set<string>()
  const connectedObjectIds = new Set<string>()
  if (!focusedTagId) return { resolved: true, matchingObjectIds, connectedObjectIds }
  const tag = tags.find((candidate) => candidate.tagId === focusedTagId)
  if (!tag) return { resolved: false, matchingObjectIds, connectedObjectIds }

  const objectIds = new Set(objects.map((object) => object.id))
  for (const object of objects) {
    if (object.tagAssignments?.[tag.tagId]) matchingObjectIds.add(object.id)
  }
  for (const connection of connections) {
    if (matchingObjectIds.has(connection.fromId) && objectIds.has(connection.toId)) {
      connectedObjectIds.add(connection.toId)
    }
    if (matchingObjectIds.has(connection.toId) && objectIds.has(connection.fromId)) {
      connectedObjectIds.add(connection.fromId)
    }
  }
  return { resolved: true, matchingObjectIds, connectedObjectIds }
}

/** Hovering a hidden Tag reveals only entities carrying that exact Tag. */
export function resolveHiddenTagState(
  entity: TagAssignable,
  hiddenTagIds: ReadonlySet<string>,
  hoveredTagId: string | null,
): HiddenTagState {
  const temporarilyRevealed = Boolean(
    hoveredTagId
      && hiddenTagIds.has(hoveredTagId)
      && entity.tagAssignments?.[hoveredTagId],
  )
  if (temporarilyRevealed) return { hidden: false, temporarilyRevealed: true }
  return {
    hidden: Object.keys(entity.tagAssignments ?? {}).some((tagId) => hiddenTagIds.has(tagId)),
    temporarilyRevealed: false,
  }
}

/**
 * Connections keep their normal skin color until the user explicitly hovers
 * or focuses a Tag carried by either endpoint. Pins decorate shapes only and
 * selecting the Tags perspective or one of its Groups never recolors lines.
 */
export function resolveConnectionPerspectiveTag(
  from: TagAssignable | undefined,
  to: TagAssignable | undefined,
  tags: readonly Tag[],
  activeTagGroupId: string | null,
  interactions: {
    hoveredTagId: string | null
    focusedTagId: string | null
    pinnedTagIds: readonly string[]
  },
  connection: TagAssignable = {},
): Tag | null {
  const byId = new Map(tags.map((tag) => [tag.tagId, tag]))
  const relationshipCarries = (tagId: string) => Boolean(
    connection.tagAssignments?.[tagId]
      || from?.tagAssignments?.[tagId]
      || to?.tagAssignments?.[tagId],
  )
  const eligible = (tagId: string | null): Tag | null => {
    if (!tagId || !relationshipCarries(tagId)) return null
    const tag = byId.get(tagId)
    if (!tag || (activeTagGroupId && tag.groupId !== activeTagGroupId)) return null
    return tag
  }
  const hovered = eligible(interactions.hoveredTagId)
  if (hovered) return hovered
  return eligible(interactions.focusedTagId)
}
