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

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RedisRuntime } from '../runtime/redis.js'
import { notifyWorkspaceCreated } from '../rbac/docScope.js'
import type { WorkerPartitionLease } from './partitionLeaseWorker.js'
import { syncCellPartitionConfig, workspacePartition } from './assignment.js'
import {
  FencedPartitionLeaseStore,
  FencedWorkspaceLeaseStore,
  SyncCellOwnershipCoordinator,
  SyncCellTopologyMismatchError,
  syncCellOwnershipConfig,
  syncCellOwnershipMetricSamples,
  type SyncCellOwnershipConfig,
  type PlacementResolver,
} from './ownership.js'

class FakeRedis {
  configured = true
  ready = true
  failNextWorkspaceRenew = false
  prefix = 'test'
  private readonly values = new Map<string, string>()
  private readonly sequences = new Map<string, number>()

  deleteWorkspaceOwners(): void {
    for (const key of this.values.keys()) {
      if (key.includes(':sync-cell:owner:')) this.values.delete(key)
    }
  }

  workspaceOwner(workspace: { landscapeId: string; versionId: string }): string | null {
    const digest = createHash('sha256')
      .update(`${workspace.landscapeId}\0${workspace.versionId}`)
      .digest('hex')
    return this.values.get(`${this.prefix}:sync-cell:owner:${digest}`) ?? null
  }

  /** Put a live incumbent in place WITHOUT going through `acquire`.
   *
   *  Needed because two of the three generation-guard cases are owner values
   *  this binary cannot write: a pre-upgrade two-component lease, and a lease
   *  belonging to another generation. A fixture assembled from the current
   *  acquire path can express neither. Digest
   *  computed the same way `FencedWorkspaceLeaseStore.keys` computes it — if
   *  that changes, this seeds a key nothing reads and the arms go red rather
   *  than passing over an absent incumbent. */
  seedOwner(workspace: { landscapeId: string, versionId: string }, value: string): void {
    const digest = createHash('sha256')
      .update(`${workspace.landscapeId}\0${workspace.versionId}`)
      .digest('hex')
    this.values.set(`${this.prefix}:sync-cell:owner:${digest}`, value)
    // AND THE SEQUENCE THAT ISSUED THAT TOKEN. Seeding the owner alone builds a
    // state Redis cannot be in — a lease at token 7 beside a sequence at 0 —
    // and it hides the property the arms exist to check: the successor's token
    // must EXCEED the incumbent's, because that is what fences the loser's
    // in-flight writes. Without this the successor would come back at token 1.
    const token = Number(value.split('|')[1])
    if (Number.isInteger(token)) {
      const sequenceKey = `${this.prefix}:sync-cell:fence:${digest}`
      this.sequences.set(sequenceKey, Math.max(this.sequences.get(sequenceKey) ?? 0, token))
    }
  }

  async send<T>(args: string[]): Promise<T> {
    if (!this.ready) throw new Error('Redis unavailable')
    if (args[0] === 'GET') return (this.values.get(args[1]) ?? null) as T
    if (args[0] === 'MGET') return args.slice(1).map(key => this.values.get(key) ?? null) as T
    const script = args[1] ?? ''
    const ownerKey = args[3]
    // Placed adds authority/census KEYS. ARGV begins after the declared key
    // count, not at the old three-key offsets. This fake remains a contract
    // model; the authority/refusal Lua runs in
    // `ownership.placementAcquire.integration.test.ts`.
    const argv = args.slice(3 + Number(args[2]))
    // The topology contract, modelling THREE outcomes: 2 for created, 1 for
    // matched, 0 for a disagreement. A fake answering 1 for both of the first
    // two would hide the created/matched bit from every unit test here.
    //
    // It is still a RE-IMPLEMENTATION and not the Lua, which is why the create /
    // match distinction is pinned against a real Redis in
    // `topologyIdentity.integration.test.ts` — collapsing the two is caught
    // there, not here.
    if (script.includes("redis.call('SET', KEYS[1], ARGV[1])")) {
      const expected = args[4]
      const current = this.values.get(ownerKey)
      if (!current) {
        this.values.set(ownerKey, expected)
        return 2 as T
      }
      return (current === expected ? 1 : 0) as T
    }
    if (script.includes("local minimum = tonumber(ARGV[1])")) {
      const sequenceKey = args[3]
      const minimum = Number(args[4])
      this.sequences.set(sequenceKey, Math.max(this.sequences.get(sequenceKey) ?? 0, minimum))
      return this.sequences.get(sequenceKey) as T
    }
    // The partition-proof acquire. It MODELS THE GENERATION GUARD rather than
    // only the proof check, because a fake that answers the guard's question
    // wrong is worse than one that does not answer it at all: every arm built
    // on it would report a property of the fake.
    //
    // Faithful to the script's two-element contract as well: an empty second
    // element for a stale proof, the incumbent's own value for a generation
    // refusal. `acquireForPartition` reads exactly that byte to pick which
    // counter the refusal belongs to.
    if (script.includes("KEYS[3]") && script.includes("redis.call('INCR'")) {
      const sequenceKey = args[4]
      const partitionOwnerKey = args[5]
      const expectedPartitionOwner = argv[2]
      const generation = argv[3] ?? ''
      if (this.values.get(partitionOwnerKey) !== expectedPartitionOwner) return ['0', ''] as T
      const current = this.values.get(ownerKey)
      if (current !== undefined) {
        const incumbentGeneration = /^[^|]*\|[^|]*\|(.*)$/.exec(current)?.[1]
        if (incumbentGeneration !== undefined && incumbentGeneration !== generation) {
          return ['0', current] as T
        }
      }
      const token = (this.sequences.get(sequenceKey) ?? 0) + 1
      this.sequences.set(sequenceKey, token)
      const value = `${argv[0]}|${token}|${generation}`
      this.values.set(ownerKey, value)
      return [String(token), value] as T
    }
    if (script.includes("redis.call('INCR'")) {
      const sequenceKey = args[4]
      const current = this.values.get(ownerKey)
      if (current) return ['0', current] as T
      const token = (this.sequences.get(sequenceKey) ?? 0) + 1
      this.sequences.set(sequenceKey, token)
      // Three parts unconditionally: `ACQUIRE_SCRIPT` always appends the
      // generation.
      const value = `${args[5]}|${token}|${args[7]}`
      this.values.set(ownerKey, value)
      return [String(token), value] as T
    }
    const expected = argv[0]
    if (script.includes("redis.call('PEXPIRE'")) {
      if (this.failNextWorkspaceRenew && ownerKey.includes(':sync-cell:owner:')) {
        this.failNextWorkspaceRenew = false
        throw new Error('transient Redis timeout')
      }
      return (this.values.get(ownerKey) === expected ? 1 : 0) as T
    }
    if (script.includes("redis.call('DEL'")) {
      if (this.values.get(ownerKey) !== expected) return 0 as T
      this.values.delete(ownerKey)
      return 1 as T
    }
    throw new Error('unexpected Redis command')
  }
}

