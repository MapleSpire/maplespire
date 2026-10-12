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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  Repo,
  type AutomergeUrl,
  type Chunk,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import {
  AuthenticatedWSServerAdapter,
  automergeSaveDebounceRate,
  createEmptyRoot,
  startIdleEviction,
} from './automergeServer.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'
import { OVERLAY_WRITE_HEAD_VERSION } from './modelMeta.js'
import { openBootstrapScope } from './bootstrapScope.js'

afterEach(() => vi.useRealTimers())

describe('Automerge durable save cadence', () => {
  it('keeps the upstream default outside failover deployments', () => {
    expect(automergeSaveDebounceRate({})).toBe(100)
  })

  it('accepts immediate durable saves for failover cells', () => {
    expect(automergeSaveDebounceRate({ AM_SAVE_DEBOUNCE_MS: '0' })).toBe(0)
  })

  it('rejects ambiguous or unbounded values', () => {
    expect(() => automergeSaveDebounceRate({ AM_SAVE_DEBOUNCE_MS: '-1' })).toThrow()
    expect(() => automergeSaveDebounceRate({ AM_SAVE_DEBOUNCE_MS: '2.5' })).toThrow()
    expect(() => automergeSaveDebounceRate({ AM_SAVE_DEBOUNCE_MS: '5001' })).toThrow()
  })
})

class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()

  private keyText(key: StorageKey): string {
    return key.join('/')
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.keyText(key))?.data.slice()
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.entries.set(this.keyText(key), { key: [...key], data: data.slice() })
  }

  async remove(key: StorageKey): Promise<void> {
    this.entries.delete(this.keyText(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => keyPrefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) {
      if (keyPrefix.every((part, index) => key[index] === part)) this.entries.delete(text)
    }
  }
}

describe('AuthenticatedWSServerAdapter inbound fairness', () => {
  it('queues the join frame and preserves per-socket order', async () => {
    vi.useFakeTimers()
    const server = new WebSocketServer({ noServer: true })
    const adapter = new AuthenticatedWSServerAdapter(server as never)
    const processInboundFrame = vi.fn()
    ;(adapter as unknown as {
      processInboundFrame(message: Uint8Array, socket: WebSocket): void
    }).processInboundFrame = processInboundFrame
    const socket = { readyState: WebSocket.OPEN } as WebSocket
    const join = new Uint8Array([1])
    const document = new Uint8Array([2])

    adapter.receiveMessage(join, socket)
    adapter.receiveMessage(document, socket)

    expect(processInboundFrame).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(processInboundFrame.mock.calls.map(([message]) => [...message])).toEqual([[1], [2]])
    server.close()
  })
})

describe('createEmptyRoot durable bootstrap', () => {
  it('persists every root-referenced document before exposing the root URL', async () => {
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [] })

    const { rootUrl } = await createEmptyRoot(writer, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })

    // A new server process only has storage. It must still be able to satisfy the
    // client's root → model → registry chain immediately after boot.
    const reader = new Repo({ storage, network: [] })
    const rootHandle = await reader.find(rootUrl as AutomergeUrl)
    const root = rootHandle.doc() as {
      modelUrl: string
      modelMetaUrl?: string
      shardUrls: string[]
    }
    const [model, meta, registry] = await Promise.all([
      reader.find(root.modelUrl as AutomergeUrl),
      reader.find(root.modelMetaUrl! as AutomergeUrl),
      reader.find(root.shardUrls[0] as AutomergeUrl),
    ])

    expect(Object.keys(model.doc() as object)).toEqual(
      expect.arrayContaining(['objects', 'connections', 'groups', 'domains', 'tagSnapshots', 'decisionRecords'])
    )
    // NOT just `arrayContaining([...ShardUrls])`: without the `edits*` write
    // heads every new workspace silently stops accepting writes, so they are
    // asserted explicitly.
    const metaDoc = meta.doc() as Record<string, unknown>
    expect(metaDoc.editsObjectShardUrl).toEqual(expect.stringMatching(/^automerge:/))
    expect(metaDoc.editsConnectionShardUrl).toEqual(expect.stringMatching(/^automerge:/))
    expect(metaDoc.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
    // The head must be LAST in its base list: forkRoot remaps it by POSITION and
    // yields undefined when it is not found there.
    expect((metaDoc.objectShardUrls as string[]).at(-1)).toBe(metaDoc.editsObjectShardUrl)
    expect((metaDoc.connectionShardUrls as string[]).at(-1)).toBe(metaDoc.editsConnectionShardUrl)
    // And the overlay documents must be durable, not merely named.
    await Promise.all([
      reader.find(metaDoc.editsObjectShardUrl as AutomergeUrl),
      reader.find(metaDoc.editsConnectionShardUrl as AutomergeUrl),
    ])
    expect(registry.doc()).toMatchObject({ diagrams: expect.any(Object) })
  })

  it('keeps a workspace root durable when its idle handle leaves the repo cache', async () => {
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 100 })
    const { rootUrl } = await createEmptyRoot(writer, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }))
    const root = await writer.find(rootUrl as AutomergeUrl)
    await root.whenReady()
    root.change((doc) => { (doc as Record<string, unknown>).lastAcceptedChange = 'durable' })

    const residency = new AutomergeResidencyLeases(writer)
    expect(await residency.evict(root.documentId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))

    const reader = new Repo({ storage, network: [] })
    const reloaded = await reader.find(rootUrl as AutomergeUrl)
    await reloaded.whenReady()
    expect(reloaded.doc()).toMatchObject({
      modelUrl: expect.stringMatching(/^automerge:/),
      shardUrls: [expect.stringMatching(/^automerge:/)],
      lastAcceptedChange: 'durable',
    })
  })
})

