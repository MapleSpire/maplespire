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
 * The C4 "Person" silhouette — a round head resting on a body with rounded
 * shoulders — fitted INSIDE an object's box. Pure geometry, no DOM and no
 * three.js, so one definition serves every renderer: the 2D canvas (fill,
 * stroke, selection ring, low-zoom LOD), the 3D board (extruded outline), the
 * SVG export, the shop preview and the connection maths (edge points and the
 * 12 anchors), which is what keeps a connection landing ON the figure instead
 * of in the empty corners beside the head.
 *
 * The figure never leaves the box: layout, hit-testing, groups and resize keep
 * working on the unchanged w×h rectangle. A theme opts in with
 * `renderStyle.actorShape: 'person'`; every other theme keeps the card.
 */

export type ObjectSilhouette = 'person'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type Face = 'top' | 'bottom' | 'left' | 'right'

export interface EdgeHit {
  x: number
  y: number
  face: Face
}

export interface PersonGeometry {
  /** Head circle. */
  headCx: number
  headCy: number
  headR: number
  /** Body box: from the shoulder line down to the bottom of the object box. */
  bodyX: number
  bodyY: number
  bodyW: number
  bodyH: number
  /** Corner radius of the shoulders (top corners of the body). */
  shoulderR: number
  /** Corner radius of the bottom corners of the body. */
  footR: number
}

/*
 * Proportions. The target is the C4 person of the reference diagram the owner
 * supplied (measured on its 620 px export, 2026-11-07): body 161×95, head
 * ⌀77 — 0.48 × the body width, 0.81 × the body height — sunk 0.29 R into the
 * body, all four body corners ≈ 24 px (≈ 0.25 × the body height). The
 * constants below reproduce that wherever the box allows it, and give way to
 * the text where it does not (art-direction pass, same date).
 */
/** Fraction of the head radius that sinks into the body (the neck overlap). */
const HEAD_OVERLAP = 0.3
/** Head radius per box width / height. With the 0.3 overlap, `0.24 h` gives
 *  head ⌀ = 0.81 × body height; `0.235 w` gives head ⌀ = 0.47 × body width. */
const HEAD_PER_W = 0.235
const HEAD_PER_H = 0.24
const HEAD_MAX_R = 96
/** The text needs, under the chin: title 16 + one 9 px description line
 *  (10.35) + the 5 px gap + the 16 px badge with its 4 px inset ≈ 52 px. */
const TEXT_UNDER_CHIN = 52
const CHIN_GAP = 2
/** The smallest body that still holds that text block (≈ 52 + 6 top inset). */
const MIN_BODY_H = 58
/** The body is narrowed to at most 2:1 (the reference is ≈ 1.7:1, too narrow
 *  for a description at 160×100) and centred: a wide, short box keeps the
 *  figure's proportions rather than stretching it into a slab (validation
 *  pass, 2026-11-07: a 60 % width floor left 300×100 at the rejected 0.26). */
const BODY_MAX_ASPECT = 2
/** Shoulders and bottom corners round alike, as on the reference (all four
 *  corners ≈ 0.25 × the body height), within the body's width. */
const FOOT_PER_BODY_H = 0.24
const SHOULDER_PER_BODY_H = 0.27
const CORNER_PER_BODY_W = 0.15
const CORNER_MAX_R = 44
/** The gap under the chin grows with the head (2 px at the default size's
 *  head, 5 px from R ≈ 35) so a big figure's title does not touch it. */
const CHIN_GAP_PER_R = 0.25
const CHIN_GAP_MAX = 5
/** Share of a person's spare body height left above the text block. */
const TEXT_SLACK_ABOVE = 0.4

/**
 * Fit the person silhouette inside {x, y, w, h}: a head of the reference's
 * proportion, as large as the box allows while the body keeps room for the
 * title, one description line and the type badge; the body narrowed to at
 * most 2:1 and centred under the head. `reserveText: false` drops the text
 * limits, for a figure that carries no more than its name (the shop preview's
 * 70×50 sample, whose head the text rule would shrink to the 6 px floor).
 */
