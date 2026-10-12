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
import type { C4Object, Group } from '../../types'
import { createMemoryKvStore } from './kvStore'
import {
  createMemoryTagPostingsStore, recoverTagPostingsIfNeeded,
  TAG_POSTINGS_DIRTY_KEY, tagPostingsFor, tagPostingsForEntity,
} from './tagPostings'

const object = (id: string, tagIds: string[]): C4Object => ({
  id, type: 'app', name: id, scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  tagAssignments: Object.fromEntries(tagIds.map((tagId) => [tagId, { tagId }])),
  tagOrder: tagIds,
} as C4Object)

const group = (id: string, tagIds: string[]): Group => ({
  id, name: id, color: '#888888', objectIds: [],
  tagAssignments: Object.fromEntries(tagIds.map((tagId) => [tagId, { tagId }])),
  tagOrder: tagIds,
})

describe('Tag postings', () => {
  it('preserves functional order and repairs incomplete CRDT order', () => {
    const entity = object('a', ['risk', 'region'])
    entity.tagOrder = ['region', 'region']
    expect(tagPostingsForEntity(entity)).toEqual([
      { entityId: 'a', entityKind: 'object', tagId: 'region', ordinal: 0 },
      { entityId: 'a', entityKind: 'object', tagId: 'risk', ordinal: 1 },
    ])
  })

  it('uses OR semantics and atomically replaces stale object and group postings', async () => {
    const store = createMemoryTagPostingsStore()
    await store.rebuild([
      object('a', ['risk-high']), object('b', ['region-eu']),
      group('platform', ['risk-high', 'region-us']),
    ])
    expect(new Set(await store.entityIdsForTags(['region-eu', 'region-us']))).toEqual(new Set(['b', 'platform']))
    await store.applyEntityDelta([object('a', ['risk-low'])], ['b'], -1)
    expect(await store.entityIdsForTags(['risk-high'])).toEqual(['platform'])
    expect(await store.entityIdsForTags(['risk-low'])).toEqual(['a'])
    expect(await store.entityCount()).toBe(2)
  })

  it('selects sparse matches from 50k objects without an object scan', async () => {
    const store = createMemoryTagPostingsStore()
    const objects = Array.from({ length: 50_000 }, (_, index) =>
      object(`o-${index}`, index % 10_000 === 0 ? ['target'] : ['other']))
    await store.rebuild(objects)
    expect(await store.entityIdsForTags(['target'])).toEqual([
      'o-0', 'o-10000', 'o-20000', 'o-30000', 'o-40000',
    ])
  })

  it('repairs an interrupted delta and creates postings for an older warm index', async () => {
    const kv = createMemoryKvStore()
    const postings = tagPostingsFor(kv)
    await postings.rebuild([object('a', ['risk-high'])])
    await kv.set('o:a', object('a', ['risk-low']))
    await kv.set(TAG_POSTINGS_DIRTY_KEY, true)
    expect(await recoverTagPostingsIfNeeded(kv)).toBe(true)
    expect(await postings.entityIdsForTags(['risk-high'])).toEqual([])
    expect(await postings.entityIdsForTags(['risk-low'])).toEqual(['a'])
    expect(await kv.get(TAG_POSTINGS_DIRTY_KEY)).toBeUndefined()

    const older = createMemoryKvStore()
    await older.set('o:b', object('b', ['region-eu']))
    expect(await recoverTagPostingsIfNeeded(older)).toBe(true)
    expect(await tagPostingsFor(older).entityIdsForTags(['region-eu'])).toEqual(['b'])
  })
})
