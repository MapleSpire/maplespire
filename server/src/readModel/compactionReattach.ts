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
import { ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError } from './projectorService.js'
import type { WorkspaceKey } from './projector.js'
import type { WorkspaceCompactionDeps } from './workspaceCompaction.js'

/**
 * THE RE-ATTACH A COMPACTION COULD NOT DO, RETRIED (G4-16f, 3-year bench).
 *
 * `runWorkspaceCompaction` detaches the workspace's projector, folds, and
 * re-attaches it with a `{ adopt: false }` cold build. When that re-attach
 * fails the pass names it (`skipped_reattach_failed`, guard (c)) and hands it
 * here (`noteDetached`). Before this module nothing retried it: measured on
 * the bench, a storage permit refused for 2 s on slow storage became a read
 * plane detached for good.
 *
 * THE SCHEDULE, per workspace. Fast first — {@link COMPACTION_REATTACH_DELAYS_MS}
 * (1, 2, 5, 10, 30 s) for a refusal that really was transient — then
 * {@link COMPACTION_REATTACH_BACKOFF_MS} (60, 120, 300 s, the last repeated),
 * with ±{@link COMPACTION_REATTACH_JITTER} of jitter. No ceiling on the NUMBER
 * of attempts: giving up is the defect being fixed; the ceiling is on the rate.
 *
 * THE REST, for the whole supervisor: no
 * attempt of ANY workspace starts before the last build's release plus
 * {@link COMPACTION_REATTACH_REST_FACTOR} × how long that build held the slot.
 * An attempt is a whole cold build (45 s on the bench's slow storage) inside
 * the slot the epoch sweep, the meta-only job and the hop latches wait for
 * (`forwardBusy`, `latchReady`); with the rest shared, the retries of every
 * detached workspace of the cell together hold it at most 1 / (1 + k) = 25 %
 * of the time, whatever a build costs and however many workspaces fail. (Per
 * workspace, N of them would take min(1, N / (1 + k)) of it.)
 *
 * UNDER THE COMPACTION'S EXCLUSION (`exclusive`, production: the pool-heavy
 * slot every pass holds for its whole run): an attempt never runs DURING a
 * pass. Everything is asked twice: OUTSIDE the slot first (no queueing behind
 * a pass, no waiter making a sweep yield, for an attempt that has nothing to
 * do), then again UNDER it. An attempt always runs after the pass that
 * detached returned, so its cold build reads the compacted documents, never
 * the kept rows (`{ adopt: false }`, the fleet's `compactionDetached`).
 *
 * NOT A PAGE FOR WHAT A RETRY CANNOT FIX. Two DORMANT states, out of the
 * detached gauges:
 *  - `not_owned`: this cell does not own the workspace now (a lease late to
 *    renew on a loaded host, a handover). Not abandoned — that would bring the
 *    permanent outage back by another door: on an ownership acquisition
 *    (`noteOwnershipAcquired`) `owns()` is asked after
 *    {@link COMPACTION_REATTACH_ACQUIRED_CHECKS_MS} (the acquisition listeners
 *    run BEFORE `owns()` turns true), otherwise every
 *    {@link COMPACTION_REATTACH_DORMANT_CHECK_MS}, without the slot; dropped
 *    after {@link COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS} (the workspace moved
 *    for good: its new owner's projector serves it);
 *  - `no_root`: the root did not resolve {@link COMPACTION_REATTACH_NO_ROOT_LIMIT}
 *    times in a row (a deleted or broken workspace); retried every
 *    {@link COMPACTION_REATTACH_NO_ROOT_PERIOD_MS}, on a ticket alert. Any
 *    other failure makes it an ordinary outage again.
 * A woken workspace keeps the AGE of its outage: a lease that
 * flaps cannot restart the alerts' windows.
 * It STOPS otherwise only on a promotion to summary (the static projector
 * serves the workspace) or the process stopping.
 *
 * A RECOVERY BY ANYONE ENDS THE OUTAGE AT ONCE: the fleet tells this
 * supervisor whenever a workspace becomes resident (`noteAttached`), so a
 * read's cold build takes the gauge to 0 without waiting for the next tick,
 * and lifts the fleet's `compactionDetached` mark when the slot is free.
 *
 * SKIPPED WHILE STORAGE STILL REFUSES: an attempt whose storage-write gate has
 * callers queued (`storageSaturated`) is postponed without taking the slot, at
 * most {@link COMPACTION_REATTACH_MAX_SATURATED_SKIPS} times in a row — the
 * cold build it would run IS more load on the saturated storage.
 *
 * A WATCHDOG: every re-attach BUILD in flight, the pass's own
 * (`watchReattach`) and this supervisor's (from the moment it holds the slot,
 * not while it waits for it), is a gauge (`..._running_seconds`) and, past
 * {@link COMPACTION_REATTACH_SLOW_LOG_MS}, a log line. A cold build waiting on
 * a lock does not fail and cannot be cancelled (`ProjectorFleet.release` only
 * bumps a generation), so it is made visible rather than given a deadline.
 */

