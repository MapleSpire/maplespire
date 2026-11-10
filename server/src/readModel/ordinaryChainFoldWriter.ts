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

import { getHeads } from '@automerge/automerge'
import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocumentId,
} from '@automerge/automerge-repo'
import type { PoolClient } from 'pg'
import {
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  releaseOverlayRotationLock,
  reportOverlayRotationLockContended,
  type OverlayRotationLockState,
} from './overlayRotationLock.js'
import { STATIC_PLANE_LOCK_WAIT_MS } from './projectionAuthority.js'
import {
  foldOverlaySegmentContents,
  OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES,
  OVERLAY_SEGMENT_ENTITY_CEILING,
} from './overlayChainFold.js'
import {
  abandonOrdinaryChainFold,
  ORDINARY_FOLD_SOURCES_FIELD,
  recordOrdinaryChainFold,
  retiredProductOrdinaryChainFolds,
  sweepOrdinaryChainFoldRows,
} from './ordinaryChainFold.js'
import { loadOrdinaryHeadRetirements, retirementKey } from './ordinaryHeadForwarding.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * Ordinary CHAIN FOLD, the writer (G4-16b phase 4, step 3).
 *
 * Rotation (`ordinaryHeadRotator.ts`) appends one segment per rotation and
 * nothing removes one. This merges the OLDEST contiguous run of foldable
 * retired heads into one new segment (the PRODUCT) and substitutes it for them
 * in ModelMeta, in one change. The projector side (`ordinaryChainFold.ts`,
 * `projectorService.ts`) then attaches the product without projecting it and
 * detaches the sources.
 *
 * FOLDABLE: a head listed in BOTH `objectShardUrls` (the read order) and the
 * overlay list, not the current write head, ATTACHED by this projector (a
 * product whose source it does not watch is refused at attach), whose
 * retirement row is `retired` (a folded head is gone; an `admitted` or missing
 * row is a head rotation did not retire, which is projected directly and may
 * not be folded), not SEALED, and SETTLED: its live heads equal its
 * `forwarded_heads` (or H_r), so every write it holds has been published or
 * forwarded. A product is foldable again (step 2 gives it a `retired` row).
 *
 * SEALED AND WINDOWED, as the summary plane's fold (`overlayChainFold.ts`,
 * whose measurements set both bounds): a head holding at least
 * `OVERLAY_SEGMENT_ENTITY_CEILING` entities is never folded again, and one
 * pass merges at most `OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES`. Without the seal
 * every fold re-merges the previous product and one document grows towards
 * every entity ever edited, a WASM heap the process never gets back; without
 * the window one pass's create and flush, held under the lock below, has no
 * bound. The residual is the summary plane's: a sealed run grows with total
 * writes, not with distinct entities.
 *
 * THE RUN is contiguous in BOTH lists: ModelMeta order is the last-wins order
 * (the cold build's `Object.assign`, `servedOutsideCurrentHead`), and only a
 * contiguous run can be replaced by one segment at its slot without moving a
 * value across a segment that outranks it.
 *
 * THE SEQUENCE, and what a crash after each step leaves:
 *  1. ownership, fence and plane. Nothing written.
 *  2. the `overlay-rotation:` lock, by REFUSAL (the rotator's key: a rotation
 *     and a fold of one kind never interleave; in-process the projector also
 *     makes a fold yield to a pending rotation). Nothing written.
 *  3. under the lock, FIRST: every recorded fold whose product ModelMeta does
 *     not list and was never folded again (a crash between steps 6 and 7, a
 *     `superseded` after the record) is published now — only if every source
 *     is still `folded` into it and its live heads still equal the forward
 *     state that row records; otherwise it is reported `unpublished` and, once
 *     `retainMs` old, ABANDONED: undone in one transaction
 *     (`abandonOrdinaryChainFold`: its sources `retired` again, its product's
 *     rows gone, the product left to GC), and the pass goes on. The wait is
 *     because a splice can reach a client before its flush and come back
 *     later. Then the rows nothing reads any more are swept
 *     (`sweepOrdinaryChainFoldRows`). Then the plan: rows read fresh, each
 *     candidate's document and heads sampled in ONE synchronous turn.
 *  4. the product: its marker in its creating change, its entities (the run
 *     merged in read order, last wins) in bounded changes after it, one
 *     timer tick apart (`createClaimedOverlaySegment`; one change of a whole
 *     fleet product was one 45–96 ms block of the event loop, G4-16 M3),
 *     all of them before it is flushed, then claimed (`createProduct`).
 *     Nothing names it until step 7. A crash leaves an orphan no row names:
 *     GC.
 *  5. ownership re-checked.
 *  6. the record (`recordOrdinaryChainFold`), on the lock's own client, in a
 *     bare BEGIN with plane and fence asserted inside (never the projection
 *     mutex: the global order is mutex BEFORE overlay-rotation), with no other
 *     await inside. The CAS on each source's `forwarded_heads` refuses a fold
 *     whose read a forward overtook. A crash after COMMIT: sources `folded`
 *     but still listed, still forwarding (step 2) — step 3 of the next pass.
 *  7. ownership, the current head and the run re-checked SYNCHRONOUSLY, then
 *     ONE ModelMeta change SPLICING the product in place of the run in both
 *     lists. In place, never a list assigned whole: a client's concurrent
 *     push into the read-order list (a new base shard, made offline) targets
 *     the document's own list and would be lost on a replaced one.
 *  8. ModelMeta flushed. The lock is released.
 *
 * A write that reaches a source after the sample and is not forwarded yet is
 * not in the product, but it is forwarded into the current head, which
 * ModelMeta lists after the product: it wins its row. The projector does not
 * attach the product until that forward commits (its settle check).
 *
 * KNOWN, NOT FIXED HERE:
 *  - a `$` conflict a source never healed collapses to Automerge's winner in
 *    the product's single change, so a later heal cannot recover the hidden
 *    branch. A cold build serves the same winner: the rows agree;
 *  - the product carries no `writeBatchIds`. The server's acknowledgements
 *    are unaffected (the sources' batches were acknowledged while current, or
 *    forwarded), but a client replaying a journaled intent checks batch-id
 *    membership in the listed overlay shards (`src/lib/automerge/bridge.ts`),
 *    and after a fold the sources' ids are no longer listed: the same residual
 *    daily compaction has. Copying them would make the projector re-acknowledge
 *    them under the product's id, rewriting their `document_id` and status;
 *  - an abandoned record's source that ModelMeta no longer lists goes back to
 *    `retired` with the rest, so GC no longer keeps it for `retain_until`:
 *    only a client that rewrote ModelMeta's lists can unlist one.
 */

export type OrdinaryChainFoldSkip =
  | 'chain-below-threshold'
  | 'no-foldable-run'
  /** Not enough is foldable now, but enough would be once `retired` heads
   * whose forward is in flight settle, or that the projector is still
   * attaching (a product just published, say) are watched. Worth retrying,
   * unlike the two above, which wait for the next rotation. */
  | 'sources-not-settled'

export interface OrdinaryChainFoldPlanInput {
  /** ModelMeta's read order for the kind (`objectShardUrls`). */
  shardUrls: readonly string[]
  /** ModelMeta's overlay list for the kind (`editsObjectShardUrls`). */
  overlayUrls: readonly string[]
  currentUrl: string | undefined
  foldable: (url: string) => boolean
  /** Entities a foldable head holds. */
  entityCountOf: (url: string) => number
  /** Fold once at least this many heads are foldable and unsealed. */
  minChain: number
  /** At most this many heads per fold. */
  budget: number
  /** A head holding at least this many entities is sealed: never folded. */
  segmentCeiling: number
  /** At most this many entities merged by one fold (a run of two always may). */
  windowEntities: number
}

export type OrdinaryChainFoldPlan =
  | { fold: string[] }
  | { fold: []; skippedReason: OrdinaryChainFoldSkip }

/** The oldest run of at least two foldable, unsealed heads, contiguous in
 * both lists, at most `budget` long and `windowEntities` large. Pure. */
export function planOrdinaryChainFold(input: OrdinaryChainFoldPlanInput): OrdinaryChainFoldPlan {
  const inOverlay = new Map(input.overlayUrls.map((url, index) => [url, index]))
  const candidate = (url: string): boolean =>
    url !== input.currentUrl && inOverlay.has(url) && input.foldable(url)
    && input.entityCountOf(url) < input.segmentCeiling
  if (input.shardUrls.filter(candidate).length < input.minChain) {
    return { fold: [], skippedReason: 'chain-below-threshold' }
  }
  const budget = Math.max(2, Math.trunc(input.budget))
  let at = 0
  while (at < input.shardUrls.length) {
    if (!candidate(input.shardUrls[at]!)) { at += 1; continue }
    const run = [input.shardUrls[at]!]
    let entities = input.entityCountOf(run[0]!)
    let next = at + 1
    while (next < input.shardUrls.length && run.length < budget) {
      const url = input.shardUrls[next]!
      // Contiguous in the overlay list too: the next shard is the next overlay entry.
      if (!candidate(url) || inOverlay.get(url) !== inOverlay.get(run[run.length - 1]!)! + 1) break
      const size = input.entityCountOf(url)
      if (run.length >= 2 && entities + size > input.windowEntities) break
      run.push(url)
      entities += size
      next += 1
    }
    if (run.length >= 2) return { fold: run }
    at = next
  }
  return { fold: [], skippedReason: 'no-foldable-run' }
}

/** Where the contiguous run `sources` starts in `list`, or -1 when they are
 * not all there, contiguous, in order, or `product` is already listed. Pure. */
export function foldedRunIndex(list: readonly string[], sources: readonly string[], product: string): number {
  const at = list.indexOf(sources[0]!)
  if (at < 0 || list.includes(product)) return -1
  for (let offset = 0; offset < sources.length; offset += 1) {
    if (list[at + offset] !== sources[offset]) return -1
  }
  return at
}

/** `list` with the run replaced by `product` at its slot, or null. Pure. */
export function substituteFoldedRun(
  list: readonly string[],
  sources: readonly string[],
  product: string,
): string[] | null {
  const at = foldedRunIndex(list, sources, product)
  return at < 0 ? null : [...list.slice(0, at), product, ...list.slice(at + sources.length)]
}

type MetaLike = Record<string, unknown>

const fieldsOf = (collection: OverlayCollection) => collection === 'object'
  ? { shards: 'objectShardUrls', overlay: 'editsObjectShardUrls', current: 'editsObjectShardUrl', entities: 'objects' } as const
  : { shards: 'connectionShardUrls', overlay: 'editsConnectionShardUrls', current: 'editsConnectionShardUrl', entities: 'connections' } as const

const listOf = (meta: MetaLike | undefined, field: string): string[] =>
  Array.isArray(meta?.[field]) ? (meta![field] as unknown[]).filter((url): url is string => typeof url === 'string') : []

const sameHeads = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((head, index) => head === b[index])
}

