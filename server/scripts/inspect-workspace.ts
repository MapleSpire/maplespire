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

// Dev diagnostic: dump a workspace's doc tree as the SERVER storage sees it.
//   npx tsx scripts/inspect-workspace.ts <landscapeId> [versionId]
// Reads the versions table for the root url, then walks root → modelMeta/model +
// registry shards → diagram metas, printing counts. No mutations.
import 'dotenv/config'
import { Repo, isValidAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'

const landscapeId = process.argv[2]
const versionId = process.argv[3]

async function readDoc(repo: Repo, url: string): Promise<Record<string, unknown> | null> {
  if (!isValidAutomergeUrl(url)) return null
  const h = await repo.find(url as AutomergeUrl)
  await h.whenReady()
  return (h.doc() as Record<string, unknown>) ?? null
}

const { rows } = await pool.query<{ id: string; landscape_id: string; label: string; root_url: string; kind: string | null }>(
  versionId
    ? `SELECT id, landscape_id, label, root_url, kind FROM versions WHERE landscape_id = $1 AND id = $2`
    : `SELECT id, landscape_id, label, root_url, kind FROM versions WHERE landscape_id = $1`,
  versionId ? [landscapeId, versionId] : [landscapeId]
)
if (rows.length === 0) {
  console.log('no versions found for', landscapeId, versionId ?? '')
  process.exit(0)
}

const repo = new Repo({ network: [], storage: new PostgresStorageAdapter() })

for (const v of rows) {
  console.log(`\n=== version ${v.id} (${v.label}, kind=${v.kind ?? 'version'}) root=${v.root_url}`)
  const root = await readDoc(repo, v.root_url)
  if (!root) { console.log('  root doc UNREADABLE'); continue }
  const modelUrl = root.modelUrl as string
  const modelMetaUrl = root.modelMetaUrl as string | undefined
  const shardUrls = (root.shardUrls as string[]) ?? []
  console.log(`  modelUrl=${modelUrl || '(empty)'}  modelMetaUrl=${modelMetaUrl ?? '(unset)'}  registryShards=${shardUrls.length}`)
  if (modelMetaUrl && isValidAutomergeUrl(modelMetaUrl)) {
    const meta = await readDoc(repo, modelMetaUrl)
    const os = (meta?.objectShardUrls as string[]) ?? []
    const cs = (meta?.connectionShardUrls as string[]) ?? []
    console.log(`  meta: objectShards=${os.length} connectionShards=${cs.length}`)
    let objects = 0
    for (const u of os) { const d = await readDoc(repo, u); objects += Object.keys((d?.objects as object) ?? {}).length }
    console.log(`  objects in shards: ${objects}`)
  }
  if (modelUrl && isValidAutomergeUrl(modelUrl)) {
    const model = await readDoc(repo, modelUrl)
    console.log(`  monolith objects: ${Object.keys((model?.objects as object) ?? {}).length}`)
  }
  for (const su of shardUrls) {
    const shard = await readDoc(repo, su)
    const diagrams = (shard?.diagrams as Record<string, { name?: string }>) ?? {}
    console.log(`  registry shard ${su.slice(0, 24)}…: ${Object.keys(diagrams).length} diagram(s) ${Object.values(diagrams).map((d) => d.name).join(', ')}`)
  }
}
await pool.end()
process.exit(0)
