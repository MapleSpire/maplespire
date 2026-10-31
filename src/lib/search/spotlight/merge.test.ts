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
import { prepareSpotlightDoc, rankSpotlight } from './evaluate'
import type { SpotlightDoc } from './evaluate'
import { parseSpotlightQuery } from './grammar'
import type { SpotlightKind } from './grammar'
import { mergeSpotlightTiers, serverCoverage, spotlightEntityKey, spotlightFieldReads, spotlightFieldsRead } from './merge'
import type { SpotlightMergedResult, SpotlightServerTier } from './merge'
import type { SpotlightCoverage, SpotlightWireDoc, SpotlightWireSection } from './wire'

const FULL: SpotlightCoverage = { unavailableKinds: [], fieldGaps: {} }
/** What today's server reports (spotlight.ts SPOTLIGHT_FIELD_GAPS, a non-static workspace). */
const TODAY: SpotlightCoverage = { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'], flow: ['domain'] } }

const wire = (kind: SpotlightKind, id: string, name: string, more: Partial<SpotlightWireDoc> = {}): SpotlightWireDoc =>
  ({ kind, id, name, extra: {}, ...more })

function section(kind: SpotlightKind, hits: Array<[number, SpotlightWireDoc]>, total = hits.length, totalCapped = false): SpotlightWireSection {
  return { kind, total, totalCapped, hits: hits.map(([score, doc]) => ({ score, doc })) }
}

const keyOf = (d: SpotlightDoc) => spotlightEntityKey(d.kind, d.id)

interface Options {
  /** Entity keys this tab deleted. */
  readonly deleted?: readonly string[]
  readonly complete?: readonly SpotlightKind[]
  readonly perKind?: number
}

/** The merge as SpotlightSearch runs it: the resident ranking of the same
 *  query, the store's documents as the lookup. */
function merge(q: string, resident: SpotlightDoc[], server: SpotlightServerTier, options: Options = {}): SpotlightMergedResult {
  const perKind = options.perKind ?? 5
  const query = parseSpotlightQuery(q)
  const prepared = resident.map((d) => prepareSpotlightDoc(d))
  const byKey = new Map(prepared.map((p) => [keyOf(p.doc), p]))
  return mergeSpotlightTiers(query, {
    result: rankSpotlight(query, prepared, perKind),
    doc: (key) => byKey.get(key),
    deleted: (kind, id) => options.deleted?.includes(spotlightEntityKey(kind, id)) ?? false,
    completeKinds: new Set(options.complete ?? []),
  }, server, perKind)
}

const shape = (r: SpotlightMergedResult) => r.sections.map((s) => [s.kind, s.hits.map((h) => h.doc.id)])
const isWire = (d: SpotlightDoc) => 'extra' in d

describe('mergeSpotlightTiers: a kind the server covers', () => {
  it('adds the hits the store does not hold, in the core order, with the server scores', () => {
    const r = merge('pay', [{ kind: 'app', id: 'a1', name: 'Payments API' }], {
      sections: [
        section('system', [[16, wire('system', 's1', 'Pay')]]),
        // A tie with the resident a1 (prefix x name = 12): folded name order puts "payments api" first.
        section('app', [[12, wire('app', 'a2', 'Payroll')]]),
      ],
      coverage: FULL,
    })
    expect(shape(r)).toEqual([['system', ['s1']], ['app', ['a1', 'a2']]])
    expect(r.topHit?.doc.id).toBe('s1')
    expect(r.sections.every((s) => s.source === 'merged')).toBe(true)
  })

  it('never ranks a server document again: a hit stays with the score it came with', () => {
    // Its description was trimmed for the wire, so the core would not even match it here.
    const r = merge('ledger', [], { sections: [section('app', [[4, wire('app', 'a9', 'Billing', { description: '' })]])], coverage: FULL })
    expect(r.sections[0].hits[0]).toMatchObject({ score: 4, doc: { id: 'a9' } })
    expect(r.topHit?.doc.id).toBe('a9')
  })

  it('lets the store decide an entity it holds: edited out of the match, the stale server hit is dropped', () => {
    const r = merge('pay', [{ kind: 'app', id: 'a1', name: 'Billing' }], {
      sections: [section('app', [[12, wire('app', 'a1', 'Payments')]])],
      coverage: FULL,
    })
    expect(r.sections).toEqual([])
    expect(r.topHit).toBeNull()
  })

  it('lets the store decide an entity it holds: still matching, the resident copy and score are shown', () => {
    const r = merge('pay', [{ kind: 'app', id: 'a1', name: 'Pay' }], {
      sections: [section('app', [[12, wire('app', 'a1', 'Payments')]])],
      coverage: FULL,
    })
    expect(r.sections[0].hits).toHaveLength(1)
    expect(r.sections[0].hits[0]).toMatchObject({ score: 16, doc: { id: 'a1', name: 'Pay' } })
    expect(isWire(r.sections[0].hits[0].doc)).toBe(false)
  })

  it('does not bring back an entity this tab deleted while the projection still lists it', () => {
    const server = { sections: [section('app', [[16, wire('app', 'gone', 'Pay'), ], [12, wire('app', 'kept', 'Payroll')]])], coverage: FULL }
    expect(shape(merge('pay', [], server, { deleted: ['object:gone'] }))).toEqual([['app', ['kept']]])
    // Nor under a query that reads context, where held entities may come from the server.
    expect(shape(merge('in:main pay', [], server, { deleted: ['object:gone'] }))).toEqual([['app', ['kept']]])
    // The control: not deleted, it shows.
    expect(shape(merge('pay', [], server))).toEqual([['app', ['gone', 'kept']]])
  })

  it('leaves a kind the store holds in full to the store', () => {
    const resident: SpotlightDoc[] = [{ kind: 'diagram', id: 'd1', name: 'Pay overview' }]
    const server = { sections: [section('diagram', [[16, wire('diagram', 'stale', 'Pay')]])], coverage: FULL }
    const r = merge('pay', resident, server, { complete: ['diagram'] })
    expect(shape(r)).toEqual([['diagram', ['d1']]])
    expect(r.sections[0].source).toBe('resident')
    expect(shape(merge('pay', resident, server))).toEqual([['diagram', ['stale', 'd1']]])
  })

  it('shows an object whose kind changed locally once, under the kind the store gives it', () => {
    const r = merge('payments', [{ kind: 'app', id: 'o1', name: 'Payments' }], {
      sections: [section('system', [[16, wire('system', 'o1', 'Payments')]])],
      coverage: FULL,
    })
    expect(shape(r)).toEqual([['app', ['o1']]])
  })

  it('keeps a local entity the projection has not seen yet next to the server hits', () => {
    const r = merge('pay', [{ kind: 'app', id: 'new', name: 'Pay later' }], {
      sections: [section('app', [[16, wire('app', 's', 'Pay')]])],
      coverage: FULL,
    })
    expect(shape(r)).toEqual([['app', ['s', 'new']]])
  })

  it('caps a section at perKind after ordering both tiers together', () => {
    const resident = [1, 2, 3].map((i): SpotlightDoc => ({ kind: 'app', id: `r${i}`, name: `Pay r${i}` }))
    const r = merge('pay', resident, {
      sections: [section('app', [16, 16, 4, 4].map((score, i): [number, SpotlightWireDoc] => [score, wire('app', `s${i}`, `S${i}`)]))],
      coverage: FULL,
    }, { perKind: 4 })
    // s0, s1 exact (16); then the three resident prefix hits (12); s2, s3 (4) are cut.
    expect(shape(r)).toEqual([['app', ['s0', 's1', 'r1', 'r2']]])
  })

  it('recomputes the top hit from the merged sections, and has none for a filters-only query', () => {
    const r = merge('pay', [{ kind: 'app', id: 'a1', name: 'Pay' }], {
      sections: [section('system', [[12, wire('system', 's1', 'Payments')]])],
      coverage: FULL,
    })
    expect(r.topHit?.doc.id).toBe('a1')
    const filters = merge('kind:app', [], { sections: [section('app', [[0, wire('app', 'a2', 'Z')]])], coverage: FULL })
    expect(filters.topHit).toBeNull()
    expect(shape(filters)).toEqual([['app', ['a2']]])
  })

  it('counts at least what either tier counted, and marks a capped count', () => {
    const resident = [1, 2, 3].map((i): SpotlightDoc => ({ kind: 'app', id: `r${i}`, name: `Pay r${i}` }))
    const r = merge('pay', resident, { sections: [section('app', [[16, wire('app', 's1', 'Pay')]], 40, true)], coverage: FULL })
    expect(r.sections[0]).toMatchObject({ total: 40, totalCapped: true })
    const fewer = merge('pay', resident, { sections: [section('app', [[16, wire('app', 's1', 'Pay')]], 1)], coverage: FULL })
    expect(fewer.sections[0]).toMatchObject({ total: 4, totalCapped: false })
    // The store counted more than either list shows (QA: the resident total counts).
    const seven = Array.from({ length: 7 }, (_, i): SpotlightDoc => ({ kind: 'app', id: `m${i}`, name: `Pay m${i}` }))
    const many = merge('pay', seven, { sections: [section('app', [[16, wire('app', 's1', 'Pay')]], 1)], coverage: FULL }, { perKind: 2 })
    expect(many.sections[0]).toMatchObject({ total: 7, totalCapped: false })
  })

  it('lists an entity once even if the server repeats it', () => {
    const r = merge('pay', [], { sections: [section('app', [[16, wire('app', 'a', 'Pay')], [16, wire('app', 'a', 'Pay')]])], coverage: FULL })
    expect(shape(r)).toEqual([['app', ['a']]])
  })
})

describe('mergeSpotlightTiers: queries that read other entities', () => {
  it('shows a held entity the server places in the diagram, as the tab shows it', () => {
    // The store holds a1 but knows none of its diagrams (the open window).
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'a1', name: 'Payments', diagrams: [] }]
    const server = { sections: [section('app', [[12, wire('app', 'a1', 'Payments old', { diagrams: ['Other'] })]])], coverage: FULL }
    const r = merge('in:"Other" pay', resident, server)
    expect(shape(r)).toEqual([['app', ['a1']]])
    // The store's copy (its name), ranked by the server's score.
    expect(r.sections[0].hits[0]).toMatchObject({ score: 12, doc: { name: 'Payments' } })
    expect(isWire(r.sections[0].hits[0].doc)).toBe(false)
    // The control: without the contextual term the store decides, and a1 no longer matches "ledger".
    expect(merge('ledger', resident, { sections: [section('app', [[12, wire('app', 'a1', 'Ledger')]])], coverage: FULL }).sections).toEqual([])
  })

  it('drops that server hit when the entity\'s own fields were edited out of the match', () => {
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'a1', name: 'Billing', diagrams: [] }]
    const server = { sections: [section('app', [[12, wire('app', 'a1', 'Payments', { diagrams: ['Other'] })]])], coverage: FULL }
    expect(merge('in:"Other" pay', resident, server).sections).toEqual([])
  })

  it('files a held entity whose kind changed under the kind the store gives it', () => {
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'x', name: 'Checkout API', diagrams: [] }]
    const server = { sections: [section('system', [[0, wire('system', 'x', 'Checkout API', { diagrams: ['Checkout'] })]])], coverage: FULL }
    expect(shape(merge('in:checkout', resident, server))).toEqual([['app', ['x']]])
  })

  it('does the same for a connection whose endpoint the store does not hold', () => {
    const resident: SpotlightDoc[] = [{ kind: 'connection', id: 'c1', name: 'Reads', from: '', to: 'Orders' }]
    const r = merge('from:gateway', resident, {
      sections: [section('connection', [[0, wire('connection', 'c1', 'Reads', { from: 'Gateway', to: 'Orders' })]])],
      coverage: FULL,
    })
    expect(shape(r)).toEqual([['connection', ['c1']]])
    // ...and on the other end (QA: each context field counts).
    const other: SpotlightDoc[] = [{ kind: 'connection', id: 'c2', name: 'Writes', from: 'Orders', to: '' }]
    expect(shape(merge('to:ledger', other, {
      sections: [section('connection', [[0, wire('connection', 'c2', 'Writes', { from: 'Orders', to: 'Ledger' })]])],
      coverage: FULL,
    }))).toEqual([['connection', ['c2']]])
  })

  it('prefers the resident copy when the store does match it', () => {
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'a1', name: 'Payments', diagrams: ['Other'] }]
    const r = merge('in:other pay', resident, { sections: [section('app', [[12, wire('app', 'a1', 'Payments old')]])], coverage: FULL })
    expect(r.sections[0].hits.map((h) => [h.doc.name, isWire(h.doc)])).toEqual([['Payments', false]])
  })

  it('lets the server exclude a held entity under a NEGATED context term the store cannot see', () => {
    // x is placed on the open "Main" and on the off-window "Checkout": the store knows only Main.
    const resident: SpotlightDoc[] = [
      { kind: 'app', id: 'x', name: 'Pay gateway', diagrams: ['Main'] },
      { kind: 'app', id: 'y', name: 'Pay ledger', diagrams: ['Main'] },
    ]
    // The server, which sees Checkout, returns y only.
    const server = { sections: [section('app', [[12, wire('app', 'y', 'Pay ledger')]])], coverage: FULL }
    expect(shape(merge('pay -in:checkout', resident, server))).toEqual([['app', ['y']]])
    expect(shape(merge('pay NOT has:diagram', [{ kind: 'app', id: 'z', name: 'Pay', diagrams: [] }], { sections: [], coverage: FULL }))).toEqual([])
    // The control: the same hits with a positive term keep both.
    expect(shape(merge('pay in:main', resident, server))).toEqual([['app', ['x', 'y']]])
  })
})

