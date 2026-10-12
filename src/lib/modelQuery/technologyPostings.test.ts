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
  createMemoryTechnologyPostingsStore, recoverTechnologyPostingsIfNeeded,
  TECHNOLOGY_POSTINGS_DIRTY_KEY, technologyPostingsFor,
} from './technologyPostings'

const object = (id: string, technologyIds: string[]): C4Object => ({
  id, type: 'app', name: id, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  technologyUsages: Object.fromEntries(technologyIds.map((technologyId, index) => [
    `u${index}`, { id: `u${index}`, technologyId, catalogRevision: 1, snapshot: { name: technologyId } },
  ])),
} as unknown as C4Object)

const group = (id: string, technologyIds: string[]): Group => ({
  id, name: id, color: '#888888', objectIds: [], tagAssignments: {}, tagOrder: [],
  technologyUsages: Object.fromEntries(technologyIds.map((technologyId, index) => [
    `u${index}`, { id: `u${index}`, technologyId, catalogRevision: 2, snapshot: { schemaVersion: 1, name: technologyId } },
  ])),
})

describe('technology postings', () => {
  it('uses OR semantics and atomically replaces stale object postings', async () => {
    const store = createMemoryTechnologyPostingsStore()
    await store.rebuild([object('a', ['angular']), object('b', ['react']), object('c', ['angular', 'postgres'])])
    expect(new Set(await store.entityIdsForTechnologies(['react', 'postgres']))).toEqual(new Set(['b', 'c']))
    expect(await store.entityCount()).toBe(3)

    await store.applyEntityDelta([object('a', ['vue'])], ['b'], -1)
    expect(await store.entityIdsForTechnologies(['angular'])).toEqual(['c'])
    expect(await store.entityIdsForTechnologies(['vue'])).toEqual(['a'])
    expect(await store.entityIdsForTechnologies(['react'])).toEqual([])
    expect(await store.entityCount()).toBe(2)
  })

  it('selects sparse matches from 50k objects without needing an object scan', async () => {
    const store = createMemoryTechnologyPostingsStore()
    const objects = Array.from({ length: 50_000 }, (_, index) =>
      object(`o-${index}`, index % 10_000 === 0 ? ['target'] : ['other']))
    await store.rebuild(objects)
    expect(await store.entityIdsForTechnologies(['target'])).toEqual([
      'o-0', 'o-10000', 'o-20000', 'o-30000', 'o-40000',
    ])
  })

  it('repairs a delta interrupted between the flat index and postings on warm boot', async () => {
    const kv = createMemoryKvStore()
    const postings = technologyPostingsFor(kv)
    await postings.rebuild([object('a', ['angular'])])

    // Simulate a crash after the model record changed but before posting commit.
    await kv.set('o:a', object('a', ['vue']))
    await kv.set(TECHNOLOGY_POSTINGS_DIRTY_KEY, true)
    expect(await recoverTechnologyPostingsIfNeeded(kv)).toBe(true)
    expect(await postings.entityIdsForTechnologies(['angular'])).toEqual([])
    expect(await postings.entityIdsForTechnologies(['vue'])).toEqual(['a'])
    expect(await kv.get(TECHNOLOGY_POSTINGS_DIRTY_KEY)).toBeUndefined()
  })

  it('builds postings for an older warm index even without a dirty marker', async () => {
    const kv = createMemoryKvStore()
    await kv.set('o:a', object('a', ['angular']))

    expect(await technologyPostingsFor(kv).isBuilt()).toBe(false)
    expect(await recoverTechnologyPostingsIfNeeded(kv)).toBe(true)
    expect(await technologyPostingsFor(kv).isBuilt()).toBe(true)
    expect(await technologyPostingsFor(kv).entityIdsForTechnologies(['angular'])).toEqual(['a'])
  })

  it('indexes and incrementally replaces group technology usages', async () => {
    const store = createMemoryTechnologyPostingsStore()
    await store.rebuild([object('app', ['angular']), group('platform-group', ['terraform'])])
    expect(await store.entityIdsForTechnologies(['terraform'])).toEqual(['platform-group'])
    expect(await store.entityCount()).toBe(2)

    await store.applyEntityDelta([group('platform-group', ['docker'])], [], 0)
    expect(await store.entityIdsForTechnologies(['terraform'])).toEqual([])
    expect(await store.entityIdsForTechnologies(['docker'])).toEqual(['platform-group'])
  })
})
