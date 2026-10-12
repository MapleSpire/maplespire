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
  planBulkTagAssign,
  planBulkTagRemove,
  planBulkTechnologyAssign,
  planBulkTechnologyRemove,
  tagCoverage,
  technologyCoverage,
} from './bulkAssign'
import type { C4Object, TechnologyUsage } from '../../types'

const object = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  ...over,
} as C4Object)

const tagged = (id: string, ...tagIds: string[]) => object(id, {
  tagAssignments: Object.fromEntries(tagIds.map((t) => [t, { tagId: t }])),
  tagOrder: [...tagIds],
})

const usage = (id: string, technologyId: string, name = technologyId): TechnologyUsage => ({
  id,
  technologyId,
  catalogRevision: 1,
  role: 'runtime',
  snapshot: { schemaVersion: 1, name, defaultRole: 'runtime' },
} as unknown as TechnologyUsage)

/** Deterministic ids, so a plan can be asserted whole. */
function minter(prefix = 'new') {
  let n = 0
  return () => `${prefix}${++n}`
}

describe('tagCoverage', () => {
  it('counts how many of the selection carry each tag', () => {
    const counts = tagCoverage([tagged('a', 'red', 'blue'), tagged('b', 'red'), tagged('c')])
    expect(counts.get('red')).toBe(2)
    expect(counts.get('blue')).toBe(1)
    expect(counts.has('green')).toBe(false)
  })

  it('is empty for a selection with no tags', () => {
    expect(tagCoverage([object('a'), object('b')]).size).toBe(0)
  })
})

describe('planBulkTagAssign', () => {
  it('assigns to every shape that does not already carry the tag', () => {
    const updates = planBulkTagAssign([tagged('a'), tagged('b')], ['red'])
    expect(updates.map((u) => u.id)).toEqual(['a', 'b'])
    expect(updates[0].data.tagAssignments).toEqual({ red: { tagId: 'red' } })
    expect(updates[0].data.tagOrder).toEqual(['red'])
  })

  // Not economy: every write re-runs the sync bridge's model sweep, so an
  // assignment that changes nothing would still mark the object edited for
  // every peer.
  it('writes nothing for a shape that already has it', () => {
    expect(planBulkTagAssign([tagged('a', 'red')], ['red'])).toEqual([])
  })

  it('skips only the shapes that have it, not the whole batch', () => {
    const updates = planBulkTagAssign([tagged('a', 'red'), tagged('b')], ['red'])
    expect(updates.map((u) => u.id)).toEqual(['b'])
  })

  it('keeps the tags a shape already had', () => {
    const updates = planBulkTagAssign([tagged('a', 'blue')], ['red'])
    expect(Object.keys(updates[0].data.tagAssignments ?? {}).sort()).toEqual(['blue', 'red'])
    expect(updates[0].data.tagOrder).toEqual(['blue', 'red'])
  })

  // The planner clones before mutating; the helpers it delegates to mutate in
  // place, so a missed clone would edit the store's objects behind zustand's
  // back and no re-render would follow.
  it('does not touch the shapes it was given', () => {
    const shape = tagged('a', 'blue')
    planBulkTagAssign([shape], ['red'])
    expect(Object.keys(shape.tagAssignments)).toEqual(['blue'])
    expect(shape.tagOrder).toEqual(['blue'])
  })
})

describe('planBulkTagRemove', () => {
  it('removes from every shape that carries it, and only those', () => {
    const updates = planBulkTagRemove([tagged('a', 'red'), tagged('b'), tagged('c', 'red', 'blue')], 'red')
    expect(updates.map((u) => u.id)).toEqual(['a', 'c'])
    expect(updates[0].data.tagAssignments).toEqual({})
    expect(Object.keys(updates[1].data.tagAssignments ?? {})).toEqual(['blue'])
  })

  it('drops the tag from the order as well as the assignments', () => {
    const updates = planBulkTagRemove([tagged('a', 'red', 'blue')], 'red')
    expect(updates[0].data.tagOrder).toEqual(['blue'])
  })

  it('does not touch the shapes it was given', () => {
    const shape = tagged('a', 'red')
    planBulkTagRemove([shape], 'red')
    expect(Object.keys(shape.tagAssignments)).toEqual(['red'])
  })
})

