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

import * as A from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import {
  EPOCH_META_BUILDER_KEYS,
  EpochBuildError,
  buildEpochMeta,
  buildEpochShard,
  copyTypedValue,
  planEpochMetaLists,
  typedDifference,
} from './modelEpochs.js'
import { META_URL_FORMAT_FIELD, metaUrlsAreScalar, readMetaUrl, readMetaUrls, readMetaUrlsUnion } from './modelMetaUrls.js'

type Doc = A.Doc<Record<string, unknown>>
const kindAt = (doc: Doc, path: Array<string | number>) => {
  const be = A.getBackend(doc)
  let obj = '_root'
  for (const p of path.slice(0, -1)) obj = (be.getWithType(obj, p) as [string, string])[1]
  return be.getWithType(obj, path.at(-1)!)?.[0]
}

/** A source exercising every stored datatype, written the ways production
 * writes them: nested literals (positive ints int, others f64), scalar puts
 * (every integer int), wrappers, text, overwritten list elements, a conflict,
 * and a long history the epoch must not carry. */
function richSource(): { doc: Doc; heads: A.Heads } {
  let doc = A.from<Record<string, unknown>>({
    objects: {
      o1: { id: 'o1', name: 'Text name', pos: 5, neg: -5, frac: 1.5, zero: 0, negzero: -0, nan: Number.NaN,
        tags: ['a', 'b'], technologies: [{ name: 'lib', v: 1 }, { name: 'rt', v: -2 }],
        nested: { owner: 'ann', deep: { z: -0, n: 3 } } },
    },
  }, { actor: '01'.repeat(16) })
  doc = A.change(doc, (d) => {
    d.rootScalar = new A.ImmutableString('root-level')
    const o = (d.objects as Record<string, Record<string, unknown>>).o1!
    o.ref = new A.ImmutableString('automerge:ref')
    o.hits = new A.Counter(5)
    o.at = new Date(1_700_000_000_000)
    o.bytes = new Uint8Array([1, 2, 3])
    o.flag = true
    o.none = null
    o.putNeg = -7 // scalar put: int
    o.putZero = 0 // scalar put: int 0
    o.f64Five = new A.Float64(5)
    o.uintSeven = new A.Uint(7)
    const tags = o.tags as unknown[]
    tags[1] = 'B' // an overwritten element (a put at its element id)
    tags.push(new A.ImmutableString('scalar-tag'))
    tags.push(-0)
    tags.push(4)
    tags.push(1.25)
    tags.push(true)
    tags.push(null)
    ;(o.hits as A.Counter).increment(3)
    A.splice(d, ['objects', 'o1', 'name'], 0, 0, 'Spliced ')
  })
  // Many changes of history.
  for (let i = 0; i < 40; i += 1) doc = A.change(doc, (d) => { ((d.objects as Record<string, Record<string, unknown>>).o1!).n = i })
  // A conflict: two concurrent puts on one key.
  let fork = A.clone(doc, { actor: '02'.repeat(16) })
  fork = A.change(fork, (d) => { ((d.objects as Record<string, Record<string, unknown>>).o1!).conflicted = 'fork' })
  doc = A.change(doc, (d) => { ((d.objects as Record<string, Record<string, unknown>>).o1!).conflicted = 'main' })
  doc = A.merge(doc, fork)
  return { doc, heads: A.getHeads(doc) }
}

