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
 * G4-16f P3p (a cold build merges the GIN pending lists once, at its end;
 * `COLD_BUILD_GIN_PENDING_LIST_LIMIT`) under concurrency:
 * several workspaces cold-built AT ONCE into the shared `ro_*` tables, with
 * an incremental writer on another workspace the whole time, and the
 * server's memory sampled.
 *
 *   cd server
 *   G416F_PG_URL=… npx tsx qa/g416f-gin-pending-concurrency.mts --database <snapshot copy> \
 *     --manifest <dir>/<label>.manifest.json --container <docker name> \
 *     [--builds 2] [--objects 36410] [--samples 2] --out <json>
 *
 * On a COPY of an aged snapshot: the corpus's objects extended to
 * `--objects` per workspace (copies with fresh ids and redrawn hex tokens),
 * `--builds` workspaces `l-conc-<k>` cold-built concurrently through
 * `coldBuildReadModel` (each on its own connection), while a third
 * workspace takes one single-object `upsertObjects` every 20 ms (the
 * incremental path, which keeps the server's 4 MB pending-list limit).
 * Recorded per sample: each build's wall ms and breakdown, the incremental
 * writes' p50 / p95 / p99 / max and how many exceeded 100 ms, WAL bytes, and
 * every 200 ms the private memory (RssAnon, /proc) of each PostgreSQL
 * backend and of all of them, read in the container. Runs in a tree before
 * P3p unchanged (the same calls), which is how the same file measures both.
 */
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { coldBuildReadModel, upsertObjects, type WorkspaceKey } from '../src/readModel/projector.js'
import type { ObjectInput } from '../src/readModel/types.js'
import { roundedRowWriteTimings, type RowWriteTimings } from '../src/readModel/rowWriteTimings.js'

const run = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const manifest = JSON.parse(readFileSync(flag('manifest'), 'utf8')) as { workspace: { landscapeId: string; versionId: string; schema: string } }
const ADMIN_URL = process.env.G416F_PG_URL
if (!ADMIN_URL) throw new Error('G416F_PG_URL is required')
const url = new URL(ADMIN_URL)
url.pathname = `/${flag('database')}`
const builds = Number(flag('builds', '2'))
const pool = new pg.Pool({ connectionString: url.toString(), max: builds + 4, options: `-c search_path=${manifest.workspace.schema}` })
const CORPUS: WorkspaceKey = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
const container = flag('container')

const redraw = (s: unknown) => typeof s === 'string'
  ? s.replace(/[0-9a-f]{8,}/g, (m) => randomBytes(Math.ceil(m.length / 2)).toString('hex').slice(0, m.length))
  : s
const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : 0
const round = (ms: number) => Math.round(ms * 10) / 10

/** RssAnon (kB) of every postgres process in the container. */
async function backendMemory(): Promise<number[]> {
  const { stdout } = await run('docker', ['exec', container, 'sh', '-c',
    'for s in /proc/[0-9]*/status; do grep -q "^Name:.*postgres" "$s" 2>/dev/null && grep "^RssAnon" "$s"; done; true'])
  return stdout.split('\n').map((line) => Number(/(\d+)\s*kB/.exec(line)?.[1])).filter((kb) => Number.isFinite(kb) && kb > 0)
}

async function main() {
  const { rows } = await pool.query<{ data: ObjectInput }>(
    `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id COLLATE "C"`, [CORPUS.landscapeId, CORPUS.versionId])
  const base = rows.map((row) => row.data)
  const target = Number(flag('objects', '36410'))
  const corpusOf = (k: number): ObjectInput[] => {
    const objects: ObjectInput[] = []
    for (let pass = 0; objects.length < target; pass++) {
      for (const o of base) {
        if (objects.length >= target) break
        const c = structuredClone(o)
        c.id = `${String(o.id)}~${k}~${pass}`
        c.name = redraw(c.name) as string
        c.description = redraw(c.description) as string
        c.technology = redraw(c.technology) as string
        if (Array.isArray(c.technologies)) c.technologies = c.technologies.map((t) => ({ ...t, name: redraw(t.name) as string }))
        objects.push(c)
      }
    }
    return objects
  }
  const corpora = Array.from({ length: builds }, (_, k) => corpusOf(k))
  const incrementalKey: WorkspaceKey = { landscapeId: 'l-conc-incremental', versionId: 'v1' }
  await coldBuildReadModel(pool, incrementalKey, null, base.slice(0, 2000).map((o) => ({ ...o, id: `inc-${String(o.id)}` })), [], [], [])
  const out: Record<string, unknown> = {
    builds, objectsPerBuild: target,
    settings: (await pool.query(`SELECT name, setting, unit FROM pg_settings WHERE name IN
      ('max_wal_size', 'shared_buffers', 'gin_pending_list_limit', 'maintenance_work_mem', 'work_mem') ORDER BY name`)).rows,
    roObjectsGinIndexes: (await pool.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid
      JOIN pg_class t ON t.oid = x.indrelid JOIN pg_am am ON am.oid = c.relam WHERE t.relname = 'ro_objects' AND am.amname = 'gin' ORDER BY 1`)).rows,
    samples: [] as unknown[],
  }
  const idleMemory = await backendMemory()
  out.idleBackendsRssAnonKb = { count: idleMemory.length, total: idleMemory.reduce((a, b) => a + b, 0), max: Math.max(...idleMemory) }
  for (let sample = 1; sample <= Number(flag('samples', '2')); sample++) {
    for (let k = 0; k < builds; k++) {
      await pool.query(`DELETE FROM ro_objects WHERE landscape_id = $1`, [`l-conc-${k}`])
    }
    await pool.query('VACUUM ro_objects')
    await pool.query('CHECKPOINT')
    const lsnBefore = (await pool.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0]!.lsn
    let running = true
    const memory: Array<{ t: number; total: number; max: number }> = []
    const startedAt = performance.now()
    const sampler = (async () => {
      while (running) {
        const kb = await backendMemory().catch(() => [])
        memory.push({ t: Math.round(performance.now() - startedAt), total: kb.reduce((a, b) => a + b, 0), max: Math.max(0, ...kb) })
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    })()
    const latencies: number[] = []
    const incremental = (async () => {
      let n = 0
      while (running && flag('incremental', 'on') === 'on') {
        const object = base[n % 2000]!
        const t = performance.now()
        await upsertObjects(pool, incrementalKey, null, [{ ...object, id: `inc-${String(object.id)}`, name: `${String(object.name)} ${sample}-${n}` }])
        latencies.push(performance.now() - t)
        n += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    // A READER of the same trigram index, on another workspace: a GIN scan
    // reads the WHOLE pending list (every workspace's entries, committed or
    // not), so a list a build lets grow is paid by every search meanwhile.
    const readLatencies: number[] = []
    const reader = (async () => {
      const client = await pool.connect()
      try {
        await client.query('SET enable_seqscan = off')
        let n = 0
        while (running) {
          const word = String(base[(n * 7) % base.length]!.name ?? 'x').split(/\s+/).find((w) => w.length >= 6)?.slice(0, 6) ?? 'abcdef'
          const t = performance.now()
          // No workspace predicate, so the only index that can serve it is
          // the trigram one (`idx_ro_objects_name_trgm`), as a substring
          // search over the table's rows would be.
          await client.query(
            `SELECT id FROM ro_objects WHERE lower(name) LIKE $1 LIMIT 20`,
            [`%${word.toLowerCase()}%`],
          )
          readLatencies.push(performance.now() - t)
          n += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        await client.query('RESET enable_seqscan').catch(() => undefined)
        client.release()
      }
    })()
    const buildResults = await Promise.all(corpora.map(async (objects, k) => {
      const timings: RowWriteTimings = {}
      const t = performance.now()
      await coldBuildReadModel(pool, { landscapeId: `l-conc-${k}`, versionId: 'v1' }, null, objects, [], [], [], { timings })
      return { ms: Math.round(performance.now() - t), timings: roundedRowWriteTimings(timings) }
    }))
    // A little past the builds: a merge an incremental write pays after them shows.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    running = false
    await Promise.all([sampler, incremental, reader])
    const reads = [...readLatencies].sort((a, b) => a - b)
    const lsnAfter = (await pool.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0]!.lsn
    const wal = Number((await pool.query<{ d: string }>('SELECT pg_wal_lsn_diff($2, $1)::bigint AS d', [lsnBefore, lsnAfter])).rows[0]!.d)
    const sorted = [...latencies].sort((a, b) => a - b)
    const line = {
      sample, wallMs: Math.round(performance.now() - startedAt), builds: buildResults,
      incremental: { writes: latencies.length, p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), p99: round(quantile(sorted, 0.99)), max: round(sorted[sorted.length - 1] ?? 0), over100ms: latencies.filter((ms) => ms > 100).length },
      trigramReads: { reads: reads.length, p50: round(quantile(reads, 0.5)), p95: round(quantile(reads, 0.95)), p99: round(quantile(reads, 0.99)), max: round(reads[reads.length - 1] ?? 0), over100ms: reads.filter((ms) => ms > 100).length },
      walMB: Math.round(wal / 2 ** 20),
      backendsRssAnonKb: { peakTotal: Math.max(...memory.map((m) => m.total)), peakSingle: Math.max(...memory.map((m) => m.max)), samples: memory.length },
    }
    console.log(JSON.stringify(line))
    ;(out.samples as unknown[]).push(line)
  }
  writeFileSync(flag('out'), `${JSON.stringify(out, null, 1)}\n`)
  await pool.end()
}
await main()
