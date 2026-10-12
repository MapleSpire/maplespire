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

import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { readDrillOverlap, recordDrillRun, signDrillReport } from './drillReport.js'
import { abandonmentReport } from './drillAbandonment.js'
import { BACKUP_DRILL_RUNS_COLUMNS } from './schema.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * The drill-overlap consequence check, and the proof that it can FIRE.
 *
 * A detector that reports zero on a deployment running one scheduler reports
 * zero whether it works or not: *a gate must be able to fail*. So the first
 * tests here manufacture the defect and demand a non-zero count; the rest are
 * negative controls.
 *
 * Against a real cluster because the subject IS the SQL. A fake `Queryable`
 * returning canned rows would assert what this file already believes: the whole
 * question is whether Postgres's window frame and the strict `>` behave as
 * intended, and only Postgres can answer that.
 */

const URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

/** Its own table, in its own schema. `backup_drill_runs` is shared with every
 *  other DB-gated suite in this tree, and a test that inserted overlapping
 *  drills into it would make the PRODUCTION alert fire on a developer's
 *  database. */
const SCHEMA = `drill_overlap_${process.pid}`

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

const live = await reachable()
const suite = live ? describe : describe.skip
if (!live) console.warn(`[drillOverlap] no Postgres at ${URL} — skipping`)

// A suite that can evaporate is not a gate.
it.skipIf(!process.env.REQUIRE_DB_TESTS)('runs rather than skips when the run intends to exercise Postgres', () => {
  expect(live).toBe(true)
})

let pool: pg.Pool | null = null

async function db(): Promise<pg.Pool> {
  if (pool) return pool
  pool = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000 }), 'drillOverlap')
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
  return pool
}

/**
 * Run the production query against rows no other session can see.
 *
 * `readDrillOverlap` queries `backup_drill_runs` UNQUALIFIED, which resolves to
 * the TEMP table created here: `pg_temp` is searched first even though
 * `SHOW search_path` does not list it. So the production query reads the
 * fixture.
 *
 * The whole thing runs inside a transaction that is rolled back, so a suite
 * that inserted overlapping drills can never make the PRODUCTION alert fire on
 * a developer's database.
 */
async function withRuns<T>(
  rows: Array<{ id: string; started: string; finished: string; abandoned?: boolean }>,
  read: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await (await db()).connect()
  try {
    await client.query('BEGIN')
    await assertGuardWouldPass(client)
    // PRODUCTION's column list, not a copy of it. A hand-written fixture is
    // free to drift, and the drift would be invisible: a `CHECK (finished_at >=
    // started_at)` added to the real table would leave the backwards-row test
    // below asserting a state production can no longer reach.
    await client.query(`CREATE TEMP TABLE backup_drill_runs (${BACKUP_DRILL_RUNS_COLUMNS}) ON COMMIT DROP`)
    for (const row of rows) {
      await client.query(
        `INSERT INTO backup_drill_runs
           (id, started_at, finished_at, outcome, rto_ms, report_sha256, report)
         VALUES ($1, $2, $3, 'passed', 0, repeat('a', 64), $4)`,
        [row.id, row.started, row.finished, JSON.stringify(row.abandoned ? { abandoned: true } : {})],
      )
    }
    return await read(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/** Precondition: the schema has been bootstrapped. `readDrillOverlap` no longer
 *  probes `public.backup_drill_runs` first (it is one query, and treats a
 *  missing table as empty via SQLSTATE 42P01), so the temp-table fixture is
 *  read either way; this check keeps the suite from running against an
 *  unbootstrapped database. */
async function assertGuardWouldPass(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.backup_drill_runs') IS NOT NULL AS present`,
  )
  if (rows[0]?.present !== true) {
    throw new Error(
      'public.backup_drill_runs does not exist, so readDrillOverlap would short-circuit and '
      + 'every assertion in this file would be vacuous. Run the schema bootstrap first.',
    )
  }
}

const at = (hhmm: string): string => `2026-08-21T${hhmm}:00Z`

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await pool.end().catch(() => {})
  }
})

