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

import { appendFile } from 'node:fs/promises'
import type { WorkspaceKey } from './projector.js'
import type { UnyieldingPhase } from './modelEpochForwarder.js'

/**
 * The decisions the server entry point makes around the event-driven forward
 * (G4-16f), kept out of `index.ts`
 * so each is tested.
 */

/** THE EVENT-DRIVEN PASS's sweep options: a
 * short budget, and FORWARD ONLY — retirement decodes storage and is the
 * periodic sweep's business. Spread by `index.ts` into its triggered sweep. */
export const TRIGGERED_SWEEP = { budgetMs: 10_000, forwardOnly: true } as const

/** A latch's pass waits this long for the pool-heavy slot as
 * a WAITER (inside the route's 1.5 s wait, the tab's 2 s latch)… */
export const LATCH_EXCLUSION_WAIT_MS = 1_000
/** …S9's as long as the periodic sweep (it is the roll's own forward)… */
export const RESET_EXCLUSION_WAIT_MS = 30_000
/** …and an urgent pass is not preempted by a waiter before this. */
export const URGENT_YIELD_GRACE_MS = 2_000

/**
 * The triggered sweep's options for a pass of this urgency.
 * An ORDINARY pass only TRIES the pool-heavy slot and yields to any waiter
 * at once. An URGENT one (a latch, S9) waits for the slot as a WAITER — so
 * the periodic sweep and the meta-only job, waiters themselves, yield to it
 * at their next safe point instead of starving it for the whole 10-minute
 * loop — and is not preempted before {@link URGENT_YIELD_GRACE_MS}: the
 * loop's next waiter would otherwise preempt it before its first source.
 */
export function triggeredSweepOptions(urgency: { priority?: boolean; reset?: boolean } = {}): {
  budgetMs: number; forwardOnly: true; exclusionWaitMs?: number; yieldGraceMs?: number; maintenance?: false
} {
  if (urgency.reset) return { ...TRIGGERED_SWEEP, exclusionWaitMs: RESET_EXCLUSION_WAIT_MS, yieldGraceMs: URGENT_YIELD_GRACE_MS }
  // D2: a pass a REQUEST asked for (a latch's or an ordinary one) forwards,
  // and does nothing else — the dedupe sweep and the text mirror are the
  // periodic sweep's, S9's and compaction's (`ForwarderDeps.maintenance`).
  if (urgency.priority) return { ...TRIGGERED_SWEEP, exclusionWaitMs: LATCH_EXCLUSION_WAIT_MS, yieldGraceMs: URGENT_YIELD_GRACE_MS, maintenance: false }
  return { ...TRIGGERED_SWEEP, maintenance: false }
}

/**
 * A refused overlay rotation (or fold) of a workspace: the event-driven pass
 * YIELDS for a while so the rotation's retry finds its keys free — but only
 * when THAT pass held them: one of the workspace's triggered passes HOLDS the
 * pool-heavy slot (the keys are taken only under it; a latch still WAITING for
 * the slot behind a compaction holds nothing). Refused by a compaction (F1
 * holds the keys up to 4.8 s), yielding would only delay the forward after it.
 * True when it yielded.
 */
export function yieldToRefusedRotation(
  trigger: { holding(key: WorkspaceKey): boolean; yieldFor(key: WorkspaceKey, ms: number): void } | null,
  detail: { landscapeId: string; versionId: string },
  ms: number,
): boolean {
  const key = { landscapeId: detail.landscapeId, versionId: detail.versionId }
  if (!trigger || !trigger.holding(key)) return false
  trigger.yieldFor(key, ms)
  return true
}

