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
 * Shared low-level box-drawing primitives used by the engine's default object
 * rendering and by the official theme plugins' `object` hooks. Extracted so the
 * themed box draws live in the plugins without duplicating the path geometry.
 *
 * These take a real CanvasRenderingContext2D (the trusted-tier `Draw` surface IS
 * a real ctx, so plugins pass it straight through).
 */

/** Build the canonical rounded-rect path (matches the engine's inline arcTo sequence). */
export function buildRoundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

export interface ObjectAccentBox {
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  isStore: boolean
}

export type GroupAccentBox = Omit<ObjectAccentBox, 'isStore'>

/** Constrain a group perspective accent to the group's canonical rounded box. */
export function clipGroupAccentToBox(
  ctx: CanvasRenderingContext2D,
  box: GroupAccentBox,
): void {
  const { x, y, w, h, cornerRadius } = box
  buildRoundRectPath(ctx, x, y, w, h, cornerRadius)
  ctx.clip()
}

/**
 * Constrain a perspective accent to the canonical object silhouette. The accent
 * is intentionally painted after the object contents, but it must use the same
 * final geometry as the box (including pixel-snapped coordinates) or its lower
 * corners visibly overhang at high canvas zoom.
 */
export function clipObjectAccentToBox(
  ctx: CanvasRenderingContext2D,
  box: ObjectAccentBox,
): void {
  const { x, y, w, h, cornerRadius, isStore } = box
  if (isStore) {
    buildCylinderPath(ctx, x, y, w, h, storeCapRy(w, h))
  } else {
    buildRoundRectPath(ctx, x, y, w, h, cornerRadius)
  }
  ctx.clip()
}

/**
 * Stroke the current path with a selection glow (used by group selection
 * highlight). Sets a glow shadow, strokes, then clears the shadow — exactly the
 * sequence the engine used inline.
 */
export function strokeSelectionGlow(
  ctx: CanvasRenderingContext2D,
  glowColor: string,
  blur: number,
): void {
  ctx.shadowColor = glowColor
  ctx.shadowBlur = blur
  ctx.shadowOffsetY = 0
  ctx.shadowOffsetX = 0
  ctx.stroke()
  ctx.shadowColor = 'transparent'
}

/**
 * Depth (px) of the elliptical caps on a store/database cylinder, derived from
 * the object's size so the drum reads correctly at any dimension. Clamped so the
 * caps never collapse on tiny nodes nor eat the whole body on large/short ones.
 * Every box path (engine default + theme hooks + shop preview) calls this so the
 * silhouette is identical everywhere.
 */
export function storeCapRy(w: number, h: number): number {
  return Math.max(4, Math.min(6, w * 0.1, h * 0.13))
}

/**
 * Build the closed outline of a database "cylinder" (drum) that fills the box
 * {x,y,w,h}: vertical sides, a front-bulging bottom curve, and a top rim that
 * bulges up to `y`. Fill + stroke this for the body; draw {@link strokeStoreLid}
 * on top for the 3-D lid seam. `capRy` is the ellipse depth (see storeCapRy).
 */
export function buildCylinderPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  capRy: number,
): void {
  const rx = w / 2
  const cx = x + rx
  const topCy = y + capRy
  const botCy = y + h - capRy
  ctx.beginPath()
  ctx.moveTo(x, topCy)
  ctx.lineTo(x, botCy)
  // Bottom front (lower) half-ellipse, left → right, bulging down to y+h.
  ctx.ellipse(cx, botCy, rx, capRy, 0, Math.PI, 0, true)
  ctx.lineTo(x + w, topCy)
  // Top rim upper half-ellipse, right → left, bulging up to y.
  ctx.ellipse(cx, topCy, rx, capRy, 0, 0, Math.PI, true)
  ctx.closePath()
}

/**
 * Stroke the front (lower) arc of the top rim — the seam that makes the cylinder
 * read as a 3-D lid. Caller sets strokeStyle / lineWidth first. Optionally fills
 * the lid disc with `lidFill` for a subtle top highlight before the seam.
 */
export function strokeStoreLid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  capRy: number,
  lidFill?: string,
): void {
  const rx = w / 2
  const cx = x + rx
  const topCy = y + capRy
  if (lidFill) {
    ctx.beginPath()
    ctx.ellipse(cx, topCy, rx, capRy, 0, 0, Math.PI * 2)
    ctx.fillStyle = lidFill
    ctx.fill()
  }
  ctx.beginPath()
  ctx.ellipse(cx, topCy, rx, capRy, 0, 0, Math.PI, false)
  ctx.stroke()
}

