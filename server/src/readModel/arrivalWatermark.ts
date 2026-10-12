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
 * The minted arrival watermark — the ORDER the absence proof compares.
 * Wall-clock timestamps cannot be used: they do not carry commit order.
 *
 * The clock is `automerge_arrival_seq`, stamped by the storage adapter on
 * every durable chunk write. A projection CAPTURES a value from the same
 * sequence around its sampling and RECORDS it per source document at
 * completion, inside the projection's own transaction. The proof for a
 * document is then `projected_watermark ≥ max(arrival_seq)` — a pure integer
 * order.
 *
 * The ordinary projection protocol against the projector's OWN writes:
 *  1. sample and flush the document;
 *  2. OUTSIDE the projection transaction, capture `wPost`, drain pending
 *     document saves without starting a write, and read all durable content
 *     chunks in one PostgreSQL statement snapshot. Reconstruct their heads
 *     directly, without touching Repo's SavedHeads or chunkInfos caches;
 *  3. inside the fenced projection transaction, certify only when every
 *     sample of a document matches BOTH those durable heads and the current
 *     runtime heads. Write exactly `wPost` on equality, otherwise invalidate
 *     the previous certificate with 0. A pre-sample sequence capture is NOT
 *     a safe floor: a save can mint its sequence before that capture yet
 *     commit an unseen revision after the sample. These writes are exact,
 *     not monotone, because neither a previous positive certificate nor a
 *     newer sequence certifies the rows THIS transaction just projected.
 *
 * A delayed save must not acquire a new admission/token merely to verify a
 * projection. Preparation never writes, deletes or compacts storage chunks.
 * A durable read newer than wPost may under-promise, never extend the claim
 * past the captured sequence. Missing durable chunks cannot earn an upgrade;
 * malformed chunks make preparation fail rather than certify a partial load.
 *
 * Watermarks are BIGINT and cross the pg driver as strings; they are compared
 * ONLY in SQL and never coerced to Number here.
 *
 * SINGLE-WRITER INVARIANT: the runtime-heads argument holds only for arrivals
 * that pass through THIS process's repo — a foreign process writing content
 * chunks for the same document would mint sequences our heads never reflect,
 * and wPost would over-cover them. What holds that invariant: sync-cell
 * ownership fencing rejects a stale cell's storage mutations, and the
 * row-write fence (`assertReadModelWriteFence`, health.ts) rolls back the
 * WHOLE projection transaction of any instance that no longer holds the
 * workspace's `write_fence`, watermark rows included. A second writer OUTSIDE
 * that regime (e.g. a server-rs peer sharing the table without fencing) would
 * still break the heads argument — mirror the fencing AND the fence before
 * mirroring the clock.
 */

import { durableHeadsDecoder } from './durableHeadsDecoder.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'

/** Consume one value from the arrival clock. Monotone across the fleet's
 * writers because it is the SAME sequence the storage adapter stamps. */
export async function captureArrivalWatermark(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ w: string }>(
    `SELECT nextval('automerge_arrival_seq')::text AS w`,
  )
  return rows[0].w
}

export function headsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((head, index) => head === b[index])
}

export interface DocumentWatermarkProofTarget {
  documentId: string
  /** Wait for actual writes already in flight; do not start a new save. */
  drainPendingSaves: () => Promise<void>
}

export interface PreparedDocumentWatermarks {
  watermarkPost: string
  /** Missing IDs have no durable content and cannot earn an upgrade. */
  durableHeadsById: ReadonlyMap<string, readonly string[]>
}

/** Prepare before opening the projection transaction. One SELECT observes all
 * snapshots and incrementals coherently even if compaction overlaps it. The
 * document-ID equality can use the existing split_part expression indexes;
 * unlike a '/'..'0' key range, it does not depend on the database collation.
 * sync-state is excluded.
 * Decode without Repo.loadDoc so neither SavedHeads nor chunkInfos changes. */