suite('drill overlap — it can FIRE', () => {
  it('finds an overlap that really happened', async () => {
    // THE test. Two schedulers dumping at once is the state the advisory lock
    // and the deadline exist to make impossible; a detector that cannot report
    // it when it is staged is decoration, and on a single-scheduler deployment
    // nothing else would ever reveal that.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('03:00') },
        { id: 'b', started: at('02:30'), finished: at('03:30') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(1)
    expect(found.consideredRuns).toBe(2)
    expect(found.lastOverlapAgeSeconds).toEqual(expect.any(Number))
  })

  it('counts RUNS rather than pairs when three pile up', async () => {
    // Three mutually overlapping runs are three pairs but two offending runs.
    // Reporting 3 would overstate the incident; reporting 1 would hide that a
    // third scheduler joined.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('03:00') },
        { id: 'b', started: at('02:30'), finished: at('03:30') },
        { id: 'c', started: at('02:45'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(2)
  })

  it('sees an overlap regardless of INSERTION order', async () => {
    // The rows arrive in finish order in production, not start order, and the
    // window frame orders by `started_at` precisely so that does not matter.
    const found = await withRuns(
      [
        { id: 'later-start', started: at('02:30'), finished: at('03:30') },
        { id: 'earlier-start', started: at('02:00'), finished: at('03:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(1)
  })

  it('catches a run entirely CONTAINED in another', async () => {
    const found = await withRuns(
      [
        { id: 'long', started: at('02:00'), finished: at('06:00') },
        { id: 'short', started: at('03:00'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(1)
  })
})

suite('drill overlap — and it must stay QUIET otherwise', () => {
  it('does NOT fire on back-to-back runs', async () => {
    // The negative control that matters most in production. The scheduler
    // starts its next tick immediately when a drill overruns its interval, so
    // `b.started_at == a.finished_at` is the ordinary healthy shape. A `>=`
    // here would page somebody on the first slow night, and an alarm that
    // fires on healthy runs re-hides the real event as surely as silence.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('03:00') },
        { id: 'b', started: at('03:00'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(0)
    expect(found.lastOverlapAgeSeconds).toBeNull()
  })

  it('does not fire on disjoint runs, or on a single run', async () => {
    const disjoint = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('03:00') },
        { id: 'b', started: at('05:00'), finished: at('06:00') },
      ],
      readDrillOverlap,
    )
    expect(disjoint.overlappingRuns).toBe(0)

    // A run cannot overlap itself — the self-join version of this check would
    // report 1 here without an `id <> id` guard nobody would have tested.
    const alone = await withRuns(
      [{ id: 'a', started: at('02:00'), finished: at('03:00') }],
      readDrillOverlap,
    )
    expect(alone.overlappingRuns).toBe(0)
  })

  it('reports an empty table as EMPTY, not as clean', async () => {
    const found = await withRuns([], readDrillOverlap)
    expect(found).toEqual({
      overlappingRuns: 0,
      lastOverlapAgeSeconds: null,
      marginalRuns: 0,
      abandonedRuns: 0,
      backwardsRuns: 0,
      implausibleRuns: 0,
      lastUnreliableAgeSeconds: null,
      // The field that keeps the zero honest: nothing was examined.
      consideredRuns: 0,
    })
  })
})

suite('drill overlap — the running maximum is over ALL earlier runs', () => {
  // The central claim — "the greatest finish time among ALL earlier-starting
  // runs" — needs its own fixtures: every fixture above is arranged so that
  // `min`, `max` and "the immediately preceding row" coincide, so replacing the
  // running maximum with a minimum, or the frame with a single-row lookback,
  // would change no answer there.

  it('sees an overlap with a LONG run that is not the immediate predecessor', async () => {
    // `c` starts after `b` has finished but while `a` is still running. Only a
    // running maximum over ALL earlier rows catches it: `min` looks at `b`,
    // and a one-row frame looks at `b` — both would report 1.
    const found = await withRuns(
      [
        { id: 'a-long', started: at('02:00'), finished: at('06:00') },
        { id: 'b-short', started: at('02:30'), finished: at('03:00') },
        { id: 'c-after-b', started: at('03:30'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(2)
    expect(found.consideredRuns).toBe(3)
  })

  it('orders by START, not by finish', async () => {
    // `a` starts first and finishes last. Ordering by `finished_at` would put
    // it after both others and hide the two overlaps it causes.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('09:00') },
        { id: 'b', started: at('03:00'), finished: at('04:00') },
        { id: 'c', started: at('05:00'), finished: at('06:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(2)
  })

  it('does not order by ID — two disjoint runs whose ids sort backwards', async () => {
    // The "disjoint" control above uses ids `a` and `b`, which happen to sort
    // in start order. Under an id ordering, ids that sort against time would
    // turn two runs that never met into a page.
    const found = await withRuns(
      [
        { id: 'zzz-first-in-time', started: at('02:00'), finished: at('03:00') },
        { id: 'aaa-second-in-time', started: at('05:00'), finished: at('06:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(0)
  })

  it('breaks ties on id, so runs sharing a start time are still ordered', async () => {
    // Without the `, id` tiebreaker the frame's contents are whatever the plan
    // happens to produce, which is a non-deterministic answer to a question
    // that pages somebody.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('04:00') },
        { id: 'b', started: at('02:00'), finished: at('04:00') },
        { id: 'c', started: at('02:00'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(2)
  })
})

suite('drill overlap — clock skew must not page', () => {
  it('writes off an apparent overlap smaller than the tolerance, and COUNTS it', async () => {
    // The two timestamps come from the drill PROCESS while the exclusion is a
    // Postgres lock, so two schedulers on two hosts stamp from two clocks — and
    // an incoming host trailing the outgoing one records an overlap that never
    // happened. Absorbing it silently would hide it, so it is counted where a
    // reader can see it.
    const found = await withRuns(
      [
        { id: 'outgoing', started: at('02:00'), finished: '2026-08-21T03:00:20Z' },
        { id: 'incoming', started: at('03:00'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(0)
    expect(found.lastOverlapAgeSeconds).toBeNull()
    expect(found.marginalRuns).toBe(1)
  })

  it('still pages for an overlap bigger than the tolerance', async () => {
    // The tolerance must not become a hiding place. A real exclusion failure
    // means two drills DUMPING at once, which lasts minutes.
    const found = await withRuns(
      [
        { id: 'a', started: at('02:00'), finished: at('03:00') },
        { id: 'b', started: at('02:50'), finished: at('04:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(1)
    expect(found.marginalRuns).toBe(0)
  })

  it('EXCLUDES an implausibly long window instead of letting it poison the scan', async () => {
    // Left in the scan, one forward-skewed row would raise the running maximum
    // above every later start and report 3 overlaps out of 3 healthy runs — a
    // page saying the exclusion failed when the clock jumped. Excluding it
    // without counting it would hide it, so both halves are asserted here.
    const found = await withRuns(
      [
        { id: 'clock-jumped', started: at('02:00'), finished: '2027-08-01T00:00:00Z' },
        { id: 'n1', started: at('05:00'), finished: at('06:00') },
        { id: 'n2', started: at('07:00'), finished: at('08:00') },
        { id: 'n3', started: at('09:00'), finished: at('10:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(0)
    expect(found.implausibleRuns).toBe(1)
    // Excluded from the scan, so it is not among the rows the answer covers.
    expect(found.consideredRuns).toBe(3)
    expect(found.lastUnreliableAgeSeconds).toEqual(expect.any(Number))
  })

  it('never reports a NEGATIVE age for a future-dated overlap', async () => {
    // `now() - started_at` is negative for a row stamped in the future, and a
    // negative age fed to a `< threshold` alert is a permanent page. This pins
    // the clamp.
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString()
    const laterFuture = new Date(Date.now() + 4 * 3_600_000).toISOString()
    const found = await withRuns(
      [
        { id: 'a', started: future, finished: laterFuture },
        { id: 'b', started: new Date(Date.now() + 3.5 * 3_600_000).toISOString(), finished: laterFuture },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(1)
    expect(found.lastOverlapAgeSeconds).toBe(0)
  })

  it('reports the age of the MOST RECENT overlap, not the oldest', async () => {
    // `expect.any(Number)` would accept an age read with `min` instead of
    // `max`, many times too large. An operator uses this number to decide
    // whether an incident is live.
    const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
    const found = await withRuns(
      [
        { id: 'old-a', started: hoursAgo(400), finished: hoursAgo(398) },
        { id: 'old-b', started: hoursAgo(399), finished: hoursAgo(397) },
        { id: 'recent-a', started: hoursAgo(5), finished: hoursAgo(3) },
        { id: 'recent-b', started: hoursAgo(4), finished: hoursAgo(2) },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(2)
    // ~4 h, not ~399 h. Generous bounds: the point is which overlap it named.
    expect(found.lastOverlapAgeSeconds!).toBeGreaterThan(3 * 3_600)
    expect(found.lastOverlapAgeSeconds!).toBeLessThan(6 * 3_600)
  })
})

suite('drill overlap — it says when it cannot see', () => {
  it('counts abandoned runs, whose window stops when the scheduler gave up', async () => {
    // An abandoned run records `finished_at` at the moment of giving up,
    // not at the moment the drill stopped — nobody knows that. So an overlap
    // beginning after it is invisible here, and a `0` computed over such rows
    // is INCOMPLETE rather than clean. Reporting the count is what lets an
    // operator tell the two apart.
    const found = await withRuns(
      [
        { id: 'gave-up', started: at('02:00'), finished: at('08:00'), abandoned: true },
        { id: 'next', started: at('09:00'), finished: at('10:00') },
      ],
      readDrillOverlap,
    )
    expect(found.overlappingRuns).toBe(0)
    expect(found.abandonedRuns).toBe(1)
    expect(found.consideredRuns).toBe(2)
  })

  it('counts a REAL abandonment, written by the real producer', async () => {
    // THE conjunctive test. Everything else here writes `{"abandoned": true}`
    // by hand, so nothing else connects the TypeScript field to the SQL that
    // reads it: rename `abandoned`, move it under the signed envelope, or drop
    // it, and only this test would notice `abandonedRuns` reporting 0 forever.
    //
    // So this goes through the whole chain the production path uses:
    // abandonmentReport -> signDrillReport -> recordDrillRun -> readDrillOverlap.
    const report = abandonmentReport(
      {
        reason: 'deadline',
        heldMs: 21_600_000,
        deadlineMs: 21_600_000,
        graceMs: 300_000,
        backendPid: 4242,
        lockKey: 7_243_119_002,
        // Present because the type requires them. Nothing enforces that here:
        // server `*.test.ts` files are excluded from `tsconfig.json`, so a
        // missing field surfaces only as a runtime throw.
        backendStart: '1787454350107573',
        lockLoss: null,
        lockWatch: { verdict: 'ours', ageMs: 2, checks: 1, fenced: true },
      },
      {
        startedAt: new Date(at('02:00')),
        bundleDirectory: '/var/lib/maplespire/backups/x',
        now: () => new Date(at('08:00')),
      },
    )

    const client = await (await db()).connect()
    try {
      await client.query('BEGIN')
      await assertGuardWouldPass(client)
      await client.query(`CREATE TEMP TABLE backup_drill_runs (${BACKUP_DRILL_RUNS_COLUMNS}) ON COMMIT DROP`)
      await recordDrillRun(client, signDrillReport(report, 'test-key', 'test'))

      const found = await readDrillOverlap(client)
      expect(found.consideredRuns).toBe(1)
      // The assertion the whole `abandoned` mechanism exists for.
      expect(found.abandonedRuns).toBe(1)
      expect(found.lastUnreliableAgeSeconds).toEqual(expect.any(Number))
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('does NOT count an ordinary run as abandoned', async () => {
    // The other half of the conjunction: a marker that is always true would
    // pass the test above and report every night as unreliable.
    const client = await (await db()).connect()
    try {
      await client.query('BEGIN')
      await assertGuardWouldPass(client)
      await client.query(`CREATE TEMP TABLE backup_drill_runs (${BACKUP_DRILL_RUNS_COLUMNS}) ON COMMIT DROP`)
      await client.query(
        `INSERT INTO backup_drill_runs
           (id, started_at, finished_at, outcome, rto_ms, report_sha256, report)
         VALUES ('ordinary', $1, $2, 'passed', 0, repeat('a', 64), $3)`,
        [at('02:00'), at('03:00'), JSON.stringify({ reportVersion: 1, outcome: 'passed' })],
      )

      const found = await readDrillOverlap(client)
      expect(found.consideredRuns).toBe(1)
      expect(found.abandonedRuns).toBe(0)
      expect(found.lastUnreliableAgeSeconds).toBeNull()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('counts BACKWARDS rows instead of letting them corrupt the answer', async () => {
    // No CHECK constraint forbids `finished_at < started_at`, and a clock that
    // jumped backwards mid-run produces one. Silently folding it into the
    // overlap arithmetic is how a detector starts lying.
    //
    // THREE rows, and the third is the point: with one backwards row and one
    // healthy one, `finished_at < started_at` and its inverse `>` would both
    // count 1. Two healthy rows make the two answers 1 and 2.
    const found = await withRuns(
      [
        { id: 'skewed', started: at('05:00'), finished: at('04:00') },
        { id: 'ordinary-1', started: at('06:00'), finished: at('07:00') },
        { id: 'ordinary-2', started: at('08:00'), finished: at('09:00') },
      ],
      readDrillOverlap,
    )
    expect(found.backwardsRuns).toBe(1)
    // Excluded from the scan — a row whose window runs backwards is not a
    // window — so the overlap answer covers the two that are left.
    expect(found.consideredRuns).toBe(2)
    expect(found.overlappingRuns).toBe(0)
  })

  it('does not count a ZERO-DURATION run as backwards', async () => {
    // `rto_ms >= 0` permits `finished_at = started_at`, and `<` vs `<=` is one
    // character: with `<=`, an instantaneous run would be reported as a
    // corrupt clock every night.
    const found = await withRuns(
      [{ id: 'instant', started: at('05:00'), finished: at('05:00') }],
      readDrillOverlap,
    )
    expect(found.backwardsRuns).toBe(0)
    expect(found.consideredRuns).toBe(1)
  })
})
