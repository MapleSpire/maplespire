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

import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { foldedArrivalPendingSql } from './ordinaryFoldedArrivals.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * ORDINARY CHAIN FOLD (G4-16b phase 4): the projector's side of it.
 *
 * Rotation appends one segment per rotation and nothing removes one
 * (`ordinaryHeadRotator.ts`). A fold merges a contiguous run of RETIRED heads
 * into one new segment and substitutes it for them in ModelMeta, in one
 * change. The merged segment names the heads it replaces in
 * `ORDINARY_FOLD_SOURCES_FIELD`, and that durable field — not an in-memory
 * registry — is what tells a running projector two things when the change
 * arrives:
 *
 *  - ATTACH IT FROM ITS OWN CONTENT, AND NEVER PROJECT IT. Its values are
 *    OLDER than the newer heads behind it, and any projection of a shard
 *    upserts its WHOLE entity set (`applyObjectShardDelta`; the last shard
 *    written wins the row), so an initial apply — or a delta on any later
 *    change — would put them over rows a newer head wrote. It is attached
 *    with its live content as the baseline and publishes nothing; a change to
 *    it after that is refused (`ORDINARY_FOLD_PRODUCT_CHANGED`): the shard is
 *    degraded until a cold build, which reads ModelMeta order and so serves
 *    the right values. A fold must therefore write its product WHOLE before
 *    ModelMeta names it (its marker in the creating change, its entities in
 *    bounded changes after it, all before the flush:
 *    `createClaimedOverlaySegment`), and nothing may write it again.
 *    "Publishes nothing" is right only if every value in it was already
 *    served. So the attach is refused, loudly, unless every source is a
 *    segment this projector watches (`ORDINARY_FOLD_SOURCES_NOT_WATCHED`) and
 *    is SETTLED (`ORDINARY_FOLD_SOURCES_NOT_SETTLED`): a forwarded head's live
 *    heads equal its `forwarded_heads` (or H_r), any other source's live heads
 *    equal the heads its last projection published. A refusal is retried on
 *    the attach backoff, so a source still forwarding is waited for.
 *  - STOP WATCHING THE SOURCES once ModelMeta no longer lists them, and release
 *    their residency leases, AFTER the source's in-flight pass has finished.
 *    Only a source named by an attached fold product is detached: a shard that
 *    leaves ModelMeta any other way keeps the behaviour it always had (still
 *    watched until the projector stops). A detached source is never attached
 *    again by this projector, and a source that is the current write head is
 *    never detached.
 *
 * A projector that cold-builds after the fold never sees the sources at all:
 * they are not listed, so they are neither extracted nor attached.
 *
 * NOT HERE: the fold itself, its locks and rows, and what happens to a late
 * write that reaches a source after the settle check — between that check and
 * the detach, or after the detach — which this projector neither projects nor
 * forwards: phases 4.2 to 4.4 in `docs/read-model-projector-health.md`.
 * The marker is in a document a client can write, like ModelMeta itself; a
 * crafted product can hide its own content until the next cold build and
 * detach shards the same client unlisted, but destroys no row. Phase 4.2's
 * server-side rows are to become the authority, the marker a cross-check.
 */
export const ORDINARY_FOLD_SOURCES_FIELD = 'foldedFromUrls'

export const ORDINARY_FOLD_SOURCES_NOT_WATCHED = 'ordinary-fold-sources-not-watched'
export const ORDINARY_FOLD_SOURCES_NOT_SETTLED = 'ordinary-fold-sources-not-settled'
export const ORDINARY_FOLD_PRODUCT_CHANGED = 'ordinary-fold-product-changed'

/** The heads a merged segment replaces, or null when `doc` is not a fold
 * product. A field that is present but not a non-empty list of valid Automerge
 * URLs is not trusted as one either: it throws, so the attach degrades. */
