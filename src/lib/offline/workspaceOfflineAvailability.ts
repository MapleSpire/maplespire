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

import { workspaceApiFetch } from '../api/http'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import type { ModelCacheWorkspaceMeta } from '../modelQuery/idbSchema'
import {
  downloadWorkspaceForOffline,
  discardWorkspaceOfflineDownload,
  forgetModelReadCacheGeneration,
  type OfflineCacheProgress,
} from '../modelQuery/modelReadCacheBootstrap'
import { getModelReadCacheWorker } from '../modelQuery/workerClient'
import { withWorkspaceParams } from '../modelQuery/workspaceParams'
import { enforceDerivedCacheBudget, scheduleDerivedCacheMaintenance } from './cacheRetention'
import {
  computeDerivedCacheBudget,
  readOriginStorageDiagnostics,
  requestPersistentStorage,
  type OriginStorageDiagnostics,
} from './storageBudget'

import { API_BASE } from '../api/base'

export interface WorkspaceOfflineEstimate {
  objectCount: number
  groupCount: number
  connectionCount: number
  rawPayloadBytes: number
  searchCharacters: number
  estimatedBytes: number
}

export interface WorkspaceOfflineCapacity {
  fits: boolean
  estimatedBytes: number
  currentWorkspaceBytes: number
  desiredDerivedBytes: number
  budgetBytes: number
  additionalBytes: number
}

function generationBytes(meta: ModelCacheWorkspaceMeta | undefined): number {
  if (!meta) return 0
  const targetGeneration = meta.offlineDownload?.generation ?? meta.activeGeneration
  const stats = meta.generationStats[String(targetGeneration)]
  return Object.values(stats?.accountedBytes ?? {}).reduce((sum, bytes) => sum + Math.max(0, bytes), 0)
}

function allGenerationBytes(metas: ModelCacheWorkspaceMeta[]): number {
  return metas.reduce((total, meta) => total + Object.values(meta.generationStats).reduce(
    (workspaceTotal, stats) => workspaceTotal
      + Object.values(stats.accountedBytes).reduce((sum, bytes) => sum + Math.max(0, bytes), 0),
    0,
  ), 0)
}

export function assessWorkspaceOfflineCapacity(
  estimate: WorkspaceOfflineEstimate,
  metas: ModelCacheWorkspaceMeta[],
  storage: Pick<OriginStorageDiagnostics, 'usageBytes' | 'quotaBytes'>,
  workspaceKey: string,
): WorkspaceOfflineCapacity {
  const currentWorkspaceBytes = generationBytes(metas.find((meta) => meta.workspaceKey === workspaceKey))
  const currentDerivedBytes = allGenerationBytes(metas)
  const additionalBytes = Math.max(0, estimate.estimatedBytes - currentWorkspaceBytes)
  const desiredDerivedBytes = currentDerivedBytes + additionalBytes
  const budget = computeDerivedCacheBudget({
    usageBytes: storage.usageBytes,
    quotaBytes: storage.quotaBytes,
    currentDerivedBytes: desiredDerivedBytes,
  })
  return {
    fits: desiredDerivedBytes <= budget.budgetBytes,
    estimatedBytes: estimate.estimatedBytes,
    currentWorkspaceBytes,
    desiredDerivedBytes,
    budgetBytes: budget.budgetBytes,
    additionalBytes,
  }
}

export class WorkspaceOfflineCapacityError extends Error {
  readonly capacity: WorkspaceOfflineCapacity
  constructor(capacity: WorkspaceOfflineCapacity) {
    super('Insufficient browser storage for a complete offline workspace')
    this.name = 'WorkspaceOfflineCapacityError'
    this.capacity = capacity
  }
}

export async function fetchWorkspaceOfflineEstimate(signal?: AbortSignal): Promise<WorkspaceOfflineEstimate> {
  const response = await workspaceApiFetch(
    `${API_BASE}/api/model/cache/estimate?${withWorkspaceParams('')}`,
    { signal },
  )
  if (!response.ok) throw new Error(`offline cache estimate → HTTP ${response.status}`)
  return response.json() as Promise<WorkspaceOfflineEstimate>
}

export async function readWorkspaceOfflineStatus(): Promise<ModelCacheWorkspaceMeta | null> {
  const key = workspaceRefKey(currentWorkspaceRef())
  return (await getModelReadCacheWorker().storageStatus({ workspaceKey: key }))[0] ?? null
}

export async function makeWorkspaceAvailableOffline(options: {
  signal?: AbortSignal
  onProgress?: (progress: OfflineCacheProgress) => void
} = {}): Promise<{ estimate: WorkspaceOfflineEstimate; persisted: boolean }> {
  const workspaceKey = workspaceRefKey(currentWorkspaceRef())
  options.onProgress?.({ phase: 'preparing', processed: 0 })
  // Persistence requests are browser-gated and must remain inside this explicit
  // click-driven workflow. A denial does not prevent a bounded offline copy, but
  // the UI reports that the browser may evict it under pressure.
  const persisted = await requestPersistentStorage()
  const estimate = await fetchWorkspaceOfflineEstimate(options.signal)
  await enforceDerivedCacheBudget({ protectWorkspaceKey: workspaceKey })
  const [metas, storage] = await Promise.all([
    getModelReadCacheWorker().storageStatus(),
    readOriginStorageDiagnostics(),
  ])
  const capacity = assessWorkspaceOfflineCapacity(estimate, metas, storage, workspaceKey)
  if (!capacity.fits) throw new WorkspaceOfflineCapacityError(capacity)
  let committedPages = 0
  await downloadWorkspaceForOffline({
    ...options,
    quotaGuard: async () => {
      committedPages += 1
      // Storage estimates are origin-wide and comparatively expensive. Recheck
      // every ten durable pages; a real IndexedDB quota error is still surfaced
      // immediately by the Worker and preserves the preceding checkpoint.
      if (committedPages % 10 !== 0) return
      const [currentMetas, currentStorage] = await Promise.all([
        getModelReadCacheWorker().storageStatus(),
        readOriginStorageDiagnostics(),
      ])
      const currentCapacity = assessWorkspaceOfflineCapacity(
        estimate,
        currentMetas,
        currentStorage,
        workspaceKey,
      )
      if (!currentCapacity.fits) throw new WorkspaceOfflineCapacityError(currentCapacity)
    },
  })
  scheduleDerivedCacheMaintenance()
  return { estimate, persisted }
}

/** Remove only the incomplete target generation/checkpoint. The last promoted
 * active generation, Automerge documents and mutation outboxes are preserved. */
export async function abandonWorkspaceOfflineDownload(): Promise<boolean> {
  return discardWorkspaceOfflineDownload()
}

export async function removeWorkspaceOfflineCopy(): Promise<void> {
  const workspaceKey = workspaceRefKey(currentWorkspaceRef())
  const worker = getModelReadCacheWorker()
  await worker.setWorkspacePolicy({ workspaceKey, pinned: false })
  await worker.clearWorkspace({ workspaceKey })
  forgetModelReadCacheGeneration(workspaceKey)
}
