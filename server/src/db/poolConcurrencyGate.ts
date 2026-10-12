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

/**
 * A BOUND ON HOW MANY CLIENTS ONE BORROWER MAY HOLD FROM A SHARED POOL.
 *
 * Under load (measured during a prolonged Redis outage, ~45 concurrent merges)
 * the Automerge `PostgresStorageAdapter` alone could occupy every usable client
 * of the PRIMARY pool — `DB_POOL_MAX` 10 minus the three held for the process
 * lifetime by LISTEN subscribers leaves seven — so every other borrower waited
 * the full `connectionTimeoutMillis` (~10 s) and failed untyped. The
 * concurrency is request-level: each merge does a handful of adapter
 * operations.
 *
 * Why a permit gate rather than a dedicated `Pool`: this holder is unbounded in
 * COUNT, so a small dedicated pool would just queue the same aggregate and hit
 * its own `connectionTimeoutMillis`. And pg-pool applies ONE number to two
 * different waits — the queued checkout AND the establishment of a new
 * connection — so making the queue untimed would also remove the ceiling on a
 * TCP/TLS connect to an unreachable Postgres. The gate separates them: the
 * queue wait gets its own deadline here, and the borrow keeps the pool's
 * ceiling.
 *
 * The deadline is not optional. An untimed queue does not remove the failure,
 * it trades a fast one for a slow one (Little's Law); production limiters ship
 * both halves — Envoy's `max_pending_requests` beside `max_requests`,
 * HikariCP's `connectionTimeout` on a fixed pool.
 *
 * Refusing a `save()` is not automatically a lost document: automerge-repo's
 * `StorageSubsystem` only advances its saved heads after the adapter resolves,
 * so a throw leaves the document dirty and its NEXT change re-saves it. A
 * document that never changes again has no retry — a known uncovered gap.
 */

import type { Pool } from 'pg'

/**
 * Thrown when a caller waited longer than its deadline for a permit.
 *
 * Deliberately NOT a storage-specific error: this module knows nothing about
 * Automerge, and the caller converts it at its own boundary, where the meaning
 * of "which operation" is known. Same division as `pg` throwing an untyped
 * error that `acquireLifecycleApplyLock` converts at the acquisition site.
 */
export class PoolPermitTimeoutError extends Error {
  constructor(readonly waitedMs: number, readonly limit: number) {
    super(`waited ${waitedMs} ms for one of ${limit} pool permits`)
    this.name = 'PoolPermitTimeoutError'
  }
}

/**
 * Handed out by `acquire`, returned by `release`.
 *
 * `release` is IDEMPOTENT on purpose. A permit released twice hands one slot to
 * two waiters, so `inFlight` drifts below the truth and the bound loosens
 * permanently — a failure that is hard to notice because it fails OPEN.
 */
export interface PoolPermit {
  release(): void
}

interface Waiter {
  wake: () => void
  /** Set when the deadline fired. See `handOff` for why this cannot be skipped. */
  abandoned: boolean
}

export class PoolConcurrencyGate {
  private readonly max: number
  private inFlight = 0
  private readonly waiters: Waiter[] = []

  constructor(max: number) {
    this.max = Math.max(1, Math.trunc(max))
  }

  /** Permits currently held. Never above `max`; that is the invariant. */
  get inFlightCount(): number {
    return this.inFlight
  }

  /**
   * Callers parked waiting for a permit.
   *
   * OVER-REPORTS DURING A REFUSAL STORM, by design: a waiter whose deadline
   * fires is marked abandoned but stays in the array until a release drains it
   * (`handOff`). Splicing it out from the timer would cost an O(n) scan per
   * timeout on the path already under pressure. Use `liveQueueDepth` for live
   * demand.
   */
  get queueDepth(): number {
    return this.waiters.length
  }

  /** Waiters that are genuinely still waiting — `queueDepth` minus tombstones. */
  get liveQueueDepth(): number {
    return this.waiters.reduce((live, waiter) => (waiter.abandoned ? live : live + 1), 0)
  }

  get limit(): number {
    return this.max
  }

