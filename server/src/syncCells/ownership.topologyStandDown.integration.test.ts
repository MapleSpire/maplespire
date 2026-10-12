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
import type { Pool } from 'pg'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore,
  OWNABLE_WORKSPACES_SQL,
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  syncCellOwnershipConfig,
  type SyncCellOwnershipConfig,
} from './ownership.js'

/**
 * FALSIFY: must a SUPERSEDED cell stand down on its own?
 *
 * ## The hole this exists to close
 *
 * The generation guard stops two cells on different topology generations from
 * both owning a workspace, at the cost of a liveness hazard. `ensureTopology`
 * has one production call site, inside `start()`, so without a stand-down a
 * RUNNING cell never re-reads the contract and never learns it was superseded.
 * It renews for as long as its process lives; the new generation's cells are
 * refused; and the workspace is served by a process no router on the new
 * generation will ever address. `SyncCellCrossGenerationRefusal` pages, and a
 * human has to drain the old cell.
 *
 * ## Why the obvious remedy is worse than the bug
 *
 * "Re-read the contract each pass, release everything on a disagreement" makes
 * ARM 1 pass and is wrong. The contract can only change under a running fleet
 * in two ways — an operator rewrites the key, or the key is ABSENT and some
 * cell creates it — and one of those has a failure mode the stall does not:
 *
 *   An operator who rewrites the generation BEFORE deploying the new roster
 *   should take no outage at all: the old cells keep serving; the new ones do
 *   not exist yet. Under an unconditional stand-down every cell in the fleet
 *   releases within one reconcile interval, simultaneously, and there is nobody
 *   to take over. That converts "stale cells keep serving" into "the service is
 *   down", a strictly worse trade.
 *
 * So the property is not "stand down when superseded". It is **stand down when
 * superseded AND a successor is already there to take over** — which is exactly
 * the condition under which releasing is safe, and it is observable: a cell on
 * the new generation holds the partition key under the new generation's name.
 *
 * ARM 3 is the arm that says so, and it is the one that kills the naive fix.
 *
 * ## Reconciles are driven by hand
 *
 * `reconcileIntervalMs` is ten minutes here and every pass in this file is one
 * the test asked for by name. A timer firing between the assertions would let
 * a renewal repair the very state being measured — the same reason
 * `ownership.topologyGeneration.integration.test.ts` does it.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

const LANDSCAPE = 'landscape-standdown'
const WORKSPACE = { landscapeId: LANDSCAPE, versionId: 'version-a' }

/**
 * How many passes the stand-down is allowed to take, and it is a STATED bound
 * rather than "eventually".
 *
 * TWO is a CEILING with slack, not a required count: the shipped remedy needs
 * one pass. The slack is deliberate — an assertion pinned to exactly one pass
 * pins a schedule, and this file has no business being red because a future
 * remedy split the work across two.
 *
 * What it does NOT buy is safety through delay. A "confirm the disagreement
 * over N readings" rule would be the obvious way to stop a transient Redis read
 * dropping leases fleet-wide, and it is not what guards this: the guard is that
 * a SUCCESSOR must already hold the partition (ARM 3). That is a much stronger
 * condition than patience — it is unsatisfiable by a transient read of one key,
 * because it requires a second key, written by a different process, to agree.
 *
 * The bound is the hand-over window an operator who rolls a generation without
 * draining gets, measured in reconcile intervals rather than left as
 * "eventually".
 */
const STAND_DOWN_PASSES = 2

/** Pure coverage of the real coordinator/store methods for reserved successors. The transports
 * below model command results, not Lua/PG semantics, TTLs or a Worker. Empty
 * workspace tables isolate the partition handoff; the DB suite below covers
 * workspace release and durable fencing with real services. */
