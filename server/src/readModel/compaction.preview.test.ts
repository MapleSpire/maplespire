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
import { compactOverlay } from './compaction.js'

/**
 * PREVIEW mode: a fold count without a fold.
 *
 * `compactOverlay` rewrites base shards in place and clears the overlay, so
 * before pointing it at a workspace there must be a way to ask what it WOULD
 * do — and the answer has to be trustworthy in two separate directions:
 *
 *   (1) a preview must write NOTHING — zero `.change()` calls across every
 *       base, overlay and meta handle, counted rather than assumed.
 *   (2) a preview must predict the fold it forecasts. A preview whose counts
 *       drift from what apply then does is worse than no preview, because it is
 *       believed. The same fixture is previewed and then applied, and the counts
 *       must be equal.
 *
 * The third detector is the TYPE, not a test: `CompactionOptions.mode` is
 * required with no default, so a production call site that forgets to declare
 * its side does not compile. Test call sites are NOT covered by the server
 * typecheck configs (they exclude `src/**\/*.test.ts`), so there the omission
 * surfaces at runtime instead.
 */

type Obj = { id: string; name: string }
type ObjShard = { objects: Record<string, Obj> }

interface Built {
  repo: Repo
  rootUrl: string
  handles: DocHandle<unknown>[]
}

/** A model with base shards, an edits overlay and optional tombstones. Kept
 *  separate from `compaction.test.ts`'s builder so that this file's fixture can
 *  hand back EVERY handle a write could land on — which is the thing detector
 *  (1) counts. */
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
  const handles = [...baseObj, ...(overlayObj ? [overlayObj] : []), meta, root] as DocHandle<unknown>[]
  await Promise.all(handles.map((h) => h.whenReady()))
  return { repo, rootUrl: root.url, handles }
}

/**
 * Count `.change()` on every handle the repo hands out, including ones created
 * DURING the call.
 *
 * Patching only the fixture's handles would miss the head document compaction
 * mints for itself, and "no write to the documents already known about" is a
 * much weaker claim than the one this test is making.
 */
function countChanges(repo: Repo, existing: DocHandle<unknown>[] = []): { calls: () => number; restore: () => void } {
  let calls = 0
  const seen = new Set<DocHandle<unknown>>()
  const patch = (handle: DocHandle<unknown>) => {
    if (!handle || seen.has(handle)) return handle
    seen.add(handle)
    const original = handle.change.bind(handle)
    ;(handle as unknown as { change: unknown }).change = (...args: unknown[]) => {
      calls += 1
      return (original as (...a: unknown[]) => unknown)(...args)
    }
    return handle
  }
  // The fixture's own handles were minted before this spy existed, and
  // `repo.find` may return them from cache without re-creating them. Patched
  // through the SAME counter so the assertion covers all of them rather than two
  // tallies that could disagree.
  for (const handle of existing) patch(handle)
  const originalCreate = repo.create.bind(repo)
  const originalFind = repo.find.bind(repo)
  ;(repo as unknown as { create: unknown }).create = (...args: unknown[]) =>
    patch((originalCreate as (...a: unknown[]) => DocHandle<unknown>)(...args))
  ;(repo as unknown as { find: unknown }).find = async (...args: unknown[]) =>
    patch(await (originalFind as (...a: unknown[]) => Promise<DocHandle<unknown>>)(...args))
  return {
    calls: () => calls,
    restore: () => {
      ;(repo as unknown as { create: unknown }).create = originalCreate
      ;(repo as unknown as { find: unknown }).find = originalFind
    },
  }
}

const FIXTURE = {
  base: [{ o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' }, o2: { id: 'o2', name: 'C' } }],
  // o0 edited, o9 created (no base shard yet), o2 tombstoned.
  overlay: { o0: { id: 'o0', name: 'A-edited' }, o9: { id: 'o9', name: 'NEW' } },
  deleted: ['o2'],
}

describe('compactOverlay — preview mode (T-28b)', () => {
  it('DETECTOR 1 — preview issues zero changes', async () => {
    const b = await build(FIXTURE.base, FIXTURE.overlay, FIXTURE.deleted)
    const spy = countChanges(b.repo, b.handles)
    try {
      const res = await compactOverlay(b.repo, b.rootUrl, { mode: 'preview' })
      expect(res.objectsFolded, 'preview reported no fold at all — the fixture is wrong').toBeGreaterThan(0)
      expect(spy.calls(), 'preview WROTE — the early return is gone or came too late').toBe(0)
    } finally { spy.restore() }
  })

  it('DETECTOR 1b — the counter can see a write (control)', async () => {
    // Without this, `toBe(0)` above is satisfied just as well by a spy that never
    // counts anything, which is the shape of a gate that reports success having
    // done nothing.
    const b = await build(FIXTURE.base, FIXTURE.overlay, FIXTURE.deleted)
    const spy = countChanges(b.repo, b.handles)
    try {
      await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
      expect(spy.calls(), 'the change counter is blind — detector 1 proves nothing').toBeGreaterThan(0)
    } finally { spy.restore() }
  })

  it('DETECTOR 2 — preview counts equal apply counts', async () => {
    // Two identical fixtures rather than one reused: previewing and then applying
    // the SAME repo would let the preview's own effects (if any) shift the apply.
    const previewed = await build(FIXTURE.base, FIXTURE.overlay, FIXTURE.deleted)
    const applied = await build(FIXTURE.base, FIXTURE.overlay, FIXTURE.deleted)

    const p = await compactOverlay(previewed.repo, previewed.rootUrl, { mode: 'preview' })
    const a = await compactOverlay(applied.repo, applied.rootUrl, { mode: 'apply' })

    // ALL SIX counters, so `kept` and every other forecast is actually
    // compared, not just the fold counts.
    expect(p).toEqual(a)
    // Non-zero on both axes, or the equality above is two zeroes agreeing.
    expect(a.objectsFolded).toBeGreaterThan(0)
    expect(a.objectsDeleted).toBeGreaterThan(0)
  })

  it('preview leaves the documents byte-for-byte where they were', async () => {
    // The counts and the spy both go through compaction's own code. This asserts
    // the OUTCOME instead: the state a reader would see is unchanged.
    const b = await build(FIXTURE.base, FIXTURE.overlay, FIXTURE.deleted)
    const before = b.handles.map((h) => JSON.stringify(h.doc()))
    await compactOverlay(b.repo, b.rootUrl, { mode: 'preview' })
    expect(b.handles.map((h) => JSON.stringify(h.doc()))).toEqual(before)

    // Control: the same comparison after an APPLY must differ, or "unchanged"
    // was never a distinguishing observation.
    await compactOverlay(b.repo, b.rootUrl, { mode: 'apply' })
    expect(b.handles.map((h) => JSON.stringify(h.doc()))).not.toEqual(before)
  })
})
