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
 * Rebuild the DiagramDocs a registry points at but storage does not hold.
 *
 *   npx tsx scripts/repair-missing-diagram-documents.ts \
 *     --landscape-id X --version-id Y --dry-run
 *   npx tsx scripts/repair-missing-diagram-documents.ts \
 *     --landscape-id X --version-id Y --confirm-recreate-diagram-documents
 *
 * THE SHAPE THIS REPAIRS. A registry meta carries `docUrl`, the document behind
 * it has no `snapshot`/`incremental` chunk, and the diagram is therefore
 * unopenable: `repo.find()` reports "is unavailable", the client's
 * `activateEditing` callback never fires, `markEditReady()` is never called, and
 * `CanvasView` renders it permanently read-only while still DISPLAYING it from
 * the server read-model.
 *
 * PRESENCE MEANS CONTENT. A document with only `sync-state/<peerId>` (2 bytes,
 * written the first time a peer merely TRIES to sync it) is ABSENT for this
 * script's purposes — counting that row as presence would hide exactly this
 * damage.
 *
 * STOP THE API FIRST. This writes through its own Repo against the same
 * Postgres storage; a running server holds cached registry handles and the two
 * writers would not see each other.
 *
 * Ordering, which is the entire point — the repair must not commit the defect
 * it repairs (an Automerge root must never be published before all documents
 * it references are durably written):
 *   1. build the replacement DiagramDoc,
 *   2. FLUSH it to Postgres,
 *   3. register its workspace admission,
 *   4. ONLY THEN repoint the registry meta at it.
 * A crash between any two steps leaves at worst an orphan document, never a
 * second dangling pointer.
 *
 * WHAT COMES BACK, AND WHAT DOES NOT. The registry meta carries the diagram's
 * whole composition (`objectIds`, `connectionIds`, `groupIds`, `name`, `type`,
 * `parentObjectId`), so the diagram is whole and editable again. Everything that
 * lived ONLY inside the lost document is gone and this script cannot invent it:
 * **layouts** (positions and sizes — run auto-layout afterwards), `layouts3d`,
 * comments, flows, checkpoints, `description`, `sourceViewKey`, `domainId` and
 * the per-diagram style preferences. Say this to whoever asks for the repair
 * BEFORE running it, not after.
 *
 * IT FORECLOSES A RECOVERY. An Automerge document id cannot be chosen, so the
 * replacement is a NEW document and the registry stops pointing at the old one.
 * If any browser still holds the original in IndexedDB, its content — including
 * the layouts — would have synced back on the next visit; after this runs it
 * would sync into a document nothing references. So: exhaust the browser path
 * FIRST. This script therefore leaves the old admission row in place and writes
 * the old→new mapping to a report file, so a later merge stays possible; it
 * never deletes the superseded id.
 *
 * Re-run `npm run fsck` afterwards — that is the proof.
 */
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Repo, isValidAutomergeUrl, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { initSchema, pool } from '../src/db.js'
import type { Queryable } from '../src/readModel/types.js'

interface DiagramMetaShape {
  id?: string
  name?: string
  type?: string
  docUrl?: string
  parentObjectId?: string
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
}

interface RegistryShard {
  diagrams: Record<string, DiagramMetaShape>
}

interface RootShape {
  shardUrls?: unknown
  registryWriteUrl?: unknown
}

