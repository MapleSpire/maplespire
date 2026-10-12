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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { residentModelQuery } from './resident'
import { pagedModelQuery, __setPagedStoreForTest } from './paged'
import { __setServerFetchForTest } from './server'
import { createMemoryKvStore } from './kvStore'
import { buildModelIndex, indexRelatedDiagrams } from './modelIndex'
import type { C4Object, Connection, Group, Diagram } from '../../types'
import type { SearchHit } from './types'
import { seededTechnologyUsages } from '../technologyUsage'

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  }
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function grp(id: string, over: Partial<Group> = {}): Group {
  return { id, name: id, color: '#888888', objectIds: [], tagAssignments: {}, tagOrder: [], ...over }
}
function fixture() {
  return {
    objects: [obj('A'), obj('B'), obj('C'), obj('D', { parentId: 'A', domainId: 'dom1' })],
    groups: [grp('G1', { domainId: 'dom2' })],
    connections: [
      conn('c1', 'B', 'A'), conn('c2', 'A', 'C', { kind: 'direct' }), conn('c3', 'A', 'A'),
      conn('c4', 'G1', 'A'), conn('c5', 'A', 'C', { kind: 'lower' }),
    ],
  }
}
const ids = (es: { connection: Connection }[]) => es.map((e) => e.connection.id).sort()

beforeEach(async () => {
  const store = createMemoryKvStore()
  __setPagedStoreForTest(store)
  await buildModelIndex(store, fixture())
  // Resident reads the store too — seed it identically so we can cross-check.
  const f = fixture()
  useModelStore.setState({ objects: f.objects, connections: f.connections, groups: f.groups, diagrams: [] })
})
afterEach(() => {
  __setPagedStoreForTest(null)
  __setServerFetchForTest(null)
  vi.unstubAllGlobals()
})