/**
 * THE POOL-HEAVY HOLDS THAT DO NOT YIELD. `ProcessExclusion.hold()` is true
 * whoever holds the slot, but only a COMPACTION (F1 holds it up to ~4.8 s) and
 * the META-ONLY epoch job (a roll) keep it until they end. The periodic sweep,
 * a waiter itself, yields to any waiter at its next safe point — a latch's
 * pass, waiting 1 s, is served behind it. So `latchReady` (the route's
 * `forwardBusy`) asks THIS, not `hold()`: a periodic sweep holding the slot no
 * longer sends every draining tab of the process through a 20 s busy drain.
 *
 * Each such pass runs through {@link UnyieldingHolds.run} /
 * {@link UnyieldingHolds.runWithin}: it is counted from the moment it QUEUES
 * for the slot until it releases
 * it. `ProcessExclusion` serves its waiters in order and the periodic sweep
 * yields to the FIRST one: a compaction queued behind the sweep before a
 * latch's pass gets the slot before it and keeps it up to ~4.8 s, so the
 * latch's 1 s wait would be refused — the latch is "not ready" then too.
 *
 * {@link UnyieldingHolds.during} marks a PHASE without a safe point of a pass
 * that already holds the slot (the periodic sweep's retirement and purge, the
 * forwarder's text mirror): a latch's waiter is not served before it ends
 * either.
 */
export interface UnyieldingHolds {
  run<T>(work: () => Promise<T>): Promise<T>
  runWithin<T>(work: () => Promise<T>, maxWaitMs: number): Promise<{ ran: true; value: T } | { ran: false }>
  /** Mark `phase` of a pass that holds the slot already. */
  during<T>(phase: () => Promise<T>): Promise<T>
  /** True while a pass run through this holds the slot OR waits for it, or
   * while a marked phase runs. */
  held(): boolean
  /** True ONLY while a pass run
   * through this (`run`, `runWithin`) HOLDS the slot — not queued for it, not
   * a marked phase: the original meaning of `held()`, what the compaction re-attach reads
   * to lift its mark (`slotHeld`). The latch's readiness keeps `held()`. */
  holding(): boolean
  /** True while a pass run through this WAITS for the slot: whoever holds the slot, that waiter is served
   * before a latch asking after it. */
  queued(): boolean
}

export function createUnyieldingHolds(exclusion: {
  run<T>(work: () => Promise<T>): Promise<T>
  runWithin<T>(work: () => Promise<T>, maxWaitMs: number): Promise<{ ran: true; value: T } | { ran: false }>
}): UnyieldingHolds {
  /** Passes run through this that hold the slot. */
  let holding = 0
  /** Marked phases (`during`). */
  let phases = 0
  let queued = 0
  /** Counted as queued now; moved to holding once the slot is held; the
   * queue count given back whatever happens (refused, thrown). */
  const through = <R, T>(enter: (work: () => Promise<T>) => Promise<R>, work: () => Promise<T>): Promise<R> => {
    queued += 1
    let waiting = true
    const leaveQueue = () => { if (waiting) { waiting = false; queued -= 1 } }
    const marked = async (): Promise<T> => {
      leaveQueue()
      holding += 1
      try { return await work() } finally { holding -= 1 }
    }
    let entered: Promise<R>
    try {
      entered = enter(marked)
    } catch (error) {
      leaveQueue()
      throw error
    }
    return entered.finally(leaveQueue)
  }
  return {
    run: (work) => through((marked) => exclusion.run(marked), work),
    runWithin: (work, maxWaitMs) => through((marked) => exclusion.runWithin(marked, maxWaitMs), work),
    async during(phase) {
      phases += 1
      try { return await phase() } finally { phases -= 1 }
    },
    held: () => holding > 0 || phases > 0 || queued > 0,
    holding: () => holding > 0,
    queued: () => queued > 0,
  }
}

/**
 * THE MAINTENANCE A REQUESTED PASS LEFT. A requested pass forwards only;
 * the dedupe sweep it skipped compensates a duplicated forward only while
 * neither copy was edited since. Left
 * to the periodic sweep (10 min, more when it yields), a duplicate lives long
 * enough to be edited, and is then KEPT for good (`duplicate_kept`, an
 * operator alert). So a requested pass that FORWARDED schedules one
 * ordinary pass WITH the maintenance {@link MAINTENANCE_FOLLOW_UP_MS} later —
 * outside any latch, trying the slot like any ordinary pass
 * ({@link maintenanceFollowUpSweepOptions}). One per workspace at a time; a
 * pass whose MAINTENANCE did not run to its end ({@link maintenanceRanToEnd}:
 * refused the slot, preempted or out of budget before or after it forwarded,
 * a rotation or `model-epoch:` key taken, a run that failed) is retried after
 * the same delay, at most {@link MAINTENANCE_FOLLOW_UP_ATTEMPTS} times, then
 * left to the periodic sweep (retrying only a pass "refused" the slot would
 * stop the follow-up in the likeliest cases after a hop — latches arriving,
 * rotations). A requested pass that forwards WHILE a
 * follow-up runs gets one more after it. A run that never settles frees its
 * workspace after {@link MAINTENANCE_FOLLOW_UP_RUN_TIMEOUT_MS}.
 */
