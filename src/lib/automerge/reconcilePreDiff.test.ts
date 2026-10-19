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

/**
 * The write path's PRE-DIFF (`reconcileIsNoop`, `planCollectionReconcile`,
 * `applyCollectionReconcile`) decides, against the materialized document,
 * what a reconcile inside a change would have written. A wrong "no-op" is a
 * lost edit, so every case here is judged by REAL Automerge: the oracle is
 * whether `reconcileKey` / `reconcile` inside `A.change` moved the heads.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import {
  applyCollectionReconcile,
  planCollectionReconcile,
  reconcile,
  reconcileIsNoop,
  reconcileKey,
} from './reconcile'

/** Oracle: does reconcileKey(doc, 'v', target) write anything? */
function writes(current: unknown, target: unknown): boolean {
  const base = A.from<any>(current === undefined ? {} : { v: current })
  const after = A.change(base, (d: any) => reconcileKey(d, 'v', target))
  return A.getHeads(after).join() !== A.getHeads(base).join()
}

function judged(current: unknown, target: unknown): boolean {
  const doc = A.from<any>(current === undefined ? {} : { v: current })
  return reconcileIsNoop(doc.v, target)
}

const CASES: Array<[string, unknown, unknown]> = [
  ['equal primitive', 'a', 'a'],
  ['changed primitive', 'a', 'b'],
  ['number vs string', 1, '1'],
  ['null equal', null, null],
  ['absent vs undefined', undefined, undefined],
  ['present vs undefined (delete)', 'a', undefined],
  ['absent vs value', undefined, 'a'],
  ['equal object', { a: 1, b: 'x' }, { a: 1, b: 'x' }],
  ['object with undefined member = absent', { a: 1 }, { a: 1, b: undefined }],
  ['object member to delete via undefined', { a: 1, b: 2 }, { a: 1, b: undefined }],
  ['object extra key in current', { a: 1, legacy: 'x' }, { a: 1 }],
  ['object missing key in current', { a: 1 }, { a: 1, b: 2 }],
  ['nested object change', { p: { x: 1, y: 2 } }, { p: { x: 1, y: 3 } }],
  ['nested object equal', { p: { x: 1, y: 2 } }, { p: { x: 1, y: 2 } }],
  ['equal array', ['a', 'b'], ['a', 'b']],
  ['array reordered', ['a', 'b'], ['b', 'a']],
  ['array appended', ['a'], ['a', 'b']],
  ['array truncated', ['a', 'b'], ['a']],
  ['array vs object', ['a'], { 0: 'a' }],
  ['object vs array', { 0: 'a' }, ['a']],
  ['array of objects equal', [{ id: 'l1', t: 'x' }], [{ id: 'l1', t: 'x' }]],
  ['array of objects changed', [{ id: 'l1', t: 'x' }], [{ id: 'l1', t: 'y' }]],
  ['primitive to object', 'a', { a: 1 }],
  ['empty array equal', [], []],
  ['empty object equal', {}, {}],
  ['boolean flip', true, false],
  ['float equal', 0.25, 0.25],
  // QA lens 2026-10-11: a string has `length` and indices too — RED when the
  // array branch stops checking that `current` IS an array.
  ['string vs array of its characters', 'ab', ['a', 'b']],
  ['removed nested key', { p: { x: 1, gone: 2 } }, { p: { x: 1 } }],
  ['nested change inside an array element', [{ id: 'l1', p: { x: 1 } }], [{ id: 'l1', p: { x: 2 } }]],
]

describe('reconcileIsNoop agrees with a real Automerge reconcile', () => {
  for (const [name, current, target] of CASES) {
    it(name, () => {
      expect(judged(current, target)).toBe(!writes(current, target))
    })
  }

  it('the by-id `related` array: index-equal means no write either way', () => {
    const current = { related: [{ id: 'r1', kind: 'x' }, { id: 'r2', kind: 'y' }] }
    const doc = A.from<any>({ v: current })
    const after = A.change(doc, (d: any) => reconcile(d.v, current))
    expect(A.getHeads(after)).toEqual(A.getHeads(doc))
    expect(reconcileIsNoop(doc.v, current)).toBe(true)
    expect(reconcileIsNoop(doc.v, { related: [{ id: 'r2', kind: 'y' }] })).toBe(false)
  })

  it('a registry meta read from a MATERIALIZED shard doc is judged current, and any drift is not', () => {
    const meta = { id: 'd1', name: 'D', type: 'container', docUrl: 'automerge:x', objectIds: ['o1'], connectionIds: ['c1'], groupIds: [] }
    const shard = A.from<any>({ diagrams: { d1: meta } })
    expect(reconcileIsNoop(shard.diagrams.d1, { ...meta })).toBe(true)
    expect(reconcileIsNoop(shard.diagrams.d1, { ...meta, connectionIds: ['c1', 'c2'] })).toBe(false)
    expect(reconcileIsNoop(shard.diagrams.d1, { ...meta, parentObjectId: 'p' })).toBe(false)
    expect(reconcileIsNoop(shard.diagrams.d1, { ...meta, name: 'E' })).toBe(false)
  })
})

