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
import { isActionableRef, lookupFromArray, lookupFromMap, refLabel, resolveRef } from './resolve'

interface Row { id: string; name: string }

const rows: Row[] = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: '  ' }]

describe('resolveRef', () => {
  it('reports a resident target as live and hands it back', () => {
    const r = resolveRef('a', lookupFromArray(rows, { complete: true }))
    expect(r).toEqual({ state: 'live', target: rows[0] })
  })

  it('reports a miss as dangling ONLY when the collection is complete', () => {
    expect(resolveRef('gone', lookupFromArray(rows, { complete: true })).state).toBe('dangling')
  })

  it('NEVER answers dangling on a miss when the collection is windowed', () => {
    // The rule the whole module exists for. A bounded ADR page or a one-entry
    // server registry summary cannot tell deleted from not-loaded, and calling
    // it dangling marks healthy links broken.
    expect(resolveRef('gone', lookupFromArray(rows, { complete: false })).state).toBe('unknown')
  })

  it('lets a tombstone prove death even in a windowed collection', () => {
    // The only way a windowed client gets to say dangling at all.
    const lookup = lookupFromArray(rows, { complete: false, deleted: new Set(['gone']) })
    expect(resolveRef('gone', lookup).state).toBe('dangling')
  })

  it('trusts the tombstone over a stale resident copy', () => {
    const lookup = lookupFromArray(rows, { complete: true, deleted: new Set(['a']) })
    expect(resolveRef('a', lookup).state).toBe('dangling')
  })

  it('treats a declared reference with no id as dangling', () => {
    const lookup = lookupFromArray(rows, { complete: false })
    for (const id of [undefined, null, '']) {
      expect(resolveRef(id, lookup).state).toBe('dangling')
    }
  })

  it('never returns a target alongside a non-live state', () => {
    const lookup = lookupFromArray(rows, { complete: false })
    expect(resolveRef('gone', lookup).target).toBeUndefined()
  })

  it('resolves through a map index without rebuilding one', () => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(resolveRef('a', lookupFromMap(byId, { complete: true })).state).toBe('live')
    expect(resolveRef('gone', lookupFromMap(byId, { complete: false })).state).toBe('unknown')
  })
})

describe('isActionableRef', () => {
  it('keeps unknown actionable, because the click is what resolves it', () => {
    expect(isActionableRef('live')).toBe(true)
    expect(isActionableRef('unknown')).toBe(true)
    expect(isActionableRef('dangling')).toBe(false)
  })
})

describe('refLabel', () => {
  it('prefers the live name over the label frozen at creation', () => {
    const r = resolveRef('a', lookupFromArray(rows, { complete: true }))
    expect(refLabel(r, (row: Row) => row.name, 'stale name')).toBe('Alpha')
  })

  it('falls back to the stored label when the target is unknown', () => {
    const r = resolveRef('gone', lookupFromArray(rows, { complete: false }))
    expect(refLabel(r, (row: Row) => row.name, 'stored label')).toBe('stored label')
  })

  it('falls back when the live name is blank rather than rendering nothing', () => {
    // A chip with no text cannot be found, read or removed by the user.
    const r = resolveRef('b', lookupFromArray(rows, { complete: true }))
    expect(refLabel(r, (row: Row) => row.name, 'stored label')).toBe('stored label')
  })
})
