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
import { guardIdleClientErrors } from './poolErrorGuard.js'
import {
  acquireSessionAdvisoryLock,
  advisoryLockHeldByThisSession,
  checkAdvisoryLockOwnership,
  DEFAULT_KEEPALIVES,
  terminateAdvisoryLockHolder,
} from './sessionAdvisoryLock.js'

/**
 * Against a real Postgres, because every claim this module makes is a claim
 * about Postgres: that a session lock dies with its backend, that `pg_locks`
 * attributes it to a pid, that `pg_advisory_unlock` answers `false` rather than
 * raising. A fake pool would agree with any implementation.
 *
 * ## Why the timings are small
 *
 * The real failure needs `pg-pool`'s default `idleTimeoutMillis` of 10 000 ms
 * to elapse (a lock taken through `pool.query` was held at t+9 s, gone at
 * t+11 s). The pools here set `idleTimeoutMillis: 150` and wait 900 ms: the
 * mechanism is identical, only its clock is turned down.
 *
 * So the shortened clock is shown to still discriminate, the first `describe`
 * runs BOTH arms — the naive `pool.query` shape and the held-client shape — on
 * identically-configured pools. If the wait were ever too short, the control
 * arm would stop failing and take the file with it.
 */

const URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

/** Advisory locks are per-DATABASE and vitest runs many workers against one,
 * so keys are spread by pid. The range [9.0e9, 9.4e9] must stay DISJOINT from
 * `drillTick.integration.test.ts`'s [9.5e9, 9.9e9], or two workers can land on
 * the same key. */
let nextKey = 9_000_000_000 + (process.pid % 400_000) * 1_000
const freshKey = (): number => (nextKey += 1)

/** The database name out of the URL, for the GRANT/REVOKE the cross-role case
 *  needs. Parsed rather than hardcoded: this file runs against whatever
 *  `TEST_DATABASE_URL` points at.
 *
 *  `globalThis.URL` because this file's own `URL` constant shadows the
 *  constructor. */
const DATABASE = new globalThis.URL(URL).pathname.slice(1) || 'postgres'

/** Named per worker, because vitest runs many against one cluster and a role is
 *  CLUSTER-wide — two workers sharing one name would drop it under each other's
 *  feet mid-assertion. */
const STRANGER_ROLE = `maplespire_stranger_${process.pid}`

const IDLE_TIMEOUT_MS = 150
const WAIT_MS = 900

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function probe(): Promise<boolean> {
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

const reachable = await probe()
const suite = reachable ? describe : describe.skip
if (!reachable) console.warn(`[sessionAdvisoryLock] no Postgres at ${URL} — skipping`)

// `check-test-skips.mjs` catches an undeclared skip across a full run; this
// catches the same thing here, beside the assertions it protects.
it.skipIf(!process.env.REQUIRE_DB_TESTS)('runs rather than skips when the run intends to exercise Postgres', () => {
  expect(reachable).toBe(true)
})

const opened: pg.Pool[] = []
function lockPool(): pg.Pool {
  const pool = guardIdleClientErrors(new pg.Pool({
    connectionString: URL,
    max: 1,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 4000,
  }), 'sessionAdvisoryLock:pool')
  opened.push(pool)
  return pool
}

/** An INDEPENDENT connection. Asking the holder whether it still holds the lock
 *  would be the witness deriving from the thing being proven. */
async function rivalCanAcquire(key: number): Promise<boolean> {
  const rival = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
  await rival.connect()
  try {
    const { rows } = await rival.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [key],
    )
    const got = rows[0]?.locked === true
    if (got) await rival.query('SELECT pg_advisory_unlock($1)', [key])
    return got
  } finally {
    await rival.end().catch(() => {})
  }
}

afterAll(async () => {
  // BOUNDED on purpose. A pool whose client is checked out and never given
  // back can NEVER end: pg-pool waits for every client and arms no timer. The
  // termination suite below can produce exactly that, and an unbounded
  // teardown would report the whole file as a hook timeout beside a green run.
  // (`drillScheduler` races its own `lockPool.end()` for the same reason.)
  await Promise.all(opened.map((pool) => Promise.race([
    pool.end().catch(() => {}),
    new Promise<void>((settle) => {
      const timer = setTimeout(settle, 2_000)
      timer.unref?.()
    }),
  ])))
})

