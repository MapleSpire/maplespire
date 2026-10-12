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

import { describe, it, expect } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { captureRootManifest } from './manifest.js'

/** Build a small sharded doc graph in an in-memory repo and return the root url. */
async function makeWorkspace(repo: Repo) {
  const objShard = repo.create<Record<string, unknown>>({ objects: { o1: { id: 'o1', name: 'A' } } })
  const connShard = repo.create<Record<string, unknown>>({ connections: {} })
  const meta = repo.create<Record<string, unknown>>({
    objectShardUrls: [objShard.url],
    connectionShardUrls: [connShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const diagram = repo.create<Record<string, unknown>>({ name: 'D', objectIds: [], connectionIds: [], groupIds: [] })
  const registry = repo.create<Record<string, unknown>>({ diagrams: { d1: { id: 'd1', docUrl: diagram.url } } })
  const root = repo.create<Record<string, unknown>>({ modelMetaUrl: meta.url, shardUrls: [registry.url] })
  await Promise.all([objShard, connShard, meta, diagram, registry, root].map((h) => h.whenReady()))
  return { root: root.url, meta: meta.url, objShard: objShard.url, connShard: connShard.url, registry: registry.url, diagram: diagram.url }
}

describe('captureRootManifest', () => {
  it('captures every workspace doc with non-empty heads', async () => {
    const repo = new Repo({})
    const urls = await makeWorkspace(repo)
    const manifest = await captureRootManifest(repo, urls.root)

    expect(manifest.schema).toBe(1)
    expect(manifest.rootUrl).toBe(urls.root)
    const byUrl = new Map(manifest.docs.map((d) => [d.url, d]))
    // Every doc in the graph is present.
    for (const u of Object.values(urls)) expect(byUrl.has(u)).toBe(true)
    // Each captured doc has at least one head (a created doc has history).
    for (const d of manifest.docs) expect(d.heads.length).toBeGreaterThan(0)
    // Kinds are labelled correctly.
    expect(byUrl.get(urls.root)?.kind).toBe('root')
    expect(byUrl.get(urls.meta)?.kind).toBe('modelMeta')
    expect(byUrl.get(urls.objShard)?.kind).toBe('objectShard')
    expect(byUrl.get(urls.registry)?.kind).toBe('registryShard')
    // The diagram entry carries its id.
    const dia = byUrl.get(urls.diagram)
    expect(dia?.kind).toBe('diagram')
    expect(dia?.diagramId).toBe('d1')
  })

  it('fails loud when a referenced doc cannot be resolved', async () => {
    const repo = new Repo({})
    // A root that points at a syntactically-valid but non-existent modelMeta url.
    const ghost = repo.create<Record<string, unknown>>({})
    const ghostUrl = ghost.url
    await ghost.whenReady()
    repo.delete(ghostUrl) // make it unresolvable
    const root = repo.create<Record<string, unknown>>({ modelMetaUrl: ghostUrl, shardUrls: [] })
    await root.whenReady()
    await expect(captureRootManifest(repo, root.url)).rejects.toThrow(/document unavailable/)
  })
})