describe('mergeSpotlightTiers: what the server cannot answer', () => {
  it('keeps the resident section for an unavailable kind and ignores what the server sent for it', () => {
    const r = merge('pay', [{ kind: 'adr', id: 'r1', name: 'Pay with cards' }], {
      sections: [section('adr', [[16, wire('adr', 'r2', 'Pay')]])],
      coverage: TODAY,
    })
    expect(shape(r)).toEqual([['adr', ['r1']]])
    expect(r.sections[0]).toMatchObject({ source: 'resident', totalCapped: false })
  })

  it('serves a kind whose missing field the query reads positively, as a lower bound', () => {
    // The read model holds no diagram description: its hits match by name, some are missing.
    const resident: SpotlightDoc[] = [{ kind: 'diagram', id: 'd1', name: 'Overview', description: 'payments landscape' }]
    const server = { sections: [section('diagram', [[16, wire('diagram', 'd2', 'Payments')]])], coverage: TODAY }
    const r = merge('payments', resident, server)
    expect(shape(r)).toEqual([['diagram', ['d2', 'd1']]])
    expect(r.sections[0]).toMatchObject({ source: 'merged', totalCapped: true })
  })

  it('keeps the store alone for a kind whose missing field the query reads negatively', () => {
    // Without the description the server would let "Legacy notes" through "-legacy".
    expect(merge('-legacy', [], { sections: [section('diagram', [[0, wire('diagram', 'd2', 'Legacy notes')]])], coverage: TODAY }).sections).toEqual([])
    expect(merge('-domain:finance', [], { sections: [section('flow', [[0, wire('flow', 'f2', 'Refunds')]])], coverage: TODAY }).sections).toEqual([])
  })

  it('serves diagrams in full for a short unscoped term, which reads names only', () => {
    const server = { sections: [section('diagram', [[12, wire('diagram', 'd2', 'Payments')]])], coverage: TODAY }
    const r = merge('pa', [], server)
    expect(shape(r)).toEqual([['diagram', ['d2']]])
    expect(r.sections[0].totalCapped).toBe(false)
  })

  it('never lets the server answer pages', () => {
    for (const q of ['pay', 'kind:page', '-x']) expect(serverCoverage(parseSpotlightQuery(q), FULL).has('page')).toBe(false)
    const r = merge('settings', [{ kind: 'page', id: 'settings', name: 'Settings' }], {
      sections: [section('page' as SpotlightKind, [[16, wire('page', 'evil', 'Settings')]])],
      coverage: FULL,
    })
    expect(shape(r)).toEqual([['page', ['settings']]])
  })
})

