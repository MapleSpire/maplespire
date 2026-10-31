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

import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import {
  linkTypesForKind,
  removeDecisionRecordLinks,
  type DecisionRecordLike,
  type MetaLike,
} from './decisionRecordLinkRemoval.js'

const link = (id: string, type: string, targetId: string) => ({ id, type, targetId })
const record = (id: string, related: ReturnType<typeof link>[], content = 'BASE'): DecisionRecordLike =>
  ({ id, content, related })

const meta = (over: Partial<MetaLike> = {}): MetaLike => ({
  decisionRecords: {
    'adr-1': record('adr-1', [
      link('l1', 'diagram', 'dg-live'),
      link('l2', 'diagram', 'dg-gone'),
      link('l3', 'adr', 'adr-gone'),
    ]),
  },
  deletedDecisionRecordIds: [],
  ...over,
})

const strip = (m: MetaLike, targetId: string, kind = 'decisionRecord.related.diagram', adrId = 'adr-1') =>
  removeDecisionRecordLinks(m, [{ adrId, targetId, types: linkTypesForKind(kind) }], new Map())

const idsOf = (m: MetaLike, adrId = 'adr-1') =>
  (m.decisionRecords![adrId].related as Array<{ id: string }>).map((l) => l.id)

describe('removeDecisionRecordLinks', () => {
  it('removes only the link naming the dead target', () => {
    const m = meta()
    expect(strip(m, 'dg-gone')).toEqual([{ adrId: 'adr-1', targetId: 'dg-gone', outcome: 'removed', removed: 1 }])
    expect(idsOf(m)).toEqual(['l1', 'l3'])
  })

  it('matches on target AND type, so an adr kind never eats a diagram link', () => {
    // The scan reports these as two different kinds; repairing one must not
    // silently take the other with it.
    const m = meta()
    expect(strip(m, 'dg-gone', 'decisionRecord.related.adr')[0].outcome).toBe('not-found')
    expect(idsOf(m)).toEqual(['l1', 'l2', 'l3'])
  })

  it('covers adr AND draft under the record kind, which the scan reports together', () => {
    const m = meta({
      decisionRecords: { 'adr-1': record('adr-1', [link('d1', 'draft', 'adr-gone'), link('a1', 'adr', 'adr-gone')]) },
    })
    expect(strip(m, 'adr-gone', 'decisionRecord.related.adr')[0].removed).toBe(2)
    expect(idsOf(m)).toEqual([])
  })

  it('removes EVERY duplicate of the same dead target, not just the first', () => {
    // Two adjacent matches: a head-first splice would skip the second as the
    // indices shift.
    const m = meta({
      decisionRecords: { 'adr-1': record('adr-1', [
        link('a', 'diagram', 'dg-gone'), link('b', 'diagram', 'dg-gone'), link('c', 'diagram', 'dg-live'),
      ]) },
    })
    expect(strip(m, 'dg-gone')[0].removed).toBe(2)
    expect(idsOf(m)).toEqual(['c'])
  })

  it('removes an id-less link the paged read model can produce', () => {
    // `related` arrives unvalidated on that path, so matching by `link.id` would
    // silently skip exactly the rows most likely to be broken.
    const m: MetaLike = { decisionRecords: { 'adr-1': { related: [{ type: 'diagram', targetId: 'dg-gone' }] } } }
    expect(strip(m, 'dg-gone')[0].removed).toBe(1)
  })

  it('reports not-found rather than success when there is nothing to remove', () => {
    // `applied` is counted from outcomes; calling this success is how a repair
    // reports a change it did not make.
    expect(strip(meta(), 'dg-never-there')[0].outcome).toBe('not-found')
  })

  it('is idempotent', () => {
    const m = meta()
    strip(m, 'dg-gone')
    expect(strip(m, 'dg-gone')[0]).toMatchObject({ outcome: 'not-found', removed: 0 })
    expect(idsOf(m)).toEqual(['l1', 'l3'])
  })

  it('never touches a tombstoned record, which would resurrect it', () => {
    const m = meta({ decisionRecords: {}, deletedDecisionRecordIds: ['adr-1'] })
    expect(strip(m, 'dg-gone')[0].outcome).toBe('tombstoned')
    expect(m.decisionRecords).toEqual({})
  })

  it('reports absent when there is no overlay entry and no baseline to seed one', () => {
    const m = meta({ decisionRecords: {} })
    expect(strip(m, 'dg-gone')[0].outcome).toBe('absent')
    expect(m.decisionRecords).toEqual({})
  })

  it('seeds the overlay from the MATERIALIZED baseline when the entry is missing', () => {
    const m = meta({ decisionRecords: {} })
    const baseline = new Map([['adr-1', record('adr-1', [link('l1', 'diagram', 'dg-live'), link('l2', 'diagram', 'dg-gone')], 'MATERIALIZED')]])
    const out = removeDecisionRecordLinks(m, [{ adrId: 'adr-1', targetId: 'dg-gone', types: ['diagram'] }], baseline)
    expect(out[0].outcome).toBe('removed')
    expect(idsOf(m)).toEqual(['l1'])
    // Materialized, not the shard copy: nothing edited since the baseline is
    // rolled back by the seeding write.
    expect(m.decisionRecords!['adr-1'].content).toBe('MATERIALIZED')
  })

  it('ignores a link whose `type` is not a string', () => {
    // `related` arrives unvalidated on the paged path, so pin the behaviour.
    // Note what this does NOT prove: dropping the `typeof` guard in `matches`
    // still passes, because `includes` compares with SameValueZero and no
    // non-string can match. The guard is narrowing, not filtering.
    const m: MetaLike = { decisionRecords: { 'adr-1': { related: [
      { type: 7, targetId: 'dg-gone' }, { type: null, targetId: 'dg-gone' }, { targetId: 'dg-gone' },
    ] } } }
    expect(strip(m, 'dg-gone')[0].outcome).toBe('not-found')
    expect((m.decisionRecords!['adr-1'].related as unknown[]).length).toBe(3)
  })

  it('maps each kind to exactly its own link types, in BOTH directions', () => {
    // Asserting only that the adr kind excludes `diagram` leaves the mirror
    // mutant alive: a diagram kind that also returns ['adr','draft'] passes.
    expect([...linkTypesForKind('decisionRecord.related.diagram')]).toEqual(['diagram'])
    expect([...linkTypesForKind('decisionRecord.related.adr')]).toEqual(['adr', 'draft'])
  })

  it('does not alias the baseline it seeded from', () => {
    const baselineRecord = record('adr-1', [link('l2', 'diagram', 'dg-gone')])
    const m = meta({ decisionRecords: {} })
    removeDecisionRecordLinks(m, [{ adrId: 'adr-1', targetId: 'dg-gone', types: ['diagram'] }],
      new Map([['adr-1', baselineRecord]]))
    expect((baselineRecord.related as unknown[]).length).toBe(1)
  })
})