export function ordinaryFoldSourcesOf(doc: unknown): string[] | null {
  if (!doc || typeof doc !== 'object') return null
  const value = (doc as Record<string, unknown>)[ORDINARY_FOLD_SOURCES_FIELD]
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length === 0
    || !value.every((url) => typeof url === 'string' && isValidAutomergeUrl(url))) {
    throw new Error(`malformed ${ORDINARY_FOLD_SOURCES_FIELD} in an overlay segment`)
  }
  return [...new Set(value as string[])]
}

/** Does `doc` carry the marker at all, well-formed or not? What decides that
 * its watcher never projects it: a malformed marker is still refused rather
 * than projected whole. */
export function hasOrdinaryFoldMarker(doc: unknown): boolean {
  return Boolean(doc && typeof doc === 'object'
    && (doc as Record<string, unknown>)[ORDINARY_FOLD_SOURCES_FIELD] !== undefined)
}

/** Watched shards to detach after a ModelMeta change: no longer listed, and
 * named as a source by an attached fold product that IS listed. Keyed on the
 * listed products, not on every source ever seen, so a ModelMeta read that
 * lists nothing (a missing field) detaches nothing. */
export function foldSourcesToDetach(
  watched: readonly string[],
  listed: readonly string[],
  sourcesByProduct: ReadonlyMap<string, readonly string[]>,
): string[] {
  const stillListed = new Set(listed)
  const sources = new Set(listed.flatMap((url) => sourcesByProduct.get(url) ?? []))
  return watched.filter((url) => sources.has(url) && !stillListed.has(url))
}

// ---------------------------------------------------------------------------
// The server-side record of a fold (phase 4, step 2). The marker above sits in
// a document any client of the workspace can write; THIS is what a projector
// trusts. A product is accepted only when a row names it with exactly the
// sources its marker names, and every source's retirement row is `folded`
// into it.
// ---------------------------------------------------------------------------

export const ORDINARY_FOLD_UNRECORDED = 'ordinary-fold-unrecorded'
export const ORDINARY_FOLD_MISMATCH = 'ordinary-fold-mismatch'

export interface OrdinaryChainFoldRecord {
  collection: OverlayCollection
  productDocumentId: string
  sourceDocumentIds: string[]
}

export class OrdinaryChainFoldConflictError extends Error {
  constructor(readonly key: WorkspaceKey, readonly collection: OverlayCollection, readonly productDocumentId: string,
    readonly conflicting: readonly string[], reason: string) {
    super(`ordinary chain fold of ${key.landscapeId}/${key.versionId} ${collection} into ${productDocumentId}: `
      + `${reason}${conflicting.length ? `: ${conflicting.join(', ')}` : ''}`)
    this.name = 'OrdinaryChainFoldConflictError'
  }
}

export type RecordOrdinaryChainFoldResult = 'recorded' | 'already-recorded'

const FOLD_SAVEPOINT = 'ordinary_chain_fold'

/**
 * Record a fold INSIDE the caller's open transaction (a SAVEPOINT, which
 * Postgres refuses outside a transaction block, so a pool or an autocommit
 * client throws before anything is written):
 *
 *  1. every source's retirement row moves `retired` -> `folded`, a
 *     compare-and-set on the `forwarded_heads` the fold read. A forward that
 *     committed since means the product misses a write; a source already
 *     `folded`, `admitted` or without a row does not move either;
 *  2. the PRODUCT gets a `retired` row whose H_r is its heads at creation, so
 *     a later fold can take it as a source like any retired head: without it
 *     every fold leaves one segment that can never be folded again, and the
 *     chain is not bounded;
 *  3. the product's fold row.
 *
 * Any source that did not move, or a product that already has a row, rolls
 * the savepoint back and throws {@link OrdinaryChainFoldConflictError} naming
 * them. A product already recorded with exactly these sources is the retry of
 * a fold whose transaction committed (a crash before its ModelMeta change):
 * `already-recorded`, nothing written.
 *
 * NOT checked here: a late write that reached a source and is not forwarded
 * yet (its row has not moved, so the CAS passes). The fold writer must compare
 * each source's live heads with `forwarded_heads ?? H_r` under the rotation
 * lock just before (`ordinaryHeadLateWritesPending`). One that slips through
 * is still forwarded into the current head, which ModelMeta lists after the
 * product, so it wins its row; the guard is sufficient, not exact.
 *
 * Rows only move forward (retired -> folded; the rotator refuses to re-retire
 * a folded row): readers that read the record and the rows in two statements
 * rely on it. The one exception is a fold recorded and never published,
 * undone by {@link abandonOrdinaryChainFold}, whose product no reader reads.
 */
