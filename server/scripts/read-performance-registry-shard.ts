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

/** Internal bounded-memory helper: read exactly one registry shard then exit. */
import 'dotenv/config'
import { isValidAutomergeUrl, Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'

async function main(): Promise<void> {
  const shardUrl = process.argv[2]
  if (!shardUrl || !isValidAutomergeUrl(shardUrl)) throw new Error('A valid registry shard URL is required')
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })
  const handle = await repo.find<{ diagrams?: Record<string, { docUrl?: string }> }>(shardUrl as AutomergeUrl)
  await handle.whenReady()
  const entries = Object.entries(handle.doc()?.diagrams ?? {}).map(([diagramId, meta]) => {
    if (!meta.docUrl || !isValidAutomergeUrl(meta.docUrl)) throw new Error(`Invalid document URL for ${diagramId}`)
    return [diagramId, meta.docUrl]
  })
  process.stdout.write(JSON.stringify(entries))
  // This read is WARM. Dropping the handle cannot make it cold in
  // automerge-repo 2.6.0-alpha.2: `synchronizer.removeDocument` does not exist
  // (only `detach` does), and `delete repo.handles[id]` mutates a throwaway
  // copy the getter rebuilds per access. Only a fresh Repo would be cold.
  await repo.shutdown()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => pool.end().catch(() => undefined))