/** The fast phase, in order. */
export const COMPACTION_REATTACH_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000]
/** After the fast phase, in order; the last one repeats. */
export const COMPACTION_REATTACH_BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000]
/** Jitter on the backoff phase: ± this fraction. */
export const COMPACTION_REATTACH_JITTER = 0.2
/** No attempt before the last build's release plus this many times its hold of the slot. */
export const COMPACTION_REATTACH_REST_FACTOR = 3
/** A dormant `not_owned` workspace: how often `owns()` is asked again. */
export const COMPACTION_REATTACH_DORMANT_CHECK_MS = 60_000
/** After an ownership acquisition: when `owns()` is asked, then the period above. */
export const COMPACTION_REATTACH_ACQUIRED_CHECKS_MS: readonly number[] = [1_000, 2_000, 5_000]
/** A workspace dormant `not_owned` this long is dropped: it moved for good. */
export const COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS = 86_400_000
/** Consecutive `no_root` answers before the workspace goes dormant. */
export const COMPACTION_REATTACH_NO_ROOT_LIMIT = 3
/** A dormant `no_root` workspace: how often it is tried again. */
export const COMPACTION_REATTACH_NO_ROOT_PERIOD_MS = 900_000
/** Consecutive attempts postponed for a saturated storage gate before one runs anyway. */
export const COMPACTION_REATTACH_MAX_SATURATED_SKIPS = 5
/** A re-attach build in flight longer than this is logged (`read_model.compaction_reattach_slow`). */
export const COMPACTION_REATTACH_SLOW_LOG_MS = 120_000
/**
 * The longest the shared rest may last after one build. 3 × a cold build
 * of three years (45-90 s) is 2-5 min, and a manual test measured 507 s after a pass
 * held 169 s by a row lock; a build held for half an hour would otherwise
 * forbid every retry for an hour and a half, past the Outage page, for a
 * share of the slot that build already took. 15 min is the 300 s step plus
 * margin: beyond builds of 5 min the 25 % bound gives way to recovering
 * within the page's window (the Stuck ticket has fired by then anyway).
 */
export const COMPACTION_REATTACH_REST_MAX_MS = 900_000

export interface CompactionReattachDeps {
  readonly fleet: Pick<WorkspaceCompactionDeps['fleet'], 'isResident' | 'ensure'> & {
    /** Lift the fleet's `compactionDetached` mark of a resident workspace. */
    liftCompactionDetached?(key: WorkspaceKey): void
  }
  readonly owns: (key: WorkspaceKey) => boolean
  readonly isShuttingDown: () => boolean
  /** The exclusion every compaction pass runs under (production: the
   * pool-heavy slot, `unyieldingHolds.run`). An attempt runs inside it. */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
  /** Is that exclusion held now (production: `unyieldingHolds.held`)? A
   * recovery seen from outside lifts the fleet's mark only when it is not. */
  readonly slotHeld?: () => boolean
  /** Does the storage write gate have callers queued now? */
  readonly storageSaturated?: () => boolean
  readonly delaysMs?: readonly number[]
  readonly backoffMs?: readonly number[]
  readonly restFactor?: number
  readonly jitter?: number
  readonly dormantCheckMs?: number
  readonly notOwnedExpiryMs?: number
  readonly noRootLimit?: number
  readonly noRootPeriodMs?: number
  readonly slowLogMs?: number
  readonly random?: () => number
  readonly now?: () => number
  readonly log?: (event: Record<string, unknown>) => void
  readonly warn?: (event: Record<string, unknown>) => void
  /** Diagnostics (`MODEL_EPOCH_TRACE_FILE`): the slot's wait, acquisition and release. */
  readonly trace?: (event: Record<string, unknown>) => void
}