describe('pagedModelQuery — served from the index, equals resident', () => {
  it('serves complete team facets from the index, independent of the resident window', async () => {
    const s = createMemoryKvStore()
    __setPagedStoreForTest(s)
    await buildModelIndex(s, {
      objects: [obj('off-window', { ownerTeamIds: ['team-off-window'] })],
      groups: [], connections: [],
    })
    useModelStore.setState({ objects: [], groups: [], connections: [], diagrams: [] })
    expect(await pagedModelQuery.modelObjectFacets()).toEqual({ teamIds: ['team-off-window'] })
  })

  it('incoming/outgoing/connectionCount agree with resident for every focus', async () => {
    for (const focus of ['A', 'B', 'C', 'G1']) {
      expect(ids(await pagedModelQuery.incoming(focus))).toEqual(ids(await residentModelQuery.incoming(focus)))
      expect(ids(await pagedModelQuery.outgoing(focus))).toEqual(ids(await residentModelQuery.outgoing(focus)))
      expect(await pagedModelQuery.connectionCount(focus)).toBe(await residentModelQuery.connectionCount(focus))
    }
  })

  it('object/group/lookupMany resolve correctly', async () => {
    expect((await pagedModelQuery.object('A'))?.name).toBe('A')
    expect((await pagedModelQuery.group('G1'))?.name).toBe('G1')
    expect(await pagedModelQuery.object('missing')).toBeUndefined()
    const m = await pagedModelQuery.lookupMany(['A', 'G1', 'missing'])
    expect(m.get('A')?.name).toBe('A')
    expect(m.get('G1')?.name).toBe('G1')
    expect(m.has('missing')).toBe(false)
  })

  it('resolves an off-window dependency focus from the server before the local index is complete', async () => {
    const emptyIndex = createMemoryKvStore()
    __setPagedStoreForTest(emptyIndex)
    const remote = obj('remote-focus', { name: 'Remote focus' })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    __setServerFetchForTest(async (input) => {
      expect(String(input)).toContain('/api/model/lookup')
      return new Response(JSON.stringify({ entities: [[remote.id, remote]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await pagedModelQuery.lookupMany([remote.id])

    expect(result.get(remote.id)?.name).toBe('Remote focus')
  })

  it('hydrates an off-window object from the server for a canvas drop', async () => {
    const emptyIndex = createMemoryKvStore()
    __setPagedStoreForTest(emptyIndex)
    const remote = obj('remote-drop', { name: 'Double-entry Ledger / 10' })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    __setServerFetchForTest(async (input) => {
      expect(String(input)).toContain('/api/model/object/remote-drop')
      return new Response(JSON.stringify({ object: remote }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await pagedModelQuery.object(remote.id)

    expect(result?.name).toBe('Double-entry Ledger / 10')
  })

  it('descendants agrees with resident', async () => {
    for (const focus of ['A', 'B', 'C', 'D']) {
      expect((await pagedModelQuery.descendants(focus)).sort()).toEqual(
        (await residentModelQuery.descendants(focus)).sort()
      )
    }
    expect(await pagedModelQuery.descendants('A')).toEqual(['D'])
  })

  it('relatedDiagrams agrees with resident', async () => {
    const objects = [obj('A'), obj('B'), obj('C'), obj('D', { parentId: 'A' })]
    const diagrams: Diagram[] = [
      { id: 'dgRoot', name: 'Root', type: 'context', objectIds: ['A', 'B'], connectionIds: [], groupIds: [] },
      { id: 'dgDetailA', name: 'Detail A', type: 'container', objectIds: ['C'], connectionIds: [], groupIds: [], parentObjectId: 'A' },
      { id: 'dgContainsD', name: 'Contains D', type: 'container', objectIds: ['D'], connectionIds: [], groupIds: [], parentObjectId: 'A' },
    ]
    const s = createMemoryKvStore()
    __setPagedStoreForTest(s)
    await buildModelIndex(s, { objects, groups: [], connections: [], diagrams })
    useModelStore.setState({ objects, connections: [], groups: [], diagrams, currentDiagramId: null })

    const rel = (r: { detail: Diagram[]; reference: Diagram[]; parent: Diagram[] }) => ({
      detail: r.detail.map((d) => d.id).sort(),
      reference: r.reference.map((d) => d.id).sort(),
      parent: r.parent.map((d) => d.id).sort(),
    })
    for (const focus of ['A', 'B', 'C', 'D']) {
      expect(rel(await pagedModelQuery.relatedDiagrams(focus)))
        .toEqual(rel(await residentModelQuery.relatedDiagrams(focus)))
    }
    expect(rel(await pagedModelQuery.relatedDiagrams('D'))).toEqual({
      detail: [], reference: ['dgContainsD'], parent: ['dgDetailA'],
    })
  })

  // Regression: the user created two diagrams for a container (parentObjectId = the
  // container) but the container's shape did not link to them. Under boot-from-server
  // the IndexedDB diagram index (dpo:/od:) is NOT refreshed on diagram creation, so it
  // stays STALE — while the resident diagrams registry IS updated. relatedDiagrams must
  // answer from the fresh registry. This builds the index with NO related diagram (stale),
  // then puts a freshly-created detail diagram only in the registry, and asserts it links.
  it('finds a freshly-created diagram present in the registry but MISSING from the (stale) index', async () => {
    const objects = [obj('Container30')]
    const s = createMemoryKvStore()
    __setPagedStoreForTest(s)
    // Index built with NO diagrams — mimics the stale post-boot index.
    await buildModelIndex(s, { objects, groups: [], connections: [], diagrams: [] })
    // ...but the registry now carries two detail diagrams the user just created.
    const created: Diagram[] = [
      { id: 'olivier2', name: 'olivier 2', type: 'component', objectIds: [], connectionIds: [], groupIds: [], parentObjectId: 'Container30' },
      { id: 'olivierDiagram', name: 'olivier diagram', type: 'component', objectIds: [], connectionIds: [], groupIds: [], parentObjectId: 'Container30' },
    ]
    useModelStore.setState({ objects, connections: [], groups: [], diagrams: created, currentDiagramId: 'someOtherDiagram' })

    const r = await pagedModelQuery.relatedDiagrams('Container30')
    expect(r.detail.map((d) => d.id).sort()).toEqual(['olivier2', 'olivierDiagram'])

    // Proof the bug was real (not a tautology): the OLD index-backed path returns nothing
    // for the same stale index — that empty result was the "shape not linked to my diagrams".
    const stale = await indexRelatedDiagrams(s, 'Container30', 'someOtherDiagram')
    expect(stale.detail).toEqual([])
  })

  it('search agrees with resident (>= 3 chars), incl. technologies[] array', async () => {
    const objects = [
      obj('o1', { name: 'Auth service', technologyUsages: seededTechnologyUsages('o1', ['Node.js']), description: 'handles login' }),
      obj('o2', { name: 'Auth database', technologyUsages: seededTechnologyUsages('o2', ['PostgreSQL']) }),
      obj('o3', { name: 'Payment service', technologyUsages: seededTechnologyUsages('o3', ['Go']) }),
      // modern field: searchable tech lives in technologies[], not `technology`.
      obj('o4', { name: 'Stream processor', technologyUsages: seededTechnologyUsages('o4', ['Kafka', 'Flink']) }),
    ]
    const connections = [conn('k1', 'o1', 'o2', { label: 'authenticates' })]
    const s = createMemoryKvStore()
    __setPagedStoreForTest(s)
    await buildModelIndex(s, { objects, groups: [], connections })
    useModelStore.setState({ objects, connections, groups: [], diagrams: [] })

    const sig = (hits: SearchHit[]) =>
      hits.map((h) => (h.type === 'object' ? `o:${h.object.id}` : `c:${h.connection.id}:${h.fromName}>${h.toName}`))
    for (const q of ['auth', 'service', 'postgres', 'log', 'authenticates', 'kafka', 'flink', 'au', 'zzz']) {
      expect(sig(await pagedModelQuery.search(q))).toEqual(sig(await residentModelQuery.search(q)))
    }
    // technologies[] is now actually findable.
    expect((await residentModelQuery.search('kafka')).map((h) => (h.type === 'object' ? h.object.id : ''))).toContain('o4')
  })
})
