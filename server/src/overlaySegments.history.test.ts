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
import * as A from '@automerge/automerge'
import { generateAutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { overlaySegmentUrls, publishOverlaySegment, type OverlayMetaLike } from './overlaySegments.js'
import { rewriteListInPlace } from './crdtListEdit.js'
import { adoptScalarMetaUrls, readMetaUrl, readMetaUrls } from './modelMetaUrls.js'
import { scalarRerun } from './testing/scalarRerun.js'

/**
 * G4-16f: ModelMeta's HISTORY per rotation. `publishOverlaySegment` used to
 * assign the whole segment list, re-creating every url (and every character
 * of each: strings are text) on every rotation — quadratic history, measured
 * at 7.7 M operations in ModelMeta at three years on the aged bench. Pure:
 * an Automerge document and a fake handle, no Repo, no database.
 */

type MetaHandle = Pick<DocHandle<OverlayMetaLike>, 'change'>
/** The `change` of a handle over a document held by the caller. */
const handleOver = (get: () => A.Doc<OverlayMetaLike>, set: (doc: A.Doc<OverlayMetaLike>) => void): MetaHandle =>
  ({ change: (fn: unknown) => { set(A.change(get(), fn as never)) } }) as unknown as MetaHandle

/** A ModelMeta document behind the `change` a handle exposes. */
function metaDoc(initial: OverlayMetaLike) {
  let doc = A.from<OverlayMetaLike>(initial)
  // G4-16f: in this suite's SECOND run (`modelMetaUrls.scalarAuthority.
  // test.ts`) the document is scalar-ruled from its start, as an epoch meta is
  // born, so the per-rotation cost measured is the steady state's.
  if (scalarRerun()) doc = A.change(doc, (d) => adoptScalarMetaUrls(d))
  return {
    handle: handleOver(() => doc, (next) => { doc = next }),
    get doc() { return doc },
    set doc(next: A.Doc<OverlayMetaLike>) { doc = next },
    ops: () => A.stats(doc as A.Doc<unknown>).numOps,
  }
}

/** A meta whose object segment list has `length` urls, the last current. */
function metaWith(length: number) {
  const urls = Array.from({ length }, () => generateAutomergeUrl())
  return metaDoc({
    objectShardUrls: [...urls],
    connectionShardUrls: [],
    editsObjectShardUrls: [...urls],
    editsObjectShardUrl: urls[urls.length - 1]!,
  })
}

/** Operations one rotation adds, averaged over `rotations` rotations. */
function opsPerRotation(length: number, rotations = 5): number {
  const meta = metaWith(length)
  const before = meta.ops()
  for (let i = 0; i < rotations; i += 1) publishOverlaySegment(meta.handle, 'objects', generateAutomergeUrl())
  return (meta.ops() - before) / rotations
}

describe('publishOverlaySegment: ModelMeta history per rotation (G4-16f)', () => {
  it('adds O(1) operations per rotation whatever the list length (RED on the whole-list assignment)', () => {
    const short = opsPerRotation(10)
    const long = opsPerRotation(200)
    // One url pushed into each of two lists, the pointer, the version: a few
    // hundred ops at most (a url is ~45 characters of text), and the same at
    // 10 and at 200 entries. The whole-list assignment costs ~L x 46 ops:
    // ~460 at 10, ~9 200 at 200 — a ratio near 20.
    expect(long / short).toBeLessThan(1.5)
    expect(long).toBeLessThan(400)
  })

  it('writes the same list as before: valid urls, first occurrence kept, the previous current moved last, then the new url', () => {
    const [a, b, c, d] = Array.from({ length: 4 }, () => generateAutomergeUrl())
    // The current head C is NOT physically last (a stale writer appended B
    // after it), the list holds a duplicate and a junk entry.
    const meta = metaDoc({
      objectShardUrls: [a!, c!, b!],
      connectionShardUrls: [],
      editsObjectShardUrls: [a!, c!, 'not-a-url', b!, a!],
      editsObjectShardUrl: c!,
    })
    const expected = [...overlaySegmentUrls(meta.doc, 'objects'), d!]
    publishOverlaySegment(meta.handle, 'objects', d!)
    expect([...readMetaUrls(meta.doc, 'editsObjectShardUrls')!]).toEqual(expected)
    expect(expected).toEqual([a, b, c, d])
    expect(readMetaUrl(meta.doc, 'editsObjectShardUrl')).toBe(d)
    expect(readMetaUrls(meta.doc, 'objectShardUrls')).toEqual([a, c, b, d])
  })

  it('an absent list is created and filled (Assign, then RE-READ)', () => {
    const url = generateAutomergeUrl()
    const meta = metaDoc({ objectShardUrls: [], connectionShardUrls: [] })
    publishOverlaySegment(meta.handle, 'objects', url)
    expect(readMetaUrls(meta.doc, 'editsObjectShardUrls')).toEqual([url])
    expect(readMetaUrls(meta.doc, 'objectShardUrls')).toEqual([url])
    expect(readMetaUrl(meta.doc, 'editsObjectShardUrl')).toBe(url)
  })

  it('republishing the current url changes nothing in the list', () => {
    const meta = metaWith(3)
    const before = [...readMetaUrls(meta.doc, 'editsObjectShardUrls')!]
    publishOverlaySegment(meta.handle, 'objects', readMetaUrl(meta.doc, 'editsObjectShardUrl')!)
    expect([...readMetaUrls(meta.doc, 'editsObjectShardUrls')!]).toEqual(before)
  })

  it('two writers publishing concurrently: both urls survive the merge, and the current one resolves the same on both sides', () => {
    const base = metaWith(3)
    // Two actors (a clone keeps its source's actor otherwise).
    let left = A.clone(base.doc, { actor: 'aa'.repeat(16) as A.ActorId })
    let right = A.clone(base.doc, { actor: 'bb'.repeat(16) as A.ActorId })
    const u1 = generateAutomergeUrl()
    const u2 = generateAutomergeUrl()
    publishOverlaySegment(handleOver(() => left, (next) => { left = next }), 'objects', u1)
    publishOverlaySegment(handleOver(() => right, (next) => { right = next }), 'objects', u2)
    const mergedLR = A.merge(A.clone(left), right)
    const mergedRL = A.merge(A.clone(right), left)
    for (const merged of [mergedLR, mergedRL]) {
      // A replaced list would keep ONE of the two lists: one url lost from
      // the segments (the old whole assignment did exactly that).
      expect(readMetaUrls(merged, 'editsObjectShardUrls')).toContain(u1)
      expect(readMetaUrls(merged, 'editsObjectShardUrls')).toContain(u2)
      expect(readMetaUrls(merged, 'objectShardUrls')).toContain(u1)
      expect(readMetaUrls(merged, 'objectShardUrls')).toContain(u2)
    }
    // Convergence: the same document, the same current, the same canonical order.
    expect(readMetaUrl(mergedLR, 'editsObjectShardUrl')).toBe(readMetaUrl(mergedRL, 'editsObjectShardUrl'))
    expect([u1, u2]).toContain(readMetaUrl(mergedLR, 'editsObjectShardUrl'))
    expect(overlaySegmentUrls(mergedLR, 'objects')).toEqual(overlaySegmentUrls(mergedRL, 'objects'))
    expect(overlaySegmentUrls(mergedLR, 'objects').at(-1)).toBe(readMetaUrl(mergedLR, 'editsObjectShardUrl'))
  })
})

describe('rewriteListInPlace', () => {
  const apply = (initial: string[], target: string[]) => {
    let doc = A.from<{ list: string[] }>({ list: initial })
    const before = A.stats(doc as A.Doc<unknown>).numOps
    doc = A.change(doc, (d) => rewriteListInPlace(d.list, target))
    return { list: [...doc.list], ops: A.stats(doc as A.Doc<unknown>).numOps - before }
  }

  it('reaches the target from any list', () => {
    for (const [initial, target] of [
      [['a', 'b', 'c'], ['a', 'b', 'c', 'd']],
      [['a', 'c', 'b'], ['a', 'b', 'c', 'd']],
      [['x', 'a', 'a'], ['a']],
      [[], ['a', 'b']],
      [['a', 'b'], []],
      [['b', 'a'], ['a', 'b']],
    ] as Array<[string[], string[]]>) {
      expect(apply(initial, target).list).toEqual(target)
    }
  })

  it('property: random lists and targets with duplicates (seeded) — the result is always the target', () => {
    // mulberry32: deterministic, so a failure reproduces from its seed.
    let seed = 0x16f
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
    const alphabet = ['a', 'b', 'c', 'd', 'e', 'f']
    const randomList = () => Array.from({ length: Math.floor(random() * 9) }, () => alphabet[Math.floor(random() * alphabet.length)]!)
    for (let run = 0; run < 300; run += 1) {
      const initial = randomList()
      const target = randomList()
      expect(apply(initial, target).list, `run ${run}: ${JSON.stringify(initial)} -> ${JSON.stringify(target)}`).toEqual(target)
    }
  })

  it('an append costs the appended element only', () => {
    const long = Array.from({ length: 100 }, (_, i) => `url-${i}`)
    expect(apply(long, [...long, 'next']).ops).toBe(apply(['url-0'], ['url-0', 'next']).ops)
  })
})
