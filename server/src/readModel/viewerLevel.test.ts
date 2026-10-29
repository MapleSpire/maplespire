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
import { roViewerLevel } from './viewerLevel.js'

describe('model viewer level window', () => {
  it('returns ancestors, bounded children, child counts and visible direct edges', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT object.id, object.normalized_name')) {
        // The C4 hierarchy, not the explorer's group-first navigation parent.
        expect(sql).toContain('object.c4_parent_id = $3')
        expect(sql).not.toContain('effective_parent_id')
        expect(sql).not.toContain('IS NOT DISTINCT FROM')
        expect(params).toEqual(['ls', 'v1', 'system', '', [], 3])
        return { rows: [
          { id: 'a', normalized_name: 'a', data: { id: 'a', name: 'A', parentId: 'system' }, child_count: 2, page_total: 3, projected_generation: 33 },
          { id: 'b', normalized_name: 'b', data: { id: 'b', name: 'B', parentId: 'system' }, child_count: 0, page_total: 3, projected_generation: 33 },
          { id: 'c', normalized_name: 'c', data: { id: 'c', name: 'C', parentId: 'system' }, child_count: 0, page_total: 3, projected_generation: 33 },
        ], rowCount: 3 }
      }
      if (sql.includes('WITH RECURSIVE ancestors')) {
        return { rows: [{ data: { id: 'system', name: 'System' }, depth: 0 }], rowCount: 1 }
      }
      if (sql.includes('FROM ro_connections')) {
        expect(params).toEqual(['ls', 'v1', ['a', 'b'], 2])
        return { rows: [
          { data: { id: 'c1', fromId: 'a', toId: 'b' } },
          { data: { id: 'c2', fromId: 'b', toId: 'a' } },
        ], rowCount: 2 }
      }
      return { rows: [], rowCount: 0 }
    })
    const result = await roViewerLevel(
      { query },
      { landscapeId: 'ls', versionId: 'v1' },
      { parentId: 'system', limit: 2, connectionLimit: 1 },
    )
    expect(result).toMatchObject({
      projectionGeneration: 33,
      ancestors: [{ id: 'system', name: 'System' }],
      objects: [
        { object: { id: 'a', name: 'A', parentId: 'system' }, childCount: 2 },
        { object: { id: 'b', name: 'B', parentId: 'system' }, childCount: 0 },
      ],
      connections: [{ id: 'c1', fromId: 'a', toId: 'b' }],
      totalObjects: 3,
      connectionsTruncated: true,
    })
    expect(result.nextCursor).toMatch(/\./)
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('caps object and connection renderer windows', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT object.id, object.normalized_name')) {
        expect(sql).toContain('object.c4_parent_id IS NULL')
        // the lead key that lets the ROOT level (an IS NULL qual) read the page
        // straight off idx_ro_objects_c4_name_c_page instead of sorting every
        // root — measured with server/scripts/measure-viewer-level-c4.ts
        expect(sql).toContain('ORDER BY object.c4_parent_id, object.normalized_name COLLATE "C", object.id COLLATE "C"')
        expect(sql).not.toContain('effective_parent_id')
        expect(sql).not.toContain('IS NOT DISTINCT FROM')
        expect(params?.at(-1)).toBe(251)
      }
      return { rows: [], rowCount: 0 }
    })
    await roViewerLevel(
      { query },
      { landscapeId: 'ls', versionId: 'v1' },
      { limit: 99_999, connectionLimit: 99_999 },
    )
  })

  it('does not overlap statements on a checked-out PostgreSQL client', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const query = vi.fn(async (sql: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (sql.includes('SELECT object.id, object.normalized_name')) {
        return { rows: [{
          id: 'a', normalized_name: 'a', data: { id: 'a' }, child_count: 0,
          page_total: 1, projected_generation: 4,
        }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    await roViewerLevel(
      { query },
      { landscapeId: 'ls', versionId: 'v1' },
      { limit: 1 },
    )

    expect(maxInFlight).toBe(1)
    expect(query).toHaveBeenCalledTimes(2)
  })

  // PostgreSQL refuses a Bind that supplies a different NUMBER of parameters
  // than the statement's highest placeholder. The empty-level fallback used to
  // reuse the main statement's five parameters for a statement that mentions two
  // or three, so ANY empty level (a childless object, a new landscape) was an
  // HTTP 500. A mock that returns rows can never see this; one that checks every
  // statement's arity can.
  const highestPlaceholder = (sql: string) =>
    Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))

  it.each([
    ['root, no filter', {}],
    ['a parent, no filter', { parentId: 'system' }],
    ['root, text filter', { query: 'pay' }],
    ['a parent, domain filter', { parentId: 'system', domainIds: ['d1'] }],
    ['a parent, text filter and a cursor-free page', { parentId: 'system', query: 'pay', limit: 5 }],
  ])('binds exactly the placeholders each statement mentions on an EMPTY level (%s)', async (_label, opts) => {
    const arity: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (highestPlaceholder(sql) !== (params?.length ?? 0)) {
        arity.push(`${highestPlaceholder(sql)} placeholders, ${params?.length ?? 0} params: ${sql.slice(0, 60)}`)
      }
      return { rows: [], rowCount: 0 }
    })
    const result = await roViewerLevel({ query }, { landscapeId: 'ls', versionId: 'v1' }, opts)
    expect(arity).toEqual([])
    expect(result).toMatchObject({ objects: [], connections: [], totalObjects: 0, nextCursor: null })
  })
})
