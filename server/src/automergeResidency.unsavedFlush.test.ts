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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { AutomergeResidencyLeases } from './automergeResidency.js'

/**
 * G4-16d: an eviction refused for an unsaved document asks for a flush — at
 * once, then no more often than 30 s doubling to 10 min — reading the save
 * cursor BEFORE the flush and reporting it once the flush resolves. Only
 * `Date` is faked: the Repo's own timers run for real.
 */
describe('refused eviction of an unsaved document: the flush backoff', () => {
  afterEach(() => { vi.useRealTimers() })

  it('flushes at 0, not again before 30 s, then 60, 120, … capped at 600 s; resets after an allowed eviction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ v: number }>({ v: 1 })
    await handle.whenReady()
    const events: string[] = []
    let unsaved = true
    let cursor = 0
    const flushSettled = vi.fn((_id: string, at: number) => { events.push(`settled:${at}`) })
    const residency = new AutomergeResidencyLeases(repo, {
      snapshot: () => ({ trackedDocuments: 0, trackedChunkBytes: 0 }),
      forget: () => {},
      hasUnsavedWrite: () => unsaved,
      saveCursor: () => { events.push(`cursor:${++cursor}`); return cursor },
      flushSettled,
    })
    const flush = vi.spyOn(repo, 'flush').mockImplementation(async () => { events.push('flush') })
    const at = async (offsetMs: number) => {
      vi.setSystemTime(1_000_000 + offsetMs)
      expect(await residency.evict(handle.documentId)).toBe(false)
      await Promise.resolve()
      await Promise.resolve()
      return flush.mock.calls.length
    }
    expect(await at(0)).toBe(1)
    // The cursor is read BEFORE the flush, and reported once it resolved.
    expect(events.slice(0, 3)).toEqual(['cursor:1', 'flush', 'settled:1'])
    expect(await at(29_999)).toBe(1)
    expect(await at(30_000)).toBe(2)
    expect(await at(30_000 + 59_999)).toBe(2)
    expect(await at(90_000)).toBe(3)
    expect(await at(90_000 + 120_000)).toBe(4)
    expect(await at(210_000 + 240_000)).toBe(5)
    expect(await at(450_000 + 480_000)).toBe(6)
    // Capped: 600 s, not 960 s.
    expect(await at(930_000 + 599_999)).toBe(6)
    expect(await at(930_000 + 600_000)).toBe(7)
    expect(await at(1_530_000 + 600_000)).toBe(8)
    expect((await residency.snapshot()).evictionSkippedUnsavedWrite).toBe(11)
    // Saved: the eviction goes through, and the backoff is forgotten.
    unsaved = false
    expect(await residency.evict(handle.documentId)).toBe(true)
    expect((residency as unknown as { unsavedFlushes: Map<string, unknown> }).unsavedFlushes.size).toBe(0)
    expect(flushSettled).toHaveBeenCalledTimes(8)
  })
})
