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
import { createTechnologyUsage } from '../lib/technologyUsage'
import type { Group } from '../types'
import { useModelStore } from './modelStore'

const postgres = createTechnologyUsage({
  id: 'usage-postgres',
  name: 'PostgreSQL',
  technologyId: 'tech-postgresql',
  recommendedShapeTypes: ['store'],
  defaultRole: 'database',
})

function group(): Group {
  return {
    id: 'group-1',
    name: 'Data platform',
    color: '#888888',
    objectIds: [],
    tagAssignments: {},
    tagOrder: [],
    technologyUsages: { [postgres.id]: postgres },
  }
}

describe('group technology usages', () => {
  beforeEach(() => useModelStore.setState({ groups: [group()] }))

  it('keeps catalog identity immutable while allowing a per-group role override', () => {
    useModelStore.getState().updateGroup('group-1', {
      technologyUsages: {
        [postgres.id]: { ...postgres, role: 'storage' },
      },
    })
    expect(useModelStore.getState().groups[0].technologyUsages?.[postgres.id].role).toBe('storage')

    expect(() => useModelStore.getState().updateGroup('group-1', {
      technologyUsages: {
        [postgres.id]: {
          ...postgres,
          snapshot: { ...postgres.snapshot, recommendedShapeTypes: ['group'] },
        },
      },
    })).toThrow(/immutable/)
  })
})