export function personGeometry(
  x: number,
  y: number,
  w: number,
  h: number,
  { reserveText = true }: { reserveText?: boolean } = {},
): PersonGeometry {
  const headR = clamp(
    Math.min(
      w * HEAD_PER_W,
      h * HEAD_PER_H,
      reserveText ? (h - MIN_BODY_H) / (2 - HEAD_OVERLAP) : Infinity,
      reserveText ? (h - TEXT_UNDER_CHIN - CHIN_GAP) / 2 : Infinity,
    ),
    6,
    HEAD_MAX_R,
  )
  const bodyY = y + headR * (2 - HEAD_OVERLAP)
  const bodyH = Math.max(0, y + h - bodyY)
  const bodyW = Math.min(w, bodyH * BODY_MAX_ASPECT)
  const neck = neckHalfWidth(headR, bodyY - (y + headR))
  const footR = Math.max(0, Math.min(bodyH * FOOT_PER_BODY_H, bodyW * CORNER_PER_BODY_W, CORNER_MAX_R, bodyH / 2))
  // Shoulders: generous, but they must leave a straight run between the corner
  // and the neck so the head always meets a flat shoulder line.
  const shoulderR = Math.max(
    0,
    Math.min(bodyH * SHOULDER_PER_BODY_H, bodyW * CORNER_PER_BODY_W, CORNER_MAX_R, bodyW / 2 - neck - 1, bodyH - footR),
  )
  return {
    headCx: x + w / 2,
    headCy: y + headR,
    headR,
    bodyX: x + (w - bodyW) / 2,
    bodyY,
    bodyW,
    bodyH,
    shoulderR,
    footR,
  }
}

/** Where a person's text goes: the body, inset 8 px each side (a card's
 *  `x + 8`, `w − 16`). */
export function personTextBox(g: PersonGeometry): { x: number; width: number } {
  return { x: g.bodyX + 8, width: Math.max(0, g.bodyW - 16) }
}

/** Half-width of the chord where a circle of radius `r` crosses a line `dy` below its centre. */
function neckHalfWidth(r: number, dy: number): number {
  return dy >= r ? 0 : Math.sqrt(r * r - dy * dy)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * A geometry inflated (offset > 0) or deflated (offset < 0) by `offset` px —
 * the Minkowski offset of a union is the union of the offset parts, so this is
 * exact for selection rings, focus outlines and inset borders.
 */
export function offsetPerson(g: PersonGeometry, offset: number): PersonGeometry {
  if (offset === 0) return g
  return {
    headCx: g.headCx,
    headCy: g.headCy,
    headR: Math.max(0, g.headR + offset),
    bodyX: g.bodyX - offset,
    bodyY: g.bodyY - offset,
    bodyW: Math.max(0, g.bodyW + 2 * offset),
    bodyH: Math.max(0, g.bodyH + 2 * offset),
    shoulderR: Math.max(0, g.shoulderR + offset),
    footR: Math.max(0, g.footR + offset),
  }
}

/**
 * One outline segment. `A` is a circular arc drawn with INCREASING angle
 * (clockwise on a y-down screen — canvas `arc(..., false)`, SVG sweep-flag 1).
 * Its start point is the pen position.
 */
export type OutlineSeg =
  | { kind: 'M'; x: number; y: number }
  | { kind: 'L'; x: number; y: number }
  | { kind: 'A'; cx: number; cy: number; r: number; a0: number; a1: number }
  | { kind: 'Z' }

/**
 * The closed outline of the figure (body ∪ head), clockwise from the top of
 * the left side. When an inset separates the head from the body (only for
 * insets deeper than ~15 % of the head radius) the head becomes its own closed
 * sub-path after the body.
 */
export function personOutline(g: PersonGeometry): OutlineSeg[] {
  const { headCx: hcx, headCy: hcy, headR: R, bodyX: bx, bodyY: by, bodyW: bw, bodyH: bh } = g
  const fR = Math.min(g.footR, bh / 2, bw / 2)
  const neck = neckHalfWidth(R, by - hcy)
  const sR = Math.max(0, Math.min(g.shoulderR, bh - fR, bw / 2 - neck))
  const segs: OutlineSeg[] = []
  segs.push({ kind: 'M', x: bx, y: by + sR })
  segs.push({ kind: 'A', cx: bx + sR, cy: by + sR, r: sR, a0: Math.PI, a1: Math.PI * 1.5 })
  const joined = neck > 0 && R > 0
  if (joined) {
    const dy = by - hcy
    segs.push({ kind: 'L', x: hcx - neck, y: by })
    // Over the top of the head: lower-left crossing → left → top → right →
    // lower-right crossing, angles increasing.
    segs.push({
      kind: 'A',
      cx: hcx,
      cy: hcy,
      r: R,
      a0: Math.atan2(dy, -neck),
      a1: Math.atan2(dy, neck) + Math.PI * 2,
    })
  }
  segs.push({ kind: 'L', x: bx + bw - sR, y: by })
  segs.push({ kind: 'A', cx: bx + bw - sR, cy: by + sR, r: sR, a0: Math.PI * 1.5, a1: Math.PI * 2 })
  segs.push({ kind: 'L', x: bx + bw, y: by + bh - fR })
  segs.push({ kind: 'A', cx: bx + bw - fR, cy: by + bh - fR, r: fR, a0: 0, a1: Math.PI / 2 })
  segs.push({ kind: 'L', x: bx + fR, y: by + bh })
  segs.push({ kind: 'A', cx: bx + fR, cy: by + bh - fR, r: fR, a0: Math.PI / 2, a1: Math.PI })
  segs.push({ kind: 'Z' })
  if (!joined && R > 0) {
    segs.push({ kind: 'M', x: hcx + R, y: hcy })
    segs.push({ kind: 'A', cx: hcx, cy: hcy, r: R, a0: 0, a1: Math.PI * 2 })
    segs.push({ kind: 'Z' })
  }
  return segs
}

/** The canvas calls an outline needs — a live CanvasRenderingContext2D, a
 *  Path2D, or the Theme SDK `Draw` surface all satisfy it. */
export interface CanvasPathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  closePath(): void
}

