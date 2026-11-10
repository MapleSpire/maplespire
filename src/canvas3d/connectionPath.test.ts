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
import type { Connection } from '../types'
import { anchorPoint, connectionPath, edgePoint, nearestAnchorIndex, samplePath, type Rect } from './connectionPath'
import { personAnchorPoint, personContains, personEdgePoint, personGeometry } from '../canvas/personShape'
import { INK_HEAD_LEN } from './inkLine'

// Two cards of the quality harness board (scripts/view3d-quality/run.mjs).
const ROLLUP: Rect = { x: 310, y: 520, w: 200, h: 100 }
const METRICS: Rect = { x: 472, y: 940, w: 200, h: 100 }
const conn = (over: Partial<Connection>): Connection => ({ id: 'c', fromId: 'a', toId: 'b', type: 'solid', ...over })

describe('connectionPath — the route both 3D profiles draw (2D parity)', () => {
  for (const [name, c] of [
    ['straight, free ends', conn({ shape: 'straight' })],
    ['curved, free ends', conn({})],
    ['curved through a waypoint', conn({ waypoints: [{ x: 316, y: 784 }] })],
  ] as const) {
    it(`${name}: the arrow tip is the target edge point and the drawn line stops 14 px short of it`, () => {
      const g = connectionPath(c, ROLLUP, METRICS)
      expect(g.arrowTip.x).toBe(g.toEdge.x)
      expect(g.arrowTip.y).toBe(g.toEdge.y)
      const pts = samplePath(g, 24)
      const end = pts[pts.length - 1]
      // the end sits back along the arrow's own axis
      expect(end.x).toBeCloseTo(g.arrowTip.x - 14 * Math.cos(g.arrowTip.angle), 9)
      expect(end.y).toBeCloseTo(g.arrowTip.y - 14 * Math.sin(g.arrowTip.angle), 9)
      // the lit flat head (inkLine) is longer than the setback: it overlaps
      // the core instead of leaving a gap before its base
      expect(INK_HEAD_LEN - 14).toBeGreaterThanOrEqual(1)
      // and the source end leaves 4 px off its edge point
      expect(Math.hypot(pts[0].x - g.fromEdge.x, pts[0].y - g.fromEdge.y)).toBeCloseTo(4, 9)
    })
  }
})

describe('connectionPath — the C4 person figure (2D parity)', () => {
  const USER: Rect = { x: 0, y: 0, w: 160, h: 100, shape: 'person' }
  const CARD: Rect = { x: 0, y: 0, w: 160, h: 100 }

  it('free ends and anchors use the shared person geometry, exactly as the 2D engine does', () => {
    for (const [tx, ty] of [[-300, -300], [80, -500], [900, 40], [80, 900], [-40, 30]]) {
      expect(edgePoint(USER, tx, ty)).toEqual(personEdgePoint(USER, tx, ty))
    }
    const sides = ['top', 'top', 'top', 'right', 'right', 'right', 'bottom', 'bottom', 'bottom', 'left', 'left', 'left'] as const
    const ratios = [0.2, 0.5, 0.8]
    for (let i = 0; i < 12; i++) {
      expect(anchorPoint(USER, i)).toEqual(personAnchorPoint(USER, sides[i], ratios[i % 3]))
    }
  })

  it('a route toward the upper left starts on the figure, not in the empty box corner', () => {
    const g = connectionPath(conn({}), USER, { x: -400, y: -400, w: 160, h: 100 })
    const fig = personGeometry(0, 0, 160, 100)
    const { x, y } = g.fromEdge
    const len = Math.hypot(x - 80, y - 50)
    expect(personContains(fig, x - ((x - 80) / len) * 0.5, y - ((y - 50) / len) * 0.5)).toBe(true)
    expect(personContains(fig, x + ((x - 80) / len) * 0.5, y + ((y - 50) / len) * 0.5)).toBe(false)
    expect(y).toBeGreaterThan(10)
  })

  it('a card rect (no shape) keeps the rectangle maths', () => {
    expect(edgePoint(CARD, 80, -500)).toEqual({ x: 80, y: 0, face: 'top' })
    expect(anchorPoint(CARD, 0)).toEqual({ x: 8 + 0.2 * 144, y: 0, face: 'top' })
    expect(nearestAnchorIndex(USER, 80, -2)).toBe(1) // the crown
  })
})
