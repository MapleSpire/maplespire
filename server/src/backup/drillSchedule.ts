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

import { DEFAULT_ABORT_GRACE_MS, DEFAULT_DRILL_DEADLINE_MS } from './drillTick.js'

/**
 * The three numbers that decide when a drill runs and how long it may last.
 *
 * Kept out of `drillScheduler` for the same reason as `drillTick`: that module
 * calls `main()` at module scope, so nothing can import it, so anything living
 * there is checked by no test.
 *
 * All three THROW on an unreadable value rather than clamping. An operator who
 * wrote `BACKUP_DRILL_INTERVAL_HOURS=6h` and got a silent 24 believes something
 * about their backups that is not true, and the gauge they would check to find
 * out is the one the misconfiguration breaks.
 */

export type SchedulerEnv = Readonly<Record<string, string | undefined>>

/**
 * Floor under any drill deadline.
 *
 * `BackupDrillRtoDegraded` (`infra/monitoring/alerts.yml`) fires at 15 minutes,
 * the point at which the monitoring considers a drill merely slow enough to
 * ticket. A ceiling at or below that threshold would kill drills the monitoring
 * thinks are still working — and a ceiling that kills a legitimate dump leaves
 * no backup at all, which is worse than the stall it prevents.
 */
export const MINIMUM_DEADLINE_MS = 30 * 60_000

/** Cadence, in milliseconds. */
export function intervalMs(env: SchedulerEnv): number {
  const raw = env.BACKUP_DRILL_INTERVAL_HOURS?.trim()
  const hours = raw ? Number(raw) : 24
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 24 * 30) {
    throw new Error('BACKUP_DRILL_INTERVAL_HOURS must be between 0.25 and 720')
  }
  return Math.round(hours * 3_600_000)
}

/**
 * Wall-clock ceiling on ONE drill.
 *
 * Bounded above by the interval, and that is a real constraint rather than
 * tidiness: the ceiling exists to stop a wedged run from starving every other
 * scheduler, and a ceiling longer than the cadence cannot do that — the next
 * tick arrives first and skips, forever, while the log says only "another
 * scheduler holds the lock". Accepting such a value would ship a number that
 * reads as protection and is none.
 *
 * The default is `min(6h, interval)` rather than a flat 6h so that a deployment
 * running an hourly drill gets a bound that fits its own cadence without
 * anybody having to remember a second variable.
 */
export function deadlineMs(env: SchedulerEnv, interval: number, grace = abortGraceMs(env)): number {
  const budget = interval - grace
  if (budget < MINIMUM_DEADLINE_MS) {
    throw new Error(
      `BACKUP_DRILL_INTERVAL_HOURS (${interval / 3_600_000}h) leaves only ${budget} ms for a drill `
      + `once BACKUP_DRILL_ABORT_GRACE_SECONDS (${grace / 1000}s) is subtracted; `
      + `a deadline under ${MINIMUM_DEADLINE_MS / 60_000} minutes kills legitimate dumps`,
    )
  }
  const raw = env.BACKUP_DRILL_DEADLINE_HOURS?.trim()
  if (!raw) return Math.min(DEFAULT_DRILL_DEADLINE_MS, budget)
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('BACKUP_DRILL_DEADLINE_HOURS must be a positive number of hours')
  }
  const value = Math.round(hours * 3_600_000)
  if (value < MINIMUM_DEADLINE_MS) {
    throw new Error(
      `BACKUP_DRILL_DEADLINE_HOURS (${hours}h) is under the ${MINIMUM_DEADLINE_MS / 60_000}-minute floor; `
      + 'a ceiling that kills a legitimate dump leaves no backup at all, which is worse than the stall',
    )
  }
  // `value + grace`, not `value`: the actual hold is the deadline PLUS the
  // grace, so checking the deadline alone would let `DEADLINE_HOURS=24` on a
  // 24 h cadence hold the key for 24 h 5 min — past the next tick.
  if (value + grace > interval) {
    throw new Error(
      `BACKUP_DRILL_DEADLINE_HOURS (${hours}h) plus the abort grace (${grace / 1000}s) exceeds `
      + `BACKUP_DRILL_INTERVAL_HOURS (${interval / 3_600_000}h); the maximum hold is deadline PLUS `
      + 'grace, and a hold longer than the cadence bounds nothing — the next tick arrives first and '
      + 'skips, forever, saying only that another scheduler holds the lock',
    )
  }
  return value
}

