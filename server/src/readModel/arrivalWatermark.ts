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

import { DurableDecodeTransientError, durableHeadsDecoder } from './durableHeadsDecoder.js'
import { durableHeadsScopeSql, type DurableHeadsMemo, type ScopedRowVersion } from './durableHeadsMemo.js'
import { DOCUMENT_ARRIVAL_COVERED_SQL } from './health.js'
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
 * Decode without Repo.loadDoc so neither SavedHeads nor chunkInfos changes.
 * With a memo, one metadata SELECT (key, arrival_seq, octet length, and the
 * scope of the table each row is in) comes first; a document whose
 * row-version set equals a strict decode remembered against the SAME table
 * takes those heads, the others are read and decoded as above. Each
 * document's heads still come from ONE statement's snapshot of ALL its rows. */
export async function prepareDocumentWatermarkProofs(
  db: Queryable,
  documents: readonly DocumentWatermarkProofTarget[],
  /** Strict decodes already made of these exact row versions
   * (`durableHeadsMemo.ts`, which carries the soundness argument). Absent:
   * every document is read and decoded, as before. */
  memo?: DurableHeadsMemo,
): Promise<PreparedDocumentWatermarks> {
  const watermarkPost = await captureArrivalWatermark(db)
  const drained = await Promise.allSettled(documents.map(document =>
    Promise.resolve().then(() => document.drainPendingSaves())))
  const rejected = drained.find(result => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  const documentIds = [...new Set(documents.map(document => document.documentId))].sort()
  const durableHeadsById = new Map<string, readonly string[]>()
  if (!documentIds.length) return { watermarkPost, durableHeadsById }
  let decodeIds = documentIds
  if (memo) {
    // After the capture and the drain, like the content read it replaces: one
    // statement, no data detoast (octet_length reads the stored size). A
    // document hits only when this set EQUALS the set the memo decoded.
    // Each row carries the scope of the table it was read from, so an entry
    // remembered against another table (another schema, another database)
    // cannot answer here.
    const { rows } = await db.query<{ document_id: string; key: string; arrival_seq: string | null; octets: number; durable_scope: string | null }>(
      `SELECT documents.document_id, storage.key, storage.arrival_seq::text AS arrival_seq,
         octet_length(storage.data) AS octets, ${durableHeadsScopeSql('storage')} AS durable_scope
       FROM unnest($1::text[]) AS documents(document_id)
       JOIN automerge_storage AS storage
         ON split_part(storage.key, '/', 1) = documents.document_id
       WHERE split_part(storage.key, '/', 2) IN ('snapshot', 'incremental')`,
      [documentIds],
    )
    const versionsById = new Map<string, ScopedRowVersion[]>()
    for (const row of rows) {
      const versions = versionsById.get(row.document_id) ?? []
      versions.push({ key: row.key, arrivalSeq: row.arrival_seq ?? null, octets: Number(row.octets), scope: row.durable_scope ?? null })
      versionsById.set(row.document_id, versions)
    }
    decodeIds = []
    for (const documentId of documentIds) {
      const versions = versionsById.get(documentId)
      if (!versions?.length) { memo.forget(documentId); continue }
      const heads = memo.lookup(documentId, versions)
      if (heads) durableHeadsById.set(documentId, heads)
      else decodeIds.push(documentId)
    }
    if (!decodeIds.length) return { watermarkPost, durableHeadsById }
  }
  // Neither a drain nor SQL holds the process-wide decoder. One workspace's
  // suspended storage operation must not prevent another from decoding.
  const { rows } = await db.query<{ document_id: string; key?: string; arrival_seq?: string | null; durable_scope?: string | null; data: Uint8Array }>(
    `SELECT documents.document_id, storage.key, storage.arrival_seq::text AS arrival_seq,
       ${durableHeadsScopeSql('storage')} AS durable_scope, storage.data
     FROM unnest($1::text[]) AS documents(document_id)
     JOIN automerge_storage AS storage
       ON split_part(storage.key, '/', 1) = documents.document_id
     WHERE split_part(storage.key, '/', 2) IN ('snapshot', 'incremental')
     ORDER BY documents.document_id,
       CASE split_part(storage.key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END,
       storage.key`,
    [decodeIds],
  )
  const chunksById = new Map<string, Uint8Array[]>()
  const versionsById = new Map<string, ScopedRowVersion[]>()
  for (const row of rows) {
    if (!(row.data instanceof Uint8Array)) throw new Error(`invalid durable chunk bytes: ${row.document_id}`)
    const chunks = chunksById.get(row.document_id) ?? []
    chunks.push(row.data)
    chunksById.set(row.document_id, chunks)
    const versions = versionsById.get(row.document_id) ?? []
    versions.push({ key: String(row.key), arrivalSeq: row.arrival_seq ?? null, octets: row.data.byteLength, scope: row.durable_scope ?? null })
    versionsById.set(row.document_id, versions)
  }
  for (const documentId of decodeIds) {
    const chunks = chunksById.get(documentId)
    if (!chunks?.length) continue
    const transientKey = transientDecodeKey(documentId, versionsById.get(documentId) ?? [])
    if ((transientDecodes.get(transientKey) ?? 0) >= TRANSIENT_DECODE_LIMIT) continue
    // The worker is the strict predicate (A.load, no fallback, no missing
    // dependency); a refusal throws before anything is remembered.
    let heads: readonly string[]
    try {
      heads = await durableHeadsDecoder.decode(documentId, chunks)
    } catch (error) {
      if (!(error instanceof DurableDecodeTransientError)) throw error
      const failures = (transientDecodes.get(transientKey) ?? 0) + 1
      transientDecodes.delete(transientKey)
      transientDecodes.set(transientKey, failures)
      while (transientDecodes.size > TRANSIENT_DECODE_KEYS) transientDecodes.delete(transientDecodes.keys().next().value!)
      if (failures < TRANSIENT_DECODE_LIMIT) throw error
      // Once per row-version set: from here on the check above skips it
      // without decoding, and without a word.
      console.warn(JSON.stringify({
        event: 'read_model.durable_proof_transient_skipped',
        documentId,
        failures,
        error: error.message,
      }))
      continue
    }
    transientDecodes.delete(transientKey)
    durableHeadsById.set(documentId, heads)
    memo?.remember(documentId, versionsById.get(documentId) ?? [], heads)
  }
  return { watermarkPost, durableHeadsById }
}

/**
 * THE TRANSIENT BOUND of the durable proof (G4-16f). A
 * `transient` decode answer (`durableDecodeFailure.mjs`: out of memory) is a
 * plain failure of the pass, which the projector retries — for ever, if the
 * same bytes run the isolate out of memory every time. So the failures are
 * counted per document AND exact row-version set (the rows' keys, arrival
 * sequences, sizes and table): after {@link TRANSIENT_DECODE_LIMIT} in a row
 * on the same set, the proof SKIPS that document — no heads, so no exact
 * certificate (`recordSampledDocumentWatermark` writes `0`, the conservative
 * answer the proof gives a document with no durable content) — without
 * decoding it again, until a row of it changes (a new set, a new count) or
 * the process restarts. A decode that succeeds clears its count. Process
 * memory, at most {@link TRANSIENT_DECODE_KEYS} sets, oldest dropped first.
 * The skip is logged ONCE per set, as a warning naming the document
 * (`read_model.durable_proof_transient_skipped`, at the failure that
 * reaches the limit); the passes that then skip it without decoding are
 * silent.
 *
 * What is NOT counted: only the worker's own `transient` ANSWER is. A
 * worker CRASH — its `exit` or `error` event (`durableHeadsDecoder.ts`,
 * `retire`), whatever killed it — rejects with a plain `Error`, which this proof rethrows every time,
 * uncounted: bytes that crash the worker on every decode fail every pass
 * for ever, as before this bound existed.
 */
export const TRANSIENT_DECODE_LIMIT = 3
export const TRANSIENT_DECODE_KEYS = 1_024
const transientDecodes = new Map<string, number>()

function transientDecodeKey(documentId: string, versions: readonly ScopedRowVersion[]): string {
  return JSON.stringify([documentId, ...versions
    .map((version) => [version.key, version.arrivalSeq, version.octets, version.scope])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))])
}

