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
import { cyberpunkSkin } from '../../skins/cyberpunkSkin'
import {
  startCyberpunkAnimations,
  stopCyberpunkAnimations,
  getCyberpunkAnimState,
} from '../../canvas/engine/cyberpunkAnimations'
import { buildImperfectPath, drawScratchOverlay, drawCornerBrackets } from '../../canvas/engine/cyberpunkEffects'
import { buildRoundRectPath, storeCapRy, buildCylinderPath, strokeStoreLid } from '../../canvas/engine/objectBox'

/**
 * Official cyberpunk theme:
 *  - animation lifecycle (GSAP) in onActivate / onDeactivate, with
 *    isAnimating()/animate() exposing the live GSAP state to the engine's
 *    renderLoop;
 *  - `object`, `group` and `selection` hooks for the grunge card look;
 *  - the screen-space scan-line overlay as a `background` post-hook (drawn after
 *    the bg fill, before the world).
 */
const rs = cyberpunkSkin.renderStyle

export const cyberpunkTheme = defineTheme({
  meta: {
    id: cyberpunkSkin.id,
    name: cyberpunkSkin.name,
    version: '1.0.0',
    trust: 'official',
    mode: 'cyberpunk',
  },
  style: { renderStyle: cyberpunkSkin.renderStyle },

  onActivate() {
    startCyberpunkAnimations(
      rs.neonGlow?.pulseSpeed ?? 800,
      rs.neonGlow?.intensity ?? 1.5,
      rs.glitch?.interval ?? 3.5,
      rs.glitch?.duration ?? 0.12,
      rs.glitch?.intensity ?? 2.5,
    )
  },

  onDeactivate() {
    stopCyberpunkAnimations()
  },

  isAnimating() {
    // Same gate the engine's renderLoop used: keep the rAF alive while the glow
    // pulse is off-neutral or a glitch offset is active.
    if (!rs.neonGlow?.enabled) return false
    const anim = getCyberpunkAnimState()
    return Math.abs(anim.glowPulse - 1) > 0.05 || anim.glitchX !== 0 || anim.glitchY !== 0
  },

  animate() {
    const a = getCyberpunkAnimState()
    return { glowPulse: a.glowPulse, glitchX: a.glitchX, glitchY: a.glitchY, chromaticBoost: a.chromaticBoost }
  },

  // Object box (cyberpunk): cyan pre-stroke → imperfect path → scratch fill →
  // yellow offset double-stroke. The engine has already applied alpha, glitch
  // translate, shadow/glow, and resolved fill/stroke colors before this runs;
  // shared content (icon/text) is drawn by the engine afterwards. In fast mode
  // all grunge is disabled and it falls back to a plain rounded box.
  object: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { geom, fill, type, id } = args
      const { x, y, w, h, cornerRadius: cornerR } = geom
      // Read the RESOLVED render style (light/dark variant), not the static dark
      // import — that is what lets the light variant turn the grunge/double-stroke
      // off and render clean cards.
      const style = args.ctx.style
      const fastMode = args.ctx.fastMode
      const imperfect = style.imperfectShapes
      const scratch = style.scratchPaint
      const ds = style.doubleStroke!
      const offset = ds.offset ?? 2
      // Stores are a database cylinder — keep the drum curves clean (no grunge).
      const isStore = type === 'store'
      const cap = storeCapRy(w, h)
      const useImperfect = !fastMode && imperfect?.enabled && !isStore
      const useScratch = !fastMode && scratch?.enabled
      const hasDoubleStroke = !fastMode && !!ds?.enabled
      const bodyOutline = () =>
        isStore ? buildCylinderPath(cd, x, y, w, h, cap) : buildRoundRectPath(cd, x, y, w, h, cornerR)

      // Perforated/broken edge: the engine sets a [4,4] dash for `component`
      // shapes only, so the component keeps its dashed border while every other
      // shape (app/system/store) draws a clean solid border. The dash is still
      // applied locally to the scratch overlay below, so all non-actor boxes
      // keep the nicer "scratched" interior. (Engine resets the dash after this
      // hook.)

      // Cyan stroke drawn BEFORE fill (peeks below the shape)
      if (hasDoubleStroke) {
        d.save()
        d.strokeStyle = ds.innerColor!
        d.lineWidth = ds.innerWidth
        d.lineJoin = 'round'
        d.lineCap = 'round'
        d.translate(0, offset * 0.5)
        bodyOutline()
        d.stroke()
        d.restore()
      }

      // Path: imperfect grunge or regular
      if (useImperfect) {
        buildImperfectPath(cd, {
          x, y, w, h,
          cornerRadius: cornerR,
          roughness: imperfect!.roughness,
          segmentCount: imperfect!.segmentCount,
          seed: id,
        })
      } else {
        bodyOutline()
      }

      // Fill: scratched paint or solid
      if (useScratch) {
        d.fillStyle = scratch!.revealColor
        d.fill()
        d.fillStyle = fill
        d.fill()
        d.save()
        d.clip()
        if (type !== 'actor') {
          // Keep the broken/scratched stroke look for the interior marks even
          // though the border itself is now solid on non-component shapes.
          d.setLineDash([4, 4])
          drawScratchOverlay(
            cd, x, y, w, h, id,
            scratch!.scratchCount,
            scratch!.scratchOpacity,
            scratch!.scratchWidth,
            scratch!.revealColor,
          )
        }
        d.restore()
      } else {
        d.fillStyle = fill
        d.fill()
      }

      // Plain stroke only when not double-stroking
      if (!hasDoubleStroke) {
        d.stroke()
      }

      // Yellow stroke drawn AFTER fill (offset up, visible above)
      if (hasDoubleStroke) {
        d.save()
        d.strokeStyle = ds.outerColor || (args.stroke as string)
        d.lineWidth = ds.outerWidth
        d.lineJoin = 'round'
        d.lineCap = 'round'
        d.translate(0, -offset * 0.5)
        bodyOutline()
        d.stroke()
        d.restore()
      }

      // Database lid seam (store only).
      if (isStore) {
        d.shadowColor = 'transparent'
        d.strokeStyle = cyberpunkSkin.objects.store.cylinderLine
        d.lineWidth = 1.5
        strokeStoreLid(cd, x, y, w, cap)
      }
    },
  },

  // Group box (cyberpunk): translucent yellow fill. No plain stroke / no double
  // stroke (the engine's `mode !== cyberpunk` guards skipped those). The engine's
  // selection glow strokes the path this hook leaves; corner brackets are drawn
  // by the `selection` post-hook below.
  group: {
    mode: 'replace',
    draw(d, args) {
      const cd = d as unknown as CanvasRenderingContext2D
      const { x, y, w, h, cornerRadius: r } = args.geom
      const { fill, stroke, fillAlpha, strokeAlpha, isParentWrapper, customColors } = args

      // When the user sets a custom background/border, honor it like a normal
      // group box (the corner brackets from the `selection` hook still draw on
      // top). Otherwise keep the signature neon-HUD fill.
      if (!isParentWrapper && customColors) {
        buildRoundRectPath(cd, x, y, w, h, r)
        if (fillAlpha > 0) {
          d.globalAlpha = fillAlpha
          d.fillStyle = fill
          d.fill()
        }
        d.globalAlpha = strokeAlpha
        d.strokeStyle = stroke
        const lw = args.strokeWidth || 1
        d.lineWidth = args.state.selected ? lw + 1 : lw
        d.stroke()
        return
      }

      if (!isParentWrapper) {
        d.globalAlpha = fillAlpha
      }
      buildRoundRectPath(cd, x, y, w, h, r)
      d.fillStyle = args.ctx.style.groupHudFill ?? 'rgba(255, 240, 0, 0.08)'
      d.fill()
    },
  },

  // Cyberpunk corner brackets — drawn on every group after its content (HUD).
  selection: {
    mode: 'post',
    draw(d, args) {
      if (args.ctx.fastMode) return
      const cd = d as unknown as CanvasRenderingContext2D
      const g = args.target.geom
      const bracketColor = args.ctx.style.groupHudStroke ?? '#fff000'
      drawCornerBrackets(cd, g.x, g.y, g.w, g.h, bracketColor, 14, 2, 3)
    },
  },

  // 3D board (spec-builder layer): every card gets a neon rim on its
  // top face (accent when selected), database drums spin slowly so the baked
  // sheen sweeps — pure data out, the WebGL engine applies it. The light
  // variant swaps to its techwear accents (magenta action / cyan secondary).
  object3d(args) {
    const rim = args.dark
      ? { idle: '#00F0FF', selected: '#FCEE0A' }
      : { idle: '#16C0E0', selected: '#FF1B6D' }
    return {
      edgeGlow: { color: args.selected ? rim.selected : rim.idle, width: 1.6 },
      ...(args.type === 'store' ? { spin: { speed: 10 } } : {}),
    }
  },

  floor3d(args) {
    // glow grid dots on the slab; keep the (recolored) underglow shadow
    return { gridColor: args.dark ? '#2A4A55' : '#A9D3DE', shadow: true }
  },

  background: {
    mode: 'post',
    draw(d, { ctx }) {
      // Matches the old `!this.isInteracting && scanLines?.enabled` call-site gate.
      if (ctx.fastMode) return
      const scan = ctx.style.scanLines
      if (!scan?.enabled) return

      const spacing = scan.density * ctx.viewport.scale
      const offsetY = ctx.viewport.y % spacing
      const flicker = scan.speed > 0 ? Math.sin(ctx.timeMs / scan.speed) * 0.5 + 0.5 : 1

      d.save()
      d.globalAlpha = scan.opacity * flicker
      d.fillStyle = ctx.style.scanLineColor ?? cyberpunkSkin.objects.actor.stroke

      for (let y = offsetY; y < ctx.canvas.height; y += spacing) {
        // Slight random horizontal offset for glitch feel
        const glitchOffset = scan.speed > 0 && Math.random() > 0.97 ? (Math.random() - 0.5) * 8 : 0
        d.fillRect(glitchOffset, y, ctx.canvas.width, 1)
      }

      d.restore()
    },
  },
})
