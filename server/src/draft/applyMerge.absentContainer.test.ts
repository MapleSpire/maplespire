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

// A draft merge into documents that LACK the container it writes into. The old
// `d.f ?? (d.f = {})` shape wrote into the plain object the assignment
// returned, so the document kept an empty container and the merge reported
// success (see modelOps.absentContainer.test.ts for the measured shapes).

import { describe, expect, it } from 'vitest'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { materializeFullModel, type FullModel } from './materialize.js'
import { diffModels } from './merge.js'
import { applyChangeset } from './applyMerge.js'

const clone = (m: FullModel): FullModel => JSON.parse(JSON.stringify(m))

async function create(repo: Repo, value: Record<string, unknown>) {
  const handle = repo.create<Record<string, unknown>>(value)
  await handle.whenReady()
  return handle
}

async function merge(repo: Repo, rootUrl: string, edit: (theirs: FullModel) => void): Promise<void> {
  const ours = await materializeFullModel(repo, rootUrl)
  const theirs = clone(ours)
  edit(theirs)
  const diff = diffModels(ours, ours, theirs)
  expect(diff.conflicts).toHaveLength(0)
  expect(diff.changes.length).toBeGreaterThan(0)
  await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
}

const read = async (repo: Repo, url: string) =>
  (await repo.find<Record<string, unknown>>(url as AutomergeUrl)).doc()

describe('applyChangeset writes into a container the document does not have', () => {
  it('monolith: an absent model collection receives the upsert', async () => {
    const repo = new Repo({})
    const model = await create(repo, { objects: {}, connections: {} })
    const registry = await create(repo, { diagrams: {} })
    const root = await create(repo, { modelUrl: model.url, shardUrls: [registry.url] })

    await merge(repo, root.url, (theirs) => { theirs.groups.g1 = { id: 'g1', name: 'G' } })

    expect((await read(repo, model.url))?.groups).toEqual({ g1: { id: 'g1', name: 'G' } })
  })

  it('sharded: an absent inline collection on ModelMeta receives the upsert', async () => {
    const repo = new Repo({})
    const meta = await create(repo, { objectShardUrls: [], connectionShardUrls: [] })
    const registry = await create(repo, { diagrams: {} })
    const root = await create(repo, { modelMetaUrl: meta.url, shardUrls: [registry.url] })

    await merge(repo, root.url, (theirs) => { theirs.groups.g1 = { id: 'g1', name: 'G' } })

    expect((await read(repo, meta.url))?.groups).toEqual({ g1: { id: 'g1', name: 'G' } })
  })

  it('sharded: an absent decision-record tombstone list receives the delete', async () => {
    const repo = new Repo({})
    const adrShard = await create(repo, { decisionRecords: { r1: { id: 'r1', title: 'R' } } })
    const meta = await create(repo, {
      objectShardUrls: [], connectionShardUrls: [], decisionRecords: {},
      decisionRecordShardUrls: [adrShard.url],
    })
    const registry = await create(repo, { diagrams: {} })
    const root = await create(repo, { modelMetaUrl: meta.url, shardUrls: [registry.url] })

    await merge(repo, root.url, (theirs) => { delete theirs.decisionRecords.r1 })

    expect((await read(repo, meta.url))?.deletedDecisionRecordIds).toEqual(['r1'])
    expect((await materializeFullModel(repo, root.url)).decisionRecords.r1).toBeUndefined()
  })

  it('sharded: an absent object tombstone list receives the delete', async () => {
    const repo = new Repo({})
    const objects = await create(repo, { objects: { a: { id: 'a', type: 'system', name: 'A' } } })
    const meta = await create(repo, { objectShardUrls: [objects.url], connectionShardUrls: [] })
    const registry = await create(repo, { diagrams: {} })
    const root = await create(repo, { modelMetaUrl: meta.url, shardUrls: [registry.url] })

    await merge(repo, root.url, (theirs) => { delete theirs.objects.a })

    expect((await read(repo, meta.url))?.deletedObjectIds).toEqual(['a'])
    expect((await materializeFullModel(repo, root.url)).objects.a).toBeUndefined()
  })

  it('a DiagramDoc without layouts or flows receives both deltas', async () => {
    const repo = new Repo({})
    const model = await create(repo, { objects: {}, connections: {} })
    const diagram = await create(repo, { name: 'D', type: 'context', objectIds: [], connectionIds: [], groupIds: [] })
    const registry = await create(repo, {
      diagrams: { D: { id: 'D', name: 'D', type: 'context', docUrl: diagram.url, objectIds: [], connectionIds: [], groupIds: [] } },
    })
    const root = await create(repo, { modelUrl: model.url, shardUrls: [registry.url] })
    const layout = { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } }
    const flow = { id: 'f1', name: 'Flow', steps: [] }

    await merge(repo, root.url, (theirs) => {
      const detail = theirs.diagrams.D.detail!
      detail.layouts = { ...(detail.layouts ?? {}), a: layout }
      detail.flows = { ...(detail.flows ?? {}), f1: flow }
    })

    const after = await read(repo, diagram.url)
    expect(after?.layouts).toEqual({ a: layout })
    expect(after?.flows).toEqual({ f1: flow })
  })

  it('a root without shardUrls records the registry shard a created diagram lands in', async () => {
    const repo = new Repo({})
    const model = await create(repo, { objects: {}, connections: {} })
    const root = await create(repo, { modelUrl: model.url })
    const draftDoc = await create(repo, {
      name: 'New', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {}, comments: {}, checkpoints: [],
    })

    await merge(repo, root.url, (theirs) => {
      theirs.diagrams.N = {
        id: 'N',
        meta: { id: 'N', name: 'New', type: 'context', docUrl: draftDoc.url, objectIds: [], connectionIds: [], groupIds: [] },
        detail: { settings: { name: 'New', type: 'context' }, objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {} },
      }
    })

    expect((await read(repo, root.url))?.shardUrls).toHaveLength(1)
    expect((await materializeFullModel(repo, root.url)).diagrams.N).toBeDefined()
  })
})
