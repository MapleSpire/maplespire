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

import { describe, expect, it } from 'vitest'
import { convexGap, convexHull, convexOverlap, plaqueInFront, screenShadowOnFloor, slideClear, type Pt } from './screenClearance'

describe("slideClear / screenShadowOnFloor — a drum's name tag keeps off the cards (user regression 2026-10-10)", () => {
  it('a raised card covers the floor behind it on screen: its footprint swept away from the camera', () => {
    // camera due +z (az 0) at polar 45°: a 20-tall card covers 20 more units toward −z
    const s = screenShadowOnFloor({ x: 0, y: 100, w: 200, h: 120 }, 20, 45, 0, 2)
    expect(s.x).toBeCloseTo(-2, 9)
    expect(s.w).toBeCloseTo(204, 9)
    expect(s.y).toBeCloseTo(78, 9)
    expect(s.h).toBeCloseTo(144, 9)
  })
  it('a clear tag stays where plaqueInFront put it', () => {
    const tag = { x: 0, y: 0, w: 70, h: 18 }
    expect(slideClear(tag, 40, [{ x: 200, y: 200, w: 10, h: 10 }], 4, 60)).toBe(tag)
  })
  it('a touching tag slides sideways — same depth toward the camera — to the nearest clear spot', () => {
    // the 'Event bus' case (tp4-cards workbench-tag-0.png): a card's screen
    // shadow overlaps the tag's left end by a few units
    const tag = { x: 0, y: 0, w: 70, h: 18 }
    const card = { x: -100, y: -40, w: 104, h: 100 }
    const r = slideClear(tag, 0, [card], 4, 60)
    expect(r.x).toBeGreaterThanOrEqual(card.x + card.w)
    expect(r.x - tag.x).toBe(4)
    expect(r.y).toBeCloseTo(tag.y, 9) // az 0: sliding is along x only
    // the depth along the camera ray is unchanged at any azimuth
    const az = 40
    const t = { sx: Math.sin((az * Math.PI) / 180), sy: Math.cos((az * Math.PI) / 180) }
    const slid = slideClear(tag, az, [{ x: -60, y: -40, w: 70, h: 100 }], 4, 120)
    expect(slid).not.toBe(tag)
    expect(slid.x * t.sx + slid.y * t.sy).toBeCloseTo(tag.x * t.sx + tag.y * t.sy, 9)
  })
  it('boxed in on both sides past maxShift: left where it was', () => {
    const tag = { x: 0, y: 0, w: 70, h: 18 }
    expect(slideClear(tag, 0, [{ x: -500, y: -5, w: 1000, h: 30 }], 4, 40)).toBe(tag)
  })
})

describe("plaqueInFront — a drum's floor tag on the camera side (quality pass labels round 2)", () => {
  // the drum (Scene3D DRUM_R 46), the iso preset azimuth (rz 40), the
  // 'Elasticsearch' tag (13 chars x 10.5 x 0.59 + 18 ≈ 98.5 x 18)
  const R = 46
  const GAP = 6
  const W = 98.5
  const H = 18
  /** How far past the cylinder's front tangent line the plaque's NEAREST
   * corner lies, along the board direction toward the camera. */
  const pastFront = (r: { x: number; y: number; w: number; h: number }, az: number) => {
    const tx = Math.sin((az * Math.PI) / 180)
    const ty = Math.cos((az * Math.PI) / 180)
    const corners = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ]
    return Math.min(...corners.map(([x, y]) => x * tx + y * ty)) - R
  }

  it('the defect: the old fixed +z tag (cz + 49 .. 67) reached BEHIND the front of the drum at the iso azimuth', () => {
    const old = { x: -W / 2, y: 49, w: W, h: H }
    expect(pastFront(old, 40)).toBeLessThan(0)
  })

  it.each([0, 40, 45, 90, 180, 300])('every corner past the front by the gap at azimuth %i', (az) => {
    const r = plaqueInFront(0, 0, W, H, az, R, GAP)
    expect(r.w).toBe(W)
    expect(r.h).toBe(H)
    expect(pastFront(r, az)).toBeGreaterThanOrEqual(GAP - 1e-9)
    // …and no farther than it needs: the nearest corner is exactly the gap past
    expect(pastFront(r, az)).toBeCloseTo(GAP, 9)
  })

  it('is centred on the camera ray', () => {
    const r = plaqueInFront(100, 200, W, H, 40, R, GAP)
    const c = { x: r.x + r.w / 2 - 100, y: r.y + r.h / 2 - 200 }
    // collinear with (sin 40, cos 40)
    expect(c.x * Math.cos((40 * Math.PI) / 180) - c.y * Math.sin((40 * Math.PI) / 180)).toBeCloseTo(0, 9)
    expect(c.x).toBeGreaterThan(0)
    expect(c.y).toBeGreaterThan(0)
  })
})

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]
/** `pts` turned by `deg` about `c`. */
const turn = (pts: Pt[], deg: number, c: Pt): Pt[] => {
  const a = (deg * Math.PI) / 180
  return pts.map((p) => ({
    x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
    y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
  }))
}

