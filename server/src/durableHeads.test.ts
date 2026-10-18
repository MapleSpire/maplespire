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

import { getHeads } from '@automerge/automerge'
import {
  NetworkAdapter,
  Repo,
  type Chunk,
  type PeerId,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { describe, expect, it, vi } from 'vitest'
import {
  acknowledgeDurableHeads,
  parseDurableHeadRequests,
} from './durableHeads.js'

/**
 * One connected peer that never answers — the state of a server whose only
 * peer holding the document (the browser that presented it) has not sent its
 * content yet. The server's request goes unanswered, so the sync source stays
 * `pending` for a document absent from storage and `repo.find` never settles
 * on its own. (An adapter with NO peer is not this state: sync reports
 * `unavailable` at once and `find` rejects quickly — measured while writing
 * this test, the first draft passed against the hanging code that way.)
 */
class SilentPeerAdapter extends NetworkAdapter {
  isReady(): boolean { return true }
  whenReady(): Promise<void> { return Promise.resolve() }
  connect(peerId: PeerId): void {
    this.peerId = peerId
    setTimeout(() => this.emit('peer-candidate', { peerId: 'silent-browser' as PeerId, peerMetadata: {} }), 0)
  }
  send(): void {}
  disconnect(): void {}
}

async function repoWithSilentPeer(storage: StorageAdapterInterface): Promise<Repo> {
  const repo = new Repo({ storage, network: [new SilentPeerAdapter()] })
  await vi.waitFor(() => expect(repo.peers).toContain('silent-browser'))
  return repo
}

class MemoryStorageAdapter implements StorageAdapterInterface {
  readonly entries = new Map<string, Uint8Array>()
  async load(key: StorageKey): Promise<Uint8Array | undefined> { return this.entries.get(key.join('/')) }
  async save(key: StorageKey, data: Uint8Array): Promise<void> { this.entries.set(key.join('/'), data) }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(key.join('/')) }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const start = prefix.join('/')
    return [...this.entries].filter(([key]) => key.startsWith(start))
      .map(([key, data]) => ({ key: key.split('/'), data }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    const start = prefix.join('/')
    for (const key of [...this.entries.keys()]) if (key.startsWith(start)) this.entries.delete(key)
  }
}

/** A PostgreSQL adapter whose document-chunk reads never come back. The
 *  storage-id read still answers: the Repo awaits it before connecting. */
class HangingStorageAdapter extends MemoryStorageAdapter {
  override loadRange(): Promise<Chunk[]> { return new Promise(() => {}) }
}

/** Document-chunk reads answer, after a real I/O delay (300 ms by default:
 *  long enough to hold a request open). */
class SlowDocumentStorageAdapter extends MemoryStorageAdapter {
  constructor(private readonly delayMs = 300) { super() }
  override async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return super.loadRange(prefix)
  }
}

const WORKSPACE ={ landscapeId: 'landscape-1', versionId: 'version-1' }
const permitAll = (ids: string[]) => ({
  query: vi.fn().mockResolvedValue({ rows: ids.map((document_id) => ({ document_id })) }),
})

