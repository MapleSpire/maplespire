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

import { randomBytes } from 'node:crypto'
import * as A from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { findForwardChange, forwardMessage } from './modelEpochForward.js'
import { objectIdAt } from './modelEpochs.js'
import {
  applyCompensation,
  compensated,
  compensationChanges,
  compensationFixMessage,
  compensationMessage,
  forwardDuplicates,
  planCompensation,
  planCounterFix,
} from './modelEpochForwardDedupe.js'

/**
 * G4-16f: a forward's change landing TWICE on a target (synced before flush
 * then a crash; the journal lease window) is compensated — its sequence
 * inserts deleted, its counter increments reverted — and only those, and
 * only while the canonical copy is
 * still there and neither copy was edited: content a user kept is never
 * deleted.
 */
type Row = { k: number[] }
type B = { id: string; tags: number[]; note: string; hits: A.Counter; rows: Row[]; tallies: A.Counter[] }
type D = { objects: Record<string, B | { id: string; tags: number[]; note: string; hits: A.Counter; nested?: { k: number[] } }> }

const actor = () => randomBytes(16).toString('hex')
const MESSAGE = forwardMessage('journal-1', 'target-1')
const PATHS = [['objects', 'b'], ['objects', 'f']]

function base(): A.Doc<D> {
  return A.from<D>({ objects: { b: { id: 'b', tags: [1, 2], note: 'ab', hits: new A.Counter(0), rows: [], tallies: [new A.Counter(10)] } } }, { actor: actor() })
}
const bOf = (doc: A.Doc<D>) => doc.objects.b as B

/** The forward's effect: a list insert, an astral text insert, an increment
 * and a created entity with a nested list. */
const forward = (d: D) => {
  const b = d.objects.b as B
  b.tags.insertAt(1, 9)
  A.splice(d as unknown as A.Doc<unknown>, ['objects', 'b', 'note'], 1, 0, '😀')
  b.hits.increment(3)
  d.objects.f = { id: 'f', tags: [7], note: 'x', hits: new A.Counter(1), nested: { k: [5] } }
}

/** The same forward written by two replicas: the canonical and a duplicate
 * (`other`: the second attempt's plan, when it differs). */
function twice(effect: (d: D) => void = forward, other: (d: D) => void = effect) {
  const t0 = base()
  const before = A.getHeads(t0)
  const one = A.change(A.clone(t0, { actor: actor() }), { message: MESSAGE }, effect)
  const two = A.change(A.clone(t0, { actor: actor() }), { message: MESSAGE }, other)
  const merged = A.merge(A.clone(one, { actor: actor() }), two)
  const canonical = findForwardChange(merged, MESSAGE, before)!.hash
  const [duplicate] = forwardDuplicates(merged, MESSAGE, before, canonical)
  return { merged, before, canonical, duplicate: duplicate!, guard: { canonical, headsBefore: before, forwardMessage: MESSAGE } }
}

/** Run the compensation as the sweep does: one change under its message. */
function compensate(doc: A.Doc<D>, duplicate: string, guard: { canonical: string; headsBefore: A.Heads; forwardMessage: string }) {
  const plan = planCompensation(doc, duplicate, PATHS, guard)
  let result = { applied: 0, unmatched: 0 }
  const fixed = A.change(A.clone(doc, { actor: actor() }), { message: compensationMessage(MESSAGE, duplicate) }, (d) => {
    result = applyCompensation(d, doc, plan.ops, guard.headsBefore)
  })
  return { fixed, plan, result }
}

/** The CURRENT index of the `nth` element a change inserted into the list at `path`. */
function indexOfInsert(doc: A.Doc<D>, hash: string, path: Array<string | number>, nth = 0): number {
  const obj = objectIdAt(doc as A.Doc<unknown>, undefined, path)!
  const change = A.inspectChange(doc, hash)!
  const id = change.ops.map((op, i) => ({ op: op as { insert?: boolean; obj: string }, id: `${change.startOp + i}@${change.actor}` }))
    .filter((x) => x.op.insert && x.op.obj === obj)[nth]!.id
  const be = A.getBackend(doc)
  for (let i = 0; i < be.length(obj); i += 1) if ((be.getAll(obj, i) as unknown[][]).some((v) => v[v.length - 1] === id)) return i
  return -1
}
/** The UTF-16 index of the character a change inserted into the text at `path`. */
function textIndexOfInsert(doc: A.Doc<D>, hash: string, path: Array<string | number>): number {
  const obj = objectIdAt(doc as A.Doc<unknown>, undefined, path)!
  const change = A.inspectChange(doc, hash)!
  const index = change.ops.findIndex((op) => (op as { insert?: boolean; obj: string }).insert && (op as { obj: string }).obj === obj)
  return A.getBackend(doc).getCursorPosition(obj, `${change.startOp + index}@${change.actor}`)
}