describe('planBulkTechnologyAssign', () => {
  it('gives every shape its OWN usage id', () => {
    const updates = planBulkTechnologyAssign([object('a'), object('b')], [usage('picked', 'redis')], minter())
    const ids = updates.map((u) => Object.keys(u.data.technologyUsages ?? {})[0])
    expect(ids).toEqual(['new1', 'new2'])
  })

  // The store's `addTechnologyToSelected` writes the usage map and nothing else,
  // which leaves the technology unordered and the shape without the icon a
  // single-shape assignment would have derived.
  it('writes the order and the derived icon, not just the usage', () => {
    const updates = planBulkTechnologyAssign([object('a')], [usage('picked', 'redis', 'Redis')], minter())
    expect(updates[0].data.technologyUsageOrder).toEqual(['new1'])
    expect(updates[0].data.icon).toBe('Redis')
    expect(updates[0].data.iconAssignment).toMatchObject({ source: 'technology', mode: 'automatic' })
  })

  it('leaves an existing icon alone', () => {
    const updates = planBulkTechnologyAssign(
      [object('a', { icon: 'Chosen', iconAssignment: { source: 'generic', mode: 'explicit', displayName: 'Chosen' } as never })],
      [usage('picked', 'redis', 'Redis')],
      minter(),
    )
    expect(updates[0].data.icon).toBe('Chosen')
  })

  it('writes nothing for a shape that already has the technology', () => {
    const already = object('a', {
      technologyUsages: { existing: usage('existing', 'redis') },
      technologyUsageOrder: ['existing'],
    })
    expect(planBulkTechnologyAssign([already], [usage('picked', 'redis')], minter())).toEqual([])
  })

  it('still writes the shapes that lack it', () => {
    const already = object('a', {
      technologyUsages: { existing: usage('existing', 'redis') },
      technologyUsageOrder: ['existing'],
    })
    const updates = planBulkTechnologyAssign([already, object('b')], [usage('picked', 'redis')], minter())
    expect(updates.map((u) => u.id)).toEqual(['b'])
  })

  it('applies a whole basket to every shape', () => {
    const updates = planBulkTechnologyAssign(
      [object('a'), object('b')],
      [usage('p1', 'redis'), usage('p2', 'kafka')],
      minter(),
    )
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(Object.keys(update.data.technologyUsages ?? {})).toHaveLength(2)
      expect(update.data.technologyUsageOrder).toHaveLength(2)
    }
    // Four assignments, four distinct ids.
    const ids = updates.flatMap((u) => Object.keys(u.data.technologyUsages ?? {}))
    expect(new Set(ids).size).toBe(4)
  })

  it('keeps the technologies a shape already had', () => {
    const already = object('a', {
      technologyUsages: { existing: usage('existing', 'kafka') },
      technologyUsageOrder: ['existing'],
    })
    const updates = planBulkTechnologyAssign([already], [usage('picked', 'redis')], minter())
    expect(updates[0].data.technologyUsageOrder).toEqual(['existing', 'new1'])
  })

  it('plans nothing at all for an empty basket', () => {
    expect(planBulkTechnologyAssign([object('a')], [], minter())).toEqual([])
  })

  it('does not touch the shapes it was given', () => {
    const shape = object('a')
    planBulkTechnologyAssign([shape], [usage('picked', 'redis')], minter())
    expect(shape.technologyUsages).toBeUndefined()
  })
})

describe('technologyCoverage', () => {
  it('counts shapes, not usages', () => {
    // The same technology twice on one shape (two roles) is still one shape.
    const twice = object('a', {
      technologyUsages: { u1: usage('u1', 'redis'), u2: usage('u2', 'redis') },
    })
    const once = object('b', { technologyUsages: { u3: usage('u3', 'redis') } })
    expect(technologyCoverage([twice, once]).get('redis')?.count).toBe(2)
  })

  it('carries a display name for the chip', () => {
    const shape = object('a', { technologyUsages: { u1: usage('u1', 'redis', 'Redis') } })
    expect(technologyCoverage([shape]).get('redis')?.name).toBe('Redis')
  })
})

