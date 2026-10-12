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
 * Distinct, offline enterprise performance seed.
 *
 * The full profile writes 200k C4 objects, 300k connections, 30k diagram docs,
 * 100k ADRs, 20k organization members and 200 teams. It deliberately does not
 * share the org-admin demo endpoint: stop the API first, then run this script so
 * the bulk writer cannot race a live sync-cell storage fence.
 *
 * Examples:
 *   npm run seed:performance -- --profile full --org-id <id> --confirm-large-seed
 *   npm run seed:performance -- --profile smoke --org-id <id>
 *   npm run seed:performance -- --profile full --dry-run
 */
import 'dotenv/config'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { ensureAuthSchema } from '../src/auth/schema.js'
import { ensureRbacSchema } from '../src/rbac/schema.js'
import { ensureTagSchema } from '../src/tags/schema.js'
import { ensureTechnologySchema } from '../src/technologies/schema.js'
import { PerformanceSeedPlan } from '../src/performanceSeed/generator.js'
import { performanceTeamIds } from '../src/performanceSeed/principals.js'
import { seedPerformanceEnvironment } from '../src/performanceSeed/provision.js'
import {
  FULL_PERFORMANCE_SEED_SCALE,
  SMOKE_PERFORMANCE_SEED_SCALE,
  type PerformanceSeedScale,
  type PerformanceTagSnapshot,
} from '../src/performanceSeed/types.js'

interface CliOptions {
  profile: 'full' | 'smoke'
  orgId: string | null
  actorUserId: string | null
  landscapeName: string | null
  dryRun: boolean
  confirmLargeSeed: boolean
  allowLiveServer: boolean
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseOptions(args: string[]): CliOptions {
  const profile = valueAfter(args, '--profile') ?? 'full'
  if (profile !== 'full' && profile !== 'smoke') throw new Error('--profile must be full or smoke')
  return {
    profile,
    orgId: valueAfter(args, '--org-id'),
    actorUserId: valueAfter(args, '--actor-user-id'),
    landscapeName: valueAfter(args, '--name'),
    dryRun: args.includes('--dry-run'),
    confirmLargeSeed: args.includes('--confirm-large-seed'),
    allowLiveServer: args.includes('--allow-live-server'),
  }
}

function placeholderTags(): PerformanceTagSnapshot[] {
  return Array.from({ length: 14 }, (_, index) => ({
    tagId: `dry-tag-${index}`,
    value: `Dry tag ${index}`,
    color: '#336699',
    groupId: `dry-group-${index % 4}`,
    groupName: `Dry group ${index % 4}`,
    catalogRevision: 1,
  }))
}

async function resolveActor(orgId: string, requested: string | null): Promise<string> {
  if (requested) return requested
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'admin' ORDER BY created_at, user_id LIMIT 1`,
    [orgId],
  )
  if (!rows[0]) throw new Error(`Organization ${orgId} has no administrator; pass --actor-user-id explicitly`)
  return rows[0].user_id
}

async function assertServerStopped(allowLiveServer: boolean): Promise<void> {
  if (allowLiveServer) return
  const { rows } = await pool.query<{ active: string }>(
    `SELECT count(*)::text AS active
     FROM sync_workspace_ownership
     WHERE released_at IS NULL AND updated_at > now() - interval '1 minute'`,
  ).catch(() => ({ rows: [{ active: '0' }] }))
  if (Number(rows[0]?.active ?? 0) > 0) {
    throw new Error('A sync/API server appears active. Stop it first, or pass --allow-live-server only if you accept storage-fence races.')
  }
}

function scaleFor(profile: CliOptions['profile']): PerformanceSeedScale {
  return profile === 'full' ? FULL_PERFORMANCE_SEED_SCALE : SMOKE_PERFORMANCE_SEED_SCALE
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const scale = scaleFor(options.profile)
  const dryPlan = new PerformanceSeedPlan({
    scale,
    tags: placeholderTags(),
    teamIds: performanceTeamIds(options.orgId ?? 'dry-run-org', scale.teams),
  })
  console.log('[performance-seed] plan')
  console.log(JSON.stringify(dryPlan.summary(), null, 2))
  if (options.dryRun) return
  if (process.env.PERFORMANCE_SEED !== 'on') {
    throw new Error('PERFORMANCE_SEED=on is required for writes')
  }
  if (!options.orgId) throw new Error('--org-id is required unless --dry-run is used')
  if (options.profile === 'full' && !options.confirmLargeSeed) {
    throw new Error('The full seed requires --confirm-large-seed')
  }
  // The CLI is intentionally usable against an older dev database. Apply the
  // same additive/idempotent schema initializers as server boot before the
  // first bulk write (notably automerge_storage.created_at/updated_at).
  await initSchema()
  await ensureAuthSchema(pool)
  await ensureRbacSchema(pool)
  await ensureTagSchema(pool)
  await ensureTechnologySchema(pool)
  await assertServerStopped(options.allowLiveServer)
  const actorUserId = await resolveActor(options.orgId, options.actorUserId)
  const startedAt = Date.now()
  const result = await seedPerformanceEnvironment({
    db: pool,
    storage: new PostgresStorageAdapter({ db: pool }),
    orgId: options.orgId,
    actorUserId,
    scale,
    ...(options.landscapeName ? { landscapeName: options.landscapeName } : {}),
    onProgress: (progress) => {
      const percent = progress.total ? Math.floor((progress.completed / progress.total) * 100) : 100
      console.log(`[performance-seed] ${progress.phase} ${percent}% — ${progress.message}`)
    },
  })
  console.log('[performance-seed] complete')
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - startedAt }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-seed] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => undefined)
  })
