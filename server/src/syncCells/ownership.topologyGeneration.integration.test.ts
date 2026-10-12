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

import { createHash, randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore,
  FencedWorkspaceLeaseStore,
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  syncCellOwnershipConfig,
  type SyncCellOwnershipConfig,
} from './ownership.js'

/**
 * FALSIFY: can two cells on DIFFERENT topology generations both own one
 * workspace?
 *
 * ## The asymmetry the question comes from
 *
 * Three Redis keys, and only two of them carry the generation:
 *
 *   - the topology contract — `<prefix>:sync-cell:topology`, ONE key for the
 *     fleet, holding `<generation>|<partitionCount>`;
 *   - the partition lease — `<prefix>:sync-cell:partition:<generation>:<n>`,
 *     generation-SCOPED;
 *   - the workspace owner — `<prefix>:sync-cell:owner:<sha256>`, NOT scoped.
 *
 * `ensureTopology` has exactly one production call site, inside `start()`, and a
 * running coordinator never re-reads it. So a cell that started on `v1` keeps
 * believing it holds its partition after the contract is rewritten to `v2` —
 * and a `v2` cell contends for a DIFFERENT partition key, so it wins one
 * immediately. Then `ACQUIRE_WORKSPACE_FOR_PARTITION_SCRIPT` overwrites the
 * unscoped workspace owner key once its partition proof passes.
 *
 * ARM 1 states the consequence. ARM 2 is its control: without a green arm
 * proving the harness can watch the single-owner property HOLD, a red arm 1 is
 * indistinguishable from a broken fixture.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

const LANDSCAPE = 'landscape-generation'
const WORKSPACE = { landscapeId: LANDSCAPE, versionId: 'version-a' }

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('topology generation skew (T-13c)', () => {
  const prefix = `test:generation-skew:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  const running: SyncCellOwnershipCoordinator[] = []

  const runtime = () => ({
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime)

  const config = (cellId: string, generation: string): SyncCellOwnershipConfig => ({
    ...syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId, SYNC_CELL_TOPOLOGY_GENERATION: generation }),
    enabled: true,
    cellId,
    advertiseUrl: null,
    leaseTtlMs: 60_000,
    renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000,
    partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000,
    partitionProbeIntervalMs: 1_000,
    partitionWorker: false,
    // Every reconcile this suite observes is one it asked for by name: an
    // interval firing between the two coordinators would let A's renewal
    // discover the theft and repair the very state being measured.
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount: 1,
  })

  async function boot(cellId: string, generation: string): Promise<SyncCellOwnershipCoordinator> {
    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config(cellId, generation))
    running.push(coordinator)
    await coordinator.start()
    await coordinator.reconcileNow()
    return coordinator
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'generation_skew')
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
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'Generation'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, 'automerge:root-a'],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)

  afterEach(async () => {
    while (running.length > 0) await running.pop()?.stop()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    await db.pool.query('DELETE FROM sync_topology_contract')
  })

  afterAll(async () => {
    await client.close()
    await db?.teardown()
  })

  // ── The steal itself, at the store, both ways ───────────────────────────────
  //
  // These arms execute the script's ALLOW path over a LIVE incumbent — the
  // `if current then … end` block. Nothing else does: unit tests run against a
  // fake, and the two-cell failover test hands over after `stop()`, which
  // DELETES the owner key, so the replacement takes the absent-key path.
  // Without these arms, stealing could be deleted outright — or narrowed to
  // `if generation ~= nil then refuse` — and a cell that died ungracefully
  // would strand every one of its workspaces for a second full lease TTL. The
  // steal IS the system's only atomic exclusivity proof.
  //
  // At the STORE rather than through two coordinators, deliberately: a
  // coordinator hand-over goes through `stop()` and never produces a live
  // incumbent.

  function stores(generation: string) {
    const redis = runtime()
    const effective = config('fixture-identity', generation).effectiveGeneration
    return {
      workspace: new FencedWorkspaceLeaseStore(redis, effective),
      partition: new FencedPartitionLeaseStore(redis, effective),
    }
  }

  async function ownerValue(): Promise<string | null> {
    const digest = createHash('sha256')
      .update(`${WORKSPACE.landscapeId}\0${WORKSPACE.versionId}`)
      .digest('hex')
    const value = await client.sendCommand(['GET', `${prefix}:sync-cell:owner:${digest}`])
    return value === null || value === undefined ? null : String(value)
  }

  it('the STEAL still happens within one generation — a live incumbent is taken over atomically', async () => {
    const gen = stores('gen-v1')

    // A holds the workspace and is STILL LIVE — no release, no expiry. This is
    // the state a cell that died ungracefully leaves behind.
    const incumbent = await gen.workspace.acquire(WORKSPACE, 'cell-a', 60_000)
    expect(incumbent).not.toBeNull()
    expect(await ownerValue()).toBe(`cell-a|${incumbent!.token}|gen-v1.ce1461953e2b8ac2`)

    // B proves it holds the partition — which is what the whole steal is
    // conditioned on, and what a replacement acquires once A's partition lease
    // has expired.
    const partition = await gen.partition.acquire(0, 'cell-b', 60_000, null)
    expect(partition).not.toBeNull()

    const stolen = await gen.workspace.acquireForPartition(
      WORKSPACE, 'cell-b', 60_000, gen.partition.proof(0, partition!),
    )

    // TAKEN, over a live key, with a HIGHER token — the fence is what makes the
    // hand-over safe, and a steal that reused the incumbent's token would let
    // A's in-flight writes through.
    expect(stolen.acquired, 'the same-generation steal was refused — atomic failover is gone')
      .not.toBeNull()
    expect(BigInt(stolen.acquired!.token)).toBeGreaterThan(BigInt(incumbent!.token))
    expect(await ownerValue()).toBe(`cell-b|${stolen.acquired!.token}|gen-v1.ce1461953e2b8ac2`)
  }, 60_000)

  it('a PRE-UPGRADE lease carrying no generation is still stealable — the rolling upgrade can make progress', async () => {
    // THE THIRD BRANCH OF THE GUARD. Deleting `generation ~= nil and` —
    // leaving `if generation ~= ARGV[4] then refuse` — is the shape of the code
    // somebody writes when they simplify the condition, and only this arm
    // catches it.
    //
    // WHAT IT WOULD COST. Leases written by a binary predating generations are
    // two-component values. Under that simplification every one of them is
    // unstealable, so an upgrade stops being a rolling one: each workspace
    // waits out a full `leaseTtlMs` (15 000 ms default) instead of being taken
    // over atomically. The escape is what makes the guard deployable at all.
    //
    // The incumbent is written with a raw `SET` rather than through `acquire`,
    // because the point is a value THIS BINARY CANNOT PRODUCE — the previous
    // one's. A fixture built from the current code could not express it.
    const gen = stores('gen-v1')
    const digest = createHash('sha256')
      .update(`${WORKSPACE.landscapeId}\0${WORKSPACE.versionId}`)
      .digest('hex')
    await client.sendCommand([
      'SET', `${prefix}:sync-cell:owner:${digest}`, 'cell-a|1', 'PX', '60000',
    ])

    const partition = await gen.partition.acquire(0, 'cell-b', 60_000, null)
    expect(partition).not.toBeNull()

    const stolen = await gen.workspace.acquireForPartition(
      WORKSPACE, 'cell-b', 60_000, gen.partition.proof(0, partition!),
    )

    expect(stolen.acquired, 'a pre-upgrade lease became unstealable: the rolling upgrade wedges')
      .not.toBeNull()
    // AND IT IS UPGRADED IN PLACE. The successor writes a three-component value,
    // so the workspace leaves the exemption permanently rather than staying
    // stealable by any generation for ever.
    expect(await ownerValue()).toBe(`cell-b|${stolen.acquired!.token}|gen-v1.ce1461953e2b8ac2`)
  }, 60_000)

  it('the steal is REFUSED across generations, and the incumbent is left exactly as it was', async () => {
    const older = stores('gen-v1')
    const newer = stores('gen-v2')

    const incumbent = await older.workspace.acquire(WORKSPACE, 'cell-a', 60_000)
    expect(incumbent).not.toBeNull()
    const before = await ownerValue()

    // B's partition proof is VALID — it holds partition 0 under its own
    // generation-scoped key, which is precisely why nothing contended and why
    // the falsification was reachable at all.
    const partition = await newer.partition.acquire(0, 'cell-b', 60_000, null)
    expect(partition).not.toBeNull()

    const refused = await newer.workspace.acquireForPartition(
      WORKSPACE, 'cell-b', 60_000, newer.partition.proof(0, partition!),
    )

    // NAMED, not merely refused. `partition-proof-stale` would also be a
    // refusal here and would mean the opposite thing — that B never proved its
    // partition, i.e. the arm never reached the guard it exists to exercise.
    expect(refused).toEqual({
      acquired: null,
      refusal: 'foreign-generation',
      incumbent: before,
    })
    // UNCHANGED, byte for byte. A refusal that still bumped the sequence or
    // rewrote the TTL would be a partial steal — the shape that leaves a
    // workspace owned by nobody.
    expect(await ownerValue()).toBe(before)
  }, 60_000)

  it('ARM 2 (CONTROL) — at the SAME generation, exactly one cell owns the workspace', async () => {
    // THE CONTROL RUNS FIRST, deliberately. If the harness cannot watch the
    // single-owner property HOLD, a red arm 1 says nothing about the product.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)

    const b = await boot('cell-b', 'gen-v1')

    // B contends for the SAME generation-scoped partition key, which A holds, so
    // it gets no partition and no workspace. One owner, which is the property.
    expect(b.owns(WORKSPACE)).toBe(false)
    expect(a.owns(WORKSPACE) && b.owns(WORKSPACE)).toBe(false)
    // AND FOR THE STATED REASON. Asserting only `b.owns === false` in both
    // arms would let an `acquireForPartition` that returns null
    // unconditionally pass both — a control that cannot be told apart from the
    // arm it controls is not a control. Here B is refused because it never got a PARTITION; in ARM 1 it
    // holds one and is refused by the guard, which is the whole difference.
    expect(b.snapshot().partitionReady, 'B should be refused by partition contention, not by the guard')
      .toBe(false)
    expect(b.snapshot().partitionIndex).toBeNull()
    expect(a.snapshot().partitionReady).toBe(true)
  }, 60_000)

  it('ARM 1 — a rewritten topology contract must not produce TWO owners of one workspace', async () => {
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)
    expect(tokenBefore).not.toBeNull()

    // THE OPERATOR ACTION THIS IS ABOUT. Rewriting the contract is how a
    // generation is rolled — the key is one value for the whole fleet, and
    // nothing revokes the cells that read the old one. Written directly rather
    // than through a second coordinator, because the point is the STATE, not
    // how it was reached.
    await client.sendCommand(['SET', `${prefix}:sync-cell:topology`, 'gen-v2.ce1461953e2b8ac2|1'])
    // The durable topology mirror refuses a boot that still describes A. This
    // adversarial fixture explicitly changes both external contract witnesses
    // so B reaches the cross-generation workspace guard under examination.
    const changed = await db.pool.query(`UPDATE sync_topology_contract
      SET value = $1, written_by = 'generation-skew-fixture', written_at = NOW()`,
    ['gen-v2.ce1461953e2b8ac2|1'])
    expect(changed.rowCount).toBe(1)
    expect((await db.pool.query('SELECT value FROM sync_topology_contract')).rows)
      .toEqual([{ value: 'gen-v2.ce1461953e2b8ac2|1' }])

    const b = await boot('cell-b', 'gen-v2')

    // A never re-reads the contract, so it still believes it holds its
    // partition and its workspace lease. B took a DIFFERENT partition key —
    // generation-scoped — so nothing contended, and then overwrote the
    // workspace owner key, which is NOT generation-scoped.
    expect(
      a.owns(WORKSPACE) && b.owns(WORKSPACE),
      'two cells on different topology generations both claim this workspace: '
      + 'the partition lease is generation-scoped and the workspace owner key is not, '
      + 'so B\'s partition proof let it overwrite a lease A still believes it holds',
    ).toBe(false)

    // B GOT A PARTITION — which is what makes this arm different from the
    // control, and what makes the falsification reachable at all: B contends for
    // `partition:gen-v2:0`, a key nothing holds, so nothing stops it. The
    // refusal it then meets is the guard, not contention.
    expect(b.snapshot().partitionReady).toBe(true)
    expect(b.snapshot().partitionIndex).toBe(0)

    // WHICH CELL SURVIVES, stated rather than left to `!(a && b)` — that
    // expression is equally satisfied by the other, differently-wrong outcome
    // where B wins and A keeps serving a workspace it no longer owns. A holds
    // it, under the token it was granted, and B holds nothing.
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(b.owns(WORKSPACE)).toBe(false)
    expect(b.snapshot().ownedWorkspaceCount).toBe(0)

    // AND THE REFUSAL IS COUNTED separately from `conflictCount` ("the
    // partition proof no longer matches"), so this state is distinguishable
    // from ordinary contention and can be paged on. B expects one workspace,
    // owns none, and will never acquire while A renews: a routing black hole
    // with a name.
    expect(b.snapshot().expectedWorkspaceCount).toBe(1)
    // AT LEAST ONE, not exactly one, and the looseness is deliberate rather
    // than a shrug: the reconcile pass is periodic, so B re-attempts the
    // acquisition for as long as the arm runs and the exact count is a reading
    // of how many passes fitted in the window. Pinning it to 1 would pin a
    // timing.
    expect(b.snapshot().crossGenerationRefusalCount).toBeGreaterThanOrEqual(1)
    // THE PAIR IS THE ASSERTION. `>= 1` alone would pass a counter that simply
    // counts every refusal. B's
    // `conflictCount` at ZERO says the refusal was NOT booked as contention —
    // fold the two branches back together and this line goes red while the one
    // above stays green.
    expect(b.snapshot().conflictCount).toBe(0)
    // …and the cell that never refused anything counts nothing, which rules out
    // a counter wired to something both cells do.
    expect(a.snapshot().crossGenerationRefusalCount).toBe(0)
    expect(a.snapshot().conflictCount).toBe(0)
  }, 60_000)
})
