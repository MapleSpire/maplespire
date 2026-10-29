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
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { seedDemoIntoUnpublishedRoot } from './demoSeed.js'
import { DEMO_SEED } from './demoSeed.gen.js'
import { findReadyDocument } from './automergeRepoCompat.js'

type Doc = Record<string, unknown>

/** The documents `ensureRootDoc` creates before it seeds: root, empty model, one empty shard. */
function freshRoot(repo: Repo): { root: DocHandle<Doc>; model: DocHandle<Doc>; shard: DocHandle<Doc> } {
  const root = repo.create<Doc>({ shardUrls: [] })
  const model = repo.create<Doc>({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shard = repo.create<Doc>({ diagrams: {} })
  root.change((r) => {
    r.modelUrl = model.url
    r.shardUrls = [shard.url]
  })
  return { root, model, shard }
}

describe('seedDemoIntoUnpublishedRoot', () => {
  it('writes the whole demo: the model, a registry entry per diagram, and each entry resolves to its DiagramDoc', async () => {
    const repo = new Repo({ network: [] })
    const { root, model, shard } = freshRoot(repo)

    await expect(seedDemoIntoUnpublishedRoot(repo, root, model)).resolves.toBe(true)

    expect(model.doc()).toEqual(DEMO_SEED.model)
    const entries = (shard.doc()?.diagrams ?? {}) as Record<string, Doc & { docUrl: string }>
    expect(Object.keys(entries).sort()).toEqual(DEMO_SEED.diagrams.map((d) => d.meta.id).sort())
    for (const { meta, doc } of DEMO_SEED.diagrams) {
      const entry = entries[meta.id]
      expect(entry).toEqual({ ...meta, docUrl: expect.stringMatching(/^automerge:\w+$/) })
      // The pointer is never dangling: the document it names exists, with the demo's content.
      const diagram = await findReadyDocument<Doc>(repo, entry.docUrl)
      expect(diagram.doc()).toEqual(doc)
    }
  })

  it('leaves a workspace whose model already holds objects untouched (a legacy migration wins)', async () => {
    const repo = new Repo({ network: [] })
    const { root, model, shard } = freshRoot(repo)
    model.change((m) => { (m.objects as Doc).legacy = { id: 'legacy', name: 'Kept' } })

    await expect(seedDemoIntoUnpublishedRoot(repo, root, model)).resolves.toBe(false)

    expect(Object.keys(model.doc()?.objects as Doc)).toEqual(['legacy'])
    expect(shard.doc()?.diagrams).toEqual({})
  })

  it('leaves a workspace whose registry already lists a diagram untouched, even with an empty model', async () => {
    const repo = new Repo({ network: [] })
    const { root, model, shard } = freshRoot(repo)
    shard.change((s) => { (s.diagrams as Doc).existing = { id: 'existing', name: 'Kept' } })

    await expect(seedDemoIntoUnpublishedRoot(repo, root, model)).resolves.toBe(false)

    expect(model.doc()?.objects).toEqual({})
    expect(Object.keys(shard.doc()?.diagrams as Doc)).toEqual(['existing'])
  })
})
