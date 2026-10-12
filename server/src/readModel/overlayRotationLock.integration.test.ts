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

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  releaseOverlayRotationLock,
} from './overlayRotationLock.js'
// Not a hand-written `pool.on('error')`: a bare listener SWALLOWS, this one
// warns — and one test here deliberately leaves a session holding a key, which
// is precisely the run where an idle-client error is worth seeing.
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * The overlay-rotation lock against a REAL Postgres, because every claim this
 * module rests on is about the server or about pg-pool, and a fake can be
 * written to agree with either answer.
 *
 * Four properties, each with a control that must come back the other way:
 *
 *  1. a held key REFUSES instead of waiting — and the blocking form, in the
 *     same situation, is still waiting when the deadline expires;
 *  2. the hand-back after an acquisition actually drops the key;
 *  3. a BARE `client.release()` does NOT, and the next borrower of that backend
 *     is then ADMITTED to a key nobody released — which is why the `unknown`
 *     state ends the session instead;
 *  4. a refusal issues no unlock and leaves the connection usable.
 *
 * THE WITNESS IS `pg_locks`, decoded back to the key text, and never the handle
 * that took the lock. This file shares a database with suites running in other
 * vitest workers, so "count the advisory locks" is not a statement about this
 * test's key; and asking the holder would make a witness that cannot report
 * the one outcome it exists to forbid.
 */
/** `TEST_DATABASE_URL` first and NO hardcoded fallback, like the other DB-gated
 * files: this file deliberately LEAKS a session advisory lock in one test,
 * relying on `pool.end()` to reap it, so it must never default to a
 * developer's dev-stack database. */
const URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? ''

async function probePool(): Promise<pg.Pool | null> {
  if (!URL) return null
  const probe = guardIdleClientErrors(
    new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4_000 }),
    'overlayRotationLock:witness',
  )
  try {
    await probe.query('SELECT 1')
    return probe
  } catch {
    await probe.end().catch(() => undefined)
    return null
  }
}

const witnessPool = await probePool()
const suite = witnessPool ? describe : describe.skip
if (!witnessPool) console.warn(`[overlayRotationLock] no Postgres at ${URL} — skipping`)

/**
 * How many sessions hold this exact key, asked from a connection that holds
 * nothing.
 *
 * `pg_locks` reports a single-bigint advisory lock as classid = the high 32
 * bits, objid = the low 32, objsubid = 1. Recomposing them needs `numeric`:
 * `oid` has no cast to numeric (hence the `::bigint::numeric`), and the hash is
 * a SIGNED int8 while the two halves recompose to the unsigned value — so the
 * `+ 2^64 % 2^64` is not decoration. Verified on a key whose hash is positive
 * AND one whose hash is negative. A predicate that silently never matches would
 * make every zero below meaningless.
 */
async function keyHolders(lockKey: string): Promise<number> {
  const { rows } = await witnessPool!.query<{ held: number }>(
    `SELECT count(*)::int AS held
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND objsubid = 1
        AND classid::bigint::numeric * 4294967296 + objid::bigint::numeric
            = (hashtextextended($1, 0)::numeric + 18446744073709551616::numeric)
              % 18446744073709551616::numeric`,
    [lockKey],
  )
  return rows[0]?.held ?? 0
}

/** Pools opened by a test, ended afterwards. `pool.end()` closes the sessions,
 * which is the only thing that returns a session advisory lock one of these
 * tests deliberately leaked. */
const pools: pg.Pool[] = []
function poolOf(max = 1): pg.Pool {
  const pool = guardIdleClientErrors(
    new pg.Pool({ connectionString: URL, max, connectionTimeoutMillis: 4_000 }),
    'overlayRotationLock:test',
  )
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)))
})
afterAll(async () => { await witnessPool?.end().catch(() => undefined) })