describe('planCollectionReconcile + applyCollectionReconcile ≡ reconcile(collection, target)', () => {
  const base = {
    a: { id: 'a', name: 'A', tags: ['t1'] },
    b: { id: 'b', name: 'B', tags: [] },
    c: { id: 'c', name: 'C', tags: ['t2', 't3'] },
  }
  const TARGETS: Array<[string, Record<string, unknown>]> = [
    ['identical', { ...base }],
    ['one field edited', { ...base, b: { id: 'b', name: 'B2', tags: [] } }],
    ['one added', { ...base, d: { id: 'd', name: 'D', tags: [] } }],
    ['one removed', { a: base.a, c: base.c }],
    ['one removed via undefined', { ...base, c: undefined }],
    ['edit + add + remove', { a: { id: 'a', name: 'A', tags: ['t1', 't9'] }, d: { id: 'd', name: 'D', tags: [] } }],
    ['emptied', {}],
  ]
  for (const [name, target] of TARGETS) {
    it(name, () => {
      const doc = A.from<any>({ coll: base })
      const full = A.change(A.clone(doc), (d: any) => reconcile(d.coll, target))
      const plan = planCollectionReconcile(doc.coll, target)
      const targeted = plan === null
        ? doc
        : A.change(A.clone(doc), (d: any) => applyCollectionReconcile(d.coll, target, plan))
      expect(JSON.parse(JSON.stringify(targeted.coll))).toEqual(JSON.parse(JSON.stringify(full.coll)))
      // null plan ⇔ the full reconcile wrote nothing
      expect(plan === null).toBe(A.getHeads(full).join() === A.getHeads(doc).join())
    })
  }

  it('plans only the keys that differ', () => {
    const doc = A.from<any>({ coll: base })
    const plan = planCollectionReconcile(doc.coll, { ...base, b: { id: 'b', name: 'B2', tags: [] }, d: { id: 'd', name: 'D', tags: [] } })
    expect(plan).toEqual({ update: ['b', 'd'], remove: [] })
    expect(planCollectionReconcile(doc.coll, { a: base.a, b: base.b })).toEqual({ update: [], remove: ['c'] })
  })

  // QA lens 2026-10-11: the JSON-equality arms above cannot see HOW the plan
  // is applied. Minimal ops are the point of reconcile — a whole-entity write
  // yields the same JSON locally and silently discards a peer's concurrent
  // edit of another field on merge.
  it('a targeted update merges per FIELD with a concurrent peer edit of the same entity (RED on a whole-entity overwrite)', () => {
    const doc = A.from<any>({ coll: base })
    const peer = A.change(A.clone(doc), (d: any) => { d.coll.b.tags.push('peer-tag') })
    const target = { ...base, b: { id: 'b', name: 'B2', tags: [] } }
    const plan = planCollectionReconcile(doc.coll, target)!
    expect(plan).toEqual({ update: ['b'], remove: [] })
    const mine = A.change(A.clone(doc), (d: any) => applyCollectionReconcile(d.coll, target, plan))
    const merged = A.merge(A.clone(mine), peer)
    expect(merged.coll.b.name).toBe('B2')
    expect([...merged.coll.b.tags]).toEqual(['peer-tag'])
  })
})

/*
 * Seeded-random detectors (review 2026-10-11). The table above is the author's
 * list of shapes; these generate shapes nobody listed — nested objects and
 * arrays, `undefined` members, `related` keyed arrays, strings next to arrays
 * of their characters, ints next to floats — and judge each by real Automerge.
 * The property that matters is ONE-SIDED: a pre-diff that says "no-op" for a
 * reconcile that would have written is a lost edit; the reverse only costs a
 * draft walk.
 */