/**
 * The reason this is a splice at all. A whole-record write works on every read
 * path and resurrects nothing — and still destroys any concurrent edit to that
 * record, because `map[id] = {...}` is the only write to the key, so Automerge
 * has no conflict to resolve and the peer's subtree becomes unreachable.
 *
 * The negative control is the point: without it these tests pass against the
 * implementation this design exists to reject.
 */
describe('concurrency: the splice keeps a peer’s work, a whole-record write does not', () => {
  interface Doc { [k: string]: unknown; decisionRecords: Record<string, DecisionRecordLike> }
  const base = () => Automerge.from<Doc>({
    decisionRecords: { 'adr-1': record('adr-1', [link('l1', 'diagram', 'dg-live'), link('l2', 'diagram', 'dg-gone')]) },
  })
  const repaired = (doc: Automerge.Doc<Doc>) => Automerge.change(Automerge.clone(doc, { actor: 'aaaaaa' }), (d) => {
    removeDecisionRecordLinks(d as MetaLike, [{ adrId: 'adr-1', targetId: 'dg-gone', types: ['diagram'] }], new Map())
  })
  /** What NOT to do, kept so the tests can prove the difference. */
  const clobbered = (doc: Automerge.Doc<Doc>) => Automerge.change(Automerge.clone(doc, { actor: 'aaaaaa' }), (d) => {
    const cur = d.decisionRecords['adr-1']
    d.decisionRecords['adr-1'] = {
      ...cur,
      related: (cur.related as Array<{ targetId?: unknown }>).filter((l) => l?.targetId !== 'dg-gone').map((l) => ({ ...l })),
    }
  })
  const view = (d: Automerge.Doc<Doc>) => {
    const r = d.decisionRecords['adr-1']
    return { content: r.content, links: (r.related as Array<{ id: string }>).map((l) => l.id) }
  }

  it('keeps a peer’s concurrent content edit, in both merge orders', () => {
    const b = base()
    const peer = Automerge.change(Automerge.clone(b, { actor: 'bbbbbb' }), (d) => {
      d.decisionRecords['adr-1'].content = 'PEER EDIT'
    })
    expect(view(Automerge.merge(Automerge.clone(repaired(b)), peer))).toEqual({ content: 'PEER EDIT', links: ['l1'] })
    expect(view(Automerge.merge(Automerge.clone(peer), repaired(b)))).toEqual({ content: 'PEER EDIT', links: ['l1'] })
  })

  it('keeps a link the peer added while the repair was removing another', () => {
    const b = base()
    const peer = Automerge.change(Automerge.clone(b, { actor: 'bbbbbb' }), (d) => {
      d.decisionRecords['adr-1'].related!.push(link('l3', 'adr', 'adr-new'))
    })
    expect(view(Automerge.merge(Automerge.clone(repaired(b)), peer)).links).toEqual(['l1', 'l3'])
  })

  it('NEGATIVE CONTROL: a whole-record write loses both', () => {
    // If this ever starts passing, the implementation stopped splicing.
    const b = base()
    const editing = Automerge.change(Automerge.clone(b, { actor: 'bbbbbb' }), (d) => {
      d.decisionRecords['adr-1'].content = 'PEER EDIT'
    })
    expect(view(Automerge.merge(Automerge.clone(clobbered(b)), editing)).content).toBe('BASE')

    const appending = Automerge.change(Automerge.clone(b, { actor: 'bbbbbb' }), (d) => {
      d.decisionRecords['adr-1'].related!.push(link('l3', 'adr', 'adr-new'))
    })
    expect(view(Automerge.merge(Automerge.clone(clobbered(b)), appending)).links).toEqual(['l1'])
  })

  it('lets two repairs strip different dead links without either being lost', () => {
    const b = Automerge.from<Doc>({
      decisionRecords: { 'adr-1': record('adr-1', [
        link('l1', 'diagram', 'dg-live'), link('l2', 'diagram', 'dg-gone-a'), link('l3', 'diagram', 'dg-gone-b'),
      ]) },
    })
    const one = Automerge.change(Automerge.clone(b, { actor: 'aaaaaa' }), (d) => {
      removeDecisionRecordLinks(d as MetaLike, [{ adrId: 'adr-1', targetId: 'dg-gone-a', types: ['diagram'] }], new Map())
    })
    const two = Automerge.change(Automerge.clone(b, { actor: 'bbbbbb' }), (d) => {
      removeDecisionRecordLinks(d as MetaLike, [{ adrId: 'adr-1', targetId: 'dg-gone-b', types: ['diagram'] }], new Map())
    })
    expect(view(Automerge.merge(Automerge.clone(one), two)).links).toEqual(['l1'])
  })

  it('a meta WITHOUT decisionRecords keeps the seeded record and the removal', () => {
    // `meta.decisionRecords ?? (meta.decisionRecords = {})` handed back the
    // plain `{}`, so the seed and the splice landed on a detached object, the
    // document kept an empty map, and the result still said 'removed'.
    const b = Automerge.from<Record<string, unknown>>({ marker: 1 })
    const baseline = new Map([[
      'adr-1', record('adr-1', [link('l1', 'diagram', 'dg-live'), link('l2', 'diagram', 'dg-gone')]),
    ]])
    let results: ReturnType<typeof removeDecisionRecordLinks> = []
    const after = Automerge.change(b, (d) => {
      results = removeDecisionRecordLinks(
        d as MetaLike, [{ adrId: 'adr-1', targetId: 'dg-gone', types: ['diagram'] }], baseline,
      )
    })
    expect(results[0]).toMatchObject({ outcome: 'removed', removed: 1 })
    expect(view(after as Automerge.Doc<Doc>)).toEqual({ content: 'BASE', links: ['l1'] })
  })

  it('records no new change when there was nothing to remove', () => {
    // The head check is what lets the caller assert an effect instead of an
    // intention.
    const b = base()
    const once = repaired(b)
    const twice = Automerge.change(Automerge.clone(once, { actor: 'aaaaaa' }), (d) => {
      removeDecisionRecordLinks(d as MetaLike, [{ adrId: 'adr-1', targetId: 'dg-gone', types: ['diagram'] }], new Map())
    })
    expect(Automerge.getHeads(twice)).toEqual(Automerge.getHeads(once))
  })
})
