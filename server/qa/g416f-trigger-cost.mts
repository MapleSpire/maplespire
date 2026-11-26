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
 * G4-16f — the cost of the adopt protocol triggers at AGED-CORPUS
 * scale (`schema.ts`, `ADOPT_PROTOCOL_*`; `adoptState.ts`).
 *
 *   cd server
 *   DATABASE_URL=postgres://user:pass@127.0.0.1:5494/db npx tsx qa/g416f-trigger-cost.mts <out.json> [--samples 200]
 *
 * A private schema (`g416f_trigger_cost`, dropped on entry AND exit) holds one
 * synthetic workspace shaped like the G4-16f `high` corpus at three years
 * (`g416f-aged-corpus.mts --rate high --eh 50 --posture P0`):
 * 455 listed heads, 426 of them sealed fold products. Rows:
 *  - retirements: 426 `retired` fold products (`origin = 'fold-product'`),
 *    28 `retired` rotation heads, 16 `folded` sources inside their retain
 *    window (`arrival_watermark` NULL) — 470 rows;
 *  - folds: 426 records of 8 source ids each.
 * That row shape is an ASSUMPTION drawn from the corpus' counters (listed and
 * sealed counts), not a dump of its tables.
 *
 * Every sample is ONE transaction that takes the fence row
 * (`assertReadModelWriteFence`), runs the operation, and ROLLS BACK — so the
 * corpus is the same for every sample; the time is the operation's
 * statements, trigger work included, commit excluded. Arms per operation:
 *  - `triggers`: the adopt row present, the triggers firing (production);
 *  - `control`: `SET LOCAL session_replication_role = replica` (no user
 *    trigger fires) — the same statements without the digest work.
 * Operations:
 *  - `forward`: `commitForwardedHeads` on one retired head (the projector's
 *    late-write `commit()`; one statement);
 *  - `foldRecord`: `recordOrdinaryChainFold` of 8 sources (the batched
 *    record: one source UPDATE, one product INSERT, one fold INSERT) and
 *    `foldRecordPerSource`, the SAME writes with one UPDATE per source (the
 *    shape before this change, hand-written here to the old SQL);
 *  - `detached`: `advanceFoldedArrivalWatermarks` of 8 folded heads (one
 *    statement) and `detachedPerHead`, one `advanceFoldedArrivalWatermark`
 *    per head (the shape before this change);
 *  - `digest`: `read_model_adopt_protocol_digests` alone;
 *  - `settle`: the compaction settle's writes at this shape — the current
 *    head retired and every fold product's `forwarded_heads` advanced by
 *    CAS — batched (`commitOrdinaryHeadRetirements` +
 *    `commitForwardedHeadsBatch`, two statements, as
 *    `settleCompactedOrdinarySegments` now writes them) and
 *    `settlePerSegment`, one `commitOrdinaryHeadRetirement` /
 *    `commitForwardedHeads` per segment (the shape before);
 *    `--settle-samples` (default 40) samples per arm, as the per-segment arm
 *    costs ~0.6 s each;
 *  - `forwardNoAdoptRow`: a forward on a second workspace with the same rows
 *    and NO adopt row (its re-stamp has nothing to update).
 * Samples alternate the arms (A, B, A, B, ...) so drift lands on both. The
 * pool goes through `guardIdleClientErrors`, so its connections carry the
 * protocol participant marker and the lock-order check runs, as in
 * production. The report also carries an EXPLAIN ANALYZE of the re-stamp's
 * UPDATE … FROM the digests on the no-adopt-row workspace: whether the
 * function scan runs when no row matches.
 */

import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { assertReadModelWriteFence } from '../src/readModel/health.js'
import { adoptTopology, withAdoptSavepoint, writeAdoptState } from '../src/readModel/adoptState.js'
import { commitForwardedHeads, commitForwardedHeadsBatch } from '../src/readModel/ordinaryHeadForwarding.js'
import { commitOrdinaryHeadRetirement, commitOrdinaryHeadRetirements } from '../src/readModel/ordinaryHeadRotator.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { recordOrdinaryChainFold } from '../src/readModel/ordinaryChainFold.js'
import { advanceFoldedArrivalWatermark, advanceFoldedArrivalWatermarks } from '../src/readModel/ordinaryFoldedArrivals.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'

