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

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  acquireMaintenanceWorkspaceLock,
  maintenanceWorkspaceLockKeyText,
  releaseMaintenanceWorkspaceLock,
  type MaintenanceWorkspaceKey,
} from './maintenanceWorkspaceLock.js'

/** Per-run options. `workspace` switches the exclusion from "one run of this job
 *  anywhere in the cluster" to "one run of this job on THIS workspace", which is
 *  the whole of per-workspace maintenance. Omitted, behaviour is unchanged. */
export interface MaintenanceRunOptions {
  readonly workspace?: MaintenanceWorkspaceKey
}

export const MAINTENANCE_LOCK_NAMESPACE = 1_111_578_706

export const MAINTENANCE_JOBS = {
  tag_operational_gc: 1,
  automerge_gc: 2,
  default_compaction: 3,
  technology_asset_gc: 4,
  minted_orphan_reaper: 5,
} as const

/**
 * Which jobs MAY be keyed per workspace, declared with the job and not passed in
 * by each caller.
 *
 * `automerge_gc` walks the ENTIRE Automerge Repo. Two runs of it keyed by
 * different workspaces would each believe they had exclusive access and each
 * compute an incomplete reachable set, and mark-and-sweep with an incomplete
 * reachable set deletes live documents. Declaring the scope here rather than at
 * the call site matters because that job name is already used from two places
 * with different intents: `globalGcWorker.ts` runs the global walk, and
 * `fsckQueue.ts` (`FSCK_JOB = 'automerge_gc'`) drives PER-WORKSPACE units under
 * the same name. If scope stayed a per-call-site string, the day the fsck tick is
 * routed through the coordinator that job becomes workspace-keyed on one path and
 * job-name-keyed on the destructive one — and those are disjoint advisory key
 * spaces (measured), so neither would exclude the other.
 */
export const WORKSPACE_KEYABLE_JOBS: Readonly<Record<MaintenanceJobName, boolean>> = {
  tag_operational_gc: false,
  automerge_gc: false,
  default_compaction: true,
  technology_asset_gc: false,
  // Fleet-wide like `automerge_gc`, for the opposite reason: it walks NOTHING.
  // Its predicate is local to each storage row (server-minted, unclaimed,
  // bound to no existing version, older than the floor), so two runs keyed by
  // different workspaces would not compute anything incomplete — but an
  // orphan by definition HAS no workspace to key on, so the key would be
  // meaningless. One job-name lease, one run at a time.
  minted_orphan_reaper: false,
}

/**
 * Whether per-workspace keying is switched on for this process. DEFAULT OFF, and
 * that default is the point.
 *
 * A workspace-keyed run takes the 1-arg `hashtextextended` key; a job-name-keyed
 * run takes the 2-arg `(namespace, jobId)` key. Those are separate key spaces, so
 * a replica on the OLD build and a replica on the NEW build do not exclude each
 * other at all. `compose.maplespire.yml` ships two API services, so during a
 * rolling deploy that flipped keying, two compactors could write the base
 * shards concurrently — the case `readModel/compaction.ts` states it
 * claims nothing about, on an unfenced job. Shipping the mechanism switched off
 * makes the cutover a separate, reversible act taken on a homogeneous fleet
 * instead of a side effect of deploying.
 *
 * Turning it on has prerequisites that are NOT met yet:
 *   - `maintenance_job_status` and `maintenance_job_fence` are keyed by job NAME,
 *     so two workspaces running one job share a row and one run's failure is
 *     recorded nowhere;
 *   - every replica must agree on the workspace key text, and `index.ts` falls
 *     back to `DEFAULT_WORKSPACE_KEY` (`versionId: 'current'`) when
 *     `canonicalWorkspaceKey` returns null — two replicas disagreeing there would
 *     key differently and not exclude each other.
 */
export function workspaceKeyedMaintenanceEnabled(
  env: { MAINTENANCE_WORKSPACE_KEYED?: string } = process.env,
): boolean {
  return env.MAINTENANCE_WORKSPACE_KEYED === 'on'
}

export type MaintenanceJobName = keyof typeof MAINTENANCE_JOBS
export type MaintenanceRunResult<T> =
  | { status: 'completed'; job: MaintenanceJobName; durationMs: number; value: T }
  | { status: 'skipped_locked'; job: MaintenanceJobName }
  | { status: 'skipped_stopping'; job: MaintenanceJobName }

