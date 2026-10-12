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

import { defineTheme } from '../sdk/contract'
import { studioSkin } from '../../skins/studioSkin'
import { studioSkinDark } from '../../skins/studioSkinDark'
import { buildRoundRectPath, buildCylinderPath, strokeStoreLid, storeCapRy, lightenHex } from '../../canvas/engine/objectBox'

/**
 * Official "Studio" theme — the design system palette on the canvas. It uses the
 * engine's standard node layout (icon on top, title + description centred below,
 * like Default / Slate); only the SELECTION treatment is customised here, since a
 * SkinConfig can't express it.
 *
 * The engine default selects with a 2px stroke centred on the edge (1px spills
 * OUTward) plus a blurred shadow glow. The design system instead specifies a 2px
 * accent border absorbed INward (footprint + inner content never shift) PLUS a
 * crisp `0 0 0 4px` accent@15% ring over the resting `--shadow-lg` — mirrored
 * in-app on the Dependencies cards. The `object` seam is the only one that owns
 * object selection, so the whole box is drawn here (`mode: 'replace'`); the
 * NON-selected path is byte-identical to the engine default (fill + the state
 * stroke / dash the engine already resolved onto the ctx). The engine still draws
 * the icon / title / description on top afterwards, unchanged.
 */

// Relative luminance of a #RRGGBB colour → treat as a dark card below mid-grey.
// Picks the light vs dark skin for values not carried in ObjectArgs (the store lid
// seam colour and the selected drop shadow).
function isDarkHex(hex: string): boolean {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

// #RRGGBB → rgba(r,g,b,a). Anything already non-hex passes straight through.
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

const RING = 4 // DS focus ring width: box-shadow 0 0 0 4px
const RING_ALPHA = 0.15 // accent @ 15%

export const studioTheme = defineTheme({
  meta: { id: studioSkin.id, name: studioSkin.name, version: '1.0.0', trust: 'official', mode: 'default' },
  style: { renderStyle: studioSkin.renderStyle },

  object: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { geom, fill, type, state } = args
      const { x, y, w, h, cornerRadius: r } = geom
      const isStore = type === 'store'
      const cap = isStore ? storeCapRy(w, h) : 0
      // The resolved variant — the store lid seam colour and the selected drop
      // shadow aren't in ObjectArgs, so read them off our own skin (like cyberpunk).
      const skin = isDarkHex(fill) ? studioSkinDark : studioSkin
      const os = skin.objects[type]

      // One path builder for both silhouettes; optional outward offset for the ring.
      const box = (o = 0) =>
        isStore
          ? buildCylinderPath(cd, x - o, y - o, w + o * 2, h + o * 2, cap)
          : buildRoundRectPath(cd, x - o, y - o, w + o * 2, h + o * 2, r + o)

      if (!state.selected) {
        // Resting / hover / connected — mirror the engine default box exactly: the
        // engine already set fill's drop shadow and the border stroke / width / dash.
        box()
        cd.fillStyle = fill
        cd.fill()
        cd.stroke()
        if (isStore) {
          cd.shadowColor = 'transparent'
          cd.strokeStyle = state.external ? os.cylinderLineExternal : os.cylinderLine
          cd.lineWidth = 1
          strokeStoreLid(cd, x, y, w, cap, state.external ? undefined : lightenHex(os.fill, 0.25))
        }
        return
      }

      // SELECTED — the DS focus treatment.
      const accent = os.strokeSelected
      cd.setLineDash([]) // a selected component drops its dashed border (matches engine)

      // 1) Card + resting --shadow-lg drop (not the engine's blurred selection glow).
      cd.shadowColor = os.shadowColor
      cd.shadowBlur = os.shadowBlur
      cd.shadowOffsetX = 0
      cd.shadowOffsetY = os.shadowOffsetY
      box()
      cd.fillStyle = fill
      cd.fill()
      cd.shadowColor = 'transparent'

      // 2) Crisp 4px ring hugging the OUTSIDE of the edge, accent @ 15%. Stroking a
      //    path offset out by RING/2 with lineWidth RING lays a band spanning
      //    [edge, edge+4px] — the DS `0 0 0 4px` spread, corners at radius r+4.
      cd.strokeStyle = withAlpha(accent, RING_ALPHA)
      cd.lineWidth = RING
      box(RING / 2)
      cd.stroke()

      // 3) 2px accent border absorbed INward — footprint unchanged. Stroking a path
      //    inset 1px with lineWidth 2 sits the border in the outer 2px of the box
      //    (outer edge flush with the node edge), instead of spilling outward.
      cd.strokeStyle = accent
      cd.lineWidth = 2
      if (isStore) {
        box() // a drum's border reads best on its own silhouette, not inset
      } else {
        buildRoundRectPath(cd, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1))
      }
      cd.stroke()

      // 4) Store lid seam on top (store only).
      if (isStore) {
        cd.strokeStyle = state.external ? os.cylinderLineExternal : os.cylinderLine
        cd.lineWidth = 1
        strokeStoreLid(cd, x, y, w, cap, state.external ? undefined : lightenHex(os.fill, 0.25))
      }
    },
  },
})
