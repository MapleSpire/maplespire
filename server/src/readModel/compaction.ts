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

import type { Repo, DocHandle } from '@automerge/automerge-repo'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { Float64, getHeads, isCounter, isImmutableString } from '@automerge/automerge'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { appendMetaUrl, readMetaUrl, readMetaUrls, writeMetaUrl, writeMetaUrls } from '../modelMetaUrls.js'
import { createClaimedDocument } from '../rbac/docScope.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import { BoundedResolveDeadlineError, SERVER_SHARD_RESOLVE_BATCH_SIZE, resolveWithBoundedConcurrency } from './batchedResolve.js'
import {
  OVERLAY_REMATERIALIZE_MESSAGE, clearedEntryEditsYielding, rematerializedEntity, sameDocumentValue, valueAtPath,
  type ClearScanRow, type ClearScanSave, type ClearedEntryEdit, type DeclinedWrite, type ScanStats,
} from './overlayClearRematerialize.js'

/**
 * Overlay compaction (the daily background job).
 *
 * Clients write all object/connection edits (new + edited, on- or off-diagram) into ONE
 * persistent, model-level "edits overlay" shard, kept LAST in ModelMeta.{object,
 * connection}ShardUrls so the read model overlays it last-wins. That overlay grows with
 * cumulative edits; compaction folds it back into the base shards (in place) and clears
 * it, resetting the per-session first-edit fetch cost to ~zero.
 *
 * CRDT-safe under concurrent editing (clients keep writing the overlay during the run):
 *   - we snapshot the overlay, fold the snapshot into the base shards, then CONDITIONALLY
 *     clear — deleting an overlay entry ONLY if it still deep-equals the folded snapshot.
 *     An entry edited since the snapshot differs → it is KEPT for the next run (its old
 *     value was folded, but the read model still reads the newer overlay copy last-wins);
 *   - Automerge map put-wins also protects an edit that lands during the clear change.
 * WHAT THAT ARGUMENT COVERS. It quantifies over ONE compactor and N clients: every
 * writer other than the compactor writes the OVERLAY, which is exactly what the
 * snapshot / conditional-clear pair reasons about. No such edit is lost; at worst a
 * concurrently-edited entry is folded next time.
 *
 * WHAT IT DOES NOT COVER — a SECOND COMPACTOR, which writes the BASE shards and so
 * lies outside everything quantified above. This header therefore claims nothing
 * about two concurrent compactions. They cannot overlap, and the two independent
 * exclusions that prevent it are tested in
 * `compactionExclusionToday.integration.test.ts`: an advisory lock per job NAME
 * refuses a second replica outright, and a single-flight latch joins a second
 * in-process caller to the run already in flight.
 *
 * Two concurrent compactions are UNPROVEN, not safe. Anyone removing or
 * replacing either exclusion (e.g. with per-workspace scheduling) must revisit
 * this argument.
 *
 * The Automerge docs are the source of truth and are always left correct. The Postgres
 * read model is reconciled by the caller (it restarts the projector, whose cold build
 * re-derives overlay-last-wins from the compacted shards).
 *
 * ON A ROTATED, FOLDED ORDINARY WORKSPACE (G4-16i). The clear REWRITES every listed
 * segment, and two kinds of segment have a server-side row that says what the
 * segment holds (`ordinaryHeadForwarding.ts`):
 *  - a fold PRODUCT has a `retired` row whose H_r is its heads at creation, and
 *    nothing forwards a product (`ordinaryChainFold.ts`). Cleared and left so, it
 *    reads as unsettled for ever: the fold never takes it again and every later
 *    compaction refused `retired_head_forward_pending` on it (measured on the
 *    G4-16f aged bench, `compactionOrdinaryFold.integration.test.ts` W1);
 *  - the head this pass REPLACES (the current one) had no row, so it was projected
 *    directly and split every fold run that crossed it; nothing bounded the chain.
 * So, between the clear and the ModelMeta change, every segment's heads are
 * captured in the SAME synchronous turn as the clear, the segments are flushed
 * (a row must never name heads the stored document lacks), and
 * `settleRewrittenSegments` records them (`workspaceCompaction.ts`,
 * `settleCompactedOrdinarySegments`) — BEFORE ModelMeta moves, the contract of
 * `ordinaryHeadForwarding.ts` on order. A throw from it propagates and ModelMeta
 * is not repointed: the overlay is cleared and the read model reads the base
 * last-wins, which is what the next pass finds. A write that reaches a segment
 * after the capture is after its H_r / `forwarded_heads`, and the forwarder
 * carries it into the fresh head once the projector re-attaches.
 */

interface RootLike {
  modelMetaUrl?: string
}
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  editsOverlayWriteHeadVersion?: number
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
}
/** A model shard read/written structurally: collectionKey → (id → entity). */
type ShardDoc = Record<string, Record<string, unknown>>

/**
 * The compaction's segment-list write: `url` appended, the list deduplicated
 * (first kept) — what it always wrote — IN PLACE, not assigned whole: one
 * compaction a day would otherwise re-create every segment url in
 * ModelMeta's history (G4-16f), through `modelMetaUrls.ts` (text or scalar by
 * the document's marker). Synchronous; inside the ModelMeta `change`.
 * Exported for its test.
 */
export function appendCompactionSegmentInPlace(
  meta: MetaLike,
  field: 'editsObjectShardUrls' | 'editsConnectionShardUrls',
  url: string,
): void {
  writeMetaUrls(meta, field, [...new Set([...(readMetaUrls(meta, field) ?? []), url])])
}

/**
 * The fold's base-shard write: make `target[key]` hold `next` — the state a
 * whole assignment (`target[key] = next`) would leave — while writing only what
 * differs. Synchronous; inside the base shard's `change`. `target` is a map
 * proxy of that change, `next` a value materialized from an overlay segment
 * (`handle.doc()`). Exported for its test.
 *
 * WHY (G4-16f): a whole assignment makes a NEW map in Automerge 3, so every
 * field is written again, and every string field is a text object, one
 * operation per character. Measured on one base shard of 500 aged-bench
 * entities, 40 of them folded per pass: re-folding them UNCHANGED cost 16 730
 * operations and 34.8 KB of history per pass; with this helper 0. With one
 * short field changed per entity: 16 410 operations and 34.4 KB, against 400
 * and 2.3 KB.
 *
 * What it writes:
 *  - equal values (by {@link sameFoldValue}) are left as they are;
 *  - two maps are merged key by key, and a key `next` lacks is DELETED — the
 *    overlay entry is the entity's whole value, as the assignment made it;
 *  - anything else (a list that differs, a changed string or number, a kind
 *    change such as text ↔ ImmutableString or map ↔ list) is assigned whole,
 *    exactly as before. A changed string is therefore a new text object, not
 *    an `updateText` splice: the field keeps the assignment's last-writer-wins
 *    behaviour, and a splice of a rewritten string cost MORE history (probe:
 *    59–69 KB per pass against 41 KB).
 *
 * PARITY with the whole assignment is SEQUENTIAL, and it has three limits
 * (all pinned in `compactionFieldFold.test.ts`):
 *  - DATATYPE. Automerge 3.2.6 encodes a number differently in a nested value
 *    (what the whole assignment writes) and in a scalar put (what a merged
 *    field write is): nested, a positive integer is `int` and every other
 *    number — `0`, `-0`, a negative integer, a fraction — is `f64`; a scalar
 *    put makes every integer `int`, `-0` included (measured with
 *    `getBackend(doc).getWithType`). So a changed number below the entity is
 *    written as `Float64` where the nested encoding gives `f64`, and a change
 *    to or from `-0` re-assigns its enclosing map whole (`Float64` turns `-0`
 *    into `0`, and a put of `Float64(0)` over a stored `-0` is dropped as a
 *    no-op, while a plain `0` put stores `int 0`).
 *    An EQUAL value is not rewritten and
 *    keeps whatever datatype it already had, which the whole assignment
 *    would have re-encoded;
 *  - CONFLICTS. A field holding concurrent values whose winner equals the
 *    overlay is left as it is; the whole assignment overwrote it and so
 *    resolved the conflict;
 *  - CONCURRENT WRITERS (a full-model client writes base shards, `bridge.ts`
 *    `writeModelShards`). A peer's put of a field the fold does not write
 *    SURVIVES the merge (the whole assignment made a new map, and the peer's
 *    put landed on the abandoned one), and a peer's DELETE of the entity
 *    WINS (the fold writes inside the existing map and never puts the
 *    entity's key, where the whole assignment's put resurrected it).
 *
 * Not preserved, because it is not state: the IDENTITY of a map object that is
 * merged rather than re-created.
 */
export function foldValueInPlace(target: Record<string, unknown>, key: string, next: unknown): void {
  foldInto(target, key, next, false)
}

