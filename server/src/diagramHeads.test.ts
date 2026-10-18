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

import { describe, it, expect, vi } from 'vitest'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { createEmptyRoot } from './automergeServer.js'
import {
  diagramDocHeads,
  registryHasDiagram,
  resolveDiagramDocUrlFromReadModel,
  resolveDiagramDocUrlFromRegistry,
} from './diagramHeads.js'
import { openBootstrapScope } from './bootstrapScope.js'

/** Read the id + doc url of the single starter diagram createEmptyRoot seeds. */
async function starterDiagram(repo: Repo, rootUrl: string): Promise<{ id: string; docUrl: string }> {
  const rootHandle = await repo.find(rootUrl as AutomergeUrl)
  await rootHandle.whenReady()
  const root = rootHandle.doc() as { shardUrls?: string[] }
  const shardHandle = await repo.find(root.shardUrls![0] as AutomergeUrl)
  await shardHandle.whenReady()
  const shard = shardHandle.doc() as { diagrams: Record<string, { docUrl: string }> }
  const id = Object.keys(shard.diagrams)[0]
  return { id, docUrl: shard.diagrams[id].docUrl }
}

describe('diagramDocHeads', () => {
  it('resolves a diagram doc url from the registry and returns its raw hex heads', async () => {
    const repo = new Repo({ network: [] })
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    const { docUrl } = await starterDiagram(repo, rootUrl)
    const heads = await diagramDocHeads(repo, docUrl)
    expect(Array.isArray(heads)).toBe(true)
    expect(heads!.length).toBeGreaterThan(0)
    // Raw hex change hashes (getHeads), NOT repo-tagged UrlHeads.
    expect(heads!.every((h) => typeof h === 'string' && /^[0-9a-f]+$/.test(h))).toBe(true)
  })

  it('moves the heads when the diagram doc changes (the freshness signal)', async () => {
    const repo = new Repo({ network: [] })
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    const { docUrl } = await starterDiagram(repo, rootUrl)

    const before = await diagramDocHeads(repo, docUrl)
    const handle = await repo.find(docUrl as AutomergeUrl)
    await handle.whenReady()
    handle.change((d: Record<string, unknown>) => {
      d.layouts = { obj1: { position: { x: 10, y: 20 }, size: { width: 100, height: 60 } } }
    })
    const after = await diagramDocHeads(repo, docUrl)

    expect(after).not.toEqual(before)
    // The old head is no longer in the frontier — a client at `before` is now BEHIND.
    expect(after!.some((h) => !before!.includes(h))).toBe(true)
  })

  it('returns null for an invalid diagram document URL', async () => {
    const repo = new Repo({ network: [] })
    expect(await diagramDocHeads(repo, 'not-an-automerge-url')).toBeNull()
  })

  it('opens only the resolved DiagramDoc even when it is behind 136 registry shards', async () => {
    const repo = new Repo({ network: [] })
    const diagram = repo.create({ layouts: {}, comments: {}, flows: {} })
    const registries = Array.from({ length: 150 }, (_, index) => repo.create({
      diagrams: index === 135 ? { 'perf-dg-027004': { docUrl: diagram.url } } : {},
    }))
    const root = repo.create({ shardUrls: registries.map((registry) => registry.url) })
    const find = vi.spyOn(repo, 'find')

    const heads = await diagramDocHeads(repo, diagram.url)

    expect(heads).toHaveLength(1)
    expect(find).toHaveBeenCalledTimes(1)
    // The url is what this test is about — one document opened, not 150 shards.
    // The signal is asserted alongside it because `repo.find` can hang forever
    // with no peer connected, and this runs inside a request handler.
    expect(find).toHaveBeenCalledWith(diagram.url, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    expect(repo.handles[root.documentId]).toBe(root)
  })

  it('resolves the DiagramDoc with one workspace-scoped read-model query', async () => {
    const repo = new Repo({ network: [] })
    const diagram = repo.create({ layouts: {}, comments: {}, flows: {} })
    const query = vi.fn().mockResolvedValue({ rows: [{ doc_url: diagram.url }] })

    await expect(resolveDiagramDocUrlFromReadModel(
      { query },
      { landscapeId: 'landscape', versionId: 'version' },
      'perf-dg-027004',
    )).resolves.toBe(diagram.url)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('read_model_static_documents')
    expect(query.mock.calls[0][0]).toContain("document.kind = 'diagram'")
    expect(query.mock.calls[0][1]).toEqual(['landscape', 'version', 'perf-dg-027004'])
  })

  it('uses the static manifest mapping when a sparse Draft row has no docUrl', async () => {
    const repo = new Repo({ network: [] })
    const diagram = repo.create({ layouts: {}, comments: {}, flows: {} })
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("NULLIF(diagram.data->>'docUrl', '')")
      expect(sql).toContain("'automerge:' || document.document_id")
      return { rows: [{ doc_url: diagram.url }] }
    })

    await expect(resolveDiagramDocUrlFromReadModel(
      { query },
      { landscapeId: 'landscape', versionId: 'draft' },
      'perf-dg-000000',
    )).resolves.toBe(diagram.url)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('keeps the registry walk only as the READ_MODEL=off legacy fallback', async () => {
    const repo = new Repo({ network: [] })
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    const { id, docUrl } = await starterDiagram(repo, rootUrl)
    await expect(resolveDiagramDocUrlFromRegistry(repo, rootUrl, id)).resolves.toBe(docUrl)
  })
})

describe('registryHasDiagram', () => {
  it('finds a diagram in whichever shard of the root lists it', async () => {
    const repo = new Repo({ network: [] })
    const shards = [repo.create({ diagrams: { a: { docUrl: '' } } }), repo.create({ diagrams: { b: { docUrl: '' } } })]
    const root = repo.create({ shardUrls: shards.map((shard) => shard.url) })
    await expect(registryHasDiagram(repo, root.url, 'b')).resolves.toEqual({ state: 'ok', present: true })
    await expect(registryHasDiagram(repo, root.url, 'missing')).resolves.toEqual({ state: 'ok', present: false })
  })

  it('sees a diagram added to the shard in place — what a merge does to live', async () => {
    const repo = new Repo({ network: [] })
    const shard = repo.create<{ diagrams: Record<string, { docUrl: string }> }>({ diagrams: {} })
    const root = repo.create({ shardUrls: [shard.url] })
    await expect(registryHasDiagram(repo, root.url, 'merged')).resolves.toEqual({ state: 'ok', present: false })
    shard.change((doc) => { doc.diagrams.merged = { docUrl: '' } })
    await expect(registryHasDiagram(repo, root.url, 'merged')).resolves.toEqual({ state: 'ok', present: true })
  })

  it('does not mistake an inherited property for a diagram', async () => {
    const repo = new Repo({ network: [] })
    const root = repo.create({ shardUrls: [repo.create({ diagrams: {} }).url] })
    await expect(registryHasDiagram(repo, root.url, 'toString')).resolves.toEqual({ state: 'ok', present: false })
  })

  it('refuses a registry above the shard ceiling instead of walking it', async () => {
    const repo = new Repo({ network: [] })
    const shards = Array.from({ length: 3 }, () => repo.create({ diagrams: {} }))
    const root = repo.create({ shardUrls: shards.map((shard) => shard.url) })
    await expect(registryHasDiagram(repo, root.url, 'x', 2)).resolves.toEqual({ state: 'too-large', shardCount: 3 })
  })

  it('says not-found for an unknown root rather than "absent"', async () => {
    const repo = new Repo({ network: [] })
    await expect(registryHasDiagram(repo, 'not-an-automerge-url', 'x')).resolves.toEqual({ state: 'not-found' })
  })
})
