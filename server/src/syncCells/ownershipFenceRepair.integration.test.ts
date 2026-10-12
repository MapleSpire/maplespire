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
import pg from 'pg'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StorageKey } from '@automerge/automerge-repo'
import { PostgresStorageAdapter, StaleSyncCellWriteError } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from './ownership.js'

/**
 * The fence-divergence REPAIR (R1) — the causes the wedge bench does not reach.
 *
 * `ownershipFenceWedge.integration.test.ts` covers `belowLive` (the restore
 * that lowers a token) and `aboveLive` (a foreign cell's newer row). This file
 * covers the other two, and one property that needs more than one workspace to
 * state at all:
 *
 *   1. ABSENT — the durable row is DELETED rather than lowered. The gate
 *      refuses both the same way, and an implementation that repaired only an
 *      UPDATE would look correct against the lowering arm alone.
 *   2. ONE DIVERGENT WORKSPACE MUST NOT ABORT THE PASS. With a single unguarded
 *      `persistLease` inside the loop, one workspace whose repair throws takes
 *      every other held lease's repair down with it, every reconcile interval,
 *      with the error counter as the only symptom. Stating that needs a pass
 *      containing BOTH a repairable workspace and a skipped one.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
/**
 * Both must be REAL Automerge document ids (generated from a `Repo`), not
 * hand-edited ones: `documentIdFromKey` returns `null` unless the id passes
 * base58check, so an invented id has no `document_mapping` row, the write
 * takes the unmapped path, and the gate ADMITS it — failing the refusal
 * assertions for a reason unrelated to fences.
 */
const DOCUMENT_ID = 'kE8ZRtuA758kFm9tC39X8SjZpYK'
const AHEAD_DOCUMENT_ID = '3kv4crAKHyFcBvt64xRSnBnUdkTA'
const LANDSCAPE = 'landscape-repair'
const REPAIRABLE = { landscapeId: LANDSCAPE, versionId: 'version-repairable' }
const AHEAD = { landscapeId: LANDSCAPE, versionId: 'version-ahead' }