  /**
   * THE CALLER MUST `release()` IN A `finally`, WITH NO `await` BETWEEN THIS
   * RESOLVING AND THE `try` IT GUARDS, or a throw in between leaks the permit.
   * Prefer `run()` below, which is that shape written once.
   *
   * Rejects with `PoolPermitTimeoutError` if no permit arrives within
   * `timeoutMs`. Nothing is held when it rejects: the waiter is marked
   * abandoned before the rejection and no permit was ever transferred to it.
   */
  async acquire(timeoutMs: number): Promise<PoolPermit> {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return this.permit()
    }
    const startedAt = Date.now()
    const waiter: Waiter = { wake: () => undefined, abandoned: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        waiter.wake = resolve
        this.waiters.push(waiter)
        timer = setTimeout(() => {
          // Mark the waiter abandoned before rejecting. A permit handed to an
          // abandoned waiter is never released — a permanent leak, failing
          // CLOSED. The order of these two lines does not matter (`reject`
          // only schedules a microtask); what matters is that this write and
          // the read in `handOff` are both synchronous, so they cannot
          // interleave.
          waiter.abandoned = true
          reject(new PoolPermitTimeoutError(Date.now() - startedAt, this.max))
        }, timeoutMs)
        // Never hold the event loop open for a waiter. `unref` is absent under
        // some fake-timer implementations, hence the guard.
        timer.unref?.()
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
    // NOT `inFlight += 1` here. The permit was TRANSFERRED by the releaser
    // without ever being given back, so this waiter already owns it. A
    // release-then-reacquire would open a window in which a newly-arriving
    // caller takes the free slot ahead of a waiter that has been parked longer
    // — starvation under exactly the sustained load this gate is for.
    return this.permit()
  }

  /** Acquire, run, release — the only shape that cannot leak a permit. */
  async run<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const permit = await this.acquire(timeoutMs)
    try {
      return await fn()
    } finally {
      permit.release()
    }
  }

  private permit(): PoolPermit {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.handOff()
      },
    }
  }

  /**
   * Give the permit to the longest-parked waiter that still wants it, or give
   * it back to the pool of free slots.
   *
   * The loop is what makes the deadline safe: an abandoned waiter is still in
   * the array (its timer does not splice it out), so handing to the head
   * unconditionally would drop the permit into a caller that has already
   * rejected, and `inFlight` would never come back down.
   */
  private handOff(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()
      if (!next || next.abandoned) continue
      next.wake()
      return
    }
    this.inFlight -= 1
  }
}

/**
 * ONE GATE PER POOL. Several `PostgresStorageAdapter` instances share the same
 * `pool` (one per promote-summary request, one for the process lifetime, one in
 * the global GC worker). A gate owned by the adapter INSTANCE would multiply by
 * the number of live adapters and bound nothing under load, while unit tests
 * that build one adapter would still pass. The bound belongs to the resource,
 * so it is keyed by the pool.
 *
 * A `WeakMap` rather than a module-level `Map`: a test pool that goes out of
 * scope must not keep its gate — or, through the key, itself — alive.
 *
 * FIRST CALLER'S `max` WINS: silently taking the larger would let a later
 * caller loosen an earlier caller's bulkhead.
 */
const gatesByPool = new WeakMap<Pool, PoolConcurrencyGate>()

export function poolConcurrencyGate(pool: Pool, max: number): PoolConcurrencyGate {
  const existing = gatesByPool.get(pool)
  if (existing) return existing
  const gate = new PoolConcurrencyGate(max)
  gatesByPool.set(pool, gate)
  return gate
}

/**
 * The gate installed on this pool, if any — read-only, for the census in
 * `poolMeter.ts`. `poolConcurrencyGate(pool, max)` would INSTALL a gate when
 * none is present, so an instrument calling it would apply a bulkhead as a side
 * effect of asking a question.
 *
 * The census needs it because this gate is a SECOND queue in front of the
 * pool, and a caller parked in it holds no pg client: without these numbers a
 * saturated cell would look calm (`waiting: 0`, `checkedOut` below `max`).
 */
export function installedPoolConcurrencyGate(pool: Pool): PoolConcurrencyGate | undefined {
  return gatesByPool.get(pool)
}
