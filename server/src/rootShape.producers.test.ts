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
 * Executes every root RECONSTRUCTION path and asserts, per producer, FULL
 * equality over the eight ROOT_SHAPE_FIELDS — each field's expected value, or
 * its expected ABSENCE, stated explicitly. The compiler pins the mapper's list
 * to the interface (rootShape.ts), but it cannot force a producer THROUGH the
 * mapper — nothing can type-forbid `repo.create({...})`. This suite is that
 * missing leg. The remaining leg is fsck's `summary-static-coherence`, which
 * catches the RESULT in production data.
 *
 * Why equality and not key-inclusion: rejecting only keys OUTSIDE the closed
 * list is blind to a field a producer LOSES (e.g. the performanceSeed
 * conversion dropping `registrySummaryOnly`), which is exactly what this module
 * exists to prevent. So the sweep fails BY FIELD NAME when a producer drops,
 * invents, or changes one.
 *
 * Not covered here, deliberately:
 *  - `scripts/seed-workspace.ts` — a top-level operator script (opens the pg
 *    pool at import); it builds its root through the mapper, untested here.
 *  - `ensureRootDoc` (automergeServer.ts) — needs `automerge_meta`; it builds
 *    from the same `buildEmptyRootShape()` as `createEmptyRoot`, which IS run.
 *  - in-place mutators (client `publishNewRegistryShard`, automergeMigrate's
 *    shard appends, repair scripts) — a mutation cannot lose fields it does
 *    not touch; forcing a rebuild there would be the disease, not the cure.
 */

import { describe, expect, it } from 'vitest'
import {
  Repo,
  type AutomergeUrl,
  type Chunk,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { ROOT_SHAPE_FIELDS } from './rootShape.js'
import { createEmptyRoot } from './automergeServer.js'
import { createSeedWorkspaceRoot } from './orgSeed/workspace.js'
import { generateSeedModel } from './orgSeed/generator.js'
import { createSparseDraftRoot } from './draft/sparse.js'
import { createPerformanceWorkspaceRoot } from './performanceSeed/workspace.js'
import { PerformanceSeedPlan } from './performanceSeed/generator.js'
import { TEST_PERFORMANCE_SEED_SCALE, type PerformanceTagSnapshot } from './performanceSeed/types.js'
import { forkRoot } from './forkRoot.js'
import { publishRotatedRoot, type DegenerateRootAudit } from './maintenance/degenerateRootRepair.js'
import { openBootstrapScope } from './bootstrapScope.js'

class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()

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
      .filter(({ key }) => keyPrefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) {
      if (keyPrefix.every((part, index) => key[index] === part)) this.entries.delete(text)
    }
  }
}

async function readRoot(repo: Repo, url: string): Promise<Record<string, unknown>> {
  const handle = await repo.find(url as AutomergeUrl)
  await handle.whenReady()
  return handle.doc() as Record<string, unknown>
}

/** Sentinel: this producer must NOT emit the field at all. */
const ABSENT = Symbol('expected absent')

/** Every one of the eight fields must be stated — a value/matcher or ABSENT. */
type RootFieldExpectations = Record<(typeof ROOT_SHAPE_FIELDS)[number], unknown>

/** Any automerge document url — for clones whose exact url the test cannot know. */
const anyDocUrl = () => expect.stringMatching(/^automerge:\w+$/)

/**
 * The assertion of this suite: FULL equality over the closed list.
 *  - a key outside ROOT_SHAPE_FIELDS fails (foreign key named);
 *  - a field expected ABSENT that is present fails (field named);
 *  - a field expected present that is missing or differs fails (field named)
 *    — so a producer LOSING a field fails by naming it.
 * The expectation record REQUIRES all eight fields, and the runtime guard
 * below backs the type up (test files are not typechecked by the server tsc).
 */
