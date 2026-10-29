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
import { computeLowerConnections, buildLocalDiagramRender, withOwnConnections } from './diagramRenderLocal'
import { buildModelIndex } from './modelIndex'
import { createMemoryKvStore } from './kvStore'
import type { C4Object, Connection, Group, Diagram } from '../../types'

/**
 * Offline diagram-render fallback. Two layers:
 *  1. `computeLowerConnections` — the SAME fixture the server's parity test uses
 *     (server/src/readModel/diagramRender.test.ts). Byte-identical inputs/outputs ⇒
 *     the client twin rolls connections up exactly like the server (so going offline
 *     doesn't change the diagram).
 *  2. `buildLocalDiagramRender` — end-to-end over a real (in-memory) model index built
 *     by `buildModelIndex`, asserting the render == what the server would return.
 */

// ── 1. computeLowerConnections parity (mirrors the server fixture exactly) ──────
const parentOf = new Map<string, string | undefined>([
  ['A', undefined], ['B', undefined],
  ['a1', 'A'], ['a1c', 'a1'],
  ['b1', 'B'], ['b1c', 'b1'],
  ['x', undefined],
  ['gObj', undefined],
])

describe('computeLowerConnections — parity with the server roll-up', () => {
  const diagram = { objectIds: ['A', 'B'], groupIds: [] }
  const noGroups = new Map<string, string[]>()

  it('rolls a deep edge up to the nearest visible ancestors', () => {
    expect(computeLowerConnections(diagram, parentOf, noGroups, [{ id: 'deep1', fromId: 'a1c', toId: 'b1c' }])).toEqual([
      { id: 'lower:A→B', fromId: 'A', toId: 'B', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('skips an edge where both endpoints are already directly visible', () => {
    expect(computeLowerConnections(diagram, parentOf, noGroups, [{ id: 'direct1', fromId: 'A', toId: 'B' }])).toEqual([])
  })

  it('skips self-loops after roll-up and dedupes a visible pair (first wins)', () => {
    const lower = computeLowerConnections(diagram, parentOf, noGroups, [
      { id: 'self', fromId: 'a1', toId: 'a1c' },
      { id: 'deep1', fromId: 'a1c', toId: 'b1c' },
      { id: 'deep2', fromId: 'a1', toId: 'b1' },
    ])
    expect(lower.map((l) => l.id)).toEqual(['lower:A→B'])
  })

  it('skips an edge with an endpoint that has no visible representative', () => {
    expect(computeLowerConnections(diagram, parentOf, noGroups, [{ id: 'orphan', fromId: 'a1c', toId: 'x' }])).toEqual([])
  })

  it('falls back to a containing group when that group is on the diagram', () => {
    const diagWithGroup = { objectIds: ['A'], groupIds: ['G'] }
    const groups = new Map<string, string[]>([['G', ['gObj']]])
    expect(computeLowerConnections(diagWithGroup, parentOf, groups, [{ id: 'e', fromId: 'a1c', toId: 'gObj' }])).toEqual([
      { id: 'lower:A→G', fromId: 'A', toId: 'G', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('skips a roll-up the diagram already draws with its own edge, same direction only', () => {
    const conns = [
      { id: 'own', fromId: 'A', toId: 'B' },
      { id: 'deep1', fromId: 'a1c', toId: 'b1c' }, // A→B: drawn by 'own'
      { id: 'back', fromId: 'b1c', toId: 'a1c' }, // B→A: not drawn
    ]
    const withOwn = { objectIds: ['A', 'B'], groupIds: [], connectionIds: ['own'] }
    expect(computeLowerConnections(withOwn, parentOf, noGroups, conns).map((l) => l.id)).toEqual(['lower:B→A'])
    // The same model edge, not on the diagram, suppresses nothing.
    expect(computeLowerConnections(diagram, parentOf, noGroups, conns).map((l) => l.id)).toEqual(['lower:A→B', 'lower:B→A'])
  })

  it('ignores a group that is NOT on the diagram (no fallback)', () => {
    const groups = new Map<string, string[]>([['G', ['gObj']]])
    expect(computeLowerConnections({ objectIds: ['A', 'B'], groupIds: [] }, parentOf, groups, [{ id: 'e', fromId: 'a1c', toId: 'gObj' }])).toEqual([])
  })
})

describe('withOwnConnections — the roll-up input of the cache Worker', () => {
  // The Worker's candidates are the edges leaving the diagram's subtree; an own
  // edge leaving a GROUP on the diagram is not among them.
  it('lets a group-sourced own edge suppress the roll-up of its pair', () => {
    const diagram = { objectIds: ['B'], groupIds: ['G'], connectionIds: ['own'] }
    const groups = new Map<string, string[]>([['G', ['gObj']]])
    const candidates = [{ id: 'deep', fromId: 'gObj', toId: 'b1c' }] // G→B
    const own = [{ id: 'own', fromId: 'G', toId: 'B' }]
    expect(computeLowerConnections(diagram, parentOf, groups, candidates).map((l) => l.id)).toEqual(['lower:G→B'])
    expect(computeLowerConnections(diagram, parentOf, groups, withOwnConnections(candidates, own))).toEqual([])
  })

  it('does not list an edge twice', () => {
    const edge = { id: 'e', fromId: 'A', toId: 'B' }
    expect(withOwnConnections([edge], [edge])).toEqual([edge])
  })
})

// ── 2. buildLocalDiagramRender end-to-end (over a built index) ──────────────────
function obj(id: string, parentId?: string, name = id): C4Object {
  return { id, name, type: 'system', parentId } as unknown as C4Object
}
function conn(id: string, fromId: string, toId: string): Connection {
  return { id, fromId, toId, type: 'solid', label: id } as unknown as Connection
}
function grp(id: string, objectIds: string[]): Group {
  return { id, name: id, objectIds } as unknown as Group
}
function diag(id: string, objectIds: string[], connectionIds: string[], groupIds: string[] = []): Diagram {
  return { id, name: id, type: 'context', objectIds, connectionIds, groupIds } as unknown as Diagram
}

describe('buildLocalDiagramRender — render from the local index', () => {
  // Same two-level hierarchy as the parity fixture, as a real model.
  const objects = [obj('A'), obj('B'), obj('a1', 'A'), obj('a1c', 'a1'), obj('b1', 'B'), obj('b1c', 'b1')]
  const connections = [
    conn('direct1', 'A', 'B'), // both visible → stays direct, no lower
    conn('deep1', 'a1c', 'b1c'), // rolls up A→B
  ]
  const diagrams = [diag('dg', ['A', 'B'], ['direct1']), diag('bare', ['A', 'B'], [])]

  async function freshStore() {
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects, groups: [], connections, diagrams })
    return store
  }

  it('returns the diagram objects, its direct connections, and the lower roll-up', async () => {
    const store = await freshStore()
    const render = await buildLocalDiagramRender(store, 'dg')
    expect(render).toBeTruthy()
    expect(render!.objects.map((o) => o.id).sort()).toEqual(['A', 'B'])

    const direct = render!.connections.filter((c) => c.kind !== 'lower')
    const lower = render!.connections.filter((c) => c.kind === 'lower')
    expect(direct.map((c) => c.id)).toEqual(['direct1'])
    // deep1 (a1c→b1c) rolls up to A→B, which the diagram already draws with
    // direct1: no second line beside it (saoe.dsl IncidentFlow, 2026-10-21).
    expect(lower).toEqual([])
  })

  it('rolls the deep edge up on a diagram that does not draw the pair itself', async () => {
    const store = await freshStore()
    const render = await buildLocalDiagramRender(store, 'bare')
    expect(render!.connections).toEqual([
      { id: 'lower:A→B', fromId: 'A', toId: 'B', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('resolves groups on the diagram and uses them for the roll-up fallback', async () => {
    const store = createMemoryKvStore()
    const gObjects = [obj('A'), obj('a1', 'A'), obj('a1c', 'a1'), obj('gObj')]
    const gGroups = [grp('G', ['gObj'])]
    const gConns = [conn('e', 'a1c', 'gObj')] // a1c→A (ancestor), gObj→G (group)
    await buildModelIndex(store, { objects: gObjects, groups: gGroups, connections: gConns, diagrams: [diag('dg', ['A'], [], ['G'])] })

    const render = await buildLocalDiagramRender(store, 'dg')
    expect(render!.groups.map((g) => g.id)).toEqual(['G'])
    expect(render!.connections.filter((c) => c.kind === 'lower')).toEqual([
      { id: 'lower:A→G', fromId: 'A', toId: 'G', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('returns undefined for a diagram that is not in the index (cold offline)', async () => {
    const store = await freshStore()
    expect(await buildLocalDiagramRender(store, 'nope')).toBeUndefined()
  })

  it('returns the diagram with no lower connections when nothing rolls up', async () => {
    const store = createMemoryKvStore()
    // A flat diagram: every object + edge is directly visible.
    await buildModelIndex(store, {
      objects: [obj('A'), obj('B')],
      groups: [],
      connections: [conn('direct1', 'A', 'B')],
      diagrams: [diag('flat', ['A', 'B'], ['direct1'])],
    })
    const render = await buildLocalDiagramRender(store, 'flat')
    expect(render!.connections.map((c) => c.id)).toEqual(['direct1'])
    expect(render!.connections.some((c) => c.kind === 'lower')).toBe(false)
  })
})
