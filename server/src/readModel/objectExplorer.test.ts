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
import { roObjectCacheByIds, roObjectCachePage, roObjectSearchPage, roObjectTreeChildren } from './objectExplorer.js'

const workspace = { landscapeId: 'landscape-a', versionId: 'version-a' }
const isMetricSql = (sql: string) => sql.includes("FILTER (WHERE child.type") || sql.includes('endpoints GROUP BY') || sql.includes('ro_diagram_groups')
const isTotalSql = (sql: string) => sql.includes('SELECT count(*) FROM ro_objects') && sql.includes('SELECT count(*) FROM ro_groups')

describe('enterprise object explorer', () => {
  it('paginates roots with a signed keyset cursor and exposes chevrons only for real children', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('read_model_projection_state')) {
        return { rows: [{ projected_generation: 42 }], rowCount: 1 }
      }
      if (isMetricSql(sql)) return { rows: [], rowCount: 0 }
      if (isTotalSql(sql)) return { rows: [{ total: 2 }], rowCount: 1 }
      return {
        rows: [
          {
            id: 'store', name: 'Orders DB', normalized_name: 'orders db', kind: 'object', type: 'store',
            parent_id: null, child_count: 0, scope: 'internal', status: 'live', icon: null,
            icon_assignment: null, in_diagram: true, sort_order: 4,
          },
          {
            id: 'component', name: 'Payments', normalized_name: 'payments', kind: 'object', type: 'component',
            parent_id: null, child_count: 0, scope: 'internal', status: 'live', icon: null,
            icon_assignment: null, in_diagram: false, sort_order: 5,
          },
        ],
        rowCount: 2,
      }
    })

    const result = await roObjectTreeChildren({ query } as unknown as Queryable, workspace, { limit: 1 })

    expect(result.projectionGeneration).toBe(42)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: 'store', childCount: 0, hasChildren: false, canAcceptChildren: true, inDiagram: true,
    })
    expect(result.nextCursor).toMatch(/\./)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('ORDER BY sort_order, normalized_name, id')
    expect(params.at(-1)).toBe(2)
  })

  it('binds search to indexed filters, caps the page, and returns a breadcrumb instead of expanding the tree', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('WITH candidates AS')) {
        return {
          rows: [{
            id: 'checkout', name: 'Checkout service', normalized_name: 'checkout service', kind: 'object', type: 'app',
            parent_id: 'storefront', child_count: 1, scope: 'internal', status: 'live', icon: null,
            icon_assignment: null, in_diagram: true, sort_order: 3, score: 3,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('WITH RECURSIVE chain')) {
        return {
          rows: [{ origin_id: 'checkout', id: 'storefront', name: 'Storefront platform', depth: 1 }],
          rowCount: 1,
        }
      }
      if (isMetricSql(sql)) return { rows: [], rowCount: 0 }
      if (isTotalSql(sql)) return { rows: [{ total: 1 }], rowCount: 1 }
      expect(params).toEqual([workspace.landscapeId, workspace.versionId])
      return { rows: [{ projected_generation: 7 }], rowCount: 1 }
    })

    const result = await roObjectSearchPage({ query } as unknown as Queryable, workspace, {
      query: 'checkout', diagramId: 'diagram-a', limit: 5,
      filter: { types: ['app'], technologyIds: ['nodejs'], scope: 'internal' },
    })

    expect(result).toMatchObject({ projectionGeneration: 7, nextCursor: null })
    expect(result.items[0]).toMatchObject({
      id: 'checkout', matchKind: 'prefix', breadcrumb: [{ id: 'storefront', name: 'Storefront platform' }],
    })
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('o.type = ANY')
    expect(sql).toContain('ro_object_technologies')
    expect(sql).toContain('ORDER BY score DESC, normalized_name, id')
    expect(params).toContain('diagram-a')
    expect(params.at(-1)).toBe(6)
  })

  it('never asks PostgreSQL for more than 51 rows', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await roObjectTreeChildren({ query } as unknown as Queryable, workspace, { limit: 10_000 })
    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params.at(-1)).toBe(51)
  })

  it('does not bind an unused contains parameter for two-character prefix search', async () => {
    let captured: [string, unknown[]] | undefined
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH candidates AS')) captured = [sql, params]
      if (isTotalSql(sql)) return { rows: [{ total: 0 }], rowCount: 1 }
      if (sql.includes('read_model_projection_state')) {
        return { rows: [{ projected_generation: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    await roObjectSearchPage({ query } as unknown as Queryable, workspace, { query: 'ch', limit: 50 })

    expect(captured).toBeDefined()
    const [sql, params] = captured!
    expect(params).toEqual(['landscape-a', 'version-a', null, 'ch', 'ch%', '% ch%', 51])
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    expect(new Set(placeholders)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]))
  })

  it('streams normalized cache rows in bounded pages without client-side hierarchy assembly', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('read_model_projection_state')
      ? { rows: [{ projected_generation: 12 }], rowCount: 1 }
      : {
          rows: [{
            id: 'g1', kind: 'group', name: 'Platform', type: 'group', parent_id: null,
            child_count: 2, search_text: 'Platform', data: { id: 'g1', name: 'Platform' }, sort_order: 0,
          }],
          rowCount: 1,
        })
    const page = await roObjectCachePage({ query } as unknown as Queryable, workspace, { limit: 500 })
    expect(page).toEqual({
      projectionGeneration: 12,
      total: 0,
      items: [{
        id: 'g1', kind: 'group', name: 'Platform', type: 'group', parentId: null,
        childCount: 2, searchText: 'Platform', payload: { id: 'g1', name: 'Platform' },
      }],
      nextCursor: null,
    })
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('o.effective_parent_id AS parent_id')
    expect(params.at(-1)).toBe(501)
  })

  it('refreshes a bounded changed identity set with current child counts', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('read_model_projection_state')) {
        return { rows: [{ projected_generation: 19 }], rowCount: 1 }
      }
      expect(params).toEqual(['landscape-a', 'version-a', ['parent', 'missing']])
      return { rows: [{
        id: 'parent', kind: 'object', name: 'Storefront', type: 'system', parent_id: null,
        child_count: 3, data: { id: 'parent', name: 'Storefront', type: 'system' },
      }], rowCount: 1 }
    })
    const result = await roObjectCacheByIds(
      { query } as unknown as Queryable,
      workspace,
      ['parent', 'missing', 'parent'],
    )
    expect(result).toEqual({
      projectionGeneration: 19,
      items: [{
        id: 'parent', kind: 'object', name: 'Storefront', type: 'system', parentId: null,
        childCount: 3, searchText: 'Storefront',
        payload: { id: 'parent', name: 'Storefront', type: 'system' },
      }],
    })
  })
})
