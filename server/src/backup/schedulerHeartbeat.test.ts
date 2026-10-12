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

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DRILL_METRICS_PORT,
  SCHEDULER_PHASES,
  SCHEDULER_PHASE_AGE_METRIC,
  SCHEDULER_PHASE_BUDGET_METRIC,
  SCHEDULER_START_TIME_METRIC,
  createSchedulerHeartbeat,
  drillMetricsPort,
  schedulerPhaseBudgets,
} from './schedulerHeartbeat.js'

/**
 * The budgets are asserted against LITERALS throughout.
 *
 * A test that derives its bound from the constant under test agrees with any
 * value that constant is given. Writing
 * `deadlineMs + abortGraceMs + PHASE_BUDGET_SLACK_MS` here would restate the
 * implementation and pass for any slack, including zero — which would put the
 * alert threshold exactly on the boundary a healthy sleep reaches.
 */
const HOUR = 3_600_000

/** Deliberately DISTINCT so no two budgets can coincide by accident. */
const BUDGET_INPUT = {
  bootSweepCeilingMs: 90_000,
  deadlineMs: 6 * HOUR,
  abortGraceMs: 300_000,
  intervalMs: 24 * HOUR,
} as const

describe('the phase budgets, derived from the deployment and never written down', () => {
  it('gives each phase the longest it can legitimately last, plus one slack', () => {
    // Every number here is a literal. 90 000 + 300 000, 21 600 000 + 300 000 +
    // 300 000, and so on — computed once, by hand, on purpose.
    expect(schedulerPhaseBudgets(BUDGET_INPUT)).toEqual({
      starting: 360_000,
      boot_sweep: 390_000,
      running: 22_200_000,
      sleeping: 86_700_000,
      stopping: 600_000,
    })
  })

  it('covers every phase in the union', () => {
    // A phase with no budget would render `undefined / 1000` — NaN — and every
    // comparison against NaN is false, so `age > budget` would be silent for
    // exactly that state. `SCHEDULER_PHASES` is the list `monitoring.test.mjs`
    // parses to check the scheduler enters them all; this is the other half.
    const budgets = schedulerPhaseBudgets(BUDGET_INPUT)
    for (const phase of SCHEDULER_PHASES) {
      expect(Number.isFinite(budgets[phase])).toBe(true)
      expect(budgets[phase]).toBeGreaterThan(0)
    }
    expect(Object.keys(budgets).sort()).toEqual([...SCHEDULER_PHASES].sort())
  })

  it('no two phases share a budget for these inputs, so a swap cannot hide', () => {
    // The guard on the assertion above. With the real `BOOT_SWEEP_CEILING_MS`
    // of 60 000 the `starting` and `boot_sweep` budgets are equal, and swapping
    // the two keys would go unnoticed in a test written with it.
    const budgets = Object.values(schedulerPhaseBudgets(BUDGET_INPUT))
    expect(new Set(budgets).size).toBe(budgets.length)
  })

  it('tracks the cadence rather than pinning a threshold', () => {
    // The whole reason the budget is a SERIES: raise the interval and the
    // tolerance follows it, with nothing in alerts.yml to revisit.
    const daily = schedulerPhaseBudgets(BUDGET_INPUT)
    const weekly = schedulerPhaseBudgets({ ...BUDGET_INPUT, intervalMs: 7 * 24 * HOUR })
    expect(daily.sleeping).toBe(86_700_000)
    expect(weekly.sleeping).toBe(605_100_000)
    // ...and only the sleep budget moves.
    expect(weekly.running).toBe(daily.running)
  })

  it('follows the deadline and the grace independently', () => {
    expect(schedulerPhaseBudgets({ ...BUDGET_INPUT, deadlineMs: 2 * HOUR }).running)
      .toBe(7_800_000)
    expect(schedulerPhaseBudgets({ ...BUDGET_INPUT, abortGraceMs: 60_000 }).running)
      .toBe(21_960_000)
    expect(schedulerPhaseBudgets({ ...BUDGET_INPUT, abortGraceMs: 60_000 }).stopping)
      .toBe(360_000)
  })
})

