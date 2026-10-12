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
 * What does the ACTIVITY WITNESS query cost, and what plan does Postgres
 * actually choose for it?
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... npx tsx qa/measure-m6.mts ../reports/M6-raw.json
 *
 * ## WHICH query this is
 *
 * The activity witness excludes sync-state chunks with a NEGATIVE spelling. It
 * is the per-document lateral inside `getWorkspaceProjectionFreshness`
 * (`src/readModel/health.ts`), which spells the exclusion
 * `split_part(s.key, '/', 2) <> 'sync-state'` and reads BOTH clocks
 * (`max(updated_at)`, `max(arrival_seq)`). The other `<> 'sync-state'` SQL
 * sites, in `backup/backupRestore.ts`, are census selectors and a
 * `count(*) FILTER` — none is a freshness or liveness witness. Both expression
 * indexes lead on the first key field —
 * `idx_automerge_storage_doc_updated ((split_part(key,'/',1)), updated_at)` and
 * `idx_automerge_storage_doc_arrival ((split_part(key,'/',1)), arrival_seq DESC
 * NULLS LAST)` (`src/db.ts`) — and `split_part(key,'/',2)`, the field the
 * sync-state filter tests, is indexed by nothing.
 *
 * ## The plan is READ FROM THE SHIPPED STATEMENT, never from a copy
 *
 * `getWorkspaceProjectionFreshness` is called for real, through a `Queryable`
 * proxy that runs `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) <text>` on
 * whatever SQL the shipped module hands it, with the shipped parameters, and
 * then runs the statement itself. So the captured plan cannot drift from the
 * code the way a transcribed SQL string would.
 * The three isolated single-document variants below ARE transcriptions, and are
 * labelled as such in the record.
 *
 * ## Why the seed is what it is
 *
 * A plan taken against an empty table says nothing: Postgres seq-scans three
 * rows and reports no index. This harness seeds a chunk table of 96 310 rows
 * over 8 410 documents in its OWN schema, then ANALYZEs, so the planner's
 * choice is a choice (those two numbers are the harness's own `seedShape`
 * output). The seed breaks down as 10 + 100 + 1 000 + 300 + 7 000 documents at ten
 * content chunks each, plus 12 210 sync-state rows.
 *
 * Three measured workspaces (10 / 100 / 1 000 admitted
 * documents) give the SHAPE, because the witness runs once per admitted
 * document and a single point could not show that.
 *
 * ## The control
 *
 * C1 drops BOTH expression indexes and re-runs the identical instrument. If the
 * reported plan were an assertion rather than a reading, it would not move. It
 * must become a sequential scan, and the indexes are then recreated and the
 * index plan must come back — a one-way control could not tell "the drop worked"
 * from "the harness broke".
 *
 * C2 is about the FILTER rather than the index: the witness node's
 * `Rows Removed by Filter` must be > 0 with the `<> 'sync-state'` clause and
 * exactly 0 without it. That is what "nothing indexes the second field" costs,
 * observed rather than argued — the sync-state rows are fetched from the heap
 * and then discarded.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { getWorkspaceProjectionFreshness } from '../src/readModel/health.js'
import type { Queryable } from '../src/readModel/types.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
if (!DATABASE_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero, and `samples: 0` is VOID.
  throw new Error('M6 needs TEST_DATABASE_URL; refusing to report nothing')
}
const OUT = process.argv[2] ?? '../reports/M6-raw.json'

/** Documents whose chunks exist but that belong to OTHER workspaces. They are
 * what makes the table big enough for the planner's choice to be informative. */
const FILLER_DOCUMENTS = 7_000
/** The three measured workspaces, by admitted-document count. */
const WORKSPACE_SIZES = [10, 100, 1_000] as const
/** Content chunks per document: one snapshot plus this many incrementals. Plus
 * the `sync-state` rows, which are what the witness must exclude. */
