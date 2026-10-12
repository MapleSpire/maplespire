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

import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { roObjectSearchPage, roObjectTreeChildren } from '../src/readModel/objectExplorer.js'
import { roConnectionExplorerPage } from '../src/readModel/connectionExplorer.js'
import { roDecisionRecordPage } from '../src/readModel/decisionRecords.js'
import { roDependencyPeerPage } from '../src/readModel/dependencyExplorer.js'
import { roDiagramListPage } from '../src/readModel/diagramList.js'
import { rebuildReadModelDerivedStats } from '../src/readModel/derivedStats.js'
import { roViewerLevel } from '../src/readModel/viewerLevel.js'
import { encodeReadModelCursor, readModelQueryHash } from '../src/readModel/cursor.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import type { Queryable } from '../src/readModel/types.js'
import {
  deepSearchAdrIndex,
  loadAdrCreatedAt,
  loadAdrId,
  planReadModelLoadSeed,
} from './read-model-load-plan.js'

const connectionString = process.env.READ_MODEL_LOAD_DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!connectionString) {
  throw new Error(
    'Set READ_MODEL_LOAD_DATABASE_URL (or TEST_DATABASE_URL) to a disposable PostgreSQL database. ' +
      'The gate creates and removes one isolated schema; it never writes to public.',
  )
}

const objectCount = positiveInt('READ_MODEL_LOAD_OBJECTS', 100_000)
const connectionCount = positiveInt('READ_MODEL_LOAD_CONNECTIONS', 300_000)
const decisionRecordCount = positiveInt('READ_MODEL_LOAD_ADRS', 100_000)
const iterations = positiveInt('READ_MODEL_LOAD_ITERATIONS', 15)
const searchP95BudgetMs = positiveInt('READ_MODEL_LOAD_SEARCH_P95_MS', 200)
const boundedQueryP95BudgetMs = positiveInt('READ_MODEL_LOAD_QUERY_P95_MS', 500)
const pagedSqlP95BudgetMs = positiveInt('READ_MODEL_LOAD_PAGED_P95_MS', 100)
const connectionP95BudgetMs = positiveInt('READ_MODEL_LOAD_CONNECTION_P95_MS', 200)
const seedTimeoutMs = positiveInt('READ_MODEL_LOAD_SEED_TIMEOUT_MS', 300_000)
const schemaName = `rm_load_${process.pid}_${Date.now()}`
const quotedSchema = quoteIdentifier(schemaName)
const workspace: WorkspaceKey = { landscapeId: 'load-landscape', versionId: 'current' }
const seedPlan = planReadModelLoadSeed({ objectCount, connectionCount, decisionRecordCount })

interface Measurement {
  name: string
  samples: number[]
  p50: number
  p95: number
  max: number
  budget: number
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

async function measure(
  name: string,
  budget: number,
  operation: () => Promise<unknown>,
): Promise<Measurement> {
  // Warm both PostgreSQL buffers and prepared execution paths before samples.
  for (let index = 0; index < 3; index += 1) await operation()
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    await operation()
    samples.push(performance.now() - startedAt)
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    name,
    samples,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    budget,
  }
}

