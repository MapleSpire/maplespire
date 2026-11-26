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

import { randomBytes } from 'node:crypto'
import * as A from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { buildEpochShard } from './modelEpochs.js'
import { birthHeadsOf } from './readModel/modelEpochForwarder.js'
import {
  applyTargetPlan,
  findForwardChange,
  forwardMessage,
  lateChanges,
  listElementIds,
  planForwardTarget,
  putToElementMap,
  rebuildElemMap,
  putToElementStats,
  putToElementCacheSize,
  resetPutToElementCache,
  setPutToElementCacheMaxEntriesForTest,
  viewAt,
  type ForwardSource,
  type ForwardTarget,
  type PlannedInsert,
} from './modelEpochForward.js'

/**
 * G4-16f — the epoch forward planner and applier, against real Automerge
 * 3.2.6, ported from the standalone probes that first measured it ("the
 * probe-2 matrix" and "probe 3" below). Every scenario runs with one FIXED
 * actor set and SEEDS random ones, so no result depends on an actor ordering.
 */
type D = Record<string, unknown>
type Entity = Record<string, unknown>
const SEEDS = 25
const hex = () => randomBytes(16).toString('hex')
const objectsOf = (doc: A.Doc<D>) => doc.objects as Record<string, Entity>
const entity = (i: number | string): Entity => ({
  id: `o${i}`, name: `name ${i}`, ref: new A.ImmutableString(`automerge:ref${i}`), hits: new A.Counter(5),
  tags: ['a', 'b', 'c'], technologies: [{ name: 'lib', v: 1 }, { name: 'rt', v: 2 }],
  meta: { owner: 'ann', team: 't1' }, flag: false, n: 3,
})
const SHARD = (doc: A.Doc<D>): Omit<ForwardSource, 'from' | 'to' | 'cut' | 'elemMap'> & { doc: A.Doc<D> } => ({
  doc, collections: new Set(['objects']), excludedRootKeys: new Set(['epochSuccessorRef']),
})

/** One forward of `source` into ONE target, as the service will drive it:
 * plan, apply in one change with its message, rebuild the element ids from
 * that change. */
function forwardInto(
  source: ForwardSource, target: ForwardTarget, journalId: string,
): { doc: A.Doc<D>; elemMap: Map<string, string>; plan: ReturnType<typeof planForwardTarget> } {
  const plan = planForwardTarget(source, target)
  const message = forwardMessage(journalId, target.documentId)
  const doc = A.change(target.doc as A.Doc<D>, { message }, (draft) => { applyTargetPlan(draft, plan, source.doc, source.to) })
  const rebuilt = rebuildElemMap(doc, message, plan.plannedInserts) ?? new Map()
  return { doc, elemMap: new Map([...source.elemMap, ...rebuilt]), plan }
}

interface Actors { server: string; roller: string; marie: string; carl: string; dana: string }
const fixedActors: Actors = { server: '01'.repeat(16), roller: '02'.repeat(16), marie: '03'.repeat(16), carl: '06'.repeat(16), dana: '04'.repeat(16) }
const randomActors = (): Actors => ({ server: hex(), roller: hex(), marie: hex(), carl: hex(), dana: hex() })

/** The probe-2 matrix. */
function marieScenario(actors: Actors) {
  let old = A.from<D>({ objects: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => [`o${i}`, entity(i)])) }, { actor: actors.server })
  old = A.change(old, (d) => {
    // o11: a list of maps whose elements hold their own list.
    objectsOf(d).o11!.layers = [{ name: 'l0', items: ['x'] }, { name: 'l1', items: ['y'] }]
  })
  let marie = A.clone(old, { actor: actors.marie })
  old = A.change(old, (d) => { objectsOf(d).o8!.name = 'server pre-cut'; (objectsOf(d).o0!.tags as unknown[])[1] = 'B' })
  const cut = A.getHeads(old)
  let cur = buildEpochShard<D>(old, cut, actors.roller)
  const birth = A.getHeads(cur)
  marie = A.change(marie, (d) => {
    const o = objectsOf(d)
    ;(o.o0!.tags as unknown[]).push('marie') // list insert
    A.splice(d, ['objects', 'o1', 'name'], 0, 0, 'M:') // text splice
    ;(o.o2!.hits as A.Counter).increment(2) // counter
    ;(o.o3!.meta as Entity).owner = 'marie' // nested key (Carl edits another, Dana the same, unsynced)
    o.o4!.flag = true // same leaf as Carl
    A.deleteAt(o.o5!.tags as unknown[], 0) // list delete by identity
    ;((o.o6!.technologies as Entity[])[1]!).v = 9 // a leaf in a list element Carl shifts
    o.o7!.n = 4 // Carl deletes the entity
    o.m0 = entity(100) // created offline
    o.o9!.ref = new A.ImmutableString('automerge:marie') // ImmutableString leaf
    delete o.o10 // a late entity deletion (nobody touched it after the cut)
    // In ONE session: an insert in the OUTER list and one in an inner list of
    // a later element — the inner one was planned at the element's current
    // index, which the outer insert shifts unless the inner is applied first.
    const layers = o.o11!.layers as Array<Entity>
    ;(layers[1]!.items as unknown[]).push('marie-inner')
    A.insertAt(layers as unknown[], 0, { name: 'marie-layer', items: [] })
  })
  cur = A.change(cur, { time: 0 }, (d) => {
    const o = objectsOf(d)
    ;(o.o0!.tags as unknown[]).push('carl')
    A.splice(d, ['objects', 'o1', 'name'], (o.o1!.name as string).length, 0, ' :C')
    ;(o.o2!.hits as A.Counter).increment(1)
    ;(o.o3!.meta as Entity).team = 'carl-team'
    o.o4!.flag = 'carl'
    ;(o.o5!.tags as unknown[])[2] = 'carl-c'
    A.insertAt(o.o6!.technologies as unknown[], 0, { name: 'carl-lib', v: 0 })
    delete o.o7
  })
  let dana = A.clone(cur, { actor: actors.dana })
  dana = A.change(dana, (d) => { A.insertAt(objectsOf(d).o0!.tags as unknown[], 0, 'dana'); (objectsOf(d).o3!.meta as Entity).owner = 'dana' })
  old = A.merge(old, marie)
  const before = A.getHeads(old)
  old = A.change(old, (d) => { d.epochSuccessorRef = new A.ImmutableString('automerge:next') }) // S8, the server's own
  const serverHashes = new Set(A.getChangesMetaSince(old, before).map((m) => m.hash))
  return { old, cut, cur, birth, dana, serverHashes }
}

