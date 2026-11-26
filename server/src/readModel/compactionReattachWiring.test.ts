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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wireCompactionReattach, type CompactionReattachWiringDeps } from './compactionReattachWiring.js'
import { createProcessExclusion } from '../maintenance/processExclusion.js'
import { createUnyieldingHolds } from './modelEpochForwardWiring.js'
import type { WorkspaceKey } from './projector.js'

const KEY: WorkspaceKey = { landscapeId: 'l-1', versionId: 'v-1' }

/** What `index.ts` hands over, as fakes that record how they are used. */
function world(over: Partial<CompactionReattachWiringDeps> = {}) {
  let resident = false
  const residentListeners = new Set<(key: WorkspaceKey) => void>()
  const acquiredListeners = new Set<(event: { workspace: WorkspaceKey }) => void>()
  const ensures: Array<{ at: number; options: unknown }> = []
  const lifted: WorkspaceKey[] = []
  const owned = { value: true }
  const readiness = { shuttingDown: false }
  const holds = createUnyieldingHolds(createProcessExclusion())
  const stops: Array<() => void> = []
  let saturated = 0
  const deps: CompactionReattachWiringDeps = {
    fleet: {
      isResident: () => resident,
      ensure: async (_key, options) => {
        ensures.push({ at: Date.now(), options })
        resident = true
        for (const listener of residentListeners) listener(KEY)
        return true
      },
      liftCompactionDetached: (key) => { lifted.push(key) },
      onResident: (listener) => { residentListeners.add(listener); return () => residentListeners.delete(listener) },
    },
    ownership: {
      owns: () => owned.value,
      onOwnershipAcquired: (listener) => { acquiredListeners.add(listener); return () => acquiredListeners.delete(listener) },
    },
    readiness,
    holds,
    stops,
    writeGate: () => ({ liveQueueDepth: saturated }),
    overrides: { log: () => {}, warn: () => {} },
    ...over,
  }
  const wiring = wireCompactionReattach(deps)
  return {
    wiring, ensures, lifted, owned, readiness, holds, stops,
    setResident: (value: boolean) => { resident = value },
    becomeResident: () => { resident = true; for (const listener of residentListeners) listener(KEY) },
    /** As `SyncCellOwnershipCoordinator`: the listeners run BEFORE `owns()`
     * turns true (an admission barrier). */
    acquire: () => {
      for (const listener of acquiredListeners) listener({ workspace: KEY })
      owned.value = true
    },
    saturate: (depth: number) => { saturated = depth },
    listeners: () => ({ resident: residentListeners.size, acquired: acquiredListeners.size }),
  }
}

describe('wireCompactionReattach (G4-16f): what index.ts hands over, and what each piece is used for', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }) })
  afterEach(() => { vi.useRealTimers() })

  it('the pass hooks hand a failed re-attach to the supervisor, which re-attaches it { adopt: false }', async () => {
    const w = world()
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('StoragePoolExhaustedError'), 'reattach_failed')
    expect(w.wiring.supervisor.isPending(KEY)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.ensures).toEqual([{ at: 1_000, options: { adopt: false } }])
    expect(w.wiring.supervisor.isPending(KEY)).toBe(false)
    const unwatch = w.wiring.passHooks.watchReattach!(KEY)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(w.wiring.supervisor.snapshot().runningMs).toBe(2_000)
    unwatch()
  })

  it('an attempt runs UNDER the compaction slot (`holds`): never while a pass holds it', async () => {
    const w = world()
    let release!: () => void
    const pass = w.holds.run(() => new Promise<void>((resolve) => { release = resolve }))
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.ensures, 'no build while the pass holds the slot').toHaveLength(0)
    release()
    await pass
    await vi.advanceTimersByTimeAsync(0)
    expect(w.ensures).toHaveLength(1)
  })

  it('readiness.shuttingDown is the shutdown the supervisor asks', async () => {
    const w = world()
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    w.readiness.shuttingDown = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.ensures).toHaveLength(0)
    expect(w.wiring.supervisor.snapshot().attempts.abandoned).toBe(1)
  })

  it('ownership.owns is the ownership the supervisor asks, and an acquisition re-arms a dormant workspace', async () => {
    const w = world()
    w.owned.value = false
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.ensures).toHaveLength(0)
    expect(w.wiring.supervisor.dormantReason(KEY)).toBe('not_owned')
    w.acquire()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.ensures).toHaveLength(1)
    // Null ownership (ownership off): this cell owns everything.
    const off = world({ ownership: null })
    off.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(off.ensures).toHaveLength(1)
  })

  it('the fleet\'s onResident ends an outage at once (a read\'s cold build), lifting the mark when no pass holds the slot', async () => {
    const w = world()
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    w.becomeResident()
    expect(w.wiring.supervisor.isPending(KEY)).toBe(false)
    expect(w.lifted).toEqual([KEY])
    // Under a pass's slot: recovered, NOT lifted.
    const held = world()
    held.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    let release!: () => void
    const pass = held.holds.run(() => new Promise<void>((resolve) => { release = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    expect(held.holds.held()).toBe(true)
    held.becomeResident()
    expect(held.wiring.supervisor.isPending(KEY)).toBe(false)
    expect(held.lifted).toEqual([])
    release()
    await pass
  })

  it('a pass only QUEUED for the slot, or a marked phase, does not keep the mark — lifted as before', async () => {
    const exclusion = createProcessExclusion()
    const holds = createUnyieldingHolds(exclusion)
    const w = world({ holds })
    // Another holder (the periodic sweep: the exclusion itself) has the slot;
    // a compaction waits behind it.
    let releaseSweep!: () => void
    const sweeping = exclusion.run(() => new Promise<void>((resolve) => { releaseSweep = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    const queued = holds.run(async () => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(holds.held()).toBe(true)
    let releasePhase!: () => void
    const phase = holds.during(() => new Promise<void>((resolve) => { releasePhase = resolve }))
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    w.becomeResident()
    expect(w.wiring.supervisor.isPending(KEY)).toBe(false)
    expect(w.lifted).toEqual([KEY])
    releasePhase()
    await phase
    releaseSweep()
    await sweeping
    await queued
  })

  it('the storage write gate with callers queued postpones the attempt', async () => {
    const w = world()
    // ONE caller queued is saturated (`> 0`, not `> 1`).
    w.saturate(1)
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.ensures).toHaveLength(0)
    expect(w.wiring.supervisor.snapshot().attempts.skippedSaturated).toBe(1)
    w.saturate(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(w.ensures).toHaveLength(1)
  })

  it('the traces go to `trace` (MODEL_EPOCH_TRACE_FILE)', async () => {
    const traces: Array<Record<string, unknown>> = []
    const w = world({ trace: (event) => { traces.push(event) } })
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(traces.map((t) => t.event)).toContain('compaction_reattach.slot_released')
  })

  it('ONE stop registered in `stops`: it stops the supervisor and unsubscribes both listeners', async () => {
    const w = world()
    expect(w.stops).toHaveLength(1)
    expect(w.listeners()).toEqual({ resident: 1, acquired: 1 })
    w.wiring.passHooks.onReadPlaneLeftDetached!(KEY, new Error('x'), 'reattach_failed')
    w.stops[0]!()
    expect(w.listeners()).toEqual({ resident: 0, acquired: 0 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.ensures).toHaveLength(0)
  })
})
