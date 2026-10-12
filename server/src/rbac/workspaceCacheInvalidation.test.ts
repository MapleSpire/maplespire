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
 * The LISTEN plumbing, against the same
 * fake-client shape wsAuth.test.ts uses for the channel it mirrors. The real
 * triggers' emission is pinned by the DB-gated twin
 * (workspaceCacheInvalidation.integration.test.ts); THIS file pins the
 * payload routing, the malformed-payload tolerance, the reconnect cadence and
 * the pump's resilience to a throwing handler.
 */

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  startWorkspaceCacheInvalidation,
  WORKSPACE_COVERAGE_CHANNEL,
  WORKSPACE_VERSION_CREATED_CHANNEL,
  WORKSPACE_ROUTE_CHANGED_CHANNEL,
  WORKSPACE_CACHE_INVALIDATION_STOP_CEILING_MS,
} from './workspaceCacheInvalidation.js'

const routeSchema = 'test_route_cache'
const queryResult = (sql: string) => ({ rows: sql === 'SELECT current_schema() AS schema' ? [{ schema: routeSchema }] : [] })
const routePayload = (landscapeId: unknown, schema = routeSchema) => JSON.stringify({ schema, landscapeId })

function fakeClient() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => queryResult(sql)),
    release: vi.fn(),
  })
}