export interface RebuildPlanEntry {
  diagramId: string
  name: string
  type: string
  supersededDocUrl: string
  registryShardUrl: string
  objectIds: number
  connectionIds: number
  groupIds: number
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

const documentIdOf = (url: string): string => url.replace(/^automerge:/, '').split('?')[0]

/**
 * The document ids that hold actual CONTENT.
 *
 * `sync-state` is deliberately excluded — see the module doc. Kept as its own
 * exported function so the predicate that decides "this document exists" has
 * exactly one definition in this script.
 */
export async function documentIdsWithContent(
  query: (sql: string, params: unknown[]) => Promise<{ rows: { document_id: string }[] }>,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set()
  const { rows } = await query(
    `SELECT DISTINCT split_part(key, '/', 1) AS document_id
       FROM automerge_storage
      WHERE split_part(key, '/', 1) = ANY($1::text[])
        AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
    [candidateIds],
  )
  return new Set(rows.map((row) => row.document_id))
}

/**
 * The DiagramDoc a lost one is replaced by, from its registry meta alone.
 *
 * Mirrors `diagramToDiagramDoc` (src/lib/automerge/projection.ts): every
 * `Diagram` field except `id`, plus `layouts`/`comments`/`flows`/`checkpoints`.
 * Empty layouts is not a placeholder — it is the honest statement that the
 * positions are gone, and it is what makes the client offer auto-layout.
 */
export function rebuiltDiagramDoc(meta: DiagramMetaShape): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    name: typeof meta.name === 'string' ? meta.name : 'Diagramme restauré',
    type: meta.type === 'container' || meta.type === 'component' ? meta.type : 'context',
    objectIds: [...(meta.objectIds ?? [])],
    connectionIds: [...(meta.connectionIds ?? [])],
    groupIds: [...(meta.groupIds ?? [])],
    layouts: {},
    comments: {},
    flows: {},
    checkpoints: [],
  }
  // Only when present: Automerge rejects `undefined`, and a key set to undefined
  // is not the same document as a key absent.
  if (typeof meta.parentObjectId === 'string') doc.parentObjectId = meta.parentObjectId
  return doc
}

export interface RepairOutcome {
  plan: RebuildPlanEntry[]
  repaired: { diagramId: string; name: string; from: string; to: string }[]
  registryDiagrams: number
}

/**
 * The whole repair, as a function of an already-open pool and repo.
 *
 * Extracted from `main` so a test can drive it against real Postgres and the
 * real storage adapter. The end-state assertion a test can then make is the one
 * that matters: the document the registry points at HAS content. That fails if
 * the flush was skipped or ordered after the pointer — i.e. it catches the
 * defect this script exists to repair being committed BY the repair.
 */
export async function repairMissingDiagramDocuments(
  db: Queryable,
  repo: Repo,
  key: { landscapeId: string; versionId: string; rootUrl: string },
  options: { dryRun: boolean; log?: (line: string) => void } = { dryRun: true },
): Promise<RepairOutcome> {
  const { landscapeId, versionId, rootUrl } = key
  const log = options.log ?? (() => undefined)

  const rootHandle = await findReadyDocument<RootShape>(repo, rootUrl as AutomergeUrl)
  const root = rootHandle.doc()
  const registryUrls = [
    ...(Array.isArray(root?.shardUrls) ? root.shardUrls : []),
    ...(typeof root?.registryWriteUrl === 'string' ? [root.registryWriteUrl] : []),
  ].filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url))
  if (registryUrls.length === 0) throw new Error('root names no registry shard — nothing to walk')

  const shards = new Map<string, DocHandle<RegistryShard>>()
  for (const url of new Set(registryUrls)) {
    shards.set(url, await findReadyDocument<RegistryShard>(repo, url as AutomergeUrl))
  }

  // Collect every (shard, diagram) pair that names a document.
  const candidates: { shardUrl: string; diagramId: string; meta: DiagramMetaShape }[] = []
  for (const [shardUrl, handle] of shards) {
    const diagrams = handle.doc()?.diagrams
    if (!diagrams || typeof diagrams !== 'object') continue
    for (const [diagramId, meta] of Object.entries(diagrams)) {
      if (typeof meta?.docUrl === 'string' && isValidAutomergeUrl(meta.docUrl)) {
        candidates.push({ shardUrl, diagramId, meta })
      }
    }
  }

  const present = await documentIdsWithContent(
    (sql, params) => db.query<{ document_id: string }>(sql, params),
    candidates.map((c) => documentIdOf(c.meta.docUrl!)),
  )
  const missing = candidates.filter((c) => !present.has(documentIdOf(c.meta.docUrl!)))

  log(`[repair] ${landscapeId}/${versionId}: ${candidates.length} diagram(s) in the registry,`
    + ` ${candidates.length - missing.length} with durable content, ${missing.length} MISSING`)

  if (missing.length === 0) {
    log('[repair] nothing to do')
    return { plan: [], repaired: [], registryDiagrams: candidates.length }
  }

  const plan: RebuildPlanEntry[] = missing.map(({ shardUrl, diagramId, meta }) => ({
    diagramId,
    name: meta.name ?? '(sans nom)',
    type: meta.type ?? 'context',
    supersededDocUrl: meta.docUrl!,
    registryShardUrl: shardUrl,
    objectIds: meta.objectIds?.length ?? 0,
    connectionIds: meta.connectionIds?.length ?? 0,
    groupIds: meta.groupIds?.length ?? 0,
  }))
  for (const entry of plan) {
    log(`  - ${entry.diagramId.padEnd(18)} ${entry.name.padEnd(32)}`
      + ` ${entry.objectIds} obj / ${entry.connectionIds} conn / ${entry.groupIds} grp`
      + `  (was ${entry.supersededDocUrl})`)
  }

  if (options.dryRun) {
    log('')
    log('[repair] --dry-run: nothing was written.')
    log('[repair] a real run would rebuild each diagram from its registry meta and')
    log('[repair] LOSE, irrecoverably: layouts (positions/sizes), layouts3d, comments,')
    log('[repair] flows, checkpoints, description, sourceViewKey, domainId, style prefs.')
    log('[repair] If ANY browser may still hold these documents, recover from it FIRST —')
    log('[repair] repointing the registry means a returning copy is no longer picked up.')
    return { plan, repaired: [], registryDiagrams: candidates.length }
  }

  const repaired: { diagramId: string; name: string; from: string; to: string }[] = []
  for (const { shardUrl, diagramId, meta } of missing) {
    // 1) Build the replacement.
    const handle = repo.create<Record<string, unknown>>(rebuiltDiagramDoc(meta))
    // 2) Durable BEFORE referenced.
    await repo.flush([handle.documentId])
    // 3) Admitted BEFORE referenced — the sync gate consults this index, and a
    //    document the gate refuses is one the client can never load.
    await db.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT $1, v.landscape_id, v.id FROM versions v
       WHERE v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING`,
      [handle.documentId, landscapeId, versionId],
    )
    // 4) ONLY NOW the pointer.
    const shard = shards.get(shardUrl)!
    shard.change((doc) => {
      const entry = doc.diagrams?.[diagramId]
      if (entry) entry.docUrl = handle.url
    })
    await repo.flush([shard.documentId])
    repaired.push({ diagramId, name: meta.name ?? '(sans nom)', from: meta.docUrl!, to: handle.url })
    log(`[repair] ${diagramId} -> ${handle.url}`)
  }

