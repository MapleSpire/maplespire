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
import type { Comment, Diagram, Flow } from '../../types'
import { PendingEntityIntents } from './entityIntents'
import { observeRegistryAbsence, planDiagramAbsenceSweep } from './diagramAbsenceRetirement'

const WS = 'landscape/version'

function comment(id: string, diagramId: string): Comment {
  return { id, diagramId, targetId: 'o1', type: 'question', text: 'txt', author: 'me', createdAt: 't' } as unknown as Comment
}

function flow(id: string, diagramId: string): Flow {
  return { id, diagramId, name: 'flow', steps: [] } as unknown as Flow
}

function diagram(id: string, name: string): Diagram {
  return { id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [] }
}

const never = () => false

describe('planDiagramAbsenceSweep', () => {
  it('retires comment/flow/placement/stub-rename intents of a diagram a complete registry no longer holds', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'comment', 'c1', comment('c1', 'dGone'))
    journal.recordUpsert(WS, 'flow', 'f1', flow('f1', 'dGone'))
    journal.recordDelete(WS, 'comment', 'c2', { diagramId: 'dGone' })
    journal.recordUpsert(WS, 'diagram', 'dGone', diagram('dGone', 'Renamed'), diagram('dGone', 'Old'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: ['dGone'],
      observation: { presentIds: new Set(['dOther']), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(1)
    const entry = plan.retire[0]
    expect(entry.diagramId).toBe('dGone')
    expect(entry.commentIds.sort()).toEqual(['c1', 'c2'])
    expect(entry.flowIds).toEqual(['f1'])
    expect(entry.stubIntent).toBe(true)
    expect(entry.placement).toBe(true)
  })

  it('leaves every intent of a PRESENT diagram untouched', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'comment', 'c1', comment('c1', 'dHere'))
    journal.recordUpsert(WS, 'diagram', 'dHere', diagram('dHere', 'Renamed'), diagram('dHere', 'Old'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: ['dHere'],
      observation: { presentIds: new Set(['dHere']), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(0)
    expect(plan.unaddressed).toHaveLength(0)
  })

  it('a creation in flight is absent from every shard and must NOT retire — the replay recreates it', () => {
    const journal = new PendingEntityIntents()
    // The stub creation itself (baseline undefined) is skipped structurally…
    journal.recordUpsert(WS, 'diagram', 'dNew', diagram('dNew', 'Fresh'))
    // …and its dependents are shielded by the in-flight predicate.
    journal.recordUpsert(WS, 'comment', 'c1', comment('c1', 'dNew'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: ['dNew'],
      observation: { presentIds: new Set(), summaryLocalIds: null },
      isCreationInFlight: (id) => id === 'dNew',
    })

    expect(plan.retire).toHaveLength(0)
  })

  it('a pending stub CREATION never marks stubIntent even when the id is not in flight anymore', () => {
    // Defence in depth: if the gate memo was lost (fresh boot), the creation
    // intent itself still replays — only the in-flight predicate normally
    // shields it, but the planner must not retire the creation either way.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dNew', diagram('dNew', 'Fresh'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(0)
  })

  it('under a summary registry only session-local ids are provable — server-owned intents are retained', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'comment', 'cLocal', comment('cLocal', 'dLocal'))
    journal.recordUpsert(WS, 'comment', 'cServer', comment('cServer', 'dServerOwned'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: ['dServerOwned'],
      observation: {
        presentIds: new Set(),
        summaryLocalIds: new Set(['dLocal']),
      },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(1)
    expect(plan.retire[0].diagramId).toBe('dLocal')
    expect(plan.retire[0].commentIds).toEqual(['cLocal'])
  })

  it('a comment/flow DELETE with no diagramId at all is unaddressable and retires under a complete CLASSIC observation', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'comment', 'cDangling')
    journal.recordDelete(WS, 'flow', 'fDangling')

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(['dAnything']), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(0)
    expect(plan.unaddressed).toEqual([
      { kind: 'comment', id: 'cDangling' },
      { kind: 'flow', id: 'fDangling' },
    ])
  })

  it('a dangling DELETE is RETAINED under a summary observation — the write-head proves nothing about an unknown carrier', () => {
    // Retiring a delete un-expresses a user
    // deletion; summary completeness covers session-local ids only.
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'comment', 'cDangling')

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(), summaryLocalIds: new Set(['dMine']) },
      isCreationInFlight: never,
    })

    expect(plan.unaddressed).toHaveLength(0)
    expect(plan.retire).toHaveLength(0)
  })

  it('an UPSERT with no diagramId is retained — only data-free deletes are unaddressable', () => {
    // An upsert carries user data;
    // pushing it into `unaddressed` would destroy it under a proof that
    // names no carrier.
    const journal = new PendingEntityIntents()
    const orphan = { ...comment('cOrphan', 'dX') } as { diagramId?: string }
    delete orphan.diagramId
    journal.recordUpsert(WS, 'comment', 'cOrphan', orphan as Comment)

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.unaddressed).toHaveLength(0)
    expect(plan.retire).toHaveLength(0)
  })

  it('two absent diagrams plan as two separate retirements', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'comment', 'c1', comment('c1', 'dGone1'))
    journal.recordUpsert(WS, 'flow', 'f1', flow('f1', 'dGone2'))

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: ['dGone2'],
      observation: { presentIds: new Set(), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire.map((entry) => entry.diagramId).sort()).toEqual(['dGone1', 'dGone2'])
    const second = plan.retire.find((entry) => entry.diagramId === 'dGone2')!
    expect(second.flowIds).toEqual(['f1'])
    expect(second.placement).toBe(true)
    expect(plan.retire.find((entry) => entry.diagramId === 'dGone1')!.commentIds).toEqual(['c1'])
  })

  it('non-diagram-scoped kinds never enter the plan', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'group', 'g1', { id: 'g1', name: 'G', objectIds: [] })
    journal.recordDelete(WS, 'object', 'o1')

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(0)
    expect(plan.unaddressed).toHaveLength(0)
  })

  it('placement-only debt retires on proven absence (the docUrl-stranded drain worklist)', () => {
    const plan = planDiagramAbsenceSweep({
      intents: [],
      placementDiagramIds: ['dGone', 'dHere'],
      observation: { presentIds: new Set(['dHere']), summaryLocalIds: null },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(1)
    expect(plan.retire[0]).toMatchObject({ diagramId: 'dGone', placement: true, stubIntent: false })
  })

  it('a stub DELETE of an absent diagram retires (summary mode wedge: metasComplete is hard-false there)', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'diagram', 'dGone')

    const plan = planDiagramAbsenceSweep({
      intents: journal.pending(WS),
      placementDiagramIds: [],
      observation: { presentIds: new Set(), summaryLocalIds: new Set(['dGone']) },
      isCreationInFlight: never,
    })

    expect(plan.retire).toHaveLength(1)
    expect(plan.retire[0].stubIntent).toBe(true)
  })
})

