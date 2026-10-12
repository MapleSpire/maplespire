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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { residentModelQuery } from './resident'
import { serverModelQuery, fetchDurabilityWitness, __setServerFetchForTest } from './server'
import { __setPagedStoreForTest } from './paged'
import { createMemoryKvStore } from './kvStore'
import { buildModelIndex } from './modelIndex'
import { fetchDiagramRender, __setDiagramRenderFetchForTest } from './diagramRender'
import { setActiveWorkspaceRef, currentWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'
import type { C4Object, Connection, Group, Diagram } from '../../types'
import type { SearchHit } from './types'
import { seededTechnologyUsages } from '../technologyUsage'

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const conn = (id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection =>
  ({ id, fromId, toId, type: 'solid', ...over })
const grp = (id: string, over: Partial<Group> = {}): Group => ({ id, name: id, color: '#888', objectIds: [], tagAssignments: {}, tagOrder: [], ...over })

function fixture() {
  return {
    objects: [
      obj('A', { name: 'Auth service', technologyUsages: seededTechnologyUsages('A', ['Node.js']), description: 'handles login' }),
      obj('B', { name: 'Billing' }),
      obj('C', { name: 'Catalog' }),
      obj('D', { parentId: 'A', name: 'Auth db', technologyUsages: seededTechnologyUsages('D', ['PostgreSQL']) }),
      obj('E', { name: 'Stream processor', technologyUsages: seededTechnologyUsages('E', ['Kafka', 'Flink']) }),
    ],
    groups: [grp('G1', { name: 'Group One' })],
    connections: [
      conn('c1', 'B', 'A'),
      conn('c2', 'A', 'C', { kind: 'direct', label: 'authenticates' }),
      conn('c3', 'A', 'A'),
      conn('c4', 'G1', 'A'),
    ],
    diagrams: [
      { id: 'dgRoot', name: 'Root', type: 'context', objectIds: ['A', 'B'], connectionIds: [], groupIds: [] },
      { id: 'dgDetailA', name: 'Detail A', type: 'container', objectIds: ['C'], connectionIds: [], groupIds: [], parentObjectId: 'A' },
      { id: 'dgContainsD', name: 'Contains D', type: 'container', objectIds: ['D'], connectionIds: [], groupIds: [], parentObjectId: 'A' },
    ] as Diagram[],
  }
}

/**
 * A fake fetch that returns the server's API JSON shape, with the *values* computed
 * from the resident query (the server-side SQL→resident parity is proven by the
 * server's own integration tests). So this asserts serverModelQuery's fetch+map
 * layer is a faithful pass-through: server == resident.
 */
function residentBackedFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://localhost')
    const p = u.pathname
    const q = u.searchParams
    if (p === '/api/model/dependencies') {
      const f = q.get('focus') ?? ''
      return json({ incoming: await residentModelQuery.incoming(f), outgoing: await residentModelQuery.outgoing(f) })
    }
    if (p.startsWith('/api/model/object/')) {
      const object = await residentModelQuery.object(decodeURIComponent(p.slice('/api/model/object/'.length)))
      return object ? json({ object }) : json({ error: 'not found' }, 404)
    }
    if (p.startsWith('/api/model/group/')) {
      const group = await residentModelQuery.group(decodeURIComponent(p.slice('/api/model/group/'.length)))
      return group ? json({ group }) : json({ error: 'not found' }, 404)
    }
    if (p === '/api/model/lookup') {
      const m = await residentModelQuery.lookupMany((q.get('ids') ?? '').split(',').filter(Boolean))
      return json({ entities: [...m.entries()] })
    }
    if (p === '/api/model/connection-count') return json({ count: await residentModelQuery.connectionCount(q.get('id') ?? '') })
    if (p === '/api/model/descendants') return json({ ids: await residentModelQuery.descendants(q.get('object') ?? '') })
    if (p === '/api/model/related-diagrams') {
      return json(await residentModelQuery.relatedDiagrams(q.get('object') ?? '', {
        query: q.get('q') ?? undefined,
        limit: Number(q.get('limit') ?? 50),
      }))
    }
    if (p === '/api/model/related-diagram-object-ids') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { objectIds?: string[] }
      return json({ ids: await residentModelQuery.relatedDiagramObjectIds(body.objectIds ?? []) })
    }
    if (p === '/api/model/search') return json({ hits: await residentModelQuery.search(q.get('q') ?? '', Number(q.get('limit') ?? 12)) })
    if (p === '/api/model/object-facets') return json(await residentModelQuery.modelObjectFacets())
    return json({ error: 'unknown route' }, 404)
  }
}

