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

import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

type WorkspaceCount =
  | 'object_count'
  | 'connection_count'
  | 'diagram_count'
  | 'decision_record_count'
  | 'group_count'

const COUNT_COLUMNS = new Set<WorkspaceCount>([
  'object_count', 'connection_count', 'diagram_count', 'decision_record_count', 'group_count',
])

function boundedIds(ids?: readonly string[]): string[] | null {
  if (!ids) return null
  return [...new Set(ids.filter(Boolean))]
}

export async function adjustWorkspaceCount(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  column: WorkspaceCount,
  delta: number,
): Promise<void> {
  if (!delta) return
  if (!COUNT_COLUMNS.has(column)) throw new Error(`Unsupported workspace count: ${column}`)
  await db.query(
    `INSERT INTO ro_workspace_stats (landscape_id, version_id, org_id, ${column})
     VALUES ($1, $2, $3, GREATEST(0, $4::bigint))
     ON CONFLICT (landscape_id, version_id) DO UPDATE
     SET org_id = COALESCE(EXCLUDED.org_id, ro_workspace_stats.org_id),
         ${column} = GREATEST(0, ro_workspace_stats.${column} + $4::bigint),
         updated_at = now()`,
    [key.landscapeId, key.versionId, orgId, delta],
  )
}

export async function countExistingIds(
  db: Queryable,
  key: WorkspaceKey,
  table: 'ro_objects' | 'ro_connections' | 'ro_groups' | 'ro_diagrams' | 'ro_decision_records',
  idColumn: 'id' | 'diagram_id',
  ids: readonly string[],
): Promise<number> {
  const uniqueIds = boundedIds(ids) ?? []
  if (!uniqueIds.length) return 0
  const result = await db.query<{ total: string | number }>(
    `SELECT count(*) AS total FROM ${table}
     WHERE landscape_id = $1 AND version_id = $2 AND ${idColumn} = ANY($3::text[])`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return Number(result.rows[0]?.total ?? 0)
}

export async function refreshRootObjectCount(db: Queryable, key: WorkspaceKey): Promise<void> {
  await db.query(
    `INSERT INTO ro_workspace_stats (landscape_id, version_id, org_id, root_object_count)
     SELECT $1, $2, max(org_id), count(*)
     FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2 AND effective_parent_id IS NULL
     ON CONFLICT (landscape_id, version_id) DO UPDATE
     SET root_object_count = EXCLUDED.root_object_count,
         org_id = COALESCE(EXCLUDED.org_id, ro_workspace_stats.org_id), updated_at = now()`,
    [key.landscapeId, key.versionId],
  )
}

export async function adjustRootObjectCount(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  delta: number,
): Promise<void> {
  if (!delta) return
  await db.query(
    `INSERT INTO ro_workspace_stats (landscape_id, version_id, org_id, root_object_count)
     VALUES ($1, $2, $3, GREATEST(0, $4::bigint))
     ON CONFLICT (landscape_id, version_id) DO UPDATE
     SET org_id = COALESCE(EXCLUDED.org_id, ro_workspace_stats.org_id),
         root_object_count = GREATEST(0, ro_workspace_stats.root_object_count + $4::bigint),
         updated_at = now()`,
    [key.landscapeId, key.versionId, orgId, delta],
  )
}

export async function refreshDiagramSummaries(
  db: Queryable,
  key: WorkspaceKey,
  diagramIds?: readonly string[],
): Promise<void> {
  const ids = boundedIds(diagramIds)
  if (ids && !ids.length) return
  const bounded = ids ? 'AND diagram.id = ANY($3::text[])' : ''
  const params: unknown[] = ids
    ? [key.landscapeId, key.versionId, ids]
    : [key.landscapeId, key.versionId]
  if (ids) {
    await db.query(
      `DELETE FROM ro_diagram_summaries summary
       WHERE summary.landscape_id = $1 AND summary.version_id = $2
         AND summary.diagram_id = ANY($3::text[])
         AND NOT EXISTS (
           SELECT 1 FROM ro_diagrams diagram
           WHERE diagram.landscape_id = summary.landscape_id
             AND diagram.version_id = summary.version_id AND diagram.id = summary.diagram_id
         )`,
      params,
    )
  } else {
    await db.query(
      `DELETE FROM ro_diagram_summaries summary
       WHERE summary.landscape_id = $1 AND summary.version_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM ro_diagrams diagram
           WHERE diagram.landscape_id = summary.landscape_id
             AND diagram.version_id = summary.version_id AND diagram.id = summary.diagram_id
         )`,
      params,
    )
  }
  await db.query(
    `INSERT INTO ro_diagram_summaries (
       landscape_id, version_id, org_id, diagram_id, name, type, domain_id,
       parent_object_id, object_count, connection_count, group_count,
       preview_object_ids, preview_object_types, data
     )
     SELECT diagram.landscape_id, diagram.version_id, diagram.org_id, diagram.id,
            COALESCE(diagram.data->>'name', ''), COALESCE(diagram.data->>'type', ''),
            NULLIF(diagram.data->>'domainId', ''), diagram.parent_object_id,
            (SELECT count(*)::integer FROM ro_diagram_objects member
             WHERE member.landscape_id = diagram.landscape_id
               AND member.version_id = diagram.version_id AND member.diagram_id = diagram.id),
            (SELECT count(*)::integer FROM ro_diagram_connections member
             WHERE member.landscape_id = diagram.landscape_id
               AND member.version_id = diagram.version_id AND member.diagram_id = diagram.id),
            (SELECT count(*)::integer FROM ro_diagram_groups member
             WHERE member.landscape_id = diagram.landscape_id
               AND member.version_id = diagram.version_id AND member.diagram_id = diagram.id),
            COALESCE(preview.object_ids, '{}'::text[]), COALESCE(preview.object_types, '{}'::text[]),
            diagram.data - 'layouts' - 'comments' - 'flows' - 'checkpoints'
                         - 'objectIds' - 'connectionIds' - 'groupIds'
     FROM ro_diagrams diagram
     LEFT JOIN LATERAL (
       SELECT array_agg(member.object_id ORDER BY member.object_id) AS object_ids,
              array_agg(COALESCE(object.type, '') ORDER BY member.object_id) AS object_types
       FROM (
         SELECT item.object_id FROM ro_diagram_objects item
         WHERE item.landscape_id = diagram.landscape_id
           AND item.version_id = diagram.version_id AND item.diagram_id = diagram.id
         ORDER BY item.object_id LIMIT 12
       ) member
       LEFT JOIN ro_objects object ON object.landscape_id = diagram.landscape_id
         AND object.version_id = diagram.version_id AND object.id = member.object_id
     ) preview ON true
     WHERE diagram.landscape_id = $1 AND diagram.version_id = $2 ${bounded}
     ON CONFLICT (landscape_id, version_id, diagram_id) DO UPDATE SET
       org_id = EXCLUDED.org_id, name = EXCLUDED.name, type = EXCLUDED.type,
       domain_id = EXCLUDED.domain_id, parent_object_id = EXCLUDED.parent_object_id,
       object_count = EXCLUDED.object_count, connection_count = EXCLUDED.connection_count,
       group_count = EXCLUDED.group_count, preview_object_ids = EXCLUDED.preview_object_ids,
       preview_object_types = EXCLUDED.preview_object_types, data = EXCLUDED.data`,
    params,
  )
}

export async function refreshConnectionStats(
  db: Queryable,
  key: WorkspaceKey,
  connectionIds?: readonly string[],
): Promise<void> {
  const ids = boundedIds(connectionIds)
  if (ids && !ids.length) return
  const bounded = ids ? 'AND connection.id = ANY($3::text[])' : ''
  const params: unknown[] = ids
    ? [key.landscapeId, key.versionId, ids]
    : [key.landscapeId, key.versionId]
  const countColumns = ids
    ? `(SELECT count(*)::integer FROM ro_diagram_connections member
             WHERE member.landscape_id = connection.landscape_id
               AND member.version_id = connection.version_id AND member.connection_id = connection.id),
            (SELECT count(DISTINCT (member.diagram_id, member.flow_id))::integer
             FROM ro_connection_flows member
             WHERE member.landscape_id = connection.landscape_id
               AND member.version_id = connection.version_id AND member.connection_id = connection.id)`
    : `COALESCE(diagrams.total, 0)::integer, COALESCE(flows.total, 0)::integer`
  const countJoins = ids
    ? ''
    : `LEFT JOIN (
         SELECT connection_id, count(*)::integer AS total
         FROM ro_diagram_connections
         WHERE landscape_id = $1 AND version_id = $2
         GROUP BY connection_id
       ) diagrams ON diagrams.connection_id = connection.id
       LEFT JOIN (
         SELECT connection_id, count(DISTINCT (diagram_id, flow_id))::integer AS total
         FROM ro_connection_flows
         WHERE landscape_id = $1 AND version_id = $2
         GROUP BY connection_id
       ) flows ON flows.connection_id = connection.id`
  await db.query(
    `DELETE FROM ro_connection_stats stat
     WHERE stat.landscape_id = $1 AND stat.version_id = $2
       ${ids ? 'AND stat.connection_id = ANY($3::text[])' : ''}
       AND NOT EXISTS (
         SELECT 1 FROM ro_connections connection
         WHERE connection.landscape_id = stat.landscape_id
           AND connection.version_id = stat.version_id AND connection.id = stat.connection_id
       )`,
    params,
  )
  await db.query(
    `INSERT INTO ro_connection_stats (
       landscape_id, version_id, org_id, connection_id, diagram_count, flow_count,
       from_name, from_icon, from_type, from_domain_id,
       to_name, to_icon, to_type, to_domain_id
     )
     SELECT connection.landscape_id, connection.version_id, connection.org_id, connection.id,
            ${countColumns},
            COALESCE(from_object.name, from_group.name, ''),
            COALESCE(from_object.data->>'icon', from_group.data->>'icon'),
            COALESCE(from_object.type, CASE WHEN from_group.id IS NOT NULL THEN 'group' END),
            COALESCE(from_object.domain_id, from_group.data->>'domainId'),
            COALESCE(to_object.name, to_group.name, ''),
            COALESCE(to_object.data->>'icon', to_group.data->>'icon'),
            COALESCE(to_object.type, CASE WHEN to_group.id IS NOT NULL THEN 'group' END),
            COALESCE(to_object.domain_id, to_group.data->>'domainId')
     FROM ro_connections connection
     LEFT JOIN ro_objects from_object ON from_object.landscape_id = connection.landscape_id
       AND from_object.version_id = connection.version_id AND from_object.id = connection.from_id
     LEFT JOIN ro_groups from_group ON from_group.landscape_id = connection.landscape_id
       AND from_group.version_id = connection.version_id AND from_group.id = connection.from_id
     LEFT JOIN ro_objects to_object ON to_object.landscape_id = connection.landscape_id
       AND to_object.version_id = connection.version_id AND to_object.id = connection.to_id
     LEFT JOIN ro_groups to_group ON to_group.landscape_id = connection.landscape_id
       AND to_group.version_id = connection.version_id AND to_group.id = connection.to_id
     ${countJoins}
     WHERE connection.landscape_id = $1 AND connection.version_id = $2 ${bounded}
     ON CONFLICT (landscape_id, version_id, connection_id) DO UPDATE SET
       org_id = EXCLUDED.org_id, diagram_count = EXCLUDED.diagram_count,
       flow_count = EXCLUDED.flow_count, from_name = EXCLUDED.from_name,
       from_icon = EXCLUDED.from_icon, from_type = EXCLUDED.from_type,
       from_domain_id = EXCLUDED.from_domain_id, to_name = EXCLUDED.to_name,
       to_icon = EXCLUDED.to_icon, to_type = EXCLUDED.to_type,
       to_domain_id = EXCLUDED.to_domain_id`,
    params,
  )
}

export async function refreshConnectionStatsForEndpoints(
  db: Queryable,
  key: WorkspaceKey,
  endpointIds: readonly string[],
): Promise<void> {
  const ids = boundedIds(endpointIds) ?? []
  if (!ids.length) return
  const result = await db.query<{ id: string }>(
    `SELECT id FROM ro_connections
     WHERE landscape_id = $1 AND version_id = $2
       AND (from_id = ANY($3::text[]) OR to_id = ANY($3::text[]))`,
    [key.landscapeId, key.versionId, ids],
  )
  await refreshConnectionStats(db, key, result.rows.map((row) => row.id))
}

export async function refreshObjectChildStats(
  db: Queryable,
  key: WorkspaceKey,
  objectIds?: readonly string[],
): Promise<void> {
  const ids = boundedIds(objectIds)
  if (ids && !ids.length) return
  const params: unknown[] = ids
    ? [key.landscapeId, key.versionId, ids]
    : [key.landscapeId, key.versionId]
  await db.query(
    `DELETE FROM ro_object_child_stats
     WHERE landscape_id = $1 AND version_id = $2
       ${ids ? 'AND object_id = ANY($3::text[])' : ''}`,
    params,
  )
  await db.query(
    `INSERT INTO ro_object_child_stats (landscape_id, version_id, org_id, object_id, child_count)
     SELECT child.landscape_id, child.version_id, max(child.org_id),
            child.effective_parent_id, count(*)::integer
     FROM ro_objects child
     WHERE child.landscape_id = $1 AND child.version_id = $2
       AND child.effective_parent_id IS NOT NULL
       ${ids ? 'AND child.effective_parent_id = ANY($3::text[])' : ''}
     GROUP BY child.landscape_id, child.version_id, child.effective_parent_id`,
    params,
  )
}

export async function rebuildWorkspaceStats(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO ro_workspace_stats (
       landscape_id, version_id, org_id, object_count, connection_count,
       diagram_count, decision_record_count, group_count, root_object_count, updated_at
     ) VALUES (
       $1, $2, $3,
       (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2),
       (SELECT count(*) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2),
       (SELECT count(*) FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2),
       (SELECT count(*) FROM ro_decision_records WHERE landscape_id = $1 AND version_id = $2),
       (SELECT count(*) FROM ro_groups WHERE landscape_id = $1 AND version_id = $2),
       (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2
          AND effective_parent_id IS NULL), now()
     )
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, ro_workspace_stats.org_id),
       object_count = EXCLUDED.object_count, connection_count = EXCLUDED.connection_count,
       diagram_count = EXCLUDED.diagram_count,
       decision_record_count = EXCLUDED.decision_record_count,
       group_count = EXCLUDED.group_count, root_object_count = EXCLUDED.root_object_count,
       updated_at = now()`,
    [key.landscapeId, key.versionId, orgId],
  )
}

export async function rebuildReadModelDerivedStats(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null = null,
): Promise<void> {
  // A cold build/full sync may have inserted hundreds of thousands of source
  // rows in the current transaction. Give PostgreSQL real cardinalities before
  // planning the bulk aggregate joins; without this, the default estimates can
  // turn a 30k-row rebuild into a multi-minute nested-loop plan.
  await db.query(`ANALYZE ro_objects, ro_connections, ro_groups, ro_diagrams,
    ro_diagram_objects, ro_diagram_groups, ro_diagram_connections, ro_connection_flows`)
  const params = [key.landscapeId, key.versionId]
  await db.query(`DELETE FROM ro_diagram_summaries WHERE landscape_id = $1 AND version_id = $2`, params)
  await db.query(`DELETE FROM ro_connection_stats WHERE landscape_id = $1 AND version_id = $2`, params)
  await db.query(`DELETE FROM ro_object_child_stats WHERE landscape_id = $1 AND version_id = $2`, params)
  await refreshDiagramSummaries(db, key)
  await refreshConnectionStats(db, key)
  await refreshObjectChildStats(db, key)
  await rebuildWorkspaceStats(db, key, orgId)
}

export async function upsertDecisionRecords(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  records: readonly object[],
): Promise<void> {
  const rows = records
    .map((record) => ({ record, value: record as {
      id?: unknown
      title?: unknown
      status?: unknown
      createdAt?: unknown
      updatedAt?: unknown
      number?: unknown
    } }))
    .filter(({ value }) => typeof value.id === 'string' && value.id.length > 0)
    .map(({ record, value }) => ({
      id: value.id as string,
      title: typeof value.title === 'string' ? value.title : '',
      status: typeof value.status === 'string' ? value.status : '',
      created_at: typeof value.createdAt === 'string' ? value.createdAt : '',
      updated_at: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      adr_number: typeof value.number === 'number' && Number.isFinite(value.number) ? Math.floor(value.number) : null,
      data: record,
    }))
  if (!rows.length) return
  const existing = await countExistingIds(db, key, 'ro_decision_records', 'id', rows.map((row) => row.id))
  await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($4::jsonb)
         AS x(id text, title text, status text, created_at text, updated_at text, adr_number integer, data jsonb)
     )
     INSERT INTO ro_decision_records (
       landscape_id, version_id, org_id, id, title, status,
       created_at, updated_at, adr_number, data
     )
     SELECT $1, $2, $3, id, title, status, created_at, updated_at, adr_number, data FROM input
     ON CONFLICT (landscape_id, version_id, id) DO UPDATE SET
       org_id = EXCLUDED.org_id, title = EXCLUDED.title,
       status = EXCLUDED.status, created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at, adr_number = EXCLUDED.adr_number,
       data = EXCLUDED.data`,
    [key.landscapeId, key.versionId, orgId, JSON.stringify(rows)],
  )
  await adjustWorkspaceCount(db, key, orgId, 'decision_record_count', rows.length - existing)
}

export async function deleteDecisionRecords(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  ids: readonly string[],
): Promise<void> {
  const uniqueIds = boundedIds(ids) ?? []
  if (!uniqueIds.length) return
  const result = await db.query(
    `DELETE FROM ro_decision_records
     WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  await adjustWorkspaceCount(db, key, orgId, 'decision_record_count', -(result.rowCount ?? 0))
}
