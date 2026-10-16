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

// Regression for the Details panel's hard-coded "In 1 diagram" / "In 0 flows" /
// "1 object" (2026-10-15): an object in TWO diagrams must count two — including
// when one of them is the open diagram, which the expand-menu path excludes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelStore } from '../stores/modelStore'
import { useUIStore } from '../stores/uiStore'
import { residentModelQuery } from './modelQuery/resident'
import { __setModelQueryForTest } from './modelQuery'
import { pagedModelQuery, __setPagedStoreForTest } from './modelQuery/paged'
import { serverModelQuery, __setServerFetchForTest } from './modelQuery/server'
import { createMemoryKvStore } from './modelQuery/kvStore'

const tier = vi.hoisted(() => ({ server: false }))
vi.mock('./modelQuery/tierFlag', async (original) => ({
  ...(await original<typeof import('./modelQuery/tierFlag')>()),
  isServerReadModelEnabled: () => tier.server,
}))
import { buildModelIndex } from './modelQuery/modelIndex'
import {
  flowUsage,
  flowsReferencingConnection,
  flowsReferencingObject,
  loadChildCount,
  loadEntityDiagramUsage,
  loadModelFlowUsage,
  mergeFlowUsage,
  loadObjectDiagramUsage,
  openEntityInDiagram,
  registryDiagramUsage,
  type DiagramUsage,
} from './entityUsage'
import type { C4Object, Connection, Diagram, Flow, FlowStep } from '../types'

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const conn = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid' })
const dg = (id: string, name: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})
const flow = (id: string, diagramId: string, steps: FlowStep[]): Flow => ({ id, name: id, diagramId, steps })
const message = (id: string, from: string, to: string, connectionId: string): FlowStep =>
  ({ id, order: 0, type: 'message', title: id, fromObjectId: from, toObjectId: to, connectionId })
const processStep = (id: string, objectId: string): FlowStep => ({ id, order: 0, type: 'process', title: id, objectId })
const intro = (id: string): FlowStep => ({ id, order: 0, type: 'introduction', title: id })

// "Payment" is in Containers AND Order Components; "Ledger" is in Containers only;
// "Orphan" is in no diagram. Containers is the open diagram.
function fixture() {
  return {
    objects: [
      obj('sys', { type: 'system', name: 'Shop' }),
      obj('payment', { name: 'Payment Service', parentId: 'sys' }),
      obj('ledger', { name: 'Ledger', parentId: 'sys' }),
      obj('orders', { name: 'Orders', parentId: 'sys' }),
      obj('orphan', { name: 'Orphan' }),
    ],
    connections: [conn('c-pay-led', 'payment', 'ledger'), conn('c-ord-pay', 'orders', 'payment')],
    groups: [],
    diagrams: [
      dg('containers', 'Containers', { objectIds: ['payment', 'ledger', 'orders'], connectionIds: ['c-pay-led'], groupIds: ['g1'] }),
      dg('order-components', 'Order Service — Components', { objectIds: ['payment', 'orders'], connectionIds: ['c-ord-pay'] }),
    ],
  }
}

function seed(currentDiagramId: string | null = 'containers') {
  const f = fixture()
  useModelStore.setState({ ...f, flows: [], currentDiagramId, selectedItems: [] })
  return f
}

afterEach(() => {
  __setServerFetchForTest(null)
  __setPagedStoreForTest(null)
  useUIStore.setState({ pendingCanvasFocus: null })
})

describe('flow counts', () => {
  const flows = [
    flow('checkout', 'containers', [intro('i'), message('m1', 'orders', 'payment', 'c-ord-pay'), message('m2', 'payment', 'ledger', 'c-pay-led')]),
    flow('refund', 'containers', [processStep('p1', 'payment')]),
    flow('audit', 'containers', [processStep('p2', 'ledger')]),
  ]

  it('counts 0 flows for an object no step touches', () => {
    expect(flowsReferencingObject(flows, 'orphan')).toEqual([])
  })

  it('counts 1 flow for an object a single flow touches (once, however many steps)', () => {
    expect(flowsReferencingObject(flows, 'orders').map((f) => f.id)).toEqual(['checkout'])
    expect(flowsReferencingObject(flows, 'ledger').map((f) => f.id)).toEqual(['checkout', 'audit'])
  })

  it('counts message senders, receivers and process steps', () => {
    expect(flowsReferencingObject(flows, 'payment').map((f) => f.id)).toEqual(['checkout', 'refund'])
  })

  it('counts connection flows by the message step connectionId', () => {
    expect(flowsReferencingConnection(flows, 'c-pay-led').map((f) => f.id)).toEqual(['checkout'])
    expect(flowsReferencingConnection(flows, 'nope')).toEqual([])
  })

  it('is complete only when every containing diagram is the open one', () => {
    const only = (ids: string[]): DiagramUsage => ({ diagrams: ids.map((id) => dg(id, id)), total: ids.length, complete: true })
    expect(flowUsage(flows, 'object', 'ledger', only(['containers']), 'containers').complete).toBe(true)
    expect(flowUsage(flows, 'object', 'orphan', only([]), 'containers').complete).toBe(true)
    // In a second diagram whose flows are not loaded → the count is a floor.
    expect(flowUsage(flows, 'object', 'payment', only(['containers', 'order-components']), 'containers'))
      .toMatchObject({ complete: false })
    // The open diagram is not even one of them → nothing about it is known.
    expect(flowUsage(flows, 'object', 'payment', only(['order-components']), 'containers').complete).toBe(false)
  })
})

