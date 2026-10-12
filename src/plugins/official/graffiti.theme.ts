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
import { graffitiSkin } from '../../skins/graffitiSkin'
import { buildRoundRectPath, storeCapRy, buildCylinderPath, strokeStoreLid } from '../../canvas/engine/objectBox'

/**
 * Official graffiti theme. Object box = regular rounded rect + solid fill, then a
 * hand-drawn double border (inner rotated slightly CW, outer 1.5px larger rotated
 * CCW). No plain stroke when double-stroking. In fast mode it falls back to a
 * plain stroked box. The engine resolves colors/shadow and draws shared content.
 */
export const graffitiTheme = defineTheme({
  meta: { id: graffitiSkin.id, name: graffitiSkin.name, version: '1.0.0', trust: 'official', mode: 'graffiti' },
  style: { renderStyle: graffitiSkin.renderStyle },

  object: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { geom, fill, stroke, type } = args
      const { x, y, w, h, cornerRadius: cornerR } = geom
      const ds = graffitiSkin.renderStyle.doubleStroke!
      const hasDoubleStroke = !args.ctx.fastMode && !!ds.enabled
      // Stores are a hand-drawn database cylinder; everything else a rounded rect.
      const isStore = type === 'store'
      const cap = storeCapRy(w, h)
      const body = (px: number, py: number, pw: number, ph: number, pr: number, pcap: number) =>
        isStore ? buildCylinderPath(cd, px, py, pw, ph, pcap) : buildRoundRectPath(cd, px, py, pw, ph, pr)
      const lid = () => {
        if (!isStore) return
        cd.shadowColor = 'transparent'
        // Lid seam in the SAME dark ink as the body outline (was a faint grey
        // cylinderLine that didn't read as part of the hand-drawn sketch).
        cd.strokeStyle = stroke as string
        cd.lineWidth = ds.innerWidth
        strokeStoreLid(cd, x, y, w, cap)
      }

      body(x, y, w, h, cornerR, cap)
      d.fillStyle = fill
      d.fill()

      if (!hasDoubleStroke) {
        d.stroke()
        lid()
        return
      }

      const objectStrokeColor = stroke as string
      const cx = x + w / 2
      const cy = y + h / 2

      // Inner border — exact object size, clockwise rotation
      d.save()
      d.strokeStyle = objectStrokeColor
      d.lineWidth = ds.innerWidth
      d.lineJoin = 'round'
      d.lineCap = 'round'
      d.translate(cx, cy)
      d.rotate(0.008)
      d.translate(-cx, -cy)
      body(x, y, w, h, cornerR, cap)
      d.stroke()
      d.restore()

      // Outer border — 1.5px larger, stronger counter-clockwise rotation
      d.save()
      d.strokeStyle = objectStrokeColor
      d.lineWidth = ds.outerWidth
      d.lineJoin = 'round'
      d.lineCap = 'round'
      d.translate(cx, cy)
      d.rotate(-0.012)
      d.translate(-cx, -cy)
      const outPad = 1.5
      const outR = Math.max(0, cornerR + 1)
      body(x - outPad, y - outPad, w + outPad * 2, h + outPad * 2, outR, cap + 0.8)
      d.stroke()
      d.restore()

      lid()
    },
  },

  // Group box (graffiti): rounded fill + rotated inner/outer double border. Parent
  // wrappers draw at full alpha; standard groups at 0.3 fill / 0.9|0.5 stroke. No
  // plain stroke. The engine's selection glow strokes the path this hook leaves.
  group: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { x, y, w, h, cornerRadius: r } = args.geom
      const { fill, stroke, fillAlpha, strokeAlpha, strokeWidth, isParentWrapper } = args
      const ds = graffitiSkin.renderStyle.doubleStroke!
      const hasDoubleStroke = !args.ctx.fastMode && !!ds.enabled
      const cx = x + w / 2
      const cy = y + h / 2
      // Stroke alpha is engine-resolved (selected vs not); parent wrappers stay
      // fully opaque.
      const selAlpha = isParentWrapper ? 1 : strokeAlpha
      // Honor a user border width while keeping the natural inner→outer ratio;
      // fall back to the skin's hand-drawn widths when unset.
      const innerW = strokeWidth || ds.innerWidth
      const outerW = innerW + (ds.outerWidth - ds.innerWidth)

      // Skip the fill for a transparent background; the borders still draw.
      if (isParentWrapper || fillAlpha > 0) {
        cd.fillStyle = fill
        if (!isParentWrapper) cd.globalAlpha = fillAlpha
        buildRoundRectPath(cd, x, y, w, h, r)
        cd.fill()
      }

      if (!hasDoubleStroke) return

      // Inner — clockwise rotation
      cd.save()
      if (!isParentWrapper) cd.globalAlpha = selAlpha
      cd.strokeStyle = stroke
      cd.lineWidth = innerW
      cd.lineJoin = 'round'
      cd.lineCap = 'round'
      cd.translate(cx, cy)
      cd.rotate(0.008)
      cd.translate(-cx, -cy)
      buildRoundRectPath(cd, x, y, w, h, r)
      cd.stroke()
      cd.restore()

      // Outer — 1.5px larger, stronger counter-clockwise rotation
      cd.save()
      if (!isParentWrapper) cd.globalAlpha = selAlpha
      cd.strokeStyle = stroke
      cd.lineWidth = outerW
      cd.lineJoin = 'round'
      cd.lineCap = 'round'
      cd.translate(cx, cy)
      cd.rotate(-0.012)
      cd.translate(-cx, -cy)
      const outR = Math.max(0, r + 1)
      const outPad = 1.5
      buildRoundRectPath(cd, x - outPad, y - outPad, w + outPad * 2, h + outPad * 2, outR)
      cd.stroke()
      cd.restore()
    },
  },
})
