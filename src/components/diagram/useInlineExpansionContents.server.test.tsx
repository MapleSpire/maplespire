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
/**
 * Following the server's changes WITH their ids. Every edit — the user's own,
 * elsewhere on the diagram, included — reaches the client as an id-less server
 * invalidation. These tests pin the CLIENT's use of the ids; how precise the
 * ids are is the server's (on the 2026-10-15 stack its feed named every object
 * of the touched model shard, see the hook).
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object } from '../../types'

vi.mock('../../lib/modelQuery', () => ({ getModelQuery: () => { throw new Error('not in this test') } }))
vi.mock('../../stores/modelStore', () => ({ getDiagramIndex: () => { throw new Error('not in this test') } }))
vi.mock('../../lib/diagrams/duplicateSource', () => ({ openDiagramPlacement: () => { throw new Error('not in this test') } }))
vi.mock('../../lib/modelQuery/modelReadCacheChangeFeed', () => ({ changedIdsSince: () => { throw new Error('not in this test') } }))

const { useInlineExpansionContents } = await import('./useInlineExpansionContents')
const { notifyModelIndexChanged, __resetModelIndexVersionForTest } = await import('../../lib/modelQuery/indexSync')
type Source = import('./useInlineExpansionContents').ExpansionTargetSource
type TargetRead = import('./useInlineExpansionContents').TargetRead
type Change = import('../../lib/modelQuery/indexSync').ModelIndexChange

const B = { objectIds: ['inner'], connectionIds: ['c-in'] }

function feedSource(feed: 'available' | 'none') {
  const loads: Array<{ resolve: (read: TargetRead) => void }> = []
  const listeners = new Set<(change: Change | null) => void>()
  let stops = 0
  const source: Source = {
    composition: (id) => (id === 'B' ? B : undefined),
    open: () => ({
      load: () => new Promise<TargetRead>((resolve) => { loads.push({ resolve }) }),
      subscribe: () => () => {},
      close: () => {},
    }),
    watchServerChanges: (onChange) => {
      if (feed === 'none') return null
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
        stops += 1
      }
    },
  }
  const serverChanged = (change: Change | null) => act(() => { for (const fn of [...listeners]) fn(change) })
  return { source, loads, listeners, serverChanged, stops: () => stops }
}

const read: TargetRead = { objects: [{ id: 'inner', scope: 'internal' } as C4Object], connections: [], layouts: {} }

beforeEach(() => __resetModelIndexVersionForTest())
afterEach(() => vi.useRealTimers())

describe('useInlineExpansionContents and the server change feed', () => {
  it('re-reads promptly when the server changed one of the target\'s entities', async () => {
    vi.useFakeTimers()
    const { source, loads, serverChanged } = feedSource('available')
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].resolve(read) })

    serverChanged({ objectIds: ['inner'], connectionIds: [] })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads).toHaveLength(2)
  })

  it('does nothing when the server changed only entities elsewhere', async () => {
    vi.useFakeTimers()
    const { source, loads, serverChanged } = feedSource('available')
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].resolve(read) })

    for (let i = 0; i < 5; i++) {
      serverChanged({ objectIds: ['customer'], connectionIds: ['elsewhere'] })
      // ...and the bridge's id-less revision for the same invalidation.
      act(() => { notifyModelIndexChanged(undefined, 'server-invalidation') })
      act(() => { vi.advanceTimersByTime(3000) })
    }
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(loads, 'an edit elsewhere re-read the expansion').toHaveLength(1)
  })

  it('re-reads on the slow lane when the server cannot say what changed', async () => {
    vi.useFakeTimers()
    const { source, loads, serverChanged } = feedSource('available')
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].resolve(read) })

    serverChanged(null)
    act(() => { vi.advanceTimersByTime(900) })
    expect(loads).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(2)
  })

  // Without a server tier there is nobody to ask: the bridge's id-less
  // revision must still count as "anything changed".
  it('without a server feed, an id-less server revision still re-reads (slow lane)', async () => {
    vi.useFakeTimers()
    const { source, loads } = feedSource('none')
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].resolve(read) })

    act(() => { notifyModelIndexChanged(undefined, 'server-invalidation') })
    act(() => { vi.advanceTimersByTime(1100) })
    expect(loads).toHaveLength(2)
  })

  it('a non-server id-less revision (an index rebuild) still re-reads with the feed on', async () => {
    vi.useFakeTimers()
    const { source, loads } = feedSource('available')
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].resolve(read) })

    act(() => { notifyModelIndexChanged() })
    act(() => { vi.advanceTimersByTime(1100) })
    expect(loads).toHaveLength(2)
  })

  it('follows the feed only while something is expanded', async () => {
    const { source, listeners, stops } = feedSource('available')
    const { rerender, unmount } = renderHook(
      ({ expansions }) => useInlineExpansionContents(expansions, null, source),
      { initialProps: { expansions: {} as Record<string, string> } },
    )
    expect(listeners.size, 'subscribed with nothing expanded').toBe(0)
    rerender({ expansions: { host: 'B' } })
    expect(listeners.size).toBe(1)
    rerender({ expansions: {} })
    expect(listeners.size).toBe(0)
    expect(stops()).toBe(1)
    rerender({ expansions: { host: 'B' } })
    unmount()
    expect(listeners.size).toBe(0)
  })

  // QA lens, review 3: the server tier can be gone by the next expansion (a
  // workspace without it). A feed that stopped must stop answering for the
  // bridge's id-less server revisions.
  it('a feed that stopped no longer answers for the id-less server revisions', async () => {
    vi.useFakeTimers()
    let feedOn = true
    const loads: Array<(read: TargetRead) => void> = []
    const source: Source = {
      composition: (id) => (id === 'B' ? B : undefined),
      open: () => ({
        load: () => new Promise<TargetRead>((resolve) => { loads.push(resolve) }),
        subscribe: () => () => {},
        close: () => {},
      }),
      watchServerChanges: () => (feedOn ? () => {} : null),
    }
    const { rerender } = renderHook(
      ({ expansions }) => useInlineExpansionContents(expansions, null, source),
      { initialProps: { expansions: { host: 'B' } as Record<string, string> } },
    )
    await act(async () => { loads[0](read) })
    rerender({ expansions: {} })
    feedOn = false
    rerender({ expansions: { host: 'B' } })
    await act(async () => { loads[1](read) })

    act(() => { notifyModelIndexChanged(undefined, 'server-invalidation') })
    act(() => { vi.advanceTimersByTime(1100) })
    expect(loads, 'still skipping server revisions with no feed to answer for them').toHaveLength(3)
  })
})
