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

/**
 * Replace a static performance workspace's oversized ModelMeta history with a
 * bounded control document. Stop the API before running this migration.
 */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import {
  materializeAcknowledgedOverlayState,
  pruneCoveredPerformanceOverlayHistory,
  toPerformanceControlMeta,
  type PerformanceControlMetaInput,
} from '../src/performanceSeed/controlMeta.js'

const isQualificationObjectId = (id: string): boolean => (
  /^qa-[a-z0-9]+-\d+-[A-Za-z0-9_-]{1,10}-\d+$/.test(id)
)

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  if (process.env.PERFORMANCE_SEED !== 'on') throw new Error('PERFORMANCE_SEED=on is required')
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-large-seed')) throw new Error('--confirm-large-seed is required')
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')

  await initSchema()
  await ensureReadModelSchema(pool)
  const result = await pool.query<{ root_url: string }>(
    `SELECT version.root_url
     FROM versions version
     JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id AND workspace.version_id = version.id
     WHERE version.landscape_id = $1 AND version.id = $2`,
    [landscapeId, versionId],
  )
  const rootUrl = result.rows[0]?.root_url
  if (!rootUrl || !isValidAutomergeUrl(rootUrl)) throw new Error('Static performance workspace was not found')

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })
  const rootHandle = await repo.find<{ modelMetaUrl?: string }>(rootUrl as AutomergeUrl)
  await rootHandle.whenReady()
  const oldMetaUrl = rootHandle.doc()?.modelMetaUrl
  if (!oldMetaUrl || !isValidAutomergeUrl(oldMetaUrl)) throw new Error('Model metadata was not found')
  const oldMetaHandle = await repo.find<PerformanceControlMetaInput>(oldMetaUrl as AutomergeUrl)
  await oldMetaHandle.whenReady()

  const source = oldMetaHandle.doc() ?? {}
  let prunedObjectOverlays = 0
  let prunedConnectionOverlays = 0
  let prunedQualificationTombstones = 0
  let cleanObjectOverlayUrl: string | null = null
  let compactSource = source
  if (args.includes('--prune-covered-overlays')) {
    const snapshots = await pool.query<{
      collection: 'object' | 'connection'
      document_id: string
      last_projected_snapshot: Record<string, unknown>
    }>(
      `SELECT segment.collection, segment.document_id, segment.last_projected_snapshot
       FROM read_model_overlay_segments segment
       JOIN read_model_static_document_queue queue
         ON queue.landscape_id = segment.landscape_id
        AND queue.version_id = segment.version_id
        AND queue.document_id = segment.document_id
       WHERE segment.landscape_id = $1 AND segment.version_id = $2
         AND segment.last_projected_snapshot IS NOT NULL
         AND queue.projected_revision >= queue.revision`,
      [landscapeId, versionId],
    )
    const objectSnapshots = new Map<string, Record<string, unknown>>()
    const connectionSnapshots = new Map<string, Record<string, unknown>>()
    for (const row of snapshots.rows) {
      const target = row.collection === 'object' ? objectSnapshots : connectionSnapshots
      target.set(`automerge:${row.document_id}`, row.last_projected_snapshot ?? {})
    }
    const originalObjectUrls = [...new Set([
      ...(source.editsObjectShardUrls ?? []), source.editsObjectShardUrl,
    ].filter((url): url is string => Boolean(url)))]
    // A clean head created by an interrupted/offline prior maintenance may not
    // yet have a projector snapshot. With every API stopped, its durable
    // Automerge state is authoritative and cannot race an online writer.
    for (const url of originalObjectUrls) {
      if (objectSnapshots.has(url) || !isValidAutomergeUrl(url)) continue
      try {
        const handle = await repo.find<{ objects?: Record<string, unknown> }>(url as AutomergeUrl)
        await handle.whenReady()
        const objects = handle.doc()?.objects
        if (objects && typeof objects === 'object') objectSnapshots.set(url, JSON.parse(JSON.stringify(objects)))
      } catch {
        // The compaction helper below fails closed and retains the full chain.
      }
    }
    const effectiveObjects = materializeAcknowledgedOverlayState(
      originalObjectUrls,
      objectSnapshots,
      new Set(source.deletedObjectIds ?? []),
    )
    // Rotate away from the final load phase before pruning. When every source
    // is known, the fresh head contains the complete effective business delta;
    // otherwise it stays empty and the original chain is retained.
    const cleanObjectOverlay = repo.create({
      objects: effectiveObjects ?? {}, writeHeadVersion: 1, writeBatchIds: [],
    })
    await cleanObjectOverlay.whenReady()
    await repo.flush([cleanObjectOverlay.documentId])
    cleanObjectOverlayUrl = cleanObjectOverlay.url
    const admission = await pool.connect()
    try {
      await admission.query('BEGIN')
      await admission.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
        [cleanObjectOverlay.documentId, landscapeId, versionId],
      )
      await admission.query(
        `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
         VALUES ($1, $2, $3, 'object-overlay') ON CONFLICT DO NOTHING`,
        [landscapeId, versionId, cleanObjectOverlay.documentId],
      )
      await admission.query('COMMIT')
    } catch (error) {
      await admission.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      admission.release()
    }
    objectSnapshots.set(cleanObjectOverlay.url, effectiveObjects ?? {})
    const rotatedSource: PerformanceControlMetaInput = {
      ...source,
      editsObjectShardUrl: cleanObjectOverlay.url,
      editsObjectShardUrls: effectiveObjects
        ? [cleanObjectOverlay.url]
        : [...originalObjectUrls, cleanObjectOverlay.url],
    }
    const beforeObjectCount = new Set([
      ...(source.editsObjectShardUrls ?? []), source.editsObjectShardUrl,
    ].filter(Boolean)).size
    const beforeConnectionCount = new Set([
      ...(source.editsConnectionShardUrls ?? []), source.editsConnectionShardUrl,
    ].filter(Boolean)).size
    compactSource = pruneCoveredPerformanceOverlayHistory(rotatedSource, {
      objects: objectSnapshots,
      connections: connectionSnapshots,
    }, {
      disposableObjectId: isQualificationObjectId,
    })
    const retainedOriginalObjects = new Set(compactSource.editsObjectShardUrls ?? [])
    retainedOriginalObjects.delete(cleanObjectOverlay.url)
    prunedObjectOverlays = beforeObjectCount - retainedOriginalObjects.size
    prunedConnectionOverlays = beforeConnectionCount - (compactSource.editsConnectionShardUrls?.length ?? 0)
    prunedQualificationTombstones = (source.deletedObjectIds ?? []).filter(isQualificationObjectId).length
      - (compactSource.deletedObjectIds ?? []).filter(isQualificationObjectId).length
  }
  const control = toPerformanceControlMeta(compactSource)
  const newMetaHandle = repo.create(control)
  await newMetaHandle.whenReady()
  await repo.flush([newMetaHandle.documentId])

  // Admit the child before publishing it from the root. A crash after this
  // transaction leaves only an unreachable, recoverable document; publishing
  // the root first can leave cold/selective-sync clients following a child the
  // server is not yet allowed to serve.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
      [newMetaHandle.documentId, landscapeId, versionId],
    )
    await client.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ($1, $2, $3, 'model-meta')
       ON CONFLICT DO NOTHING`,
      [landscapeId, versionId, newMetaHandle.documentId],
    )
    await client.query('COMMIT')

    rootHandle.change((root) => { root.modelMetaUrl = newMetaHandle.url })
    await repo.flush([rootHandle.documentId])

    await client.query('BEGIN')
    await client.query(
      `DELETE FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = $2
         AND kind = 'model-meta' AND document_id = $3`,
      [landscapeId, versionId, oldMetaUrl.slice('automerge:'.length)],
    )
    // Stale clients may still request the old metadata before receiving the
    // updated root. Removing its workspace admission prevents an OOM replay.
    await client.query(
      `DELETE FROM automerge_document_workspace
       WHERE document_id = $1 AND landscape_id = $2 AND version_id = $3`,
      [oldMetaUrl.slice('automerge:'.length), landscapeId, versionId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  await repo.shutdown()
  console.log(JSON.stringify({
    status: 'complete', landscapeId, versionId,
    oldModelMetaUrl: oldMetaUrl,
    modelMetaUrl: newMetaHandle.url,
    objectOverlays: control.objectShardUrls?.length ?? 0,
    connectionOverlays: control.connectionShardUrls?.length ?? 0,
    prunedObjectOverlays,
    prunedConnectionOverlays,
    prunedQualificationTombstones,
    cleanObjectOverlayUrl,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-control-meta] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
