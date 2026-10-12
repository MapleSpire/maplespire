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

import {
  classifyDocumentResolutionError,
  type DocumentResolutionOutcome,
} from './documentResolution.js'

/**
 * Bounded retry scheduler for documents a workspace references but has not
 * received yet.
 *
 * The failure mode this prevents: one `setTimeout` and one independent retry
 * loop per missing document, where a registry holding a thousand unresolvable
 * references owns a thousand live timers and can run a thousand concurrent
 * `repo.find()` calls, each re-entering the repo's find machinery.
 *
 * Invariants:
 *  - one entry per document URL (dedup by URL, never scheduled twice);
 *  - at most `maxConcurrent` resolutions in flight for the whole workspace;
 *  - at most `maxPending` tracked documents — beyond that new work is rejected
 *    and counted, never silently queued;
 *  - EXACTLY ONE wake timer per queue, always armed for the earliest due entry;
 *  - exponential backoff with jitter, and a wall-clock deadline per document;
 *  - a document that stops being referenced is dropped immediately;
 *  - `stop()` (projector stopped, evicted, ownership lost) cancels everything
 *    and aborts the signal handed to in-flight tasks.
 *
 * Only a genuinely unavailable document is retried. A task that fails for any
 * other reason — a PostgreSQL outage, a projection bug — is abandoned here and
 * reported to the owner, because retrying document resolution cannot fix it.
 */

export interface DocumentRetryQueueConfig {
  maxConcurrent: number
  maxPending: number
  baseDelayMs: number
  maxDelayMs: number
  /** Fractional jitter applied to each delay, e.g. 0.2 for ±20%. */
  jitterRatio: number
  /** Wall-clock budget per document, from its first scheduling. */
  deadlineMs: number
}

export type DocumentRetryAbandonReason =
  /** Exhausted its wall-clock budget while still unavailable. */
  | 'deadline'
  /** Used every allowed attempt. */
  | 'exhausted'
  /** Deleted document or malformed URL — it can never resolve. */
  | 'invalid'
  /** Failed for a non-resolution reason (PostgreSQL, projection). Not retried. */
  | 'unexpected'
  /** No longer referenced by the workspace. */
  | 'dropped'
  /** The queue was stopped: projector shutdown, eviction or ownership loss. */
  | 'stopped'

const ABANDON_REASONS: readonly DocumentRetryAbandonReason[] = [
  'deadline', 'exhausted', 'invalid', 'unexpected', 'dropped', 'stopped',
]

export interface DocumentRetryOptions {
  /** Attempts allowed before abandoning as `exhausted`. Unlimited by default —
   * `deadlineMs` is then the only bound. */
  maxAttempts?: number
  /** Decides whether a failure earns another attempt. Defaults to retrying only
   * a genuinely unavailable document; a bounded reprojection can opt in to
   * retrying projection faults too. */
  retryOn?: (error: unknown, outcome: DocumentResolutionOutcome) => boolean
}

const RETRY_ONLY_UNAVAILABLE = (_error: unknown, outcome: DocumentResolutionOutcome): boolean =>
  outcome === 'unavailable'

export interface DocumentRetryQueueSnapshot extends DocumentRetryQueueConfig {
  /** Documents currently tracked (waiting or in flight). */
  pendingDepth: number
  maxPendingDepth: number
  activeResolutions: number
  maxActiveResolutions: number
  /** Expected to be 0 or 1: the single wake timer. */
  activeTimers: number
  scheduled: number
  retries: number
  resolved: number
  abandoned: Record<DocumentRetryAbandonReason, number>
  /** Documents refused because `maxPending` was already reached. */
  rejectedOverCapacity: number
  maxTimeToAvailableMs: number
  lastTimeToAvailableMs: number | null
  stopped: boolean
}

/** Runs one resolution attempt. Rejecting with an unavailable-document error
 * asks for another attempt; any other rejection abandons the document. */
export type DocumentRetryTask = (signal: AbortSignal) => Promise<void>

export interface DocumentRetryQueueDeps {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Injectable for deterministic jitter in tests. */
  random?: () => number
  /** Stops the queue when the owning projector is torn down. */
  signal?: AbortSignal
  onAbandon?: (url: string, reason: DocumentRetryAbandonReason, error: unknown) => void
  /**
   * The queue has nothing left: no entry waiting and no resolution in flight.
   *
   * The workspace's health depends on this, not only on `onAbandon`. A document
   * that is merely QUEUED is outstanding work — the read model is incomplete
   * while it waits — so nothing may report the workspace healthy until the queue
   * is empty, and the last document to leave has to say so. `onAbandon` alone
   * cannot: it never fires on the path where every document eventually resolves.
   */
  onIdle?: () => void
}