const argv = process.argv.slice(2)
const output = argv.find((arg, at) => !arg.startsWith('--') && !['--samples', '--settle-samples'].includes(argv[at - 1] ?? ''))
if (!output) throw new Error('usage: tsx qa/g416f-trigger-cost.mts <out.json> [--samples 200] [--settle-samples 40]')
const samplesAt = argv.indexOf('--samples')
const SAMPLES = samplesAt >= 0 ? Number(argv[samplesAt + 1]) : 200
if (!Number.isInteger(SAMPLES) || SAMPLES < 10) throw new Error(`bad --samples ${argv[samplesAt + 1]}`)
const settleAt = argv.indexOf('--settle-samples')
const SETTLE_SAMPLES = settleAt >= 0 ? Number(argv[settleAt + 1]) : 40
if (!Number.isInteger(SETTLE_SAMPLES) || SETTLE_SAMPLES < 10) throw new Error(`bad --settle-samples ${argv[settleAt + 1]}`)
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const SCHEMA = 'g416f_trigger_cost'
const WS: WorkspaceKey = { landscapeId: 'ls-trigger-cost', versionId: 'v1' }
/** The same rows, no adopt row. */
const NO_ADOPT: WorkspaceKey = { landscapeId: 'ls-trigger-cost-no-adopt', versionId: 'v1' }
const FENCE = 'cost-fence'
const PRODUCTS = 426
const ROTATION_HEADS = 28
const FOLDED = 16
const SOURCES_PER_FOLD = 8
const BATCH = 8
const heads = (id: string) => [`${id}-h1`.padEnd(64, '0'), `${id}-h2`.padEnd(64, '1')]

