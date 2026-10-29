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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkerPool, DeadlineError, keepAnswering, WorkerDiedError, type PoolWorker } from './workerPool'

type Job = { id: string }
type Result = { id: string; by?: string }

/** A fake worker whose jobs settle only when the test says so. */
function fakeWorker(name = 'w') {
  const pending: Array<{ job: Job; resolve: (r: Result) => void; reject: (e: Error) => void }> = []
  const worker: PoolWorker<Job, Result> & { terminated: boolean } = {
    terminated: false,
    run: (job) => new Promise((resolve, reject) => pending.push({ job, resolve, reject })),
    terminate() { this.terminated = true },
  }
  return { worker, pending, name }
}

const job = (id: string): Job => ({ id })
const inThread = vi.fn(async (j: Job): Promise<Result> => ({ id: j.id, by: 'calling thread' }))

describe('createWorkerPool — layout workers with a calling-thread fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    inThread.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('gives each worker one job at a time, the rest wait in the pool', async () => {
    const a = fakeWorker()
    const b = fakeWorker()
    const pool = createWorkerPool([a.worker, b.worker], inThread, 30_000)
    const runs = ['j1', 'j2', 'j3'].map((id) => pool.run(job(id)))
    expect(a.pending.map((p) => p.job.id)).toEqual(['j1'])
    expect(b.pending.map((p) => p.job.id)).toEqual(['j2'])
    a.pending[0].resolve({ id: 'j1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.pending.map((p) => p.job.id)).toEqual(['j1', 'j3'])
    a.pending[1].resolve({ id: 'j3' })
    b.pending[0].resolve({ id: 'j2' })
    expect(await Promise.all(runs)).toEqual([{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }])
  })

  it('times a job from when its worker STARTS it, not from when it was queued', async () => {
    const a = fakeWorker()
    const pool = createWorkerPool([a.worker], inThread, 30_000)
    const first = pool.run(job('j1'))
    const second = pool.run(job('j2'))
    await vi.advanceTimersByTimeAsync(25_000)
    a.pending[0].resolve({ id: 'j1' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000) // 45 s after queueing, 20 s of its own work
    a.pending[1].resolve({ id: 'j2' })
    expect(await first).toEqual({ id: 'j1' })
    expect(await second).toEqual({ id: 'j2' })
    expect(a.worker.terminated).toBe(false)
  })

  it('passes a job\'s own failure through and keeps the worker', async () => {
    const a = fakeWorker()
    const pool = createWorkerPool([a.worker], inThread, 30_000)
    const bad = pool.run(job('bad'))
    a.pending[0].reject(new Error('unsupported graph'))
    await expect(bad).rejects.toThrow('unsupported graph')
    const next = pool.run(job('j2'))
    await vi.advanceTimersByTimeAsync(0)
    expect(a.pending.map((p) => p.job.id)).toEqual(['bad', 'j2'])
    a.pending[1].resolve({ id: 'j2' })
    expect(await next).toEqual({ id: 'j2' })
    expect(a.worker.terminated).toBe(false)
    expect(inThread).not.toHaveBeenCalled()
  })

  it('retires a worker that DIED and runs its job elsewhere', async () => {
    const a = fakeWorker()
    const b = fakeWorker()
    const pool = createWorkerPool([a.worker, b.worker], inThread, 30_000)
    const first = pool.run(job('j1'))
    const second = pool.run(job('j2'))
    a.pending[0].reject(new WorkerDiedError('script failed'))
    b.pending[0].resolve({ id: 'j2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.worker.terminated).toBe(true)
    // j1 never ran: it went back to the queue and the surviving worker took it.
    expect(b.pending.map((p) => p.job.id)).toEqual(['j2', 'j1'])
    b.pending[1].resolve({ id: 'j1', by: 'b' })
    expect(await first).toEqual({ id: 'j1', by: 'b' })
    expect(await second).toEqual({ id: 'j2' })
  })

  it('terminates a stuck worker, drops its job, and falls back once none is left', async () => {
    const a = fakeWorker()
    const pool = createWorkerPool([a.worker], inThread, 1_000)
    const stuck = pool.run(job('j1'))
    const queued = pool.run(job('j2'))
    const settled = Promise.allSettled([stuck])
    await vi.advanceTimersByTimeAsync(1_001)
    const [outcome] = await settled
    expect(outcome.status === 'rejected' && outcome.reason).toBeInstanceOf(DeadlineError)
    expect(a.worker.terminated).toBe(true)
    expect(pool.alive).toBe(false)
    expect(await queued).toEqual({ id: 'j2', by: 'calling thread' })
    expect(await pool.run(job('j3'))).toEqual({ id: 'j3', by: 'calling thread' })
  })

  it('reruns a job whose worker died once only: a job that kills a second worker rejects', async () => {
    const [a, b, c] = [fakeWorker(), fakeWorker(), fakeWorker()]
    const pool = createWorkerPool([a.worker, b.worker, c.worker], inThread, 30_000)
    const poison = pool.run(job('poison'))
    const outcome = Promise.allSettled([poison])
    a.pending[0].reject(new WorkerDiedError('killed by poison'))
    await vi.advanceTimersByTimeAsync(0)
    expect(b.pending.map((p) => p.job.id)).toEqual(['poison'])
    b.pending[0].reject(new WorkerDiedError('killed by poison again'))
    await vi.advanceTimersByTimeAsync(0)
    expect((await outcome)[0].status).toBe('rejected')
    expect(c.pending).toEqual([])
    expect(c.worker.terminated).toBe(false)
    expect(pool.alive).toBe(true)
  })

  // Review lenses, 2026-10-25: retired workers were never replaced, so a pool
  // losing its workers mid-run took a whole Auto-layout's queued jobs and dropped
  // them, and every later Auto-layout ran on a shrunken pool.
  it('replaces a retired worker while its budget lasts, then lets the pool shrink', async () => {
    const a = fakeWorker()
    const spares = [fakeWorker(), fakeWorker()]
    let spawned = 0
    const pool = createWorkerPool([a.worker], inThread, 1_000, { respawn: async () => spares[spawned++].worker, maxRespawns: 1 })
    const stuck = Promise.allSettled([pool.run(job('j1'))])
    const queued = pool.run(job('j2'))
    await vi.advanceTimersByTimeAsync(1_001)
    await vi.advanceTimersByTimeAsync(0)
    expect((await stuck)[0].status).toBe('rejected')
    expect(a.worker.terminated).toBe(true)
    expect(spares[0].pending.map((p) => p.job.id)).toEqual(['j2'])
    spares[0].pending[0].resolve({ id: 'j2', by: 'replacement' })
    expect(await queued).toEqual({ id: 'j2', by: 'replacement' })
    expect(pool.alive).toBe(true)
    const again = Promise.allSettled([pool.run(job('j3'))])
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await again)[0].status).toBe('rejected')
    expect(spawned).toBe(1)
    expect(pool.alive).toBe(false)
  })

  it('keeps the slot while a replacement starts, and lets the pool shrink when none can be had', async () => {
    const a = fakeWorker()
    const b = fakeWorker()
    let ready: (w: PoolWorker<Job, Result> | null) => void = () => undefined
    const pool = createWorkerPool([a.worker, b.worker], inThread, 1_000, { respawn: () => new Promise((r) => { ready = r }), idleMs: 500 })
    const stuck = Promise.allSettled([pool.run(job('j1'))])
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await stuck)[0].status).toBe('rejected')
    await vi.advanceTimersByTimeAsync(5_000)
    // b is idle and nothing is queued, but the starting replacement holds a slot:
    // the pool is not released under it.
    expect(b.worker.terminated).toBe(false)
    expect(pool.alive).toBe(true)
    ready(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.alive).toBe(true)
    const next = pool.run(job('j2'))
    expect(b.pending.map((p) => p.job.id)).toEqual(['j2'])
    b.pending[0].resolve({ id: 'j2' })
    expect(await next).toEqual({ id: 'j2' })
  })

  it('does not release its workers while canRelease says no', async () => {
    const a = fakeWorker()
    let online = false
    const pool = createWorkerPool([a.worker], inThread, 30_000, { idleMs: 1_000, canRelease: () => online })
    const first = pool.run(job('j1'))
    a.pending[0].resolve({ id: 'j1' })
    await first
    await vi.advanceTimersByTimeAsync(5_000)
    expect(a.worker.terminated).toBe(false)
    online = true
    await vi.advanceTimersByTimeAsync(1_001)
    expect(a.worker.terminated).toBe(true)
    expect(pool.alive).toBe(false)
  })

  it('releases its workers once idle for idleMs, and a job before then keeps them', async () => {
    const a = fakeWorker()
    const pool = createWorkerPool([a.worker], inThread, 30_000, { idleMs: 60_000 })
    const first = pool.run(job('j1'))
    a.pending[0].resolve({ id: 'j1' })
    await first
    await vi.advanceTimersByTimeAsync(59_000)
    const second = pool.run(job('j2'))
    a.pending[1].resolve({ id: 'j2' })
    await second
    await vi.advanceTimersByTimeAsync(59_000)
    expect(a.worker.terminated).toBe(false)
    expect(pool.alive).toBe(true)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(a.worker.terminated).toBe(true)
    expect(pool.alive).toBe(false)
  })

  it('rejects the job of a worker that throws synchronously, and keeps the worker', async () => {
    let calls = 0
    const throwing: PoolWorker<Job, Result> & { terminated: boolean } = {
      terminated: false,
      run: (j) => {
        calls++
        if (j.id === 'bad') throw new Error('threw before answering')
        return Promise.resolve({ id: j.id })
      },
      terminate() { this.terminated = true },
    }
    const pool = createWorkerPool([throwing], inThread, 30_000)
    await expect(pool.run(job('bad'))).rejects.toThrow('threw before answering')
    expect(await pool.run(job('j2'))).toEqual({ id: 'j2' })
    expect(calls).toBe(2)
    expect(throwing.terminated).toBe(false)
  })
})

describe('keepAnswering — the warm-up', () => {
  const twoProbes = async (w: PoolWorker<Job, Result>) => {
    await w.run(job('probe-1'))
    await w.run(job('probe-2'))
  }

  it('keeps the workers that pass and terminates the silent ones', async () => {
    vi.useFakeTimers()
    try {
      const ok = fakeWorker()
      const silent = fakeWorker()
      const proving = keepAnswering([ok.worker, silent.worker], twoProbes, 5_000)
      ok.pending[0].resolve({ id: 'probe-1' })
      await vi.advanceTimersByTimeAsync(0)
      ok.pending[1].resolve({ id: 'probe-2' })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(await proving).toEqual([ok.worker])
      expect(silent.worker.terminated).toBe(true)
      expect(ok.worker.terminated).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates a worker that answers its first probe and goes silent on the next', async () => {
    vi.useFakeTimers()
    try {
      const once = fakeWorker()
      const proving = keepAnswering([once.worker], twoProbes, 5_000)
      once.pending[0].resolve({ id: 'probe-1' })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(once.pending.map((p) => p.job.id)).toEqual(['probe-1', 'probe-2'])
      expect(await proving).toEqual([])
      expect(once.worker.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