describe('T-13d reserved successor options (pure)', () => {
  function fixture() {
    const prefix = 'reserved-successor-unit'
    const topologyKey = `${prefix}:sync-cell:topology`
    let topology: string | null = null
    let mirror: string | null = null
    const owners = new Map<string, string>()
    const sequences = new Map<string, number>()
    const commands: string[][] = []
    const running: SyncCellOwnershipCoordinator[] = []
    const lines: string[] = []
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)) })
    vi.spyOn(console, 'warn').mockImplementation(line => { lines.push(String(line)) })
    const runtime = {
      configured: true, ready: true, prefix,
      async send<T>(args: string[]): Promise<T> {
        commands.push([...args])
        if (args[0] === 'GET' && args[1] === topologyKey) return topology as T
        if (args[0] === 'MGET') {
          const firstKey = /^reserved-successor-unit:sync-cell:partition:(gen-(?:old|next)\.ce1461953e2b8ac2):0:owner$/.exec(args[1] ?? '')
          expect(firstKey).not.toBeNull()
          expect(args).toEqual(['MGET', ...Array.from({ length: 4 }, (_, partition) =>
            `${prefix}:sync-cell:partition:${firstKey![1]}:${partition}:owner`)])
          // Sample the same values changed by acquire/release and read by GET;
          // empty slots are null, including the three slots this role cannot own.
          return args.slice(1).map(key => owners.get(key) ?? null) as T
        }
        if (args[0] === 'EVAL' && args[2] === '1' && args[3] === topologyKey) {
          expect(args).toHaveLength(5)
          if (topology !== null) return (topology === args[4] ? 1 : 0) as T
          topology = args[4]!
          return 2 as T
        }
        const key = args[0] === 'GET' ? args[1]! : args[3]!
        expect(key).toMatch(/^reserved-successor-unit:sync-cell:partition:gen-(?:old|next)\.ce1461953e2b8ac2:1:owner$/)
        if (args[0] === 'GET') return (owners.get(key) ?? null) as T
        if (args[0] === 'EVAL' && args[2] === '2') {
          expect(args).toHaveLength(8)
          expect(args[4]).toBe(key.replace(/:owner$/, ':fence'))
          const current = owners.get(key)
          if (current !== undefined) return ['0', current] as T
          const token = (sequences.get(key) ?? 0) + 1
          sequences.set(key, token)
          const value = `${args[5]}|${token}|${args[7]}`
          owners.set(key, value)
          return [String(token), value] as T
        }
        if (args[0] === 'EVAL' && args[2] === '1') {
          expect(args).toHaveLength(5)
          if (owners.get(key) !== args[4]) return 0 as T
          owners.delete(key)
          return 1 as T
        }
        throw new Error('Unexpected pure successor Redis command')
      },
    } as unknown as RedisRuntime
    const pool = {
      async query(sql: string, params?: unknown[]) {
        if (sql === 'SELECT value FROM sync_topology_contract WHERE singleton = TRUE') {
          return { rows: mirror === null ? [] : [{ value: mirror }], rowCount: mirror === null ? 0 : 1 }
        }
        if (sql.includes('INSERT INTO sync_topology_contract')) {
          const value = String(params?.[0])
          if (mirror !== null && mirror !== value) return { rows: [], rowCount: 0 }
          mirror = value
          return { rows: [{ value }], rowCount: 1 }
        }
        if (sql.includes("current_setting('statement_timeout')")) {
          return { rows: [{ statement_timeout: '30s', lock_timeout: '5s' }], rowCount: 1 }
        }
        if (sql.includes('FROM sync_workspace_ownership')) {
          return sql.includes('count(*)')
            ? { rows: [{ count: '0' }], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (sql === OWNABLE_WORKSPACES_SQL || sql.includes('FROM workspace_placement')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error('Unexpected pure successor SQL')
      },
    } as unknown as Pool
    const boot = async (generation: 'gen-old' | 'gen-next', reserved: string) => {
      const config = syncCellOwnershipConfig({
        SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: generation, SYNC_CELL_TOPOLOGY_GENERATION: generation,
        SYNC_CELL_PARTITION_COUNT: '4', SYNC_CELL_MULTI_PARTITION: 'on',
        SYNC_CELL_RESERVED_PARTITIONS: reserved, SYNC_CELL_ROLE: 'reserved:1',
        SYNC_CELL_PLACEMENT_MODE: 'shadow', SYNC_CELL_PARTITION_WORKER: 'off',
        SYNC_CELL_ADVERTISE_URL: `http://${generation}:3000`,
      })
      const coordinator = new SyncCellOwnershipCoordinator(pool, runtime, config, () => 1_000)
      running.push(coordinator)
      await coordinator.start()
      const store = new FencedPartitionLeaseStore(runtime, config.topologyGeneration, 'shadow', config.reservedPartitions)
      expect(coordinator.snapshot()).toMatchObject({
        topologyConfirmed: true, partitionReady: true, partitionIndex: 1,
        partitionAcquisitionCount: 1, errorCount: 0, bootReconcileFailed: false,
        ownerRouteMap: { enabled: true, usable: true, entries: 1, refreshErrorCount: 0 },
      })
      expect(await store.resolve(1)).toEqual({
        partition: 1, cellId: generation, token: '1', advertiseUrl: `http://${generation}:3000`,
      })
      return { coordinator, store }
    }
    return {
      boot, commands, lines,
      rewrite(reserved: '1,3' | '1,2') {
        // Explicit external topology transition, not a product reassertion.
        // Both witnesses change; the real successor still passes its boot gate.
        topology = `gen-next.ce1461953e2b8ac2|4|v1|mode=shadow|reserved=${reserved}`
        mirror = topology
      },
      async stop() {
        try { await Promise.all(running.map(coordinator => coordinator.stop())) }
        finally { vi.restoreAllMocks(); vi.useRealTimers() }
      },
    }
  }

  it('hands off an acquired partition to another generation with the same nonempty fleet set', async () => {
    const f = fixture()
    try {
      const old = await f.boot('gen-old', '3,1')
      const exposed = old.coordinator.snapshot().reservedPartitions as number[]
      exposed.splice(0, exposed.length, 0)
      expect(old.coordinator.snapshot()).toMatchObject({ reservedPartitions: [1, 3], role: 'reserved:1' })
      f.rewrite('1,3')
      const next = await f.boot('gen-next', '1,3')
      const nextOwner = await next.store.resolve(1)
      await old.coordinator.reconcileNow()
      expect(old.coordinator.snapshot()).toMatchObject({
        partitionIndex: null, partitionReady: false, standDownActive: true,
        supersededByGeneration: true, partitionAcquisitionCount: 1, errorCount: 0,
      })
      expect(await old.store.resolve(1)).toBeNull()
      expect(await next.store.resolve(1)).toEqual(nextOwner)
      const events = f.lines.map(line => JSON.parse(line)).filter(event => event.event === 'sync.cell.topology_stand_down')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ cellId: 'gen-old', partition: 1, successorCellId: 'gen-next', released: true })
      const acquiredBefore = f.commands.filter(args => args[0] === 'EVAL' && args[2] === '2').length
      await old.coordinator.reconcileNow()
      expect(f.commands.filter(args => args[0] === 'EVAL' && args[2] === '2')).toHaveLength(acquiredBefore)
      expect(old.coordinator.snapshot().standDownActive).toBe(true)
    } finally { await f.stop() }
  })

  it('keeps the acquired old owner when an existing successor has a different nonempty fleet set', async () => {
    const f = fixture()
    try {
      const old = await f.boot('gen-old', '1,3')
      const oldOwner = await old.store.resolve(1)
      f.rewrite('1,2')
      const next = await f.boot('gen-next', '1,2')
      const nextOwner = await next.store.resolve(1)
      // Trying to mutate a public snapshot cannot make incompatible sets agree.
      const exposed = old.coordinator.snapshot().reservedPartitions as number[]
      exposed.splice(0, exposed.length, 1, 2)
      const before = f.commands.length
      await old.coordinator.reconcileNow()
      expect(old.coordinator.snapshot()).toMatchObject({
        reservedPartitions: [1, 3], role: 'reserved:1', partitionIndex: 1,
        partitionReady: true, standDownActive: false, supersededByGeneration: true,
        partitionAcquisitionCount: 1, errorCount: 0,
      })
      const during = f.commands.slice(before)
      expect(during.filter(args => args[0] === 'GET' && args[1]?.includes('partition:gen-next.'))).toEqual([])
      expect(during.filter(args => args[0] === 'EVAL')).toEqual([])
      expect(await old.store.resolve(1)).toEqual(oldOwner)
      expect(await next.store.resolve(1)).toEqual(nextOwner)
      expect(f.lines.map(line => JSON.parse(line)).filter(event => event.event === 'sync.cell.topology_stand_down')).toEqual([])
      expect(f.lines.map(line => JSON.parse(line)).filter(event => event.event === 'sync.cell.topology_superseded_without_successor'))
        .toEqual([expect.objectContaining({ cellId: 'gen-old', contractOptionsCompatible: false, partition: 1 })])
    } finally { await f.stop() }
  })
})

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('superseded cell stand-down (T-13g)', () => {
  const prefix = `test:stand-down:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  const running: SyncCellOwnershipCoordinator[] = []
  const commands: string[][] = []

  /** When true, every `GET` of the topology contract throws — and nothing else
   *  does. Reset in `afterEach`.
   *
   *  Narrow on purpose: a runtime that failed every command would prove that a
   *  cell with no Redis stops working, which nobody doubts. The question this
   *  suite has to answer is what a failure of the STAND-DOWN'S OWN READ does to
   *  the stand-down, and that needs every other command to keep working. */
  let failTopologyReads = false

  /** When true, every `GET` of a partition owner key under this generation
   *  throws. The successor probe's own read, and nothing else — the same
   *  narrowness and for the same reason. */
  let failSuccessorProbeFor: string | null = null

  const runtime = () => ({
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) {
      commands.push([...args])
      if (failTopologyReads && args[0] === 'GET' && args[1] === `${prefix}:sync-cell:topology`) {
        return Promise.reject(new Error('injected: topology read timed out')) as Promise<T>
      }
      if (
        failSuccessorProbeFor !== null && args[0] === 'GET'
        && args[1]?.startsWith(`${prefix}:sync-cell:partition:${failSuccessorProbeFor}:`)
      ) {
        return Promise.reject(new Error('injected: successor probe timed out')) as Promise<T>
      }
      return client.sendCommand(args) as Promise<T>
    },
  } as unknown as RedisRuntime)

  const config = (cellId: string, generation: string, placementMode: SyncCellOwnershipConfig['placementMode'] = 'shadow'): SyncCellOwnershipConfig => ({
    ...syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId, SYNC_CELL_TOPOLOGY_GENERATION: generation, SYNC_CELL_PLACEMENT_MODE: placementMode }),
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
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount: 1,
  })

  const effective = (generation: string) => config('fixture-identity', generation).effectiveGeneration

  async function boot(cellId: string, generation: string, placementMode: SyncCellOwnershipConfig['placementMode'] = 'shadow'): Promise<SyncCellOwnershipCoordinator> {
    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime(), config(cellId, generation, placementMode))
    running.push(coordinator)
    await coordinator.start()
    await coordinator.reconcileNow()
    return coordinator
  }

  /** Establish the external contract change whose live-owner reaction is tested.
   *
   *  A raw `SET`, not `ensureTopology`: the script only writes when the key is
   *  ABSENT, so nothing in the product can express this and a fixture built
   *  from product calls could not reach the state under test. The durable
   *  topology mirror must be changed explicitly too; bypassing its boot gate would
   *  manufacture a successor the current product could never admit. */
  function contractValue(generation: string, partitionCount: number, placementMode: SyncCellOwnershipConfig['placementMode']): string {
    const base = `${effective(generation)}|${partitionCount}`
    return placementMode === 'shadow' ? base : `${base}|v1|mode=placed|reserved=`
  }
  async function rewriteMirror(generation: string, partitionCount = 1, placementMode: SyncCellOwnershipConfig['placementMode'] = 'shadow'): Promise<void> {
    const value = contractValue(generation, partitionCount, placementMode)
    const changed = await db.pool.query(`UPDATE sync_topology_contract
      SET value = $1, written_by = 'stand-down-fixture', written_at = NOW()`, [value])
    expect(changed.rowCount, 'the predecessor never published its mirror').toBe(1)
    expect((await db.pool.query('SELECT value FROM sync_topology_contract')).rows).toEqual([{ value }])
  }
  async function rewriteContract(generation: string, partitionCount = 1, placementMode: SyncCellOwnershipConfig['placementMode'] = 'shadow'): Promise<void> {
    await rewriteMirror(generation, partitionCount, placementMode)
    await client.sendCommand([
      'SET', `${prefix}:sync-cell:topology`, contractValue(generation, partitionCount, placementMode),
    ])
  }

  async function ownerValue(): Promise<string | null> {
    const digest = createHash('sha256')
      .update(`${WORKSPACE.landscapeId}\0${WORKSPACE.versionId}`)
      .digest('hex')
    const value = await client.sendCommand(['GET', `${prefix}:sync-cell:owner:${digest}`])
    return value === null || value === undefined ? null : String(value)
  }

  /** Drive `n` reconcile passes on a coordinator, the way its timer would. */
  async function passes(coordinator: SyncCellOwnershipCoordinator, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await coordinator.reconcileNow()
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'stand_down')
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
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'StandDown'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, 'automerge:root-a'],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)

  afterEach(async () => {
    failTopologyReads = false
    failSuccessorProbeFor = null
    while (running.length > 0) await running.pop()?.stop()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    await db.pool.query('DELETE FROM sync_topology_contract')
    commands.length = 0
  })

  afterAll(async () => {
    await client.close()
    await db?.teardown()
  })

  it('T-10h3: a real placement notification can stand down the predecessor before any manually driven pass', async () => {
    const predecessor = await boot('cell-a', 'gen-v1', 'placed')
    const oldStore = new FencedPartitionLeaseStore(runtime(), effective('gen-v1'), 'placed')
    const oldKey = oldStore.proof(0, { token: '0', ownerValue: '' }, 1).ownerKey
    const oldValue = await client.get(oldKey)
    expect(oldValue).toMatch(/^cell-a\|[1-9]\d*\|$/)
    expect(predecessor.owns(WORKSPACE)).toBe(true)
    const nextStore = new FencedPartitionLeaseStore(runtime(), effective('gen-v2'), 'placed')
    let nextLease: Awaited<ReturnType<typeof nextStore.acquire>> = null
    let permitNotification = false
    const delegated: Promise<void>[] = []
    const original = predecessor.reconcileNow.bind(predecessor)
    // Hold only the asynchronous callback during setup. No owns/store value
    // is replaced, and the actual notification delegates to the real pass.
    const callback = vi.spyOn(predecessor, 'reconcileNow').mockImplementation(() => {
      if (!permitNotification) return Promise.resolve()
      const flight = original()
      delegated.push(flight)
      return flight
    })
    try {
      await rewriteContract('gen-v2', 1, 'placed')
      nextLease = await nextStore.acquire(0, 'cell-b', 60_000, null)
      expect(nextLease).not.toBeNull()
      expect(await client.get(oldKey)).toBe(oldValue)
      expect(predecessor.owns(WORKSPACE)).toBe(true)
      permitNotification = true
      // The production channel is a global invalidation hint: even a payload
      // naming another schema can enter the same real stand-down predicate.
      await db.pool.query('SELECT pg_notify($1, $2)', ['workspace_placement_changed', 'another-test-schema'])
      await expect.poll(() => delegated.length).toBeGreaterThan(0)
      await Promise.all(delegated)
      expect(predecessor.snapshot()).toMatchObject({ standDownActive: true, partitionIndex: null })
      expect(predecessor.owns(WORKSPACE)).toBe(false)
      expect(await client.get(oldKey)).toBeNull()
      expect(await ownerValue()).toBeNull()
      expect(await nextStore.resolve(0)).toMatchObject({ cellId: 'cell-b', token: nextLease!.token })
    } finally {
      permitNotification = false
      callback.mockRestore()
      await Promise.allSettled(delegated)
      if (nextLease) await nextStore.release(0, nextLease)
    }
  })

  it.each(['shadow', 'placed'] as const)('T-10h1: a placed predecessor compares the successor mode %s with its own mode', async successorMode => {
    const predecessor = await boot('cell-a', 'gen-v1', 'placed')
    // These two arms measure the manually driven stand-down predicate. The
    // separate notification arm above proves why an enabled listener could
    // legitimately perform that pass before the staged refusal assertion.
    const listener = (predecessor as unknown as {
      placementInvalidation: { stop(): Promise<void> } | null
    }).placementInvalidation
    expect(listener).not.toBeNull()
    await listener!.stop()
    await predecessor.reconcileNow()
    expect(predecessor.snapshot()).toMatchObject({ placementMode: 'placed', standDownActive: false })
    expect(predecessor.owns(WORKSPACE)).toBe(true)
    const incumbent = await ownerValue()
    const oldStore = new FencedPartitionLeaseStore(runtime(), effective('gen-v1'), 'placed')
    const oldKey = oldStore.proof(0, { token: '0', ownerValue: '' }, 1).ownerKey
    const oldValue = await client.get(oldKey)
    expect(oldValue).toMatch(/^cell-a\|[1-9]\d*\|$/)
    await rewriteContract('gen-v2', 1, successorMode)
    const successor = await boot('cell-b', 'gen-v2', successorMode)
    expect(successor.snapshot()).toMatchObject({ placementMode: successorMode, partitionIndex: 0 })
    expect(successor.owns(WORKSPACE)).toBe(false)
    expect(predecessor.owns(WORKSPACE)).toBe(true)
    expect(await client.get(oldKey)).toBe(oldValue)
    expect(await ownerValue()).toBe(incumbent)
    const successorStore = new FencedPartitionLeaseStore(runtime(), effective('gen-v2'), successorMode)
    const successorKey = successorStore.proof(0, { token: '0', ownerValue: '' }, 1).ownerKey
    expect(await client.sendCommand(['EXISTS', successorKey])).toBe(1)
    commands.length = 0
    await passes(predecessor, STAND_DOWN_PASSES)
    if (successorMode === 'placed') {
      expect(predecessor.snapshot().standDownActive).toBe(true)
      expect(predecessor.owns(WORKSPACE)).toBe(false)
      expect(await client.get(oldKey)).toBeNull()
      expect(commands.some(args => args[0] === 'GET' && args[1] === successorKey)).toBe(true)
      await successor.reconcileNow()
      expect(successor.owns(WORKSPACE)).toBe(true)
    } else {
      expect(predecessor.snapshot().standDownActive).toBe(false)
      expect(predecessor.owns(WORKSPACE)).toBe(true)
      expect(commands.filter(args => args[0] === 'GET' && args[1] === successorKey)).toEqual([])
      expect(await ownerValue()).toBe(incumbent)
      expect(await client.get(oldKey)).toBe(oldValue)
    }
  })

  it.each([false, true])('B3d2 malformed presence preserves the previous superseded flag %s and never probes a successor', async previous => {
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    if (previous) {
      await rewriteContract('gen-v3')
      await passes(a, 1)
    }
    expect(a.snapshot().supersededByGeneration).toBe(previous)
    const token = a.fencingToken(WORKSPACE)
    const owner = await ownerValue()
    const old = new FencedPartitionLeaseStore(runtime(), effective('gen-v1'))
    const oldRoute = await old.resolve(0)
    const successor = new FencedPartitionLeaseStore(runtime(), effective('gen-v2'))
    expect(await successor.acquire(0, 'cell-b', 60_000, null)).not.toBeNull()
    const successorKey = successor.proof(0, { token: '0', ownerValue: '' }).ownerKey
    expect(await client.sendCommand(['EXISTS', successorKey])).toBe(1)
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args); originalWarn(...args as []) }
    try {
      for (const [raw, reason] of [
        ['gen-v2.ce1461953e2b8ac2|1|1111111111111111', 'arity-invalid'],
        ['gen-v2.ce1461953e2b8ac2|1\n', 'count-invalid'],
        ['gen-v2.ce1461953e2b8ac2\n|1', 'generation-invalid'],
      ]) {
        await client.sendCommand(['SET', `${prefix}:sync-cell:topology`, raw])
        const before = a.snapshot().errorCount
        commands.length = 0
        await passes(a, STAND_DOWN_PASSES + 2)
        expect(commands.filter(args => args[0] === 'GET' && args[1] === successorKey)).toEqual([])
        expect(a.snapshot()).toMatchObject({ supersededByGeneration: previous, standDownActive: false, partitionReady: true, canServe: true })
        expect(a.snapshot().errorCount).toBeGreaterThan(before)
        expect(a.fencingToken(WORKSPACE)).toBe(token)
        expect(await ownerValue()).toBe(owner)
        expect(await old.resolve(0)).toEqual(oldRoute)
        expect(await client.sendCommand(['GET', `${prefix}:sync-cell:topology`])).toBe(raw)
        expect(warnings.some(args => args[0] === '[sync-cell] topology-contract failed:'
          && (args[1] as { code?: string; reason?: string })?.code === 'sync_cell_topology_contract_invalid'
          && (args[1] as { reason?: string }).reason === reason)).toBe(true)
      }
    } finally {
      console.warn = originalWarn
    }
  }, 120_000)

  it.each(['mode=placed|reserved=', 'mode=shadow|reserved=0'])(
    'B3d2 does not hand over to the same numeric slot under incompatible %s', async fields => {
      const a = await boot('cell-a', 'gen-v1')
      expect(a.owns(WORKSPACE)).toBe(true)
      const token = a.fencingToken(WORKSPACE)
      const owner = await ownerValue()
      const successor = new FencedPartitionLeaseStore(runtime(), effective('gen-v2'))
      expect(await successor.acquire(0, 'cell-b', 60_000, null)).not.toBeNull()
      const successorKey = successor.proof(0, { token: '0', ownerValue: '' }).ownerKey
      expect(await client.sendCommand(['EXISTS', successorKey])).toBe(1)
      const raw = `gen-v2.ce1461953e2b8ac2|1|v1|${fields}`
      await client.sendCommand(['SET', `${prefix}:sync-cell:topology`, raw])
      commands.length = 0
      await passes(a, STAND_DOWN_PASSES + 2)
      expect(commands.filter(args => args[0] === 'GET' && args[1] === successorKey)).toEqual([])
      expect(a.snapshot()).toMatchObject({ supersededByGeneration: true, standDownActive: false, partitionReady: true, canServe: true })
      expect(a.fencingToken(WORKSPACE)).toBe(token)
      expect(await ownerValue()).toBe(owner)
      expect(await client.sendCommand(['GET', `${prefix}:sync-cell:topology`])).toBe(raw)
    }, 120_000,
  )

  it('ARM 2 (CONTROL) — an UNCHANGED contract makes nobody stand down', async () => {
    // THE CONTROL RUNS FIRST. A remedy that releases on every pass satisfies
    // ARM 1 perfectly and is a total outage; without this arm green, ARM 1's
    // green says nothing about the product.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)

    await passes(a, STAND_DOWN_PASSES + 2)

    // STILL HELD, and under the SAME token. A cell that released and silently
    // re-acquired would also answer `owns === true`, and that is a different
    // system — every in-flight write fenced out for no reason.
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(a.snapshot().ownedWorkspaceCount).toBe(1)
    expect(a.snapshot().partitionReady).toBe(true)
    expect(a.snapshot().supersededByGeneration).toBe(false)
  }, 120_000)

  it('ARM 3 (THE COUNTER-EXAMPLE) — superseded with NO successor present: keep serving, do not release', async () => {
    // THE OPERATOR WHO ROLLS THE GENERATION BEFORE DEPLOYING THE ROSTER. The
    // contract now says `gen-v2` and not one cell on `gen-v2` exists. Releasing
    // here hands the workspace to nobody: the service goes down, and it goes
    // down across every cell at once because they all read the same key.
    //
    // This arm is what makes the remedy conditional rather than reflexive, and
    // it is the one a naive fix fails. It runs BEFORE arm 1 for the same reason
    // the control does — a green arm 1 obtained by releasing unconditionally is
    // worth nothing until this is also green.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)

    await rewriteContract('gen-v2')
    await passes(a, STAND_DOWN_PASSES + 2)

    // KEPT. The workspace is still served, by the only process able to serve it.
    expect(a.owns(WORKSPACE), 'A released with no successor present — that is an outage, not a hand-over')
      .toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(await ownerValue()).toBe(`cell-a|${tokenBefore}|gen-v1.ce1461953e2b8ac2`)

    // AND IT KNOWS. Serving on a superseded contract is a state an operator has
    // to be able to see, and it is NOT the same fact as "somebody refused me" —
    // no refusal has happened here, because no successor has asked.
    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.snapshot().crossGenerationRefusalCount).toBe(0)
  }, 120_000)

  it('ARM 1 — superseded WITH a successor holding the new partition: A stands down and B takes over', async () => {
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.snapshot()).toMatchObject({ configuredGeneration: 'gen-v1', effectiveGeneration: 'gen-v1.ce1461953e2b8ac2', topologyGeneration: 'gen-v1.ce1461953e2b8ac2' })
    expect(await client.sendCommand(['GET', `${prefix}:sync-cell:topology`])).toBe('gen-v1.ce1461953e2b8ac2|1')

    await rewriteContract('gen-v2')

    // B is the successor, and it really is one: it holds `partition:gen-v2:0`,
    // a key nothing on the old generation contends for. The generation guard
    // refuses its steal, so without a stand-down it stalls — the liveness
    // hazard this arm states.
    const b = await boot('cell-b', 'gen-v2')
    expect(b.snapshot()).toMatchObject({ configuredGeneration: 'gen-v2', effectiveGeneration: 'gen-v2.ce1461953e2b8ac2', topologyGeneration: 'gen-v2.ce1461953e2b8ac2' })
    expect(b.snapshot().partitionReady).toBe(true)
    expect(b.snapshot().partitionIndex).toBe(0)
    expect(b.owns(WORKSPACE), 'B took the workspace across generations — T-13c has regressed').toBe(false)

    // A learns it was superseded and hands over. Bounded, and the bound is
    // stated at the top of this file rather than left as "eventually".
    await passes(a, STAND_DOWN_PASSES)

    expect(a.owns(WORKSPACE), 'A never learned the contract moved — the stall is still there').toBe(false)
    expect(a.snapshot().ownedWorkspaceCount).toBe(0)
    expect(a.snapshot().supersededByGeneration).toBe(true)

    // AND B ACTUALLY GETS IT. "A let go" is only half the property — a
    // hand-over that leaves the workspace owned by NOBODY is the same outage
    // with a different cause, and `!a.owns()` alone cannot tell them apart.
    await passes(b, 1)
    expect(b.owns(WORKSPACE), 'A released but B did not pick it up — the workspace is owned by nobody')
      .toBe(true)
    expect(await ownerValue()).toBe(`cell-b|${b.fencingToken(WORKSPACE)}|gen-v2.ce1461953e2b8ac2`)
  }, 120_000)

  it('an ABSENT contract is not a disagreement — a wiped Redis must not stand the fleet down', async () => {
    // THE CASE THAT MUST NEVER STAND ANYBODY DOWN, and it is the one an
    // unconditional re-read gets wrong in the worst way. Redis losing its
    // contents is already a recovery: the cell's own leases went with it.
    // Reading the absent key as "somebody replaced my contract" would add a
    // fleet-wide release on top of that, simultaneously, on every cell.
    //
    // `verifyTopology` answers `agreed: true` when the key is gone and its
    // docblock says why. This arm is what makes that a tested property of the
    // stand-down rather than a property of a function the stand-down happens to
    // call — a later change to either side has to keep it.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)

    await client.sendCommand(['DEL', `${prefix}:sync-cell:topology`])
    await passes(a, STAND_DOWN_PASSES + 2)

    expect(a.owns(WORKSPACE), 'an absent contract stood the cell down — a wipe would now take the fleet with it')
      .toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(a.snapshot().supersededByGeneration).toBe(false)
    expect(a.snapshot().partitionReady).toBe(true)
  }, 120_000)

  it('a partition COUNT change is a disagreement, and the cell does not stand down against ITSELF', async () => {
    // THE BRANCH THAT LOOKS DEAD AND IS NOT. The contract holds
    // `<generation>|<partitionCount>`, so changing only the COUNT disagrees
    // while leaving the generation this cell's own. The successor probe then
    // reads the partition key under THIS cell's generation — and finds this
    // cell.
    //
    // Without the `successor.cellId === cellId` guard, the cell reads its own
    // lease as proof that somebody is ready to take over, hands the partition
    // back to nobody, and releases every workspace. A count change is exactly
    // the operation the runbook says to do at a drain window, so the failure
    // would land on an operator following the documented procedure.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)

    await rewriteContract('gen-v1', 4)
    await passes(a, STAND_DOWN_PASSES + 2)

    // SUPERSEDED — the contract genuinely disagrees, and hiding that would be
    // the other error.
    expect(a.snapshot().supersededByGeneration).toBe(true)
    // BUT STILL SERVING. Nobody else is there; this cell IS the fleet.
    expect(a.owns(WORKSPACE), 'the cell stood down against its own lease').toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(a.snapshot().partitionReady).toBe(true)
  }, 120_000)

  it('a superseded cell with NO successor RE-ACQUIRES a partition it has lost — the two flags are not one flag', async () => {
    // THE ARM MY OWN MUTATION BATTERY DEMANDED, and it is the one that makes
    // the difference between the two flags a tested property instead of a
    // comment. Replacing `standDownActive` with `supersededByGeneration` in the
    // acquisition guard passed all six of the arms above, because in every one
    // of them the cell ALREADY holds its partition and
    // `acquirePartitionIfMissing` returns at its `partitionIsLive()` line
    // before reaching the guard at all.
    //
    // WHAT THE MUTANT COSTS. A superseded cell that loses its partition — an
    // expiry, a Redis blip, a renew that lost a race — can never take one back.
    // With no successor deployed, that cell is the only thing serving its
    // workspaces, so it stops serving them and nothing picks them up: the
    // fleet-wide outage this whole design is shaped to avoid, arrived by the
    // back door on one cell at a time.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)

    await rewriteContract('gen-v2')
    await passes(a, 1)
    expect(a.snapshot().supersededByGeneration).toBe(true)

    // THE PARTITION GOES AWAY THROUGH THE PRODUCT'S OWN LOSS PATH, not by
    // reaching into the instance: delete the owner key and drive `renewNow()`,
    // which is public. `renewPartitionOnce` nulls the lease on a renew that
    // comes back false, exactly as an expiry or a lost race would, so this
    // proves the guard on the state the product actually produces.
    //
    // The key comes from the PRODUCT's template too: the real owner key is
    // `…:partition:gen-v1:0:owner`, and a hand-written key missing the suffix
    // would delete nothing.
    const ownerKey = new FencedPartitionLeaseStore(runtime(), effective('gen-v1'))
      .proof(0, { token: '0', ownerValue: '' }).ownerKey
    expect(await client.sendCommand(['EXISTS', ownerKey]), 'the arm is about to delete a key that does not exist')
      .toBe(1)
    await client.sendCommand(['DEL', ownerKey])
    await a.renewNow()

    // The loss really happened, and through the counter the product keeps for
    // it — otherwise a `renewNow` that silently did nothing would leave this
    // arm asserting that a cell which never lost its partition still has one.
    expect(a.snapshot().partitionLossCount).toBeGreaterThan(0)
    expect(a.snapshot().partitionReady).toBe(false)

    await passes(a, 1)

    // TAKEN BACK, and still serving. `partitionReady` alone would not say it:
    // the workspace assertion is what distinguishes "it holds a partition
    // again" from "it holds a partition and the leases came back with it".
    expect(a.snapshot().partitionReady, 'a superseded cell could not take its partition back')
      .toBe(true)
    // AND THE WORKSPACE CAME BACK WITH IT. `partitionReady` alone says it holds
    // a partition again, not that it is serving anything — the loss released
    // every lease through the `partition-unavailable` path, so this is the
    // assertion that the cell is actually working again.
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.snapshot().supersededByGeneration).toBe(true)
  }, 120_000)

  it('a contract whose partition COUNT also changed does not stand the cell down — the indices name different workspaces', async () => {
    // On `gen-v1|1` → `gen-v2|2`, a successor holding index 0 is not evidence
    // that a workspace hashing to index 1 under the NEW count is covered. The
    // successor probe resolves `lease.partition` — an index computed under THIS
    // cell's count — against the successor generation's key space, so it must
    // also check that the two key spaces index the same partitioning;
    // otherwise standing down would leave such a workspace owned by NOBODY.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)
    const tokenBefore = a.fencingToken(WORKSPACE)

    // A successor on a new generation AND a bigger count. It is a genuine
    // successor by every other measure — that is what makes this arm different
    // from ARM 3, where there is simply nobody.
    await rewriteContract('gen-v2', 2)
    const successorPartitions = new FencedPartitionLeaseStore(runtime(), effective('gen-v2'))
    expect(await successorPartitions.acquire(0, 'cell-b', 60_000, null)).not.toBeNull()

    await passes(a, STAND_DOWN_PASSES + 2)

    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.owns(WORKSPACE), 'the cell handed over on a count change — half its workspaces now belong to nobody')
      .toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)
    expect(a.snapshot().standDownActive).toBe(false)
    expect(a.snapshot().canServe).toBe(true)
  }, 120_000)

  it('a contract that DISAPPEARS after a hand-over does not un-do it', async () => {
    // `verification.agreed` is true for an ABSENT key, deliberately, because
    // that is the wiped-Redis case. A recovery branch that reset BOTH flags on
    // `agreed` would re-arm a cell that had already handed over the instant the
    // contract key went away: it would take its own dead generation's partition
    // straight back and sit being refused by the successor — the cross-
    // generation stall, restored, after a hand-over that was correct when it
    // was made.
    //
    // Forgetting the DISAGREEMENT on an absent key is right — there is no
    // contract left to disagree with. Forgetting the DECISION is not: it was
    // taken on evidence that was true, and the successor is still out there
    // holding the workspaces.
    const a = await boot('cell-a', 'gen-v1')
    await rewriteContract('gen-v2')
    const b = await boot('cell-b', 'gen-v2')
    await passes(a, STAND_DOWN_PASSES)
    await passes(b, 1)

    // The hand-over is complete before the wipe — asserted, not assumed, or the
    // arm below would be measuring a cell that never stood down.
    expect(a.snapshot().standDownActive).toBe(true)
    expect(b.owns(WORKSPACE)).toBe(true)

    await client.sendCommand(['DEL', `${prefix}:sync-cell:topology`])
    await passes(a, STAND_DOWN_PASSES + 2)

    expect(a.snapshot().standDownActive, 'the hand-over was un-done by the contract key disappearing').toBe(true)
    expect(a.snapshot().partitionReady, 'A took its dead generation partition back').toBe(false)
    expect(a.owns(WORKSPACE)).toBe(false)
    // AND B KEEPS IT. The point of not re-arming is that the successor is
    // undisturbed; `!a.owns()` alone would also be satisfied by both cells
    // holding nothing.
    expect(b.owns(WORKSPACE)).toBe(true)
    // The DISAGREEMENT is forgotten though, and that is correct: there is no
    // contract to disagree with any more. The two flags part company here,
    // which is the clearest statement of why they are two.
    expect(a.snapshot().supersededByGeneration).toBe(false)
  }, 120_000)

  it('a stood-down cell STOPS ANSWERING READY, because it can no longer serve OR forward', async () => {
    // `canServe` is what `/api/ready` answers on, and its justification — set
    // out at the caller in `index.ts` — is that a cell owning nothing still
    // says yes BY FORWARDING. A stood-down cell cannot: `resolveOwner` reads
    // `partition:<config generation>:<n>:owner`, and the stand-down has just
    // deleted it. The cell resolves null for ever, so REST answers 503 and
    // Automerge upgrades are rejected — while a load balancer seeing 200 would
    // go on sending it its share, until somebody removed the old pods by hand.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.snapshot().canServe, 'a healthy owner must answer ready').toBe(true)

    await rewriteContract('gen-v2')
    const b = await boot('cell-b', 'gen-v2')
    expect(b.snapshot().partitionReady).toBe(true)

    // SUPERSEDED BUT NOT YET STOOD DOWN — one pass with no successor probe
    // reachable would leave `canServe` true, which is correct and is what the
    // next arm-pair pins. Here the successor IS present, so this pass stands
    // A down.
    await passes(a, STAND_DOWN_PASSES)

    expect(a.snapshot().canServe, 'a stood-down cell still says it can serve — the load balancer will keep feeding it')
      .toBe(false)
    // AND B, WHICH CAN ACTUALLY SERVE, SAYS SO. Without this the assertion
    // above is satisfied by a change that makes every cell unready.
    expect(b.snapshot().canServe).toBe(true)
  }, 120_000)

  it('a superseded cell with NO successor KEEPS answering ready — readiness follows the stand-down, not the disagreement', async () => {
    // THE CONTROL FOR THE ARM ABOVE, and it is the one that stops the fix being
    // worse than the bug. With no successor deployed every cell in the fleet
    // sets `supersededByGeneration`; gating readiness on THAT flag would empty
    // the load balancer's target group in one reconcile interval — the same
    // fleet-wide outage this whole design is shaped around, arriving through
    // the health check instead of through the lease.
    //
    // Swapping `standDownActive` for `supersededByGeneration` in `canServe`
    // passes the arm above and fails here, which is why the arm above is worth
    // anything.
    const a = await boot('cell-a', 'gen-v1')

    await rewriteContract('gen-v2')
    await passes(a, STAND_DOWN_PASSES + 2)

    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.snapshot().canServe, 'a superseded cell with nobody to hand over to was taken out of the load balancer')
      .toBe(true)
    expect(a.owns(WORKSPACE)).toBe(true)
  }, 120_000)

  it('Redis WIPED and then a new fleet appears: the old cell hands over rather than fighting a contract it did not write', async () => {
    // Not the same as either arm it looks like. The plain wipe (above) leaves no contract at
    // all and must change nothing. THIS is a wipe followed by a `gen-v2` cell
    // booting and CREATING the contract — the ordinary shape of "Redis was
    // rebuilt and the new roster came up against it".
    //
    // What makes it worth its own arm rather than a rerun of ARM 1: the wipe
    // takes A's workspace owner key with it, so A believes it holds a lease
    // that Redis no longer has. A remedy that reasoned from its own in-process
    // lease map rather than from the contract could behave differently here,
    // and the two states are indistinguishable from inside `owns()`.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.owns(WORKSPACE)).toBe(true)

    // The wipe: every key in this suite's namespace, contract and leases alike.
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    expect(keys.length, 'the wipe removed nothing — this arm would prove nothing').toBeGreaterThan(0)
    await client.sendCommand(['DEL', ...keys])

    // Establish the changed durable witness for this explicit external-state
    // scenario. Leave Redis absent so the real successor remains its creator.
    await rewriteMirror('gen-v2')
    expect(await client.get(`${prefix}:sync-cell:topology`)).toBeNull()
    // The new fleet comes up against the empty Redis and defines the contract,
    // which is exactly what `ensureTopology` is for.
    const b = await boot('cell-b', 'gen-v2')
    expect(b.snapshot().topologyKeyCreatedAtBoot, 'B did not create the contract — the wipe did not take it')
      .toBe(true)
    expect(b.snapshot().partitionReady).toBe(true)

    await passes(a, STAND_DOWN_PASSES)

    // A HANDS OVER. It is not fighting: the contract it disagrees with is the
    // live one, a cell on it holds A's partition, and A's own leases went with
    // the wipe anyway. Standing down here costs nothing and clearing the way
    // costs nothing either — the workspace is already B's to take.
    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.owns(WORKSPACE), 'A kept believing it owned a workspace whose key was wiped').toBe(false)

    await passes(b, 1)
    expect(b.owns(WORKSPACE)).toBe(true)
    expect(await ownerValue()).toBe(`cell-b|${b.fencingToken(WORKSPACE)}|gen-v2.ce1461953e2b8ac2`)
  }, 120_000)

  it('a FAILED contract read is not a disagreement, and does not latch — the previous reading stands', async () => {
    // Pins the docblock beside that `catch`: a failed read must NOT set
    // `supersededByGeneration = true`, and no other arm would notice if it did.
    //
    // WHAT THAT WOULD COST is a false signal rather than an outage — the flag
    // is a state, so the next successful read clears it — but a Redis blip
    // longer than `SyncCellSupersededGeneration`'s fifteen minutes would open a
    // ticket saying the fleet contract has moved when it has not, on every cell
    // at once. That is the shape an on-call learns to ignore the rule by.
    const a = await boot('cell-a', 'gen-v1')
    expect(a.snapshot().supersededByGeneration).toBe(false)
    const errorsBefore = a.snapshot().errorCount

    failTopologyReads = true
    await passes(a, STAND_DOWN_PASSES + 2)

    expect(a.snapshot().supersededByGeneration, 'an unreadable contract was taken for a changed one')
      .toBe(false)
    // AND IT IS NOT SILENT EITHER. "Unknown" that nobody counts is the other
    // failure: the reading is being skipped every pass and the only evidence
    // would be its absence.
    expect(a.snapshot().errorCount).toBeGreaterThan(errorsBefore)
    // Still serving throughout — the read that failed is the stand-down's, and
    // it must not take the workspace with it.
    expect(a.owns(WORKSPACE)).toBe(true)

    // The read comes back and nothing has changed, which is the only thing
    // this arm can say about recovery: the flag was never TRUE here, so an
    // assertion that it is false afterwards is satisfied by a no-op. The real
    // recovery arm is a later one, where the flag is set first.
    failTopologyReads = false
    await passes(a, 1)
    expect(a.snapshot().supersededByGeneration).toBe(false)
    expect(a.owns(WORKSPACE)).toBe(true)
  }, 120_000)

  it('the superseded-without-successor line is emitted ONCE per transition, not once per pass', async () => {
    // A CLAIM IN A COMMENT, MADE CHECKABLE. `firstDisagreement` exists so that a
    // state which can last as long as an operator takes to deploy a roster does
    // not print a line every reconcile interval for hours — that is how a real
    // signal gets filtered out. Without this arm, replacing the predicate with
    // a literal `true` would go unnoticed.
    //
    // The line is the operator's only pointer to the contract value this cell
    // read, so its cardinality is part of what it is for.
    const emitted: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('topology_superseded_without_successor')) {
        emitted.push(args[0])
      }
      realWarn(...args as [])
    }
    try {
      const a = await boot('cell-a', 'gen-v1')
      await rewriteContract('gen-v2')
      await passes(a, 4)

      expect(emitted, 'the line repeats every pass — hours of it during a slow roster deploy')
        .toHaveLength(1)

      // AND IT SPEAKS AGAIN ON A NEW TRANSITION. A latch that only ever fires
      // once per process would also satisfy the assertion above, and would go
      // silent on the second, different incident.
      await rewriteContract('gen-v1')
      await passes(a, 1)
      await rewriteContract('gen-v3')
      await passes(a, 1)
      expect(emitted, 'the line never came back after the state was left and re-entered')
        .toHaveLength(2)
    } finally {
      console.warn = realWarn
    }
  }, 120_000)

  it('a FAILED successor probe keeps the cell serving, and is COUNTED', async () => {
    // THE SIBLING CATCH, symmetric with the contract-read one: its
    // `errorCount` increment is asserted too, so a bare `catch {}` in place of
    // `catch (error) { this.recordError(...) }` goes red.
    //
    // The two halves matter separately. NOT STANDING DOWN is the safety half —
    // a probe that could not answer "is a successor there" must not be read as
    // "yes". BEING COUNTED is the visibility half: this is the one read that
    // decides whether the fleet hands over, and a fleet where it fails every
    // pass would sit superseded for ever with nothing but silence to show for
    // it.
    const a = await boot('cell-a', 'gen-v1')
    const tokenBefore = a.fencingToken(WORKSPACE)

    await rewriteContract('gen-v2')
    const b = await boot('cell-b', 'gen-v2')
    expect(b.snapshot().partitionReady).toBe(true)

    // A real successor IS present — that is what makes this arm about the probe
    // rather than about there being nobody. Only the READ fails.
    failSuccessorProbeFor = effective('gen-v2')
    const errorsBefore = a.snapshot().errorCount
    await passes(a, STAND_DOWN_PASSES)

    expect(a.snapshot().errorCount, 'the successor probe failed silently — nothing counts this read')
      .toBeGreaterThan(errorsBefore)
    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.snapshot().standDownActive, 'an unanswerable probe was read as "a successor is there"').toBe(false)
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.fencingToken(WORKSPACE)).toBe(tokenBefore)

    // AND IT HANDS OVER ONCE THE READ COMES BACK. Without this the arm is
    // satisfied by a probe failure that wedges the stand-down permanently,
    // which is the other way to be wrong here.
    failSuccessorProbeFor = null
    await passes(a, STAND_DOWN_PASSES)
    expect(a.snapshot().standDownActive).toBe(true)
    expect(a.owns(WORKSPACE)).toBe(false)
  }, 120_000)

  it('a stood-down cell RECOVERS when the contract is rolled back — the latch has an exit', async () => {
    // THE RECOVERY BRANCH. This is the only arm that drives a cell from
    // superseded back to agreeing, so it is what catches deleting
    // `supersededByGeneration = false` or `standDownActive = false` (or both)
    // from the `agreed` branch.
    //
    // WHAT THAT WOULD COST, given `canServe` is gated on the latch: a latch
    // with no exit is a cell that never answers `/api/ready`
    // again and never takes a partition again — out of the load balancer for
    // the life of the process, while the contract names its own generation and
    // everything else says it is healthy. An operator who rolled a generation
    // by mistake and rolled it straight back would have to restart the fleet.
    const a = await boot('cell-a', 'gen-v1')
    await rewriteContract('gen-v2')
    const b = await boot('cell-b', 'gen-v2')
    await passes(a, STAND_DOWN_PASSES)

    // The state to recover FROM, asserted rather than assumed — without this
    // the arm below could pass on a cell that never stood down.
    expect(a.snapshot().standDownActive).toBe(true)
    expect(a.snapshot().supersededByGeneration).toBe(true)
    expect(a.snapshot().canServe).toBe(false)
    expect(a.owns(WORKSPACE)).toBe(false)

    // The operator rolls it back. B is stopped first, as a real rollback would
    // — leaving it running would have it re-take the workspace from A on the
    // very next pass and this arm would be measuring a race.
    await b.stop()
    running.splice(running.indexOf(b), 1)
    await rewriteContract('gen-v1')

    await passes(a, STAND_DOWN_PASSES)

    expect(a.snapshot().supersededByGeneration, 'the disagreement outlived the contract that caused it')
      .toBe(false)
    expect(a.snapshot().standDownActive, 'the latch has no exit — this cell is out of the fleet for good')
      .toBe(false)
    // AND IT IS BACK IN SERVICE, all three of the things the stand-down took
    // away. `canServe` is the one that matters most: without it the cell is
    // healthy, owns its workspace, and still gets no traffic.
    expect(a.snapshot().partitionReady).toBe(true)
    expect(a.owns(WORKSPACE)).toBe(true)
    expect(a.snapshot().canServe).toBe(true)
  }, 120_000)

  it('the partition under the OLD generation is given up too, so the old cell stops advertising a route', async () => {
    // THE HALF A WORKSPACE ASSERTION CANNOT SEE. `resolve()` reads the partition
    // key to answer "which cell serves this partition", and the ROUTER on the
    // old generation still asks. A cell that released its workspaces but kept
    // `partition:gen-v1:0` would go on being named as the owner of a partition
    // it serves nothing on — a route to a cell that will 503, which reads to an
    // operator as the new fleet being broken.
    const oldPartitions = new FencedPartitionLeaseStore(runtime(), effective('gen-v1'))

    const a = await boot('cell-a', 'gen-v1')
    expect(await oldPartitions.resolve(0)).not.toBeNull()

    await rewriteContract('gen-v2')
    const b = await boot('cell-b', 'gen-v2')
    expect(b.snapshot().partitionReady).toBe(true)

    await passes(a, STAND_DOWN_PASSES)

    expect(a.snapshot().partitionReady).toBe(false)
    expect(a.snapshot().partitionIndex).toBeNull()
    expect(await oldPartitions.resolve(0), 'the superseded cell is still advertised on the old generation')
      .toBeNull()
  }, 120_000)
})
