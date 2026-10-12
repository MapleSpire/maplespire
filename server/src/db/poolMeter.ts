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

import type { Pool, PoolClient } from 'pg'
import { installedPoolConcurrencyGate } from './poolConcurrencyGate.js'

/**
 * In-process census of every pg pool, read by `/api/health/pools`.
 *
 * Attributing pool exhaustion from OUTSIDE the process with `pg_stat_activity`
 * is misleading: a backend `idle` in Postgres says nothing about whether
 * node-postgres has handed that connection to a caller. This meter reads the
 * pool's own counters and events instead. Claims below are against
 * `pg-pool@3.14.0`.
 *
 * ## What is exact and what is sampled
 *
 * `checkedOut` is EXACT: the running difference of the pool's `'acquire'` and
 * `'release'` events, which pg-pool pairs exactly — `client.release` is
 * assigned only after `'acquire'` is emitted, a waiter that timed out after
 * being handed a client still releases it, one that timed out while queued
 * produces neither event, and a double release throws before emitting. (The
 * exception is `options.verify`, whose hook could strand the count; it is unset
 * in this tree.)
 *
 * `connecting` is DERIVED as `total - idle - checkedOut`: pg-pool adds a client
 * to `totalCount` before `client.connect()` resolves. This separates two
 * failure modes: a queue that will not drain shows `waiting > 0`, while an
 * establishment that will not complete shows `connecting > 0` with `waiting`
 * at zero.
 *
 * ## Why `connecting` is folded only at SNAPSHOT time
 *
 * Every pg event fires mid-transition: at `'connect'`/`'acquire'` the client is
 * in `_clients` but not yet in `checkedOut`, and at `'release'` it is in
 * neither `idle` nor `checkedOut`. A fold inside those handlers reads the
 * hand-off as an establishment stall (measured: ten immediate, successful
 * `connect()`s on a `max: 10` pool reported `connectingHighWater = 10`). So
 * `connectingHighWaterObserved` is a peak at SAMPLE resolution. `waiting` is
 * folded at event time too, because `waitingCount` moves inside `connect()`
 * with no event of its own, and no transient inflates it.
 *
 * ## The one interleaving where the derivation IS negative
 *
 * pg-pool's `maxLifetimeSeconds` timer acquires a client it found in `_idle`
 * without popping it, so `total - idle - checkedOut` reaches −1 at that emit
 * and returns to 0 synchronously. It is only observable at event time, which is
 * why `#observe` counts underflows. `maxLifetimeSeconds` is unset in this tree,
 * so the count is expected to stay 0.
 *
 * `borrowHighWater` is EXACT: `checkedOut` can only rise in the `'acquire'`
 * handler, which folds it.
 *
 * ## What it deliberately does not do
 *
 * It does not wrap `connect`, `query` or `release`: listeners observe without
 * sitting between an acquisition and its release. (`Pool.query` calls
 * `this.connect` in callback form, so a wrapper would have to preserve both
 * signatures, and getting that wrong leaks a client.)
 *
 * It does not capture a stack per borrow — too costly on the hottest path.
 * `oldestBorrowMs` is the cheap substitute: a hold that will not end shows as
 * an age that keeps climbing.
 */
export interface PoolMeterSnapshot {
  /** The label `guardIdleClientErrors` was given — `primary`, `read-model`, … */
  pool: string
  /** `options.max`, so a reader can tell "8 of 10" from "8 of 8". */
  max: number | null
  /** `pool.totalCount` — every client the pool owns, INCLUDING one still connecting. */
  total: number
  /** `pool.idleCount` — clients on the free list, available to the next `connect()`. */
  idle: number
  /** EXACT: handed to a caller and not yet released. What `pg_stat_activity` cannot see. */
  checkedOut: number
  /** DERIVED, clamped at 0: owned by the pool, not free, not handed out — being established. */
  connecting: number
  /** `pool.waitingCount` — callers queued because the pool is full. */
  waiting: number
  /** EXACT peak of `checkedOut`; it can only rise in the `'acquire'` handler, which folds it. */
  borrowHighWater: number
  /** Peak of `waiting` across every pool EVENT and every snapshot — see the docblock. */
  waitHighWaterObserved: number
  /** Peak of `connecting` across SNAPSHOTS only, deliberately — see the docblock. */
  connectingHighWaterObserved: number
  acquires: number
  releases: number
  /** Physical connections opened, from `'connect'`; `'acquire'` counts hand-offs. */
  connects: number
  removes: number
  /** Age of the oldest in-flight borrow, or null when nothing is checked out. */
  oldestBorrowMs: number | null
  /**
   * THE SECOND QUEUE (`PoolConcurrencyGate`), null when this pool has none. A
   * caller parked at the gate holds no pg client, so without this the pool
   * reads as calm while the gate holds callers back. `queueDepth` counts
   * tombstoned waiters too; `liveQueueDepth` is live demand.
   */
  gate: { limit: number; inFlight: number; queueDepth: number; liveQueueDepth: number } | null
  /**
   * Observations — at event time AND at snapshot time — in which
   * `total - idle - checkedOut` was negative. Expected 0 with this tree's
   * configuration; see the docblock for the one pg path that produces it.
   */
  connectingUnderflows: number
  /**
   * Times a listener threw. Expected 0. Present because these handlers run
   * inside a socket read callback, where an uncaught throw is process death,
   * not a 500 — see the guard on `#safely`.
   */
  handlerFailures: number
  /** `end()` has been called. Reported, not pruned: a pool that will not drain is a finding. */
  ending: boolean
  /** Draining finished — pg-pool sets this only once every client is gone. */
  ended: boolean
}

