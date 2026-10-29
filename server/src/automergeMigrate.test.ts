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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { findReadyDocument } from './automergeRepoCompat.js'

// The legacy `entities` migration had no test before its writer was extracted
// for the server demo seed (writeWorkspaceContent). These pin what it writes,
// field by field, and the shard overflow it shares with the seed.

const rows: Array<{ id: string; type: string; data: Record<string, unknown> }> = []
vi.mock('./db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows })) },
}))

type Doc = Record<string, unknown>

function freshRoot(repo: Repo): { root: DocHandle<Doc>; model: DocHandle<Doc> } {
  const root = repo.create<Doc>({ shardUrls: [] })
  const model = repo.create<Doc>({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shard = repo.create<Doc>({ diagrams: {} })
  root.change((r) => {
    r.modelUrl = model.url
    r.shardUrls = [shard.url]
  })
  return { root, model }
}

async function registry(repo: Repo, root: DocHandle<Doc>): Promise<Array<Record<string, Doc & { docUrl: string }>>> {
  const urls = (root.doc() as { shardUrls: string[] }).shardUrls
  const out = []
  for (const url of urls) out.push(((await findReadyDocument<Doc>(repo, url)).doc() as { diagrams: Record<string, Doc & { docUrl: string }> }).diagrams)
  return out
}

afterEach(() => {
  rows.length = 0
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('migrateEntitiesIntoRoot', () => {
  it('returns false and writes nothing when the legacy table is empty', async () => {
    const { migrateEntitiesIntoRoot } = await import('./automergeMigrate.js')
    const repo = new Repo({ network: [] })
    const { root, model } = freshRoot(repo)

    await expect(migrateEntitiesIntoRoot(repo, root, model)).resolves.toBe(false)
    expect((model.doc() as Doc).objects).toEqual({})
    expect(await registry(repo, root)).toEqual([{}])
  })

  it('folds every legacy family into the model, one DiagramDoc per diagram, and a registry entry each', async () => {
    rows.push(
      { id: 'o1', type: 'object', data: { name: 'API' } },
      { id: 'c1', type: 'connection', data: { fromId: 'o1', toId: 'o1' } },
      { id: 'g1', type: 'group', data: { name: 'Group' } },
      { id: 'd1', type: 'domain', data: { name: 'Domain' } },
      { id: 'adr1', type: 'decisionRecord', data: { title: 'ADR' } },
      { id: 't1', type: 'tag', data: { name: 'discarded' } },
      { id: 'dg1', type: 'diagram', data: { name: 'Context', type: 'context', objectIds: ['o1'], connectionIds: ['c1'], groupIds: ['g1'], layouts: { o1: { x: 1, y: 2 } } } },
      { id: 'dg2', type: 'diagram', data: { name: 'Containers', type: 'container', parentObjectId: 'o1', objectIds: [], connectionIds: [], groupIds: [] } },
      { id: 'cm1', type: 'comment', data: { diagramId: 'dg1', text: 'on dg1' } },
      { id: 'cm2', type: 'comment', data: { diagramId: 'dg2', text: 'on dg2' } },
      { id: 'f1', type: 'flow', data: { diagramId: 'dg2', name: 'Flow' } },
    )
    const { migrateEntitiesIntoRoot } = await import('./automergeMigrate.js')
    const repo = new Repo({ network: [] })
    const { root, model } = freshRoot(repo)

    await expect(migrateEntitiesIntoRoot(repo, root, model)).resolves.toBe(true)

    expect(model.doc()).toEqual({
      objects: { o1: { id: 'o1', name: 'API' } },
      connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o1' } },
      groups: { g1: { id: 'g1', name: 'Group' } },
      domains: { d1: { id: 'd1', name: 'Domain' } },
      tagSnapshots: {},
      decisionRecords: { adr1: { id: 'adr1', title: 'ADR' } },
    })
    const [entries] = await registry(repo, root)
    expect(entries.dg1).toEqual({
      id: 'dg1', name: 'Context', type: 'context', docUrl: expect.stringMatching(/^automerge:/),
      objectIds: ['o1'], connectionIds: ['c1'], groupIds: ['g1'],
    })
    expect(entries.dg2).toEqual({
      id: 'dg2', name: 'Containers', type: 'container', docUrl: expect.stringMatching(/^automerge:/),
      parentObjectId: 'o1', objectIds: [], connectionIds: [], groupIds: [],
    })
    expect((await findReadyDocument<Doc>(repo, entries.dg1.docUrl)).doc()).toEqual({
      name: 'Context', type: 'context', objectIds: ['o1'], connectionIds: ['c1'], groupIds: ['g1'],
      layouts: { o1: { x: 1, y: 2 } },
      comments: { cm1: { id: 'cm1', diagramId: 'dg1', text: 'on dg1' } },
      flows: {},
      checkpoints: [],
    })
    expect((await findReadyDocument<Doc>(repo, entries.dg2.docUrl)).doc()).toEqual({
      name: 'Containers', type: 'container', parentObjectId: 'o1', objectIds: [], connectionIds: [], groupIds: [],
      layouts: {},
      comments: { cm2: { id: 'cm2', diagramId: 'dg2', text: 'on dg2' } },
      flows: { f1: { id: 'f1', diagramId: 'dg2', name: 'Flow' } },
      checkpoints: [],
    })
  })
})

describe('writeWorkspaceContent shard overflow', () => {
  it('fills the last shard to AM_SHARD_SIZE and appends a new shard to the root for the rest', async () => {
    vi.stubEnv('AM_SHARD_SIZE', '2')
    const { writeWorkspaceContent } = await import('./automergeMigrate.js')
    const repo = new Repo({ network: [] })
    const { root, model } = freshRoot(repo)
    const diagram = (id: string) => ({
      meta: { id, name: id, type: 'context', objectIds: [], connectionIds: [], groupIds: [] },
      doc: { name: id },
    })

    await writeWorkspaceContent(repo, root, model, { objects: {} }, [diagram('a'), diagram('b'), diagram('c')])

    const shards = await registry(repo, root)
    expect(shards.map((s) => Object.keys(s).sort())).toEqual([['a', 'b'], ['c']])
  })
})
