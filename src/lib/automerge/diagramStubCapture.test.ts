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
import type { Diagram } from '../../types'
import { PendingEntityIntents } from './entityIntents'
import {
  DiagramStubCapture,
  diagramStubOf,
  planDiagramStubAck,
  planDiagramStubReplay,
} from './diagramStubCapture'

const WS = 'landscape/version'

function diagram(id: string, name: string, extra: Partial<Diagram> = {}): Diagram {
  return {
    id, name, type: 'container',
    objectIds: [], connectionIds: [], groupIds: [],
    ...extra,
  }
}

const journalAll = () => true

describe('DiagramStubCapture — capture', () => {
  it('a created diagram journals its FULL snapshot; composition churn on an established one records nothing', () => {
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    const d1 = diagram('d1', 'Landscape', { objectIds: ['o1'] })
    capture.seed([d1])

    const d1MoreObjects = { ...d1, objectIds: ['o1', 'o2'], layouts: { o2: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } } }
    const dNew = diagram('dNew', 'Fresh', { objectIds: ['seed'], groupIds: ['g1'] })
    const outcome = capture.diff([d1MoreObjects, dNew], journal, WS, journalAll)

    expect(outcome.recorded).toBe(true)
    const pending = journal.pending(WS)
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('dNew')
    expect(pending[0].op === 'upsert' ? (pending[0].snapshot as Diagram).objectIds : null).toEqual(['seed'])
    expect(pending[0].op === 'upsert' ? pending[0].baseline : null).toBeUndefined()
  })

  it('a RENAME journals with the durable baseline; the snapshot is the full value but only stub fields differ', () => {
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    const d1 = diagram('d1', 'Old name')
    capture.seed([d1])

    const renamed = { ...d1, name: 'New name' }
    capture.diff([renamed], journal, WS, journalAll)

    const [intent] = journal.pending(WS)
    expect(intent.op === 'upsert' ? (intent.baseline as Diagram).name : null).toBe('Old name')
    expect(intent.op === 'upsert' ? (intent.snapshot as Diagram).name : null).toBe('New name')
  })

  it('a pending CREATION refreshes its full snapshot on every ref change and STAYS a creation across reseeds', () => {
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    capture.seed([])
    const dNew = diagram('dNew', 'Fresh')
    capture.diff([dNew], journal, WS, journalAll)
    // A projection reseeds the baseline WITH the held (not yet durable)
    // diagram — the creation must not demote to a rename patch.
    capture.seed([dNew])
    const withContent = { ...dNew, objectIds: ['o1'], name: 'Fresh (renamed)' }
    capture.diff([withContent], journal, WS, journalAll)

    const [intent] = journal.pending(WS)
    expect(intent.op === 'upsert' ? intent.baseline : null).toBeUndefined()
    expect(intent.op === 'upsert' ? (intent.snapshot as Diagram).objectIds : null).toEqual(['o1'])
    expect(intent.op === 'upsert' ? (intent.snapshot as Diagram).name : null).toBe('Fresh (renamed)')
  })

  it('a DELETE journals immediately; refused ids (summary-owned) record NOTHING in either direction', () => {
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    const mine = diagram('mine', 'Deletable')
    const serverOwned = diagram('server-owned', 'Not ours to delete')
    capture.seed([mine, serverOwned])

    const outcome = capture.diff([], journal, WS, (id) => id === 'mine')

    expect(outcome.persistImmediately).toBe(true)
    const pending = journal.pending(WS)
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('mine')
    expect(pending[0].op).toBe('delete')
  })

  it('create-then-delete inside the pre-ack window RETIRES the creation — no diagram resurrection', () => {
    // The pending creation is never in the baseline, so without retirement it
    // would survive the deletion tick and the survivor→replay path would
    // re-inject the deleted diagram and re-place its meta — a PERMANENT
    // resurrection.
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    capture.seed([])
    const dNew = diagram('dNew', 'Created then deleted')
    capture.diff([dNew], journal, WS, journalAll)
    expect(journal.pendingCreation(WS, 'diagram', 'dNew')).toBe(true)

    const outcome = capture.diff([], journal, WS, journalAll)

    expect(outcome.persistImmediately).toBe(true)
    expect(journal.pendingCount(WS)).toBe(0)
  })

  it('a projection reseed on the same tick means a registry catch-up never reads as user deletes', () => {
    const capture = new DiagramStubCapture()
    const journal = new PendingEntityIntents()
    capture.seed([diagram('d1', 'A'), diagram('d2', 'B')])
    // The registry catch-up drops d2 from the slice AND reseeds on the same
    // synchronous tick.
    const after = [diagram('d1', 'A')]
    capture.seed(after)

    const outcome = capture.diff(after, journal, WS, journalAll)

    expect(outcome.recorded).toBe(false)
    expect(journal.pendingCount(WS)).toBe(0)
  })
})

