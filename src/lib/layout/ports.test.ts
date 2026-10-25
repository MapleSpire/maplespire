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
import { assignAnchors, type AnchorAssignment, type AnchorEdge } from './ports'
import { connectionGeometry, resolveEndpoints, type Box, type Pt } from './geometry'
import { segmentsCross } from './metrics'

const box = (x: number, y: number, w = 100, h = 60): Box => ({ x, y, width: w, height: h })

/** The endpoints the canvas draws for an edge under an assignment. */
const drawn = (rects: Map<string, Box>, e: AnchorEdge, a: AnchorAssignment | undefined) => {
  const locked = a?.fromAnchor !== undefined || a?.toAnchor !== undefined
  return resolveEndpoints(rects.get(e.fromId)!, rects.get(e.toId)!, {
    fromAnchor: a?.fromAnchor,
    toAnchor: a?.toAnchor,
    lockedToAnchors: locked,
  })
}

/** Every drawn attachment point on `nodeId`. */
const attachments = (rects: Map<string, Box>, edges: AnchorEdge[], res: Map<string, AnchorAssignment>, nodeId: string): Pt[] => {
  const out: Pt[] = []
  for (const e of edges) {
    const { fromEdge, toEdge } = drawn(rects, e, res.get(e.id))
    if (e.fromId === nodeId) out.push(fromEdge)
    if (e.toId === nodeId) out.push(toEdge)
  }
  return out
}

const minPairDistance = (pts: Pt[]) => {
  let min = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y))
  }
  return min
}

