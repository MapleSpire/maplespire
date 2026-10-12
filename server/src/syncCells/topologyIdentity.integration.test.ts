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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore,
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  syncCellOwnershipConfig,
  type SyncCellOwnershipConfig,
} from './ownership.js'
import { startRouterTopologyGuard } from './routerTopology.js'
import { syncCellPartitionConfig } from './assignment.js'

/**
 * The topology identity bit `ENSURE_TOPOLOGY_SCRIPT` computes: "I CREATED the
 * topology key" versus "it existed and agreed". Paired with a count of
 * ownership rows it says "PostgreSQL has been serving and Redis has never seen
 * a cell boot", for one GET.
 *
 * IT MUST BE AN INTEGRATION TEST: a Lua script returning the same value whether
 * it created the key or matched it would pass the service-free unit suite,
 * whose fake Redis never executes the script.
 *
 * Fixture choices that matter:
 *
 *  - THE PAIRING COUNTS EVERY ROW, released or not. `restore:reset-routing
 *    --apply` releases every row and is run BEFORE the cells restart, so a
 *    count filtered on `released_at IS NULL` would be silent on the documented
 *    procedure it exists for. One arm runs with every row released.
 *  - IDENTIFIERS ARE MINTED PER RUN, never fixture literals the code could
 *    hard-code, and the row count is three so `ownershipRows` and
 *    `unreleasedRows` cannot be confused.
 *  - EACH ARM ASSERTS the state it just established, rather than inheriting a
 *    precondition from another arm's teardown.
 *
 * FRESH PREFIX PER ARM. The topology key is created ONCE per prefix by
 * construction, so an arm reusing a prefix asserts about a key some earlier arm
 * made.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

const LANDSCAPE = 'landscape-topology'
const VERSIONS = ['version-a', 'version-b', 'version-c']

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('topology identity at boot (B4-7c)', () => {
  const client = createClient({ url: TEST_REDIS_URL })
  const prefixes: string[] = []
  let db: IsolatedSchemaDb

  /** A runtime on a prefix nothing has ever used. */
  function runtime(): RedisRuntime {
    const prefix = `test:topology:${randomBytes(8).toString('hex')}`
    prefixes.push(prefix)
    return {
      configured: true,
      get ready() { return client.isReady },
      prefix,
      send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime
  }

  /** MINTED, never a literal: code that hard-coded the cell id or the
   * generation would pass against a fixture using the same constants. */
  const minted = () => ({
    cellId: `cell-${randomBytes(4).toString('hex')}`,
    ...syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: `gen-${randomBytes(4).toString('hex')}` }),
  })

  function config(overrides: Partial<SyncCellOwnershipConfig> = {}): SyncCellOwnershipConfig {
    return {
      ...syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'cell-topology', SYNC_CELL_TOPOLOGY_GENERATION: 'topology-v1' }),
      enabled: true,
      cellId: 'cell-topology',
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
      partitionCount: 1,
      ...overrides,
    }
  }

  /** Seed N ownership rows, released or not, and ASSERT the seeding took —
   * a selection that found nothing makes every
   * assertion below it vacuous. */
  async function seedOwnership(count: number, released: boolean): Promise<void> {
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    for (let index = 0; index < count; index += 1) {
      await db.pool.query(
        `INSERT INTO sync_workspace_ownership
           (landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at)
         VALUES ($1, $2, 'cell-from-the-old-world', 42, NOW() - INTERVAL '1 hour', $3)`,
        [LANDSCAPE, VERSIONS[index]!, released ? new Date() : null],
      )
    }
    const { rows } = await db.pool.query<{ total: string; live: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE released_at IS NULL)::text AS live
         FROM sync_workspace_ownership`,
    )
    expect(rows[0], 'the ownership seed did not take').toMatchObject({
      total: String(count),
      live: released ? '0' : String(count),
    })
  }

  /** Run `start()` with `console.warn` captured, and always restore it. */
  async function bootCapturingWarnings(
    coordinator: SyncCellOwnershipCoordinator,
  ): Promise<Array<Record<string, unknown>>> {
    const lines: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      await coordinator.start()
    } finally {
      console.warn = realWarn
      await coordinator.stop()
    }
    return lines
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((value): value is Record<string, unknown> => value !== null)
  }

  const incidents = (lines: Array<Record<string, unknown>>) =>
    lines.filter((line) => line.event === 'sync.cell.topology_created_with_durable_rows')

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'sync_cell_topology_identity')
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
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'Topology'])
    for (const version of VERSIONS) {
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:x')`,
        [version, LANDSCAPE],
      )
    }
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)

  beforeEach(async () => {
    // Each arm uses a fresh Redis prefix/generation. Its PG comparison witness
    // must describe that same fresh world, not a previous arm's creator.
    await db.pool.query('DELETE FROM sync_topology_contract')
    expect((await db.pool.query('SELECT value FROM sync_topology_contract')).rows).toEqual([])
  })

  afterAll(async () => {
    for (const prefix of prefixes) {
      const keys: string[] = []
      for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        if (Array.isArray(batch)) keys.push(...batch)
        else keys.push(batch)
      }
      if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    }
    await client.close()
    await db?.teardown()
  })

  it('says CREATED the first time and MATCHED thereafter, against the real script', async () => {
    // A script returning the same value in both cases can only be caught here:
    // it is Lua, and only a real Redis executes it.
    const store = new FencedPartitionLeaseStore(runtime(), 'topology-v1')
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: true })
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: false })
    // A third time, because `created` LATCHING true after the write reads
    // identically on two calls.
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: false })
  })

  it('refuses a disagreeing contract, and does not call that created', async () => {
    const shared = runtime()
    const first = new FencedPartitionLeaseStore(shared, 'topology-v1')
    expect(await first.ensureTopology(1)).toEqual({ agreed: true, created: true })
    // A different GENERATION on the same prefix.
    expect(await new FencedPartitionLeaseStore(shared, 'topology-v2').ensureTopology(1))
      .toEqual({ agreed: false, created: false })
    // ...and a different partition COUNT on the agreed generation, which is the
    // other half of the contract and the half a rolling deploy gets wrong.
    expect(await new FencedPartitionLeaseStore(shared, 'topology-v1').ensureTopology(4))
      .toEqual({ agreed: false, created: false })
  })

  it('is ATOMIC: two cells booting at once cannot both create the key', async () => {
    // THE PROPERTY THE LUA SCRIPT EXISTS FOR. A client-side GET followed by a
    // conditional SET is semantically identical on a quiet Redis, but under a
    // real race it lets two cells with DIFFERENT generations both read
    // "absent", both write, and both return `agreed: true`: the topology
    // refusal fails open.
    //
    // The interleaving is forced rather than hoped for. Each participant's
    // RESPONSE is held until both have issued their first command, so a
    // read-then-write implementation must observe the pre-write state on both
    // sides. Redis executes an EVAL atomically on arrival, so the real script is
    // unaffected — which is precisely the difference being measured.
    const shared = runtime()
    let arrived = 0
    let open!: () => void
    const bothIssued = new Promise<void>((resolve) => { open = resolve })
    const barrier = {
      configured: true,
      ready: true,
      prefix: shared.prefix,
      async send<T>(args: string[]): Promise<T> {
        const inFlight = shared.send<T>(args)
        arrived += 1
        if (arrived >= 2) open()
        await bothIssued
        return inFlight
      },
    } as unknown as RedisRuntime

    const [a, b] = await Promise.all([
      new FencedPartitionLeaseStore(barrier, 'race-gen-a').ensureTopology(1),
      new FencedPartitionLeaseStore(barrier, 'race-gen-b').ensureTopology(1),
    ])

    // EXACTLY ONE creator, and the loser is REFUSED rather than admitted.
    expect([a, b].filter((outcome) => outcome.created)).toHaveLength(1)
    expect([a, b].filter((outcome) => outcome.agreed)).toHaveLength(1)
    // Stated as a pair too: a version that let both through would satisfy
    // neither line, and one that refused both would satisfy neither.
    expect([a.agreed, b.agreed].sort()).toEqual([false, true])
  })

  it('reports the contradiction even when every ownership row is RELEASED', async () => {
    // The state is the documented procedure rather than a corner:
    // `restore:reset-routing --apply` sets `released_at = NOW()` on every row,
    // and is run BEFORE the cells restart. Pairing against
    // `WHERE released_at IS NULL` rows would make the detector silent exactly here.
    await seedOwnership(3, true)
    const identity = minted()
    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config(identity))

    const emitted = incidents(await bootCapturingWarnings(coordinator))
    expect(emitted, 'the contradiction was not reported for released rows').toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      cellId: identity.cellId,
      topologyGeneration: identity.topologyGeneration,
      // THREE and ZERO, and the two must differ, so reporting the survey's
      // count instead of the table's cannot pass.
      ownershipRows: 3,
      unreleasedRows: 0,
    })
    expect(String(emitted[0]!.detail)).toMatch(/different\s+Redis or key prefix/)
    expect(emitted[0]!.observedAt).toEqual(expect.any(String))
    expect(coordinator.snapshot().topologyKeyCreatedAtBoot).toBe(true)
    expect(coordinator.snapshot().bootObservedAt).toEqual(expect.any(String))
  })

  it('reports it once — not once per row — when rows are unreleased', async () => {
    await seedOwnership(3, false)
    const identity = minted()
    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config(identity))

    const emitted = incidents(await bootCapturingWarnings(coordinator))
    // ONE line for three rows. Looping over the rows would emit 10 000
    // identical warnings at boot on a 10 000-workspace deployment — invisible to
    // a single-row fixture.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ ownershipRows: 3, unreleasedRows: 3 })
  })

  it('stays SILENT when the topology key already existed — the ordinary restart', async () => {
    // THE CONTROL that makes the arms above mean anything: a cell restarting
    // into a healthy fleet has ownership rows too. If this fired here the signal
    // would be "a cell booted" and would say nothing about the world.
    await seedOwnership(3, false)
    const shared = runtime()
    const configured = config()
    expect(configured.effectiveGeneration).toBe('topology-v1.ce1461953e2b8ac2')
    // Somebody booted here before us.
    expect(await new FencedPartitionLeaseStore(shared, configured.effectiveGeneration).ensureTopology(1))
      .toEqual({ agreed: true, created: true })

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, shared, configured)
    expect(incidents(await bootCapturingWarnings(coordinator))).toHaveLength(0)
    expect(coordinator.snapshot().topologyKeyCreatedAtBoot).toBe(false)
  })

  it('stays SILENT on a first boot with an empty table — a new deployment', async () => {
    // The other control. "I created the topology key" alone is the ordinary
    // first boot of a new deployment; a detector firing on it would be noise on
    // day one of every install. The precondition is established HERE and
    // asserted, rather than inherited from the previous arm's teardown.
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sync_workspace_ownership',
    )
    expect(rows[0]!.count, 'the table was not actually emptied').toBe('0')

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config())
    expect(incidents(await bootCapturingWarnings(coordinator))).toHaveLength(0)
    // ...and the bit itself is still TRUE. The field says what happened; only
    // the PAIRING is the incident.
    expect(coordinator.snapshot().topologyKeyCreatedAtBoot).toBe(true)
  })

  it('a ROUTER reads the very contract a cell wrote — both sides of one string (B0a-3)', async () => {
    // THE ONE PROPERTY NO UNIT TEST CAN SHOW. `verifyTopology` compares a string
    // it builds against a string `ensureTopology`'s Lua wrote, and the unit arms
    // build the expected value THEMSELVES — so a drift on one side only (a
    // separator change, a reordering to `count|generation`) leaves them all
    // green while every router in the fleet refuses to start. Here the writer is
    // the real script and the reader is the real method, on one Redis.
    const shared = runtime()
    const generation = `gen-${randomBytes(4).toString('hex')}`

    // Nobody has booted: the router starts anyway, and says so.
    const cold = await new FencedPartitionLeaseStore(shared, generation).verifyTopology(2)
    expect(cold, 'a router must start against a Redis no cell has claimed').toMatchObject({
      known: false, agreed: true, found: null,
    })

    // A cell boots and writes the contract — and `created: true` HERE is also
    // the proof that the router's read left no trace, because the read above ran
    // FIRST on this same prefix. A `verifyTopology` that wrote would have made
    // this line report `created: false`, silently disarming the rebuilt-Redis
    // detector this very file exists for. That ordering is the only way
    // to tell a reading implementation from a writing one, and it is why the
    // cold read is not merely the first arm but the setup for this one.
    expect(await new FencedPartitionLeaseStore(shared, generation).ensureTopology(2))
      .toEqual({ agreed: true, created: true })

    // ...and NOW the router agrees with it. Written as `found === expected`
    // rather than a literal so the assertion cannot be satisfied by the format
    // this test happens to expect.
    const warm = await new FencedPartitionLeaseStore(shared, generation).verifyTopology(2)
    expect(warm.known).toBe(true)
    expect(warm.agreed, `router expected ${warm.expected}, fleet wrote ${warm.found}`).toBe(true)
    expect(warm.found).toBe(warm.expected)

    // Both halves of a real divergence, against the same written contract.
    expect(await new FencedPartitionLeaseStore(shared, generation).verifyTopology(4))
      .toMatchObject({ known: true, agreed: false })
    expect(await new FencedPartitionLeaseStore(shared, `${generation}-other`).verifyTopology(2))
      .toMatchObject({ known: true, agreed: false })

  })

  it('the ROUTER reports an absent contract beside RELEASED ownership rows (B0a-3)', async () => {
    // THE ARM A FAKE CANNOT BE: the unit fake returns whatever count it is
    // asked for and ignores the SQL entirely, so a `WHERE released_at IS NULL`
    // added to the router's survey would leave every unit arm green.
    //
    // WHY RELEASED ROWS ARE THE FIXTURE RATHER THAN A CORNER CASE:
    // `restore:reset-routing --apply` sets `released_at = NOW()` on every row,
    // and is run BEFORE the cells and the router restart. A survey filtered to unreleased rows is therefore silent by
    // construction on the documented procedure it exists for. Counting the whole
    // table is the property, and only a real table can witness it.
    await seedOwnership(3, true)
    const warnings: string[] = []
    const guard = await startRouterTopologyGuard({
      // A prefix nothing has ever written: the router finds no contract, which
      // is the branch under test. It stands in for the real hazard — a router
      // pointed at a different Redis or REDIS_KEY_PREFIX than the cells.
      store: new FencedPartitionLeaseStore(runtime(), 'router-generation'),
      partitionCount: 2,
      db: db.pool,
      log: () => {},
      warn: (line) => warnings.push(line),
      setInterval: () => 1,
      clearInterval: () => {},
    })

    const reported = warnings
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === 'sync.router.contract_absent_with_durable_rows')
    expect(reported, 'the router did not report an absent contract beside durable rows').toHaveLength(1)
    // THREE, against a table whose unreleased count is ZERO. A survey filtered
    // to unreleased rows reports nothing at all here and this arm goes red —
    // which a one-row fixture, or a fixture with live rows, could not show.
    expect(reported[0]).toMatchObject({ ownershipRows: 3 })
    expect(guard.snapshot()).toMatchObject({ state: 'pending', contractPresent: false })
  })

  it('...and the ROUTER stays silent on a genuine cold start (the control)', async () => {
    // Without this, the arm above would fire for "a router booted" and say
    // nothing about the world. A first deployment has no contract AND no rows.
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sync_workspace_ownership',
    )
    expect(rows[0]!.count, 'the table was not actually emptied').toBe('0')

    const warnings: string[] = []
    await startRouterTopologyGuard({
      store: new FencedPartitionLeaseStore(runtime(), 'router-generation'),
      partitionCount: 2,
      db: db.pool,
      log: () => {},
      warn: (line) => warnings.push(line),
      setInterval: () => 1,
      clearInterval: () => {},
    })

    expect(warnings.filter((l) => l.includes('contract_absent_with_durable_rows'))).toHaveLength(0)
  })

  it('reports the contradiction even if the fence survey itself fails', async () => {
    // The pairing is emitted BEFORE the MGET, and this is why. A rebuilt Redis
    // is a cold Redis; the survey's MGET runs on the lease runtime, whose
    // timeout DESTROYS the connection, and the throw lands in the survey's
    // catch. With the pairing below the MGET, the one line that names the
    // contradiction would never execute — in the incident it exists for.
    await seedOwnership(2, false)
    const healthy = runtime()
    const broken = {
      configured: true,
      ready: true,
      prefix: healthy.prefix,
      async send<T>(args: string[]): Promise<T> {
        if (args[0] === 'MGET') throw new Error('connection destroyed by the command timeout')
        return healthy.send<T>(args)
      },
    } as unknown as RedisRuntime

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, broken, config())
    const emitted = incidents(await bootCapturingWarnings(coordinator))
    expect(emitted, 'the pairing did not survive the survey failing').toHaveLength(1)
    expect(emitted[0]).toMatchObject({ ownershipRows: 2 })
    // ...and the survey itself reports "not known" rather than "none".
    expect(coordinator.snapshot().durableFencesWithoutSequence).toBeNull()
  })
})
