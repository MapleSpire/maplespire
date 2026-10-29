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

// Every write here starts from a document that LACKS the container it writes
// into. `const c = d.f ?? (d.f = {}); c.k = v` and `(d.f ??= []).push(v)` hand
// back the plain `{}`/`[]` the assignment was given, not the Automerge proxy
// the document now holds, so the write lands on a detached object and the
// document keeps an EMPTY container. Measured with @automerge/automerge 3.2.6:
// `{"a":{},"b":{},"c":[]}` for those shapes, `{"e":{"k":1}}` for assign-then-reread.
// Documents written by older code or partial imports do lack these fields.

import { afterEach, describe, expect, it } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import {
  createDiagramDoc,
  deleteModelEntities,
  mutateComment,
  updateDiagramDoc,
  upsertInlineEntities,
  upsertModelEntities,
} from './modelOps.js'

const workspace = { landscapeId: 'L-absent', versionId: 'V-absent' }
const repos: Repo[] = []

function newRepo(): Repo {
  const repo = new Repo({ network: [] })
  repos.push(repo)
  return repo
}

async function ready<T>(handle: DocHandle<T>): Promise<DocHandle<T>> {
  await handle.whenReady()
  return handle
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.shutdown()))
})

describe('modelOps writes into a container the document does not have', () => {
  it('upsertModelEntities (unsharded) persists into an absent collection', async () => {
    const repo = newRepo()
    const model = await ready(repo.create<Record<string, unknown>>({ marker: 1 }))
    const root = await ready(repo.create({ modelUrl: model.url, shardUrls: [] as string[] }))

    await upsertModelEntities(repo, root.url, 'objects', { o1: { id: 'o1', name: 'One' } }, workspace)

    expect(model.doc()?.objects).toEqual({ o1: { id: 'o1', name: 'One' } })
  })

  it('deleteModelEntities (sharded) persists the tombstone into an absent list', async () => {
    const repo = newRepo()
    const meta = await ready(repo.create<Record<string, unknown>>({ marker: 1 }))
    const root = await ready(repo.create({ modelMetaUrl: meta.url, shardUrls: [] as string[] }))

    await deleteModelEntities(repo, root.url, 'objects', ['o1'])

    expect(meta.doc()?.deletedObjectIds).toEqual(['o1'])
  })

  it('upsertInlineEntities persists into an absent inline collection', async () => {
    const repo = newRepo()
    const meta = await ready(repo.create<Record<string, unknown>>({ marker: 1 }))
    const root = await ready(repo.create({ modelMetaUrl: meta.url, shardUrls: [] as string[] }))

    await upsertInlineEntities(repo, root.url, 'groups', { g1: { id: 'g1', name: 'G' } })

    expect(meta.doc()?.groups).toEqual({ g1: { id: 'g1', name: 'G' } })
  })

  it('a root without shardUrls records the registry shard it creates', async () => {
    const repo = newRepo()
    const root = await ready(repo.create<Record<string, unknown>>({ modelUrl: '' }))

    const id = await createDiagramDoc(repo, root.url, { name: 'D', type: 'context' }, workspace)

    const shardUrls = root.doc()?.shardUrls as string[] | undefined
    expect(shardUrls).toHaveLength(1)
    const shard = await repo.find<{ diagrams: Record<string, unknown> }>(shardUrls![0] as never)
    expect(shard.doc()?.diagrams[id]).toBeDefined()
  })

  it('updateDiagramDoc persists ids and layouts into absent arrays and map', async () => {
    const repo = newRepo()
    const registry = await ready(repo.create({ diagrams: {} as Record<string, unknown> }))
    const root = await ready(repo.create({ modelUrl: '', shardUrls: [registry.url] }))
    const id = await createDiagramDoc(repo, root.url, { name: 'D', type: 'context' }, workspace)
    const docUrl = (registry.doc()!.diagrams[id] as { docUrl: string }).docUrl
    const diagram = await repo.find<Record<string, unknown>>(docUrl as never)
    diagram.change((d) => {
      delete d.objectIds
      delete d.connectionIds
      delete d.groupIds
      delete d.layouts
    })

    const layout = { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } }
    expect(await updateDiagramDoc(repo, root.url, id, {
      addObjectIds: ['o1'],
      addConnectionIds: ['c1'],
      addGroupIds: ['g1'],
      layoutUpserts: { o1: layout },
    })).toBe(true)

    expect(diagram.doc()).toMatchObject({
      objectIds: ['o1'],
      connectionIds: ['c1'],
      groupIds: ['g1'],
      layouts: { o1: layout },
    })
  })

  it('mutateComment persists a reply on a comment that has no replies list', async () => {
    const repo = newRepo()
    const registry = await ready(repo.create({ diagrams: {} as Record<string, unknown> }))
    const root = await ready(repo.create({ modelUrl: '', shardUrls: [registry.url] }))
    const id = await createDiagramDoc(repo, root.url, { name: 'D', type: 'context' }, workspace)
    const docUrl = (registry.doc()!.diagrams[id] as { docUrl: string }).docUrl
    const diagram = await repo.find<{ comments: Record<string, Record<string, unknown>> }>(docUrl as never)
    diagram.change((d) => { d.comments.k1 = { id: 'k1', text: 'first' } })

    expect(await mutateComment(repo, root.url, id, 'k1', { reply: { text: 'answer', author: 'A' } })).toBe(true)

    expect(diagram.doc()?.comments.k1.replies).toEqual([
      expect.objectContaining({ text: 'answer', author: 'A' }),
    ])
  })
})