/** Append the outline to a canvas path (the caller owns beginPath). */
export function tracePersonOutline(sink: CanvasPathSink, g: PersonGeometry): void {
  for (const s of personOutline(g)) {
    if (s.kind === 'M') sink.moveTo(s.x, s.y)
    else if (s.kind === 'L') sink.lineTo(s.x, s.y)
    else if (s.kind === 'A') sink.arc(s.cx, s.cy, s.r, s.a0, s.a1, false)
    else sink.closePath()
  }
}

/**
 * The part of the head's rim that lies inside the body (the "neck" seam that
 * makes the head read as in front of the shoulders): an arc from the right
 * neck crossing, down through the chin, to the left one — angles increasing.
 * Null when the head does not overlap the body.
 */
export function personNeckArc(g: PersonGeometry): { a0: number; a1: number } | null {
  const dy = g.bodyY - g.headCy
  const neck = neckHalfWidth(g.headR, dy)
  if (neck <= 0) return null
  return { a0: Math.atan2(dy, neck), a1: Math.atan2(dy, -neck) }
}

/**
 * Opacity of the neck seam stroke. A border darker than the fill (light
 * themes) draws a quiet seam at 0.7; a border LIGHTER than the fill (dark
 * themes lift the border to carry the edge) would ring the whole head at that
 * strength, so it drops to 0.45. Non-#RRGGBB colours keep 0.7.
 */
export function personNeckSeamOpacity(fill: string, stroke: string): number {
  const lf = hexLuminance(fill)
  const ls = hexLuminance(stroke)
  return lf !== null && ls !== null && ls > lf ? 0.45 : 0.7
}

function hexLuminance(color: string): number | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString()

