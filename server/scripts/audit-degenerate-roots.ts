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
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { isStructurallyHealthyRoot } from '../src/maintenance/degenerateRootRepair.js'

type DocumentSummary = {
  url: string
  keys: string[]
  classification: string
}

function classification(value: Record<string, unknown>): string {
  if ('modelUrl' in value || 'modelMetaUrl' in value || 'shardUrls' in value) return 'root'
  if ('objectShardUrls' in value || 'connectionShardUrls' in value) return 'model-meta'
  if ('diagrams' in value) return 'registry'
  if ('objects' in value || 'connections' in value || 'decisionRecords' in value) return 'model-or-shard'
  if ('objectIds' in value || 'connectionIds' in value || 'layouts' in value) return 'diagram'
  return 'unknown'
}

async function main(): Promise<void> {
  const repo = new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }) })
  try {
    const { rows: versions } = await pool.query<{
      landscape_id: string
      id: string
      label: string
      root_url: AutomergeUrl
    }>('SELECT landscape_id, id, label, root_url FROM versions ORDER BY landscape_id, id')
    const results = []
    for (const version of versions) {
      let root: Record<string, unknown> | undefined
      let rootUnavailable = false
      try {
        const handle = await repo.find(version.root_url)
        await handle.whenReady()
        root = handle.doc() as Record<string, unknown> | undefined
      } catch {
        rootUnavailable = true
      }
      const healthy = isStructurallyHealthyRoot(root)
      if (healthy) continue
      const { rows: mappings } = await pool.query<{ document_id: string }>(
        `SELECT document_id FROM automerge_document_workspace
         WHERE landscape_id = $1 AND version_id = $2 ORDER BY document_id`,
        [version.landscape_id, version.id],
      )
      const documents: DocumentSummary[] = []
      for (const mapping of mappings) {
        const url = `automerge:${mapping.document_id}` as AutomergeUrl
        try {
          const child = await repo.find(url)
          await child.whenReady()
          const value = (child.doc() ?? {}) as Record<string, unknown>
          documents.push({ url, keys: Object.keys(value).sort(), classification: classification(value) })
        } catch {
          documents.push({ url, keys: [], classification: 'unavailable' })
        }
      }
      results.push({
        landscapeId: version.landscape_id,
        versionId: version.id,
        label: version.label,
        rootUrl: version.root_url,
        rootUnavailable,
        rootKeys: Object.keys(root ?? {}).sort(),
        mappedDocuments: documents,
      })
    }
    console.log(JSON.stringify({ event: 'maintenance.degenerate_root_audit', workspaces: results }))
  } finally {
    await repo.shutdown()
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[degenerate-root-audit] failed:', error)
  process.exitCode = 1
})
