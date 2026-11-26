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
import * as A from '@automerge/automerge'
import { compactOverlay, foldValueInPlace } from './compaction.js'

/**
 * G4-16f: compaction folds an overlay entity into its base shard FIELD BY FIELD
 * (`foldValueInPlace`) instead of assigning it whole. Real Automerge, no
 * database (like `compaction.test.ts`).
 *
 *  (a) the final state equals the whole assignment's, KIND included (text vs
 *      ImmutableString, counter, map vs list), over seeded random values;
 *  (b) the cost witness: re-folding an unchanged entity adds no operation, and
 *      changing one field adds exactly the operations of assigning that field;
 *  (c) the defensive branches compared by STORED datatype (`typed`, from
 *      `getBackend(doc).getWithType`): Date, bytes, counter, `0` / `-0`, a
 *      battery of numbers;
 *  (d) the merge semantics against a concurrent peer on the base shard: a
 *      peer's new field survives, a peer's delete of the entity wins.
 *
 * Restoring `coll[id] = snapshot[id]` in `applyFold` turns (b) red.
 */

// ------------------------------------------------------------ seeded values
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rand = () => number
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const word = (r: Rand) => Math.floor(r() * 36 ** 5).toString(36)

function leaf(r: Rand): unknown {
  switch (pick(r, ['text', 'text', 'imm', 'int', 'float', 'bool', 'null', 'counter'] as const)) {
    case 'text': return `t-${word(r)}`
    case 'imm': return new A.ImmutableString(`i-${word(r)}`)
    case 'int': return Math.floor(r() * 1000) - 500
    case 'float': return Math.floor(r() * 1000) / 7 + 0.5
    case 'bool': return r() < 0.5
    case 'null': return null
    case 'counter': return new A.Counter(Math.floor(r() * 50))
  }
}
function value(r: Rand, depth: number): unknown {
  const roll = r()
  if (depth <= 0 || roll < 0.55) return leaf(r)
  if (roll < 0.75) return Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.7 ? leaf(r) : value(r, depth - 1)))
  return map(r, depth - 1)
}
function map(r: Rand, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const n = 1 + Math.floor(r() * 5)
  for (let i = 0; i < n; i += 1) out[`k${Math.floor(r() * 8)}`] = value(r, depth)
  return out
}
/** A plain copy of a materialized value, keeping Automerge's special kinds. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain)
  if (A.isImmutableString(v)) return new A.ImmutableString(v.val)
  if (A.isCounter(v)) return new A.Counter(v.value)
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.keys(v).map((k) => [k, plain((v as Record<string, unknown>)[k])]))
  return v
}
/** The next revision of `base`: keys removed, changed (possibly to another
 * kind), recursed into, added — or nothing at all. */
function revise(r: Rand, base: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(base)) {
    const roll = r()
    if (roll < 0.15) continue // removed
    if (roll < 0.35) out[k] = value(r, depth) // changed, kind may change
    else if (roll < 0.55 && typeof v === 'object' && v !== null && !Array.isArray(v) && !A.isImmutableString(v) && !A.isCounter(v)) {
      out[k] = revise(r, v as Record<string, unknown>, depth - 1)
    } else out[k] = plain(v) // kept
  }
  if (r() < 0.3) out[`n${Math.floor(r() * 8)}`] = value(r, depth)
  return out
}

/** The materialized value with its KIND spelled out, so a text field and an
 * ImmutableString of the same characters do not compare equal. */
function kinds(v: unknown): unknown {
  if (Array.isArray(v)) return { list: v.map(kinds) }
  if (A.isImmutableString(v)) return { imm: v.val }
  if (A.isCounter(v)) return { counter: v.value }
  if (typeof v === 'string') return { text: v }
  if (typeof v === 'object' && v !== null) {
    return { map: Object.fromEntries(Object.keys(v).sort().map((k) => [k, kinds((v as Record<string, unknown>)[k])])) }
  }
  return { [typeof v]: v }
}

/** The stored value under `obj`, DATATYPE included, read from the backend:
 * `int` vs `f64`, `-0`, text vs `str`, timestamp, bytes, counter. */
function typed(doc: A.Doc<unknown>, obj: string = '_root'): unknown {
  const backend = A.getBackend(doc)
  const one = (full: unknown): unknown => {
    if (!Array.isArray(full)) return full
    const [type, value] = full as [string, unknown]
    if (type === 'map' || type === 'list') return { [type]: typed(doc, value as string) }
    if (type === 'text') return { text: backend.text(value as string) }
    if (value instanceof Date) return { [type]: value.getTime() }
    if (value instanceof Uint8Array) return { [type]: [...value] }
    if (typeof value === 'number') return { [type]: Object.is(value, -0) ? '-0' : Number.isNaN(value) ? 'NaN' : value }
    return { [type]: value }
  }
  const info = obj === '_root' ? { type: 'map' } : backend.objInfo(obj as never)
  if (info.type === 'list') {
    return Array.from({ length: backend.length(obj as never) }, (_, i) => one(backend.getWithType(obj as never, i)))
  }
  return Object.fromEntries(backend.keys(obj as never).sort().map((k) => [k, one(backend.getWithType(obj as never, k))]))
}

