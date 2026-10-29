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

/**
 * Executes the producers of a workspace's write-path documents and asserts
 * that each one creates, AT BIRTH, the containers its writers push into:
 *
 *  - ModelMeta: the four inline collections and the four tombstone lists;
 *  - the current overlay write heads: their entity map and `writeBatchIds`;
 *  - DiagramDocs: the composition lists and the layout/comment/flow maps.
 *
 * Why at birth: a container created lazily by its first writer is created
 * TWICE when two peers write first concurrently, and Automerge resolves the
 * two values under one key by keeping one — the other peer's entries become
 * unreachable (measured in `modelMeta.test.ts`, "two peers creating a
 * tombstone list lazily"). The writers stay tolerant of an absent container
 * (`local/no-detached-container-write`); this suite is what keeps absence the
 * rare case. `rootShape.producers.test.ts` is its sibling for the root's own
 * fields.
 *
 * NOT here, deliberately:
 *  - `layouts3d` — absent by design until the first 3D edit forks the diagram
 *    (`ensureFork3d`); `{}` would block that fork.
 *  - in-place mutators and clones (`forkRoot`, `applyMerge`'s doc copies,
 *    `degenerateRootRepair`): they copy their source, so they inherit what it
 *    holds. For old sources `containerBackfill.ts` backfills and heals the one
 *    append-only list (`writeBatchIds`) and only reports the rest — a server
 *    write racing an offline client's lazy creation hides that client's
 *    entries, and only an append-only list can be healed afterwards.
 *  - `scripts/seed-workspace.ts` and `scripts/repair-overlay-heads.ts` —
 *    top-level operator scripts (they open a pg pool at import), changed to the
 *    same shape and not executed here.
 */

import { describe, expect, it } from 'vitest'
import {
  Repo,
  type AutomergeUrl,
  type Chunk,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { createEmptyRoot } from './automergeServer.js'
import { createSeedWorkspaceRoot } from './orgSeed/workspace.js'
import { generateSeedModel } from './orgSeed/generator.js'
import { createSparseDraftRoot } from './draft/sparse.js'
import { createPerformanceWorkspaceRoot } from './performanceSeed/workspace.js'
import { PerformanceSeedPlan } from './performanceSeed/generator.js'
import { TEST_PERFORMANCE_SEED_SCALE, type PerformanceTagSnapshot } from './performanceSeed/types.js'
import { openBootstrapScope } from './bootstrapScope.js'
import { writeOverlayEntities, type OverlayMetaLike } from './overlaySegments.js'
import { compactOverlay } from './readModel/compaction.js'
import { createDiagramDoc } from './ai/core/modelOps.js'

class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()
  async load(key: StorageKey): Promise<Uint8Array | undefined> { return this.entries.get(key.join('/'))?.data.slice() }
  async save(key: StorageKey, data: Uint8Array): Promise<void> { this.entries.set(key.join('/'), { key: [...key], data: data.slice() }) }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(key.join('/')) }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => prefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) if (prefix.every((part, index) => key[index] === part)) this.entries.delete(text)
  }
}

type Doc = Record<string, unknown>

async function read(repo: Repo, url: unknown): Promise<Doc> {
  expect(typeof url, 'a producer left a pointer unset').toBe('string')
  const handle = await repo.find<Doc>(url as AutomergeUrl)
  await handle.whenReady()
  return handle.doc() as Doc
}

const isMap = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Fails by NAME for every container the document lacks. */
function expectContainers(doc: Doc, producer: string, maps: readonly string[], lists: readonly string[]): void {
  const missing = [
    ...maps.filter((field) => !isMap(doc[field])).map((field) => `${field} (map)`),
    ...lists.filter((field) => !Array.isArray(doc[field])).map((field) => `${field} (list)`),
  ]
  expect(missing, `${producer} created without`).toEqual([])
}

const META_MAPS = ['groups', 'domains', 'tagSnapshots', 'decisionRecords'] as const
const META_LISTS = ['deletedObjectIds', 'deletedConnectionIds', 'deletedDecisionRecordIds', 'deletedDiagramIds'] as const
const DIAGRAM_MAPS = ['layouts', 'comments', 'flows'] as const
const DIAGRAM_LISTS = ['objectIds', 'connectionIds', 'groupIds', 'checkpoints'] as const

/** The meta and both CURRENT heads of a workspace root. */
async function expectWriteDocuments(repo: Repo, rootUrl: string, producer: string): Promise<Doc> {
  const root = await read(repo, rootUrl)
  const meta = await read(repo, root.modelMetaUrl)
  expectContainers(meta, `${producer} ModelMeta`, META_MAPS, META_LISTS)
  expectContainers(await read(repo, meta.editsObjectShardUrl), `${producer} object write head`, ['objects'], ['writeBatchIds'])
  expectContainers(await read(repo, meta.editsConnectionShardUrl), `${producer} connection write head`, ['connections'], ['writeBatchIds'])
  return root
}

