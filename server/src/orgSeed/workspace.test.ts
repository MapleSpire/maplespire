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
import { generateSeedModel } from './generator.js'
import { createSeedWorkspaceRoot } from './workspace.js'
import { forkRoot } from '../forkRoot.js'
import { openBootstrapScope } from '../bootstrapScope.js'

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

describe('organization seed workspace durability', () => {
  it('cold-loads the root and every referenced document before publication', async () => {
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const model = generateSeedModel('org-durable-seed')
    await expect(writer.find('automerge:4AW8JyhzsdXix8VKib584EtconB1' as AutomergeUrl)).rejects.toThrow('unavailable')

    const { rootUrl } = await createSeedWorkspaceRoot(writer, model)

    const reader = new Repo({ storage, network: [] })
    const root = (await reader.find(rootUrl as AutomergeUrl)).doc() as {
      modelUrl: string
      modelMetaUrl: string
      shardUrls: string[]
    }
    const monolith = await reader.find(root.modelUrl as AutomergeUrl)
    const meta = (await reader.find(root.modelMetaUrl as AutomergeUrl)).doc() as {
      objectShardUrls: string[]
      connectionShardUrls: string[]
    }
    const registry = (await reader.find(root.shardUrls[0] as AutomergeUrl)).doc() as {
      diagrams: Record<string, { docUrl: string }>
    }
    const objectShards = await Promise.all(meta.objectShardUrls.map((url) => reader.find(url as AutomergeUrl)))
    const connectionShards = await Promise.all(meta.connectionShardUrls.map((url) => reader.find(url as AutomergeUrl)))
    const diagrams = await Promise.all(Object.values(registry.diagrams).map(({ docUrl }) => reader.find(docUrl as AutomergeUrl)))

    expect(monolith.doc()).toMatchObject({ objects: {}, connections: {} })
    expect(Object.keys((objectShards[0].doc() as { objects: object }).objects)).toHaveLength(model.objects.length)
    expect(Object.keys((connectionShards[0].doc() as { connections: object }).connections)).toHaveLength(model.connections.length)
    expect(objectShards[1].doc()).toMatchObject({ objects: {} })
    expect(connectionShards[1].doc()).toMatchObject({ connections: {} })
    expect(diagrams).toHaveLength(model.diagrams.length)

    await reader.shutdown()
    // The writer is deliberately not shut down: Repo.shutdown() flushes every
    // cached handle, including the unavailable one requested above, and would
    // fail for an unrelated reason. Production keeps the shared repo alive;
    // the scoped flush is what this test covers.
  })

  it('cold-loads the Snapshot fork before createVersion can publish it', async () => {
    const storage = new MemoryStorage()
    const writer = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const { rootUrl: sourceRootUrl } = await createSeedWorkspaceRoot(writer, generateSeedModel('org-durable-fork'))

    const { rootUrl: forkedRootUrl } = await forkRoot(writer, sourceRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))

    const reader = new Repo({ storage, network: [] })
    const root = (await reader.find(forkedRootUrl as AutomergeUrl)).doc() as {
      modelUrl: string
      modelMetaUrl: string
      shardUrls: string[]
    }
    const meta = (await reader.find(root.modelMetaUrl as AutomergeUrl)).doc() as {
      objectShardUrls: string[]
      connectionShardUrls: string[]
    }
    const registry = (await reader.find(root.shardUrls[0] as AutomergeUrl)).doc() as {
      diagrams: Record<string, { docUrl: string }>
    }

    await reader.find(root.modelUrl as AutomergeUrl)
    await Promise.all(meta.objectShardUrls.map((url) => reader.find(url as AutomergeUrl)))
    await Promise.all(meta.connectionShardUrls.map((url) => reader.find(url as AutomergeUrl)))
    await Promise.all(Object.values(registry.diagrams).map(({ docUrl }) => reader.find(docUrl as AutomergeUrl)))

    expect(Object.keys(registry.diagrams)).toHaveLength(3)
    await reader.shutdown()
    await writer.shutdown()
  })
})
