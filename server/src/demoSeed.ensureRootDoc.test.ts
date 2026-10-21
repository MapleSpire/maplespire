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
  type Chunk,
  type DocHandle,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { ensureRootDoc, type RootBootstrapDeps } from './automergeServer.js'
import { findReadyDocument } from './automergeRepoCompat.js'
import { DEMO_SEED } from './demoSeed.gen.js'

// The property the server seed exists for: when `root_url` is published, every
// document the root reaches is ALREADY in storage, with the demo's content. A
// client can only find the root through `root_url`, so this is "no client can
// ever observe a partial demo". The witness reads STORAGE through a second
// Repo — not the bootstrapping Repo's memory, which holds everything whether
// or not it was flushed.

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

type Doc = Record<string, unknown>

/** Everything a cold client would load, read from STORAGE only. Throws when a
 *  document the root reaches is not in storage. */
async function readPublishedWorkspace(storage: MemoryStorage, rootUrl: string) {
  const reader = new Repo({ network: [], storage })
  const root = (await findReadyDocument<Doc>(reader, rootUrl)).doc() as { modelUrl: string; shardUrls: string[] }
  const model = (await findReadyDocument<Doc>(reader, root.modelUrl)).doc() as Record<string, Doc>
  const entries: Array<Doc & { docUrl: string }> = []
  for (const url of root.shardUrls) {
    const shard = (await findReadyDocument<Doc>(reader, url)).doc() as { diagrams: Record<string, Doc & { docUrl: string }> }
    entries.push(...Object.values(shard.diagrams))
  }
  const diagramDocs = new Map<string, Doc>()
  for (const entry of entries) {
    diagramDocs.set(String(entry.id), (await findReadyDocument<Doc>(reader, entry.docUrl)).doc() as Doc)
  }
  return { model, entries, diagramDocs }
}

function deps(storage: MemoryStorage, overrides: Partial<RootBootstrapDeps> = {}) {
  const meta = new Map<string, string>()
  const published: Array<Awaited<ReturnType<typeof readPublishedWorkspace>>> = []
  const value: RootBootstrapDeps = {
    getMeta: async (key) => meta.get(key) ?? null,
    setMeta: async (key, url) => {
      // Read storage AT THE MOMENT of publication, before the write lands.
      if (key === 'root_url') published.push(await readPublishedWorkspace(storage, url))
      meta.set(key, url)
    },
    migrate: async () => false,
    seedDemo: true,
    ...overrides,
  }
  return { deps: value, meta, published }
}

describe('ensureRootDoc on a fresh database', () => {
  it('publishes root_url only once storage already holds the whole demo it reaches', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ network: [], storage })
    const { deps: d, meta, published } = deps(storage)

    const rootUrl = await ensureRootDoc(repo, d)

    expect(meta.get('root_url')).toBe(rootUrl)
    expect(published).toHaveLength(1)
    const [seen] = published
    expect(seen.model).toEqual(DEMO_SEED.model)
    expect(seen.entries.map((e) => e.id).sort()).toEqual(DEMO_SEED.diagrams.map((d) => d.meta.id).sort())
    for (const { meta: diagramMeta, doc } of DEMO_SEED.diagrams) {
      expect(seen.diagramDocs.get(diagramMeta.id)).toEqual(doc)
    }
  })

  it('does not seed over a legacy migration (its collections would be replaced)', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ network: [], storage })
    const { deps: d, published } = deps(storage, {
      migrate: async (_repo, _root, model: DocHandle<Doc>) => {
        // A legacy table with a domain and nothing else: no object, no diagram.
        model.change((m) => { (m.domains as Doc).legacy = { id: 'legacy', name: 'Kept' } })
        return true
      },
    })

    await ensureRootDoc(repo, d)

    const [seen] = published
    expect(seen.model.domains).toEqual({ legacy: { id: 'legacy', name: 'Kept' } })
    expect(seen.model.objects).toEqual({})
    expect(seen.entries).toEqual([])
  })

  it('with DEMO_SEED off (the cold server) publishes an EMPTY root', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ network: [], storage })
    const { deps: d, published } = deps(storage, { seedDemo: false })

    await ensureRootDoc(repo, d)

    const [seen] = published
    expect(seen.model.objects).toEqual({})
    expect(seen.entries).toEqual([])
  })

  it('returns an existing root_url and creates nothing', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ network: [], storage })
    const { deps: d, meta, published } = deps(storage)
    meta.set('root_url', 'automerge:existing')

    await expect(ensureRootDoc(repo, d)).resolves.toBe('automerge:existing')
    expect(published).toHaveLength(0)
    expect(Object.keys(repo.handles)).toHaveLength(0)
  })
})
