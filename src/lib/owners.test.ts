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
import type { C4Object, OwnerAssignment } from '../types'
import { assignOwner, orderedOwnerAssignments, removeOwner } from './owners'

const team: OwnerAssignment = {
  id: 'team-platform',
  kind: 'team',
  source: 'platform',
  catalogId: 'team-platform',
  name: 'Platform',
}

describe('shape owners', () => {
  it('keeps stable assignment order and projects governed teams for legacy filters', () => {
    const assigned = assignOwner({ ownerTeamIds: ['team-legacy'] }, team)
    expect(assigned.ownerAssignmentOrder).toEqual(['team-platform'])
    expect(assigned.ownerTeamIds).toEqual(['team-legacy', 'team-platform'])
    expect(orderedOwnerAssignments(assigned).map((owner) => owner.name)).toEqual([
      'Platform',
      'team-legacy',
    ])
  })

  it('removes only the selected owner and its governed team projection', () => {
    const carrier: Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'> = {
      ownerAssignments: { [team.id]: team },
      ownerAssignmentOrder: [team.id],
      ownerTeamIds: ['team-platform', 'team-associated'],
    }
    expect(removeOwner(carrier, team.id)).toEqual({
      ownerAssignments: {},
      ownerAssignmentOrder: [],
      ownerTeamIds: ['team-associated'],
    })
  })
})
