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
import * as A from '@automerge/automerge'
import { DummyStorageAdapter } from '@automerge/automerge-repo/helpers/DummyStorageAdapter.js'
import { materializeFullModel, type FullModel } from './materialize.js'
import {
  diffModels,
  resolveConflicts,
  type DiffResult,
  type ChangeKind,
  type ChangeCollection,
} from './merge.js'
import { applyChangeset, applyChangesetDurably } from './applyMerge.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'

const has = (r: DiffResult, kind: ChangeKind, collection: ChangeCollection, id: string): boolean =>
  r.changes.some((c) => c.kind === kind && c.collection === collection && c.id === id)

// applyChangeset is the pure Automerge half of a merge (no DB). These drive the REAL
// materialize + diff + apply against an in-memory repo, mirroring the live monolithic path.

const obj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'system', name, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 100, height: 60 }, ...extra,
})

interface SeedDiagram { id: string; name: string; type?: string; objectIds?: string[]; layouts?: Record<string, unknown>; parentObjectId?: string; objectScopes?: Record<string, string> }

async function seedMonolith(repo: Repo, objects: Record<string, unknown>, diagrams: SeedDiagram[]): Promise<string> {
  const model = repo.create<Record<string, unknown>>({ objects, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
  await model.whenReady()
  const reg: Record<string, unknown> = {}
  for (const d of diagrams) {
    const docFields: Record<string, unknown> = {
      name: d.name, type: d.type ?? 'context', objectIds: d.objectIds ?? [], connectionIds: [], groupIds: [],
      layouts: d.layouts ?? {}, flows: {}, comments: {}, checkpoints: [],
    }
    const stub: Record<string, unknown> = { id: d.id, name: d.name, type: d.type ?? 'context', objectIds: d.objectIds ?? [], connectionIds: [], groupIds: [] }
    if (d.parentObjectId !== undefined) { docFields.parentObjectId = d.parentObjectId; stub.parentObjectId = d.parentObjectId }
    if (d.objectScopes !== undefined) docFields.objectScopes = d.objectScopes
    const doc = repo.create<Record<string, unknown>>(docFields)
    await doc.whenReady()
    stub.docUrl = doc.url
    reg[d.id] = stub
  }
  const shard = repo.create<Record<string, unknown>>({ diagrams: reg })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

/** Seed a SHARDED root (modelMetaUrl + one object shard) with optional delete tombstones. */
async function seedSharded(repo: Repo, objects: Record<string, unknown>, deletedObjectIds: string[] = []): Promise<string> {
  const objShard = repo.create<Record<string, unknown>>({ objects })
  await objShard.whenReady()
  const meta = repo.create<Record<string, unknown>>({
    objectShardUrls: [objShard.url], connectionShardUrls: [],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds, deletedConnectionIds: [],
  })
  await meta.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelMetaUrl: meta.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

/** Deep clone a FullModel so a test can mutate `theirs` independently of `ours`. */
const clone = (m: FullModel): FullModel => JSON.parse(JSON.stringify(m))

describe('applyChangeset (monolith)', () => {
  it('flushes only merge documents when the busy repo contains an unrelated non-ready handle', async () => {
    const repo = new Repo({ storage: new DummyStorageAdapter() })
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A') }, [])
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    ;(theirs.objects.a as Record<string, unknown>).name = 'A after draft merge'
    const changes = diffModels(ours, ours, theirs).changes

    // This mirrors the enterprise server: its shared Repo is also resolving documents from
    // other workspaces while the draft merge is running. The merge must never broaden a
    // durability boundary to every cached document, regardless of Repo version semantics.
    const unrelatedRepo = new Repo({})
    const unrelatedDocument = unrelatedRepo.create({ unrelated: true })
    await unrelatedDocument.whenReady()
    const pending = repo.findWithProgress(unrelatedDocument.url)
    void pending.whenReady().catch(() => undefined)
    expect(pending.peek().state).not.toBe('ready')
    const originalFlush = repo.flush.bind(repo)
    const flush = vi.spyOn(repo, 'flush').mockImplementation(async (documentIds) => {
      if (!documentIds?.length) throw new Error('merge attempted an unbounded Repo flush')
      expect(documentIds).not.toContain(unrelatedDocument.documentId)
      await originalFlush(documentIds)
    })

    const flushedDocumentIds = await applyChangesetDurably(repo, rootUrl, theirs, ours, changes)

    expect(flush).toHaveBeenCalled()
    expect(flushedDocumentIds).not.toContain(unrelatedDocument.documentId)
    expect((await materializeFullModel(repo, rootUrl)).objects.a).toMatchObject({
      name: 'A after draft merge',
    })
  })

  it('keeps every rotated connection overlay resident until a large merge is durable', async () => {
    const repo = new Repo({ storage: new DummyStorageAdapter() })
    const residency = new AutomergeResidencyLeases(repo)
    const rootUrl = await seedSharded(repo, {})
    // The production parent workspace is already durable before a draft merge.
    await repo.flush()
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    // The reported draft had 222 model changes; at the production segment
    // size this crosses seven connection-overlay heads during one merge.
    for (let index = 0; index < 222; index += 1) {
      const id = `connection-${String(index).padStart(3, '0')}`
      theirs.connections[id] = {
        id,
        fromId: `object-${index}`,
        toId: `object-${index + 1}`,
        type: 'solid',
        waypoints: [{ x: index * 10, y: index * 5 }],
      }
    }
    const changes = diffModels(ours, ours, theirs).changes

    const originalFlush = repo.flush.bind(repo)
    const createdConnectionSegments: string[] = []
    let retiredSegmentEvicted: boolean | null = null
    repo.flush = async (documentIds) => {
      await originalFlush(documentIds)
      if (documentIds?.length !== 1) return
      const handle = repo.handles[documentIds[0]]
      const doc = handle?.doc() as { connections?: Record<string, unknown> } | undefined
      if (!doc?.connections || Object.keys(doc.connections).length !== 0) return
      if (!createdConnectionSegments.includes(documentIds[0])) {
        createdConnectionSegments.push(documentIds[0])
      }
      if (createdConnectionSegments.length === 3 && retiredSegmentEvicted === null) {
        // Make the first filled segment durable, then reproduce the production
        // 15-second idle sweep racing the final merge flush after two rotations.
        await originalFlush([createdConnectionSegments[0] as never])
        retiredSegmentEvicted = await residency.evict(createdConnectionSegments[0])
      }
    }

    const touched = await applyChangesetDurably(
      repo,
      rootUrl,
      theirs,
      ours,
      changes,
      { residency, workspace: 'land/version' },
    )

    expect(createdConnectionSegments).toHaveLength(7)
    expect(retiredSegmentEvicted).toBe(false)
    expect(touched).toEqual(expect.arrayContaining(createdConnectionSegments))
    await residency.drain()
    expect(Object.keys((await materializeFullModel(repo, rootUrl)).connections)).toHaveLength(222)
  })

  it('applies object edit + create, a layout move, and a new diagram; preserves untouched entities', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(
      repo,
      { a: obj('a', 'A'), b: obj('b', 'B') },
      [{ id: 'D', name: 'Context', objectIds: ['a'], layouts: { a: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } } }]
    )

    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    // draft edits:
    ;(theirs.objects.a as Record<string, unknown>).name = 'A2'         // updated object
    theirs.objects.c = obj('c', 'C')                                    // created object
    ;(theirs.diagrams.D.detail!.layouts as Record<string, unknown>).a = { position: { x: 9, y: 9 }, size: { width: 1, height: 1 } } // layout move
    // created diagram N — its DiagramDoc must exist in the repo so applyChangeset can clone it
    const nDoc = repo.create<Record<string, unknown>>({ name: 'New', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {}, comments: {}, checkpoints: [] })
    await nDoc.whenReady()
    theirs.diagrams.N = {
      id: 'N',
      meta: { id: 'N', name: 'New', type: 'context', docUrl: nDoc.url, objectIds: [], connectionIds: [], groupIds: [] },
      detail: { settings: { name: 'New', type: 'context' }, objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {} },
    }

    // base = ours (current unchanged) ⇒ the diff is exactly the draft's changes, no conflicts.
    const diff = diffModels(ours, ours, theirs)
    expect(diff.conflicts).toHaveLength(0)

    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)

    const merged = await materializeFullModel(repo, rootUrl)
    expect((merged.objects.a as Record<string, unknown>).name).toBe('A2') // updated
    expect(merged.objects.c).toBeDefined()                                 // created
    expect((merged.objects.b as Record<string, unknown>).name).toBe('B')   // preserved (current-only)
    expect((merged.diagrams.D.detail!.layouts as Record<string, { position: { x: number } }>).a.position.x).toBe(9) // moved
    expect(merged.diagrams.N).toBeDefined()                                // created diagram cloned
    expect(merged.diagrams.N.detail).toBeDefined()
    // the clone stripped checkpoints
    const nDocAfter = await repo.find<{ checkpoints?: unknown[] }>(merged.diagrams.N.meta.docUrl as never)
    await nDocAfter.whenReady()
    expect(nDocAfter.doc()?.checkpoints).toEqual([])
  })

  it('preserves a current-only layout entry the draft never touched', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(
      repo,
      { a: obj('a', 'A') },
      [{ id: 'D', name: 'D', objectIds: ['a'], layouts: { a: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }, q: { position: { x: 5, y: 5 }, size: { width: 1, height: 1 } } } }]
    )
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    ;(theirs.diagrams.D.detail!.layouts as Record<string, unknown>).a = { position: { x: 1, y: 1 }, size: { width: 1, height: 1 } } // only move 'a'
    const diff = diffModels(ours, ours, theirs)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const merged = await materializeFullModel(repo, rootUrl)
    const layouts = merged.diagrams.D.detail!.layouts as Record<string, { position: { x: number } }>
    expect(layouts.a.position.x).toBe(1) // applied
    expect(layouts.q).toBeDefined()       // untouched current-only entry survives (union semantics)
    expect(layouts.q.position.x).toBe(5)
  })

  it('object delete is applied', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A'), b: obj('b', 'B') }, [])
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    delete theirs.objects.b // draft deletes b
    const diff = diffModels(ours, ours, theirs)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const merged = await materializeFullModel(repo, rootUrl)
    expect(merged.objects.b).toBeUndefined()
    expect(merged.objects.a).toBeDefined()
  })

  it('un-nesting a diagram (clearing parentObjectId) actually clears it in both the doc and the registry stub', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A') }, [{ id: 'D', name: 'D', objectIds: [], parentObjectId: 'a' }])
    const ours = await materializeFullModel(repo, rootUrl)
    expect((ours.diagrams.D.detail!.settings as Record<string, unknown>).parentObjectId).toBe('a')
    const theirs = clone(ours)
    delete (theirs.diagrams.D.detail!.settings as Record<string, unknown>).parentObjectId // un-nest in draft
    delete (theirs.diagrams.D.meta as Record<string, unknown>).parentObjectId
    const diff = diffModels(ours, ours, theirs)
    expect(has(diff, 'updated', 'diagram', 'D')).toBe(true)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const merged = await materializeFullModel(repo, rootUrl)
    expect((merged.diagrams.D.detail!.settings as Record<string, unknown>).parentObjectId).toBeUndefined() // doc cleared
    expect((merged.diagrams.D.meta as Record<string, unknown>).parentObjectId).toBeUndefined()             // stub cleared
  })

  it('merges per-diagram scope overrides key by key, and a draft that clears them all empties the live map instead of deleting it', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A'), b: obj('b', 'B') },
      [{ id: 'D', name: 'D', objectIds: ['a', 'b'], objectScopes: { a: 'external' } }])
    const ours = await materializeFullModel(repo, rootUrl)
    expect(ours.diagrams.D.detail!.settings.objectScopes).toEqual({ a: 'external' })

    const theirs = clone(ours)
    theirs.diagrams.D.detail!.settings.objectScopes = { a: 'internal', b: 'external' }
    let diff = diffModels(ours, ours, theirs)
    expect(has(diff, 'updated', 'diagram', 'D')).toBe(true)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    let merged = await materializeFullModel(repo, rootUrl)
    expect(merged.diagrams.D.detail!.settings.objectScopes).toEqual({ a: 'internal', b: 'external' })

    const cleared = clone(merged)
    delete (cleared.diagrams.D.detail!.settings as Record<string, unknown>).objectScopes
    diff = diffModels(merged, merged, cleared)
    expect(has(diff, 'updated', 'diagram', 'D')).toBe(true)
    const docUrl = merged.diagrams.D.meta.docUrl as AutomergeUrl
    const handle = await repo.find<Record<string, unknown>>(docUrl)
    // A peer, concurrently with the merge, overrides a third object.
    const peer = A.change(A.clone(handle.doc()!), (d) => {
      (d.objectScopes as Record<string, unknown>).c = 'external'
    })
    await applyChangeset(repo, rootUrl, cleared, merged, diff.changes)
    merged = await materializeFullModel(repo, rootUrl)
    // An empty map reads as "no overrides" in the diff model…
    expect(merged.diagrams.D.detail!.settings.objectScopes).toBeUndefined()
    expect(handle.doc()?.objectScopes).toEqual({})
    // …and because the live map was emptied, not deleted and recreated, the
    // peer's concurrent override survives the merge of the two histories.
    const converged = A.merge(A.clone(handle.doc()!), peer)
    expect(converged.objectScopes).toEqual({ c: 'external' })
  })

  // The stub's copy of the per-diagram scope overrides feeds Model Objects'
  // "external in N of M diagrams" (read model: ro_diagrams.data). A draft that
  // only touched the DiagramDoc's overrides must still move the stub.
  it('a draft\'s per-diagram scope override reaches the registry stub, from the DOC (not the draft meta)', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A') }, [{ id: 'D', name: 'D', objectIds: ['a'] }])
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    ;(theirs.diagrams.D.detail!.settings as Record<string, unknown>).objectScopes = { a: 'external' }
    const diff = diffModels(ours, ours, theirs)
    expect(has(diff, 'updated', 'diagram', 'D')).toBe(true)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    let merged = await materializeFullModel(repo, rootUrl)
    expect((merged.diagrams.D.detail!.settings as Record<string, unknown>).objectScopes).toEqual({ a: 'external' })
    expect((merged.diagrams.D.meta as Record<string, unknown>).objectScopes).toEqual({ a: 'external' })

    // …and a draft clearing it empties the stub's map too.
    const cleared = clone(merged)
    delete (cleared.diagrams.D.detail!.settings as Record<string, unknown>).objectScopes
    const clearDiff = diffModels(merged, merged, cleared)
    await applyChangeset(repo, rootUrl, cleared, merged, clearDiff.changes)
    merged = await materializeFullModel(repo, rootUrl)
    expect((merged.diagrams.D.meta as Record<string, unknown>).objectScopes).toEqual({})
  })

  it('sharded: a re-created object is NOT wiped by a stale delete tombstone (un-tombstone on upsert)', async () => {
    const repo = new Repo({})
    // parent root already carries a tombstone for id 'x' from a prior delete-merge.
    const rootUrl = await seedSharded(repo, {}, ['x'])
    const ours = await materializeFullModel(repo, rootUrl)
    expect(ours.objects.x).toBeUndefined() // tombstoned out
    const theirs = clone(ours)
    theirs.objects.x = obj('x', 'X-reborn') // draft re-introduces id x
    const diff = diffModels(ours, ours, theirs)
    expect(has(diff, 'created', 'object', 'x')).toBe(true)
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const merged = await materializeFullModel(repo, rootUrl)
    expect(merged.objects.x).toBeDefined() // survives the tombstone pass
    expect((merged.objects.x as Record<string, unknown>).name).toBe('X-reborn')
  })

  it('applies an auto-layout connection routing-only change', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A'), b: obj('b', 'B') }, [])
    const empty = await materializeFullModel(repo, rootUrl)
    const withConnection = clone(empty)
    withConnection.connections.c = {
      id: 'c', fromId: 'a', toId: 'b', type: 'solid', lockedToAnchors: false,
    }
    await applyChangeset(repo, rootUrl, withConnection, empty, diffModels(empty, empty, withConnection).changes)

    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    theirs.connections.c = {
      ...theirs.connections.c,
      waypoints: [{ x: 120, y: 80 }],
      fromAnchor: 3,
      toAnchor: 1,
      lockedToAnchors: true,
    }
    const routeOnly = diffModels(ours, ours, theirs)
    expect(has(routeOnly, 'updated', 'connection', 'c')).toBe(true)

    await applyChangeset(repo, rootUrl, theirs, ours, routeOnly.changes)

    expect((await materializeFullModel(repo, rootUrl)).connections.c).toMatchObject({
      waypoints: [{ x: 120, y: 80 }],
      fromAnchor: 3,
      toAnchor: 1,
      lockedToAnchors: true,
    })
  })

  it('summary-only static workspace updates the DiagramDoc without rewriting its immutable registry shard', async () => {
    const repo = new Repo({})
    const diagram = repo.create<Record<string, unknown>>({
      name: 'Live', type: 'context', objectIds: [], connectionIds: [], groupIds: [],
      layouts: {}, flows: {}, comments: {}, checkpoints: [],
    })
    const registry = repo.create<{ diagrams: Record<string, Record<string, unknown>> }>({
      diagrams: {
        D: {
          id: 'D', name: 'Live', type: 'context', docUrl: diagram.url,
          objectIds: [], connectionIds: [], groupIds: [],
        },
      },
    })
    const meta = repo.create<Record<string, unknown>>({
      objectShardUrls: [], connectionShardUrls: [], groups: {}, domains: {},
      tagSnapshots: {}, decisionRecords: {},
    })
    await Promise.all([diagram, registry, meta].map((handle) => handle.whenReady()))
    const root = repo.create<Record<string, unknown>>({
      modelMetaUrl: meta.url,
      shardUrls: [registry.url],
      registrySummaryOnly: true,
    })
    await root.whenReady()

    const ours: FullModel = {
      objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
      diagrams: {
        D: {
          id: 'D',
          meta: {
            id: 'D', name: 'Live', type: 'context', docUrl: diagram.url,
            objectIds: [], connectionIds: [], groupIds: [],
          },
          detail: {
            settings: { name: 'Live', type: 'context' },
            objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {},
          },
        },
      },
      missing: [],
    }
    const theirs = clone(ours)
    theirs.diagrams.D.meta.name = 'Draft'
    theirs.diagrams.D.detail!.settings.name = 'Draft'
    const diff = diffModels(ours, ours, theirs)

    await applyChangeset(repo, root.url, theirs, ours, diff.changes)

    expect(diagram.doc()?.name).toBe('Draft')
    // The relational read model + DiagramDoc are authoritative for a static
    // baseline. Touching a potentially huge registry shard here was the O(N)
    // merge regression on the 30k-diagram performance workspace.
    expect(registry.doc()?.diagrams.D.name).toBe('Live')
  })

  it('applies an explicit draft conflict resolution and preserves the live choice on retry', async () => {
    const repo = new Repo({})
    const rootUrl = await seedSharded(repo, { a: obj('a', 'At fork') })
    const base = await materializeFullModel(repo, rootUrl)

    // Reproduce the real conflict: both the live workspace and the draft
    // changed the same field after the fork.
    const live = clone(base)
    ;(live.objects.a as Record<string, unknown>).name = 'Changed live'
    await applyChangeset(
      repo,
      rootUrl,
      live,
      base,
      diffModels(base, base, live).changes,
    )
    const current = await materializeFullModel(repo, rootUrl)
    const draft = clone(base)
    ;(draft.objects.a as Record<string, unknown>).name = 'Changed in draft'

    const conflict = diffModels(base, current, draft)
    expect(conflict.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'object', id: 'a', kind: 'update/update' }),
    ]))

    const keepLive = resolveConflicts(conflict, { 'object:a:': 'live' })
    expect(keepLive.blocked).toBeNull()
    await applyChangeset(repo, rootUrl, draft, current, keepLive.appliedChanges)
    expect((await materializeFullModel(repo, rootUrl)).objects.a).toMatchObject({
      name: 'Changed live',
    })

    const keepDraft = resolveConflicts(conflict, { 'object:a:': 'draft' })
    expect(keepDraft.blocked).toBeNull()
    await applyChangeset(repo, rootUrl, draft, current, keepDraft.appliedChanges)
    expect((await materializeFullModel(repo, rootUrl)).objects.a).toMatchObject({
      name: 'Changed in draft',
    })

    // A network retry of the accepted merge stays idempotent.
    await applyChangeset(repo, rootUrl, draft, current, keepDraft.appliedChanges)
    expect((await materializeFullModel(repo, rootUrl)).objects.a).toMatchObject({
      name: 'Changed in draft',
    })
  })

  it('is idempotent — re-running does not duplicate the created diagram or re-apply destructively', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { a: obj('a', 'A') }, [])
    const ours = await materializeFullModel(repo, rootUrl)
    const theirs = clone(ours)
    ;(theirs.objects.a as Record<string, unknown>).name = 'A2'
    const nDoc = repo.create<Record<string, unknown>>({ name: 'New', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {}, comments: {}, checkpoints: [] })
    await nDoc.whenReady()
    theirs.diagrams.N = {
      id: 'N',
      meta: { id: 'N', name: 'New', type: 'context', docUrl: nDoc.url, objectIds: [], connectionIds: [], groupIds: [] },
      detail: { settings: { name: 'New', type: 'context' }, objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {} },
    }
    const diff = diffModels(ours, ours, theirs)

    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const after1 = await materializeFullModel(repo, rootUrl)
    // Re-run with the SAME changeset (ours is stale on purpose — simulates a retry).
    await applyChangeset(repo, rootUrl, theirs, ours, diff.changes)
    const after2 = await materializeFullModel(repo, rootUrl)

    expect(Object.keys(after2.diagrams)).toEqual(Object.keys(after1.diagrams)) // no duplicate N
    expect((after2.objects.a as Record<string, unknown>).name).toBe('A2')
    expect(Object.keys(after2.diagrams).filter((k) => k === 'N')).toHaveLength(1)
  })
})
