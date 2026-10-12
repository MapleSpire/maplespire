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

import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { pool } from '../src/db.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')
  const key = [landscapeId, versionId]
  const counts = await pool.query<{
    adrs: string
    diagrams: string
    objects: string
    connections: string
    allowed_documents: string
    shape_appearances: string
    diagram_connection_memberships: string
    performance_users: string
    performance_teams: string
  }>(
    `SELECT
       (SELECT count(*) FROM ro_decision_records WHERE landscape_id=$1 AND version_id=$2) AS adrs,
       (SELECT count(*) FROM ro_diagrams WHERE landscape_id=$1 AND version_id=$2) AS diagrams,
       (SELECT count(*) FROM ro_objects WHERE landscape_id=$1 AND version_id=$2) AS objects,
       (SELECT count(*) FROM ro_connections WHERE landscape_id=$1 AND version_id=$2) AS connections,
       (SELECT count(*) FROM read_model_static_documents WHERE landscape_id=$1 AND version_id=$2) AS allowed_documents,
       (SELECT count(*) FROM ro_diagram_objects WHERE landscape_id=$1 AND version_id=$2) AS shape_appearances,
       (SELECT count(*) FROM ro_diagram_connections WHERE landscape_id=$1 AND version_id=$2) AS diagram_connection_memberships,
       (SELECT count(*) FROM users user_account
          JOIN org_members membership ON membership.user_id = user_account.id
         WHERE membership.org_id = (
           SELECT org_id FROM landscapes WHERE id = $1
         ) AND user_account.issuer = 'performance-seed') AS performance_users,
       (SELECT count(*) FROM teams team
         WHERE team.org_id = (SELECT org_id FROM landscapes WHERE id = $1)
           AND team.name LIKE 'Performance / %') AS performance_teams`,
    key,
  )
  const samples = await pool.query<{
    id: string
    layouts: number
    comments: number
    flows: number
    has_doc_url: boolean
  }>(
    `SELECT id,
       (SELECT count(*) FROM jsonb_object_keys(data->'layouts')) AS layouts,
       (SELECT count(*) FROM jsonb_object_keys(data->'comments')) AS comments,
       (SELECT count(*) FROM jsonb_object_keys(data->'flows')) AS flows,
       data->>'docUrl' IS NOT NULL AS has_doc_url
     FROM ro_diagrams
     WHERE landscape_id=$1 AND version_id=$2
       AND id IN ('perf-dg-000000', 'perf-dg-027000')
     ORDER BY id`,
    key,
  )
  const buckets = await pool.query<{ shape_count: number; diagrams: string }>(
    `SELECT (data->>'shapeCount')::integer AS shape_count, count(*) AS diagrams
     FROM ro_diagrams
     WHERE landscape_id=$1 AND version_id=$2
     GROUP BY (data->>'shapeCount')::integer
     ORDER BY shape_count`,
    key,
  )
  const version = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id=$1 AND id=$2',
    key,
  )
  const rootUrl = version.rows[0]?.root_url
  if (!rootUrl || !isValidAutomergeUrl(rootUrl)) throw new Error('performance root is unavailable')
  const repo = new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [] })
  const root = await repo.find<{ modelMetaUrl?: string }>(rootUrl as AutomergeUrl)
  await root.whenReady()
  const modelMetaUrl = root.doc()?.modelMetaUrl
  if (!modelMetaUrl || !isValidAutomergeUrl(modelMetaUrl)) throw new Error('performance control metadata is unavailable')
  const meta = await repo.find<{
    staticBaseline?: boolean
    objectShardUrls?: string[]
    connectionShardUrls?: string[]
    decisionRecordShardUrls?: string[]
    editsObjectShardUrl?: string
    editsConnectionShardUrl?: string
  }>(modelMetaUrl as AutomergeUrl)
  await meta.whenReady()
  const control = meta.doc()
  if (!control?.staticBaseline) throw new Error('performance metadata is not bounded to static baseline mode')
  if ((control.objectShardUrls?.length ?? 0) > 64 || (control.connectionShardUrls?.length ?? 0) > 64) {
    throw new Error('performance metadata contains an unbounded overlay history')
  }
  if ((control.decisionRecordShardUrls?.length ?? 0) !== 0) {
    throw new Error('performance metadata still contains immutable ADR shard routes')
  }
  const objectHead = control.editsObjectShardUrl && isValidAutomergeUrl(control.editsObjectShardUrl)
    ? await repo.find<{ objects?: Record<string, unknown>; writeBatchIds?: string[]; writeHeadVersion?: number }>(control.editsObjectShardUrl as AutomergeUrl)
    : null
  const connectionHead = control.editsConnectionShardUrl && isValidAutomergeUrl(control.editsConnectionShardUrl)
    ? await repo.find<{ connections?: Record<string, unknown>; writeBatchIds?: string[]; writeHeadVersion?: number }>(control.editsConnectionShardUrl as AutomergeUrl)
    : null
  await Promise.all([objectHead?.whenReady(), connectionHead?.whenReady()])
  await repo.shutdown()
  console.log(JSON.stringify({
    counts: counts.rows[0],
    buckets: buckets.rows,
    samples: samples.rows,
    control: {
      modelMetaUrl,
      objectOverlaySegments: control.objectShardUrls?.length ?? 0,
      connectionOverlaySegments: control.connectionShardUrls?.length ?? 0,
      sampleHistoricalObjectSegment: control.objectShardUrls?.find((url) => url !== control.editsObjectShardUrl),
      sampleHistoricalConnectionSegment: control.connectionShardUrls?.find((url) => url !== control.editsConnectionShardUrl),
      editsObjectShardUrl: control.editsObjectShardUrl,
      editsConnectionShardUrl: control.editsConnectionShardUrl,
      objectWriteHead: objectHead ? {
        state: objectHead.state,
        entries: Object.keys(objectHead.doc()?.objects ?? {}).length,
        batches: objectHead.doc()?.writeBatchIds?.length ?? 0,
        version: objectHead.doc()?.writeHeadVersion ?? null,
      } : null,
      connectionWriteHead: connectionHead ? {
        state: connectionHead.state,
        entries: Object.keys(connectionHead.doc()?.connections ?? {}).length,
        batches: connectionHead.doc()?.writeBatchIds?.length ?? 0,
        version: connectionHead.doc()?.writeHeadVersion ?? null,
      } : null,
    },
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-verify] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
