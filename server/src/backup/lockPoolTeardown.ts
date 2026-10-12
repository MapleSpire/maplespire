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
 * Close the drill's lock pool, bounded, and report what actually happened.
 *
 * The ceiling itself is not new and its reason is unchanged:
 * `connectionTimeoutMillis` does NOT cover `end()` — pg-pool's `ending` branch
 * waits for every client to come back and arms no timer, so one checked-out
 * client that is never given back makes `end()` never resolve and the
 * scheduler's `finally` eats the loop. That is #52's silent wedge.
 *
 * What IS new is where the reporting happens, and it is the whole point.
 *
 * **The measurement.** The previous shape was a `Promise.race` whose 30 s
 * `setTimeout` called `log(...)` from inside the timer callback and was never
 * cleared. `Promise.race` settles on the FIRST promise; the loser's timer keeps
 * running. So on every healthy run the pool closed in about a millisecond, the
 * race resolved, the scheduler moved on — and thirty seconds later the orphaned
 * timer fired and logged that "a client was not given back". Measured on the
 * demo stack, twice in ten minutes, with the ordering that proves it: this
 * teardown runs BEFORE `backup.drill_scheduler_sleeping`, and that line was
 * logged at 17:43:35.199 while the supposed timeout arrived at 17:44:05.198 —
 * 29.999 s AFTER the scheduler had already gone to sleep.
 *
 * So the line was false on 100 % of runs, and that is worse than noise: it is
 * a detector that can no longer report the leak it exists to catch, because a
 * real one would be indistinguishable from the background. Same family as
 * "a comment asserting a measured property cites the measurement", applied to
 * a log line — this one asserted a mechanism ("a client was not
 * given back") that nothing had checked.
 *
 * **The structural fix is not `clearTimeout` alone.** It is that no side effect
 * happens inside the timer callback at all: the timer only settles a value, and
 * every log is emitted on the awaited path, where the race has already chosen a
 * winner. A timer that merely resolves a promise nobody reads is garbage; one
 * that logs is a false alarm.
 *
 * The two are JOINTLY necessary, and that is a measurement rather than a
 * reading. A QA lens moved the log back inside the callback while leaving the
 * `clearTimeout` standing: it SURVIVED, because with the clear in place the two
 * placements are observationally identical. Only the pair — log inside AND no
 * clear — reproduces the demo defect, and it turns 7 of 9 cases red. So the
 * clear is not decoration and it is not the fix; it is one half of a guard whose
 * halves mask each other, which is a shape to score as a PAIR
 * before calling either one dead. `leaves no timer armed behind it` pins the
 * clear on its own so the pair cannot silently become a single point of failure.
 *
 * **And the report no longer asserts a cause.** `end()` being slow is a fact;
 * "a client was not given back" was an inference, and a wrong one whenever
 * `end()` was slow for another reason. The pool's own counters are cheap and
 * they are a measurement: `totalCount - idleCount` IS the number of checked-out
 * clients. A rejecting `end()` is now its own event rather than being swallowed
 * and then mis-reported as a leak thirty seconds later.
 *
 * Deliberately NOT `runTeardownSteps`, which has the correct timer handling and
 * would otherwise be the right reuse: it aggregates every outcome into one
 * thrown message, so telling a ceiling apart from a rejection would mean
 * parsing that string — a worse coupling than this twenty-line race. The
 * reason is recorded here so the next reader does not "fix" it back.
 */

/** What this needs of a `pg` Pool. Narrow on purpose: the test drives it with
 * a double, and a double that has to be a real Pool is a test about `pg`.
 *
 * The counters are OPTIONAL here and non-optional on `pg`'s own `Pool`, so the
 * `null` branch in `poolCounters` is unreachable from the single production
 * call site. It is kept and tested because this type admits a double that omits
 * them, and a partial double is exactly how the `NaN` below was found — named
 * rather than left to imply the branch is live. */
export type LockPoolLike = {
  end: () => Promise<void>
  readonly totalCount?: number
  readonly idleCount?: number
  readonly waitingCount?: number
}

export type LockPoolLogFn = (event: string, fields?: Record<string, unknown>) => void

export type LockPoolCloseOutcome = 'closed' | 'ceiling' | 'failed'

/** 30 s. The scheduler sleeps for hours afterwards, so this bounds nothing the
 * user waits on — it exists only so the loop survives a wedged `end()`. */
export const LOCK_POOL_CLOSE_CEILING_MS = 30_000

function poolCounters(pool: LockPoolLike): Record<string, unknown> {
  const total = pool.totalCount
  const idle = pool.idleCount
  return {
    totalCount: total ?? null,
    idleCount: idle ?? null,
    waitingCount: pool.waitingCount ?? null,
    // The number the old message asserted without ever looking. Null rather
    // than 0 when it could not be taken — #56's fourth rule: a zero here would
    // read as "no client is checked out", which is a different fact.
    checkedOutCount: typeof total === 'number' && typeof idle === 'number' ? total - idle : null,
  }
}

/**
 * Never throws FOR THE POOL AND SINK IT IS CALLED WITH, which is the claim that
 * can be made rather than the one that reads better. The one production call
 * site is a `finally` inside the scheduler's loop, and an exception there ends
 * the schedule.
 *
 * `end()` is fully covered: `Promise.resolve().then(...)` converts a synchronous
 * throw to a rejection, the race's arms never reject, and a late rejection after
 * the ceiling cannot become an unhandled one. `poolCounters` is safe for a real
 * pool — pg-pool's counters are property reads over `_clients` / `_idle`. What
 * is NOT guarded is `log` itself: a throwing sink escapes into the scheduler's
 * `finally` and ends the schedule. `drillScheduler`'s sink is
 * `console.log(JSON.stringify(...))` over numbers and strings, so the claim
 * holds there; the exported types admit anything, and a review lens was right
 * that the unqualified version of this sentence was false.
 */
export async function closeLockPoolWithCeiling(
  pool: LockPoolLike,
  log: LockPoolLogFn,
  ceilingMs: number = LOCK_POOL_CLOSE_CEILING_MS,
): Promise<LockPoolCloseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'ceiling'>((settle) => {
    timer = setTimeout(() => settle('ceiling'), ceilingMs)
    timer.unref?.()
  })
  try {
    // `end()` is started before the race so a synchronous throw from a double
    // (or a future pg) becomes a rejection rather than escaping this function.
    const closing = Promise.resolve()
      .then(() => pool.end())
      .then(() => 'closed' as const, (error: unknown) => ({ error }))
    const outcome = await Promise.race([closing, expired])
    if (outcome === 'closed') return 'closed'
    if (outcome === 'ceiling') {
      log('backup.drill_lock_pool_end_timeout', {
        detail: 'the lock pool did not close within the ceiling',
        afterMs: ceilingMs,
        ...poolCounters(pool),
      })
      return 'ceiling'
    }
    log('backup.drill_lock_pool_end_failed', {
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      ...poolCounters(pool),
    })
    return 'failed'
  } finally {
    if (timer) clearTimeout(timer)
  }
}
