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

import { createHash } from 'node:crypto'
import { isValidAutomergeUrl, type Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { pool } from './db.js'
import {
  assertMaintenanceFence,
  type MaintenanceFence,
} from './maintenance/coordinator.js'
import { cachedHandles, findReadyDocument } from './automergeRepoCompat.js'
import { isDocumentStorageKey } from './automergeStorage.js'
import { envNumber } from './envNumber.js'
import { enumerateMaintainableWorkspaces } from './maintenance/maintainableWorkspaces.js'

/**
 * Mark-and-sweep GC of ORPHANED Automerge documents.
 *
 * Orphans accumulate from deleting versions/landscapes, fork rollbacks, and
 * client-created docs whose registry link never synced. This deletes the storage
 * chunks of any document NOT reachable from a version's root.
 *
 * SAFETY (this destroys storage, so it is deliberately paranoid):
 *  1. MARK COMPLETELY OR ABORT — if any root / modelMeta / registry shard fails to
 *     load, the reachable set is incomplete, so we DELETE NOTHING (a transiently
 *     unreadable root must never make its whole subtree look orphaned).
 *  2. SKIP IN-MEMORY DOCS — a doc the server currently holds is active or was just
 *     created (its registry link may not have synced yet); never delete it.
 *  3. OFF-HOURS — scheduled daily when concurrent doc creation is rare.
 */

interface RootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
}
interface ShardLike { diagrams?: Record<string, { docUrl?: string }> }

/** Storage-key prefix for a doc url: `automerge:<id>` → `<id>`. */
function docIdOf(url: string): string {
  return url.startsWith('automerge:') ? url.slice('automerge:'.length) : url
}

export interface GcResult {
  roots: number
  reachable: number
  stored: number
  deleted: number
  skippedInMemory: number
  /** Unreachable documents still inside the creation/linking grace period. */
  deferredYoung: number
  /** Old, unreachable documents that an apply run would delete. */
  proposedDeletions: number
  /** Stable fingerprint over sorted proposed document ids. */
  candidateDigest: string | null
  /** Present only for an explicitly requested report-only audit. */
  candidateDocumentIds?: string[]
  /** Structured reasons why the reachable set could not be proven complete. */
  incompleteReasons: GcIncompleteReason[]
  reportOnly: boolean
  /** True when marking was incomplete → nothing was deleted (safe abort). */
  aborted: boolean
}

export interface GcIncompleteReason {
  kind: 'unreadable-document' | 'empty-static-manifest' | 'degenerate-root'
    | 'degenerate-model-meta' | 'degenerate-registry-shard'
  url: string
  referencedBy?: string
}

export interface GcOptions {
  db?: Pool
  fence?: MaintenanceFence
  /** Defaults to 24h; 0 is reserved for isolated tests/gates. */
  minimumAgeMs?: number
  now?: Date
  /** Calculate the exact sweep set but never delete. */
  reportOnly?: boolean
  /** Return every candidate id. Valid only together with reportOnly. */
  includeCandidateDocumentIds?: boolean
  /** Apply only if the recomputed candidate set matches the audited digest. */
  expectedCandidateDigest?: string
}

/** Per-document ceiling for the reachability walk. Ten times the interactive
 * default: these are cold loads of arbitrarily large documents, and treating a
 * slow one as missing makes GC refuse to delete anything. */
const BATCH_READ_TIMEOUT_MS = 60_000
const DEFAULT_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000

/** The GC grace period, parsed through `envNumber` because this module DELETES
 * DURABLY.
 *
 * A dangling `GC_MINIMUM_AGE_MS=` makes `Number('')` **0**; a `>= 0` check
 * would accept it and move the cutoff to NOW, silently removing the 24-hour
 * margin that keeps a document created seconds ago — not yet reachable from
 * any root — out of the candidate set.
 *
 * `minimum: 1` rather than 0 on purpose, and the upper bound is 30 days: the
 * runtime parser enforces the range itself because the variable can be set by
 * anything (a compose file, a hand-edited task definition, a `.env`).
 *
 * A caller that genuinely wants no floor passes `options.minimumAgeMs`
 * explicitly, which this function does not touch (the unit tests in
 * `gc.test.ts` use `minimumAgeMs: 0`). */
function configuredMinimumAgeMs(): number {
  return envNumber('GC_MINIMUM_AGE_MS', {
    fallback: DEFAULT_MINIMUM_AGE_MS,
    minimum: 1,
    maximum: 30 * DEFAULT_MINIMUM_AGE_MS,
  })
}