export async function recordOrdinaryChainFold(
  tx: Queryable,
  key: WorkspaceKey,
  fold: {
    collection: OverlayCollection
    productDocumentId: string
    /** The product's heads as created: its H_r as a future source. */
    productHeads: readonly string[]
    /** The current write head, which may be neither a source nor the product. */
    currentDocumentId: string
    sources: ReadonlyArray<{ documentId: string; forwardedHeads: readonly string[] | null }>
    retainUntil: Date
  },
): Promise<RecordOrdinaryChainFoldResult> {
  const sourceIds = fold.sources.map((source) => source.documentId)
  const invalid = (why: string) => new Error(`ordinary chain fold into ${fold.productDocumentId}: ${why}`)
  if (!sourceIds.length) throw invalid('no source')
  if (new Set(sourceIds).size !== sourceIds.length) throw invalid('a source is named twice')
  if (sourceIds.includes(fold.productDocumentId)) throw invalid('the product is one of its own sources')
  if (fold.productDocumentId === fold.currentDocumentId || sourceIds.includes(fold.currentDocumentId)) {
    throw invalid('the current write head can be neither a source nor the product')
  }
  if (!fold.productHeads.length) throw invalid('the product has no heads')
  if (!Number.isFinite(fold.retainUntil.getTime()) || fold.retainUntil.getTime() <= Date.now()) {
    throw invalid('retainUntil must be a valid date in the future')
  }
  await tx.query(`SAVEPOINT ${FOLD_SAVEPOINT}`)
  const fail = async (error: Error): Promise<never> => {
    await tx.query(`ROLLBACK TO SAVEPOINT ${FOLD_SAVEPOINT}`)
    throw error
  }
  try {
    const existing = await readOrdinaryChainFold(tx, key, fold.collection, fold.productDocumentId)
    if (existing) {
      const recorded = new Set(existing.sourceDocumentIds)
      if (recorded.size === sourceIds.length && sourceIds.every((id) => recorded.has(id))) {
        await tx.query(`RELEASE SAVEPOINT ${FOLD_SAVEPOINT}`)
        return 'already-recorded'
      }
      return await fail(new OrdinaryChainFoldConflictError(key, fold.collection, fold.productDocumentId,
        existing.sourceDocumentIds, 'the product is already recorded with other sources'))
    }
    const stale: string[] = []
    for (const source of fold.sources) {
      const result = await tx.query(
        `UPDATE read_model_ordinary_head_retirements
            SET status = 'folded', folded_into = $5, retain_until = $6, updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4
            AND status = 'retired'
            AND forwarded_heads IS NOT DISTINCT FROM $7::text[]`,
        [
          key.landscapeId, key.versionId, fold.collection, source.documentId,
          fold.productDocumentId, fold.retainUntil,
          source.forwardedHeads ? [...source.forwardedHeads].sort() : null,
        ],
      )
      if ((result.rowCount ?? 0) !== 1) stale.push(source.documentId)
    }
    if (stale.length) {
      return await fail(new OrdinaryChainFoldConflictError(key, fold.collection, fold.productDocumentId, stale,
        'source(s) not retired at the forward state the fold read'))
    }
    const product = await tx.query(
      `INSERT INTO read_model_ordinary_head_retirements (
         landscape_id, version_id, collection, document_id, retirement_heads, status, origin
       ) VALUES ($1, $2, $3, $4, $5::text[], 'retired', 'fold-product')
       ON CONFLICT (landscape_id, version_id, collection, document_id) DO NOTHING`,
      [key.landscapeId, key.versionId, fold.collection, fold.productDocumentId, [...fold.productHeads].sort()],
    )
    if ((product.rowCount ?? 0) !== 1) {
      return await fail(new OrdinaryChainFoldConflictError(key, fold.collection, fold.productDocumentId,
        [fold.productDocumentId], 'the product already has a retirement row'))
    }
    await tx.query(
      `INSERT INTO read_model_ordinary_chain_folds (
         landscape_id, version_id, collection, product_document_id, source_document_ids
       ) VALUES ($1, $2, $3, $4, $5::text[])`,
      [key.landscapeId, key.versionId, fold.collection, fold.productDocumentId, sourceIds],
    )
    await tx.query(`RELEASE SAVEPOINT ${FOLD_SAVEPOINT}`)
    return 'recorded'
  } catch (error) {
    if (error instanceof OrdinaryChainFoldConflictError) throw error
    // A failed statement aborts the transaction; give the caller it back.
    await tx.query(`ROLLBACK TO SAVEPOINT ${FOLD_SAVEPOINT}`).catch(() => {})
    throw error
  }
}