/** Tests: forget every counted transient failure. */
export function resetTransientDecodesForTest(): void {
  transientDecodes.clear()
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
  headWithdrawn?: () => boolean,
): Promise<'certified' | 'refused' | 'withdrawn'> {
  let watermark = '0'
  if (sampledHeads) {
    const durableHeads = prepared.durableHeadsById.get(documentId)
    const currentHeads = readCurrentHeads()
    if (durableHeads && currentHeads && headsEqual(currentHeads, sampledHeads)
      && headsEqual(durableHeads, sampledHeads)) watermark = prepared.watermarkPost
    // T-ZEROWM-2: THE WITHDRAWN HEAD. The only reason left to refuse is that
    // the handle the pass sampled is no longer the Repo's (`currentHeads`
    // null) — sampled, durable agree — and the caller says it was taken away
    // UNDER the pass (an eviction it was told of, or its own shutdown having
    // released its leases). No certificate is written here: the CALLER
    // leaves the document owed in its own transaction, so that a later pass
    // certifies it — the static plane re-opens the document's queue row
    // (`StaticDeltaProjector.recordPassWatermark`), the ordinary plane writes
    // 0 with NULL heads so the next attach cold-builds and re-certifies
    // (`withdrawShardCertificate`).
    // The kept watermark covers no arrival past it (`exact_low`). Every OTHER
    // refusal (no sampled heads, no durable heads, a durable or a live
    // revision unlike the sample: a true hole) is still written as 0: it is
    // the one a later arrival must not lift.
    else if (!currentHeads && durableHeads && headsEqual(durableHeads, sampledHeads) && headWithdrawn?.()) {
      return 'withdrawn'
    }
  }
  await replaceProjectedWatermarks(tx, key, [documentId], watermark, new Map([[documentId, sampledHeads]]))
  return watermark === '0' ? 'refused' : 'certified'
}

