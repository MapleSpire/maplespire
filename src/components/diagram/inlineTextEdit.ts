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
import type { C4Object } from '../../types'
import type { ObjectTextBand } from '../../canvas/engine/CanvasEngine'

/**
 * What an inline canvas edit seeds from and what it writes back.
 *
 * Extracted from `CanvasView` because `CanvasView` has no test file and this is
 * the part with rules in it — the same reason `contextMenuTarget.ts` and
 * `copyStyle.ts` exist.
 *
 * ## Why the editor holds a DRAFT instead of writing per keystroke
 *
 * The connection-label editor next to it writes on every keystroke, and that is
 * safe there only by accident of which projection path is active. For objects it
 * is not safe at all off the boot-from-server path:
 *
 *  - the Automerge bridge's local-edit overlay is built by `detectEdits()`,
 *    which has exactly ONE call site and it sits inside
 *    `if (isBootFromServerEnabled())` (in the bridge). With that flag
 *    off there is no overlay, so a projection between keystrokes rewrites the
 *    object from the document — which still holds the pre-edit value;
 *  - the write debounce for ordinary edits is a pure trailing timer with no
 *    maximum wait, so continuous typing postpones the flush indefinitely and
 *    keeps that window open for the whole burst.
 *
 * The result is letters erased while renaming — or the whole edit reverted. A
 * draft buffer is safe under BOTH paths, because the store
 * holds no in-progress value for a projection to clobber.
 *
 * Two consequences fall out of the same choice, both good: Escape can revert
 * (this app has no undo, so the alternative is unrecoverable), and one commit
 * costs one store write instead of one per character — each of which would
 * otherwise re-run the bridge's whole-model edit sweep and rebuild the engine's
 * index maps.
 */

/** Matches the sidebar's compact-summary cap, and the AI write tool's schema. */
export const INLINE_EDIT_MAX_LEN = 120

/**
 * The text the editor opens with.
 *
 * Always the STORE value, never what the canvas painted: the painted title and
 * description are fitted, truncated and may carry a literal '...', which
 * seeding from would save back into the model on the next commit.
 */
export function inlineEditSeed(object: C4Object, band: ObjectTextBand): string {
  return band === 'title' ? object.name : objectShortDescription(object) ?? ''
}

/**
 * The update a commit should write, or `null` when nothing changed.
 *
 * Returning `null` for an unchanged value matters beyond tidiness: every
 * `updateObject` mirrors name and description onto parent-wrapper groups and
 * re-runs the sync bridge's model sweep, so a blur with no edit must not write.
 *
 * A description edit goes through `separateObjectShortDescription`, never
 * `{ description }`. On a migrated object the latter edits the detailed Markdown
 * document, which the canvas does not render — the shape would not change. On a
 * legacy object it leaves the old overloaded value in place, where
 * `objectShortDescription` keeps returning it.
 */
export function planInlineTextEdit(
  object: C4Object,
  band: ObjectTextBand,
  text: string,
): Partial<C4Object> | null {
  const next = text.slice(0, INLINE_EDIT_MAX_LEN)
  if (band === 'title') {
    // A shape with no name at all is unidentifiable on the canvas and in every
    // list; refuse the edit rather than write one.
    if (next.trim().length === 0) return null
    return next === object.name ? null : { name: next }
  }
  if (next === (objectShortDescription(object) ?? '')) return null
  return separateObjectShortDescription(object, next)
}
