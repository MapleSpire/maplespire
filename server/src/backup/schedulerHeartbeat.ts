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

import type { MetricSample } from '../runtime/metrics.js'

/**
 * What the drill scheduler's loop is doing, and for how long.
 *
 * ## Why this exists beside `up`
 *
 * The scrape gives Prometheus `up{job="backup-drill"}` for free, which catches
 * a dead or crash-looping container. But `up` alone is green through a WEDGE:
 * an `await` on a promise that never settles (e.g. a pool `end()` waiting on a
 * client that is never given back). A live process with a free event loop
 * answers every scrape in a millisecond, `up` stays 1, and the phase age is the
 * only number that moves.
 *
 * Conversely, a long SYNCHRONOUS block delays the scrape response by exactly
 * the block; a long enough one trips `scrape_timeout` and `up` goes to 0 —
 * which this gauge cannot report, because the same block stops it being
 * served. Two failure shapes, one signal each, neither covering the other.
 *
 * ## Why a BUDGET is exported beside the age
 *
 * The tolerable age is different for every phase and every one of them is
 * configuration: `sleeping` may legitimately last `BACKUP_DRILL_INTERVAL_HOURS`,
 * `running` may last the deadline plus the abort grace. A literal threshold in
 * `alerts.yml` would be a copy of four env vars that could silently drift.
 * Exporting the budget as a series makes the rule `age > budget`: cadence-free,
 * and impossible to drift from the deployment that produced it.
 */

/**
 * The loop's states, in the order one process passes through them.
 *
 * `starting` is not padding: the window it covers is `mkdir(bundleRoot)`, which
 * hangs rather than fails when the bundle volume is mounted from a filesystem
 * that has gone away. That is a drill that never runs and never says why.
 */
export type SchedulerPhase = 'starting' | 'boot_sweep' | 'running' | 'sleeping' | 'stopping'

export const SCHEDULER_PHASES: readonly SchedulerPhase[] = [
  'starting', 'boot_sweep', 'running', 'sleeping', 'stopping',
]

/**
 * Headroom added to every phase budget.
 *
 * Not tuning. A phase ends and the next one begins in the same turn, so a
 * healthy age reaches its budget and stops — there is no overshoot to absorb
 * except a scrape landing exactly on the boundary. Five minutes is ten scrape
 * intervals, and the rule's own `for:` window is what actually keeps a single
 * unlucky sample from firing anything.
 */
export const PHASE_BUDGET_SLACK_MS = 5 * 60_000

export type PhaseBudgets = Readonly<Record<SchedulerPhase, number>>

/**
 * Every budget derived from a number the scheduler already prints at boot.
 *
 * No literal thresholds: each one is the longest the phase can legitimately
 * last under THIS deployment's configuration, so raising
 * `BACKUP_DRILL_INTERVAL_HOURS` cannot leave a stale threshold behind.
 */
export function schedulerPhaseBudgets(input: {
  /** `BOOT_SWEEP_CEILING_MS` — the sweep bounds itself and this is that bound. */
  readonly bootSweepCeilingMs: number
  /** Per-tick deadline; past it the tick aborts. */
  readonly deadlineMs: number
  /** How long an aborting tick is given to unwind before the process ends. */
  readonly abortGraceMs: number
  /** The cadence. A sleep is `max(60s, interval - elapsed)`, so never longer. */
  readonly intervalMs: number
}): PhaseBudgets {
  const slack = PHASE_BUDGET_SLACK_MS
  return {
    // Only `mkdir` and env parsing happen here; anything else is a hang.
    starting: 60_000 + slack,
    boot_sweep: input.bootSweepCeilingMs + slack,
    // Exceeding this means the abandonment machinery ITSELF failed: past
    // deadline + grace the tick is contractually required to have ended the
    // process. Typically this pages ~6 h before `BackupDrillStale` would.
    running: input.deadlineMs + input.abortGraceMs + slack,
    sleeping: input.intervalMs + slack,
    // The stop path aborts the tick and waits out the same grace.
    //
    // This one is a HUMAN gauge, not an alert threshold: `stop_grace_period`
    // is 420 s, so Docker SIGKILLs the container before this budget plus the
    // wedge rule's window could elapse. A teardown that hangs surfaces as the
    // SIGKILL and then as `BackupDrillRestarting`.
    stopping: input.abortGraceMs + slack,
  }
}

export type SchedulerHeartbeat = {
  /** Move to `phase`, restarting its clock. */
  enter(phase: SchedulerPhase): void
  /** The current phase, for logging and for tests. */
  phase(): SchedulerPhase
  /** Sampled at scrape time, never pushed on a timer. */
  samples(): MetricSample[]
}

