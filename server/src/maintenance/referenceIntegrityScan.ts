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

import type { Queryable } from '../readModel/types.js'
import {
  SQL_CHECKED_KINDS as CHECKED,
  UNCHECKED_KINDS as UNCHECKED,
  classifyReferenceFinding as classify,
  type ReferenceFinding as Finding,
  type SqlReferenceKind,
} from './referenceFindings.js'

/**
 * Find cross-entity references whose target no longer exists.
 *
 * This is the half of the reference-integrity story a client cannot do. A
 * windowed client resolves a miss to `unknown` — it cannot tell "deleted" from
 * "not loaded" (see `src/lib/refs/resolve.ts`), and only a reader that sees the
 * WHOLE collection may promote that to `dangling`. The server read model is that
 * reader.
 *
 * REPORT ONLY. Nothing here mutates. Repair is a separate concern with a
 * separate authorization story, because it writes Automerge documents directly
 * and so bypasses the RBAC write gate.
 *
 * ## What this leg cannot see
 *
 * The scan is meant to be TWO-legged: SQL for what `ro_*` projects, and an
 * Automerge document walk for the rest. Only the SQL leg exists so far, so these
 * references are NOT checked and a clean report does not clear them:
 *
 *   - `Group.parentObjectId` — not a column; `ro_groups` is (id, name) only.
 *     This is the one with a visible symptom (wrapper chrome and a live
 *     "create detail diagram" control anchored to a deleted object).
 *   - `Diagram.skinId` — not projected.
 *   - `Diagram.layouts` / `layouts3d` keys — not projected.
 *   - `Comment.diagramId` and flow-step object/connection refs — there is no
 *     `ro_comments` table at all.
 *
 * `checkedKinds` / `uncheckedKinds` on the result say so explicitly, so a caller
 * can render "0 findings" without implying "0 problems".
 */

export {
  SQL_CHECKED_KINDS,
  UNCHECKED_KINDS as SQL_UNCHECKED_KINDS,
  classifyReferenceFinding,
} from './referenceFindings.js'
export type { ReferenceFinding, ReferenceKind, ReferenceSeverity } from './referenceFindings.js'

export interface ReferenceIntegrityReport {
  reportOnly: true
  scannedAt: string
  workspaces: number
  findings: Finding[]
  /** Findings by kind, including the kinds that found nothing — an explicit zero
   *  is the point of a scan. */
  countsByKind: Record<string, number>
  checkedKinds: readonly string[]
  /** Reference kinds NEITHER leg checks. Never render a clean report without them. */
  uncheckedKinds: readonly string[]
  /** True when the result was cut short by `limit`, so counts are lower bounds. */
  truncated: boolean
}

interface RawFinding extends Record<string, unknown> {
  landscape_id: string
  version_id: string
  source_id: string
  target_id: string
}

interface Check {
  kind: SqlReferenceKind
  field: string
  sql: string
}

/**
 * One query per reference kind.
 *
 * Every query binds `landscape_id`/`version_id` and joins within the workspace —
 * ids are only unique inside one, and `forkRoot` copies ADR shards across
 * versions with ids preserved, so an unscoped join would resolve a reference
 * against a FOREIGN version and silently report health.
 */
