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

import net from 'node:net'
// Aliased, because this file's own `URL` constant shadows the global
// constructor.
import { URL as WebUrl } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runDrillTick, type DrillAbandonment } from './drillTick.js'
import { settleAbandonment } from './drillAbandonment.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * One property:
 *
 *   **For the WHOLE duration of the drill, no other session can take the key.**
 *
 * "The lock is acquired" and "the lock is released" are not enough: a lock taken
 * through `pool.query` dies with the pool's idle client. So the witness is a
 * rival connection TRYING, repeatedly, across the drill's whole span.
 *
 * `idleTimeoutMillis` is turned down to 100 ms and the drill runs 900 ms, nine
 * times over. The `CONTROL` case runs the unprotected shape through the same
 * harness, so a drill that stopped outlasting the idle timeout would fail this
 * file rather than silently make every other case vacuous.
 *
 * The VERDICT — whether the tick reports the run as exclusive — is pinned in
 * `drillTick.test.ts` instead, one clause at a time. It cannot be pinned here:
 * the only non-exclusive case a real cluster produces cheaply is killing the
 * backend, which falsifies all three clauses at once, so deleting any one of
 * them leaves this file green.
 */

const URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

/** Advisory locks are per-DATABASE and vitest runs many workers against one.
 *
 * The range must stay DISJOINT from `sessionAdvisoryLock.integration.test.ts`'s
 * (that file starts at 9 000 000 000, this one at 9 500 000 000, each spanning
 * 400 000 pids × 1 000 keys); overlapping ranges let two workers collide on the
 * same key. */
let nextKey = 9_500_000_000 + (process.pid % 400_000) * 1_000
const freshKey = (): number => (nextKey += 1)

const IDLE_TIMEOUT_MS = 100
const DRILL_MS = 900
const POLL_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for a CONDITION, never for a duration.
 *
 *  A fixed sleep is a bet on how fast heartbeats time out on a loaded box.
 *  Returns the condition's final value so a caller can assert on it. */
const waitUntil = async (ready: () => boolean, ms = 15_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!ready() && Date.now() < deadline) await sleep(50)
  return ready()
}

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
if (!reachable) console.warn(`[drillTick] no Postgres at ${URL} — skipping`)

// Fails instead of skipping when the run requires Postgres
// (`REQUIRE_DB_TESTS`); `scripts/check-test-skips.mjs` catches undeclared skips
// in a full run.
it.skipIf(!process.env.REQUIRE_DB_TESTS)('runs rather than skips when the run intends to exercise Postgres', () => {
  expect(reachable).toBe(true)
})

/**
 * An `abandon` that fails the test instead of ending the process.
 *
 * `runDrillTick`'s default ends the process, which would take the vitest worker
 * down. Tests using this one have deadlines far beyond their drills, so reaching
 * abandonment is itself the failure.
 */
const neverInATest = (report: unknown): void => {
  throw new Error(`a test reached the abandonment path: ${JSON.stringify(report)}`)
}

const opened: pg.Pool[] = []
function lockPool(): pg.Pool {
  const pool = guardIdleClientErrors(new pg.Pool({
    connectionString: URL,
    // TWO, matching `drillScheduler`: one client is held for the drill's whole
    // run (the exclusion), the second lets an inconclusive loss be put to an
    // INDEPENDENT connection.
    max: 2,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 4000,
  }), 'drillTick')
  opened.push(pool)
  return pool
}

afterAll(async () => {
  // BOUNDED: a pool with a client checked out and never given back can never
  // end (pg-pool waits for `_clients` to empty and arms no timer), and the
  // abandonment tests below leave exactly that on purpose. `drillScheduler`
  // races its own `lockPool.end()` for the same reason.
  await Promise.all(opened.map((pool) => Promise.race([
    pool.end().catch(() => {}),
    new Promise<void>((settle) => {
      const timer = setTimeout(settle, 2_000)
      timer.unref?.()
    }),
  ])))
})