describe('duplicate forwards', () => {
  it('the duplicate is found, and the canonical is the smallest hash on every replica', () => {
    const { duplicate, canonical } = twice()
    expect(duplicate > canonical).toBe(true)
  })

  it('CONTROL: uncompensated, the insert, the character and the increment count twice', () => {
    const b = bOf(twice().merged)
    expect(b.tags).toEqual([1, 9, 9, 2])
    expect(b.note).toBe('a😀😀b')
    expect(b.hits.value).toBe(6)
  })

  it('compensated: once each; the created entity is left whole; compensated() turns true', () => {
    const { merged, duplicate, guard, before } = twice()
    expect(compensated(merged, MESSAGE, duplicate, before)).toBe(false)
    const { fixed, plan, result } = compensate(merged, duplicate, guard)
    expect(plan.ops.map((o) => o.kind).sort()).toEqual(['counter', 'list-del', 'text-del'])
    expect(plan.kept).toEqual([])
    expect(result).toEqual({ applied: 3, unmatched: 0 })
    const b = bOf(fixed)
    expect(b.tags).toEqual([1, 9, 2])
    expect(b.note).toBe('a😀b')
    expect(b.hits.value).toBe(3)
    // The created entity: one of the two copies wins, whole.
    const f = fixed.objects.f as { id: string; tags: number[]; note: string; hits: A.Counter; nested: { k: number[] } }
    expect({ id: f.id, tags: [...f.tags], note: f.note, hits: f.hits.value, nested: { k: [...f.nested.k] } }).toEqual({ id: 'f', tags: [7], note: 'x', hits: 1, nested: { k: [5] } })
    expect(compensated(fixed, MESSAGE, duplicate, before)).toBe(true)
  })

  it('a duplicate element a user already deleted is not planned at all', () => {
    const { merged, duplicate, guard } = twice()
    const edited = A.change(A.clone(merged, { actor: actor() }), (d) => {
      ;(d.objects.b as B).tags.deleteAt(indexOfInsert(merged, duplicate, ['objects', 'b', 'tags']))
    })
    const { fixed, plan } = compensate(edited, duplicate, guard)
    expect(plan.ops.filter((o) => o.kind === 'list-del')).toEqual([])
    expect(bOf(fixed).tags).toEqual([1, 9, 2])
  })

  it('the user deleted the CANONICAL copy first — the duplicate survives, kept and reported', () => {
    const { merged, canonical, duplicate, guard } = twice()
    const edited = A.change(A.clone(merged, { actor: actor() }), (d) => {
      ;(d.objects.b as B).tags.deleteAt(indexOfInsert(merged, canonical, ['objects', 'b', 'tags']))
      A.splice(d as unknown as A.Doc<unknown>, ['objects', 'b', 'note'], textIndexOfInsert(merged, canonical, ['objects', 'b', 'note']), 2)
    })
    expect(bOf(edited).tags).toEqual([1, 9, 2])
    const { fixed, plan } = compensate(edited, duplicate, guard)
    expect(plan.kept.map((k) => k.reason).sort()).toEqual(['twin-gone', 'twin-gone'])
    expect(bOf(fixed).tags).toEqual([1, 9, 2]) // the user's one remaining 9 is NOT deleted
    expect(bOf(fixed).note).toBe('a😀b')
    expect(bOf(fixed).hits.value).toBe(3) // the counter is still reverted
  })

  it('the user EDITED the duplicate (or its twin) — both survive', () => {
    for (const which of ['duplicate', 'canonical'] as const) {
      const { merged, canonical, duplicate, guard } = twice()
      const edited = A.change(A.clone(merged, { actor: actor() }), (d) => {
        ;(d.objects.b as B).tags[indexOfInsert(merged, which === 'duplicate' ? duplicate : canonical, ['objects', 'b', 'tags'])] = 8
      })
      const { fixed, plan } = compensate(edited, duplicate, guard)
      expect(plan.kept).toEqual([expect.objectContaining({ reason: 'edited' })])
      expect([...bOf(fixed).tags].sort()).toEqual([1, 2, 8, 9])
    }
  })

  it('a duplicated MAP with a nested edit is never deleted; without one it is', () => {
    const addRow = (d: D) => { ;(d.objects.b as B).rows.insertAt(0, { k: [5] }) }
    for (const nestedEdit of [true, false]) {
      const { merged, duplicate, guard } = twice(addRow)
      expect(bOf(merged).rows).toHaveLength(2)
      const edited = nestedEdit
        ? A.change(A.clone(merged, { actor: actor() }), (d) => {
          ;(d.objects.b as B).rows[indexOfInsert(merged, duplicate, ['objects', 'b', 'rows'])]!.k.push(6)
        })
        : merged
      const { fixed, plan } = compensate(edited, duplicate, guard)
      if (nestedEdit) {
        expect(plan.kept).toEqual([expect.objectContaining({ reason: 'edited' })])
        expect(bOf(fixed).rows.map((r) => [...r.k]).sort()).toEqual([[5], [5, 6]])
      } else {
        expect(plan.kept).toEqual([])
        expect(bOf(fixed).rows.map((r) => [...r.k])).toEqual([[5]])
      }
    }
  })

  it('the same value inserted TWICE on purpose — by the late writer, and by a user after — all survive but the duplicate\'s', () => {
    const doubled = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 9); b.tags.insertAt(1, 9) }
    const { merged, duplicate, guard } = twice(doubled)
    expect(bOf(merged).tags.filter((t) => t === 9)).toHaveLength(4)
    const user = A.change(A.clone(merged, { actor: actor() }), (d) => { const b = d.objects.b as B; b.tags.push(9); b.tags.push(9) })
    const { fixed, plan } = compensate(user, duplicate, guard)
    expect(plan.kept).toEqual([])
    // Marie's two 9s once, and the user's two: 4.
    expect(bOf(fixed).tags.filter((t) => t === 9)).toHaveLength(4)
    expect(bOf(fixed).tags).toHaveLength(6)
  })

  it('SEVERAL distinct inserts into one sequence — each duplicate is paired with ITS twin', () => {
    const two = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 7); b.tags.insertAt(2, 8) }
    const { merged, canonical, duplicate, guard } = twice(two)
    expect([...bOf(merged).tags].sort()).toEqual([1, 2, 7, 7, 8, 8])
    // The user deletes the canonical copy of the SECOND insert (8).
    const edited = A.change(A.clone(merged, { actor: actor() }), (d) => {
      ;(d.objects.b as B).tags.deleteAt(indexOfInsert(merged, canonical, ['objects', 'b', 'tags'], 1))
    })
    const { fixed, plan } = compensate(edited, duplicate, guard)
    // The duplicate 7 goes (its twin is there); the duplicate 8 stays (its twin is gone).
    expect(plan.kept).toEqual([expect.objectContaining({ reason: 'twin-gone' })])
    expect([...bOf(fixed).tags].sort()).toEqual([1, 2, 7, 8])
  })

  it('the same value inserted twice — deleting the canonical SECOND copy keeps its duplicate (never the first one\'s twin)', () => {
    const doubled = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 9); b.tags.insertAt(2, 9) }
    const { merged, canonical, duplicate, guard } = twice(doubled)
    const edited = A.change(A.clone(merged, { actor: actor() }), (d) => {
      ;(d.objects.b as B).tags.deleteAt(indexOfInsert(merged, canonical, ['objects', 'b', 'tags'], 1))
    })
    expect(bOf(edited).tags.filter((t) => t === 9)).toHaveLength(3)
    const { fixed, plan } = compensate(edited, duplicate, guard)
    // Marie's two 9s, both still there: one canonical, one duplicate kept.
    expect(bOf(fixed).tags.filter((t) => t === 9)).toHaveLength(2)
    expect(plan.kept).toEqual([expect.objectContaining({ reason: 'twin-gone' })])
  })

  it('the two plans ordered their inserts differently — distinct values pair by content; an equal-value group is AMBIGUOUS and kept', () => {
    // Distinct values in another order: paired by content, both undone.
    const xy = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 7); b.tags.insertAt(2, 8) }
    const yx = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 8); b.tags.insertAt(2, 7) }
    const distinct = twice(xy, yx)
    const swapped = compensate(distinct.merged, distinct.duplicate, distinct.guard)
    expect(swapped.plan.kept).toEqual([])
    expect([...bOf(swapped.fixed).tags].sort()).toEqual([1, 2, 7, 8])
    // An equal-value group whose relative order differs: kept, not guessed.
    const a = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 9); b.tags.insertAt(2, 5); b.tags.insertAt(3, 9) }
    const b2 = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 9); b.tags.insertAt(2, 9); b.tags.insertAt(3, 5) }
    const groups = twice(a, b2)
    const result = compensate(groups.merged, groups.duplicate, groups.guard)
    expect(result.plan.kept.map((k) => k.reason)).toEqual(['ambiguous', 'ambiguous'])
    expect(bOf(result.fixed).tags.filter((t) => t === 9)).toHaveLength(4)
    expect(bOf(result.fixed).tags.filter((t) => t === 5)).toHaveLength(1)
  })

  it('an equal-value group whose two SIZES differ (one attempt inserted 9 once, the other twice) is no-twin — kept, never paired by ordinal', () => {
    const once = (d: D) => { ;(d.objects.b as B).tags.insertAt(1, 9) }
    const doubled = (d: D) => { const b = d.objects.b as B; b.tags.insertAt(1, 9); b.tags.insertAt(2, 9) }
    // Whichever attempt the hashes make canonical, the group sizes differ.
    const { merged, duplicate, guard } = twice(once, doubled)
    expect(bOf(merged).tags.filter((t) => t === 9)).toHaveLength(3)
    const { fixed, plan } = compensate(merged, duplicate, guard)
    expect(plan.kept.length).toBeGreaterThan(0)
    expect(plan.kept.map((k) => k.reason).every((r) => r === 'no-twin')).toBe(true)
    expect(plan.ops.filter((o) => o.kind === 'list-del')).toEqual([])
    expect(bOf(fixed).tags.filter((t) => t === 9)).toHaveLength(3)
  })

  it('a REPLAYED compensation (two changes under its message) does not revert the counter twice', () => {
    const { merged, duplicate, guard, before } = twice()
    // Two cells (or a crash after sync and before flush) both compensate.
    const first = compensate(merged, duplicate, guard).fixed
    const second = compensate(merged, duplicate, guard).fixed
    const both = A.merge(A.clone(first, { actor: actor() }), second)
    expect(bOf(both).hits.value).toBe(0) // reverted twice
    expect(bOf(both).tags).toEqual([1, 9, 2]) // two deletes of one element are one delete
    const comps = compensationChanges(both, MESSAGE, duplicate, before)
    expect(comps).toHaveLength(2)
    const plan = planCompensation(both, duplicate, PATHS, guard)
    const fix = planCounterFix(both, plan.ops, comps)
    expect(fix).toEqual([expect.objectContaining({ kind: 'counter', by: 3 })])
    const fixed = A.change(A.clone(both, { actor: actor() }), { message: compensationFixMessage(MESSAGE, duplicate, comps) }, (d) => {
      applyCompensation(d, both, fix, before)
    })
    expect(bOf(fixed).hits.value).toBe(3)
    // The fix is counted by the next pass: nothing more is owed.
    const after = compensationChanges(fixed, MESSAGE, duplicate, before)
    expect(after).toHaveLength(3)
    expect(planCounterFix(fixed, planCompensation(fixed, duplicate, PATHS, guard).ops, after)).toEqual([])
    // …and a single compensation owes nothing either.
    expect(planCounterFix(first, plan.ops, compensationChanges(first, MESSAGE, duplicate, before))).toEqual([])
  })

  it('a counter INSIDE A LIST is reverted too', () => {
    const { merged, duplicate, guard } = twice((d) => { ;(d.objects.b as B).tallies[0]!.increment(2) })
    expect(bOf(merged).tallies[0]!.value).toBe(14)
    const { fixed, plan, result } = compensate(merged, duplicate, guard)
    expect(plan.ops).toEqual([expect.objectContaining({ kind: 'counter', by: -2 })])
    expect(result).toEqual({ applied: 1, unmatched: 0 })
    expect(bOf(fixed).tallies[0]!.value).toBe(12)
  })

  it('a single forward (no duplicate) plans nothing', () => {
    const t0 = base()
    const before = A.getHeads(t0)
    const one = A.change(A.clone(t0, { actor: actor() }), { message: MESSAGE }, forward)
    const canonical = findForwardChange(one, MESSAGE, before)!.hash
    expect(forwardDuplicates(one, MESSAGE, before, canonical)).toEqual([])
  })
})
