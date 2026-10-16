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

// QA-lens additions for the read-model flow index (roEntityFlows +
// replaceDiagramFlowIndex): each test here killed a mutant the first battery
// let survive (rename, page bound, ordering, LEFT JOIN, leaked ro_flows rows,
// id-less flows, the ro_flow_objects primary key). Same txn-isolated pattern
// as queries.integration.test.ts; the schema test runs in its own schema.

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { coldBuildReadModel, deleteDiagrams, syncConnectionFlows, syncDiagrams, type WorkspaceKey } from './projector.js'
import { roEntityFlows } from './queries.js'
import { ensureReadModelSchema } from './schema.js'
import type { DiagramInput, FlowInput } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb } from '../testing/isolatedSchema.js'

const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'qa-entity-flows')
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
if (!pool) console.warn(`[flow index QA] no Postgres at ${URL} — skipping DB tests`)

const WS: WorkspaceKey = { landscapeId: 'ws-qa-flows', versionId: 'v1' }
const dia = (id: string, objectIds: string[]): DiagramInput =>
  ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [] })
const proc = (id: string, name: string, objectId: string): FlowInput =>
  ({ id, name, steps: [{ type: 'process', objectId }] })

suite('flow index — QA additions', () => {
  let client: pg.PoolClient
  afterAll(async () => { await pool!.end() })
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })
  const rows = async (table: string, diagramId: string) => Number((await client.query(
    `SELECT count(*) AS n FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
    [WS.landscapeId, WS.versionId, diagramId],
  )).rows[0].n)

  it('a renamed flow shows its NEW name after re-projection', async () => {
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], [dia('dg', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dg', [proc('f', 'Old', 'A')], true)
    await syncConnectionFlows(client, WS, null, 'dg', [proc('f', 'New', 'A')], true)
    expect((await roEntityFlows(client, WS, 'object', 'A')).flows.map((f) => f.name)).toEqual(['New'])
  })

  it('bounds the page by limit while total stays the full count, ordered by case-insensitive name', async () => {
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], [dia('dg', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dg', [
      proc('a1', 'zeta', 'A'), proc('b1', 'Alpha', 'A'), proc('c1', 'beta', 'A'), proc('d1', 'Gamma', 'A'),
    ], true)
    const all = await roEntityFlows(client, WS, 'object', 'A')
    expect(all.flows.map((f) => f.name)).toEqual(['Alpha', 'beta', 'Gamma', 'zeta'])
    const page = await roEntityFlows(client, WS, 'object', 'A', { limit: 2 })
    expect(page).toMatchObject({ total: 4, complete: true })
    expect(page.flows.map((f) => f.name)).toEqual(['Alpha', 'beta'])
  })

  it('clamps the limit at 100', async () => {
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], [dia('dg', ['A'])])
    const flows = Array.from({ length: 105 }, (_, i) => proc(`f${String(i).padStart(3, '0')}`, `F${i}`, 'A'))
    await syncConnectionFlows(client, WS, null, 'dg', flows, true)
    const result = await roEntityFlows(client, WS, 'object', 'A', { limit: 1000 })
    expect(result.total).toBe(105)
    expect(result.flows).toHaveLength(100)
  })

  it('a connection flow with no ro_flows row (perf seed / static projector without a flows map) still lists, unnamed', async () => {
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
      [{ id: 'c1', fromId: 'A', toId: 'B' }], [], [{ ...dia('dg', ['A', 'B']), connectionIds: ['c1'] }])
    await client.query(
      `INSERT INTO ro_connection_flows (landscape_id, version_id, org_id, diagram_id, flow_id, connection_id)
       VALUES ($1, $2, NULL, 'dg', 'legacy', 'c1')`,
      [WS.landscapeId, WS.versionId],
    )
    // Listed (LEFT JOIN), unnamed — and NOT complete: the diagram has no witness.
    expect(await roEntityFlows(client, WS, 'connection', 'c1'))
      .toEqual({ flows: [{ id: 'legacy', diagramId: 'dg', name: '' }], total: 1, complete: false })
  })

  it('every removal path drops ALL three flow-index tables (no leaked ro_flows rows)', async () => {
    const diagrams = [dia('d1', ['A']), dia('d2', ['A']), dia('d3', ['A'])]
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], diagrams)
    for (const d of diagrams) await syncConnectionFlows(client, WS, null, d.id, [proc(`f-${d.id}`, d.id, 'A')], true)
    for (const d of diagrams) expect(await rows('ro_flows', d.id)).toBe(1)

    await deleteDiagrams(client, WS, ['d1'])
    expect([await rows('ro_flows', 'd1'), await rows('ro_flow_objects', 'd1'), await rows('ro_diagram_flow_index', 'd1')]).toEqual([0, 0, 0])

    await syncDiagrams(client, WS, null, [dia('d3', ['A'])])
    expect([await rows('ro_flows', 'd2'), await rows('ro_flow_objects', 'd2'), await rows('ro_diagram_flow_index', 'd2')]).toEqual([0, 0, 0])
    expect(await rows('ro_flows', 'd3')).toBe(1)

    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], [dia('d3', ['A'])])
    expect([await rows('ro_flows', 'd3'), await rows('ro_flow_objects', 'd3'), await rows('ro_diagram_flow_index', 'd3')]).toEqual([0, 0, 0])
  })

  it('an id-less flow is skipped, not fatal, and blank object ids are not posted', async () => {
    await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }], [], [], [dia('dg', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dg', [
      { name: 'no id', steps: [{ type: 'process', objectId: 'A' }] } as unknown as FlowInput,
      { id: 'f', name: 'F', steps: [{ type: 'process', objectId: '' }, { type: 'process', objectId: 'A' }] },
    ], true)
    expect((await roEntityFlows(client, WS, 'object', 'A')).flows.map((f) => f.id)).toEqual(['f'])
    expect(await roEntityFlows(client, WS, 'object', '')).toMatchObject({ total: 0 })
  })
})

// The schema test needs a schema in which ensureReadModelSchema really CREATES
// the tables (the shared one already has them, so a DDL mutant is invisible there).
const isolated = process.env.TEST_DATABASE_URL
describe.skipIf(!isolated)('flow index schema (isolated schema)', () => {
  it('ro_flow_objects keeps one posting per object of the same flow', async () => {
    const db = await createIsolatedSchemaDb(isolated!, 'qa_flow_index_schema')
    try {
      await ensureReadModelSchema(db.pool)
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await coldBuildReadModel(client, WS, null, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
          [{ id: 'c1', fromId: 'A', toId: 'B' }], [], [{ ...dia('dg', ['A', 'B']), connectionIds: ['c1'] }])
        await syncConnectionFlows(client, WS, null, 'dg', [
          { id: 'm', name: 'M', steps: [{ type: 'message', fromObjectId: 'A', toObjectId: 'B', connectionId: 'c1' }] },
        ], true)
        expect((await roEntityFlows(client, WS, 'object', 'A')).total).toBe(1)
        expect((await roEntityFlows(client, WS, 'object', 'B')).total).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    } finally {
      await db.teardown()
    }
  }, 60_000)
})