const documentIdOf = (url: string): DocumentId | null =>
  isValidAutomergeUrl(url) ? parseAutomergeUrl(url).documentId : null

export interface FoldOrdinaryChainArgs {
  key: WorkspaceKey
  collection: OverlayCollection
  /** ModelMeta, read live at every check, changed once. */
  meta: { documentId: DocumentId; doc(): MetaLike | undefined; change(fn: (meta: MetaLike) => void): void }
  minChain: number
  budget: number
  retainMs: number
  /** Defaults: the summary plane's measured bounds (`overlayChainFold.ts`). */
  segmentCeiling?: number
  windowEntities?: number
  /** Synchronous ownership (lease + projector not stopped). */
  mayWrite: () => boolean
  /** Is this listed segment ATTACHED by the projector (watched)? */
  watched: (url: string) => boolean
  /** Fence and plane, read from the database before anything is written. */
  assertAuthority: () => Promise<void>
  /** A pooled client: the lock is session-scoped and the record is committed on it. */
  connect: () => Promise<ReleasableQueryable>
  /** Inside the record's transaction: plane (`FOR KEY SHARE`) and write fence. */
  assertTransactionAuthority: (tx: Queryable) => Promise<void>
  /** A listed segment's resident document. */
  segment: (url: string) => Promise<{ documentId: DocumentId; doc(): unknown }>
  /** Create → write → flush → claim: `fields` in its creating change, `entities`
   * in bounded changes after it, every one before the flush. Null when the
   * build stopped before its claim — the projector stopped between two
   * chunks (a lost write fence throws instead): the pass ends `not-owner`. */
  createProduct: (entities: Record<string, unknown>, fields: Record<string, unknown>) =>
    Promise<{ url: string; documentId: DocumentId; doc(): unknown } | null>
  flush: (documentIds: DocumentId[]) => Promise<unknown>
  log?: (line: string) => void
  /** What the row sweep must leave (G4-16d): `hold` skips it altogether
   * (the projector's handover re-check has not run yet, so the heads it
   * will owe are not known), `documentIds` are the heads it owes now.
   * `announce: false` keeps the held line out of the log (the projector
   * logs it once per hold, not on every pass). Default: nothing. */
  sweepKeep?: () => { hold: boolean; announce?: boolean; documentIds: Iterable<string> }
}