function runMarie(actors: Actors) {
  const s = marieScenario(actors)
  const to = A.getHeads(s.old)
  // Read BEFORE the second session: `A.merge` advances its first argument.
  const late = lateChanges(s.old, s.cut, s.serverHashes)
  const source: ForwardSource = { ...SHARD(s.old), from: s.cut, to, cut: s.cut, elemMap: new Map() }
  const target: ForwardTarget = { documentId: 'T', doc: s.cur, birthHeads: s.birth, receives: () => true }
  const f1 = forwardInto(source, target, 'j1')
  // Crash between the flush and the CAS, then Carl sets o4.flag back to the
  // late writer's BASE: the replay must still write nothing (message, not value).
  const reverted = A.change(f1.doc, (d) => { objectsOf(d).o4!.flag = false })
  const replayFound = findForwardChange(reverted, forwardMessage('j1', 'T'), s.birth) !== undefined
  // A second Marie session after the first forward (cursor = planned to),
  // anchored on her own forwarded element.
  let marie2 = A.clone(s.old, { actor: actors.marie })
  marie2 = A.change(marie2, (d) => { const t = objectsOf(d).o0!.tags as string[]; A.insertAt(t, t.indexOf('marie') + 1, 'marie2') })
  const old2 = A.merge(s.old, marie2)
  const source2: ForwardSource = { ...SHARD(old2), from: to, to: A.getHeads(old2), cut: s.cut, elemMap: f1.elemMap }
  const f2 = forwardInto(source2, { documentId: 'T', doc: reverted, birthHeads: s.birth, receives: () => true }, 'j2')
  const fin = objectsOf(A.merge(f2.doc, s.dana))
  const tags = [...(fin.o0!.tags as string[])]
  return {
    plan: f1.plan, f2plan: f2.plan, replayFound, fin, late,
    checks: {
      listAllInserts: ['marie', 'carl', 'dana', 'marie2'].every((t) => tags.includes(t)),
      listSecondAfterFirst: tags.indexOf('marie2') === tags.indexOf('marie') + 1,
      listOverwrittenPreCutKept: tags.includes('B') && !tags.includes('b'),
      textBothSplices: (fin.o1!.name as string).startsWith('M:') && (fin.o1!.name as string).endsWith(' :C'),
      counterSum: (fin.o2!.hits as A.Counter).value === 8,
      nestedDifferentKeys: (fin.o3!.meta as Entity).team === 'carl-team',
      leafCurrentWinsAfterRevert: fin.o4!.flag === false,
      listDeleteByIdentity: !(fin.o5!.tags as string[]).includes('a') && (fin.o5!.tags as string[]).includes('carl-c') && (fin.o5!.tags as string[]).includes('b'),
      leafInShiftedListElement: (fin.o6!.technologies as Entity[]).length === 3 && (fin.o6!.technologies as Entity[])[2]!.v === 9
        && (fin.o6!.technologies as Entity[])[0]!.name === 'carl-lib',
      entityDeleteWins: !('o7' in fin),
      createdWithKinds: 'm0' in fin && A.isCounter(fin.m0!.hits) && A.isImmutableString(fin.m0!.ref),
      preCutEditKept: fin.o8!.name === 'server pre-cut',
      immutableStringLeaf: A.isImmutableString(fin.o9!.ref) && String((fin.o9!.ref as A.ImmutableString).val) === 'automerge:marie',
      lateEntityDeletion: !('o10' in fin),
      innerListInShiftedElement: JSON.stringify((fin.o11!.layers as Entity[]).map((l) => [l.name, [...(l.items as string[])]]))
        === JSON.stringify([['marie-layer', []], ['l0', ['x']], ['l1', ['y', 'marie-inner']]]),
    },
  }
}

