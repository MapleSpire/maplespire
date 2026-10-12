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
import { PerformanceSeedPlan } from './generator.js'
import { createPerformanceWorkspaceRoot } from './workspace.js'
import {
  TEST_PERFORMANCE_SEED_SCALE,
  type PerformanceSeedScale,
  type PerformanceTagSnapshot,
} from './types.js'

class MemoryStorage implements StorageAdapterInterface {
  private entries = new Map<string, { key: StorageKey; data: Uint8Array }>()

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(key.join('/'))?.data.slice()
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.entries.set(key.join('/'), { key: [...key], data: data.slice() })
  }

  async remove(key: StorageKey): Promise<void> {
    this.entries.delete(key.join('/'))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => keyPrefix.every((part, index) => part === key[index]))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) {
      if (keyPrefix.every((part, index) => part === key[index])) this.entries.delete(text)
    }
  }
}

class ConcurrencyTrackingStorage extends MemoryStorage {
  activeSaves = 0
  maximumConcurrentSaves = 0

  override async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.activeSaves++
    this.maximumConcurrentSaves = Math.max(this.maximumConcurrentSaves, this.activeSaves)
    try {
      await new Promise((resolve) => setTimeout(resolve, 2))
      await super.save(key, data)
    } finally {
      this.activeSaves--
    }
  }
}

function tags(): PerformanceTagSnapshot[] {
  return Array.from({ length: 6 }, (_, index) => ({
    tagId: `tag-${index}`,
    value: `Tag ${index}`,
    color: '#336699',
    groupId: `group-${index % 2}`,
    groupName: `Group ${index % 2}`,
    catalogRevision: 1,
  }))
}

/**
 * 9 975 records, not the fixture's 100 000. At full scale this file took ~91 s
 * and 5.8 GB RSS in one worker — 96 % of it `Automerge.from` building 200
 * documents of real ADR payload — and timed out under load, while none of its
 * assertions needed the scale to be large (shard arithmetic has no threshold).
 *
 * 9 975 is deliberately NOT a multiple of the shard size: it gives 19 full
 * shards and a tail of 475, so a `ceil` → `floor` mistake is observable. The
 * id probes below also check which records land in which shard and in what
 * order, which counting keys cannot see (e.g. an assignment rotated by 250).
 */
const ADR_SCALE_RECORDS = 9_975
/** The seeder's default (`workspace.ts`, `decisionRecordShardSize ?? 500`).
 *  Deliberately NOT passed as an option below: this test is the only thing that
 *  pins the default, and passing it would make the assertion its own echo. */
const ADR_DEFAULT_SHARD_SIZE = 500

