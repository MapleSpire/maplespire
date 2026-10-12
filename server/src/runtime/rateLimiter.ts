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

import { createHash, randomUUID } from 'node:crypto'
import { RedisRuntime, redisRuntime } from './redis.js'

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export interface RateLimitDecision {
  allowed: boolean
  count: number
  remaining: number
  retryAfterSeconds: number
  justExceeded: boolean
  backend: 'redis' | 'memory'
}

interface MemoryWindow {
  count: number
  resetAt: number
}

function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex')
}

function safeNamespace(namespace: string): string {
  const value = namespace.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').slice(0, 80)
  if (!value) throw new Error('Rate-limit namespace must not be empty')
  return value
}

/** Redis-backed across replicas; bounded in-memory only when REDIS_URL is not configured. */
export class DistributedRateLimiter {
  private readonly memory = new Map<string, MemoryWindow>()

  constructor(
    private readonly runtime: RedisRuntime = redisRuntime,
    private readonly now: () => number = Date.now,
    private readonly maxMemoryKeys = 100_000,
  ) {}

  async consume(input: {
    namespace: string
    identity: string
    limit: number
    windowMs: number
  }): Promise<RateLimitDecision> {
    const namespace = safeNamespace(input.namespace)
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 1_000_000)
    const windowMs = Math.min(Math.max(Math.floor(input.windowMs), 1_000), 31 * 24 * 60 * 60 * 1_000)
    const digest = hashIdentity(input.identity)
    const key = `${this.runtime.prefix}:rate:v1:${namespace}:${digest}`

    if (this.runtime.configured) {
      const reply = await this.runtime.send<Array<number | string>>([
        'EVAL', FIXED_WINDOW_SCRIPT, '1', key, String(windowMs),
      ])
      const count = Number(reply[0])
      const ttlMs = Math.max(1, Number(reply[1]))
      return this.decision(count, limit, ttlMs, 'redis')
    }

    const now = this.now()
    let window = this.memory.get(key)
    if (!window || window.resetAt <= now) {
      if (this.memory.size >= this.maxMemoryKeys) this.prune(now)
      if (this.memory.size >= this.maxMemoryKeys) {
        return this.decision(limit + 1, limit, windowMs, 'memory')
      }
      window = { count: 0, resetAt: now + windowMs }
      this.memory.set(key, window)
    }
    window.count += 1
    return this.decision(window.count, limit, Math.max(1, window.resetAt - now), 'memory')
  }

  resetMemoryForTests(): void {
    this.memory.clear()
  }

  private decision(count: number, limit: number, ttlMs: number, backend: 'redis' | 'memory'): RateLimitDecision {
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: count <= limit ? 0 : Math.max(1, Math.ceil(ttlMs / 1_000)),
      justExceeded: count === limit + 1,
      backend,
    }
  }

  private prune(now: number): void {
    for (const [key, window] of this.memory) {
      if (window.resetAt <= now) this.memory.delete(key)
    }
  }
}

interface MemoryLease {
  token: string
  expiresAt: number
}

export class DistributedLeaseManager {
  private readonly memory = new Map<string, MemoryLease>()

  constructor(
    private readonly runtime: RedisRuntime = redisRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(namespace: string, identity: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const token = randomUUID()
    const key = `${this.runtime.prefix}:lease:v1:${safeNamespace(namespace)}:${hashIdentity(identity)}`
    const boundedTtl = Math.min(Math.max(Math.floor(ttlMs), 1_000), 24 * 60 * 60 * 1_000)

    if (this.runtime.configured) {
      const acquired = await this.runtime.send<string | null>([
        'SET', key, token, 'PX', String(boundedTtl), 'NX',
      ])
      if (acquired !== 'OK') return null
      let released = false
      return async () => {
        if (released) return
        released = true
        await this.runtime.send<number>(['EVAL', RELEASE_LEASE_SCRIPT, '1', key, token]).catch(() => undefined)
      }
    }

    const now = this.now()
    const existing = this.memory.get(key)
    if (existing && existing.expiresAt > now) return null
    this.memory.set(key, { token, expiresAt: now + boundedTtl })
    let released = false
    return async () => {
      if (released) return
      released = true
      if (this.memory.get(key)?.token === token) this.memory.delete(key)
    }
  }
}

export function createDistributedRateLimiter(options?: { now?: () => number; maxMemoryKeys?: number }): DistributedRateLimiter {
  return new DistributedRateLimiter(redisRuntime, options?.now, options?.maxMemoryKeys)
}

export function createDistributedLeaseManager(options?: { now?: () => number }): DistributedLeaseManager {
  return new DistributedLeaseManager(redisRuntime, options?.now)
}
