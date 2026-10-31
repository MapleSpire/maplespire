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
 * Spotlight server measurement:
 *  - projector write cost WITHOUT and WITH the stored `spot_*` columns,
 *  - the first-boot cost of building them on populated tables,
 *  - query latency (p50/p95 of 15 runs after 3 warm-ups) and its SQL/Node split.
 *
 *   SPOTLIGHT_MEASURE_DB=postgres://... npx tsx scripts/spotlight-measure.ts
 *
 * Runs in its own schema (`test_spotlight_perf`, dropped on the way in AND out;
 * the last line asserts it is gone). Synthetic data: every description draws 30
 * words from a 30-word list, so a common word matches most rows — a worst case
 * for broad terms, not a typical workspace.
 */

import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { coldBuildReadModel } from '../src/readModel/projector.js'
import { upsertDecisionRecords } from '../src/readModel/derivedStats.js'
import { SPOTLIGHT_TABLES, ensureSpotlightSchema } from '../src/readModel/spotlightSql.js'
import { roSpotlight } from '../src/readModel/spotlight.js'
import type { Queryable } from '../src/readModel/types.js'

const URL = process.env.SPOTLIGHT_MEASURE_DB
if (!URL) throw new Error('set SPOTLIGHT_MEASURE_DB to a Postgres URL you can create schemas in')
const N_OBJECTS = 12_000
const N_CONNECTIONS = 15_000
const N_DIAGRAMS = 400
const N_ADRS = 400

let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
const WORDS = ['payment', 'order', 'checkout', 'ledger', 'invoice', 'customer', 'catalog', 'search', 'inventory', 'shipping',
  'notification', 'identity', 'session', 'pricing', 'réclamation', 'énergie', 'facturation', 'compte', 'gateway', 'billing',
  'analytics', 'report', 'audit', 'fraud', 'risk', 'warehouse', 'stock', 'cart', 'wallet', 'refund']
const TECH = ['PostgreSQL', 'Redis', 'Kafka', 'Go', 'Node.js', 'React', 'Python', 'Java', 'Kotlin', 'S3', 'gRPC', 'Elasticsearch']
const TYPES = ['system', 'app', 'store', 'component', 'actor']
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function model(prefix: string) {
  const objects = Array.from({ length: N_OBJECTS }, (_, i) => {
    const t = pick(TECH)
    return {
      id: `${prefix}o${i}`, type: pick(TYPES), name: `${cap(pick(WORDS))} ${pick(WORDS)} ${i}`,
      description: sentence(30), shortDescription: sentence(8), scope: rnd() < 0.2 ? 'external' : 'internal', status: 'live',
      technologyUsages: { u: { id: 'u', technologyId: t, catalogRevision: 1, snapshot: { schemaVersion: 1, name: t } } }, technologyUsageOrder: ['u'],
      tagAssignments: {}, tagOrder: [], position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, properties: {},
    }
  })
  const connections = Array.from({ length: N_CONNECTIONS }, (_, i) => ({
    id: `${prefix}c${i}`, fromId: `${prefix}o${Math.floor(rnd() * N_OBJECTS)}`, toId: `${prefix}o${Math.floor(rnd() * N_OBJECTS)}`,
    label: rnd() < 0.7 ? `${cap(pick(WORDS))} ${pick(WORDS)}` : '', type: 'solid',
  }))
  const diagrams = Array.from({ length: N_DIAGRAMS }, (_, i) => ({
    id: `${prefix}d${i}`, name: `${cap(pick(WORDS))} view ${i}`, type: 'container',
    objectIds: Array.from({ length: 30 }, () => `${prefix}o${Math.floor(rnd() * N_OBJECTS)}`),
    connectionIds: Array.from({ length: 30 }, () => `${prefix}c${Math.floor(rnd() * N_CONNECTIONS)}`), groupIds: [],
  }))
  const adrs = Array.from({ length: N_ADRS }, (_, i) => ({
    id: `${prefix}a${i}`, number: i + 1, title: `Use ${pick(TECH)} for ${pick(WORDS)}`, summary: sentence(20), content: sentence(200),
    status: 'approved', createdAt: '2026-01-01', updatedAt: '2026-01-02',
  }))
  return { objects, connections, diagrams, adrs }
}

