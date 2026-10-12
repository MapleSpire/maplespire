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
import pg, { type Pool } from 'pg'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import {
  ensureSyncCellOwnershipSchema, FencedPartitionLeaseStore, SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig, type SyncCellOwnershipConfig,
} from './ownership.js'
import { ensureSyncTopologyContractSchema, publishSyncTopologyContract } from './topologyMirror.js'

const DB = process.env.TEST_DATABASE_URL, REDIS = process.env.TEST_REDIS_URL
const CONTRACT = 'b3i-qa-v1.ce1461953e2b8ac2|1'
const OTHER = 'b3i-qa-v1.2222222222222222|1'
const WORKSPACE = { landscapeId: 'mirror-land', versionId: 'mirror-active' }
const OLD_DATE = '2001-02-03T04:05:06.000Z'

/** Real PG and Redis: a fake answering an absent mirror forever cannot prove
 * either the compare-before-write gate or the created/matched distinction. */
describe.skipIf(!DB || !REDIS)('B3i durable topology mirror', () => {
  let db: IsolatedSchemaDb
  const client = createClient({ url: REDIS })
  const coordinators: SyncCellOwnershipCoordinator[] = []
  let prefix: string
  let failTopology = false
  const commands: string[][] = []

  const config = (cellId = 'mirror-cell'): SyncCellOwnershipConfig => ({
    ...syncCellOwnershipConfig({
      SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId,
      SYNC_CELL_TOPOLOGY_GENERATION: 'b3i-qa-v1',
    }),
    partitionWorker: false,
    advertiseUrl: null,
    partitionCount: 1,
    leaseTtlMs: 60_000, renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000, partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000, partitionProbeIntervalMs: 600_000,
    reconcileIntervalMs: 600_000, telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
  })
  const runtime = (): RedisRuntime => ({
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]): Promise<T> {
      commands.push([...args])
      if (failTopology && args[0] === 'EVAL' && args[3] === `${prefix}:sync-cell:topology`) {
        return Promise.reject(new Error('b3i injected Redis topology outage'))
      }
      return client.sendCommand(args) as Promise<T>
    },
  } as unknown as RedisRuntime)
  function coordinator(cellId = 'mirror-cell', pool = db.pool): SyncCellOwnershipCoordinator {
    const settings = config(cellId)
    expect(settings.effectiveGeneration).toBe('b3i-qa-v1.ce1461953e2b8ac2')
    const value = new SyncCellOwnershipCoordinator(pool, runtime(), settings)
    coordinators.push(value)
    return value
  }
  const topology = () => client.get(`${prefix}:sync-cell:topology`)
  const mirror = async () => (await db.pool.query<{ value: string; written_by: string; written_at: string }>(
    'SELECT value, written_by, written_at::text AS written_at FROM sync_topology_contract',
  )).rows
  async function seedMirror(value = CONTRACT): Promise<void> {
    await db.pool.query('DELETE FROM sync_topology_contract')
    await db.pool.query(
      'INSERT INTO sync_topology_contract (value, written_by, written_at) VALUES ($1, $2, $3)',
      [value, 'writer-from-the-dump', OLD_DATE],
    )
    expect(await mirror()).toHaveLength(1)
    expect((await mirror())[0]).toMatchObject({ value, written_by: 'writer-from-the-dump' })
  }
  async function seedClaims(released: boolean): Promise<void> {
    for (const versionId of ['mirror-active', 'mirror-retired-1', 'mirror-retired-2']) {
      await db.pool.query(`INSERT INTO sync_workspace_ownership
        (landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at)
        VALUES ($1, $2, 'dump-cell', 42, NOW() - INTERVAL '1 hour', $3)`,
      [WORKSPACE.landscapeId, versionId, released ? OLD_DATE : null])
    }
    expect((await db.pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE released_at IS NULL)::int AS live FROM sync_workspace_ownership`)).rows)
      .toEqual([{ total: 3, live: released ? 0 : 3 }])
  }
  function warningCapture() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    return {
      incidents: () => warn.mock.calls.flatMap(args => {
        try { const item = JSON.parse(args.map(String).join(' ')); return item.event === 'sync.cell.topology_created_with_durable_rows' ? [item] : [] }
        catch { return [] }
      }),
      restore: () => warn.mockRestore(),
    }
  }
  const assertNoAdmission = (c: SyncCellOwnershipCoordinator) => {
    expect(c.snapshot()).toMatchObject({ topologyConfirmed: false, partitionReady: false,
      partitionAcquisitionCount: 0, acquisitionCount: 0, ownedWorkspaceCount: 0 })
    expect(c.owns(WORKSPACE)).toBe(false)
  }
  const isRead = (text: string) => text.includes('SELECT value FROM sync_topology_contract')
  const isPublication = (text: string) => text.includes('INSERT INTO sync_topology_contract')
  function interceptQueries(beforeQuery: (text: string) => Promise<void>): Pool {
    return {
      async query(text: string, values?: unknown[]) {
        await beforeQuery(text)
        return db.pool.query(text, values)
      },
    } as unknown as Pool
  }
  function blockedQuery(matches: (text: string) => boolean) {
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const observed = new Promise<void>(resolve => { entered = resolve })
    let calls = 0
    const pool = interceptQueries(async text => {
      if (!matches(text)) return
      calls++
      if (calls === 1) { entered(); await held }
    })
    return {
      pool, release, calls: () => calls,
      wait: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([observed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('B3i query barrier was never reached')), 5_000)
          })])
        } finally { if (timer !== undefined) clearTimeout(timer) }
      },
    }
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(DB!, 'sync_cell_topology_mirror')
    await client.connect()
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id),
        label TEXT, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      INSERT INTO landscapes VALUES ('mirror-land', 'Mirror');
      INSERT INTO versions VALUES
        ('mirror-active', 'mirror-land', 'Active', 'automerge:mirror-active', 'active'),
        ('mirror-retired-1', 'mirror-land', 'Old 1', 'automerge:mirror-retired-1', 'retired'),
        ('mirror-retired-2', 'mirror-land', 'Old 2', 'automerge:mirror-retired-2', 'retired');`)
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)
  beforeEach(async () => {
    prefix = `test:b3i:${randomBytes(8).toString('hex')}`
    failTopology = false
    commands.length = 0
    await db.pool.query('DELETE FROM sync_topology_contract')
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    expect(await mirror()).toEqual([])
    expect(await topology()).toBeNull()
  })
  afterEach(async () => {
    failTopology = false
    for (const c of coordinators.splice(0)) await c.stop()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length) await client.sendCommand(['DEL', ...keys])
    vi.restoreAllMocks()
  })
  afterAll(async () => { await client.close(); await db?.teardown() }, 120_000)

  it('the 0003 migration creates the singleton table and rerunning preserves its row', async () => {
    const { schemaMigrations } = await import('../db/schemaMigrations.js')
    const { runMigrations } = await import('../db/migrations.js')
    const entries = schemaMigrations(db.pool).filter(m => m.id.startsWith('0003-'))
    expect(entries).toHaveLength(1)
    await db.pool.query('DROP TABLE sync_topology_contract')
    try {
      const first = await runMigrations(db.pool, entries, { log: () => {} })
      expect(first.applied).toEqual([entries[0]!.id])
      expect(await mirror()).toEqual([])
      await seedMirror()
      const before = await mirror()
      await expect(db.pool.query('INSERT INTO sync_topology_contract (value, written_by) VALUES ($1, $2)', [OTHER, 'second-row']))
        .rejects.toMatchObject({ code: '23505' })
      await expect(db.pool.query('INSERT INTO sync_topology_contract (singleton, value, written_by) VALUES (FALSE, $1, $2)', [OTHER, 'false-singleton']))
        .rejects.toMatchObject({ code: '23514' })
      expect(await mirror()).toEqual(before)
      const again = await runMigrations(db.pool, entries, { log: () => {} })
      expect(again.alreadyApplied).toEqual([entries[0]!.id])
      expect(await mirror()).toEqual(before)
    } finally {
      await ensureSyncTopologyContractSchema(db.pool)
    }
  })

  it.each([false, true])('an absent mirror preserves genuine Redis created and B4-7c with released=%s', async released => {
    await seedClaims(released)
    const warnings = warningCapture()
    try {
      const c = coordinator()
      await c.start()
      expect(c.snapshot()).toMatchObject({ topologyConfirmed: true, topologyKeyCreatedAtBoot: true, partitionReady: true })
      expect(c.owns(WORKSPACE)).toBe(true)
      expect(c.snapshot().acquisitionCount).toBe(1)
      expect(await topology()).toBe(CONTRACT)
      expect(await mirror()).toHaveLength(1)
      expect((await mirror())[0]).toMatchObject({ value: CONTRACT, written_by: 'mirror-cell' })
      expect(warnings.incidents()).toHaveLength(1)
      expect(warnings.incidents()[0]).toMatchObject({ topologyGeneration: 'b3i-qa-v1.ce1461953e2b8ac2', ownershipRows: 3, unreleasedRows: released ? 0 : 3 })
      expect(commands.some(args => args[0] === 'EVAL' && args[3] === `${prefix}:sync-cell:topology`)).toBe(true)
      expect(commands.some(args => args[0] === 'EVAL' && args[1]?.includes("redis.call('INCR'"))).toBe(true)
    } finally { warnings.restore() }
  })

  it('an equal durable mirror allows a wiped Redis prefix and exceeds the durable workspace token', async () => {
    await seedClaims(true)
    const first = coordinator('first-creator')
    await first.start()
    expect(await topology()).toBe(CONTRACT)
    expect(first.owns(WORKSPACE)).toBe(true)
    await first.stop()
    const before = await mirror()
    expect(before[0]?.written_by).toBe('first-creator')
    const claimsBefore = (await db.pool.query<{ version_id: string; fencing_token: string; released: boolean }>(
      'SELECT version_id, fencing_token::text, released_at IS NOT NULL AS released FROM sync_workspace_ownership ORDER BY version_id',
    )).rows
    const activeBefore = claimsBefore.find(row => row.version_id === WORKSPACE.versionId)
    expect(claimsBefore).toHaveLength(3)
    expect(claimsBefore.every(row => row.released)).toBe(true)
    expect(activeBefore).toBeDefined()
    expect(BigInt(activeBefore!.fencing_token)).toBeGreaterThan(42n)
    const prefixKeys = async () => {
      const keys: string[] = []
      for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
        if (Array.isArray(batch)) keys.push(...batch)
        else keys.push(batch)
      }
      return [...new Set(keys)].sort()
    }
    const beforeKeys = await prefixKeys()
    expect(beforeKeys).toContain(`${prefix}:sync-cell:topology`)
    const workspaceSequences = beforeKeys.filter(key => key.startsWith(`${prefix}:sync-cell:fence:`))
    const partitionSequences = beforeKeys.filter(key => key.startsWith(`${prefix}:sync-cell:partition:`) && key.endsWith(':fence'))
    expect(workspaceSequences).toHaveLength(1)
    expect(partitionSequences).toEqual([`${prefix}:sync-cell:partition:b3i-qa-v1.ce1461953e2b8ac2:0:fence`])
    expect(await client.get(workspaceSequences[0]!)).toBe(activeBefore!.fencing_token)
    expect(BigInt((await client.get(partitionSequences[0]!))!)).toBeGreaterThan(0n)
    // Model a rebuilt Redis for this isolated test prefix, including its lost
    // sequences. Removing the topology key alone does not exercise recovery of
    // a durable fence when the live monotonic counter has disappeared.
    expect(await client.sendCommand(['DEL', ...beforeKeys])).toBe(beforeKeys.length)
    expect(await prefixKeys()).toEqual([])
    expect(await topology()).toBeNull()
    for (const key of [...workspaceSequences, ...partitionSequences]) expect(await client.get(key)).toBeNull()
    expect(await mirror()).toEqual(before)
    expect((await db.pool.query(
      'SELECT version_id, fencing_token::text, released_at IS NOT NULL AS released FROM sync_workspace_ownership ORDER BY version_id',
    )).rows).toEqual(claimsBefore)
    const warnings = warningCapture()
    try {
      const next = coordinator('second-creator')
      await next.start()
      expect(next.snapshot().topologyKeyCreatedAtBoot).toBe(true)
      expect(next.owns(WORKSPACE)).toBe(true)
      expect(await topology()).toBe(CONTRACT)
      const activeAfter = (await db.pool.query<{ fencing_token: string; cell_id: string; released: boolean }>(
        'SELECT fencing_token::text, cell_id, released_at IS NOT NULL AS released FROM sync_workspace_ownership WHERE landscape_id = $1 AND version_id = $2',
        [WORKSPACE.landscapeId, WORKSPACE.versionId],
      )).rows
      expect(activeAfter).toHaveLength(1)
      expect(activeAfter[0]).toMatchObject({ cell_id: 'second-creator', released: false })
      expect(BigInt(activeAfter[0]!.fencing_token)).toBeGreaterThan(BigInt(activeBefore!.fencing_token))
      expect(await client.get(workspaceSequences[0]!)).toBe(activeAfter[0]!.fencing_token)
      expect(warnings.incidents()).toHaveLength(1)
      expect(warnings.incidents()[0]).toMatchObject({ ownershipRows: 3, unreleasedRows: 0 })
      const after = await mirror()
      expect(after[0]).toMatchObject({ value: CONTRACT, written_by: 'second-creator' })
      expect(new Date(after[0]!.written_at).getTime()).toBeGreaterThanOrEqual(new Date(before[0]!.written_at).getTime())
    } finally { warnings.restore() }
  })

  it.each([
    ['different fingerprint', OTHER],
    ['different partition count', 'b3i-qa-v1.ce1461953e2b8ac2|2'],
    ['malformed value', 'malformed-durable-contract'],
  ])('a mirror with %s refuses the actual boot before any Redis command or acquisition', async (_reason, value) => {
    await seedMirror(value)
    const before = await mirror()
    const c = coordinator()
    const error = await c.start().then(() => null, (reason: unknown) => reason)
    expect(error).toMatchObject({ name: 'SyncCellTopologyMismatchError', code: 'sync_cell_topology_mismatch' })
    const message = String((error as Error).message)
    for (const text of [CONTRACT, value, 'B3d1', 'maplespire-sponsor-kit/docs/operations/sync-cell-ownership.md']) expect(message).toContain(text)
    assertNoAdmission(c)
    expect(commands).toEqual([])
    expect(await topology()).toBeNull()
    expect(await mirror()).toEqual(before)
  })

  it.each([false, true])('matched never creates or refreshes a mirror (present=%s)', async present => {
    if (present) await seedMirror()
    const before = await mirror()
    const store = new FencedPartitionLeaseStore(runtime(), 'b3i-qa-v1.ce1461953e2b8ac2')
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: true })
    const warnings = warningCapture()
    try {
      const c = coordinator('must-not-be-written')
      await c.start()
      expect(c.snapshot().topologyKeyCreatedAtBoot).toBe(false)
      expect(c.owns(WORKSPACE)).toBe(true)
      expect(await mirror()).toEqual(before)
      expect(warnings.incidents()).toEqual([])
    } finally { warnings.restore() }
  })

  it('a delayed publisher cannot overwrite a different contract already committed', async () => {
    expect(await publishSyncTopologyContract(db.pool, { value: OTHER, writtenBy: 'winner' })).toBe(true)
    const before = await mirror()
    expect(before[0]).toMatchObject({ value: OTHER, written_by: 'winner' })
    expect(await publishSyncTopologyContract(db.pool, { value: CONTRACT, writtenBy: 'late-creator' })).toBe(false)
    expect(await mirror()).toEqual(before)
  })

  it('the real boot refuses a different mirror committed while its creator publication is held', async () => {
    const winner = new pg.Client({ connectionString: DB!, options: `-c search_path=${db.schema}` })
    try {
      await winner.connect()
      const gate = blockedQuery(isPublication)
      const c = coordinator('held-creator', gate.pool)
      const startup = c.start().then(() => null, (error: unknown) => error)
      try {
        await gate.wait()
        expect(gate.calls()).toBe(1)
        // The coordinator already read an absent mirror and really created
        // Redis. The competing commit uses a separate PostgreSQL connection;
        // it is not a fake answer substituted for the conditional UPSERT.
        expect(await topology()).toBe(CONTRACT)
        expect(await mirror()).toEqual([])
        assertNoAdmission(c)
        expect(commands).toHaveLength(1)
        expect(commands[0]?.[0]).toBe('EVAL')
        expect(commands[0]?.[3]).toBe(`${prefix}:sync-cell:topology`)
        expect((await winner.query(
          'INSERT INTO sync_topology_contract (value, written_by, written_at) VALUES ($1, $2, $3)',
          [OTHER, 'independent-winner', OLD_DATE],
        )).rowCount).toBe(1)
        const before = await mirror()
        expect(before[0]).toMatchObject({ value: OTHER, written_by: 'independent-winner' })
        gate.release()
        const error = await startup
        expect(error).toMatchObject({ name: 'SyncCellTopologyMismatchError', code: 'sync_cell_topology_mismatch' })
        for (const text of [CONTRACT, OTHER, 'B3d1', 'maplespire-sponsor-kit/docs/operations/sync-cell-ownership.md']) {
          expect(String((error as Error).message)).toContain(text)
        }
        assertNoAdmission(c)
        expect(await mirror()).toEqual(before)
        expect(await topology()).toBe(CONTRACT)
        expect(commands).toHaveLength(1)
        expect(gate.calls()).toBe(1)
      } finally { gate.release(); await startup }
    } finally { await winner.end() }
  })

  it('Redis recovery rechecks the mirror instead of admitting through the degraded retry', async () => {
    failTopology = true
    const c = coordinator()
    await c.start()
    assertNoAdmission(c)
    expect(await topology()).toBeNull()
    await seedMirror(OTHER)
    const before = await mirror()
    failTopology = false
    commands.length = 0
    await expect(c.reconcileNow()).rejects.toMatchObject({ code: 'sync_cell_topology_mismatch' })
    assertNoAdmission(c)
    expect(commands).toEqual([])
    expect(await topology()).toBeNull()
    expect(await mirror()).toEqual(before)
    // Same live coordinator and reachable Redis: the failed half must not be
    // explained by a dead fixture. Restore the allowed mirror deliberately.
    await seedMirror(CONTRACT)
    await c.reconcileNow()
    expect(c.owns(WORKSPACE)).toBe(true)
    expect(await topology()).toBe(CONTRACT)
    expect((await mirror())[0]?.written_by).toBe('mirror-cell')
  })

  it('a PostgreSQL read failure degrades without Redis writes, then the same cell recovers', async () => {
    let fail = true, reads = 0
    const pool = interceptQueries(async text => {
      if (isRead(text)) { reads++; if (fail) throw new Error('B3i injected PostgreSQL read failure') }
    })
    const c = coordinator('read-recovery', pool)
    await c.start()
    expect(reads).toBeGreaterThan(0)
    assertNoAdmission(c)
    expect(commands).toEqual([])
    expect(await mirror()).toEqual([])
    expect(await topology()).toBeNull()
    fail = false
    await c.reconcileNow()
    expect(c.owns(WORKSPACE)).toBe(true)
    expect((await mirror())[0]).toMatchObject({ value: CONTRACT, written_by: 'read-recovery' })
  })

  it('stop during the actual mirror read forbids a late Redis creation', async () => {
    const gate = blockedQuery(isRead)
    const c = coordinator('stopped-read', gate.pool)
    const startup = c.start().then(() => null, (error: unknown) => error)
    let stopping: Promise<void> | undefined, secondStop: Promise<void> | undefined
    try {
      await gate.wait()
      expect(gate.calls()).toBe(1)
      let stopped = false, stoppedAgain = false
      stopping = c.stop().then(() => { stopped = true })
      secondStop = c.stop().then(() => { stoppedAgain = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect([stopped, stoppedAgain]).toEqual([false, false])
      gate.release()
      expect(await startup).toBeNull()
      await Promise.all([stopping, secondStop])
      await c.reconcileNow()
      assertNoAdmission(c)
      expect(commands).toEqual([])
      expect(await topology()).toBeNull()
      expect(await mirror()).toEqual([])
    } finally { gate.release(); await Promise.all([startup, stopping, secondStop]) }
  })

  it('a failed creator publication stays unconfirmed and pays its debt on matched retry', async () => {
    let fail = true, publications = 0
    const pool = interceptQueries(async text => {
      if (isPublication(text)) { publications++; if (fail) throw new Error('B3i injected PostgreSQL publication failure') }
    })
    const c = coordinator('publication-recovery', pool)
    await c.start()
    expect(publications).toBeGreaterThan(0)
    expect(await topology()).toBe(CONTRACT)
    expect(await mirror()).toEqual([])
    assertNoAdmission(c)
    fail = false
    await c.reconcileNow()
    expect(c.owns(WORKSPACE)).toBe(true)
    expect(c.snapshot().topologyKeyCreatedAtBoot).toBe(true)
    expect((await mirror())[0]).toMatchObject({ value: CONTRACT, written_by: 'publication-recovery' })
  })

  it('stop during publication never confirms or acquires after the pending write joins', async () => {
    const gate = blockedQuery(isPublication)
    const c = coordinator('stopped-publication', gate.pool)
    const startup = c.start().then(() => null, (error: unknown) => error)
    let stopping: Promise<void> | undefined, secondStop: Promise<void> | undefined
    try {
      await gate.wait()
      expect(gate.calls()).toBe(1)
      expect(await topology()).toBe(CONTRACT)
      expect(await mirror()).toEqual([])
      assertNoAdmission(c)
      const beforeStop = commands.length
      let stopped = false, stoppedAgain = false
      stopping = c.stop().then(() => { stopped = true })
      secondStop = c.stop().then(() => { stoppedAgain = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect([stopped, stoppedAgain]).toEqual([false, false])
      gate.release()
      expect(await startup).toBeNull()
      await Promise.all([stopping, secondStop])
      await c.reconcileNow()
      assertNoAdmission(c)
      expect(commands).toHaveLength(beforeStop)
      // Joining an already-dispatched PG write may persist the witness. It must
      // not hand responsibility to a stopped coordinator or a late Worker.
      expect((await mirror())[0]).toMatchObject({ value: CONTRACT, written_by: 'stopped-publication' })
      expect(gate.calls()).toBe(1)
    } finally { gate.release(); await Promise.all([startup, stopping, secondStop]) }
  })
})
