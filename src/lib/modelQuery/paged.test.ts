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
import { pagedModelQuery, __setPagedStoreForTest, __setPagedEntityCacheForTest } from './paged'
import { __setServerFetchForTest } from './server'
import { createMemoryKvStore } from './kvStore'
import { buildModelIndex, indexRelatedDiagrams } from './modelIndex'
import type { C4Object, Connection, Group, Diagram } from '../../types'
import type { SearchHit } from './types'
import { seededTechnologyUsages } from '../technologyUsage'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'

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

  it('connectionsMany agrees with resident, absent ids omitted', async () => {
    const ask = ['c1', 'c4', 'missing']
    const paged = await pagedModelQuery.connectionsMany(ask)
    const resident = await residentModelQuery.connectionsMany(ask)
    expect([...paged.keys()].sort()).toEqual(['c1', 'c4'])
    expect([...resident.keys()].sort()).toEqual(['c1', 'c4'])
    expect(paged.get('c4')?.fromId).toBe('G1')
  })

  // An inline expansion asked for its connections one request each.
  it('connectionsMany asks the server in ONE batch, and fills the gaps from the index', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    const remote = conn('remote', 'A', 'B')
    const requests: string[] = []
    __setServerFetchForTest(async (input) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ projectionGeneration: 1, items: [{ connection: remote }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await pagedModelQuery.connectionsMany(['remote', 'c1'])

    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('/api/model/cache/connections/by-ids')
    expect(decodeURIComponent(requests[0])).toContain('ids=remote,c1')
    expect(result.get('remote')).toEqual(remote)
    expect(result.get('c1')?.fromId, 'the index answers for what the server did not').toBe('B')
  })

  // 100 per request, the change feed's batch on the same GET route: 500 long
  // imported ids (UUIDs) would make a URL past nginx's 8 KB request line.
  it('connectionsMany batches at 100 ids', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    const requested: number[] = []
    __setServerFetchForTest(async (input) => {
      const idsParam = new URL(String(input), 'http://x').searchParams.get('ids') ?? ''
      requested.push(idsParam.split(',').length)
      return new Response(JSON.stringify({ projectionGeneration: 1, items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await pagedModelQuery.connectionsMany(Array.from({ length: 1001 }, (_, i) => `k${i}`))
    expect(requested).toEqual([...Array(10).fill(100), 1])
  })

  it('connectionsMany falls back to the index when the server fails', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    __setServerFetchForTest(async () => { throw new TypeError('Failed to fetch') })
    const result = await pagedModelQuery.connectionsMany(['c1', 'c2'])
    expect([...result.keys()].sort()).toEqual(['c1', 'c2'])
  })

  // QA lens, review 3: the index is a working set and may be older than the
  // server — it fills gaps, it does not overwrite what the server answered.
  it('connectionsMany keeps the server\'s answer over the index\'s for an id both know', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    const fresher = conn('c1', 'C', 'A', { label: 'renamed on the server' })
    __setServerFetchForTest(async () => new Response(
      JSON.stringify({ projectionGeneration: 1, items: [{ connection: fresher }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const result = await pagedModelQuery.connectionsMany(['c1', 'c2'])

    expect(result.get('c1'), 'the index overwrote the server').toEqual(fresher)
    expect(result.get('c2')?.fromId, 'the gap is still filled').toBe('A')
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

  describe('offline point lookups fall back to the COMPLETE offline copy in the Worker', () => {
    // Regression, 2026-10-16 (e2e/boot/offline-readmodel.spec.ts): after "Make
    // available offline", the offline Model Objects table listed an off-window
    // object (page ladders read the Worker), but selecting it opened no editor —
    // the point lookups fell back to the legacy index only, which nothing fills
    // under boot-from-server any more.
    const remote = obj('off-window', { name: 'Only in the Worker cache' })
    const remoteGroup = grp('off-group', { name: 'Group in the Worker cache' })
    const remoteConnection = conn('off-conn', 'A', 'off-window')
    let calls: Array<{ workspaceKey: string; ids: string[]; connectionIds: string[] }> = []
    let coverage: 'full' | 'working-set' = 'full'
    beforeEach(() => {
      calls = []
      coverage = 'full'
      vi.stubGlobal('navigator', { onLine: false })
      __setPagedEntityCacheForTest({
        getEntities: async ({ workspaceKey, ids, connectionIds }) => {
          calls.push({ workspaceKey, ids, connectionIds })
          return {
            coverage,
            entities: [remote, remoteGroup, obj('A', { name: 'stale server copy of A' })]
              .filter((e) => ids.includes(e.id)),
            connections: [remoteConnection].filter((c) => connectionIds.includes(c.id)),
          }
        },
      })
    })
    afterEach(() => __setPagedEntityCacheForTest(null))

    it('lookupMany / object / group / connectionsMany answer from the Worker for ids the index lacks', async () => {
      const many = await pagedModelQuery.lookupMany(['A', remote.id, remoteGroup.id, 'absent'])
      expect(many.get(remote.id)?.name).toBe('Only in the Worker cache')
      expect(many.get(remoteGroup.id)?.name).toBe('Group in the Worker cache')
      expect(many.has('absent')).toBe(false)
      expect((await pagedModelQuery.object(remote.id))?.name).toBe('Only in the Worker cache')
      expect(await pagedModelQuery.object(remoteGroup.id)).toBeUndefined() // a group is not an object
      expect(await pagedModelQuery.group(remote.id)).toBeUndefined() // …nor an object a group
      // The ACTIVE workspace's copy, keyed exactly as the explorers and the render cache key it.
      expect(new Set(calls.map((c) => c.workspaceKey))).toEqual(new Set([workspaceRefKey(currentWorkspaceRef())]))
      expect((await pagedModelQuery.group(remoteGroup.id))?.name).toBe('Group in the Worker cache')
      expect((await pagedModelQuery.connectionsMany([remoteConnection.id])).get(remoteConnection.id)?.toId).toBe('off-window')
    })

    it('the index wins over the Worker (it alone carries this browser\'s off-window edits), and is asked first', async () => {
      const many = await pagedModelQuery.lookupMany(['A', remote.id])
      expect(many.get('A')?.name).toBe('A')
      // The Worker is asked only for what the index could not answer.
      expect(calls.at(-1)?.ids).toEqual([remote.id])
      // …and even a Worker that over-answers cannot replace an index record.
      __setPagedEntityCacheForTest({
        getEntities: async () => ({ coverage: 'full' as const, entities: [remote, obj('A', { name: 'stale server copy of A' })], connections: [] }),
      })
      expect((await pagedModelQuery.lookupMany(['A', remote.id])).get('A')?.name).toBe('A')
    })

    it('a WORKING-SET generation is refused: its payloads are explorer placeholders, not entities', async () => {
      // 2026-10-16: the editor seeds what a lookup returns into the
      // editable window, so a placeholder (empty properties, zero size) would be
      // written over the real entity by the first keystroke.
      coverage = 'working-set'
      const many = await pagedModelQuery.lookupMany([remote.id, remoteGroup.id])
      expect(calls.length).toBeGreaterThan(0) // void-run guard: the Worker WAS asked
      expect(many.size).toBe(0)
      expect(await pagedModelQuery.object(remote.id)).toBeUndefined()
      expect(await pagedModelQuery.group(remoteGroup.id)).toBeUndefined()
      expect((await pagedModelQuery.connectionsMany([remoteConnection.id])).size).toBe(0)
    })

    it('ONLINE, a server miss stays index-only: a stale copy cannot bring back what the server deleted', async () => {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
      })
      vi.stubGlobal('navigator', { onLine: true })
      __setServerFetchForTest(async (input) => {
        const url = String(input)
        const body = url.includes('/api/model/lookup') ? { entities: [] }
          : url.includes('/connections') ? { connections: [] }
            : { object: null, group: null }
        return new Response(JSON.stringify(body), { status: url.includes('/api/model/lookup') || url.includes('/connections') ? 200 : 404, headers: { 'content-type': 'application/json' } })
      })
      expect((await pagedModelQuery.lookupMany([remote.id])).has(remote.id)).toBe(false)
      expect(await pagedModelQuery.object(remote.id)).toBeUndefined()
      expect(await pagedModelQuery.group(remoteGroup.id)).toBeUndefined()
      expect(calls).toEqual([])
    })

    it('a failing Worker leaves the index answer intact', async () => {
      __setPagedEntityCacheForTest({ getEntities: async () => { throw new Error('worker gone') } })
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const many = await pagedModelQuery.lookupMany(['A', remote.id])
      expect(many.get('A')?.id).toBe('A')
      expect(many.has(remote.id)).toBe(false)
    })
  })

  describe('an access refusal is final — never answered from this browser\'s caches', () => {
    // Regression, 2026-10-11 (app.maplespire.ca): after signing out and creating
    // a new account in the same browser, the app booted with the previous
    // account's persisted landscape. The server answered 403, the ladder fell to
    // the local rungs, and the shape explorer listed the PREVIOUS account's
    // objects under "Offline results are limited to this device's working set".
    // The local caches are keyed by workspace, not by user, so a refusal must
    // end the ladder. The 503 arm is the control: an outage still falls back.
    function serverAnswers(status: number) {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
      })
      vi.stubGlobal('navigator', { onLine: true })
      __setServerFetchForTest(async () => new Response(JSON.stringify({ error: 'x' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }))
    }

    for (const status of [401, 403]) {
      it(`HTTP ${status}: every page ladder rejects instead of serving local data`, async () => {
        serverAnswers(status)
        await expect(pagedModelQuery.objectTreePage({ limit: 50 })).rejects.toMatchObject({ status })
        await expect(pagedModelQuery.objectSearchPage({ query: 'abc', limit: 50 })).rejects.toMatchObject({ status })
        await expect(pagedModelQuery.connectionPage({ limit: 50 })).rejects.toMatchObject({ status })
        await expect(pagedModelQuery.dependencyPage({ focusId: 'A', direction: 'incoming', limit: 50 }))
          .rejects.toMatchObject({ status })
        await expect(pagedModelQuery.viewerLevel({ limit: 50 })).rejects.toMatchObject({ status })
      })
    }

    it('point lookups keep their offline fallback on a refusal (callers do not handle a rejection)', async () => {
      // Deliberate: see `stopsFallback`. The cross-account case is closed at
      // the source by the data-owner purge, not here.
      serverAnswers(403)
      expect((await pagedModelQuery.object('A'))?.id).toBe('A')
      expect((await pagedModelQuery.group('G1'))?.id).toBe('G1')
      expect((await pagedModelQuery.lookupMany(['A'])).has('A')).toBe(true)
    })

    it('HTTP 503 (control): an outage still falls back to the local working set', async () => {
      serverAnswers(503)
      const page = await pagedModelQuery.objectTreePage({ limit: 50 })
      expect(page.coverage).toBe('working-set')
      expect(page.items.length).toBeGreaterThan(0)
      expect((await pagedModelQuery.object('A'))?.id).toBe('A')
      expect((await pagedModelQuery.lookupMany(['A'])).has('A')).toBe(true)
    })
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
