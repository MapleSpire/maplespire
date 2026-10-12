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

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  BOOT_SWEEP_CEILING_MS,
  bootSweepBudgetMs,
  bootSweepMinimumAgeMs,
  ORPHAN_MINIMUM_AGE_MS,
  sweepOrphanedRestoreDatabasesAtBoot,
} from './drillRunner.js'
import {
  DEFAULT_SWEEP_BUDGET_MS,
  DEFAULT_SWEEP_MAX_DROPS,
  DEFAULT_SWEEP_MAX_FAILURES,
  dropOrphanedRestoreDatabases,
  MINIMUM_SWEEPABLE_AGE_MS,
  POOL_CONNECT_TIMEOUT_MS,
  type OrphanedRestoreSweep,
} from './backupRestore.js'
import { DEFAULT_ABORT_GRACE_MS, DEFAULT_DRILL_DEADLINE_MS } from './drillTick.js'

/**
 * Reclaiming what a previous PROCESS left behind.
 *
 * Two properties carry everything here and they pull in opposite directions:
 *
 *  - it must never prevent a drill (a JANITORIAL step sits in front of the copy
 *    and could abort it), and
 *  - it must never delete a database a LIVE drill is using, which is the only
 *    way a cleanup task can destroy data.
 *
 * A test that only asserted "it swept" would pass on an implementation that
 * violates either.
 */

const HOUR = 3_600_000

const clean: OrphanedRestoreSweep = {
  candidates: 2, dropped: ['maplespire_restore_a', 'maplespire_restore_b'], failed: [],
  failedCount: 0, remaining: 0, completed: true, stoppedBy: 'exhausted',
}

interface Recorded {
  readonly events: Array<[string, Record<string, unknown>]>
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  readonly names: () => string[]
  readonly find: (event: string) => Record<string, unknown> | undefined
}

function recorder(): Recorded {
  const events: Array<[string, Record<string, unknown>]> = []
  return {
    events,
    log: (event, fields = {}) => { events.push([event, fields]) },
    names: () => events.map(([name]) => name),
    find: (event) => events.find(([name]) => name === event)?.[1],
  }
}

describe('bootSweepMinimumAgeMs — what a live drill elsewhere can still own', () => {
  it('never goes below the floor the sweep itself refuses to cross', () => {
    // Asserted against `MINIMUM_SWEEPABLE_AGE_MS` rather than against a copy of
    // its value: `dropOrphanedRestoreDatabases` THROWS below that floor, so a
    // derivation that undercut it would turn every boot sweep into a logged
    // failure — silently, since the failure is swallowed by design. Lowering
    // one and forgetting the other fails here.
    //
    // STRICTLY greater: `>=` would pass with the six-hour floor collapsed onto
    // the one-hour hard minimum. The floor is a deliberate multiple of the hard
    // minimum, not the hard minimum itself.
    expect(bootSweepMinimumAgeMs(0)).toBe(ORPHAN_MINIMUM_AGE_MS)
    expect(bootSweepMinimumAgeMs(0)).toBeGreaterThan(MINIMUM_SWEEPABLE_AGE_MS)
    expect(bootSweepMinimumAgeMs(60_000)).toBeGreaterThan(MINIMUM_SWEEPABLE_AGE_MS)
    // An hourly cadence derives a 55-minute deadline, which is the smallest
    // hold this deployment can configure and is UNDER the floor.
    expect(bootSweepMinimumAgeMs(55 * 60_000 + DEFAULT_ABORT_GRACE_MS))
      .toBeGreaterThan(MINIMUM_SWEEPABLE_AGE_MS)
  })

  it('rises with the deployment\'s own maximum hold, rather than staying at the floor', () => {
    // The derivation, and the reason it is not simply the six-hour constant:
    // this sweep runs with NO advisory lock, so a rival mid-drill is not
    // excluded by anything but age. A deployment that raised its deadline would
    // otherwise have a boot sweep able to delete a database that rival is
    // restoring into.
    const generous = 20 * HOUR
    expect(bootSweepMinimumAgeMs(generous)).toBe(generous)
    expect(bootSweepMinimumAgeMs(generous)).toBeGreaterThan(bootSweepMinimumAgeMs(0))
  })

  it('covers the default configuration with room to spare', () => {
    const defaultHold = DEFAULT_DRILL_DEADLINE_MS + DEFAULT_ABORT_GRACE_MS
    expect(bootSweepMinimumAgeMs(defaultHold)).toBeGreaterThanOrEqual(defaultHold)
  })
})

