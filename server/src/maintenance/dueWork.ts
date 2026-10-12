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

import type { MaintenanceJobName } from './coordinator.js'

/**
 * PER-WORKSPACE DUE WORK.
 *
 * THE PROBLEM. `MaintenanceCoordinator` takes one advisory lock per job NAME,
 * cluster-wide. Compacting a single workspace therefore holds
 * `default_compaction` against every other workspace on every cell. With one
 * workspace that is invisible; with a fleet it serialises the whole maintenance
 * plane behind whichever workspace is slowest, and a workspace that takes an
 * hour starves the rest for an hour.
 *
 * TWO MECHANISMS, TWO QUESTIONS, KEPT APART. Queue exclusion is the due-work
 * ROW: claiming it is what stops two cells running the same unit. The advisory
 * lock keeps its own separate job — guarding the mutation. They are not merged
 * because they fail differently: a claim may expire harmlessly, a half-applied
 * mutation may not.
 *
 * NO LEADER ELECTION. Every cell may propose the same work; a unique key on
 * a QUANTIZED SLOT collapses the proposals to one row. Nobody is elected to
 * decide what is due, so nobody's death stops the queue being filled.
 */

export interface DueWorkKey {
  job: MaintenanceJobName
  landscapeId: string
  versionId: string
}

export interface DueWorkClaim extends DueWorkKey {
  slot: Date
  attempts: number
}

interface DueWorkDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

/**
 * Quantize an instant to the start of its slot.
 *
 * THE DEDUP KEY, and it must be computed the SAME way on every cell — that is
 * the whole mechanism. Two cells noticing the same work within one interval
 * produce one row rather than two, without either being the leader.
 *
 * Derived from the epoch rather than from calendar fields on purpose: a
 * calendar-aligned bucket ("this hour") changes width across a DST boundary, so
 * two cells in different zones — or one cell either side of a transition —
 * disagree about which slot they are in and the dedup silently stops working
 * twice a year.
 */
export function quantizeSlot(at: Date, intervalMs: number): Date {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`slot interval must be a positive number of milliseconds, got ${intervalMs}`)
  }
  return new Date(Math.floor(at.getTime() / intervalMs) * intervalMs)
}

/**
 * Propose work. Returns true when THIS call created the row.
 *
 * Idempotent by the unique key, so every cell may call it on every tick. The
 * return value is not a claim — it says only who won the insert, and the winner
 * has no privilege over the row afterwards.
 */
