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
import type { OverlayCollection } from './overlayHistoryProtocol.js'
// The OTHER two takers of `overlay-rotation:*` live in this file, and they take
// it at TRANSACTION scope while `staticDeltaProjector`'s three take it at
// SESSION scope. Different scope, same key, and the key is what makes them
// exclude each other — so it comes from the same function, never a
// hand-written string.
import { overlayRotationLockHash, overlayRotationLockKey } from './overlayRotationLock.js'
import type { Queryable } from './types.js'

export type OverlayBatchStatus =
  | 'forwarding'
  | 'forwarding_conflict'
  | 'projected'
  | 'forwarded'
  | 'conflict'

export interface OverlayBatchStatusRow {
  batchId: string
  status: OverlayBatchStatus
  documentId: string
  updatedAt: string
}

export interface OverlayConflictInput {
  entityId: string
  conflictPaths: string[]
  baseValue: unknown
  historicalValue: unknown
  currentValue: unknown
  forwardedValue: unknown
}

export interface OverlayEntityBase {
  existed: boolean
  data: Record<string, unknown> | undefined
}

const overlayEntityTable = (collection: OverlayCollection) => collection === 'object'
  ? 'ro_objects'
  : 'ro_connections'

/** Capture the immutable value underneath a sparse overlay entry before its
 * first projection. Storage is proportional to edited entities, never to the
 * full static baseline. */
export async function captureOverlayEntityBases(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  entityIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(entityIds.filter(Boolean))]
  if (!ids.length) return
  const table = overlayEntityTable(collection)
  await db.query(
    `INSERT INTO read_model_overlay_entity_bases (
       landscape_id, version_id, collection, document_id, entity_id, data, existed
     )
     SELECT $1, $2, $3, $4, entity.id, current.data, current.id IS NOT NULL
     FROM unnest($5::text[]) AS entity(id)
     LEFT JOIN ${table} current
       ON current.landscape_id = $1
      AND current.version_id = $2
      AND current.id = entity.id
     ON CONFLICT (landscape_id, version_id, collection, document_id, entity_id)
     DO NOTHING`,
    [key.landscapeId, key.versionId, collection, documentId, ids],
  )
}