describe('durable Automerge head acknowledgements', () => {
  it('validates a bounded, unique set of document heads', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    const heads = getHeads(handle.doc()!)
    expect(parseDurableHeadRequests([{ documentId: handle.documentId, heads }])).toEqual([
      { documentId: handle.documentId, heads },
    ])
    expect(parseDurableHeadRequests([])).toBeNull()
    expect(parseDurableHeadRequests([
      { documentId: handle.documentId, heads },
      { documentId: handle.documentId, heads },
    ])).toBeNull()
    expect(parseDurableHeadRequests([{ documentId: handle.documentId, heads: ['not-a-hash'] }])).toBeNull()
  })

  it('flushes only workspace-owned documents whose requested heads reached the server', async () => {
    const repo = new Repo({ network: [] })
    const owned = repo.create({ value: 1 })
    const crossWorkspace = repo.create({ value: 2 })
    const notArrived = repo.create({ value: 3 })
    const missingHead = '0'.repeat(64)
    const flush = vi.spyOn(repo, 'flush').mockResolvedValue()
    const query = vi.fn().mockResolvedValue({ rows: [
      { document_id: owned.documentId },
      { document_id: notArrived.documentId },
    ] })

    const result = await acknowledgeDurableHeads(
      repo,
      { query },
      { landscapeId: 'landscape-1', versionId: 'version-1' },
      [
        { documentId: owned.documentId, heads: getHeads(owned.doc()!) },
        { documentId: crossWorkspace.documentId, heads: getHeads(crossWorkspace.doc()!) },
        { documentId: notArrived.documentId, heads: [missingHead] },
      ],
    )

    expect(query).toHaveBeenCalledWith(expect.stringContaining('automerge_document_workspace'), [
      'landscape-1',
      'version-1',
      [owned.documentId, crossWorkspace.documentId, notArrived.documentId],
    ])
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([owned.documentId])
    expect(result).toEqual([
      { documentId: owned.documentId, durable: true },
      { documentId: crossWorkspace.documentId, durable: false },
      { documentId: notArrived.documentId, durable: false },
    ])
  })

  it('does not acknowledge before the PostgreSQL-backed Repo flush resolves', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    let release!: () => void
    let markFlushStarted!: () => void
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve })
    vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
      markFlushStarted()
    }))
    const pending = acknowledgeDurableHeads(
      repo,
      { query: vi.fn().mockResolvedValue({ rows: [{ document_id: handle.documentId }] }) },
      { landscapeId: 'landscape-1', versionId: 'version-1' },
      [{ documentId: handle.documentId, heads: getHeads(handle.doc()!) }],
    )
    let settled = false
    void pending.then(() => { settled = true })
    await flushStarted
    expect(settled).toBe(false)
    release()
    await expect(pending).resolves.toEqual([{ documentId: handle.documentId, durable: true }])
  })

  // Measured 2026-10-18, bare AUTH-off server, fresh database: the route gate
  // claims a minted id when the client first presents it, before its content
  // arrives. The first acknowledgement then waited the full 10 s find ceiling
  // on that document (sent +1.0 s, answered +11.1 s); the retry took ~20 ms.
  // A document with no data cannot carry the requested heads, so the answer
  // is `false` at once — never the network's give-up time.
  describe('a document whose content has not reached this server', () => {
    const someHead = 'a'.repeat(64)

    it('answers durable:false without waiting for a peer (not resident, not stored)', async () => {
      const storage = new MemoryStorageAdapter()
      const repo = await repoWithSilentPeer(storage)
      const arrived = repo.create({ value: 1 })
      // A real id with no content anywhere: mint it in another repo.
      const absent = new Repo({ network: [] }).create({ value: 2 })
      const flush = vi.spyOn(repo, 'flush')

      const started = performance.now()
      const result = await acknowledgeDurableHeads(
        repo,
        permitAll([arrived.documentId, absent.documentId]),
        WORKSPACE,
        [
          { documentId: arrived.documentId, heads: getHeads(arrived.doc()!) },
          { documentId: absent.documentId, heads: getHeads(absent.doc()!) },
        ],
      )
      const elapsed = performance.now() - started

      expect(result).toEqual([
        { documentId: arrived.documentId, durable: true },
        { documentId: absent.documentId, durable: false },
      ])
      // Literal bound, not derived from any constant in the code under test.
      expect(elapsed).toBeLessThan(500)
      expect(flush).toHaveBeenCalledWith([arrived.documentId])
    }, 15_000)

    it('answers durable:false at once for a resident query still loading from a peer', async () => {
      const repo = await repoWithSilentPeer(new MemoryStorageAdapter())
      const absent = new Repo({ network: [] }).create({ value: 2 })
      // What a peer presenting the id leaves behind: a query, no data.
      const progress = repo.findWithProgress(absent.url)
      await vi.waitFor(() => expect(progress.peek().sources.storage).toBe('unavailable'))
      expect(progress.peek().state).toBe('loading')

      const started = performance.now()
      const result = await acknowledgeDurableHeads(repo, permitAll([absent.documentId]), WORKSPACE, [
        { documentId: absent.documentId, heads: [someHead] },
      ])
      expect(performance.now() - started).toBeLessThan(500)
      expect(result).toEqual([{ documentId: absent.documentId, durable: false }])
    }, 15_000)

    it('still acknowledges a document that is only in storage (not resident)', async () => {
      const storage = new MemoryStorageAdapter()
      const writer = new Repo({ storage, network: [] })
      const stored = writer.create({ value: 3 })
      const heads = getHeads(stored.doc()!)
      await writer.flush([stored.documentId])

      const repo = await repoWithSilentPeer(storage)
      expect(repo.handles[stored.documentId]).toBeUndefined()
      const flush = vi.spyOn(repo, 'flush')
      const result = await acknowledgeDurableHeads(repo, permitAll([stored.documentId]), WORKSPACE, [
        { documentId: stored.documentId, heads },
      ])
      expect(result).toEqual([{ documentId: stored.documentId, durable: true }])
      expect(flush).toHaveBeenCalledWith([stored.documentId])
    }, 15_000)

    it('does not acknowledge stored content missing the requested heads', async () => {
      const storage = new MemoryStorageAdapter()
      const writer = new Repo({ storage, network: [] })
      const stored = writer.create({ value: 3 })
      await writer.flush([stored.documentId])

      const repo = await repoWithSilentPeer(storage)
      const started = performance.now()
      const result = await acknowledgeDurableHeads(repo, permitAll([stored.documentId]), WORKSPACE, [
        { documentId: stored.documentId, heads: [someHead] },
      ])
      expect(performance.now() - started).toBeLessThan(500)
      expect(result).toEqual([{ documentId: stored.documentId, durable: false }])
    }, 15_000)

    // Measured 2026-10-18: `Repo.flush` skips an id whose query
    // is gone, so a document evicted while the request waits on ANOTHER one
    // was acknowledged without a byte reaching storage.
    it('never acknowledges a document evicted before the flush could save it', async () => {
      const storage = new SlowDocumentStorageAdapter()
      const repo = new Repo({ storage, network: [new SilentPeerAdapter()], saveDebounceRate: 60_000 })
      await vi.waitFor(() => expect(repo.peers).toContain('silent-browser'))
      // Stored by someone else, not resident here: its load holds the request.
      const seed = new MemoryStorageAdapter()
      const writer = new Repo({ storage: seed, network: [] })
      const slow = writer.create({ value: 'slow' })
      const slowHeads = getHeads(slow.doc()!)
      await writer.flush([slow.documentId])
      for (const [key, data] of seed.entries) if (key.startsWith(slow.documentId)) storage.entries.set(key, data)
      // Resident here; its armed save (60 s debounce) will not land in time.
      const evicted = repo.create({ value: 1 })
      const evictedHeads = getHeads(evicted.doc()!)
      expect([...storage.entries.keys()].some((k) => k.startsWith(evicted.documentId))).toBe(false)

      const pending = acknowledgeDurableHeads(repo, permitAll([evicted.documentId, slow.documentId]), WORKSPACE, [
        { documentId: evicted.documentId, heads: evictedHeads },
        { documentId: slow.documentId, heads: slowHeads },
      ])
      await new Promise((resolve) => setTimeout(resolve, 20))
      await repo.removeFromCache(evicted.documentId)
      const result = await pending

      const cold = new Repo({ storage, network: [] })
      const reread = await cold.find(evicted.url).catch(() => undefined)
      const savedHeads = reread?.doc() ? getHeads(reread.doc()!) : []
      // The invariant, whatever the answer: durable:true only if storage has it.
      const evictedAnswer = result.find(({ documentId }) => documentId === evicted.documentId)!
      expect(evictedAnswer.durable ? savedHeads : evictedHeads).toEqual(evictedHeads)
      expect(savedHeads).not.toEqual(evictedHeads)
      expect(evictedAnswer.durable).toBe(false)
      expect(result.find(({ documentId }) => documentId === slow.documentId)?.durable).toBe(true)
    }, 15_000)

    // Comparing ids instead of handle identity would pass the test
    // above, because there the evicted id simply vanished. A browser
    // re-presenting the id brings a NEW, empty, loading query back; `flush`
    // skips it, and only handle identity tells the two apart.
    it('never acknowledges an evicted document whose query was re-created before the flush', async () => {
      const storage = new SlowDocumentStorageAdapter()
      const repo = new Repo({ storage, network: [new SilentPeerAdapter()], saveDebounceRate: 60_000 })
      await vi.waitFor(() => expect(repo.peers).toContain('silent-browser'))
      const seed = new MemoryStorageAdapter()
      const writer = new Repo({ storage: seed, network: [] })
      const slow = writer.create({ value: 'slow' })
      const slowHeads = getHeads(slow.doc()!)
      await writer.flush([slow.documentId])
      for (const [key, data] of seed.entries) if (key.startsWith(slow.documentId)) storage.entries.set(key, data)
      const evicted = repo.create({ value: 1 })
      const evictedHeads = getHeads(evicted.doc()!)

      const pending = acknowledgeDurableHeads(repo, permitAll([evicted.documentId, slow.documentId]), WORKSPACE, [
        { documentId: evicted.documentId, heads: evictedHeads },
        { documentId: slow.documentId, heads: slowHeads },
      ])
      await new Promise((resolve) => setTimeout(resolve, 20))
      await repo.removeFromCache(evicted.documentId)
      repo.findWithProgress(evicted.url)
      const result = await pending

      expect(result.find(({ documentId }) => documentId === evicted.documentId)?.durable).toBe(false)
      expect(result.find(({ documentId }) => documentId === slow.documentId)?.durable).toBe(true)
    }, 15_000)

    // The storage wait itself, not merely its ceiling.
    it('waits for a slow storage read and acknowledges what it loads', async () => {
      const storage = new SlowDocumentStorageAdapter(150)
      const seed = new MemoryStorageAdapter()
      const writer = new Repo({ storage: seed, network: [] })
      const stored = writer.create({ value: 3 })
      const heads = getHeads(stored.doc()!)
      await writer.flush([stored.documentId])
      for (const [key, data] of seed.entries) storage.entries.set(key, data)

      const repo = await repoWithSilentPeer(storage)
      const result = await acknowledgeDurableHeads(repo, permitAll([stored.documentId]), WORKSPACE, [
        { documentId: stored.documentId, heads },
      ])
      expect(result).toEqual([{ documentId: stored.documentId, durable: true }])
    }, 15_000)

    // A deleted handle can sit in a ready query (`DocHandle.delete()` called
    // on its own leaves it cached); only the state check refuses it.
    it('does not acknowledge a deleted handle', async () => {
      const repo = new Repo({ network: [] })
      const handle = repo.create({ value: 1 })
      const heads = getHeads(handle.doc()!)
      handle.delete()
      const result = await acknowledgeDurableHeads(repo, permitAll([handle.documentId]), WORKSPACE, [
        { documentId: handle.documentId, heads },
      ])
      expect(result).toEqual([{ documentId: handle.documentId, durable: false }])
    })

    it('bounds a storage read that never returns', async () => {
      const repo = await repoWithSilentPeer(new HangingStorageAdapter())
      const absent = new Repo({ network: [] }).create({ value: 2 })
      const flush = vi.spyOn(repo, 'flush')
      const started = performance.now()
      const result = await acknowledgeDurableHeads(repo, permitAll([absent.documentId]), WORKSPACE, [
        { documentId: absent.documentId, heads: getHeads(absent.doc()!) },
      ])
      // Literal: well under the 10 s network ceiling this replaced.
      expect(performance.now() - started).toBeLessThan(3_000)
      expect(result).toEqual([{ documentId: absent.documentId, durable: false }])
      expect(flush).not.toHaveBeenCalled()
    }, 15_000)
  })
})