function foldInto(target: Record<string, unknown>, key: string, next: unknown, nested: boolean): void {
  const current = target[key]
  if (sameFoldValue(current, next)) return
  if (isFoldMap(current) && isFoldMap(next)) {
    // `-0` has no scalar spelling that keeps its sign, and a put of
    // `Float64(0)` over `-0` is dropped as a no-op (measured: the stored `-0`
    // stays; a plain `0` put would store `int 0`, the wrong datatype). Either
    // change re-assigns the map whole, which is what the whole assignment
    // wrote anyway.
    if (Object.keys(next).some((k) => !sameFoldValue(current[k], next[k])
      && (Object.is(next[k], -0) || (Object.is(current[k], -0) && next[k] === 0)))) {
      target[key] = next
      return
    }
    for (const k of Object.keys(current)) if (!Object.hasOwn(next, k)) delete current[k]
    for (const k of Object.keys(next)) foldInto(current, k, next[k], true)
    return
  }
  target[key] = nested && typeof next === 'number' ? nestedNumber(next) : next
}

/** A number spelled so that a scalar put stores the datatype the NESTED
 * encoding gives it (see {@link foldValueInPlace}): positive integers `int`,
 * every other number `f64`. `NaN` is not an integer, so a plain put already
 * stores it as `f64` (and `Float64` would turn it into `0`). */
function nestedNumber(value: number): number | Float64 {
  if (Number.isNaN(value) || (Number.isInteger(value) && value > 0)) return value
  return new Float64(value)
}

/** A plain map, read through a change proxy or materialized. ARRAY FIRST:
 * Automerge 3.2.6's list proxy answers `true` to `isImmutableString` and
 * `isCounter` (measured; `has` reports every symbol), so those tests are only
 * meaningful once a list has been ruled out. */
function isFoldMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isImmutableString(value) && !isCounter(value)
    && !(value instanceof Date) && !(value instanceof Uint8Array)
}

/** Equality of a value read through a change proxy and a materialized one,
 * KIND included: text reads back as a `string` from both, a scalar string as an
 * `ImmutableString`, so `'a'` and `ImmutableString('a')` differ and the
 * assignment that would change the kind still happens. */