export async function prepareDocumentWatermarkProofs(
  db: Queryable,
  documents: readonly DocumentWatermarkProofTarget[],
): Promise<PreparedDocumentWatermarks> {
  const watermarkPost = await captureArrivalWatermark(db)
  const drained = await Promise.allSettled(documents.map(document =>
    Promise.resolve().then(() => document.drainPendingSaves())))
  const rejected = drained.find(result => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  const documentIds = [...new Set(documents.map(document => document.documentId))].sort()
  const durableHeadsById = new Map<string, readonly string[]>()
  if (!documentIds.length) return { watermarkPost, durableHeadsById }
  // Neither a drain nor SQL holds the process-wide decoder. One workspace's
  // suspended storage operation must not prevent another from decoding.
  const { rows } = await db.query<{ document_id: string; data: Uint8Array }>(
    `SELECT documents.document_id, storage.data
     FROM unnest($1::text[]) AS documents(document_id)
     JOIN automerge_storage AS storage
       ON split_part(storage.key, '/', 1) = documents.document_id
     WHERE split_part(storage.key, '/', 2) IN ('snapshot', 'incremental')
     ORDER BY documents.document_id,
       CASE split_part(storage.key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END,
       storage.key`,
    [documentIds],
  )
  const chunksById = new Map<string, Uint8Array[]>()
  for (const row of rows) {
    if (!(row.data instanceof Uint8Array)) throw new Error(`invalid durable chunk bytes: ${row.document_id}`)
    const chunks = chunksById.get(row.document_id) ?? []
    chunks.push(row.data)
    chunksById.set(row.document_id, chunks)
  }
  for (const documentId of documentIds) {
    const chunks = chunksById.get(documentId)
    if (!chunks?.length) continue
    durableHeadsById.set(documentId, await durableHeadsDecoder.decode(documentId, chunks))
  }
  return { watermarkPost, durableHeadsById }
}

/**
 * Record a prepared proof atomically with its projected rows. No capture,
 * drain or durable chunk read belongs in this transaction: only the runtime
 * heads recheck and the intersection of sampled/durable/current revisions.
 */
export async function recordSampledDocumentWatermark(
  tx: Queryable,
  key: WorkspaceKey,
  documentId: string,
  sampledHeads: readonly string[] | null,
  readCurrentHeads: () => readonly string[] | null,
  prepared: PreparedDocumentWatermarks,
): Promise<void> {
  let watermark = '0'
  if (sampledHeads) {
    const durableHeads = prepared.durableHeadsById.get(documentId)
    const currentHeads = readCurrentHeads()
    if (durableHeads && currentHeads && headsEqual(currentHeads, sampledHeads)
      && headsEqual(durableHeads, sampledHeads)) watermark = prepared.watermarkPost
  }
  await replaceProjectedWatermarks(tx, key, [documentId], watermark)
}

/** Cold extraction can sample one document through several shard references.
 * Upgrade that document only when EVERY sampled reference still matches. The
 * durable proof is prepared before entering the fenced transaction. Runtime
 * getters must refuse handles replaced or removed since extraction. */
export async function recordSampledDocumentWatermarks(
  tx: Queryable,
  key: WorkspaceKey,
  documents: readonly {
    documentId: string
    sampledHeads: readonly string[] | null
    readCurrentHeads: () => readonly string[] | null
  }[],
  prepared: PreparedDocumentWatermarks,
): Promise<void> {
  if (!documents.length) return
  const stableById = new Map<string, boolean>()
  for (const document of documents) {
    const durableHeads = prepared.durableHeadsById.get(document.documentId)
    const currentHeads = document.readCurrentHeads()
    const stable = document.sampledHeads !== null && currentHeads !== null && durableHeads !== undefined
      && headsEqual(document.sampledHeads, currentHeads)
      && headsEqual(document.sampledHeads, durableHeads)
    stableById.set(document.documentId, (stableById.get(document.documentId) ?? true) && stable)
  }
  // First invalidate and lock every row in the usual sorted order; the exact
  // certificates only revisit rows already held by this transaction. A mixed
  // alias cannot retain an older certificate after any reference disagrees.
  await replaceProjectedWatermarks(tx, key, [...stableById.keys()], '0')
  await replaceProjectedWatermarks(tx, key,
    [...stableById].filter(([, stable]) => stable).map(([id]) => id), prepared.watermarkPost)
}

/** Replace the certificate for the rows written by THIS fenced transaction.
 * A lower positive certificate can temporarily refuse freshness; retaining
 * an older higher value could certify content this projection did not sample.
 * Zero must remain a stored refusal, not a missing row eligible for fallback. */
async function replaceProjectedWatermarks(
  tx: Queryable,
  key: WorkspaceKey,
  documentIds: readonly string[],
  watermark: string,
): Promise<void> {
  const unique = [...new Set(documentIds)].filter(Boolean).sort()
  if (unique.length === 0) return
  await tx.query(
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
     SELECT $1, $2, doc.id, $4::bigint
     FROM unnest($3::text[]) AS doc(id)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET projected_watermark = EXCLUDED.projected_watermark,
         updated_at = now()`,
    [key.landscapeId, key.versionId, unique, watermark],
  )
}

/**
 * Record, atomically with the projection that earned them, the watermark each
 * sampled document is covered up to. GREATEST keeps the record monotone: a
 * late completion of an older sampling can never regress a newer one.
 */
export async function recordProjectedWatermarks(
  tx: Queryable,
  key: WorkspaceKey,
  documentIds: readonly string[],
  watermark: string,
): Promise<void> {
  // Sorted so every writer takes row locks in the same order — two
  // transactions upserting overlapping document sets with divergent orders is
  // the textbook deadlock.
  const unique = [...new Set(documentIds)].filter(Boolean).sort()
  if (unique.length === 0) return
  await tx.query(
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
     SELECT $1, $2, doc.id, $4::bigint
     FROM unnest($3::text[]) AS doc(id)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET projected_watermark = GREATEST(read_model_document_watermarks.projected_watermark, EXCLUDED.projected_watermark),
         updated_at = now()`,
    [key.landscapeId, key.versionId, unique, watermark],
  )
}