suite('session advisory lock — lifetime', () => {
  it('CONTROL: taken through pool.query it is gone well before the job is, and the unlock lies', async () => {
    // The naive pattern — lock through `pool.query` — on a pool whose idle
    // timeout has only been turned down. It must FAIL to hold — if it ever
    // passes, `WAIT_MS` has stopped being long enough and every other
    // assertion in this file has quietly become vacuous.
    const key = freshKey()
    const pool = lockPool()
    const { rows } = await pool.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [key],
    )
    expect(rows[0]?.locked).toBe(true)

    await sleep(WAIT_MS)

    expect(await rivalCanAcquire(key)).toBe(true)
    const unlock = await pool.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1) AS unlocked', [key],
    )
    // The worse half: Postgres says "you did not hold this" as a RETURN VALUE,
    // so a `.catch(() => undefined)` on the unlock can never see it.
    expect(unlock.rows[0]?.unlocked).toBe(false)
  })

  it('held on a checked-out client, it survives many times the pool idle timeout', async () => {
    // heartbeatMs: 0 ON PURPOSE. With a heartbeat running, query traffic on the
    // connection is a confound — one could not tell whether the lock
    // survived because the client is held or because the heartbeat kept the
    // socket busy. This arm proves the held client is by itself sufficient.
    const key = freshKey()
    const pool = lockPool()
    const lock = await acquireSessionAdvisoryLock(pool, key, { heartbeatMs: 0 })
    expect(lock).not.toBeNull()

    await sleep(WAIT_MS)

    expect(await rivalCanAcquire(key)).toBe(false)
    expect(lock!.loss()).toBeNull()
    const released = await lock!.release()
    expect(released).toEqual({ confirmed: true, loss: null, error: null })
    // And it is genuinely given back, not merely reported as given back.
    expect(await rivalCanAcquire(key)).toBe(true)
  })

  it('a second acquirer is told no rather than made to wait', async () => {
    const key = freshKey()
    const first = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    expect(first).not.toBeNull()
    try {
      // `pg_try_advisory_lock`, never the blocking form: a scheduler that waits
      // is a scheduler whose next tick is decided by another process.
      const second = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
      expect(second).toBeNull()
    } finally {
      await first!.release()
    }
  })

  it('release is idempotent and does not abort the signal', async () => {
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    const first = await lock!.release()
    const second = await lock!.release()
    expect(first.confirmed).toBe(true)
    // A second `pg_advisory_unlock` on a released key returns FALSE, so an
    // implementation that re-queried would report a loss that never happened.
    expect(second).toBe(first)
    // An ordinary release must not look like an emergency to a caller watching
    // the signal for revocation.
    expect(lock!.signal.aborted).toBe(false)
  })
})

