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
 * Measure the Model Viewer's level query and the `c4_parent_id` write path at
 * the 200 000-object performance-seed scale. NOT a gate — it prints EXPLAIN
 * (ANALYZE, BUFFERS) text and timings for a performance record.
 *
 * DESTRUCTIVE for one workspace only: it cold-builds `perf-c4/v1` in the
 * database DATABASE_URL names. Point it at a PRIVATE Postgres — never a shared
 * stack — with the schema already migrated (any vitest run does that).
 *
 *   DATABASE_URL=postgres://…:<private port>/… npx tsx scripts/measure-viewer-level-c4.ts
 */
import pg from 'pg'
import { coldBuildReadModel, deleteObjects, upsertObjects, type WorkspaceKey } from '../src/readModel/projector.js'
import { roViewerLevel } from '../src/readModel/viewerLevel.js'
import { backfillC4ParentIds } from '../src/readModel/schema.js'
import { PerformanceSeedPlan } from '../src/performanceSeed/generator.js'
import { FULL_PERFORMANCE_SEED_SCALE } from '../src/performanceSeed/types.js'
import type { ObjectInput } from '../src/readModel/types.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'

const KEY: WorkspaceKey = { landscapeId: 'perf-c4', versionId: 'v1' }
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL must name a PRIVATE Postgres')

const pool = guardIdleClientErrors(new pg.Pool({ connectionString: url, max: 2 }), 'measure-viewer-level-c4')
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6

async function explain(label: string, sql: string, params: unknown[]): Promise<void> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)
  console.log(`\n### ${label}\n\`\`\`\n${rows.map((row) => row['QUERY PLAN']).join('\n')}\n\`\`\``)
}

