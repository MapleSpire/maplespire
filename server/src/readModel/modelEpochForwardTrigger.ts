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

import type { WorkspaceKey } from './projector.js'

/**
 * THE EVENT-DRIVEN FORWARD PASS (G4-16f): a late write on
 * a superseded epoch document is forwarded when a tab ASKS about it, not at
 * the next 10-minute sweep. Without it a user who types continuously while a
 * repoint is pending never converges: each latch's paused heads are past the
 * cursor until a pass lands inside its 2 s, which a timer cannot promise.
 *
 * The pass itself is the sweep's (`sweepModelEpochs`, injected as `run`):
 * the same `overlay-rotation:` keys, `model-epoch:` key, journal, write
 * fence and pool-heavy exclusion — no new lock edge, no new writer. This
 * module only decides WHEN:
 *  - SINGLE FLIGHT per workspace: one pass at a time; a request during a
 *    pass, or during the rest after it, is folded into ONE follow-up pass
 *    (the request may concern heads the running pass did not see), and
 *    every waiter of that period is answered by it;
 *  - A RATE CEILING per workspace: after a pass the workspace
 *    RESTS at least `minGapMs` and at least as long as that pass ran;
 *  - A BUDGET per PROCESS: ordinary passes start only while
 *    the passes of every workspace together held less than `budgetShare` of
 *    the last `budgetWindowMs` (default 30 % of 60 s); past it an ordinary
 *    request waits — the pool-heavy slot they share with compaction, the
 *    sweep, the meta-only job and the other workspaces is never monopolized
 *    by asking;
 *  - LATCH REQUESTS skip the rest: a hopping tab's 2 s
 *    latch needs the pass after the running one to start AT ONCE. At most
 *    `priorityBurst` (3, was one) such passes per workspace in any
 *    `priorityGapMs` (2 s) — every tab of a workspace sees a roll at the same
 *    moment and latches together, and the second one, demoted, waited the
 *    running pass, its rest and its own pass, past its 2 s — AND only
 *    while the priority passes of the process held less than their
 *    RESERVED share (`priorityShare`, default 15 % of the window): `latch=1`
 *    is a client parameter, never trusted — past the share a latch is an
 *    ordinary request (traced and logged), so a client asking
 *    `latch=1` in a loop over N workspaces holds the slot at most
 *    `budgetShare + priorityShare` (45 %) plus one pass;
 *  - S9 (`reset`): right after a roll, the workspace's backoff
 *    is cleared and the pass starts as soon as the running one ends — single
 *    flight kept; server-originated (one per roll), so outside the budget
 *    and outside the rotation yield. Refused the pool-heavy
 *    slot (a waiter took it at the release), it is RE-PLANNED after
 *    `minGapMs`, at most `resetRetries` (3) times;
 *  - ROTATION YIELD: a refused overlay rotation of
 *    the workspace (`yieldFor`) holds every pass of it but S9 back for a
 *    while, so the rotation's retry finds its keys free;
 *  - NO PROGRESS, NO RETRY STORM: a pass that moved nothing (`progressed`
 *    false: a source not resident, quarantined, failing, a contended key)
 *    backs the workspace off, doubling from `backoffMs` to `maxBackoffMs`; a
 *    pass that progresses resets it, and so does a quiet period of
 *    `maxBackoffMs` past the rest. A pass refused
 *    the pool-heavy slot (`busy`: compaction holds it, or a waiter preempted
 *    it) is NOT no-progress: only the minimal rest;
 *  - a request never throws: a failed pass is logged (and counts as no
 *    progress), the periodic sweep and the next request remain.
 * `run` is told whether the pass is URGENT (a latch or S9):
 * the entry point then waits for the slot as a waiter instead of only
 * trying it (`triggeredSweepOptions`, `modelEpochForwardWiring.ts`).
 * THE BUDGET COUNTS THE HOLD, NOT THE WAIT: `run` calls
 * `onAcquired()` the moment it holds the pool-heavy slot (`sweepModelEpochs`
 * calls it first thing under the slot). The process budget, the priority
 * share and the rest after a pass count from that instant to the pass's end;
 * a pass that never got the slot (`busy`, or a probe that stopped before it)
 * counts nothing — an S9 that waited 25 s behind a compaction and worked 1 s
 * is 1 s of the window, not 26. {@link ForwardTrigger.holding} is true over
 * the same interval.
 * Triggered by the durable-heads route when an asked document is a live
 * source past its cursor (`forwardPending`), and right after a roll (S9).
 */
