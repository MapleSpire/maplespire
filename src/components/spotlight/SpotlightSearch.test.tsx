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
// The Spotlight wired to the REAL stores, i18n and search core. Only the final
// navigation is stubbed, to observe what a choice opens.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../lib/i18n'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../../lib/automerge/workspace'
import { __setSpotlightFetchForTest } from '../../lib/search/spotlightServer'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { C4Object, Connection, Diagram } from '../../types'
import { SpotlightSearch } from './SpotlightSearch'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../../lib/search/spotlightCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/search/spotlightCommands')>()
  return { ...actual, openSpotlightResult: opened }
})
// The bridge's view of this session: whether the store is a window (boot-from-
// server active) and which entities it holds delete tombstones for.
const bridge = vi.hoisted(() => ({ windowed: true, tombstones: new Set<string>() }))
vi.mock('../../lib/automerge/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/automerge/bridge')>()
  return {
    ...actual,
    isBootFromServerActive: () => bridge.windowed,
    hasDeleteTombstone: (kind: string, id: string) => bridge.tombstones.has(`${kind}:${id}`),
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
const type = (text: string) => fireEvent.change(input(), { target: { value: text } })

beforeEach(async () => {
  localStorage.clear()
  await i18n.changeLanguage('en')
  useModelStore.setState({
    objects: OBJECTS, connections: CONNECTIONS, diagrams: DIAGRAMS, groups: [], flows: [], decisionRecords: [],
    domains: [], tags: [], currentDiagramId: 'd1', workspaceReadOnly: false,
  })
  useUIStore.setState({ searchOpen: true, currentView: 'diagram' })
  opened.mockClear()
})
afterEach(async () => {
  cleanup()
  useUIStore.setState({ searchOpen: false })
  await i18n.changeLanguage('en')
})

describe('SpotlightSearch', () => {
  it('ranks the resident model: an accent-free query finds the accented name as top hit', () => {
    render(<SpotlightSearch />)
    type('energie')
    expect(rowKeys()[0]).toBe('app:energy')
    expect(screen.getByTestId('spotlight-section-top')).toBeTruthy()
  })

  it('opens the chosen result, closes, and lists it under Recent next time', () => {
    render(<SpotlightSearch />)
    type('payment')
    expect(rowKeys()).toEqual(['app:pay', 'connection:c1'])
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(opened).toHaveBeenCalledWith('app', 'pay', 'none', { name: 'Payment service' })
    expect(useUIStore.getState().searchOpen).toBe(false)

    act(() => useUIStore.setState({ searchOpen: true }))
    type('')
    expect(screen.getByTestId('spotlight-section-recent').textContent).toContain('Payment service')
  })

  it('keeps the query across a close, as the design specifies', () => {
    render(<SpotlightSearch />)
    type('orders')
    act(() => useUIStore.setState({ searchOpen: false }))
    act(() => useUIStore.setState({ searchOpen: true }))
    expect(input().value).toBe('orders')
  })

  it('edits the query, without closing, when a tip or a suggestion is chosen', () => {
    render(<SpotlightSearch />)
    // Empty field: tips. Choosing one starts the filter.
    fireEvent.click(document.querySelector('[data-key="tip:kind"]')!)
    expect(input().value).toBe('kind:')
    expect(useUIStore.getState().searchOpen).toBe(true)
    // Typing its value suggests completions; Enter takes the first.
    type('kind:st')
    expect(rowKeys()[0]).toBe('suggestion:kind:store ')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('kind:store ')
    expect(rowKeys()).toEqual(['store:db'])
  })

  it('offers to correct a mistyped filter key', () => {
    render(<SpotlightSearch />)
    type('knd:store')
    expect(rowKeys()[0]).toBe('fix:0')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('kind:store')
  })

  it('runs a command and does not leave the search open', () => {
    render(<SpotlightSearch />)
    type('model objects')
    const key = rowKeys().find((k) => k === 'page:goObjects')
    expect(key).toBe('page:goObjects')
    fireEvent.click(document.querySelector('[data-key="page:goObjects"]')!)
    expect(useUIStore.getState().currentView).toBe('model-objects')
    expect(useUIStore.getState().searchOpen).toBe(false)
  })

  it('lists a whole scope on an empty field', () => {
    render(<SpotlightSearch />)
    fireEvent.click(screen.getByTestId('spotlight-scope-objects'))
    // Name order (folded): energie tarifs, orders database, payment service.
    expect(rowKeys()).toEqual(['app:energy', 'store:db', 'app:pay'])
  })

  it('agrees two plurals in French (regression: "1 entrantes")', async () => {
    await act(async () => { await i18n.changeLanguage('fr') })
    render(<SpotlightSearch />)
    type('orders')
    // Orders database: one connection in, none out.
    expect(screen.getByTestId('spotlight-preview').textContent).toContain('1 entrante · 0 sortante')
  })
})

// ── the server tier ───────────────────────────────────────────────────────────

const WS = { landscapeId: 'L1', versionId: 'V1' }

interface ServerHit { score: number; doc: Record<string, unknown> }
function serverBody(sections: Array<{ kind: string; total?: number; totalCapped?: boolean; hits: ServerHit[] }>) {
  return {
    v: 1,
    topHit: null,
    sections: sections.map((s) => ({ total: s.hits.length, totalCapped: false, ...s })),
    coverage: { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'], flow: ['domain'] } },
    ...WS,
    projectionGeneration: 3,
    status: 'healthy',
    caughtUp: true,
    absenceProvable: true,
  }
}

/** A system the store does not hold (another diagram of the workspace). */
const FAR: ServerHit = {
  score: 12,
  doc: {
    kind: 'system', id: 'far', name: 'Payment ledger', description: 'Books every captured payment.',
    tech: ['Kafka'], status: 'live', scope: 'external', diagrams: ['Finance overview'],
    extra: { parentName: null, domainId: null, diagramCount: 3 },
  },
}

let requests: Array<{ url: string; body: Record<string, unknown> }> = []
function serverAnswers(make: () => Response | Promise<Response>) {
  requests = []
  __setSpotlightFetchForTest(async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    return make()
  })
}
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

describe('SpotlightSearch with the server tier', () => {
  beforeEach(() => {
    // The tier selection: the server read model (tierFlag.ts's runtime toggle),
    // over a store that holds a window (boot-from-server active).
    localStorage.setItem('maplespire:serverReadModel', 'true')
    bridge.windowed = true
    bridge.tombstones.clear()
    setActiveWorkspaceRef(WS)
    useWorkspaceStore.setState({ ref: WS })
  })
  afterEach(() => {
    __setSpotlightFetchForTest(null)
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    useWorkspaceStore.setState({ ref: DEFAULT_WORKSPACE_REF })
    useModelStore.setState({ pendingDeletedObjectIds: [] })
    vi.restoreAllMocks()
  })

  it('answers from the store at once, then adds the server hits the store does not hold', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    // Resident results first, before any answer.
    expect(rowKeys()).toEqual(['app:pay', 'connection:c1'])
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    // Ordered by the core with the server's score: the resident prefix match (12) ties the
    // server hit (12) and the folded names decide ("payment ledger" < "payment service").
    expect(rowKeys()).toEqual(['system:far', 'app:pay', 'connection:c1'])
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toMatch(/\/api\/model\/spotlight\?landscapeId=L1&versionId=V1$/)
    expect(requests[0].body).toMatchObject({ q: 'payment', perKind: 5, vocab: { domains: [], tags: [] } })
    expect(requests[0].body.kinds).toBeUndefined()
  })

  it('builds the row and preview of a server hit from what the server sent', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    const row = document.querySelector('[data-key="system:far"]')!
    expect(row.textContent).toContain('Payment ledger')
    expect(row.textContent).toContain('External')
    const preview = screen.getByTestId('spotlight-preview').textContent ?? ''
    expect(preview).toContain('Books every captured payment.')
    expect(preview).toContain('Kafka')
    expect(preview).toContain('3 diagrams')
  })

  it('opens a server hit with the name it carried', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(opened).toHaveBeenCalledWith('system', 'far', 'none', { name: 'Payment ledger' })
  })

  it('opens a server flow in the diagram the server named', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'flow', hits: [{ score: 16, doc: { kind: 'flow', id: 'f9', name: 'Refunds', diagrams: ['Billing'], extra: { diagramId: 'd9' } } }] }])))
    render(<SpotlightSearch />)
    type('refunds')
    await waitFor(() => expect(rowKeys()).toContain('flow:f9'))
    fireEvent.click(document.querySelector('[data-key="flow:f9"]')!)
    expect(opened).toHaveBeenCalledWith('flow', 'f9', 'none', { name: 'Refunds', diagramId: 'd9' })
  })

  it('shows a capped count as "N+"', async () => {
    const hits = Array.from({ length: 5 }, (_, i): ServerHit => ({ score: 12, doc: { kind: 'system', id: `s${i}`, name: `Payment ${i}`, extra: {} } }))
    serverAnswers(() => ok(serverBody([{ kind: 'system', total: 1000, totalCapped: true, hits }])))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(rowKeys()).toContain('system:s1'))
    expect(screen.getByTestId('spotlight-section-objects').textContent).toContain('1000+')
  })

  it('asks for a whole scope, 50 rows plus the top hit, on an empty field', async () => {
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    fireEvent.click(screen.getByTestId('spotlight-scope-objects'))
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    expect(requests[0].body).toMatchObject({
      q: 'kind:system,app,store,component,actor,group',
      kinds: ['system', 'app', 'store', 'component', 'actor', 'group'],
      perKind: 51,
    })
  })

  it.each([
    ['a 503 (not ready)', () => new Response(JSON.stringify({ error: 'x', retryable: true }), { status: 503 })],
    ['a 404 (an older server)', () => new Response('{}', { status: 404 })],
    ['a 403 (refused)', () => new Response('{}', { status: 403 })],
    ['a network failure', () => { throw new TypeError('Failed to fetch') }],
    ['an answer for another workspace', () => ok({ ...serverBody([{ kind: 'system', hits: [FAR] }]), versionId: 'BASE' })],
  ])('keeps the resident results on %s', async (_label, make) => {
    serverAnswers(make)
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(requests).toHaveLength(1))
    // Give the answer time to land; nothing from the server may appear.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(rowKeys()).toEqual(['app:pay', 'connection:c1'])
  })

  it('does not ask the server while the browser is offline', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(requests).toHaveLength(0)
    expect(rowKeys()).toEqual(['app:pay', 'connection:c1'])
  })

  it('does not ask the server when the tier selection did not pick it', async () => {
    localStorage.removeItem('maplespire:serverReadModel')
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(requests).toHaveLength(0)
  })

  it('does not ask the server when the store holds the whole model', async () => {
    bridge.windowed = false
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payment')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['a tombstone the bridge holds', () => { bridge.tombstones.add('object:far') }],
    ['a delete the bridge has not picked up yet', () => { useModelStore.setState({ pendingDeletedObjectIds: ['far'] }) }],
  ])('does not bring back an object this tab deleted (%s) while the projection still lists it', async (_label, deleteIt) => {
    deleteIt()
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR, { score: 4, doc: { kind: 'system', id: 'other', name: 'Ledger of payments', extra: {} } }] }])))
    render(<SpotlightSearch />)
    type('payment')
    // The answer landed (its other hit shows), without the deleted one.
    await waitFor(() => expect(rowKeys()).toContain('system:other'))
    expect(rowKeys()).not.toContain('system:far')
  })

  it('says the results are partial when the server could not be asked, and only then', async () => {
    serverAnswers(() => new Response('{}', { status: 503 }))
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(screen.getByTestId('spotlight-notice')).toBeTruthy())
    cleanup()
    serverAnswers(() => ok(serverBody([{ kind: 'system', hits: [FAR] }])))
    render(<SpotlightSearch />)
    type('payments')
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    expect(screen.queryByTestId('spotlight-notice')).toBeNull()
  })

  it('keeps the row the user moved to when the server answer inserts rows above it', async () => {
    let release: (() => void) | null = null
    serverAnswers(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return ok(serverBody([{ kind: 'system', hits: [FAR] }]))
    })
    render(<SpotlightSearch />)
    type('payment')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const activeKey = () => document.querySelector('[data-testid=spotlight-row][aria-selected=true]')?.getAttribute('data-key')
    expect(activeKey()).toBe('connection:c1')
    await waitFor(() => expect(requests).toHaveLength(1))
    release!()
    await waitFor(() => expect(rowKeys()[0]).toBe('system:far'))
    expect(activeKey()).toBe('connection:c1')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(opened).toHaveBeenCalledWith('connection', 'c1', 'none', { name: 'Writes payments' })
  })

  it('asks again for the same query when the browser comes back online', async () => {
    let up = false
    serverAnswers(() => {
      if (!up) throw new TypeError('Failed to fetch')
      return ok(serverBody([{ kind: 'system', hits: [FAR] }]))
    })
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(screen.getByTestId('spotlight-notice')).toBeTruthy())
    up = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(rowKeys()).toContain('system:far'))
    expect(requests).toHaveLength(2)
    expect(screen.queryByTestId('spotlight-notice')).toBeNull()
  })

  it('never shows an answer for the previous query', async () => {
    let release: (() => void) | null = null
    requests = []
    __setSpotlightFetchForTest(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { q: string }
      requests.push({ url: _url, body })
      // The first answer is held until the second query has been typed. (Each
      // answer is the server's for ITS query: a server hit is never re-checked.)
      if (body.q !== 'payment') return ok(serverBody([]))
      await new Promise<void>((resolve) => { release = resolve })
      return ok(serverBody([{ kind: 'system', hits: [FAR] }]))
    })
    render(<SpotlightSearch />)
    type('payment')
    await waitFor(() => expect(requests).toHaveLength(1))
    type('orders')
    release!()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(rowKeys()).not.toContain('system:far')
    expect(rowKeys()).toEqual(['store:db'])
  })
})
