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

// Regressions written by the QA review lens (2026-10-22): each test kills a
// mutant that survived the rest of the layout suite.

import { describe, it, expect } from 'vitest'
import { buildLayoutGraph, deriveGroupBoxes, nestGroups } from './graph'
import { layoutDiagram, bestLayout } from './index'
import { layoutDiagramElk } from './elk/elkLayout'
import { STRATEGIES } from './elk/elkConfig'
import { assignAnchors, type AnchorEdge } from './ports'
import { connectionGeometry, type Box } from './geometry'
import { computeMetrics, segmentsCross, type Rect } from './metrics'
import { sizeGroupBoxes } from '../structurizr/json/mapWorkspace'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import type { C4Object, Connection, Diagram, Group } from '../../types'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'

const object = (id: string, type = 'app'): C4Object =>
  ({ id, type, name: id, position: { x: 0, y: 0 }, size: { width: 150, height: 90 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }) as unknown as C4Object
const link = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid', label: 'uses' })
const view = (objectIds: string[], connectionIds: string[], groupIds: string[]) =>
  ({ id: 'v', name: 'v', type: 'container', objectIds, connectionIds, groupIds, layouts: {} }) as unknown as Diagram
const group = (id: string, objectIds: string[], extra: Partial<Group> = {}): Group =>
  ({ id, name: id, color: '#fff', objectIds, ...extra }) as Group
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const boxOf = (layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>, id: string): Box => {
  const l = layouts[id]
  return { x: l.position.x, y: l.position.y, width: l.size.width, height: l.size.height }
}

describe('nestGroups — a three-level chain', () => {
  it('gives the innermost group its IMMEDIATE parent, not the outermost', () => {
    const d = view(['a', 'b', 'c'], [], ['o', 'm', 'i'])
    const n = nestGroups(d, [group('o', ['a', 'b', 'c']), group('m', ['a', 'b']), group('i', ['a'])], new Set(['a', 'b', 'c']))
    expect(n.compoundParent.get('m')).toBe('o')
    expect(n.compoundParent.get('i')).toBe('m')
  })
})

describe('deriveGroupBoxes — the same box the JSON importer sizes (sizeGroupBoxes fresh)', () => {
  const objectBoxes = new Map<string, Box>([
    ['a', { x: 0, y: 200, width: 100, height: 60 }],
    ['b', { x: 300, y: 320, width: 100, height: 60 }],
  ])
  const layouts = Object.fromEntries([...objectBoxes].map(([id, b]) => [id, { position: { x: b.x, y: b.y }, size: { width: b.width, height: b.height } }]))
  for (const [label, g] of [
    ['a standard group', group('g', ['a', 'b'])],
    ['a standard group titled wider than its content', group('g', ['a'], { name: 'A deliberately long group title that is far wider than its member' })],
    ['a parent wrapper', group('g', ['a', 'b'], { name: 'Internet Banking System', type: 'Software System', parentObjectId: 'sys' })],
  ] as const) {
    it(label, () => {
      const d = view(['a', 'b'], [], ['g'])
      const derived = deriveGroupBoxes(nestGroups(d, [g], new Set(['a', 'b'])), [g], objectBoxes).get('g')!
      expect(derived).toEqual(boxOf(sizeGroupBoxes([g], layouts, 'fresh'), 'g'))
    })
  }
})

describe('deriveGroupBoxes — nested inline-expansion wrappers', () => {
  it('draws a parent wrapper around the wrappers named in innerWrapperIds', () => {
    const objectBoxes = new Map<string, Box>([
      ['a', { x: 0, y: 200, width: 100, height: 60 }],
      ['b', { x: 0, y: 300, width: 100, height: 60 }],
    ])
    const inner = group('inner', ['a'], { parentObjectId: 'c', name: 'inner' })
    const outer = group('outer', ['a', 'b'], { parentObjectId: 's', name: 'outer', innerWrapperIds: ['inner'] })
    const groups = [outer, inner]
    const boxes = deriveGroupBoxes(nestGroups(view(['a', 'b'], [], ['outer', 'inner']), groups, new Set(['a', 'b'])), groups, objectBoxes)
    const o = boxes.get('outer')!
    const i = boxes.get('inner')!
    expect(o.y).toBeLessThan(i.y)
    expect(o.x).toBeLessThan(i.x)
  })

  // The QA lens's open hypothesis, settled: an inner wrapper with the SAME
  // members as its outer one, listed first, makes membership order the outer one
  // deeper — it must still be sized around the inner box.
  it('encloses an inner wrapper with the same members, whatever the list order', () => {
    const objectBoxes = new Map<string, Box>([
      ['a', { x: 0, y: 200, width: 100, height: 60 }],
      ['b', { x: 0, y: 300, width: 100, height: 60 }],
    ])
    const inner = group('inner', ['a', 'b'], { parentObjectId: 'c', name: 'inner' })
    const outer = group('outer', ['a', 'b'], { parentObjectId: 's', name: 'outer', innerWrapperIds: ['inner'] })
    const groups = [inner, outer]
    const boxes = deriveGroupBoxes(nestGroups(view(['a', 'b'], [], ['inner', 'outer']), groups, new Set(['a', 'b'])), groups, objectBoxes)
    expect(boxes.get('outer')!.y).toBeLessThan(boxes.get('inner')!.y)
  })
})

describe('buildLayoutGraph — an undrawn twin gets no lane', () => {
  it('keeps only the drawn connection when the second on the pair is not on this diagram', () => {
    const objects = new Map([object('a'), object('b')].map((o) => [o.id, o]))
    const d = view(['a', 'b'], ['c1'], [])
    const edges = buildLayoutGraph(d, objects, [], [link('c1', 'a', 'b'), link('c2', 'a', 'b')]).edges
    expect(edges.map((e) => e.id)).toEqual(['c1'])
  })
})

describe('custom engine — people first', () => {
  it('puts a notified person above the system that notifies it', () => {
    const objects = [object('p', 'actor'), object('s')]
    const connections = [link('e', 's', 'p')]
    const sol = layoutDiagram(view(['p', 's'], ['e'], []), { objects, connections, groups: [] }, 'tb')
    const p = boxOf(sol.layouts, 'p')
    const s = boxOf(sol.layouts, 's')
    expect(p.y + p.height).toBeLessThanOrEqual(s.y)
  })
})

describe('ELK DOWN candidates — a title wider than its group', () => {
  // The selection-level test passes whatever the DOWN candidates look like, because
  // the straddle score steers selection away from a bad one. Check the candidates.
  it('no DOWN strategy widens a group box over its neighbour', async () => {
    const long = 'A deliberately long group title that is far wider than its member'
    const objects = ['hub', 'm1', 'm2', 's1', 's2', 's3'].map((id) => object(id))
    const connections = ['m1', 'm2', 's1', 's2', 's3'].map((to, i) => link(`e${i}`, 'hub', to))
    const groups = [group('g1', ['m1'], { name: long, autoSize: false }), group('g2', ['m2'], { name: `${long}!`, autoSize: false })]
    const d = view(objects.map((o) => o.id), connections.map((c) => c.id), ['g1', 'g2'])
    for (const s of STRATEGIES.filter((x) => x.direction === 'DOWN')) {
      const sol = (await layoutDiagramElk(d, { objects, connections, groups }, s))!
      const g1 = boxOf(sol.layouts, 'g1')
      const g2 = boxOf(sol.layouts, 'g2')
      expect(overlaps(g1, g2), `${s.id}: g1 over g2`).toBe(false)
      for (const id of ['hub', 'm2', 's1', 's2', 's3']) expect(overlaps(boxOf(sol.layouts, id), g1), `${s.id}: ${id} in g1`).toBe(false)
    }
  })
})

describe('assignAnchors — a reciprocal pair on a diagonal', () => {
  it('splits the pair at BOTH nodes when the ends leave by different axes (lanes)', () => {
    // Found by a seeded random sweep: without lanes the two like ends on one node
    // land on the same point here (a braided line); with lanes they are apart.
    const rects = new Map<string, Box>([
      ['A', { x: 0, y: 0, width: 135, height: 79 }],
      ['B', { x: 158, y: 388, width: 44, height: 157 }],
    ])
    const edges: AnchorEdge[] = [
      { id: 'c1', fromId: 'A', toId: 'B' },
      { id: 'c2', fromId: 'B', toId: 'A' },
    ]
    const res = assignAnchors(rects, edges)
    const line = (e: AnchorEdge) =>
      connectionGeometry(rects.get(e.fromId)!, rects.get(e.toId)!, { ...res.get(e.id), lockedToAnchors: true }).polyline
    const l1 = line(edges[0])
    const l2 = line(edges[1])
    const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
    expect(gap(l1[0], l2[l2.length - 1]), 'like ends on A').toBeGreaterThanOrEqual(8)
    expect(gap(l1[l1.length - 1], l2[0]), 'like ends on B').toBeGreaterThanOrEqual(8)
    let crossed = false
    for (let i = 0; i + 1 < l1.length; i++) for (let j = 0; j + 1 < l2.length; j++) if (segmentsCross(l1[i], l1[i + 1], l2[j], l2[j + 1])) crossed = true
    expect(crossed).toBe(false)
  })
})

describe('assignAnchors — a reciprocal pair leaving through a corner', () => {
  // From the seeded sweep (2026-10-22): both ends at A were free, aimed at two of
  // B's adjacent ports, and their raycasts left A through its TOP and RIGHT sides
  // 4–8 px apart — each side solved alone saw one endpoint and no collision.
  const like = (rects: Map<string, Box>) => {
    const edges: AnchorEdge[] = [
      { id: 'c1', fromId: 'A', toId: 'B' },
      { id: 'c2', fromId: 'B', toId: 'A' },
    ]
    const res = assignAnchors(rects, edges)
    const line = (e: AnchorEdge) =>
      connectionGeometry(rects.get(e.fromId)!, rects.get(e.toId)!, { ...res.get(e.id), lockedToAnchors: true }).polyline
    const l1 = line(edges[0])
    const l2 = line(edges[1])
    const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
    return { atA: gap(l1[0], l2[l2.length - 1]), atB: gap(l1[l1.length - 1], l2[0]) }
  }
  for (const [label, A, B] of [
    ['up-right', { x: 0, y: 0, width: 176, height: 204 }, { x: 450, y: -447, width: 172, height: 44 }],
    ['up, narrow', { x: 0, y: 0, width: 44, height: 155 }, { x: 84, y: -430, width: 79, height: 159 }],
    ['up-left', { x: 0, y: 0, width: 79, height: 79 }, { x: -413, y: -392, width: 151, height: 189 }],
  ] as const) {
    it(`splits the pair at both nodes — ${label}`, () => {
      const { atA, atB } = like(new Map<string, Box>([['A', A], ['B', B]]))
      expect(atA, 'like ends on A').toBeGreaterThanOrEqual(8)
      expect(atB, 'like ends on B').toBeGreaterThanOrEqual(8)
    })
  }

  // The sweep ports.ts cites. Before the corner rule, 29 of these pairs had like
  // ends within 8 px at a node and 1 pair crossed; moving EVERY parallel pair onto
  // the facing side instead gave 3 near-touching and 11 crossed (2026-10-22).
  it('seeded sweep of random two-box reciprocal pairs: none near-touching, at most 3 crossed', () => {
    let seed = 12345
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const size = () => 40 + Math.round(random() * 200)
    let pairs = 0
    let near = 0
    let crossed = 0
    for (let k = 0; k < 2000; k++) {
      const A: Box = { x: 0, y: 0, width: size(), height: size() }
      const B: Box = { x: Math.round((random() - 0.5) * 900), y: Math.round((random() - 0.5) * 900), width: size(), height: size() }
      if (A.x < B.x + B.width + 40 && A.x + A.width + 40 > B.x && A.y < B.y + B.height + 40 && A.y + A.height + 40 > B.y) continue
      pairs++
      const rects = new Map<string, Box>([['A', A], ['B', B]])
      const edges: AnchorEdge[] = [{ id: 'c1', fromId: 'A', toId: 'B' }, { id: 'c2', fromId: 'B', toId: 'A' }]
      const res = assignAnchors(rects, edges)
      const line = (e: AnchorEdge) =>
        connectionGeometry(rects.get(e.fromId)!, rects.get(e.toId)!, { ...res.get(e.id), lockedToAnchors: true }).polyline
      const [l1, l2] = [line(edges[0]), line(edges[1])]
      const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
      if (Math.min(gap(l1[0], l2[l2.length - 1]), gap(l1[l1.length - 1], l2[0])) < 8) near++
      let crosses = false
      for (let i = 0; i + 1 < l1.length && !crosses; i++) {
        for (let j = 0; j + 1 < l2.length; j++) if (segmentsCross(l1[i], l1[i + 1], l2[j], l2[j + 1])) crosses = true
      }
      if (crosses) crossed++
    }
    expect(pairs, 'the sample itself').toBe(1677)
    expect(near, 'like ends within 8 px at a node').toBe(0)
    expect(crossed, 'pairs whose two lines cross').toBeLessThanOrEqual(3)
  })
})

describe('metrics — the crowding threshold sits between the engines’ spacings', () => {
  const r = (id: string, x: number, y: number): Rect => ({ id, x, y, width: 150, height: 90 })
  it('40px (boundary interiors, isolated grid) is not crowded; 20px is', () => {
    expect(computeMetrics([r('a', 0, 0), r('b', 190, 0)], []).localDensity).toBe(0)
    expect(computeMetrics([r('a', 0, 0), r('b', 170, 0)], []).localDensity).toBe(1)
  })
})

describe('portfolio — the wrapped strategies earn their place', () => {
  // Measured by the author: dropping every wrapped strategy took saoe
  // AzureObservabilityFlow from 21 to 33.
  it('saoe AzureObservabilityFlow stays near its wrapped score', async () => {
    let n = 0
    const m = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
    const d = m.diagrams.find((x) => x.name === 'AzureObservabilityFlow')!
    const sol = await bestLayout(d, { objects: m.objects, connections: m.connections, groups: m.groups })
    console.log('QAPROBE AzureObservabilityFlow', sol.source, sol.metrics.score)
    expect(sol.metrics.score).toBeLessThan(27)
  })
})
