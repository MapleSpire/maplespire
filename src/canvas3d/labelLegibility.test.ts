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
import {
  BoxGrid,
  exceptSource,
  freeScale,
  legibleScale,
  MIN_CAP_PX,
  type Obstacle,
  overlapArea,
  overlapsAny,
  roomiestSpot,
  scaleAbout,
  settleScales,
  unionSource,
} from './labelLegibility'

// (The far card-title tests lived here until 2026-10-10, when the user
// rejected the far-title mode — card and drum faces keep the base design.)

describe('connection labels grow toward MIN_CAP_PX within their room', () => {
  it('legibleScale: lifts to the minimum, never shrinks, never past the room', () => {
    expect(legibleScale(5.5, 3)).toBeCloseTo(MIN_CAP_PX / 5.5, 6)
    expect(legibleScale(5.5, 1.4)).toBe(1.4)
    expect(legibleScale(20, 3), 'already legible: untouched').toBe(1)
    expect(legibleScale(0, 3)).toBe(1)
  })

  it('freeScale: stops before a new obstacle, and never covers MORE of one it already touches', () => {
    const box = { x: 0, y: 0, w: 40, h: 10 }
    // a card 10 units to the right: 20 + 10 = half-width room at k = 1.5
    expect(freeScale(box, [{ x: 50, y: -20, w: 50, h: 50 }], 2.2)).toBeCloseTo(1.5, 6)
    // already overlapped (a card top or cable the label floats over) → not a limit
    expect(freeScale(box, [{ x: 10, y: -2, w: 5, h: 5 }], 2.2)).toBeCloseTo(2.2, 6)
    // …unless it is STRICT (a drum the label is tucked behind on screen):
    // growth would cover more of it → no growth (loop3-r2-fix-f, 'reads')
    expect(freeScale(box, [{ x: 36, y: -20, w: 50, h: 50, strict: true }], 2.2)).toBe(1)
    expect(freeScale(box, [{ x: 36, y: -20, w: 50, h: 50 }], 2.2), 'the same body, lenient').toBeCloseTo(2.2, 6)
    // anchored on its left side (the cable is there): grows away from it
    const anchor = { x: 0, y: 5 }
    expect(scaleAbout(box, 2, anchor)).toEqual({ x: 0, y: -5, w: 80, h: 20 })
    expect(freeScale(box, [{ x: -6, y: -20, w: 4, h: 50 }], 2.2, anchor), 'the wire behind it does not bind').toBeCloseTo(2.2, 6)
  })

  it('settleScales: two growing labels never grow into each other', () => {
    const a = { x: 0, y: 0, w: 40, h: 10 }
    const b = { x: 50, y: 0, w: 40, h: 10 }
    const [ka, kb] = settleScales([a, b], [2, 2])
    const ga = scaleAbout(a, ka)
    const gb = scaleAbout(b, kb)
    expect(ga.x + ga.w <= gb.x || gb.x + gb.w <= ga.x).toBe(true)
    expect(ka).toBeGreaterThan(1)
  })

  it('settleScales: a pair placed overlapping keeps that overlap, never more (loop3-r2-fix-d: "writes" across "notifies")', () => {
    const writes = { x: 0, y: 0, w: 50, h: 21 }
    const notifies = { x: 46, y: 10, w: 60, h: 21 } // 4 x 11 overlap as placed
    const own = 4 * 11
    const [kw, kn] = settleScales([writes, notifies], [2.04, 1.35])
    const a = scaleAbout(writes, kw)
    const b = scaleAbout(notifies, kn)
    const area =
      Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
    expect(area).toBeLessThanOrEqual(own + 1e-6)
  })
})

describe('roomiestSpot: a boxed-in label slides along its wire to room it can grow into (loop4-r1: 7 of 10 labels <= 7.2 px)', () => {
  // 'consumes' (loop4-r1 legibility.labels: 4.7 px at k = 1) sat between the
  // Event bus drum and the Rollup worker card; the same wire had open board
  // further along it.
  const plate = (cx: number) => ({ box: { x: cx - 30, y: -10, w: 60, h: 20 }, anchor: { x: cx, y: -10 } })
  // touching the placed plate (x -30..30) on both sides, overlapping neither
  const card = { x: -50, y: -60, w: 20, h: 120 }
  const drum = { x: 30, y: -60, w: 20, h: 120, strict: true }

  it('the defect: at the placed spot the label cannot grow at all', () => {
    expect(freeScale(plate(0).box, [card, drum], 2.2, plate(0).anchor)).toBe(1)
  })

  it('takes the first spot along the wire that reaches the wanted scale', () => {
    const spots = [plate(0), plate(60), plate(200), plate(400)]
    const got = roomiestSpot(spots, [card, drum], 2.2, 2)
    expect(got?.index, 'the nearest stretch with room, not the farthest').toBe(2)
    expect(got!.k).toBeGreaterThanOrEqual(2)
  })

  it('never picks a spot that already touches an obstacle at its own size', () => {
    // plate(50) overlaps the drum at k = 1 — freeScale would ignore a
    // lenient body it already covers, so the overlap must disqualify it here
    const lenientDrum = { ...drum, strict: false }
    const got = roomiestSpot([plate(0), plate(50)], [card, lenientDrum], 2.2, 2)
    expect(got?.index).toBe(0)
    expect(got?.k).toBe(1)
  })

  it('falls back to the roomiest spot when none reaches the want, and to null when none is clean', () => {
    const wall = { x: 70, y: -60, w: 10, h: 120 }
    // plate(150) (x 120..180) is clean of everything and grows about its
    // top centre until its right edge meets the wall at x 190 (k ~1.33)
    const got = roomiestSpot([plate(0), plate(150)], [card, drum, { ...wall, x: 190 }], 2.2, 3)
    expect(got?.index).toBe(1)
    expect(got!.k).toBeGreaterThan(1)
    expect(got!.k).toBeLessThan(3)
    expect(roomiestSpot([plate(-50)], [card], 2.2, 2)).toBeNull()
  })
})

