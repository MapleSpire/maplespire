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

/**
 * `list()` is what the technology picker calls, so it must rank by relevance:
 * alphabetical order on the real seeded catalog puts PostgreSQL at row 26 of 31
 * for "post", behind five managed-Postgres SKUs whose names merely CONTAIN the
 * word.
 *
 * These pin the order, and the paging that has to survive it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { ensureAuthSchema } from '../auth/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { TechnologyRepository } from './repository.js'
import { ensureTechnologySchema } from './schema.js'

const connectionString = process.env.TEST_DATABASE_URL
const ORG = '__ranking_reader__'

/** name, aliases — normalized forms are derived the way the catalog does it. */
const CATALOG: Array<[string, string[]]> = [
  ['Postman', []],
  ['PostgreSQL', []],
  ['PostgreSQL Flexible Server', []],
  ['AlloyDB for PostgreSQL', []],
  ['Amazon RDS for PostgreSQL', []],
  ['Relay', ['post', 'zookeeper-proxy']],
  ['Zookeeper', []],
]

describe.skipIf(!connectionString)('technology list ranking', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  let repository: TechnologyRepository

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_search_ranking')
    pool = db.pool
    await ensureAuthSchema(pool)
    await ensureTechnologySchema(pool)

    for (const [index, [name, aliases]] of CATALOG.entries()) {
      const id = `tech_rank_${String(index).padStart(2, '0')}`
      await pool.query(
        `INSERT INTO technology_identities
           (id, scope, lifecycle_status, latest_revision, current_revision, created_by)
         VALUES ($1, 'public', 'active', 1, 1, 'ranking-test')`,
        [id],
      )
      await pool.query(
        `INSERT INTO technology_revisions
           (technology_id, revision, name, normalized_name, aliases, normalized_aliases,
            category, recommended_shape_types, default_role, search_document, created_by)
         VALUES ($1, 1, $2, $3, $4::text[], $5::text[], 'General technology',
                 ARRAY['system','app','store','component','group']::text[], 'other', $6, 'ranking-test')`,
        [
          id, name, name.toLowerCase(), aliases, aliases.map((a) => a.toLowerCase()),
          `${name.toLowerCase()} ${aliases.join(' ').toLowerCase()}`.trim(),
        ],
      )
      await pool.query(
        `INSERT INTO technology_revision_workflows
           (technology_id, revision, status, decided_by, decided_at)
         VALUES ($1, 1, 'approved', 'ranking-test', now())`,
        [id],
      )
    }
    repository = new TechnologyRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await db?.teardown()
  })

  const names = async (q: string, limit = 50) =>
    (await repository.list(ORG, { q, limit })).technologies.map((technology) => technology.revision.name)

  it('puts a name that STARTS with the term above every name that merely contains it', async () => {
    const ordered = await names('post')

    // The defect, in one assertion: alphabetically "AlloyDB for PostgreSQL"
    // and "Amazon RDS for PostgreSQL" sort first.
    expect(ordered.indexOf('PostgreSQL')).toBeLessThan(ordered.indexOf('AlloyDB for PostgreSQL'))
    expect(ordered.indexOf('PostgreSQL')).toBeLessThan(ordered.indexOf('Amazon RDS for PostgreSQL'))
  })

  it('ranks exact alias above a prefix, and a prefix above a contains', async () => {
    expect(await names('post')).toEqual([
      // 'post' is an exact ALIAS of Relay.
      'Relay',
      // Then the prefixes, alphabetically.
      'PostgreSQL',
      'PostgreSQL Flexible Server',
      'Postman',
      // Then the ones that only contain it, alphabetically.
      'AlloyDB for PostgreSQL',
      'Amazon RDS for PostgreSQL',
    ])
  })

  it('puts an exact name first of all', async () => {
    const ordered = await names('postgresql')
    expect(ordered[0]).toBe('PostgreSQL')
  })

  // A shorter-name-first tie-break was tried and measured worse on the running
  // catalog: 'kub' put Kuberun and Kubecost above Kubernetes. Ties stay
  // alphabetical, and the RANK is what does the work.
  it('keeps ties inside a rank alphabetical', async () => {
    const ordered = await names('postgresql')
    expect(ordered.indexOf('PostgreSQL Flexible Server'))
      .toBeLessThan(ordered.indexOf('AlloyDB for PostgreSQL'))
  })

  it('leaves an unfiltered browse alphabetical', async () => {
    const ordered = (await repository.list(ORG, { limit: 50 })).technologies
      .map((technology) => technology.revision.name)
    expect(ordered).toEqual([...ordered].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
  })

  /**
   * The keyset has to lead with the same column the sort leads with. A ranked
   * page paged by a name-only cursor repeats rows it already showed and skips
   * ones it never did — and only ever on page 2, where nobody looks.
   */
  it('pages a ranked result without repeating or skipping a row', async () => {
    const all = await names('post')
    const paged: string[] = []
    let after: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await repository.list(ORG, { q: 'post', limit: 2, after })
      paged.push(...page.technologies.map((technology) => technology.revision.name))
      if (!page.nextCursor) break
      after = page.nextCursor
    }
    expect(paged).toEqual(all)
  })