const cids = (es: { connection: Connection }[]) => es.map((e) => e.connection.id).sort()
const sig = (hits: SearchHit[]) =>
  hits.map((h) => (h.type === 'object' ? `o:${h.object.id}` : `c:${h.connection.id}:${h.fromName}>${h.toName}`))

beforeEach(async () => {
  const f = fixture()
  useModelStore.setState({ objects: f.objects, connections: f.connections, groups: f.groups, diagrams: f.diagrams, currentDiagramId: null })
  const store = createMemoryKvStore()
  __setPagedStoreForTest(store)
  await buildModelIndex(store, f)
  __setServerFetchForTest(residentBackedFetch())
})
afterEach(() => {
  __setServerFetchForTest(null)
  __setPagedStoreForTest(null)
  __setDiagramRenderFetchForTest(null)
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
})

describe('serverModelQuery — server == resident over the API (mapping is a faithful pass-through)', () => {
  it('incoming / outgoing / connectionCount agree with resident', async () => {
    for (const focus of ['A', 'B', 'C', 'D', 'G1']) {
      expect(cids(await serverModelQuery.incoming(focus))).toEqual(cids(await residentModelQuery.incoming(focus)))
      expect(cids(await serverModelQuery.outgoing(focus))).toEqual(cids(await residentModelQuery.outgoing(focus)))
      expect(await serverModelQuery.connectionCount(focus)).toBe(await residentModelQuery.connectionCount(focus))
    }
  })

  it('object / group / lookupMany agree (and 404 → undefined)', async () => {
    expect((await serverModelQuery.object('A'))?.name).toBe('Auth service')
    expect(await serverModelQuery.object('missing')).toBeUndefined()
    expect((await serverModelQuery.group('G1'))?.name).toBe('Group One')
    expect(await serverModelQuery.group('missing')).toBeUndefined()
    const m = await serverModelQuery.lookupMany(['A', 'G1', 'missing'])
    expect(m.get('A')?.name).toBe('Auth service')
    expect(m.get('G1')?.name).toBe('Group One')
    expect(m.has('missing')).toBe(false)
    expect((await serverModelQuery.lookupMany([])).size).toBe(0)
  })

  it('descendants agrees with resident', async () => {
    for (const focus of ['A', 'B', 'D']) {
      expect((await serverModelQuery.descendants(focus)).sort()).toEqual((await residentModelQuery.descendants(focus)).sort())
    }
    expect(await serverModelQuery.descendants('A')).toEqual(['D'])
  })

  it('relatedDiagrams agrees with resident (reference/detail/parent)', async () => {
    const rel = (r: { detail: Diagram[]; reference: Diagram[]; parent: Diagram[] }) => ({
      detail: r.detail.map((d) => d.id).sort(),
      reference: r.reference.map((d) => d.id).sort(),
      parent: r.parent.map((d) => d.id).sort(),
    })
    for (const focus of ['A', 'B', 'C', 'D']) {
      expect(rel(await serverModelQuery.relatedDiagrams(focus))).toEqual(rel(await residentModelQuery.relatedDiagrams(focus)))
    }
    expect(rel(await serverModelQuery.relatedDiagrams('D'))).toEqual({ detail: [], reference: ['dgContainsD'], parent: ['dgDetailA'] })
  })

  it('relatedDiagrams forwards the bounded limit and server-side search', async () => {
    expect((await serverModelQuery.relatedDiagrams('A', { query: 'root', limit: 7 })).reference.map((d) => d.id))
      .toEqual(['dgRoot'])
    expect((await serverModelQuery.relatedDiagrams('A', { query: 'missing', limit: 7 })).totals.reference)
      .toBe(0)
  })

  it('batch-resolves related-diagram affordances without marking current-only objects', async () => {
    useModelStore.setState({ currentDiagramId: 'dgRoot' })
    expect(await serverModelQuery.relatedDiagramObjectIds(['A', 'B', 'D', 'E', 'D']))
      .toEqual(['A', 'D'])
  })

  it('search agrees with resident (ranking + endpoint names + technologies[])', async () => {
    for (const queryStr of ['auth', 'service', 'postgres', 'login', 'authenticates', 'kafka', 'flink', 'au', 'zzz']) {
      expect(sig(await serverModelQuery.search(queryStr))).toEqual(sig(await residentModelQuery.search(queryStr)))
    }
    expect((await serverModelQuery.search('kafka')).some((h) => h.type === 'object' && h.object.id === 'E')).toBe(true)
  })

  it('model object facets agree with resident', async () => {
    useModelStore.setState({
      objects: [obj('team-object', { ownerTeamIds: ['team-b'], teamIds: ['team-a'] })],
    })
    expect(await serverModelQuery.modelObjectFacets()).toEqual({ teamIds: ['team-a', 'team-b'] })
  })

  it('propagates a non-404 server error', async () => {
    __setServerFetchForTest(async () => new Response('boom', { status: 500 }))
    await expect(serverModelQuery.connectionCount('A')).rejects.toThrow(/HTTP 500/)
  })
})

