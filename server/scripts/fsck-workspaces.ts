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
 * Run the workspace fsck over every version, or one named workspace.
 *
 *   npx tsx scripts/fsck-workspaces.ts
 *   npx tsx scripts/fsck-workspaces.ts --landscape-id X --version-id Y
 *   npx tsx scripts/fsck-workspaces.ts --json
 *
 * READ-ONLY: it opens documents and runs two SELECTs. It repairs nothing.
 *
 * Deliberately `network: []`. With a network adapter attached and no peer
 * connected, `repo.find()` NEVER SETTLES for a missing document — which is the
 * exact condition this script is looking for, so an adapter would turn every
 * real finding into a hang. Without one the find rejects in about 2 ms and the
 * document is correctly reported absent.
 *
 * Exit code is 1 when any workspace is `violations` or `incomplete`, so this can
 * gate a pipeline. `incomplete` counts as failure ON PURPOSE: a run that could
 * not look at everything has not established that anything is fine.
 */
import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import {
  FSCK_CHECKS,
  FSCK_PARK_CHECKS,
  fsckAllWorkspaces,
  fsckSharedRoots,
  fsckWorkspace,
  type SharedRootFinding,
  type WorkspaceFsckReport,
} from '../src/maintenance/workspaceFsck.js'

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function print(reports: WorkspaceFsckReport[]): void {
  const bySeverity = { 'data-loss': 0, 'sync-stall': 0, degraded: 0 }
  for (const report of reports) {
    const key = `${report.workspace.landscapeId}/${report.workspace.versionId}`
    // The tombstone COUNT rides in the headline, not in a finding: the list is
    // append-only on the one document a summary boot must materialize, and its
    // growth is accepted-but-surveilled until it can be folded.
    // A workspace whose tombstones are all honoured is `clean` and would
    // otherwise report nothing at all about how large the list has become.
    const tombstones = report.diagramTombstoneCount > 0
      ? `, ${report.diagramTombstoneCount} diagram tombstones`
      : ''
    // The write head is NOT bounded by SHARD_SIZE — the client
    // selector that picks it has no size test at all — so its size is the count
    // of diagrams ever created on the workspace, and the projector reads it in
    // full on every creation. Surveilled the same way as the tombstone list,
    // for the same reason: growth is not a violation, but it must not be
    // invisible either.
    const writeHead = report.registryWriteHeadDiagramCount !== null
      ? `, write head ${report.registryWriteHeadDiagramCount}`
      : ''
    // The BOOT-CRITICAL weight, on the same terms as the two counts above.
    // `repo.ts` sizes the boot resolution windows on "these documents are all
    // small"; on a 3 000-diagram landscape that set reaches 6.7 MB with a single
    // 2.4 MB shard. Growth is not a violation — invisibility would be.
    const bootBytes = report.bootCriticalBytes > 0
      ? `, boot ${Math.round(report.bootCriticalBytes / 1024)} kB`
        + `/max ${Math.round(report.largestBootDocumentBytes / 1024)} kB`
      : ''
    // A10quater: the OVERLAY write heads' weight, on the same terms again.
    // `overlay-head-bounded` reports the entity and batch counts, but it SKIPS
    // on an ordinary workspace (nothing rotates those heads), skips when a head
    // will not resolve, and stays silent on a workspace under continuous
    // writes. This number is written by the storage adapter, so it reports
    // through all three — and bytes have no ceiling to derive, which is what
    // makes it a number here rather than a check there.
    // `null` and `0` render DIFFERENTLY, unlike the three numbers above — they
    // are non-nullable, so the `> 0 ? … : ''` idiom was safe there and is not
    // here. Collapsing them would throw away the one distinction this field
    // exists to carry: "the sum could not be taken" is not "the heads weigh
    // nothing", and a `?` is what tells an operator to go and look.
    const overlayHead = report.overlayWriteHeadBytes === null
      ? ', overlay head ?'
      : report.overlayWriteHeadBytes > 0
        ? `, overlay head ${Math.round(report.overlayWriteHeadBytes / 1024)} kB`
        : ''
    const head = `${report.status.toUpperCase().padEnd(10)} ${key}  `
      + `(${report.reachableDocuments} docs reachable${tombstones}${writeHead}${bootBytes}${overlayHead})`
    console.log(head)
    for (const finding of report.findings) {
      bySeverity[finding.severity] += 1
      console.log(`  [${finding.severity}] ${finding.check}: ${finding.detail}`)
      if (finding.documentUrl) console.log(`      ${finding.documentUrl}`)
    }
    for (const skipped of report.checksSkipped) {
      console.log(`  (skipped ${skipped.check}: ${skipped.reason})`)
    }
  }
  console.log('')
  console.log(`workspaces: ${reports.length}`
    + `  clean: ${reports.filter((r) => r.status === 'clean').length}`
    + `  violations: ${reports.filter((r) => r.status === 'violations').length}`
    + `  incomplete: ${reports.filter((r) => r.status === 'incomplete').length}`)
  console.log(`findings: data-loss ${bySeverity['data-loss']}`
    + `  sync-stall ${bySeverity['sync-stall']}  degraded ${bySeverity.degraded}`)
  console.log(`checks available: ${Object.keys(FSCK_CHECKS).join(', ')}`
    + ` | park: ${Object.keys(FSCK_PARK_CHECKS).join(', ')}`)
  // THE EFFECTIVE THRESHOLD THIS RUN JUDGED WITH, and it is printed because the
  // derivation it comes from holds inside one PROCESS and not across two.
  // `OVERLAY_HEAD_CEILING` is `4 * OVERLAY_SEGMENT_SIZE`, and
  // `OVERLAY_SEGMENT_SIZE` reads `AM_OVERLAY_SEGMENT_SIZE` from the environment
  // of whoever runs it — this script does `import 'dotenv/config'`, so it takes
  // the knob from `server/.env` while the server it is checking takes it from a
  // compose file or a task definition. Unset here and 8 there, the ceiling is
  // 64x looser than the promise it checks; 256 there and it is 2x tighter and
  // fires on healthy workspaces.
  //
  // Printing it does not fix that. It is the difference between a reader who
  // can notice and one who assumes the default. `OVERLAY_CHAIN_CEILING` has
  // the same cross-process caveat.
  const first = reports[0]
  if (first) {
    console.log(`overlay thresholds (from THIS process's env): `
      + `segment size ${first.overlaySegmentSize}, head ceiling ${first.overlayHeadCeiling}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = flag(args, '--landscape-id')
  const versionId = flag(args, '--version-id')

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })

  let reports: WorkspaceFsckReport[]
  if (landscapeId && versionId) {
    const { rows } = await pool.query<{ root_url: string }>(
      'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
      [landscapeId, versionId],
    )
    if (rows.length === 0) throw new Error(`no such workspace: ${landscapeId}/${versionId}`)
    reports = [await fsckWorkspace(pool, repo, { landscapeId, versionId }, rows[0].root_url)]
  } else {
    reports = await fsckAllWorkspaces(pool, repo)
  }
  // Park-level: two workspaces on one root. Runs even for a single-workspace
  // invocation — the twin is invisible from inside either twin's own walk.
  const sharedRoots: SharedRootFinding[] = await fsckSharedRoots(pool)
  await repo.shutdown()

  if (args.includes('--json')) console.log(JSON.stringify({ reports, sharedRoots }, null, 2))
  else {
    print(reports)
    for (const twin of sharedRoots) {
      console.log(`SHARED-ROOT ${twin.rootUrl}`)
      for (const workspace of twin.workspaces) {
        console.log(`  ${workspace.landscapeId}/${workspace.versionId}`)
      }
      console.log('  admission is first-owner-wins per document: the losing twin\'s walk fails'
        + ' "foreign" forever and its COLD boots hang. Retire the alias or merge the rows.')
    }
  }

  if (reports.some((report) => report.status !== 'clean') || sharedRoots.length > 0) {
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('[fsck] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => pool.end().catch(() => undefined))
