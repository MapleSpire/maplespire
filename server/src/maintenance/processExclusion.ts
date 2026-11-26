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
 * ONE MAINTENANCE PASS AT A TIME IN THIS PROCESS, for passes that hold
 * several pooled connections at once (G4-16f).
 *
 * A compaction pass holds about five connections of the primary pool
 * (`overlay-rotation:` object and connection, `model-epoch:`, the lifecycle
 * lock's pin, its plain queries) and so does an epoch sweep; with
 * `DB_POOL_MAX=10` the two together fill the pool and an HTTP route then
 * fails `connectionTimeoutMillis` with a 500. They never need to overlap: the
 * pass forwards late writes itself.
 *
 *  - {@link ProcessExclusion.run}: WAIT for the slot (compaction — a nightly
 *    pass is not dropped because a sweep is running; a sweep lasts seconds);
 *  - {@link ProcessExclusion.tryRun}: TAKE it or SKIP (the sweep and the
 *    meta-only epoch job — they come back in ten minutes).
 *
 * Lifetime walk: the slot is taken synchronously when free (no await
 * between the check and the take), released in `finally` on both settle
 * paths, and handed to the next waiter in FIFO order — `held` never drops
 * to false between the release and the waiter's resumption, so a `tryRun`
 * in that gap is refused, not admitted beside the waiter.
 *
 * Observability: {@link ProcessExclusion.waiting}
 * lets a running TRY yield at its safe points to a waiting RUN, and
 * {@link ProcessExclusion.hold} names the current hold (a sequence number and
 * its start), so a sweep that keeps being skipped behind ONE hung pass can
 * alert once per hold.
 */
export interface ProcessExclusion {
  run<T>(work: () => Promise<T>): Promise<T>
  tryRun<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>
  /** WAIT up to `maxWaitMs` for the slot, as a waiter (the
   * periodic sweep and the meta-only job are counted by `waiting()`, so a
   * running event-driven pass yields to them at its next safe point), then
   * SKIP. */
  runWithin<T>(work: () => Promise<T>, maxWaitMs: number): Promise<{ ran: true; value: T } | { ran: false }>
  busy(): boolean
  /** How many RUNs are queued behind the current holder. */
  waiting(): number
  /** The current hold — a sequence number, unique per hand-over, and when it
   * began (ms, `now`) — or null when free. */
  hold(): { seq: number; sinceMs: number } | null
}

export function createProcessExclusion(now: () => number = () => Date.now()): ProcessExclusion {
  let held = false
  let seq = 0
  let sinceMs = 0
  const waiters: Array<() => void> = []
  const take = () => { held = true; seq += 1; sinceMs = now() }
  const release = () => {
    const next = waiters.shift()
    if (next) { take(); next() } // the slot passes straight to the next waiter: `held` stays true
    else held = false
  }
  const acquire = (): Promise<void> => {
    if (!held) { take(); return Promise.resolve() }
    return new Promise<void>((resolve) => { waiters.push(resolve) })
  }
  return {
    async run(work) {
      await acquire()
      try { return await work() } finally { release() }
    },
    async tryRun(work) {
      if (held) return { ran: false }
      take()
      try { return { ran: true, value: await work() } } finally { release() }
    },
    async runWithin(work, maxWaitMs) {
      if (held) {
        const granted = await new Promise<boolean>((resolve) => {
          // Handed the slot by `release` (which shifts it first): the timer
          // can no longer find it, so a late timeout never answers twice.
          const waiter = () => { clearTimeout(timer); resolve(true) }
          const timer = setTimeout(() => {
            const at = waiters.indexOf(waiter)
            if (at >= 0) { waiters.splice(at, 1); resolve(false) }
          }, maxWaitMs)
          timer.unref?.()
          waiters.push(waiter)
        })
        if (!granted) return { ran: false }
      } else {
        take()
      }
      try { return { ran: true, value: await work() } } finally { release() }
    },
    busy: () => held,
    waiting: () => waiters.length,
    hold: () => (held ? { seq, sinceMs } : null),
  }
}
