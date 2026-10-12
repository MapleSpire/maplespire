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
 * Re-align a STALE static (performance) fixture with what today's producer
 * emits, so the summary-migration doors can run against it.
 *
 *   npm run realign-performance-fixture -- --landscape X --version Y
 *   npm run realign-performance-fixture -- --landscape X --version Y --apply
 *
 * See `src/maintenance/realignPerformanceFixture.ts` for what it does and, more
 * importantly, what it refuses to do. Report-only unless `--apply`.
 *
 * Exit code: 0 when clear (or applied), 1 when blocked, 2 on failure.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { canonicalWorkspaceKey } from '../src/rbac/workspaceGate.js'
import {
  realignPerformanceFixture,
  type FixtureRealignmentReport,
} from '../src/maintenance/realignPerformanceFixture.js'

function flag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name)
    const value = index >= 0 ? args[index + 1] : undefined
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

function print(report: FixtureRealignmentReport): void {
  const key = `${report.workspace.landscapeId}/${report.workspace.versionId}`
  console.log(`${report.mode.toUpperCase()} ${key}  root=${report.rootUrl ?? '(none)'}`)
  const w = report.witnesses
  console.log('witnesses:')
  console.log(`  static source     ${w.staticSource ?? '(none)'}`)
  console.log(`  root write head   ${w.rootWriteHeadId ?? '(none)'} (manifest kind: ${w.writeHeadKind ?? 'not listed'})`)
  console.log(`  manifest          ${w.allowListSize} document(s) vs ${w.admittedDocuments} admitted`)
  if (report.plan) {
    console.log('plan:')
    console.log(`  relabel head      ${report.plan.relabelWriteHeadId ?? '(nothing to relabel)'}`)
    console.log(`  claim             ${report.plan.claimDocumentIds.length} listed-but-unadmitted document(s)`)
    console.log(`  REPORTED ONLY     ${report.plan.admittedButUnlisted.length} admitted-but-unlisted document(s)`
      + ' — never touched here')
  }
  if (report.blockers.length === 0) console.log('blockers: none')
  else {
    console.log(`blockers: ${report.blockers.length}`)
    for (const blocker of report.blockers) console.log(`  [${blocker.code}] ${blocker.detail}`)
  }
  if (report.applied) {
    console.log(`APPLIED: ${report.applied.relabelled} relabelled, ${report.applied.claimed} claimed, `
      + `${report.applied.alreadyOurs} already ours.`)
    console.log('  verify with: npm run fsck -- --landscape-id <id> --version-id <id>')
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = flag(args, '--landscape', '--landscape-id')
  const versionId = flag(args, '--version', '--version-id')
  if (!landscapeId || !versionId) {
    throw new Error('usage: realign-performance-fixture --landscape <id> --version <id> [--apply] [--json]')
  }
  const workspace = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!workspace) throw new Error(`landscape ${landscapeId} has no default version to resolve against`)
  if (workspace.versionId !== versionId) {
    console.log(`… resolved version '${versionId}' → '${workspace.versionId}' (the landscape's default)`)
  }

  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: 0 })
  const report = await realignPerformanceFixture({
    db: pool,
    workspace,
    apply: args.includes('--apply'),
    onProgress: args.includes('--json') ? undefined : (message) => console.log(`… ${message}`),
    readRootWriteHeadId: async () => {
      const { rows } = await pool.query<{ root_url: string }>(
        'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
        [workspace.landscapeId, workspace.versionId],
      )
      const rootUrl = rows[0]?.root_url
      if (!rootUrl) throw new Error('no root_url')
      const root = (await findReadyDocument<Record<string, unknown>>(repo, rootUrl, 20_000)).doc()
      const head = root?.registryWriteUrl
      return typeof head === 'string' && head.length > 0 ? head.replace(/^automerge:/, '') : null
    },
  })
  await repo.shutdown()

  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else print(report)
  if (report.blockers.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[realign-performance-fixture] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => pool.end().catch(() => undefined))
