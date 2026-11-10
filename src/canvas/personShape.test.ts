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
  offsetPerson,
  personAnchorPoint,
  personBottomAt,
  personContains,
  personContentTop,
  personEdgePoint,
  personGeometry,
  personLinkIndicator,
  personNeckArc,
  personNeckPathD,
  personNeckSeamOpacity,
  personOutlinePoints,
  personPathD,
  personTextBox,
  personTopAt,
  type Box,
  type Face,
} from './personShape'

const SIZES: Array<[number, number]> = [
  [160, 100], // the default shape size (shapeDefaults.ts)
  [200, 150], // the create palette's size
  [240, 160],
  [310, 220],
  [450, 300], // a Structurizr import
  [120, 80],
  [120, 70],
  [70, 50], // the shop preview sample
  [300, 100], // wide and short
  [400, 120],
  [160, 200], // tall
  [140, 260],
]

const NORMAL: Record<Face, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

describe('personGeometry — the C4 Person figure fitted inside the box', () => {
  for (const [w, h] of SIZES) {
    it(`${w}×${h}: head and body stay inside the box, the head rests on the shoulders`, () => {
      const g = personGeometry(10, 20, w, h)
      expect(g.headCy - g.headR).toBeCloseTo(20, 9) // head top = box top
      expect(g.headCx).toBe(10 + w / 2)
      expect(g.headCx - g.headR).toBeGreaterThanOrEqual(10)
      expect(g.headCx + g.headR).toBeLessThanOrEqual(10 + w)
      // the body is centred under the head: the box wide, or 2:1 if narrower
      expect(g.bodyX + g.bodyW / 2).toBeCloseTo(10 + w / 2, 9)
      expect(g.bodyW).toBeCloseTo(Math.min(w, 2 * g.bodyH), 9)
      expect(g.bodyY + g.bodyH).toBeCloseTo(20 + h, 9) // feet = box bottom
      // the head overlaps the body (a neck), and sits above the box centre
      expect(g.bodyY).toBeLessThan(g.headCy + g.headR)
      expect(g.bodyY).toBeGreaterThan(g.headCy)
      expect(g.bodyY).toBeLessThan(20 + h / 2)
      // the shoulders leave a flat run between the corner and the neck
      const neck = Math.sqrt(g.headR ** 2 - (g.bodyY - g.headCy) ** 2)
      expect(g.headCx - neck).toBeGreaterThan(g.bodyX + g.shoulderR)
    })
  }
})

/**
 * The owner's report (2026-11-07): "la proportion de la tête avec le reste du
 * corps du bonhomme n'est pas bonne" — the shipped head was 0.23 × the body
 * width at 160×100, a pin-head on a slab. The reference C4 person (measured on
 * the owner's diagram) has a head ⌀ of 0.48 × the body width and 0.81 × the
 * body height, sunk 0.29 R into the body, body corners ≈ 0.25 × its height.
 */
describe('personGeometry — the reference C4 proportions', () => {
  const ratios = (w: number, h: number) => {
    const g = personGeometry(0, 0, w, h)
    return { g, perW: (2 * g.headR) / g.bodyW, perH: (2 * g.headR) / g.bodyH }
  }

  for (const [w, h] of [[200, 150], [240, 160], [310, 220], [450, 300]] as const) {
    it(`${w}×${h}: head ⌀ = 0.81 × the body height, ≥ 0.4 × the body width, sunk 0.3 R`, () => {
      const { g, perW, perH } = ratios(w, h)
      expect(perH).toBeCloseTo(0.81, 2)
      expect(perW).toBeGreaterThanOrEqual(0.4)
      expect(perW).toBeLessThanOrEqual(0.5)
      expect((g.headCy + g.headR - g.bodyY) / g.headR).toBeCloseTo(0.3, 9)
      // the body is narrowed to 2:1 (the reference is ≈ 1.7:1)
      expect(g.bodyW / g.bodyH).toBeLessThanOrEqual(2 + 1e-9)
      // all four corners round alike, growing with the body (not a fixed 12)
      expect(g.footR).toBeCloseTo(Math.min(0.24 * g.bodyH, 0.15 * g.bodyW, 44), 9)
      expect(g.footR).toBeGreaterThan(12)
      expect(Math.abs(g.footR - g.shoulderR) / g.shoulderR).toBeLessThan(0.15)
    })
  }

  it('160×100 (the default): no longer a pin-head — head ⌀ ≥ 0.35 × body width, ≥ 0.7 × body height', () => {
    const { perW, perH } = ratios(160, 100)
    expect(perW).toBeGreaterThanOrEqual(0.35) // shipped: 0.23
    expect(perH).toBeGreaterThanOrEqual(0.7) // shipped: 0.52
  })

  it('a tall box keeps a full-width body and the reference head/width ratio', () => {
    const { g, perW } = ratios(160, 200)
    expect(g.bodyW).toBe(160)
    expect(perW).toBeCloseTo(0.47, 2)
  })

  it('a wide, short box keeps the proportions (no slab): the 2:1 body, centred', () => {
    // validation pass: a 60 % width floor left 300×100 at the rejected 0.26
    for (const [w, h] of [[300, 100], [400, 120]] as const) {
      const { g, perW } = ratios(w, h)
      expect(g.bodyW).toBeCloseTo(2 * g.bodyH, 9)
      expect(g.bodyX).toBeCloseTo((w - g.bodyW) / 2, 9)
      expect(perW).toBeGreaterThanOrEqual(0.35)
    }
  })

  it('a tall box keeps its bottom corners no rounder than its shoulders', () => {
    const g = personGeometry(0, 0, 160, 200)
    expect(g.footR).toBeLessThanOrEqual(g.shoulderR + 1e-9)
  })

  it('reserveText: false keeps the proportion where the text rule would shrink the head', () => {
    // the shop preview's 70×50 sample carries only its name
    expect(personGeometry(0, 0, 70, 50).headR).toBe(6)
    expect(personGeometry(0, 0, 70, 50, { reserveText: false }).headR).toBeCloseTo(12, 9)
    // where the text fits anyway, both agree
    expect(personGeometry(0, 0, 310, 220, { reserveText: false })).toEqual(personGeometry(0, 0, 310, 220))
  })
})