const admin = guardIdleClientErrors(new pg.Pool({ connectionString: url, max: 1 }), 'trigger-cost:admin')
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
await admin.query(`CREATE SCHEMA ${SCHEMA}`)
const pool = guardIdleClientErrors(new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${SCHEMA}` }), 'trigger-cost')

type Op = 'forward' | 'foldRecord' | 'foldRecordPerSource' | 'detached' | 'detachedPerHead' | 'digest'
  | 'settle' | 'settlePerSegment' | 'forwardNoAdoptRow'
type Arm = 'triggers' | 'control'
const series = new Map<string, number[]>()
let sampled = 0

try {
  await ensureReadModelSchema(pool)
  // The corpus, written with the triggers off (setup is not measured).
  const setup = await pool.connect()
  try {
    await setup.query('BEGIN')
    await setup.query('SET LOCAL session_replication_role = replica')
    await setup.query('INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)',
      [WS.landscapeId, WS.versionId, FENCE])
    const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, at) => `${prefix}${String(at).padStart(4, '0')}`)
    const products = ids('product-', PRODUCTS)
    const rotations = ids('rotation-', ROTATION_HEADS)
    const folded = ids('folded-', FOLDED)
    await setup.query(
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id, retirement_heads, status, origin)
       SELECT $1, $2, 'object', id, ARRAY[id || '-h1', id || '-h2'], 'retired', origin
         FROM unnest($3::text[], $4::text[]) AS row(id, origin)`,
      [WS.landscapeId, WS.versionId, [...products, ...rotations],
        [...products.map(() => 'fold-product'), ...rotations.map(() => 'rotation')]],
    )
    await setup.query(
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id, retirement_heads,
         forwarded_heads, status, folded_into, retain_until, origin)
       SELECT $1, $2, 'object', id, ARRAY[id || '-h1'], ARRAY[id || '-h1'], 'folded', $4, now() + interval '7 days', 'rotation'
         FROM unnest($3::text[]) AS id`,
      [WS.landscapeId, WS.versionId, folded, products[PRODUCTS - 1]],
    )
    await setup.query(
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
       SELECT $1, $2, 'object', id, ARRAY(SELECT id || '-src-' || n FROM generate_series(1, $4::int) AS n)
         FROM unnest($3::text[]) AS id`,
      [WS.landscapeId, WS.versionId, products, SOURCES_PER_FOLD],
    )
    // The no-adopt-row workspace: the same rows under another landscape.
    await setup.query('INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)',
      [NO_ADOPT.landscapeId, NO_ADOPT.versionId, FENCE])
    await setup.query(
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id, retirement_heads,
         forwarded_heads, status, folded_into, retain_until, origin)
       SELECT $1, version_id, collection, document_id, retirement_heads, forwarded_heads, status, folded_into, retain_until, origin
         FROM read_model_ordinary_head_retirements WHERE landscape_id = $2`,
      [NO_ADOPT.landscapeId, WS.landscapeId],
    )
    await setup.query(
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
       SELECT $1, version_id, collection, product_document_id, source_document_ids
         FROM read_model_ordinary_chain_folds WHERE landscape_id = $2`,
      [NO_ADOPT.landscapeId, WS.landscapeId],
    )
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    setup.release()
  }
  // The adopt row, as a cold build writes it (digests computed in its statement).
  const adopt = await pool.connect()
  try {
    await adopt.query('BEGIN')
    if (!(await withAdoptSavepoint(adopt, WS, () => writeAdoptState(adopt, WS, {
      orgId: null, topology: adoptTopology(null, undefined, undefined), defects: 0, sealedCeiling: 0,
      posture: { rotation: false, fold: false, parking: false, extractCache: false },
    })))) {
      throw new Error('the adopt row was not written')
    }
    await adopt.query('COMMIT')
  } finally {
    adopt.release()
  }
  const counts = (await pool.query<{ r: string; f: string; r2: string; a2: string }>(
    `SELECT (SELECT count(*) FROM read_model_ordinary_head_retirements WHERE landscape_id = $1)::text AS r,
            (SELECT count(*) FROM read_model_ordinary_chain_folds WHERE landscape_id = $1)::text AS f,
            (SELECT count(*) FROM read_model_ordinary_head_retirements WHERE landscape_id = $2)::text AS r2,
            (SELECT count(*) FROM read_model_adopt_state WHERE landscape_id = $2)::text AS a2`,
    [WS.landscapeId, NO_ADOPT.landscapeId])).rows[0]!
  if (Number(counts.r) !== PRODUCTS + ROTATION_HEADS + FOLDED || Number(counts.f) !== PRODUCTS
    || counts.r2 !== counts.r || counts.a2 !== '0') {
    throw new Error(`corpus witness: ${JSON.stringify(counts)}`)
  }
  const productIds = Array.from({ length: PRODUCTS }, (_, at) => `product-${String(at).padStart(4, '0')}`)
  // Whether the re-stamp's UPDATE … FROM runs the digest function when no
  // adopt row matches (this workspace has none): its plan, executed, rolled back.
  const explain = await pool.connect()
  let noAdoptRowPlan: unknown
  try {
    await explain.query('BEGIN')
    noAdoptRowPlan = (await explain.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, FORMAT JSON)
       UPDATE read_model_adopt_state AS state
          SET retirements_digest = digests.retirements, folds_digest = digests.folds, updated_at = now()
         FROM read_model_adopt_protocol_digests($1, $2) AS digests
        WHERE state.landscape_id = $1 AND state.version_id = $2`,
      [NO_ADOPT.landscapeId, NO_ADOPT.versionId])).rows[0]!['QUERY PLAN']
  } finally {
    await explain.query('ROLLBACK')
    explain.release()
  }

  const rotationIds = Array.from({ length: ROTATION_HEADS }, (_, at) => `rotation-${String(at).padStart(4, '0')}`)
  const foldedIds = Array.from({ length: FOLDED }, (_, at) => `folded-${String(at).padStart(4, '0')}`)
  const ops: Record<Op, (tx: pg.PoolClient, sample: number) => Promise<void>> = {
    forward: async (tx, sample) => {
      const id = rotationIds[sample % ROTATION_HEADS]!
      if (!(await commitForwardedHeads(tx, WS, 'object', id, null, heads(`late-${sample}`)))) throw new Error('forward did not move')
    },
    foldRecord: async (tx, sample) => {
      const outcome = await recordOrdinaryChainFold(tx, WS, {
        collection: 'object', productDocumentId: `new-product-${sample}`, productHeads: heads('p'),
        currentDocumentId: 'current-head',
        sources: rotationIds.slice(0, BATCH).map((documentId) => ({ documentId, forwardedHeads: null })),
        retainUntil: new Date(Date.now() + 86_400_000),
      })
      if (outcome !== 'recorded') throw new Error(`fold record: ${outcome}`)
    },
    foldRecordPerSource: async (tx, sample) => {
      for (const documentId of rotationIds.slice(0, BATCH)) {
        const moved = await tx.query(
          `UPDATE read_model_ordinary_head_retirements
              SET status = 'folded', folded_into = $5, retain_until = $6, updated_at = now()
            WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4
              AND status = 'retired' AND forwarded_heads IS NOT DISTINCT FROM $7::text[]`,
          [WS.landscapeId, WS.versionId, 'object', documentId, `new-product-${sample}`, new Date(Date.now() + 86_400_000), null],
        )
        if (moved.rowCount !== 1) throw new Error('per-source fold did not move')
      }
      await tx.query(
        `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id, retirement_heads, status, origin)
         VALUES ($1, $2, 'object', $3, $4::text[], 'retired', 'fold-product')`,
        [WS.landscapeId, WS.versionId, `new-product-${sample}`, heads('p')],
      )
      await tx.query(
        `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
         VALUES ($1, $2, 'object', $3, $4::text[])`,
        [WS.landscapeId, WS.versionId, `new-product-${sample}`, rotationIds.slice(0, BATCH)],
      )
    },
    detached: async (tx, sample) => {
      const moved = await advanceFoldedArrivalWatermarks(tx, WS, 'object',
        foldedIds.slice(0, BATCH).map((documentId, at) => ({ documentId, arrivalSeq: String(sample * BATCH + at + 1) })))
      if (moved.size !== BATCH) throw new Error(`detached batch moved ${moved.size}`)
    },
    detachedPerHead: async (tx, sample) => {
      for (const [at, documentId] of foldedIds.slice(0, BATCH).entries()) {
        if (!(await advanceFoldedArrivalWatermark(tx, WS, 'object', documentId, null, String(sample * BATCH + at + 1)))) {
          throw new Error('per-head advance did not move')
        }
      }
    },
    digest: async (tx) => {
      await tx.query('SELECT * FROM read_model_adopt_protocol_digests($1, $2)', [WS.landscapeId, WS.versionId])
    },
    settle: async (tx, sample) => {
      await commitOrdinaryHeadRetirements(tx, WS, 'object', [{ documentId: 'compaction-current', retirementHeads: heads(`c-${sample}`) }])
      const moved = await commitForwardedHeadsBatch(tx, WS, 'object',
        productIds.map((documentId) => ({ documentId, expected: null, next: heads(`s-${sample}`) })))
      if (moved.size !== PRODUCTS) throw new Error(`batched settle moved ${moved.size}`)
    },
    settlePerSegment: async (tx, sample) => {
      await commitOrdinaryHeadRetirement(tx, WS, 'object', 'compaction-current', heads(`c-${sample}`))
      for (const documentId of productIds) {
        if (!(await commitForwardedHeads(tx, WS, 'object', documentId, null, heads(`s-${sample}`)))) {
          throw new Error('per-segment settle did not move')
        }
      }
    },
    forwardNoAdoptRow: async (tx, sample) => {
      const id = rotationIds[sample % ROTATION_HEADS]!
      if (!(await commitForwardedHeads(tx, NO_ADOPT, 'object', id, null, heads(`late-${sample}`)))) throw new Error('forward did not move')
    },
  }

  const client = await pool.connect()
  try {
    for (const op of Object.keys(ops) as Op[]) {
      const samples = op === 'settle' || op === 'settlePerSegment' ? SETTLE_SAMPLES : SAMPLES
      for (let sample = 0; sample < samples + 10; sample += 1) {
        for (const arm of (sample % 2 ? ['control', 'triggers'] : ['triggers', 'control']) as Arm[]) {
          await client.query('BEGIN')
          try {
            if (arm === 'control') await client.query('SET LOCAL session_replication_role = replica')
            await assertReadModelWriteFence(client, op === 'forwardNoAdoptRow' ? NO_ADOPT : WS, FENCE)
            const startedAt = performance.now()
            await ops[op](client, sample)
            const ms = performance.now() - startedAt
            // The first 10 per arm are warm-up.
            if (sample >= 10) {
              const key = `${op}/${arm}`
              series.set(key, [...(series.get(key) ?? []), ms])
              sampled += 1
            }
          } finally {
            await client.query('ROLLBACK')
          }
        }
      }
    }
  } finally {
    client.release()
  }

  const quantile = (values: number[], q: number) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  }
  const round = (ms: number) => Math.round(ms * 1000) / 1000
  const results: Record<string, { median: number; p90: number; samples: number }> = {}
  for (const [key, values] of series) {
    results[key] = { median: round(quantile(values, 0.5)), p90: round(quantile(values, 0.9)), samples: values.length }
  }
  const report = {
    measured: 'adopt protocol trigger cost, aged-corpus shape',
    corpus: { retirementRows: Number(counts.r), foldRows: Number(counts.f), sourcesPerFold: SOURCES_PER_FOLD, batch: BATCH },
    samplesPerArm: SAMPLES,
    settleSamplesPerArm: SETTLE_SAMPLES,
    totalSamples: sampled,
    unit: 'ms (statements of the operation inside one fenced transaction, rolled back; commit excluded)',
    results,
    noAdoptRowRestampPlan: noAdoptRowPlan,
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
}