describe('assignAnchors — hub fan-out', () => {
  it('distributes 3 edges leaving the same (right) side across ports 3,4,5', () => {
    // Hub A (tall enough that its ports sit farther apart than the cluster
    // tolerance) with three targets far to its right: the natural raycast points
    // land within ~3px of each other on A's right border → genuine spray.
    const rects = new Map<string, Box>([
      ['A', box(0, 100, 100, 160)],
      ['B', box(1200, 110)],
      ['C', box(1200, 150)],
      ['D', box(1200, 190)],
    ])
    const edges: AnchorEdge[] = [
      { id: 'e1', fromId: 'A', toId: 'B' },
      { id: 'e2', fromId: 'A', toId: 'C' },
      { id: 'e3', fromId: 'A', toId: 'D' },
    ]
    const res = assignAnchors(rects, edges)
    // The outer two take the outer right ports (3, 5); the middle one already sits on
    // the centre port's point, so it may stay free — pinning it would change nothing.
    expect(res.get('e1')!.fromAnchor).toBe(3)
    expect(res.get('e3')!.fromAnchor).toBe(5)
    expect([undefined, 4]).toContain(res.get('e2')!.fromAnchor)
    const onA = attachments(rects, edges, res, 'A')
    expect(onA.every((p) => p.x === 100)).toBe(true) // all on A's right border
    expect(minPairDistance(onA)).toBeGreaterThanOrEqual(15) // no spray left
    // Targets each receive only ONE edge on their left side → left UNLOCKED (undefined)
    // so the edge raycasts a centre-facing endpoint and runs straight.
    expect(res.get('e1')!.toAnchor).toBeUndefined()
    expect(res.get('e2')!.toAnchor).toBeUndefined()
    expect(res.get('e3')!.toAnchor).toBeUndefined()
  })

  // The original hub geometry (100×60 boxes) and a 150×90 hub (actor/component
  // height): both have ports closer together than the diagram-wide tolerance, which
  // made the solver call "three ports" as colliding as "one point" and leave a real
  // spray unpinned. Each side must still end up with distinct attachments.
  for (const [label, hub, targets] of [
    ['100×60 hub, targets at three heights', box(0, 100), [box(400, 0), box(400, 100), box(400, 200)]],
    ['150×90 hub, targets far right at near-same height', box(0, 100, 150, 90), [box(1200, 80, 150, 90), box(1200, 100, 150, 90), box(1200, 120, 150, 90)]],
  ] as const) {
    it(`fans a spray on a side whose ports sit inside the tolerance (${label})`, () => {
      const rects = new Map<string, Box>([['A', hub], ['B', targets[0]], ['C', targets[1]], ['D', targets[2]]])
      const edges: AnchorEdge[] = [
        { id: 'e1', fromId: 'A', toId: 'B' },
        { id: 'e2', fromId: 'A', toId: 'C' },
        { id: 'e3', fromId: 'A', toId: 'D' },
      ]
      const res = assignAnchors(rects, edges)
      expect(res.get('e1')!.fromAnchor).toBe(3)
      expect(res.get('e3')!.fromAnchor).toBe(5)
      const onA = attachments(rects, edges, res, 'A')
      // Ports on a side of height h sit 0.3·(h−16) apart: 13.2px at 60, 22.2px at 90.
      expect(minPairDistance(onA)).toBeGreaterThanOrEqual(0.3 * (hub.height - 16) - 0.01)
    })
  }

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
    const edges: AnchorEdge[] = [
      { id: 'e1', fromId: 'A', toId: 'B' },
      { id: 'e2', fromId: 'A', toId: 'C' },
    ]
    const res = assignAnchors(rects, edges)
    // At least one end is pinned to a right-side port; the other may stay free when
    // its natural point already sits on the centre port's spot.
    const fromAnchors = [res.get('e1')!.fromAnchor, res.get('e2')!.fromAnchor].filter((a) => a !== undefined)
    expect(fromAnchors.length).toBeGreaterThanOrEqual(1)
    expect(fromAnchors.every((a) => a! >= 3 && a! <= 5)).toBe(true)
    const onA = attachments(rects, edges, res, 'A')
    expect(onA.every((p) => p.x === 100)).toBe(true)
    // Distinct points, not one: at least the side's port spacing apart (0.3·(60−16)).
    expect(minPairDistance(onA)).toBeGreaterThanOrEqual(13.2 - 0.01)
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

describe('assignAnchors — reciprocal pairs and hub sides (SAOE FSSystemContext regression)', () => {
  // Reported defect: Inspecteur ↔ Microsoft Power Platform SAOE (one connection
  // each way) drew as a single braided line, and the pair's collision made the
  // whole top side of the hub fan onto three ports — two of them shared — bending
  // the other people's connections too. Geometry mirrors the ELK DOWN placement:
  // four people in a row above the hub.
  const rects = new Map<string, Box>([
    ['insp', box(48, 48, 150, 90)],
    ['rep', box(258, 48, 150, 90)],
    ['emp', box(468, 48, 150, 90)],
    ['agent', box(678, 48, 150, 90)],
    ['pp', box(253, 228, 200, 100)],
  ])
  const edges: AnchorEdge[] = [
    { id: 'c1', fromId: 'insp', toId: 'pp' },
    { id: 'c2', fromId: 'pp', toId: 'insp' },
    { id: 'c3', fromId: 'rep', toId: 'pp' },
    { id: 'c4', fromId: 'emp', toId: 'pp' },
    { id: 'c5', fromId: 'pp', toId: 'agent' },
  ]
  const res = assignAnchors(rects, edges)

  it('splits the reciprocal pair into two separate, non-crossing lines', () => {
    const p1 = drawn(rects, edges[0], res.get('c1'))
    const p2 = drawn(rects, edges[1], res.get('c2'))
    // c1 runs insp→pp, c2 pp→insp: compare like ends.
    const atInsp = [p1.fromEdge, p2.toEdge]
    const atPp = [p1.toEdge, p2.fromEdge]
    expect(minPairDistance(atInsp)).toBeGreaterThanOrEqual(22.5)
    expect(minPairDistance(atPp)).toBeGreaterThanOrEqual(22.5)
    const line1 = connectionGeometry(rects.get('insp')!, rects.get('pp')!, { ...res.get('c1'), lockedToAnchors: true }).polyline
    const line2 = connectionGeometry(rects.get('pp')!, rects.get('insp')!, { ...res.get('c2'), lockedToAnchors: true }).polyline
    let crossed = false
    for (let i = 0; i + 1 < line1.length && !crossed; i++) {
      for (let j = 0; j + 1 < line2.length; j++) {
        if (segmentsCross(line1[i], line1[i + 1], line2[j], line2[j + 1])) {
          crossed = true
          break
        }
      }
    }
    expect(crossed).toBe(false)
  })

  it('keeps every attachment on the hub distinct without pinning the edges that already separate', () => {
    // tolerance = 0.25 × the smallest node side (90) = 22.5px
    expect(minPairDistance(attachments(rects, edges, res, 'pp'))).toBeGreaterThanOrEqual(22.5)
    // Répartiteur's and Employé's connections were never in conflict: they stay free
    // at the hub and run straight at their natural points.
    expect(res.get('c3')!.toAnchor).toBeUndefined()
    expect(res.get('c4')!.toAnchor).toBeUndefined()
  })
})
