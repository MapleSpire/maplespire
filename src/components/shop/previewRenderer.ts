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

import type { SkinConfig } from '../../skins/types'
import { buildImperfectPath, drawScratchOverlay } from '../../canvas/engine/cyberpunkEffects'
import { storeCapRy, buildCylinderPath, strokeStoreLid, drawPixelArtCylinder, lightenHex } from '../../canvas/engine/objectBox'

interface PreviewObject {
  type: 'actor' | 'system' | 'store'
  x: number
  y: number
  w: number
  h: number
  name: string
}

const sampleObjects: PreviewObject[] = [
  { type: 'actor', x: 20, y: 45, w: 70, h: 50, name: 'User' },
  { type: 'system', x: 120, y: 35, w: 80, h: 55, name: 'API' },
  { type: 'store', x: 230, y: 40, w: 70, h: 50, name: 'DB' },
]

const sampleConnections = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
]

function drawPixelArtRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  shadowColor: string,
  pixelSize: number = 2
): void {
  const borderW = pixelSize * 2
  const shadowOffX = pixelSize * 2
  const shadowOffY = pixelSize * 3

  // Drop shadow
  ctx.fillStyle = shadowColor
  ctx.fillRect(x + shadowOffX, y + shadowOffY, w, h)

  // Main fill
  ctx.fillStyle = fill
  ctx.fillRect(x, y, w, h)

  // Outer border
  ctx.strokeStyle = stroke
  ctx.lineWidth = borderW
  ctx.strokeRect(x, y, w, h)

  // Inset highlight (top)
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.fillRect(x + borderW, y + borderW, w - borderW * 2, pixelSize)

  // Inset shadow (bottom)
  ctx.fillStyle = 'rgba(0,0,0,0.15)'
  ctx.fillRect(x + borderW, y + h - borderW - pixelSize, w - borderW * 2, pixelSize)
}

/**
 * Draw the store sample as a database cylinder, theme-adapted (pixel drum for
 * 8-bit, double-stroke for cyberpunk/graffiti, smooth otherwise) so shop cards
 * match the canvas. Mirrors the engine's per-theme store box.
 */
function drawPreviewStore(
  ctx: CanvasRenderingContext2D,
  skin: SkinConfig,
  obj: PreviewObject
): void {
  const s = skin.objects.store
  const { x, y, w, h } = obj
  const cap = storeCapRy(w, h)
  const mode = skin.renderStyle.mode

  if (mode === 'eightbit') {
    const ps = skin.renderStyle.pixelSize || 2
    drawPixelArtCylinder(ctx, x, y, w, h, s.fill, s.stroke, s.shadowColor, ps)
    return
  }

  ctx.save()
  ctx.shadowColor = s.shadowColor
  ctx.shadowBlur = mode === 'graffiti' ? 0 : s.shadowBlur
  ctx.shadowOffsetY = s.shadowOffsetY
  buildCylinderPath(ctx, x, y, w, h, cap)
  ctx.fillStyle = s.fill
  ctx.fill()
  ctx.restore()

  const ds = skin.renderStyle.doubleStroke
  if (ds?.enabled && (ds.innerColor || ds.outerColor)) {
    const off = ds.offset ?? 2
    ctx.save(); ctx.translate(0, off * 0.5); ctx.strokeStyle = ds.innerColor!; ctx.lineWidth = ds.innerWidth
    buildCylinderPath(ctx, x, y, w, h, cap); ctx.stroke(); ctx.restore()
    ctx.save(); ctx.translate(0, -off * 0.5); ctx.strokeStyle = ds.outerColor || s.stroke; ctx.lineWidth = ds.outerWidth
    buildCylinderPath(ctx, x, y, w, h, cap); ctx.stroke(); ctx.restore()
  } else if (ds?.enabled) {
    const cx = x + w / 2, cy = y + h / 2
    ctx.save(); ctx.strokeStyle = s.stroke; ctx.lineWidth = ds.innerWidth; ctx.lineJoin = 'round'
    ctx.translate(cx, cy); ctx.rotate(0.01); ctx.translate(-cx, -cy)
    buildCylinderPath(ctx, x, y, w, h, cap); ctx.stroke(); ctx.restore()
    ctx.save(); ctx.strokeStyle = s.stroke; ctx.lineWidth = ds.outerWidth; ctx.lineJoin = 'round'
    ctx.translate(cx, cy); ctx.rotate(-0.014); ctx.translate(-cx, -cy)
    buildCylinderPath(ctx, x - 1, y - 1, w + 2, h + 2, cap + 0.5); ctx.stroke(); ctx.restore()
  } else {
    ctx.strokeStyle = s.stroke; ctx.lineWidth = s.strokeWidth
    buildCylinderPath(ctx, x, y, w, h, cap); ctx.stroke()
  }

  // Graffiti draws the lid seam in the dark body ink (matches the canvas hook),
  // everything else uses the faint cylinderLine.
  const graffitiLid = mode === 'graffiti'
  ctx.strokeStyle = graffitiLid ? s.stroke : s.cylinderLine
  ctx.lineWidth = graffitiLid ? (skin.renderStyle.doubleStroke?.innerWidth ?? 1.5) : 1
  strokeStoreLid(ctx, x, y, w, cap, mode === 'default' ? lightenHex(s.fill, 0.25) : undefined)
}