export async function overlayEntityBases(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  entityIds: readonly string[],
): Promise<Map<string, OverlayEntityBase>> {
  const ids = [...new Set(entityIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const { rows } = await db.query<{
    entity_id: string
    data: Record<string, unknown> | null
    existed: boolean
  }>(
    `SELECT entity_id, data, existed
     FROM read_model_overlay_entity_bases
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
       AND document_id = $4 AND entity_id = ANY($5::text[])`,
    [key.landscapeId, key.versionId, collection, documentId, ids],
  )
  return new Map(rows.map((row) => [row.entity_id, {
    existed: row.existed,
    data: row.existed ? row.data ?? undefined : undefined,
  }]))
}

export const isTerminalOverlayBatchStatus = (status: OverlayBatchStatus) =>
  status === 'projected' || status === 'forwarded' || status === 'conflict'

/**
 * How long a retired overlay segment stays reachable for the GC.
 *
 * ONE constant shared by every user (the defaults here, and in
 * `staticDeltaProjector` the fold's retention refresh and
 * `publishAdmittedRotation`'s demotion of the previous head) — never an inline
 * `interval '30 days'` literal. `forwardHistoricalOverlay`
 * merges an offline client's edits against the retired segment as its
 * three-way base, so a window that disagrees with itself turns "your offline
 * edits were merged" into "your offline edits were dropped".
 */
export const OVERLAY_RETENTION_DAYS = 30

/**
 * Release the retention pin on a rotation child that will never be published.
 *
 * `read_model_overlay_segments.retain_until IS NULL` means RETAINED, not
 * expired — `gc.ts` names it as a reachability root explicitly, because the
 * current head and a freshly rotated child both carry NULL and both must
 * survive the sweep. That is correct while a rotation is in flight. It stops
 * being correct the moment the rotation is marked `superseded`: nothing in the
 * tree ever DELETEs a `read_model_overlay_segments` row, so the abandoned
 * child's segment row is a root that can never expire.
 *
 * Reachable WITHOUT a crash: `recoverAdmittedOverlayRotations` supersedes every
 * admitted rotation whose version is no longer `active`, which is what merging
 * or discarding a Draft does.
 *
 * SCOPE: this does NOT, on its own, make the child collectable. While the workspace still has its
 * `read_model_static_workspaces` row, `gc.ts` marks a static workspace's
 * documents from `automerge_document_workspace UNION
 * read_model_static_documents` — unconditionally, with no retention predicate —
 * and the abandoned child has a row in both by the time it can be superseded.
 * The segment row is ONE of three roots. Releasing it matters after a demotion,
 * when the static branch no longer applies and this root is the one that would
 * otherwise never expire; before that it is necessary and not sufficient.
 *
 * `NOT is_current` is the safety, not a filter: a rotation superseded by a
 * LATER one that already promoted this same document must never have its pin
 * released. `COALESCE` is the other half — a second call cannot shorten a
 * window that is already running.
 */
export function releaseSupersededOverlaySegment(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  retentionDays = OVERLAY_RETENTION_DAYS,
): Promise<unknown> {
  return db.query(
    `UPDATE read_model_overlay_segments
        SET retired_at = COALESCE(retired_at, now()),
            retain_until = COALESCE(retain_until, now() + ($5::int * interval '1 day'))
      WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
        AND document_id = $4 AND NOT is_current`,
    [key.landscapeId, key.versionId, collection, documentId, retentionDays],
  )
}

export async function synchronizeOverlaySegments(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  orderedUrls: readonly string[],
  currentUrl: string | undefined,
  retentionDays = OVERLAY_RETENTION_DAYS,
): Promise<void> {
  // ModelMeta projection can run as a consequence of flushing a server-owned
  // overlay rotation. Serialize both paths on the same advisory key so the
  // projector cannot demote/promote rows while the rotation transaction is
  // publishing its admitted head. Without this lock, two transactions can
  // each try to promote a different row and trip the partial unique index that
  // guarantees a single current segment per workspace/collection.
  const rotationLockKey = overlayRotationLockKey(key.landscapeId, key.versionId, collection)
  await db.query(
    `SELECT pg_advisory_xact_lock(${overlayRotationLockHash()})`,
    [rotationLockKey],
  )
  const documentIdOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]
  const currentId = currentUrl ? documentIdOf(currentUrl) : undefined
  await db.query(
    `UPDATE read_model_overlay_segments
     SET is_current = false,
         retired_at = COALESCE(retired_at, now()),
         retain_until = COALESCE(retain_until, now() + ($4::int * interval '1 day'))
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
       AND is_current`,
    [key.landscapeId, key.versionId, collection, retentionDays],
  )
  if (orderedUrls.length) {
    // Overlay history is intentionally retained for offline clients, so a
    // long-lived enterprise workspace can have hundreds or thousands of
    // segments. Keep ModelMeta projection O(1) database round trips: a
    // per-segment INSERT loop would serialize every history row over the
    // network and stall failover convergence for seconds.
    const segments = orderedUrls.map((url) => ({ documentId: documentIdOf(url), url }))
    await db.query(
      `INSERT INTO read_model_overlay_segments (
         landscape_id, version_id, collection, document_id, segment_url, is_current,
         retired_at, retain_until
       )
       SELECT $2, $3, $4, segment."documentId", segment.url, false,
         now(), now() + ($5::int * interval '1 day')
       FROM jsonb_to_recordset($1::jsonb) AS segment("documentId" text, url text)
       ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE SET
         segment_url = EXCLUDED.segment_url,
         is_current = false,
         retired_at = COALESCE(read_model_overlay_segments.retired_at, now()),
         retain_until = COALESCE(read_model_overlay_segments.retain_until,
           now() + ($5::int * interval '1 day'))`,
      [JSON.stringify(segments), key.landscapeId, key.versionId, collection, retentionDays],
    )
  }
  if (currentId) {
    await db.query(
      `UPDATE read_model_overlay_segments
       SET is_current = true, retired_at = NULL, retain_until = NULL
       WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
         AND document_id = $4`,
      [key.landscapeId, key.versionId, collection, currentId],
    )
  }
}

/** Promote only the current overlay pointer. The admitted-rotation protocol
 * already persisted the child and immutable history row before ModelMeta was
 * published, so a pointer-only projection must not re-upsert the complete
 * retained history. */
export async function synchronizeOverlayHead(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  currentUrl: string | undefined,
  retentionDays = OVERLAY_RETENTION_DAYS,
): Promise<void> {
  const rotationLockKey = overlayRotationLockKey(key.landscapeId, key.versionId, collection)
  await db.query(
    `SELECT pg_advisory_xact_lock(${overlayRotationLockHash()})`,
    [rotationLockKey],
  )
  const currentId = currentUrl
    ? currentUrl.replace(/^automerge:/, '').split('?')[0]
    : undefined
  await db.query(
    `UPDATE read_model_overlay_segments
     SET is_current = false,
         retired_at = COALESCE(retired_at, now()),
         retain_until = COALESCE(retain_until, now() + ($5::int * interval '1 day'))
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
       AND is_current AND ($4::text IS NULL OR document_id <> $4)`,
    [key.landscapeId, key.versionId, collection, currentId ?? null, retentionDays],
  )
  if (!currentId || !currentUrl) return
  await db.query(
    `INSERT INTO read_model_overlay_segments (
       landscape_id, version_id, collection, document_id, segment_url,
       is_current, retired_at, retain_until
     ) VALUES ($1, $2, $3, $4, $5, true, NULL, NULL)
     ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE SET
       segment_url = EXCLUDED.segment_url,
       is_current = true,
       retired_at = NULL,
       retain_until = NULL`,
    [key.landscapeId, key.versionId, collection, currentId, currentUrl],
  )
}

export function recordOverlaySegmentProjection(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  sourceRevision: number,
  snapshot: Record<string, unknown>,
): Promise<unknown> {
  return db.query(
    `INSERT INTO read_model_overlay_segments (
       landscape_id, version_id, collection, document_id, segment_url,
       last_projected_revision, last_projected_snapshot
     ) VALUES ($1, $2, $3, $4, 'automerge:' || $4, $5, $6::jsonb)
     ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE SET
       last_projected_revision = GREATEST(
         read_model_overlay_segments.last_projected_revision,
         EXCLUDED.last_projected_revision
       ),
       last_projected_snapshot = CASE
         WHEN EXCLUDED.last_projected_revision >= read_model_overlay_segments.last_projected_revision
         THEN EXCLUDED.last_projected_snapshot
         ELSE read_model_overlay_segments.last_projected_snapshot END`,
    [key.landscapeId, key.versionId, collection, documentId, sourceRevision, JSON.stringify(snapshot)],
  )
}

export async function overlaySegmentBase(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query<{ last_projected_snapshot: Record<string, unknown> }>(
    `SELECT last_projected_snapshot FROM read_model_overlay_segments
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4`,
    [key.landscapeId, key.versionId, collection, documentId],
  )
  return rows[0]?.last_projected_snapshot
}

export async function overlaySegmentSnapshots(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (!documentIds.length) return new Map()
  const { rows } = await db.query<{
    document_id: string
    last_projected_snapshot: Record<string, unknown> | null
  }>(
    `SELECT document_id, last_projected_snapshot
     FROM read_model_overlay_segments
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
       AND document_id = ANY($4::text[])
       AND last_projected_snapshot IS NOT NULL`,
    [key.landscapeId, key.versionId, collection, [...new Set(documentIds)]],
  )
  return new Map(rows.map((row) => [row.document_id, row.last_projected_snapshot ?? {}]))
}

export async function overlayDocumentProjectionCheckpoint(
  db: Queryable,
  key: WorkspaceKey,
  documentId: string,
): Promise<{ revision: number; projectedRevision: number }> {
  const { rows } = await db.query<{ revision: string | number; projected_revision: string | number }>(
    `SELECT revision, projected_revision FROM read_model_static_document_queue
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [key.landscapeId, key.versionId, documentId],
  )
  return {
    revision: Number(rows[0]?.revision ?? 0),
    projectedRevision: Number(rows[0]?.projected_revision ?? 0),
  }
}

export function acknowledgeOverlayBatches(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  batchIds: readonly string[],
  status: OverlayBatchStatus,
  sourceRevision: number,
  projectedGeneration: number,
): Promise<unknown> {
  if (!batchIds.length) return Promise.resolve()
  return db.query(
    `INSERT INTO read_model_overlay_batch_acks (
       landscape_id, version_id, batch_id, document_id, collection, status,
       source_revision, projected_generation, updated_at
     ) SELECT $1, $2, batch_id, $3, $4, $5, $6, $7, now()
       FROM unnest($8::text[]) AS batch_id
     ON CONFLICT (landscape_id, version_id, batch_id) DO UPDATE SET
       document_id = EXCLUDED.document_id,
       collection = EXCLUDED.collection,
       status = CASE
         WHEN read_model_overlay_batch_acks.status = 'conflict' THEN 'conflict'
        WHEN read_model_overlay_batch_acks.status = 'forwarding'
          AND EXCLUDED.status = 'projected' THEN 'forwarded'
        WHEN read_model_overlay_batch_acks.status = 'forwarding_conflict'
          AND EXCLUDED.status = 'projected' THEN 'conflict'
        WHEN read_model_overlay_batch_acks.status IN ('projected', 'forwarded')
          AND EXCLUDED.status IN ('forwarding', 'forwarding_conflict')
          THEN read_model_overlay_batch_acks.status
         ELSE EXCLUDED.status END,
       source_revision = GREATEST(read_model_overlay_batch_acks.source_revision, EXCLUDED.source_revision),
       projected_generation = GREATEST(
         read_model_overlay_batch_acks.projected_generation,
         EXCLUDED.projected_generation
       ),
       updated_at = now()`,
    [
      key.landscapeId, key.versionId, documentId, collection, status,
      sourceRevision, projectedGeneration, [...new Set(batchIds)],
    ],
  )
}

export async function overlayBatchStatuses(
  db: Queryable,
  key: WorkspaceKey,
  batchIds: readonly string[],
): Promise<OverlayBatchStatusRow[]> {
  if (!batchIds.length) return []
  const { rows } = await db.query<{
    batch_id: string
    status: OverlayBatchStatus
    document_id: string
    updated_at: Date | string
  }>(
    `SELECT batch_id, status, document_id, updated_at
     FROM read_model_overlay_batch_acks
     WHERE landscape_id = $1 AND version_id = $2 AND batch_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, [...new Set(batchIds)]],
  )
  return rows.map((row) => ({
    batchId: row.batch_id,
    status: row.status,
    documentId: row.document_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  }))
}