describe('viewAt', () => {
  it('two head sets of the SAME size are two views — the memo is keyed by the heads, not their count', () => {
    let doc = A.change(A.init<{ v: string }>(), (d) => { d.v = 'one' })
    const atOne = A.getHeads(doc)
    doc = A.change(doc, (d) => { d.v = 'two' })
    const atTwo = A.getHeads(doc)
    doc = A.change(doc, (d) => { d.v = 'three' })
    expect(atOne).toHaveLength(1)
    expect(atTwo).toHaveLength(1)
    expect(viewAt(doc, atOne).v).toBe('one')
    expect(viewAt(doc, atTwo).v).toBe('two')
    // Memoized: the same heads give the same view, in any order.
    expect(viewAt(doc, atOne)).toBe(viewAt(doc, [...atOne]))
    // Its own heads: the document itself.
    expect(viewAt(doc, A.getHeads(doc))).toBe(doc)
  })
})

describe('decoded op-id layout (Automerge 3.2.6 contract the forwarder relies on)', () => {
  it('op k of a decoded change is `${startOp + k}@${actor}`, and a put at a list element carries its elemId', () => {
    let doc = A.from<D>({ l: ['a', 'b', 'c'] }, { actor: '0a'.repeat(16) })
    const be0 = A.getBackend(doc)
    const list = A.getObjectId(doc, 'l')!
    const inserted = [0, 1, 2].map((i) => String(be0.getAll(list, i)[0]!.at(-1)))
    const heads = A.getHeads(doc)
    doc = A.change(doc, (d) => { (d.l as unknown[])[1] = 'B' })
    const change = A.decodeChange(A.getChangesSince(doc, heads)[0]!)
    // The winning op id of the overwritten element is the put's own id...
    const winner = String(A.getBackend(doc).getAll(list, 1)[0]!.at(-1))
    const putIndex = change.ops.findIndex((op) => (op as { elemId?: string }).elemId === inserted[1])
    expect(putIndex).toBeGreaterThanOrEqual(0)
    expect(winner).toBe(`${change.startOp + putIndex}@${change.actor}`)
    // ...and the put names the element by its INSERT id.
    expect((change.ops[putIndex] as { elemId?: string }).elemId).toBe(inserted[1])
    // So the put → element map resolves the winner back to the element.
    expect(putToElementMap(doc).get(winner)).toBe(inserted[1])
    expect(listElementIds(doc, ['l'], undefined, putToElementMap(doc)).ids).toEqual(inserted)
  })

  it('a document\'s birth heads are remembered per document id, and stay its FIRST change as it grows', () => {
    let doc = A.from<D>({ l: ['a'] } as unknown as D, { actor: '0e'.repeat(16) })
    const birth = [A.decodeChange(A.getAllChanges(doc)[0]!).hash]
    expect(birthHeadsOf(doc as A.Doc<unknown>, 'doc-birth-1')).toEqual(birth)
    doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = 'b' })
    expect(birthHeadsOf(doc as A.Doc<unknown>, 'doc-birth-1')).toEqual(birth)
    // Validated: a document asked under the same id that does
    // NOT hold the remembered birth gets its own, never the remembered one.
    const other = A.from<D>({ l: ['z'] } as unknown as D, { actor: '0f'.repeat(16) })
    const otherBirth = [A.decodeChange(A.getAllChanges(other)[0]!).hash]
    expect(birthHeadsOf(other as A.Doc<unknown>, 'doc-birth-1')).toEqual(otherBirth)
    expect(otherBirth).not.toEqual(birth)
  })

  it('the memo DECODES only what is new: a whole history once, then the changes since', () => {
    resetPutToElementCache()
    let doc = A.from<D>({ l: ['a', 'b'] } as unknown as D, { actor: '1a'.repeat(16) })
    for (let i = 0; i < 30; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[i % 2] = `v${i}` })
    const total = A.getAllChanges(doc).length
    putToElementMap(doc as A.Doc<unknown>)
    expect(putToElementStats.decoded).toBe(total)
    // The same state again, twice: nothing decoded.
    putToElementMap(doc as A.Doc<unknown>)
    putToElementMap(doc as A.Doc<unknown>)
    expect(putToElementStats.decoded).toBe(total)
    // Three more changes: three decoded, then nothing on the next calls.
    for (let i = 0; i < 3; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = `w${i}` })
    putToElementMap(doc as A.Doc<unknown>)
    expect(putToElementStats.decoded).toBe(total + 3)
    putToElementMap(doc as A.Doc<unknown>)
    expect(putToElementStats.decoded).toBe(total + 3)
  })

  it('a pass over 12 documents RE-PLANS them all without decoding again (a cache of 4 or 8 evicts its own plan)', () => {
    resetPutToElementCache()
    const docs = Array.from({ length: 12 }, (_, n) => {
      let doc = A.from<D>({ l: ['a', 'b'] } as unknown as D, { actor: (n + 16).toString(16).padStart(2, '0').repeat(16) })
      for (let i = 0; i < 5; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[i % 2] = `v${i}` })
      return doc as A.Doc<unknown>
    })
    for (const doc of docs) putToElementMap(doc) // plan
    const decoded = putToElementStats.decoded
    for (const doc of docs) putToElementMap(doc) // re-plan
    expect(putToElementStats.decoded).toBe(decoded)
  })

  it('at most TWO entries per document lineage — a source extended on every pass does not pile up copies', () => {
    resetPutToElementCache()
    let doc = A.from<D>({ l: ['a'] } as unknown as D, { actor: '2a'.repeat(16) })
    const sizes: number[] = []
    for (let i = 0; i < 10; i += 1) {
      doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = `v${i}` })
      sizes.push(putToElementMap(doc as A.Doc<unknown>).size)
    }
    putToElementMap(doc as A.Doc<unknown>)
    expect(putToElementCacheSize().documents).toBe(2)
    // The entry count follows the evictions — exactly the two
    // maps kept (the last state and the ancestor it was extended from).
    expect(putToElementCacheSize().entries).toBe(sizes[8]! + sizes[9]!)
  })

  it('a pass reading the source AT ITS CURSOR (an older view) and NOW decodes neither whole again', () => {
    resetPutToElementCache()
    let doc = A.from<D>({ l: ['a', 'b'] } as unknown as D, { actor: '2b'.repeat(16) })
    for (let i = 0; i < 20; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[i % 2] = `v${i}` })
    let cursor = A.getHeads(doc)
    putToElementMap(A.view(doc, cursor) as A.Doc<unknown>)
    putToElementMap(doc as A.Doc<unknown>)
    for (let pass = 0; pass < 5; pass += 1) {
      for (let i = 0; i < 3; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = `p${pass}-${i}` })
      const before = putToElementStats.decoded
      putToElementMap(A.view(doc, cursor) as A.Doc<unknown>) // the cursor of the previous pass
      putToElementMap(doc as A.Doc<unknown>) // now
      expect(putToElementStats.decoded - before).toBeLessThanOrEqual(3)
      cursor = A.getHeads(doc)
    }
  })

  it('the cache is bounded by its TOTAL entries, least recently used evicted first', () => {
    resetPutToElementCache()
    setPutToElementCacheMaxEntriesForTest(25)
    try {
      const docs = Array.from({ length: 6 }, (_, n) => {
        let doc = A.from<D>({ l: ['a'] } as unknown as D, { actor: (n + 48).toString(16).padStart(2, '0').repeat(16) })
        for (let i = 0; i < 8; i += 1) doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = `v${i}` })
        return doc as A.Doc<unknown>
      })
      for (const doc of docs) putToElementMap(doc)
      const size = putToElementCacheSize()
      expect(size.entries).toBeLessThanOrEqual(25)
      expect(size.documents).toBeLessThan(6)
      // The most recent is kept: asked again, nothing decoded.
      const decoded = putToElementStats.decoded
      putToElementMap(docs[5]!)
      expect(putToElementStats.decoded).toBe(decoded)
    } finally { setPutToElementCacheMaxEntriesForTest(null) }
  })

  it('a map handed out is never changed by a later extension', () => {
    resetPutToElementCache()
    let doc = A.from<D>({ l: ['a'] } as unknown as D, { actor: '1b'.repeat(16) })
    doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = 'b' })
    const before = putToElementMap(doc as A.Doc<unknown>)
    const size = before.size
    doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[0] = 'c' })
    const after = putToElementMap(doc as A.Doc<unknown>)
    expect(after.size).toBe(size + 1)
    expect(before.size).toBe(size)
  })

  it('the put → element map is MEMOIZED: extended from an ancestor, equal to a full decode, branches included', () => {
    resetPutToElementCache()
    const full = (doc: A.Doc<unknown>) => putToElementMap(doc, [])
    let doc = A.from<D>({ l: ['a', 'b', 'c'] } as unknown as D, { actor: '0c'.repeat(16) })
    const first = putToElementMap(doc as A.Doc<unknown>)
    expect([...first]).toEqual([...full(doc as A.Doc<unknown>)])
    // A typist: many puts on list elements, each a new change.
    let midHeads: A.Heads = []
    for (let i = 0; i < 40; i += 1) {
      doc = A.change(doc, (d) => { ((d as unknown as { l: string[] }).l)[i % 3] = `v${i}` })
      if (i === 9) midHeads = A.getHeads(doc)
      if (i === 19) putToElementMap(doc as A.Doc<unknown>) // a pass in between: the cache moves on
    }
    const grown = putToElementMap(doc as A.Doc<unknown>)
    const expected = full(doc as A.Doc<unknown>)
    for (const [k, v] of expected) expect(grown.get(k)).toBe(v)
    expect(grown.size).toBe(expected.size)
    // A sibling branch from an OLDER point, by another actor (it lacks the
    // cached heads): its map is complete for every op id it holds.
    let branch = A.clone(A.view(doc, midHeads) as A.Doc<D>, { actor: '0d'.repeat(16) })
    branch = A.change(branch, (d) => { ((d as unknown as { l: string[] }).l)[0] = 'other' })
    const branchMap = putToElementMap(branch as A.Doc<unknown>)
    for (const [k, v] of full(branch as A.Doc<unknown>)) expect(branchMap.get(k)).toBe(v)
  })

  it('text cursors are the characters\' op ids (one format for both identities)', () => {
    let doc = A.from<D>({ t: 'ab' }, { actor: '0b'.repeat(16) })
    const heads = A.getHeads(doc)
    doc = A.change(doc, (d) => { A.splice(d, ['t'], 1, 0, 'Z') })
    const change = A.decodeChange(A.getChangesSince(doc, heads)[0]!)
    const text = A.getObjectId(doc, 't')!
    expect(A.getBackend(doc).getCursor(text, 1)).toBe(`${change.startOp}@${change.actor}`)
  })
})

