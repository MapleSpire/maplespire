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

import type { PoolConcurrencyGate } from '../db/poolConcurrencyGate.js'
import { CompactionReattachSupervisor, type CompactionReattachDeps } from './compactionReattach.js'
import type { WorkspaceKey } from './projector.js'
import type { WorkspaceCompactionDeps } from './workspaceCompaction.js'

/**
 * THE COMPACTION RE-ATTACH SUPERVISOR, WIRED AS `index.ts` WIRES IT (G4-16f).
 *
 * Extracted from `main()` so the wiring is a tested fact rather than lines in
 * a file no test boots: `index.ts` hands over the objects it owns (the fleet,
 * the ownership, the readiness flag, the compaction slot, the stop list, the
 * storage write gate, the epoch trace) and spreads `passHooks` into the
 * compaction pass. What each one is used for is decided here, and
 * `compactionReattachWiring.test.ts` drives it.
 */
export interface CompactionReattachWiringDeps {
  readonly fleet: CompactionReattachDeps['fleet'] & {
    onResident(listener: (key: WorkspaceKey) => void): () => void
  }
  /** Null: ownership off — this cell owns every workspace. */
  readonly ownership: {
    owns(key: WorkspaceKey): boolean
    onOwnershipAcquired?(listener: (event: { workspace: WorkspaceKey }) => void | Promise<void>): () => void
  } | null
  readonly readiness: { readonly shuttingDown: boolean }
  /** The compaction slot (`createUnyieldingHolds(poolHeavyPasses)`). */
  readonly holds: { run<T>(work: () => Promise<T>): Promise<T>; holding(): boolean }
  /** `maintenanceScheduleStops`: everything registered here is stopped at shutdown. */
  readonly stops: Array<() => void>
  /** The storage write pool's permit gate, read at each attempt. */
  readonly writeGate?: () => Pick<PoolConcurrencyGate, 'liveQueueDepth'> | undefined
  readonly trace?: (event: Record<string, unknown>) => void
  /** Test seams; production leaves them unset. */
  readonly overrides?: Partial<Omit<CompactionReattachDeps, 'fleet' | 'owns' | 'isShuttingDown' | 'exclusive' | 'slotHeld' | 'storageSaturated' | 'trace'>>
}

export interface CompactionReattachWiring {
  readonly supervisor: CompactionReattachSupervisor
  /** Spread into `runWorkspaceCompaction`'s deps. */
  readonly passHooks: Pick<WorkspaceCompactionDeps, 'onReadPlaneLeftDetached' | 'watchReattach'>
}

export function wireCompactionReattach(deps: CompactionReattachWiringDeps): CompactionReattachWiring {
  const supervisor = new CompactionReattachSupervisor({
    ...deps.overrides,
    fleet: deps.fleet,
    owns: (key) => (deps.ownership ? deps.ownership.owns(key) : true),
    isShuttingDown: () => deps.readiness.shuttingDown,
    // Every attempt under the slot every compaction pass holds.
    exclusive: (work) => deps.holds.run(work),
    // HELD only: a pass queued for the slot, or a marked phase of the epoch
    // sweep, does not keep the mark — the meaning it had before epochs, so
    // the next boot adopts instead of a cold
    // build `adopt: 'off'`.
    slotHeld: () => deps.holds.holding(),
    storageSaturated: () => (deps.writeGate?.()?.liveQueueDepth ?? 0) > 0,
    ...(deps.trace ? { trace: deps.trace } : {}),
  })
  const stopResident = deps.fleet.onResident((key) => supervisor.noteAttached(key))
  const stopAcquired = deps.ownership?.onOwnershipAcquired?.(({ workspace }) => supervisor.noteOwnershipAcquired(workspace))
  deps.stops.push(() => {
    supervisor.stop()
    stopResident()
    stopAcquired?.()
  })
  return {
    supervisor,
    passHooks: {
      onReadPlaneLeftDetached: (key, cause, reason) => supervisor.noteDetached(key, cause, reason),
      watchReattach: (key) => supervisor.watchReattach(key, 'pass'),
    },
  }
}
