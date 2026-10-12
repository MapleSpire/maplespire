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

import 'dotenv/config'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { bumpDiagramRenderGenerations } from '../src/readModel/diagramRenderGeneration.js'
import { roRelatedDiagrams } from '../src/readModel/queries.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'

const connectionString = process.env.DIAGRAM_FANOUT_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) throw new Error('Set DIAGRAM_FANOUT_DATABASE_URL or DATABASE_URL')

const fanout = positiveInt('DIAGRAM_FANOUT_COUNT', 10_000)
const iterations = positiveInt('DIAGRAM_FANOUT_ITERATIONS', 15)
const queryBudgetMs = positiveInt('DIAGRAM_FANOUT_QUERY_P95_MS', 200)
const invalidationBudgetMs = positiveInt('DIAGRAM_FANOUT_INVALIDATION_P99_MS', 2_000)
const payloadBudgetBytes = positiveInt('DIAGRAM_FANOUT_PAYLOAD_BYTES', 262_144)
const targetObjectId = `__fanout_gate_${process.pid}_${Date.now()}`

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

async function measure(operation: () => Promise<unknown>): Promise<number[]> {
  for (let index = 0; index < 2; index += 1) await operation()
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    await operation()
    samples.push(performance.now() - startedAt)
  }
  return samples
}

const pool = guardIdleClientErrors(new pg.Pool({ connectionString, max: 2 }), 'diagramFanoutGate')
const client = await pool.connect()
let transactionOpen = false
try {
  await client.query('BEGIN')
  transactionOpen = true
  const workspaceResult = await client.query<WorkspaceKey & { diagram_count: string }>(
    `SELECT landscape_id AS "landscapeId", version_id AS "versionId", count(*)::text AS diagram_count
     FROM ro_diagrams
     GROUP BY landscape_id, version_id
     HAVING count(*) >= $1
     ORDER BY count(*) DESC
     LIMIT 1`,
    [fanout],
  )
  const workspace = workspaceResult.rows[0]
  if (!workspace) throw new Error(`No read-model workspace contains ${fanout} diagrams`)

  await client.query(
    `INSERT INTO ro_objects (
       landscape_id, version_id, id, type, name, data
     ) VALUES ($1, $2, $3, 'component', 'Fan-out load gate', $4::jsonb)`,
    [workspace.landscapeId, workspace.versionId, targetObjectId, JSON.stringify({
      id: targetObjectId, type: 'component', name: 'Fan-out load gate',
    })],
  )
  const membershipInsert = await client.query(
    `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
     SELECT diagram.landscape_id, diagram.version_id, diagram.org_id, diagram.id, $3
     FROM ro_diagrams diagram
     WHERE diagram.landscape_id = $1 AND diagram.version_id = $2
     ORDER BY diagram.id COLLATE "C"
     LIMIT $4`,
    [workspace.landscapeId, workspace.versionId, targetObjectId, fanout],
  )
  if (membershipInsert.rowCount !== fanout) {
    throw new Error(`Expected ${fanout} reversible memberships, inserted ${membershipInsert.rowCount ?? 0}`)
  }

  let related = await roRelatedDiagrams(client, workspace, targetObjectId, null, { limit: 50 })
  const querySamples = await measure(async () => {
    related = await roRelatedDiagrams(client, workspace, targetObjectId, null, { limit: 50 })
  })
  const payloadBytes = Buffer.byteLength(JSON.stringify(related))
  let generationBase = Date.now()
  let invalidatedCount = 0
  const invalidationSamples = await measure(async () => {
    invalidatedCount = await bumpDiagramRenderGenerations(client, workspace, generationBase++, {
      objectIds: [targetObjectId],
    })
  })

  const result = {
    workspace: { landscapeId: workspace.landscapeId, versionId: workspace.versionId },
    fixture: { fanout, reversible: true, persisted: false },
    relatedDiagrams: {
      returned: related.reference.length,
      total: related.totals.reference,
      truncated: related.truncated,
      payloadBytes,
      p50Ms: percentile(querySamples, 0.5),
      p95Ms: percentile(querySamples, 0.95),
      maxMs: Math.max(...querySamples),
      budgetP95Ms: queryBudgetMs,
      budgetPayloadBytes: payloadBudgetBytes,
    },
    invalidation: {
      affectedDiagrams: invalidatedCount,
      p50Ms: percentile(invalidationSamples, 0.5),
      p95Ms: percentile(invalidationSamples, 0.95),
      p99Ms: percentile(invalidationSamples, 0.99),
      maxMs: Math.max(...invalidationSamples),
      budgetP99Ms: invalidationBudgetMs,
    },
  }
  const failures = [
    related.reference.length !== Math.min(50, fanout) && 'related result is not bounded',
    related.totals.reference !== fanout && 'related total does not expose complete fan-out',
    !related.truncated && 'related result does not disclose truncation',
    payloadBytes > payloadBudgetBytes && 'related payload exceeds byte budget',
    percentile(querySamples, 0.95) > queryBudgetMs && 'related query exceeds p95 budget',
    invalidatedCount !== fanout && 'generation invalidation missed affected diagrams',
    percentile(invalidationSamples, 0.99) > invalidationBudgetMs && 'generation invalidation exceeds p99 budget',
  ].filter(Boolean)
  console.log(JSON.stringify({ outcome: failures.length ? 'failed' : 'passed', failures, ...result }, null, 2))
  if (failures.length) process.exitCode = 1
} finally {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
  client.release()
  await pool.end()
}
