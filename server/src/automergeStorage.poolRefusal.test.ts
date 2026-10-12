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
 * THE BOUND, AND THE REFUSAL, WITH A BEHAVIOUR WITNESS — NOT A WIRE CHECK.
 *
 * Asserting that a pool is PASSED says nothing about whether it is USED. Every
 * test here is written to fail if the mechanism is removed, not if a line is
 * edited.
 *
 * EACH TEST BUILDS ITS OWN POOL OBJECT. The gate is keyed by pool identity in a
 * `WeakMap` (that is what stops a per-request adapter from multiplying the
 * bound), so two tests sharing one pool double would share one gate and the
 * second would inherit the first's `max` and its in-flight count.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { PostgresStorageAdapter } from './automergeStorage.js'
import { StoragePoolExhaustedError } from './automergeStorageErrors.js'
import { dependencyOutageResponse } from './runtime/dependencyOutageResponse.js'
import { routeErrorResponse } from './routeErrors.js'

const KEY = ['2iagHJ2SQxAUTdyd7vG3LAaTicun', 'incremental', 'hash-1'] as never

/** A pool that can never lend a connection — `connect()` is all that is reached. */
function unlendablePool(message = 'timeout exceeded when trying to connect'): Pool {
  return { connect: () => Promise.reject(new Error(message)) } as unknown as Pool
}

/**
 * A pool whose `connect()` never settles, so every borrower stays in flight.
 * `connects` counts how many got that far — which is the only way to observe
 * the bound from outside.
 */
function stalledPool(): { pool: Pool; connects: () => number } {
  let connects = 0
  return {
    pool: {
      connect: () => { connects += 1; return new Promise<PoolClient>(() => undefined) },
    } as unknown as Pool,
    connects: () => connects,
  }
}

describe('the storage adapter refuses a borrow it cannot make', () => {
  it('throws a TYPED refusal, naming the operation, when the pool cannot lend', async () => {
    const adapter = new PostgresStorageAdapter({ db: unlendablePool() })
    const error = await adapter.save(KEY, new Uint8Array([1]))
      .then(() => null, (thrown: unknown) => thrown) as StoragePoolExhaustedError

    expect(error).toBeInstanceOf(StoragePoolExhaustedError)
    expect(error.reason).toBe('borrow-timeout')
    expect(error.code).toBe('storage-pool-exhausted')
    // The operation is in the message because an operator seeing this needs to
    // know WHICH storage path is starving, and the stack is not in the body.
    expect(error.message).toContain('unfenced-mutation')
  })

  it('keeps the pg error as the CAUSE and out of the message', async () => {
    // This message reaches an HTTP client through the shared mapping, and a
    // connect failure's text carries the host, the port and the role (same
    // property `lifecycleApplyLockRefusal.test.ts` pins for its own refusal).
    const leaky = 'connect ECONNREFUSED 10.0.0.7:5432 as maplespire_admin'
    const adapter = new PostgresStorageAdapter({ db: unlendablePool(leaky) })
    const error = await adapter.save(KEY, new Uint8Array([1]))
      .then(() => null, (thrown: unknown) => thrown) as StoragePoolExhaustedError

    expect(error.message).not.toContain('10.0.0.7')
    expect(error.message).not.toContain('5432')
    expect(error.message).not.toContain('maplespire_admin')
    expect((error.cause as Error | undefined)?.message).toBe(leaky)
  })

  it('runs no statement on the attempt that could not borrow', async () => {
    // ASSERTED ON THE CLIENT, NOT THE POOL: the adapter never uses
    // `pool.query`, so asserting on it would pass whether or not the borrow was
    // refused. What means something is that no client was handed out.
    const clientQuery = vi.fn(async () => ({ rows: [] }))
    let handedOut = 0
    const pool = {
      connect: () => {
        handedOut += 1
        return Promise.reject(new Error('timeout exceeded when trying to connect'))
      },
    } as unknown as Pool

    await expect(new PostgresStorageAdapter({ db: pool }).save(KEY, new Uint8Array([1]))).rejects
      .toBeInstanceOf(StoragePoolExhaustedError)
    expect(handedOut).toBeGreaterThan(0)
    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('POISONS the client on a transient failure, so the retry cannot reuse it', async () => {
    // `withDbRetry` retries once on the codes in `TRANSIENT_DB_CODES`, and its
    // contract is that "the pool discards the dead client before the retry".
    // `pg-pool` only discards when `release` is given the error
    // (`pg-pool/index.js`); a bare `release()` puts the client back on
    // `_idle` (`:427`) for the very next `connect()` (`:157-158`). A server-sent
    // `57P01` leaves `_queryable` TRUE (`pg/lib/client.js`), so the dead
    // client looks healthy and the retry draws the same one.
    const released: unknown[] = []
    let attempts = 0
    const pool = {
      connect: async () => ({
        query: async () => {
          attempts += 1
          if (attempts === 1) throw Object.assign(new Error('terminating connection'), { code: '57P01' })
          return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
        },
        release: (err?: unknown) => { released.push(err) },
        on: () => undefined,
        off: () => undefined,
      }),
    } as unknown as Pool

    await new PostgresStorageAdapter({ db: pool }).save(KEY, new Uint8Array([1]))
    expect(attempts).toBe(2)
    // First release carries the error (client destroyed); the successful retry
    // releases clean, so the healthy client goes back to the pool.
    expect((released[0] as { code?: string } | undefined)?.code).toBe('57P01')
    expect(released[1]).toBeUndefined()
  })

  it('does NOT poison the client when the adapter itself refuses the write', async () => {
    // The other half, and the reason the poisoning is predicated rather than
    // unconditional: a fence refusal is OUR error on a perfectly healthy
    // connection. One outage can quarantine thousands of mutations; releasing
    // each with an error would mean as many needless reconnects.
    const released: unknown[] = []
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [{ mapped: false, fence_valid: false, permitted: false }] }),
        release: (err?: unknown) => { released.push(err) },
        on: () => undefined,
        off: () => undefined,
      }),
    } as unknown as Pool

    await new PostgresStorageAdapter({ db: pool, ownership: { fencingToken: () => null } as never })
      .save(KEY, new Uint8Array([1])).catch(() => undefined)

    expect(released.length).toBeGreaterThan(0)
    expect(released.every((err) => err === undefined)).toBe(true)
  })

  it('reaches the client as a 503 with Retry-After — and deliberately NOT as retryable', async () => {
    const adapter = new PostgresStorageAdapter({ db: unlendablePool() })
    const error = await adapter.save(KEY, new Uint8Array([1])).then(() => null, (e: unknown) => e)

    const outage = dependencyOutageResponse(error)
    expect(outage?.status).toBe(503)
    expect(outage?.headers['Retry-After']).toBe('2')
    expect(outage?.subsystem).toBe('storage connection pool')
    // `retryable` means "safe to repeat" in this codebase. `Repo.flush` fans
    // `saveDoc` out with a `Promise.all` and `applyMerge` flushes four times,
    // so the operation that threw wrote nothing while its siblings may already
    // have committed. Asserting its ABSENCE is the point: the operation is
    // not safe to repeat.
    expect(outage?.body.retryable).toBeUndefined()

    // And the same answer through the door that actually serves the two failing
    // families, so the mapping being shared is witnessed rather than asserted.
    const routed = routeErrorResponse(error)
    expect(routed.status).toBe(503)
    expect(routed.body.error).not.toBe('read model query failed')
  })
})

