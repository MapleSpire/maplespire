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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RedisRuntime } from '../runtime/redis.js'
import { SyncCellOwnershipCoordinator, type SyncCellOwnershipConfig } from './ownership.js'

/**
 * A Redis hiccup during boot degrades the cell; it does not delete it.
 *
 * `RedisRuntime.send` DESTROYS the connection on a command timeout and
 * `disableOfflineQueue: true` makes the next command throw, so an unguarded
 * blip during boot would propagate out of `start()`, out of `main()`, and exit
 * the process — removing a cell from the fleet instead of degrading it.
 *
 * The reconcile pass itself cannot throw on a Redis blip:
 * `acquirePartitionIfMissing` catches and returns (`ownership.ts`),
 * `acquireMissing` catches per workspace, and `reassertHeldFences` catches its
 * own survey. The await that needs guarding is the topology check
 * (`ensureTopology`) that runs before it.
 *
 * ── TWO FAILURES, TWO ANSWERS ───────────────────────────────────────────────
 *
 * Disagreement is fatal (arm 4). Not being able to ASK is not disagreement, and
 * degrades (arm 1) — but only because the cell then refuses to acquire anything
 * until it has confirmed the contract (arm 3). Without that refusal this change
 * would trade "a blip removes a cell" for "a blip removes the mixed-deployment
 * gate", which is a worse bargain.
 */