/**
 * A TCP proxy in front of Postgres that can BLACK-HOLE the flows it already
 * carries while still accepting new ones.
 *
 * That asymmetry models a stateful firewall or NAT evicting a flow from its
 * table: tracked connections die, fresh ones get through. It produces, against a
 * real cluster, the case the independent check exists for — the lock's
 * connection stops answering while the backend behind it is alive and still
 * holding the key.
 *
 * No FIN and no RST: forwarding simply stops, in both directions, with both
 * sockets open. Either end closing would let the peer notice, which is the
 * thing that is NOT happening in the failure being modelled.
 */
interface Blackholeable {
  readonly port: number
  readonly blackHoleExisting: () => void
  readonly close: () => void
}

async function startProxy(): Promise<Blackholeable> {
  const upstream = new WebUrl(URL)
  const pairs: Array<{ client: net.Socket; server: net.Socket; forwarding: boolean }> = []
  const server = net.createServer((client) => {
    const target = net.connect(Number(upstream.port || 5432), upstream.hostname)
    const pair = { client, server: target, forwarding: true }
    pairs.push(pair)
    client.on('data', (chunk) => { if (pair.forwarding) target.write(chunk) })
    target.on('data', (chunk) => { if (pair.forwarding) client.write(chunk) })
    client.on('error', () => {})
    target.on('error', () => {})
  })
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready) })
  return {
    port: (server.address() as net.AddressInfo).port,
    // Only the pairs that EXIST now. Connections opened afterwards forward
    // normally, which is what lets the independent check reach the cluster.
    blackHoleExisting: () => { for (const pair of pairs) pair.forwarding = false },
    close: () => {
      for (const pair of pairs) { pair.client.destroy(); pair.server.destroy() }
      server.close()
    },
  }
}

interface Rival {
  /** Hammer the key for `windowMs`, returning every moment it got in.
   *  Milliseconds are counted from the first attempt, NOT from `open()`. */
  attemptsFor: (windowMs: number) => Promise<number[]>
  close: () => Promise<void>
}

/**
 * A rival scheduler on its own connection.
 *
 * **Open it BEFORE the protected span and poll INSIDE it.** Polling during the
 * acquisition would let the rival win the key before the subject takes it, and
 * counting time from before `client.connect()` would fold connection latency
 * into `stolen[0]` — enough on a loaded box to satisfy the CONTROL's bound
 * while measuring nothing.
 */
async function openRival(key: number): Promise<Rival> {
  const client = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
  await client.connect()
  return {
    attemptsFor: async (windowMs: number): Promise<number[]> => {
      const stolen: number[] = []
      const startedAt = Date.now()
      // ALWAYS at least one attempt (`do…while`): a head-tested loop runs zero
      // times whenever the clock ticks before the first check, and the callers
      // that assert `[]` (the key is HELD) would then pass vacuously.
      do {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked', [key],
        )
        if (rows[0]?.locked === true) {
          stolen.push(Date.now() - startedAt)
          await client.query('SELECT pg_advisory_unlock($1)', [key])
        }
        await sleep(POLL_MS)
      } while (Date.now() - startedAt < windowMs)
      return stolen
    },
    close: async () => { await client.end().catch(() => {}) },
  }
}