describe('personContentTop / personTextBox — the text lives in the body, under the chin', () => {
  // the engine's anchors: title top at 38 + contentTop, description 16 below,
  // the 16 px type badge 4 px above the bottom, a 5 px gap above it
  // (below 70 px no box holds title + a line + badge, card or person)
  for (const [w, h] of SIZES.filter(([, h]) => h >= 70)) {
    it(`${w}×${h}: title clears the chin, and title + one 9 px line + badge fit in the body`, () => {
      const g = personGeometry(0, 0, w, h)
      const titleTop = 38 + personContentTop({ width: w, height: h, descriptionLines: 1 })
      expect(titleTop).toBeGreaterThanOrEqual(g.bodyY + 6 - 0.5)
      expect(titleTop).toBeGreaterThanOrEqual(g.headCy + g.headR + 2 - 0.5)
      const badgeTop = h - 16 - 4
      expect(titleTop + 16 + 9 * 1.15 + 5).toBeLessThanOrEqual(badgeTop + 0.5)
    })
  }

  it('the text box is the body inset 8 px each side', () => {
    const g = personGeometry(0, 0, 160, 100)
    expect(personTextBox(g)).toEqual({ x: g.bodyX + 8, width: g.bodyW - 16 })
    expect(personTextBox(g).width).toBeLessThan(160 - 16) // narrower than a card's
  })

  it('a big head leaves a wider gap under the chin (5 px), the default head 2 px', () => {
    for (const [w, h, gap] of [[160, 100, 2], [310, 220, 5], [450, 300, 5]] as const) {
      const g = personGeometry(0, 0, w, h)
      const titleTop = 38 + personContentTop({ width: w, height: h, descriptionLines: 9 })
      expect(titleTop - (g.headCy + g.headR)).toBeGreaterThanOrEqual(gap - 0.5)
      expect(titleTop - (g.headCy + g.headR)).toBeLessThanOrEqual(gap + 0.5)
    }
  })

  it('on a big figure the spare room splits 40 % above the block, 60 % below', () => {
    const g = personGeometry(0, 0, 310, 220)
    const usableTop = g.headCy + g.headR + 5
    const usableH = 220 - 28 - usableTop
    const blockH = 16 + 1 * Math.round(11 * 1.15)
    const titleTop = 38 + personContentTop({ width: 310, height: 220, descriptionLines: 1 })
    expect(titleTop - usableTop).toBeCloseTo((usableH - blockH) * 0.4, 0)
  })
})