const now = (): number => performance.now()

class PoolMeter {
  readonly label: string
  readonly #poolRef: WeakRef<Pool>
  /**
   * Borrow ages, in TWO maps, and the split is the whole point.
   *
   * A single `Map<PoolClient, number>` would pin the pool: meters (strong) →
   * map → `PoolClient` → `client.release`, a closure whose `this` is the pool.
   * A pool abandoned mid-borrow (e.g. a drill whose stalled query keeps its
   * client, see `backup/drillScheduler.ts`) would then stay reachable for the
   * life of the process, with its clients and sockets, defeating the `WeakRef`.
   *
   * So identity is held weakly and the age by a number: `#borrowIds` retains no
   * client and `#borrowStartedAt` is `number -> number`. What survives an
   * abandoned borrow is one pair of numbers — an `oldestBorrowMs` that climbs
   * forever is the leak signal, not a leak.
   *
   * Dropping the whole meter happens in `pruneRetired()`, on `ended`.
   */
  readonly #borrowIds = new WeakMap<PoolClient, number>()
  readonly #borrowStartedAt = new Map<number, number>()
  #nextBorrowId = 1
  #checkedOut = 0
  #acquires = 0
  #releases = 0
  #connects = 0
  #removes = 0
  #borrowHighWater = 0
  #waitHighWater = 0
  #connectingHighWater = 0
  #underflows = 0
  #handlerFailures = 0

  constructor(pool: Pool, label: string) {
    this.label = label
    this.#poolRef = new WeakRef(pool)

    pool.on('acquire', (client) => this.#safely(() => {
      this.#acquires += 1
      this.#checkedOut += 1
      if (this.#checkedOut > this.#borrowHighWater) this.#borrowHighWater = this.#checkedOut
      // A fresh id per BORROW, not per client: pg reuses one client object
      // across many borrows, so keying the age by the client alone would let a
      // stale start time survive a release.
      const id = this.#nextBorrowId
      this.#nextBorrowId += 1
      this.#borrowIds.set(client, id)
      this.#borrowStartedAt.set(id, now())
      this.#observe(pool)
    }))

