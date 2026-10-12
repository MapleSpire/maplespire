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

import { Repo } from '@automerge/automerge-repo'
import { describe, expect, it, vi } from 'vitest'
import {
  evictWorkspaceDocumentCache,
  prewarmWorkspaceFailoverDocuments,
} from './repoFreshness.js'

describe('sync-cell workspace repo freshness', () => {
  it('evicts mapped mutable handles and leaves the transport root resident', async () => {
    const repo = new Repo({})
    const root = repo.create({ root: true })
    const meta = repo.create({ groups: {} })
    const overlay = repo.create({ objects: {} })
    await Promise.all([root.whenReady(), meta.whenReady(), overlay.whenReady()])
    const metaSave = vi.fn()
    const overlaySave = vi.fn()
    meta.on('heads-changed', metaSave)
    overlay.on('heads-changed', overlaySave)
    const query = vi.fn(async () => ({
      rows: [{ document_id: meta.documentId }, { document_id: overlay.documentId }],
      rowCount: 2,
    }))

    await expect(evictWorkspaceDocumentCache(
      repo, { query } as never, { landscapeId: 'land', versionId: 'version' },
    )).resolves.toBe(2)
    expect(repo.handles[root.documentId]).toBeDefined()
    expect(repo.handles[meta.documentId]).toBeUndefined()
    expect(repo.handles[overlay.documentId]).toBeUndefined()
    expect(metaSave).not.toHaveBeenCalled()
    expect(overlaySave).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('regexp_replace(version.root_url'), [
      'land', 'version',
      expect.arrayContaining([root.documentId, meta.documentId, overlay.documentId]),
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ANY($3::text[])'), expect.any(Array))
  })

  /**
   * Regression: this is the SECOND eviction path in the process.
   *
   * `AutomergeResidencyLeases.evict()` notifies its before-evict listeners, and
   * that notification is how `WorkspaceDocIndex.trackResidency` learns that a
   * control document's watcher has just been orphaned. Partition failover
   * evicts through THIS function instead,
   * which calls `repo.removeFromCache` directly, so the index never hears about
   * it: `staleWorkspaces` stays empty, and the `routeBackfills` memo still holds
   * a complete walk, so neither recovery path arms. The documents dropped here
   * are exactly ModelMeta and the registry shards (the SQL excludes the root) —
   * precisely the ones `walk()` marks as control documents.
   */
  it('notifies residency before-evict listeners so the doc index learns the watcher is orphaned', async () => {
    const repo = new Repo({})
    const root = repo.create({ root: true })
    const meta = repo.create({ groups: {} })
    await Promise.all([root.whenReady(), meta.whenReady()])
    const query = vi.fn(async () => ({ rows: [{ document_id: meta.documentId }], rowCount: 1 }))
    const notified: string[] = []
    const forgotten: string[] = []
    const residency = {
      notifyBeforeEvict: (id: string) => { notified.push(id) },
      forgetAmbientListener: (id: string) => { forgotten.push(id) },
    }

    await expect(evictWorkspaceDocumentCache(
      repo, { query } as never, { landscapeId: 'land', versionId: 'version' }, residency as never,
    )).resolves.toBe(1)

    expect(notified).toEqual([String(meta.documentId)])
    // This path never runs the census, so it must also drop the sweep's ambient
    // marker — left behind it would suppress one real orphan later.
    expect(forgotten).toEqual([String(meta.documentId)])
  })

  it('detaches an unresolved standby query without waiting for its Repo timeout', async () => {
    const sourceRepo = new Repo({})
    const source = sourceRepo.create({ value: 'exists elsewhere' })
    await source.whenReady()
    const repo = new Repo({})
    const missing = repo.find(source.url)
    // automerge-repo 2.6 can conclude unavailability in the same microtask
    // turn, so attach the rejection handler immediately.
    void missing.catch(() => undefined)
    const handle = repo.handles[source.documentId]
    expect(handle).toBeDefined()
    const query = vi.fn(async () => ({
      rows: [{ document_id: source.documentId }],
      rowCount: 1,
    }))

    await expect(evictWorkspaceDocumentCache(
      repo, { query } as never, { landscapeId: 'land', versionId: 'version' },
    )).resolves.toBe(1)
    expect(repo.handles[source.documentId]).toBeUndefined()
  })

  it('does not scan durable workspace mappings when the repo cache is empty', async () => {
    const repo = new Repo({})
    const query = vi.fn()

    await expect(evictWorkspaceDocumentCache(
      repo, { query } as never, { landscapeId: 'large-land', versionId: 'large-version' },
    )).resolves.toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('prewarms the root, ModelMeta and only the two current write heads before admission', async () => {
    const repo = new Repo({})
    const objectHead = repo.create({ objects: { current: { id: 'current' } } })
    const connectionHead = repo.create({ connections: { current: { id: 'current' } } })
    const retiredHead = repo.create({ objects: { retired: { id: 'retired' } } })
    const meta = repo.create({
      editsObjectShardUrl: objectHead.url,
      editsObjectShardUrls: [retiredHead.url, objectHead.url],
      editsConnectionShardUrl: connectionHead.url,
      editsConnectionShardUrls: [connectionHead.url],
    })
    const root = repo.create({ modelUrl: '', modelMetaUrl: meta.url, registrySummaryOnly: true })
    await Promise.all([
      root.whenReady(), meta.whenReady(), objectHead.whenReady(),
      connectionHead.whenReady(), retiredHead.whenReady(),
    ])
    const mapped = new Set([meta.documentId, objectHead.documentId, connectionHead.documentId])
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('JOIN read_model_static_workspaces')) {
        return { rows: [{ root_url: root.url }], rowCount: 1 }
      }
      const candidates = params?.[2] as string[]
      const rows = candidates.filter((documentId) => mapped.has(documentId))
        .map((document_id) => ({ document_id }))
      return { rows, rowCount: rows.length }
    })
    const documents = new Map([
      [root.url, root.doc()],
      [meta.url, meta.doc()],
      [objectHead.url, objectHead.doc()],
      [connectionHead.url, connectionHead.doc()],
      [retiredHead.url, retiredHead.doc()],
    ])
    const resolve = vi.fn(async (url: string) => documents.get(url))

    await expect(prewarmWorkspaceFailoverDocuments(
      repo,
      { query } as never,
      { landscapeId: 'land', versionId: 'version' },
      resolve,
    )).resolves.toEqual({
      rootUrl: root.url,
      documentIds: [root.documentId, meta.documentId, objectHead.documentId, connectionHead.documentId],
      modelKind: 'static-sharded',
    })
    expect(resolve.mock.calls.map(([url]) => url)).toEqual([
      root.url, meta.url, objectHead.url, connectionHead.url,
    ])
    expect(resolve).not.toHaveBeenCalledWith(retiredHead.url)
  })

  it('fails closed before resolving a cross-workspace write-head pointer', async () => {
    const repo = new Repo({})
    const foreignHead = repo.create({ objects: { secret: { id: 'secret' } } })
    const meta = repo.create({ editsObjectShardUrl: foreignHead.url })
    const root = repo.create({ modelMetaUrl: meta.url, registrySummaryOnly: true })
    await Promise.all([root.whenReady(), meta.whenReady(), foreignHead.whenReady()])
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('JOIN read_model_static_workspaces')) {
        return { rows: [{ root_url: root.url }], rowCount: 1 }
      }
      const candidates = params?.[2] as string[]
      const rows = candidates.filter((documentId) => documentId === meta.documentId)
        .map((document_id) => ({ document_id }))
      return { rows, rowCount: rows.length }
    })
    const resolve = vi.fn(async (url: string) => (
      url === root.url ? root.doc() : url === meta.url ? meta.doc() : foreignHead.doc()
    ))

    await expect(prewarmWorkspaceFailoverDocuments(
      repo,
      { query } as never,
      { landscapeId: 'land', versionId: 'version' },
      resolve,
    )).rejects.toThrow('write head is outside its durable document scope')
    expect(resolve.mock.calls.map(([url]) => url)).toEqual([root.url, meta.url])
  })

  it('defers ordinary sharded workspaces whose overlay history is not bounded by the static format', async () => {
    const repo = new Repo({})
    const meta = repo.create({ editsObjectShardUrl: repo.create({ objects: {} }).url })
    const root = repo.create({ modelMetaUrl: meta.url })
    await Promise.all([root.whenReady(), meta.whenReady()])
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('JOIN read_model_static_workspaces') ? [{ root_url: root.url }] : [],
      rowCount: 1,
    }))
    const resolve = vi.fn(async (url: string) => url === root.url ? root.doc() : meta.doc())

    await expect(prewarmWorkspaceFailoverDocuments(
      repo,
      { query } as never,
      { landscapeId: 'land', versionId: 'version' },
      resolve,
    )).resolves.toEqual({
      rootUrl: root.url,
      documentIds: [root.documentId],
      modelKind: 'sharded-deferred',
    })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('defers unbounded legacy monolith decoding so it cannot delay another workspace takeover', async () => {
    const repo = new Repo({})
    const model = repo.create({ objects: { legacy: { id: 'legacy' } } })
    const root = repo.create({ modelUrl: model.url })
    await Promise.all([root.whenReady(), model.whenReady()])
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('JOIN read_model_static_workspaces') ? [{ root_url: root.url }] : [],
      rowCount: 1,
    }))
    const resolve = vi.fn(async (url: string) => url === root.url ? root.doc() : model.doc())

    await expect(prewarmWorkspaceFailoverDocuments(
      repo,
      { query } as never,
      { landscapeId: 'land', versionId: 'version' },
      resolve,
    )).resolves.toEqual({
      rootUrl: root.url,
      documentIds: [root.documentId],
      modelKind: 'monolith-deferred',
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalledWith(model.url)
  })

  it('does not open any Automerge document for an ordinary non-static workspace', async () => {
    const repo = new Repo({})
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const resolve = vi.fn()

    await expect(prewarmWorkspaceFailoverDocuments(
      repo,
      { query } as never,
      { landscapeId: 'ordinary', versionId: 'version' },
      resolve,
    )).resolves.toEqual({
      rootUrl: null,
      documentIds: [],
      modelKind: 'non-static-deferred',
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})