export interface ForwardTrigger {
  /** Resolves when a pass that STARTED after this call has finished. */
  request(key: WorkspaceKey, options?: ForwardRequestOptions): Promise<void>
  /** A lower bound of how long until a pass this request would join starts
   * (ms): the route does not wait for one that cannot start in its window. */
  startsInMs(key: WorkspaceKey, options?: ForwardRequestOptions): number
  /** Hold every pass of this workspace but S9 back `ms` from now (a refused rotation). */
  yieldFor(key: WorkspaceKey, ms: number): void
  /** Passes in flight or queued (tests, diagnostics). */
  busy(key: WorkspaceKey): boolean
  /** A pass of this workspace is RUNNING now (so a refused rotation was
   * refused by it, not by a compaction). */
  running(key: WorkspaceKey): boolean
  /** The pass of this workspace running now (settles when it ends,
   * never rejects), or null — the durable-heads route answers again when it
   * ends, before the follow-up a request queues. */
  runningPass(key: WorkspaceKey): Promise<void> | null
  /** A pass of this workspace HOLDS the pool-heavy slot now — from its
   * `onAcquired()` to its end (a pass still WAITING for the
   * slot holds no `overlay-rotation:` key and refused no rotation). */
  holding(key: WorkspaceKey): boolean
  /** Whether a LATCH asked now would get its pass at once — no S9 of
   * the workspace running or queued (it runs first, and its first plan after
   * a roll is the slow one), no rotation yield, the latch's priority allowed
   * (per-workspace gap, the process's reserved share), and the pool-heavy
   * slot not held by anything but a pass of this trigger (a compaction — a
   * roll's own, the tab's repoint comes from it). The durable-heads route
   * tells a draining tab (`forwardBusy`), which then waits before it blocks
   * input: a latch started in such a window could not be served in its 2 s. */
  latchReady(key: WorkspaceKey): boolean
  /** G4-16j: whether a latch request made NOW keeps its priority — the
   * predicate `request` applies (`grantPriority`: the workspace's burst in
   * `priorityGapMs`, the process's reserved share), read without logging.
   * False: the request is served as an ordinary one (demoted). Telemetry
   * only; asked just before `request`. */
  latchGranted(key: WorkspaceKey): boolean
  /** Workspaces with state kept (tests: idle slots are purged). */
  slotCount(): number
  /** Entries of the budget's pass log (tests: it is pruned past the window). */
  passLogSize(): number
}

export interface ForwardRequestOptions {
  /** A hopping tab's latch asks (`latch=1`): no rest, at most `priorityBurst`
   * per workspace in any `priorityGapMs`, inside the reserved priority share. */
  priority?: boolean
  /** S9: clear the backoff, start as soon as the running pass ends. */
  reset?: boolean
}

/** What `run` is told about the pass it runs. */
export interface ForwardPassUrgency {
  /** A latch's pass. */
  priority: boolean
  /** S9's pass. */
  reset: boolean
}

