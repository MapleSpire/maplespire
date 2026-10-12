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

  describe('refusals, each reported rather than silent', () => {
    it('refuses to expand a shape into the diagram being drawn', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [{ objectId: 'host', diagramId: 'A' }], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'host', reason: 'cycle' }])
      expect(result.groups).toEqual([])
    })

    // A→B→A: the shape pulled in from B carries its own expansion back to A.
    // Only shapes present in the BASE are expanded, so it is never consulted —
    // and the visited set refuses it explicitly if it ever is.
    it('cannot recurse back into a diagram already expanded here', () => {
      const w = world()
      const result = expandDiagramsInline(w.base, 'A', [
        { objectId: 'host', diagramId: 'B' },
        { objectId: 'inner1', diagramId: 'A' },
      ], w.lookup)
      expect(result.skipped).toEqual([{ objectId: 'inner1', reason: 'missing' }])
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
})
