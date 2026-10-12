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
import { describe, expect, it, vi } from 'vitest'
import { ModelReadCacheWorkerClient, ModelReadCacheWorkerError } from './workerClient'
import type { ModelReadCacheResponse } from './modelReadCacheProtocol'

class FakeWorker {
  onmessage: ((event: MessageEvent<ModelReadCacheResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: unknown[] = []
  terminate = vi.fn()

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  respond(response: ModelReadCacheResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<ModelReadCacheResponse>)
  }
}

describe('ModelReadCacheWorkerClient', () => {
  it('correlates responses and records typed results', async () => {
    const worker = new FakeWorker()
    const client = new ModelReadCacheWorkerClient(worker as unknown as Worker)
    const promise = client.storageStatus({ workspaceKey: 'ls::v1' })
    const request = worker.posted[0] as { id: number; op: string }
    expect(request.op).toBe('storageStatus')
    worker.respond({ id: request.id, ok: true, result: [], durationMs: 3, rowsRead: 0 })
    await expect(promise).resolves.toEqual([])
    client.dispose()
  })

  it('cancels a stale request without accepting a later response', async () => {
    const worker = new FakeWorker()
    const client = new ModelReadCacheWorkerClient(worker as unknown as Worker)
    const abort = new AbortController()
    const promise = client.searchObjects({ workspaceKey: 'ls::v1', query: 'checkout', limit: 50 }, abort.signal)
    const request = worker.posted[0] as { id: number }
    abort.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.posted[1]).toMatchObject({ op: 'cancel', targetId: request.id })
    worker.respond({ id: request.id, ok: true, result: { items: [] }, durationMs: 50, rowsRead: 100 })
    client.dispose()
  })

  it('preserves typed Worker error codes such as quota exhaustion', async () => {
    const worker = new FakeWorker()
    const client = new ModelReadCacheWorkerClient(worker as unknown as Worker)
    const promise = client.beginOfflineDownload({
      workspaceKey: 'ls::v1', generation: 4, serverGeneration: 4,
      pinned: true, ownerId: 'tab-1',
    })
    const request = worker.posted[0] as { id: number }
    worker.respond({
      id: request.id,
      ok: false,
      error: 'Quota exceeded',
      errorCode: 'quota_exceeded',
      durationMs: 2,
      rowsRead: 0,
    })
    await expect(promise).rejects.toMatchObject({
      name: 'ModelReadCacheWorkerError', code: 'quota_exceeded',
    } satisfies Partial<ModelReadCacheWorkerError>)
    client.dispose()
  })
})
