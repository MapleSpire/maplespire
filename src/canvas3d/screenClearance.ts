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
 * Screen-space truth for the board's text (pure math — no three).
 *
 * QUALITY PASS "labels" (tp-final-dpr1/workbench-wide.png, both
 * backgrounds): 'evaluates' sat on Alert manager's front wall and 'queries'
 * between Query API and Web console at the default framing. Every placement
 * rule upstream (connLabelPlacement's apparent zones, labelLegibility's growth
 * obstacles) reasons on the BOARD plane with an orthographic approximation of
 * the preset view, and the growth step ignores an obstacle a label already
 * touches at k = 1 — so nothing ever looked at where the plate and the card
 * actually land on screen. These helpers do: the caller projects the plate's
 * four corners and each node's solid through the default-framing camera, and
 * a plate is clear of a node when their convex hulls are apart.
 */

export interface Pt {
  x: number
  y: number
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up frame;
 * collinear points dropped. Fewer than 3 distinct points come back as they
 * are (a point or a segment is still a valid SAT shape). */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const uniq: Pt[] = []
  for (const p of pts) {
    const last = uniq[uniq.length - 1]
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) uniq.push(p)
  }
  if (uniq.length < 3) return uniq
  const lower: Pt[] = []
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** The separating-axis candidates of a convex polygon: its edge normals (a
 * segment contributes its direction and its normal, a point nothing), each
 * normalised, flat [x0, y0, x1, y1, …]; degenerate (zero-length) axes are
 * dropped. */
function computeAxes(poly: readonly Pt[]): Float64Array {
  const raw: number[] = []
  if (poly.length === 2) {
    const dx = poly[1].x - poly[0].x
    const dy = poly[1].y - poly[0].y
    raw.push(dx, dy, -dy, dx)
  } else if (poly.length > 2) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      raw.push(-(b.y - a.y), b.x - a.x)
    }
  }
  const out: number[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const len = Math.hypot(raw[i], raw[i + 1])
    if (len < 1e-12) continue
    out.push(raw[i] / len, raw[i + 1] / len)
  }
  return Float64Array.from(out)
}

/** Axes per polygon ARRAY: the label passes test one plate against the same
 * node and plate hulls thousands of times per build (the on-wire search and
 * the hidden-label fallback: convexGap was 554 of 1008 ms of the pass on
 * 0ob3fum, connect-freeze profile 2026-10-11). Hulls are never mutated once
 * built (convexHull returns a fresh array). */
const axesCache = new WeakMap<readonly Pt[], Float64Array>()
function axesOf(poly: readonly Pt[]): Float64Array {
  let ax = axesCache.get(poly)
  if (!ax) {
    ax = computeAxes(poly)
    axesCache.set(poly, ax)
  }
  return ax
}

/** The gap of `a` and `b` along unit axis (nx, ny): >= 0 apart by that much,
 * < 0 overlapping. */
function axisGap(a: readonly Pt[], b: readonly Pt[], nx: number, ny: number): number {
  let a0 = Infinity
  let a1 = -Infinity
  let b0 = Infinity
  let b1 = -Infinity
  for (let i = 0; i < a.length; i++) {
    const d = a[i].x * nx + a[i].y * ny
    if (d < a0) a0 = d
    if (d > a1) a1 = d
  }
  for (let i = 0; i < b.length; i++) {
    const d = b[i].x * nx + b[i].y * ny
    if (d < b0) b0 = d
    if (d > b1) b1 = d
  }
  return Math.max(b0 - a1, a0 - b1)
}

/**
 * The widest gap (px) between two convex polygons along any separating axis
 * — negative when they overlap (then it is minus the smallest penetration).
 * Exact for convex shapes (separating-axis theorem); the caller hulls first.
 */
export function convexGap(a: readonly Pt[], b: readonly Pt[]): number {
  if (a.length === 0 || b.length === 0) return Infinity
  let best = -Infinity
  for (const ax of [computeAxes(a), axesOf(b)]) {
    for (let i = 0; i < ax.length; i += 2) best = Math.max(best, axisGap(a, b, ax[i], ax[i + 1]))
  }
  // two points (no axes at all): their distance
  if (best === -Infinity) return Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y)
  return best
}

/** True when the two convex polygons are closer than `margin` px — exactly
 * `convexGap(a, b) < margin`, but it stops at the first axis that holds
 * them `margin` apart. */
