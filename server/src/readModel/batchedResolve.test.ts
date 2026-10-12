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
import { resolveCooperatively, resolveInBatches } from './batchedResolve.js'

describe('server shard resolution', () => {
  it('yields between complete resolutions even when every result is already ready', async () => {
    const order: string[] = []
    const result = await resolveCooperatively(['a', 'b', 'c'], async (id) => {
      order.push(`resolve-${id}`)
      setImmediate(() => order.push(`io-${id}`))
      return id.toUpperCase()
    })
    expect(result).toEqual(['A', 'B', 'C'])
    expect(order.slice(0, 5)).toEqual(['resolve-a', 'io-a', 'resolve-b', 'io-b', 'resolve-c'])
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  it('propagates a failed resolution without starting later documents', async () => {
    const seen: number[] = []
    await expect(resolveCooperatively([1, 2, 3], async id => {
      seen.push(id)
      if (id === 2) throw new Error('storage failed')
      return id
    })).rejects.toThrow('storage failed')
    expect(seen).toEqual([1, 2])
  })

  it('leaves PostgreSQL pool headroom during a cold build', async () => {
    let active = 0
    let maximum = 0
    const values = await resolveInBatches(
      Array.from({ length: 600 }, (_, index) => `shard-${index}`),
      async (url) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return url
      },
    )
    expect(maximum).toBe(3)
    expect(values).toHaveLength(600)
  })
})
