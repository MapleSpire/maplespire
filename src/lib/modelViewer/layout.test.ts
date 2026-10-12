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
import { computeViewerLayout, tileFocal } from './layout'
import { computeEdgeAnchors, edgePath, sidesFor } from './edgeGeometry'
import type { C4Object } from '../../types'

const obj = (id: string): C4Object => ({
  id,
  type: 'system',
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 160, height: 100 },
  tagAssignments: {}, tagOrder: [], scope: 'internal',
  status: 'live',
  properties: {},
})

const AREA = { x: 24, y: 18, w: 1200, h: 700 }
const OPTS = { density: 'comfortable' as const }

describe('viewer grid layout', () => {
  it('is deterministic and keeps every tile inside the world box', () => {
    const kids = Array.from({ length: 7 }, (_, i) => obj(`o${i}`))
    const a = computeViewerLayout(kids, null, AREA, OPTS)
    const b = computeViewerLayout(kids, null, AREA, OPTS)
    expect(a.tiles.map((t) => [t.id, t.x, t.y])).toEqual(b.tiles.map((t) => [t.id, t.x, t.y]))
    for (const t of a.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.x + t.w).toBeLessThanOrEqual(a.worldW + 1e-6)
      expect(t.y + t.h).toBeLessThanOrEqual(a.worldH + 1e-6)
    }
  })

  it('centers a short last row', () => {
    // 5 tiles in a 3-col grid → last row of 2, inset by half a column
    const kids = Array.from({ length: 5 }, (_, i) => obj(`o${i}`))
    const L = computeViewerLayout(kids, null, { x: 0, y: 0, w: 900, h: 700 }, OPTS)
    const rows = new Map<number, number[]>()
    for (const t of L.tiles) {
      const arr = rows.get(t.y) ?? []
      arr.push(t.x)
      rows.set(t.y, arr)
    }
    const ys = [...rows.keys()].sort((a, b) => a - b)
    const firstRow = rows.get(ys[0])!
    const lastRow = rows.get(ys[ys.length - 1])!
    if (lastRow.length < firstRow.length) {
      expect(Math.min(...lastRow)).toBeGreaterThan(Math.min(...firstRow))
    }
  })

  it('reserves boundary chrome only when drilled inside a parent', () => {
    const kids = [obj('a'), obj('b')]
    const root = computeViewerLayout(kids, null, AREA, OPTS)
    const drilled = computeViewerLayout(kids, 'parent', AREA, OPTS)
    expect(root.padT).toBe(0)
    expect(root.hasBoundary).toBe(false)
    expect(drilled.padT).toBeGreaterThan(100)
    expect(drilled.padX).toBeGreaterThan(0)
    expect(drilled.hasBoundary).toBe(true)
    expect(drilled.fullH).toBe(drilled.worldH + drilled.padT + drilled.padB)
  })

  it('scales down to fit a small area and never above 1.12', () => {
    const many = Array.from({ length: 40 }, (_, i) => obj(`o${i}`))
    const small = computeViewerLayout(many, null, { x: 0, y: 0, w: 500, h: 400 }, OPTS)
    expect(small.scale).toBeLessThan(1)
    expect(small.fullW * small.scale).toBeLessThanOrEqual(500 + 1e-6)
    const one = computeViewerLayout([obj('solo')], null, AREA, OPTS)
    expect(one.scale).toBeLessThanOrEqual(1.12)
  })

  it('tileFocal returns the tile centre in screen coords (the zoom focal point)', () => {
    const kids = [obj('a'), obj('b')]
    const L = computeViewerLayout(kids, null, AREA, OPTS)
    const t = L.byId.get('a')!
    const f = tileFocal(L, 'a')!
    expect(f.x).toBeCloseTo(L.ox + (L.padX + t.cx) * L.scale, 6)
    expect(f.y).toBeCloseTo(L.oy + (L.padT + t.cy) * L.scale, 6)
    expect(tileFocal(L, 'missing')).toBeNull()
  })
})

