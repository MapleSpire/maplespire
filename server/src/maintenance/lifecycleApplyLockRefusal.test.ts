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
 * THE POOL-EXHAUSTION REFUSAL, WITHOUT A DATABASE.
 *
 * `acquireLifecycleApplyLock` catches the failure of `db.connect()` AT THE
 * ACQUISITION SITE and turns it into `LifecycleApplyRefusedError('pool-exhausted')`,
 * which `routeErrors.ts` answers 503 + `Retry-After: 5` + `retryable: true`.
 * With a small dedicated lock pool, that refusal arrives quickly (about 2 s)
 * instead of after the primary pool's 10 s connect timeout.
 *
 * The failing arm needs NO database: a pool whose `connect()` rejects is enough,
 * because nothing else on the object is touched before the throw. So this file
 * runs everywhere, while `lifecycleApplyLock.integration.test.ts` (skipped
 * without `TEST_DATABASE_URL`) keeps the control proving the same call succeeds
 * against a real server.
 */
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { acquireLifecycleApplyLock, LifecycleApplyRefusedError, withLifecycleApplyLock } from './lifecycleApplyLock.js'
import { routeErrorResponse } from '../routeErrors.js'

const WORKSPACE = { landscapeId: 'land-refusal', versionId: 'ver-refusal' }

/** A pool that can never lend a connection. `connect()` is all that is reached. */
const exhaustedPool = (message = 'timeout exceeded when trying to connect') => ({
  connect: () => Promise.reject(new Error(message)),
}) as unknown as Pool

describe('acquireLifecycleApplyLock — the borrow that fails', () => {
  it('converts an untyped pg failure into a TYPED refusal at the acquisition site', async () => {
    const error = await acquireLifecycleApplyLock(exhaustedPool(), WORKSPACE)
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(LifecycleApplyRefusedError)
    expect((error as LifecycleApplyRefusedError).code).toBe('pool-exhausted')
  })

  it('keeps the pg error as the CAUSE and out of the message', async () => {
    // The message must not carry the pg error: a connect failure's text
    // includes the host, port and role, and `routeErrors.ts` passes this
    // message through to the HTTP client.
    const leaky = 'connect ECONNREFUSED 10.0.0.7:5432 as maplespire_admin'
    const error = await acquireLifecycleApplyLock(exhaustedPool(leaky), WORKSPACE)
      .then(() => null, (thrown: unknown) => thrown) as LifecycleApplyRefusedError

    expect(error.message).not.toContain('10.0.0.7')
    expect(error.message).not.toContain('5432')
    expect(error.message).not.toContain('maplespire_admin')
    // The detail is not lost — it is on the cause, for the server log.
    expect((error.cause as Error | undefined)?.message).toBe(leaky)
  })

  it('names the workspace, so an operator knows WHICH apply was refused', async () => {
    const error = await acquireLifecycleApplyLock(exhaustedPool(), WORKSPACE)
      .then(() => null, (thrown: unknown) => thrown) as LifecycleApplyRefusedError
    expect(error.message).toContain(WORKSPACE.landscapeId)
    expect(error.message).toContain(WORKSPACE.versionId)
  })

  it('says NOTHING WAS WRITTEN, and the code path is why', async () => {
    // The claim a caller acts on: this refusal is safe to retry because the
    // throw happens BEFORE any query. The wrapper is what proves it — the
    // critical section cannot have run if it was never reached.
    let ran = false
    const error = await withLifecycleApplyLock(exhaustedPool(), WORKSPACE, async () => { ran = true; return 'x' })
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(LifecycleApplyRefusedError)
    expect(ran).toBe(false)
  })

  it('reaches the client as 503 + Retry-After + retryable, not as a 500', async () => {
    // End-to-end shape, derived from the real mapping: dropping
    // `pool-exhausted` from the transient branch would turn the refusal into
    // a 500.
    const error = await acquireLifecycleApplyLock(exhaustedPool(), WORKSPACE)
      .then(() => null, (thrown: unknown) => thrown)

    const response = routeErrorResponse(error)
    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBe('5')
    expect(response.body.code).toBe('pool-exhausted')
    expect(response.body.retryable).toBe(true)
  })

  it('does NOT swallow a failure that is not a borrow failure', async () => {
    // The negative control. `acquireLifecycleApplyLock` wraps only `connect()`;
    // if it wrapped more, a genuine bug inside the lock query would be reported
    // to operators as "the pool is saturated" — the wrong subsystem.
    const lockQueryFails = {
      connect: () => Promise.resolve({
        query: () => Promise.reject(new Error('syntax error at or near "SELCT"')),
        release: () => undefined,
        on: () => undefined,
      }),
    } as unknown as Pool

    const error = await acquireLifecycleApplyLock(lockQueryFails, WORKSPACE)
      .then(() => null, (thrown: unknown) => thrown) as Error

    expect(error).toBeTruthy()
    expect((error as LifecycleApplyRefusedError).code).not.toBe('pool-exhausted')
  })
})