/**
 * How long a drill has to STOP after being aborted, before the process is ended
 * and the key returned by the session dying.
 *
 * Must be positive: the grace is the window in which an aborted drill tears
 * down its own isolated restore database, and abandoning inside it hands the
 * key to a rival mid-teardown.
 */
export function abortGraceMs(env: SchedulerEnv): number {
  const raw = env.BACKUP_DRILL_ABORT_GRACE_SECONDS?.trim()
  if (!raw) return DEFAULT_ABORT_GRACE_MS
  const seconds = Number(raw)
  // Zero is REFUSED here even though `runDrillTick` accepts it: a test passes
  // options directly and may legitimately want to abandon instantly, while an
  // operator who sets this to 0 gets a container that kills itself before
  // `runBackupDrill`'s teardown can drop the isolated restore database.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      'BACKUP_DRILL_ABORT_GRACE_SECONDS must be a positive number of seconds: the grace is the '
      + 'window in which an aborted drill drops its isolated restore database, and abandoning '
      + 'inside it hands the advisory lock to a rival mid-teardown',
    )
  }
  return Math.round(seconds * 1000)
}

/**
 * The longest ONE drill can hold on under this configuration: the deadline plus
 * the grace it is given to unwind afterwards.
 *
 * Exported so no caller recomputes `deadline + grace`: `drillScheduler` prints
 * it at boot, and the boot-time sweep of orphaned restore databases derives its
 * age gate from it — a sweep that runs with no advisory lock is kept away from
 * a rival's live restore database by age and by nothing else.
 *
 * The same sum is what `deadlineMs` above validates against the interval, so
 * this is guaranteed to be at most one cadence.
 */
export function maxDrillHoldMs(
  env: SchedulerEnv,
  interval = intervalMs(env),
  grace = abortGraceMs(env),
): number {
  return deadlineMs(env, interval, grace) + grace
}

/**
 * Sortable, filesystem-safe, UTC: `2026-08-09T02-31-07Z`.
 *
 * Lives here rather than in `drillScheduler.ts` so it can be tested.
 * `retention.ts` parses this format back to age unfinished bundles; a format
 * change on one side alone would make every age unreadable, every partial
 * immortal, and the sweep a no-op reporting success. `retention.test.ts`
 * round-trips the pair.
 *
 * The bundle pruner also ORDERS by this name, so that a copy or a restore
 * rehearsal cannot reorder history the way a rewritten mtime would.
 */
export function bundleName(now: Date): string {
  return `${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}`
}

/**
 * The bundle root.
 *
 * `BACKUP_DIRECTORY` means ONE bundle to the one-shot CLI and the ROOT that
 * holds every bundle to this scheduler. Two meanings behind one name is how an
 * operator following the CLI documentation points a recursive delete at the
 * wrong directory — so `BACKUP_DIRECTORY` without `BACKUP_BUNDLE_ROOT` is
 * refused rather than guessed at.
 */
export function bundleRootFrom(env: SchedulerEnv): string {
  if (env.BACKUP_DIRECTORY && !env.BACKUP_BUNDLE_ROOT) {
    throw new Error(
      'The scheduler reads BACKUP_BUNDLE_ROOT (the directory that HOLDS every bundle), '
      + 'not BACKUP_DIRECTORY (one bundle, used by the one-shot CLI). Set BACKUP_BUNDLE_ROOT.',
    )
  }
  return env.BACKUP_BUNDLE_ROOT ?? '/var/lib/maplespire/backups'
}
