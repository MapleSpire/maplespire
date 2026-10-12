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

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DependencyCounts, DependencyPeerList } from './DependencyPeerList'
import type { PeerGroup } from './useDependencies'
import type { Connection } from '../../types'

// jsdom gives the scroll container no height, so the real virtualizer renders
// zero rows. The repo's other virtualized component tests mock it for the same
// reason: what is under test here is the paging and the row content, and the
// virtualizer has its own tests.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index, key: index, start: index * estimateSize(), size: estimateSize(),
    })),
    getTotalSize: () => count * estimateSize(),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const connection = (id: string): Connection => ({ id, fromId: 'a', toId: 'b', type: 'solid' } as Connection)

const peer = (n: number, over: { direct?: number; lower?: number } = {}): PeerGroup => ({
  peerId: `peer-${n}`,
  peerName: `Peer ${n}`,
  connections: [connection(`conn-${n}`)],
  connectionCount: (over.direct ?? 1) + (over.lower ?? 0),
  directCount: over.direct ?? 1,
  lowerCount: over.lower ?? 0,
  domainName: 'No domain',
  objectType: 'app',
  techLine: '',
})

const peers = (n: number) => Array.from({ length: n }, (_, i) => peer(i + 1))

const list = (over: Partial<Parameters<typeof DependencyPeerList>[0]> = {}) => (
  <DependencyPeerList
    direction="incoming"
    peers={peers(2)}
    totalPeers={2}
    loading={false}
    onLoadMore={vi.fn()}
    onClose={vi.fn()}
    {...over}
  />
)

describe('DependencyPeerList', () => {
  afterEach(cleanup)

  // The fan caps at six per side and rolled the rest into a decorative slot;
  // peer seven was unreachable except by guessing its name in the search box.
  it('lists peers the fan could never reach', () => {
    render(list({ peers: peers(9), totalPeers: 9 }))

    expect(screen.getByTestId('dependency-peer-peer-9')).toBeTruthy()
    expect(screen.getByTestId('dependency-peer-peer-7')).toBeTruthy()
  })

  it('gives every row its own connection control', () => {
    render(list())

    expect(screen.getByTestId('dependency-connection-peer-1')).toBeTruthy()
    expect(screen.getByTestId('dependency-connection-peer-2')).toBeTruthy()
  })

  // The panel opens on top of the fan, on the same direction of the same focus
  // object. Fetching its own rows meant two requests for identical data and —
  // the reason it matters — two answers, since nothing made the two queries
  // carry the same filters. It renders what the page already loaded.
  it('renders the rows it is handed without asking the seam for its own', () => {
    const seam = vi.fn()
    vi.stubGlobal('fetch', seam)
    render(list({ peers: [peer(1)], totalPeers: 1 }))

    expect(screen.getByTestId('dependency-peer-peer-1')).toBeTruthy()
    expect(seam).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  // Reaching the end extends the SHARED window, so the fan behind the panel
  // grows with it rather than the two ending up with different rows.
  it('asks its caller to extend the window when the rows run out', () => {
    const onLoadMore = vi.fn()
    render(list({ peers: peers(9), totalPeers: 40, onLoadMore }))

    expect(onLoadMore).toHaveBeenCalled()
  })

  it('says it is loading rather than claiming there are no dependencies', () => {
    render(list({ peers: [], totalPeers: 0, loading: true }))

    expect(screen.getByText('common.loading')).toBeTruthy()
    expect(screen.queryByText('dataViewsA.dependenciesView.noPeers')).toBeNull()
  })
})

describe('DependencyCounts', () => {
  afterEach(cleanup)

  // Both numbers arrive from the seam per peer and were rendered nowhere, so a
  // dependency that exists only through a lower-level relationship looked
  // identical to a direct one.
  it('shows the lower-level count beside the direct one', () => {
    render(<DependencyCounts direct={3} lower={2} />)
    expect(screen.getByTestId('dependency-direct-count').textContent).toBe('3')
    expect(screen.getByTestId('dependency-lower-count').textContent).toBe('2')
  })

  it('omits the lower badge when there is nothing lower', () => {
    render(<DependencyCounts direct={4} lower={0} />)
    expect(screen.getByTestId('dependency-direct-count').textContent).toBe('4')
    expect(screen.queryByTestId('dependency-lower-count')).toBeNull()
  })

  it('shows a lower-only peer rather than nothing', () => {
    render(<DependencyCounts direct={0} lower={5} />)
    expect(screen.queryByTestId('dependency-direct-count')).toBeNull()
    expect(screen.getByTestId('dependency-lower-count').textContent).toBe('5')
  })

  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<DependencyCounts direct={0} lower={0} />)
    expect(container.textContent).toBe('')
  })
})
