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
import { connectionPath, samplePath, type Rect } from './connectionPath'
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
