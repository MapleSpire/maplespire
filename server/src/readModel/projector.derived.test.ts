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
import { upsertDiagrams, upsertObjects } from './projector.js'
import type { Queryable } from './types.js'

describe('derived projection mutation bounds', () => {
  it('never falls back to an unscoped workspace refresh for one object/diagram edit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('count(*) AS total')) return { rows: [{ total: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const db = { query } as unknown as Queryable
    const key = { landscapeId: 'landscape', versionId: 'version' }

    await upsertObjects(db, key, 'org', [{ id: 'o1', name: 'Edited', type: 'app' }])
    await upsertDiagrams(db, key, 'org', [{ id: 'd1', name: 'Edited diagram', objectIds: ['o1'] }])

    const statements = query.mock.calls.map(([sql]) => sql as string)
    const childRefreshes = statements.filter((sql) => sql.includes('DELETE FROM ro_object_child_stats'))
    expect(childRefreshes.length).toBeGreaterThan(0)
    expect(childRefreshes.every((sql) => sql.includes('object_id = ANY($3::text[])'))).toBe(true)
    const rootCounts = statements.filter((sql) => sql.includes('effective_parent_id IS NULL'))
    expect(rootCounts.every((sql) => sql.includes('ANY($3::text[])'))).toBe(true)
    const diagramRefreshes = statements.filter((sql) => sql.includes('FROM ro_diagrams diagram'))
    expect(diagramRefreshes.every((sql) => sql.includes('diagram.id = ANY($3::text[])')
      || sql.includes('summary.diagram_id = ANY($3::text[])'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM ro_connection_stats stat')
      && !sql.includes('connection_id = ANY'))).toBe(false)
  })
})
