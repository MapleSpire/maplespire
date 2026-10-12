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
import type { DecisionRecord, Domain, Group, Tag } from '../../types'
import { PendingEntityIntents } from './entityIntents'
import {
  SmallCollectionCapture,
  planSmallCollectionAck,
  type SmallCollectionSlices,
} from './smallCollectionCapture'

const WS = 'landscape-1::version-1'

function group(id: string, name: string, extra: Record<string, unknown> = {}): Group {
  return { id, name, objectIds: [], ...extra } as unknown as Group
}

function adr(id: string, title: string): DecisionRecord {
  return {
    id, number: 1, title, summary: '', status: 'proposed', author: '',
    content: '', createdAt: 't0', updatedAt: 't0',
  } as unknown as DecisionRecord
}

function tagSnap(tagId: string, label: string): Tag {
  return { tagId, label } as unknown as Tag
}

function slices(partial: Partial<SmallCollectionSlices> = {}): SmallCollectionSlices {
  return { group: [], domain: [], tagSnapshot: [], decisionRecord: [], ...partial }
}

// Unit tier for the capture layer, which bridge-touching tests cannot see
// (every one of them mocks bridge.ts).
describe('SmallCollectionCapture — seed/diff', () => {
  it('captures an edit with the seeded value as its baseline, once per ref', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    const base = group('g1', 'before')
    capture.seed({ group: [base] })
    const edited = group('g1', 'after')
    const first = capture.diff(slices({ group: [edited] }), journal, WS)
    expect(first.recorded).toBe(true)
    expect(first.newIntentKey).toBe(true)
    const [intent] = journal.pending(WS)
    expect(intent.kind).toBe('group')
    expect(intent.op).toBe('upsert')
    if (intent.op !== 'upsert') throw new Error('unreachable')
    expect((intent.baseline as Group | undefined)?.name).toBe('before')
    // Same ref again: no re-record (the captured map holds it).
    const second = capture.diff(slices({ group: [edited] }), journal, WS)
    expect(second.recorded).toBe(false)
  })

  it('captures a DELETE as a baseline id missing from the slice', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    const untouchedDomain = { id: 'd1', name: 'D' } as Domain // shared ref: unchanged ⟹ not an edit
    capture.seed({ group: [group('g1', 'doomed')], domain: [untouchedDomain] })
    const outcome = capture.diff(slices({ domain: [untouchedDomain] }), journal, WS)
    expect(outcome.persistImmediately).toBe(true)
    const pending = journal.pending(WS)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'group', id: 'g1', op: 'delete' })
    // And not again on the next tick — the baseline entry was consumed.
    const again = capture.diff(slices({ domain: [untouchedDomain] }), journal, WS)
    expect(again.recorded).toBe(false)
  })

  it('create-then-delete inside the pre-ack window RETIRES the creation — no group resurrection', () => {
    // Same hole as the diagram-scoped captures: a pending creation was never
    // in the baseline, so its user-tick disappearance records no delete and
    // the replay would resurrect it.
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed(slices())
    capture.diff(slices({ group: [group('g1', 'created then deleted')] }), journal, WS)
    expect(journal.pendingCreation(WS, 'group', 'g1')).toBe(true)

    const outcome = capture.diff(slices(), journal, WS)

    expect(outcome.persistImmediately).toBe(true)
    expect(journal.pendingCount(WS)).toBe(0)
  })

  it('an ADR page swap reseeded on its own tick can never read as a burst of deletes', () => {
    // The data-loss shape this guards: without the reseed, page 1's ids linger in the baseline, page 2's slice
    // lacks them, and the diff journals a recordDelete per old-page ADR — a
    // phantom-delete burst the replay then executes as REAL ModelMeta
    // deletions. The contract: the site that swaps the slice reseeds the
    // family on the same synchronous tick, BEFORE any user tick can diff.
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    const page1 = [adr('a1', 'One'), adr('a2', 'Two')]
    capture.seed({ decisionRecord: page1 })
    const page2 = [adr('b1', 'Three'), adr('b2', 'Four')]
    capture.seed({ decisionRecord: page2 })
    const outcome = capture.diff(slices({ decisionRecord: page2 }), journal, WS)
    expect(outcome.recorded).toBe(false)
    expect(journal.pending(WS)).toHaveLength(0)
  })

  it('seeding one family leaves the others UNTOUCHED (a group replay must not adopt a pending domain edit)', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    const replayedGroup = group('g1', 'v1')
    capture.seed({ group: [group('g1', 'v0')], domain: [{ id: 'd1', name: 'old' } as Domain] })
    // A group-only reseed (the replay's injection shape).
    capture.seed({ group: [replayedGroup] })
    // The pending DOMAIN edit still diffs against its ORIGINAL baseline; the
    // reseeded group ref is in-baseline and records nothing.
    const outcome = capture.diff(
      slices({ group: [replayedGroup], domain: [{ id: 'd1', name: 'edited' } as Domain] }),
      journal, WS,
    )
    expect(outcome.recorded).toBe(true)
    const [intent] = journal.pending(WS)
    expect(intent).toMatchObject({ kind: 'domain', id: 'd1', op: 'upsert' })
    if (intent.op !== 'upsert') throw new Error('unreachable')
    expect((intent.baseline as Domain | undefined)?.name).toBe('old')
  })

  it('records NOTHING before the first seed — journaling a whole projected collection as created would clobber colleagues on replay', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    const outcome = capture.diff(slices({ group: [group('g1', 'projected')] }), journal, WS)
    expect(outcome.recorded).toBe(false)
    expect(journal.pending(WS)).toHaveLength(0)
  })

  it('an op flip (upsert over a pending delete) demands immediate persistence', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ group: [group('g1', 'v0')] })
    capture.diff(slices(), journal, WS) // delete captured
    expect(journal.pendingOp(WS, 'group', 'g1')).toBe('delete')
    const restored = capture.diff(slices({ group: [group('g1', 'restored')] }), journal, WS)
    expect(restored.persistImmediately).toBe(true)
    expect(journal.pendingOp(WS, 'group', 'g1')).toBe('upsert')
  })

  it('keys tagSnapshots by canonical tagId', () => {
    const capture = new SmallCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ tagSnapshot: [tagSnap('tag-a', 'A')] })
    capture.diff(slices({ tagSnapshot: [tagSnap('tag-a', 'A renamed')] }), journal, WS)
    expect(journal.pending(WS)[0]).toMatchObject({ kind: 'tagSnapshot', id: 'tag-a' })
  })
})

