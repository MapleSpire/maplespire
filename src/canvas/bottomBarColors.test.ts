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

/**
 * Bottom accent-bar color resolution — shared by the 2D engine
 * (renderObjectBottomBar) and the 3D board (Scene3D accent bars/bands).
 * Guards the "color by tags/technology/status" semantics both views rely on.
 */

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_TECH_COLORS,
  resolveGroupBottomBarColors,
  resolveObjectBottomBarColors,
  resolveTagColor,
  resolveTeamColor,
  resolveTechnologyColor,
} from './bottomBarColors'
import type { C4Object, Tag } from '../types'
import type { SkinConfig } from '../skins/types'
import { seededTechnologyUsages } from '../lib/technologyUsage'

const TAGS: Tag[] = [
  { tagId: 't1', value: 'core', color: '#111111', groupId: 'g', groupName: 'Test', catalogRevision: 1 },
  { tagId: 't2', value: 'edge', color: '#222222', groupId: 'g', groupName: 'Test', catalogRevision: 1 },
  { tagId: 't3', value: 'legacy', color: '#333333', groupId: 'other', groupName: 'Other', catalogRevision: 1 },
]

const skinWith = (bottomBar: Partial<SkinConfig['bottomBar']>): SkinConfig =>
  ({
    bottomBar: {
      height: 6,
      cornerRadius: 10,
      opacity: 1,
      technology: {},
      status: { live: '#10B981', draft: '#F59E0B', down: '#EF4444', unstable: '#8B5CF6' },
      tagColorMode: 'original',
      tagColors: [],
      ...bottomBar,
    },
  }) as unknown as SkinConfig

const obj = (over: Partial<C4Object>): C4Object =>
  ({ id: 'o1', tagAssignments: {}, tagOrder: [], ...over }) as unknown as C4Object
const assigned = (...tagOrder: string[]): Pick<C4Object, 'tagAssignments' | 'tagOrder'> => ({
  tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
  tagOrder,
})

describe('resolveTagColor', () => {
  it('returns the tag own color in original mode', () => {
    expect(resolveTagColor('t2', TAGS, skinWith({}))).toBe('#222222')
  })

  it('cycles the themed palette by registry order in theme mode', () => {
    const skin = skinWith({ tagColorMode: 'theme', tagColors: ['#AAA111', '#BBB222'] })
    expect(resolveTagColor('t1', TAGS, skin)).toBe('#AAA111')
    expect(resolveTagColor('t2', TAGS, skin)).toBe('#BBB222')
    expect(resolveTagColor('t3', TAGS, skin)).toBe('#AAA111') // wraps
  })

  it('falls back to the tag color when the theme palette is empty', () => {
    expect(resolveTagColor('t1', TAGS, skinWith({ tagColorMode: 'theme' }))).toBe('#111111')
  })

  it('returns null for a name missing from the registry', () => {
    expect(resolveTagColor('nope', TAGS, skinWith({}))).toBeNull()
  })
})