export const MAINTENANCE_FOLLOW_UP_MS = 30_000
export const MAINTENANCE_FOLLOW_UP_ATTEMPTS = 3
export const MAINTENANCE_FOLLOW_UP_RUN_TIMEOUT_MS = 5 * 60_000

/** Whether a pass ran the maintenance to its END: swept, its forwarder ran
 * (not a contended key) and did not yield before the dedupe and the mirror
 * were done. */
export function maintenanceRanToEnd(result: unknown): boolean {
  const outcome = result as { outcome?: string; forwarded?: { outcome?: string; yielded?: string } }
  return outcome?.outcome === 'swept' && outcome.forwarded?.outcome === 'ran' && !outcome.forwarded.yielded
}

/** The follow-up's sweep options: the triggered pass's, WITH the maintenance. */
export function maintenanceFollowUpSweepOptions(): { budgetMs: number; forwardOnly: true } {
  return { ...TRIGGERED_SWEEP }
}

/** Whether a pass forwarded at least one source (a write landed in the current epoch). */
export function forwardPassForwarded(result: unknown): boolean {
  const outcome = result as { outcome?: string; forwarded?: { outcome?: string; sources?: Array<{ outcome?: string }> } }
  return outcome?.outcome === 'swept' && outcome.forwarded?.outcome === 'ran'
    && (outcome.forwarded.sources ?? []).some((s) => s.outcome === 'forwarded')
}

export interface MaintenanceFollowUp {
  /** A REQUESTED pass's outcome (not S9's: S9 keeps the maintenance). */
  noteRequested(key: WorkspaceKey, outcome: unknown): void
  pending(key: WorkspaceKey): boolean
  stop(): void
}

export function createMaintenanceFollowUp(options: {
  run: (key: WorkspaceKey) => Promise<unknown>
  delayMs?: number
  attempts?: number
  runTimeoutMs?: number
  log?: (event: Record<string, unknown>) => void
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}): MaintenanceFollowUp {
  const delay = options.delayMs ?? MAINTENANCE_FOLLOW_UP_MS
  const attempts = options.attempts ?? MAINTENANCE_FOLLOW_UP_ATTEMPTS
  const runTimeout = options.runTimeoutMs ?? MAINTENANCE_FOLLOW_UP_RUN_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  })
  /** A workspace's follow-up: armed (a timer) or running (`running`). */
  const slots = new Map<string, { cancel(): void; again: boolean; running: boolean }>()
  let stopped = false
  const id = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  const log = (key: WorkspaceKey, event: string, extra: Record<string, unknown> = {}) =>
    options.log?.({ event, landscapeId: key.landscapeId, versionId: key.versionId, ...extra })
  const schedule = (key: WorkspaceKey, attempt: number) => {
    const k = id(key)
    const slot = { cancel: () => undefined as void, again: false, running: false }
    let settled = false
    const settle = (ranToEnd: boolean) => {
      if (settled) return
      settled = true
      if (slots.get(k) === slot) slots.delete(k)
      if (stopped) return
      // A requested pass forwarded while this one ran — a fresh series.
      if (slot.again) schedule(key, 1)
      else if (!ranToEnd && attempt < attempts) schedule(key, attempt + 1)
    }
    let guard: { cancel(): void } | null = null
    const timer = setTimer(() => {
      slot.running = true
      guard = setTimer(() => {
        log(key, 'model_epoch.forward.maintenance_follow_up_stuck', { runTimeoutMs: runTimeout })
        settle(false)
      }, runTimeout)
      void options.run(key).then((outcome) => {
        guard?.cancel()
        settle(maintenanceRanToEnd(outcome))
      }, (error) => {
        guard?.cancel()
        log(key, 'model_epoch.forward.maintenance_follow_up_failed', { error: error instanceof Error ? error.message : String(error) })
        settle(false)
      })
    }, delay)
    // A RUNNING follow-up's 5 min guard
    // is cancelled at stop too (a long shutdown logged a false "stuck").
    slot.cancel = () => { timer.cancel(); guard?.cancel() }
    slots.set(k, slot)
  }
  return {
    noteRequested(key, outcome) {
      if (stopped || !forwardPassForwarded(outcome)) return
      const slot = slots.get(id(key))
      // Armed: the same follow-up covers it. Running: it may have passed the
      // dedupe already — one more after it.
      if (slot) { if (slot.running) slot.again = true; return }
      schedule(key, 1)
    },
    pending: (key) => slots.has(id(key)),
    stop() {
      stopped = true
      for (const slot of slots.values()) slot.cancel()
      slots.clear()
    },
  }
}

