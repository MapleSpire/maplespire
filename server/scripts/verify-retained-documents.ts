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
import { PostgresStorageAdapter, documentContentChunkFilter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { isStructurallyHealthyRoot } from '../src/maintenance/degenerateRootRepair.js'

type TargetClass = 'root' | 'model' | 'model-meta' | 'registry-sample'
  | 'active-diagram' | 'draft-document' | 'retained-overlay'
type PlainDocument = Record<string, unknown>

const targets = new Map<AutomergeUrl, Set<TargetClass>>()
const registryOwners = new Map<string, string[]>()
function add(url: string | null | undefined, kind: TargetClass): void {
  if (!url?.startsWith('automerge:')) return
  const key = url as AutomergeUrl
  const kinds = targets.get(key) ?? new Set<TargetClass>()
  kinds.add(kind)
  targets.set(key, kinds)
}

function createRepo(): Repo {
  return new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }) })
}

/**
 * A plain shutdown, with no per-handle cleanup loop: in automerge-repo
 * 2.6.0-alpha.2 `synchronizer.removeDocument` does not exist, `delete
 * repo.handles[id]` mutates a copy the getter rebuilds per access, and
 * `DocHandle.state` is `ready` or `deleted` for EVERY cached handle (even one
 * that never received a byte). Not-ready documents are already handled
 * upstream: `Repo.flush`, which `shutdown()` awaits, skips any document whose
 * query is not ready.
 */
async function shutdownReadRepo(repo: Repo): Promise<void> {
  await repo.shutdown()
}

async function loadOne(repo: Repo, url: AutomergeUrl): Promise<PlainDocument> {
  const handle = await repo.find(url)
  await handle.whenReady()
  const document = handle.doc()
  if (!document || typeof document !== 'object') throw new Error(`cold load returned no document: ${url}`)
  return document as PlainDocument
}

