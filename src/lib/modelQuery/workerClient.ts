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

import type {
  ModelCachePage,
  ModelCacheConnectionPage,
  ModelCacheDependencyPage,
  ModelCacheViewerLevel,
  ModelCacheSearchItem,
  ModelReadCacheApi,
  ModelReadCacheCommandInput,
  ModelReadCacheResponse,
} from './modelReadCacheProtocol'
import type {
  CachedDiagramRenderRecord,
  ModelCacheEvictionResult,
  CachedModelEntityRecord,
  ModelCacheWorkspaceMeta,
} from './idbSchema'
import { recordModelQueryOperation } from '../observability/modelQueryDiagnostics'
import { accountWorkerName } from '../auth/accountNamespace'

interface PendingRequest {
  operation: string
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

export class ModelReadCacheWorkerError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ModelReadCacheWorkerError'
    this.code = code
  }
}

export class ModelReadCacheWorkerClient implements ModelReadCacheApi {
  private worker: Worker
  private sequence = 0
  private pending = new Map<number, PendingRequest>()

  constructor(worker?: Worker) {
    if (worker) {
      this.worker = worker
    } else if (typeof Worker !== 'undefined') {
      // The Worker opens the account's read cache; it has no localStorage, so
      // the namespace travels as its name (accountNamespace.ts).
      this.worker = new Worker(new URL('../../workers/modelReadCache.worker.ts', import.meta.url), {
        type: 'module',
        name: accountWorkerName(),
      })
    } else {
      throw new Error('Model read cache Worker is unavailable in this environment')
    }
    this.worker.onmessage = (event: MessageEvent<ModelReadCacheResponse>) => this.handleResponse(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Model read cache Worker failed')
      for (const pending of this.pending.values()) {
        pending.cleanup()
        pending.reject(error)
      }
      this.pending.clear()
    }
  }

