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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  clearWorkspace: vi.fn(),
  activateGeneration: vi.fn(),
  beginOfflineDownload: vi.fn(),
  upsertObjects: vi.fn(),
  upsertConnections: vi.fn(),
  upsertDiagramManifests: vi.fn(),
  completeOfflineDownload: vi.fn(),
  setOfflineDownloadState: vi.fn(),
  discardOfflineDownload: vi.fn(),
  setWorkspacePolicy: vi.fn(),
  storageStatus: vi.fn(),
}))

vi.mock('../api/http', () => ({ apiFetch: mocks.apiFetch, workspaceApiFetch: mocks.apiFetch }))
vi.mock('./workerClient', () => ({
  ModelReadCacheWorkerError: class extends Error {
    code?: string
  },
  getModelReadCacheWorker: () => ({
    clearWorkspace: mocks.clearWorkspace,
    activateGeneration: mocks.activateGeneration,
    beginOfflineDownload: mocks.beginOfflineDownload,
    upsertObjects: mocks.upsertObjects,
    upsertConnections: mocks.upsertConnections,
    upsertDiagramManifests: mocks.upsertDiagramManifests,
    completeOfflineDownload: mocks.completeOfflineDownload,
    setOfflineDownloadState: mocks.setOfflineDownloadState,
    discardOfflineDownload: mocks.discardOfflineDownload,
    setWorkspacePolicy: mocks.setWorkspacePolicy,
    storageStatus: mocks.storageStatus,
  }),
}))

import { __resetModelReadCacheBootstrap, ensureModelReadCacheReady, isModelReadCacheReady } from './modelReadCacheBootstrap'

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json' },
})

describe('streaming model read-cache bootstrap', () => {
  beforeEach(() => {
    __resetModelReadCacheBootstrap()
    setActiveWorkspaceRef({ landscapeId: 'large', versionId: 'current-id' })
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.storageStatus.mockResolvedValue([])
    mocks.clearWorkspace.mockResolvedValue({ cleared: true })
    mocks.activateGeneration.mockResolvedValue({})
    mocks.beginOfflineDownload.mockImplementation(async (input) => ({
      offlineDownload: {
        generation: input.generation,
        serverGeneration: input.serverGeneration,
        status: 'running',
        phase: 'objects',
        nextCursor: null,
        objectCount: 0,
        connectionCount: 0,
        diagramCount: 0,
        pinned: input.pinned,
        ownerId: input.ownerId,
        leaseExpiresAt: Date.now() + 30_000,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    }))
    mocks.upsertObjects.mockResolvedValue({ count: 1 })
    mocks.upsertConnections.mockResolvedValue({ count: 1 })
    mocks.upsertDiagramManifests.mockResolvedValue({ count: 1 })
    mocks.completeOfflineDownload.mockResolvedValue({})
    mocks.setOfflineDownloadState.mockResolvedValue({})
    mocks.discardOfflineDownload.mockResolvedValue({ discarded: true })
    mocks.setWorkspacePolicy.mockResolvedValue({})
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/model/cache/objects') {
        return json({
          projectionGeneration: 9,
          items: [{
            id: 'api', kind: 'object', name: 'API', type: 'app', parentId: null,
            childCount: 0, searchText: 'API service', payload: { id: 'api', name: 'API', type: 'app' },
          }],
          nextCursor: null,
        })
      }
      if (parsed.pathname === '/api/model/cache/connections') {
        return json({
          projectionGeneration: 9,
          items: [{
            connection: { id: 'c1', fromId: 'api', toId: 'db', type: 'solid' },
            fromName: 'API', toName: 'DB', diagramCount: 1, flowCount: 0,
          }],
          nextCursor: null,
        })
      }
      if (parsed.pathname === '/api/model/cache/diagrams') {
        return json({
          projectionGeneration: 9,
          items: [{ diagramId: 'dg-1', objectIds: ['api'], connectionIds: ['c1'], groupIds: [] }],
          nextCursor: null,
        })
      }
      return new Response('missing', { status: 404 })
    })
  })

  afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

  it('commits page cursors with their rows and promotes only after generation verification', async () => {
    await ensureModelReadCacheReady()
    expect(mocks.upsertObjects).toHaveBeenCalledTimes(1)
    expect(mocks.upsertConnections).toHaveBeenCalledTimes(1)
    expect(mocks.upsertDiagramManifests).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'large/current-id',
      generation: 9,
      items: [{ diagramId: 'dg-1', objectIds: ['api'], connectionIds: ['c1'], groupIds: [] }],
      downloadCheckpoint: expect.objectContaining({
        expectedPhase: 'diagrams', phase: 'verifying', expectedCursor: null,
      }),
    }))
    expect(mocks.clearWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateGeneration).not.toHaveBeenCalled()
    expect(mocks.completeOfflineDownload).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'large/current-id', generation: 9,
    }))
    expect(mocks.apiFetch.mock.calls.filter(([url]) => new URL(url, 'http://localhost').pathname === '/api/model/cache/objects')).toHaveLength(2)
    expect(isModelReadCacheReady('large/current-id')).toBe(true)
  })

  it('reuses a complete matching generation without rewriting entities', async () => {
    mocks.storageStatus.mockResolvedValue([{ activeGeneration: 9, coverage: 'full' }])
    await ensureModelReadCacheReady()
    expect(mocks.clearWorkspace).not.toHaveBeenCalled()
    expect(mocks.upsertObjects).not.toHaveBeenCalled()
    expect(isModelReadCacheReady('large/current-id')).toBe(true)
  })

  it('resumes from a durable connection cursor without replaying object pages', async () => {
    mocks.beginOfflineDownload.mockImplementationOnce(async (input) => ({
      offlineDownload: {
        generation: 9, serverGeneration: 9, status: 'running', phase: 'connections',
        nextCursor: 'connection-cursor', objectCount: 500, connectionCount: 500, diagramCount: 0,
        objectTotal: 500, connectionTotal: 1_000, pinned: true, ownerId: input.ownerId,
        leaseExpiresAt: Date.now() + 30_000, startedAt: 1, updatedAt: 2,
      },
    }))
    await ensureModelReadCacheReady()
    expect(mocks.upsertObjects).not.toHaveBeenCalled()
    const connectionUrl = mocks.apiFetch.mock.calls
      .map(([url]) => new URL(url as string, 'http://localhost'))
      .find((url) => url.pathname === '/api/model/cache/connections')
    expect(connectionUrl?.searchParams.get('after')).toBe('connection-cursor')
    expect(mocks.upsertConnections).toHaveBeenCalledWith(expect.objectContaining({
      downloadCheckpoint: expect.objectContaining({
        expectedPhase: 'connections', expectedCursor: 'connection-cursor', connectionCount: 501,
      }),
    }))
  })

  it('persists a paused state after the last committed page', async () => {
    const controller = new AbortController()
    mocks.upsertObjects.mockImplementationOnce(async (request) => {
      expect(request.downloadCheckpoint).toMatchObject({ phase: 'connections', objectCount: 1 })
      controller.abort()
      return { count: 1 }
    })
    const promise = ensureModelReadCacheReady(controller.signal)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.setOfflineDownloadState).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'large/current-id', status: 'paused',
    }))
  })
})