/** SVG path data for the outline; `tx`/`ty` map world → document coords. */
export function personPathD(
  g: PersonGeometry,
  tx: (x: number) => number = (x) => x,
  ty: (y: number) => number = (y) => y,
): string {
  const out: string[] = []
  for (const s of personOutline(g)) {
    if (s.kind === 'M') out.push(`M ${fmt(tx(s.x))} ${fmt(ty(s.y))}`)
    else if (s.kind === 'L') out.push(`L ${fmt(tx(s.x))} ${fmt(ty(s.y))}`)
    else if (s.kind === 'Z') out.push('Z')
    else {
      if (s.r <= 0) continue
      // A single SVG arc cannot close a full turn: split long sweeps in halves.
      const sweep = s.a1 - s.a0
      const steps = sweep > Math.PI * 1.5 ? 2 : 1
      for (let i = 1; i <= steps; i += 1) {
        const a = s.a0 + (sweep * i) / steps
        const large = sweep / steps > Math.PI ? 1 : 0
        out.push(
          `A ${fmt(s.r)} ${fmt(s.r)} 0 ${large} 1 ${fmt(tx(s.cx + s.r * Math.cos(a)))} ${fmt(ty(s.cy + s.r * Math.sin(a)))}`,
        )
      }
    }
  }
  return out.join(' ')
}

/** SVG path data for the neck seam ({@link personNeckArc}), or '' when none. */
export function personNeckPathD(
  g: PersonGeometry,
  tx: (x: number) => number = (x) => x,
  ty: (y: number) => number = (y) => y,
): string {
  const arc = personNeckArc(g)
  if (!arc) return ''
  const r = fmt(g.headR)
  const px = (a: number) => fmt(tx(g.headCx + g.headR * Math.cos(a)))
  const py = (a: number) => fmt(ty(g.headCy + g.headR * Math.sin(a)))
  return `M ${px(arc.a0)} ${py(arc.a0)} A ${r} ${r} 0 0 1 ${px(arc.a1)} ${py(arc.a1)}`
}

/**
 * The outline as a polyline (y-down world coords), first point not repeated —
 * for consumers that need vertices (the 3D board's THREE.Shape). Only the
 * first closed sub-path is sampled; insets never separate the head at the
 * offsets the board uses.
 */
export function personOutlinePoints(g: PersonGeometry, arcSegments = 12): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  const push = (x: number, y: number) => {
    const last = pts[pts.length - 1]
    if (!last || Math.abs(last.x - x) > 1e-6 || Math.abs(last.y - y) > 1e-6) pts.push({ x, y })
  }
  for (const s of personOutline(g)) {
    if (s.kind === 'Z') break
    if (s.kind === 'M' || s.kind === 'L') {
      push(s.x, s.y)
      continue
    }
    const sweep = s.a1 - s.a0
    const n = Math.max(2, Math.ceil((arcSegments * sweep) / (Math.PI / 2)))
    for (let i = 0; i <= n; i += 1) {
      const a = s.a0 + (sweep * i) / n
      push(s.cx + s.r * Math.cos(a), s.cy + s.r * Math.sin(a))
    }
  }
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (pts.length > 1 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) pts.pop()
  return pts
}

/** True when (px, py) lies on or inside the figure. */
export function personContains(g: PersonGeometry, px: number, py: number): boolean {
  const dxh = px - g.headCx
  const dyh = py - g.headCy
  if (dxh * dxh + dyh * dyh <= g.headR * g.headR + 1e-6) return true
  return insideRoundedBody(g, px, py)
}

function insideRoundedBody(g: PersonGeometry, px: number, py: number): boolean {
  const { bodyX: bx, bodyY: by, bodyW: bw, bodyH: bh, shoulderR: sR, footR: fR } = g
  if (px < bx - 1e-6 || px > bx + bw + 1e-6 || py < by - 1e-6 || py > by + bh + 1e-6) return false
  const corner = (ccx: number, ccy: number, r: number, inX: boolean, inY: boolean) => {
    if (!inX || !inY || r <= 0) return true
    const dx = px - ccx
    const dy = py - ccy
    return dx * dx + dy * dy <= r * r + 1e-6
  }
  return (
    corner(bx + sR, by + sR, sR, px < bx + sR, py < by + sR) &&
    corner(bx + bw - sR, by + sR, sR, px > bx + bw - sR, py < by + sR) &&
    corner(bx + bw - fR, by + bh - fR, fR, px > bx + bw - fR, py > by + bh - fR) &&
    corner(bx + fR, by + bh - fR, fR, px < bx + fR, py > by + bh - fR)
  )
}

