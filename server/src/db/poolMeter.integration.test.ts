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

import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { guardIdleClientErrors } from './poolErrorGuard.js'
import { poolMeterSnapshots } from './poolMeter.js'

/**
 * Against a real `pg.Pool`, because every claim the meter makes is a claim
 * about node-postgres: that `'acquire'` and `'release'` are exactly paired,
 * that a client still being ESTABLISHED is already inside `totalCount`, that a
 * caller blocked on a full pool appears in `waitingCount`. A fake pool agrees
 * with any implementation of the meter, including a wrong one — which is why
 * the arithmetic lives in `poolMeter.test.ts` and the ASSUMPTIONS live here.
 *
 * ## What pg_stat_activity cannot tell you
 *
 * `pg_stat_activity` cannot distinguish a connection node-postgres has handed
 * to a caller from one sitting free on the idle list: both are `state = 'idle'`
 * in Postgres, because nobody is running a statement.
 * `answers the question pg_stat_activity gets wrong` holds a client with NO
 * statement in flight and asserts BOTH readings in the same instant: Postgres
 * says `idle`, the meter says `checkedOut: 1`.
 *
 * That test alone does not prove `checkedOut` is exact rather than derived as
 * `total - idle` — the two agree in every state it visits.
 * `shows a stalled ESTABLISHMENT as connecting` separates them: `total - idle`
 * reads 1 there and the truth is 0.
 *
 * No `skipIf`. `TEST_DATABASE_URL` falls back to `DATABASE_URL` and then to the
 * local default, so an absent Postgres fails this file loudly instead of
 * skipping it green.
 */

const URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

const opened: pg.Pool[] = []

function makePool(label: string, config: pg.PoolConfig = {}): pg.Pool {
  const pool = guardIdleClientErrors(new pg.Pool({ connectionString: URL, ...config }), label, () => {})
  opened.push(pool)
  return pool
}

const snapshotOf = (label: string) => poolMeterSnapshots().find((entry) => entry.pool === label)

afterEach(async () => {
  // `end()` on a pool with a client still checked out never resolves, so every
  // test hands its clients back before it finishes. A failure to do so shows up
  // as this hook hanging — which is the correct, loud symptom.
  await Promise.all(opened.splice(0).map((pool) => pool.end()))
})

