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

interface Page<T> {
  items: T[]
  total: number
}

/**
 * Windowed data for a virtualized list: fetch only the visible slice (+ buffer)
 * through an async `fetchPage(offset, limit)`, so the view holds page-sized rows
 * instead of one per entity. `deps` (filter/sort/search keys) reset the window.
 *
 * Usage: count the virtualizer by `total`; in an effect call `ensureRange(first,
 * last)` with the visible indices; render `rowAt(i)` (undefined while loading).
 */
export function usePagedRows<T>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  deps: unknown[],
  buffer = 40
): { total: number; rowAt: (i: number) => T | undefined; ensureRange: (start: number, end: number) => void; loading: boolean } {
  const [total, setTotal] = useState(0)
  const [, force] = useState(0)
  const windowStart = useRef(0)
  const rows = useRef<T[]>([])
  const reqId = useRef(0)
  const [loading, setLoading] = useState(false)
  // The query identity is the caller's `deps` (filter/sort/search keys) — a runtime
  // array, so the lint rules that want a literal don't apply here.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const fetcher = useCallback(fetchPage, deps)

  const load = useCallback(
    async (start: number, limit: number) => {
      const id = ++reqId.current
      setLoading(true)
      try {
        const page = await fetcher(Math.max(0, start), limit)
        if (id !== reqId.current) return // superseded
        windowStart.current = Math.max(0, start)
        rows.current = page.items
        setTotal(page.total)
        force((n) => n + 1)
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    },
    [fetcher]
  )

  // Refresh on any dep change, but distinguish two cases so an edit doesn't yank the
  // scroll back to the top:
  //  - QUERY changed (search/sort/filter → `fetchPage`, hence `fetcher`, gets a new ref):
  //    the result set is different, so RESET to the first window.
  //  - DATA changed (an edit / index-version bump → `fetchPage` is ref-stable, so the
  //    extra deps the caller passes are what moved): REFRESH the CURRENT window in place,
  //    keeping `windowStart` (and the DOM scroll) so the edited row updates where it is —
  //    like the Model Objects table. We key on `deps` directly because a ref-stable
  //    `fetchPage` means `load` wouldn't change on data-only deps; `prevFetcher` is read
  //    inside the effect (never during render).
  const prevFetcher = useRef(fetcher)
  useEffect(() => {
    const queryChanged = prevFetcher.current !== fetcher
    prevFetcher.current = fetcher
    if (queryChanged) {
      windowStart.current = 0
      rows.current = []
       
      void load(0, buffer * 3)
    } else {
      // Keep the loaded rows visible (no flicker) and re-fetch the same range in place.
      const span = rows.current.length || buffer * 3
       
      void load(windowStart.current, span)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, buffer])

  const ensureRange = useCallback(
    (start: number, end: number) => {
      const loadedEnd = windowStart.current + rows.current.length
      if (start < windowStart.current || end >= loadedEnd) {
        void load(Math.max(0, start - buffer), end - start + buffer * 3)
      }
    },
    [load, buffer]
  )

  const rowAt = useCallback((i: number): T | undefined => {
    const local = i - windowStart.current
    return local >= 0 && local < rows.current.length ? rows.current[local] : undefined
  }, [])

  return { total, rowAt, ensureRange, loading }
}
