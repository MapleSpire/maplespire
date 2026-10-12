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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DiagramRenderCache } from '../readModel/diagramRenderCache.js'
import { RedisDiagramRenderCache } from '../readModel/diagramRenderRedisCache.js'
import { DistributedLeaseManager, DistributedRateLimiter } from './rateLimiter.js'
import { RedisRuntime } from './redis.js'

const url = process.env.TEST_REDIS_URL
const suite = url ? describe : describe.skip

suite('Redis distributed runtime across replicas', () => {
  const prefix = `maplespire-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let first: RedisRuntime
  let second: RedisRuntime

  beforeAll(async () => {
    const config = {
      url: url!,
      host: null,
      port: 6_379,
      tls: false,
      username: undefined,
      password: undefined,
      required: true,
      keyPrefix: prefix,
      connectWaitMs: 2_000,
      commandTimeoutMs: 1_500,
    }
    first = new RedisRuntime(config)
    second = new RedisRuntime(config)
    await Promise.all([first.start(), second.start()])
    expect(first.ready).toBe(true)
    expect(second.ready).toBe(true)
  })

  afterAll(async () => {
    if (first?.ready) {
      const keys = await first.send<string[]>(['KEYS', `${prefix}:*`]).catch(() => [])
      if (keys.length > 0) await first.send<number>(['DEL', ...keys]).catch(() => undefined)
    }
    await Promise.all([first?.stop(), second?.stop()])
  })

  it('shares one quota and one active lease between independent clients', async () => {
    const limiterA = new DistributedRateLimiter(first)
    const limiterB = new DistributedRateLimiter(second)
    const input = { namespace: 'integration', identity: 'same-user', limit: 2, windowMs: 60_000 }
    expect(await limiterA.consume(input)).toMatchObject({ allowed: true, count: 1, backend: 'redis' })
    expect(await limiterB.consume(input)).toMatchObject({ allowed: true, count: 2, backend: 'redis' })
    expect(await limiterA.consume(input)).toMatchObject({ allowed: false, count: 3, justExceeded: true })
    const rateKeys = await first.send<string[]>(['KEYS', `${prefix}:rate:*`])
    expect(rateKeys).toHaveLength(1)
    expect(rateKeys[0]).not.toContain('same-user')

    const leasesA = new DistributedLeaseManager(first)
    const leasesB = new DistributedLeaseManager(second)
    const release = await leasesA.acquire('integration', 'same-user', 10_000)
    expect(release).not.toBeNull()
    expect(await leasesB.acquire('integration', 'same-user', 10_000)).toBeNull()
    await release?.()
    expect(await leasesB.acquire('integration', 'same-user', 10_000)).not.toBeNull()
  })

  it('serves a generation-addressed render written by another replica', async () => {
    const config = { ttlSeconds: 60, maxEntryBytes: 10_000 }
    const cacheA = new DiagramRenderCache(
      { maxEntries: 4, maxBytes: 10_000, maxEntryBytes: 10_000 },
      new RedisDiagramRenderCache(first, config),
    )
    const cacheB = new DiagramRenderCache(
      { maxEntries: 4, maxBytes: 10_000, maxEntryBytes: 10_000 },
      new RedisDiagramRenderCache(second, config),
    )
    const key = { landscapeId: 'l1', versionId: 'v1', diagramId: 'd1', projectionGeneration: 7 }
    const value = { projectionGeneration: 7, body: '{"diagram":"shared"}' }
    expect((await cacheA.getOrLoad(key, async () => value)).status).toBe('miss')

    const databaseLoad = vi.fn(async () => ({ projectionGeneration: 7, body: '{"wrong":true}' }))
    expect(await cacheB.getOrLoad(key, databaseLoad)).toEqual({ status: 'shared-hit', value })
    expect(databaseLoad).not.toHaveBeenCalled()
  })
})