describe('planSmallCollectionAck — the value-checked flush acknowledgement', () => {
  const writtenFrom = (partial: Partial<SmallCollectionSlices>) => ({
    group: new Map((partial.group ?? []).map((g) => [g.id, g as unknown])),
    domain: new Map((partial.domain ?? []).map((d) => [d.id, d as unknown])),
    tagSnapshot: new Map((partial.tagSnapshot ?? []).map((t) => [t.tagId, t as unknown])),
    decisionRecord: new Map((partial.decisionRecord ?? []).map((r) => [r.id, r as unknown])),
  })

  it('acks an expressed upsert, refuses a clobbered one (the round\'s headline property)', () => {
    // A BLANKET ack would be wrong: a projection
    // clobbers the store between capture and flush, the full-set flush writes
    // the OLD value, and the blanket ack forgets the intent whose newer value
    // was never written anywhere.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'mine'), group('g1', 'base'))
    const revision = journal.revisionNow
    const clobbered = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({ group: [group('g1', 'base')] }), revision, null,
    )
    expect(clobbered.ackByKind.group).toHaveLength(0)
    expect(clobbered.survivors).toBe(true)
    const expressed = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({ group: [group('g1', 'mine')] }), revision, null,
    )
    expect(expressed.ackByKind.group).toEqual(['g1'])
    expect(expressed.survivors).toBe(false)
  })

  it('acks through the MERGE predicate: a written value that already carries every changed field is expressed', () => {
    // The livelock killer: after a replay three-way-merged colleague fields
    // in, the written value never raw-equals the snapshot — raw equality
    // would keep the intent surviving, the survivor would re-schedule the
    // replay, and the loop would never drain.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(
      WS, 'group', 'g1',
      group('g1', 'mine', { color: 'blue' }),
      group('g1', 'base', { color: 'blue' }),
    )
    const merged = group('g1', 'mine', { color: 'red' }) // rename mine + colleague recolor
    const plan = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({ group: [merged] }), journal.revisionNow, null,
    )
    expect(plan.ackByKind.group).toEqual(['g1'])
  })

  it('full-set family deletes ack on absence from the written slice', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'group', 'g1')
    const plan = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({}), journal.revisionNow, null,
    )
    expect(plan.ackByKind.group).toEqual(['g1'])
  })

  it('ADR deletes take the CARRIER witness, never the store: absent-from-store is not expressed on a paged meta', () => {
    // On a delta/paged workspace the flush only tombstones
    // ids present in the page baseline, so a record opened OUTSIDE the page
    // is deleted in the store, intact in the meta — a store-witnessed ack
    // throws away the delete the replay could still save.
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'decisionRecord', 'adr1')
    const revision = journal.revisionNow
    const notExpressed = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({}), revision, () => false,
    )
    expect(notExpressed.ackByKind.decisionRecord).toHaveLength(0)
    expect(notExpressed.survivors).toBe(true)
    const expressed = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({}), revision, (id) => id === 'adr1',
    )
    expect(expressed.ackByKind.decisionRecord).toEqual(['adr1'])
    // No witness at all (meta unreadable) fails CLOSED.
    const noWitness = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({}), revision, null,
    )
    expect(noWitness.ackByKind.decisionRecord).toHaveLength(0)
  })

  it('never acks past the captured revision — an edit landing mid-flush survives', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'v1'))
    const revision = journal.revisionNow
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'v2'))
    const plan = planSmallCollectionAck(
      journal.pending(WS), writtenFrom({ group: [group('g1', 'v2')] }), revision, null,
    )
    expect(plan.ackByKind.group).toHaveLength(0)
  })
})
