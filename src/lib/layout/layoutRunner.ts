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

import type { Diagram } from '../../types'
import type { Direction } from './engine'
import type { LayoutContext, LayoutSolution } from './graph'
import { STRATEGIES, type Strategy } from './elk/elkConfig'
import { createWorkerPool, keepAnswering, withDeadline, WorkerDiedError, type PoolWorker, type WorkerPool } from './workerPool'

/**
 * One auto-layout candidate, as plain data a worker can receive: an ELK
 * strategy, or the custom engine. Both are laid out, ROUTED and SCORED where they
 * run — the routing and scoring were the part of an Auto-layout still blocking
 * the page once ELK itself had moved to workers (main-thread gaps of ~0.4–0.7 s
 * on saoe DataverseComponents, dev build, measured 2026-10-22; none over 50 ms
 * before the result is written once they moved too).
 */
export type LayoutJob =
  | { kind: 'elk'; strategy: Strategy; diagram: Diagram; ctx: LayoutContext }
  | { kind: 'custom'; direction: Direction; diagram: Diagram; ctx: LayoutContext }

export interface LayoutJobMessage { id: number; job: LayoutJob }
export type LayoutJobAnswer =
  | { id: number; ok: true; solution: LayoutSolution | null }
  | { id: number; ok: false; error: string }

/** At most this many workers; one core stays free for the page itself. */
const MAX_WORKERS = 4
/** A chosen bound, not a measured one: the only measurement is a whole cold
 *  Structurizr import — four workers started and warmed up, fifteen views laid
 *  out — in 1.7 s (dev build, 2026-10-22). */
const WARMUP_DEADLINE_MS = 10_000
/** A worker that has spent this long on ONE candidate is presumed stuck. */
const JOB_DEADLINE_MS = 30_000
/** After a failed warm-up, the calling thread lays out until this has passed. */
const RETRY_AFTER_MS = 60_000
/** Workers are released after this long without a job, else up to four live for
 *  the page's whole life. scripts/layout-worker-heap.mjs (a Node worker_thread
 *  standing in for a Web Worker, 2026-10-25): ~31 MB of V8 heap once ELK is
 *  loaded, ~48 MB after laying out every saoe view with every strategy. The cost
 *  of coming back, measured live the same day: an Auto-layout on a pool built
 *  afresh after a release wrote its result in 467 ms, warm-up included (dev). */
const IDLE_MS = 60_000

const WARMUP_DIAGRAM = { id: 'warm-up', name: 'warm-up', type: 'container', objectIds: ['a', 'b'], connectionIds: ['e'], groupIds: [], layouts: {} } as unknown as Diagram
const WARMUP_CTX: LayoutContext = {
  objects: ['a', 'b'].map((id) => ({
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 60 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  })) as unknown as LayoutContext['objects'],
  connections: [{ id: 'e', fromId: 'a', toId: 'b', type: 'solid' }] as LayoutContext['connections'],
  groups: [],
}

/**
 * A worker is kept once it has laid the warm-up out with ELK AND answered the
 * job after it. Both halves were missing once: a two-node custom layout proved
 * workers that then went silent on their first ELK job, because loading elkjs
 * in a worker took the worker's messages (elkClient.ts).
 */
export async function proveWorker(worker: PoolWorker<LayoutJob, LayoutSolution | null>): Promise<void> {
  if (!(await worker.run({ kind: 'elk', strategy: STRATEGIES[0], diagram: WARMUP_DIAGRAM, ctx: WARMUP_CTX }))) {
    throw new Error('ELK did not lay the warm-up out')
  }
  await worker.run({ kind: 'custom', direction: 'tb', diagram: WARMUP_DIAGRAM, ctx: WARMUP_CTX })
}

type LayoutPool = WorkerPool<LayoutJob, LayoutSolution | null>

/** Jobs still queued when the last worker goes — the replacement budget spent —
 *  are dropped, not laid out here: the workers went because jobs hung or crashed
 *  them, and the same jobs on the calling thread would freeze or crash the page.
 *  The next Auto-layout starts a new pool. */
const noWorkerLeft = () => Promise.reject(new Error('no layout worker left'))

let creating: Promise<LayoutPool | null> | null = null
let settled: { pool: LayoutPool | null; at: number } | null = null

