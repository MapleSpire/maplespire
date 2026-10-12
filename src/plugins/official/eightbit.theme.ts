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
import { eightBitSkin } from '../../skins/eightBitSkin'
import { drawPixelArtRect, drawPixelArtCylinder } from '../../canvas/engine/objectBox'
import { mixColors, parseColor } from '../../canvas3d/palette'
import { SKY_DAY_PNG, SKY_NIGHT_PNG, FLOOR_DAY_PNG, FLOOR_NIGHT_PNG } from './eightbitAssets'

/**
 * Official 8-bit theme. Object box = pixel-art rect. The pixel grid snap and the
 * font floor are cross-cutting (they affect shared content layout, not just the
 * box), so they're declared via `meta.pixelSnap` / `meta.fontMinSize` and applied
 * by the engine — replacing the old `mode === 'eightbit'` geometry/font checks.
 *
 * 3D: the board reads as a voxel/Minecraft take on the NES palette —
 * pixel-art equirect skies (day/night per appearance, via the skins'
 * `three.environment`), a dithered floor tile, and `object3d`/`floor3d` specs
 * turning every card into a sharp-cornered chunky block with posterized
 * block-shaded walls. The engine's pixel-snap layer supplies the rest (snapped
 * depth, faceted drums, square grid dots, crisp texel filtering).
 */
const ps = eightBitSkin.renderStyle.pixelSize || 2

/** Quantize a css color to 32-value channel steps — the posterized "block
 * palette" look; smooth mixes read airbrushed, not 8-bit. */
function posterize(css: string): string {
  const c = parseColor(css)
  if (!c) return css
  const q = (v: number) => Math.min(255, Math.round(v / 32) * 32)
  return `rgb(${q(c.r)}, ${q(c.g)}, ${q(c.b)})`
}

export const eightbitTheme = defineTheme({
  meta: {
    id: eightBitSkin.id,
    name: eightBitSkin.name,
    version: '1.0.0',
    trust: 'official',
    mode: 'eightbit',
    pixelSnap: ps,
    fontMinSize: 8,
    // Embedded pixel-art 3D assets (generated: scripts/gen-eightbit-assets.mjs).
    // The light/dark skin variants pick their sky + floor tile by id in their
    // `three.environment` blocks.
    assets: {
      'sky-day': { kind: 'texture', dataUri: SKY_DAY_PNG },
      'sky-night': { kind: 'texture', dataUri: SKY_NIGHT_PNG },
      'floor-day': { kind: 'texture', dataUri: FLOOR_DAY_PNG },
      'floor-night': { kind: 'texture', dataUri: FLOOR_NIGHT_PNG },
    },
  },
  style: { renderStyle: eightBitSkin.renderStyle },

  object: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { geom, fill, stroke, type, state } = args
      const { x, y, w, h } = geom
      const objSkin = eightBitSkin.objects[type]
      const shadowColor = state.external ? objSkin.shadowColorExternal : objSkin.shadowColor
      if (type === 'store') {
        drawPixelArtCylinder(cd, x, y, w, h, fill, stroke as string, shadowColor, ps)
      } else {
        drawPixelArtRect(cd, x, y, w, h, fill, stroke as string, shadowColor, ps)
      }
      d.lineWidth = 1
      d.shadowColor = 'transparent'
    },
  },

  // Group box (8-bit): pixel border with stepped bevel corners. Parent-wrapper
  // groups fill at full alpha; standard groups use the configured fill/stroke
  // alphas. No double-stroke and no selection glow (the engine skips glow for
  // pixel-snap themes). `fill`/`stroke` are engine-resolved.
  group: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { x, y, w, h } = args.geom
      const { fill, stroke, fillAlpha, strokeAlpha, strokeWidth, isParentWrapper } = args
      // Pixel border thickness in whole pixel-blocks; honors a user width.
      const borderW = ps * (strokeWidth ? Math.max(1, Math.round(strokeWidth)) : 2)
      const cornerGap = borderW

      if (isParentWrapper) {
        cd.fillStyle = fill
        cd.fillRect(x, y, w, h)
        cd.fillStyle = stroke
      } else {
        // Background fill (skipped when the group is transparent), then the
        // pixel border. Alphas are engine-resolved so per-group opacity wins.
        if (fillAlpha > 0) {
          cd.globalAlpha = fillAlpha
          cd.fillStyle = fill
          cd.fillRect(x, y, w, h)
        }
        cd.globalAlpha = strokeAlpha
        cd.fillStyle = stroke
      }

      // Border segments
      cd.fillRect(x + cornerGap, y, w - cornerGap * 2, borderW)
      cd.fillRect(x + cornerGap, y + h - borderW, w - cornerGap * 2, borderW)
      cd.fillRect(x, y + cornerGap, borderW, h - cornerGap * 2)
      cd.fillRect(x + w - borderW, y + cornerGap, borderW, h - cornerGap * 2)
      // Stepped corner fills
      cd.fillRect(x + cornerGap - ps, y + cornerGap - ps, ps, ps)
      cd.fillRect(x + w - cornerGap, y + cornerGap - ps, ps, ps)
      cd.fillRect(x + cornerGap - ps, y + h - cornerGap, ps, ps)
      cd.fillRect(x + w - cornerGap, y + h - cornerGap, ps, ps)
    },
  },

  // 3D board: every card is a voxel block — perfectly sharp corners,
  // double the preset extrusion (chunky Minecraft proportions), and hard
  // posterized wall steps derived from the top fill (block top bright, front
  // face darker, side face darkest — the classic block shading law) instead of
  // the kit's smooth stone mix. Selection tints the walls toward the NES red.
  object3d(args) {
    const pole = args.dark ? '#000000' : '#101018'
    let front = mixColors(args.fill, pole, args.dark ? 0.4 : 0.3)
    let side = mixColors(args.fill, pole, args.dark ? 0.58 : 0.48)
    if (args.selected) {
      front = mixColors(front, '#E4000F', 0.32)
      side = mixColors(side, '#E4000F', 0.24)
    }
    return {
      cornerRadius: 0,
      depthScale: 2,
      materials: { wallFront: posterize(front), wallSide: posterize(side) },
    }
  },

  // Sharp-cornered board slab; the grid dots stay (the engine renders them as
  // square pixels for pixel-snap themes) over the dithered floor tile. Flat,
  // rectangular grid cells break away from its edges, dense beside the intact
  // surface and increasingly sparse outside it. The pieces remain scene toys:
  // users can grab or kick them, but nothing is saved.
  floor3d(args) {
    return {
      cornerRadius: 0,
      edge: 'flat' as const,
      shadow: true,
      scatter: args.dark
        ? { pattern: 'grid-fracture' as const, colors: ['#22224A', '#2E8C1E', '#3CBCFC'], count: 120, size: 8, spread: 132, rise: 12, interactive: true }
        : { pattern: 'grid-fracture' as const, colors: ['#A8B4BA', '#379E22', '#0058F8'], count: 120, size: 8, spread: 132, rise: 12, interactive: true },
    }
  },
})