/** What the wiring adds to `sweepModelEpochs`'s deps per kind of pass. */
export interface EpochPassSweepOptions<E = unknown> {
  exclusion: E
  unyielding: <T>(phase: () => Promise<T>, name?: UnyieldingPhase) => Promise<T>
  budgetMs?: number
  forwardOnly?: true
  maintenance?: false
  exclusionWaitMs?: number
  yieldGraceMs?: number
  onAcquired?: () => void
}

/**
 * THE EPOCH PASSES' WIRING: what `index.ts` used to compose inline, and
 * tested there only on its source text (which let a mutation of each point
 * below survive). `index.ts` gives the sweeps bound to
 * its dependencies and the process's exclusion; this decides:
 *  - every pass runs under the process's pool-heavy exclusion, the
 *    maintenance follow-up included (outside it, beside a compaction,
 *    the pool is exhausted — `processExclusion.ts`);
 *  - the compaction and the meta-only job run through the ONE
 *    {@link UnyieldingHolds}, which `slotHeld` (the route's `forwardBusy`)
 *    asks; each pass's phases without a safe point are marked through it;
 *  - a REQUESTED pass (not S9) is noted for the follow-up;
 *  - the follow-up is stopped at shutdown (pushed to `stops`);
 *  - every periodic sweep is noted by ONE yield watch for the process's
 *    life (a watch per tick never reaches its streak).
 */
export function wireEpochForwardPasses<E extends {
  run<T>(work: () => Promise<T>): Promise<T>
  runWithin<T>(work: () => Promise<T>, maxWaitMs: number): Promise<{ ran: true; value: T } | { ran: false }>
}>(deps: {
  exclusion: E
  /** `sweepModelEpochs` bound to the event-driven pass's deps. */
  triggeredSweep: (key: WorkspaceKey, options: EpochPassSweepOptions<E>) => Promise<unknown>
  /** `sweepModelEpochs` bound to the follow-up's and the periodic loop's. */
  sweep: (key: WorkspaceKey, options: EpochPassSweepOptions<E>) => Promise<unknown>
  isShuttingDown: () => boolean
  log: (event: Record<string, unknown>) => void
  /** The process's shutdown list (`maintenanceScheduleStops`). */
  stops: Array<() => void>
  /** The periodic sweep's wait for the slot, as a waiter. */
  periodicWaitMs: number
  followUp?: { delayMs?: number; attempts?: number; runTimeoutMs?: number; setTimer?: (fn: () => void, ms: number) => { cancel(): void } }
}): {
  holds: UnyieldingHolds
  slotHeld: () => boolean
  slotQueued: () => boolean
  runRequestedOrS9: (key: WorkspaceKey, urgency: { priority?: boolean; reset?: boolean }, onAcquired: () => void) => Promise<unknown>
  periodicSweep: (key: WorkspaceKey) => Promise<unknown>
  followUp: MaintenanceFollowUp
  yieldWatch: SweepYieldWatch
} {
  const holds = createUnyieldingHolds(deps.exclusion)
  const unyielding: EpochPassSweepOptions['unyielding'] = (phase) => holds.during(phase)
  const followUp = createMaintenanceFollowUp({
    run: (key) => (deps.isShuttingDown()
      ? Promise.resolve({ outcome: 'shutting_down' })
      : deps.sweep(key, { exclusion: deps.exclusion, unyielding, ...maintenanceFollowUpSweepOptions() })),
    log: deps.log,
    ...deps.followUp,
  })
  deps.stops.push(() => followUp.stop())
  const yieldWatch = createSweepYieldWatch({ log: deps.log })
  return {
    holds,
    slotHeld: () => holds.held(),
    slotQueued: () => holds.queued(),
    async runRequestedOrS9(key, urgency, onAcquired) {
      const outcome = await deps.triggeredSweep(key, { exclusion: deps.exclusion, unyielding, ...triggeredSweepOptions(urgency), onAcquired })
      if (!urgency.reset) followUp.noteRequested(key, outcome)
      return outcome
    },
    async periodicSweep(key) {
      const outcome = await deps.sweep(key, { exclusion: deps.exclusion, unyielding, exclusionWaitMs: deps.periodicWaitMs })
      yieldWatch.note(key, outcome)
      return outcome
    },
    followUp,
    yieldWatch,
  }
}

