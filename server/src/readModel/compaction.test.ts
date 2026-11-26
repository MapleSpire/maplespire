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
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { getHeads } from '@automerge/automerge'
import { COMPACTION_RESOLVE_CONCURRENCY, compactOverlay, OVERLAY_COMPACTION_CLEAR_MESSAGE, readProjectionAcknowledgement } from './compaction.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import type { Queryable } from './types.js'
import { readMetaUrl, readMetaUrls } from '../modelMetaUrls.js'

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
    expect(readMetaUrl(b.meta.doc(), 'editsObjectShardUrl')).not.toBe(b.overlayObj!.url)
  })

  it('the clear\'s delete carries the clear message the browser rescue keys on — and only the clear\'s', async () => {
    expect(OVERLAY_COMPACTION_CLEAR_MESSAGE).toBe('maplespire:overlay-compaction-clear')
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } }],
      { o0: { id: 'o0', name: 'A-edited' } },
    )
    const before = getHeads(b.overlayObj!.doc() as never)
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    const changes = A.getChanges(A.view(b.overlayObj!.doc() as never, before), b.overlayObj!.doc() as never).map((raw) => A.decodeChange(raw))
    const deleting = changes.filter((c) => c.ops.some((op) => op.action === 'del' && op.key === 'o0'))
    expect(deleting.length).toBeGreaterThan(0)
    expect(deleting.every((c) => c.message === OVERLAY_COMPACTION_CLEAR_MESSAGE)).toBe(true)
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
    const urls = readMetaUrls(meta, 'objectShardUrls')
    // A new base shard and a fresh history-free write head were appended. The
    // cleared legacy overlay remains referenced for stale clients.
    expect(urls.length).toBe(4)
    expect(urls).toContain(overlayUrl)
    expect(readMetaUrl(meta, 'editsObjectShardUrl')).not.toBe(overlayUrl)
    expect(urls[urls.length - 1]).toBe(readMetaUrl(meta, 'editsObjectShardUrl'))
    // The protocol version the fold republishes. Nothing else pins it: a wrong
    // or missing version published here means every client flush bails
    // forever, silently, while online.
    expect(meta.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
    // The created object lives in the freshly-created base shard (not the full one).
    const newUrl = urls.find((u) => u !== overlayUrl && u !== readMetaUrl(meta, 'editsObjectShardUrl') && u !== b.baseObj[0].url)!
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
      events.push({ kind: 'meta-publish', urls: [...(readMetaUrls(b.meta.doc(), 'objectShardUrls') ?? [])] })
      return out
    }) as typeof b.meta.change

    const knownAtStart = new Set(readMetaUrls(b.meta.doc()!, 'objectShardUrls'))
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

  it('a CONNECTION late write pending refuses the pass BEFORE the objects pass writes anything', async () => {
    // Phase-3 review: the objects pass used to fold and flush, and only then
    // did the connections pass ask `lateWritesPending` and refuse — while the
    // caller logged "nothing was written". Both collections are asked first.
    const repo = new Repo({})
    const baseObj = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'A' } } })
    const overlayObj = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'A-edited' } } })
    const baseConn = repo.create<ConnShard>({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const retiredConn = repo.create<ConnShard>({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o2' } } })
    const currentConn = repo.create<ConnShard>({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [baseObj.url, overlayObj.url],
      connectionShardUrls: [baseConn.url, retiredConn.url, currentConn.url],
      editsObjectShardUrl: overlayObj.url,
      editsConnectionShardUrl: currentConn.url,
      editsConnectionShardUrls: [retiredConn.url, currentConn.url],
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([baseObj, overlayObj, baseConn, retiredConn, currentConn, meta, root].map((h) => h.whenReady()))
    const heads = (h: DocHandle<unknown>) => JSON.stringify(h.heads())
    const before = [baseObj, overlayObj, baseConn, retiredConn, currentConn, meta].map(heads)
    const asked: string[] = []
    const res = await compactOverlay(repo, root.url, {
      mode: 'apply',
      lateWritesPending: async (collection, segments) => {
        asked.push(collection)
        return collection === 'connection'
          ? segments.filter((s) => s.documentId === String(retiredConn.documentId)).map((s) => s.documentId)
          : []
      },
    })
    expect(res.skippedReason).toBe('retired_head_forward_pending')
    // Anti-void: both collections were asked, the objects pass had work to do.
    expect(asked.sort()).toEqual(['connection', 'object'])
    expect(res.objectsFolded).toBe(0)
    expect(baseObj.doc()?.objects.o0.name).toBe('A')
    expect(overlayObj.doc()?.objects.o0.name).toBe('A-edited')
    // NOTHING written, in any document.
    expect([baseObj, overlayObj, baseConn, retiredConn, currentConn, meta].map(heads)).toEqual(before)
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

  // ---- G4-16i: `settleRewrittenSegments` ----
  async function twoSegments() {
    const repo = new Repo({})
    const base = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'base' } } })
    const first = repo.create<ObjShard>({ objects: { n1: { id: 'n1', name: 'one' } } })
    const current = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'current' } } })
    const meta = repo.create({
      objectShardUrls: [base.url, first.url, current.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrls: [first.url, current.url],
      editsObjectShardUrl: current.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, first, current, meta, root].map((handle) => handle.whenReady()))
    return { repo, root, base, first, current, meta }
  }

  it('settleRewrittenSegments: called AFTER the clear and BEFORE the ModelMeta change, with every segment at its post-clear heads, flushed', async () => {
    const m = await twoSegments()
    const flushed: string[] = []
    const flush = m.repo.flush.bind(m.repo)
    m.repo.flush = async (ids?: string[]) => { flushed.push(...(ids ?? []).map(String)); return flush(ids as never) }
    const calls: Array<{ collection: string; segments: unknown; pointer: unknown; cleared: unknown; flushedBefore: string[] }> = []
    const result = await compactOverlay(m.repo, m.root.url, {
      mode: 'apply',
      settleRewrittenSegments: async (collection, segments) => {
        calls.push({
          collection,
          segments: segments.map((segment) => ({ ...segment, heads: [...segment.heads] })),
          // Not repointed yet.
          pointer: readMetaUrl(m.meta.doc(), 'editsObjectShardUrl'),
          cleared: [m.first.doc()?.objects, m.current.doc()?.objects],
          flushedBefore: [...flushed],
        })
      },
    })
    expect(result.objectsFolded).toBe(2)
    expect(calls).toHaveLength(1) // the connection collection had nothing to do
    expect(calls[0]).toMatchObject({
      collection: 'object',
      pointer: m.current.url,
      cleared: [{}, {}],
      segments: [
        { documentId: String(m.first.documentId), heads: getHeads(m.first.doc() as never), current: false },
        { documentId: String(m.current.documentId), heads: getHeads(m.current.doc() as never), current: true },
      ],
    })
    expect(calls[0]!.flushedBefore).toEqual(expect.arrayContaining([String(m.first.documentId), String(m.current.documentId)]))
    // And then repointed.
    expect(readMetaUrl(m.meta.doc(), 'editsObjectShardUrl')).not.toBe(m.current.url)
  })

  it('settleRewrittenSegments: the ModelMeta change that repoints the head comes AFTER it (crash order)', async () => {
    // A crash between the two must leave the rows and the OLD pointer, never a
    // repointed meta without rows: a spy on the meta's change, recording each
    // change's pointer move against the settle.
    const m = await twoSegments()
    const order: string[] = []
    const change = m.meta.change.bind(m.meta)
    ;(m.meta as unknown as { change: unknown }).change = (fn: (doc: unknown) => void) => {
      const before = readMetaUrl(m.meta.doc(), 'editsObjectShardUrl')
      change(fn as never)
      const after = readMetaUrl(m.meta.doc(), 'editsObjectShardUrl')
      order.push(before === after ? 'meta' : 'meta-repoint')
    }
    await compactOverlay(m.repo, m.root.url, {
      mode: 'apply',
      settleRewrittenSegments: async () => { order.push('settle') },
    })
    expect(order).toContain('meta-repoint')
    expect(order.indexOf('settle')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('settle')).toBeLessThan(order.indexOf('meta-repoint'))
  })

  it('settleRewrittenSegments: a THROW ends the pass with the pointer unmoved', async () => {
    const m = await twoSegments()
    await expect(compactOverlay(m.repo, m.root.url, {
      mode: 'apply',
      settleRewrittenSegments: async () => { throw new Error('settle refused') },
    })).rejects.toThrow('settle refused')
    expect(readMetaUrl(m.meta.doc(), 'editsObjectShardUrl')).toBe(m.current.url)
    expect(readMetaUrls(m.meta.doc(), 'editsObjectShardUrls')).toEqual([m.first.url, m.current.url])
  })

  it('settleRewrittenSegments: never asked in PREVIEW, nor by a refused pass', async () => {
    const m = await twoSegments()
    let asked = 0
    const settle = async () => { asked += 1 }
    await compactOverlay(m.repo, m.root.url, { mode: 'preview', settleRewrittenSegments: settle })
    const refused = await compactOverlay(m.repo, m.root.url, {
      mode: 'apply', settleRewrittenSegments: settle,
      lateWritesPending: async () => ({ reason: 'ordinary_fold_unpublished' as const, segments: ['x'] }),
    })
    expect(refused.skippedReason).toBe('ordinary_fold_unpublished')
    expect(asked).toBe(0)
    // Control: the same model, unrefused, asks.
    await compactOverlay(m.repo, m.root.url, { mode: 'apply', settleRewrittenSegments: settle })
    expect(asked).toBe(1)
  })

  it('settleRewrittenSegments: a TOMBSTONE-ONLY pass (nothing to fold) still settles — the tombstone deletes rewrote the overlay segments', async () => {
    const m = await twoSegments()
    m.meta.change((doc) => { (doc as { deletedObjectIds?: string[] }).deletedObjectIds = ['n1', 'o0'] })
    const seen: Array<{ documentId: string; heads: string[]; current: boolean }> = []
    const result = await compactOverlay(m.repo, m.root.url, {
      mode: 'apply',
      settleRewrittenSegments: async (_collection, segments) => { seen.push(...segments.map((s) => ({ ...s, heads: [...s.heads] }))) },
    })
    // Witness: the pass folded nothing and deleted through the tombstones.
    expect(result.objectsFolded).toBe(0)
    expect(result.objectsDeleted).toBe(2)
    expect(m.first.doc()?.objects).toEqual({})
    expect(seen).toEqual([
      { documentId: String(m.first.documentId), heads: getHeads(m.first.doc() as never), current: false },
      { documentId: String(m.current.documentId), heads: getHeads(m.current.doc() as never), current: true },
    ])
  })

  it('a refusal names its reason in the compaction.refused event (not the legacy one)', async () => {
    const m = await twoSegments()
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])) })
    try {
      await compactOverlay(m.repo, m.root.url, {
        mode: 'apply',
        lateWritesPending: async () => ({ reason: 'ordinary_fold_unpublished' as const, segments: ['x'] }),
      })
    } finally { spy.mockRestore() }
    const refused = warns.map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((line) => line?.event === 'compaction.refused')
    expect(refused).toEqual([{ event: 'compaction.refused', reason: 'ordinary_fold_unpublished', collection: 'objects', segments: ['x'] }])
  })

  // `x ?? (x = {})` yields the plain value the assignment was given, not the
  // document's proxy. The fold then CLEARS the overlay, so a value written into
  // the detached object is not merely dropped but deleted from the workspace.
  it('places a created object into a base shard that has NO collection map', async () => {
    const repo = new Repo({})
    const base = repo.create<Record<string, unknown>>({ marker: 1 })
    const overlay = repo.create<ObjShard>({ objects: { n0: { id: 'n0', name: 'New' } } })
    const meta = repo.create({
      objectShardUrls: [base.url, overlay.url], connectionShardUrls: [] as string[], editsObjectShardUrl: overlay.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, overlay, meta, root].map((handle) => handle.whenReady()))

    expect((await compactOverlay(repo, root.url, { mode: 'apply' })).objectsFolded).toBe(1)

    expect(base.doc()?.objects).toEqual({ n0: { id: 'n0', name: 'New' } })
    expect(overlay.doc()?.objects).toEqual({})
  })

  it('a ModelMeta WITHOUT objectShardUrls lists the new base shard and the fresh head', async () => {
    const repo = new Repo({})
    const overlay = repo.create<ObjShard>({ objects: { n0: { id: 'n0', name: 'New' } } })
    const meta = repo.create<Record<string, unknown>>({ connectionShardUrls: [], editsObjectShardUrl: overlay.url })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([overlay, meta, root].map((handle) => handle.whenReady()))

    expect((await compactOverlay(repo, root.url, { mode: 'apply' })).objectsFolded).toBe(1)

    const after = meta.doc() as { objectShardUrls?: string[]; editsObjectShardUrl?: string }
    // [new base shard, fresh write head]
    expect(readMetaUrls(after, 'objectShardUrls')).toHaveLength(2)
    expect(readMetaUrls(after, 'objectShardUrls')!.at(-1)).toBe(readMetaUrl(after, 'editsObjectShardUrl'))
    const placed = await repo.find<ObjShard>(readMetaUrls(after, 'objectShardUrls')![0] as never)
    expect(placed.doc()?.objects).toEqual({ n0: { id: 'n0', name: 'New' } })
  })

  // The fold-in-place and clear sites read a map that the PARTITION saw, so an
  // absent map there needs a peer's change landing during an await between the
  // two. `stillSafeToWrite` is awaited at exactly those points (before the first
  // write, before the clear), which is where a sync message can be applied.
  it('folds an edit even when a peer removed the base map while ownership was re-checked', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { o0: { id: 'o0', name: 'A-edited' } },
    )
    let calls = 0
    const res = await compactOverlay(b.repo, b.rootUrl, {
      mode: 'apply',
      stillSafeToWrite: async () => {
        calls += 1
        // First consultation of the objects pass: right before the fold writes.
        if (calls === 1) b.baseObj[0].change((s) => { delete (s as Partial<ObjShard>).objects })
        return true
      },
    })
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(res.objectsFolded).toBe(1)
    // The fold re-created the map and wrote through it: the edit is not left in
    // a detached object while the overlay copy is cleared below.
    expect(b.baseObj[0].doc()?.objects).toEqual({ o0: { id: 'o0', name: 'A-edited' } })
    expect(b.overlayObj!.doc()?.objects).toEqual({})
  })

  it('the clear pass leaves alone an overlay segment whose map a peer removed mid-fold', async () => {
    const b = await build(
      [{ o0: { id: 'o0', name: 'A' } }],
      { o0: { id: 'o0', name: 'A-edited' } },
    )
    let calls = 0
    const res = await compactOverlay(b.repo, b.rootUrl, {
      mode: 'apply',
      stillSafeToWrite: async () => {
        calls += 1
        // Second consultation of the objects pass: right before the clear.
        if (calls === 2) b.overlayObj!.change((s) => { delete (s as Partial<ObjShard>).objects })
        return true
      },
    })
    expect(calls).toBeGreaterThanOrEqual(2)
    // Nothing to clear, so nothing written: no throw on the absent map, and no
    // empty container re-created over the peer's removal.
    expect(res.objectsFolded).toBe(1)
    expect(b.baseObj[0].doc()?.objects.o0.name).toBe('A-edited')
    expect('objects' in (b.overlayObj!.doc() as object)).toBe(false)
  })

  it('a tombstone-only pass on a ModelMeta WITHOUT objectShardUrls still lists the fresh head', async () => {
    // The only path to the fresh-head push with the list still absent: no
    // created id means the base-shard splice above never ran to create it.
    const repo = new Repo({})
    const overlay = repo.create<ObjShard>({ objects: {} })
    const meta = repo.create<Record<string, unknown>>({
      connectionShardUrls: [], editsObjectShardUrl: overlay.url, deletedObjectIds: ['gone'],
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([overlay, meta, root].map((handle) => handle.whenReady()))

    await compactOverlay(repo, root.url, { mode: 'apply' })

    const after = meta.doc() as { objectShardUrls?: string[]; editsObjectShardUrl?: string }
    expect(readMetaUrl(after, 'editsObjectShardUrl')).not.toBe(overlay.url)
    expect(readMetaUrls(after, 'objectShardUrls')).toEqual([readMetaUrl(after, 'editsObjectShardUrl')])
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

describe('compactOverlay hands its base shards to the storage compaction (G4-16f diagnosis F1)', () => {
  const build2 = () => build([{ o0: { id: 'o0', name: 'A' } }, { o1: { id: 'o1', name: 'B' } }], { o1: { id: 'o1', name: 'B2' } })

  it('after an applied pass: every base shard, AFTER the clear and the ModelMeta change', async () => {
    const b = await build2()
    const seen: Array<{ url: string; clearedOverlay: boolean; metaMoved: boolean }> = []
    await compactOverlay(b.repo, b.rootUrl, {
      mode: 'apply',
      compactBaseShardStorage: async (handles) => {
        for (const handle of handles) {
          seen.push({
            url: handle.url,
            clearedOverlay: Object.keys(b.overlayObj!.doc()!.objects).length === 0,
            metaMoved: readMetaUrl(b.meta.doc(), 'editsObjectShardUrl') !== b.overlayObj!.url,
          })
        }
      },
    })
    expect(seen.map((s) => s.url).sort()).toEqual(b.baseObj.map((h) => h.url).sort())
    expect(seen.every((s) => s.clearedOverlay && s.metaMoved)).toBe(true)
  })

  it('a hook that THROWS does not fail the pass: the counts are the fold\'s', async () => {
    const b = await build2()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const res = await compactOverlay(b.repo, b.rootUrl, {
      mode: 'apply',
      compactBaseShardStorage: async () => { throw new Error('storage gone') },
    })
    expect(res.skippedReason).toBeUndefined()
    expect(res.objectsFolded).toBe(1)
    expect(warn.mock.calls.some(([line]) => String(line).includes('compaction.base_storage_failed'))).toBe(true)
  })

  it('never in preview, never on a refused pass', async () => {
    const b = await build2()
    let calls = 0
    const hook = async () => { calls += 1 }
    await compactOverlay(b.repo, b.rootUrl, { mode: 'preview', compactBaseShardStorage: hook })
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', compactBaseShardStorage: hook, lateWritesPending: async () => ['seg'] })
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', compactBaseShardStorage: hook, stillSafeToWrite: async () => false })
    expect(calls).toBe(0)
  })
})

describe('compactOverlay resolves base shards a few at a time (G4-16f diagnosis q1)', () => {
  it('never has more than COMPACTION_RESOLVE_CONCURRENCY base finds in flight, each with its own deadline', async () => {
    const base = Array.from({ length: 10 }, (_, i) => ({ [`o${i}`]: { id: `o${i}`, name: `N${i}` } }))
    const b = await build(base, { o3: { id: 'o3', name: 'edited' } })
    const baseUrls = new Set(b.baseObj.map((h) => h.url as string))
    const find = b.repo.find.bind(b.repo)
    let active = 0
    let maximum = 0
    const signals: AbortSignal[] = []
    vi.spyOn(b.repo, 'find').mockImplementation((async (url: string, options?: { signal?: AbortSignal }) => {
      if (!baseUrls.has(url)) return find(url as never, options as never)
      active += 1
      maximum = Math.max(maximum, active)
      if (options?.signal) signals.push(options.signal)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await find(url as never, options as never)
      } finally {
        active -= 1
      }
    }) as never)
    const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(res.objectsFolded).toBe(1)
    expect(maximum).toBe(COMPACTION_RESOLVE_CONCURRENCY)
    // One AbortSignal per find: a deadline of its own, not one shared clock.
    expect(new Set(signals).size).toBe(10)
  })

  it('ONE resolution ceiling for the whole pass: two lists each under it, together over it, are refused', async () => {
    const base = Array.from({ length: 6 }, (_, i) => ({ [`o${i}`]: { id: `o${i}`, name: `N${i}` } }))
    const b = await build(base, { o3: { id: 'o3', name: 'edited' } })
    const delayed = new Map<string, number>([[b.overlayObj!.url as string, 45], ...b.baseObj.map((h) => [h.url as string, 25] as [string, number])])
    const find = b.repo.find.bind(b.repo)
    vi.spyOn(b.repo, 'find').mockImplementation((async (url: string, options?: unknown) => {
      const ms = delayed.get(url)
      if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
      return find(url as never, options as never)
    }) as never)
    // Overlay list ~45 ms, base list ~50 ms (6 x 25 ms, 3 at a time): each
    // under 70 ms, the pass over it.
    await expect(compactOverlay(b.repo, b.rootUrl, { mode: 'apply', resolveDeadlineMs: 70 }))
      .rejects.toThrow(/compaction objects base shards \(what was left of the pass's single resolution ceiling\)/)
    // Control: the same pass with room resolves and folds.
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', resolveDeadlineMs: 10_000 })).objectsFolded).toBe(1)
  })

  it('objects and connections each under the ceiling, over it together, are refused', async () => {
    const repo = new Repo({})
    const objBase = Array.from({ length: 3 }, (_, i) => repo.create<ObjShard>({ objects: { [`o${i}`]: { id: `o${i}`, name: `N${i}` } } }))
    const objOverlay = repo.create<ObjShard>({ objects: { o1: { id: 'o1', name: 'edited' } } })
    const connBase = Array.from({ length: 3 }, (_, i) => repo.create<ConnShard>({ connections: { [`c${i}`]: { id: `c${i}`, fromId: 'o0', toId: 'o1' } } }))
    const connOverlay = repo.create<ConnShard>({ connections: { c1: { id: 'c1', fromId: 'o0', toId: 'o2' } } })
    const meta = repo.create({
      objectShardUrls: [...objBase.map((h) => h.url), objOverlay.url],
      connectionShardUrls: [...connBase.map((h) => h.url), connOverlay.url],
      editsObjectShardUrl: objOverlay.url,
      editsConnectionShardUrl: connOverlay.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([...objBase, objOverlay, ...connBase, connOverlay, meta, root].map((h) => h.whenReady()))
    // Every shard and segment 30 ms; three base shards resolve in one slot
    // round. Objects ~60 ms (segment, then base), connections ~60 ms: each
    // under 90 ms, the pass (~120 ms) over it.
    const delayed = new Set<string>([...objBase, objOverlay, ...connBase, connOverlay].map((h) => h.url as string))
    const find = repo.find.bind(repo)
    vi.spyOn(repo, 'find').mockImplementation((async (url: string, options?: unknown) => {
      if (delayed.has(url)) await new Promise((resolve) => setTimeout(resolve, 30))
      return find(url as never, options as never)
    }) as never)
    await expect(compactOverlay(repo, root.url, { mode: 'apply', resolveDeadlineMs: 90 }))
      .rejects.toThrow(/compaction connections .*single resolution ceiling/)
    // Control: with room, both collections fold.
    const res = await compactOverlay(repo, root.url, { mode: 'apply', resolveDeadlineMs: 10_000 })
    expect(res.objectsFolded).toBe(1)
    expect(res.connectionsFolded).toBe(1)
  })

  it('a base find that fails names the shard and its place', async () => {
    const b = await build([{ o0: { id: 'o0', name: 'A' } }, { o1: { id: 'o1', name: 'B' } }], { o0: { id: 'o0', name: 'A2' } })
    const failing = b.baseObj[1].url as string
    const find = b.repo.find.bind(b.repo)
    vi.spyOn(b.repo, 'find').mockImplementation((async (url: string, options?: unknown) => {
      if (url === failing) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      return find(url as never, options as never)
    }) as never)
    await expect(compactOverlay(b.repo, b.rootUrl, { mode: 'apply' }))
      .rejects.toThrow(new RegExp(`compaction objects base shards: ${failing} \\(2 of 2\\) not ready \\d+ ms after its own find started`))
  })
})