/**
 * Text outside the Basic Multilingual Plane:
 * Automerge indexes text in UTF-16 code units but stores one element per CODE
 * POINT. A late insert or delete of an astral character, a ZWJ sequence or a
 * combining mark must reach the current epoch whole, never as lone
 * surrogates.
 */
describe('O1, served elsewhere: an entity only an OLDER segment serves', () => {
  function world() {
    let old = A.from<D>({ objects: { e: { id: 'e', name: 'Base', tags: ['a'] } } }, { actor: '01'.repeat(16) })
    let late = A.clone(old, { actor: '03'.repeat(16) })
    const cut = A.getHeads(old)
    late = A.change(late, (d) => { objectsOf(d).e!.name = 'Marie' })
    old = A.merge(old, late)
    // The current epoch serves `e` from an older overlay segment; the head lacks it.
    const segment = A.from<D>({ objects: { e: { id: 'e', name: 'Base', type: 'from-segment', tags: ['a', 'seg'] } } })
    const head = A.from<D>({ objects: { other: { id: 'other' } } })
    const source: ForwardSource = { ...SHARD(old), from: cut, to: A.getHeads(old), cut, elemMap: new Map() }
    return { source, segment, head }
  }

  it('copies the served value into the head and merges the late write over it', () => {
    const { source, segment, head } = world()
    const { doc, plan } = forwardInto(source, {
      documentId: 'W', doc: head, birthHeads: null, receives: () => true, servedElsewhere: () => segment,
    }, 'jo1')
    expect(objectsOf(doc).e).toMatchObject({ name: 'Marie', type: 'from-segment' })
    expect([...(objectsOf(doc).e!.tags as string[])]).toEqual(['a', 'seg'])
    expect(plan.overrides).toEqual([])
  })

  it('control: without the served value the edit is reported as an entity deleted, never written', () => {
    const { source, head } = world()
    const { doc, plan } = forwardInto(source, { documentId: 'W', doc: head, birthHeads: null, receives: () => true }, 'jo2')
    expect(objectsOf(doc).e).toBeUndefined()
    expect(plan.overrides.map((o) => o.reason)).toEqual(['entity-deleted'])
  })

  it('a clash with the SERVED value: the current epoch (the segment) wins', () => {
    const { source, head } = world()
    const segment = A.from<D>({ objects: { e: { id: 'e', name: 'Paul', type: 'from-segment' } } })
    const { doc, plan } = forwardInto(source, {
      documentId: 'W', doc: head, birthHeads: null, receives: () => true, servedElsewhere: () => segment,
    }, 'jo3')
    expect(objectsOf(doc).e!.name).toBe('Paul')
    expect(plan.overrides.map((o) => [o.target.join('.'), o.reason])).toEqual([['objects.e.name', 'leaf']])
  })
})

