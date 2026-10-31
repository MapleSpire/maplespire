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
import { mergeDiagramDocOverRow, mergeRegistryMetaOverRow } from './staticDeltaProjector.js'

describe('mergeDiagramDocOverRow (static DiagramDoc projection)', () => {
  const row = { id: 'd1', name: 'Old', docUrl: 'automerge:abc', objectScopes: { bank: 'external' } }

  it('lets the doc win and keeps registry-only fields the doc does not carry', () => {
    const merged = mergeDiagramDocOverRow(row, { id: 'd1', name: 'New', objectScopes: { web: 'internal' } }, 'd1')
    expect(merged).toMatchObject({ name: 'New', docUrl: 'automerge:abc', objectScopes: { web: 'internal' } })
  })

  it('drops the row\'s overrides when the doc has cleared them (absent key)', () => {
    const merged = mergeDiagramDocOverRow(row, { id: 'd1', name: 'Old', objectIds: ['bank'] }, 'd1')
    expect(merged).not.toHaveProperty('objectScopes')
    expect(merged.docUrl).toBe('automerge:abc')
  })

  it('pins the id to the descriptor\'s entity, not the document body', () => {
    expect(mergeDiagramDocOverRow(undefined, { id: 'other' }, 'd1').id).toBe('d1')
  })
})

describe('mergeRegistryMetaOverRow (static registry-shard projection)', () => {
  it('never lets a stale meta copy resurrect an override the doc projection cleared', () => {
    // 1. AI tool set bank external: doc + stub carry it. 2. The user cleared it
    // in the browser: only the doc changed, and its projection dropped it.
    const afterDocClear = mergeDiagramDocOverRow(
      { id: 'd1', name: 'D', docUrl: 'automerge:abc', objectScopes: { bank: 'external' } },
      { id: 'd1', name: 'D' }, 'd1',
    )
    // 3. A sibling in the same shard is renamed: the shard re-projects D's stale meta.
    const staleMeta = { id: 'd1', name: 'D', docUrl: 'automerge:abc', objectScopes: { bank: 'external' } }
    expect(mergeRegistryMetaOverRow(afterDocClear, staleMeta)).not.toHaveProperty('objectScopes')
  })

  it('keeps the doc-projected overrides and still takes every other meta field', () => {
    const row = { id: 'd1', name: 'Old', objectScopes: { web: 'internal' } }
    const merged = mergeRegistryMetaOverRow(row, { id: 'd1', name: 'Renamed', objectScopes: { web: 'external' } })
    expect(merged).toMatchObject({ name: 'Renamed', objectScopes: { web: 'internal' } })
  })
})
