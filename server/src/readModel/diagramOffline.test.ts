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
import type { Queryable } from './types.js'
import { roDiagramCachePage } from './diagramOffline.js'

const workspace = { landscapeId: 'large', versionId: 'v1' }

describe('roDiagramCachePage', () => {
  it('returns bounded reference-only manifests with a signed cursor', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, object_ids, data')) {
        expect(sql).toContain('landscape_id = $1 AND version_id = $2')
        expect(params?.slice(0, 2)).toEqual(['large', 'v1'])
        return {
          rows: [
            { id: 'dg-a', object_ids: ['a', 'a'], data: { connectionIds: ['c1'], groupIds: [] } },
            { id: 'dg-b', object_ids: ['b'], data: { connectionIds: [], groupIds: ['g1'] } },
            { id: 'dg-c', object_ids: ['c'], data: {} },
          ],
          rowCount: 3,
        }
      }
      if (sql.includes('projected_generation')) return { rows: [{ projected_generation: 44 }], rowCount: 1 }
      if (sql.includes('count(*) AS total')) return { rows: [{ total: 3 }], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const page = await roDiagramCachePage({ query } as unknown as Queryable, workspace, { limit: 2 })
    expect(page.projectionGeneration).toBe(44)
    expect(page.total).toBe(3)
    expect(page.items).toEqual([
      { diagramId: 'dg-a', objectIds: ['a'], connectionIds: ['c1'], groupIds: [] },
      { diagramId: 'dg-b', objectIds: ['b'], connectionIds: [], groupIds: ['g1'] },
    ])
    expect(page.nextCursor).toEqual(expect.any(String))
  })

  it('rejects a cursor that was not issued for this query', async () => {
    await expect(roDiagramCachePage({ query: vi.fn() } as unknown as Queryable, workspace, {
      after: encodeURIComponent(JSON.stringify({ id: 'dg-a' })),
    })).rejects.toThrow(/cursor/i)
  })
})