export function sameFoldValue(a: unknown, b: unknown): boolean {
  // `Object.is`: `0` and `-0` differ, as their stored values do.
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameFoldValue(a[i], b[i])) return false
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (isImmutableString(a) || isImmutableString(b)) {
    return isImmutableString(a) && isImmutableString(b) && a.val === b.val
  }
  if (isCounter(a) || isCounter(b)) return isCounter(a) && isCounter(b) && a.value === b.value
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array
      && a.length === b.length && a.every((byte, i) => byte === b[i])
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false
    if (!sameFoldValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** Max objects/connections per base shard when compaction has to place a newly-created
 * id that has no base shard yet. Mirrors the client's VITE_MODEL_SHARD_SIZE default. */
const DEFAULT_SHARD_SIZE = Number(process.env.AM_MODEL_SHARD_SIZE ?? 512)

/**
 * The CLEAR's change message. A browser rescues an offline edit inside an entry
 * only when the delete that erased it is this one (`overlayClearRescue.ts`,
 * which names the same string): a colleague's explicit delete, or the tombstone
 * deletes above, carry none and are never undone. Changing it breaks the rescue
 * of browsers built against the old string.
 */
export const OVERLAY_COMPACTION_CLEAR_MESSAGE = 'maplespire:overlay-compaction-clear'

export interface CompactionResult {
  objectsFolded: number
  connectionsFolded: number
  /** Entries kept (concurrently edited during the run) — folded on a later pass. */
  objectsKept: number
  connectionsKept: number
  /** Tombstoned ids removed from the base shards + overlay this run. */
  objectsDeleted: number
  connectionsDeleted: number
  /** G4-16k: entities whose offline edits an earlier clear erased, written
   * again this pass (`rematerializeClearedEdits`). Absent: none. */
  objectsRematerialized?: number
  connectionsRematerialized?: number
  /** G4-16k: the step failed (per collection, its error); the fold went on
   * and the next pass reads the same changes again. Absent: no failure. */
  rematerializeFailed?: string[]
  /** `projection_not_acknowledged` is deliberately ABSENT: `compactOverlay`
   *  never sets it; it lives on `WorkspaceCompactionSkip`, where the caller
   *  that decides it does. */
  skippedReason?: 'static_baseline' | 'ownership_lost_mid_fold' | 'rematerialize_cursor_unsaved' | CompactionSegmentRefusal
}

/** Why `lateWritesPending` refuses a pass: a retired head holds a late write not
 * forwarded yet, or a listed segment is a source of a fold RECORDED and not
 * published (`workspaceCompaction.ts`). */
export type CompactionSegmentRefusal = 'retired_head_forward_pending' | 'ordinary_fold_unpublished'

/** A listed overlay segment as a pass sampled it (heads read in the same
 * synchronous turn as its content). */
export interface CompactionSegment {
  documentId: string
  heads: readonly string[]
  current: boolean
}

/**
 * Whether this call may WRITE.
 *
 * Required on `CompactionOptions`, with no default, and that is the whole design:
 * `compactOverlay` rewrites base shards and clears the overlay. A new call site
 * that forgets to say which side it is on must not silently get the
 * destructive one — so the type refuses to compile rather than defaulting.
 */
export type CompactionMode = 'preview' | 'apply'

export interface CompactionOptions {
  /** REQUIRED. See `CompactionMode` — there is deliberately no default. */
  mode: CompactionMode
  /**
   * G4-16k: where each overlay segment's last rematerialization scan stopped
   * (its heads then), and how to record a new one — after the writes it led
   * to are flushed. A segment with no row starts at its heads when first
   * seen, so without a store nothing is ever read and nothing rewritten.
   */
  /**
   * G4-16k: how long ago a pass must have FIRST SEEN every late change of an
   * entry before the server writes it back — by the server's clock, recorded
   * in the scan row (the author's `change.time` would let a clock set in the
   * past skip the grace, and one set in the future park the segment for
   * ever). Younger, it waits — the
   * segment's scan is not recorded past it — and the browser's own rescue,
   * the fast path, has that long to apply it. Measured without it, on one
   * stack: the server wrote back, ten
   * minutes after her reconnection, 67 edits her browser had rescued into the
   * retired epoch's export, while she edited the same fields offline again;
   * 14 of her new values lost the concurrent conflict. Default 0 (the
   * DB-free suites); the production caller passes a day
   * (`workspaceCompaction.ts`).
   */
  rematerializeGraceMs?: number
  /** The writes the authors unchecked in the batch re-apply, per
   * entity id — never written back — and the ones still pending their
   * decision, held back until it is made (`declinedOverrideWrites`). Absent: none. */
  declinedEdits?: (collection: 'object' | 'connection', ids: readonly string[]) => Promise<ReadonlyMap<string, ReadonlyArray<DeclinedWrite>>>
  clearScans?: {
    /** Every recorded scan of the workspace's segments of `collection`, by
     * document id, the least recently saved first. */
    load: (collection: 'object' | 'connection') => Promise<ReadonlyMap<string, ClearScanRow>>
    /** `onlyNew`: a row that exists already is left as it is (a first sighting). */
    save: (collection: 'object' | 'connection', scans: ReadonlyArray<ClearScanSave>, options?: { onlyNew?: boolean }) => Promise<void>
    /** The rows of segments the repo answered are gone. Absent: kept. */
    purge?: (collection: 'object' | 'connection', documentIds: readonly string[]) => Promise<void>
  }
  /** TEST SEAM: the server clock of the grace period. Default `Date.now`. */
  now?: () => number
  /** TEST SEAM: how the scan gives the event loop back between its steps.
   * Default `setImmediate`. */
  yieldToEventLoop?: () => Promise<void>
  /** The segments known ONLY by their scan row (no list names them) resolved
   * per pass, the least recently scanned first. Default
   * {@link REMATERIALIZE_UNNAMED_SEGMENTS_PER_PASS}. */
  rematerializeUnnamedPerPass?: number
  /** The changes the scan decodes per pass and collection; the segment that
   * crosses it is the last one read (the first is always read). Default
   * {@link REMATERIALIZE_DECODE_BUDGET}. */
  rematerializeDecodeBudget?: number
  /** Objects/connections per shard when placing created ids (tests inject a small one). */
  shardSize?: number
  /** Immutable performance baselines must never be destructively rewritten. */
  staticBaseline?: boolean
  /** Claim-at-write: the workspace the rotated heads and overflow shards
   * belong to. Optional for the DB-free unit suites; the production caller
   * (index.ts's daily job) always passes it — a claim throw aborts the
   * compaction before any pointer is published, and the orphan is GC fodder. */
  workspace?: WorkspaceKey
  /**
   * Re-asked immediately before the FIRST write and again before the destructive
   * CLEAR. Returning false aborts with `skippedReason: 'ownership_lost_mid_fold'`.
   *
   * The caller checks ownership and ordinariness ONCE, before the run. Resolving
   * the base shards is an unbounded await in between — every shard is fetched —
   * and two things can change under it: the lease can move to another cell, and
   * the workspace can be PROMOTED to summary, which hands its base shards to
   * `StaticDeltaProjector` while this compactor is still writing them. A check
   * that happens once answers a question about a moment that has passed.
   *
   * The two consultation points are not symmetric, and that asymmetry is why
   * aborting is safe rather than merely early. Folding into the base is
   * idempotent: the overlay still holds the same entries, the read model reads
   * it last-wins, and the next pass folds again. CLEARING the overlay is the
   * destructive half — the only step after which the base is the sole home of
   * the value. Refusing before the second one is what stops a lost lease from
   * becoming a lost edit.
   *
   * WHAT REFUSING DOES NOT PROMISE: it does not leave the meta document in
   * every respect as it would have been. `editsOverlayWriteHeadVersion` is
   * per-META and means BOTH overlay heads are current-protocol, but it is set by
   * the objects pass; a connections pass that then refuses leaves the flag
   * asserting a version over an unrotated connection head. The empty-collection
   * early return can produce the same half-state. No edit is lost by it; a
   * client can be made to materialise a large history.
   */
  stillSafeToWrite?: () => Promise<boolean>
  /**
   * Which overlay segments hold late writes the ordinary forwarder has not
   * carried into the current head yet (`ordinaryHeadLateWritesPending`,
   * `ordinaryHeadForwarding.ts`), given each segment's heads AS THIS PASS
   * SNAPSHOT THEM. Asked in `apply` mode only, for BOTH collections, after
   * each one's snapshot and before the first write of EITHER; any answer
   * aborts the whole pass with `retired_head_forward_pending`, and then
   * nothing was written (`compaction.test.ts`, "a CONNECTION late write
   * pending refuses the pass BEFORE the objects pass writes anything").
   *
   * Why the fold cannot simply run: it `Object.assign`s every segment oldest →
   * newest, so a retired head's un-forwarded FIELD edit is folded under the
   * current head's whole entity, and the conditional clear then deletes it
   * from the retired head (it still equals the snapshot) — the edit is gone
   * from every document. Once forwarded, the current head carries it and the
   * fold is the cold build's own order. A late write that lands AFTER the
   * snapshot differs from it and is kept by the conditional clear, and the
   * forwarder carries it after the re-attach.
   *
   * The production caller (`workspaceCompaction.ts`) always passes it; the
   * DB-free unit suites do not, and have no rows to consult.
   *
   * A bare list refuses with `retired_head_forward_pending`; `{ reason,
   * segments }` names the reason (`ordinary_fold_unpublished`: a listed
   * segment is the source of a fold recorded and not published, whose
   * recovery would publish a product built from the content this pass is
   * about to clear — `workspaceCompaction.ts`).
   */
  lateWritesPending?: (
    collection: 'object' | 'connection',
    segments: ReadonlyArray<CompactionSegment>,
  ) => Promise<readonly string[] | { reason: CompactionSegmentRefusal; segments: readonly string[] }>
  /**
   * Called once per collection that wrote, in `apply` mode only, AFTER the clear
   * and BEFORE the ModelMeta change that repoints the write head, with EVERY
   * listed segment's heads captured in the same synchronous turn as the clear
   * (and the segments flushed first). The production caller records them
   * (`settleCompactedOrdinarySegments`): the replaced head's `retired` row, a
   * rewritten fold product's `forwarded_heads`. A throw propagates and
   * ModelMeta is NOT repointed.
   */
  settleRewrittenSegments?: (
    collection: 'object' | 'connection',
    segments: ReadonlyArray<CompactionSegment>,
  ) => Promise<void>
  /**
   * G4-16f diagnosis F1: called once, in `apply` mode, after BOTH collections
   * applied without refusal (the clear and the ModelMeta change done), with
   * every base shard the pass resolved, so their storage can be compacted to
   * one snapshot each before the caller re-attaches
   * (`workspaceCompaction.ts`, `PostgresStorageAdapter.compactToSnapshot`).
   * Its outcome never changes the pass's: the caller catches and reports.
   * Absent (the DB-free suites): nothing.
   */
  compactBaseShardStorage?: (handles: ReadonlyArray<DocHandle<unknown>>) => Promise<void>
  /** TEST SEAM: the pass's single resolution ceiling, default
   * {@link COMPACTION_RESOLVE_DEADLINE_MS}. */
  resolveDeadlineMs?: number
}

export async function compactOverlay(repo: Repo, rootUrl: string, opts: CompactionOptions): Promise<CompactionResult> {
  const shardSize = opts.shardSize ?? DEFAULT_SHARD_SIZE
  const empty: CompactionResult = {
    objectsFolded: 0, connectionsFolded: 0, objectsKept: 0, connectionsKept: 0,
    objectsDeleted: 0, connectionsDeleted: 0,
  }
  if (opts.staticBaseline) return { ...empty, skippedReason: 'static_baseline' }
  const resolve = async <T>(url: string): Promise<DocHandle<T>> => {
    const h = await findReadyDocument<T>(repo, url)
    return h
  }

  const rootHandle = await resolve<RootLike>(rootUrl)
  const root = rootHandle.doc()
  if (!root?.modelMetaUrl || !isValidAutomergeUrl(root.modelMetaUrl)) return empty
  const metaHandle = await resolve<MetaLike>(root.modelMetaUrl)
  if (!metaHandle.doc()) return empty

  const claim = opts.workspace ? { workspace: opts.workspace, rootUrl } : undefined
  // G4-16k, BEFORE the fold reads its snapshot: an offline edit an earlier
  // pass's clear erased is written back where its entity lives now, so this
  // pass folds it like any other value. Apply mode only (a preview writes
  // nothing). Its own resolution ceiling, taken before the fold's: a failure
  // or a ceiling here is reported and the fold goes on unchanged.
  // A quarter of the pass's ceiling: the step can add at most
  // that to a pass's wait.
  const rematerializeDeadlineAt = Date.now() + Math.min(opts.resolveDeadlineMs ?? COMPACTION_RESOLVE_DEADLINE_MS, COMPACTION_RESOLVE_DEADLINE_MS / 4)
  const notRun: RematerializeOutcome = { written: 0 }
  const remObjects = opts.mode === 'apply'
    ? await rematerializeClearedEdits(repo, resolve, metaHandle, 'objects', 'objectShardUrls', 'editsObjectShardUrl', 'editsObjectShardUrls', 'deletedObjectIds', opts, rematerializeDeadlineAt)
    : notRun
  const remConnections = opts.mode === 'apply' && !remObjects.ownershipLost
    ? await rematerializeClearedEdits(repo, resolve, metaHandle, 'connections', 'connectionShardUrls', 'editsConnectionShardUrl', 'editsConnectionShardUrls', 'deletedConnectionIds', opts, rematerializeDeadlineAt)
    : notRun
  const rematerializeFailed = [remObjects.failed, remConnections.failed].filter((f): f is string => !!f)
  const rematerializedCounts = {
    ...(remObjects.written ? { objectsRematerialized: remObjects.written } : {}),
    ...(remConnections.written ? { connectionsRematerialized: remConnections.written } : {}),
    ...(rematerializeFailed.length ? { rematerializeFailed } : {}),
  }
  // The ownership guard said no inside the step: the pass stops there, as
  // the fold's own guard would have stopped it.
  if (remObjects.ownershipLost || remConnections.ownershipLost) {
    return { ...empty, ...rematerializedCounts, skippedReason: 'ownership_lost_mid_fold' }
  }
  // A segment seen for the first time whose scan row was not saved
  // would start, next pass, AFTER this pass's clear — the edits that clear
  // erases would never be repaired. Nothing is folded or cleared.
  if (remObjects.firstRowsUnsaved || remConnections.firstRowsUnsaved) {
    return { ...empty, ...rematerializedCounts, skippedReason: 'rematerialize_cursor_unsaved' }
  }
  // ONE resolution ceiling for the whole pass (its four lists), not one each.
  const resolveDeadlineAt = Date.now() + (opts.resolveDeadlineMs ?? COMPACTION_RESOLVE_DEADLINE_MS)
  // BOTH collections are READ — snapshot, heads, and the `lateWritesPending`
  // answer — before EITHER writes. Asked per collection inside its own pass,
  // an objects pass that folded and flushed was followed by a connections
  // pass that refused, and the caller reported "nothing was written" over a
  // written base shard (phase-3 review). The connections snapshot is then
  // older than the objects writes; that is the conditional clear's ordinary
  // case (an entry that changed after its snapshot is kept).
  const objPrepared = await prepareFold(repo, resolve, metaHandle, 'objects', 'objectShardUrls', 'editsObjectShardUrl', 'editsObjectShardUrls', 'deletedObjectIds', shardSize, opts.mode, claim, opts.stillSafeToWrite, opts.lateWritesPending, opts.settleRewrittenSegments, resolveDeadlineAt)
  // The connections pass is SKIPPED once the objects pass has refused: the
  // predicate said this process may no longer write, and starting a second
  // collection would be writing anyway. Its own guard would catch it, but
  // relying on that would mean resolving every connection shard first, for a
  // pass already known to be refused.
  const refusedEarly = !('apply' in objPrepared) && objPrepared.aborted
  const connPrepared = refusedEarly
    ? { folded: 0, kept: 0, deleted: 0, aborted: true as const }
    : await prepareFold(repo, resolve, metaHandle, 'connections', 'connectionShardUrls', 'editsConnectionShardUrl', 'editsConnectionShardUrls', 'deletedConnectionIds', shardSize, opts.mode, claim, opts.stillSafeToWrite, opts.lateWritesPending, opts.settleRewrittenSegments, resolveDeadlineAt)
  // A connections refusal found while reading: the objects pass never writes.
  const connRefused = !('apply' in connPrepared) && connPrepared.aborted
  const none = { folded: 0, kept: 0, deleted: 0 }
  const obj: FoldOutcome = 'apply' in objPrepared
    ? (connRefused ? none : await objPrepared.apply())
    : objPrepared
  const conn: FoldOutcome = 'apply' in connPrepared
    ? (obj.aborted ? { folded: 0, kept: 0, deleted: 0, aborted: true } : await connPrepared.apply())
    : connPrepared
  if (obj.aborted || conn.aborted) {
    return {
      objectsFolded: obj.folded, connectionsFolded: conn.folded,
      objectsKept: obj.kept, connectionsKept: conn.kept,
      objectsDeleted: obj.deleted, connectionsDeleted: conn.deleted,
      ...rematerializedCounts,
      skippedReason: obj.abortReason ?? conn.abortReason ?? 'ownership_lost_mid_fold',
    }
  }
  // F1, after the pass's own writes and before the caller re-attaches: the
  // base shards the fold wrote this pass (and any left with accumulated
  // incrementals) back to one stored snapshot each.
  const appliedBase = [objPrepared, connPrepared].flatMap((prepared) => 'apply' in prepared ? prepared.baseHandles : [])
  if (opts.mode === 'apply' && opts.compactBaseShardStorage && appliedBase.length) {
    // The fold stands whatever the hook does: its caller catches
    // per shard, and this catches anything else, so the counts below are
    // always what the pass did.
    try {
      await opts.compactBaseShardStorage(appliedBase as ReadonlyArray<DocHandle<unknown>>)
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'compaction.base_storage_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  return {
    objectsFolded: obj.folded,
    connectionsFolded: conn.folded,
    objectsKept: obj.kept,
    connectionsKept: conn.kept,
    objectsDeleted: obj.deleted,
    connectionsDeleted: conn.deleted,
    ...rematerializedCounts,
  }
}

/**
 * G4-16k: write back, where each
 * entity lives NOW, the offline edits an earlier pass's clear erased
 * (`overlayClearRematerialize.ts`). The server holds both her late change and
 * the clear once she synced, so this covers the browser that never comes
 * back, closes before its own rescue runs, or rescued nothing.
 *
 *  - Read: every listed overlay segment's changes since its last scan
 *    (`opts.clearScans`; nothing at all without it), the entries whose
 *    late edits a clear erased — yielding the event loop between its steps,
 *    within a per-pass decode budget.
 *  - Never resurrect: an id in the meta's tombstones, or held by no listed
 *    shard (deleted since), is left as it is.
 *  - Owed fields only (`rematerializedEntity`): where her value differs
 *    from what the clear saw and the documents still hold what it saw — a
 *    later write (her browser's rescue, a colleague's) wins.
 *  - Written in place (`foldValueInPlace`, change message
 *    `maplespire:overlay-clear-rematerialize`) into the LAST listed shard
 *    holding the id — the copy the read model and the browsers project.
 *  - Under the pass's ownership guard, flushed, and only then is the scan
 *    recorded. A failure is reported and costs nothing: the fold goes on, and
 *    the next pass reads the same changes again.
 *
 * Returns how many entities it wrote.
 */
async function rematerializeClearedEdits(
  repo: Repo,
  resolve: <T>(url: string) => Promise<DocHandle<T>>,
  metaHandle: DocHandle<MetaLike>,
  collKey: 'objects' | 'connections',
  urlsField: 'objectShardUrls' | 'connectionShardUrls',
  overlayField: 'editsObjectShardUrl' | 'editsConnectionShardUrl',
  overlayUrlsField: 'editsObjectShardUrls' | 'editsConnectionShardUrls',
  tombstoneField: 'deletedObjectIds' | 'deletedConnectionIds',
  opts: CompactionOptions,
  resolveDeadlineAt: number,
): Promise<RematerializeOutcome> {
  const collection = collKey === 'objects' ? 'object' : 'connection'
  let written = 0
  // From the deployment on: a segment with no row starts its scan at its heads
  // when a pass first sees it, read nothing — only what an edit loses after
  // that is repaired, never the history before the deployment. This first
  // sighting is BEFORE the segment's first clear: only a pass clears, and this
  // step runs at the start of the pass, before its fold; a segment created
  // after the deployment (a pass's fresh head, a rotation's) is therefore first
  // seen, and recorded, before any clear of it. That holds only if the row is
  // SAVED. So the named segments with no row are counted BEFORE anything is
  // resolved, and unless every one of them got its row saved — whatever stopped
  // the step: a scan table that could not be read, a resolution that failed or
  // missed the step's ceiling, a failed save — the pass neither folds nor
  // clears (`firstRowsUnsaved`).
  const firstIds = new Set<string>()
  const savedFirstIds = new Set<string>()
  const outcome = (r: { written: number; failed?: string }): RematerializeOutcome =>
    [...firstIds].some((id) => !savedFirstIds.has(id)) ? { ...r, firstRowsUnsaved: true } : r
  // Without a store nothing is ever read: no starting point can be kept.
  if (!opts.clearScans) return { written: 0 }
  const scanStore = opts.clearScans
  try {
    const meta = metaHandle.doc()
    const overlayUrl = readMetaUrl(meta, overlayField)
    const listed = (readMetaUrls(meta, urlsField) ?? []).filter((url) => isValidAutomergeUrl(url))
    // The overlay segments the meta names now.
    const named = [...new Set([...(readMetaUrls(meta, overlayUrlsField) ?? []), ...(overlayUrl ? [overlayUrl] : [])]
      .filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url)))]
    // Until the rows are read, every named segment may be a first sighting:
    // a scan table that cannot be read refuses the fold too.
    for (const url of named) firstIds.add(url.slice('automerge:'.length))
    const since = await scanStore.load(collection)
    for (const documentId of [...firstIds]) if (since.has(documentId)) firstIds.delete(documentId)
    if (named.length === 0 && since.size === 0) return { written: 0 }
    const namedSegments = await resolveCompactionShards(resolve, named, `rematerialize ${collKey} overlay segments`, resolveDeadlineAt)
    let firstSaveFailed: string | undefined
    if (firstIds.size > 0) {
      // Recorded at once, before any scan, and only where no row exists yet
      // (`onlyNew`). Not behind the ownership guard, and safe without it: a
      // pass that clears a segment saved its row first, so a pass that lost
      // the workspace finds that row and moves nothing.
      const firsts = namedSegments.filter((handle) => firstIds.has(String(handle.documentId)))
        .map((handle) => ({ documentId: String(handle.documentId), heads: handle.doc() ? getHeads(handle.doc() as never) : [] }))
      try {
        await scanStore.save(collection, firsts, { onlyNew: true })
        for (const first of firsts) if (first.heads.length > 0) savedFirstIds.add(first.documentId)
      } catch (error) {
        // Reported, and the fold refused (`outcome`); the scan and its writes
        // still run, so what is owed elsewhere is not held back by it.
        firstSaveFailed = error instanceof Error ? error.message : String(error)
        console.warn(JSON.stringify({ event: 'compaction.overlay_clear_rematerialize_failed', collection: collKey, error: firstSaveFailed }))
      }
    }
    // And the documents an earlier pass scanned as a segment that no list names
    // any more: a meta with the singular pointer alone forgets a segment once
    // its head rotates, and a chain fold delists the segments it folds — while
    // a late edit can still reach one. Bounded per pass, the least recently
    // scanned first; a row whose document the repo answers is gone is purged,
    // never retried for ever.
    const namedIds = new Set(namedSegments.map((handle) => String(handle.documentId)))
    const listedIds = new Set(listed.map((url) => url.slice('automerge:'.length)))
    const unnamed = [...since.keys()].filter((id) => !namedIds.has(id))
      .slice(0, opts.rematerializeUnnamedPerPass ?? REMATERIALIZE_UNNAMED_SEGMENTS_PER_PASS)
    const unnamedSegments: DocHandle<ShardDoc>[] = []
    const gone: string[] = []
    for (const documentId of unnamed) {
      if (Date.now() >= resolveDeadlineAt) break
      try {
        unnamedSegments.push(await resolve<ShardDoc>(`automerge:${documentId}`))
      } catch (error) {
        if (!listedIds.has(documentId) && documentGone(error)) gone.push(documentId)
      }
    }
    if (gone.length > 0 && scanStore.purge) {
      await scanStore.purge(collection, gone)
      console.warn(JSON.stringify({ event: 'compaction.overlay_clear_scan_purged', collection: collKey, documents: gone.length }))
    }
    // Read in the rows' order: the least recently scanned first.
    const byId = new Map([...namedSegments, ...unnamedSegments].map((handle) => [String(handle.documentId), handle]))
    const toScan = [...since.keys()].filter((id) => byId.has(id))
    const graceMs = opts.rematerializeGraceMs ?? 0
    const now = opts.now?.() ?? Date.now()
    const yieldNow = opts.yieldToEventLoop ?? (() => new Promise<void>((resolveYield) => setImmediate(resolveYield)))
    const budget = opts.rematerializeDecodeBudget ?? REMATERIALIZE_DECODE_BUDGET
    const stats: ScanStats = { decoded: 0 }
    // `done`: the late changes of a PARKED segment this server already dealt
    // with — written, owing nothing, or tombstoned. A segment parks for the
    // entry that keeps it (a grace period, a pending row) and not for the
    // others: an edit whose changes are all done is not looked at again, so a
    // colleague's revert of a field the server already wrote back is not
    // overwritten on every pass while the segment waits.
    // `seen`: the entry/change keys this scan read — `done` is saved pruned to
    // them, so it never outgrows the late changes still after the parked
    // cursor.
    type Scanned = { documentId: string; heads: readonly string[]; row: ClearScanRow; parked: boolean; lateSeen: Record<string, number>; done: Set<string>; seen: Set<string> }
    const scanned: Scanned[] = []
    const found: Array<{ edit: ClearedEntryEdit; segment: Scanned }> = []
    for (const documentId of toScan) {
      // The cap: the segment that crossed it was the last read; the rest keep
      // their rows (and their place at the front of the next pass).
      if (scanned.length > 0 && stats.decoded >= budget) break
      const segment = byId.get(documentId)!
      await yieldNow()
      const doc = segment.doc()
      if (!doc) continue
      const row = since.get(documentId)!
      // The heads and the read from the same immutable revision: the scan
      // recorded is the revision read, whatever lands while it yields.
      const heads = getHeads(doc as never)
      await yieldNow()
      const edits = await clearedEntryEditsYielding(doc as never, [...row.heads], [collKey], yieldNow, stats)
      const entry: Scanned = { documentId, heads, row, parked: false, lateSeen: {}, done: new Set(row.done ?? []), seen: new Set() }
      scanned.push(entry)
      for (const edit of edits) {
        for (const hash of edit.changes) entry.seen.add(`${edit.id}/${hash}`)
        // By entry AND change: one change can write several entries, only some of them held.
        if (edit.changes.length > 0 && edit.changes.every((hash) => entry.done.has(`${edit.id}/${hash}`))) continue
        // The grace period, by the server's clock: from the first pass that
        // saw each late change (its row's `lateSeen`; this pass for a new one).
        const firstSeen = (hash: string) => row.lateSeen?.[hash] ?? now
        if (edit.changes.every((hash) => now - firstSeen(hash) >= graceMs)) { found.push({ edit, segment: entry }); continue }
        // Still in its grace period: this segment is read again from the
        // same place next pass, and remembers when each change was first seen.
        entry.parked = true
        for (const hash of edit.changes) entry.lateSeen[hash] = firstSeen(hash)
      }
    }
    const touched: DocHandle<ShardDoc>[] = []
    if (found.length > 0) {
      const tombstones = new Set((meta?.[tombstoneField] ?? []).filter((id): id is string => typeof id === 'string'))
      const bySegmentUrl = new Map([...byId.values()].map((handle) => [handle.url as string, handle]))
      const others = listed.filter((url) => !bySegmentUrl.has(url))
      const resolved = await resolveCompactionShards(resolve, others, `rematerialize ${collKey} shards`, resolveDeadlineAt)
      const byUrl = new Map<string, DocHandle<ShardDoc>>([...bySegmentUrl, ...others.map((url, i) => [url, resolved[i]] as const)])
      // Every segment, named or known by its scan row.
      const overlaySet = new Set<string>([...byId.values()].map((handle) => handle.url))
      const head = overlayUrl ? byUrl.get(overlayUrl) : undefined
      // The unchecked box is honoured: a WRITE she unchecked in the batch
      // re-apply (an override row `dismissed`) is never written back here.
      // Scoped to that write — its path AND its value — never to the field for
      // ever: if she edits the field again and a later clear erases THAT edit,
      // it is repaired like any other. A row still `pending` holds the field
      // back whatever the value, and parks the segment, until she decides.
      const declined = opts.declinedEdits
        ? await opts.declinedEdits(collection, [...new Set(found.map(({ edit }) => edit.id))])
        : new Map<string, ReadonlyArray<DeclinedWrite>>()
      if (opts.stillSafeToWrite && !(await opts.stillSafeToWrite())) return { ...outcome({ written: 0 }), ownershipLost: true }
      for (const { edit, segment } of found) {
        const handled = () => { for (const hash of edit.changes) segment.done.add(`${edit.id}/${hash}`) }
        if (tombstones.has(edit.id)) { handled(); continue }
        const declinedPaths = declined.get(edit.id) ?? []
        let heldByPending = false
        // A field is declined when a declined write's path overlaps it (the
        // field itself, a key below it, or the map above it) AND her value
        // there is the value she declined — or the row is still pending.
        const overlaps = (write: DeclinedWrite, field: readonly string[]) => {
          const n = Math.min(write.path.length, field.length)
          for (let i = 0; i < n; i++) if (String(write.path[i]) !== field[i]) return false
          return true
        }
        const isDeclined = (field: readonly string[]) => {
          if (declinedPaths.some((write) => write.pending && overlaps(write, field))) { heldByPending = true; return true }
          return declinedPaths.some((write) => !write.pending && overlaps(write, field)
            && sameDocumentValue(valueAtPath(edit.mine, write.path), write.value))
        }
        // Where it lives now: the LAST listed shard holding it (list order is precedence).
        let home: DocHandle<ShardDoc> | undefined
        for (const url of listed) {
          const handle = byUrl.get(url)
          if (handle?.doc()?.[collKey]?.[edit.id] !== undefined) home = handle
        }
        const current = home?.doc()?.[collKey]?.[edit.id] as Record<string, unknown> | undefined
        if (!home || !current) { handled(); continue }
        const next = rematerializedEntity(edit.mine as Record<string, unknown>, edit.seen as Record<string, unknown>, current,
          edit.previous as Record<string, unknown> | undefined, declinedPaths.length ? isDeclined : undefined)
        // Her decision is still owed: the scan does not move past this edit
        // (and only this one is looked at again, `done`), and NOTHING of it is
        // written until she decides: a neighbouring field written now would be
        // judged "untouched" again on every pass while the row is pending, and
        // a colleague's revert of it overwritten each time. At the decision the
        // whole edit is written once, by the field rule (a later write wins). A
        // held edit keeps the FIRST sighting of each change while it is held —
        // else her decision would wait one more grace (a day in production)
        // before it is written.
        if (heldByPending) {
          segment.parked = true
          for (const hash of edit.changes) segment.lateSeen[hash] = segment.row.lateSeen?.[hash] ?? now
          continue
        }
        handled()
        if (!next) continue
        // Never into an overlay segment that is no longer the write head: a
        // retired head written past its recorded heads makes the pass refuse.
        // Into the current head instead, the whole entity — what a browser's
        // edit writes; it outranks the older copy, and this pass folds it.
        const target = home !== head && overlaySet.has(home.url) && head ? head : home
        target.change((s) => {
          if (!s[collKey]) s[collKey] = {}
          const coll = s[collKey]
          if (target === home && coll[edit.id] === undefined) return
          foldValueInPlace(coll, edit.id, next)
        }, { message: OVERLAY_REMATERIALIZE_MESSAGE })
        if (!touched.includes(target)) touched.push(target)
        written += 1
        console.warn(JSON.stringify({
          event: 'compaction.overlay_clear_rematerialized',
          collection: collKey, id: edit.id, home: String(target.documentId), changes: edit.changes.length,
        }))
      }
    }
    // What was written is durable BEFORE the scan moves past it: a crash
    // between the two would otherwise leave her values in memory only, the
    // cursor already beyond them.
    if (touched.length) await repo.flush(touched.map((handle) => handle.documentId))
    // Re-asked right before the save: a pass that lost
    // the workspace meanwhile records nothing.
    if (scanned.length > 0 && opts.stillSafeToWrite && !(await opts.stillSafeToWrite())) return { ...outcome({ written }), ownershipLost: true }
    const scans: ClearScanSave[] = scanned.map((segment) => segment.parked
      ? { documentId: segment.documentId, heads: segment.row.heads, lateSeen: segment.lateSeen, done: [...segment.done].filter((key) => segment.seen.has(key)) }
      : { documentId: segment.documentId, heads: segment.heads })
    if (scans.length) await scanStore.save(collection, scans)
    if (firstSaveFailed) return outcome({ written, failed: `${collKey}: ${firstSaveFailed}` })
    return outcome({ written })
  } catch (error) {
    // Reported on the pass's result too, never silent; the
    // fold goes on, and the next pass reads the same changes again (the scan
    // is not recorded). Writes already made stand: the fold flushes them.
    // Except a FIRST sighting not recorded: its starting point would be
    // a later pass's heads, after this pass's clear — the fold is refused.
    const message = error instanceof Error ? error.message : String(error)
    console.warn(JSON.stringify({ event: 'compaction.overlay_clear_rematerialize_failed', collection: collKey, error: message }))
    return outcome({ written, failed: `${collKey}: ${message}` })
  }
}

