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

import { afterEach, describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import {
  isValidAutomergeUrl,
  NetworkAdapter,
  Repo,
  type DocHandle,
  type PeerId,
} from '@automerge/automerge-repo'
import { adoptScalarMetaUrls, readMetaUrl, readMetaUrls } from './modelMetaUrls.js'
import { publishOverlaySegment, type OverlayMetaLike } from './overlaySegments.js'
import { buildModelMeta } from './modelMeta.js'

/**
 * G4-16f — MIXED VERSIONS on one ModelMeta, two real Repos over an
 * in-process link. The NEW writer is the server's real rotation write
 * (`publishOverlaySegment`, the rotator's one ModelMeta change). The OLD
 * build is represented by verbatim copies of its code before epochs, frozen
 * here on purpose (a test cannot import a previous commit):
 *  - its writer: `bridge.ts` `publishModelShardReference`
 *    (`m[field].push(handle.url)`), the client's one ModelMeta list write;
 *  - its readers: `bridge.ts` `orderedObjectOverlayUrls` and
 *    `overlayWriteHead.ts` `planBfsWriteMode`'s head test.
 */

type Meta = OverlayMetaLike & Record<string, unknown>

/** OLD BUILD `bridge.ts` orderedObjectOverlayUrls, verbatim. */
function oldOrderedObjectOverlayUrls(meta: Meta | undefined): string[] {
  const urls = [...(meta?.editsObjectShardUrls ?? [])].filter(isValidAutomergeUrl)
  const current = meta?.editsObjectShardUrl
  if (current && isValidAutomergeUrl(current)) {
    const index = urls.indexOf(current)
    if (index >= 0) urls.splice(index, 1)
    urls.push(current)
  }
  return [...new Set(urls)]
}
/** OLD BUILD `overlayWriteHead.ts` planBfsWriteMode's first test. */
function oldHeadsUsable(meta: Meta): boolean {
  const objectHead = meta.editsObjectShardUrl && isValidAutomergeUrl(meta.editsObjectShardUrl)
  const connectionHead = meta.editsConnectionShardUrl && isValidAutomergeUrl(meta.editsConnectionShardUrl)
  return Boolean(objectHead && connectionHead && meta.editsOverlayWriteHeadVersion === 1)
}
/** OLD BUILD `bridge.ts` publishModelShardReference, random-id path. */
function oldPublishModelShardReference(meta: DocHandle<Meta>, url: string): void {
  meta.change((m) => { (m.objectShardUrls as string[]).push(url) })
}

type SentMessage = Parameters<NetworkAdapter['send']>[0]
type PeerMeta = Parameters<NetworkAdapter['connect']>[1]
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

function link(a: Repo, b: Repo): void {
  const left = new LinkedAdapter()
  const right = new LinkedAdapter()
  left.other = right
  right.other = left
  a.networkSubsystem.addNetworkAdapter(left)
  b.networkSubsystem.addNetworkAdapter(right)
}

async function converged(a: DocHandle<Meta>, b: DocHandle<Meta>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const left = A.getHeads(a.doc() as A.Doc<unknown>).sort().join()
    const right = A.getHeads(b.doc() as A.Doc<unknown>).sort().join()
    if (left === right) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the two repos did not converge in 5 s')
}

/** A server Repo holding a fresh ModelMeta and an OLD client Repo with a
 * replica of it, then disconnected: each side writes alone. */
async function twoReplicas(): Promise<{ server: DocHandle<Meta>; client: DocHandle<Meta>; reconnect: () => Promise<void> }> {
  const serverRepo = new Repo({ network: [], sharePolicy: async () => true })
  repos.push(serverRepo)
  const mint = () => serverRepo.create({}).url
  const server = serverRepo.create<Meta>(buildModelMeta({
    objectShardUrls: [mint(), mint()],
    objectWriteHead: mint(),
    connectionWriteHead: mint(),
  }) as unknown as Meta)
  await server.whenReady()
  const clientRepo = new Repo({ network: [], sharePolicy: async () => true })
  repos.push(clientRepo)
  // The replica: the server's bytes, as a sync would leave them, under its own
  // handle; `reconnect` merges it into the synced handle of the SAME document
  // and lets the link carry both sides' concurrent changes.
  const client = clientRepo.import<Meta>(A.save(server.doc() as A.Doc<unknown>))
  await client.whenReady()
  return {
    server,
    client,
    reconnect: async () => {
      link(serverRepo, clientRepo)
      // The replica is a different handle id; merge it explicitly into the
      // server document's handle on the client side, then let sync converge.
      const replica = await clientRepo.find<Meta>(server.url)
      replica.merge(client)
      await converged(server, replica)
      clientReplica = replica
    },
  }
}
let clientReplica: DocHandle<Meta> | null = null

describe('mixed versions on one TEXT-ruled ModelMeta', () => {
  it('an OLD writer splicing the old field and a NEW writer, concurrently, converge on one list', async () => {
    const { server, client, reconnect } = await twoReplicas()
    const oldShard = 'automerge:3uZ7CB7xSiHiaVd1NGQfzH2BrQyQ' as const
    const rotated: string[] = []
    // Concurrent: the server rotates three times, the old client publishes a shard.
    for (let i = 0; i < 3; i += 1) {
      const next = (repos[0]!.create({}).url)
      rotated.push(next)
      publishOverlaySegment(server, 'objects', next)
    }
    oldPublishModelShardReference(client, oldShard)
    await reconnect()
    const merged = clientReplica!.doc()!
    const onServer = server.doc()!
    // One resolved list, identical on both replicas, holding both writers' urls.
    expect(readMetaUrls(merged, 'objectShardUrls')).toEqual(readMetaUrls(onServer, 'objectShardUrls'))
    for (const url of [...rotated, oldShard]) expect(readMetaUrls(merged, 'objectShardUrls')).toContain(url)
    // The OLD reader reads the same list from the old field.
    expect(merged.objectShardUrls).toEqual(readMetaUrls(merged, 'objectShardUrls'))
    // On a text-ruled document the new writer writes the SAME text field the old one
    // did: one Automerge list, two concurrent edits, nothing else to reconcile.
    expect(merged.objectShardRefs).toBeUndefined()
    // G4-16f: no later write cuts this document over in place (the in-place
    // cut-over is gone; an epoch builds a scalar-native successor instead):
    // it stays one text list, the old client's url in it.
    publishOverlaySegment(server, 'objects', repos[0]!.create({}).url)
    expect(server.doc()!.objectShardRefs).toBeUndefined()
    expect(readMetaUrls(server.doc(), 'objectShardUrls')).toContain(oldShard)
  })

  it('an OLD reader resolves every segment and the head the NEW writer wrote', async () => {
    const { server } = await twoReplicas()
    const written: string[] = [readMetaUrl(server.doc(), 'editsObjectShardUrl')!]
    for (let i = 0; i < 5; i += 1) {
      const next = repos[0]!.create({}).url
      written.push(next)
      publishOverlaySegment(server, 'objects', next)
    }
    const meta = server.doc()!
    expect(oldOrderedObjectOverlayUrls(meta)).toEqual(written)
    expect(oldOrderedObjectOverlayUrls(meta)).toEqual(readMetaUrls(meta, 'editsObjectShardUrls'))
    expect(oldHeadsUsable(meta)).toBe(true)
    // Nothing an old reader cannot read was written.
    expect(meta.editsObjectShardRefs).toBeUndefined()
    expect((meta.editsObjectShardUrls as unknown[]).every((v) => typeof v === 'string')).toBe(true)
  })

  it('a NEW reader resolves the same segments on a scalar-ruled ModelMeta, from the scalars', async () => {
    const { server } = await twoReplicas()
    const written: string[] = [readMetaUrl(server.doc(), 'editsObjectShardUrl')!]
    // The shape an epoch meta is born with (`buildEpochMeta`).
    server.change((d) => adoptScalarMetaUrls(d))
    for (let i = 0; i < 5; i += 1) {
      const next = repos[0]!.create({}).url
      written.push(next)
      publishOverlaySegment(server, 'objects', next)
    }
    const meta = server.doc()!
    expect(readMetaUrls(meta, 'editsObjectShardUrls')).toEqual(written)
    expect((meta.editsObjectShardRefs as unknown[]).every((v) => typeof v === 'object')).toBe(true)
  })
})

/**
 * A scalar-ruled ModelMeta (an epoch meta, born with its frozen text mirror)
 * read and written by an OLD client (from before the scalar URL fields): what the mirror gives it, and
 * what it does not. The mirror's own late writes reach new readers only once
 * the epoch forwarder adopts them (`forwardMetaMirror`, in
 * `readModel/modelEpochForwarder.ts`); no forwarder runs here.
 */
describe('a scalar-ruled ModelMeta and an OLD client: the frozen mirror, pinned', () => {
  it('an OLD reader sees the head and segments FROZEN in the mirror, still a usable shape', async () => {
    const { server } = await twoReplicas()
    server.change((d) => adoptScalarMetaUrls(d))
    const frozenHead = server.doc()!.editsObjectShardUrl
    const next = repos[0]!.create({}).url
    publishOverlaySegment(server, 'objects', next)
    const meta = server.doc()!
    expect(readMetaUrl(meta, 'editsObjectShardUrl')).toBe(next)
    // The old build would write into the head the mirror froze.
    expect(meta.editsObjectShardUrl).toBe(frozenHead)
    expect(oldHeadsUsable(meta)).toBe(true)
    expect(oldOrderedObjectOverlayUrls(meta)).not.toContain(next)
  })

  it('an OLD writer splicing the mirror is invisible to new readers until the mirror is forwarded', async () => {
    const { server, client, reconnect } = await twoReplicas()
    server.change((d) => adoptScalarMetaUrls(d))
    publishOverlaySegment(server, 'objects', repos[0]!.create({}).url)
    const late = 'automerge:4uZ7CB7xSiHiaVd1NGQfzH2BrQyQ'
    oldPublishModelShardReference(client, late)
    await reconnect()
    expect(clientReplica!.doc()!.objectShardUrls).toContain(late)
    expect(readMetaUrls(clientReplica!.doc(), 'objectShardUrls')).not.toContain(late)
  })
})
