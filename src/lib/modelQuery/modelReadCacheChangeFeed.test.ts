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

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  storageStatus: vi.fn(),
  upsertObjects: vi.fn(),
  upsertConnections: vi.fn(),
  deleteEntities: vi.fn(),
  commitServerGeneration: vi.fn(),
  downloadWorkspaceForOffline: vi.fn(),
}))

vi.mock('../api/http', () => ({ apiFetch: mocks.apiFetch, workspaceApiFetch: mocks.apiFetch }))
vi.mock('./modelReadCacheBootstrap', () => ({
  downloadWorkspaceForOffline: mocks.downloadWorkspaceForOffline,
}))
vi.mock('./workerClient', () => ({
  getModelReadCacheWorker: () => ({
    storageStatus: mocks.storageStatus,
    upsertObjects: mocks.upsertObjects,
    upsertConnections: mocks.upsertConnections,
    deleteEntities: mocks.deleteEntities,
    commitServerGeneration: mocks.commitServerGeneration,
  }),
}))
vi.mock('./tierFlag', () => ({ isServerReadModelEnabled: () => true }))

import {
  __resetModelReadCacheChangeFeedForTests,
  installModelReadCacheChangeFeed,
  pollCurrentWorkspaceChangeFeed,
} from './modelReadCacheChangeFeed'
import { useModelIndexVersion } from './indexSync'

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const fullMeta = {
  workspaceKey: 'large/v1',
  activeGeneration: 5,
  serverGeneration: 10,
  coverage: 'full',
  pinned: true,
  lastAccessAt: 0,
  objectCount: 100,
  connectionCount: 200,
  accountedBytes: {},
  generationStats: {},
}