export type FoldOrdinaryChainOutcome =
  | { outcome: 'not-owner' }
  | { outcome: 'lock-refused'; state: OverlayRotationLockState }
  | { outcome: 'skipped'; reason: OrdinaryChainFoldSkip }
  /** The record's CAS refused: a forward overtook the fold's read. The
   * product is an orphan no row names. */
  | { outcome: 'conflict'; productUrl: string; productDocumentId: DocumentId }
  /** Ownership, the current head or the run moved after the product existed. */
  | { outcome: 'superseded'; productUrl: string; productDocumentId: DocumentId; stage: 'before-record' | 'after-record' }
  | { outcome: 'folded'; productUrl: string; sources: string[]; recovered: boolean }

const UNRECORDED_PRODUCT = Symbol('ordinaryChainFold.unrecordedProduct')

/** Carried by an error a fold pass threw after its product existed and
 * before its record committed (the record's authority check, a lock
 * timeout, a transient error): that product's document id, for its lease. */
function markUnrecordedFoldProduct(error: unknown, documentId: DocumentId): void {
  if (!error || typeof error !== 'object') return
  try {
    Object.defineProperty(error, UNRECORDED_PRODUCT, { value: documentId, enumerable: false, configurable: true })
  } catch { /* a frozen error: the lease waits for the projector's stop */ }
}