/**
 * The unix time the PROCESS started — not an uptime, and the difference decides
 * whether a crash loop can be detected at all.
 *
 * An uptime gauge with `< 600` behind a `for: 30m` window cannot fire on a
 * crash loop. Prometheus marks every series of a target stale on a FAILED
 * scrape, so an empty vector ends the pending period and restarts the clock —
 * and a container under `restart: always` is down across at least one 30 s
 * scrape per cycle, because Docker's restart delay doubles up to a minute.
 *
 * `changes(...[30m])` is computed from the samples actually present in the
 * range and is immune to gaps, which is why the standard client libraries all
 * export `process_start_time_seconds` and the standard crash-loop rule is
 * `changes(process_start_time_seconds[30m]) > 2`. This is that metric under
 * the house prefix, so `monitoring.test.mjs` can see it.
 *
 * Uptime is still available to a dashboard as `time() - <this>`.
 */
export const SCHEDULER_START_TIME_METRIC = 'maplespire_backup_drill_scheduler_start_time_seconds'
export const SCHEDULER_PHASE_AGE_METRIC = 'maplespire_backup_drill_scheduler_phase_age_seconds'
export const SCHEDULER_PHASE_BUDGET_METRIC = 'maplespire_backup_drill_scheduler_phase_budget_seconds'

export function createSchedulerHeartbeat(
  budgets: PhaseBudgets,
  now: () => number = Date.now,
  /**
   * Unix SECONDS at which this process started, defaulting to the real source.
   *
   * Not `now()` at construction: `createSchedulerHeartbeat` is called well
   * inside `main()`, after env parsing, so a constructed-at stamp would omit
   * everything before it. `process.uptime()` is exact wherever the call sits.
   */
  processStartedAtSeconds: number = Date.now() / 1000 - process.uptime(),
): SchedulerHeartbeat {
  let phase: SchedulerPhase = 'starting'
  let enteredAt = now()

  return {
    enter(next) {
      phase = next
      enteredAt = now()
    },
    phase: () => phase,
    samples() {
      // ONE clock reading for the whole render, so the samples cannot disagree
      // about when "now" was.
      const at = now()
      return [
        {
          name: SCHEDULER_START_TIME_METRIC,
          help: 'Unix time at which the backup drill scheduler process started; constant while it lives and different after every restart, so changes() over a range counts restarts. Alert with changes(...[30m]) > 2, never with a threshold behind a for: window — a failed scrape marks the series stale and restarts that window, which is exactly what a crash loop produces.',
          type: 'gauge',
          values: [{ value: processStartedAtSeconds }],
        },
        {
          // Only the CURRENT phase is emitted. Emitting all five with zeros for
          // the inactive ones would make `age > budget` match five pairs and
          // report four healthy zeros beside the one that matters; Prometheus
          // marks the absent series stale on the next scrape, so nothing lingers.
          name: SCHEDULER_PHASE_AGE_METRIC,
          help: 'Seconds the scheduler loop has spent in its current phase. A loop wedged on an await that never settles keeps answering scrapes, so this is the only series that moves; compare it against the budget series of the same phase.',
          type: 'gauge',
          values: [{ labels: { phase }, value: (at - enteredAt) / 1000 }],
        },
        {
          name: SCHEDULER_PHASE_BUDGET_METRIC,
          help: 'The longest this phase can legitimately last under the running configuration, derived from BACKUP_DRILL_INTERVAL_HOURS, _DEADLINE_HOURS and _ABORT_GRACE_SECONDS rather than written as a threshold in the alert rule.',
          type: 'gauge',
          values: [{ labels: { phase }, value: budgets[phase] / 1000 }],
        },
      ]
    },
  }
}

/** The port the drill serves `/metrics` on. */
export const DEFAULT_DRILL_METRICS_PORT = 9464

/**
 * Chosen to sit BELOW the ephemeral range (Linux defaults to 32768-60999),
 * because this container allocates ephemeral ports to itself: `startColdServer`
 * boots the deployed API against the restored database on a port the OS hands
 * out, one per drill. A fixed listener inside that range would be a collision
 * that only ever happens under load, on the run whose evidence matters most.
 *
 * An unparseable or out-of-range value falls back rather than throwing, and
 * says so. This is an observability knob, and observability may never prevent
 * a drill.
 */
export function drillMetricsPort(
  env: NodeJS.ProcessEnv,
  log: (event: string, fields?: Record<string, unknown>) => void = () => {},
): number {
  const raw = env.BACKUP_DRILL_METRICS_PORT
  if (raw === undefined || raw === '') return DEFAULT_DRILL_METRICS_PORT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    log('backup.drill_metrics_port_invalid', {
      detail: 'BACKUP_DRILL_METRICS_PORT is not a port number; using the default',
      value: raw,
      using: DEFAULT_DRILL_METRICS_PORT,
    })
    return DEFAULT_DRILL_METRICS_PORT
  }
  return parsed
}
