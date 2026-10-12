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
import {
  abortGraceMs,
  bundleRootFrom,
  deadlineMs,
  intervalMs,
  maxDrillHoldMs,
  MINIMUM_DEADLINE_MS,
} from './drillSchedule.js'
import { DEFAULT_ABORT_GRACE_MS, DEFAULT_DRILL_DEADLINE_MS } from './drillTick.js'

/**
 * The scheduler's env readers.
 *
 * `drillScheduler.ts` calls `main()` at module scope, so a guard written there
 * cannot be executed by a test; these live in `drillSchedule.ts` instead. A
 * runtime guard nobody meets until the deploy is worth a static test.
 */

const HOUR = 3_600_000

describe('intervalMs', () => {
  it('defaults to a daily cadence', () => {
    expect(intervalMs({})).toBe(24 * HOUR)
  })

  it('reads a configured cadence', () => {
    expect(intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '6' })).toBe(6 * HOUR)
    expect(intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '  0.25  ' })).toBe(15 * 60_000)
  })

  it('THROWS rather than clamping an unreadable one', () => {
    // The units mistake an operator actually makes. A silent fall back to 24
    // would leave them believing in an hourly drill they do not have.
    expect(() => intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '6h' })).toThrow(/between 0.25 and 720/)
    expect(() => intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '0' })).toThrow()
    expect(() => intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '-1' })).toThrow()
    expect(() => intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '10000' })).toThrow()
  })
})

describe('deadlineMs (#54)', () => {
  it('defaults to the module default when the cadence is roomy', () => {
    expect(deadlineMs({}, 24 * HOUR)).toBe(DEFAULT_DRILL_DEADLINE_MS)
  })

  it('defaults DOWN to the cadence MINUS THE GRACE when the cadence is tight', () => {
    // A 1-hour schedule with a 6-hour ceiling would let one wedged run skip
    // five ticks before anything bounded it. And the subtraction is the point:
    // the maximum hold is deadline PLUS grace, so a default of exactly the
    // interval would still overrun it.
    expect(deadlineMs({}, HOUR)).toBe(HOUR - DEFAULT_ABORT_GRACE_MS)
  })

  it('reads a configured ceiling', () => {
    expect(deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '2' }, 24 * HOUR)).toBe(2 * HOUR)
    expect(deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '0.5' }, 24 * HOUR)).toBe(30 * 60_000)
  })

  it('REFUSES a ceiling whose hold — deadline PLUS GRACE — exceeds the cadence', () => {
    // A guard on the deadline alone would accept `DEADLINE_HOURS=24` on a 24 h
    // cadence, which holds the key for 24 h 5 min — past the next tick.
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '48' }, 24 * HOUR))
      .toThrow(/exceeds BACKUP_DRILL_INTERVAL_HOURS/)
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '24' }, 24 * HOUR))
      .toThrow(/plus the abort grace/)
    // …and just under is accepted, so the guard is a bound rather than a ban.
    expect(deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '23' }, 24 * HOUR)).toBe(23 * HOUR)
  })

  it('REFUSES a ceiling under the floor, in both the derived and the explicit form', () => {
    // A ceiling at or below `BackupDrillRtoDegraded`'s 15-minute threshold
    // would kill drills the monitoring still considers merely slow — and a
    // ceiling that kills a legitimate dump leaves no backup at all.
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '0.1' }, 24 * HOUR))
      .toThrow(/floor/)
    // Derived: the minimum permitted cadence is 0.25 h, which after the grace
    // leaves 10 minutes. That combination is refused rather than silently
    // producing a ceiling shorter than a legitimate drill.
    expect(() => deadlineMs({}, 0.25 * HOUR)).toThrow(/leaves only/)
    expect(MINIMUM_DEADLINE_MS).toBe(30 * 60_000)
  })

  it('THROWS on an unreadable or non-positive ceiling', () => {
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: 'six' }, 24 * HOUR)).toThrow(/positive number/)
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '0' }, 24 * HOUR)).toThrow(/positive number/)
    expect(() => deadlineMs({ BACKUP_DRILL_DEADLINE_HOURS: '-3' }, 24 * HOUR)).toThrow(/positive number/)
  })
})