describe('resolveObjectBottomBarColors', () => {
  it('returns nothing when no tab is active', () => {
    expect(resolveObjectBottomBarColors(obj(assigned('t1')), TAGS, skinWith({}), null)).toEqual([])
  })

  it('tags: one segment per resolvable tag, in tag order', () => {
    const colors = resolveObjectBottomBarColors(
      obj(assigned('t2', 'ghost', 't1')),
      TAGS,
      skinWith({}),
      'tags',
    )
    expect(colors).toEqual(['#222222', '#111111'])
  })

  it('tags: renders only values from the active governed Group', () => {
    expect(resolveObjectBottomBarColors(
      obj(assigned('t1', 't3', 't2')),
      TAGS,
      skinWith({}),
      'tags',
      'g',
    )).toEqual(['#111111', '#222222'])
  })

  it('technology: skin map wins over the brand fallback', () => {
    const skin = skinWith({ technology: { PostgreSQL: '#ABCDEF' } })
    const o = obj({ technologyUsages: seededTechnologyUsages('o1', ['PostgreSQL']) })
    expect(resolveObjectBottomBarColors(o, TAGS, skin, 'technology')).toEqual(['#ABCDEF'])
  })

  it('technology: every governed technology gets an accent color', () => {
    const o = obj({ technologyUsages: seededTechnologyUsages('o1', ['PostgreSQL']) })
    expect(resolveObjectBottomBarColors(o, TAGS, skinWith({}), 'technology')).toEqual([
      FALLBACK_TECH_COLORS['PostgreSQL'],
    ])
    const unknown = obj({ technologyUsages: seededTechnologyUsages('o1', ['FortranWeb']) })
    expect(resolveObjectBottomBarColors(unknown, TAGS, skinWith({}), 'technology')).toEqual([
      resolveTechnologyColor('FortranWeb', skinWith({})),
    ])
  })

  it('status: maps each status to the skin color, none without a status', () => {
    const skin = skinWith({})
    for (const [status, color] of [
      ['live', '#10B981'],
      ['draft', '#F59E0B'],
      ['down', '#EF4444'],
      ['unstable', '#8B5CF6'],
    ] as const) {
      expect(resolveObjectBottomBarColors(obj({ status }), TAGS, skin, 'status')).toEqual([color])
    }
    expect(resolveObjectBottomBarColors(obj({}), TAGS, skin, 'status')).toEqual([])
  })

  it('teams: colors both governed teams and saved people', () => {
    const o = obj({
      ownerTeamIds: ['team-platform'],
      ownerAssignments: {
        'team-platform': { id: 'team-platform', kind: 'team', source: 'platform', name: 'Platform', catalogId: 'team-platform' },
        'user:alice': { id: 'user:alice', kind: 'person', source: 'platform', name: 'Alice', catalogId: 'alice' },
      },
      ownerAssignmentOrder: ['team-platform', 'user:alice'],
    })
    expect(resolveObjectBottomBarColors(o, TAGS, skinWith({}), 'teams')).toEqual([
      resolveTeamColor('team-platform'),
      resolveTeamColor('user:alice'),
    ])
  })

  it('teams: resolves stable deduplicated colors from governed team IDs', () => {
    const colors = resolveObjectBottomBarColors(
      obj({ ownerTeamIds: ['team-a'], teamIds: ['team-a', 'team-b'] }),
      TAGS,
      skinWith({}),
      'teams',
    )
    expect(colors).toEqual([resolveTeamColor('team-a'), resolveTeamColor('team-b')])
    expect(resolveTeamColor('team-a')).toBe(resolveTeamColor('team-a'))
  })
})

describe('resolveGroupBottomBarColors', () => {
  const members = [obj({ id: 'a', ...assigned('t1', 't2') }), obj({ id: 'b', ...assigned('t2', 't3') })]

  it('dedupes member tag colors preserving first-seen order (tags mode)', () => {
    expect(resolveGroupBottomBarColors(members, TAGS, skinWith({}), 'tags')).toEqual([
      '#111111',
      '#222222',
      '#333333',
    ])
  })

  it('limits group colors to the active governed Group', () => {
    expect(resolveGroupBottomBarColors(members, TAGS, skinWith({}), 'tags', 'g')).toEqual([
      '#111111',
      '#222222',
    ])
  })

  it('draws nothing for the other tabs', () => {
    expect(resolveGroupBottomBarColors(members, TAGS, skinWith({}), 'technology')).toEqual([])
    expect(resolveGroupBottomBarColors(members, TAGS, skinWith({}), 'status')).toEqual([])
    expect(resolveGroupBottomBarColors(members, TAGS, skinWith({}), null)).toEqual([])
  })

  it('aggregates team ownership across group members', () => {
    const teamMembers = [
      obj({ id: 'a', ownerTeamIds: ['team-a'] }),
      obj({ id: 'b', ownerTeamIds: ['team-a', 'team-b'] }),
    ]
    expect(resolveGroupBottomBarColors(teamMembers, TAGS, skinWith({}), 'teams')).toEqual([
      resolveTeamColor('team-a'),
      resolveTeamColor('team-b'),
    ])
  })
})