/** What the G4-16k step did: entities written, a failure, a first sighting
 * whose row is not saved (the fold is refused), an ownership guard that said
 * no (the pass stops). */
type RematerializeOutcome = { written: number; failed?: string; firstRowsUnsaved?: true; ownershipLost?: true }

/** Segments known only by their scan row, resolved per pass and collection
 * The rest wait, the least recently scanned first. */
export const REMATERIALIZE_UNNAMED_SEGMENTS_PER_PASS = 16
/** Changes the scan decodes per pass and collection: past it, the segments
 * not read yet keep their rows for the next pass. A year of daily clears of
 * 50 entries (365 x 50) is well inside one pass. */
export const REMATERIALIZE_DECODE_BUDGET = 200_000

/** The repo's answer that a document is gone (collected), as opposed to slow:
 * only then is its scan row purged. A timeout or an abort is not. */
function documentGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unavailable|resolved in state "deleted"/i.test(message) && !/abort|timeout|timed out/i.test(message)
}

/** Documents resolved at once by a pass (see {@link resolveCompactionShards}). */
export const COMPACTION_RESOLVE_CONCURRENCY = SERVER_SHARD_RESOLVE_BATCH_SIZE
/** ONE ceiling for every resolution of a pass (not one per list: a
 * pass resolves four lists — overlay segments and base shards of both
 * collections — with the projector detached, so 4 x 120 s). Taken once at
 * the start of `compactOverlay` (`deadlineAt`); each list gets what is left.
 * It is a WALL-CLOCK deadline: the work between the lists (the objects
 * fold's preparation, the `lateWritesPending` query) consumes it too, not
 * only the finds. Each find keeps its own 10 s from its own start. */