export async function pendingOverlayBatchIds(
  db: Queryable,
  key: WorkspaceKey,
  batchIds: readonly string[],
): Promise<string[]> {
  const statuses = new Map((await overlayBatchStatuses(db, key, batchIds)).map((row) => [row.batchId, row.status]))
  return [...new Set(batchIds)].filter((batchId) => {
    const status = statuses.get(batchId)
    return !status || !isTerminalOverlayBatchStatus(status)
  })
}

export async function recordOverlayConflicts(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  historicalDocumentId: string,
  currentDocumentId: string,
  batchIds: readonly string[],
  conflicts: readonly OverlayConflictInput[],
): Promise<void> {
  for (const conflict of conflicts) {
    await db.query(
      `INSERT INTO read_model_overlay_conflicts (
         landscape_id, version_id, collection, entity_id,
         historical_document_id, current_document_id, batch_ids, conflict_paths,
         base_value, historical_value, current_value, forwarded_value
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
       ON CONFLICT (landscape_id, version_id, collection, entity_id,
         historical_document_id, current_document_id) WHERE status = 'open'
       DO UPDATE SET
         batch_ids = ARRAY(SELECT DISTINCT unnest(read_model_overlay_conflicts.batch_ids || EXCLUDED.batch_ids)),
         conflict_paths = ARRAY(SELECT DISTINCT unnest(read_model_overlay_conflicts.conflict_paths || EXCLUDED.conflict_paths)),
         historical_value = EXCLUDED.historical_value,
         current_value = EXCLUDED.current_value,
         forwarded_value = EXCLUDED.forwarded_value`,
      [
        key.landscapeId, key.versionId, collection, conflict.entityId,
        historicalDocumentId, currentDocumentId, [...new Set(batchIds)], conflict.conflictPaths,
        JSON.stringify(conflict.baseValue ?? null), JSON.stringify(conflict.historicalValue ?? null),
        JSON.stringify(conflict.currentValue ?? null), JSON.stringify(conflict.forwardedValue ?? null),
      ],
    )
  }
}