export async function readOrdinaryChainFold(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  productDocumentId: string,
): Promise<OrdinaryChainFoldRecord | undefined> {
  const { rows } = await db.query<{ source_document_ids: string[] }>(
    `SELECT source_document_ids FROM read_model_ordinary_chain_folds
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND product_document_id = $4`,
    [key.landscapeId, key.versionId, collection, productDocumentId],
  )
  return rows[0]
    ? { collection, productDocumentId, sourceDocumentIds: rows[0].source_document_ids }
    : undefined
}

/** The recorded folds of one kind whose product was never folded again (its
 * row is still `retired`), newest first, each with its age. The writer
 * (`ordinaryChainFoldWriter.ts`) drops those ModelMeta lists: the rest are
 * recorded and not published. Every listed product of the chain is among
 * them, so the answer is as long as the chain, which the fold bounds. */
export async function retiredProductOrdinaryChainFolds(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
): Promise<Array<OrdinaryChainFoldRecord & { ageMs: number }>> {
  const { rows } = await db.query<{ product_document_id: string; source_document_ids: string[]; age_ms: string }>(
    `SELECT fold.product_document_id, fold.source_document_ids,
            (extract(epoch FROM now() - fold.created_at) * 1000)::bigint::text AS age_ms
       FROM read_model_ordinary_chain_folds fold
       JOIN read_model_ordinary_head_retirements product
         ON product.landscape_id = fold.landscape_id AND product.version_id = fold.version_id
        AND product.collection = fold.collection AND product.document_id = fold.product_document_id
      WHERE fold.landscape_id = $1 AND fold.version_id = $2 AND fold.collection = $3
        AND product.status = 'retired'
      ORDER BY fold.created_at DESC, fold.product_document_id DESC`,
    [key.landscapeId, key.versionId, collection],
  )
  return rows.map((row) => ({
    collection, productDocumentId: row.product_document_id, sourceDocumentIds: row.source_document_ids,
    ageMs: Number(row.age_ms),
  }))
}

export type AbandonOrdinaryChainFoldResult =
  | { outcome: 'abandoned'; reverted: string[] }
  /** The product's row is not `retired` (it was published and folded again,
   * or has no row) or the product has no record: nothing is pending. */
  | { outcome: 'not-pending' }

const ABANDON_SAVEPOINT = 'ordinary_chain_fold_abandon'

