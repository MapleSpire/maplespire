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

// @vitest-environment jsdom
//
// The Spotlight's server-tier wiring, from the survivors of an independent
// mutation battery (QA lens, round 2, 2026-10-25): the request key, the
// complete kinds, deletes, wire rows and previews, the pinned row, the notice.
// The first-pass tests are in SpotlightSearch.test.tsx.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../lib/i18n'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../../lib/automerge/workspace'
import {
  __resetResolvedWorkspacesForTest, adoptBindingAsBasis, holdWorkspaceOn, rememberResolvedWorkspace,
} from '../../lib/automerge/workspaceBinding'
import { setWorkspaceSummaryActive } from '../../lib/modelQuery/summaryTier'
import { __setSpotlightFetchForTest } from '../../lib/search/spotlightServer'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { C4Object, Connection, Diagram, Group } from '../../types'
import { SpotlightSearch } from './SpotlightSearch'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../../lib/search/spotlightCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/search/spotlightCommands')>()
  return { ...actual, openSpotlightResult: opened }
})
const bridge = vi.hoisted(() => ({ windowed: true, tombstones: new Set<string>(), rootUrl: null as string | null }))
vi.mock('../../lib/automerge/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/automerge/bridge')>()
  return {
    ...actual,
    isBootFromServerActive: () => bridge.windowed,
    hasDeleteTombstone: (kind: string, id: string) => bridge.tombstones.has(`${kind}:${id}`),
    sessionRootUrl: () => bridge.rootUrl,
  }
})

function object(id: string, name: string, extra: Partial<C4Object> = {}): C4Object {
  return {
    id, name, type: 'app', position: { x: 0, y: 0 }, size: { width: 100, height: 60 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...extra,
  }
}
const OBJECTS = [
  object('pay', 'Payment service', { shortDescription: 'Captures card payments.' }),
  object('energy', 'Énergie tarifs'),
  object('db', 'Orders database', { type: 'store' }),
]
const CONNECTIONS: Connection[] = [{ id: 'c1', fromId: 'pay', toId: 'db', label: 'Writes payments', type: 'solid' }]
const DIAGRAMS: Diagram[] = [
  { id: 'd1', name: 'Checkout flow', type: 'container', objectIds: ['pay', 'db', 'energy'], connectionIds: ['c1'], groupIds: [] },
]
const input = () => screen.getByTestId('spotlight-input') as HTMLInputElement
const rowKeys = () => [...document.querySelectorAll('[data-testid=spotlight-row]')].map((r) => r.getAttribute('data-key'))
const activeKey = () => document.querySelector('[data-testid=spotlight-row][aria-selected=true]')?.getAttribute('data-key')
const type = (text: string) => fireEvent.change(input(), { target: { value: text } })

const WS = { landscapeId: 'L1', versionId: 'V1' }
interface ServerHit { score: number; doc: Record<string, unknown> }
function serverBody(sections: Array<{ kind: string; total?: number; totalCapped?: boolean; hits: ServerHit[] }>, ws: { landscapeId: string; versionId: string } = WS) {
  return {
    v: 1, topHit: null,
    sections: sections.map((s) => ({ total: s.hits.length, totalCapped: false, ...s })),
    coverage: { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'], flow: ['domain'] } },
    ...ws, projectionGeneration: 3, status: 'healthy', caughtUp: true, absenceProvable: true,
  }
}
const FAR: ServerHit = {
  score: 12,
  doc: {
    kind: 'system', id: 'far', name: 'Payment ledger', description: 'Books every captured payment.',
    tech: ['Kafka'], status: 'live', scope: 'external', diagrams: ['Finance overview'],
    extra: { parentName: null, domainId: null, diagramCount: 3 },
  },
}
let requests: Array<{ url: string; body: Record<string, unknown> }> = []
function serverAnswers(make: (body: Record<string, unknown>) => Response | Promise<Response>) {
  requests = []
  __setSpotlightFetchForTest(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, body })
    return make(body)
  })
}
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(async () => {
  localStorage.clear()
  await i18n.changeLanguage('en')
  useModelStore.setState({
    objects: OBJECTS, connections: CONNECTIONS, diagrams: DIAGRAMS, groups: [], flows: [], decisionRecords: [],
    domains: [], tags: [], currentDiagramId: 'd1', workspaceReadOnly: false,
    pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [], pendingDeletedDiagramIds: [], deletedDiagramIds: [],
  })
  useUIStore.setState({ searchOpen: true, currentView: 'diagram' })
  opened.mockClear()
  localStorage.setItem('maplespire:serverReadModel', 'true')
  bridge.windowed = true
  bridge.tombstones.clear()
  bridge.rootUrl = 'automerge:booted-root'
  __resetResolvedWorkspacesForTest()
  setActiveWorkspaceRef(WS)
  useWorkspaceStore.setState({ ref: WS })
})
afterEach(async () => {
  cleanup()
  useUIStore.setState({ searchOpen: false })
  __setSpotlightFetchForTest(null)
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  useWorkspaceStore.setState({ ref: DEFAULT_WORKSPACE_REF })
  holdWorkspaceOn(null)
  __resetResolvedWorkspacesForTest()
  bridge.rootUrl = null
  setWorkspaceSummaryActive(false)
  useModelStore.setState({ pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [], pendingDeletedDiagramIds: [], deletedDiagramIds: [] })
  vi.restoreAllMocks()
})