describe('abortGraceMs (#54)', () => {
  it('defaults to the module default', () => {
    expect(abortGraceMs({})).toBe(DEFAULT_ABORT_GRACE_MS)
  })

  it('reads a configured grace, in SECONDS', () => {
    // Seconds, not hours, and not milliseconds. The unit is in the variable
    // name for the same reason `BACKUP_BUNDLE_ROOT` is not `BACKUP_DIRECTORY`.
    expect(abortGraceMs({ BACKUP_DRILL_ABORT_GRACE_SECONDS: '90' })).toBe(90_000)
  })

  it('REFUSES zero, which its own docstring called test-only', () => {
    // `runDrillTick` accepts a zero grace and should — a test passing options
    // directly may want to abandon instantly. An OPERATOR setting it has asked
    // for a container that kills itself before `runBackupDrill`'s teardown can
    // drop the isolated restore database it just created.
    expect(() => abortGraceMs({ BACKUP_DRILL_ABORT_GRACE_SECONDS: '0' })).toThrow(/positive/)
    expect(() => abortGraceMs({ BACKUP_DRILL_ABORT_GRACE_SECONDS: '-1' })).toThrow(/positive/)
    expect(() => abortGraceMs({ BACKUP_DRILL_ABORT_GRACE_SECONDS: 'later' })).toThrow(/positive/)
  })
})

describe('bundleRootFrom — #56, six days with no backup', () => {
  it('takes BACKUP_BUNDLE_ROOT', () => {
    expect(bundleRootFrom({ BACKUP_BUNDLE_ROOT: '/srv/backups' })).toBe('/srv/backups')
  })

  it('has a default', () => {
    expect(bundleRootFrom({})).toBe('/var/lib/maplespire/backups')
  })

  it('REFUSES the BACKUP_DIRECTORY-only pair the committed compose file shipped', () => {
    // A compose file setting only BACKUP_DIRECTORY cannot start the drill.
    // `scripts/maplespire-compose.test.mjs` gates the file, this gates the
    // guard the file would trip over — the two cover different halves.
    expect(() => bundleRootFrom({ BACKUP_DIRECTORY: '/var/lib/maplespire/backups' }))
      .toThrow(/BACKUP_BUNDLE_ROOT/)
  })

  it('accepts both together, since only the root is ambiguous', () => {
    expect(bundleRootFrom({ BACKUP_DIRECTORY: '/tmp/one', BACKUP_BUNDLE_ROOT: '/srv/all' }))
      .toBe('/srv/all')
  })
})

/**
 * `maxDrillHoldMs` — the number a sweep DELETES DATABASES by.
 *
 * It is the far end of a chain — `drillSchedule` → `drillScheduler` →
 * `bootSweepMinimumAgeMs` → `DROP DATABASE` — and every link in between is
 * tested against a value the caller supplies, so the value itself is pinned
 * here: replacing the body with `deadlineMs(...)` alone or with `interval`
 * must fail.
 */
