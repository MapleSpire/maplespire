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

export interface IconRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where an icon image of natural size `naturalWidth × naturalHeight` is drawn
 * inside the square box at (`x`, `y`) of side `size`: aspect-fit ("contain"),
 * centred — the canvas twin of the DOM's `object-contain`. Catalog artwork is
 * 128×128, but a governed technology's uploaded logo can be any shape, and
 * `drawImage(img, x, y, size, size)` squashed a wide one into a grey line
 * (defect 2026-10-18). A degenerate size falls back to the whole box.
 */
export function containIconRect(
  naturalWidth: number,
  naturalHeight: number,
  x: number,
  y: number,
  size: number,
): IconRect {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return { x, y, width: size, height: size }
  const scale = size / Math.max(naturalWidth, naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return { x: x + (size - width) / 2, y: y + (size - height) / 2, width, height }
}
