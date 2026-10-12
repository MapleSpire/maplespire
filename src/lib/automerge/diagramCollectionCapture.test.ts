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
import type { Comment, Flow } from '../../types'
import {
  PendingEntityIntents,
  planDiagramCollectionIntentReplay,
} from './entityIntents'
import {
  DiagramCollectionCapture,
  planDiagramCollectionAck,
} from './diagramCollectionCapture'

const WS = 'landscape/version'

function comment(id: string, diagramId: string, text: string): Comment {
  return {
    id, diagramId, type: 'question', text,
    position: { x: 10, y: 20 }, author: 'me', createdAt: '2026-08-14T00:00:00Z',
    resolved: false, pinned: false, replies: [],
  }
}

function flow(id: string, diagramId: string, name: string): Flow {
  return { id, diagramId, name, steps: [] }
}

describe('DiagramCollectionCapture — capture', () => {
  it('journals an added comment as a CREATION and an edited one with its durable baseline', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    const c1 = comment('c1', 'd1', 'first')
    capture.seed({ comment: [c1], flow: [] })

    const c1edited = { ...c1, text: 'edited' }
    const c2 = comment('c2', 'd1', 'brand new')
    const outcome = capture.diff({ comment: [c1edited, c2], flow: [] }, journal, WS)

    expect(outcome.recorded).toBe(true)
    expect(outcome.newIntentKey).toBe(true)
    const pending = journal.pending(WS)
    expect(pending).toHaveLength(2)
    const edited = pending.find((intent) => intent.id === 'c1')
    const created = pending.find((intent) => intent.id === 'c2')
    expect(edited && edited.op === 'upsert' ? edited.baseline : null).toEqual(c1)
    expect(created && created.op === 'upsert' ? created.baseline : undefined).toBeUndefined()
  })

  it('unseeded capture is a NO-OP (M1: no baseline, no delete diff, no whole-slice journal)', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    const outcome = capture.diff({ comment: [comment('c1', 'd1', 'x')], flow: [] }, journal, WS)
    expect(outcome.recorded).toBe(false)
    expect(journal.pendingCount(WS)).toBe(0)
  })

  it('a DELETE records the diagramId from the baseline value and persists immediately', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    const f1 = flow('f1', 'd7', 'checkout')
    capture.seed({ comment: [], flow: [f1] })

    const outcome = capture.diff({ comment: [], flow: [] }, journal, WS)

    expect(outcome.persistImmediately).toBe(true)
    const [intent] = journal.pending(WS)
    expect(intent.op).toBe('delete')
    expect(intent.kind).toBe('flow')
    expect(intent.op === 'delete' ? intent.diagramId : null).toBe('d7')
  })

  it('a diagram SWITCH reseed on the same tick means the swap never reads as deletes', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ comment: [comment('c1', 'd1', 'on d1')], flow: [] })
    // The projection replaces the slice with the NEW diagram's comments and
    // reseeds on the same synchronous tick — before any user tick can diff.
    const d2Comments = [comment('c9', 'd2', 'on d2')]
    capture.seed({ comment: d2Comments, flow: [] })

    const outcome = capture.diff({ comment: d2Comments, flow: [] }, journal, WS)

    expect(outcome.recorded).toBe(false)
    expect(journal.pendingCount(WS)).toBe(0)
  })

  it('partial seed touches only the given family — a pending flow edit keeps its baseline', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    const f1 = flow('f1', 'd1', 'original')
    capture.seed({ comment: [], flow: [f1] })
    capture.seed({ comment: [comment('cX', 'd1', 'projection tick')] })

    const outcome = capture.diff({ comment: [comment('cX', 'd1', 'projection tick')], flow: [] }, journal, WS)

    // The flow baseline survived the comment-only reseed: its disappearance
    // still diffs as a delete.
    expect(outcome.recorded).toBe(true)
    expect(journal.pending(WS).some((intent) => intent.kind === 'flow' && intent.op === 'delete')).toBe(true)
  })

  it('a pending CREATION stays a creation across a baseline reseed (never demoted to a field patch)', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ comment: [], flow: [] })
    const c1 = comment('c1', 'd1', 'created offline')
    capture.diff({ comment: [c1], flow: [] }, journal, WS)
    // A reseed adopts the not-yet-acknowledged comment into the baseline
    // (e.g. the flush-time reseed while the intent survived).
    capture.seed({ comment: [c1], flow: [] })
    const c1edited = { ...c1, text: 'edited before ack' }
    capture.diff({ comment: [c1edited], flow: [] }, journal, WS)

    const [intent] = journal.pending(WS)
    expect(intent.op).toBe('upsert')
    // Still baseline-less: the replay must RECREATE the whole comment, not
    // assert two fields of a comment that no longer exists anywhere.
    expect(intent.op === 'upsert' ? intent.baseline : null).toBeUndefined()
    expect(intent.op === 'upsert' ? (intent.snapshot as Comment).text : null).toBe('edited before ack')
  })

  it('create-then-delete inside the pre-ack window RETIRES the creation — no resurrection by replay', () => {
    // A pending creation is never in the baseline, so its disappearance records
    // no delete — without the retirement the intent would survive the full-set
    // flush and the replay would resurrect the entity the user just deleted.
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ comment: [], flow: [] })
    const c1 = comment('c1', 'd1', 'created then deleted')
    capture.diff({ comment: [c1], flow: [] }, journal, WS)
    expect(journal.pendingCreation(WS, 'comment', 'c1')).toBe(true)

    const outcome = capture.diff({ comment: [], flow: [] }, journal, WS)

    expect(outcome.persistImmediately).toBe(true)
    // Retired outright: nothing was durable, so there is nothing to delete
    // AND nothing the replay could resurrect.
    expect(journal.pendingCount(WS)).toBe(0)
  })

  it('a reseed swap does NOT retire a pending creation — only a user-tick disappearance does', () => {
    // The crash-recovery case: the entity vanished from the slice because a
    // projection swapped it (seed clears the captured memo), not because the
    // user deleted it — the creation intent must survive for the replay.
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    capture.seed({ comment: [], flow: [] })
    capture.diff({ comment: [comment('c1', 'd1', 'crash payload')], flow: [] }, journal, WS)
    // Remote swap to another diagram's window: reseed on the same tick.
    // Shared ref — a recreated literal would read as an EDIT under the
    // ref-diff (the round-8 fixture trap).
    const otherWindow = comment('c9', 'd2', 'other window')
    capture.seed({ comment: [otherWindow], flow: [] })

    capture.diff({ comment: [otherWindow], flow: [] }, journal, WS)

    expect(journal.pendingCreation(WS, 'comment', 'c1')).toBe(true)
    expect(journal.pendingCount(WS)).toBe(1)
  })

  it('op flip (delete → re-add) persists immediately', () => {
    const capture = new DiagramCollectionCapture()
    const journal = new PendingEntityIntents()
    const c1 = comment('c1', 'd1', 'x')
    capture.seed({ comment: [c1], flow: [] })
    capture.diff({ comment: [], flow: [] }, journal, WS)
    expect(journal.pendingOp(WS, 'comment', 'c1')).toBe('delete')

    capture.seed({ comment: [], flow: [] })
    const outcome = capture.diff({ comment: [{ ...c1 }], flow: [] }, journal, WS)

    expect(outcome.persistImmediately).toBe(true)
    expect(journal.pendingOp(WS, 'comment', 'c1')).toBe('upsert')
  })
})

