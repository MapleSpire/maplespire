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
  expandDiagramsInline,
  inlineWrapperId,
  shiftPoint,
  unshiftPoint,
  type InlineExpansionResult,
  type MakeRoomCut,
} from './expandInline'
import { parentWrapperBox, parentWrapperHeaderBand, type Box } from '../../canvas/parentWrapperBox'
import type { C4Object, Connection, Diagram, Group } from '../../types'

/**
 * The box the engine draws for a wrapper (`computeGroupBounds`): its member
 * shapes plus the boxes of the wrappers it names as nested, padded.
 */
function drawnWrapperBox(result: InlineExpansionResult, hostId: string, minWidth = 0): Box {
  const wrapper = result.groups.find((g) => g.id === inlineWrapperId(hostId))!
  const boxes: Box[] = result.objects
    .filter((o) => wrapper.objectIds.includes(o.id))
    .map((o) => ({ x: o.position.x, y: o.position.y, width: o.size.width, height: o.size.height }))
  for (const innerId of wrapper.innerWrapperIds ?? []) {
    const inner = result.groups.find((g) => g.id === innerId)!
    boxes.push(drawnWrapperBox(result, inner.parentObjectId!, minWidth))
  }
  return parentWrapperBox(boxes, parentWrapperHeaderBand(wrapper), minWidth)!
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

/**
 * Nothing drawn sits on anything it does not belong to: no two shapes overlap,
 * no shape overlaps a wrapper it is not inside, and two wrappers either nest
 * (the inner box wholly inside the outer) or do not touch.
 */
function expectNothingOverlaps(result: InlineExpansionResult) {
  const wrappers = result.groups.filter((g) => g.id.startsWith(inlineWrapperId('')))
  const boxOfWrapper = new Map(wrappers.map((w) => [w.id, drawnWrapperBox(result, w.parentObjectId!)]))
  const encloses = (outer: Group, innerId: string): boolean =>
    (outer.innerWrapperIds ?? []).some((id) => id === innerId || encloses(wrappers.find((w) => w.id === id)!, innerId))
  const shapeBox = (o: C4Object): Box => ({ x: o.position.x, y: o.position.y, width: o.size.width, height: o.size.height })
  for (const a of result.objects) {
    for (const b of result.objects) {
      if (a !== b) expect(intersects(shapeBox(a), shapeBox(b)), `${a.id} overlaps ${b.id}`).toBe(false)
    }
    for (const w of wrappers) {
      if (w.objectIds.includes(a.id)) continue
      expect(intersects(shapeBox(a), boxOfWrapper.get(w.id)!), `${a.id} overlaps the wrapper of ${w.parentObjectId}`).toBe(false)
    }
  }
  for (const a of wrappers) {
    for (const b of wrappers) {
      if (a === b) continue
      if (encloses(a, b.id)) {
        expect(contains(boxOfWrapper.get(a.id)!, boxOfWrapper.get(b.id)!), `${b.parentObjectId} pokes out of ${a.parentObjectId}`).toBe(true)
      } else if (!encloses(b, a.id)) {
        expect(intersects(boxOfWrapper.get(a.id)!, boxOfWrapper.get(b.id)!), `${a.parentObjectId} overlaps ${b.parentObjectId}`).toBe(false)
      }
    }
  }
}

const object = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 60 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  ...over,
} as C4Object)

const conn = (id: string, fromId: string, toId: string): Connection =>
  ({ id, fromId, toId, type: 'solid' } as Connection)

const diagram = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
} as Diagram)

/** A world: diagram A holds `host`; diagram B holds `inner1`, `inner2`. */
function world(over: { objects?: C4Object[]; diagrams?: Diagram[]; connections?: Connection[] } = {}) {
  const objects = over.objects ?? [
    object('host', { name: 'Billing', position: { x: 500, y: 400 } }),
    object('peer', { position: { x: 900, y: 400 } }),
    object('inner1', { position: { x: 20, y: 10 } }),
    object('inner2', { position: { x: 220, y: 10 } }),
  ]
  const connections = over.connections ?? [
    conn('a-edge', 'peer', 'host'),
    conn('b-edge', 'inner1', 'inner2'),
  ]
  const diagrams = over.diagrams ?? [
    diagram('A', { objectIds: ['host', 'peer'], connectionIds: ['a-edge'] }),
    diagram('B', { objectIds: ['inner1', 'inner2'], connectionIds: ['b-edge'] }),
  ]
  const byId = <T extends { id: string }>(items: T[]) => (id: string) => items.find((i) => i.id === id)
  return {
    lookup: {
      diagram: byId(diagrams), object: byId(objects), connection: byId(connections),
      // No header-width floor, so a box is exactly its members + padding.
      wrapperMinWidth: () => 0,
    },
    base: {
      objects: objects.filter((o) => diagrams[0].objectIds.includes(o.id)),
      connections: connections.filter((c) => diagrams[0].connectionIds.includes(c.id)),
      groups: [] as Group[],
    },
  }
}

const expandHostIntoB = (w: ReturnType<typeof world>) =>
  expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)