const DEFAULTS: DocumentRetryQueueConfig = {
  maxConcurrent: 4,
  maxPending: 512,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  deadlineMs: 120_000,
}

function boundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= minimum ? Math.min(value, maximum) : fallback
}

export function documentRetryQueueConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DocumentRetryQueueConfig {
  return {
    maxConcurrent: boundedNumber(env.READ_MODEL_DOC_RETRY_CONCURRENCY, DEFAULTS.maxConcurrent, 1, 64),
    maxPending: boundedNumber(env.READ_MODEL_DOC_RETRY_MAX_PENDING, DEFAULTS.maxPending, 1, 100_000),
    baseDelayMs: boundedNumber(env.READ_MODEL_DOC_RETRY_BASE_MS, DEFAULTS.baseDelayMs, 1, 60_000),
    // READ_MODEL_DIAGRAM_RETRY_MS is a legacy alias of this knob.
    maxDelayMs: boundedNumber(
      env.READ_MODEL_DOC_RETRY_MAX_MS ?? env.READ_MODEL_DIAGRAM_RETRY_MS,
      DEFAULTS.maxDelayMs, 1, 600_000,
    ),
    jitterRatio: boundedNumber(env.READ_MODEL_DOC_RETRY_JITTER, DEFAULTS.jitterRatio, 0, 1),
    deadlineMs: boundedNumber(env.READ_MODEL_DOC_RETRY_DEADLINE_MS, DEFAULTS.deadlineMs, 0, 3_600_000),
  }
}

interface Entry {
  url: string
  task: DocumentRetryTask
  /** Failed attempts so far; drives the backoff exponent. */
  attempts: number
  maxAttempts: number
  retryOn: (error: unknown, outcome: DocumentResolutionOutcome) => boolean
  dueAtMs: number
  firstScheduledAtMs: number
  running: boolean
}

export class DocumentRetryQueue {
  private readonly config: DocumentRetryQueueConfig
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly random: () => number
  private readonly onAbandon?: (url: string, reason: DocumentRetryAbandonReason, error: unknown) => void
  private readonly onIdle?: () => void
  private readonly controller = new AbortController()
  private readonly ownerSignal?: AbortSignal
  private readonly onOwnerAbort = () => this.stop()

  /** Insertion-ordered: a rescheduled entry is re-inserted at the back, so a
   * long backlog cannot starve the documents behind it. */
  private readonly entries = new Map<string, Entry>()
  private timer: unknown = null
  private timerDueAtMs = Number.POSITIVE_INFINITY
  private active = 0
  private stopped = false
  private readonly counters = {
    scheduled: 0,
    retries: 0,
    resolved: 0,
    rejectedOverCapacity: 0,
    maxPendingDepth: 0,
    maxActiveResolutions: 0,
    maxTimeToAvailableMs: 0,
    lastTimeToAvailableMs: null as number | null,
  }
  private readonly abandoned: Record<DocumentRetryAbandonReason, number> = {
    deadline: 0, exhausted: 0, invalid: 0, unexpected: 0, dropped: 0, stopped: 0,
  }