/**
   * A cursor belongs to the query that minted it. Both of these produced a
   * WRONG ANSWER rather than an error before the guard: a rank-less browse
   * cursor replayed with a query eliminated every row and reported "no
   * results" for a query with matches, and a cursor from a different query
   * paged against a rank it was never ordered by.
   */
  it('refuses a browse cursor replayed with a search', async () => {
    const browse = await repository.list(ORG, { limit: 2 })
    expect(browse.nextCursor).toEqual(expect.any(String))

    await expect(repository.list(ORG, { q: 'post', limit: 5, after: browse.nextCursor! }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  it('refuses a cursor minted under a different query', async () => {
    const first = await repository.list(ORG, { q: 'postgresql', limit: 1 })
    expect(first.nextCursor).toEqual(expect.any(String))

    await expect(repository.list(ORG, { q: 'post', limit: 5, after: first.nextCursor! }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  it('refuses a search cursor replayed as a browse', async () => {
    const searched = await repository.list(ORG, { q: 'post', limit: 2 })
    expect(searched.nextCursor).toEqual(expect.any(String))

    await expect(repository.list(ORG, { limit: 5, after: searched.nextCursor! }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  // A fractional or oversized rank reaches `$n::int` and comes back as a pg
  // 22P02/22003, which the route maps to a 500 rather than the 400 the cursor
  // decoder exists to produce.
  it('rejects a crafted cursor rank as a bad request, not a server error', async () => {
    const crafted = (rank: unknown) => Buffer
      .from(JSON.stringify({ name: 'a', id: 'b', rank, q: 'post' }))
      .toString('base64url')

    for (const rank of [1.5, 1e30, 2 ** 40, 'two']) {
      await expect(repository.list(ORG, { q: 'post', limit: 5, after: crafted(rank) }))
        .rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
    }
  })

  // Without a row that matches only through an ALIAS PREFIX, swapping ranks 2
  // and 3 changes nothing anywhere and the tier is untested.
  it('ranks a name prefix above an alias prefix', async () => {
    const ordered = await names('zoo')
    expect(ordered).toEqual([
      // 'Zookeeper' starts with it.
      'Zookeeper',
      // 'Relay' reaches it only through the alias 'zookeeper-proxy'.
      'Relay',
    ])
  })
  it('pages an unfiltered browse the same way', async () => {
    const all = (await repository.list(ORG, { limit: 50 })).technologies
      .map((technology) => technology.revision.name)
    const paged: string[] = []
    let after: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await repository.list(ORG, { limit: 3, after })
      paged.push(...page.technologies.map((technology) => technology.revision.name))
      if (!page.nextCursor) break
      after = page.nextCursor
    }
    expect(paged).toEqual(all)
  })
})
