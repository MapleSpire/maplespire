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

import { isValidAutomergeUrl, type Repo } from '@automerge/automerge-repo'
import { getHeads } from '@automerge/automerge'
import type { WorkspaceKey } from './readModel/projector.js'
import { findReadyDocument } from './automergeRepoCompat.js'

/**
 * Server-side lookup of a diagram doc's current Automerge heads
 * ("fresh-on-load").
 *
 * A boot-from-server client draws a diagram's shape positions from its LOCAL
 * (IndexedDB) copy of the per-diagram Automerge doc, which `repo.find().whenReady()`
 * resolves from disk BEFORE the WebSocket has delivered the server's newer copy —
 * so a warm-but-stale client paints old positions for ~1-2s until sync lands, then
 * snaps. To avoid painting stale, the client compares its local doc's heads to the
 * server's (returned here) and only holds the boot loader when it is actually
 * behind.
 *
 * The diagram's doc url is resolved SERVER-SIDE from the workspace-scoped read
 * model (or the registry only when READ_MODEL=off), so a caller can only ever
 * obtain heads for a diagram in a workspace it was already granted. The route
 * uses the same access check as `/api/automerge/root`; the raw doc url is never
 * trusted from the client.
 */

interface RootLike {
  shardUrls?: string[]
}

interface Queryable {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>
}
interface ShardLike {
  diagrams?: Record<string, { docUrl?: string }>
}

async function readDoc(repo: Repo, url: string): Promise<unknown | null> {
  if (!isValidAutomergeUrl(url)) return null
  try {
    const handle = await findReadyDocument(repo, url)
    return handle.doc() ?? null
  } catch {
    // Unavailable/unknown doc — treat as "not found" rather than throwing.
    return null
  }
}

/**
 * Resolve the one DiagramDoc URL from the bounded PostgreSQL read model. This
 * is the production path when READ_MODEL=on: a late diagram in a 30k registry
 * must not materialize every preceding Automerge registry shard just to obtain
 * its freshness heads.
 */
export async function resolveDiagramDocUrlFromReadModel(
  db: Queryable,
  key: WorkspaceKey,
  diagramId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ doc_url: string | null }>(
    `SELECT COALESCE(
       (SELECT NULLIF(diagram.data->>'docUrl', '')
        FROM ro_diagrams diagram
        WHERE diagram.landscape_id = $1
          AND diagram.version_id = $2
          AND diagram.id = $3),
       (SELECT 'automerge:' || document.document_id
        FROM read_model_static_documents document
        WHERE document.landscape_id = $1
          AND document.version_id = $2
          AND document.kind = 'diagram'
          AND document.entity_id = $3
        LIMIT 1)
     ) AS doc_url`,
    [key.landscapeId, key.versionId, diagramId],
  )
  const docUrl = rows[0]?.doc_url
  return docUrl && isValidAutomergeUrl(docUrl) ? docUrl : null
}

/** Legacy READ_MODEL=off fallback: walk the workspace registry shards. */
export async function resolveDiagramDocUrlFromRegistry(repo: Repo, rootUrl: string, diagramId: string): Promise<string | null> {
  const root = (await readDoc(repo, rootUrl)) as RootLike | null
  if (!root) return null
  for (const shardUrl of root.shardUrls ?? []) {
    const shard = (await readDoc(repo, shardUrl)) as ShardLike | null
    const docUrl = shard?.diagrams?.[diagramId]?.docUrl
    if (docUrl && isValidAutomergeUrl(docUrl)) return docUrl
  }
  return null
}

/**
 * The server's current heads for a diagram doc within a workspace root, as RAW
 * hex change hashes (`getHeads`, NOT the repo-tagged `handle.heads()` — only the
 * raw hashes are comparable to the client's own `getHeads`). Returns null when the
 * diagram (or its doc) can't be resolved.
 */
export async function diagramDocHeads(repo: Repo, docUrl: string): Promise<string[] | null> {
  if (!isValidAutomergeUrl(docUrl)) return null
  const doc = await readDoc(repo, docUrl)
  if (!doc) return null
  return getHeads(doc as never)
}
