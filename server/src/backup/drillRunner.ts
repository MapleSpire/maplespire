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

import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Pool } from 'pg'
import {
  createDatabaseBackup,
  createTemporaryRestoreDatabase,
  dropOrphanedRestoreDatabases,
  DEFAULT_SWEEP_MAX_DROPS,
  ORPHAN_MINIMUM_AGE_MS,
  DocumentProbeError,
  POOL_CONNECT_TIMEOUT_MS,
  restoreAndVerifyDatabase,
  type BackupManifest,
  type OrphanedRestoreSweep,
  type PgTools,
  type RestoreVerification,
} from './backupRestore.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { deriveColdApiExpectation, runColdApiChecks } from './coldApi.js'
import { startColdServer } from './coldServer.js'
import {
  newDrillId,
  recordDrillRun,
  signDrillReport,
  type ColdApiOutcome,
  type DrillReport,
  type SignedDrillReport,
  type SourceIntegrity,
} from './drillReport.js'
import { runTeardownSteps, type TeardownStep } from '../runtime/teardownSteps.js'
import { pruneBackupBundles, pruneDrillHistory, type BundleRetentionResult, type DrillRetentionResult } from './retention.js'

/**
 * One drill, start to finish, as a library call.
 *
 * This lives under `src/` rather than in `server/scripts/` on purpose: the
 * tsconfig compiles `src/**` into `dist/`, and `scripts/` is tsx-only. An
 * operational job that runs on a schedule in production has to be part of the
 * shipped artifact — a drill that can only run from a source checkout with dev
 * dependencies installed is a drill that does not run where it matters.
 *
 * `server/scripts/backup-restore-drill.ts` is a thin CLI over this.
 */

export type BackupDrillOptions = {
  databaseUrl: string
  bundleDirectory: string
  pgTools: PgTools
  applicationRevision?: string
  maxDocumentProbes?: number
  assetDirectory?: string
  /** Boot a server against the isolated restore and probe the read-model pages. */
  coldApi?: boolean
  keepRestoreDatabase?: boolean
  /**
   * Wall-clock ceiling on each teardown obligation. Defaults to
   * `TEARDOWN_STEP_TIMEOUT_MS`; raise it for a cluster whose checkpoints are slower than
   * anything measured here, lower it in a test that needs the ceiling to fire.
   */
  teardownStepTimeoutMs?: number
  /** Where to write the signed report. The bundle keeps its own copy regardless. */
  reportPath?: string
  serverRoot?: string
  /**
   * Cut the drill short. Aborted by the per-tick deadline, and by SIGTERM
   * reaching the scheduler.
   *
   * **What it reaches, and what it does not** — a signal threaded halfway
   * gives the *feeling* of a bound, so its coverage is stated:
   *
   *  - REACHES `pgTools.dump` and `pgTools.restore`, which is where a drill
   *    spends most of its minutes. (The hangs actually observed so far were
   *    `DROP DATABASE ... WITH (FORCE)` in TEARDOWN, not `pg_dump`.)
   *  - DOES NOT reach `coldApiCheck`, the document probes, or the SQL this file
   *    issues directly. Each of those carries a ceiling of its own (120 s boot
   *    and 120 s deadline in `coldServer`/`coldApi`, `findReadyDocument` for the
   *    probes, `POOL_CONNECT_TIMEOUT_MS` on every pool), so the uncovered
   *    regions are bounded — just not CANCELLABLE.
   *
   * So an abort makes a drill stop *promptly* in the common case and *not at
   * all* in the rest. `runDrillTick` is written for both: it waits a bounded
   * grace for this function to settle and abandons the process when it does not.
   */
  signal?: AbortSignal
  /** `false` disables autoclean for this run; otherwise byte budgets apply. */
  retention?: false | {
    historyBudgetBytes?: number
    historyMinimumRows?: number
    bundleRoot?: string
    bundleBudgetBytes?: number
    /** Age gate for unfinished bundle directories. Omitted means none are ever
     * removed; the scheduler passes `partialSweepMinimumAgeMs(maxDrillHold)`
     * and the one-shot CLI deliberately does not, because it cannot know how
     * long a scheduled drill elsewhere may still be dumping. */
    partialMaxAgeMs?: number
  }
}

/**
 * What the drill managed to CLEAN UP, as opposed to what it verified.
 *
 * Reported rather than assumed because the drop is bounded by a wall clock, so
 * the answer to "was the isolated database removed?" is "usually, and here is
 * how you tell". An answer derived from a flag such as `--keep-target` would
 * state an intention and call it an observation.
 */
export type BackupDrillTeardown = {
  restoreDatabase: string | null
  /**
   * Wall-clock time the drop actually took. Emitted so the teardown ceiling can
   * be re-derived from real runs.
   */
  restoreDropMs: number | null
  /** Teardown's own duration, which is deliberately NOT part of `rtoMs`. */
  teardownMs: number
  /** `true` only when the drop was OBSERVED to finish, never when it was merely started. */
  restoreDatabaseDropped: boolean
  /** `null` when sweeping was not requested for this run. */
  orphans: OrphanedRestoreSweep | null
  /** The aggregated ceiling/failure message, naming the step. */
  failure: string | null
}

export type BackupDrillOutcome = {
  signed: SignedDrillReport
  verification: RestoreVerification | null
  coldApi: ColdApiOutcome | null
  history: DrillRetentionResult | null
  bundles: BundleRetentionResult | null
  teardown: BackupDrillTeardown
  failure: Error | null
}