async function seed(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO ro_diagrams (
       landscape_id, version_id, org_id, id, parent_object_id, object_ids, data
     ) VALUES (
       $1, $2, 'load-org', 'diagram-load', NULL, '{}'::text[],
       '{"id":"diagram-load","name":"Load architecture","type":"context"}'::jsonb
     )`,
    [workspace.landscapeId, workspace.versionId],
  )

  await client.query(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, observed_generation, projected_generation,
       projector_attached, updated_at
     ) VALUES ($1, $2, 1, 1, true, now())`,
    [workspace.landscapeId, workspace.versionId],
  )

  await client.query(
    `INSERT INTO ro_objects (
       landscape_id, version_id, org_id, id, type, name, description,
       technology, domain_id, parent_id, effective_parent_id, scope, status, data
     )
     SELECT $1, $2, 'load-org',
       'obj-' || lpad(value::text, 6, '0'),
       CASE value % 5
         WHEN 0 THEN 'system' WHEN 1 THEN 'app' WHEN 2 THEN 'store'
         WHEN 3 THEN 'component' ELSE 'actor' END,
       CASE WHEN value % 1000 = 0
         THEN 'Checkout service ' || lpad(value::text, 6, '0')
         ELSE 'Service ' || lpad(value::text, 6, '0') END,
       CASE WHEN value % 1000 = 0 THEN 'Checkout workload' ELSE '' END,
       CASE WHEN value % 11 = 0 THEN 'PostgreSQL' ELSE '' END,
       'domain-' || (value % 20)::text,
       CASE WHEN value <= 100 THEN NULL
         ELSE 'obj-' || lpad((((value - 1) % 100) + 1)::text, 6, '0') END,
       CASE WHEN value <= 100 THEN NULL
         ELSE 'obj-' || lpad((((value - 1) % 100) + 1)::text, 6, '0') END,
       CASE WHEN value % 2 = 0 THEN 'internal' ELSE 'external' END,
       CASE WHEN value % 7 = 0 THEN 'deprecated' ELSE 'live' END,
       jsonb_build_object(
         'id', 'obj-' || lpad(value::text, 6, '0'),
         'name', CASE WHEN value % 1000 = 0
           THEN 'Checkout service ' || lpad(value::text, 6, '0')
           ELSE 'Service ' || lpad(value::text, 6, '0') END,
         'type', CASE value % 5
           WHEN 0 THEN 'system' WHEN 1 THEN 'app' WHEN 2 THEN 'store'
           WHEN 3 THEN 'component' ELSE 'actor' END,
         'parentId', CASE WHEN value <= 100 THEN NULL
           ELSE 'obj-' || lpad((((value - 1) % 100) + 1)::text, 6, '0') END
       )
     FROM generate_series(1, $3::int) AS value`,
    [workspace.landscapeId, workspace.versionId, objectCount],
  )

  if (seedPlan.denseDiagram.count > 0) {
    const denseEligibleObjects = seedPlan.denseDiagram.objectCount - 3
    await client.query(
      `INSERT INTO ro_connections (
         landscape_id, version_id, org_id, id, from_id, to_id, label, kind, data
       )
       SELECT $1, $2, 'load-org',
         'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
         'obj-' || lpad((4 + ((value - 1) % $5::int))::text, 6, '0'),
         'obj-' || lpad((4 + (value % $5::int))::text, 6, '0'),
         'Dense transactional path', 'direct',
         jsonb_build_object(
           'id', 'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
           'from', 'obj-' || lpad((4 + ((value - 1) % $5::int))::text, 6, '0'),
           'to', 'obj-' || lpad((4 + (value % $5::int))::text, 6, '0'),
           'label', 'Dense transactional path'
         )
       FROM generate_series(1, $4::int) AS value`,
      [
        workspace.landscapeId,
        workspace.versionId,
        seedPlan.denseDiagram.first,
        seedPlan.denseDiagram.count,
        denseEligibleObjects,
      ],
    )
  }

  for (const hub of seedPlan.dependencyHubs) {
    if (hub.count === 0) continue
    await client.query(
      `INSERT INTO ro_connections (
         landscape_id, version_id, org_id, id, from_id, to_id, label, kind, data
       )
       SELECT $1, $2, 'load-org',
         'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
         'obj-' || lpad($5::text, 6, '0'),
         'obj-' || lpad((CASE WHEN value >= $5::int THEN value + 1 ELSE value END)::text, 6, '0'),
         'Dependency hub ' || $6::text, 'direct',
         jsonb_build_object(
           'id', 'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
           'from', 'obj-' || lpad($5::text, 6, '0'),
           'to', 'obj-' || lpad((CASE WHEN value >= $5::int THEN value + 1 ELSE value END)::text, 6, '0'),
           'label', 'Dependency hub ' || $6::text
         )
       FROM generate_series(1, $4::int) AS value`,
      [
        workspace.landscapeId,
        workspace.versionId,
        hub.first,
        hub.count,
        hub.focusIndex,
        hub.requestedPeers,
      ],
    )
  }

  if (seedPlan.baselineConnections.count > 0) {
    await client.query(
      `INSERT INTO ro_connections (
         landscape_id, version_id, org_id, id, from_id, to_id, label, kind, data
       )
       SELECT $1, $2, 'load-org',
         'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
         'obj-' || lpad((4 + ((value - 1) % ($5::int - 3)))::text, 6, '0'),
         'obj-' || lpad((1 + ((value + 7918) % $5::int))::text, 6, '0'),
         CASE WHEN value % 3000 = 0 THEN 'Checkout event' ELSE 'Calls' END,
         'direct',
         jsonb_build_object(
           'id', 'conn-' || lpad(($3::int + value - 1)::text, 7, '0'),
           'from', 'obj-' || lpad((4 + ((value - 1) % ($5::int - 3)))::text, 6, '0'),
           'to', 'obj-' || lpad((1 + ((value + 7918) % $5::int))::text, 6, '0'),
           'label', CASE WHEN value % 3000 = 0 THEN 'Checkout event' ELSE 'Calls' END
         )
       FROM generate_series(1, $4::int) AS value`,
      [
        workspace.landscapeId,
        workspace.versionId,
        seedPlan.baselineConnections.first,
        seedPlan.baselineConnections.count,
        objectCount,
      ],
    )
  }

  const deepAdrIndex = deepSearchAdrIndex(decisionRecordCount)
  await client.query(
    `INSERT INTO ro_decision_records (
       landscape_id, version_id, org_id, id, title, status,
       created_at, updated_at, adr_number, data
     )
     SELECT $1, $2, 'load-org',
       'adr-load-' || lpad(value::text, 6, '0'),
       CASE WHEN value = $4::int
         THEN 'Quorum atlas deep-search migration ' || lpad(value::text, 6, '0')
         ELSE 'Architecture decision ' || lpad(value::text, 6, '0') END,
       CASE value % 5 WHEN 0 THEN 'in-progress' WHEN 1 THEN 'rejected' ELSE 'approved' END,
       to_char(TIMESTAMPTZ '2020-01-01T00:00:00.000Z' + value * INTERVAL '1 second',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(TIMESTAMPTZ '2020-01-01T00:00:00.000Z' + value * INTERVAL '1 second',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       value,
       jsonb_build_object(
         'id', 'adr-load-' || lpad(value::text, 6, '0'),
         'number', value,
         'title', CASE WHEN value = $4::int
           THEN 'Quorum atlas deep-search migration ' || lpad(value::text, 6, '0')
           ELSE 'Architecture decision ' || lpad(value::text, 6, '0') END,
         'summary', 'Govern a bounded architecture change for load validation.',
         'status', CASE value % 5 WHEN 0 THEN 'in-progress' WHEN 1 THEN 'rejected' ELSE 'approved' END,
         'author', 'load-architect-' || lpad((value % 250)::text, 3, '0'),
         'createdAt', to_char(TIMESTAMPTZ '2020-01-01T00:00:00.000Z' + value * INTERVAL '1 second',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'updatedAt', to_char(TIMESTAMPTZ '2020-01-01T00:00:00.000Z' + value * INTERVAL '1 second',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'content', CASE WHEN value = $4::int
           THEN 'Quorum atlas validates a selective deep-search hit without scanning every ADR payload.'
           ELSE 'Use bounded retries, idempotency, telemetry and automated recovery.' END,
         'related', jsonb_build_array(
           jsonb_build_object('id', 'adr-diagram-' || value::text, 'type', 'diagram',
             'label', 'Load architecture', 'targetId', 'diagram-load'),
           jsonb_build_object('id', 'adr-link-' || value::text, 'type', 'url',
             'label', 'PostgreSQL architecture', 'url', 'https://www.postgresql.org/docs/current/')
         )
       )
     FROM generate_series(1, $3::int) AS value`,
    [workspace.landscapeId, workspace.versionId, decisionRecordCount, deepAdrIndex],
  )

  await client.query(
    `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
     SELECT $1, $2, 'load-org', 'diagram-load',
       'obj-' || lpad(value::text, 6, '0')
     FROM generate_series(1, $3::int) AS value`,
    [workspace.landscapeId, workspace.versionId, seedPlan.denseDiagram.objectCount],
  )
  await client.query(
    `INSERT INTO ro_diagram_connections (landscape_id, version_id, org_id, diagram_id, connection_id)
     SELECT $1, $2, 'load-org', 'diagram-load',
       'conn-' || lpad(value::text, 7, '0')
     FROM generate_series($3::int, $3::int + $4::int - 1) AS value`,
    [
      workspace.landscapeId,
      workspace.versionId,
      seedPlan.denseDiagram.first,
      seedPlan.denseDiagram.count,
    ],
  )
  await rebuildReadModelDerivedStats(client, workspace, 'load-org')
  await client.query('ANALYZE')

  const derived = await client.query<{
    decision_records: string
    dense_connections: string
    dense_objects: string
    diagrams: string
    connections: string
    objects: string
  }>(
    `SELECT
       (SELECT count(*) FROM ro_diagram_summaries
        WHERE landscape_id = $1 AND version_id = $2)::text AS diagrams,
       (SELECT count(*) FROM ro_connection_stats
        WHERE landscape_id = $1 AND version_id = $2)::text AS connections,
       COALESCE((SELECT object_count FROM ro_workspace_stats
        WHERE landscape_id = $1 AND version_id = $2), 0)::text AS objects,
       COALESCE((SELECT decision_record_count FROM ro_workspace_stats
        WHERE landscape_id = $1 AND version_id = $2), 0)::text AS decision_records,
       (SELECT count(*) FROM ro_diagram_objects
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'diagram-load')::text AS dense_objects,
       (SELECT count(*) FROM ro_diagram_connections
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'diagram-load')::text AS dense_connections`,
    [workspace.landscapeId, workspace.versionId],
  )
  const counts = derived.rows[0]
  if (Number(counts?.diagrams) !== 1 || Number(counts?.connections) !== connectionCount ||
      Number(counts?.objects) !== objectCount ||
      Number(counts?.decision_records) !== decisionRecordCount ||
      Number(counts?.dense_objects) !== seedPlan.denseDiagram.objectCount ||
      Number(counts?.dense_connections) !== seedPlan.denseDiagram.count) {
    throw new Error(`Derived read-model seed mismatch: ${JSON.stringify(counts)}`)
  }
}

