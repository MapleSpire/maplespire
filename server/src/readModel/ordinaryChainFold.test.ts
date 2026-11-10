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
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import {
  foldSourcesToDetach,
  ORDINARY_FOLD_MISMATCH,
  ORDINARY_FOLD_SOURCES_FIELD,
  ORDINARY_FOLD_UNRECORDED,
  ordinaryFoldRecordRefusal,
  ordinaryFoldSourcesOf,
} from './ordinaryChainFold.js'

const [a, b, c, p] = [generateAutomergeUrl(), generateAutomergeUrl(), generateAutomergeUrl(), generateAutomergeUrl()]

describe('ordinaryFoldSourcesOf', () => {
  it('is null for a segment that is not a fold product', () => {
    expect(ordinaryFoldSourcesOf({ objects: {} })).toBeNull()
    expect(ordinaryFoldSourcesOf(undefined)).toBeNull()
    expect(ordinaryFoldSourcesOf(null)).toBeNull()
  })

  it('returns the sources, de-duplicated, in order', () => {
    expect(ordinaryFoldSourcesOf({ [ORDINARY_FOLD_SOURCES_FIELD]: [a, b, a] })).toEqual([a, b])
  })

  it.each([
    ['an empty list', []],
    ['a string', a],
    ['a non-URL entry', [a, 'not-a-url']],
    ['a non-string entry', [a, 7]],
    ['null', null],
  ])('THROWS on a field that is present but malformed: %s', (_label, value) => {
    expect(() => ordinaryFoldSourcesOf({ [ORDINARY_FOLD_SOURCES_FIELD]: value })).toThrow(/malformed foldedFromUrls/)
  })
})

describe('foldSourcesToDetach', () => {
  const products = new Map([[p, [a, b]]])

  it('detaches watched sources of a LISTED product once they are unlisted', () => {
    expect(foldSourcesToDetach([a, b, c, p], [p, c], products)).toEqual([a, b])
  })

  it('keeps a source that is still listed (the substitution has not landed)', () => {
    expect(foldSourcesToDetach([a, b, p], [a, p], products)).toEqual([b])
  })

  it('detaches nothing when the product itself is not listed — a ModelMeta read with no list included', () => {
    expect(foldSourcesToDetach([a, b, p], [], products)).toEqual([])
    expect(foldSourcesToDetach([a, b, p], [c], products)).toEqual([])
  })

  it('never detaches an unlisted shard no product names', () => {
    expect(foldSourcesToDetach([a, c, p], [p], new Map([[p, [a]]]))).toEqual([a])
  })
})

describe('ordinaryFoldRecordRefusal', () => {
  const record = { collection: 'object' as const, productDocumentId: 'P', sourceDocumentIds: ['s1', 's2'] }
  const folded = (into: string) => ({ status: 'folded', foldedInto: into })
  const rows = new Map([['s1', folded('P')], ['s2', folded('P')]])

  it('vouches when the row names exactly the marker sources and every source is folded into it', () => {
    expect(ordinaryFoldRecordRefusal(record, ['s2', 's1'], (id) => rows.get(id))).toBeNull()
  })

  it('refuses a product with no row as UNRECORDED', () => {
    expect(ordinaryFoldRecordRefusal(undefined, ['s1'], (id) => rows.get(id))).toBe(ORDINARY_FOLD_UNRECORDED)
  })

  it.each([
    ['a marker naming fewer sources', ['s1']],
    ['a marker naming more sources', ['s1', 's2', 's3']],
    ['a marker naming other sources', ['s1', 's3']],
  ])('refuses %s as a MISMATCH', (_label, marked) => {
    expect(ordinaryFoldRecordRefusal(record, marked, (id) => rows.get(id))).toBe(ORDINARY_FOLD_MISMATCH)
  })

  it.each([
    ['still retired', { status: 'retired', foldedInto: null }],
    ['folded into another product', folded('Q')],
    ['without a row', undefined],
  ])('refuses a source %s as a MISMATCH', (_label, row) => {
    const lookup = (id: string) => id === 's2' ? row : rows.get(id)
    expect(ordinaryFoldRecordRefusal(record, ['s1', 's2'], lookup)).toBe(ORDINARY_FOLD_MISMATCH)
  })
})