describe('buildEpochShard (G4-16f)', () => {
  it('equals the source at the cut, datatype by datatype, in ONE change, with no history', () => {
    const { doc, heads } = richSource()
    const epoch = buildEpochShard<Record<string, unknown>>(doc, heads, 'aa'.repeat(16))
    expect(typedDifference(doc, heads, epoch, A.getHeads(epoch))).toBeNull()
    expect(A.getAllChanges(epoch)).toHaveLength(1)
    expect(A.getAllChanges(doc).length).toBeGreaterThan(40)
    expect(A.save(epoch).length).toBeLessThan(A.save(doc).length)
  })

  it('pins the datatypes that a nested copy would change', () => {
    const { doc, heads } = richSource()
    const epoch = buildEpochShard<Record<string, unknown>>(doc, heads) as Doc
    const o = ['objects', 'o1']
    expect(kindAt(epoch, [...o, 'putNeg'])).toBe('int') // nested would give f64
    expect(kindAt(epoch, [...o, 'putZero'])).toBe('int')
    expect(kindAt(epoch, [...o, 'neg'])).toBe('f64')
    expect(kindAt(epoch, [...o, 'f64Five'])).toBe('f64') // nested would give int
    expect(kindAt(epoch, [...o, 'uintSeven'])).toBe('uint')
    expect(kindAt(epoch, [...o, 'ref'])).toBe('str')
    expect(kindAt(epoch, [...o, 'name'])).toBe('text')
    expect(kindAt(epoch, [...o, 'hits'])).toBe('counter')
    expect(Object.is((epoch.objects as Record<string, Record<string, unknown>>).o1!.negzero, -0)).toBe(true)
    expect(Number.isNaN((epoch.objects as Record<string, Record<string, unknown>>).o1!.nan)).toBe(true)
    const tags = (epoch.objects as Record<string, Record<string, unknown>>).o1!.tags as unknown[]
    expect(Object.is(tags[3], -0)).toBe(true)
    expect(((epoch.objects as Record<string, Record<string, unknown>>).o1!.hits as A.Counter).value).toBe(8)
  })

  it('copies the winner of a conflict', () => {
    const { doc, heads } = richSource()
    const epoch = buildEpochShard<Record<string, unknown>>(doc, heads) as Doc
    const winner = ((doc.objects as Record<string, Record<string, unknown>>).o1!).conflicted
    expect(((epoch.objects as Record<string, Record<string, unknown>>).o1!).conflicted).toBe(winner)
  })

  it('copies the state AT THE CUT, not the latest', () => {
    const { doc, heads } = richSource()
    // After the cut: a nested edit, a ROOT key added and a root key replaced
    // (each read at a different level of the copy).
    const later = A.change(doc, (d) => {
      const o1 = (d.objects as Record<string, Record<string, unknown>>).o1!
      o1.name = 'after the cut'
      delete o1.frac // a nested key removed after the cut
      ;(o1.tags as unknown[]).push('after') // a list grown after the cut
      A.splice(d, ['objects', 'o1', 'nested', 'owner'], 0, 0, 'late ') // the SAME text object spliced after the cut
      d.addedLater = 1
      delete d.rootScalar
      d.objects = { replaced: { id: 'replaced' } }
    })
    const epoch = buildEpochShard<Record<string, unknown>>(later, heads) as Doc
    expect(typedDifference(doc, heads, epoch, A.getHeads(epoch))).toBeNull()
    expect(typedDifference(later, A.getHeads(later), epoch, A.getHeads(epoch))).not.toBeNull()
  })

  it('refuses heads the source does not contain', () => {
    const { doc } = richSource()
    const other = A.change(A.from({ x: 1 }), (d) => { d.x = 2 })
    expect(() => buildEpochShard(doc, A.getHeads(other))).toThrow(EpochBuildError)
  })

  it('a battery of numbers keeps its stored datatype through a map key AND a list element', () => {
    const numbers = [0, -0, 1, -1, 2 ** 31, -(2 ** 31), 2 ** 53 - 1, -(2 ** 53 - 1), 0.5, -0.5, 1e-300, -1e300,
      Number.MIN_VALUE, Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    let doc = A.from<Record<string, unknown>>({ nested: Object.fromEntries(numbers.map((n, i) => [`n${i}`, n])), list: [...numbers] })
    doc = A.change(doc, (d) => {
      d.put = {}
      numbers.forEach((n, i) => { (d.put as Record<string, unknown>)[`n${i}`] = n })
      d.wrapped = {}
      numbers.forEach((n, i) => { (d.wrapped as Record<string, unknown>)[`n${i}`] = new A.Float64(n) })
    })
    const heads = A.getHeads(doc)
    const epoch = buildEpochShard<Record<string, unknown>>(doc, heads)
    expect(typedDifference(doc, heads, epoch, A.getHeads(epoch))).toBeNull()
  })

  it('empty containers survive', () => {
    const doc = A.from<Record<string, unknown>>({ objects: {}, list: [], deep: { a: {}, b: [] }, text: '' })
    const epoch = buildEpochShard<Record<string, unknown>>(doc, A.getHeads(doc))
    expect(typedDifference(doc, A.getHeads(doc), epoch, A.getHeads(epoch))).toBeNull()
  })
})

/** The builder as it was before the literal builder: every
 * value written through the change proxy, one put at a time
 * (`copyTypedValue` is that per-value writer). The reference the literal
 * builder must equal. */
function proxyWriteShard(source: Doc, heads: A.Heads): Doc {
  return A.change(A.init<Record<string, unknown>>(), (draft) => {
    for (const key of A.getBackend(source).keys('_root', heads)) {
      copyTypedValue(source, heads, [key], draft as Record<string, unknown>, key)
    }
  })
}

/** A deterministic pseudo-random shard: maps, lists, text and every scalar
 * datatype, nested to depth 3, written by nested literals AND scalar puts. */
function randomShard(seed: number): Doc {
  let state = seed
  const next = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31 }
  const scalar = (): unknown => {
    const pick = Math.floor(next() * 14)
    switch (pick) {
      case 0: return Math.floor(next() * 100) + 1
      case 1: return -Math.floor(next() * 100)
      case 2: return next() - 0.5
      case 3: return new A.Float64(Math.floor(next() * 10) + 1)
      case 4: return new A.Uint(Math.floor(next() * 10))
      case 5: return new A.ImmutableString(`s${Math.floor(next() * 1e6)}`)
      case 6: return `text ${Math.floor(next() * 1e6)}`
      case 7: return new A.Counter(Math.floor(next() * 10))
      case 8: return new Date(1_700_000_000_000 + Math.floor(next() * 1e9))
      case 9: return new Uint8Array([Math.floor(next() * 255), 7])
      case 10: return next() < 0.5
      case 11: return null
      case 12: return -0
      default: return 0
    }
  }
  const value = (depth: number): unknown => {
    const r = next()
    if (depth < 3 && r < 0.2) return Object.fromEntries(Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => [`k${i}`, value(depth + 1)]))
    if (depth < 3 && r < 0.3) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1))
    return scalar()
  }
  let doc = A.init<Record<string, unknown>>({ actor: '03'.repeat(16) })
  doc = A.change(doc, (d) => {
    d.objects = {}
    for (let i = 0; i < 30; i += 1) {
      const entity: Record<string, unknown> = { id: `o${i}`, name: `entity ${i}` }
      for (let f = 0; f < 6; f += 1) entity[`f${f}`] = value(1)
      ;(d.objects as Record<string, unknown>)[`o${i}`] = entity
    }
  })
  // Scalar puts over the literal: the other way a stored datatype arises.
  doc = A.change(doc, (d) => {
    for (let i = 0; i < 30; i += 3) {
      const o = (d.objects as Record<string, Record<string, unknown>>)[`o${i}`]!
      o.put = scalar()
      o.putNeg = -i
      o.list = [1, 2]
      ;(o.list as unknown[])[1] = new A.Uint(i)
    }
  })
  return doc
}

