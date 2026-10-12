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
import type { C4Object, Connection } from '../../types'
import { EMPTY_VIEWER_WINDOW, mergeViewerLevelWindow } from './viewerWindow'

const object = (id: string): C4Object => ({
  id, name: id, type: 'app', description: '',
  position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})
const connection = (id: string): Connection => ({ id, fromId: 'a', toId: 'b', label: id, type: 'solid' })

describe('mergeViewerLevelWindow', () => {
  it('uses the next cursor and deduplicates overlapping renderer windows', () => {
    const first = mergeViewerLevelWindow(EMPTY_VIEWER_WINDOW, {
      ancestors: [], objects: [{ object: object('a'), childCount: 1 }], connections: [],
      nextCursor: 'page-2', totalObjects: 2, connectionsTruncated: false,
      projectionGeneration: 1, coverage: 'full',
    }, false)
    const second = mergeViewerLevelWindow(first, {
      ancestors: [],
      objects: [{ object: { ...object('a'), name: 'new a' }, childCount: 1 }, { object: object('b'), childCount: 0 }],
      connections: [connection('c1')], nextCursor: null, totalObjects: 2,
      connectionsTruncated: false, projectionGeneration: 2, coverage: 'full',
    }, true)

    expect(second.objects.map(({ object: item }) => item.id)).toEqual(['a', 'b'])
    expect(second.objects[0].object.name).toBe('new a')
    expect(second.nextCursor).toBeNull()
    expect(second.connectionsTruncated).toBe(true)
  })
})
