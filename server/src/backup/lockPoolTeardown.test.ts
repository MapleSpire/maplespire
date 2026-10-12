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
import {
  closeLockPoolWithCeiling,
  LOCK_POOL_CLOSE_CEILING_MS,
  type LockPoolLike,
} from './lockPoolTeardown.js'

type Logged = { event: string; fields?: Record<string, unknown> }

function recorder(): { log: (event: string, fields?: Record<string, unknown>) => void; lines: Logged[] } {
  const lines: Logged[] = []
  return { log: (event, fields) => { lines.push({ event, fields }) }, lines }
}

/** A pool whose `end()` the test resolves by hand, so "slow" needs no clock. */
function controllablePool(counters: Partial<LockPoolLike> = {}): {
  pool: LockPoolLike
  settle: () => void
  fail: (error: unknown) => void
} {
  let settle!: () => void
  let fail!: (error: unknown) => void
  const ending = new Promise<void>((resolveEnd, rejectEnd) => {
    settle = resolveEnd
    fail = rejectEnd
  })
  return {
    pool: { end: () => ending, ...counters },
    settle,
    fail,
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('closeLockPoolWithCeiling', () => {
  it('reports a prompt close and says nothing', async () => {
    const { log, lines } = recorder()
    const outcome = await closeLockPoolWithCeiling({ end: async () => {} }, log)
    expect(outcome).toBe('closed')
    expect(lines).toEqual([])
  })

  it('THE REGRESSION: a prompt close emits nothing after the ceiling elapses', async () => {
    // The demo stack logged `backup.drill_lock_pool_end_timeout` on EVERY run,
    // 29.999 s after the scheduler had already gone to sleep, because the
    // losing branch of a `Promise.race` kept a timer whose callback called
    // `log`. A detector that fires on 100 % of healthy runs cannot report the
    // leak it exists to catch.
    const { log, lines } = recorder()
    const outcome = await closeLockPoolWithCeiling({ end: async () => {} }, log)
    expect(outcome).toBe('closed')

    await vi.advanceTimersByTimeAsync(LOCK_POOL_CLOSE_CEILING_MS * 2)
    expect(lines).toEqual([])
  })

  it('leaves no timer armed behind it', async () => {
    // Kills the `clearTimeout` mutant specifically. Without this the clear is
    // NOT load-bearing — the module's header says so, because moving the log
    // out of the timer callback is what makes a stale timer harmless, and a
    // reader who assumes otherwise would be wrong.
    const { log } = recorder()
    await closeLockPoolWithCeiling({ end: async () => {} }, log)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('CAN FAIL: reports the ceiling, once, when the close does not settle', async () => {
    const { log, lines } = recorder()
    const { pool } = controllablePool({ totalCount: 2, idleCount: 1, waitingCount: 3 })
    const running = closeLockPoolWithCeiling(pool, log)

    // A LITERAL, not a fraction of the exported constant: a bound derived from
    // the constant under test agrees with any value that constant is given.
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(running).resolves.toBe('ceiling')

    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('backup.drill_lock_pool_end_timeout')
    expect(lines[0].fields).toMatchObject({
      afterMs: 30_000,
      totalCount: 2,
      idleCount: 1,
      waitingCount: 3,
      // The number the old message ASSERTED without ever looking at it.
      checkedOutCount: 1,
    })
  })

  it('does not fire the ceiling early', async () => {
    const { log, lines } = recorder()
    const { pool, settle } = controllablePool()
    const running = closeLockPoolWithCeiling(pool, log)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(lines).toEqual([])

    settle()
    await expect(running).resolves.toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lines).toEqual([])
  })

  it('reports a REJECTING close as its own fact, not as a leak', async () => {
    // Previously `end().catch(() => undefined)` swallowed this, the race
    // settled at once, and the orphaned timer then reported it 30 s later as
    // "a client was not given back" — one failure mis-named as another.
    const { log, lines } = recorder()
    const { pool, fail } = controllablePool({ totalCount: 1, idleCount: 1 })
    const running = closeLockPoolWithCeiling(pool, log)

    fail(new Error('connection terminated'))
    await expect(running).resolves.toBe('failed')

    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('backup.drill_lock_pool_end_failed')
    expect(lines[0].fields).toMatchObject({ error: 'connection terminated', checkedOutCount: 0 })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(lines).toHaveLength(1)
  })

  it('never throws — the call site is a `finally` inside the schedule loop', async () => {
    const { log } = recorder()
    await expect(
      closeLockPoolWithCeiling({ end: () => { throw new Error('synchronous') } }, log),
    ).resolves.toBe('failed')
    await expect(
      closeLockPoolWithCeiling({ end: async () => { throw new Error('asynchronous') } }, log),
    ).resolves.toBe('failed')
  })

  it('reports NULL, never zero, for a counter it could not take', async () => {
    // #56's fourth rule: a zero here reads as "no client is checked out",
    // which is a different fact from "nobody counted".
    const { log, lines } = recorder()
    const { pool } = controllablePool()
    const running = closeLockPoolWithCeiling(pool, log)
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(running).resolves.toBe('ceiling')
    expect(lines[0].fields).toMatchObject({
      totalCount: null,
      idleCount: null,
      waitingCount: null,
      checkedOutCount: null,
    })
  })

  it('reports NULL when only ONE counter is available — never NaN', async () => {
    // A QA lens flipped the `&&` in the guard to `||` and it SURVIVED: with one
    // counter present, `total - undefined` is NaN, which serialises to `null` in
    // JSON and so reads in the report as "nobody counted" while actually being
    // "counted wrongly" — one value worse than the #56 fourth rule the line
    // itself cites.
    const { log, lines } = recorder()
    const { pool } = controllablePool({ totalCount: 2 })
    const running = closeLockPoolWithCeiling(pool, log)
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(running).resolves.toBe('ceiling')
    expect(lines[0].fields).toMatchObject({ totalCount: 2, idleCount: null, checkedOutCount: null })
    expect(Number.isNaN(lines[0].fields?.checkedOutCount)).toBe(false)
  })

  it('honours a caller-supplied ceiling', async () => {
    const { log, lines } = recorder()
    const { pool } = controllablePool()
    const running = closeLockPoolWithCeiling(pool, log, 5_000)
    await vi.advanceTimersByTimeAsync(5_001)
    await expect(running).resolves.toBe('ceiling')
    expect(lines[0].fields).toMatchObject({ afterMs: 5_000 })
  })
})