function expectExactRootShape(
  root: Record<string, unknown>,
  producer: string,
  expected: RootFieldExpectations,
): void {
  const foreign = Object.keys(root).filter((key) => !(ROOT_SHAPE_FIELDS as readonly string[]).includes(key))
  expect(foreign, `${producer} emitted keys outside ROOT_SHAPE_FIELDS`).toEqual([])
  for (const field of ROOT_SHAPE_FIELDS) {
    if (!(field in expected)) {
      throw new Error(`the ${producer} expectation does not state '${field}' — state a value or ABSENT`)
    }
    if (expected[field] === ABSENT) {
      expect(
        Object.prototype.hasOwnProperty.call(root, field),
        `${producer}: '${field}' expected ABSENT but was emitted`,
      ).toBe(false)
    } else {
      expect(root[field], `${producer}: '${field}' lost or changed`).toEqual(expected[field])
    }
  }
}

describe('every producer emits EXACTLY its expected root shape (all 8 fields stated)', () => {
  it('createEmptyRoot (workspace bootstrap)', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [] })
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    expectExactRootShape(await readRoot(repo, rootUrl), 'createEmptyRoot', {
      modelUrl: anyDocUrl(),
      modelMetaUrl: anyDocUrl(),
      shardUrls: [anyDocUrl()],
      registryWriteUrl: ABSENT,
      registrySummaryOnly: ABSENT,
      diagramCount: ABSENT,
      sparseDraftBaseVersionId: ABSENT,
      sparseDraftBaseRootUrl: ABSENT,
    })
  })

  it('createSeedWorkspaceRoot (organization demo seed)', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const { rootUrl } = await createSeedWorkspaceRoot(repo, generateSeedModel('rootshape-producers'))
    expectExactRootShape(await readRoot(repo, rootUrl), 'createSeedWorkspaceRoot', {
      modelUrl: anyDocUrl(),
      modelMetaUrl: anyDocUrl(),
      shardUrls: [anyDocUrl()],
      registryWriteUrl: ABSENT,
      registrySummaryOnly: ABSENT,
      diagramCount: ABSENT,
      sparseDraftBaseVersionId: ABSENT,
      sparseDraftBaseRootUrl: ABSENT,
    })
  })

  it('createSparseDraftRoot (bounded copy-on-write draft)', async () => {
    const repo = new Repo({ network: [] })
    const objectOverlay = repo.create({ objects: {} })
    const connectionOverlay = repo.create({ connections: {} })
    const meta = repo.create({
      staticBaseline: true,
      objectShardUrls: [objectOverlay.url],
      connectionShardUrls: [connectionOverlay.url],
      editsObjectShardUrl: objectOverlay.url,
      editsConnectionShardUrl: connectionOverlay.url,
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const parentRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [] as string[],
      registrySummaryOnly: true,
      diagramCount: 42,
    })
    await Promise.all([objectOverlay, connectionOverlay, meta, parentRoot].map((h) => h.whenReady()))

    const draft = await createSparseDraftRoot(repo, parentRoot.url, 'parent-v', openBootstrapScope({ landscapeId: 'L-test', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }))
    // The eight-field contract exercised for real: all optionals set, and the
    // control-plane pointers are the ones the result reports.
    expectExactRootShape(await readRoot(repo, draft.rootUrl), 'createSparseDraftRoot', {
      modelUrl: anyDocUrl(), // fresh legacy-compat monolith
      modelMetaUrl: draft.modelMetaUrl,
      shardUrls: [draft.registryUrl],
      registryWriteUrl: draft.registryUrl,
      registrySummaryOnly: true,
      diagramCount: 42, // inherited from the parent root
      sparseDraftBaseVersionId: 'parent-v',
      sparseDraftBaseRootUrl: parentRoot.url,
    })
  })

  it('createPerformanceWorkspaceRoot (benchmark seed)', async () => {
    const storage = new MemoryStorage()
    const plan = new PerformanceSeedPlan({
      scale: TEST_PERFORMANCE_SEED_SCALE,
      tags: Array.from({ length: 4 }, (_, index): PerformanceTagSnapshot => ({
        tagId: `tag-${index}`,
        value: `Tag ${index}`,
        color: '#336699',
        groupId: 'group-0',
        groupName: 'Group 0',
        catalogRevision: 1,
      })),
      teamIds: Array.from({ length: TEST_PERFORMANCE_SEED_SCALE.teams }, (_, index) => `team-${index}`),
      seed: 7,
    })
    const result = await createPerformanceWorkspaceRoot(storage, plan, {
      modelShardSize: 256,
      registryShardSize: 4,
      documentsPerRepo: 2,
    })
    const reader = new Repo({ storage, network: [] })
    // Removing `registrySummaryOnly: true` from the performanceSeed conversion
    // (workspace.ts) must fail here, naming the field.
    expectExactRootShape(await readRoot(reader, result.rootUrl), 'createPerformanceWorkspaceRoot', {
      modelUrl: result.modelUrl,
      modelMetaUrl: result.modelMetaUrl,
      shardUrls: result.registryShardUrls,
      registryWriteUrl: result.registryWriteUrl,
      registrySummaryOnly: true,
      diagramCount: plan.diagramCount,
      sparseDraftBaseVersionId: ABSENT,
      sparseDraftBaseRootUrl: ABSENT,
    })
    await reader.shutdown()
  }, 60_000)

  it('forkRoot (version fork of a summary root)', async () => {
    const repo = new Repo({ network: [] })
    const meta = repo.create({
      objectShardUrls: [], connectionShardUrls: [],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const writeHead = repo.create({ diagrams: {} })
    const srcRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [writeHead.url],
      registryWriteUrl: writeHead.url,
      registrySummaryOnly: true,
      diagramCount: 3,
      sparseDraftBaseVersionId: 'parent-v',
      sparseDraftBaseRootUrl: 'automerge:parent-root',
    })
    const { rootUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    const root = await readRoot(repo, rootUrl)
    const twinShard = (root.shardUrls as string[])[0]
    expect(twinShard, 'the twin owns a CLONE, never the source shard').not.toBe(writeHead.url)
    expectExactRootShape(root, 'forkRoot', {
      modelUrl: anyDocUrl(), // fresh empty monolith so pre-sharding readers boot
      modelMetaUrl: anyDocUrl(),
      shardUrls: [twinShard],
      registryWriteUrl: twinShard, // remapped to the twin's clone (url-keyed map)
      registrySummaryOnly: true,
      diagramCount: 3,
      sparseDraftBaseVersionId: 'parent-v',
      sparseDraftBaseRootUrl: 'automerge:parent-root',
    })
  })

  it('publishRotatedRoot (degenerate root rotation, static and ordinary)', async () => {
    const repo = new Repo({ network: [] })
    const audit = (over: Partial<DegenerateRootAudit>): DegenerateRootAudit => ({
      rootUrl: 'automerge:TZmtdi8zC33kWVUGNMqhBXS3A1o' as AutomergeUrl,
      modelUrl: '',
      modelMetaUrl: 'automerge:3Xb7FRNfh1SUKHLrgbJADtWN75zk' as AutomergeUrl,
      shardUrls: ['automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW' as AutomergeUrl],
      registryWriteUrl: 'automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW' as AutomergeUrl,
      issues: [],
      landscapeId: 'land',
      versionId: 'v',
      label: 'Main',
      mappedDocuments: 3,
      ...over,
    })
    const staticRotation = await publishRotatedRoot(repo, audit({ staticWorkspace: { diagramCount: 5 } }))
    // Non-sparse rotation keeps the audit's document urls; the STATIC row
    // carries the summary fields, without inventing base pointers.
    expectExactRootShape(await readRoot(repo, staticRotation.newRootUrl), 'publishRotatedRoot (static)', {
      modelUrl: '',
      modelMetaUrl: 'automerge:3Xb7FRNfh1SUKHLrgbJADtWN75zk',
      shardUrls: ['automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW'],
      registryWriteUrl: 'automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW',
      registrySummaryOnly: true,
      diagramCount: 5,
      sparseDraftBaseVersionId: ABSENT,
      sparseDraftBaseRootUrl: ABSENT,
    })
    const ordinaryRotation = await publishRotatedRoot(repo, audit({ registryWriteUrl: null }))
    expectExactRootShape(await readRoot(repo, ordinaryRotation.newRootUrl), 'publishRotatedRoot (ordinary)', {
      modelUrl: '',
      modelMetaUrl: 'automerge:3Xb7FRNfh1SUKHLrgbJADtWN75zk',
      shardUrls: ['automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW'],
      registryWriteUrl: ABSENT,
      registrySummaryOnly: ABSENT,
      diagramCount: ABSENT,
      sparseDraftBaseVersionId: ABSENT,
      sparseDraftBaseRootUrl: ABSENT,
    })
  })
})