describe('mergeSpotlightTiers: a kind the store holds every entity of', () => {
  it('lets the server place a held group the store cannot see in the diagram (QA: groups under a summary registry)', () => {
    // The store holds the group but none of the diagrams placing it.
    const resident: SpotlightDoc[] = [{ kind: 'group', id: 'g1', name: 'Payments zone', diagrams: [] }]
    const server = { sections: [section('group', [[0, wire('group', 'g1', 'Payments zone', { diagrams: ['Off window'] })]])], coverage: FULL }
    expect(shape(merge('in:"off window"', resident, server, { complete: ['group'] }))).toEqual([['group', ['g1']]])
  })

  it('still drops a server group the store does not hold: in a complete kind it is stale', () => {
    const server = { sections: [section('group', [[0, wire('group', 'gone', 'Payments zone', { diagrams: ['X'] })]])], coverage: FULL }
    expect(merge('in:x', [], server, { complete: ['group'] }).sections).toEqual([])
    expect(merge('pay', [], server, { complete: ['group'] }).sections).toEqual([])
  })

  it('lets the server exclude a held group under a negated context term', () => {
    const resident: SpotlightDoc[] = [{ kind: 'group', id: 'g', name: 'Pay zone', diagrams: ['Main'] }]
    expect(shape(merge('pay -in:checkout', resident, { sections: [], coverage: FULL }, { complete: ['group'] }))).toEqual([])
    // Without a context term the store alone decides.
    expect(shape(merge('pay', resident, { sections: [], coverage: FULL }, { complete: ['group'] }))).toEqual([['group', ['g']]])
  })
})

