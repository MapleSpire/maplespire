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
 * The PRODUCERS of the change log, driven for real: every other test of the
 * log calls `notifyModelIndexChanged` itself, so deleting the ids at the two
 * index writers left every suite green (QA lens, review 3). Without them every
 * local edit reaches an inline expansion as "unknown" and re-reads every
 * expanded target on the slow lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Connection } from '../../types'

vi.mock('./flag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./flag')>()),
  isModelPagingEnabled: () => true,
}))
const kv = vi.hoisted(() => ({ store: null as unknown }))
vi.mock('./kvStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kvStore')>()
  return { ...actual, workspaceKvStore: () => (kv.store ??= actual.createMemoryKvStore()) }
})

const {
  __resetModelIndexVersionForTest,
  applyOffWindowEditsToIndex,
  modelIndexChangesSince,
  notifyModelIndexChanged,
  resetModelIndexSync,
  syncModelIndex,
  useModelIndexVersion,
} = await import('./indexSync')

const obj = (id: string, name = id): C4Object => ({ id, name, type: 'container', scope: 'internal' } as unknown as C4Object)
const conn = (id: string): Connection => ({ id, fromId: 'o1', toId: 'o2' } as Connection)
const version = () => useModelIndexVersion.getState().version

beforeEach(() => {
  kv.store = null
  resetModelIndexSync()
  __resetModelIndexVersionForTest()
})

describe('model index change log — its producers', () => {
  it('syncModelIndex: a first build is unknown, a delta names exactly what it touched', async () => {
    const o2 = obj('o2')
    const c1 = conn('c1')
    syncModelIndex({ objects: [obj('o1'), o2], connections: [c1], groups: [] })
    await vi.waitFor(() => expect(version()).toBe(1))
    expect(modelIndexChangesSince(0), 'a first build touches everything').toBeNull()

    syncModelIndex({ objects: [obj('o1', 'Renamed'), o2], connections: [c1], groups: [] })
    await vi.waitFor(() => expect(version()).toBe(2))
    expect(modelIndexChangesSince(1)).toEqual({ objectIds: ['o1'], connectionIds: [] })
  })

  it('applyOffWindowEditsToIndex names the edited and deleted ids', async () => {
    applyOffWindowEditsToIndex([obj('o3', 'Edited')], [], [], ['c9'])
    await vi.waitFor(() => expect(version()).toBe(1))
    expect(modelIndexChangesSince(0)).toEqual({ objectIds: ['o3'], connectionIds: ['c9'] })
  })
})

// The bound is a literal: a test that only overflows it by a margin agrees
// with any limit below that margin.
describe('model index change log — its bound', () => {
  it('reaches back exactly 64 revisions', () => {
    for (let i = 0; i < 64; i++) notifyModelIndexChanged({ objectIds: [`o${i}`], connectionIds: [] })
    expect(modelIndexChangesSince(0)?.objectIds).toHaveLength(64)
    notifyModelIndexChanged({ objectIds: ['o64'], connectionIds: [] })
    expect(modelIndexChangesSince(0), 'the 65th revision pushed the first out').toBeNull()
    expect(modelIndexChangesSince(1)?.objectIds).toHaveLength(64)
  })
})
