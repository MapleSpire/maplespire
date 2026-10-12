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

import type { C4Object, Connection, Group } from '../../types'
import { workspaceApiFetch } from '../api/http'
import { currentWorkspaceRef, workspaceRefKey, type WorkspaceRef } from '../automerge/workspace'
import type {
  CachedConnectionInput,
  CachedDiagramManifestInput,
  CachedModelEntityInput,
  ModelCacheOfflineDownload,
  ModelCacheOfflineDownloadCheckpoint,
  OfflineDownloadStatus,
} from './idbSchema'
import { getModelReadCacheWorker, ModelReadCacheWorkerError } from './workerClient'

import { API_BASE } from '../api/base'
const PAGE_SIZE = 500

interface ObjectCachePage {
  projectionGeneration: number
  items: Array<Omit<CachedModelEntityInput, 'payload'> & { payload: Record<string, unknown> }>
  nextCursor: string | null
  total?: number
}

interface ConnectionCachePage {
  projectionGeneration: number
  items: Array<Omit<CachedConnectionInput, 'connection'> & { connection: Record<string, unknown> }>
  nextCursor: string | null
  total?: number
}

interface DiagramCachePage {
  projectionGeneration: number
  items: CachedDiagramManifestInput[]
  nextCursor: string | null
  total?: number
}

const readyGeneration = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()

export type OfflineCachePhase = 'preparing' | 'objects' | 'connections' | 'diagrams' | 'verifying' | 'complete'

export interface OfflineCacheProgress {
  phase: OfflineCachePhase
  processed: number
  total?: number
}

interface SnapshotOptions {
  signal?: AbortSignal
  pinned: boolean
  onProgress?: (progress: OfflineCacheProgress) => void
  quotaGuard?: (progress: OfflineCacheProgress) => Promise<void>
  workspace?: WorkspaceRef
}

class ProjectionChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionChangedError'
  }
}

class OfflineCacheHttpError extends Error {
  readonly status: number

  constructor(path: string, status: number) {
    super(`${path} → HTTP ${status}`)
    this.name = 'OfflineCacheHttpError'
    this.status = status
  }
}

export class OfflineCacheBusyError extends Error {
  constructor() {
    super('Another tab is already downloading this workspace for offline use')
    this.name = 'OfflineCacheBusyError'
  }
}

export function isModelReadCacheReady(workspaceKey = workspaceRefKey(currentWorkspaceRef())): boolean {
  return readyGeneration.has(workspaceKey)
}

export function modelReadCacheGeneration(workspaceKey = workspaceRefKey(currentWorkspaceRef())): number | null {
  return readyGeneration.get(workspaceKey) ?? null
}

/** Called after an LRU eviction removes a workspace's active derived generation. */
export function forgetModelReadCacheGeneration(workspaceKey: string): void {
  readyGeneration.delete(workspaceKey)
}

async function getPage<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await workspaceApiFetch(`${API_BASE}${path}?${params.toString()}`, { signal })
  if (!response.ok) throw new OfflineCacheHttpError(path, response.status)
  return response.json() as Promise<T>
}

function workspaceParams(landscapeId: string, versionId: string): URLSearchParams {
  return new URLSearchParams({ landscapeId, versionId, limit: String(PAGE_SIZE) })
}

