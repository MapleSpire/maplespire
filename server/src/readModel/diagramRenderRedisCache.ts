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

import { createHash } from 'node:crypto'
import { RedisRuntime, redisRenderCacheRuntime } from '../runtime/redis.js'
import type {
  DiagramRenderCacheKey,
  DiagramRenderSharedCache,
  SerializedDiagramRender,
} from './diagramRenderCache.js'

export interface RedisDiagramRenderCacheConfig {
  ttlSeconds: number
  maxEntryBytes: number
}

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback
}

export function redisDiagramRenderCacheConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RedisDiagramRenderCacheConfig {
  return {
    ttlSeconds: boundedInteger(env.REDIS_RENDER_CACHE_TTL_SECONDS, 300, 86_400),
    maxEntryBytes: boundedInteger(env.REDIS_RENDER_CACHE_MAX_ENTRY_BYTES, 4 * 1024 * 1024, 64 * 1024 * 1024),
  }
}

function redisKey(prefix: string, key: DiagramRenderCacheKey): string {
  const digest = createHash('sha256').update(JSON.stringify([
    key.landscapeId,
    key.versionId,
    key.diagramId,
    key.projectionGeneration,
    key.variant ?? 'full',
    key.baselineEpoch ?? '',
  ])).digest('hex')
  return `${prefix}:render:v2:${digest}`
}

/** Cross-pod L2. Keys include the authoritative projection generation, so a
 * stale value can consume memory until TTL but can never answer a newer read. */
export class RedisDiagramRenderCache implements DiagramRenderSharedCache {
  constructor(
    private readonly runtime: RedisRuntime = redisRenderCacheRuntime,
    private readonly config: RedisDiagramRenderCacheConfig = redisDiagramRenderCacheConfig(),
  ) {}

  async get(key: DiagramRenderCacheKey): Promise<SerializedDiagramRender | undefined> {
    if (this.config.ttlSeconds === 0 || this.config.maxEntryBytes === 0) return undefined
    const encoded = await this.runtime.send<string | null>(['GET', redisKey(this.runtime.prefix, key)])
    if (encoded === null) return undefined
    if (Buffer.byteLength(encoded, 'utf8') > this.config.maxEntryBytes) return undefined
    try {
      const value = JSON.parse(encoded) as SerializedDiagramRender
      return typeof value.body === 'string' && Number.isFinite(value.projectionGeneration) ? value : undefined
    } catch {
      return undefined
    }
  }

  async set(key: DiagramRenderCacheKey, value: SerializedDiagramRender): Promise<void> {
    if (this.config.ttlSeconds === 0 || this.config.maxEntryBytes === 0) return
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded, 'utf8') > this.config.maxEntryBytes) return
    await this.runtime.send<string>([
      'SET', redisKey(this.runtime.prefix, key), encoded, 'EX', String(this.config.ttlSeconds),
    ])
  }
}
