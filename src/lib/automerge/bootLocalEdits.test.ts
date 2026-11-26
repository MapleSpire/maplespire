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
import { BootLocalEdits } from './bootLocalEdits'

type S = { objects: Array<{ id: string; name: string }>; groups: Array<{ id: string }>; tags: Array<{ tagId: string; v: number }> }

describe('the boot window\'s LOCAL edits, by entity', () => {
  it('the base is now with only her edits put back: a later remote change is a baseline, never hers', () => {
    const edits = new BootLocalEdits()
    const a = { id: 'a', name: 'A' }
    const b = { id: 'b', name: 'B' }
    const s0: S = { objects: [a, b], groups: [], tags: [{ tagId: 't', v: 1 }] }
    const mine = { id: 'a', name: 'Mine' }
    const s1: S = { ...s0, objects: [mine, b] }
    edits.note(s0, s1)
    // A remote projection: b changed by a colleague, and a group added.
    const theirs = { id: 'b', name: 'Theirs' }
    const now: S = { ...s1, objects: [mine, theirs], groups: [{ id: 'g' }] }
    const base = edits.base(now)
    expect(base.objects).toEqual([a, theirs])
    // Untouched slices keep their reference (they read as unchanged).
    expect(base.groups).toBe(now.groups)
    expect(base.tags).toBe(now.tags)
    expect(edits.size).toBe(1)
  })

  it('at FIELD grain — a colleague\'s change to another field of an entity she edited is a baseline too', () => {
    const edits = new BootLocalEdits()
    type D = { objects: Array<{ id: string; name: string; description?: string }>; groups: never[]; tags: never[] }
    const a = { id: 'a', name: 'A', description: 'd' }
    const s0: D = { objects: [a], groups: [], tags: [] }
    const s1: D = { ...s0, objects: [{ ...a, name: 'Mine' }] }
    edits.note(s0, s1)
    // A remote projection: the colleague's description lands on her edited entity.
    const now: D = { ...s1, objects: [{ id: 'a', name: 'Mine', description: 'Theirs' }] }
    expect(edits.base(now).objects).toEqual([{ id: 'a', name: 'A', description: 'Theirs' }])
    // A field she then REMOVED is hers too: back at its value before her first change.
    const s2: D = { ...now, objects: [{ id: 'a', name: 'Mine' }] }
    edits.note(now, s2)
    expect(edits.base(s2).objects).toEqual([{ id: 'a', name: 'A', description: 'd' }])
  })

  it('an entity she edited, deleted, then created again is hers WHOLE — the base is the entity before her first change, every field of the new one replayed', () => {
    const edits = new BootLocalEdits()
    type D = { objects: Array<{ id: string; name: string; description?: string }>; groups: never[]; tags: never[] }
    const a = { id: 'a', name: 'A', description: 'd' }
    const s0: D = { objects: [a], groups: [], tags: [] }
    const s1: D = { ...s0, objects: [{ ...a, name: 'Mine' }] }
    edits.note(s0, s1)
    const s2: D = { ...s1, objects: [] }
    edits.note(s1, s2)
    const s3: D = { ...s2, objects: [{ id: 'a', name: 'Again', description: 'new' }] }
    edits.note(s2, s3)
    // Not only `name`: the re-created description is hers too.
    expect(edits.base(s3).objects).toEqual([a])
  })

  it('the value before the FIRST local change is kept; a creation is absent from the base; a delete is back in it', () => {
    const edits = new BootLocalEdits()
    const a = { id: 'a', name: 'A' }
    const b = { id: 'b', name: 'B' }
    const s0: S = { objects: [a, b], groups: [], tags: [{ tagId: 't', v: 1 }] }
    const s1: S = { ...s0, objects: [{ id: 'a', name: 'one' }, b, { id: 'n', name: 'New' }] }
    edits.note(s0, s1)
    const s2: S = { ...s1, objects: [{ id: 'a', name: 'two' }, { id: 'n', name: 'New' }], tags: [{ tagId: 't', v: 2 }] }
    edits.note(s1, s2)
    const base = edits.base(s2)
    expect(base.objects).toEqual([a, b])
    expect(base.tags).toEqual([{ tagId: 't', v: 1 }])
  })
})