const DEFAULT_SERVER_ROOT = resolve(import.meta.dirname, '..', '..')

/**
 * Ceiling on each teardown obligation.
 *
 * `DROP DATABASE ... WITH (FORCE)` waits on `IPC / ProcSignalBarrier`: every
 * busy backend must absorb a barrier, so its cost tracks how busy the OTHER
 * sessions are, not the size of what is dropped. Ten forced drops per arm on
 * the CI container:
 *
 *   idle cluster ................ 40 ms median, 1.5 s worst
 *   eight concurrent writers .... 35 s median, 301 s worst
 *
 * so a merely-slow drop CAN exceed 120 s and be abandoned. That is safe: the
 * statement finishes server-side whether or not anyone is still waiting for it
 * (asserted in `backupRestore.integration.test.ts`, "finishes a drop nobody is
 * waiting for"). What the ceiling buys is a failure that NAMES the step instead
 * of a teardown that never returns.
 *
 * For the sweep step the cost is nearly nothing, because `onProgress` keeps
 * whatever that sweep already did. The other obligations have no progress
 * callback — abandoning `restore target database` leaks a database until some
 * later sweep reclaims it, a real if bounded cost.
 *
 * It is also negligible against the scheduler's floor of a 15-minute cadence,
 * so a drop that is stuck never costs a tick.
 */
export const TEARDOWN_STEP_TIMEOUT_MS = 120_000

/**
 * Re-exported, not defined here, since the restore-database census in
 * `/metrics` needs the same gate. Importing THIS module to get it would drag
 * `coldServer` — a whole HTTP server — plus `coldApi`, `assetArchive` and
 * `node:child_process` into the API entrypoint's module graph for one number.
 * It lives beside `MINIMUM_SWEEPABLE_AGE_MS`, which is the floor it must
 * respect, so the two constants that gate the same decision read together.
 *
 * Imported at the top as well as re-exported here: `export … from` creates no
 * local binding, and this module uses the constant in three places.
 */
export { ORPHAN_MINIMUM_AGE_MS }

/**
 * Wall clock on the whole boot sweep.
 *
 * `dropOrphanedRestoreDatabases` already bounds itself — `budgetMs` and
 * `maxDrops` — but both of those gate STARTING a drop and neither can interrupt
 * one in flight, and this call has no ceiling above it the way the teardown
 * sweep has `TEARDOWN_STEP_TIMEOUT_MS`.
 *
 * A minute is roughly ONE forced drop under contention (see
 * `TEARDOWN_STEP_TIMEOUT_MS`), not a comfortable multiple of one. That is
 * acceptable because this ceiling is a `Promise.race` that steps OVER a slow
 * sweep and keeps its partial progress, so being reached costs a few reclaimed
 * databases at boot and never a drill.
 */
export const BOOT_SWEEP_CEILING_MS = 60_000

/**
 * Headroom between the last drop this sweep may START and the ceiling firing.
 *
 * It is what keeps "one stuck drop outlives the ceiling" from becoming "the
 * abandoned loop keeps starting NEW drops while the first `pg_dump` runs",
 * each of them a cluster-wide `CHECKPOINT_IMMEDIATE` on production.
 */
export const BOOT_SWEEP_MARGIN_MS = 5_000

/**
 * Budget for the boot sweep's drop loop, DERIVED from the ceiling above it.
 *
 * `dropOrphanedRestoreDatabases` arms its budget AFTER the admin connect, so
 * the latest a drop may START is `connect + budget`. With the defaults,
 * `POOL_CONNECT_TIMEOUT_MS + DEFAULT_SWEEP_BUDGET_MS` = 30 000 + 30 000 is
 * exactly `BOOT_SWEEP_CEILING_MS` — no margin at all. Hence a function of the
 * EFFECTIVE ceiling rather than a third literal: a caller that shortens the
 * ceiling shortens this with it.
 *
 * The floor exists because a test may set a ceiling smaller than the connect
 * timeout; there the subtraction is meaningless and the sweep is abandoned long
 * before the budget matters either way.
 */
export function bootSweepBudgetMs(ceilingMs: number): number {
  return Math.max(1_000, ceilingMs - POOL_CONNECT_TIMEOUT_MS - BOOT_SWEEP_MARGIN_MS)
}

/**
 * How old a restore database must be before a BOOT sweep may claim it.
 *
 * Derived rather than picked. The teardown sweep runs while holding the advisory
 * lock; this one runs before the first tick, with no lock, so a rival scheduler
 * may be mid-drill and its isolated restore database is not ours to delete. What
 * bounds that database's age is the rival's own hold: it is created inside
 * `runBackupDrill`, so it is younger than the run, and a run cannot outlive
 * `deadline + grace` before its process ends. Anything older than that belongs
 * to no drill that is still alive.
 *
 * Floored at `ORPHAN_MINIMUM_AGE_MS` so a deployment with a short cadence — an
 * hourly drill derives a 55-minute deadline — cannot lower the gate the teardown
 * sweep already trusts.
 *
 * This rests on the RIVAL honouring the same deadline. A neighbour configured
 * with a longer one, or a build with no deadline at all, is outside what this
 * can reason about — the six-hour floor covers that case, the same exposure
 * the teardown sweep has.
 */
export function bootSweepMinimumAgeMs(maxDrillHoldMs: number): number {
  return Math.max(ORPHAN_MINIMUM_AGE_MS, maxDrillHoldMs)
}

