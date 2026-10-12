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
import { describe, expect, it, vi } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import { SyncCellOwnershipCoordinator, syncCellOwnershipConfig } from './ownership.js'

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
function fixture() {
  const coordinator = new SyncCellOwnershipCoordinator({} as Pool, {} as RedisRuntime,
    syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_PLACEMENT_MODE: 'placed' }))
  // Suspend the entire pass; these tests concern the public queue's lifetime.
  // Real SELECT/NOTIFY/acquisition wiring is exercised by the DB suites.
  const pass = vi.spyOn(coordinator as unknown as { performReconcile(): Promise<void> }, 'performReconcile')
  return { coordinator, pass }
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

describe('placed reconciliation invalidations', () => {
  it('coalesces an invalidation burst into one further pass, never a concurrent pass', async () => {
    const { coordinator, pass } = fixture()
    const held = deferred()
    pass.mockImplementationOnce(() => held.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    await tick()
    const invalidations = Array.from({ length: 20 }, () => coordinator.reconcileNow())
    expect(pass).toHaveBeenCalledTimes(1)
    held.resolve()
    await Promise.all([first, ...invalidations])
    expect(pass).toHaveBeenCalledTimes(2)
    await coordinator.stop()
  })

  it('ticks join a slow pass without keeping that flight alive forever', async () => {
    const { coordinator, pass } = fixture()
    const held = deferred()
    pass.mockImplementationOnce(() => held.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    const ticks = Array.from({ length: 20 }, () => coordinator.reconcileNow(false))
    held.resolve()
    await Promise.all([first, ...ticks])
    expect(pass).toHaveBeenCalledTimes(1)
    await coordinator.stop()
  })

  it('an invalidation during the second pass causes a third read', async () => {
    const { coordinator, pass } = fixture()
    const one = deferred(), two = deferred()
    pass.mockImplementationOnce(() => one.promise).mockImplementationOnce(() => two.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    await tick()
    const second = coordinator.reconcileNow()
    one.resolve()
    await tick()
    expect(pass).toHaveBeenCalledTimes(2)
    const third = coordinator.reconcileNow()
    two.resolve()
    await Promise.all([first, second, third])
    expect(pass).toHaveBeenCalledTimes(3)
    await coordinator.stop()
  })

  it('retains the error and still replays an invalidation received during the failed read', async () => {
    const { coordinator, pass } = fixture()
    const held = deferred()
    pass.mockImplementationOnce(() => held.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    await tick()
    const notified = coordinator.reconcileNow()
    held.reject(new Error('first SELECT failed'))
    await Promise.all([first, notified])
    expect(pass).toHaveBeenCalledTimes(2)
    expect(coordinator.snapshot().errorCount).toBe(1)
    await coordinator.stop()
  })

  it('rejects a failed pass with no invalidation, then accepts a fresh attempt', async () => {
    const { coordinator, pass } = fixture()
    pass.mockRejectedValueOnce(new Error('SQL failed')).mockResolvedValue(undefined)
    await expect(coordinator.reconcileNow()).rejects.toThrow('SQL failed')
    await coordinator.reconcileNow()
    expect(pass).toHaveBeenCalledTimes(2)
    await coordinator.stop()
  })

  it('does not lose an invalidation queued immediately after the final pass continuation', async () => {
    const { coordinator, pass } = fixture()
    const held = deferred()
    pass.mockImplementationOnce(() => held.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    await tick()
    // Registered after the drain's await: this callback runs after its final
    // dirty check, but before a separate promise.finally could clear flight.
    const late = held.promise.then(() => coordinator.reconcileNow())
    held.resolve()
    await Promise.all([first, late])
    expect(pass).toHaveBeenCalledTimes(2)
    await coordinator.stop()
  })

  it('clears a flight whose pass throws synchronously', async () => {
    const { coordinator, pass } = fixture()
    pass.mockImplementationOnce(() => { throw new Error('synchronous dependency failure') }).mockResolvedValue(undefined)
    await expect(coordinator.reconcileNow()).rejects.toThrow('synchronous dependency failure')
    await coordinator.reconcileNow()
    expect(pass).toHaveBeenCalledTimes(2)
    await coordinator.stop()
  })

  it('stop joins the actual pass and suppresses an already queued follow-up', async () => {
    const { coordinator, pass } = fixture()
    const held = deferred()
    pass.mockImplementationOnce(() => held.promise).mockResolvedValue(undefined)
    const first = coordinator.reconcileNow()
    await tick()
    const notified = coordinator.reconcileNow()
    const stopping = coordinator.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await tick()
    expect(stopped).toBe(false)
    held.resolve()
    await Promise.all([stopping, first, notified])
    expect(stopped).toBe(true)
    await coordinator.reconcileNow()
    expect(pass).toHaveBeenCalledTimes(1)
  })
})
