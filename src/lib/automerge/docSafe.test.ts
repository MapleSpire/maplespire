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

import { describe, it, expect } from 'vitest'
import * as Automerge from '@automerge/automerge'
import { stripUndefined } from './docSafe'
import type { C4Object } from '../../types'

// stripUndefined is the real fix behind "adding a shape reverts": a new top-level object
// has parentId: undefined (and other undefined optional fields), and Automerge throws
// `RangeError: Cannot assign undefined value` if any property is undefined, so the write
// never persisted. These tests prove (1) it drops undefined keys deeply, (2) it keeps all
// real data, and (3) the cleaned object is actually writable into a real Automerge doc.

describe('stripUndefined', () => {
  it('drops top-level undefined keys, keeps defined ones', () => {
    const out = stripUndefined({ a: 1, b: undefined, c: 'x', d: null })
    expect(out).toEqual({ a: 1, c: 'x', d: null }) // null is a valid Automerge value, kept
    expect('b' in out).toBe(false)
  })

  it('recurses into nested objects and arrays', () => {
    const out = stripUndefined({
      pos: { x: 1, y: undefined },
      techs: [{ name: 'Go', framework: undefined }, { name: 'Rust' }],
      links: undefined,
    })
    expect(out).toEqual({ pos: { x: 1 }, techs: [{ name: 'Go' }, { name: 'Rust' }] })
  })

  it('leaves a fully-defined value unchanged (deep-equal)', () => {
    const v = { a: 1, b: { c: [2, 3] }, d: 'x' }
    expect(stripUndefined(v)).toEqual(v)
  })

  it('produces an object that a real Automerge doc accepts (raw object throws)', () => {
    const newObject = {
      id: 'sys-new', type: 'system', name: 'New System', description: '',
      position: { x: 0, y: 0 }, size: { width: 160, height: 100 },
      tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      parentId: undefined, icon: undefined, links: undefined, // <- the undefined fields
    } as unknown as C4Object

    const emptyDoc = () => Automerge.from({ objects: {} as Record<string, C4Object> })

    // Raw write throws — this is exactly the bug.
    expect(() =>
      Automerge.change(emptyDoc(), (d) => {
        d.objects['sys-new'] = newObject
      })
    ).toThrow()

    // Cleaned write succeeds and round-trips the real data.
    const doc = Automerge.change(emptyDoc(), (d) => {
      d.objects['sys-new'] = stripUndefined(newObject)
    })
    expect(doc.objects['sys-new']).toMatchObject({
      id: 'sys-new', name: 'New System', tagAssignments: {}, tagOrder: [],
    })
    expect('parentId' in doc.objects['sys-new']).toBe(false)
  })
})
