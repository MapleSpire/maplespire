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
 * G4-16f P3p: a cold build merges the GIN pending lists ONCE, at its end,
 * inside its transaction, instead of every 4 MB (the server's
 * `gin_pending_list_limit`) as it inserts.
 *
 *  1. DURING the build the lists grow past the server's limit: a probe
 *     merge (`gin_clean_pending_list`, which returns the pending pages it
 *     merged) in the build's transaction finds more pages than a 4 MB list
 *     can hold — with the server's limit the inserts would have merged them.
 *  2. AT ITS END nothing is pending on any GIN index of a table it wrote, and
 *     the session's limit is the caller's again (`SET LOCAL` restored): a
 *     reader never scans an unmerged list, the incremental paths keep the
 *     server's limit.
 *  3. ONLY ALONE: with another workspace's rows in `ro_objects` (either side
 *     of the key), the limit is not raised and the inserts merge as before —
 *     another workspace's writer would otherwise pay the whole merge
 *     (`COLD_BUILD_GIN_PENDING_LIST_LIMIT` has the measurement).
 *  4. TWO cold builds of two workspaces at once on the SHARED tables, with an
 *     incremental write of a third workspace between them: all commit, each
 *     workspace's rows are its own and complete, nothing large is pending after.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { COLD_BUILD_GIN_PENDING_LIST_LIMIT, coldBuildReadModel, upsertObjects } from './projector.js'
import { roSearch } from './queries.js'
import { ensureReadModelSchema } from './schema.js'
import type { ConnectionInput, DiagramInput, ObjectInput, Queryable } from './types.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const suite = CONNECTION ? describe : describe.skip

/** 8 KB GIN pages; the server default limit is 4 MB = 512 pages. */
const DEFAULT_LIMIT_PAGES = (4 * 1024) / 8

/** `count` objects with ~300 characters of distinct words each: well over
 *  4 MB of trigram entries per GIN index of `ro_objects`. */
function corpus(prefix: string, count: number): ObjectInput[] {
  const syllables = ['ka', 'lo', 'mi', 'ne', 'po', 'ru', 'sa', 'ti', 'vo', 'ze', 'bra', 'cle', 'dri', 'fro', 'glu', 'pla', 'qua', 'sto']
  const word = (n: number, k: number) => [0, 1, 2].map((j) => syllables[(n * 31 + k * 7 + j * 13 + (n >> j)) % syllables.length]).join('') + String((n * k) % 997)
  return Array.from({ length: count }, (_, n) => ({
    id: `${prefix}-${n}`, type: 'component',
    name: `${word(n, 1)} ${word(n, 2)} ${word(n, 3)}`,
    description: Array.from({ length: 30 }, (_, k) => word(n, k + 4)).join(' '),
    technology: word(n, 40),
  }))
}

/** Two connections per object, with long labels (`idx_ro_conn_label_trgm`). */
function links(objects: readonly ObjectInput[]): ConnectionInput[] {
  return objects.flatMap((object, n) => [1, 7].map((step) => ({
    id: `${object.id}-l${step}`, fromId: object.id, toId: objects[(n + step) % objects.length]!.id,
    label: `${object.name} vers ${objects[(n + step) % objects.length]!.name} ${String(object.description).slice(0, 60)}`,
  })))
}

/** Diagrams of 150 objects each, every object in several (`idx_ro_diagrams_objects`). */
function diagramsOver(objects: readonly ObjectInput[]): DiagramInput[] {
  return Array.from({ length: 120 }, (_, d) => ({
    id: `d-${objects[0]!.id}-${d}`, name: `diagramme ${d}`,
    objectIds: Array.from({ length: 150 }, (_, k) => objects[(d * 37 + k * 11) % objects.length]!.id),
  }))
}

