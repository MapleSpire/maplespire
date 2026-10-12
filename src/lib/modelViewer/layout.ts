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

import type { C4Object } from '../../types'

/**
 * Model Viewer deterministic grid layout (design kit `mv-grid.jsx`
 * computeLayout): square-ish tiles auto-arranged to fit the viewport area,
 * centered last row, optional boundary chrome reserved when drilled into a
 * parent. Pure world-space math — tile centres drive BOTH the connection
 * routing and the drill-down zoom focal point (2D) / camera target (3D).
 */

export interface ViewerArea {
  x: number
  y: number
  w: number
  h: number
}

export interface ViewerTile {
  id: string
  o: C4Object
  /** World coords inside the content box (before padding/offset/scale). */
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

export interface ViewerLayout {
  tiles: ViewerTile[]
  byId: Map<string, ViewerTile>
  worldW: number
  worldH: number
  scale: number
  /** Screen offset of the full (padded) box. */
  ox: number
  oy: number
  padX: number
  padT: number
  padB: number
  fullW: number
  fullH: number
  hasBoundary: boolean
  parentId: string | null
}

export interface ViewerLayoutOpts {
  density: 'comfortable' | 'compact'
}

export function computeViewerLayout(
  kids: C4Object[],
  parentId: string | null,
  area: ViewerArea,
  opts: ViewerLayoutOpts
): ViewerLayout {
  const n = kids.length || 1
  const compact = opts.density === 'compact'
  const tw = compact ? 142 : 170
  const th = compact ? 126 : 150
  const gap = compact ? 22 : 30
  // Boundary "group" chrome — reserved only when drilled inside a parent.
  const hasBoundary = parentId !== null
  const padX = hasBoundary ? (compact ? 32 : 44) : 0
  const padB = hasBoundary ? (compact ? 28 : 36) : 0
  const padT = hasBoundary ? (compact ? 108 : 134) : 0
  const aspect = area.w / Math.max(1, area.h)
  let cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * aspect * 0.62))))
  let rows = Math.ceil(n / cols)
  // avoid a very tall skinny grid
  while (rows > cols + 1 && cols < n) {
    cols += 1
    rows = Math.ceil(n / cols)
  }
  const worldW = cols * tw + (cols - 1) * gap
  const worldH = rows * th + (rows - 1) * gap
  const fullW = worldW + padX * 2
  const fullH = worldH + padT + padB
  const scale = Math.min(1.12, area.w / fullW, area.h / fullH)
  const ox = area.x + (area.w - fullW * scale) / 2
  const oy = area.y + (area.h - fullH * scale) / 2
  const lastRow = n - (rows - 1) * cols
  const tiles = kids.map((o, i) => {
    const row = Math.floor(i / cols)
    const col = i % cols
    const rowN = row === rows - 1 ? lastRow : cols
    const inset = ((cols - rowN) * (tw + gap)) / 2
    const x = col * (tw + gap) + inset
    const y = row * (th + gap)
    return { id: o.id, o, x, y, w: tw, h: th, cx: x + tw / 2, cy: y + th / 2 }
  })
  const byId = new Map<string, ViewerTile>()
  for (const t of tiles) byId.set(t.id, t)
  return { tiles, byId, worldW, worldH, scale, ox, oy, padX, padT, padB, fullW, fullH, hasBoundary, parentId }
}

/** A tile's centre in SCREEN coords (the zoom focal point / camera target). */
export function tileFocal(layout: ViewerLayout, id: string): { x: number; y: number } | null {
  const t = layout.byId.get(id)
  if (!t) return null
  return {
    x: layout.ox + (layout.padX + t.cx) * layout.scale,
    y: layout.oy + (layout.padT + t.cy) * layout.scale,
  }
}