/** Why a pass handed a workspace over. */
export type DetachedReason = 'reattach_failed' | 'no_root' | 'not_owned'
export type DormantReason = 'not_owned' | 'no_root'
/** Why a detached workspace left the supervisor without being re-attached. */
export type CompactionReattachAbandon = 'static_workspace' | 'shutting_down' | 'not_owned_expired'

export interface CompactionReattachSnapshot {
  /** Workspaces a compaction left detached, being retried (the alerts' gauge). */
  detached: number
  /** Age of the oldest of them since its FIRST detachment, ms; 0 when none. */
  oldestDetachedMs: number
  /** Detached workspaces this supervisor is not retrying actively. */
  dormant: Record<DormantReason, number>
  /** Since process start, by outcome. */
  attempts: { attached: number; alreadyResident: number; failed: number; abandoned: number; skippedSaturated: number }
  /** Total time attempts held the compaction slot, ms, the hold in progress included. */
  slotHeldMs: number
  /** The longest re-attach build in flight now (the pass's or a retry's), ms; 0 when none. */
  runningMs: number
}

interface Pending {
  key: WorkspaceKey
  /** The first detachment: kept across dormant phases. */
  since: number
  state: 'active' | 'dormant'
  dormantReason: DormantReason | null
  dormantSince: number
  attempts: number
  /** Index into the schedule (fast phase, then the backoff). */
  step: number
  noRootStreak: number
  saturatedSkips: number
  /** After an ownership acquisition: the short checks still to make. */
  acquiredChecks: number[]
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
}

const keyOf = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
const describe = (error: unknown) => {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } catch {
    return '(an error that cannot be described)'
  }
}

type Outcome = 'attached' | 'already_resident' | 'no_root' | 'not_owned' | 'resting' | CompactionReattachAbandon

export class CompactionReattachSupervisor {
  private readonly deps: CompactionReattachDeps
  private readonly delaysMs: readonly number[]
  private readonly backoffMs: readonly number[]
  private readonly restFactor: number
  private readonly jitter: number
  private readonly dormantCheckMs: number
  private readonly notOwnedExpiryMs: number
  private readonly noRootLimit: number
  private readonly noRootPeriodMs: number
  private readonly slowLogMs: number
  private readonly random: () => number
  private readonly now: () => number
  private readonly pending = new Map<string, Pending>()
  private readonly running = new Map<number, { key: WorkspaceKey; by: 'pass' | 'retry'; since: number }>()
  private nextWatch = 0
  private readonly counts = { attached: 0, alreadyResident: 0, failed: 0, abandoned: 0, skippedSaturated: 0 }
  private slotHeldMs = 0
  /** When the hold in progress began, or null. */
  private holdingSince: number | null = null
  /** THE SHARED REST: the last build's release and its hold of the slot. */
  /** When the shared rest ends: the LATEST of every build's release +
   * k × its hold (capped), so a short build cannot shorten a longer rest. */
  private restEnd = Number.NEGATIVE_INFINITY
  private stopped = false