describe('planDiagramCollectionAck — the flush-side value check', () => {
  it('acks an expressed upsert via the MERGE predicate, keeps a clobbered one as survivor', () => {
    const journal = new PendingEntityIntents()
    const base = comment('c1', 'd1', 'old')
    const mine = { ...base, text: 'mine' }
    journal.recordUpsert(WS, 'comment', 'c1', mine, base)
    const clobbered = comment('c2', 'd1', 'never written')
    journal.recordUpsert(WS, 'comment', 'c2', clobbered)
    const revision = journal.revisionNow

    // The doc as written: c1 carries my text PLUS a colleague field change
    // (raw equality would never hold — the livelock the merge predicate
    // kills); c2 was erased by a projection before the flush read the store.
    const written = new Map<string, unknown>([
      ['c1', { ...mine, pinned: true }],
    ])
    const plan = planDiagramCollectionAck(
      journal.pending(WS), { comment: written, flow: new Map() }, 'd1', revision,
    )

    expect(plan.ackByKind.comment).toEqual(['c1'])
    expect(plan.survivors).toBe(true)
  })

  it('a delete is expressed by ABSENCE from the written map', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'flow', 'f1', { diagramId: 'd1' })
    const revision = journal.revisionNow

    const plan = planDiagramCollectionAck(
      journal.pending(WS), { comment: new Map(), flow: new Map() }, 'd1', revision,
    )

    expect(plan.ackByKind.flow).toEqual(['f1'])
    expect(plan.survivors).toBe(false)
  })

  it('intents of ANOTHER diagram are neither acked nor survivors — this flush never covered them', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'flow', 'f9', flow('f9', 'd-import', 'imported'))
    const revision = journal.revisionNow

    const plan = planDiagramCollectionAck(
      journal.pending(WS), { comment: new Map(), flow: new Map() }, 'd1', revision,
    )

    expect(plan.ackByKind.flow).toEqual([])
    expect(plan.survivors).toBe(false)
    expect(journal.pendingCount(WS)).toBe(1)
  })

  it('never acks an intent recorded AFTER the flush began (revision scoping)', () => {
    const journal = new PendingEntityIntents()
    const c1 = comment('c1', 'd1', 'v1')
    journal.recordUpsert(WS, 'comment', 'c1', c1)
    const revision = journal.revisionNow
    const newer = { ...c1, text: 'v2 recorded mid-flush' }
    journal.recordUpsert(WS, 'comment', 'c1', newer)

    // The written doc ALREADY EXPRESSES the newer value (a same-tick write
    // raced in) — so the merge predicate alone would say "ack": only the
    // revision filter refuses here. (A stale written value would let the value
    // check mask a broken revision filter.)
    const plan = planDiagramCollectionAck(
      journal.pending(WS), { comment: new Map([['c1', newer]]), flow: new Map() }, 'd1', revision,
    )

    expect(plan.ackByKind.comment).toEqual([])
    // Skipped, not a survivor: the NEXT flush covers it — the replay must
    // not be scheduled for an intent no clobber touched.
    expect(plan.survivors).toBe(false)
  })
})