describe('enterprise performance workspace durability', () => {
  it('shards ADRs by the default shard size and keeps ModelMeta summary-only', async () => {
    const storage = new MemoryStorage()
    const adrHeavyScale: PerformanceSeedScale = {
      ...TEST_PERFORMANCE_SEED_SCALE,
      decisionRecords: ADR_SCALE_RECORDS,
      diagramBuckets: [{ shapes: 10, count: 1 }],
    }
    const plan = new PerformanceSeedPlan({
      scale: adrHeavyScale,
      tags: tags(),
      teamIds: Array.from({ length: adrHeavyScale.teams }, (_, index) => `team-${index}`),
      seed: 13,
    })

    const result = await createPerformanceWorkspaceRoot(storage, plan, {
      modelShardSize: 600,
      registryShardSize: 1,
    })
    const shardCount = Math.ceil(ADR_SCALE_RECORDS / ADR_DEFAULT_SHARD_SIZE)
    const reader = new Repo({ storage, network: [] })
    const meta = (await reader.find(result.modelMetaUrl as AutomergeUrl)).doc() as {
      decisionRecordShardUrls: string[]
      decisionRecordCount: number
      decisionRecordShardSize: number
      decisionRecords: Record<string, unknown>
    }
    expect(meta.decisionRecordShardUrls).toEqual([])
    expect(result.decisionRecordShardUrls).toHaveLength(shardCount)
    expect(meta.decisionRecordCount).toBe(ADR_SCALE_RECORDS)
    expect(meta.decisionRecordShardSize).toBe(ADR_DEFAULT_SHARD_SIZE)
    expect(Object.keys(meta.decisionRecords)).toHaveLength(0)

    const shardAt = async (index: number): Promise<Record<string, unknown>> => (
      ((await reader.find(result.decisionRecordShardUrls[index] as AutomergeUrl)).doc() as {
        decisionRecords: Record<string, unknown>
      }).decisionRecords
    )
    // Length AND identity on every shard this test opens. Identity is free once
    // the shard is resolved (the cost is the `find`, ~375 ms), and length alone
    // says nothing about which records are in it.
    const expectShard = async (index: number, length: number): Promise<void> => {
      const keys = Object.keys(await shardAt(index))
      expect(keys).toHaveLength(length)
      expect(keys[0]).toBe(plan.decisionRecordId(index * ADR_DEFAULT_SHARD_SIZE))
      expect(keys.at(-1)).toBe(plan.decisionRecordId(index * ADR_DEFAULT_SHARD_SIZE + length - 1))
    }
    await expectShard(0, ADR_DEFAULT_SHARD_SIZE)
    await expectShard(shardCount - 2, ADR_DEFAULT_SHARD_SIZE)
    // The partial tail shard.
    await expectShard(shardCount - 1, ADR_SCALE_RECORDS - (shardCount - 1) * ADR_DEFAULT_SHARD_SIZE)

    // Not covered: only three of twenty shards are opened, so a permutation
    // confined to the middle shards (e.g. swapping 5 and 6) goes unseen.
    // Resolving all twenty costs ~6 s; the realistic scramble (losing
    // `urls.push` order) moves shard 0, 18 or 19 and is caught here.

    // Check each record is at the expected POSITION in its shard, not merely
    // present. Automerge map keys read back in lexicographic order, so
    // position equals record index only because `decisionRecordId` zero-pads
    // to six digits (`generator.ts`); the padding stops working above 999 999
    // records. This does not exercise `readDecisionRecordPage`: its sharded
    // branch never runs here because `toPerformanceControlMeta` empties the
    // shard list, as asserted above.
    const recordIndexes = [
      0,
      1,
      ADR_DEFAULT_SHARD_SIZE - 1,                                        // last of shard 0
      ADR_DEFAULT_SHARD_SIZE,                                            // first of shard 1
      ADR_SCALE_RECORDS - (ADR_SCALE_RECORDS % ADR_DEFAULT_SHARD_SIZE),  // first of the tail
      ADR_SCALE_RECORDS - 1,
    ]
    for (const recordIndex of recordIndexes) {
      const located = await shardAt(Math.floor(recordIndex / meta.decisionRecordShardSize))
      expect(Object.keys(located)[recordIndex % meta.decisionRecordShardSize])
        .toBe(plan.decisionRecordId(recordIndex))
    }
    await reader.shutdown()
    // 60 s timeout is required, not slack: this test takes ~11 s alone and
    // ~18 s inside the loaded suite, too close to the default 20 s
    // `testTimeout`. 60 s is ~3.3x the loaded cost.
  }, 60_000)

  it('bounds concurrent storage writes below the default PostgreSQL pool size', async () => {
    const storage = new ConcurrencyTrackingStorage()
    const plan = new PerformanceSeedPlan({
      scale: TEST_PERFORMANCE_SEED_SCALE,
      tags: tags(),
      teamIds: Array.from({ length: TEST_PERFORMANCE_SEED_SCALE.teams }, (_, index) => `team-${index}`),
      seed: 12,
    })

    await createPerformanceWorkspaceRoot(storage, plan, {
      modelShardSize: 64,
      registryShardSize: 10,
    })

    expect(storage.maximumConcurrentSaves).toBeLessThan(10)
  }, 30_000)

  it('cold-loads every sharded layer after bounded writer repos are destroyed', async () => {
    const storage = new MemoryStorage()
    const plan = new PerformanceSeedPlan({
      scale: TEST_PERFORMANCE_SEED_SCALE,
      tags: tags(),
      teamIds: Array.from({ length: TEST_PERFORMANCE_SEED_SCALE.teams }, (_, index) => `team-${index}`),
      seed: 11,
    })
    const progress: string[] = []
    const result = await createPerformanceWorkspaceRoot(storage, plan, {
      modelShardSize: 256,
      registryShardSize: 4,
      documentsPerRepo: 2,
      onProgress: (entry) => progress.push(entry.phase),
    })

    expect(result.objectShardUrls).toHaveLength(4) // three base shards + one overlay
    expect(result.connectionShardUrls).toHaveLength(
      Math.ceil(TEST_PERFORMANCE_SEED_SCALE.connections / 256) + 1,
    ) // base shards + one editable overlay
    expect(result.registryShardUrls).toHaveLength(4) // three immutable baseline shards + one write head
    expect(progress).toEqual(expect.arrayContaining([
      'objects', 'connections', 'decision_records', 'model_meta', 'diagrams', 'root',
    ]))

    const reader = new Repo({ storage, network: [] })
    const root = (await reader.find(result.rootUrl as AutomergeUrl)).doc() as {
      modelUrl: string
      modelMetaUrl: string
      shardUrls: string[]
      registryWriteUrl: string
    }
    expect(root).toMatchObject({
      modelUrl: result.modelUrl,
      modelMetaUrl: result.modelMetaUrl,
      shardUrls: result.registryShardUrls,
      registryWriteUrl: result.registryWriteUrl,
    })
    const registryWrite = (await reader.find(root.registryWriteUrl as AutomergeUrl)).doc() as {
      diagrams: Record<string, unknown>
    }
    expect(registryWrite.diagrams).toEqual({})
    const meta = (await reader.find(root.modelMetaUrl as AutomergeUrl)).doc() as {
      objectShardUrls: string[]
      connectionShardUrls: string[]
      decisionRecordShardUrls: string[]
      decisionRecords: Record<string, unknown>
      domains: Record<string, unknown>
      tagSnapshots: Record<string, unknown>
    }
    expect(meta.objectShardUrls).toEqual([result.objectOverlayUrl])
    expect(meta.connectionShardUrls).toEqual([result.connectionOverlayUrl])
    expect(meta.decisionRecordShardUrls).toEqual([])
    expect(Object.keys(meta.decisionRecords)).toHaveLength(0)
    const objectOverlay = (await reader.find(result.objectOverlayUrl as AutomergeUrl)).doc() as {
      objects: Record<string, unknown>
      writeHeadVersion: number
      writeBatchIds: string[]
    }
    const connectionOverlay = (await reader.find(result.connectionOverlayUrl as AutomergeUrl)).doc() as {
      connections: Record<string, unknown>
      writeHeadVersion: number
      writeBatchIds: string[]
    }
    expect(objectOverlay).toMatchObject({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    expect(connectionOverlay).toMatchObject({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const decisionRecordShards = await Promise.all(result.decisionRecordShardUrls.map(async (url) => (
      (await reader.find(url as AutomergeUrl)).doc() as { decisionRecords: Record<string, unknown> }
    )))
    expect(decisionRecordShards.reduce((sum, shard) => sum + Object.keys(shard.decisionRecords).length, 0))
      .toBe(TEST_PERFORMANCE_SEED_SCALE.decisionRecords)
    expect(Object.keys(meta.domains)).toHaveLength(96)
    expect(Object.keys(meta.tagSnapshots)).toHaveLength(tags().length)

    const registries = await Promise.all(root.shardUrls.map(async (url) => (
      (await reader.find(url as AutomergeUrl)).doc() as { diagrams: Record<string, { docUrl: string }> }
    )))
    const diagramMetas = registries.flatMap((registry) => Object.values(registry.diagrams))
    expect(diagramMetas).toHaveLength(plan.diagramCount)
    const firstDiagram = (await reader.find(diagramMetas[0].docUrl as AutomergeUrl)).doc() as {
      objectIds: string[]
      comments: Record<string, unknown>
      flows: Record<string, unknown>
    }
    const lastDiagram = (await reader.find(diagramMetas.at(-1)!.docUrl as AutomergeUrl)).doc() as {
      objectIds: string[]
    }
    expect(firstDiagram.objectIds).toHaveLength(10)
    expect(Object.keys(firstDiagram.comments).length).toBeGreaterThan(0)
    expect(Object.keys(firstDiagram.flows)).toHaveLength(1)
    expect(lastDiagram.objectIds).toHaveLength(500)

    await reader.shutdown()
  }, 30_000)
})
