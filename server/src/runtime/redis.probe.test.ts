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

import { createClient } from 'redis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisRuntime } from './redis.js'

vi.mock('redis', () => ({ createClient: vi.fn() }))

/**
 * `RedisRuntime.probe()` — the readiness door's question to Redis. Unlike `send()`, which owns the command path and RECYCLES the
 * multiplexed connection when a command goes silent, a health probe is an
 * observer: it must never destroy the connection that quotas, leases and
 * maintenance share, must answer within the command timeout, and must never
 * throw into a healthcheck.
 */
describe('RedisRuntime.probe', () => {
  const config = (commandTimeoutMs: number) => ({
    url: 'redis://critical-redis:6379',
    host: null,
    port: 6_379,
    tls: false,
    username: undefined,
    password: undefined,
    required: true,
    keyPrefix: 'probe-test',
    connectWaitMs: 100,
    commandTimeoutMs,
  })

  const fakeClient = (sendCommand: (...args: unknown[]) => Promise<unknown>) => {
    const client = {
      isOpen: true,
      isReady: true,
      on: vi.fn(),
      sendCommand: vi.fn(sendCommand),
      connect: vi.fn(async () => { client.isOpen = true; client.isReady = true }),
      close: vi.fn(async () => { client.isOpen = false; client.isReady = false }),
      destroy: vi.fn(() => { client.isOpen = false; client.isReady = false }),
    }
    vi.mocked(createClient).mockReturnValue(client as never)
    return client
  }

  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('a PING that never settles is `false` at the command timeout, and the connection is left ALONE', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = fakeClient(() => new Promise(() => undefined))
    const runtime = new RedisRuntime(config(250))

    const probe = runtime.probe()
    let settled: boolean | null = null
    void probe.then((value) => { settled = value })
    await vi.advanceTimersByTimeAsync(249)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)

    // The observer did not recycle: no destroy, no reconnect, socket still open.
    expect(client.destroy).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.isOpen).toBe(true)
    expect(client.isReady).toBe(true)
  })

  it('PONG is `true`; anything else, or a rejection, is `false` — and nothing throws', async () => {
    const client = fakeClient(async () => 'PONG')
    const runtime = new RedisRuntime(config(250))
    await expect(runtime.probe()).resolves.toBe(true)
    expect(client.sendCommand).toHaveBeenCalledWith(['PING'], expect.anything())

    client.sendCommand.mockImplementationOnce(async () => 'LOADING')
    await expect(runtime.probe()).resolves.toBe(false)

    client.sendCommand.mockImplementationOnce(async () => { throw new Error('ECONNRESET') })
    await expect(runtime.probe()).resolves.toBe(false)
  })

  it('a client that is not ready is `false` at once, without sending anything', async () => {
    const client = fakeClient(async () => 'PONG')
    client.isReady = false
    const runtime = new RedisRuntime(config(5_000))
    const startedAt = Date.now()
    await expect(runtime.probe()).resolves.toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(client.sendCommand).not.toHaveBeenCalled()
  })

  it('an unconfigured runtime is `false` (the door reports it as null itself)', async () => {
    vi.mocked(createClient).mockReturnValue(null as never)
    const runtime = new RedisRuntime({ ...config(250), url: null, host: null })
    await expect(runtime.probe()).resolves.toBe(false)
  })

  it('single-flight: concurrent probes share ONE PING', async () => {
    let resolvePing!: (value: string) => void
    const client = fakeClient(() => new Promise<string>((resolvePong) => { resolvePing = resolvePong }))
    const runtime = new RedisRuntime(config(5_000))

    const first = runtime.probe()
    const second = runtime.probe()
    const third = runtime.probe()
    expect(client.sendCommand).toHaveBeenCalledTimes(1)
    resolvePing('PONG')
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])

    // The flight is released: the next probe asks again (and gets its own reply).
    const fourth = runtime.probe()
    expect(client.sendCommand).toHaveBeenCalledTimes(2)
    resolvePing('PONG')
    await expect(fourth).resolves.toBe(true)
  })

  it('after a timed-out probe, `send` still uses the same open connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'] })
    const client = fakeClient(() => new Promise(() => undefined))
    const runtime = new RedisRuntime(config(100))

    const probe = runtime.probe()
    await vi.advanceTimersByTimeAsync(100)
    await expect(probe).resolves.toBe(false)

    client.sendCommand.mockImplementationOnce(async () => 'still-here')
    await expect(runtime.send<string>(['GET', 'lease'])).resolves.toBe('still-here')
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('stop() does not wait for a close() that never resolves — bounded by the command timeout, then destroy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = fakeClient(() => new Promise(() => undefined))
    client.close = vi.fn(() => new Promise<void>(() => undefined)) // node-redis: resolves only when the queue drains
    const runtime = new RedisRuntime(config(300))
    let stopped = false
    void runtime.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(299)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(stopped).toBe(true)
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('stop() with a probe PING still pending destroys at once and never calls close() — close() would wait for a reply the peer will not send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = fakeClient(() => new Promise(() => undefined))
    client.close = vi.fn(() => new Promise<void>(() => undefined))
    const runtime = new RedisRuntime(config(200))
    const probe = runtime.probe()
    await vi.advanceTimersByTimeAsync(200)
    await expect(probe).resolves.toBe(false) // settled by the bound; the PING is still in the queue
    let stopped = false
    void runtime.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(true)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('stop() on a client whose close() resolves does not destroy it', async () => {
    const client = fakeClient(async () => 'PONG')
    const runtime = new RedisRuntime(config(300))
    await runtime.stop()
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('a probe that was ANSWERED leaves nothing pending: stop() afterwards closes gracefully, it does not destroy', async () => {
    // A pending-probe counter that never came back down after a PONG would
    // make every later stop() take the destroy path on a healthy peer.
    const client = fakeClient(async () => 'PONG')
    const runtime = new RedisRuntime(config(300))
    await expect(runtime.probe()).resolves.toBe(true)
    await expect(runtime.probe()).resolves.toBe(true)
    await runtime.stop()
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('a probe whose PING was REJECTED (flushed) leaves nothing pending either: stop() closes gracefully', async () => {
    const client = fakeClient(async () => { throw new Error('flushed') })
    const runtime = new RedisRuntime(config(300))
    await expect(runtime.probe()).resolves.toBe(false)
    await runtime.stop()
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('a late PONG after the timeout is ignored, not an unhandled rejection and not a `true` for the next caller', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveLate!: (value: string) => void
    const client = fakeClient(() => new Promise<string>((resolvePong) => { resolveLate = resolvePong }))
    const runtime = new RedisRuntime(config(100))

    const probe = runtime.probe()
    await vi.advanceTimersByTimeAsync(100)
    await expect(probe).resolves.toBe(false)
    resolveLate('PONG') // arrives after the bound; must be inert

    client.sendCommand.mockImplementationOnce(() => new Promise(() => undefined))
    const next = runtime.probe()
    await vi.advanceTimersByTimeAsync(100)
    await expect(next).resolves.toBe(false)
  })
})
