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

import { describe, expect, it, vi } from 'vitest'
import {
  DiagramRenderCache,
  diagramRenderCacheConfig,
  type DiagramRenderCacheKey,
  type DiagramRenderSharedCache,
  type SerializedDiagramRender,
} from './diagramRenderCache.js'

const key = (generation = 1, diagramId = 'diagram-1'): DiagramRenderCacheKey => ({
  landscapeId: 'landscape-1',
  versionId: 'version-1',
  diagramId,
  projectionGeneration: generation,
})
const payload = (generation = 1, body = '{"ok":true}'): SerializedDiagramRender => ({
  projectionGeneration: generation,
  body,
})

describe('DiagramRenderCache', () => {
  it('reuses a serialized render for the exact workspace, diagram and generation', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    const load = vi.fn(async () => payload())

    expect((await cache.getOrLoad(key(), load)).status).toBe('miss')
    expect((await cache.getOrLoad(key(), load)).status).toBe('hit')
    expect(load).toHaveBeenCalledOnce()
    expect(cache.snapshot()).toMatchObject({ entries: 1, hits: 1, misses: 1, loads: 1 })
  })

  it('does not mix full and first-paint response contracts at the same generation', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    const fullKey = { ...key(), variant: 'full' as const }
    const paintKey = { ...key(), variant: 'first-paint' as const }
    await cache.getOrLoad(fullKey, async () => payload(1, '{"view":"full"}'))
    const compactLoad = vi.fn(async () => payload(1, '{"view":"first-paint"}'))
    expect((await cache.getOrLoad(paintKey, compactLoad)).status).toBe('miss')
    expect(compactLoad).toHaveBeenCalledOnce()
  })

  it('addresses a dependency render by cacheGeneration while retaining its workspace snapshot generation', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    const raced = { projectionGeneration: 99, cacheGeneration: 8, body: '{"projectionGeneration":99,"renderGeneration":8}' }
    await cache.getOrLoad({ ...key(7), variant: 'first-paint' }, async () => raced)
    const reload = vi.fn(async () => raced)
    expect((await cache.getOrLoad({ ...key(8), variant: 'first-paint' }, reload)).status).toBe('hit')
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reuse generation zero across distinct static baseline epochs', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    await cache.getOrLoad({ ...key(0), variant: 'first-paint', baselineEpoch: 'seed-a' }, async () => payload(1))
    const reseedLoad = vi.fn(async () => payload(1))
    expect((await cache.getOrLoad({ ...key(0), variant: 'first-paint', baselineEpoch: 'seed-b' }, reseedLoad)).status).toBe('miss')
    expect(reseedLoad).toHaveBeenCalledOnce()
  })

  it('single-flights concurrent requests for the same generation', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    let resolve!: (value: SerializedDiagramRender) => void
    const load = vi.fn(() => new Promise<SerializedDiagramRender>((done) => { resolve = done }))

    const first = cache.getOrLoad(key(), load)
    await Promise.resolve()
    const second = cache.getOrLoad(key(), load)
    resolve(payload())

    expect(await first).toEqual({ value: payload(), status: 'miss' })
    expect(await second).toEqual({ value: payload(), status: 'coalesced' })
    expect(load).toHaveBeenCalledOnce()
    expect(cache.snapshot()).toMatchObject({ coalesced: 1, inFlight: 0 })
  })

  it('separates generations and stores a raced render under its actual generation', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 })
    const racedLoad = vi.fn(async () => payload(2, '{"generation":2}'))

    expect((await cache.getOrLoad(key(1), racedLoad)).status).toBe('miss')
    const secondGenerationLoad = vi.fn(async () => payload(2))
    expect((await cache.getOrLoad(key(2), secondGenerationLoad)).status).toBe('hit')
    expect(secondGenerationLoad).not.toHaveBeenCalled()

    const oldGenerationLoad = vi.fn(async () => payload(1))
    expect((await cache.getOrLoad(key(1), oldGenerationLoad)).status).toBe('miss')
    expect(oldGenerationLoad).toHaveBeenCalledOnce()
  })

  it('does not retain rejected or oversized loads', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 8, maxBytes: 100, maxEntryBytes: 10 })
    const failing = vi.fn(async () => { throw new Error('database unavailable') })
    await expect(cache.getOrLoad(key(), failing)).rejects.toThrow('database unavailable')
    await expect(cache.getOrLoad(key(), failing)).rejects.toThrow('database unavailable')
    expect(failing).toHaveBeenCalledTimes(2)

    const oversized = vi.fn(async () => payload(1, '123456')) // 12 estimated heap bytes
    expect((await cache.getOrLoad(key(), oversized)).status).toBe('miss')
    expect((await cache.getOrLoad(key(), oversized)).status).toBe('miss')
    expect(oversized).toHaveBeenCalledTimes(2)
    expect(cache.snapshot()).toMatchObject({ entries: 0, loadErrors: 2, bypassedEntries: 2 })
  })

  it('evicts least-recently-used entries within both entry and heap budgets', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 2, maxBytes: 24, maxEntryBytes: 24 })
    await cache.getOrLoad(key(1, 'a'), async () => payload(1, 'aaaa')) // 8 bytes
    await cache.getOrLoad(key(1, 'b'), async () => payload(1, 'bbbb'))
    await cache.getOrLoad(key(1, 'a'), async () => payload(1, 'unused')) // touch a
    await cache.getOrLoad(key(1, 'c'), async () => payload(1, 'cccccccc')) // 16 bytes; evicts b

    const reloadB = vi.fn(async () => payload(1, 'bbbb'))
    expect((await cache.getOrLoad(key(1, 'b'), reloadB)).status).toBe('miss')
    expect(reloadB).toHaveBeenCalledOnce()
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 24 })
    expect(cache.snapshot().evictions).toBeGreaterThanOrEqual(2)
  })

  it('supports an explicit zero-sized cache while preserving single-flight', async () => {
    const cache = new DiagramRenderCache({ maxEntries: 0, maxBytes: 0, maxEntryBytes: 0 })
    let resolve!: (value: SerializedDiagramRender) => void
    const load = vi.fn(() => new Promise<SerializedDiagramRender>((done) => { resolve = done }))
    const first = cache.getOrLoad(key(), load)
    await Promise.resolve()
    const second = cache.getOrLoad(key(), load)
    resolve(payload())
    expect((await first).status).toBe('miss')
    expect((await second).status).toBe('coalesced')
    expect(cache.snapshot()).toMatchObject({ entries: 0, bypassedEntries: 1 })
  })

  it('uses a shared L2 before PostgreSQL and promotes the result into L1', async () => {
    const shared: DiagramRenderSharedCache = {
      get: vi.fn(async () => payload(1, '{"from":"redis"}')),
      set: vi.fn(async () => undefined),
    }
    const cache = new DiagramRenderCache(
      { maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 },
      shared,
    )
    const load = vi.fn(async () => payload(1, '{"from":"postgres"}'))

    expect(await cache.getOrLoad(key(), load)).toEqual({
      status: 'shared-hit',
      value: payload(1, '{"from":"redis"}'),
    })
    expect((await cache.getOrLoad(key(), load)).status).toBe('hit')
    expect(load).not.toHaveBeenCalled()
    expect(shared.get).toHaveBeenCalledOnce()
    expect(shared.set).not.toHaveBeenCalled()
    expect(cache.snapshot()).toMatchObject({ sharedHits: 1, sharedMisses: 0, loads: 0 })
  })

  it('falls through when the shared cache is unavailable and writes the actual generation', async () => {
    const shared: DiagramRenderSharedCache = {
      get: vi.fn(async () => { throw new Error('redis unavailable') }),
      set: vi.fn(async () => undefined),
    }
    const cache = new DiagramRenderCache(
      { maxEntries: 8, maxBytes: 10_000, maxEntryBytes: 10_000 },
      shared,
    )

    expect((await cache.getOrLoad(key(1), async () => payload(2))).status).toBe('miss')
    expect(shared.set).toHaveBeenCalledWith(key(2), payload(2))
    expect(cache.snapshot()).toMatchObject({ sharedErrors: 1, loads: 1 })
  })
})

describe('diagramRenderCacheConfig', () => {
  it('uses conservative defaults and bounds invalid operator input', () => {
    expect(diagramRenderCacheConfig({})).toEqual({
      maxEntries: 256,
      maxBytes: 128 * 1024 * 1024,
      maxEntryBytes: 16 * 1024 * 1024,
    })
    expect(diagramRenderCacheConfig({
      READ_MODEL_RENDER_CACHE_MAX_ENTRIES: '-1',
      READ_MODEL_RENDER_CACHE_MAX_BYTES: '1024',
      READ_MODEL_RENDER_CACHE_MAX_ENTRY_BYTES: '2048',
    })).toEqual({
      maxEntries: 256,
      maxBytes: 1024,
      maxEntryBytes: 1024,
    })
  })
})