// ── QA lens, round 2 (2026-10-25): survivors of an independent battery ─────────

describe('mergeSpotlightTiers: QA round 2', () => {
  it('does not drop resident hits under a negated context term when the kind is only partly served', () => {
    // The read model lacks app descriptions here: "payments" reads them positively, so apps are partial.
    const partial: SpotlightCoverage = { unavailableKinds: [], fieldGaps: { app: ['desc'] } }
    const resident: SpotlightDoc[] = [
      { kind: 'app', id: 'x', name: 'Payments gateway', diagrams: ['Main'] },
      { kind: 'app', id: 'y', name: 'Payments ledger', diagrams: ['Main'] },
    ]
    const server = { sections: [section('app', [[12, wire('app', 'y', 'Payments ledger')]])], coverage: partial }
    expect(shape(merge('payments -in:checkout', resident, server))).toEqual([['app', ['x', 'y']]])
  })

  it('keeps the resident score of a hit the server also returned under a negated context term', () => {
    // The store renamed y to an exact match; the projection still has the older name.
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'y', name: 'Pay', diagrams: ['Main'] }]
    const server = { sections: [section('app', [[4, wire('app', 'y', 'Old pay ledger')]])], coverage: FULL }
    const r = merge('pay -in:checkout', resident, server)
    expect(r.sections[0].hits[0]).toMatchObject({ score: 16, doc: { id: 'y', name: 'Pay' } })
  })

  it('does not bring back, with the server score, a held entity the resident ranking cut at perKind', () => {
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'a1', name: 'Pay' }, { kind: 'app', id: 'a2', name: 'Payments' }]
    const server = { sections: [section('app', [[20, wire('app', 'a2', 'Pay')]])], coverage: FULL }
    expect(shape(merge('pay', resident, server, { perKind: 1 }))).toEqual([['app', ['a1']]])
  })

  it('does not file a held entity under a kind the server does not serve', () => {
    const odd: SpotlightCoverage = { unavailableKinds: ['app'], fieldGaps: {} }
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'x', name: 'Checkout API', diagrams: [] }]
    const server = { sections: [section('system', [[0, wire('system', 'x', 'Checkout API', { diagrams: ['Checkout'] })]])], coverage: odd }
    expect(merge('in:checkout', resident, server).sections).toEqual([])
  })

  it('orders a held entity shown for a context term by the name the tab shows', () => {
    const resident: SpotlightDoc[] = [{ kind: 'app', id: 'a1', name: 'Zeta', diagrams: [] }]
    const server = { sections: [section('app', [[0, wire('app', 'a1', 'Alpha', { diagrams: ['X'] })], [0, wire('app', 'a2', 'Beta', { diagrams: ['X'] })]])], coverage: FULL }
    expect(shape(merge('in:x', resident, server))).toEqual([['app', ['a2', 'a1']]])
  })

  it('counts every resident match in a kind the server does not serve', () => {
    const adrs = Array.from({ length: 7 }, (_, i): SpotlightDoc => ({ kind: 'adr', id: `r${i}`, name: `Pay ${i}` }))
    const r = merge('pay', adrs, { sections: [], coverage: TODAY }, { perKind: 2 })
    expect(r.sections[0]).toMatchObject({ kind: 'adr', total: 7, source: 'resident' })
  })

  it('does not count, under a negated context term, the resident matches the server excluded', () => {
    const resident = ['a', 'b', 'c'].map((id): SpotlightDoc => ({ kind: 'app', id, name: `Pay ${id}`, diagrams: ['Main'] }))
    const server = { sections: [section('app', [[12, wire('app', 'b', 'Pay b')]], 1)], coverage: FULL }
    expect(merge('pay -in:checkout', resident, server).sections[0]).toMatchObject({ total: 1 })
  })

  it('keeps the resident count under a negated context term when the kind is only partly served', () => {
    const partial: SpotlightCoverage = { unavailableKinds: [], fieldGaps: { app: ['desc'] } }
    const resident = ['a', 'b', 'c'].map((id): SpotlightDoc => ({ kind: 'app', id, name: `Payments ${id}`, diagrams: ['Main'] }))
    const server = { sections: [section('app', [[12, wire('app', 'b', 'Payments b')]], 1)], coverage: partial }
    expect(merge('payments -in:checkout', resident, server, { perKind: 2 }).sections[0]).toMatchObject({ total: 3, totalCapped: true })
  })
})

