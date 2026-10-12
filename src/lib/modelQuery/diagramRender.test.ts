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

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  fetchDiagramRender,
  readCachedDiagramRender,
  __setDiagramRenderCacheForTest,
  __setDiagramRenderFetchForTest,
  __setDiagramRenderCacheSchedulerForTest,
} from './diagramRender'
import type { CachedDiagramRenderRecord } from './idbSchema'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

let cached: CachedDiagramRenderRecord | null = null
let deferredCacheWrites: Array<() => void | Promise<void>> = []
const cache = {
  putDiagramRender: vi.fn(async ({ record }: { record: CachedDiagramRenderRecord }) => {
    cached = record
    return { stored: true as const }
  }),
  getDiagramRender: vi.fn(async () => cached),
  buildDiagramRender: vi.fn(async () => null as CachedDiagramRenderRecord | null),
}

afterEach(() => {
  cached = null
  deferredCacheWrites = []
  cache.putDiagramRender.mockClear()
  cache.getDiagramRender.mockClear()
  cache.buildDiagramRender.mockReset()
  cache.buildDiagramRender.mockResolvedValue(null)
  __setDiagramRenderFetchForTest(null)
  __setDiagramRenderCacheForTest(null)
  __setDiagramRenderCacheSchedulerForTest(null)
})

describe('fetchDiagramRender', () => {
  it('returns the rendered diagram (objects + connections incl. lower + groups)', async () => {
    const payload = {
      projectionGeneration: 17,
      objects: [{ id: 'A' }, { id: 'B' }],
      connections: [
        { id: 'direct', fromId: 'A', toId: 'B' },
        { id: 'lower:A→B', fromId: 'A', toId: 'B', kind: 'lower', type: 'dashed', label: '' },
      ],
      groups: [],
    }
    let calledUrl = ''
    __setDiagramRenderCacheForTest(cache)
    __setDiagramRenderCacheSchedulerForTest((write) => { deferredCacheWrites.push(write) })
    __setDiagramRenderFetchForTest(async (url) => { calledUrl = url; return jsonResponse(payload) })
    const render = await fetchDiagramRender('dg 1')
    expect(calledUrl).toContain('/api/model/diagram-render?id=dg%201') // encoded
    expect(calledUrl).toContain('cacheScope=diagram')
    expect(render?.objects.map((o) => o.id)).toEqual(['A', 'B'])
    expect(render?.connections.some((c) => c.kind === 'lower')).toBe(true)
    expect(cache.putDiagramRender).not.toHaveBeenCalled()
    await deferredCacheWrites.shift()?.()
    expect(cache.putDiagramRender).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({ diagramId: 'dg 1', generation: 17 }),
    }))
    await expect(readCachedDiagramRender('dg 1')).resolves.toEqual(payload)
  })

  it('separates the render snapshot from the current workspace invalidation cursor', async () => {
    const payload = { projectionGeneration: 17, objects: [], connections: [], groups: [] }
    __setDiagramRenderFetchForTest(async () => jsonResponse(payload, 200, {
      'x-read-model-workspace-generation': '19',
      'x-read-model-render-generation': '7',
    }))

    await expect(fetchDiagramRender('generation-aware')).resolves.toMatchObject({
      projectionGeneration: 17,
      workspaceGeneration: 19,
      renderGeneration: 7,
    })
  })

  it('does not hold visual readiness behind a pending IndexedDB write', async () => {
    const payload = { projectionGeneration: 18, objects: [], connections: [], groups: [] }
    let finishWrite!: () => void
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve })
    cache.putDiagramRender.mockImplementationOnce(async () => {
      await pendingWrite
      return { stored: true as const }
    })
    __setDiagramRenderCacheForTest(cache)
    __setDiagramRenderCacheSchedulerForTest((write) => { deferredCacheWrites.push(write) })
    __setDiagramRenderFetchForTest(async () => jsonResponse(payload))

    await expect(fetchDiagramRender('fast-paint')).resolves.toEqual(payload)
    expect(cache.putDiagramRender).not.toHaveBeenCalled()

    const write = deferredCacheWrites.shift()
    const writing = write?.()
    expect(cache.putDiagramRender).toHaveBeenCalledOnce()
    finishWrite()
    await writing
  })

  it('runs the boot render fetch under a wall-clock AbortSignal (M5)', async () => {
    // A server that accepts the request and never answers must not hold the
    // boot pipeline hostage — same ceiling family as the root-url fetch. The
    // resulting TimeoutError lands in loadDiagramRenderForProjection's catch
    // (offline badge + cached render), i.e. it stays transient. Presence is
    // pinned here; the 10s duration is not fake-timer reachable because
    // AbortSignal.timeout runs on internal timers.
    const payload = { projectionGeneration: 1, objects: [], connections: [], groups: [] }
    let capturedInit: { signal?: AbortSignal } | undefined
    __setDiagramRenderFetchForTest(async (_url, init) => {
      capturedInit = init
      return jsonResponse(payload)
    })

    await expect(fetchDiagramRender('ceilinged')).resolves.toEqual(payload)
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps 404 to undefined (unknown diagram / read model off)', async () => {
    __setDiagramRenderFetchForTest(async () => jsonResponse({ error: 'not found' }, 404))
    expect(await fetchDiagramRender('nope')).toBeUndefined()
  })

  it('throws on a non-404 error status', async () => {
    __setDiagramRenderFetchForTest(async () => jsonResponse({ error: 'boom' }, 500))
    await expect(fetchDiagramRender('x')).rejects.toThrow(/HTTP 500/)
  })

  it('rejects an unversioned response instead of caching ambiguous data', async () => {
    __setDiagramRenderCacheForTest(cache)
    __setDiagramRenderFetchForTest(async () => jsonResponse({ objects: [], connections: [], groups: [] }))
    await expect(fetchDiagramRender('x')).rejects.toThrow(/invalid generation-bound payload/)
    expect(cache.putDiagramRender).not.toHaveBeenCalled()
  })

  it('rejects a cached payload whose embedded generation does not match its key', async () => {
    __setDiagramRenderCacheForTest(cache)
    cached = {
      workspaceKey: 'default/current', diagramId: 'x', generation: 8,
      payload: { projectionGeneration: 7, objects: [], connections: [], groups: [] },
      accountedBytes: 1, cachedAt: Date.now(),
    }
    await expect(readCachedDiagramRender('x')).resolves.toBeUndefined()
  })

  it('builds an unvisited diagram from the complete Worker cache before accepting a stale render', async () => {
    __setDiagramRenderCacheForTest(cache)
    const payload = {
      projectionGeneration: 12,
      objects: [{ id: 'api', name: 'API', type: 'app' }],
      connections: [],
      groups: [],
    }
    cache.buildDiagramRender.mockResolvedValue({
      workspaceKey: 'default/current',
      diagramId: 'unvisited',
      generation: 12,
      payload,
      accountedBytes: 42,
      cachedAt: Date.now(),
    })
    await expect(readCachedDiagramRender('unvisited')).resolves.toEqual(payload)
    expect(cache.buildDiagramRender).toHaveBeenCalledWith(expect.objectContaining({ diagramId: 'unvisited' }))
  })
})