/** The product a failed pass built and never recorded, or null. */
export function unrecordedFoldProductOf(error: unknown): DocumentId | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<symbol, unknown>)[UNRECORDED_PRODUCT]
  return typeof value === 'string' ? value as DocumentId : null
}

export async function foldOrdinaryChain(args: FoldOrdinaryChainArgs): Promise<FoldOrdinaryChainOutcome> {
  const log = args.log ?? ((line: string) => console.warn(line))
  const fields = fieldsOf(args.collection)
  const workspace = `${args.key.landscapeId}/${args.key.versionId}`
  const segmentCeiling = args.segmentCeiling ?? OVERLAY_SEGMENT_ENTITY_CEILING
  const windowEntities = args.windowEntities ?? OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES
  if (!args.mayWrite()) return { outcome: 'not-owner' }
  await args.assertAuthority()
  const lockKey = overlayRotationLockKey(args.key.landscapeId, args.key.versionId, args.collection)
  const client = await args.connect()
  let lock: OverlayRotationLockState = 'unknown'
  let heldSince = 0
  let inTransaction = false
  /** The product this pass built, and whether its record committed. */
  let builtProduct: DocumentId | null = null
  let recorded = false

  /** Step 7, shared by a new fold and a recovered one. Synchronous from the
   * check to the change; splices in place (see the header). */
  const publish = (sources: string[], productUrl: string): boolean => {
    const meta = args.meta.doc()
    const current = meta?.[fields.current]
    if (typeof current !== 'string' || sources.includes(current) || current === productUrl) return false
    const shardsAt = foldedRunIndex(listOf(meta, fields.shards), sources, productUrl)
    const overlayAt = foldedRunIndex(listOf(meta, fields.overlay), sources, productUrl)
    if (shardsAt < 0 || overlayAt < 0) return false
    args.meta.change((doc) => {
      (doc[fields.shards] as string[]).splice(shardsAt, sources.length, productUrl)
      ;(doc[fields.overlay] as string[]).splice(overlayAt, sources.length, productUrl)
    })
    return true
  }

  try {
    lock = await acquireOverlayRotationLock(client as unknown as PoolClient, lockKey)
    heldSince = Date.now()
    if (lock !== 'acquired') {
      reportOverlayRotationLockContended({
        path: 'fold', landscapeId: args.key.landscapeId, versionId: args.key.versionId,
        kind: args.collection, state: lock,
      })
      return { outcome: 'lock-refused', state: lock }
    }
    if (!args.mayWrite()) return { outcome: 'not-owner' }

    // Step 3a: the recorded folds ModelMeta does not list and whose product
    // was never folded again (its row still `retired`): a crash, or a
    // `superseded`, between the record and the publish. Each is published if
    // it can be; otherwise, once `retainMs` old, undone (step 5).
    let rows = await loadOrdinaryHeadRetirements(client, args.key)
    const listedAtStart = listOf(args.meta.doc(), fields.shards)
    const unpublished = (await retiredProductOrdinaryChainFolds(client, args.key, args.collection))
      .filter((record) => !listedAtStart.includes(stringifyAutomergeUrl({ documentId: record.productDocumentId as DocumentId })))
    let undone = false
    for (const pending of unpublished) {
      const productUrl = stringifyAutomergeUrl({ documentId: pending.productDocumentId as DocumentId })
      const listed = listOf(args.meta.doc(), fields.shards)
      const sourceUrls = new Set<string>(pending.sourceDocumentIds.map(
        (id) => stringifyAutomergeUrl({ documentId: id as DocumentId })))
      let reason = 'sources-unlisted'
      if ([...sourceUrls].every((url) => listed.includes(url))) {
        // In ModelMeta's order, which is the order the record does not keep.
        const ordered = listed.filter((url) => sourceUrls.has(url))
        // Unchanged since the record: a source rewritten in between (a
        // compaction's clear, say) would publish values older than its own.
        let unchanged = true
        for (const url of ordered) {
          const segment = await args.segment(url)
          const row = rows.get(retirementKey(args.collection, segment.documentId))
          const doc = segment.doc()
          unchanged &&= Boolean(row && row.status === 'folded' && row.foldedInto === pending.productDocumentId
            && row.retirementHeads && doc && sameHeads(getHeads(doc as never), row.forwardedHeads ?? row.retirementHeads))
        }
        if (!args.mayWrite()) return { outcome: 'not-owner' }
        if (unchanged && publish(ordered, productUrl)) {
          await args.flush([args.meta.documentId])
          log(JSON.stringify({
            event: 'read_model.ordinary_chain_folded', workspace, collection: args.collection,
            product: pending.productDocumentId, sources: pending.sourceDocumentIds, recovered: true,
          }))
          return { outcome: 'folded', productUrl, sources: ordered, recovered: true }
        }
        reason = unchanged ? 'run-not-publishable' : 'sources-changed'
      }
      if (!args.mayWrite()) return { outcome: 'not-owner' }
      // "Not listed here" is not "never published": the splice may have
      // reached a client before this owner's predecessor flushed it, and come
      // back. Within `retainMs` the record and its rows stay, so such a
      // listing is still accepted (`abandonOrdinaryChainFold`).
      if (pending.ageMs < args.retainMs) {
        log(JSON.stringify({
          event: 'read_model.ordinary_chain_fold_unpublished', workspace, collection: args.collection,
          product: pending.productDocumentId, sources: pending.sourceDocumentIds, reason,
          ageMs: pending.ageMs, abandonAfterMs: args.retainMs,
        }))
        continue
      }
      // Undone: its sources go back to `retired`, so this pass and later
      // ones can fold them again; the product is left to GC.
      await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
      inTransaction = true
      await args.assertTransactionAuthority(client)
      const abandoned = await abandonOrdinaryChainFold(client, args.key, {
        collection: args.collection, productDocumentId: pending.productDocumentId,
      })
      await client.query('COMMIT')
      inTransaction = false
      log(JSON.stringify(abandoned.outcome === 'abandoned'
        ? {
          event: 'read_model.ordinary_chain_fold_abandoned', workspace, collection: args.collection,
          product: pending.productDocumentId, sources: pending.sourceDocumentIds, reason,
          reverted: abandoned.reverted,
        }
        : {
          event: 'read_model.ordinary_chain_fold_abandon_not_pending', workspace, collection: args.collection,
          product: pending.productDocumentId,
        }))
      undone ||= abandoned.outcome === 'abandoned'
    }
    if (undone) rows = await loadOrdinaryHeadRetirements(client, args.key)

    // Step 3c (step 5): the rows nothing reads any more
    // (`sweepOrdinaryChainFoldRows`), only when a `folded` row names a product
    // that is not `retired`. Housekeeping: its failure is logged, and the
    // pass goes on to the plan.
    const sweepable = [...rows.values()].some((row) => row.collection === args.collection
      && row.status === 'folded' && row.foldedInto !== null
      && rows.get(retirementKey(args.collection, row.foldedInto))?.status !== 'retired')
    // Asked only when there IS something to sweep: the projector logs the
    // held line once per hold, on the first pass that would have swept.
    const keep = sweepable ? args.sweepKeep?.() ?? { hold: false, documentIds: [] } : { hold: false, documentIds: [] }
    if (sweepable && keep.hold && keep.announce !== false) {
      log(JSON.stringify({
        event: 'read_model.ordinary_chain_fold_rows_sweep_held', workspace, collection: args.collection,
        reason: 'handover-recheck-pending',
      }))
    }
    if (sweepable && !keep.hold) {
      await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
      inTransaction = true
      await args.assertTransactionAuthority(client)
      let swept: { rows: number; records: number } | undefined
      try {
        swept = await sweepOrdinaryChainFoldRows(client, args.key, args.collection, undefined, [...keep.documentIds])
      } catch (error) {
        log(JSON.stringify({
          event: 'read_model.ordinary_chain_fold_rows_sweep_failed', workspace, collection: args.collection,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
      await client.query(swept ? 'COMMIT' : 'ROLLBACK')
      inTransaction = false
      if (swept && (swept.rows || swept.records)) {
        log(JSON.stringify({
          event: 'read_model.ordinary_chain_fold_rows_swept', workspace, collection: args.collection,
          rows: swept.rows, records: swept.records,
        }))
      }
    }

    // Step 3b: the plan. The row first (no document resolved for a head that
    // is not foldable anyway), then ONE synchronous turn per candidate: the
    // heads judged and the content folded are the same immutable document.
    const meta = args.meta.doc()
    const shardUrls = listOf(meta, fields.shards)
    const overlayUrls = listOf(meta, fields.overlay)
    const currentUrl = typeof meta?.[fields.current] === 'string' ? meta[fields.current] as string : undefined
    const overlaySet = new Set(overlayUrls)
    const samples = new Map<string, { documentId: DocumentId; doc: Record<string, unknown>; entities: number; forwardedHeads: string[] | null }>()
    const unsettled = new Set<string>()
    for (const url of shardUrls) {
      if (url === currentUrl || !overlaySet.has(url)) continue
      const documentId = documentIdOf(url)
      const row = documentId ? rows.get(retirementKey(args.collection, documentId)) : undefined
      if (row?.status !== 'retired' || !row.retirementHeads) continue
      // Still being attached: pending, like an unsettled head.
      if (!args.watched(url)) { unsettled.add(url); continue }
      const segment = await args.segment(url)
      const doc = segment.doc() as Record<string, unknown> | undefined
      if (!doc) continue
      const entities = doc[fields.entities]
      if (!entities || typeof entities !== 'object' || Array.isArray(entities)) continue
      const size = Object.keys(entities).length
      if (!sameHeads(getHeads(doc as never), row.forwardedHeads ?? row.retirementHeads)) {
        if (size < segmentCeiling) unsettled.add(url)
        continue
      }
      samples.set(url, { documentId: segment.documentId, doc, entities: size, forwardedHeads: row.forwardedHeads })
    }
    const planInput = {
      shardUrls, overlayUrls, currentUrl, minChain: args.minChain, budget: args.budget,
      segmentCeiling, windowEntities,
      entityCountOf: (url: string) => samples.get(url)?.entities ?? 0,
    }
    const plan = planOrdinaryChainFold({ ...planInput, foldable: (url) => samples.has(url) })
    if (!plan.fold.length) {
      const reason = (plan as { skippedReason: OrdinaryChainFoldSkip }).skippedReason
      // Would the unsettled heads, once settled, make a fold possible?
      const settledPlan = unsettled.size
        ? planOrdinaryChainFold({ ...planInput, foldable: (url) => samples.has(url) || unsettled.has(url) })
        : plan
      return { outcome: 'skipped', reason: settledPlan.fold.length ? 'sources-not-settled' : reason }
    }
    const sources = plan.fold

    // Step 4: the product, written whole before its flush. Only the run is copied.
    const merged = foldOverlaySegmentContents(sources.map((url) =>
      JSON.parse(JSON.stringify(samples.get(url)!.doc[fields.entities])) as Record<string, unknown>))
    const product = await args.createProduct(merged, { [ORDINARY_FOLD_SOURCES_FIELD]: sources })
    // Null: the projector stopped between two chunks: nothing claimed,
    // nothing recorded.
    if (!product) return { outcome: 'not-owner' }
    builtProduct = product.documentId

    // Step 5.
    const currentNow = args.meta.doc()?.[fields.current]
    const currentDocumentId = typeof currentNow === 'string' ? documentIdOf(currentNow) : null
    if (!args.mayWrite() || !currentDocumentId) {
      return { outcome: 'superseded', productUrl: product.url, productDocumentId: product.documentId, stage: 'before-record' }
    }

    // Step 6: the record. Nothing awaited in the transaction but its statements.
    const productHeads = getHeads(product.doc() as never)
    const retainUntil = new Date(Date.now() + args.retainMs)
    await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
    inTransaction = true
    await args.assertTransactionAuthority(client)
    try {
      await recordOrdinaryChainFold(client, args.key, {
        collection: args.collection,
        productDocumentId: product.documentId,
        productHeads,
        currentDocumentId,
        sources: sources.map((url) => ({
          documentId: samples.get(url)!.documentId, forwardedHeads: samples.get(url)!.forwardedHeads,
        })),
        retainUntil,
      })
    } catch (error) {
      if ((error as Error).name !== 'OrdinaryChainFoldConflictError') throw error
      await client.query('ROLLBACK')
      inTransaction = false
      log(JSON.stringify({
        event: 'read_model.ordinary_chain_fold_conflict', workspace, collection: args.collection,
        product: product.documentId, error: (error as Error).message,
      }))
      return { outcome: 'conflict', productUrl: product.url, productDocumentId: product.documentId }
    }
    await client.query('COMMIT')
    inTransaction = false
    recorded = true

    // Steps 7 and 8.
    if (!args.mayWrite() || !publish(sources, product.url)) {
      return { outcome: 'superseded', productUrl: product.url, productDocumentId: product.documentId, stage: 'after-record' }
    }
    await args.flush([args.meta.documentId])
    log(JSON.stringify({
      event: 'read_model.ordinary_chain_folded', workspace, collection: args.collection,
      product: product.documentId, sources: sources.map((url) => samples.get(url)!.documentId),
      entities: Object.keys(merged).length, recovered: false,
    }))
    return { outcome: 'folded', productUrl: product.url, sources, recovered: false }
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    // A product built and not recorded is an orphan no row names: the
    // caller gives its lease back (`unrecordedFoldProductOf`). Not marked once
    // the record has committed; whoever releases it then (a superseded
    // after-record, a COMMIT whose answer was lost) does so safely too: the
    // product is flushed, and the pass that publishes or attaches it reloads it.
    if (builtProduct && !recorded) markUnrecordedFoldProduct(error, builtProduct)
    throw error
  } finally {
    await releaseOverlayRotationLock(client as unknown as PoolClient, lockKey, lock)
    // Acquired to released: the time a rotation of this kind was refused for.
    if (lock === 'acquired') {
      // `at` places the hold in its quarter of the run (the bench's summary).
      const at = Date.now()
      log(JSON.stringify({
        event: 'read_model.ordinary_chain_fold_lock_held', workspace, collection: args.collection,
        at, heldMs: at - heldSince,
      }))
    }
  }
}
