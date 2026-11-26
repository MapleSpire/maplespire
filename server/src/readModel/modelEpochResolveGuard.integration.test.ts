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

import { Repo } from '@automerge/automerge-repo'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { modelEpochConfig } from './modelEpochConfig.js'
import type { RollPorts } from './modelEpochRoll.js'
import { fencedOn } from './modelEpochStep.js'
import {
  EPOCH_RESOLVE_CLI_HELP,
  EPOCH_RESOLVE_DONE_PREFIX,
  EPOCH_RESOLVE_FENCE_PREFIX,
  EpochResolveInProgressError,
  applyEpochResolveRepointing,
  claimEpochResolveWriteFence,
  epochResolveAcquisitionGuard,
  epochResolveOnlineHolders,
  parseEpochResolveArgs,
  type EpochResolveStaleOverride,
} from './modelEpochResolveGuard.js'

/**
 * G4-16f — `epoch:resolve-repointing` refuses
 * while anything can serve the workspace, WHATEVER
 * `EPOCH_RESOLVE_OFFLINE_CONFIRMED` says, and writes under a fence of its
 * own, never the live projector's. Isolated schema, TEST_DATABASE_URL.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS = { landscapeId: 'ls-resolve', versionId: 'v-resolve' }
const PROJECTOR = '6f1c3e2a-0b7d-4c55-9e1a-3d2b4c5a6e7f'
let db: IsolatedSchemaDb

const fenceOf = async () => (await db.pool.query<{ write_fence: string | null }>(
  'SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])).rows[0]?.write_fence
const lease = (released: boolean, expiredAgo = '10 minutes') => db.pool.query(
  `INSERT INTO sync_workspace_ownership (landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at)
   VALUES ($1, $2, 'cell-a', 7, now() - $3::interval, ${released ? 'now()' : 'NULL'})`, [WS.landscapeId, WS.versionId, expiredAgo])
const projector = (attached: boolean, lastProjected: string | null) => db.pool.query(
  `UPDATE read_model_projection_state
      SET projector_attached = $3, projector_instance_id = $4, last_projected_at = ${lastProjected ?? 'NULL'}
    WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId, attached, attached ? PROJECTOR : null])

async function claim() {
  const client = await db.pool.connect()
  try { return await claimEpochResolveWriteFence(client, WS) } finally { client.release() }
}

suite('epoch:resolve-repointing — the offline guard and its own write fence', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_resolve_guard')
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await db.pool.query(`CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL, root_url TEXT NOT NULL)`)
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE sync_workspace_ownership (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, cell_id TEXT NOT NULL, fencing_token BIGINT NOT NULL,
      lease_observed_expires_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id))`)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    await db.pool.query('DELETE FROM read_model_projection_state')
    // The last projector that served the workspace holds the fence.
    await db.pool.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence, projector_attached, projector_instance_id)
       VALUES ($1, $2, $3, false, NULL)`, [WS.landscapeId, WS.versionId, PROJECTOR])
  })

  it('REFUSED on an unreleased ownership lease — even one whose observed expiry is past — and nothing is written', async () => {
    await lease(false)
    expect(await epochResolveOnlineHolders(db.pool, WS)).toEqual([{ kind: 'ownership_lease', cellId: 'cell-a', fencingToken: '7', stale: false }])
    expect(await claim()).toMatchObject({ claimed: false, reason: 'online', holders: [{ kind: 'ownership_lease' }] })
    expect(await fenceOf()).toBe(PROJECTOR)
  })

  it('REFUSED on a live projector: attached, or detached but seen projecting within the window', async () => {
    await projector(true, `now() - interval '2 hours'`)
    expect(await claim()).toMatchObject({ claimed: false, reason: 'online', holders: [{ kind: 'projector', attached: true, instanceId: PROJECTOR }] })
    await projector(false, `now() - interval '1 minute'`)
    expect(await claim()).toMatchObject({ claimed: false, reason: 'online', holders: [{ kind: 'projector', attached: false }] })
    expect(await fenceOf()).toBe(PROJECTOR)
  })

  it('offline (lease released, projector detached and quiet): the CLI claims a fence of ITS OWN — the old projector id no longer passes', async () => {
    await lease(true)
    await projector(false, `now() - interval '2 hours'`)
    expect(await epochResolveOnlineHolders(db.pool, WS)).toEqual([])
    const result = await claim()
    expect(result.claimed).toBe(true)
    const fence = (result as { fence: string }).fence
    expect(fence.startsWith(EPOCH_RESOLVE_FENCE_PREFIX)).toBe(true)
    expect(await fenceOf()).toBe(fence)
    // Unique per run.
    expect((await claim() as { fence: string }).fence).not.toBe(fence)
    const current = (await fenceOf())!
    const client = await db.pool.connect()
    try {
      await expect(fencedOn(client, WS, PROJECTOR)(async () => 'written')).rejects.toThrow(/write fence lost/)
      expect(await fencedOn(client, WS, current)(async () => 'written')).toBe('written')
    } finally { client.release() }
  })

  it('the APPLY path: refused online without running the door; offline, the door runs its row transactions on the CLI\'s fence', async () => {
    const repo = new Repo({ network: [] })
    const calls: string[] = []
    const deps = {
      db: db.pool, connect: () => db.pool.connect(), key: WS, repo, rootUrl: 'automerge:root', config: modelEpochConfig({}),
      withLifecycleLock: async <T>(critical: () => Promise<T>) => ({ granted: true as const, value: await critical() }),
      // The door: one fenced row read, as every step of it does first — and,
      // while it runs, a cell's acquisition is REFUSED.
      resolve: async (ports: RollPorts) => {
        calls.push('resolve')
        await ports.rows.published()
        await expect(epochResolveAcquisitionGuard(db.pool)({ workspace: WS })).rejects.toThrow(EpochResolveInProgressError)
        return { outcome: 'nothing_stuck' as const }
      },
    }
    try {
      await lease(false)
      expect(await applyEpochResolveRepointing(deps, 'adopt-root')).toMatchObject({ outcome: 'refused_online' })
      await db.pool.query('DELETE FROM sync_workspace_ownership')
      await projector(true, null)
      expect(await applyEpochResolveRepointing(deps, 'repoint')).toMatchObject({ outcome: 'refused_online' })
      expect(calls).toEqual([])
      expect(await fenceOf()).toBe(PROJECTOR)
      await projector(false, null)
      expect(await applyEpochResolveRepointing(deps, 'adopt-root')).toEqual({ outcome: 'nothing_stuck' })
      expect(calls).toEqual(['resolve'])
      // The run is over: the fence moved to a `done` value, and cells acquire again.
      expect((await fenceOf())!.startsWith(EPOCH_RESOLVE_DONE_PREFIX)).toBe(true)
      await epochResolveAcquisitionGuard(db.pool)({ workspace: WS })
      // A door that THROWS still releases the fence (its writes are flushed).
      const throwing = { ...deps, resolve: async () => { throw new Error('door failed') } }
      await expect(applyEpochResolveRepointing(throwing, 'repoint')).rejects.toThrow('door failed')
      expect((await fenceOf())!.startsWith(EPOCH_RESOLVE_DONE_PREFIX)).toBe(true)
    } finally { await repo.shutdown() }
  })

  it('the claim LOCKS the ownership rows — a cell\'s lease upsert waits for it — and the acquisition guard waits on the state row', async () => {
    await lease(true) // a released row: the claim passes, and holds it
    const real = await db.pool.connect()
    let pause!: () => void
    const paused = new Promise<void>((resolve) => { pause = resolve })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const pausing = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await real.query(sql, params)
        // Right after the claim READ the ownership rows (inside its transaction).
        if (sql.includes('FROM sync_workspace_ownership')) { pause(); await gate }
        return result
      },
    }
    const contender = await db.pool.connect()
    try {
      const claiming = claimEpochResolveWriteFence(pausing as never, WS)
      await paused
      await contender.query(`SET lock_timeout = '300ms'`)
      // A cell persisting its lease (released_at back to NULL) waits on the claim's row lock…
      await expect(contender.query(
        `UPDATE sync_workspace_ownership SET released_at = NULL, fencing_token = 8 WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId])).rejects.toMatchObject({ code: '55P03' })
      // …and its acquisition listener waits on the claim's state-row lock.
      await expect(epochResolveAcquisitionGuard(contender)({ workspace: WS })).rejects.toMatchObject({ code: '55P03' })
      resume()
      expect(await claiming).toMatchObject({ claimed: true })
      // After the claim: the lease may be persisted, but acquisition is refused.
      await contender.query(`SET lock_timeout = 0`)
      await expect(epochResolveAcquisitionGuard(contender)({ workspace: WS })).rejects.toThrow(EpochResolveInProgressError)
    } finally { resume(); real.release(); contender.release() }
  })

  it('a CRASHED cell or projector refuses until NAMED — and the name is honoured only when it looks stale', async () => {
    await lease(false, '2 hours')
    await projector(true, `now() - interval '2 hours'`)
    const holders = await epochResolveOnlineHolders(db.pool, WS)
    expect(holders).toEqual([
      { kind: 'ownership_lease', cellId: 'cell-a', fencingToken: '7', stale: true },
      expect.objectContaining({ kind: 'projector', instanceId: PROJECTOR, attached: true, stale: true }),
    ])
    const claimWith = async (override: EpochResolveStaleOverride) => {
      const client = await db.pool.connect()
      try { return await claimEpochResolveWriteFence(client, WS, { override }) } finally { client.release() }
    }
    // Unnamed, or named wrong (token, instance): refused, nothing written.
    expect(await claimWith({})).toMatchObject({ claimed: false })
    expect(await claimWith({ leases: [{ cellId: 'cell-a', fencingToken: '6' }], projectorInstanceId: PROJECTOR })).toMatchObject({ claimed: false })
    expect(await claimWith({ leases: [{ cellId: 'cell-a', fencingToken: '7' }] })).toMatchObject({ claimed: false })
    expect(await fenceOf()).toBe(PROJECTOR)
    // The remedy names the lease-release tooling.
    const repo = new Repo({ network: [] })
    try {
      const refused = await applyEpochResolveRepointing({
        db: db.pool, connect: () => db.pool.connect(), key: WS, repo, rootUrl: 'automerge:root', config: modelEpochConfig({}),
        withLifecycleLock: async <T>(critical: () => Promise<T>) => ({ granted: true as const, value: await critical() }),
      }, 'repoint')
      expect(refused).toMatchObject({ outcome: 'refused_online', remedy: expect.stringContaining('restore:reset-routing') })
      expect((refused as { remedy: string }).remedy).toContain('syncCells/restoreRoutingReset.ts')
    } finally { await repo.shutdown() }
    // Named exactly, and stale: released (token kept) and detached, in the claim.
    const claimed = await claimWith({ leases: [{ cellId: 'cell-a', fencingToken: '7' }], projectorInstanceId: PROJECTOR })
    expect(claimed).toMatchObject({ claimed: true, releasedLeases: [{ cellId: 'cell-a', fencingToken: '7' }], detachedProjector: PROJECTOR })
    const { rows } = await db.pool.query<{ released: boolean; fencing_token: string }>(
      'SELECT released_at IS NOT NULL AS released, fencing_token::text AS fencing_token FROM sync_workspace_ownership')
    expect(rows).toEqual([{ released: true, fencing_token: '7' }])
    expect(await epochResolveOnlineHolders(db.pool, WS)).toEqual([])
  })

  it('a FRESH lease or a RECENT projector is never overridden by naming it', async () => {
    await lease(false, '10 minutes')
    await projector(true, `now() - interval '1 minute'`)
    const client = await db.pool.connect()
    try {
      expect(await claimEpochResolveWriteFence(client, WS, {
        override: { leases: [{ cellId: 'cell-a', fencingToken: '7' }], projectorInstanceId: PROJECTOR },
      })).toMatchObject({ claimed: false, reason: 'online' })
    } finally { client.release() }
    const { rows } = await db.pool.query<{ released: boolean }>('SELECT released_at IS NOT NULL AS released FROM sync_workspace_ownership')
    expect(rows).toEqual([{ released: false }])
    expect(await fenceOf()).toBe(PROJECTOR)
  })

  it('a final flush that FAILS keeps the fence ACTIVE — no cell may acquire a half-written resolution', async () => {
    const repo = new Repo({ network: [] })
    const log: Array<Record<string, unknown>> = []
    repo.flush = async () => { throw new Error('storage down') }
    try {
      expect(await applyEpochResolveRepointing({
        db: db.pool, connect: () => db.pool.connect(), key: WS, repo, rootUrl: 'automerge:root', config: modelEpochConfig({}),
        withLifecycleLock: async <T>(critical: () => Promise<T>) => ({ granted: true as const, value: await critical() }),
        resolve: async () => ({ outcome: 'nothing_stuck' as const }), log: (e) => log.push(e),
      }, 'repoint')).toEqual({ outcome: 'nothing_stuck' })
      expect((await fenceOf())!.startsWith(EPOCH_RESOLVE_FENCE_PREFIX)).toBe(true)
      await expect(epochResolveAcquisitionGuard(db.pool)({ workspace: WS })).rejects.toThrow(EpochResolveInProgressError)
      expect(log.find((e) => e.event === 'model_epoch.resolve_repointing.flush_failed')).toMatchObject({ alert: true })
    } finally { await repo.shutdown().catch(() => undefined) }
  })

  it('an ATTACHED projector never seen projecting is NOT stale — naming it does not override it', async () => {
    await projector(true, null)
    expect(await epochResolveOnlineHolders(db.pool, WS)).toEqual([
      { kind: 'projector', instanceId: PROJECTOR, attached: true, lastSeenAgeMs: null, stale: false },
    ])
    const client = await db.pool.connect()
    try {
      expect(await claimEpochResolveWriteFence(client, WS, { override: { projectorInstanceId: PROJECTOR } }))
        .toMatchObject({ claimed: false, reason: 'online' })
    } finally { client.release() }
  })

  it('no projection-state row: refused, never invented', async () => {
    await db.pool.query('DELETE FROM read_model_projection_state')
    expect(await claim()).toEqual({ claimed: false, reason: 'no_projection_state' })
  })
})

describe('epoch:resolve-repointing arguments', () => {
  it('positionals, the door, and the stale-holder names', () => {
    expect(parseEpochResolveArgs(['l', 'v', '--adopt-root', '--stale-lease', 'cell-a.host:7', '--stale-lease', 'b:9', '--stale-projector', 'p1']))
      .toEqual({ landscapeId: 'l', versionId: 'v', repoint: false, adopt: true,
        override: { leases: [{ cellId: 'cell-a.host', fencingToken: '7' }, { cellId: 'b', fencingToken: '9' }], projectorInstanceId: 'p1' } })
    expect(parseEpochResolveArgs(['l', 'v'])).toEqual({ landscapeId: 'l', versionId: 'v', repoint: false, adopt: false, override: {} })
    expect(() => parseEpochResolveArgs(['l', 'v', '--stale-lease'])).toThrow(/needs a value/)
    expect(() => parseEpochResolveArgs(['l', 'v', '--stale-lease', 'cell'])).toThrow(/<cell>:<token>/)
    // M6: the token is DIGITS only — a typo never names a lease.
    for (const bad of ['cell:abc', 'cell:', 'cell:7x', ':7', 'cell:-7']) {
      expect(() => parseEpochResolveArgs(['l', 'v', '--stale-lease', bad]), bad).toThrow(/<cell>:<token>/)
    }
    // A workspace has one projector row: naming two is an error, never last-wins.
    expect(() => parseEpochResolveArgs(['l', 'v', '--stale-projector', 'p1', '--stale-projector', 'p2'])).toThrow(/given twice/)
    expect(EPOCH_RESOLVE_CLI_HELP).toMatch(/DO NOT CLEAR THE maintenance:epoch-resolve-repointing: FENCE BY HAND; RE-RUN THE CLI/)
    expect(() => parseEpochResolveArgs(['l', 'v', '--repoint', '--adopt-root'])).toThrow(/usage/)
    expect(() => parseEpochResolveArgs(['l', 'v', '--bogus'])).toThrow(/unknown argument/)
  })
})