suite('drill tick — exclusion for the whole run', () => {
  // Pins `attemptsFor`'s own contract, whose failure mode is a silent false
  // pass (rare in practice, deterministic here): on a free key a zero-window
  // call must still make exactly one attempt, and one that succeeds.
  it('attemptsFor ALWAYS attempts at least once — the window bounds polling, not whether it polls', async () => {
    const rival = await openRival(freshKey())
    try {
      expect(await rival.attemptsFor(0)).toHaveLength(1)
    } finally {
      await rival.close()
    }
  })

  it('CONTROL: the shipped shape is preempted part-way through the same drill', async () => {
    // The unprotected shape — the lock taken through `pool.query`, so it lives
    // on an idle client — driven by the same harness. If this ever stops
    // finding a preemption, the drill in these tests has become shorter than
    // the idle timeout and the real assertions below prove nothing.
    const key = freshKey()
    const pool = lockPool()
    const rival = await openRival(key)
    try {
      const { rows } = await pool.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked', [key],
      )
      expect(rows[0]?.locked).toBe(true)
      const stolen = await rival.attemptsFor(DRILL_MS)
      const unlock = await pool.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1) AS unlocked', [key],
      )

      expect(stolen).not.toHaveLength(0)
      // The first preemption lands just after the pool destroys its idle client.
      expect(stolen[0]).toBeGreaterThan(IDLE_TIMEOUT_MS - POLL_MS)
      expect(unlock.rows[0]?.unlocked).toBe(false)
    } finally {
      await rival.close()
    }
  })

  it('holds the key for every moment of the drill, and says the run was exclusive', async () => {
    const key = freshKey()
    const rival = await openRival(key)
    let stolen: number[] | null = null
    try {
      const outcome = await runDrillTick({
        pool: lockPool(),
        lockKey: key,
        log: () => {},
        heartbeatMs: 0,
        abandon: neverInATest,
        // The rival lives and dies inside the drill, so every one of its
        // attempts happens at a moment the exclusion is supposed to cover.
        drill: async () => { stolen = await rival.attemptsFor(DRILL_MS) },
      })

      expect(stolen).toEqual([])
      expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
    } finally {
      await rival.close()
    }
  })

  it('a second tick skips instead of running a concurrent drill', async () => {
    const key = freshKey()
    let secondDrillRan = false
    let firstDrillEntered = false
    let releaseFirst!: () => void
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: () => {},
      heartbeatMs: 0,
      abandon: neverInATest,
      drill: async () => { firstDrillEntered = true; await firstDone },
    })
    // Bounded: if the first tick never gets the key — a key collision, a stray
    // holder — an unbounded loop would surface as a 20 s suite timeout naming
    // nothing at all.
    const deadline = Date.now() + 10_000
    while (!firstDrillEntered && Date.now() < deadline) await sleep(10)
    expect(firstDrillEntered).toBe(true)

    const events: string[] = []
    const second = await runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: (event) => { events.push(event) },
      heartbeatMs: 0,
      abandon: neverInATest,
      drill: async () => { secondDrillRan = true },
    })

    expect(second).toEqual({ status: 'skipped_lock_held' })
    // A tick that reports `skipped` while still running the drill would be the
    // worst outcome.
    expect(secondDrillRan).toBe(false)
    expect(events).toContain('backup.drill_skipped_lock_held')

    releaseFirst()
    expect(await first).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
  })

  it('a failing drill still gives the key back, and the failure still reaches the caller', async () => {
    const key = freshKey()
    const boom = new Error('pg_dump exploded')
    await expect(runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: () => {},
      heartbeatMs: 0,
      abandon: neverInATest,
      drill: () => Promise.reject(boom),
    })).rejects.toBe(boom)

    // A failed drill must not wedge the key for every future one.
    const after = await runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: () => {},
      heartbeatMs: 0,
      abandon: neverInATest,
      drill: () => Promise.resolve(),
    })
    expect(after).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
  })

  it('an inconclusive loss is put to a SECOND connection, which stops the drill', async () => {
    const key = freshKey()
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
    let toldToStop = false
    const outcome = await runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: (event, fields) => { events.push({ event, fields }) },
      heartbeatMs: 100,
      abandon: neverInATest,
      drill: async (signal) => {
        signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
        // Find the holder through pg_locks rather than being handed the pid:
        // the point is that an outside actor ends the session without the tick
        // being told.
        const executioner = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
        await executioner.connect()
        try {
          await executioner.query(
            `SELECT pg_terminate_backend(l.pid)
               FROM pg_locks l
              WHERE l.locktype = 'advisory'
                AND l.classid = (($1::bigint >> 32) & 4294967295)::bigint
                AND l.objid = ($1::bigint & 4294967295)::bigint
                AND l.objsubid = 1`,
            [key],
          )
        } finally {
          await executioner.end().catch(() => {})
        }
        // Wait for the EVENT, not for a span: the kill, the heartbeat's notice
        // and the independent confirmation take variable time under load.
        const deadline = Date.now() + 15_000
        while (!events.some((e) => e.event === 'backup.drill_stop_requested')
          && Date.now() < deadline) await sleep(25)
      },
    })

    // Killing the lock's backend from outside produces `connection-error` or
    // `heartbeat-failed` — never `not-owner`, because `pg_locks` was never asked
    // and never named anybody else. Those mean "nothing was learned", so the
    // heartbeat alone may not stop the dump.
    //
    // What stops it is the second connection: it asks `pg_locks` from a socket
    // the executioner did not touch, and the answer is that the key is gone.
    // End to end, with no fake deciding any part of it.
    expect(toldToStop).toBe(true)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: 'lock-lost' })
    const requested = events.find((e) => e.event === 'backup.drill_stop_requested')
    expect(requested?.fields?.reason).toBe('lock-lost')
    expect(String(requested?.fields?.detail)).toMatch(/an independent connection confirms/)
    const warned = events.find((e) => e.event === 'backup.drill_ran_without_exclusion')
    expect(warned).toBeDefined()
    expect(warned!.fields?.unlockConfirmed).toBe(false)
    // A terminated backend fails all clauses of the verdict together, which is
    // why `drillTick.test.ts` pins them individually.
    // `> 0`, not `expect.any(Number)`: zero is what an unreadable pid would be.
    expect(warned!.fields?.backendPid).toBeGreaterThan(0)

    // And the key really is free afterwards: the report is not a false alarm.
    //
    // A WINDOW, not a single try: the key is released when the terminated
    // backend actually exits, which `pg_terminate_backend` does not wait for
    // (measured: often still held at the first poll, free within ~1 ms).
    const rival = await openRival(key)
    try {
      const attempts = await rival.attemptsFor(2_000)
      expect(attempts).not.toHaveLength(0)
      // The window avoids the race; this bound keeps a much slower release from
      // passing unnoticed.
      expect(attempts[0]).toBeLessThan(500)
    } finally {
      await rival.close()
    }
  })
})

