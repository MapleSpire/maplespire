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

import { compareTechnologyMatches, technologyMatchRank } from './ranking'

/**
 * The same catalog as the server's `searchRanking.integration.test.ts`, and the
 * same expected order FOR THIS FIXTURE — which is a weaker claim than it looks,
 * and deliberately stated as such.
 *
 * The two implementations agree on rank for ordinary ASCII names and diverge on
 * punctuation and collation; see `ranking.ts`. Sharing the fixture catches a
 * change to the RULE (a swapped rank, a dropped tier). It does not and cannot
 * prove the two orders are identical over the real 4,000-entry catalog, because
 * they are not.
 */
const CATALOG: Array<{ name: string; aliases: string[] }> = [
  { name: 'Postman', aliases: [] },
  { name: 'PostgreSQL', aliases: [] },
  { name: 'PostgreSQL Flexible Server', aliases: [] },
  { name: 'AlloyDB for PostgreSQL', aliases: [] },
  { name: 'Amazon RDS for PostgreSQL', aliases: [] },
  { name: 'Relay', aliases: ['post'] },
  { name: 'Zookeeper', aliases: [] },
]

function ranked(query: string): string[] {
  const needle = query.toLocaleLowerCase()
  return CATALOG
    .filter(({ name, aliases }) => [name, ...aliases]
      .some((term) => term.toLocaleLowerCase().includes(needle)))
    .sort(compareTechnologyMatches(needle, (t) => t.name, (t) => t.aliases))
    .map(({ name }) => name)
}

describe('technologyMatchRank', () => {
  it('ranks exact name, exact alias, name prefix, alias prefix, contains', () => {
    expect(technologyMatchRank('PostgreSQL', [], 'postgresql')).toBe(0)
    expect(technologyMatchRank('Relay', ['post'], 'post')).toBe(1)
    expect(technologyMatchRank('PostgreSQL', [], 'post')).toBe(2)
    expect(technologyMatchRank('Relay', ['postal'], 'post')).toBe(3)
    expect(technologyMatchRank('AlloyDB for PostgreSQL', [], 'post')).toBe(4)
  })

  it('is case-insensitive on both sides', () => {
    expect(technologyMatchRank('PostgreSQL', [], 'POSTGRESQL')).toBe(0)
    expect(technologyMatchRank('Relay', ['POST'], 'post')).toBe(1)
  })

  it('treats an empty query as no opinion', () => {
    expect(technologyMatchRank('Anything', [], '   ')).toBe(0)
  })
})

describe('compareTechnologyMatches — mirrors the SQL order exactly', () => {
  it('ranks exact alias above a prefix, and a prefix above a contains', () => {
    expect(ranked('post')).toEqual([
      'Relay',
      'PostgreSQL',
      'PostgreSQL Flexible Server',
      'Postman',
      'AlloyDB for PostgreSQL',
      'Amazon RDS for PostgreSQL',
    ])
  })

  it('puts an exact name first of all', () => {
    expect(ranked('postgresql')[0]).toBe('PostgreSQL')
  })

  it('keeps ties inside a rank alphabetical', () => {
    const ordered = ranked('postgresql')
    expect(ordered.indexOf('PostgreSQL Flexible Server'))
      .toBeLessThan(ordered.indexOf('AlloyDB for PostgreSQL'))
  })

  // The defect this exists to fix: alphabetically the managed SKUs sort first.
  it('puts a name that STARTS with the term above every name that contains it', () => {
    const ordered = ranked('post')
    expect(ordered.indexOf('PostgreSQL')).toBeLessThan(ordered.indexOf('AlloyDB for PostgreSQL'))
    expect(ordered.indexOf('PostgreSQL')).toBeLessThan(ordered.indexOf('Amazon RDS for PostgreSQL'))
  })

  it('falls back to the alphabet inside a rank', () => {
    const tied = [{ name: 'Bravo', aliases: [] }, { name: 'Alpha', aliases: [] }]
    expect(tied.sort(compareTechnologyMatches('a', (t) => t.name, (t) => t.aliases)).map((t) => t.name))
      .toEqual(['Alpha', 'Bravo'])
  })
})