const INCREMENTALS_PER_DOCUMENT = 9
/**
 * How many `sync-state` rows one document carries, swept.
 *
 * automerge-repo keys peer bookkeeping `[documentId, "sync-state", storageId]`
 * (`StorageSubsystem.js`), so a document accumulates ONE ROW PER DISTINCT
 * PEER STORAGE ID that ever synced it — not one row per document. This is the
 * axis the unindexed filter is exposed on: every one of those rows is newer
 * than the content on a quiet workspace, so the backwards probe on
 * `updated_at` must walk past all of them before it reaches a content chunk.
 * 100 documents per bucket, one workspace per bucket.
 */
const SYNC_STATE_PEER_BUCKETS = [1, 8, 32] as const
const PEER_BUCKET_DOCUMENTS = 100
const SAMPLES = 40
const WARMUP = 8

type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  Filter?: string
  'Rows Removed by Filter'?: number
  'Actual Total Time'?: number
  'Actual Loops'?: number
  'Shared Hit Blocks'?: number
  'Shared Read Blocks'?: number
  Plans?: PlanNode[]
}
type ExplainResult = { Plan: PlanNode; 'Execution Time': number; 'Planning Time': number }

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)]

const storageNodes = (plan: ExplainResult): PlanNode[] =>
  nodes(plan.Plan).filter((n) =>
    n['Relation Name'] === 'automerge_storage' || (n['Index Name'] ?? '').includes('automerge_storage'))

/** Every index actually named by the plan, in plan order. Read from the plan,
 * never from what the schema says SHOULD be used. */
const indexesUsed = (plan: ExplainResult): string[] =>
  nodes(plan.Plan).map((n) => n['Index Name']).filter((n): n is string => typeof n === 'string')

const summarise = (plan: ExplainResult) => ({
  executionMs: Number(plan['Execution Time'].toFixed(3)),
  planningMs: Number(plan['Planning Time'].toFixed(3)),
  indexUsed: indexesUsed(plan),
  storageAccess: storageNodes(plan).map((n) => ({
    nodeType: n['Node Type'],
    indexName: n['Index Name'] ?? null,
    indexCond: n['Index Cond'] ?? null,
    filter: n.Filter ?? null,
    rowsRemovedByFilter: n['Rows Removed by Filter'] ?? 0,
    loops: n['Actual Loops'] ?? null,
    sharedHitBlocks: n['Shared Hit Blocks'] ?? null,
    sharedReadBlocks: n['Shared Read Blocks'] ?? null,
  })),
  topLevel: plan.Plan['Node Type'],
})

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!.toFixed(3))
}