export const COMPACTION_RESOLVE_DEADLINE_MS = 120_000

/** The pass's resolution ceiling ran out before a list could start. */
function passCeilingPassed(label: string, total: number): BoundedResolveDeadlineError {
  return new BoundedResolveDeadlineError(`${label} (the pass's single resolution ceiling)`, 0, 0, total)
}

/**
 * Resolve a pass's shard list with a bounded number of finds in flight
 * (`resolveWithBoundedConcurrency`), so `findReadyDocument`'s 10 s deadline
 * starts when THAT find starts. Before (G4-16f diagnosis q1), `Promise.all`
 * started every base shard's find, and so its clock, at once; the projector's
 * detach had evicted them all, their `A.load` calls ran back to back, and the
 * last shards timed out on the sum of every load (day 16 on the bench machine, a
 * reproduction at 4 s on the Mac). A failure names the document and its place.
 */
async function resolveCompactionShards(
  resolve: <T>(url: string) => Promise<DocHandle<T>>,
  urls: readonly string[],
  label: string,
  /** The pass's single resolution deadline (epoch ms), see {@link COMPACTION_RESOLVE_DEADLINE_MS}. */
  deadlineAt: number,
): Promise<DocHandle<ShardDoc>[]> {
  const remaining = deadlineAt - Date.now()
  if (urls.length && remaining <= 0) throw passCeilingPassed(label, urls.length)
  return resolveWithBoundedConcurrency(urls, async (url, index) => {
    const startedAt = Date.now()
    try {
      return await resolve<ShardDoc>(url)
    } catch (error) {
      throw new Error(
        `${label}: ${url} (${index + 1} of ${urls.length}) not ready ${Date.now() - startedAt} ms after its own find started `
        + `(${COMPACTION_RESOLVE_CONCURRENCY} in flight at most): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }, {
    concurrency: COMPACTION_RESOLVE_CONCURRENCY,
    deadlineMs: Math.max(1, remaining),
    label: `${label} (what was left of the pass's single resolution ceiling)`,
  })
}

/** Fold one overlay collection (objects OR connections) into its base shards, apply delete
 * tombstones (remove from base shards + overlay, then clear the tombstone list), and clear
 * the folded overlay entries. `collKey` is the in-doc map key; `urlsField`/`overlayField`/
 * `tombstoneField` are the ModelMeta fields.
 *
 * In two halves: this function READS (and answers preview, and asks
 * `lateWritesPending`), and returns either a terminal outcome or the `apply`
 * that writes. `compactOverlay` prepares both collections before applying
 * either. */
type FoldOutcome = {
  folded: number; kept: number; deleted: number; aborted?: true
  abortReason?: 'ownership_lost_mid_fold' | CompactionSegmentRefusal
}
async function prepareFold(
  repo: Repo,
  resolve: <T>(url: string) => Promise<DocHandle<T>>,
  metaHandle: DocHandle<MetaLike>,
  collKey: 'objects' | 'connections',
  urlsField: 'objectShardUrls' | 'connectionShardUrls',
  overlayField: 'editsObjectShardUrl' | 'editsConnectionShardUrl',
  overlayUrlsField: 'editsObjectShardUrls' | 'editsConnectionShardUrls',
  tombstoneField: 'deletedObjectIds' | 'deletedConnectionIds',
  shardSize: number,
  mode: CompactionMode,
  claim?: { workspace: WorkspaceKey; rootUrl: string },
  stillSafeToWrite?: () => Promise<boolean>,
  lateWritesPending?: CompactionOptions['lateWritesPending'],
  settleRewrittenSegments?: CompactionOptions['settleRewrittenSegments'],
  resolveDeadlineAt: number = Date.now() + COMPACTION_RESOLVE_DEADLINE_MS,
): Promise<FoldOutcome | { apply: () => Promise<FoldOutcome>; baseHandles: DocHandle<ShardDoc>[] }> {
  const none = { folded: 0, kept: 0, deleted: 0 }
  const meta = metaHandle.doc()

  // Delete tombstones to apply this run (ids the client deleted but couldn't remove from
  // their base shard). A pure delete creates NO overlay, so tombstones must be handled even
  // when there is no overlay shard. Exclude tombstoned ids from the fold below.
  const tombstones = (meta?.[tombstoneField] ?? []).filter((id): id is string => typeof id === 'string')
  const tombSet = new Set(tombstones)

  // Resolve every bounded overlay segment oldest → newest. Legacy workspaces
  // expose only the singular current pointer and remain fully compatible.
  const overlayUrl = readMetaUrl(meta, overlayField)
  const overlayUrls = [...new Set([
    ...(readMetaUrls(meta, overlayUrlsField) ?? []),
    ...(overlayUrl ? [overlayUrl] : []),
  ].filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url)))]
  // The singular pointer is the current writer and must be overlaid last.
  if (overlayUrl && overlayUrls.includes(overlayUrl)) {
    overlayUrls.splice(overlayUrls.indexOf(overlayUrl), 1)
    overlayUrls.push(overlayUrl)
  }
  const overlayHandles = await resolveCompactionShards(resolve, overlayUrls, `compaction ${collKey} overlay segments`, resolveDeadlineAt)
  const segmentSnapshots = overlayHandles.map((handle) => ({ ...(handle.doc()?.[collKey] ?? {}) }))
  // Same synchronous turn as the snapshot: the heads `lateWritesPending` is
  // asked about must be the revision that was folded.
  const segmentHeads = overlayHandles.map((handle) => {
    try { return getHeads(handle.doc() as never) } catch { return [] as string[] }
  })
  const snapshot: Record<string, unknown> = {}
  for (const segment of segmentSnapshots) Object.assign(snapshot, segment)
  for (const id of tombSet) delete snapshot[id]
  const ids = Object.keys(snapshot)
  if (ids.length === 0 && tombstones.length === 0) return none

  // Load the base shards (every model shard EXCEPT all overlay segments) — needed for both
  // folding and applying tombstone deletes.
  const overlaySet = new Set(overlayUrls)
  const baseUrls = (readMetaUrls(meta, urlsField) ?? []).filter((u) => !overlaySet.has(u) && isValidAutomergeUrl(u))
  const baseHandles = await resolveCompactionShards(resolve, baseUrls, `compaction ${collKey} base shards`, resolveDeadlineAt)

  // id → base-shard index (an existing object lives in exactly one base shard).
  const idToShard = new Map<string, number>()
  baseHandles.forEach((h, i) => {
    for (const id of Object.keys(h.doc()?.[collKey] ?? {})) idToShard.set(id, i)
  })

  // Partition overlay ids: EDITS of existing objects (fold in place) vs CREATED objects
  // (no base shard yet — need placement).
  const existingByShard = new Map<number, string[]>()
  const created: string[] = []
  for (const id of ids) {
    const idx = idToShard.get(id)
    if (idx === undefined) created.push(id)
    else {
      const arr = existingByShard.get(idx)
      if (arr) arr.push(id)
      else existingByShard.set(idx, [id])
    }
  }

  // PREVIEW STOPS HERE — after everything has been READ and partitioned, and
  // before the first `.change()` below, which is the first byte this function
  // would write. Everything above resolves documents and builds maps; nothing
  // above mutates. That is the property `compaction.preview.test.ts` pins by
  // spying on `.change()` across every base, overlay and meta handle and
  // asserting the count is exactly zero.
  //
  // The counts are what an apply WOULD produce on this same state: `kept` is
  // non-zero only when an entry was edited between the snapshot and the clear,
  // which cannot happen when no clear runs — so a preview predicts `kept: 0` and
  // the fold count it predicts. `compaction.preview.test.ts` checks that
  // equality so a preview cannot drift from what it forecasts.
  if (mode === 'preview') {
    return { folded: ids.length, kept: 0, deleted: tombstones.length }
  }

  // Still a READ, and in this half so that `compactOverlay` has both
  // collections' answers before either writes.
  if (lateWritesPending) {
    const pending = await lateWritesPending(collKey === 'objects' ? 'object' : 'connection', overlayHandles.map(
      (handle, index) => ({
        documentId: String(handle.documentId),
        heads: segmentHeads[index],
        current: overlayUrls[index] === overlayUrl,
      }),
    ))
    const refusal = Array.isArray(pending)
      ? { reason: 'retired_head_forward_pending' as const, segments: pending as readonly string[] }
      : pending as { reason: CompactionSegmentRefusal; segments: readonly string[] }
    if (refusal.segments.length) {
      console.warn(JSON.stringify({
        event: 'compaction.refused',
        reason: refusal.reason,
        collection: collKey,
        segments: refusal.segments,
      }))
      return { folded: 0, kept: 0, deleted: 0, aborted: true, abortReason: refusal.reason }
    }
  }

  const currentIndex = overlayUrl ? overlayUrls.indexOf(overlayUrl) : -1
  return {
    baseHandles,
    apply: () => applyFold({
      repo, metaHandle, collKey, urlsField, overlayField, overlayUrlsField, tombstoneField, shardSize, claim,
      stillSafeToWrite, tombstones, tombSet, overlayHandles, segmentSnapshots, snapshot, ids, overlaySet,
      baseHandles, idToShard, existingByShard, created, currentIndex, settleRewrittenSegments,
    }),
  }
}

/** The WRITE half of {@link prepareFold}: everything from the first ownership
 * consultation on. Reached only once `compactOverlay` has prepared both
 * collections. */
async function applyFold(prepared: {
  repo: Repo
  metaHandle: DocHandle<MetaLike>
  collKey: 'objects' | 'connections'
  urlsField: 'objectShardUrls' | 'connectionShardUrls'
  overlayField: 'editsObjectShardUrl' | 'editsConnectionShardUrl'
  overlayUrlsField: 'editsObjectShardUrls' | 'editsConnectionShardUrls'
  tombstoneField: 'deletedObjectIds' | 'deletedConnectionIds'
  shardSize: number
  claim?: { workspace: WorkspaceKey; rootUrl: string }
  stillSafeToWrite?: () => Promise<boolean>
  tombstones: string[]
  tombSet: Set<string>
  overlayHandles: DocHandle<ShardDoc>[]
  segmentSnapshots: Record<string, unknown>[]
  snapshot: Record<string, unknown>
  ids: string[]
  overlaySet: Set<string>
  baseHandles: DocHandle<ShardDoc>[]
  idToShard: Map<string, number>
  existingByShard: Map<number, string[]>
  created: string[]
  /** Index in `overlayHandles` of the current write head, or -1. */
  currentIndex: number
  settleRewrittenSegments?: CompactionOptions['settleRewrittenSegments']
}): Promise<FoldOutcome> {
  const {
    repo, metaHandle, collKey, urlsField, overlayField, overlayUrlsField, tombstoneField, shardSize, claim,
    stillSafeToWrite, tombstones, tombSet, overlayHandles, segmentSnapshots, snapshot, ids, overlaySet,
    baseHandles, idToShard, existingByShard, created, currentIndex, settleRewrittenSegments,
  } = prepared
  // OWNERSHIP GUARD, first consultation — the last instant before this function writes
  // anything. Everything above was reads, and resolving the base shards is an
  // unbounded await during which the lease can move and the workspace can be
  // promoted to summary. See `CompactionOptions.stillSafeToWrite`.
  if (stillSafeToWrite && !(await stillSafeToWrite())) {
    return { folded: 0, kept: 0, deleted: 0, aborted: true }
  }

  // Fold edits in place — the overlay entry is the authoritative current value, so
  // the result is a full replace, written field by field (`foldValueInPlace`).
  for (const [idx, shardIds] of existingByShard) {
    baseHandles[idx].change((s) => {
      // Assign, then RE-READ: `s[k] ?? (s[k] = {})` yields the plain `{}`, not
      // the document's map, and the fold would land on a detached object right
      // before the overlay copy is cleared below.
      if (!s[collKey]) s[collKey] = {}
      const coll = s[collKey]
      for (const id of shardIds) foldValueInPlace(coll, id, snapshot[id])
    })
  }

  // Place created ids: fill base shards that have room, then create new shards for the
  // overflow, splicing their urls BEFORE the overlay url so the overlay stays LAST.
  if (created.length) {
    const counts = baseHandles.map((h) => Object.keys(h.doc()?.[collKey] ?? {}).length)
    let ci = 0
    for (let i = 0; i < baseHandles.length && ci < created.length; i++) {
      const room = shardSize - counts[i]
      if (room <= 0) continue
      const take = created.slice(ci, ci + room)
      baseHandles[i].change((s) => {
        if (!s[collKey]) s[collKey] = {}
        const coll = s[collKey]
        // A created id is absent from every base shard (`idToShard`), so the
        // helper assigns it whole here. The third path, the overflow into NEW
        // shards below, writes whole without the helper, which is correct:
        // those documents are new and there is nothing to diff against.
        for (const id of take) foldValueInPlace(coll, id, snapshot[id])
      })
      ci += take.length
    }
    while (ci < created.length) {
      const take = created.slice(ci, ci + shardSize)
      // The child must be durable BEFORE any durable document points at it
      // (createEmptyRoot's rule, same as `nextHead` below) — a crash between
      // the meta save and the shard save would otherwise leave a pointer to a
      // document that never reached storage, and a cold client's find() on it
      // never settles. It must also be CLAIMED before then, which is why the
      // filled value is built upfront and handed to the wrapper (created ->
      // flushed -> claimed -> only then the meta splice below).
      const filled = {
        [collKey]: Object.fromEntries(take.map((id) => [id, snapshot[id] as Record<string, unknown>])),
      } as ShardDoc
      const newHandle = claim
        ? await createClaimedDocument<ShardDoc>(repo, claim.workspace, claim.rootUrl, filled)
        : await (async () => {
            const handle = repo.create<ShardDoc>(filled)
            await handle.whenReady()
            await repo.flush([handle.documentId])
            return handle
          })()
      metaHandle.change((m) => {
        const urls = [...(readMetaUrls(m, urlsField) ?? [])]
        const oIdx = urls.findIndex((url) => overlaySet.has(url))
        if (oIdx >= 0) urls.splice(oIdx, 0, newHandle.url)
        else urls.push(newHandle.url)
        // A middle insertion: `writeMetaUrls` inserts it at its position and
        // re-creates nothing after it.
        writeMetaUrls(m, urlsField, urls)
      })
      ci += take.length
    }
  }

  // Apply delete tombstones: remove each tombstoned id from its base shard + the overlay,
  // then remove ONLY the applied ids from the tombstone list (splice by value so a
  // concurrently-appended tombstone isn't clobbered).
  let deleted = 0
  if (tombstones.length) {
    const delByShard = new Map<number, string[]>()
    for (const id of tombstones) {
      const idx = idToShard.get(id)
      if (idx === undefined) continue
      const arr = delByShard.get(idx)
      if (arr) arr.push(id)
      else delByShard.set(idx, [id])
    }
    for (const [idx, delIds] of delByShard) {
      baseHandles[idx].change((s) => {
        const coll = s[collKey]
        if (coll) for (const id of delIds) delete coll[id]
      })
    }
    for (const overlayHandle of overlayHandles) {
      overlayHandle.change((s) => {
        const coll = s[collKey]
        if (coll) for (const id of tombstones) delete coll[id]
      })
    }
    metaHandle.change((m) => {
      const arr = m[tombstoneField]
      if (!arr) return
      for (let i = arr.length - 1; i >= 0; i--) if (tombSet.has(arr[i])) arr.splice(i, 1)
    })
    deleted = tombstones.length
  }

  // The folded values must be durable in their NEW home before the overlay
  // copies are cleared — the POINTER half of this rule is enforced at shard
  // creation above; this is the VALUE half. A crash that persists the cleared
  // overlay but not the folded base shards would lose the entity from both
  // homes. (The delete path needs no such fence: an unsaved base deletion
  // comes back with an unsaved meta tombstone splice, so the next run
  // re-applies it.)
  await repo.flush([
    ...baseHandles.map((handle) => handle.documentId),
    metaHandle.documentId,
  ])

  // Conditional clear of folded entries: delete an overlay entry ONLY if it's unchanged
  // since the snapshot (compared deep). A concurrent edit makes the current value differ →
  // keep it (folded next run; the read model reads it last-wins meanwhile). put-wins covers
  // an edit landing during this very change.
  // OWNERSHIP GUARD, second consultation — before the DESTRUCTIVE half. Everything
  // above is idempotent: the base now holds the folded values, the overlay still
  // holds them too, and the read model reads the overlay last-wins, so a pass
  // that stops here has changed nothing a reader can observe and the next pass
  // redoes it. Past this point the base becomes the sole home of the value, so a
  // lease that moved during the fold must not be allowed to clear.
  if (stillSafeToWrite && !(await stillSafeToWrite())) {
    // The counts are what ACTUALLY happened, not zeroes. By this line the fold
    // has been applied to the base shards, created ids have been placed, the
    // tombstones have been applied to base + overlay + meta, and ALL of it has
    // been flushed. Reporting `folded: 0` alongside a non-zero `deleted` would
    // be one object making two contradictory claims about a single pass — and it
    // reaches an operator through `POST /api/model/compact`. `kept: 0` is
    // accurate: `keptIds` is populated by the clear, which did not run.
    //
    // Read WITH `skippedReason: 'ownership_lost_mid_fold'`, `folded` here means
    // "folded into the base, and still present in the overlay" — the safe,
    // idempotent half. The next pass folds them again.
    return { folded: ids.length, kept: 0, deleted, aborted: true }
  }

  const keptIds = new Set<string>()
  if (ids.length) {
    overlayHandles.forEach((overlayHandle, segmentIndex) => overlayHandle.change((s) => {
      // Nothing to clear in a segment without the map (and creating one here
      // would have handed back a detached object anyway).
      const coll = s[collKey] as Record<string, unknown> | undefined
      if (!coll) return
      for (const [id, captured] of Object.entries(segmentSnapshots[segmentIndex])) {
        if (tombSet.has(id)) continue
        const cur = coll[id]
        if (cur === undefined) continue
        if (JSON.stringify(cur) === JSON.stringify(captured)) delete coll[id]
        else keptIds.add(id)
      }
    }, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }))
  }
  // EVERY segment's heads, in the SAME synchronous turn as the clear above (and
  // after the tombstone deletes, so a tombstone-only pass is covered too): the
  // revision `settleRewrittenSegments` records is the one this pass wrote, and
  // a write arriving after it is after its H_r, for the forwarder.
  const rewritten = overlayHandles.map((handle, index) => ({
    documentId: String(handle.documentId),
    heads: (() => { try { return getHeads(handle.doc() as never) } catch { return [] as string[] } })(),
    current: index === currentIndex,
  }))
  // Never leave the singular pointer on a cleared document with a large CRDT
  // history. New clients resolve only this fresh bounded head; historical URLs
  // remain referenced so stale/offline clients can finish syncing safely.
  // The fresh head is claimed before ModelMeta points at it.
  // `writeBatchIds` from birth, like every head producer (overlaySegments.ts).
  const nextHeadValue = { [collKey]: {}, writeHeadVersion: 1, writeBatchIds: [] } as unknown as ShardDoc
  const nextHead = claim
    ? await createClaimedDocument<ShardDoc>(repo, claim.workspace, claim.rootUrl, nextHeadValue)
    : await (async () => {
        const handle = repo.create<ShardDoc>(nextHeadValue)
        await handle.whenReady()
        await repo.flush([handle.documentId])
        return handle
      })()
  // BEFORE ModelMeta moves (G4-16i, the header): the rows are committed first,
  // over heads already in storage — a row naming heads the stored document
  // lacks refuses every forward of it for ever (`unknown-heads`). A throw ends
  // the pass here, with the pointer unmoved.
  if (settleRewrittenSegments) {
    await repo.flush(overlayHandles.map((handle) => handle.documentId))
    await settleRewrittenSegments(collKey === 'objects' ? 'object' : 'connection', rewritten)
  }
  metaHandle.change((m) => {
    appendCompactionSegmentInPlace(m, overlayUrlsField, nextHead.url)
    writeMetaUrl(m, overlayField, nextHead.url)
    appendMetaUrl(m, urlsField, nextHead.url)
    // NOT the same number as `nextHeadValue`'s `writeHeadVersion` above,
    // despite both reading `1`: that one is a per-document lifecycle marker,
    // this one is the meta's protocol version the client compares against.
    // They are free to diverge.
    //
    // The projector does not promote this head to 2: `rotateOverlayHead`
    // promotes only the child IT mints, so a head created here stays at 1 —
    // and since `maybeRotateOverlayHead`'s gate is `>= 2`, a compaction head is
    // scheduled for rotation immediately and REPLACED rather than promoted.
    m.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
  })

  return { folded: ids.length - keptIds.size, kept: keptIds.size, deleted }
}

