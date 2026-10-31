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
  MATCH_EXACT,
  MATCH_PREFIX,
  MATCH_SUBSTRING,
  MATCH_WORD_START,
  evaluateSpotlight,
  matchQuality,
  prepareSpotlightDoc,
  rankSpotlight,
  spotlightHighlights,
  spotlightKinds,
  type PreparedDoc,
  type SpotlightDoc,
} from './evaluate'
import { SPOTLIGHT_KIND_ORDER, parseSpotlightQuery } from './grammar'

const prep = (d: SpotlightDoc) => prepareSpotlightDoc(d)

const CORPUS: PreparedDoc[] = [
  prep({ kind: 'system', id: 's1', name: 'Payments', description: 'Moves money', status: 'live', scope: 'internal', domain: 'Finance', diagrams: ['Checkout'] }),
  prep({ kind: 'app', id: 'a1', name: 'Payments API', tech: ['Node.js'] }),
  prep({ kind: 'app', id: 'a2', name: 'Card payments' }),
  prep({ kind: 'app', id: 'a3', name: 'Repayments' }),
  prep({ kind: 'component', id: 'c1', name: 'Ledger', tech: ['payments-lib'] }),
  prep({ kind: 'store', id: 'st1', name: 'Orders DB', description: 'Stores payments history', tech: ['PostgreSQL'], status: 'down' }),
  prep({ kind: 'actor', id: 'ac1', name: 'Customer', scope: 'external' }),
  prep({ kind: 'group', id: 'g1', name: 'Payments zone' }),
  prep({ kind: 'diagram', id: 'd1', name: 'Checkout', domain: 'Finance' }),
  prep({ kind: 'flow', id: 'f1', name: 'Pay an order', diagrams: ['Checkout'] }),
  prep({ kind: 'adr', id: 'adr1', name: 'Use Postgres for payments', alt: ['ADR-12'], status: 'approved' }),
  prep({ kind: 'connection', id: 'cn1', name: 'Sends payments', from: 'Payments API', to: 'Orders DB', tech: ['HTTPS'] }),
  // A page carries only a name: the description below must be ignored.
  prep({ kind: 'page', id: 'p1', name: 'Model objects', alt: ['objets'], description: 'billing payments' }),
]

/** Matching ids for a query, by brute force over the whole corpus. */
function matches(q: string, corpus: PreparedDoc[] = CORPUS): Record<string, number> {
  const query = parseSpotlightQuery(q)
  const out: Record<string, number> = {}
  for (const d of corpus) {
    const score = evaluateSpotlight(query, d)
    if (score !== null) out[d.doc.id] = score
  }
  return out
}

describe('matchQuality', () => {
  it('grades exact, prefix, word start and substring', () => {
    expect(matchQuality('payments', 'payments')).toBe(MATCH_EXACT)
    expect(matchQuality('payments api', 'payments')).toBe(MATCH_PREFIX)
    expect(matchQuality('card payments', 'payments')).toBe(MATCH_WORD_START)
    expect(matchQuality('repayments', 'payments')).toBe(MATCH_SUBSTRING)
    expect(matchQuality('ledger', 'payments')).toBe(0)
  })

  it('starts a word after ASCII punctuation, never after a letter, digit or non-ASCII character', () => {
    for (const field of ['x-pay', 'x_pay', 'x.pay', 'x/pay', 'x(pay']) expect(matchQuality(field, 'pay'), field).toBe(MATCH_WORD_START)
    for (const field of ['xpay', '1pay', 'épay']) expect(matchQuality(field, 'pay'), field).toBe(MATCH_SUBSTRING)
  })

  it('finds a word start even after an earlier mid-word occurrence', () => {
    expect(matchQuality('repay pay', 'pay')).toBe(MATCH_WORD_START)
  })

  it('never matches a short term as a mere substring', () => {
    expect(matchQuality('repayments', 'pa')).toBe(0)
    expect(matchQuality('card payments', 'pa')).toBe(MATCH_WORD_START)
    expect(matchQuality('payments', 'pa')).toBe(MATCH_PREFIX)
  })
})

