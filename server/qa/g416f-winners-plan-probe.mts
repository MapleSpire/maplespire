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
 * The sealed-winners statement under STALE and FRESH statistics: the C5
 * text (`PREVIOUS_SQL`, the statement `readSealedWinners` ran before) against
 * `SEALED_WINNERS_SQL`.
 *
 *   cd server
 *   DATABASE_URL=postgres://user:pass@127.0.0.1:5821/db npx tsx qa/g416f-winners-plan-probe.mts <out.json> [--products 97] [--per 1139] [--ids 28631] [--timeout-ms 120000]
 *
 * A private schema (`g416f_winners_probe`, dropped on entry AND exit), both
 * sealed tables with `autovacuum_enabled = false`. A SYNTHETIC corpus at the
 * diagnosed size: `products` headers of `per` entities each, product p
 * holding ids (p * floor(ids / products) + k) mod ids, so each id is held by
 * about four products. Written under key A, ANALYZEd, then moved to key B
 * (the re-key shape: the statistics know A only). List: even products in
 * order, odd ones reversed, product 3 listed again at the end.
 *
 *  1. `stale`: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of both statements,
 *     values false and true, each under `statement_timeout` (`--timeout-ms`;
 *     a cancel is recorded as such, SQLSTATE 57014), with the planner's row
 *     estimate for key B beside it and the quadratic plan shapes found (the
 *     same predicate as `sealedWinnersPlan.integration.test.ts`).
 *  2. `fresh`: ANALYZE both tables, the same four runs.
 *  3. `equivalence`: under fresh statistics, the row multisets of the two
 *     statements, values false and true.
 *
 * One sample per arm: the stale arm differs by orders of magnitude, and the
 * fresh arm is recorded as an order of magnitude, not a ranking.
 */

import { writeFileSync } from 'node:fs'
import pg from 'pg'

import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { SEALED_WINNERS_SQL, sealedWinnersParams } from '../src/readModel/sealedWinners.js'
import { SEALED_WINNERS_C5_SQL } from '../src/testing/sealedWinnersC5.js'
import { SEALED_PRODUCT_EXTRACTION_VERSION } from '../src/readModel/sealedProductCache.js'

const SCHEMA = 'g416f_winners_probe'
const ENTITIES = 'read_model_sealed_product_entities'
const A = { landscapeId: 'probe-a', versionId: 'v1' }
const B = { landscapeId: 'probe-b', versionId: 'v1' }

/** The C5 statement, verbatim from the earlier `readSealedWinners`. */
const PREVIOUS_SQL = SEALED_WINNERS_C5_SQL

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 ? Number(process.argv[at + 1]) : fallback
}
const OUT = process.argv[2]
if (!OUT || OUT.startsWith('--')) {
  throw new Error('usage: g416f-winners-plan-probe.mts <out.json> [--products N] [--per N] [--ids N] [--timeout-ms N]')
}
const PRODUCTS = arg('products', 97)
const PER = arg('per', 1139)
const IDS = arg('ids', 28_631)
const TIMEOUT_MS = arg('timeout-ms', 120_000)
const STRIDE = Math.floor(IDS / PRODUCTS)
if (PER > IDS) throw new Error('--per must not exceed --ids (one product holds an id once)')