async function firstObjectPage(landscapeId: string, versionId: string, signal?: AbortSignal): Promise<ObjectCachePage> {
  return getPage('/api/model/cache/objects', workspaceParams(landscapeId, versionId), signal)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function offlineDownloadOwnerId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `offline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function progressForJob(job: ModelCacheOfflineDownload): OfflineCacheProgress {
  switch (job.phase) {
    case 'objects': return { phase: 'objects', processed: job.objectCount, total: job.objectTotal }
    case 'connections': return { phase: 'connections', processed: job.connectionCount, total: job.connectionTotal }
    case 'diagrams': return { phase: 'diagrams', processed: job.diagramCount, total: job.diagramTotal }
    case 'verifying': return {
      phase: 'verifying',
      processed: job.objectCount + job.connectionCount + job.diagramCount,
    }
  }
}

function advanceJob(
  job: ModelCacheOfflineDownload,
  checkpoint: ModelCacheOfflineDownloadCheckpoint,
): ModelCacheOfflineDownload {
  return {
    ...job,
    phase: checkpoint.phase,
    nextCursor: checkpoint.nextCursor,
    objectCount: checkpoint.objectCount,
    connectionCount: checkpoint.connectionCount,
    diagramCount: checkpoint.diagramCount,
    ...(checkpoint.objectTotal !== undefined ? { objectTotal: checkpoint.objectTotal } : {}),
    ...(checkpoint.connectionTotal !== undefined ? { connectionTotal: checkpoint.connectionTotal } : {}),
    ...(checkpoint.diagramTotal !== undefined ? { diagramTotal: checkpoint.diagramTotal } : {}),
  }
}

function checkpointFor(
  job: ModelCacheOfflineDownload,
  next: Pick<ModelCacheOfflineDownloadCheckpoint,
    'phase' | 'nextCursor' | 'objectCount' | 'connectionCount' | 'diagramCount'
    | 'objectTotal' | 'connectionTotal' | 'diagramTotal'>,
): ModelCacheOfflineDownloadCheckpoint {
  return {
    ownerId: job.ownerId,
    generation: job.generation,
    expectedPhase: job.phase,
    expectedCursor: job.nextCursor,
    ...next,
  }
}

async function reportCheckpoint(
  options: SnapshotOptions,
  progress: OfflineCacheProgress,
): Promise<void> {
  options.onProgress?.(progress)
  await options.quotaGuard?.(progress)
}

async function buildSnapshot(
  landscapeId: string,
  versionId: string,
  workspaceKey: string,
  first: ObjectCachePage,
  options: SnapshotOptions,
  ownerId: string,
): Promise<void> {
  const { signal, onProgress } = options
  const worker = getModelReadCacheWorker()
  const generation = first.projectionGeneration
  const meta = await worker.beginOfflineDownload({
    workspaceKey,
    generation,
    serverGeneration: generation,
    pinned: options.pinned,
    ownerId,
  })
  let job = meta.offlineDownload
  if (!job) throw new Error('Offline download checkpoint was not created')
  onProgress?.(progressForJob(job))

  for (let pageIndex = 0; job.phase === 'objects' && pageIndex < 100_000; pageIndex += 1) {
    throwIfAborted(signal)
    const cursor = job.nextCursor
    const params = workspaceParams(landscapeId, versionId)
    if (cursor) params.set('after', cursor)
    const page = cursor === null && job.objectCount === 0
      ? first
      : await getPage<ObjectCachePage>('/api/model/cache/objects', params, signal)
    if (page.projectionGeneration !== generation) {
      throw new ProjectionChangedError('projection changed during object cache build')
    }
    const objectCount = job.objectCount + page.items.length
    const checkpoint = checkpointFor(job, {
      phase: page.nextCursor ? 'objects' : 'connections',
      nextCursor: page.nextCursor,
      objectCount,
      connectionCount: job.connectionCount,
      diagramCount: job.diagramCount,
      objectTotal: job.objectTotal ?? page.total ?? first.total,
      connectionTotal: job.connectionTotal,
      diagramTotal: job.diagramTotal,
    })
    await worker.upsertObjects({
      workspaceKey,
      generation,
      items: page.items.map((item) => ({
        ...item,
        payload: item.payload as unknown as C4Object | Group,
      })),
      downloadCheckpoint: checkpoint,
    })
    job = advanceJob(job, checkpoint)
    await reportCheckpoint(options, {
      phase: 'objects', processed: objectCount, total: checkpoint.objectTotal,
    })
  }
  if (job.phase === 'objects') throw new Error('Object cache page limit exceeded')

  for (let pageIndex = 0; job.phase === 'connections' && pageIndex < 100_000; pageIndex += 1) {
    throwIfAborted(signal)
    const params = workspaceParams(landscapeId, versionId)
    if (job.nextCursor) params.set('after', job.nextCursor)
    const page = await getPage<ConnectionCachePage>('/api/model/cache/connections', params, signal)
    if (page.projectionGeneration !== generation) {
      throw new ProjectionChangedError('projection changed during connection cache build')
    }
    const connectionCount = job.connectionCount + page.items.length
    const checkpoint = checkpointFor(job, {
      phase: page.nextCursor ? 'connections' : 'diagrams',
      nextCursor: page.nextCursor,
      objectCount: job.objectCount,
      connectionCount,
      diagramCount: job.diagramCount,
      objectTotal: job.objectTotal,
      connectionTotal: job.connectionTotal ?? page.total,
      diagramTotal: job.diagramTotal,
    })
    await worker.upsertConnections({
      workspaceKey,
      generation,
      items: page.items.map((item) => ({ ...item, connection: item.connection as unknown as Connection })),
      downloadCheckpoint: checkpoint,
    })
    job = advanceJob(job, checkpoint)
    await reportCheckpoint(options, {
      phase: 'connections', processed: connectionCount, total: checkpoint.connectionTotal,
    })
  }
  if (job.phase === 'connections') throw new Error('Connection cache page limit exceeded')

  for (let pageIndex = 0; job.phase === 'diagrams' && pageIndex < 100_000; pageIndex += 1) {
    throwIfAborted(signal)
    const params = workspaceParams(landscapeId, versionId)
    if (job.nextCursor) params.set('after', job.nextCursor)
    const page = await getPage<DiagramCachePage>('/api/model/cache/diagrams', params, signal)
    if (page.projectionGeneration !== generation) {
      throw new ProjectionChangedError('projection changed during diagram cache build')
    }
    const diagramCount = job.diagramCount + page.items.length
    const checkpoint = checkpointFor(job, {
      phase: page.nextCursor ? 'diagrams' : 'verifying',
      nextCursor: page.nextCursor,
      objectCount: job.objectCount,
      connectionCount: job.connectionCount,
      diagramCount,
      objectTotal: job.objectTotal,
      connectionTotal: job.connectionTotal,
      diagramTotal: job.diagramTotal ?? page.total,
    })
    await worker.upsertDiagramManifests({
      workspaceKey,
      generation,
      items: page.items,
      downloadCheckpoint: checkpoint,
    })
    job = advanceJob(job, checkpoint)
    await reportCheckpoint(options, {
      phase: 'diagrams', processed: diagramCount, total: checkpoint.diagramTotal,
    })
  }
  if (job.phase === 'diagrams') throw new Error('Diagram cache page limit exceeded')

  throwIfAborted(signal)
  onProgress?.(progressForJob(job))
  const verification = await firstObjectPage(landscapeId, versionId, signal)
  if (verification.projectionGeneration !== generation) {
    throw new ProjectionChangedError('projection changed during cache verification')
  }
  try {
    await worker.completeOfflineDownload({ workspaceKey, ownerId, generation })
  } catch (error) {
    if (error instanceof ModelReadCacheWorkerError && error.code === 'offline_download_generation_stale') {
      throw new ProjectionChangedError('projection changed before cache promotion')
    }
    throw error
  }
  readyGeneration.set(workspaceKey, generation)
  const completeCount = job.objectCount + job.connectionCount + job.diagramCount
  onProgress?.({ phase: 'complete', processed: completeCount, total: completeCount })
}

function isQuotaFailure(error: unknown): boolean {
  return (error instanceof ModelReadCacheWorkerError && error.code === 'quota_exceeded')
    || (error instanceof Error && (error.name === 'QuotaExceededError'
      || error.name === 'WorkspaceOfflineCapacityError'))
}

function failureState(error: unknown, signal?: AbortSignal): Exclude<OfflineDownloadStatus, 'running'> {
  if (signal?.aborted) return 'paused'
  if (isQuotaFailure(error)) return 'blocked-quota'
  if (error instanceof ProjectionChangedError
    || error instanceof TypeError
    || (error instanceof OfflineCacheHttpError
      && (error.status === 408 || error.status === 429 || error.status >= 500))) return 'interrupted'
  return 'failed'
}

async function withWorkspaceDownloadLock<T>(
  workspaceKey: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return callback()
  return navigator.locks.request(
    `maplespire:offline-download:${workspaceKey}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) throw new OfflineCacheBusyError()
      return callback()
    },
  )
}

