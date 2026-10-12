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
 * Repair false ADR tombstones produced by clients that treated a slim static
 * performance ModelMeta as an authoritative inline ADR collection.
 *
 * Stop the API first. The command clears only deterministic `perf-adr-*`
 * tombstones, rematerializes the 100k immutable baseline, then reapplies every
 * legitimate ADR edit/create stored in the bounded ModelMeta overlay.
 */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { ensureAuthSchema } from '../src/auth/schema.js'
import { ensureRbacSchema } from '../src/rbac/schema.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { ensureTagSchema } from '../src/tags/schema.js'
import { ensureTechnologySchema } from '../src/technologies/schema.js'
import { preparePerformanceCatalog } from '../src/performanceSeed/catalog.js'
import { PerformanceSeedPlan } from '../src/performanceSeed/generator.js'
import { performanceTeamIds } from '../src/performanceSeed/principals.js'
import { materializePerformanceDecisionRecords } from '../src/performanceSeed/readModel.js'
import { FULL_PERFORMANCE_SEED_SCALE } from '../src/performanceSeed/types.js'
import { upsertDecisionRecords } from '../src/readModel/derivedStats.js'

interface RepairMeta {
  staticBaseline?: boolean
  deletedDecisionRecordIds?: string[]
  decisionRecords?: Record<string, Record<string, unknown>>
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  if (process.env.PERFORMANCE_SEED !== 'on') throw new Error('PERFORMANCE_SEED=on is required')
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-reset-adr-tombstones')) {
    throw new Error('--confirm-reset-adr-tombstones is required')
  }
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

  const versionResult = await pool.query<{ root_url: string; source: string }>(
    `SELECT version.root_url, workspace.source
     FROM versions version
     JOIN landscapes landscape ON landscape.id = version.landscape_id
     JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id AND workspace.version_id = version.id
     WHERE version.landscape_id = $1 AND version.id = $2 AND landscape.org_id = $3`,
    [landscapeId, versionId, orgId],
  )
  const target = versionResult.rows[0]
  if (!target || !isValidAutomergeUrl(target.root_url)
      || target.source !== 'performance-seed-editable') {
    throw new Error('Editable static performance workspace was not found')
  }

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })
  const rootHandle = await repo.find<{ modelMetaUrl?: string }>(target.root_url as AutomergeUrl)
  await rootHandle.whenReady()
  const modelMetaUrl = rootHandle.doc()?.modelMetaUrl
  if (!modelMetaUrl || !isValidAutomergeUrl(modelMetaUrl)) {
    throw new Error('Performance ModelMeta was not found')
  }
  const metaHandle = await repo.find<RepairMeta>(modelMetaUrl as AutomergeUrl)
  await metaHandle.whenReady()
  const meta = metaHandle.doc()
  if (meta?.staticBaseline !== true) throw new Error('ModelMeta is not a static baseline')

  const deleted = [...new Set(meta.deletedDecisionRecordIds ?? [])]
  const falseBaselineTombstones = deleted.filter((id) => /^perf-adr-\d{6}$/.test(id))
  const retainedTombstones = deleted.filter((id) => !/^perf-adr-\d{6}$/.test(id))
  const overlay = Object.values(meta.decisionRecords ?? {})
  metaHandle.change((draft) => {
    draft.deletedDecisionRecordIds = retainedTombstones
  })
  await repo.flush([metaHandle.documentId])

  const tags = await preparePerformanceCatalog(pool, orgId, actorUserId)
  const plan = new PerformanceSeedPlan({
    scale: FULL_PERFORMANCE_SEED_SCALE,
    tags,
    teamIds: performanceTeamIds(orgId, FULL_PERFORMANCE_SEED_SCALE.teams),
  })
  await materializePerformanceDecisionRecords(pool, key, orgId, plan, (progress) => {
    if (progress.completed === progress.total || progress.completed % 10_000 === 0) {
      console.log(`[performance-adr-repair] ${progress.message}`)
    }
  })
  await upsertDecisionRecords(pool, key, orgId, overlay)

  const countResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ro_decision_records
     WHERE landscape_id = $1 AND version_id = $2`,
    [landscapeId, versionId],
  )
  await repo.shutdown()
  console.log(JSON.stringify({
    status: 'complete',
    landscapeId,
    versionId,
    clearedPerformanceTombstones: falseBaselineTombstones.length,
    retainedNonPerformanceTombstones: retainedTombstones.length,
    reappliedOverlayRecords: overlay.length,
    decisionRecords: Number(countResult.rows[0]?.count ?? 0),
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-adr-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