describe('planDiagramStubReplay', () => {
  const metaStub = (name: string) => ({ name, type: 'container' })

  it('recreates a creation whose meta never landed, patches a present rename, satisfies an expressed one', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dNew', diagram('dNew', 'Fresh', { objectIds: ['seed'] }))
    journal.recordUpsert(WS, 'diagram', 'dRen', diagram('dRen', 'Renamed'), diagram('dRen', 'Old'))
    journal.recordUpsert(WS, 'diagram', 'dOk', diagram('dOk', 'Already there'), diagram('dOk', 'Was'))

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map([
        ['dRen', metaStub('Old')],
        ['dOk', metaStub('Already there')],
      ]),
      metasComplete: true,
    })

    expect(plan.replayCreates.map((d) => d.id)).toEqual(['dNew'])
    expect(plan.replayCreates[0].objectIds).toEqual(['seed'])
    expect(plan.replayStubPatches).toEqual([{ id: 'dRen', fields: { name: 'Renamed', type: 'container' } }])
    expect(plan.satisfied.map((s) => s.id)).toEqual(['dOk'])
  })

  it('a rename of a diagram the COMPLETE registry no longer holds is satisfied; under a WINDOW it is retained', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dGone', diagram('dGone', 'Renamed'), diagram('dGone', 'Old'))
    const intents = journal.pending(WS)

    const complete = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: true })
    const windowed = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: false })

    expect(complete.satisfied).toHaveLength(1)
    expect(complete.remaining).toBe(0)
    expect(windowed.satisfied).toHaveLength(0)
    expect(windowed.remaining).toBe(1)
  })

  it('a delete replays when the meta is present, satisfies on proven absence, is retained under a window', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dDel')
    const intents = journal.pending(WS)

    const present = planDiagramStubReplay({
      intents, currentMetaStubs: new Map([['dDel', metaStub('X')]]), metasComplete: true,
    })
    const absentComplete = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: true })
    const absentWindow = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: false })

    expect(present.replayDeletes).toEqual(['dDel'])
    expect(absentComplete.satisfied).toHaveLength(1)
    expect(absentWindow.remaining).toBe(1)
  })

  it('the stub patch merges per-field: a colleague rename to a field I never touched survives', () => {
    const journal = new PendingEntityIntents()
    // The local user changed the parent only; a colleague renamed meanwhile.
    journal.recordUpsert(
      WS, 'diagram', 'd1',
      diagram('d1', 'Original', { parentObjectId: 'newParent' }),
      diagram('d1', 'Original', { parentObjectId: 'oldParent' }),
    )

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map([['d1', { name: 'Colleague rename', type: 'container', parentObjectId: 'oldParent' }]]),
      metasComplete: true,
    })

    expect(plan.replayStubPatches).toEqual([{
      id: 'd1',
      fields: { name: 'Colleague rename', type: 'container', parentObjectId: 'newParent' },
    }])
  })
})