  private handleResponse(response: ModelReadCacheResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.cleanup()
    const resultRows = response.ok && Array.isArray(response.result) ? response.result.length : 0
    recordModelQueryOperation({
      operation: `worker.${pending.operation}`,
      durationMs: response.durationMs,
      rowsRead: response.rowsRead,
      resultRows,
      failed: !response.ok,
    })
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new ModelReadCacheWorkerError(response.error, response.errorCode))
  }

  private send<Result>(command: ModelReadCacheCommandInput, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const id = ++this.sequence
    return new Promise<Result>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        this.worker.postMessage({ id: ++this.sequence, op: 'cancel', targetId: id })
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, {
        operation: command.op,
        resolve: (value) => resolve(value as Result),
        reject,
        cleanup,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.worker.postMessage({ ...command, id })
    })
  }

  activateGeneration(input: Parameters<ModelReadCacheApi['activateGeneration']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'activateGeneration', ...input }, signal)
  }

  beginOfflineDownload(input: Parameters<ModelReadCacheApi['beginOfflineDownload']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'beginOfflineDownload', ...input }, signal)
  }

  upsertObjects(input: Parameters<ModelReadCacheApi['upsertObjects']>[0], signal?: AbortSignal): Promise<{ count: number }> {
    return this.send({ op: 'upsertObjects', ...input }, signal)
  }

  upsertConnections(input: Parameters<ModelReadCacheApi['upsertConnections']>[0], signal?: AbortSignal): Promise<{ count: number }> {
    return this.send({ op: 'upsertConnections', ...input }, signal)
  }

  upsertDiagramManifests(input: Parameters<ModelReadCacheApi['upsertDiagramManifests']>[0], signal?: AbortSignal): Promise<{ count: number }> {
    return this.send({ op: 'upsertDiagramManifests', ...input }, signal)
  }

  queryChildren(input: Parameters<ModelReadCacheApi['queryChildren']>[0], signal?: AbortSignal): Promise<ModelCachePage<CachedModelEntityRecord>> {
    return this.send({ op: 'queryChildren', ...input }, signal)
  }

  searchObjects(input: Parameters<ModelReadCacheApi['searchObjects']>[0], signal?: AbortSignal): Promise<ModelCachePage<ModelCacheSearchItem>> {
    return this.send({ op: 'searchObjects', ...input }, signal)
  }

  queryConnections(input: Parameters<ModelReadCacheApi['queryConnections']>[0], signal?: AbortSignal): Promise<ModelCacheConnectionPage> {
    return this.send({ op: 'queryConnections', ...input }, signal)
  }

  queryDependencyPeers(input: Parameters<ModelReadCacheApi['queryDependencyPeers']>[0], signal?: AbortSignal): Promise<ModelCacheDependencyPage> {
    return this.send({ op: 'queryDependencyPeers', ...input }, signal)
  }

  queryViewerLevel(input: Parameters<ModelReadCacheApi['queryViewerLevel']>[0], signal?: AbortSignal): Promise<ModelCacheViewerLevel> {
    return this.send({ op: 'queryViewerLevel', ...input }, signal)
  }

  deleteEntities(input: Parameters<ModelReadCacheApi['deleteEntities']>[0], signal?: AbortSignal): Promise<{ objectsDeleted: number; connectionsDeleted: number; diagramsDeleted: number }> {
    return this.send({ op: 'deleteEntities', ...input }, signal)
  }

  commitServerGeneration(input: Parameters<ModelReadCacheApi['commitServerGeneration']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'commitServerGeneration', ...input }, signal)
  }

  putDiagramRender(input: Parameters<ModelReadCacheApi['putDiagramRender']>[0], signal?: AbortSignal): Promise<{ stored: true }> {
    return this.send({ op: 'putDiagramRender', ...input }, signal)
  }

  getDiagramRender(input: Parameters<ModelReadCacheApi['getDiagramRender']>[0], signal?: AbortSignal): Promise<CachedDiagramRenderRecord | null> {
    return this.send({ op: 'getDiagramRender', ...input }, signal)
  }

  buildDiagramRender(input: Parameters<ModelReadCacheApi['buildDiagramRender']>[0], signal?: AbortSignal): Promise<CachedDiagramRenderRecord | null> {
    return this.send({ op: 'buildDiagramRender', ...input }, signal)
  }

  setOfflineDownloadState(input: Parameters<ModelReadCacheApi['setOfflineDownloadState']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'setOfflineDownloadState', ...input }, signal)
  }

  completeOfflineDownload(input: Parameters<ModelReadCacheApi['completeOfflineDownload']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'completeOfflineDownload', ...input }, signal)
  }

  discardOfflineDownload(input: Parameters<ModelReadCacheApi['discardOfflineDownload']>[0], signal?: AbortSignal): Promise<{ discarded: boolean }> {
    return this.send({ op: 'discardOfflineDownload', ...input }, signal)
  }

  setWorkspacePolicy(input: Parameters<ModelReadCacheApi['setWorkspacePolicy']>[0], signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta> {
    return this.send({ op: 'setWorkspacePolicy', ...input }, signal)
  }

  evictDerived(input: Parameters<ModelReadCacheApi['evictDerived']>[0], signal?: AbortSignal): Promise<ModelCacheEvictionResult> {
    return this.send({ op: 'evictDerived', ...input }, signal)
  }

  storageStatus(input: Parameters<ModelReadCacheApi['storageStatus']>[0] = {}, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta[]> {
    return this.send({ op: 'storageStatus', ...input }, signal)
  }

  clearWorkspace(input: Parameters<ModelReadCacheApi['clearWorkspace']>[0], signal?: AbortSignal): Promise<{ cleared: true }> {
    return this.send({ op: 'clearWorkspace', ...input }, signal)
  }

  dispose(): void {
    this.worker.terminate()
    const error = new Error('Model read cache Worker was disposed')
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }
}

let singleton: ModelReadCacheWorkerClient | null = null

export function getModelReadCacheWorker(): ModelReadCacheWorkerClient {
  singleton ??= new ModelReadCacheWorkerClient()
  return singleton
}

export function disposeModelReadCacheWorker(): void {
  singleton?.dispose()
  singleton = null
}