describe('startIdleEviction', () => {
  it('evicts unleased ready handles while preserving leased projector documents', async () => {
    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const leased = repo.create({ objects: { leased: { id: 'leased' } } })
    const idle = repo.create({ objects: { idle: { id: 'idle' } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    residency.acquire(leased, 'projector', 'workspace/version')
    const timer = startIdleEviction(repo, root.url, residency, 1, 1)

    await vi.advanceTimersByTimeAsync(1) // first sighting starts the grace period
    await vi.advanceTimersByTimeAsync(2)
    expect(repo.handles[idle.documentId]).toBeUndefined()
    expect(repo.handles[leased.documentId]).toBe(leased)
    expect(repo.handles[root.documentId]).toBe(root)

    clearInterval(timer)
    residency.releaseOwner('projector')
    await residency.drain()
    expect(repo.handles[leased.documentId]).toBeUndefined()
  })

  /**
   * The census must report the canonical single-orphan case on the idle-sweep
   * path.
   *
   * `WorkspaceDocIndex.walkFrom` attaches exactly ONE 'change' listener to a
   * registry shard and takes no lease. When the sweep evicts that shard, that
   * one listener is the orphan — and one is the number the census has to be able
   * to see, because two is already a different bug.
   */
  it('reports a single orphaned watcher evicted by the sweep', async () => {
    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const shard = repo.create({ objects: { a: { id: 'a' } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    // Exactly what docScope's walk does: watch, without leasing.
    shard.on('change', () => {})
    const timer = startIdleEviction(repo, root.url, residency, 1, 1)

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(2)
    clearInterval(timer)

    expect(repo.handles[shard.documentId]).toBeUndefined()
    vi.useRealTimers()
    expect((await residency.snapshot()).orphanedListenerEvictions).toBe(1)
  })

  it('stays silent when the sweep evicts a document nobody was watching', async () => {
    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const doc = repo.create({ objects: { a: { id: 'a' } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    const timer = startIdleEviction(repo, root.url, residency, 1, 1)

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(2)
    clearInterval(timer)

    // Silence only means something if an eviction actually happened — without
    // this the test passes for any mutation that stops the sweep evicting.
    expect(repo.handles[doc.documentId]).toBeUndefined()
    vi.useRealTimers()
    expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)
  })

  it('does not force a stop-the-world GC from the periodic eviction loop', async () => {
    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const idle = repo.create({ objects: { idle: { id: 'idle' } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    const runtime = globalThis as typeof globalThis & { gc?: () => void }
    const previousGc = runtime.gc
    const gc = vi.fn()
    runtime.gc = gc
    try {
      const timer = startIdleEviction(repo, root.url, residency, 1, 1)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(2)
      clearInterval(timer)
      await residency.drain()
      expect(repo.handles[idle.documentId]).toBeUndefined()
      expect(gc).not.toHaveBeenCalled()
    } finally {
      if (previousGc) runtime.gc = previousGc
      else delete runtime.gc
    }
  })
})
