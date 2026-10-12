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
import { mergeOverlaySegments, updateOverlaySegment } from './overlayPrecedence'

describe('overlay precedence', () => {
  it('keeps the newest segment authoritative after an old segment changes', () => {
    const result = mergeOverlaySegments([
      { same: { value: 'old changed late' }, oldOnly: { value: 'old' } },
      { same: { value: 'middle' } },
      { same: { value: 'newest' }, newOnly: { value: 'new' } },
    ])
    expect(result.get('same')).toEqual({ value: 'newest' })
    expect([...result]).toHaveLength(3)
  })
})

describe('updateOverlaySegment', () => {
  it('touches only changed winners and keeps the newest segment authoritative', () => {
    const oldestShared = { name: 'old' }
    const newestShared = { name: 'new' }
    const stable = { name: 'stable' }
    const segments = new Map<string, Record<string, { name: string }>>([
      ['old', { shared: oldestShared, stable }],
      ['new', { shared: newestShared }],
    ])
    const effective = mergeOverlaySegments([...segments.values()])

    const changedOld = { name: 'old changed' }
    const delta = updateOverlaySegment(
      ['old', 'new'], segments, effective, 'old', { shared: changedOld, stable },
    )

    expect(delta.upserts.size).toBe(0)
    expect(effective.get('shared')).toBe(newestShared)
    expect(effective.get('stable')).toBe(stable)
  })
})
