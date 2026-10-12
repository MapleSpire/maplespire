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

import { beforeEach, describe, expect, it } from 'vitest'
import { useModelStore } from './modelStore'
import type { C4Object, Group } from '../types'

/**
 * `updateEntitiesBatch` exists so applying a copied style across a selection is
 * ONE store transaction.
 *
 * Per-target `updateObject` calls issue one `set()` each, and every store
 * notification re-runs the Automerge bridge's `detectEdits()`, which walks the
 * whole model — O(targets × model) inside a single mousedown. React's auto
 * batching hides it on the render side, so this is invisible on a small diagram
 * and in every component test; it only bites at scale. `gestureBatch.test.ts`
 * pins the same contract for a multi-shape drag.
 */

const object = (id: string): C4Object => ({
  id,
  type: 'app',
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 160, height: 90 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status: 'live',
  properties: {},
})

const group = (id: string, over: Partial<Group> = {}): Group => ({
  id,
  name: id,
  color: '#3B82F6',
  objectIds: [],
  tagAssignments: {},
  tagOrder: [],
  ...over,
})

beforeEach(() => {
  useModelStore.setState({
    objects: [object('a'), object('b'), object('c')],
    groups: [group('g1'), group('g2')],
    connections: [],
    diagrams: [],
    currentDiagramId: null,
    selectedItems: [],
  })
})

describe('updateEntitiesBatch', () => {
  it('notifies ONCE for a whole multi-entity copy', () => {
    let notifications = 0
    const unsubscribe = useModelStore.subscribe(() => { notifications += 1 })

    useModelStore.getState().updateEntitiesBatch({
      objects: [
        { id: 'a', data: { icon: 'Redis' } },
        { id: 'b', data: { icon: 'Redis' } },
        { id: 'c', data: { icon: 'Redis' } },
      ],
      groups: [{ id: 'g1', data: { color: '#111' } }],
    })
    unsubscribe()

    expect(notifications).toBe(1)
    expect(useModelStore.getState().objects.map((o) => o.icon)).toEqual(['Redis', 'Redis', 'Redis'])
    expect(useModelStore.getState().groups[0].color).toBe('#111')
  })

  it('CONTROL: the per-entity path notifies once PER entity', () => {
    // Without this the test above could pass on a store that batches nothing,
    // if zustand happened to coalesce. It does not.
    let notifications = 0
    const unsubscribe = useModelStore.subscribe(() => { notifications += 1 })

    const store = useModelStore.getState()
    store.updateObject('a', { icon: 'Redis' })
    store.updateObject('b', { icon: 'Redis' })
    store.updateObject('c', { icon: 'Redis' })
    unsubscribe()

    expect(notifications).toBe(3)
  })

  it('keeps the parent-wrapper sync that updateObject performs', () => {
    // The reason the batch routes through the SAME helper instead of a
    // hand-rolled writer: `updateObject` mirrors icon/name onto wrapper groups
    // whose `parentObjectId` is the object. A bulk writer that only assigned
    // fields would silently drop this, and nothing else would notice.
    useModelStore.setState({ groups: [group('w1', { parentObjectId: 'a' })] })

    useModelStore.getState().updateEntitiesBatch({
      objects: [{ id: 'a', data: { icon: 'Kafka', name: 'Renamed' } }],
    })

    const wrapper = useModelStore.getState().groups.find((g) => g.id === 'w1')!
    expect(wrapper.icon).toBe('Kafka')
    expect(wrapper.name).toBe('Renamed')
  })

  it('skips ids that no longer exist instead of throwing', () => {
    expect(() => useModelStore.getState().updateEntitiesBatch({
      objects: [{ id: 'gone', data: { icon: 'X' } }],
      groups: [{ id: 'also-gone', data: { color: '#000' } }],
    })).not.toThrow()
  })

  it('does not notify at all for an empty batch', () => {
    let notifications = 0
    const unsubscribe = useModelStore.subscribe(() => { notifications += 1 })

    useModelStore.getState().updateEntitiesBatch({ objects: [], groups: [] })
    unsubscribe()

    expect(notifications).toBe(0)
  })
})
