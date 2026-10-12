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
import {
  __setDecisionRecordFetchForTest,
  fetchDecisionRecordDetail,
  fetchDecisionRecordPage,
} from './decisionRecords'

describe('decision record page client', () => {
  afterEach(() => __setDecisionRecordFetchForTest(null))

  it('carries the active workspace and bounds the requested page', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      paged: true, total: 100_000, offset: 0, limit: 100, nextOffset: 100, items: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    __setDecisionRecordFetchForTest(fetcher)

    const page = await fetchDecisionRecordPage(0, 5_000)

    expect(page.total).toBe(100_000)
    expect(fetcher.mock.calls[0][0]).toContain('/api/model/decision-records/page?')
    expect(fetcher.mock.calls[0][0]).toContain('limit=100')
    expect(page.nextCursor).toBeNull()
    expect(page.nextOffset).toBe(100)
    expect(page.serverFiltered).toBe(false)
    expect(page.detailsIncluded).toBe(true)
  })

  it('sends global search and status filtering to the server and follows its signed cursor', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      paged: true,
      total: 1,
      limit: 50,
      serverFiltered: true,
      nextCursor: 'signed.next',
      projectionGeneration: 17,
      items: [{
        id: 'adr-90001', number: 90001, title: 'Remote ledger', summary: 'Beyond page 100',
        status: 'approved', author: 'Platform', createdAt: '2026-01-01', updatedAt: '2026-01-02',
        content: '', related: [],
      }],
    }), { status: 200 }))
    __setDecisionRecordFetchForTest(fetcher)

    const page = await fetchDecisionRecordPage({
      query: 'ledger', status: 'approved', after: 'signed.previous', offset: 50_000, limit: 50,
    })
    const url = String(fetcher.mock.calls[0][0])
    expect(url).toContain('q=ledger')
    expect(url).toContain('status=approved')
    expect(url).toContain('after=signed.previous')
    expect(url).not.toContain('offset=')
    expect(page).toMatchObject({
      nextCursor: 'signed.next', nextOffset: null, projectionGeneration: 17, serverFiltered: true,
    })
    expect(page.items[0].id).toBe('adr-90001')
  })

  it('requests ADRs related to a specific diagram', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      paged: true, total: 0, limit: 20, serverFiltered: true,
      nextCursor: null, nextOffset: null, items: [],
    }), { status: 200 }))
    __setDecisionRecordFetchForTest(fetcher)

    await fetchDecisionRecordPage({
      relatedTargetId: 'diagram/with spaces', relatedType: 'diagram', limit: 20,
    })

    const url = String(fetcher.mock.calls[0][0])
    expect(url).toContain('relatedTargetId=diagram%2Fwith+spaces')
    expect(url).toContain('relatedType=diagram')
  })

  it('normalizes bounded summary rows and marks their details as deferred', async () => {
    __setDecisionRecordFetchForTest(vi.fn(async () => new Response(JSON.stringify({
      paged: true, total: 1, limit: 100, detailsIncluded: false,
      items: [{
        id: 'adr-7', number: 7, title: 'Summary only', summary: 'Small', status: 'approved',
        author: 'Platform', createdAt: '2026-01-01', updatedAt: '2026-01-02',
      }],
    }), { status: 200 })))

    const page = await fetchDecisionRecordPage()

    expect(page.detailsIncluded).toBe(false)
    expect(page.items[0]).toMatchObject({ id: 'adr-7', content: '', related: [] })
  })

  it('fetches and validates a full record from the workspace-scoped detail API', async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({
      record: {
        id: 'adr/7', number: 7, title: 'Full', summary: 'Detail', status: 'approved',
        author: 'Platform', createdAt: '2026-01-01', updatedAt: '2026-01-02',
        content: '# Decision', related: [{ id: 'link-1', type: 'url', label: 'Docs', url: 'https://example.com' }],
      },
    }), { status: 200 }))
    __setDecisionRecordFetchForTest(fetcher)

    const record = await fetchDecisionRecordDetail('adr/7')

    const url = String(fetcher.mock.calls[0][0])
    expect(url).toContain('/api/model/decision-records/adr%2F7?')
    expect(url).toContain('landscapeId=')
    expect(url).toContain('versionId=')
    expect(record).toMatchObject({ id: 'adr/7', content: '# Decision' })
  })
})
