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

import {
  digestOfIds,
  digestsEqual,
  parseDigestRow,
  summarizeDigestVerdicts,
  verifyDigest,
  type StampedDigest,
} from './contentDigest.js'

const sealed = (n: number, x: string, g: number): StampedDigest => ({ n, x, g })

describe('digestOfIds', () => {
  it('is independent of order, which is what lets the SQL side skip an ORDER BY', () => {
    expect(digestOfIds(['a', 'b', 'c'])).toEqual(digestOfIds(['c', 'a', 'b']))
  })

  it('renders 16 lowercase hex characters, zero-padded', () => {
    const digest = digestOfIds(['a'])
    expect(digest.x).toMatch(/^[0-9a-f]{16}$/)
    expect(digestOfIds([]).x).toBe('0000000000000000')
  })

  it('detects a missing id', () => {
    expect(digestsEqual(digestOfIds(['a', 'b']), digestOfIds(['a']))).toBe(false)
  })

  it('detects a SWAPPED id even though the count is unchanged', () => {
    expect(digestsEqual(digestOfIds(['a', 'b']), digestOfIds(['a', 'c']))).toBe(false)
  })

  it('carries the count, because XOR alone cannot see a duplicate', () => {
    // a ⊕ a = 0, so the XOR of ['a','a'] equals the XOR of []. The count is what
    // keeps the pair honest if this is ever pointed at a collection whose
    // primary key does not already forbid duplicates.
    const duplicated = digestOfIds(['a', 'a'])
    expect(duplicated.x).toBe(digestOfIds([]).x)
    expect(digestsEqual(duplicated, digestOfIds([]))).toBe(false)
  })

  it('KEEPS the top bit for ids whose hash lands in the signed-negative half', () => {
    // `('x'||md5(id))::bit(64)::bigint` produces a NEGATIVE bigint whenever the
    // top bit is set; this side holds the value unsigned. Both must render the
    // same hex or the two disagree on roughly half of all ids.
    //
    // Asserting the /^[0-9a-f]{16}$/ SHAPE proves nothing — an implementation
    // that masked the high bit off would pass it. What discriminates is that
    // single-id digests actually occur in the upper half, i.e. a leading hex
    // digit >= 8.
    const ids = Array.from({ length: 200 }, (_, index) => `id-${index}`)
    const leading = ids.map((id) => digestOfIds([id]).x[0]!)
    expect(leading.some((digit) => parseInt(digit, 16) >= 8)).toBe(true)
    expect(leading.some((digit) => parseInt(digit, 16) < 8)).toBe(true)
  })

  it('is TOTAL — a non-string id must not throw', () => {
    // `fullExtractionIntegrity` is evaluated as an ARGUMENT, before `runTracked`
    // opens its health span, so a throw here would abort the cold build AND
    // leave the workspace reading `uninitialized` rather than `failed`. An
    // entity with a numeric id projects fine (node-postgres coerces it for a
    // `text` column), so the digest must not take the workspace down.
    expect(() => digestOfIds([42 as unknown as string])).not.toThrow()
    expect(digestOfIds([42 as unknown as string])).toEqual(digestOfIds(['42']))
    expect(() => digestOfIds([undefined as unknown as string])).not.toThrow()
    expect(() => digestOfIds([null as unknown as string])).not.toThrow()
  })
})

describe('parseDigestRow', () => {
  it('accepts count(*)::bigint arriving as a string', () => {
    expect(parseDigestRow({ n: '11935', x: 'a3f0000000000000' })).toEqual({ n: 11935, x: 'a3f0000000000000' })
  })

  it.each([
    ['no row', undefined],
    ['a short hex string', { n: 1, x: 'abc' }],
    ['uppercase hex', { n: 1, x: 'A3F0000000000000' }],
    ['a non-numeric count', { n: 'many', x: 'a3f0000000000000' }],
  ])('returns null for %s, rather than an empty digest', (_label, row) => {
    // A digest that cannot be read is NOT an empty set. Returning {n:0} here
    // would compare unequal to a sealed non-empty digest and report corruption
    // on what is really a broken read.
    expect(parseDigestRow(row as never)).toBeNull()
  })
})

describe('verifyDigest', () => {
  const actual = digestOfIds(['a', 'b'])

  it('matches when the sealed digest, the rows and the generation all agree', () => {
    const verdict = verifyDigest('object', { ...actual, g: 7 }, actual, 7)
    expect(verdict.outcome).toBe('match')
  })

  it('reports a mismatch when the rows changed under an unchanged generation', () => {
    const verdict = verifyDigest('object', { ...digestOfIds(['a', 'b', 'c']), g: 7 }, actual, 7)
    expect(verdict.outcome).toBe('mismatch')
  })

  it('is NOT VERIFIABLE when the read model moved past the sealed generation', () => {
    // The whole reason this is trustworthy. A digest sealed at 7 says nothing
    // about a read model at 40, and calling that a match would report "clean"
    // for something that was never measured.
    const verdict = verifyDigest('object', { ...actual, g: 7 }, actual, 40)
    expect(verdict.outcome).toBe('not-verifiable')
    expect(verdict.reason).toMatch(/sealed at generation 7, read model is at 40/)
  })

  it('is not verifiable when nothing was ever sealed for the kind', () => {
    const verdict = verifyDigest('group', null, actual, 7)
    expect(verdict.outcome).toBe('not-verifiable')
    expect(verdict.reason).toMatch(/no digest has been sealed/)
  })

  it('is not verifiable when the workspace has no projection generation', () => {
    const verdict = verifyDigest('object', { ...actual, g: 7 }, actual, null)
    expect(verdict.outcome).toBe('not-verifiable')
  })

  it('is not verifiable — never a match — when the aggregate could not be read', () => {
    const verdict = verifyDigest('object', { ...actual, g: 7 }, null, 7)
    expect(verdict.outcome).toBe('not-verifiable')
    expect(verdict.reason).toMatch(/could not be read/)
  })

  it('always gives a reason when it did not check', () => {
    const cases = [
      verifyDigest('object', null, actual, 7),
      verifyDigest('object', sealed(2, actual.x, 7), actual, null),
      verifyDigest('object', sealed(2, actual.x, 7), actual, 8),
      verifyDigest('object', sealed(2, actual.x, 7), null, 7),
    ]
    for (const verdict of cases) {
      expect(verdict.outcome).toBe('not-verifiable')
      expect(verdict.reason && verdict.reason.length > 0).toBe(true)
    }
  })
})

describe('summarizeDigestVerdicts', () => {
  it('states how many kinds were actually verified, not just the mismatch count', () => {
    // "0 mismatches" over 0 verified kinds is the shape that reads as healthy
    // and is not.
    const summary = summarizeDigestVerdicts([
      { kind: 'object', outcome: 'not-verifiable', expected: null, actual: null, reason: 'x' },
      { kind: 'group', outcome: 'not-verifiable', expected: null, actual: null, reason: 'x' },
    ])
    expect(summary).toBe('verified=0/2')
  })

  it('names the mismatching kind and both sides', () => {
    const summary = summarizeDigestVerdicts([
      { kind: 'object', outcome: 'mismatch', expected: sealed(3, 'aaaaaaaaaaaaaaaa', 7), actual: { n: 2, x: 'bbbbbbbbbbbbbbbb' } },
    ])
    expect(summary).toContain('MISMATCH')
    expect(summary).toContain('object: sealed 3/aaaaaaaaaaaaaaaa vs rows 2/bbbbbbbbbbbbbbbb')
  })
})
