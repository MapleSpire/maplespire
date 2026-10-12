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

import { useCallback, useEffect, useRef, useState } from 'react'

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
  total: number
  coverage?: 'working-set' | 'full'
  /** Optional snapshot/revision returned by the data source. Every page in one
   * background revalidation must agree on it or the window is kept unchanged. */
  revision?: string | number
}

type LoadMode = 'replace' | 'append' | 'refresh'

interface RefreshedWindow<T> extends CursorPage<T> {
  complete: boolean
}

function appendUnique<T>(current: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const keys = new Set(current.map(keyOf))
  return [...current, ...incoming.filter((item) => !keys.has(keyOf(item)))]
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, value])
  return debounced
}

export function useCursorRows<T>({
  queryKey,
  refreshKey,
  enabled = true,
  fetchPage,
  keyOf,
  maxRefreshPages = 20,
}: {
  /** Identity of the user's query. Changing it hides stale rows immediately. */
  queryKey: string
  /** Data-revision signal. Changing it revalidates the loaded window in the
   * background and keeps the current rows/scroll anchor visible meanwhile. */
  refreshKey?: unknown
  enabled?: boolean
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<CursorPage<T>>
  keyOf: (item: T) => string
  /** Safety bound for a deep infinite-scroll window. Defaults to 1,000 rows at
   * the normal 50-row page size; an incomplete refresh preserves the tail. */
  maxRefreshPages?: number
}) {
  const [items, setItems] = useState<T[]>([])
  const itemsRef = useRef<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const cursorRef = useRef<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const loadingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshIncomplete, setRefreshIncomplete] = useState(false)
  const [queuedRefresh, setQueuedRefresh] = useState(0)
  const consumedQueuedRefresh = useRef(0)
  const [coverage, setCoverage] = useState<'working-set' | 'full' | undefined>()
  const [resultQueryKey, setResultQueryKey] = useState<string | null>(null)
  const resultQueryKeyRef = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const refreshEffectMounted = useRef(false)
  const pendingRefresh = useRef(false)

  const fetchRefreshedWindow = useCallback(async (
    targetCount: number,
    signal: AbortSignal,
  ): Promise<RefreshedWindow<T>> => {
    let cursor: string | null = null
    let items: T[] = []
    let total = 0
    let coverage: CursorPage<T>['coverage']
    let revision: CursorPage<T>['revision']
    const pageLimit = Math.max(1, Math.floor(maxRefreshPages))
    for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
      const page = await fetchPage(cursor, signal)
      if (pageIndex === 0) revision = page.revision
      else if (revision !== undefined && page.revision !== undefined && page.revision !== revision) {
        throw new Error('Data changed while the visible list window was being refreshed')
      }
      items = appendUnique(items, page.items, keyOf)
      cursor = page.nextCursor
      total = page.total
      coverage = page.coverage
      if (!cursor || items.length >= targetCount) {
        return { items, nextCursor: cursor, total, coverage, revision, complete: true }
      }
    }
    return { items, nextCursor: cursor, total, coverage, revision, complete: false }
  }, [fetchPage, keyOf, maxRefreshPages])

  const load = useCallback(async (mode: LoadMode) => {
    const append = mode === 'append'
    const refresh = mode === 'refresh'
    if (!enabled || (append && !cursorRef.current)) return
    if (loadingRef.current) {
      if (refresh) pendingRefresh.current = true
      return
    }
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    const requestSequence = ++sequence.current
    loadingRef.current = true
    setLoading(true)
    setRefreshing(refresh)
    if (refresh) setRefreshError(null)
    else {
      setError(null)
      if (mode === 'replace') {
        setRefreshError(null)
        setRefreshIncomplete(false)
      }
    }
    try {
      const refreshedPage = refresh
        ? await fetchRefreshedWindow(Math.max(1, itemsRef.current.length), request.signal)
        : null
      const page = refreshedPage ?? await fetchPage(append ? cursorRef.current : null, request.signal)
      if (request.signal.aborted || sequence.current !== requestSequence) return
      const refreshComplete = refreshedPage?.complete ?? true
      const nextItems = refresh && !refreshComplete
        ? appendUnique(page.items, itemsRef.current, keyOf).slice(0, Math.max(itemsRef.current.length, page.items.length))
        : append
          ? appendUnique(itemsRef.current, page.items, keyOf)
          : page.items
      itemsRef.current = nextItems
      // A bounded partial refresh cannot safely replace the continuation cursor
      // for a deeper old window. Keep it until a complete refresh catches up.
      if (!refresh || refreshComplete) cursorRef.current = page.nextCursor
      resultQueryKeyRef.current = queryKey
      setResultQueryKey(queryKey)
      setItems(nextItems)
      setNextCursor(cursorRef.current)
      setTotal(page.total)
      setCoverage(page.coverage)
      setRefreshIncomplete(refresh && !refreshComplete)
    } catch (cause) {
      if (request.signal.aborted || sequence.current !== requestSequence) return
      if (refresh) {
        setRefreshError(cause instanceof Error ? cause.message : String(cause))
        return
      }
      resultQueryKeyRef.current = queryKey
      setResultQueryKey(queryKey)
      if (!append) {
        itemsRef.current = []
        cursorRef.current = null
        setItems([])
        setNextCursor(null)
        setTotal(0)
        setCoverage(undefined)
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence.current === requestSequence) {
        loadingRef.current = false
        setLoading(false)
        setRefreshing(false)
        if (pendingRefresh.current && resultQueryKeyRef.current === queryKey) {
          pendingRefresh.current = false
          setQueuedRefresh((value) => value + 1)
        }
      }
    }
  }, [enabled, fetchPage, fetchRefreshedWindow, keyOf, queryKey])

  useEffect(() => {
    let active = true
    controller.current?.abort()
    sequence.current += 1
    itemsRef.current = []
    cursorRef.current = null
    resultQueryKeyRef.current = null
    loadingRef.current = false
    pendingRefresh.current = false
    if (enabled) queueMicrotask(() => {
      if (active) void load('replace')
    })
    return () => {
      active = false
      controller.current?.abort()
    }
    // fetchPage captures the same contract represented by queryKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, queryKey])

  useEffect(() => {
    if (!refreshEffectMounted.current) {
      refreshEffectMounted.current = true
      return
    }
    if (!enabled || resultQueryKeyRef.current !== queryKey) return
    let active = true
    queueMicrotask(() => {
      if (active) void load('refresh')
    })
    return () => {
      active = false
    }
    // `refreshKey` is deliberately an opaque revision signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, queryKey, refreshKey])

  useEffect(() => {
    if (queuedRefresh === consumedQueuedRefresh.current) return
    consumedQueuedRefresh.current = queuedRefresh
    if (!enabled || resultQueryKeyRef.current !== queryKey) return
    let active = true
    queueMicrotask(() => {
      if (active) void load('refresh')
    })
    return () => {
      active = false
    }
  }, [enabled, load, queryKey, queuedRefresh])

  // A query-key change is reflected during render, before the effect starts the
  // replacement request. This prevents one frame of stale rows without using a
  // synchronous effect-driven state reset.
  const hasCurrentResult = enabled && resultQueryKey === queryKey

  return {
    items: hasCurrentResult ? items : [],
    nextCursor: hasCurrentResult ? nextCursor : null,
    total: hasCurrentResult ? total : 0,
    loading: enabled && (!hasCurrentResult || loading),
    refreshing: hasCurrentResult && refreshing,
    error: hasCurrentResult ? error : null,
    refreshError: hasCurrentResult ? refreshError : null,
    refreshIncomplete: hasCurrentResult && refreshIncomplete,
    coverage: hasCurrentResult ? coverage : undefined,
    loadMore: () => void load('append'),
    retry: () => void load('replace'),
    refresh: () => void load('refresh'),
  }
}