describe('text by code point: emoji, ZWJ sequences, combining marks', () => {
  function forwardText(initial: string, late: (d: A.Doc<D>) => void, current?: (d: A.Doc<D>) => void): string {
    let old = A.from<D>({ objects: { t: { id: 't', name: initial } } }, { actor: '01'.repeat(16) })
    let writer = A.clone(old, { actor: '03'.repeat(16) })
    const cut = A.getHeads(old)
    let cur = buildEpochShard<D>(old, cut, '02'.repeat(16))
    const birth = A.getHeads(cur)
    writer = A.change(writer, late)
    if (current) cur = A.change(cur, current)
    old = A.merge(old, writer)
    const source: ForwardSource = { ...SHARD(old), from: cut, to: A.getHeads(old), cut, elemMap: new Map() }
    const { doc } = forwardInto(source, { documentId: 'T', doc: cur, birthHeads: birth, receives: () => true }, 'jt')
    return objectsOf(doc).t!.name as string
  }
  const name = ['objects', 't', 'name']

  it('an emoji inserted between two letters arrives whole', () => {
    expect(forwardText('ab', (d) => { A.splice(d, name, 1, 0, '😀') })).toBe('a😀b')
  })

  it('an emoji deleted from the middle leaves its neighbours', () => {
    expect(forwardText('a😀bc', (d) => { A.splice(d, name, 1, 2) })).toBe('abc')
  })

  it('an insert after an astral neighbour lands after BOTH of its code units', () => {
    expect(forwardText('a😀c', (d) => { A.splice(d, name, 3, 0, 'b') })).toBe('a😀bc')
  })

  it('a ZWJ family sequence and a combining mark arrive as written, with a concurrent current edit kept', () => {
    const family = '👩‍👩‍👧'
    expect(forwardText('x', (d) => { A.splice(d, name, 1, 0, `${family}é`) }, (d) => { A.splice(d, name, 0, 0, '🌍') }))
      .toBe(`🌍x${family}é`)
  })

  it('an emoji deleted late while the current epoch inserted another one before it', () => {
    expect(forwardText('a😀b', (d) => { A.splice(d, name, 1, 2) }, (d) => { A.splice(d, name, 0, 0, '🎉') })).toBe('🎉ab')
  })

  /** What Automerge itself gives for the same two edits on ONE document. */
  function automergeMerge<T>(initial: T, late: (d: A.Doc<D>) => void, current: (d: A.Doc<D>) => void, read: (d: A.Doc<D>) => unknown) {
    const doc = A.from<D>({ objects: { t: { id: 't', name: initial } } }, { actor: '01'.repeat(16) })
    const a = A.change(A.clone(doc, { actor: '03'.repeat(16) }), late)
    const b = A.change(A.clone(doc, { actor: '02'.repeat(16) }), current)
    return read(A.merge(a, b))
  }

  it('an insert whose left neighbour the current epoch DELETED anchors where it was, not at 0', () => {
    const late = (d: A.Doc<D>) => { A.splice(d, name, 1, 0, 'Z') } // `Z` after `a`
    const current = (d: A.Doc<D>) => { A.splice(d, name, 0, 1, '😀') } // `a` replaced by `😀`
    expect(forwardText('ab', late, current)).toBe('😀Zb')
    expect(automergeMerge('ab', late, current, (d) => objectsOf(d).t!.name)).toBe('😀Zb')
  })

  it('the same in a LIST — right before the next surviving element', () => {
    let old = A.from<D>({ objects: { t: { id: 't', tags: ['a', 'b'] } } }, { actor: '01'.repeat(16) })
    let writer = A.clone(old, { actor: '03'.repeat(16) })
    const cut = A.getHeads(old)
    let cur = buildEpochShard<D>(old, cut, '02'.repeat(16))
    const birth = A.getHeads(cur)
    const late = (d: A.Doc<D>) => { A.insertAt(objectsOf(d).t!.tags as unknown[], 1, 'Z') }
    const current = (d: A.Doc<D>) => { const tags = objectsOf(d).t!.tags as unknown[]; A.deleteAt(tags, 0); A.insertAt(tags, 0, 'X') }
    writer = A.change(writer, late)
    cur = A.change(cur, current)
    old = A.merge(old, writer)
    const source: ForwardSource = { ...SHARD(old), from: cut, to: A.getHeads(old), cut, elemMap: new Map() }
    const { doc } = forwardInto(source, { documentId: 'T', doc: cur, birthHeads: birth, receives: () => true }, 'jl')
    expect([...(objectsOf(doc).t!.tags as unknown[])]).toEqual(['X', 'Z', 'b'])
    const reference = automergeMerge(['a', 'b'], (d) => { A.insertAt((objectsOf(d).t as unknown as { name: unknown[] }).name, 1, 'Z') },
      (d) => { const l = (objectsOf(d).t as unknown as { name: unknown[] }).name; A.deleteAt(l, 0); A.insertAt(l, 0, 'X') },
      (d) => [...(objectsOf(d).t!.name as unknown[])])
    expect(reference).toEqual(['X', 'Z', 'b'])
  })
})