describe('every producer creates the write-path containers at birth', () => {
  it('createEmptyRoot (workspace bootstrap), and its starter diagram', async () => {
    const repo = new Repo({ storage: new MemoryStorage(), network: [] })
    const { rootUrl } = await createEmptyRoot(
      repo,
      openBootstrapScope({ landscapeId: 'L-c', versionId: 'V-c' }, { kind: 'unfenced', reason: 'no-forker' }),
      { starterDiagram: true },
    )
    const root = await expectWriteDocuments(repo, rootUrl, 'createEmptyRoot')
    const registry = await read(repo, (root.shardUrls as string[])[0])
    const stubs = Object.values(registry.diagrams as Record<string, { docUrl: string }>)
    expect(stubs.length, 'the starter diagram is the DiagramDoc under test').toBeGreaterThan(0)
    for (const stub of stubs) {
      expectContainers(await read(repo, stub.docUrl), 'createEmptyRoot starter DiagramDoc', DIAGRAM_MAPS, DIAGRAM_LISTS)
    }
  })

  it('createSeedWorkspaceRoot (organization demo seed)', async () => {
    const repo = new Repo({ storage: new MemoryStorage(), network: [], saveDebounceRate: 60_000 })
    const { rootUrl } = await createSeedWorkspaceRoot(repo, generateSeedModel('containers-producers'))
    await expectWriteDocuments(repo, rootUrl, 'createSeedWorkspaceRoot')
  })

  it('createSparseDraftRoot (bounded copy-on-write draft)', async () => {
    const repo = new Repo({ network: [] })
    const objectOverlay = repo.create({ objects: {} })
    const connectionOverlay = repo.create({ connections: {} })
    const meta = repo.create({
      staticBaseline: true,
      objectShardUrls: [objectOverlay.url], connectionShardUrls: [connectionOverlay.url],
      editsObjectShardUrl: objectOverlay.url, editsConnectionShardUrl: connectionOverlay.url,
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const parentRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [] as string[], registrySummaryOnly: true })
    await Promise.all([objectOverlay, connectionOverlay, meta, parentRoot].map((handle) => handle.whenReady()))
    const draft = await createSparseDraftRoot(
      repo, parentRoot.url, 'parent-v',
      openBootstrapScope({ landscapeId: 'L-c', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }),
    )
    await expectWriteDocuments(repo, draft.rootUrl, 'createSparseDraftRoot')
  })

  it('createPerformanceWorkspaceRoot (benchmark seed)', async () => {
    const storage = new MemoryStorage()
    const plan = new PerformanceSeedPlan({
      scale: TEST_PERFORMANCE_SEED_SCALE,
      tags: Array.from({ length: 4 }, (_, index): PerformanceTagSnapshot => ({
        tagId: `tag-${index}`, value: `Tag ${index}`, color: '#336699',
        groupId: 'group-0', groupName: 'Group 0', catalogRevision: 1,
      })),
      teamIds: Array.from({ length: TEST_PERFORMANCE_SEED_SCALE.teams }, (_, index) => `team-${index}`),
      seed: 11,
    })
    const result = await createPerformanceWorkspaceRoot(storage, plan, {
      modelShardSize: 256, registryShardSize: 4, documentsPerRepo: 2,
    })
    const reader = new Repo({ storage, network: [] })
    await expectWriteDocuments(reader, result.rootUrl, 'createPerformanceWorkspaceRoot')
    await reader.shutdown()
  }, 60_000)

  it('a fresh overlay segment (overlaySegments.createSegment, via its only door)', async () => {
    const repo = new Repo({ network: [] })
    const meta = repo.create<OverlayMetaLike>({ objectShardUrls: [], connectionShardUrls: [] })
    await meta.whenReady()
    await writeOverlayEntities(repo, meta, 'objects', { a: { id: 'a' } })
    const head = await read(repo, meta.doc()!.editsObjectShardUrl)
    expectContainers(head, 'overlaySegments.createSegment', ['objects'], ['writeBatchIds'])
  })

  it("compaction's fresh write head", async () => {
    const repo = new Repo({ network: [] })
    const overlay = repo.create({ objects: { n0: { id: 'n0' } } })
    const meta = repo.create({ objectShardUrls: [overlay.url], connectionShardUrls: [] as string[], editsObjectShardUrl: overlay.url })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([overlay, meta, root].map((handle) => handle.whenReady()))
    await compactOverlay(repo, root.url, { mode: 'apply' })
    const head = await read(repo, (meta.doc() as Doc).editsObjectShardUrl)
    expect((meta.doc() as Doc).editsObjectShardUrl, 'the fold published a fresh head').not.toBe(overlay.url)
    expectContainers(head, 'compaction nextHead', ['objects'], ['writeBatchIds'])
  })

  it('createDiagramDoc (AI / MCP diagram creation)', async () => {
    const repo = new Repo({ network: [] })
    const registry = repo.create({ diagrams: {} as Record<string, { docUrl: string }> })
    const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([registry.whenReady(), root.whenReady()])
    const id = await createDiagramDoc(repo, root.url, { name: 'D', type: 'context' }, { landscapeId: 'L-c', versionId: 'V-c' })
    expectContainers(await read(repo, registry.doc()!.diagrams[id]!.docUrl), 'createDiagramDoc', DIAGRAM_MAPS, DIAGRAM_LISTS)
  })
})