/** Far root of a ray (origin o, unit dir d) against a circle; null if missed. */
function rayCircleFar(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  if (r <= 0) return null
  const fx = ox - cx
  const fy = oy - cy
  const b = fx * dx + fy * dy
  const c = fx * fx + fy * fy - r * r
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b + Math.sqrt(disc)
  return t > 0 ? t : null
}

/**
 * Where a connection leaving the box centre toward (tx, ty) crosses the
 * figure's outline — the outermost crossing, so the line from there to the
 * other end never passes through the figure. Same contract as the engine's
 * rectangle `getEdgePoint` (and the 3D port's `edgePoint`): a point plus the
 * face whose normal the curve leaves along.
 */
export function personEdgePoint(box: Box, tx: number, ty: number): EdgeHit {
  const g = personGeometry(box.x, box.y, box.w, box.h)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  let dx = tx - cx
  let dy = ty - cy
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { x: g.headCx, y: g.headCy - g.headR, face: 'top' }
  dx /= len
  dy /= len

  // Body: the rounded rectangle exit (the centre is inside the body for every
  // box the clamp in personGeometry allows; outside it, the head still wins).
  const { bodyX: bx, bodyY: by, bodyW: bw, bodyH: bh, shoulderR: sR, footR: fR } = g
  const txExit = dx > 0 ? (bx + bw - cx) / dx : dx < 0 ? (bx - cx) / dx : Infinity
  const tyExit = dy > 0 ? (by + bh - cy) / dy : dy < 0 ? (by - cy) / dy : Infinity
  let tBody = Math.max(0, Math.min(txExit, tyExit))
  let face: Face = txExit < tyExit ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top')
  const ix = cx + dx * tBody
  const iy = cy + dy * tBody
  // Corner arcs: the straight-side exit lies in a corner square → re-cut on the arc.
  const corners: Array<[number, number, number, boolean]> = [
    [bx + sR, by + sR, sR, ix < bx + sR && iy < by + sR],
    [bx + bw - sR, by + sR, sR, ix > bx + bw - sR && iy < by + sR],
    [bx + bw - fR, by + bh - fR, fR, ix > bx + bw - fR && iy > by + bh - fR],
    [bx + fR, by + bh - fR, fR, ix < bx + fR && iy > by + bh - fR],
  ]
  for (const [ccx, ccy, r, inCorner] of corners) {
    if (!inCorner) continue
    const t = rayCircleFar(cx, cy, dx, dy, ccx, ccy, r)
    if (t !== null) tBody = t
    break
  }

  const tHead = rayCircleFar(cx, cy, dx, dy, g.headCx, g.headCy, g.headR)
  if (tHead !== null && tHead > tBody) {
    const hx = cx + dx * tHead
    const hy = cy + dy * tHead
    const nx = hx - g.headCx
    const ny = hy - g.headCy
    face = Math.abs(nx) > Math.abs(ny) ? (nx < 0 ? 'left' : 'right') : (ny < 0 ? 'top' : 'bottom')
    return { x: hx, y: hy, face }
  }
  return { x: cx + dx * tBody, y: cy + dy * tBody, face }
}

/** Top of the figure's outline at abscissa `px` (head or shoulders, whichever is higher). */
export function personTopAt(g: PersonGeometry, px: number): number {
  const { bodyX: bx, bodyY: by, bodyW: bw, shoulderR: sR } = g
  let top = by
  if (px < bx + sR) {
    const d = bx + sR - px
    top = by + sR - Math.sqrt(Math.max(0, sR * sR - d * d))
  } else if (px > bx + bw - sR) {
    const d = px - (bx + bw - sR)
    top = by + sR - Math.sqrt(Math.max(0, sR * sR - d * d))
  }
  const dx = px - g.headCx
  if (Math.abs(dx) <= g.headR) top = Math.min(top, g.headCy - Math.sqrt(g.headR * g.headR - dx * dx))
  return top
}

/** Bottom of the figure's outline at abscissa `px` (the body's base, rising
 *  along the bottom corner arcs). */
