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

import { EventEmitter } from 'node:events'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { PlacementInvalidationListener } from './placementInvalidation.js'
import { WORKSPACE_PLACEMENT_CHANNEL } from './workspacePlacement.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn(),
  })
  const connect = vi.fn().mockResolvedValue(client)
  const invalidate = vi.fn(), errors = vi.fn()
  const listener = new PlacementInvalidationListener({ connect } as unknown as Pool, invalidate, errors)
  return { client, connect, invalidate, errors, listener }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe('placement LISTEN resource lifetime', () => {
  it.each([1, 2])('checks the real normalized pool budget max=%i before any checkout', async (max) => {
    const pool = guardIdleClientErrors(new Pool({ max }), 'placement-listener-budget-test')
    const connect = vi.spyOn(pool, 'connect')
    try {
      expect(pool.options.max).toBe(max)
      if (max === 1) {
        expect(() => new PlacementInvalidationListener(pool, vi.fn(), vi.fn()))
          .toThrow('pool max of at least 2')
      } else {
        const listener = new PlacementInvalidationListener(pool, vi.fn(), vi.fn())
        await listener.stop()
      }
      expect(connect).not.toHaveBeenCalled()
      expect(pool.totalCount).toBe(0)
    } finally {
      connect.mockRestore()
      await pool.end()
    }
  })

  it('subscribes before signaling the baseline and accepts only its channel', async () => {
    const { client, invalidate, listener } = fixture()
    const listen = deferred<unknown>()
    client.query.mockReturnValue(listen.promise)
    const connecting = listener.connect()
    await tick()
    expect(invalidate).not.toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(1)
    expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_PLACEMENT_CHANNEL}`)
    client.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL, payload: '' })
    expect(invalidate).toHaveBeenCalledTimes(1)
    client.emit('notification', { channel: 'unrelated', payload: 'forged placement' })
    expect(invalidate).toHaveBeenCalledTimes(1)
    listen.resolve({ rows: [] })
    await connecting
    expect(invalidate).toHaveBeenCalledTimes(2)
    await listener.stop()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    client.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('coalesces checkout, and stop joins a late checkout before releasing once', async () => {
    const { client, connect, listener, invalidate } = fixture()
    const checkout = deferred<PoolClient>()
    connect.mockReturnValue(checkout.promise)
    const first = listener.connect()
    expect(listener.connect()).toBe(first)
    const stopping = listener.stop()
    expect(listener.stop()).toBe(stopping)
    let stopped = false
    void stopping.then(() => { stopped = true })
    await tick()
    expect(stopped).toBe(false)
    expect(connect).toHaveBeenCalledTimes(1)
    checkout.resolve(client as unknown as PoolClient)
    await stopping
    await first
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    expect(client.query).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    await listener.connect()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('destroys a pending LISTEN at stop and joins the actual query rejection', async () => {
    const { client, listener, invalidate } = fixture()
    const listen = deferred<unknown>()
    client.query.mockReturnValue(listen.promise)
    const connecting = listener.connect()
    const observed = connecting.catch(error => error)
    await tick()
    const stopping = listener.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    await tick()
    expect(stopped).toBe(false)
    listen.reject(new Error('Connection terminated'))
    await stopping
    expect(await observed).toBeInstanceOf(Error)
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('releases a failed LISTEN and allows a single fresh attempt', async () => {
    const { client, connect, listener, invalidate } = fixture()
    client.query.mockRejectedValue(new Error('LISTEN failed'))
    await expect(listener.connect()).rejects.toThrow('LISTEN failed')
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    const replacement = fixture().client
    connect.mockResolvedValue(replacement)
    await listener.connect()
    expect(invalidate).toHaveBeenCalledTimes(1)
    await listener.stop()
    expect(replacement.release).toHaveBeenCalledTimes(1)
  })

  it('reconnects after error or end, invalidates the blind interval, ignores old notifications', async () => {
    for (const event of ['error', 'end']) {
      const { client, connect, listener, invalidate, errors } = fixture()
      await listener.connect()
      client.emit(event, new Error('connection lost'))
      expect(client.release).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledTimes(1)
      const replacement = fixture().client
      connect.mockResolvedValue(replacement)
      await listener.connect()
      expect(invalidate).toHaveBeenCalledTimes(2)
      client.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })
      client.emit('error', new Error('late error'))
      await listener.connect()
      expect(connect).toHaveBeenCalledTimes(2)
      replacement.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })
      expect(invalidate).toHaveBeenCalledTimes(3)
      await listener.stop()
      expect(client.release).toHaveBeenCalledTimes(1)
      expect(replacement.release).toHaveBeenCalledTimes(1)
    }
  })

  it('a throwing notification handler is reported and does not kill the listener', async () => {
    const { client, listener, invalidate, errors } = fixture()
    await listener.connect()
    invalidate.mockImplementationOnce(() => { throw new Error('handler failed') })
    expect(() => client.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })).not.toThrow()
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'handler failed' }))
    client.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })
    expect(invalidate).toHaveBeenCalledTimes(3)
    await listener.stop()
  })
})
