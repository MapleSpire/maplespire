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
 * Promote one ordinary workspace into the SUMMARY world.
 *
 *   npm run promote-summary -- --landscape X --version Y
 *   npm run promote-summary -- --landscape X --version Y --apply --assume-quiesced
 *   npm run promote-summary -- --landscape X --version Y --json
 *
 * REPORT-ONLY by default, exactly like `npm run fsck` and
 * `npm run repair:degenerate-roots`: `--apply` is a second, explicit decision.
 * The report is the same shape either way, so a dry run tells you precisely
 * what an apply would do — including the one-off cost of precondition 3
 * (materialising every registry shard once, ~33 s at 10k diagrams, memory
 * bounded to one shard).
 *
 * `--assume-quiesced` is REQUIRED for `--apply` from this script and is not a
 * formality: a standalone process has no WebSocket server, so it cannot see
 * whether a browser is connected, and the primitive refuses to fabricate a zero
 * (`quiesce-unproven`). Either stop the sync server first, or promote through
 * `POST /api/platform/workspace/promote-summary`, which MEASURES the census.
 *
 * Deliberately `network: []`. With a network adapter attached and no peer
 * connected, `repo.find()` never settles for a missing document — which is one
 * of the conditions the preconditions exist to detect, so an adapter would turn
 * a real finding into a hang.
 *
 * Exit code: 0 when the promotion is clear (or applied), 1 when blocked, 2 on
 * an unexpected failure.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { lifecycleApplyPool, pool } from '../src/db.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import {
  promoteSummaryWorkspace,
  type SummaryPromotionReport,
} from '../src/maintenance/promoteSummaryWorkspace.js'

function flag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    const value = index >= 0 ? args[index + 1] : undefined
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

function print(report: SummaryPromotionReport): void {
  const key = `${report.workspace.landscapeId}/${report.workspace.versionId}`
  console.log(`${report.mode.toUpperCase()} ${key}  root=${report.rootUrl ?? '(none)'}`)
  const w = report.witnesses
  console.log('witnesses:')
  console.log(`  fsck              ${w.fsck ? `${w.fsck.status} (${w.fsck.findings} finding(s), `
    + `model-write-head ${w.fsck.modelWriteHead}, write-head-version ${w.fsck.writeHeadVersion})` : 'not run'}`)
  console.log(`  read-model seals  ${w.integrity ? `${w.integrity.outcome} — ${w.integrity.summary}` : 'not read'}`)
  console.log(`  projection        ${w.freshness ? `${w.freshness.status}, caughtUp=${w.freshness.caughtUp}, `
    + `absenceProvable=${w.freshness.absenceProvable}` : 'not read'}`)
  console.log(`  projector run     ${w.projectorInstanceId ?? '(none)'}`)
  console.log(`  claim coverage    ${w.coverage ? `covered=${w.coverage.covered} protocol=${w.coverage.protocol}` : 'absent'}`)
  console.log(`  quiesce           ${w.quiesce}${w.connectedPeers !== null ? ` (${w.connectedPeers} peer(s))` : ' (not measurable from this process)'}`)
  if (w.registry) {
    console.log(`  registry          ${w.registry.shards} shard(s), ${w.registry.shardsUnresolved} unresolved, `
      + `${w.registry.diagramsInCrdt} diagram(s) in CRDT vs ${w.registry.diagramsInReadModel} in ro_diagrams `
      + `(${(w.registry.materializeMs / 1000).toFixed(1)} s — the one-off payment of the materialisation wall)`)
  }
  if (report.plan) {
    console.log('plan:')
    console.log(`  allow-list        ${report.plan.allowList.length} document(s)`)
    const byKind = new Map<string, number>()
    for (const entry of report.plan.allowList) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1)
    console.log(`    ${[...byKind].sort().map(([kind, n]) => `${kind}×${n}`).join('  ')}`)
    console.log(`  diagrams          ${report.plan.diagramCount}`)
    console.log(`  frozen registries ${report.plan.frozenRegistryShards} (kept in root.shardUrls — never removed)`)
  }
  if (report.blockers.length === 0) {
    console.log('blockers: none')
  } else {
    console.log(`blockers: ${report.blockers.length}`)
    for (const blocker of report.blockers) console.log(`  [${blocker.code}] ${blocker.detail}`)
  }
  for (const blocker of report.overridden) {
    console.log(`OVERRIDDEN by --allow-connected-peers [${blocker.code}] ${blocker.detail}`)
  }
  if (report.applied) {
    console.log('APPLIED:')
    console.log(`  write head        ${report.applied.writeHeadUrl}`)
    console.log(`  allow-list        ${report.applied.allowListSize} document(s), source '${report.applied.staticSource}'`)
    console.log(`  fence wait        ${report.applied.fenceWaitMs} ms between the COMMIT and the root flip`)
    console.log(`  diagramCount      ${report.applied.diagramCount}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = flag(args, '--landscape', '--landscape-id')
  const versionId = flag(args, '--version', '--version-id')
  if (!landscapeId || !versionId) {
    throw new Error('usage: promote-summary --landscape <id> --version <id> [--apply] [--assume-quiesced] [--json]')
  }
  const apply = args.includes('--apply')
  // CANONICALISE FIRST — `--version current` is a sentinel, not a version id.
  // Everything downstream is keyed by the real id (ro_* rows, the allow-list,
  // `automerge_document_workspace`, the fleet's LRU), so a promotion run on the
  // alias would gather its witnesses from one key set and write its static row
  // under another. The same one producer the HTTP routes use — never a second
  // copy of the resolution.
  const workspace = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!workspace) {
    throw new Error(`landscape ${landscapeId} has no default version to resolve 'current' against`)
  }
  if (workspace.versionId !== versionId) {
    console.log(`… resolved version '${versionId}' → '${workspace.versionId}' (the landscape's default)`)
  }
  const storage = new PostgresStorageAdapter({ db: pool })
  const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })

  const report = await promoteSummaryWorkspace({
    db: pool,
    lockDb: lifecycleApplyPool,
    repo,
    residency: null, // This standalone Repo has no idle sweep or projector fleet.
    storage,
    workspace,
    apply,
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
    console.error('[promote-summary] failed:', error)
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
