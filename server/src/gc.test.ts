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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gcOrphanedDocs } from './gc.js'

const repos: Repo[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.shutdown()))
})

describe('Automerge GC static workspaces', () => {
  it('marks the SQL ownership manifest without opening sealed CRDT shards', async () => {
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const root = repo.create({ sealed: true })
    const shard = repo.create({ huge: 'registry' })
    await Promise.all([root.whenReady(), shard.whenReady()])
    const find = vi.spyOn(repo, 'find')
    const query = vi.fn(async (sql: string) => {
      // MATCHED ON THE TABLE, not on an exact SQL string: a fake pinned to a
      // literal query silently answers no rows once the query's shape changes.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: root.url }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: true }] }
      if (sql.includes('FROM read_model_static_workspaces workspace')) {
        return { rows: [{ root_url: root.url, landscape_id: 'land', version_id: 'version' }] }
      }
      if (sql.includes('FROM automerge_document_workspace')) {
        return { rows: [{ document_id: root.documentId }, { document_id: shard.documentId }] }
      }
      if (sql.includes('FROM automerge_meta')) return { rows: [] }
      if (sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) {
        return {
          rows: [
            { doc: root.documentId, updated_at: new Date(0) },
            { doc: shard.documentId, updated_at: new Date(0) },
          ],
        }
      }
      return { rows: [] }
    })

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-07-24T00:00:00Z'),
    })

    expect(result).toMatchObject({ roots: 1, reachable: 2, deleted: 0, aborted: false })
    expect(find).not.toHaveBeenCalled()
  })

  it('fails closed when a static workspace manifest is empty', async () => {
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const root = repo.create({ sealed: true })
    await root.whenReady()
    const find = vi.spyOn(repo, 'find')
    const query = vi.fn(async (sql: string) => {
      // MATCHED ON THE TABLE, not on an exact SQL string: a fake pinned to a
      // literal query silently answers no rows once the query's shape changes.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: root.url }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: true }] }
      if (sql.includes('FROM read_model_static_workspaces workspace')) {
        return { rows: [{ root_url: root.url, landscape_id: 'land', version_id: 'version' }] }
      }
      if (sql.includes('FROM automerge_document_workspace')) return { rows: [] }
      if (sql.includes('FROM automerge_meta')) return { rows: [] }
      if (sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) return { rows: [] }
      return { rows: [] }
    })

    const result = await gcOrphanedDocs(repo, { db: { query } as never })

    expect(result).toMatchObject({
      roots: 1,
      stored: 0,
      deleted: 0,
      proposedDeletions: 0,
      aborted: true,
      incompleteReasons: [{ kind: 'empty-static-manifest', url: root.url }],
    })
    expect(find).not.toHaveBeenCalled()
  })

  it('reports the exact old-orphan set and digest without deleting it', async () => {
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const model = repo.create({ objects: {} })
    const registry = repo.create({ diagrams: {} })
    const root = repo.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([model.whenReady(), registry.whenReady(), root.whenReady()])
    const query = vi.fn(async (sql: string) => {
      // MATCHED ON THE TABLE, not on an exact SQL string: a fake pinned to a
      // literal query silently answers no rows once the query's shape changes.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: root.url }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: false }] }
      if (sql.includes('FROM automerge_meta')) return { rows: [] }
      if (sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) {
        return {
          rows: [
            { doc: root.documentId, updated_at: new Date(0) },
            { doc: model.documentId, updated_at: new Date(0) },
            { doc: registry.documentId, updated_at: new Date(0) },
            { doc: 'old-orphan-b', updated_at: new Date(0) },
            { doc: 'old-orphan-a', updated_at: new Date(0) },
          ],
        }
      }
      if (sql.includes('DELETE FROM automerge_storage')) throw new Error('report-only attempted a delete')
      return { rows: [] }
    })

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-07-26T00:00:00Z'),
      reportOnly: true,
      includeCandidateDocumentIds: true,
    })

    expect(result).toMatchObject({
      aborted: false,
      reportOnly: true,
      deleted: 0,
      proposedDeletions: 2,
      candidateDocumentIds: ['old-orphan-a', 'old-orphan-b'],
      incompleteReasons: [],
    })
    expect(result.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM automerge_storage'))).toBe(false)
  })

  it('never proposes automerge-repo\'s own storage-adapter-id for deletion', async () => {
    // `automerge_storage` is enumerated by key PREFIX
    // (`split_part(key, '/', 1)`), and one prefix is not a document:
    // `storage-adapter-id`, the per-repo identity `StorageSubsystem.id()`
    // persists. Nothing references it from any root, so without
    // `isDocumentStorageKey` it would be a permanent sweep candidate and a
    // complete GC pass would DELETE the repo's identity.
    //
    // No timing in this test: the row is stated outright rather than waited for.
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const model = repo.create({ objects: {} })
    const registry = repo.create({ diagrams: {} })
    const root = repo.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([model.whenReady(), registry.whenReady(), root.whenReady()])
    const query = vi.fn(async (sql: string) => {
      // MATCHED ON THE TABLE, not on an exact SQL string: a fake pinned to a
      // literal query silently answers no rows once the query's shape changes.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: root.url }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: false }] }
      if (sql.includes('FROM automerge_meta')) return { rows: [] }
      if (sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) {
        return {
          rows: [
            { doc: root.documentId, updated_at: new Date(0) },
            { doc: model.documentId, updated_at: new Date(0) },
            { doc: registry.documentId, updated_at: new Date(0) },
            { doc: 'storage-adapter-id', updated_at: new Date(0) },
          ],
        }
      }
      if (sql.includes('DELETE FROM automerge_storage')) throw new Error('the adapter id was swept')
      return { rows: [] }
    })

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-07-26T00:00:00Z'),
      reportOnly: true,
      includeCandidateDocumentIds: true,
    })

    expect(result).toMatchObject({
      aborted: false,
      deleted: 0,
      proposedDeletions: 0,
      candidateDocumentIds: [],
    })
    // …and it is not a document, so it is not part of the inventory either.
    expect(result.stored).toBe(3)
  })

  it('refuses an apply when the candidate set changed after its audit', async () => {
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const model = repo.create({ objects: {} })
    const registry = repo.create({ diagrams: {} })
    const root = repo.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([model.whenReady(), registry.whenReady(), root.whenReady()])
    const query = vi.fn(async (sql: string) => {
      // MATCHED ON THE TABLE, not on an exact SQL string: a fake pinned to a
      // literal query silently answers no rows once the query's shape changes.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: root.url }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: false }] }
      if (sql.includes('FROM automerge_meta') || sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) {
        return { rows: [{ doc: 'changed-orphan', updated_at: new Date(0) }] }
      }
      if (sql.includes('DELETE FROM automerge_storage')) throw new Error('digest mismatch attempted a delete')
      return { rows: [] }
    })

    await expect(gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      expectedCandidateDigest: 'audited-but-now-stale',
    })).rejects.toThrow(/candidate digest changed/)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM automerge_storage'))).toBe(false)
  })
})

