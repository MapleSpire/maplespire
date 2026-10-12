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
import { applyAutoLayout, measureDiagram, type LayoutContext } from './index'
import { analyzeGraphComplexity, packIsolatedBelow, splitIsolatedNodes } from './graph'
import type { C4Object, Connection, Diagram } from '../../types'
import type { Box } from './geometry'

// The disconnected-field treatment: degree-0 nodes must NOT be strung into a one-row
// sliver by the layered engines (a 60-node/31-edge component view otherwise lays
// out at ~8:1); they pack into an aspect-aware grid below the wired content. And a
// re-layout OWNS connection anchor state: stale anchors from an earlier run (or a
// user drag) must be cleared, never resurrected.

const SIZE = { width: 180, height: 110 }
function obj(id: string): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { ...SIZE },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  } as C4Object
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}

describe('auto-layout — disconnected component field', () => {
  it('packs isolated nodes into a grid below the wired content (no sliver)', async () => {
    const wired = ['a', 'b', 'c']
    const isolatedIds = Array.from({ length: 18 }, (_, i) => `iso${i}`)
    const objects = [...wired, ...isolatedIds].map(obj)
    const connections = [conn('e1', 'a', 'b'), conn('e2', 'b', 'c')]
    const diagram: Diagram = {
      id: 'd', name: 'D', type: 'container',
      objectIds: objects.map((o) => o.id), connectionIds: ['e1', 'e2'], groupIds: [],
    }
    const ctx: LayoutContext = { objects, connections, groups: [] }
    const res = await applyAutoLayout([diagram], ctx)
    const d = res.diagrams[0]

    for (const o of objects) expect(d.layouts?.[o.id], `layout for ${o.id}`).toBeDefined()

    // The page reads as a page, not a strip (the old behaviour was aspect ≈ 8).
    const boxes = objects.map((o) => ({ ...d.layouts![o.id].position, ...d.layouts![o.id].size }))
    const w = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x))
    const h = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y))
    expect(w / h).toBeGreaterThan(0.4)
    expect(w / h).toBeLessThan(3.2)

    // The isolated field sits strictly BELOW the wired content.
    const wiredMaxY = Math.max(...wired.map((id) => d.layouts![id].position.y + d.layouts![id].size.height))
    for (const id of isolatedIds) {
      expect(d.layouts![id].position.y, `${id} below the wired content`).toBeGreaterThan(wiredMaxY)
    }

    // Hard structural gates still hold over the combined page.
    const { metrics } = measureDiagram(d, { objects, connections: res.connections, groups: [] })
    expect(metrics.nodeOverlaps).toBe(0)
    expect(metrics.minGap).toBeGreaterThan(0)
    expect(metrics.edgeNodeOverlaps).toBe(0)
  })

  it('keeps group members in the layered graph even at degree 0', () => {
    const nodes = [
      { id: 'a', width: 180, height: 110 },
      { id: 'freeIso', width: 180, height: 110 },
      { id: 'groupedIso', width: 180, height: 110 },
    ]
    const edges = [{ id: 'e', fromId: 'a', toId: 'a' }] // self-loop → everyone degree 0
    const { connected, isolated } = splitIsolatedNodes(nodes, edges, new Set(['groupedIso']))
    expect(isolated.map((n) => n.id).sort()).toEqual(['a', 'freeIso'])
    expect(connected.map((n) => n.id)).toEqual(['groupedIso'])
  })

  it('grid packing targets the 1.6 page aspect when there is no wired content', () => {
    const isolated = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, width: 180, height: 110 }))
    const out = new Map<string, Box>()
    packIsolatedBelow(isolated, null, out)
    expect(out.size).toBe(12)
    const boxes = [...out.values()]
    const w = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x))
    const h = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y))
    expect(w / h).toBeGreaterThan(0.8)
    expect(w / h).toBeLessThan(2.6)
    // Uniform cells → columns share exact x, rows share exact y (aligned by construction).
    const xs = new Set(boxes.map((b) => b.x))
    const ys = new Set(boxes.map((b) => b.y))
    expect(xs.size * ys.size).toBeGreaterThanOrEqual(12)
    expect(xs.size).toBeLessThan(12)
  })

  it('reports the complexity profile the ELK parameters adapt to', () => {
    const nodes = ['a', 'b', 'c', 'd', 'iso1', 'iso2'].map((id) => ({ id, width: 10, height: 10 }))
    const edges = [
      { id: 'e1', fromId: 'a', toId: 'b' },
      { id: 'e2', fromId: 'c', toId: 'd' },
      { id: 'e3', fromId: 'a', toId: 'd' },
    ]
    const cx = analyzeGraphComplexity(nodes, edges)
    expect(cx).toMatchObject({ nodeCount: 6, edgeCount: 3, isolatedCount: 2, componentCount: 1, maxDegree: 2 })
    expect(cx.density).toBeCloseTo(0.75)
  })
})

describe('auto-layout — re-layout owns connection anchor state', () => {
  it('clears stale anchors the new layout does not assign', async () => {
    const objects = ['a', 'b'].map(obj)
    // Junk carried over from an earlier layout / a user drag: both ends pinned to
    // ports the current geometry would never pick, plus a leftover waypoint.
    const connections = [
      conn('e1', 'a', 'b', { fromAnchor: 9, toAnchor: 3, lockedToAnchors: true, waypoints: [{ x: 1, y: 1 }] }),
    ]
    const diagram: Diagram = {
      id: 'd', name: 'D', type: 'container', objectIds: ['a', 'b'], connectionIds: ['e1'], groupIds: [],
    }
    const res = await applyAutoLayout([diagram], { objects, connections, groups: [] })
    const c = res.connections.find((x) => x.id === 'e1')!
    // A 1:1 edge stays fully unlocked — and the stale ports are GONE, not kept for
    // the next partial lock to resurrect.
    expect(c.lockedToAnchors).toBe(false)
    expect(c.fromAnchor).toBeUndefined()
    expect(c.toAnchor).toBeUndefined()
  })
})