function config(cellId: string, overrides: Partial<SyncCellOwnershipConfig> = {}): SyncCellOwnershipConfig {
  return {
    ...syncCellOwnershipConfig({
      SYNC_CELL_OWNERSHIP: 'on',
      SYNC_CELL_ID: cellId,
      SYNC_CELL_ADVERTISE_URL: 'http://cell.internal:3001',
      SYNC_CELL_PARTITION_COUNT: String(overrides.partitionCount ?? 1),
      SYNC_CELL_MULTI_PARTITION: 'on',
    }),
    reconcileIntervalMs: 300_000,
    telemetryIntervalMs: 300_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    ...overrides,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function fakePool(
  tokens: string[] = [],
  workspaces: Array<{ landscape_id: string; id: string }> = [{ landscape_id: 'landscape-1', id: 'current' }],
  afterPersist?: (token: string) => Promise<void>,
): Pool {
  /** What this fake has actually persisted, per workspace. The flat `tokens`
   * array above is a chronological log the callers assert on; this is the
   * TABLE, and the fence reassertion survey needs a table rather than a log. */
  const persisted = new Map<string, { token: string; cellId: string }>()
  let topologyValue: string | null = null
  return {
    async connect() {
      // The real placed coordinator keeps one dedicated LISTEN checkout.
      // This unit fixture models its interface and release; no NOTIFY or
      // PostgreSQL transport is claimed here.
      const client = new EventEmitter()
      return Object.assign(client, {
        async query(text: string) {
          expect(text).toBe('LISTEN workspace_placement_changed')
          return { rows: [], rowCount: 0 }
        },
        release() { client.removeAllListeners() },
      })
    },
    async query(text: string, values?: unknown[]) {
      // This fake must acknowledge the new durable write before admission.
      // Real comparison/publication semantics are pinned by the PG suite.
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
        return { rows: workspaces }
      }
      if (text.includes('SELECT fencing_token FROM sync_workspace_ownership')) {
        return { rows: tokens.length ? [{ fencing_token: tokens.at(-1)! }] : [] }
      }
      if (text.includes('INSERT INTO sync_workspace_ownership')) {
        tokens.push(String(values?.[3]))
        persisted.set(`${String(values?.[0])}/${String(values?.[1])}`, {
          token: String(values?.[3]),
          cellId: String(values?.[2]),
        })
        if (afterPersist) await afterPersist(String(values?.[3]))
        return { rows: [], rowCount: 1 }
      }
      // The fence reassertion survey (`reassertHeldFences`), recognised by its
      // two array parameters. Answering it EMPTILY would make every held lease
      // look like a durable row that was deleted, so the repair half would fire
      // on every pass and push tokens nobody asked for. Production persists a
      // row when it acquires, so the honest answer is the row this fake has
      // already recorded.
      if (Array.isArray(values?.[0]) && Array.isArray(values?.[1])) {
        const landscapes = values[0] as string[]
        const versions = values[1] as string[]
        return {
          rows: landscapes.flatMap((landscapeId, index) => {
            const row = persisted.get(`${landscapeId}/${versions[index]}`)
            return row === undefined ? [] : [{
              landscape_id: landscapeId,
              version_id: versions[index]!,
              fencing_token: row.token,
              cell_id: row.cellId,
              released: false,
            }]
          }),
        }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool
}

/** A controlled worker boundary, not a worker-thread integration fixture.
 * Acquiring goes through the real partition store and writes the Redis proof
 * needed by workspace admission. Only the independently advancing heartbeat is
 * injected; no test installs a partition lease directly in the coordinator. */
class FakePartitionWorker {
  current: WorkerPartitionLease | null = null
  startedAt: number | null = null
  readonly acquired: number[] = []
  readonly released: WorkerPartitionLease[] = []
  readonly proofReads: Array<WorkerPartitionLease | undefined> = []
  private nextIncarnation = 1

  constructor(
    private readonly store: FencedPartitionLeaseStore,
    private readonly settings: SyncCellOwnershipConfig,
    private readonly now: () => number,
  ) {}

  async acquire(partition: number): Promise<WorkerPartitionLease | null> {
    if (this.current) return this.current.partition === partition ? this.current : null
    const startedAt = this.now()
    const acquired = await this.store.acquire(
      partition, this.settings.cellId, this.settings.partitionLeaseTtlMs, this.settings.advertiseUrl,
    )
    if (!acquired) return null
    this.current = { ...acquired, partition, incarnation: this.nextIncarnation++ }
    this.startedAt = startedAt
    this.acquired.push(partition)
    return this.current
  }

  lastRenewStartedAt(expectedLease: WorkerPartitionLease): number | null {
    this.proofReads.push(expectedLease)
    return expectedLease && this.current
      && expectedLease.partition === this.current.partition
      && expectedLease.ownerValue === this.current.ownerValue
      && expectedLease.incarnation === this.current.incarnation
      ? this.startedAt
      : null
  }

  replaceProofIncarnation(): void {
    if (!this.current) throw new Error('the fixture must acquire before replacing its proof')
    this.current = { ...this.current, incarnation: this.nextIncarnation++ }
    this.startedAt = this.now()
  }

  async release(lease: WorkerPartitionLease): Promise<boolean> {
    this.released.push(lease)
    if (this.current?.incarnation !== lease.incarnation) return false
    this.current = null
    this.startedAt = null
    return this.store.release(lease.partition, lease)
  }

  async stop(): Promise<void> {
    if (this.current) await this.release(this.current)
  }
}

function withPartitionWorker(
  redis: FakeRedis,
  db: Pool,
  now: () => number,
  overrides: Partial<SyncCellOwnershipConfig> = {},
  placement?: PlacementResolver,
) {
  // Install the seam before start/acquire, without launching the actual worker
  // factory. The client and worker thread have their separate execution tests.
  const settings = config('cell-a', overrides)
  const coordinator = new SyncCellOwnershipCoordinator(db, redis as unknown as RedisRuntime, settings, now, placement)
  const worker = new FakePartitionWorker(
    new FencedPartitionLeaseStore(redis as unknown as RedisRuntime, settings.topologyGeneration), settings, now,
  )
  const internals = coordinator as unknown as {
    partitionWorker: FakePartitionWorker | null
    partitionLease: (WorkerPartitionLease & { validUntil: number }) | null
    leases: Map<string, { token: string; ownerValue: string }>
  }
  internals.partitionWorker = worker
  return { coordinator, worker, internals }
}

describe('syncCellOwnershipConfig — lease command timeout (I4)', () => {
  /**
   * If the partition lease TTL and the Redis command timeout were equal, ONE
   * stalled renew would consume the entire TTL and the cell would lose its
   * partition — a failure that looks like a spurious failover rather than a
   * timeout. So the lease command timeout is DERIVED from the TTL and renew
   * interval rather than cross-validated against an independent setting.
   */
  it('derives a timeout that leaves the renew loop a retry budget', () => {
    const config = syncCellOwnershipConfig({ SYNC_CELL_ID: 'cell' })
    // (1500 - 400) / 2 = 550: one full retry fits inside the TTL after a stall.
    expect(config.leaseCommandTimeoutMs).toBe(550)
    expect(config.leaseCommandTimeoutMs + config.partitionRenewIntervalMs)
      .toBeLessThan(config.partitionLeaseTtlMs)
  })

  it('scales the derived timeout with an operator-widened TTL', () => {
    const config = syncCellOwnershipConfig({
      SYNC_CELL_ID: 'cell',
      SYNC_CELL_PARTITION_LEASE_TTL_MS: '5000',
      SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '1000',
    })
    expect(config.leaseCommandTimeoutMs).toBe(2_000)
  })

  it('never derives a timeout too small to complete a command', () => {
    const config = syncCellOwnershipConfig({
      SYNC_CELL_ID: 'cell',
      SYNC_CELL_PARTITION_LEASE_TTL_MS: '750',
      SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '360',
    })
    expect(config.leaseCommandTimeoutMs).toBe(195)
    expect(config.leaseCommandTimeoutMs).toBeGreaterThanOrEqual(100)
  })

  /**
   * The plan's own warning about this fix: "a config field added without
   * threading it into both lease connections is inert — it looks fixed and
   * changes nothing." Both call sites construct their RedisRuntime from
   * `redisRuntimeConfig()`, whose commandTimeoutMs default is the very 1500 ms
   * that equals the TTL. So the value existing in the config object proves
   * nothing; what matters is that it REACHES a connection.
   *
   * Asserted by reading both call sites, because neither is reachable from a
   * unit test: one runs inside `main()` after pools and Express are built, the
   * other inside a worker thread.
   */
  it('reaches both lease connections, not just the config object', async () => {
    const read = async (relative: string): Promise<string> => {
      const { readFile } = await import('node:fs/promises')
      const { fileURLToPath } = await import('node:url')
      const { dirname, resolve } = await import('node:path')
      const here = dirname(fileURLToPath(import.meta.url))
      return readFile(resolve(here, relative), 'utf8')
    }

    // The in-process path, which is the DEFAULT: SYNC_CELL_PARTITION_WORKER is
    // off unless opted into, so a fix that missed this one would apply only to
    // the configuration almost nobody runs.
    const index = await read('../index.ts')
    expect(index).toMatch(
      /new RedisRuntime\(\s*\{\s*\.\.\.redisRuntimeConfig\(\),\s*commandTimeoutMs:\s*syncCellOwnershipConfig\(\)\.leaseCommandTimeoutMs/,
    )

    // The worker path.
    const worker = await read('./partitionLeaseWorker.ts')
    expect(worker).toMatch(
      /new RedisRuntime\(\s*\{\s*\.\.\.redisRuntimeConfig\(\),\s*commandTimeoutMs:\s*options\.commandTimeoutMs/,
    )
    // ...and the coordinator has to actually supply it.
    const ownership = await read('./ownership.ts')
    expect(ownership).toMatch(/commandTimeoutMs:\s*this\.config\.leaseCommandTimeoutMs/)
  })

  it('validates an EXPLICIT override, which is the only place a rule is safe', () => {
    expect(() => syncCellOwnershipConfig({
      SYNC_CELL_ID: 'cell',
      SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS: '1200',
    })).toThrow('SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS')

    expect(syncCellOwnershipConfig({
      SYNC_CELL_ID: 'cell',
      SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS: '300',
    }).leaseCommandTimeoutMs).toBe(300)
  })
})

describe('syncCellOwnershipConfig', () => {
  it('is opt-in and rejects an unsafe renewal window', () => {
    expect(syncCellOwnershipConfig({ SYNC_CELL_ID: 'Cell A' })).toMatchObject({
      enabled: false,
      cellId: 'cell-a',
      advertiseUrl: null,
      leaseTtlMs: 15_000,
      renewIntervalMs: 5_000,
      partitionLeaseTtlMs: 1_500,
      partitionRenewIntervalMs: 400,
      partitionWorker: false,
      partitionCount: 1,
      configuredGeneration: 'v1',
      effectiveGeneration: 'v1.ce1461953e2b8ac2',
      topologyGeneration: 'v1.ce1461953e2b8ac2',
    })
    expect(() => syncCellOwnershipConfig({
      SYNC_CELL_LEASE_TTL_MS: '6000',
      SYNC_CELL_RENEW_INTERVAL_MS: '3000',
    })).toThrow('less than half')
    expect(() => syncCellOwnershipConfig({
      SYNC_CELL_PARTITION_LEASE_TTL_MS: '1500',
      SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '750',
    })).toThrow('less than half')
    expect(syncCellOwnershipConfig({
      SYNC_CELL_PARTITION_LEASE_TTL_MS: '750',
      SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '200',
    })).toMatchObject({ partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200 })
    expect(() => syncCellOwnershipConfig({ SYNC_CELL_ADVERTISE_URL: 'file:///tmp/socket' })).toThrow('http or https')
    expect(() => syncCellOwnershipConfig({ SYNC_CELL_ADVERTISE_URL: 'http://cell.internal/path' })).toThrow('scheme, host and port')
    expect(syncCellOwnershipConfig({ SYNC_CELL_ADVERTISE_URL: 'HTTPS://Cell.Internal:8443/' }).advertiseUrl)
      .toBe('https://cell.internal:8443')
    expect(syncCellOwnershipConfig({ SYNC_CELL_PARTITION_WORKER: 'on' }).partitionWorker).toBe(true)
    expect(syncCellOwnershipConfig({ SYNC_CELL_ADMISSION_CONCURRENCY: '1' }).admissionConcurrency).toBe(1)
  })
})

describe('FencedPartitionLeaseStore', () => {
  it('publishes the live owner route in the fenced partition lease', async () => {
    const redis = new FakeRedis()
    const store = new FencedPartitionLeaseStore(redis, 'v1')
    const lease = await store.acquire(3, 'cell-a', 15_000, 'http://cell-a.internal:3001')
    expect(lease).toMatchObject({ token: '1' })
    await expect(store.resolve(3)).resolves.toEqual({
      cellId: 'cell-a',
      token: '1',
      advertiseUrl: 'http://cell-a.internal:3001',
      partition: 3,
    })
    expect(await store.release(3, lease!)).toBe(true)
    await expect(store.resolve(3)).resolves.toBeNull()
  })
})

describe('FencedWorkspaceLeaseStore', () => {
  it('compare-renews/releases and never reuses a fencing token', async () => {
    const redis = new FakeRedis()
    const store = new FencedWorkspaceLeaseStore(redis)
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    const first = await store.acquire(workspace, 'cell-a', 15_000)
    expect(first?.token).toBe('1')
    expect(await store.acquire(workspace, 'cell-b', 15_000)).toBeNull()
    expect(await store.renew(workspace, first!, 15_000)).toBe(true)
    expect(await store.release(workspace, { token: '1', ownerValue: 'cell-b|1' })).toBe(false)
    expect(await store.release(workspace, first!)).toBe(true)
    expect((await store.acquire(workspace, 'cell-b', 15_000))?.token).toBe('2')
  })

  it('continues above the durable fence after Redis sequence loss', async () => {
    const redis = new FakeRedis()
    const store = new FencedWorkspaceLeaseStore(redis)
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    await store.ensureMinimumToken(workspace, 25)
    expect((await store.acquire(workspace, 'cell-a', 15_000))?.token).toBe('26')
  })

  it('replaces a stale workspace lease only with the current partition proof', async () => {
    const redis = new FakeRedis()
    const workspaceStore = new FencedWorkspaceLeaseStore(redis)
    const partitionStore = new FencedPartitionLeaseStore(redis, 'v1')
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    const firstPartition = await partitionStore.acquire(0, 'cell-a', 1_500, 'http://cell-a:3001')
    expect((await workspaceStore.acquire(workspace, 'cell-a', 15_000))?.token).toBe('1')

    // `partition-proof-stale` and NOT `foreign-generation` — both refuse, and
    // asserting only "it refused" would pass with the two swapped, which is the
    // confusion the discriminated result exists to make impossible.
    await expect(workspaceStore.acquireForPartition(workspace, 'cell-b', 15_000, {
      ownerKey: partitionStore.proof(0, firstPartition!).ownerKey,
      ownerValue: 'cell-b|2|http://cell-b:3001',
    })).resolves.toEqual({ acquired: null, refusal: 'partition-proof-stale', incumbent: null })

    expect(await partitionStore.release(0, firstPartition!)).toBe(true)
    const replacementPartition = await partitionStore.acquire(0, 'cell-b', 1_500, 'http://cell-b:3001')
    await expect(workspaceStore.acquireForPartition(
      workspace,
      'cell-b',
      15_000,
      partitionStore.proof(0, replacementPartition!),
    )).resolves.toMatchObject({ acquired: { token: '2', ownerValue: 'cell-b|2|' } })
  })

  /**
   * THE FAKE AND THE LUA, ASKED THE SAME QUESTIONS.
   *
   * The generation guard's parse exists TWICE — as a Lua `string.match` in
   * `ACQUIRE_WORKSPACE_FOR_PARTITION_SCRIPT` and as `/^[^|]*\|[^|]*\|(.*)$/` in
   * this file's `FakeRedis`. Without comparing them, an edit to one would
   * leave every unit test in this file measuring the other and reporting green.
   *
   * These three cases are the SAME three the real Lua answers against a real
   * Redis in `ownership.topologyGeneration.integration.test.ts`. Neither file
   * proves the other correct; what the pair gives is that a divergence shows up
   * as one suite green and the other red, instead of as silence.
   */
  describe('the FakeRedis model answers the guard exactly as the Lua does', () => {
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }

    /** Seed a live incumbent and try to steal it from `generation`. */
    async function steal(incumbentValue: string, generation: string) {
      const redis = new FakeRedis()
      const workspaceStore = new FencedWorkspaceLeaseStore(redis, generation)
      const partitionStore = new FencedPartitionLeaseStore(redis, generation)
      const partition = await partitionStore.acquire(0, 'cell-b', 1_500, 'http://cell-b:3001')
      // Written through the fake's own map rather than through `acquire`, for
      // the same reason the integration arm uses a raw `SET`: two of the three
      // cases are values this binary cannot produce.
      redis.seedOwner(workspace, incumbentValue)
      return workspaceStore.acquireForPartition(
        workspace, 'cell-b', 1_500, partitionStore.proof(0, partition!),
      )
    }

    it('STEALS within one generation', async () => {
      const outcome = await steal('cell-a|7|gen-v1', 'gen-v1')
      expect(outcome.acquired).not.toBeNull()
      expect(outcome.acquired!.ownerValue).toBe('cell-b|8|gen-v1')
    })

    it('REFUSES across generations, naming the incumbent', async () => {
      expect(await steal('cell-a|7|gen-v1', 'gen-v2')).toEqual({
        acquired: null,
        refusal: 'foreign-generation',
        incumbent: 'cell-a|7|gen-v1',
      })
    })

    it('STEALS a pre-upgrade two-part lease, and upgrades it in place', async () => {
      const outcome = await steal('cell-a|7', 'gen-v2')
      expect(outcome.acquired, 'the fake lost the rolling-upgrade escape').not.toBeNull()
      expect(outcome.acquired!.ownerValue).toBe('cell-b|8|gen-v2')
    })
  })
})

describe('SyncCellOwnershipCoordinator — partition renew in-flight guard (I4)', () => {
  /**
   * The renew timer fires every `partitionRenewIntervalMs` (400 ms) and does not
   * wait for the previous renew. A renew that stalls — which is exactly the case
   * the derived command timeout now bounds at 550 ms — therefore overlaps the
   * next tick, and two concurrent renews race on `lease.validUntil`: the slower
   * one can write a validity computed from an OLDER `startedAt`, moving the
   * lease's expiry backwards and making a live cell believe it lost its
   * partition.
   *
   * The worker path already guards this with `renewFlight`. The in-process path
   * did not — and that is the DEFAULT, since SYNC_CELL_PARTITION_WORKER is off
   * unless opted into.
   */
  it('coalesces overlapping renews instead of racing them', async () => {
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool([], []),
      redis as unknown as RedisRuntime,
      config('cell-a'),
    )
    const internals = coordinator as unknown as {
      partitionLease: { partition: number; ownerValue: string; token: string; validUntil: number } | null
      partitionStore: { renew: (...args: unknown[]) => Promise<boolean> }
      renewPartition: () => Promise<void>
    }
    internals.partitionLease = {
      partition: 0, ownerValue: 'cell-a|1', token: '1', validUntil: Date.now() + 1_500,
    }

    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    let release: (() => void) | null = null
    internals.partitionStore.renew = async () => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => { release = resolve })
      inFlight -= 1
      return true
    }

    const first = internals.renewPartition()
    await new Promise((resolve) => setImmediate(resolve))
    const second = internals.renewPartition()
    await new Promise((resolve) => setImmediate(resolve))

    expect(maxInFlight).toBe(1)
    expect(calls).toBe(1)

    release?.()
    await Promise.all([first, second])
  })
})

describe('SyncCellOwnershipCoordinator', () => {
  it('bounds concurrent workspace admission listeners independently from lease renewal', async () => {
    const redis = new FakeRedis()
    const workspaces = Array.from({ length: 5 }, (_, index) => ({
      landscape_id: `landscape-${index}`,
      id: `version-${index}`,
    }))
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool([], workspaces),
      redis as unknown as RedisRuntime,
      config('cell-a', { concurrency: 5, admissionConcurrency: 1 }),
    )
    let active = 0
    let maximumActive = 0
    coordinator.onOwnershipAcquired(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
    })

    await coordinator.start()

    expect(maximumActive).toBe(1)
    expect(coordinator.snapshot().ownedWorkspaceCount).toBe(5)
    await coordinator.stop()
  })

  it('does not expose a transferred lease until acquisition refresh finishes', async () => {
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool(['7']), redis as unknown as RedisRuntime, config('cell-b'),
    )
    let releaseRefresh!: () => void
    const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const observedTokens: string[] = []
    coordinator.onOwnershipAcquired(async ({ fencingToken }) => {
      observedTokens.push(fencingToken)
      await refresh
    })
    const start = coordinator.start()
    await expect.poll(() => observedTokens).toEqual(['8'])
    expect(coordinator.snapshot()).toMatchObject({ ready: false, ownedWorkspaceCount: 0 })
    releaseRefresh()
    await start
    expect(coordinator.snapshot()).toMatchObject({ ready: true, ownedWorkspaceCount: 1 })
    await coordinator.stop()
  })

  it('keeps a competing cell unready, then transfers ownership with a higher token', async () => {
    const redis = new FakeRedis()
    const persistedTokens: string[] = []
    const db = fakePool(persistedTokens)
    const first = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-a'),
    )
    const second = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-b'),
    )

    await first.start()
    await second.start()
    expect(first.snapshot()).toMatchObject({ ready: true, ownedWorkspaceCount: 1 })
    expect(second.snapshot()).toMatchObject({ ready: false, ownedWorkspaceCount: 0, conflictCount: 1 })

    await first.stop()
    await second.reconcileNow()
    expect(second.snapshot()).toMatchObject({ ready: true, ownedWorkspaceCount: 1 })
    expect(persistedTokens).toEqual(['1', '2'])
    await second.stop()
  })

  it.each(['shadow', 'placed'] as const)('T-10h1: two %s cells agree, publish their mode and keep one owner per workspace', async (placementMode) => {
    const redis = new FakeRedis()
    const rows = Array.from({ length: 24 }, (_, index) => ({ landscape_id: `landscape-${index}`, id: `version-${index}` }))
    const db = fakePool([], rows)
    const partition = syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: placementMode })
    const { coordinator: first } = withPartitionWorker(redis, db, () => 1_000, partition)
    const { coordinator: second } = withPartitionWorker(redis, db, () => 1_000, { ...partition, cellId: 'cell-b' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await first.start()
      await second.start()
      expect(first.snapshot()).toMatchObject({ ready: true, placementMode, topologyKeyCreatedAtBoot: true })
      expect(second.snapshot()).toMatchObject({ ready: true, placementMode, topologyKeyCreatedAtBoot: false })
      expect([first.snapshot().partitionIndex, second.snapshot().partitionIndex].sort()).toEqual([0, 1])
      for (const row of rows) {
        const workspace = { landscapeId: row.landscape_id, versionId: row.id }
        expect(Number(first.owns(workspace)) + Number(second.owns(workspace))).toBe(1)
      }
      const emitted = log.mock.calls.map(([value]) => value)
        .filter(value => typeof value === 'string' && value.includes('"event":"sync.cell.ownership"'))
        .map(value => JSON.parse(value as string) as { cellId: string; placementMode: string })
      expect(new Set(emitted.map(event => event.cellId))).toEqual(new Set(['cell-a', 'cell-b']))
      expect(emitted.every(event => event.placementMode === placementMode)).toBe(true)
    } finally {
      const stops = await Promise.allSettled([first.stop(), second.stop()])
      log.mockRestore()
      expect(stops.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    }
  })

  it.each([['shadow', 'placed'], ['placed', 'shadow']] as const)(
    'T-10h1: Redis refuses %s then %s before the inverted resolver acquires, without a shared mirror',
    async (firstMode, secondMode) => {
      const redis = new FakeRedis()
      const rows = Array.from({ length: 24 }, (_, index) => ({ landscape_id: `landscape-${index}`, id: `version-${index}` }))
      const env = { SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
      const firstConfig = syncCellPartitionConfig({ ...env, SYNC_CELL_PLACEMENT_MODE: firstMode })
      const secondConfig = syncCellPartitionConfig({ ...env, SYNC_CELL_PLACEMENT_MODE: secondMode })
      // Separate absent mirrors deliberately force the second boot through the
      // Redis contract check; a shared durable mirror could mask a missing Redis wire.
      const { coordinator: first } = withPartitionWorker(redis, fakePool([], rows), () => 1_000, firstConfig)
      const { coordinator: second, worker } = withPartitionWorker(redis, fakePool([], rows), () => 1_000,
        { ...secondConfig, cellId: 'cell-b' },
        { partitionOf: (workspace, count) => (count - 1) - workspacePartition(workspace, count) })
      const keys = rows.map(row => ({ landscapeId: row.landscape_id, versionId: row.id }))
      try {
        await first.start()
        expect(first.snapshot()).toMatchObject({ ready: true, ownedWorkspaceCount: 16 })
        const owners = keys.map(key => redis.workspaceOwner(key))
        const tokens = keys.map(key => first.fencingToken(key))
        const send = vi.spyOn(redis, 'send')
        try {
          await expect(second.start()).rejects.toBeInstanceOf(SyncCellTopologyMismatchError)
          const contractCalls = send.mock.calls.map(([args]) => args).filter(args => args[0] === 'EVAL' && args[3] === 'test:sync-cell:topology')
          const expected = secondMode === 'shadow' ? 'v1.ce1461953e2b8ac2|2' : 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved='
          expect(contractCalls).toHaveLength(1)
          expect(contractCalls[0][4]).toBe(expected)
        } finally { send.mockRestore() }
        expect(second.snapshot()).toMatchObject({ placementMode: secondMode, topologyConfirmed: false, partitionAcquisitionCount: 0, ownedWorkspaceCount: 0 })
        expect(worker.acquired).toEqual([])
        expect(keys.map(key => redis.workspaceOwner(key))).toEqual(owners)
        expect(keys.map(key => first.fencingToken(key))).toEqual(tokens)
      } finally {
        const stops = await Promise.allSettled([first.stop(), second.stop()])
        expect(stops.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
      }
    },
  )

  it('T-10h1: a persisted shadow mirror refuses placed against empty Redis before any Redis command', async () => {
    const db = fakePool()
    const firstRedis = new FakeRedis(), emptyRedis = new FakeRedis()
    const env = { SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
    const { coordinator: first } = withPartitionWorker(firstRedis, db, () => 1_000, syncCellPartitionConfig(env))
    const { coordinator: second, worker } = withPartitionWorker(emptyRedis, db, () => 1_000,
      { ...syncCellPartitionConfig({ ...env, SYNC_CELL_PLACEMENT_MODE: 'placed' }), cellId: 'cell-b' })
    const send = vi.spyOn(emptyRedis, 'send')
    try {
      await first.start()
      expect(first.snapshot().topologyKeyCreatedAtBoot).toBe(true)
      await expect(second.start()).rejects.toMatchObject({
        name: 'SyncCellTopologyMismatchError',
        durableContract: { expected: 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved=', found: 'v1.ce1461953e2b8ac2|2' },
      })
      expect(send).not.toHaveBeenCalled()
      expect(worker.acquired).toEqual([])
    } finally {
      const stops = await Promise.allSettled([first.stop(), second.stop()])
      send.mockRestore()
      expect(stops.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    }
  })

  it('T-10h1/T-10h3: both modes hash 1000 absent keys after the placed snapshot loads, without I/O per lookup', async () => {
    // Separate contracts let both homogeneous modes boot. Unknown placement
    // before that first SELECT must not be mistaken for an empty snapshot.
    const redis = new FakeRedis(), db = fakePool(), placedDb = fakePool()
    const env = { SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
    const shadow = new SyncCellOwnershipCoordinator(db, redis as unknown as RedisRuntime,
      config('cell-a', syncCellPartitionConfig({ ...env, SYNC_CELL_PLACEMENT_MODE: 'shadow' })))
    const placed = new SyncCellOwnershipCoordinator(placedDb, new FakeRedis() as unknown as RedisRuntime,
      config('cell-b', syncCellPartitionConfig({ ...env, SYNC_CELL_PLACEMENT_MODE: 'placed' })))
    const queries = vi.spyOn(db, 'query')
    const placedQueries = vi.spyOn(placedDb, 'query')
    try {
      expect(() => placed.partitionFor({ landscapeId: 'cold', versionId: 'unknown' }))
        .toThrow('Workspace placement has not loaded')
      await shadow.start()
      await placed.start()
      expect(placedQueries.mock.calls.some(([sql]) => sql.includes('FROM workspace_placement'))).toBe(true)
      expect(placed.snapshot()).toMatchObject({ topologyConfirmed: true, bootReconcileFailed: false, errorCount: 0 })
      queries.mockClear()
      placedQueries.mockClear()
      const seen = new Set<number>()
      for (let index = 0; index < 1_000; index++) {
        const workspace = { landscapeId: `landscape-${index}`, versionId: `version-${index % 17}` }
        const expected = workspacePartition(workspace, 2)
        expect(shadow.partitionFor(workspace)).toBe(expected)
        expect(placed.partitionFor(workspace)).toBe(expected)
        seen.add(expected)
      }
      expect([...seen].sort()).toEqual([0, 1])
      expect(queries).not.toHaveBeenCalled()
      expect(placedQueries).not.toHaveBeenCalled()
    } finally {
      const stops = await Promise.allSettled([shadow.stop(), placed.stop()])
      queries.mockRestore()
      placedQueries.mockRestore()
      expect(stops.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    }
  })

  it('assigns disjoint deterministic workspace partitions to two live cells', async () => {
    const redis = new FakeRedis()
    const workspaces = Array.from({ length: 24 }, (_, index) => ({
      landscape_id: `landscape-${index}`,
      id: `version-${index}`,
    }))
    const db = fakePool([], workspaces)
    const first = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-a', { partitionCount: 2 }),
    )
    const second = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-b', { partitionCount: 2 }),
    )

    try {
      await first.start()
      await second.start()
      const firstSnapshot = first.snapshot()
      const secondSnapshot = second.snapshot()
      expect(firstSnapshot).toMatchObject({ ready: true, partitionCount: 2, discoveredWorkspaceCount: 24, topologyKeyCreatedAtBoot: true, topologyGeneration: 'v1.ce1461953e2b8ac2' })
      expect(secondSnapshot).toMatchObject({ ready: true, partitionCount: 2, discoveredWorkspaceCount: 24, topologyKeyCreatedAtBoot: false, topologyGeneration: 'v1.ce1461953e2b8ac2' })
      expect(firstSnapshot.partitionIndex).not.toBe(secondSnapshot.partitionIndex)
      expect(firstSnapshot.expectedWorkspaceCount + secondSnapshot.expectedWorkspaceCount).toBe(24)
      for (const row of workspaces) {
        const workspace = { landscapeId: row.landscape_id, versionId: row.id }
        expect(Number(first.owns(workspace)) + Number(second.owns(workspace))).toBe(1)
      }
    } finally {
      const stopped = await Promise.allSettled([first.stop(), second.stop()])
      expect(stopped.every(result => result.status === 'fulfilled')).toBe(true)
    }
  })

  // Specifies refusal before acquisition when two builds declare different
  // mapping fingerprints. The matching-mapping control above checks every
  // workspace through the signed factory.
  it('B3d2 refuses a distinct fingerprint before the inverted mapping can acquire', async () => {
    const redis = new FakeRedis()
    const workspaces = Array.from({ length: 24 }, (_, index) => ({ landscape_id: `landscape-${index}`, id: `version-${index}` }))
    const db = fakePool([], workspaces)
    const env = { SYNC_CELL_TOPOLOGY_GENERATION: 'v1', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
    const firstConfig = syncCellPartitionConfig(env, '1111111111111111')
    const secondConfig = syncCellPartitionConfig(env, '2222222222222222')
    const { coordinator: first } = withPartitionWorker(redis, db, () => 1_000, firstConfig)
    const { coordinator: second, worker: secondWorker } = withPartitionWorker(redis, db, () => 1_000,
      { ...secondConfig, cellId: 'cell-b' },
      { partitionOf: (workspace, count) => (count - 1) - workspacePartition(workspace, count) })
    const keys = workspaces.map(row => ({ landscapeId: row.landscape_id, versionId: row.id }))
    const store = new FencedPartitionLeaseStore(redis as unknown as RedisRuntime, firstConfig.topologyGeneration)
    try {
      await first.start()
      expect(first.snapshot()).toMatchObject({
        ready: true, topologyConfirmed: true, topologyKeyCreatedAtBoot: true, partitionIndex: 0,
        configuredGeneration: 'v1', effectiveGeneration: 'v1.1111111111111111', topologyGeneration: 'v1.1111111111111111',
        discoveredWorkspaceCount: 24, expectedWorkspaceCount: 16, ownedWorkspaceCount: 16,
      })
      const ownersBefore = keys.map(key => redis.workspaceOwner(key))
      const tokensBefore = keys.map(key => first.fencingToken(key))
      const partitionBefore = await store.resolve(0)
      expect(partitionBefore).toMatchObject({ cellId: 'cell-a', partition: 0 })
      const refused = second.start()
      await expect(refused).rejects.toBeInstanceOf(SyncCellTopologyMismatchError)
      await expect(refused).rejects.toThrow('B3d1')
      expect(second.snapshot()).toMatchObject({
        ready: false, topologyConfirmed: false, topologyKeyCreatedAtBoot: null,
        discoveredWorkspaceCount: 0, ownedWorkspaceCount: 0, partitionAcquisitionCount: 0,
        configuredGeneration: 'v1', effectiveGeneration: 'v1.2222222222222222',
      })
      expect(secondWorker.acquired).toEqual([])
      expect(await store.verifyTopology(2)).toEqual({
        known: true, agreed: true, expected: 'v1.1111111111111111|2', found: 'v1.1111111111111111|2',
      })
      expect(await store.resolve(0)).toEqual(partitionBefore)
      expect(keys.map(key => redis.workspaceOwner(key))).toEqual(ownersBefore)
      expect(keys.map(key => first.fencingToken(key))).toEqual(tokensBefore)
      const ownerCounts = keys.map(key => Number(first.owns(key)) + Number(second.owns(key)))
      expect(ownerCounts.filter(count => count === 2)).toHaveLength(0)
      expect(ownerCounts.filter(count => count === 1)).toHaveLength(16)
      expect(ownerCounts.filter(count => count === 0)).toHaveLength(8)
      for (let round = 0; round < 3; round++) await first.renewNow()
      expect(keys.map(key => redis.workspaceOwner(key))).toEqual(ownersBefore)
      expect(first.snapshot().workspaceLeaseRecoveryCount).toBe(0)
    } finally {
      const stops = await Promise.allSettled([first.stop(), second.stop()])
      expect(stops.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    }
  })

  it('fails boot when cells disagree on the cluster topology contract', async () => {
    const redis = new FakeRedis()
    const db = fakePool()
    const first = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-a'),
    )
    const divergent = new SyncCellOwnershipCoordinator(
      db, redis as unknown as RedisRuntime, config('cell-b', { partitionCount: 2 }),
    )

    await first.start()
    await expect(divergent.start()).rejects.toThrow('topology mismatch')
    // ...AND IT REPORTS NOTHING ABOUT THE WORLD. `reportDurableFencesWithoutSequence`'s
    // docblock says it runs after `ensureTopology` "because a cell that disagrees
    // about the topology has no business reporting on the world"; this arm is
    // what makes that more than a comment (moving the survey and the topology
    // bit ABOVE the throw turns it red). A cell that
    // is about to refuse to start must not first publish a boot observation that
    // an operator would read as this fleet's.
    expect(divergent.snapshot().topologyKeyCreatedAtBoot).toBeNull()
    expect(divergent.snapshot().bootObservedAt).toBeNull()
    expect(divergent.snapshot().durableFencesWithoutSequence).toBeNull()
    await first.stop()
  })

  it('refuses a topology reply it does not recognise, rather than admitting the cell', async () => {
    // FAIL-CLOSED, and the guard needs its own driver: real Redis only ever
    // returns 0, 1 or 2, so no other test reaches it.
    //
    // A decode written as `!== 0` would be fail-OPEN, because `Number()` of
    // anything non-numeric is NaN and `NaN !== 0` is TRUE. An unrecognised reply
    // would then ADMIT a cell whose partition count disagrees with the fleet's,
    // splitting workspace placement silently — through the one gate whose entire
    // job is to refuse exactly that.
    //
    // Reachable three ways, none exotic: a future rewrite returning `'created'`,
    // a proxy layer answering a status string, and a stub `send` in a test.
    const storeAnswering = (reply: unknown) => new FencedPartitionLeaseStore({
      configured: true,
      ready: true,
      prefix: 'test',
      async send<T>(): Promise<T> { return reply as T },
    } as unknown as RedisRuntime, 'v1')

    for (const reply of ['created', undefined, {}, 'OK', 3, -1]) {
      await expect(
        storeAnswering(reply).ensureTopology(1),
        `a reply of ${JSON.stringify(reply) ?? 'undefined'} was accepted`,
      ).rejects.toThrow(/unrecognised outcome/)
    }

    // `null` is the one that does NOT throw, and the distinction is worth
    // stating rather than lumping in: `Number(null)` is 0, which is the script's
    // own "mismatch" code, so it already refuses. Both routes are fail-closed;
    // only one of them is an error.
    await expect(storeAnswering(null).ensureTopology(1)).resolves.toEqual({ agreed: false, created: false })
  })

  it('reports the topology bit as NOT KNOWN until a real boot sets it', async () => {
    // `null` is a THIRD state — "start() has not run" — and it is the one the
    // metric renders as NaN. Without this arm the state is produced only by
    // hand-built snapshot literals in the metrics test, so changing the field's
    // initialiser to `false` or `true` would go unnoticed.
    const beforeStart = new SyncCellOwnershipCoordinator(
      fakePool(), new FakeRedis() as unknown as RedisRuntime, config('cell-a'),
    )
    expect(beforeStart.snapshot().topologyKeyCreatedAtBoot).toBeNull()
    expect(beforeStart.snapshot().bootObservedAt).toBeNull()

    // ...and a DISABLED cell never reaches the topology check either, so it must
    // keep saying "not known" rather than "I did not create it".
    const disabled = new SyncCellOwnershipCoordinator(
      fakePool(), new FakeRedis() as unknown as RedisRuntime, config('cell-b', { enabled: false }),
    )
    await disabled.start()
    expect(disabled.snapshot().topologyKeyCreatedAtBoot).toBeNull()
    await disabled.stop()
  })

  it('does not re-observe the world when start() is called twice', async () => {
    // `start()` returns early on `this.started`, so the boot observation is
    // taken once. A second call that re-ran `ensureTopology` and re-assigned
    // the field would turn a BOOT observation into a live one whose name still
    // says `AtBoot`, and would publish `created: false` over a `true` an
    // operator was looking at.
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool(), redis as unknown as RedisRuntime, config('cell-a'),
    )
    await coordinator.start()
    const first = coordinator.snapshot()
    expect(first.topologyKeyCreatedAtBoot).toBe(true)
    const observedAt = first.bootObservedAt
    expect(observedAt).toEqual(expect.any(String))

    await coordinator.start()
    expect(coordinator.snapshot().topologyKeyCreatedAtBoot).toBe(true)
    expect(coordinator.snapshot().bootObservedAt).toBe(observedAt)
    await coordinator.stop()
  })

  it('emits one loss event when a live workspace lease can no longer be renewed', async () => {
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool(), redis as unknown as RedisRuntime, config('cell-a'),
    )
    const losses: Array<{ workspace: { landscapeId: string; versionId: string }; reason: string }> = []
    const ownsWhileNotifying: boolean[] = []
    coordinator.onOwnershipLost((event) => {
      losses.push(event)
      ownsWhileNotifying.push(coordinator.owns(event.workspace))
    })
    await coordinator.start()
    redis.deleteWorkspaceOwners()

    await coordinator.renewNow()

    expect(losses).toEqual([{
      workspace: { landscapeId: 'landscape-1', versionId: 'current' },
      reason: 'workspace-lease-lost',
    }])
    expect(ownsWhileNotifying).toEqual([false])
    expect(coordinator.snapshot()).toMatchObject({ ownedWorkspaceCount: 0, lossCount: 1, ready: false })
    await coordinator.stop()
  })

  it('keeps a still-valid workspace lease across a transient Redis renewal timeout', async () => {
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool(), redis as unknown as RedisRuntime, config('cell-a'),
    )
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    redis.failNextWorkspaceRenew = true

    await coordinator.renewNow()

    expect(reasons).toEqual([])
    expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
    expect(coordinator.snapshot()).toMatchObject({
      ready: true,
      ownedWorkspaceCount: 1,
      lossCount: 0,
      errorCount: 1,
    })

    await coordinator.renewNow()
    expect(coordinator.snapshot()).toMatchObject({ ready: true, renewalCount: 1 })
    await coordinator.stop()
  })

  it('T-G1b2 refuses a silent worker at partition TTL plus one second', async () => {
    const redis = new FakeRedis()
    let now = 1_000
    const db = fakePool()
    const { coordinator, worker, internals } = withPartitionWorker(redis, db, () => now)
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      expect(worker.acquired).toEqual([0])
      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
      expect(coordinator.snapshot()).toMatchObject({ minimumRemainingLeaseMs: 1_300 })
      now += config('cell-a').partitionLeaseTtlMs + 1_000
      const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
      const before = JSON.stringify({ partition: internals.partitionLease, leases: [...internals.leases] })
      const query = vi.spyOn(db, 'query')
      const send = vi.spyOn(redis, 'send')
      try {
        for (let sample = 0; sample < 100; sample += 1) {
          expect(coordinator.owns(workspace)).toBe(false)
          expect(coordinator.fencingToken(workspace)).toBeNull()
          expect(coordinator.readSnapshot()).toMatchObject({
            partitionReady: false, partitionIndex: null, ownedWorkspaceCount: 0, partitionLossCount: 0,
          })
          expect(coordinator.snapshot().partitionLossCount).toBe(0)
          expect(syncCellOwnershipMetricSamples(coordinator, now).length).toBeGreaterThan(0)
        }
        expect(JSON.stringify({ partition: internals.partitionLease, leases: [...internals.leases] })).toBe(before)
        expect(reasons).toEqual([])
        expect(query).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
      } finally {
        query.mockRestore()
        send.mockRestore()
      }
      // The same expired authority refuses immediately, but only a reconcile
      // pass performs releases and increments the loss counters.
      await coordinator.reconcileNow()
      expect(coordinator.readSnapshot()).toMatchObject({ ownedWorkspaceCount: 0, partitionLossCount: 1 })
      expect(reasons).toEqual(['partition-expired'])
      expect(internals.leases.size).toBe(0)
    } finally {
      await coordinator.stop()
    }
  })

  it('keeps worker-proved ownership while the main Redis connection recycles', async () => {
    const redis = new FakeRedis()
    const { coordinator } = withPartitionWorker(redis, fakePool(), () => 1_000)
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      redis.ready = false
      await coordinator.renewNow()

      expect(reasons).toEqual([])
      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
      expect(coordinator.snapshot()).toMatchObject({
        ready: true, partitionReady: true, ownedWorkspaceCount: 1, lossCount: 0,
        minimumRemainingLeaseMs: 1_300,
      })
    } finally {
      redis.ready = true
      await coordinator.stop()
    }
  })

  it('recovers an expired workspace lease without draining while the partition worker proves authority', async () => {
    const redis = new FakeRedis()
    const persistedTokens: string[] = []
    const { coordinator } = withPartitionWorker(redis, fakePool(persistedTokens), () => 1_000)
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      redis.deleteWorkspaceOwners()
      await coordinator.renewNow()

      expect(reasons).toEqual([])
      expect(persistedTokens).toEqual(['1', '2'])
      expect(coordinator.fencingToken({ landscapeId: 'landscape-1', versionId: 'current' })).toBe('2')
      expect(coordinator.snapshot()).toMatchObject({
        ready: true, ownedWorkspaceCount: 1, workspaceLeaseRecoveryCount: 1, lossCount: 0,
        minimumRemainingLeaseMs: 1_300,
      })
    } finally {
      await coordinator.stop()
    }
  })

  it.each(['fresh', 'frozen'] as const)('T-G1b2 uses a %s shared heartbeat after a 60-second main-loop delay', async (heartbeat) => {
    const redis = new FakeRedis()
    let now = 1_000
    const { coordinator, worker } = withPartitionWorker(redis, fakePool(), () => now)
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
      const proofReadsBeforeDelay = worker.proofReads.length
      redis.ready = false
      // The coordinator performs no work while the independent worker clock
      // advances. Frozen is the negative witness: existence alone proves none.
      for (let elapsed = 0; elapsed < 60_000; elapsed += 400) {
        now += 400
        if (heartbeat === 'fresh') worker.startedAt = now
      }
      expect(worker.proofReads).toHaveLength(proofReadsBeforeDelay)

      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' }))
        .toBe(heartbeat === 'fresh')
      expect(coordinator.snapshot()).toMatchObject(heartbeat === 'fresh' ? {
        ready: true, partitionReady: true, ownedWorkspaceCount: 1,
        minimumRemainingLeaseMs: 1_300, partitionLossCount: 0,
      } : {
        ready: false, partitionReady: false, ownedWorkspaceCount: 0,
        partitionLossCount: 0,
      })
      expect(reasons).toEqual([])
      await coordinator.reconcileNow()
      expect(coordinator.readSnapshot().partitionLossCount).toBe(heartbeat === 'fresh' ? 0 : 1)
      expect(reasons).toEqual(heartbeat === 'fresh' ? [] : ['partition-expired'])
    } finally {
      redis.ready = true
      await coordinator.stop()
    }
  })

  it('T-G1b2 expires a worker-acquired partition exactly at the 650 ms conservative deadline', async () => {
    const redis = new FakeRedis()
    let now = 1_000
    const { coordinator, worker, internals } = withPartitionWorker(redis, fakePool(), () => now, {
      partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200,
    })
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      expect(worker.acquired).toEqual([0])
      expect(internals.partitionLease).toMatchObject({ partition: 0, validUntil: 1_650, incarnation: 1 })
      expect(coordinator.snapshot()).toMatchObject({ minimumRemainingLeaseMs: 650, partitionLossCount: 0 })

      now += 649
      expect(coordinator.owns(workspace)).toBe(true)
      expect(coordinator.snapshot()).toMatchObject({ minimumRemainingLeaseMs: 1, partitionLossCount: 0 })
      now += 1
      expect(coordinator.owns(workspace)).toBe(false)
      expect(coordinator.snapshot()).toMatchObject({
        partitionReady: false, partitionIndex: null, ready: false,
        ownedWorkspaceCount: 0, partitionLossCount: 0,
      })
      expect(reasons).toEqual([])
      await coordinator.reconcileNow()
      expect(reasons).toEqual(['partition-expired'])
      expect(coordinator.owns(workspace)).toBe(false)
      expect(coordinator.snapshot().partitionLossCount).toBe(1)
      expect(reasons).toEqual(['partition-expired'])
      expect(worker.proofReads.length).toBeGreaterThan(0)
      expect(worker.proofReads.every((lease) => lease?.incarnation === 1 && lease.partition === 0)).toBe(true)
    } finally {
      await coordinator.stop()
    }
  })

  it('T-G1b2 reads the renewed partition deadline for ownership and remaining-time telemetry', async () => {
    const redis = new FakeRedis()
    let now = 1_000
    const { coordinator, worker, internals } = withPartitionWorker(redis, fakePool(), () => now, {
      partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200,
    })
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    await coordinator.start()
    try {
      expect(coordinator.snapshot().minimumRemainingLeaseMs).toBe(650)
      now = 1_400
      worker.startedAt = now
      now = 1_700
      // The acquisition's deadline (1650) has passed; the renewed proof lasts
      // until 2050. Neither a cached deadline nor Date.now-at-read can pass both.
      expect(coordinator.owns(workspace)).toBe(true)
      expect(coordinator.snapshot().minimumRemainingLeaseMs).toBe(350)
      // Computing the new deadline must not write it into the acquired lease.
      expect(internals.partitionLease?.validUntil).toBe(1_650)
      now = 2_049
      expect(coordinator.owns(workspace)).toBe(true)
      expect(coordinator.snapshot().minimumRemainingLeaseMs).toBe(1)
      now = 2_050
      expect(coordinator.owns(workspace)).toBe(false)
      expect(coordinator.snapshot().partitionLossCount).toBe(0)
      await coordinator.reconcileNow()
      expect(coordinator.snapshot().partitionLossCount).toBe(1)
    } finally {
      await coordinator.stop()
    }
  })

  it.each(['absent', 'different-incarnation'] as const)('T-G1b2 refuses a proof that is %s without waiting for lost', async (proof) => {
    const redis = new FakeRedis()
    let now = 1_000
    const { coordinator, worker, internals } = withPartitionWorker(redis, fakePool(), () => now)
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    try {
      expect(coordinator.owns(workspace)).toBe(true)
      const accepted = internals.partitionLease
      expect(accepted).not.toBeNull()
      now += 1
      if (proof === 'absent') worker.startedAt = null
      else worker.replaceProofIncarnation()
      // Keep the Redis ownerValue the same: only the shared proof identity
      // changes. Borrowing a newer incarnation for this old lease must refuse.
      expect(worker.current?.ownerValue).toBe(accepted?.ownerValue)
      expect(coordinator.owns(workspace)).toBe(false)
      expect(coordinator.snapshot()).toMatchObject({
        partitionReady: false, partitionLossCount: 0, ownedWorkspaceCount: 0,
      })
      expect(reasons).toEqual([])
      await coordinator.reconcileNow()
      expect(coordinator.readSnapshot().partitionLossCount).toBe(1)
      expect(reasons).toEqual(['partition-expired'])
    } finally {
      await coordinator.stop()
    }
  })

  it.each(['absent', 'expired'] as const)('T-G1b2 releases an acquisition returned with an %s shared proof', async (proof) => {
    const redis = new FakeRedis()
    const persistedTokens: string[] = []
    let now = 1_000
    const { coordinator, worker, internals } = withPartitionWorker(redis, fakePool(persistedTokens), () => now, {
      partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200,
    })
    const generation = coordinator.snapshot().effectiveGeneration
    expect(generation).toBe('v1.ce1461953e2b8ac2')
    const partitions = new FencedPartitionLeaseStore(redis as unknown as RedisRuntime, generation)
    let observedAcquisitions = 0
    const acquire = worker.acquire.bind(worker)
    worker.acquire = async (partition) => {
      const acquired = await acquire(partition)
      expect(acquired).not.toBeNull()
      // Read the acquired owner before invalidating its shared proof.
      expect(await partitions.resolve(partition)).toMatchObject({
        cellId: 'cell-a', partition, token: acquired?.token,
      })
      observedAcquisitions += 1
      if (proof === 'absent') worker.startedAt = null
      else now += 650
      return acquired
    }
    await coordinator.start()
    try {
      expect(observedAcquisitions).toBe(1)
      expect(worker.acquired).toEqual([0])
      expect(worker.released).toHaveLength(1)
      expect(internals.partitionLease).toBeNull()
      expect(persistedTokens).toEqual([])
      expect(coordinator.snapshot()).toMatchObject({
        partitionReady: false, partitionIndex: null, partitionAcquisitionCount: 0, ownedWorkspaceCount: 0,
      })
      expect(await partitions.resolve(0)).toBeNull()
    } finally {
      await coordinator.stop()
    }
  })

  it.each(['expired', 'different-incarnation'] as const)('T-G1b2 refuses recovery publication when the partition becomes %s during persistence', async (proof) => {
    const redis = new FakeRedis()
    const persistedTokens: string[] = []
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    let now = 1_000
    let resumePersistence!: () => void
    const persistenceBlocked = new Promise<void>((resolve) => { resumePersistence = resolve })
    let persistenceEntered = false
    const db = fakePool(persistedTokens, undefined, async (token) => {
      if (token !== '2') return
      persistenceEntered = true
      await persistenceBlocked
    })
    const { coordinator, worker, internals } = withPartitionWorker(redis, db, () => now, {
      partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200,
    })
    await coordinator.start()
    let recovery: Promise<void> | undefined
    try {
      expect(coordinator.fencingToken(workspace)).toBe('1')
      redis.deleteWorkspaceOwners()
      recovery = coordinator.renewNow()
      await expect.poll(() => persistenceEntered).toBe(true)
      // The new fence REALLY reached persistence and Redis before the fault.
      // Reading the raw local map avoids snapshot() pruning away a bad publish.
      expect(persistedTokens).toEqual(['1', '2'])
      expect(redis.workspaceOwner(workspace)).toBe('cell-a|2|v1.ce1461953e2b8ac2')
      expect([...internals.leases.values()].map((lease) => lease.token)).toEqual(['1'])
      if (proof === 'expired') now += 650
      else worker.replaceProofIncarnation()
      resumePersistence()
      await recovery

      expect([...internals.leases.values()].map((lease) => lease.token)).not.toContain('2')
      expect(redis.workspaceOwner(workspace)).toBeNull()
      expect(coordinator.snapshot()).toMatchObject({ workspaceLeaseRecoveryCount: 0, ownedWorkspaceCount: 0 })
      expect(coordinator.owns(workspace)).toBe(false)
    } finally {
      resumePersistence()
      try { await recovery } finally { await coordinator.stop() }
    }
  })

  it.each([
    ['persist', 'expired'],
    ['persist', 'different-incarnation'],
    ['listener', 'expired'],
    ['listener', 'different-incarnation'],
  ] as const)('T-G1b2 abandons admission blocked at %s when its partition becomes %s', async (stage, proof) => {
    const redis = new FakeRedis()
    const persistedTokens: string[] = []
    const workspace = { landscapeId: 'landscape-1', versionId: 'current' }
    let now = 1_000
    let resumeAdmission!: () => void
    const admissionBlocked = new Promise<void>((resolve) => { resumeAdmission = resolve })
    let stageEntered = false
    const db = fakePool(persistedTokens, undefined, async (token) => {
      if (stage !== 'persist' || token !== '1') return
      stageEntered = true
      await admissionBlocked
    })
    const query = vi.spyOn(db, 'query')
    const { coordinator, worker, internals } = withPartitionWorker(redis, db, () => now, {
      partitionLeaseTtlMs: 750, partitionRenewIntervalMs: 200,
    })
    const notifiedTokens: string[] = []
    coordinator.onOwnershipAcquired(async ({ fencingToken }) => {
      notifiedTokens.push(fencingToken)
      if (stage !== 'listener') return
      stageEntered = true
      await admissionBlocked
    })
    const starting = coordinator.start()
    try {
      await expect.poll(() => stageEntered).toBe(true)
      expect(worker.acquired).toEqual([0])
      expect(persistedTokens).toEqual(['1'])
      expect(redis.workspaceOwner(workspace)).toBe('cell-a|1|v1.ce1461953e2b8ac2')
      expect(internals.leases.size).toBe(0)
      if (proof === 'expired') now += 650
      else worker.replaceProofIncarnation()
      resumeAdmission()
      await starting

      // start() logs a snapshot, which may prune a bad publication. The Redis
      // key and acquisition counter expose that error even after such pruning.
      expect(internals.leases.size).toBe(0)
      expect(redis.workspaceOwner(workspace)).toBeNull()
      expect(notifiedTokens).toEqual(stage === 'persist' ? [] : ['1'])
      expect(coordinator.snapshot()).toMatchObject({
        acquisitionCount: 0, ownedWorkspaceCount: 0, ready: false,
      })
      expect(coordinator.owns(workspace)).toBe(false)
      const releases = query.mock.calls.filter(([text]) => (
        typeof text === 'string' && text.includes('UPDATE sync_workspace_ownership')
          && text.includes('SET released_at =')
      ))
      expect(releases.length).toBeGreaterThan(0)
      expect(releases.map(([, values]) => values)).toContainEqual(['landscape-1', 'current', 'cell-a', '1'])
    } finally {
      resumeAdmission()
      try { await starting } finally {
        try { await coordinator.stop() } finally { query.mockRestore() }
      }
    }
  })

  it.each([true, false])('T-12b resolves 100 owners with route map enabled=%s and an explicit direct-GET control', async (enabled) => {
    vi.useFakeTimers()
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(fakePool(), redis as unknown as RedisRuntime,
      config('cell-a', { routeMap: { enabled, refreshMs: 1000, maxAgeMs: 3000 } }))
    const send = vi.spyOn(redis, 'send')
    try {
      await coordinator.start()
      expect(send.mock.calls.filter(([args]) => args[0] === 'MGET')).toHaveLength(enabled ? 1 : 0)
      send.mockClear()
      for (let i = 0; i < 100; i += 1) {
        expect(await coordinator.resolveOwner({ landscapeId: 'landscape-1', versionId: 'current' }))
          .toMatchObject({ partition: 0, cellId: 'cell-a', token: '1' })
      }
      expect(send.mock.calls).toHaveLength(enabled ? 0 : 100)
      expect(send.mock.calls.every(([args]) => args[0] === 'GET')).toBe(true)
      send.mockClear()
      await vi.advanceTimersByTimeAsync(1000)
      expect(send.mock.calls.filter(([args]) => args[0] === 'MGET')).toHaveLength(enabled ? 1 : 0)
    } finally {
      await coordinator.stop()
      send.mockRestore()
      vi.useRealTimers()
    }
  })

  it('T-12b withdraws forwarding readiness when MGET fails while Redis remains ready', async () => {
    vi.useFakeTimers()
    // Fake timers replace Date, not the perf_hooks clock used by the map.
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const redis = new FakeRedis()
    const send = redis.send.bind(redis)
    let failSample = true
    redis.send = async <T>(args: string[]): Promise<T> => {
      if (failSample && args[0] === 'MGET') throw new Error('MGET failed, connection still ready')
      return send<T>(args)
    }
    const coordinator = new SyncCellOwnershipCoordinator(fakePool(), redis as unknown as RedisRuntime,
      config('standby', { partitionEligible: false }))
    try {
      await coordinator.start()
      expect(redis.ready).toBe(true)
      expect(coordinator.readSnapshot()).toMatchObject({ canServe: false,
        ownerRouteMap: { usable: false, sampleSequence: 0, refreshErrorCount: 1 } })
      failSample = false
      await vi.advanceTimersByTimeAsync(1000)
      // An empty but successful sample is distinct from no observation.
      expect(coordinator.readSnapshot()).toMatchObject({ canServe: true,
        ownerRouteMap: { usable: true, entries: 0, sampleSequence: 1 } })
      failSample = true
      await vi.advanceTimersByTimeAsync(2999)
      expect(coordinator.readSnapshot().canServe).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(redis.ready).toBe(true)
      expect(coordinator.readSnapshot()).toMatchObject({ canServe: false,
        ownerRouteMap: { usable: false, sampleAgeMs: 3000, refreshErrorCount: 4 } })
      failSample = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(coordinator.readSnapshot().canServe).toBe(true)
    } finally {
      await coordinator.stop()
      monotonic.mockRestore()
      vi.useRealTimers()
    }
  })

  it('T-12b renews an acquired partition while the first routing sample is suspended', async () => {
    vi.useFakeTimers({ now: 1000 })
    const redis = new FakeRedis()
    const entered = deferred()
    const resume = deferred()
    const send = redis.send.bind(redis)
    redis.send = async <T>(args: string[]): Promise<T> => {
      if (args[0] === 'MGET') { entered.resolve(); await resume.promise }
      return send<T>(args)
    }
    // Initial admission consumes 700 ms of the 1300 ms conservative partition
    // lifetime. Waiting another 800 ms for a routing hint must not lose it.
    const db = fakePool([], undefined, async () => { vi.setSystemTime(1700) })
    const coordinator = new SyncCellOwnershipCoordinator(db, redis as unknown as RedisRuntime, config('cell-a'))
    const starting = coordinator.start()
    try {
      await entered.promise
      expect(coordinator.readSnapshot().partitionReady).toBe(true)
      await vi.advanceTimersByTimeAsync(800)
      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
      expect(coordinator.readSnapshot()).toMatchObject({ partitionReady: true, partitionLossCount: 0,
        ownerRouteMap: { refreshInFlight: true, sampleSequence: 0 } })
      resume.resolve()
      await starting
      expect(coordinator.readSnapshot().ownerRouteMap.sampleSequence).toBe(1)
    } finally {
      resume.resolve()
      await starting
      await coordinator.stop()
      vi.useRealTimers()
    }
  })

  it('T-12b waits for a release begun after the prune before reacquiring a partition', async () => {
    vi.useFakeTimers()
    const redis = new FakeRedis()
    const { coordinator, worker, internals } = withPartitionWorker(redis, fakePool(), () => 1000)
    const state = coordinator as unknown as {
      partitionStore: FencedPartitionLeaseStore
      releaseFlights: Set<Promise<void>>
      acquirePartitionIfMissing: (countConflict?: boolean) => Promise<void>
      handleWorkerPartitionLoss: (lease: WorkerPartitionLease, reason: string) => void
    }
    const topologyEntered = deferred()
    const resumeTopology = deferred()
    const releaseEntered = deferred()
    const resumeRelease = deferred()
    const acquisitionAttempted = deferred()
    let reconcile: Promise<void> | undefined
    let renewal: Promise<void> | undefined
    await coordinator.start()
    const verify = state.partitionStore.verifyTopology.bind(state.partitionStore)
    const verifySpy = vi.spyOn(state.partitionStore, 'verifyTopology').mockImplementationOnce(async count => {
      topologyEntered.resolve()
      await resumeTopology.promise
      return verify(count)
    })
    const acquire = state.acquirePartitionIfMissing.bind(state)
    const attemptSpy = vi.spyOn(state, 'acquirePartitionIfMissing').mockImplementationOnce(async count => {
      await acquire(count)
      acquisitionAttempted.resolve()
    })
    const workerAcquire = vi.spyOn(worker, 'acquire')
    const send = redis.send.bind(redis)
    const sendSpy = vi.spyOn(redis, 'send').mockImplementation(async args => {
      if (args[0] === 'EVAL' && args[1].includes("redis.call('DEL'") && args[3].includes(':sync-cell:owner:')) {
        releaseEntered.resolve()
        await resumeRelease.promise
      }
      return send(args)
    })
    try {
      const previous = internals.partitionLease!
      expect(previous).not.toBeNull()
      reconcile = coordinator.reconcileNow()
      await topologyEntered.promise // The prune has finished; the pass awaits Redis.
      await worker.release(previous)
      state.handleWorkerPartitionLoss(previous, 'lease-lost')
      renewal = coordinator.renewNow()
      await releaseEntered.promise
      expect(internals.leases.size).toBe(0)
      expect(state.releaseFlights.size).toBe(1)
      resumeTopology.resolve()
      await acquisitionAttempted.promise
      expect(workerAcquire).not.toHaveBeenCalled()
      expect(coordinator.readSnapshot().partitionReady).toBe(false)
      resumeRelease.resolve()
      await Promise.all([reconcile, renewal])
      expect(workerAcquire).toHaveBeenCalledTimes(1)
      expect(coordinator.owns({ landscapeId: 'landscape-1', versionId: 'current' })).toBe(true)
      expect(coordinator.fencingToken({ landscapeId: 'landscape-1', versionId: 'current' })).toBe('2')
      expect(state.releaseFlights.size).toBe(0)
    } finally {
      resumeTopology.resolve()
      resumeRelease.resolve()
      await Promise.allSettled([reconcile, renewal])
      await coordinator.stop()
      verifySpy.mockRestore()
      attemptSpy.mockRestore()
      workerAcquire.mockRestore()
      sendSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('T-12b joins a creation admission and its exact-token cleanup before stop returns', async () => {
    vi.useFakeTimers()
    const entered = deferred()
    const resume = deferred()
    const redis = new FakeRedis()
    const db = fakePool([], [], async () => { entered.resolve(); await resume.promise })
    const query = vi.spyOn(db, 'query')
    const coordinator = new SyncCellOwnershipCoordinator(db, redis as unknown as RedisRuntime, config('cell-a'))
    let stopped: Promise<void> | undefined
    try {
      await coordinator.start()
      const workspace = { landscapeId: 'new-landscape', versionId: 'new-version' }
      notifyWorkspaceCreated({ ...workspace, rootUrl: 'unused-by-ownership' })
      await entered.promise
      expect(redis.workspaceOwner(workspace)).not.toBeNull()
      let stopReturned = false
      stopped = coordinator.stop().then(() => { stopReturned = true })
      await vi.advanceTimersByTimeAsync(1)
      expect(stopReturned).toBe(false)
      expect(coordinator.owns(workspace)).toBe(false)
      resume.resolve()
      await stopped
      expect(redis.workspaceOwner(workspace)).toBeNull()
      const releases = query.mock.calls.filter(([text]) => typeof text === 'string'
        && text.includes('UPDATE sync_workspace_ownership') && text.includes('SET released_at ='))
      expect(releases.map(([, values]) => values)).toContainEqual(['new-landscape', 'new-version', 'cell-a', '1'])
      expect(coordinator.readSnapshot().ownedWorkspaceCount).toBe(0)
    } finally {
      resume.resolve()
      await stopped
      await coordinator.stop()
      query.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fails closed and drains ownership immediately when critical Redis becomes unavailable', async () => {
    const redis = new FakeRedis()
    const coordinator = new SyncCellOwnershipCoordinator(
      fakePool(), redis as unknown as RedisRuntime, config('cell-a'),
    )
    const reasons: string[] = []
    coordinator.onOwnershipLost(({ reason }) => reasons.push(reason))
    await coordinator.start()
    redis.ready = false

    await coordinator.renewNow()

    expect(reasons).toEqual(['partition-unavailable'])
    expect(coordinator.snapshot()).toMatchObject({
      ready: false,
      partitionReady: false,
      ownedWorkspaceCount: 0,
      lossCount: 1,
    })
    await coordinator.stop()
  })
})

describe('a failed partition worker client is replaced', () => {
  it('replaces it at the next probe once it is old enough, and acquires through the new one', async () => {
    let clock = 1_000
    const redis = new FakeRedis()
    const db = fakePool([], [])
    const { coordinator, worker } = withPartitionWorker(redis, db, () => clock)
    const failure = new Error('worker-unresponsive')
    const failing = {
      failed: failure,
      acquire: vi.fn(async () => { throw failure }),
      release: vi.fn(async () => false),
      lastRenewStartedAt: () => null,
      stop: vi.fn(async () => { throw failure }),
    }
    const seams = coordinator as unknown as {
      partitionWorker: unknown
      partitionWorkerStartedAt: number
      createPartitionWorker: () => unknown
    }
    seams.partitionWorker = failing
    seams.partitionWorkerStartedAt = clock
    const created = vi.fn(() => worker)
    seams.createPartitionWorker = created
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await coordinator.start()
      // A client that failed within its first five seconds is not replaced:
      // a thread that dies at once must not become a spawn loop.
      expect(created).not.toHaveBeenCalled()
      expect(seams.partitionWorker).toBe(failing)
      expect(coordinator.snapshot()).toMatchObject({ ready: false, partitionIndex: null })

      clock += 5_000
      await coordinator.reconcileNow()
      expect(created).toHaveBeenCalledTimes(1)
      expect(seams.partitionWorker).toBe(worker)
      expect(failing.stop).toHaveBeenCalledTimes(1)
      expect(worker.acquired).toEqual([0])
      expect(coordinator.snapshot()).toMatchObject({ ready: true, partitionIndex: 0 })
      expect(warn.mock.calls.some(([value]) => String(value).includes('"event":"sync.cell.partition_worker_replaced"'))).toBe(true)

      await coordinator.reconcileNow()
      expect(created).toHaveBeenCalledTimes(1)
    } finally {
      await coordinator.stop()
      warn.mockRestore()
    }
  })
})
