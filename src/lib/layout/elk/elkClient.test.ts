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

// QA lens 2026-10-25: a failed elkjs load is not cached (elkClient.ts: "a chunk
// that failed to load offline loads once the network is back").
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('elkjs/lib/elk.bundled.js')
  vi.restoreAllMocks()
})

describe('getElk — a failed load is retried', () => {
  it('loads ELK on the next call after a failed load', async () => {
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fail = true
    vi.doMock('elkjs/lib/elk.bundled.js', async (importOriginal) => {
      if (fail) throw new Error('Failed to fetch dynamically imported module')
      return importOriginal()
    })
    const { getElk } = await import('./elkClient')
    await expect(getElk()).rejects.toThrow()
    expect(warn).toHaveBeenCalled()
    fail = false
    vi.resetModules()
    const elk = await getElk()
    const laid = await elk.layout({ id: 'g', children: [{ id: 'a', width: 10, height: 10 }] })
    expect(laid.children?.[0].x).toBeTypeOf('number')
  }, 30_000)
})
