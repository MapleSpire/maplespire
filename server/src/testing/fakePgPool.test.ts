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
import { advisoryLockResponder, fakePgPool } from './fakePgPool.js'

/**
 * The fake is a gate, so the fake needs a gate.
 *
 * Three mutations of `fakePgPool.ts` survived the whole advisory-lock battery:
 * making `off` remove every listener regardless of identity, letting a double
 * `release()` pass, and hard-coding the listener count recorded at release. Each
 * one silently weakens several assertions elsewhere — and none of them is
 * visible from those assertions, because a more forgiving fake makes them
 * greener rather than redder.
 *
 * The same shape as `source-nul.test.mjs` checking its scanner against fixtures
 * before anybody trusts a scan. Every property below is one the REAL
 * `pg`/`pg-pool` has; that is the only reason the fake is allowed to have it.
 */

describe('the fake pool is no more forgiving than pg-pool', () => {
  it('removes a listener by identity, like EventEmitter', async () => {
    // The mistake this replaces counted `on`/`off` calls and ignored both the
    // event name and the function, so `off('close', aFreshClosure)` satisfied
    // `expect(listeners).toBe(0)` — while the real client kept the listener,
    // handed it back to the pool, and leaked it onto the next borrower.
    const fake = fakePgPool(advisoryLockResponder({}))
    const client = await fake.pool.connect()
    const handler = (): void => {}

    client.on('error', handler)
    expect(client.listenerCount('error')).toBe(1)

    client.off('error', () => {})
    expect(client.listenerCount('error')).toBe(1)

    client.off('close', handler)
    expect(client.listenerCount('error')).toBe(1)

    client.off('error', handler)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('throws on a double release, and on a query after release', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const client = await fake.pool.connect()
    client.release()
    expect(() => client.release()).toThrow(/already been released/)
    await expect(client.query('SELECT 1')).rejects.toThrow(/Cannot use a released client/)
  })

  it('records the listener count AT release, not afterwards', async () => {
    // The ordering witness. A caller that removes its own listener before
    // releasing leaves the client unguarded for the whole gap, and the unlock
    // statement runs in that gap. A hard-coded 1 here would make that
    // invisible.
    const fake = fakePgPool(advisoryLockResponder({}))
    const bare = await fake.pool.connect()
    bare.release()
    expect((fake.clients[0] as { releaseErrorListeners: number[] }).releaseErrorListeners).toEqual([0])

    const guarded = await fake.pool.connect()
    guarded.on('error', () => {})
    guarded.release()
    expect((fake.clients[1] as { releaseErrorListeners: number[] }).releaseErrorListeners).toEqual([1])
  })

  it('throws when an error is emitted with nobody listening', async () => {
    // Node's ERR_UNHANDLED_ERROR, which is what makes an unguarded checked-out
    // client a dead process rather than a logged warning.
    const fake = fakePgPool(advisoryLockResponder({}))
    const client = await fake.pool.connect()
    expect(() => client.emit('error', new Error('read ECONNRESET'))).toThrow(/Unhandled error/)

    const seen: unknown[] = []
    client.on('error', (error: never) => { seen.push(error) })
    client.emit('error', new Error('read ECONNRESET'))
    expect(seen).toHaveLength(1)
  })

  it('records every statement with its parameters and its guard state', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const client = await fake.pool.connect()
    client.on('error', () => {})
    await client.query('SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid', [77])

    expect(fake.only.statements).toEqual([
      { sql: expect.stringContaining('pg_try_advisory_lock'), values: [77], errorListeners: 1 },
    ])
  })

  it('rejects a statement it was given no answer for, rather than inventing one', async () => {
    // A fake that returns empty rows for anything it does not recognise turns a
    // typo in production SQL into a passing test.
    const fake = fakePgPool(advisoryLockResponder({}))
    const client = await fake.pool.connect()
    client.on('error', () => {})
    await expect(client.query('SELECT something_else()')).rejects.toThrow(/no answer for/)
  })
})
