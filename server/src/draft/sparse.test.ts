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

import { describe, expect, it, vi } from 'vitest'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { diffModels, resolveConflicts } from './merge.js'
import {
  canCreateSparseDraft,
  captureSparseDraftEntityBases,
  createSparseDraftRoot,
  materializeSparseDraftModels,
} from './sparse.js'
import { publishRotatedRoot } from '../maintenance/degenerateRootRepair.js'
import { openBootstrapScope } from '../bootstrapScope.js'

const object = (id: string, name: string) => ({
  id,
  name,
  type: 'component',
  scope: 'internal',
  status: 'live',
  tagAssignments: {},
  tagOrder: [],
  properties: {},
})

async function staticParent(repo: Repo, diagramCount = 30000) {
  const objectOverlay = repo.create({ objects: {} })
  const connectionOverlay = repo.create({ connections: {} })
  const meta = repo.create({
    staticBaseline: true,
    objectShardUrls: [objectOverlay.url],
    connectionShardUrls: [connectionOverlay.url],
    editsObjectShardUrl: objectOverlay.url,
    editsConnectionShardUrl: connectionOverlay.url,
    groups: {},
    domains: { default: { id: 'default', name: 'Default' } },
    tagSnapshots: {},
    decisionRecords: {},
  })
  // Intentionally referenced but unavailable. A bounded fork must never
  // resolve the baseline registries or any of their DiagramDocs.
  const root = repo.create({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: Array.from({ length: 150 }, (_, i) => `automerge:unavailable-registry-${i}`),
    registrySummaryOnly: true,
    diagramCount,
  })
  await Promise.all([objectOverlay, connectionOverlay, meta, root].map((handle) => handle.whenReady()))
  return { root }
}

