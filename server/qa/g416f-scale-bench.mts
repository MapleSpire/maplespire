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
 * G4-16f: the cold build (its WAL volume) and the two `search_document`
 * readers at 119 000 objects, on a SYNTHETIC corpus (the day-250 snapshot of
 * the first measurements was not kept). Synthetic objects: a name of two
 * vocabulary words and a number, a description of `--desc-words` words drawn
 * from a 4 000-word vocabulary (accented words included) plus one random hex
 * token, a technology from 80. `--desc-words` is calibrated so that a
 * 119 000-object build writes the WAL the snapshot-derived bench wrote
 * (measured: 1 783 MB for the row writes alone).
 *
 *   cd server
 *   G416F_PG_URL=postgres://…/<db> npx tsx qa/g416f-scale-bench.mts build \
 *     --landscape ls-a --objects 119000 [--workspaces 1] [--desc-words 60] [--vocab syllable|random] [--truncate] [--no-checkpoint] [--samples 1] --out <json>
 *   G416F_PG_URL=… npx tsx qa/g416f-scale-bench.mts search --landscape ls-a \
 *     --index with|without --rates 10,20,40 --seconds 30 [--pool 10] [--writer-ms 20] --writer-landscape ls-b --out <json>
 *
 * build: per sample (after an optional TRUNCATE of every ro_* table and a
 * CHECKPOINT): wall time, WAL bytes (pg_current_wal_lsn), checkpoints
 * requested and timed (pg_stat_bgwriter), the peak size of pg_wal sampled
 * every 250 ms (pg_ls_waldir), the build's own phases.
 *
 * search: OPEN-LOOP arrivals (Poisson, `--rates` per second: 20/s is 200
 * users searching once every 10 s, 40/s once every 5 s) on ONE pool of
 * `--pool` connections (the server's primary pool: DB_POOL_MAX, 10), latency
 * from arrival (pool queue included; past 4 queued per connection an arrival
 * is shed and counted), half `roSearch`, half
 * `roObjectSearchPage`, over selective queries; meanwhile one writer
 * `upsertObjects` one object every `--writer-ms` in the searched workspace
 * and one in `--writer-landscape`. p50 / p95 / p99 / max per reader, and the
 * writers'.
 */
import pg from 'pg'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { coldBuildReadModel, upsertObjects, type WorkspaceKey } from '../src/readModel/projector.js'
import { roSearch } from '../src/readModel/queries.js'
import { roObjectSearchPage } from '../src/readModel/objectExplorer.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import type { ObjectInput } from '../src/readModel/types.js'

const [command, ...argv] = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const has = (name: string) => argv.includes(`--${name}`)
const URL_ = process.env.G416F_PG_URL
if (!URL_) throw new Error('G416F_PG_URL is required')

const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : NaN
const round = (ms: number) => Math.round(ms * 10) / 10
const stats = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, p50: round(quantile(s, 0.5)), p95: round(quantile(s, 0.95)), p99: round(quantile(s, 0.99)), max: round(s[s.length - 1] ?? NaN) }
}