describe('planDiagramStubReplay — les tombstones de diagramme (T6)', () => {
  it('rejoue une suppression summary faite hors-ligne en RE-EXPRIMANT le tombstone', () => {
    // An absent target must not be classed as `remaining` when a tombstone can
    // be expressed. Under a summary registry `metasComplete` is
    // permanently false, so the intent would be parked at EVERY boot for ever
    // and the badge with it — the user's offline deletion silently never
    // happening while the app insists it is still saving.
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dOffline')

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map(),
      metasComplete: false,
      tombstonedIds: new Set(),
      canTombstone: true,
    })

    expect(plan.replayTombstones).toEqual(['dOffline'])
    expect(plan.remaining).toBe(0)
    expect(plan.satisfied).toEqual([])
  })

  it('sans chemin de tombstone, l\'absence reste improuvable et l\'intention est retenue', () => {
    // The control, and the guard against the opposite error: a session that
    // CANNOT express a tombstone (classic mode with unresolved shards) must
    // keep the honest `remaining` — retiring a delete it cannot express would
    // un-express a user deletion.
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dOffline')

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map(),
      metasComplete: false,
      canTombstone: false,
    })

    expect(plan.replayTombstones).toEqual([])
    expect(plan.remaining).toBe(1)
  })

  it('une suppression déjà tombstonée est satisfaite, pas rejouée', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dGone')

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map(),
      metasComplete: false,
      tombstonedIds: new Set(['dGone']),
      canTombstone: true,
    })

    expect(plan.satisfied.map((entry) => entry.id)).toEqual(['dGone'])
    expect(plan.replayTombstones).toEqual([])
  })

  it('un renommage local perd contre un tombstone distant', () => {
    // Delete-wins. If the replayed stub patch re-placed the meta, the registry
    // entry would come back, the server re-projects it, and the diagram
    // a colleague deleted is resurrected PERMANENTLY — with the local user's
    // new name on it, so nobody connects the two events.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dRen', diagram('dRen', 'My new name'), diagram('dRen', 'Old'))

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map([['dRen', { name: 'Old', type: 'container' }]]),
      metasComplete: false,
      tombstonedIds: new Set(['dRen']),
      canTombstone: true,
    })

    expect(plan.replayStubPatches).toEqual([])
    expect(plan.satisfied.map((entry) => entry.id)).toEqual(['dRen'])
  })

  it('une CRÉATION journalisée LÈVE le tombstone au lieu d\'être avalée par lui', () => {
    // The delete-wins branch is written for a RENAME; it must not swallow a
    // journaled CREATION (an upsert with no baseline). Marking that intent
    // `satisfied` would drop it while the diagram stays hidden behind the
    // tombstone filter and the badge goes green — a re-creation lost with no
    // trace.
    //
    // Replaying the create ALONE is not the answer either: the re-placed meta
    // is filtered out by `summaryRegistryMetas()` and re-deleted by the server
    // projector — an invisible diagram plus a write loop. Only a LIFT expresses
    // a re-creation honestly, which is what the live user-tick path already
    // does in `detectEdits` (`unTombDiagrams`). So the plan carries
    // both: the lift IS the expression, the create rides on it.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dBack', diagram('dBack', 'Re-imported'), undefined)
    expect(journal.pendingCreation(WS, 'diagram', 'dBack')).toBe(true)

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map(),
      metasComplete: false,
      tombstonedIds: new Set(['dBack']),
      canTombstone: true,
    })

    expect(plan.replayLifts).toEqual(['dBack'])
    expect(plan.replayCreates.map((entry) => entry.id)).toEqual(['dBack'])
    // …and above all NOT satisfied: acknowledging it would lose the diagram.
    expect(plan.satisfied).toEqual([])
  })

  it('seule une CRÉATION lève un tombstone — un renommage et une suppression ne le touchent pas', () => {
    // The guard on the exemption's WIDTH, and it is the whole safety of it. A
    // journaled EDIT (baseline present) of a tombstoned id is a stale patch of
    // something that got deleted; a journaled DELETE of one is already
    // expressed. Neither may reach `replayLifts`, or a colleague's deletion
    // would be spliced out of ModelMeta by any pending intent that happens to
    // name the same id — the permanent resurrection delete-wins refuses.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dRen', diagram('dRen', 'New'), diagram('dRen', 'Old'))
    journal.recordDelete(WS, 'diagram', 'dDel')

    const plan = planDiagramStubReplay({
      intents: journal.pending(WS),
      currentMetaStubs: new Map([['dRen', { name: 'Old', type: 'container' }]]),
      metasComplete: false,
      tombstonedIds: new Set(['dRen', 'dDel']),
      canTombstone: true,
    })

    expect(plan.replayLifts).toEqual([])
    expect(plan.replayCreates).toEqual([])
    expect(plan.satisfied.map((entry) => entry.id).sort()).toEqual(['dDel', 'dRen'])
  })
})

