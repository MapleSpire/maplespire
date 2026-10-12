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
 * THE GATE'S OWN WITNESSES.
 *
 * Every test here exists because a specific way of getting this wrong leaves a
 * permit permanently miscounted, and a miscounted permit does not fail
 * loudly — the bound simply stops binding (fails OPEN) or stops admitting
 * (fails CLOSED) while nothing throws. The two counters are the only
 * observable, so they are what the assertions are written against.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  PoolConcurrencyGate,
  PoolPermitTimeoutError,
  poolConcurrencyGate,
} from './poolConcurrencyGate.js'

/** A promise plus the handle to settle it, so a test can hold a permit open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('PoolConcurrencyGate — the bound', () => {
  it('admits up to `max` and parks the rest', async () => {
    const gate = new PoolConcurrencyGate(2)
    const held = [deferred(), deferred(), deferred()]
    const runs = held.map((d) => gate.run(1_000, () => d.promise))

    // Two ran; the third is parked. `await Promise.resolve()` is not enough —
    // `run` awaits `acquire`, which is itself async, so the microtask queue has
    // to drain further than one tick before `inFlightCount` is meaningful.
    await vi.waitFor(() => expect(gate.inFlightCount).toBe(2))
    expect(gate.queueDepth).toBe(1)

    held[0].resolve()
    await vi.waitFor(() => expect(gate.queueDepth).toBe(0))
    // STILL 2, not 3 and not 1: the permit was TRANSFERRED to the waiter, never
    // returned to the free pool. (A release-then-reacquire dip would not be
    // visible here; the barging test below is what catches it.)
    expect(gate.inFlightCount).toBe(2)

    held[1].resolve()
    held[2].resolve()
    await Promise.all(runs)
    expect(gate.inFlightCount).toBe(0)
    expect(gate.queueDepth).toBe(0)
  })

  it('gives the permit back when the work THROWS', async () => {
    const gate = new PoolConcurrencyGate(1)
    await expect(gate.run(1_000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(gate.inFlightCount).toBe(0)
  })

  it('gives the permit back when the work throws SYNCHRONOUSLY', async () => {
    // An `fn` that throws before its first `await` never yields, so a `finally`
    // reached only via a resolved promise would not run.
    const gate = new PoolConcurrencyGate(1)
    await expect(gate.run(1_000, () => { throw new Error('sync boom') })).rejects.toThrow('sync boom')
    expect(gate.inFlightCount).toBe(0)
  })

  it('does not let a caller arriving in the HAND-OFF TICK barge past a parked waiter', async () => {
    // Catches a release-then-reacquire hand-off (decrement `inFlight` before
    // waking, re-increment after). That dip opens and closes inside one
    // microtask drain, so counters alone cannot see it; it is visible only if a
    // caller STEPS INTO it. On a gate of one, a caller arriving in the hand-off
    // tick and the woken waiter would BOTH hold a permit.
    const gate = new PoolConcurrencyGate(1)
    const first = await gate.acquire(1_000)
    const parked = gate.acquire(1_000)
    await vi.waitFor(() => expect(gate.queueDepth).toBe(1))

    first.release()
    // Synchronously, in the same tick as the release: the barger.
    let bargerAdmitted = false
    const barger = gate.acquire(1_000).then((permit) => { bargerAdmitted = true; return permit })

    const parkedPermit = await parked
    expect(gate.inFlightCount).toBe(1)
    expect(bargerAdmitted).toBe(false)

    parkedPermit.release()
    ;(await barger).release()
    expect(gate.inFlightCount).toBe(0)
  })

  it('counts a DOUBLE release once — the failure that loosens the bound forever', async () => {
    const gate = new PoolConcurrencyGate(2)
    const permit = await gate.acquire(1_000)
    expect(gate.inFlightCount).toBe(1)
    permit.release()
    permit.release()
    permit.release()
    // Not -2. A permit released three times would hand three permits out of one
    // slot and permanently loosen `max` — failing OPEN, so nothing blocks to
    // reveal it.
    expect(gate.inFlightCount).toBe(0)
  })
})

describe('PoolConcurrencyGate — the deadline', () => {
  it('refuses a waiter that outlasts its deadline, and holds nothing after', async () => {
    const gate = new PoolConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(10_000, () => held.promise)
    await vi.waitFor(() => expect(gate.inFlightCount).toBe(1))

    const refused = await gate.acquire(20).then(() => null, (e: unknown) => e)
    expect(refused).toBeInstanceOf(PoolPermitTimeoutError)
    expect((refused as PoolPermitTimeoutError).limit).toBe(1)

    held.resolve()
    await running
    // THE POINT OF THE TEST. The refused waiter is still sitting in the array
    // when the permit is handed off; if `handOff` did not skip abandoned
    // waiters it would transfer the permit to a caller that has already
    // rejected, and `inFlightCount` would stay at 1 for the life of the
    // process. That is a permanent, silent, fail-CLOSED leak.
    expect(gate.inFlightCount).toBe(0)
    expect(gate.queueDepth).toBe(0)
  })

  it('a refused waiter does not consume the permit a later caller needs', async () => {
    const gate = new PoolConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(10_000, () => held.promise)
    await vi.waitFor(() => expect(gate.inFlightCount).toBe(1))

    await expect(gate.acquire(20)).rejects.toBeInstanceOf(PoolPermitTimeoutError)
    held.resolve()
    await running

    // The end-to-end statement of the same invariant: the gate still WORKS
    // after a refusal. A leaked permit would make this hang until the test
    // timed out, which is why it asserts a completed run rather than a counter.
    await expect(gate.run(50, async () => 'ok')).resolves.toBe('ok')
  })

  it('wakes a waiter that is ABOUT to time out, and the late timer is inert', async () => {
    // The other ordering: `handOff` reaches the waiter FIRST and the deadline
    // would expire immediately afterwards (the tests above cover
    // timer-then-handOff).
    //
    // If `clearTimeout` in the `finally` did not run, or if a late `reject`
    // could beat the already-resolved promise, this waiter would reject after
    // having been given a permit — and the permit would be lost for the life of
    // the process.
    const gate = new PoolConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(10_000, () => held.promise)
    await vi.waitFor(() => expect(gate.inFlightCount).toBe(1))

    const waiting = gate.acquire(30)
    held.resolve()
    await running
    const permit = await waiting
    expect(gate.inFlightCount).toBe(1)

    // Outlive the deadline that was armed for this waiter; it must not fire.
    await new Promise((resolve) => setTimeout(resolve, 60))
    permit.release()
    expect(gate.inFlightCount).toBe(0)
    await expect(gate.run(50, async () => 'still works')).resolves.toBe('still works')
  })

  it('reports a timed-out waiter as a TOMBSTONE, not as live demand', async () => {
    // `liveQueueDepth` exists because `queueDepth` over-reports during a
    // refusal storm — an abandoned waiter stays in the array until some release
    // drains it. The two numbers must be asserted to DISAGREE here, or a
    // `liveQueueDepth` that just returned `waiters.length` would pass.
    const gate = new PoolConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(10_000, () => held.promise)
    await vi.waitFor(() => expect(gate.inFlightCount).toBe(1))

    await expect(gate.acquire(20)).rejects.toBeInstanceOf(PoolPermitTimeoutError)
    expect(gate.queueDepth).toBe(1)
    expect(gate.liveQueueDepth).toBe(0)

    held.resolve()
    await running
    expect(gate.queueDepth).toBe(0)
    expect(gate.liveQueueDepth).toBe(0)
  })

  it('does not arm a deadline for a caller that never waits', async () => {
    // A permit available immediately must not be charged the deadline, and the
    // timer must not outlive the call — an un-cleared timer would keep a
    // reference to the gate for its whole duration.
    const gate = new PoolConcurrencyGate(1)
    await expect(gate.run(5, async () => 'immediate')).resolves.toBe('immediate')
    expect(gate.inFlightCount).toBe(0)
  })
})

describe('poolConcurrencyGate — one gate per POOL', () => {
  it('returns the SAME gate for the same pool object', () => {
    // `index.ts` builds a fresh `PostgresStorageAdapter` per promote-summary
    // request, so a per-instance gate would multiply by the number of live
    // adapters and bound nothing under load.
    const pool = {} as Pool
    expect(poolConcurrencyGate(pool, 4)).toBe(poolConcurrencyGate(pool, 4))
  })

  it('gives DIFFERENT pools different gates', () => {
    expect(poolConcurrencyGate({} as Pool, 4)).not.toBe(poolConcurrencyGate({} as Pool, 4))
  })

  it('keeps the FIRST caller`s bound — a later caller cannot loosen a bulkhead', () => {
    const pool = {} as Pool
    expect(poolConcurrencyGate(pool, 2).limit).toBe(2)
    expect(poolConcurrencyGate(pool, 99).limit).toBe(2)
  })

  it('never admits a bound below one', () => {
    // `Math.max(1, …)`: a zero or negative bound would park every caller
    // forever.
    expect(new PoolConcurrencyGate(0).limit).toBe(1)
    expect(new PoolConcurrencyGate(-5).limit).toBe(1)
  })
})
