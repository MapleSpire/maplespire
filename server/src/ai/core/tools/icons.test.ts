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
 * Regression, defect 2026-10-18: the AI picked wordmark icons (wide text
 * logos) that render as a grey line at shape size. searchIcons — behind the
 * AI's search_icons and the picker's /api/icons — must rank a square mark
 * above a wordmark. Pairs come from the catalog itself, so the test follows
 * the artwork as entries get square marks.
 */

import { describe, expect, it } from 'vitest'
import { ICON_CATALOG } from './iconCatalog.gen.js'
import { searchIcons } from './icons.js'

const rank = (q: string, name: string) => searchIcons({ q, limit: 500 }).icons.findIndex((e) => e.name === name)

describe('searchIcons and wordmarks', () => {
  it('the generated catalog marks the measured wordmarks', () => {
    const wordmarks = ICON_CATALOG.filter((e) => e.wordmark)
    expect(wordmarks.length).toBeGreaterThan(0)
    expect(wordmarks.length).toBeLessThan(ICON_CATALOG.length / 4)
    // Spot checks, both ways: a printed name vs a symbol.
    expect(ICON_CATALOG.find((e) => e.name === 'PostgreSQL')?.wordmark).toBeUndefined()
  })

  it('ranks a square mark that merely starts with the query above a wordmark that IS the query', () => {
    const pairs = ICON_CATALOG.filter((w) => w.wordmark).flatMap((w) =>
      ICON_CATALOG
        .filter((e) => !e.wordmark && e.name !== w.name && e.name.toLowerCase().startsWith(w.name.toLowerCase()))
        .map((square) => ({ wordmark: w.name, square: square.name })))
    expect(pairs.length, 'no wordmark/square prefix pair left in the catalog: pick another witness').toBeGreaterThan(0)
    for (const { wordmark, square } of pairs) {
      const w = rank(wordmark, wordmark)
      const s = rank(wordmark, square)
      expect(w, wordmark).toBeGreaterThanOrEqual(0)
      expect(s, `${square} should rank above ${wordmark}`).toBeLessThan(w)
    }
  })

  it('still finds a wordmark: it can be the only artwork a brand has', () => {
    const wordmark = ICON_CATALOG.find((e) => e.wordmark)!
    expect(searchIcons({ q: wordmark.name, limit: 50 }).icons.map((e) => e.name)).toContain(wordmark.name)
  })

  it('lists square marks before wordmarks when browsing without a query', () => {
    const page = searchIcons({ limit: ICON_CATALOG.length }).icons
    const firstWordmark = page.findIndex((e) => e.wordmark)
    expect(firstWordmark).toBeGreaterThan(0)
    expect(page.slice(firstWordmark).every((e) => e.wordmark)).toBe(true)
  })
})