describe('property: reconcileIsNoop === true ⇒ the reconcile writes nothing', () => {
  function rng(seed: number) {
    let a = seed >>> 0
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return { next, int: (n: number) => Math.floor(next() * n) }
  }
  type R = ReturnType<typeof rng>
  const KEYS = ['id', 'name', 'tags', 'related', 'p', 'x', 'kind']
  const STRINGS = ['', 'a', 'ab', 'b', 'id1', 'id2']
  const NUMBERS = [0, 1, 2, 0.5, 1.25, -3]

  /** A JSON value Automerge can hold (no `undefined` anywhere). */
  function value(r: R, depth: number): unknown {
    const roll = r.int(depth >= 3 ? 4 : 8)
    switch (roll) {
      case 0: return STRINGS[r.int(STRINGS.length)]
      case 1: return NUMBERS[r.int(NUMBERS.length)]
      case 2: return r.next() < 0.5
      case 3: return null
      case 4:
      case 5: return Array.from({ length: r.int(4) }, () => value(r, depth + 1))
      case 6: return related(r)
      default: {
        const o: Record<string, unknown> = {}
        for (let i = r.int(4); i > 0; i--) {
          const k = KEYS[r.int(KEYS.length)]
          o[k] = k === 'related' ? related(r) : value(r, depth + 1)
        }
        return o
      }
    }
  }
  function related(r: R): unknown[] {
    return Array.from({ length: r.int(4) }, (_, i) => ({ id: `r${(i + r.int(2)) % 4}`, kind: STRINGS[r.int(STRINGS.length)] }))
  }

  /** A target derived from `current`, biased toward EQUAL and near-equal. */
  function perturb(r: R, current: unknown, depth = 0): unknown {
    const roll = r.next()
    if (roll < 0.45) return structuredClone(current)
    if (Array.isArray(current)) {
      if (roll < 0.55 && current.length > 1) return [...current].reverse()
      if (roll < 0.6) return current.length ? current.slice(1) : ['a']
      if (roll < 0.85) return current.map((c) => perturb(r, c, depth + 1))
      return typeof current[0] === 'string' ? current.join('') : value(r, depth)
    }
    if (current !== null && typeof current === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(current)) o[k] = perturb(r, v, depth + 1)
      if (roll < 0.6) o[KEYS[r.int(KEYS.length)]] = undefined // "absent" — or a deletion
      else if (roll < 0.65) delete o[Object.keys(o)[0]]
      else if (roll < 0.7) o[KEYS[r.int(KEYS.length)]] = value(r, depth + 1)
      return o
    }
    if (typeof current === 'string') {
      if (roll < 0.6) return current.split('')
      return roll < 0.75 ? `${current}x` : current
    }
    if (typeof current === 'number') return roll < 0.65 ? String(current) : roll < 0.8 ? current + 1 : current
    return roll < 0.7 ? value(r, depth) : current
  }

  it('600 random (current, target) pairs: never "no-op" while the heads move', () => {
    let noop = 0
    let conservative = 0
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed)
      const current = value(r, 0)
      const target = perturb(r, current)
      const doc = A.from<any>({ v: current })
      const judgedNoop = reconcileIsNoop(doc.v, target)
      const after = A.change(doc, (d: any) => reconcileKey(d, 'v', target))
      const moved = A.getHeads(after).join() !== A.getHeads(doc).join()
      if (judgedNoop) {
        noop++
        expect(moved, `seed ${seed}: ${JSON.stringify(current)} -> ${JSON.stringify(target)}`).toBe(false)
      } else if (!moved) {
        conservative++
      }
    }
    // Not vacuous: a fair share of the pairs are genuine no-ops.
    expect(noop).toBeGreaterThan(150)
    // The conservative direction (says "write", writes nothing) is allowed but
    // should stay rare; a jump here means the pre-diff stopped helping.
    expect(conservative).toBeLessThan(60)
  })

  it('300 random collections: a null plan writes nothing, and a plan writes what the full reconcile writes', () => {
    let nullPlans = 0
    for (let seed = 10_001; seed <= 10_300; seed++) {
      const r = rng(seed)
      const coll: Record<string, unknown> = {}
      for (let i = r.int(5); i >= 0; i--) coll[`e${i}`] = { id: `e${i}`, ...(value(r, 1) as object ?? {}) }
      const target = perturb(r, coll) as Record<string, unknown>
      if (target === null || typeof target !== 'object' || Array.isArray(target)) continue
      const doc = A.from<any>({ coll })
      const full = A.change(A.clone(doc), (d: any) => reconcile(d.coll, target))
      const plan = planCollectionReconcile(doc.coll, target)
      if (plan === null) {
        nullPlans++
        expect(A.getHeads(full).join(), `seed ${seed}`).toBe(A.getHeads(doc).join())
        continue
      }
      const targeted = A.change(A.clone(doc), (d: any) => applyCollectionReconcile(d.coll, target, plan))
      expect(JSON.parse(JSON.stringify(targeted.coll)), `seed ${seed}`).toEqual(JSON.parse(JSON.stringify(full.coll)))
    }
    expect(nullPlans).toBeGreaterThan(50)
  })
})