describe('poolMeter against a real pg.Pool', () => {
  it('answers the question pg_stat_activity gets wrong', async () => {
    const held = makePool('real-held', { max: 2 })
    const observer = makePool('real-observer', { max: 2 })

    const client = await held.connect()
    try {
      // One statement, so the backend exists and has a pid to look up. It
      // finishes; from here on Postgres considers this connection idle.
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = rows[0].pid

      const { rows: seen } = await observer.query<{ state: string }>(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
      // WHAT POSTGRES SEES: an idle backend, indistinguishable from a free one.
      expect(seen[0]?.state).toBe('idle')

      // WHAT THE METER SEES: a connection that is not available to anybody.
      expect(snapshotOf('real-held')).toMatchObject({ checkedOut: 1, idle: 0, total: 1 })
    } finally {
      client.release()
    }

    // And the moment it is given back, the two readings agree again — the
    // control that keeps the assertion above from being true of every state.
    expect(snapshotOf('real-held')).toMatchObject({ checkedOut: 0, idle: 1, total: 1 })
  })

  it('pairs acquire and release across the pool.query shape', async () => {
    // `pool.query(...)` borrows and releases inside pg with no client ever
    // visible to the caller; most read paths use this shape.
    const pool = makePool('real-query', { max: 3 })
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 2'), pool.query('SELECT 3')])
    await pool.query('SELECT 4')

    const snapshot = snapshotOf('real-query')
    expect(snapshot?.acquires).toBe(4)
    expect(snapshot?.releases).toBe(4)
    expect(snapshot?.checkedOut).toBe(0)
    // A control only: this shape produces no underflow. The test below is the
    // one that shows the counter can fire at all.
    expect(snapshot?.connectingUnderflows).toBe(0)
    expect(snapshot?.handlerFailures).toBe(0)
  })

  it('counts the ONE underflow pg really produces', () => {
    // pg-pool's max-lifetime timer calls `_acquireClient` on a client it has
    // just FOUND in `_idle` and does not pop — the only caller that does not.
    // `total - idle - checkedOut` reaches -1 at that emit and is back to 0
    // synchronously, so the count has to be taken at event time.
    //
    // `maxLifetimeSeconds` is unset in the shipped configuration; this proves
    // the detector can actually fire.
    const pool = makePool('real-maxlifetime', { max: 1, maxLifetimeSeconds: 1 })
    return pool.query('SELECT 1')
      .then(() => new Promise((resolve) => setTimeout(resolve, 1_400)))
      .then(() => {
        expect(snapshotOf('real-maxlifetime')?.connectingUnderflows).toBeGreaterThanOrEqual(1)
      })
  })

  it('shows a stalled ESTABLISHMENT as connecting, with nothing waiting', () => {
    // The establishment half of the discriminator, against real pg.
    //
    // A socket that ACCEPTS and never speaks: pg completes the TCP connect,
    // sends its startup packet and waits. The client is in `_clients`, never in
    // `_idle`, never acquired. Local and deterministic, with no dependence on
    // how this host treats an unroutable address.
    // The accepted sockets are held so they can be destroyed at the end:
    // `server.close()` waits for open connections, and one the client abandoned
    // at its timeout can otherwise outlive the test (seen as a 20 s vitest
    // timeout with every assertion green).
    const accepted: Socket[] = []
    const silent = createServer((socket) => { accepted.push(socket) })
    return new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
      .then(async () => {
        const port = (silent.address() as AddressInfo).port
        const pool = makePool('real-stalled', {
          connectionString: undefined,
          host: '127.0.0.1',
          port,
          user: 'maplespire',
          database: 'maplespire',
          max: 2,
          connectionTimeoutMillis: 1_500,
        })
        const attempt = pool.connect().then(
          (client) => { client.release(); return 'connected' },
          (error: Error) => error.message,
        )
        await new Promise((r) => setTimeout(r, 250))

        // The signature: owned, not free, not handed out, and NOBODY queued —
        // `connect()` only enqueues when the pool is full.
        expect(snapshotOf('real-stalled')).toMatchObject({
          total: 1, idle: 0, checkedOut: 0, connecting: 1, waiting: 0,
        })
        expect(await attempt).toMatch(/timeout|terminated/i)
      })
      .finally(() => {
        for (const socket of accepted) socket.destroy()
        return new Promise<void>((resolve) => silent.close(() => resolve()))
      })
  })

  it('shows a blocked caller in waiting, not in connecting', async () => {
    // The queue signature: the pool is full, everything it owns is handed out,
    // and the next caller is queued.
    const pool = makePool('real-saturated', { max: 2 })
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      expect(snapshotOf('real-saturated')).toMatchObject({ total: 2, idle: 0, checkedOut: 2, waiting: 0 })

      const queued = pool.connect()
      // One turn of the loop is enough: `connect()` pushes into `_pendingQueue`
      // synchronously when the pool is full.
      await new Promise((resolve) => setImmediate(resolve))
      expect(snapshotOf('real-saturated')).toMatchObject({ checkedOut: 2, waiting: 1, connecting: 0 })

      a.release()
      const third = await queued
      expect(snapshotOf('real-saturated')).toMatchObject({ checkedOut: 2, waiting: 0 })
      third.release()
    } finally {
      b.release()
    }
    expect(snapshotOf('real-saturated')).toMatchObject({ checkedOut: 0, borrowHighWater: 2 })
  })

  it('keeps the count exact when a queued caller times out', async () => {
    // `pg-pool` removes a timed-out waiter from the pending queue and rejects
    // it WITHOUT an acquire, while a waiter that already reached
    // `_acquireClient` gets its acquire and an immediate synchronous release.
    // Either way the running difference must still equal what is held.
    const pool = makePool('real-timeout', { max: 1, connectionTimeoutMillis: 120 })
    const held = await pool.connect()
    try {
      await expect(pool.connect()).rejects.toThrow(/timeout exceeded/)
      const snapshot = snapshotOf('real-timeout')
      expect(snapshot?.checkedOut).toBe(1)
      expect((snapshot?.acquires ?? 0) - (snapshot?.releases ?? 0)).toBe(1)
      expect(snapshot?.waiting).toBe(0)
    } finally {
      held.release()
    }
    expect(snapshotOf('real-timeout')).toMatchObject({ checkedOut: 0 })
  })

  it('ages a borrow that is not given back, and the age KEEPS CLIMBING', async () => {
    const pool = makePool('real-age', { max: 2 })
    const client = await pool.connect()
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
      const first = snapshotOf('real-age')?.oldestBorrowMs ?? 0
      expect(first).toBeGreaterThanOrEqual(90)

      // The stated purpose of the field: a hold that will not end shows as an
      // age that keeps climbing. A floor alone would pass for a clamped age.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(snapshotOf('real-age')?.oldestBorrowMs ?? 0).toBeGreaterThan(first + 100)
    } finally {
      client.release()
    }
    expect(snapshotOf('real-age')?.oldestBorrowMs).toBeNull()
  })

  it('meters all four long-lived pools under the names an operator greps for', async () => {
    // The source gate in `poolErrorGuard.test.ts` proves every pool is GUARDED,
    // not that the four long-lived pools are metered under the right labels.
    //
    // `db.js` constructs its pools at module scope and `new pg.Pool(...)` opens
    // no connection, so this needs no database — it is here rather than in the
    // fake-pool file because it is about the real wiring.
    await import('../db.js')
    expect(poolMeterSnapshots().map((entry) => entry.pool)).toEqual(
      expect.arrayContaining(['primary', 'read-model', 'sync-cell', 'lifecycle-apply']),
    )
  })

  it('retires a pool from the registry once it has actually drained', async () => {
    const pool = makePool('real-retired', { max: 1 })
    await pool.query('SELECT 1')
    expect(snapshotOf('real-retired')).toBeDefined()

    await pool.end()
    opened.splice(opened.indexOf(pool), 1)
    expect(snapshotOf('real-retired')).toBeUndefined()
  })
})