describe('incremental model read cache feed', () => {
  beforeEach(() => {
    __resetModelReadCacheChangeFeedForTests()
    useModelIndexVersion.setState({ version: 0 })
    setActiveWorkspaceRef({ landscapeId: 'large', versionId: 'v1' })
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.storageStatus.mockResolvedValue([fullMeta])
    mocks.upsertObjects.mockResolvedValue({ count: 1 })
    mocks.upsertConnections.mockResolvedValue({ count: 1 })
    mocks.deleteEntities.mockResolvedValue({ objectsDeleted: 1, connectionsDeleted: 1 })
    mocks.commitServerGeneration.mockResolvedValue({})
    mocks.downloadWorkspaceForOffline.mockResolvedValue(undefined)
  })

  afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

  it('applies bounded changed rows, refreshes adjacent connections, then commits last', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/model/cache/changes') {
        expect(parsed.searchParams.get('afterGeneration')).toBe('10')
        return json({
          projectionGeneration: 12,
          events: [
            { generation: 11, kind: 'objects', upsertIds: ['o1'], deleteIds: ['o2'] },
            { generation: 12, kind: 'connections', upsertIds: ['c1'], deleteIds: ['c2'] },
          ],
          nextGeneration: 12,
          hasMore: false,
          resetRequired: false,
        })
      }
      if (parsed.pathname === '/api/model/cache/objects/by-ids') {
        return json({ projectionGeneration: 12, items: [{
          id: 'o1', kind: 'object', name: 'Checkout', type: 'app', parentId: null,
          childCount: 0, searchText: 'Checkout', payload: { id: 'o1', name: 'Checkout', type: 'app' },
        }] })
      }
      if (parsed.pathname === '/api/model/cache/connections/by-ids') {
        return json({ projectionGeneration: 12, items: [{
          connection: { id: 'c1', fromId: 'o1', toId: 'db' },
          fromName: 'Checkout', toName: 'DB', diagramCount: 1, flowCount: 0,
        }] })
      }
      if (parsed.pathname === '/api/model/cache/connections/by-endpoints') {
        return json({ projectionGeneration: 12, items: [{
          connection: { id: 'adjacent', fromId: 'o1', toId: 'queue' },
          fromName: 'Checkout', toName: 'Queue', diagramCount: 1, flowCount: 0,
        }], nextCursor: null })
      }
      return new Response('missing', { status: 404 })
    })

    await pollCurrentWorkspaceChangeFeed()

    expect(mocks.upsertObjects).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'large/v1', generation: 5,
      items: [expect.objectContaining({ id: 'o1', name: 'Checkout' })],
    }), undefined)
    expect(mocks.upsertConnections).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'large/v1', generation: 5,
      items: expect.arrayContaining([
        expect.objectContaining({ connection: expect.objectContaining({ id: 'c1' }) }),
        expect.objectContaining({ connection: expect.objectContaining({ id: 'adjacent' }) }),
      ]),
    }), undefined)
    expect(mocks.deleteEntities).toHaveBeenCalledWith({
      workspaceKey: 'large/v1', generation: 5,
      objectIds: ['o2'], connectionIds: ['c2'],
    }, undefined)
    expect(mocks.commitServerGeneration).toHaveBeenCalledWith({
      workspaceKey: 'large/v1', serverGeneration: 12,
    }, undefined)
    expect(mocks.commitServerGeneration.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.deleteEntities.mock.invocationCallOrder[0])
    expect(useModelIndexVersion.getState().version).toBe(1)
  })

  it('rebuilds a complete copy on a retained-history gap instead of guessing', async () => {
    mocks.apiFetch.mockResolvedValue(json({
      projectionGeneration: 40,
      events: [],
      nextGeneration: 10,
      hasMore: false,
      resetRequired: true,
    }))
    await pollCurrentWorkspaceChangeFeed()
    expect(mocks.downloadWorkspaceForOffline).toHaveBeenCalledWith({
      signal: undefined,
      workspace: { landscapeId: 'large', versionId: 'v1' },
    })
    expect(mocks.commitServerGeneration).not.toHaveBeenCalled()
  })

  it('advances past a scoped reset without redownloading the complete workspace', async () => {
    mocks.apiFetch.mockResolvedValue(json({
      projectionGeneration: 11,
      events: [{ generation: 11, kind: 'reset', scope: 'diagrams' }],
      nextGeneration: 11,
      hasMore: false,
      resetRequired: false,
    }))

    await pollCurrentWorkspaceChangeFeed()

    expect(mocks.downloadWorkspaceForOffline).not.toHaveBeenCalled()
    expect(mocks.commitServerGeneration).toHaveBeenCalledWith({
      workspaceKey: 'large/v1', serverGeneration: 11,
    }, undefined)
  })

  it('does not consume the durable feed for a partial working set', async () => {
    mocks.storageStatus.mockResolvedValue([{ ...fullMeta, coverage: 'working-set', pinned: false }])
    await pollCurrentWorkspaceChangeFeed()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('uses SSE as a wake-up and reconnects it when the workspace changes', async () => {
    vi.useFakeTimers()
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      readonly listeners = new Map<string, Array<() => void>>()
      readonly close = vi.fn()
      readonly url: string
      readonly options?: EventSourceInit
      constructor(url: string, options?: EventSourceInit) {
        this.url = url
        this.options = options
        sources.push(this)
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const callback = typeof listener === 'function' ? listener : () => listener.handleEvent(new Event(type))
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), () => callback(new MessageEvent(type, {
          data: JSON.stringify({ generation: 10 }),
        }))])
      }
      emit(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener()
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    mocks.apiFetch.mockImplementation(async () => json({
      projectionGeneration: 10,
      events: [],
      nextGeneration: 10,
      hasMore: false,
      resetRequired: false,
    }))

    const stop = installModelReadCacheChangeFeed()
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sources).toHaveLength(1)
      expect(new URL(sources[0].url, 'http://localhost').searchParams.get('landscapeId')).toBe('large')
      expect(sources[0].options).toEqual({ withCredentials: true })
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1)

      sources[0].emit('invalidate')
      await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2))

      setActiveWorkspaceRef({ landscapeId: 'other', versionId: 'v2' })
      expect(sources[0].close).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(sources).toHaveLength(2))
      expect(new URL(sources[1].url, 'http://localhost').searchParams.get('landscapeId')).toBe('other')
    } finally {
      stop()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('does not reserve an SSE connection for an unpinned working set', async () => {
    vi.useFakeTimers()
    const sources: unknown[] = []
    class FakeEventSource {
      constructor() {
        sources.push(this)
      }
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    mocks.storageStatus.mockResolvedValue([{ ...fullMeta, coverage: 'working-set', pinned: false }])

    const stop = installModelReadCacheChangeFeed()
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sources).toHaveLength(0)
      expect(mocks.apiFetch).not.toHaveBeenCalled()
    } finally {
      stop()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