describe('planForwardTarget + applyTargetPlan (the probe-2 matrix)', () => {
  it('fixed actors: every check of the matrix', () => {
    const r = runMarie(fixedActors)
    expect(r.checks).toEqual(Object.fromEntries(Object.keys(r.checks).map((k) => [k, true])))
    expect(r.replayFound).toBe(true)
    expect(r.plan.log.conflicts).toBe(1) // o4.flag only
    expect(r.plan.log.increments).toBe(1)
    expect(r.plan.overrides.map((o) => [o.target.join('.'), o.reason]).sort()).toEqual([
      ['objects.o4.flag', 'leaf'], ['objects.o7', 'entity-deleted'],
    ])
    expect(r.f2plan.log.seqInserts).toBe(1)
  })

  it(`${SEEDS} random actor sets: every check of the matrix`, () => {
    for (let i = 0; i < SEEDS; i += 1) {
      const r = runMarie(randomActors())
      const failed = Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k)
      expect(failed).toEqual([])
    }
  })

  it('the residual: an UNSYNCED concurrent edit of the same key is decided by Automerge, not by the rule', () => {
    const owners = new Set<string>()
    for (let i = 0; i < SEEDS; i += 1) owners.add((runMarie(randomActors()).fin.o3!.meta as Entity).owner as string)
    // Whoever it is, it is one of the two writers: never lost to a third value.
    for (const owner of owners) expect(['marie', 'dana']).toContain(owner)
  })

  it('late changes exclude the server\'s own S8 write by hash, and the cursor advances over server-only changes', () => {
    const r = runMarie(fixedActors)
    expect(r.late.late).toHaveLength(1)
    expect(r.late.advanceTo).toBeNull()
    let meta = A.from<D>({ x: 1 }, { actor: fixedActors.server })
    const cut = A.getHeads(meta)
    meta = A.change(meta, (d) => { d.epochSuccessorRef = new A.ImmutableString('automerge:n') })
    const server = new Set(A.getChangesMetaSince(meta, cut).map((m) => m.hash))
    expect(lateChanges(meta, cut, server)).toEqual({ late: [], advanceTo: A.getHeads(meta) })
  })

  it('a non-aligned target (an overlay write head) takes sequences as leaves: current wins on a list both changed', () => {
    const s = marieScenario(fixedActors)
    // The head holds o0 written by another writer: not built from the source.
    const head = A.change(A.from<D>({ objects: {} }, { actor: '07'.repeat(16) }), (d) => {
      objectsOf(d).o0 = { ...entity(0), tags: ['a', 'B', 'c', 'head'] }
    })
    const source: ForwardSource = { ...SHARD(s.old), from: s.cut, to: A.getHeads(s.old), cut: s.cut, elemMap: new Map() }
    const plan = planForwardTarget(source, { documentId: 'W', doc: head, birthHeads: null, receives: (p) => p[1] === 'o0' })
    expect(plan.seq).toEqual([])
    expect(plan.overrides.map((o) => o.target.join('.'))).toEqual(['objects.o0.tags'])
  })

  it('a sequence the target REPLACED since birth falls back to the leaf rule (seqObjectReplaced)', () => {
    const s = marieScenario(fixedActors)
    const replaced = A.change(s.cur, (d) => { objectsOf(d).o0!.tags = ['a', 'B', 'c', 'carl', 'whole'] })
    const source: ForwardSource = { ...SHARD(s.old), from: s.cut, to: A.getHeads(s.old), cut: s.cut, elemMap: new Map() }
    const plan = planForwardTarget(source, { documentId: 'T', doc: replaced, birthHeads: s.birth, receives: (p) => p[1] === 'o0' })
    expect(plan.log.seqObjectReplaced).toBe(1)
    expect(plan.overrides).toEqual([expect.objectContaining({ reason: 'sequence-replaced' })])
  })
})

