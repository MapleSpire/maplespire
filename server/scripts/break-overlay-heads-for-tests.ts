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
 * TEST FIXTURE ONLY: strip the overlay write heads from a workspace's ModelMeta,
 * reproducing the born-broken shape (`fsck` → `model-write-head` / data-loss)
 * on demand. The one legitimate use is verifying the client's L6 boot guard and
 * the repair loop end to end on a SCRATCH workspace:
 *
 *   npx tsx scripts/break-overlay-heads-for-tests.ts --landscape-id X --version-id Y \
 *     --i-am-breaking-a-workspace-for-tests
 *
 * It refuses to run in production, refuses without the explicit flag, and
 * refuses when the target overlay is NOT empty — a workspace whose overlay
 * holds real edits would lose them, and no test needs that. Undo with
 * `npm run repair:overlay-heads`.
 *
 * STOP THE API FIRST (same rule as repair-overlay-heads.ts): this writes
 * through its own Repo against the same Postgres storage, and a running server
 * holds cached handles the two writers would not see. `network: []` on purpose.
 */
import 'dotenv/config'
import { Repo, isValidAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { initSchema, pool } from '../src/db.js'

interface MetaShape {
  editsObjectShardUrls?: string[]
  editsConnectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  editsOverlayWriteHeadVersion?: number
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (!args.includes('--i-am-breaking-a-workspace-for-tests')) {
    throw new Error('--i-am-breaking-a-workspace-for-tests is required — this DAMAGES a workspace on purpose')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to break a workspace in production')
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
  const root = await repo.find<{ modelMetaUrl?: string }>(rootUrl as AutomergeUrl)
  const metaUrl = root.doc()?.modelMetaUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) throw new Error('workspace has no ModelMeta (monolith?)')
  const meta = await repo.find<MetaShape>(metaUrl as AutomergeUrl)
  const doc = meta.doc()
  if (!doc) throw new Error('ModelMeta did not resolve')

  // Refuse when the overlay holds ANYTHING — stripping the heads then would
  // lose real edits, and the L6 fallback this fixture exists to exercise only
  // triggers on a PROVABLY EMPTY overlay anyway. The PLURAL segment lists are
  // inspected too: this script deletes them as well, and a historical segment
  // can carry content the singular heads no longer do.
  const headUrls = [...new Set(
    [
      doc.editsObjectShardUrl,
      doc.editsConnectionShardUrl,
      ...(doc.editsObjectShardUrls ?? []),
      ...(doc.editsConnectionShardUrls ?? []),
    ].filter((value): value is string => Boolean(value) && isValidAutomergeUrl(value!)),
  )]
  for (const headUrl of headUrls) {
    const head = await repo.find<{ objects?: Record<string, unknown>; connections?: Record<string, unknown> }>(
      headUrl as AutomergeUrl,
    )
    const contents = { ...(head.doc()?.objects ?? {}), ...(head.doc()?.connections ?? {}) }
    if (Object.keys(contents).length > 0) {
      throw new Error(`refusing: overlay head ${headUrl} holds ${Object.keys(contents).length} entities`)
    }
  }
  if ((doc.deletedObjectIds ?? []).length > 0 || (doc.deletedConnectionIds ?? []).length > 0) {
    throw new Error('refusing: pending tombstones exist on this workspace')
  }

  meta.change((m) => {
    delete m.editsObjectShardUrl
    delete m.editsConnectionShardUrl
    delete m.editsObjectShardUrls
    delete m.editsConnectionShardUrls
    delete m.editsOverlayWriteHeadVersion
  })
  await repo.flush([meta.documentId])
  console.log(`stripped overlay write heads from ${landscapeId}/${versionId} (${metaUrl})`)
  console.log('undo: npm run repair:overlay-heads -- --landscape-id ' + landscapeId
    + ' --version-id ' + versionId + ' --confirm-create-overlay-heads')
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error)
    await pool.end().catch(() => undefined)
    process.exitCode = 1
  })