/**
 * How old an UNFINISHED BUNDLE DIRECTORY must be before a sweep may remove it.
 *
 * Deliberately beside `bootSweepMinimumAgeMs` and floored on the same constant,
 * because it is the same argument about the same rival — one sweep reclaims a
 * restore database, this one reclaims a directory, and both are recursive
 * deletes against something a live run may still own.
 *
 * The floor matters: `BACKUP_DRILL_INTERVAL_HOURS=1` derives a one-hour hold,
 * and the one-shot CLI (`scripts/backup-restore-drill.ts`) has no deadline and
 * no advisory lock at all. Without the floor, a manual backup written into a
 * scheduler-shaped name could be recursively deleted mid-dump.
 *
 * Non-finite input is refused rather than clamped. `Math.max(0, NaN)` is `NaN`,
 * and `age <= NaN` is FALSE for every age, so the clamp that looks defensive
 * would delete every partial including one a millisecond old — a recursive
 * delete failing open, which is the direction that costs a backup.
 */
export function partialSweepMinimumAgeMs(maxDrillHoldMs: number): number {
  if (!Number.isFinite(maxDrillHoldMs)) {
    throw new Error(`partialSweepMinimumAgeMs needs a finite hold, got ${String(maxDrillHoldMs)}`)
  }
  return Math.max(ORPHAN_MINIMUM_AGE_MS, maxDrillHoldMs)
}

/**
 * Replace a file without ever showing a reader a half-written one.
 *
 * `writeFile` opens with `w`, which TRUNCATES: between the open and the write
 * the file is zero bytes, and a reader arriving there does not get a bad report
 * — it gets an unparseable one (a 400 kB `latest-report.json` read during its
 * own replacement measured **0 bytes**). It is not the DURABLE record — that is
 * `backup_drill_runs` — and nothing here fsyncs the file or its parent.
 *
 * Staged in the same directory so the `rename` is within one filesystem, and
 * the guarantee it buys differs by platform. POSIX: an atomic replace, readers
 * see the old report or the new one and never neither. Windows: the rename
 * fails **EPERM** while any reader holds the file open, so what a reader is
 * protected from is a TRUNCATED report — the new one is dropped instead. Still
 * strictly better than writing in place.
 *
 * It does NOT survive a KILL between the write and the rename. The `catch`
 * removes the staging file on a rejection, and a SIGKILL raises none — so a
 * stray `latest-report.json.tmp-*` is left in the bundle root, where the bundle
 * sweep cannot see it (it filters on `isDirectory`). `sweepStrayReportStaging`
 * is what removes it.
 */
export async function writeReportAtomically(finalPath: string, contents: string): Promise<void> {
  const staging = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(staging, contents, 'utf8')
    await rename(staging, finalPath)
  } catch (error) {
    await rm(staging, { force: true, maxRetries: 3 }).catch(() => undefined)
    throw error
  }
  // After the rename, so a failure here can never cost the report. Best-effort,
  // errors ignored: this is housekeeping, and the run it belongs to has already
  // produced its evidence.
  await sweepStrayReportStaging(finalPath).catch(() => undefined)
}

/** Anything older than this cannot be a live writer's staging file. A report is
 * a few hundred kilobytes and the window between its write and its rename is
 * sub-millisecond, so an hour is four orders of magnitude of headroom — chosen
 * to be obviously safe rather than tight, because the cost of waiting is one
 * stale file and the cost of being wrong is a concurrent writer's report. */
const REPORT_STAGING_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Remove `<report>.tmp-<pid>-<hex>` files that no writer can still own.
 *
 * These are invisible to everything else: `pruneBackupBundles` filters
 * `entry.isDirectory()`, so a stray FILE in the bundle root is not in
 * `skipped`, not in `partials`, not in any byte figure. One accumulates per
 * process death inside the write window — and the defining property of this
 * drill's abandonment path is that it ENDS THE PROCESS rather than throwing, so
 * the `catch` above cannot be the answer.
 *
 * mtime is the right clock here and the name is not, unlike one directory up: a
 * staging file's name carries a pid, not a timestamp, and pids mean nothing
 * across containers sharing a volume.
 */
export async function sweepStrayReportStaging(
  finalPath: string,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? REPORT_STAGING_MAX_AGE_MS
  const directory = dirname(finalPath)
  const prefix = `${basename(finalPath)}.tmp-`
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    const path = join(directory, entry.name)
    const info = await stat(path).catch(() => null)
    // Unreadable, or young enough that a writer may still be mid-rename: keep.
    if (info === null || now - info.mtimeMs <= maxAgeMs) continue
    await rm(path, { force: true, maxRetries: 3 }).catch(() => undefined)
    removed.push(entry.name)
  }
  return removed
}

export interface BootSweepOptions {
  readonly databaseUrl: string
  /** The longest one drill can hold on, under this deployment's configuration:
   *  `deadlineMs + abortGraceMs`. See `bootSweepMinimumAgeMs`. */
  readonly maxDrillHoldMs: number
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  readonly ceilingMs?: number
  readonly budgetMs?: number
  /** Injected so the failure and timeout paths can be driven without a cluster
   *  — "a sweep never fails" is exactly the assumption that lets a swallowed
   *  error ship, and this one runs where nobody is watching. */
  readonly sweep?: typeof dropOrphanedRestoreDatabases
}