/**
 * T-ZEROWM-2 (4): the ORDINARY plane's answer to a withdrawn head
 * ({@link recordSampledDocumentWatermark} returned `'withdrawn'`), in the
 * pass's transaction: the refusal `0` with NULL heads, whatever the row held.
 *
 *  - NULL heads, not the sample's: with the sample's heads an adopter
 *    (`READ_MODEL_ADOPT=on`) seeded the shard there, found the live heads
 *    equal, ran no pass, and kept the 0 for good (measured). With NULL heads
 *    it refuses the claim
 *    (`null-projected-heads`, `adoptVerify.ts`) and cold-builds, which
 *    re-certifies every listed shard; with adopt off every attach is a cold
 *    build anyway. So this 0 is never orphaned.
 *  - The row's previous heads are not kept either: they name
 *    a base OLDER than the rows this pass published, and a catch-up from
 *    there would miss a deletion made after the sample.
 *  - Nor its previous watermark: an older, higher certificate must not
 *    survive a pass that could not vouch for its rows (the ordinary rule,
 *    `projectorWatermark.races.test.ts`, "a transaction completing after stop
 *    invalidates an old high certificate").
 *  - NO ROW (a first certificate): written too, or an adopter would class the
 *    shard `new` and `applyInitial` its live content — upserts only — keeping
 *    an object deleted after the sample.
 */
