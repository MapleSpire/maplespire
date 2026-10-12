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

import { describe, it, expect, vi } from 'vitest'
import {
  DocumentRetryQueue,
  DocumentRetryRegistry,
  documentRetryQueueConfig,
  type DocumentRetryAbandonReason,
} from './documentRetryQueue.js'

/**
 * Deterministic clock + timer. The production queue must own EXACTLY ONE timer,
 * so the harness records every arm/disarm and asserts on the live count rather
 * than on wall-clock behaviour.
 */
function harness() {
  let nowMs = 0
  let nextId = 1
  const live = new Map<number, { dueAtMs: number; fire: () => void }>()
  let armed = 0
  return {
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number) => {
      armed += 1
      const id = nextId++
      live.set(id, { dueAtMs: nowMs + ms, fire: fn })
      return id
    },
    clearTimer: (handle: unknown) => { live.delete(handle as number) },
    /** Timers currently armed — the invariant under test. */
    liveTimers: () => live.size,
    /** Total timers ever armed, to catch per-document timer regressions. */
    armedTimers: () => armed,
    /** Advance the clock and fire everything that came due, like a real loop. */
    async advance(ms: number) {
      const target = nowMs + ms
      for (;;) {
        let nextDue = Number.POSITIVE_INFINITY
        let nextId2: number | null = null
        for (const [id, timer] of live) {
          if (timer.dueAtMs < nextDue) { nextDue = timer.dueAtMs; nextId2 = id }
        }
        if (nextId2 === null || nextDue > target) break
        nowMs = Math.max(nowMs, nextDue)
        const timer = live.get(nextId2)!
        live.delete(nextId2)
        timer.fire()
        await flush()
      }
      nowMs = target
      await flush()
    },
    tick(ms: number) { nowMs += ms },
  }
}

