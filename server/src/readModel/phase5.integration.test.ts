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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import { coldBuildReadModel, syncConnectionFlows, upsertObjects } from './projector.js'
import { upsertDecisionRecords } from './derivedStats.js'
import { roDiagramListPage } from './diagramList.js'
import { roConnectionExplorerPage } from './connectionExplorer.js'
import { roDecisionRecordPage } from './decisionRecords.js'
import { roViewerLevel } from './viewerLevel.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
const suite = connectionString ? describe.sequential : describe.skip

suite('Phase-5 derived read model (isolated PostgreSQL)', () => {
  const schema = 'test_read_model_phase5'
  let pool: pg.Pool

  beforeAll(async () => {
    const admin = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1 }), 'phase5:admin')
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.end()
    pool = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1 }), 'phase5:pool')
    await pool.query(`SET search_path TO ${schema}`)
    await ensureReadModelSchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    const admin = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1 }), 'phase5:admin')
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })

  it('backfills a Phase-4 workspace once and makes later schema ensures O(1)', async () => {
    const key = ['migration-workspace', 'v1']
    await pool.query(`
      ALTER TABLE ro_decision_records DROP COLUMN search_document;
      ALTER TABLE ro_decision_records DROP COLUMN normalized_title;
      ALTER TABLE ro_decision_records DROP COLUMN adr_number;
      ALTER TABLE ro_decision_records DROP COLUMN updated_at;
      ALTER TABLE ro_decision_records DROP COLUMN created_at;
      ALTER TABLE ro_decision_records DROP COLUMN status;
      ALTER TABLE ro_decision_records DROP COLUMN title;
    `)
    await pool.query(
      `INSERT INTO ro_objects (
         landscape_id, version_id, org_id, id, type, name, description,
         technology, effective_parent_id, data
       ) VALUES ($1, $2, 'org', 'o1', 'app', 'API', '', '', NULL,
                 '{"id":"o1","name":"API","type":"app"}')`,
      key,
    )
    await pool.query(
      `INSERT INTO ro_connections (
         landscape_id, version_id, org_id, id, from_id, to_id, label, data
       ) VALUES ($1, $2, 'org', 'c1', 'o1', 'o1', 'loop',
                 '{"id":"c1","fromId":"o1","toId":"o1","label":"loop"}')`,
      key,
    )
    await pool.query(
      `INSERT INTO ro_diagrams (
         landscape_id, version_id, org_id, id, object_ids, data
       ) VALUES ($1, $2, 'org', 'd1', ARRAY['o1'],
                 '{"id":"d1","name":"Context","type":"context","objectIds":["o1"],"connectionIds":["c1"],"groupIds":[]}')`,
      key,
    )
    await pool.query(
      `INSERT INTO ro_diagram_objects VALUES ($1, $2, 'org', 'd1', 'o1')`,
      key,
    )
    await pool.query(
      `INSERT INTO ro_diagram_connections VALUES ($1, $2, 'org', 'd1', 'c1')`,
      key,
    )
    await pool.query(
      `INSERT INTO ro_decision_records (landscape_id, version_id, org_id, id, data)
       VALUES ($1, $2, 'org', 'adr-1',
         '{"id":"adr-1","number":1,"title":"Use events","status":"approved","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z"}')`,
      key,
    )
    await pool.query(`DELETE FROM read_model_schema_migrations WHERE name = 'phase5-derived-read-model-v1'`)
    await ensureReadModelSchema(pool)

    const connectionNameIndex = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'idx_ro_connections_name_c_page'`,
    )
    expect(connectionNameIndex.rows[0]?.indexdef).toContain('normalized_label COLLATE "C"')
    expect(connectionNameIndex.rows[0]?.indexdef).toContain('id COLLATE "C"')

    const summary = await pool.query<{
      object_count: number
      connection_count: number
      name: string
    }>(`SELECT object_count, connection_count, name FROM ro_diagram_summaries
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'd1'`, key)
    expect(summary.rows[0]).toEqual({ object_count: 1, connection_count: 1, name: 'Context' })
    const stats = await pool.query<{ from_name: string; diagram_count: number }>(
      `SELECT from_name, diagram_count FROM ro_connection_stats
       WHERE landscape_id = $1 AND version_id = $2 AND connection_id = 'c1'`, key,
    )
    expect(stats.rows[0]).toEqual({ from_name: 'API', diagram_count: 1 })
    const adr = await pool.query<{ title: string; status: string; created_at: string }>(
      `SELECT title, status, created_at FROM ro_decision_records
       WHERE landscape_id = $1 AND version_id = $2 AND id = 'adr-1'`, key,
    )
    expect(adr.rows[0]).toEqual({
      title: 'Use events', status: 'approved', created_at: '2026-01-01T00:00:00.000Z',
    })

    await pool.query(
      `UPDATE ro_diagram_summaries SET name = 'migration-sentinel'
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'd1'`, key,
    )
    await ensureReadModelSchema(pool)
    const secondEnsure = await pool.query<{ name: string }>(
      `SELECT name FROM ro_diagram_summaries
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = 'd1'`, key,
    )
    expect(secondEnsure.rows[0]?.name).toBe('migration-sentinel')
  }, 60_000)

  it('keeps cursor pages disjoint and derived counts/endpoints current after edits', async () => {
    const key = { landscapeId: 'phase5-live', versionId: 'v1' }
    await coldBuildReadModel(
      pool,
      key,
      'org',
      [
        { id: 'A', name: 'API', type: 'app' },
        { id: 'B', name: 'Worker', type: 'app' },
        { id: 'C', name: 'Component', type: 'component', parentId: 'A' },
      ],
      [
        { id: 'c1', fromId: 'A', toId: 'B', label: 'Calls' },
        { id: 'c2', fromId: 'G', toId: 'A', label: 'Routes' },
      ],
      [{ id: 'G', name: 'Runtime group', domainId: 'domain-g', objectIds: ['B'] }],
      [
        { id: 'd1', name: 'Alpha', type: 'context', objectIds: ['A', 'B'], connectionIds: ['c1'] },
        { id: 'd2', name: 'Beta', type: 'container', objectIds: ['A', 'C'], connectionIds: ['c1'] },
      ],
    )
    await syncConnectionFlows(pool, key, 'org', 'd1', [
      { id: 'flow-1', steps: [{ connectionId: 'c1' }] },
    ], true)
    await upsertDecisionRecords(pool, key, 'org', [
      { id: 'adr-old', title: 'Old', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'adr-new', title: 'New', status: 'proposed', createdAt: '2026-02-01T00:00:00.000Z' },
    ])

    const first = await roDiagramListPage(pool, key, { limit: 1 })
    const second = await roDiagramListPage(pool, key, { limit: 1, after: first.nextCursor })
    expect(first.items.map((item) => item.id)).toEqual(['d1'])
    expect(second.items.map((item) => item.id)).toEqual(['d2'])
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2)
    expect(first.items[0]).toMatchObject({ objectCount: 2, connectionCount: 1 })

    const connections = await roConnectionExplorerPage(pool, key, {
      sortBy: 'sender', limit: 10,
    })
    expect(connections.items[0]).toMatchObject({
      fromName: 'API', toName: 'Worker', diagramCount: 2, flowCount: 1,
    })
    const groupDomainConnections = await roConnectionExplorerPage(pool, key, {
      domainId: 'domain-g', sortBy: 'sender', limit: 10,
    })
    expect(groupDomainConnections.items).toEqual([
      expect.objectContaining({ fromName: 'Runtime group', toName: 'API' }),
    ])
    const viewerRoot = await roViewerLevel(pool, key, { limit: 10 })
    expect(viewerRoot.objects.map((item) => item.object.id)).toEqual(['A'])
    expect(viewerRoot.objects[0]?.childCount).toBe(1)
    const groupLevel = await roViewerLevel(pool, key, { parentId: 'G', limit: 10 })
    expect(groupLevel.totalObjects).toBe(1)
    expect(groupLevel.objects[0]?.object.id).toBe('B')

    const decisions = await roDecisionRecordPage(pool, key, { limit: 1 })
    const olderDecisions = await roDecisionRecordPage(pool, key, {
      limit: 1, after: decisions.nextCursor,
    })
    expect(decisions.items[0]?.id).toBe('adr-new')
    expect(olderDecisions.items[0]?.id).toBe('adr-old')

    await upsertObjects(pool, key, 'org', [{ id: 'A', name: 'Gateway', type: 'app' }])
    const renamed = await roConnectionExplorerPage(pool, key, { sortBy: 'sender', limit: 10 })
    expect(renamed.items[0]?.fromName).toBe('Gateway')
    const workspace = await pool.query<{
      object_count: string
      connection_count: string
      diagram_count: string
      decision_record_count: string
      root_object_count: string
    }>(`SELECT object_count, connection_count, diagram_count,
              decision_record_count, root_object_count
       FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId])
    expect(workspace.rows[0]).toMatchObject({
      object_count: '3', connection_count: '2', diagram_count: '2',
      decision_record_count: '2', root_object_count: '1',
    })
  }, 60_000)
})
