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
import { PlacementWriteScheduler } from './placementWriteScheduler'

describe('PlacementWriteScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a continuous placement burst and flushes at maxWait', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = new PlacementWriteScheduler(flush, {
      trailingMs: 200,
      minIntervalMs: 500,
      maxWaitMs: 1_000,
    })

    scheduler.request('placement')
    for (let elapsed = 100; elapsed < 1_000; elapsed += 100) {
      vi.advanceTimersByTime(100)
      scheduler.request('placement')
    }

    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('guarantees one trailing flush with the last pending state', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = new PlacementWriteScheduler(flush, {
      trailingMs: 200,
      minIntervalMs: 500,
      maxWaitMs: 1_000,
    })

    scheduler.request('placement')
    vi.advanceTimersByTime(100)
    scheduler.request('placement')
    vi.advanceTimersByTime(199)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('never exceeds the placement publication interval after a flush', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = new PlacementWriteScheduler(flush, {
      trailingMs: 200,
      minIntervalMs: 500,
      maxWaitMs: 1_000,
    })

    scheduler.request('placement')
    vi.advanceTimersByTime(200)
    expect(flush).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(50)
    scheduler.request('placement')
    vi.advanceTimersByTime(449)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('flushes immediately for lifecycle boundaries and cancels the timer', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = new PlacementWriteScheduler(flush)

    scheduler.request('placement')
    expect(scheduler.pending).toBe(true)
    scheduler.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(scheduler.pending).toBe(false)

    vi.runAllTimers()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('bounds ten thousand continuous moves and always publishes the final state', () => {
    vi.useFakeTimers()
    let latest = -1
    const published: number[] = []
    const scheduler = new PlacementWriteScheduler(() => published.push(latest), {
      trailingMs: 200,
      minIntervalMs: 500,
      maxWaitMs: 1_000,
    })

    for (let index = 0; index < 10_000; index += 1) {
      latest = index
      scheduler.request('placement')
      vi.advanceTimersByTime(1)
    }
    vi.advanceTimersByTime(500)

    expect(published.at(-1)).toBe(9_999)
    expect(published.length).toBeLessThanOrEqual(11)
  })
})