describe('the heartbeat', () => {
  function fixture() {
    let now = 1_000_000
    const clock = () => now
    const advance = (ms: number) => { now += ms }
    return { advance, heartbeat: createSchedulerHeartbeat(schedulerPhaseBudgets(BUDGET_INPUT), clock) }
  }

  it('starts in `starting`, which is the window `mkdir` on a dead volume hangs in', () => {
    const { heartbeat } = fixture()
    expect(heartbeat.phase()).toBe('starting')
  })

  it('reports an age that climbs while the loop is wedged', () => {
    // The premise of the whole module: a loop stuck on an await keeps
    // answering scrapes, so this is the only number that moves.
    const { advance, heartbeat } = fixture()
    heartbeat.enter('running')
    advance(90_000)
    const age = heartbeat.samples().find((m) => m.name === SCHEDULER_PHASE_AGE_METRIC)
    expect(age?.values).toEqual([{ labels: { phase: 'running' }, value: 90 }])
  })

  it('restarts the age on every transition', () => {
    const { advance, heartbeat } = fixture()
    heartbeat.enter('running')
    advance(600_000)
    heartbeat.enter('sleeping')
    advance(30_000)
    const age = heartbeat.samples().find((m) => m.name === SCHEDULER_PHASE_AGE_METRIC)
    expect(age?.values).toEqual([{ labels: { phase: 'sleeping' }, value: 30 }])
  })

  it('emits ONLY the current phase, so `age > budget` matches exactly one pair', () => {
    // Emitting all five with zeros for the inactive ones would make the rule
    // compare four healthy pairs beside the one that matters, and a reader of
    // the firing alert could not tell which phase it came from.
    const { heartbeat } = fixture()
    heartbeat.enter('sleeping')
    const samples = heartbeat.samples()
    for (const name of [SCHEDULER_PHASE_AGE_METRIC, SCHEDULER_PHASE_BUDGET_METRIC]) {
      const metric = samples.find((m) => m.name === name)
      expect(metric?.values).toHaveLength(1)
      expect(metric?.values[0]?.labels).toEqual({ phase: 'sleeping' })
    }
  })

  it('labels the budget with the same phase as the age', () => {
    // Prometheus matches binary operators on the full label set. Different
    // `phase` values on the two series makes `age > budget` match nothing at
    // all — a rule that is present, valid, and permanently inactive.
    const { heartbeat } = fixture()
    heartbeat.enter('boot_sweep')
    const samples = heartbeat.samples()
    const age = samples.find((m) => m.name === SCHEDULER_PHASE_AGE_METRIC)
    const budget = samples.find((m) => m.name === SCHEDULER_PHASE_BUDGET_METRIC)
    expect(age?.values[0]?.labels).toEqual(budget?.values[0]?.labels)
    expect(budget?.values[0]?.value).toBe(390)
  })

  it('carries the budget of the phase it is IN, not of the one it started in', () => {
    const { heartbeat } = fixture()
    const budgetOf = (phase: 'starting' | 'running' | 'sleeping') => {
      heartbeat.enter(phase)
      return heartbeat.samples().find((m) => m.name === SCHEDULER_PHASE_BUDGET_METRIC)?.values[0]?.value
    }
    expect(budgetOf('starting')).toBe(360)
    expect(budgetOf('running')).toBe(22_200)
    expect(budgetOf('sleeping')).toBe(86_700)
  })

  it('reports a start time that does NOT move while the process lives', () => {
    // The crash-loop signal, and the property `changes(...[30m])` counts. A
    // gauge that drifted — an uptime, or a stamp taken from the render clock —
    // would make every scrape a "change" and the rule fire continuously.
    const { advance, heartbeat } = fixture()
    const startTime = () =>
      heartbeat.samples().find((m) => m.name === SCHEDULER_START_TIME_METRIC)?.values[0]?.value

    const first = startTime()
    advance(120_000)
    heartbeat.enter('running')
    advance(3_600_000)
    heartbeat.enter('sleeping')

    expect(startTime()).toBe(first)
    // ...while the phase age underneath it does move.
    expect(heartbeat.samples().find((m) => m.name === SCHEDULER_PHASE_AGE_METRIC)?.values[0]?.value)
      .toBe(0)
  })

  it('takes the start time from the PROCESS, not from its own construction', () => {
    // `createSchedulerHeartbeat` is called well inside `main()`, after env
    // parsing — so a constructed-at stamp omits everything before it. Two
    // heartbeats built at different moments of ONE process must agree, or `changes()` counts
    // constructions instead of restarts.
    const early = createSchedulerHeartbeat(schedulerPhaseBudgets(BUDGET_INPUT), () => 1_000, 1_700_000_000)
    const late = createSchedulerHeartbeat(schedulerPhaseBudgets(BUDGET_INPUT), () => 9_999_999, 1_700_000_000)
    const startTime = (hb: ReturnType<typeof createSchedulerHeartbeat>) =>
      hb.samples().find((m) => m.name === SCHEDULER_START_TIME_METRIC)?.values[0]?.value
    expect(startTime(early)).toBe(1_700_000_000)
    expect(startTime(late)).toBe(1_700_000_000)
  })

  it('defaults the start time to the real process start, in SECONDS', () => {
    // The default has to resolve to the real source: the single call site is
    // inside a function no test boots.
    const before = Date.now() / 1000 - process.uptime()
    const heartbeat = createSchedulerHeartbeat(schedulerPhaseBudgets(BUDGET_INPUT))
    const value = heartbeat.samples()
      .find((m) => m.name === SCHEDULER_START_TIME_METRIC)?.values[0]?.value ?? 0

    // Seconds, not milliseconds: a ms value would be ~1e12 and every duration
    // computed against `time()` would be nonsense while still looking like data.
    expect(value).toBeGreaterThan(1_600_000_000)
    expect(value).toBeLessThan(4_000_000_000)

    // A tolerance check alone (`Math.abs(value - before) < 2`) would also pass
    // for `Date.now() / 1000`, because the test process's uptime here is under
    // two seconds. The DIRECTIONAL check does not: the process started at
    // least `process.uptime()` ago, and a constructed-at stamp cannot be that
    // old.
    expect(Date.now() / 1000 - value).toBeGreaterThanOrEqual(process.uptime() - 0.05)
    expect(Math.abs(value - before)).toBeLessThan(2)
    expect(value).toBeLessThanOrEqual(Date.now() / 1000)
  })

  it('reads the clock ONCE per render', () => {
    // Otherwise the samples of one render could disagree about when "now" was.
    const clock = vi.fn(() => 5_000)
    const heartbeat = createSchedulerHeartbeat(schedulerPhaseBudgets(BUDGET_INPUT), clock)
    clock.mockClear()
    heartbeat.samples()
    expect(clock).toHaveBeenCalledTimes(1)
  })

  it('names its metrics with the exported constants', () => {
    // The alert rules select on these names; a rename that misses one leaves a
    // rule present, valid and inactive forever. `monitoring.test.mjs` compares
    // alerts.yml against the source, and this is the half that pins the source
    // against the module's own contract.
    const { heartbeat } = fixture()
    expect(heartbeat.samples().map((m) => m.name)).toEqual([
      'maplespire_backup_drill_scheduler_start_time_seconds',
      'maplespire_backup_drill_scheduler_phase_age_seconds',
      'maplespire_backup_drill_scheduler_phase_budget_seconds',
    ])
  })

  it('declares every sample a gauge and gives it help text', () => {
    const { heartbeat } = fixture()
    for (const sample of heartbeat.samples()) {
      expect(sample.type).toBe('gauge')
      expect(sample.help.length).toBeGreaterThan(40)
    }
  })
})