/**
 * A PERIODIC SWEEP THAT NEVER RETIRES.
 * `model_epoch.sweep.starved` covers the sweeps SKIPPED behind one hold. A
 * sweep that gets the slot but yields every period (urgent waiters) retires
 * nothing and dedupes only partly, silently. Counted per workspace: past
 * {@link SWEEP_YIELD_ALERT_STREAK} consecutive yielded periodic sweeps,
 * `model_epoch.sweep.yield_starved` is raised once for the streak; a sweep
 * whose retirement ran clears it, a sweep that found a key taken leaves it
 * as it was.
 *
 * BOTH yields count: `preempted` (urgent waiters,
 * the case this alert was made for) and `budget` (a workspace whose sweep
 * always spends its 60 s) retire nothing alike. The alert's `reason` is the
 * last yield's, which tells them apart: `budget` points at the workspace's
 * size (or a slow store), `preempted` at the latches and compactions.
 */
export const SWEEP_YIELD_ALERT_STREAK = 6

export interface SweepYieldWatch {
  note(key: WorkspaceKey, outcome: unknown): void
  streak(key: WorkspaceKey): number
}

export function createSweepYieldWatch(options: { log: (event: Record<string, unknown>) => void; streak?: number }): SweepYieldWatch {
  const limit = options.streak ?? SWEEP_YIELD_ALERT_STREAK
  const streaks = new Map<string, number>()
  const id = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  return {
    note(key, outcome) {
      const o = outcome as { outcome?: string; retired?: { outcome?: string; reason?: string } }
      if (o?.outcome !== 'swept') return // busy / not resident: not this signal's
      // Only a retirement that
      // RAN (a report, no `outcome`) clears the streak; a taken key
      // (rotation or `model-epoch:`) retired nothing either — neutral.
      if (o.retired && 'outcome' in o.retired && o.retired.outcome !== 'yielded') return
      if (o.retired?.outcome !== 'yielded') { streaks.delete(id(key)); return }
      const next = (streaks.get(id(key)) ?? 0) + 1
      streaks.set(id(key), next)
      if (next === limit) {
        options.log({ event: 'model_epoch.sweep.yield_starved', alert: true, landscapeId: key.landscapeId, versionId: key.versionId,
          consecutiveYields: next, reason: o.retired.reason,
          detail: 'the periodic sweep got the pool-heavy slot but yielded this many times in a row: nothing is retired and the dedupe sweep is partial' })
      }
    },
    streak: (key) => streaks.get(id(key)) ?? 0,
  }
}

/**
 * AN E2E-ONLY LONG COMPACTION: the epoch e2e's
 * small workspace compacts in well under a second, so "a hop DURING
 * compactions" never saw a latch wait for, or be refused, the pool-heavy
 * slot the way F1 (`compactToSnapshot`, up to ~4.8 s) makes it in
 * production. With `MODEL_EPOCH_E2E_COMPACTION_HOLD=on` (the epoch e2e
 * harness only; ignored — with a warning — under NODE_ENV=production), a
 * `POST /api/model/compact?e2eHoldMs=…&e2eHoldAfterMs=…` arms the NEXT
 * compaction to:
 *  - keep the slot `holdMs` longer after its work, still inside its hold
 *    (a long F1);
 *  - hand the slot at its release to one more holder of `afterMs` (another
 *    pool-heavy pass queued at the release — what refuses S9 when it waits
 *    longer than S9's own wait).
 * Both bounded by {@link E2E_COMPACTION_HOLD_MAX_MS}. Off (the default and
 * every production deployment), `index.ts` builds nothing: one null check
 * per compaction.
 */
