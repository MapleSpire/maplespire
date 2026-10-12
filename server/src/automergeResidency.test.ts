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

import { Repo } from '@automerge/automerge-repo'
import type { Chunk, StorageAdapterInterface, StorageKey } from '@automerge/automerge-repo'
import { describe, expect, it, vi } from 'vitest'
import {
  AutomergeResidencyLeases,
  classifyAutomergeDocument,
  collectAutomergeGarbage,
  REPO_BASELINE_CHANGE_LISTENERS,
} from './automergeResidency.js'

/** Storage is what makes an evicted document RELOADABLE, which is the only way
 * to get a handle through `repo.find()` — the path every real eviction candidate
 * arrives on, and a different construction path from `repo.create()`. */
class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()
  private keyText(key: StorageKey): string { return key.join('/') }
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.keyText(key))?.data.slice()
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.entries.set(this.keyText(key), { key: [...key], data: data.slice() })
  }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(this.keyText(key)) }
  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const head = this.keyText(keyPrefix)
    return [...this.entries.values()]
      .filter(({ key }) => this.keyText(key).startsWith(head))
      .map(({ key, data }) => ({ key, data: data.slice() }))
  }
  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const head = this.keyText(keyPrefix)
    for (const [text] of this.entries) if (text.startsWith(head)) this.entries.delete(text)
  }
}

describe('AutomergeResidencyLeases', () => {
  it('keeps overlapping projector leases and evicts after the last owner leaves', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ objects: { a: { id: 'a' } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.acquire(handle, 'projector-a', 'landscape-a/v1')
    residency.acquire(handle, 'projector-b', 'landscape-b/v1')

    residency.releaseOwner('projector-a')
    await residency.drain()
    expect(repo.handles[handle.documentId]).toBe(handle)
    residency.releaseOwner('projector-b')
    await residency.drain()
    expect(repo.handles[handle.documentId]).toBeUndefined()
  })

  it('never evicts the protected process root', async () => {
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    residency.acquire(root, 'default-projector', 'default/current')
    residency.releaseOwner('default-projector')
    await residency.drain()
    expect(repo.handles[root.documentId]).toBe(root)
  })

  it('refreshes an exclusive root lease without evicting the same handle', async () => {
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: 'automerge:model', shardUrls: ['automerge:registry'] })
    const residency = new AutomergeResidencyLeases(repo)
    const remove = vi.spyOn(repo, 'removeFromCache')

    residency.replaceOwner(root, 'static:workspace:root', 'workspace/version', 'root')
    residency.replaceOwner(root, 'static:workspace:root', 'workspace/version', 'root')
    await residency.drain()

    expect(remove).not.toHaveBeenCalled()
    expect(residency.isLeased(root.documentId)).toBe(true)
    expect(repo.handles[root.documentId]).toBe(root)
  })

  it('leases a replacement before evicting the retired exclusive document', async () => {
    const repo = new Repo({ network: [] })
    const first = repo.create({ modelUrl: 'automerge:model-a', shardUrls: ['automerge:registry-a'] })
    const next = repo.create({ modelUrl: 'automerge:model-b', shardUrls: ['automerge:registry-b'] })
    const residency = new AutomergeResidencyLeases(repo)
    residency.replaceOwner(first, 'static:workspace:root', 'workspace/version', 'root')
    const remove = vi.spyOn(repo, 'removeFromCache').mockImplementation(async (documentId) => {
      expect(residency.isLeased(next.documentId)).toBe(true)
      delete repo.handles[documentId]
    })

    residency.replaceOwner(next, 'static:workspace:root', 'workspace/version', 'root')
    await residency.drain()

    expect(remove).toHaveBeenCalledWith(first.documentId)
    expect(residency.isLeased(first.documentId)).toBe(false)
    expect(residency.isLeased(next.documentId)).toBe(true)
  })

  it('notifies strong-reference owners before removing an idle handle', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ layouts: {}, comments: {}, flows: {} })
    const residency = new AutomergeResidencyLeases(repo)
    const retained = new Map([[handle.documentId, handle]])
    residency.onBeforeEvict((documentId) => retained.delete(documentId as typeof handle.documentId))

    await expect(residency.evict(handle.documentId)).resolves.toBe(true)
    expect(retained.size).toBe(0)
    expect(repo.handles[handle.documentId]).toBeUndefined()
  })

  it('survives 1,000 opens and 100 reconnect-style owner rotations without retaining handles', async () => {
    const repo = new Repo({ network: [] })
    const residency = new AutomergeResidencyLeases(repo)
    for (let reconnect = 0; reconnect < 100; reconnect += 1) {
      const owner = `client-${reconnect}`
      for (let open = 0; open < 10; open += 1) {
        const handle = repo.create({ layouts: {}, comments: {}, flows: {}, open })
        residency.acquire(handle, owner, 'perf/v1')
      }
      residency.releaseOwner(owner)
      await residency.drain()
    }
    expect(Object.keys(repo.handles)).toHaveLength(0)
    expect((await residency.snapshot()).evictedDocuments).toBe(1_000)
  }, 20_000)

  it('reports storage-level bytes and workspace/type diagnostics without reading a live document', async () => {
    const repo = new Repo({ network: [] })
    const objectShard = repo.create({ objects: { a: { id: 'a', name: 'A' } } })
    const residency = new AutomergeResidencyLeases(repo, {
      snapshot: (documentIds) => ({
        trackedDocuments: documentIds.length,
        trackedChunkBytes: documentIds.length * 321,
      }),
      forget: () => undefined,
    })
    residency.acquire(objectShard, 'projector', 'landscape/version')
    const liveDocRead = vi.spyOn(objectShard, 'doc').mockImplementation(() => {
      throw new Error('snapshot must not materialize a live Automerge document')
    })
    const snapshot = await residency.snapshot()
    expect(snapshot).toMatchObject({
      handles: 1,
      leasedDocuments: 1,
      byType: { 'object-shard': 1 },
      leasedByWorkspace: { 'landscape/version': 1 },
      durableChunkBytesByWorkspace: { 'landscape/version': 321 },
      durableChunkBytesByType: { 'object-shard': 321 },
      residentDurableBytesTrackedDocuments: 1,
      residentDurableChunkBytes: 321,
    })
    expect(liveDocRead).not.toHaveBeenCalled()
  })

  it('aggregates materialized runtime cost without exposing document or peer identifiers', () => {
    const repo = new Repo({ network: [] })
    const objectShard = repo.create({ objects: { a: { id: 'a', name: 'A' } } })
    repo.create({ layouts: { a: { x: 1, y: 2 } }, comments: {}, flows: {} })
    const residency = new AutomergeResidencyLeases(repo, {
      snapshot: (documentIds) => ({
        trackedDocuments: documentIds.length,
        trackedChunkBytes: documentIds.includes(objectShard.documentId) ? 400 : 50,
      }),
      forget: () => undefined,
    })

    const snapshot = residency.runtimeSnapshot()

    expect(snapshot.handles).toBe(2)
    expect(snapshot.byType['object-shard']).toMatchObject({
      handles: 1,
      durableChunkBytes: 400,
      activePeerDocuments: 0,
    })
    expect(snapshot.byType.diagram).toMatchObject({ handles: 1, durableChunkBytes: 50 })
    expect(snapshot.byType['object-shard'].numOps).toBeGreaterThan(0)
    expect(JSON.stringify(snapshot)).not.toContain(objectShard.documentId)
  })
})

