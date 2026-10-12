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
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { gcOrphanedDocs } from '../src/gc.js'

async function main(): Promise<void> {
  const repo = new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }) })
  try {
    const result = await gcOrphanedDocs(repo, {
      db: pool,
      reportOnly: true,
      includeCandidateDocumentIds: true,
    })
    if (result.aborted) {
      console.log(JSON.stringify({ event: 'maintenance.global_gc_audit', result }))
      process.exitCode = 1
      return
    }
    const candidates = result.candidateDocumentIds ?? []
    const { rows } = await pool.query<{
      total: string | number
      mapped: string | number
      static_documents: string | number
      overlay_segments: string | number
      version_roots: string | number
      snapshot_documents: string | number
      draft_base_documents: string | number
      total_bytes: string | number
      oldest_at: string | Date | null
      newest_at: string | Date | null
    }>(
      `WITH candidate(document_id) AS (SELECT unnest($1::text[]))
       SELECT count(*) AS total,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM automerge_document_workspace mapping
           WHERE mapping.document_id = candidate.document_id
         )) AS mapped,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM read_model_static_documents document
           WHERE document.document_id = candidate.document_id
         )) AS static_documents,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM read_model_overlay_segments segment
           WHERE segment.document_id = candidate.document_id
         )) AS overlay_segments,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM versions version
           WHERE replace(version.root_url, 'automerge:', '') = candidate.document_id
         )) AS version_roots,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM landscape_versions snapshot
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.manifest->'docs', '[]'::jsonb)) document
           WHERE replace(COALESCE(document->>'url', ''), 'automerge:', '') = candidate.document_id
         )) AS snapshot_documents,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM versions draft
           CROSS JOIN LATERAL jsonb_path_query(COALESCE(draft.base_manifest, '{}'::jsonb), '$.**.url') reference
           WHERE replace(trim(both '"' from reference::text), 'automerge:', '') = candidate.document_id
         )) AS draft_base_documents,
         COALESCE(sum(storage.bytes), 0) AS total_bytes,
         min(storage.updated_at) AS oldest_at,
         max(storage.updated_at) AS newest_at
       FROM candidate
       LEFT JOIN (
         SELECT split_part(key, '/', 1) AS document_id,
                sum(octet_length(data)) AS bytes,
                max(updated_at) AS updated_at
         FROM automerge_storage GROUP BY split_part(key, '/', 1)
       ) storage USING (document_id)`,
      [candidates],
    )
    const audit = rows[0]
    const protectedReferences = Number(audit.static_documents)
      + Number(audit.overlay_segments)
      + Number(audit.version_roots)
      + Number(audit.snapshot_documents)
      + Number(audit.draft_base_documents)
    console.log(JSON.stringify({
      event: 'maintenance.global_gc_audit',
      result: { ...result, candidateDocumentIds: undefined },
      classification: {
        ...audit,
        total: Number(audit.total),
        mapped: Number(audit.mapped),
        staticDocuments: Number(audit.static_documents),
        overlaySegments: Number(audit.overlay_segments),
        versionRoots: Number(audit.version_roots),
        snapshotDocuments: Number(audit.snapshot_documents),
        draftBaseDocuments: Number(audit.draft_base_documents),
        totalBytes: Number(audit.total_bytes),
        protectedReferences,
      },
    }))
    if (Number(audit.total) !== result.proposedDeletions || protectedReferences > 0) process.exitCode = 1
  } finally {
    await repo.shutdown()
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[global-gc-audit] failed:', error)
  process.exitCode = 1
})