/** Materialize `v` through a document, as the overlay snapshot is. */
const materialized = (v: unknown): unknown => (A.from({ v } as Record<string, unknown>) as Record<string, unknown>).v

type Doc = { objects: Record<string, unknown> }
const opsBetween = (before: A.Doc<unknown>, after: A.Doc<unknown>): number =>
  A.getChanges(before, after).reduce((n, c) => n + A.decodeChange(c).ops.length, 0)

describe('foldValueInPlace (a): same final state as the whole assignment', () => {
  it('over 400 seeded random entity revisions, kinds included', () => {
    let changedSome = 0
    for (let trial = 0; trial < 400; trial += 1) {
      const r = prng(1000 + trial)
      const baseValue = map(r, 3)
      const nextValue = r() < 0.15 ? plain(baseValue) as Record<string, unknown> : revise(r, baseValue, 3)
      const base = A.from<Doc>({ objects: { e: baseValue, other: { id: 'other', name: 'kept' } } })
      const next = materialized(nextValue)
      const whole = A.change(A.clone(base), (s) => { s.objects.e = next })
      const folded = A.change(A.clone(base), (s) => { foldValueInPlace(s.objects, 'e', next) })
      expect(kinds(folded.objects.e), `trial ${trial}`).toEqual(kinds(whole.objects.e))
      expect(typed(folded), `trial ${trial}`).toEqual(typed(whole))
      expect(kinds(folded.objects.e), `trial ${trial}`).toEqual(kinds(next))
      expect(kinds(folded.objects.other)).toEqual(kinds(base.objects.other))
      if (JSON.stringify(kinds(base.objects.e)) !== JSON.stringify(kinds(next))) changedSome += 1
    }
    // The generator must produce both revisions and identities (265 / 135 at
    // these seeds).
    expect(changedSome).toBeGreaterThan(200)
    expect(400 - changedSome).toBeGreaterThan(50)
  })

  it('a kind change is a change: text ↔ ImmutableString, map ↔ list, counter', () => {
    const base = A.from<Doc>({ objects: { e: { a: 'x', b: new A.ImmutableString('y'), c: { z: 1 }, d: [1], f: new A.Counter(3) } } })
    const next = materialized({ a: new A.ImmutableString('x'), b: 'y', c: [1], d: { z: 1 }, f: new A.Counter(4) })
    const folded = A.change(base, (s) => { foldValueInPlace(s.objects, 'e', next) })
    expect(kinds(folded.objects.e)).toEqual(kinds(next))
  })

  it('through compactOverlay: base shards end exactly as the whole assignment leaves them', async () => {
    const r = prng(7)
    const ids = Array.from({ length: 30 }, (_, i) => `o${i}`)
    const baseValues = Object.fromEntries(ids.map((id) => [id, { id, ...map(r, 3) }]))
    const overlayValues: Record<string, unknown> = {}
    for (const id of ids.slice(0, 20)) overlayValues[id] = { ...revise(r, baseValues[id]!, 3), id }
    for (let i = 0; i < 3; i += 1) overlayValues[`n${i}`] = { id: `n${i}`, ...map(r, 2) } // created
    const repo = new Repo({})
    const shard = repo.create<Doc>({ objects: baseValues })
    const overlay = repo.create<Doc>({ objects: overlayValues as Record<string, unknown> })
    const meta = repo.create({
      objectShardUrls: [shard.url, overlay.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrl: overlay.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([shard, overlay, meta, root].map((h) => h.whenReady()))
    const snapshot = { ...overlay.doc()!.objects }
    const reference = A.change(A.clone(shard.doc()!), (s) => {
      for (const id of Object.keys(snapshot)) s.objects[id] = snapshot[id]
    })

    const res = await compactOverlay(repo, root.url, { mode: 'apply', shardSize: 512 })

    expect(res.objectsFolded).toBe(23)
    expect(kinds(shard.doc()!.objects)).toEqual(kinds(reference.objects))
    expect(typed(shard.doc()!)).toEqual(typed(reference))
  })
})

describe('foldValueInPlace: the defensive branches, by stored datatype', () => {
  /** Fold `{ f: to, keep }` over `{ f: from, keep }`; return both results and
   * the fold's op count. */
  const fold = (from: unknown, to: unknown) => {
    const base = A.from<Doc>({ objects: { e: { f: from, keep: 'k' } } })
    const next = materialized({ f: to, keep: 'k' })
    const whole = A.change(A.clone(base), (s) => { s.objects.e = next })
    const folded = A.change(A.clone(base), (s) => { foldValueInPlace(s.objects, 'e', next) })
    return { whole, folded, ops: opsBetween(base, folded) }
  }

  it.each([
    ['a changed Date', new Date(1_000), new Date(2_000)],
    ['changed bytes', new Uint8Array([1, 2]), new Uint8Array([1, 3])],
    ['Counter(3) -> 3', new A.Counter(3), 3],
    ['0 -> -0', 0, -0],
    ['-0 -> 0', -0, 0],
    ['5 -> 0', 5, 0],
    ['5 -> -0', 5, -0],
    ['5 -> -5', 5, -5],
  ])('%s: stored exactly as the whole assignment stores it', (_label, from, to) => {
    const { whole, folded, ops } = fold(from, to)
    expect(typed(folded)).toEqual(typed(whole))
    expect(ops).toBeGreaterThan(0)
  })

  it.each([
    ['an equal Date', new Date(5_000), new Date(5_000)],
    ['equal bytes', new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    ['an equal counter', new A.Counter(3), new A.Counter(3)],
    ['an equal NaN', NaN, NaN],
  ])('%s: 0 ops, same stored state', (_label, from, to) => {
    const { whole, folded, ops } = fold(from, to)
    expect(ops).toBe(0)
    expect(typed(folded)).toEqual(typed(whole))
  })

  it.each([
    ['0 -> -0', 0, -0],
    ['-0 -> 0', -0, 0],
    ['5 -> -0', 5, -0],
  ])('%s two maps below the entity: stored exactly as the whole assignment stores it', (_label, from, to) => {
    // The -0 fallback must hold at every depth, not only one level down.
    const base = A.from<Doc>({ objects: { e: { m: { n: { f: from, keep: 'k' } }, keep: 'k' } } })
    const next = materialized({ m: { n: { f: to, keep: 'k' } }, keep: 'k' })
    const whole = A.change(A.clone(base), (s) => { s.objects.e = next })
    const folded = A.change(A.clone(base), (s) => { foldValueInPlace(s.objects, 'e', next) })
    expect(typed(folded)).toEqual(typed(whole))
    expect(opsBetween(base, folded)).toBeGreaterThan(0)
  })

  it('every number: a changed field is stored with the whole assignment’s datatype', () => {
    // Positive integers above MAX_SAFE_INTEGER are left out: stored as `int`,
    // decoding the change that holds one throws in 3.2.6 (measured 11/11/2026
    // with 2 ** 53 + 2: "RangeError: 9007199254740994 can't be represented as
    // a JavaScript number"), so this battery cannot compare them.
    const numbers = [0, -0, 1, -1, 2, -2, 2 ** 31, -(2 ** 31), -(2 ** 53), -(2 ** 60),
      0.5, -0.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, -1e21,
      -Number.MAX_VALUE, Number.EPSILON, 5e-324]
    for (const n of numbers) {
      const { whole, folded } = fold(7.25, n)
      expect(typed(folded), String(n)).toEqual(typed(whole))
    }
  })
})

describe('foldValueInPlace: concurrent writers on the base shard (merge semantics)', () => {
  const ACTOR_FOLD = 'aa'.repeat(16)
  const ACTOR_PEER = 'bb'.repeat(16)
  const base = () => A.from<Doc>({ objects: { e: { id: 'e', name: 'before', status: 'live' } } }, { actor: 'cc'.repeat(16) })
  const next = () => materialized({ id: 'e', name: 'after', status: 'live' })

  it('a peer’s concurrent put of a NEW field survives the fold (the whole assignment lost it)', () => {
    const b = base()
    const peer = A.change(A.clone(b, { actor: ACTOR_PEER }), (s) => { (s.objects.e as Record<string, unknown>).owner = 'peer' })
    const folded = A.change(A.clone(b, { actor: ACTOR_FOLD }), (s) => { foldValueInPlace(s.objects, 'e', next()) })
    const whole = A.change(A.clone(b, { actor: ACTOR_FOLD }), (s) => { s.objects.e = next() })

    const mergedFold = A.merge(folded, peer)
    expect(mergedFold.objects.e).toEqual({ id: 'e', name: 'after', status: 'live', owner: 'peer' })
    // The previous behaviour, pinned so the contrast is a measurement.
    expect(A.merge(whole, peer).objects.e).toEqual({ id: 'e', name: 'after', status: 'live' })
  })

  it('a peer’s concurrent DELETE of the entity wins over the fold (the whole assignment resurrected it)', () => {
    const b = base()
    const peer = A.change(A.clone(b, { actor: ACTOR_PEER }), (s) => { delete s.objects.e })
    const folded = A.change(A.clone(b, { actor: ACTOR_FOLD }), (s) => { foldValueInPlace(s.objects, 'e', next()) })
    const whole = A.change(A.clone(b, { actor: ACTOR_FOLD }), (s) => { s.objects.e = next() })

    expect(A.merge(folded, peer).objects.e).toBeUndefined()
    expect(A.merge(whole, peer).objects.e).toEqual({ id: 'e', name: 'after', status: 'live' })
  })
})

// ------------------------------------------------------------ (b) cost witness
/** A C4-like entity: text fields of realistic length, nested maps, lists. */
const entity = (id: string) => ({
  id,
  type: 'container',
  name: `${id} payments gateway`,
  description: `Accepts card payments for ${id} and forwards them to the acquirer; retries idempotently.`,
  position: { x: 120, y: 340 },
  size: { width: 240, height: 120 },
  tagAssignments: { t1: { tagId: 't1', value: 'pci' } },
  tagOrder: ['t1'],
  teamIds: ['team-a', 'team-b'],
  links: [{ url: 'https://example.test/runbook', label: 'runbook' }],
  scope: 'internal',
  status: 'live',
  properties: { owner: 'payments', tier: 'gold' },
})

interface Fixture {
  repo: Repo
  rootUrl: string
  shard: DocHandle<Doc>
}
async function fixture(overlayValues: Record<string, unknown>): Promise<Fixture> {
  const repo = new Repo({})
  const shard = repo.create<Doc>({ objects: { e0: entity('e0'), e1: entity('e1') } })
  const overlay = repo.create<Doc>({ objects: overlayValues })
  const meta = repo.create({
    objectShardUrls: [shard.url, overlay.url],
    connectionShardUrls: [] as string[],
    editsObjectShardUrl: overlay.url,
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  await Promise.all([shard, overlay, meta, root].map((h) => h.whenReady()))
  return { repo, rootUrl: root.url, shard }
}

describe('compaction fold (b): cost witness on the base shard', () => {
  it('re-folding an UNCHANGED entity writes nothing to its base shard', async () => {
    const f = await fixture({ e0: entity('e0') })
    const before = f.shard.doc()!
    const res = await compactOverlay(f.repo, f.rootUrl, { mode: 'apply' })
    expect(res.objectsFolded).toBe(1) // it WAS folded (and cleared from the overlay)
    expect(opsBetween(before, f.shard.doc()!)).toBe(0)
    expect(A.getHeads(f.shard.doc()!)).toEqual(A.getHeads(before))
  })

  it.each([
    ['a number in a nested map', (e: ReturnType<typeof entity>) => ({ ...e, position: { ...e.position, x: 121 } }), (s: Doc) => { (s.objects.e0 as { position: { x: number } }).position.x = 121 }],
    ['a text field', (e: ReturnType<typeof entity>) => ({ ...e, status: 'down' }), (s: Doc) => { (s.objects.e0 as { status: string }).status = 'down' }],
    ['a removed field', (e: ReturnType<typeof entity>) => { const { scope: _scope, ...rest } = e; return rest }, (s: Doc) => { delete (s.objects.e0 as { scope?: string }).scope }],
    ['a list', (e: ReturnType<typeof entity>) => ({ ...e, teamIds: ['team-a'] }), (s: Doc) => { (s.objects.e0 as { teamIds: string[] }).teamIds = ['team-a'] }],
    ['a reordered list', (e: ReturnType<typeof entity>) => ({ ...e, teamIds: ['team-b', 'team-a'] }), (s: Doc) => { (s.objects.e0 as { teamIds: string[] }).teamIds = ['team-b', 'team-a'] }],
  ])('changing %s writes the operations of that field alone', async (_label, edit, alone) => {
    const f = await fixture({ e0: edit(entity('e0')) })
    const before = f.shard.doc()!
    // The reference: that one field assigned on a copy of the same base shard.
    const expected = opsBetween(before, A.change(A.clone(before), alone))
    expect(expected).toBeGreaterThan(0)
    await compactOverlay(f.repo, f.rootUrl, { mode: 'apply' })
    expect(opsBetween(before, f.shard.doc()!)).toBe(expected)
    expect(kinds(f.shard.doc()!.objects.e0)).toEqual(kinds(materialized(edit(entity('e0')))))
    expect(kinds(f.shard.doc()!.objects.e1)).toEqual(kinds(materialized(entity('e1'))))
  })
})
