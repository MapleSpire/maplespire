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
 * Backfill and heal the overlay write heads' `writeBatchIds`, and report every
 * other container a workspace's write-path documents lack or have conflicted —
 * see `src/maintenance/containerBackfill.ts` for exactly what is written, what
 * is only reported, and why.
 *
 *   npm run repair:missing-containers -- --landscape-id L --version-id V   # preview one
 *   npm run repair:missing-containers -- --all                             # preview every workspace
 *   CONTAINER_BACKFILL_OFFLINE_CONFIRMED=on \
 *     npm run repair:missing-containers -- --all --apply                   # write
 *
 * Apply writes straight to storage through this process's own Repo, so every
 * sync cell that can own the workspace must be stopped first — the same
 * contract as `repair-degenerate-roots`. After an apply, a COLD re-plan (fresh
 * Repo, nothing cached) must find nothing left to write or heal.
 *
 * Exit codes: 0 done (or nothing to do); 1 failure, an unknown workspace, a
 * document not mapped to the workspace, a document that did not resolve (its
 * containers are UNKNOWN), a write the cold re-plan still finds, or an apply
 * whose lock exclusion was not proven; 75 a transient refusal (lock held,
 * workspace moved, pool exhausted) — come back. Under `--all` a failing
 * workspace is reported and the run continues.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import {
  backfillMissingContainers,
  type ContainerBackfillReport,
} from '../src/maintenance/containerBackfill.js'
import { LifecycleApplyRefusedError } from '../src/maintenance/lifecycleApplyLock.js'
import { enumerateMaintainableWorkspaces } from '../src/maintenance/maintainableWorkspaces.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const openRepo = () => new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }), saveDebounceRate: 0 })

async function runOne(workspace: { landscapeId: string; versionId: string }, apply: boolean): Promise<ContainerBackfillReport> {
  const repo = openRepo()
  try {
    return await backfillMissingContainers({ db: pool, repo, openRepo, workspace, apply })
  } finally {
    await repo.shutdown()
  }
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all')
  const landscapeId = argument('--landscape-id')
  const versionId = argument('--version-id')
  if (!all && (!landscapeId || !versionId)) {
    throw new Error('usage: repair-missing-containers (--all | --landscape-id <id> --version-id <id>) [--apply]')
  }
  const apply = process.argv.includes('--apply')
  if (apply && process.env.CONTAINER_BACKFILL_OFFLINE_CONFIRMED !== 'on') {
    throw new Error(
      'refusing an online container backfill: stop every sync cell that can own the workspace, '
      + 'then set CONTAINER_BACKFILL_OFFLINE_CONFIRMED=on',
    )
  }
  const workspaces = all
    ? (await enumerateMaintainableWorkspaces(pool)).map(({ landscapeId: l, versionId: v }) => ({ landscapeId: l, versionId: v }))
    : [{ landscapeId: landscapeId!, versionId: versionId! }]

  let failed = false
  let refused = false
  for (const workspace of workspaces) {
    const name = `${workspace.landscapeId}/${workspace.versionId}`
    let report: ContainerBackfillReport
    try {
      report = await runOne(workspace, apply)
    } catch (error) {
      if (error instanceof LifecycleApplyRefusedError) {
        console.error(`[container-backfill] ${name} REFUSED (${error.code}) — nothing written. Re-run once it clears.`)
        refused = true
        continue
      }
      // One workspace's failure (a root that does not resolve, say) must not
      // abandon the rest of an `--all` run, nor hide that it happened.
      console.error(`[container-backfill] ${name} FAILED:`, error)
      failed = true
      continue
    }
    console.log(JSON.stringify({ event: 'maintenance.container_backfill', apply, ...report }))
    if (report.refused === 'workspace-unknown' || report.refused === 'document-not-owned') {
      // Not transient: a document reachable but unmapped is fsck's
      // `document-admitted` finding, and needs fixing before this can write.
      console.error(`[container-backfill] ${name} REFUSED (${report.refused}) — nothing written.`)
      failed = true
    } else if (report.refused) {
      // A refusal must not look like success: it wrote nothing.
      console.error(`[container-backfill] ${name} REFUSED (${report.refused}) — nothing written. Re-run once it clears.`)
      refused = true
    }
    if (report.plan.unresolved.length > 0) {
      console.error(`[container-backfill] ${name}: ${report.plan.unresolved.length} document(s) did not resolve; their containers are unknown.`)
      failed = true
    }
    if (report.applied && !report.applied.exclusionProven) {
      console.error(`[container-backfill] ${name}: EXCLUSION NOT PROVEN — the lock may not have excluded the other `
        + 'lifecycle doors while this wrote. Run `npm run fsck` on this workspace.')
      failed = true
    }
    if (report.applied && (report.applied.written > 0 || report.applied.healed > 0)) {
      // Cold verification: a fresh Repo reads storage, not this process's cache.
      const cold = await runOne(workspace, false)
      if (cold.plan.writes.length > 0 || cold.plan.heals.length > 0) {
        console.error(`[container-backfill] ${name}: the cold re-plan still finds ${cold.plan.writes.length} write(s) `
          + `and ${cold.plan.heals.length} heal(s) — the apply did not reach storage.`)
        failed = true
      }
    }
  }
  if (failed) process.exitCode = 1
  else if (refused) process.exitCode = 75
}

main()
  .catch((error) => {
    console.error('[container-backfill] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
