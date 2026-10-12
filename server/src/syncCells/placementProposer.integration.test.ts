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

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createPlacementProposerFixture, controlledPlacementObservations } from '../testing/placementProposerFixture.js'
import { auditPlacementProposerRole } from './placementProposerRole.js'
import { ensurePlacementProposerSchema } from './placementProposerSchema.js'
import { readPlacementProposerSnapshot } from './placementProposerSnapshot.js'
import { persistObservedPlacement, placementProposalLockKey, PlacementProposer, type ProposalWriteResult } from './placementProposer.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
type Fixture = Awaited<ReturnType<typeof createPlacementProposerFixture>>
describe.skipIf(!TEST_DATABASE_URL)('restricted proposer transactions in PostgreSQL (T-14d)', () => {
  let f: Fixture
  let databaseAdmin: Pool | undefined
  const database = 'test_proposer_' + randomUUID().replaceAll('-', '')
  let databaseCreated = false
  const extraPools: Pool[] = []
  const blockers: PoolClient[] = []
  const flights: Promise<PromiseSettledResult<ProposalWriteResult>>[] = []
  function tracked(run: Promise<ProposalWriteResult>): Promise<ProposalWriteResult> {
    // Retain rejections immediately, then surface them after releasing blockers
    // in afterEach even when the test exits before its normal join.
    flights.push(run.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })))
    return run
  }
  // The audit deliberately reads database-wide ACLs. A schema cannot isolate
  // this suite's PUBLIC grants or executable SECURITY DEFINER probes from a
  // concurrent restricted LOGIN in another suite.
  const cleanupDatabase = async () => {
    const errors: unknown[] = []
    try { await f?.cleanup() } catch (error) { errors.push(error) }
    if (databaseCreated) {
      try { await databaseAdmin!.query(`DROP DATABASE "${database}"`); databaseCreated = false }
      catch (error) { errors.push(error) }
    }
    try { await databaseAdmin?.end() } catch (error) { errors.push(error) }
    databaseAdmin = undefined
    if (errors.length) throw new AggregateError(errors, 'proposer test database cleanup failed')
  }
  beforeAll(async () => {
    databaseAdmin = guardIdleClientErrors(new Pool({ connectionString: TEST_DATABASE_URL!, max: 1 }), 'proposer-test-database')
    try {
      await databaseAdmin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
      databaseCreated = true
      const url = new URL(TEST_DATABASE_URL!)
      url.pathname = '/' + database
      f = await createPlacementProposerFixture(url.href, 'placement_proposer')
    } catch (error) {
      try { await cleanupDatabase() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'proposer database setup and cleanup failed', { cause: cleanupError }) }
      throw error
    }
  })
  beforeEach(async () => { await f.reset() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const errors: unknown[] = []
    for (const client of blockers.splice(0)) {
      try { await client.query('ROLLBACK'); client.release() }
      catch (error) { client.release(true); errors.push(error) }
    }
    for (const result of await Promise.all(flights.splice(0))) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    for (const pool of extraPools.splice(0)) {
      try { await pool.end() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'proposer test resources not joined')
  })
  afterAll(async () => { if (databaseAdmin) await cleanupDatabase() })
  const observed = () => controlledPlacementObservations(f.reader, f.config.schema)
  const write = async (id = randomUUID(), pool = f.reader) =>
    persistObservedPlacement(pool, f.config, await observed(), 'subject', 1, id)
  const rows = async () => (await f.db.pool.query('SELECT * FROM sync_placement_proposals ORDER BY proposal_id')).rows
  const newReader = () => {
    const pool = guardIdleClientErrors(new Pool(f.config.pool), 't14d-concurrent-reader')
    extraPools.push(pool)
    return pool
  }
  async function holdLandscape() {
    const blocker = await f.db.pool.connect()
    blockers.push(blocker)
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [placementProposalLockKey(f.config.schema, JSON.stringify(['landscape','subject']))])
    return blocker
  }
  async function release(blocker: PoolClient) {
    await blocker.query('COMMIT')
    blockers.splice(blockers.indexOf(blocker), 1)
    blocker.release()
  }
  async function waitBlocked(pids: number[]) {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      const waiters = await f.db.pool.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'`, [pids])
      if (Number(waiters.rows[0].count) === pids.length) return
      await delay(10)
    }
    throw new Error('real-PG-lock-wait-not-observed')
  }
  const pid = async (pool: Pool) => (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

  it('audits the actual password LOGIN and exercises all required SELECTs', async () => {
    const identity = await f.reader.query('SELECT session_user,current_user')
    expect(identity.rows[0]).toEqual({ session_user: f.config.role, current_user: f.config.role })
    expect(await auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).toMatchObject({ role: f.config.role })
    const snapshot = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    expect(snapshot.workspaces).toHaveLength(6)
    expect(snapshot.history.proposalCoverage?.fromBeginning).toBe(true)
  })
  it('admits the complete group including a draft and an already-target member in one row', async () => {
    const result = await write()
    expect(result).toMatchObject({ kind: 'admitted', admission: { gain: { poolGain: 8 }, sampleCount: 61 } })
    const persisted = await rows()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].payload.members).toEqual([
      { landscapeId: 'subject', versionId: 's1', fromPartition: 0, toPartition: 1 },
      { landscapeId: 'subject', versionId: 's2', fromPartition: 0, toPartition: 1 },
      { landscapeId: 'subject', versionId: 's3', fromPartition: 1, toPartition: 1 },
    ])
    expect(persisted[0].payload.policy).toMatchObject({ entryStableMs: 300000, returnStableMs: 1800000 })
    const snapshot = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    expect(snapshot.history.proposals).toHaveLength(3)
    expect(snapshot.history.proposals[0].atUs.toString()).toBe(persisted[0].payload.evaluatedAtUs)
    expect(snapshot.workspaces.find(w => w.versionId === 's1')?.placement?.partition).toBe(0)
  })
  it('repeats and a newly connected process keep the durable per-member cooldown', async () => {
    expect(await write()).toMatchObject({ kind: 'admitted' })
    expect(await write()).toEqual({ kind: 'refused', reason: 'recent-proposal' })
    expect(await write(randomUUID(), newReader())).toEqual({ kind: 'refused', reason: 'recent-proposal' })
    expect(await rows()).toHaveLength(1)
  })
  it('two actual sessions waiting after BEGIN admit exactly once', async () => {
    const b = newReader()
    const pids = [await pid(f.reader), await pid(b)]
    const input = await observed()
    const blocker = await holdLandscape()
    const aResult = tracked(persistObservedPlacement(f.reader, f.config, input, 'subject', 1))
    const bResult = tracked(persistObservedPlacement(b, f.config, input, 'subject', 1))
    await waitBlocked(pids)
    await release(blocker)
    const results = await Promise.all([aResult, bResult])
    expect(results.map(r => r.kind).sort()).toEqual(['admitted','refused'])
    expect(results.find(r => r.kind === 'refused')).toEqual({ kind: 'refused', reason: 'recent-proposal' })
    expect(await rows()).toHaveLength(1)
  })
  it('rereads the complete group after waiting; a new active version refuses the stale census', async () => {
    const input = await observed(), backend = await pid(f.reader)
    const blocker = await holdLandscape()
    const pending = tracked(persistObservedPlacement(f.reader, f.config, input, 'subject', 1))
    await waitBlocked([backend])
    await f.db.pool.query("INSERT INTO versions(id,landscape_id,kind) VALUES ('new-draft','subject','draft')")
    await release(blocker)
    expect(await pending).toEqual({ kind: 'refused', reason: 'census-changed' })
    expect(await rows()).toHaveLength(0)
  })
  it('rereads tier and organization rights after waiting', async () => {
    const input = await observed(), backend = await pid(f.reader)
    const blocker = await holdLandscape()
    const pending = tracked(persistObservedPlacement(f.reader, f.config, input, 'subject', 1))
    await waitBlocked([backend])
    await f.db.pool.query("UPDATE landscapes SET tier='enterprise' WHERE id='subject'")
    await release(blocker)
    expect(await pending).toEqual({ kind: 'refused', reason: 'census-changed' })
    expect(await rows()).toHaveLength(0)
  })
  it('same UUID recognizes a durable admission without counting it again', async () => {
    const id = randomUUID(), input = await observed()
    expect(await persistObservedPlacement(f.reader, f.config, input, 'subject', 1, id)).toMatchObject({ kind: 'admitted' })
    expect(await persistObservedPlacement(f.reader, f.config, input, 'subject', 1, id)).toEqual({ kind: 'already-admitted', id })
    expect(await persistObservedPlacement(f.reader, f.config, input, 'subject', 0, id))
      .toEqual({ kind: 'unknown', reason: 'idempotency-conflict', id })
    expect(await rows()).toHaveLength(1)
  })
  it('read-only reconciliation proves absence without attempting a new INSERT', async () => {
    const id = randomUUID()
    expect(await persistObservedPlacement(f.reader, f.config, await observed(), 'subject', 1, id, undefined, true))
      .toEqual({ kind: 'refused', reason: 'not-admitted' })
    expect(await rows()).toHaveLength(0)
  })
  it.each([true, false])('COMMIT response loss, durable=%s: no false admission and same-UUID reconciliation', async durable => {
    const input = await observed(), id = randomUUID()
    const client = await f.reader.connect()
    const query = client.query.bind(client)
    client.release()
    const spy = vi.spyOn(client, 'query').mockImplementation(async (sql, values) => {
      if (sql === 'COMMIT') {
        if (durable) await query('COMMIT')
        throw new Error('injected-ack-loss')
      }
      return query(sql, values)
    })
    const result = await persistObservedPlacement(f.reader, f.config, input, 'subject', 1, id)
    expect(result).toEqual({ kind: 'unknown', reason: 'commit-uncertain', id })
    spy.mockRestore()
    expect(await rows()).toHaveLength(durable ? 1 : 0)
    // Membership changed after an uncertain ACK: reconciliation keeps ORIGINAL
    // intent, including identities that no longer exist in the active census.
    if (durable) await f.db.pool.query("UPDATE versions SET status='retired' WHERE landscape_id='subject'")
    const reconciled = await persistObservedPlacement(newReader(), f.config, input, 'subject', 1, id)
    expect(reconciled).toMatchObject({ kind: durable ? 'already-admitted' : 'admitted', id })
    expect(await rows()).toHaveLength(1)
  })
  it('abort during connection acquisition prevents BEGIN and releases the client', async () => {
    const input = await observed()
    const client = await f.reader.connect(), abort = new AbortController()
    const query = vi.spyOn(client, 'query')
    const releaseClient = vi.spyOn(client, 'release')
    const connect = vi.spyOn(f.reader, 'connect').mockImplementation(async () => {
      abort.abort()
      return client
    })
    expect(await persistObservedPlacement(f.reader, f.config, input, 'subject', 1, randomUUID(), abort.signal))
      .toEqual({ kind: 'refused', reason: 'stopped' })
    expect(query).not.toHaveBeenCalled()
    expect(releaseClient).toHaveBeenCalledOnce()
    connect.mockRestore()
  })
  it('failed INSERT rolls the whole group back and releases transaction locks', async () => {
    await f.db.pool.query(`CREATE FUNCTION reject_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'controlled insert failure'; END $$;
      CREATE TRIGGER reject_proposal BEFORE INSERT ON sync_placement_proposals
        FOR EACH ROW EXECUTE FUNCTION reject_proposal()`)
    try {
      expect(await write()).toMatchObject({ kind: 'unknown', reason: 'transaction-failed' })
      expect(await rows()).toHaveLength(0)
      const locks = await f.db.pool.query(`SELECT * FROM pg_locks WHERE locktype='advisory'
        AND pid=$1`, [await pid(f.reader)])
      expect(locks.rows).toHaveLength(0)
    } finally { await f.db.pool.query('DROP TRIGGER reject_proposal ON sync_placement_proposals; DROP FUNCTION reject_proposal()') }
  })
  it('rollback failure destroys the client and cannot report success', async () => {
    const input = await observed()
    const client = await f.reader.connect(), query = client.query.bind(client)
    const oldPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    client.release()
    vi.spyOn(client, 'query').mockImplementation(async (sql, values) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO')) throw new Error('insert-failure')
      if (sql === 'ROLLBACK') throw new Error('rollback-failure')
      return query(sql, values)
    })
    await expect(persistObservedPlacement(f.reader, f.config, input, 'subject', 1)).rejects.toThrow('rollback-failed')
    expect(f.reader.totalCount).toBe(0)
    expect(await pid(f.reader)).not.toBe(oldPid)
    expect(await rows()).toHaveLength(0)
  })

  const denied = [
    ["UPDATE workspace_placement SET partition=1 WHERE version_id='s1'", 'workspace_placement'],
    ["UPDATE sync_workspace_ownership SET cell_id='cell-b' WHERE version_id='s1'", 'sync_workspace_ownership'],
    ["INSERT INTO sync_workspace_placement_moves(landscape_id,version_id,from_cell_id,to_cell_id,fencing_token) VALUES ('subject','s1','a','b',2)", 'sync_workspace_placement_moves'],
    ["UPDATE read_model_static_workspaces SET status='changed'", 'read_model_static_workspaces'],
    ["UPDATE landscapes SET tier='enterprise' WHERE id='subject'", 'landscapes'],
    ["UPDATE sync_placement_history_coverage SET from_at='2000-01-01'", 'sync_placement_history_coverage'],
    ["UPDATE sync_topology_contract SET value='changed'", 'sync_topology_contract'],
    ['DELETE FROM workspace_placement', 'workspace_placement'],
    ['TRUNCATE sync_workspace_placement_moves', 'sync_workspace_placement_moves'],
  ]
  it.each(denied)('actual LOGIN receives SQLSTATE 42501 and unchanged values: %s', async (sql, table) => {
    const before = (await f.db.pool.query(`SELECT * FROM ${table}`)).rows
    await expect(f.reader.query(sql)).rejects.toMatchObject({ code: '42501' })
    expect((await f.db.pool.query(`SELECT * FROM ${table}`)).rows).toEqual(before)
  })
  const excess = [
    ['GRANT UPDATE ON workspace_placement TO ROLE', 'REVOKE UPDATE ON workspace_placement FROM ROLE'],
    ['GRANT UPDATE(partition) ON workspace_placement TO ROLE', 'REVOKE UPDATE(partition) ON workspace_placement FROM ROLE'],
    ['GRANT UPDATE ON workspace_placement TO PUBLIC', 'REVOKE UPDATE ON workspace_placement FROM PUBLIC'],
    ['GRANT CREATE ON SCHEMA SCHEMA TO ROLE', 'REVOKE CREATE ON SCHEMA SCHEMA FROM ROLE'],
    ['GRANT USAGE ON SEQUENCE sync_workspace_placement_moves_move_id_seq TO ROLE', 'REVOKE USAGE ON SEQUENCE sync_workspace_placement_moves_move_id_seq FROM ROLE'],
    ['GRANT pg_monitor TO ROLE', 'REVOKE pg_monitor FROM ROLE'],
    ['ALTER role ROLE BYPASSRLS', 'ALTER role ROLE NOBYPASSRLS'],
  ]
  it.each(excess)('live audit rejects privilege escalation: %s', async (grant, revoke) => {
    const sql = (value: string) => value.replaceAll('ROLE', '"' + f.config.role + '"').replaceAll('SCHEMA', '"' + f.config.schema + '"')
    // Replace the identifier placeholder only, not the keyword SCHEMA.
    const normalize = (value: string) => sql(value.replace('ON SCHEMA SCHEMA', 'ON schema SCHEMA'))
    await f.db.pool.query(normalize(grant))
    try { await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).rejects.toThrow('unsafe') }
    finally { await f.db.pool.query(normalize(revoke)) }
    expect(await auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).toMatchObject({ role: f.config.role })
  })
  it('rejects executable SECURITY DEFINER and ownership of an invoker function', async () => {
    await f.db.pool.query("CREATE FUNCTION privilege_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'")
    try { await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).rejects.toThrow('unsafe') }
    finally { await f.db.pool.query('DROP FUNCTION privilege_probe()') }
    await f.db.pool.query(`CREATE FUNCTION privilege_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
      ALTER FUNCTION privilege_probe() OWNER TO "${f.config.role}"`)
    try { await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).rejects.toThrow('unsafe') }
    finally { await f.db.pool.query('DROP FUNCTION privilege_probe()') }
  })
  it.each([
    ['PUBLIC write', 'GRANT UPDATE ON workspace_placement TO PUBLIC', 'REVOKE UPDATE ON workspace_placement FROM PUBLIC'],
    ['PUBLIC definer', "CREATE FUNCTION isolation_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'", 'DROP FUNCTION isolation_probe()'],
  ])('keeps %s refusal inside this database while another LOGIN remains safe', async (_kind, grant, revoke) => {
    const other = await createPlacementProposerFixture(TEST_DATABASE_URL!, 'proposer_acl_bystander')
    try {
      const ownDb = (await f.reader.query('SELECT current_database() AS name')).rows[0].name
      const otherDb = (await other.reader.query('SELECT current_database() AS name')).rows[0].name
      expect(ownDb).not.toBe(otherDb)
      await expect(auditPlacementProposerRole(other.reader, other.config.schema, other.config.role)).resolves.toMatchObject({ role: other.config.role })
      await f.db.pool.query(grant)
      try {
        await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).rejects.toThrow('unsafe-placement-proposer-role')
        await expect(auditPlacementProposerRole(other.reader, other.config.schema, other.config.role)).resolves.toMatchObject({ role: other.config.role })
      } finally { await f.db.pool.query(revoke) }
      await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).resolves.toMatchObject({ role: f.config.role })
    } finally { await other.cleanup() }
  })
  it('rejects RLS on an activity source even with SELECT privileges', async () => {
    await f.db.pool.query('ALTER TABLE automerge_storage ENABLE ROW LEVEL SECURITY')
    try { await expect(auditPlacementProposerRole(f.reader, f.config.schema, f.config.role)).rejects.toThrow('unsafe') }
    finally { await f.db.pool.query('ALTER TABLE automerge_storage DISABLE ROW LEVEL SECURITY') }
  })
  it.each(['UPDATE', 'DELETE', 'TRUNCATE'])('%s of history starts new coverage and cannot waive six hours', async op => {
    const before = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    const sql = op === 'UPDATE' ? 'UPDATE sync_workspace_placement_moves SET to_cell_id=to_cell_id'
      : op === 'DELETE' ? 'DELETE FROM sync_workspace_placement_moves' : 'TRUNCATE sync_workspace_placement_moves'
    await f.db.pool.query(sql)
    const after = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    expect(after.history.movementCoverage?.origin).not.toBe(before.history.movementCoverage?.origin)
    expect(after.history.movementCoverage?.fromBeginning).toBe(false)
    expect(await write()).toEqual({ kind: 'refused', reason: 'warming-history' })
  })
  it('identical schema installation preserves age; a missing marker on an old empty table is not inception', async () => {
    const before = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    const client = await f.db.pool.connect()
    let destroy = false
    try {
      await client.query('BEGIN')
      await ensurePlacementProposerSchema(client)
      await client.query('COMMIT')
    } catch (error) {
      try { await client.query('ROLLBACK') }
      catch (rollbackError) {
        destroy = true
        throw new AggregateError([error, rollbackError], 'fixture migration rollback failed', { cause: rollbackError })
      }
      throw error
    } finally { client.release(destroy) }
    const after = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    expect(after.history.proposalCoverage?.fromUs).toBe(before.history.proposalCoverage?.fromUs)
    await f.db.pool.query("DELETE FROM sync_placement_history_coverage WHERE kind='proposals'")
    const repair = await f.db.pool.connect()
    let repairDestroy = false
    try {
      await repair.query('BEGIN')
      await ensurePlacementProposerSchema(repair)
      await repair.query('COMMIT')
    } catch (error) {
      try { await repair.query('ROLLBACK') }
      catch (rollbackError) {
        repairDestroy = true
        throw new AggregateError([error, rollbackError], 'fixture repair rollback failed', { cause: rollbackError })
      }
      throw error
    } finally { repair.release(repairDestroy) }
    const repaired = await readPlacementProposerSnapshot(f.reader, f.config.schema)
    expect(repaired.history.proposalCoverage?.fromBeginning).toBe(false)
    expect(repaired.history.proposalCoverage!.fromUs).toBeGreaterThan(before.atUs)
    expect(await write()).toEqual({ kind: 'refused', reason: 'warming-history' })
  })
  it('disabled movement trigger is unknown coverage, never an empty proven history', async () => {
    await f.db.pool.query('ALTER TABLE sync_workspace_ownership DISABLE TRIGGER trg_sync_placement_move')
    try {
      expect((await readPlacementProposerSnapshot(f.reader, f.config.schema)).history.movementCoverage).toBeNull()
      expect(await write()).toEqual({ kind: 'refused', reason: 'warming-history' })
    } finally { await f.db.pool.query('ALTER TABLE sync_workspace_ownership ENABLE TRIGGER trg_sync_placement_move') }
  })
  it('recreating the movement source with identical names and trigger text breaks coverage', async () => {
    const definition = (await f.db.pool.query<{ definition: string }>(`SELECT pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid='sync_workspace_ownership'::regclass AND tgname='trg_sync_placement_move'`)).rows[0].definition
    await f.db.pool.query(`ALTER TABLE sync_workspace_ownership RENAME TO old_ownership;
      CREATE TABLE sync_workspace_ownership (LIKE old_ownership INCLUDING ALL)`)
    try {
      await f.db.pool.query(definition)
      expect((await readPlacementProposerSnapshot(f.reader, f.config.schema)).history.movementCoverage).toBeNull()
    } finally {
      await f.db.pool.query('DROP TABLE sync_workspace_ownership; ALTER TABLE old_ownership RENAME TO sync_workspace_ownership')
    }
    expect((await readPlacementProposerSnapshot(f.reader, f.config.schema)).history.movementCoverage).not.toBeNull()
  })
  it('malformed or incomplete history refuses rather than dropping budget members', async () => {
    expect(await write()).toMatchObject({ kind: 'admitted' })
    await f.db.pool.query(`UPDATE sync_placement_proposals SET payload =
      jsonb_set(payload,'{members}',jsonb_build_array(payload->'members'->0))`)
    await expect(readPlacementProposerSnapshot(f.reader, f.config.schema)).rejects.toThrow('proposal-history')
  })
  it('the native scalar witness renews every fleet member and stop prevents new work', async () => {
    const proposer = new PlacementProposer(f.reader, f.config)
    try {
      const first = proposer.pass()
      expect(proposer.pass()).toBe(first)
      expect(await first).toMatchObject({ kind: 'observed', censusCount: 6, frames: 1 })
      await delay(5)
      expect(await proposer.pass()).toMatchObject({ kind: 'observed', censusCount: 6, frames: 2 })
    } finally { await proposer.stop() }
    expect(await proposer.pass()).toEqual({ kind: 'stopped' })
  })
})
