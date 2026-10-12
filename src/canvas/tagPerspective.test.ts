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
import type { C4Object, Tag } from '../types'
import {
  resolveConnectionPerspectiveTag,
  resolveHiddenTagState,
  resolvePinnedTagPresentation,
  resolveTagFocusMembership,
} from './tagPerspective'

const tags: Tag[] = [
  { tagId: 'risk-high', value: 'High', color: '#b42318', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 },
  { tagId: 'risk-low', value: 'Low', color: '#067647', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 },
  { tagId: 'region-ca', value: 'Canada', color: '#175cd3', groupId: 'region', groupName: 'Region', catalogRevision: 1 },
  { tagId: 'risk-mid', value: 'Medium', color: '#b54708', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 },
]

const entity = (...tagOrder: string[]): Pick<C4Object, 'tagAssignments' | 'tagOrder'> => ({
  tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
  tagOrder,
})

describe('Tag perspective semantics', () => {
  it('uses the latest matching pin for the outline and assignment order for labels', () => {
    const result = resolvePinnedTagPresentation(
      entity('risk-high', 'risk-low', 'risk-mid', 'region-ca'),
      tags,
      ['risk-mid', 'region-ca', 'risk-high', 'risk-low'],
    )
    expect(result.outline?.tagId).toBe('risk-low')
    expect(result.labels.map((tag) => tag.tagId)).toEqual(['risk-high', 'risk-low', 'risk-mid'])
    expect(result.overflowCount).toBe(1)
  })

  it('reveals only an entity carrying the hovered hidden Tag', () => {
    const hidden = new Set(['risk-high', 'region-ca'])
    expect(resolveHiddenTagState(entity('risk-high'), hidden, 'risk-high')).toEqual({
      hidden: false,
      temporarilyRevealed: true,
    })
    expect(resolveHiddenTagState(entity('region-ca'), hidden, 'risk-high')).toEqual({
      hidden: true,
      temporarilyRevealed: false,
    })
  })

  it('keeps connections neutral until a Tag is hovered or focused', () => {
    const from = entity('region-ca', 'risk-low')
    const to = entity('risk-high')
    expect(resolveConnectionPerspectiveTag(from, to, tags, 'risk', {
      hoveredTagId: null,
      focusedTagId: null,
      pinnedTagIds: ['risk-low'],
    })).toBeNull()
    expect(resolveConnectionPerspectiveTag(from, to, tags, 'risk', {
      hoveredTagId: null,
      focusedTagId: 'risk-low',
      pinnedTagIds: [],
    })?.tagId).toBe('risk-low')
    expect(resolveConnectionPerspectiveTag(from, to, tags, 'risk', {
      hoveredTagId: 'risk-high',
      focusedTagId: null,
      pinnedTagIds: [],
    })?.tagId).toBe('risk-high')
  })

  it('resolves a tag carried directly by the connection', () => {
    expect(resolveConnectionPerspectiveTag(entity(), entity(), tags, 'risk', {
      hoveredTagId: 'risk-high',
      focusedTagId: null,
      pinnedTagIds: [],
    }, entity('risk-high'))?.tagId).toBe('risk-high')
  })

  it('keeps focused objects and their direct object neighbours', () => {
    const result = resolveTagFocusMembership(
      [
        { id: 'a', ...entity('risk-high') },
        { id: 'b', ...entity() },
        { id: 'c', ...entity() },
      ],
      [{ fromId: 'a', toId: 'b' }, { fromId: 'group-1', toId: 'c' }],
      tags,
      'risk-high',
    )

    expect(result.resolved).toBe(true)
    expect([...result.matchingObjectIds]).toEqual(['a'])
    expect([...result.connectedObjectIds]).toEqual(['b'])
  })

  it('does not hide the scene when the focused id is absent locally', () => {
    const result = resolveTagFocusMembership(
      [{ id: 'a', ...entity('risk-high') }],
      [],
      tags,
      'not-in-snapshot',
    )
    expect(result.resolved).toBe(false)
    expect(result.matchingObjectIds.size).toBe(0)
  })

  it('keeps partially hydrated entities safe until assignment containers arrive', () => {
    const partial = {} as Pick<C4Object, 'tagAssignments' | 'tagOrder'>
    expect(resolvePinnedTagPresentation(partial, tags, ['risk-high'])).toEqual({
      outline: null,
      labels: [],
      overflowCount: 0,
    })
    expect(resolveHiddenTagState(partial, new Set(['risk-high']), 'risk-high')).toEqual({
      hidden: false,
      temporarilyRevealed: false,
    })
  })
})