suite('session advisory lock — ownership predicate', () => {
  // The four cases a plausible-but-wrong predicate passes. Two of them are the
  // ones that matter: a predicate that forgets the key answers yes for any
  // advisory lock, and one that forgets `pg_backend_pid()` reads a RIVAL's lock
  // as ours — which is the exact instant ownership must read as lost.
  const cases: ReadonlyArray<readonly [string, number]> = [
    // Deliberately NOT near 7_243_119_002 (`LOCK_KEY` in `drillScheduler`): with
    // `+ (process.pid % 97)` a run could take a live scheduler's key on a shared
    // cluster. The property being covered is the HIGH WORD, not the number.
    ['a key whose high word is 1', 5_000_000_000],
    ['a key whose high word is not 1', 6_004_799_503_160_661],
    ['a key below 2^32, whose high word is 0', 2_948_151],
  ]

  for (const [label, base] of cases) {
    it(`decodes the lock tag for ${label}`, async () => {
      const key = base + (process.pid % 97)
      const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
      const rival = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
      await holder.connect()
      await rival.connect()
      try {
        expect(await advisoryLockHeldByThisSession(holder, key)).toBe(false)

        const taken = await holder.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked', [key],
        )
        // Asserted rather than assumed: without this, a key already held by
        // somebody else fails three lines below and the message accuses the
        // decode predicate of a fault that belongs to the key.
        expect(taken.rows[0]?.locked).toBe(true)
        expect(await advisoryLockHeldByThisSession(holder, key)).toBe(true)
        expect(await advisoryLockHeldByThisSession(holder, key + 1)).toBe(false)

        const stolen = await rival.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked', [key + 7],
        )
        expect(stolen.rows[0]?.locked).toBe(true)
        expect(await advisoryLockHeldByThisSession(holder, key + 7)).toBe(false)
        await rival.query('SELECT pg_advisory_unlock($1)', [key + 7])

        await holder.query('SELECT pg_advisory_unlock($1)', [key])
        expect(await advisoryLockHeldByThisSession(holder, key)).toBe(false)
      } finally {
        await holder.end().catch(() => {})
        await rival.end().catch(() => {})
      }
    })
  }

  it('does not mistake the two-argument form for the one-argument form', async () => {
    // `pg_advisory_lock(classid, objid)` builds the SAME lock tag as
    // `pg_advisory_lock(key)` with those two words — except `objsubid`, which is
    // 2 instead of 1. That is the entire difference, and both forms are live in
    // this tree against the same database: the maintenance coordinator and the
    // summary-promotion path both use the two-argument form.
    //
    // Without the `objsubid` clause the predicate would report ownership of a
    // drill key on the strength of a maintenance job's lock in the same
    // session, where `pg_backend_pid()` cannot tell them apart.
    const key = freshKey()
    const classid = Math.floor(key / 2 ** 32)
    const objid = key - classid * 2 ** 32
    const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await holder.connect()
    try {
      const { rows } = await holder.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked', [classid, objid],
      )
      expect(rows[0]?.locked).toBe(true)
      expect(await advisoryLockHeldByThisSession(holder, key)).toBe(false)
      await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [classid, objid])
    } finally {
      await holder.end().catch(() => {})
    }
  })
})

suite('session advisory lock — loss is an event, not a silence', () => {
  it('a terminated backend aborts the signal and the release says so', async () => {
    const key = freshKey()
    const events: string[] = []
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, {
      heartbeatMs: 100,
      onEvent: (event) => { events.push(event) },
    })
    expect(lock).not.toBeNull()
    expect(lock!.backendPid).toBeGreaterThan(0)

    // The blunt version of every way a session can end under a long job:
    // an operator, an OOM kill, a failover, a middlebox dropping an idle flow.
    const executioner = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await executioner.connect()
    try {
      await executioner.query('SELECT pg_terminate_backend($1)', [lock!.backendPid])
    } finally {
      await executioner.end().catch(() => {})
    }

    const deadline = Date.now() + 8_000
    while (!lock!.signal.aborted && Date.now() < deadline) await sleep(25)
    expect(lock!.signal.aborted).toBe(true)

    const loss = lock!.loss()
    expect(loss).not.toBeNull()
    // Which of the two arrives first is an OS scheduling detail — the socket
    // error and the next heartbeat race — and pinning it would be asserting on
    // the race rather than on the outcome. What must hold is that ownership
    // ended, that it was NOTICED, and that it was noticed as a loss rather than
    // as an ordinary release.
    expect(['connection-error', 'heartbeat-failed']).toContain(loss!.reason)
    expect(loss!.observedAfterMs).toBeGreaterThanOrEqual(0)
    expect(events).toContain('db.advisory_lock_lost')

    const released = await lock!.release()
    expect(released.confirmed).toBe(false)
    expect(released.loss).toEqual(loss)
    // And the key really is free — the loss report is not a false alarm.
    expect(await rivalCanAcquire(key)).toBe(true)
  })
})

/**
 * The fencing token, and the question it makes answerable.
 *
 * Both halves are claims about Postgres that a fake would agree with whatever
 * the implementation did: that `pg_stat_activity.backend_start` is readable
 * from another session of the same role, that it identifies a session rather
 * than a pid, and that `pg_locks` answers the ownership question the same way
 * for a caller who is not the holder.
 */
