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
import { assignAnchors, slotsFor, type AnchorEdge } from './ports'
import { type Box } from './geometry'

const box = (x: number, y: number, w = 100, h = 60): Box => ({ x, y, width: w, height: h })

describe('slotsFor', () => {
  it('distributes k endpoints across the 3 ratio slots', () => {
    expect(slotsFor(1)).toEqual([1]) // center
    expect(slotsFor(2)).toEqual([0, 2]) // near + far
    expect(slotsFor(3)).toEqual([0, 1, 2]) // all three
    expect(slotsFor(4)).toHaveLength(4)
    expect(slotsFor(5).every((s) => s >= 0 && s <= 2)).toBe(true)
  })
})

describe('assignAnchors — hub fan-out', () => {
  it('distributes 3 edges leaving the same (right) side across slots 3,4,5', () => {
    // Hub A on the left; three targets to its right at different heights.
    const rects = new Map<string, Box>([
      ['A', box(0, 100)],
      ['B', box(400, 0)],
      ['C', box(400, 100)],
      ['D', box(400, 200)],
    ])
    const edges: AnchorEdge[] = [
      { id: 'e1', fromId: 'A', toId: 'B' },
      { id: 'e2', fromId: 'A', toId: 'C' },
      { id: 'e3', fromId: 'A', toId: 'D' },
    ]
    const res = assignAnchors(rects, edges)
    const fromAnchors = [res.get('e1')!.fromAnchor, res.get('e2')!.fromAnchor, res.get('e3')!.fromAnchor]
    // Right side anchors are 3,4,5 — all three distinct, all on the right side (shared side).
    expect(new Set(fromAnchors)).toEqual(new Set([3, 4, 5]))
    // Targets each receive only ONE edge on their left side → left UNLOCKED (undefined)
    // so the edge raycasts a centre-facing endpoint and runs straight.
    expect(res.get('e1')!.toAnchor).toBeUndefined()
    expect(res.get('e2')!.toAnchor).toBeUndefined()
    expect(res.get('e3')!.toAnchor).toBeUndefined()
  })

  it('leaves a single 1:1 edge fully unlocked (no anchor on either side)', () => {
    const rects = new Map<string, Box>([
      ['A', box(0, 0)],
      ['B', box(400, 0)],
    ])
    const res = assignAnchors(rects, [{ id: 'e', fromId: 'A', toId: 'B' }])
    // Neither side is shared → both endpoints stay unlocked for raycast routing.
    expect(res.get('e')!.fromAnchor).toBeUndefined()
    expect(res.get('e')!.toAnchor).toBeUndefined()
  })

  it('leaves a shared side unlocked when the raycast endpoints already separate', () => {
    // A with two targets to its right at strongly different heights: the natural
    // raycast points on A's right border sit ~50px apart (≥ the cluster tolerance),
    // so there is no spray to fix — pinning them to the 0.2/0.8 ports would only
    // move both endpoints off their natural lines and bow the edges into S-curves.
    const rects = new Map<string, Box>([
      ['A', box(0, 200)],
      ['B', box(400, 0)],
      ['C', box(400, 400)],
    ])
    const res = assignAnchors(rects, [
      { id: 'e1', fromId: 'A', toId: 'B' },
      { id: 'e2', fromId: 'A', toId: 'C' },
    ])
    expect(res.get('e1')!.fromAnchor).toBeUndefined()
    expect(res.get('e2')!.fromAnchor).toBeUndefined()
    expect(res.get('e1')!.toAnchor).toBeUndefined()
    expect(res.get('e2')!.toAnchor).toBeUndefined()
  })

  it('fans a shared side whose raycast endpoints collide', () => {
    // Both targets lie in nearly the same direction from A → the natural raycast
    // points land ~1px apart on A's right border (genuine spray) → distribute.
    const rects = new Map<string, Box>([
      ['A', box(0, 100)],
      ['B', box(400, 100)],
      ['C', box(560, 110)],
    ])
    const res = assignAnchors(rects, [
      { id: 'e1', fromId: 'A', toId: 'B' },
      { id: 'e2', fromId: 'A', toId: 'C' },
    ])
    const fromAnchors = [res.get('e1')!.fromAnchor, res.get('e2')!.fromAnchor]
    expect(fromAnchors.every((a) => a !== undefined && a >= 3 && a <= 5)).toBe(true)
    expect(new Set(fromAnchors).size).toBe(2) // distinct ports, not one point
  })

  it('respects an explicit sideOf override (ELK ports) on a shared side', () => {
    // Two edges forced onto A's bottom side → that side is shared, so it distributes
    // across the overridden (bottom) anchors, proving the override side is honoured.
    const rects = new Map<string, Box>([
      ['A', box(0, 0)],
      ['B', box(300, 0)],
      ['C', box(500, 0)],
    ])
    const res = assignAnchors(
      rects,
      [
        { id: 'e1', fromId: 'A', toId: 'B' },
        { id: 'e2', fromId: 'A', toId: 'C' },
      ],
      { sideOf: (_id, end) => (end === 'from' ? 'bottom' : 'top') },
    )
    const fromAnchors = [res.get('e1')!.fromAnchor, res.get('e2')!.fromAnchor]
    // Bottom-side anchors are 6,7,8 — both assigned edges land on the bottom side.
    expect(fromAnchors.every((a) => a !== undefined && a >= 6 && a <= 8)).toBe(true)
    expect(new Set(fromAnchors).size).toBe(2) // distinct slots
    // Each target still has a single edge on its top side → unlocked.
    expect(res.get('e1')!.toAnchor).toBeUndefined()
  })
})
