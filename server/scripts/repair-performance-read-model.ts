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
 * One-time upgrader for performance workspaces created before static read-model
 * materialization was part of `seed:performance`.
 *
 * Stop the API first: this reads the existing registry to recover the exact
 * diagram-document URLs, materializes PostgreSQL rows, then marks the root for
 * bounded boot-from-server loading.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
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
import { materializePerformanceReadModel } from '../src/performanceSeed/readModel.js'
import { FULL_PERFORMANCE_SEED_SCALE } from '../src/performanceSeed/types.js'

type RegistryEntry = readonly [diagramId: string, docUrl: string]

function readRegistryEntries(shardUrl: AutomergeUrl): RegistryEntry[] {
  // Automerge's WASM arena is not fully returned by Repo.shutdown() in a long
  // loop. One short child per oversized registry shard provides a hard memory
  // boundary and keeps the parent flat even for 500-shape compositions.
  const stdout = execFileSync(process.execPath, [
    '--max-old-space-size=8192',
    'node_modules/tsx/dist/cli.mjs',
    'scripts/read-performance-registry-shard.ts',
    shardUrl,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout) as RegistryEntry[]
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
  if (!args.includes('--confirm-large-seed')) throw new Error('--confirm-large-seed is required')
  const orgId = valueAfter(args, '--org-id')
  const actorUserId = valueAfter(args, '--actor-user-id')
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')

  await initSchema()
  await ensureAuthSchema(pool)
  await ensureRbacSchema(pool)
  await ensureTagSchema(pool)
  await ensureTechnologySchema(pool)
  await ensureReadModelSchema(pool)

  const { rows } = await pool.query<{ root_url: string }>(
    `SELECT version.root_url
     FROM versions version
     JOIN landscapes landscape ON landscape.id = version.landscape_id
     WHERE landscape.id = $1 AND version.id = $2 AND landscape.org_id = $3`,
    [landscapeId, versionId, orgId],
  )
  const rootUrl = rows[0]?.root_url
  if (!rootUrl || !isValidAutomergeUrl(rootUrl)) throw new Error('Performance workspace root was not found')

  const tags = await preparePerformanceCatalog(pool, orgId, actorUserId)
  const plan = new PerformanceSeedPlan({
    scale: FULL_PERFORMANCE_SEED_SCALE,
    tags,
    teamIds: performanceTeamIds(orgId, FULL_PERFORMANCE_SEED_SCALE.teams),
  })
  const storage = new PostgresStorageAdapter({ db: pool })
  const rootRepo = new Repo({ storage, network: [], saveDebounceRate: 0 })
  const rootHandle = await rootRepo.find<Record<string, unknown>>(rootUrl as AutomergeUrl)
  await rootHandle.whenReady()
  const shardUrls = (rootHandle.doc()?.shardUrls ?? []) as string[]
  if (!shardUrls.length) throw new Error('Performance root has no registry shards')

  const diagramDocumentUrls = Array<string>(plan.diagramCount)
  for (let shardIndex = 0; shardIndex < shardUrls.length; shardIndex += 1) {
    const shardUrl = shardUrls[shardIndex]
    if (!isValidAutomergeUrl(shardUrl)) throw new Error(`Invalid registry shard URL at ${shardIndex}`)
    const entries = readRegistryEntries(shardUrl as AutomergeUrl)
    for (const [diagramId, docUrl] of entries) {
      const index = Number(diagramId.slice('perf-dg-'.length))
      if (!Number.isSafeInteger(index) || index < 0 || index >= plan.diagramCount) continue
      diagramDocumentUrls[index] = docUrl
    }
    if ((shardIndex + 1) % 10 === 0 || shardIndex + 1 === shardUrls.length) {
      console.log(`[performance-repair] registry ${shardIndex + 1} / ${shardUrls.length}`)
    }
  }
  const missing = diagramDocumentUrls.findIndex((url) => !url)
  if (missing >= 0) throw new Error(`Missing diagram document URL at index ${missing}`)

  await materializePerformanceReadModel({
    db: pool,
    key: { landscapeId, versionId },
    orgId,
    plan,
    diagramDocumentUrls,
    onProgress: (progress) => {
      const percent = Math.floor((progress.completed / progress.total) * 100)
      if (progress.completed === progress.total || percent % 5 === 0) {
        console.log(`[performance-repair] ${progress.phase} ${percent}% - ${progress.message}`)
      }
    },
  })

  rootHandle.change((root) => {
    root.registrySummaryOnly = true
    root.diagramCount = plan.diagramCount
  })
  await rootRepo.flush([rootHandle.documentId])
  await rootRepo.shutdown()
  console.log(JSON.stringify({
    status: 'complete', orgId, landscapeId, versionId,
    objects: plan.scale.objects,
    connections: plan.scale.connections,
    diagrams: plan.diagramCount,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