describe('viewer edge geometry', () => {
  const tile = (id: string, x: number, y: number) => ({
    id,
    o: obj(id),
    x,
    y,
    w: 170,
    h: 150,
    cx: x + 85,
    cy: y + 75,
  })

  it('anchors on facing sides by dominant axis', () => {
    const a = tile('a', 0, 0)
    expect(sidesFor(a, tile('b', 400, 0))).toEqual(['r', 'l'])
    expect(sidesFor(a, tile('b', -400, 0))).toEqual(['l', 'r'])
    expect(sidesFor(a, tile('b', 0, 400))).toEqual(['b', 't'])
    expect(sidesFor(a, tile('b', 0, -400))).toEqual(['t', 'b'])
  })

  it('produces the three routings with a midpoint label anchor', () => {
    const a = tile('a', 0, 0)
    const b = tile('b', 400, 0)
    // paths stop ARROW_TRIM (9px) short of the target side — the arrowhead
    // (tip drawn at the tile edge) caps the line instead of poking through it
    const straight = edgePath(a, b, 'straight')
    expect(straight.d).toBe('M170,75 L391,75')
    expect(straight.mid).toEqual([280.5, 75])
    const orth = edgePath(a, b, 'orthogonal')
    expect(orth.d).toContain('H280.5')
    const curved = edgePath(a, b, 'curved')
    expect(curved.d.startsWith('M170,75 C')).toBe(true)
    // horizontal symmetric curve: the midpoint sits halfway between endpoints
    expect(curved.mid[0]).toBeCloseTo(280.5, 6)
    expect(curved.mid[1]).toBeCloseTo(75, 6)
  })

  it('fans out edges sharing a tile side instead of stacking arrowheads (USER BUG)', () => {
    // hub in the middle, two sources to its left (one above, one below): both
    // edges land on the hub's LEFT side and must not share the anchor point
    const hub = tile('hub', 400, 150)
    const top = tile('top', 0, 0)
    const bottom = tile('bottom', 0, 300)
    const byId = new Map([
      ['hub', hub],
      ['top', top],
      ['bottom', bottom],
    ])
    const anchors = computeEdgeAnchors(
      [
        { id: 'c1', fromId: 'top', toId: 'hub' },
        { id: 'c2', fromId: 'bottom', toId: 'hub' },
      ],
      byId
    )
    const a1 = anchors.get('c1')!
    const a2 = anchors.get('c2')!
    expect(a1.ts).toBe('l')
    expect(a2.ts).toBe('l')
    expect(a1.p2[0]).toBe(400) // both on the left edge…
    expect(a2.p2[0]).toBe(400)
    expect(a1.p2[1]).not.toBe(a2.p2[1]) // …but fanned apart vertically
    // ordered by the far endpoint: the edge from the higher tile lands higher
    expect(a1.p2[1]).toBeLessThan(a2.p2[1])
    // slots at (i+1)/(n+1): 1/3 and 2/3 of the side
    expect(a1.p2[1]).toBeCloseTo(150 + 150 / 3, 6)
    expect(a2.p2[1]).toBeCloseTo(150 + 300 / 3, 6)
    // sources keep their single-edge midpoint anchors
    expect(a1.p1).toEqual([170, 75])
    expect(a2.p1).toEqual([170, 375])
  })

  it('separates an A→B / B→A pair deterministically', () => {
    const a = tile('a', 0, 0)
    const b = tile('b', 400, 0)
    const byId = new Map([
      ['a', a],
      ['b', b],
    ])
    const anchors = computeEdgeAnchors(
      [
        { id: 'ab', fromId: 'a', toId: 'b' },
        { id: 'ba', fromId: 'b', toId: 'a' },
      ],
      byId
    )
    const ab = anchors.get('ab')!
    const ba = anchors.get('ba')!
    // the two opposite edges no longer overlap on the same line
    expect(ab.p1[1]).not.toBe(ba.p2[1])
    expect(ab.p2[1]).not.toBe(ba.p1[1])
  })
})