function traced(db: Queryable, surface: string): Queryable {
  return {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
      const startedAt = performance.now()
      const result = await db.query<R>(text, params)
      console.log(JSON.stringify({
        phase: 'trace', surface,
        sql: text.replace(/\s+/g, ' ').trim().slice(0, 120),
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        rows: result.rowCount,
      }))
      return result
    },
  }
}

function lastAdrPageCursor(limit = 50): string | null {
  if (decisionRecordCount <= limit) return null
  const afterIndex = limit + 1
  const queryHash = readModelQueryHash({
    kind: 'decision-records',
    landscapeId: workspace.landscapeId,
    versionId: workspace.versionId,
    query: '',
    status: '',
  })
  return encodeReadModelCursor({
    kind: 'decision-record-page',
    queryHash,
    createdAt: loadAdrCreatedAt(afterIndex),
    id: loadAdrId(afterIndex),
  })
}

async function verifyAdversarialSeed(db: Queryable): Promise<Map<string, string | null>> {
  const adrFirst = await roDecisionRecordPage(db, workspace, { limit: 50 })
  if (adrFirst.total !== decisionRecordCount || adrFirst.items[0]?.id !== loadAdrId(decisionRecordCount)) {
    throw new Error(
      `ADR first-page seed mismatch: total=${adrFirst.total}, first=${adrFirst.items[0]?.id ?? 'missing'}`,
    )
  }
  const lastCursor = lastAdrPageCursor()
  const adrLast = await roDecisionRecordPage(db, workspace, { after: lastCursor, limit: 50 })
  if (adrLast.items.at(-1)?.id !== loadAdrId(1)) {
    throw new Error(`ADR last-page seed mismatch: last=${adrLast.items.at(-1)?.id ?? 'missing'}`)
  }
  const deepId = loadAdrId(deepSearchAdrIndex(decisionRecordCount))
  const deepSearch = await roDecisionRecordPage(db, workspace, { query: 'quorum atlas', limit: 50 })
  if (deepSearch.total !== 1 || deepSearch.items[0]?.id !== deepId) {
    throw new Error(
      `ADR deep-search seed mismatch: total=${deepSearch.total}, first=${deepSearch.items[0]?.id ?? 'missing'}`,
    )
  }

  const hubCursors = new Map<string, string | null>()
  for (const hub of seedPlan.dependencyHubs) {
    if (hub.peerCount === 0) continue
    const first = await roDependencyPeerPage(db, workspace, {
      focusId: hub.focusId,
      direction: 'outgoing',
      limit: 50,
    })
    if (first.totalPeers !== hub.peerCount || first.totalConnections !== hub.count) {
      throw new Error(
        `Dependency hub ${hub.requestedPeers} mismatch: ` +
        `peers=${first.totalPeers}/${hub.peerCount}, connections=${first.totalConnections}/${hub.count}`,
      )
    }
    if (hub.peerCount > 50 && !first.nextCursor) {
      throw new Error(`Dependency hub ${hub.requestedPeers} did not produce a second-page cursor`)
    }
    hubCursors.set(hub.focusId, first.nextCursor)
  }
  return hubCursors
}