export async function enqueueDueWork(
  db: DueWorkDb,
  key: DueWorkKey,
  slot: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO maintenance_due_work (job_name, landscape_id, version_id, slot)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_name, landscape_id, version_id, slot) DO NOTHING`,
    [key.job, key.landscapeId, key.versionId, slot],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Claim up to `limit` units of work for one job.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this concurrent without a leader: two
 * cells scanning at once take DIFFERENT rows instead of one blocking on the
 * other. Without `SKIP LOCKED` the second cell waits for the first's
 * transaction — the cluster-wide serialisation this module exists to remove,
 * rebuilt one row at a time.
 *
 * THE LEASE IS THE RECOVERY. A claimed row is respected only while
 * `claimed_until` is in the future. A cell that dies holding a claim returns it
 * when the lease expires — nothing has to notice the death, and no restart is
 * required. That is why the claim is a deadline rather than a boolean.
 *
 * The claim and the release are ONE statement, so there is no window in which a
 * row is selected but not yet marked.
 */
export async function claimDueWork(
  db: DueWorkDb,
  job: MaintenanceJobName,
  claimant: string,
  leaseMs: number,
  limit = 1,
): Promise<DueWorkClaim[]> {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error(`claim lease must be a positive number of milliseconds, got ${leaseMs}`)
  }
  const { rows } = await db.query<{
    landscape_id: string
    version_id: string
    slot: Date
    attempts: number
  }>(
    `UPDATE maintenance_due_work AS work
        SET claimed_by = $2,
            claimed_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
            attempts = work.attempts + 1
      WHERE (work.job_name, work.landscape_id, work.version_id, work.slot) IN (
        SELECT candidate.job_name, candidate.landscape_id, candidate.version_id, candidate.slot
          FROM maintenance_due_work AS candidate
         WHERE candidate.job_name = $1
           -- Unclaimed, or claimed by a lease that has run out. The second half
           -- is the whole recovery story: no reaper, no restart, just a deadline
           -- that has passed.
           AND candidate.completed_at IS NULL
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until < NOW())
         -- DETERMINISTIC, and the first version ordered by slot ALONE, which
         -- imposes no order at all in the common case: one tick enqueues every
         -- workspace at the SAME quantized slot. A window that then took a
         -- bounded batch got an arbitrary subset, and a row released back could
         -- come straight to the front again — so a repeatedly-failing workspace
         -- could hold a slot of every window while a healthy one behind it was
         -- never reached. Ordering by attempts second is what makes that
         -- impossible: a row that keeps failing sorts BEHIND fresh work rather
         -- than ahead of it. The two id columns make the rest total, so two
         -- cells scanning at once walk the same sequence and SKIP LOCKED splits
         -- it cleanly instead of having them contend on an arbitrary overlap.
         --
         -- (No backticks in this comment, and that is not a style rule: it sits
         -- inside a template literal, where one would end the string. This
         -- repository has lost a build to that byte twice before.)
         ORDER BY candidate.slot, candidate.attempts, candidate.landscape_id, candidate.version_id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
      )
      RETURNING work.landscape_id, work.version_id, work.slot, work.attempts`,
    [job, claimant, Math.floor(leaseMs), limit],
  )
  return rows.map((row) => ({
    job,
    landscapeId: row.landscape_id,
    versionId: row.version_id,
    slot: row.slot,
    attempts: row.attempts,
  }))
}

/**
 * The work is done for this slot: the row is MARKED.
 *
 * NOT DELETED. Deleting the row would delete the only record that this
 * workspace's turn in this slot has been taken: the unique key could no longer
 * collapse a proposal, so the very next tick would re-create the row and claim
 * the workspace again inside the same slot — the slot would stop being a
 * cadence, and the re-created rows would sort ahead of workspaces that had
 * never run.
 *
 * The tail is bounded by `pruneCompletedDueWork`, called from each job's own
 * sweep: every completed row from an EARLIER slot is deleted, so the table holds
 * at most one row per workspace per job.
 *
 * The lease fields are cleared at the same time so a completed row can never be
 * mistaken for one somebody is still working on.
 */
export async function completeDueWork(db: DueWorkDb, claim: DueWorkKey & { slot: Date }): Promise<void> {
  await db.query(
    `UPDATE maintenance_due_work
        SET completed_at = NOW(), claimed_by = NULL, claimed_until = NULL
      WHERE job_name = $1 AND landscape_id = $2 AND version_id = $3 AND slot = $4`,
    [claim.job, claim.landscapeId, claim.versionId, claim.slot],
  )
}

/**
 * Delete every completed row for this job from a slot older than `beforeSlot`.
 *
 * THE OTHER HALF OF MARKING INSTEAD OF DELETING. Without it the table grows
 * without bound and the claim scan walks an ever-longer completed tail. Called
 * from the sweep,
 * so it runs on the same schedule as the proposals it is cleaning up after, and
 * bounded by one statement per tick rather than a background reaper nobody would
 * notice had stopped.
 *
 * Rows of the CURRENT slot are kept, completed or not: they are what stops the
 * same workspace being proposed again inside its own window.
 */
export async function pruneCompletedDueWork(
  db: DueWorkDb,
  job: MaintenanceJobName,
  beforeSlot: Date,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM maintenance_due_work
      WHERE job_name = $1 AND slot < $2 AND completed_at IS NOT NULL`,
    [job, beforeSlot],
  )
  return rowCount ?? 0
}

/**
 * The work failed: hand the row back NOW rather than waiting out the lease.
 *
 * `attempts` is already incremented by the claim, so a row that keeps failing
 * carries its own count without a separate write. The error is recorded on the
 * row because the next cell to claim it is a different process, and "why did
 * this fail last time" is otherwise only in a log somebody has to find.
 */
export async function releaseDueWork(
  db: DueWorkDb,
  claim: DueWorkKey & { slot: Date },
  error: string,
  /**
   * Hold the row back for this long before anyone may claim it again. Omit for
   * "immediately", which is the right answer for a READ-ONLY job: retrying an
   * fsck costs a read.
   *
   * It is NOT the right answer for a mutating job, and the difference is why
   * this parameter exists. `claimed_until = NULL` makes the row instantly
   * re-claimable, so a workspace that fails deterministically is retried every
   * window for ever — and each compaction attempt DETACHES its read plane, ~30 s
   * of a workspace answering 503 at 200 000 objects. An immediate infinite retry loop on that
   * is an outage generator, not resilience. The deadline reuses the same column
   * the lease uses, so no schema change and no second concept: a row held back
   * and a row being worked on are both "claimed until".
   */
  retryAfterMs?: number,
): Promise<void> {
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
    throw new Error(`retry delay must be a non-negative number of milliseconds, got ${retryAfterMs}`)
  }
  await db.query(
    `UPDATE maintenance_due_work
        SET claimed_by = NULL,
            claimed_until = CASE WHEN $6::bigint IS NULL THEN NULL
                                 ELSE NOW() + ($6::bigint * INTERVAL '1 millisecond') END,
            last_error = $5
      WHERE job_name = $1 AND landscape_id = $2 AND version_id = $3 AND slot = $4`,
    [
      claim.job, claim.landscapeId, claim.versionId, claim.slot, error.slice(0, 2_000),
      retryAfterMs === undefined ? null : Math.floor(retryAfterMs),
    ],
  )
}