/**
 * Reclaim restore databases a PREVIOUS PROCESS left behind, before drilling.
 *
 * The sweep already ran in `runBackupDrill`'s teardown, and that covers every
 * way one drill can fail — including a throw, since the sweep is in a `finally`.
 * What it cannot cover is the run whose teardown never happens: an abandoned
 * drill calls `process.exit`, a SIGKILL at the end of the orchestrator's grace
 * takes the container mid-dump, the host reboots. Each of those leaves an
 * isolated restore database AND skips the only thing that would have reclaimed
 * it.
 *
 * On a healthy deployment that is harmless — the next night's drill sweeps it.
 * The case that is not harmless is the one the deadline exists for: a
 * DETERMINISTIC wedge under `restart: always`. Every cycle abandons, exits
 * before teardown, and restarts, so the teardown sweep never runs again at all
 * and the cluster accumulates one restore database per cycle, indefinitely, in
 * precisely the state where nobody is reading the logs.
 *
 * Boot is the right trigger because a boot is what follows a process that did
 * not tear down.
 *
 * **It may never prevent a drill.** That is why this function returns `null`
 * instead of throwing: a JANITORIAL step in front of the copy must not be able
 * to abort it. Every failure here is logged and swallowed, and the ceiling is a
 * `Promise.race` so a sweep that hangs is stepped over rather than waited on.
 *
 * It does not empty the cluster on the first boot after a long wedge.
 * `maxDrops` caps one pass at TWO — half the teardown sweep's five, computed
 * below rather than written as a literal — because each successful
 * `DROP DATABASE ... WITH (FORCE)` is a cluster-wide `CHECKPOINT_IMMEDIATE` on
 * the PRODUCTION cluster, and a first sweep after an outage must not become an
 * I/O event of its own. The cap is reported as `remaining` rather than left
 * silent.
 *
 * Convergence has a precondition: a pass reclaims up to `maxDrops` databases
 * it CAN drop, so the cap counts successes only — were it to count failures,
 * two undroppable databases at the head of the oldest-first list would consume
 * it on every boot. See `DEFAULT_SWEEP_MAX_FAILURES` for the residual that is
 * still not covered.
 */
