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
import { publishAfterDurableFlush } from './durableReferences'

describe('publishAfterDurableFlush', () => {
  it('does not expose a parent reference until child documents are durable', async () => {
    const order: string[] = []
    let releaseFlush!: () => void
    const flush = vi.fn(() => new Promise<void>((resolve) => {
      releaseFlush = () => { order.push('flushed'); resolve() }
    }))

    const publishing = publishAfterDurableFlush({ flush }, () => order.push('published'))
    await Promise.resolve()

    expect(order).toEqual([])
    releaseFlush()
    await publishing
    expect(order).toEqual(['flushed', 'published'])
  })
})