interface ArmVerdict { permitted: boolean; reason: string | null }

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('R1 repair — absent rows, and one workspace not aborting the pass', () => {
  const prefix = `test:fence-repair:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  let coordinator: SyncCellOwnershipCoordinator
  let adapter: PostgresStorageAdapter

  const config: SyncCellOwnershipConfig = {
    enabled: true,
    cellId: 'cell-repair',
    advertiseUrl: null,
    leaseTtlMs: 60_000,
    renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000,
    partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000,
    partitionProbeIntervalMs: 1_000,
    partitionWorker: false,
    // Every reconcile this suite observes is one it asked for by name.
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount: 1,
    topologyGeneration: 'fence-repair-v1',
  } as SyncCellOwnershipConfig

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'sync_cell_fence_repair')
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
      CREATE SEQUENCE automerge_arrival_seq;
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      );
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'Repair'])
    for (const [workspace, documentId] of [[REPAIRABLE, DOCUMENT_ID], [AHEAD, AHEAD_DOCUMENT_ID]] as const) {
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
        [workspace.versionId, workspace.landscapeId, `automerge:${documentId}`],
      )
    }
    await ensureSyncCellOwnershipSchema(db.pool)
    for (const [workspace, documentId] of [[REPAIRABLE, DOCUMENT_ID], [AHEAD, AHEAD_DOCUMENT_ID]] as const) {
      await db.pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3)`,
        [documentId, workspace.landscapeId, workspace.versionId],
      )
    }

    const runtime = {
      configured: true,
      get ready() { return client.isReady },
      prefix,
      send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime

    coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    await coordinator.start()
    adapter = new PostgresStorageAdapter({ db: db.pool, ownership: coordinator })
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

  async function drive(key: StorageKey): Promise<ArmVerdict> {
    try {
      await adapter.save(key, new Uint8Array([7]))
      return { permitted: true, reason: null }
    } catch (error) {
      return {
        permitted: false,
        reason: error instanceof StaleSyncCellWriteError
          ? error.reason
          // Anything that is not the fence saying no is a harness fault, and it
          // has to reach the reader as itself rather than as a rejection.
          : `unexpected:${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async function durableToken(workspace: typeof REPAIRABLE): Promise<string | null> {
    const { rows } = await db.pool.query<{ fencing_token: string }>(
      `SELECT fencing_token::text FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [workspace.landscapeId, workspace.versionId],
    )
    return rows[0]?.fencing_token ?? null
  }

  it('repairs a DELETED durable row, exactly as it repairs a lowered one', async () => {
    // The control first: both workspaces are healthy and both commit. A bench
    // that could only ever reject would not distinguish "the repair worked"
    // from "the harness was mis-wired", and every resolution below would be
    // self-confirming.
    expect(coordinator.owns(REPAIRABLE)).toBe(true)
    expect(await drive([DOCUMENT_ID, 'incremental', 'control'])).toEqual({ permitted: true, reason: null })
    const liveToken = coordinator.fencingToken(REPAIRABLE)
    expect(await durableToken(REPAIRABLE)).toBe(liveToken)

    // The restore that DELETES rather than lowers — a dump taken before the
    // workspace existed, restored over one that does.
    const deleted = await db.pool.query(
      'DELETE FROM sync_workspace_ownership WHERE landscape_id = $1 AND version_id = $2',
      [REPAIRABLE.landscapeId, REPAIRABLE.versionId],
    )
    expect(deleted.rowCount, 'the row was not there to delete — the arm below would measure nothing').toBe(1)
    expect(await durableToken(REPAIRABLE)).toBeNull()

    // Refused, and with the SAME reason as a lowered token: `valid_fence` joins
    // from `document_mapping` and finds no ownership row, so the mapped write
    // fails the fence rather than falling through to the provisional path.
    const beforeRepair = await drive([DOCUMENT_ID, 'incremental', 'after-delete'])
    expect(beforeRepair.permitted).toBe(false)
    expect(beforeRepair.reason).toBe('fence-mismatch')

    const repairsBefore = coordinator.snapshot().fenceRepairCount
    await coordinator.reconcileNow()

    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore + 1)
    expect(coordinator.snapshot().fenceDivergenceByCause).toMatchObject({ absent: 1, belowLive: 0 })
    // The row is back, AT THE LIVE TOKEN. Not merely present: a repair that
    // inserted some other token would leave the workspace wedged in a new way.
    expect(await durableToken(REPAIRABLE)).toBe(liveToken)
    // And service is restored — the assertion the criterion actually names.
    expect(await drive([DOCUMENT_ID, 'incremental', 'after-repair']))
      .toEqual({ permitted: true, reason: null })
  }, 60_000)

  it('repairs one workspace in the same pass where another is deliberately skipped', async () => {
    // One `persistLease` inside the loop without its own catch, and the
    // workspace whose repair throws takes every other held lease down with it —
    // every reconcile interval, with the error counter as the only symptom.
    //
    // `AHEAD` is put five tokens ahead, which is the state `persistLease`
    // REFUSES (`WHERE fencing_token <= EXCLUDED`) and therefore the state that
    // makes it throw if it is ever called. `REPAIRABLE` is deleted, which is
    // the state that must still be repaired in the same pass.
    const aheadLive = coordinator.fencingToken(AHEAD)
    expect(aheadLive).not.toBeNull()
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET fencing_token = fencing_token + 5
       WHERE landscape_id = $1 AND version_id = $2`,
      [AHEAD.landscapeId, AHEAD.versionId],
    )
    const aheadToken = String(BigInt(aheadLive!) + 5n)
    expect(await durableToken(AHEAD)).toBe(aheadToken)

    const repairableLive = coordinator.fencingToken(REPAIRABLE)
    await db.pool.query(
      'DELETE FROM sync_workspace_ownership WHERE landscape_id = $1 AND version_id = $2',
      [REPAIRABLE.landscapeId, REPAIRABLE.versionId],
    )

    const repairsBefore = coordinator.snapshot().fenceRepairCount
    const failuresBefore = coordinator.snapshot().fenceRepairFailureCount
    const errorsBefore = coordinator.snapshot().errorCount
    await coordinator.reconcileNow()

    // TWO divergences seen, ONE repaired.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(2)
    expect(coordinator.snapshot().fenceDivergenceByCause).toMatchObject({ absent: 1, aboveLive: 1 })
    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore + 1)
    // Not attempted, so not failed — the difference between "skipped by design"
    // and "tried and threw" is the difference between a working remedy and one
    // whose failure mode is invisible. Asserted as a DELTA: an absolute
    // `toBe(0)` could pass because the counter happened to be 0 for reasons
    // this arm does not control.
    expect(coordinator.snapshot().fenceRepairFailureCount).toBe(failuresBefore)
    expect(coordinator.snapshot().errorCount).toBe(errorsBefore)

    // The repairable one was repaired…
    expect(await durableToken(REPAIRABLE)).toBe(repairableLive)
    expect(await drive([DOCUMENT_ID, 'incremental', 'mixed-pass-repaired']))
      .toEqual({ permitted: true, reason: null })
    // …and the skipped one is untouched, still held, still refusing.
    expect(await durableToken(AHEAD)).toBe(aheadToken)
    expect(coordinator.owns(AHEAD)).toBe(true)
    expect(coordinator.fencingToken(AHEAD)).toBe(aheadLive)
    const aheadWrite = await drive([AHEAD_DOCUMENT_ID, 'incremental', 'mixed-pass-skipped'])
    expect(aheadWrite.permitted).toBe(false)
    expect(aheadWrite.reason).toBe('fence-mismatch')
  }, 60_000)

  it('does not resurrect a row that R2 released BETWEEN the survey and the repair', async () => {
    // Why the repair carries its skip in the STATEMENT rather than only in the
    // survey's snapshot. Deciding `released` from the row the survey read, one
    // or more round trips before the write, lets an operator's
    // `restore:reset-routing --apply --force` in between have every released
    // row silently re-acquired by `persistLease`'s upsert (which sets
    // `released_at = NULL`), counted as a repair.
    //
    // A serial battery cannot see this: it needs a writer INSIDE the pass. The
    // coordinator's own `db` is the seam.
    const liveToken = coordinator.fencingToken(REPAIRABLE)
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET fencing_token = fencing_token - 1
       WHERE landscape_id = $1 AND version_id = $2`,
      [REPAIRABLE.landscapeId, REPAIRABLE.versionId],
    )

    const internals = coordinator as unknown as { db: { query: (text: string, values?: unknown[]) => Promise<unknown> } }
    const realDb = internals.db
    let injected = false
    internals.db = {
      async query(text: string, values?: unknown[]) {
        const result = await db.pool.query(text, values as never)
        // After the survey, before the repair: reset-routing's single statement.
        if (!injected && Array.isArray(values?.[0]) && Array.isArray(values?.[1])) {
          injected = true
          await db.pool.query('UPDATE sync_workspace_ownership SET released_at = NOW() WHERE released_at IS NULL')
        }
        return result
      },
    }
    const repairsBefore = coordinator.snapshot().fenceRepairCount
    try {
      await coordinator.reconcileNow()
    } finally {
      internals.db = realDb
    }
    expect(injected, 'the reset was never injected — this arm measured nothing').toBe(true)

    // EVERY row is still released. Not "the one we watched" — all of them, which
    // is what the operator's command promised.
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sync_workspace_ownership WHERE released_at IS NULL',
    )
    expect(rows[0]!.n, 'the repair resurrected a row R2 had just released').toBe('0')
    // The repair was ATTEMPTED and REFUSED by the statement, not skipped by the
    // stale snapshot — so it is reported as a failure rather than as a success.
    // That distinction is the whole point: a silent skip and a refused write
    // look identical in the row count and completely different in the report.
    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore)
    expect(coordinator.snapshot().fenceRepairFailureCount).toBeGreaterThan(0)

    // Put the fixture back for anything that follows.
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET released_at = NULL, fencing_token = $3::bigint
       WHERE landscape_id = $1 AND version_id = $2`,
      [REPAIRABLE.landscapeId, REPAIRABLE.versionId, liveToken],
    )
  }, 60_000)

  // ── The implicit foreign-key lock ───────────────────────────────────────────
  //
  // `sync_workspace_ownership.version_id` carries `REFERENCES versions(id)`, so
  // the INSERT the `absent` cause triggers takes a row lock on the PARENT that
  // appears in no statement anybody wrote — the engine places it. Such
  // implicit locks are a classic source of unseen deadlocks, so the `absent`
  // branch is exercised here with something else touching `versions`.
  //
  // The other two repaired causes do not take it: they UPDATE an existing child
  // row and never re-check the parent.
  //
  // A DEDICATED CLIENT, not one checked out of `db.pool`. The pool is `max: 5`
  // and the coordinator draws from it during the very pass being measured;
  // holding one of its five connections open across a blocking transaction
  // would risk measuring pool starvation and calling it a foreign-key wait.

  async function openBlocker(lockSql: string): Promise<pg.Client> {
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await blocker.connect()
    await blocker.query(`SET search_path TO ${db.schema}, public`)
    await blocker.query('BEGIN')
    await blocker.query(lockSql, [REPAIRABLE.versionId])
    return blocker
  }

  async function makeAbsent(): Promise<string> {
    const liveToken = coordinator.fencingToken(REPAIRABLE)
    expect(liveToken, 'the lease is not held — this arm would measure nothing').not.toBeNull()
    const deleted = await db.pool.query(
      'DELETE FROM sync_workspace_ownership WHERE landscape_id = $1 AND version_id = $2',
      [REPAIRABLE.landscapeId, REPAIRABLE.versionId],
    )
    expect(deleted.rowCount, 'there was no row to delete, so the cause would not be `absent`').toBe(1)
    return liveToken!
  }

  it('an ORDINARY update of the parent `versions` row does not block the repair at all', async () => {
    // THE PRODUCTION-SHAPED CASE. `UPDATE versions SET label = …` touches no key column, so
    // PostgreSQL takes `FOR NO KEY UPDATE` on that row — and the foreign key's
    // check takes `FOR KEY SHARE`, which does NOT conflict with it. The two
    // weaker lock modes exist for exactly this: since 9.3, a parent row being
    // edited no longer blocks a child insert.
    //
    // So the arm is written to FAIL if the repair waits. It is worth an arm
    // rather than a paragraph because the reasoning is about lock modes nobody
    // can see in the SQL, and a future schema change — making `label` part of a
    // unique index, say — would flip the answer silently.
    const liveToken = await makeAbsent()
    const blocker = await openBlocker('UPDATE versions SET label = label || $1 WHERE id = $1')
    try {
      const repairsBefore = coordinator.snapshot().fenceRepairCount
      const startedAt = Date.now()
      await coordinator.reconcileNow()
      const elapsedMs = Date.now() - startedAt

      expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore + 1)
      expect(coordinator.snapshot().fenceDivergenceByCause).toMatchObject({ absent: 1 })
      expect(await durableToken(REPAIRABLE)).toBe(liveToken)
      // The number is the assertion. A repair that waited on the parent would
      // sit here until the ROLLBACK below, which never comes first.
      expect(elapsedMs, `the repair waited ${elapsedMs}ms on a FOR NO KEY UPDATE parent`)
        .toBeLessThan(5_000)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end().catch(() => undefined)
    }
  }, 60_000)

  it('a parent row held FOR UPDATE makes the repair WAIT, not deadlock, and the pass recovers', async () => {
    // `SELECT … FOR UPDATE` is the mode that does
    // conflict with the foreign key's `FOR KEY SHARE` — as does a DELETE of the
    // parent, which is the realistic production shape (a landscape being
    // removed while a reconcile runs).
    //
    // TWO ASSERTIONS, and the second is the one that matters: the INSERT waits
    // rather than failing with `40P01 deadlock detected`, AND the pass is not
    // wedged afterwards. A deadlock would surface here as the pass settling
    // EARLY with a failure, which is why "did it settle" is checked before the
    // lock is released rather than only after.
    const liveToken = await makeAbsent()
    const blocker = await openBlocker('SELECT id FROM versions WHERE id = $1 FOR UPDATE')
    let settled: 'no' | 'ok' | 'threw' = 'no'
    let passError: unknown = null
    try {
      const repairsBefore = coordinator.snapshot().fenceRepairCount
      const pass = coordinator.reconcileNow().then(
        () => { settled = 'ok' },
        (error: unknown) => { settled = 'threw'; passError = error },
      )

      await new Promise((resolve) => setTimeout(resolve, 1_000))
      // Neither finished nor failed: WAITING. A deadlock resolves in
      // milliseconds — PostgreSQL's detector fires on a 1 s default — so
      // `threw` here is the deadlock this arm exists to rule out.
      expect(settled, `the pass settled while the parent was locked: ${String(passError)}`).toBe('no')

      await blocker.query('ROLLBACK')
      await pass

      expect(settled).toBe('ok')
      expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore + 1)
      expect(await durableToken(REPAIRABLE)).toBe(liveToken)
      expect(await drive([DOCUMENT_ID, 'incremental', 'after-parent-lock']))
        .toEqual({ permitted: true, reason: null })

      // NOT WEDGED. The waiting statement held a pool connection and a
      // transaction; if either were left behind, the next pass is where it
      // would show. THE CONTROL IS THIS SAME MEASUREMENT: an unblocked pass
      // completing in well under the second the blocked one could not, which is
      // what distinguishes "it waited on the lock" from "the harness is slow".
      const unblockedAt = Date.now()
      await coordinator.reconcileNow()
      const unblockedMs = Date.now() - unblockedAt
      expect(unblockedMs, `a pass with nothing to wait for took ${unblockedMs}ms`).toBeLessThan(1_000)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end().catch(() => undefined)
    }
  }, 60_000)
})