describe('personOutline — every renderer traces the same silhouette', () => {
  it('the polyline is the union of head and body (inside points in, corner beside the head out)', () => {
    const g = personGeometry(0, 0, 160, 100)
    const pts = personOutlinePoints(g, 16)
    expect(pts.length).toBeGreaterThan(20)
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6)
      expect(p.x).toBeLessThanOrEqual(160 + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(-1e-6)
      expect(p.y).toBeLessThanOrEqual(100 + 1e-6)
    }
    expect(personContains(g, 80, 1)).toBe(true) // crown of the head
    expect(personContains(g, 80, 70)).toBe(true) // chest
    expect(personContains(g, 3, 3)).toBe(false) // empty air beside the head
    expect(personContains(g, 157, 3)).toBe(false)
    expect(personContains(g, 3, 70)).toBe(false) // beside the narrowed body
  })

  it('the SVG path carries no NaN and closes; the neck seam is a chin arc inside the body', () => {
    const g = personGeometry(0, 0, 160, 100)
    const d = personPathD(g)
    expect(d).not.toMatch(/NaN|Infinity/)
    expect(d.startsWith('M ')).toBe(true)
    expect(d.trim().endsWith('Z')).toBe(true)
    const arc = personNeckArc(g)!
    expect(arc).not.toBeNull()
    // both ends at the shoulder line, passing under the head centre
    for (const a of [arc.a0, arc.a1]) expect(g.headCy + g.headR * Math.sin(a)).toBeCloseTo(g.bodyY, 9)
    expect(arc.a0).toBeLessThan(Math.PI / 2)
    expect(arc.a1).toBeGreaterThan(Math.PI / 2)
    expect(personNeckPathD(g)).toMatch(/^M [\d.]+ [\d.]+ A /)
  })

  it('offsetting inflates the whole figure (selection ring) and a small inset keeps it joined', () => {
    const g = personGeometry(0, 0, 160, 100)
    const out = offsetPerson(g, 3)
    expect(out.headR).toBeCloseTo(g.headR + 3, 9)
    expect(out.bodyX).toBeCloseTo(g.bodyX - 3, 9)
    expect(out.bodyW).toBeCloseTo(g.bodyW + 6, 9)
    expect(out.bodyY + out.bodyH).toBeCloseTo(103, 9)
    const inset = offsetPerson(g, -1)
    expect(personNeckArc(inset)).not.toBeNull()
    expect(personOutlinePoints(inset).length).toBeGreaterThan(20)
  })

  it('the neck seam is quieter when the border is lighter than the body (dark themes)', () => {
    expect(personNeckSeamOpacity('#08427B', '#05325E')).toBe(0.7) // C4 light
    expect(personNeckSeamOpacity('#0D4C8E', '#3A7FCB')).toBe(0.45) // C4 dark
    expect(personNeckSeamOpacity('#0D4C8E', 'rgba(255, 255, 255, 0.5)')).toBe(0.7)
  })
})

/** The hit lies on the outline: just inside along the ray is in, just beyond is out. */
function expectOnOutline(box: Box, hit: { x: number; y: number }) {
  const g = personGeometry(box.x, box.y, box.w, box.h)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const len = Math.hypot(hit.x - cx, hit.y - cy)
  const ux = (hit.x - cx) / len
  const uy = (hit.y - cy) / len
  expect(personContains(g, hit.x - ux * 0.5, hit.y - uy * 0.5)).toBe(true)
  expect(personContains(g, hit.x + ux * 0.5, hit.y + uy * 0.5)).toBe(false)
}

describe('personEdgePoint — connections land on the figure, never in the air beside the head', () => {
  for (const box of [
    { x: 100, y: 200, w: 160, h: 100 },
    { x: 100, y: 200, w: 300, h: 100 },
    { x: 100, y: 200, w: 160, h: 200 },
    { x: 100, y: 200, w: 450, h: 300 },
  ] as Box[]) {
    it(`${box.w}×${box.h}: every direction ends on the outline (the outermost crossing)`, () => {
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      for (let deg = 0; deg < 360; deg += 7.5) {
        const a = (deg * Math.PI) / 180
        const hit = personEdgePoint(box, cx + Math.cos(a) * 900, cy + Math.sin(a) * 900)
        expectOnOutline(box, hit)
      }
    })
  }

  const box: Box = { x: 100, y: 200, w: 160, h: 100 }
  const cx = 180
  const cy = 250

  it('straight up reaches the crown of the head, straight down the feet', () => {
    const up = personEdgePoint(box, cx, -1000)
    expect(up.x).toBeCloseTo(cx, 9)
    expect(up.y).toBeCloseTo(200, 9)
    expect(up.face).toBe('top')
    const down = personEdgePoint(box, cx, 2000)
    expect(down.y).toBeCloseTo(300, 9)
    expect(down.face).toBe('bottom')
  })

  it('toward the top-left corner it lands on the figure, not at the box corner', () => {
    const hit = personEdgePoint(box, 0, 0)
    expect(hit.y).toBeGreaterThan(box.y + 5) // the box corner is empty air
    expectOnOutline(box, hit)
  })

  it('toward the far upper left it lands on the left shoulder (left of the neck, not the head)', () => {
    const hit = personEdgePoint(box, box.x - 1000, cy - 400)
    const g = personGeometry(box.x, box.y, box.w, box.h)
    const neck = Math.sqrt(g.headR ** 2 - (g.bodyY - g.headCy) ** 2)
    expect(hit.y).toBeGreaterThanOrEqual(g.bodyY - 1e-6)
    expect(hit.x).toBeLessThan(g.headCx - neck)
    expectOnOutline(box, hit)
  })

  it('sideways it leaves from the body side, inside the narrowed box', () => {
    const g = personGeometry(box.x, box.y, box.w, box.h)
    // the box centre sits on the shoulder curve here: within a pixel of the side
    const right = personEdgePoint(box, 2000, cy)
    expect(Math.abs(right.x - (g.bodyX + g.bodyW))).toBeLessThan(1.5)
    expect(right.y).toBeCloseTo(cy, 9)
    expect(right.face).toBe('right')
    expectOnOutline(box, right)
    const left = personEdgePoint(box, -2000, cy)
    expect(Math.abs(left.x - g.bodyX)).toBeLessThan(1.5)
    expect(left.x).toBeGreaterThan(box.x + 10) // the narrowed body, not the box edge
    expect(left.face).toBe('left')
    // lower down the side is straight
    const lowRight = personEdgePoint(box, 2000, cy + 200)
    expect(lowRight.face).toBe('right')
    expectOnOutline(box, lowRight)
  })
})

