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

import type { IconAssignmentView, TechnologyBearingView, TechnologyUsageView } from './shapes.js'

/**
 * Server mirror of the shape-icon rules in src/lib/technologyUsage.ts
 * (`technologyIconAssignment`, `assignTechnologyUsage`, `removeTechnologyUsage`).
 * The server does not import client code, so the AI catalog tools apply the
 * same rules here; technologyIcon.test.ts pins them on the stored document.
 */

export type IconState = Pick<TechnologyBearingView, 'icon' | 'iconAssignment'>

export function technologyIconAssignment(
  usage: TechnologyUsageView,
  mode: IconAssignmentView['mode'],
): IconAssignmentView {
  return {
    source: 'technology',
    mode,
    displayName: usage.snapshot.name,
    technologyUsageId: usage.id,
    catalogRevision: usage.catalogRevision,
    ...(usage.snapshot.iconLightPath ? { iconLightPath: usage.snapshot.iconLightPath } : {}),
    ...(usage.snapshot.iconDarkPath ? { iconDarkPath: usage.snapshot.iconDarkPath } : {}),
  }
}

function boundTo(assignment: IconAssignmentView | undefined, usageId: string): assignment is IconAssignmentView {
  return assignment?.source === 'technology' && assignment.technologyUsageId === usageId
}

/** The icon after `usage` was written. A shape with neither an icon nor an
 * assignment takes an AUTOMATIC one from it. An assignment already bound to
 * this usage id is rebuilt in its own mode, because assign_technology rewrites
 * a re-assigned usage from the current catalog revision and the assignment
 * must not keep the previous revision's artwork. */
export function iconAfterAssign(state: IconState, usage: TechnologyUsageView): IconState {
  if (boundTo(state.iconAssignment, usage.id)) {
    return { icon: usage.snapshot.name, iconAssignment: technologyIconAssignment(usage, state.iconAssignment.mode) }
  }
  if (!state.icon && !state.iconAssignment) {
    return { icon: usage.snapshot.name, iconAssignment: technologyIconAssignment(usage, 'automatic') }
  }
  return state
}

/** The icon after `usageId` was removed. An automatic assignment bound to it
 * moves to the first remaining usage in `remainingOrder`; an explicit one (or
 * an automatic one with nothing left) is cleared together with `icon`. AI
 * removal is a confirmed removal, so the editor's explicit-icon block does not
 * apply. */
export function iconAfterRemove(
  state: IconState,
  usageId: string,
  remaining: Record<string, TechnologyUsageView>,
  remainingOrder: readonly string[],
): IconState {
  if (!boundTo(state.iconAssignment, usageId)) return state
  const fallback = state.iconAssignment.mode === 'automatic' ? remaining[remainingOrder[0]] : undefined
  if (fallback) return { icon: fallback.snapshot.name, iconAssignment: technologyIconAssignment(fallback, 'automatic') }
  return {}
}

/** Replace an entity's icon fields with `next`, OMITTING absent ones: the
 * write path stores the whole entity value and Automerge rejects undefined. */
export function withIconState<T extends IconState>(entity: T, next: IconState): T {
  const { icon: _icon, iconAssignment: _assignment, ...rest } = entity
  return {
    ...rest,
    ...(next.icon ? { icon: next.icon } : {}),
    ...(next.iconAssignment ? { iconAssignment: next.iconAssignment } : {}),
  } as T
}