export async function sweepOrphanedRestoreDatabasesAtBoot(
  options: BootSweepOptions,
): Promise<OrphanedRestoreSweep | null> {
  const ceilingMs = options.ceilingMs ?? BOOT_SWEEP_CEILING_MS
  const minimumAgeMs = bootSweepMinimumAgeMs(options.maxDrillHoldMs)
  const sweep = options.sweep ?? dropOrphanedRestoreDatabases
  const startedAt = Date.now()
  // Guarded like every other caller-supplied sink in this subsystem. This
  // function's whole contract is that it cannot fail the drill, and an
  // unguarded log call is a caller deciding whether the backup happens.
  const log = (event: string, fields: Record<string, unknown>): void => {
    try {
      options.log(event, fields)
    } catch {
      // Nothing to escalate to: the only channel is the one that just failed.
    }
  }
  // Whatever the sweep managed before it was stepped over. Without it, a sweep
  // that dropped three databases and then blocked reports nothing at all, which
  // reads as "there was nothing to do".
  // A holder rather than a bare `let`: TypeScript narrows a `let` initialised to
  // `null` and cannot see the assignment inside the callback below, so every
  // later read would be typed `null` and need a cast. A property read is
  // re-widened at each call boundary, so the type stays honest with no
  // assertion.
  const partial: { sweep: OrphanedRestoreSweep | null } = { sweep: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((settle) => {
    timer = setTimeout(() => settle('expired'), ceilingMs)
    timer.unref?.()
  })
  // `Promise.resolve().then(...)` rather than a bare call: `sweep` is typed
  // `(url, options) => Promise<…>`, which a non-`async` function throwing
  // SYNCHRONOUSLY satisfies. Such a throw would escape before the `try` below,
  // reach `main()` and, under `restart: always`, become a crash loop with no
  // backups at all. The production default is `async`, but the seam is
  // injectable, so a synchronous throw from it must be caught all the same.
  const running = Promise.resolve().then(() => sweep(options.databaseUrl, {
    minimumAgeMs,
    // Never `options.budgetMs` alone: an absent budget would fall through to
    // `DEFAULT_SWEEP_BUDGET_MS`, which lands the last permitted drop-start
    // exactly ON the ceiling. See `bootSweepBudgetMs`.
    budgetMs: options.budgetMs ?? bootSweepBudgetMs(ceilingMs),
    // Below the teardown sweep's cap, and derived rather than chosen: that cap
    // bounds I/O per CADENCE (once a day by default), while this one runs per
    // process START — which is the pathological variable in precisely the
    // restart loop it exists for. Each `DROP DATABASE ... WITH (FORCE)` is a
    // cluster-wide CHECKPOINT_IMMEDIATE on the PRODUCTION cluster, and a crash
    // loop must not turn reclamation into an I/O event of its own. Convergence
    // is slower and still monotone, because `maxDrops` counts successes only.
    //
    // Written as a fraction of the other cap rather than as a second literal:
    // the justification is the RELATION, which two independent numbers would
    // not keep.
    maxDrops: Math.max(1, Math.floor(DEFAULT_SWEEP_MAX_DROPS / 2)),
    // `maxFailures` is deliberately LEFT AT ITS DEFAULT — not halved the way
    // the drop cap is. The halving buys a bound on CHECKPOINT I/O, and a failed
    // drop performs no checkpoint, so halving the failure cap would buy nothing
    // and would let undroppable databases starve the sweep at half the
    // threshold. Pinned by `drillBootSweep.test.ts`.
    onProgress: (snapshot) => { partial.sweep = snapshot },
  }))
  // The race may abandon it, and an abandoned sweep that rejects later would
  // otherwise be an unhandled rejection attributed to whatever is running by
  // then — which, at boot, is the first drill.
  running.catch(() => undefined)
  try {
    const outcome = await Promise.race([running, expired])
    if (outcome === 'expired') {
      log('backup.drill_boot_sweep_timeout', {
        // "Stepped over", never "stopped": nothing here can cancel a
        // `DROP DATABASE`, so at most one drop is still in flight while the
        // first dump starts. At most one, structurally: the sweep's own
        // `budgetMs` stops it STARTING new drops well before this ceiling
        // fires, so only a single stuck drop can outlive it.
        detail: 'the boot sweep of orphaned restore databases was stepped over and may still have '
          + 'one drop in flight; the drill starts anyway and the next boot retries',
        ceilingMs,
        minimumAgeMs,
        ...describeSweep(partial.sweep),
      })
      return partial.sweep
    }
    log('backup.drill_boot_sweep', { minimumAgeMs, tookMs: Date.now() - startedAt, ...describeSweep(outcome) })
    return outcome
  } catch (error) {
    log('backup.drill_boot_sweep_failed', {
      detail: 'reclaiming orphaned restore databases failed; this never blocks the drill',
      error: error instanceof Error ? error.message : String(error),
      minimumAgeMs,
      ...describeSweep(partial.sweep),
    })
    return partial.sweep
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function describeSweep(sweep: OrphanedRestoreSweep | null): Record<string, unknown> {
  // Nulls, never zeros, when nothing could be counted. `dropped: 0` beside a
  // timeout reads as "the cluster was clean", which is the one thing this run
  // did not establish.
  if (!sweep) {
    return {
      candidates: null, dropped: null, failed: null, remaining: null,
      completed: false, stoppedBy: null,
    }
  }
  return {
    candidates: sweep.candidates,
    dropped: sweep.dropped.length,
    // A sweep failing on every candidate every night would otherwise print
    // `dropped: 0` and read exactly like a clean cluster.
    //
    // `failedCount`, never `failed.length`: `failed` is a bounded SAMPLE, so
    // reading its length would under-report the moment the sample cap bites.
    failed: sweep.failedCount,
    failures: sweep.failed,
    failuresTruncated: sweep.failedCount > sweep.failed.length,
    remaining: sweep.remaining,
    completed: sweep.completed,
    // `?? 'unknown'` rather than a bare read: `completed: true` covers five
    // operationally opposite outcomes, so this is the field that separates
    // them, and a fixture that forgets to set it should say `unknown` rather
    // than print nothing. Server test files are excluded from typechecking, so
    // no compiler enforces the field there.
    stoppedBy: sweep.stoppedBy ?? 'unknown',
  }
}

async function coldApiCheck(
  restoredDatabaseUrl: string,
  assetDirectory: string,
  serverRoot: string,
  onOutput: (text: string) => void,
): Promise<ColdApiOutcome> {
  // Attached to the RESTORE database, which teardown drops `WITH (FORCE)` — the
  // single most likely source of an idle-client kill in this file.
  const pool = guardIdleClientErrors(new Pool({
    connectionString: restoredDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  }), 'cold-api')
  let expectation
  try {
    expectation = await deriveColdApiExpectation(pool)
  } finally {
    await pool.end()
  }
  const server = await startColdServer({
    databaseUrl: restoredDatabaseUrl,
    serverRoot,
    assetDirectory,
  })
  try {
    const outcome = await runColdApiChecks({ baseUrl: server.baseUrl, expectation })
    if (outcome.outcome !== 'passed') {
      // The child's stdio is the only place the reason exists — a failing check
      // reports "HTTP 500" and the stack trace is over there.
      onOutput(server.output().slice(-4_000))
    }
    return outcome
  } finally {
    await server.stop()
  }
}

export async function runBackupDrill(options: BackupDrillOptions): Promise<BackupDrillOutcome> {
  const startedAt = new Date()
  const serverRoot = options.serverRoot ?? DEFAULT_SERVER_ROOT
  const resolvedBundle = resolve(options.bundleDirectory)

  let manifest: BackupManifest | null = null
  let verification: RestoreVerification | null = null
  let coldApi: ColdApiOutcome | null = null
  let failure: Error | null = null
  // Mutable, and still being written to AFTER the ceiling fires: an abandoned
  // step keeps running. What the caller receives is a snapshot taken the moment
  // teardown settles (see `publishedTeardown`), so a drop that finishes at 121 s
  // cannot print `restoreDatabaseDropped: true` beside a
  // "still running after 120000 ms" error, depending on nothing but timing.
  const teardown: BackupDrillTeardown = {
    restoreDatabase: null,
    restoreDropMs: null,
    teardownMs: 0,
    restoreDatabaseDropped: false,
    orphans: null,
    failure: null,
  }
  /**
   * Stopped BEFORE teardown, on purpose. `rtoMs` is the signed, stored,
   * gauge-exported Recovery Time Objective, and a real recovery does not drop a
   * throwaway database or sweep another run's litter. Leaving the clock running
   * through the `finally` would inflate a compliance figure by up to the
   * teardown ceiling.
   */
  let finishedAt: Date | undefined
  let publishedTeardown: BackupDrillTeardown | undefined
  // Created up front so the `finally` can always clean it up, including when
  // the backup itself throws.
  const restoredAssets = await mkdtemp(join(tmpdir(), 'maplespire-drill-assets-'))
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>> | null = null

  try {
    manifest = await createDatabaseBackup({
      databaseUrl: options.databaseUrl,
      bundleDirectory: resolvedBundle,
      pgTools: options.pgTools,
      applicationRevision: options.applicationRevision,
      maxDocumentProbes: options.maxDocumentProbes,
      assetDirectory: options.assetDirectory,
      signal: options.signal,
      // Recorded on the partial directory so a retention report can name which
      // party is holding it. The liveness gate keys on host and pid; this only
      // decides whether the report says `drill` or `cli`.
      ownerKind: 'drill',
    })
    target = await createTemporaryRestoreDatabase(options.databaseUrl)
    verification = await restoreAndVerifyDatabase({
      sourceDatabaseUrl: options.databaseUrl,
      targetDatabaseUrl: target.url,
      bundleDirectory: resolvedBundle,
      pgTools: options.pgTools,
      assetTargetDirectory: restoredAssets,
      signal: options.signal,
    })
    coldApi = options.coldApi
      ? await coldApiCheck(target.url, restoredAssets, serverRoot, (text) => {
        console.error(`[backup-drill] cold server output:\n${text}`)
      })
      : { outcome: 'skipped', checks: [] }
    if (coldApi.outcome === 'failed') {
      const failed = coldApi.checks.filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.detail}`)
      throw new Error(`Cold API verification failed:\n- ${failed.join('\n- ')}`)
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    finishedAt = new Date()
    const teardownStartedAt = Date.now()
    // Concurrent, ceilinged steps rather than a sequence of `await`s. One
    // un-ceilinged wait in a sequence means the steps after it never run and
    // `runBackupDrill` never returns, so the drill produces no report and no
    // recorded run — a drill that hangs would leave less evidence than one that
    // fails. See `runtime/teardownSteps.ts`.
    const steps: TeardownStep[] = []
    if (target) {
      const isolated = target
      teardown.restoreDatabase = isolated.database
      if (options.keepRestoreDatabase) {
        steps.push({
          name: `retaining database ${isolated.database}`,
          run: async () => {
            // Renames it out of the sweepable namespace. Retaining it under the
            // old name would leave the scheduler free to delete it in six hours.
            const kept = await isolated.retain()
            teardown.restoreDatabase = kept
            console.warn(`[backup-drill] retained isolated database as ${kept} by request`)
          },
        })
      } else {
        steps.push({
          name: `isolated restore database ${isolated.database}`,
          run: async () => {
            const startedDrop = Date.now()
            await isolated.drop()
            // Set on the FAR side of the await, deliberately: this flag is the
            // drill's only witness that the database is gone, so it must fire on
            // completion, never on intent.
            teardown.restoreDropMs = Date.now() - startedDrop
            teardown.restoreDatabaseDropped = true
          },
        })
      }
    }
    steps.push({
      name: 'restored asset directory',
      run: () => rm(restoredAssets, { recursive: true, force: true }),
    })
    // Explicitly `=== object`, not `!== false`: an OMITTED `retention` must not
    // enable a `DROP DATABASE` loop. Destructive-by-default on an absent field
    // is how a future caller deletes databases by forgetting a line.
    //
    // Under `retention` rather than a knob of its own because it answers the
    // same question the bundle and history sweeps answer: does this run own the
    // operator's leftovers? A one-shot run from a checkout does not. Note this
    // gate does NOT protect a database kept with `--keep-target` -- the
    // scheduler always passes `retention`, so it would sweep one six hours later
    // regardless. What protects it is `retain()` renaming it out of the
    // namespace `restoreDatabaseAgeMs` claims.
    if (typeof options.retention === 'object' && options.retention !== null) {
      steps.push({
        name: 'orphaned restore databases',
        run: async () => {
          // Both caps left at their defaults here — five successful drops and
          // `DEFAULT_SWEEP_MAX_FAILURES`. The BOOT sweep halves the drop cap;
          // this one runs per CADENCE, so it needs no reduction.
          teardown.orphans = await dropOrphanedRestoreDatabases(options.databaseUrl, {
            minimumAgeMs: ORPHAN_MINIMUM_AGE_MS,
            // Never our own target: the two steps run concurrently.
            exclude: teardown.restoreDatabase ? [teardown.restoreDatabase] : [],
            // Partial progress has to survive this step being abandoned by its
            // own ceiling. Without it, a sweep that dropped three databases and
            // then blocked would report `null`.
            onProgress: (progress) => { teardown.orphans = progress },
          })
        },
      })
    }
    // This `catch` is not optional. `runTeardownSteps` reports failure by
    // throwing, and a throw from a `finally` escapes `runBackupDrill` -- taking
    // the report, the recorded run and the retention sweep with it. That is the
    // same loss the ceiling exists to prevent, arriving through a different door.
    await runTeardownSteps(steps, {
      stepTimeoutMs: options.teardownStepTimeoutMs ?? TEARDOWN_STEP_TIMEOUT_MS,
      label: 'backup drill teardown',
    }).catch((error: unknown) => {
      teardown.failure = error instanceof Error ? error.message : String(error)
      console.warn(`[backup-drill] ${teardown.failure}`)
    })
    teardown.teardownMs = Date.now() - teardownStartedAt
    publishedTeardown = { ...teardown, orphans: teardown.orphans ? { ...teardown.orphans } : null }
  }

  const recoveredAt = finishedAt ?? new Date()
  const manifestSha256 = createHash('sha256')
    .update(manifest
      ? await readFile(join(resolvedBundle, 'manifest.json')).catch(() => Buffer.alloc(0))
      : Buffer.alloc(0))
    .digest('hex')

  // Derived AFTER the try/finally, from the durable manifest rather than from
  // a variable the happy path sets -- a verdict computed inside the pass it is
  // judging reports on how far that pass got.
  const sourceIntegrity = summariseSourceIntegrity(manifest)

  const report: DrillReport = {
    reportVersion: 1,
    drillId: newDrillId(),
    startedAt: startedAt.toISOString(),
    finishedAt: recoveredAt.toISOString(),
    rtoMs: recoveredAt.getTime() - startedAt.getTime(),
    // Three independent ways to fail, and source integrity is the one that
    // must NOT be able to prevent the bundle from existing. It still fails the
    // drill: fail-open on the copy, fail-closed on the verdict.
    outcome: failure || sourceIntegrity.verdict !== 'clean' ? 'failed' : 'passed',
    applicationRevision: manifest?.applicationRevision ?? null,
    source: {
      database: manifest?.source.database ?? '',
      postgresVersion: manifest?.source.postgresVersion ?? '',
      snapshotAt: manifest?.source.transactionTimestamp ?? '',
    },
    bundle: {
      directory: resolvedBundle,
      written: manifest !== null,
      dumpBytes: manifest?.dump.bytes ?? 0,
      dumpSha256: manifest?.dump.sha256 ?? '',
      manifestSha256,
    },
    verification,
    coldApi,
    retiredWorkspaces: manifest?.retiredWorkspaces ?? [],
    sourceIntegrity,
    // A verdict with no message is a verdict nobody can act on, so a
    // source-integrity failure fills `error` when no exception was thrown.
    error: failure ? failure.message : sourceIntegrity.detail,
  }
  const signed = signDrillReport(report)

  // Both of these are attempted even when the drill failed: a failed drill is
  // the run operations most needs recorded, and "no report" is indistinguishable
  // from "no drill ran".
  if (options.reportPath) {
    await writeReportAtomically(resolve(options.reportPath), `${JSON.stringify(signed, null, 2)}\n`)
      .catch((error) => console.warn('[backup-drill] could not write the report file:', error))
  }

  let history: DrillRetentionResult | null = null
  let bundles: BundleRetentionResult | null = null
  // A connect ceiling is essential here: this pool sits in the post-teardown
  // tail, which no abort signal reaches, and a `connectionTimeoutMillis` of 0
  // (pg-pool's default) means wait forever. A Postgres briefly unreachable at
  // the END of an otherwise successful drill would otherwise hang
  // `recordDrillRun` until the grace expired and the run was abandoned.
  const pool = guardIdleClientErrors(new Pool({
    connectionString: options.databaseUrl,
    max: 1,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  }), 'drill-history')
  try {
    await recordDrillRun(pool, signed)
    // Autoclean AFTER recording, so the run that just happened is one of the
    // rows the budget is measured against rather than a surprise next time.
    if (options.retention !== false) {
      history = await pruneDrillHistory(pool, {
        budgetBytes: options.retention?.historyBudgetBytes,
        minimumRows: options.retention?.historyMinimumRows,
      })
    }
  } catch (error) {
    console.warn('[backup-drill] could not record or prune the drill run:', error)
  } finally {
    await pool.end()
  }

  if (options.retention !== false && options.retention?.bundleRoot) {
    bundles = await pruneBackupBundles(options.retention.bundleRoot, {
      budgetBytes: options.retention.bundleBudgetBytes,
      partialMaxAgeMs: options.retention.partialMaxAgeMs,
    }).catch((error) => {
      console.warn('[backup-drill] could not prune old bundles:', error)
      return null
    })
  }

  return { signed, verification, coldApi, history, bundles, teardown: publishedTeardown ?? teardown, failure }
}

/**
 * Read the source-health verdict out of the manifest.
 *
 * The manifest, not the in-process result: it is the durable witness, it is what
 * a restore will read months from now, and deriving the verdict from anything
 * this run holds in memory would make the check depend on the run having gone
 * well enough to hold it.
 */
export function summariseSourceIntegrity(manifest: BackupManifest | null): SourceIntegrity {
  if (!manifest) {
    return {
      verdict: 'incomplete',
      census: null,
      probeFailures: 0,
      coverage: null,
      detail: 'no manifest was written, so nothing is known about the source',
    }
  }
  const census = manifest.documentCensus ?? null
  const probeFailures = manifest.documentProbeFailures ?? []
  const coverage = manifest.probeCoverage ?? null
  const reasons: string[] = []
  if (!census || census.status !== 'complete') {
    reasons.push('the document census is incomplete')
  }
  const violations = census?.unretiredViolations ?? 0
  if (violations > 0) {
    const names = census?.violationSample ?? []
    reasons.push(
      `${violations} mapped document(s) hold no content chunk and are not retired`
      + (names.length > 0 ? ` (${names.slice(0, 5).join(', ')}${violations > 5 ? ', …' : ''})` : ''),
    )
  }
  if (probeFailures.length > 0) {
    reasons.push(new DocumentProbeError(probeFailures).message)
  }
  // A backup whose probes covered NOTHING while the database holds loadable
  // documents has not been cold-load tested at all (e.g. `--document-probes 0`),
  // so it is a finding, not a silent pass.
  if (coverage && coverage.probed === 0 && (census?.withChunks ?? 0) > 0) {
    reasons.push(
      `no document was cold-load tested while ${census?.withChunks} document(s) hold content`,
    )
  }
  if (reasons.length === 0) {
    return { verdict: 'clean', census, probeFailures: 0, coverage, detail: null }
  }
  return {
    verdict: !census || census.status !== 'complete' ? 'incomplete' : 'violations',
    census,
    probeFailures: probeFailures.length,
    coverage,
    detail: reasons.join('; '),
  }
}

/** The one-line summary both the CLI and the scheduler print. */
export function drillSummary(outcome: BackupDrillOutcome, extra: Record<string, unknown> = {}): string {
  const { signed, verification, coldApi, history, bundles, teardown, failure } = outcome
  return JSON.stringify({
    event: failure ? 'backup.database.drill_failed' : 'backup.database.drill_completed',
    drillId: signed.report.drillId,
    // AFTER the spread, deliberately. RestoreVerification carries its own
    // `outcome: 'passed'` describing the restore alone, and spreading it last
    // would make a failed drill print `"outcome":"passed"`.
    ...verification ?? {},
    outcome: signed.report.outcome,
    restoreOutcome: verification?.outcome ?? null,
    coldApi: coldApi?.outcome ?? null,
    retiredWorkspaces: signed.report.retiredWorkspaces.length,
    sourceSnapshotAt: signed.report.source.snapshotAt,
    bundleDirectory: signed.report.bundle.directory,
    // Separates "the drill failed but a bundle exists" from "no backup at all".
    bundleWritten: signed.report.bundle.written,
    sourceIntegrity: signed.report.sourceIntegrity?.verdict ?? null,
    rtoMs: signed.report.rtoMs,
    reportSha256: signed.reportSha256,
    signed: signed.signature !== null,
    historyBytes: history?.bytesAfter ?? null,
    historyDeleted: history?.deleted ?? null,
    bundleBytes: bundles?.bytesAfter ?? null,
    bundlesDeleted: bundles?.deleted.length ?? null,
    // Bytes the budget does NOT govern, printed beside it rather than folded
    // in. This drill's own partial has been renamed by the time the sweep runs,
    // so a non-zero figure here is somebody else's run in flight — or abandoned
    // partials accumulating.
    partialBundleBytes: bundles?.partialBytes ?? null,
    partialBundles: bundles?.partials.length ?? null,
    // Separate from `bundlesDeleted`: one is the byte budget doing its job, the
    // other is a run that ended without cleaning up after itself. Reporting one
    // number for both would hide the second inside the first.
    partialBundlesDeleted: bundles?.deletedPartials.length ?? null,
    // What the sweep RECLAIMED, which `partialBundleBytes` cannot say — that
    // one counts survivors, so a night that freed 40 GB and a night that freed
    // nothing both print zero there.
    partialBundleBytesReclaimed: bundles?.deletedPartialBytes ?? null,
    // Partials a LIVE ownership claim saved from a delete both age clocks called
    // for, with the claim itself. The retention code keeps such a directory
    // indefinitely on the grounds that an operator seeing the same name held
    // night after night has the pid and host to check — these fields are what
    // make that true.
    //
    // `partialBundles` alone cannot say this: a young in-flight partial and one
    // held forever by a recycled pid both print 1.
    partialBundlesHeld: bundles?.heldPartials.length ?? null,
    partialBundleOwners: bundles?.partials
      .filter((partial) => partial.ownerLiveness !== 'unknown' || partial.owner !== null)
      .map((partial) => ({
        name: partial.name,
        liveness: partial.ownerLiveness,
        host: partial.owner?.host ?? null,
        pid: partial.owner?.pid ?? null,
        kind: partial.owner?.kind ?? null,
        startedAt: partial.owner?.startedAt ?? null,
      })) ?? null,
    error: signed.report.error,
    ...extra,
    // AFTER the spread, deliberately, and for the same reason `outcome` is.
    // These are OBSERVATIONS, and a caller must not pass its INTENTION under one
    // of these names (e.g. `restoreDatabaseDropped: !argv.includes('--keep-target')`).
    // A caller may add fields to this summary; it may not overrule the witness.
    restoreDatabase: teardown.restoreDatabase,
    // `false` WITH a `teardownError` is the ceiling firing -- the server
    // finishes the drop anyway (measured), and the next run's sweep reclaims it
    // if it somehow does not. `false` WITHOUT one means no drop was attempted:
    // either `--keep-target`, or the backup failed before a restore database
    // existed, and `restoreDatabase: null` tells those two apart.
    restoreDatabaseDropped: teardown.restoreDatabaseDropped,
    restoreDropMs: teardown.restoreDropMs,
    teardownMs: teardown.teardownMs,
    orphansDropped: teardown.orphans?.dropped.length ?? null,
    // A sweep that failed on every candidate every night would otherwise print
    // `orphansDropped: 0` and read as "there was nothing to do".
    //
    // `failedCount`, NOT `failed.length`. `failed` is a bounded SAMPLE, and a
    // sample reported as a count under-reports the moment the cap bites
    // (unreachable while `FAILURE_SAMPLE_LIMIT > DEFAULT_SWEEP_MAX_FAILURES`,
    // which `backupRestore.test.ts` asserts).
    //
    // This summary is a log line only: `recordDrillRun` persists
    // `signed.report`, which carries no orphan fields at all.
    orphansFailed: teardown.orphans?.failedCount ?? null,
    orphansRemaining: teardown.orphans?.remaining ?? null,
    orphanSweepCompleted: teardown.orphans?.completed ?? null,
    // `completed: true` covers five operationally opposite outcomes, so the log
    // line that summarises a whole drill should not be the one place the stop
    // reason is missing. `failures` is the cluster-level alarm; `drops` is a
    // healthy converging pass.
    orphanSweepStoppedBy: teardown.orphans?.stoppedBy ?? null,
    teardownError: teardown.failure,
  })
}