async function main(): Promise<void> {
  // Per-run schema name. `createIsolatedSchemaDb` opens with `DROP SCHEMA IF
  // EXISTS … CASCADE`, so a fixed name means two concurrent runs on the shared
  // CI database destroy each other mid-flight. `teardown()` still drops it.
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `m6_activity_witness_${randomBytes(4).toString('hex')}`)
  const pool = db.pool

  /** EXPLAINs whatever the shipped module sends, then runs it. */
  const captured: ExplainResult[] = []
  let explaining = false
  const proxy: Queryable = {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      if (explaining) {
        const explained = await pool.query<{ 'QUERY PLAN': ExplainResult[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${text}`, params)
        captured.push(explained.rows[0]!['QUERY PLAN'][0]!)
      }
      const result = await pool.query(text, params)
      return { rows: result.rows as R[], rowCount: result.rowCount }
    },
  }

  try {
    // --- SCHEMA: the production DDL, verbatim except for CONCURRENTLY (which
    // cannot run in this context and changes nothing about the resulting index).
    await pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await pool.query(`CREATE TABLE versions (
      id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE, label TEXT)`)
    await pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await pool.query(`ALTER TABLE automerge_storage ADD COLUMN arrival_seq BIGINT`)
    await pool.query(
      `ALTER TABLE automerge_storage ALTER COLUMN arrival_seq SET DEFAULT nextval('automerge_arrival_seq')`)
    // The two expression indexes. Both lead on `split_part(key,'/',1)`;
    // NOTHING indexes `split_part(key,'/',2)`, which is the field the
    // sync-state filter tests. If they are missing, control C1 dies at
    // `DROP INDEX … does not exist` rather than swallowing the difference.
    await pool.query(`CREATE INDEX idx_automerge_storage_doc_updated
      ON automerge_storage ((split_part(key, '/', 1)), updated_at)`)
    await pool.query(`CREATE INDEX idx_automerge_storage_doc_arrival
      ON automerge_storage ((split_part(key, '/', 1)), arrival_seq DESC NULLS LAST)`)
    await pool.query(`CREATE TABLE automerge_document_workspace (
      document_id   TEXT PRIMARY KEY,
      landscape_id  TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      version_id    TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    await pool.query(`CREATE INDEX idx_automerge_document_workspace_scope
      ON automerge_document_workspace(landscape_id, version_id)`)
    await pool.query(`CREATE TABLE read_model_projection_state (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, org_id TEXT,
      observed_generation BIGINT NOT NULL DEFAULT 0,
      projected_generation BIGINT NOT NULL DEFAULT 0,
      source_changed_at TIMESTAMPTZ, projection_started_at TIMESTAMPTZ,
      last_projected_at TIMESTAMPTZ, last_duration_ms INTEGER,
      last_error_at TIMESTAMPTZ, last_error_generation BIGINT, last_error_code TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      projector_attached BOOLEAN NOT NULL DEFAULT false, projector_instance_id TEXT,
      write_fence TEXT, last_projection_kind TEXT,
      degraded_since TIMESTAMPTZ, degraded_kind TEXT, degraded_error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id)
    )`)
    await pool.query(`CREATE TABLE read_model_document_watermarks (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, document_id TEXT NOT NULL,
      projected_watermark BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, document_id)
    )`)

    await pool.query(`INSERT INTO landscapes (id, name) VALUES ('m6', 'M6')`)
    const registerWorkspace = async (version: string) => {
      await pool.query(`INSERT INTO versions (id, landscape_id, label) VALUES ($1, 'm6', $1)`, [version])
      await pool.query(
        `INSERT INTO read_model_projection_state
           (landscape_id, version_id, org_id, observed_generation, projected_generation,
            source_changed_at, last_projected_at, projector_attached, last_projection_kind)
         VALUES ('m6', $1, 'org-m6', 12, 12, now() - interval '2 minutes', now(), true, 'object_shard')`,
        [version])
    }
    for (const size of WORKSPACE_SIZES) await registerWorkspace(`ws${size}`)
    for (const peers of SYNC_STATE_PEER_BUCKETS) await registerWorkspace(`wspeers${peers}`)
    await pool.query(`INSERT INTO versions (id, landscape_id, label) VALUES ('wsfiller', 'm6', 'filler')`)

    // --- SEED. One statement per family; an N-statement seed at ~96 000 rows
    // would dominate the wall clock of the run and measure the seed instead.
    // `md5(...)` payloads rather than `repeat('a', n)`: a compressible payload
    // TOASTs away and the heap ends up denser than production, which would make
    // the sequential-scan control look cheaper than it is.
    const seedDocuments = async (version: string, count: number, offset: number, syncStates = 1) => {
      await pool.query(
        `WITH docs AS (
           SELECT substr(md5('m6-doc-' || (g + $1)::text), 1, 22) AS doc FROM generate_series(1, $2) g
         ), snap AS (
           INSERT INTO automerge_storage (key, data, updated_at, arrival_seq)
           SELECT doc || '/snapshot/' || substr(md5(doc || 's'), 1, 16),
                  decode(repeat(md5(doc || 'p'), 64), 'hex'),
                  now() - (random() * interval '20 days'),
                  nextval('automerge_arrival_seq')
           FROM docs RETURNING 1
         ), incr AS (
           INSERT INTO automerge_storage (key, data, updated_at, arrival_seq)
           SELECT doc || '/incremental/' || substr(md5(doc || i::text), 1, 16),
                  decode(repeat(md5(doc || i::text), 16), 'hex'),
                  now() - (random() * interval '20 days'),
                  nextval('automerge_arrival_seq')
           FROM docs, generate_series(1, $3) i RETURNING 1
         ), ss AS (
           -- The sync-state rows: automerge-repo's own 2-byte peer bookkeeping,
           -- keyed [documentId, 'sync-state', storageId] so there is ONE PER
           -- PEER. arrival_seq NULL, exactly as automergeStorage.save() writes
           -- it, and updated_at deliberately NEWER than every content chunk —
           -- that is the case the exclusion exists for.
           INSERT INTO automerge_storage (key, data, updated_at, arrival_seq)
           SELECT doc || '/sync-state/peer-' || p::text, '\\x0102'::bytea, now(), NULL
           FROM docs, generate_series(1, $5) p RETURNING 1
         )
         INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         SELECT doc, 'm6', $4 FROM docs`,
        [offset, count, INCREMENTALS_PER_DOCUMENT, version, syncStates])
    }
    let offset = 0
    for (const size of WORKSPACE_SIZES) {
      await seedDocuments(`ws${size}`, size, offset)
      offset += size
    }
    for (const peers of SYNC_STATE_PEER_BUCKETS) {
      await seedDocuments(`wspeers${peers}`, PEER_BUCKET_DOCUMENTS, offset, peers)
      offset += PEER_BUCKET_DOCUMENTS
    }
    await seedDocuments('wsfiller', FILLER_DOCUMENTS, offset)

    // Watermarks for the admitted documents, so the EXACT branch of the arrival
    // clause is the one exercised — the fallback branch reads no extra rows and
    // would understate the join.
    await pool.query(
      `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
       SELECT landscape_id, version_id, document_id, 9223372036854775807
       FROM automerge_document_workspace`)

    await pool.query('ANALYZE automerge_storage')
    await pool.query('ANALYZE automerge_document_workspace')
    await pool.query('ANALYZE read_model_document_watermarks')
    await pool.query('ANALYZE read_model_projection_state')

    const { rows: sizeRows } = await pool.query<{ chunks: string; docs: string; syncstate: string; bytes: string }>(
      `SELECT (SELECT count(*)::text FROM automerge_storage) AS chunks,
              (SELECT count(*)::text FROM automerge_document_workspace) AS docs,
              (SELECT count(*)::text FROM automerge_storage
                 WHERE split_part(key, '/', 2) = 'sync-state') AS syncstate,
              pg_total_relation_size('automerge_storage')::text AS bytes`)
    const seedShape = {
      chunkRows: Number(sizeRows[0]!.chunks),
      mappedDocuments: Number(sizeRows[0]!.docs),
      syncStateRows: Number(sizeRows[0]!.syncstate),
      storageBytes: Number(sizeRows[0]!.bytes),
      contentChunksPerDocument: INCREMENTALS_PER_DOCUMENT + 1,
      syncStateRowsPerDocument: `1 everywhere except the peer sweep, which is ${SYNC_STATE_PEER_BUCKETS.join(' / ')}`,
    }

    // --- The three transcribed single-document variants. Transcriptions, and
    // labelled as such: only the whole-statement measurement below is proxied
    // off the shipped module.
    const { rows: sampleDoc } = await pool.query<{ document_id: string }>(
      `SELECT document_id FROM automerge_document_workspace WHERE version_id = 'ws100' LIMIT 1`)
    const doc = sampleDoc[0]!.document_id

    const WITNESS_SHIPPED_SPELLING = `SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq
       FROM automerge_storage s
       WHERE split_part(s.key, '/', 1) = $1
         AND split_part(s.key, '/', 2) <> 'sync-state'`
    const WITNESS_WITHOUT_FILTER = `SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq
       FROM automerge_storage s
       WHERE split_part(s.key, '/', 1) = $1`
    // The spelling the org/fleet rollups in the SAME file use — no sync-state
    // exclusion, and an ORDER BY … LIMIT 1 rather than max(). Measured here as
    // the comparison point the "one backwards index probe that stops at the
    // first row" comment in health.ts claims.
    const WITNESS_ORG_SPELLING = `SELECT s.updated_at FROM automerge_storage s
       WHERE split_part(s.key, '/', 1) = $1
       ORDER BY s.updated_at DESC LIMIT 1`

    const explainOne = async (sql: string, params: unknown[]): Promise<ExplainResult> => {
      const { rows } = await pool.query<{ 'QUERY PLAN': ExplainResult[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${sql}`, params as never[])
      return rows[0]!['QUERY PLAN'][0]!
    }
    const timeOne = async (sql: string, params: unknown[]): Promise<number[]> => {
      const durations: number[] = []
      for (let i = 0; i < SAMPLES + WARMUP; i += 1) {
        const t0 = performance.now()
        await pool.query(sql, params as never[])
        const elapsed = performance.now() - t0
        if (i >= WARMUP) durations.push(elapsed)
      }
      return durations
    }

    const singleDocument: Record<string, unknown> = {}
    for (const [name, sql] of [
      ['shippedSpelling', WITNESS_SHIPPED_SPELLING],
      ['withoutSyncStateFilter', WITNESS_WITHOUT_FILTER],
      ['orgRollupSpelling', WITNESS_ORG_SPELLING],
    ] as const) {
      const plan = await explainOne(sql, [doc])
      const durations = await timeOne(sql, [doc])
      singleDocument[name] = {
        sql: sql.replace(/\s+/g, ' ').trim(),
        plan: summarise(plan),
        rawPlan: plan,
        samples: durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: Number(Math.max(...durations).toFixed(3)),
      }
    }

    // --- The SHIPPED statement, whole, through the proxy.
    const workspaces: Record<string, unknown> = {}
    for (const size of WORKSPACE_SIZES) {
      const key = { landscapeId: 'm6', versionId: `ws${size}` }
      captured.length = 0
      explaining = true
      const freshness = await getWorkspaceProjectionFreshness(proxy, key)
      explaining = false
      const plan = captured[0]!
      const durations: number[] = []
      for (let i = 0; i < SAMPLES + WARMUP; i += 1) {
        const t0 = performance.now()
        await getWorkspaceProjectionFreshness(proxy, key)
        const elapsed = performance.now() - t0
        if (i >= WARMUP) durations.push(elapsed)
      }
      workspaces[`admitted${size}`] = {
        admittedDocuments: freshness.admittedDocuments,
        status: freshness.status,
        absenceProvable: freshness.absenceProvable,
        statementsIssued: 1,
        plan: summarise(plan),
        rawPlan: plan,
        samples: durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: Number(Math.max(...durations).toFixed(3)),
      }
    }

    // --- DO THE TWO SPELLINGS AGREE? `health.ts` holds THREE activity
    // witnesses and only ONE of them carries the `<> 'sync-state'` exclusion
    // (inside getWorkspaceProjectionFreshness). The fleet rollup
    // (getFleetReadModelStatusCounts) and the org view (getOrgReadModelHealth)
    // read the same table with the same LATERAL and no filter. Measured rather
    // than argued: both spellings, same document, same instant.
    const { rows: disagreement } = await pool.query<{
      witness_at: string; rollup_at: string; skew_seconds: string
    }>(
      `SELECT w.at AS witness_at, r.at AS rollup_at,
              EXTRACT(EPOCH FROM (r.at - w.at))::text AS skew_seconds
       FROM (SELECT max(s.updated_at) AS at FROM automerge_storage s
              WHERE split_part(s.key, '/', 1) = $1
                AND split_part(s.key, '/', 2) <> 'sync-state') w,
            (SELECT s.updated_at AS at FROM automerge_storage s
              WHERE split_part(s.key, '/', 1) = $1
              ORDER BY s.updated_at DESC LIMIT 1) r`,
      [doc])
    const witnessDisagreement = {
      documentId: doc,
      freshnessWitnessNewestAt: disagreement[0]!.witness_at,
      orgAndFleetRollupNewestAt: disagreement[0]!.rollup_at,
      skewSeconds: Number(Number(disagreement[0]!.skew_seconds).toFixed(1)),
    }

    // --- THE PEER SWEEP. Same 100 admitted documents, same content chunks; only
    // the number of `sync-state` rows per document changes. Whatever moves here
    // is the unindexed filter's own cost, isolated from every other variable.
    const peerSweep: Record<string, unknown> = {}
    for (const peers of SYNC_STATE_PEER_BUCKETS) {
      const version = `wspeers${peers}`
      const { rows: bucketDoc } = await pool.query<{ document_id: string }>(
        `SELECT document_id FROM automerge_document_workspace WHERE version_id = $1 LIMIT 1`, [version])
      const bDoc = bucketDoc[0]!.document_id
      const witnessPlan = await explainOne(WITNESS_SHIPPED_SPELLING, [bDoc])
      const witnessDurations = await timeOne(WITNESS_SHIPPED_SPELLING, [bDoc])

      const key = { landscapeId: 'm6', versionId: version }
      captured.length = 0
      explaining = true
      const freshness = await getWorkspaceProjectionFreshness(proxy, key)
      explaining = false
      const wholePlan = captured[0]!
      const wholeDurations: number[] = []
      for (let i = 0; i < SAMPLES + WARMUP; i += 1) {
        const t0 = performance.now()
        await getWorkspaceProjectionFreshness(proxy, key)
        const elapsed = performance.now() - t0
        if (i >= WARMUP) wholeDurations.push(elapsed)
      }
      peerSweep[`peers${peers}`] = {
        syncStateRowsPerDocument: peers,
        admittedDocuments: freshness.admittedDocuments,
        status: freshness.status,
        absenceProvable: freshness.absenceProvable,
        singleDocumentWitness: {
          plan: summarise(witnessPlan),
          samples: witnessDurations.length,
          p50Ms: percentile(witnessDurations, 0.5),
          p95Ms: percentile(witnessDurations, 0.95),
        },
        wholeStatement: {
          plan: summarise(wholePlan),
          rawPlan: wholePlan,
          samples: wholeDurations.length,
          p50Ms: percentile(wholeDurations, 0.5),
          p95Ms: percentile(wholeDurations, 0.95),
        },
      }
    }

    // --- CONTROL C1: drop both expression indexes, re-run the SAME instrument.
    await pool.query('DROP INDEX idx_automerge_storage_doc_updated')
    await pool.query('DROP INDEX idx_automerge_storage_doc_arrival')
    await pool.query('ANALYZE automerge_storage')
    const controlSingle = await explainOne(WITNESS_SHIPPED_SPELLING, [doc])
    const controlSingleDurations = await timeOne(WITNESS_SHIPPED_SPELLING, [doc])
    captured.length = 0
    explaining = true
    await getWorkspaceProjectionFreshness(proxy, { landscapeId: 'm6', versionId: 'ws100' })
    explaining = false
    const controlWhole = captured[0]!
    const controlWholeDurations: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const t0 = performance.now()
      await getWorkspaceProjectionFreshness(proxy, { landscapeId: 'm6', versionId: 'ws100' })
      controlWholeDurations.push(performance.now() - t0)
    }

    // Recreate and re-read. A one-way control cannot tell "the drop worked" from
    // "the harness broke after the drop".
    await pool.query(`CREATE INDEX idx_automerge_storage_doc_updated
      ON automerge_storage ((split_part(key, '/', 1)), updated_at)`)
    await pool.query(`CREATE INDEX idx_automerge_storage_doc_arrival
      ON automerge_storage ((split_part(key, '/', 1)), arrival_seq DESC NULLS LAST)`)
    await pool.query('ANALYZE automerge_storage')
    const restored = await explainOne(WITNESS_SHIPPED_SPELLING, [doc])

    const report = {
      measureId: 'M6',
      takenOn: new Date().toISOString(),
      harness: 'server/qa/measure-m6.mts',
      schema: db.schema,
      postgres: (await pool.query<{ version: string }>('SELECT version() AS version')).rows[0]!.version,
      seedShape,
      subject: {
        module: 'server/src/readModel/health.ts',
        function: 'getWorkspaceProjectionFreshness',
        note: 'plan captured through a Queryable proxy over the SHIPPED statement text, not a transcription',
      },
      workspaces,
      singleDocument,
      witnessDisagreement,
      peerSweep,
      control: {
        c1IndexDropped: {
          singleDocument: {
            plan: summarise(controlSingle),
            rawPlan: controlSingle,
            samples: controlSingleDurations.length,
            p50Ms: percentile(controlSingleDurations, 0.5),
            p95Ms: percentile(controlSingleDurations, 0.95),
          },
          wholeStatement: {
            plan: summarise(controlWhole),
            rawPlan: controlWhole,
            samples: controlWholeDurations.length,
            p50Ms: percentile(controlWholeDurations, 0.5),
          },
          restoredSingleDocument: { plan: summarise(restored) },
        },
      },
    }
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`M6 raw series written to ${OUT}`)
    console.log(`  chunk rows seeded : ${seedShape.chunkRows} over ${seedShape.mappedDocuments} documents`)
    for (const size of WORKSPACE_SIZES) {
      const w = workspaces[`admitted${size}`] as { p50Ms: number; p95Ms: number; plan: { indexUsed: string[] } }
      console.log(`  freshness @${String(size).padStart(4)} docs : p50 ${w.p50Ms} ms  p95 ${w.p95Ms} ms  indexes ${w.plan.indexUsed.join(', ')}`)
    }
    const witness = singleDocument.shippedSpelling as { p50Ms: number; plan: { indexUsed: string[]; storageAccess: unknown[] } }
    console.log(`  witness (1 doc)   : p50 ${witness.p50Ms} ms  indexes ${witness.plan.indexUsed.join(', ')}`)
    for (const peers of SYNC_STATE_PEER_BUCKETS) {
      const b = peerSweep[`peers${peers}`] as {
        singleDocumentWitness: { p50Ms: number; plan: { storageAccess: { rowsRemovedByFilter: number }[] } }
        wholeStatement: { p50Ms: number }
      }
      const removed = b.singleDocumentWitness.plan.storageAccess.map((a) => a.rowsRemovedByFilter).join('/')
      console.log(`  peers=${String(peers).padStart(2)}          : witness p50 ${b.singleDocumentWitness.p50Ms} ms  rowsRemovedByFilter ${removed}  whole@100docs p50 ${b.wholeStatement.p50Ms} ms`)
    }
    console.log(`  witness disagree  : filtered ${witnessDisagreement.freshnessWitnessNewestAt} vs rollup ${witnessDisagreement.orgAndFleetRollupNewestAt} (skew ${witnessDisagreement.skewSeconds} s)`)
    console.log(`  CONTROL no index  : p50 ${percentile(controlSingleDurations, 0.5)} ms  top ${controlSingle.Plan['Node Type']}  indexes ${indexesUsed(controlSingle).join(', ') || '(none)'}`)
    console.log(`  CONTROL restored  : indexes ${indexesUsed(restored).join(', ') || '(none)'}`)
  } finally {
    await db.teardown()
  }
}

await main()
