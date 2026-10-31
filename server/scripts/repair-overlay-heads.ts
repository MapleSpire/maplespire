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
 * Repair an ORDINARY sharded workspace whose ModelMeta has no overlay write
 * heads — the shape that silently eats every entity edit under boot-from-server
 * (`npm run fsck` reports it as `model-write-head` / data-loss).
 *
 *   npx tsx scripts/repair-overlay-heads.ts --landscape-id X --version-id Y --confirm-create-overlay-heads
 *
 * STOP THE API FIRST. This writes through its own Repo against the same
 * Postgres storage; a running server holds cached handles and the two writers
 * would not see each other.
 *
 * Ordering is the whole point (same contract as `buildModelMeta`/createEmptyRoot):
 *   1. create the two empty overlay shards,
 *   2. flush them to Postgres,
 *   3. register their workspace admission,
 *   4. ONLY THEN publish their URLs into ModelMeta.
 * A crash between any two steps leaves at worst an orphan document, never a
 * dangling pointer. `network: []` on purpose — with an adapter attached and no
 * peer, a missing document's find() never settles.
 *
 * Companion of `repair-performance-overlay-heads.ts`, which repairs DANGLING
 * pointers on the static perf workspaces; this one creates MISSING heads on
 * ordinary workspaces. Re-run `npm run fsck` afterwards — that is the proof.
 */
import 'dotenv/config'
import { Repo, isValidAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../src/modelMeta.js'

interface MetaShape {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-create-overlay-heads')) {
    throw new Error('--confirm-create-overlay-heads is required')
  }
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')

  await initSchema()
  const { rows } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [landscapeId, versionId],
  )
  if (rows.length === 0) throw new Error(`no such workspace: ${landscapeId}/${versionId}`)
  const rootUrl = rows[0].root_url
  if (!isValidAutomergeUrl(rootUrl)) throw new Error(`invalid root url: ${rootUrl}`)

  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })

  const rootHandle = await repo.find<{ modelMetaUrl?: string }>(rootUrl as AutomergeUrl)
  const root = rootHandle.doc()
  const metaUrl = root?.modelMetaUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) {
    throw new Error('root has no modelMetaUrl — this is a monolith workspace, nothing to repair here')
  }
  const metaHandle = await repo.find<MetaShape>(metaUrl as AutomergeUrl)
  const meta = metaHandle.doc()
  if (!meta) throw new Error('ModelMeta did not resolve')

  // Per-collection: only the MISSING head is created; a healthy collection is
  // never touched. And a collection with historical segments but no current
  // head is the DANGLING-pointer shape — replacing its list here would orphan
  // segments that may hold uncompacted edits (the repair would cause the loss
  // it repairs). That shape belongs to repair-performance-overlay-heads-style
  // handling; refuse it.
  const needObject = !meta.editsObjectShardUrl || !isValidAutomergeUrl(meta.editsObjectShardUrl)
  const needConnection = !meta.editsConnectionShardUrl || !isValidAutomergeUrl(meta.editsConnectionShardUrl)
  if (!needObject && !needConnection) {
    console.log('[repair] both overlay write heads already present — nothing to do')
    await repo.shutdown()
    return
  }
  if ((needObject && (meta.editsObjectShardUrls?.length ?? 0) > 0)
    || (needConnection && (meta.editsConnectionShardUrls?.length ?? 0) > 0)) {
    throw new Error(
      'a collection has overlay segments but no current head (dangling-pointer shape); '
      + 'refusing to replace its segment list — those segments may hold uncompacted edits',
    )
  }

  console.log(`[repair] ${landscapeId}/${versionId}: creating overlay write heads`
    + ` (object: ${needObject ? 'MISSING' : 'present'}, connection: ${needConnection ? 'MISSING' : 'present'})`)
  // 1) Children first — only the ones actually missing.
  const objectShard = needObject
    ? repo.create<{ objects: Record<string, unknown>; writeBatchIds: string[] }>({ objects: {}, writeBatchIds: [] })
    : null
  const connectionShard = needConnection
    ? repo.create<{ connections: Record<string, unknown>; writeBatchIds: string[] }>({ connections: {}, writeBatchIds: [] })
    : null
  const created = [objectShard, connectionShard].filter((shard) => shard !== null)
  // 2) Durable before referenced.
  await repo.flush(created.map((shard) => shard.documentId))
  // 3) Admitted before referenced — the sync gate consults this index.
  for (const child of created) {
    await pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT $1, v.landscape_id, v.id FROM versions v
       WHERE v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING`,
      [child.documentId, landscapeId, versionId],
    )
  }
  // 4) Only now the parent pointers, APPEND-only. Head LAST in the base lists —
  // forkRoot remaps heads by POSITION there (see modelMeta.ts:withHeadLast).
  metaHandle.change((m) => {
    if (objectShard) {
      if (!m.objectShardUrls) m.objectShardUrls = []
      if (!m.objectShardUrls.includes(objectShard.url)) m.objectShardUrls.push(objectShard.url)
      m.editsObjectShardUrl = objectShard.url
      if (!m.editsObjectShardUrls) m.editsObjectShardUrls = []
      if (!m.editsObjectShardUrls.includes(objectShard.url)) m.editsObjectShardUrls.push(objectShard.url)
    }
    if (connectionShard) {
      if (!m.connectionShardUrls) m.connectionShardUrls = []
      if (!m.connectionShardUrls.includes(connectionShard.url)) m.connectionShardUrls.push(connectionShard.url)
      m.editsConnectionShardUrl = connectionShard.url
      if (!m.editsConnectionShardUrls) m.editsConnectionShardUrls = []
      if (!m.editsConnectionShardUrls.includes(connectionShard.url)) m.editsConnectionShardUrls.push(connectionShard.url)
    }
    m.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
  })
  await repo.flush([metaHandle.documentId])
  await repo.shutdown()

  if (objectShard) console.log(`[repair] object head     ${objectShard.url}`)
  if (connectionShard) console.log(`[repair] connection head ${connectionShard.url}`)
  console.log(`[repair] admission rows written for ${created.map((shard) => documentId(shard.url)).join(', ')}`)
  console.log('[repair] done — restart the API, then re-run `npm run fsck` to prove it')
}

main()
  .catch((error) => {
    console.error('[repair] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => pool.end().catch(() => undefined))
