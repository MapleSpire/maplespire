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
import { c4Skin } from '../../skins/c4Skin'
import { buildRoundRectPath, buildCylinderPath, strokeStoreLid, storeCapRy } from '../../canvas/engine/objectBox'
import {
  offsetPerson,
  personGeometry,
  personNeckArc,
  personNeckSeamOpacity,
  tracePersonOutline,
  type PersonGeometry,
} from '../../canvas/personShape'

/**
 * Official "C4 Model" theme — the C4 notation colours (see `c4Skin.ts`) with
 * the element faces drawn here, because a SkinConfig cannot express them:
 *
 *  - every element is filled with a top-lit vertical gradient of its own C4
 *    colour plus a faint sheen on the upper half (a soft 3-D read, still flat
 *    enough to print);
 *  - actors are the C4 Person: a round head on rounded shoulders, the head's
 *    lower rim showing through the body as a seam (head in front of body);
 *    the geometry is shared with the engine (`canvas/personShape.ts`), which
 *    lays the text out in the body and lands connections on the figure;
 *  - grey externals take a resting border shaded from their own grey, not the
 *    blue of their type;
 *  - a SELECTED element keeps its silhouette and gains a crisp amber ring
 *    (accent @ 30 %) outside the engine's glow;
 *  - groups and expanded-object frames are C4 boundaries: dashed frames over a
 *    faint wash.
 *
 * The engine still draws the icon / title / description / type badge on top.
 */

const HEX6 = /^#([0-9a-fA-F]{6})$/

/** Mix a #RRGGBB colour toward white (amt > 0) or black (amt < 0). Non-hex
 *  colours (rgba, keywords) pass through unchanged. */
