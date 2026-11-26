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

export interface ColdBuildAdmissionConfig {
  maxConcurrent: number
  maxQueued: number
}

export interface ColdBuildAdmissionSnapshot extends ColdBuildAdmissionConfig {
  active: number
  queued: number
  stopped: boolean
  started: number
  completed: number
  failed: number
  rejected: number
  cancelled: number
  maxObservedActive: number
  maxObservedQueued: number
}

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_QUEUED = 32

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum ? Math.min(value, maximum) : fallback
}

export function coldBuildAdmissionConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): ColdBuildAdmissionConfig {
  return {
    maxConcurrent: boundedInteger(env.READ_MODEL_MAX_COLD_BUILDS, DEFAULT_MAX_CONCURRENT, 1, 64),
    maxQueued: boundedInteger(env.READ_MODEL_MAX_COLD_BUILD_QUEUE, DEFAULT_MAX_QUEUED, 0, 10_000),
  }
}

export class ColdBuildQueueFullError extends Error {
  readonly code = 'read_model_cold_build_queue_full'
  readonly retryable = true

  constructor() {
    super('Read-model cold-build queue is full')
    this.name = 'ColdBuildQueueFullError'
  }
}

export class ColdBuildAdmissionStoppedError extends Error {
  readonly code = 'read_model_cold_build_admission_stopped'
  readonly retryable = false

  constructor() {
    super('Read-model cold-build admission is stopped')
    this.name = 'ColdBuildAdmissionStoppedError'
  }
}

interface QueuedJob<T> {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** Process-local FIFO admission control for expensive workspace cold starts.
 *
 * ProjectorFleet already single-flights one workspace. This controller handles
 * the other axis: many DIFFERENT cold workspaces arriving together. The queue
 * is bounded so authenticated workspace enumeration cannot retain an unbounded
 * number of closures or turn a database recovery into a cold-build stampede.
 */
export class ColdBuildAdmission {
  private readonly queue: Array<QueuedJob<unknown>> = []
  private active = 0
  private stopped = false
  private readonly counters = {
    started: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    maxObservedActive: 0,
    maxObservedQueued: 0,
  }

  constructor(private readonly config: ColdBuildAdmissionConfig = coldBuildAdmissionConfig()) {}

  /**
   * `options` (G4-16f C6-2b, the fleet's adopting starts):
   *  - `signal`: an abort while QUEUED removes the job from the queue (it no
   *    longer counts toward `maxQueued`, `cancelled` + 1) and rejects with
   *    the signal's reason; a job already running is not affected;
   *  - `exemptFromQueueLimit`: queued even when `maxQueued` is reached — for
   *    a caller whose number is bounded elsewhere (a claimed adopting start,
   *    bounded by the claims that committed), whose refusal here would waste
   *    work already done.
   */
  run<T>(task: () => Promise<T>, options: { signal?: AbortSignal; exemptFromQueueLimit?: boolean } = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new ColdBuildAdmissionStoppedError())
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (this.active < this.config.maxConcurrent) return this.start(task)
    if (!options.exemptFromQueueLimit && this.queue.length >= this.config.maxQueued) {
      this.counters.rejected += 1
      return Promise.reject(new ColdBuildQueueFullError())
    }

    return new Promise<T>((resolve, reject) => {
      const signal = options.signal
      const onAbort = () => {
        const at = this.queue.indexOf(job)
        if (at < 0) return
        this.queue.splice(at, 1)
        this.counters.cancelled += 1
        reject(signal!.reason)
      }
      const job: QueuedJob<unknown> = {
        run: task,
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value as T) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
      }
      this.queue.push(job)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.counters.maxObservedQueued = Math.max(this.counters.maxObservedQueued, this.queue.length)
    })
  }

  /** Reject queued work immediately. Active jobs cannot be force-cancelled, but
   * ProjectorFleet checks its stopped flag before registering their listeners. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const queued = this.queue.splice(0)
    this.counters.cancelled += queued.length
    const error = new ColdBuildAdmissionStoppedError()
    for (const job of queued) job.reject(error)
  }

  snapshot(): ColdBuildAdmissionSnapshot {
    return {
      ...this.config,
      active: this.active,
      queued: this.queue.length,
      stopped: this.stopped,
      ...this.counters,
    }
  }

  private start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1
    this.counters.started += 1
    this.counters.maxObservedActive = Math.max(this.counters.maxObservedActive, this.active)
    return Promise.resolve()
      .then(task)
      .then(
        (value) => {
          this.counters.completed += 1
          return value
        },
        (error: unknown) => {
          this.counters.failed += 1
          throw error
        }
      )
      .finally(() => {
        this.active -= 1
        this.drain()
      })
  }

  private drain(): void {
    while (!this.stopped && this.active < this.config.maxConcurrent) {
      const job = this.queue.shift()
      if (!job) return
      void this.start(job.run).then(job.resolve, job.reject)
    }
  }
}