describe('classifyAutomergeDocument', () => {
  it('recognizes core document shapes', () => {
    expect(classifyAutomergeDocument({ modelUrl: '', shardUrls: [] })).toBe('root')
    expect(classifyAutomergeDocument({ objectShardUrls: [], connectionShardUrls: [] })).toBe('model-meta')
    expect(classifyAutomergeDocument({ diagrams: {} })).toBe('registry-shard')
    expect(classifyAutomergeDocument({ layouts: {}, comments: {} })).toBe('diagram')
  })
})

describe('collectAutomergeGarbage', () => {
  it('runs two collections around one event-loop turn when GC is exposed', async () => {
    let collections = 0
    await expect(collectAutomergeGarbage(() => { collections += 1 })).resolves.toBe(true)
    expect(collections).toBe(2)
  })

  it('reports an unavailable collector without pretending to collect', async () => {
    await expect(collectAutomergeGarbage(null)).resolves.toBe(false)
  })

  /**
   * The evict-time listener census.
   *
   * The read-model health signal structurally cannot detect the orphaned-watcher
   * class: `observed_generation` is incremented only from inside the watcher, so
   * orphaning it freezes the counter and the workspace evaluates to `healthy`.
   *
   * This census sits at the one place every orphan must pass through. A ready
   * handle carries a known number of `'change'` listeners; anything beyond that
   * plus what is declared ambient is a component watching a document nobody
   * leased — a listener that is about to stop firing forever.
   */
  describe('evict-time listener census', () => {
    it('the repo uses heads notifications and leaves no baseline change listener on a ready handle', async () => {
      // The census threshold is derived from this number. Measured rather than
      // assumed, so an upstream change fails HERE instead of quietly turning the
      // census into noise — or, far worse, into silence.
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      expect(handle.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS)
      expect(handle.listenerCount('change')).toBe(0)
    })

    it('the baseline is the same for a handle loaded from storage, not just a created one', async () => {
      // The measurement above covers `repo.create()`. Every handle the sweep
      // ever evicts arrived through `repo.find()` instead — a storage load or a
      // peer sync — and the two paths build the handle differently.
      //
      // The census counts DOCUMENTS with at least one unaccounted listener, not
      // listeners, so a baseline one too high would make the common
      // SINGLE-orphan case invisible while two-orphan cases still register.
      const storage = new MemoryStorage()
      const writer = new Repo({ network: [], storage })
      const created = writer.create({ objects: { a: { id: 'a' } } })
      await created.whenReady()
      await writer.flush()

      const reader = new Repo({ network: [], storage })
      const loaded = await reader.find(created.url)
      await loaded.whenReady()

      expect(loaded).not.toBe(created)
      expect(loaded.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS)
      expect(loaded.listenerCount('change')).toBe(0)
    })

    it('forgetAmbientListener drops the marker the failover path leaves behind', async () => {
      // The public method, not `evict()`'s internal delete. `repoFreshness`
      // drops handles without running the census and calls this instead; its own
      // test asserts only that the call HAPPENS, against a fake, so the method's
      // effect is pinned here.
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      const documentId = String(handle.documentId)
      const residency = new AutomergeResidencyLeases(repo)

      handle.on('change', () => {})
      residency.noteAmbientListener(documentId)
      residency.forgetAmbientListener(documentId)

      // With the marker gone, that one listener is unaccounted for again.
      await expect(residency.evict(documentId)).resolves.toBe(true)
      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(1)
    })

    it('forgets the ambient marker, so the NEXT eviction of that id still reports', async () => {
      // A document can be evicted, come back, and be evicted again — the second
      // time through a path that never re-marked it ambient. A marker left over
      // from the first round would silently absorb one real orphan, which is the
      // same failure `forgetAmbientListener` exists to prevent on the failover
      // path.
      const storage = new MemoryStorage()
      const repo = new Repo({ network: [], storage })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      await repo.flush()
      const documentId = String(handle.documentId)
      const residency = new AutomergeResidencyLeases(repo)

      handle.on('change', () => {})
      residency.noteAmbientListener(documentId)
      await expect(residency.evict(documentId)).resolves.toBe(true)
      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)

      // Same document id, new handle, a real unaccounted watcher, and no sweep
      // has passed over it yet.
      const reopened = await repo.find(handle.url)
      await reopened.whenReady()
      expect(String(reopened.documentId)).toBe(documentId)
      reopened.on('change', () => {})

      await expect(residency.evict(documentId)).resolves.toBe(true)
      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(1)
    })

    it('counts a document evicted while something unaccounted-for was watching it', async () => {
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: { a: { id: 'a' } } })
      await handle.whenReady()
      const residency = new AutomergeResidencyLeases(repo)

      // A projector attaches a watcher and nobody leases the document — exactly
      // the shape of the bug this exists to surface.
      handle.on('change', () => {})

      await expect(residency.evict(String(handle.documentId))).resolves.toBe(true)

      const snapshot = await residency.snapshot()
      expect(snapshot.orphanedListenerEvictions).toBe(1)
      expect(snapshot.orphanedListenersByType).toEqual({ 'object-shard': 1 })
    })

    it('stays silent for a document nobody was watching', async () => {
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      const residency = new AutomergeResidencyLeases(repo)

      await expect(residency.evict(String(handle.documentId))).resolves.toBe(true)

      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)
    })

    it('does not count the idle sweep ambient tracker on a lease release', async () => {
      // The sweep attaches its 'change' tracker to every READY handle it
      // iterates — before the lease check — so a leased, projector-held document
      // acquires it within one sweep. `releaseOwner`/`replaceOwner` then evict
      // without declaring any owned listeners, because they have no idea the
      // sweep exists. Counting that tracker would make the census non-zero at
      // steady state on any READ_MODEL=on deployment — a detector that always
      // fires reports nothing.
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      const residency = new AutomergeResidencyLeases(repo)
      residency.acquire(handle, 'projector-a', 'landscape/v1')

      // ...one sweep passes over it while it is still leased.
      handle.on('change', () => {})
      residency.noteAmbientListener(String(handle.documentId))

      residency.releaseOwner('projector-a')
      await residency.drain()

      expect(repo.handles[handle.documentId]).toBeUndefined()
      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)
    })

    it('still counts a real watcher on a swept document', async () => {
      // The ambient tracker is worth exactly one listener. A projector watching
      // the same document without a lease must still be reported.
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      const residency = new AutomergeResidencyLeases(repo)
      handle.on('change', () => {})
      residency.noteAmbientListener(String(handle.documentId))
      handle.on('change', () => {})

      await expect(residency.evict(String(handle.documentId))).resolves.toBe(true)

      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(1)
    })

    it('does not count a watcher that detaches on the eviction hook', async () => {
      // An orphan is a listener still attached AFTER everyone who knows about
      // eviction has cleaned up. A component that subscribes to onBeforeEvict
      // and detaches there is doing exactly what it should — the read-model
      // projector watches diagram documents this way, deliberately unleased —
      // and must not be reported.
      const repo = new Repo({ network: [] })
      const handle = repo.create({ objects: {} })
      await handle.whenReady()
      const residency = new AutomergeResidencyLeases(repo)
      const onChange = () => {}
      handle.on('change', onChange)
      residency.onBeforeEvict(() => { handle.off('change', onChange) })

      await expect(residency.evict(String(handle.documentId))).resolves.toBe(true)

      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)
    })
  })
})