export async function withdrawShardCertificate(tx: Queryable, key: WorkspaceKey, documentId: string): Promise<void> {
  await tx.query(
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads)
     VALUES ($1, $2, $3, 0, NULL)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET projected_watermark = 0, projected_heads = NULL, updated_at = now()`,
    [key.landscapeId, key.versionId, documentId],
  )
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
  // The SAMPLED heads per document, whatever the certificate: one value when
  // every sample of the document read the same revision, otherwise null (two
  // references read at different revisions name no single revision the rows
  // are the projection of).
  const headsById = new Map<string, readonly string[] | null>()
  for (const document of documents) {
    const durableHeads = prepared.durableHeadsById.get(document.documentId)
    const currentHeads = document.readCurrentHeads()
    const stable = document.sampledHeads !== null && currentHeads !== null && durableHeads !== undefined
      && headsEqual(document.sampledHeads, currentHeads)
      && headsEqual(document.sampledHeads, durableHeads)
    stableById.set(document.documentId, (stableById.get(document.documentId) ?? true) && stable)
    const previous = headsById.get(document.documentId)
    headsById.set(document.documentId, previous === undefined
      ? document.sampledHeads
      : previous !== null && document.sampledHeads !== null && headsEqual(previous, document.sampledHeads) ? previous : null)
  }
  // First invalidate and lock every row in the usual sorted order; the exact
  // certificates only revisit rows already held by this transaction. A mixed
  // alias cannot retain an older certificate after any reference disagrees.
  // Each statement writes the heads with the watermark it sets, so the row's
  // final watermark and heads always come from the same statement.
  await replaceProjectedWatermarks(tx, key, [...stableById.keys()], '0', headsById)
  await replaceProjectedWatermarks(tx, key,
    [...stableById].filter(([, stable]) => stable).map(([id]) => id), prepared.watermarkPost, headsById)
}

/** Replace the certificate for the rows written by THIS fenced transaction.
 * A lower positive certificate can temporarily refuse freshness; retaining
 * an older higher value could certify content this projection did not sample.
 * Zero must remain a stored refusal, not a missing row eligible for fallback.
 *
 * `projected_heads` (G4-16f C6b): the heads of the revision the projection
 * SAMPLED — the revision the rows this transaction wrote are the projection
 * of — in the same statement as the watermark, whatever the watermark (0 is
 * a refused certificate, not unknown content). A document with no sampled
 * heads, or absent from `headsById`, gets NULL: an adopter refuses NULL and
 * cold-builds. Heads cross as one JSON array text per row (a `text[][]`
 * parameter cannot be ragged).
 *
 * A build that predates the column upserts the
 * watermark and leaves the heads as they were, so a row can pair its new
 * watermark with old heads. Read `projected_heads` only under an adopt row
 * whose fence binding equals the current fence (`adoptState.ts`,
 * `adoptRefusal`): such a writer had to claim the fence, which unbinds. */
async function replaceProjectedWatermarks(
  tx: Queryable,
  key: WorkspaceKey,
  documentIds: readonly string[],
  watermark: string,
  headsById: ReadonlyMap<string, readonly string[] | null>,
): Promise<void> {
  const unique = [...new Set(documentIds)].filter(Boolean).sort()
  if (unique.length === 0) return
  const heads = unique.map((id) => {
    const sampled = headsById.get(id)
    return sampled ? JSON.stringify(sampled) : null
  })
  await tx.query(
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads)
     SELECT $1, $2, doc.id, $4::bigint,
            CASE WHEN doc.heads IS NULL THEN NULL ELSE ARRAY(
              SELECT head.value FROM jsonb_array_elements_text(doc.heads::jsonb) WITH ORDINALITY AS head(value, ord)
               ORDER BY head.ord) END
     FROM unnest($3::text[], $5::text[]) AS doc(id, heads)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET projected_watermark = EXCLUDED.projected_watermark,
         projected_heads = EXCLUDED.projected_heads,
         updated_at = now()`,
    [key.landscapeId, key.versionId, unique, watermark, heads],
  )
}

