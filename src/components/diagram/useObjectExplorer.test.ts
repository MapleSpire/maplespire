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
import { afterEach, describe, expect, it } from 'vitest'
import { __setModelQueryForTest, residentModelQuery } from '../../lib/modelQuery'
import type { ObjectExplorerRow } from '../../lib/modelQuery/types'
import { reconciledChildDisclosure, useObjectExplorer } from './useObjectExplorer'

const staleParent = { childCount: 1, hasChildren: true }

describe('object explorer disclosure reconciliation', () => {
  it('removes a stale chevron when an authoritative child page is empty', () => {
    expect(reconciledChildDisclosure(staleParent, {
      items: [], nextCursor: null, loading: false, loaded: true, error: null, coverage: 'full',
    })).toEqual({ childCount: 0, hasChildren: false })
  })

  it('also treats a server page without an explicit coverage field as authoritative', () => {
    expect(reconciledChildDisclosure(staleParent, {
      items: [], nextCursor: null, loading: false, loaded: true, error: null,
    })).toEqual({ childCount: 0, hasChildren: false })
  })

  it('removes a dead chevron from an empty offline working set', () => {
    expect(reconciledChildDisclosure(staleParent, {
      items: [], nextCursor: null, loading: false, loaded: true, error: null, coverage: 'working-set',
    })).toEqual({ childCount: 0, hasChildren: false })
  })

  it('keeps the chevron while children exist or the request can continue', () => {
    expect(reconciledChildDisclosure(staleParent, {
      items: [{ id: 'child' } as never], nextCursor: null,
      loading: false, loaded: true, error: null, coverage: 'full',
    })).toEqual(staleParent)
  })
})

describe('useObjectExplorer concurrent refresh', () => {
  afterEach(() => __setModelQueryForTest(null))

  it('keeps a deep search window visible and revalidates all loaded pages', async () => {
    let revision = 1
    let releaseRevisionTwo!: () => void
    const revisionTwoGate = new Promise<void>((resolve) => { releaseRevisionTwo = resolve })
    let revisionTwoStarted = false
    const records: ObjectExplorerRow[] = Array.from({ length: 100 }, (_, index) => ({
      id: `object-${index + 1}`,
      name: `Service ${index + 1}`,
      kind: 'object',
      type: 'app',
      parentId: null,
      childCount: 0,
      hasChildren: false,
      canAcceptChildren: true,
      appCount: 0,
      storeCount: 0,
      componentCount: 0,
      connectionCount: 0,
      diagramCount: 0,
      inDiagram: false,
      breadcrumb: [],
    }))
    __setModelQueryForTest({
      ...residentModelQuery,
      objectTreePage: async () => ({
        projectionGeneration: revision, items: [], nextCursor: null, total: 100,
      }),
      objectSearchPage: async (options) => {
        const requestRevision = revision
        const offset = options.cursor ? Number(options.cursor.slice('offset:'.length)) : 0
        if (requestRevision === 2 && offset === 0) {
          revisionTwoStarted = true
          await revisionTwoGate
        }
        const items = records.slice(offset, offset + 50).map((row) => ({
          ...row,
          name: requestRevision > 1 && row.id === 'object-1'
            ? `Service 1 revised ${requestRevision}`
            : row.name,
        }))
        return {
          projectionGeneration: requestRevision,
          items,
          nextCursor: offset + items.length < records.length ? `offset:${offset + items.length}` : null,
          total: records.length,
        }
      },
    })

    const { result, rerender } = renderHook(
      ({ refreshKey }) => useObjectExplorer({
        query: 'service', filters: {}, diagramId: null, refreshKey,
      }),
      { initialProps: { refreshKey: revision } },
    )
    await waitFor(() => expect(result.current.rows).toHaveLength(50), { timeout: 2_000 })
    act(() => result.current.loadMoreSearch())
    await waitFor(() => expect(result.current.rows).toHaveLength(100))

    revision = 2
    rerender({ refreshKey: revision })
    expect(result.current.rows).toHaveLength(100)
    await waitFor(() => expect(revisionTwoStarted).toBe(true))
    revision = 3
    rerender({ refreshKey: revision })
    releaseRevisionTwo()
    await waitFor(() => expect(result.current.rows[0]?.name).toBe('Service 1 revised 3'))
    expect(result.current.rows).toHaveLength(100)
    expect(new Set(result.current.rows.map((row) => row.id)).size).toBe(100)
  })
})
