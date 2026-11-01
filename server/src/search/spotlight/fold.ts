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
 * Spotlight search core: accent and case folding.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `src/lib/search/spotlight/` (the ruling
 * copy) and `server/src/search/spotlight/` (the server's mirror). Neither side
 * can import the other at runtime: `server/tsconfig.json` has `rootDir: ./src`,
 * and the web image is built without `server/` (`src/webImageBuild.test.ts`).
 * Edit the `src/` copy, then run `node scripts/sync-spotlight-core.mjs`;
 * `spotlight.conformance.test.ts` fails on any byte difference.
 *
 * Both tsconfigs compile it, so keep it plain: no enums, no namespaces, no
 * parameter properties, `import type` for types, `.js` on relative imports.
 */

// The three tables below are the WHOLE definition of folding beyond NFKD and
// lowercasing. The server's SQL fold is GENERATED from them
// (server/src/readModel/spotlightSql.ts), so the two cannot disagree on which
// marks, letters or spaces fold; changing one means bumping the SQL function's
// version (its fingerprint test says so).

/** Combining-mark blocks folding removes: the DIACRITIC blocks only. Indic
 *  vowel signs, Hebrew and Arabic points are marks too, but they spell the
 *  word; removing them would make different words equal. */
export const FOLD_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0xfe20, 0xfe2f], // Combining Half Marks
]

/** The code points ECMAScript's `\s` matches, spelled out so SQL can match the same set. */
export const FOLD_WHITESPACE: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]

/** Letters NFKD keeps whole that a reader still treats as an accented Latin
 *  letter. Keys are lowercase: folding lowercases before looking them up. */
export const FOLD_LETTERS: Readonly<Record<string, string>> = {
  'ß': 'ss', // sharp s
  'æ': 'ae', // ae ligature
  'œ': 'oe', // oe ligature
  'ø': 'o', // o with stroke
  'đ': 'd', // d with stroke
  'ð': 'd', // eth
  'ł': 'l', // l with stroke
  'ħ': 'h', // h with stroke
  'ı': 'i', // dotless i
  'ŧ': 't', // t with stroke
  'þ': 'th', // thorn
  // Final sigma. Lowercasing a whole string (Postgres through ICU) writes a
  // word-final capital sigma as ς; this fold lowercases code point by code
  // point and writes σ. Folding ς to σ makes both agree, whatever wrote it.
  'ς': 'σ',
}

const WHITESPACE_SET: ReadonlySet<number> = new Set(FOLD_WHITESPACE)
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

function isFoldMark(code: number): boolean {
  for (const [from, to] of FOLD_MARK_RANGES) if (code >= from && code <= to) return true
  return false
}

/** True when `unit` (one code point) is whitespace folding collapses. */
function isFoldSpace(unit: string): boolean {
  return WHITESPACE_SET.has(unit.codePointAt(0) ?? -1)
}

/** Fold ONE code point: compatibility-decompose, drop diacritic marks,
 *  lowercase, then map the letters NFKD leaves whole. Per code point (not per
 *  string) on purpose: whole-string `toLowerCase` applies the Greek final-sigma
 *  rule, which no index can reproduce, and it keeps `foldWithMap` exact. */
function foldCodePoint(codePoint: string): string {
  // ASCII is its own NFKD and holds no marks or folded letters: lowercase is
  // the whole fold. Most of any text, so this is most of the fold's cost.
  if (codePoint.charCodeAt(0) < 0x80) return codePoint.toLowerCase()
  let out = ''
  for (const unit of codePoint.normalize('NFKD')) {
    if (isFoldMark(unit.codePointAt(0) ?? -1)) continue
    const lower = unit.toLowerCase()
    out += FOLD_LETTERS[lower] ?? lower
  }
  return out
}

/** Folded text plus, for each folded character, the UTF-16 index in the source
 *  of the code point that produced it. `offsets[text.length]` is the index just
 *  past the last code point that produced output, so a folded range
 *  `[start, end)` maps back to the source as `[offsets[start], endOf(end))`. */
export interface FoldedText {
  readonly text: string
  readonly offsets: readonly number[]
}

/**
 * Fold for matching: no accents, lowercase, whitespace runs collapsed to one
 * space, trimmed. `fold('  Énergie  Œuvre ')` is `'energie oeuvre'`.
 */
export function fold(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value.toLowerCase().replace(/ +/g, ' ').trim()
  return foldWithMap(value).text
}

/** `fold`, keeping the map back to the source for highlighting. */
export function foldWithMap(value: string): FoldedText {
  let text = ''
  const offsets: number[] = []
  let pendingSpace = -1
  let index = 0
  let lastEnd = 0
  for (const codePoint of value) {
    const folded = foldCodePoint(codePoint)
    let foldsToSpace = false
    for (const unit of folded) {
      if (isFoldSpace(unit)) {
        foldsToSpace = true
        if (text.length > 0 && pendingSpace < 0) pendingSpace = index
        continue
      }
      if (pendingSpace >= 0) {
        text += ' '
        offsets.push(pendingSpace)
        pendingSpace = -1
      }
      for (let k = 0; k < unit.length; k++) offsets.push(index)
      text += unit
    }
    // A code point that folds to nothing (a decomposed accent's combining mark)
    // belongs to the character before it, so the range runs past it.
    if (text.length > 0 && pendingSpace < 0 && !foldsToSpace) lastEnd = index + codePoint.length
    index += codePoint.length
  }
  offsets.push(lastEnd)
  return { text, offsets }
}

/** The source range of the folded range `[start, end)`. A range that ends inside
 *  the expansion of one code point (the first `s` of a sharp s) covers that whole
 *  code point, so a highlight never splits a character. */
export function sourceRange(folded: FoldedText, start: number, end: number): [number, number] {
  const from = folded.offsets[start]
  const last = folded.offsets[end - 1]
  let next = end
  while (next < folded.text.length && folded.offsets[next] === last) next++
  return [from, folded.offsets[next]]
}

/** Compare by Unicode code point, which is what Postgres `COLLATE "C"` does on
 *  UTF-8. Plain `<` on JS strings compares UTF-16 code units, which order
 *  astral characters (surrogate pairs) BEFORE U+E000..U+FFFF; `localeCompare`
 *  depends on the browser's ICU. Neither matches the server's ORDER BY. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) return codePointOrderKey(x) - codePointOrderKey(y)
  }
  return a.length - b.length
}

function codePointOrderKey(unit: number): number {
  if (unit < 0xd800) return unit
  // Surrogates encode code points above U+FFFF: lift them past U+E000..U+FFFF.
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000
}
