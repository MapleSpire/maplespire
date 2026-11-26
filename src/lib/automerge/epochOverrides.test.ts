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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultChecked, fetchOverrides, groupByEntity, isReapplyMessage, plainOf, planReapply, reapplyMessage, rowStatuses, toggleChecked,
  type OverrideRow, type ReplicaView,
} from './epochOverrides'

/** G4-16f: the batch re-apply's pure half. */
const row = (id: string, path: Array<string | number>, late: unknown, current: unknown, reason = 'leaf'): OverrideRow => ({
  id, entityKind: String(path[0]).replace(/s$/, ''), entityId: typeof path[1] === 'string' ? path[1] : null, path, reason,
  lateValue: late, currentValueAtForward: current, currentHeadsAtForward: ['h'], targetDoc: 'T', state: 'pending', createdAt: '2026-11-14T00:00:00Z',
})

function replica(state: { objects?: Record<string, Record<string, unknown>>; connections?: Record<string, Record<string, unknown>>; groups?: Record<string, Record<string, unknown>> }): ReplicaView {
  return { entity: (collection, id) => state[collection]?.[id] }
}

describe('the review rows', () => {
  const y = row('r-y', ['objects', 'y', 'name'], 'Marie', 'Paul')
  const w = row('r-w', ['objects', 'w', 'description'], 'mine', 'theirs')
  const u = row('r-u', ['objects', 'u', 'status'], 'live', 'deprecated')
  const live = replica({ objects: { y: { id: 'y', name: 'Paul' }, w: { id: 'w', description: 'theirs' }, u: { id: 'u', status: 'deprecated' } } })

  it('EVERY row is checked by default', () => {
    const statuses = rowStatuses([y, w, u], live)
    expect([...defaultChecked([y, w, u], statuses)].sort()).toEqual(['r-u', 'r-w', 'r-y'])
  })

  it('a row whose field changed SINCE the override is not checked by default and is shown "changed since: now X"', () => {
    const later = replica({ objects: { y: { id: 'y', name: 'Paul again' }, w: { id: 'w', description: 'theirs' }, u: { id: 'u', status: 'deprecated' } } })
    const statuses = rowStatuses([y, w, u], later)
    expect(statuses.get('r-y')).toEqual({ kind: 'changed-since', now: 'Paul again' })
    expect(defaultChecked([y, w, u], statuses).has('r-y')).toBe(false)
  })

  it('groups by entity', () => {
    const y2 = row('r-y2', ['objects', 'y', 'description'], 'a', 'b')
    expect(groupByEntity([y, w, y2]).map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['objects:y', ['r-y', 'r-y2']], ['objects:w', ['r-w']],
    ])
  })
})

describe('planReapply (the batch at the click)', () => {
  const y = row('r-y', ['objects', 'y', 'name'], { $immutable: 'Marie' }, 'Paul')
  const w = row('r-w', ['objects', 'w', 'description'], 'mine', 'theirs')
  const u = row('r-u', ['objects', 'u', 'status'], 'live', 'deprecated')

  it('writes the checked rows, dismisses the unchecked, PULLS OUT a row changed since (unchecked, not written, not dismissed)', () => {
    // Paul edited U again after the notice: now "retired".
    const view = replica({ objects: { y: { id: 'y', name: 'Paul' }, w: { id: 'w', description: 'theirs' }, u: { id: 'u', status: 'retired' } } })
    const plan = planReapply([y, w, u], new Set(['r-y', 'r-u']), view, 'b-1')
    expect(plan.reapplied).toEqual(['r-y'])
    expect(plan.dismissed).toEqual(['r-w'])
    expect(plan.pulled).toEqual(['r-u'])
    expect(plan.updates).toEqual([{ collection: 'objects', id: 'y', patch: { name: 'Marie' } }])
  })

  it('a value compared after decoding: an ImmutableString override still matches the plain string in the store', () => {
    expect(plainOf({ $immutable: 'x' })).toBe('x')
    expect(plainOf([{ $counter: 3 }, { a: { $date: '2026-01-01' } }])).toEqual([3, { a: '2026-01-01' }])
  })

  it('nested paths patch a copy of the top-level field', () => {
    const nested = row('r-n', ['objects', 'y', 'properties', 'k'], 'mine', 'theirs')
    const view = replica({ objects: { y: { id: 'y', properties: { k: 'theirs', other: 1 } } } })
    const plan = planReapply([nested], new Set(['r-n']), view, 'b')
    expect(plan.updates).toEqual([{ collection: 'objects', id: 'y', patch: { properties: { k: 'mine', other: 1 } } }])
    expect(view.entity('objects', 'y')).toEqual({ id: 'y', properties: { k: 'theirs', other: 1 } })
  })
})