suite('drill tick — a BLACK-HOLED lock connection does not cost the backup', () => {
  it('keeps dumping, because an independent connection says the key is still ours', async () => {
    // The case the independent check exists for, which a fake cannot decide.
    // The lock's socket stops carrying bytes with no FIN and no RST, so the
    // heartbeat can never answer — while the backend behind it is alive and
    // still holds the key, so the exclusion is intact. The tick ASKS on a
    // connection the black hole does not cover, and keeps dumping.
    const key = freshKey()
    const proxy = await startProxy()
    const url = new WebUrl(URL)
    url.hostname = '127.0.0.1'
    url.port = String(proxy.port)
    // With no listener, node-postgres surfaces a client error as an UNCAUGHT
    // exception, and destroying the proxy's sockets below produces exactly
    // that. `guardIdleClientErrors` rather than a bare `pool.on('error')`,
    // which covers only idle clients. The logger is silent because this
    // fixture destroys sockets on purpose.
    const pool = guardIdleClientErrors(new pg.Pool({
      connectionString: url.toString(),
      max: 2,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 4000,
    }), 'drillTick:proxy', () => {})
    opened.push(pool)
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
    let toldToStop = false

    try {
      const outcome = await runDrillTick({
        pool,
        lockKey: key,
        log: (event, fields) => { events.push({ event, fields }) },
        heartbeatMs: 60,
        deadlineMs: 60_000,
        abandon: neverInATest,
        drill: async (signal) => {
          signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
          proxy.blackHoleExisting()
          // Wait for the verdict rather than for a fixed span: a fixed one is a
          // bet on how fast two heartbeats time out on a loaded box.
          const deadline = Date.now() + 15_000
          while (!events.some((e) => e.event === 'backup.drill_exclusion_unverified')
            && Date.now() < deadline) await sleep(50)
          // Now let the sockets DIE, before the tick reaches its release:
          // otherwise `pg_advisory_unlock` sits on its own 30-second ceiling.
          // The drill's whole run was black-holed, which is the property under
          // test; this is teardown.
          proxy.close()
        },
      })

      // Not stopped — because of an ANSWER, not a policy of ignoring the loss.
      expect(toldToStop).toBe(false)
      expect(outcome.status).toBe('ran')
      expect((outcome as { cutShortBy: unknown }).cutShortBy).toBeNull()

      const confirmed = events.find((e) => e.event === 'backup.drill_exclusion_unverified')
      expect(confirmed).toBeDefined()
      expect(confirmed!.fields).toMatchObject({ confirmed: 'ours', fenced: true })
      // The loss really was the inconclusive kind, so the case is not passing
      // for the wrong reason.
      expect(['heartbeat-failed', 'connection-error']).toContain(confirmed!.fields?.reason)
      expect(events.map((e) => e.event)).not.toContain('backup.drill_stop_requested')
    } finally {
      proxy.close()
    }
  })

  it('…and stops when the key goes away LATER, which one check could never see', async () => {
    // The first independent sample IS `ours`, and the key goes away afterwards:
    // the lock's flow is evicted from a firewall's state table (so the heartbeat
    // can never answer) and the backend is later terminated — by an operator, a
    // failover, the OOM killer. A single-shot check would let the drill keep
    // dumping with the key available to anyone; the watch must notice.
    const key = freshKey()
    const proxy = await startProxy()
    const url = new WebUrl(URL)
    url.hostname = '127.0.0.1'
    url.port = String(proxy.port)
    // Through the guard, with a silent logger — see the sibling fixture above.
    const pool = guardIdleClientErrors(new pg.Pool({
      connectionString: url.toString(),
      max: 2,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 4000,
    }), 'drillTick:killer', () => {})
    opened.push(pool)
    // NOT through the proxy: this stands in for whatever kills the backend, and
    // routing it through the black hole would make the fixture unable to act.
    const killer = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await killer.connect()
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
    let toldToStop = false
    let sawFirstSample = false

    try {
      const outcome = await runDrillTick({
        pool,
        lockKey: key,
        log: (event, fields) => { events.push({ event, fields }) },
        // The watch inherits this, as it does by default in production.
        heartbeatMs: 60,
        deadlineMs: 60_000,
        abandon: neverInATest,
        drill: async (signal) => {
          signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
          proxy.blackHoleExisting()
          // Sample 1 must land, and must say the key is OURS, before anything
          // takes it away. Without this the test could pass against a
          // single-shot build purely by ordering.
          sawFirstSample = await waitUntil(
            () => events.some((e) => e.event === 'backup.drill_exclusion_unverified'),
          )
          const pid = events.find((e) => e.event === 'db.advisory_lock_acquired')?.fields?.backendPid
          await killer.query('SELECT pg_terminate_backend($1::int)', [pid])
          // Now the watch has to notice. Bounded, and the assertion below is on
          // the outcome rather than on this returning true.
          await waitUntil(() => signal.aborted)
          proxy.close()
        },
      })

      expect(sawFirstSample).toBe(true)
      const first = events.find((e) => e.event === 'backup.drill_exclusion_unverified')!
      // The exclusion really was intact when it was first asked about — so the
      // stop below cannot be the first answer arriving late.
      expect(first.fields).toMatchObject({ confirmed: 'ours', fenced: true })

      expect(toldToStop).toBe(true)
      expect((outcome as { cutShortBy: unknown }).cutShortBy).toBe('lock-lost')
      const requested = events.find((e) => e.event === 'backup.drill_stop_requested')!
      expect(requested.fields?.reason).toBe('lock-lost')
      // The discriminating assertion: check 1 said `ours`, so the stop must come
      // from a later check.
      const which = /established on independent check (\d+)/.exec(String(requested.fields?.detail))
      expect(which).not.toBeNull()
      expect(Number(which![1])).toBeGreaterThan(1)
    } finally {
      proxy.close()
      await killer.end().catch(() => {})
    }
  })
})

