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
import type { C4Object, Connection, Group } from '../types'

/**
 * G4-16f: the batch re-apply re-creates entities the current epoch
 * deleted. An id that exists is never duplicated nor overwritten; a
 * connection may end on a GROUP and is restored with it.
 */
const obj = (id: string, name = id): C4Object => ({
  id, type: 'app', name, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})
const grp = (id: string): Group => ({
  id, name: id, objectIds: [], color: '#000000', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
  tagAssignments: {}, tagOrder: [],
})
const conn = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid' })

beforeEach(() => {
  useModelStore.setState({
    objects: [obj('kept', 'Theirs')], connections: [], groups: [], diagrams: [], domains: [], flows: [],
    currentDiagramId: null, selectedItems: [],
    pendingDeletedObjectIds: ['gone'], pendingDeletedConnectionIds: ['c-g'], pendingDeletedGroupIds: ['g'],
  })
})

describe('restoreDeletedEntities', () => {
  it('an id that EXISTS is neither duplicated nor overwritten', () => {
    useModelStore.getState().restoreDeletedEntities({ objects: [obj('kept', 'Mine'), obj('gone')] })
    const s = useModelStore.getState()
    expect(s.objects.filter((o) => o.id === 'kept')).toEqual([expect.objectContaining({ name: 'Theirs' })])
    expect(s.objects.map((o) => o.id)).toEqual(['kept', 'gone'])
    expect(s.pendingDeletedObjectIds).toEqual([])
  })

  it('a connection to a re-created GROUP is restored with it; one to a missing endpoint is not', () => {
    useModelStore.getState().restoreDeletedEntities({
      groups: [grp('g')],
      connections: [conn('c-g', 'kept', 'g'), conn('c-x', 'kept', 'nowhere')],
    })
    const s = useModelStore.getState()
    expect(s.groups.map((g) => g.id)).toEqual(['g'])
    expect(s.connections.map((c) => c.id)).toEqual(['c-g'])
    expect(s.pendingDeletedGroupIds).toEqual([])
    expect(s.pendingDeletedConnectionIds).toEqual([])
  })
})