/**
 * Undo a RECORDED fold that was never published (phase 4 step 5), INSIDE the
 * caller's open transaction (a SAVEPOINT, refused outside one), under the
 * `overlay-rotation:` lock the fold writer holds:
 *
 *  1. the product's `retired` row is deleted. A product folded again (its row
 *     `folded`) was published, and nothing moves: `not-pending`;
 *  2. every source still `folded` into the product goes back to `retired`
 *     (`folded_into`, `retain_until` and `arrival_watermark` cleared; H_r and
 *     `forwarded_heads` kept), so a later fold can take it again: left
 *     `folded`, a listed source is never foldable and splits every run that
 *     crosses it, and the chain is no longer bounded;
 *  3. the product's fold row is deleted, so the next pass does not examine
 *     it again.
 *
 * The product is then an orphan no row names, unlisted and unrooted: GC
 * sweeps it after its grace period (`gc.ts`). This is the one move of a row
 * backwards. A projector reads a record only for a product ModelMeta lists,
 * and the writer calls this only for a product its ModelMeta does not list,
 * under the lock. But "not listed HERE" is not "never published": an owner
 * that spliced the product in can have synced that change to a client and
 * died before its flush, and the client's merge lists the product again
 * later. So the writer waits `retainMs` after the record before abandoning
 * (and GC roots a recorded product until then): a resurrected listing within
 * that window finds its record and its rows. After it, the product is
 * refused (`ordinary-fold-unrecorded`) until a client's ModelMeta drops it.
 */
export async function abandonOrdinaryChainFold(
  tx: Queryable,
  key: WorkspaceKey,
  fold: { collection: OverlayCollection; productDocumentId: string },
): Promise<AbandonOrdinaryChainFoldResult> {
  await tx.query(`SAVEPOINT ${ABANDON_SAVEPOINT}`)
  try {
    const product = await tx.query(
      `DELETE FROM read_model_ordinary_head_retirements
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4
          AND status = 'retired'`,
      [key.landscapeId, key.versionId, fold.collection, fold.productDocumentId],
    )
    const record = await tx.query(
      `DELETE FROM read_model_ordinary_chain_folds
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND product_document_id = $4`,
      [key.landscapeId, key.versionId, fold.collection, fold.productDocumentId],
    )
    if ((product.rowCount ?? 0) !== 1 || (record.rowCount ?? 0) !== 1) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${ABANDON_SAVEPOINT}`)
      return { outcome: 'not-pending' }
    }
    const { rows } = await tx.query<{ document_id: string }>(
      `UPDATE read_model_ordinary_head_retirements
          SET status = 'retired', folded_into = NULL, retain_until = NULL, arrival_watermark = NULL,
              updated_at = now()
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
          AND status = 'folded' AND folded_into = $4
        RETURNING document_id`,
      [key.landscapeId, key.versionId, fold.collection, fold.productDocumentId],
    )
    await tx.query(`RELEASE SAVEPOINT ${ABANDON_SAVEPOINT}`)
    return { outcome: 'abandoned', reverted: rows.map((row) => row.document_id).sort() }
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${ABANDON_SAVEPOINT}`).catch(() => {})
    throw error
  }
}

/** Rows one sweep deletes at most, so the transaction under the rotation lock
 * stays short however many folds a workspace has had. */
export const ORDINARY_FOLD_ROW_SWEEP_LIMIT = 500

/** How long a product must have been folded again before its sources' rows
 * go (`updated_at`, which a later watermark advance only pushes back). */
export const ORDINARY_FOLD_ROW_SWEEP_PRODUCT_GRACE = '10 minutes'

/**
 * Delete the fold rows nothing reads any more (phase 4 step 5), inside the
 * caller's transaction, under the fold writer's lock:
 *
 *  - a source row `folded` into a product that is itself `folded`, once its
 *    `retain_until` has passed, and the product folded at least
 *    {@link ORDINARY_FOLD_ROW_SWEEP_PRODUCT_GRACE} ago. Its document is no
 *    longer listed or rooted (GC sweeps it, `gc.ts`), and the only reader of
 *    the row, the check that vouches for a product when the projector
 *    attaches it (`ordinaryFoldRecordRefusal`), runs for a LISTED product: a
 *    `folded` product was published and replaced. The grace covers an attach
 *    that found the product listed just before it was folded again. The row
 *    of a source whose product is still `retired` stays, however old:
 *    without it every attach of that product would be refused
 *    (`ordinary-fold-mismatch`). Nor does a row whose head holds an arrival
 *    above its `arrival_watermark` (`foldedArrivalPendingSql`, G4-16c): the
 *    row is what the poll carries that late write from and what GC keeps the
 *    head for, so deleting it would lose the write with the head; it goes on
 *    a later pass, once the watermark has moved. Nor does a row named in
 *    `keep`: the heads owed a handover re-check (G4-16d). An old owner's late
 *    save sits BELOW the watermark, where the pending probe above cannot see
 *    it, and only the re-check finds it — from this row;
 *  - then a fold record whose product is `folded` or has no row any more (its
 *    row went in the first statement, in a backlog) and no row is folded
 *    into it. A record whose product is still `retired` is never touched
 *    here: it is listed, or pending, which is the writer's to resolve.
 *
 * At most {@link ORDINARY_FOLD_ROW_SWEEP_LIMIT} source rows per call; the
 * next pass takes the rest.
 */