/** Blend a #RRGGBB color toward white by `amt` (0..1). Returns the input
 * unchanged if it isn't a 6-digit hex (e.g. rgba/named colors). */
export function lightenHex(hex: string, amt: number): string {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16)
    return Math.round(c + (255 - c) * amt).toString(16).padStart(2, '0')
  }
  return `#${ch(1)}${ch(3)}${ch(5)}`
}

/**
 * 8-bit pixel-art database cylinder. The top lid is a real stepped pixel ELLIPSE
 * (both the back rim and the front lip curve, like the smooth themes' top disc) —
 * not a flat line — filled in a lighter shade so it reads as a drum lid. Straight
 * body walls and a stepped front bottom bulge complete the drum. The pixel-art
 * reading of {@link buildCylinderPath}.
 */
export function drawPixelArtCylinder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  shadowColor: string,
  pixelSize: number = 2,
): void {
  const p = pixelSize
  const snap = (v: number) => Math.round(v / p) * p
  const sx = snap(x)
  const sy = snap(y)
  const sw = snap(w)
  const sh = snap(h)
  const rx = sw / 2
  const cx = sx + rx
  // Ellipse depth (≥3 pixel rows so the curve is legible). The lid is the FULL
  // ellipse (2·ry tall, widest at its centre y+ry); the base shows its front half.
  const ry = Math.max(p * 3, snap(storeCapRy(sw, sh)))
  const lid = lightenHex(fill, 0.6)
  const bodyTop = sy + ry
  const bodyBottom = sy + sh - ry
  // Half-width of the cap ellipse at vertical distance `dy` from its centre.
  const hw = (dy: number) => {
    const k = 1 - (dy * dy) / (ry * ry)
    return k <= 0 ? 0 : snap(rx * Math.sqrt(k))
  }
  // Draw a pixel ellipse band centred at `cyc`, dy ∈ [loDy, hiDy]: a solid `inner`
  // fill, then a CONNECTED 1px stroke outline (start/end caps, side edges, and
  // horizontal connectors across each width step) so the rim fully encloses the
  // fill with no scattered pixels — a clean pixel-art oval at any aspect. Used for
  // the lid (the body+base trace their own continuous silhouette below).
  const oval = (cyc: number, inner: string, loDy: number, hiDy: number) => {
    ctx.fillStyle = inner
    for (let dy = loDy; dy <= hiDy; dy += p) {
      const ww = hw(dy)
      if (ww > 0) ctx.fillRect(cx - ww, cyc + dy, ww * 2, p)
    }
    ctx.fillStyle = stroke
    let prevW = -1
    let prevY = 0
    for (let dy = loDy; dy <= hiDy + p; dy += p) {
      const ww = dy <= hiDy ? hw(dy) : 0
      const yr = cyc + dy
      if (ww <= 0) {
        if (prevW > 0) ctx.fillRect(cx - prevW, prevY, prevW * 2, p) // end cap
        prevW = -1
        continue
      }
      if (prevW < 0) {
        ctx.fillRect(cx - ww, yr, ww * 2, p) // start cap
      } else {
        ctx.fillRect(cx - ww, yr, p, p)
        ctx.fillRect(cx + ww - p, yr, p, p)
        if (ww !== prevW) {
          const lo = Math.min(ww, prevW)
          const hi = Math.max(ww, prevW)
          ctx.fillRect(cx - hi, yr, hi - lo + p, p)
          ctx.fillRect(cx + lo - p, yr, hi - lo + p, p)
        }
      }
      prevW = ww
      prevY = yr
    }
  }

  // Straight body (one solid rect — NO per-row bands, so no faint seam lines at
  // scale) down to the base, then the front bulge narrowing to the bottom. The
  // base arc is the only per-row part (small, at the very bottom).
  const ox = p * 2
  const oy = p * 3
  const bottom = sy + sh
  const straightH = bodyBottom - bodyTop

  // Drop shadow: straight block + tapering base, offset. Each base row overlaps
  // the previous by one step (drawn 2·p tall from yr−p) so there are no seam gaps
  // between the bands at scale; the narrower lower rows hide behind the wider ones
  // above, leaving the taper unchanged.
  ctx.fillStyle = shadowColor
  ctx.fillRect(sx + ox, bodyTop + oy, sw, straightH)
  for (let yr = bodyBottom; yr < bottom; yr += p) {
    const ww = hw(yr - bodyBottom)
    if (ww > 0) ctx.fillRect(cx - ww + ox, yr - p + oy, ww * 2, p * 2)
  }
  // Fill: straight block + tapering base (overlapping rows, see above).
  ctx.fillStyle = fill
  ctx.fillRect(sx, bodyTop, sw, straightH)
  for (let yr = bodyBottom; yr < bottom; yr += p) {
    const ww = hw(yr - bodyBottom)
    if (ww > 0) ctx.fillRect(cx - ww, yr - p, ww * 2, p * 2)
  }
  // Outline: straight side walls (rects) joined at bodyBottom to the stepped base
  // arc, so the border is continuous with no corner gap and no seam line.
  ctx.fillStyle = stroke
  ctx.fillRect(sx, bodyTop, p, straightH) // left wall
  ctx.fillRect(sx + sw - p, bodyTop, p, straightH) // right wall
  let bodyPrevW = rx
  for (let yr = bodyBottom; yr <= bottom; yr += p) {
    const ww = yr < bottom ? hw(yr - bodyBottom) : 0
    if (ww <= 0) {
      if (bodyPrevW > 0) ctx.fillRect(cx - bodyPrevW, yr - p, bodyPrevW * 2, p) // bottom tip cap
      break
    }
    ctx.fillRect(cx - ww, yr, p, p)
    ctx.fillRect(cx + ww - p, yr, p, p)
    if (ww !== bodyPrevW) {
      const lo = Math.min(ww, bodyPrevW)
      const hi = Math.max(ww, bodyPrevW)
      ctx.fillRect(cx - hi, yr, hi - lo + p, p)
      ctx.fillRect(cx + lo - p, yr, hi - lo + p, p)
    }
    bodyPrevW = ww
  }

  // Lid — a full outlined pixel ellipse in the lighter shade, drawn last so it
  // sits cleanly on top of the body (its lower arc reads as the drum's front lip).
  oval(bodyTop, lid, -ry, ry)
}

