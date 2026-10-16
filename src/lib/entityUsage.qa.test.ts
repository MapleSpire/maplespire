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

// QA-lens additions for entityUsage: each test here killed a mutant the first
// battery let survive (openFlowInDiagram untested, group selected as a
// connection, abort signal dropped/swallowed, unencoded id, bounded totals,
// child-count ceiling reported as exact).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModelStore } from '../stores/modelStore'
import { useUIStore } from '../stores/uiStore'
import { pagedModelQuery } from './modelQuery/paged'
import { serverModelQuery, __setServerFetchForTest } from './modelQuery/server'

const tier = vi.hoisted(() => ({ server: false }))
vi.mock('./modelQuery/tierFlag', async (original) => ({
  ...(await original<typeof import('./modelQuery/tierFlag')>()),
  isServerReadModelEnabled: () => tier.server,
}))
import {
  CHILD_COUNT_CEILING,
  DIAGRAM_USAGE_LIMIT,
  loadChildCount,
  loadModelFlowUsage,
  loadObjectDiagramUsage,
  openEntityInDiagram,
  openFlowInDiagram,
  registryDiagramUsage,
} from './entityUsage'
import type { C4Object, Diagram } from '../types'

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const dg = (id: string, name: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  __setServerFetchForTest(null)
  tier.server = false
  vi.unstubAllGlobals()
  useUIStore.setState({ pendingCanvasFocus: null, currentFlowId: null })
})

describe('openFlowInDiagram', () => {
  it('switches to the flow diagram, makes the flow current and shows the canvas', () => {
    useModelStore.setState({
      objects: [], connections: [], groups: [], flows: [],
      diagrams: [dg('a', 'A'), dg('b', 'B')], currentDiagramId: 'a', selectedItems: [],
    })
    useUIStore.setState({ currentView: 'model-objects', currentFlowId: null })
    openFlowInDiagram('b', 'refund')
    expect(useModelStore.getState().currentDiagramId).toBe('b')
    expect(useUIStore.getState().currentFlowId).toBe('refund')
    expect(useUIStore.getState().currentView).toBe('diagram')
  })
})

describe('openEntityInDiagram — groups and connections', () => {
  it('selects a group as a group, and a connection as a connection', () => {
    useModelStore.setState({
      objects: [], connections: [], groups: [], flows: [],
      diagrams: [dg('a', 'A'), dg('b', 'B')], currentDiagramId: 'a', selectedItems: [],
    })
    openEntityInDiagram('b', 'group', 'g1')
    expect(useModelStore.getState().selectedItems).toEqual([{ id: 'g1', type: 'group' }])
    openEntityInDiagram('a', 'connection', 'c1')
    expect(useModelStore.getState().currentDiagramId).toBe('a')
    expect(useModelStore.getState().selectedItems).toEqual([{ id: 'c1', type: 'connection' }])
  })
})

describe('whole-model flow usage — wire details', () => {
  it('forwards the abort signal to the server request', async () => {
    tier.server = true
    vi.stubGlobal('navigator', { onLine: true })
    const signals: Array<AbortSignal | null | undefined> = []
    __setServerFetchForTest(async (_url, init) => {
      signals.push(init?.signal)
      return json({ flows: [], total: 0, complete: true })
    })
    const controller = new AbortController()
    await loadModelFlowUsage('object', 'x', null, controller.signal)
    expect(signals).toEqual([controller.signal])
  })

  it('an aborted request rejects instead of degrading to the open-diagram fallback', async () => {
    tier.server = true
    vi.stubGlobal('navigator', { onLine: true })
    __setServerFetchForTest(async () => { throw new DOMException('aborted', 'AbortError') })
    const controller = new AbortController()
    controller.abort()
    await expect(pagedModelQuery.entityFlows('object', 'x', { signal: controller.signal })).rejects.toThrow()
  })

  it('encodes the entity id in the query string', async () => {
    const urls: string[] = []
    __setServerFetchForTest(async (url) => {
      urls.push(url)
      return json({ flows: [], total: 0, complete: true })
    })
    await serverModelQuery.entityFlows('object', 'a&kind=connection#x', {})
    const q = new URL(urls[0], 'http://localhost').searchParams
    expect([q.get('kind'), q.get('id')]).toEqual(['object', 'a&kind=connection#x'])
  })
})

describe('bounded counts report the FULL total', () => {
  const many = Array.from({ length: DIAGRAM_USAGE_LIMIT + 10 }, (_, i) =>
    dg(`d${String(i).padStart(3, '0')}`, `D${String(i).padStart(3, '0')}`, { objectIds: ['o'], groupIds: ['g'] }))

  it('registry usage: list bounded, total not', () => {
    const usage = registryDiagramUsage(many, 'group', 'g', true)
    expect(usage.diagrams).toHaveLength(DIAGRAM_USAGE_LIMIT)
    expect(usage.total).toBe(DIAGRAM_USAGE_LIMIT + 10)
  })

  it('object usage: list bounded, total not', async () => {
    useModelStore.setState({
      objects: [obj('o')], connections: [], groups: [], flows: [],
      diagrams: many, currentDiagramId: 'd000', selectedItems: [],
    })
    const usage = await loadObjectDiagramUsage('o')
    expect(usage.diagrams).toHaveLength(DIAGRAM_USAGE_LIMIT)
    expect(usage.total).toBe(DIAGRAM_USAGE_LIMIT + 10)
  })

  it('child count past the ceiling is reported as a floor, whatever the tier page size', async () => {
    const children = Array.from({ length: CHILD_COUNT_CEILING + 50 }, (_, i) => obj(`child-${i}`, { parentId: 'sys' }))
    useModelStore.setState({
      objects: [obj('sys', { type: 'system' }), ...children], connections: [], groups: [], flows: [],
      diagrams: [], currentDiagramId: null, selectedItems: [],
    })
    // Literal, not derived from the constant (a ceiling test that derives its
    // bound from the constant agrees with any value it is given).
    expect(await loadChildCount('sys')).toEqual({ count: 2000, complete: false })
  })
})