async function seedWorkspace(db: Queryable, prefix: string, key: { landscapeId: string; versionId: string }): Promise<number> {
  const m = model(prefix)
  const t0 = performance.now()
  await coldBuildReadModel(db, key, null, m.objects, m.connections, [], m.diagrams)
  await upsertDecisionRecords(db, key, null, m.adrs)
  await db.query(`INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'measure')`, [key.landscapeId, key.versionId])
  return performance.now() - t0
}

const db = await createIsolatedSchemaDb(URL, 'spotlight_perf')
try {
  await ensureReadModelSchema(db.pool)
  // First boot after deploy: tables full, Spotlight columns absent.
  for (const t of SPOTLIGHT_TABLES) await db.pool.query(`ALTER TABLE ${t.table} DROP COLUMN IF EXISTS spot_name, DROP COLUMN IF EXISTS spot_text`)
  await db.pool.query(`DELETE FROM read_model_schema_migrations WHERE name LIKE 'spotlight:%'`)

  const a = { landscapeId: 'perf-a', versionId: 'v1' }
  const b = { landscapeId: 'perf-b', versionId: 'v1' }
  console.log(`write (projector cold build), WITHOUT spot_* columns: ${(await seedWorkspace(db.pool, 'a', a)).toFixed(0)} ms`)
  const tb = performance.now()
  await ensureSpotlightSchema(db.pool)
  console.log(`first-boot build on one populated workspace (12k objects): ${(performance.now() - tb).toFixed(0)} ms`)
  console.log(`write (projector cold build), WITH spot_* columns:    ${(await seedWorkspace(db.pool, 'b', b)).toFixed(0)} ms`)
  await db.pool.query('ANALYZE')
  const counts = (await db.pool.query(`SELECT (SELECT count(*) FROM ro_objects) o, (SELECT count(*) FROM ro_connections) c`)).rows[0]
  console.log(`rows: ${counts.o} objects, ${counts.c} connections`)

  const vocab = { domains: new Map<string, string>(), tags: new Map<string, string>() }
  const queries = ['p', 'pa', 'pay', 'payment', 'energie', 'réclam', 'tech:postgres', 'kind:app', 'in:checkout', 'payment -order', 'ledger OR wallet', 'scope:external kind:system', 'zzzz-none']
  for (const q of queries) {
    for (let i = 0; i < 3; i++) await roSpotlight(db.pool, a, q, { perKind: 5, vocab })
    const times: number[] = []
    let matches = 0
    for (let i = 0; i < 15; i++) {
      const t = performance.now()
      const r = await roSpotlight(db.pool, a, q, { perKind: 5, vocab })
      times.push(performance.now() - t)
      matches = r.sections.reduce((n, s) => n + s.total, 0)
    }
    times.sort((x, y) => x - y)
    console.log(`${q.padEnd(28)} p50 ${times[7].toFixed(1).padStart(7)} ms  p95 ${times[14].toFixed(1).padStart(7)} ms  matches ${matches}`)
  }
  for (const q of ['payment', 'energie']) {
    let sql = 0
    const timed = { query: async (text: string, params?: unknown[]) => { const t = performance.now(); try { return await db.pool.query(text, params) } finally { sql += performance.now() - t } } }
    await roSpotlight(timed as unknown as Queryable, a, q, { perKind: 5, vocab })
    sql = 0
    const t = performance.now()
    await roSpotlight(timed as unknown as Queryable, a, q, { perKind: 5, vocab })
    const total = performance.now() - t
    console.log(`${q}: total ${total.toFixed(1)} ms = SQL ${sql.toFixed(1)} ms + Node ${(total - sql).toFixed(1)} ms`)
  }
} finally {
  await db.teardown()
  const check = new pg.Client({ connectionString: URL })
  await check.connect()
  const left = (await check.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = 'test_spotlight_perf'`)).rows[0].n
  await check.end()
  console.log(`measurement schema left behind: ${left}`)
}
