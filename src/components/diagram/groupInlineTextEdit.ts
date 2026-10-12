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

import { objectShortDescription, separateObjectShortDescription } from '../../lib/objectDescription'
import { INLINE_EDIT_MAX_LEN } from './inlineTextEdit'
import type { ObjectTextBand } from '../../canvas/engine/CanvasEngine'
import type { C4Object, Group } from '../../types'

/**
 * What an inline edit of a GROUP's text seeds from and writes back.
 *
 * The draft-and-commit reasoning is identical to `inlineTextEdit.ts` (a group
 * rename losing characters is exactly the failure it prevents). What is
 * different, and what this module exists for, is WHERE the write lands.
 *
 * ## A parent wrapper's title is a mirror, not a source
 *
 * A group with a `parentObjectId` is the expanded form of an object, and the
 * store keeps its name / description / icon in step with that object: every
 * `updateObject` copies them onto the wrapper (`groupsToSync` in
 * `modelStore.ts`). Writing an edited wrapper title back to the GROUP therefore
 * survives only until the next edit of the object, then silently reverts — the
 * user would see their rename undo itself minutes later with no action of their
 * own. So a wrapper's edits are routed to the object, and the mirror carries
 * them back.
 *
 * The wrapper's `type` line is deliberately not editable: it holds a C4 type,
 * not free text, and a textarea over it would invite a value the model cannot
 * represent.
 */

export type GroupInlineEditWrite =
  | { target: 'group'; id: string; update: Partial<Group> }
  | { target: 'object'; id: string; update: Partial<C4Object> }

/**
 * What the editor is sitting on. A wrapper carries its parent object, because
 * that is where a wrapper's edits have to land.
 */
export type InlineEditSubject =
  | { kind: 'object'; object: C4Object }
  | { kind: 'group'; group: Group; parentObject?: C4Object }

/** True when this group is an object's expanded wrapper rather than a real group. */
export function isMirrorOfObject(group: Group): boolean {
  return !!group.parentObjectId
}

/**
 * Turn "the user double-clicked this id" into something the editor can both
 * display and commit — or null, meaning do not open an editor at all.
 *
 * This exists as a function because it is where the feature's worst bug lived,
 * and the bug was invisible from inside `planGroupInlineTextEdit`: that function
 * correctly refuses a wrapper edit when it has no parent object in hand, and a
 * unit test happily pinned the refusal as intended behaviour. What no unit could
 * see is that the CALLER could never supply one.
 *
 * The two lookups are deliberately different scopes, and that is the whole rule:
 *
 *  - `diagramObject` / `diagramGroup` are the CURRENT DIAGRAM's composition,
 *    matching what the engine drew. An entity that left this diagram mid-edit
 *    has no painted rect for the overlay to track, so the editor must close
 *    rather than hover over unrelated canvas.
 *  - `modelObject` is MODEL-WIDE, and has to be. A wrapper's parent object is by
 *    construction never in its own child diagram — `ExpandMenu` creates that
 *    diagram with `objectIds: []` and attaches only the wrapper — so a
 *    diagram-scoped lookup always misses, and every wrapper edit is discarded in
 *    silence: the editor opens, seeds correctly from the mirror, accepts typing
 *    and drops it on Enter.
 */
export function resolveInlineEditSubject(
  target: { kind: 'object' | 'group'; id: string },
  lookups: {
    diagramObject: (id: string) => C4Object | undefined
    diagramGroup: (id: string) => Group | undefined
    modelObject: (id: string) => C4Object | undefined
  },
): InlineEditSubject | null {
  if (target.kind === 'object') {
    const object = lookups.diagramObject(target.id)
    return object ? { kind: 'object', object } : null
  }
  const group = lookups.diagramGroup(target.id)
  if (!group) return null
  if (!isMirrorOfObject(group)) return { kind: 'group', group }
  const parentObject = lookups.modelObject(group.parentObjectId!)
  // Nothing durable to write to — do not open an editor that cannot commit.
  return parentObject ? { kind: 'group', group, parentObject } : null
}

/**
 * The text the editor opens with — always the STORE value.
 *
 * Never what the canvas painted: a wrapper header is fitted and ellipsized, so
 * seeding from the painted run would save a literal '...' into the model.
 */
export function groupInlineEditSeed(
  group: Group,
  parentObject: C4Object | undefined,
  band: ObjectTextBand,
): string {
  if (isMirrorOfObject(group) && parentObject) {
    return band === 'title' ? parentObject.name : objectShortDescription(parentObject) ?? ''
  }
  return band === 'title' ? group.name : group.description ?? ''
}

/**
 * The write a commit should make, or `null` when nothing changed.
 *
 * Returning `null` for an unchanged value is not tidiness: a group write
 * re-runs the sync bridge's model sweep and rebuilds the engine's index maps, so
 * a blur with no edit must not write.
 */
export function planGroupInlineTextEdit(
  group: Group,
  parentObject: C4Object | undefined,
  band: ObjectTextBand,
  text: string,
): GroupInlineEditWrite | null {
  const next = text.slice(0, INLINE_EDIT_MAX_LEN)

  if (isMirrorOfObject(group)) {
    // No parent object in hand means we cannot write where the value actually
    // lives, and writing to the mirror instead would revert. Refuse.
    if (!parentObject) return null
    if (band === 'title') {
      if (next.trim().length === 0) return null
      return next === parentObject.name
        ? null
        : { target: 'object', id: parentObject.id, update: { name: next } }
    }
    if (next === (objectShortDescription(parentObject) ?? '')) return null
    return {
      target: 'object',
      id: parentObject.id,
      update: separateObjectShortDescription(parentObject, next),
    }
  }

  if (band === 'title') {
    // A nameless group is unidentifiable on the canvas and in every list;
    // refuse the edit rather than write one. Same rule as a shape's title.
    if (next.trim().length === 0) return null
    return next === group.name ? null : { target: 'group', id: group.id, update: { name: next } }
  }

  // A standard group paints no description, so the canvas offers no band to
  // reach this. Kept total rather than throwing: a future renderer that paints
  // one gets the obvious behaviour instead of a crash.
  if (next === (group.description ?? '')) return null
  return { target: 'group', id: group.id, update: { description: next } }
}
