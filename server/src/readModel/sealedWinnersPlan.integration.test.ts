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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import type { WorkspaceKey } from './projector.js'
import { SealedWinnerIndex, sealedRankIn } from './sealedWinnerIndex.js'
import {
  SEALED_WINNERS_SQL, readSealedWinners, sealedWinnersParams, type SealedWinnerCandidate,
} from './sealedWinners.js'
import { SEALED_PRODUCT_EXTRACTION_VERSION } from './sealedProductCache.js'
import { SEALED_WINNERS_C5_SQL, sealedWinnersWithoutOffsetFence } from '../testing/sealedWinnersC5.js'

/**
 * G4-16f: the PLAN of the sealed-winners statement under STALE statistics.
 *
 * Measured on a production-like machine:
 * when the planner's statistics do not know the workspace key (a re-keyed
 * or new workspace, or a large extract-cache write followed by a restart
 * inside the autovacuum window), it estimates ~1 row per CTE and joined
 * `win` back to `read_model_sealed_product_entities` by a Nested Loop whose
 * inner index scan was bounded by (landscape, version, collection) only,
 * the product and entity ids in a Join Filter: every winner rescanned every
 * entity row of the workspace. An adopted boot's B2 took 504 s.
 *
 * The fixture builds that state deterministically — autovacuum off on both
 * tables, ANALYZE under key A, every row moved to key B — and asserts on the
 * shape of `EXPLAIN (FORMAT JSON)`, never on a duration. Then it runs the
 * statement under those same statistics and compares it with the in-memory
 * index (the semantic oracle of `sealedWinners.integration.test.ts`).
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const A: WorkspaceKey = { landscapeId: 'ls-plan-a', versionId: 'v1' }
const B: WorkspaceKey = { landscapeId: 'ls-plan-b', versionId: 'v1' }
const PRODUCTS = 40
const PER_PRODUCT = 500
/** Product p holds ids p*250 .. p*250+499: each id held by two products. */
const STRIDE = 250
const ENTITIES = 'read_model_sealed_product_entities'

let db: IsolatedSchemaDb

type PlanNode = {
  'Node Type': string
  'Parent Relationship'?: string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  'Join Filter'?: string
  Plans?: PlanNode[]
}

function* walk(node: PlanNode): Generator<PlanNode> {
  yield node
  for (const child of node.Plans ?? []) yield* walk(child)
}

/**
 * The quadratic shapes, as text naming each: a Nested Loop that matches an
 * entity id through a Join Filter (rows compared pairwise, not looked up),
 * and a Nested Loop whose INNER side scans the entities table bounded by
 * neither a product nor an entity id (the whole workspace per outer row).
 */
function quadraticShapes(root: PlanNode): string[] {
  const found: string[] = []
  for (const node of walk(root)) {
    if (node['Node Type'] !== 'Nested Loop') continue
    if (/entity_id/.test(node['Join Filter'] ?? '')) found.push(`Nested Loop Join Filter: ${node['Join Filter']}`)
    const inner = node.Plans?.find((child) => child['Parent Relationship'] === 'Inner')
    if (!inner) continue
    for (const scan of walk(inner)) {
      if (scan['Relation Name'] !== ENTITIES) continue
      const bound = scan['Index Cond'] ?? scan['Recheck Cond'] ?? ''
      if (!/product_document_id|entity_id/.test(bound)) {
        found.push(`Nested Loop inner ${scan['Node Type']} on ${ENTITIES} (${scan['Index Name'] ?? 'no index'}) bounded by: ${bound || 'nothing'}`)
      }
    }
  }
  return found
}

const urlOf = (product: number) => `automerge:PLAN${String(product).padStart(3, '0')}`