export function convexOverlap(a: readonly Pt[], b: readonly Pt[], margin = 0): boolean {
  if (a.length === 0 || b.length === 0) return false
  let any = false
  for (const ax of [axesOf(b), computeAxes(a)]) {
    for (let i = 0; i < ax.length; i += 2) {
      any = true
      if (axisGap(a, b, ax[i], ax[i + 1]) >= margin) return false
    }
  }
  if (!any) return Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) < margin
  return true
}

/**
 * A flat plaque (axis-aligned board rect `w` x `h`) set IN FRONT of a
 * standing cylinder of `radius` centred at (cx, cz), as seen from a camera at
 * `azimuthDeg` (the board direction toward it is (sin az, cos az)): centred
 * on that ray, every corner past the cylinder's front tangent line by `gap`.
 * A flat point nearer the camera than a standing cylinder's front is never
 * hidden by it, and none of the plaque sits beside its foot. Returns the
 * rect's top-left + size. (Quality pass "labels" round 2: a drum's floor
 * tag at a fixed +z sat beside the drum at the iso azimuth, its inner end
 * under the drum's foot — Scene3D storeTagRect.)
 */
export function plaqueInFront(
  cx: number,
  cz: number,
  w: number,
  h: number,
  azimuthDeg: number,
  radius: number,
  gap: number,
): { x: number; y: number; w: number; h: number } {
  const tx = Math.sin((azimuthDeg * Math.PI) / 180)
  const ty = Math.cos((azimuthDeg * Math.PI) / 180)
  const d = radius + gap + Math.abs(tx) * (w / 2) + Math.abs(ty) * (h / 2)
  return { x: cx + d * tx - w / 2, y: cz + d * ty - h / 2, w, h }
}

type PlanRect = { x: number; y: number; w: number; h: number }

/**
 * The board area a raised box (`footprint`, `height` tall) covers ON SCREEN
 * for a camera at `polarDeg` from the zenith and `azimuthDeg`: a point at
 * height H is drawn over the floor point H·tan(polar) farther from the
 * camera, so the silhouette is the footprint swept that far away from it
 * (bounding box of the sweep, plus `margin` all round).
 */
export function screenShadowOnFloor(
  footprint: PlanRect,
  height: number,
  polarDeg: number,
  azimuthDeg: number,
  margin = 0,
): PlanRect {
  const reach = height * Math.tan((Math.min(85, Math.max(0, polarDeg)) * Math.PI) / 180)
  const dx = -Math.sin((azimuthDeg * Math.PI) / 180) * reach
  const dy = -Math.cos((azimuthDeg * Math.PI) / 180) * reach
  const x0 = Math.min(footprint.x, footprint.x + dx) - margin
  const y0 = Math.min(footprint.y, footprint.y + dy) - margin
  const x1 = Math.max(footprint.x + footprint.w, footprint.x + footprint.w + dx) + margin
  const y1 = Math.max(footprint.y + footprint.h, footprint.y + footprint.h + dy) + margin
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * `rect` slid sideways — along the board direction perpendicular to the
 * camera ray at `azimuthDeg`, so its depth toward the camera never changes —
 * by the smallest multiple of `step` (|shift| <= `maxShift`, + before −) that
 * clears every obstacle; `rect` itself when it is already clear or when no
 * shift clears. (A drum's NAME tag, restored 2026-10-10, is wider than the
 * technology tag it replaced: 'Event bus' touched the Rollup worker card on
 * screen by 0.7 px in tp4-cards/workbench-tag-0.png.)
 */
export function slideClear(
  rect: PlanRect,
  azimuthDeg: number,
  obstacles: readonly PlanRect[],
  step: number,
  maxShift: number,
): PlanRect {
  const hits = (r: PlanRect) =>
    obstacles.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h)
  if (!hits(rect)) return rect
  // the in-plane direction perpendicular to (sin az, cos az)
  const sx = Math.cos((azimuthDeg * Math.PI) / 180)
  const sy = -Math.sin((azimuthDeg * Math.PI) / 180)
  for (let n = 1; n * step <= maxShift + 1e-9; n++) {
    for (const s of [n * step, -n * step]) {
      const r = { ...rect, x: rect.x + sx * s, y: rect.y + sy * s }
      if (!hits(r)) return r
    }
  }
  return rect
}

// (badgeScale — a grow-or-hide rule for the tech badges — lived here until
// 2026-10-10, when the user rejected it with the far card titles: the
// badges keep their base size and show wherever the projected-size LOD
// keeps the node's primary content.)
