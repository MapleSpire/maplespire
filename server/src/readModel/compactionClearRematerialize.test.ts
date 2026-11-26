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
import { Repo, generateAutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { compactOverlay, type CompactionOptions } from './compaction.js'
import { DEFAULT_REMATERIALIZE_GRACE_MS, OVERLAY_REMATERIALIZE_MESSAGE, rematerializeGraceMsFromEnv } from './overlayClearRematerialize.js'

/**
 * G4-16k: an offline edit made INSIDE an overlay
 * entry that a compaction cleared meanwhile, received after the clear, by a
 * browser that never comes back to rescue it. The NEXT pass writes her fields
 * where the entity lives now. Deterministic, in-memory, as compaction.test.ts.
 */

type Obj = { id: string; name: string; description?: string; properties?: Record<string, string> }
type ObjShard = { objects: Record<string, Obj> }
type Meta = { objectShardUrls: string[]; connectionShardUrls: string[]; editsObjectShardUrl?: string; deletedObjectIds?: string[] }

async function build() {
  const repo = new Repo({})
  const base = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'A' } } })
  const overlay = repo.create<ObjShard>({ objects: { o1: { id: 'o1', name: 'v1', description: 'd', properties: { k1: 'p1' } } } })
  const meta = repo.create<Meta>({ objectShardUrls: [base.url, overlay.url], connectionShardUrls: [], editsObjectShardUrl: overlay.url })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  await Promise.all([base, overlay, meta, root].map((h) => h.whenReady()))
  // Marie's browser holds the overlay as it is now, then goes offline.
  const marie = A.clone(overlay.doc() as A.Doc<ObjShard>)
  // The production caller always records its scans (`workspaceCompaction.ts`).
  return { repo, rootUrl: root.url, base, overlay, meta, marie, scans: memoryScans() }
}

/** Her offline edit reaches the server after the clear; her browser is gone. */
function deliver(overlay: DocHandle<ObjShard>, marie: A.Doc<ObjShard>, edit: (o: Obj) => void): void {
  const edited = A.change(marie, (d) => edit(d.objects.o1))
  overlay.update((doc) => A.merge(doc, edited))
}

/** Where o1 is projected: the last listed object shard holding it. */
function projected(repo: Repo, meta: DocHandle<Meta>): Obj | undefined {
  let found: Obj | undefined
  for (const url of meta.doc()!.objectShardUrls) {
    const handle = Object.values(repo.handles).find((h) => h.url === url) as DocHandle<ObjShard> | undefined
    const o = handle?.doc()?.objects?.o1
    if (o) found = o
  }
  return found ? JSON.parse(JSON.stringify(found)) as Obj : undefined
}

/** The scan table in memory: `rows` the heads, `lateSeen` the grace clock,
 * both in the order they were saved (the store reads the oldest first). */
function memoryScans(): NonNullable<CompactionOptions['clearScans']> & {
  rows: Map<string, readonly string[]>; lateSeen: Map<string, Readonly<Record<string, number>>>; done: Map<string, readonly string[]>; saves: number; purged: string[]
} {
  const rows = new Map<string, readonly string[]>()
  const lateSeen = new Map<string, Readonly<Record<string, number>>>()
  const done = new Map<string, readonly string[]>()
  const store = {
    rows,
    lateSeen,
    done,
    saves: 0,
    purged: [] as string[],
    load: async (collection: string) => new Map([...rows].filter(([k]) => k.startsWith(`${collection}:`))
      .map(([k, heads]) => [k.slice(collection.length + 1), { heads, lateSeen: lateSeen.get(k) ?? {}, done: done.get(k) ?? [] }])),
    save: async (collection: string, scans: ReadonlyArray<{ documentId: string; heads: readonly string[]; lateSeen?: Readonly<Record<string, number>>; done?: readonly string[] }>,
      options: { onlyNew?: boolean } = {}) => {
      store.saves += 1
      for (const scan of scans) {
        if (scan.heads.length === 0) continue
        const key = `${collection}:${scan.documentId}`
        if (options.onlyNew && rows.has(key)) continue
        rows.delete(key)
        rows.set(key, scan.heads)
        lateSeen.set(key, scan.lateSeen ?? {})
        done.set(key, scan.done ?? [])
      }
    },
    purge: async (collection: string, documentIds: readonly string[]) => {
      for (const id of documentIds) { rows.delete(`${collection}:${id}`); lateSeen.delete(`${collection}:${id}`); store.purged.push(id) }
    },
  }
  return store
}