describe('the bound BINDS — the behaviour, not the wiring', () => {
  it('never lets more than `dbConcurrency` borrows be outstanding at once', async () => {
    const { pool, connects } = stalledPool()
    const adapter = new PostgresStorageAdapter({ db: pool, dbConcurrency: 2, dbConcurrencyWaitMs: 10_000 })

    // Six concurrent mutations against a pool that never answers. Without the
    // gate all six reach `connect()`; with it, exactly two do and four park.
    const running = Array.from({ length: 6 }, (_, i) => adapter.save(
      [`2iagHJ2SQxAUTdyd7vG3LAaTicun`, 'incremental', `hash-${i}`] as never,
      new Uint8Array([i]),
    ).catch(() => undefined))

    await vi.waitFor(() => expect(connects()).toBe(2))
    // Held, not merely slow to start: a bound that only delayed the others
    // would show 6 here once the microtask queue drained.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(connects()).toBe(2)
    void running
  })

  it('SHARES one bound across every adapter on the same pool', async () => {
    // A per-instance gate would multiply by the number of live adapters and
    // bound nothing under the load it exists for, while every single-adapter
    // test still passed (see `poolConcurrencyGate`). This is the shipping
    // configuration: `index.ts` constructs a fresh adapter per promote-summary
    // REQUEST, against the same module-scope `pool` the sync server uses.
    const { pool, connects } = stalledPool()
    const first = new PostgresStorageAdapter({ db: pool, dbConcurrency: 2, dbConcurrencyWaitMs: 10_000 })
    const second = new PostgresStorageAdapter({ db: pool, dbConcurrency: 2, dbConcurrencyWaitMs: 10_000 })

    for (const [i, adapter] of [first, second, first, second, first, second].entries()) {
      void adapter.save(
        ['2iagHJ2SQxAUTdyd7vG3LAaTicun', 'incremental', `shared-${i}`] as never,
        new Uint8Array([i]),
      ).catch(() => undefined)
    }

    await vi.waitFor(() => expect(connects()).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 25))
    // TWO, not four. A per-instance gate gives each adapter its own 2.
    expect(connects()).toBe(2)
  })

  it('derives the DEFAULT bound from the pool, and the number is 4', async () => {
    // The constructor comment carries the derivation — `DB_POOL_MAX` 10, minus
    // 3 permanently-held LISTEN clients, leaves 7; the widest victim fan-out is
    // 5; so 4 leaves 3 free. A wrong number makes the bulkhead fail OPEN, which
    // reports success having bounded nothing.
    //
    // Asserted against a LITERAL rather than against the constant, so importing
    // the constant into the expectation cannot make this vacuous.
    const connects = { count: 0 }
    const pool = {
      options: { max: 10 },
      connect: () => { connects.count += 1; return new Promise<PoolClient>(() => undefined) },
    } as unknown as Pool
    const adapter = new PostgresStorageAdapter({ db: pool })

    for (let i = 0; i < 8; i += 1) {
      void adapter.save(
        ['2iagHJ2SQxAUTdyd7vG3LAaTicun', 'incremental', `default-${i}`] as never,
        new Uint8Array([i]),
      ).catch(() => undefined)
    }

    await vi.waitFor(() => expect(connects.count).toBe(4))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(connects.count).toBe(4)
  })

  it('refuses a mutation that waits out its deadline, with the reason that says so', async () => {
    const { pool } = stalledPool()
    const adapter = new PostgresStorageAdapter({ db: pool, dbConcurrency: 1, dbConcurrencyWaitMs: 20 })

    void adapter.save(KEY, new Uint8Array([1])).catch(() => undefined)
    const second = await adapter.save(
      ['2iagHJ2SQxAUTdyd7vG3LAaTicun', 'incremental', 'hash-2'] as never,
      new Uint8Array([2]),
    ).then(() => null, (e: unknown) => e) as StoragePoolExhaustedError

    // An UNTIMED queue would turn a 10 s failure into an unbounded one:
    // pg-pool's own pending queue has no depth cap, so its per-waiter timer is
    // the ONLY ceiling, and a gate in front of it must put one back.
    expect(second).toBeInstanceOf(StoragePoolExhaustedError)
    expect(second.reason).toBe('queue-timeout')
    expect(dependencyOutageResponse(second)?.status).toBe(503)
  })

  it('honours the CONFIGURED deadline, so the 2 000 ms policy is not a decoration', async () => {
    // The test above asserts THAT a refusal happens, never WHEN, and 2 000 ms
    // fits inside vitest's timeout — so this pins that the `dbConcurrencyWaitMs`
    // seam is honoured. The `Promise.race` makes a missing deadline fail fast
    // with a message instead of hitting the vitest timeout.
    const { pool } = stalledPool()
    const adapter = new PostgresStorageAdapter({ db: pool, dbConcurrency: 1, dbConcurrencyWaitMs: 40 })

    void adapter.save(KEY, new Uint8Array([1])).catch(() => undefined)
    const startedAt = Date.now()
    const refused = await Promise.race([
      adapter.save(['2iagHJ2SQxAUTdyd7vG3LAaTicun', 'incremental', 'timed'] as never, new Uint8Array([2]))
        .then(() => 'resolved', (e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve('NEVER SETTLED'), 1_500)),
    ])
    const elapsed = Date.now() - startedAt

    expect(refused).toBeInstanceOf(StoragePoolExhaustedError)
    // Against a LITERAL: a ceiling, not the absence of a value.
    // Generous on both sides — this asserts the configured 40 ms was used
    // rather than the 2 000 ms default, not the precision of a timer.
    expect(elapsed).toBeLessThan(1_000)
  })

  it('releases the client EXACTLY ONCE on the legacy fenced path', async () => {
    // `executeLegacyFencedMutation` takes the client from `withBoundedClient`
    // and keeps only the `error` listener removal; a second `client.release()`
    // in its `finally` would return a client the pool may already have lent to
    // someone else. Reached only through the `afterFenceLocked` seam.
    let releases = 0
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.startsWith('SELECT landscape_id')) return { rows: [] }
          if (sql.startsWith('SELECT fencing_token')) return { rows: [{ fencing_token: '7', released_at: null }] }
          return { rows: [] }
        },
        release: () => { releases += 1 },
        on: () => undefined,
        off: () => undefined,
      }),
    } as unknown as Pool

    const adapter = new PostgresStorageAdapter({
      db: pool,
      ownership: { fencingToken: () => '7' } as never,
      afterFenceLocked: async () => undefined,
    })
    await adapter.save(KEY, new Uint8Array([1]))

    expect(releases).toBe(1)
  })

  it('does NOT gate reads — the asymmetry is a decision, so it gets a witness', async () => {
    // Deliberate: `load`/`loadRange` are not among the pool-starving holders,
    // `StorageSubsystem.loadDocData` issues two `loadRange` per document, and a
    // bound there multiplies by the document count against a ~245 ms cold
    // boot. Pinned so that gating them later is a visible change. `dbConcurrency: 1` would admit exactly one borrow if reads
    // were gated; three get through.
    const { pool, connects } = stalledPool()
    const adapter = new PostgresStorageAdapter({ db: pool, dbConcurrency: 1, dbConcurrencyWaitMs: 20 })

    void adapter.load(KEY).catch(() => undefined)
    void adapter.load(KEY).catch(() => undefined)
    void adapter.loadRange(['2iagHJ2SQxAUTdyd7vG3LAaTicun'] as never).catch(() => undefined)

    await vi.waitFor(() => expect(connects()).toBe(3))
  })
})
