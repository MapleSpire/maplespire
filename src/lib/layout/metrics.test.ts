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
  rectsOverlap,
  rectGap,
  segmentsCross,
  segmentIntersectsRect,
  computeMetrics,
  type Rect,
  type EdgeGeom,
} from './metrics'

const r = (id: string, x: number, y: number, w = 100, h = 60): Rect => ({ id, x, y, width: w, height: h })

describe('geometry primitives', () => {
  it('detects overlapping vs separated rects', () => {
    expect(rectsOverlap(r('a', 0, 0), r('b', 50, 0))).toBe(true)
    expect(rectsOverlap(r('a', 0, 0), r('b', 200, 0))).toBe(false)
  })

  it('honours the gap margin', () => {
    // 10px apart horizontally → overlaps when a 20px gap is required.
    expect(rectsOverlap(r('a', 0, 0), r('b', 110, 0), 0)).toBe(false)
    expect(rectsOverlap(r('a', 0, 0), r('b', 110, 0), 20)).toBe(true)
  })

  it('computes a positive gap for separated rects and negative for overlap', () => {
    expect(rectGap(r('a', 0, 0), r('b', 130, 0))).toBe(30)
    expect(rectGap(r('a', 0, 0), r('b', 50, 0))).toBeLessThan(0)
  })

  it('detects proper segment crossings but not shared endpoints', () => {
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true)
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false)
    // Shared endpoint must NOT count as a crossing.
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }, { x: 10, y: -10 })).toBe(false)
  })

  it('detects a segment passing through a rect', () => {
    const box = r('n', 40, 40, 40, 40) // 40..80 x, 40..80 y
    expect(segmentIntersectsRect({ x: 0, y: 60 }, { x: 200, y: 60 }, box)).toBe(true)
    expect(segmentIntersectsRect({ x: 0, y: 200 }, { x: 200, y: 200 }, box)).toBe(false)
  })
})

describe('computeMetrics', () => {
  it('counts node overlaps and reports min gap', () => {
    const rects = [r('a', 0, 0), r('b', 50, 0), r('c', 400, 0)]
    const m = computeMetrics(rects, [])
    expect(m.nodeOverlaps).toBe(1) // a & b overlap
    expect(m.minGap).toBeLessThan(0)
  })

  it('counts edge crossings between independent edges', () => {
    const rects = [r('a', 0, 0), r('b', 200, 0), r('c', 0, 200), r('d', 200, 200)]
    // a→d and c→b cross in the middle; they share no node.
    const edges: EdgeGeom[] = [
      { id: 'e1', fromId: 'a', toId: 'd', points: [{ x: 50, y: 30 }, { x: 250, y: 230 }] },
      { id: 'e2', fromId: 'c', toId: 'b', points: [{ x: 50, y: 230 }, { x: 250, y: 30 }] },
    ]
    expect(computeMetrics(rects, edges).edgeCrossings).toBe(1)
  })

  it('counts an edge cutting through an unrelated node', () => {
    const rects = [r('a', 0, 0), r('mid', 130, 0), r('b', 300, 0)]
    const edges: EdgeGeom[] = [
      { id: 'e', fromId: 'a', toId: 'b', points: [{ x: 50, y: 30 }, { x: 350, y: 30 }] },
    ]
    expect(computeMetrics(rects, edges).edgeNodeOverlaps).toBe(1) // passes through 'mid'
  })
})