suite('session advisory lock — the fencing token', () => {
  it('is captured at acquisition, as an integer that survives the round trip', async () => {
    // node-postgres parses `timestamptz`
    // into a JS Date, which is MILLISECOND resolution against Postgres's
    // microseconds — so a token handed back as a timestamp NEVER matches, and a
    // terminate whose predicate never matches kills nothing while reporting
    // `released: true`. Epoch microseconds are an integer, and `int8` arrives
    // as a string, so no digit is lost in either direction.
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    try {
      expect(lock!.backendStart).toMatch(/^\d+$/)
      // Sanity on the magnitude rather than on the value: microseconds since
      // the epoch for any plausible run are a sixteen-digit number.
      expect(lock!.backendStart!.length).toBeGreaterThanOrEqual(16)
    } finally {
      await lock!.release()
    }
  })

  it('answers OURS for a live holder and NOT-OURS once the session is gone', async () => {
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      expect(await checkAdvisoryLockOwnership(asker, key, lock!.backendPid, {
        backendStart: lock!.backendStart,
      })).toEqual({ verdict: 'ours', fenced: true, error: null })

      // The one-argument form returns once the signal is SENT; the session keeps
      // its lock until it has exited, so a check right after it can still answer
      // `ours` (seen on CI; reproduced with the holder's backend SIGSTOPped: true
      // after 2 ms, lock still held). With a timeout it returns once the backend
      // is gone.
      const terminated = await asker.query<{ ok: boolean }>(
        'SELECT pg_terminate_backend($1, 10000) AS ok', [lock!.backendPid],
      )
      expect(terminated.rows[0].ok, 'the holder did not exit within 10 s').toBe(true)

      expect(await checkAdvisoryLockOwnership(asker, key, lock!.backendPid, {
        backendStart: lock!.backendStart,
      })).toEqual({ verdict: 'not-ours', fenced: true, error: null })
    } finally {
      await lock!.release().catch(() => {})
      await asker.end().catch(() => {})
    }
  })

  it('a WRONG token means not-ours, even for the pid that really holds the key', async () => {
    // THE assertion. This is pid reuse, staged: the number is right and the
    // session is not. Without the fence the answer would be `ours` — and on the
    // destructive path below, a kill.
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      expect(await checkAdvisoryLockOwnership(asker, key, lock!.backendPid, {
        backendStart: '1',
      })).toMatchObject({ verdict: 'not-ours', fenced: true })

      // …and the CONTROL, so the case cannot pass because the query is simply
      // broken: the same call with the real token still says `ours`.
      expect(await checkAdvisoryLockOwnership(asker, key, lock!.backendPid, {
        backendStart: lock!.backendStart,
      })).toMatchObject({ verdict: 'ours' })
    } finally {
      await lock!.release()
      await asker.end().catch(() => {})
    }
  })

  it('WITHOUT a token it answers by pid alone, and says the answer is unfenced', async () => {
    // The degraded mode a cluster that hides `backend_start` would get. It is
    // weaker on purpose — the alternative is a lock nobody can take — and the
    // caller is told which guarantee it received rather than left to assume.
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      expect(await checkAdvisoryLockOwnership(asker, key, lock!.backendPid))
        .toEqual({ verdict: 'ours', fenced: false, error: null })
    } finally {
      await lock!.release()
      await asker.end().catch(() => {})
    }
  })

  it('an asker who can see the LOCK but not the SESSION gets unknown, and kills nothing', async () => {
    // `pg_locks` is not privilege-masked, but `pg_stat_activity.backend_start`
    // is: a role that is not a member of the holder's sees the lock row and a
    // NULL token.
    //
    // A fence placed inside the WHERE clause would make that asker's answer
    // identical to "this pid holds nothing" — a healthy lock would read as
    // `not-ours` (aborting a long dump), and the terminate would report
    // `released: true` while a live backend sat on the key.
    //
    // Unreachable while every connection uses the same role, but reachable on
    // the first least-privilege hardening pass.
    const key = freshKey()
    const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await holder.connect()
    let stranger: pg.Client | null = null
    try {
      const { rows } = await holder.query<{ locked: boolean; pid: number; token: string }>(
        `SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid,
                (SELECT (EXTRACT(epoch FROM backend_start) * 1000000)::bigint::text
                   FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS token`, [key],
      )
      expect(rows[0]!.locked).toBe(true)

      const admin = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
      await admin.connect()
      try {
        await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM ${STRANGER_ROLE}`).catch(() => {})
        await admin.query(`DROP ROLE IF EXISTS ${STRANGER_ROLE}`).catch(() => {})
        await admin.query(`CREATE ROLE ${STRANGER_ROLE} LOGIN PASSWORD 'probe'`)
        await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${STRANGER_ROLE}`)
        stranger = new pg.Client({
          connectionString: URL.replace(/\/\/[^@]+@/, `//${STRANGER_ROLE}:probe@`),
          connectionTimeoutMillis: 4000,
        })
        await stranger.connect()

        // The premise, asserted rather than assumed: this asker CAN see the
        // lock. Without it the case could pass because the row was invisible,
        // which is a different — and harmless — situation.
        const visible = await stranger.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND pid = $1::int`, [rows[0]!.pid],
        )
        expect(visible.rows[0]!.n).toBeGreaterThanOrEqual(1)

        expect(await checkAdvisoryLockOwnership(stranger, key, rows[0]!.pid, {
          backendStart: rows[0]!.token,
        })).toMatchObject({ verdict: 'unknown', fenced: true })

        const refused = await terminateAdvisoryLockHolder(stranger, key, rows[0]!.pid, {
          backendStart: rows[0]!.token,
        })
        expect(refused).toMatchObject({ signalled: false, released: false, fenced: true })
        expect(refused.error).toMatch(/did not report its backend_start/)

        // And the holder is untouched — alive, and still holding.
        const alive = await holder.query<{ ok: number }>('SELECT 1 AS ok')
        expect(alive.rows[0]!.ok).toBe(1)
        expect(await rivalCanAcquire(key)).toBe(false)
      } finally {
        await stranger?.end().catch(() => {})
        stranger = null
        await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM ${STRANGER_ROLE}`).catch(() => {})
        await admin.query(`DROP ROLE IF EXISTS ${STRANGER_ROLE}`).catch(() => {})
        await admin.end().catch(() => {})
      }
      await holder.query('SELECT pg_advisory_unlock($1)', [key])
    } finally {
      await stranger?.end().catch(() => {})
      await holder.end().catch(() => {})
    }
  })

  it('a WRONG token cannot authorise a KILL', async () => {
    // Pid reuse on the destructive path. The victim of a mistake here would not
    // be a random bystander — the only backend that can hold this exact key in
    // this database is another MapleSpire drill, i.e. the rightful successor,
    // killed mid-dump.
    const key = freshKey()
    const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await holder.connect()
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      const { rows } = await holder.query<{ locked: boolean; pid: number }>(
        'SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid', [key],
      )
      expect(rows[0]!.locked).toBe(true)

      const refused = await terminateAdvisoryLockHolder(asker, key, rows[0]!.pid, {
        backendStart: '1',
      })
      expect(refused).toMatchObject({ signalled: false, fenced: true, error: null })

      // Alive, and still holding: `released: true` above is the honest answer
      // to "is THAT session holding it" — the session identified by the token,
      // which does not exist — and it must not have cost the real one its life.
      const alive = await holder.query<{ ok: number }>('SELECT 1 AS ok')
      expect(alive.rows[0]!.ok).toBe(1)
      expect(await rivalCanAcquire(key)).toBe(false)
      await holder.query('SELECT pg_advisory_unlock($1)', [key])
    } finally {
      await holder.end().catch(() => {})
      await asker.end().catch(() => {})
    }
  })
})