describe('re-creating deleted entities', () => {
  const objRow = row('r-o', ['objects', 'o'], { id: 'o', name: 'Gone' }, null, 'entity-deleted')
  const connRow = row('r-c', ['connections', 'c'], { id: 'c', fromId: 'o', toId: 'kept' }, null, 'entity-deleted')
  const orphan = row('r-x', ['connections', 'x'], { id: 'x', fromId: 'missing', toId: 'kept' }, null, 'entity-deleted')
  const view = replica({ objects: { kept: { id: 'kept' } } })

  it('a connection whose endpoint is itself a pending entity row is BUNDLED: checking one checks the other', () => {
    const statuses = rowStatuses([objRow, connRow], view)
    expect(statuses.get('r-c')).toEqual({ kind: 'needs', rowIds: ['r-o'], entityIds: ['o'] })
    expect([...toggleChecked(new Set(), 'r-c', true, statuses)].sort()).toEqual(['r-c', 'r-o'])
    expect([...toggleChecked(new Set(['r-c', 'r-o']), 'r-o', false, statuses)]).toEqual([])
  })

  it('a `needs` row is CHECKED by default, like a ready one', () => {
    const statuses = rowStatuses([objRow, connRow], view)
    expect([...defaultChecked([objRow, connRow], statuses)].sort()).toEqual(['r-c', 'r-o'])
  })

  // Both endpoints are deleted pending objects.
  const objB = row('r-b', ['objects', 'b'], { id: 'b', name: 'B' }, null, 'entity-deleted')
  const both = row('r-cb', ['connections', 'cb'], { id: 'cb', fromId: 'o', toId: 'b' }, null, 'entity-deleted')

  it('a connection needing TWO deleted endpoints lists both; checking it checks both, unchecking either unchecks it', () => {
    const statuses = rowStatuses([objRow, objB, both], view)
    expect(statuses.get('r-cb')).toEqual({ kind: 'needs', rowIds: ['r-o', 'r-b'], entityIds: ['o', 'b'] })
    expect([...toggleChecked(new Set(), 'r-cb', true, statuses)].sort()).toEqual(['r-b', 'r-cb', 'r-o'])
    expect([...toggleChecked(new Set(['r-o', 'r-b', 'r-cb']), 'r-b', false, statuses)].sort()).toEqual(['r-o'])
  })

  it('a `needs` row whose endpoint row is UNCHECKED is pulled, never resolved as re-applied', () => {
    // B unchecked behind the toggle's back (a refresh kept it unchecked).
    const plan = planReapply([objRow, objB, both], new Set(['r-o', 'r-cb']), view, 'b')
    expect(plan.reapplied).toEqual(['r-o'])
    expect(plan.pulled).toEqual(['r-cb'])
    expect(plan.dismissed).toEqual(['r-b'])
    expect(plan.recreate.map((r) => r.entity.id)).toEqual(['o'])
  })

  it('a connection to a deleted GROUP is re-creatable with it', () => {
    const groupRow = row('r-g', ['groups', 'g'], { id: 'g', name: 'G' }, null, 'entity-deleted')
    const toGroup = row('r-cg', ['connections', 'cg'], { id: 'cg', fromId: 'kept', toId: 'g' }, null, 'entity-deleted')
    const statuses = rowStatuses([groupRow, toGroup], view)
    expect(statuses.get('r-cg')).toEqual({ kind: 'needs', rowIds: ['r-g'], entityIds: ['g'] })
    const kept = replica({ objects: { kept: { id: 'kept' } }, groups: { g2: { id: 'g2' } } })
    const toLiveGroup = row('r-cl', ['connections', 'cl'], { id: 'cl', fromId: 'kept', toId: 'g2' }, null, 'entity-deleted')
    expect(rowStatuses([toLiveGroup], kept).get('r-cl')).toEqual({ kind: 'ready' })
  })

  it('a connection whose endpoint is simply gone is disabled ("endpoint deleted")', () => {
    expect(rowStatuses([orphan], view).get('r-x')).toEqual({ kind: 'endpoint-deleted' })
    expect(defaultChecked([orphan], rowStatuses([orphan], view)).size).toBe(0)
  })

  it('the plan re-creates objects before the connections that need them', () => {
    const plan = planReapply([connRow, objRow], new Set(['r-c', 'r-o']), view, 'b')
    expect(plan.recreate.map((r) => r.collection)).toEqual(['objects', 'connections'])
  })
})

describe('the batch message', () => {
  it('is recognised by its id, never by value', () => {
    expect(isReapplyMessage(reapplyMessage('b-1'), 'b-1')).toBe(true)
    expect(isReapplyMessage(reapplyMessage('b-1'), 'b-2')).toBe(false)
    expect(isReapplyMessage('not json', 'b-1')).toBe(false)
  })
})

describe('fetchOverrides', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('with no actor of its own, a SIGNED-IN device still asks (the server adds the actors her other devices recorded); signed out it asks nothing', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ overrides: [{ id: 'r1' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchOverrides([])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(await fetchOverrides([], undefined, true)).toEqual([{ id: 'r1' }])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/api/model/epoch-overrides?')
  })
})