type PlanNode = {
  'Node Type': string
  'Parent Relationship'?: string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  'Join Filter'?: string
  'Actual Loops'?: number
  'Actual Rows'?: number
  'Rows Removed by Join Filter'?: number
  Plans?: PlanNode[]
}
function* walk(node: PlanNode): Generator<PlanNode> {
  yield node
  for (const child of node.Plans ?? []) yield* walk(child)
}
/** As `quadraticShapes` in sealedWinnersPlan.integration.test.ts. */
function quadraticShapes(root: PlanNode): string[] {
  const found: string[] = []
  for (const node of walk(root)) {
    if (node['Node Type'] !== 'Nested Loop') continue
    if (/entity_id/.test(node['Join Filter'] ?? '')) {
      found.push(`Nested Loop Join Filter ${node['Join Filter']} (removed ${node['Rows Removed by Join Filter'] ?? '?'})`)
    }
    const inner = node.Plans?.find((child) => child['Parent Relationship'] === 'Inner')
    if (!inner) continue
    for (const scan of walk(inner)) {
      if (scan['Relation Name'] !== ENTITIES) continue
      const bound = scan['Index Cond'] ?? scan['Recheck Cond'] ?? ''
      if (!/product_document_id|entity_id/.test(bound)) {
        found.push(`Nested Loop inner ${scan['Node Type']} ${scan['Index Name'] ?? ''} (loops ${scan['Actual Loops'] ?? '?'})`)
      }
    }
  }
  return found
}

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: `-c search_path=${SCHEMA}` })
const runs: Array<Record<string, unknown>> = []
try {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await ensureReadModelSchema(pool)
  await pool.query(`ALTER TABLE read_model_sealed_product_extracts SET (autovacuum_enabled = false)`)
  await pool.query(`ALTER TABLE ${ENTITIES} SET (autovacuum_enabled = false)`)
  await pool.query(
    `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
       rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
     SELECT $1, $2, 'object', 'P' || lpad(p::text, 4, '0'), 'd-' || p, ARRAY['h'], 1, $3, $4, NULL
       FROM generate_series(0, $5 - 1) AS p`,
    [A.landscapeId, A.versionId, SEALED_PRODUCT_EXTRACTION_VERSION, PER, PRODUCTS],
  )
  await pool.query(
    `INSERT INTO ${ENTITIES} (landscape_id, version_id, collection, product_document_id, entity_id, value)
     SELECT $1, $2, 'object', 'P' || lpad(p::text, 4, '0'), 'e' || ((p * $3 + k) % $6),
            jsonb_build_object('id', 'e' || ((p * $3 + k) % $6), 'name', 'n' || p || ':' || k, 'pad', repeat('x', 200))
       FROM generate_series(0, $4 - 1) AS p, generate_series(0, $5 - 1) AS k`,
    [A.landscapeId, A.versionId, STRIDE, PRODUCTS, PER, IDS],
  )
  await pool.query(`ANALYZE read_model_sealed_product_extracts`)
  await pool.query(`ANALYZE ${ENTITIES}`)
  await pool.query(
    `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
       rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
     SELECT $3, $4, collection, product_document_id, rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason
       FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2`,
    [A.landscapeId, A.versionId, B.landscapeId, B.versionId],
  )
  await pool.query(`UPDATE ${ENTITIES} SET landscape_id = $3, version_id = $4 WHERE landscape_id = $1 AND version_id = $2`,
    [A.landscapeId, A.versionId, B.landscapeId, B.versionId])
  await pool.query(`DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2`, [A.landscapeId, A.versionId])
  const { rows: [corpus] } = await pool.query<{ rows: number; ids: number }>(
    `SELECT count(*)::int AS rows, count(DISTINCT entity_id)::int AS ids FROM ${ENTITIES} WHERE landscape_id = $1`, [B.landscapeId])
  const served = Array.from({ length: PRODUCTS }, (_, p) => {
    const documentId = `P${String(p).padStart(4, '0')}`
    return { url: `automerge:${documentId}`, documentId, rowsDigest: `d-${p}`, entityCount: PER }
  })
  const list = [...served.filter((_, p) => p % 2 === 0), ...served.filter((_, p) => p % 2 === 1).reverse(), served[3]!]
    .map((candidate) => candidate.url)
  const params = (values: boolean) => sealedWinnersParams(B, 'object', list, served, { values })

  const measure = async (statistics: 'stale' | 'fresh') => {
    for (const [statement, sql] of [['previous', PREVIOUS_SQL], ['rewrite', SEALED_WINNERS_SQL]] as const) {
      for (const values of [false, true]) {
        const client = await pool.connect()
        try {
          await client.query(`SET statement_timeout = ${Math.trunc(TIMEOUT_MS)}`)
          const { rows: [estimate] } = await client.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
            `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${ENTITIES} WHERE landscape_id = $1 AND version_id = $2`, [B.landscapeId, B.versionId])
          const base = { statistics, statement, values, estimatedWorkspaceRows: estimate!['QUERY PLAN'][0]!.Plan['Plan Rows'] }
          const startedAt = performance.now()
          try {
            const { rows: [explained] } = await client.query<{
              'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number; 'Planning Time': number }>
            }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params(values))
            const top = explained!['QUERY PLAN'][0]!
            runs.push({ ...base, executionMs: top['Execution Time'], planningMs: top['Planning Time'],
              rows: top.Plan['Actual Rows'], quadraticShapes: quadraticShapes(top.Plan) })
          } catch (error) {
            const code = (error as { code?: string }).code
            if (code !== '57014') throw error
            runs.push({ ...base, cancelledAfterMs: Math.round(performance.now() - startedAt), sqlstate: code })
          }
        } finally {
          client.release()
        }
        console.log(JSON.stringify(runs.at(-1)))
      }
    }
  }
  await measure('stale')
  await pool.query(`ANALYZE read_model_sealed_product_extracts`)
  await pool.query(`ANALYZE ${ENTITIES}`)
  await measure('fresh')

  const equivalence: Record<string, unknown> = {}
  for (const values of [false, true]) {
    const canonical = async (sql: string) => (await pool.query(sql, params(values))).rows
      .map((row) => JSON.stringify([row.row_kind, row.url, row.entity_id, row.plain, row.inner_id, row.value])).sort()
    const previous = await canonical(PREVIOUS_SQL)
    const rewrite = await canonical(SEALED_WINNERS_SQL)
    equivalence[`values=${values}`] = {
      previousRows: previous.length, rewriteRows: rewrite.length,
      identical: previous.length === rewrite.length && previous.every((row, at) => row === rewrite[at]),
    }
  }
  const { rows: [server] } = await pool.query<{ server_version: string }>('SHOW server_version')
  const result = {
    server: server!.server_version,
    corpus: { products: PRODUCTS, perProduct: PER, idSpace: IDS, entityRows: corpus!.rows, distinctIds: corpus!.ids },
    timeoutMs: TIMEOUT_MS, runs, equivalence,
  }
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(equivalence))
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
  await pool.end()
  await admin.end()
}