export function personBottomAt(g: PersonGeometry, px: number): number {
  const { bodyX: bx, bodyY: by, bodyW: bw, bodyH: bh, footR: fR } = g
  const base = by + bh
  let d = 0
  if (px < bx + fR) d = bx + fR - px
  else if (px > bx + bw - fR) d = px - (bx + bw - fR)
  if (d <= 0) return base
  return base - fR + Math.sqrt(Math.max(0, fR * fR - d * d))
}

/**
 * One of the 12 anchors (3 per side, ratios 0.2 / 0.5 / 0.8) projected onto
 * the figure: top and bottom anchors spread across the body (the card's inset
 * rule, applied to the body) and sit on the head, the shoulders or the base;
 * side anchors spread along the straight part of the body's sides (never in
 * the air beside the head). `inset` is the corner inset the rectangle anchors
 * use (8 in both renderers).
 */
export function personAnchorPoint(box: Box, side: Face, ratio: number, inset = 8): EdgeHit {
  const g = personGeometry(box.x, box.y, box.w, box.h)
  switch (side) {
    case 'top': {
      const x = g.bodyX + inset + ratio * Math.max(0, g.bodyW - 2 * inset)
      return { x, y: personTopAt(g, x), face: 'top' }
    }
    case 'bottom': {
      const x = g.bodyX + inset + ratio * Math.max(0, g.bodyW - 2 * inset)
      return { x, y: personBottomAt(g, x), face: 'bottom' }
    }
    case 'left':
    case 'right': {
      const top = g.bodyY + g.shoulderR
      const bottom = g.bodyY + g.bodyH - g.footR
      const y = top + ratio * Math.max(0, bottom - top)
      return { x: side === 'left' ? g.bodyX : g.bodyX + g.bodyW, y, face: side }
    }
  }
}

/**
 * A person's link indicator: on the canvas beside the head, above the left
 * shoulder (left edge at the body's left edge + 4, centre 10 px above the
 * shoulder line, never above the box's usual y + 10). It sits OUTSIDE the
 * figure, so the engine paints it in a canvas colour, not the element's ink.
 * Shared by the draw and the click hit-area so they cannot drift apart.
 */
export function personLinkIndicator(g: PersonGeometry, boxY: number): { left: number; cy: number } {
  return { left: g.bodyX + 4, cy: Math.max(boxY + 10, g.bodyY - 10) }
}

/**
 * `contentTop` for a person: the text block (title, description) sits in the
 * body below the chin, above the type-badge reserve — 40 % of the spare room
 * above it, 60 % below, so on a big figure the title stays near the chin as
 * on the reference instead of floating mid-body. Same coordinate system as
 * `objectContentLayout` (title top at y + 38 + contentTop), so the shared
 * anchors stay valid; there is no type glyph — the head is the icon.
 */
export function personContentTop({
  width,
  height,
  descriptionLines,
  titleSize = 13,
  descriptionSize = 11,
  bottomReserve = 28,
}: {
  width: number
  height: number
  descriptionLines: number
  titleSize?: number
  descriptionSize?: number
  bottomReserve?: number
}): number {
  const g = personGeometry(0, 0, width, height)
  // Under the chin, with a gap that grows with the head — but never so low
  // that the minimum block (title, one line, badge) stops fitting: the head
  // was sized for a CHIN_GAP of 2 (personGeometry).
  const chin = g.headCy + g.headR
  const gap = Math.min(CHIN_GAP_MAX, Math.max(CHIN_GAP, CHIN_GAP + (g.headR - 23) * CHIN_GAP_PER_R))
  const usableTop = Math.max(g.bodyY + 6, Math.min(chin + gap, Math.max(chin + CHIN_GAP, height - TEXT_UNDER_CHIN)))
  const usableH = height - bottomReserve - usableTop
  const lineH = Math.round(descriptionSize * 1.15)
  const blockH = descriptionLines > 0 ? 16 + descriptionLines * lineH : titleSize
  return Math.round(usableTop + Math.max(0, usableH - blockH) * TEXT_SLACK_ABOVE) - 38
}
