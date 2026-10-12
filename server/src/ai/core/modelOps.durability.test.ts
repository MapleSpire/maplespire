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

import { describe, expect, it } from 'vitest'
import {
  Repo,
  type AutomergeUrl,
  type Chunk,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { createDiagramDoc } from './modelOps.js'
import { WorkspaceDocIndex } from '../../rbac/docScope.js'

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

describe('AI diagram document durability', () => {
  it('cold-loads a newly created diagram immediately after the MCP write returns', async () => {
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const model = writer.create({ objects: {}, connections: {} })
    const registry = writer.create({ diagrams: {} as Record<string, { docUrl: string }> })
    const root = writer.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([model.whenReady(), registry.whenReady(), root.whenReady()])
    await writer.flush([model.documentId, registry.documentId, root.documentId])
    const workspace = { landscapeId: 'landscape-mcp', versionId: 'version-live' }
    const index = new WorkspaceDocIndex(writer, {} as never, { durable: false })

    const diagramId = await createDiagramDoc(writer, root.url, {
      id: 'mcp-cold-load',
      name: 'MCP cold-load validation',
      type: 'context',
    }, workspace)

    // Simulate the browser connecting after the stateless MCP request has
    // completed: it knows only durable storage, not the writer's handle cache.
    const reader = new Repo({ storage, network: [] })
    const coldRoot = (await reader.find(root.url as AutomergeUrl)).doc() as { shardUrls: string[] }
    const coldRegistry = (await reader.find(coldRoot.shardUrls[0] as AutomergeUrl)).doc() as {
      diagrams: Record<string, { docUrl: string }>
    }
    const stub = coldRegistry.diagrams[diagramId]
    expect(stub).toBeDefined()
    expect(await index.resolveDocWorkspace(stub.docUrl.replace(/^automerge:/, ''))).toEqual(workspace)
    const coldDiagram = await reader.find(stub.docUrl as AutomergeUrl)
    expect(coldDiagram.doc()).toMatchObject({
      name: 'MCP cold-load validation',
      type: 'context',
      objectIds: [],
      connectionIds: [],
    })

    await reader.shutdown()
    await writer.shutdown()
  })

  // The order IS the invariant: a restart between the stub publication and
  // the claim leaves a published link pointing at a document no admission
  // path can place. Pinned by event capture, not by reading the
  // code: flush(diagram) < claim(diagram) < registry publish.
  it('createDiagram claims after flush and before the registry stub is published', async () => {
    const events: string[] = []
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const flushRecorder = new Proxy(writer, {
      get(target, prop) {
        if (prop === 'flush') {
          return (documentIds?: string[]) => {
            for (const id of documentIds ?? []) events.push(`flush:${id}`)
            return target.flush(documentIds as never)
          }
        }
        // Bind to the TARGET, not the proxy: Repo's methods touch #private
        // members, which throw when `this` is the proxy.
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    }) as unknown as Repo

    const registry = writer.create({ diagrams: {} as Record<string, { docUrl: string }> })
    const root = writer.create({ modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([registry.whenReady(), root.whenReady()])
    await writer.flush([registry.documentId, root.documentId])
    events.length = 0
    registry.on('change', ({ patchInfo }) => {
      const after = (patchInfo?.after ?? {}) as { diagrams?: Record<string, unknown> }
      for (const id of Object.keys(after.diagrams ?? {})) events.push(`publish:${id}`)
    })

    const workspace = { landscapeId: 'L-order', versionId: 'V-order' }
    const claimingPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          for (const id of Array.isArray(first) ? first as string[] : [String(first)]) {
            events.push(`claim:${id}`)
          }
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    new WorkspaceDocIndex(flushRecorder, claimingPool as never)

    const diagramId = await createDiagramDoc(flushRecorder, root.url, {
      id: 'order-pin',
      name: 'Order pin',
      type: 'context',
    }, workspace)

    const publishAt = events.indexOf(`publish:${diagramId}`)
    expect(publishAt).toBeGreaterThan(-1)
    const stub = (registry.doc() as { diagrams: Record<string, { docUrl: string }> }).diagrams[diagramId]!
    const docId = stub.docUrl.replace(/^automerge:/, '')
    const flushAt = events.indexOf(`flush:${docId}`)
    const claimAt = events.indexOf(`claim:${docId}`)
    expect(flushAt, `no flush event for the diagram doc in ${JSON.stringify(events)}`).toBeGreaterThan(-1)
    expect(claimAt, `no claim event for the diagram doc in ${JSON.stringify(events)}`).toBeGreaterThan(-1)
    expect(flushAt).toBeLessThan(claimAt)
    expect(claimAt).toBeLessThan(publishAt)

    await writer.shutdown()
  })

  it('the REGISTRY SHARD a diagram creation spills into is claimed too, before the root advertises it', async () => {
    // THE SECOND DOCUMENT THIS PATH CREATES: the registry shard holding the
    // stub must be claimed too, or it is a shard no workspace owns. The type
    // seal in `rbac/sealedRepo.ts` guards the type surface; it cannot stop
    // somebody rewriting the creation inside a sanctioned opening as a bare
    // `repo.create`. This arm is that half — nothing else in the `src/ai` and
    // `src/draft` suites would notice.
    //
    // A root with an EMPTY `shardUrls` is what forces the create path: the
    // loop over existing shards finds nothing to fill, so a fresh shard is the
    // only way to land the stub. Cheaper and more direct than filling one to
    // `AM_SHARD_SIZE`, and it exercises the same line.
    const events: string[] = []
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const root = writer.create({ modelUrl: '', shardUrls: [] as string[] })
    await root.whenReady()
    await writer.flush([root.documentId])

    const workspace = { landscapeId: 'L-shard', versionId: 'V-shard' }
    const claimingPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          // The WORKSPACE is recorded with the id, from the insert's own
          // parameters (`[batch, landscapeId, versionId]`). "A claim happened"
          // is not the property — the diagram document's own claim would
          // satisfy that. The property is that THIS shard was claimed to THIS
          // workspace.
          for (const id of ids) events.push(`claim:${id}:${String(params?.[1])}/${String(params?.[2])}`)
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    new WorkspaceDocIndex(writer, claimingPool as never)

    // The root learns the shard's URL only at the end of the creation, so
    // watching it tells us WHEN the link was published relative to the claim.
    root.on('change', ({ patchInfo }) => {
      const after = (patchInfo?.after ?? {}) as { shardUrls?: string[] }
      for (const url of after.shardUrls ?? []) events.push(`advertise:${url.replace(/^automerge:/, '')}`)
    })

    await createDiagramDoc(writer, root.url, {
      id: 'shard-spill',
      name: 'Shard spill',
      type: 'context',
    }, workspace)

    const shardUrls = (root.doc() as { shardUrls: string[] }).shardUrls
    expect(shardUrls, 'no registry shard was created — this arm exercised nothing').toHaveLength(1)
    const shardId = shardUrls[0]!.replace(/^automerge:/, '')

    // CLAIMED TO THIS WORKSPACE, and claimed BEFORE the root advertised it. A
    // published link to an unclaimed document is the exact hole the route gate
    // would have to constater, so the ordering is the property — not the
    // claim's bare existence.
    const claimAt = events.indexOf(
      `claim:${shardId}:${workspace.landscapeId}/${workspace.versionId}`,
    )
    const advertiseAt = events.indexOf(`advertise:${shardId}`)
    expect(claimAt, `no claim event for the registry shard in ${JSON.stringify(events)}`).toBeGreaterThan(-1)
    expect(advertiseAt, `the root never advertised the shard in ${JSON.stringify(events)}`).toBeGreaterThan(-1)
    // The only assertion in this arm that catches "minted unclaimed, published,
    // then claimed". It carries the event list in its message so a failure is
    // readable, like its siblings.
    expect(claimAt, `the shard was advertised before it was claimed; saw ${JSON.stringify(events)}`)
      .toBeLessThan(advertiseAt)

    await writer.shutdown()
  })
})