async function main(): Promise<void> {
  const { rows: integrityRows } = await pool.query<{
    static_documents: string | number
    static_missing_storage: string | number
    mapped_documents: string | number
    mapped_missing_storage: string | number
    retained_segments: string | number
    retained_segments_missing_storage: string | number
  }>(
    // A content-chunk filter on every one of the three: a 2-byte
    // `<id>/sync-state/<uuid>` row is automerge-repo's own peer bookkeeping,
    // never content, and it satisfies a bare `split_part(key,'/',1) = id` — so
    // without the filter a document whose bytes were never durably written
    // reads as PRESENT.
    //
    // Worse than a blind spot: the row is written the first time a peer merely
    // TRIES to sync a document, so opening a broken diagram is itself what would
    // make it read as present.
    //
    // The filter comes from `automergeStorage.ts` rather than being spelled out
    // here, so it cannot disagree with `workspaceFsck.ts` on the unknown-kind
    // default.
    `SELECT
       (SELECT count(*) FROM read_model_static_documents) AS static_documents,
       (SELECT count(*) FROM read_model_static_documents document
        WHERE NOT EXISTS (
          SELECT 1 FROM automerge_storage storage
          WHERE split_part(storage.key, '/', 1) = document.document_id
            AND ${documentContentChunkFilter('storage.key')}
        )) AS static_missing_storage,
       (SELECT count(*) FROM automerge_document_workspace) AS mapped_documents,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE NOT EXISTS (
          SELECT 1 FROM automerge_storage storage
          WHERE split_part(storage.key, '/', 1) = mapping.document_id
            AND ${documentContentChunkFilter('storage.key')}
        )) AS mapped_missing_storage,
       (SELECT count(*) FROM read_model_overlay_segments) AS retained_segments,
       (SELECT count(*) FROM read_model_overlay_segments segment
        WHERE NOT EXISTS (
          SELECT 1 FROM automerge_storage storage
          WHERE split_part(storage.key, '/', 1) = segment.document_id
            AND ${documentContentChunkFilter('storage.key')}
        )) AS retained_segments_missing_storage`,
  )
  const integrity = integrityRows[0]
  // TWO of the three counters gate the verdict; `mapped_missing_storage` is
  // reported and does not. That asymmetry is deliberate.
  //
  // The reason it is a gauge: `read_model_static_documents` and
  // `read_model_overlay_segments` are MANIFESTS — a row asserts the document
  // exists, so a missing one is a broken promise. `automerge_document_workspace`
  // is an ADMISSION LEDGER, and a row there can legitimately outlive its
  // document (a deleted diagram, a `gcOrphanedDocs` sweep that removed bytes and
  // not the mapping). Throwing on it would go red on a healthy database, and the
  // first response to that would be to weaken the check — which is the outcome
  // this whole file exists to avoid.
  //
  // Before promoting it to a throw, the predicate needs to exclude
  // `storage-adapter-id`, which `workspaceFsck.ts` documents as landing in that
  // table while not being a document at all.
  if (Number(integrity.static_missing_storage) !== 0) throw new Error('a static manifest document is missing storage')
  if (Number(integrity.retained_segments_missing_storage) !== 0) throw new Error('a retained overlay segment is missing storage')

  const { rows: versions } = await pool.query<{
    landscape_id: string
    id: string
    kind: string
    status: string
    root_url: AutomergeUrl
    static_source: string | null
  }>(
    `SELECT version.landscape_id, version.id, version.kind, version.status,
            version.root_url, workspace.source AS static_source
     FROM versions version
     LEFT JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id
      AND workspace.version_id = version.id
     ORDER BY version.landscape_id, version.id`,
  )

  // Cold-load every root and discover its immediate model/registry children.
  for (const version of versions) {
    add(version.root_url, 'root')
    const repo = createRepo()
    try {
      let root: PlainDocument
      try {
        root = await loadOne(repo, version.root_url)
      } catch (error) {
        throw new Error(
          `cold load failed for root ${version.landscape_id}/${version.id} (${version.root_url}): ${String(error)}`,
          { cause: error },
        )
      }
      if (!isStructurallyHealthyRoot(root)) {
        throw new Error(`cold load found a structurally degenerate root: ${version.landscape_id}/${version.id}`)
      }
      add(typeof root.modelUrl === 'string' ? root.modelUrl : undefined, 'model')
      add(typeof root.modelMetaUrl === 'string' ? root.modelMetaUrl : undefined, 'model-meta')
      const registries = Array.isArray(root.shardUrls)
        ? root.shardUrls.filter((url): url is string => typeof url === 'string')
        : []
      // Non-static graphs are small and every registry is loaded. The 30k
      // static baseline is validated in SQL and samples both ends, avoiding the
      // OOM-prone all-registry materialization that selective sync replaced.
      const selected = version.static_source
        ? [...new Set([registries.at(0), registries.at(-1)].filter(Boolean) as string[])]
        : registries
      for (const registry of selected) {
        add(registry, 'registry-sample')
        const owners = registryOwners.get(registry) ?? []
        owners.push(`${version.landscape_id}/${version.id}`)
        registryOwners.set(registry, owners)
      }
    } finally {
      await shutdownReadRepo(repo)
    }
  }

  const { rows: staticControl } = await pool.query<{ segment_url: AutomergeUrl; kind: string }>(
    `SELECT 'automerge:' || document.document_id AS segment_url, document.kind
     FROM read_model_static_documents document
     JOIN versions version
       ON version.landscape_id = document.landscape_id
      AND version.id = document.version_id
     WHERE document.kind IN ('model-meta', 'object-overlay', 'connection-overlay')
        OR (version.kind = 'draft' AND document.kind IN ('root', 'registry-shard', 'registry', 'diagram'))`,
  )
  for (const document of staticControl) add(
    document.segment_url,
    document.kind === 'diagram' ? 'draft-document' : document.kind === 'model-meta' ? 'model-meta' : 'retained-overlay',
  )

  const { rows: segments } = await pool.query<{ segment_url: AutomergeUrl }>(
    'SELECT segment_url FROM read_model_overlay_segments ORDER BY landscape_id, version_id, collection, admitted_at',
  )
  for (const segment of segments) add(segment.segment_url, 'retained-overlay')

  const { rows: activeDiagrams } = await pool.query<{ doc_url: AutomergeUrl }>(
    `WITH ranked AS (
       SELECT diagram.landscape_id, diagram.version_id,
              diagram.data->>'docUrl' AS doc_url,
              row_number() OVER (
                PARTITION BY diagram.landscape_id, diagram.version_id ORDER BY diagram.id
              ) AS first_row,
              row_number() OVER (
                PARTITION BY diagram.landscape_id, diagram.version_id ORDER BY diagram.id DESC
              ) AS last_row,
              diagram.id
       FROM ro_diagrams diagram
       JOIN versions version
         ON version.landscape_id = diagram.landscape_id
        AND version.id = diagram.version_id
       WHERE version.status = 'active'
     )
     SELECT DISTINCT doc_url FROM ranked
     WHERE first_row = 1 OR last_row = 1 OR id IN ('perf-dg-016038', 'perf-dg-029999')`,
  )
  for (const diagram of activeDiagrams) add(diagram.doc_url, 'active-diagram')

  // A selected registry must itself resolve and point at a readable diagram.
  for (const [url, kinds] of [...targets]) {
    if (!kinds.has('registry-sample')) continue
    const repo = createRepo()
    try {
      let registry: PlainDocument
      try {
        registry = await loadOne(repo, url)
      } catch (error) {
        throw new Error(
          `cold load failed for registry sample ${url} `
          + `(owners: ${(registryOwners.get(url) ?? []).join(', ') || 'unknown'}): ${String(error)}`,
          { cause: error },
        )
      }
      const first = Object.values((registry.diagrams ?? {}) as Record<string, { docUrl?: string }>)[0]
      add(first?.docUrl, 'active-diagram')
    } finally {
      await shutdownReadRepo(repo)
    }
  }

  const entries = [...targets.entries()]
  const loaded = new Map<TargetClass, number>()
  for (let offset = 0; offset < entries.length; offset += 12) {
    const repo = createRepo()
    try {
      for (const [url, kinds] of entries.slice(offset, offset + 12)) {
        try {
          await loadOne(repo, url)
        } catch (error) {
          throw new Error(
            `cold load failed for ${url} (${[...kinds].sort().join(', ')}): ${String(error)}`,
            { cause: error },
          )
        }
        for (const kind of kinds) loaded.set(kind, (loaded.get(kind) ?? 0) + 1)
      }
    } finally {
      await shutdownReadRepo(repo)
    }
  }

  console.log(JSON.stringify({
    event: 'maintenance.retained_document_cold_load',
    outcome: 'passed',
    versions: versions.length,
    documentsLoaded: entries.length,
    loadedByClass: Object.fromEntries(loaded),
    integrity: {
      staticDocuments: Number(integrity.static_documents),
      staticMissingStorage: Number(integrity.static_missing_storage),
      mappedDocuments: Number(integrity.mapped_documents),
      mappedMissingStorage: Number(integrity.mapped_missing_storage),
      retainedSegments: Number(integrity.retained_segments),
      retainedSegmentsMissingStorage: Number(integrity.retained_segments_missing_storage),
    },
    note: 'All static manifest rows were checked in SQL; first/last registry shards were materialized for summary-only 30k baselines.',
  }))
}

main()
  .catch((error) => {
    console.error('[retained-document-cold-load] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