describe('serverCoverage', () => {
  const cover = (q: string, complete: SpotlightKind[] = []) => Object.fromEntries(serverCoverage(parseSpotlightQuery(q), TODAY, new Set(complete)))

  it('serves in full, partly, or not at all', () => {
    expect(cover('pa')).toMatchObject({ system: 'full', diagram: 'full', flow: 'full', connection: 'full' })
    expect(cover('pay')).toMatchObject({ system: 'full', diagram: 'partial', flow: 'full' })
    expect(cover('domain:x')).toMatchObject({ system: 'full', flow: 'partial' })
    expect(cover('-pay').diagram).toBeUndefined()
    expect(cover('-domain:x').flow).toBeUndefined()
    expect(cover('pay').adr).toBeUndefined()
    expect(cover('pay', ['group', 'diagram'])).not.toHaveProperty('diagram')
    expect(cover('pay', ['group', 'diagram'])).not.toHaveProperty('group')
    // A query that reads context lets the server rule on placements in a complete kind.
    expect(cover('in:x', ['group'])).toMatchObject({ group: 'full' })
  })

  it('ignores a reported gap on a field the kind does not carry (QA)', () => {
    // A group has no description, so a missing one changes nothing for it.
    const odd: SpotlightCoverage = { unavailableKinds: [], fieldGaps: { group: ['desc'] } }
    expect(serverCoverage(parseSpotlightQuery('pay'), odd).get('group')).toBe('full')
    expect(serverCoverage(parseSpotlightQuery('-pay'), odd).get('group')).toBe('full')
  })
})