/**
 * The reachability root that keeps chain folding from being a data-loss
 * defect. A folded overlay segment is deliberately removed from ModelMeta, so
 * the ModelMeta walk stops marking it; read_model_overlay_segments becomes its
 * only anchor, and forwardHistoricalOverlay needs its bytes to merge the
 * offline edits of a client that reconnects on a head which rotated away.
 */
describe('Automerge GC — les segments overlay retenus (D3)', () => {
  /** A NON-static workspace, so the ModelMeta walk runs rather than the SQL
   * manifest shortcut — that walk is exactly what a fold stops covering. */
  async function foldedWorkspace() {
    const repo = new Repo({ network: [] })
    repos.push(repo)
    const head = repo.create({ objects: {} })
    const folded = repo.create({ objects: { kept: { id: 'kept' } } })
    const registry = repo.create({ diagrams: {} })
    const meta = repo.create({
      objectShardUrls: [] as string[],
      connectionShardUrls: [] as string[],
      // The fold already happened: `folded` is named in NO list.
      editsObjectShardUrls: [head.url],
      editsObjectShardUrl: head.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await Promise.all([head.whenReady(), folded.whenReady(), registry.whenReady(),
      meta.whenReady(), root.whenReady()])
    return { repo, head, folded, registry, meta, root }
  }

  function poolFor(
    rootUrl: string,
    documents: { documentId: string }[],
    overlayRows: { document_id: string }[] | 'absent',
  ) {
    return vi.fn(async (sql: string) => {
      // Matched on the table, for the same reason as the fakes above.
      if (sql.includes('FROM versions')) return { rows: [{ root_url: rootUrl }] }
      if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: false }] }
      if (sql.includes("'.read_model_overlay_segments'")) {
        return { rows: [{ present: overlayRows !== 'absent' }] }
      }
      if (sql.includes('FROM read_model_overlay_segments')) {
        return { rows: overlayRows === 'absent' ? [] : overlayRows }
      }
      if (sql.includes('FROM automerge_meta')) return { rows: [] }
      if (sql.includes('FROM landscape_versions')) return { rows: [] }
      if (sql.includes('FROM automerge_storage')) {
        return { rows: documents.map((d) => ({ doc: d.documentId, updated_at: new Date(0) })) }
      }
      return { rows: [] }
    })
  }

  it('protège un segment plié — y compris celui dont retain_until est NULL', async () => {
    const { repo, head, folded, registry, meta, root } = await foldedWorkspace()
    const query = poolFor(root.url, [root, meta, registry, head, folded], [
      // The CURRENT head: is_current true, retain_until NULL.
      { document_id: head.documentId },
      // A FOLDED segment. NULL here means RETAINED, not expired — the predicate
      // is `is_current OR retain_until IS NULL OR retain_until > now()`.
      // `WHERE retain_until > now()` alone would fail on NULL, making the
      // segment a candidate whose bytes the sweep deletes.
      { document_id: folded.documentId },
    ])

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-08-19T00:00:00Z'),
      reportOnly: true,
      includeCandidateDocumentIds: true,
    })

    expect(result.aborted).toBe(false)
    expect(result.candidateDocumentIds ?? []).not.toContain(folded.documentId)
    expect(result.proposedDeletions).toBe(0)
    // A decorated `segment_url` would be dropped by isValidAutomergeUrl and
    // never reach the set — this exact count is what proves the id form.
    expect(result.reachable).toBe(5)
  })

  it('un segment HORS rétention perd la protection — le pliage ne borne le stockage que par expiration', async () => {
    const { repo, head, folded, registry, meta, root } = await foldedWorkspace()
    // Same shape, except the fold's target is past its retention window, so the
    // root does not return it at all.
    const query = poolFor(root.url, [root, meta, registry, head, folded], [{ document_id: head.documentId }])

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-08-19T00:00:00Z'),
      reportOnly: true,
      includeCandidateDocumentIds: true,
    })

    // The claim is about the REACHABLE set, not the candidate list. This
    // harness holds every document in a live Repo, so `skippedInMemory` filters
    // the folded id out of the candidates whatever the root decided — asserting
    // on candidates here would pass against a root that protects EVERYTHING.
    expect(result.reachable).toBe(4)
    expect(result.skippedInMemory).toBeGreaterThan(0)
  })

  it("une version SUPPRIMEE ne garde pas ses tetes overlay epinglees", async () => {
    const { repo, head, folded, registry, meta, root } = await foldedWorkspace()
    // Nothing in server/src ever deletes a read_model_overlay_segments row, and
    // deleteVersion touches only `versions` — so the row OUTLIVES its version.
    // The root must JOIN, or the current head of every deleted version
    // (is_current true, retain_until NULL) stays pinned for ever with no
    // operator lever to release it.
    //
    // This fake MODELS the join instead of hard-coding its answer: the rows
    // exist, and they are returned only if the query asks for them through
    // `versions`. A fake that answered [] unconditionally would pass against
    // the un-joined query too, and would be testing nothing.
    const rows = [{ document_id: head.documentId }, { document_id: folded.documentId }]
    const inner = poolFor(root.url, [root, meta, registry, head, folded], rows)
    const deletedVersion = vi.fn(async (sql: string) => {
      if (sql.includes("FROM read_model_overlay_segments")) {
        return { rows: sql.includes("JOIN versions") ? [] : rows }
      }
      return inner(sql)
    })

    const result = await gcOrphanedDocs(repo, {
      db: { query: deletedVersion } as never,
      minimumAgeMs: 0,
      now: new Date("2026-08-19T00:00:00Z"),
      reportOnly: true,
    })

    // Without `JOIN versions`, reachable would be 5.
    expect(result.reachable).toBe(4)
    expect(deletedVersion.mock.calls.some(([sql]) =>
      String(sql).includes("FROM read_model_overlay_segments") && String(sql).includes("JOIN versions"))).toBe(true)
  })

  it('une base sans la table balaie normalement, et n\'est PAS incomplète', async () => {
    const { repo, head, registry, meta, root } = await foldedWorkspace()
    const query = poolFor(root.url, [root, meta, registry, head], 'absent')

    const result = await gcOrphanedDocs(repo, {
      db: { query } as never,
      minimumAgeMs: 0,
      now: new Date('2026-08-19T00:00:00Z'),
      reportOnly: true,
    })

    // Unlike `empty-static-manifest`, an empty answer must NOT set
    // complete = false. Zero rows is the NORMAL state of a
    // park with no promoted workspace, and aborting there would stop the sweep
    // from ever deleting anything again, for every workspace in the park.
    expect(result.aborted).toBe(false)
    expect(result.incompleteReasons).toEqual([])
  })
})
