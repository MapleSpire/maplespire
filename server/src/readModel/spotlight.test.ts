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

import { describe, expect, it, vi } from 'vitest'
import { SPOTLIGHT_FIELD_GAPS, parseSpotlightRequest, roSpotlight } from './spotlight.js'
import type { Queryable } from './types.js'

describe('parseSpotlightRequest', () => {
  it('accepts a query with defaults', () => {
    const r = parseSpotlightRequest({ q: 'pay' })
    expect(r).toMatchObject({ q: 'pay', perKind: 5 })
    expect(typeof r === 'object' && r.vocab.domains.size).toBe(0)
  })

  it('reads kinds, perKind and the vocabulary', () => {
    const r = parseSpotlightRequest({ q: 'x', kinds: ['system', 'diagram'], perKind: 50, vocab: { domains: [['d1', 'Finance']], tags: [['t1', 'pci']] } })
    expect(r).toMatchObject({ kinds: ['system', 'diagram'], perKind: 50 })
    expect(typeof r === 'object' && r.vocab.domains.get('d1')).toBe('Finance')
    expect(typeof r === 'object' && r.vocab.tags.get('t1')).toBe('pci')
  })

  it('refuses malformed bodies with a reason', () => {
    for (const body of [
      null, 'q', {}, { q: 3 }, { q: 'x'.repeat(257) }, { q: 'x', kinds: ['nope'] }, { q: 'x', perKind: 0 },
      { q: 'x', perKind: 52 }, { q: 'x', perKind: 1.5 }, { q: 'x', vocab: { domains: [['only-id']] } },
      { q: 'x', vocab: { tags: [[1, 'n']] } }, { q: 'x', vocab: { domains: 'd' } },
    ]) {
      expect(typeof parseSpotlightRequest(body), JSON.stringify(body)).toBe('string')
    }
  })

  it('refuses at each bound, and accepts exactly at it (QA lens)', () => {
    const refused = (body: unknown) => typeof parseSpotlightRequest(body) === 'string'
    expect(refused({ q: 'x', kinds: ['system', 'nope'] })).toBe(true)
    expect(refused({ q: 'x'.repeat(256) })).toBe(false)
    // The scoped view asks for 50 rows plus the top hit (the shared wire limit).
    expect(refused({ q: 'x', perKind: 51 })).toBe(false)
    expect(refused({ q: 'x', perKind: 52 })).toBe(true)
    expect(refused({ q: 'x', vocab: 'd' })).toBe(true)
    const pairs = (n: number) => Array.from({ length: n }, (_, i) => [`d${i}`, `n${i}`])
    expect(refused({ q: 'x', vocab: { domains: pairs(1000) } })).toBe(false)
    expect(refused({ q: 'x', vocab: { domains: pairs(1001) } })).toBe(true)
    expect(refused({ q: 'x', vocab: { tags: pairs(5000) } })).toBe(false)
    expect(refused({ q: 'x', vocab: { tags: pairs(5001) } })).toBe(true)
    expect(refused({ q: 'x', vocab: { tags: [['t'.repeat(256), 'n'.repeat(256)]] } })).toBe(false)
    expect(refused({ q: 'x', vocab: { tags: [['t'.repeat(257), 'n']] } })).toBe(true)
    expect(refused({ q: 'x', vocab: { tags: [['t', 'n'.repeat(257)]] } })).toBe(true)
  })
})

describe('roSpotlight without a database', () => {
  it('answers an empty query without touching the database', async () => {
    const query = vi.fn()
    const r = await roSpotlight({ query } as unknown as Queryable, { landscapeId: 'l', versionId: 'v' }, '  ', {
      perKind: 5, vocab: { domains: new Map(), tags: new Map() },
    })
    expect(r).toEqual({ v: 1, topHit: null, sections: [], coverage: { unavailableKinds: [], fieldGaps: SPOTLIGHT_FIELD_GAPS } })
    expect(query).not.toHaveBeenCalled()
  })

  it('does not search decision records outside a static workspace, and says so', async () => {
    const query = vi.fn(async (sql: string) => (sql.includes('read_model_static_workspaces')
      ? { rows: [{ static: false }], rowCount: 1 }
      : { rows: [], rowCount: 0 }))
    const r = await roSpotlight({ query } as unknown as Queryable, { landscapeId: 'L', versionId: 'V' }, 'kind:adr payments', {
      perKind: 5, vocab: { domains: new Map(), tags: new Map() },
    })
    expect(r.coverage.unavailableKinds).toEqual(['adr'])
    const sqls = query.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(sqls.some((s) => s.includes('ro_decision_records'))).toBe(false)

    query.mockImplementation(async (sql: string) => (sql.includes('read_model_static_workspaces')
      ? { rows: [{ static: true }], rowCount: 1 }
      : { rows: [], rowCount: 0 }))
    query.mockClear()
    const statik = await roSpotlight({ query } as unknown as Queryable, { landscapeId: 'L', versionId: 'V' }, 'kind:adr payments', {
      perKind: 5, vocab: { domains: new Map(), tags: new Map() },
    })
    expect(statik.coverage.unavailableKinds).toEqual([])
    expect(query.mock.calls.some((c) => (c as unknown as [string])[0].includes('FROM ro_decision_records r'))).toBe(true)
  })

  it('never queries a family the query or the scope rules out, and binds every query to the workspace', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await roSpotlight({ query } as unknown as Queryable, { landscapeId: 'L', versionId: 'V' }, 'from:api', {
      perKind: 5, vocab: { domains: new Map(), tags: new Map() },
    })
    // `from:` is a connection field: only the connections family is read.
    const sqls = query.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('FROM ro_connections c')
    for (const call of query.mock.calls) expect((call as unknown as [string, unknown[]])[1].slice(0, 2)).toEqual(['L', 'V'])

    query.mockClear()
    await roSpotlight({ query } as unknown as Queryable, { landscapeId: 'L', versionId: 'V' }, 'payments', {
      kinds: ['diagram'], perKind: 5, vocab: { domains: new Map(), tags: new Map() },
    })
    expect(query.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([expect.stringContaining('FROM ro_diagram_summaries s')])
  })
})