export const E2E_COMPACTION_HOLD_MAX_MS = 60_000

export interface E2eCompactionHold {
  /** The compact route's query: arms the next compaction (a no-op without the parameters). */
  arm(query: Record<string, unknown>): void
  /** Consumed by the compaction that starts: what it holds, then hands on. */
  take(): { holdMs: number; afterMs: number }
}

export function e2eCompactionHoldFromEnv(
  env: { MODEL_EPOCH_E2E_COMPACTION_HOLD?: string; NODE_ENV?: string },
  warn?: (message: string) => void,
): E2eCompactionHold | null {
  if (env.MODEL_EPOCH_E2E_COMPACTION_HOLD !== 'on') return null
  if (env.NODE_ENV === 'production') {
    warn?.('[model-epoch] MODEL_EPOCH_E2E_COMPACTION_HOLD is ignored in production (an e2e knob)')
    return null
  }
  const ms = (value: unknown): number => {
    const n = typeof value === 'string' ? Number(value) : Number.NaN
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), E2E_COMPACTION_HOLD_MAX_MS) : 0
  }
  let armed = { holdMs: 0, afterMs: 0 }
  return {
    arm(query) {
      const next = { holdMs: ms(query.e2eHoldMs), afterMs: ms(query.e2eHoldAfterMs) }
      if (next.holdMs > 0 || next.afterMs > 0) armed = next
    },
    take() {
      const taken = armed
      armed = { holdMs: 0, afterMs: 0 }
      return taken
    },
  }
}

/** What the durable-heads route needs of the trigger. */
export interface ForwardWaitTrigger {
  startsInMs(key: WorkspaceKey, options?: { priority?: boolean; reset?: boolean }): number
  request(key: WorkspaceKey, options?: { priority?: boolean; reset?: boolean }): Promise<void>
  /** D2 (`ForwardTrigger.latchReady`). Absent: always ready. */
  latchReady?(key: WorkspaceKey): boolean
  /** D2 (`ForwardTrigger.runningPass`). Absent: never asked. */
  runningPass?(key: WorkspaceKey): Promise<void> | null
  /** G4-16j (`ForwardTrigger.latchGranted`). Absent: always granted. */
  latchGranted?(key: WorkspaceKey): boolean
}

/**
 * THE DURABLE-HEADS ROUTE's forward wait (extracted from `index.ts` so it
 * is tested): when an asked document is a
 * live superseded source past its cursor (`forwardPending`), a pass is
 * requested — a LATCH one when the query says `latch=1` — and the route
 * waits for it, bounded by `waitMs`, only when it can START inside that
 * window; the answer is computed again only after a pass ran — the follow-up
 * it queued, or the pass already running when it asked. Returns the
 * (possibly re-computed) answer and what happened, for the trace.
 */
