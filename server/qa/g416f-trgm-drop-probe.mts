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
 * What dropping `idx_ro_objects_desc_trgm` / `idx_ro_objects_tech_trgm` buys
 * and costs (schema.ts `REDUNDANT_OBJECT_TRIGRAM_INDEXES`).
 *
 *   cd server
 *   DATABASE_URL=postgres://user:pass@127.0.0.1:5691/db npx tsx qa/g416f-trgm-drop-probe.mts <out.json> [--objects 85235] [--reps 5] [--search-reps 15]
 *
 * A private schema (`g416f_trgm_probe`, dropped on entry AND exit) holds a
 * SYNTHETIC corpus — deterministic syllable words, lengths tuned to the
 * averages of the real 3-year `high` corpus (name 26, description 143,
 * technology 70 chars; 85 235 objects). Synthetic text is an ASSUMPTION: the
 * trigram distribution of real names and descriptions is not this one, so the
 * search timings are this corpus's, and the insert ratio is what travels.
 *
 *  1. `insert`: an empty `ro_objects` (this build's schema), `INSERT … SELECT`
 *     of the whole corpus in one workspace, wall clock including commit.
 *     Arms `before` (the two indexes re-created with the DDL that defined
 *     them before the drop) and `after` (without them), INTERLEAVED (before,
 *     after, before, …) so drift lands on both.
 *  2. `search`: the table filled once, `ANALYZE`d; `EXPLAIN (ANALYZE,
 *     BUFFERS)` of the object filter, median execution time over
 *     `--search-reps`, four arms: `before` (previous SQL, indexes present),
 *     `after` (RO_SEARCH_OBJECTS_SQL, indexes absent), `oldSqlAfterDrop`
 *     (previous SQL on a migrated database — an older node in a mixed
 *     fleet), `newSqlBeforeDrop` (the rewrite on a database not yet migrated).
 *  3. `rebuild`: how long an older build's baseline takes to re-create the two
 *     indexes with a plain `CREATE INDEX` (SHARE lock: writers of every
 *     workspace wait that long), and how long the concurrent drop takes on an
 *     idle table.
 *  4. `analyzeInterplay`: a transaction T writes `ro_objects` (as a cold build
 *     does), the concurrent drop starts and waits for T, then T issues the
 *     cold build's bounded `ANALYZE ro_objects` (`SET LOCAL lock_timeout =
 *     '15000ms'`, `analyzeWithinCeiling`) after `delayMs`. Records which
 *     session fails and with what SQLSTATE. `deadlock_timeout` is recorded
 *     beside it, since which side the detector picks depends on it. Arms:
 *     `raw` (a bare `DROP INDEX CONCURRENTLY`, unbounded) and `shipped`
 *     (`dropRedundantObjectTrigramIndexes`, one attempt), plus what a failed
 *     drop leaves behind and whether the next drop clears it.
 */

import { writeFileSync } from 'node:fs'
import pg from 'pg'

import { dropRedundantObjectTrigramIndexes, ensureReadModelSchema } from '../src/readModel/schema.js'
import { RO_SEARCH_OBJECTS_SQL } from '../src/readModel/queries.js'

const SCHEMA = 'g416f_trgm_probe'
const KEY = { landscapeId: 'ls-probe', versionId: 'v1' }

const PREVIOUS_SQL = `SELECT data FROM ro_objects
       WHERE landscape_id = $1 AND version_id = $2
         AND (lower(name) LIKE $3 ESCAPE '\\'
          OR lower(technology) LIKE $3 ESCAPE '\\'
          OR lower(description) LIKE $3 ESCAPE '\\')`
const CREATE_DESC = `CREATE INDEX IF NOT EXISTS idx_ro_objects_desc_trgm ON ro_objects USING gin (lower(description) public.gin_trgm_ops)`
const CREATE_TECH = `CREATE INDEX IF NOT EXISTS idx_ro_objects_tech_trgm ON ro_objects USING gin (lower(technology) public.gin_trgm_ops)`
const DROP_DESC = `DROP INDEX CONCURRENTLY IF EXISTS idx_ro_objects_desc_trgm`
const DROP_TECH = `DROP INDEX CONCURRENTLY IF EXISTS idx_ro_objects_tech_trgm`

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 ? Number(process.argv[at + 1]) : fallback
}
const OUT = process.argv[2]
if (!OUT || OUT.startsWith('--')) throw new Error('usage: g416f-trgm-drop-probe.mts <out.json> [--objects N] [--reps N] [--search-reps N]')
const OBJECTS = arg('objects', 85_235)
const REPS = arg('reps', 5)
const SEARCH_REPS = arg('search-reps', 15)

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const like = (q: string) => `%${q.trim().toLowerCase().replace(/([%_\\])/g, '\\$1')}%`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
await admin.query(`CREATE SCHEMA ${SCHEMA}`)
await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6, options: `-c search_path=${SCHEMA},public` })

try {
  await ensureReadModelSchema(pool)
  const server = (await pool.query<{ version: string; deadlock_timeout: string; shared_buffers: string }>(
    `SELECT version(), current_setting('deadlock_timeout') AS deadlock_timeout, current_setting('shared_buffers') AS shared_buffers`,
  )).rows[0]!

  // The corpus, once, in a plain table. Word counts chosen so the average
  // lengths land near 26 / 143 / 70.
  await pool.query(`
    CREATE TABLE corpus AS
    WITH syllables AS (
      SELECT ARRAY['ka','lo','mi','ne','po','ru','sa','ti','vo','ze','bra','cle','dri','fro','glu',
                   'pla','qua','sto','tre','wix','yul','zan','mor','pex','dun','hal','jor','lek','nim','orb']::text[] AS s
    ), words AS (
      SELECT i, k, (SELECT s[1 + (abs(hashint4(i * 131 + k)) % 30)] || s[1 + (abs(hashint4(i * 137 + k * 7)) % 30)]
                       || s[1 + (abs(hashint4(i * 139 + k * 11)) % 30)] FROM syllables) AS word
        FROM generate_series(1, $1::int) AS i, generate_series(1, 27) AS k
    )
    SELECT i,
           string_agg(word, ' ' ORDER BY k) FILTER (WHERE k <= 3) AS name,
           string_agg(word, ' ' ORDER BY k) FILTER (WHERE k BETWEEN 4 AND 19) AS description,
           string_agg(word, ' ' ORDER BY k) FILTER (WHERE k >= 20) AS technology
      FROM words GROUP BY i`, [OBJECTS])
  const corpus = (await pool.query(
    `SELECT count(*)::int AS objects, round(avg(length(name)), 1)::float AS name,
            round(avg(length(description)), 1)::float AS description, round(avg(length(technology)), 1)::float AS technology
       FROM corpus`,
  )).rows[0]

  const fill = async () => {
    const started = performance.now()
    await pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, id, type, name, description, technology, data)
       SELECT $1, $2, 'obj-' || i, 'app', name, description, technology,
              jsonb_build_object('id', 'obj-' || i, 'name', name, 'description', description, 'technology', technology)
         FROM corpus`, [KEY.landscapeId, KEY.versionId])
    return performance.now() - started
  }
  const setIndexes = async (present: boolean) => {
    if (present) { await pool.query(CREATE_DESC); await pool.query(CREATE_TECH) } else { await pool.query(DROP_DESC); await pool.query(DROP_TECH) }
  }
  const indexes = async () => (await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'ro_objects' ORDER BY 1`, [SCHEMA],
  )).rows.map((row) => row.indexname)

  // 1. insert
  const insert: Record<'before' | 'after', number[]> = { before: [], after: [] }
  const insertIndexes: Record<string, string[]> = {}
  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of ['before', 'after'] as const) {
      await pool.query('TRUNCATE ro_objects')
      await setIndexes(arm === 'before')
      insertIndexes[arm] = await indexes()
      await pool.query('CHECKPOINT')
      insert[arm].push(await fill())
    }
  }

  // 2. search (the table left filled by the last `after` fill)
  await pool.query('VACUUM ANALYZE ro_objects')
  const QUERIES = ['kaloru', 'zanmor', 'ka lo', 'brazan', 'orbpexdun', 'qua']
  const runSearch = async (sql: string) => {
    const out: Record<string, { medianMs: number; minMs: number; rows: number; plan: string[]; sharedHit: number; sharedRead: number }> = {}
    for (const q of QUERIES) {
      const times: number[] = []
      let rows = 0
      let plan: string[] = []
      let sharedHit = 0
      let sharedRead = 0
      for (let rep = 0; rep < SEARCH_REPS; rep++) {
        const { rows: explained } = await pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [KEY.landscapeId, KEY.versionId, like(q)],
        )
        const top = explained[0]!['QUERY PLAN'][0]!
        times.push(top['Execution Time'])
        rows = top.Plan['Actual Rows']
        plan = flatten(top.Plan)
        sharedHit = top.Plan['Shared Hit Blocks'] ?? 0
        sharedRead = top.Plan['Shared Read Blocks'] ?? 0
      }
      out[q] = { medianMs: median(times), minMs: Math.min(...times), rows, plan, sharedHit, sharedRead }
    }
    return out
  }
  interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: PlanNode[] }
  const flatten = (node: PlanNode): string[] =>
    [`${node['Node Type']}${node['Index Name'] ? ` on ${node['Index Name']}` : ''}`, ...(node.Plans ?? []).flatMap(flatten)]

  await setIndexes(true)
  await pool.query('ANALYZE ro_objects')
  const before = await runSearch(PREVIOUS_SQL)
  const newSqlBeforeDrop = await runSearch(RO_SEARCH_OBJECTS_SQL)
  await setIndexes(false)
  await pool.query('ANALYZE ro_objects')
  const after = await runSearch(RO_SEARCH_OBJECTS_SQL)
  const oldSqlAfterDrop = await runSearch(PREVIOUS_SQL)
  // Equality on this corpus too, as a cross-check of the test.
  const equal: Record<string, boolean> = {}
  for (const q of QUERIES) {
    const ids = async (sql: string) => (await pool.query<{ id: string }>(
      `SELECT data->>'id' AS id FROM (${sql}) r ORDER BY data->>'id' COLLATE "C"`, [KEY.landscapeId, KEY.versionId, like(q)],
    )).rows.map((row) => row.id).join(',')
    equal[q] = (await ids(PREVIOUS_SQL)) === (await ids(RO_SEARCH_OBJECTS_SQL))
  }

  // 3. rebuild / drop cost
  const rebuild: Array<{ createBothMs: number; dropConcurrentlyBothMs: number }> = []
  for (let rep = 0; rep < 3; rep++) {
    let started = performance.now()
    await setIndexes(true)
    const createBothMs = performance.now() - started
    started = performance.now()
    await setIndexes(false)
    rebuild.push({ createBothMs, dropConcurrentlyBothMs: performance.now() - started })
  }

  // 4. ANALYZE interplay
  const analyzeInterplay: Array<Record<string, unknown>> = []
  // `raw`: a bare `DROP INDEX CONCURRENTLY`, no lock_timeout (the first
  // design). `shipped`: `dropRedundantObjectTrigramIndexes`, one attempt.
  const ARMS: Array<{ arm: 'raw' | 'shipped'; delayMs: number }> = [
    { arm: 'raw', delayMs: 200 }, { arm: 'raw', delayMs: 1500 },
    { arm: 'shipped', delayMs: 100 }, { arm: 'shipped', delayMs: 300 }, { arm: 'shipped', delayMs: 1500 },
  ]
  for (const { arm, delayMs } of ARMS) {
    await setIndexes(true)
    const t = await pool.connect()
    const d = await pool.connect()
    try {
      const dropperPid = (await d.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await t.query('BEGIN')
      await t.query(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ('ls-interplay', 'v1', $1, '{}')`, [`x-${arm}-${delayMs}`])
      const started = performance.now()
      const run = arm === 'raw'
        ? d.query(DROP_DESC).then(() => ({}))
        : dropRedundantObjectTrigramIndexes(d, { attempts: 1, log: () => {} })
      const drop = run.then(
        (value) => ({ outcome: 'ok', value, atMs: performance.now() - started }),
        (error: { code?: string; message?: string }) => ({ outcome: error.code ?? 'error', message: error.message, atMs: performance.now() - started }),
      )
      for (let i = 0; i < 400; i++) {
        const { rows } = await pool.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [dropperPid])
        if (rows[0]?.w === 'Lock') break
        await sleep(5)
      }
      const dropWaitingAtMs = performance.now() - started
      await sleep(delayMs)
      let analyze: Record<string, unknown>
      const analyzeStarted = performance.now()
      try {
        await t.query(`SET LOCAL lock_timeout = '15000ms'`)
        await t.query('ANALYZE ro_objects')
        analyze = { outcome: 'ok', tookMs: performance.now() - analyzeStarted }
        await t.query('COMMIT')
      } catch (error) {
        analyze = { outcome: (error as { code?: string }).code ?? 'error', message: (error as Error).message, tookMs: performance.now() - analyzeStarted }
        await t.query('ROLLBACK').catch(() => {})
      }
      const dropped = await drop
      // What a failed concurrent drop leaves behind, and whether the next
      // `DROP INDEX CONCURRENTLY IF EXISTS` (the migration's retry) clears it.
      const left = async () => (await pool.query<{ name: string; valid: boolean; ready: boolean }>(
        `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'ro_objects'::regclass AND c.relname = 'idx_ro_objects_desc_trgm'`,
      )).rows
      const leftAfter = await left()
      await pool.query(DROP_DESC)
      const sessionLockTimeout = (await d.query<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`)).rows[0]!.v
      analyzeInterplay.push({ arm, delayMs, dropWaitingAtMs, analyze, drop: dropped, sessionLockTimeoutAfter: sessionLockTimeout, descIndexAfter: leftAfter, descIndexAfterRetry: await left() })
    } finally {
      t.release()
      d.release()
    }
  }
  await setIndexes(false)

  const result = {
    probe: 'g416f-trgm-drop-probe',
    measuredAt: new Date().toISOString(),
    server,
    corpus,
    reps: REPS,
    searchReps: SEARCH_REPS,
    insert: {
      indexes: insertIndexes,
      beforeMs: insert.before,
      afterMs: insert.after,
      medianBeforeMs: median(insert.before),
      medianAfterMs: median(insert.after),
      medianSavedMs: median(insert.before) - median(insert.after),
    },
    search: { before, after, oldSqlAfterDrop, newSqlBeforeDrop, equal },
    rebuild,
    analyzeInterplay,
  }
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ corpus, insert: result.insert, equal, rebuild, analyzeInterplay }, null, 2))
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
}