/**
 * CONNECT FREEZE (2026-10-11): the label pass asks its ~1200 card zones and
 * wire samples through ONE grid (BoxGrid) and per-label views of it
 * (exceptSource / unionSource) instead of scanning a fresh array per spot.
 * An index may only change the cost: every answer is the scan's.
 */
describe('BoxGrid / exceptSource / unionSource — the same answers as scanning the list', () => {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  // wire samples (6 x 6), card zones (up to 300 x 160) incl. strict drums,
  // and boxes no grid can key (huge, far, non-finite)
  const obstacles: Obstacle[] = []
  for (let i = 0; i < 900; i++) obstacles.push({ x: rnd() * 2000 - 1000, y: rnd() * 1400 - 700, w: 6, h: 6 })
  for (let i = 0; i < 120; i++) {
    obstacles.push({ x: rnd() * 2000 - 1000, y: rnd() * 1400 - 700, w: 20 + rnd() * 280, h: 20 + rnd() * 140, strict: rnd() < 0.2 })
  }
  // a band across the whole board: more cells than a grid keys
  obstacles.push({ x: -50000, y: 100, w: 100000, h: 3 })
  obstacles.push({ x: 1e7, y: 0, w: 10, h: 10 })
  obstacles.push({ x: 0, y: Number.NaN, w: 10, h: 10 })
  const owner = obstacles.map((_, i) => i % 17)
  const grid = new BoxGrid(obstacles)
  const box = () => ({ x: rnd() * 2100 - 1050, y: rnd() * 1500 - 750, w: 30 + rnd() * 120, h: 12 + rnd() * 14 })

  it('overlapsAny, freeScale and roomiestSpot through the grid equal the scan', () => {
    let hits = 0
    for (let n = 0; n < 400; n++) {
      const b = box()
      const anchor = { x: b.x + rnd() * b.w, y: b.y + (rnd() < 0.5 ? 0 : b.h) }
      const scanned = obstacles.some((o) => overlapArea(b, o) > 1e-6)
      expect(overlapsAny(b, grid)).toBe(scanned)
      if (scanned) hits++
      expect(freeScale(b, grid, 2.2, anchor)).toBe(freeScale(b, obstacles, 2.2, anchor))
    }
    for (let n = 0; n < 60; n++) {
      const spots = Array.from({ length: 12 }, () => {
        const b = box()
        return { box: b, anchor: { x: b.x + b.w / 2, y: b.y } }
      })
      expect(roomiestSpot(spots, grid, 2.2, 1.8)).toEqual(roomiestSpot(spots, obstacles, 2.2, 1.8))
    }
    // control: both answers exercised
    expect(hits).toBeGreaterThan(40)
    expect(hits).toBeLessThan(360)
  })

  it('boxes no grid cell keys (huge, far) are still found', () => {
    const list: Obstacle[] = [
      ...Array.from({ length: 60 }, (_, i) => ({ x: i * 10, y: 500, w: 6, h: 6 })),
      { x: -50000, y: 100, w: 100000, h: 3 },
      { x: 1e7, y: 0, w: 10, h: 10 },
    ]
    const g = new BoxGrid(list)
    const q = { x: 0, y: 90, w: 50, h: 20 } // meets the band only
    expect(overlapsAny(q, list)).toBe(true)
    expect(overlapsAny(q, g)).toBe(true)
    // a plate whose bottom edge touches the band: growth stops at once
    const plate = { x: 0, y: 80, w: 50, h: 20 }
    expect(freeScale(plate, g, 2.2)).toBe(freeScale(plate, list, 2.2))
    expect(freeScale(plate, list, 2.2)).toBeLessThan(2.2) // control: the band binds
    expect(overlapsAny({ x: 1e7 + 2, y: 2, w: 3, h: 3 }, g)).toBe(true)
  })

  it("a label's view drops its own wire and adds the other labels, as the arrays it replaced", () => {
    for (let n = 0; n < 200; n++) {
      const own = n % 17
      const labels = Array.from({ length: 8 }, box)
      const view = unionSource(exceptSource(grid, (i) => owner[i] === own), labels)
      const list = [...obstacles.filter((_, i) => owner[i] !== own), ...labels]
      const b = box()
      const anchor = { x: b.x + b.w / 2, y: b.y + b.h }
      expect(overlapsAny(b, view)).toBe(overlapsAny(b, list))
      expect(freeScale(b, view, 2.2, anchor)).toBe(freeScale(b, list, 2.2, anchor))
    }
  })
})
