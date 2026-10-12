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

import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import { SyncCellOwnershipCoordinator, syncCellOwnershipConfig } from './ownership.js'

describe('coordinator placement retry scheduling (T-10h3)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  function fixture() {
    vi.useFakeTimers()
    const config = syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'retry-cell',
      SYNC_CELL_PLACEMENT_MODE: 'placed' })
    const coordinator = new SyncCellOwnershipCoordinator({} as Pool, { ready: true, prefix: 'test:retry' } as RedisRuntime, config)
    const internal = coordinator as unknown as {
      schedulePlacementRetry(): void
      reconcileFlight: Promise<void> | null
    }
    const reconcile = vi.spyOn(coordinator, 'reconcileNow').mockResolvedValue()
    return { coordinator, internal, reconcile }
  }

  it('coalesces refusals into one delayed retry and cancels it on stop', async () => {
    const { coordinator, internal, reconcile } = fixture()
    internal.schedulePlacementRetry()
    internal.schedulePlacementRetry()
    internal.schedulePlacementRetry()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(reconcile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    internal.schedulePlacementRetry()
    expect(vi.getTimerCount()).toBe(1)
    await coordinator.stop()
    expect(vi.getTimerCount()).toBe(0)
    internal.schedulePlacementRetry()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending retry while a pass is still running instead of consuming it by joining', async () => {
    const { coordinator, internal, reconcile } = fixture()
    let finish!: () => void
    const running = new Promise<void>(resolve => { finish = resolve })
    internal.reconcileFlight = running
    internal.schedulePlacementRetry()
    await vi.advanceTimersByTimeAsync(750)
    expect(reconcile).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    finish()
    await running
    internal.reconcileFlight = null
    await vi.advanceTimersByTimeAsync(250)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await coordinator.stop()
  })
})
