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
import { ABSENT_DELETE_GRACE_MS, ResidentPendingWrites } from './residentPendingWrites'

type E = { id: string; name?: string; description?: string; size?: { w: number } }

describe('the resident path\'s owed local writes', () => {
  it('a creation is overlaid until a document holds it, then released', () => {
    const owed = new ResidentPendingWrites()
    const a: E = { id: 'a', name: 'A' }
    const created: E = { id: 'n', name: 'New' }
    owed.note('objects', [a], [a, created])
    expect(owed.size).toBe(1)
    expect(owed.overlay('objects', [a])).toEqual([a, created])
    expect(owed.size).toBe(1)
    // The document holds it: released, the merge returned as it is.
    const held = [a, { id: 'n', name: 'New' }]
    expect(owed.overlay('objects', held)).toBe(held)
    expect(owed.size).toBe(0)
  })

  it('an edit is overlaid on its TOUCHED fields only: a remote change to another field stands', () => {
    const owed = new ResidentPendingWrites()
    const before: E = { id: 'a', name: 'A', description: 'd' }
    const mine: E = { ...before, name: 'Mine' }
    owed.note('objects', [before], [mine])
    const remote = [{ id: 'a', name: 'A', description: 'Theirs' }]
    expect(owed.overlay('objects', remote)).toEqual([{ id: 'a', name: 'Mine', description: 'Theirs' }])
    // Two edits of the same entity: the baseline is the first one's.
    const again: E = { ...mine, size: { w: 2 } }
    owed.note('objects', [mine], [again])
    expect(owed.overlay('objects', remote)).toEqual([{ id: 'a', name: 'Mine', description: 'Theirs', size: { w: 2 } }])
    owed.release('objects', () => ({ id: 'a', name: 'Mine', description: 'Theirs', size: { w: 2 } }))
    expect(owed.size).toBe(0)
  })

  it('a delete is filtered out until the documents no longer hold it; created then deleted owes nothing', () => {
    const owed = new ResidentPendingWrites()
    const a: E = { id: 'a', name: 'A' }
    const b: E = { id: 'b', name: 'B' }
    owed.note('objects', [a, b], [b])
    expect(owed.overlay('objects', [a, b])).toEqual([b])
    expect(owed.overlay('objects', [b])).toEqual([b])
    expect(owed.size).toBe(0)
    const n: E = { id: 'n' }
    owed.note('objects', [b], [b, n])
    owed.note('objects', [b, n], [b])
    expect(owed.size).toBe(0)
  })

  it('an entry is released only once the documents hold EVERY field it touched — after a write, and on a projection', () => {
    const owed = new ResidentPendingWrites()
    const before: E = { id: 'a', name: 'A', description: 'd' }
    const mine: E = { ...before, name: 'Mine', description: 'Mine too' }
    owed.note('objects', [before], [mine])
    // One of her two fields written so far (a write split by the shard's echo).
    owed.release('objects', () => ({ id: 'a', name: 'Mine', description: 'd' }))
    expect(owed.size).toBe(1)
    // A projection of that same state still shows BOTH of hers.
    expect(owed.overlay('objects', [{ id: 'a', name: 'Mine', description: 'd' }])).toEqual([mine])
    expect(owed.size).toBe(1)
    owed.release('objects', () => ({ id: 'a', name: 'Mine', description: 'Mine too' }))
    expect(owed.size).toBe(0)
  })

  it('an entity edited here and only TRANSIENTLY absent from the merge keeps her edit — it is overlaid again when its folded copy appears', () => {
    const owed = new ResidentPendingWrites()
    const a: E = { id: 'a', name: 'A', description: 'd' }
    owed.note('objects', [a], [{ ...a, name: 'Mine' }])
    // The clear removed it from the segment; its fold product is not followed yet.
    expect(owed.overlay('objects', [], 1_000)).toEqual([])
    owed.release('objects', () => undefined, 2_000)
    expect(owed.size).toBe(1)
    // The fold product arrives a second later, with the value the clear saw.
    expect(owed.overlay('objects', [{ id: 'a', name: 'A', description: 'd' }], 2_000)).toEqual([{ id: 'a', name: 'Mine', description: 'd' }])
    expect(owed.size).toBe(1)
    // Absent again, then past the grace, after a write: the delete wins.
    expect(owed.overlay('objects', [], 3_000)).toEqual([])
    owed.release('objects', () => undefined, 3_000 + ABSENT_DELETE_GRACE_MS)
    expect(owed.size).toBe(0)
  })

  it('an absence that flickers starts its grace again — back present, then absent, the clock restarts; the deadline is reported', () => {
    const owed = new ResidentPendingWrites()
    const a: E = { id: 'a', name: 'A' }
    owed.note('objects', [a], [{ ...a, name: 'Mine' }])
    expect(owed.nextAbsentDeadline()).toBeNull()
    owed.overlay('objects', [], 0)
    expect(owed.nextAbsentDeadline()).toBe(ABSENT_DELETE_GRACE_MS)
    // Back after 10 s, absent again at 11 s.
    owed.overlay('objects', [{ id: 'a', name: 'A' }], 10_000)
    expect(owed.nextAbsentDeadline()).toBeNull()
    owed.overlay('objects', [], 11_000)
    // 20 s: 20 s since the first absence, 9 s since this one — still owed.
    owed.overlay('objects', [], 20_000)
    expect(owed.size).toBe(1)
    expect(owed.nextAbsentDeadline()).toBe(11_000 + ABSENT_DELETE_GRACE_MS)
    owed.release('objects', () => undefined, 11_000 + ABSENT_DELETE_GRACE_MS)
    expect(owed.size).toBe(0)
  })

  it('a remote DELETE of an entity edited here wins; undefined fields and key order never keep an entry owed', () => {
    const owed = new ResidentPendingWrites()
    const a: E = { id: 'a', name: 'A' }
    owed.note('objects', [a], [{ ...a, name: 'Mine' }])
    // Not shown at once; dropped once absent for the grace.
    expect(owed.overlay('objects', [], 1_000)).toEqual([])
    expect(owed.overlay('objects', [], 1_000 + ABSENT_DELETE_GRACE_MS)).toEqual([])
    expect(owed.size).toBe(0)
    type F = { id: string; name: string; size: Record<string, number | undefined> }
    const b: F = { id: 'b', name: 'B', size: { w: 1 } }
    // A nested `undefined` the document never holds, its keys in another order.
    owed.note('objects', [b], [{ ...b, size: { w: 1, h: 2, d: undefined } }])
    owed.release('objects', () => ({ size: { h: 2, w: 1 }, name: 'B', id: 'b' }))
    expect(owed.size).toBe(0)
  })
})
