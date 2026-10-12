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
import type { Pool } from 'pg'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  isReconcilePassDeadline,
  type SyncCellOwnershipConfig,
} from './ownership.js'
import { QUERY_CANCELED } from '../db/statementTimeout.js'

/**
 * The reconcile PASS has a deadline, and one workspace cannot spend it for
 * everyone else.
 *
 * `statement_timeout` and `lock_timeout` on the coordinator's connections bound
 * each STATEMENT, not the pass. Three `catch` blocks swallow per-workspace
 * failures by design, so N workspaces can each burn the ceiling in turn: at
 * 10 000 workspaces with `admissionConcurrency` 4 and a 30 s ceiling, roughly
 * twenty hours, with `reconcileFlight` pending throughout and every later
 * `reconcileNow()` handed that same pending promise.
 *
 * A FAKE CLOCK, NOT A REAL WAIT. The deadline is wall-clock, and the coordinator
 * already takes its clock as a constructor parameter, so the arms below drive
 * time instead of spending it. That is not a shortcut: a test that waited would
 * either be slow or would need the deadline set so low that a legitimate pass
 * could trip it, and then it would be measuring the fixture.
 */
describe('the reconcile pass has a deadline', () => {
  const WORKSPACES = Array.from({ length: 6 }, (unused, index) => ({
    landscape_id: 'landscape-1',
    id: `version-${index}`,
  }))

  /**
   * A clock the WORK advances, not the reader.
   *
   * Advancing time on every `now()` read would be wrong: `partitionIsLive()`
   * reads the clock, so the partition lease would expire before the pass ever
   * reached workspace discovery. Simulated time has to be spent by the thing
   * that spends real time — a statement hitting the ceiling — or the fixture is
   * measuring its own clock.
   */
  function simulatedClock(): { now: () => number; spend: (ms: number) => void } {
    let value = 1_000_000
    return { now: () => value, spend: (ms) => { value += ms } }
  }

  function config(overrides: Partial<SyncCellOwnershipConfig> = {}): SyncCellOwnershipConfig {
    return {
      enabled: true,
      cellId: 'cell-a',
      advertiseUrl: null,
      leaseTtlMs: 600_000,
      renewIntervalMs: 200_000,
      partitionLeaseTtlMs: 3_600_000,
      partitionRenewIntervalMs: 600_000,
      partitionProbeIntervalMs: 600_000,
      partitionWorker: false,
      reconcileIntervalMs: 300_000,
      telemetryIntervalMs: 300_000,
      reconcilePassDeadlineMs: 30_000,
      concurrency: 2,
      admissionConcurrency: 2,
      partitionCount: 1,
      topologyGeneration: 'v1',
      ...overrides,
    } as SyncCellOwnershipConfig
  }

  /** Answers the pass's queries; every acquisition attempt fails the way a
   *  server-imposed ceiling fails, which is the state after a restore when every
   *  held lease is divergent at once. */
  function poolThatAlwaysHitsTheCeiling(spend: (ms: number) => void, costMs: number): { pool: Pool; attempts: () => number } {
    let attempts = 0
    const pool = {
      async query(text: string, values?: unknown[]) {
        // This fixture exercises the deadline after successful topology
        // confirmation, which requires acknowledgement of its durable write.
        if (text.includes('INSERT INTO sync_topology_contract')) {
          return { rows: [{ value: values?.[0] }], rowCount: 1 }
        }
        if (text.includes('SELECT landscape_id, id FROM versions')) {
          return { rows: WORKSPACES, rowCount: WORKSPACES.length }
        }
        if (text.includes('SELECT fencing_token FROM sync_workspace_ownership')) {
          attempts += 1
          // The statement burned its ceiling; that is where the pass’s time goes.
          spend(costMs)
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: QUERY_CANCELED,
          })
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool
    return { pool, attempts: () => attempts }
  }

  const REDIS = {
    configured: true,
    ready: true,
    prefix: 'test',
    async send(args: string[]) {
      // Enough of a partition lease for the pass to get past the topology and
      // partition gates and reach the part under test.
      if (args[0] === 'GET') return null
      const script = args[1] ?? ''
      if (script.includes("redis.call('SET', KEYS[1], ARGV[1])")) return 2
      if (script.includes("local minimum = tonumber(ARGV[1])")) return 1
      if (script.includes("redis.call('INCR'")) return ['1', 'cell-a|1']
      if (script.includes("redis.call('PEXPIRE'")) return 1
      if (script.includes("redis.call('DEL'")) return 1
      return 0
    },
  } as unknown as RedisRuntime

  interface Internals { performReconcile: () => Promise<void> }

  it('abandons the pass instead of grinding through every workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      // Each failing statement costs 20 s of simulated time against a 30 s
      // deadline, so the pass runs out during the admission batches.
      const { pool, attempts } = poolThatAlwaysHitsTheCeiling(time.spend, 20_000)
      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, config(), time.now)
      const internals = coordinator as unknown as Internals

      const outcome = await internals.performReconcile().then(() => null, (error: unknown) => error)

      // ABANDONED, not completed. Without a deadline this would resolve only
      // after every one of the six workspaces had failed in turn — and at
      // 10 000 workspaces that is the twenty-hour pass.
      expect(isReconcilePassDeadline(outcome)).toBe(true)
      // And it stopped EARLY: fewer attempts than workspaces is the whole
      // property. A deadline that only fired after the last workspace would
      // satisfy every other assertion here and prevent nothing.
      expect(attempts()).toBeLessThan(WORKSPACES.length)
      expect(coordinator.snapshot().passAbandonedCount).toBe(1)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('a pass that fits its deadline is not abandoned — the control', async () => {
    // Without this arm, "it threw" cannot be told from a coordinator that throws
    // whatever happens. The clock barely advances, so the same six failing
    // workspaces are all attempted and the pass ends on its own terms.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      const { pool, attempts } = poolThatAlwaysHitsTheCeiling(time.spend, 1)
      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, config(), time.now)
      const internals = coordinator as unknown as Internals

      const outcome = await internals.performReconcile().then(() => null, (error: unknown) => error)

      expect(isReconcilePassDeadline(outcome)).toBe(false)
      expect(attempts()).toBe(WORKSPACES.length)
      expect(coordinator.snapshot().passAbandonedCount).toBe(0)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('the abandoned pass releases the single-flight, so the NEXT pass runs', async () => {
    // The core property: the danger is not that a pass is slow, it is that a
    // pass which never ends hands its pending promise to every later caller.
    // `reconcileNow` must be callable again.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      const { pool } = poolThatAlwaysHitsTheCeiling(time.spend, 20_000)
      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, config(), time.now)

      const first = await coordinator.reconcileNow().then(() => null, (error: unknown) => error)
      expect(isReconcilePassDeadline(first)).toBe(true)
      const second = await coordinator.reconcileNow().then(() => null, (error: unknown) => error)
      expect(isReconcilePassDeadline(second)).toBe(true)
      // TWO abandonments, not one: a second call that returned the FIRST pass's
      // settled promise would leave this at 1 and every other assertion green.
      expect(coordinator.snapshot().passAbandonedCount).toBe(2)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('the SERIAL repair loop is bounded too, and its catch does not swallow the deadline', async () => {
    // The other two check points, and without this arm they are untested: the
    // admission fixture above never reaches `reassertHeldFences`. The repair
    // loop is the WORST path — serial, one `persistLease` per divergent lease,
    // and after a restore every held lease is divergent at once.
    //
    // It also covers the re-throw. `reassertHeldFences` has an outer catch whose
    // job is to stop a broken detector killing the pass; if that catch swallowed
    // the deadline, the survey would return, the pass would carry on, and the
    // wedge would be back with every assertion above still green.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      let repairAttempts = 0
      const held = Array.from({ length: 6 }, (unused, index) => ({
        landscapeId: 'landscape-1',
        versionId: `version-${index}`,
      }))
      const pool = {
        async query(text: string, values?: unknown[]) {
          if (text.includes('INSERT INTO sync_topology_contract')) {
            return { rows: [{ value: values?.[0] }], rowCount: 1 }
          }
          // The reassertion survey, recognised by its two array parameters —
          // by SHAPE, as the sibling suite does, because a semantically
          // identical SQL rewrite should not turn this red.
          if (Array.isArray(values?.[0]) && Array.isArray(values?.[1])) {
            const landscapes = values[0] as string[]
            const versions = values[1] as string[]
            // Every row BELOW our live token: `belowLive`, which is repairable,
            // which is what drives the loop under test.
            return {
              rows: landscapes.map((landscapeId, index) => ({
                landscape_id: landscapeId,
                version_id: versions[index]!,
                fencing_token: '1',
                cell_id: 'cell-a',
                released: false,
              })),
              rowCount: landscapes.length,
            }
          }
          if (text.includes('SELECT landscape_id, id FROM versions')) {
            return {
              rows: held.map((w) => ({ landscape_id: w.landscapeId, id: w.versionId })),
              rowCount: held.length,
            }
          }
          if (text.includes('INSERT INTO sync_workspace_ownership')) {
            repairAttempts += 1
            time.spend(20_000)
            throw Object.assign(new Error('canceling statement due to statement timeout'), {
              code: QUERY_CANCELED,
            })
          }
          return { rows: [], rowCount: 0 }
        },
      } as unknown as Pool

      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, config(), time.now)
      const internals = coordinator as unknown as {
        leases: Map<string, unknown>
        expected: Map<string, unknown>
        partitionLease: unknown
        performReconcile: () => Promise<void>
      }
      internals.partitionLease = { partition: 0, ownerValue: 'cell-a|1', token: '1', validUntil: time.now() + 3_600_000 }
      for (const workspace of held) {
        const key = `${workspace.landscapeId}\u0000${workspace.versionId}`
        internals.leases.set(key, {
          workspace,
          token: '9',
          // THREE parts, matching this fixture's `topologyGeneration: 'v1'`:
          // the acquire scripts always append the generation, so a
          // two-part workspace owner value is a state Redis cannot hold.
          ownerValue: 'cell-a|9|v1',
          validUntil: time.now() + 3_600_000,
        })
        internals.expected.set(key, workspace)
      }

      // Through the REAL pass, not by calling the survey directly: the deadline
      // is set by `performReconcile` and is deliberately inert outside one, so an
      // arm that called the survey on its own would prove the check unreachable
      // rather than working. With every workspace already leased, `acquireMissing`
      // no-ops and the pass goes straight to the reassertion.
      const outcome = await internals.performReconcile().then(() => null, (error: unknown) => error)

      expect(isReconcilePassDeadline(outcome)).toBe(true)
      expect(repairAttempts).toBeLessThan(held.length)
      expect(coordinator.snapshot().passAbandonedCount).toBe(1)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('a missing deadline degrades to NO deadline, never to abandoning every pass', async () => {
    // `now() + undefined` is NaN and `now() < NaN` is FALSE, so a naive
    // implementation makes an absent value fire the very first check: every
    // pass abandoned instantly, the cell never acquires a lease. That is
    // strictly worse than an unbounded pass — no deadline is survivable; no
    // reconciliation is not.
    //
    // Hand-built configs use `as SyncCellOwnershipConfig`, so the compiler
    // cannot say the field is missing, and `.test.ts` is outside both tsconfigs
    // anyway.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      const { pool, attempts } = poolThatAlwaysHitsTheCeiling(time.spend, 20_000)
      const broken = config()
      // Exactly what an omitted field looks like through the cast.
      ;(broken as { reconcilePassDeadlineMs?: number }).reconcilePassDeadlineMs = undefined
      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, broken, time.now)
      const internals = coordinator as unknown as Internals

      const outcome = await internals.performReconcile().then(() => null, (error: unknown) => error)

      expect(isReconcilePassDeadline(outcome)).toBe(false)
      // Every workspace attempted — unbounded, which is the survivable direction.
      expect(attempts()).toBe(WORKSPACES.length)
      expect(coordinator.snapshot().passAbandonedCount).toBe(0)
      // And it SAYS so. Degrading quietly would leave a cell whose pass is
      // unbounded looking exactly like one whose deadline is working.
      const events = warn.mock.calls
        .map(([line]) => (typeof line === 'string' ? line : ''))
        .filter((line) => line.includes('sync.cell.pass_deadline_absent'))
      expect(events).toHaveLength(1)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('a cell that abandoned a pass does not report itself ready', async () => {
    // This is asserted rather than built: `ready` is
    // `ownedWorkspaceCount === expected.size`, and `expected` is populated
    // BEFORE acquisition, so a pass abandoned mid-acquisition already leaves the
    // two unequal. Adding machinery for a property the existing formula gives
    // would be a guard that cannot fail — but leaving it unasserted would let a
    // future change to that formula quietly remove it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const time = simulatedClock()
      const { pool } = poolThatAlwaysHitsTheCeiling(time.spend, 20_000)
      const coordinator = new SyncCellOwnershipCoordinator(pool, REDIS, config(), time.now)
      await coordinator.reconcileNow().catch(() => undefined)

      const snapshot = coordinator.snapshot()
      expect(snapshot.expectedWorkspaceCount).toBe(WORKSPACES.length)
      expect(snapshot.ownedWorkspaceCount).toBeLessThan(snapshot.expectedWorkspaceCount)
      expect(snapshot.ready).toBe(false)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })
})