export interface MaintenanceFence {
  job: MaintenanceJobName
  token: string
  /** The workspace this token was minted for, or `''` for a job-name-keyed run.
   *  The fence row is keyed by (job, landscape, version): without these, two
   *  workspaces running one fenced job share a token row and the second
   *  acquisition invalidates the first run's fence on a workspace it has nothing
   *  to do with. */
  landscapeId: string
  versionId: string
}

export class StaleMaintenanceFenceError extends Error {
  readonly code = 'stale_maintenance_fence'

  constructor() {
    super('Maintenance fencing rejected a stale mutation')
    this.name = 'StaleMaintenanceFenceError'
  }
}

/** Lock the fence row in the same transaction as a destructive mutation. A
 * successor cannot publish its higher token until this share lock commits;
 * once published, every old-token mutation fails. */
export async function assertMaintenanceFence(
  client: PoolClient,
  fence: MaintenanceFence,
): Promise<void> {
  const { rows } = await client.query<{ fencing_token: string | number }>(
    `SELECT fencing_token
     FROM maintenance_job_fence
     WHERE job_name = $1 AND landscape_id = $2 AND version_id = $3
     FOR SHARE`,
    [fence.job, fence.landscapeId, fence.versionId],
  )
  if (!rows[0] || String(rows[0].fencing_token) !== fence.token) {
    throw new StaleMaintenanceFenceError()
  }
}

export interface MaintenanceJobSnapshot {
  job: MaintenanceJobName
  /** The workspace this row is for, or `null` for a job-name-keyed run. */
  landscapeId: string | null
  versionId: string | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'orphaned'
  lockHeld: boolean
  startedAt: string | null
  finishedAt: string | null
  lastDurationMs: number | null
  lastErrorCode: string | null
  runCount: number
  failureCount: number
  skipCount: number
}

interface StatusRow {
  job_name: MaintenanceJobName
  landscape_id: string
  version_id: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  started_at: Date | string | null
  finished_at: Date | string | null
  last_duration_ms: string | number | null
  last_error_code: string | null
  run_count: string | number
  failure_count: string | number
  skip_count: string | number
  lock_held: boolean
}

function boundedErrorCode(error: unknown): string {
  const candidate = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : typeof (error as { name?: unknown })?.name === 'string'
      ? (error as { name: string }).name
      : 'maintenance_failed'
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64)
  return normalized || 'maintenance_failed'
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Runs each maintenance job at most once across every API replica sharing the
 * database. Locks are PostgreSQL session advisory locks, so the checked-out
 * PoolClient must stay pinned for the whole task.
 *
 * This is intentionally fail-closed and non-blocking: a losing replica skips
 * its scheduled/manual run instead of building an unbounded DB wait queue.
 */
export class MaintenanceCoordinator {
  private accepting = true
  private readonly active = new Set<Promise<void>>()

  constructor(
    private readonly pool: Pool,
    private readonly runnerId: string = randomUUID(),
    private readonly lockNamespace = MAINTENANCE_LOCK_NAMESPACE,
    /** Read ONCE, here, so the flag has exactly one reading in the process and a
     *  test can set it without touching the environment. Callers may always pass
     *  a workspace; this is what decides whether it is used as the key. */
    private readonly workspaceKeyingEnabled = workspaceKeyedMaintenanceEnabled(),
  ) {}

  run<T>(
    job: MaintenanceJobName,
    task: () => Promise<T>,
    options?: MaintenanceRunOptions,
  ): Promise<MaintenanceRunResult<T>> {
    if (!this.accepting) return Promise.resolve({ status: 'skipped_stopping', job })
    const execution = this.execute(job, async () => task(), false, options?.workspace)
    const tracked = execution.then(() => undefined, () => undefined)
    this.active.add(tracked)
    void tracked.finally(() => this.active.delete(tracked))
    return execution
  }

  runFenced<T>(
    job: MaintenanceJobName,
    task: (fence: MaintenanceFence) => Promise<T>,
    options?: MaintenanceRunOptions,
  ): Promise<MaintenanceRunResult<T>> {
    if (!this.accepting) return Promise.resolve({ status: 'skipped_stopping', job })
    const execution = this.execute(job, task, true, options?.workspace)
    const tracked = execution.then(() => undefined, () => undefined)
    this.active.add(tracked)
    void tracked.finally(() => this.active.delete(tracked))
    return execution
  }

