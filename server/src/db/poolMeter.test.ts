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

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { meterPool, poolMeterSnapshots } from './poolMeter.js'
import { poolConcurrencyGate } from './poolConcurrencyGate.js'

/**
 * The ARITHMETIC of the meter, driven by hand.
 *
 * A fake pool is the right double here and the wrong one for the claim in the
 * sibling file: these tests establish that the meter computes what it says it
 * computes, and a fake can be made to emit any sequence including ones a real
 * pool never produces (a saturated pool at `max`, an underflow). What a fake
 * CANNOT establish is that `pg-pool` actually emits the sequence the meter
 * assumes — that `'acquire'` and `'release'` are paired, that a queued waiter
 * appears in `waitingCount`. `poolMeter.integration.test.ts` does that against
 * a real Postgres, and it is the load-bearing half.
 *
 * Both exist because either alone is a gate that can pass while wrong: a fake
 * agrees with any implementation, and an integration test that only ever sees a
 * healthy pool never reaches the branches these cover.
 */

/**
 * The four fields the meter reads off a pool, mutable so a test can put the
 * pool in a state and then emit. Deliberately NOT a partial mock of `Pool` with
 * `vi.fn()` everywhere: the meter's contract is exactly these getters plus the
 * four events, and a double that offers more would let a mutant reach for
 * something this file never noticed it was allowed to use.
 */
class FakePool extends EventEmitter {
  totalCount = 0
  idleCount = 0
  waitingCount = 0
  ending = false
  ended = false
  options = { max: 10 }

  /** Mint a distinct client identity; the meter keys borrow ages by it. */
  static client(): PoolClient {
    return {} as PoolClient
  }

  asPool(): Pool {
    return this as unknown as Pool
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('poolMeter — checkedOut is exact, not derived', () => {
  it('rises on acquire and falls on release', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'exact')
    const a = FakePool.client()

    expect(meter.snapshot()?.checkedOut).toBe(0)
    fake.totalCount = 1
    fake.emit('acquire', a)
    expect(meter.snapshot()?.checkedOut).toBe(1)
    fake.emit('release', undefined, a)
    fake.idleCount = 1
    expect(meter.snapshot()?.checkedOut).toBe(0)
  })

  it('tracks two borrows released out of order', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'interleaved')
    const a = FakePool.client()
    const b = FakePool.client()

    fake.totalCount = 2
    fake.emit('acquire', a)
    fake.emit('acquire', b)
    expect(meter.snapshot()?.checkedOut).toBe(2)
    // A released before B — the order pg produces whenever two callers finish
    // in a different order than they started.
    fake.emit('release', undefined, a)
    fake.idleCount = 1
    expect(meter.snapshot()?.checkedOut).toBe(1)
    fake.emit('release', undefined, b)
    fake.idleCount = 2
    expect(meter.snapshot()?.checkedOut).toBe(0)
  })

  it('counts a REUSED client object as one borrow at a time, with a FRESH age', async () => {
    // pg hands the same `Client` object out again after a release. The age must
    // be the CURRENT borrow's: a meter that kept the first borrow's start time
    // would report an age that predates the borrow now in flight.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'reused')
    const a = FakePool.client()

    fake.totalCount = 1
    fake.emit('acquire', a)
    await sleep(60)
    fake.emit('release', undefined, a)
    fake.emit('acquire', a)
    expect(meter.snapshot()?.checkedOut).toBe(1)
    expect(meter.snapshot()?.acquires).toBe(2)
    expect(meter.snapshot()?.releases).toBe(1)
    expect(meter.snapshot()?.oldestBorrowMs).toBeLessThan(40)
  })
})