describe('fetchDurabilityWitness — the batched replay witness', () => {
  it('POSTs BOTH id families in one request body, scoped to the workspace, and parses maps', async () => {
    // POST, never GET: 500 long imported ids overflow the request-line/header
    // ceiling (HTTP 431), and a failed witness call defers every stamped
    // intent — the journal would never drain.
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(async (url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://localhost')
      seen.push({ url: u, init })
      return new Response(JSON.stringify({
        // Echo the workspace the request asked for, as the real route does.
        landscapeId: u.searchParams.get('landscapeId'),
        versionId: u.searchParams.get('versionId'),
        absenceProvable: true,
        objects: { A: { id: 'A', name: 'Auth service' } },
        connections: { c1: { id: 'c1', fromId: 'B', toId: 'A', type: 'solid' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = await fetchDurabilityWitness(['A', 'missing'], ['c1'])
    expect(seen).toHaveLength(1) // ONE round trip for both families
    expect(seen[0].url.pathname).toBe('/api/model/durability-witness')
    expect(seen[0].init?.method).toBe('POST')
    const body = JSON.parse(String(seen[0].init?.body)) as { objects: string[]; connections: string[] }
    expect(body.objects).toEqual(['A', 'missing'])
    expect(body.connections).toEqual(['c1'])
    // Workspace scoping is not optional — a witness answering for the wrong
    // workspace would be worse than no witness.
    expect(seen[0].url.searchParams.get('landscapeId')).toBeTruthy()
    expect(result.absenceProvable).toBe(true)
    expect(result.objects.get('A')?.name).toBe('Auth service')
    expect(result.objects.has('missing')).toBe(false)
    expect(result.connections.get('c1')?.toId).toBe('A')
  })

  it('reports an unprovable projection as absenceProvable:false — never silently as absence', async () => {
    __setServerFetchForTest(async (url: string) => {
      const u = new URL(url, 'http://localhost')
      return new Response(
        JSON.stringify({
          landscapeId: u.searchParams.get('landscapeId'),
          versionId: u.searchParams.get('versionId'),
          absenceProvable: false, objects: {}, connections: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const result = await fetchDurabilityWitness(['A'], [])
    expect(result.absenceProvable).toBe(false)
    expect(result.objects.size).toBe(0)
  })

  it('DISCARDS the whole payload when the server resolved another workspace (M3)', async () => {
    // ensureWorkspace redirects static/sparse-draft workspaces to their BASE
    // version's read model. The base's values could equality-acknowledge the
    // draft's own intents (presence poisoning — the losing direction), so a
    // mismatched echo forfeits the values too, not just the proof.
    __setServerFetchForTest(async () => new Response(
      JSON.stringify({
        landscapeId: 'the-parent-landscape', versionId: 'the-base-version',
        absenceProvable: true,
        objects: { A: { id: 'A', name: 'parent copy' } },
        connections: {},
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const result = await fetchDurabilityWitness(['A'], [])
    expect(result.absenceProvable).toBe(false)
    expect(result.objects.size).toBe(0)
    expect(result.connections.size).toBe(0)
  })

  it('THROWS on a server failure — a failed fetch is "unknown", never "absent"', async () => {
    __setServerFetchForTest(async () => new Response('boom', { status: 503 }))
    await expect(fetchDurabilityWitness(['A'], [])).rejects.toThrow(/HTTP 503/)
  })

  it('a missing or malformed absenceProvable is read as NOT provable (old server, bad payload)', async () => {
    __setServerFetchForTest(async () => new Response(
      JSON.stringify({ caughtUp: true, objects: {}, connections: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    expect((await fetchDurabilityWitness(['A'], [])).absenceProvable).toBe(false)
  })
})

/**
 * Every `/api/model/*` request carries the active workspace's `landscapeId` +
 * `versionId` (the shared client/server contract) — asserted here
 * per endpoint so a regression that drops the params on any one call site is caught.
 */
describe('serverModelQuery — every request carries the active workspace', () => {
  const capture = (): { urls: string[]; fetcher: (url: string) => Promise<Response> } => {
    const urls: string[] = []
    return {
      urls,
      fetcher: async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({
          incoming: [], outgoing: [], entities: [], count: 0, ids: [],
          detail: [], reference: [], parent: [], hits: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
  }
  const paramsOf = (url: string) => new URL(url, 'http://localhost').searchParams

  it('defaults to the default workspace (landscapeId=default, versionId=current)', async () => {
    const { urls, fetcher } = capture()
    __setServerFetchForTest(fetcher)
    await serverModelQuery.incoming('A')
    await serverModelQuery.object('A')
    await serverModelQuery.group('A')
    await serverModelQuery.lookupMany(['A'])
    await serverModelQuery.connectionCount('A')
    await serverModelQuery.descendants('A')
    await serverModelQuery.relatedDiagrams('A', { query: 'needle', limit: 7 })
    await serverModelQuery.relatedDiagramObjectIds(['A', 'B'])
    await serverModelQuery.search('auth')
    await serverModelQuery.modelObjectFacets()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      const q = paramsOf(url)
      expect(q.get('landscapeId')).toBe('default')
      expect(q.get('versionId')).toBe('current')
    }
  })

  it('a non-default active workspace is reflected on every request', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-42', versionId: 'v-7' })
    const { urls, fetcher } = capture()
    __setServerFetchForTest(fetcher)
    await serverModelQuery.incoming('A')
    await serverModelQuery.outgoing('A')
    await serverModelQuery.object('A')
    await serverModelQuery.group('A')
    await serverModelQuery.lookupMany(['A'])
    await serverModelQuery.connectionCount('A')
    await serverModelQuery.descendants('A')
    await serverModelQuery.relatedDiagrams('A')
    await serverModelQuery.relatedDiagramObjectIds(['A', 'B'])
    await serverModelQuery.search('auth')
    await serverModelQuery.modelObjectFacets()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      const q = paramsOf(url)
      expect(q.get('landscapeId')).toBe('ls-42')
      expect(q.get('versionId')).toBe('v-7')
    }
  })

  it('own params (focus/id/ids/object/q) survive alongside the workspace params', async () => {
    const { urls, fetcher } = capture()
    __setServerFetchForTest(fetcher)
    await serverModelQuery.incoming('focus-1')
    await serverModelQuery.search('needle', 5)
    await serverModelQuery.relatedDiagrams('A', { query: 'needle', limit: 7 })
    const depsUrl = urls.find((u) => u.includes('/api/model/dependencies'))
    const searchUrl = urls.find((u) => u.includes('/api/model/search'))
    expect(paramsOf(depsUrl!).get('focus')).toBe('focus-1')
    expect(paramsOf(searchUrl!).get('q')).toBe('needle')
    expect(paramsOf(searchUrl!).get('limit')).toBe('5')
    const relatedUrl = urls.find((u) => u.includes('/api/model/related-diagrams'))
    expect(paramsOf(relatedUrl!).get('q')).toBe('needle')
    expect(paramsOf(relatedUrl!).get('limit')).toBe('7')
  })

  it('fetchDiagramRender carries the active workspace (boot-from-server keys per workspace)', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-9', versionId: 'v-1' })
    let calledUrl = ''
    __setDiagramRenderFetchForTest(async (url) => {
      calledUrl = url
      return new Response(JSON.stringify({ projectionGeneration: 1, objects: [], connections: [], groups: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    await fetchDiagramRender('dg1')
    const q = paramsOf(calledUrl)
    expect(q.get('id')).toBe('dg1')
    expect(q.get('landscapeId')).toBe('ls-9')
    expect(q.get('versionId')).toBe('v-1')
  })
})

describe('getModelQuery() selection no longer depends on the active workspace', () => {
  afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

  it('currentWorkspaceRef reflects a non-default switch (sanity check for the seam below)', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
    expect(currentWorkspaceRef()).toEqual({ landscapeId: 'ls-1', versionId: 'v-1' })
  })
})
