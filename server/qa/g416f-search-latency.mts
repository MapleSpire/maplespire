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
 * A superseded variant (the index is kept): what dropping
 * `idx_ro_objects_search_trgm` costs the two readers of `search_document`, `roSearch` (the UI's 12) and
 * `roObjectSearchPage` (the explorer's first page), and their PLANS.
 *
 *   cd server
 *   G416F_PG_URL=… npx tsx qa/g416f-search-latency.mts --database <snapshot copy> \
 *     --manifest <dir>/<label>.manifest.json [--objects 119000] [--reps 21] --out <json>
 *
 * On a COPY of an aged snapshot (its read model built). With `--objects`, the
 * workspace is first rebuilt to that count through `coldBuildReadModel`
 * (the corpus's objects plus copies with fresh ids and redrawn hex tokens,
 * as qa/g416f-cold-attach-overlap.mts makes them) and ANALYZEd. Then, for
 * each of two index states — WITHOUT the index (this tree's schema) and
 * WITH it (created, ANALYZEd, dropped after) — and each query (corpus name,
 * description and technology tokens, a word every description holds, a
 * miss, an accent): one warm call, then `--reps` timed calls per reader
 * (p50 / p95 / max), and EXPLAIN (ANALYZE, BUFFERS) of the reader's object
 * statement, captured from the reader's own call (a recording client).
 */
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { coldBuildReadModel, type WorkspaceKey } from '../src/readModel/projector.js'
import { roSearch } from '../src/readModel/queries.js'
import { roObjectSearchPage } from '../src/readModel/objectExplorer.js'
import type { ObjectInput, Queryable } from '../src/readModel/types.js'

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
const pool = new pg.Pool({ connectionString: url.toString(), max: 4, options: `-c search_path=${manifest.workspace.schema}` })
const KEY: WorkspaceKey = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
const reps = Number(flag('reps', '21'))

const redraw = (s: unknown) => typeof s === 'string'
  ? s.replace(/[0-9a-f]{8,}/g, (m) => randomBytes(Math.ceil(m.length / 2)).toString('hex').slice(0, m.length))
  : s

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
const round = (ms: number) => Math.round(ms * 10) / 10

async function main() {
  const { rows } = await pool.query<{ data: ObjectInput }>(
    `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id COLLATE "C"`, [KEY.landscapeId, KEY.versionId])
  const base = rows.map((row) => row.data)
  const target = Number(flag('objects', String(base.length)))
  if (target !== base.length) {
    const objects: ObjectInput[] = []
    for (let k = 0; objects.length < target; k++) {
      for (const o of base) {
        if (objects.length >= target) break
        if (k === 0) { objects.push(o); continue }
        const c = structuredClone(o)
        c.id = `${String(o.id)}~${k}`
        c.name = redraw(c.name) as string
        c.description = redraw(c.description) as string
        c.technology = redraw(c.technology) as string
        if (Array.isArray(c.technologies)) c.technologies = c.technologies.map((t) => ({ ...t, name: redraw(t.name) as string }))
        objects.push(c)
      }
    }
    await coldBuildReadModel(pool, KEY, null, objects, [], [], [])
  }
  // No parallel workers: a container's default 64 MB /dev/shm refused their
  // segment at 119 000 objects (53100).
  await pool.query('VACUUM (ANALYZE, PARALLEL 0) ro_objects')
  const { rows: sample } = await pool.query<{ name: string; description: string; technology: string }>(
    `SELECT name, description, technology FROM ro_objects WHERE landscape_id = $1 AND version_id = $2
      ORDER BY id COLLATE "C" LIMIT 1 OFFSET 4242`, [KEY.landscapeId, KEY.versionId])
  const one = sample[0]!
  const word = (text: string, at: number) => text.split(/\s+/).filter((w) => w.length >= 4)[at] ?? text.slice(0, 8)
  const queries = [
    { q: word(one.name, 1), kind: 'a name token (few hits)' },
    { q: word(one.description, 3).slice(0, 12), kind: 'a description token' },
    { q: word(one.technology, 0).slice(0, 12), kind: 'a technology token' },
    { q: 'cafe', kind: 'a short hex-like token (dozens of hits)' },
    { q: 'synthetic', kind: 'a word every description holds (every row)' },
    { q: 'zzz-none', kind: 'no hit' },
    { q: 'système', kind: 'an accent (no hit in the corpus)' },
  ]
  const { rows: count } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`, [KEY.landscapeId, KEY.versionId])
  const out: Record<string, unknown> = { objects: count[0]!.n, reps, queries, states: {} as Record<string, unknown> }

  const client = await pool.connect()
  /** The reader's statements, recorded; EXPLAIN ANALYZE of the one that reads ro_objects by search_document. */
  const explainOf = async (read: (db: Queryable) => Promise<unknown>) => {
    const seen: Array<{ text: string; values?: unknown[] }> = []
    const recording: Queryable = {
      query: ((text: string, values?: unknown[]) => { seen.push({ text, values }); return client.query(text, values) }) as Queryable['query'],
    }
    await read(recording)
    const statement = seen.find((s) => /search_document LIKE/.test(s.text))
    if (!statement) return null
    const { rows: plan } = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown>; 'Execution Time': number }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values)
    const top = plan[0]!['QUERY PLAN'][0]!
    const nodes: string[] = []
    const walk = (node: Record<string, unknown>) => {
      nodes.push([node['Node Type'], node['Index Name']].filter(Boolean).join(' '))
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child)
    }
    walk(top.Plan)
    return { executionMs: round(top['Execution Time']), nodes, sharedHit: top.Plan['Shared Hit Blocks'], sharedRead: top.Plan['Shared Read Blocks'] }
  }
  const time = async (fn: () => Promise<unknown>) => {
    await fn()
    const ms: number[] = []
    for (let i = 0; i < reps; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t) }
    ms.sort((a, b) => a - b)
    return { p50: round(quantile(ms, 0.5)), p95: round(quantile(ms, 0.95)), max: round(ms[ms.length - 1]!) }
  }
  const measure = async (state: string) => {
    const results: unknown[] = []
    for (const { q, kind } of queries) {
      const search = await time(() => roSearch(client, KEY, q))
      const explorer = await time(() => roObjectSearchPage(client, KEY, { query: q }))
      const hits = (await roSearch(client, KEY, q, 1_000_000)).length
      const line = {
        state, q, kind, hits, search, explorer,
        searchPlan: await explainOf((db) => roSearch(db, KEY, q)),
        explorerPlan: await explainOf((db) => roObjectSearchPage(db, KEY, { query: q })),
      }
      console.log(JSON.stringify(line))
      results.push(line)
    }
    ;(out.states as Record<string, unknown>)[state] = results
  }
  try {
    const present = (await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_ro_objects_search_trgm'`)).rowCount
    if (present) await client.query('DROP INDEX idx_ro_objects_search_trgm')
    await measure('without-index')
    await client.query(`CREATE INDEX idx_ro_objects_search_trgm ON ro_objects USING gin (search_document public.gin_trgm_ops)`)
    await client.query('ANALYZE ro_objects')
    await measure('with-index')
    await client.query('DROP INDEX idx_ro_objects_search_trgm')
  } finally {
    client.release()
  }
  writeFileSync(flag('out'), `${JSON.stringify(out, null, 1)}\n`)
  await pool.end()
}
await main()
