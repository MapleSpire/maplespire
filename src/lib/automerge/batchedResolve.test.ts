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
import { resolveInBatches } from './batchedResolve'

describe('client shard resolution', () => {
  it('keeps concurrent document requests below the PostgreSQL pool size', async () => {
    let active = 0
    let maximum = 0
    const result = await resolveInBatches(
      Array.from({ length: 150 }, (_, index) => index),
      async (value) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return value * 2
      },
    )
    expect(maximum).toBe(3)
    expect(result).toHaveLength(150)
    expect(result.at(-1)).toBe(298)
  })
})