export async function sweepOrdinaryChainFoldRows(
  tx: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  limit = ORDINARY_FOLD_ROW_SWEEP_LIMIT,
  /** Document ids whose rows stay whatever else holds (the handover re-check). */
  keep: readonly string[] = [],
): Promise<{ rows: number; records: number }> {
  const rows = await tx.query(
    `DELETE FROM read_model_ordinary_head_retirements
      WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
        AND status = 'folded' AND retain_until <= now()
        AND document_id IN (
          SELECT source.document_id
            FROM read_model_ordinary_head_retirements source
            JOIN read_model_ordinary_head_retirements product
              ON product.landscape_id = source.landscape_id
             AND product.version_id = source.version_id
             AND product.collection = source.collection
             AND product.document_id = source.folded_into
           WHERE source.landscape_id = $1 AND source.version_id = $2 AND source.collection = $3
             AND source.status = 'folded' AND source.retain_until <= now()
             AND product.status = 'folded'
             AND product.updated_at <= now() - $5::interval
             AND NOT ${foldedArrivalPendingSql('source')}
             AND NOT (source.document_id = ANY($6::text[]))
           ORDER BY source.retain_until, source.document_id
           LIMIT $4)`,
    [key.landscapeId, key.versionId, collection, limit, ORDINARY_FOLD_ROW_SWEEP_PRODUCT_GRACE, [...keep]],
  )
  const records = await tx.query(
    `DELETE FROM read_model_ordinary_chain_folds fold
      WHERE fold.landscape_id = $1 AND fold.version_id = $2 AND fold.collection = $3
        AND NOT EXISTS (
          SELECT 1 FROM read_model_ordinary_head_retirements product
           WHERE product.landscape_id = $1 AND product.version_id = $2 AND product.collection = $3
             AND product.document_id = fold.product_document_id AND product.status <> 'folded')
        AND NOT EXISTS (
          SELECT 1 FROM read_model_ordinary_head_retirements source
           WHERE source.landscape_id = $1 AND source.version_id = $2 AND source.collection = $3
             AND source.folded_into = fold.product_document_id)`,
    [key.landscapeId, key.versionId, collection],
  )
  return { rows: rows.rowCount ?? 0, records: records.rowCount ?? 0 }
}

/** Why the record does not vouch for a product whose marker names
 * `markerSourceIds`, or null when it does: the row exists, names exactly
 * those sources, and every source's retirement row is `folded` into it. */
export function ordinaryFoldRecordRefusal(
  record: OrdinaryChainFoldRecord | undefined,
  markerSourceIds: readonly string[],
  retirementOf: (documentId: string) => { status: string; foldedInto: string | null } | undefined,
): string | null {
  if (!record) return ORDINARY_FOLD_UNRECORDED
  const recorded = new Set(record.sourceDocumentIds)
  const marked = new Set(markerSourceIds)
  if (recorded.size !== marked.size || [...marked].some((id) => !recorded.has(id))) return ORDINARY_FOLD_MISMATCH
  for (const id of recorded) {
    const row = retirementOf(id)
    if (row?.status !== 'folded' || row.foldedInto !== record.productDocumentId) return ORDINARY_FOLD_MISMATCH
  }
  return null
}