describe('the literal builder equals the proxy-write builder (G4-16f, roll step S3)', () => {
  it('on the rich source, datatype by datatype, in one change', () => {
    const { doc, heads } = richSource()
    // `rootScalar` is a root ImmutableString: both paths put it as a scalar.
    const literal = buildEpochShard<Record<string, unknown>>(doc, heads) as Doc
    const reference = proxyWriteShard(doc, heads)
    expect(typedDifference(reference, A.getHeads(reference), literal, A.getHeads(literal))).toBeNull()
    expect(A.toJS(literal)).toEqual(A.toJS(reference))
    expect(A.getAllChanges(literal)).toHaveLength(1)
  })

  it('on 25 pseudo-random shards (every datatype, nested, literal and put)', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const doc = randomShard(seed)
      const heads = A.getHeads(doc)
      const literal = buildEpochShard<Record<string, unknown>>(doc, heads) as Doc
      const reference = proxyWriteShard(doc, heads)
      expect(typedDifference(reference, A.getHeads(reference), literal, A.getHeads(literal)), `seed ${seed}`).toBeNull()
      expect(typedDifference(doc, heads, literal, A.getHeads(literal)), `seed ${seed}`).toBeNull()
    }
  })

  it('the kinds a nested literal would change are written by a deferred put (control)', () => {
    // Control for `literalKeepsDatatype`: if every value went into the
    // literal, these four would change kind (measured on 3.2.6) — the
    // assertions below are what such a mutant breaks.
    const doc = A.change(A.from<Record<string, unknown>>({ m: {} }), (d) => {
      const m = d.m as Record<string, unknown>
      m.intZero = 0
      m.intNeg = -4
      m.f64Int = new A.Float64(9)
      m.uint = new A.Uint(3)
      d.l = [0]
      ;(d.l as unknown[])[0] = new A.Uint(2)
    })
    const epoch = buildEpochShard<Record<string, unknown>>(doc, A.getHeads(doc)) as Doc
    expect(kindAt(epoch, ['m', 'intZero'])).toBe('int')
    expect(kindAt(epoch, ['m', 'intNeg'])).toBe('int')
    expect(kindAt(epoch, ['m', 'f64Int'])).toBe('f64')
    expect(kindAt(epoch, ['m', 'uint'])).toBe('uint')
    expect(kindAt(epoch, ['l', 0])).toBe('uint')
  })
})

