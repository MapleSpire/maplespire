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
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

/**
 * R3 — the WORLD-MISMATCH detector, at cell boot, read-only.
 *
 * WHAT IT SEES THAT THE FENCE-DIVERGENCE READING CANNOT. That reading
 * (`fenceDivergencesSeen`) compares the durable fence of every lease THIS CELL
 * HOLDS against the token it writes under. It is the narrowest possible oracle
 * and it is blind to the workspaces nobody has admitted — which, after a
 * restore into a rebuilt Redis, is all of them. This detector asks the wider
 * question: is there a durable fence for which Redis holds no sequence AT ALL?
 *
 * WHY THE TWO ARMS ARE THE WHOLE TEST. A detector that reports N is worth
 * nothing until the same harness has been shown reporting 0 on a healthy
 * world: the arm with Redis INTACT is not decoration, it is what separates
 * "found the mismatch" from "counts every row it sees".
 *
 * AND WHY IT MUST WRITE NOTHING. `updated_at` is compared before and after the
 * boot. A repair here would erase the evidence an operator needs to decide
 * whether a restore happened, and `restore:reset-routing` is the deliberate,
 * operator-driven remedy.
 */
describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('R3 — durable fences with no Redis sequence', () => {
  let db: IsolatedSchemaDb
  let client: Awaited<ReturnType<typeof createClient>>
  /** Mutable ON PURPOSE: a REBUILT Redis is an empty namespace, so each arm
   * that needs one takes a fresh prefix rather than trying to delete its way
   * back to empty (a scan-and-delete would be exercised only if an earlier arm
   * had left keys behind). */
  let prefix: string
  const prefixes: string[] = []
  const freshPrefix = (): string => {
    prefix = `r3-${randomBytes(6).toString('hex')}`
    prefixes.push(prefix)
    return prefix
  }
  const started: SyncCellOwnershipCoordinator[] = []

  const WORKSPACES = [
    { landscapeId: 'landscape-1', versionId: 'version-a', token: 11 },
    { landscapeId: 'landscape-1', versionId: 'version-b', token: 12 },
    { landscapeId: 'landscape-2', versionId: 'version-c', token: 13 },
  ]

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'sync_cell_world_mismatch')
    freshPrefix()
    client = createClient({ url: TEST_REDIS_URL })
    await client.connect()

    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        kind TEXT NOT NULL DEFAULT 'version'
      );
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    for (const landscapeId of [...new Set(WORKSPACES.map((w) => w.landscapeId))]) {
      await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [landscapeId, landscapeId])
    }
    for (const workspace of WORKSPACES) {
      // RETIRED, not active, and this is the whole scenario rather than a
      // convenience. The rows this detector exists to find are precisely the
      // ones no cell will ever admit — a fleet that shrank, a partition count
      // that changed, versions retired while the dump was being taken. A
      // reconcile pass ignores them (`WHERE status = 'active'`), so the
      // fence-divergence reading is structurally blind to them, and the boot that runs the detector acquires nothing — which
      // is what makes "no row was written" an assertion about the DETECTOR
      // instead of an assertion about an idle database.
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url, status)
         VALUES ($1, $2, $1, $3, 'retired')`,
        [workspace.versionId, workspace.landscapeId, `automerge:root-${workspace.versionId}`],
      )
      await db.pool.query(
        `INSERT INTO sync_workspace_ownership (
           landscape_id, version_id, cell_id, fencing_token,
           lease_observed_expires_at, acquired_at, updated_at, released_at
         ) VALUES ($1, $2, 'cell-from-the-dump', $3::bigint,
           NOW() - interval '1 hour', NOW() - interval '1 hour', NOW() - interval '1 hour', NULL)`,
        [workspace.landscapeId, workspace.versionId, workspace.token],
      )
    }
  }, 120_000)

  afterEach(async () => {
    for (const coordinator of started.splice(0)) await coordinator.stop().catch(() => undefined)
  })

  afterAll(async () => {
    // Every namespace this file used, not just the last one.
    for (const used of prefixes) {
      const keys: string[] = []
      for await (const batch of client.scanIterator({ MATCH: `${used}:*`, COUNT: 200 })) {
        if (Array.isArray(batch)) keys.push(...batch)
        else keys.push(batch)
      }
      if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    }
    await client.close()
    await db?.teardown()
  })

  function runtime(): RedisRuntime {
    return {
      configured: true,
      get ready() { return client.isReady },
      prefix,
      send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime
  }

  function config(cellId: string): SyncCellOwnershipConfig {
    return {
      enabled: true,
      cellId,
      advertiseUrl: 'http://r3.internal:3001',
      leaseTtlMs: 60_000,
      renewIntervalMs: 20_000,
      partitionLeaseTtlMs: 30_000,
      partitionRenewIntervalMs: 10_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      reconcileIntervalMs: 600_000,
      telemetryIntervalMs: 600_000,
      reconcilePassDeadlineMs: 300_000,
      concurrency: 4,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: 'r3-world-mismatch',
    } as SyncCellOwnershipConfig
  }

  async function scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = []
    for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      if (Array.isArray(batch)) found.push(...batch)
      else found.push(batch)
    }
    return found
  }

  /**
   * Put the fixture back to "three LIVE durable claims", which is what a restore
   * leaves and what the detector surveys (`WHERE released_at IS NULL`).
   *
   * Needed between arms because `stop()` releases every lease it holds, so an
   * arm that boots and stops leaves three RELEASED rows behind — and the next
   * arm's survey then legitimately sees nothing and reports zero. That zero is
   * correct and useless: it says the rows were released, not that Redis knew
   * them.
   */
  async function relive(): Promise<number> {
    const { rowCount } = await db.pool.query('UPDATE sync_workspace_ownership SET released_at = NULL')
    return rowCount ?? 0
  }

  async function liveDurableRows(): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sync_workspace_ownership WHERE released_at IS NULL',
    )
    return Number(rows[0]!.n)
  }

  async function updatedAtByWorkspace(): Promise<Map<string, string>> {
    const { rows } = await db.pool.query<{ k: string; updated_at: string }>(`
      SELECT landscape_id || '/' || version_id AS k, updated_at::text AS updated_at
        FROM sync_workspace_ownership ORDER BY 1
    `)
    return new Map(rows.map((row) => [row.k, row.updated_at]))
  }

  async function bootAndCapture(cellId: string): Promise<{
    lines: Array<Record<string, unknown>>
    coordinator: SyncCellOwnershipCoordinator
  }> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config(cellId))
    started.push(coordinator)
    try {
      await coordinator.start()
      // Captured BEFORE `mockRestore`, which clears `mock.calls` as well as
      // restoring the original — read them afterwards and the array is empty,
      // and the assertion passes on an implementation that logs nothing.
      const lines = warn.mock.calls
        .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return null } })
        .filter((value): value is Record<string, unknown> => value !== null)
      return { lines, coordinator }
    } finally {
      warn.mockRestore()
    }
  }

  it('reports every durable fence whose Redis sequence is gone, and writes nothing', async () => {
    // The restore, made literal: the database keeps its ownership rows and
    // Redis has been REBUILT — an empty namespace, which is what a rebuilt
    // Redis is.
    freshPrefix()
    await relive()
    // Asserted, not assumed: a survey with nothing to survey reports zero
    // missing sequences, and that zero would look exactly like a healthy world.
    expect(await liveDurableRows()).toBe(WORKSPACES.length)

    const before = await updatedAtByWorkspace()
    expect(before.size).toBe(WORKSPACES.length)

    const { lines, coordinator } = await bootAndCapture('cell-r3-restored')

    const detail = lines.filter((line) => line.event === 'sync.cell.durable_fence_without_sequence')
    expect(detail).toHaveLength(WORKSPACES.length)
    expect(detail.map((line) => line.versionId).sort()).toEqual(['version-a', 'version-b', 'version-c'])
    // The durable token is carried on the line: without it the operator knows
    // that something is wrong and not how far the sequence has to be raised.
    expect(detail.find((line) => line.versionId === 'version-a')).toMatchObject({ durableToken: '11' })

    const summary = lines.filter((line) => line.event === 'sync.cell.durable_fence_without_sequence_summary')
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({ withoutSequence: 3, durableRows: 3, suppressedDetailLines: 0 })
    expect(coordinator.snapshot().durableFencesWithoutSequence).toBe(3)

    // READ-ONLY, and against BOTH stores: Redis is where a repair would be
    // cheapest to write by accident. `MGET` creates nothing; this is what says
    // so.
    expect(await updatedAtByWorkspace()).toEqual(before)
    expect(await scanKeys(`${prefix}:sync-cell:fence:*`)).toEqual([])
    // And the boot really did acquire nothing, so the assertion above is about
    // the DETECTOR and not about a database nobody touched for other reasons.
    expect(coordinator.snapshot().acquisitionCount).toBe(0)
    expect(coordinator.snapshot().expectedWorkspaceCount).toBe(0)
    // The fence-divergence reading sees NOTHING here, and that asymmetry is the
    // reason this detector exists: the cell holds no lease on these
    // workspaces, so it has nothing to compare.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
  }, 60_000)

  it('reports ZERO on the same harness once Redis knows the workspaces', async () => {
    // THE CONTROL, and it is not decoration: a
    // detector that counted every durable row would have produced 3 above and
    // 3 here, and the arm above would have looked like a finding.
    //
    // The healthy world is reached the way PRODUCTION reaches it, not by
    // writing Redis keys from the test — which would duplicate the key
    // derivation and drift from it. Make the versions active, boot once so
    // `acquireMissing` mints the sequences, then retire them again so the
    // second boot is the same shape as the arm above in every respect except
    // the one under test.
    await db.pool.query("UPDATE versions SET status = 'active'")
    const seeding = await bootAndCapture('cell-r3-seeding')
    expect(seeding.coordinator.snapshot().acquisitionCount).toBe(3)
    await seeding.coordinator.stop()
    await db.pool.query("UPDATE versions SET status = 'retired'")
    // `stop()` released all three. Put them back to LIVE claims, or the survey
    // below sees nothing and reports zero for a reason that has nothing to do
    // with Redis knowing the workspaces.
    expect(await relive()).toBe(3)
    expect(await liveDurableRows()).toBe(WORKSPACES.length)

    const { lines, coordinator } = await bootAndCapture('cell-r3-healthy')
    expect(lines.filter((line) => String(line.event).startsWith('sync.cell.durable_fence_without_sequence')))
      .toEqual([])
    expect(coordinator.snapshot().durableFencesWithoutSequence).toBe(0)
    // Same shape as the finding arm: nothing admitted, nothing to compare.
    expect(coordinator.snapshot().acquisitionCount).toBe(0)
  }, 90_000)

  it('reads BEFORE the first reconcile, which is the only moment the answer exists', async () => {
    // The PLACE is load-bearing and the two arms above cannot see it: with
    // retired versions a reconcile acquires nothing, so moving the detector
    // after it changes no number. Here the versions are ACTIVE and Redis has
    // been flushed, so `acquireMissing` would mint every sequence the detector
    // is looking for. Run a moment later and it reports zero — for the same
    // reason a census taken after the repair reports a healthy population.
    freshPrefix()
    await db.pool.query("UPDATE versions SET status = 'active'")
    await relive()
    expect(await liveDurableRows()).toBe(WORKSPACES.length)

    const { coordinator } = await bootAndCapture('cell-r3-ordering')
    // The boot DID go on to admit all three — so the reading was taken in the
    // window between the topology check and the acquisitions, and nowhere else.
    expect(coordinator.snapshot().acquisitionCount).toBe(3)
    expect(coordinator.snapshot().durableFencesWithoutSequence).toBe(3)
  }, 90_000)
})