const CHECKS: readonly Check[] = [
  {
    kind: 'decisionRecord.related.diagram',
    field: 'related[type=diagram].targetId',
    sql: `
      SELECT rec.landscape_id, rec.version_id, rec.id AS source_id, link->>'targetId' AS target_id
      FROM ro_decision_records rec
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rec.data->'related') = 'array' THEN rec.data->'related' ELSE '[]'::jsonb END
      ) AS link
      WHERE link->>'type' = 'diagram'
        AND coalesce(link->>'targetId', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ro_diagrams d
          WHERE d.landscape_id = rec.landscape_id AND d.version_id = rec.version_id
            AND d.id = link->>'targetId')`,
  },
  {
    kind: 'decisionRecord.related.adr',
    field: 'related[type=adr|draft].targetId',
    sql: `
      SELECT rec.landscape_id, rec.version_id, rec.id AS source_id, link->>'targetId' AS target_id
      FROM ro_decision_records rec
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rec.data->'related') = 'array' THEN rec.data->'related' ELSE '[]'::jsonb END
      ) AS link
      WHERE link->>'type' IN ('adr', 'draft')
        AND coalesce(link->>'targetId', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ro_decision_records other
          WHERE other.landscape_id = rec.landscape_id AND other.version_id = rec.version_id
            AND other.id = link->>'targetId')`,
  },
  {
    kind: 'diagram.parentObjectId',
    field: 'parentObjectId',
    sql: `
      SELECT d.landscape_id, d.version_id, d.id AS source_id, d.parent_object_id AS target_id
      FROM ro_diagrams d
      WHERE d.parent_object_id IS NOT NULL AND d.parent_object_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ro_objects o
          WHERE o.landscape_id = d.landscape_id AND o.version_id = d.version_id
            AND o.id = d.parent_object_id)`,
  },
  {
    kind: 'diagram.groupIds',
    field: 'groupIds',
    sql: `
      SELECT dg.landscape_id, dg.version_id, dg.diagram_id AS source_id, dg.group_id AS target_id
      FROM ro_diagram_groups dg
      WHERE NOT EXISTS (
        SELECT 1 FROM ro_groups g
        WHERE g.landscape_id = dg.landscape_id AND g.version_id = dg.version_id
          AND g.id = dg.group_id)`,
  },
  {
    kind: 'diagram.objectIds',
    field: 'objectIds',
    sql: `
      SELECT dobj.landscape_id, dobj.version_id, dobj.diagram_id AS source_id, dobj.object_id AS target_id
      FROM ro_diagram_objects dobj
      WHERE NOT EXISTS (
        SELECT 1 FROM ro_objects o
        WHERE o.landscape_id = dobj.landscape_id AND o.version_id = dobj.version_id
          AND o.id = dobj.object_id)`,
  },
  {
    kind: 'diagram.connectionIds',
    field: 'connectionIds',
    sql: `
      SELECT dc.landscape_id, dc.version_id, dc.diagram_id AS source_id, dc.connection_id AS target_id
      FROM ro_diagram_connections dc
      WHERE NOT EXISTS (
        SELECT 1 FROM ro_connections c
        WHERE c.landscape_id = dc.landscape_id AND c.version_id = dc.version_id
          AND c.id = dc.connection_id)`,
  },
  {
    kind: 'connection.endpoint',
    field: 'fromId|toId',
    // An endpoint may legitimately be an OBJECT or a GROUP. Checking only
    // ro_objects would report every group-anchored connection as broken, which
    // is how a scan earns its own distrust.
    sql: `
      SELECT c.landscape_id, c.version_id, c.id AS source_id, endpoint.target_id
      FROM ro_connections c
      CROSS JOIN LATERAL (VALUES (c.from_id), (c.to_id)) AS endpoint(target_id)
      WHERE endpoint.target_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ro_objects o
          WHERE o.landscape_id = c.landscape_id AND o.version_id = c.version_id
            AND o.id = endpoint.target_id)
        AND NOT EXISTS (
          SELECT 1 FROM ro_groups g
          WHERE g.landscape_id = c.landscape_id AND g.version_id = c.version_id
            AND g.id = endpoint.target_id)`,
  },
  {
    kind: 'object.parentId',
    field: 'parentId',
    sql: `
      SELECT o.landscape_id, o.version_id, o.id AS source_id, o.parent_id AS target_id
      FROM ro_objects o
      WHERE o.parent_id IS NOT NULL AND o.parent_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ro_objects parent
          WHERE parent.landscape_id = o.landscape_id AND parent.version_id = o.version_id
            AND parent.id = o.parent_id)`,
  },
]

export interface ScanOptions {
  /** Restrict to one workspace. Omit to sweep the whole read model. */
  landscapeId?: string
  versionId?: string
  /** Cap the findings returned per check. A landscape with a systemic break can
   *  produce millions of rows, and a report nobody can load is not a report. */
  limit?: number
  /** Injected so a result is reproducible in tests. */
  now?: () => Date
}

const DEFAULT_LIMIT = 500

export async function scanReferenceIntegrity(
  db: Queryable,
  options: ScanOptions = {},
): Promise<ReferenceIntegrityReport> {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
  const scoped = options.landscapeId !== undefined && options.versionId !== undefined

  const findings: Finding[] = []
  const countsByKind: Record<string, number> = {}
  let truncated = false

  for (const check of CHECKS) {
    const params: unknown[] = []
    let sql = `SELECT * FROM (${check.sql}) AS hits`
    if (scoped) {
      params.push(options.landscapeId, options.versionId)
      sql += ` WHERE hits.landscape_id = $1 AND hits.version_id = $2`
    }
    // limit + 1 so the caller learns the cap was hit rather than reading a
    // truncated list as a complete one.
    sql += ` ORDER BY hits.landscape_id, hits.version_id, hits.source_id, hits.target_id LIMIT ${limit + 1}`

    const { rows } = await db.query<RawFinding>(sql, params)
    const kept = rows.slice(0, limit)
    if (rows.length > limit) truncated = true
    countsByKind[check.kind] = kept.length
    for (const row of kept) {
      findings.push({
        landscapeId: row.landscape_id,
        versionId: row.version_id,
        kind: check.kind,
        field: check.field,
        sourceId: row.source_id,
        targetId: row.target_id,
        ...classify(check.kind),
      })
    }
  }

  const workspaces = new Set(findings.map((f) => `${f.landscapeId}/${f.versionId}`)).size

  return {
    reportOnly: true,
    scannedAt: (options.now?.() ?? new Date()).toISOString(),
    workspaces,
    findings,
    countsByKind,
    checkedKinds: CHECKED,
    uncheckedKinds: UNCHECKED,
    truncated,
  }
}