  constructor(config: Partial<DocumentRetryQueueConfig> = {}, deps: DocumentRetryQueueDeps = {}) {
    this.config = { ...documentRetryQueueConfig(), ...config }
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return handle
    })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.random = deps.random ?? Math.random
    this.onAbandon = deps.onAbandon
    this.onIdle = deps.onIdle
    this.ownerSignal = deps.signal
    if (this.ownerSignal?.aborted) this.stopped = true
    else this.ownerSignal?.addEventListener('abort', this.onOwnerAbort, { once: true })
  }

  /** Signal handed to tasks; aborted by `stop()`. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get pendingDepth(): number {
    return this.entries.size
  }

  has(url: string): boolean {
    return this.entries.has(url)
  }

  /**
   * Track `url` for bounded retries. Returns false when it is already tracked
   * (dedup), when the queue is stopped, or when `maxPending` is reached — the
   * caller learns the document was refused instead of assuming it is pending.
   */
  schedule(url: string, task: DocumentRetryTask, options: DocumentRetryOptions = {}): boolean {
    if (this.stopped || this.entries.has(url)) return false
    if (this.entries.size >= this.config.maxPending) {
      this.counters.rejectedOverCapacity += 1
      return false
    }
    const nowMs = this.now()
    this.entries.set(url, {
      url,
      task,
      attempts: 0,
      maxAttempts: Math.max(1, options.maxAttempts ?? Number.POSITIVE_INFINITY),
      retryOn: options.retryOn ?? RETRY_ONLY_UNAVAILABLE,
      dueAtMs: nowMs + this.delayFor(0),
      firstScheduledAtMs: nowMs,
      running: false,
    })
    this.counters.scheduled += 1
    this.counters.maxPendingDepth = Math.max(this.counters.maxPendingDepth, this.entries.size)
    this.pump()
    return true
  }

  /** Drop a document that is no longer referenced. An in-flight attempt is
   * left to finish, but its result is discarded and never rescheduled. */
  forget(url: string): void {
    const entry = this.entries.get(url)
    if (!entry) return
    this.entries.delete(url)
    this.abandoned.dropped += 1
    this.onAbandon?.(url, 'dropped', undefined)
    this.armTimer()
    // NO `notifyIfIdle()` here, deliberately.
    //
    // Dropping the last WAITING entry does empty the queue — but the only caller
    // is `retain()`, and the only caller of THAT is `reconcileDiagramDocs`,
    // which drops the unreferenced urls and then immediately re-attaches the
    // referenced ones. An idle report in that gap is a lie with a plausible
    // shape: registry swaps diagram A for diagram B, `retain` drops A, the queue
    // is momentarily empty, health is published and LATCHED — and B, whose
    // document has not synced either, is queued a millisecond later. The row
    // claims healthy with a document outstanding until the queue's 120 s wall
    // clock abandons it.
    //
    // Nothing is lost by omitting it: `reconcileDiagramDocs` ends with a health
    // call, after the re-attach, which is the same edge reported at a moment
    // when it is actually true. The mid-flight case is different and does need
    // its own notify — see `settle()`.
  }

  /** Keep only the documents the workspace still references. */
  retain(referenced: ReadonlySet<string>): void {
    for (const url of [...this.entries.keys()]) {
      if (!referenced.has(url)) this.forget(url)
    }
  }

  /** Cancel everything: no timer survives, no further attempt is started, and
   * in-flight tasks observe an aborted signal. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.ownerSignal?.removeEventListener('abort', this.onOwnerAbort)
    this.disarmTimer()
    const cancelled = [...this.entries.values()]
    this.entries.clear()
    this.abandoned.stopped += cancelled.length
    for (const entry of cancelled) this.onAbandon?.(entry.url, 'stopped', undefined)
    this.controller.abort()
  }

  snapshot(): DocumentRetryQueueSnapshot {
    return {
      ...this.config,
      pendingDepth: this.entries.size,
      activeResolutions: this.active,
      activeTimers: this.timer === null ? 0 : 1,
      abandoned: { ...this.abandoned },
      stopped: this.stopped,
      ...this.counters,
    }
  }

  /** Exponential backoff with ±jitterRatio, capped at `maxDelayMs`. */
  private delayFor(attempts: number): number {
    const exponential = Math.min(
      this.config.maxDelayMs,
      this.config.baseDelayMs * 2 ** Math.min(attempts, 30),
    )
    const jitter = 1 + (this.random() * 2 - 1) * this.config.jitterRatio
    return Math.max(0, Math.round(exponential * jitter))
  }

  /** Start every due entry the concurrency budget allows, then re-arm the
   * single wake timer for whatever remains. */
  private pump(): void {
    if (this.stopped) return
    const nowMs = this.now()
    for (const entry of [...this.entries.values()]) {
      if (this.active >= this.config.maxConcurrent) break
      if (entry.running || entry.dueAtMs > nowMs) continue
      this.run(entry)
    }
    this.armTimer()
  }

  private run(entry: Entry): void {
    entry.running = true
    this.active += 1
    this.counters.maxActiveResolutions = Math.max(this.counters.maxActiveResolutions, this.active)
    void Promise.resolve()
      .then(() => entry.task(this.controller.signal))
      .then(
        () => this.settle(entry, null),
        (error: unknown) => this.settle(entry, error ?? new Error('document retry task failed')),
      )
  }

  private settle(entry: Entry, error: unknown): void {
    this.active -= 1
    entry.running = false
    // Dropped, or the queue stopped, while this attempt was in flight. The
    // slot it held is still released, so waiting documents can start.
    if (this.stopped) return
    // Dropped (or replaced) while this attempt was in flight. `forget()` already
    // fired `onAbandon`, but it could not report the queue idle because THIS
    // attempt was still counted in `active` — so the idle edge belongs here.
    if (this.entries.get(entry.url) !== entry) { this.pump(); this.notifyIfIdle(); return }

    if (error === null) {
      this.entries.delete(entry.url)
      this.counters.resolved += 1
      const elapsed = Math.max(0, this.now() - entry.firstScheduledAtMs)
      this.counters.lastTimeToAvailableMs = elapsed
      this.counters.maxTimeToAvailableMs = Math.max(this.counters.maxTimeToAvailableMs, elapsed)
      this.pump()
      this.notifyIfIdle()
      return
    }

    const outcome = classifyDocumentResolutionError(error)
    if (outcome === 'aborted') { this.abandon(entry, 'stopped', error); return }
    if (!entry.retryOn(error, outcome)) {
      // By default a PostgreSQL outage or an unexpected fault is never retried
      // as a document resolution: another `repo.find()` cannot repair it.
      this.abandon(entry, outcome === 'invalid' ? 'invalid' : 'unexpected', error)
      return
    }
    if (this.now() - entry.firstScheduledAtMs >= this.config.deadlineMs) {
      this.abandon(entry, 'deadline', error)
      return
    }
    if (entry.attempts + 1 >= entry.maxAttempts) {
      this.abandon(entry, 'exhausted', error)
      return
    }

    entry.attempts += 1
    entry.dueAtMs = this.now() + this.delayFor(entry.attempts)
    this.counters.retries += 1
    // Re-insert at the back so a large backlog stays fair.
    this.entries.delete(entry.url)
    this.entries.set(entry.url, entry)
    this.pump()
  }

  private abandon(entry: Entry, reason: DocumentRetryAbandonReason, error: unknown): void {
    this.entries.delete(entry.url)
    this.abandoned[reason] += 1
    this.onAbandon?.(entry.url, reason, error)
    this.pump()
    this.notifyIfIdle()
  }

  /** AFTER `pump()`, never before: pump may start the next entry, and an idle
   * report issued while work is about to begin is exactly the premature
   * all-clear this callback exists to prevent. */
  private notifyIfIdle(): void {
    if (this.stopped || this.entries.size > 0 || this.active > 0) return
    this.onIdle?.()
  }

  /** Exactly one timer, always armed for the earliest waiting entry. */
  private armTimer(): void {
    if (this.stopped) return
    let earliest = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      if (!entry.running && entry.dueAtMs < earliest) earliest = entry.dueAtMs
    }
    if (earliest === Number.POSITIVE_INFINITY) {
      this.disarmTimer()
      return
    }
    // An already-armed timer that fires no later than the new earliest entry
    // will pump and re-arm on its own; replacing it would only churn.
    if (this.timer !== null && this.timerDueAtMs <= earliest) return
    this.disarmTimer()
    this.timerDueAtMs = earliest
    this.timer = this.setTimer(() => {
      this.timer = null
      this.timerDueAtMs = Number.POSITIVE_INFINITY
      this.pump()
    }, Math.max(0, earliest - this.now()))
  }

  private disarmTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.timerDueAtMs = Number.POSITIVE_INFINITY
  }
}