suite('cold build: GIN pending lists merged once, at the end (P3p)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(CONNECTION!, 'ro_gin_pending')
    await ensureReadModelSchema(db.pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  /** Every GIN index of an `ro_*` table, merged now; the pages each had pending. */
  const mergeAll = async (client: pg.PoolClient | pg.Pool) => (await client.query<{ index: string; pages: string }>(
    `SELECT i.relname AS index, gin_clean_pending_list(x.indexrelid::regclass) AS pages
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_am am ON am.oid = i.relam
      WHERE am.amname = 'gin' AND t.relname LIKE 'ro\\_%' AND t.relnamespace = current_schema()::regnamespace
      ORDER BY 1`,
  )).rows.map((row) => ({ index: row.index, pages: Number(row.pages) }))

  const withTransaction = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('ROLLBACK')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** `client`, probed once during the build: at its ANALYZE (after every
   * insert, before the end-of-build merge), the session's limit and every
   * GIN index's pending pages, merged by the probe. */
  const probedAtAnalyze = (client: pg.PoolClient, builderRole?: string) => {
    const seen: { limit?: string; pending?: Array<{ index: string; pages: number }>; texts: string[] } = { texts: [] }
    const wrapper: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        seen.texts.push(text)
        if (!seen.pending && /^\s*ANALYZE\b/.test(text)) {
          seen.limit = (await client.query<{ v: string }>(`SELECT current_setting('gin_pending_list_limit') AS v`)).rows[0]!.v
          // The probe's merge needs the indexes' owner, which a builder role is not.
          if (builderRole) await client.query('RESET ROLE')
          seen.pending = await mergeAll(client)
          if (builderRole) await client.query(`SET LOCAL ROLE ${builderRole}`)
        }
        return client.query(text, values)
      }) as Queryable['query'],
    }
    return { wrapper, seen }
  }

  it('lets the lists grow past the server limit during the build', async () => {
    // Pinned: the value the measurements were taken with.
    expect(COLD_BUILD_GIN_PENDING_LIST_LIMIT).toBe('256MB')
    await mergeAll(db.pool)
    const pending = await withTransaction(async (client) => {
      expect((await client.query<{ v: string }>(`SELECT current_setting('gin_pending_list_limit') AS v`)).rows[0]!.v).toBe('4MB')
      const probe = probedAtAnalyze(client)
      const objects = corpus('a', 3000)
      await coldBuildReadModel(probe.wrapper, { landscapeId: 'ls-gin-a', versionId: 'v1' }, null, objects, links(objects), [], diagramsOver(objects))
      expect(probe.seen.limit).toBe('256MB')
      return probe.seen.pending!
    })
    const pagesOf = (index: string) => pending.find((entry) => entry.index === index)!.pages
    expect(pagesOf('idx_ro_objects_spot_trgm'), JSON.stringify(pending)).toBeGreaterThan(2 * DEFAULT_LIMIT_PAGES)
    expect(pagesOf('idx_ro_objects_name_trgm'), JSON.stringify(pending)).toBeGreaterThan(0)
    // The search_document index (kept) is the largest list of all.
    expect(pagesOf('idx_ro_objects_search_trgm'), JSON.stringify(pending)).toBeGreaterThan(2 * DEFAULT_LIMIT_PAGES)
    // Not only ro_objects: the connections' and the
    // diagrams' GIN lists grew too, so the final merge has them to merge.
    expect(pagesOf('idx_ro_conn_label_trgm'), JSON.stringify(pending)).toBeGreaterThan(0)
    expect(pagesOf('idx_ro_diagrams_objects'), JSON.stringify(pending)).toBeGreaterThan(0)
  })

  it('leaves nothing pending and restores the limit at its end, in the caller\'s transaction', async () => {
    await mergeAll(db.pool)
    await withTransaction(async (client) => {
      await client.query(`SET LOCAL gin_pending_list_limit = '2MB'`)
      const objects = corpus('b', 3000)
      await coldBuildReadModel(client, { landscapeId: 'ls-gin-b', versionId: 'v1' }, null, objects, links(objects), [], diagramsOver(objects))
      expect((await client.query<{ v: string }>(`SELECT current_setting('gin_pending_list_limit') AS v`)).rows[0]!.v).toBe('2MB')
      const left = await mergeAll(client)
      expect(left.length).toBeGreaterThanOrEqual(5)
      // Every GIN index of every table written, connections and diagrams
      // included, is empty.
      expect(left.map((entry) => entry.index)).toEqual(expect.arrayContaining([
        'idx_ro_objects_spot_trgm', 'idx_ro_objects_name_trgm', 'idx_ro_objects_search_trgm', 'idx_ro_conn_label_trgm', 'idx_ro_diagrams_objects',
      ]))
      expect(left.filter((entry) => entry.pages > 0), JSON.stringify(left)).toEqual([])
      // And the merged index serves its search.
      const hits = await roSearch(client, { landscapeId: 'ls-gin-b', versionId: 'v1' }, corpus('b', 1)[0]!.name.split(' ')[1]!)
      expect(hits.length).toBeGreaterThan(0)
    })
  })

  it('does NOT defer when another workspace has rows: its writers would pay the merge', async () => {
    await mergeAll(db.pool)
    await withTransaction(async (client) => {
      // Either side of the built key in the primary key's order: both probes.
      // Other landscapes, AND other versions of the SAME landscape: a guard that compared landscape_id alone would call v0 and
      // v9 "this workspace" and defer.
      for (const other of [
        { landscapeId: 'ls-gin-0-before', versionId: 'v1' }, { landscapeId: 'ls-gin-z-after', versionId: 'v1' },
        { landscapeId: 'ls-gin-m', versionId: 'v0' }, { landscapeId: 'ls-gin-m', versionId: 'v9' },
      ]) {
        const label = `${other.landscapeId}/${other.versionId}`
        await client.query('SAVEPOINT other')
        await coldBuildReadModel(client, other, null, corpus('o', 1), [])
        const timings: Record<string, number> = {}
        const probe = probedAtAnalyze(client)
        await coldBuildReadModel(probe.wrapper, { landscapeId: 'ls-gin-m', versionId: 'v1' }, null, corpus('m', 3000), [], [], [], { timings })
        expect(probe.seen.limit, label).toBe('4MB')
        // The inserts merged as they went: at most one limit's worth is left.
        for (const entry of probe.seen.pending!) expect(entry.pages, `${label} ${entry.index}`).toBeLessThanOrEqual(DEFAULT_LIMIT_PAGES + 8)
        expect(timings.ginPendingDeferred).toBeUndefined()
        expect(timings.ginPendingMergeMs).toBeUndefined()
        // And no end-of-build merge ran: a refused guard
        // leaves the lists to the server's ordinary behaviour.
        expect(probe.seen.texts.filter((text) => /gin_clean_pending_list|gin_pending_list_limit/.test(text)), label).toEqual([])
        await client.query('ROLLBACK TO SAVEPOINT other')
      }
    })
  })

  it('does NOT defer when this role does not own the GIN indexes (the final merge could not clean them)', async () => {
    await mergeAll(db.pool)
    await withTransaction(async (client) => {
      // Rolled back with the transaction: the role never exists outside it.
      const role = `gin_builder_${process.pid}_${Date.now() % 100_000}`
      await client.query(`CREATE ROLE ${role} NOLOGIN`)
      await client.query(`GRANT USAGE ON SCHEMA ${db.schema} TO ${role}`)
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${db.schema} TO ${role}`)
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${db.schema} TO ${role}`)
      await client.query(`SET LOCAL ROLE ${role}`)
      const timings: Record<string, number> = {}
      const probe = probedAtAnalyze(client, role)
      await coldBuildReadModel(probe.wrapper, { landscapeId: 'ls-gin-r', versionId: 'v1' }, null, corpus('r', 3000), [], [], [], { timings })
      expect(probe.seen.limit).toBe('4MB')
      expect(timings.ginPendingDeferred).toBeUndefined()
      expect(probe.seen.pending!.length).toBeGreaterThanOrEqual(5)
      for (const entry of probe.seen.pending!) expect(entry.pages, entry.index).toBeLessThanOrEqual(DEFAULT_LIMIT_PAGES + 8)
      await client.query('RESET ROLE')
    })
  })

  it('a build through the POOL commits with the connection\'s limit back to the server\'s (SET LOCAL, not SET)', async () => {
    // One connection, so the connection the build committed on is the one read.
    const single = guardIdleClientErrors(
      new pg.Pool({ connectionString: CONNECTION!, max: 1, options: `-c search_path=${db.schema}` }), 'coldBuildGinPending:single')
    try {
      const timings: Record<string, number> = {}
      await coldBuildReadModel(single, { landscapeId: 'ls-gin-p', versionId: 'v1' }, null, corpus('p', 500), [], [], [], { timings })
      expect(timings.ginPendingDeferred).toBe(1)
      expect((await single.query<{ v: string }>(`SELECT current_setting('gin_pending_list_limit') AS v`)).rows[0]!.v).toBe('4MB')
    } finally {
      await single.end()
    }
  })

  it('two workspaces cold-built at once on the shared tables, with an incremental write between them', async () => {
    await mergeAll(db.pool)
    const keys = [{ landscapeId: 'ls-gin-c1', versionId: 'v1' }, { landscapeId: 'ls-gin-c2', versionId: 'v1' }]
    const third = { landscapeId: 'ls-gin-c3', versionId: 'v1' }
    await coldBuildReadModel(db.pool, third, null, corpus('c3', 50), [])
    const incremental = (async () => {
      for (let n = 0; n < 20; n++) {
        await upsertObjects(db.pool, third, null, [{ id: `c3-${n}`, type: 'app', name: `edited ${n} kalomi`, description: 'x' }])
      }
    })()
    await Promise.all([
      ...keys.map((key, k) => coldBuildReadModel(db.pool, key, null, corpus(`c${k + 1}`, 2500), [])),
      incremental,
    ])
    for (const [k, key] of keys.entries()) {
      const { rows } = await db.pool.query<{ n: number; foreign: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE id NOT LIKE $3)::int AS foreign
           FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`,
        [key.landscapeId, key.versionId, `c${k + 1}-%`],
      )
      expect(rows[0]).toEqual({ n: 2500, foreign: 0 })
    }
    const { rows: edited } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND name LIKE 'edited %'`, [third.landscapeId],
    )
    expect(edited[0]!.n).toBe(20)
    // The incremental writes kept the server's limit, so what they left
    // pending is at most one limit's worth; the cold builds left nothing.
    const left = await mergeAll(db.pool)
    for (const entry of left) expect(entry.pages, entry.index).toBeLessThanOrEqual(DEFAULT_LIMIT_PAGES + 8)
  })
})
