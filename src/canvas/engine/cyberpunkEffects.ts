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
 * Helpers for cyberpunk grunge / scratch-paint effects on Canvas 2D.
 * All noise is deterministic (seeded by object id) so shapes don't flicker.
 *
 * The seeded PRNG lives in `plugins/sdk/rng.ts` (the engine-canonical generator
 * shared with theme plugins). Algorithm unchanged — see that file.
 */
import { createRng } from '../../plugins/sdk/rng'

export interface ImperfectRectOptions {
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  roughness: number
  segmentCount: number
  seed: string
}

export interface ScratchPaintOptions {
  ctx: CanvasRenderingContext2D
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  seed: string
  scratchCount: number
  scratchOpacity: number
  scratchWidth: number
  revealColor: string
  fillColor: string
  roughness: number
  segmentCount: number
}

// --- Imperfect rounded rectangle path ---

/**
 * Build an irregular rounded-rect path on the current canvas context.
 * The border is subdivided into small segments and each vertex is nudged
 * by a deterministic pseudo-random amount.
 */
export function buildImperfectPath(
  ctx: CanvasRenderingContext2D,
  opts: ImperfectRectOptions
): void {
  const { x, y, w, h, cornerRadius, roughness, segmentCount, seed } = opts
  const rng = createRng(seed)

  // Helper to get a corner arc start/end angles
  const corners = [
    { cx: x + w - cornerRadius, cy: y + cornerRadius, startAngle: -Math.PI / 2, endAngle: 0 },
    { cx: x + w - cornerRadius, cy: y + h - cornerRadius, startAngle: 0, endAngle: Math.PI / 2 },
    { cx: x + cornerRadius, cy: y + h - cornerRadius, startAngle: Math.PI / 2, endAngle: Math.PI },
    { cx: x + cornerRadius, cy: y + cornerRadius, startAngle: Math.PI, endAngle: -Math.PI / 2 },
  ]

  // Build points around the perimeter: 4 sides + 4 corner arcs
  const points: { x: number; y: number }[] = []

  // Top side (left to right, excluding corners)
  for (let i = 1; i <= segmentCount; i++) {
    const t = i / (segmentCount + 1)
    const px = x + cornerRadius + t * (w - 2 * cornerRadius)
    const py = y
    points.push({
      x: px + (rng() - 0.5) * roughness * 2,
      y: py + (rng() - 0.5) * roughness * 2,
    })
  }

  // Top-right corner arc
  {
    const c = corners[0]
    const arcSegs = Math.max(3, Math.floor(segmentCount * 0.5))
    for (let i = 1; i <= arcSegs; i++) {
      const t = i / (arcSegs + 1)
      const angle = c.startAngle + t * (c.endAngle - c.startAngle)
      points.push({
        x: c.cx + Math.cos(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
        y: c.cy + Math.sin(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
      })
    }
  }

  // Right side
  for (let i = 1; i <= segmentCount; i++) {
    const t = i / (segmentCount + 1)
    const px = x + w
    const py = y + cornerRadius + t * (h - 2 * cornerRadius)
    points.push({
      x: px + (rng() - 0.5) * roughness * 2,
      y: py + (rng() - 0.5) * roughness * 2,
    })
  }

  // Bottom-right corner arc
  {
    const c = corners[1]
    const arcSegs = Math.max(3, Math.floor(segmentCount * 0.5))
    for (let i = 1; i <= arcSegs; i++) {
      const t = i / (arcSegs + 1)
      const angle = c.startAngle + t * (c.endAngle - c.startAngle)
      points.push({
        x: c.cx + Math.cos(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
        y: c.cy + Math.sin(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
      })
    }
  }

  // Bottom side
  for (let i = 1; i <= segmentCount; i++) {
    const t = i / (segmentCount + 1)
    const px = x + w - cornerRadius - t * (w - 2 * cornerRadius)
    const py = y + h
    points.push({
      x: px + (rng() - 0.5) * roughness * 2,
      y: py + (rng() - 0.5) * roughness * 2,
    })
  }

  // Bottom-left corner arc
  {
    const c = corners[2]
    const arcSegs = Math.max(3, Math.floor(segmentCount * 0.5))
    for (let i = 1; i <= arcSegs; i++) {
      const t = i / (arcSegs + 1)
      const angle = c.startAngle + t * (c.endAngle - c.startAngle)
      points.push({
        x: c.cx + Math.cos(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
        y: c.cy + Math.sin(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
      })
    }
  }

  // Left side
  for (let i = 1; i <= segmentCount; i++) {
    const t = i / (segmentCount + 1)
    const px = x
    const py = y + h - cornerRadius - t * (h - 2 * cornerRadius)
    points.push({
      x: px + (rng() - 0.5) * roughness * 2,
      y: py + (rng() - 0.5) * roughness * 2,
    })
  }

  // Top-left corner arc
  {
    const c = corners[3]
    const arcSegs = Math.max(3, Math.floor(segmentCount * 0.5))
    for (let i = 1; i <= arcSegs; i++) {
      const t = i / (arcSegs + 1)
      const angle = c.startAngle + t * (c.endAngle - c.startAngle)
      points.push({
        x: c.cx + Math.cos(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
        y: c.cy + Math.sin(angle) * cornerRadius + (rng() - 0.5) * roughness * 2,
      })
    }
  }

  // Draw path
  if (points.length === 0) {
    ctx.rect(x, y, w, h)
    return
  }

  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y)
  }
  ctx.closePath()
}

// --- Scratch paint effect ---

/**
 * Draw scratch overlay inside the current clipping region.
 * Call after `ctx.clip()` so scratches only affect the shape interior.
 * Assumes the background is already filled with the paint color.
 */
export function drawScratchOverlay(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: string,
  scratchCount: number,
  scratchOpacity: number,
  scratchWidth: number,
  revealColor: string
): void {
  const rng = createRng(seed + '-scratch')

  ctx.save()
  ctx.globalAlpha = scratchOpacity
  ctx.strokeStyle = revealColor
  ctx.fillStyle = revealColor
  ctx.lineCap = 'butt'

  const margin = 4

  // --- Main scratch lines (horizontal bands) — biased to edges ---
  ctx.lineWidth = scratchWidth
  const bandCount = Math.floor(scratchCount * 0.6)
  for (let i = 0; i < bandCount; i++) {
    // Create clusters: 2-4 scratches close together
    const clusterSize = 2 + Math.floor(rng() * 3)
    // Bias Y toward edges (top 30% or bottom 30%)
    const edgeBias = rng()
    let baseY: number
    if (edgeBias < 0.35) {
      baseY = y + margin + rng() * (h * 0.25)
    } else if (edgeBias < 0.7) {
      baseY = y + h - margin - rng() * (h * 0.25)
    } else {
      baseY = y + margin + rng() * (h - margin * 2)
    }
    const baseAngle = (rng() - 0.5) * 0.3 // very close to horizontal
    const length = 12 + rng() * 28

    for (let j = 0; j < clusterSize; j++) {
      const sx = x + margin + rng() * (w - margin * 2)
      const sy = baseY + (rng() - 0.5) * 3 // slight vertical jitter within cluster
      const ex = sx + Math.cos(baseAngle) * length
      const ey = sy + Math.sin(baseAngle) * length

      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(ex, ey)
      ctx.stroke()
    }
  }

  // --- Secondary scratches (shorter, more random) ---
  ctx.lineWidth = Math.max(0.5, scratchWidth * 0.6)
  for (let i = 0; i < Math.floor(scratchCount * 0.25); i++) {
    const sx = x + margin + rng() * (w - margin * 2)
    const sy = y + margin + rng() * (h - margin * 2)
    const length = 3 + rng() * 10
    const angle = (rng() - 0.5) * Math.PI * 0.5
    const ex = sx + Math.cos(angle) * length
    const ey = sy + Math.sin(angle) * length

    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(ex, ey)
    ctx.stroke()
  }

  // --- Small chip patches (polygons) ---
  for (let i = 0; i < Math.floor(scratchCount * 0.3); i++) {
    const cx = x + margin + rng() * (w - margin * 2)
    const cy = y + margin + rng() * (h - margin * 2)
    const size = 1.5 + rng() * 3.5

    ctx.beginPath()
    ctx.moveTo(cx + size, cy)
    ctx.lineTo(cx + size * 0.3, cy + size)
    ctx.lineTo(cx - size * 0.7, cy + size * 0.4)
    ctx.lineTo(cx - size * 0.2, cy - size * 0.6)
    ctx.closePath()
    ctx.fill()
  }

  // --- Fine particles / dust ---
  ctx.lineWidth = scratchWidth * 0.4
  for (let i = 0; i < Math.floor(scratchCount * 0.8); i++) {
    const px = x + margin + rng() * (w - margin * 2)
    const py = y + margin + rng() * (h - margin * 2)
    const pSize = 0.5 + rng() * 1.5
    // horizontal dash
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(px + pSize, py)
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * Draw a shape with a "scratched paint" look (self-contained).
 * 1. Base layer in revealColor (the colour underneath)
 * 2. Top layer in fillColor (the paint)
 * 3. Random scratch lines in revealColor to simulate peeled paint
 */
export function applyScratchPaint(opts: ScratchPaintOptions): void {
  const {
    ctx,
    x,
    y,
    w,
    h,
    cornerRadius,
    seed,
    scratchCount,
    scratchOpacity,
    scratchWidth,
    revealColor,
    fillColor,
    roughness,
    segmentCount,
  } = opts

  // Step 1: build imperfect path and fill with revealColor (the under-layer)
  buildImperfectPath(ctx, { x, y, w, h, cornerRadius, roughness, segmentCount, seed })
  ctx.fillStyle = revealColor
  ctx.fill()

  // Step 2: fill with the paint color (yellow)
  buildImperfectPath(ctx, { x, y, w, h, cornerRadius, roughness, segmentCount, seed })
  ctx.fillStyle = fillColor
  ctx.fill()

  // Step 3: draw scratches in revealColor on top, clipped to shape
  ctx.save()
  buildImperfectPath(ctx, { x, y, w, h, cornerRadius, roughness, segmentCount, seed })
  ctx.clip()
  drawScratchOverlay(ctx, x, y, w, h, seed, scratchCount, scratchOpacity, scratchWidth, revealColor)
  ctx.restore()
}

// --- Group HUD style helpers ---

/**
 * Draw four corner "L" brackets (crosshair style) around a rectangle.
 */
export function drawCornerBrackets(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  size: number,
  thickness: number,
  inset: number
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = thickness
  ctx.lineCap = 'square'
  ctx.lineJoin = 'miter'

  const ix = x + inset
  const iy = y + inset
  const iw = w - inset * 2
  const ih = h - inset * 2

  // Top-left
  ctx.beginPath()
  ctx.moveTo(ix + size, iy)
  ctx.lineTo(ix, iy)
  ctx.lineTo(ix, iy + size)
  ctx.stroke()

  // Top-right
  ctx.beginPath()
  ctx.moveTo(ix + iw - size, iy)
  ctx.lineTo(ix + iw, iy)
  ctx.lineTo(ix + iw, iy + size)
  ctx.stroke()

  // Bottom-left
  ctx.beginPath()
  ctx.moveTo(ix, iy + ih - size)
  ctx.lineTo(ix, iy + ih)
  ctx.lineTo(ix + size, iy + ih)
  ctx.stroke()

  // Bottom-right
  ctx.beginPath()
  ctx.moveTo(ix + iw, iy + ih - size)
  ctx.lineTo(ix + iw, iy + ih)
  ctx.lineTo(ix + iw - size, iy + ih)
  ctx.stroke()

  ctx.restore()
}

/**
 * Draw a textured semi-transparent fill for cyberpunk groups.
 * Includes fine horizontal scan-line texture.
 */
export function drawGroupTexturedFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  baseColor: string,
  seed: string
): void {
  const rng = createRng(seed + '-group')

  ctx.save()

  // Base tinted fill
  ctx.fillStyle = baseColor
  ctx.fill()

  // Scan-line texture
  ctx.globalAlpha = 0.08
  ctx.strokeStyle = '#fff000'
  ctx.lineWidth = 0.5

  const lineSpacing = 3 + rng() * 3
  for (let ly = y + 2; ly < y + h - 2; ly += lineSpacing) {
    if (rng() > 0.6) continue // random gaps
    const segStart = x + 4 + rng() * (w * 0.3)
    const segEnd = x + w - 4 - rng() * (w * 0.3)
    ctx.beginPath()
    ctx.moveTo(segStart, ly)
    ctx.lineTo(segEnd, ly)
    ctx.stroke()
  }

  // Random small noise dots
  ctx.globalAlpha = 0.06
  ctx.fillStyle = '#52bedc'
  for (let i = 0; i < 15; i++) {
    const dx = x + 4 + rng() * (w - 8)
    const dy = y + 4 + rng() * (h - 8)
    const dSize = 0.5 + rng() * 1.5
    ctx.fillRect(dx, dy, dSize, dSize)
  }

  ctx.restore()
}