describe('planDiagramCollectionIntentReplay', () => {
  it('replays only the ACTIVE diagram; the rest counts as remaining', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'comment', 'c1', comment('c1', 'd1', 'mine'))
    journal.recordUpsert(WS, 'flow', 'f1', flow('f1', 'd2', 'elsewhere'))
    journal.recordDelete(WS, 'comment', 'c9', { diagramId: 'd2' })

    const plan = planDiagramCollectionIntentReplay({
      intents: journal.pending(WS),
      activeDiagramId: 'd1',
      current: { comment: new Map(), flow: new Map() },
    })

    expect(plan.replayUpserts.comment).toHaveLength(1)
    expect(plan.remaining).toBe(2)
    expect(plan.replayDeletes.comment).toEqual([])
  })

  it('satisfaction is the MERGE predicate: a value a previous replay merged acks instead of livelocking', () => {
    const journal = new PendingEntityIntents()
    const base = comment('c1', 'd1', 'old')
    const mine = { ...base, text: 'mine' }
    journal.recordUpsert(WS, 'comment', 'c1', mine, base)

    const durable = { ...mine, resolved: true } // colleague field merged in
    const plan = planDiagramCollectionIntentReplay({
      intents: journal.pending(WS),
      activeDiagramId: 'd1',
      current: { comment: new Map([['c1', durable as unknown as Record<string, unknown>]]), flow: new Map() },
    })

    expect(plan.satisfied).toHaveLength(1)
    expect(plan.replayUpserts.comment).toHaveLength(0)
  })

  it('a delete replays even against an absent target (carrier-resident absence rule), and an upsert merges per-field', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'flow', 'fGone', { diagramId: 'd1' })
    const base = flow('f1', 'd1', 'old-name')
    const mine = { ...base, name: 'renamed' }
    journal.recordUpsert(WS, 'flow', 'f1', mine, base)

    const colleague = { ...base, domainId: 'dom-9' }
    const plan = planDiagramCollectionIntentReplay({
      intents: journal.pending(WS),
      activeDiagramId: 'd1',
      current: { comment: new Map(), flow: new Map([['f1', colleague as unknown as Record<string, unknown>]]) },
    })

    expect(plan.replayDeletes.flow).toEqual(['fGone'])
    const [merged] = plan.replayUpserts.flow
    expect(merged.name).toBe('renamed')
    expect(merged.domainId).toBe('dom-9')
  })

  it('an unknown kind never reaches the diagram-collection planner (closed world)', () => {
    const plan = planDiagramCollectionIntentReplay({
      intents: [{
        workspaceKey: WS, revision: 1, recordedAt: 1, id: 'x1',
        kind: 'hologram' as never, op: 'upsert', snapshot: { id: 'x1' } as never,
      }],
      activeDiagramId: 'd1',
      current: { comment: new Map(), flow: new Map() },
    })
    expect(plan.replayUpserts.comment).toHaveLength(0)
    expect(plan.replayUpserts.flow).toHaveLength(0)
    expect(plan.satisfied).toHaveLength(0)
    expect(plan.remaining).toBe(0)
  })
})