describe('poolMeter — connecting is the reading pg_stat_activity cannot give', () => {
  it('separates a client being ESTABLISHED from an idle one and from a borrowed one', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'connecting')
    const a = FakePool.client()

    // `newClient` pushes into `_clients` before `client.connect()` resolves, so
    // this is the state of a pool opening its first connection: counted, not
    // idle, never acquired.
    fake.totalCount = 1
    expect(meter.snapshot()).toMatchObject({ total: 1, idle: 0, checkedOut: 0, connecting: 1 })

    // Established and handed to the caller.
    fake.emit('connect', a)
    fake.emit('acquire', a)
    expect(meter.snapshot()).toMatchObject({ total: 1, idle: 0, checkedOut: 1, connecting: 0 })

    // Given back.
    fake.emit('release', undefined, a)
    fake.idleCount = 1
    expect(meter.snapshot()).toMatchObject({ total: 1, idle: 1, checkedOut: 0, connecting: 0 })
  })

  it('is the SIGNATURE that tells a full queue apart from a stalled establishment', () => {
    // The two failure modes side by side. Only the derived field distinguishes
    // them: `total` and `idle` are identical.
    const queued = new FakePool()
    const queuedMeter = meterPool(queued.asPool(), 'queued')
    queued.totalCount = 2
    const held = [FakePool.client(), FakePool.client()]
    for (const client of held) queued.emit('acquire', client)
    queued.waitingCount = 5
    expect(queuedMeter.snapshot()).toMatchObject({ checkedOut: 2, connecting: 0, waiting: 5 })

    const stalled = new FakePool()
    const stalledMeter = meterPool(stalled.asPool(), 'stalled')
    stalled.totalCount = 2
    expect(stalledMeter.snapshot()).toMatchObject({ checkedOut: 0, connecting: 2, waiting: 0 })
  })

  it('counts an underflow at EVENT time, where the only real one occurs', () => {
    // `pg-pool`'s `maxLifetimeSeconds` timer calls `_acquireClient` on a client
    // it has just found in `_idle` and does NOT pop, so the derivation reaches
    // -1 at that emit and is back to 0 synchronously. A counter sited in
    // `snapshot()` alone could never fire.
    //
    // The pool state is RESTORED before the snapshot, so a snapshot-only
    // counter reads 0 here. That is what makes this test able to tell them
    // apart rather than merely agree with both.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'underflow-event')
    const a = FakePool.client()

    fake.totalCount = 1
    fake.idleCount = 1 // the client is STILL on the free list…
    fake.emit('acquire', a) // …and handed out at the same time: 1 - 1 - 1 = -1
    fake.idleCount = 0 // pg's own state settles synchronously

    expect(meter.snapshot()).toMatchObject({ connecting: 0, connectingUnderflows: 1 })
  })

  it('clamps an underflow observed at snapshot time and counts that too', () => {
    // An instrument that throws takes down the process it was installed to
    // watch, so a broken derivation is reported as a number an operator can
    // read rather than swallowed — or raised.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'underflow-snapshot')
    const a = FakePool.client()

    fake.totalCount = 1
    fake.emit('acquire', a)
    fake.idleCount = 1 // an impossible state, reachable only if pairing broke
    expect(meter.snapshot()).toMatchObject({ connecting: 0, connectingUnderflows: 1 })
    expect(meter.snapshot()?.connectingUnderflows).toBe(2)
  })

  it('reports zero underflows on a well-behaved pool', () => {
    // The control for the two tests above: without it, a mutant that hard-codes
    // `connectingUnderflows` to a rising number passes both of them.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'no-underflow')
    const a = FakePool.client()
    fake.totalCount = 1
    fake.emit('acquire', a)
    meter.snapshot()
    fake.emit('release', undefined, a)
    fake.idleCount = 1
    expect(meter.snapshot()?.connectingUnderflows).toBe(0)
  })
})

describe('poolMeter — the peaks say which of them is exact', () => {
  it('borrowHighWater survives a return to zero', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-borrow')
    const clients = [FakePool.client(), FakePool.client(), FakePool.client()]

    fake.totalCount = 3
    for (const client of clients) fake.emit('acquire', client)
    for (const client of clients) fake.emit('release', undefined, client)
    fake.idleCount = 3

    expect(meter.snapshot()).toMatchObject({ checkedOut: 0, borrowHighWater: 3 })
  })

  it('records a wait peak that exists ONLY between two snapshots, because events fold it', () => {
    // `waitingCount` moves inside `connect()` with no event to hang a listener
    // on. The meter folds it on every pool event as well as every snapshot, so
    // a peak that rose and fell between two samples is still seen — provided
    // anything at all was acquired or released while it stood.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-wait')
    const a = FakePool.client()
    fake.totalCount = 1

    expect(meter.snapshot()?.waitHighWaterObserved).toBe(0)
    fake.waitingCount = 7
    fake.emit('acquire', a) // the only observation while the queue stood at 7
    fake.waitingCount = 0
    fake.emit('release', undefined, a)

    expect(meter.snapshot()).toMatchObject({ waiting: 0, waitHighWaterObserved: 7 })
  })

  it('folds the wait peak on a RELEASE too, not only on an acquire', () => {
    // The wait peak is folded on every pool event. A release matters most: it
    // is what happens while a queue is draining, which is exactly when
    // `waitingCount` is highest.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-wait-release')
    const a = FakePool.client()
    fake.totalCount = 1

    fake.emit('acquire', a)
    fake.waitingCount = 9
    fake.emit('release', undefined, a)
    fake.waitingCount = 0
    fake.idleCount = 1

    expect(meter.snapshot()).toMatchObject({ waiting: 0, waitHighWaterObserved: 9 })
  })

  it('records a wait peak seen ONLY at snapshot time, with no event to fold it', () => {
    // The other half. A pool can sit with a full queue and produce no event at
    // all — nothing is being acquired, that is the complaint — so the snapshot
    // itself must fold. Removing either fold leaves one of these two red.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-wait-idle')
    fake.totalCount = 1
    fake.waitingCount = 4

    expect(meter.snapshot()).toMatchObject({ waiting: 4, waitHighWaterObserved: 4 })
    fake.waitingCount = 0
    expect(meter.snapshot()).toMatchObject({ waiting: 0, waitHighWaterObserved: 4 })
  })

  it('leaves the connecting peak at ZERO for a warm pool that only lends and takes back', () => {
    // Folding `connecting` inside a pool EVENT would read pg's own
    // mid-transition state as an establishment stall: `_release` emits before
    // pushing to `_idle`, so in between the client is in neither `idle` nor
    // `checkedOut` and the derivation reads 1 on a pool that established
    // nothing. The sequence below is pg's, in pg's order.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-connecting-warm')
    const a = FakePool.client()
    fake.totalCount = 2
    fake.idleCount = 2

    for (let cycle = 0; cycle < 3; cycle += 1) {
      fake.idleCount = 1 // `_pulseQueue` pops `_idle`…
      fake.emit('acquire', a) // …then `_acquireClient` emits
      fake.emit('release', undefined, a) // `_release` emits FIRST…
      fake.idleCount = 2 // …and only then pushes to `_idle`
    }

    expect(meter.snapshot()).toMatchObject({ connecting: 0, connectingHighWaterObserved: 0 })
  })

  it('records a connecting peak a SNAPSHOT can see, and keeps it after it clears', () => {
    // The positive control for the test above: folding at snapshot time is not
    // the same as not folding at all.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'peak-connecting')
    fake.totalCount = 6
    expect(meter.snapshot()?.connectingHighWaterObserved).toBe(6)
    fake.idleCount = 6
    expect(meter.snapshot()).toMatchObject({ connecting: 0, connectingHighWaterObserved: 6 })
  })
})