/**
 * Probe 3, as a test: ONE forward spanning TWO targets (a base shard T and
 * the write head W), a crash between them, and a replay rebuilt FROM STORAGE
 * ONLY (`A.save` bytes and the journal as JSON), with and without a head
 * rotation. The per-target messages are the primitives the forwarder service
 * drives; the journal here is a plain object.
 */
describe('multi-target idempotence from storage only', () => {
  type Storage = Map<string, Uint8Array>
  interface Journal { id: string; from: Heads; to: Heads; parts: Record<string, PlannedInsert[]> }
  type Heads = A.Heads

  function world(actors: Actors) {
    const storage: Storage = new Map()
    let S = A.from<D>({ objects: { A: entity('A'), B: entity('B') } }, { actor: actors.server })
    let marie = A.clone(S, { actor: actors.marie })
    const cut = A.getHeads(S)
    const T = buildEpochShard<D>(S, cut, actors.roller)
    const W = A.from<D>({ objects: {} }, { actor: hex() })
    const W1 = A.change(W, (d) => { objectsOf(d).B = { id: 'B', name: 'name B', hits: new A.Counter(5), tags: ['a', 'b', 'c'], meta: { owner: 'ann' } } })
    marie = A.change(marie, (d) => {
      const o = objectsOf(d)
      ;(o.A!.hits as A.Counter).increment(2); (o.A!.tags as unknown[]).push('marie')
      ;(o.B!.hits as A.Counter).increment(3); (o.B!.tags as unknown[]).push('marieB'); (o.B!.meta as Entity).owner = 'marie'
    })
    S = A.merge(S, marie)
    storage.set('S', A.save(S)); storage.set('T', A.save(T)); storage.set('W', A.save(W1))
    return { storage, cut, birthT: A.getHeads(T), sql: new Map<string, string>([['cursor', JSON.stringify(cut)], ['elemMap', '[]']]) }
  }
  type World = ReturnType<typeof world>
  const load = (w: World, k: string) => A.load<D>(w.storage.get(k)!)
  const targets = (w: World): Array<{ name: string; birth: Heads | null; receives: (p: readonly (string | number)[]) => boolean }> => [
    { name: 'T', birth: w.birthT, receives: (p) => p[1] === 'A' },
    { name: 'W', birth: null, receives: (p) => p[1] === 'B' },
  ]

  /** The service's journal loop, reduced to storage + rows. `crashAfter`: stop
   * after that many target writes. `searchIn`: the document a target's
   * message is looked for and written into (the RECORDED one by default). */
  function runForward(w: World, opts: { crashAfter?: number; order?: string[]; searchIn?: Record<string, string>; anyMessageThenCas?: boolean } = {}) {
    const S = load(w, 'S')
    const from = JSON.parse(w.sql.get('cursor')!) as Heads
    const to = A.getHeads(S)
    const elemMap = new Map<string, string>(JSON.parse(w.sql.get('elemMap')!))
    let journal = w.sql.has('journal') ? JSON.parse(w.sql.get('journal')!) as Journal : null
    const sourceFor = (j: Journal): ForwardSource => ({ ...SHARD(S), from: j.from, to: j.to, cut: w.cut, elemMap })
    if (!journal) {
      journal = { id: `j-${hex().slice(0, 8)}`, from, to, parts: {} }
      for (const t of targets(w)) {
        journal.parts[t.name] = planForwardTarget(sourceFor(journal), { documentId: t.name, doc: load(w, t.name), birthHeads: t.birth, receives: t.receives }).plannedInserts
      }
      w.sql.set('journal', JSON.stringify(journal)) // committed BEFORE any write
    }
    let written = 0
    for (const name of opts.order ?? ['T', 'W']) {
      const t = targets(w).find((x) => x.name === name)!
      const key = opts.searchIn?.[name] ?? name
      const message = forwardMessage(journal.id, name)
      let doc = load(w, key)
      if (opts.anyMessageThenCas && Object.keys(journal.parts).some((n) => findForwardChange(load(w, opts.searchIn?.[n] ?? n), forwardMessage(journal!.id, n)))) break
      if (findForwardChange(doc, message)) {
        for (const [k, v] of rebuildElemMap(doc, message, journal.parts[name]!) ?? []) elemMap.set(k, v)
        continue
      }
      const plan = planForwardTarget(sourceFor(journal), { documentId: name, doc, birthHeads: t.birth, receives: t.receives })
      journal.parts[name] = plan.plannedInserts
      w.sql.set('journal', JSON.stringify(journal))
      doc = A.change(doc, { message }, (draft) => { applyTargetPlan(draft, plan, S, journal!.to) })
      for (const [k, v] of rebuildElemMap(doc, message, plan.plannedInserts) ?? []) elemMap.set(k, v)
      w.storage.set(key, A.save(doc))
      written += 1
      if (written >= (opts.crashAfter ?? Infinity)) return 'crashed'
    }
    w.sql.set('cursor', JSON.stringify(journal.to)); w.sql.set('elemMap', JSON.stringify([...elemMap])); w.sql.delete('journal')
    return 'done'
  }
  /** The rotator: W retires at its current heads (H_r); W2 is seeded from it. */
  function rotate(w: World): Heads {
    const W = load(w, 'W')
    const W2 = A.from<D>({ objects: {} }, { actor: hex() })
    w.storage.set('W2', A.save(A.change(W2, (d) => { objectsOf(d).B = JSON.parse(JSON.stringify(objectsOf(W).B)) as Entity; (objectsOf(d).B!.hits as unknown) = new A.Counter((objectsOf(W).B!.hits as A.Counter).value) })))
    return A.getHeads(W)
  }
  /** The ordinary head forwarder, abstracted: what reached W after H_r reaches W2. */
  function carryRetiredHead(w: World, hr: Heads) {
    const W = load(w, 'W'); const before = objectsOf(A.view(W, hr) as A.Doc<D>).B!; const after = objectsOf(W).B!
    w.storage.set('W2', A.save(A.change(load(w, 'W2'), (d) => {
      const b = objectsOf(d).B!
      ;(b.hits as A.Counter).increment((after.hits as A.Counter).value - (before.hits as A.Counter).value)
      if (JSON.stringify(after.tags) !== JSON.stringify(before.tags)) b.tags = [...(after.tags as string[])]
      if ((after.meta as Entity).owner !== (before.meta as Entity).owner) (b.meta as Entity).owner = (after.meta as Entity).owner
    })))
  }
  const count = (list: unknown, v: string) => [...(list as string[])].filter((x) => x === v).length

  function cases(actors: Actors) {
    const out: Record<string, boolean> = {}
    {
      const w = world(actors)
      expect(runForward(w, { crashAfter: 1 })).toBe('crashed')
      out.journalSurvivesCursorHeld = w.sql.has('journal') && w.sql.get('cursor') === JSON.stringify(w.cut)
      runForward(w)
      runForward(w)
      let S = load(w, 'S'); let m2 = A.clone(S, { actor: actors.marie })
      m2 = A.change(m2, (d) => { const t = objectsOf(d).A!.tags as string[]; A.insertAt(t, t.indexOf('marie') + 1, 'marie2') })
      S = A.merge(S, m2); w.storage.set('S', A.save(S))
      runForward(w)
      const T = objectsOf(load(w, 'T')).A!, W = objectsOf(load(w, 'W')).B!
      out.T_once = (T.hits as A.Counter).value === 7 && count(T.tags, 'marie') === 1
      out.W_written = (W.hits as A.Counter).value === 8 && count(W.tags, 'marieB') === 1 && (W.meta as Entity).owner === 'marie'
      const tags = [...(T.tags as string[])]
      out.elemMapRebuiltFromStorage = tags.indexOf('marie2') === tags.indexOf('marie') + 1
    }
    {
      const w = world(actors)
      runForward(w, { crashAfter: 1, order: ['W', 'T'] })
      const hr = rotate(w)
      runForward(w, { order: ['W', 'T'] })
      carryRetiredHead(w, hr)
      const W2 = objectsOf(load(w, 'W2')).B!
      out.rotatedAfterHeadWrite_once = (W2.hits as A.Counter).value === 8 && count(W2.tags, 'marieB') === 1
    }
    {
      const w = world(actors)
      runForward(w, { crashAfter: 1, order: ['T', 'W'] })
      const hr = rotate(w)
      runForward(w, { order: ['T', 'W'] })
      carryRetiredHead(w, hr)
      out.rotatedBeforeHeadWrite_viaRetiredHead = (objectsOf(load(w, 'W2')).B!.hits as A.Counter).value === 8
    }
    return out
  }

  it('fixed and random actors: crash between targets, rotation, rebuild from storage', () => {
    for (const actors of [fixedActors, ...Array.from({ length: 10 }, randomActors)]) {
      const r = cases(actors)
      expect(Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k)).toEqual([])
    }
  })

  it('control: one message per forward instead of per target loses the unwritten target', () => {
    const w = world(fixedActors)
    runForward(w, { crashAfter: 1 })
    runForward(w, { anyMessageThenCas: true })
    expect((objectsOf(load(w, 'W')).B!.hits as A.Counter).value).toBe(5)
  })

  it('control: searching the CURRENT head after a rotation double-applies', () => {
    const w = world(fixedActors)
    runForward(w, { crashAfter: 1, order: ['W', 'T'] })
    const hr = rotate(w)
    runForward(w, { order: ['W', 'T'], searchIn: { W: 'W2' } })
    carryRetiredHead(w, hr)
    expect((objectsOf(load(w, 'W2')).B!.hits as A.Counter).value).toBe(11)
  })
})
