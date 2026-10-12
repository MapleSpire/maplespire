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

import type { Repo } from '@automerge/automerge-repo'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'
import {
  claimDueWork,
  completeDueWork,
  enqueueDueWork,
  pruneCompletedDueWork,
  quantizeSlot,
  releaseDueWork,
  type DueWorkClaim,
} from './dueWork.js'
import { fsckWorkspace, type WorkspaceFsckReport } from './workspaceFsck.js'

/**
 * THE FSCK QUEUE — a READ-ONLY job on the due-work queue.
 *
 * Read-only separates proving the QUEUE from proving the LOCK: if the claim
 * logic double-claims, starves a workspace or loses a lease, the worst outcome
 * here is a wrong row in `workspace_fsck_finding`, not edit loss. A mutating job
 * on the queue is only safe once its critical section's DURATION is known.
 *
 * WHAT IT DOES. Schedules `fsckWorkspace` over every maintainable workspace, so
 * a structural violation in a non-default workspace is found WITHOUT a human
 * going looking.
 *
 * It reuses the single workspace enumeration and the quantized-slot dedup and
 * lease-based claim of `dueWork.ts`; it adds no third way to decide what to
 * sweep or who may sweep it.
 */

export const FSCK_JOB = 'automerge_gc' as const

export interface FsckQueueOptions {
  /** How often each workspace is due. Also the dedup window: two cells ticking
   *  inside one interval enqueue one row, not two. */
  intervalMs?: number
  /** How long a claim is respected. A cell that dies mid-check returns its work
   *  when this passes — no reaper, no restart. */
  leaseMs?: number
  /** How many workspaces one tick will check. Bounded so a tick's duration stays
   *  predictable. */
  batchSize?: number
  now?: () => Date
}

interface FsckQueueDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

export interface FsckQueueTick {
  enqueued: number
  claimed: number
  checked: number
  failed: number
  /** Workspaces whose report said something other than clean. */
  withFindings: number
  /** Enqueued, then deleted before they could be claimed. Counted apart from
   *  `checked`: nothing was examined. */
  vanished: number
}

/**
 * Propose an fsck for every maintainable workspace in the current slot.
 *
 * Every cell may call this on its own schedule; the unique key on the quantized
 * slot collapses the proposals. Nobody is elected to decide what is due.
 */
export async function enqueueFsckSweep(
  db: FsckQueueDb,
  options: FsckQueueOptions = {},
): Promise<number> {
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1_000
  const now = (options.now ?? (() => new Date()))()
  const slot = quantizeSlot(now, intervalMs)
  // `completeDueWork` MARKS the row instead of deleting it, so the slot is a
  // real cadence. This is the other half: every completed row from an earlier
  // slot goes, so the table stays bounded by the workspace count.
  await pruneCompletedDueWork(db, FSCK_JOB, slot)
  const workspaces = await enumerateMaintainableWorkspaces(db)
  let enqueued = 0
  for (const workspace of workspaces) {
    const created = await enqueueDueWork(
      db,
      { job: FSCK_JOB, landscapeId: workspace.landscapeId, versionId: workspace.versionId },
      slot,
    )
    if (created) enqueued += 1
  }
  return enqueued
}

/**
 * Claim a bounded batch and check each workspace.
 *
 * ONE WORKSPACE'S FAILURE DOES NOT SINK THE BATCH. A check that throws releases
 * its own row with the error recorded and the loop continues — the alternative
 * is that one unreadable workspace stops every other from ever being checked,
 * which is the cluster-wide serialisation this whole line of work is removing,
 * rebuilt inside a single tick.
 */
export async function runFsckQueueTick(
  db: FsckQueueDb,
  repo: Repo,
  cellId: string,
  options: FsckQueueOptions = {},
): Promise<FsckQueueTick> {
  const leaseMs = options.leaseMs ?? 10 * 60 * 1_000
  const batchSize = options.batchSize ?? 4

  const enqueued = await enqueueFsckSweep(db, options)
  const claims = await claimDueWork(db, FSCK_JOB, cellId, leaseMs, batchSize)

  let checked = 0
  let failed = 0
  let withFindings = 0
  let vanished = 0

  for (const claim of claims) {
    try {
      const report = await checkOne(db, repo, claim, cellId)
      if (report === null) {
        // The workspace was deleted between enqueue and claim. Counted apart
        // from `checked`: reporting it as checked would say a workspace was
        // examined when nothing was, which is the shape this whole table exists
        // to avoid.
        vanished += 1
        await completeDueWork(db, claim)
        continue
      }
      checked += 1
      if (report.status !== 'clean') withFindings += 1
      await completeDueWork(db, claim)
    } catch (error) {
      failed += 1
      // RELEASED, not left to the lease. The lease is the recovery for a cell
      // that DIED; a cell that is alive and knows it failed should hand the work
      // back at once, so another cell can try before the lease would have run.
      await releaseDueWork(db, claim, error instanceof Error ? error.message : String(error))
    }
  }

  return { enqueued, claimed: claims.length, checked, failed, withFindings, vanished }
}

/**
 * `null` means the workspace went away between being enqueued and being claimed.
 *
 * NOT A FABRICATED REPORT. The real report's fields are MEASUREMENTS
 * (tombstone counts, boot-critical bytes, the largest document); inventing
 * zeroes for them would write a row asserting things nobody looked at. A
 * vanished workspace has no findings and no
 * measurements; `null` says exactly that, and the caller completes the row
 * rather than retrying something that no longer exists.
 */
async function checkOne(
  db: FsckQueueDb,
  repo: Repo,
  claim: DueWorkClaim,
  cellId: string,
): Promise<WorkspaceFsckReport | null> {
  const { rows } = await db.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [claim.landscapeId, claim.versionId],
  )
  const rootUrl = rows[0]?.root_url
  if (!rootUrl) return null

  const report = await fsckWorkspace(
    db as never,
    repo,
    { landscapeId: claim.landscapeId, versionId: claim.versionId },
    rootUrl,
  )
  await recordFsckReport(db, report, cellId)
  return report
}

/**
 * Write what was found, replacing whatever was there before.
 *
 * CURRENT STATE, not history: the question is "what is wrong now". An
 * append-only log would grow without bound and bury the answer, and
 * `maintenance_job_status` already records the run.
 */
export async function recordFsckReport(
  db: FsckQueueDb,
  report: WorkspaceFsckReport,
  observedBy: string,
): Promise<void> {
  const codes = [...new Set(report.findings.map((finding) => finding.check))]
  await db.query(
    `INSERT INTO workspace_fsck_finding
       (landscape_id, version_id, status, finding_count, finding_codes, checks_skipped, report, observed_by, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       status = EXCLUDED.status,
       finding_count = EXCLUDED.finding_count,
       finding_codes = EXCLUDED.finding_codes,
       checks_skipped = EXCLUDED.checks_skipped,
       report = EXCLUDED.report,
       observed_by = EXCLUDED.observed_by,
       observed_at = EXCLUDED.observed_at`,
    [
      report.workspace.landscapeId,
      report.workspace.versionId,
      report.status,
      report.findings.length,
      codes,
      report.checksSkipped.length,
      JSON.stringify(report),
      observedBy,
    ],
  )
}