  return { plan, repaired, registryDiagrams: candidates.length }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const confirmed = args.includes('--confirm-recreate-diagram-documents')
  if (!dryRun && !confirmed) {
    throw new Error('pass --dry-run to preview, or --confirm-recreate-diagram-documents to write')
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

  // `network: []` on purpose: with an adapter attached and no peer connected,
  // `repo.find()` for a missing document NEVER settles — and missing documents
  // are precisely what this script looks for.
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: pool }),
    network: [],
    saveDebounceRate: 0,
  })

  const outcome = await repairMissingDiagramDocuments(
    pool,
    repo,
    { landscapeId, versionId, rootUrl },
    { dryRun, log: (line) => console.log(line) },
  )
  await repo.shutdown()

  if (outcome.repaired.length === 0) return

  // The superseded ids are NOT de-admitted: if a browser copy ever returns, its
  // content still lands in storage and this file says which diagram it belonged
  // to. Without the mapping that content would be unattributable.
  const reportPath = `repair-missing-diagram-documents-${landscapeId}-${versionId}.json`
  await writeFile(
    reportPath,
    `${JSON.stringify({ landscapeId, versionId, repaired: outcome.repaired }, null, 2)}\n`,
    'utf8',
  )

  console.log(`\n[repair] rebuilt ${outcome.repaired.length} diagram document(s)`)
  console.log(`[repair] old -> new mapping written to ${reportPath} (superseded ids left admitted on purpose)`)
  console.log('[repair] layouts were NOT restored — open each diagram and run auto-layout')
  console.log('[repair] restart the API, then re-run `npm run fsck` to prove it')
}

// Only when RUN, never when imported: the test imports
// `repairMissingDiagramDocuments` from here, and an unguarded `main()` would
// fire on import — parsing argv that belongs to vitest and ending the pool
// under the test's feet.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error('[repair] failed:', error)
      process.exitCode = 2
    })
    .finally(async () => pool.end().catch(() => undefined))
}
