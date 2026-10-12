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

export interface WorldEditRect {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  lineHeight: number
}

export interface ScreenEditRect {
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  lineHeight: number
}

/**
 * Project a world-space text rect into the screen box the textarea occupies.
 *
 * Kept pure and separate so it can be re-run cheaply on every frame while an
 * editor is open. The existing connection-label editor projects ONCE at open
 * time and never again, so it detaches from its line on any pan or zoom — and
 * a wheel zoom moves no focus, so nothing closes the editor to hide it.
 *
 * Note the line-height derivation. The connection editor clamps `fontSize` to a
 * readable floor of 11 but leaves its line height at `12 * scale`, so below
 * roughly 0.92 zoom it renders 11px glyphs inside a smaller line box and the
 * text clips. Fit-to-screen routinely lands at 0.3–0.6. Derive the line height
 * from the CLAMPED font size, not from the raw scale.
 */
export function projectInlineEditRect(
  world: WorldEditRect,
  viewport: { x: number; y: number; scale: number },
): ScreenEditRect {
  const fontSize = Math.max(world.fontSize * viewport.scale, 11)
  const lineHeight = fontSize * 1.15
  return {
    left: world.x * viewport.scale + viewport.x,
    top: world.y * viewport.scale + viewport.y,
    width: Math.max(world.width * viewport.scale, 80),
    // The painted text's height is the height of the GLYPHS. The editor is a
    // border-box element, so its border and padding eat into that, and a height
    // set from the glyphs alone leaves a content box shorter than one line —
    // which clips the descenders and, at small sizes, the caret itself.
    // CHROME_HEIGHT is that allowance; the editor then auto-grows past it for
    // wrapped text.
    height: Math.max(world.height * viewport.scale, lineHeight) + CHROME_HEIGHT,
    fontSize,
    lineHeight,
  }
}

/** Vertical border + padding of the editor, in CSS px. Keep in sync with the
 *  `border` and `py-*` classes on the textarea. */
export const CHROME_HEIGHT = 6
