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

import { expandDiagramsInline, inlineWrapperId } from './expandInline'
import type { C4Object, Connection, Diagram, Group } from '../../types'

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
    lookup: { diagram: byId(diagrams), object: byId(objects), connection: byId(connections) },
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
    // host sat at (500,400); the block's own top-left was (20,10).
    expect(inner1.position).toEqual({ x: 500, y: 400 })
    // …and the block keeps its internal arrangement.
    expect(inner2.position).toEqual({ x: 700, y: 400 })
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
    // inner2 (220,10) is now the block's top-left, so it takes host's position.
    expect(result.objects.find((o) => o.id === 'inner2')!.position).toEqual({ x: 500, y: 400 })
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
      // Block top-left was (300,117); the host sat at (223,280): dx=-77, dy=163.
      expect(at('c1')).toEqual({ x: 223, y: 280 })
      expect(at('c2')).toEqual({ x: 673, y: 280 })
      expect(at('c3')).toEqual({ x: 447, y: 512 })
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
      // ...and the grid still lands where the shape was.
      expect(Math.min(...positions.map((p) => p.x))).toBe(223)
      expect(Math.min(...positions.map((p) => p.y))).toBe(280)
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
      // svc sat at (100,100) once the containers landed; its components land there.
      expect(result.objects.find((o) => o.id === 'comp1')!.position).toEqual({ x: 100, y: 100 })
      expect(result.objects.find((o) => o.id === 'comp2')!.position).toEqual({ x: 300, y: 100 })
      // db was already drawn by the outer expansion: not pulled twice.
      expect(result.objects.find((o) => o.id === 'db')!.position).toEqual({ x: 500, y: 100 })
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