describe('object diagram usage — the same membership on every tier', () => {
  it('resident: an object in 2 diagrams counts 2, the open one included', async () => {
    seed('containers')
    const usage = await loadObjectDiagramUsage('payment')
    expect(usage.total).toBe(2)
    expect(usage.diagrams.map((d) => d.id)).toEqual(['containers', 'order-components'])
    expect((await loadObjectDiagramUsage('ledger')).total).toBe(1)
    expect((await loadObjectDiagramUsage('orphan')).total).toBe(0)
  })

  it('resident: the expand-menu default still excludes the open diagram', async () => {
    seed('containers')
    const related = await residentModelQuery.relatedDiagrams('payment')
    expect(related.reference.map((d) => d.id)).toEqual(['order-components'])
    const withCurrent = await residentModelQuery.relatedDiagrams('payment', { includeCurrent: true })
    expect(withCurrent.totals.reference).toBe(2)
  })

  it('paged registry floor honours includeCurrent', async () => {
    const f = seed('containers')
    const store = createMemoryKvStore()
    __setPagedStoreForTest(store)
    await buildModelIndex(store, { ...f, groups: [] })
    expect((await pagedModelQuery.relatedDiagrams('payment')).totals.reference).toBe(1)
    expect((await pagedModelQuery.relatedDiagrams('payment', { includeCurrent: true })).totals.reference).toBe(2)
  })

  it('server: includeCurrent sends no `current`, so the server excludes nothing', async () => {
    seed('containers')
    const seen: string[] = []
    __setServerFetchForTest(async (url: string) => {
      const q = new URL(url, 'http://localhost').searchParams
      seen.push(q.get('current') ?? '<none>')
      // Faithful to roRelatedDiagrams: `current` (when sent) is excluded.
      const all = await residentModelQuery.relatedDiagrams(q.get('object') ?? '', { includeCurrent: true })
      const current = q.get('current')
      const reference = all.reference.filter((d) => d.id !== current)
      return new Response(JSON.stringify({ ...all, reference, totals: { ...all.totals, reference: reference.length } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    expect((await serverModelQuery.relatedDiagrams('payment')).totals.reference).toBe(1)
    expect((await serverModelQuery.relatedDiagrams('payment', { includeCurrent: true })).totals.reference).toBe(2)
    expect(seen).toEqual(['containers', '<none>'])
  })
})

describe('whole-model flow usage (read-model flow index)', () => {
  const answer = { flows: [{ id: 'refund', diagramId: 'order-components', name: 'Refund' }], total: 3, complete: false }
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  afterEach(() => {
    tier.server = false
    vi.unstubAllGlobals()
  })

  it('resident tier has no flow index → null, so the panel falls back to the open diagram', async () => {
    seed()
    expect(await residentModelQuery.entityFlows('object', 'payment')).toBeNull()
    expect(await loadModelFlowUsage('object', 'payment', 'containers')).toBeNull()
  })

  it('server tier asks /api/model/entity-flows, excluding the open diagram, and keeps its verdict', async () => {
    seed()
    const urls: string[] = []
    __setServerFetchForTest(async (url: string) => {
      urls.push(url)
      return ok(answer)
    })
    expect(await serverModelQuery.entityFlows('connection', 'c-ord-pay', { limit: 7, excludeDiagramId: 'containers' })).toEqual(answer)
    const q = new URL(urls[0], 'http://localhost')
    expect(q.pathname).toBe('/api/model/entity-flows')
    expect(['kind', 'id', 'limit', 'excludeDiagram'].map((name) => q.searchParams.get(name)))
      .toEqual(['connection', 'c-ord-pay', '7', 'containers'])
    await serverModelQuery.entityFlows('object', 'payment')
    expect(new URL(urls[1], 'http://localhost').searchParams.has('excludeDiagram')).toBe(false)
  })

  it('paged tier: server answer when the read model is on, null (fallback) when it fails', async () => {
    seed()
    tier.server = true
    vi.stubGlobal('navigator', { onLine: true })
    let fail = false
    __setServerFetchForTest(async () => fail
      ? new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })
      : ok(answer))
    expect(await pagedModelQuery.entityFlows('object', 'payment')).toEqual(answer)
    expect(await loadModelFlowUsage('object', 'payment', 'containers')).toEqual(answer)
    fail = true
    expect(await pagedModelQuery.entityFlows('object', 'payment')).toBeNull()
  })

  it('merges the index (other diagrams) with the OPEN diagram\'s live flows', () => {
    const held = [
      flow('refund-live', 'containers', [processStep('p', 'payment')]),
      flow('elsewhere', 'containers', [processStep('p', 'ledger')]),
    ]
    // The index left the open diagram out; a stale copy of it must not double-count.
    const model = {
      flows: [{ id: 'audit', diagramId: 'order-components', name: 'Audit' }, { id: 'refund-live', diagramId: 'containers', name: 'stale' }],
      total: 1,
      complete: true,
    }
    const merged = mergeFlowUsage(model, held, 'object', 'payment', 'containers')
    expect(merged).toMatchObject({ total: 2, complete: true, scope: 'model' })
    expect(merged.flows.map((f) => `${f.diagramId}/${f.id}`)).toEqual(['containers/refund-live', 'order-components/audit'])
    expect(mergeFlowUsage({ ...model, complete: false }, held, 'object', 'payment', 'containers').complete).toBe(false)
  })
})

describe('group / connection diagram usage', () => {
  afterEach(() => {
    tier.server = false
    vi.unstubAllGlobals()
  })

  it('registry answer carries the window verdict it is given', () => {
    const { diagrams } = fixture()
    expect(registryDiagramUsage(diagrams, 'group', 'g1', true)).toMatchObject({ total: 1, complete: true })
    expect(registryDiagramUsage(diagrams, 'connection', 'c-ord-pay', false)).toMatchObject({ total: 1, complete: false })
    expect(registryDiagramUsage(diagrams, 'connection', 'c-ord-pay', true).diagrams.map((d) => d.id)).toEqual(['order-components'])
    expect(registryDiagramUsage(diagrams, 'connection', 'nope', true).total).toBe(0)
  })

  it('read model answers on the server tier; no read model → null (registry fallback)', async () => {
    seed()
    expect(await loadEntityDiagramUsage('group', 'g1')).toBeNull()
    tier.server = true
    vi.stubGlobal('navigator', { onLine: true })
    const urls: string[] = []
    __setServerFetchForTest(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ diagrams: [dg('far', 'Far away')], total: 7 }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    expect(await loadEntityDiagramUsage('connection', 'c-ord-pay')).toMatchObject({ total: 7, complete: true })
    const q = new URL(urls[0], 'http://localhost')
    expect([q.pathname, q.searchParams.get('kind'), q.searchParams.get('id')]).toEqual(['/api/model/entity-diagrams', 'connection', 'c-ord-pay'])
  })
})


describe('Contains — children, not the parent', () => {
  beforeEach(() => seed())

  it('counts the objects whose parent is this object', async () => {
    expect(await loadChildCount('sys')).toEqual({ count: 3, complete: true })
    // The old panel said "1 object" for any object WITH a parent.
    expect(await loadChildCount('payment')).toEqual({ count: 0, complete: true })
  })

  it('walks every child page', async () => {
    const many = Array.from({ length: 250 }, (_, i) => obj(`child-${i}`, { parentId: 'sys' }))
    useModelStore.setState((s) => ({ objects: [...s.objects, ...many] }))
    expect(await loadChildCount('sys')).toEqual({ count: 253, complete: true })
  })

  it('a page served from a working set (offline fallback) makes the count a floor', async () => {
    __setModelQueryForTest({
      ...residentModelQuery,
      objectTreePage: async (opts) => ({ ...(await residentModelQuery.objectTreePage(opts)), coverage: 'working-set' }),
    })
    try {
      expect(await loadChildCount('sys')).toEqual({ count: 3, complete: false })
    } finally {
      __setModelQueryForTest(null)
    }
  })
})

describe('openEntityInDiagram', () => {
  it('switches diagram, selects the entity AFTER the switch, and asks the canvas to centre it', () => {
    seed('containers')
    useUIStore.setState({ currentView: 'model-objects' })
    openEntityInDiagram('order-components', 'object', 'payment')
    expect(useModelStore.getState().currentDiagramId).toBe('order-components')
    expect(useModelStore.getState().selectedItems).toEqual([{ id: 'payment', type: 'object' }])
    expect(useUIStore.getState().currentView).toBe('diagram')
    expect(useUIStore.getState().pendingCanvasFocus).toEqual({ diagramId: 'order-components', kind: 'object', id: 'payment' })
  })

  it('drops the centring request once the canvas is left, so a later visit fits normally', () => {
    seed('containers')
    openEntityInDiagram('order-components', 'object', 'payment')
    useUIStore.getState().setCurrentView('diagram')
    expect(useUIStore.getState().pendingCanvasFocus).not.toBeNull()
    useUIStore.getState().setCurrentView('model-objects')
    expect(useUIStore.getState().pendingCanvasFocus).toBeNull()
  })
})