/**
 * Abandonment, against a real cluster: an abandoned drill keeps the key, proved
 * by a rival connection that cannot get in (a fake pool can only prove unlock
 * was not CALLED). Then the property the design rests on — ending the session
 * returns the key — is checked by terminating the backend.
 */
suite('drill tick — an abandoned drill keeps the key until the session dies', () => {
  it('holds the key while the drill runs on, and gives it up when the backend is terminated', async () => {
    const key = freshKey()
    const abandonments: Array<{ backendPid: number; reason: string }> = []
    const pool = lockPool()
    let stopDrill!: () => void
    const drillEnds = new Promise<void>((resolve) => { stopDrill = resolve })

    const outcome = await runDrillTick({
      pool,
      lockKey: key,
      log: () => {},
      heartbeatMs: 0,
      deadlineMs: 200,
      abortGraceMs: 300,
      // A drill that ignores the abort. Released at the end of the test so no
      // promise outlives the suite.
      drill: () => drillEnds,
      abandon: (report) => { abandonments.push({ backendPid: report.backendPid, reason: report.reason }) },
    })

    expect(outcome.status).toBe('abandoned')
    expect(abandonments).toHaveLength(1)
    const backendPid = abandonments[0]!.backendPid

    // The key is still held: releasing it would hand a rival scheduler the key
    // while this process may still be dumping.
    const rival = await openRival(key)
    try {
      expect(await rival.attemptsFor(300)).toEqual([])

      // Killing the session releases a session-scoped advisory lock; if it did
      // not, abandonment would be a permanent wedge.
      const executioner = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
      await executioner.connect()
      try {
        const { rows } = await executioner.query<{ terminated: boolean }>(
          'SELECT pg_terminate_backend($1) AS terminated', [backendPid],
        )
        expect(rows[0]?.terminated).toBe(true)
      } finally {
        await executioner.end().catch(() => {})
      }

      const afterDeath = await rival.attemptsFor(2_000)
      expect(afterDeath).not.toHaveLength(0)
    } finally {
      stopDrill()
      await rival.close()
    }
  })

  it('settleAbandonment returns the key ITSELF, without waiting on a socket', async () => {
    // The test above kills the backend by hand (the Postgres property); here
    // the production path does it. Not left to `process.exit`: ending the
    // process releases the lock only once the socket carries a FIN, and a
    // black-holed flow leaves the backend holding the key until `tcp_retries2`
    // (roughly fifteen minutes) while every scheduler skips its tick.
    const key = freshKey()
    const abandonments: DrillAbandonment[] = []
    let stopDrill!: () => void
    const drillEnds = new Promise<void>((resolve) => { stopDrill = resolve })

    const outcome = await runDrillTick({
      pool: lockPool(),
      lockKey: key,
      log: () => {},
      heartbeatMs: 0,
      deadlineMs: 200,
      abortGraceMs: 300,
      drill: () => drillEnds,
      abandon: (report) => { abandonments.push(report) },
    })
    expect(outcome.status).toBe('abandoned')
    expect(abandonments).toHaveLength(1)

    const rival = await openRival(key)
    // A fresh connection, as `drillScheduler` opens: it must not depend on the
    // lock's own, which may be the broken one.
    const settler = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 4000 })
    await settler.connect()
    let recordAttempts = 0
    try {
      // The key is still held right up to the moment the production path runs.
      expect(await rival.attemptsFor(1)).toEqual([])

      const settlement = await settleAbandonment(settler as never, abandonments[0]!, {
        startedAt: new Date(),
        bundleDirectory: '/tmp/does-not-matter',
      }, {
        log: () => {},
        // The real terminate; a counting stand-in for the write (no
        // `backup_drill_runs` table here — `drillAbandonment.test.ts` covers
        // it). Asserted together: the key came back AND the record step ran.
        record: async () => { recordAttempts += 1; return true },
      })

      expect(settlement.termination).toMatchObject({
        signalled: true, released: true, refusedSelf: false, error: null,
      })
      expect(recordAttempts).toBe(1)

      // An independent witness: `released: true` is read from `pg_locks`; this
      // is the lock manager actually granting the key to somebody else.
      expect(await rival.attemptsFor(2_000)).not.toHaveLength(0)
    } finally {
      stopDrill()
      await rival.close()
      await settler.end().catch(() => {})
    }
  })
})
