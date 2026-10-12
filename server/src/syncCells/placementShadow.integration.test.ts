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

import { randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from './ownership.js'
import { workspacePartition } from './assignment.js'

/**
 * `workspace_placement` in SHADOW mode: written and compared against the hash,
 * while routing still follows the hash.
 *
 * Switching routing to the stored mapping is only safe once the divergence
 * between placed and hashed partitions is measured at zero — and a zero from a
 * comparison nobody made satisfies that perfectly, which is why the counter is
 * exercised in both directions.
 *
 * BOTH ARMS ARE REQUIRED AND NEITHER PASSES ALONE. A counter that only ever
 * reports zero is indistinguishable from one that works, and a counter that
 * only ever reports non-zero is indistinguishable from one that is broken. The
 * denominator is asserted in both, because a divergence of zero over an empty
 * comparison is the failure this file exists to make impossible.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

const LANDSCAPE = 'landscape-placement'
const WORKSPACE_COUNT = 24
const workspaces = Array.from({ length: WORKSPACE_COUNT }, (_, index) => ({
  landscapeId: LANDSCAPE,
  versionId: `version-${index}`,
}))

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('placement shadow comparison (T-10c)', () => {
  const prefix = `test:placement-shadow:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  let coordinator: SyncCellOwnershipCoordinator

  // TWO PARTITIONS, because at one the comparison has no discriminating power:
  // `workspacePartition` returns 0 for every key, so a mapping that disagrees
  // is indistinguishable from one that agrees. The shadow reports `'void'`
  // there, and the last arm asserts exactly that — it is what production sees.
  // THE GENERATION IS A PARAMETER. The topology contract in Redis records the
  // partition count for a generation, and a cell that arrives with a DIFFERENT
  // count for the same generation is refused — `topologyConfirmed: false`, no
  // partition, no reconcile. Sharing one generation across the two-partition
  // and one-partition arms would make the latter measure a cell that never ran
  // a pass.
  const config = (partitionCount: number, generation: string): SyncCellOwnershipConfig => ({
    enabled: true,
    cellId: 'cell-placement',
    advertiseUrl: null,
    leaseTtlMs: 60_000,
    renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000,
    partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000,
    partitionProbeIntervalMs: 1_000,
    partitionWorker: false,
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount,
    topologyGeneration: generation,
  } as SyncCellOwnershipConfig)

  const TWO = 'placement-shadow-two'
  const ONE = 'placement-shadow-one'

  // A PREFIX PER GENERATION, i.e. a separate CLUSTER per arm. The topology
  // contract is one agreement for the whole Redis prefix, not one per
  // generation name: `ensureTopology` refuses a cell whose (generation, count)
  // pair disagrees with what the prefix already holds, so a distinct generation
  // name alone still throws `SyncCellTopologyMismatchError`.
  const runtime = (generation: string) => ({
    configured: true,
    get ready() { return client.isReady },
    prefix: `${prefix}:${generation}`,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime)

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'placement_shadow')
    await client.connect()
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'Placement'])
    for (const workspace of workspaces) {
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
        [workspace.versionId, workspace.landscapeId, `automerge:root-${workspace.versionId}`],
      )
    }
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)

  afterAll(async () => {
    await coordinator?.stop()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await client.close()
    await db?.teardown()
  })

  beforeEach(async () => {
    await coordinator?.stop()
    // These independent one/two-partition worlds must also reset the durable
    // topology-contract witness in PG; a fresh Redis prefix alone does not
    // define a fresh fleet.
    await db.pool.query('DELETE FROM sync_topology_contract')
    await db.pool.query('DELETE FROM workspace_placement')
    await db.pool.query('DELETE FROM sync_workspace_ownership')
  })

  /** Seed the mapping the way a generator would, optionally flipping one row. */
  async function seedPlacement(
    partitionCount: number,
    flip: string | null,
    generation: string,
    // The subset defaults to every workspace. It is a parameter because
    // `workspace_placement.version_id` carries a REAL foreign key to `versions`
    // — seeding a mapping row for a version that has been deleted is rejected
    // by the database, which is the schema saying the mapping cannot outlive
    // its workspace.
    subset: readonly { landscapeId: string; versionId: string }[] = workspaces,
  ): Promise<void> {
    for (const workspace of subset) {
      const truth = workspacePartition(workspace, partitionCount)
      // A FLIP, never a constant: a fixed wrong number would agree with the hash
      // by accident on roughly half the workspaces, and the divergence count
      // would be a property of the fixture rather than of the mapping.
      const stored = workspace.versionId === flip ? (truth === 0 ? 1 : 0) : truth
      await db.pool.query(
        `INSERT INTO workspace_placement (landscape_id, version_id, partition, topology_generation)
         VALUES ($1, $2, $3, $4)`,
        [workspace.landscapeId, workspace.versionId, stored, generation],
      )
    }
  }

  async function reconcileOnce(partitionCount: number, generation: string) {
    coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(generation), config(partitionCount, generation))
    await coordinator.start()
    await coordinator.reconcileNow()
    return coordinator.snapshot()
  }

  it('snapshot() counts a wrong placement row', async () => {
    await seedPlacement(2, 'version-7', TWO)

    const snapshot = await reconcileOnce(2, TWO)

    expect(snapshot.placementDivergenceCount).toBe(1)
    // THE DENOMINATOR, asserted in the same breath. A divergence of 1 over a
    // comparison of 1 workspace is a different fact from 1 over 24, and the
    // number alone cannot tell them apart.
    expect(snapshot.placementRowsCompared).toBe(WORKSPACE_COUNT)
  }, 60_000)

  it('the control: 24 correct rows diverge on nothing, over the SAME denominator', async () => {
    // NEITHER ARM PASSES ALONE. Without this one, a counter hardcoded to 1
    // satisfies the case above; without the case above, a counter hardcoded to
    // 0 satisfies this one. The equal denominator is what makes the pair a
    // measurement rather than two assertions about different sets.
    await seedPlacement(2, null, TWO)

    const snapshot = await reconcileOnce(2, TWO)

    expect(snapshot.placementDivergenceCount).toBe(0)
    expect(snapshot.placementRowsCompared).toBe(WORKSPACE_COUNT)
  }, 60_000)

  it('an EMPTY mapping is 24 divergences, not a clean zero', async () => {
    // The table exists and nothing has written it. Reporting zero here would be
    // a false PASS — "divergence measured at zero" over a mapping that does not
    // exist.
    const snapshot = await reconcileOnce(2, TWO)

    expect(snapshot.placementDivergenceCount).toBe(WORKSPACE_COUNT)
    expect(snapshot.placementRowsCompared).toBe(WORKSPACE_COUNT)
  }, 60_000)

  it('rows from ANOTHER topology generation are not compared against this hash', async () => {
    // A mapping computed for a previous generation is stale, not wrong.
    // Comparing it would report every workspace as divergent and turn a routine
    // generation bump into what reads as a catastrophe.
    await seedPlacement(2, null, TWO)
    await db.pool.query(`UPDATE workspace_placement SET topology_generation = 'placement-shadow-stale'`)

    const snapshot = await reconcileOnce(2, TWO)

    // Every row is invisible, so every workspace has no mapping — which is 24
    // divergences, the same answer as an empty table, and NOT a clean zero.
    expect(snapshot.placementDivergenceCount).toBe(WORKSPACE_COUNT)
  }, 60_000)

  it('the denominator TRACKS the discovery set — it is measured, not the fixture size', async () => {
    // Every other case here has exactly 24 workspaces, so
    // `placementRowsCompared = workspaces.length` and `= 24` would be
    // indistinguishable without this arm. A denominator that cannot move is not
    // a denominator; it is the fixture size written twice.
    const removed = workspaces.slice(0, 4)
    for (const workspace of removed) {
      await db.pool.query('DELETE FROM versions WHERE id = $1', [workspace.versionId])
    }
    try {
      await seedPlacement(2, null, TWO, workspaces.slice(removed.length))

      const snapshot = await reconcileOnce(2, TWO)

      expect(snapshot.placementRowsCompared).toBe(WORKSPACE_COUNT - removed.length)
      // …and the divergence follows it: the 20 surviving workspaces have correct
      // rows, so the count is 0 over 20 rather than 0 over 24.
      expect(snapshot.placementDivergenceCount).toBe(0)
    } finally {
      await coordinator?.stop()
      for (const workspace of removed) {
        await db.pool.query(
          `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)
           ON CONFLICT (id) DO NOTHING`,
          [workspace.versionId, workspace.landscapeId, `automerge:root-${workspace.versionId}`],
        )
      }
    }
  }, 60_000)

  it('reports VOID at one partition — which is what every shipped manifest runs', async () => {
    // The reading the shipped manifests get: they pin SYNC_CELL_PARTITION_COUNT
    // to 1, where `workspacePartition` returns 0 for every key. A `0` here
    // would be read as "the mapping agrees" when it means "there was nothing to
    // compare".
    // A valid N=1 mapping has only partition 0. An out-of-range row is a
    // malformed read, which must not qualify even this nondiscriminating gauge.
    await seedPlacement(1, null, ONE)

    const snapshot = await reconcileOnce(1, ONE)

    expect(snapshot.placementDivergenceCount).toBe('void')
    expect(snapshot.placementDivergenceCount).not.toBe(0)
    expect(snapshot.placementRowsCompared).toBe(WORKSPACE_COUNT)
  }, 60_000)

  it('keeps an out-of-range N=1 mapping unknown and reports its error while shadow routes by hash', async () => {
    await seedPlacement(1, 'version-7', ONE)
    const warning = vi.spyOn(console, 'warn')
    try {
      const snapshot = await reconcileOnce(1, ONE)

      expect(snapshot.placementDivergenceCount).toBeNull()
      expect(snapshot.placementRowsCompared).toBeNull()
      expect(snapshot.errorCount).toBeGreaterThan(0)
      expect(warning).toHaveBeenCalledWith(
        '[sync-cell] placement-shadow failed:',
        expect.objectContaining({ message: 'Workspace placement outside partition count 1' }),
      )
      expect(snapshot.ownedWorkspaceCount).toBe(WORKSPACE_COUNT)
      for (const workspace of workspaces) {
        expect(coordinator.partitionFor(workspace)).toBe(0)
        expect(coordinator.owns(workspace)).toBe(true)
      }
    } finally {
      warning.mockRestore()
    }
  }, 60_000)
})