export interface ForwardTriggerOptions {
  log?: (event: Record<string, unknown>) => void
  /** Diagnostics: every request and pass, timed. Absent: nothing is built. */
  trace?: (event: Record<string, unknown>) => void
  /** Whether a pass moved anything (default: every pass that did not throw). */
  progressed?: (result: unknown) => boolean
  /** Whether a pass was refused the pool-heavy slot or preempted with nothing
   * done (default: never): only the minimal rest, the backoff untouched. */
  busy?: (result: unknown) => boolean
  /** The least rest between two passes of a workspace (default 750 ms). */
  minGapMs?: number
  /** The first rest after a pass that moved nothing (default 1 s), doubled… */
  backoffMs?: number
  /** …up to this (default 30 s). */
  maxBackoffMs?: number
  /** One priority (latch) pass per workspace at most this often (default 2 s). */
  priorityGapMs?: number
  /** …at most this many in that gap (default {@link FORWARD_TRIGGER_PRIORITY_BURST}). */
  priorityBurst?: number
  /** The process budget: this share (default 0.3) of the last… */
  budgetShare?: number
  /** …window (default 60 s) for the ordinary passes of every workspace. */
  budgetWindowMs?: number
  /** The priority passes' reserved share of the window (default 0.15). */
  priorityShare?: number
  /** Over budget, an ordinary follow-up re-checks this often (default 1 s). */
  budgetRecheckMs?: number
  /** A refused S9 is re-planned at most this many times (default 3). */
  resetRetries?: number
  /** For `latchReady`: a latch's pass could not get the process's
   * pool-heavy slot within its wait now (absent: never). `index.ts` answers
   * `UnyieldingHolds.held()`: a compaction or the meta-only job HOLDING the
   * slot or QUEUED for it (the exclusion serves its waiters in order), or a phase
   * of a pass with no safe point — NOT the periodic sweep at a safe point,
   * which yields to the latch's waiter. A hold by one of this trigger's own
   * passes is told apart by the trigger itself. */
  slotHeld?: () => boolean
  /** A compaction or the
   * meta-only job WAITING for the slot (`UnyieldingHolds.queued`). Asked
   * before the exemption below: the exclusion serves its waiters in order
   * and a holding pass of this trigger yields to the FIRST — the
   * compaction, not the latch queued after it. Absent: never. */
  slotQueued?: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const FORWARD_TRIGGER_MIN_GAP_MS = 750
export const FORWARD_TRIGGER_BACKOFF_MS = 1_000
export const FORWARD_TRIGGER_MAX_BACKOFF_MS = 30_000
export const FORWARD_TRIGGER_PRIORITY_GAP_MS = 2_000
export const FORWARD_TRIGGER_PRIORITY_BURST = 3
export const FORWARD_TRIGGER_BUDGET_SHARE = 0.3
export const FORWARD_TRIGGER_PRIORITY_SHARE = 0.15
export const FORWARD_TRIGGER_BUDGET_WINDOW_MS = 60_000
export const FORWARD_TRIGGER_RESET_RETRIES = 3

interface Slot {
  running: Promise<void> | null
  runningSince: number
  /** The running pass holds the pool-heavy slot (its `onAcquired()` ran). */
  holding: boolean
  /** The running pass is S9's. */
  runningReset: boolean
  /** The follow-up pass, shared by every request made while one runs or rests. */
  next: Promise<void> | null
  /** The queued follow-up skips the rest and the budget (latch or S9). */
  skipRest: boolean
  /** …and it was a latch (it then counts against the burst of `priorityGapMs`). */
  nextIsPriority: boolean
  /** …and it is S9's (it ignores the rotation yield; refused, re-planned). */
  nextIsReset: boolean
  /** The S9 attempt the queued follow-up carries (0: the first). */
  nextResetAttempt: number
  /** Wakes a follow-up sleeping its rest when a latch or S9 joins it. */
  wake: (() => void) | null
  /** No ordinary pass of this workspace starts before this instant. */
  notBefore: number
  /** No pass but S9 before this instant (a refused rotation). */
  yieldUntil: number
  /** The current no-progress rest (0 after a pass that progressed). */
  backoff: number
  /** When this workspace's latch passes started, the last `priorityGapMs` only. */
  priorityAt: number[]
}

interface PassKind extends ForwardPassUrgency {
  /** S9 attempt number (0: the first). */
  resetAttempt: number
}

export function createForwardTrigger(
  run: (key: WorkspaceKey, urgency: ForwardPassUrgency, onAcquired: () => void) => Promise<unknown>,
  options: ForwardTriggerOptions = {},
): ForwardTrigger {
  const { log, trace } = options
  const progressed = options.progressed ?? (() => true)
  const refused = options.busy ?? (() => false)
  const minGap = options.minGapMs ?? FORWARD_TRIGGER_MIN_GAP_MS
  const firstBackoff = options.backoffMs ?? FORWARD_TRIGGER_BACKOFF_MS
  const maxBackoff = options.maxBackoffMs ?? FORWARD_TRIGGER_MAX_BACKOFF_MS
  const priorityGap = options.priorityGapMs ?? FORWARD_TRIGGER_PRIORITY_GAP_MS
  const priorityBurst = options.priorityBurst ?? FORWARD_TRIGGER_PRIORITY_BURST
  /** The workspace's latch passes started inside the gap (pruned as read). */
  const recentPriority = (slot: Slot, at: number): number => {
    while (slot.priorityAt.length > 0 && at - slot.priorityAt[0]! >= priorityGap) slot.priorityAt.shift()
    return slot.priorityAt.length
  }
  const budgetShare = options.budgetShare ?? FORWARD_TRIGGER_BUDGET_SHARE
  const priorityShare = options.priorityShare ?? FORWARD_TRIGGER_PRIORITY_SHARE
  const budgetWindow = options.budgetWindowMs ?? FORWARD_TRIGGER_BUDGET_WINDOW_MS
  const budgetRecheck = options.budgetRecheckMs ?? 1_000
  const resetRetries = options.resetRetries ?? FORWARD_TRIGGER_RESET_RETRIES
  const now = options.now ?? Date.now
  // `unref`: a resting follow-up never holds the process's exit.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.() }))
  const slots = new Map<string, Slot>()
  const id = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  let passSeq = 0
  /** Every HOLD of the pool-heavy slot by a pass of any workspace: [the
   * pass's `onAcquired()`, its end] (end null while it holds), for the
   * process budget (S9's counted, never held by it); `priority` marks a
   * latch's. The wait for the slot is never in it. */
  const passLog: Array<{ start: number; end: number | null; priority: boolean }> = []
  /** The last instant a demoted latch was LOGGED (once per window). */
  let demotedLoggedAt = Number.NEGATIVE_INFINITY

  /** The window's use, CLIPPED to the window (a pass begun before it counts
   * only its part inside), in total and for the priority passes alone. */
  function budgetUsedMs(at: number): { total: number; priority: number } {
    const from = at - budgetWindow
    // Every ended entry past the window goes, wherever it is in the log
    // (a hold that never ends does not pin the ones after it).
    for (let i = passLog.length - 1; i >= 0; i -= 1) {
      const end = passLog[i]!.end
      if (end !== null && end <= from) passLog.splice(i, 1)
    }
    let total = 0
    let priority = 0
    for (const p of passLog) {
      const used = Math.max(0, (p.end ?? at) - Math.max(p.start, from))
      total += used
      if (p.priority) priority += used
    }
    return { total, priority }
  }
  const overBudget = (at: number) => budgetUsedMs(at).total >= budgetShare * budgetWindow
  const priorityBudgetLeft = (at: number) => budgetUsedMs(at).priority < priorityShare * budgetWindow

  /** A latch may skip the rest: the workspace has not had `priorityBurst`
   * of them in the gap, and the process's priority passes are inside their
   * reserved share. */
  const priorityAllowed = (slot: Slot | undefined, at: number) =>
    (!slot || recentPriority(slot, at) < priorityBurst) && priorityBudgetLeft(at)

  /** Whether a latch asked for is granted; a demotion past the reserved
   * share is traced, and logged once per window. */
  function grantPriority(k: string, slot: Slot | undefined, at: number): boolean {
    // The same predicate as `latchGranted` (G4-16j), so the two cannot drift.
    if (priorityAllowed(slot, at)) return true
    if (slot && recentPriority(slot, at) >= priorityBurst) return false
    trace?.({ event: 'forward_trigger.latch_demoted', workspace: k })
    if (at - demotedLoggedAt >= budgetWindow) {
      demotedLoggedAt = at
      log?.({ event: 'model_epoch.forward_trigger.latch_demoted', workspace: k,
        detail: 'latch=1 requests past the reserved priority share are served as ordinary requests' })
    }
    return false
  }

  async function pass(key: WorkspaceKey, slot: Slot, kind: PassKind, priorityStamp: number | null): Promise<boolean> {
    const seq = ++passSeq
    const startedAt = now()
    slot.runningSince = startedAt
    // Opened when `run` HOLDS the slot: the wait before it is
    // never budget, never rest.
    let entry: { start: number; end: number | null; priority: boolean } | null = null
    const onAcquired = () => {
      if (entry) return
      entry = { start: now(), end: null, priority: kind.priority }
      passLog.push(entry)
      slot.holding = true
      slot.runningSince = entry.start
      trace?.({ event: 'forward_trigger.pass_acquired', seq, workspace: id(key), waitedMs: entry.start - startedAt,
        priority: kind.priority, reset: kind.reset })
    }
    trace?.({ event: 'forward_trigger.pass_start', seq, workspace: id(key), priority: kind.priority, reset: kind.reset,
      ...(kind.reset ? { attempt: kind.resetAttempt } : {}) })
    let moved = false
    let wasRefused = false
    const held = () => {
      const opened = entry as { start: number; end: number | null } | null
      return opened ? { waitedMs: opened.start - startedAt, heldMs: (opened.end ?? now()) - opened.start } : { waitedMs: now() - startedAt, heldMs: 0 }
    }
    try {
      const result = await run(key, { priority: kind.priority, reset: kind.reset }, onAcquired)
      wasRefused = refused(result)
      moved = !wasRefused && progressed(result)
      trace?.({ event: 'forward_trigger.pass_end', seq, workspace: id(key), ms: now() - startedAt, ...held(), acquired: entry !== null,
        priority: kind.priority, reset: kind.reset, progressed: moved, busy: wasRefused, result: JSON.stringify(result ?? null).slice(0, 600) })
    } catch (error) {
      trace?.({ event: 'forward_trigger.pass_failed', seq, workspace: id(key), ms: now() - startedAt, ...held(), acquired: entry !== null,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
      log?.({ event: 'model_epoch.forward_trigger.failed', landscapeId: key.landscapeId, versionId: key.versionId,
        error: error instanceof Error ? error.message : String(error) })
    }
    const endedAt = now()
    const hold = entry as { start: number; end: number | null } | null
    if (hold) hold.end = endedAt
    slot.holding = false
    const ranMs = hold ? endedAt - hold.start : 0
    if (wasRefused) {
      // Refused the slot: nothing ran, nothing to back off from.
      slot.notBefore = now() + minGap
      // Nor a latch's share of the burst — a
      // latch pass refused behind a compaction held nothing, and the next
      // ask of the same latch may start one once the slot is free.
      if (priorityStamp !== null) {
        const at = slot.priorityAt.indexOf(priorityStamp)
        if (at >= 0) slot.priorityAt.splice(at, 1)
      }
      return kind.reset && kind.resetAttempt < resetRetries
    }
    slot.backoff = moved ? 0 : Math.min(maxBackoff, slot.backoff > 0 ? slot.backoff * 2 : firstBackoff)
    slot.notBefore = now() + Math.max(minGap, ranMs, slot.backoff)
    return false
  }

  function start(key: WorkspaceKey, slot: Slot, kind: PassKind): Promise<void> {
    const priorityStamp = kind.priority ? now() : null
    if (priorityStamp !== null) slot.priorityAt.push(priorityStamp)
    slot.runningReset = kind.reset
    const running = pass(key, slot, kind, priorityStamp).then((replan) => {
      slot.running = null
      slot.runningReset = false
      // A REFUSED S9 is not lost — re-planned
      // after the minimal rest, a bounded number of times.
      if (replan) {
        trace?.({ event: 'forward_trigger.reset_replanned', workspace: id(key), attempt: kind.resetAttempt + 1 })
        void sleep(minGap).then(() => requestPass(key, { reset: true }, kind.resetAttempt + 1))
      }
    }, () => { slot.running = null; slot.runningReset = false })
    slot.running = running
    return running
  }

  /** Lazy purge: an idle slot whose rest and backoff are
   * over is forgotten; a quiet backoff decays to nothing. A slot with a
   * latch younger than `priorityGapMs` is kept (forgotten,
   * its workspace would get more latches inside the gap than its burst). */
  function purge(at: number, keep: string): void {
    for (const [k, slot] of slots) {
      if (slot.running || slot.next) continue
      const quietFrom = slot.notBefore + (slot.backoff > 0 ? maxBackoff : 0)
      if (at >= quietFrom && at >= slot.yieldUntil) {
        if (k === keep) slot.backoff = 0
        else if (recentPriority(slot, at) === 0) slots.delete(k)
      }
    }
  }

  function slotOf(k: string): Slot {
    let slot = slots.get(k)
    if (!slot) {
      slot = { running: null, runningSince: 0, holding: false, runningReset: false, next: null, skipRest: false, nextIsPriority: false, nextIsReset: false,
        nextResetAttempt: 0, wake: null, notBefore: 0, yieldUntil: 0, backoff: 0, priorityAt: [] }
      slots.set(k, slot)
    }
    return slot
  }

  /** How long the queued follow-up must still wait (0: it may start). */
  function followUpWait(slot: Pick<Slot, 'skipRest' | 'nextIsReset' | 'notBefore' | 'yieldUntil'>, at: number): number {
    // S9 is not held by the rotation yield.
    const held = slot.nextIsReset ? 0 : Math.max(0, slot.yieldUntil - at)
    if (slot.skipRest) return held
    const rest = Math.max(0, slot.notBefore - at)
    if (rest > 0 || held > 0) return Math.max(rest, held)
    return overBudget(at) ? budgetRecheck : 0
  }

  function requestPass(key: WorkspaceKey, requestOptions: ForwardRequestOptions, resetAttempt: number): Promise<void> {
    const k = id(key)
    const at = now()
    purge(at, k)
    const slot = slotOf(k)
    const reset = requestOptions.reset === true
    if (reset) slot.backoff = 0
    const priority = requestOptions.priority === true && grantPriority(k, slot, at)
    const urgent = priority || reset
    if (slot.next) {
      trace?.({ event: 'forward_trigger.request', workspace: k, joined: 'follow-up', priority, reset })
      if (urgent && !slot.skipRest) {
        slot.skipRest = true
        slot.nextIsPriority = priority
        slot.wake?.()
      }
      if (reset && !slot.nextIsReset) {
        slot.nextIsReset = true
        slot.nextResetAttempt = resetAttempt
        slot.wake?.()
      }
      return slot.next
    }
    if (!slot.running && followUpWait({ ...slot, skipRest: urgent, nextIsReset: reset }, at) === 0) {
      trace?.({ event: 'forward_trigger.request', workspace: k, joined: 'new-pass', priority, reset })
      return start(key, slot, { priority, reset, resetAttempt })
    }
    trace?.({ event: 'forward_trigger.request', workspace: k, joined: 'queued-follow-up', priority, reset })
    const current = slot
    current.skipRest = urgent
    current.nextIsPriority = priority
    current.nextIsReset = reset
    current.nextResetAttempt = resetAttempt
    const after = slot.running ?? Promise.resolve()
    current.next = after
      .then(async () => {
        for (;;) {
          const wait = followUpWait(current, now())
          if (wait <= 0) return
          await Promise.race([
            sleep(wait),
            new Promise<void>((resolve) => { current.wake = resolve }),
          ])
          current.wake = null
        }
      })
      .then(() => {
        // Cleared BEFORE the pass starts: a request during THIS pass must
        // queue the NEXT one, not join one already running.
        current.next = null
        const kind: PassKind = { priority: current.nextIsPriority, reset: current.nextIsReset, resetAttempt: current.nextResetAttempt }
        current.skipRest = false
        current.nextIsPriority = false
        current.nextIsReset = false
        current.nextResetAttempt = 0
        return start(key, current, kind)
      })
    return current.next
  }

  return {
    request: (key, requestOptions = {}) => requestPass(key, requestOptions, 0),
    startsInMs(key, requestOptions = {}) {
      const at = now()
      const slot = slots.get(id(key))
      const reset = requestOptions.reset === true
      const priority = requestOptions.priority === true && priorityAllowed(slot, at)
      const urgent = priority || reset
      if (!slot) return !urgent && overBudget(at) ? budgetRecheck : 0
      const held = reset ? 0 : Math.max(0, slot.yieldUntil - at)
      if (slot.running) {
        // Joins the follow-up: after the running pass, then (ordinary) a rest
        // of at least max(minGap, how long it has HELD the slot so far).
        if (urgent || (slot.next && slot.skipRest)) return held
        return Math.max(held, minGap, slot.holding ? at - slot.runningSince : 0)
      }
      return followUpWait({
        notBefore: slot.notBefore, yieldUntil: slot.yieldUntil,
        skipRest: urgent || (slot.next !== null && slot.skipRest),
        nextIsReset: reset || (slot.next !== null && slot.nextIsReset),
      }, at)
    },
    yieldFor(key, ms) {
      const slot = slotOf(id(key))
      slot.yieldUntil = Math.max(slot.yieldUntil, now() + ms)
      trace?.({ event: 'forward_trigger.yield', workspace: id(key), ms })
    },
    busy: (key) => {
      const slot = slots.get(id(key))
      return !!slot && (slot.running !== null || slot.next !== null)
    },
    running: (key) => (slots.get(id(key))?.running ?? null) !== null,
    runningPass: (key) => slots.get(id(key))?.running ?? null,
    holding: (key) => slots.get(id(key))?.holding === true,
    latchReady(key) {
      const at = now()
      const slot = slots.get(id(key))
      if (slot && (slot.runningReset || (slot.next !== null && slot.nextIsReset) || slot.yieldUntil > at)) return false
      // A compaction queued for the slot is served before a latch's pass,
      // whoever holds it now.
      if (options.slotQueued?.()) return false
      // Held by a pass of this trigger (any workspace's: short, and a latch
      // waits for it as a waiter) is not "held elsewhere".
      if (options.slotHeld?.() && ![...slots.values()].some((s) => s.holding)) return false
      return priorityAllowed(slot, at)
    },
    latchGranted: (key) => priorityAllowed(slots.get(id(key)), now()),
    slotCount: () => slots.size,
    passLogSize: () => { budgetUsedMs(now()); return passLog.length },
  }
}