/**
 * Process-wide aggregate of every live queue. Individual workspace keys are
 * deliberately not exposed: the platform endpoint reports fleet-level pressure,
 * not tenant activity.
 */
export class DocumentRetryRegistry {
  private readonly queues = new Set<DocumentRetryQueue>()

  register(queue: DocumentRetryQueue): () => void {
    this.queues.add(queue)
    return () => { this.queues.delete(queue) }
  }

  size(): number {
    return this.queues.size
  }

  snapshot(): {
    queues: number
    pendingDepth: number
    maxPendingDepth: number
    activeResolutions: number
    maxActiveResolutions: number
    activeTimers: number
    scheduled: number
    retries: number
    resolved: number
    rejectedOverCapacity: number
    maxTimeToAvailableMs: number
    abandoned: Record<DocumentRetryAbandonReason, number>
  } {
    const abandoned = Object.fromEntries(
      ABANDON_REASONS.map((reason) => [reason, 0]),
    ) as Record<DocumentRetryAbandonReason, number>
    const total = {
      queues: this.queues.size,
      pendingDepth: 0,
      maxPendingDepth: 0,
      activeResolutions: 0,
      maxActiveResolutions: 0,
      activeTimers: 0,
      scheduled: 0,
      retries: 0,
      resolved: 0,
      rejectedOverCapacity: 0,
      maxTimeToAvailableMs: 0,
      abandoned,
    }
    for (const queue of this.queues) {
      const snapshot = queue.snapshot()
      total.pendingDepth += snapshot.pendingDepth
      total.maxPendingDepth = Math.max(total.maxPendingDepth, snapshot.maxPendingDepth)
      total.activeResolutions += snapshot.activeResolutions
      total.maxActiveResolutions = Math.max(total.maxActiveResolutions, snapshot.maxActiveResolutions)
      total.activeTimers += snapshot.activeTimers
      total.scheduled += snapshot.scheduled
      total.retries += snapshot.retries
      total.resolved += snapshot.resolved
      total.rejectedOverCapacity += snapshot.rejectedOverCapacity
      total.maxTimeToAvailableMs = Math.max(total.maxTimeToAvailableMs, snapshot.maxTimeToAvailableMs)
      for (const reason of ABANDON_REASONS) abandoned[reason] += snapshot.abandoned[reason]
    }
    return total
  }
}

/** Production registry shared by every workspace projector in this process. */
export const documentRetryRegistry = new DocumentRetryRegistry()
