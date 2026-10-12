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

import { describe, expect, it, vi } from 'vitest'
import { roDecisionRecordDetail, roDecisionRecordPage } from './decisionRecords.js'

describe('roDecisionRecordPage', () => {
  it('returns a bounded page and total for a static workspace', async () => {
    const query = vi.fn(async () => ({ rows: [
          {
            id: 'adr-502', adr_number: 502, title: 'Bounded title', summary: 'Bounded summary',
            status: 'approved', author: 'Architect', created_at: '2026-02-02T00:00:00.000Z',
            updated_at: '2026-02-03T00:00:00.000Z', page_total: '100000',
          },
          {
            id: 'adr-501', adr_number: 501, title: 'Prior decision', summary: '',
            status: 'in-progress', author: 'Architect', created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z', page_total: '100000',
          },
        ] }))
    const page = await roDecisionRecordPage(
      { query } as never,
      { landscapeId: 'l1', versionId: 'v1' },
      { limit: 500 },
    )
    expect(page).toMatchObject({
      total: 100000, offset: 0, nextOffset: null, serverFiltered: true, detailsIncluded: false,
    })
    expect(page.items).toEqual([
      {
        id: 'adr-502', number: 502, title: 'Bounded title', summary: 'Bounded summary',
        status: 'approved', author: 'Architect', createdAt: '2026-02-02T00:00:00.000Z',
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
      {
        id: 'adr-501', number: 501, title: 'Prior decision', summary: '',
        status: 'in-progress', author: 'Architect', createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ])
    expect(query.mock.calls[0]?.[0]).toContain('created_at COLLATE "C" DESC')
    expect(query.mock.calls[0]?.[0]).not.toContain('OFFSET')
    expect(query.mock.calls[0]?.[0]).toContain("left(COALESCE(record.data->>'summary', ''), 1024)")
    expect(query.mock.calls[0]?.[0]).not.toContain('record.data\n')
    expect(query.mock.calls[0]?.[0]).toContain('AS page_total')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('loads one full record with a workspace-scoped point lookup', async () => {
    const full = { id: 'adr-501', content: 'Full markdown', related: [{ id: 'l1' }] }
    const query = vi.fn(async () => ({ rows: [{ data: full }] }))

    await expect(roDecisionRecordDetail(
      { query } as never,
      { landscapeId: 'l1', versionId: 'v1' },
      'adr-501',
    )).resolves.toEqual(full)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('record.id = $3'), ['l1', 'v1', 'adr-501'])
  })

  it('filters a page to ADRs whose related links target a diagram', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'adr-7', adr_number: 7, title: 'Linked decision', summary: '',
      status: 'approved', author: 'Architect', created_at: '2026-02-02T00:00:00.000Z',
      updated_at: '2026-02-03T00:00:00.000Z', page_total: '1',
    }] }))

    await roDecisionRecordPage(
      { query } as never,
      { landscapeId: 'l1', versionId: 'v1' },
      { relatedTargetId: 'diagram-1', relatedType: 'diagram', limit: 20 },
    )

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('record.data @>')
    expect(params).toContain(JSON.stringify({
      related: [{ targetId: 'diagram-1', type: 'diagram' }],
    }))
  })
})
