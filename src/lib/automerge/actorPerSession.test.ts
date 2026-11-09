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

import * as A from '@automerge/automerge'
import {
  NetworkAdapter,
  Repo,
  type AutomergeUrl,
  type Chunk,
  type DocHandle,
  type PeerId,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * G4-16e step 1: WHICH client events make a new Automerge actor in a write
 * head? An ordinary head rotates at `AM_ORDINARY_HEAD_ROTATION_MAX_ACTORS`
 * (128) actors, so the answer decides whether rotation follows sessions or
 * edits.
 *
 * The client never chooses an actor: nothing in `src/` calls `setActor` or
 * passes an actor to `init`/`load`/`from`, and the whole app shares ONE
 * module-level `Repo` per page (`src/lib/automerge/repo.ts`). automerge-repo
 * (2.6.0-alpha.2) gives each document handle a fresh random actor when the
 * handle is made: `Repo.#ensureQuery` builds it on `Automerge.init()`, and a
 * document read from storage arrives as `A.loadIncremental(A.init(), …)`
 * (`StorageSubsystem.loadDoc`) — either way a new actor, for the life of that
 * handle. So an actor is per (page load × document handle), and it enters a
 * head's history only with the first change it makes there.
 *
 * Pinned below with real Repos, the browser's shared IndexedDB played by one
 * in-memory storage adapter, and the server by a Repo they sync with, whose
 * copy of the head is what the projector reads `A.stats` on:
 *
 * | event                                         | new actor in the head? |
 * |-----------------------------------------------|------------------------|
 * | a page load (new session) that writes         | yes, one per load      |
 * | a second tab that writes                      | yes                    |
 * | a reload while offline, then writing          | yes (and the offline   |
 * |                                               | edits keep theirs)     |
 * | a handle evicted from the cache, then written | yes (`handleRetry.ts`) |
 * | a reconnect of the same page                  | no                     |
 * | offline edits, then reconnect (same page)     | no                     |
 * | a second `find` of the same document          | no                     |
 * | a session that only reads                     | no                     |
 */

type Head = { objects: Record<string, { id: string; name: string }> }

class MemoryStorage implements StorageAdapterInterface {
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

type SentMessage = Parameters<NetworkAdapter['send']>[0]
type PeerMeta = Parameters<NetworkAdapter['connect']>[1]

/** One end of an in-process link, as a WebSocket is to the server: messages
 * on a later macrotask, and a disconnect that tells both sides. */
class LinkedAdapter extends NetworkAdapter {
  other: LinkedAdapter | null = null
  connected = false
  closed = false
  isReady(): boolean { return this.connected }
  whenReady(): Promise<void> { return Promise.resolve() }
  connect(peerId: PeerId, peerMetadata?: PeerMeta): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true
    const other = this.other
    if (other?.connected && other.peerId) {
      this.emit('peer-candidate', { peerId: other.peerId, peerMetadata: other.peerMetadata ?? {} })
      other.emit('peer-candidate', { peerId, peerMetadata: peerMetadata ?? {} })
    }
  }
  send(message: SentMessage): void {
    const other = this.other
    if (this.closed || !other || other.closed) return
    setTimeout(() => { if (!this.closed && !other.closed) other.emit('message', message) }, 0)
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true
    const other = this.other
    if (other?.peerId) this.emit('peer-disconnected', { peerId: other.peerId })
    if (other && this.peerId) {
      other.closed = true
      other.emit('peer-disconnected', { peerId: this.peerId })
    }
  }
}

const repos: Repo[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.shutdown().catch(() => undefined)))
})

/** The server, holding the write head every session edits. */
async function server(): Promise<{ repo: Repo; head: DocHandle<Head> }> {
  const repo = new Repo({ storage: new MemoryStorage(), network: [], sharePolicy: async () => true })
  repos.push(repo)
  const head = repo.create<Head>({ objects: {} })
  await head.whenReady()
  return { repo, head }
}

/** Connect `client` to `serverRepo` over a fresh link; returns its client end. */
function link(serverRepo: Repo, client: Repo): LinkedAdapter {
  const serverSide = new LinkedAdapter()
  const clientSide = new LinkedAdapter()
  serverSide.other = clientSide
  clientSide.other = serverSide
  serverRepo.networkSubsystem.addNetworkAdapter(serverSide)
  client.networkSubsystem.addNetworkAdapter(clientSide)
  return clientSide
}

/** A page load: a NEW Repo over the browser's (shared, persistent) storage,
 * online unless told otherwise — what `src/lib/automerge/repo.ts` builds. */
function page(storage: MemoryStorage, serverRepo: Repo | null): { repo: Repo; link: LinkedAdapter | null } {
  const repo = new Repo({ storage, network: [], sharePolicy: async () => true })
  repos.push(repo)
  return { repo, link: serverRepo ? link(serverRepo, repo) : null }
}

const actorsOf = (handle: DocHandle<unknown>) => A.stats(handle.doc() as A.Doc<unknown>).numActors
const changesOf = (handle: DocHandle<unknown>) => A.stats(handle.doc() as A.Doc<unknown>).numChanges
const actorOf = (handle: DocHandle<unknown>) => A.getActorId(handle.doc() as A.Doc<unknown>)

function write(handle: DocHandle<Head>, id: string): void {
  handle.change((d) => { d.objects[id] = { id, name: id } })
}

/** Wait until the server's head holds `changes` changes. */
async function serverHas(head: DocHandle<Head>, changes: number): Promise<void> {
  await vi.waitFor(() => expect(changesOf(head)).toBe(changes), { timeout: 10_000, interval: 10 })
}

