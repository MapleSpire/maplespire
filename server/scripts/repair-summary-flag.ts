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
 * Finish a HYBRID workspace — static rows committed, ordinary root — by writing
 * the ROOT half and nothing else.
 *
 *   npm run repair-summary-flag -- --landscape X --version Y
 *   npm run repair-summary-flag -- --landscape X --version Y --apply
 *
 * The third door of the summary migration. It exists because the hybrid state
 * is reachable two ways — a crash between the promotion's COMMIT and its root
 * flip, and a `registrySummaryOnly` flag stripped by hand from a static fixture
 * — and neither of the other two doors can regularise it: `promote-summary`
 * answers `already-summary` (the static row exists) and `demote-summary`
 * answers `not-promoted` for any source it did not write. Until this existed
 * the only remaining tool was a hand-written UPDATE against
 * `read_model_static_*`.
 *
 * It MINTS NOTHING. Where the root already names a registry write head it uses
 * that one; where it does not (the crash case) it ADOPTS the single
 * `registry-shard` document the committed allow-list already carries — durable
 * and claimed, because the promotion's one transaction put it there. A second
 * write head is the one irreversible mistake available here.
 *
 * fsck reports the state this repairs as `summary-static-coherence` /
 * `degraded`; a run of `npm run fsck` on the same workspace afterwards is the
 * verification.
 *
 * Report-only unless `--apply`. No `--assume-quiesced`: this repair takes
 * nothing away from a live session that the static row has not already taken —
 * a hybrid workspace is ALREADY dropping a classic tab's registry writes at the
 * wire, and the flag flip is what finally tells that tab (the client's epoch
 * guard banners and offers a reload).
 *
 * Exit code: 0 when clear (or applied), 1 when blocked, 2 on failure.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { lifecycleApplyPool, pool } from '../src/db.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import {
  repairSummaryFlag,
  type SummaryFlagRepairReport,
} from '../src/maintenance/promoteSummaryWorkspace.js'

function flag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    const value = index >= 0 ? args[index + 1] : undefined
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

function print(report: SummaryFlagRepairReport): void {
  const key = `${report.workspace.landscapeId}/${report.workspace.versionId}`
  console.log(`${report.mode.toUpperCase()} ${key}  root=${report.rootUrl ?? '(none)'}`)
  const w = report.witnesses
  console.log('witnesses:')
  console.log(`  static source     ${w.staticSource ?? '(none)'}`)
  console.log(`  root flag         registrySummaryOnly=${w.registrySummaryOnly}`)
  console.log(`  root write head   ${w.rootWriteHeadUrl ?? '(none — would be adopted from the allow-list)'}`)
  console.log(`  write head kind   ${w.writeHeadKind ?? '(not in the allow-list)'}`)
  console.log(`  allow-list        ${w.allowListSize} document(s) vs ${w.admittedDocuments} admitted`)
  console.log(`  diagrams          ${w.diagramCount} (ro_diagrams)`)
  if (report.plan) {
    console.log('plan:')
    console.log(`  write head        ${report.plan.writeHeadUrl}`
      + `${report.plan.adoptedFromAllowList ? ' (ADOPTED from the allow-list — a crashed promotion)' : ''}`)
    console.log(`  diagramCount      ${report.plan.diagramCount}`)
  }
  if (report.blockers.length === 0) console.log('blockers: none')
  else {
    console.log(`blockers: ${report.blockers.length}`)
    for (const blocker of report.blockers) console.log(`  [${blocker.code}] ${blocker.detail}`)
  }
  if (report.applied) {
    console.log('APPLIED: the root now carries the summary contract; nothing was minted.')
    console.log('  verify with: npm run fsck -- --landscape-id <id> --version-id <id>')
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = flag(args, '--landscape', '--landscape-id')
  const versionId = flag(args, '--version', '--version-id')
  if (!landscapeId || !versionId) {
    throw new Error('usage: repair-summary-flag --landscape <id> --version <id> [--apply] [--json]')
  }
  // CANONICALISE FIRST — see promote-summary.ts.
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

  const report = await repairSummaryFlag({
    db: pool,
    lockDb: lifecycleApplyPool,
    repo,
    workspace,
    apply: args.includes('--apply'),
    onProgress: args.includes('--json') ? undefined : (message) => console.log(`… ${message}`),
  })
  await repo.shutdown()

  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else print(report)

  if (report.blockers.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[repair-summary-flag] failed:', error)
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