/** Let queued microtasks (the task promises) settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const unavailable = () => new Error('Document abc is unavailable')

function queueWith(
  config: Parameters<typeof DocumentRetryQueue.prototype.constructor>[0] = {},
  extra: Record<string, unknown> = {},
) {
  const clock = harness()
  const abandoned: Array<{ url: string; reason: DocumentRetryAbandonReason }> = []
  const queue = new DocumentRetryQueue(config as never, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5, // no jitter offset
    onAbandon: (url, reason) => { abandoned.push({ url, reason }) },
    ...extra,
  })
  return { clock, queue, abandoned }
}

describe('DocumentRetryQueue capacity and concurrency', () => {
  it('keeps 1000 unavailable documents to one timer and four concurrent resolutions', async () => {
    const { clock, queue } = queueWith({ maxPending: 1_000, maxConcurrent: 4, jitterRatio: 0 })
    let active = 0
    let maxActive = 0
    let attempts = 0
    const task = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      attempts += 1
      await Promise.resolve()
      active -= 1
      throw unavailable()
    }

    for (let index = 0; index < 1_000; index += 1) queue.schedule(`automerge:doc-${index}`, task)

    expect(queue.pendingDepth).toBe(1_000)
    expect(clock.liveTimers()).toBe(1)
    await clock.advance(5_000)

    expect(maxActive).toBe(4)
    expect(attempts).toBeGreaterThan(4)
    expect(clock.liveTimers()).toBe(1)
    // Never one timer per missing document: the wake timer must stay a
    // per-queue resource no matter how deep the backlog is.
    expect(clock.armedTimers()).toBeLessThan(1_000)
    expect(queue.snapshot()).toMatchObject({ maxActiveResolutions: 4, maxPendingDepth: 1_000 })
    queue.stop()
    expect(clock.liveTimers()).toBe(0)
  })

  it('never tracks the same document url twice', () => {
    const { queue } = queueWith()
    const task = vi.fn(async () => undefined)

    expect(queue.schedule('automerge:a', task)).toBe(true)
    expect(queue.schedule('automerge:a', task)).toBe(false)
    expect(queue.schedule('automerge:a', task)).toBe(false)
    expect(queue.pendingDepth).toBe(1)
    expect(queue.snapshot().scheduled).toBe(1)
  })

  it('refuses work beyond maxPending instead of queueing it silently', () => {
    const { queue } = queueWith({ maxPending: 3 })
    const task = async () => undefined

    for (let index = 0; index < 10; index += 1) queue.schedule(`automerge:doc-${index}`, task)

    expect(queue.pendingDepth).toBe(3)
    expect(queue.snapshot().rejectedOverCapacity).toBe(7)
  })
})

describe('DocumentRetryQueue backoff', () => {
  it('grows the delay exponentially up to the cap and applies jitter', async () => {
    const delays: number[] = []
    const clock = harness()
    const random = vi.fn(() => 1) // maximum positive jitter
    const queue = new DocumentRetryQueue(
      { baseDelayMs: 250, maxDelayMs: 30_000, jitterRatio: 0.2, deadlineMs: 10 * 60_000 },
      {
        now: clock.now,
        random,
        setTimer: (fn, ms) => { delays.push(ms); return clock.setTimer(fn, ms) },
        clearTimer: clock.clearTimer,
      },
    )
    queue.schedule('automerge:a', async () => { throw unavailable() })

    await clock.advance(5 * 60_000)

    // 250, 500, 1000 … each scaled by the +20% jitter bound.
    expect(delays.slice(0, 4)).toEqual([300, 600, 1_200, 2_400])
    expect(Math.max(...delays)).toBe(30_000 * 1.2)
    queue.stop()
  })

  it('keeps jitter inside +/- the configured ratio', () => {
    const samples: number[] = []
    const clock = harness()
    let seed = 0
    const queue = new DocumentRetryQueue(
      { baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0.2 },
      {
        now: clock.now,
        random: () => (seed = (seed + 0.17) % 1),
        setTimer: (fn, ms) => { samples.push(ms); return clock.setTimer(fn, ms) },
        clearTimer: clock.clearTimer,
      },
    )
    for (let index = 0; index < 25; index += 1) queue.schedule(`automerge:doc-${index}`, async () => undefined)

    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(800)
      expect(sample).toBeLessThanOrEqual(1_200)
    }
    queue.stop()
  })

  it('abandons a document that exhausts its wall-clock budget', async () => {
    const { clock, queue, abandoned } = queueWith({ deadlineMs: 2_000, baseDelayMs: 250, jitterRatio: 0 })
    queue.schedule('automerge:a', async () => { throw unavailable() })

    await clock.advance(60_000)

    expect(abandoned).toEqual([{ url: 'automerge:a', reason: 'deadline' }])
    expect(queue.pendingDepth).toBe(0)
    expect(clock.liveTimers()).toBe(0)
    expect(queue.snapshot().abandoned.deadline).toBe(1)
  })
})

describe('DocumentRetryQueue failure handling', () => {
  it('never retries a PostgreSQL outage as a document resolution', async () => {
    const { clock, queue, abandoned } = queueWith({ baseDelayMs: 100, jitterRatio: 0 })
    const task = vi.fn(async () => {
      throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
    })
    queue.schedule('automerge:a', task)

    await clock.advance(120_000)

    expect(task).toHaveBeenCalledTimes(1)
    expect(abandoned).toEqual([{ url: 'automerge:a', reason: 'unexpected' }])
    expect(queue.snapshot().retries).toBe(0)
  })

  it('never retries a permanently unresolvable reference', async () => {
    const { clock, queue, abandoned } = queueWith({ baseDelayMs: 100, jitterRatio: 0 })
    const task = vi.fn(async () => { throw new Error('Document abc was deleted') })
    queue.schedule('automerge:a', task)

    await clock.advance(120_000)

    expect(task).toHaveBeenCalledTimes(1)
    expect(abandoned).toEqual([{ url: 'automerge:a', reason: 'invalid' }])
  })

  it('honours an opt-in bounded retry policy for non-resolution failures', async () => {
    const { clock, queue, abandoned } = queueWith({ baseDelayMs: 100, jitterRatio: 0, deadlineMs: 10 * 60_000 })
    const task = vi.fn(async () => { throw new Error('read model projection failed') })
    queue.schedule('automerge:a', task, { maxAttempts: 3, retryOn: () => true })

    await clock.advance(120_000)

    expect(task).toHaveBeenCalledTimes(3)
    expect(abandoned).toEqual([{ url: 'automerge:a', reason: 'exhausted' }])
  })

  it('records how long a late document took to become available', async () => {
    const { clock, queue } = queueWith({ baseDelayMs: 1_000, jitterRatio: 0, deadlineMs: 10 * 60_000 })
    let arrived = false
    queue.schedule('automerge:a', async () => { if (!arrived) throw unavailable() })

    await clock.advance(1_500)
    expect(queue.pendingDepth).toBe(1)
    arrived = true
    await clock.advance(10_000)

    expect(queue.pendingDepth).toBe(0)
    expect(queue.snapshot().resolved).toBe(1)
    expect(queue.snapshot().maxTimeToAvailableMs).toBeGreaterThan(0)
    expect(clock.liveTimers()).toBe(0)
  })
})

describe('DocumentRetryQueue lifecycle', () => {
  it('drops a document as soon as it stops being referenced', async () => {
    const { clock, queue, abandoned } = queueWith({ baseDelayMs: 1_000, jitterRatio: 0 })
    const removed = vi.fn(async () => { throw unavailable() })
    const kept = vi.fn(async () => { throw unavailable() })
    queue.schedule('automerge:a', removed)
    queue.schedule('automerge:b', kept)

    queue.retain(new Set(['automerge:b']))

    expect(queue.has('automerge:a')).toBe(false)
    expect(queue.has('automerge:b')).toBe(true)
    expect(abandoned).toEqual([{ url: 'automerge:a', reason: 'dropped' }])
    await clock.advance(5_000)
    // The dropped reference never consumes another resolution slot.
    expect(removed).not.toHaveBeenCalled()
    expect(kept.mock.calls.length).toBeGreaterThan(0)
    queue.stop()
  })

  it('discards the result of an in-flight attempt for a dropped document', async () => {
    const { clock, queue } = queueWith({ baseDelayMs: 100, jitterRatio: 0 })
    let release: (() => void) | null = null
    queue.schedule('automerge:a', () => new Promise<void>((resolve) => { release = resolve }))

    await clock.advance(200)
    expect(queue.snapshot().activeResolutions).toBe(1)
    queue.forget('automerge:a')
    release?.()
    await flush()

    expect(queue.pendingDepth).toBe(0)
    expect(queue.snapshot().activeResolutions).toBe(0)
    expect(queue.snapshot().resolved).toBe(0)
  })

  // `onIdle` is what tells the owning projector its workspace is finally
  // complete, and on a quiet workspace it is the ONLY thing that will — no
  // further change arrives to re-derive it. So every path that can remove the
  // last entry has to report it, not just the resolve/abandon pair.
  describe('reporting the queue idle', () => {
    it('reports idle when the last entry RESOLVES', async () => {
      const idle = vi.fn()
      const { clock, queue } = queueWith({ baseDelayMs: 100, jitterRatio: 0 }, { onIdle: idle })
      queue.schedule('automerge:a', async () => {})

      await clock.advance(200)
      expect(idle).toHaveBeenCalledTimes(1)
      queue.stop()
    })

    it('does NOT report idle when a WAITING entry is dropped by retain', async () => {
      // `forget()` must NOT report idle. Its only caller is `retain()`, whose
      // only caller is `reconcileDiagramDocs` — which drops the unreferenced urls and then
      // immediately re-attaches the referenced ones. An idle edge reported in
      // that gap is a lie with a plausible shape: swap diagram A for diagram B,
      // `retain` drops A, the queue is momentarily empty, health is published
      // AND LATCHED, and B — whose document has not synced either — is queued a
      // millisecond later. Nothing is lost by staying quiet: the reconcile ends
      // with its own health call, after the re-attach.
      const idle = vi.fn()
      const { queue } = queueWith({ baseDelayMs: 10_000, jitterRatio: 0 }, { onIdle: idle })
      queue.schedule('automerge:a', async () => { throw unavailable() })

      queue.retain(new Set())

      expect(queue.pendingDepth).toBe(0)
      expect(idle).not.toHaveBeenCalled()
      queue.stop()
    })

    it('reports idle when an entry dropped MID-FLIGHT finally settles', async () => {
      // The subtle one. `forget()` cannot report idle while the attempt it
      // dropped is still counted in `active`, and `settle()` returns early for a
      // replaced entry — so without a notify on that branch the idle edge is
      // lost entirely and the workspace keeps a stale degradation forever.
      const idle = vi.fn()
      const { clock, queue } = queueWith({ baseDelayMs: 100, jitterRatio: 0 }, { onIdle: idle })
      let release: (() => void) | null = null
      queue.schedule('automerge:a', () => new Promise<void>((resolve) => { release = resolve }))

      await clock.advance(200)
      expect(queue.snapshot().activeResolutions).toBe(1)
      queue.forget('automerge:a')
      expect(idle).not.toHaveBeenCalled() // still one attempt in flight

      release?.()
      await flush()

      expect(queue.snapshot().activeResolutions).toBe(0)
      expect(idle).toHaveBeenCalledTimes(1)
      queue.stop()
    })

    it('does not report idle while another document is still owed', async () => {
      const idle = vi.fn()
      const { queue } = queueWith({ baseDelayMs: 10_000, jitterRatio: 0 }, { onIdle: idle })
      queue.schedule('automerge:a', async () => { throw unavailable() })
      queue.schedule('automerge:b', async () => { throw unavailable() })

      queue.forget('automerge:a')

      expect(idle).not.toHaveBeenCalled()
      queue.stop()
    })
  })

  it('stops every retry and clears the timer when the projector goes away', async () => {
    const { clock, queue, abandoned } = queueWith({ baseDelayMs: 100, jitterRatio: 0 })
    const task = vi.fn(async () => { throw unavailable() })
    queue.schedule('automerge:a', task)
    queue.schedule('automerge:b', task)

    await clock.advance(300)
    const before = task.mock.calls.length
    queue.stop()
    await clock.advance(120_000)

    expect(task.mock.calls.length).toBe(before)
    expect(clock.liveTimers()).toBe(0)
    expect(queue.pendingDepth).toBe(0)
    expect(queue.schedule('automerge:c', task)).toBe(false)
    expect(abandoned.filter((entry) => entry.reason === 'stopped').length).toBe(2)
    expect(queue.signal.aborted).toBe(true)
  })

  it('stops when the owning projector aborts its signal', async () => {
    const controller = new AbortController()
    const { clock, queue } = queueWith({ baseDelayMs: 100, jitterRatio: 0 }, { signal: controller.signal })
    const task = vi.fn(async () => { throw unavailable() })
    queue.schedule('automerge:a', task)

    controller.abort()
    await clock.advance(60_000)

    expect(task).not.toHaveBeenCalled()
    expect(clock.liveTimers()).toBe(0)
    expect(queue.pendingDepth).toBe(0)
  })

  it('leaves memory clean once every document has expired', async () => {
    const { clock, queue } = queueWith({ maxPending: 600, deadlineMs: 1_000, baseDelayMs: 250, jitterRatio: 0 })
    for (let index = 0; index < 600; index += 1) {
      queue.schedule(`automerge:doc-${index}`, async () => { throw unavailable() })
    }

    await clock.advance(10 * 60_000)

    expect(queue.pendingDepth).toBe(0)
    expect(clock.liveTimers()).toBe(0)
    expect(queue.snapshot().abandoned.deadline).toBe(600)
  })
})

describe('documentRetryQueueConfig', () => {
  it('defaults to the bounded production policy', () => {
    expect(documentRetryQueueConfig({})).toEqual({
      maxConcurrent: 4,
      maxPending: 512,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
      deadlineMs: 120_000,
    })
  })

  it('accepts overrides and ignores nonsense', () => {
    expect(documentRetryQueueConfig({
      READ_MODEL_DOC_RETRY_CONCURRENCY: '8',
      READ_MODEL_DOC_RETRY_MAX_PENDING: 'not-a-number',
      READ_MODEL_DIAGRAM_RETRY_MS: '45000',
    })).toMatchObject({ maxConcurrent: 8, maxPending: 512, maxDelayMs: 45_000 })
  })
})

describe('DocumentRetryRegistry', () => {
  it('aggregates process-wide pressure without exposing workspace keys', () => {
    const registry = new DocumentRetryRegistry()
    const first = queueWith({ maxPending: 2 })
    const second = queueWith({ maxPending: 2 })
    const unregister = registry.register(first.queue)
    registry.register(second.queue)
    for (let index = 0; index < 4; index += 1) {
      first.queue.schedule(`automerge:a-${index}`, async () => undefined)
      second.queue.schedule(`automerge:b-${index}`, async () => undefined)
    }

    const snapshot = registry.snapshot()

    expect(snapshot).toMatchObject({ queues: 2, pendingDepth: 4, scheduled: 4, rejectedOverCapacity: 4 })
    expect(Object.keys(snapshot)).not.toContain('workspaces')
    unregister()
    expect(registry.snapshot().queues).toBe(1)
  })
})
