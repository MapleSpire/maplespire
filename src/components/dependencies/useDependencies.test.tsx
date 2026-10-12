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

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useDependencies } from './useDependencies'

const mocks = vi.hoisted(() => {
  const resident = { dependencyPage: vi.fn() }
  return {
    dependencyPage: vi.fn(),
    resident,
    active: { dependencyPage: vi.fn() } as { dependencyPage: ReturnType<typeof vi.fn> },
  }
})

vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => mocks.active,
  residentModelQuery: mocks.resident,
}))

const emptyPage = {
  items: [],
  totalConnections: 0,
  totalPeers: 0,
  coverage: 'full' as const,
}

describe('useDependencies request invalidation', () => {
  beforeEach(() => {
    mocks.dependencyPage.mockReset().mockResolvedValue(emptyPage)
    mocks.resident.dependencyPage.mockReset().mockResolvedValue(emptyPage)
    mocks.active = { dependencyPage: mocks.dependencyPage }
    useModelStore.setState({ objects: [], groups: [], connections: [], domains: [] })
    useUIStore.setState({
      dependenciesGlobalSearch: '',
      dependenciesDomainId: null,
    })
  })

  afterEach(cleanup)

  it('ignores unrelated resident-window replacement for a bounded query backend', async () => {
    renderHook(() => useDependencies('focus'))
    await waitFor(() => expect(mocks.dependencyPage).toHaveBeenCalledTimes(2))

    act(() => useModelStore.setState({ objects: [], groups: [], connections: [] }))
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(mocks.dependencyPage).toHaveBeenCalledTimes(2)
  })

  it('debounces text filters before issuing the incoming and outgoing requests', async () => {
    renderHook(() => useDependencies('focus'))
    await waitFor(() => expect(mocks.dependencyPage).toHaveBeenCalledTimes(2))

    act(() => useUIStore.getState().setDependenciesGlobalSearch('ledger'))
    await new Promise((resolve) => window.setTimeout(resolve, 100))
    expect(mocks.dependencyPage).toHaveBeenCalledTimes(2)

    await waitFor(() => expect(mocks.dependencyPage).toHaveBeenCalledTimes(4))
    expect(mocks.dependencyPage.mock.calls.slice(-2).map(([request]) => request.globalSearch)).toEqual([
      'ledger',
      'ledger',
    ])
  })

  it('retains array invalidation for the offline resident backend', async () => {
    mocks.active = mocks.resident
    renderHook(() => useDependencies('focus'))
    await waitFor(() => expect(mocks.resident.dependencyPage).toHaveBeenCalledTimes(2))

    act(() => useModelStore.setState({ objects: [] }))
    await waitFor(() => expect(mocks.resident.dependencyPage).toHaveBeenCalledTimes(4))
  })
})

/** One page of peers, numbered so the cursor can be seen to advance. */
function pageOf(from: number, to: number, nextCursor: string | null, totalPeers: number) {
  return {
    items: Array.from({ length: to - from + 1 }, (_, i) => ({
      peerId: `peer-${from + i}`,
      peerKind: 'object' as const,
      peer: {
        id: `peer-${from + i}`, type: 'app', name: `Peer ${from + i}`, position: { x: 0, y: 0 },
        size: { width: 10, height: 10 }, tagAssignments: {}, tagOrder: [],
        scope: 'internal', status: 'live', properties: {},
      },
      representativeConnection: { id: `conn-${from + i}`, fromId: 'a', toId: 'b', type: 'solid' },
      connectionCount: 1, directCount: 1, lowerCount: 0,
    })),
    nextCursor,
    totalPeers,
    totalConnections: totalPeers,
    coverage: 'full' as const,
  }
}

describe('useDependencies paging and filters', () => {
  beforeEach(() => {
    mocks.dependencyPage.mockReset().mockResolvedValue(emptyPage)
    mocks.active = { dependencyPage: mocks.dependencyPage }
    useModelStore.setState({ objects: [], groups: [], connections: [], domains: [] })
    useUIStore.setState({
      dependenciesGlobalSearch: '',
      dependenciesDomainId: null,
    })
  })

  afterEach(cleanup)

  // The fan capped at six per side with no way to ask for more, so peer seven
  // was unreachable. `DependencyPageOpts` has carried a cursor all along and all
  // three backends honour it; nothing consumed it.
  it('pages with the cursor the seam handed back', async () => {
    mocks.dependencyPage.mockResolvedValue(pageOf(1, 3, 'cursor-2', 60))
    const { result } = renderHook(() => useDependencies('focus'))
    await waitFor(() => expect(result.current.incoming).toHaveLength(3))
    expect(result.current.hasMoreIncoming).toBe(true)

    mocks.dependencyPage.mockResolvedValue(pageOf(4, 6, null, 60))
    act(() => result.current.loadMoreIncoming())

    await waitFor(() => expect(result.current.incoming).toHaveLength(6))
    const paged = mocks.dependencyPage.mock.calls.map(([request]) => request.cursor)
    expect(paged).toContain('cursor-2')
  })

  // Both directions carry the page's filters. The fan and the list panel read
  // this one query, so neither can end up narrowed differently from the other.
  it('sends the page-level filters with both directions', async () => {
    useUIStore.setState({
      dependenciesDomainId: 'domain-1',
      dependenciesGlobalSearch: 'ledger',
    })
    renderHook(() => useDependencies('focus'))

    await waitFor(() => expect(mocks.dependencyPage).toHaveBeenCalledTimes(2))
    const byDirection = new Map(
      mocks.dependencyPage.mock.calls.map(([request]) => [request.direction, request]),
    )
    expect(byDirection.get('incoming')).toMatchObject({ domainId: 'domain-1', globalSearch: 'ledger' })
    expect(byDirection.get('outgoing')).toMatchObject({ domainId: 'domain-1', globalSearch: 'ledger' })
  })

  // A filter narrows the set; paging the narrowed query onto the tail of the old
  // rows would leave peers on screen that no longer match it.
  it('drops the loaded rows when a filter changes rather than paging onto them', async () => {
    mocks.dependencyPage.mockResolvedValue(pageOf(1, 5, 'cursor-2', 60))
    const { result } = renderHook(() => useDependencies('focus'))
    await waitFor(() => expect(result.current.incoming).toHaveLength(5))

    mocks.dependencyPage.mockResolvedValue(pageOf(90, 90, null, 1))
    act(() => useUIStore.getState().setDependenciesDomainId('domain-9'))

    await waitFor(() => expect(result.current.incoming).toHaveLength(1))
    expect(result.current.incoming[0].peerId).toBe('peer-90')
    expect(mocks.dependencyPage.mock.calls.at(-1)?.[0].cursor).toBeNull()
  })
})
