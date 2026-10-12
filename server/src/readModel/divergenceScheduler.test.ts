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

import { nextWorkspace } from './divergenceScheduler.js'

const ws = (id: string) => ({ landscapeId: id, versionId: 'v' })

describe('nextWorkspace', () => {
  it('returns null when nothing is eligible, so "nothing to do" is distinguishable from "checked"', () => {
    expect(nextWorkspace([], null)).toBeNull()
    expect(nextWorkspace([], 'a/v')).toBeNull()
  })

  it('starts at the first candidate', () => {
    expect(nextWorkspace([ws('a'), ws('b')], null)).toEqual(ws('a'))
  })

  it('advances round-robin and wraps', () => {
    const all = [ws('a'), ws('b'), ws('c')]
    expect(nextWorkspace(all, 'a/v')).toEqual(ws('b'))
    expect(nextWorkspace(all, 'b/v')).toEqual(ws('c'))
    expect(nextWorkspace(all, 'c/v')).toEqual(ws('a'))
  })

  it('restarts the sweep when the cursor workspace disappeared, rather than stalling on it', () => {
    // findIndex returns -1, so (-1 + 1) % n = 0. A workspace released between
    // ticks must not freeze the sweep forever.
    expect(nextWorkspace([ws('a'), ws('b')], 'gone/v')).toEqual(ws('a'))
  })

  it('handles a single candidate without looping on itself incorrectly', () => {
    expect(nextWorkspace([ws('only')], 'only/v')).toEqual(ws('only'))
  })
})
