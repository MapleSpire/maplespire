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

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCursorRows, type CursorPage } from './useCursorRows'

interface Row {
  id: string
  label: string
}

describe('useCursorRows', () => {
  it('revalidates every loaded page atomically without clearing or duplicating the virtual window', async () => {
    let revision = 1
    let rows: Row[] = Array.from({ length: 8 }, (_, index) => ({
      id: `row-${index + 1}`,
      label: `Row ${index + 1}`,
    }))
    const fetchPage = vi.fn(async (cursor: string | null): Promise<CursorPage<Row>> => {
      const offset = cursor ? Number(cursor.slice('offset:'.length)) : 0
      const items = rows.slice(offset, offset + 2).map((row) => ({ ...row }))
      return {
        items,
        nextCursor: offset + items.length < rows.length ? `offset:${offset + items.length}` : null,
        total: rows.length,
        revision,
      }
    })

    const { result, rerender } = renderHook(
      ({ refreshKey }) => useCursorRows<Row>({
        queryKey: 'all',
        refreshKey,
        fetchPage,
        keyOf: (row) => row.id,
      }),
      { initialProps: { refreshKey: revision } },
    )

    await waitFor(() => expect(result.current.items.map((row) => row.id)).toEqual(['row-1', 'row-2']))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(4))

    rows = rows.map((row) => row.id === 'row-1' ? { ...row, label: 'Row 1 revised' } : row)
    revision = 2
    rerender({ refreshKey: revision })

    // The old window remains usable while both loaded pages are fetched again.
    expect(result.current.items).toHaveLength(4)
    await waitFor(() => expect(result.current.items[0]?.label).toBe('Row 1 revised'))
    expect(result.current.items).toHaveLength(4)
    expect(new Set(result.current.items.map((row) => row.id)).size).toBe(4)
    expect(result.current.refreshError).toBeNull()
    expect(fetchPage).toHaveBeenCalledTimes(4)
  })

  it('keeps the previous window when the projection changes between refresh pages', async () => {
    let refresh = false
    let refreshCall = 0
    const fetchPage = vi.fn(async (cursor: string | null): Promise<CursorPage<Row>> => {
      const offset = cursor ? Number(cursor.slice('offset:'.length)) : 0
      if (refresh) refreshCall += 1
      return {
        items: Array.from({ length: 2 }, (_, index) => ({
          id: `row-${offset + index + 1}`,
          label: refresh ? `Changed ${offset + index + 1}` : `Row ${offset + index + 1}`,
        })),
        nextCursor: offset < 2 ? `offset:${offset + 2}` : null,
        total: 4,
        revision: refresh && refreshCall > 1 ? 3 : 2,
      }
    })
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useCursorRows<Row>({
        queryKey: 'all', refreshKey, fetchPage, keyOf: (row) => row.id,
      }),
      { initialProps: { refreshKey: 1 } },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(4))
    const previous = result.current.items.map((row) => row.label)

    refresh = true
    rerender({ refreshKey: 2 })
    await waitFor(() => expect(result.current.refreshError).toMatch(/changed while/i))
    expect(result.current.items.map((row) => row.label)).toEqual(previous)
  })

  it('coalesces an invalidation that arrives while a refresh is already running', async () => {
    let revision = 1
    let releaseFirstRefresh!: () => void
    const firstRefreshGate = new Promise<void>((resolve) => { releaseFirstRefresh = resolve })
    let firstRefreshStarted = false
    const fetchPage = vi.fn(async (cursor: string | null): Promise<CursorPage<Row>> => {
      const requestRevision = revision
      if (requestRevision === 2 && cursor === null) {
        firstRefreshStarted = true
        await firstRefreshGate
      }
      const offset = cursor ? Number(cursor.slice('offset:'.length)) : 0
      return {
        items: Array.from({ length: 2 }, (_, index) => ({
          id: `row-${offset + index + 1}`,
          label: `Revision ${requestRevision}`,
        })),
        nextCursor: offset < 2 ? `offset:${offset + 2}` : null,
        total: 4,
        revision: requestRevision,
      }
    })
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useCursorRows<Row>({
        queryKey: 'all', refreshKey, fetchPage, keyOf: (row) => row.id,
      }),
      { initialProps: { refreshKey: revision } },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(4))

    revision = 2
    rerender({ refreshKey: revision })
    await waitFor(() => expect(firstRefreshStarted).toBe(true))
    revision = 3
    rerender({ refreshKey: revision })
    releaseFirstRefresh()

    await waitFor(() => expect(result.current.items[0]?.label).toBe('Revision 3'))
    await waitFor(() => expect(result.current.refreshing).toBe(false))
    expect(result.current.refreshError).toBeNull()
    expect(fetchPage).toHaveBeenCalledTimes(6)
  })
})
