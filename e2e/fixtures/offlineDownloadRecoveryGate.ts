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

import {
  __resetModelReadCacheBootstrap,
  discardWorkspaceOfflineDownload,
  downloadWorkspaceForOffline,
} from '../../src/lib/modelQuery/modelReadCacheBootstrap'
import { MODEL_READ_CACHE_DB, type ModelCacheWorkspaceMeta } from '../../src/lib/modelQuery/idbSchema'
import { accountDatabaseName } from '../../src/lib/auth/accountNamespace'
import {
  disposeModelReadCacheWorker,
  getModelReadCacheWorker,
} from '../../src/lib/modelQuery/workerClient'

const workspace = { landscapeId: 'offline-gate', versionId: 'current' }
const workspaceKey = 'offline-gate/current'

export interface OfflineDownloadRecoveryGateApi {
  reset(): Promise<void>
  seedPreviousGeneration(): Promise<ModelCacheWorkspaceMeta>
  pauseAfterFirstPage(): Promise<ModelCacheWorkspaceMeta>
  interruptAfterFirstPage(): Promise<ModelCacheWorkspaceMeta>
  resumeAfterRestart(): Promise<{ meta: ModelCacheWorkspaceMeta; objectBatches: string[][] }>
  blockOnQuotaAfterFirstPage(): Promise<ModelCacheWorkspaceMeta>
  discard(): Promise<ModelCacheWorkspaceMeta | null>
  status(): Promise<ModelCacheWorkspaceMeta | null>
}

declare global {
  interface Window {
    __offlineDownloadRecoveryGate?: OfflineDownloadRecoveryGateApi
  }
}

function deleteCacheDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    // The name the Worker actually opened (per user under AUTH=on): deleting
    // the bare legacy name would report a reset that reset nothing.
    const request = indexedDB.deleteDatabase(accountDatabaseName(MODEL_READ_CACHE_DB))
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Unable to delete model cache'))
    request.onblocked = () => reject(new Error('Model cache deletion was blocked'))
  })
}

async function status(): Promise<ModelCacheWorkspaceMeta | null> {
  return (await getModelReadCacheWorker().storageStatus({ workspaceKey }))[0] ?? null
}

async function reset(): Promise<void> {
  disposeModelReadCacheWorker()
  __resetModelReadCacheBootstrap()
  await deleteCacheDatabase()
}

async function seedPreviousGeneration(): Promise<ModelCacheWorkspaceMeta> {
  const worker = getModelReadCacheWorker()
  await worker.activateGeneration({
    workspaceKey, generation: 41, serverGeneration: 41, coverage: 'working-set',
  })
  await worker.upsertObjects({
    workspaceKey,
    generation: 41,
    items: [{
      id: 'previous-object', kind: 'object', name: 'Previous object', type: 'app',
      parentId: null, childCount: 0,
      // A REAL `C4Object`, not three of its fields: the payload column is typed
      // `C4Object | Group` and this fixture stands in for a cached object that
      // the recovery path reads back.
      payload: {
        id: 'previous-object',
        name: 'Previous object',
        type: 'app',
        position: { x: 0, y: 0 },
        size: { width: 160, height: 90 },
        tagAssignments: {},
        tagOrder: [],
        scope: 'internal',
        status: 'live',
        properties: {},
      },
    }],
  })
  return worker.activateGeneration({
    workspaceKey, generation: 41, serverGeneration: 41, coverage: 'full', pinned: true,
  })
}

async function pauseAfterFirstPage(): Promise<ModelCacheWorkspaceMeta> {
  const controller = new AbortController()
  try {
    await downloadWorkspaceForOffline({
      workspace,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === 'objects' && progress.processed === 2) controller.abort()
      },
    })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  }
  const meta = await status()
  if (!meta) throw new Error('Paused download metadata is missing')
  return meta
}

async function interruptAfterFirstPage(): Promise<ModelCacheWorkspaceMeta> {
  let releaseCheckpoint: (() => void) | null = null
  const checkpointReached = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
  void downloadWorkspaceForOffline({
    workspace,
    onProgress: (progress) => {
      if (progress.phase === 'objects' && progress.processed === 2) releaseCheckpoint?.()
    },
    // Keep the task alive after its first durable transaction. Reloading the
    // document terminates this execution without writing a graceful pause state.
    quotaGuard: async (progress) => {
      if (progress.phase === 'objects' && progress.processed === 2) {
        await new Promise<void>(() => undefined)
      }
    },
  }).catch(() => undefined)
  await checkpointReached
  const meta = await status()
  if (!meta) throw new Error('Interrupted download metadata is missing')
  return meta
}

async function resumeAfterRestart(): Promise<{ meta: ModelCacheWorkspaceMeta; objectBatches: string[][] }> {
  const worker = getModelReadCacheWorker()
  const original = worker.upsertObjects.bind(worker)
  const objectBatches: string[][] = []
  worker.upsertObjects = async (input, signal) => {
    objectBatches.push(input.items.map((item) => item.id))
    return original(input, signal)
  }
  await downloadWorkspaceForOffline({ workspace })
  const meta = await status()
  if (!meta) throw new Error('Completed download metadata is missing')
  return { meta, objectBatches }
}

async function blockOnQuotaAfterFirstPage(): Promise<ModelCacheWorkspaceMeta> {
  let checked = false
  try {
    await downloadWorkspaceForOffline({
      workspace,
      quotaGuard: async (progress) => {
        if (!checked && progress.phase === 'objects' && progress.processed === 2) {
          checked = true
          const error = new Error('Simulated browser quota exhaustion')
          error.name = 'WorkspaceOfflineCapacityError'
          throw error
        }
      },
    })
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'WorkspaceOfflineCapacityError') throw error
  }
  const meta = await status()
  if (!meta) throw new Error('Quota-blocked download metadata is missing')
  return meta
}

async function discard(): Promise<ModelCacheWorkspaceMeta | null> {
  await discardWorkspaceOfflineDownload(workspace)
  return status()
}

window.__offlineDownloadRecoveryGate = {
  reset,
  seedPreviousGeneration,
  pauseAfterFirstPage,
  interruptAfterFirstPage,
  resumeAfterRestart,
  blockOnQuotaAfterFirstPage,
  discard,
  status,
}
document.documentElement.dataset.offlineDownloadRecoveryGateReady = 'true'
