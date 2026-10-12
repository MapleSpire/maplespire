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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { ensureAuthSchema } from '../auth/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { TechnologyRepository } from './repository.js'
import { ensureTechnologySchema } from './schema.js'

const connectionString = process.env.TEST_DATABASE_URL
const CATALOG_SIZE = 50_000

describe.skipIf(!connectionString)('technology catalog search at 50k entries', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  let repository: TechnologyRepository

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_search_scale')
    pool = db.pool
    await ensureAuthSchema(pool)
    await ensureTechnologySchema(pool)

    await pool.query(`
      INSERT INTO technology_identities
        (id, scope, lifecycle_status, latest_revision, current_revision, created_by)
      SELECT 'tech_scale_' || lpad(n::text, 5, '0'), 'public', 'active', 1, 1, 'scale-test'
      FROM generate_series(1, $1) n
    `, [CATALOG_SIZE])
    await pool.query(`
      INSERT INTO technology_revisions
        (technology_id, revision, name, normalized_name, aliases, normalized_aliases,
         category, recommended_shape_types, default_role, search_document, created_by)
      SELECT
        'tech_scale_' || lpad(n::text, 5, '0'),
        1,
        CASE WHEN n = $1 THEN 'Catalog Needle Framework' ELSE 'Catalog Technology ' || lpad(n::text, 5, '0') END,
        CASE WHEN n = $1 THEN 'catalog needle framework' ELSE 'catalog technology ' || lpad(n::text, 5, '0') END,
        CASE WHEN n = $1 THEN ARRAY['Needle-Alias']::text[] ELSE ARRAY[]::text[] END,
        CASE WHEN n = $1 THEN ARRAY['needle alias']::text[] ELSE ARRAY[]::text[] END,
        CASE WHEN n % 5 = 0 THEN 'Database' ELSE 'General technology' END,
        CASE WHEN n % 5 = 0 THEN ARRAY['store']::text[] ELSE ARRAY['system','app','store','component','group']::text[] END,
        CASE WHEN n % 5 = 0 THEN 'database' ELSE 'other' END,
        CASE WHEN n = $1 THEN 'catalog needle framework needle alias' ELSE 'catalog technology ' || lpad(n::text, 5, '0') END,
        'scale-test'
      FROM generate_series(1, $2) n
    `, [CATALOG_SIZE - 1, CATALOG_SIZE])
    await pool.query(`
      INSERT INTO technology_revision_workflows
        (technology_id, revision, status, decided_by, decided_at)
      SELECT 'tech_scale_' || lpad(n::text, 5, '0'), 1, 'approved', 'scale-test', now()
      FROM generate_series(1, $1) n
    `, [CATALOG_SIZE])
    await pool.query('ANALYZE technology_identities')
    await pool.query('ANALYZE technology_revisions')
    await pool.query('ANALYZE technology_revision_workflows')
    repository = new TechnologyRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('caps broad result pages at 50 rows at the repository boundary', async () => {
    const search = await repository.search('__scale_reader__', 'catalog technology', 5_000)
    const list = await repository.list('__scale_reader__', { q: 'catalog technology', limit: 5_000 })

    expect(search).toHaveLength(50)
    expect(list.technologies).toHaveLength(50)
    expect(list.nextCursor).toEqual(expect.any(String))
  })

  it('preserves contains and punctuation-insensitive alias matching', async () => {
    const contains = await repository.search('__scale_reader__', 'dle frame', 50)
    const compactAlias = await repository.search('__scale_reader__', 'NeedleAlias', 50)

    expect(contains).toEqual([
      expect.objectContaining({ id: 'tech_scale_49999', matchKind: 'contains' }),
    ])
    expect(compactAlias).toEqual([
      expect.objectContaining({ id: 'tech_scale_49999', matchKind: 'exact_alias' }),
    ])
  })

  it('uses trigram indexes to generate selective contains-search candidates', async () => {
    let captured: { text: string; values?: unknown[] } | undefined
    const instrumentedPool = {
      query(text: string, values?: unknown[]) {
        captured = { text, values }
        return pool.query(text, values as never)
      },
    } as unknown as Pool
    await new TechnologyRepository(instrumentedPool).search('__scale_reader__', 'needle framework', 50)
    expect(captured).toBeDefined()

    const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${captured!.text}`,
      captured!.values as never
    )
    const plan = JSON.stringify(rows[0]?.['QUERY PLAN'])

    expect(plan).toContain('idx_technology_revisions_search_document_trgm')
    expect(plan).toContain('idx_technology_revisions_compact_document_trgm')
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]+"Relation Name":"technology_revisions"/)
  })

  it('uses the trigram index for the paginated list filter too', async () => {
    const captured: Array<{ text: string; values?: unknown[] }> = []
    const instrumentedPool = {
      query(text: string, values?: unknown[]) {
        captured.push({ text, values })
        return pool.query(text, values as never)
      },
    } as unknown as Pool
    await new TechnologyRepository(instrumentedPool).list('__scale_reader__', {
      q: 'needle framework',
      limit: 50,
    })
    // A searched page sorts by relevance rank first; an unfiltered one still
    // sorts by name, which is what the facet test below matches on.
    const listQuery = captured.find(({ text }) => text.includes('ORDER BY r.match_rank'))
    expect(listQuery).toBeDefined()

    const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${listQuery!.text}`,
      listQuery!.values as never
    )
    const plan = JSON.stringify(rows[0]?.['QUERY PLAN'])
    expect(plan).toContain('idx_technology_revisions_search_document_trgm')
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]+"Relation Name":"technology_revisions"/)
  })

  it('keeps category, shape and role facets indexed and cursor-bounded at 50k', async () => {
    const captured: Array<{ text: string; values?: unknown[] }> = []
    const instrumentedPool = {
      query(text: string, values?: unknown[]) {
        captured.push({ text, values })
        return pool.query(text, values as never)
      },
    } as unknown as Pool
    const page = await new TechnologyRepository(instrumentedPool).list('__scale_reader__', {
      category: 'Database', shapeType: 'store', role: 'database', limit: 5_000,
    })
    expect(page.technologies).toHaveLength(50)
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(page.technologies.every((technology) =>
      technology.revision.category === 'Database'
      && technology.revision.recommendedShapeTypes.includes('store')
      && technology.revision.defaultRole === 'database'
    )).toBe(true)

    const listQuery = captured.find(({ text }) => text.includes('ORDER BY r.normalized_name'))
    expect(listQuery).toBeDefined()
    const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${listQuery!.text}`,
      listQuery!.values as never,
    )
    const plan = JSON.stringify(rows[0]?.['QUERY PLAN'])
    expect(plan).toMatch(/idx_technology_revisions_(category|default_role|recommended_shapes)/)
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]+"Relation Name":"technology_revisions"/)
  })
})
