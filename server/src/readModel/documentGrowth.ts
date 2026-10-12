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

// How large the hot documents are getting, and how many are EMPTY.
//
// 1. Growth. Nothing in the product bounds an Automerge op log, and the
//    whole-document operations that DO scale with history (A.load, joiner
//    catch-up, storage compaction) are on the boot, takeover and admission
//    paths. Stored bytes per document is the early-warning signal for that,
//    and it is observable without touching Automerge at all.
//
// 2. Empty documents. A document can be mapped to a workspace, advertised in
//    the registry, and hold NO data chunks — if projected into `ro_diagrams`
//    it is listed in the UI and unopenable. Some carry a lone `/sync-state/`
//    row, which every `EXISTS(split_part(key,'/',1) = document_id)` predicate
//    in this codebase counts as content, so those checks miss them.
//
// The aggregate is a full scan of `automerge_storage` (`split_part` defeats any
// index), so it is sampled on a timer and cached: expensive work on a scrape
// path can build an unbounded synchronous backlog on a hot cell (see
// `automergeTransportTelemetry`). Never call this from a request handler.

import type { Pool } from 'pg'

export interface DocumentGrowthSnapshot {
  /** When the sample was taken; null before the first one. A stale sample must
   * be visibly stale rather than silently presented as current. */
  sampledAt: string | null
  documentsWithChunks: number
  /** Mapped to a workspace but holding no snapshot/incremental chunk at all. */
  documentsEmpty: number
  /** Mapped, and holding ONLY a sync-state chunk — these pass the codebase's
   * "is it stored?" predicates and then fail to load. */
  documentsSyncStateOnly: number
  totalBytes: number
  maxDocumentBytes: number
  maxDocumentIncrementals: number
  sampleDurationMs: number | null
}

const EMPTY: DocumentGrowthSnapshot = {
  sampledAt: null,
  documentsWithChunks: 0,
  documentsEmpty: 0,
  documentsSyncStateOnly: 0,
  totalBytes: 0,
  maxDocumentBytes: 0,
  maxDocumentIncrementals: 0,
  sampleDurationMs: null,
}

let current: DocumentGrowthSnapshot = EMPTY

export function documentGrowthSnapshot(): DocumentGrowthSnapshot {
  return current
}

/** One scan, three answers. Kept as a single statement so the three counts are
 * consistent with each other — running them separately would let a concurrent
 * write make "empty" and "with chunks" disagree. */
export async function sampleDocumentGrowth(pool: Pool): Promise<DocumentGrowthSnapshot> {
  const startedAt = Date.now()
  const { rows } = await pool.query<{
    documents_with_chunks: string
    documents_empty: string
    documents_sync_state_only: string
    total_bytes: string | null
    max_document_bytes: string | null
    max_document_incrementals: string | null
  }>(
    `WITH per_document AS (
       SELECT split_part(s.key, '/', 1) AS document_id,
              count(*) FILTER (WHERE split_part(s.key, '/', 2) IN ('snapshot', 'incremental')) AS data_chunks,
              count(*) FILTER (WHERE split_part(s.key, '/', 2) = 'incremental') AS incrementals,
              sum(octet_length(s.data)) AS bytes
       FROM automerge_storage s
       GROUP BY 1
     ),
     mapped AS (
       SELECT d.document_id, COALESCE(p.data_chunks, 0) AS data_chunks,
              COALESCE(p.bytes, 0) AS bytes, COALESCE(p.incrementals, 0) AS incrementals,
              p.document_id IS NOT NULL AS has_any_row
       FROM automerge_document_workspace d
       LEFT JOIN per_document p ON p.document_id = d.document_id
     )
     SELECT
       count(*) FILTER (WHERE data_chunks > 0)::text AS documents_with_chunks,
       count(*) FILTER (WHERE NOT has_any_row)::text AS documents_empty,
       count(*) FILTER (WHERE has_any_row AND data_chunks = 0)::text AS documents_sync_state_only,
       COALESCE(sum(bytes), 0)::text AS total_bytes,
       COALESCE(max(bytes), 0)::text AS max_document_bytes,
       COALESCE(max(incrementals), 0)::text AS max_document_incrementals
     FROM mapped`,
  )

  const row = rows[0]
  current = {
    sampledAt: new Date().toISOString(),
    documentsWithChunks: Number(row?.documents_with_chunks ?? 0),
    documentsEmpty: Number(row?.documents_empty ?? 0),
    documentsSyncStateOnly: Number(row?.documents_sync_state_only ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
    maxDocumentBytes: Number(row?.max_document_bytes ?? 0),
    maxDocumentIncrementals: Number(row?.max_document_incrementals ?? 0),
    sampleDurationMs: Date.now() - startedAt,
  }
  return current
}

/** Start the periodic sampler. Returns a stop function.
 *
 * A failed sample leaves the previous snapshot in place and logs — publishing
 * zeros on a transient database error would read as "every document is empty",
 * which is the alarm this gauge exists to raise.
 */
export function startDocumentGrowthSampler(pool: Pool, intervalMs = 60_000): () => void {
  let stopped = false
  const run = async () => {
    if (stopped) return
    try {
      await sampleDocumentGrowth(pool)
    } catch (error) {
      console.warn('[document-growth] sample failed, keeping the previous snapshot:', error)
    }
  }
  void run()
  const timer = setInterval(() => { void run() }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