describe('which client events make a new Automerge actor in a write head (G4-16e)', () => {
  it('a page load is a new actor: N sessions writing one change each put N more actors in the head', async () => {
    const { repo: serverRepo, head } = await server()
    const storage = new MemoryStorage()
    const base = actorsOf(head)
    const changes = changesOf(head)
    const seen = new Set<string>()
    const N = 4
    for (let session = 0; session < N; session += 1) {
      const { repo } = page(storage, serverRepo)
      const handle = await repo.find<Head>(head.url as AutomergeUrl)
      write(handle, `s${session}`)
      seen.add(actorOf(handle))
      await serverHas(head, changes + session + 1)
      await repo.flush()
      await repo.shutdown()
    }
    expect(seen.size).toBe(N)
    expect(actorsOf(head)).toBe(base + N)
    for (const actor of seen) expect(actor).not.toBe(actorOf(head))
  })

  it('a second tab is a second actor, the two tabs sharing one storage', async () => {
    const { repo: serverRepo, head } = await server()
    const storage = new MemoryStorage()
    const base = actorsOf(head)
    const changes = changesOf(head)
    const tabs = [page(storage, serverRepo), page(storage, serverRepo)]
    const handles = await Promise.all(tabs.map(({ repo }) => repo.find<Head>(head.url as AutomergeUrl)))
    write(handles[0]!, 'tab-a')
    write(handles[1]!, 'tab-b')
    await serverHas(head, changes + 2)
    expect(actorOf(handles[0]!)).not.toBe(actorOf(handles[1]!))
    expect(actorsOf(head)).toBe(base + 2)
  })

  it('the same page keeps ONE actor across a second find, a reconnect, and offline edits synced on reconnect', async () => {
    const { repo: serverRepo, head } = await server()
    const base = actorsOf(head)
    const changes = changesOf(head)
    const { repo, link: first } = page(new MemoryStorage(), serverRepo)
    const handle = await repo.find<Head>(head.url as AutomergeUrl)
    write(handle, 'one')
    const actor = actorOf(handle)
    // A second find returns the cached handle: same document, same actor.
    const again = await repo.find<Head>(head.url as AutomergeUrl)
    expect(again).toBe(handle)
    write(again, 'two')
    await serverHas(head, changes + 2)
    expect(actorsOf(head)).toBe(base + 1)
    // The socket drops; the page edits OFFLINE, then reconnects.
    first!.disconnect()
    write(handle, 'offline-1')
    write(handle, 'offline-2')
    expect(changesOf(head)).toBe(changes + 2)
    link(serverRepo, repo)
    await serverHas(head, changes + 4)
    write(handle, 'after-reconnect')
    await serverHas(head, changes + 5)
    expect(actorOf(handle)).toBe(actor)
    expect(actorsOf(head)).toBe(base + 1)
  })

  it('offline, then a RELOAD before reconnecting: the offline edits keep their actor, the reloaded page is another', async () => {
    const { repo: serverRepo, head } = await server()
    const storage = new MemoryStorage()
    const base = actorsOf(head)
    const changes = changesOf(head)
    // Online once, to have the head in local storage; no write.
    const warm = page(storage, serverRepo)
    await warm.repo.find<Head>(head.url as AutomergeUrl)
    await warm.repo.flush()
    await warm.repo.shutdown()
    // Offline: the page loads from storage alone and writes.
    const offline = page(storage, null)
    const offlineHandle = await offline.repo.find<Head>(head.url as AutomergeUrl)
    write(offlineHandle, 'offline')
    const offlineActor = actorOf(offlineHandle)
    await offline.repo.flush()
    await offline.repo.shutdown()
    expect(changesOf(head)).toBe(changes)
    // Reloaded, online: it carries the offline edit up AND writes as itself.
    const online = page(storage, serverRepo)
    const onlineHandle = await online.repo.find<Head>(head.url as AutomergeUrl)
    write(onlineHandle, 'online')
    await serverHas(head, changes + 2)
    expect(actorOf(onlineHandle)).not.toBe(offlineActor)
    expect(actorsOf(head)).toBe(base + 2)
  })

  it('a handle evicted from the cache and found again is a new actor (the handleRetry path)', async () => {
    const { repo: serverRepo, head } = await server()
    const base = actorsOf(head)
    const changes = changesOf(head)
    const { repo } = page(new MemoryStorage(), serverRepo)
    const first = await repo.find<Head>(head.url as AutomergeUrl)
    write(first, 'before')
    await serverHas(head, changes + 1)
    await repo.flush()
    await repo.removeFromCache(first.documentId)
    const second = await repo.find<Head>(head.url as AutomergeUrl)
    expect(second).not.toBe(first)
    write(second, 'after')
    await serverHas(head, changes + 2)
    expect(actorOf(second)).not.toBe(actorOf(first))
    expect(actorsOf(head)).toBe(base + 2)
  })

  it('a session that only reads adds no actor (an actor enters the history with its first change)', async () => {
    const { repo: serverRepo, head } = await server()
    const base = actorsOf(head)
    const changes = changesOf(head)
    for (let session = 0; session < 3; session += 1) {
      const { repo } = page(new MemoryStorage(), serverRepo)
      const handle = await repo.find<Head>(head.url as AutomergeUrl)
      expect(handle.doc()?.objects).toEqual({})
      await repo.shutdown()
    }
    // Control: one writing session after them is counted.
    const { repo } = page(new MemoryStorage(), serverRepo)
    write(await repo.find<Head>(head.url as AutomergeUrl), 'writer')
    await serverHas(head, changes + 1)
    expect(actorsOf(head)).toBe(base + 1)
  })
})