describe('expandDiagramsInline', () => {
  it('returns the diagram untouched when nothing is expanded', () => {
    const w = world()
    const result = expandDiagramsInline(w.base, 'A', [], w.lookup)
    expect(result.objects).toEqual(w.base.objects)
    expect(result.groups).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('pulls the other diagram\'s shapes in', () => {
    const result = expandHostIntoB(world())
    expect(result.objects.map((o) => o.id).sort()).toEqual(['inner1', 'inner2', 'peer'])
  })

  // A wrapper IS the expanded form of an object; drawing both would show the
  // same thing twice.
  it('replaces the expanded shape with a wrapper group', () => {
    const result = expandHostIntoB(world())
    expect(result.objects.some((o) => o.id === 'host')).toBe(false)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      id: inlineWrapperId('host'),
      parentObjectId: 'host',
      name: 'Billing',
      objectIds: ['inner1', 'inner2'],
    })
  })

  // Without this every line into the expanded shape would resolve to a missing
  // endpoint and vanish from the canvas.
  it('rewrites this diagram\'s connections onto the wrapper', () => {
    const result = expandHostIntoB(world())
    const edge = result.connections.find((c) => c.id === 'a-edge')!
    expect(edge.toId).toBe(inlineWrapperId('host'))
    expect(edge.fromId).toBe('peer')
  })

  it('brings the relationships between the pulled shapes too', () => {
    const result = expandHostIntoB(world())
    expect(result.connections.map((c) => c.id).sort()).toEqual(['a-edge', 'b-edge'])
  })

  // An expanded boundary is about what is inside it.
  it('leaves external-scope shapes behind', () => {
    const w = world({
      objects: [
        object('host', { position: { x: 500, y: 400 } }),
        object('peer'),
        object('inner1', { position: { x: 20, y: 10 } }),
        object('inner2', { position: { x: 220, y: 10 }, scope: 'external' }),
      ],
      diagrams: [
        diagram('A', { objectIds: ['host', 'peer'] }),
        diagram('B', { objectIds: ['inner1', 'inner2'] }),
      ],
      connections: [],
    })
    const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
    expect(result.objects.map((o) => o.id)).toContain('inner1')
    expect(result.objects.map((o) => o.id)).not.toContain('inner2')
    expect(result.groups[0].objectIds).toEqual(['inner1'])
  })

  // Two entries with one id collide in the engine's object map and the second
  // silently wins.
  it('leaves behind a shape this diagram already draws', () => {
    const w = world({
      objects: [
        object('host', { position: { x: 500, y: 400 } }),
        object('inner1', { position: { x: 20, y: 10 } }),
        object('inner2', { position: { x: 220, y: 10 } }),
      ],
      diagrams: [
        diagram('A', { objectIds: ['host', 'inner1'] }),
        diagram('B', { objectIds: ['inner1', 'inner2'] }),
      ],
      connections: [],
    })
    const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
    expect(result.objects.filter((o) => o.id === 'inner1')).toHaveLength(1)
    expect(result.groups[0].objectIds).toEqual(['inner2'])
  })

  // The pulled shapes carry the OTHER diagram's coordinates, which mean nothing
  // here. Untranslated they land on whatever occupies those coordinates.
  it('lands the pulled block where the expanded shape was', () => {
    const result = expandHostIntoB(world())
    const inner1 = result.objects.find((o) => o.id === 'inner1')!
    const inner2 = result.objects.find((o) => o.id === 'inner2')!
    // host sat at (500,400): the WRAPPER's box starts there, so the shapes sit
    // inside it — side padding 30, header band 71 (title + type line).
    expect(parentWrapperHeaderBand(result.groups[0])).toBe(71)
    expect(inner1.position).toEqual({ x: 530, y: 471 })
    // …and the block keeps its internal arrangement.
    expect(inner2.position).toEqual({ x: 730, y: 471 })
    expect(drawnWrapperBox(result, 'host')).toEqual({ x: 500, y: 400, width: 360, height: 159 })
  })

  it('places from the target diagram\'s layout override, not the model position', () => {
    const w = world()
    const withLayout = {
      ...w,
      lookup: {
        ...w.lookup,
        diagram: (id: string) => (id === 'B'
          ? diagram('B', {
            objectIds: ['inner1', 'inner2'],
            connectionIds: [],
            layouts: { inner1: { position: { x: 1000, y: 1000 }, size: { width: 100, height: 60 } } },
          })
          : w.lookup.diagram(id)),
      },
    }
    const result = expandDiagramsInline(
      withLayout.base, 'A', [{ objectId: 'host', diagramId: 'B' }], withLayout.lookup,
    )
    // inner2 (220,10) is now the block's top-left, so it sits at the box's
    // inner corner: host (500,400) + padding (30, 71).
    expect(result.objects.find((o) => o.id === 'inner2')!.position).toEqual({ x: 530, y: 471 })
  })

  // The defect of 2026-10-15: a non-active diagram is a layout-less STUB in the
  // store and the diagram index (its placement lives in its own unloaded
  // DiagramDoc). A Structurizr import leaves every model-level position at the
  // same default, so a stub-only expansion drew the whole block on ONE point.
  describe('placement read from the target diagram, not its stub', () => {
    /** Three containers whose model positions all coincide, as an import leaves them. */
    const importedWorld = () => world({
      objects: [
        object('host', { position: { x: 223, y: 280 } }),
        object('c1', { position: { x: 0, y: 0 }, size: { width: 185, height: 100 } }),
        object('c2', { position: { x: 0, y: 0 }, size: { width: 185, height: 100 } }),
        object('c3', { position: { x: 0, y: 0 }, size: { width: 185, height: 100 } }),
      ],
      diagrams: [
        diagram('A', { objectIds: ['host'] }),
        // No `layouts`: exactly what `metaToStubDiagram` hands the index.
        diagram('B', { objectIds: ['c1', 'c2', 'c3'] }),
      ],
      connections: [],
    })
    const read = {
      c1: { position: { x: 300, y: 117 }, size: { width: 185, height: 100 } },
      c2: { position: { x: 750, y: 117 }, size: { width: 185, height: 100 } },
      c3: { position: { x: 524, y: 349 }, size: { width: 185, height: 100 } },
    }

    it('lays the pulled shapes out from the placement read for a layout-less stub', () => {
      const w = importedWorld()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], {
        ...w.lookup,
        layouts: (id) => (id === 'B' ? read : undefined),
      })
      const at = (id: string) => result.objects.find((o) => o.id === id)!.position
      // Block top-left was (300,117); the box starts at the host (223,280), so
      // the shapes start at (223+30, 280+71): dx=-47, dy=234.
      expect(at('c1')).toEqual({ x: 253, y: 351 })
      expect(at('c2')).toEqual({ x: 703, y: 351 })
      expect(at('c3')).toEqual({ x: 477, y: 583 })
    })

    // While the target's document is still loading the expansion must WAIT, not
    // draw a pile and then jump: the shape stays a shape for that instant.
    it('waits while the placement has not been read yet', () => {
      const w = importedWorld()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], {
        ...w.lookup,
        layouts: () => undefined,
      })
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'pending' }])
      expect(result.objects.map((o) => o.id)).toEqual(['host'])
      expect(result.groups).toEqual([])
    })

    // Offline with a document this client never synced: the arrangement is
    // unknowable, and a grid is honest where a pile is not.
    it('falls back to a grid, never a pile, when the placement cannot be read', () => {
      const w = importedWorld()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], {
        ...w.lookup,
        layouts: () => null,
      })
      const positions = ['c1', 'c2', 'c3'].map((id) => result.objects.find((o) => o.id === id)!.position)
      expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(3)
      // ...and the grid still lands where the shape was (inside its box).
      expect(Math.min(...positions.map((p) => p.x))).toBe(223 + 30)
      expect(Math.min(...positions.map((p) => p.y))).toBe(280 + 71)
      // No two cells overlap.
      for (const a of positions) {
        for (const b of positions) {
          if (a === b) continue
          expect(Math.abs(a.x - b.x) >= 185 || Math.abs(a.y - b.y) >= 100).toBe(true)
        }
      }
    })
  })

  // A shape pulled in by one expansion carries the ⤢ indicator too. Expanding it
  // used to be refused as 'missing' — a click that did nothing.
  describe('nested expansion', () => {
    const nestedWorld = () => world({
      objects: [
        object('system', { position: { x: 100, y: 100 } }),
        object('peer', { position: { x: 900, y: 100 } }),
        object('svc', { position: { x: 0, y: 0 } }),
        object('db', { position: { x: 0, y: 0 } }),
        object('comp1', { position: { x: 0, y: 0 } }),
        object('comp2', { position: { x: 0, y: 0 } }),
      ],
      diagrams: [
        diagram('context', { objectIds: ['system', 'peer'], connectionIds: ['peer-system'] }),
        diagram('containers', { objectIds: ['svc', 'db'], connectionIds: ['svc-db'] }),
        diagram('components', { objectIds: ['comp1', 'comp2', 'db'], connectionIds: ['comp1-comp2'] }),
      ],
      connections: [
        conn('peer-system', 'peer', 'system'),
        conn('svc-db', 'svc', 'db'),
        conn('comp1-comp2', 'comp1', 'comp2'),
      ],
    })
    const placements: Record<string, Diagram['layouts']> = {
      containers: {
        svc: { position: { x: 0, y: 0 }, size: { width: 100, height: 60 } },
        db: { position: { x: 400, y: 0 }, size: { width: 100, height: 60 } },
      },
      components: {
        comp1: { position: { x: 50, y: 50 }, size: { width: 100, height: 60 } },
        comp2: { position: { x: 250, y: 50 }, size: { width: 100, height: 60 } },
        db: { position: { x: 600, y: 50 }, size: { width: 100, height: 60 } },
      },
    }
    const expandBoth = (order: 'outer-first' | 'inner-first') => {
      const w = nestedWorld()
      const outer = { objectId: 'system', diagramId: 'containers' }
      const inner = { objectId: 'svc', diagramId: 'components' }
      return expandDiagramsInline(
        w.base, 'context', order === 'outer-first' ? [outer, inner] : [inner, outer],
        { ...w.lookup, layouts: (id) => placements[id] },
      )
    }

    it('expands a shape that an earlier expansion pulled in', () => {
      const result = expandBoth('outer-first')
      expect(result.skipped).toEqual([])
      expect(result.objects.map((o) => o.id).sort()).toEqual(['comp1', 'comp2', 'db', 'peer'])
      // Inside out. The components' box is 360x159; svc's place in the
      // containers (0,0) takes it, pushing db (400,0) right by 260 to 660. The
      // containers' box is then 820x258, and it takes the system's place.
      expect(result.objects.find((o) => o.id === 'comp1')!.position).toEqual({ x: 160, y: 242 })
      expect(result.objects.find((o) => o.id === 'comp2')!.position).toEqual({ x: 360, y: 242 })
      // db was already drawn by the outer expansion: not pulled twice.
      expect(result.objects.find((o) => o.id === 'db')!.position).toEqual({ x: 790, y: 171 })
      expect(drawnWrapperBox(result, 'system')).toEqual({ x: 100, y: 100, width: 820, height: 258 })
      expect(drawnWrapperBox(result, 'svc')).toEqual({ x: 130, y: 171, width: 360, height: 159 })
      // The system's box grew by 720 to the right: peer (900,100) moved past it.
      expect(result.objects.find((o) => o.id === 'peer')!.position).toEqual({ x: 1620, y: 100 })
    })

    // The order the store happens to hold the entries in is not a meaning.
    it('does not depend on the order the expansions are listed in', () => {
      const a = expandBoth('outer-first')
      const b = expandBoth('inner-first')
      expect(b.skipped).toEqual([])
      expect(new Map(b.objects.map((o) => [o.id, o.position]))).toEqual(new Map(a.objects.map((o) => [o.id, o.position])))
    })

    it('keeps the inner block inside the outer wrapper', () => {
      const result = expandBoth('outer-first')
      const outer = result.groups.find((g) => g.id === inlineWrapperId('system'))!
      const inner = result.groups.find((g) => g.id === inlineWrapperId('svc'))!
      expect(inner.objectIds).toEqual(['comp1', 'comp2'])
      // svc is gone (its wrapper IS it); the outer box encloses what replaced it.
      expect([...outer.objectIds].sort()).toEqual(['comp1', 'comp2', 'db'])
    })

    it('rewrites the outer block\'s edges onto the inner wrapper', () => {
      const result = expandBoth('outer-first')
      const edge = result.connections.find((c) => c.id === 'svc-db')!
      expect(edge.fromId).toBe(inlineWrapperId('svc'))
      expect(result.connections.find((c) => c.id === 'comp1-comp2')).toBeTruthy()
    })
  })

  // The defect after the 2026-10-15 fix: once the block was its TRUE size
  // (~860x460 of containers for a 200x100 system), it was drawn over the
  // neighbours — Restaurant Portal and Order Service on Stripe (60,510) and
  // Google Maps (330,510), and a nested Order Service over Payment Service.
  // Rule 5: the rest of the diagram is pushed out of the way, in the VIEW only.
  describe('making room for the block', () => {
    const sz = { width: 200, height: 100 }
    /** The FoodDash Product Hunt fixture, at the coordinates the repro reported. */
    const foodDash = () => {
      const w = world({
        objects: [
          object('customer', { type: 'person', position: { x: 310, y: 40 }, size: sz }),
          object('foodDash', { name: 'FoodDash', type: 'system', shortDescription: 'Food delivery', position: { x: 310, y: 280 }, size: sz }),
          object('courier', { type: 'person', position: { x: 620, y: 280 }, size: sz }),
          object('stripe', { scope: 'external', position: { x: 60, y: 510 }, size: sz }),
          object('maps', { scope: 'external', position: { x: 330, y: 510 }, size: sz }),
          object('portal', { name: 'Restaurant Portal', size: sz }),
          object('web', { size: sz }), object('mobile', { size: sz }),
          object('orders', { name: 'Order Service', type: 'container', size: sz }),
          object('payments', { name: 'Payment Service', size: sz }),
          object('db', { size: sz }),
          object('api', { size: sz }), object('checkout', { size: sz }), object('machine', { size: sz }),
        ],
        diagrams: [
          diagram('context', {
            objectIds: ['customer', 'foodDash', 'courier', 'stripe', 'maps'],
            connectionIds: ['foodDash-stripe', 'customer-foodDash'],
          }),
          diagram('containers', {
            objectIds: ['customer', 'portal', 'web', 'mobile', 'orders', 'payments', 'db', 'stripe', 'maps'],
            connectionIds: ['orders-payments'],
          }),
          diagram('components', { objectIds: ['api', 'checkout', 'machine', 'payments'], connectionIds: ['api-checkout'] }),
        ],
        connections: [
          { ...conn('foodDash-stripe', 'foodDash', 'stripe'), waypoints: [{ x: 160, y: 330 }, { x: 900, y: 700 }] },
          conn('customer-foodDash', 'customer', 'foodDash'),
          { ...conn('orders-payments', 'orders', 'payments'), waypoints: [{ x: 250, y: 300 }] },
          conn('api-checkout', 'api', 'checkout'),
        ],
      })
      const at = (x: number, y: number) => ({ position: { x, y }, size: sz })
      const layouts: Record<string, Diagram['layouts']> = {
        // ~860x460, the size the import lays this view out at.
        containers: {
          portal: at(0, 0), web: at(330, 0), mobile: at(660, 0),
          orders: at(0, 180), payments: at(330, 180), db: at(660, 360),
        },
        components: { api: at(0, 0), checkout: at(300, 0), machine: at(150, 180) },
      }
      return { w, lookup: { ...w.lookup, layouts: (id: string) => layouts[id] } }
    }
    const expandSystem = (nested: boolean) => {
      const { w, lookup } = foodDash()
      return expandDiagramsInline(w.base, 'context', [
        { objectId: 'foodDash', diagramId: 'containers' },
        ...(nested ? [{ objectId: 'orders', diagramId: 'components' }] : []),
      ], lookup)
    }
    const pos = (result: InlineExpansionResult, id: string) => result.objects.find((o) => o.id === id)!.position

    it('draws nothing over the neighbours of the expanded system', () => {
      const result = expandSystem(false)
      expect(result.skipped).toEqual([])
      expectNothingOverlaps(result)
      // The witness the repro named, pinned: Stripe and Google Maps sat under
      // the block's left half, and are below the host, so they move DOWN only.
      const box = drawnWrapperBox(result, 'foodDash')
      expect(box).toMatchObject({ x: 310, y: 280 })
      expect(pos(result, 'stripe')).toEqual({ x: 60, y: 510 + box.height - 100 })
      expect(pos(result, 'maps')).toEqual({ x: 330, y: 510 + box.height - 100 })
      // Right of the host: moves RIGHT only, keeping its 110px gap.
      expect(pos(result, 'courier')).toEqual({ x: 310 + box.width + 110, y: 280 })
      // Above the host: untouched.
      expect(pos(result, 'customer')).toEqual({ x: 310, y: 40 })
    })

    it('draws nothing over Payment Service when Order Service is expanded inside', () => {
      const result = expandSystem(true)
      expect(result.skipped).toEqual([])
      expectNothingOverlaps(result)
      const inner = drawnWrapperBox(result, 'orders')
      // Order Service's box starts where it was, and Payment Service — to its
      // right in the same row — moved past it.
      expect(pos(result, 'payments').x).toBeGreaterThanOrEqual(inner.x + inner.width)
      // The outer block grew around the inner one, and the diagram made room
      // for the GROWN outer block.
      const outer = drawnWrapperBox(result, 'foodDash')
      expect(contains(outer, inner)).toBe(true)
      expect(pos(result, 'stripe').y).toBeGreaterThanOrEqual(outer.y + outer.height)
      expect(pos(result, 'courier').x).toBeGreaterThanOrEqual(outer.x + outer.width)
    })

    it('moves shapes right of the host right, below it down, and diagonal ones both', () => {
      const w = world({
        objects: [
          object('host', { name: 'Billing', position: { x: 500, y: 400 } }),
          object('right', { position: { x: 900, y: 400 } }),
          object('below', { position: { x: 500, y: 700 } }),
          object('diagonal', { position: { x: 900, y: 700 } }),
          object('left', { position: { x: 100, y: 400 } }),
          object('above', { position: { x: 500, y: 100 } }),
          object('aboveRight', { position: { x: 900, y: 100 } }),
          object('touching', { position: { x: 600, y: 400 } }),
          object('inner1', { position: { x: 20, y: 10 } }),
          object('inner2', { position: { x: 220, y: 10 } }),
        ],
        diagrams: [
          diagram('A', { objectIds: ['host', 'right', 'below', 'diagonal', 'left', 'above', 'aboveRight', 'touching'] }),
          diagram('B', { objectIds: ['inner1', 'inner2'] }),
        ],
        connections: [],
      })
      const result = expandHostIntoB(w)
      // Box 360x159 for a 100x60 host: 260 wider, 99 taller.
      expect(result.cuts).toEqual([{ atX: 600, byX: 260, atY: 460, byY: 99 }])
      expect(pos(result, 'right')).toEqual({ x: 1160, y: 400 })
      expect(pos(result, 'below')).toEqual({ x: 500, y: 799 })
      expect(pos(result, 'diagonal')).toEqual({ x: 1160, y: 799 })
      expect(pos(result, 'left')).toEqual({ x: 100, y: 400 })
      expect(pos(result, 'above')).toEqual({ x: 500, y: 100 })
      // A whole column moves, so what was aligned stays aligned.
      expect(pos(result, 'aboveRight')).toEqual({ x: 1160, y: 100 })
      // Edge to edge with the host is "at or past" its right edge.
      expect(pos(result, 'touching')).toEqual({ x: 860, y: 400 })
      expectNothingOverlaps(result)
    })

    it('moves nothing when the block is no larger than the shape it replaces', () => {
      const w = world({
        objects: [
          object('host', { position: { x: 0, y: 0 }, size: { width: 2000, height: 2000 } }),
          object('right', { position: { x: 2100, y: 0 } }),
          object('inner1'),
        ],
        diagrams: [diagram('A', { objectIds: ['host', 'right'] }), diagram('B', { objectIds: ['inner1'] })],
        connections: [],
      })
      const result = expandHostIntoB(w)
      expect(result.cuts).toEqual([{ atX: 2000, byX: 0, atY: 2000, byY: 0 }])
      expect(pos(result, 'right')).toEqual({ x: 2100, y: 0 })
    })

    // Each expansion's room is made on the coordinates the previous one left,
    // so two side by side cannot land on each other.
    it('keeps two blocks expanded side by side apart, whatever order they are listed in', () => {
      const w = world({
        objects: [
          object('h1', { position: { x: 0, y: 0 } }), object('h2', { position: { x: 150, y: 0 } }),
          object('h3', { position: { x: 0, y: 100 } }),
          object('a1', { position: { x: 0, y: 0 } }), object('a2', { position: { x: 300, y: 300 } }),
          object('b1', { position: { x: 0, y: 0 } }), object('b2', { position: { x: 500, y: 0 } }),
          object('c1', { position: { x: 0, y: 0 } }),
        ],
        diagrams: [
          diagram('A', { objectIds: ['h1', 'h2', 'h3'] }),
          diagram('B', { objectIds: ['a1', 'a2'] }), diagram('C', { objectIds: ['b1', 'b2'] }),
          diagram('D', { objectIds: ['c1'] }),
        ],
        connections: [],
      })
      const entries = [
        { objectId: 'h1', diagramId: 'B' }, { objectId: 'h2', diagramId: 'C' }, { objectId: 'h3', diagramId: 'D' },
      ]
      const forward = expandDiagramsInline(w.base, 'A', entries, w.lookup)
      const backward = expandDiagramsInline(w.base, 'A', [...entries].reverse(), w.lookup)
      expect(forward.skipped).toEqual([])
      expectNothingOverlaps(forward)
      expect(new Map(backward.objects.map((o) => [o.id, o.position]))).toEqual(new Map(forward.objects.map((o) => [o.id, o.position])))
    })

    it('moves this diagram\'s waypoints with the cut, and the block\'s own with the block', () => {
      const result = expandSystem(false)
      const box = drawnWrapperBox(result, 'foodDash')
      const outward = result.connections.find((c) => c.id === 'foodDash-stripe')!
      // (160,330): left of and above the host's far edges — untouched.
      // (900,700): past both — moved by both.
      expect(outward.waypoints).toEqual([
        { x: 160, y: 330 }, { x: 900 + box.width - 200, y: 700 + box.height - 100 },
      ])
      // The block's edge kept its bend relative to its shapes.
      const internal = result.connections.find((c) => c.id === 'orders-payments')!
      const ordersAt = pos(result, 'orders')
      expect(internal.waypoints).toEqual([{ x: ordersAt.x + 250, y: ordersAt.y + 300 - 180 }])
    })

    it('drops a pulled edge\'s waypoints over a grid, where they mean nothing', () => {
      const { w, lookup } = foodDash()
      const result = expandDiagramsInline(w.base, 'context', [{ objectId: 'foodDash', diagramId: 'containers' }], {
        ...lookup, layouts: () => null,
      })
      expect(result.connections.find((c) => c.id === 'orders-payments')!.waypoints).toBeUndefined()
      expectNothingOverlaps(result)
    })

    it('moves a positioned group past the cut, and leaves its membership alone', () => {
      const w = world()
      const fixed = { id: 'g1', name: 'g', objectIds: ['peer'], position: { x: 880, y: 380 }, size: { width: 200, height: 120 }, autoSize: false } as unknown as Group
      const result = expandDiagramsInline({ ...w.base, groups: [fixed] }, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
      const moved = result.groups.find((g) => g.id === 'g1')!
      expect(moved.position).toEqual({ x: 1140, y: 380 })
      expect(moved.objectIds).toEqual(['peer'])
    })

    it('does not move anything it was given', () => {
      const { w, lookup } = foodDash()
      const before = JSON.stringify(w.base)
      const placementBefore = JSON.stringify(lookup.layouts('containers'))
      expandDiagramsInline(w.base, 'context', [
        { objectId: 'foodDash', diagramId: 'containers' }, { objectId: 'orders', diagramId: 'components' },
      ], lookup)
      expect(JSON.stringify(w.base)).toBe(before)
      expect(JSON.stringify(lookup.layouts('containers'))).toBe(placementBefore)
      expect(w.lookup.connection('orders-payments')!.waypoints).toEqual([{ x: 250, y: 300 }])
    })

    // Without the engine's measurement the header's widest possible floor is
    // assumed: more room than needed, never less — and the box still STARTS at
    // the host, because the shapes are centred under the wider header.
    it('assumes the widest header when no engine measures it', () => {
      const w = world({
        objects: [object('host', { position: { x: 500, y: 400 } }), object('right', { position: { x: 700, y: 400 } }), object('inner1')],
        diagrams: [diagram('A', { objectIds: ['host', 'right'] }), diagram('B', { objectIds: ['inner1'] })],
        connections: [],
      })
      const { wrapperMinWidth: _unused, ...unmeasured } = w.lookup
      void _unused
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], unmeasured)
      const box = drawnWrapperBox(result, 'host', 392)
      expect(box).toMatchObject({ x: 500, y: 400, width: 392 })
      expect(pos(result, 'inner1').x).toBe(500 + (392 - 100) / 2)
      expect(pos(result, 'right').x).toBe(700 + 392 - 100)
    })

    it('hands the engine the nesting, so the outer box is drawn around the inner one', () => {
      const result = expandSystem(true)
      const outer = result.groups.find((g) => g.id === inlineWrapperId('foodDash'))!
      expect(outer.innerWrapperIds).toEqual([inlineWrapperId('orders')])
      expect(result.groups.find((g) => g.id === inlineWrapperId('orders'))!.innerWrapperIds).toBeUndefined()
    })
  })

  // A drag on the displaced view reports VIEW coordinates; this is what keeps
  // the displacement out of the model.
  describe('mapping view coordinates back to the model', () => {
    const cuts: MakeRoomCut[] = [
      { atX: 600, byX: 260, atY: 460, byY: 99 },
      { atX: 1000, byX: 100, atY: 2000, byY: 0 },
    ]

    it('undoes the shift for every point outside the gaps a cut opened', () => {
      for (const p of [
        { x: 0, y: 0 }, { x: 599, y: 459 }, { x: 600, y: 460 }, { x: 900, y: 700 },
        { x: 740, y: 100 }, { x: 999, y: 3000 }, { x: 1200, y: 10 },
      ]) {
        expect(unshiftPoint(cuts, shiftPoint(cuts, p)), JSON.stringify(p)).toEqual(p)
      }
    })

    it('stores a displaced shape dragged by d at its model position + d', () => {
      const model = { x: 900, y: 400 }
      const drawn = shiftPoint(cuts, model)
      // Past both cuts: the second applies to where the first left it.
      expect(drawn).toEqual({ x: 1260, y: 400 })
      expect(unshiftPoint(cuts, { x: drawn.x + 40, y: drawn.y + 25 })).toEqual({ x: 940, y: 425 })
    })

    it('stores a shape dropped in an opened gap at the cut line', () => {
      expect(unshiftPoint(cuts.slice(0, 1), { x: 700, y: 480 })).toEqual({ x: 600, y: 460 })
    })

    it('is the identity with nothing expanded', () => {
      expect(shiftPoint([], { x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
      expect(unshiftPoint([], { x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
    })
  })

  describe('refusals, each reported rather than silent', () => {
    it('refuses to expand a shape into the diagram being drawn', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'A' }], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'cycle' }])
      expect(result.groups).toEqual([])
    })

    // A→B→A: the shape pulled in from B carries its own expansion back to A.
    // Pulled shapes ARE expandable (nesting), so this is the visited set's job.
    it('cannot recurse back into a diagram already expanded here', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [
        { objectId: 'host', diagramId: 'B' },
        { objectId: 'inner1', diagramId: 'A' },
      ], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'inner1', reason: 'cycle' }])
      expect(result.groups).toHaveLength(1)
    })

    it('refuses a second expansion into the same diagram', () => {
      const w = world({
        objects: [
          object('host', { position: { x: 500, y: 400 } }),
          object('host2', { position: { x: 900, y: 400 } }),
          object('inner1', { position: { x: 20, y: 10 } }),
        ],
        diagrams: [
          diagram('A', { objectIds: ['host', 'host2'] }),
          diagram('B', { objectIds: ['inner1'] }),
        ],
        connections: [],
      })
      const result = expandDiagramsInline(w.base, 'A', [
        { objectId: 'host', diagramId: 'B' },
        { objectId: 'host2', diagramId: 'B' },
      ], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'host2', reason: 'cycle' }])
      expect(result.groups).toHaveLength(1)
    })

    it('refuses a diagram that no longer exists', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'gone' }], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'missing' }])
    })

    it('refuses a shape that is not on this diagram', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'inner1', diagramId: 'B' }], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'inner1', reason: 'missing' }])
    })

    // Nothing to show is not the same as nothing to do: the shape stays a shape
    // rather than becoming an empty box.
    it('refuses an expansion that would show nothing', () => {
      const w = world({
        objects: [
          object('host', { position: { x: 500, y: 400 } }),
          object('inner1', { scope: 'external' }),
        ],
        diagrams: [diagram('A', { objectIds: ['host'] }), diagram('B', { objectIds: ['inner1'] })],
        connections: [],
      })
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'empty' }])
      expect(result.objects.some((o) => o.id === 'host')).toBe(true)
      expect(result.groups).toEqual([])
    })
  })

  it('does not mutate what it was given', () => {
    const w = world()
    const baseObjects = [...w.base.objects]
    const baseConnections = [...w.base.connections]
    expandHostIntoB(w)
    expect(w.base.objects).toEqual(baseObjects)
    expect(w.base.connections).toEqual(baseConnections)
    expect(w.base.connections[0].toId).toBe('host')
  })

  it('expands two shapes into two different diagrams at once', () => {
    const w = world({
      objects: [
        object('host', { position: { x: 0, y: 0 } }),
        object('host2', { position: { x: 900, y: 0 } }),
        object('inner1'),
        object('other1'),
      ],
      diagrams: [
        diagram('A', { objectIds: ['host', 'host2'] }),
        diagram('B', { objectIds: ['inner1'] }),
        diagram('C', { objectIds: ['other1'] }),
      ],
      connections: [],
    })
    const result = expandDiagramsInline(w.base, 'A', [
      { objectId: 'host', diagramId: 'B' },
      { objectId: 'host2', diagramId: 'C' },
    ], w.lookup)
    expect(result.skipped).toEqual([])
    expect(result.groups.map((g) => g.parentObjectId)).toEqual(['host', 'host2'])
    expect(result.objects.map((o) => o.id).sort()).toEqual(['inner1', 'other1'])
  })

  // Each of these was a surviving mutant of the 2026-10-15 fix (independent QA
  // lens, 33 mutants): behaviour the suite above did not pin.
  describe('edges of the transform', () => {
    const sz = (width: number, height: number) => ({ width, height })

    it('sizes grid cells for the LARGEST shape, with a gap, in a near-square', () => {
      const w = world({
        objects: [
          object('host'),
          object('a', { size: sz(400, 100) }), object('b', { size: sz(100, 300) }),
          object('c'), object('d'), object('e'),
        ],
        // The largest shapes are NOT listed first.
        diagrams: [diagram('A', { objectIds: ['host'] }), diagram('B', { objectIds: ['c', 'a', 'b', 'd', 'e'] })],
        connections: [],
      })
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], { ...w.lookup, layouts: () => null })
      for (const p of result.objects) {
        for (const q of result.objects) {
          if (p === q) continue
          const apartX = p.position.x + p.size.width + 1 <= q.position.x || q.position.x + q.size.width + 1 <= p.position.x
          const apartY = p.position.y + p.size.height + 1 <= q.position.y || q.position.y + q.size.height + 1 <= p.position.y
          expect(apartX || apartY).toBe(true)
        }
      }
      expect(new Set(result.objects.map((o) => o.position.x)).size).toBe(3)
      expect(new Set(result.objects.map((o) => o.position.y)).size).toBe(2)
    })

    it('takes the size from the layout, and never shares the object it came in', () => {
      const w = world()
      const placement = {
        inner1: { position: { x: 0, y: 0 }, size: sz(321, 123) },
        inner2: { position: { x: 50, y: 0 }, size: sz(10, 20) },
      }
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], { ...w.lookup, layouts: () => placement })
      const inner1 = result.objects.find((o) => o.id === 'inner1')!
      expect(inner1.size).toEqual(sz(321, 123))
      expect(inner1.size).not.toBe(placement.inner1.size)
      const unplaced = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
      expect(unplaced.objects.find((o) => o.id === 'inner2')!.size).not.toBe(w.lookup.object('inner2')!.size)
    })

    it('leaves a persisted group\'s membership alone', () => {
      const w = world()
      const persisted = { id: 'g1', name: 'g', objectIds: ['host', 'peer'] } as unknown as Group
      const result = expandDiagramsInline({ ...w.base, groups: [persisted] }, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
      expect(result.groups.find((g) => g.id === 'g1')!.objectIds).toEqual(['host', 'peer'])
    })

    // A paged or off-window id that does not resolve must not take the whole
    // transform down with it.
    it('skips an unresolvable member, and an edge with one end outside the block', () => {
      const w = world({
        objects: [object('host'), object('x1'), object('x2', { scope: 'external' })],
        diagrams: [
          diagram('A', { objectIds: ['host'] }),
          diagram('B', { objectIds: ['x1', 'ghost', 'x2'], connectionIds: ['in-out', 'x1-ghost'] }),
        ],
        connections: [conn('in-out', 'x1', 'x2'), conn('x1-ghost', 'x1', 'ghost')],
      })
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'B' }], w.lookup)
      expect(result.groups[0].objectIds).toEqual(['x1'])
      expect(result.connections).toEqual([])
    })

    it('resolves three levels of nesting to what the outermost wrapper encloses', () => {
      const w = world({
        objects: [object('s'), object('c1'), object('k1'), object('l1')],
        diagrams: [
          diagram('D0', { objectIds: ['s'] }), diagram('D1', { objectIds: ['c1'] }),
          diagram('D2', { objectIds: ['k1'] }), diagram('D3', { objectIds: ['l1'] }),
        ],
        connections: [],
      })
      const result = expandDiagramsInline(w.base, 'D0', [
        { objectId: 's', diagramId: 'D1' }, { objectId: 'c1', diagramId: 'D2' }, { objectId: 'k1', diagramId: 'D3' },
      ], { ...w.lookup, layouts: () => ({}) })
      expect(result.skipped).toEqual([])
      expect(result.groups.find((g) => g.id === inlineWrapperId('s'))!.objectIds).toEqual(['l1'])
    })

    it('expands a shape listed twice only once', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [
        { objectId: 'host', diagramId: 'B' }, { objectId: 'host', diagramId: 'C' },
      ], { ...w.lookup, diagram: (id) => (id === 'C' ? diagram('C', { objectIds: ['peer'] }) : w.lookup.diagram(id)) })
      expect(result.groups).toHaveLength(1)
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'missing' }])
    })

    it('names the wrapper\'s type the way the renderer labels it', () => {
      expect(expandHostIntoB(world()).groups[0].type).toBe('App')
    })
  })
})
