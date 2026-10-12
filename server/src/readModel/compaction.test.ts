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
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { compactOverlay, readProjectionAcknowledgement } from './compaction.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import type { Queryable } from './types.js'

/**
 * Compaction folds the persistent edits overlay back into the base shards and clears
 * it. Deterministic, in-memory (no Postgres): build a sharded model + overlay in an
 * in-process Repo, run compactOverlay, then assert the resulting Automerge doc states.
 */

type Obj = { id: string; name: string }
type ObjShard = { objects: Record<string, Obj> }
type ConnShard = { connections: Record<string, { id: string; fromId: string; toId: string }> }

interface Built {
  repo: Repo
  rootUrl: string
  meta: DocHandle<{
    objectShardUrls: string[]
    connectionShardUrls: string[]
    editsObjectShardUrl?: string
    editsObjectShardUrls?: string[]
    editsConnectionShardUrl?: string
    editsConnectionShardUrls?: string[]
    editsOverlayWriteHeadVersion?: number
  }>
  baseObj: DocHandle<ObjShard>[]
  overlayObj: DocHandle<ObjShard> | null
}

/** Build a sharded model: `base` = array of base object-shard contents; `overlay` =
 * the edits-overlay object-shard contents (null = no overlay); `deleted` = tombstones. */
