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
import { roDiagramListPage } from './diagramList.js'

describe('roDiagramListPage', () => {
  it('returns a bounded searchable page and total', async () => {
    const query = vi.fn(async () => ({ rows: [{
          diagram_id: 'perf-dg-1', normalized_name: 'checkout',
          object_count: 50, connection_count: 49, group_count: 0,
          preview_object_ids: ['o1'], preview_object_types: ['app'],
          data: { id: 'perf-dg-1', name: 'Checkout', type: 'context' },
          page_total: '30000',
        }] }))
    const page = await roDiagramListPage(
      { query } as never,
      { landscapeId: 'landscape', versionId: 'version' },
      { limit: 500, query: 'check', type: 'context' },
    )
    expect(page).toMatchObject({ total: 30000, offset: 0, limit: 200, nextOffset: null })
    expect(page.items[0]).toMatchObject({
      id: 'perf-dg-1', objectIds: ['o1'], objectCount: 50, connectionCount: 49,
    })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('summary.type'), expect.arrayContaining(['context']))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('AS page_total')
    expect(query.mock.calls[0]?.[0]).not.toContain('OFFSET')
  })
})