export interface ProjectionAcknowledgement {
  /** `projector_attached` and `projected >= observed`. */
  readonly acknowledged: boolean
  /**
   * WHICH projector instance published that acknowledgement, or `null` when the
   * row does not say.
   *
   * The caller must compare it to the instance it believes is resident. A row
   * can read `attached = true` with `projected >= observed` and have been
   * written by a projector on ANOTHER cell — after a failover, before this cell's
   * own projector has caught up. Reading only the two numbers turns another
   * cell's progress into this cell's permission to clear the overlay, and
   * clearing is the step after which the base is the value's only home.
   */
  readonly projectorInstanceId: string | null
}

/** Compaction may clear overlay entries only after PostgreSQL has published the
 * same observed generation, AND only when the projector that published it is the
 * one this cell has resident. Otherwise an operational read model could miss an
 * edit during the stop/rebuild window.
 *
 * Named for what it reads rather than `isX`: it answers two questions, and a
 * boolean name for a two-part answer is how the second part gets dropped. */
export async function readProjectionAcknowledgement(
  db: Queryable,
  key: WorkspaceKey,
): Promise<ProjectionAcknowledgement> {
  const { rows } = await db.query<{
    observed_generation: string | number
    projected_generation: string | number
    projector_attached: boolean
    projector_instance_id: string | null
  }>(
    `SELECT observed_generation, projected_generation, projector_attached, projector_instance_id
     FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  return {
    acknowledged: row?.projector_attached === true
      && Number(row.projected_generation) >= Number(row.observed_generation),
    projectorInstanceId: row?.projector_instance_id ?? null,
  }
}
