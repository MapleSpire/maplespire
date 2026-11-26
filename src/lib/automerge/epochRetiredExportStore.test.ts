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

import { describe, expect, it, vi } from 'vitest'
import type { RetiredExport } from './epochRetiredDiff'
import { collectRetiredDifferences } from './epochRetiredDiff'

vi.mock('../modelQuery/kvStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modelQuery/kvStore')>()
  const store = actual.createMemoryKvStore()
  return { ...actual, workspaceKvStore: () => store }
})

const { loadRetiredExport, mergeRetiredExports, persistRetiredExport, removeRetiredExportLines, RETIRED_EXPORT_KEY } = await import('./epochRetiredExportStore')
const { workspaceKvStore } = await import('../modelQuery/kvStore')

const exported = (lines: Array<[string, string]>, at = 'then'): RetiredExport => ({
  version: 1, metaUrl: `automerge:${at}`, collectedAt: at,
  differences: lines.map(([id, name]) => ({ kind: 'object', id, local: { name }, current: null })),
})

describe('the persisted retired export', () => {
  it('merges one line per entity, the one shown FIRST kept, its date and meta kept', () => {
    const merged = mergeRetiredExports(exported([['o1', 'first'], ['o2', 'two']], 'a'), exported([['o1', 'later'], ['o3', 'three']], 'b'))
    expect(merged.differences.map((d) => [d.id, (d.local as { name: string }).name])).toEqual([['o1', 'first'], ['o2', 'two'], ['o3', 'three']])
    expect(merged.collectedAt).toBe('a')
    expect(merged.metaUrl).toBe('automerge:a')
    expect(mergeRetiredExports(null, exported([['o1', 'x']], 'b')).collectedAt).toBe('b')
  })

  it('persists merged with what an earlier session left, reads it back, clears it', async () => {
    expect(await loadRetiredExport()).toBeNull()
    await persistRetiredExport(exported([['o1', 'first']], 'a'))
    const merged = await persistRetiredExport(exported([['o1', 'later'], ['o2', 'two']], 'b'))
    expect(merged.differences.map((d) => d.id)).toEqual(['o1', 'o2'])
    expect((await loadRetiredExport())?.differences.map((d) => (d.local as { name: string }).name)).toEqual(['first', 'two'])
    await removeRetiredExportLines(merged)
    expect(await loadRetiredExport()).toBeNull()
    // Garbage under the key is not an export.
    await workspaceKvStore().set(RETIRED_EXPORT_KEY, { nope: true })
    expect(await loadRetiredExport()).toBeNull()
  })

  it('two tabs — tab B merges E2 while tab A shows E1; A\'s "×" removes E1\'s lines only, E2 stays for the next boot', async () => {
    await workspaceKvStore().del(RETIRED_EXPORT_KEY)
    const shownInA = await persistRetiredExport(exported([['o1', 'one']], 'a'))
    await persistRetiredExport(exported([['o2', 'two']], 'b')) // tab B
    await removeRetiredExportLines(shownInA)
    expect((await loadRetiredExport())?.differences.map((d) => d.id)).toEqual(['o2'])
  })

  it('an emptied export is not loaded as one', async () => {
    await workspaceKvStore().set(RETIRED_EXPORT_KEY, exported([], 'empty'))
    expect(await loadRetiredExport()).toBeNull()
  })
})

describe('collectRetiredDifferences with the current shards UNKNOWN (boot-from-server)', () => {
  it('lists every object and connection of the retired shards as not compared — never "absent from the new epoch"', () => {
    const lines = collectRetiredDifferences({
      retiredObjectShards: [{ objects: { o1: { name: 'A' } } }],
      retiredConnectionShards: [{ connections: { c1: { fromId: 'o1' } } }],
      current: { objects: { o1: { name: 'A' } }, connections: {} },
      currentShardsUnknown: true,
    })
    expect(lines).toEqual([
      { kind: 'object', id: 'o1', local: { name: 'A' }, current: null, currentUnknown: true },
      { kind: 'connection', id: 'c1', local: { fromId: 'o1' }, current: null, currentUnknown: true },
    ])
    // Known: an equal value is no line.
    expect(collectRetiredDifferences({
      retiredObjectShards: [{ objects: { o1: { name: 'A' } } }], retiredConnectionShards: [],
      current: { objects: { o1: { name: 'A' } }, connections: {} },
    })).toEqual([])
  })
})