describe('observeRegistryAbsence — the completeness rules, unit-coverable', () => {
  // The abstention rules are the feature's most safety-critical logic, so
  // they are pinned here rather than only through the bridge tier.
  const witness = (url: string, ids: readonly string[] | null) => ({ url, diagramIds: ids })

  it('classic: a complete observation unions every shard', () => {
    const obs = observeRegistryAbsence({
      mode: 'classic',
      witnesses: [witness('s1', ['d1']), witness('s2', ['d2', 'd3'])],
      rootShardUrls: ['s1', 's2'],
      writeHeadUrl: null,
      summaryLocalIds: null,
    })
    expect(obs).not.toBeNull()
    expect([...obs!.presentIds].sort()).toEqual(['d1', 'd2', 'd3'])
    expect(obs!.summaryLocalIds).toBeNull()
  })

  it('classic abstains: empty witnesses; null/empty root urls; count mismatch; foreign url; unresolved shard', () => {
    const base = {
      mode: 'classic' as const,
      witnesses: [witness('s1', ['d1'])],
      rootShardUrls: ['s1'],
      writeHeadUrl: null,
      summaryLocalIds: null,
    }
    expect(observeRegistryAbsence({ ...base, witnesses: [] })).toBeNull()
    expect(observeRegistryAbsence({ ...base, rootShardUrls: null })).toBeNull()
    expect(observeRegistryAbsence({ ...base, rootShardUrls: [] })).toBeNull()
    // Mid-rollover: root lists two shards, only one resolved handle exists.
    expect(observeRegistryAbsence({ ...base, rootShardUrls: ['s1', 's2'] })).toBeNull()
    // Same-count url replacement window: the witness is not root-listed.
    expect(observeRegistryAbsence({ ...base, rootShardUrls: ['sNew'] })).toBeNull()
    // An unresolved shard is NOT an empty shard.
    expect(observeRegistryAbsence({ ...base, witnesses: [witness('s1', null)] })).toBeNull()
  })

  it('summary: unions ALL resolved witnesses — a meta living in the second shard is PRESENT', () => {
    // witnesses[0] is not the write head by construction; a session-local
    // diagram stranded in the second shard must not be falsely retired.
    const obs = observeRegistryAbsence({
      mode: 'summary',
      witnesses: [witness('h1', []), witness('h2', ['dMine'])],
      rootShardUrls: null,
      writeHeadUrl: 'h2',
      summaryLocalIds: new Set(['dMine']),
    })
    expect(obs).not.toBeNull()
    expect(obs!.presentIds.has('dMine')).toBe(true)
  })

  it('summary abstains: no write-head url; write head absent from witnesses; any unresolved witness', () => {
    const base = {
      mode: 'summary' as const,
      witnesses: [witness('h1', ['d1'])],
      rootShardUrls: null,
      writeHeadUrl: 'h1',
      summaryLocalIds: new Set<string>(),
    }
    expect(observeRegistryAbsence({ ...base, writeHeadUrl: null })).toBeNull()
    expect(observeRegistryAbsence({ ...base, writeHeadUrl: 'hElsewhere' })).toBeNull()
    expect(observeRegistryAbsence({
      ...base,
      witnesses: [witness('h1', ['d1']), witness('h2', null)],
    })).toBeNull()
  })

  it('summary: un diagramme tombstoné devient PROUVABLEMENT absent (T6)', () => {
    // Without `tombstonedIds` fed into the observation, the comment/flow/
    // placement intents of a diagram deleted REMOTELY have no exit whatsoever —
    // the replay parks them until an activation that can never come, the
    // flush-side acks skip them, and the badge wedges on 'saving' for ever,
    // rehydrated at every boot. The tombstone is the proof, and it is
    // POSITIVE — a durable document stating the deletion, not an inference
    // from a window.
    const obs = observeRegistryAbsence({
      mode: 'summary',
      witnesses: [witness('h1', [])],
      rootShardUrls: null,
      writeHeadUrl: 'h1',
      summaryLocalIds: new Set(),
      tombstonedIds: new Set(['dServerOwned']),
    })

    expect(obs).not.toBeNull()
    expect(obs!.presentIds.has('dServerOwned')).toBe(false)
    // …and provable, which is the half that actually retires the intents.
    expect(obs!.summaryLocalIds!.has('dServerOwned')).toBe(true)
  })

  it('un tombstone l\'emporte sur une entrée de registre encore présente', () => {
    // The frozen baseline registry shard keeps the entry FOR EVER by design —
    // nothing rewrites a sealed shard. So "still listed by a witness" must not
    // outrank the tombstone, or a deleted diagram would read as present and its
    // dependants would never retire.
    const obs = observeRegistryAbsence({
      mode: 'summary',
      witnesses: [witness('h1', ['dDeleted'])],
      rootShardUrls: null,
      writeHeadUrl: 'h1',
      summaryLocalIds: new Set(),
      tombstonedIds: new Set(['dDeleted']),
    })

    expect(obs!.presentIds.has('dDeleted')).toBe(false)
  })

  it('classic: un tombstone reste une absence, sans devenir une preuve summary', () => {
    // An ordinary workspace carries an empty tombstone list, so this is mostly
    // a shape guarantee — but the day a hybrid workspace carries one, it must
    // not silently flip `summaryLocalIds` away from null (which is what the
    // planner reads as "classic completeness").
    const obs = observeRegistryAbsence({
      mode: 'classic',
      witnesses: [witness('s1', ['d1'])],
      rootShardUrls: ['s1'],
      writeHeadUrl: null,
      summaryLocalIds: null,
      tombstonedIds: new Set(['d1']),
    })

    expect(obs!.presentIds.has('d1')).toBe(false)
    expect(obs!.summaryLocalIds).toBeNull()
  })
})