/**
 * 8-bit pixel-art rectangle: drop shadow, 3-strip fill (chamfered corners),
 * 4-segment border with stepped bevels, inset highlight/shadow. Moved verbatim
 * from CanvasEngine.drawPixelArtRect.
 */
export function drawPixelArtRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  shadowColor: string,
  pixelSize: number = 2,
): void {
  const borderW = pixelSize * 2
  const shadowOffX = pixelSize * 2
  const shadowOffY = pixelSize * 3

  // Drop shadow
  ctx.fillStyle = shadowColor
  ctx.fillRect(x + shadowOffX, y + shadowOffY, w, h)

  // Main fill — 3 strips to leave corner chamfers transparent
  ctx.fillStyle = fill
  ctx.fillRect(x + borderW, y, w - borderW * 2, h)
  ctx.fillRect(x, y + borderW, borderW, h - borderW * 2)
  ctx.fillRect(x + w - borderW, y + borderW, borderW, h - borderW * 2)

  // Outer border — 4 segments with stepped bevel corners
  ctx.fillStyle = stroke
  const bd = borderW
  ctx.fillRect(x + bd, y, w - bd * 2, bd)
  ctx.fillRect(x + bd, y + h - bd, w - bd * 2, bd)
  ctx.fillRect(x, y + bd, bd, h - bd * 2)
  ctx.fillRect(x + w - bd, y + bd, bd, h - bd * 2)

  // Stepped corner fills for pixel-art bevel look
  const step = pixelSize
  ctx.fillRect(x + bd - step, y + bd - step, step, step)
  ctx.fillRect(x + w - bd, y + bd - step, step, step)
  ctx.fillRect(x + bd - step, y + h - bd, step, step)
  ctx.fillRect(x + w - bd, y + h - bd, step, step)

  // Inset highlight (top)
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.fillRect(x + borderW, y + borderW, w - borderW * 2, pixelSize)

  // Inset shadow (bottom)
  ctx.fillStyle = 'rgba(0,0,0,0.15)'
  ctx.fillRect(x + borderW, y + h - borderW - pixelSize, w - borderW * 2, pixelSize)
}