describe('workspace cache invalidation listener', () => {
  it('LISTENs both channels, routes payloads to the right handler, and UNLISTENs on stop', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const onCoverageChanged = vi.fn()
    const onVersionCreated = vi.fn()
    const handle = startWorkspaceCacheInvalidation(pool as never, { onCoverageChanged, onVersionCreated })

    await vi.waitFor(() => {
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_VERSION_CREATED_CHANNEL}`)
    })

    client.emit('notification', { channel: WORKSPACE_COVERAGE_CHANNEL, payload: 'L1/V1' })
    expect(onCoverageChanged).toHaveBeenCalledExactlyOnceWith({ landscapeId: 'L1', versionId: 'V1' })

    client.emit('notification', { channel: WORKSPACE_VERSION_CREATED_CHANNEL, payload: 'L1' })
    expect(onVersionCreated).toHaveBeenCalledExactlyOnceWith('L1')

    // Malformed payloads drop NOTHING and call NOTHING — ignoring is always
    // safe (the TTL remains the net), acting on garbage never is.
    for (const bad of ['', 'no-slash', '/V-orphan', 'L-orphan/']) {
      client.emit('notification', { channel: WORKSPACE_COVERAGE_CHANNEL, payload: bad })
    }
    client.emit('notification', { channel: WORKSPACE_VERSION_CREATED_CHANNEL, payload: '' })
    // An unrelated channel on the same connection is not ours to interpret.
    client.emit('notification', { channel: 'auth_epoch', payload: 'org-1' })
    expect(onCoverageChanged).toHaveBeenCalledTimes(1)
    expect(onVersionCreated).toHaveBeenCalledTimes(1)

    await handle.stop()
    expect(client.query).toHaveBeenCalledWith(`UNLISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
    expect(client.query).toHaveBeenCalledWith(`UNLISTEN ${WORKSPACE_VERSION_CREATED_CHANNEL}`)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('re-establishes a dropped LISTEN client on the retry cadence', async () => {
    const first = fakeClient()
    const second = fakeClient()
    const pool = { connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
    const onCoverageChanged = vi.fn()
    const handle = startWorkspaceCacheInvalidation(
      pool as never,
      { onCoverageChanged, onVersionCreated: vi.fn() },
      { reconnectMs: 20 },
    )
    await vi.waitFor(() => {
      expect(first.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
    })

    // The connection dies — pg surfaces it as an 'error' event, exactly the
    // shape wsAuth handles: mark dead, reconnect lazily.
    first.emit('error', new Error('server closed the connection unexpectedly'))

    await vi.waitFor(() => {
      expect(second.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
    })
    second.emit('notification', { channel: WORKSPACE_COVERAGE_CHANNEL, payload: 'L9/V9' })
    expect(onCoverageChanged).toHaveBeenCalledWith({ landscapeId: 'L9', versionId: 'V9' })

    await handle.stop()
  })

  // ======================================================================
  // A dead LISTEN client must give its SLOT back.
  // In node-postgres a checked-out client whose connection died stays counted
  // by the pool until release() is called; `listenClient = null` alone leaks
  // one DB_POOL_MAX slot (default 10, dbConfig.ts) per Postgres
  // restart/failover, for the life of the process — after a few incidents
  // every gate that borrows from the shared pool times out in a loop.
  // ======================================================================

  it("the 'error' event releases the dead client back to the shared pool — WITH the error, so it is destroyed", async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const handle = startWorkspaceCacheInvalidation(
      pool as never,
      { onCoverageChanged: vi.fn(), onVersionCreated: vi.fn() },
    )
    await vi.waitFor(() => {
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
    })

    const boom = new Error('server closed the connection unexpectedly')
    client.emit('error', boom)

    // Without release() the slot is counted forever. The
    // ERROR argument is part of the contract: release(err) destroys the dead
    // connection instead of recycling it into the next checkout.
    expect(client.release).toHaveBeenCalledExactlyOnceWith(boom)

    // And stop() must not double-release what the handler already returned.
    await handle.stop()
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('a client whose LISTEN statement fails is destroyed too — the catch path holds the same slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async () => { throw new Error('permission denied for LISTEN') }),
        release: vi.fn(),
      })
      const pool = { connect: vi.fn(async () => client) }
      const handle = startWorkspaceCacheInvalidation(
        pool as never,
        { onCoverageChanged: vi.fn(), onVersionCreated: vi.fn() },
      )
      await vi.waitFor(() => {
        expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
      })
      await handle.stop()
      expect(client.release).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  // The reconnect interval is deliberately NON-unref'd (an unref'd interval
  // was observed not to fire under tsx), so a stop() that skips
  // clearInterval retains the whole process at graceful shutdown. Counting
  // connect calls cannot catch that — the `stopped` guard silences the
  // reconnects — so the witness is the timer count itself.
  it('stop() disarms the reconnect interval — no timer may survive the handle', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      const pool = { connect: vi.fn(async () => client) }
      const handle = startWorkspaceCacheInvalidation(
        pool as never,
        { onCoverageChanged: vi.fn(), onVersionCreated: vi.fn() },
        { reconnectMs: 20 },
      )
      // Fake timers stall vi.waitFor's clock; the fake client settles in
      // microtasks, so a manual flush reaches the LISTEN statements.
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
      // An honest zero needs a known one first: the armed interval is visible.
      expect(vi.getTimerCount()).toBe(1)

      await handle.stop()

      // Without clearInterval this would still read 1.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing handler does not kill the pump for later notifications', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const onCoverageChanged = vi.fn(() => { throw new Error('handler exploded') })
    const onVersionCreated = vi.fn()
    const handle = startWorkspaceCacheInvalidation(pool as never, { onCoverageChanged, onVersionCreated })
    await vi.waitFor(() => {
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_COVERAGE_CHANNEL}`)
    })

    client.emit('notification', { channel: WORKSPACE_COVERAGE_CHANNEL, payload: 'L1/V1' })
    client.emit('notification', { channel: WORKSPACE_VERSION_CREATED_CHANNEL, payload: 'L2' })

    expect(onCoverageChanged).toHaveBeenCalledTimes(1)
    expect(onVersionCreated, 'the second notification must survive the first handler throwing')
      .toHaveBeenCalledExactlyOnceWith('L2')

    await handle.stop()
  })
})

describe('canonical route invalidation and listener lifetime', () => {
  const handlers = () => ({ onCoverageChanged: vi.fn(), onVersionCreated: vi.fn(), onRouteChanged: vi.fn() })
  const microtasks = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

  it('subscribes to route lifecycle events, validates ids, and forgets startup gaps', async () => {
    const client = fakeClient()
    const callbacks = handlers()
    const handle = startWorkspaceCacheInvalidation({ connect: async () => client } as never, callbacks)
    try {
      await vi.waitFor(() => expect(callbacks.onRouteChanged).toHaveBeenCalledWith(null))
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_ROUTE_CHANGED_CHANNEL}`)
      callbacks.onRouteChanged.mockClear()
      client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload('L-version-retired') })
      client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload(null) })
      for (const payload of ['', 'L/V', 'L invalid', 'L'.repeat(161)]) {
        client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload(payload) })
      }
      client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload(null, 'foreign_schema') })
      client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload('L-version-retired', 'foreign_schema') })
      client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: 'malformed json' })
      expect(callbacks.onRouteChanged.mock.calls).toEqual([['L-version-retired'], [null]])
      expect(callbacks.onVersionCreated).not.toHaveBeenCalled()
    } finally { await handle.stop() }
    expect(client.query).toHaveBeenCalledWith(`UNLISTEN ${WORKSPACE_ROUTE_CHANGED_CHANNEL}`)
    callbacks.onRouteChanged.mockClear()
    client.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload('after-stop') })
    expect(callbacks.onRouteChanged).not.toHaveBeenCalled()
  })

  it('drops caches on listener loss and recovery and ignores notifications from the replaced client', async () => {
    const first = fakeClient(), second = fakeClient()
    const callbacks = handlers()
    const pool = { connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
    const handle = startWorkspaceCacheInvalidation(pool as never, callbacks, { reconnectMs: 10 })
    try {
      await vi.waitFor(() => expect(callbacks.onRouteChanged).toHaveBeenCalledTimes(1))
      first.emit('error', new Error('lost listener'))
      expect(callbacks.onRouteChanged).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => expect(callbacks.onRouteChanged).toHaveBeenCalledTimes(3))
      callbacks.onRouteChanged.mockClear()
      first.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload('old-client') })
      second.emit('notification', { channel: WORKSPACE_ROUTE_CHANGED_CHANNEL, payload: routePayload('live-client') })
      expect(callbacks.onRouteChanged.mock.calls).toEqual([['live-client']])
    } finally { await handle.stop() }
    expect(first.release).toHaveBeenCalledOnce()
    expect(second.release).toHaveBeenCalledOnce()
  })

  it('stop joins a pending checkout and returns that late client without subscribing', async () => {
    const client = fakeClient()
    let checkout!: (client: ReturnType<typeof fakeClient>) => void
    const pool = { connect: () => new Promise<ReturnType<typeof fakeClient>>(done => { checkout = done }) }
    const handle = startWorkspaceCacheInvalidation(pool as never, handlers())
    const stopping = handle.stop()
    expect(handle.stop()).toBe(stopping)
    let completed = false
    void stopping.then(() => { completed = true })
    await microtasks()
    expect(completed).toBe(false)
    checkout(client)
    await stopping
    expect(completed).toBe(true)
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('stop joins a pending LISTEN and never starts the following LISTEN', async () => {
    let finish!: () => void
    const firstListen = new Promise<void>(done => { finish = done })
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('LISTEN ')) await firstListen
        return queryResult(sql)
      }), release: vi.fn(),
    })
    const handle = startWorkspaceCacheInvalidation({ connect: async () => client } as never, handlers())
    await microtasks()
    const stopping = handle.stop()
    let completed = false
    void stopping.then(() => { completed = true })
    await microtasks()
    expect(completed).toBe(false)
    expect(client.release).not.toHaveBeenCalled()
    finish()
    await stopping
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('LISTEN '))).toHaveLength(1)
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('UNLISTEN '))).toHaveLength(3)
    expect(client.release).toHaveBeenCalledOnce()
  })

  for (const stage of ['checkout', 'LISTEN', 'UNLISTEN'] as const) {
    it(`a stuck ${stage} rejects stop rather than claiming closure; late work cannot resubscribe`, async () => {
      vi.useFakeTimers()
      let finish!: (value?: unknown) => void
      const held = new Promise<unknown>(done => { finish = done })
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async (sql: string) => {
          if ((stage === 'LISTEN' && sql.startsWith('LISTEN ')) || (stage === 'UNLISTEN' && sql.startsWith('UNLISTEN '))) await held
          return queryResult(sql)
        }), release: vi.fn(),
      })
      const pool = { connect: async () => stage === 'checkout' ? await held : client }
      const handle = startWorkspaceCacheInvalidation(pool as never, handlers())
      try {
        await microtasks()
        const stopping = handle.stop()
        const verdict = stopping.then(() => 'resolved', error => error)
        await vi.advanceTimersByTimeAsync(WORKSPACE_CACHE_INVALIDATION_STOP_CEILING_MS + 1)
        expect(await verdict).toBeInstanceOf(Error)
        const callsAtFailure = client.query.mock.calls.length
        finish(stage === 'checkout' ? client : undefined)
        await microtasks()
        expect(client.query).toHaveBeenCalledTimes(callsAtFailure)
        expect(client.release).toHaveBeenCalledOnce()
        if (stage !== 'checkout') expect(client.release).toHaveBeenCalledWith(expect.any(Error))
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        finish(stage === 'checkout' ? client : undefined)
        await microtasks()
        vi.useRealTimers()
      }
    })
  }

  it('a failed third LISTEN destroys its client and leaves the existing TTL fallback', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql === `LISTEN ${WORKSPACE_ROUTE_CHANGED_CHANNEL}`) throw new Error('third LISTEN failed')
        return queryResult(sql)
      }), release: vi.fn(),
    })
    const callbacks = handlers()
    const handle = startWorkspaceCacheInvalidation({ connect: async () => client } as never, callbacks)
    try {
      await vi.waitFor(() => expect(client.release).toHaveBeenCalledWith(expect.any(Error)))
      expect(callbacks.onRouteChanged).toHaveBeenCalledWith(null)
    } finally { await handle.stop() }
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('a failed release cannot make stop report success', async () => {
    const client = fakeClient()
    const error = new Error('release was not confirmed')
    client.release.mockImplementation(() => { throw error })
    const handle = startWorkspaceCacheInvalidation({ connect: async () => client } as never, handlers())
    await microtasks()
    await expect(handle.stop()).rejects.toBe(error)
  })
})