/**
 * The layout worker pool, created on first use and again once every worker of
 * the last one is gone — or null where workers are not available (Node, vitest,
 * a browser whose workers fail to start), in which case the caller lays out on
 * the calling thread exactly as before. A failed warm-up is retried after
 * RETRY_AFTER_MS (an offline page that could not fetch the worker chunk).
 */
export function layoutWorkerPool(): Promise<LayoutPool | null> {
  if (settled && (settled.pool ? settled.pool.alive : Date.now() - settled.at < RETRY_AFTER_MS)) {
    return Promise.resolve(settled.pool)
  }
  if (!creating) {
    settled = null
    creating = createPool()
      .catch(() => null)
      .then((pool) => {
        settled = { pool, at: Date.now() }
        creating = null
        return pool
      })
  }
  return creating
}

const spawnWorker = () => wrapWorker(new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' }))

/**
 * A replacement worker, proven by the same warm-up as the first ones BEFORE it
 * joins the pool — or null, terminated, when it fails. Proving it on its first
 * job instead blamed that job for the warm-up (a requeued job was then rejected)
 * and spent the job's deadline on it.
 */
export async function readyWorker(
  spawn: () => PoolWorker<LayoutJob, LayoutSolution | null> = spawnWorker,
): Promise<PoolWorker<LayoutJob, LayoutSolution | null> | null> {
  let worker: PoolWorker<LayoutJob, LayoutSolution | null>
  try {
    worker = spawn()
  } catch {
    return null
  }
  try {
    await withDeadline(proveWorker(worker), WARMUP_DEADLINE_MS)
    return worker
  } catch {
    worker.terminate()
    return null
  }
}

/** Released workers come back by fetching their chunk again: an offline page
 *  without it cached would lose them, so it keeps them. */
const canRelease = () => typeof navigator === 'undefined' || navigator.onLine !== false

async function createPool(): Promise<LayoutPool | null> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null
  const workers: PoolWorker<LayoutJob, LayoutSolution | null>[] = []
  try {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
    const size = Math.max(1, Math.min(MAX_WORKERS, cores - 1))
    for (let i = 0; i < size; i++) workers.push(spawnWorker())
  } catch (error) {
    for (const worker of workers) worker.terminate()
    console.warn('[layout] layout workers unavailable; laying out on the calling thread', error)
    return null
  }
  const proven = await keepAnswering(workers, proveWorker, WARMUP_DEADLINE_MS)
  if (proven.length === 0) {
    console.warn('[layout] no layout worker passed its warm-up; laying out on the calling thread')
    return null
  }
  return createWorkerPool(proven, noWorkerLeft, JOB_DEADLINE_MS, {
    respawn: () => readyWorker(),
    maxRespawns: workers.length,
    idleMs: IDLE_MS,
    canRelease,
  })
}

/** A Worker speaking LayoutJobMessage / LayoutJobAnswer, as a pool worker. */
export function wrapWorker(worker: Worker): PoolWorker<LayoutJob, LayoutSolution | null> {
  let sequence = 0
  let terminated = false
  const pending = new Map<number, { resolve: (s: LayoutSolution | null) => void; reject: (e: Error) => void }>()
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<LayoutJobAnswer>) => {
    const answer = event.data
    const entry = pending.get(answer.id)
    if (!entry) return
    pending.delete(answer.id)
    if (answer.ok) entry.resolve(answer.solution)
    else entry.reject(new Error(answer.error))
  }
  // A script that fails to load, a fatal error — or an error thrown outside any
  // job (the worker answers a job's own failure with `ok: false`; elkjs's GWT
  // scheduler rethrows its errors from a setTimeout). All are taken as the
  // worker's death: the pool terminates it and reruns the pending job once.
  worker.onerror = (event) => failAll(new WorkerDiedError(event.message || 'layout worker error'))
  return {
    run(job) {
      if (terminated) return Promise.reject(new Error('layout worker terminated'))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          worker.postMessage({ id, job } satisfies LayoutJobMessage)
        } catch (error) {
          // A job that cannot be cloned is its own failure: the worker never saw it.
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    terminate() {
      terminated = true
      worker.terminate()
      failAll(new Error('layout worker terminated'))
    },
  }
}
