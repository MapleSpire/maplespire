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

/**
 * Bottom accent-bar colors ("color by" — the BottomBar's Tags / Technology /
 * Status tabs). Extracted from CanvasEngine so the 2D canvas and the 3D board
 * resolve the SAME colors for the same object — the bar semantics live here,
 * each view only decides how to draw the segments.
 */

import type { C4Object, Tag } from '../types'
import type { SkinConfig } from '../skins/types'
import { orderedTechnologyUsages } from '../lib/technologyUsage'
import { orderedTagIds } from '../lib/tags/assignments'
import { orderedOwnerAssignments } from '../lib/owners'

export type BottomBarTab = 'tags' | 'technology' | 'status' | 'teams' | null

const TEAM_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#D97706', '#059669', '#0891B2', '#4F46E5']

/** Stable color for an organization team ID, including while offline when the
 * central team display record is unavailable. */
export function resolveTeamColor(teamId: string): string {
  let hash = 2166136261
  for (let i = 0; i < teamId.length; i++) {
    hash ^= teamId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return TEAM_COLORS[(hash >>> 0) % TEAM_COLORS.length]
}

/** Brand accents for well-known technologies a skin doesn't map itself. */
export const FALLBACK_TECH_COLORS: Record<string, string> = {
  'React': '#61DAFB',
  'Node.js': '#339933',
  'Socket.io': '#010101',
  'Firebase Auth': '#FFCA28',
  'S3': '#FF9900',
  'PostgreSQL': '#336791',
  'Redis': '#DC382D',
  'Pub/Sub': '#4285F4',
  'Go': '#00ADD8',
  'Cloud Scheduler': '#4285F4',
}

export function resolveTechnologyColor(name: string, skin: SkinConfig): string {
  return skin.bottomBar.technology[name] ?? FALLBACK_TECH_COLORS[name] ?? resolveStableFacetColor(name)
}

export function resolveStatusColor(status: C4Object['status'], skin: SkinConfig): string {
  return skin.bottomBar.status[status]
}

const GENERIC_FACET_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#D97706', '#059669', '#0891B2']

function resolveStableFacetColor(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return GENERIC_FACET_COLORS[(hash >>> 0) % GENERIC_FACET_COLORS.length]
}

/** A tag's bar color: the tag's own color, or the skin's themed palette cycled
 * by registry order (`bottomBar.tagColorMode`). Null when the name is unknown. */
export function resolveTagColor(tagId: string, tags: Tag[], skin: SkinConfig): string | null {
  const idx = tags.findIndex((t) => t.tagId === tagId)
  if (idx < 0) return null
  if (skin.bottomBar.tagColorMode === 'original') return tags[idx].color
  const palette = skin.bottomBar.tagColors
  if (palette.length === 0) return tags[idx].color
  return palette[idx % palette.length]
}

/** The object's bar segments for the active tab (empty → no bar). */
export function resolveObjectBottomBarColors(
  obj: C4Object,
  tags: Tag[],
  skin: SkinConfig,
  bottomTab: BottomBarTab,
  activeTagGroupId: string | null = null,
): string[] {
  const bb = skin.bottomBar
  if (bottomTab === 'tags') {
    const colors: string[] = []
    for (const tagId of orderedTagIds(obj)) {
      const tag = tags.find((entry) => entry.tagId === tagId)
      if (activeTagGroupId && tag?.groupId !== activeTagGroupId) continue
      const color = resolveTagColor(tagId, tags, skin)
      if (color) colors.push(color)
    }
    return colors
  } else if (bottomTab === 'technology') {
    const firstTech = orderedTechnologyUsages(obj.technologyUsages, obj.technologyUsageOrder)[0]?.snapshot.name
    return firstTech ? [resolveTechnologyColor(firstTech, skin)] : []
  } else if (bottomTab === 'status') {
    if (obj.status === 'live') return [bb.status.live]
    if (obj.status === 'draft') return [bb.status.draft]
    if (obj.status === 'down') return [bb.status.down]
    if (obj.status === 'unstable') return [bb.status.unstable]
    return []
  } else if (bottomTab === 'teams') {
    return [...new Set([
      ...orderedOwnerAssignments(obj).map((owner) => owner.id),
      ...(obj.teamIds ?? []),
    ])].map(resolveTeamColor)
  }
  return []
}

/** A group's bar segments — the DEDUPED tag colors of its members, in member
 * order (tags mode only; the other tabs draw nothing on groups). */
export function resolveGroupBottomBarColors(
  groupObjects: C4Object[],
  tags: Tag[],
  skin: SkinConfig,
  bottomTab: BottomBarTab,
  activeTagGroupId: string | null = null,
): string[] {
  if (bottomTab === 'teams') {
    return [...new Set(groupObjects.flatMap((object) => [
      ...orderedOwnerAssignments(object).map((owner) => owner.id),
      ...(object.teamIds ?? []),
    ]))].map(resolveTeamColor)
  }
  if (bottomTab !== 'tags') return []
  const colorSet = new Set<string>()
  const colors: string[] = []
  for (const obj of groupObjects) {
    for (const tagId of orderedTagIds(obj)) {
      const tag = tags.find((entry) => entry.tagId === tagId)
      if (activeTagGroupId && tag?.groupId !== activeTagGroupId) continue
      const color = resolveTagColor(tagId, tags, skin)
      if (color && !colorSet.has(color)) {
        colorSet.add(color)
        colors.push(color)
      }
    }
  }
  return colors
}