export async function awaitTriggeredForward<T extends { forwardPending?: true; forwardBusy?: true }>(input: {
  trigger: ForwardWaitTrigger | null
  key: WorkspaceKey
  query: Record<string, unknown>
  acknowledged: T[]
  reacknowledge: () => Promise<T[]>
  waitMs: number
  now?: () => number
}): Promise<{ acknowledged: T[]; ended: 'pass' | 'running-pass' | 'timeout' | 'not-waited' | 'not-triggered'; priority: boolean; granted: boolean; startsInMs: number; waitedMs: number }> {
  const priority = input.query.latch === '1'
  const now = input.now ?? Date.now
  if (!input.trigger || !input.acknowledged.some((d) => d.forwardPending)) {
    return { acknowledged: input.acknowledged, ended: 'not-triggered', priority, granted: false, startsInMs: 0, waitedMs: 0 }
  }
  const startedAt = now()
  const request = { priority }
  // G4-16j: whether the trigger keeps this latch's priority — read before
  // `request`, which applies the same predicate. Telemetry only.
  const granted = priority && (input.trigger.latchGranted?.(input.key) ?? true)
  const startsInMs = input.trigger.startsInMs(input.key, request)
  // D2: the pass RUNNING when the request is made (taken before it, so never
  // the one it starts) may already carry these heads — it reads each source
  // when it reaches it, and the tab flushed before asking. When it ends the
  // answer is computed again, and kept if nothing is pending any more: a
  // second tab latching while the first one's pass runs no longer waits for
  // the follow-up and its rest (measured: 1.5 s of a 2 s latch).
  const running = input.trigger.runningPass?.(input.key) ?? null
  const passing = input.trigger.request(input.key, request)
  const followUpWaited = startsInMs < input.waitMs
  let ended: 'pass' | 'running-pass' | 'timeout' | 'not-waited' = 'not-waited'
  let answered = input.acknowledged
  if (followUpWaited || running) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), input.waitMs) })
    const follow = followUpWaited ? passing.then(() => 'pass' as const) : null
    try {
      if (running) {
        const ran = running.then(() => 'running-pass' as const, () => 'running-pass' as const)
        const first = await Promise.race(follow ? [ran, timeout, follow] : [ran, timeout])
        if (first === 'running-pass') {
          answered = await input.reacknowledge()
          if (!answered.some((d) => d.forwardPending)) ended = 'running-pass'
          else ended = follow ? await Promise.race([follow, timeout]) : 'not-waited'
        } else {
          ended = first
        }
      } else {
        ended = await Promise.race([follow!, timeout])
      }
    } finally {
      clearTimeout(timer)
    }
  }
  if (ended === 'pass') answered = await input.reacknowledge()
  // D2: a source still pending while a latch could not be served at once is
  // marked `forwardBusy` — a draining tab waits instead of blocking input
  // for a latch bound to time out (S9 first, a compaction holding the slot,
  // another latch of the workspace just served).
  const busy = input.trigger.latchReady ? !input.trigger.latchReady(input.key) : false
  const acknowledged = busy ? answered.map((d) => (d.forwardPending ? { ...d, forwardBusy: true as const } : d)) : answered
  return { acknowledged, ended, priority, granted, startsInMs, waitedMs: now() - startedAt }
}

/** The workspaces the PERIODIC sweep walks: the compaction's
 * (default + allow-list) AND the meta-only ones — whose superseded metas
 * nothing else retires since the event-driven pass is forward-only. Each
 * once, in that order. */
