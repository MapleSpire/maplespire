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

import { describe, it, expect } from 'vitest'
import {
  anchorPoint,
  edgePoint,
  controlPoints,
  buildSegments,
  connectionGeometry,
  center,
  type Box,
} from './geometry'

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, width: w, height: h })

describe('geometry — anchors (mirror CanvasEngine.getAnchorPoint)', () => {
  const b = box(0, 0, 200, 100)
  it('top-center (idx 1) sits on the top edge, inset by corner radius', () => {
    const p = anchorPoint(b, 1)
    expect(p.face).toBe('top')
    expect(p.y).toBe(0)
    expect(p.x).toBeCloseTo(8 + 0.5 * (200 - 16)) // 100
  })
  it('right-center (idx 4) sits on the right edge', () => {
    const p = anchorPoint(b, 4)
    expect(p.face).toBe('right')
    expect(p.x).toBe(200)
    expect(p.y).toBeCloseTo(8 + 0.5 * (100 - 16)) // 50
  })
  it('left-near (idx 9) and bottom-far (idx 8)', () => {
    expect(anchorPoint(b, 9).face).toBe('left')
    expect(anchorPoint(b, 8).face).toBe('bottom')
    expect(anchorPoint(b, 8).y).toBe(100)
  })
})

describe('geometry — edgePoint raycast', () => {
  const b = box(0, 0, 200, 100) // center 100,50
  it('exits the right face toward a far-right target', () => {
    const p = edgePoint(b, { x: 1000, y: 50 })
    expect(p.face).toBe('right')
    expect(p.x).toBeCloseTo(200)
    expect(p.y).toBeCloseTo(50)
  })
  it('exits the bottom face toward a target below', () => {
    const p = edgePoint(b, { x: 100, y: 1000 })
    expect(p.face).toBe('bottom')
    expect(p.y).toBeCloseTo(100)
  })
})

describe('geometry — control points & segments', () => {
  it('straight control points are at 1/3 and 2/3 of the chord', () => {
    const cp = controlPoints({ x: 0, y: 0, face: 'right' }, { x: 30, y: 0, face: 'left' }, 'straight')
    expect(cp.cp1x).toBeCloseTo(10)
    expect(cp.cp2x).toBeCloseTo(20)
  })
  it('no waypoints → single segment; N waypoints → N+1 segments', () => {
    const f = { x: 0, y: 0, face: 'right' as const }
    const t = { x: 100, y: 0, face: 'left' as const }
    expect(buildSegments(f, t, [], 'curved')).toHaveLength(1)
    expect(buildSegments(f, t, [{ x: 50, y: 20 }, { x: 70, y: -20 }], 'curved')).toHaveLength(3)
  })
})

describe('geometry — connectionGeometry', () => {
  it('produces a sampled polyline between two boxes', () => {
    const g = connectionGeometry(box(0, 0, 100, 60), box(300, 0, 100, 60), { shape: 'curved' })
    expect(g.polyline.length).toBeGreaterThan(5)
    expect(g.fromEdge.face).toBe('right')
    expect(g.toEdge.face).toBe('left')
  })
  it('honours locked anchors for endpoints', () => {
    const g = connectionGeometry(box(0, 0, 100, 60), box(300, 0, 100, 60), {
      lockedToAnchors: true,
      fromAnchor: 4, // right-center of from
      toAnchor: 10, // left-center of to
    })
    expect(g.fromEdge.x).toBeCloseTo(100)
    expect(g.toEdge.x).toBeCloseTo(300)
  })
  it('aims a free end at the other end\'s anchor, as the canvas does', () => {
    // CanvasEngine.getConnectionGeometry raycasts an unlocked end toward the other
    // end's resolved point — its ANCHOR when locked — not toward the box centre.
    // A tall target box anchored at its top-left port: aiming at the centre (y=150)
    // lands mid-height on the source's right side; aiming at the port (y≈50) lands
    // well above it.
    const from = box(0, 100, 100, 100)
    const to = box(400, 0, 100, 300)
    const g = connectionGeometry(from, to, { lockedToAnchors: true, toAnchor: 9 }) // left side, 0.2
    expect(g.toEdge.y).toBeCloseTo(8 + 0.2 * (300 - 16))
    expect(g.fromEdge.face).toBe('right')
    expect(g.fromEdge.y).toBeLessThan(140) // the centre aim would give ~150
  })
})

describe('geometry — center helper', () => {
  it('computes box center', () => {
    expect(center(box(10, 20, 100, 80))).toEqual({ x: 60, y: 60 })
  })
})
