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

import { diff, diffPath, getBackend, getHeads, view } from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import { threeWayMergeOverlayEntity, type OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * Ordinary-workspace writer-head rotation — PHASE 2, THE FORWARDER.
 *
 * A retired write head is still listed in ModelMeta and still claimed, so a
 * client that was offline across the rotation reconnects and keeps writing
 * into it. Without this module those late writes are projected straight from
 * the retired head ("last shard delta wins", `projectorService.ts`) while
 * every reader — the cold build, and every client — lets the CURRENT head win
 * the entity whenever it holds it. The offline field edit is then invisible:
 * not lost from Automerge, lost from the product.
 *
 * What this does instead, for a head with a `retired` row carrying H_r:
 *
 *  - the projector stops projecting the retired head directly;
 *  - every change after `forwarded_heads ?? H_r` is read with `A.diff` and
 *    merged into the CURRENT head THREE-WAY, PER FIELD: base = the retired
 *    head at the forwarding point, historical = the retired head now,
 *    current = the live current head (or, when the current head lacks the
 *    entity, the value the other segments serve). An entity already in the
 *    current head is never replaced: only the leaves that differ are written,
 *    because replacing the map orphans a peer concurrently writing into it
 *    (the measurement in `overlayConflictHealing.ts`). An entity ABSENT from
 *    the current head is written whole — there is no map to orphan;
 *  - the new batch ids go into the current head's `forwardedBatchIds`, and
 *    the current head's own projection acknowledges them in the SAME
 *    transaction as the rows that carry their values;
 *  - `forwarded_heads` is committed only after the current head is flushed.
 *
 * Removed entity keys are not forwarded: ModelMeta tombstones are the deletion
 * channel, as in `staticDeltaProjector.forwardHistoricalOverlay`. A FIELD the
 * three-way merge says the late writer removed is removed. At a same-field
 * conflict the current head wins and the conflict is logged — the ordinary
 * plane keeps no conflict ledger.
 *
 * IDEMPOTENT across a crash between the flush and the commit: the replay
 * starts from the old forwarding point, the merge finds the current head
 * already equal to the historical value on every forwarded field (nothing to
 * write), and a batch id already in `forwardedBatchIds` is not pushed again.
 *
 * THE CONTRACT ON H_r, which the phase-3 rotator must honour: H_r is a set of
 * heads of the retired document whose content the ordinary projector has
 * ALREADY PUBLISHED. Forwarding covers everything after it, whether it
 * arrived before or after ModelMeta was repointed; nothing covers anything
 * before it, because the retired head is no longer projected. H_r must also
 * be DURABLE in the retired document's storage before it is recorded (flush
 * it), for the same reason the forwarder flushes before `forwarded_heads`.
 *
 * AND ON ORDER: the `retired` row WITH H_r must be committed BEFORE ModelMeta
 * is repointed. The projector re-reads rows only when a write-head pointer
 * moves (`projectorService.ts`, `freshRetirements`), so a row recorded
 * `admitted` before the repoint and promoted to `retired` after it is not seen
 * until the next pointer move or re-attach: the head is projected directly
 * (today's compaction behaviour) for that whole time. Measured by the phase-2
 * review: under that order `forwarded_heads` stayed NULL and the retired
 * head's whole entity won the `ro_*` row over the current head's.
 *
 * NOT GATED BY `AM_ORDINARY_HEAD_ROTATION`. The flag governs whether new
 * rotations are made; a retired head with H_r exists only because one was,
 * and turning the flag off must not strand the edits still arriving on it
 * (the design's rollback note). So forwarding is driven by the row, under
 * every mode. The rows' only production writer is the phase-3 rotator
 * (`ordinaryHeadRotator.ts`, `on` and allow-listed). With no row, the
 * projector's only new work is one SELECT on attach and one each time a
 * write-head pointer moves.
 *
 * WHAT ELSE MUST KNOW ABOUT A ROW. Two maintenance paths read every overlay
 * segment as if it were projected directly, and so would lose a late write
 * the forwarder has not carried yet:
 *
 *  - compaction folds all segments `Object.assign` oldest → newest and then
 *    clears what it folded — a retired head's un-forwarded field edit is
 *    folded UNDER the current head's whole entity and then deleted from the
 *    retired head. It refuses while {@link ordinaryHeadLateWritesPending}
 *    names a segment (`compaction.ts`, `retired_head_forward_pending`);
 *  - promotion to the static plane hands the overlay to a projector that
 *    knows nothing of these rows and projects every segment directly. It
 *    refuses while the workspace has ANY row
 *    ({@link countOrdinaryHeadRetirements}, `ordinary-head-retirements`).
 */

/** `folded`: a retired head merged into a fold product (G4-16b phase 4,
 * `ordinaryChainFold.ts`). It still forwards: a write that reaches it after
 * the fold is carried into the current head like any late write. */
export type OrdinaryHeadRetirementStatus = 'admitted' | 'retired' | 'folded'

export interface OrdinaryHeadRetirement {
  collection: OverlayCollection
  documentId: string
  retirementHeads: string[] | null
  forwardedHeads: string[] | null
  status: OrdinaryHeadRetirementStatus
  /** The fold product's document id, for a `folded` row only. */
  foldedInto: string | null
  /** `created_at` in epoch ms — the rotation's time for a `retired` row.
   * Read by {@link loadOrdinaryHeadRetirements} only (the G4-16e durable
   * rotation rate, `ordinaryRotationTelemetry.ts`); absent elsewhere. */
  createdAtMs?: number
  /** Who wrote the row (G4-16e): the rotator, a fold record for its product,
   * or NULL (an older row, or a test's). Loader only, like `createdAtMs`. */
  origin?: 'rotation' | 'fold-product' | null
}

export const retirementKey = (collection: OverlayCollection, documentId: string): string =>
  `${collection}:${documentId}`

/** True when this row asks for forwarding: `retired` or `folded`, with H_r. */
export const forwardsLateWrites = (row: OrdinaryHeadRetirement | undefined): row is OrdinaryHeadRetirement & {
  retirementHeads: string[]
} => Boolean(row && (row.status === 'retired' || row.status === 'folded') && row.retirementHeads)

const sortedHeads = (heads: readonly string[]): string[] => [...heads].sort()

const sameHeads = (left: readonly string[], right: readonly string[]): boolean => {
  const a = sortedHeads(left)
  const b = sortedHeads(right)
  return a.length === b.length && a.every((head, index) => head === b[index])
}

type RetirementRow = {
  collection: OverlayCollection
  document_id: string
  retirement_heads: string[] | null
  forwarded_heads: string[] | null
  status: OrdinaryHeadRetirementStatus
  folded_into: string | null
  created_at?: Date | string | null
  origin?: 'rotation' | 'fold-product' | null
}

const fromRow = (row: RetirementRow): OrdinaryHeadRetirement => ({
  collection: row.collection,
  documentId: row.document_id,
  retirementHeads: row.retirement_heads,
  forwardedHeads: row.forwarded_heads,
  status: row.status,
  foldedInto: row.folded_into,
  ...(row.created_at == null ? {} : { createdAtMs: new Date(row.created_at).getTime() }),
  ...(row.origin === undefined ? {} : { origin: row.origin }),
})

/** Every retirement row of the workspace, by `retirementKey`. */
export async function loadOrdinaryHeadRetirements(
  db: Queryable,
  key: WorkspaceKey,
): Promise<Map<string, OrdinaryHeadRetirement>> {
  const { rows } = await db.query<RetirementRow>(
    `SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into, created_at, origin
     FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return new Map(rows.map((row) => [retirementKey(row.collection, row.document_id), fromRow(row)]))
}

export async function readOrdinaryHeadRetirement(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
): Promise<OrdinaryHeadRetirement | undefined> {
  const { rows } = await db.query<RetirementRow>(
    `SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into
     FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4`,
    [key.landscapeId, key.versionId, collection, documentId],
  )
  return rows[0] ? fromRow(rows[0]) : undefined
}

/** Record a retirement, for tests: the rotator's own write is an upsert
 * inside its lock (`ordinaryHeadRotator.ts`, `commitOrdinaryHeadRetirement`).
 * Never overwrites a row: a second retirement of the same head is a defect
 * of the caller, not a reason to move H_r. Returns whether it inserted. */
export async function recordOrdinaryHeadRetirement(
  db: Queryable,
  key: WorkspaceKey,
  retirement: {
    collection: OverlayCollection
    documentId: string
    retirementHeads: readonly string[] | null
    status: OrdinaryHeadRetirementStatus
  },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO read_model_ordinary_head_retirements (
       landscape_id, version_id, collection, document_id, retirement_heads, status
     ) VALUES ($1, $2, $3, $4, $5::text[], $6)
     ON CONFLICT (landscape_id, version_id, collection, document_id) DO NOTHING`,
    [
      key.landscapeId, key.versionId, retirement.collection, retirement.documentId,
      retirement.retirementHeads ? sortedHeads(retirement.retirementHeads) : null, retirement.status,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

/** Advance `forwarded_heads` from the value the forward started from (a CAS:
 * a concurrent forward that already moved it wins, and the replay of this one
 * is a no-op). Returns whether the row moved. */
export async function commitForwardedHeads(
  tx: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  expected: readonly string[] | null,
  next: readonly string[],
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE read_model_ordinary_head_retirements
        SET forwarded_heads = $6::text[], updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4
        AND status IN ('retired', 'folded')
        AND forwarded_heads IS NOT DISTINCT FROM $5::text[]`,
    [
      key.landscapeId, key.versionId, collection, documentId,
      expected ? sortedHeads(expected) : null, sortedHeads(next),
    ],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Which of `segments` carry late writes the forwarder has NOT carried into the
 * current head yet? A segment with a `retired` row whose heads, AS THE CALLER
 * SAMPLED THEM, differ from `forwarded_heads ?? H_r`. Read the rows AFTER the
 * sample: a forward in flight then reads as pending (its row moves after its
 * write), which is the safe direction — the caller refuses and retries.
 *
 * The CURRENT head is never pending, whatever its row says: a row naming the
 * current head is a rotation that crashed between recording the row and
 * repointing ModelMeta (`ordinaryHeadRotator.ts`), and that head is projected
 * directly. A segment without a row is never pending either (compaction's own
 * retired heads, projected directly).
 */
export async function ordinaryHeadLateWritesPending(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  segments: ReadonlyArray<{ documentId: string; heads: readonly string[]; current: boolean }>,
): Promise<string[]> {
  const candidates = segments.filter((segment) => !segment.current)
  if (!candidates.length) return []
  const rows = await loadOrdinaryHeadRetirements(db, key)
  const pending: string[] = []
  for (const segment of candidates) {
    const row = rows.get(retirementKey(collection, segment.documentId))
    if (!forwardsLateWrites(row)) continue
    if (!sameHeads(segment.heads, row.forwardedHeads ?? row.retirementHeads)) pending.push(segment.documentId)
  }
  return pending
}

/** How many retirement rows the workspace has, any status. */
export async function countOrdinaryHeadRetirements(db: Queryable, key: WorkspaceKey): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return Number(rows[0]?.count ?? 0)
}

type Entity = Record<string, unknown>

function isRecord(value: unknown): value is Entity {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const entityField = (collection: OverlayCollection) => collection === 'object' ? 'objects' : 'connections'

export interface RetiredHeadForwardPlan {
  /** Sorted. Where this forward started and where it ends. */
  fromHeads: string[]
  toHeads: string[]
  /** Entities the diff touched that the retired head still holds and no
   * tombstone deletes, with the value at the forwarding point (`base`,
   * undefined when created since) and now (`historical`). */
  entities: Map<string, { base: Entity | undefined; historical: Entity }>
  /** Batch ids (own writes and forwarded ones) that appeared since the
   * forwarding point, in document order. */
  batchIds: string[]
  /** Touched but not forwarded: removed from the retired head, tombstoned, or
   * back to their base value. */
  ignored: string[]
}

export type RetiredHeadForwardPlanOutcome =
  | { kind: 'nothing' }
  /** `A.diff` returns NO patches when a head is missing — a silent no-op the
   * forwarder must not mistake for "nothing happened". Refused, loudly. Also
   * a `from` the document HAS but not BEFORE `to` (a value already outdated
   * when it was passed): a diff from it to `to` would run backwards. */
  | { kind: 'unknown-heads'; fromHeads: string[] }
  /** `proceed` said no when the plan's turn came (ownership lost meanwhile). */
  | { kind: 'abandoned' }
  | { kind: 'plan'; plan: RetiredHeadForwardPlan }

export interface RetiredHeadForwardPlanOptions {
  /** Read when the plan's turn in the lane comes, before its first read:
   * false abandons it. */
  proceed?: () => boolean
  /** How long the plan waited for its turn, how long it took once running,
   * and which path read its delta. */
  timing?: (timing: { laneWaitMs: number; planMs: number; path: 'narrow' | 'wide' }) => void
}

interface OverlayDocLike {
  objects?: Record<string, unknown>
  connections?: Record<string, unknown>
  writeBatchIds?: string[]
  forwardedBatchIds?: string[]
}

const batchIdsOf = (doc: OverlayDocLike | undefined): string[] => [
  ...(doc?.writeBatchIds ?? []),
  ...(doc?.forwardedBatchIds ?? []),
].filter((id): id is string => typeof id === 'string' && id.length > 0)

/** One macrotask boundary: timers, I/O and other forwards run here. */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Plans run ONE AT A TIME per process. `setImmediate` callbacks queued in
 * the same loop iteration run back to back in its check phase, with no timer
 * between them: N forwards planning at once (~11 per rotation) would put N
 * slices in each phase and rebuild the long task out of short ones. */
let planLane: Promise<unknown> = Promise.resolve()
function inPlanLane<T>(work: () => Promise<T>): Promise<T> {
  const run = planLane.then(work, work)
  planLane = run.then(() => undefined, () => undefined)
  return run
}

/** The entity loop yields once a slice has run this long (checked before
 * each entity, so a slice ends at most one entity past it). The whole-
 * document path's `view` and `A.diff` are single calls: one slice each,
 * whatever they cost. */
const PLAN_SLICE_BUDGET_MS = 4

/** Every one of `heads` is a change in `doc`'s history. Exactly
 * `A.hasHeads` — false for a foreign hash AND for one only QUEUED (its deps
 * missing), the same throw on a malformed one — but read from the change
 * graph's metadata: `hasHeads` calls `getChangeByHash` per head, which REBUILDS
 * the change from the op set (`ChangeCollector::from_build_meta`). Measured:
 * 2.9 ms for 10 heads of a 532-change, 141-actor head, against 0.07 ms.
 * (`getMissingDeps` is NOT equivalent: it never names a queued hash.) */
export function hasAllHeads(doc: unknown, heads: readonly string[]): boolean {
  const backend = getBackend(doc as never)
  return heads.every((hash) => backend.getChangeMetaByHash(hash) != null)
}

/** `from` is in the history of `to` — a forward from `from` to `to` runs
 * FORWARDS. Must be read in the same synchronous step as `to`: the backend is
 * shared by every value of the handle and grows under a yield (a sync, a
 * durable merge), and a `from` that arrives meanwhile would read as known
 * while `to` predates it. When the backend's heads are `to`, its history IS
 * `to`'s; otherwise (a value already outdated) the changes after `to` are
 * listed and `from` must hold none of them. */
export function headsPrecede(doc: unknown, from: readonly string[], to: readonly string[]): boolean {
  if (!hasAllHeads(doc, from)) return false
  const backend = getBackend(doc as never)
  if (sameHeads(backend.getHeads(), to)) return true
  const after = new Set(backend.getChangesMeta([...to]).map((change) => change.hash))
  return from.every((hash) => !after.has(hash))
}

type HistoricalValue = ['map' | 'list' | 'text' | string, unknown] | null

/** What the plan needs of the retired head at the forwarding point: the
 * entities the delta touched, each one's value THEN (as `view(doc, from)`
 * serves it), and the batch ids THEN. */
interface ForwardDelta {
  touched: Set<string>
  atFrom: (id: string) => unknown
  batchIdsBefore: () => Promise<string[]>
}

/**
 * The delta read NARROWLY: the entity map's own subtree diffed, and only what
 * the plan reads materialised at `from` — never the whole document. On the
 * fleet head (532 changes, 141 actors, 10 objects, 531 batch ids) the whole
 * `A.diff` costs 3.9 ms cold, 3.1 of them outside the entity map (the batch-id
 * LIST, `SpansDiff`), and `view(doc, from)` 2.6 ms; the subtree diff 0.8 ms, a
 * touched entity 0.1 ms.
 *
 * Exactly the patches of `A.diff` under `field` and exactly the values of
 * `view`: it applies only when the root shows no change of `field` between
 * the two head sets (so the entity map is the SAME object at both) and that
 * object, and every value it reads, has the shape a head carries (a map, a
 * list of batch ids, or absent), and the delta puts or removes at most ONE
 * entity (late writes edit fields). Anything else answers null and the plan
 * takes the whole-document path — a replaced entity map is `wholeCollection`
 * there. Relies on Automerge 3.2.6 (`patch-automerge-inflight-fanout.mjs`
 * pins the version): `diffPath` on an object id returns ABSOLUTE paths, and
 * `getWithType` / `materialize` read at explicit heads.
 */
async function narrowDelta(
  doc: OverlayDocLike,
  field: 'objects' | 'connections',
  from: string[],
  to: string[],
): Promise<ForwardDelta | null> {
  for (const patch of diffPath(doc as never, [], from, to, { recursive: false })) {
    if (patch.path[0] === field) return null
  }
  const backend = getBackend(doc as never)
  const atTo = backend.getWithType('_root', field, to) as HistoricalValue
  const atFrom = backend.getWithType('_root', field, from) as HistoricalValue
  if ((atTo && atTo[0] !== 'map') || (atFrom && atFrom[0] !== 'map')) return null
  if ((atTo === null) !== (atFrom === null) || (atTo && atFrom && atTo[1] !== atFrom[1])) return null
  const mapAtFrom = atFrom ? (atFrom[1] as string) : null
  const touched = new Set<string>()
  if (atTo) {
    await yieldToLoop()
    let own = 0
    for (const patch of backend.diffPath(atTo[1] as string, from, to, { recursive: true })) {
      // Every patch of the entity map's subtree starts with `field`. One that
      // does not means the path shape changed (an upgrade making them
      // relative): skipping it would forward nothing and commit past it.
      if (patch.path[0] !== field || patch.path.length < 2) return null
      // The ORDER of the entity map's own patches (an entity put or
      // removed) is not `A.diff`'s when there are several: the subtree diff
      // emits them by key, the whole diff otherwise. The order is the
      // plan's write order, so the whole-document path keeps it exact.
      // Field edits inside entities come out in the same order (pinned).
      if (patch.path.length === 2 && ++own > 1) return null
      touched.add(String(patch.path[1]))
    }
  }
  // An entity THEN that is not a map (or absent) is read from the whole
  // entity map at `from`, once: what `view` serves for any other type.
  let wholeMap: Record<string, unknown> | undefined
  const atFromOf = (id: string): unknown => {
    if (mapAtFrom === null) return undefined
    const value = backend.getWithType(mapAtFrom, id, from) as HistoricalValue
    if (value === null) return undefined
    if (value[0] === 'map') return backend.materialize(value[1] as string, from)
    wholeMap ??= backend.materialize(mapAtFrom, from) as Record<string, unknown>
    return wholeMap[id]
  }
  const batchIdsBefore = async (): Promise<string[]> => {
    const lists: unknown[][] = []
    for (const name of ['writeBatchIds', 'forwardedBatchIds'] as const) {
      await yieldToLoop()
      const value = backend.getWithType('_root', name, from) as HistoricalValue
      if (value === null) continue
      // Not a list (a corrupted head): exactly what `view` serves.
      if (value[0] !== 'list') return batchIdsOf(view(doc as never, from) as OverlayDocLike)
      lists.push(backend.materialize(value[1] as string, from) as unknown[])
    }
    return lists.flat().filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
  return { touched, atFrom: atFromOf, batchIdsBefore }
}

/** The whole-document path: `view` at `from` and the full `A.diff`, one
 * slice each. */
async function wideDelta(
  doc: OverlayDocLike,
  field: 'objects' | 'connections',
  from: string[],
  to: string[],
): Promise<ForwardDelta> {
  await yieldToLoop()
  const before = view(doc as never, from) as OverlayDocLike
  await yieldToLoop()
  const touched = new Set<string>()
  let wholeCollection = false
  for (const patch of diff(doc as never, from, to)) {
    if (patch.path[0] !== field) continue
    if (patch.path.length >= 2) touched.add(String(patch.path[1]))
    else wholeCollection = true
  }
  if (wholeCollection) {
    for (const id of Object.keys(before[field] ?? {})) touched.add(id)
    for (const id of Object.keys(doc[field] ?? {})) touched.add(id)
  }
  return { touched, atFrom: (id) => before[field]?.[id], batchIdsBefore: async () => batchIdsOf(before) }
}

/**
 * Pure over an IMMUTABLE snapshot: what changed in the retired head since
 * `fromHeads`. The heads are checked SYNCHRONOUSLY, with `to` (see
 * {@link headsPrecede}); the rest runs asynchronously, in slices: it yields to
 * the event loop between phases (the diff, the entity reads, each batch-id
 * list), and plans run one at a time ({@link inPlanLane}), so no loop
 * iteration runs two slices — of this plan or of another forward's (G4-16,
 * PC run-01: one synchronous plan was the cell's longest task in the burst
 * after each rotation, 46–81 ms against a 100 ms p99 gate; on the Mac
 * micro-benchmark of the fleet head the longest slice is 2.1 ms where the
 * plan took 10.7 ms).
 *
 * Safe to slice: every read is either of `retiredDoc` — an Automerge value,
 * which the handle REPLACES on the next change and never mutates (an outdated
 * value keeps its heads, `getHeads` answers them) — or of the shared backend
 * at the explicit head sets `from` and `to`, which a history that only grows
 * keeps answering identically. A write arriving meanwhile is simply after
 * `toHeads`: the next forward carries it, as it already did for one arriving
 * during the driver's awaits after the plan.
 *
 * The narrow read falls back to the whole-document one on any shape it does
 * not know AND on any error it raises (logged): it is an optimisation, and
 * must never be the reason a forward fails or carries less.
 */
export async function planRetiredHeadForward(
  retiredDoc: unknown,
  collection: OverlayCollection,
  fromHeads: readonly string[],
  tombstones: ReadonlySet<string>,
  options: RetiredHeadForwardPlanOptions = {},
): Promise<RetiredHeadForwardPlanOutcome> {
  const doc = retiredDoc as OverlayDocLike
  const from = sortedHeads(fromHeads)
  const to = sortedHeads(getHeads(doc as never))
  if (sameHeads(from, to)) return { kind: 'nothing' }
  // NO await between `to` and this check.
  if (!headsPrecede(doc, from, to)) return { kind: 'unknown-heads', fromHeads: from }
  const queuedAt = performance.now()
  return inPlanLane(async () => {
    // The previous plan's last slice settled in THIS macrotask.
    await yieldToLoop()
    const startedAt = performance.now()
    if (options.proceed && !options.proceed()) return { kind: 'abandoned' }
    const field = entityField(collection)
    let path: 'narrow' | 'wide' = 'narrow'
    let outcome: RetiredHeadForwardPlanOutcome | null = null
    try {
      const delta = await narrowDelta(doc, field, from, to)
      if (delta) outcome = await assemblePlan(doc, field, from, to, tombstones, delta)
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_head_forward_narrow_failed',
        collection,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    if (!outcome) {
      path = 'wide'
      outcome = await assemblePlan(doc, field, from, to, tombstones, await wideDelta(doc, field, from, to))
    }
    options.timing?.({ laneWaitMs: startedAt - queuedAt, planMs: performance.now() - startedAt, path })
    return outcome
  })
}

async function assemblePlan(
  doc: OverlayDocLike,
  field: 'objects' | 'connections',
  from: string[],
  to: string[],
  tombstones: ReadonlySet<string>,
  delta: ForwardDelta,
): Promise<RetiredHeadForwardPlanOutcome> {
  const entities = new Map<string, { base: Entity | undefined; historical: Entity }>()
  const ignored: string[] = []
  let sliceStartedAt = Number.NEGATIVE_INFINITY
  for (const id of delta.touched) {
    if (performance.now() - sliceStartedAt >= PLAN_SLICE_BUDGET_MS) {
      await yieldToLoop()
      sliceStartedAt = performance.now()
    }
    const now = doc[field]?.[id]
    if (!isRecord(now) || tombstones.has(id)) {
      ignored.push(id)
      continue
    }
    const then = delta.atFrom(id)
    const historical = jsonCopy(now)
    const base = isRecord(then) ? jsonCopy(then) : undefined
    if (base !== undefined && sameJson(base, historical)) {
      ignored.push(id)
      continue
    }
    entities.set(id, { base, historical })
  }
  const seen = new Set(await delta.batchIdsBefore())
  const batchIds: string[] = []
  for (const id of batchIdsOf(doc)) {
    if (seen.has(id)) continue
    seen.add(id)
    batchIds.push(id)
  }
  // A plan even when nothing in it is forwardable (a removed key, a tombstoned
  // entity): `forwarded_heads` must still advance past those changes, or every
  // later forward re-reads the same diff.
  return { kind: 'plan', plan: { fromHeads: from, toHeads: to, entities, batchIds, ignored } }
}

/** Write `to` over `target` (whose JSON is `from`) leaf by leaf: a nested map
 * present on both sides is descended into, never replaced. Arrays and scalars
 * are atomic, as in `threeWayMergeOverlayEntity`. Returns whether it wrote. */
function writeLeaves(target: Entity, from: Entity, to: Entity): boolean {
  let wrote = false
  for (const key of Object.keys(to)) {
    const previous = from[key]
    const next = to[key]
    if (Object.prototype.hasOwnProperty.call(from, key) && sameJson(previous, next)) continue
    if (isRecord(previous) && isRecord(next) && isRecord(target[key])) {
      if (writeLeaves(target[key] as Entity, previous, next)) wrote = true
      continue
    }
    target[key] = jsonCopy(next)
    wrote = true
  }
  for (const key of Object.keys(from)) {
    if (Object.prototype.hasOwnProperty.call(to, key)) continue
    delete target[key]
    wrote = true
  }
  return wrote
}

export interface RetiredHeadForwardApplied {
  /** Entities whose current-head value this forward changed. */
  written: string[]
  /** Of those, the ones that did not exist in the current head (written whole). */
  created: string[]
  /** Same-field divergences, where the current head's value was kept. */
  conflicts: Array<{ entityId: string; paths: string[] }>
  batchIdsAdded: string[]
}

/** Inside the current head's `handle.change`, synchronously: every value it
 * merges against is read from the live document it is writing, so no write
 * can land between the read and the write. `servedElsewhere` is the value the
 * other segments serve for an entity the current head does not hold. */
export function applyRetiredHeadForward(
  currentDoc: unknown,
  collection: OverlayCollection,
  plan: RetiredHeadForwardPlan,
  servedElsewhere: (entityId: string) => Entity | undefined,
): RetiredHeadForwardApplied {
  const doc = currentDoc as OverlayDocLike
  const field = entityField(collection)
  const applied: RetiredHeadForwardApplied = { written: [], created: [], conflicts: [], batchIdsAdded: [] }
  if (plan.entities.size) {
    // Assign, then RE-READ: `(doc[field] ??= {})` yields the plain `{}` it
    // assigned, not the document's map (`local/no-detached-container-write`).
    if (!doc[field]) doc[field] = {}
    const entities = doc[field] as Record<string, unknown>
    for (const [entityId, { base, historical }] of plan.entities) {
      const liveEntity = entities[entityId]
      const live = isRecord(liveEntity) ? jsonCopy(liveEntity) : undefined
      const current = live ?? servedElsewhere(entityId)
      // THE BASE OF A CREATION IS THE EMPTY RECORD, as in the healer: an
      // entity created in the retired head since the forwarding point and also
      // present in what is served merges field by field, not "current wins".
      const mergeBase = base ?? (current !== undefined ? {} : undefined)
      const merged = threeWayMergeOverlayEntity<Entity>(mergeBase, historical, current)
      if (merged.conflicts.length) applied.conflicts.push({ entityId, paths: merged.conflicts })
      // Never a delete: entity deletion is ModelMeta's channel.
      if (!isRecord(merged.value)) continue
      if (live === undefined) {
        entities[entityId] = jsonCopy(merged.value)
        applied.written.push(entityId)
        applied.created.push(entityId)
        continue
      }
      if (writeLeaves(liveEntity as Entity, live, merged.value)) applied.written.push(entityId)
    }
  }
  if (plan.batchIds.length) {
    if (!doc.forwardedBatchIds) doc.forwardedBatchIds = []
    const list = doc.forwardedBatchIds
    const present = new Set(list)
    for (const batchId of plan.batchIds) {
      if (present.has(batchId)) continue
      list.push(batchId)
      present.add(batchId)
      applied.batchIdsAdded.push(batchId)
    }
  }
  return applied
}

export interface ForwardTargetHandle {
  documentId: DocumentId
  doc(): unknown
  change(callback: (doc: unknown) => void): void
}

export interface ForwardRetiredHeadArgs {
  db: Queryable
  key: WorkspaceKey
  collection: OverlayCollection
  retired: { documentId: DocumentId; doc(): unknown }
  /** The CURRENT write head, resolved. */
  current: () => Promise<ForwardTargetHandle>
  /** What the non-current segments serve for these ids, ModelMeta order
   * (later wins). Asked only for ids the current head does not hold. */
  servedElsewhere: (entityIds: readonly string[]) => Promise<Map<string, Entity>>
  tombstones: () => ReadonlySet<string>
  /** Synchronous ownership: checked at entry and again with NO await between
   * it and the current head's `change`. */
  mayWrite: () => boolean
  /** Database truth (write fence, plane) before the first irreversible act;
   * throws the authority error. */
  assertAuthority: () => Promise<void>
  flush: (documentIds: DocumentId[]) => Promise<unknown>
  /** Runs `write` in a fenced projection transaction. */
  commit: (write: (tx: Queryable) => Promise<void>) => Promise<void>
  /** Called once the forward is COMMITTED (`forwarded` or `superseded`), with
   * the retired head's heads it forwarded up to and the head it wrote into.
   * The projector uses it to re-stamp the retired head's arrival watermark
   * once the target's projection has published what was written. */
  settled?: (settled: { retiredHeads: string[]; targetDocumentId: DocumentId }) => void
  log?: (line: string) => void
}

export type ForwardRetiredHeadOutcome =
  | 'not-owner'
  | 'not-retired'
  | 'nothing'
  | 'unknown-heads'
  | 'forwarded'
  /** Forwarded, but another forward had already advanced the row. */
  | 'superseded'

export async function forwardRetiredHead(args: ForwardRetiredHeadArgs): Promise<ForwardRetiredHeadOutcome> {
  const log = args.log ?? ((line: string) => console.warn(line))
  const workspace = `${args.key.landscapeId}/${args.key.versionId}`
  if (!args.mayWrite()) return 'not-owner'
  await args.assertAuthority()
  // Read fresh: the projector's in-memory row is only a routing hint, and
  // `forwarded_heads` may have been moved by a previous process.
  const row = await readOrdinaryHeadRetirement(args.db, args.key, args.collection, args.retired.documentId)
  if (!forwardsLateWrites(row)) return 'not-retired'
  // In slices (see the plan): over the value read HERE, whatever the handle
  // receives meanwhile; skipped if ownership is gone when its turn comes.
  let timing: { laneWaitMs: number; planMs: number; path: 'narrow' | 'wide' } | undefined
  const outcome = await planRetiredHeadForward(
    args.retired.doc(), args.collection, row.forwardedHeads ?? row.retirementHeads, args.tombstones(),
    { proceed: args.mayWrite, timing: (measured) => { timing = measured } },
  )
  if (outcome.kind === 'nothing') return 'nothing'
  if (outcome.kind === 'abandoned') return 'not-owner'
  if (outcome.kind === 'unknown-heads') {
    console.error(JSON.stringify({
      event: 'read_model.ordinary_head_forward_refused',
      reason: 'unknown-heads',
      workspace,
      collection: args.collection,
      retired: args.retired.documentId,
      fromHeads: outcome.fromHeads,
    }))
    return 'unknown-heads'
  }
  const { plan } = outcome
  const target = await args.current()
  if (target.documentId === args.retired.documentId) return 'not-retired'
  const held = ((target.doc() as OverlayDocLike | undefined)?.[entityField(args.collection)] ?? {}) as Record<string, unknown>
  const absent = [...plan.entities.keys()].filter((id) => !isRecord(held[id]))
  const elsewhere = absent.length ? await args.servedElsewhere(absent) : new Map<string, Entity>()
  // NO await from here to the change: ownership is re-read synchronously and
  // the merge reads the live document it writes.
  if (!args.mayWrite()) return 'not-owner'
  let applied: RetiredHeadForwardApplied | undefined
  target.change((doc) => {
    applied = applyRetiredHeadForward(doc, args.collection, plan, (id) => elsewhere.get(id))
  })
  // Always, even when this pass wrote nothing: a previous pass in THIS
  // process may have written and failed its flush, and `forwarded_heads`
  // must never be committed past a value that is only in memory. The RETIRED
  // head too: `forwarded_heads` names ITS heads, which arrived by sync and sit
  // behind the repo's throttled save. Committed before they are durable, a
  // crash leaves a row naming heads the reloaded document does not have, and
  // every later forward of that head is refused as `unknown-heads`.
  await args.flush([target.documentId, args.retired.documentId])
  let moved = false
  await args.commit(async (tx) => {
    moved = await commitForwardedHeads(
      tx, args.key, args.collection, args.retired.documentId, row.forwardedHeads, plan.toHeads,
    )
  })
  args.settled?.({ retiredHeads: plan.toHeads, targetDocumentId: target.documentId })
  const result = applied ?? { written: [], created: [], conflicts: [], batchIdsAdded: [] }
  log(JSON.stringify({
    event: 'read_model.ordinary_head_forwarded',
    workspace,
    collection: args.collection,
    retired: args.retired.documentId,
    current: target.documentId,
    entities: plan.entities.size,
    written: result.written.length,
    created: result.created.length,
    ignored: plan.ignored.length,
    batchIdsAdded: result.batchIdsAdded,
    conflicts: result.conflicts,
    committed: moved,
    // The plan lane (G4-16): its wait and the plan's own duration, in the
    // log rather than a metric (no workspace label on a metric).
    ...(timing ? {
      planLaneWaitMs: Math.round(timing.laneWaitMs * 10) / 10,
      planMs: Math.round(timing.planMs * 10) / 10,
      planPath: timing.path,
    } : {}),
  }))
  return moved ? 'forwarded' : 'superseded'
}
