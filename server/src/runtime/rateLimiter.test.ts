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
import { DistributedLeaseManager, DistributedRateLimiter } from './rateLimiter.js'
import {
  RedisRuntime,
  RedisUnavailableError,
  redisRenderCacheRuntimeConfig,
  redisRuntimeConfig,
} from './redis.js'

function memoryRuntime(): RedisRuntime {
  return new RedisRuntime({
    url: null,
    host: null,
    port: 6_379,
    tls: false,
    username: undefined,
    password: undefined,
    required: false,
    keyPrefix: 'test',
    connectWaitMs: 100,
    commandTimeoutMs: 100,
  })
}

describe('DistributedRateLimiter memory compatibility mode', () => {
  it('enforces a fixed window and resets it without an unbounded timer', async () => {
    let now = 1_000
    const limiter = new DistributedRateLimiter(memoryRuntime(), () => now, 10)
    const input = { namespace: 'share', identity: 'secret-token', limit: 2, windowMs: 60_000 }

    expect(await limiter.consume(input)).toMatchObject({ allowed: true, count: 1, backend: 'memory' })
    expect(await limiter.consume(input)).toMatchObject({ allowed: true, count: 2, remaining: 0 })
    expect(await limiter.consume(input)).toMatchObject({ allowed: false, count: 3, justExceeded: true })
    expect(await limiter.consume(input)).toMatchObject({ allowed: false, count: 4, justExceeded: false })

    now += 60_001
    expect(await limiter.consume(input)).toMatchObject({ allowed: true, count: 1 })
  })

  it('fails closed for a new identity if the bounded fallback cannot evict an expired key', async () => {
    const limiter = new DistributedRateLimiter(memoryRuntime(), () => 1_000, 1)
    await limiter.consume({ namespace: 'org', identity: 'a', limit: 5, windowMs: 60_000 })
    expect(await limiter.consume({ namespace: 'org', identity: 'b', limit: 5, windowMs: 60_000 }))
      .toMatchObject({ allowed: false, justExceeded: true })
  })

  it('does not silently fall back per pod when Redis is configured but unavailable', async () => {
    const configured = new RedisRuntime({
      url: 'redis://127.0.0.1:1',
      host: null,
      port: 6_379,
      tls: false,
      username: undefined,
      password: undefined,
      required: false,
      keyPrefix: 'test',
      connectWaitMs: 100,
      commandTimeoutMs: 100,
    })
    const limiter = new DistributedRateLimiter(configured)
    await expect(limiter.consume({ namespace: 'security', identity: 'user', limit: 1, windowMs: 60_000 }))
      .rejects.toBeInstanceOf(RedisUnavailableError)
  })
})

describe('DistributedLeaseManager memory compatibility mode', () => {
  it('allows one owner, compare-releases it, and expires abandoned leases', async () => {
    let now = 1_000
    const leases = new DistributedLeaseManager(memoryRuntime(), () => now)
    const first = await leases.acquire('research', 'user\u0000org', 2_000)
    expect(first).not.toBeNull()
    expect(await leases.acquire('research', 'user\u0000org', 2_000)).toBeNull()
    await first?.()
    expect(await leases.acquire('research', 'user\u0000org', 2_000)).not.toBeNull()

    now += 2_001
    expect(await leases.acquire('research', 'user\u0000org', 2_000)).not.toBeNull()
  })
})

describe('redisRuntimeConfig', () => {
  it('requires an endpoint when Redis is mandatory and sanitizes the key prefix', () => {
    expect(() => redisRuntimeConfig({ REDIS_REQUIRED: 'on' })).toThrow('requires REDIS_URL or REDIS_HOST')
    expect(redisRuntimeConfig({
      REDIS_URL: 'redis://redis:6379',
      REDIS_REQUIRED: 'on',
      REDIS_KEY_PREFIX: 'Tenant / Production!',
      REDIS_COMMAND_TIMEOUT_MS: '750',
    })).toMatchObject({
      url: 'redis://redis:6379',
      required: true,
      keyPrefix: 'tenant_production_',
      commandTimeoutMs: 750,
    })
    expect(redisRuntimeConfig({
      REDIS_HOST: 'managed.internal',
      REDIS_PORT: '10000',
      REDIS_TLS: 'on',
      REDIS_USERNAME: 'runtime',
      REDIS_PASSWORD: 'secret',
    })).toMatchObject({
      url: null,
      host: 'managed.internal',
      port: 10_000,
      tls: true,
      username: 'runtime',
      password: 'secret',
    })
    expect(() => redisRuntimeConfig({
      REDIS_URL: 'redis://redis:6379',
      REDIS_HOST: 'managed.internal',
    })).toThrow('not both')
  })

  it('never reuses the critical endpoint implicitly for the render cache', () => {
    expect(redisRenderCacheRuntimeConfig({
      REDIS_URL: 'redis://critical:6379',
      REDIS_KEY_PREFIX: 'Tenant / Production!',
    })).toMatchObject({
      url: null,
      host: null,
      required: false,
      keyPrefix: 'tenant_production_:cache',
    })

    expect(redisRenderCacheRuntimeConfig({
      REDIS_RENDER_CACHE_HOST: 'cache.internal',
      REDIS_RENDER_CACHE_PORT: '6380',
      REDIS_RENDER_CACHE_TLS: 'on',
      REDIS_RENDER_CACHE_USERNAME: 'render-cache',
      REDIS_RENDER_CACHE_PASSWORD: 'cache-secret',
      REDIS_RENDER_CACHE_KEY_PREFIX: 'Render / Cache!',
    })).toMatchObject({
      url: null,
      host: 'cache.internal',
      port: 6_380,
      tls: true,
      username: 'render-cache',
      password: 'cache-secret',
      keyPrefix: 'render_cache_',
    })

    expect(() => redisRenderCacheRuntimeConfig({
      REDIS_RENDER_CACHE_URL: 'redis://cache:6379',
      REDIS_RENDER_CACHE_HOST: 'cache.internal',
    })).toThrow('not both')
  })

  it('never exposes managed credentials in its operational snapshot', () => {
    const runtime = new RedisRuntime(redisRuntimeConfig({
      REDIS_HOST: 'managed.internal',
      REDIS_USERNAME: 'runtime',
      REDIS_PASSWORD: 'top-secret',
    }))
    expect(JSON.stringify(runtime.snapshot())).not.toContain('managed.internal')
    expect(JSON.stringify(runtime.snapshot())).not.toContain('top-secret')
  })
})