/**
 * Returning the key deliberately, rather than hoping a socket carries a FIN.
 *
 * Three claims here are ones a fake would agree with whatever the
 * implementation does: that a terminated session releases its advisory locks,
 * that the `pg_locks` predicate declines to kill a backend which does not hold
 * the key, and that the `CASE` declines to kill the asking backend. The second
 * matters most — without it this function is a `kill` on a number that the OS
 * recycles.
 */
suite('session advisory lock — terminating the holder', () => {
  it('kills the holder, CONFIRMS it, and a rival can then take the key', async () => {
    const key = freshKey()
    // Heartbeat off: it would race the termination and abort the signal for its
    // own reasons, which is a different mechanism than the one under test.
    const lock = await acquireSessionAdvisoryLock(lockPool(), key, { heartbeatMs: 0 })
    expect(lock).not.toBeNull()
    expect(await rivalCanAcquire(key)).toBe(false)

    const executioner = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await executioner.connect()
    try {
      const outcome = await terminateAdvisoryLockHolder(executioner, key, lock!.backendPid)
      expect(outcome).toMatchObject({ signalled: true, released: true, refusedSelf: false, error: null })
    } finally {
      await executioner.end().catch(() => {})
    }

    // The witness that is not ours: an independent connection can take the key.
    // `released: true` above is read out of `pg_locks`; this is read out of the
    // lock manager actually granting it, which is the fact the caller cares
    // about and the one the abandonment path exists to restore.
    expect(await rivalCanAcquire(key)).toBe(true)

    // And the handle answers HONESTLY about a session that no longer exists:
    // the unlock statement cannot be run, so this is an `error`, not a
    // `confirmed: false` — Postgres not answering, rather than Postgres saying
    // no. Releasing here also hands the dead client back destroyed, which is
    // what lets `afterAll` finish; a checked-out client that never comes back
    // makes `pool.end()` never resolve.
    const released = await lock!.release()
    expect(released.confirmed).toBe(false)
    expect(released.error).not.toBeNull()
  })

  it('will NOT kill a backend that does not hold the key — the pid-reuse guard', async () => {
    // THE test. Pids are recycled, and the abandonment path fires minutes or
    // hours after the pid was recorded. Without the `pg_locks` predicate this
    // function is `kill(pid)` on a number that may by then belong to an
    // unrelated session — a projector, a migration, a user's transaction.
    const key = freshKey()
    const bystander = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await bystander.connect()
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      const { rows } = await bystander.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const innocent = rows[0]!.pid
      // Nobody holds `key`, and `innocent` certainly does not.
      const outcome = await terminateAdvisoryLockHolder(asker, key, innocent)
      expect(outcome).toMatchObject({ signalled: false, released: true, refusedSelf: false, error: null })

      // Alive, and not merely "no error was thrown": a terminated backend
      // rejects the next statement with `terminating connection due to
      // administrator command`. Asking it something is the only way to tell.
      const alive = await bystander.query<{ ok: number }>('SELECT 1 AS ok')
      expect(alive.rows[0]!.ok).toBe(1)
    } finally {
      await bystander.end().catch(() => {})
      await asker.end().catch(() => {})
    }
  })

  it('refuses to kill the backend it is asking from, and that connection survives', async () => {
    // A caller that passed the LOCK'S own pool would ask a backend to kill
    // itself and then read the answer off a socket that is closing. The `CASE`
    // declines rather than the WHERE clause excluding, so the row still comes
    // back and the refusal is reported instead of looking like "already free".
    const key = freshKey()
    const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await holder.connect()
    try {
      const { rows } = await holder.query<{ locked: boolean; pid: number }>(
        'SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid', [key],
      )
      expect(rows[0]!.locked).toBe(true)

      const outcome = await terminateAdvisoryLockHolder(holder, key, rows[0]!.pid)
      expect(outcome).toMatchObject({ refusedSelf: true, released: false, signalled: false })

      // Both halves matter: the connection is usable, and the key was NOT
      // given away by a refusal that reported success.
      const alive = await holder.query<{ ok: number }>('SELECT 1 AS ok')
      expect(alive.rows[0]!.ok).toBe(1)
      expect(await rivalCanAcquire(key)).toBe(false)
      await holder.query('SELECT pg_advisory_unlock($1)', [key])
    } finally {
      await holder.end().catch(() => {})
    }
  })

  it('a holder of our key in ANOTHER DATABASE is not killed', async () => {
    // Advisory locks are per-database, and the drill's key is a constant every
    // scheduler in the fleet shares — so two MapleSpire databases in one cluster
    // hold the identical `classid`/`objid` legitimately, and `pg_locks` rows for
    // both are visible from either. Without `database` in the predicate, an
    // abandonment in one deployment would terminate the holder in the other.
    //
    // The heartbeat cannot confuse them (a backend is attached to exactly one
    // database, and it asks about `pg_backend_pid()`), which is why the clause
    // is justified by the DESTRUCTIVE reader rather than by the read-only one.
    const key = freshKey()
    const elsewhere = new pg.Client({
      connectionString: URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1'),
      connectionTimeoutMillis: 4000,
    })
    let connected = false
    try {
      await elsewhere.connect()
      connected = true
    } catch {
      // A cluster without a reachable `postgres` database cannot host this case.
      console.warn('[sessionAdvisoryLock] no second database reachable — cross-database case not run')
    }
    // A case that returns early passes with ZERO assertions, and `check-test-skips`
    // cannot see it because it is not a skip. So when the run INTENDS to
    // exercise Postgres, an unreachable second database is a failure.
    if (process.env.REQUIRE_DB_TESTS) expect(connected).toBe(true)
    if (!connected) return

    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      const { rows } = await elsewhere.query<{ locked: boolean; pid: number }>(
        'SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid', [key],
      )
      expect(rows[0]!.locked).toBe(true)

      expect(await terminateAdvisoryLockHolder(asker, key, rows[0]!.pid))
        .toMatchObject({ signalled: false, released: true, error: null })

      const alive = await elsewhere.query<{ ok: number }>('SELECT 1 AS ok')
      expect(alive.rows[0]!.ok).toBe(1)
      await elsewhere.query('SELECT pg_advisory_unlock($1)', [key])
    } finally {
      await elsewhere.end().catch(() => {})
      await asker.end().catch(() => {})
    }
  })

  it('a holder of ANOTHER key is not killed by asking about ours', async () => {
    // The lock-tag decode again, on the destructive path this time. A predicate
    // that matched any advisory lock held by that pid would terminate a backend
    // busy with an unrelated exclusion. The read-only version is covered by the
    // ownership-predicate suite above.
    const ours = freshKey()
    const theirs = freshKey()
    const holder = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await holder.connect()
    const asker = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await asker.connect()
    try {
      const { rows } = await holder.query<{ locked: boolean; pid: number }>(
        'SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid', [theirs],
      )
      expect(rows[0]!.locked).toBe(true)

      expect(await terminateAdvisoryLockHolder(asker, ours, rows[0]!.pid))
        .toMatchObject({ signalled: false, released: true, error: null })

      const alive = await holder.query<{ ok: number }>('SELECT 1 AS ok')
      expect(alive.rows[0]!.ok).toBe(1)
      expect(await rivalCanAcquire(theirs)).toBe(false)
      await holder.query('SELECT pg_advisory_unlock($1)', [theirs])
    } finally {
      await holder.end().catch(() => {})
      await asker.end().catch(() => {})
    }
  })
})

