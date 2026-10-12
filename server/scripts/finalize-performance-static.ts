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
 * Finish the bounded static projection for an already-materialized performance
 * workspace. This deliberately does not replay objects, connections, principals,
 * memberships, or Automerge documents.
 */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { ensureAuthSchema } from '../src/auth/schema.js'
import { ensureRbacSchema } from '../src/rbac/schema.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { markStaticReadModelWorkspace } from '../src/readModel/staticWorkspace.js'
import { ensureTagSchema } from '../src/tags/schema.js'
import { ensureTechnologySchema } from '../src/technologies/schema.js'
import { preparePerformanceCatalog } from '../src/performanceSeed/catalog.js'
import { PerformanceSeedPlan } from '../src/performanceSeed/generator.js'
import { performanceTeamIds } from '../src/performanceSeed/principals.js'
import {
  materializePerformanceDecisionRecords,
  materializePerformanceDiagramData,
  performanceEditableDocuments,
} from '../src/performanceSeed/readModel.js'
import { FULL_PERFORMANCE_SEED_SCALE } from '../src/performanceSeed/types.js'

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  if (process.env.PERFORMANCE_SEED !== 'on') throw new Error('PERFORMANCE_SEED=on is required')
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-large-seed')) throw new Error('--confirm-large-seed is required')
  const orgId = valueAfter(args, '--org-id')
  const actorUserId = valueAfter(args, '--actor-user-id')
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')
  const key = { landscapeId, versionId }

  await initSchema()
  await ensureAuthSchema(pool)
  await ensureRbacSchema(pool)
  await ensureTagSchema(pool)
  await ensureTechnologySchema(pool)
  await ensureReadModelSchema(pool)

  const versionResult = await pool.query<{ root_url: string }>(
    `SELECT version.root_url
     FROM versions version
     JOIN landscapes landscape ON landscape.id = version.landscape_id
     WHERE version.landscape_id = $1 AND version.id = $2 AND landscape.org_id = $3`,
    [landscapeId, versionId, orgId],
  )
  const rootUrl = versionResult.rows[0]?.root_url
  if (!rootUrl || !isValidAutomergeUrl(rootUrl)) throw new Error('Performance workspace root was not found')
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })
  const rootHandle = await repo.find<{
    modelMetaUrl?: string
  }>(rootUrl as AutomergeUrl)
  await rootHandle.whenReady()
  const modelMetaUrl = rootHandle.doc()?.modelMetaUrl
  if (!modelMetaUrl || !isValidAutomergeUrl(modelMetaUrl)) throw new Error('Performance model metadata was not found')
  const metaHandle = await repo.find<{
    editsObjectShardUrl?: string
    editsConnectionShardUrl?: string
  }>(modelMetaUrl as AutomergeUrl)
  await metaHandle.whenReady()
  const objectOverlayUrl = metaHandle.doc()?.editsObjectShardUrl
  const connectionOverlayUrl = metaHandle.doc()?.editsConnectionShardUrl
  if (!objectOverlayUrl || !isValidAutomergeUrl(objectOverlayUrl)
      || !connectionOverlayUrl || !isValidAutomergeUrl(connectionOverlayUrl)) {
    throw new Error('Performance edit overlays were not found')
  }
  await repo.shutdown()

  const tags = await preparePerformanceCatalog(pool, orgId, actorUserId)
  const plan = new PerformanceSeedPlan({
    scale: FULL_PERFORMANCE_SEED_SCALE,
    tags,
    teamIds: performanceTeamIds(orgId, FULL_PERFORMANCE_SEED_SCALE.teams),
  })
  const { rows } = await pool.query<{ id: string; doc_url: string | null }>(
    `SELECT id, data->>'docUrl' AS doc_url
     FROM ro_diagrams
     WHERE landscape_id = $1 AND version_id = $2
     ORDER BY id`,
    [landscapeId, versionId],
  )
  if (rows.length !== plan.diagramCount) {
    throw new Error(`Expected ${plan.diagramCount} existing diagrams; got ${rows.length}`)
  }
  const diagramDocumentUrls = Array<string>(plan.diagramCount)
  for (const row of rows) {
    const index = Number(row.id.slice('perf-dg-'.length))
    if (!Number.isSafeInteger(index) || index < 0 || index >= plan.diagramCount || !row.doc_url) {
      throw new Error(`Invalid existing diagram row ${row.id}`)
    }
    diagramDocumentUrls[index] = row.doc_url
  }

  const report = (progress: { phase: string; completed: number; total: number; message: string }) => {
    if (progress.completed === progress.total || progress.completed % 5_000 === 0) {
      console.log(`[performance-finalize] ${progress.phase} - ${progress.message}`)
    }
  }
  await materializePerformanceDecisionRecords(pool, key, orgId, plan, report)
  await materializePerformanceDiagramData(pool, key, orgId, plan, diagramDocumentUrls, report)
  await markStaticReadModelWorkspace(
    pool,
    key,
    'performance-seed-editable',
    performanceEditableDocuments([
      { url: rootUrl, kind: 'root' },
      { url: modelMetaUrl, kind: 'model-meta' },
      { url: objectOverlayUrl, kind: 'object-overlay' },
      { url: connectionOverlayUrl, kind: 'connection-overlay' },
    ], diagramDocumentUrls),
  )
  console.log(JSON.stringify({
    status: 'complete', orgId, landscapeId, versionId,
    decisionRecords: plan.scale.decisionRecords,
    diagrams: plan.diagramCount,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-finalize] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