describe('poolMeter — oldestBorrowMs is the age of the borrow that will not end', () => {
  it('is null when nothing is checked out', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'age-empty')
    expect(meter.snapshot()?.oldestBorrowMs).toBeNull()
  })

  it('reports the OLDEST of two borrows, and forgets it on release', async () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'age')
    const older = FakePool.client()
    const newer = FakePool.client()

    fake.totalCount = 2
    fake.emit('acquire', older)
    await sleep(60)
    fake.emit('acquire', newer)

    // A meter reporting the NEWEST borrow lands near zero here.
    expect(meter.snapshot()?.oldestBorrowMs).toBeGreaterThanOrEqual(40)

    fake.emit('release', undefined, older)
    fake.idleCount = 1
    // A meter that never retired the released entry stays above 40.
    expect(meter.snapshot()?.oldestBorrowMs).toBeLessThan(40)
    expect(meter.snapshot()?.oldestBorrowMs).not.toBeNull()

    fake.emit('release', undefined, newer)
    fake.idleCount = 2
    expect(meter.snapshot()?.oldestBorrowMs).toBeNull()
  })
})

describe('poolMeter — the counters an operator greps for', () => {
  it('counts hand-offs, physical connections and removals apart', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'counters')
    const a = FakePool.client()

    fake.totalCount = 1
    fake.emit('connect', a)
    fake.emit('acquire', a)
    fake.emit('release', undefined, a)
    fake.emit('acquire', a) // reused: a second hand-off, NOT a second connection
    fake.emit('release', new Error('57P01'), a)
    fake.emit('remove', a)
    fake.totalCount = 0

    // A release carrying an ERROR — the `57P01` / `ECONNRESET` path that
    // `poolErrorGuard.ts` exists for — must retire the borrow like any other,
    // or `checkedOut` drifts upward by one on every dropped connection.
    expect(meter.snapshot()).toMatchObject({
      acquires: 2, releases: 2, connects: 1, removes: 1, checkedOut: 0, oldestBorrowMs: null,
    })
  })

  it('publishes max so a reader can tell "8 of 10" from "8 of 8"', () => {
    const fake = new FakePool()
    fake.options = { max: 4 }
    const meter = meterPool(fake.asPool(), 'max')
    expect(meter.snapshot()?.max).toBe(4)
  })
})

describe('poolMeter — the SECOND queue in front of the same pool', () => {
  it('is null on a pool with no gate', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'gateless')
    expect(meter.snapshot()?.gate).toBeNull()
  })

  it('publishes the gate a caller can be parked in while the pool looks calm', () => {
    // A caller waiting on `PoolConcurrencyGate` holds NO pg client, so the pool
    // counters alone look perfectly calm while the gate holds callers back. The
    // state below is exactly that: pool idle, gate full, someone waiting.
    const fake = new FakePool()
    const gate = poolConcurrencyGate(fake.asPool(), 2)
    const meter = meterPool(fake.asPool(), 'gated')
    fake.totalCount = 2
    fake.idleCount = 2

    const held = [gate.acquire(1_000), gate.acquire(1_000)]
    const parked = gate.acquire(1_000)

    const snapshot = meter.snapshot()
    expect(snapshot).toMatchObject({ checkedOut: 0, waiting: 0, connecting: 0, idle: 2 })
    expect(snapshot?.gate).toMatchObject({ limit: 2, inFlight: 2, liveQueueDepth: 1 })

    return Promise.all(held).then(async (permits) => {
      for (const permit of permits) permit.release()
      ;(await parked).release()
    })
  })
})