describe('a Redis hiccup during boot degrades the cell rather than removing it', () => {
  function config(overrides: Partial<SyncCellOwnershipConfig> = {}): SyncCellOwnershipConfig {
    return {
      enabled: true,
      cellId: 'cell-a',
      advertiseUrl: null,
      leaseTtlMs: 600_000,
      renewIntervalMs: 200_000,
      partitionLeaseTtlMs: 600_000,
      partitionRenewIntervalMs: 200_000,
      partitionProbeIntervalMs: 600_000,
      partitionWorker: false,
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      reconcilePassDeadlineMs: 300_000,
      concurrency: 4,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: 'v1',
      ...overrides,
    } as SyncCellOwnershipConfig
  }

  let topologyValue: string | null = null
  beforeEach(() => { topologyValue = null })
  const pool = {
    async query(text: string, values?: unknown[]) {
      if (text.includes('SELECT value FROM sync_topology_contract')) {
        return { rows: topologyValue === null ? [] : [{ value: topologyValue }], rowCount: topologyValue === null ? 0 : 1 }
      }
      if (text.includes('INSERT INTO sync_topology_contract')) {
        const value = String(values?.[0])
        if (topologyValue !== null && topologyValue !== value) return { rows: [], rowCount: 0 }
        topologyValue = value
        return { rows: [{ value }], rowCount: 1 }
      }
      if (text.includes('SELECT landscape_id, id FROM versions')) {
        return { rows: [{ landscape_id: 'landscape-1', id: 'version-a' }], rowCount: 1 }
      }
      if (text.includes('current_setting')) {
        return { rows: [{ statement_timeout: '30s', lock_timeout: '2s' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool

  /** What a destroyed connection produces on the NEXT command: node-redis with
   *  `disableOfflineQueue: true` throws rather than queueing. */
  const DEAD_CONNECTION = 'Stream isn\'t writeable and enableOfflineQueue options is false'

  interface RedisOptions {
    /** 2 = created, 1 = matched, 0 = DISAGREES. */
    topology?: number
    /** Whether the TOPOLOGY command can be answered at all. Separate from
     *  `healthy` on purpose: with both tied to one switch, "refused because the
     *  contract is unconfirmed" and "failed because Redis is dead" produce the
     *  same observation, so deleting the refusal would change nothing any arm
     *  could see. */
    topologyReadable?: () => boolean
    healthy?: () => boolean
  }

  function fakeRedis(options: RedisOptions = {}): RedisRuntime {
    const alive = options.healthy ?? (() => true)
    const canReadTopology = options.topologyReadable ?? (() => true)
    return {
      configured: true,
      ready: true,
      prefix: 'test',
      async send(args: string[]) {
        const script = args[1] ?? ''
        if (script.includes('redis.call(\'SET\', KEYS[1], ARGV[1])')) {
          if (!canReadTopology()) throw new Error(DEAD_CONNECTION)
          return options.topology ?? 2
        }
        if (!alive()) throw new Error(DEAD_CONNECTION)
        if (args[0] === 'GET') return null
        if (args[0] === 'MGET') return args.slice(1).map(() => null)
        if (script.includes('local minimum = tonumber(ARGV[1])')) return 1
        if (script.includes('redis.call(\'INCR\'')) return ['1', 'cell-a|1']
        if (script.includes('redis.call(\'PEXPIRE\'')) return 1
        if (script.includes('redis.call(\'DEL\'')) return 1
        return 0
      },
    } as unknown as RedisRuntime
  }

  const quiet = () => ({
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  })

  it('start() RESOLVES when the topology contract cannot be read', async () => {
    const spies = quiet()
    try {
      const coordinator = new SyncCellOwnershipCoordinator(
        pool,
        fakeRedis({ topologyReadable: () => false, healthy: () => false }),
        config(),
      )

      // THE CLAUSE. Rejecting here would make `main()` exit, and the cell would
      // be absent from the fleet for a transient Redis blip.
      await expect(coordinator.start()).resolves.toBeUndefined()

      const snapshot = coordinator.snapshot()
      expect(snapshot.bootReconcileFailed).toBe(true)
      expect(snapshot.topologyConfirmed).toBe(false)
      expect(snapshot.ready).toBe(false)
      expect(snapshot.errorCount).toBeGreaterThan(0)
      // And it SAYS so. A cell that started holding nothing, silently, is worse
      // than one that failed loudly — the operator has no reason to look.
      const said = spies.warn.mock.calls
        .map(([line]) => (typeof line === 'string' ? line : ''))
        .filter((line) => line.includes('sync.cell.started_degraded'))
      expect(said).toHaveLength(1)

      await coordinator.stop().catch(() => undefined)
    } finally {
      spies.warn.mockRestore()
      spies.log.mockRestore()
    }
  })

  it('a healthy boot confirms the contract and is not degraded — the control', async () => {
    // Without this, `bootReconcileFailed: true` cannot be told from a field that
    // is always true, and `start()` resolving cannot be told from a `start()`
    // that does nothing at all.
    const spies = quiet()
    try {
      const coordinator = new SyncCellOwnershipCoordinator(pool, fakeRedis(), config())
      await expect(coordinator.start()).resolves.toBeUndefined()

      const snapshot = coordinator.snapshot()
      expect(snapshot.topologyConfirmed).toBe(true)
      expect(snapshot.bootReconcileFailed).toBe(false)
      expect(snapshot.partitionIndex).not.toBeNull()
      expect(
        spies.warn.mock.calls
          .map(([line]) => (typeof line === 'string' ? line : ''))
          .filter((line) => line.includes('sync.cell.started_degraded')),
      ).toEqual([])

      await coordinator.stop().catch(() => undefined)
    } finally {
      spies.warn.mockRestore()
      spies.log.mockRestore()
    }
  })

  it('acquires NOTHING while the contract is unconfirmed, then recovers when Redis returns', async () => {
    // The two halves that make degrading defensible, in one arm because they are
    // one property. FAIL-CLOSED: an unconfirmed contract must not acquire, or
    // this change would trade a removed cell for a removed gate. RECOVERY: it
    // must re-ask, or "degraded" is a nicer word for dead and arm 1 would still
    // pass.
    const spies = quiet()
    try {
      let topologyReadable = false
      const coordinator = new SyncCellOwnershipCoordinator(
        pool,
        // EVERY OTHER COMMAND WORKS THROUGHOUT. That separation is the arm's
        // whole value: with the acquisition path also broken, "it acquired
        // nothing" would be true whether or not the refusal existed.
        fakeRedis({ topologyReadable: () => topologyReadable }),
        config(),
      )
      await coordinator.start()
      expect(coordinator.snapshot().topologyConfirmed).toBe(false)
      // FAIL-CLOSED: acquisition would succeed right now — the partition scripts
      // are answering — and it must not happen, because the contract is unknown.
      expect(coordinator.snapshot().partitionIndex).toBeNull()
      await coordinator.reconcileNow().catch(() => undefined)
      expect(coordinator.snapshot().partitionIndex).toBeNull()

      // Now the contract becomes readable and the next pass recovers.
      topologyReadable = true
      await coordinator.reconcileNow()

      const recovered = coordinator.snapshot()
      expect(recovered.topologyConfirmed).toBe(true)
      expect(recovered.partitionIndex).not.toBeNull()
      // The boot fact does not un-say itself: it answers "did this cell come up
      // cleanly", which stays false. `ready` answers "is it healthy now".
      expect(recovered.bootReconcileFailed).toBe(true)

      await coordinator.stop().catch(() => undefined)
    } finally {
      spies.warn.mockRestore()
      spies.log.mockRestore()
    }
  })

  it('the PARTITION PROBE also refuses while the contract is unconfirmed', async () => {
    // A SECOND ENTRY POINT. Deleting `if (!this.topologyConfirmed) return`
    // from `acquirePartitionIfMissing` leaves the other arms green, because on
    // the reconcile path
    // `ensureTopologyConfirmed` throws first and acquisition is never reached —
    // the guard is unreachable there.
    //
    // It is not unreachable everywhere: `probePartition`, armed on its own timer
    // and running every `partitionProbeIntervalMs`, calls
    // `acquirePartitionIfMissing` directly and does NOT pass through the pass's
    // confirmation. Without the guard, a cell that started with an unreadable
    // contract would acquire a partition from that timer alone — serving on a
    // topology it has never agreed to, which is the exact fail-open this whole
    // change exists to avoid.
    const spies = quiet()
    try {
      const coordinator = new SyncCellOwnershipCoordinator(
        pool,
        // Every command answers EXCEPT the contract, so acquisition would
        // otherwise succeed and only the refusal can prevent it.
        fakeRedis({ topologyReadable: () => false }),
        config(),
      )
      await coordinator.start()
      expect(coordinator.snapshot().topologyConfirmed).toBe(false)

      const internals = coordinator as unknown as { probePartition: () => Promise<void> }
      await internals.probePartition()

      expect(coordinator.snapshot().partitionIndex).toBeNull()
      expect(coordinator.snapshot().ready).toBe(false)

      await coordinator.stop().catch(() => undefined)
    } finally {
      spies.warn.mockRestore()
      spies.log.mockRestore()
    }
  })

  it('a topology MISMATCH is still fatal — the gate that must fail closed', async () => {
    // The line. "Boot failures should be non-fatal" is true of work and false of
    // gates. Without this arm, a later reading of arm 1 could fold the
    // disagreement case into the same catch and take the fleet's only protection
    // against a mixed deployment with it.
    const spies = quiet()
    try {
      const coordinator = new SyncCellOwnershipCoordinator(pool, fakeRedis({ topology: 0 }), config())
      await expect(coordinator.start()).rejects.toThrow(/topology mismatch/i)
      expect(coordinator.snapshot().topologyConfirmed).toBe(false)
      expect(coordinator.snapshot().ready).toBe(false)
    } finally {
      spies.warn.mockRestore()
      spies.log.mockRestore()
    }
  })
})