describe('planDiagramStubAck', () => {
  it('acks an expressed rename and a proven-absent delete; keeps the doc-gated creation as survivor', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dRen', diagram('dRen', 'Renamed'), diagram('dRen', 'Old'))
    journal.recordDelete(WS, 'diagram', 'dDel')
    journal.recordUpsert(WS, 'diagram', 'dGated', diagram('dGated', 'Held back'))
    const revision = journal.revisionNow

    const plan = planDiagramStubAck(
      journal.pending(WS),
      new Map([['dRen', { name: 'Renamed', type: 'container' }]]),
      true,
      revision,
    )

    expect(plan.ackIds.sort()).toEqual(['dDel', 'dRen'])
    expect(plan.survivors).toBe(true)
  })

  it('under a summary WINDOW absence never acks a delete', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dDel')
    const plan = planDiagramStubAck(journal.pending(WS), new Map(), false, journal.revisionNow)
    expect(plan.ackIds).toEqual([])
    expect(plan.survivors).toBe(true)
  })

  it('acquitte une suppression summary contre le tombstone, jamais contre l\'absence', () => {
    // `expressed = meta === undefined && metasComplete` alone is not enough:
    // `metasComplete` is `allShardsLoaded && !registrySummaryOnly` — i.e.
    // PERMANENTLY false under a summary registry — so the ack could never fire
    // and the badge would stay on "Saving…" for ever after a deletion that in
    // fact succeeded completely.
    //
    // The direction matters as much as the outcome: the tombstone proves the
    // delete by PRESENCE, while absence-from-a-window proves nothing at all.
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dTombstoned')
    journal.recordDelete(WS, 'diagram', 'dNotWritten')

    const plan = planDiagramStubAck(
      journal.pending(WS),
      new Map(),
      false,
      journal.revisionNow,
      new Set(['dTombstoned']),
    )

    expect(plan.ackIds).toEqual(['dTombstoned'])
    // …and the one the meta does NOT carry is still a survivor: absence from
    // the window is not a proof, so it must keep its journal entry.
    expect(plan.survivors).toBe(true)
  })

  it('un renommage n\'est jamais acquitté par un tombstone', () => {
    // The tombstone witnesses DELETES only. A rename of a server-owned diagram
    // still has no durable client write path (ModelMeta carries no diagram
    // overrides), and letting the tombstone set answer for it would acknowledge
    // an intent nothing ever expressed.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dRen', diagram('dRen', 'New'), diagram('dRen', 'Old'))

    const plan = planDiagramStubAck(
      journal.pending(WS), new Map(), false, journal.revisionNow, new Set(['dRen']),
    )

    expect(plan.ackIds).toEqual([])
    expect(plan.survivors).toBe(true)
  })

  it('revision scoping: an intent recorded mid-flush survives the ack', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'd1', diagram('d1', 'v1'), diagram('d1', 'v0'))
    const revision = journal.revisionNow
    journal.recordUpsert(WS, 'diagram', 'd1', diagram('d1', 'v2'), diagram('d1', 'v0'))

    // The meta ALREADY EXPRESSES the newer stub (v2) — the merge predicate
    // alone would ack; only the revision filter refuses (a stale meta would let
    // the value check mask a broken revision filter).
    const plan = planDiagramStubAck(
      journal.pending(WS),
      new Map([['d1', { name: 'v2', type: 'container' }]]),
      true,
      revision,
    )

    expect(plan.ackIds).toEqual([])
    // Skipped, not a survivor: the NEXT flush covers it.
    expect(plan.survivors).toBe(false)
  })
})

describe('diagramStubOf', () => {
  it('projects exactly the registry-witnessable identity fields', () => {
    const stub = diagramStubOf(diagram('d1', 'N', {
      parentObjectId: 'p1', skinId: 'skin-x', objectIds: ['o1'],
      layouts: { o1: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } },
    }))
    expect(stub).toEqual({ name: 'N', type: 'container', parentObjectId: 'p1' })
  })
})
