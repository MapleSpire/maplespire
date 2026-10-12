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
 * Replace dangling performance overlay pointers with server-durable empty
 * write heads. Stop the API first. Every new child is flushed and admitted to
 * the exact workspace before ModelMeta publishes its URL.
 */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../src/modelMeta.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { registerStaticReadModelDocuments } from '../src/readModel/staticWorkspace.js'

interface RepairMeta {
  staticBaseline?: boolean
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrls?: string[]
  editsConnectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  editsOverlayWriteHeadVersion?: number
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

const documentId = (url: string) => url.replace(/^automerge:/, '').split('?')[0]
const unique = (values: readonly string[]) => [...new Set(values)]

async function durableUrls(urls: readonly string[]): Promise<{ durable: string[]; missing: string[] }> {
  const valid = unique(urls.filter(isValidAutomergeUrl))
  if (!valid.length) return { durable: [], missing: [] }
  const ids = valid.map(documentId)
  const result = await pool.query<{ document_id: string }>(
    `SELECT DISTINCT split_part(key, '/', 1) AS document_id
     FROM automerge_storage WHERE split_part(key, '/', 1) = ANY($1::text[])`,
    [ids],
  )
  const found = new Set(result.rows.map((row) => row.document_id))
  return {
    durable: valid.filter((url) => found.has(documentId(url))),
    missing: valid.filter((url) => !found.has(documentId(url))),
  }
}

async function main(): Promise<void> {
  if (process.env.PERFORMANCE_SEED !== 'on') throw new Error('PERFORMANCE_SEED=on is required')
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-replace-overlay-heads')) {
    throw new Error('--confirm-replace-overlay-heads is required')
  }
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')
  const key = { landscapeId, versionId }

  await initSchema()
  await ensureReadModelSchema(pool)
  const targetResult = await pool.query<{ root_url: string; source: string }>(
    `SELECT version.root_url, workspace.source
     FROM versions version
     JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id AND workspace.version_id = version.id
     WHERE version.landscape_id = $1 AND version.id = $2`,
    [landscapeId, versionId],
  )
  const target = targetResult.rows[0]
  if (!target || !isValidAutomergeUrl(target.root_url)
      || target.source !== 'performance-seed-editable') {
    throw new Error('Editable static performance workspace was not found')
  }

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool, trackStaticReadModel: true }),
    network: [],
    saveDebounceRate: 0,
  })
  const rootHandle = await repo.find<{ modelMetaUrl?: string }>(target.root_url as AutomergeUrl)
  await rootHandle.whenReady()
  const metaUrl = rootHandle.doc()?.modelMetaUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) throw new Error('Performance ModelMeta was not found')
  const metaHandle = await repo.find<RepairMeta>(metaUrl as AutomergeUrl)
  await metaHandle.whenReady()
  const before = metaHandle.doc()
  if (before?.staticBaseline !== true) throw new Error('ModelMeta is not a static baseline')

  const objects = await durableUrls(unique([
    ...(before.editsObjectShardUrls ?? []),
    ...(before.objectShardUrls ?? []),
    ...(before.editsObjectShardUrl ? [before.editsObjectShardUrl] : []),
  ]))
  const connections = await durableUrls(unique([
    ...(before.editsConnectionShardUrls ?? []),
    ...(before.connectionShardUrls ?? []),
    ...(before.editsConnectionShardUrl ? [before.editsConnectionShardUrl] : []),
  ]))

  const objectHead = repo.create({ objects: {}, writeBatchIds: [] as string[], writeHeadVersion: 1 })
  const connectionHead = repo.create({ connections: {}, writeBatchIds: [] as string[], writeHeadVersion: 1 })
  await Promise.all([objectHead.whenReady(), connectionHead.whenReady()])
  await repo.flush([objectHead.documentId, connectionHead.documentId])

  // Admission and static tracking are durable before the parent points at the
  // children, so a cold client can never observe an authorized-but-missing doc.
  await pool.query(
    `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
     VALUES ($1, $3, $4), ($2, $3, $4) ON CONFLICT DO NOTHING`,
    [objectHead.documentId, connectionHead.documentId, landscapeId, versionId],
  )
  await registerStaticReadModelDocuments(pool, key, [
    { documentId: objectHead.documentId, kind: 'object-overlay' },
    { documentId: connectionHead.documentId, kind: 'connection-overlay' },
  ])
  const missingIds = [...objects.missing, ...connections.missing].map(documentId)
  if (missingIds.length) {
    await pool.query(
      `DELETE FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
      [landscapeId, versionId, missingIds],
    )
    await pool.query(
      `DELETE FROM automerge_document_workspace
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
      [landscapeId, versionId, missingIds],
    )
  }

  metaHandle.change((meta) => {
    meta.editsObjectShardUrls = [...objects.durable, objectHead.url]
    meta.objectShardUrls = [...objects.durable, objectHead.url]
    meta.editsObjectShardUrl = objectHead.url
    meta.editsConnectionShardUrls = [...connections.durable, connectionHead.url]
    meta.connectionShardUrls = [...connections.durable, connectionHead.url]
    meta.editsConnectionShardUrl = connectionHead.url
    // The constant, like `repair-overlay-heads.ts` next door. A repair tool is
    // the worst place to leave a stale literal: after a protocol bump this one
    // would stamp the OLD version onto the workspace it was invoked to fix,
    // reintroducing the `data-loss` finding it was run to clear.
    meta.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
  })
  await repo.flush([metaHandle.documentId])
  await repo.shutdown()
  console.log(JSON.stringify({
    status: 'complete', landscapeId, versionId,
    removedMissingObjectHeads: objects.missing,
    removedMissingConnectionHeads: connections.missing,
    objectHead: objectHead.url,
    connectionHead: connectionHead.url,
    retainedObjectSegments: objects.durable.length,
    retainedConnectionSegments: connections.durable.length,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('[performance-overlay-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
