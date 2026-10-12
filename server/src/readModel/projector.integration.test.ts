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

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import {
  upsertObjects, upsertConnections, deleteObjects,
  applyObjectShardDelta, coldBuildReadModel, deleteGroups, upsertGroups, type WorkspaceKey,
} from './projector.js'

/**
 * Postgres integration tests. They connect to a real database (DATABASE_URL or the
 * dev default) and SKIP themselves when none is reachable, so the suite is green
 * without a DB but catches real regressions when one is present. Every test runs
 * inside a transaction that is ROLLED BACK, so it never touches existing data.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'projector')
  try {
    const c = await p.connect()
    c.release()
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[readModel integration] no Postgres at ${URL} — skipping DB tests`)

// Every row lives under a workspace key — this suite uses one fixed key
// throughout (cross-workspace isolation is covered by workspaceIsolation.integration.test.ts).
const WS: WorkspaceKey = { landscapeId: 'ws-test', versionId: 'v1' }

suite('read-model projector (Postgres integration, txn-isolated)', () => {
  let client: pg.PoolClient

  // Schema is ensured once by vitest globalSetup (avoids concurrent-CREATE races).
  afterAll(async () => {
    await pool!.end()
  })
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    // Scope the clean-slate delete to this suite's workspace — the shared
    // `public` schema now holds every workspace's rows side by side, so a bare
    // TRUNCATE would blow away rows other txn-isolated suites (running
    // concurrently against the same pool) depend on.
    await client.query('DELETE FROM ro_object_technologies WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_group_technologies WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_object_tags WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_group_tags WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_object_teams WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_connections WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    await client.query('DELETE FROM ro_groups WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
  })
  afterEach(async () => {
    await client.query('ROLLBACK') // discard everything — existing data untouched
    client.release()
  })

  const countObjects = async () =>
    Number((await client.query('SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])).rows[0].n)
  const getObject = async (id: string) =>
    (await client.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [WS.landscapeId, WS.versionId, id]
    )).rows[0]?.data
  const degree = async (id: string) =>
    Number((await client.query(
      'SELECT count(*)::int AS n FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND (from_id=$3 OR to_id=$3)',
      [WS.landscapeId, WS.versionId, id]
    )).rows[0].n)

  it('upsert inserts, then updates in place — idempotent', async () => {
    await upsertObjects(client, WS, null, [{ id: 'o1', name: 'A' }])
    expect(await countObjects()).toBe(1)
    await upsertObjects(client, WS, null, [{ id: 'o1', name: 'A' }]) // replay → still one row
    expect(await countObjects()).toBe(1)
    await upsertObjects(client, WS, null, [{ id: 'o1', name: 'A2' }]) // update
    expect((await getObject('o1'))?.name).toBe('A2')
    expect(await countObjects()).toBe(1)
  })

  it('object(id) reconstructs the entity byte-for-byte from data', async () => {
    const o = {
      id: 'o1', type: 'app', name: 'API', description: 'd', technology: 'Go',
      tagAssignments: { x: { tagId: 'x' } }, tagOrder: ['x'], properties: { a: 1 },
    }
    await upsertObjects(client, WS, null, [o])
    expect(await getObject('o1')).toEqual(o)
  })

  it('replaces technology postings on update and removes them with the object', async () => {
    const usage = (technologyId: string, revision: number) => ({
      id: 'u1', technologyId, catalogRevision: revision, usedVersion: '21', role: 'framework',
      snapshot: { name: technologyId },
    })
    await upsertObjects(client, WS, 'org1', [{ id: 'o1', technologyUsages: { u1: usage('angular', 2) } }])
    await upsertObjects(client, WS, 'org1', [{ id: 'o1', technologyUsages: { u1: usage('react', 4) } }])
    const postings = await client.query(
      `SELECT object_id, usage_id, technology_id, catalog_revision, used_version, role
       FROM ro_object_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1'`,
      [WS.landscapeId, WS.versionId]
    )
    expect(postings.rows).toEqual([{
      object_id: 'o1', usage_id: 'u1', technology_id: 'react', catalog_revision: 4,
      used_version: '21', role: 'framework',
    }])
    await deleteObjects(client, WS, ['o1'])
    expect((await client.query(
      `SELECT 1 FROM ro_object_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1'`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([])
  })

  it('replaces normalized team postings on update and removes them with the object', async () => {
    await upsertObjects(client, WS, 'org1', [{ id: 'o1', ownerTeamIds: ['team-a'], teamIds: ['team-b'] }])
    await upsertObjects(client, WS, 'org1', [{ id: 'o1', ownerTeamIds: ['team-c'] }])
    expect((await client.query(
      `SELECT team_id FROM ro_object_teams
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1' ORDER BY team_id`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([{ team_id: 'team-c' }])
    await deleteObjects(client, WS, ['o1'])
    expect((await client.query(
      `SELECT 1 FROM ro_object_teams
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1'`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([])
  })

  it('replaces ordered Tag postings on update and removes them with the object', async () => {
    await upsertObjects(client, WS, 'org1', [{
      id: 'o1',
      tagAssignments: { risk: { tagId: 'risk' }, region: { tagId: 'region' } },
      tagOrder: ['region', 'risk'],
    }])
    await upsertObjects(client, WS, 'org1', [{
      id: 'o1', tagAssignments: { risk: { tagId: 'risk' } }, tagOrder: ['risk'],
    }])
    expect((await client.query(
      `SELECT tag_id, ordinal FROM ro_object_tags
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1' ORDER BY ordinal`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([{ tag_id: 'risk', ordinal: 0 }])
    await deleteObjects(client, WS, ['o1'])
    expect((await client.query(
      `SELECT 1 FROM ro_object_tags
       WHERE landscape_id = $1 AND version_id = $2 AND object_id = 'o1'`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([])
  })

  it('replaces group technology postings and removes them with the group', async () => {
    const group = (technologyId: string) => ({
      id: 'g1', name: 'Runtime boundary',
      technologyUsages: {
        u1: {
          id: 'u1', technologyId, catalogRevision: 2, role: 'infrastructure',
          snapshot: { name: technologyId, recommendedShapeTypes: ['group'] },
        },
      },
    })
    await upsertGroups(client, WS, 'org1', [group('tech-docker')])
    await upsertGroups(client, WS, 'org1', [group('tech-terraform')])
    expect((await client.query(
      `SELECT group_id, usage_id, technology_id, catalog_revision, role
       FROM ro_group_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND group_id = 'g1'`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([{
      group_id: 'g1', usage_id: 'u1', technology_id: 'tech-terraform',
      catalog_revision: 2, role: 'infrastructure',
    }])

    await deleteGroups(client, WS, ['g1'])
    expect((await client.query(
      `SELECT 1 FROM ro_group_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND group_id = 'g1'`,
      [WS.landscapeId, WS.versionId]
    )).rows).toEqual([])
  })

  it('applyObjectShardDelta upserts current members and deletes departed ids', async () => {
    await upsertObjects(client, WS, null, [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }])
    // shard was [o1,o2]; now [o2(updated), o3]
    await applyObjectShardDelta(client, WS, null, ['o1', 'o2'], [{ id: 'o2', name: 'B2' }, { id: 'o3', name: 'C' }])
    expect(await countObjects()).toBe(2)
    expect(await getObject('o1')).toBeUndefined()
    expect((await getObject('o2'))?.name).toBe('B2')
    expect((await getObject('o3'))?.name).toBe('C')
  })

  it('deleteObjects removes by id', async () => {
    await upsertObjects(client, WS, null, [{ id: 'o1' }, { id: 'o2' }])
    await deleteObjects(client, WS, ['o1'])
    expect(await countObjects()).toBe(1)
    expect(await getObject('o1')).toBeUndefined()
  })

  it('coldBuild is replay-safe and self-heals (drops stale rows on rebuild)', async () => {
    const objs = [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }]
    const conns = [{ id: 'c1', fromId: 'o1', toId: 'o2' }]
    await coldBuildReadModel(client, WS, null, objs, conns)
    expect(await countObjects()).toBe(2)
    await coldBuildReadModel(client, WS, null, objs, conns) // replay → identical
    expect(await countObjects()).toBe(2)
    await coldBuildReadModel(client, WS, null, [{ id: 'o1', name: 'A' }], []) // shrink → o2 dropped
    expect(await countObjects()).toBe(1)
    expect(await getObject('o2')).toBeUndefined()
  })

  it('the COLD BUILD analyzes ro_objects before reparenting, and the delta path does NOT', async () => {
    // Both halves, because each alone is satisfied by the wrong thing.
    //
    // The cold build DELETEs every `ro_objects` row for the workspace and
    // re-inserts them, so the planner's statistics for this `landscape_id` are
    // worthless exactly where `refreshEffectiveParents` correlates the table
    // with itself. Measured at 12 000 objects: without ANALYZE the planner
    // estimates `rows=1` and picks a per-row SubPlan, ~21 s instead of ~1.6 s
    // for that UPDATE.
    //
    // And the delta path must NOT do it: the same ANALYZE there costs ~2.5x on
    // a small shard, on the hottest path in the projector. That is why this is
    // a parameter and not a default, and this half is the one that would rot
    // silently.
    const recorded: string[] = []
    let failAnalyze = false
    const recordingClient = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== 'query') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (text: string, params?: unknown[]) => {
          if (typeof text === 'string') recorded.push(text.trim().split('\n')[0].trim())
          // A statement Postgres really rejects, so the catch is entered by the
          // database rather than by a stub — and the transaction is genuinely in
          // the aborted state the SAVEPOINT has to rescue it from.
          const sql = failAnalyze && text === 'ANALYZE ro_objects'
            ? 'ANALYZE ro_objects_no_such_table'
            : text
          return (target.query as (t: string, p?: unknown[]) => Promise<never>)(sql, params)
        }
      },
    })
    // EXACT match, not `startsWith`. `rebuildReadModelDerivedStats` already
    // issues `ANALYZE ro_objects, ro_connections, …` at the END of the cold
    // build — a different statement for a different query — and a prefix test
    // counts both. Do not loosen this to `>= 1`; that version could never fail.
    const ANALYZE = 'ANALYZE ro_objects'
    const analyzeCount = () => recorded.filter((sql) => sql === ANALYZE).length

    await coldBuildReadModel(recordingClient, WS, null, [{ id: 'o1', name: 'A' }, { id: 'o2', parentId: 'o1' }], [])
    expect(analyzeCount()).toBe(1)
    // BETWEEN the insert and the reparent — BOTH bounds, because either alone
    // is satisfied by a placement that does nothing. An ANALYZE at the TOP of
    // `upsertObjects` would still be before the reparent and completely dead:
    // analyzing a table whose rows for this workspace were just DELETEd is what
    // produces the `est=1` plan in the first place.
    const analyzeAt = recorded.findIndex((sql) => sql === ANALYZE)
    const insertAt = recorded.findIndex((sql) => sql.startsWith('INSERT INTO ro_objects'))
    const reparentAt = recorded.findIndex((sql) => sql.startsWith('UPDATE ro_objects'))
    expect(insertAt).toBeGreaterThan(-1)
    expect(reparentAt).toBeGreaterThan(-1)
    expect(analyzeAt).toBeGreaterThan(insertAt)
    expect(analyzeAt).toBeLessThan(reparentAt)
    // BOUNDED, and released again. An unbounded wait here would sit inside the
    // projection mutex on a CROSS-WORKSPACE table lock; leaving the ceiling
    // armed afterwards would re-time every later lock in the projection.
    expect(recorded).toContain("SET LOCAL lock_timeout = '15000ms'")
    expect(recorded.lastIndexOf('SET LOCAL lock_timeout = 0')).toBeGreaterThan(analyzeAt)
    // And it is allowed to fail without taking the build with it.
    expect(recorded).toContain('SAVEPOINT read_model_analyze')

    // THE DEGRADE PATH, DRIVEN — not merely asserted as a string.
    //
    // `expect(recorded).toContain('SAVEPOINT read_model_analyze')` above proves
    // the savepoint is opened; it proves nothing about what happens when the
    // ANALYZE inside it FAILS. Rethrowing from the catch, or dropping the
    // `ROLLBACK TO SAVEPOINT`, would make the transaction not survive a failed
    // ANALYZE — the one thing the savepoint exists to prevent (a cold build
    // lost to an optimisation).
    //
    // Driven by substituting a statement that genuinely errors, so the catch is
    // entered by Postgres rather than by a stub.
    recorded.length = 0
    const warnings: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      failAnalyze = true
      await coldBuildReadModel(recordingClient, WS, null, [{ id: 'o4', name: 'D' }], [])
    } finally {
      failAnalyze = false
      console.warn = warn
    }
    // The build COMPLETED despite the failed ANALYZE — the property that matters.
    expect(await getObject('o4')).toBeDefined()
    expect(recorded).toContain('ROLLBACK TO SAVEPOINT read_model_analyze')
    // And it said so, because a cold build silently taking 4x longer is the
    // kind of thing nobody ever finds.
    expect(warnings.some((args) => String(args[0]).includes('could not ANALYZE ro_objects'))).toBe(true)

    recorded.length = 0
    await applyObjectShardDelta(recordingClient, WS, null, ['o2'], [{ id: 'o2', parentId: 'o1' }, { id: 'o3', parentId: 'o1' }])
    expect(analyzeCount()).toBe(0)
    // CONTROL: the delta really ran the reparent, so the zero above is about the
    // ANALYZE being absent and not about the driver never entering the path.
    expect(recorded.some((sql) => sql.startsWith('UPDATE ro_objects'))).toBe(true)
    expect(await getObject('o3')).toBeDefined()
  })

  it('degree via from_id/to_id counts a self-loop once (matches client connectionCount)', async () => {
    await upsertObjects(client, WS, null, [{ id: 'A' }, { id: 'B' }, { id: 'C' }])
    await upsertConnections(client, WS, null, [
      { id: 'c1', fromId: 'A', toId: 'B' },
      { id: 'c2', fromId: 'C', toId: 'A' },
      { id: 'c3', fromId: 'A', toId: 'A' }, // self-loop
    ])
    expect(await degree('A')).toBe(3)
    expect(await degree('B')).toBe(1)
    expect(await degree('C')).toBe(1)
  })
})