describe('the metrics port', () => {
  it('defaults below the ephemeral range the drill allocates from', () => {
    // `startColdServer` takes an OS-assigned port per drill. A fixed listener
    // inside 32768-60999 would be a collision that only happens under load.
    expect(DEFAULT_DRILL_METRICS_PORT).toBe(9464)
    expect(DEFAULT_DRILL_METRICS_PORT).toBeLessThan(32_768)
    expect(drillMetricsPort({})).toBe(9464)
    expect(drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: '' })).toBe(9464)
  })

  it('takes a configured port', () => {
    expect(drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: '9999' })).toBe(9999)
    expect(drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: '1' })).toBe(1)
    expect(drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: '65535' })).toBe(65_535)
  })

  it('falls back LOUDLY rather than throwing on a typo', () => {
    // Nothing observational may prevent a drill, including a typo in an env
    // var.
    for (const value of ['nine', '0', '65536', '-1', '9464.5', 'NaN', ' ']) {
      const log = vi.fn()
      expect(drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: value }, log)).toBe(9464)
      expect(log).toHaveBeenCalledWith('backup.drill_metrics_port_invalid', expect.objectContaining({
        value,
        using: 9464,
      }))
    }
  })

  it('says nothing when the value is good', () => {
    const log = vi.fn()
    drillMetricsPort({ BACKUP_DRILL_METRICS_PORT: '9464' }, log)
    drillMetricsPort({}, log)
    expect(log).not.toHaveBeenCalled()
  })
})