export function periodicSweepWorkspaces(compacted: readonly WorkspaceKey[], metaOnly: readonly WorkspaceKey[]): WorkspaceKey[] {
  const seen = new Set<string>()
  return [...compacted, ...metaOnly].filter((key) => {
    const id = `${key.landscapeId}/${key.versionId}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Source outcomes that MOVED something: a later pass would not redo them. */
const MOVING_SOURCE_OUTCOMES = new Set(['forwarded', 'advanced', 'nothing-routed'])

/**
 * Whether a triggered pass progressed: it forwarded, advanced or routed
 * at least one source, compensated a duplicate or adopted a mirror URL. A
 * pass that was busy, contended, not resident, yielded with nothing done, or
 * whose sources all failed / were quarantined / leased elsewhere did not —
 * asking again at once would only redo it.
 */
export function forwardPassProgressed(result: unknown): boolean {
  const outcome = result as { outcome?: string; forwarded?: { outcome?: string; sources?: Array<{ outcome?: string }>; dedupe?: unknown[]; mirrorAdopted?: unknown[] } }
  if (outcome?.outcome !== 'swept' || outcome.forwarded?.outcome !== 'ran') return false
  const ran = outcome.forwarded
  return (ran.sources ?? []).some((s) => MOVING_SOURCE_OUTCOMES.has(String(s.outcome)))
    || (ran.dedupe?.length ?? 0) > 0
    || (ran.mirrorAdopted?.length ?? 0) > 0
}

/**
 * Whether a triggered pass was REFUSED rather than unproductive: the pool-heavy
 * slot was held (`busy` — a compaction, F1 holds it up to 4.8 s), or a waiter
 * (compaction, the periodic sweep, the meta-only job) preempted it before it
 * moved anything. The trigger then rests the minimal gap only and keeps its
 * backoff where it was.
 */
export function forwardPassRefused(result: unknown): boolean {
  const outcome = result as { outcome?: string; forwarded?: { outcome?: string; yielded?: string } }
  if (outcome?.outcome === 'busy') return true
  return outcome?.outcome === 'swept' && outcome.forwarded?.outcome === 'ran'
    && outcome.forwarded.yielded === 'preempted' && !forwardPassProgressed(result)
}

/** S9: a pass right after an epoch ROLLED or a crashed roll was
 * RECOVERED — by the compaction or by the meta-only job. */
export function epochRolledOrRecovered(outcome: unknown): boolean {
  const o = (outcome as { outcome?: string } | undefined)?.outcome
  return o === 'rolled' || o === 'recovered'
}

/**
 * Whether a workspace has epochs, as the durable-heads answer tells the tab:
 * its epoch rows, per workspace, memoized — POSITIVE is
 * sticky (a workspace that rolled once has epochs for good), NEGATIVE is
 * re-read after `negativeTtlMs`, an ERROR answers `undefined` (the answer
 * omits the bit; the tab keeps what it knew). A roll in this process marks
 * the workspace at once (`markRolled`), before the TTL.
 */
export interface EpochCapabilityMemo {
  get(key: WorkspaceKey): Promise<boolean | undefined>
  markRolled(key: WorkspaceKey): void
}

export function createEpochCapabilityMemo(
  rowsExist: (key: WorkspaceKey) => Promise<boolean>,
  options: { negativeTtlMs?: number; now?: () => number } = {},
): EpochCapabilityMemo {
  const ttl = options.negativeTtlMs ?? 60_000
  const now = options.now ?? Date.now
  const positive = new Set<string>()
  const negative = new Map<string, number>()
  const id = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  return {
    async get(key) {
      const k = id(key)
      if (positive.has(k)) return true
      const checkedAt = negative.get(k)
      if (checkedAt !== undefined && now() - checkedAt < ttl) return false
      try {
        const exists = await rowsExist(key)
        if (exists) { positive.add(k); negative.delete(k) } else negative.set(k, now())
        return exists
      } catch {
        return undefined
      }
    },
    markRolled(key) {
      positive.add(id(key))
      negative.delete(id(key))
    },
  }
}

/**
 * The diagnostics trace: JSON lines appended
 * ASYNCHRONOUSLY (never on the request path's event loop turn), in order,
 * up to `maxBytes` (then one `trace_truncated` line and nothing more).
 * Refused in production: it names documents and workspaces.
 */
export interface EpochTraceSink {
  readonly enabled: boolean
  write(event: Record<string, unknown>): void
  /** Settles when every line written so far is on disk (tests). */
  flushed(): Promise<void>
}

export function createEpochTraceSink(
  file: string | undefined,
  options: { nodeEnv?: string; maxBytes?: number; append?: (file: string, text: string) => Promise<void>; warn?: (message: string) => void } = {},
): EpochTraceSink {
  const disabled: EpochTraceSink = { enabled: false, write: () => undefined, flushed: async () => undefined }
  if (!file) return disabled
  if (options.nodeEnv === 'production') {
    options.warn?.('[model-epoch] MODEL_EPOCH_TRACE_FILE is ignored in production (it names documents)')
    return disabled
  }
  const max = options.maxBytes ?? 20 * 1024 * 1024
  const append = options.append ?? ((f: string, text: string) => appendFile(f, text))
  let written = 0
  let truncated = false
  let chain: Promise<void> = Promise.resolve()
  return {
    enabled: true,
    write(event) {
      if (truncated) return
      let line = `${JSON.stringify({ t: Date.now(), ...event })}\n`
      // BYTES, not UTF-16 units: a document name in another
      // script counts what it weighs on disk.
      if (written + Buffer.byteLength(line) > max) {
        truncated = true
        line = `${JSON.stringify({ t: Date.now(), event: 'trace_truncated', maxBytes: max })}\n`
      }
      written += Buffer.byteLength(line)
      chain = chain.then(() => append(file, line)).catch(() => undefined)
    },
    flushed: () => chain,
  }
}