suite('the overlay-rotation advisory lock, against a real Postgres', () => {
  it('REFUSES a held key in one round trip, and takes a free one', async () => {
    const lockKey = overlayRotationLockKey('land', 'i1', 'object')
    const holderPool = poolOf()
    const holder = await holderPool.connect()
    expect(await acquireOverlayRotationLock(holder, lockKey)).toBe('acquired')
    expect(await keyHolders(lockKey)).toBe(1)

    // THE ARM. A second session asks and is told no, promptly.
    const rivalPool = poolOf()
    const rival = await rivalPool.connect()
    const startedAt = Date.now()
    expect(await acquireOverlayRotationLock(rival, lockKey)).toBe('refused')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    await releaseOverlayRotationLock(rival, lockKey, 'refused')

    // THE CONTROL: with nothing holding the key, the same call succeeds.
    // Without it, "refused" could be a function that refuses everything.
    await releaseOverlayRotationLock(holder, lockKey, 'acquired')
    const freePool = poolOf()
    const free = await freePool.connect()
    expect(await acquireOverlayRotationLock(free, lockKey)).toBe('acquired')
    await releaseOverlayRotationLock(free, lockKey, 'acquired')
  })

  it('…and the statement it replaced is still waiting when a deadline expires', async () => {
    // THE DISCRIMINATOR, and the reason the test above is worth anything: the
    // same situation with the BLOCKING form. `recoverAdmittedOverlayRotations`
    // runs on the chain `start()` awaits, so a blocking wait there is not a
    // stalled tick — the pod would never finish starting, never install either
    // interval and never publish readiness.
    //
    // Its own test because it PERTURBS the key: a queued waiter is granted the
    // instant the holder lets go, so a "the key is free again" control sharing
    // this test would be measuring the waiter rather than the release.
    const lockKey = overlayRotationLockKey('land', 'i1b', 'object')
    const holderPool = poolOf()
    const holder = await holderPool.connect()
    expect(await acquireOverlayRotationLock(holder, lockKey)).toBe('acquired')

    const blockedPool = poolOf()
    const blocked = await blockedPool.connect()
    // A killed session raises an 'error' EVENT on the client, not a rejection.
    // Unhandled, vitest reports it as an uncaught exception and the file fails
    // on the instrument rather than on the subject.
    blocked.on('error', () => undefined)
    const outcome = await Promise.race([
      blocked.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
        .then(() => 'granted' as const, () => 'error' as const),
      new Promise<'still-waiting'>((resolve) => { setTimeout(() => resolve('still-waiting'), 750) }),
    ])
    expect(outcome).toBe('still-waiting')

    // The blocked client is never asked a second question — a statement queued
    // behind an unanswered one wedges. It is handed back WITH an error, which
    // destroys it: `pool.end()` waits for every checked-out client to come
    // back, and a bare release cannot be issued for a connection whose query
    // has not returned (without this, `afterEach` hangs for its full 30 s).
    blocked.release(new Error('probe: end the blocked session'))
    await releaseOverlayRotationLock(holder, lockKey, 'acquired')
  })

  it('hands the key back on `acquired` — 1 before, 0 after', async () => {
    const lockKey = overlayRotationLockKey('land', 'i2', 'connection')
    const pool = poolOf()
    const client = await pool.connect()
    expect(await acquireOverlayRotationLock(client, lockKey)).toBe('acquired')
    // The control is the pair: a zero taken without a one before it says
    // nothing, because a key nobody ever took also reads zero.
    expect(await keyHolders(lockKey)).toBe(1)
    await releaseOverlayRotationLock(client, lockKey, 'acquired')
    expect(await keyHolders(lockKey)).toBe(0)
  })

  it('a BARE release keeps the key, and re-admits the next borrower of that backend', async () => {
    // THE MEASUREMENT THE `unknown` BRANCH EXISTS FOR: why
    // `pg_advisory_unlock(...).catch(() => undefined)` followed by a bare
    // `client.release()` is a defect.
    //
    // pg-pool's `_release(client, listener, err)` removes the client only when
    // `err` is truthy; bare, it re-arms the idle listener and returns the SAME
    // backend — with the key still on it.
    const lockKey = overlayRotationLockKey('land', 'i3', 'object')
    const pool = poolOf(1)
    const leaker = await pool.connect()
    const leakedPid = (await leaker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    expect(await acquireOverlayRotationLock(leaker, lockKey)).toBe('acquired')
    leaker.release()
    expect(await keyHolders(lockKey)).toBe(1)

    // BOTH failure directions arrive at once, which is what makes this worse
    // than an ordinary leak. Every OTHER session is refused for ever…
    const strangerPool = poolOf()
    const stranger = await strangerPool.connect()
    expect(await acquireOverlayRotationLock(stranger, lockKey)).toBe('refused')

    // …and the next borrower of the leaked backend is ADMITTED, because an
    // advisory lock is COUNTED per session: asking for a key your own session
    // already holds succeeds. Two writers, one head.
    const next = await pool.connect()
    const samePid = (await next.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    expect(samePid).toBe(leakedPid)
    expect(await acquireOverlayRotationLock(next, lockKey)).toBe('acquired')

    // THE CONTROL, and it is the branch under test: `unknown` hands the
    // connection back destroyed, which ends the session — the only thing that
    // returns a key we may no longer have a handle on. The count goes to zero
    // even though the session took it TWICE, because ending a session drops
    // every lock it holds regardless of the counter.
    await releaseOverlayRotationLock(next, lockKey, 'unknown')
    await expect.poll(() => keyHolders(lockKey), { timeout: 4_000 }).toBe(0)
    await releaseOverlayRotationLock(stranger, lockKey, 'refused')
  })

  it('a refusal issues no unlock and leaves the connection usable', async () => {
    // Unlocking a key this session never took answers `false`, which the
    // release path reports as broken bookkeeping. Doing it after every refusal
    // would make that detector fire on the healthy path and retire it.
    const lockKey = overlayRotationLockKey('land', 'i4', 'connection')
    const holderPool = poolOf()
    const holder = await holderPool.connect()
    expect(await acquireOverlayRotationLock(holder, lockKey)).toBe('acquired')

    const pool = poolOf(1)
    const refused = await pool.connect()
    const pid = (await refused.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    expect(await acquireOverlayRotationLock(refused, lockKey)).toBe('refused')
    await releaseOverlayRotationLock(refused, lockKey, 'refused')

    // The same backend comes back out of the pool and answers — a destroyed
    // connection per contended row would drain a pool of four under exactly the
    // contention this lock must survive.
    const reused = await pool.connect()
    expect((await reused.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid).toBe(pid)
    reused.release()
    await releaseOverlayRotationLock(holder, lockKey, 'acquired')
    expect(await keyHolders(lockKey)).toBe(0)
  })

  it('`pg_advisory_unlock` answers false for a key this session never held', async () => {
    // The detector the `acquired` branch reads, and the reason it is a report
    // rather than a destroyed connection: `false` says the bookkeeping is
    // wrong, not that the connection is dirty.
    const lockKey = overlayRotationLockKey('land', 'i5', 'object')
    const pool = poolOf()
    const client = await pool.connect()
    const notHeld = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [lockKey],
    )
    expect(notHeld.rows[0]!.released).toBe(false)
    expect(await acquireOverlayRotationLock(client, lockKey)).toBe('acquired')
    const held = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [lockKey],
    )
    expect(held.rows[0]!.released).toBe(true)
    client.release()
  })
})
