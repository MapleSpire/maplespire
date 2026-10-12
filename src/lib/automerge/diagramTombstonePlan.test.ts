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
import {
  planDiagramTombstones,
  type DiagramTombstonePlanInput,
} from './diagramTombstonePlan'

const input = (
  overrides: Partial<DiagramTombstonePlanInput> = {},
): DiagramTombstonePlanInput => ({
  registrySummaryOnly: true,
  tombstonedIds: [],
  unTombstonedIds: [],
  summaryLocalDiagramIds: new Set(),
  existingTombstones: [],
  ...overrides,
})

describe('planDiagramTombstones', () => {
  it('ne tombstone que les ids explicitement supprimés par l\'utilisateur', () => {
    // A plan derived from the resident WINDOW would tombstone every registry id
    // the window does not hold. The fixture is the realistic summary shape: a
    // window of ONE while the server registry holds three, so such a plan would
    // tombstone the two off-window diagrams the user never touched (thousands
    // on a large workspace).
    //
    // There is deliberately no `registryDiagramIds` input: the planner is not
    // given the registry at all, so the window-difference
    // implementation cannot be typed here. That structural absence is the
    // primary guard; this test pins the other half — `tombstonedIds` is the
    // ONLY channel into `add`.
    const plan = planDiagramTombstones(input({ tombstonedIds: ['dg-deleted'] }))

    expect(plan.add).toEqual(['dg-deleted'])
    expect(plan.remove).toEqual([])
  })

  it('ne tombstone rien quand l\'utilisateur n\'a rien supprimé', () => {
    // The void guard for the case above: with no explicit intent the plan is EMPTY even
    // though the window holds a single diagram out of a large registry.
    const plan = planDiagramTombstones(input())

    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.deferredToLocalRegistry).toEqual([])
  })

  it('n\'émet pas de tombstone pour un id créé en session', () => {
    // The `summaryLocalDiagramIds` exclusion: a session-created id already has
    // a real removal path (`writeSummaryLocalRegistry` does
    // `delete shard.diagrams[id]` in the write head), so tombstoning it produces
    // BOTH a shard removal and a permanent tombstone: two truths, and unbounded
    // growth in the one document a summary boot must materialise.
    const plan = planDiagramTombstones(input({
      tombstonedIds: ['dg-created', 'dg-server-owned'],
      summaryLocalDiagramIds: new Set(['dg-created']),
    }))

    expect(plan.add).toEqual(['dg-server-owned'])
    expect(plan.deferredToLocalRegistry).toEqual(['dg-created'])
  })

  it('lève le tombstone quand l\'id est recréé', () => {
    // Without the un-tombstone branch (the `remObj` equivalent in bridge.ts), a
    // JSON import under "existing ids win" that recreates the same id would
    // leave it invisible for ever — the server read model keeps
    // excluding it and no later write can ever say otherwise.
    const plan = planDiagramTombstones(input({
      unTombstonedIds: ['dg-recreated'],
      existingTombstones: ['dg-recreated', 'dg-still-deleted'],
    }))

    expect(plan.remove).toEqual(['dg-recreated'])
    expect(plan.add).toEqual([])
  })

  it('ne lève un tombstone que pour un id réellement écrit dans le meta', () => {
    // Companion to the case above: an un-tombstone for an id the meta does not carry is not
    // a change. Without this the flush would take a no-op Automerge change (and
    // a repo.flush + IndexedDB round trip) on every later pass.
    const plan = planDiagramTombstones(input({
      unTombstonedIds: ['dg-never-deleted'],
      existingTombstones: [],
    }))

    expect(plan.remove).toEqual([])
  })

  it('rend un plan vide hors contrat summary', () => {
    // The `registrySummaryOnly` guard: a session that is `bfsActive` on an
    // ORDINARY landscape (the VITE flag on a classic workspace — a reachable
    // state) would otherwise write tombstones for diagrams its resident
    // registry already knows how to remove: two truths on an ordinary
    // workspace, and a ModelMeta that grows for nothing.
    const plan = planDiagramTombstones(input({
      registrySummaryOnly: false,
      tombstonedIds: ['dg-deleted'],
      unTombstonedIds: ['dg-recreated'],
      existingTombstones: ['dg-recreated'],
    }))

    expect(plan).toEqual({ add: [], remove: [], deferredToLocalRegistry: [] })
  })

  it('ne réécrit pas un tombstone déjà présent', () => {
    // Append-only union semantics: a re-delete of an already-tombstoned id is
    // durable already. Re-appending would grow the list without bound on every
    // flush of the session.
    const plan = planDiagramTombstones(input({
      tombstonedIds: ['dg-deleted'],
      existingTombstones: ['dg-deleted'],
    }))

    expect(plan.add).toEqual([])
  })

  it('ne tombstone pas un id supprimé puis recréé avant le flush', () => {
    // The RE-CREATION signal is `unTombstonedIds`, fed by `detectEdits` on a
    // USER tick — never by the resident window, which projections refill
    // (including with the echo of this very delete). Suppressing on window
    // presence would drop real deletions on the floor.
    const plan = planDiagramTombstones(input({
      tombstonedIds: ['dg-churned'],
      unTombstonedIds: ['dg-churned'],
      existingTombstones: ['dg-churned'],
    }))

    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual(['dg-churned'])
  })

  it('une levée l\'emporte sur un ajout dans la MÊME passe', () => {
    // Pins the module's rule "a lift always wins over an add for the same id in
    // the same pass" (the `lifting` guard). The bridge keeps the two sets
    // disjoint, but that is a property of ONE caller of a pure, exported
    // planner; the failure would be a tombstone written for a diagram the user
    // has just re-created, hiding it for ever with its data intact.
    //
    // The `existing` half is what makes the two branches disagree at all: when
    // the meta does not yet carry the id, `remove` is empty by design, so an
    // unguarded `add` is the ONLY thing the plan would emit.
    const plan = planDiagramTombstones({
      registrySummaryOnly: true,
      tombstonedIds: ['dg-1'],
      unTombstonedIds: ['dg-1'],
      summaryLocalDiagramIds: new Set(),
      existingTombstones: [],
    })

    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('dédoublonne les intentions répétées', () => {
    const plan = planDiagramTombstones(input({
      tombstonedIds: ['dg-a', 'dg-a', 'dg-b'],
    }))

    expect(plan.add).toEqual(['dg-a', 'dg-b'])
  })
})