describe('evaluateSpotlight', () => {
  it('scores field weight x match quality: names lead, then technology, then description', () => {
    expect(matches('payments')).toEqual({
      s1: 16, // name exact
      a1: 12, // name prefix
      g1: 12,
      c1: 9, // technology prefix
      a2: 8, // name word start
      adr1: 8,
      cn1: 8,
      a3: 4, // name substring
      st1: 4, // description word start
    })
  })

  it('folds accents on both sides', () => {
    const corpus = [prep({ kind: 'system', id: 'e', name: 'Énergie verte' }), prep({ kind: 'system', id: 'f', name: 'Energie' })]
    expect(Object.keys(matches('energie', corpus))).toEqual(['e', 'f'])
    expect(Object.keys(matches('ÉNERGIE', corpus))).toEqual(['e', 'f'])
  })

  it('matches a short term only where a word starts, and unscoped only in names', () => {
    expect(matches('pa')).toEqual({ s1: 12, a1: 12, a2: 8, g1: 12, f1: 12, adr1: 8, cn1: 8 })
    expect(matches('tech:pa')).toEqual({ c1: 9 })
  })

  it('ANDs words and adds their scores', () => {
    expect(matches('payments api')).toEqual({ a1: 12 + 8 })
  })

  it('excludes negated terms and ORs grouped ones', () => {
    expect(Object.keys(matches('payments -api'))).not.toContain('a1')
    expect(Object.keys(matches('payments -api'))).toContain('s1')
    expect(Object.keys(matches('ledger OR customer')).sort()).toEqual(['ac1', 'c1'])
    // Both sides match the ledger (tech prefix 9, name exact 16): the best counts.
    expect(matches('payments OR ledger').c1).toBe(16)
    expect(Object.keys(matches('payments -kind:app')).sort()).toEqual(['adr1', 'c1', 'cn1', 'g1', 's1', 'st1'])
  })

  it('applies enum filters; a filters-only query matches with score 0', () => {
    expect(Object.keys(matches('kind:app payments')).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(matches('status:down')).toEqual({ st1: 0 })
    expect(matches('status:approved')).toEqual({ adr1: 0 })
    expect(matches('scope:external')).toEqual({ ac1: 0 })
    expect(Object.keys(matches('has:tech')).sort()).toEqual(['a1', 'c1', 'cn1', 'st1'])
    expect(Object.keys(matches('has:description')).sort()).toEqual(['s1', 'st1'])
  })

  it('applies text filters without adding to the score', () => {
    expect(matches('in:checkout')).toEqual({ s1: 0, f1: 0 })
    expect(matches('domain:fin')).toEqual({ s1: 0, d1: 0 })
    expect(matches('from:"payments api" to:orders')).toEqual({ cn1: 0 })
    expect(matches('desc:payments')).toEqual({ st1: 4 })
    expect(matches('name:payments kind:system')).toEqual({ s1: 16 })
  })

  it('matches alternative names like a title', () => {
    expect(matches('adr-12')).toEqual({ adr1: 16 })
    expect(matches('objets')).toEqual({ p1: 16 })
  })

  it('ignores fields a kind does not carry, even when a tier fills them', () => {
    expect(matches('billing')).toEqual({})
    expect(matches('desc:billing')).toEqual({})
  })

  it('matches nothing for an empty query', () => {
    expect(matches('')).toEqual({})
    expect(matches(' - ')).toEqual({})
  })
})

describe('spotlightKinds', () => {
  it('narrows sections exactly', () => {
    expect(spotlightKinds(parseSpotlightQuery('from:api'))).toEqual(['connection'])
    expect(spotlightKinds(parseSpotlightQuery('kind:diagram OR kind:system x'))).toEqual(['system', 'diagram'])
    expect(spotlightKinds(parseSpotlightQuery('-kind:actor'))).toEqual(SPOTLIGHT_KIND_ORDER.filter((k) => k !== 'actor'))
    expect(spotlightKinds(parseSpotlightQuery('status:live'))).toEqual(['system', 'app', 'store', 'component', 'actor', 'adr'])
    expect(spotlightKinds(parseSpotlightQuery('payments'))).toEqual(SPOTLIGHT_KIND_ORDER)
    expect(spotlightKinds(parseSpotlightQuery(''))).toEqual([])
  })

  it('never drops a match: ranked sections equal a brute-force evaluation', () => {
    const queries = [
      'payments', 'pa', 'tech:pa', 'payments -api', '-kind:app', 'kind:app OR from:api', 'has:tech', 'has:diagram',
      'in:checkout', 'domain:finance', 'status:down OR scope:external', '-status:down payments', 'desc:money OR tag:x',
      'NOT has:description kind:object', 'objets', '-payments', 'to:orders OR name:ledger',
    ]
    for (const q of queries) {
      const query = parseSpotlightQuery(q)
      const ranked = rankSpotlight(query, CORPUS, 100)
      const fromSections = Object.fromEntries(ranked.sections.flatMap((s) => s.hits.map((h) => [h.doc.id, h.score])))
      expect(fromSections, q).toEqual(matches(q))
    }
  })
})

describe('rankSpotlight', () => {
  it('returns sections in kind order, best first, with totals and a top hit', () => {
    const r = rankSpotlight(parseSpotlightQuery('payments'), CORPUS, 2)
    expect(r.topHit?.doc.id).toBe('s1')
    expect(r.sections.map((s) => s.kind)).toEqual(['system', 'app', 'store', 'component', 'group', 'adr', 'connection'])
    const apps = r.sections.find((s) => s.kind === 'app')!
    expect(apps.total).toBe(3)
    expect(apps.hits.map((h) => h.doc.id)).toEqual(['a1', 'a2'])
  })

  it('breaks top-hit ties by section order, then title, then id', () => {
    const corpus = [
      prep({ kind: 'app', id: 'x', name: 'Gateway' }),
      prep({ kind: 'system', id: 'z', name: 'Gateway' }),
      prep({ kind: 'system', id: 'y', name: 'Gateway' }),
    ]
    const r = rankSpotlight(parseSpotlightQuery('gateway'), corpus, 10)
    expect(r.topHit?.doc.id).toBe('y')
    expect(r.sections[0].hits.map((h) => h.doc.id)).toEqual(['y', 'z'])
  })

  it('has no top hit for a filters-only query', () => {
    const r = rankSpotlight(parseSpotlightQuery('kind:app'), CORPUS, 10)
    expect(r.topHit).toBeNull()
    expect(r.sections[0].hits.map((h) => h.doc.id)).toEqual(['a2', 'a1', 'a3'])
  })
})

describe('spotlightHighlights', () => {
  it('maps folded matches back to the source text', () => {
    const q = parseSpotlightQuery('energie')
    expect(spotlightHighlights(q, 'L’Énergie verte', 'name')).toEqual([[2, 9]])
  })

  it('highlights a short term only at word starts', () => {
    const q = parseSpotlightQuery('pa')
    expect(spotlightHighlights(q, 'Repay pay', 'name')).toEqual([[6, 8]])
  })

  it('merges overlapping ranges and skips negated terms', () => {
    const q = parseSpotlightQuery('pay payments -api')
    expect(spotlightHighlights(q, 'Payments API', 'name')).toEqual([[0, 8]])
  })

  it('highlights a scoped term only in its own field', () => {
    const q = parseSpotlightQuery('tech:postgres')
    expect(spotlightHighlights(q, 'Postgres', 'name')).toEqual([])
    expect(spotlightHighlights(q, 'PostgreSQL', 'tech')).toEqual([[0, 8]])
  })
})
