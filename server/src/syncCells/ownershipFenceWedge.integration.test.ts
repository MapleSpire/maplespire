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
 * THE DURABLE/LIVE FENCE WEDGE, AND ITS REPAIR.
 *
 * A restore reinstalls `sync_workspace_ownership` from the dump. Redis, which
 * is the LIVE lease authority, is untouched, so the durable fencing token can
 * come back BELOW the live one. Every write by the legitimate live owner is
 * then refused until something puts the durable row back.
 *
 *   A0  control     — a real coordinator holding a real Redis lease commits a
 *                     chunk, and it lands on the MAPPED path.
 *   A1  the wedge   — `UPDATE ... SET fencing_token = fencing_token - 1`. That
 *                     one statement IS the restoration. Drive a mutation and
 *                     record the verdict.
 *   A2  self-repair — `reconcileNow()`, then drive again. The coordinator's own
 *                     reconcile must close the wedge.
 *   A3  durable ahead — the durable token pushed ABOVE the live one (a foreign
 *                     cell's newer row): refused, counted, and NOT repaired.
 *   A4  foreign cell — a foreign `cell_id` at our token: admitted, recorded
 *                     separately, and not repaired.
 *
 * A0 is not decoration: without it a bench that only ever rejects cannot tell
 * "the defect is real" from "the harness is mis-wired", and every rejection
 * below would be self-confirming.
 *
 * A2 needs a liveness witness of its own, which is why this suite has a second
 * workspace: an observation after `reconcileNow()` says nothing unless the pass
 * demonstrably ran. A second active version is inserted immediately before the
 * call and the pass is required to DISCOVER it. Ownership and the live token
 * are re-asserted too, so a reconcile that dropped the lease cannot masquerade
 * as a repair or a wedge.
 *
 * If A1 is ever PERMITTED, the gate no longer refuses a lowered durable token
 * and the whole repair machinery is answering a problem that does not exist —
 * re-examine the design rather than adjusting the assertion.
 *
 * Each arm uses its own storage key on purpose. `save()` of a content chunk
 * passes `coalesceOwnershipUnavailable`, so re-driving one key would return a
 * cached verdict instead of the database's, and A2 would be reading A1's
 * answer back to itself.
 *
 * Live Postgres and live Redis: the wedge is a disagreement BETWEEN the two
 * stores, so a stubbed either side would be the measurement stating its own
 * conclusion. Sibling suites for the two halves in isolation are
 * `automergeStorage.fencing.integration.test.ts` (gate, stubbed token) and
 * `ownership.redis.integration.test.ts` (leases, no storage).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
const DOCUMENT_ID = 'kE8ZRtuA758kFm9tC39X8SjZpYK'
const WORKSPACE = { landscapeId: 'landscape-wedge', versionId: 'version-wedge' }
/** Inserted mid-test, only so A2 can prove its reconcile pass actually ran. */
const LATE_VERSION_ID = 'version-wedge-late'

interface ArmVerdict {
  permitted: boolean
  reason: string | null
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('sync-cell durable/live fence wedge', () => {
  const prefix = `test:fence-wedge:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  let coordinator: SyncCellOwnershipCoordinator
  let adapter: PostgresStorageAdapter

  const config: SyncCellOwnershipConfig = {
    enabled: true,
    cellId: 'cell-wedge',
    advertiseUrl: null,
    leaseTtlMs: 60_000,
    renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000,
    partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000,
    partitionProbeIntervalMs: 1_000,
    partitionWorker: false,
    // Long enough that no background pass can move the durable row between two
    // arms. Every reconcile this suite observes is one it asked for by name.
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    // One partition, so the single cell owns every workspace it discovers and
    // the arms do not depend on where the jump hash lands.
    partitionCount: 1,
    topologyGeneration: 'fence-wedge-v1',
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'sync_cell_fence_wedge')
    await client.connect()

    await db.pool.query(`
      CREATE TABLE landscapes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_version_id TEXT
      )
    `)
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [
      WORKSPACE.landscapeId,
      'Wedge',
    ])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url)
       VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, `automerge:${DOCUMENT_ID}`],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3)`,
      [DOCUMENT_ID, WORKSPACE.landscapeId, WORKSPACE.versionId],
    )

    const runtime = {
      configured: true,
      get ready() { return client.isReady },
      prefix,
      send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime

    // A restore reinstalls a token minted by a PREVIOUS acquisition, so the
    // wedge in production is n-1 against n with both sides non-zero. Against a
    // virgin Redis sequence the coordinator would hold token 1 and the lowering
    // UPDATE would produce 0 — a boundary value that `acquireMissing` also uses
    // as its "no durable row" default. One throwaway cell burns the first token
    // so the measured wedge sits on neither boundary.
    const warmUp = new SyncCellOwnershipCoordinator(db.pool, runtime, {
      ...config,
      cellId: 'cell-wedge-warmup',
    })
    await warmUp.start()
    await warmUp.stop()

    coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    await coordinator.start()
    adapter = new PostgresStorageAdapter({ db: db.pool, ownership: coordinator })
  })

  afterAll(async () => {
    // Order matters: the coordinator writes `released_at` to Postgres on stop,
    // so it has to finish before the schema and the Redis keys go away.
    await coordinator?.stop()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await client.close()
    await db?.teardown()
  })

  async function durableToken(): Promise<string | null> {
    const { rows } = await db.pool.query<{ fencing_token: string }>(
      `SELECT fencing_token::text FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
    return rows[0]?.fencing_token ?? null
  }

  /** Drive one real mutation and RECORD the database's verdict — never infer it. */
  async function driveMutation(arm: string, key: StorageKey): Promise<ArmVerdict> {
    let verdict: ArmVerdict
    try {
      await adapter.save(key, new Uint8Array([7]))
      verdict = { permitted: true, reason: null }
    } catch (error) {
      verdict = {
        permitted: false,
        reason: error instanceof StaleSyncCellWriteError
          ? error.reason
          // Anything that is not the fence saying no is a harness fault, and it
          // has to reach the reader as itself rather than as a rejection.
          : `unexpected:${error instanceof Error ? error.message : String(error)}`,
      }
    }
    console.log(JSON.stringify({
      event: 'b4m.arm',
      arm,
      permitted: verdict.permitted,
      reason: verdict.reason,
      liveToken: coordinator.fencingToken(WORKSPACE),
      durableToken: await durableToken(),
      owns: coordinator.owns(WORKSPACE),
    }))
    return verdict
  }

  it('measures whether a lowered durable token wedges the live owner out, and whether reconcile repairs it', async () => {
    // ---- A0: the control. A bench that cannot commit proves nothing below. ----
    expect(coordinator.snapshot().partitionReady).toBe(true)
    expect(coordinator.owns(WORKSPACE)).toBe(true)
    const liveToken = coordinator.fencingToken(WORKSPACE)
    expect(liveToken).not.toBeNull()
    expect(await durableToken()).toBe(liveToken)
    expect(adapter.snapshot().enabled).toBe(true)

    const before = adapter.snapshot().mappedMutationCount
    const a0 = await driveMutation('A0', [DOCUMENT_ID, 'incremental', 'a0-control'])
    expect(a0).toEqual({ permitted: true, reason: null })
    expect(adapter.snapshot().mappedMutationCount).toBe(before + 1)

    // The fence-divergence detector, on a healthy fixture. `start()` ran a reconcile, so this is
    // a MEASURED zero and not the initial value: null is what the field holds
    // before any pass has looked, and a zero here separates "looked, agreed"
    // from "never looked" — which is the whole reason the field is nullable.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)

    // ---- A1: the restoration, in one statement. ----
    const lowered = await db.pool.query(
      'UPDATE sync_workspace_ownership SET fencing_token = fencing_token - 1',
    )
    // If this touched no row the arm would "confirm" the defect while measuring
    // nothing at all — the wedge has to be installed before it can be observed.
    expect(lowered.rowCount).toBe(1)
    const loweredToken = String(BigInt(liveToken!) - 1n)
    expect(await durableToken()).toBe(loweredToken)

    const a1 = await driveMutation('A1', [DOCUMENT_ID, 'incremental', 'a1-after-restore'])
    // A GREEN HERE IS THE DESIGN'S PREMISE HOLDING. A red because `permitted`
    // is true means the wedge no longer exists: re-examine the design, do not
    // re-assert.
    expect(a1.permitted, 'A1 permitted: the durable/live wedge does not refuse writes — re-scope B4').toBe(false)
    expect(a1.reason).toBe('fence-mismatch')
    expect(await adapter.load([DOCUMENT_ID, 'incremental', 'a1-after-restore'])).toBeUndefined()

    // ---- A2: does the coordinator repair itself? ----
    // The liveness witness. Without it, deleting `reconcileNow()` below leaves
    // this arm green — an absent pass and a pass that repairs nothing produce
    // the identical observation.
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url)
       VALUES ($1, $2, 'Late', $3)`,
      [LATE_VERSION_ID, WORKSPACE.landscapeId, `automerge:${DOCUMENT_ID}`],
    )
    expect(coordinator.snapshot().expectedWorkspaceCount).toBe(1)

    await coordinator.reconcileNow()

    // The pass ran, and it did the normal work of a pass: it discovered the new
    // workspace, took its lease and wrote its durable row. Anything it failed to
    // do to the wedged row below, it failed to do while demonstrably awake and
    // demonstrably able to write to this very table.
    expect(coordinator.snapshot().expectedWorkspaceCount).toBe(2)
    expect(coordinator.owns({ landscapeId: WORKSPACE.landscapeId, versionId: LATE_VERSION_ID })).toBe(true)
    // Asserted directly rather than inferred from owns(): the comment above
    // claims the pass WROTE to this table, and that claim is what makes the
    // untouched wedged row a choice of code path instead of an inability.
    const { rows: late } = await db.pool.query<{ fencing_token: string }>(
      `SELECT fencing_token::text FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2 AND released_at IS NULL`,
      [WORKSPACE.landscapeId, LATE_VERSION_ID],
    )
    expect(late).toHaveLength(1)
    // "Still refused" is only about the wedge while the cell still believes it
    // owns the workspace at the same live token. If reconcile had dropped the
    // lease, the next rejection would be a different mechanism wearing the same
    // reason string.
    expect(coordinator.owns(WORKSPACE)).toBe(true)
    expect(coordinator.fencingToken(WORKSPACE)).toBe(liveToken)
    expect(coordinator.snapshot().partitionReady).toBe(true)

    // ---- A2: the same pass that detects the wedge closes it. ----
    const a2 = await driveMutation('A2', [DOCUMENT_ID, 'incremental', 'a2-after-reconcile'])
    expect(a2, 'the repair did not restore service — B4-3 is inert').toEqual({ permitted: true, reason: null })
    // The durable row is back at the live token. Not "changed" — EQUAL to the
    // token this cell writes under, which is the only value that unwedges it.
    expect(await durableToken()).toBe(liveToken)
    expect(coordinator.snapshot().fenceRepairCount).toBe(1)
    expect(coordinator.snapshot().fenceRepairFailureCount).toBe(0)

    // The divergence was still SEEN — one, not two. Two leases are held and only
    // the wedged one diverged, so this number is also the discrimination: a
    // detector that counted every held lease would read 2 here and be
    // indistinguishable from a working one on a single-workspace fixture.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)
    expect(coordinator.snapshot().fenceDivergenceByCause).toEqual({
      belowLive: 1, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0,
    })
    expect(coordinator.owns({ landscapeId: WORKSPACE.landscapeId, versionId: LATE_VERSION_ID })).toBe(true)

    // ---- The RELEASED cause, against the real column rather than a fake. ----
    // The unit file feeds `released` to the detector directly, so replacing the
    // SQL's `(released_at IS NOT NULL)` with a literal `false` was invisible
    // there. Here it is the column. This cause matters on its own account: it
    // is the SUCCESS condition of `restore:reset-routing`, so the breakdown is
    // what keeps a completed reset from reading as a wedge.
    await db.pool.query(
      'UPDATE sync_workspace_ownership SET released_at = NOW() WHERE landscape_id = $1 AND version_id = $2',
      [WORKSPACE.landscapeId, LATE_VERSION_ID],
    )
    const repairsBefore = coordinator.snapshot().fenceRepairCount
    await coordinator.reconcileNow()
    // ONE divergence, not two: the wedged row was repaired by the previous
    // pass, so only the newly released neighbour disagrees now.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)
    expect(coordinator.snapshot().fenceDivergenceByCause).toEqual({
      belowLive: 0, aboveLive: 0, released: 1, absent: 0, foreignCellAtSameToken: 0,
    })
    // AND IT WAS NOT REPAIRED. `persistLease`'s upsert sets
    // `released_at = NULL`, so a repair here would undo an operator's
    // `restore:reset-routing` within one reconcile interval and count the
    // struggle as a repair.
    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBefore)
    const { rows: stillReleased } = await db.pool.query<{ released: boolean }>(
      `SELECT (released_at IS NOT NULL) AS released FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, LATE_VERSION_ID],
    )
    expect(stillReleased[0]!.released, 'the repair re-acquired a released row — R2 is annulled').toBe(true)
    // Put it back by hand, because nothing else will.
    await db.pool.query(
      'UPDATE sync_workspace_ownership SET released_at = NULL WHERE landscape_id = $1 AND version_id = $2',
      [WORKSPACE.landscapeId, LATE_VERSION_ID],
    )

    // ---- A3: `durable > live`. ----
    // The shape of a row written by a FOREIGN cell that acquired after this
    // one: the durable fence is ahead, and this cell's live token is the stale
    // side.
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET fencing_token = fencing_token + 5
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
    const aheadToken = String(BigInt(liveToken!) + 5n)
    expect(await durableToken()).toBe(aheadToken)

    const repairsBeforeAhead = coordinator.snapshot().fenceRepairCount
    const errorsBeforeAhead = coordinator.snapshot().errorCount
    await coordinator.reconcileNow()

    const a3 = await driveMutation('A3', [DOCUMENT_ID, 'incremental', 'a3-durable-ahead'])
    // Still refused, and with the same reason: the gate compares by EQUALITY,
    // so a durable token five ahead refuses exactly as one behind does.
    expect(a3.permitted).toBe(false)
    expect(a3.reason).toBe('fence-mismatch')
    // THE LEASE IS KEPT. A cell that dropped its lease on seeing a higher
    // durable token would stop serving a workspace it still holds in Redis, and
    // the next rejection would be a different mechanism wearing the same reason.
    expect(coordinator.owns(WORKSPACE)).toBe(true)
    expect(coordinator.fencingToken(WORKSPACE)).toBe(liveToken)
    // COUNTED AND NAMED as its own cause…
    expect(coordinator.snapshot().fenceDivergenceByCause).toMatchObject({ aboveLive: 1, belowLive: 0 })
    // …and NOT repaired. `persistLease` guards on `fencing_token <= EXCLUDED`,
    // so an attempt would return zero rows and THROW — which, in an unguarded
    // loop, aborts the pass for every other held lease and increments the error
    // counter every reconcile interval.
    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBeforeAhead)
    expect(coordinator.snapshot().fenceRepairFailureCount).toBe(0)
    expect(coordinator.snapshot().errorCount).toBe(errorsBeforeAhead)
    expect(await durableToken()).toBe(aheadToken)
    // And the pass did NOT abort: the neighbouring workspace is still held and
    // still surveyed, which is the whole reason the repair is per-workspace.
    expect(coordinator.owns({ landscapeId: WORKSPACE.landscapeId, versionId: LATE_VERSION_ID })).toBe(true)

    expect(adapter.snapshot().rejectedMutationsByReason).toMatchObject({ 'fence-mismatch': 2 })

    // ---- A4: a FOREIGN cell at OUR token — the cause that refuses nothing. ----
    // The arm the unit file cannot state: it feeds `cell_id` to
    // the detector directly, so it can say the cause is counted but not that the
    // GATE lets the write through. `valid_fence` tests `fencing_token` and
    // `released_at` and does not look at `cell_id` at all, which is why this
    // observation sits outside the divergence total. Asserting a refusal here
    // would measure the wrong thing entirely.
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET fencing_token = $3::bigint, cell_id = 'cell-foreign'
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId, liveToken],
    )
    const repairsBeforeForeign = coordinator.snapshot().fenceRepairCount
    const failuresBeforeForeign = coordinator.snapshot().fenceRepairFailureCount
    const errorsBeforeForeign = coordinator.snapshot().errorCount
    await coordinator.reconcileNow()

    const a4 = await driveMutation('A4', [DOCUMENT_ID, 'incremental', 'a4-foreign-cell'])
    // ADMITTED. Two cells now believe they own this workspace at the same token
    // and both can write; that is the state, and this line is the measurement of
    // it rather than a complaint about it.
    expect(a4, 'the gate refused a foreign cell at the same token — it now tests cell_id, and B4-8c\'s premise has moved').toEqual({ permitted: true, reason: null })
    // Outside the total, in its own field.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
    expect(coordinator.snapshot().fenceDivergenceByCause).toEqual({
      belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 1,
    })
    // NOT repaired, and the evidence survives: this cell cannot tell whether it
    // or the other one is the stale believer, and `persistLease` would overwrite
    // the name — leaving the incident with no record of who the other party was.
    expect(coordinator.snapshot().fenceRepairCount).toBe(repairsBeforeForeign)
    // ...and nothing was ATTEMPTED either. Repaired-zero and attempted-then-failed
    // are different facts with different remedies, and only the second would
    // mean the skip is an accident of persistLease refusing rather than a
    // branch this pass chose not to enter.
    expect(coordinator.snapshot().fenceRepairFailureCount).toBe(failuresBeforeForeign)
    expect(coordinator.snapshot().errorCount).toBe(errorsBeforeForeign)
    const { rows: stillForeign } = await db.pool.query<{ cell_id: string }>(
      `SELECT cell_id FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
    expect(stillForeign[0]!.cell_id).toBe('cell-foreign')

    // ---- The divergence count is a reading, not a latch. ----
    // A counter that only ever went up would satisfy the assertions above while
    // being useless as an alarm — it would never clear once a restore had been
    // repaired, and every later pass would report a wedge that no longer exists.
    await db.pool.query(
      `UPDATE sync_workspace_ownership SET fencing_token = $3::bigint, cell_id = 'cell-wedge'
       WHERE landscape_id = $1 AND version_id = $2`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId, liveToken],
    )
    await coordinator.reconcileNow()
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
    // The foreign observation clears with it — it is a reading of the CURRENT
    // rows, and a latched one would go on naming a cell that no longer holds
    // anything.
    expect(coordinator.snapshot().fenceDivergenceByCause).toEqual({
      belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0,
    })

    // ---- The operator has to be able to SEE it. ----
    // Read off the real `sync.cell.ownership` emission rather than inferred
    // from the snapshot spreading into it. `stop()` emits one and is guarded against a second
    // entry, which makes the afterAll's own stop a no-op — so this has to be
    // the last thing the test does with the coordinator.
    const lines: string[] = []
    const realLog = console.log
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      await coordinator.stop()
    } finally {
      console.log = realLog
    }
    const telemetry = lines
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((value): value is Record<string, unknown> => value?.event === 'sync.cell.ownership')
    expect(telemetry, 'stop() emitted no sync.cell.ownership line — the assertion below would pass vacuously').toHaveLength(1)
    expect(telemetry[0]).toHaveProperty('fenceDivergencesSeen')
    // NULL, and that is the guard working rather than a gap. `stop()` releases
    // every lease and then logs, so by the time this line is written the set the
    // last reading described no longer exists. Publishing the 0 it used to hold
    // would have a cell that owns nothing go on reporting a number about leases
    // it released.
    expect(telemetry[0]!.fenceDivergencesSeen).toBeNull()
    expect(telemetry[0]!.ownedWorkspaceCount).toBe(0)

    console.log(JSON.stringify({
      event: 'b4m.verdict',
      wedgeRefusesWrites: !a1.permitted && a1.reason === 'fence-mismatch',
      reconcileRepairsIt: a2.permitted,
      durableTokenAfterRepair: liveToken,
      liveToken,
      durableAheadStillRefuses: !a3.permitted && a3.reason === 'fence-mismatch',
      durableAheadIsNotRepaired: true,
    }))
  })
})
