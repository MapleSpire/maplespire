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
import { createMemoryKvStore } from './kvStore'
import {
  buildModelIndex,
  indexObject, indexGroup, indexIncoming, indexOutgoing,
  indexDescendants, indexConnectionCount, indexRelatedDiagrams,
} from './modelIndex'
import {
  coldBuildIndexFromShards,
  applyObjectShardDelta,
  applyConnectionShardDelta,
  applyRegistryDelta,
} from './shardIndexSync'
import type { C4Object, Connection, Group, Diagram } from '../../types'

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const conn = (id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection =>
  ({ id, fromId, toId, type: 'solid', ...over })
const grp = (id: string, over: Partial<Group> = {}): Group => ({ id, name: id, color: '#888', objectIds: [], tagAssignments: {}, tagOrder: [], ...over })
const dia = (id: string, objectIds: string[], over: Partial<Diagram> = {}): Diagram =>
  ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [], ...over })
const ids = (es: { connection: Connection }[]) => es.map((e) => e.connection.id).sort()

describe('shardIndexSync (slice 4b: index maintained from shards)', () => {
  it('cold-build + per-shard object delta == fresh full rebuild', async () => {
    const shard0 = [obj('A'), obj('B')]
    const shard1 = [obj('C'), obj('D', { parentId: 'A' })]
    const connections = [conn('c1', 'B', 'A'), conn('c2', 'A', 'C')]
    const groups = [grp('G1')]
    const merged = { objects: [...shard0, ...shard1], groups, connections, diagrams: [] }

    const inc = createMemoryKvStore()
    await coldBuildIndexFromShards(inc, merged)

    // Mutate only shard1: reparent D (A→C), add E (child of A).
    const shard1b = [obj('C'), obj('D', { parentId: 'C' }), obj('E', { parentId: 'A' })]
    await applyObjectShardDelta(inc, shard1, shard1b)

    const fresh = createMemoryKvStore()
    await buildModelIndex(fresh, { objects: [...shard0, ...shard1b], groups, connections, diagrams: [] })

    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      expect((await indexObject(inc, id))?.name).toEqual((await indexObject(fresh, id))?.name)
      expect((await indexDescendants(inc, id)).sort()).toEqual((await indexDescendants(fresh, id)).sort())
    }
    expect(await indexDescendants(inc, 'A')).toEqual(['E'])
    expect(await indexDescendants(inc, 'C')).toEqual(['D'])
  })

  it('per-shard connection delta keeps adjacency consistent with a rebuild', async () => {
    const objects = [obj('A'), obj('B'), obj('C')]
    const cShard = [conn('c1', 'A', 'B')]
    const inc = createMemoryKvStore()
    await coldBuildIndexFromShards(inc, { objects, groups: [], connections: cShard, diagrams: [] })

    // c1 endpoint moves B→C; add c2 A→B.
    const cShardB = [conn('c1', 'A', 'C'), conn('c2', 'A', 'B')]
    await applyConnectionShardDelta(inc, cShard, cShardB)

    const fresh = createMemoryKvStore()
    await buildModelIndex(fresh, { objects, groups: [], connections: cShardB, diagrams: [] })
    for (const id of ['A', 'B', 'C']) {
      expect(ids(await indexOutgoing(inc, id))).toEqual(ids(await indexOutgoing(fresh, id)))
      expect(ids(await indexIncoming(inc, id))).toEqual(ids(await indexIncoming(fresh, id)))
      expect(await indexConnectionCount(inc, id)).toEqual(await indexConnectionCount(fresh, id))
    }
  })

  it('an object shard delta never disturbs other shards', async () => {
    const shard0 = [obj('A'), obj('B')]
    const shard1 = [obj('C')]
    const inc = createMemoryKvStore()
    await coldBuildIndexFromShards(inc, { objects: [...shard0, ...shard1], groups: [], connections: [], diagrams: [] })

    await applyObjectShardDelta(inc, shard1, []) // delete C (its whole shard emptied)
    expect(await indexObject(inc, 'C')).toBeUndefined()
    expect((await indexObject(inc, 'A'))?.name).toBe('A') // shard0 intact
    expect((await indexObject(inc, 'B'))?.name).toBe('B')
  })

  it('registry delta maintains groups + diagrams without touching objects/connections', async () => {
    const objects = [obj('A')]
    const connections = [conn('c1', 'A', 'A')] // self-loop, count 1
    const groups0 = [grp('G1')]
    const diagrams0 = [dia('d1', ['A'])]
    const inc = createMemoryKvStore()
    await coldBuildIndexFromShards(inc, { objects, groups: groups0, connections, diagrams: diagrams0 })

    const groups1 = [grp('G1'), grp('G2')]
    const diagrams1 = [dia('d1', ['A']), dia('d2', ['A'])]
    await applyRegistryDelta(inc, { groups: groups0, diagrams: diagrams0 }, { groups: groups1, diagrams: diagrams1 })

    expect((await indexGroup(inc, 'G2'))?.name).toBe('G2')
    // objects/connections must be untouched by the registry delta
    expect((await indexObject(inc, 'A'))?.name).toBe('A')
    expect(await indexConnectionCount(inc, 'A')).toBe(1)
    // diagram membership updated: A is now referenced by d1 + d2
    const rel = await indexRelatedDiagrams(inc, 'A', null)
    expect(rel.reference.map((d) => d.id).sort()).toEqual(['d1', 'd2'])
  })
})