  stopAccepting(): void {
    this.accepting = false
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active])
  }

  async clusterSnapshot(): Promise<{ generatedAt: string; accepting: boolean; activeOnThisReplica: number; jobs: MaintenanceJobSnapshot[] }> {
    const jobNames = Object.keys(MAINTENANCE_JOBS) as MaintenanceJobName[]
    const lockIds = jobNames.map((job) => MAINTENANCE_JOBS[job])
    const { rows } = await this.pool.query<StatusRow>(
      `SELECT
         jobs.job_name,
         COALESCE(status.landscape_id, '') AS landscape_id,
         COALESCE(status.version_id, '') AS version_id,
         COALESCE(status.status, 'idle') AS status,
         status.started_at,
         status.finished_at,
         status.last_duration_ms,
         status.last_error_code,
         COALESCE(status.run_count, 0) AS run_count,
         COALESCE(status.failure_count, 0) AS failure_count,
         COALESCE(status.skip_count, 0) AS skip_count,
         CASE WHEN COALESCE(status.landscape_id, '') = '' THEN EXISTS (
           -- Job-name-keyed: the TWO-argument key space, objsubid 2.
           SELECT 1 FROM pg_locks locks
           WHERE locks.locktype = 'advisory'
             AND locks.classid = $1::integer::oid
             AND locks.objid = jobs.lock_id::integer::oid
             AND locks.objsubid = 2
             AND locks.granted
         ) ELSE EXISTS (
           -- Workspace-keyed: the ONE-argument hashed key, objsubid 1, split
           -- across classid/objid as the high and low 32 bits. Reassembled here
           -- rather than reported as "not observed", which is what this row could
           -- not do while the table carried no workspace. Verified against a
           -- positive and a negative hash, each with a control.
           SELECT 1 FROM pg_locks locks
           WHERE locks.locktype = 'advisory'
             AND locks.objsubid = 1
             AND locks.classid = ((hashtextextended(
                   'maintenance-workspace:' || jobs.job_name || ':' || status.landscape_id
                   || ':' || status.version_id, 0) >> 32) & 4294967295)::bigint::oid
             AND locks.objid = (hashtextextended(
                   'maintenance-workspace:' || jobs.job_name || ':' || status.landscape_id
                   || ':' || status.version_id, 0) & 4294967295)::bigint::oid
             AND locks.granted
         ) END AS lock_held
       FROM unnest($2::text[], $3::integer[]) AS jobs(job_name, lock_id)
       LEFT JOIN maintenance_job_status status ON status.job_name = jobs.job_name
       ORDER BY jobs.lock_id, landscape_id, version_id`,
      [this.lockNamespace, jobNames, lockIds],
    )
    return {
      generatedAt: new Date().toISOString(),
      accepting: this.accepting,
      activeOnThisReplica: this.active.size,
      jobs: rows.map((row) => ({
        job: row.job_name,
        // One entry per (job, workspace). `landscapeId`/`versionId` are `null`
        // for a job-name-keyed run — the only kind that exists while
        // MAINTENANCE_WORKSPACE_KEYED is off — so with no workspace rows this
        // array is shaped exactly as it was.
        landscapeId: row.landscape_id === '' ? null : row.landscape_id,
        versionId: row.version_id === '' ? null : row.version_id,
        // `lock_held` now asks the key space this ROW actually uses, so
        // `orphaned` means what it has always meant. It briefly could not: while
        // the table carried no workspace, the predicate looked only in the
        // 2-argument space and every healthy workspace-keyed run rendered as a
        // dead runner — and `orphaned` is a paging alert.
        status: row.status === 'running' && !row.lock_held ? 'orphaned' : row.status,
        lockHeld: row.lock_held,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        lastDurationMs: row.last_duration_ms === null ? null : Number(row.last_duration_ms),
        lastErrorCode: row.last_error_code,
        runCount: Number(row.run_count),
        failureCount: Number(row.failure_count),
        skipCount: Number(row.skip_count),
      })),
    }
  }

  private async execute<T>(
    job: MaintenanceJobName,
    task: (fence: MaintenanceFence) => Promise<T>,
    fenced = false,
    workspace?: MaintenanceWorkspaceKey,
  ): Promise<MaintenanceRunResult<T>> {
    // FAIL CLOSED, BEFORE TAKING A CONNECTION. Both of these combinations
    // compile and are reachable through the `index.ts` wrappers; neither is
    // sound, and each fails in a way nothing downstream would report.
    if (workspace !== undefined) {
      if (!WORKSPACE_KEYABLE_JOBS[job]) {
        throw new Error(
          `maintenance job ${job}: not workspace-keyable — it operates on the whole Repo, and two `
          + 'runs keyed by different workspaces would each sweep with an incomplete reachable set',
        )
      }
    }
    const client = await this.pool.connect()
    let locked = false
    // Set the instant the acquisition ANSWERS, never around the attempt: the
    // guard has to track "is there a key to give back", not "did we ask for one".
    let workspaceLocked = false
    // Not `release(err)`-ing a healthy client: destruction is reserved for the
    // one case where the connection is genuinely unsafe to reuse — see the
    // `finally`.
    let poisoned: Error | null = null
    const lockId = MAINTENANCE_JOBS[job]
    // EXCLUSIVE with the per-job-name lock, not additive. Taking both would keep
    // serialising every workspace behind one job name, which is the property
    // per-workspace maintenance exists to end; and a second lock that excludes
    // nothing is only a second thing that can leak.
    //
    // ...but ONLY when the flag is on. With it off, a supplied workspace is
    // deliberately ignored and the job-name lock is taken exactly as before, so a
    // replica running this build and one running the previous build still take
    // the SAME key and still exclude each other. That is the whole reason the
    // decision lives here and not at the call site.
    const workspaceKeyText = workspace !== undefined && this.workspaceKeyingEnabled
      ? maintenanceWorkspaceLockKeyText(job, workspace)
      : null
    // The status and fence rows are keyed by the SAME thing the exclusion is
    // keyed by, and `''` means "excluded by the job name". Deriving both from
    // `workspaceKeyText` rather than from `workspace` is what keeps them
    // aligned: a run that supplied a workspace but is job-name-excluded (the
    // flag off) must write the job-name row, or two replicas would book-keep in
    // different rows while contending for one lock.
    const rowLandscapeId = workspaceKeyText !== null ? workspace!.landscapeId : ''
    const rowVersionId = workspaceKeyText !== null ? workspace!.versionId : ''
    try {
      if (!this.accepting) return { status: 'skipped_stopping', job }
      if (workspaceKeyText !== null) {
        workspaceLocked = await acquireMaintenanceWorkspaceLock(client, workspaceKeyText)
        if (!workspaceLocked) {
          await this.recordSkip(client, job, rowLandscapeId, rowVersionId)
          return { status: 'skipped_locked', job }
        }
      } else {
        const lockResult = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [this.lockNamespace, lockId],
        )
        locked = lockResult.rows[0]?.locked === true
        if (!locked) {
          await this.recordSkip(client, job, rowLandscapeId, rowVersionId)
          return { status: 'skipped_locked', job }
        }
      }
      if (!this.accepting) return { status: 'skipped_stopping', job }

      const startedAtMs = Date.now()
      await client.query(
        `INSERT INTO maintenance_job_status (
           job_name, landscape_id, version_id, runner_id, status, started_at, finished_at,
           last_duration_ms, last_error_code, run_count, updated_at
         ) VALUES ($1, $3, $4, $2, 'running', now(), NULL, NULL, NULL, 1, now())
         ON CONFLICT (job_name, landscape_id, version_id) DO UPDATE SET
           runner_id = EXCLUDED.runner_id,
           status = 'running',
           started_at = now(),
           finished_at = NULL,
           last_duration_ms = NULL,
           last_error_code = NULL,
           run_count = maintenance_job_status.run_count + 1,
           updated_at = now()`,
        [job, this.runnerId, rowLandscapeId, rowVersionId],
      )

      try {
        const fence = fenced
          ? await this.acquireFence(client, job, rowLandscapeId, rowVersionId)
          : { job, token: 'unfenced', landscapeId: rowLandscapeId, versionId: rowVersionId }
        const value = await task(fence)
        const durationMs = Math.max(0, Date.now() - startedAtMs)
        // The workspace is in the WHERE, not only the runner id. Without it a
        // concurrent run on another workspace that overwrote `runner_id` would
        // make this match zero rows — and on the failure path below that means a
        // failure incremented nothing and wrote no error code, which are two of
        // the alert conditions the runbook names.
        await client.query(
          `UPDATE maintenance_job_status SET
             status = 'completed', finished_at = now(), last_duration_ms = $3,
             last_error_code = NULL, updated_at = now()
           WHERE job_name = $1 AND runner_id = $2 AND landscape_id = $4 AND version_id = $5`,
          [job, this.runnerId, durationMs, rowLandscapeId, rowVersionId],
        )
        return { status: 'completed', job, durationMs, value }
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs)
        await client.query(
          `UPDATE maintenance_job_status SET
             status = 'failed', finished_at = now(), last_duration_ms = $3,
             last_error_code = $4, failure_count = failure_count + 1, updated_at = now()
           WHERE job_name = $1 AND runner_id = $2 AND landscape_id = $5 AND version_id = $6`,
          [job, this.runnerId, durationMs, boundedErrorCode(error), rowLandscapeId, rowVersionId],
        ).catch(() => undefined)
        throw error
      }
    } finally {
      if (locked) {
        // Answered, not assumed — the same reason spelled out for the workspace
        // key below. `pg_advisory_unlock` RETURNS false rather than raising when
        // the session does not hold the key, so discarding its value would make
        // a lock that had already evaporated release exactly like a clean one.
        const released = await client
          .query<{ released: boolean }>(
            'SELECT pg_advisory_unlock($1, $2) AS released',
            [this.lockNamespace, lockId],
          )
          .then((r) => ({ confirmed: r.rows[0]?.released === true, error: null as string | null }))
          .catch((error: unknown) => ({
            confirmed: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        if (!released.confirmed) {
          poisoned = new Error(
            `maintenance job lock ${this.lockNamespace}/${lockId} (${job}) was not confirmed released`
            + `${released.error ? `: ${released.error}` : ' (pg_advisory_unlock returned false)'}`
            + ' — destroying the connection so the session, and the lock with it, ends',
          )
          console.error(`[maintenance] ${poisoned.message}`)
        }
      }
      if (workspaceLocked && workspaceKeyText !== null) {
        const released = await releaseMaintenanceWorkspaceLock(client, workspaceKeyText)
        if (!released.confirmed) {
          // A session advisory lock outlives `client.release()` — it dies with the
          // BACKEND, not with the checkout. So a key we could not confirm giving
          // back is still held on a connection about to be handed to somebody
          // else, and every later run keyed the same way would be refused for
          // ever, silently. Destroying the client ends the session, which is the
          // only thing that certainly drops the key.
          // `pg-pool/index.js` — `release(err)` with a truthy err routes to
          // `_remove` instead of returning the client to the pool.
          poisoned = new Error(
            `maintenance workspace lock ${workspaceKeyText} was not confirmed released`
            + `${released.error ? `: ${released.error}` : ' (pg_advisory_unlock returned false)'}`
            + ' — destroying the connection so the session, and the lock with it, ends',
          )
          console.error(`[maintenance] ${poisoned.message}`)
        }
      }
      client.release(poisoned ?? undefined)
    }
  }

  private async acquireFence(
    client: PoolClient,
    job: MaintenanceJobName,
    landscapeId: string,
    versionId: string,
  ): Promise<MaintenanceFence> {
    const { rows } = await client.query<{ fencing_token: string | number }>(
      `INSERT INTO maintenance_job_fence (job_name, landscape_id, version_id, fencing_token, owner_id, acquired_at)
       VALUES ($1, $3, $4, 1, $2, NOW())
       ON CONFLICT (job_name, landscape_id, version_id) DO UPDATE SET
         fencing_token = maintenance_job_fence.fencing_token + 1,
         owner_id = EXCLUDED.owner_id,
         acquired_at = NOW()
       RETURNING fencing_token`,
      [job, this.runnerId, landscapeId, versionId],
    )
    const token = rows[0]?.fencing_token
    if (token === undefined) throw new Error('Maintenance fence acquisition returned no token')
    return { job, token: String(token), landscapeId, versionId }
  }

  private async recordSkip(
    client: PoolClient,
    job: MaintenanceJobName,
    landscapeId: string,
    versionId: string,
  ): Promise<void> {
    // Keyed like the exclusion that caused the skip, so "this workspace is busy"
    // and "the job name is globally held" stop landing in one counter.
    await client.query(
      `INSERT INTO maintenance_job_status (job_name, landscape_id, version_id, status, skip_count, updated_at)
       VALUES ($1, $2, $3, 'idle', 1, now())
       ON CONFLICT (job_name, landscape_id, version_id) DO UPDATE SET
         skip_count = maintenance_job_status.skip_count + 1,
         updated_at = now()`,
      [job, landscapeId, versionId],
    )
  }
}