describe('convexHull', () => {
  it('keeps the extreme points of a projected box and drops the inner ones', () => {
    const pts = [...rect(0, 0, 10, 10), { x: 5, y: 5 }, { x: 5, y: 0 }, { x: 2, y: 3 }]
    const h = convexHull(pts)
    expect(h).toHaveLength(4)
    for (const c of rect(0, 0, 10, 10)) expect(h).toContainEqual(c)
  })
  it('passes a point or a segment through', () => {
    expect(convexHull([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }])
    expect(convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }])).toHaveLength(2)
  })
})

describe('convexGap — the separating-axis distance between two hulls', () => {
  it('is the clear distance between boxes apart, 0 touching, minus the penetration overlapping', () => {
    const a = rect(0, 0, 10, 10)
    expect(convexGap(a, rect(13, 0, 10, 10))).toBeCloseTo(3, 9)
    expect(convexGap(a, rect(10, 2, 10, 10))).toBeCloseTo(0, 9)
    expect(convexGap(a, rect(8, 2, 10, 10))).toBeCloseTo(-2, 9)
  })
  it('sees through the bounding-box trap: two turned plates whose boxes overlap but which do not', () => {
    // a label plate turned 30 deg beside a card turned 30 deg (the iso view
    // turns both alike): their axis-aligned boxes overlap, the shapes are 4 apart
    const card = turn(rect(0, 0, 100, 40), 30, { x: 0, y: 0 })
    const plate = turn(rect(0, 44, 60, 14), 30, { x: 0, y: 0 })
    const box = (p: Pt[]) => {
      const xs = p.map((q) => q.x)
      const ys = p.map((q) => q.y)
      return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    }
    expect(convexGap(box(card), box(plate))).toBeLessThan(0) // control: the boxes do overlap
    expect(convexGap(card, plate)).toBeCloseTo(4, 6)
    expect(convexOverlap(card, plate)).toBe(false)
    expect(convexOverlap(card, plate, 5)).toBe(true) // inside the margin
  })
  it('overlap is symmetric', () => {
    const a = turn(rect(0, 0, 30, 10), 17, { x: 5, y: 5 })
    const b = rect(20, 4, 30, 10)
    expect(convexGap(a, b)).toBeCloseTo(convexGap(b, a), 9)
  })
})

/**
 * CONNECT FREEZE (2026-10-11): convexGap was 554 of 1008 ms of the label
 * pass on the 67-connection board; it now caches each hull's axes and
 * convexOverlap stops at the first separating axis, and the hidden-label
 * fallback skips hulls by a box bound. Each must give the old answers.
 */
