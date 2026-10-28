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
import { primeActiveWorkspaceRef } from '../../lib/automerge/workspace'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import type { ViewerLevelResult } from '../../lib/modelQuery/types'
import { childrenOf } from '../../lib/modelViewer/levels'
import type { C4Object } from '../../types'
import { useViewerData } from './useViewerData'

const mocks = vi.hoisted(() => ({ viewerLevel: vi.fn() }))

vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => ({ viewerLevel: mocks.viewerLevel }),
}))

const obj = (id: string, parentId?: string): C4Object =>
  ({ id, name: id, type: parentId ? 'container' : 'system', parentId }) as unknown as C4Object

const page = (ancestors: C4Object[], kids: Array<[C4Object, number]>): ViewerLevelResult => ({
  ancestors,
  objects: kids.map(([object, childCount]) => ({ object, childCount })),
  connections: [],
  nextCursor: null,
  totalObjects: kids.length,
  connectionsTruncated: false,
  projectionGeneration: 1,
  coverage: 'full',
})

const ROOT_PAGE = page([], [[obj('shop'), 2], [obj('erp'), 0]])
const SHOP_PAGE = page([obj('shop')], [[obj('web', 'shop'), 0], [obj('api', 'shop'), 0]])

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ids = (objects: C4Object[]) => objects.map((o) => o.id).sort()

/** The drill zoom animates the level it is handed. The hook used to CLEAR the
 * level window on every parent change, so both zoom layers rendered an empty
 * grid and the tiles popped in after the animation (2026-10-19, "the effect is
 * smooth in the design kit but not in the app"). */
describe('useViewerData level hand-over', () => {
  beforeEach(() => {
    mocks.viewerLevel.mockReset()
    primeActiveWorkspaceRef({ landscapeId: 'default', versionId: 'current' })
    useModelIndexVersion.setState({ version: 0 })
  })
  afterEach(cleanup)

  it('keeps serving the current level until the next level lands', async () => {
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.levelParentId).toBe(null))
    expect(ids(childrenOf(result.current.model, null))).toEqual(['erp', 'shop'])

    const shop = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(shop.promise)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))
    // The request is in flight: the root level must still be fully there,
    // labelled as the root level, not an empty window.
    expect(result.current.loaded).toBe(true)
    expect(result.current.levelParentId).toBe(null)
    expect(ids(childrenOf(result.current.model, null))).toEqual(['erp', 'shop'])

    await act(async () => shop.resolve(SHOP_PAGE))
    expect(result.current.levelParentId).toBe('shop')
    expect(ids(childrenOf(result.current.model, 'shop'))).toEqual(['api', 'web'])
  })

  it('answers a failed level with an empty window so a waiting drill still lands', async () => {
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.levelParentId).toBe(null))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.viewerLevel.mockRejectedValueOnce(new Error('offline'))
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(result.current.loaded).toBe(false)
    expect(result.current.model.objectById.size).toBe(0)
    warn.mockRestore()
  })

  it('drops the held level on a workspace switch instead of showing another landscape', async () => {
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    const { result } = renderHook(() => useViewerData({ parentId: null }))
    await waitFor(() => expect(result.current.levelParentId).toBe(null))

    const other = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(other.promise)
    primeActiveWorkspaceRef({ landscapeId: 'other', versionId: 'current' })
    act(() => useModelIndexVersion.setState({ version: 1 }))
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.loaded).toBe(false))
    expect(result.current.levelParentId).toBe(undefined)
    expect(result.current.model.objectById.size).toBe(0)

    await act(async () => other.resolve(page([], [[obj('billing'), 0]])))
    expect(result.current.levelParentId).toBe(null)
    expect(ids(childrenOf(result.current.model, null))).toEqual(['billing'])
  })
})

/** The warm-up half of the drill: a level already in memory lets the zoom start
 * on the click itself. At hundreds of thousands of objects it must also stay
 * bounded (the bounds themselves are unit-tested in levelStore.test.ts). */