describe('buildEpochMeta (G4-16f, born scalar-native)', () => {
  const S = (n: string) => `automerge:${n}`

  function textMeta(): { doc: Doc; heads: A.Heads } {
    // A TEXT-authority predecessor (every workspace today), with groups,
    // tombstones, unknown keys, decision-record shards and a counter.
    const doc = A.from<Record<string, unknown>>({
      objectShardUrls: [S('b1'), S('b2'), S('seg1'), S('head1')],
      connectionShardUrls: [S('c1'), S('chead1')],
      editsObjectShardUrls: [S('seg1'), S('head1')],
      editsConnectionShardUrls: [S('chead1')],
      editsObjectShardUrl: S('head1'),
      editsConnectionShardUrl: S('chead1'),
      editsOverlayWriteHeadVersion: 2,
      groups: { g1: { id: 'g1', name: 'G' } },
      deletedObjectIds: ['x1', 'x2'],
      decisionRecordShardUrls: [S('adr1')],
      somethingFuture: { keep: true },
    })
    return { doc, heads: A.getHeads(doc) }
  }
  const recreated: Record<string, string> = { [S('b1')]: S('nb1'), [S('b2')]: S('nb2'), [S('c1')]: S('nc1') }
  const plan = { epoch: 1, predecessorUrl: S('meta0'), baseShardUrl: (u: string) => recreated[u] }

  it('lists: base shards first (recreated), overlays kept in place after them, heads as at the cut', () => {
    const { doc, heads } = textMeta()
    const lists = planEpochMetaLists(A.view(doc, heads), plan)
    expect(lists.objectShardUrls).toEqual([S('nb1'), S('nb2'), S('seg1'), S('head1')])
    expect(lists.connectionShardUrls).toEqual([S('nc1'), S('chead1')])
    expect(lists.editsObjectShardUrl).toBe(S('head1'))
    expect(lists.slots).toEqual([S('nb1'), S('nb2'), S('nc1')])
  })

  it('keeps an interleaved order: a base shard appended after the overlay (a browser overflow) stays after it', () => {
    const doc = A.from<Record<string, unknown>>({
      objectShardUrls: [S('b1'), S('seg1'), S('head1'), S('b2')],
      connectionShardUrls: [],
      editsObjectShardUrls: [S('seg1'), S('head1')],
      editsObjectShardUrl: S('head1'),
    })
    const lists = planEpochMetaLists(A.view(doc, A.getHeads(doc)), {
      baseShardUrl: (u) => ({ [S('b1')]: S('nb1'), [S('b2')]: S('nb2') } as Record<string, string>)[u],
    })
    // nb2 must still win over head1 for an entity both hold.
    expect(lists.objectShardUrls).toEqual([S('nb1'), S('seg1'), S('head1'), S('nb2')])
  })

  it('a meta-only epoch carries its base shards (identity mapping)', () => {
    const { doc, heads } = textMeta()
    const carried = new Set([S('b1'), S('b2'), S('c1')])
    const lists = planEpochMetaLists(A.view(doc, heads), { baseShardUrl: (u) => (carried.has(u) ? u : undefined) })
    expect(lists.objectShardUrls).toEqual([S('b1'), S('b2'), S('seg1'), S('head1')])
  })

  it('is born with the marker, all four scalar lists, all four mirror lists, the heads, hints; one change', () => {
    const { doc, heads } = textMeta()
    const meta = buildEpochMeta<Record<string, unknown>>(doc, heads, plan) as Doc
    expect(A.getAllChanges(meta)).toHaveLength(1)
    expect(metaUrlsAreScalar(meta)).toBe(true)
    expect(meta[META_URL_FORMAT_FIELD]).toBe(2)
    for (const scalar of ['objectShardRefs', 'connectionShardRefs', 'editsObjectShardRefs', 'editsConnectionShardRefs']) {
      expect(Array.isArray(meta[scalar])).toBe(true)
    }
    for (const mirror of ['objectShardUrls', 'connectionShardUrls', 'editsObjectShardUrls', 'editsConnectionShardUrls']) {
      expect(Array.isArray(meta[mirror])).toBe(true)
    }
    expect(readMetaUrls(meta, 'objectShardUrls')).toEqual([S('nb1'), S('nb2'), S('seg1'), S('head1')])
    expect(readMetaUrl(meta, 'editsObjectShardUrl')).toBe(S('head1'))
    // The mirror reads the same values as TEXT (what a build from before the scalar URL fields reads).
    expect(meta.objectShardUrls).toEqual([S('nb1'), S('nb2'), S('seg1'), S('head1')])
    expect(kindAt(meta, ['objectShardUrls', 0])).toBe('text')
    expect(kindAt(meta, ['objectShardRefs', 0])).toBe('str')
    expect(typeof meta.editsObjectShardUrl).toBe('string')
    expect(meta.modelEpoch).toBe(1)
    expect(String((meta.epochPredecessorRef as A.ImmutableString).val)).toBe(S('meta0'))
    expect((meta.epochSlots as A.ImmutableString[]).map((s) => String(s.val))).toEqual([S('nb1'), S('nb2'), S('nc1')])
  })

  it('carries every other key with its datatype, unknown keys included', () => {
    const { doc, heads } = textMeta()
    const meta = buildEpochMeta<Record<string, unknown>>(doc, heads, plan)
    expect(typedDifference(doc, heads, meta, A.getHeads(meta), { omitRootKeys: EPOCH_META_BUILDER_KEYS })).toBeNull()
  })

  it('empty edits lists are still born as lists (no old client can race a `= []`)', () => {
    const doc = A.from<Record<string, unknown>>({ objectShardUrls: [S('b1')], connectionShardUrls: [] })
    const meta = buildEpochMeta<Record<string, unknown>>(doc, A.getHeads(doc), { ...plan, baseShardUrl: (u) => u }) as Doc
    for (const key of ['objectShardRefs', 'connectionShardRefs', 'editsObjectShardRefs', 'editsConnectionShardRefs',
      'objectShardUrls', 'connectionShardUrls', 'editsObjectShardUrls', 'editsConnectionShardUrls']) {
      expect(Array.isArray(meta[key]), key).toBe(true)
    }
    expect('editsObjectShardRef' in meta).toBe(false)
    expect('editsObjectShardUrl' in meta).toBe(false)
  })

  it('a SCALAR predecessor (an earlier epoch) is read through its ruling copies, not its frozen mirror', () => {
    const { doc, heads } = textMeta()
    const meta1 = buildEpochMeta<Record<string, unknown>>(doc, heads, plan) as Doc
    // After birth the server writes only the scalars: a rotation.
    const rotated = A.change(meta1, (m) => {
      ;(m.editsObjectShardRefs as unknown[]).push(new A.ImmutableString(S('head2')))
      ;(m.objectShardRefs as unknown[]).push(new A.ImmutableString(S('head2')))
      m.editsObjectShardRef = new A.ImmutableString(S('head2'))
    })
    const second = { [S('nb1')]: S('mb1'), [S('nb2')]: S('mb2'), [S('nc1')]: S('mc1') }
    const meta2 = buildEpochMeta<Record<string, unknown>>(rotated, A.getHeads(rotated), {
      epoch: 2, predecessorUrl: S('meta1'), baseShardUrl: (u) => second[u],
    }) as Doc
    expect(readMetaUrls(meta2, 'objectShardUrls')).toEqual([S('mb1'), S('mb2'), S('seg1'), S('head1'), S('head2')])
    expect(readMetaUrl(meta2, 'editsObjectShardUrl')).toBe(S('head2'))
    // The union closure of the new meta names no URL of the previous epoch's base shards.
    expect(readMetaUrlsUnion(meta2, 'objectShardUrls')).not.toContain(S('nb1'))
  })

  it('refuses a bad epoch number', () => {
    const { doc, heads } = textMeta()
    expect(() => buildEpochMeta(doc, heads, { ...plan, epoch: 0 })).toThrow(EpochBuildError)
  })
})
