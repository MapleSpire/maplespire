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

import type { Pool } from 'pg'

/**
 * Cluster-wide operational state for destructive/expensive maintenance jobs.
 *
 * The advisory lock remains the source of truth for ownership. This table is
 * deliberately only observability/history: a process can die after recording
 * `running`, so readers must combine it with pg_locks before reporting a job as
 * active.
 */
export async function ensureMaintenanceSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_job_status (
      job_name TEXT NOT NULL,
      -- '' means "not workspace-scoped": a run excluded by the per-job-name
      -- advisory lock, which is every run while MAINTENANCE_WORKSPACE_KEYED is
      -- off. NOT NULL with an empty sentinel rather than NULL because Postgres
      -- does not treat NULLs as equal in a primary key, so a nullable column
      -- here would let the same global job insert unboundedly many rows.
      landscape_id TEXT NOT NULL DEFAULT '',
      version_id TEXT NOT NULL DEFAULT '',
      runner_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'completed', 'failed')),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      last_duration_ms BIGINT,
      last_error_code VARCHAR(64),
      run_count BIGINT NOT NULL DEFAULT 0,
      failure_count BIGINT NOT NULL DEFAULT 0,
      skip_count BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (job_name, landscape_id, version_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_job_fence (
      job_name TEXT NOT NULL,
      landscape_id TEXT NOT NULL DEFAULT '',
      version_id TEXT NOT NULL DEFAULT '',
      fencing_token BIGINT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_name, landscape_id, version_id)
    )
  `)
  /**
   * DUE WORK, ONE ROW PER (job, workspace, slot).
   *
   * WHY. `maintenance_job_status` above is keyed by job NAME, and
   * the advisory lock behind it is one key per name, cluster-wide. So compacting
   * ONE workspace holds the `default_compaction` lock against every other
   * workspace, on every cell. At one workspace that is invisible; at a fleet it
   * serialises the entire maintenance plane behind whichever workspace is
   * slowest.
   *
   * TWO MECHANISMS, TWO QUESTIONS, NOT MERGED. Queue exclusion is this ROW:
   * claiming it with FOR UPDATE SKIP LOCKED is what stops two cells doing the
   * same unit of work. The advisory lock keeps its separate job: guarding the
   * MUTATION itself. Folding them together would make "who may run" and "who may
   * write" one answer, and they fail differently — a claim can expire safely, a
   * half-written mutation cannot.
   *
   * DEDUP BY UNIQUE INDEX ON A QUANTIZED SLOT, NO LEADER ELECTION. Every
   * cell may propose the same work with `ON CONFLICT DO NOTHING`; the unique
   * index makes exactly one row survive per slot. Nobody has to be elected to
   * decide what is due, which removes the failure mode where the elector dies
   * and the queue stops being filled. (Solid Queue's mechanism.)
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_due_work (
      job_name TEXT NOT NULL,
      landscape_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      -- The quantized slot. Two cells computing "compaction is due for this
      -- workspace" in the same window produce the SAME slot value, so the unique
      -- index below collapses them without either having to be the leader.
      slot TIMESTAMPTZ NOT NULL,
      -- NULL until claimed. A claim is a lease, not a flag: see claimed_until.
      claimed_by TEXT,
      -- THE VISIBILITY LEASE, and the reason a dead cell does not wedge a
      -- workspace until someone restarts it. A claim is only respected while
      -- this is in the future; past it, the row is claimable again by anyone.
      -- Nothing has to notice the death — the deadline does the work.
      claimed_until TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- DONE FOR THIS SLOT. The row is MARKED rather than deleted, and the
      -- first version of this table deleted it — which quietly cost the slot its
      -- only real job. Completion removed the row, so the very next tick
      -- re-proposed the same workspace successfully (a unique key can only
      -- collapse proposals against a row that still exists), and with a
      -- deterministic claim order the re-created rows sorted ahead of the
      -- workspaces that had never run: measured, a two-cell window compacted the
      -- SAME two workspaces twice and never reached the other two.
      --
      -- The tail this was meant to avoid is bounded by pruning every completed
      -- row from an earlier slot on each sweep, so the table still holds at most
      -- one row per workspace per job — the affordability argument is unchanged.
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (job_name, landscape_id, version_id, slot)
    )
  `)
  // Deployments created before `completed_at` existed. Additive and nullable, so
  // an in-flight row is unaffected: NULL is exactly "not completed".
  await pool.query(`
    ALTER TABLE maintenance_due_work ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
  `)
  /**
   * The claim scan's index: rows for one job, oldest slot first.
   *
   * NOT PARTIAL, and it cannot be. The natural predicate would be "claimable" —
   * `claimed_until IS NULL OR claimed_until < now()` — but `now()` is not
   * IMMUTABLE, and PostgreSQL rejects a non-immutable expression in an index
   * predicate.
   *
   * So the scan filters claimed rows at read time. That is affordable because
   * the queue is bounded by the workspace count: completed rows from earlier
   * slots are pruned on each sweep, leaving at most one row per workspace per
   * job.
   */
  await pool.query(`
    CREATE INDEX IF NOT EXISTS maintenance_due_work_claimable
      ON maintenance_due_work (job_name, slot)
  `)
  /**
   * WHERE AN UNATTENDED FSCK PUTS WHAT IT FOUND.
   *
   * A scheduled fsck whose report is returned and discarded finds nothing an
   * operator can see; this table is where the result lands.
   *
   * ONE ROW PER WORKSPACE, overwritten. This is a CURRENT-STATE table, not a
   * history: the question it answers is "what is wrong now", and an append-only
   * log would grow without bound while burying the answer. `maintenance_job_status`
   * already carries run history for the job as a whole.
   *
   * READ-ONLY BY CONSTRUCTION. The fsck job exercises the due-work QUEUE while
   * the worst a bug can do is write a wrong row here: if the queue mis-claims,
   * double-claims or starves, that shows up without an edit-loss path.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_fsck_finding (
      landscape_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('clean', 'violations', 'incomplete')),
      finding_count INTEGER NOT NULL DEFAULT 0,
      -- The codes, so an operator can tell a shared root from a dangling shard
      -- without opening the payload.
      finding_codes TEXT[] NOT NULL DEFAULT '{}',
      -- Which checks could not run. A workspace whose root would not resolve is
      -- incomplete, never clean: "nothing outstanding" is only true once
      -- everything has been looked at.
      --
      -- (No backticks anywhere in this DDL. It lives inside a JS template
      -- literal, and the first one ends the string — the same mistake made
      -- earlier today in gc.integration.test.ts, reported both times as an
      -- unhelpful "',' expected".)
      checks_skipped INTEGER NOT NULL DEFAULT 0,
      report JSONB,
      observed_by TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (landscape_id, version_id)
    )
  `)
}
