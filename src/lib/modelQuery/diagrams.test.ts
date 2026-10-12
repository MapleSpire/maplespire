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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __setDiagramListFetchForTest, fetchDiagramListPage, normalizeDiagramListItem } from './diagrams'

describe('diagram list page client', () => {
  afterEach(() => __setDiagramListFetchForTest(null))

  it('carries filters and bounds the page size', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      total: 30_000, offset: 0, limit: 200, nextOffset: 1,
      items: [{ id: 'd1', name: 'Checkout', type: 'context', objectIds: [], connectionIds: [], groupIds: [] }],
    }), { status: 200 }))
    __setDiagramListFetchForTest(fetcher)
    const page = await fetchDiagramListPage({ limit: 500, query: 'check', type: 'context' })
    expect(page.total).toBe(30_000)
    expect(fetcher.mock.calls[0][0]).toContain('limit=200')
    expect(fetcher.mock.calls[0][0]).toContain('q=check')
    expect(fetcher.mock.calls[0][0]).toContain('type=context')
    expect(page.nextCursor).toBeNull()
    expect(page.nextOffset).toBe(1)
  })

  it('continues with the signed cursor without also sending a deep offset', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      total: 30_000,
      limit: 60,
      nextCursor: 'signed.next',
      projectionGeneration: 12,
      items: [{
        id: 'd2', name: 'Payments', type: 'container', domainId: 'money',
        objectCount: 500, connectionCount: 730, groupCount: 4,
        previewObjectIds: ['o1', 'o2'], previewObjectTypes: ['app', 'store'],
      }],
    }), { status: 200 }))
    __setDiagramListFetchForTest(fetcher)

    const page = await fetchDiagramListPage({ after: 'signed.previous', offset: 9_000 })
    const url = String(fetcher.mock.calls[0][0])
    expect(url).toContain('after=signed.previous')
    expect(url).not.toContain('offset=')
    expect(page).toMatchObject({ nextCursor: 'signed.next', nextOffset: null, projectionGeneration: 12 })
    expect(page.items[0]).toMatchObject({ objectCount: 500, connectionCount: 730 })
  })

  it('normalizes a compact summary without consulting resident object arrays', () => {
    const summary = normalizeDiagramListItem({
      id: 'd3', name: 'Ledger', type: 'component', objectCount: 100,
      connectionCount: 140, groupCount: 2, previewObjectTypes: ['component'],
    })
    expect(summary).toEqual(expect.objectContaining({
      id: 'd3', objectCount: 100, connectionCount: 140,
      previewObjectIds: [], previewObjectTypes: ['component'],
    }))
  })
})