describe('planBulkTechnologyRemove', () => {
  // Keyed by the usage's own id, which is the invariant everywhere the map is
  // written (`usages[incoming.id] = incoming`). A fixture that keys it any other
  // way tests a shape the app cannot produce.
  const withRedis = (id: string) => object(id, {
    technologyUsages: {
      [`${id}u`]: usage(`${id}u`, 'redis', 'Redis'),
      [`${id}k`]: usage(`${id}k`, 'kafka', 'Kafka'),
    },
    technologyUsageOrder: [`${id}u`, `${id}k`],
  })

  it('removes the technology from every shape that carries it', () => {
    const { updates, blockedIds } = planBulkTechnologyRemove([withRedis('a'), withRedis('b')], 'redis')
    expect(blockedIds).toEqual([])
    expect(updates.map((u) => u.id)).toEqual(['a', 'b'])
    for (const update of updates) {
      const left = Object.values(update.data.technologyUsages ?? {}).map((u) => u.technologyId)
      expect(left).toEqual(['kafka'])
    }
  })

  it('leaves shapes that do not carry it alone', () => {
    const { updates } = planBulkTechnologyRemove([withRedis('a'), object('b')], 'redis')
    expect(updates.map((u) => u.id)).toEqual(['a'])
  })

  it('removes every usage of the technology, not just the first', () => {
    // One shape, same technology twice under different roles.
    const twice = object('a', {
      technologyUsages: { u1: usage('u1', 'redis'), u2: usage('u2', 'redis'), k: usage('k', 'kafka') },
      technologyUsageOrder: ['u1', 'u2', 'k'],
    })
    const { updates } = planBulkTechnologyRemove([twice], 'redis')
    expect(Object.keys(updates[0].data.technologyUsages ?? {})).toEqual(['k'])
    expect(updates[0].data.technologyUsageOrder).toEqual(['k'])
  })

  // `removeTechnologyUsage` says "this shape now has no icon" by OMITTING the
  // key. Spreading it conditionally would read as "leave the icon alone", and
  // the shape would keep an icon whose technology is gone.
  it('clears an icon whose technology just left', () => {
    const shape = object('a', {
      technologyUsages: { u: usage('u', 'redis', 'Redis') },
      technologyUsageOrder: ['u'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'automatic', technologyUsageId: 'u', displayName: 'Redis' } as never,
    })
    const { updates } = planBulkTechnologyRemove([shape], 'redis')
    expect('icon' in (updates[0].data as object)).toBe(true)
    expect(updates[0].data.icon).toBeUndefined()
    expect(updates[0].data.iconAssignment).toBeUndefined()
  })

  it('falls back to the next technology for an automatic icon', () => {
    const shape = object('a', {
      technologyUsages: { u: usage('u', 'redis', 'Redis'), k: usage('k', 'kafka', 'Kafka') },
      technologyUsageOrder: ['u', 'k'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'automatic', technologyUsageId: 'u', displayName: 'Redis' } as never,
    })
    const { updates } = planBulkTechnologyRemove([shape], 'redis')
    expect(updates[0].data.icon).toBe('Kafka')
  })

  // The same refusal the single-shape flow makes, reported rather than skipped
  // — the caller has to ask before overriding it.
  it('reports the shapes whose explicit icon depends on the technology', () => {
    const explicit = object('a', {
      technologyUsages: { u: usage('u', 'redis', 'Redis') },
      technologyUsageOrder: ['u'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'explicit', technologyUsageId: 'u', displayName: 'Redis' } as never,
    })
    const { updates, blockedIds } = planBulkTechnologyRemove([explicit, withRedis('b')], 'redis')
    expect(blockedIds).toEqual(['a'])
    // The rest of the selection is still planned, not abandoned.
    expect(updates.map((u) => u.id)).toEqual(['b'])
  })

  it('goes through with it once the caller allows the icon to be cleared', () => {
    const explicit = object('a', {
      technologyUsages: { u: usage('u', 'redis', 'Redis') },
      technologyUsageOrder: ['u'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'explicit', technologyUsageId: 'u', displayName: 'Redis' } as never,
    })
    const { updates, blockedIds } = planBulkTechnologyRemove([explicit], 'redis', {
      allowExplicitIconRemoval: true,
    })
    expect(blockedIds).toEqual([])
    expect(updates[0].data.icon).toBeUndefined()
  })

  it('does not touch the shapes it was given', () => {
    const shape = withRedis('a')
    planBulkTechnologyRemove([shape], 'redis')
    expect(Object.keys(shape.technologyUsages ?? {})).toEqual(['au', 'ak'])
  })
})

/**
 * The basket. `TagPicker` commits a staged multi-select by replaying its
 * single-add callback once per tag, in one tick, before React can re-render —
 * so a handler that PLANS from captured objects reads the same pre-update state
 * every time and each write clobbers the last. A three-tag basket applied one
 * tag. The planner takes the whole basket for exactly this reason.
 */