describe('sweepOrphanedRestoreDatabasesAtBoot — it may never prevent a drill', () => {
  it('sweeps at the derived age and reports what it reclaimed', async () => {
    const seen: Array<{ url: string; minimumAgeMs: number; budgetMs?: number }> = []
    const log = recorder()
    const outcome = await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 20 * HOUR,
      budgetMs: 1_234,
      log: log.log,
      sweep: async (url, options) => {
        seen.push({ url, minimumAgeMs: options.minimumAgeMs, budgetMs: options.budgetMs })
        return clean
      },
    })

    expect(outcome).toEqual(clean)
    // The URL and the budget really reach the sweep. Dropping either would
    // still return `clean` from this fixture.
    expect(seen).toEqual([{ url: 'postgres://x/y', minimumAgeMs: 20 * HOUR, budgetMs: 1_234 }])
    expect(log.find('backup.drill_boot_sweep')).toMatchObject({
      minimumAgeMs: 20 * HOUR, candidates: 2, dropped: 2, failed: 0, remaining: 0, completed: true,
    })
    // A healthy pass is silent about failure. An event that also fires on a
    // clean boot re-hides the real one.
    expect(log.names()).not.toContain('backup.drill_boot_sweep_failed')
    expect(log.names()).not.toContain('backup.drill_boot_sweep_timeout')
  })

  it('a sweep that THROWS is logged and swallowed, never re-thrown', async () => {
    // A janitorial step stands in front of the copy, and a throw would take `main()` down before a single byte was dumped — turning a
    // cluster with some litter in it into a cluster with no backups.
    const log = recorder()
    await expect(sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: log.log,
      sweep: () => Promise.reject(new Error('permission denied for database postgres')),
    })).resolves.toBeNull()

    expect(log.find('backup.drill_boot_sweep_failed')).toMatchObject({
      error: 'permission denied for database postgres',
    })
  })

  it('a sweep that throws SYNCHRONOUSLY is swallowed too', async () => {
    // The test above passes a REJECTION. `sweep` is typed
    // `(url, options) => Promise<…>`, and a non-`async` function throwing
    // synchronously satisfies that type — such a throw escapes before any `try`
    // around the await and would reach `main()`, which under `restart: always`
    // means no backups at all.
    const log = recorder()
    await expect(sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: log.log,
      sweep: (): Promise<OrphanedRestoreSweep> => { throw new Error('parseDatabaseUrl threw') },
    })).resolves.toBeNull()

    expect(log.find('backup.drill_boot_sweep_failed')).toMatchObject({
      error: 'parseDatabaseUrl threw',
    })
  })

  it('a log sink that throws cannot fail the drill either', async () => {
    // The guarantee is "this may never prevent a drill", and `log` is
    // caller-supplied. A logger with a full disk deciding whether tonight's
    // backup happens is the same shape one layer down.
    await expect(sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: () => { throw new Error('ENOSPC') },
      sweep: async () => clean,
    })).resolves.toEqual(clean)
  })

  it('caps a BOOT sweep below the teardown cap, because boots repeat faster', async () => {
    // `maxDrops` bounds I/O, and each drop is a cluster-wide
    // CHECKPOINT_IMMEDIATE on the production cluster. The teardown sweep pays
    // that at most once per cadence; this one pays it once per process START,
    // which is the pathological variable in exactly the restart loop it exists
    // for. Same cap in both places would turn a crash loop into an I/O event.
    //
    // Compared against `DEFAULT_SWEEP_MAX_DROPS`, never against the literal 5:
    // a relation written as two independent numbers is a relation nothing
    // keeps.
    const seen: number[] = []
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: recorder().log,
      sweep: async (_url, options) => {
        seen.push(options.maxDrops ?? DEFAULT_SWEEP_MAX_DROPS)
        return clean
      },
    })

    expect(seen).toHaveLength(1)
    // EXACTLY the derived value, not a range: a range like
    // `<= DEFAULT_SWEEP_MAX_DROPS / 2` and `> 0` would let a cap of ONE through,
    // silently halving the boot sweep's reclamation rate.
    //
    // Written as the expression rather than as `2`, so the relation survives a
    // change to `DEFAULT_SWEEP_MAX_DROPS`; the literal that the code cannot
    // move lives in `backupRestore.test.ts`.
    expect(seen[0]).toBe(Math.max(1, Math.floor(DEFAULT_SWEEP_MAX_DROPS / 2)))
    // …and never zero, or a restart loop reclaims nothing at all. Kept beside
    // the exact assertion because it is the property the `Math.max(1, …)`
    // exists for, and it stays true for every value of the cap.
    expect(seen[0]).toBeGreaterThan(0)
  })

  it('does NOT halve the failure cap along with the drop cap', async () => {
    // The drop cap is halved here because it bounds CHECKPOINT I/O and a boot
    // repeats faster than a cadence. A failed drop performs no checkpoint, so
    // the same reasoning does not reach `maxFailures` — and halving it would
    // re-introduce, at half the threshold, the starvation separate caps exist
    // to prevent: two undroppable databases at the head of the
    // oldest-first list stopping every boot sweep forever, silently, with
    // `completed: true`.
    //
    // Asserted on the EFFECTIVE cap rather than on the absence of a line: a
    // future edit could pass `DEFAULT_SWEEP_MAX_FAILURES` explicitly and should
    // still pass, while any fraction of it must fail.
    const seen: Array<number | undefined> = []
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: recorder().log,
      sweep: async (_url, options) => {
        seen.push(options.maxFailures ?? DEFAULT_SWEEP_MAX_FAILURES)
        return clean
      },
    })

    // The relation below is NOT the detector (a halved failure cap still clears
    // a drop cap of 2); it states WHY the cap matters — the failure cap must
    // stay above the drop cap or failures exhaust the pass before a
    // reclaimable database is reached.
    //
    // Against the EFFECTIVE boot cap rather than `MAX_DROPS / 2`: that
    // expression is 2.5 while the cap is `Math.max(1, Math.floor(5 / 2))` = 2,
    // so it compared the new constant against a number the code never uses.
    const bootDropCap = Math.max(1, Math.floor(DEFAULT_SWEEP_MAX_DROPS / 2))
    expect(seen[0]!).toBeGreaterThan(bootDropCap)
  })

  it('reclaims past the undroppable litter a boot sweep actually meets', async () => {
    // The behavioural half, driving the REAL sweep rather than a seam that
    // reports whatever it is handed: the seam tests above pin the numbers that
    // are PASSED, not that the loop honours them.
    //
    // Two stubborn databases in front, which is exactly the boot drop cap, so
    // this case only passes if failures and drops have separate caps.
    //
    // The stamps are literal and tiny on purpose. They are base-36 offsets from
    // the epoch, so `a1` dates to 361 ms and reads as decades old — clearing
    // the boot floor with no clock arithmetic — and all three are the same
    // LENGTH, which is what makes the sweep's lexicographic `.sort()`
    // chronological. `a1 < a2 < zz`, so the two failures lead the walk, which
    // is the position that does the starving.
    const stubborn = ['maplespire_restore_a1_deadbeef', 'maplespire_restore_a2_deadbeef']
    const good = 'maplespire_restore_zz_deadbeef'
    const attempted: string[] = []
    const query = async (text: string) => {
      if (text.includes('FROM pg_database')) {
        return { rows: [...stubborn, good].map((datname) => ({ datname })) }
      }
      const name = /"([^"]+)"/.exec(text)?.[1] ?? ''
      attempted.push(name)
      // The real cluster's wording AND its SQLSTATE, measured: an ownership
      // error is the permanent, instant failure under test, and `42501` is what makes the sweep treat it as a refusal of THIS
      // database rather than as the connection dying.
      if (stubborn.includes(name)) {
        throw Object.assign(new Error(`must be owner of database ${name}`), { code: '42501' })
      }
      return { rows: [] }
    }
    const pool = {
      on: () => pool,
      end: async () => undefined,
      query,
      // An EventEmitter, because the sweep attaches an `error` listener to the
      // client it checks out — a plain object makes the whole call throw, and a
      // fake that cannot emit would hide an unhandled client `error` (i.e. the
      // death of the drill container).
      connect: async () => Object.assign(new EventEmitter(), {
        query, release: () => undefined,
      }),
    }

    const outcome = await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://u:p@127.0.0.1:1/source',
      maxDrillHoldMs: 6 * HOUR,
      log: recorder().log,
      sweep: (url, options) => dropOrphanedRestoreDatabases(url, {
        ...options,
        createPool: () => pool as never,
      }),
    })

    // The point: the reclaimable one is reached.
    expect(outcome?.dropped).toEqual([good])
    expect(outcome?.failed).toHaveLength(2)
    expect(attempted).toHaveLength(3)
  })

  it('stops STARTING drops before the ceiling fires, so at most one outlives it', async () => {
    // The timeout line claims exactly this — "at most one drop in flight" — and
    // it is true only because the sweep's own budget expires first (same shape
    // as `DEFAULT_ABORT_GRACE_MS > TEARDOWN_STEP_TIMEOUT_MS`, gated next door).
    expect(DEFAULT_SWEEP_BUDGET_MS).toBeLessThan(BOOT_SWEEP_CEILING_MS)

    // …but that assertion alone is not the guard it reads as. The sweep arms
    // its budget AFTER the admin connect, so the latest a drop may START is
    // `connect + budget`; with the shipped defaults that would be
    // 30 000 + 30 000 = EXACTLY the ceiling. So the relation is asserted on the
    // budget the boot sweep ACTUALLY passes down. A call site that reverts to
    // `budgetMs: options.budgetMs` fails here.
    const passed: Array<number | undefined> = []
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: recorder().log,
      sweep: async (_url, options) => { passed.push(options.budgetMs); return clean },
    })

    expect(passed).toHaveLength(1)
    expect(passed[0]).toBeDefined()
    expect(POOL_CONNECT_TIMEOUT_MS + passed[0]!).toBeLessThan(BOOT_SWEEP_CEILING_MS)
    // A literal beside the derivation, because a value derived from the
    // constants it is asserted against agrees with any value those constants
    // are given. 60 000 − 30 000 − 5 000. Change any of the three deliberately
    // and this line is where you say so.
    expect(passed[0]).toBe(25_000)
    // An explicit budget from the caller still wins: this is a DEFAULT, and the
    // drill scheduler is entitled to name its own.
    const explicit: Array<number | undefined> = []
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      budgetMs: 1_234,
      log: recorder().log,
      sweep: async (_url, options) => { explicit.push(options.budgetMs); return clean },
    })
    expect(explicit).toEqual([1_234])
  })

  it('shortens the budget with the EFFECTIVE ceiling, not with the constant', async () => {
    // `bootSweepBudgetMs` is a function of the ceiling precisely so "a caller
    // that shortens the ceiling shortens this with it". This pins that the
    // EFFECTIVE `ceilingMs` is used, not `BOOT_SWEEP_CEILING_MS`.
    const shortened: Array<number | undefined> = []
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      ceilingMs: 45_000,
      log: recorder().log,
      sweep: async (_url, options) => { shortened.push(options.budgetMs); return clean },
    })
    // 45 000 − 30 000 − 5 000, and it must stay strictly inside the ceiling it
    // was derived from, which is the property the whole derivation exists for.
    expect(shortened).toEqual([10_000])
    expect(POOL_CONNECT_TIMEOUT_MS + shortened[0]!).toBeLessThan(45_000)

    // The floor. A ceiling below the connect timeout makes the subtraction
    // meaningless — it goes negative — and a budget of zero or less starts no
    // drops at all, so a test that shortened the ceiling far enough would get a
    // sweep that silently reclaims nothing rather than one that reclaims a
    // little. Latent in production (nothing passes a ceiling that short) but
    // asserted anyway.
    expect(bootSweepBudgetMs(10_000)).toBe(1_000)
    expect(bootSweepBudgetMs(BOOT_SWEEP_CEILING_MS)).toBe(25_000)
  })

  it('keeps the progress a sweep made before it THREW, not only before it hung', async () => {
    // The failure path keeps partial progress for the same reason as the
    // timeout path. A sweep that reclaimed two
    // databases and then failed would otherwise report nothing at all — which
    // reads as "there was nothing to do" on the one boot where there was.
    const log = recorder()
    const outcome = await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: log.log,
      sweep: async (_url, options) => {
        options.onProgress?.({
          candidates: 4, dropped: ['a', 'b'], failed: [], failedCount: 0, remaining: 2,
          completed: false, stoppedBy: null,
        })
        throw new Error('connection terminated unexpectedly')
      },
    })

    expect(outcome).toMatchObject({ dropped: ['a', 'b'], remaining: 2, completed: false })
    expect(log.find('backup.drill_boot_sweep_failed')).toMatchObject({
      dropped: 2, remaining: 2, minimumAgeMs: 6 * HOUR,
    })
  })

  it('names the age it deleted by, on the line where it could not finish', async () => {
    // `minimumAgeMs` is the number databases were destroyed by. On the timeout
    // line it is the only record of which gate was in force for the drops that
    // DID happen, and an operator reading a partial sweep needs it.
    const log = recorder()
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 20 * HOUR,
      ceilingMs: 40,
      log: log.log,
      sweep: () => new Promise<never>(() => {}),
    })

    expect(log.find('backup.drill_boot_sweep_timeout')).toMatchObject({ minimumAgeMs: 20 * HOUR })
  })

  it('a sweep that HANGS is stepped over rather than waited on', async () => {
    // The faithful fixture. `DROP DATABASE ... WITH (FORCE)` forces a
    // checkpoint and WAITS for it, so the failure mode of this subsystem is a
    // wait, not a rejection — a test that only covered the throw would stay
    // green over the path that wedges the boot.
    const log = recorder()
    const started = Date.now()
    await expect(sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      ceilingMs: 60,
      log: log.log,
      sweep: () => new Promise<never>(() => {}),
    })).resolves.toBeNull()

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(log.find('backup.drill_boot_sweep_timeout')).toMatchObject({ ceilingMs: 60 })
  })

  it('keeps the progress a hung sweep had already made', async () => {
    // Conjunctive: the drill is not blocked AND the two databases it did drop
    // are reported. Without `onProgress`, a sweep that reclaimed two and then
    // blocked reports nothing — a pass reporting from inside itself, which
    // reads as "there was nothing to do".
    const log = recorder()
    const outcome = await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      ceilingMs: 80,
      log: log.log,
      sweep: async (_url, options) => {
        options.onProgress?.({
          candidates: 5, dropped: ['a', 'b'], failed: [], failedCount: 0, remaining: 3,
          completed: false, stoppedBy: null,
        })
        return new Promise<never>(() => {})
      },
    })

    expect(outcome).toMatchObject({ dropped: ['a', 'b'], remaining: 3, completed: false })
    expect(log.find('backup.drill_boot_sweep_timeout')).toMatchObject({
      candidates: 5, dropped: 2, remaining: 3, completed: false,
    })
  })

  it('reports NULLS, not zeros, when nothing could be counted', async () => {
    // Nulls, never zeros, when a count could not be taken: `dropped: 0` beside a
    // timeout reads as "the cluster was
    // clean", which is the one thing this run did not establish — and this line
    // is what an operator reads to decide whether to go looking.
    const log = recorder()
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      ceilingMs: 40,
      log: log.log,
      sweep: () => new Promise<never>(() => {}),
    })

    expect(log.find('backup.drill_boot_sweep_timeout')).toMatchObject({
      candidates: null, dropped: null, failed: null, remaining: null, completed: false,
    })
  })

  it('a sweep that failed on every candidate does not read as a clean cluster', async () => {
    // `dropped: 0` alone is indistinguishable from "there was nothing to do".
    // The failures are counted AND named, because a repeating failure on the
    // same database every boot is the case worth seeing.
    const log = recorder()
    await sweepOrphanedRestoreDatabasesAtBoot({
      databaseUrl: 'postgres://x/y',
      maxDrillHoldMs: 6 * HOUR,
      log: log.log,
      sweep: async () => ({
        candidates: 2, dropped: [], failed: ['maplespire_restore_a: in use'], failedCount: 1,
        remaining: 1, completed: true, stoppedBy: 'failures',
      }),
    })

    expect(log.find('backup.drill_boot_sweep')).toMatchObject({
      dropped: 0, failed: 1, failures: ['maplespire_restore_a: in use'],
    })
  })

  it('the default ceiling is finite and far beyond a measured forced drop', () => {
    // 2.4 s was the worst `DROP DATABASE ... WITH (FORCE)` measured here under
    // contention. A ceiling near that would abandon healthy sweeps; an infinite
    // one would be the wait this whole function exists to bound.
    //
    // A bound the same order as the scheduler's own cadence floor bounds
    // nothing, because this delay sits in FRONT of the first drill. Five minutes is two orders of magnitude above the measurement and a third
    // of the shortest cadence the scheduler will accept.
    expect(BOOT_SWEEP_CEILING_MS).toBeGreaterThan(10_000)
    expect(BOOT_SWEEP_CEILING_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})