export async function gcOrphanedDocs(repo: Repo, options: GcOptions = {}): Promise<GcResult> {
  const db = options.db ?? pool
  const minimumAgeMs = options.minimumAgeMs ?? configuredMinimumAgeMs()
  const cutoff = new Date((options.now ?? new Date()).getTime() - minimumAgeMs)
  const reachable = new Set<string>()
  const incompleteReasons: GcIncompleteReason[] = []
  const reportOnly = options.reportOnly === true
  if (options.includeCandidateDocumentIds && !reportOnly) {
    throw new Error('includeCandidateDocumentIds requires reportOnly')
  }
  let complete = true
  const add = (url?: string) => {
    if (url && isValidAutomergeUrl(url)) reachable.add(docIdOf(url))
  }
  const read = async (url?: string, referencedBy?: string): Promise<unknown> => {
    if (!url || !isValidAutomergeUrl(url)) return undefined
    try {
      // A BATCH ceiling, not the interactive default. These reads are cold
      // loads from Postgres storage on a repo with no peers, one per referenced
      // document, and a slow-but-present one must not be mistaken for a missing
      // one: the `complete = false` below makes GC delete nothing at all.
      // Bounded all the same, but the walk is serial and does not bail once
      // `complete` is already false, so a workspace with several unreachable
      // documents can spend a minute on each while holding the maintenance
      // lock — the conservative trade-off.
      const handle = await findReadyDocument(repo, url, BATCH_READ_TIMEOUT_MS)
      return handle.doc()
    } catch (err) {
      complete = false // a referenced doc we couldn't read → can't trust the orphan set
      incompleteReasons.push({ kind: 'unreadable-document', url, referencedBy })
      console.warn('[gc] could not read doc (marking incomplete):', url, err)
      return undefined
    }
  }

  // --- MARK: every doc reachable from a version root (+ the legacy primary root) ---
  const rootUrls = new Set<string>()
  const staticRoots = new Map<string, { landscapeId: string; versionId: string }>()
  // The SAME set maintenance sweeps everywhere else. GC marking from
  // a narrower set than fsck inspects would be the worst possible split: a root
  // fsck reports on but GC does not mark from is a root whose documents GC is
  // free to delete.
  for (const workspace of await enumerateMaintainableWorkspaces(db)) rootUrls.add(workspace.rootUrl)
  const { rows: staticSchema } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_static_workspaces') IS NOT NULL AS present`,
  )
  if (staticSchema[0]?.present) {
    const { rows } = await db.query<{
      root_url: string
      landscape_id: string
      version_id: string
    }>(
      `SELECT version.root_url, workspace.landscape_id, workspace.version_id
       FROM read_model_static_workspaces workspace
       JOIN versions version
         ON version.landscape_id = workspace.landscape_id
        AND version.id = workspace.version_id`,
    )
    for (const row of rows) {
      staticRoots.set(row.root_url, {
        landscapeId: row.landscape_id,
        versionId: row.version_id,
      })
    }
  }
  const { rows: meta } = await db.query<{ value: string }>(
    "SELECT value FROM automerge_meta WHERE key = 'root_url'"
  )
  if (meta[0]?.value) rootUrls.add(meta[0].value) // anchor: never GC the legacy workspace

  for (const rootUrl of rootUrls) {
    add(rootUrl)
    const staticWorkspace = staticRoots.get(rootUrl)
    if (staticWorkspace) {
      // Performance baselines deliberately contain registry/model shards large
      // enough to exhaust the Automerge WASM heap when walked by the generic
      // graph marker. Provisioning already records every durable document in a
      // workspace ownership manifest. Treat that SQL manifest as the reachability
      // authority and never materialize a sealed static CRDT here.
      const { rows } = await db.query<{ document_id: string }>(
        `SELECT document_id
         FROM automerge_document_workspace
         WHERE landscape_id = $1 AND version_id = $2
         UNION
         SELECT document_id
         FROM read_model_static_documents
         WHERE landscape_id = $1 AND version_id = $2`,
        [staticWorkspace.landscapeId, staticWorkspace.versionId],
      )
      if (!rows.length) {
        complete = false
        incompleteReasons.push({ kind: 'empty-static-manifest', url: rootUrl })
        console.warn('[gc] static workspace has no SQL document manifest; marking incomplete:', rootUrl)
        continue
      }
      for (const row of rows) add(`automerge:${row.document_id}`)
      continue
    }
    const root = (await read(rootUrl)) as RootLike | undefined
    if (!root) continue // read() already set complete=false
    // STRUCTURAL sanity: a real root always has a model pointer AND ≥1 registry
    // shard. A doc that loads `ready` but degenerate (missing those — e.g. a
    // chunk written mid-flush) would otherwise drop its whole subtree silently;
    // treat it as incomplete so we abort rather than sweep live docs.
    const hasModel =
      (root.modelUrl && isValidAutomergeUrl(root.modelUrl)) ||
      (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl))
    if (!hasModel || !(root.shardUrls && root.shardUrls.length > 0)) {
      complete = false
      incompleteReasons.push({ kind: 'degenerate-root', url: rootUrl })
      console.warn('[gc] root degenerate (no model/shards); marking incomplete:', rootUrl)
      continue
    }
    add(root.modelUrl)
    if (root.modelMetaUrl) {
      add(root.modelMetaUrl)
      const m = (await read(root.modelMetaUrl, rootUrl)) as MetaLike | undefined
      if (!m || m.objectShardUrls === undefined || m.connectionShardUrls === undefined) {
        complete = false
        incompleteReasons.push({
          kind: 'degenerate-model-meta',
          url: root.modelMetaUrl,
          referencedBy: rootUrl,
        })
        console.warn('[gc] modelMeta degenerate (missing shard arrays); marking incomplete:', root.modelMetaUrl)
        continue
      }
      for (const u of m.objectShardUrls) add(u)
      for (const u of m.connectionShardUrls) add(u)
      for (const u of m.decisionRecordShardUrls ?? []) add(u)
      add(m.editsObjectShardUrl)
      add(m.editsConnectionShardUrl)
      for (const u of m.editsObjectShardUrls ?? []) add(u)
      for (const u of m.editsConnectionShardUrls ?? []) add(u)
    }
    for (const shardUrl of root.shardUrls) {
      add(shardUrl)
      const s = (await read(shardUrl, rootUrl)) as ShardLike | undefined
      if (!s || s.diagrams === undefined) {
        complete = false
        incompleteReasons.push({
          kind: 'degenerate-registry-shard',
          url: shardUrl,
          referencedBy: rootUrl,
        })
        console.warn('[gc] registry shard degenerate (missing diagrams); marking incomplete:', shardUrl)
        continue
      }
      for (const d of Object.values(s.diagrams)) add(d.docUrl)
    }
  }

  // Saved landscape-version SNAPSHOTS reference live docs by url + heads
  // and restore by rolling those exact docs back — so their histories must NOT be
  // swept even if the live root stopped referencing them (e.g. a since-deleted
  // diagram). Mark every doc a snapshot manifest names as reachable.
  const { rows: snaprows } = await db.query<{ manifest: { docs?: { url?: string }[] } }>(
    'SELECT manifest FROM landscape_versions'
  )
  for (const row of snaprows) {
    for (const d of row.manifest?.docs ?? []) add(d.url)
  }

  // RETIRED OVERLAY SEGMENTS, retained for offline clients.
  //
  // This root is what makes overlay CHAIN FOLDING safe. The fold REMOVES the
  // folded prefix from `ModelMeta.editsObjectShardUrls` — which, without this
  // root, would hand the whole prefix straight to the sweep below.
  //
  // Losing them is not cosmetic. `forwardHistoricalOverlay` reconciles a client
  // that reconnects with durable edits against a head that rotated while it was
  // offline, and its three-way merge base is the retired segment. Sweeping it
  // inside the retention window turns "your offline edits were merged" into
  // "your offline edits were dropped", silently.
  //
  // Read the predicate carefully — `retain_until IS NULL` means RETAINED, not
  // expired. The column is left NULL on the current head (`publishAdmitted-
  // Rotation`) and on a freshly rotated child (`schema.ts` DEFAULT NULL), so a
  // narrower `retain_until > now()` would be an inert root: it protects neither
  // of those and only ever matches segments the ModelMeta walk already marks.
  // `is_current` is named explicitly for the same reason — cheap, and it does
  // not depend on the walk having reached this workspace's ModelMeta at all.
  //
  // What is deliberately NOT protected: a segment whose window has EXPIRED.
  // That expiry is the only thing that ever bounds overlay storage — see the
  // fold's own header for what it does and does not bound.
  //
  // `'automerge:' + document_id`, never `segment_url`: `add()` runs
  // `isValidAutomergeUrl` first and silently drops anything decorated.
  const { rows: overlaySchema } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_overlay_segments') IS NOT NULL AS present`,
  )
  if (overlaySchema[0]?.present) {
    // JOINED to `versions`, like the two other marks in this file. The table has
    // no foreign key, `deleteVersion` touches only `versions`, and NOTHING in
    // `server/src` ever deletes a `read_model_overlay_segments` row — so without
    // the join, the current head of every deleted version stays pinned for ever
    // (`is_current` true, `retain_until` NULL) with no operator lever to release
    // it. A reachability root must not outlive the thing it makes reachable.
    const { rows: retainedOverlays } = await db.query<{ document_id: string }>(
      `SELECT segment.document_id
         FROM read_model_overlay_segments segment
         JOIN versions version
           ON version.landscape_id = segment.landscape_id
          AND version.id = segment.version_id
        WHERE segment.is_current
           OR segment.retain_until IS NULL
           OR segment.retain_until > now()`
    )
    // Zero rows is NORMAL — a park with no promoted workspace has no overlay
    // history — so this must never set `complete = false`. The neighbouring
    // `empty-static-manifest` guard above does the opposite ON PURPOSE: there,
    // an empty answer contradicts a root that exists.
    for (const row of retainedOverlays) add(`automerge:${row.document_id}`)
  }

  // Inventory storage even on an incomplete mark. Operators need the real
  // cardinality to repair the graph, while candidates remain deliberately
  // empty until completeness is proven.
  const { rows: storageRows } = await db.query<{ doc: string; updated_at: Date | string }>(
    `SELECT split_part(key, '/', 1) AS doc, MAX(updated_at) AS updated_at
     FROM automerge_storage
     GROUP BY split_part(key, '/', 1)`
  )
  // Not every key prefix is a document. `storage-adapter-id` is automerge-repo's
  // own per-repo identity (see `isDocumentStorageKey`), so NOTHING can ever make
  // it reachable; without this filter any complete sweep would DELETE it,
  // forcing the repo to mint a new identity on the next boot.
  const srows = storageRows.filter((row) => isDocumentStorageKey(row.doc))

  // Never sweep with a partial reachable set — that would delete live docs.
  if (!complete) {
    return {
      roots: rootUrls.size,
      reachable: reachable.size,
      stored: srows.length,
      deleted: 0,
      skippedInMemory: 0,
      deferredYoung: 0,
      proposedDeletions: 0,
      candidateDigest: null,
      incompleteReasons,
      reportOnly,
      aborted: true,
    }
  }

  // --- SWEEP: stored docs neither reachable nor currently held in memory ---
  // `cachedHandles`, and NEVER `syncedHandle`: below, absence from this set is
  // a licence to DELETE the document durably. The cache is the only authority
  // that may answer that question, and one O(n) read per GC pass is the right
  // price for it.
  const inMemory = new Set(Object.values(cachedHandles(repo)).map((h) => docIdOf(h.url)))
  let skippedInMemory = 0
  let deferredYoung = 0
  const candidates: string[] = []
  for (const { doc, updated_at: updatedAt } of srows) {
    if (reachable.has(doc)) continue
    if (inMemory.has(doc)) { skippedInMemory++; continue }
    if (new Date(updatedAt).getTime() > cutoff.getTime()) { deferredYoung++; continue }
    candidates.push(doc)
  }

  candidates.sort()
  const candidateDigest = candidates.length > 0
    ? createHash('sha256').update(candidates.join('\n')).digest('hex')
    : null
  if (!reportOnly && options.expectedCandidateDigest !== undefined) {
    if (candidateDigest !== options.expectedCandidateDigest) {
      throw new Error(
        `GC candidate digest changed: expected ${options.expectedCandidateDigest}, got ${candidateDigest ?? 'none'}`,
      )
    }
  }

  let deleted = 0
  for (let offset = 0; !reportOnly && offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (options.fence) await assertMaintenanceFence(client, options.fence)
      const { rows: deletedRows } = await client.query<{ doc: string }>(
        `DELETE FROM automerge_storage
         WHERE split_part(key, '/', 1) = ANY($1::text[])
         RETURNING split_part(key, '/', 1) AS doc`,
        [batch],
      )
      // The workspace-admission row dies WITH the storage, in the same
      // transaction. Left behind, it is a permanent ghost: `fsck
      // document-orphaned` would flag a document that no longer exists at all,
      // and nothing else ever revisits the row.
      await client.query(
        `DELETE FROM automerge_document_workspace WHERE document_id = ANY($1::text[])`,
        [batch],
      )
      // Same rule for the arrival-watermark rows: a watermark for a
      // document with no storage describes nothing and would sit forever.
      await client.query(
        `DELETE FROM read_model_document_watermarks WHERE document_id = ANY($1::text[])`,
        [batch],
      )
      await client.query('COMMIT')
      deleted += new Set(deletedRows.map(({ doc }) => doc)).size
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  return {
    roots: rootUrls.size,
    reachable: reachable.size,
    stored: srows.length,
    deleted,
    skippedInMemory,
    deferredYoung,
    proposedDeletions: candidates.length,
    candidateDigest,
    ...(options.includeCandidateDocumentIds ? { candidateDocumentIds: candidates } : {}),
    incompleteReasons,
    reportOnly,
    aborted: false,
  }
}