describe('sparse static drafts', () => {
  it('creates an O(1) copy-on-write root without resolving 30k diagram documents', async () => {
    const repo = new Repo({ network: [] })
    const parent = await staticParent(repo)

    await expect(canCreateSparseDraft(repo, parent.root.url)).resolves.toBe(true)
    const draft = await createSparseDraftRoot(repo, parent.root.url, 'parent-v', openBootstrapScope({ landscapeId: 'L-test', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }))

    expect(draft.allowedDocuments).toHaveLength(5)
    expect(draft.manifest).toMatchObject({
      schema: 2,
      mode: 'sparse-static',
      parentVersionId: 'parent-v',
      diagramBases: {},
    })
    const rootHandle = await repo.find<Record<string, unknown>>(draft.rootUrl as AutomergeUrl)
    await rootHandle.whenReady()
    const root = rootHandle.doc()!
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount).toBe(30000)
    expect(root.shardUrls).toEqual([draft.registryUrl])
    expect(root.registryWriteUrl).toBe(draft.registryUrl)

    const registryHandle = await repo.find<{ diagrams: Record<string, unknown> }>(draft.registryUrl as AutomergeUrl)
    await registryHandle.whenReady()
    expect(registryHandle.doc()?.diagrams).toEqual({})
  })

  it('captures the old parent value for every active sparse child before mutation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    await captureSparseDraftEntityBases(
      { query } as never,
      { landscapeId: 'land', versionId: 'live' },
      'object',
      ['o1', 'o1', 'o2'],
    )
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('draft_sparse_base_entities')
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN ro_objects')
    expect(query.mock.calls[0][1]).toEqual(['land', 'live', 'object', ['o1', 'o2']])
  })

  it('reconstructs an update/update conflict from only the touched overlay entity', async () => {
    const repo = new Repo({ network: [] })
    const parent = await staticParent(repo)
    const draft = await createSparseDraftRoot(repo, parent.root.url, 'parent-v', openBootstrapScope({ landscapeId: 'L-test', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }))
    const overlay = await repo.find<{ objects: Record<string, ReturnType<typeof object>> }>(draft.objectOverlayUrl as AutomergeUrl)
    await overlay.whenReady()
    overlay.change((doc) => { doc.objects.o1 = object('o1', 'Mine') })

    const baseValue = object('o1', 'At fork')
    const liveValue = object('o1', 'Changed live')
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM ro_objects')) return { rows: [{ id: 'o1', data: liveValue }] }
      if (sql.includes('FROM draft_sparse_base_entities') && params[2] === 'object') {
        return { rows: [{ entity_id: 'o1', existed: true, data: baseValue }] }
      }
      return { rows: [] }
    })
    const models = await materializeSparseDraftModels(
      repo,
      { query } as never,
      'land',
      'draft-v',
      draft.rootUrl,
      'parent-v',
      draft.manifest,
    )
    const diff = diffModels(models.base, models.ours, models.theirs)
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'object', id: 'o1', kind: 'updated' }),
    ]))
    expect(diff.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'object', id: 'o1', kind: 'update/update' }),
    ]))
    expect(resolveConflicts(diff, {}).blocked).toHaveLength(1)
    expect(resolveConflicts(diff, { 'object:o1:': 'draft' }).blocked).toBeNull()
    expect(resolveConflicts(diff, { 'object:o1:': 'live' }).appliedChanges).toHaveLength(0)
  })

  it('keeps draft change materialization valid when a stale peer rewrites the retired root', async () => {
    const repo = new Repo({ network: [] })
    const parent = await staticParent(repo)
    const draft = await createSparseDraftRoot(repo, parent.root.url, 'parent-v', openBootstrapScope({ landscapeId: 'L-test', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }))
    const retiredRoot = await repo.find<Record<string, unknown>>(draft.rootUrl as AutomergeUrl)
    await retiredRoot.whenReady()
    const retired = retiredRoot.doc()!
    const retiredRegistryUrl = (retired.shardUrls as string[])[0] as AutomergeUrl

    const rotation = await publishRotatedRoot(repo, {
      landscapeId: 'land',
      versionId: 'draft-v',
      label: 'Regression draft',
      rootUrl: draft.rootUrl as AutomergeUrl,
      modelUrl: retired.modelUrl as string,
      modelMetaUrl: retired.modelMetaUrl as AutomergeUrl,
      shardUrls: [retiredRegistryUrl],
      registryWriteUrl: retiredRegistryUrl,
      issues: [],
      mappedDocuments: 5,
      sparseDraft: {
        parentVersionId: 'parent-v',
        parentRootUrl: parent.root.url,
        diagramCount: 30000,
      },
    })
    expect(rotation.newRootUrl).not.toBe(draft.rootUrl)

    // This is the production regression: an open browser still carries the
    // old empty heads and publishes them after the maintenance window.
    retiredRoot.change((doc) => {
      delete doc.modelUrl
      delete doc.modelMetaUrl
      delete doc.shardUrls
    })
    await repo.flush([retiredRoot.documentId])

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const models = await materializeSparseDraftModels(
      repo,
      { query } as never,
      'land',
      'draft-v',
      rotation.newRootUrl,
      'parent-v',
      draft.manifest,
    )
    expect(diffModels(models.base, models.ours, models.theirs)).toMatchObject({
      changes: [],
      conflicts: [],
    })

    const canonical = await repo.find<Record<string, unknown>>(rotation.newRootUrl)
    await canonical.whenReady()
    expect(canonical.doc()).toMatchObject({
      registrySummaryOnly: true,
      diagramCount: 30000,
      sparseDraftBaseVersionId: 'parent-v',
    })
    expect(canonical.doc()?.modelMetaUrl).not.toBe(draft.modelMetaUrl)
    expect((canonical.doc()?.shardUrls as string[])[0]).not.toBe(retiredRegistryUrl)
    expect(canonical.doc()?.registryWriteUrl).toBe((canonical.doc()?.shardUrls as string[])[0])
  })
})