describe('useViewerData level warm-up', () => {
  beforeEach(() => {
    mocks.viewerLevel.mockReset()
    primeActiveWorkspaceRef({ landscapeId: 'default', versionId: 'current' })
    useModelIndexVersion.setState({ version: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const mountAtRoot = async () => {
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    const hook = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(hook.result.current.levelParentId).toBe(null))
    return hook
  }
  const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

  it('serves a visited level from memory: the way back up needs no request', async () => {
    const { result, rerender } = await mountAtRoot()
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2)

    rerender({ parentId: null })
    await waitFor(() => expect(result.current.levelParentId).toBe(null))
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2)
    expect(ids(childrenOf(result.current.model, null))).toEqual(['erp', 'shop'])
  })

  it('prefetchLevel warms a level so peekLevel serves it and the drill needs no request', async () => {
    const { result, rerender } = await mountAtRoot()
    expect(result.current.peekLevel('shop')).toBeUndefined()
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    act(() => result.current.prefetchLevel('shop', true))
    await waitFor(() => expect(result.current.peekLevel('shop')).toBeDefined())
    expect(ids(childrenOf(result.current.peekLevel('shop')!.model, 'shop'))).toEqual(['api', 'web'])

    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2) // root + the warm-up, nothing for the drill
  })

  it('a drill that starts before the warm-up lands joins it instead of requesting twice', async () => {
    const { result, rerender } = await mountAtRoot()
    const shop = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(shop.promise)
    act(() => result.current.prefetchLevel('shop', true))
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))

    rerender({ parentId: 'shop' })
    await tick()
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2) // joined, not duplicated
    await act(async () => shop.resolve(SHOP_PAGE))
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(ids(childrenOf(result.current.model, 'shop'))).toEqual(['api', 'web'])
  })

  it('navigating aborts the warm-ups of the levels that were not chosen', async () => {
    const { result, rerender } = await mountAtRoot()
    let warmSignal: AbortSignal | undefined
    mocks.viewerLevel.mockImplementationOnce((_opts: unknown, signal?: AbortSignal) => {
      warmSignal = signal
      return new Promise(() => {})
    })
    act(() => result.current.prefetchLevel('erp', true))
    await waitFor(() => expect(warmSignal).toBeDefined())
    expect(warmSignal?.aborted).toBe(false)

    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(warmSignal?.aborted).toBe(true))
  })

  it('warms nothing while offline or under data saver', async () => {
    const { result } = await mountAtRoot()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    act(() => result.current.prefetchLevel('shop', true))
    await tick()
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(1)
    online.mockReturnValue(true)
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true })
    try {
      act(() => result.current.prefetchLevel('shop', true))
      await tick()
      expect(mocks.viewerLevel).toHaveBeenCalledTimes(1)
    } finally {
      delete (navigator as unknown as { connection?: unknown }).connection
    }
  })

  it('a model change drops the warm levels', async () => {
    const { result } = await mountAtRoot()
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    act(() => result.current.prefetchLevel('shop', true))
    await waitFor(() => expect(result.current.peekLevel('shop')).toBeDefined())

    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    act(() => useModelIndexVersion.setState({ version: 1 }))
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(3))
    expect(result.current.peekLevel('shop')).toBeUndefined()
  })

  it('a first page does not inherit the previous level\'s truncation flag', async () => {
    mocks.viewerLevel.mockResolvedValueOnce({ ...ROOT_PAGE, connectionsTruncated: true })
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.connectionsTruncated).toBe(true))
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(result.current.connectionsTruncated).toBe(false)
  })

  it('offers no "load more" for a level that has not landed, so a page cursor never crosses levels', async () => {
    mocks.viewerLevel.mockResolvedValueOnce({ ...ROOT_PAGE, nextCursor: 'cursor-of-root' })
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.hasMoreObjects).toBe(true))

    const shop = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(shop.promise)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))
    // the root window is still held, with its cursor, while shop loads
    expect(result.current.levelParentId).toBe(null)
    expect(result.current.hasMoreObjects).toBe(false)
    act(() => result.current.loadMore())
    await tick()
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2) // the root cursor was NOT sent for shop

    await act(async () => shop.resolve(SHOP_PAGE))
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(ids(childrenOf(result.current.model, 'shop'))).toEqual(['api', 'web']) // first page not superseded
  })

  it('a different text or domain filter never reuses a cached level', async () => {
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE)
    const { result, rerender } = renderHook(
      (props: { query?: string; domainIds?: string[] }) => useViewerData({ parentId: null, ...props }),
      { initialProps: {} as { query?: string; domainIds?: string[] } },
    )
    await waitFor(() => expect(result.current.levelParentId).toBe(null))

    mocks.viewerLevel.mockResolvedValueOnce(page([], [[obj('payments'), 0]]))
    rerender({ query: 'pay' })
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))
    expect(mocks.viewerLevel.mock.calls[1][0]).toMatchObject({ query: 'pay' })
    await waitFor(() => expect(ids(childrenOf(result.current.model, null))).toEqual(['payments']))

    mocks.viewerLevel.mockResolvedValueOnce(page([], [[obj('billing'), 0]]))
    rerender({ domainIds: ['d1'] })
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(3))
    expect(mocks.viewerLevel.mock.calls[2][0]).toMatchObject({ domainIds: ['d1'] })
    await waitFor(() => expect(ids(childrenOf(result.current.model, null))).toEqual(['billing']))
  })

  it('a level remembered for one workspace is never served for another (without any model change)', async () => {
    const { result, rerender } = await mountAtRoot() // workspace "default"
    primeActiveWorkspaceRef({ landscapeId: 'other', versionId: 'current' })
    // no ancestors in this page: it must not trigger the parent warm-up
    mocks.viewerLevel.mockResolvedValueOnce(page([], [[obj('x'), 0]]))
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    mocks.viewerLevel.mockResolvedValueOnce(page([], [[obj('billing'), 0]]))
    rerender({ parentId: null })
    await waitFor(() => expect(ids(childrenOf(result.current.model, null))).toEqual(['billing']))
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(3) // the other workspace's root was fetched, not recalled
  })

  it('"load more" pages are merged and remembered with their level', async () => {
    mocks.viewerLevel.mockResolvedValueOnce({ ...ROOT_PAGE, nextCursor: 'c1' })
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.hasMoreObjects).toBe(true))
    mocks.viewerLevel.mockResolvedValueOnce(page([], [[obj('zed'), 0]]))
    act(() => result.current.loadMore())
    await waitFor(() => expect(ids(childrenOf(result.current.model, null))).toEqual(['erp', 'shop', 'zed']))
    expect(result.current.hasMoreObjects).toBe(false)

    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    rerender({ parentId: null })
    await waitFor(() => expect(result.current.levelParentId).toBe(null))
    expect(ids(childrenOf(result.current.model, null))).toEqual(['erp', 'shop', 'zed']) // both pages kept
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(3) // root, page 2, shop — the way back needed none
  })

  it('a "load more" page that lands after navigating away is discarded', async () => {
    mocks.viewerLevel.mockResolvedValueOnce({ ...ROOT_PAGE, nextCursor: 'c1' })
    const { result, rerender } = renderHook(({ parentId }) => useViewerData({ parentId }), {
      initialProps: { parentId: null as string | null },
    })
    await waitFor(() => expect(result.current.hasMoreObjects).toBe(true))
    const stale = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(stale.promise)
    act(() => result.current.loadMore())
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))

    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' })
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    await act(async () => stale.resolve(page([], [[obj('zed'), 0]])))
    await tick()
    expect(result.current.levelParentId).toBe('shop')
    expect(ids(childrenOf(result.current.model, 'shop'))).toEqual(['api', 'web'])
    expect(ids(childrenOf(result.current.peekLevel(null)!.model, null))).toEqual(['erp', 'shop']) // no zed
  })

  it('opening a level warms the one above it (a deep link can still go back instantly)', async () => {
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE) // ancestors: [shop], shop has no parent
    mocks.viewerLevel.mockResolvedValueOnce(ROOT_PAGE) // the warm-up of the level above
    const { result } = renderHook(() => useViewerData({ parentId: 'shop' }))
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    await waitFor(() => expect(result.current.peekLevel(null)).toBeDefined())
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(2)
  })

  it('a drill that joined a warm-up which then FAILED falls back to its own fetch', async () => {
    const { result, rerender } = await mountAtRoot()
    const warm = deferred<ViewerLevelResult>()
    mocks.viewerLevel.mockReturnValueOnce(warm.promise)
    act(() => result.current.prefetchLevel('shop', true))
    await waitFor(() => expect(mocks.viewerLevel).toHaveBeenCalledTimes(2))
    mocks.viewerLevel.mockResolvedValueOnce(SHOP_PAGE)
    rerender({ parentId: 'shop' }) // joins the warm-up
    await tick()
    await act(async () => warm.reject(new Error('network')))
    await waitFor(() => expect(result.current.levelParentId).toBe('shop'))
    expect(ids(childrenOf(result.current.model, 'shop'))).toEqual(['api', 'web'])
    expect(mocks.viewerLevel).toHaveBeenCalledTimes(3)
  })
})
