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
 * The geometry of a parent-wrapper box (a group with `parentObjectId`, drawn as
 * an expanded shape), with no canvas behind it.
 *
 * It lives here rather than in `CanvasEngine` because something other than the
 * engine has to predict that box: the inline-expansion planner
 * (`src/lib/diagrams/expandInline.ts`) makes room for a wrapper BEFORE the
 * engine has drawn it, so the two must agree on every pixel of padding. One
 * definition, imported by both, is what keeps them agreeing.
 *
 * Only the minimum header WIDTH needs a canvas (it measures text); the engine
 * exposes that as `inlineWrapperMinWidth`, and `PARENT_WRAPPER_MAX_MIN_WIDTH`
 * is its upper bound for a caller that has no engine.
 */

/** Left and right padding between the members and the box. */
export const PARENT_WRAPPER_SIDE_PAD = 30
/** Padding between the lowest member and the box's bottom edge. */
export const GROUP_FOOTER_PAD = 28
/** Floor of the header band (parity with the legacy top reservation). */
export const MIN_HEADER_BAND = 46
export const HDR_TOP_INSET = 24     // stack top; clears the y ≤ 22 corner hit band
export const HDR_BOTTOM_INSET = 12  // gap between the stack and the first member
export const HDR_PAD_X = 16         // horizontal inset for centered text (each side)
export const HDR_ICON = 20          // icon block height (renderTechnologyIcon draws 20px)
export const HDR_GAP_ICON = 8       // gap below the icon
export const HDR_GAP_TYPE = 4       // gap above the type line
export const HDR_GAP_DESC = 6       // gap above the description line
export const HDR_TITLE_BASE = 14
export const HDR_TYPE = 10
export const HDR_DESC_BASE = 12
export const HDR_MAX_TEXT_W = 360   // cap on text-driven box growth; longer text shrinks/truncates

/**
 * The most `measureGroupHeaderMinWidth` can return: the capped text plus its
 * insets. (Its other floor, the corner affordances, is at most 28 + 58 + 16.)
 */
export const PARENT_WRAPPER_MAX_MIN_WIDTH = HDR_MAX_TEXT_W + HDR_PAD_X * 2

/** Height of the reserved top band for a parent-wrapper's centered header, sized
 *  to the present elements at base font (the tallest they get — the fitted stack
 *  only ever shrinks). Reserving exactly this guarantees the rendered stack never
 *  overlaps the members. No text measurement — presence + base line heights
 *  only — so it's cheap and identical between bounds and render. */
export function parentWrapperHeaderBand(
  group: Pick<Group, 'icon' | 'name' | 'type' | 'description'>,
): number {
  let stack = 0
  if (group.icon) stack += HDR_ICON + HDR_GAP_ICON
  if (group.name?.trim()) stack += Math.round(HDR_TITLE_BASE * 1.25)
  if (group.type?.trim()) stack += HDR_GAP_TYPE + Math.round(HDR_TYPE * 1.3)
  if (group.description?.trim()) stack += HDR_GAP_DESC + Math.round(HDR_DESC_BASE * 1.3)
  if (stack === 0) return MIN_HEADER_BAND
  return Math.max(MIN_HEADER_BAND, HDR_TOP_INSET + stack + HDR_BOTTOM_INSET)
}

export interface Box { x: number; y: number; width: number; height: number }

/**
 * The box a parent wrapper draws around `contents` (its member shapes and any
 * wrapper nested inside it): side padding, the header band on top, the footer
 * below, widened symmetrically to `minWidth` when the contents are narrower.
 * `null` with no contents — a wrapper with nothing in it has no box.
 */
export function parentWrapperBox(
  contents: readonly Box[],
  bandHeight: number,
  minWidth: number,
): Box | null {
  if (contents.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const box of contents) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  let x = minX - PARENT_WRAPPER_SIDE_PAD
  let width = maxX - minX + PARENT_WRAPPER_SIDE_PAD * 2
  if (minWidth > width) {
    x -= (minWidth - width) / 2
    width = minWidth
  }
  return { x, y: minY - bandHeight, width, height: maxY - minY + bandHeight + GROUP_FOOTER_PAD }
}