describe('maxDrillHoldMs — deadline PLUS grace, never either alone', () => {
  it('is the SUM, which is what a live drill can actually hold for', () => {
    // The grace is not a rounding error: it is the five minutes in which an
    // aborted drill tears down its isolated restore database, and a sweep that
    // ignored it would be free to delete that database mid-teardown.
    const env = { BACKUP_DRILL_INTERVAL_HOURS: '24', BACKUP_DRILL_DEADLINE_HOURS: '6' }
    expect(maxDrillHoldMs(env)).toBe(6 * 3_600_000 + DEFAULT_ABORT_GRACE_MS)
  })

  it('is strictly greater than the deadline, and strictly less than the cadence', () => {
    // Two bounds that between them kill every plausible wrong body: returning
    // the deadline, returning the grace, returning the interval.
    const env = {
      BACKUP_DRILL_INTERVAL_HOURS: '12',
      BACKUP_DRILL_DEADLINE_HOURS: '4',
      BACKUP_DRILL_ABORT_GRACE_SECONDS: '600',
    }
    const interval = intervalMs(env)
    const hold = maxDrillHoldMs(env)

    expect(hold).toBeGreaterThan(deadlineMs(env, interval))
    expect(hold).toBeGreaterThan(abortGraceMs(env))
    expect(hold).toBeLessThanOrEqual(interval)
  })

  it('tracks the configuration rather than a constant', () => {
    const small = { BACKUP_DRILL_INTERVAL_HOURS: '2', BACKUP_DRILL_DEADLINE_HOURS: '1' }
    const large = { BACKUP_DRILL_INTERVAL_HOURS: '24', BACKUP_DRILL_DEADLINE_HOURS: '20' }
    expect(maxDrillHoldMs(large)).toBeGreaterThan(maxDrillHoldMs(small))
  })

  it('never exceeds the cadence — the invariant deadlineMs already enforces', () => {
    // Executable rather than a sentence: if this could exceed the interval, the
    // boot sweep would refuse to reclaim anything younger than a whole cadence
    // and the wedge case it exists for would never converge.
    for (const hours of ['1', '2', '6', '24']) {
      const env = { BACKUP_DRILL_INTERVAL_HOURS: hours }
      expect(maxDrillHoldMs(env)).toBeLessThanOrEqual(intervalMs(env))
    }
  })

  it('THROWS rather than returning a hold the cadence cannot fit', () => {
    // A half-hour cadence leaves 25 minutes once the default grace is
    // subtracted, which is under the deadline floor — so there is no valid hold
    // and `deadlineMs` refuses. The refusal is the behaviour, not an edge the
    // caller has to remember.
    expect(() => maxDrillHoldMs({ BACKUP_DRILL_INTERVAL_HOURS: '0.55' }))
      .toThrow(/leaves only/)
    // And it is the GRACE that decides where the cliff is, not the cadence
    // alone: the same cadence is fine with a smaller one.
    const kinder = { BACKUP_DRILL_INTERVAL_HOURS: '0.55', BACKUP_DRILL_ABORT_GRACE_SECONDS: '60' }
    expect(maxDrillHoldMs(kinder)).toBeLessThanOrEqual(intervalMs(kinder))
  })

  it('the cadence floor intervalMs advertises is NOT reachable, and that is pre-existing', () => {
    // `intervalMs` accepts 0.25 h, but `MINIMUM_DEADLINE_MS` is 30 minutes and
    // the grace must be positive, so any cadence at or below 30 minutes leaves
    // no valid deadline at ALL. The two guards disagree about the supported
    // range; this pins the current behaviour (a refusal) until that is
    // reconciled as a configuration decision.
    expect(() => intervalMs({ BACKUP_DRILL_INTERVAL_HOURS: '0.25' })).not.toThrow()
    expect(() => maxDrillHoldMs({
      BACKUP_DRILL_INTERVAL_HOURS: '0.25',
      BACKUP_DRILL_ABORT_GRACE_SECONDS: '1',
    })).toThrow(/leaves only/)
  })

  it('respects an explicit grace', () => {
    const env = {
      BACKUP_DRILL_INTERVAL_HOURS: '24',
      BACKUP_DRILL_DEADLINE_HOURS: '6',
      BACKUP_DRILL_ABORT_GRACE_SECONDS: '900',
    }
    expect(maxDrillHoldMs(env)).toBe(6 * 3_600_000 + 900_000)
  })

  it('the default configuration is the documented 6 h + 5 min', () => {
    expect(maxDrillHoldMs({})).toBe(DEFAULT_DRILL_DEADLINE_MS + DEFAULT_ABORT_GRACE_MS)
  })
})
