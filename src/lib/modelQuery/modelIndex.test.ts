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

import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { residentModelQuery } from './resident'
import { createMemoryKvStore, type KvStore } from './kvStore'
import {
  buildModelIndex, buildModelIndexChunked, applyModelChanges, diffModelChanges,
  indexIncoming, indexOutgoing, indexObject, indexGroup, indexConnectionCount,
  indexDescendants, indexRelatedDiagrams, indexSearch,
  indexAllObjects, indexAllConnections, indexAllGroups, indexAllDiagrams,
  indexModelObjectFacets,
} from './modelIndex'
import type { C4Object, Connection, Group, Diagram } from '../../types'
import type { SearchHit } from './types'
import { seededTechnologyUsages } from '../technologyUsage'
import { TECHNOLOGY_POSTINGS_DIRTY_KEY, technologyPostingsFor } from './technologyPostings'

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
      conn('c1', 'B', 'A'),
      conn('c2', 'A', 'C', { kind: 'direct' }),
      conn('c3', 'A', 'A'), // self-loop
      conn('c4', 'G1', 'A'),
      conn('c5', 'A', 'C', { kind: 'lower' }),
    ],
  }
}

const ids = (es: { connection: Connection }[]) => es.map((e) => e.connection.id).sort()

let store: KvStore
beforeEach(async () => {
  store = createMemoryKvStore()
  await buildModelIndex(store, fixture())
})

describe('buildModelIndexChunked — identical index, time-sliced', () => {
  const dump = async (s: KvStore) => {
    const all = await s.scanPrefix<unknown>('')
    return all.map(([k, v]) => [k, JSON.stringify(v)] as [string, string]).sort((a, b) => a[0].localeCompare(b[0]))
  }
  it('produces byte-identical entries to buildModelIndex (small yieldEvery forces yields)', async () => {
    const diagrams: Diagram[] = [
      { id: 'dg1', name: 'dg1', type: 'context', objectIds: ['A', 'B'], connectionIds: [], groupIds: [], parentObjectId: 'A' } as Diagram,
    ]
    const model = { ...fixture(), diagrams }
    const full = createMemoryKvStore()
    await buildModelIndex(full, model)
    const chunked = createMemoryKvStore()
    await buildModelIndexChunked(chunked, model, undefined, 1) // yield after every item
    expect(await dump(chunked)).toEqual(await dump(full))
  })
  it('reports write progress and finishes at total', async () => {
    const store = createMemoryKvStore()
    const calls: [number, number][] = []
    await buildModelIndexChunked(store, fixture(), (d, t) => calls.push([d, t]))
    expect(calls.length).toBeGreaterThan(0)
    const last = calls[calls.length - 1]
    expect(last[0]).toBe(last[1]) // done === total at the end
  })
})