/** Stream a complete read snapshot directly into the data Worker. Page rows and
 * cursors commit atomically, so a pause/crash resumes from the last durable page.
 * A previous active generation remains queryable until the final promotion. */
function prepareModelReadCache(options: SnapshotOptions): Promise<void> {
  const { signal, onProgress } = options
  const workspace = options.workspace ?? currentWorkspaceRef()
  const key = workspaceRefKey(workspace)
  const existing = inFlight.get(key)
  if (existing) return existing
  const ownerId = offlineDownloadOwnerId()
  const task = withWorkspaceDownloadLock(key, async () => {
    let activeOwner = false
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal)
        const first = await firstObjectPage(workspace.landscapeId, workspace.versionId, signal)
        const worker = getModelReadCacheWorker()
        const statuses = await worker.storageStatus({ workspaceKey: key })
        const status = statuses[0]
        if (status?.activeGeneration === first.projectionGeneration && status.coverage === 'full') {
          if (status.offlineDownload) await worker.discardOfflineDownload({ workspaceKey: key })
          if (options.pinned && !status.pinned) await worker.setWorkspacePolicy({ workspaceKey: key, pinned: true })
          readyGeneration.set(key, first.projectionGeneration)
          onProgress?.({
            phase: 'complete',
            processed: status.objectCount + status.connectionCount,
            total: status.objectCount + status.connectionCount,
          })
          return
        }
        try {
          activeOwner = true
          await buildSnapshot(
            workspace.landscapeId,
            workspace.versionId,
            key,
            first,
            options,
            ownerId,
          )
          return
        } catch (error) {
          if (!signal?.aborted && error instanceof ProjectionChangedError && attempt === 0) continue
          if (error instanceof ModelReadCacheWorkerError
            && (error.code === 'offline_download_busy'
              || error.code === 'offline_download_stale_checkpoint')) {
            throw new OfflineCacheBusyError()
          }
          throw error
        }
      }
    } catch (error) {
      if (activeOwner) {
        const state = failureState(error, signal)
        try {
          await getModelReadCacheWorker().setOfflineDownloadState({
            workspaceKey: key,
            ownerId,
            status: state,
            errorCode: isQuotaFailure(error) ? 'quota_exceeded' : undefined,
            errorMessage: error instanceof Error ? error.message : undefined,
          })
        } catch {
          // A newer tab/generation may already own the durable job. Never mask
          // the original interruption with a best-effort status write failure.
        }
      }
      throw error
    }
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** Background/recovery entry point. Full offline availability should use the
 * explicit user-action function below so storage persistence and progress are
 * visible rather than silently consuming quota. */
export function ensureModelReadCacheReady(signal?: AbortSignal): Promise<void> {
  return prepareModelReadCache({ signal, pinned: false })
}

export function downloadWorkspaceForOffline(options: {
  signal?: AbortSignal
  onProgress?: (progress: OfflineCacheProgress) => void
  quotaGuard?: (progress: OfflineCacheProgress) => Promise<void>
  workspace?: WorkspaceRef
} = {}): Promise<void> {
  return prepareModelReadCache({ ...options, pinned: true })
}

export async function discardWorkspaceOfflineDownload(workspace = currentWorkspaceRef()): Promise<boolean> {
  const workspaceKey = workspaceRefKey(workspace)
  const result = await getModelReadCacheWorker().discardOfflineDownload({ workspaceKey })
  return result.discarded
}

export function __resetModelReadCacheBootstrap(): void {
  readyGeneration.clear()
  inFlight.clear()
}
