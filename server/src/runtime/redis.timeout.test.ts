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
import { RedisRuntime, RedisUnavailableError } from './redis.js'
import { RedisUnavailableError as leafRedisUnavailableError } from './redisErrors.js'
import { dependencyOutageResponse } from './dependencyOutageResponse.js'

vi.mock('redis', () => ({ createClient: vi.fn() }))

describe('RedisRuntime reply timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts a reply already queued for I/O when an overdue timer wakes first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveReply!: (value: string) => void
    const client = {
      isOpen: true,
      isReady: true,
      on: vi.fn(),
      sendCommand: vi.fn(() => new Promise<string>((resolve) => { resolveReply = resolve })),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(),
    }
    vi.mocked(createClient).mockReturnValue(client as never)
    const runtime = new RedisRuntime({
      url: 'redis://critical-redis:6379',
      host: null,
      port: 6_379,
      tls: false,
      username: undefined,
      password: undefined,
      required: true,
      keyPrefix: 'timer-order-test',
      connectWaitMs: 100,
      commandTimeoutMs: 25,
    })

    const result = runtime.send<string>(['GET', 'lease'])
    vi.advanceTimersByTime(25)
    resolveReply('already-readable')

    await expect(result).resolves.toBe('already-readable')
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('fails a silent in-flight command, recycles the socket and reconnects', async () => {
    const client = {
      isOpen: true,
      isReady: true,
      on: vi.fn(),
      sendCommand: vi.fn(() => new Promise(() => undefined)),
      connect: vi.fn(async () => {
        client.isOpen = true
        client.isReady = true
      }),
      close: vi.fn(async () => {
        client.isOpen = false
        client.isReady = false
      }),
      destroy: vi.fn(() => {
        client.isOpen = false
        client.isReady = false
      }),
    }
    vi.mocked(createClient).mockReturnValue(client as never)
    const runtime = new RedisRuntime({
      url: 'redis://critical-redis:6379',
      host: null,
      port: 6_379,
      tls: false,
      username: undefined,
      password: undefined,
      required: true,
      keyPrefix: 'timeout-test',
      connectWaitMs: 100,
      commandTimeoutMs: 25,
    })

    await expect(runtime.send(['GET', 'lease'])).rejects.toBeInstanceOf(RedisUnavailableError)
    expect(client.destroy).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce())

    // THE ERROR THIS RUNTIME THROWS IS THE ONE THE HTTP MAPPING MATCHES ON.
    // `RedisUnavailableError` lives in a leaf module so an error door can name
    // it without building the two runtimes at the bottom of `redis.ts`. If
    // `redis.ts` ever re-declared the class locally instead of re-exporting
    // the leaf, its own throwers and `instanceof` checks would stay consistent
    // and every other suite green — while `dependencyOutageResponse` silently
    // stopped recognising it and a Redis outage answered 500.
    const thrown = await runtime.send(['GET', 'lease']).then(() => null, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(leafRedisUnavailableError)
    expect(dependencyOutageResponse(thrown)).toMatchObject({
      status: 503,
      body: { code: 'rate_limit_unavailable' },
    })

    client.sendCommand.mockResolvedValueOnce('recovered' as never)
    await expect(runtime.send<string>(['GET', 'lease'])).resolves.toBe('recovered')
    await runtime.stop()
  })
})