// ── corpus ────────────────────────────────────────────────────────────────
// 40 000 words of 6-10 random letters (a fixed seed): each word is in ~0.2 %
// of the descriptions, so a word query is SELECTIVE (a few hundred hits at
// 119 000 objects, the first measurement's "cafe (228 hits)" order). A
// syllable vocabulary, tried first, made every query match ~25 % of the rows.
const ACCENTED = ['réservation', 'système', 'données', 'événement', 'élève', 'café', 'montréal', 'quotidienne', 'géré', 'sécurité']
let seed = 0x9e3779b9
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const RANDOM_VOCAB = Array.from({ length: 40_000 }, (_, n) =>
  n % 997 === 0 ? ACCENTED[(n / 997) % ACCENTED.length]! + String(n % 13)
    : Array.from({ length: 6 + Math.floor(rand() * 5) }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join(''))
// `--vocab syllable`: the 4 000 syllable words the WAL build measurements were
// taken with (calibrated on the snapshot bench's WAL; few distinct trigrams,
// so NOT selective for searches). The random vocabulary has far more
// distinct trigrams: its builds write several times the WAL.
const SYL = ['ka', 'lo', 'mi', 'ne', 'po', 'ru', 'sa', 'ti', 'vo', 'ze', 'bra', 'cle', 'dri', 'fro', 'glu', 'pla', 'qua', 'sto', 'tre', 'vin']
const SYLLABLE_VOCAB = Array.from({ length: 4000 }, (_, n) =>
  n % 97 === 0 ? ACCENTED[(n / 97) % ACCENTED.length]! + String(n % 13)
    : [0, 1, 2].map((j) => SYL[(n * 7 + j * 11 + (n >> (j + 2))) % SYL.length]).join('') + (n % 5 === 0 ? String(n % 89) : ''))
const VOCAB = argv.includes('--vocab') && argv[argv.indexOf('--vocab') + 1] === 'syllable' ? SYLLABLE_VOCAB : RANDOM_VOCAB
const TECH = Array.from({ length: 80 }, (_, n) => `${['postgresql', 'kafka', 'redis', 'node.js', 'java', 'go', 'nginx', 'react'][n % 8]} ${1 + (n % 10)}.${n % 7}`)
const TYPES = ['component', 'container', 'system']
const pick = (n: number, k: number) => VOCAB[(n * 2654435761 + k * 40503) % VOCAB.length >>> 0]!

function corpus(count: number, descWords: number, prefix = 'o'): ObjectInput[] {
  return Array.from({ length: count }, (_, n) => ({
    id: `${prefix}-${n}`,
    type: TYPES[n % TYPES.length]!,
    name: `${pick(n, 1)} ${pick(n, 2)} ${n}`,
    description: `${Array.from({ length: descWords }, (_, k) => pick(n, k + 3)).join(' ')} ${randomBytes(6).toString('hex')}`,
    technology: TECH[n % TECH.length]!,
  }))
}

const keyOf = (landscapeId: string, k = 0): WorkspaceKey => ({ landscapeId: k ? `${landscapeId}-${k}` : landscapeId, versionId: 'v1' })

// ── build ─────────────────────────────────────────────────────────────────
async function build() {
  const pool = new pg.Pool({ connectionString: URL_, max: 3 })
  // This tree's read-model schema (idx_ro_objects_search_trgm included;
  // the first WAL measurements were taken without it, while it was dropped).
  await ensureReadModelSchema(pool)
  const objects = Number(flag('objects'))
  const workspaces = Number(flag('workspaces', '1'))
  const descWords = Number(flag('desc-words', '60'))
  const samples = Number(flag('samples', '1'))
  const landscape = flag('landscape')
  const setting = async (name: string) => (await pool.query<{ v: string }>('SELECT current_setting($1) AS v', [name])).rows[0]!.v
  const out: Record<string, unknown> = {
    objects, workspaces, descWords,
    settings: {
      max_wal_size: await setting('max_wal_size'), checkpoint_completion_target: await setting('checkpoint_completion_target'),
      checkpoint_timeout: await setting('checkpoint_timeout'), shared_buffers: await setting('shared_buffers'),
      wal_compression: await setting('wal_compression'), full_page_writes: await setting('full_page_writes'),
    },
    runs: [] as unknown[],
  }
  const runs = out.runs as unknown[]
  for (let s = 0; s < samples; s++) {
    for (let k = 0; k < workspaces; k++) {
      if (has('truncate') && k === 0) {
        const { rows } = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'ro\\_%'`)
        await pool.query(`TRUNCATE ${rows.map((r) => r.t).join(', ')}`)
      }
      const key = keyOf(landscape, k)
      const rows = corpus(objects, descWords, `${key.landscapeId}-o`)
      // `--no-checkpoint`: start where the WAL already is (the production
      // case: after a compaction fold, anywhere in checkpoint_timeout's
      // interval), and record how much WAL the last checkpoint already has
      // behind it — the trigger counts from that checkpoint, not from the build.
      if (!has('no-checkpoint')) await pool.query('CHECKPOINT')
      const before = (await pool.query<{ lsn: string; req: string; timed: string; since: string; age: string }>(
        `SELECT pg_current_wal_lsn()::text AS lsn, checkpoints_req::text AS req, checkpoints_timed::text AS timed,
                pg_wal_lsn_diff(pg_current_wal_lsn(), (pg_control_checkpoint()).redo_lsn)::text AS since,
                extract(epoch FROM now() - (pg_control_checkpoint()).checkpoint_time)::text AS age
           FROM pg_stat_bgwriter`)).rows[0]!
      let peakWal = 0
      let sampling = true
      const sampler = (async () => {
        while (sampling) {
          const { rows: w } = await pool.query<{ b: string }>('SELECT coalesce(sum(size), 0)::text AS b FROM pg_ls_waldir()')
          peakWal = Math.max(peakWal, Number(w[0]!.b))
          await new Promise((r) => setTimeout(r, 250))
        }
      })()
      const timings: Record<string, number> = {}
      const t0 = performance.now()
      await coldBuildReadModel(pool, key, null, rows, [], [], [], { timings })
      const ms = performance.now() - t0
      sampling = false
      await sampler
      const after = (await pool.query<{ wal: string; req: string; timed: string }>(
        `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::text AS wal, checkpoints_req::text AS req, checkpoints_timed::text AS timed FROM pg_stat_bgwriter`,
        [before.lsn])).rows[0]!
      const line = {
        sample: s, workspace: key.landscapeId, ms: Math.round(ms), walMB: Math.round(Number(after.wal) / 1048576),
        walSinceCheckpointAtStartMB: Math.round(Number(before.since) / 1048576), lastCheckpointAgeAtStartS: Math.round(Number(before.age)),
        checkpointsRequested: Number(after.req) - Number(before.req), checkpointsTimed: Number(after.timed) - Number(before.timed),
        peakPgWalMB: Math.round(peakWal / 1048576), ginPendingDeferred: timings.ginPendingDeferred ?? 0,
        objectsInsertMs: timings.objectsInsertMs, ginPendingMergeMs: timings.ginPendingMergeMs,
      }
      console.log(JSON.stringify(line))
      runs.push(line)
    }
  }
  await pool.query('VACUUM (ANALYZE, PARALLEL 0) ro_objects')
  writeFileSync(flag('out'), `${JSON.stringify(out, null, 1)}\n`)
  await pool.end()
}

// ── search under load ─────────────────────────────────────────────────────
async function search() {
  const poolSize = Number(flag('pool', '10'))
  const pool = new pg.Pool({ connectionString: URL_, max: poolSize })
  const writerPool = new pg.Pool({ connectionString: URL_, max: 2 })
  const key = keyOf(flag('landscape'))
  const other = keyOf(flag('writer-landscape'))
  const seconds = Number(flag('seconds', '30'))
  const writerMs = Number(flag('writer-ms', '20'))
  const rates = flag('rates', '10,20,40').split(',').map(Number)
  const state = flag('index')
  const present = (await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_ro_objects_search_trgm'`)).rowCount
  let createIndexMs: number | undefined
  if (state === 'with' && !present) {
    // The baseline's DDL (a plain CREATE INDEX: SHARE lock, writes to
    // ro_objects wait for it), timed.
    const t = performance.now()
    await pool.query('CREATE INDEX idx_ro_objects_search_trgm ON ro_objects USING gin (search_document public.gin_trgm_ops)')
    createIndexMs = Math.round(performance.now() - t)
    await pool.query('ANALYZE ro_objects')
  }
  if (state === 'without' && present) await pool.query('DROP INDEX idx_ro_objects_search_trgm')
  const { rows: counts } = await pool.query<{ ws: number; all: number }>(
    `SELECT count(*) FILTER (WHERE landscape_id = $1 AND version_id = $2)::int AS ws, count(*)::int AS all FROM ro_objects`, [key.landscapeId, key.versionId])
  // Selective queries, drawn from the corpus: name tokens, description
  // tokens, a technology, an accent, a miss. Every query a user types is a
  // few characters of a word; none of these matches more than ~1 % of rows.
  const { rows: sample } = await pool.query<{ name: string; description: string }>(
    `SELECT name, description FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id LIMIT 40 OFFSET 777`, [key.landscapeId, key.versionId])
  const queries = [
    ...sample.slice(0, 20).map((r) => r.name.split(' ')[0]!),
    ...sample.slice(20, 35).map((r) => r.description.split(' ')[4]!),
    'kafka 3.2', 'réservation', 'système4', 'zzz-none', 'qwxv',
  ]
  const out: Record<string, unknown> = { state, createIndexMs, poolSize, seconds, writerMs, workspaceObjects: counts[0]!.ws, tableObjects: counts[0]!.all, queries, levels: [] as unknown[] }
  // How selective each query is (rows of the workspace it matches).
  const hits: Record<string, number> = {}
  for (const q of queries) {
    hits[q] = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND search_document LIKE $3`,
      [key.landscapeId, key.versionId, `%${q.toLowerCase()}%`])).rows[0]!.n
  }
  out.hits = hits
  // One plan of a selective query, for the record.
  const plan = (await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND search_document LIKE $3`,
    [key.landscapeId, key.versionId, `%${queries[0]}%`])).rows.map((r) => r['QUERY PLAN'])
  out.plan = plan
  for (const rate of rates) {
    const search: number[] = []
    const explorer: number[] = []
    const writes: Record<string, number[]> = { sameWorkspace: [], otherWorkspace: [] }
    let errors = 0
    let stop = false
    const writer = async (target: WorkspaceKey, label: string) => {
      for (let i = 0; !stop; i++) {
        const t = performance.now()
        await upsertObjects(writerPool, target, null, [{ id: `${target.landscapeId}-o-${(i * 7919) % 1000}`, type: 'component', name: `edited ${i} ${pick(i, 9)}`, description: `${pick(i, 10)} ${pick(i, 11)}` }])
        writes[label]!.push(performance.now() - t)
        await new Promise((r) => setTimeout(r, writerMs))
      }
    }
    const writers = [writer(key, 'sameWorkspace'), writer(other, 'otherWorkspace')]
    const inflight: Promise<void>[] = []
    const end = performance.now() + seconds * 1000
    let n = 0
    let pending = 0
    let shed = 0
    while (performance.now() < end) {
      const q = queries[n % queries.length]!
      const reader = n % 2
      n++
      const arrival = performance.now()
      // Saturation: past 4 queued requests per connection an arrival is SHED
      // (counted, not run), so a rate above capacity reads as shed > 0 and a
      // bounded queue, not as an ever-growing backlog.
      if (pending >= 4 * poolSize) {
        shed++
        await new Promise((r) => setTimeout(r, -Math.log(1 - Math.random()) * 1000 / rate))
        continue
      }
      pending++
      inflight.push((async () => {
        try {
          if (reader === 0) await roSearch(pool, key, q)
          else await roObjectSearchPage(pool, key, { query: q })
          ;(reader === 0 ? search : explorer).push(performance.now() - arrival)
        } catch {
          errors++
        } finally {
          pending--
        }
      })())
      // Poisson arrivals at `rate` per second.
      await new Promise((r) => setTimeout(r, -Math.log(1 - Math.random()) * 1000 / rate))
    }
    await Promise.all(inflight)
    stop = true
    await Promise.all(writers)
    const level = {
      rate, arrivals: n, shed, servedPerSecond: round((n - shed) / seconds), errors,
      roSearch: stats(search), explorer: stats(explorer),
      writerSameWorkspace: stats(writes.sameWorkspace!), writerOtherWorkspace: stats(writes.otherWorkspace!),
    }
    console.log(JSON.stringify({ state, ...level }))
    ;(out.levels as unknown[]).push(level)
  }
  writeFileSync(flag('out'), `${JSON.stringify(out, null, 1)}\n`)
  await pool.end()
  await writerPool.end()
}

if (command === 'build') await build()
else if (command === 'search') await search()
else throw new Error('usage: g416f-scale-bench.mts build|search …')