suite('session advisory lock — the keepalives are a claim about POSTGRES', () => {
  /** `max: 1` so the client the lock used is the client the readback gets, and
   *  an idle timeout long enough that it is not destroyed in between. That
   *  reuse IS the assertion: a session GUC that survives its own statement,
   *  its transaction, and a trip through the pool is a session GUC. */
  const readbackPool = (): pg.Pool => {
    const pool = guardIdleClientErrors(new pg.Pool({
      connectionString: URL,
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 4000,
    }), 'sessionAdvisoryLock:pool')
    opened.push(pool)
    return pool
  }

  const settingOn = async (pool: pg.Pool): Promise<string> => {
    const { rows } = await pool.query<{ v: string }>(
      "SELECT current_setting('tcp_keepalives_idle') AS v",
    )
    return rows[0]!.v
  }

  it('reports what the cluster ACTUALLY took, and it survives the statement', async () => {
    // The `is_local` argument of `set_config` is the whole point of the second
    // half. Passing `true` would revert the value at the end of the acquiring
    // statement's implicit transaction, and EVERY assertion available inside
    // that statement -- including the returned value the handle is built from --
    // would still be exactly this. No fake can tell those apart; a second
    // statement on the same session can.
    const pool = readbackPool()
    const key = freshKey()
    const lock = await acquireSessionAdvisoryLock(pool, key, {
      heartbeatMs: 0,
      keepalives: { idleSeconds: 37, intervalSeconds: 11, count: 3 },
    })
    expect(lock).not.toBeNull()
    expect(lock!.keepalives.effective).toEqual({ idleSeconds: 37, intervalSeconds: 11, count: 3 })
    expect(lock!.keepalives.detectsWithinSeconds).toBe(37 + 3 * 11)
    await lock!.release()
    expect(await settingOn(pool)).toBe('37')
  })

  it('leaves the cluster default alone when asked to — the control', async () => {
    // Without this arm the test above is a claim about the value 37 and not
    // about the module: a cluster that already ran with these settings would
    // pass it unchanged. Two pools, one variable.
    const pool = readbackPool()
    const before = await settingOn(pool)
    const lock = await acquireSessionAdvisoryLock(pool, freshKey(), {
      heartbeatMs: 0,
      keepalives: null,
    })
    expect(lock!.keepalives).toEqual({
      requested: null,
      effective: null,
      // Read off a real TCP connection, so this also pins that the transport
      // column is answered by `pg_stat_activity` and not by a default. The
      // Unix-socket half of that pair (`client_port = -1`) cannot be reached
      // from here -- vitest connects over TCP -- and is covered by the fake.
      transport: 'tcp',
      detectsWithinSeconds: null,
    })
    await lock!.release()
    expect(await settingOn(pool)).toBe(before)
    expect(before).not.toBe('37')
  })

  it('sees a value the KERNEL silently refuses, which no positivity test can', async () => {
    // 128 is one above Linux's MAX_TCP_KEEPCNT. Postgres accepts the statement,
    // `setsockopt` refuses, and `set_config` returns the PREVIOUS value -- 9 --
    // with no error anywhere. Every number that comes back is positive and
    // plausible, so a positivity check would report a confident window.
    //
    // The module now refuses 128 up front, so reach the cluster behaviour
    // directly: this asserts the PREMISE the guard rests on, against the real
    // kernel, so a future platform where 128 is fine fails here rather than
    // leaving a guard nobody can explain.
    const pool = readbackPool()
    const { rows } = await pool.query<{ applied: number }>(
      `SELECT set_config('tcp_keepalives_count', '128', false)::int AS applied`,
    )
    expect(rows[0]!.applied).not.toBe(128)
    expect(rows[0]!.applied).toBeGreaterThan(0)
    // And the boundary itself sticks, so the ceiling is exactly where the guard
    // puts it rather than somewhere near it.
    const ok = await pool.query<{ applied: number }>(
      `SELECT set_config('tcp_keepalives_count', '127', false)::int AS applied`,
    )
    expect(ok.rows[0]!.applied).toBe(127)
  })

  it('applies the SHIPPED defaults against a real cluster', async () => {
    // The two cases above use invented numbers so the assertions are sharp.
    // This one uses what production actually sends, because an out-of-range
    // default would raise HERE and nowhere else. (A GUC name typo is also
    // caught by the unit suite, which string-matches the statement.)
    const pool = readbackPool()
    const lock = await acquireSessionAdvisoryLock(pool, freshKey(), { heartbeatMs: 0 })
    expect(lock!.keepalives.effective).toEqual(DEFAULT_KEEPALIVES)
    expect(lock!.keepalives.detectsWithinSeconds).toBe(
      DEFAULT_KEEPALIVES.idleSeconds + DEFAULT_KEEPALIVES.count * DEFAULT_KEEPALIVES.intervalSeconds,
    )
    await lock!.release()
  })
})