/**
 * MARK ONCE (T-SUM-2): at the ENTRY into the static plane, turn the coverage
 * every allow-listed document of the workspace has RIGHT NOW into an exact
 * certificate. Called by the promotion (inside its transaction, BEFORE its
 * write fence — see the lock-order note at the call site) and by the
 * performance seed (after its rows and its projection state). Not by the
 * sparse draft: its durability witness answers for its BASE version, and the
 * client discards an echo of another workspace (`fetchDurabilityWitness`), so
 * a certificate under the draft's key would never be read.
 *
 * WHY EVERY DOCUMENT, not only the frozen baseline: a
 * document that has no certificate stays on the timestamp fallback, and there
 * ANY later publish of the workspace covers an arrival nothing projected —
 * measured without the mark, a raw chunk "proven absent" 539–555 ms after an
 * unrelated edit. After the mark, a frozen document refuses any later arrival
 * for good (no pass projects it — the honest answer), and a document a pass
 * projects is re-stamped by that pass: every tracked write of an allow-listed
 * document enqueues a revision, and the pass that projects it stamps it
 * (`StaticDeltaProjector.recordPassWatermark`, or `stampRootPass` for the
 * root). What stays on the fallback: documents registered AFTER the entry
 * (rotation and fold children, client-created DiagramDocs) until their first
 * tracked write, and admitted documents outside the allow-list.
 *
 * ONE STATEMENT: the coverage is read by the same clause as
 * `absenceProvable` ({@link DOCUMENT_ARRIVAL_COVERED_SQL}) and the certificate
 * written from the same snapshot, at the `max(arrival_seq)` that clause
 * covered — including, since T-SUM-2c, a control document only its positive
 * adopt certificate covers (`aw`, the clause's adopt branch: a value minted
 * after the same flush-drain-heads proof, so the certificate written here,
 * `max(arrival_seq)` ≤ that value, claims no more than it). A document it does not cover — an exact refusal, a `0`, a fallback
 * that does not hold — is left as it is; an existing row is never touched (DO
 * NOTHING: a row is covered only if it already certifies, and a concurrent
 * refusal must not be lifted after a lock wait).
 *
 * What it rests on: a write minted with a LOWER sequence than this snapshot's
 * newest and committed after it would be covered (the reason the ordinary
 * protocol compares heads). It takes two concurrent writers of one document;
 * the promotion's quiesce precondition and the seed's stopped server are what
 * keep that window empty — a FORCED promotion (`allowConnectedPeers`) does not.
 * Returns the number of documents stamped.
 */
export async function markStaticEntryWatermarks(tx: Queryable, key: WorkspaceKey): Promise<number> {
  const { rowCount } = await tx.query(
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads)
     SELECT dw.landscape_id, dw.version_id, dw.document_id, newest.max_seq, NULL
       FROM automerge_document_workspace dw
       JOIN read_model_static_documents sd
         ON sd.landscape_id = dw.landscape_id AND sd.version_id = dw.version_id AND sd.document_id = dw.document_id
       LEFT JOIN read_model_projection_state p
         ON p.landscape_id = dw.landscape_id AND p.version_id = dw.version_id
       CROSS JOIN LATERAL (
         SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq
           FROM automerge_storage s
          WHERE split_part(s.key, '/', 1) = dw.document_id
            AND split_part(s.key, '/', 2) <> 'sync-state'
       ) newest
       LEFT JOIN read_model_document_watermarks wm
         ON wm.landscape_id = dw.landscape_id AND wm.version_id = dw.version_id AND wm.document_id = dw.document_id
       LEFT JOIN read_model_adopt_watermarks aw
         ON aw.landscape_id = dw.landscape_id AND aw.version_id = dw.version_id AND aw.document_id = dw.document_id
      WHERE dw.landscape_id = $1 AND dw.version_id = $2
        AND wm.document_id IS NULL
        AND newest.max_seq IS NOT NULL
        AND ${DOCUMENT_ARRIVAL_COVERED_SQL}
     ORDER BY dw.document_id
     ON CONFLICT (landscape_id, version_id, document_id) DO NOTHING`,
    [key.landscapeId, key.versionId],
  )
  return rowCount ?? 0
}

/**
 * Record, atomically with the projection that earned them, the watermark each
 * sampled document is covered up to. GREATEST keeps the record monotone: a
 * late completion of an older sampling can never regress a newer one.
 *
 * It knows no heads, so it writes `projected_heads` NULL (G4-16f C6b): heads
 * left from an earlier sample would name a revision these rows may no
 * longer be the projection of. NULL makes an adopter refuse and cold-build.
 * No production path calls it today (tests and fixtures only).
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
    `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads)
     SELECT $1, $2, doc.id, $4::bigint, NULL
     FROM unnest($3::text[]) AS doc(id)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET projected_watermark = GREATEST(read_model_document_watermarks.projected_watermark, EXCLUDED.projected_watermark),
         projected_heads = NULL,
         updated_at = now()`,
    [key.landscapeId, key.versionId, unique, watermark],
  )
}
