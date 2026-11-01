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
import { FOLD_MARK_RANGES, FOLD_WHITESPACE, compareCodePoints, fold, foldWithMap, sourceRange } from './fold'

describe('fold', () => {
  it('drops accents, lowercases and collapses whitespace', () => {
    expect(fold('  Énergie \t Verte ')).toBe('energie verte')
    expect(fold('Café')).toBe('cafe')
    // Decomposed input (e + combining acute) folds the same as precomposed.
    expect(fold('Café')).toBe('cafe')
  })

  it('maps the letters NFKD keeps whole', () => {
    expect(fold('Cœur')).toBe('coeur')
    expect(fold('Æther')).toBe('aether')
    expect(fold('Straße')).toBe('strasse')
    expect(fold('ẞ')).toBe('ss') // capital sharp s
    expect(fold('Øresund')).toBe('oresund')
    expect(fold('Łódź')).toBe('lodz')
    expect(fold('Þórr')).toBe('thorr') // thorn, the other two-letter fold
  })

  it('applies compatibility decomposition (ligatures, full width, math letters)', () => {
    expect(fold('ﬁle')).toBe('file')
    expect(fold('ＡＰＩ')).toBe('api')
    expect(fold('\u{1d538}')).toBe('a') // mathematical double-struck A
    expect(fold('İstanbul')).toBe('istanbul') // dotted capital I
  })

  it('folds every sigma to a plain sigma, so a context-aware lowercase (ICU) agrees', () => {
    // Whole-string toLowerCase gives a final sigma, as Postgres lower() through ICU does.
    expect('ΟΔΟΣ'.toLowerCase()).toBe('οδος')
    expect(fold('ΟΔΟΣ')).toBe('οδοσ')
    // A typed final sigma folds the same way, so "οδος" finds "ΟΔΟΣ".
    expect(fold('οδος')).toBe('οδοσ')
  })

  it('removes both ends of every mark block, and not the code point after it (QA lens)', () => {
    for (const [from, to] of FOLD_MARK_RANGES) {
      expect(fold(`a${String.fromCodePoint(from)}b`), from.toString(16)).toBe('ab')
      expect(fold(`a${String.fromCodePoint(to)}b`), to.toString(16)).toBe('ab')
      expect(fold(`a${String.fromCodePoint(to + 1)}b`), (to + 1).toString(16)).not.toBe('ab')
    }
  })

  it('removes diacritic marks only; marks that spell a word survive', () => {
    expect(fold('a᷀b⃐c︠d')).toBe('abcd') // extended / supplement / symbol / half marks
    // Devanagari vowel signs and virama are marks, but removing them would change the word.
    const hindi = 'हिन्दी'
    expect(fold(hindi)).toBe(hindi)
    // Hebrew points survive too.
    expect(fold('שָׁ')).toBe('שָׁ')
  })

  it('collapses exactly the whitespace ECMAScript \\s matches (the SQL fold uses the same list)', () => {
    const viaRegex: number[] = []
    for (let c = 0; c <= 0xffff; c++) if (/\s/u.test(String.fromCharCode(c))) viaRegex.push(c)
    expect([...FOLD_WHITESPACE].sort((a, b) => a - b)).toEqual(viaRegex)
    expect(fold('a b　c﻿d e')).toBe('a b c d e')
  })

  it('takes the ASCII fast path to the same answer as the full path', () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    for (let n = 0; n < 500; n++) {
      let s = ''
      const len = next() % 24
      for (let k = 0; k < len; k++) s += String.fromCharCode(0x20 + (next() % 95))
      expect(fold(s), JSON.stringify(s)).toBe(foldWithMap(s).text)
    }
  })
})

describe('foldWithMap / sourceRange', () => {
  it('maps a folded range back to the source characters', () => {
    const source = 'Café  Œuf'
    const folded = foldWithMap(source)
    expect(folded.text).toBe('cafe oeuf')
    const at = folded.text.indexOf('oe')
    expect(sourceRange(folded, at, at + 2)).toEqual([6, 7])
    expect(source.slice(...sourceRange(folded, 0, 4))).toBe('Café')
  })

  it('covers a whole code point when the range ends inside its expansion', () => {
    const folded = foldWithMap('Straße')
    // The first `s` of the sharp s alone still highlights the whole sharp s.
    expect(sourceRange(folded, 4, 5)).toEqual([4, 5])
  })

  it('keeps a decomposed accent with its letter', () => {
    const source = 'Café bar'
    const folded = foldWithMap(source)
    expect(source.slice(...sourceRange(folded, 3, 4))).toBe('é')
    const tail = foldWithMap('Café')
    expect(sourceRange(tail, 3, 4)).toEqual([3, 5])
  })

  it('maps astral characters by their full surrogate pair', () => {
    const folded = foldWithMap('x\u{1d538}y')
    expect(folded.text).toBe('xay')
    expect(sourceRange(folded, 1, 2)).toEqual([1, 3])
  })
})

describe('compareCodePoints', () => {
  it('orders astral characters after U+E000..U+FFFF, as COLLATE "C" does', () => {
    const astral = '\u{1f600}'
    const highBmp = '～'
    // Plain string comparison gets this wrong: it compares UTF-16 code units.
    expect(astral < highBmp).toBe(true)
    expect(compareCodePoints(astral, highBmp)).toBeGreaterThan(0)
    expect(compareCodePoints(highBmp, astral)).toBeLessThan(0)
  })

  it('orders by length when one string is a prefix of the other', () => {
    expect(compareCodePoints('abc', 'abcd')).toBeLessThan(0)
    expect(compareCodePoints('abc', 'abc')).toBe(0)
    expect(compareCodePoints('b', 'abc')).toBeGreaterThan(0)
  })
})