    pool.on('release', (_err, client) => this.#safely(() => {
      this.#releases += 1
      this.#checkedOut -= 1
      const id = this.#borrowIds.get(client)
      if (id !== undefined) {
        this.#borrowIds.delete(client)
        this.#borrowStartedAt.delete(id)
      }
      this.#observe(pool)
    }))

    pool.on('connect', () => this.#safely(() => {
      this.#connects += 1
      this.#observe(pool)
    }))

    pool.on('remove', () => this.#safely(() => {
      this.#removes += 1
      this.#observe(pool)
    }))
  }

  /**
   * These four listeners run synchronously inside pg's own emit, which is
   * reached from a socket read callback — so an uncaught throw there is not a
   * 500, it is process death, with `pool.connect()` never settling and the
   * client stranded because pg-pool assigns `client.release` AFTER the
   * `'acquire'` emit.
   *
   * No known input makes these bodies throw (integer arithmetic, `Map`
   * operations, `performance.now()`, getters returning `Array.length`); the
   * guard exists because an instrument must never take down the process it
   * watches. Counted, never swallowed silently: `handlerFailures` is in every
   * snapshot.
   */
  #safely(fn: () => void): void {
    try {
      fn()
    } catch {
      this.#handlerFailures += 1
    }
  }

  /**
   * Fold what only an EVENT can show.
   *
   * `waiting` is folded here because `waitingCount` moves inside `connect()`
   * with no event of its own, so a queue that rose and fell between two samples
   * would otherwise be invisible.
   *
   * `connecting` is deliberately NOT folded here — see the docblock; a fold at
   * event time reads the hand-off transient as an establishment stall. But the
   * UNDERFLOW is counted here, because event time is the only place it occurs.
   */
  #observe(pool: Pool): void {
    const waiting = pool.waitingCount
    if (waiting > this.#waitHighWater) this.#waitHighWater = waiting
    if (pool.totalCount - pool.idleCount - this.#checkedOut < 0) this.#underflows += 1
  }

  snapshot(): PoolMeterSnapshot | null {
    const pool = this.#poolRef.deref()
    if (!pool) return null
    const total = pool.totalCount
    const idle = pool.idleCount
    const waiting = pool.waitingCount
    if (waiting > this.#waitHighWater) this.#waitHighWater = waiting
    const rawConnecting = total - idle - this.#checkedOut
    if (rawConnecting < 0) this.#underflows += 1
    const connecting = rawConnecting < 0 ? 0 : rawConnecting
    if (connecting > this.#connectingHighWater) this.#connectingHighWater = connecting
    let oldestBorrowMs: number | null = null
    if (this.#borrowStartedAt.size > 0) {
      const at = now()
      let oldestStart = Infinity
      for (const startedAt of this.#borrowStartedAt.values()) {
        if (startedAt < oldestStart) oldestStart = startedAt
      }
      oldestBorrowMs = at - oldestStart
    }
    const gate = installedPoolConcurrencyGate(pool)
    return {
      pool: this.label,
      max: typeof pool.options?.max === 'number' ? pool.options.max : null,
      total,
      idle,
      checkedOut: this.#checkedOut,
      connecting,
      waiting,
      borrowHighWater: this.#borrowHighWater,
      waitHighWaterObserved: this.#waitHighWater,
      connectingHighWaterObserved: this.#connectingHighWater,
      acquires: this.#acquires,
      releases: this.#releases,
      connects: this.#connects,
      removes: this.#removes,
      oldestBorrowMs,
      gate: gate
        ? {
          limit: gate.limit,
          inFlight: gate.inFlightCount,
          queueDepth: gate.queueDepth,
          liveQueueDepth: gate.liveQueueDepth,
        }
        : null,
      connectingUnderflows: this.#underflows,
      handlerFailures: this.#handlerFailures,
      ending: pool.ending,
      ended: pool.ended,
    }
  }

  /** The pool, or undefined once it has been collected. */
  get pool(): Pool | undefined {
    return this.#poolRef.deref()
  }
}

/**
 * Strong on the meters, WEAK on the pools. The backup subsystem builds and
 * ends a pool per drill, so a registry that held pools would retain one dead
 * `Pool` — with its clients and config — per drill for the life of the server.
 * A meter is a handful of numbers.
 */
const meters = new Set<PoolMeter>()

/**
 * One meter per pool. Registering the same pool twice would put two entries
 * under one label in the endpoint payload — and the second, installed on an
 * already-busy pool, starts at `checkedOut = 0` and goes permanently negative
 * on the first release. An injected pool factory that returns a cached pool
 * (e.g. `options.createPool` in `backup/backupRestore.ts`) would do exactly that.
 */
const metered = new WeakMap<Pool, PoolMeter>()

/**
 * Called by `guardIdleClientErrors` at CONSTRUCTION, so a pool added later
 * cannot be silently uninstrumented: `poolErrorGuard.test.ts` rejects any
 * `new Pool(` under `server/src` and `server/scripts` (`.ts` files) that does
 * not go through the guard. Pools built under `server/qa/*.mts` are outside it.
 */
export function meterPool(pool: Pool, label: string): PoolMeterMeasurement {
  const existing = metered.get(pool)
  if (existing) return existing
  // Prune HERE as well as in `poolMeterSnapshots()`, because pruning only on
  // read is pruning that never happens in a process with no reader:
  // `backup/drillScheduler.ts` is a standalone entrypoint with no Express app,
  // so it builds one pool per scheduled drill and never serves the census.
  // Registration is the one event such a process is guaranteed to produce.
  pruneRetired()
  const meter = new PoolMeter(pool, label)
  metered.set(pool, meter)
  meters.add(meter)
  return meter
}

export type PoolMeterMeasurement = { snapshot(): PoolMeterSnapshot | null }

/**
 * Drop meters whose pool is collected or fully drained. Reads no counters.
 */
function pruneRetired(): void {
  for (const meter of meters) {
    const pool = meter.pool
    // NOT covered by any test: forcing a `WeakRef` to clear needs a GC the
    // suite cannot schedule, and a test-only deref seam was judged worse.
    if (!pool) {
      meters.delete(meter)
      continue
    }
    if (pool.ended) meters.delete(meter)
  }
}

/**
 * Every live pool, in registration order, pruning as it goes.
 *
 * `ended`, NOT `ending`, is the retirement predicate. pg-pool only sets `ended`
 * once every client is gone, so a pool stuck draining because a client was
 * never given back (which makes `pool.end()` never resolve) keeps reporting.
 *
 * DOES NO I/O: this is the instrument for a pool that has run out of
 * connections, so it must not need one to report.
 */
export function poolMeterSnapshots(): PoolMeterSnapshot[] {
  pruneRetired()
  const out: PoolMeterSnapshot[] = []
  for (const meter of meters) {
    const snapshot = meter.snapshot()
    if (snapshot) out.push(snapshot)
  }
  return out
}