  constructor(deps: CompactionReattachDeps) {
    this.deps = deps
    this.delaysMs = deps.delaysMs ?? COMPACTION_REATTACH_DELAYS_MS
    this.backoffMs = deps.backoffMs?.length ? deps.backoffMs : COMPACTION_REATTACH_BACKOFF_MS
    this.restFactor = Math.max(0, deps.restFactor ?? COMPACTION_REATTACH_REST_FACTOR)
    this.jitter = Math.min(1, Math.max(0, deps.jitter ?? COMPACTION_REATTACH_JITTER))
    this.dormantCheckMs = Math.max(1, deps.dormantCheckMs ?? COMPACTION_REATTACH_DORMANT_CHECK_MS)
    this.notOwnedExpiryMs = Math.max(1, deps.notOwnedExpiryMs ?? COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS)
    this.noRootLimit = Math.max(1, deps.noRootLimit ?? COMPACTION_REATTACH_NO_ROOT_LIMIT)
    this.noRootPeriodMs = Math.max(1, deps.noRootPeriodMs ?? COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
    this.slowLogMs = Math.max(1, deps.slowLogMs ?? COMPACTION_REATTACH_SLOW_LOG_MS)
    this.random = deps.random ?? Math.random
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * A compaction pass left `key` detached. `reattach_failed` and `no_root`
   * start the retry; `not_owned` makes it dormant (this cell will retry once
   * it owns the workspace again). A workspace already known keeps its
   * schedule and its age (a second pass failing again is the same outage); a
   * DORMANT one whose owner pass failed again is retried from the fast phase.
   */
  noteDetached(key: WorkspaceKey, cause: unknown, reason: DetachedReason = 'reattach_failed'): void {
    if (this.stopped) return
    const k = keyOf(key)
    const existing = this.pending.get(k)
    if (existing) {
      // Not while its attempt runs: that attempt reports, and reschedules.
      if (existing.state === 'dormant' && reason !== 'not_owned' && !existing.running) {
        if (existing.timer) clearTimeout(existing.timer)
        this.wake(existing, 'reattach_failed_again')
        this.schedule(existing, this.nextDelay(existing))
      }
      return
    }
    const now = this.now()
    const entry: Pending = {
      key, since: now, state: 'active', dormantReason: null, dormantSince: now, attempts: 0, step: 0,
      noRootStreak: reason === 'no_root' ? 1 : 0, saturatedSkips: 0, acquiredChecks: [], timer: null, running: false,
    }
    this.pending.set(k, entry)
    if (reason === 'not_owned') {
      this.dormant(entry, 'not_owned', describe(cause))
      return
    }
    const inMs = this.nextDelay(entry)
    this.warn({ event: 'read_model.compaction_reattach_pending', workspace: k, cause: describe(cause), reason, nextAttemptMs: inMs })
    this.schedule(entry, inMs)
  }

  /**
   * The workspace became RESIDENT through any start (the fleet's
   * `onResident`): the outage is over now, not at the next tick — an active
   * or a dormant one. Ignored while this supervisor's own attempt is running
   * (the attempt reports it).
   */
  noteAttached(key: WorkspaceKey): void {
    const entry = this.pending.get(keyOf(key))
    if (!entry || entry.running) return
    this.recovered(entry, 'already_resident', { lift: this.slotFree() })
  }

  /** This cell acquired the workspace: a dormant `not_owned` entry asks
   * `owns()` at {@link COMPACTION_REATTACH_ACQUIRED_CHECKS_MS} — not now: the
   * acquisition listeners run BEFORE `owns()` turns true (an admission
   * barrier, `syncCells/ownership.ts`). */
  noteOwnershipAcquired(key: WorkspaceKey): void {
    const entry = this.pending.get(keyOf(key))
    if (!entry || this.stopped || entry.state !== 'dormant' || entry.dormantReason !== 'not_owned') return
    if (entry.timer) clearTimeout(entry.timer)
    entry.acquiredChecks = [...COMPACTION_REATTACH_ACQUIRED_CHECKS_MS]
    this.schedule(entry, entry.acquiredChecks.shift()!)
  }

  /**
   * The WATCHDOG of one re-attach build in flight (the pass's,
   * `watchReattach`, or a retry's once it holds the slot): counted in
   * `runningMs` until the returned function is called, and logged once past
   * {@link COMPACTION_REATTACH_SLOW_LOG_MS}. A PASS's re-attach is a whole
   * cold build under the same slot: when it settles it feeds the shared rest
   * too, so the first retry after a pass whose build held
   * the slot 45 s waits 3 × 45 s rather than 1 s.
   */
  watchReattach(key: WorkspaceKey, by: 'pass' | 'retry' = 'pass'): () => void {
    const id = ++this.nextWatch
    const since = this.now()
    this.running.set(id, { key, by, since })
    const timer = setTimeout(() => {
      if (!this.running.has(id)) return
      this.warn({ event: 'read_model.compaction_reattach_slow', workspace: keyOf(key), by, runningMs: this.now() - since })
    }, this.slowLogMs)
    timer.unref?.()
    return () => {
      clearTimeout(timer)
      if (!this.running.delete(id)) return
      if (by === 'pass') {
        this.extendRest(this.now() - since)
      }
    }
  }

  /** Is this workspace being retried actively? */
  isPending(key: WorkspaceKey): boolean {
    return this.pending.get(keyOf(key))?.state === 'active'
  }

  /** Is this workspace detached and dormant, and why? */
  dormantReason(key: WorkspaceKey): DormantReason | null {
    const entry = this.pending.get(keyOf(key))
    return entry?.state === 'dormant' ? entry.dormantReason : null
  }

  snapshot(): CompactionReattachSnapshot {
    const now = this.now()
    let oldest = 0
    let detached = 0
    const dormant: Record<DormantReason, number> = { not_owned: 0, no_root: 0 }
    for (const entry of this.pending.values()) {
      if (entry.state === 'dormant' && entry.dormantReason) { dormant[entry.dormantReason] += 1; continue }
      detached += 1
      oldest = Math.max(oldest, now - entry.since)
    }
    let runningMs = 0
    for (const watch of this.running.values()) runningMs = Math.max(runningMs, now - watch.since)
    // The hold in progress counts now, not only when it ends.
    const held = this.slotHeldMs + (this.holdingSince === null ? 0 : now - this.holdingSince)
    return { detached, oldestDetachedMs: oldest, dormant, attempts: { ...this.counts }, slotHeldMs: held, runningMs }
  }

  /** Cancels every timer. An attempt already running finishes; nothing is
   * scheduled after it. */
  stop(): void {
    this.stopped = true
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  private slotFree(): boolean {
    return !(this.deps.slotHeld?.() ?? false)
  }

  /** The delay of the current step (advancing it). */
  private nextDelay(entry: Pending): number {
    const fast = entry.step < this.delaysMs.length
    let nominal: number
    if (fast) {
      nominal = this.delaysMs[entry.step]!
    } else {
      const index = Math.min(entry.step - this.delaysMs.length, this.backoffMs.length - 1)
      nominal = this.backoffMs[index]! * (1 + this.jitter * (2 * this.random() - 1))
    }
    entry.step += 1
    return Math.round(nominal)
  }

  /** How long the SHARED rest still forbids a build, ms (0: none). */
  private restLeft(): number {
    return Math.max(0, Math.ceil(this.restEnd - this.now()))
  }

  /** A build that held the slot `holdMs` just released it. */
  private extendRest(holdMs: number): void {
    this.restEnd = Math.max(this.restEnd, this.now() + Math.min(COMPACTION_REATTACH_REST_MAX_MS, this.restFactor * holdMs))
  }

  private schedule(entry: Pending, inMs: number): void {
    if (this.stopped) return
    entry.timer = setTimeout(() => {
      this.attempt(entry).catch((error: unknown) => {
        // Nothing in `attempt` is meant to throw; if something does, the
        // entry must not be left without a timer.
        entry.running = false
        this.failed(entry, `the attempt itself failed: ${describe(error)}`)
      })
    }, inMs)
    entry.timer.unref?.()
  }

  private dormant(entry: Pending, reason: DormantReason, cause: string): void {
    if (entry.state !== 'dormant' || entry.dormantReason !== reason) entry.dormantSince = this.now()
    entry.state = 'dormant'
    entry.dormantReason = reason
    this.log({
      event: 'read_model.compaction_reattach_dormant', workspace: keyOf(entry.key), reason, cause,
      attempts: entry.attempts, detachedMs: this.now() - entry.since,
    })
    this.schedule(entry, reason === 'not_owned' ? this.dormantCheckMs : this.noRootPeriodMs)
  }

  /**
   * Dormant → retried again from the fast phase. The outage's age neither
   * restarts nor counts a `not_owned` phase: it is
   * this cell's ACTIVE time detached. Restarting it would let a flapping
   * lease restart the alerts' windows; counting the dormant
   * phase would page a minute after a workspace another cell served for
   * hours comes back. A `no_root` phase counts: the read plane was down on
   * this cell all along.
   */
  private wake(entry: Pending, reason: 'owned_again' | 'reattach_failed_again'): void {
    if (entry.dormantReason === 'not_owned') entry.since += this.now() - entry.dormantSince
    entry.state = 'active'
    entry.dormantReason = null
    entry.step = 0
    entry.noRootStreak = 0
    entry.acquiredChecks = []
    this.warn({ event: 'read_model.compaction_reattach_pending', workspace: keyOf(entry.key), reason, detachedMs: this.now() - entry.since })
  }

  private abandon(entry: Pending, reason: CompactionReattachAbandon): void {
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(keyOf(entry.key))
    this.counts.abandoned += 1
    this.log({
      event: 'read_model.compaction_reattach_abandoned', workspace: keyOf(entry.key), reason,
      attempts: entry.attempts, detachedMs: this.now() - entry.since,
    })
  }

  private recovered(entry: Pending, by: 'retry' | 'already_resident', extra: { lift: boolean; heldMs?: number; buildMs?: number }): void {
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(keyOf(entry.key))
    if (by === 'retry') this.counts.attached += 1
    else this.counts.alreadyResident += 1
    // The fleet lifts the mark only for the start that passed `{ adopt: false }`;
    // a recovery by another start — including a retry whose `ensure` joined a
    // read's start already in flight — leaves it. Lifted here, a no-op when
    // already lifted, when no compaction pass holds the slot. That bounds,
    // without proving, that the build did not overlap a fold: a
    // read's start begun DURING a fold and resident after it is possible; its
    // projector follows the documents from then on, and any later adoption is
    // checked against durable heads.
    if (extra.lift) this.deps.fleet.liftCompactionDetached?.(entry.key)
    this.warn({
      event: 'read_model.compaction_reattach_recovered', workspace: keyOf(entry.key), by,
      attempts: entry.attempts, detachedMs: this.now() - entry.since,
      ...(extra.heldMs !== undefined ? { heldMs: extra.heldMs } : {}),
      ...(extra.buildMs !== undefined ? { buildMs: extra.buildMs } : {}),
    })
  }

  private async attempt(entry: Pending): Promise<void> {
    entry.timer = null
    const k = keyOf(entry.key)
    if (this.stopped || entry.running || this.pending.get(k) !== entry) return
    // OUTSIDE the slot first: nothing to queue for.
    if (this.deps.isShuttingDown()) return this.abandon(entry, 'shutting_down')
    if (!this.deps.owns(entry.key)) {
      if (entry.state === 'dormant' && entry.dormantReason === 'not_owned') {
        if (this.now() - entry.dormantSince >= this.notOwnedExpiryMs) return this.abandon(entry, 'not_owned_expired')
        return this.schedule(entry, entry.acquiredChecks.shift() ?? this.dormantCheckMs)
      }
      return this.dormant(entry, 'not_owned', 'owns() answered false before the attempt')
    }
    if (entry.state === 'dormant' && entry.dormantReason === 'not_owned') this.wake(entry, 'owned_again')
    if (this.deps.fleet.isResident(entry.key)) return this.recovered(entry, 'already_resident', { lift: this.slotFree() })
    if (entry.saturatedSkips < COMPACTION_REATTACH_MAX_SATURATED_SKIPS && (this.deps.storageSaturated?.() ?? false)) {
      entry.saturatedSkips += 1
      this.counts.skippedSaturated += 1
      const inMs = this.nextDelay(entry)
      this.log({ event: 'read_model.compaction_reattach_skipped', workspace: k, reason: 'storage_saturated', nextAttemptMs: inMs })
      return this.schedule(entry, inMs)
    }
    const resting = this.restLeft()
    if (resting > 0) return this.rest(entry, resting)
    entry.saturatedSkips = 0
    entry.running = true
    const askedAt = this.now()
    let heldMs = 0
    let buildMs: number | undefined
    let outcome: Outcome
    this.trace({ event: 'compaction_reattach.slot_wait', workspace: k })
    try {
      outcome = await this.deps.exclusive(async (): Promise<Outcome> => {
        const acquiredAt = this.now()
        this.trace({ event: 'compaction_reattach.slot_acquired', workspace: k, waitedMs: acquiredAt - askedAt })
        // The watchdog starts HERE: a retry queued behind a long
        // pass is waiting, not building, and must not raise Stuck.
        const unwatch = this.watchReattach(entry.key, 'retry')
        let rested = false
        try {
          // Re-asked UNDER the exclusion: the wait can have outlived the
          // supervisor, the process, the ownership, the outage or the rest
          // (another workspace's build may have run first).
          if (this.stopped || this.deps.isShuttingDown()) return 'shutting_down'
          if (!this.deps.owns(entry.key)) return 'not_owned'
          if (this.deps.fleet.isResident(entry.key)) return 'already_resident'
          if (this.restLeft() > 0) { rested = true; return 'resting' }
          const builtAt = this.now()
          // From the acquisition, as the released hold is:
          // the counter does not jump at the release.
          this.holdingSince = acquiredAt
          try {
            return (await this.deps.fleet.ensure(entry.key, { adopt: false })) ? 'attached' : 'no_root'
          } finally {
            buildMs = this.now() - builtAt
          }
        } finally {
          unwatch()
          heldMs = this.now() - acquiredAt
          if (buildMs !== undefined) {
            // Only a build feeds the shared rest and the held counter.
            this.holdingSince = null
            this.slotHeldMs += heldMs
            this.extendRest(heldMs)
          }
          // A hold that only found the rest in force is marked:
          // the slot's view in the trace file tells it from a build.
          this.trace({
            event: 'compaction_reattach.slot_released', workspace: k, heldMs,
            ...(buildMs !== undefined ? { buildMs } : {}), ...(rested ? { resting: true } : {}),
          })
        }
      })
    } catch (error) {
      entry.running = false
      if (this.pending.get(k) !== entry) return
      if (error instanceof ProjectorOwnershipError) return this.dormant(entry, 'not_owned', describe(error))
      if (error instanceof ProjectorStaticWorkspaceError) return this.abandon(entry, 'static_workspace')
      if (error instanceof ColdBuildAdmissionStoppedError || this.deps.isShuttingDown()) return this.abandon(entry, 'shutting_down')
      // Someone else re-attached it while this attempt failed (the slot may
      // already be another pass's).
      if (this.deps.fleet.isResident(entry.key)) return this.recovered(entry, 'already_resident', { lift: this.slotFree() })
      return this.failed(entry, describe(error), { heldMs, buildMs })
    }
    entry.running = false
    if (this.pending.get(k) !== entry) return
    // Asked under the slot (this supervisor held it): no pass was running.
    if (outcome === 'attached') return this.recovered(entry, 'retry', { lift: true, heldMs, buildMs })
    if (outcome === 'already_resident') return this.recovered(entry, 'already_resident', { lift: true, heldMs })
    if (outcome === 'not_owned') return this.dormant(entry, 'not_owned', 'owns() answered false under the slot')
    if (outcome === 'resting') return this.rest(entry, this.restLeft())
    if (outcome === 'no_root') return this.failed(entry, 'the workspace root did not resolve; no projector was started', { heldMs, buildMs, noRoot: true })
    return this.abandon(entry, outcome)
  }

  /** Postponed by the SHARED rest: not an attempt, the step unchanged. */
  private rest(entry: Pending, waitMs: number): void {
    this.log({ event: 'read_model.compaction_reattach_resting', workspace: keyOf(entry.key), waitMs })
    this.schedule(entry, Math.max(1, waitMs))
  }

  private failed(entry: Pending, error: string, extra: { heldMs?: number; buildMs?: number; noRoot?: boolean } = {}): void {
    entry.attempts += 1
    this.counts.failed += 1
    entry.noRootStreak = extra.noRoot ? entry.noRootStreak + 1 : 0
    if (extra.noRoot && entry.noRootStreak >= this.noRootLimit) {
      if (entry.state !== 'dormant') return this.dormant(entry, 'no_root', error)
      return this.schedule(entry, this.noRootPeriodMs)
    }
    if (entry.state === 'dormant') {
      // A dormant `no_root` workspace that resolves now and fails otherwise:
      // an ordinary outage again, retried from the fast phase.
      entry.state = 'active'
      entry.dormantReason = null
      entry.step = 0
    }
    const inMs = this.nextDelay(entry)
    this.warn({
      event: 'read_model.compaction_reattach_failed', workspace: keyOf(entry.key),
      attempt: entry.attempts, error, nextAttemptMs: inMs, detachedMs: this.now() - entry.since,
      ...(extra.heldMs !== undefined ? { heldMs: extra.heldMs } : {}),
      ...(extra.buildMs !== undefined ? { buildMs: extra.buildMs } : {}),
    })
    this.schedule(entry, inMs)
  }

  private trace(event: Record<string, unknown>): void {
    try { this.deps.trace?.(event) } catch { /* a trace must not throw into an attempt */ }
  }

  private log(event: Record<string, unknown>): void {
    try { (this.deps.log ?? ((e) => console.log(JSON.stringify(e))))(event) } catch { /* a trace must not throw into a timer */ }
  }

  private warn(event: Record<string, unknown>): void {
    try { (this.deps.warn ?? ((e) => console.warn(JSON.stringify(e))))(event) } catch { /* as above */ }
  }
}

/**
 * The supervisor as Prometheus samples. `null` (READ_MODEL off, or before
 * the compaction is wired): zeros — nothing can be left detached by a pass
 * that does not run. No workspace label: the log lines name it.
 */
export function compactionReattachMetricSamples(supervisor: Pick<CompactionReattachSupervisor, 'snapshot'> | null): MetricSample[] {
  const snap: CompactionReattachSnapshot = supervisor?.snapshot() ?? {
    detached: 0, oldestDetachedMs: 0, dormant: { not_owned: 0, no_root: 0 },
    attempts: { attached: 0, alreadyResident: 0, failed: 0, abandoned: 0, skippedSaturated: 0 }, slotHeldMs: 0, runningMs: 0,
  }
  const seconds = (ms: number) => Number((ms / 1000).toFixed(3))
  return [
    {
      name: 'maplespire_read_model_compaction_detached_workspaces',
      help: 'Workspaces a compaction pass left with their read plane DETACHED (the re-attach failed), owned by this cell and being retried. Zero is the healthy value.',
      type: 'gauge',
      values: [{ value: snap.detached }],
    },
    {
      name: 'maplespire_read_model_compaction_detached_oldest_seconds',
      help: 'How long the oldest of those workspaces has been detached, since its FIRST detachment (a dormant phase in between does not restart it); 0 when none. What the Pending and Outage alerts read.',
      type: 'gauge',
      values: [{ value: seconds(snap.oldestDetachedMs) }],
    },
    {
      name: 'maplespire_read_model_compaction_reattach_dormant',
      help: 'Detached workspaces not retried actively: not_owned (this cell does not own it now; re-armed when it does, dropped after 24 h), no_root (its root did not resolve several times; retried every 15 minutes).',
      type: 'gauge',
      values: [
        { labels: { reason: 'not_owned' }, value: snap.dormant.not_owned },
        { labels: { reason: 'no_root' }, value: snap.dormant.no_root },
      ],
    },
    {
      name: 'maplespire_read_model_compaction_reattach_attempts_total',
      help: 'Retried re-attaches after a failed compaction re-attach, by outcome: attached (the retry re-attached it), already_resident (another start did, a read or a pass), failed (retried later), abandoned (promoted to summary, shutting down, or not owned for 24 h), skipped_saturated (postponed: the storage write gate had callers queued).',
      type: 'counter',
      values: [
        { labels: { outcome: 'attached' }, value: snap.attempts.attached },
        { labels: { outcome: 'already_resident' }, value: snap.attempts.alreadyResident },
        { labels: { outcome: 'failed' }, value: snap.attempts.failed },
        { labels: { outcome: 'abandoned' }, value: snap.attempts.abandoned },
        { labels: { outcome: 'skipped_saturated' }, value: snap.attempts.skippedSaturated },
      ],
    },
    {
      name: 'maplespire_read_model_compaction_reattach_slot_held_seconds_total',
      help: 'Time the retried re-attaches held the compaction slot (the one the epoch sweep, the meta-only job and the hop latches wait for), since process start, the hold in progress included.',
      type: 'counter',
      values: [{ value: seconds(snap.slotHeldMs) }],
    },
    {
      name: 'maplespire_read_model_compaction_reattach_running_seconds',
      help: 'The longest compaction re-attach BUILD in flight now (the pass\'s own, or a retry\'s once it holds the slot); 0 when none. A cold build waiting on a lock does not fail: this is how it shows.',
      type: 'gauge',
      values: [{ value: seconds(snap.runningMs) }],
    },
  ]
}
