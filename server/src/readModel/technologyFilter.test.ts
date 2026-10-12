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
import { roFilteredObjectTree, roModelObjectFacets } from './queries.js'
import type { Queryable } from './types.js'

describe('roFilteredObjectTree', () => {
  it('uses indexed technology IDs, ORs values in facets, ANDs facets, and returns ancestors', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('ro_groups g')
      ? { rows: [], rowCount: 0 }
      : {
          rows: [
            { id: 'root', data: { id: 'root' }, direct_match: false, depth: 2 },
            { id: 'leaf', data: { id: 'leaf' }, direct_match: true, depth: 0 },
          ],
          rowCount: 2,
        })
    const db = { query } as unknown as Queryable
    const result = await roFilteredObjectTree(
      db,
      { landscapeId: 'ls', versionId: 'v' },
      {
        technologyIds: ['tech-a', 'tech-b'], statuses: ['live', 'planned'],
        tagIds: ['critical', 'public'], teamIds: ['team-a', 'team-b'],
      },
      { domainId: 'domain-a' }
    )

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('JOIN technology_redirects redirect')
    expect(sql).toContain('JOIN ro_object_technologies t ON t.technology_id = selected.technology_id')
    expect(sql).toContain('JOIN tag_redirects redirect')
    expect(sql).toContain('JOIN ro_object_tags t ON t.tag_id = selected.tag_id')
    expect(sql).not.toContain("o.data->'tags'")
    expect(sql).toContain("COALESCE(o.data->'ownerTeamIds'")
    expect(sql).toContain('WITH RECURSIVE selected_canonical_technologies')
    expect(sql).toContain('tree AS (')
    expect(params).toEqual([
      'ls', 'v', ['tech-a', 'tech-b'], ['live', 'planned'],
      ['critical', 'public'], ['team-a', 'team-b'], 'domain-a',
    ])
    expect(result).toEqual({
      objects: [{ id: 'root' }, { id: 'leaf' }], matchedIds: ['leaf'],
      groups: [], matchedGroupIds: [],
    })
  })

  it('queries group technology postings separately without mixing entity payloads', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('ro_groups g')
      ? { rows: [{ id: 'group-a', data: { id: 'group-a', name: 'Platform' } }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    const result = await roFilteredObjectTree(
      { query } as unknown as Queryable,
      { landscapeId: 'ls', versionId: 'v' },
      { technologyIds: ['terraform'] },
    )

    const [groupSql, groupParams] = query.mock.calls[1] as unknown as [string, unknown[]]
    expect(groupSql).toContain('JOIN ro_group_technologies t')
    expect(groupSql).toContain('matching_technology_ids')
    expect(groupSql).toContain('t.technology_id = selected.technology_id')
    expect(groupParams).toEqual(['ls', 'v', ['terraform']])
    expect(result).toEqual({
      objects: [], matchedIds: [],
      groups: [{ id: 'group-a', name: 'Platform' }], matchedGroupIds: ['group-a'],
    })
  })

  it('queries normalized group Tag postings and canonical redirect chains', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('ro_groups g')
      ? { rows: [{ id: 'group-a', data: { id: 'group-a', name: 'Platform' } }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    await roFilteredObjectTree(
      { query } as unknown as Queryable,
      { landscapeId: 'ls', versionId: 'v' },
      { tagIds: ['risk-high'] },
    )
    const [groupSql, groupParams] = query.mock.calls[1] as unknown as [string, unknown[]]
    expect(groupSql).toContain('selected_group_tag_walk')
    expect(groupSql).toContain('JOIN ro_group_tags t ON t.tag_id = selected.tag_id')
    expect(groupParams).toEqual(['ls', 'v', ['risk-high']])
  })
})

describe('roModelObjectFacets', () => {
  it('reads distinct teams from the normalized covering index source', async () => {
    const query = vi.fn(async () => ({
      rows: [{ team_id: 'team-a' }, { team_id: 'team-b' }], rowCount: 2,
    }))
    const result = await roModelObjectFacets(
      { query } as unknown as Queryable,
      { landscapeId: 'ls', versionId: 'v' },
    )
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('FROM ro_object_teams')
    expect(sql).not.toContain('ro_objects')
    expect(params).toEqual(['ls', 'v'])
    expect(result).toEqual({ teamIds: ['team-a', 'team-b'] })
  })
})