describe('poolMeter — a listener must not take down the process it watches', () => {
  it('counts a throwing handler instead of letting it escape', () => {
    // These four listeners run synchronously inside pg's emit, reached from a
    // socket read callback: an uncaught throw there is process death, with the
    // caller's `connect()` never settling and the client stranded because
    // `client.release` is assigned AFTER the `'acquire'` emit.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'hostile')
    Object.defineProperty(fake, 'waitingCount', {
      get() { throw new Error('counter exploded') },
      configurable: true,
    })

    expect(() => fake.emit('acquire', FakePool.client())).not.toThrow()

    // Restored so the snapshot can be read — the point is what the emit did.
    Object.defineProperty(fake, 'waitingCount', { value: 0, writable: true, configurable: true })
    expect(meter.snapshot()?.handlerFailures).toBe(1)
  })

  it('reports zero failures on a healthy pool — the control', () => {
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'not-hostile')
    fake.totalCount = 1
    fake.emit('acquire', FakePool.client())
    expect(meter.snapshot()?.handlerFailures).toBe(0)
  })
})

describe('poolMeterSnapshots — the registry', () => {
  it('returns the SAME meter when a pool is registered twice', () => {
    // A second meter on an already-busy pool starts at `checkedOut = 0` and
    // goes permanently negative on the first release, and both would appear
    // under one label, where consumers look entries up with
    // `.find(entry => entry.pool === label)`.
    const fake = new FakePool()
    const first = meterPool(fake.asPool(), 'twice-registered')
    fake.totalCount = 1
    fake.emit('acquire', FakePool.client())
    const second = meterPool(fake.asPool(), 'twice-registered-again')

    expect(second).toBe(first)
    expect(second.snapshot()?.checkedOut).toBe(1)
    expect(poolMeterSnapshots().filter((entry) => entry.pool.startsWith('twice-registered'))).toHaveLength(1)
  })


  it('lists a registered pool under its label', () => {
    const fake = new FakePool()
    fake.totalCount = 3
    fake.idleCount = 3
    meterPool(fake.asPool(), 'registry-listed')
    const found = poolMeterSnapshots().find((entry) => entry.pool === 'registry-listed')
    expect(found).toMatchObject({ total: 3, idle: 3 })
    fake.ending = true
    fake.ended = true
    poolMeterSnapshots()
  })

  it('KEEPS an ending pool that has not drained, and drops it once it has', () => {
    // The retirement predicate is `ended`, not `ending`, and the difference is
    // the whole point: pg-pool sets `ended` only when every client is gone, so
    // a pool held open by a client that was never given back (making
    // `pool.end()` never resolve) stays visible.
    const fake = new FakePool()
    const held = FakePool.client()
    meterPool(fake.asPool(), 'registry-draining')
    fake.totalCount = 1
    fake.emit('acquire', held)

    fake.ending = true
    fake.ended = false
    const draining = poolMeterSnapshots().find((entry) => entry.pool === 'registry-draining')
    expect(draining).toMatchObject({ ending: true, ended: false, checkedOut: 1 })

    fake.emit('release', undefined, held)
    fake.totalCount = 0
    fake.ended = true
    expect(poolMeterSnapshots().find((entry) => entry.pool === 'registry-draining')).toBeUndefined()
    // And it stays gone — pruning removed the entry, it did not merely filter it.
    expect(poolMeterSnapshots().find((entry) => entry.pool === 'registry-draining')).toBeUndefined()
  })

  it('does no I/O, so it can answer for a pool with nothing left to give', () => {
    // The property that makes this the instrument for an exhausted pool: a
    // census that had to borrow a connection would fail on the only case it
    // exists to describe. Asserted by construction — the fake pool has no
    // `connect` and no `query`, so a snapshot that reached for either would
    // throw here.
    const fake = new FakePool()
    const meter = meterPool(fake.asPool(), 'no-io')
    fake.totalCount = 10
    fake.waitingCount = 12
    for (let index = 0; index < 10; index += 1) fake.emit('acquire', FakePool.client())
    expect(() => meter.snapshot()).not.toThrow()
    expect(meter.snapshot()).toMatchObject({ total: 10, idle: 0, checkedOut: 10, waiting: 12 })
  })
})