async function main(): Promise<void> {
  const adminPool = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 }), 'readModelLoadGate:admin')
  let loadPool: pg.Pool | undefined
  let created = false
  let failure: Error | undefined
  try {
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`)
    created = true
    loadPool = guardIdleClientErrors(new pg.Pool({
      connectionString,
      max: 8,
      connectionTimeoutMillis: 10_000,
      options: `-c search_path=${schemaName},public -c statement_timeout=30000`,
    }), 'readModelLoadGate:load')
    await ensureReadModelSchema(loadPool)

    const seedStartedAt = performance.now()
    const seedClient = await loadPool.connect()
    try {
      await seedClient.query(`SELECT set_config('statement_timeout', $1, false)`, [`${seedTimeoutMs}ms`])
      await seed(seedClient)
    } finally {
      await seedClient.query(`SELECT set_config('statement_timeout', '30000ms', false)`).catch(() => undefined)
      seedClient.release()
    }
    const seedMs = performance.now() - seedStartedAt
    console.log(JSON.stringify({
      phase: 'seed',
      objectCount,
      connectionCount,
      decisionRecordCount,
      denseDiagram: {
        objects: seedPlan.denseDiagram.objectCount,
        connections: seedPlan.denseDiagram.count,
      },
      dependencyHubs: seedPlan.dependencyHubs.map((hub) => ({
        requestedPeers: hub.requestedPeers,
        actualPeers: hub.peerCount,
        focusId: hub.focusId,
      })),
      limitations: seedPlan.limitations,
      durationMs: Math.round(seedMs),
    }))
    for (const limitation of seedPlan.limitations) {
      console.warn(JSON.stringify({ phase: 'scale-limit', message: limitation }))
    }

    const hubCursors = await verifyAdversarialSeed(loadPool)

    if (process.env.READ_MODEL_LOAD_TRACE === 'true') {
      await roObjectTreeChildren(traced(loadPool, 'object-tree-roots'), workspace, {
        diagramId: 'diagram-load', limit: 50,
      })
      await roConnectionExplorerPage(traced(loadPool, 'connection-page'), workspace, { limit: 50 })
      await roDecisionRecordPage(traced(loadPool, 'adr-page-first'), workspace, { limit: 50 })
      await roDecisionRecordPage(traced(loadPool, 'adr-search-deep'), workspace, {
        query: 'quorum atlas', limit: 50,
      })
      const largestHub = seedPlan.dependencyHubs.at(-1)
      if (largestHub?.peerCount) {
        await roDependencyPeerPage(traced(loadPool, 'dependency-hub-largest'), workspace, {
          focusId: largestHub.focusId, direction: 'outgoing', limit: 50,
        })
      }
    }

    // Run cases sequentially: concurrent samples would measure pool contention,
    // not the latency of one interactive user operation.
    const measurements: Measurement[] = []
    measurements.push(await measure('object-tree-roots', boundedQueryP95BudgetMs, () =>
      roObjectTreeChildren(loadPool!, workspace, { diagramId: 'diagram-load', limit: 50 })))
    measurements.push(await measure('object-search-checkout', searchP95BudgetMs, () =>
      roObjectSearchPage(loadPool!, workspace, { query: 'checkout', diagramId: 'diagram-load', limit: 50 })))
    measurements.push(await measure('object-search-prefix-ch', searchP95BudgetMs, () =>
      roObjectSearchPage(loadPool!, workspace, { query: 'ch', diagramId: 'diagram-load', limit: 50 })))
    measurements.push(await measure('connection-page', connectionP95BudgetMs, () =>
      roConnectionExplorerPage(loadPool!, workspace, { limit: 50 })))
    measurements.push(await measure('connection-page-sender', connectionP95BudgetMs, () =>
      roConnectionExplorerPage(loadPool!, workspace, { sortBy: 'sender', limit: 50 })))
    measurements.push(await measure('connection-page-diagrams', connectionP95BudgetMs, () =>
      roConnectionExplorerPage(loadPool!, workspace, { sortBy: 'diagrams', sortAsc: false, limit: 50 })))
    measurements.push(await measure('diagram-page', pagedSqlP95BudgetMs, () =>
      roDiagramListPage(loadPool!, workspace, { limit: 50 })))
    measurements.push(await measure('adr-page-first', pagedSqlP95BudgetMs, () =>
      roDecisionRecordPage(loadPool!, workspace, { limit: 50 })))
    measurements.push(await measure('adr-page-last', pagedSqlP95BudgetMs, () =>
      roDecisionRecordPage(loadPool!, workspace, { after: lastAdrPageCursor(), limit: 50 })))
    measurements.push(await measure('adr-search-deep', searchP95BudgetMs, () =>
      roDecisionRecordPage(loadPool!, workspace, { query: 'quorum atlas', limit: 50 })))
    measurements.push(await measure('connection-search-checkout', connectionP95BudgetMs, () =>
      roConnectionExplorerPage(loadPool!, workspace, { query: 'checkout', limit: 50 })))
    for (const hub of seedPlan.dependencyHubs) {
      if (hub.peerCount === 0) continue
      const label = hub.requestedPeers.toLocaleString('en-US', { useGrouping: false })
      measurements.push(await measure(`dependency-hub-${label}-page-first`, boundedQueryP95BudgetMs, () =>
        roDependencyPeerPage(loadPool!, workspace, {
          focusId: hub.focusId, direction: 'outgoing', limit: 50,
        })))
      const after = hubCursors.get(hub.focusId)
      if (after) {
        measurements.push(await measure(`dependency-hub-${label}-page-second`, boundedQueryP95BudgetMs, () =>
          roDependencyPeerPage(loadPool!, workspace, {
            focusId: hub.focusId, direction: 'outgoing', after, limit: 50,
          })))
      }
    }
    measurements.push(await measure('viewer-root-level', pagedSqlP95BudgetMs, () =>
      roViewerLevel(loadPool!, workspace, { limit: 50, connectionLimit: 500 })))

    for (const result of measurements) {
      console.log(JSON.stringify({
        phase: 'query', name: result.name,
        p50Ms: Number(result.p50.toFixed(1)),
        p95Ms: Number(result.p95.toFixed(1)),
        maxMs: Number(result.max.toFixed(1)),
        budgetMs: result.budget,
        passed: result.p95 <= result.budget,
      }))
    }
    const failures = measurements.filter((result) => result.p95 > result.budget)
    if (failures.length) {
      failure = new Error(
        `Read-model load gate failed: ${failures.map((item) => `${item.name} p95=${item.p95.toFixed(1)}ms`).join(', ')}`,
      )
    }
  } finally {
    await loadPool?.end()
    if (created) await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`)
    await adminPool.end()
  }
  if (failure) throw failure
}

await main()
