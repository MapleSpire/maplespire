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
 * Take a PROMOTED workspace back out of the summary world.
 *
 *   npm run demote-summary -- --landscape X --version Y
 *   npm run demote-summary -- --landscape X --version Y --apply --assume-quiesced
 *
 * The escape hatch, not a mode of operation: at 10k diagrams this re-exposes
 * both client walls (77.6 s of registry materialisation, 84.7 s in the first
 * flushWrite). It exists so a promotion is not a one-way door.
 *
 * It refuses any static workspace whose `source` is not `promoted`. A
 * performance fixture and a sparse draft were BORN summary — their baseline
 * exists nowhere but the read model — so "demoting" them does not restore an
 * ordinary workspace, it destroys the only one they have.
 *
 * Report-only unless `--apply`; `--assume-quiesced` is required for `--apply`
 * from this script for the same reason as the promotion (a standalone process
 * cannot see the live sockets and must not fabricate a zero).
 *
 * Exit code: 0 when clear (or applied), 1 when blocked, 2 on failure.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { lifecycleApplyPool, pool } from '../src/db.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import {
  demoteSummaryWorkspace,
  type SummaryDemotionReport,
} from '../src/maintenance/promoteSummaryWorkspace.js'

function flag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    const value = index >= 0 ? args[index + 1] : undefined
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

function print(report: SummaryDemotionReport): void {
  const key = `${report.workspace.landscapeId}/${report.workspace.versionId}`
  console.log(`${report.mode.toUpperCase()} ${key}  root=${report.rootUrl ?? '(none)'}`)
  console.log(`  static source     ${report.witnesses.staticSource ?? '(none)'}`)
  console.log(`  allow-list        ${report.witnesses.allowListSize} document(s)`)
  console.log(`  sparse children   ${report.witnesses.activeSparseChildren.length
    ? report.witnesses.activeSparseChildren.join(', ') : 'none active'}`)
  console.log(`  quiesce           ${report.witnesses.quiesce}${report.witnesses.connectedPeers !== null
    ? ` (${report.witnesses.connectedPeers} peer(s))` : ' (not measurable from this process)'}`)
  if (report.blockers.length === 0) console.log('blockers: none')
  else {
    console.log(`blockers: ${report.blockers.length}`)
    for (const blocker of report.blockers) console.log(`  [${blocker.code}] ${blocker.detail}`)
  }
  for (const blocker of report.overridden) {
    console.log(`OVERRIDDEN by --allow-connected-peers [${blocker.code}] ${blocker.detail}`)
  }
  if (report.applied) {
    console.log('APPLIED:')
    console.log(`  static rows       ${report.applied.staticRowsDeleted} allow-list row(s) deleted`)
    console.log(`  write head        ${report.applied.writeHeadKeptInShardUrls ? 'kept' : 'NOT'} in root.shardUrls`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = flag(args, '--landscape', '--landscape-id')
  const versionId = flag(args, '--version', '--version-id')
  if (!landscapeId || !versionId) {
    throw new Error('usage: demote-summary --landscape <id> --version <id> [--apply] [--assume-quiesced] [--json]')
  }
  // CANONICALISE FIRST — see promote-summary.ts: `current` is a sentinel, and
  // the static rows this deletes are keyed by the REAL version id.
  const workspace = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!workspace) {
    throw new Error(`landscape ${landscapeId} has no default version to resolve 'current' against`)
  }
  if (workspace.versionId !== versionId) {
    console.log(`… resolved version '${versionId}' → '${workspace.versionId}' (the landscape's default)`)
  }
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })

  const report = await demoteSummaryWorkspace({
    db: pool,
    lockDb: lifecycleApplyPool,
    repo,
    workspace,
    apply: args.includes('--apply'),
    assumeQuiesced: args.includes('--assume-quiesced'),
    allowConnectedPeers: args.includes('--allow-connected-peers'),
    onProgress: args.includes('--json') ? undefined : (message) => console.log(`… ${message}`),
  })
  await repo.shutdown()

  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else print(report)

  if (report.blockers.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[demote-summary] failed:', error)
    process.exitCode = 2
  })
  // BOTH pools, and `allSettled` so a rejection from one still ends the other.
  // The lock client comes from `lifecycleApplyPool` and
  // `releaseLifecycleApplyLock` hands it back with a BARE `release()`, which
  // RECYCLES it — so a pool nobody ends holds a live socket and pg-pool's idle
  // timer is not unref'd. Ending only `pool` would keep this script alive for
  // the full 30 s `DB_IDLE_TIMEOUT_MS` after it printed its report, on the
  // SUCCESS path only (no test covers this: nothing in the suite imports
  // `db.ts`).
  .finally(async () => { await Promise.allSettled([pool.end(), lifecycleApplyPool.end()]) })
