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
import { assignTag, orderedTagIds, referencedTagSnapshots, unassignTag, type TagAssignable } from './assignments'

describe('stable Tag assignments during selective hydration', () => {
  it('treats missing CRDT containers as an empty assignment set', () => {
    expect(orderedTagIds({})).toEqual([])
    expect(referencedTagSnapshots([{}], [{ tagId: 'risk', value: 'Risk', color: '#FF0000', groupId: 'g', groupName: 'G', catalogRevision: 1 }])).toEqual([])
  })

  it('initializes missing containers before assigning or unassigning', () => {
    const entity: TagAssignable = {}
    assignTag(entity, 'risk')
    expect(entity).toEqual({ tagAssignments: { risk: { tagId: 'risk' } }, tagOrder: ['risk'] })
    unassignTag(entity, 'risk')
    expect(entity).toEqual({ tagAssignments: {}, tagOrder: [] })
  })
})
