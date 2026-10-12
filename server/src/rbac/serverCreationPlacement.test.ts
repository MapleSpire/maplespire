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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BoundedPlacementMap,
  bootstrapPlacementFor,
  bootstrapPlacementSnapshot,
  noteBootstrapPlacement,
  noteServerCreationPlacement,
  placementForFence,
  purgeServerCreationPlacement,
  resetServerCreationPlacementForTest,
  retireBootstrapPlacement,
  serverCreationPlacementFor,
  serverCreationPlacementMetricSamples,
  serverCreationPlacementSnapshot,
} from './serverCreationPlacement.js'

/**
 * ONE MAP CLASS, TWO TIERS, and the properties each tier's reader
 * depends on. The owner tier's behaviour is exercised end to end by
 * `workspaceWriter.ordering.seam.test.ts`; this file is the class itself and
 * the forker tier, whose reader is the storage fence with no flag in front.
 */

const A = { landscapeId: 'L', versionId: 'V-a' }
const B = { landscapeId: 'L', versionId: 'V-b' }

describe('BoundedPlacementMap — the retired tier is evicted first, and only live evictions are overflows', () => {
  it('KILLS "evict oldest regardless of tier": residue goes before a live entry', () => {
    const map = new BoundedPlacementMap(3)
    map.note('d1', A)
    map.note('d2', A)
    map.note('d3', A)
    map.retire(['d1'])
    expect(map.snapshot()).toMatchObject({ size: 3, live: 2, retired: 1, overflowCount: 0, retiredEvictions: 0 })
    // At capacity: the retired d1 goes, not the oldest live d2.
    map.note('d4', A)
    expect(map.get('d1')).toBeNull()
    expect(map.get('d2')).toEqual(A)
    expect(map.snapshot()).toMatchObject({ size: 3, live: 3, retired: 0, overflowCount: 0, retiredEvictions: 1 })
    // No residue left: now a LIVE entry goes, and THAT is an overflow.
    map.note('d5', A)
    expect(map.get('d2')).toBeNull()
    expect(map.snapshot()).toMatchObject({ overflowCount: 1, retiredEvictions: 1 })
  })

  it('retiring twice moves nothing twice: an entry already retired stays where it is, counts unchanged', () => {
    // Both `forkRoot` and the publisher's catch can retire the same scope, and a
    // second retire that re-inserted (or double-counted) would corrupt the
    // eviction order the first arm above depends on.
    const W = { landscapeId: 'L-retire', versionId: 'V-retire' }
    const map = new BoundedPlacementMap(8)
    map.note('d1', W)
    map.note('d2', W)
    map.retire(['d1'])
    const once = map.snapshot()
    map.retire(['d1'])
    map.retire(['d1', 'd2'])
    expect(map.snapshot()).toMatchObject({ size: 2, live: 0, retired: 2, overflowCount: once.overflowCount, retiredEvictions: once.retiredEvictions })
    expect(map.get('d1')).toEqual(W)
    expect(map.get('d2')).toEqual(W)
  })

  it('a retired entry still ANSWERS — the write-back of a torn-down document must meet the fence', () => {
    const map = new BoundedPlacementMap(8)
    map.note('d1', A)
    map.retire(['d1'])
    expect(map.get('d1')).toEqual(A)
    // Reads do not evict, however many.
    for (let i = 0; i < 50; i += 1) map.get('d1')
    expect(map.snapshot().retired).toBe(1)
  })

  it('note is a no-op for an id in EITHER tier — re-noting at capacity must not evict for nothing', () => {
    const map = new BoundedPlacementMap(2)
    map.note('d1', A)
    map.note('d2', A)
    map.retire(['d1'])
    map.note('d1', B)          // already retired: nothing moves, nothing evicts
    expect(map.get('d1')).toEqual(A)
    expect(map.snapshot()).toMatchObject({ retiredEvictions: 0, overflowCount: 0 })
    map.note('d2', B)          // already live
    expect(map.get('d2')).toEqual(A)
    expect(map.snapshot().size).toBe(2)
  })

  it('hands out a FRESH object per read — a consumer cannot corrupt the map through its answer', () => {
    const map = new BoundedPlacementMap(8)
    map.note('d1', A)
    const answer = map.get('d1')!
    answer.versionId = 'mutated'
    expect(map.get('d1')).toEqual(A)
  })

  it('purge removes from both tiers; retire of an unknown id is ignored', () => {
    const map = new BoundedPlacementMap(8)
    map.note('d1', A)
    map.note('d2', A)
    map.retire(['d1', 'nope'])
    map.purge(['d1', 'd2', 'nope'])
    expect(map.snapshot()).toMatchObject({ size: 0, live: 0, retired: 0 })
  })
})

describe('the two tiers behind the module API', () => {
  const savedMode = process.env.SYNC_CELL_UNPLACED_CREATION
  beforeEach(() => resetServerCreationPlacementForTest())
  afterEach(() => {
    resetServerCreationPlacementForTest()
    if (savedMode === undefined) delete process.env.SYNC_CELL_UNPLACED_CREATION
    else process.env.SYNC_CELL_UNPLACED_CREATION = savedMode
  })

  it('the FORKER tier answers the fence with NO flag in front — the owner tier still waits for B2-9', () => {
    delete process.env.SYNC_CELL_UNPLACED_CREATION
    noteServerCreationPlacement('owned', A)
    noteBootstrapPlacement('forked', B)
    // Owner tier: census reads, fence does not, under the default `observe`.
    expect(serverCreationPlacementFor('owned')).toEqual(A)
    expect(placementForFence('owned')).toBeNull()
    // Forker tier: the fence reads it as it is.
    expect(bootstrapPlacementFor('forked')).toEqual(B)
    // And the tiers do not answer for each other.
    expect(bootstrapPlacementFor('owned')).toBeNull()
    expect(serverCreationPlacementFor('forked')).toBeNull()
    expect(placementForFence('forked')).toBeNull()
    process.env.SYNC_CELL_UNPLACED_CREATION = 'refuse'
    expect(placementForFence('owned')).toEqual(A)
    expect(placementForFence('forked'), 'the flag arms the OWNER tier only').toBeNull()
  })

  it('ONE purge for both tiers — a claim path cannot forget the other one', () => {
    noteServerCreationPlacement('owned', A)
    noteBootstrapPlacement('forked', B)
    purgeServerCreationPlacement(['owned', 'forked'])
    expect(serverCreationPlacementFor('owned')).toBeNull()
    expect(bootstrapPlacementFor('forked')).toBeNull()
    expect(serverCreationPlacementSnapshot().size).toBe(0)
    expect(bootstrapPlacementSnapshot().size).toBe(0)
  })

  it('retire is the forker tier\'s alone, and the snapshot says so', () => {
    noteBootstrapPlacement('forked', B)
    retireBootstrapPlacement(['forked'])
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: 1 })
    expect(bootstrapPlacementFor('forked')).toEqual(B)
  })

  it('exports both tiers to /metrics, by name, with the counters that mean different things kept apart', () => {
    const names = serverCreationPlacementMetricSamples().map((s) => s.name).sort()
    expect(names).toEqual([
      'maplespire_bootstrap_placement_overflows_total',
      'maplespire_bootstrap_placement_retired_evictions_total',
      'maplespire_bootstrap_placements',
      'maplespire_bootstrap_placements_retired',
      'maplespire_server_creation_placement_overflows_total',
      'maplespire_server_creation_placements',
    ])
  })
})
