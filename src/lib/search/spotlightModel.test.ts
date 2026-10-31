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
import type { C4Object, Connection, DecisionRecord, Diagram, Flow, Group, Tag } from '../../types'
import { parseSpotlightQuery } from './spotlight/grammar'
import {
  SPOTLIGHT_PER_KIND_MAX, SPOTLIGHT_QUERY_MAX, SPOTLIGHT_VOCAB_DOMAINS_MAX, SPOTLIGHT_VOCAB_TAGS_MAX, SPOTLIGHT_VOCAB_TEXT_MAX,
} from './spotlight/wire'
import {
  ROWS_PER_GROUP,
  ROWS_PER_SCOPED_GROUP,
  adrLabels,
  buildSpotlightDocs,
  completionRest,
  groupSpotlightResult,
  rankForScope,
  residentDocsByKey,
  spotlightSearchSource,
  spotlightServerRequest,
  spotlightSuggestions,
  spotlightVocabFingerprint,
} from './spotlightModel'
import type { RankedSpotlight, SpotlightSnapshot } from './spotlightModel'

function object(id: string, name: string, extra: Partial<C4Object> = {}): C4Object {
  return {
    id, name, type: 'app', position: { x: 0, y: 0 }, size: { width: 100, height: 60 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...extra,
  }
}

const tech = (name: string) => ({
  [name]: { id: name, technologyId: `tech-${name}`, catalogRevision: 1, snapshot: { schemaVersion: 1, name } },
}) as unknown as C4Object['technologyUsages']

function snapshotOf(parts: {
  objects?: C4Object[]; connections?: Connection[]; groups?: Group[]; diagrams?: Diagram[]; flows?: Flow[]
  decisionRecords?: DecisionRecord[]; tags?: Tag[]
}): SpotlightSnapshot {
  const objects = parts.objects ?? []
  const diagrams = parts.diagrams ?? []
  const groups = parts.groups ?? []
  const connections = parts.connections ?? []
  const toDiagrams = (pick: (d: Diagram) => string[]) => {
    const map = new Map<string, Set<string>>()
    for (const d of diagrams) for (const id of pick(d)) {
      if (!map.has(id)) map.set(id, new Set())
      map.get(id)!.add(d.id)
    }
    return map
  }
  return {
    objects, connections, groups, diagrams,
    flows: parts.flows ?? [],
    decisionRecords: parts.decisionRecords ?? [],
    domains: [{ id: 'dom-fin', name: 'Finance' }],
    tags: parts.tags ?? [],
    index: {
      objectToDiagramIds: toDiagrams((d) => d.objectIds),
      connectionToDiagramIds: toDiagrams((d) => d.connectionIds),
      groupToDiagramIds: toDiagrams((d) => d.groupIds),
      diagramById: new Map(diagrams.map((d) => [d.id, d])),
      objectById: new Map(objects.map((o) => [o.id, o])),
      groupById: new Map(groups.map((g) => [g.id, g])),
    },
  }
}

function diagram(id: string, name: string, objectIds: string[] = [], connectionIds: string[] = []): Diagram {
  return { id, name, type: 'container', objectIds, connectionIds, groupIds: [] }
}

describe('buildSpotlightDocs', () => {
  const pay = object('o-pay', 'Payment service', {
    technologyUsages: tech('Go'), technologyUsageOrder: ['Go'], domainId: 'dom-fin',
    tagAssignments: { 't-pci': { tagId: 't-pci' } }, tagOrder: ['t-pci'], shortDescription: 'Captures card payments',
  })
  const db = object('o-db', 'Orders database', { type: 'store' })
  const snapshot = snapshotOf({
    objects: [pay, db],
    connections: [{ id: 'c1', fromId: 'o-pay', toId: 'o-db', label: 'Writes orders', type: 'solid' }],
    diagrams: [diagram('d1', 'Checkout flow', ['o-pay'], ['c1'])],
    flows: [{ id: 'f1', name: 'Pay an order', diagramId: 'd1', steps: [] }],
    decisionRecords: [{ id: 'adr-7', number: 7, title: 'Use Postgres', summary: 'Orders need transactions', status: 'approved',
      author: 'Mara', createdAt: '2026-01-01', updatedAt: '2026-01-02', content: '', related: [] }],
    tags: [{ tagId: 't-pci', value: 'PCI scope', color: '#000', groupId: 'g', groupName: 'Risk', catalogRevision: 1 }],
  })
  const docs = buildSpotlightDocs(snapshot, [{ id: 'goObjects', title: 'Model objects', keywords: ['table'] }])
  const doc = (id: string) => docs.find((d) => d.doc.id === id)!

  it('reads technologies from technologyUsages, tags by name, domain and diagrams by name', () => {
    expect(doc('o-pay').doc).toMatchObject({
      kind: 'app', tech: ['Go'], tags: ['PCI scope'], domain: 'Finance', diagrams: ['Checkout flow'],
      description: 'Captures card payments',
    })
    expect(doc('o-db').doc).toMatchObject({ kind: 'store', diagrams: [] })
  })

  it('gives connections their endpoint names, flows their diagram, ADRs their numbers', () => {
    expect(doc('c1').doc).toMatchObject({ kind: 'connection', from: 'Payment service', to: 'Orders database', diagrams: ['Checkout flow'] })
    expect(doc('f1').doc).toMatchObject({ kind: 'flow', diagrams: ['Checkout flow'] })
    expect(doc('adr-7').doc).toMatchObject({ kind: 'adr', alt: ['ADR-7', 'ADR-007'], status: 'approved' })
    expect(doc('goObjects').doc).toMatchObject({ kind: 'page', name: 'Model objects', alt: ['table'] })
  })

  it('finds an object by its technology, tag, ADR number and accent-free spelling', () => {
    const ids = (q: string) => rankForScope(parseSpotlightQuery(q), docs, 'all').sections.flatMap((s) => s.hits.map((h) => h.doc.id))
    expect(ids('tech:go')).toEqual(['o-pay'])
    expect(ids('tag:pci')).toEqual(['o-pay'])
    expect(ids('adr-007')).toEqual(['adr-7'])
    expect(ids('in:checkout kind:store')).toEqual([])
    expect(ids('from:payment')).toEqual(['c1'])
  })

  it('reads tags as orderedTagIds does, as the server tier does (review finding)', () => {
    const snap = snapshotOf({
      objects: [
        object('stale', 'Stale', { tagOrder: ['t-pci'], tagAssignments: {} }),
        object('unordered', 'Unordered', { tagOrder: [], tagAssignments: { 't-pci': { tagId: 't-pci' } } }),
      ],
      tags: [{ tagId: 't-pci', value: 'PCI scope', color: '#000', groupId: 'g', groupName: 'Risk', catalogRevision: 1 }],
    })
    const built = buildSpotlightDocs(snap, [])
    // A stale order entry is a CRDT leftover, not a tag; an unordered assignment is one.
    expect(built.find((d) => d.doc.id === 'stale')!.doc.tags).toEqual([])
    expect(built.find((d) => d.doc.id === 'unordered')!.doc.tags).toEqual(['PCI scope'])
  })

  it('gives a decision record without a usable number no ADR label (none server-side either)', () => {
    expect(adrLabels({ number: 7 })).toEqual(['ADR-7', 'ADR-007'])
    expect(adrLabels({ number: 1234 })).toEqual(['ADR-1234', 'ADR-1234'])
    expect(adrLabels({ number: undefined as unknown as number })).toEqual([])
    expect(adrLabels({ number: 2.5 })).toEqual([])
  })

  it('reuses a prepared document until a context it reads changes', () => {
    // Built here, not at collection: other describe bodies share the one-slot cache.
    const first = buildSpotlightDocs(snapshot, [])
    const again = buildSpotlightDocs(snapshot, [])
    expect(again.find((d) => d.doc.id === 'o-pay')).toBe(first.find((d) => d.doc.id === 'o-pay'))
    // Renaming the diagram is a new diagrams array and index: the object's `in` list must follow.
    const renamed = snapshotOf({ objects: [pay, db], diagrams: [diagram('d1', 'Payments view', ['o-pay'])] })
    const next = buildSpotlightDocs(renamed, [])
    expect(next.find((d) => d.doc.id === 'o-pay')!.doc.diagrams).toEqual(['Payments view'])
  })
})

describe('groupSpotlightResult', () => {
  const objects = Array.from({ length: 7 }, (_, i) => object(`a${i}`, `Payments ${i}`))
  const snapshot = snapshotOf({
    objects: [object('exact', 'Payments', { type: 'system' }), ...objects],
    diagrams: [diagram('d1', 'Payments overview')],
  })
  const docs = buildSpotlightDocs(snapshot, [])

  it('lifts the top hit out of its group and caps groups in the All scope', () => {
    const view = groupSpotlightResult(rankForScope(parseSpotlightQuery('payments'), docs, 'all'), 'all')
    expect(view.topHit?.doc.id).toBe('exact')
    const objectsGroup = view.groups.find((g) => g.id === 'objects')!
    expect(objectsGroup.hits.map((h) => h.doc.id)).not.toContain('exact')
    expect(objectsGroup.hits).toHaveLength(ROWS_PER_GROUP)
    // Every app matches; the top hit (a system) is not counted again.
    expect(objectsGroup.total).toBe(7)
  })

  it('orders groups by their best remaining match', () => {
    const view = groupSpotlightResult(rankForScope(parseSpotlightQuery('payments'), docs, 'all'), 'all')
    // Apps "Payments 0" (prefix, 12) and the diagram "Payments overview" (prefix, 12) tie: objects come first.
    expect(view.groups.map((g) => g.id)).toEqual(['objects', 'diagrams'])
    const overview = groupSpotlightResult(rankForScope(parseSpotlightQuery('overview'), docs, 'all'), 'all')
    expect(overview.topHit?.doc.id).toBe('d1')
    expect(overview.groups).toEqual([])
  })

  it('lists a scope in full and only that scope', () => {
    const view = groupSpotlightResult(rankForScope(parseSpotlightQuery('payments'), docs, 'objects'), 'objects')
    expect(view.groups.map((g) => g.id)).toEqual(['objects'])
    expect(view.groups[0].hits).toHaveLength(7)
  })
})

describe('spotlightSuggestions', () => {
  const snapshot = snapshotOf({
    objects: [object('o1', 'Web app', { technologyUsages: tech('PostgreSQL') }), object('o2', 'Worker', { technologyUsages: tech('Python') })],
    diagrams: [diagram('d1', 'Checkout flow'), diagram('d2', 'Fulfilment')],
    tags: [{ tagId: 't1', value: 'payments', color: '#000', groupId: 'g', groupName: 'Area', catalogRevision: 1 }],
  })
  const suggest = (q: string) => spotlightSuggestions(parseSpotlightQuery(q), snapshot)

  it('completes enum values and keeps the rest of the query', () => {
    expect(suggest('api kind:sy')).toEqual([{ key: 'kind', value: 'system', insert: 'api kind:system ' }])
    expect(suggest('kind:app,st').map((s) => s.insert)).toEqual(['kind:app,store '])
  })

  it('offers names the store holds, quoting values with spaces', () => {
    expect(suggest('tag:').map((s) => s.value)).toEqual(['payments'])
    expect(suggest('tech:p').map((s) => s.value)).toEqual(['PostgreSQL', 'Python'])
    expect(suggest('tech:gres').map((s) => s.value)).toEqual(['PostgreSQL'])
    expect(suggest('in:"Check')).toEqual([{ key: 'in', value: 'Checkout flow', insert: 'in:"Checkout flow" ' }])
  })

  it('offers nothing for free-text keys, a finished value, or plain words', () => {
    expect(suggest('name:pay')).toEqual([])
    expect(suggest('tag:payments api')).toEqual([])
    expect(suggest('payments')).toEqual([])
  })

  it('stops suggesting a value once it is typed in full (found in the browser after a fix)', () => {
    expect(suggest('kind:system')).toEqual([])
    expect(suggest('tag:Payments')).toEqual([])
    expect(suggest('kind:syst').map((s) => s.value)).toEqual(['system'])
  })
})

describe('completionRest (ghost text)', () => {
  it('completes a plain prefix, any case', () => {
    expect(completionRest('Payment service', 'pay')).toBe('ment service')
    expect(completionRest('Payment service', 'PAYMENT')).toBe(' service')
  })

  it('completes across accents, keeping the source characters', () => {
    expect(completionRest('Énergie tarifs', 'energ')).toBe('ie tarifs')
    expect(completionRest('Cœur de métier', 'coeur')).toBe(' de métier')
  })

  it('offers nothing when the typed text is not a prefix, or already complete', () => {
    expect(completionRest('Card payments', 'pay')).toBeNull()
    expect(completionRest('Payments', 'payments')).toBeNull()
    expect(completionRest('Énergie', 'energie')).toBeNull()
    expect(completionRest('Énergie tarifs', 'energie ')).toBeNull()
  })
})

describe('the server tier request', () => {
  const vocab = { domains: [{ id: 'd1', name: 'Finance' }], tags: [{ tagId: 't1', value: 'pci' }] } as unknown as Pick<SpotlightSnapshot, 'domains' | 'tags'>
  const request = (typed: string, scope: Parameters<typeof spotlightServerRequest>[2] = 'all', v = vocab) => {
    const parsed = parseSpotlightQuery(typed)
    const source = spotlightSearchSource(typed, parsed, scope)
    return source === null ? null : spotlightServerRequest(source, source === typed ? parsed : parseSpotlightQuery(source), scope, v)
  }

  it('asks with what the UI shows: rows per group plus the top hit, and the vocabulary', () => {
    expect(request('pay')).toEqual({ q: 'pay', perKind: ROWS_PER_GROUP + 1, vocab: { domains: [['d1', 'Finance']], tags: [['t1', 'pci']] } })
    expect(request('pay', 'diagrams')).toMatchObject({ q: 'pay', kinds: ['diagram'], perKind: ROWS_PER_SCOPED_GROUP + 1 })
    expect(ROWS_PER_SCOPED_GROUP + 1).toBeLessThanOrEqual(SPOTLIGHT_PER_KIND_MAX)
  })

  it('lists a whole scope on an empty field, and asks nothing for an empty All field or ?', () => {
    expect(request('', 'decisions')).toMatchObject({ q: 'kind:adr', kinds: ['adr'] })
    expect(request('')).toBeNull()
    expect(request('  ?  ')).toBeNull()
    expect(request('tag:')).toBeNull()
  })

  it('asks nothing when no server-side kind can match', () => {
    expect(request('settings', 'actions')).toBeNull()
    expect(request('kind:page')).toBeNull()
    expect(request('kind:adr', 'objects')).toBeNull()
  })

  it('asks nothing past the limits the server enforces, and cuts an over-long name', () => {
    expect(request('x'.repeat(SPOTLIGHT_QUERY_MAX))).not.toBeNull()
    expect(request('x'.repeat(SPOTLIGHT_QUERY_MAX + 1))).toBeNull()
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ tagId: `t${i}`, value: `v${i}` }))
    expect(request('pay', 'all', { domains: [], tags: many(SPOTLIGHT_VOCAB_TAGS_MAX) } as never)).not.toBeNull()
    expect(request('pay', 'all', { domains: [], tags: many(SPOTLIGHT_VOCAB_TAGS_MAX + 1) } as never)).toBeNull()
    const long = request('pay', 'all', { domains: [{ id: 'd', name: 'n'.repeat(300) }, { id: 'i'.repeat(300), name: 'x' }], tags: [] } as never)
    expect(long?.vocab.domains).toEqual([['d', 'n'.repeat(SPOTLIGHT_VOCAB_TEXT_MAX)]])
    // The same bounds for domains and for tags (QA).
    const domains = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, name: `n${i}` }))
    expect(request('pay', 'all', { domains: domains(SPOTLIGHT_VOCAB_DOMAINS_MAX), tags: [] } as never)).not.toBeNull()
    expect(request('pay', 'all', { domains: domains(SPOTLIGHT_VOCAB_DOMAINS_MAX + 1), tags: [] } as never)).toBeNull()
    const longTag = request('pay', 'all', { domains: [], tags: [{ tagId: 't', value: 'v'.repeat(300) }, { tagId: 'i'.repeat(300), value: 'x' }] } as never)
    expect(longTag?.vocab.tags).toEqual([['t', 'v'.repeat(SPOTLIGHT_VOCAB_TEXT_MAX)]])
  })

  it('fingerprints the vocabulary by content', () => {
    const fp = (domains: Array<[string, string]>, tags: Array<[string, string]>) => spotlightVocabFingerprint({
      domains: domains.map(([id, name]) => ({ id, name })),
      tags: tags.map(([tagId, value]) => ({ tagId, value })),
    } as never)
    const a = spotlightVocabFingerprint(vocab)
    expect(fp([['d1', 'Finance']], [['t1', 'pci']])).toBe(a)
    expect(fp([['d1', 'Finances']], [['t1', 'pci']])).not.toBe(a)
    expect(fp([['d2', 'Finance']], [['t1', 'pci']])).not.toBe(a)
    expect(fp([['d1', 'Finance']], [['t1', 'pcI']])).not.toBe(a)
    expect(fp([['d1', 'Finance']], [['t2', 'pci']])).not.toBe(a)
    expect(fp([], [['d1', 'Finance'], ['t1', 'pci']])).not.toBe(a)
    // Strings are delimited: moving a character from one to the next changes it (QA).
    expect(fp([['ab', 'c']], [])).not.toBe(fp([['a', 'bc']], []))
  })
})

describe('grouping a merged ranking', () => {
  it('carries a capped count into its group, and only there', () => {
    const merged: RankedSpotlight = {
      topHit: null,
      sections: [
        { kind: 'system', total: 7, totalCapped: true, source: 'merged', hits: [{ score: 4, sortName: 'a', doc: { kind: 'system', id: 's', name: 'A' } }] },
        { kind: 'diagram', total: 1, totalCapped: false, source: 'resident', hits: [{ score: 4, sortName: 'b', doc: { kind: 'diagram', id: 'd', name: 'B' } }] },
      ],
    }
    const view = groupSpotlightResult(merged, 'all')
    expect(view.groups.map((g) => [g.id, g.total, g.totalCapped])).toEqual([['objects', 7, true], ['diagrams', 1, false]])
  })

  it('knows which entities the store holds, objects in one id space, pages not at all', () => {
    const docs = buildSpotlightDocs(snapshotOf({ objects: [object('o1', 'A', { type: 'system' })] }), [{ id: 'goObjects', title: 'Model objects', keywords: [] }])
    const byKey = residentDocsByKey(docs)
    expect([...byKey.keys()]).toEqual(['object:o1'])
    expect(byKey.get('object:o1')?.doc.name).toBe('A')
  })
})