async function build(
  base: Record<string, Obj>[],
  overlay: Record<string, Obj> | null,
  deleted: string[] = [],
): Promise<Built> {
  const repo = new Repo({})
  const baseObj = base.map((objects) => repo.create<ObjShard>({ objects }))
  const overlayObj = overlay ? repo.create<ObjShard>({ objects: overlay }) : null
  const objectShardUrls = baseObj.map((h) => h.url)
  if (overlayObj) objectShardUrls.push(overlayObj.url)
  const meta = repo.create({
    objectShardUrls,
    connectionShardUrls: [] as string[],
    ...(overlayObj ? { editsObjectShardUrl: overlayObj.url } : {}),
    ...(deleted.length ? { deletedObjectIds: deleted } : {}),
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  await Promise.all([...baseObj, ...(overlayObj ? [overlayObj] : []), meta, root].map((h) => h.whenReady()))
  return { repo, rootUrl: root.url, meta, baseObj, overlayObj }
}

const metaTombstones = (b: Built) => (b.meta.doc() as { deletedObjectIds?: string[] }).deletedObjectIds ?? []

const objIds = (h: DocHandle<ObjShard>) => Object.keys(h.doc()?.objects ?? {}).sort()

describe('compactOverlay', () => {
  it('folds an EDIT of an existing object into its base shard, then clears the overlay', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } }],
      { o0: { id: 'o0', name: 'A-edited' } } // overlay shadows o0
    )
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })

    expect(res.objectsFolded).toBe(1)
    expect(b.baseObj[0].doc()?.objects.o0.name).toBe('A-edited') // folded in place
    expect(b.baseObj[0].doc()?.objects.o1.name).toBe('B') // untouched
    expect(b.overlayObj!.doc()?.objects).toEqual({}) // overlay cleared
    expect(b.meta.doc()?.editsObjectShardUrl).not.toBe(b.overlayObj!.url)
  })

  it('folds a CREATED object into a base shard that has room', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { n0: { id: 'n0', name: 'New' } } // not in any base shard
    )
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })

    expect(res.objectsFolded).toBe(1)
    expect(objIds(b.baseObj[0])).toEqual(['n0', 'o0']) // placed into the shard with room
    expect(b.overlayObj!.doc()?.objects).toEqual({})
  })

  it('creates a NEW base shard (spliced before the overlay) when base shards are full', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }], // 1 base shard, full at shardSize=1
      { n0: { id: 'n0', name: 'New' } }
    )
    const overlayUrl = b.overlayObj!.url
    const res = await compactOverlay(b.repo, b.rootUrl, { shardSize: 1, mode: 'apply' })

    expect(res.objectsFolded).toBe(1)
    const meta = b.meta.doc()!
    const urls = meta.objectShardUrls
    // A new base shard and a fresh history-free write head were appended. The
    // cleared legacy overlay remains referenced for stale clients.
    expect(urls.length).toBe(4)
    expect(urls).toContain(overlayUrl)
    expect(meta.editsObjectShardUrl).not.toBe(overlayUrl)
    expect(urls[urls.length - 1]).toBe(meta.editsObjectShardUrl)
    // The protocol version the fold republishes. Nothing else pins it: a wrong
    // or missing version published here means every client flush bails
    // forever, silently, while online.
    expect(meta.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
    // The created object lives in the freshly-created base shard (not the full one).
    const newUrl = urls.find((u) => u !== overlayUrl && u !== meta.editsObjectShardUrl && u !== b.baseObj[0].url)!
    const newShard = await b.repo.find<ObjShard>(newUrl)
    await newShard.whenReady()
    expect(objIds(newShard)).toEqual(['n0'])
    expect(b.baseObj[0].doc()?.objects.o0.name).toBe('A') // full shard untouched
    expect(b.overlayObj!.doc()?.objects).toEqual({})
  })

  it('flushes every newly created shard BEFORE ModelMeta publishes its url', async () => {
    // The write-order invariant (createEmptyRoot's rule): no durable document may
    // point at a child that has not reached storage. A crash between the meta
    // save and the child save leaves a pointer to a document that does not
    // exist — and a cold client's find() on it never settles. The event trace is
    // recorded synchronously at CALL time, so the assertion is about ordering,
    // not about event-emission timing.
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }], // 1 base shard, full at shardSize=1
      { n0: { id: 'n0', name: 'New' } }
    )
    type Event = { kind: 'flush'; ids: string[] } | { kind: 'meta-publish'; urls: string[] }
    const events: Event[] = []
    const originalFlush = b.repo.flush.bind(b.repo)
    b.repo.flush = async (documentIds?: string[]) => {
      events.push({ kind: 'flush', ids: documentIds ?? ['*'] })
      return originalFlush(documentIds)
    }
    const originalChange = b.meta.change.bind(b.meta)
    b.meta.change = ((fn: Parameters<typeof originalChange>[0]) => {
      const out = originalChange(fn)
      events.push({ kind: 'meta-publish', urls: [...(b.meta.doc()?.objectShardUrls ?? [])] })
      return out
    }) as typeof b.meta.change

    const knownAtStart = new Set(b.meta.doc()!.objectShardUrls)
    await compactOverlay(b.repo, b.rootUrl, { shardSize: 1, mode: 'apply' })

    // Walk the trace: whenever a meta change introduces a url unseen so far,
    // an EARLIER flush must already cover that document.
    const flushedSoFar = new Set<string>()
    let published = 0
    for (const event of events) {
      if (event.kind === 'flush') {
        for (const id of event.ids) flushedSoFar.add(id)
        continue
      }
      for (const url of event.urls) {
        if (knownAtStart.has(url)) continue
        knownAtStart.add(url)
        published += 1
        const documentId = url.replace('automerge:', '')
        expect(
          flushedSoFar.has(documentId) || flushedSoFar.has('*'),
          `meta published ${url} before that document was flushed`,
        ).toBe(true)
      }
    }
    // Both creations of this scenario must have been seen: the overflow base
    // shard AND the fresh write head — otherwise the loop above vacuously passes.
    expect(published).toBe(2)
  })

  it('flushes the folded base shards BEFORE clearing the overlay copies (the VALUE half)', async () => {
    // Companion of the pointer-order test above: a crash that persists the
    // cleared overlay but not the folded base loses the entity from both
    // homes. Trace recorded synchronously at call time, as above.
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { o0: { id: 'o0', name: 'A-edited' } }
    )
    type Event = { kind: 'flush'; ids: string[] } | { kind: 'overlay-clear' }
    const events: Event[] = []
    const originalFlush = b.repo.flush.bind(b.repo)
    b.repo.flush = async (documentIds?: string[]) => {
      events.push({ kind: 'flush', ids: documentIds ?? ['*'] })
      return originalFlush(documentIds)
    }
    const overlay = b.overlayObj!
    const originalChange = overlay.change.bind(overlay)
    overlay.change = ((fn: Parameters<typeof originalChange>[0]) => {
      const out = originalChange(fn)
      events.push({ kind: 'overlay-clear' })
      return out
    }) as typeof overlay.change

    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })

    const firstClear = events.findIndex((event) => event.kind === 'overlay-clear')
    expect(firstClear, 'the overlay was never touched — the scenario is void').toBeGreaterThanOrEqual(0)
    const flushedBefore = new Set(
      events.slice(0, firstClear)
        .flatMap((event) => (event.kind === 'flush' ? event.ids : [])),
    )
    expect(
      flushedBefore.has(b.baseObj[0].documentId) || flushedBefore.has('*'),
      'the folded base shard must be durable before any overlay clear',
    ).toBe(true)
  })

  it('is a no-op when there is no overlay marker', async () => {
    const b = await build([{ o0: { id: 'o0', name: 'A' } }], null)
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(res).toMatchObject({ objectsFolded: 0, connectionsFolded: 0 })
    expect(b.baseObj[0].doc()?.objects.o0.name).toBe('A')
  })

  it('is idempotent: a second run folds nothing', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { o0: { id: 'o0', name: 'A2' }, n0: { id: 'n0', name: 'N' } }
    )
    const first = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(first.objectsFolded).toBe(2)
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(second.objectsFolded).toBe(0)
    // Final state: both ids live in base shards, overlay empty.
    expect(b.baseObj[0].doc()?.objects.o0.name).toBe('A2')
    expect(objIds(b.baseObj[0])).toEqual(['n0', 'o0'])
    expect(b.overlayObj!.doc()?.objects).toEqual({})
  })

  it('applies a delete tombstone: removes the id from its base shard + clears the tombstone', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } }],
      null,
      ['o1'] // tombstone o1 (lives in a base shard)
    )
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })

    expect(res.objectsDeleted).toBe(1)
    expect(objIds(b.baseObj[0])).toEqual(['o0']) // o1 removed from the base shard
    expect(metaTombstones(b)).toEqual([]) // tombstone list cleared
  })

  it('a tombstone also removes the id from the overlay and is NOT folded back', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { o1: { id: 'o1', name: 'edited-then-deleted' } }, // o1 is in the overlay…
      ['o1'] // …and tombstoned
    )
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })

    expect(res.objectsDeleted).toBe(1)
    expect(res.objectsFolded).toBe(0) // tombstoned id excluded from the fold
    expect(objIds(b.baseObj[0])).toEqual(['o0']) // not folded into base
    expect(b.overlayObj!.doc()?.objects).toEqual({}) // removed from overlay
    expect(metaTombstones(b)).toEqual([])
  })

  it('a tombstone for an unknown id is a harmless no-op that still clears', async () => {
    const b = await build([{ o0: { id: 'o0', name: 'A' } }], null, ['ghost'])
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(res.objectsDeleted).toBe(1) // counted as processed
    expect(objIds(b.baseObj[0])).toEqual(['o0']) // base untouched
    expect(metaTombstones(b)).toEqual([])
  })

  it('folds connection overlays too', async () => {
    const repo = new Repo({})
    const baseConn = repo.create<ConnShard>({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const overlayConn = repo.create<ConnShard>({
      connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o2' }, c1: { id: 'c1', fromId: 'o1', toId: 'o2' } },
    })
    const meta = repo.create({
      objectShardUrls: [] as string[],
      connectionShardUrls: [baseConn.url, overlayConn.url],
      editsConnectionShardUrl: overlayConn.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([baseConn, overlayConn, meta, root].map((h) => h.whenReady()))

    const res = await compactOverlay(repo, root.url, { mode: 'apply' })
    expect(res.connectionsFolded).toBe(2)
    expect(baseConn.doc()?.connections.c0.toId).toBe('o2') // edited endpoint folded
    expect(baseConn.doc()?.connections.c1.fromId).toBe('o1') // created connection placed
    expect(overlayConn.doc()?.connections).toEqual({}) // overlay cleared
  })

  it('folds bounded overlay segments oldest to newest and clears every captured segment', async () => {
    const repo = new Repo({})
    const base = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'base' } } })
    const first = repo.create<ObjShard>({
      objects: { o0: { id: 'o0', name: 'first' }, n1: { id: 'n1', name: 'one' } },
    })
    const current = repo.create<ObjShard>({
      objects: { o0: { id: 'o0', name: 'current' }, n2: { id: 'n2', name: 'two' } },
    })
    const meta = repo.create({
      objectShardUrls: [base.url, first.url, current.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrls: [first.url, current.url],
      editsObjectShardUrl: current.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, first, current, meta, root].map((handle) => handle.whenReady()))

    const result = await compactOverlay(repo, root.url, { mode: 'apply' })

    expect(result.objectsFolded).toBe(3)
    expect(base.doc()?.objects.o0.name).toBe('current')
    expect(base.doc()?.objects.n1.name).toBe('one')
    expect(base.doc()?.objects.n2.name).toBe('two')
    expect(first.doc()?.objects).toEqual({})
    expect(current.doc()?.objects).toEqual({})
  })
})