describe('convexGap / convexOverlap — the faster forms answer exactly as before', () => {
  // the pre-2026-10-11 implementation, verbatim in substance
  const refGap = (a: readonly Pt[], b: readonly Pt[]): number => {
    const axes = (poly: readonly Pt[]): Pt[] => {
      if (poly.length === 2) {
        const dx = poly[1].x - poly[0].x
        const dy = poly[1].y - poly[0].y
        return [{ x: dx, y: dy }, { x: -dy, y: dx }]
      }
      const out: Pt[] = []
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        out.push({ x: -(q.y - p.y), y: q.x - p.x })
      }
      return out
    }
    if (a.length === 0 || b.length === 0) return Infinity
    let best = -Infinity
    for (const ax of [...axes(a), ...axes(b)]) {
      const len = Math.hypot(ax.x, ax.y)
      if (len < 1e-12) continue
      const nx = ax.x / len
      const ny = ax.y / len
      const pa = a.map((p) => p.x * nx + p.y * ny)
      const pb = b.map((p) => p.x * nx + p.y * ny)
      best = Math.max(best, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
    }
    if (best === -Infinity) return Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y)
    return best
  }
  // a seeded generator: the same shapes on every run
  let seed = 20261011
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const shape = (): Pt[] => {
    const n = [1, 2, 3, 4, 5, 8][Math.floor(rnd() * 6)]
    const cx = rnd() * 200 - 100
    const cy = rnd() * 200 - 100
    const r = 2 + rnd() * 60
    const pts = Array.from({ length: n }, () => ({ x: cx + (rnd() * 2 - 1) * r, y: cy + (rnd() * 2 - 1) * r }))
    return n >= 3 ? convexHull(pts) : pts
  }
  const shapes = Array.from({ length: 160 }, shape)

  it('convexGap matches the old implementation on every pair (hull axes cached across calls)', () => {
    // the same hull objects queried again and again, as the label pass does
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < shapes.length; i += 3) {
        for (let j = 1; j < shapes.length; j += 7) {
          expect(convexGap(shapes[i], shapes[j])).toBeCloseTo(refGap(shapes[i], shapes[j]), 9)
        }
      }
    }
  })

  it('convexOverlap(a, b, m) is exactly convexGap(a, b) < m, margins either side of the gap included', () => {
    let overlapping = 0
    let apart = 0
    for (let i = 0; i < shapes.length; i += 2) {
      for (let j = 1; j < shapes.length; j += 5) {
        const g = refGap(shapes[i], shapes[j])
        for (const m of [0, 2.5, g, g + 1e-6, g - 1e-6]) {
          if (!Number.isFinite(m)) continue
          expect(convexOverlap(shapes[i], shapes[j], m), `pair ${i}/${j} margin ${m}`).toBe(g < m)
        }
        if (g < 0) overlapping++
        else apart++
      }
    }
    // control: both answers were exercised
    expect(overlapping).toBeGreaterThan(20)
    expect(apart).toBeGreaterThan(20)
  })

  it('the depth bound the hidden-label fallback prunes with: an overlap is never deeper than the push that clears its boxes along x or y', () => {
    const box = (p: readonly Pt[]) => ({
      x0: Math.min(...p.map((q) => q.x)),
      x1: Math.max(...p.map((q) => q.x)),
      y0: Math.min(...p.map((q) => q.y)),
      y1: Math.max(...p.map((q) => q.y)),
    })
    // the push along x (y) that separates the boxes — NOT the length of
    // their overlap: a point inside a card overlaps it by 0 along x and
    // needs the distance to the card's nearer side (the first form of this
    // bound used the overlap length, and this test caught it)
    const bound = (s: readonly Pt[], t: readonly Pt[]) => {
      const a = box(s)
      const b = box(t)
      return Math.max(0, Math.min(Math.min(a.x1 - b.x0, b.x1 - a.x0), Math.min(a.y1 - b.y0, b.y1 - a.y0)))
    }
    let overlapping = 0
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const g = convexGap(shapes[i], shapes[j])
        // Scene3D depth(): GAP - gap <= GAP + max(0, min(px, py))
        expect(-g).toBeLessThanOrEqual(bound(shapes[i], shapes[j]) + 1e-9)
        if (g < 0) overlapping++
      }
    }
    expect(overlapping).toBeGreaterThan(100)
    // control: the bound is reached (axis-aligned boxes), so it is not slack
    const a = rect(0, 0, 10, 10)
    const b = rect(8, 2, 10, 10)
    expect(-convexGap(a, b)).toBeCloseTo(bound(a, b), 9)
  })
})
