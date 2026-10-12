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
import { staleGraceMs } from './health.js'

describe('staleGraceMs', () => {
  it('defaults when unset', () => {
    expect(staleGraceMs({})).toBe(60_000)
  })

  it('takes an explicit override', () => {
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '5000' })).toBe(5_000)
  })

  it('refuses zero, and everything that arrives as zero', () => {
    // `Number('') === 0`, so a dangling `VAR=` must not parse as zero. A zero
    // grace would not disable the detector — it would fire on every write that
    // lands between a projection and the next generation bump, and a detector
    // that cries wolf ends up muted.
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '   ' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '0' })).toBe(60_000)
  })

  it('refuses negative and non-numeric values rather than propagating them into SQL', () => {
    // The value is interpolated into `now() - ($2 || ' milliseconds')::interval`.
    // A negative grace would move the threshold into the future and report every
    // workspace stale; a non-numeric one would make the query throw and take the
    // whole health endpoint down with it.
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '-1' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: 'soon' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: 'Infinity' })).toBe(60_000)
  })
})