describe('spotlightFieldReads and spotlightEntityKey', () => {
  it('reads what the evaluator reads', () => {
    const read = (q: string) => [...spotlightFieldsRead(parseSpotlightQuery(q))].sort()
    expect(read('pa')).toEqual(['name'])
    expect(read('pay')).toEqual(['desc', 'name', 'tag', 'tech'])
    expect(read('has:description')).toEqual(['desc'])
    expect(read('has:diagram')).toEqual(['in'])
    expect(read('has:tech')).toEqual(['tech'])
    expect(read('has:tag')).toEqual(['tag'])
    expect(read('status:live scope:external kind:app')).toEqual(['scope', 'status'])
    expect(read('from:a to:b in:c domain:d')).toEqual(['domain', 'from', 'in', 'to'])
  })

  it('tells negated reads apart', () => {
    const negated = (q: string) => [...spotlightFieldReads(parseSpotlightQuery(q)).negated].sort()
    expect(negated('pay -in:x')).toEqual(['in'])
    expect(negated('NOT has:diagram')).toEqual(['in'])
    expect(negated('-legacy')).toEqual(['desc', 'name', 'tag', 'tech'])
    expect(negated('pay in:x')).toEqual([])
  })

  it('gives the five object kinds one id space', () => {
    expect(spotlightEntityKey('system', 'x')).toBe(spotlightEntityKey('actor', 'x'))
    expect(spotlightEntityKey('group', 'x')).not.toBe(spotlightEntityKey('system', 'x'))
    expect(spotlightEntityKey('connection', 'x')).toBe('connection:x')
  })
})