describe('compaction acknowledgement gate', () => {
  it('fails closed before resolving documents for an immutable static baseline', async () => {
    const repo = new Repo({})
    await expect(compactOverlay(repo, 'automerge:unavailable', { staticBaseline: true, mode: 'apply' }))
      .resolves.toMatchObject({ skippedReason: 'static_baseline' })
    expect(Object.keys(repo.handles)).toHaveLength(0)
  })

  it('allows compaction only when the attached projector published every observed generation', async () => {
    const key = { landscapeId: 'ls', versionId: 'v1' }
    // STRINGS, because pg returns `bigint` as text — and the values straddle a
    // digit boundary on purpose. With JS numbers (`9` vs `8`) a mutant dropping
    // the `Number()` coercion survives; with `'10'` vs `'9'` it cannot, because
    // `'9' >= '10'` is TRUE and a lagging projector would read as caught up.
    const caughtUp = { query: async () => ({
      rows: [{ observed_generation: '10', projected_generation: '10', projector_attached: true }], rowCount: 1,
    }) } as Queryable
    const lagging = { query: async () => ({
      rows: [{ observed_generation: '10', projected_generation: '9', projector_attached: true }], rowCount: 1,
    }) } as Queryable
    await expect(readProjectionAcknowledgement(caughtUp, key)).resolves.toMatchObject({ acknowledged: true })
    await expect(readProjectionAcknowledgement(lagging, key)).resolves.toMatchObject({ acknowledged: false })
  })

  it('reports WHICH projector instance published the acknowledgement', async () => {
    // The numbers alone are not permission: a row can be caught up and have been
    // written by a projector on another cell after a failover. The caller
    // compares this to the instance it has resident.
    const key = { landscapeId: 'ls', versionId: 'v1' }
    const caughtUpUnnamed = { query: async () => ({
      rows: [{ observed_generation: 8, projected_generation: 8, projector_attached: true }], rowCount: 1,
    }) } as Queryable
    const named = { query: async () => ({
      rows: [{
        observed_generation: 8, projected_generation: 8,
        projector_attached: true, projector_instance_id: 'cell-b',
      }],
      rowCount: 1,
    }) } as Queryable
    await expect(readProjectionAcknowledgement(named, key))
      .resolves.toEqual({ acknowledged: true, projectorInstanceId: 'cell-b' })
    // Absent column → null, never a fabricated id: "we do not know" must not be
    // mistaken for "it is ours".
    await expect(readProjectionAcknowledgement(caughtUpUnnamed, key))
      .resolves.toEqual({ acknowledged: true, projectorInstanceId: null })
  })
})