describe('SpotlightSearch with the server tier (QA round 2)', () => {
  // The defect the battery found: groups were "complete", so the server was never
  // asked about them, yet a summary-only store holds a window of their placements.
  it('finds a held group by a diagram outside the window, on a summary-only workspace', async () => {
    setWorkspaceSummaryActive(true)
    const zone = { id: 'g1', name: 'Payments zone', objectIds: [], tagAssignments: {}, tagOrder: [] } as unknown as Group
    useModelStore.setState({ objects: [], connections: [], diagrams: [], groups: [zone] })
    serverAnswers(() => ok(serverBody([
      { kind: 'system', hits: [{ score: 0, doc: { kind: 'system', id: 'far', name: 'Ledger', diagrams: ['Off window'], extra: {} } }] },
      { kind: 'group', hits: [{ score: 0, doc: { kind: 'group', id: 'g1', name: 'Payments zone', diagrams: ['Off window'], extra: {} } }] },
    ])))
    render(<SpotlightSearch />)
    type('in:"off window"')
    await waitFor(() => expect(rowKeys()).toContain('system:far')) // witness: the answer was merged
    expect(rowKeys()).toContain('group:g1')
  })

  // X01
  it('lists more than five server hits inside a scope', async () => {
    const hits = Array.from({ length: 8 }, (_, i): ServerHit => ({ score: 0, doc: { kind: 'system', id: `s${i}`, name: `Remote ${i}`, extra: {} } }))
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits }])))
    render(<SpotlightSearch />)
    fireEvent.click(screen.getByTestId('spotlight-scope-objects'))
    await waitFor(() => expect(rowKeys()).toContain('system:s0'))
    expect(rowKeys().filter((k) => k?.startsWith('system:'))).toHaveLength(8)
  })

  // G16
  it('lets the store decide an entity it holds: the projection\'s older copy does not come back', async () => {
    const stale: ServerHit = { score: 12, doc: { kind: 'app', id: 'pay', name: 'Payment ledger v1', extra: {} } }
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }, { kind: 'app', hits: [stale] }])))
    render(<SpotlightSearch />)
    type('ledger')
    await waitFor(() => expect(rowKeys()).toContain('system:far')) // witness: the answer was merged
    expect(rowKeys()).not.toContain('app:pay')
  })

  // X04
  it('asks again when a domain is renamed under the same query', async () => {
    useModelStore.setState({ domains: [{ id: 'd1', name: 'Finance' }] as never })
    serverAnswers(() => ok(serverBody([])))
    render(<SpotlightSearch />)
    type('domain:finance')
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => useModelStore.setState({ domains: [{ id: 'd1', name: 'Finances' }] as never }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body.vocab).toEqual({ domains: [['d1', 'Finances']], tags: [] })
  })

  // X05b
  it('asks the new workspace and drops the old answer when the workspace changes under the same query', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    const WS2 = { landscapeId: 'L1', versionId: 'V2' }
    serverAnswers(() => ok(serverBody([], WS2)))
    act(() => { setActiveWorkspaceRef(WS2); useWorkspaceStore.setState({ ref: WS2 }) })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].url).toMatch(/versionId=V2$/)
    await waitFor(() => expect(rowKeys()).not.toContain('system:far'))
  })

  // G11, after the witness's trust rule (documentsWorkspaceFor) replaced the
  // effective ref: what moves the request is the documents' workspace.
  it('asks a `current` tab about its documents\' version, and again when it boots another root', async () => {
    const alias = { landscapeId: 'L1', versionId: 'current' }
    setActiveWorkspaceRef(alias)
    useWorkspaceStore.setState({ ref: alias })
    rememberResolvedWorkspace(alias, WS, { from: 'root-fetch', rootUrl: 'automerge:booted-root' })
    holdWorkspaceOn(WS)
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    expect(requests[0].url).toMatch(/versionId=V1$/)
    // A reload followed a repoint: V2's root, and a basis beside it.
    const V2 = { landscapeId: 'L1', versionId: 'V2' }
    serverAnswers(() => ok(serverBody([], V2)))
    holdWorkspaceOn(null)
    rememberResolvedWorkspace(alias, V2, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
    bridge.rootUrl = 'automerge:v2-root'
    // Any render after the basis moved (here a store update) must re-key the request.
    act(() => useModelStore.setState({ objects: [...OBJECTS] }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].url).toMatch(/versionId=V2$/)
    await waitFor(() => expect(rowKeys()).not.toContain('system:far'))
  })

  // An offline boot from the cached root (V1's documents) while an admin moved
  // the default to V2: the first socket binds to V2 and the bridge self-arms it
  // as the basis. The server would answer `current` with V2's entities.
  it('shows no server hit to a `current` tab whose basis was self-armed from a socket bound to the repointed version', async () => {
    const alias = { landscapeId: 'L1', versionId: 'current' }
    setActiveWorkspaceRef(alias)
    useWorkspaceStore.setState({ ref: alias })
    bridge.rootUrl = 'automerge:cached-v1-root'
    adoptBindingAsBasis(alias, { landscapeId: 'L1', versionId: 'V2' })
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }], { landscapeId: 'L1', versionId: 'V2' })))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(screen.getByTestId('spotlight-notice')).toBeTruthy())
    expect(rowKeys()).toContain('app:pay') // the store still answers
    expect(rowKeys()).not.toContain('system:far')
    expect(requests).toHaveLength(0)
  })

  // X06
  it('asks again with the scope kinds when the scope changes under the same query', async () => {
    setWorkspaceSummaryActive(true) // diagrams are a window: the server answers them
    const diagramHit: ServerHit = { score: 12, doc: { kind: 'diagram', id: 'd9', name: 'Pa map', extra: {} } }
    serverAnswers((b) => ok(serverBody(b.kinds ? [{ kind: 'system', hits: [FAR] }] : [{ kind: 'system', hits: [FAR] }, { kind: 'diagram', hits: [diagramHit] }])))
    render(<SpotlightSearch />)
    type('pa')
    await waitFor(() => expect(rowKeys()).toContain('diagram:d9'))
    fireEvent.click(screen.getByTestId('spotlight-scope-objects'))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body).toMatchObject({ kinds: ['system', 'app', 'store', 'component', 'actor', 'group'], perKind: 51 })
    expect(rowKeys()).not.toContain('diagram:d9')
  })

  // X08
  it('shows the parent a server hit carried as its subtitle', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'app', hits: [{ score: 16, doc: { kind: 'app', id: 'far-api', name: 'Payment', domain: 'Finance', extra: { parentName: 'Payments platform' } } }] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()).toContain('app:far-api'))
    expect(document.querySelector('[data-key="app:far-api"]')!.textContent).toContain('Payments platform')
  })

  // X09
  it('titles an unlabeled server connection by its endpoints', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'connection', hits: [{ score: 0, doc: { kind: 'connection', id: 'c9', name: '', from: 'Gateway', to: 'Ledger', extra: {} } }] }])))
    render(<SpotlightSearch />)
    type('from:gateway')
    await waitFor(() => expect(rowKeys()).toContain('connection:c9'))
    expect(document.querySelector('[data-key="connection:c9"]')!.textContent).toContain('Gateway → Ledger')
  })

  // X13
  it('previews a server object with its status', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [{ ...FAR, doc: { ...FAR.doc, status: 'unstable' } }] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    expect(screen.getByTestId('spotlight-preview').textContent).toContain('Unstable')
  })

  // X16 (and G09: under the summary contract the server answers diagrams)
  it('previews a server diagram from the counts it carried, on a summary-only workspace', async () => {
    setWorkspaceSummaryActive(true)
    serverAnswers(() => ok(serverBody([{ kind: 'diagram', hits: [{ score: 16, doc: { kind: 'diagram', id: 'd9', name: 'Pa', extra: { type: 'container', objectCount: 7, connectionCount: 2 } } }] }])))
    render(<SpotlightSearch />)
    type('pa')
    await waitFor(() => expect(rowKeys()[0]).toBe('diagram:d9'))
    expect(screen.getByTestId('spotlight-preview').textContent).toContain('7 objects · 2 connections')
  })

  // G08
  it('leaves diagrams to the store when it holds the whole registry', async () => {
    const stale: ServerHit = { score: 12, doc: { kind: 'diagram', id: 'd9', name: 'Payment map', extra: {} } }
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }, { kind: 'diagram', hits: [stale] }])))
    render(<SpotlightSearch />)
    type('pa')
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    expect(rowKeys()).not.toContain('diagram:d9')
  })

  // G05, G06
  it('does not bring back a diagram this tab deleted, on a summary-only workspace', async () => {
    setWorkspaceSummaryActive(true)
    useModelStore.setState({ deletedDiagramIds: ['d9'] })
    const hit = (id: string, name: string): ServerHit => ({ score: 12, doc: { kind: 'diagram', id, name, extra: {} } })
    serverAnswers(() => ok(serverBody([{ kind: 'diagram', hits: [hit('d9', 'Pa gone'), hit('d10', 'Pa kept')] }])))
    render(<SpotlightSearch />)
    type('pa')
    await waitFor(() => expect(rowKeys()).toContain('diagram:d10'))
    expect(rowKeys()).not.toContain('diagram:d9')
  })

  // G03, G03b
  it.each([
    ['a tombstone the bridge holds', () => { bridge.tombstones.add('connection:c9') }],
    ['a delete the bridge has not picked up yet', () => { useModelStore.setState({ pendingDeletedConnectionIds: ['c9'] }) }],
  ])('does not bring back a connection this tab deleted (%s)', async (_label, deleteIt) => {
    deleteIt()
    const hit = (id: string, name: string): ServerHit => ({ score: 12, doc: { kind: 'connection', id, name, from: 'A', to: 'B', extra: {} } })
    serverAnswers(() => ok(serverBody([{ kind: 'connection', hits: [hit('c9', 'Pays out'), hit('c10', 'Pays in')] }])))
    render(<SpotlightSearch />)
    type('pays')
    await waitFor(() => expect(rowKeys()).toContain('connection:c10'))
    expect(rowKeys()).not.toContain('connection:c9')
  })

  // V01
  it('shows "N+" even when a capped count does not exceed the rows listed', async () => {
    const hits = [0, 1].map((i): ServerHit => ({ score: 12, doc: { kind: 'system', id: `s${i}`, name: `Payment ${i}`, extra: {} } }))
    serverAnswers(() => ok(serverBody([{ kind: 'system', total: 2, totalCapped: true, hits }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()).toContain('system:s1'))
    expect(screen.getByTestId('spotlight-section-objects').textContent).toContain('2+')
  })

  // P05
  it('keeps the row a group jump moved to when the server answer inserts rows above it', async () => {
    let release: (() => void) | null = null
    serverAnswers(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return ok(serverBody([{ kind: 'system', hits: [FAR] }]))
    })
    render(<SpotlightSearch />)
    type('payment')
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true })
    expect(activeKey()).toBe('connection:c1')
    await waitFor(() => expect(requests).toHaveLength(1))
    release!()
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    expect(activeKey()).toBe('connection:c1')
  })

  // P06
  it('keeps the row the pointer moved to when the server answer inserts rows above it', async () => {
    let release: (() => void) | null = null
    serverAnswers(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return ok(serverBody([{ kind: 'system', hits: [FAR] }]))
    })
    render(<SpotlightSearch />)
    type('payment')
    fireEvent.mouseMove(document.querySelector('[data-key="connection:c1"]')!)
    expect(activeKey()).toBe('connection:c1')
    await waitFor(() => expect(requests).toHaveLength(1))
    release!()
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    expect(activeKey()).toBe('connection:c1')
  })

  // P01
  it('goes back to the first row when the query changes, even if the row moved to is still listed', () => {
    bridge.windowed = false
    render(<SpotlightSearch />)
    type('payment')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(activeKey()).toBe('connection:c1')
    type('paymen')
    expect(rowKeys()).toContain('connection:c1')
    expect(activeKey()).toBe(rowKeys()[0])
    expect(activeKey()).not.toBe('connection:c1')
  })

  // P08
  it('says the results are partial on the empty state too', async () => {
    serverAnswers(() => new Response('{}', { status: 503 }))
    render(<SpotlightSearch />)
    type('zzzqqq')
    await waitFor(() => expect(requests).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('spotlight-notice')).toBeTruthy())
    expect(rowKeys()).toEqual([])
  })
})
