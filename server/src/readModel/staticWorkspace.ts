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

import { withAtomicStatements } from './queryableShape.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

type StaticDocument = { documentId: string; kind: string; entityId?: string }

const STATIC_QUERY_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.STATIC_WORKSPACE_CACHE_TTL_MS ?? 30_000) || 0,
)
const staticQueryCache = new WeakMap<object, Map<string, {
  expiresAt: number
  queryKey: WorkspaceKey
}>>()

function staticCacheFor(db: Queryable): Map<string, { expiresAt: number; queryKey: WorkspaceKey }> {
  const owner = db as object
  let cache = staticQueryCache.get(owner)
  if (!cache) {
    cache = new Map()
    staticQueryCache.set(owner, cache)
  }
  return cache
}

/**
 * Static-workspace documents still travel through the Automerge transport.
 * The read-model allow-list is therefore only half of the publication
 * contract: every listed document must also have a durable workspace owner or
 * selective sync will reject it. Keep the two registries populated together
 * so a caller cannot publish a root/registry/DiagramDoc that the WebSocket
 * layer is unable to serve.
 */
async function registerDocumentWorkspaceAssignments(
  db: Queryable,
  key: WorkspaceKey,
  documents: readonly StaticDocument[],
): Promise<void> {
  if (!documents.length) return
  await db.query(
    `INSERT INTO automerge_document_workspace (
       document_id, landscape_id, version_id
     )
     SELECT item."documentId", version.landscape_id, version.id
     FROM jsonb_to_recordset($1::jsonb) AS item("documentId" text)
     JOIN versions version
       ON version.landscape_id = $2 AND version.id = $3
     ON CONFLICT (document_id) DO NOTHING`,
    [JSON.stringify(documents), key.landscapeId, key.versionId],
  )
}

export async function isStaticReadModelWorkspace(
  db: Queryable,
  key: WorkspaceKey,
): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM read_model_static_workspaces
       WHERE landscape_id = $1 AND version_id = $2
     ) AS present`,
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.present === true
}

/** Baseline identity, not a mutation generation. It changes on every re-seed so
 * an old L1/L2 entry can never answer a new immutable baseline that happens to
 * reuse render generation zero. */
export async function staticReadModelWorkspaceEpoch(
  db: Queryable,
  key: WorkspaceKey,
): Promise<string | undefined> {
  const { rows } = await db.query<{ baseline_epoch: string }>(
    `SELECT created_at::text AS baseline_epoch
     FROM read_model_static_workspaces
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.baseline_epoch
}

/** A sparse draft reads the parent's pre-materialized baseline and overlays its
 * own bounded Automerge changes client-side. Ordinary static workspaces return
 * themselves. */
