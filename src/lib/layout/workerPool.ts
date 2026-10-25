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

/** One worker of a pool: runs one job at a time, and can be killed. */
export interface PoolWorker<J, R> {
  run(job: J): Promise<R>
  terminate(): void
}

/** Rejected with by a worker that DIED (its script failed, a fatal error): the job
 *  did not fail on its own merit, so the pool runs it elsewhere — once. */
export class WorkerDiedError extends Error {}

/** Rejected with by {@link withDeadline} when the time ran out. */
export class DeadlineError extends Error {}

export interface WorkerPool<J, R> {
  run(job: J): Promise<R>
  /** False once every worker is gone — retired, or released after `idleMs` with
   *  nothing to do: jobs then go to the fallback. */
  readonly alive: boolean
}

export interface WorkerPoolOptions<J, R> {
  /** A fresh worker to take a retired one's place, up to `maxRespawns` times over
   *  the pool's life, resolved once it is READY (null when it cannot be had): it
   *  joins the pool only then, so no job waits on, or is blamed for, a worker
   *  still starting. Without it, every stuck or dead worker shrank the pool for
   *  good, and once the last went a whole run's queued jobs were dropped. */
  respawn?: () => Promise<PoolWorker<J, R> | null>
  maxRespawns?: number
  /** Terminate every worker once the pool has had nothing to do for this long… */
  idleMs?: number
  /** …unless this says no (asked when the time is up; asked again an `idleMs`
   *  later). */
  canRelease?: () => boolean
}

/**
 * Run jobs on a pool of workers, one job per worker at a time; the rest wait in
 * the pool's own queue, so a worker's deadline covers its own work only. Three
 * failures are told apart:
 *  - a job that REJECTS was answered — the worker is still answering: it rejects
 *    and the worker stays;
 *  - a worker that DIES (WorkerDiedError) is retired and the job goes back to the
 *    head of the queue, once — a job that kills a second worker rejects, so one
 *    poisonous job cannot retire them all;
 *  - a worker silent past the deadline is stuck: it is terminated and retired,
 *    and that job rejects with a DeadlineError (redoing it on the calling thread
 *    would freeze the page for as long).
 * A retired worker is replaced while `options.respawn` has budget left. Once every
 * worker is gone, jobs go to the fallback.
 */
export function createWorkerPool<J, R>(
  workers: readonly PoolWorker<J, R>[],
  fallback: (job: J) => Promise<R>,
  deadlineMs: number,
  options: WorkerPoolOptions<J, R> = {},
): WorkerPool<J, R> {
  const idle = [...workers]
  let live = workers.length
  let respawnsLeft = options.respawn ? options.maxRespawns ?? workers.length : 0
  const queue: Array<{ job: J; resolve: (r: R) => void; reject: (e: unknown) => void; requeued: boolean }> = []

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const stopIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const startIdleTimer = () => {
    if (options.idleMs === undefined || live === 0 || queue.length > 0 || idle.length < live) return
    stopIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (queue.length > 0 || idle.length < live) return
      if (options.canRelease && !options.canRelease()) {
        startIdleTimer()
        return
      }
      for (const worker of idle.splice(0)) worker.terminate()
      live = 0
    }, options.idleMs)
  }
  /** A retired worker's replacement once ready, or null when the budget is spent. */
  const replacement = (): Promise<PoolWorker<J, R> | null> | null => {
    if (respawnsLeft === 0 || !options.respawn) return null
    respawnsLeft--
    return attempt(() => options.respawn!()).catch(() => null)
  }
  const retire = () => {
    live--
    if (live === 0) drainToFallback()
  }

  const toFallback = (job: J) => attempt(() => fallback(job))
  const drainToFallback = () => {
    for (const entry of queue.splice(0)) toFallback(entry.job).then(entry.resolve, entry.reject)
  }
  const pump = () => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.shift()!
      const entry = queue.shift()!
      let stuck = false
      let died = false
      withDeadline(attempt(() => worker.run(entry.job)), deadlineMs, () => { stuck = true })
        .then(entry.resolve, (error: unknown) => {
          if (error instanceof WorkerDiedError && !stuck) {
            died = true
            if (entry.requeued) entry.reject(error)
            else queue.unshift({ ...entry, requeued: true })
          } else {
            entry.reject(error)
          }
        })
        .finally(() => {
          if (stuck || died) {
            worker.terminate()
            const fresh = replacement()
            console.warn(`[layout] a layout worker ${died ? 'died' : 'stopped answering'}; it was terminated${fresh ? ', replacing it' : ''}`)
            // Its slot stays counted while the replacement starts: the queue
            // waits for it (or for the other workers), and nothing is released.
            if (fresh) {
              void fresh.then((ready) => {
                if (ready) idle.push(ready)
                else retire()
                pump()
                startIdleTimer()
              })
            } else {
              retire()
            }
          } else {
            idle.push(worker)
          }
          pump()
          startIdleTimer()
        })
    }
  }
  return {
    run(job: J): Promise<R> {
      stopIdleTimer()
      if (live === 0) return toFallback(job)
      return new Promise<R>((resolve, reject) => {
        queue.push({ job, resolve, reject, requeued: false })
        pump()
      })
    },
    get alive() {
      return live > 0
    },
  }
}

/**
 * Prove each worker with `prove` and keep those that pass in time; the rest are
 * terminated. A worker whose script failed to load never answers — a deadline is
 * the only way to find out.
 */
export async function keepAnswering<J, R>(
  workers: readonly PoolWorker<J, R>[],
  prove: (worker: PoolWorker<J, R>) => Promise<void>,
  deadlineMs: number,
): Promise<PoolWorker<J, R>[]> {
  const answers = await Promise.allSettled(workers.map((w) => withDeadline(prove(w), deadlineMs)))
  const proven: PoolWorker<J, R>[] = []
  answers.forEach((answer, i) => {
    if (answer.status === 'fulfilled') proven.push(workers[i])
    else workers[i].terminate()
  })
  return proven
}

/** `start()`, with a synchronous throw turned into a rejection, so it rejects its
 *  job instead of escaping the pool's bookkeeping. */
function attempt<R>(start: () => Promise<R>): Promise<R> {
  try {
    return start()
  } catch (error) {
    return Promise.reject(error)
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, onExpired?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpired?.()
      reject(new DeadlineError(`no answer within ${ms} ms`))
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
