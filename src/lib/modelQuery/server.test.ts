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
import {
  __resetResolvedWorkspacesForTest,
  holdWorkspaceOn,
  rememberResolvedWorkspace,
} from '../automerge/workspaceBinding'
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

/**
 * What `POST /api/model/durability-witness` ACTUALLY echoes: the workspace
 * whose read model answered (`server/src/index.ts` → `ensureWorkspace` →
 * `canonicalWorkspaceKey`, then `durabilityWitnessPayload`). `current` comes
 * back as the landscape's concrete default version, never as the alias.
 *
 * The previous mock echoed the REQUESTED params. That is how a client comparing
 * the echo with the raw ref passed here while it discarded every live answer
 * for a `current` tab (measured 2026-10-25 on an isolated stack: asked
 * `default/current`, echoed `default/YhKN2DMR6yfdYSBo`, the client kept no
 * values and no proof).
 */
const SERVER_DEFAULT_NOW = 'v-resolved-7'
const CURRENT_REF = { landscapeId: 'ls-main', versionId: 'current' }
const BOOTED_ROOT = 'automerge:booted-root'
type WitnessPayload = {
  absenceProvable?: unknown
  caughtUp?: boolean
  objects?: unknown
  connections?: unknown
}
function canonicalWitnessRoute(
  payload: WitnessPayload,
  seen?: Array<{ url: URL; init?: RequestInit }>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const u = new URL(url, 'http://localhost')
    seen?.push({ url: u, init })
    const versionId = u.searchParams.get('versionId')
    return new Response(JSON.stringify({
      landscapeId: u.searchParams.get('landscapeId'),
      versionId: versionId === 'current' ? SERVER_DEFAULT_NOW : versionId,
      ...payload,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
/** What the boot's root fetch records (`repo.ts` `fetchRootUrl`). */
function rootFetchResolvedCurrentTo(versionId: string, rootUrl = BOOTED_ROOT): void {
  rememberResolvedWorkspace(
    CURRENT_REF,
    { landscapeId: CURRENT_REF.landscapeId, versionId },
    { from: 'root-fetch', rootUrl },
  )
}
const JOURNAL = { ref: CURRENT_REF, bootedRootUrl: BOOTED_ROOT }
const PROVABLE_WITH_VALUES: WitnessPayload = {
  absenceProvable: true,
  objects: { A: { id: 'A', name: 'Auth service' } },
  connections: { c1: { id: 'c1', fromId: 'B', toId: 'A', type: 'solid' } },
}
const asked = (seen: Array<{ url: URL }>) => ({
  landscapeId: seen[0]?.url.searchParams.get('landscapeId'),
  versionId: seen[0]?.url.searchParams.get('versionId'),
})

describe('fetchDurabilityWitness — the batched replay witness', () => {
  afterEach(() => {
    holdWorkspaceOn(null)
    __resetResolvedWorkspacesForTest()
  })

  it('POSTs BOTH id families in one request body, scoped to the workspace, and parses maps', async () => {
    // POST, never GET: 500 long imported ids overflow the request-line/header
    // ceiling (HTTP 431), and a failed witness call defers every stamped
    // intent — the journal would never drain.
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(JOURNAL, ['A', 'missing'], ['c1'])
    expect(seen).toHaveLength(1) // ONE round trip for both families
    expect(seen[0].url.pathname).toBe('/api/model/durability-witness')
    expect(seen[0].init?.method).toBe('POST')
    const body = JSON.parse(String(seen[0].init?.body)) as { objects: string[]; connections: string[] }
    expect(body.objects).toEqual(['A', 'missing'])
    expect(body.connections).toEqual(['c1'])
    expect(result.absenceProvable).toBe(true)
    expect(result.objects.get('A')?.name).toBe('Auth service')
    expect(result.objects.has('missing')).toBe(false)
    expect(result.connections.get('c1')?.toId).toBe('A')
  })

  it('reports an unprovable projection as absenceProvable:false — never silently as absence', async () => {
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    __setServerFetchForTest(canonicalWitnessRoute({ ...PROVABLE_WITH_VALUES, absenceProvable: false }))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(result.absenceProvable).toBe(false)
    // …while PRESENCE stays usable: a projected value was durable when it was
    // projected. Only a discarded answer forfeits the values too.
    expect(result.objects.get('A')?.name).toBe('Auth service')
  })

  // ── a `current` journal: ask about the documents' CONCRETE version ────────

  it('a `current` journal asks about the version its root fetch resolved, and KEEPS the answer', async () => {
    // The defect this pins: the request said `current`, the server echoed the
    // concrete version, the client compared that with `current`, and EVERY
    // answer a `current` tab received was thrown away — witnessesReliable went
    // false on every replay, stamped intents deferred for ever, unstamped ones
    // replayed their whole snapshot instead of merging over the server value.
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], ['c1'])
    expect(asked(seen)).toEqual({ landscapeId: 'ls-main', versionId: SERVER_DEFAULT_NOW })
    expect(result.absenceProvable).toBe(true)
    expect(result.objects.get('A')?.name).toBe('Auth service')
    expect(result.connections.get('c1')?.toId).toBe('A')
  })

  it('after a REPOINT the journal still asks about ITS version, not the new default', async () => {
    // Booted on v-booted-3; an admin has since moved the default to
    // v-resolved-7. Asking `current` would get the new default's read model —
    // another workspace than the one these intents were made in.
    rootFetchResolvedCurrentTo('v-booted-3')
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(asked(seen)).toEqual({ landscapeId: 'ls-main', versionId: 'v-booted-3' })
    expect(result.objects.get('A')?.name).toBe('Auth service')
  })

  it('under a HOLD, still asks about the documents\' version — the hold is not consulted', async () => {
    // The hold re-points the TRANSPORT. The old client sent the held version
    // and then compared the echo with `current`, refusing its own answer. The
    // witness now names the root-fetched version whatever the hold says; the
    // hold is set to a DIFFERENT version here so that re-applying it (the
    // effective ref) would be caught rather than coincide.
    rootFetchResolvedCurrentTo('v-booted-3')
    holdWorkspaceOn({ landscapeId: 'ls-main', versionId: 'v-held-9' })
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(asked(seen)).toEqual({ landscapeId: 'ls-main', versionId: 'v-booted-3' })
    expect(result.absenceProvable).toBe(true)
    expect(result.objects.get('A')?.name).toBe('Auth service')
  })

  it('answers for the JOURNAL\'s workspace, not whatever workspace is active', async () => {
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    setActiveWorkspaceRef({ landscapeId: 'ls-elsewhere', versionId: 'v-9' })
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(asked(seen)).toEqual({ landscapeId: 'ls-main', versionId: SERVER_DEFAULT_NOW })
    expect(result.objects.get('A')?.name).toBe('Auth service')
  })

  // ── when the documents' version cannot be named: no witness, no request ──

  const NO_WITNESS_CASES: Array<[string, () => void, string | null]> = [
    ['no basis at all', () => {}, BOOTED_ROOT],
    // B1 of the review: after an offline boot from the cached root, the first
    // socket binding is adopted as the basis — and the socket may be bound to
    // a version the admin repointed to while the documents are the old one's.
    ['a basis self-armed from a SOCKET BINDING', () => rememberResolvedWorkspace(
      CURRENT_REF, { landscapeId: 'ls-main', versionId: SERVER_DEFAULT_NOW }, { from: 'socket-binding' },
    ), BOOTED_ROOT],
    // A basis from an earlier root fetch, while this session booted another
    // root (the cached one, which another tab may have moved on).
    ['a root-fetched basis recorded beside ANOTHER root url', () => rootFetchResolvedCurrentTo(
      SERVER_DEFAULT_NOW, 'automerge:an-earlier-root',
    ), BOOTED_ROOT],
    ['a session that booted no root url', () => rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW), null],
  ]
  for (const [name, arrange, bootedRootUrl] of NO_WITNESS_CASES) {
    it(`NO witness and NO request for a \`current\` journal with ${name}`, async () => {
      arrange()
      const seen: Array<{ url: URL; init?: RequestInit }> = []
      __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
      const result = await fetchDurabilityWitness({ ref: CURRENT_REF, bootedRootUrl }, ['A'], ['c1'])
      expect(seen).toHaveLength(0)
      expect(result.absenceProvable).toBe(false)
      expect(result.objects.size).toBe(0)
      expect(result.connections.size).toBe(0)
    })
  }

  // ── the echo: anything but exactly the workspace asked is discarded ───────

  it('a CONCRETE journal asks about itself and keeps an exact echo', async () => {
    const seen: Array<{ url: URL; init?: RequestInit }> = []
    __setServerFetchForTest(canonicalWitnessRoute(PROVABLE_WITH_VALUES, seen))
    const result = await fetchDurabilityWitness(
      { ref: { landscapeId: 'ls-main', versionId: 'v-5' }, bootedRootUrl: null }, ['A'], [],
    )
    expect(asked(seen)).toEqual({ landscapeId: 'ls-main', versionId: 'v-5' })
    expect(result.absenceProvable).toBe(true)
    expect(result.objects.get('A')?.name).toBe('Auth service')
  })

  const echoAnswering = (echo: Record<string, unknown>) => async () => new Response(
    JSON.stringify({ ...echo, ...PROVABLE_WITH_VALUES }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

  it('DISCARDS the whole payload when the server resolved another workspace (M3)', async () => {
    // ensureWorkspace redirects a sparse draft to its BASE version's read
    // model. The base's values could equality-acknowledge the draft's own
    // intents (presence poisoning — the losing direction), so a mismatched
    // echo forfeits the values too, not just the proof.
    __setServerFetchForTest(echoAnswering({ landscapeId: 'ls-main', versionId: 'v-base' }))
    const result = await fetchDurabilityWitness(
      { ref: { landscapeId: 'ls-main', versionId: 'v-draft' }, bootedRootUrl: null }, ['A'], ['c1'],
    )
    expect(result.absenceProvable).toBe(false)
    expect(result.objects.size).toBe(0)
    expect(result.connections.size).toBe(0)
  })

  it('DISCARDS an echo for another LANDSCAPE, even one carrying the version asked', async () => {
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    __setServerFetchForTest(echoAnswering({ landscapeId: 'ls-other', versionId: SERVER_DEFAULT_NOW }))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(result.absenceProvable).toBe(false)
    expect(result.objects.size).toBe(0)
  })

  it('DISCARDS an answer with no echo at all (an older or broken server)', async () => {
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    __setServerFetchForTest(echoAnswering({}))
    const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
    expect(result.absenceProvable).toBe(false)
    expect(result.objects.size).toBe(0)
  })

  it('DISCARDS a payload missing either map — a gap is not an empty family', async () => {
    // Read as `{}`, a missing `connections` under `absenceProvable: true`
    // would prove every asked connection absent.
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    const { connections: _omitConnections, ...noConnections } = PROVABLE_WITH_VALUES
    const { objects: _omitObjects, ...noObjects } = PROVABLE_WITH_VALUES
    for (const [payload, label] of [
      [noConnections, 'no connections map'],
      [noObjects, 'no objects map'],
      [{ ...PROVABLE_WITH_VALUES, connections: ['c1'] }, 'connections as an array'],
      [{ ...PROVABLE_WITH_VALUES, objects: null }, 'objects null'],
    ] as Array<[WitnessPayload, string]>) {
      __setServerFetchForTest(canonicalWitnessRoute(payload))
      const result = await fetchDurabilityWitness(JOURNAL, ['A'], ['c1'])
      expect(result.absenceProvable, label).toBe(false)
      expect(result.objects.size, label).toBe(0)
      expect(result.connections.size, label).toBe(0)
    }
  })

  it('THROWS on a server failure — a failed fetch is "unknown", never "absent"', async () => {
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    __setServerFetchForTest(async () => new Response('boom', { status: 503 }))
    await expect(fetchDurabilityWitness(JOURNAL, ['A'], [])).rejects.toThrow(/HTTP 503/)
  })

  it('a missing or malformed absenceProvable is read as NOT provable (old server, bad payload)', async () => {
    // The echo is right here, so the answer is KEPT: what this pins is the
    // strict `=== true` read, not the echo check (with no echo the payload is
    // discarded first and this test would pass whatever the read did).
    rootFetchResolvedCurrentTo(SERVER_DEFAULT_NOW)
    for (const absenceProvable of [undefined, 'true', 1]) {
      __setServerFetchForTest(canonicalWitnessRoute({
        absenceProvable, caughtUp: true, objects: { A: { id: 'A', name: 'Auth service' } }, connections: {},
      }))
      const result = await fetchDurabilityWitness(JOURNAL, ['A'], [])
      expect(result.objects.get('A')?.name).toBe('Auth service')
      expect(result.absenceProvable).toBe(false)
    }
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
