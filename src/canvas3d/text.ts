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
 * GPU SDF text for the 3D board (troika-three-text) — vector-crisp under any
 * camera pose, using the design system's own faces (Inter + JetBrains Mono,
 * bundled statics; weight = font file, so glyphs match the app chrome).
 */

import { Text, preloadFont } from 'troika-three-text'
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff'
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff'
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff'
import mono600 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff'

export type FontId = 'inter400' | 'inter500' | 'inter600' | 'mono600'

const FONT_URLS: Record<FontId, string> = {
  inter400: inter400,
  inter500: inter500,
  inter600: inter600,
  mono600: mono600,
}

/** Kick the SDF atlases early so the first 3D frame has text. */
export function preloadFonts(onReady?: () => void): void {
  let remaining = Object.keys(FONT_URLS).length
  for (const url of Object.values(FONT_URLS)) {
    preloadFont({ font: url }, () => {
      remaining -= 1
      if (remaining === 0) onReady?.()
    })
  }
}

export interface TextSpec {
  text: string
  font: FontId
  size: number
  color: string
  anchorX?: number | string
  anchorY?: number | string
  maxWidth?: number
  letterSpacing?: number
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
  /** Clip to [minX, minY, maxX, maxY] in local text space (truncation). */
  clipRect?: [number, number, number, number]
}

/** Create a troika Text lying FLAT on the board (readable from the front),
 * positioned by its local origin; caller sets mesh.position. `onSynced` fires
 * when glyphs are ready (request a render). */
export function makeText(spec: TextSpec, onSynced: () => void): Text {
  const t = new Text()
  t.text = spec.text
  t.font = FONT_URLS[spec.font]
  t.fontSize = spec.size
  // read back by the __scene3d.nodeFaces probe (the shape-typography
  // regression gate, 2026-10-10)
  t.userData.fontId = spec.font
  t.color = spec.color
  t.anchorX = spec.anchorX ?? 'left'
  t.anchorY = spec.anchorY ?? 'top'
  if (spec.maxWidth !== undefined) t.maxWidth = spec.maxWidth
  if (spec.letterSpacing !== undefined) t.letterSpacing = spec.letterSpacing
  if (spec.lineHeight !== undefined) t.lineHeight = spec.lineHeight
  if (spec.align) t.textAlign = spec.align
  if (spec.clipRect) t.clipRect = spec.clipRect
  t.whiteSpace = 'nowrap'
  // Text planes lie a hair above their card face; bias the depth test so they
  // never z-fight with the fill under them.
  t.depthOffset = -2
  // Lay the text flat on the board: local XY → world XZ, +y(local) → −z (north).
  t.rotation.x = -Math.PI / 2
  // Ink stays ink: text is never tone-mapped. A no-op under the unlit
  // profile (NoToneMapping); under a lit theme's ACES pass this keeps the
  // SDF glyphs hex-stable and crisp instead of filmic-shifted.
  ;(t.material as { toneMapped?: boolean }).toneMapped = false
  // Glyphs are DECALS: they depth-TEST against the scene but must never
  // WRITE depth — the lit profile's half-res AO pass reads the depth buffer
  // and turns depth-written glyph quads into offset ghost outlines around
  // every letter (worst when zoomed out). No-op for layering:
  // nothing legitimately draws between a surface and its own text.
  ;(t.material as { depthWrite?: boolean }).depthWrite = false
  t.sync(onSynced)
  return t
}

/** Multiline variant (description-style): wraps at maxWidth. */
export function makeWrappedText(spec: TextSpec & { maxWidth: number }, onSynced: () => void): Text {
  const t = makeText(spec, onSynced)
  t.whiteSpace = 'normal'
  t.overflowWrap = 'break-word'
  return t
}