describe('planBulkTagAssign with a basket', () => {
  it('applies every tag in the basket to every shape', () => {
    const updates = planBulkTagAssign([tagged('a'), tagged('b')], ['red', 'blue', 'green'])
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(Object.keys(update.data.tagAssignments ?? {}).sort()).toEqual(['blue', 'green', 'red'])
      expect(update.data.tagOrder).toEqual(['red', 'blue', 'green'])
    }
  })

  it('keeps a basket and the tags a shape already had', () => {
    const updates = planBulkTagAssign([tagged('a', 'keep')], ['red', 'blue'])
    expect(updates[0].data.tagOrder).toEqual(['keep', 'red', 'blue'])
  })

  it('adds only the missing ones', () => {
    const updates = planBulkTagAssign([tagged('a', 'red')], ['red', 'blue'])
    expect(updates[0].data.tagOrder).toEqual(['red', 'blue'])
  })

  it('writes nothing when a shape already carries the whole basket', () => {
    expect(planBulkTagAssign([tagged('a', 'red', 'blue')], ['red', 'blue'])).toEqual([])
  })

  it('writes nothing for an empty basket', () => {
    expect(planBulkTagAssign([tagged('a')], [])).toEqual([])
  })

  // `orderedTagIds` exists because a CRDT merge can leave an assignment with no
  // entry in `tagOrder`. A guard that consulted the ORDER instead of the
  // assignments would call such a tag missing and re-add it.
  it('treats a tag with no order entry as already assigned', () => {
    const merged = object('a', { tagAssignments: { red: { tagId: 'red' } }, tagOrder: [] })
    expect(planBulkTagAssign([merged], ['red'])).toEqual([])
  })

  // `TagAssignable` documents both fields as optional for a partially hydrated
  // shard; every other fixture supplies them, so nothing else exercises this.
  it('survives a shape with neither field hydrated yet', () => {
    const bare = { ...object('a') } as C4Object
    delete (bare as Partial<C4Object>).tagAssignments
    delete (bare as Partial<C4Object>).tagOrder
    const updates = planBulkTagAssign([bare], ['red'])
    expect(updates[0].data.tagAssignments).toEqual({ red: { tagId: 'red' } })
    expect(updates[0].data.tagOrder).toEqual(['red'])
  })
})

describe('folding more than one removal on the same shape', () => {
  // The fold passes each step's RESULT in as the next step's state. Drop the
  // icon from that carry-over and both of these break — silently.
  it('carries the icon through to the last step', () => {
    const shape = object('a', {
      technologyUsages: {
        u1: usage('u1', 'redis', 'Redis'),
        u2: usage('u2', 'redis', 'Redis'),
        k: usage('k', 'kafka', 'Kafka'),
      },
      technologyUsageOrder: ['u1', 'u2', 'k'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'automatic', technologyUsageId: 'u1', displayName: 'Redis' } as never,
    })
    const { updates } = planBulkTechnologyRemove([shape], 'redis')
    // The icon hops u1 -> u2 -> Kafka rather than being dropped on the way.
    expect(updates[0].data.icon).toBe('Kafka')
    expect(Object.keys(updates[0].data.technologyUsages ?? {})).toEqual(['k'])
  })

  it('still reports a block when the SECOND usage is the explicit icon source', () => {
    const shape = object('a', {
      technologyUsages: { u1: usage('u1', 'redis', 'Redis'), u2: usage('u2', 'redis', 'Redis') },
      technologyUsageOrder: ['u1', 'u2'],
      icon: 'Redis',
      iconAssignment: { source: 'technology', mode: 'explicit', technologyUsageId: 'u2', displayName: 'Redis' } as never,
    })
    const { updates, blockedIds } = planBulkTechnologyRemove([shape], 'redis')
    expect(blockedIds).toEqual(['a'])
    expect(updates).toEqual([])
  })
})

describe('what the coverage name is taken from', () => {
  // The name is the chip's label AND the {{technology}} in the remove confirm.
  // Snapshot names legitimately diverge across shapes after a catalog rename,
  // so which shape it comes from has to be pinned.
  it('takes the display name from the first shape that carries it', () => {
    const older = object('a', { technologyUsages: { u: usage('u', 'redis', 'Redis') } })
    const renamed = object('b', { technologyUsages: { v: usage('v', 'redis', 'Redis 7') } })
    expect(technologyCoverage([older, renamed]).get('redis')?.name).toBe('Redis')
  })
})
