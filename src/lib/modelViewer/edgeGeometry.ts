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

import type { ViewerTile } from './layout'

/**
 * Model Viewer connection geometry (design kit `mv-grid.jsx`): side-anchored
 * edges between tiles with three routings — curved (cubic), orthogonal
 * (H/V midpoint), straight. Pure world-space SVG path math.
 *
 * Two refinements over the kit (user feedback — "the line + arrow reads
 * ugly on about every connection"):
 * - Edges sharing a tile side fan out along it instead of stacking on the
 *   side's midpoint (arrowheads no longer pile up on busy models).
 * - Paths stop `ARROW_TRIM` px short of the target side so the arrowhead —
 *   drawn with its tip exactly on the tile edge — caps the line instead of
 *   the stroke poking through the dart into the tile border.
 */

export type ViewerRouting = 'curved' | 'orthogonal' | 'straight'

type Side = 'l' | 'r' | 't' | 'b'
type Pt = [number, number]

/** Px the path stops short of the target anchor; the arrowhead covers the gap
 * (dart length 10, tip drawn 9px past the path end — see ViewerGrid markers). */
export const ARROW_TRIM = 9

const anchorPt = (t: ViewerTile, s: Side, frac = 0.5): Pt =>
  s === 'r'
    ? [t.x + t.w, t.y + t.h * frac]
    : s === 'l'
      ? [t.x, t.y + t.h * frac]
      : s === 't'
        ? [t.x + t.w * frac, t.y]
        : [t.x + t.w * frac, t.y + t.h]

/** Direction of travel INTO a target side (the arrow's pointing direction). */
const TRAVEL: Record<Side, Pt> = { l: [1, 0], r: [-1, 0], t: [0, 1], b: [0, -1] }

export function sidesFor(a: ViewerTile, b: ViewerTile): [Side, Side] {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['r', 'l'] : ['l', 'r']
  return dy >= 0 ? ['b', 't'] : ['t', 'b']
}

const cubicAt = (t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt => {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ]
}

export interface EdgeAnchors {
  p1: Pt
  p2: Pt
  fs: Side
  ts: Side
}

/** Fan out the endpoints of edges that share a (tile, side): slot i of n sits
 * at side-fraction (i+1)/(n+1) — a single edge keeps the midpoint. Slots are
 * ordered by the far endpoint's cross-axis position (id tiebreak) so
 * neighbouring edges don't cross each other at the side. */
export function computeEdgeAnchors(
  conns: { id: string; fromId: string; toId: string }[],
  byId: Map<string, ViewerTile>,
): Map<string, EdgeAnchors> {
  interface Slot {
    connId: string
    end: 'from' | 'to'
    sortKey: number
  }
  const buckets = new Map<string, Slot[]>()
  const sides = new Map<string, [Side, Side]>()
  const push = (key: string, slot: Slot) => {
    let arr = buckets.get(key)
    if (!arr) buckets.set(key, (arr = []))
    arr.push(slot)
  }
  for (const c of conns) {
    const a = byId.get(c.fromId)
    const b = byId.get(c.toId)
    if (!a || !b || c.fromId === c.toId) continue
    const [fs, ts] = sidesFor(a, b)
    sides.set(c.id, [fs, ts])
    push(`${c.fromId}:${fs}`, { connId: c.id, end: 'from', sortKey: fs === 'l' || fs === 'r' ? b.cy : b.cx })
    push(`${c.toId}:${ts}`, { connId: c.id, end: 'to', sortKey: ts === 'l' || ts === 'r' ? a.cy : a.cx })
  }
  const frac = new Map<string, number>()
  for (const slots of buckets.values()) {
    slots.sort((x, y) => x.sortKey - y.sortKey || (x.connId < y.connId ? -1 : x.connId > y.connId ? 1 : 0))
    slots.forEach((s, i) => frac.set(`${s.connId}:${s.end}`, (i + 1) / (slots.length + 1)))
  }
  const out = new Map<string, EdgeAnchors>()
  for (const c of conns) {
    const sd = sides.get(c.id)
    if (!sd) continue
    const a = byId.get(c.fromId)!
    const b = byId.get(c.toId)!
    const [fs, ts] = sd
    out.set(c.id, {
      p1: anchorPt(a, fs, frac.get(`${c.id}:from`) ?? 0.5),
      p2: anchorPt(b, ts, frac.get(`${c.id}:to`) ?? 0.5),
      fs,
      ts,
    })
  }
  return out
}

export interface EdgeGeometry {
  d: string
  /** Label anchor (path midpoint). */
  mid: Pt
}

/** Path between two resolved anchors, end pulled ARROW_TRIM px back from the
 * target side along the arrival direction (straight: along the line). */
export function edgePathBetween(anchors: EdgeAnchors, routing: ViewerRouting): EdgeGeometry {
  const { p1, fs, ts } = anchors
  const horiz = fs === 'r' || fs === 'l'
  if (routing === 'straight') {
    const dx = anchors.p2[0] - p1[0]
    const dy = anchors.p2[1] - p1[1]
    const len = Math.hypot(dx, dy) || 1
    const p2: Pt = [anchors.p2[0] - (dx / len) * ARROW_TRIM, anchors.p2[1] - (dy / len) * ARROW_TRIM]
    return { d: `M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`, mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] }
  }
  // curved / orthogonal arrive perpendicular to the target side
  const [tx, ty] = TRAVEL[ts]
  const p2: Pt = [anchors.p2[0] - tx * ARROW_TRIM, anchors.p2[1] - ty * ARROW_TRIM]
  if (routing === 'orthogonal') {
    if (horiz) {
      const mx = (p1[0] + p2[0]) / 2
      return { d: `M${p1[0]},${p1[1]} H${mx} V${p2[1]} H${p2[0]}`, mid: [mx, (p1[1] + p2[1]) / 2] }
    }
    const my = (p1[1] + p2[1]) / 2
    return { d: `M${p1[0]},${p1[1]} V${my} H${p2[0]} V${p2[1]}`, mid: [(p1[0] + p2[0]) / 2, my] }
  }
  // Handle length grows with the cross-axis travel too: a near-diagonal pair
  // has almost no main-axis distance between its anchors, and main-axis-only
  // handles degenerate the cubic into a straight run with hard elbows at both
  // ends (the ugly hook the user circled).
  let c1: Pt
  let c2: Pt
  if (horiz) {
    const k = Math.max(38, Math.abs(p2[0] - p1[0]) * 0.5, Math.abs(p2[1] - p1[1]) * 0.35)
    c1 = [p1[0] + (fs === 'r' ? k : -k), p1[1]]
    c2 = [p2[0] + (ts === 'r' ? k : -k), p2[1]]
  } else {
    const k = Math.max(38, Math.abs(p2[1] - p1[1]) * 0.5, Math.abs(p2[0] - p1[0]) * 0.35)
    c1 = [p1[0], p1[1] + (fs === 'b' ? k : -k)]
    c2 = [p2[0], p2[1] + (ts === 'b' ? k : -k)]
  }
  return {
    d: `M${p1[0]},${p1[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`,
    mid: cubicAt(0.5, p1, c1, c2, p2),
  }
}

/** Single-edge convenience (centered anchors) — tests and simple callers. */
export function edgePath(a: ViewerTile, b: ViewerTile, routing: ViewerRouting): EdgeGeometry {
  const [fs, ts] = sidesFor(a, b)
  return edgePathBetween({ p1: anchorPt(a, fs), p2: anchorPt(b, ts), fs, ts }, routing)
}