export async function staticReadModelQueryWorkspaceIfPresent(
  db: Queryable,
  key: WorkspaceKey,
): Promise<WorkspaceKey | undefined> {
  const cacheKey = `${key.landscapeId}\0${key.versionId}`
  const cache = staticCacheFor(db)
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.queryKey
  if (cached) cache.delete(cacheKey)
  const { rows } = await db.query<{ base_version_id: string | null }>(
    `SELECT base_version_id
     FROM read_model_static_workspaces
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  // Cache only positive identities. A new seed or draft therefore becomes
  // visible immediately; the immutable/static mapping itself is refreshed on
  // a short TTL to bound staleness after an external maintenance process.
  if (!rows.length) return undefined
  const baseVersionId = rows[0].base_version_id
  const queryKey = baseVersionId ? { landscapeId: key.landscapeId, versionId: baseVersionId } : key
  if (STATIC_QUERY_CACHE_TTL_MS > 0) {
    cache.set(cacheKey, { queryKey, expiresAt: Date.now() + STATIC_QUERY_CACHE_TTL_MS })
  }
  return queryKey
}

export async function staticReadModelQueryWorkspace(
  db: Queryable,
  key: WorkspaceKey,
): Promise<WorkspaceKey> {
  return (await staticReadModelQueryWorkspaceIfPresent(db, key)) ?? key
}

/**
 * Publish the workspace as STATIC, with its complete allow-list, ATOMICALLY.
 *
 * The atomicity is not the caller's job. These statements DELETE the whole
 * allow-list before re-inserting it, and a reader that lands in between sees a
 * static workspace with an EMPTY one — three different wrong answers at once:
 *
 *  - `resolveDurable` (`rbac/docScope.ts`) is `if (static_source &&
 *    !static_allowed) return null`, so EVERY document of the workspace loses
 *    its route and the gate DENIES it — and automerge-repo caches a deny per
 *    (document, peer);
 *  - `isFencedDocument` answers from `rows.some(...)`, so no rows means NOT
 *    FENCED, and inbound mutations of a frozen baseline shard are accepted. The
 *    wrong verdict is cached per document for `BASELINE_FENCE_TTL_MS`, so the
 *    damage outlives the SQL window;
 *  - the read-model enqueue CTEs in `automergeStorage.ts` JOIN both tables, so
 *    a storage write landing in the window is durable and never enqueued.
 *
 * Some callers run this on a bare Pool, so it opens its own transaction.
 *
 * A re-seed via `clearWorkspace` arrives with the allow-list already empty
 * (`read_model_static_documents_workspace_fk` cascades), but a re-mark that
 * does not clear first still replaces a previous allow-list, so the atomicity
 * remains necessary.
 */
export async function markStaticReadModelWorkspace(
  db: Queryable,
  key: WorkspaceKey,
  source = 'performance-seed',
  allowedDocuments: readonly StaticDocument[] = [],
  baseVersionId: string | null = null,
): Promise<void> {
  await withAtomicStatements(db, async (tx) => {
    await markStaticReadModelWorkspaceInTransaction(tx, key, source, allowedDocuments, baseVersionId)
  })
}

async function markStaticReadModelWorkspaceInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  source: string,
  allowedDocuments: readonly StaticDocument[],
  baseVersionId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source, base_version_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (landscape_id, version_id) DO UPDATE
     SET source = EXCLUDED.source,
         base_version_id = EXCLUDED.base_version_id,
         created_at = now()`,
    [key.landscapeId, key.versionId, source, baseVersionId],
  )
  if (!allowedDocuments.length) {
    await db.query(
      `DELETE FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    )
    return
  }
  // ORDER: `automerge_document_workspace` (W) BEFORE
  // `read_model_static_documents` (D), and it is a lock order, not a
  // preference. Within one transaction no reader can see either ordering, and
  // there is no data dependency — the assignment insert reads the JS argument,
  // not the rows above it. What it buys is that every writer of this pair
  // acquires them the same way round.
  //
  // The promotion's step 3 takes W first (`claimWorkspaceDocuments` on the
  // fresh write head) and then reaches D through this function. A static
  // publish reaches both through `registerStaticReadModelDocuments`. With D
  // first here, those two transactions took the pair in opposite orders — a
  // straight ABBA on a re-promotion, where they genuinely overlap, and nothing
  // shared a mutex to prevent it.
  await registerDocumentWorkspaceAssignments(db, key, allowedDocuments)
  await db.query(
    `DELETE FROM read_model_static_documents
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  await db.query(
    `INSERT INTO read_model_static_documents (
       landscape_id, version_id, document_id, kind, entity_id
     )
     SELECT $2, $3, item."documentId", item.kind, item."entityId"
     FROM jsonb_to_recordset($1::jsonb) AS item(
       "documentId" text, kind text, "entityId" text
     )
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET kind = EXCLUDED.kind, entity_id = EXCLUDED.entity_id`,
    [JSON.stringify(allowedDocuments), key.landscapeId, key.versionId],
  )
}

/** Register newly rotated overlay documents without replacing the existing
 * allow-list. ModelMeta is authoritative for these references; registering the
 * URL before resolving it avoids the static-workspace upload deadlock. */
export async function registerStaticReadModelDocuments(
  db: Queryable,
  key: WorkspaceKey,
  documents: readonly StaticDocument[],
): Promise<void> {
  if (!documents.length) return
  // Two statements, and the allow-list row must never be visible without the
  // workspace assignment that lets the transport serve it — that pairing is
  // this module's whole contract, stated at the top of
  // `registerDocumentWorkspaceAssignments`. Several call sites (in `server/src`
  // and `server/scripts`) run this on a bare pool, so the transaction belongs
  // here rather than with them.
  await withAtomicStatements(db, async (tx) => {
    await registerStaticReadModelDocumentsInTransaction(tx, key, documents)
  })
}

async function registerStaticReadModelDocumentsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  documents: readonly StaticDocument[],
): Promise<void> {
  // THE AUTHORITY ROW FIRST, and this statement is load-bearing rather than
  // defensive — it is what keeps this function inside the global
  // S → W → D order once the allow-list has a foreign key.
  //
  // `read_model_static_documents_workspace_fk` makes the D write take key share
  // on the workspace row, and the RI check is an AFTER-ROW trigger that fires at
  // END OF STATEMENT. So without this line the real order is D → S: the INSERT
  // locks allow-list rows as it processes tuples and only then asks for the
  // parent. Against a demotion, which takes the workspace row and then reaches
  // the allow-list through the cascade, that is an ABBA on one workspace with no
  // fan-out needed.
  //
  // Measured with 30 000 allow-list rows, 18 trials per arm: a batch MIXING
  // existing and new rows (the production shape — a rotation re-registers
  // documents alongside the one it just minted) deadlocked 18/18 without this
  // line, with the DEMOTION as victim, and 0/18 with it. A batch of existing
  // rows only never deadlocks (a non-key UPDATE skips the FK check). The
  // demotion is the expensive victim: `40P01` reaches it AFTER it has reverted
  // and flushed the root.
  await db.query(
    `SELECT 1 FROM read_model_static_workspaces
      WHERE landscape_id = $1 AND version_id = $2
      FOR KEY SHARE`,
    [key.landscapeId, key.versionId],
  )
  // W before D, the same lock order as `markStaticReadModelWorkspaceInTransaction`
  // — see the paragraph there. These two functions are the only writers of the
  // pair, so if they disagree the order is not an order.
  await registerDocumentWorkspaceAssignments(db, key, documents)
  await db.query(
    `INSERT INTO read_model_static_documents (
       landscape_id, version_id, document_id, kind, entity_id
     )
     SELECT $2, $3, item."documentId", item.kind, item."entityId"
     FROM jsonb_to_recordset($1::jsonb) AS item(
       "documentId" text, kind text, "entityId" text
     )
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET kind = EXCLUDED.kind, entity_id = COALESCE(EXCLUDED.entity_id,
       read_model_static_documents.entity_id)`,
    [JSON.stringify(documents), key.landscapeId, key.versionId],
  )
}