describe('modelIndex — whole-family enumeration (scanPrefix)', () => {
  it('enumerates objects/connections/groups/diagrams without colliding on o:/c:/g:/d: prefixes', async () => {
    // Rebuild including diagrams so d:/od:/dpo: keys coexist with o:/c:/g:.
    store = createMemoryKvStore()
    const diagrams: Diagram[] = [
      { id: 'dg1', name: 'D1', type: 'context', objectIds: ['A', 'B'], connectionIds: ['c1'], groupIds: ['G1'], parentObjectId: 'A' },
    ]
    await buildModelIndex(store, { ...fixture(), diagrams })

    expect((await indexAllObjects(store)).map((o) => o.id).sort()).toEqual(['A', 'B', 'C', 'D'])
    // 5 connections incl. the lower one — enumeration returns the raw records.
    expect((await indexAllConnections(store)).map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect((await indexAllGroups(store)).map((g) => g.id)).toEqual(['G1'])
    // d: must NOT pick up od:/dpo: (those have non-':' at index 1).
    expect((await indexAllDiagrams(store)).map((d) => d.id)).toEqual(['dg1'])
  })
})

describe('modelIndex — built index matches expectations', () => {
  it('incoming/outgoing: self-loops excluded, peers resolved', async () => {
    const inc = await indexIncoming(store, 'A')
    expect(ids(inc)).toEqual(['c1', 'c4'])
    expect(inc.map((e) => e.peerId).sort()).toEqual(['B', 'G1'])
    const out = await indexOutgoing(store, 'A')
    expect(ids(out)).toEqual(['c2', 'c5'])
    expect(out.map((e) => e.peerId)).toEqual(['C', 'C'])
  })

  it('self-loop is in neither fan', async () => {
    expect((await indexIncoming(store, 'A')).some((e) => e.connection.id === 'c3')).toBe(false)
    expect((await indexOutgoing(store, 'A')).some((e) => e.connection.id === 'c3')).toBe(false)
  })

  it('entity lookups + counts', async () => {
    expect((await indexObject(store, 'A'))?.name).toBe('A')
    expect((await indexGroup(store, 'G1'))?.name).toBe('G1')
    expect(await indexObject(store, 'missing')).toBeUndefined()
    expect(await indexConnectionCount(store, 'A')).toBe(5)
    expect(await indexConnectionCount(store, 'G1')).toBe(1)
    expect(await indexConnectionCount(store, 'missing')).toBe(0)
  })

  it('descendants: BFS over the children index', async () => {
    expect(await indexDescendants(store, 'A')).toEqual(['D']) // D.parentId === A, D has no children
    expect(await indexDescendants(store, 'B')).toEqual([]) // leaf
  })
})

describe('modelIndex — paged == resident (no divergence)', () => {
  it('the persisted index agrees with residentModelQuery on the same model', async () => {
    const f = fixture()
    useModelStore.setState({ objects: f.objects, connections: f.connections, groups: f.groups, diagrams: [] })

    for (const focus of ['A', 'B', 'C', 'G1']) {
      expect(ids(await indexIncoming(store, focus))).toEqual(ids(await residentModelQuery.incoming(focus)))
      expect(ids(await indexOutgoing(store, focus))).toEqual(ids(await residentModelQuery.outgoing(focus)))
      expect(await indexConnectionCount(store, focus)).toBe(await residentModelQuery.connectionCount(focus))
    }
    expect(await indexObject(store, 'A')).toEqual(await residentModelQuery.object('A'))
    expect(await indexGroup(store, 'G1')).toEqual(await residentModelQuery.group('G1'))
  })
})

describe('modelIndex — incremental updates', () => {
  it('maintains the complete team facet without scanning object records at query time', async () => {
    const s = createMemoryKvStore()
    await buildModelIndex(s, {
      objects: [
        obj('a', { ownerTeamIds: ['team-b', 'team-shared'] }),
        obj('b', { teamIds: ['team-a', 'team-shared'] }),
      ],
      groups: [], connections: [],
    })
    expect(await indexModelObjectFacets(s)).toEqual({ teamIds: ['team-a', 'team-b', 'team-shared'] })

    await applyModelChanges(s, {
      upsertObjects: [obj('a', { ownerTeamIds: ['team-c'] })],
      removeObjectIds: ['b'],
    })
    expect(await indexModelObjectFacets(s)).toEqual({ teamIds: ['team-c'] })
  })

  it('accepts an off-window edit before technology postings finish their first build', async () => {
    const fresh = createMemoryKvStore()
    const edited = obj('early-edit', {
      technologyUsages: seededTechnologyUsages('early-edit', ['PostgreSQL']),
    })

    await expect(applyModelChanges(fresh, { upsertObjects: [edited] })).resolves.toBeUndefined()
    expect((await indexObject(fresh, edited.id))?.technologyUsages).toEqual(edited.technologyUsages)
    expect(await technologyPostingsFor(fresh).entityIdsForTechnologies(['tech_seed_postgresql']))
      .toEqual([edited.id])
    expect(await fresh.get(TECHNOLOGY_POSTINGS_DIRTY_KEY)).toBeUndefined()
  })

  it('keeps group technology postings coherent across an off-window group edit', async () => {
    const fresh = createMemoryKvStore()
    const edited = grp('group-edit', {
      technologyUsages: seededTechnologyUsages('group-edit', ['Terraform']),
    })

    await expect(applyModelChanges(fresh, { upsertGroups: [edited] })).resolves.toBeUndefined()
    expect((await indexGroup(fresh, edited.id))?.technologyUsages).toEqual(edited.technologyUsages)
    expect(await technologyPostingsFor(fresh).entityIdsForTechnologies(['tech_seed_terraform']))
      .toEqual([edited.id])
    expect(await fresh.get(TECHNOLOGY_POSTINGS_DIRTY_KEY)).toBeUndefined()
  })

  it('adds a connection + object', async () => {
    await applyModelChanges(store, { addConnections: [conn('c6', 'E', 'A')], upsertObjects: [obj('E')] })
    expect(ids(await indexIncoming(store, 'A'))).toEqual(['c1', 'c4', 'c6'])
    expect((await indexObject(store, 'E'))?.name).toBe('E')
  })

  it('removes a connection', async () => {
    await applyModelChanges(store, { removeConnections: [conn('c1', 'B', 'A')] })
    expect(ids(await indexIncoming(store, 'A'))).toEqual(['c4'])
  })

  it('moving an endpoint updates both old and new adjacency', async () => {
    // c2 was A→C; move it to A→B.
    await applyModelChanges(store, {
      removeConnections: [conn('c2', 'A', 'C')],
      addConnections: [conn('c2', 'A', 'B')],
    })
    const byId = Object.fromEntries((await indexOutgoing(store, 'A')).map((e) => [e.connection.id, e.peerId]))
    expect(byId['c2']).toBe('B')
    expect(byId['c5']).toBe('C')
    expect(ids(await indexIncoming(store, 'C'))).toEqual(['c5']) // C lost c2
    expect(ids(await indexIncoming(store, 'B'))).toEqual(['c2']) // B gained c2
  })

  it('deletes an object', async () => {
    await applyModelChanges(store, { removeObjectIds: ['B'] })
    expect(await indexObject(store, 'B')).toBeUndefined()
  })

  it('reparenting moves a child between ch: lists (descendants follow)', async () => {
    // Add E under D (so A's subtree is D → E).
    await applyModelChanges(store, {
      upsertObjects: [obj('E', { parentId: 'D' })],
      addObjectParents: [{ parentId: 'D', id: 'E' }],
    })
    expect((await indexDescendants(store, 'A')).sort()).toEqual(['D', 'E'])
    // Reparent E from D to B (remove old + add new, like a real diff).
    await applyModelChanges(store, {
      upsertObjects: [obj('E', { parentId: 'B' })],
      removeObjectParents: [{ parentId: 'D', id: 'E' }],
      addObjectParents: [{ parentId: 'B', id: 'E' }],
    })
    expect(await indexDescendants(store, 'A')).toEqual(['D'])
    expect(await indexDescendants(store, 'B')).toEqual(['E'])
  })
})

describe('diffModelChanges — reference-identity diff', () => {
  const inp = (objects: C4Object[], groups: Group[], connections: Connection[]) => ({ objects, groups, connections })

  it('upserts only ref-changed entities; removes the missing', () => {
    const a = obj('A'), b = obj('B')
    const a2 = obj('A', { name: 'A-renamed' }) // new ref
    const d = diffModelChanges(inp([a, b], [], []), inp([a2, b], [], []))
    expect(d.upsertObjects).toEqual([a2]) // b unchanged (same ref) → not upserted
    expect(d.removeObjectIds).toEqual([])

    const d2 = diffModelChanges(inp([a, b], [], []), inp([a], [], []))
    expect(d2.removeObjectIds).toEqual(['B'])
  })

  it('endpoint move emits remove(old)+add(new); same-endpoint change emits add only', () => {
    const c = conn('c1', 'A', 'B')
    const cMoved = conn('c1', 'A', 'C') // endpoint changed
    const moved = diffModelChanges(inp([], [], [c]), inp([], [], [cMoved]))
    expect(moved.removeConnections).toEqual([c])
    expect(moved.addConnections).toEqual([cMoved])

    const cLabel = conn('c1', 'A', 'B', { label: 'x' }) // same endpoints, new field
    const labelled = diffModelChanges(inp([], [], [c]), inp([], [], [cLabel]))
    expect(labelled.removeConnections).toEqual([])
    expect(labelled.addConnections).toEqual([cLabel])
  })

  it('object reparent emits removeObjectParents(old) + addObjectParents(new)', () => {
    const d = obj('D', { parentId: 'A' })
    const dMoved = obj('D', { parentId: 'B' })
    const moved = diffModelChanges(inp([d], [], []), inp([dMoved], [], []))
    expect(moved.removeObjectParents).toEqual([{ parentId: 'A', id: 'D' }])
    expect(moved.addObjectParents).toEqual([{ parentId: 'B', id: 'D' }])

    // new object with a parent → add only; removed object with a parent → remove only
    const added = diffModelChanges(inp([], [], []), inp([obj('X', { parentId: 'A' })], [], []))
    expect(added.addObjectParents).toEqual([{ parentId: 'A', id: 'X' }])
    expect(added.removeObjectParents).toEqual([])
    const removed = diffModelChanges(inp([obj('Y', { parentId: 'A' })], [], []), inp([], [], []))
    expect(removed.removeObjectParents).toEqual([{ parentId: 'A', id: 'Y' }])
  })

  it('diff → applyModelChanges keeps the index consistent with a full rebuild', async () => {
    const before = fixture()
    const fresh = createMemoryKvStore()
    await buildModelIndex(fresh, before)
    // mutate: move c2 A→C to A→B; add E (child of A) + connection E→A; reparent D
    // from A to C; delete object B.
    const after = {
      objects: [
        ...before.objects
          .filter((o) => o.id !== 'B')
          .map((o) => (o.id === 'D' ? obj('D', { parentId: 'C', domainId: 'dom1' }) : o)),
        obj('E', { parentId: 'A' }),
      ],
      groups: before.groups,
      connections: [
        ...before.connections.map((c) => (c.id === 'c2' ? conn('c2', 'A', 'B', { kind: 'direct' }) : c)),
        conn('c6', 'E', 'A'),
      ],
    }
    await applyModelChanges(fresh, diffModelChanges(before, after))

    // a from-scratch index of `after` must agree with the incrementally-updated one.
    const rebuilt = createMemoryKvStore()
    await buildModelIndex(rebuilt, after)
    for (const focus of ['A', 'B', 'C', 'D', 'E', 'G1']) {
      expect(ids(await indexIncoming(fresh, focus))).toEqual(ids(await indexIncoming(rebuilt, focus)))
      expect(ids(await indexOutgoing(fresh, focus))).toEqual(ids(await indexOutgoing(rebuilt, focus)))
      expect((await indexDescendants(fresh, focus)).sort()).toEqual(
        (await indexDescendants(rebuilt, focus)).sort()
      )
    }
    expect(await indexObject(fresh, 'B')).toBeUndefined()
    expect((await indexObject(fresh, 'E'))?.name).toBe('E')
    expect(await indexDescendants(fresh, 'A')).toEqual(['E']) // D moved to C
    expect(await indexDescendants(fresh, 'C')).toEqual(['D'])
  })
})

describe('modelIndex — diagrams (relatedDiagrams)', () => {
  const dia = (id: string, objectIds: string[], over: Partial<Diagram> = {}): Diagram => ({
    id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [], ...over,
  })
  const objs = [obj('A'), obj('B'), obj('C'), obj('D', { parentId: 'A' })]
  const dgs = [
    dia('dgRoot', ['A', 'B'], { type: 'context' }),
    dia('dgDetailA', ['C'], { parentObjectId: 'A' }),
    dia('dgContainsD', ['D'], { parentObjectId: 'A' }),
  ]
  const rel = (r: { detail: Diagram[]; reference: Diagram[]; parent: Diagram[] }) => ({
    detail: r.detail.map((d) => d.id).sort(),
    reference: r.reference.map((d) => d.id).sort(),
    parent: r.parent.map((d) => d.id).sort(),
  })

  it('built index: reference/detail/parent precedence + currentDiagram exclusion', async () => {
    const s = createMemoryKvStore()
    await buildModelIndex(s, { objects: objs, groups: [], connections: [], diagrams: dgs })
    expect(rel(await indexRelatedDiagrams(s, 'A', null))).toEqual({
      detail: ['dgContainsD', 'dgDetailA'], reference: ['dgRoot'], parent: [],
    })
    // D: dgContainsD is a reference (contains D) → excluded from parent (dpo:A)
    expect(rel(await indexRelatedDiagrams(s, 'D', null))).toEqual({
      detail: [], reference: ['dgContainsD'], parent: ['dgDetailA'],
    })
    expect((await indexRelatedDiagrams(s, 'A', 'dgRoot')).reference).toEqual([]) // active excluded
    expect(await indexRelatedDiagrams(s, 'missing', null)).toEqual({ detail: [], reference: [], parent: [] })
  })

  it('diff → apply keeps diagram membership consistent with a rebuild', async () => {
    const before = { objects: objs, groups: [], connections: [], diagrams: dgs }
    const fresh = createMemoryKvStore()
    await buildModelIndex(fresh, before)
    // dgDetailA swaps C→D; dgContainsD reparented A→B; dgRoot removed.
    const after = {
      objects: objs, groups: [], connections: [],
      diagrams: [dia('dgDetailA', ['D'], { parentObjectId: 'A' }), dia('dgContainsD', ['D'], { parentObjectId: 'B' })],
    }
    await applyModelChanges(fresh, diffModelChanges(before, after))
    const rebuilt = createMemoryKvStore()
    await buildModelIndex(rebuilt, after)
    for (const focus of ['A', 'B', 'C', 'D']) {
      expect(rel(await indexRelatedDiagrams(fresh, focus, null)))
        .toEqual(rel(await indexRelatedDiagrams(rebuilt, focus, null)))
    }
  })
})

describe('modelIndex — search (trigram)', () => {
  const sobjs = [
    obj('o1', { name: 'Auth service', technologyUsages: seededTechnologyUsages('o1', ['Node.js']), description: 'handles login' }),
    obj('o2', { name: 'Auth database', technologyUsages: seededTechnologyUsages('o2', ['PostgreSQL']) }),
    obj('o3', { name: 'Payment service', technologyUsages: seededTechnologyUsages('o3', ['Go']) }),
  ]
  const sconns = [conn('k1', 'o1', 'o2', { label: 'authenticates' })]
  const sig = (hits: SearchHit[]) => hits.map((h) => (h.type === 'object' ? `o:${h.object.id}` : `c:${h.connection.id}`))

  it('substring match + ranking (name > tech > description > label)', async () => {
    const s = createMemoryKvStore()
    await buildModelIndex(s, { objects: sobjs, groups: [], connections: sconns })
    // 'auth': both Auth objects (name, score 4) then the connection label (score 1);
    // objects first, ties broken by name asc → o2 ('database') before o1 ('service').
    expect(sig(await indexSearch(s, 'auth'))).toEqual(['o:o2', 'o:o1', 'c:k1'])
    expect(sig(await indexSearch(s, 'postgres'))).toEqual(['o:o2']) // technology
    expect(sig(await indexSearch(s, 'log'))).toEqual(['o:o1']) // description 'login'
    expect(await indexSearch(s, 'au')).toEqual([]) // below min chars
    expect(await indexSearch(s, 'zzz')).toEqual([]) // no match
  })

  it('rename updates the trigram index (diff → apply)', async () => {
    const before = { objects: sobjs, groups: [], connections: sconns }
    const s = createMemoryKvStore()
    await buildModelIndex(s, before)
    const after = { objects: [sobjs[0], sobjs[1], obj('o3', { name: 'Billing service', technologyUsages: seededTechnologyUsages('o3', ['Go']) })], groups: [], connections: sconns }
    await applyModelChanges(s, diffModelChanges(before, after))
    expect(sig(await indexSearch(s, 'payment'))).toEqual([]) // old name's grams removed
    expect(sig(await indexSearch(s, 'billing'))).toEqual(['o:o3']) // new name indexed
  })

  it('connection hits resolve endpoint names', async () => {
    const s = createMemoryKvStore()
    await buildModelIndex(s, { objects: sobjs, groups: [], connections: sconns })
    const hit = (await indexSearch(s, 'authenticates'))[0]
    expect(hit.type).toBe('connection')
    if (hit.type === 'connection') {
      expect(hit.fromName).toBe('Auth service')
      expect(hit.toName).toBe('Auth database')
    }
  })
})
