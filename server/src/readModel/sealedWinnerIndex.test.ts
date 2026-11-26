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
import { SealedWinnerIndex, sealedRankIn } from './sealedWinnerIndex.js'

type V = { v: string }
const rankIn = (list: readonly string[]) => (url: string) => list.indexOf(url)

/** The last-wins merge every reader does (`extractModelEntities`), over
 * `list`, each segment read through `read`. */
function merge(list: readonly string[], read: (url: string) => Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const url of list) Object.assign(out, read(url))
  return out
}

/** No inner-id anomaly. */
const none: ReadonlyMap<string, string | null> = new Map()

/** What a pinned product serves: its won ids, with their pinned values. */
const pinnedWinnersOf = (index: SealedWinnerIndex<V>, url: string): Record<string, V> =>
  Object.fromEntries(index.idsWonBy(url).map((id) => [id, index.pinnedValue(url, id)!]))

describe('SealedWinnerIndex (G4-16f)', () => {
  // T8: S1, an UNSEALED segment U, S2 — in ModelMeta order. S2 is indexed
  // FIRST (a product parked mid-session can rank before one parked earlier).
  const list = ['S1', 'U', 'S2']
  const S1: Record<string, V> = { a: { v: 'a@S1' }, b: { v: 'b@S1' }, c: { v: 'c@S1' } }
  const U: Record<string, V> = { b: { v: 'b@U' }, d: { v: 'd@U' } }
  const S2: Record<string, V> = { a: { v: 'a@S2' }, b: { v: 'b@S2' }, e: { v: 'e@S2' } }
  const full: Record<string, Record<string, V>> = { S1, U, S2 }

  const built = () => {
    const index = new SealedWinnerIndex<V>()
    index.add('S2', Object.keys(S2), rankIn(list), none, S2)
    index.add('S1', Object.keys(S1), rankIn(list), none, S1)
    return index
  }

  it('T8: the winner is the latest product in ModelMeta order, not in insertion order', () => {
    const index = built()
    expect(index.idsWonBy('S2').sort()).toEqual(['a', 'b', 'e'])
    // S1 was indexed LAST: an insertion-order index would give it a and b.
    expect(index.idsWonBy('S1')).toEqual(['c'])
    expect(index.wins('S1', 'a')).toBe(false)
    expect(index.wins('S2', 'a')).toBe(true)
    expect(index.pinnedValue('S1', 'a')).toBeUndefined()
    expect(index.pinnedValue('S2', 'a')).toEqual({ v: 'a@S2' })
  })

  it('T8: the merge over winners equals the merge over full contents, an unsealed segment between them included', () => {
    const index = built()
    const served = merge(list, (url) => (index.has(url) ? pinnedWinnersOf(index, url) : full[url]!))
    expect(served).toEqual(merge(list, (url) => full[url]!))
    // b: S2 outranks U, which outranks S1.
    expect(served.b).toEqual({ v: 'b@S2' })
  })

  it('T8: an id held by a sealed product and a LATER unsealed segment only is the segment\'s', () => {
    const order = ['S1', 'U']
    const index = new SealedWinnerIndex<V>()
    index.add('S1', Object.keys(S1), rankIn(order), none, S1)
    const served = merge(order, (url) => (index.has(url) ? pinnedWinnersOf(index, url) : full[url]!))
    expect(served.b).toEqual({ v: 'b@U' })
    expect(served.c).toEqual({ v: 'c@S1' })
  })

  it('each id is stored once, whatever the number of products holding it', () => {
    const index = built()
    expect(index.entities).toBe(4) // a, b, c, e
    expect(index.products).toBe(2)
  })

  it('a product that wins nothing still answers (no ids, not a miss)', () => {
    const order = ['S1', 'S2']
    const index = new SealedWinnerIndex<V>()
    index.add('S1', ['a'], rankIn(order), none, { a: { v: 'old' } })
    index.add('S2', ['a'], rankIn(order), none, { a: { v: 'new' } })
    expect(index.has('S1')).toBe(true)
    expect(index.idsWonBy('S1')).toEqual([])
    expect(index.idsWonBy('nope')).toEqual([])
  })

  it('refuses an unlisted product', () => {
    expect(() => new SealedWinnerIndex<V>().add('X', [], () => -1, none)).toThrow(/not listed/)
  })

  it('C5: never holds `undefined` as a value — add with a value missing, and pin from a map missing a won id, both throw and change nothing', () => {
    const order = ['S1', 'S2']
    const index = new SealedWinnerIndex<V>()
    expect(() => index.add('S1', ['a', 'b'], rankIn(order), none, { a: { v: 'a' } })).toThrow(/no value for b/)
    expect(index.has('S1')).toBe(false)
    index.add('S1', ['a', 'b'], rankIn(order), none)
    expect(() => index.pin('S1', { a: { v: 'a' } })).toThrow(/no value for b/)
    expect(index.isPinned('S1')).toBe(false)
    index.pin('S1', { a: { v: 'a' }, b: { v: 'b' } })
    expect(index.pinnedValues).toBe(2)
  })

  it('C5: values are held only for products added WITH values, only for the ids they still win, and go on unpin', () => {
    const index = new SealedWinnerIndex<V>()
    // S1 without values (served from its extract), S2 with (pinned).
    index.add('S1', Object.keys(S1), rankIn(list), none)
    expect(index.isPinned('S1')).toBe(false)
    expect(index.pinnedValues).toBe(0)
    index.add('S2', Object.keys(S2), rankIn(list), none, S2)
    expect(index.isPinned('S2')).toBe(true)
    expect(index.pinnedValues).toBe(3)
    expect(index.pinnedValue('S1', 'c')).toBeUndefined()
    // A later pinned product steals `e` from S2: S2's value for it goes.
    const order = ['S1', 'U', 'S2', 'S3']
    index.add('S3', ['e'], rankIn(order), none, { e: { v: 'e@S3' } })
    expect(index.wins('S3', 'e')).toBe(true)
    expect(index.pinnedValue('S2', 'e')).toBeUndefined()
    expect(index.pinnedValues).toBe(3) // a@S2, b@S2, e@S3
    index.unpin('S2')
    expect(index.isPinned('S2')).toBe(false)
    expect(index.pinnedValues).toBe(1)
    expect(index.pinnedProducts).toBe(1)
    // Pinned again from a fresh copy: only what it wins NOW.
    index.pin('S2', S2)
    expect([...index.idsWonBy('S2')].sort().map((id) => index.pinnedValue('S2', id))).toEqual([{ v: 'a@S2' }, { v: 'b@S2' }])
    // Pinning a product not indexed does nothing.
    index.pin('nope', S1)
    expect(index.isPinned('nope')).toBe(false)
  })

  it('C5: the inner-id text follows the WINNER of the id', () => {
    const order = ['S1', 'S2']
    const index = new SealedWinnerIndex<V>()
    index.add('S1', ['a', 'b'], rankIn(order), new Map([['a', 'other']]))
    expect(index.innerIdOf('a')).toBe('other')
    expect(index.innerIdOf('b')).toBe('b')
    // S2 wins `a` with a plain inner id: the anomaly goes with S1's win.
    index.add('S2', ['a'], rankIn(order), none)
    expect(index.innerIdOf('a')).toBe('a')
    // A null inner id (no `id` field) is kept as null.
    index.add('S2', ['b'], rankIn(order), new Map([['b', null]]))
    expect(index.innerIdOf('b')).toBeNull()
  })

  it('sealedRankIn: the LAST position of a url, -1 when unlisted', () => {
    const rank = sealedRankIn(['A', 'B', 'A', 'C'])
    expect([rank('A'), rank('B'), rank('C'), rank('D')]).toEqual([2, 1, 3, -1])
  })

  it('orderMatches: the same relative order passes; a swap, an unlisted winner or a duplicate does not', () => {
    const index = built()
    expect(index.orderMatches(list)).toBe(true)
    // Another segment spliced in between (a fold) keeps the order.
    expect(index.orderMatches(['S1', 'P', 'S2', 'H'])).toBe(true)
    expect(index.orderMatches(['S2', 'U', 'S1'])).toBe(false)
    expect(index.orderMatches(['S1', 'U'])).toBe(false)
    expect(index.orderMatches(['S1', 'S2', 'S2'])).toBe(false)
  })
})
