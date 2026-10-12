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
import { AsyncSingleFlight } from './asyncSingleFlight.js'

describe('AsyncSingleFlight', () => {
  it('shares overlapping work and forgets it immediately after settlement', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => { await blocked; return { generation: 9 } })
    const flights = new AsyncSingleFlight()

    const first = flights.run('workspace/page', operation)
    const second = flights.run('workspace/page', operation)
    expect(second).toBe(first)
    expect(flights.size()).toBe(1)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { generation: 9 }, { generation: 9 },
    ])
    expect(flights.size()).toBe(0)

    await flights.run('workspace/page', operation)
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('isolates different query keys', async () => {
    const flights = new AsyncSingleFlight()
    const operation = vi.fn(async (value: number) => value)
    await expect(Promise.all([
      flights.run('page/a', () => operation(1)),
      flights.run('page/b', () => operation(2)),
    ])).resolves.toEqual([1, 2])
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('forgets rejected work so a later request can retry', async () => {
    const flights = new AsyncSingleFlight()
    const failure = new Error('temporary failure')

    await expect(flights.run('page/retry', async () => { throw failure })).rejects.toBe(failure)
    expect(flights.size()).toBe(0)
    await expect(flights.run('page/retry', async () => 'recovered')).resolves.toBe('recovered')
    expect(flights.size()).toBe(0)
  })
})
