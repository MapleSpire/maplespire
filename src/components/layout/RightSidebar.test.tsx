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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setWorkspaceKvBaseForTest, createMemoryKvStore } from '../../lib/modelQuery/kvStore'
import type { C4Object, Connection, DecisionRecord, Diagram, Group } from '../../types'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { RightSidebar } from './RightSidebar'

const mocks = vi.hoisted(() => ({
  fetchLinkMetadataTitle: vi.fn(),
  fetchDecisionRecordPage: vi.fn(),
  fetchDecisionRecordDetail: vi.fn(),
}))
vi.mock('../../lib/linkMetadata', () => ({ fetchLinkMetadataTitle: mocks.fetchLinkMetadataTitle }))
vi.mock('../../lib/modelQuery/decisionRecords', () => ({
  fetchDecisionRecordPage: mocks.fetchDecisionRecordPage,
  fetchDecisionRecordDetail: mocks.fetchDecisionRecordDetail,
}))

const shape: C4Object = {
  id: 'shape-a',
  type: 'app',
  name: 'Payments API',
  description: 'Legacy compact description',
  position: { x: 0, y: 0 },
  size: { width: 180, height: 100 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status: 'live',
  properties: {},
}

const connection: Connection = {
  id: 'connection-a-b',
  fromId: 'shape-a',
  toId: 'shape-b',
  label: 'publishes events',
  type: 'solid',
}

const diagram: Diagram = {
  id: 'diagram-1',
  name: 'Payments',
  type: 'container',
  objectIds: ['shape-a', 'shape-b'],
  connectionIds: ['connection-a-b'],
  groupIds: [],
}

const linkedDecision: DecisionRecord = {
  id: 'adr-payments',
  number: 42,
  title: 'Standardize payment event delivery',
  summary: 'Use one delivery contract across the payment landscape.',
  status: 'approved',
  author: 'Architecture',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  content: '## Decision\n\nUse the shared event contract.',
  related: [{
    id: 'adr-link-diagram', type: 'diagram', label: diagram.name, targetId: diagram.id,
  }],
}

describe('RightSidebar descriptions and connection metadata', () => {
  beforeEach(() => {
    // RightSidebar resolves relationship labels through the workspace index.
    // jsdom has no IndexedDB, so keep these tests on the same in-memory KvStore
    // contract used by the model-query unit tests.
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    mocks.fetchLinkMetadataTitle.mockReset()
    mocks.fetchDecisionRecordPage.mockReset()
    mocks.fetchDecisionRecordPage.mockResolvedValue({
      paged: true,
      serverFiltered: true,
      total: 0,
      limit: 20,
      nextCursor: null,
      nextOffset: null,
      detailsIncluded: false,
      items: [],
    })
    mocks.fetchDecisionRecordDetail.mockReset()
    mocks.fetchDecisionRecordDetail.mockResolvedValue(linkedDecision)
    useAutomergeStatus.setState({ editReady: true, visualReady: true, ready: true, status: 'ready' })
    useUIStore.setState({ rightSidebarOpen: true, currentView: 'diagram', propertyTab: 'details' })
    useModelStore.setState({
      objects: [shape, { ...shape, id: 'shape-b', name: 'Event bus' }],
      connections: [connection],
      diagrams: [diagram],
      groups: [],
      domains: [],
      tags: [],
      decisionRecords: [],
      comments: [],
      currentDiagramId: diagram.id,
      workspaceReadOnly: false,
      selectedItems: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('edits short and detailed shape descriptions independently', () => {
    useModelStore.setState({ selectedItems: [{ id: shape.id, type: 'object' }] })
    render(<RightSidebar />)

    const compact = screen.getByTestId('object-description') as HTMLTextAreaElement
    const detailed = screen.getByTestId('object-detailed-description') as HTMLTextAreaElement
    expect(compact.value).toBe('Legacy compact description')
    expect(detailed.value).toBe('')

    fireEvent.change(compact, { target: { value: 'Compact diagram label' } })
    expect(useModelStore.getState().objects[0].shortDescription).toBe('Compact diagram label')
    expect(useModelStore.getState().objects[0].description).toBe('')

    const markdown = `## Runbook\n\n${'Detailed documentation '.repeat(12)}`
    fireEvent.change(detailed, { target: { value: markdown } })
    expect(useModelStore.getState().objects[0].description).toBe(markdown)
    expect(useModelStore.getState().objects[0].shortDescription).toBe('Compact diagram label')
  })

  it('shows the short-description limit only while editing and constrains the domain selector', () => {
    useModelStore.setState({
      domains: [{ id: 'domain-with-a-long-name', name: 'Digital Banking Platform / Accounts' }],
      selectedItems: [{ id: shape.id, type: 'object' }],
    })
    render(<RightSidebar />)

    const compact = screen.getByTestId('object-description') as HTMLTextAreaElement
    const counter = `${compact.value.length} / 120`
    expect(screen.queryByText(counter)).toBeNull()

    fireEvent.focus(compact)
    expect(screen.getByText(counter)).toBeTruthy()
    fireEvent.blur(compact)
    expect(screen.queryByText(counter)).toBeNull()

    const domainSelect = screen.getByTestId('domain-select')
    expect(domainSelect.className).toContain('max-w-full')
    expect(domainSelect.className).toContain('min-w-0')
  })

  it('lists linked ADRs as a section, navigates to the selected ADR and removes the responsibilities placeholder', () => {
    useModelStore.setState({
      decisionRecords: [linkedDecision],
      selectedItems: [{ id: shape.id, type: 'object' }],
    })
    render(<RightSidebar />)

    expect(screen.queryByText('Responsibilities')).toBeNull()
    expect(screen.getByRole('button', { name: 'Technical decisions' })).toBeTruthy()

    fireEvent.click(screen.getByTestId(`technical-decision-${linkedDecision.id}`))
    expect(useUIStore.getState().selectedADRId).toBe(linkedDecision.id)
    expect(useUIStore.getState().currentView).toBe('decision-records')
  })

  it('exposes and persists description, tags, owners and technologies for a connection', () => {
    useModelStore.setState({ selectedItems: [{ id: connection.id, type: 'connection' }] })
    render(<RightSidebar />)

    expect(screen.getByTestId('connection-tags')).toBeTruthy()
    expect(screen.getByTestId('connection-owners')).toBeTruthy()
    expect(screen.getByTestId('connection-technologies')).toBeTruthy()

    const description = screen.getByTestId('connection-description') as HTMLTextAreaElement
    const markdown = '## Contract\n\nPublishes `OrderPlaced` with retry semantics.'
    fireEvent.change(description, { target: { value: markdown } })
    expect(useModelStore.getState().connections[0].description).toBe(markdown)

    useModelStore.getState().addTagToConnection(connection.id, 'risk-high', {
      tagId: 'risk-high', value: 'High', color: '#b42318', groupId: 'risk', groupName: 'Risk', catalogRevision: 1,
    })
    expect(useModelStore.getState().connections[0]).toMatchObject({
      tagAssignments: { 'risk-high': { tagId: 'risk-high' } },
      tagOrder: ['risk-high'],
    })
  })

  it('stores an optional link label, opens the URL in a new tab and enriches an empty label', async () => {
    vi.useFakeTimers()
    mocks.fetchLinkMetadataTitle.mockResolvedValue('Example documentation')
    useModelStore.setState({ selectedItems: [{ id: shape.id, type: 'object' }] })
    render(<RightSidebar />)

    fireEvent.click(screen.getByTestId('link-add'))
    const urlInput = screen.getByTestId('link-input') as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: 'https://example.com/docs' } })
    expect(useModelStore.getState().objects[0].links).toEqual([{ url: 'https://example.com/docs' }])

    const openLink = screen.getByTestId('link-open') as HTMLAnchorElement
    expect(openLink.href).toBe('https://example.com/docs')
    expect(openLink.target).toBe('_blank')
    expect(openLink.rel).toContain('noopener')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(mocks.fetchLinkMetadataTitle).toHaveBeenCalledWith('https://example.com/docs', expect.any(AbortSignal))
    expect((screen.getByTestId('link-label-input') as HTMLInputElement).value).toBe('Example documentation')
    expect(useModelStore.getState().objects[0].links).toEqual([
      { url: 'https://example.com/docs', label: 'Example documentation' },
    ])
    fireEvent.change(screen.getByTestId('link-label-input'), { target: { value: 'API reference' } })
    expect(useModelStore.getState().objects[0].links).toEqual([
      { url: 'https://example.com/docs', label: 'API reference' },
    ])
    vi.useRealTimers()
  })

  it('does not cancel metadata lookup for one link when a sibling label arrives first', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (title: string) => void
    let resolveSecond!: (title: string) => void
    let secondAborted = false
    mocks.fetchLinkMetadataTitle.mockImplementation((url: string, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      if (url.includes('first.example')) {
        resolveFirst = resolve
        return
      }
      resolveSecond = resolve
      signal?.addEventListener('abort', () => {
        secondAborted = true
        reject(new Error('aborted'))
      })
    }))
    useModelStore.setState({
      objects: [{
        ...shape,
        links: [{ url: 'https://first.example/docs' }, { url: 'https://nodejs.org' }],
      }, { ...shape, id: 'shape-b', name: 'Event bus' }],
      selectedItems: [{ id: shape.id, type: 'object' }],
    })
    render(<RightSidebar />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(mocks.fetchLinkMetadataTitle).toHaveBeenCalledTimes(2)

    await act(async () => resolveFirst('First documentation'))
    expect((screen.getAllByTestId('link-label-input')[0] as HTMLInputElement).value).toBe('First documentation')
    expect(secondAborted).toBe(false)

    await act(async () => resolveSecond('Node.js — Run JavaScript Everywhere'))
    expect((screen.getAllByTestId('link-label-input')[1] as HTMLInputElement).value)
      .toBe('Node.js — Run JavaScript Everywhere')
  })

  it('keeps legacy URL strings clickable and displays a saved label in read-only mode', () => {
    useModelStore.setState({
      workspaceReadOnly: true,
      objects: [{ ...shape, links: [{ url: 'https://example.com/runbook', label: 'Operations runbook' }] }],
      selectedItems: [{ id: shape.id, type: 'object' }],
    })
    render(<RightSidebar />)

    const anchor = screen.getByTestId('link-anchor') as HTMLAnchorElement
    expect(anchor.textContent).toContain('Operations runbook')
    expect(anchor.textContent).toContain('https://example.com/runbook')
    expect(anchor.target).toBe('_blank')

    cleanup()
    useModelStore.setState({
      workspaceReadOnly: true,
      objects: [{ ...shape, links: ['https://example.com/legacy'] }],
      selectedItems: [{ id: shape.id, type: 'object' }],
    })
    render(<RightSidebar />)
    expect((screen.getByTestId('link-anchor') as HTMLAnchorElement).href).toBe('https://example.com/legacy')
  })
})

/**
 * The auto-size switch.
 *
 * `autoSize` drives the canvas: `false` honours stored geometry, anything else
 * derives the box from the members, and every manual resize or drag writes
 * `false`. This switch is the way BACK to auto once a group has been resized by
 * hand.
 *
 * Two shapes cannot honour the flag, and the panel refuses rather than offering
 * a control the canvas will ignore (`CanvasEngine.computeGroupBounds`): a parent
 * wrapper always hugs its members, and a group with no members here has no
 * member box to derive.
 */
describe('group auto-size switch', () => {
  // This describe needs its own setup: a sibling describe's beforeEach/afterEach
  // do not apply here, and without cleanup the renders accumulate until
  // `getByRole` reports multiple matches.
  beforeEach(() => {
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    mocks.fetchDecisionRecordPage.mockResolvedValue({
      paged: true, serverFiltered: true, total: 0, limit: 20,
      nextCursor: null, nextOffset: null, detailsIncluded: false, items: [],
    })
    useAutomergeStatus.setState({ editReady: true, visualReady: true, ready: true, status: 'ready' })
    useUIStore.setState({ rightSidebarOpen: true, currentView: 'diagram', propertyTab: 'details' })
    useModelStore.setState({
      objects: [shape, { ...shape, id: 'shape-b', name: 'Event bus' }],
      connections: [], diagrams: [diagram], groups: [], domains: [], tags: [],
      decisionRecords: [], comments: [],
      currentDiagramId: diagram.id, workspaceReadOnly: false, selectedItems: [],
    })
  })
  afterEach(cleanup)

  const group = (over: Partial<Group> = {}): Group => ({
    id: 'grp-1', name: 'Payments zone', color: '#888',
    objectIds: ['shape-a'], tagAssignments: {}, tagOrder: [], ...over,
  })
  const showGroup = (g: Group) => {
    useModelStore.setState({
      groups: [g],
      diagrams: [{ ...diagram, groupIds: [g.id] }],
      selectedItems: [{ id: g.id, type: 'group' }],
    })
    render(<RightSidebar />)
    return screen.getByRole('switch', { name: 'Auto-size' })
  }

  it('is ON when the flag has never been set — the canvas treats undefined as auto', () => {
    expect(showGroup(group()).getAttribute('aria-checked')).toBe('true')
  })

  it('is OFF for a group that was resized by hand, and turns back ON', () => {
    const toggle = showGroup(group({ autoSize: false, position: { x: 5, y: 5 }, size: { width: 300, height: 200 } }))
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    expect(useModelStore.getState().groups[0].autoSize).toBe(true)
  })

  it('writes false when switched off, which is what stops it following members', () => {
    fireEvent.click(showGroup(group()))
    expect(useModelStore.getState().groups[0].autoSize).toBe(false)
  })

  it('refuses on a parent wrapper, which always hugs its members whatever the flag says', () => {
    const toggle = showGroup(group({ parentObjectId: 'shape-b' }))
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('always fits its members')).toBeTruthy()
  })

  it('refuses on a group with no members here, which has no box to derive', () => {
    const toggle = showGroup(group({ objectIds: [] }))
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('no members on this diagram')).toBeTruthy()
  })

  it('refuses in a read-only workspace', () => {
    useModelStore.setState({ workspaceReadOnly: true })
    expect((showGroup(group()) as HTMLButtonElement).disabled).toBe(true)
  })
})