export function shadeHex(hex: string, amt: number): string {
  const m = HEX6.exec(hex)
  if (!m || amt === 0) return hex
  const n = parseInt(m[1], 16)
  const target = amt > 0 ? 255 : 0
  const k = Math.min(1, Math.abs(amt))
  const ch = (c: number) => Math.round(c + (target - c) * k).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

function withAlpha(color: string, a: number): string {
  const m = HEX6.exec(color)
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

const RING = 3 // selected ring width (px), sitting just outside the border
const RING_ALPHA = 0.3
const DASH = [7, 5] // C4 boundary dash

export const c4Theme = defineTheme({
  meta: { id: c4Skin.id, name: c4Skin.name, version: '1.0.0', trust: 'official', mode: 'default' },
  style: { renderStyle: c4Skin.renderStyle },

  object: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { geom, fill, type, state } = args
      const { x, y, w, h, cornerRadius: r } = geom
      const isStore = type === 'store'
      const person: PersonGeometry | null =
        type === 'actor' && args.ctx.style.actorShape === 'person' ? personGeometry(x, y, w, h) : null
      const cap = isStore ? storeCapRy(w, h) : 0

      // One silhouette builder for fill, sheen clip, border and ring (offset o outward).
      const outline = (o = 0) => {
        if (person) {
          cd.beginPath()
          tracePersonOutline(cd, offsetPerson(person, o))
        } else if (isStore) {
          buildCylinderPath(cd, x - o, y - o, w + o * 2, h + o * 2, cap + o / 2)
        } else {
          buildRoundRectPath(cd, x - o, y - o, w + o * 2, h + o * 2, r + o)
        }
      }

      // 1) Body: top-lit gradient of the element's own colour. The engine left
      //    the resting drop shadow / hover lift / selection glow on the ctx, so
      //    this fill casts it.
      const body = cd.createLinearGradient(x, y, x, y + h)
      body.addColorStop(0, shadeHex(fill, 0.16))
      body.addColorStop(0.55, fill)
      body.addColorStop(1, shadeHex(fill, -0.08))
      outline()
      cd.fillStyle = body
      cd.fill()
      cd.shadowColor = 'transparent'

      // 2) Sheen: a faint white wash fading out over the upper half.
      if (!args.ctx.fastMode) {
        cd.save()
        outline()
        cd.clip()
        const sheen = cd.createLinearGradient(x, y, x, y + h * 0.55)
        sheen.addColorStop(0, 'rgba(255, 255, 255, 0.12)')
        sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
        cd.fillStyle = sheen
        cd.fillRect(x, y, w, h * 0.55)
        cd.restore()
      }

      // 3) Border. The engine resolved the state stroke (and the component
      //    dash); a resting grey external is outlined in a shade of its own grey.
      const resting = !state.selected && !state.hovered && !state.connectedToHover
      if (resting && state.external) cd.strokeStyle = shadeHex(fill, -0.22)
      outline()
      cd.stroke()

      // 4) Person: the head's lower rim shows through the shoulders — the C4
      //    "head in front of the body" seam.
      const neck = person ? personNeckArc(person) : null
      if (person && neck) {
        cd.save()
        cd.setLineDash([])
        // quieter when the (dark-mode) border is lighter than the body
        cd.globalAlpha *= personNeckSeamOpacity(fill, typeof cd.strokeStyle === 'string' ? cd.strokeStyle : '')
        cd.beginPath()
        cd.arc(person.headCx, person.headCy, person.headR, neck.a0, neck.a1, false)
        cd.stroke()
        cd.restore()
      }

      // 5) Store lid: a lighter disc + the front-rim seam.
      if (isStore) {
        cd.setLineDash([])
        cd.strokeStyle = 'rgba(255, 255, 255, 0.45)'
        cd.lineWidth = 1
        strokeStoreLid(cd, x, y, w, cap, shadeHex(fill, state.external ? 0.18 : 0.24))
        // re-stroke the rim edge: the lid disc painted over the border's inner half
        cd.strokeStyle = resting && state.external ? shadeHex(fill, -0.22) : args.stroke
        cd.lineWidth = args.strokeWidth
        cd.beginPath()
        cd.ellipse(x + w / 2, y + cap, w / 2, cap, 0, Math.PI, Math.PI * 2)
        cd.stroke()
      }

      // 6) Selected: a crisp accent ring just outside the border.
      if (state.selected) {
        cd.save()
        cd.setLineDash([])
        cd.strokeStyle = withAlpha(args.stroke, RING_ALPHA)
        cd.lineWidth = RING
        outline(RING / 2 + 1)
        cd.stroke()
        cd.restore()
      }
    },
  },

  // C4 boundaries: groups and expanded-object frames are dashed frames over a
  // faint wash (the theme's `groupHudFill`). A user-chosen background / border
  // is honoured, still dashed.
  group: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { x, y, w, h } = args.geom
      const r = Math.min(args.geom.cornerRadius, 8)
      const selected = args.state.selected
      if (args.isParentWrapper) {
        buildRoundRectPath(cd, x, y, w, h, r)
        cd.fillStyle = args.fill
        cd.fill()
      } else if (args.fillAlpha > 0) {
        buildRoundRectPath(cd, x, y, w, h, r)
        cd.globalAlpha = args.customColors ? args.fillAlpha : 1
        cd.fillStyle = args.customColors ? args.fill : (args.ctx.style.groupHudFill ?? 'transparent')
        cd.fill()
      }
      const lw = (args.strokeWidth || 1.25) + (selected ? 0.75 : 0)
      const inset = lw / 2
      cd.globalAlpha = args.strokeAlpha
      cd.strokeStyle = args.stroke
      cd.lineWidth = lw
      cd.setLineDash(DASH)
      buildRoundRectPath(cd, x + inset, y + inset, w - lw, h - lw, Math.max(0, r - inset))
      cd.stroke()
      // Leave the inset path current (the engine strokes its selection glow on
      // it) and the stroke alpha set, as the default box does, but hand back a
      // solid dash: the header icons draw after this.
      cd.setLineDash([])
    },
  },

  // 3D board: the database drum takes the element's own C4 colour (the engine
  // otherwise tints it with the type-glyph colour, translucent in this theme),
  // and a grey external card is rimmed in a shade of its own grey — the 2D rule.
  object3d(args) {
    if (args.type === 'store') return { materials: { top: args.fill } }
    if (args.external && !args.selected) return { materials: { border: shadeHex(args.fill, -0.22) } }
    return null
  },
})