suite('G4-16f — the winners statement keeps a linear plan under stale statistics (real PostgreSQL)', () => {
  let candidates: SealedWinnerCandidate[]
  let list: string[]

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'sealed_winners_plan')
    await ensureReadModelSchema(db.pool)
    // Nothing may refresh the statistics behind the test's back.
    await db.pool.query(`ALTER TABLE read_model_sealed_product_extracts SET (autovacuum_enabled = false)`)
    await db.pool.query(`ALTER TABLE ${ENTITIES} SET (autovacuum_enabled = false)`)
    await db.pool.query(
      `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
         rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
       SELECT $1, $2, 'object', 'PLAN' || lpad(p::text, 3, '0'), 'd-' || p, ARRAY['h'], 1, $3, $4, NULL
         FROM generate_series(0, $5 - 1) AS p`,
      [A.landscapeId, A.versionId, SEALED_PRODUCT_EXTRACTION_VERSION, PER_PRODUCT, PRODUCTS],
    )
    await db.pool.query(
      `INSERT INTO ${ENTITIES} (landscape_id, version_id, collection, product_document_id, entity_id, value)
       SELECT $1, $2, 'object', 'PLAN' || lpad(p::text, 3, '0'), 'e' || (p * $3 + k),
              jsonb_build_object('id', 'e' || (p * $3 + k), 'v', p || ':' || k, 'pad', repeat('x', 64))
         FROM generate_series(0, $4 - 1) AS p, generate_series(0, $5 - 1) AS k`,
      [A.landscapeId, A.versionId, STRIDE, PRODUCTS, PER_PRODUCT],
    )
    await db.pool.query(`ANALYZE read_model_sealed_product_extracts`)
    await db.pool.query(`ANALYZE ${ENTITIES}`)
    // The re-key: the statistics still describe key A only. Headers first
    // (the entities' foreign key), then the entities, then A's headers.
    await db.pool.query(
      `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
         rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
       SELECT $3, $4, collection, product_document_id, rows_digest, heads, max_arrival_seq, extraction_version,
              entity_count, refused_reason
         FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2`,
      [A.landscapeId, A.versionId, B.landscapeId, B.versionId],
    )
    await db.pool.query(`UPDATE ${ENTITIES} SET landscape_id = $3, version_id = $4 WHERE landscape_id = $1 AND version_id = $2`,
      [A.landscapeId, A.versionId, B.landscapeId, B.versionId])
    await db.pool.query(`DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2`,
      [A.landscapeId, A.versionId])
    // Witness the stale state: the planner believes key B holds ~nothing.
    const { rows: [estimate] } = await db.pool.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM ${ENTITIES} WHERE landscape_id = $1 AND version_id = $2`,
      [B.landscapeId, B.versionId],
    )
    expect(estimate!['QUERY PLAN'][0]!.Plan['Plan Rows']).toBeLessThan(100)
    const { rows: [headerEstimate] } = await db.pool.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2`,
      [B.landscapeId, B.versionId],
    )
    expect(headerEstimate!['QUERY PLAN'][0]!.Plan['Plan Rows']).toBeLessThan(PRODUCTS / 4)
    const { rows: [actual] } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${ENTITIES} WHERE landscape_id = $1`, [B.landscapeId])
    expect(actual!.n).toBe(PRODUCTS * PER_PRODUCT)
    candidates = Array.from({ length: PRODUCTS }, (_, p) => ({
      url: urlOf(p), documentId: urlOf(p).slice('automerge:'.length), rowsDigest: `d-${p}`, entityCount: PER_PRODUCT,
    }))
    // List order differs from id order (every other product reversed) and
    // one product is listed twice, its last slot at the end.
    list = [...candidates.filter((_, p) => p % 2 === 0), ...candidates.filter((_, p) => p % 2 === 1).reverse(), candidates[4]!]
      .map((c) => c.url)
  }, 120_000)
  afterAll(async () => { await db?.teardown() })

  const explain = async (sql: string, values: boolean): Promise<PlanNode> => {
    const { rows: [explained] } = await db.pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
      sealedWinnersParams(B, 'object', list, candidates, { values }),
    )
    return explained!['QUERY PLAN'][0]!.Plan
  }

  for (const values of [false, true]) {
    it(`values: ${values} — EXPLAIN has no Nested Loop rescanning the entities or matching entity ids through a Join Filter`, async () => {
      const plan = await explain(SEALED_WINNERS_SQL, values)
      const scans = [...walk(plan)].filter((node) => node['Relation Name'] === ENTITIES)
      // The walker sees the entities table at all (a plan it cannot read
      // would pass every check): `found`'s read and the winners' lookup.
      expect(scans.length).toBeGreaterThanOrEqual(2)
      expect(quadraticShapes(plan)).toEqual([])
      // Only `found` reads the entities by product alone; every other scan
      // (the winner's lookup) is bounded by the entity id as well — a lookup
      // bounded by its product only would read the whole product per winner.
      const withoutEntityBound = scans.filter((scan) => !/entity_id/.test(scan['Index Cond'] ?? scan['Recheck Cond'] ?? ''))
      expect(withoutEntityBound).toHaveLength(1)
    })

    // RED controls: the fixture and the predicate must SEE the defect, or
    // the test above proves nothing on this PostgreSQL.
    it(`values: ${values} — control: the C5 statement and the rewrite without its OFFSET 0 fence are flagged under the same statistics`, async () => {
      for (const sql of [SEALED_WINNERS_C5_SQL, sealedWinnersWithoutOffsetFence()]) {
        const shapes = quadraticShapes(await explain(sql, values))
        // Both halves of the predicate see it: the ids in a Join Filter, and
        // the inner scan bounded by the workspace alone.
        expect(shapes.some((shape) => shape.startsWith('Nested Loop Join Filter'))).toBe(true)
        expect(shapes.some((shape) => shape.startsWith(`Nested Loop inner `))).toBe(true)
      }
    })
  }

  it('under those same statistics the winners equal the in-memory index (ids, values, first-insert slots)', async () => {
    const { rows } = await db.pool.query<{ product_document_id: string; entity_id: string; value: { id: string } }>(
      `SELECT product_document_id, entity_id, value FROM ${ENTITIES} WHERE landscape_id = $1`, [B.landscapeId])
    const full = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const url = `automerge:${row.product_document_id}`
      if (!full.has(url)) full.set(url, {})
      full.get(url)![row.entity_id] = row.value
    }
    const winners = await readSealedWinners(db.pool, B, 'object', list, candidates, { values: true })
    const idsOnly = await readSealedWinners(db.pool, B, 'object', list, candidates, { values: false })
    const index = new SealedWinnerIndex<unknown>()
    for (const c of candidates) index.add(c.url, Object.keys(full.get(c.url)!), sealedRankIn(list), new Map(), full.get(c.url)!)
    expect(winners.refused.size).toBe(0)
    let won = 0
    for (const c of candidates) {
      const expected = index.idsWonBy(c.url).sort()
      expect(winners.wonBy.get(c.url)).toEqual(expected)
      expect(idsOnly.wonBy.get(c.url)).toEqual(expected)
      for (const id of expected) expect(winners.values.get(id)).toEqual(index.pinnedValue(c.url, id))
      won += expected.length
    }
    expect(won).toBe((PRODUCTS - 1) * STRIDE + PER_PRODUCT)
    // The merge's first-insert slots: an id first held (in list order) by
    // a product other than its winner.
    const firstHolder = new Map<string, string>()
    for (const url of list) for (const id of Object.keys(full.get(url)!)) if (!firstHolder.has(id)) firstHolder.set(id, url)
    const expectedFirst = new Map<string, string[]>(candidates.map((c) => [c.url, []]))
    for (const [id, url] of firstHolder) if (!index.wins(url, id)) expectedFirst.get(url)!.push(id)
    let placeholders = 0
    for (const c of candidates) {
      expect(winners.firstHeldBy.get(c.url)).toEqual(expectedFirst.get(c.url)!.sort())
      placeholders += expectedFirst.get(c.url)!.length
    }
    expect(placeholders).toBeGreaterThan(0)
    expect(idsOnly.firstHeldBy.size).toBe(0)
  }, 120_000)
})