export function renderSkinPreview(
  ctx: CanvasRenderingContext2D,
  skin: SkinConfig,
  time: number,
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height)

  // Background
  ctx.fillStyle = skin.canvas.bg
  ctx.fillRect(0, 0, width, height)

  // Grid
  ctx.fillStyle = skin.canvas.grid
  for (let gx = 0; gx < width; gx += 12) {
    for (let gy = 0; gy < height; gy += 12) {
      ctx.beginPath()
      ctx.arc(gx, gy, 0.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Scan lines overlay (cyberpunk skin)
  if (skin.renderStyle.scanLines?.enabled) {
    const scan = skin.renderStyle.scanLines
    ctx.save()
    ctx.globalAlpha = scan.opacity
    ctx.fillStyle = skin.objects.actor.stroke
    for (let y = 0; y < height; y += scan.density * 3) {
      ctx.fillRect(0, y, width, 1)
    }
    ctx.restore()
  }

  // Fit the sample scene (laid out in a ~296×72 design box) into the canvas, so
  // every theme reads consistently regardless of card size.
  const designW = 296
  const designH = 72
  const designCX = 160
  const designCY = 64
  const pad = 12
  const fit = Math.min((width - pad * 2) / designW, (height - pad * 2) / designH)
  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(fit, fit)
  ctx.translate(-designCX, -designCY)

  // Draw connections
  for (const conn of sampleConnections) {
    const from = sampleObjects[conn.from]
    const to = sampleObjects[conn.to]
    const fromCX = from.x + from.w / 2
    const fromCY = from.y + from.h / 2
    const toCX = to.x + to.w / 2
    const toCY = to.y + to.h / 2

    // Simple bezier
    const cp1x = fromCX + (toCX - fromCX) * 0.5
    const cp1y = fromCY
    const cp2x = fromCX + (toCX - fromCX) * 0.5
    const cp2y = toCY

    const hasDoubleStrokeConn = skin.renderStyle.doubleStroke?.enabled
    const hasChromaticConn = skin.renderStyle.chromaticAberration?.enabled

    if (!hasDoubleStrokeConn && !hasChromaticConn) {
      ctx.strokeStyle = skin.connections.normal
      ctx.lineWidth = skin.connections.strokeWidth
      ctx.beginPath()
      ctx.moveTo(fromCX + from.w / 2, fromCY)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toCX - to.w / 2, toCY)
      ctx.stroke()
    }

    // Chromatic aberration (cyberpunk skin) — cyan left/up, yellow right/down, primary centered
    if (hasChromaticConn && !hasDoubleStrokeConn) {
      const ca = skin.renderStyle.chromaticAberration!

      ctx.save()
      ctx.strokeStyle = skin.connections.highlight
      ctx.lineWidth = skin.connections.strokeWidth
      ctx.translate(-ca.offset * 0.7, -ca.offset * 0.7)
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.moveTo(fromCX + from.w / 2, fromCY)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toCX - to.w / 2, toCY)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = ca.secondaryColor
      ctx.lineWidth = skin.connections.strokeWidth
      ctx.translate(ca.offset * 0.7, ca.offset * 0.7)
      ctx.globalAlpha = 0.4
      ctx.beginPath()
      ctx.moveTo(fromCX + from.w / 2, fromCY)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toCX - to.w / 2, toCY)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = skin.connections.normal
      ctx.lineWidth = skin.connections.strokeWidth
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.moveTo(fromCX + from.w / 2, fromCY)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toCX - to.w / 2, toCY)
      ctx.stroke()
      ctx.restore()
    }

    // Double curve — cyberpunk (colored + offset) or graffiti (offset same color)
    if (hasDoubleStrokeConn) {
      const ds = skin.renderStyle.doubleStroke!
      const isCyberpunkDouble = ds.outerColor || ds.innerColor
      const offset = ds.offset ?? 2

      if (isCyberpunkDouble) {
        // Outer (yellow) — offset up
        ctx.save()
        ctx.strokeStyle = ds.outerColor || skin.connections.normal
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(fromCX + from.w / 2, fromCY - offset * 0.5)
        ctx.bezierCurveTo(cp1x, cp1y - offset * 0.5, cp2x, cp2y - offset * 0.5, toCX - to.w / 2, toCY - offset * 0.5)
        ctx.stroke()
        ctx.restore()

        // Inner (cyan) — offset down
        ctx.save()
        ctx.strokeStyle = ds.innerColor || skin.connections.normal
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(fromCX + from.w / 2, fromCY + offset * 0.5)
        ctx.bezierCurveTo(cp1x, cp1y + offset * 0.5, cp2x, cp2y + offset * 0.5, toCX - to.w / 2, toCY + offset * 0.5)
        ctx.stroke()
        ctx.restore()
      } else {
        // Graffiti sketch-style — inner + outer, offset in opposite directions
        // Inner curve — very slight offset inward (down)
        ctx.save()
        ctx.strokeStyle = skin.connections.normal
        ctx.lineWidth = ds.innerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        const inOff = 0.5
        ctx.beginPath()
        ctx.moveTo(fromCX + from.w / 2, fromCY + inOff)
        ctx.bezierCurveTo(cp1x, cp1y + inOff, cp2x, cp2y + inOff, toCX - to.w / 2, toCY + inOff)
        ctx.stroke()
        ctx.restore()

        // Outer curve — smaller offset outward (up)
        ctx.save()
        ctx.strokeStyle = skin.connections.normal
        ctx.lineWidth = ds.outerWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        const outOff = 1.5
        ctx.beginPath()
        ctx.moveTo(fromCX + from.w / 2, fromCY - outOff)
        ctx.bezierCurveTo(cp1x, cp1y - outOff, cp2x, cp2y - outOff, toCX - to.w / 2, toCY - outOff)
        ctx.stroke()
        ctx.restore()
      }
    }

    // Traveling dot
    const cycle = 2000
    const t = (time % cycle) / cycle
    const dotX = (1 - t) * (1 - t) * (1 - t) * (fromCX + from.w / 2) +
                  3 * (1 - t) * (1 - t) * t * cp1x +
                  3 * (1 - t) * t * t * cp2x +
                  t * t * t * (toCX - to.w / 2)
    const dotY = (1 - t) * (1 - t) * (1 - t) * fromCY +
                  3 * (1 - t) * (1 - t) * t * cp1y +
                  3 * (1 - t) * t * t * cp2y +
                  t * t * t * toCY

    ctx.fillStyle = skin.connections.highlight
    ctx.beginPath()
    ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // Draw objects
  for (const obj of sampleObjects) {
    const objSkin = skin.objects[obj.type]
    const isEightBit = skin.renderStyle.mode === 'eightbit'
    const r = isEightBit ? 0 : objSkin.cornerRadius

    // Stores render as a database cylinder (its own per-theme box + name); the
    // shared rect/icon path below is skipped for them.
    if (obj.type === 'store') {
      drawPreviewStore(ctx, skin, obj)
      ctx.fillStyle = objSkin.text
      ctx.font = `600 ${Math.min(10, obj.w / 6)}px ${skin.renderStyle.fontFamily || 'Inter'}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(obj.name, obj.x + obj.w / 2, obj.y + 26)
      continue
    }

    if (isEightBit && r === 0) {
      const ps = skin.renderStyle.pixelSize || 2
      drawPixelArtRect(
        ctx, obj.x, obj.y, obj.w, obj.h,
        objSkin.fill,
        objSkin.stroke,
        objSkin.shadowColor,
        ps
      )
      ctx.lineWidth = 1
      ctx.shadowColor = 'transparent'
    } else {
      // Shadow
      const neonGlow = skin.renderStyle.neonGlow
      const glowPulse = neonGlow?.enabled
        ? 1 + Math.sin(time / neonGlow.pulseSpeed) * 0.25 * neonGlow.intensity
        : 1

      if (skin.renderStyle.mode === 'cyberpunk') {
        ctx.shadowColor = objSkin.shadowColor
        ctx.shadowBlur = objSkin.shadowBlur * glowPulse
        ctx.shadowOffsetY = objSkin.shadowOffsetY
      } else if (skin.renderStyle.mode === 'graffiti') {
        ctx.shadowColor = objSkin.shadowColor
        ctx.shadowBlur = 0
        ctx.shadowOffsetY = objSkin.shadowOffsetY
      } else {
        ctx.shadowColor = objSkin.shadowColor
        ctx.shadowBlur = objSkin.shadowBlur
        ctx.shadowOffsetY = objSkin.shadowOffsetY
      }

      // Cyberpunk grunge
      const isCyberpunk = skin.renderStyle.mode === 'cyberpunk'
      const imperfect = skin.renderStyle.imperfectShapes
      const scratch = skin.renderStyle.scratchPaint
      const useImperfect = isCyberpunk && imperfect?.enabled
      const useScratch = isCyberpunk && scratch?.enabled

      // Background
      if (useImperfect) {
        buildImperfectPath(ctx, {
          x: obj.x,
          y: obj.y,
          w: obj.w,
          h: obj.h,
          cornerRadius: r,
          roughness: imperfect.roughness,
          segmentCount: imperfect.segmentCount,
          seed: obj.name,
        })
      } else if (r > 0) {
        ctx.beginPath()
        ctx.moveTo(obj.x + r, obj.y)
        ctx.lineTo(obj.x + obj.w - r, obj.y)
        ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
        ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
        ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
        ctx.lineTo(obj.x + r, obj.y + obj.h)
        ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
        ctx.lineTo(obj.x, obj.y + r)
        ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
        ctx.closePath()
      }

      if (useScratch) {
        ctx.fillStyle = scratch.revealColor
        ctx.fill()
        // Re-trace for paint layer
        if (useImperfect) {
          buildImperfectPath(ctx, {
            x: obj.x, y: obj.y, w: obj.w, h: obj.h,
            cornerRadius: r,
            roughness: imperfect.roughness,
            segmentCount: imperfect.segmentCount,
            seed: obj.name,
          })
        } else {
          ctx.beginPath()
          ctx.moveTo(obj.x + r, obj.y)
          ctx.lineTo(obj.x + obj.w - r, obj.y)
          ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
          ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
          ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
          ctx.lineTo(obj.x + r, obj.y + obj.h)
          ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
          ctx.lineTo(obj.x, obj.y + r)
          ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
          ctx.closePath()
        }
        ctx.fillStyle = objSkin.fill
        ctx.fill()

        // Scratch overlay
        ctx.save()
        if (useImperfect) {
          buildImperfectPath(ctx, {
            x: obj.x, y: obj.y, w: obj.w, h: obj.h,
            cornerRadius: r,
            roughness: imperfect.roughness,
            segmentCount: imperfect.segmentCount,
            seed: obj.name,
          })
        } else {
          ctx.beginPath()
          ctx.moveTo(obj.x + r, obj.y)
          ctx.lineTo(obj.x + obj.w - r, obj.y)
          ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
          ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
          ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
          ctx.lineTo(obj.x + r, obj.y + obj.h)
          ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
          ctx.lineTo(obj.x, obj.y + r)
          ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
          ctx.closePath()
        }
        ctx.clip()
        drawScratchOverlay(
          ctx,
          obj.x, obj.y, obj.w, obj.h,
          obj.name,
          scratch.scratchCount,
          scratch.scratchOpacity,
          scratch.scratchWidth,
          scratch.revealColor,
        )
        ctx.restore()
      } else if (r > 0) {
        ctx.fillStyle = objSkin.fill
        ctx.fill()
      } else {
        ctx.fillStyle = objSkin.fill
        ctx.fillRect(obj.x, obj.y, obj.w, obj.h)
      }

      ctx.shadowColor = 'transparent'

      const hasDoubleStroke = skin.renderStyle.doubleStroke?.enabled
      const hasChromatic = skin.renderStyle.chromaticAberration?.enabled

      // Border — skip normal stroke when double-stroke or chromatic aberration is active
      if (!hasDoubleStroke && !hasChromatic) {
        ctx.strokeStyle = objSkin.stroke
        ctx.lineWidth = objSkin.strokeWidth
        if (r > 0) {
          ctx.stroke()
        } else {
          ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
        }
      }

      // Chromatic aberration (cyberpunk skin) — cyan left, yellow right, primary centered
      if (hasChromatic && !hasDoubleStroke) {
        const ca = skin.renderStyle.chromaticAberration!
        const primaryLineWidth = objSkin.strokeWidth

        // Cyan offset left
        ctx.save()
        ctx.strokeStyle = objSkin.stroke
        ctx.lineWidth = primaryLineWidth
        ctx.translate(-ca.offset, 0)
        ctx.globalAlpha = 0.6
        if (r > 0) {
          ctx.stroke()
        } else {
          ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
        }
        ctx.restore()

        // Yellow offset right
        ctx.save()
        ctx.strokeStyle = ca.secondaryColor
        ctx.lineWidth = primaryLineWidth
        ctx.translate(ca.offset, 0)
        ctx.globalAlpha = 0.5
        if (r > 0) {
          ctx.stroke()
        } else {
          ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
        }
        ctx.restore()

        // Primary centered
        ctx.save()
        ctx.strokeStyle = objSkin.stroke
        ctx.lineWidth = primaryLineWidth
        ctx.globalAlpha = 0.9
        if (r > 0) {
          ctx.stroke()
        } else {
          ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
        }
        ctx.restore()
      }

      // Double border — cyberpunk (colored + offset) or graffiti (rotated)
      if (hasDoubleStroke) {
        const ds = skin.renderStyle.doubleStroke!
        const isCyberpunkDouble = ds.outerColor || ds.innerColor
        const offset = ds.offset ?? 2
        const cx = obj.x + obj.w / 2
        const cy = obj.y + obj.h / 2

        if (isCyberpunkDouble) {
          // Outer (yellow) — offset up-left
          ctx.save()
          ctx.strokeStyle = ds.outerColor || objSkin.stroke
          ctx.lineWidth = ds.outerWidth
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.translate(-offset * 0.5, -offset * 0.5)
          if (r > 0) {
            ctx.beginPath()
            ctx.moveTo(obj.x + r, obj.y)
            ctx.lineTo(obj.x + obj.w - r, obj.y)
            ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
            ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
            ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
            ctx.lineTo(obj.x + r, obj.y + obj.h)
            ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
            ctx.lineTo(obj.x, obj.y + r)
            ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
            ctx.closePath()
            ctx.stroke()
          } else {
            ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
          }
          ctx.restore()

          // Inner (cyan) — offset down-right
          ctx.save()
          ctx.strokeStyle = ds.innerColor || objSkin.stroke
          ctx.lineWidth = ds.innerWidth
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.translate(offset * 0.5, offset * 0.5)
          if (r > 0) {
            ctx.beginPath()
            ctx.moveTo(obj.x + r, obj.y)
            ctx.lineTo(obj.x + obj.w - r, obj.y)
            ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
            ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
            ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
            ctx.lineTo(obj.x + r, obj.y + obj.h)
            ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
            ctx.lineTo(obj.x, obj.y + r)
            ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
            ctx.closePath()
            ctx.stroke()
          } else {
            ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
          }
          ctx.restore()
        } else {
          // Graffiti sketch-style — inner + outer, both rotated differently
          // Inner border — exact object size, clockwise rotation
          ctx.save()
          ctx.strokeStyle = objSkin.stroke
          ctx.lineWidth = ds.innerWidth
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.translate(cx, cy)
          ctx.rotate(0.008)
          ctx.translate(-cx, -cy)
          if (r > 0) {
            ctx.beginPath()
            ctx.moveTo(obj.x + r, obj.y)
            ctx.lineTo(obj.x + obj.w - r, obj.y)
            ctx.arcTo(obj.x + obj.w, obj.y, obj.x + obj.w, obj.y + r, r)
            ctx.lineTo(obj.x + obj.w, obj.y + obj.h - r)
            ctx.arcTo(obj.x + obj.w, obj.y + obj.h, obj.x + obj.w - r, obj.y + obj.h, r)
            ctx.lineTo(obj.x + r, obj.y + obj.h)
            ctx.arcTo(obj.x, obj.y + obj.h, obj.x, obj.y + obj.h - r, r)
            ctx.lineTo(obj.x, obj.y + r)
            ctx.arcTo(obj.x, obj.y, obj.x + r, obj.y, r)
            ctx.closePath()
            ctx.stroke()
          } else {
            ctx.strokeRect(obj.x, obj.y, obj.w, obj.h)
          }
          ctx.restore()

          // Outer border — 1.5px larger with stronger counter-clockwise rotation
          ctx.save()
          ctx.strokeStyle = objSkin.stroke
          ctx.lineWidth = ds.outerWidth
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.translate(cx, cy)
          ctx.rotate(-0.012)
          ctx.translate(-cx, -cy)
          const outPad = 1.5
          const outR = Math.max(0, r + 1)
          if (r > 0) {
            ctx.beginPath()
            ctx.moveTo(obj.x - outPad + outR, obj.y - outPad)
            ctx.lineTo(obj.x + obj.w + outPad - outR, obj.y - outPad)
            ctx.arcTo(obj.x + obj.w + outPad, obj.y - outPad, obj.x + obj.w + outPad, obj.y - outPad + outR, outR)
            ctx.lineTo(obj.x + obj.w + outPad, obj.y + obj.h + outPad - outR)
            ctx.arcTo(obj.x + obj.w + outPad, obj.y + obj.h + outPad, obj.x + obj.w + outPad - outR, obj.y + obj.h + outPad, outR)
            ctx.lineTo(obj.x - outPad + outR, obj.y + obj.h + outPad)
            ctx.arcTo(obj.x - outPad, obj.y + obj.h + outPad, obj.x - outPad, obj.y + obj.h + outPad - outR, outR)
            ctx.lineTo(obj.x - outPad, obj.y - outPad + outR)
            ctx.arcTo(obj.x - outPad, obj.y - outPad, obj.x - outPad + outR, obj.y - outPad, outR)
            ctx.closePath()
            ctx.stroke()
          } else {
            ctx.strokeRect(obj.x - outPad, obj.y - outPad, obj.w + outPad * 2, obj.h + outPad * 2)
          }
          ctx.restore()
        }
      }
    }

    // Icon
    ctx.fillStyle = objSkin.icon
    const iconY = obj.y + 14
    if (obj.type === 'actor') {
      // Stick figure for actor
      ctx.beginPath()
      ctx.arc(obj.x + obj.w / 2, iconY - 2, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(obj.x + obj.w / 2, iconY + 2)
      ctx.lineTo(obj.x + obj.w / 2, iconY + 10)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(obj.x + obj.w / 2 - 4, iconY + 5)
      ctx.lineTo(obj.x + obj.w / 2 + 4, iconY + 5)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(obj.x + obj.w / 2 - 3, iconY + 10)
      ctx.lineTo(obj.x + obj.w / 2, iconY + 7)
      ctx.lineTo(obj.x + obj.w / 2 + 3, iconY + 10)
      ctx.stroke()
      // (store is drawn + `continue`d above as a database cylinder)
    } else {
      ctx.beginPath()
      ctx.arc(obj.x + obj.w / 2, iconY, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold 7px ${skin.renderStyle.fontFamily || 'sans-serif'}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('S', obj.x + obj.w / 2, iconY)
    }

    // Name
    ctx.fillStyle = objSkin.text
    ctx.font = `600 ${Math.min(10, obj.w / 6)}px ${skin.renderStyle.fontFamily || 'Inter'}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(obj.name, obj.x + obj.w / 2, obj.y + 26)
  }

  ctx.restore()
}
