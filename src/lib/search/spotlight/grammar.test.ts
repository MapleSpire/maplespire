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
import { isEmptySpotlightQuery, parseSpotlightQuery, suggestEnumValues } from './grammar'

const groups = (q: string) => parseSpotlightQuery(q).groups

describe('parseSpotlightQuery: text', () => {
  it('ANDs words, each its own group, folded', () => {
    expect(groups('Order  Énergie')).toEqual([
      [{ type: 'text', field: 'any', values: ['order'], negated: false, phrase: false }],
      [{ type: 'text', field: 'any', values: ['energie'], negated: false, phrase: false }],
    ])
  })

  it('keeps a quoted phrase together', () => {
    expect(groups('"Order  Service" api')).toEqual([
      [{ type: 'text', field: 'any', values: ['order service'], negated: false, phrase: true }],
      [{ type: 'text', field: 'any', values: ['api'], negated: false, phrase: false }],
    ])
  })

  it('reads an unterminated phrase to the end of the input', () => {
    expect(groups('"order serv')).toEqual([
      [{ type: 'text', field: 'any', values: ['order serv'], negated: false, phrase: true }],
    ])
  })

  it('negates with a leading dash or NOT', () => {
    expect(groups('-legacy')[0][0]).toMatchObject({ values: ['legacy'], negated: true })
    expect(groups('NOT legacy')[0][0]).toMatchObject({ values: ['legacy'], negated: true })
    expect(groups('-"old api"')[0][0]).toMatchObject({ values: ['old api'], negated: true, phrase: true })
  })

  it('joins the clauses around OR into one group; lowercase or is text', () => {
    const g = groups('billing OR invoicing api')
    expect(g).toHaveLength(2)
    expect(g[0].map((t) => (t.type === 'text' ? t.values[0] : ''))).toEqual(['billing', 'invoicing'])
    expect(groups('billing or invoicing')).toHaveLength(3)
  })

  it('ignores a dangling OR, AND, and a lone dash', () => {
    expect(groups('OR billing OR')).toHaveLength(1)
    expect(groups('billing AND api')).toHaveLength(2)
    expect(groups('billing - api')).toHaveLength(2)
    expect(isEmptySpotlightQuery(parseSpotlightQuery('  -  '))).toBe(true)
  })
})

describe('parseSpotlightQuery: filters', () => {
  it('reads text filters, comma values as OR', () => {
    expect(groups('tech:Postgres,MySQL')).toEqual([
      [{ type: 'text', field: 'tech', values: ['postgres', 'mysql'], negated: false, phrase: false }],
    ])
    expect(groups('in:"Checkout  flow"')).toEqual([
      [{ type: 'text', field: 'in', values: ['checkout flow'], negated: false, phrase: true }],
    ])
  })

  it('resolves enum values, aliases and unique prefixes', () => {
    expect(groups('kind:sys')[0][0]).toEqual({ type: 'enum', key: 'kind', values: ['system'], negated: false })
    expect(groups('kind:container,db')[0][0]).toMatchObject({ values: ['app', 'store'] })
    expect(groups('kind:object')[0][0]).toMatchObject({ values: ['system', 'app', 'store', 'component', 'actor'] })
    expect(groups('-kind:actor')[0][0]).toMatchObject({ key: 'kind', values: ['actor'], negated: true })
    expect(groups('kind:"system"')[0][0]).toMatchObject({ values: ['system'] })
  })

  it('accepts French keys and values, accents optional', () => {
    expect(groups('genre:système')[0][0]).toMatchObject({ key: 'kind', values: ['system'] })
    expect(groups('étiquette:paiement')[0][0]).toMatchObject({ field: 'tag', values: ['paiement'] })
    expect(groups('statut:approuvé')[0][0]).toMatchObject({ key: 'status', values: ['approved'] })
    expect(groups('portée:externe')[0][0]).toMatchObject({ key: 'scope', values: ['external'] })
  })

  it('warns about an enum value it cannot resolve, and drops it', () => {
    const q = parseSpotlightQuery('kind:"zzz" api')
    expect(q.groups).toHaveLength(1)
    expect(q.warnings).toEqual([
      expect.objectContaining({ code: 'unknownValue', key: 'kind', value: 'zzz', start: 6, end: 9 }),
    ])
    // Ambiguous prefix: `con` is both a container and a connection.
    expect(parseSpotlightQuery('kind:con api').warnings[0]).toMatchObject({ code: 'unknownValue', value: 'con' })
  })

  it('does not warn about a value still being typed at the end', () => {
    const typing = parseSpotlightQuery('api kind:con')
    expect(typing.warnings).toEqual([])
    expect(typing.pendingKey).toBe('kind')
    expect(parseSpotlightQuery('tag:').pendingKey).toBe('tag')
    expect(parseSpotlightQuery('in:"Check').pendingKey).toBe('in')
    expect(parseSpotlightQuery('in:"Checkout"').pendingKey).toBeNull()
    expect(parseSpotlightQuery('tag:x api').pendingKey).toBeNull()
  })

  it('searches an unknown key as text and suggests the closest key', () => {
    const q = parseSpotlightQuery('knd:system')
    expect(q.groups).toEqual([[{ type: 'text', field: 'any', values: ['knd:system'], negated: false, phrase: false }]])
    expect(q.warnings).toEqual([{ code: 'unknownKey', key: 'knd', suggestion: 'kind', start: 0, end: 3 }])
  })

  it('treats URLs, times and one-letter prefixes as plain text without a tip', () => {
    for (const text of ['http://example.com', '10:30', 'c:temp']) {
      const q = parseSpotlightQuery(text)
      expect(q.warnings, text).toEqual([])
      expect(q.groups, text).toHaveLength(1)
    }
  })

  it('emits token spans for colouring the input', () => {
    expect(parseSpotlightQuery('-kind:actor "a b" OR x').tokens).toEqual([
      { type: 'negation', start: 0, end: 1 },
      { type: 'key', start: 1, end: 6 },
      { type: 'value', start: 6, end: 11 },
      { type: 'phrase', start: 12, end: 17 },
      { type: 'operator', start: 18, end: 20 },
      { type: 'text', start: 21, end: 22 },
    ])
  })
})

describe('suggestEnumValues', () => {
  it('lists canonical values any of whose spellings start with the prefix', () => {
    // `co` starts container (app), component, connection and command (page).
    expect(suggestEnumValues('kind', 'co')).toEqual(['app', 'component', 'connection', 'page'])
    expect(suggestEnumValues('status', '')).toHaveLength(7)
  })
})