/** EXPLAIN a write inside a transaction that is ALWAYS rolled back. */
async function explainWrite(label: string, sql: string, params: unknown[], before?: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (before) await client.query(before, [KEY.landscapeId, KEY.versionId])
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)
    console.log(`\n### ${label}\n\`\`\`\n${rows.map((row) => row['QUERY PLAN']).join('\n')}\n\`\`\``)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function main(): Promise<void> {
  const tags = [0, 1, 2].map((i) => ({
    tagId: `tag-${i}`, value: `v${i}`, color: '#888', groupId: 'g', groupName: 'G', catalogRevision: 1,
  }))
  const plan = new PerformanceSeedPlan({
    scale: FULL_PERFORMANCE_SEED_SCALE,
    tags,
    teamIds: Array.from({ length: FULL_PERFORMANCE_SEED_SCALE.teams }, (_, i) => `team-${i}`),
  })
  const objects = Array.from({ length: plan.scale.objects }, (_, i) => plan.objectAt(i)) as unknown as ObjectInput[]
  console.log(`objects=${objects.length} tiers=${JSON.stringify(plan.tierCounts)}`)

  let start = process.hrtime.bigint()
  await coldBuildReadModel(pool, KEY, null, objects, [])
  console.log(`cold build (objects only, real projector path): ${ms(start).toFixed(0)} ms`)

  // Dangling parents, the way production makes them: delete 3 systems through
  // the delta path, which orphans their containers.
  const systems = objects.filter((o) => o.type === 'system').slice(0, 3).map((o) => o.id)
  start = process.hrtime.bigint()
  await deleteObjects(pool, KEY, systems)
  console.log(`deleteObjects(3 systems): ${ms(start).toFixed(0)} ms`)
  // A delta of 512 objects (one shard), re-upserted unchanged.
  const shard = objects.slice(100_000, 100_512)
  start = process.hrtime.bigint()
  await upsertObjects(pool, KEY, null, shard)
  console.log(`upsertObjects(512-object shard): ${ms(start).toFixed(0)} ms`)
  // Steady state: autovacuum would have run on a live table. PARALLEL 0 because
  // a docker Postgres' 64 MB /dev/shm cannot host parallel vacuum workers.
  await pool.query('VACUUM (ANALYZE, PARALLEL 0) ro_objects')

  const census = await pool.query(
    `SELECT count(*) FILTER (WHERE c4_parent_id IS NULL) AS roots,
            count(*) FILTER (WHERE parent_id IS NOT NULL AND c4_parent_id IS NULL) AS dangling,
            count(*) FILTER (WHERE parent_id IS NULL) AS raw_roots
     FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`,
    [KEY.landscapeId, KEY.versionId],
  )
  console.log(`census: ${JSON.stringify(census.rows[0])}`)
  const hub = await pool.query<{ c4_parent_id: string; n: string }>(
    `SELECT c4_parent_id, count(*) AS n FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2 AND c4_parent_id IS NOT NULL
     GROUP BY c4_parent_id ORDER BY count(*) DESC, c4_parent_id LIMIT 1`,
    [KEY.landscapeId, KEY.versionId],
  )
  const hubId = hub.rows[0]!.c4_parent_id
  console.log(`widest level: ${hubId} with ${hub.rows[0]!.n} children`)

  // The production statement, captured from roViewerLevel's own SQL text.
  const captured: Array<{ sql: string; params: unknown[] }> = []
  const spy = { query: async (sql: string, params?: unknown[]) => {
    captured.push({ sql, params: params ?? [] })
    return pool.query(sql, params)
  } }
  for (const [label, opts] of [
    ['root level, first page (200)', {}],
    [`widest level ${hubId}, first page`, { parentId: hubId }],
    ['root level filtered by "payments"', { query: 'payments' }],
  ] as const) {
    captured.length = 0
    const timings: number[] = []
    let result = await roViewerLevel(spy, KEY, opts)
    for (let i = 0; i < 20; i += 1) {
      start = process.hrtime.bigint()
      result = await roViewerLevel(pool, KEY, opts)
      timings.push(ms(start))
    }
    timings.sort((a, b) => a - b)
    console.log(`\n## ${label}: objects=${result.objects.length} total=${result.totalObjects} `
      + `p50=${timings[10]!.toFixed(1)} ms max=${timings[19]!.toFixed(1)} ms (20 warm runs, whole call)`)
    await explain(`${label} — objects statement`, captured[0]!.sql, captured[0]!.params)
    if (result.nextCursor) {
      captured.length = 0
      await roViewerLevel(spy, KEY, { ...opts, after: result.nextCursor })
      await explain(`${label} — second page (cursor)`, captured[0]!.sql, captured[0]!.params)
    }
  }

  // BEFORE (430be165's shape): raw parent_id, count-capped child_count. Same
  // data, same indexes otherwise — the comparison the brief asks for.
  await explain('BEFORE — root level on raw parent_id, LIMIT-1000 child count', `
    SELECT object.id, object.normalized_name, object.data,
      (SELECT count(*) FROM (SELECT 1 FROM ro_objects child
         WHERE child.landscape_id = object.landscape_id AND child.version_id = object.version_id
           AND child.parent_id = object.id LIMIT 1000) capped)::integer AS child_count,
      (SELECT count(*) FROM ro_objects o2 WHERE o2.landscape_id = $1 AND o2.version_id = $2 AND o2.parent_id IS NULL) AS page_total
    FROM ro_objects object
    WHERE object.landscape_id = $1 AND object.version_id = $2 AND object.parent_id IS NULL
    ORDER BY object.normalized_name COLLATE "C", object.id COLLATE "C" LIMIT 201`, [KEY.landscapeId, KEY.versionId])
  await explain(`BEFORE — widest level ${hubId} on raw parent_id`, `
    SELECT object.id, object.normalized_name, object.data,
      (SELECT count(*) FROM (SELECT 1 FROM ro_objects child
         WHERE child.landscape_id = object.landscape_id AND child.version_id = object.version_id
           AND child.parent_id = object.id LIMIT 1000) capped)::integer AS child_count,
      (SELECT count(*) FROM ro_objects o2 WHERE o2.landscape_id = $1 AND o2.version_id = $2 AND o2.parent_id = $3) AS page_total
    FROM ro_objects object
    WHERE object.landscape_id = $1 AND object.version_id = $2 AND object.parent_id = $3
    ORDER BY object.normalized_name COLLATE "C", object.id COLLATE "C" LIMIT 201`, [KEY.landscapeId, KEY.versionId, hubId])

  // The write path. Both shapes of the reparent UPDATE, rolled back.
  const effectiveOnly = `UPDATE ro_objects object
     SET effective_parent_id = COALESCE(
       (SELECT min(membership.group_id) FROM ro_group_objects membership
        WHERE membership.landscape_id = object.landscape_id AND membership.version_id = object.version_id
          AND membership.object_id = object.id),
       CASE WHEN EXISTS (SELECT 1 FROM ro_objects parent
         WHERE parent.landscape_id = object.landscape_id AND parent.version_id = object.version_id
           AND parent.id = object.parent_id) THEN object.parent_id END)`
  const withC4 = `${effectiveOnly},
     c4_parent_id = CASE WHEN EXISTS (SELECT 1 FROM ro_objects parent
       WHERE parent.landscape_id = object.landscape_id AND parent.version_id = object.version_id
         AND parent.id = object.parent_id) THEN object.parent_id END`
  const where = ' WHERE object.landscape_id = $1 AND object.version_id = $2'
  const bounded = `${where} AND (object.id = ANY($3::text[]) OR object.parent_id = ANY($3::text[]))`
  const shardIds = shard.map((o) => o.id)
  // Alternating, rolled back, n=7 each: one sample per arm was 41 vs 129 ms in
  // a first run, with the bgwriter visibly active in BUFFERS — not a number.
  const timedWrite = async (sql: string, params: unknown[]): Promise<number> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const begin = process.hrtime.bigint()
      await client.query(sql, params)
      return ms(begin)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }
  const arms = { before: [] as number[], after: [] as number[] }
  for (let i = 0; i < 7; i += 1) {
    arms.before.push(await timedWrite(effectiveOnly + bounded, [KEY.landscapeId, KEY.versionId, shardIds]))
    arms.after.push(await timedWrite(withC4 + bounded, [KEY.landscapeId, KEY.versionId, shardIds]))
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  console.log(`\nreparent UPDATE, 512-id shard, n=7 alternating: effective-only median ${median(arms.before).toFixed(1)} ms `
    + `[${arms.before.map((v) => v.toFixed(0)).join(', ')}]; effective+c4 median ${median(arms.after).toFixed(1)} ms `
    + `[${arms.after.map((v) => v.toFixed(0)).join(', ')}]`)
  await explainWrite('reparent UPDATE, 512-id shard — effective only (BEFORE)', effectiveOnly + bounded, [KEY.landscapeId, KEY.versionId, shardIds])
  await explainWrite('reparent UPDATE, 512-id shard — effective + c4 (AFTER)', withC4 + bounded, [KEY.landscapeId, KEY.versionId, shardIds])
  await explainWrite('reparent UPDATE, whole workspace — effective only (BEFORE)', effectiveOnly + where, [KEY.landscapeId, KEY.versionId])
  await explainWrite('reparent UPDATE, whole workspace — effective + c4 (AFTER)', withC4 + where, [KEY.landscapeId, KEY.versionId])

  // The one-time migration, from the state a pre-column row is in (NULL), on a
  // table de-bloated after the rolled-back whole-workspace UPDATEs above.
  await pool.query('VACUUM (FULL, ANALYZE) ro_objects')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE ro_objects SET c4_parent_id = NULL WHERE landscape_id = $1 AND version_id = $2', [KEY.landscapeId, KEY.versionId])
    start = process.hrtime.bigint()
    await backfillC4ParentIds(client)
    console.log(`\nbackfillC4ParentIds over ${objects.length} rows (all rows NULL first): ${ms(start).toFixed(0)} ms`)
    start = process.hrtime.bigint()
    await backfillC4ParentIds(client)
    console.log(`backfillC4ParentIds again, table now consistent (the re-run remedy): ${ms(start).toFixed(0)} ms`)
    // The static projector's per-attach repair: the same pass scoped to one
    // workspace, on a consistent table — what every attach pays once the fleet
    // is homogeneous. n=5, sequential.
    const scoped: number[] = []
    for (let i = 0; i < 5; i += 1) {
      start = process.hrtime.bigint()
      await backfillC4ParentIds(client, KEY)
      scoped.push(ms(start))
    }
    console.log(`backfillC4ParentIds scoped to ${KEY.landscapeId}/${KEY.versionId}, consistent, n=5: `
      + `[${scoped.map((v) => v.toFixed(0)).join(', ')}] ms`)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

main().finally(() => pool.end()).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