describe('personAnchorPoint — the 12 anchors sit on the figure', () => {
  for (const [w, h] of SIZES) {
    it(`${w}×${h}: each anchor is on the outline, just outside along its face normal is empty`, () => {
      const box: Box = { x: 0, y: 0, w, h }
      const g = personGeometry(0, 0, w, h)
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        for (const ratio of [0.2, 0.5, 0.8]) {
          const p = personAnchorPoint(box, side, ratio)
          expect(p.face).toBe(side)
          const n = NORMAL[side]
          expect(personContains(g, p.x - n.x * 0.5, p.y - n.y * 0.5)).toBe(true)
          expect(personContains(g, p.x + n.x * 0.5, p.y + n.y * 0.5)).toBe(false)
        }
      }
    })
  }

  it('the centre top anchor is the crown; side anchors are on the body, below the shoulders', () => {
    const box: Box = { x: 0, y: 0, w: 160, h: 100 }
    const g = personGeometry(0, 0, 160, 100)
    expect(personAnchorPoint(box, 'top', 0.5)).toEqual({ x: 80, y: 0, face: 'top' })
    expect(personTopAt(g, 80)).toBeCloseTo(0, 9)
    for (const ratio of [0.2, 0.5, 0.8]) {
      const left = personAnchorPoint(box, 'left', ratio)
      expect(left.x).toBeCloseTo(g.bodyX, 9)
      expect(left.y).toBeGreaterThanOrEqual(g.bodyY + g.shoulderR - 1e-6)
      expect(personAnchorPoint(box, 'right', ratio).x).toBeCloseTo(g.bodyX + g.bodyW, 9)
    }
  })

  it('bottom anchors spread across the body (wide box) and sit on its base', () => {
    const box: Box = { x: 0, y: 0, w: 300, h: 100 }
    const g = personGeometry(0, 0, 300, 100)
    for (const ratio of [0.2, 0.5, 0.8]) {
      const p = personAnchorPoint(box, 'bottom', ratio)
      expect(p.y).toBeCloseTo(personBottomAt(g, p.x), 9)
      expect(p.x).toBeGreaterThan(g.bodyX)
      expect(p.x).toBeLessThan(g.bodyX + g.bodyW)
    }
    // the base rises along the bottom corner arcs
    expect(personBottomAt(g, g.bodyX + g.bodyW / 2)).toBeCloseTo(100, 9)
    // (5 places: at the arc's very end the square root amplifies rounding)
    expect(personBottomAt(g, g.bodyX)).toBeCloseTo(100 - g.footR, 5)
    expect(personBottomAt(g, g.bodyX + g.bodyW)).toBeCloseTo(100 - g.footR, 5)
    const mid = g.bodyX + g.footR * (1 - Math.SQRT1_2)
    expect(personBottomAt(g, mid)).toBeCloseTo(100 - g.footR + g.footR * Math.SQRT1_2, 5)
  })

  it('the link indicator floats on the canvas beside the head, above the shoulder line', () => {
    for (const [w, h] of [[160, 100], [120, 80], [200, 150], [160, 200]] as const) {
      const g = personGeometry(0, 0, w, h)
      const { left, cy } = personLinkIndicator(g, 0)
      expect(left).toBeCloseTo(g.bodyX + 4, 9)
      expect(cy).toBeGreaterThanOrEqual(10)
      // the 12 px icon + count (≈ 26 px wide, ±6 px tall) touches neither the
      // shoulders nor the head: the engine paints it in a canvas colour
      expect(cy + 6).toBeLessThan(g.bodyY)
      expect(left + 26).toBeLessThan(g.headCx - g.headR)
    }
  })
})
