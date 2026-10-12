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
import type { C4Object, Group } from '../../types'
import {
  __resetTechnologyCanonicalIdsForTest,
  equivalentTechnologyIds,
  registerTechnologyCanonicalIds,
} from '../technologies/canonicalIds'
import { hasObjectOnlyFilter, matchesModelObjectFilter, matchesTechnologyFilter } from './modelObjectFilter'

const object = {
  id: 'o', type: 'app', name: 'Orders',
  tagAssignments: { 'tag-a': { tagId: 'tag-a' } }, tagOrder: ['tag-a'],
  scope: 'internal', status: 'live',
  description: 'Processes orders', properties: {}, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  ownerTeamIds: ['team-a'],
  technologyUsages: {
    angular: { id: 'u1', technologyId: 'tech-angular', catalogRevision: 3, snapshot: { name: 'Angular' } },
  },
} as unknown as C4Object

describe('model object facet contract', () => {
  beforeEach(() => __resetTechnologyCanonicalIdsForTest())
  it('ORs values within a facet', () => {
    expect(matchesModelObjectFilter(object, {
      statuses: ['planned', 'live'], tagIds: ['tag-z', 'tag-a'],
      teamIds: ['team-z', 'team-a'], technologyIds: ['tech-react', 'tech-angular'],
    })).toBe(true)
  })

  it('ANDs populated facets and compares governed identities rather than names', () => {
    expect(matchesModelObjectFilter(object, {
      statuses: ['live'], tagIds: ['tag-a'], teamIds: ['team-a'], technologyIds: ['tech-angular'],
    })).toBe(true)
    expect(matchesModelObjectFilter(object, {
      statuses: ['live'], tagIds: ['tag-a'], teamIds: ['team-a'], technologyIds: ['Angular'],
    })).toBe(false)
    expect(matchesModelObjectFilter(object, { statuses: ['retired'], technologyIds: ['tech-angular'] })).toBe(false)
  })

  it('treats Technology as an object-or-group facet', () => {
    const group = {
      id: 'group', name: 'Platform', color: '#888', objectIds: [], tagAssignments: {}, tagOrder: [],
      technologyUsages: {
        terraform: {
          id: 'terraform', technologyId: 'tech-terraform', catalogRevision: 2,
          snapshot: { schemaVersion: 1, name: 'Terraform', recommendedShapeTypes: ['group'] },
        },
      },
    } as Group

    expect(hasObjectOnlyFilter({ technologyIds: ['tech-terraform'] })).toBe(false)
    expect(matchesTechnologyFilter(group, ['tech-terraform'])).toBe(true)
    expect(matchesTechnologyFilter(group, ['tech-angular'])).toBe(false)
  })

  it('matches legacy Automerge usages against their canonical catalog identity', () => {
    registerTechnologyCanonicalIds([{
      id: 'tech-claude-ai',
      redirectedFromIds: ['tech-org-claude'],
    }])
    const legacyUsage = {
      ...object,
      technologyUsages: {
        claude: { id: 'u-claude', technologyId: 'tech-org-claude', catalogRevision: 1 },
      },
    } as unknown as C4Object

    expect(matchesTechnologyFilter(legacyUsage, ['tech-claude-ai'])).toBe(true)
    expect(equivalentTechnologyIds(['tech-claude-ai'])).toEqual(
      expect.arrayContaining(['tech-claude-ai', 'tech-org-claude']),
    )
  })
})