describe('compactOverlay rematerializes an offline edit a clear erased (G4-16k)', () => {
  it('the browser that never comes back: the next pass writes her fields where the entity lives now', async () => {
    const b = await build()
    const first = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(first.objectsFolded).toBe(1)
    expect(b.overlay.doc()!.objects.o1).toBeUndefined()
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers'; o.properties!.k2 = 'p2' })
    // The defect: her change is in the overlay's history, named by nothing.
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'v1', properties: { k1: 'p1' } })

    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toEqual({ id: 'o1', name: 'hers', description: 'd', properties: { k1: 'p1', k2: 'p2' } })
    // Written with its own message, in the shard the entity lives in.
    const home = Object.values(b.repo.handles).find((h) => (h.doc() as ObjShard | undefined)?.objects?.o1 && h.url !== b.overlay.url) as DocHandle<ObjShard>
    const messages = A.getAllChanges(home.doc()!).map((raw) => A.decodeChange(raw).message)
    expect(messages).toContain(OVERLAY_REMATERIALIZE_MESSAGE)

    // Idempotent: a third pass owes nothing.
    const third = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(third.objectsRematerialized).toBeUndefined()
  })

  it('a late edit younger than the grace period waits, and its segment is read again next pass (m1 flag on)', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const rowsBefore = new Map(b.scans.rows)
    const young = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeGraceMs: 3_600_000 })
    expect(young.objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
    expect(b.scans.rows.get(`object:${b.overlay.documentId}`)).toEqual(rowsBefore.get(`object:${b.overlay.documentId}`))
    // Once due, written.
    const due = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeGraceMs: 0 })
    expect(due.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers')
  })

  it('the production grace: a day by default, the environment variable otherwise, a bad value refused', () => {
    expect(rematerializeGraceMsFromEnv({})).toBe(DEFAULT_REMATERIALIZE_GRACE_MS)
    expect(DEFAULT_REMATERIALIZE_GRACE_MS).toBe(86_400_000)
    expect(rematerializeGraceMsFromEnv({ OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS: '0' })).toBe(0)
    expect(() => rematerializeGraceMsFromEnv({ OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS: '-1' })).toThrow()
  })

  it('a segment with no row starts at its heads — an edit erased before the deployment is not repaired', async () => {
    const b = await build()
    // Before the deployment: a pass without the step clears o1, her late edit arrives.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    deliver(b.overlay, b.marie, (o) => { o.name = 'before-deployment' })
    // Named as a production meta names it (the plural list keeps rotated segments).
    b.meta.change((m) => { (m as Meta & { editsObjectShardUrls?: string[] }).editsObjectShardUrls = [b.overlay.url, m.editsObjectShardUrl!] })
    // The first pass with the step: no row, so it starts at the heads it sees now.
    const first = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(first.objectsRematerialized).toBeUndefined()
    expect(b.scans.rows.get(`object:${b.overlay.documentId}`)).toEqual(A.getHeads(b.overlay.doc()!))
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
  })

  it('a segment created after the deployment is first seen before its first clear, and that clear is repaired', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // The fresh head this pass minted: a colleague writes o2 there, Marie holds it, goes offline.
    const headUrl = (b.meta.doc() as Meta).editsObjectShardUrl!
    const head = Object.values(b.repo.handles).find((h) => h.url === headUrl) as DocHandle<ObjShard>
    expect(b.scans.rows.has(`object:${head.documentId}`)).toBe(false)
    head.change((s) => { s.objects.o2 = { id: 'o2', name: 'fresh' } })
    const marie = A.clone(head.doc() as A.Doc<ObjShard>)
    // Its first clear: the row is recorded at the start of that same pass, before the fold.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(head.doc()!.objects.o2).toBeUndefined()
    expect(b.scans.rows.has(`object:${head.documentId}`)).toBe(true)
    head.update((doc) => A.merge(doc, A.change(marie, (d) => { d.objects.o2.name = 'hers' })))
    const third = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(third.objectsRematerialized).toBe(1)
    let o2: Obj | undefined
    for (const url of (b.meta.doc() as Meta).objectShardUrls) {
      const h = Object.values(b.repo.handles).find((x) => x.url === url) as DocHandle<ObjShard> | undefined
      if (h?.doc()?.objects?.o2) o2 = JSON.parse(JSON.stringify(h.doc()!.objects.o2)) as Obj
    }
    expect(o2?.name).toBe('hers')
  })

  it('a first sighting whose row cannot be saved refuses the fold — nothing is cleared before its starting point', async () => {
    const b = await build()
    const failing = { ...b.scans, save: async () => { throw new Error('scan table unreachable') } }
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: failing })
    expect(pass.skippedReason).toBe('rematerialize_cursor_unsaved')
    expect(pass.objectsFolded).toBe(0)
    expect(b.overlay.doc()!.objects.o1).toBeDefined()
    // Saved next time: folds.
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })).objectsFolded).toBe(1)
  })

  it('the write she unchecked is never written back; her later re-edit of the same field, erased by a new clear, is', async () => {
    const b = await build()
    // She declined 'hers' for o1's name in the batch re-apply (an override row `dismissed`).
    const declinedEdits = async (_collection: string, ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'o1').map((id) => [id, [{ path: ['name'], value: 'hers' }]]))
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers'; o.description = 'her description' })
    const declinedPass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    // Her other field is repaired; the declined one is not.
    expect(declinedPass.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'v1', description: 'her description' })
    // She edits the name again, online, into the current head; holds it; goes offline.
    const headUrl = (b.meta.doc() as Meta).editsObjectShardUrl!
    const head = Object.values(b.repo.handles).find((h) => h.url === headUrl) as DocHandle<ObjShard>
    head.change((s) => { s.objects.o1 = { ...(projected(b.repo, b.meta) as Obj) } })
    const offline = A.clone(head.doc() as A.Doc<ObjShard>)
    // A new clear erases her entry; her offline re-edit arrives after it.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(head.doc()!.objects.o1).toBeUndefined()
    head.update((doc) => A.merge(doc, A.change(offline, (d) => { d.objects.o1.name = 'hers-again' })))
    const repaired = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(repaired.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers-again')
    // And the declined value never comes back on a later pass.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(projected(b.repo, b.meta)?.name).toBe('hers-again')
  })

  for (const paulFirst of [false, true]) {
    it(`Marie declines her erased edit, Paul edits the field ${paulFirst ? 'BEFORE' : 'after'} she declines — Paul's value stays, in the documents her store projects`, async () => {
      const b = await build()
      await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
      deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
      const home = () => Object.values(b.repo.handles).find((h) => h.url !== b.overlay.url
        && (h.doc() as ObjShard | undefined)?.objects?.o1) as DocHandle<ObjShard>
      let declinedRows: Array<{ path: string[]; value: unknown }> = []
      const declinedEdits = async (_c: string, ids: readonly string[]) =>
        new Map(ids.filter((id) => id === 'o1' && declinedRows.length).map((id) => [id, declinedRows]))
      const paul = () => home().change((s) => { s.objects.o1.name = 'paul' })
      if (paulFirst) paul()
      declinedRows = [{ path: ['name'], value: 'hers' }]
      if (!paulFirst) paul()
      // The pass, grace elapsed (0 here), then another.
      await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits, rematerializeGraceMs: 0 })
      expect(projected(b.repo, b.meta)?.name).toBe('paul')
      await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits, rematerializeGraceMs: 0 })
      expect(projected(b.repo, b.meta)?.name).toBe('paul')
      // Her replica, once synced, holds the same shards: the same projection.
      const replica = A.merge(A.init<ObjShard>(), home().doc()!)
      expect(replica.objects.o1.name).toBe('paul')
    })
  }

  it('never resurrects a tombstone: an entity deleted since stays deleted', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    b.meta.change((m) => { m.deletedObjectIds = ['o1'] })
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)).toBeUndefined()
  })

  it('a colleague\'s later write of the same field wins; her other fields are written', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // Paul, online, renames it where it lives now (the folded base copy).
    const home = Object.values(b.repo.handles).find((h) => h.url !== b.overlay.url && (h.doc() as ObjShard | undefined)?.objects?.o1) as DocHandle<ObjShard>
    home.change((s) => { s.objects.o1.name = 'paul' })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers'; o.description = 'her description' })
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'paul', description: 'her description' })
  })

  it('written into the copy that is projected: the LAST listed shard holding it', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // A colleague edits another field after the fold: his copy is a new overlay entry, listed last.
    const head = Object.values(b.repo.handles).find((h) => h.url === (b.meta.doc() as Meta).editsObjectShardUrl) as DocHandle<ObjShard>
    head.change((s) => { s.objects.o1 = { id: 'o1', name: 'v1', description: 'his', properties: { k1: 'p1' } } })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    // Rematerialized (into his entry), then folded and cleared by the same pass.
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'hers', description: 'his' })
  })

  it('a colleague\'s explicit delete of the entry (not the clear) is never undone', async () => {
    const b = await build()
    // The entity also lives in the base: only the message keeps her edit out.
    b.base.change((s) => { s.objects.o1 = { id: 'o1', name: 'v1', description: 'd', properties: { k1: 'p1' } } })
    b.overlay.change((s) => { delete s.objects.o1 })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(pass.objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
  })

  it('split delivery over two passes: her LAST value wins over the first pass\'s own write', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    const first = A.change(b.marie, (d) => { d.objects.o1.name = 'first' })
    // A clone: an Automerge 3 document handed to `change` must not be merged afterwards.
    const second = A.change(A.clone(first), (d) => { d.objects.o1.name = 'second' })
    b.overlay.update((doc) => A.merge(doc, first))
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('first')
    b.overlay.update((doc) => A.merge(doc, second))
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('second')
  })

  it('a segment no list names any more (a chain fold delisted it) is still scanned', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    b.meta.change((m) => {
      const at = m.objectShardUrls.indexOf(b.overlay.url)
      if (at >= 0) m.objectShardUrls.splice(at, 1)
    })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers')
  })

  it('a failure is on the pass\'s result, the fold goes on, and the scan is read again next time', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const failing = { ...b.scans, save: async () => { throw new Error('scan table unreachable') } }
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: failing })
    expect(second.rematerializeFailed?.join(' ')).toMatch(/objects: scan table unreachable/)
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers')
  })

  it('never writes into an overlay segment that is no longer the write head: into the current head', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // A copy of the entity in the OLD segment again (a resident tab fills it): the last listed copy.
    b.overlay.change((s) => { s.objects.o1 = { id: 'o1', name: 'v1', description: 'd', properties: { k1: 'p1' } } })
    deliver(b.overlay, b.marie, (o) => { o.description = 'hers' })
    const headUrl = (b.meta.doc() as Meta).editsObjectShardUrl!
    const messagesOf = (url: string) => {
      const handle = Object.values(b.repo.handles).find((h) => h.url === url) as DocHandle<ObjShard>
      return A.getAllChanges(handle.doc()!).map((raw) => A.decodeChange(raw).message)
    }
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(pass.objectsRematerialized, JSON.stringify(pass)).toBe(1)
    expect(messagesOf(headUrl)).toContain(OVERLAY_REMATERIALIZE_MESSAGE)
    expect(messagesOf(b.overlay.url)).not.toContain(OVERLAY_REMATERIALIZE_MESSAGE)
    expect(projected(b.repo, b.meta)?.description).toBe('hers')
  })

  it('a preview writes nothing; the scan is recorded only by an applied pass, and read from there next time', async () => {
    const b = await build()
    const scans = memoryScans()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: scans })
    expect(scans.saves).toBe(1)
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const preview = await compactOverlay(b.repo, b.rootUrl, { mode: 'preview', clearScans: scans })
    expect(preview.objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
    expect(scans.saves).toBe(1)
    // Her change came after the recorded scan: found from it.
    const second = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: scans })
    expect(second.objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers')
  })

  it('a named segment with no row that the STEP could not resolve in its ceiling refuses the fold', async () => {
    const b = await build()
    // The step's ceiling is a quarter of the pass's, at most; the load alone
    // outlasts it here, so the step resolves nothing — the fold, with its own
    // ceiling taken after, would resolve the segment and clear it.
    const slow = { ...b.scans, load: async (collection: 'object' | 'connection') => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return b.scans.load(collection)
    } }
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: slow, resolveDeadlineMs: 100 })
    expect(pass.rematerializeFailed?.join(' ')).toMatch(/objects:/)
    expect(pass.skippedReason).toBe('rematerialize_cursor_unsaved')
    expect(pass.objectsFolded).toBe(0)
    expect(b.overlay.doc()!.objects.o1).toBeDefined()
    // A scan table that cannot be READ: which segments have a row is unknown — refused too.
    const unreadable = { ...b.scans, load: async () => { throw new Error('scan table unreachable') } }
    const blind = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: unreadable })
    expect(blind.skippedReason).toBe('rematerialize_cursor_unsaved')
    expect(b.overlay.doc()!.objects.o1).toBeDefined()
    // Control: the same pass with time to resolve records the row, then folds.
    const next = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    expect(next.objectsFolded).toBe(1)
    expect(b.scans.rows.has(`object:${b.overlay.documentId}`)).toBe(true)
  })

  it('ownership lost inside the step stops the pass — and the new head was recorded at its first sighting', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const headId = (b.meta.doc() as Meta).editsObjectShardUrl!.slice('automerge:'.length)
    expect(b.scans.rows.has(`object:${headId}`)).toBe(false)
    // Lost at the step's consultation, back by the fold's (a lease that flaps).
    let asked = 0
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, stillSafeToWrite: async () => (asked += 1) > 1 })
    expect(asked).toBe(1)
    expect(pass.skippedReason).toBe('ownership_lost_mid_fold')
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
    expect(b.scans.rows.has(`object:${headId}`)).toBe(true)
  })

  it('ownership re-asked right before the cursor save — lost there, nothing is recorded and the pass stops', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const key = `object:${b.overlay.documentId}`
    const before = b.scans.rows.get(key)
    let asked = 0
    // True at the write, false at the save.
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, stillSafeToWrite: async () => (asked += 1) === 1 })
    expect(asked).toBe(2)
    expect(pass.skippedReason).toBe('ownership_lost_mid_fold')
    expect(b.scans.rows.get(key)).toEqual(before)
  })

  it('a first sighting only INSERTS its row — a row another pass saved meanwhile is never moved', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    const headId = (b.meta.doc() as Meta).editsObjectShardUrl!.slice('automerge:'.length)
    // Another owner recorded the new head (its starting point) after this pass loaded the rows.
    const theirs = ['aa'.repeat(32)]
    const racing = { ...b.scans, load: async (collection: 'object' | 'connection') => {
      const rows = await b.scans.load(collection)
      await b.scans.save(collection, [{ documentId: headId, heads: theirs }])
      return rows
    } }
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: racing })
    expect(b.scans.rows.get(`object:${headId}`)).toEqual(theirs)
  })

  it('the writes are flushed BEFORE the scan moves past them — a failed flush records nothing', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const key = `object:${b.overlay.documentId}`
    const before = b.scans.rows.get(key)
    const flush = b.repo.flush.bind(b.repo)
    let failed = 0
    b.repo.flush = async (ids) => {
      // Only the step's own flush of the shard it wrote fails.
      if (failed === 0 && ids && ids.length > 0) { failed += 1; throw new Error('storage refused the flush') }
      return flush(ids)
    }
    const pass = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    b.repo.flush = flush
    expect(failed).toBe(1)
    expect(pass.rematerializeFailed?.join(' ')).toMatch(/storage refused the flush/)
    expect(b.scans.rows.get(key)).toEqual(before)
  })

  it('the grace runs on the SERVER\'s clock from each change\'s first sighting — an author clock in the past or the future changes nothing', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    const HOUR = 3_600_000
    const t0 = 1_900_000_000_000
    const pass = (at: number) => compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeGraceMs: HOUR, now: () => at })
    // Her device's clock says 1970: by the author's clock it would be due at once.
    const first = A.change(b.marie, { time: 0 }, (d) => { d.objects.o1.name = 'first' })
    b.overlay.update((doc) => A.merge(doc, first))
    expect((await pass(t0)).objectsRematerialized).toBeUndefined()
    // Split delivery: her second change, from a clock a year ahead, first seen 50 minutes later.
    const second = A.change(A.clone(first), { time: Math.floor((t0 + 365 * 24 * HOUR) / 1000) }, (d) => { d.objects.o1.description = 'second' })
    b.overlay.update((doc) => A.merge(doc, second))
    expect((await pass(t0 + 50 * 60_000)).objectsRematerialized).toBeUndefined()
    // 70 minutes: the first change is past its grace, the second is not — the entry waits for BOTH.
    expect((await pass(t0 + 70 * 60_000)).objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
    // 111 minutes: both are, whatever her clocks said.
    expect((await pass(t0 + 111 * 60_000)).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'first', description: 'second' })
  })

  it('an entry covered by a PENDING override row writes NOTHING and is not scanned past until she decides — a colleague\'s revert of its other field stays', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers'; o.description = 'hers-d' })
    const key = `object:${b.overlay.documentId}`
    const before = b.scans.rows.get(key)
    let state: 'pending' | 'dismissed' = 'pending'
    // A row on her name, whatever value the row carries.
    const declinedEdits = async (_c: string, ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'o1').map((id) => [id, [{ path: ['name'], value: 'another value', ...(state === 'pending' ? { pending: true as const } : {}) }]]))
    const homeOf = () => Object.values(b.repo.handles).find((h) => h.url !== b.overlay.url && (h.doc() as ObjShard | undefined)?.objects?.o1) as DocHandle<ObjShard>
    // Pending: nothing of the entry is written, and the scan stays where it was.
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })).objectsRematerialized).toBeUndefined()
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'v1', description: 'd' })
    expect(b.scans.rows.get(key)).toEqual(before)
    // The case it guards: a colleague sets the description (to the value
    // the clear saw, then to his own); the next passes never write over it.
    homeOf().change((s) => { s.objects.o1.description = 'd' })
    const passes: Array<number | undefined> = []
    for (let i = 0; i < 2; i++) passes.push((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })).objectsRematerialized)
    expect(passes).toEqual([undefined, undefined])
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'v1', description: 'd' })
    homeOf().change((s) => { s.objects.o1.description = 'his' })
    expect(b.scans.rows.get(key)).toEqual(before)
    // She decides (the row is dismissed with ANOTHER value than hers): her
    // name is owed like any other, written once; his later description wins.
    state = 'dismissed'
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'hers', description: 'his' })
    expect(b.scans.rows.get(key)).not.toEqual(before)
  })

  it('a HELD entry keeps the first sighting of its changes — written at the first pass after her decision, not one grace later', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers'; o.description = 'hers-d' })
    let state: 'pending' | 'gone' = 'pending'
    const declinedEdits = async (_c: string, ids: readonly string[]) =>
      new Map(state === 'gone' ? [] : ids.filter((id) => id === 'o1').map((id) => [id, [{ path: ['name'], value: 'x', pending: true as const }]]))
    let t = 0
    const pass = () => compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits, rematerializeGraceMs: 1000, now: () => t })
    const key = `object:${b.overlay.documentId}`
    // t0: first sighting, in its grace.
    expect((await pass()).objectsRematerialized).toBeUndefined()
    const firstSighting = { ...(b.scans.lateSeen.get(key) ?? {}) }
    expect(Object.values(firstSighting)).not.toHaveLength(0)
    expect(Object.values(firstSighting).every((at) => at === 0)).toBe(true)
    // t2000: past its grace, held by the pending row — the first sighting stays.
    t = 2000
    expect((await pass()).objectsRematerialized).toBeUndefined()
    expect(b.scans.lateSeen.get(key)).toEqual(firstSighting)
    // t2500: she has decided (the row is gone): written at once.
    state = 'gone'
    t = 2500
    expect((await pass()).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)).toMatchObject({ name: 'hers', description: 'hers-d' })
  })

  it('a parked row keeps `done` only for the late changes it still reads — a key left by an older server or cursor goes', async () => {
    const b = await build()
    b.overlay.change((s) => { s.objects.o2 = { id: 'o2', name: 'v2' } })
    const marie = A.clone(b.overlay.doc() as A.Doc<ObjShard>)
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    b.overlay.update((doc) => A.merge(doc, A.change(marie, (d) => { d.objects.o1.name = 'hers'; d.objects.o2.name = 'hers2' })))
    const declinedEdits = async (_c: string, ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'o1').map((id) => [id, [{ path: ['name'], value: 'hers', pending: true as const }]]))
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    const key = `object:${b.overlay.documentId}`
    const kept = b.scans.done.get(key) ?? []
    expect(kept.some((k) => k.startsWith('o2/'))).toBe(true)
    // An older server's update kept done_changes beside heads it moved:
    // keys for changes this scan never reads again.
    b.scans.done.set(key, [...kept, 'o9/0000', 'o2/ffff'])
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect([...(b.scans.done.get(key) ?? [])].sort()).toEqual([...kept].sort())
  })

  it('a NEW late change on an entry whose earlier change is done is written — the cursor never parks past it', async () => {
    const b = await build()
    b.overlay.change((s) => { s.objects.o2 = { id: 'o2', name: 'v2' } })
    const marie = A.clone(b.overlay.doc() as A.Doc<ObjShard>)
    const tablet = A.clone(b.overlay.doc() as A.Doc<ObjShard>, { actor: 'ab'.repeat(16) })
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // o1 held by a pending row parks the segment; o2's first late change is written (done).
    b.overlay.update((doc) => A.merge(doc, A.change(marie, (d) => { d.objects.o1.name = 'hers'; d.objects.o2.name = 'first' })))
    let decided = false
    const declinedEdits = async (_c: string, ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'o1' && !decided).map((id) => [id, [{ path: ['name'], value: 'hers', pending: true as const }]]))
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })).objectsRematerialized).toBe(1)
    const where = (id: string) => {
      let found: Obj | undefined
      for (const url of (b.meta.doc() as Meta).objectShardUrls) {
        const h = Object.values(b.repo.handles).find((x) => x.url === url) as DocHandle<ObjShard> | undefined
        if (h?.doc()?.objects?.[id]) found = h.doc()!.objects[id]
      }
      return found
    }
    expect(where('o2')?.name).toBe('first')
    // Her other device, also offline since before the clear, edits o2's description.
    b.overlay.update((doc) => A.merge(doc, A.change(tablet, (d) => { d.objects.o2.description = 'from the tablet' })))
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(where('o2')).toMatchObject({ name: 'first', description: 'from the tablet' })
    // Unparked by her decision: nothing of o2 is lost or undone.
    decided = true
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(where('o2')).toMatchObject({ name: 'first', description: 'from the tablet' })
    expect(where('o1')?.name).toBe('hers')
  })

  it('a pending row parks ITS entry, not the segment — a colleague\'s revert of another entry already written back stays', async () => {
    const b = await build()
    // A second entry in the segment, held by Marie's browser too.
    b.overlay.change((s) => { s.objects.o2 = { id: 'o2', name: 'v2' } })
    const marie = A.clone(b.overlay.doc() as A.Doc<ObjShard>)
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // ONE offline change of hers writes inside both cleared entries.
    b.overlay.update((doc) => A.merge(doc, A.change(marie, (d) => { d.objects.o1.name = 'hers'; d.objects.o2.name = 'hers2' })))
    let decided = false
    const declinedEdits = async (_c: string, ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'o1').map((id) => [id, [decided
        ? { path: ['name'], value: 'another value' }
        : { path: ['name'], value: 'hers', pending: true as const }]]))
    const first = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(first.objectsRematerialized).toBe(1)
    const where = (id: string) => {
      let found: Obj | undefined
      for (const url of (b.meta.doc() as Meta).objectShardUrls) {
        const h = Object.values(b.repo.handles).find((x) => x.url === url) as DocHandle<ObjShard> | undefined
        if (h?.doc()?.objects?.[id]) found = h.doc()!.objects[id]
      }
      return found
    }
    expect(where('o2')?.name).toBe('hers2')
    expect(where('o1')?.name).toBe('v1')
    // A colleague sets o2 back to what the clear saw, where it lives now.
    const home = Object.values(b.repo.handles).find((h) => h.url !== b.overlay.url && (h.doc() as ObjShard | undefined)?.objects?.o2) as DocHandle<ObjShard>
    home.change((s) => { s.objects.o2.name = 'v2' })
    // The segment stays parked for o1; o2 is not written again.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })
    expect(where('o2')?.name).toBe('v2')
    expect(where('o1')?.name).toBe('v1')
    // She decides (dismissed, on another value): o1 — still owed — is written;
    // o2 is not written over the colleague's revert either.
    decided = true
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, declinedEdits })).objectsRematerialized).toBe(1)
    expect(where('o1')?.name).toBe('hers')
    expect(where('o2')?.name).toBe('v2')
  })

  it('a segment slow to resolve, or still listed as a base shard, keeps its row', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    const slow = b.repo.create<ObjShard>({ objects: {} })
    await slow.whenReady()
    await b.scans.save('object', [{ documentId: String(slow.documentId), heads: A.getHeads(slow.doc()!) }])
    // The base shard is listed; give it a row as a segment an earlier pass scanned.
    await b.scans.save('object', [{ documentId: String(b.base.documentId), heads: A.getHeads(b.base.doc()!) }])
    const find = b.repo.find.bind(b.repo)
    let refusedSlow = 0
    let refusedBase = 0
    b.repo.find = (async (url: string, opts?: unknown) => {
      if (url === slow.url && refusedSlow++ === 0) throw new Error('The operation was aborted due to timeout')
      if (url === b.base.url && refusedBase++ === 0) throw new Error(`Document ${url} is unavailable`)
      return find(url as never, opts as never)
    }) as typeof b.repo.find
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    b.repo.find = find
    expect(refusedSlow).toBeGreaterThan(0)
    expect(refusedBase).toBeGreaterThan(0)
    expect(b.scans.purged).toEqual([])
    expect(b.scans.rows.has(`object:${slow.documentId}`)).toBe(true)
    expect(b.scans.rows.has(`object:${b.base.documentId}`)).toBe(true)
  })

  it('the scan gives the event loop back between its steps', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // A long history behind the late edit: 600 more changes in the segment.
    const head = Object.values(b.repo.handles).find((h) => h.url === (b.meta.doc() as Meta).editsObjectShardUrl) as DocHandle<ObjShard>
    for (let i = 0; i < 600; i++) b.overlay.change((s) => { s.objects[`f${i}`] = { id: `f${i}`, name: `f${i}` } })
    expect(head).toBeDefined()
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    let yields = 0
    const pass = await compactOverlay(b.repo, b.rootUrl, {
      mode: 'apply', clearScans: b.scans, yieldToEventLoop: async () => { yields += 1; await new Promise((resolve) => setImmediate(resolve)) },
    })
    expect(pass.objectsRematerialized).toBe(1)
    // At least once per 256 changes decoded, twice over (the changes since, then the history).
    expect(yields).toBeGreaterThanOrEqual(4)
  })

  it('a per-pass decode budget — the segment that crosses it is the last read; the next pass starts with the rest', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    // A second known segment, read after the first (its row saved later).
    const other = b.repo.create<ObjShard>({ objects: { q: { id: 'q', name: 'q' } } })
    await other.whenReady()
    await b.scans.save('object', [{ documentId: String(other.documentId), heads: A.getHeads(other.doc()!) }])
    other.change((s) => { s.objects.q.name = 'q2' })
    const order = () => [...b.scans.rows.keys()].filter((k) => k.endsWith(String(other.documentId)) || k.endsWith(String(b.overlay.documentId)))
    const otherKey = `object:${other.documentId}`
    const otherBefore = b.scans.rows.get(otherKey)
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeDecodeBudget: 1 })
    // The overlay (older row) was read; the other one was not: its row did not move.
    expect(b.scans.rows.get(otherKey)).toEqual(otherBefore)
    expect(order().at(0)).toBe(otherKey)
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeDecodeBudget: 1 })
    expect(b.scans.rows.get(otherKey)).toEqual(A.getHeads(other.doc()!))
  })

  it('the segments known only by their row are resolved a bounded number per pass, the least recently scanned first; a gone one is purged', async () => {
    const b = await build()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans })
    const docs = await Promise.all([0, 1, 2].map(async (i) => {
      const h = b.repo.create<ObjShard>({ objects: { [`u${i}`]: { id: `u${i}`, name: `u${i}` } } })
      await h.whenReady()
      return h
    }))
    // A row for a document the repo never held (collected): answered unavailable.
    const goneId = generateAutomergeUrl().slice('automerge:'.length)
    await b.scans.save('object', [{ documentId: goneId, heads: ['00'.repeat(32)] }])
    await b.scans.save('object', docs.map((h) => ({ documentId: String(h.documentId), heads: A.getHeads(h.doc()!) })))
    for (const h of docs) h.change((s) => { s.objects[Object.keys(s.objects)[0]!]!.name = 'moved' })
    const rowOf = (h: DocHandle<ObjShard>) => b.scans.rows.get(`object:${h.documentId}`)
    // Unnamed, oldest row first: the first pass's segment (its head rotated),
    // the gone one, u0, u1, u2.
    const pass1 = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeUnnamedPerPass: 3 })
    expect(pass1.skippedReason).toBeUndefined()
    // The three least recently scanned: the old segment, the gone one (purged), u0 (read).
    expect(b.scans.purged).toEqual([goneId])
    expect(rowOf(docs[0]!)).toEqual(A.getHeads(docs[0]!.doc()!))
    expect(rowOf(docs[1]!)).not.toEqual(A.getHeads(docs[1]!.doc()!))
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: b.scans, rematerializeUnnamedPerPass: 3 })
    expect(rowOf(docs[1]!)).toEqual(A.getHeads(docs[1]!.doc()!))
    expect(rowOf(docs[2]!)).toEqual(A.getHeads(docs[2]!.doc()!))
  })

  it('a pass whose ownership moved writes nothing and moves no recorded scan (a first sighting is only ever inserted)', async () => {
    const b = await build()
    const scans = memoryScans()
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: scans })
    deliver(b.overlay, b.marie, (o) => { o.name = 'hers' })
    const before = new Map(scans.rows)
    expect(before.size).toBeGreaterThan(0)
    const lost = await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: scans, stillSafeToWrite: async () => false })
    expect(lost.skippedReason).toBe('ownership_lost_mid_fold')
    expect(projected(b.repo, b.meta)?.name).toBe('v1')
    for (const [key, heads] of before) expect(scans.rows.get(key), key).toEqual(heads)
    // The owner's next pass still finds her edit from where it was.
    expect((await compactOverlay(b.repo, b.rootUrl, { mode: 'apply', clearScans: scans })).objectsRematerialized).toBe(1)
    expect(projected(b.repo, b.meta)?.name).toBe('hers')
  })
})
