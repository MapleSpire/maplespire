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

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { decodeChange, getChangesSince, hasHeads, type Doc } from '@automerge/automerge'
import type { AutomergeUrl, DocHandle, DocumentId, Repo } from '@automerge/automerge-repo'
import type { Pool, PoolClient } from 'pg'
import {
  advanceReadModelGenerationWithinTransaction,
  beginReadModelProjection,
  completeReadModelProjection,
  failReadModelProjection,
  markReadModelProjectorAttached,
  markReadModelProjectorDetached,
  type ProjectionKind,
} from './health.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { rewriteListInPlace } from '../crdtListEdit.js'
import { appendMetaUrl, readMetaUrl, readMetaUrls, withMetaUrlView, writeMetaUrl, writeMetaUrls } from '../modelMetaUrls.js'
import { envNumber } from '../envNumber.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import { claimWorkspaceDocuments } from '../rbac/documentClaims.js'
import { invalidateWorkspaceCoverage } from '../rbac/claimCoverage.js'
import { appendReadModelChange, type ReadModelChangePayload } from './changeFeed.js'
import { objectChangeWithCacheNeighbours } from './objectExplorer.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import { repairWorkspaceC4ParentIds } from './schema.js'
import {
  assertReadModelPlane, isProjectionMutexTimeout, isReadModelAuthorityLoss,
  STATIC_PLANE_LOCK_WAIT_MS,
} from './projectionAuthority.js'
import {
  deleteConnections,
  deleteDiagrams,
  deleteGroups,
  deleteObjects,
  dropDiagramFlowIndex,
  lastOccurrenceById,
  replaceDiagramFlowIndex,
  upsertConnections,
  upsertDiagrams,
  upsertGroups,
  upsertObjects,
  type DroppedDuplicateId,
  type WorkspaceKey,
} from './projector.js'
import type {
  ConnectionInput,
  DiagramInput,
  FlowInput,
  GroupInput,
  ObjectInput,
  Queryable,
} from './types.js'
import type { MetricSample } from '../runtime/metrics.js'
import {
  recordStaticEntityDeltas,
  recordStaticMembershipSnapshot,
  type StaticMembershipValue,
} from './staticDeltaStore.js'
import { isStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { noteLiveDuplicateIds, resolveHandleWithRetry } from './projectorService.js'
import type { AutomergeResidencyLeases } from '../automergeResidency.js'
import { StaleSyncCellWriteError, documentContentChunkFilter } from '../automergeStorage.js'
import { bumpDiagramRenderGenerations } from './diagramRenderGeneration.js'
import {
  adjustWorkspaceCount,
  deleteDecisionRecords,
  refreshConnectionStats,
  refreshDiagramSummaries,
  upsertDecisionRecords,
} from './derivedStats.js'
import { captureSparseDraftEntityBases } from '../draft/sparse.js'
import {
  canonicalOverlayDocumentIds,
  collectAutomergeEntityConflicts,
  isAppendOnlyOverlayOrder,
  preserveCurrentConflictPaths,
  threeWayMergeOverlayEntity,
  type AutomergeEntityConflicts,
} from './overlayHistoryProtocol.js'
import { automergeHeadsOrNull, healWholeEntityConflicts } from './overlayConflictHealing.js'
import {
  foldOverlaySegmentContents,
  planOverlayChainFold,
  splitMergedOverlaySegment,
  OVERLAY_SEGMENT_ENTITY_CEILING,
  OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES,
  OVERLAY_CHAIN_FOLD_MIN,
} from './overlayChainFold.js'
import { OVERLAY_SEGMENT_SIZE } from '../overlaySegments.js'
import {
  captureArrivalWatermark,
  headsEqual,
  prepareDocumentWatermarkProofs,
  recordSampledDocumentWatermark,
  type PreparedDocumentWatermarks,
} from './arrivalWatermark.js'
import { durableHeadsMemo } from './durableHeadsMemo.js'
import {
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  releaseOverlayRotationLock,
  reportOverlayRotationLockContended,
  type OverlayRotationLockState,
} from './overlayRotationLock.js'
import {
  acknowledgeOverlayBatches,
  captureOverlayEntityBases,
  overlayDocumentProjectionCheckpoint,
  overlaySegmentBase,
  overlaySegmentSnapshots,
  pendingOverlayBatchIds,
  recordOverlayConflicts,
  recordOverlaySegmentProjection,
  releaseSupersededOverlaySegment,
  synchronizeOverlayHead,
  synchronizeOverlaySegments,
  OVERLAY_RETENTION_DAYS,
  type OverlayConflictInput,
} from './overlayHistoryStore.js'

interface StaticDocumentDescriptor extends WorkspaceKey {
  documentId: string
  kind: string
  entityId: string | null
  orgId: string | null
}

interface ObjectOverlayLike {
  objects?: Record<string, ObjectInput>
  writeHeadVersion?: number
  writeBatchIds?: string[]
  forwardedBatchIds?: string[]
}
interface ConnectionOverlayLike {
  connections?: Record<string, ConnectionInput>
  writeHeadVersion?: number
  writeBatchIds?: string[]
  forwardedBatchIds?: string[]
}
/**
 * A registry shard, and in particular the WRITE HEAD a summary workspace
 * appends every newly created diagram to. Bounded by SHARD_SIZE, which is what
 * makes reconciling it in full affordable.
 */
interface RegistryShardLike {
  diagrams?: Record<string, DiagramInput & { docUrl?: string }>
}

interface StaticMetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  groups?: Record<string, GroupInput>
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
  /** Diagram tombstones. A summary workspace's registry lives in frozen
   * baseline shards nobody reprojects, so this list is the ONLY channel by
   * which a client can tell the read model that a diagram is gone. */
  deletedDiagramIds?: string[]
  decisionRecords?: Record<string, Record<string, unknown>>
  deletedDecisionRecordIds?: string[]
  editsOverlayWriteHeadVersion?: number
}

type OverlayRouteField = 'objectShardUrls' | 'connectionShardUrls'
  | 'editsObjectShardUrls' | 'editsConnectionShardUrls'

/** Append one immutable overlay route without replacing the CRDT list.
 * Reassigning `[...routes, next]` recreates every list element on every
 * rotation, producing quadratic Automerge history and multi-hundred-ms cold
 * loads even though the logical control document remains small. */
export function appendUniqueOverlayRoute(
  meta: StaticMetaLike,
  field: OverlayRouteField,
  url: string,
): void {
  // Through `modelMetaUrls.ts`: text or scalar by the document's marker.
  appendMetaUrl(meta, field, url)
}

/**
 * Replace a contiguous prefix of overlay routes with the ONE segment that
 * merges them, in place.
 *
 * `splice`, for the same reason its neighbour above appends instead of
 * reassigning: `meta[field] = [merged, ...tail]` recreates every element of the
 * list on the hottest control document of the workspace, giving quadratic
 * Automerge history.
 *
 * Two refusals are load-bearing:
 *  - with `requireAll`, a missing folded url writes NOTHING. Half a
 *    substitution on the authoritative list is a chain whose last-wins order no
 *    longer matches what was merged.
 *  - the key is never deleted, even when the list ends up empty. `gc.ts` reads
 *    a ModelMeta with a missing shard array as `degenerate-model-meta`, sets
 *    `complete = false`, and then the sweep deletes nothing for the WHOLE park,
 *    for ever.
 */
export function substituteOverlayPrefix(
  meta: StaticMetaLike,
  field: OverlayRouteField,
  foldedUrls: readonly string[],
  /** `ceil(n / OVERLAY_SEGMENT_ENTITY_CEILING)` merged segment urls. They are
   * spliced in together, in order, at the window's slot — order-preserving
   * because the merge has already resolved last-wins, so no id appears in two
   * of them. */
  mergedUrls: readonly string[],
  requireAll: boolean,
  /**
   * Refuse when the matched positions are not a contiguous run.
   *
   * The invariant is `overlayChainFold.ts`'s. Without this check the function
   * would accept windows such as `[0,2]`, `[1,3]` or `[0,4]`, producing
   * last-wins inversions; with sealing, the planner no longer only emits
   * prefixes, so the check is necessary.
   *
   * FALSE for the `objectShardUrls` / `connectionShardUrls` call, and that is
   * not laziness: those lists carry the MODEL base shards as well as overlay
   * routes (24 + 10 on the reference landscape), so the overlay entries in them
   * are legitimately non-adjacent and a contiguity refusal there would break
   * every fold. That list is not the last-wins authority — `edits*ShardUrls`
   * is — which is also why it is the one called with `requireAll: false`.
   */
  requireContiguous: boolean,
  /**
   * The CURRENT write head's document id, when the caller knows it.
   *
   * Contiguity is a property of the CANONICAL order, not of raw list positions,
   * and the two differ by exactly one element: `canonicalOverlayDocumentIds`
   * moves the head LAST, "even when a stale client appended it earlier". So a
   * raw list of `[0,1,2,3]` whose head is `2` yields the canonical order
   * `[0,1,3,2]` and a perfectly contiguous window `[0,1,3]` — whose raw indices
   * are 0,1,3, with a GAP at the head.
   *
   * A strict raw-position check would refuse that on every pass, for ever:
   * `prefix-not-substitutable` at the dry run, the chain then growing until
   * `overlay-chain-bounded` fires.
   *
   * Passing it lets the check skip that one position. Omitting it is the strict
   * reading, which is correct for any caller that has already canonicalised.
   */
  headDocumentId?: string,
): boolean {
  // The key exists from here on, refusal or not (see above). The splices
  // below edit a plain-string COPY of the ruling list (its elements may
  // be scalars, which `documentIdOf` and `===` cannot read); the result is
  // written back once, in place, by `writeMetaUrls` — kept elements are
  // never re-created, the folded ones deleted, the merged ones inserted at
  // the window's slot.
  if (readMetaUrls(meta, field) === undefined) writeMetaUrls(meta, field, [])
  const routes = [...(readMetaUrls(meta, field) ?? [])]
  // Match on document id, never on the string: the lists can carry decorated
  // urls (`automerge:xxx?foo`), and the two ModelMeta fields have historically
  // been written by different hands.
  const foldedIds = new Set(foldedUrls.map(documentIdOf))
  const indices: number[] = []
  // DISTINCT IDS FOUND, never the number of positions. `foldedUrls` comes from
  // a plan that was deduplicated twice, while `routes` is the RAW Automerge
  // list — and that list can genuinely carry the same url twice, because
  // `appendUniqueOverlayRoute`'s `includes` guard is a single-replica check
  // that does not survive a CRDT merge of two independent inserts. Counting
  // positions would make one duplicate refuse the fold FOR EVER.
  const found = new Set<string>()
  // FIRST OCCURRENCES ONLY drive the contiguity check; the splice below still
  // removes every occurrence.
  //
  // `routes = [seg0, seg1, seg2, seg0]` with the window `[seg0, seg1]` puts a
  // DUPLICATE of seg0 at index 3, so the position list is [0,1,3] and a naive
  // adjacency check would refuse — for ever, because the fold always picks the
  // oldest foldable run. The same freeze the distinct-id counting above
  // prevents, by a different mechanism.
  const contiguityIndices: number[] = []
  routes.forEach((route, index) => {
    const id = documentIdOf(route)
    if (!foldedIds.has(id)) return
    indices.push(index)
    if (!found.has(id)) contiguityIndices.push(index)
    found.add(id)
  })
  if (requireAll && found.size !== foldedIds.size) return false
  // CONTIGUITY, checked before anything is spliced. `indices` is built by an
  // ascending `forEach`, so it is already sorted; a gap means the window would
  // move values across segments that outrank them.
  if (requireContiguous) {
    for (let cursor = 1; cursor < contiguityIndices.length; cursor += 1) {
      const previous = contiguityIndices[cursor - 1]!
      const current = contiguityIndices[cursor]!
      if (current === previous + 1) continue
      // The ONE admissible gap: the current write head, which canonicalisation
      // relocates to the end. Anything wider, or a gap over something else, is
      // a genuine non-contiguous window.
      const gapIsHead = current === previous + 2
        && headDocumentId !== undefined
        && documentIdOf(routes[previous + 1]!) === documentIdOf(headDocumentId)
      if (!gapIsHead) return false
    }
  }
  if (!indices.length) {
    // Nothing of the prefix lives in this list. `objectShardUrls` legitimately
    // reaches that state, so append rather than refuse — the merged segments
    // still have to be named somewhere the GC walk can see them.
    for (const mergedUrl of mergedUrls) {
      if (!routes.some((route) => documentIdOf(route) === documentIdOf(mergedUrl))) {
        routes.push(mergedUrl)
      }
    }
    writeMetaUrls(meta, field, routes)
    return true
  }
  const insertAt = indices[0]
  for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) routes.splice(indices[cursor], 1)
  routes.splice(insertAt, 0, ...mergedUrls)
  writeMetaUrls(meta, field, routes)
  return true
}
interface StaticDiagramLike extends DiagramInput {
  flows?: Record<string, FlowInput>
}

/** What the registry says of a DiagramDoc pass (`diagramDocVerdict`). */
type DiagramDocVerdict =
  | { kind: 'live' }
  | { kind: 'retired'; rowPresent: boolean }
  | { kind: 'superseded' }
  | { kind: 'needs-tombstones' }

/** The `ro_diagrams.data` a DiagramDoc projection writes: the doc over the row
 * (which may carry registry-meta fields such as `docUrl`). The doc is
 * authoritative for its scope overrides, and a cleared set is an ABSENT key
 * there — which a plain spread would read as "keep the row's old overrides",
 * leaving "external in N of M diagrams" counting an override the diagram no
 * longer has. */
export function mergeDiagramDocOverRow(
  row: Record<string, unknown> | undefined,
  doc: DiagramInput,
  diagramId: string,
): DiagramInput {
  const merged: DiagramInput = { ...(row ?? {}), ...doc, id: diagramId }
  if (!('objectScopes' in doc)) delete merged.objectScopes
  return merged
}

/** The `ro_diagrams.data` a REGISTRY-SHARD projection writes: the meta over the
 * row, EXCEPT `objectScopes`, which on this plane belongs to the DiagramDoc
 * projection above. A summary workspace's client never rewrites the meta of an
 * existing diagram, so a meta copy (e.g. one an AI tool mirrored) can be older
 * than the doc; letting it win would resurrect a cleared override, or drop a
 * newer one, whenever any sibling in the shard is re-projected. */
export function mergeRegistryMetaOverRow(
  row: Record<string, unknown> | undefined,
  meta: DiagramInput,
): DiagramInput {
  const { objectScopes: _metaScopes, ...rest } = meta
  const merged: DiagramInput = { ...(row ?? {}), ...rest, id: meta.id }
  return merged
}

/** Only the field `projectRoot` needs. The root carries much more; reading more of it here
 * would make this branch a second producer of root semantics. */
interface StaticRootLike {
  registryWriteUrl?: string
}

interface StaticOverlayState {
  objectDocumentIds: string[]
  connectionDocumentIds: string[]
  deletedObjectIds: Set<string>
  deletedConnectionIds: Set<string>
  /** Diagram tombstones applied. Kept so the next projection can compute a DELTA: replaying the whole
   * list would be idempotent on `ro_diagrams` but NOT on `adjustWorkspaceCount`,
   * which is a running counter clamped at zero — the footer total would drift
   * down for ever. */
  deletedDiagramIds: Set<string>
  /**
   * The tombstone list AS READ FROM ModelMeta. A DIFFERENT FACT from
   * `deletedDiagramIds` above; conflating the two resurrects deleted diagrams
   * after a restart.
   *
   * `deletedDiagramIds` means "tombstones THIS PROCESS has applied": it is
   * seeded empty and only advanced after a publish, precisely so a
   * short-circuited ModelMeta pass cannot mark work done that no
   * `deleteDiagrams` ever ran. That makes it a progress counter, and a progress
   * counter is not a durability witness.
   *
   * This one is set UNCONDITIONALLY, before every short circuit, from the
   * ModelMeta document itself. `undefined` means "no ModelMeta pass has run in
   * this process yet" — which after any restart is the normal state, and is why
   * {@link StaticDeltaProjector.durableDeletedDiagramIds} falls back to reading
   * the document rather than treating an absent entry as "no tombstones".
   */
  metaDeletedDiagramIds?: ReadonlySet<string>
  /**
   * Object / connection tombstones APPLIED: the baseline `newlyDeleted*` is
   * computed against, the twins of `deletedDiagramIds`. `deletedObjectIds` /
   * `deletedConnectionIds` above are the ModelMeta FACT (what the overlay
   * passes filter by, installed at the top of every ModelMeta pass); these
   * two are carried from one state to the next and advance ONLY after a
   * committed ModelMeta publish. A pass that applies nothing — refused,
   * thrown inside the transaction, or thrown at any await between the
   * install and the publish — leaves them where they were, so the next pass
   * replays exactly the tombstones not yet applied, and no others.
   *
   * Carried as `previous ∩ fact`: an id that left the meta's list (a
   * forward resurrected it) leaves the baseline at once, so a later
   * re-tombstone of it is applied again even if the publish in between never
   * landed. Dropping an id here only ever costs a replay
   * (`deleteObjects` / `deleteConnections` count the rows that exist).
   *
   * `undefined` means NOT SEEDED: no ModelMeta publish of this process has
   * committed for the workspace yet (a restart, a takeover, or a self-only
   * state built by an overlay pass). It is not "nothing applied": the
   * previous process applied most of them. The next ModelMeta publish then
   * seeds the baseline from the ROWS, inside its transaction
   * (`unappliedTombstones`): a tombstoned id whose row is gone is applied, one
   * whose row is still there is not. Taking it as empty instead replays every
   * tombstone of the workspace once per process (measured: on a three-year
   * workspace about 3 400 re-stamped delta rows and a `reset all` that sends
   * every client to a full refetch).
   */
  appliedDeletedObjectIds?: Set<string>
  appliedDeletedConnectionIds?: Set<string>
  objectSegments: Map<string, Record<string, ObjectInput>>
  connectionSegments: Map<string, Record<string, ConnectionInput>>
  effectiveObjects: Map<string, { fingerprint: string; value: ObjectInput }>
  effectiveConnections: Map<string, { fingerprint: string; value: ConnectionInput }>
}

interface StaticProjectionOwnership {
  enabled: boolean
  fencingToken(key: WorkspaceKey): string | null
}

const keyOf = (key: WorkspaceKey) => `${key.landscapeId}\u0000${key.versionId}`
const documentIdOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]
const unique = (ids: readonly (string | undefined)[]) => [...new Set(ids.filter((id): id is string => Boolean(id)))]

// G4-16f: the static plane's list writes, IN PLACE (`rewriteListInPlace`).
// Each used to assign a fresh array, re-creating every element (each a text
// object) in the document's history on every call. Synchronous: call them
// inside the document's `change`. Exported for their tests.

/** A head's `forwardedBatchIds` with `ids` added (deduplicated, first kept).
 * Assign, then RE-READ, for an absent list. */
export function addForwardedBatchIdsInPlace(doc: { forwardedBatchIds?: string[] }, ids: readonly string[]): void {
  const target = unique([...(doc.forwardedBatchIds ?? []), ...ids])
  if (!Array.isArray(doc.forwardedBatchIds)) doc.forwardedBatchIds = []
  rewriteListInPlace(doc.forwardedBatchIds, target)
}

/** A head's `forwardedBatchIds` without the `acknowledged` ones; the key
 * goes once none remains. */
export function pruneForwardedBatchIdsInPlace(doc: { forwardedBatchIds?: string[] }, acknowledged: ReadonlySet<string>): void {
  const remaining = unique(doc.forwardedBatchIds ?? []).filter((batchId) => !acknowledged.has(batchId))
  if (!remaining.length) {
    delete doc.forwardedBatchIds
    return
  }
  if (!Array.isArray(doc.forwardedBatchIds)) doc.forwardedBatchIds = []
  rewriteListInPlace(doc.forwardedBatchIds, remaining)
}

/** ModelMeta's tombstone list `field` without `ids` (deduplicated, first
 * kept). A tombstone another writer pushes concurrently survives the merge. */
export function removeTombstonesInPlace(
  doc: { deletedObjectIds?: string[]; deletedConnectionIds?: string[] },
  field: 'deletedObjectIds' | 'deletedConnectionIds',
  ids: Iterable<string>,
): void {
  const next = new Set(doc[field] ?? [])
  for (const id of ids) next.delete(id)
  if (!Array.isArray(doc[field])) doc[field] = []
  rewriteListInPlace(doc[field]!, [...next])
}
/** The answer for a workspace that has no ModelMeta, i.e. no tombstone
 * CHANNEL. Distinct from "tombstones not read yet", which is `undefined` and
 * sends the caller to the durable document.
 *
 * Shared, and read-only BY TYPE only — it is not `Object.freeze`d, so it must
 * never be handed anywhere that would write into it. */
const EMPTY_DIAGRAM_TOMBSTONES: ReadonlySet<string> = new Set<string>()
/** DiagramDocs re-opened per ModelMeta pass, at most. */
const REOPEN_UNPROJECTED_LIMIT = 200
/** The repair tick's durable re-open of unprojected
 * DiagramDocs runs on the first tick of a workspace after a start, then at
 * most this often (a lift seen by a ModelMeta pass re-opens at once, in its
 * own transaction, whatever this says). */
export const UNPROJECTED_REOPEN_INTERVAL_MS = 10 * 60_000

/**
 * The descriptor memo, with an index of each workspace's ModelMeta
 * descriptor (T-DIAGDEF): `durableDeletedDiagramIds` is asked on
 * every DiagramDoc pass whose row is absent, and a linear `find` over every
 * descriptor of every workspace there was O(all descriptors) per pass. The
 * index keeps the FIRST ModelMeta registered for a workspace (the `find`'s
 * answer, insertion order), and falls back to a scan only when that one goes.
 */
export class StaticDescriptorMap extends Map<string, StaticDocumentDescriptor> {
  private readonly metaByWorkspace = new Map<string, string>()

  override set(documentId: string, descriptor: StaticDocumentDescriptor): this {
    const previous = super.get(documentId)
    super.set(documentId, descriptor)
    if (previous?.kind === 'model-meta' && descriptor.kind !== 'model-meta') this.forgetMeta(documentId, previous)
    if (descriptor.kind === 'model-meta' && !this.metaByWorkspace.has(keyOf(descriptor))) {
      this.metaByWorkspace.set(keyOf(descriptor), documentId)
    }
    return this
  }

  override delete(documentId: string): boolean {
    const previous = super.get(documentId)
    const deleted = super.delete(documentId)
    if (previous?.kind === 'model-meta') this.forgetMeta(documentId, previous)
    return deleted
  }

  override clear(): void {
    super.clear()
    this.metaByWorkspace.clear()
  }

  /** The workspace's ModelMeta descriptor, or `undefined`: none is registered
   * (no tombstone channel exists). O(1). */
  modelMetaOf(key: WorkspaceKey): StaticDocumentDescriptor | undefined {
    const documentId = this.metaByWorkspace.get(keyOf(key))
    return documentId === undefined ? undefined : super.get(documentId)
  }

  private forgetMeta(documentId: string, previous: StaticDocumentDescriptor): void {
    const workspace = keyOf(previous)
    if (this.metaByWorkspace.get(workspace) !== documentId) return
    this.metaByWorkspace.delete(workspace)
    for (const [candidateId, candidate] of this) {
      if (candidate.kind === 'model-meta' && keyOf(candidate) === workspace) {
        this.metaByWorkspace.set(workspace, candidateId)
        return
      }
    }
  }
}

/** Key-order-independent content fingerprint of a `ro_diagrams.data` value, so
 * "the shard meta changed nothing" is decided by CONTENT and not by whichever
 * order two spreads happened to produce. */
function diagramRowFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, nested) => (
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      ))
      : nested
  ))
}
const overlayBatchIds = (snapshot: ObjectOverlayLike | ConnectionOverlayLike) => unique([
  ...(snapshot.writeBatchIds ?? []),
  ...(snapshot.forwardedBatchIds ?? []),
])

/**
 * The ModelMeta tombstones (`fact`) a publish must still apply.
 *
 * With a seeded baseline (`applied`): the fact minus it, no query. Without
 * one (`undefined`, see `StaticOverlayState.appliedDeletedObjectIds`): the
 * ids whose row STILL EXISTS. A tombstoned id with no row is already applied
 * and is not replayed; one that still has a row is exactly the unapplied case
 * (a pass of a previous process refused or thrown), and is.
 *
 * The id space is the one `deleteObjects` / `deleteConnections` delete by:
 * `id = ANY(...)` on the workspace's rows. A static tombstone is a MAP KEY
 * (`effectiveOverlayState` drops tombstones by key) and the delete takes that
 * key as a row id, so a key whose row id differs deletes nothing either way;
 * this select finds no row for it, which is the same outcome without the
 * re-stamp. Scoped by `landscape_id` / `version_id`: another workspace's row
 * under the same id says nothing about this one.
 */
async function unappliedTombstones(
  db: Queryable,
  key: WorkspaceKey,
  table: 'ro_objects' | 'ro_connections',
  fact: readonly string[],
  applied: ReadonlySet<string> | undefined,
): Promise<string[]> {
  if (applied) return fact.filter((id) => !applied.has(id))
  if (!fact.length) return []
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, [...fact]],
  )
  const present = new Set(rows.map((row) => row.id))
  return fact.filter((id) => present.has(id))
}

function effectiveOverlayState<T extends { id: string }>(
  orderedDocumentIds: readonly string[],
  segments: ReadonlyMap<string, Record<string, T>>,
  tombstones: ReadonlySet<string>,
): Map<string, { fingerprint: string; value: T }> {
  const effective = new Map<string, { fingerprint: string; value: T }>()
  for (const documentId of orderedDocumentIds) {
    for (const [id, value] of Object.entries(segments.get(documentId) ?? {})) {
      effective.set(id, { fingerprint: JSON.stringify(value), value })
    }
  }
  for (const id of tombstones) effective.delete(id)
  return effective
}
// `Math.max(FLOOR, Number(env))` READS as a floor and is not one:
// `Math.max(8, NaN)` is NaN. So each knob is parsed safely FIRST (`envNumber`),
// then clamped. Resulting behaviour:
//
//   | input                          | result                          |
//   |--------------------------------|---------------------------------|
//   | blank / 0 / negative           | the DEFAULT                     |
//   | non-integer segment size       | the default                     |
//   | above the maximum              | CLAMPED to the maximum, with an |
//   |                                | `env.knob_rejected` warning     |
//
// The relational floors (`OVERLAY_*_QUIET_MS` below a max-delay) stay a clamp on
// purpose: "the max delay is never less than the quiet period" is an invariant,
// and clamping up preserves it for any quiet period, where a fallback would only
// preserve it for the default one.
// `OVERLAY_SEGMENT_SIZE` is IMPORTED from `overlaySegments.ts`: it is the bound
// this file PROMISES to hold the write head under, and `workspaceFsck.ts`
// derives a ceiling from it, so it has one home.
const OVERLAY_ROTATION_QUIET_MS = Math.max(100, envNumber('AM_OVERLAY_ROTATION_QUIET_MS', {
  fallback: 5_000, minimum: 1, maximum: 3_600_000,
}))
const OVERLAY_ROTATION_MAX_DELAY_MS = Math.max(
  OVERLAY_ROTATION_QUIET_MS,
  envNumber('AM_OVERLAY_ROTATION_MAX_DELAY_MS', { fallback: 30_000, minimum: 1, maximum: 3_600_000 }),
)
const OVERLAY_KINDS = ['object', 'connection'] as const
/** T-ZEROWM (B): how long `stop()` waits for in-flight passes, rotations and
 * folds before releasing leases. Below index.ts's 30 s forced exit, which
 * still has to drain transports and end pools after it. */
const STATIC_STOP_DRAIN_CEILING_MS = 10_000
/** T-ZEROWM-4: the age past which a pass's withdrawal watch
 * (`passWithdrawals`) is logged (`read_model.static_pass_watch_overdue`, once
 * per watch) and counted. Above every pass measured here (a first ModelMeta
 * build, 26–35 s), at the capped retry backoff (5 min). */
const STATIC_PASS_WATCH_CEILING_MS = 300_000
/** T-ZEROWM (A): orphan-zero sweep bounds — rows read per tick, relaunches
 * per document logged one by one (past them: T-ZEROWM-3, the capped backoff
 * below, logged once per step), first backoff (doubles). */
const ZERO_SWEEP_BATCH = 32
const ZERO_SWEEP_MAX_ATTEMPTS = 5
const ZERO_SWEEP_FIRST_BACKOFF_MS = 30_000
const ZERO_SWEEP_TRACKED = 1_024
/** T-ZEROWM-2 (1): consecutive re-openings of one document by a withdrawn
 * pass retried at the next reload tick. T-ZEROWM-3 (2): BEYOND them (from the
 * 6th failure, as the sweep backs off past its 5 logged relaunches) the
 * re-opening is retried after a doubling backoff instead (never abandoned),
 * logged once per backoff step. */
const WITHDRAWN_REOPEN_LIMIT = 5
/** T-ZEROWM-3 (2): the backoff of a static recovery that keeps failing — the
 * withdrawn re-opening past {@link WITHDRAWN_REOPEN_LIMIT}, the orphan-zero
 * relaunch at every attempt — doubles from 30 s and is CAPPED at 5 min: once
 * the cause is gone a document is certified within 5 min plus one reload
 * tick, and at the cap a document that never heals costs 12 passes an hour.
 * Neither is ever abandoned (the static plane has no cold build to fall back
 * on until T-SUM-3). */
const STATIC_RETRY_FIRST_BACKOFF_MS = 30_000
const STATIC_RETRY_BACKOFF_CAP_MS = 300_000

/** T-ZEROWM-3 (2): the delay before the retry `step` steps past a limit
 * (0 = the first backed-off retry): `firstMs · 2^step`, capped at `capMs`.
 * The exponent is clamped, so `firstMs = 0` gives 0 rather than NaN. */
export function staticRetryBackoffMs(step: number, firstMs: number, capMs: number): number {
  return Math.min(capMs, firstMs * 2 ** Math.min(40, Math.max(0, step)))
}

/**
 * T-ZEROWM-3 (2): the next retry of a static recovery that just failed, for
 * both paths. `known`: the failures counted so far (undefined: none in the
 * book). Failure `count` waits `staticRetryBackoffMs(count − backoffFrom)`
 * from `count = backoffFrom` on (0 before), and is BACKING OFF — counted and
 * logged per step — from `count = loggedFrom` on. A document the book does not
 * know while it is `saturated` may be one it dropped while backing off
 * (`StaticRetryBook`): it enters at the first count that is backing off AND
 * waits the cap, so neither this failure nor the next is retried faster.
 * Withdrawn re-opening: backoffFrom = loggedFrom = the re-opening limit.
 * Orphan-zero sweep: backoffFrom = 1, loggedFrom = its logged relaunches + 1.
 */
export function staticRetryDecision(
  known: number | undefined,
  saturated: boolean,
  policy: { backoffFrom: number; loggedFrom: number; firstMs: number; capMs: number },
): { count: number; backoffMs: number; backingOff: boolean; entering: boolean } {
  const entering = known === undefined && saturated
  const stepsToCap = policy.firstMs > 0 && policy.capMs > policy.firstMs
    ? Math.ceil(Math.log2(policy.capMs / policy.firstMs)) : 0
  const count = known !== undefined ? known + 1
    : entering ? Math.max(policy.loggedFrom, policy.backoffFrom + stepsToCap) : 1
  const backoffMs = count >= policy.backoffFrom
    ? staticRetryBackoffMs(count - policy.backoffFrom, policy.firstMs, policy.capMs) : 0
  return { count, backoffMs, backingOff: count >= policy.loggedFrom, entering }
}

/**
 * T-ZEROWM-3 (2): per-document retry bookkeeping in BOUNDED process memory
 * (`bound` entries; an entry is refreshed to the young end at every failure;
 * past the bound the oldest entry NOT backing off goes first). Dropping an
 * entry resets that document's count, which would restart a document backing
 * off at the cap with fast retries; so a backing-off entry is dropped only
 * when every other one backs off too, ANY drop marks the book `saturated`, and
 * while it is, a document the book does not know is assumed to have been one
 * of the dropped: it enters backing off at the cap (`staticRetryDecision`). Cleared
 * once the book is down to half its bound (entries leave when a document
 * heals, and with their workspace on `release`). The price, under saturation
 * only, is a fresh document waiting the cap. NOT a guarantee: the entry also
 * carries the document's `nextAt`, so a document dropped from the book is
 * retried once at the next tick (one early retry per drop), before it enters
 * at the cap again — a book thrashing past its bound (more than 1 024
 * documents failing at once) bounds the work by the per-tick limits only. A
 * durable backoff (on the queue row) would not have this edge.
 */
export class StaticRetryBook<T extends { backingOff: boolean }> {
  private readonly entries = new Map<string, T>()
  saturated = false
  constructor(public bound: number) {}
  get(documentId: string): T | undefined { return this.entries.get(documentId) }
  get size(): number { return this.entries.size }
  [Symbol.iterator](): IterableIterator<[string, T]> { return this.entries[Symbol.iterator]() }
  values(): IterableIterator<T> { return this.entries.values() }
  /** Insert or refresh at the young end. Past the bound, drop the oldest
   * entry that is NOT backing off, other than the one just set (the cheapest
   * loss), or else the oldest of all. EVERY drop saturates the book: two
   * documents in their fast retries could otherwise drop each
   * other at every failure, never count up to the backoff, and be re-read at
   * every tick for ever; saturated, a dropped document comes back at the cap. */
  set(documentId: string, entry: T): void {
    this.entries.delete(documentId)
    this.entries.set(documentId, entry)
    while (this.entries.size > this.bound) {
      let victim: string | undefined
      for (const [id, tracked] of this.entries) {
        if (id !== documentId && !tracked.backingOff) { victim = id; break }
      }
      this.entries.delete(victim ?? this.entries.keys().next().value!)
      this.saturated = true
    }
  }
  delete(documentId: string): boolean {
    const deleted = this.entries.delete(documentId)
    if (this.saturated && this.entries.size <= Math.floor(this.bound / 2)) this.saturated = false
    return deleted
  }
}

/** T-ZEROWM-3 (2): retries scheduled PAST a limit, per path, since the
 * process started (a counter: it survives a projector's stop). */
const staticRecoveryBackoffRetries = { withdrawn_reopen: 0, zero_sweep: 0 }
/** T-ZEROWM-4: pass watches seen past `STATIC_PASS_WATCH_CEILING_MS`,
 * since the process started (each counted once). */
let staticPassWatchesOverdue = 0
/** T-ZEROWM (B): how many times `publishAdmittedRotation` re-flushes and
 * re-reads the durable ModelMeta before leaving the rotation `admitted` for
 * the recovery tick. */
const ROTATION_DURABILITY_ATTEMPTS = 3
/** A WALL-CLOCK ceiling for resolving the whole folded prefix, not a
 * per-document one: the pass holds a session advisory lock, and `repo.find`
 * never settles for a missing document while a network adapter is attached and
 * no peer answers. */
const OVERLAY_CHAIN_FOLD_RESOLVE_MS = Math.max(
  1_000,
  envNumber('AM_OVERLAY_CHAIN_FOLD_RESOLVE_MS', { fallback: 30_000, minimum: 1, maximum: 600_000 }),
)
const OVERLAY_PROJECTION_QUIET_MS = Math.max(
  50,
  envNumber('AM_OVERLAY_PROJECTION_QUIET_MS', { fallback: 500, minimum: 1, maximum: 600_000 }),
)
const OVERLAY_PROJECTION_MAX_DELAY_MS = Math.max(
  OVERLAY_PROJECTION_QUIET_MS,
  envNumber('AM_OVERLAY_PROJECTION_MAX_DELAY_MS', { fallback: 3_000, minimum: 1, maximum: 600_000 }),
)

/** `read_model.static_overlay_deferred`: how old the oldest deferral of a
 * workspace must be before it logs, and how often it may log after that. */
const STATIC_OVERLAY_DEFERRED_WARN_AFTER_MS = 30_000
const STATIC_OVERLAY_DEFERRED_WARN_INTERVAL_MS = 60_000

/** Every constructed projector until its `stop()` (production has one). */
const liveStaticProjectors = new Set<StaticDeltaProjector>()

/**
 * The overlay passes deferred until their workspace's ModelMeta state exists
 * (`deferUntilMetaState`), summed over the live projectors: a non-zero count
 * with a growing age is a workspace whose overlay edits are not projected,
 * because its ModelMeta pass never installed the state. NaN age when nothing
 * is deferred, so "no deferral" cannot read as "a deferral of age 0".
 */
export function staticOverlayDeferralMetricSamples(
  snapshots: ReadonlyArray<{ overlays: number; oldestAgeMs: number | null }>
    = [...liveStaticProjectors].map((projector) => projector.deferredOverlaySnapshot()),
): MetricSample[] {
  const overlays = snapshots.reduce((sum, snapshot) => sum + snapshot.overlays, 0)
  const ages = snapshots.flatMap((snapshot) => snapshot.oldestAgeMs === null ? [] : [snapshot.oldestAgeMs])
  return [
    {
      name: 'maplespire_read_model_static_overlay_deferred',
      help: 'Static overlay documents whose projection waits for their workspace\'s ModelMeta state (left pending, re-tried each reload tick). Non-zero for more than a few seconds: see the log line read_model.static_overlay_deferred.',
      type: 'gauge',
      values: [{ value: overlays }],
    },
    {
      name: 'maplespire_read_model_static_overlay_deferred_oldest_seconds',
      help: 'Age of the oldest static overlay deferral. NaN when nothing is deferred.',
      type: 'gauge',
      values: [{ value: ages.length ? Number((Math.max(...ages) / 1000).toFixed(3)) : Number.NaN }],
    },
  ]
}

/**
 * T-ZEROWM-3 (2): the static recoveries retried past their limit — a
 * withdrawn re-opening (`withdrawn_reopen`) or an orphan-zero relaunch
 * (`zero_sweep`) — as a counter of retries scheduled under the capped backoff
 * and a gauge of the documents backing off now (summed over the live
 * projectors). A document stays refused while it backs off: a gauge that does
 * not fall back to 0 is a document that does not heal (log lines
 * `read_model.static_withdrawn_reopen_backoff`,
 * `read_model.static_zero_certificate_backoff`).
 */
export function staticRecoveryBackoffMetricSamples(
  snapshots: ReadonlyArray<{ withdrawnBackingOff: number; zeroSweepBackingOff: number }>
    = [...liveStaticProjectors].map((projector) => projector.recoveryBackoffSnapshot()),
): MetricSample[] {
  const withdrawn = snapshots.reduce((sum, snapshot) => sum + snapshot.withdrawnBackingOff, 0)
  const swept = snapshots.reduce((sum, snapshot) => sum + snapshot.zeroSweepBackingOff, 0)
  // Literal label values (metricCardinality.test.ts): two series each.
  return [
    {
      name: 'maplespire_read_model_static_recovery_backoff_retries_total',
      help: 'Static recoveries retried past their limit under the capped exponential backoff (30 s doubling, 5 min cap): a pass withdrawn under its head re-opened again (recovery=withdrawn_reopen), an orphan refusal 0 relaunched again (recovery=zero_sweep).',
      type: 'counter',
      values: [
        { labels: { recovery: 'withdrawn_reopen' }, value: staticRecoveryBackoffRetries.withdrawn_reopen },
        { labels: { recovery: 'zero_sweep' }, value: staticRecoveryBackoffRetries.zero_sweep },
      ],
    },
    {
      name: 'maplespire_read_model_static_recovery_backoff_documents',
      help: 'Static documents backing off now (refused until a retry certifies them). Not falling back to 0: see read_model.static_withdrawn_reopen_backoff / read_model.static_zero_certificate_backoff.',
      type: 'gauge',
      values: [
        { labels: { recovery: 'withdrawn_reopen' }, value: withdrawn },
        { labels: { recovery: 'zero_sweep' }, value: swept },
      ],
    },
  ]
}

/**
 * T-ZEROWM-4: passes in flight past `STATIC_PASS_WATCH_CEILING_MS` — a
 * counter of the watches that crossed it, and a gauge of those still in
 * flight (summed over the live projectors). Such a pass — typically an
 * evicted one that never ends — keeps the durable recovery and the
 * orphan-zero sweep off its document for as long as it lives: see the log
 * line `read_model.static_pass_watch_overdue`.
 */
export function staticPassWatchMetricSamples(
  snapshots: ReadonlyArray<{ overdueWatchesInFlight: number }>
    = [...liveStaticProjectors].map((projector) => projector.passWatchSnapshot()),
): MetricSample[] {
  return [
    {
      name: 'maplespire_read_model_static_pass_watch_overdue_total',
      help: 'Static projection passes seen in flight past their ceiling (5 min by default). The durable recovery and the orphan-zero sweep wait for such a pass, so its document is not re-projected while it lives. See read_model.static_pass_watch_overdue.',
      type: 'counter',
      values: [{ value: staticPassWatchesOverdue }],
    },
    {
      name: 'maplespire_read_model_static_pass_watches_overdue',
      help: 'Static projection passes in flight now past their ceiling (5 min by default), not counting the passes of the same documents queued behind them. A pass of the document waits for it, so its document is not projected while it lives: read read_model.static_pass_watch_overdue; the pass ending, or a restart of the instance, ends it.',
      type: 'gauge',
      values: [{ value: snapshots.reduce((sum, snapshot) => sum + snapshot.overdueWatchesInFlight, 0) }],
    },
  ]
}

/** `read_model.static_overlay_not_ready`: how long a current head must have
 * been blocked before it logs, and how often it may log after that. */
const STATIC_OVERLAY_NOT_READY_WARN_AFTER_MS = 30_000
const STATIC_OVERLAY_NOT_READY_WARN_INTERVAL_MS = 60_000

/**
 * T-SUM-0b: current overlay write heads whose projection is blocked at
 * `!ready` (a segment of the chain has no snapshot in memory and could not be
 * read from its document), summed over the live projectors, and the age of
 * the oldest. Until T-SUM-0b that return was SILENT: measured on a stack, a
 * summary workspace's object head was blocked on every pass, retried every
 * reload tick, and nothing anywhere said so. NaN age when nothing is blocked,
 * so "none" cannot read as "blocked for 0 s".
 */
export function staticOverlayNotReadyMetricSamples(
  snapshots: ReadonlyArray<{ heads: number; oldestAgeMs: number | null }>
    = [...liveStaticProjectors].map((projector) => projector.notReadyOverlaySnapshot()),
): MetricSample[] {
  const heads = snapshots.reduce((sum, snapshot) => sum + snapshot.heads, 0)
  const ages = snapshots.flatMap((snapshot) => snapshot.oldestAgeMs === null ? [] : [snapshot.oldestAgeMs])
  return [
    {
      name: 'maplespire_read_model_static_overlay_heads_not_ready',
      help: 'Current static overlay write heads whose projection stops at !ready: a segment of the chain has no snapshot and could not be read from its document (pending, or unresolvable). Their writes reach no ro_* row. Non-zero for more than a few seconds: see the log line read_model.static_overlay_not_ready.',
      type: 'gauge',
      values: [{ value: heads }],
    },
    {
      name: 'maplespire_read_model_static_overlay_heads_not_ready_oldest_seconds',
      help: 'How long the oldest blocked static overlay write head has been blocked. NaN when none is.',
      type: 'gauge',
      values: [{ value: ages.length ? Number((Math.max(...ages) / 1000).toFixed(3)) : Number.NaN }],
    },
  ]
}

/** A historical overlay segment read from its DOCUMENT because no projected
 * snapshot of it existed (T-SUM-0b), with the queue revision it was read at. */
interface MaterialisedOverlaySegment {
  documentId: string
  revision: number
  snapshot: Record<string, ObjectInput | ConnectionInput>
}

/** The durable half of a materialisation: in the SAME transaction as the
 * pass that relied on it, so a crash cannot leave a snapshot recorded for
 * rows that never committed (a restart would restore it as projected). */
async function recordMaterialisedSegments(
  tx: Queryable,
  key: WorkspaceKey,
  collection: 'object' | 'connection',
  segments: readonly MaterialisedOverlaySegment[],
): Promise<void> {
  for (const segment of segments) {
    await recordOverlaySegmentProjection(tx, key, collection, segment.documentId, segment.revision, segment.snapshot)
  }
}

function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T
}

export function mergeStaticOverlaySegments<T extends { id: string }>(
  segments: readonly Record<string, T>[],
  tombstones: ReadonlySet<string> = new Set(),
): T[] {
  const effective = new Map<string, T>()
  for (const segment of segments) {
    for (const [id, value] of Object.entries(segment)) effective.set(id, value)
  }
  for (const id of tombstones) effective.delete(id)
  return [...effective.values()]
}

type EffectiveOverlay<T> = Map<string, { fingerprint: string; value: T }>

/**
 * The entries of an effective overlay view whose MAP KEY is not their inner
 * id, by inner id. Usually empty: a client writes an entity under its own id.
 * A twin (one inner id under a second key) is the case it exists for.
 *
 * Derived, in memory only, keyed by the very `effective` Map it describes:
 * built by one scan the first time `resolveStaticOverlayInnerIds` meets a
 * map, then kept in step by `updateStaticOverlaySegment` — the only function
 * that mutates an effective map once built (`effectiveOverlayState` builds a
 * NEW map, which gets a new index on first use). A WeakMap, so a replaced
 * state takes its index with it.
 */
const misfiledByInnerId = new WeakMap<EffectiveOverlay<unknown>, Map<string, Set<string>>>()

const innerIdOf = (value: { id: unknown }): string => String(value.id)

function noteEffectiveEntry(
  index: Map<string, Set<string>> | undefined,
  key: string,
  previous: { id: unknown } | undefined,
  next: { id: unknown } | undefined,
): void {
  if (!index) return
  if (previous && innerIdOf(previous) !== key) {
    const keys = index.get(innerIdOf(previous))
    keys?.delete(key)
    if (keys && !keys.size) index.delete(innerIdOf(previous))
  }
  if (next && innerIdOf(next) !== key) {
    const keys = index.get(innerIdOf(next)) ?? new Set<string>()
    keys.add(key)
    index.set(innerIdOf(next), keys)
  }
}

function misfiledIndexFor<T extends { id: string }>(effective: EffectiveOverlay<T>): Map<string, Set<string>> {
  let index = misfiledByInnerId.get(effective as EffectiveOverlay<unknown>)
  if (!index) {
    index = new Map()
    for (const [key, entry] of effective) noteEffectiveEntry(index, key, undefined, entry.value)
    misfiledByInnerId.set(effective as EffectiveOverlay<unknown>, index)
  }
  return index
}

/**
 * A key-level overlay delta turned into a ROW-level one. `effective` and the
 * delta `updateStaticOverlaySegment` returns are keyed by MAP KEY; the
 * `ro_*` rows by the entity's inner id, and one inner id can sit under two
 * keys (a twin), in one segment or in two. So for every inner id the delta
 * touched, the row is re-derived from the WHOLE effective view — every
 * segment, the tombstones applied — by the cold build's rule
 * (`extractModelEntities`: segments merged by key in meta order, listed by
 * first appearance, then `lastOccurrenceById`): the last holder in that
 * order is upserted, and the row is deleted only when NO key holds the id
 * any more. Deleting by key instead removed a row a surviving twin still
 * renders; upserting the touched copy instead made the row follow the last
 * edit rather than that rule.
 *
 * `dropped` are the other holders of each resolved id, for the
 * `duplicate-id` counter and log (`noteLiveDuplicateIds`).
 */
export function resolveStaticOverlayInnerIds<T extends { id: string }>(
  kind: 'object' | 'connection',
  orderedDocumentIds: readonly string[],
  segments: ReadonlyMap<string, Record<string, T>>,
  effective: EffectiveOverlay<T>,
  innerIds: Iterable<string>,
): { upserts: T[]; deleteIds: string[]; dropped: DroppedDuplicateId[] } {
  const index = misfiledIndexFor(effective)
  // First appearance of a key across the ordered segments, as the cold
  // build's `Object.assign` (and `mergeStaticOverlaySegments`' Map) lists
  // it: the first segment holding the key, then its place in that segment.
  const keyOrderCache = new Map<string, Map<string, number>>()
  const rank = (key: string): [number, number] => {
    for (let at = 0; at < orderedDocumentIds.length; at += 1) {
      const documentId = orderedDocumentIds[at]
      const segment = segments.get(documentId)
      if (!segment || !Object.hasOwn(segment, key)) continue
      let order = keyOrderCache.get(documentId)
      if (!order) {
        order = new Map(Object.keys(segment).map((segmentKey, position) => [segmentKey, position]))
        keyOrderCache.set(documentId, order)
      }
      return [at, order.get(key) ?? 0]
    }
    return [orderedDocumentIds.length, 0]
  }
  const listed: T[] = []
  const deleteIds: string[] = []
  for (const innerId of new Set(innerIds)) {
    const holders: string[] = []
    const own = effective.get(innerId)
    if (own && innerIdOf(own.value) === innerId) holders.push(innerId)
    for (const key of index.get(innerId) ?? []) {
      // The index is kept in step with `effective`; checked anyway, so a
      // stale entry can never name a key that no longer holds the id.
      const entry = effective.get(key)
      if (entry && innerIdOf(entry.value) === innerId) holders.push(key)
    }
    if (!holders.length) {
      deleteIds.push(innerId)
      continue
    }
    if (holders.length > 1) {
      const ranks = new Map(holders.map((key) => [key, rank(key)]))
      holders.sort((left, right) => {
        const [leftAt, leftPosition] = ranks.get(left)!
        const [rightAt, rightPosition] = ranks.get(right)!
        return leftAt - rightAt || leftPosition - rightPosition
      })
    }
    for (const key of holders) listed.push(effective.get(key)!.value)
  }
  const { kept, dropped } = lastOccurrenceById(kind, listed)
  return { upserts: kept, deleteIds, dropped }
}

/** Incrementally update one bounded overlay segment. The first complete set of
 * segments performs one full projection; subsequent updates inspect only IDs
 * added/changed/removed in the source segment and scan the small segment list
 * to find each touched ID's newest winner.
 *
 * KEY level: `upserts` and `deleteIds` are per MAP KEY. `touchedInnerIds`
 * are the inner ids of every key whose effective value changed, before and
 * after — what `resolveStaticOverlayInnerIds` turns into row writes.
 *
 * IN PLACE: `segments` and `effective` are mutated BEFORE the caller
 * publishes, and they are the baseline the next delta is computed against.
 * So a caller whose publish then applies nothing (resolves `false`, or
 * throws) MUST call `revert()`: left mutated, the retry of the same snapshot
 * finds every fingerprint equal, computes an empty delta, and acknowledges
 * the revision as projected — the rows this call computed are lost with
 * nothing reporting it. `revert()` puts back this call's segment, and every
 * effective entry that still holds what this call wrote (an entry a later
 * call has since rewritten is left to that call). Synchronous, so nothing
 * runs between the decision and the restore. */
export function updateStaticOverlaySegment<T extends { id: string }>(
  orderedDocumentIds: readonly string[],
  segments: Map<string, Record<string, T>>,
  effective: Map<string, { fingerprint: string; value: T }>,
  documentId: string,
  nextSegment: Record<string, T>,
  tombstones: ReadonlySet<string>,
  /** T-SUM-0b: diff EVERY key — of every segment, of the replaced segment and
   * of `effective` — against `effective`, even when the set was already
   * complete. For a pass that added segments `effective` has never seen
   * (read from their documents): an incremental diff would touch this
   * segment's keys only, and a pass made full by dropping this segment's
   * entry instead would forget the keys it removed since its last
   * projection, leaving their rows for good (measured). */
  full = false,
): { ready: boolean; upserts: T[]; deleteIds: string[]; touchedInnerIds: string[]; revert: () => void } {
  const wasReady = orderedDocumentIds.every((id) => segments.has(id))
  const hadSegment = segments.has(documentId)
  const replacedSegment = segments.get(documentId)
  const previousSegment = replacedSegment ?? {}
  segments.set(documentId, nextSegment)
  type Entry = { fingerprint: string; value: T }
  const written: { key: string; prior: Entry | undefined; next: Entry | undefined }[] = []
  const revert = () => {
    if (segments.get(documentId) === nextSegment) {
      if (hadSegment) segments.set(documentId, replacedSegment!)
      else segments.delete(documentId)
    }
    const index = misfiledByInnerId.get(effective as EffectiveOverlay<unknown>)
    for (const { key, prior, next } of written.reverse()) {
      if (effective.get(key) !== next) continue
      noteEffectiveEntry(index, key, next?.value, prior?.value)
      if (prior) effective.set(key, prior)
      else effective.delete(key)
    }
    written.length = 0
  }
  const ready = orderedDocumentIds.every((id) => segments.has(id))
  if (!ready) return { ready: false, upserts: [], deleteIds: [], touchedInnerIds: [], revert }
  const index = misfiledByInnerId.get(effective as EffectiveOverlay<unknown>)
  const touchedInnerIds = new Set<string>()
  const touched = new Set<string>()
  if (!wasReady || full) {
    // In `orderedDocumentIds` order (the meta's), not the order the segments
    // ARRIVED in: the first-appearance key order across the ordered segments
    // is the order the client's `Object.values(mergeObjectShards(...))` lists
    // them in. Which copy of a twin the ROW gets is decided by
    // `resolveStaticOverlayInnerIds`, which ranks holders by that same order
    // itself; this keeps the key-level `upserts` in it too.
    for (const documentId of orderedDocumentIds) {
      for (const id of Object.keys(segments.get(documentId) ?? {})) touched.add(id)
    }
    if (full) {
      for (const id of Object.keys(previousSegment)) touched.add(id)
      for (const id of effective.keys()) touched.add(id)
    }
  } else {
    for (const id of Object.keys(previousSegment)) touched.add(id)
    for (const id of Object.keys(nextSegment)) touched.add(id)
  }
  const upserts: T[] = []
  const deleteIds: string[] = []
  for (const id of touched) {
    let winner: T | undefined
    if (!tombstones.has(id)) {
      for (let index = orderedDocumentIds.length - 1; index >= 0; index -= 1) {
        winner = segments.get(orderedDocumentIds[index])?.[id]
        if (winner) break
      }
    }
    const prior = effective.get(id)
    if (!winner) {
      if (prior) {
        deleteIds.push(id)
        touchedInnerIds.add(innerIdOf(prior.value))
        noteEffectiveEntry(index, id, prior.value, undefined)
        written.push({ key: id, prior, next: undefined })
      }
      effective.delete(id)
      continue
    }
    const fingerprint = JSON.stringify(winner)
    if (!prior || prior.fingerprint !== fingerprint) {
      if (prior) touchedInnerIds.add(innerIdOf(prior.value))
      touchedInnerIds.add(innerIdOf(winner))
      noteEffectiveEntry(index, id, prior?.value, winner)
      const next = { fingerprint, value: winner }
      effective.set(id, next)
      written.push({ key: id, prior, next })
      upserts.push(winner)
    }
  }
  return { ready: true, upserts, deleteIds, touchedInnerIds: [...touchedInnerIds], revert }
}

/** Run `publication`; unless it resolves `true` — it resolved `false`, or
 * threw, synchronously or not — run `undo` before handing the outcome back.
 * For a pass that moved in-memory derived state ahead of its publish: that
 * state is the next pass's baseline, so it must never be left claiming rows
 * that did not commit. `undo` must not throw: it would replace the
 * publication's own error. */
export async function appliedOrUndone(
  undo: () => void,
  publication: () => Promise<boolean>,
): Promise<boolean> {
  let applied = false
  try {
    applied = await publication()
  } finally {
    if (!applied) undo()
  }
  return applied
}

/** Add a server-created empty write head without rebuilding every historical
 * snapshot. Rotation only appends one fresh current segment, so the effective
 * entity view is unchanged until that head receives its first mutation. */
export function appendFreshStaticOverlayHead<T extends { id: string }>(
  previousDocumentIds: readonly string[],
  nextDocumentIds: readonly string[],
  segments: Map<string, Record<string, T>>,
  childDocumentId: string,
): boolean {
  if (nextDocumentIds.at(-1) !== childDocumentId) return false
  if (!isAppendOnlyOverlayOrder(previousDocumentIds, nextDocumentIds)) return false
  if (previousDocumentIds.some((documentId) => !segments.has(documentId))) return false
  if (nextDocumentIds.some((documentId) => (
    documentId !== childDocumentId && !segments.has(documentId)
  ))) return false
  segments.set(childDocumentId, {})
  return true
}

/**
 * Incremental projector for immutable performance baselines.
 *
 * It never opens the 200k/300k base shards and never installs 30k diagram
 * listeners. It watches only handles that are already resident because an
 * editor requested them: bounded overlay segments, ModelMeta and active
 * DiagramDocs. A small durable descriptor table maps those handles to their
 * workspace and diagram identity.
 */
/** T-ZEROWM-2 (1): one pass's withdrawal watch — set when the residency
 * announces its document's eviction under it — and the projector run it
 * started in (`StaticDeltaProjector.life`). T-ZEROWM-4: whether it still
 * waits for an earlier pass of its document (`project`), when it stopped
 * waiting and started its own work (`startedAt`), whether it was already
 * reported past its ceiling, and the pass's end (`done`, never rejects),
 * which a later pass of the document awaits. */
type PassWatch = {
  withdrawn: boolean
  life: { leasesReleased: boolean }
  waiting: boolean
  startedAt: number
  overdue?: boolean
  done: Promise<void>
  /** T-ZEROWM-4: ends the wait of a pass a later pass of its document
   * supersedes (see `project`). */
  supersede: () => void
  superseded?: boolean
}
/** The two recoveries that re-project a document nothing else leases: the
 * orphan-zero sweep (T-ZEROWM-2 (3)) and the durable recovery
 * `recoverChangedDocuments` (T-ZEROWM-3 (1)). */
type RecoveryLeaseKind = 'zero-sweep' | 'recovery'
/** The transient (relinquishing) recovery first, wherever both are dropped —
 * by safety only: the residency's eviction intent makes the order moot. */
const RECOVERY_LEASE_KINDS = ['recovery', 'zero-sweep'] as const

export class StaticDeltaProjector {
  private readonly instanceId = randomUUID()
  private readonly descriptors = new StaticDescriptorMap()
  private readonly listened = new Map<string, { handle: DocHandle<unknown>; stop: () => void }>()
  private readonly workspaceTails = new Map<string, Promise<void>>()
  private readonly docRuns = new Map<string, {
    running: boolean
    pending: boolean
    timer?: NodeJS.Timeout
    firstQueuedAt?: number
    /** T-ZEROWM-4: the handle of the pass running (or of the one the timer
     * will start), and the running pass itself (never rejects). */
    handle?: DocHandle<unknown>
    run?: Promise<void>
  }>()
  private readonly attachedWorkspaces = new Map<string, StaticDocumentDescriptor>()
  /** The ATTACH descriptors (the values of `attachedWorkspaces`) whose
   * `c4_parent_id` repair has run. Keyed by object identity, not workspace: a
   * release deletes the map entry and a later re-attach stores a NEW
   * descriptor, so every attach repairs once without a release-side clear. */
  private readonly c4ParentsRepaired = new WeakSet<StaticDocumentDescriptor>()
  /** Attach descriptors whose repair is queued and not yet settled, so a tick
   * that fires while one waits behind a long projection does not queue a
   * second. */
  private readonly c4ParentRepairsInFlight = new WeakSet<StaticDocumentDescriptor>()
  /** Serializes the repairs — see `scheduleC4ParentRepairs`. Drained by `stop()`. */
  private c4RepairChain: Promise<void> = Promise.resolve()
  /** The retired-row repairs: one at a time, never on
   * the reload chain; one in flight per workspace at most. */
  private retiredRepairChain: Promise<void> = Promise.resolve()
  private readonly retiredRepairsInFlight = new Set<string>()
  /** Per workspace, the ids a BASELINE registry still lists (so not
   * orphans), and the baseline/head facts they were judged against. */
  private readonly baselineListedIds = new Map<string, { signature: string; ids: Set<string> }>()
  /** Per workspace, when the repair tick last walked
   * the unprojected DiagramDocs; cleared by `start()`. */
  private readonly unprojectedReopenedAt = new Map<string, number>()
  /** {@link UNPROJECTED_REOPEN_INTERVAL_MS}; a field so a
   * test can pass the interval. */
  private unprojectedReopenIntervalMs = UNPROJECTED_REOPEN_INTERVAL_MS
  /** T-SUM-2: the arrival certificate the CURRENT pass of a document may
   * write, keyed by document id (`project()` sets it before the dispatch and
   * deletes it in its `finally`; ONE pass per document at a time — `trigger`,
   * and T-ZEROWM-4, across a `detach`, `project` itself). Consumed ONLY where
   * a transaction moves that document's queue row to `revision` — the
   * publication or acknowledgement of exactly this pass — so a rotation, a
   * fold or a repair that publishes for the same document (always with source
   * revision 0) writes none. The root has no queue row: its pass stamps
   * through `stampRootPass`. */
  private readonly passStamps = new Map<string, {
    revision: number
    sampledHeads: readonly string[] | null
    readCurrentHeads: () => readonly string[] | null
    prepared: PreparedDocumentWatermarks
    /** T-ZEROWM-2 (1): the sampled handle was evicted under the pass, or
     * `stop()` released its leases — no 0 for the handle it lost. */
    headWithdrawn: () => boolean
  }>()
  /** T-ZEROWM (A): a write head the current pointer has just LEFT while a pass
   * of it is running, pending or scheduled, held resident under its own
   * residency owner (`static-retiring:<workspace>:<documentId>`, the value)
   * until that pass settles. Without it the rotation's lease release evicts
   * the head under its own pass, whose `readCurrentHeads` then answers null
   * and whose certificate is the refusal 0 — for good, since nothing projects
   * a retired head again. Released by
   * {@link releaseRetiringHead}: when the document's run ends with nothing
   * pending (`trigger`), on `detach`, on `release` and on `stop`. */
  private readonly retiringLeases = new Map<string, { owner: string; workspace: string }>()
  /** Every pass `trigger` started and that has not settled: `stop()` drains
   * them BEFORE it releases a lease (T-ZEROWM (B)). */
  private readonly inFlightRuns = new Set<Promise<void>>()
  /** T-ZEROWM-2 (1): per document, the pass in flight's WITHDRAWAL flag, from
   * the moment it samples its handle to its end: set when the residency
   * announces the document's eviction (`onBeforeEvict`) under it. Its
   * certificate then writes no 0 for the handle it lost
   * (`recordSampledDocumentWatermark`, `headWithdrawn`). */
  private readonly passWithdrawals = new Map<string, Set<PassWatch>>()
  /** T-ZEROWM-2 (1): this run of the projector (one per `start()`), whose
   * `leasesReleased` `stop()` sets as it releases its leases — after its
   * drain, or past its ceiling with passes still in flight. From then on no
   * pass OF THAT RUN certifies 0 for a handle it lost (the eviction listener
   * is gone, so its watch would not hear of it); a pass captures the run it
   * started in, so a later `start()` cannot take that back. */
  private life = { leasesReleased: false }
  /** T-ZEROWM-2 (3): documents the orphan-zero sweep relaunched
   * (`zero-sweep`) and, T-ZEROWM-3 (1), documents the durable recovery
   * (`recoverChangedDocuments`, at boot and every reload tick) re-projects
   * (`recovery`), held resident until that pass settles, valued by their
   * residency owner (`static-<kind>:<workspace>:<documentId>:<n>`, one per
   * relaunch) and workspace. */
  private readonly passLeases: Record<RecoveryLeaseKind, Map<string, { owner: string; workspace: string; evictOnRelease: boolean }>> = {
    'zero-sweep': new Map(), recovery: new Map(),
  }
  private passLeaseSeq = 0
  /** T-ZEROWM (B): the ceiling of `stop()`'s drain of in-flight work before it
   * releases leases. Past it `stop()` logs `read_model.static_stop_drain_overdue`
   * and proceeds (index.ts's forced exit is at 30 s). Writable for tests. */
  stopDrainCeilingMs = STATIC_STOP_DRAIN_CEILING_MS
  /** T-ZEROWM (A): orphan-zero sweep bookkeeping, per document: attempts and
   * the earliest time of the next one. Process memory, bounded. */
  /** T-ZEROWM-3 (2): `backingOff` once past `zeroSweepMaxAttempts`;
   * `loggedBackoffMs`, the backoff step last logged. */
  private readonly zeroSweepAttempts = new StaticRetryBook<{
    attempts: number; nextAt: number; backingOff: boolean; loggedBackoffMs?: number; workspace: string
  }>(ZERO_SWEEP_TRACKED)
  /** T-ZEROWM-3 (2): the book updates a projection
   * transaction decides, applied only once THAT transaction committed (a
   * rolled-back pass must neither reset a count nor hold back a revision it
   * never wrote). Keyed by the transaction's client — a POOLED client, lent
   * to one transaction at a time and reused after — so each of the two
   * transactions that record a certificate (`publish`, `transactionOnly`)
   * registers a fresh list of its own when it starts, unregisters it when it
   * is over, committed or not (`forgetBookTx`, only if the entry is still its
   * own), and runs its OWN list — never the map's — once committed. */
  private readonly afterCommit = new WeakMap<Queryable, Array<() => void>>()
  /** `backedOff` (T-ZEROWM-3 (2)): relaunches past `zeroSweepMaxAttempts`. */
  private readonly zeroSweepCounts = { relaunched: 0, legitimate: 0, backedOff: 0 }
  /** T-ZEROWM-2 (1): certificates a withdrawn head left owed (decisions,
   * counted in the transaction; a rolled-back one counts too). */
  private withdrawnCertificates = 0
  /** T-ZEROWM-3 (2): withdrawn re-openings scheduled under the backoff. */
  private withdrawnBackedOff = 0
  /** T-ZEROWM-3 (B1): retiring leases taken on a head under recovery. */
  private retiringUnderRecovery = 0
  /** T-ZEROWM-2 (1): per document, consecutive re-openings by a withdrawn
   * pass (reset by a pass that is not withdrawn). T-ZEROWM-3 (2): with the
   * time before which `recoverChangedDocuments` leaves it (`nextAt`), the
   * queue revision the re-opening wrote (`revision`: a newer save is not held
   * back), whether it backs off, and the step last logged. Bounded. */
  private readonly withdrawnReopens = new StaticRetryBook<{
    reopens: number; nextAt: number; revision: string | null; backingOff: boolean; loggedBackoffMs?: number; workspace: string
  }>(ZERO_SWEEP_TRACKED)
  /** Legitimate verdicts, keyed by document, valued by the row version
   * (`updated_at` as text) they were reached on. Bounded. */
  private readonly zeroSweepLegitimate = new Map<string, string>()
  /** Writable for tests: the sweep's first backoff and relaunch count before
   * T-ZEROWM-3's logged backoff; the withdrawn re-opening's limit and first
   * backoff; the cap of both backoffs. */
  zeroSweepFirstBackoffMs = ZERO_SWEEP_FIRST_BACKOFF_MS
  zeroSweepMaxAttempts = ZERO_SWEEP_MAX_ATTEMPTS
  withdrawnReopenLimit = WITHDRAWN_REOPEN_LIMIT
  withdrawnFirstBackoffMs = STATIC_RETRY_FIRST_BACKOFF_MS
  recoveryBackoffCapMs = STATIC_RETRY_BACKOFF_CAP_MS
  /**
   * T-ZEROWM-4: {@link STATIC_PASS_WATCH_CEILING_MS}; writable for tests.
   *
   * A pass evicted under it and that never ends keeps its watch
   * (`passWithdrawals`, kept across `detach`): the durable recovery and the
   * orphan-zero sweep wait for that watch, and a later pass
   * of the document waits for that pass to end (`project`). Past this
   * ceiling the watch is LOGGED AND COUNTED — and still waited for. Dropping
   * it would hand the document to a second pass while the first may wake and
   * write: nothing fences a pass's publications (no per-pass token reaches
   * `publish`), so a publication that the zombie queues AFTER the second pass
   * committed puts back the rows of its older snapshot (a DiagramDoc's, for
   * one: `upsertDiagrams` is unconditional) and its refusal 0, under a queue
   * already acknowledged at the newer revision (`GREATEST`) — and nothing
   * re-projects them: the "(overlap)" case, measured before the fix. Waiting
   * costs liveness on ONE document, said by the log, the counter and the
   * gauge; the pass ending, or a restart, ends it. Dropping costs
   * correctness, silently.
   */
  passWatchCeilingMs = STATIC_PASS_WATCH_CEILING_MS
  private passWatchesOverdue = 0
  private readonly overlayState = new Map<string, StaticOverlayState>()
  /** Per workspace, the overlay documents whose pass found no `overlayState`
   * while the workspace HAS a ModelMeta, and so deferred (left pending) rather
   * than build a self-only state — see `projectEffectiveOverlay`. Re-triggered
   * by the ModelMeta pass the moment it installs the state. Each document
   * maps to the time it FIRST deferred (kept across re-deferrals), for the
   * `read_model.static_overlay_deferred` warn and the gauge. */
  private readonly overlaysAwaitingMeta = new Map<string, Map<string, number>>()
  /** Per workspace, when `read_model.static_overlay_deferred` last logged. */
  private readonly overlayDeferredWarnedAt = new Map<string, number>()
  /** T-SUM-0b: per `workspace NUL kind`, the CURRENT overlay head whose last
   * pass stopped at `!ready` — a segment of its chain has no snapshot in
   * memory — with the missing segments and the time it FIRST stopped (kept
   * across passes). Cleared by the first pass of that head that is ready.
   * Read by the `/metrics` gauge and the `read_model.static_overlay_not_ready`
   * warn (`noteOverlayNotReady`): until T-SUM-0b that return was silent, and
   * a stack measured it taken on every pass for ever while the badge said
   * "Synced". */
  private readonly overlayHeadsNotReady = new Map<string, {
    landscapeId: string
    versionId: string
    kind: 'object' | 'connection'
    documentId: string
    missing: string[]
    since: number
    warnedAt?: number
  }>()
  private readonly metaSemanticFingerprints = new Map<string, string>()
  private readonly currentOverlayDocumentIds = new Map<string, {
    object?: string
    connection?: string
  }>()
  /** Workspaces whose plane loss has already been logged. Purged on the
   * success branch of {@link holdsStaticPlane}, so a re-promotion re-arms it. */
  private readonly planeLostReported = new Set<string>()
  /** Detach writes started by `release()`, so `stop()` can drain them.
   * Self-clearing in a `finally`, so this is bounded by what is in flight. */
  private readonly pendingDetachWrites = new Set<Promise<void>>()
  private readonly rotatingHeads = new Set<string>()
  /** Chains with a fold pass in flight, keyed like {@link rotatingHeads}. */
  private readonly foldingChains = new Set<string>()
  /** At most ONE fold anywhere in this process. `foldingChains` bounds one
   * chain; this bounds the pod, whose read-model pool holds four connections. */
  private overlayFoldInFlight = false
  private readonly pendingRotations = new Map<string, {
    timer: NodeJS.Timeout
    firstQueuedAt: number
    descriptor: StaticDocumentDescriptor
    kind: 'object' | 'connection'
  }>()
  private scanTimer: NodeJS.Timeout | null = null
  /** T-ZEROWM-4: the overdue-watch check, armed at
   * the very start of `start()` — before its awaits, which a zombie of the
   * boot can park (the scan is armed only at their end) — and on no chain. */
  private watchTimer: NodeJS.Timeout | null = null
  /** Its period; writable for tests. */
  passWatchCheckMs = 1_000
  private reloadTimer: NodeJS.Timeout | null = null
  private reloadTail: Promise<void> = Promise.resolve()
  private stopped = false
  private stopEvictionListener: (() => void) | null = null

  constructor(
    private readonly repo: Repo,
    private readonly db: Pool,
    private readonly scanIntervalMs = 250,
    private readonly descriptorReloadMs = 10_000,
    private readonly ownsWorkspace: (key: WorkspaceKey) => boolean = () => true,
    private readonly ownership?: StaticProjectionOwnership,
    private readonly residency?: AutomergeResidencyLeases,
    private readonly setPinnedCoreDocument?: (owner: string, documentId?: string) => void,
    private readonly forgetDocumentRequests?: (documentId: string) => void,
    private readonly overlayRotationQuietMs = OVERLAY_ROTATION_QUIET_MS,
    private readonly overlayRotationMaxDelayMs = OVERLAY_ROTATION_MAX_DELAY_MS,
    /** Injected rather than read from `process.env` at call time, because
     * `OVERLAY_CHAIN_FOLD_MIN`/`_BUDGET` are evaluated at import. A test that
     * had to reach the production default would need 64 real rotations, which
     * is well past this suite's timeout. */
    private readonly overlayFoldMinChain?: number,
    private readonly overlayFoldBudget?: number,
    /** Injected for the same reason as the two above.
     * `OVERLAY_SEGMENT_ENTITY_CEILING` defaults to 1 024 entities, and a test
     * that had to cross it would have to build 1 024 real Automerge entities
     * per segment (~500 ms of wasm work each). Without this seam no test could
     * distinguish sealing from no sealing at all. */
    private readonly overlayFoldSegmentCeiling?: number,
    private readonly overlayFoldWindowEntities?: number,
  ) {
    // Read by `staticOverlayDeferralMetricSamples` (/metrics); `stop()` removes it.
    liveStaticProjectors.add(this)
  }

  async start(): Promise<void> {
    this.stopped = false
    this.life = { leasesReleased: false }
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.notePassWatchesOverdue(), this.passWatchCheckMs)
      this.watchTimer.unref()
    }
    // The first repair tick after a start walks again.
    this.unprojectedReopenedAt.clear()
    // `stop()` took it out of the set /metrics reads; a start after a stop
    // (the constructor's add is the only other one) puts it back.
    liveStaticProjectors.add(this)
    this.stopEvictionListener ??= this.residency?.onBeforeEvict((documentId) => {
      // T-ZEROWM-2 (1): BEFORE `removeFromCache` (the residency announces
      // synchronously): a pass of this document that commits after it writes
      // no 0 for the handle it lost.
      for (const watch of this.passWithdrawals.get(documentId) ?? []) watch.withdrawn = true
      this.detach(documentId)
    }) ?? null
    await this.reloadDescriptors()
    this.repo.on('document', this.onDocument)
    await this.hydrateControlDocuments()
    await this.recoverAdmittedOverlayRotations()
    await this.recoverChangedDocuments()
    await this.recoverCurrentOverlayRotationObligations()
    this.scheduleOverlayChainFolds()
    this.scanResidentHandles()
    // `stop()` never awaits an in-flight `start()`, and the caller invokes it
    // unconditionally on SIGTERM. Every await above can therefore have
    // straddled a shutdown: without this the two intervals would be installed
    // AFTER `stop()` cleared them, re-arming the reload chain against a pool
    // the caller is about to end, and the next tick would re-stamp
    // `read_model_projection_state.projector_instance_id` with a dead
    // instance's id that will never detach.
    if (this.stopped) return
    this.scanTimer = setInterval(() => this.scanResidentHandles(), this.scanIntervalMs)
    this.reloadTimer = setInterval(() => {
      this.reloadTail = this.reloadTail.then(async () => {
        if (this.stopped) return
        await this.reloadDescriptors()
        // A cell that regains a partition has no in-memory debounce timer from
        // the former owner. Rehydrate its two bounded control documents, then
        // reconstruct any overfull current-head rotation obligation even when
        // the durable projection queue was already caught up before failover.
        await this.hydrateControlDocuments()
        // Ownership may have been unavailable during start(). Admitted
        // rotations are durable work, so retry them whenever descriptors are
        // refreshed after a later lease acquisition.
        await this.recoverAdmittedOverlayRotations()
        await this.recoverChangedDocuments()
        await this.relaunchOrphanZeroCertificates()
        // T-DIAGDEF: rows an earlier resurrection left behind.
        // SCHEDULED on a chain of its own, never awaited
        // here: a slow repair must not hold this chain.
        this.scheduleRetiredDiagramRepairs()
        await this.recoverCurrentOverlayRotationObligations()
        // SCHEDULES, never runs inline. Running it here would hold a session
        // advisory lock on the reload chain while a ModelMeta projection waits
        // for the same key from another pooled connection.
        // `recoverAdmittedOverlayRotations` takes the SAME key from this chain,
        // so both takers refuse instead of queueing (`overlayRotationLock.ts`);
        // a blocking wait there would stall `start()` itself.
        this.scheduleOverlayChainFolds()
        this.scanResidentHandles()
        // Also SCHEDULES, on each workspace's own tail: a repair queued behind
        // a long projection must not hold up the next descriptor reload.
        this.scheduleC4ParentRepairs()
      }).catch((error) => {
        console.error('[read-model] static descriptor reload failed', error)
      })
    }, this.descriptorReloadMs)
    this.scanTimer.unref()
    this.reloadTimer.unref()
  }

  /**
   * Repair `ro_objects.c4_parent_id` once for every workspace this cell has
   * ATTACHED since its last repair (`c4ParentsRepaired`).
   *
   * WHY ON ATTACH. The `0005-ro-objects-c4-parent` migration fixes rows once,
   * at the first new-code boot. An OLD-code cell still serving during a
   * rolling deploy then keeps writing `ro_objects` without the column: a new
   * object reads as a root, a reparent keeps its old level, the children of a
   * deleted parent appear at no level. WITH `SYNC_CELL_OWNERSHIP=on` those are
   * rows of workspaces it owns: every static write asserts the ownership
   * fencing token under the projection mutex (`assertPlaneAndOwnership`, also
   * in the old code), so once this cell holds the lease an old cell's next
   * write is refused, and one that took the mutex first commits before this
   * repair, queued behind the same mutex, runs. So the moment those rows
   * become this cell's problem is the moment it takes the workspace over.
   * WITHOUT ownership (`ownsWorkspace` is `() => true`, no fence) two
   * overlapping processes both project every static workspace, and an old one
   * still running after this repair writes drift nothing repairs before the
   * next restart; the shipped deploys do not overlap (k8s `Recreate` with one
   * replica, ownership on elsewhere). An ordinary workspace heals at takeover
   * anyway (every projector start is a cold build); a static one has no cold
   * build, hence this.
   *
   * Through `transactionOnly`: queued on the workspace's tail behind its
   * projections, under the projection mutex, plane and ownership fence
   * asserted on both sides. `repairWorkspaceC4ParentIds` writes only wrong rows, so on
   * a consistent workspace it is a read-only pass — the price every attach
   * pays once the fleet is homogeneous (~1.2 s at 200 000 objects, measured with
   * server/scripts/measure-viewer-level-c4.ts).
   *
   * ONE AT A TIME, on `c4RepairChain`: a takeover attaches many workspaces in
   * one reload, and firing every repair at once would hold that many projection
   * mutexes and read-model connections (the pool is small) next to the cold
   * builds the same takeover starts.
   *
   * Not run by `start()`'s own first reload, on purpose: that would add one
   * pass per static workspace to boot. The first tick is `descriptorReloadMs`
   * later, and the drift it repairs was written before this process existed.
   */
  private scheduleC4ParentRepairs(): void {
    for (const attached of this.attachedWorkspaces.values()) {
      if (this.stopped) return
      if (this.c4ParentsRepaired.has(attached) || this.c4ParentRepairsInFlight.has(attached)) continue
      this.c4ParentRepairsInFlight.add(attached)
      const run = this.c4RepairChain.then(async () => {
        // Saves opening a transaction after a shutdown that landed while this
        // waited behind earlier repairs. Not the guard: the action re-checks
        // `stopped`, and a RELEASED attach is refused by `transactionOnly`'s
        // ownership and plane asserts (which is why no release check is here —
        // a QA mutant removing one survived as equivalent).
        if (this.stopped) return
        await this.repairC4ParentsOnAttach(attached)
      })
      // `repairC4ParentsOnAttach` never rejects, so neither does the chain.
      this.c4RepairChain = run.finally(() => {
        this.c4ParentRepairsInFlight.delete(attached)
      })
    }
  }

  /** One workspace's repair. NEVER rejects — it is scheduled, not awaited. It
   * counts as done only if the action RAN *and* its transaction COMMITTED:
   * `transactionOnly` refuses quietly when the cell no longer owns the
   * workspace, the mutex wait expired, or authority was lost — including a
   * fencing-token rotation AFTER the action ran, which rolls it back while the
   * same attach stays in place. Each of those leaves it due for the next tick. */
  private async repairC4ParentsOnAttach(attached: StaticDocumentDescriptor): Promise<void> {
    let ran = false
    let committed: boolean
    try {
      committed = await this.transactionOnly(attached, async (tx) => {
        // A repair can wait on the workspace's tail behind projections; a
        // SIGTERM in that wait must not then start a pass `stop()` has to
        // drain inside the 30 s forced-exit window. `ran` stays false.
        if (this.stopped) return
        const repaired = await repairWorkspaceC4ParentIds(tx, attached)
        if (repaired.length) await this.publishC4ParentRepair(tx, attached, repaired)
        ran = true
      })
    } catch (error) {
      console.error(
        `[read-model] c4_parent_id repair failed for ${attached.landscapeId}/${attached.versionId}; `
        + 'the next descriptor reload retries it',
        error,
      )
      return
    }
    if (ran && committed) this.c4ParentsRepaired.add(attached)
  }

  /**
   * Tell the browser caches what the repair rewrote: one `objects` change
   * naming exactly the repaired ids, under a generation allocated and appended
   * INSIDE the repair's transaction. Only called when a row changed — a
   * consistent workspace (every attach, once the fleet is homogeneous)
   * allocates no generation and appends nothing.
   *
   * NOT `publish()`, for two reasons. `publish()` stamps
   * `read_model_static_document_state` for the descriptor's document up to that
   * document's newest storage write, which would mark a pending registry shard
   * as projected when nothing projected it. And it takes its token on the POOL
   * before the transaction, so a pass that then finds nothing to repair would
   * still have bumped `observed_generation` (that bump survives the rollback).
   * Here the generation commits or rolls back with the rows it describes: a
   * refused or failed repair leaves none behind, so there is no
   * `failReadModelProjection` to record and no ordinary-plane health row to
   * forge — `transactionOnly`'s asserts on both sides of the action gate the
   * write, under the projection mutex.
   *
   * NOT `beginReadModelProjection` / `completeReadModelProjection` either: they
   * stamp `last_projected_at`, `source_changed_at` and clear the error columns,
   * workspace freshness this pass did not earn — it projects no document, and
   * it runs at takeover, when the former owner's backlog is most likely
   * pending. `advanceReadModelGenerationWithinTransaction` moves the two
   * generation counters only (health.ts says how).
   *
   * Not widened with `objectCacheNeighbourIds`: the repair moves only the
   * repaired rows' own `c4_parent_id`. No other row served to a cache reads it
   * — the cache rows' `child_count` and explorer parent follow
   * `effective_parent_id` (objectExplorer.ts), which the repair does not
   * touch. The viewer level's own `child_count` does read `c4_parent_id`
   * (viewerLevel.ts), but online it is a live query and offline the worker
   * probes its own index of the refreshed rows (modelReadCache.worker.ts
   * `queryViewerLevel`), so the parent's chevron follows the repaired child.
   */
  private async publishC4ParentRepair(
    tx: Queryable,
    attached: StaticDocumentDescriptor,
    repaired: string[],
  ): Promise<void> {
    const token = await advanceReadModelGenerationWithinTransaction(tx, attached, attached.orgId)
    await appendReadModelChange(tx, attached, token, { kind: 'objects', upsertIds: repaired, deleteIds: [] })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.reloadTimer) clearInterval(this.reloadTimer)
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
    for (const pending of this.pendingRotations.values()) clearTimeout(pending.timer)
    this.pendingRotations.clear()
    for (const run of this.docRuns.values()) if (run.timer) clearTimeout(run.timer)
    this.docRuns.clear()
    this.scanTimer = null
    this.reloadTimer = null
    this.repo.off('document', this.onDocument)
    // T-ZEROWM (B): the in-flight work FIRST, the leases after. A rotation in
    // flight holds the ModelMeta handle it resolved before its lock; releasing
    // the leases evicts that handle, and the rotation's change then lands on a
    // handle no persistence listener follows (`repo.flush` finds nothing
    // resident to save) — measured: `published` in SQL, the durable ModelMeta
    // unchanged (`rotationShutdown.integration.test.ts`, case 1). Bounded:
    // past the ceiling the leases go anyway, and the publication's own
    // durability check keeps such a rotation `admitted` for the next boot.
    const drained = await this.drainInFlightWork()
    // T-ZEROWM-2 (1): BEFORE the first release below, and before the eviction
    // listener goes: a pass still in flight past the ceiling (or one the
    // drain did not see) certifies no 0 for a head these releases evict.
    this.life.leasesReleased = true
    this.stopEvictionListener?.()
    this.stopEvictionListener = null
    for (const listener of this.listened.values()) listener.stop()
    this.listened.clear()
    const workspaces = new Set([
      ...this.attachedWorkspaces.keys(),
      ...this.currentOverlayDocumentIds.keys(),
    ])
    // T-ZEROWM-3: the transient (recovery) leases FIRST, the evicting owners
    // after — by safety only, the residency's eviction intent makes the order
    // moot.
    for (const kind of RECOVERY_LEASE_KINDS) {
      for (const [documentId, lease] of [...this.passLeases[kind]]) this.releaseRecoveryLease(kind, documentId, lease.owner)
    }
    for (const workspace of workspaces) {
      this.residency?.releaseOwner(`static-write-head:${workspace}:object`)
      this.residency?.releaseOwner(`static-write-head:${workspace}:connection`)
      this.residency?.releaseOwner(`static-control:${workspace}:root`)
      this.residency?.releaseOwner(`static-control:${workspace}:model-meta`)
      this.setPinnedCoreDocument?.(`static-write-head:${workspace}:object`)
      this.setPinnedCoreDocument?.(`static-write-head:${workspace}:connection`)
      this.setPinnedCoreDocument?.(`static-control:${workspace}:root`)
      this.setPinnedCoreDocument?.(`static-control:${workspace}:model-meta`)
    }
    for (const documentId of [...this.retiringLeases.keys()]) this.releaseRetiringHead(documentId)
    this.currentOverlayDocumentIds.clear()
    this.metaSemanticFingerprints.clear()
    this.overlaysAwaitingMeta.clear()
    this.overlayDeferredWarnedAt.clear()
    this.overlayHeadsNotReady.clear()
    liveStaticProjectors.delete(this)
    // A descriptor refresh may already be inside a PostgreSQL query when the
    // interval is cleared. Drain it before the caller closes the shared pool.
    // T-ZEROWM (B): already drained above, within the ceiling; when the
    // ceiling passed, waiting for the same work again here would make the
    // ceiling a fiction — the overdue log has said what is still in flight,
    // and index.ts's forced exit bounds the rest.
    if (drained) {
      await this.reloadTail
      // Before the tails: a queued repair re-checks `stopped` and returns, and
      // the one in progress is inside a `transactionOnly` the tails then cover.
      await this.c4RepairChain
      // The same for the retired-row repairs: within the
      // drain's ceiling above, like the C4 chain; a queued one sees `stopped`.
      await this.retiredRepairChain
      await Promise.allSettled([...this.workspaceTails.values()])
    }
    // The detach writes `release()` starts are DURABILITY-adjacent, and
    // reconciliation can fire `release()` from every reload tick, so `stop()`
    // must drain them or end with writes in flight against a pool the caller
    // is about to end.
    await Promise.allSettled([...this.pendingDetachWrites])
    await Promise.all([...this.attachedWorkspaces.values()].map((descriptor) =>
      markReadModelProjectorDetached(this.db, descriptor, this.instanceId)))
    this.attachedWorkspaces.clear()
    // TWICE, because the first drain is a SNAPSHOT and not a barrier: a tick
    // already past its own `stopped` guard, or an `onOwnershipLost` landing in
    // any of the awaits above, can call `release()` and add to the set after
    // that copy was taken. The set cannot grow after this point — nothing
    // re-adds to `attachedWorkspaces` once `stopped` is set and the timers are
    // gone — so a second pass is a barrier rather than the start of a loop.
    await Promise.allSettled([...this.pendingDetachWrites])
  }

  /** Drop every listener and descriptor for a workspace immediately after a
   * sync-cell lease loss. In-flight publications also re-check their fencing
   * token immediately before committing. */
  release(key: WorkspaceKey, reason = 'ownership lost'): void {
    const workspace = keyOf(key)
    for (const [documentId, descriptor] of this.descriptors) {
      if (keyOf(descriptor) !== workspace) continue
      this.descriptors.delete(documentId)
      this.detach(documentId)
    }
    this.overlayState.delete(workspace)
    this.overlaysAwaitingMeta.delete(workspace)
    this.overlayDeferredWarnedAt.delete(workspace)
    for (const kind of OVERLAY_KINDS) this.overlayHeadsNotReady.delete(`${workspace}\u0000${kind}`)
    this.metaSemanticFingerprints.delete(workspace)
    this.currentOverlayDocumentIds.delete(workspace)
    for (const [rotationKey, pending] of this.pendingRotations) {
      if (!rotationKey.startsWith(`${workspace}\u0000`)) continue
      clearTimeout(pending.timer)
      this.pendingRotations.delete(rotationKey)
    }
    // T-ZEROWM-2 (3): the sweep's leases of this workspace whose descriptor
    // was already gone (the `detach` loop above did not reach them);
    // T-ZEROWM-3 (1): and the durable recovery's — transient ones FIRST, the
    // evicting owners below after (by safety: the residency's eviction intent
    // makes the order moot).
    for (const kind of RECOVERY_LEASE_KINDS) {
      for (const [documentId, lease] of [...this.passLeases[kind]]) {
        if (lease.workspace === workspace) this.releaseRecoveryLease(kind, documentId)
      }
    }
    this.residency?.releaseOwner(`static-write-head:${workspace}:object`)
    this.residency?.releaseOwner(`static-write-head:${workspace}:connection`)
    this.residency?.releaseOwner(`static-control:${workspace}:root`)
    this.residency?.releaseOwner(`static-control:${workspace}:model-meta`)
    // T-ZEROWM (A): a retiring head of this workspace whose descriptor was
    // already gone (so the `detach` loop above did not reach it).
    for (const [documentId, lease] of [...this.retiringLeases]) {
      if (lease.workspace === workspace) this.releaseRetiringHead(documentId)
    }
    // T-ZEROWM-3 (2): the retry books forget the workspace's documents
    // (a lost workspace backs off nothing here; left, they stay in the gauge
    // and fill the books). Its next owner judges them afresh.
    for (const book of [this.withdrawnReopens, this.zeroSweepAttempts]) {
      for (const [documentId, tracked] of [...book]) if (tracked.workspace === workspace) book.delete(documentId)
    }
    this.setPinnedCoreDocument?.(`static-write-head:${workspace}:object`)
    this.setPinnedCoreDocument?.(`static-write-head:${workspace}:connection`)
    this.setPinnedCoreDocument?.(`static-control:${workspace}:root`)
    this.setPinnedCoreDocument?.(`static-control:${workspace}:model-meta`)
    const attached = this.attachedWorkspaces.get(workspace)
    this.attachedWorkspaces.delete(workspace)
    // UNCONDITIONAL — no `!this.stopped` gate. The map entry above is deleted
    // either way, and `stop()`'s own detach loop reads that map — so skipping
    // the write here would mean NEITHER writes it, leaving `projector_attached
    // = true` with a dead instance's id. `markReadModelProjectorDetached` is a
    // CAS on that id, so no later process could ever clear it. `index.ts`
    // awaits `stop()` before ending the read-model pool, and `stop()` drains
    // these writes twice (the first drain is only a snapshot).
    if (attached) {
      const write = markReadModelProjectorDetached(this.db, attached, this.instanceId)
        .catch((error) => console.error(`[read-model] static projector detach after ${reason} failed`, error))
        .finally(() => { this.pendingDetachWrites.delete(write) })
      this.pendingDetachWrites.add(write)
    }
  }

  private readonly onDocument = ({ handle }: { handle: DocHandle<unknown> }): void => {
    this.attach(handle)
    const descriptor = this.descriptors.get(handle.documentId)
    if (descriptor && descriptor.kind !== 'root' && descriptor.kind !== 'model-meta') {
      void this.triggerIfDurablyPending(descriptor, handle).catch((error) => {
        console.error('[read-model] static pending-document check failed', error)
      })
    }
  }

  /**
   * Derive attachment from the plane AUTHORITY, and reconcile.
   *
   * Reading `read_model_static_documents` alone (and only ever `set()`ing)
   * would be wrong in two compounding ways:
   *
   *  - a workspace the operator had DEMOTED would keep its descriptors, because
   *    the authority for the static plane is `read_model_static_workspaces`;
   *  - the demoted projector's own `rotateOverlayHead` re-INSERTs a
   *    `read_model_static_documents` row, which would read back as evidence
   *    that it should be attached — a self-sustaining re-attach loop.
   *
   * And each re-attach calls `markReadModelProjectorAttached`, which UPSERTs
   * `read_model_projection_state` — the ORDINARY projector's health row —
   * stamping the STATIC projector's `projector_instance_id` onto it.
   *
   * REMOVAL IS SNAPSHOTTED BEFORE THE QUERY, not derived from the result alone.
   * A rotation commits its document row and only then installs the child
   * descriptor, so a tick whose SELECT ran before that commit would otherwise
   * sweep away a descriptor installed while it was in flight — self-healing on
   * the next tick, but ten seconds of a write head that nothing projects.
   * Anything that appears during the query window is simply not a candidate.
   */
  private async reloadDescriptors(): Promise<void> {
    // Reconciliation MUTATES: it releases workspaces, detaches listeners and
    // writes the health row. A pass that started before `stop()` and resumed
    // after it would do all three against a pool the caller is ending. (The
    // reload tick guards this too; `start()`'s first call needs it here.)
    if (this.stopped) return
    // Candidates for removal, taken BEFORE the read. See the note above.
    const knownDocuments = new Set(this.descriptors.keys())
    const knownWorkspaces = new Map(this.attachedWorkspaces)

    // The `entity_id` backfill repairs rows that no CURRENT writer creates —
    // `projectRegistryShard` supplies `entityId` for every diagram it
    // registers. It is joined to the authority for the same reason the SELECT
    // below is, and so that a park's non-static workspaces cost nothing here.
    await this.db.query(
      `UPDATE read_model_static_documents document
       SET entity_id = diagram.id
       FROM ro_diagrams diagram, read_model_static_workspaces workspace
       WHERE document.entity_id IS NULL
         AND document.kind = 'diagram'
         AND workspace.landscape_id = document.landscape_id
         AND workspace.version_id = document.version_id
         AND diagram.landscape_id = document.landscape_id
         AND diagram.version_id = document.version_id
         AND replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '') = document.document_id`,
    )
    const { rows } = await this.db.query<{
      landscape_id: string
      version_id: string
      document_id: string
      kind: string
      entity_id: string | null
      org_id: string | null
    }>(
      // NO `ro_diagrams` JOIN, and this is the hot statement of the tick.
      //
      // A `COALESCE(document.entity_id, diagram.id)` would need a join on
      // `replace(COALESCE(data->>'docUrl',''),'automerge:','')` — an expression
      // NO index covers — every ten seconds. The backfill UPDATE above fills
      // `entity_id` over exactly that join, one statement earlier, so the
      // COALESCE could only ever return `document.entity_id` anyway.
      //
      // Measured against a real Postgres, 20 workspaces / 2 static / 10 000
      // diagrams, median of 7, identical result sets:
      //
      //   with the diagram join     122.26 ms
      //   without it                  1.52 ms
      //
      // Combined with the authority join, the planner switches to a
      // merge-then-filter that is quadratic WITHIN each workspace.
      //
      // What this gives up: a `ro_diagrams` row inserted between the
      // UPDATE and this SELECT is picked up one tick later instead of
      // immediately. Ten seconds, self-healing, against 120 ms per tick.
      `SELECT workspace.landscape_id, workspace.version_id, document.document_id,
              document.kind, document.entity_id, state.org_id
       FROM read_model_static_workspaces workspace
       LEFT JOIN read_model_static_documents document
         ON document.landscape_id = workspace.landscape_id
        AND document.version_id = workspace.version_id
       LEFT JOIN read_model_projection_state state
         ON state.landscape_id = workspace.landscape_id
        AND state.version_id = workspace.version_id`,
    )
    const servedDocuments = new Set<string>()
    const servedWorkspaces = new Set<string>()
    for (const row of rows) {
      // THE WORKSPACE VERDICT COMES FROM THE WORKSPACE TABLE, which is why the
      // statement above is driven FROM it and reaches the allow-list through a
      // LEFT JOIN. Deriving "still ours" from "did any document row survive"
      // would be wrong: an empty allow-list and a lost
      // plane are different facts, and `markStaticReadModelWorkspace`'s
      // no-documents branch is one call away from producing the first without
      // the second — at which point the sweep would drop a healthy workspace's
      // descriptors, leases and pins, and log a reason that is simply untrue.
      const key = { landscapeId: row.landscape_id, versionId: row.version_id }
      // THE SERVED SETS ARE ABOUT THE AUTHORITY, AND ONLY THE AUTHORITY. The
      // fleet's lease predicate is answered strictly BELOW them, and the order
      // is the whole point.
      //
      // With `ownsWorkspace` in front of these adds, a workspace the fleet
      // filters lands in NEITHER set and the sweep below tears it down with the
      // reason "the workspace left the static plane" — which did not happen.
      // Reconciliation would turn that false answer into a full teardown —
      // descriptors, listeners, four residency owners, four core-document pins
      // (so root and ModelMeta become idle-evictable), and every pending
      // rotation `clearTimeout`ed.
      //
      // And it is reachable with no authority transfer at all:
      // `partitionIsLive()` folds `this.redis.ready` into the answer, so `owns`
      // goes false for EVERY workspace the moment the Redis transport blips,
      // while the paired `onOwnershipLost` only fires on the next reconcile
      // tick. `ownership.ts` says it one function above — "an unavailable Redis
      // connection is not proof that another cell owns the workspace".
      //
      // Lease loss already HAS an owner: `onOwnershipLost` -> `release()`,
      // which carries the right reason and empties `attachedWorkspaces`, after
      // which this loop has nothing left to do. Two facts, two owners.
      servedWorkspaces.add(keyOf(key))
      if (row.document_id) servedDocuments.add(row.document_id)
      if (!this.ownsWorkspace(key)) continue
      // A workspace with an authority row and no allow-list yields one row with
      // a NULL document. It is SERVED and has no descriptor — collapsing those
      // two is the whole point of the LEFT JOIN.
      if (!row.document_id) continue
      const descriptor: StaticDocumentDescriptor = {
        landscapeId: row.landscape_id,
        versionId: row.version_id,
        documentId: row.document_id,
        kind: row.kind,
        entityId: row.entity_id,
        orgId: row.org_id,
      }
      this.descriptors.set(row.document_id, descriptor)
      const workspace = keyOf(descriptor)
      // RE-CHECKED HERE, not only at the entry. The guard at the top of this
      // method sits BEFORE two round trips — the backfill UPDATE and the
      // descriptor SELECT — and `stop()` does not await an in-flight `start()`,
      // whose first reload is not on `reloadTail`. So a SIGTERM landing in
      // either await would leave this loop stamping `projector_attached = true`
      // with a dying instance's id AFTER `stop()` had cleared the map. That
      // mark is cleared by a CAS on the same id, which no later process can
      // satisfy: the workspace would never report idle again.
      if (this.stopped) return
      if (!this.attachedWorkspaces.has(workspace)) {
        // MARK, then RECORD. `attachedWorkspaces` is the fixed-point guard that
        // `attach` consults, so setting it before the durable write means a
        // throw here leaves the workspace looking attached with no row — and
        // since the `has()` is what gates the retry, the mark is never
        // re-attempted for the life of the process.
        await markReadModelProjectorAttached(
          this.db, descriptor, descriptor.orgId, this.instanceId,
        )
        this.attachedWorkspaces.set(workspace, descriptor)
      }
    }

    // The same re-check the row loop carries, and for the same reason: both
    // sweeps MUTATE — `release` detaches listeners, drops residency leases and
    // starts a durable write — and every await above is a window a shutdown can
    // land in.
    if (this.stopped) return

    // Workspaces first: `release` drops every descriptor it owns, so the
    // per-document sweep below then has only the narrower case left to handle.
    // The map's VALUE is a descriptor, which is already a `WorkspaceKey` — the
    // key string is never parsed back, so its separator stays private.
    for (const [workspace, descriptor] of knownWorkspaces) {
      if (servedWorkspaces.has(workspace)) continue
      this.release(descriptor, 'the workspace left the static plane')
    }
    // Then documents whose row went while the workspace stayed. Reachable:
    // `degenerateRootRepair` deletes retired document ids from the allow-list
    // and leaves the authority row alone, so a retired registry shard would
    // otherwise keep its descriptor, its `change` listener and its projection
    // into `ro_diagrams` for a root that has been rotated away.
    for (const documentId of knownDocuments) {
      if (servedDocuments.has(documentId)) continue
      this.descriptors.delete(documentId)
      this.detach(documentId)
      // T-ZEROWM-3 (2): nothing projects it any more, so
      // it backs off nothing (not in `detach`, which an eviction — a failure
      // the backoff counts — also reaches).
      this.withdrawnReopens.delete(documentId)
      this.zeroSweepAttempts.delete(documentId)
    }
    await this.releaseCaughtUpRetiredPeerRequests()
  }

  /** A rotation can race with the final sync frames from clients that still
   * target the retired head. Historical segments become release candidates
   * only after their durable queue is caught up and quiet. The synchronizer
   * applies the stronger network proof: every requester must also have
   * acknowledged every current server head. Offline or later edits re-register
   * normally and are projected before a later release attempt. */
  private async releaseCaughtUpRetiredPeerRequests(): Promise<void> {
    if (!this.forgetDocumentRequests) return
    const { rows } = await this.db.query<{
      landscape_id: string
      version_id: string
      document_id: string
    }>(
      `SELECT segment.landscape_id, segment.version_id, segment.document_id
       FROM read_model_overlay_segments segment
       LEFT JOIN read_model_static_document_queue queue
         ON queue.landscape_id = segment.landscape_id
        AND queue.version_id = segment.version_id
        AND queue.document_id = segment.document_id
       WHERE NOT segment.is_current
         AND COALESCE(queue.revision, 0) <= COALESCE(queue.projected_revision, 0)
         AND COALESCE(queue.projected_at, segment.retired_at, segment.admitted_at)
             <= now() - interval '2 seconds'`,
    )
    for (const row of rows) {
      const key = { landscapeId: row.landscape_id, versionId: row.version_id }
      if (this.ownsWorkspace(key)) this.forgetDocumentRequests(row.document_id)
    }
  }

  /**
   * ⚠ Converted for uniformity, NOT made cheaper. This runs every
   * `scanIntervalMs` (250 ms, so 4 Hz) against the HUB's repo, for the whole
   * process regardless of workspace, and one read of the O(n) getter costs
   * 883 us at 3 000 resident documents -- about 3.5 ms/s, for ever, producing
   * nothing when nothing has changed.
   *
   * The obvious inversion -- walk `this.descriptors` and look each one up in
   * O(1) -- is NOT obviously right and is deliberately not done here:
   * `descriptors` carries a `kind: 'diagram'` row per diagram, so on a
   * 30k-diagram static workspace it is two orders of magnitude LARGER than the
   * resident set and the inversion is slower. Which side wins is unmeasured;
   * measure before touching it.
   */
  private scanResidentHandles(): void {
    if (this.stopped) return
    for (const handle of Object.values(cachedHandles(this.repo))) this.attach(handle)
  }

  /** Root + ModelMeta are the two small control documents per static workspace.
   * Both stay resident: evicting a canonical root through automerge-repo can
   * compact a conflict-laden document to an empty snapshot. ModelMeta opening
   * also backfills every plural overlay segment into the durable allow-list.
   * Base shards and the 30k DiagramDocs remain unopened. */
  private async hydrateControlDocuments(): Promise<void> {
    const controls = [...this.descriptors.values()].filter((descriptor) => (
      descriptor.kind === 'root' || descriptor.kind === 'model-meta'
    ))
    for (const descriptor of controls) {
      if (this.listened.has(descriptor.documentId)) continue
      try {
        const handle = await resolveHandleWithRetry(
          this.repo, `automerge:${descriptor.documentId}` as AutomergeUrl,
          { tries: 5, delayMs: 250 },
        )
        this.attach(handle)
      } catch (error) {
        console.error(`[read-model] static ${descriptor.kind} hydration failed`, error)
      }
    }
    await Promise.allSettled([...this.workspaceTails.values()])
  }

  /** Rotation eligibility is derived from the bounded current document, not
   * from an in-memory timer. Re-evaluate it after startup and every ownership
   * reconciliation so a failover between projection and the deferred timer
   * cannot strand an overfull write head indefinitely. */
  private async recoverCurrentOverlayRotationObligations(): Promise<void> {
    for (const [workspace, current] of this.currentOverlayDocumentIds) {
      for (const kind of ['object', 'connection'] as const) {
        const documentId = current[kind]
        if (!documentId) continue
        const descriptor = this.descriptors.get(documentId)
        if (!descriptor || keyOf(descriptor) !== workspace || !this.ownsWorkspace(descriptor)) continue
        try {
          const handle = await this.resolveDocumentHandle<ObjectOverlayLike | ConnectionOverlayLike>(documentId)
          const snapshot = plain<ObjectOverlayLike | ConnectionOverlayLike>(handle.doc())
          await this.maybeRotateOverlayHead(descriptor, kind, snapshot)
        } catch (error) {
          console.error(`[read-model] current ${kind} overlay rotation recovery failed`, error)
        }
      }
    }
  }

  /** Durable crash recovery without a 30k-handle sweep. The storage adapter
   * increments this queue atomically with each static Automerge chunk write;
   * only documents whose revision is ahead of the transactional projection
   * checkpoint are opened. */
  private async recoverChangedDocuments(): Promise<void> {
    // Shutdown check: otherwise the queue join can be issued after `stop()`
    // has already returned.
    if (this.stopped) return
    // T-ZEROWM-4: the acknowledgements committed during this run
    // (from BEFORE its SELECT), for `acknowledgedSinceSelect`. One run at a
    // time: the reload chain is serial, and `start()` runs it before the chain
    // — except after a `stop()` whose drain passed its ceiling (it does not
    // wait for `reloadTail`) followed by a `start()` in the same process: two
    // runs may then overlap and share or lose this Map. That only costs the
    // optimisation (redundant passes come back); every acknowledgement noted
    // here is still later than each run's SELECT, so no due row is skipped.
    this.acknowledgedThisTick = new Map()
    try {
      await this.recoverChangedDocumentsNow()
    } finally {
      this.acknowledgedThisTick = null
    }
  }

  private async recoverChangedDocumentsNow(): Promise<void> {
    // T-ZEROWM-3 (2): a document a withdrawn pass re-opened and that backs
    // off is NOT read before its time — excluded in SQL, so documents backing
    // off cannot fill the page — and only for the very revision that
    // re-opening wrote: a newer save (a higher queue revision) is read at once.
    const now = Date.now()
    const resting = [...this.withdrawnReopens]
      .filter(([, tracked]) => tracked.revision !== null && now < tracked.nextAt)
    const { rows } = await this.db.query<{ document_id: string; revision: string }>(
      `SELECT queue.document_id, queue.revision::text AS revision
       FROM read_model_static_document_queue queue
       JOIN read_model_static_documents document
         ON document.landscape_id = queue.landscape_id
        AND document.version_id = queue.version_id
        AND document.document_id = queue.document_id
       WHERE queue.revision > queue.projected_revision
         AND NOT EXISTS (
           SELECT 1 FROM unnest($1::text[], $2::bigint[]) AS resting(document_id, revision)
            WHERE resting.document_id = queue.document_id AND resting.revision = queue.revision)
       ORDER BY queue.enqueued_at
       LIMIT 1000`,
      [resting.map(([documentId]) => documentId), resting.map(([, tracked]) => tracked.revision)],
    )
    for (const row of rows) {
      // Per ROW as well as at the head: this loop is up to 1 000 iterations of
      // `resolveHandleWithRetry` (five tries, 250 ms apart) and a projection.
      if (this.stopped) return
      const descriptor = this.descriptors.get(row.document_id)
      if (!descriptor || !this.ownsWorkspace(descriptor)) continue
      // T-DIAGDEF: NOT a document whose pass is running (or already
      // re-requested, or scheduled). `trigger` would mark it `pending`, and the
      // running pass's `finally` re-runs it AT ONCE — after that pass was
      // withdrawn and its backoff set: the re-run left 33–41 ms later, past a
      // 300 ms backoff (measured). The
      // running pass certifies the document or is withdrawn and re-opens it;
      // either way the queue says what is still owed, and the next tick reads
      // it — under the backoff. (The orphan-zero sweep skips busy documents
      // for the same reason.)
      // `passBusy` reads `docRuns`, which `detach`
      // empties at the eviction's announcement — while the evicted pass still
      // runs to its withdrawal, whose re-opening (and backoff) only exists
      // once its transaction commits. In that window the row is owed and
      // `passBusy` false: a tick started a SECOND pass on a fresh handle,
      // concurrent with the first and under its backoff. A pass in flight is
      // also known by its watch (`passWithdrawals`, from the pass's start to
      // its end, kept across `detach`): `recoveryMustWait`.
      // T-ZEROWM-4: nor one backing off — the SELECT above read the book
      // BEFORE this loop's awaits (the resolves and passes of the rows before
      // this one), and a pass that is not the recovery's (a change event's)
      // can be withdrawn and set the backoff meanwhile. Read here, before the
      // resolve (which would LOAD it — and a load's change event starts a
      // pass), and again below, after it.
      // T-ZEROWM-4: nor one a pass acknowledged since the SELECT.
      if (this.recoveryMustWait(row.document_id) || this.withdrawnBackingOff(row) || this.acknowledgedSinceSelect(row)) continue
      try {
        const handle = await resolveHandleWithRetry(
          this.repo, `automerge:${row.document_id}` as AutomergeUrl,
          { tries: 5, delayMs: 250 },
        )
        if (this.stopped) return
        // …nor one whose pass is in flight on ANOTHER handle (an evicted pass,
        // watched, its `docRuns` entry gone with the `detach`; T-ZEROWM-4,
        // or one running on a dead handle). A pass that started DURING the
        // resolve, on THIS handle, is another matter: see
        // `adoptOrRunUnderRecoveryLease`. Skipped or not, a pass the load's change event armed on this handle runs —
        // under the lease, as the hydration's does (`leasePassStartedOn`).
        if (this.recoveryMustWaitOn(row.document_id, handle)) { this.leasePassStartedOn(handle); continue }
        // T-ZEROWM-3 (1): the handle resolved above must still be the Repo's
        // (an idle eviction inside the resolve's awaits would hand the pass a
        // dead handle: withdrawn at its sample); left owed otherwise, for the
        // next tick — and checked BEFORE `attach`, which would
        // otherwise swap a live listener for the dead handle's. Then the pass
        // runs under its own residency lease, taken with no await between.
        const held = this.repo.synchronizer.docSynchronizers[row.document_id as DocumentId]?.query.peek()
        if (held?.state !== 'ready' || held.handle !== handle) continue
        this.attach(handle)
        // T-ZEROWM-4: read again, synchronously before a pass
        // starts. A resolve that RETRIES (its find failed: 250 ms) leaves room
        // for a change-event pass on the handle resident at the start to be
        // evicted and commit its withdrawal; the retry then returns a fresh
        // handle, with no run and no watch left (measured). Not for a pass running on this handle: that one is
        // leased, whatever the book says.
        const running = this.docRuns.get(row.document_id)
        if (!(running?.running && running.handle === handle) && (this.withdrawnBackingOff(row) || this.acknowledgedSinceSelect(row))) {
          this.leasePassStartedOn(handle)
          continue
        }
        // T-DIAGDEF (seen in CI, `--static`): a pass running NOW on this
        // handle started during the resolve — the 4 Hz scan
        // (`scanResidentHandles`) attached the change listener to the handle
        // this resolve was loading, and the load's own change event started
        // it; or `attach` itself, for a ModelMeta (rarer; a root has no
        // queue row, so the recovery never reaches one). That pass IS the
        // recovery's: it takes the recovery lease — it used to run
        // unleased (measured: no `static-recovery:` owner at its
        // acknowledgement, 2 runs in 30 of `zeroWatermarkRecovery` under load)
        // — and it is NOT asked again (the busy-document skip above). T-ZEROWM-4:
        // ON THIS HANDLE, checked. Until T-ZEROWM-4 this comment said a busy
        // pass could only run on this handle; `trigger`'s `finally` re-ran a
        // pass on the dead handle of a detached entry, busy too — it no longer
        // does, and one on another handle is waited for above all the same.
        // A pass not running is started here, under the lease. Why at all: a
        // current overlay can be observed before every historical segment is
        // hydrated. Its first projection then intentionally stops at
        // `delta.ready === false`, without advancing the durable queue. Once
        // hydration completes the handle is still resident, so attach() is a
        // no-op and no Automerge change event is guaranteed to replay it.
        // Explicitly retry durable pending work for an already-listened handle.
        this.adoptOrRunUnderRecoveryLease('recovery', descriptor, handle)
      } catch (error) {
        console.error('[read-model] static changed-document recovery failed', error)
      }
    }
    await Promise.allSettled([...this.workspaceTails.values()])
  }

  /** T-ZEROWM-4: during one run of `recoverChangedDocuments`, per
   * document, the highest queue revision an acknowledgement COMMITTED since
   * that run began (`recordPassWatermark`, after COMMIT; every transaction
   * that moves a static queue row's `projected_revision` records there). The
   * run's SELECT is a snapshot: a row it read owed, that a pass acknowledged
   * since (a change event's, started before the tick), is not run again — a
   * redundant pass of an acknowledged revision (it published nothing,
   * `metaSourceAlreadyProjected` and the like; measured behind the ModelMeta
   * case above, 1 run in 60 under load). Safe: anything newer has a
   * higher queue revision, which the next tick's SELECT reads. Null between
   * runs; bounded by the acknowledgements of one run. */
  private acknowledgedThisTick: Map<string, bigint> | null = null

  private noteAcknowledged(documentId: string, revision: number): void {
    const acknowledged = this.acknowledgedThisTick
    if (!acknowledged) return
    const known = acknowledged.get(documentId)
    if (known === undefined || known < BigInt(revision)) acknowledged.set(documentId, BigInt(revision))
  }

  /** `row`, read by the run's SELECT, acknowledged since ({@link acknowledgedThisTick}). */
  private acknowledgedSinceSelect(row: { document_id: string; revision: string }): boolean {
    const known = this.acknowledgedThisTick?.get(row.document_id)
    return known !== undefined && BigInt(row.revision) <= known
  }

  /** T-ZEROWM-4: `row`'s document backs off a withdrawn re-opening NOW —
   * the rule the recovery's SELECT applies (T-ZEROWM-3 (2)), read again:
   * resting until `nextAt`, and only while the queue revision `row` read is
   * not newer than the one that re-opening wrote (a newer save is read at
   * once). A revision read BEFORE a re-opening is older than the one it
   * wrote: that is the case this re-read is for. */
  private withdrawnBackingOff(row: { document_id: string; revision: string }): boolean {
    const tracked = this.withdrawnReopens.get(row.document_id)
    return Boolean(tracked && tracked.revision !== null && Date.now() < tracked.nextAt
      && BigInt(row.revision) <= BigInt(tracked.revision))
  }

  /**
   * T-ZEROWM (A), defence in depth: re-run the pass of a document whose
   * certificate is an ORPHAN refusal — `projected_watermark = 0` while nothing
   * will ever project it again, so the absence proof of its workspace refuses
   * (`zero`) for good.
   *
   * THE FRONTIER, drawn from durable facts only: a 0 is an orphan when its
   * queue row is acknowledged (`revision = projected_revision`: no pass is
   * owed) AND its `projected_heads` — the revision the rows ARE the
   * projection of, written in the same statement as the 0 — equal the heads
   * strictly decoded from storage NOW. Then the rows already show exactly the
   * durable content and only the third witness (the live handle) was missing
   * when the 0 was written; a pass that re-samples certifies it. Everything
   * else is a LEGITIMATE 0 and is left alone, counted: heads unknown (NULL),
   * storage moved past the projected revision without a queue revision (a
   * true hole — the refusal is the honest answer, and a pass is not the
   * repair), a pass owed (it will stamp), a document busy, or no durable
   * content.
   *
   * Bounded: {@link ZERO_SWEEP_BATCH} rows per tick, only this projector's
   * attached workspaces (a PK-prefix scan each), per-document exponential
   * backoff (doubling, capped at {@link STATIC_RETRY_BACKOFF_CAP_MS}). Each of
   * the first {@link ZERO_SWEEP_MAX_ATTEMPTS} relaunches logs
   * `read_model.static_zero_certificate_relaunched`; past them the document is
   * NOT given up (T-ZEROWM-3 (2)): it keeps being relaunched at the capped
   * backoff, counted, and `read_model.static_zero_certificate_backoff` logs
   * once per backoff step. The counts are in
   * {@link zeroCertificateSweepSnapshot}. Never throws.
   */
  private async relaunchOrphanZeroCertificates(): Promise<void> {
    if (this.stopped || this.attachedWorkspaces.size === 0) return
    const workspaces = [...this.attachedWorkspaces.values()]
    const now = Date.now()
    // NOT re-read (32 skipped rows used to fill
    // every page for ever, their `updated_at` never moving): documents backing
    // off, and legitimate verdicts for the exact row version they were reached
    // on (a rewritten row — a new `updated_at` — is judged again).
    const resting = [...this.zeroSweepAttempts]
      .filter(([, tracked]) => now < tracked.nextAt)
      .map(([documentId]) => documentId)
    const judged = [...this.zeroSweepLegitimate]
    let rows: { document_id: string; projected_heads: string[]; updated_at: string }[]
    try {
      rows = (await this.db.query<{ document_id: string; projected_heads: string[]; updated_at: string }>(
        `SELECT wm.document_id, wm.projected_heads, wm.updated_at::text AS updated_at
           FROM unnest($1::text[], $2::text[]) AS w(landscape_id, version_id)
           JOIN read_model_document_watermarks wm
             ON wm.landscape_id = w.landscape_id AND wm.version_id = w.version_id
           JOIN read_model_static_document_queue q
             ON q.landscape_id = wm.landscape_id AND q.version_id = wm.version_id
            AND q.document_id = wm.document_id
           JOIN read_model_static_documents sd
             ON sd.landscape_id = wm.landscape_id AND sd.version_id = wm.version_id
            AND sd.document_id = wm.document_id
          WHERE wm.projected_watermark = 0
            AND wm.projected_heads IS NOT NULL
            AND q.revision = q.projected_revision
            -- A ModelMeta pass returns at metaSourceAlreadyProjected
            -- without stamping: relaunching it cannot heal.
            AND sd.kind NOT IN ('model-meta', 'root')
            AND NOT (wm.document_id = ANY($4::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM unnest($5::text[], $6::text[]) AS judged(document_id, updated_at)
               WHERE judged.document_id = wm.document_id AND judged.updated_at = wm.updated_at::text)
          ORDER BY wm.updated_at, wm.document_id
          LIMIT $3`,
        [
          workspaces.map((key) => key.landscapeId), workspaces.map((key) => key.versionId), ZERO_SWEEP_BATCH,
          resting, judged.map(([documentId]) => documentId), judged.map(([, updatedAt]) => updatedAt),
        ],
      )).rows
    } catch (error) {
      console.error('[read-model] orphan zero-certificate sweep failed', error)
      return
    }
    const storage = this.repo.storageSubsystem
    for (const row of rows) {
      if (this.stopped) return
      const descriptor = this.descriptors.get(row.document_id)
      // T-ZEROWM-4 (2): the recovery's rule — not only a pass
      // `trigger` knows of, but one still in flight after a `detach` (its
      // watch): an evicted relaunch runs on to its withdrawal while its 0 is
      // still on an acknowledged row, past a short backoff.
      if (!descriptor || !this.ownsWorkspace(descriptor) || this.recoveryMustWait(row.document_id)) continue
      let durable: readonly string[] | undefined
      try {
        const prepared = await prepareDocumentWatermarkProofs(this.db, storage
          ? [{ documentId: row.document_id, drainPendingSaves: () => storage.drainDocumentSaves(row.document_id as DocumentId) }]
          : [], durableHeadsMemo)
        durable = prepared.durableHeadsById.get(row.document_id)
      } catch {
        continue
      }
      if (!durable || !headsEqual(durable, row.projected_heads)) {
        // Counted once per row version, and not read again until it changes.
        this.zeroSweepLegitimate.delete(row.document_id)
        this.zeroSweepLegitimate.set(row.document_id, row.updated_at)
        while (this.zeroSweepLegitimate.size > ZERO_SWEEP_TRACKED) {
          this.zeroSweepLegitimate.delete(this.zeroSweepLegitimate.keys().next().value!)
        }
        this.zeroSweepCounts.legitimate += 1
        // T-ZEROWM-3 (2): a legitimate refusal is not a relaunch backing off.
        this.zeroSweepAttempts.delete(row.document_id)
        continue
      }
      this.zeroSweepLegitimate.delete(row.document_id)
      // Read BEFORE the resolve: did the relaunch itself load the document?
      // Any synchronizer — ready or still LOADING for another caller —
      // means someone else has it: not ours to evict. (A
      // load another caller starts DURING the resolve is not seen: the
      // relaunch then evicts it at its end, as every relaunch did before.)
      const wasResident = this.repo.synchronizer.docSynchronizers[row.document_id as DocumentId] !== undefined
      let handle: DocHandle<unknown>
      try {
        handle = await this.resolveDocumentHandle(row.document_id)
      } catch {
        continue
      }
      // T-ZEROWM-4 (2): a pass that started DURING the resolve, on this handle
      // — the 4 Hz scan's listener hearing the change event of the sweep's own
      // load — is NOT a reason to skip: skipped (as it once was), it ran with
      // no sweep lease, outside the book. It is the relaunch, below. A pass on
      // another handle (evicted, or re-run on a dead one) is waited for.
      if (this.stopped) continue
      // (m-1: an armed pass of this handle, skipped here, runs under a lease.)
      if (this.recoveryMustWaitOn(row.document_id, handle)) { this.leasePassStartedOn(handle); continue }
      // T-ZEROWM-2 (3): the handle resolved above must still be the Repo's —
      // an idle eviction inside the resolve's awaits would leave the pass a
      // dead handle — and it is LEASED, synchronously from this check to the
      // pass's start, until that pass settles: an idle eviction (a retired
      // head, a diagram: nothing else leases them) can no longer take it from
      // under the relaunch.
      const held = this.repo.synchronizer.docSynchronizers[row.document_id as DocumentId]?.query.peek()
      if (held?.state !== 'ready' || held.handle !== handle) continue
      // T-ZEROWM-3 (2): never given up. A document the book does not know
      // while it is saturated may be one it dropped while backing off: it
      // enters at the cap (`staticRetryDecision`). Its entry leaves the book
      // when a pass CERTIFIES it (`recordPassWatermark`), or with its
      // workspace (`release`).
      // T-ZEROWM-3: the descriptor may have gone during the
      // awaits above — no book entry for a document this projector no longer
      // projects (`stillProjects`).
      if (!this.stillProjects(descriptor)) continue
      const known = this.zeroSweepAttempts.get(row.document_id)
      const { count: attempts, backoffMs, backingOff, entering } = staticRetryDecision(
        known?.attempts, this.zeroSweepAttempts.saturated, {
          backoffFrom: 1, loggedFrom: this.zeroSweepMaxAttempts + 1,
          firstMs: this.zeroSweepFirstBackoffMs, capMs: this.recoveryBackoffCapMs,
        })
      // Logged once per backoff STEP past the relaunches logged one by one.
      const logStep = backingOff && known?.loggedBackoffMs !== backoffMs
      this.zeroSweepAttempts.set(row.document_id, {
        attempts, nextAt: Date.now() + backoffMs, backingOff,
        loggedBackoffMs: logStep ? backoffMs : known?.loggedBackoffMs,
        workspace: keyOf(descriptor),
      })
      if (!backingOff) console.warn(JSON.stringify({
        event: 'read_model.static_zero_certificate_relaunched',
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
        documentId: row.document_id,
        kind: descriptor.kind,
        attempt: attempts,
      }))
      else if (logStep) console.warn(JSON.stringify({
        event: 'read_model.static_zero_certificate_backoff',
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
        documentId: row.document_id,
        kind: descriptor.kind,
        attempt: attempts,
        backoffMs,
        capped: backoffMs >= this.recoveryBackoffCapMs,
        assumedFromSaturation: entering,
      }))
      // T-ZEROWM-3 (6): the sweep's release evicts only a
      // document its own relaunch loaded; one that was already resident is
      // relinquished (someone else may be using it unleased).
      // T-ZEROWM-4 (2): a pass running on this handle (started during the
      // resolve) is ADOPTED as the relaunch — leased, booked above, counted
      // below, not asked again; otherwise the relaunch starts its pass.
      const run = this.adoptOrRunUnderRecoveryLease('zero-sweep', descriptor, handle, !wasResident)
      // Counted once the relaunched pass has an outcome, as the withdrawn
      // re-opening is once its transaction committed (a relaunch that started
      // no pass — the projector stopping — is no relaunch). Never rejects.
      void run?.then(() => {
        this.zeroSweepCounts.relaunched += 1
        if (backingOff) {
          this.zeroSweepCounts.backedOff += 1
          staticRecoveryBackoffRetries.zero_sweep += 1
        }
      })
    }
  }

  /** T-ZEROWM-2 (3): the sweep's relaunch of one document (`zero-sweep`) —
   * and, T-ZEROWM-3 (1), the durable recovery's re-projection of one
   * (`recovery`) — under its own residency owner
   * (`static-<kind>:<workspace>:<documentId>:<n>`, one per relaunch), taken
   * SYNCHRONOUSLY after the caller checked the handle is the Repo's, before
   * the pass starts (so before its first await), and released once NO pass of
   * the document is left — the rule of the retiring lease: in `trigger`'s
   * `finally` when the last pass settles (a pass it re-triggers keeps it),
   * whatever its outcome; at once when no pass started; on `detach`, on
   * `release(workspace)` and on `stop()`. An idle eviction meanwhile is
   * refused (`AutomergeResidencyLeases.evict`). */
  private runUnderRecoveryLease(
    kind: RecoveryLeaseKind,
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    evictOnRelease = false,
  ): Promise<void> | undefined {
    const documentId = handle.documentId
    this.takeRecoveryLease(kind, descriptor, handle, evictOnRelease)
    let run: Promise<void> | undefined
    try {
      run = this.trigger(descriptor, handle, true)
    } finally {
      if (!run && !this.passBusy(documentId)) this.releaseRecoveryLease(kind, documentId)
    }
    return run
  }

  /** The `kind` lease of `handle`'s document (none taken if it already has
   * one), synchronously; released by the rule of {@link runUnderRecoveryLease}. */
  private takeRecoveryLease(
    kind: RecoveryLeaseKind,
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    evictOnRelease: boolean,
  ): void {
    const documentId = handle.documentId
    const workspace = keyOf(descriptor)
    const leases = this.passLeases[kind]
    if (!this.residency || leases.has(documentId)) return
    const owner = `static-${kind}:${workspace}:${documentId}:${++this.passLeaseSeq}`
    const ws = `${descriptor.landscapeId}/${descriptor.versionId}`
    // An evicting owner wants the document only for its pass but evicts it
    // after (it loaded it); a transient one leaves an eviction intent of
    // another owner standing (`AutomergeResidencyLeases.relinquish`).
    if (evictOnRelease) this.residency.acquire(handle, owner, ws)
    else this.residency.acquireTransient(handle, owner, ws)
    leases.set(documentId, { owner, workspace, evictOnRelease })
  }

  /** Idempotent: drops the `kind` lease of `documentId` — only `owner`'s when
   * given (a later relaunch's is its own). A lease taken by a relaunch that
   * loaded the document itself (the sweep's, `evictOnRelease`) is RELEASED,
   * which evicts a document no other owner holds (T-ZEROWM-2 (3): a retired
   * head). Every other one is RELINQUISHED (T-ZEROWM-3): before the lease, a
   * recovered document stayed resident until the idle sweep found it idle,
   * and it still does — the recovery re-projects every owed document, diagrams
   * an in-process caller may hold unleased included. A relinquish carries out
   * an eviction another owner asked for meanwhile (the retiring lease of a
   * head a rotation left during the pass): the residency remembers it, so the
   * order of these releases does not decide residency. */
  private releaseRecoveryLease(kind: RecoveryLeaseKind, documentId: string, owner?: string): void {
    const leases = this.passLeases[kind]
    const lease = leases.get(documentId)
    if (!lease || (owner !== undefined && lease.owner !== owner)) return
    leases.delete(documentId)
    if (lease.evictOnRelease) this.residency?.release(documentId as DocumentId, lease.owner)
    else this.residency?.relinquish(documentId as DocumentId, lease.owner)
  }

  /** T-ZEROWM-3: this projector still projects `descriptor`'s document in its
   * workspace (a reload rebuilds descriptor OBJECTS every tick, so not an
   * identity check). Guards book entries decided across awaits. */
  private stillProjects(descriptor: StaticDocumentDescriptor): boolean {
    const now = this.descriptors.get(descriptor.documentId)
    return Boolean(now && keyOf(now) === keyOf(descriptor) && this.attachedWorkspaces.has(keyOf(descriptor)))
  }

  /** Both recovery leases of `documentId` (any order: see `releaseRecoveryLease`). */
  private releaseRecoveryLeases(documentId: string): void {
    for (const kind of RECOVERY_LEASE_KINDS) this.releaseRecoveryLease(kind, documentId)
  }

  /** T-ZEROWM-3 (2): documents backing off now, per path (`/metrics`). An
   * entry that entered a saturated book (`assumedFromSaturation`) IS backing
   * off — it waits the cap before its next retry — so it counts; an entry
   * still in its fast retries does not. */
  recoveryBackoffSnapshot(): { withdrawnBackingOff: number; zeroSweepBackingOff: number } {
    let withdrawnBackingOff = 0
    let zeroSweepBackingOff = 0
    for (const tracked of this.withdrawnReopens.values()) if (tracked.backingOff) withdrawnBackingOff += 1
    for (const tracked of this.zeroSweepAttempts.values()) if (tracked.backingOff) zeroSweepBackingOff += 1
    return { withdrawnBackingOff, zeroSweepBackingOff }
  }

  /** T-ZEROWM (A): the orphan-zero sweep's counts since this projector was built. */
  zeroCertificateSweepSnapshot(): {
    relaunched: number; legitimate: number; backedOff: number; withdrawn: number; withdrawnBackedOff: number
    retiringLeases: number; sweepLeases: number; recoveryLeases: number; retiringUnderRecovery: number
    overdueWatches: number
  } {
    return {
      ...this.zeroSweepCounts, withdrawn: this.withdrawnCertificates, withdrawnBackedOff: this.withdrawnBackedOff,
      retiringUnderRecovery: this.retiringUnderRecovery, overdueWatches: this.passWatchesOverdue,
      retiringLeases: this.retiringLeases.size,
      sweepLeases: this.passLeases['zero-sweep'].size, recoveryLeases: this.passLeases.recovery.size,
    }
  }

  private attach(handle: DocHandle<unknown>): void {
    if (this.stopped || handle.state !== 'ready') return
    const descriptor = this.descriptors.get(handle.documentId)
    if (!descriptor) return
    // THE fixed point, here rather than at the six callers because this is the
    // choke point every one of them reaches: `activatePublishedOverlayHead`,
    // `projectMeta`, `projectRoot`, `hydrateOverlayDocuments`,
    // `projectEffectiveOverlay` and `resolveDocumentHandle` all re-install a
    // listener and a residency lease, relying on ONE `holdsStaticPlane` taken
    // at the top of `project()` with several awaits after it. Without this, a
    // pass in flight when `release()` runs would re-take the write-head lease —
    // and `detach()` does not release leases, so the document would stay
    // UNEVICTABLE for the life of the pod.
    //
    // `attachedWorkspaces` is the single owner of the question: `release`
    // deletes the entry, and only a reload tick that saw the AUTHORITY row puts
    // it back. `reloadDescriptors` populates it before the first
    // `hydrateControlDocuments`, so boot is unaffected.
    if (!this.attachedWorkspaces.has(keyOf(descriptor))) return
    const current = this.listened.get(handle.documentId)
    if (current?.handle === handle) return
    current?.stop()
    // The root listener matters: a summary client that has to provision its
    // own registry write head (a degraded/offline boot in the client bridge)
    // publishes it by repointing `root.registryWriteUrl` and NOTHING ELSE tells
    // the server it exists — see `projectRoot`.
    const onChange = () => this.trigger(descriptor, handle)
    handle.on('change', onChange)
    this.listened.set(handle.documentId, {
      handle,
      stop: () => handle.off('change', onChange),
    })
    if (descriptor.kind === 'root' || descriptor.kind === 'model-meta') {
      const workspace = keyOf(descriptor)
      const documentType = descriptor.kind === 'root' ? 'root' : 'model-meta'
      const owner = `static-control:${workspace}:${documentType}`
      this.residency?.replaceOwner(
        handle,
        owner,
        `${descriptor.landscapeId}/${descriptor.versionId}`,
        documentType,
      )
      this.setPinnedCoreDocument?.(owner, handle.documentId)
      // Same reason ModelMeta is triggered below: a head provisioned while this
      // projector was down produces no change event, so the wiring has to be
      // re-derived from the document once at attach time as well.
      if (descriptor.kind === 'root') { this.trigger(descriptor, handle); return }
    }
    this.leaseCurrentWriteHead(descriptor, handle)
    // ModelMeta reconstructs the in-memory overlay order/current heads even
    // when its durable queue is already caught up. Data documents are replayed
    // exclusively by recoverChangedDocuments() or a live change event. Merely
    // finding a resident historical segment must not enqueue an idempotent
    // transaction for every retained head during partition takeover.
    if (descriptor.kind === 'model-meta') this.trigger(descriptor, handle)
  }

  private async triggerIfDurablyPending(
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
  ): Promise<void> {
    if (!this.ownsWorkspace(descriptor)) return
    const { rows } = await this.db.query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM read_model_static_document_queue
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3
           AND revision > projected_revision
       ) AS pending`,
      [descriptor.landscapeId, descriptor.versionId, descriptor.documentId],
    )
    if (rows[0]?.pending && this.listened.get(descriptor.documentId)?.handle === handle) {
      this.trigger(descriptor, handle)
    }
  }

  private detach(documentId: string): void {
    const listener = this.listened.get(documentId)
    listener?.stop()
    this.listened.delete(documentId)
    const run = this.docRuns.get(documentId)
    if (run?.timer) clearTimeout(run.timer)
    this.docRuns.delete(documentId)
    // A detached document has no pass coming from this projector: whatever
    // retained it for one goes (a run still in flight finds no lease to
    // release in its `finally`, which is a no-op).
    // Transient leases first, the evicting one last (by safety; see
    // `releaseRecoveryLease`).
    this.releaseRecoveryLeases(documentId)
    this.releaseRetiringHead(documentId)
  }

  /** T-DIAGDEF: the durable recovery — and, T-ZEROWM-4, the
   * orphan-zero sweep — waits for a pass of `documentId` scheduled, running,
   * or still in flight after a `detach` (its watch outlives the `docRuns`
   * entry). Read BEFORE their resolve. */
  private recoveryMustWait(documentId: string): boolean {
    return this.passBusy(documentId) || this.passWithdrawals.has(documentId)
  }

  /** T-ZEROWM-4: the same question AFTER their resolve returned `handle` (the
   * Repo's): a pass that started during the resolve is not a reason to wait
   * when it runs on `handle` — the caller takes it as its own
   * ({@link adoptOrRunUnderRecoveryLease}). It still waits for a pass in
   * flight on ANOTHER handle: one evicted since (watched, its `docRuns` entry
   * gone with the `detach`), or one RUNNING on another handle — a dead one:
   * until T-ZEROWM-4 `trigger`'s `finally` re-ran a pass on the handle it had
   * after a `detach`; it no longer does, and the handle is checked all the
   * same (one comparison; adopting such a pass would lease a handle it does
   * not read). */
  private recoveryMustWaitOn(documentId: string, handle: DocHandle<unknown>): boolean {
    const run = this.docRuns.get(documentId)
    if (run?.running) return run.handle !== handle
    return this.passWithdrawals.has(documentId)
  }

  /** T-ZEROWM-4: the pass of `handle`'s document for a recovery (`kind`) that
   * has just resolved `handle`, checked it is the Repo's, and must not wait
   * ({@link recoveryMustWaitOn}) — under the recovery's lease, taken
   * synchronously (no await since the caller's check). A pass RUNNING on
   * `handle` started during the resolve (the 4 Hz scan attaches its listener
   * to the handle being loaded, and the load's own change event starts it;
   * or `attach` itself, for a ModelMeta): it IS the recovery's pass — leased,
   * and NOT asked again (`trigger` would mark it `pending`, and its `finally`
   * would re-run it at once, past any backoff its withdrawal sets: the
   * busy-document skip of `recoverChangedDocuments`). Otherwise the pass starts now, under the lease (a
   * coalescing timer armed meanwhile is replaced, `trigger`). The pass's
   * promise (never rejects), or undefined when none started. */
  private adoptOrRunUnderRecoveryLease(
    kind: RecoveryLeaseKind,
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    evictOnRelease = false,
  ): Promise<void> | undefined {
    const run = this.docRuns.get(handle.documentId)
    if (run?.running && run.handle === handle) {
      this.takeRecoveryLease(kind, descriptor, handle, evictOnRelease)
      return run.run
    }
    return this.runUnderRecoveryLease(kind, descriptor, handle, evictOnRelease)
  }

  /** T-ZEROWM-4: the Repo holds `handle` for its document now — ready or
   * still loading (`query.handle`; `peek()` names a handle only once it is
   * ready). A handle it dropped (an eviction, a removal without
   * announcement) is dead: changes on it are saved by nobody, and a pass on
   * it reads a stale document. */
  private repoHolds(handle: DocHandle<unknown>): boolean {
    return this.repo.synchronizer.docSynchronizers[handle.documentId]?.query.handle === handle
  }

  /** T-ZEROWM-4 (1): the recovery lease for a pass of `handle`'s document
   * running on `handle`, or armed to run on it (a coalescing timer) — none
   * started here. */
  private leasePassStartedOn(handle: DocHandle<unknown>): void {
    const run = this.docRuns.get(handle.documentId)
    const descriptor = this.descriptors.get(handle.documentId)
    if (!descriptor || !run || !(run.running || run.timer) || run.handle !== handle) return
    this.takeRecoveryLease('recovery', descriptor, handle, false)
  }

  /** T-ZEROWM (A): a pass of `documentId` is running, re-requested, or
   * scheduled (`trigger`'s three states). */
  private passBusy(documentId: string): boolean {
    const run = this.docRuns.get(documentId)
    return Boolean(run && (run.running || run.pending || run.timer))
  }

  /** T-ZEROWM-4: every pass watch past `passWatchCeilingMs` — not one
   * still waiting for an earlier pass of its document — logged
   * (`read_model.static_pass_watch_overdue`) and counted ONCE each. Read by
   * its own timer (`watchTimer`, every `passWatchCheckMs`), armed at the
   * start of `start()`: NOT by the reload chain, which a zombie holding a
   * workspace tail parks (it awaits the tails), nor by the 4 Hz scan, armed
   * only once `start()`'s awaits are over. The watch is NOT dropped: see
   * `passWatchCeilingMs`. */
  private notePassWatchesOverdue(now = Date.now()): void {
    for (const [documentId, watches] of this.passWithdrawals) {
      for (const watch of watches) {
        if (watch.waiting || watch.overdue || now - watch.startedAt < this.passWatchCeilingMs) continue
        watch.overdue = true
        this.passWatchesOverdue += 1
        staticPassWatchesOverdue += 1
        const descriptor = this.descriptors.get(documentId)
        const run = this.docRuns.get(documentId)
        console.warn(JSON.stringify({
          event: 'read_model.static_pass_watch_overdue',
          workspace: descriptor ? `${descriptor.landscapeId}/${descriptor.versionId}` : null,
          documentId,
          kind: descriptor?.kind ?? null,
          ageMs: now - watch.startedAt,
          ceilingMs: this.passWatchCeilingMs,
          // Evicted under it (the zombie case), and whether `trigger` still
          // knows of a pass of the document (a `detach` forgets it).
          withdrawn: watch.withdrawn,
          tracked: Boolean(run?.running),
        }))
      }
    }
  }

  /** T-ZEROWM-4: the watches in flight past their ceiling (`/metrics`). */
  passWatchSnapshot(now = Date.now()): { overdueWatchesInFlight: number } {
    let overdueWatchesInFlight = 0
    for (const watches of this.passWithdrawals.values()) {
      for (const watch of watches) if (!watch.waiting && now - watch.startedAt >= this.passWatchCeilingMs) overdueWatchesInFlight += 1
    }
    return { overdueWatchesInFlight }
  }

  /** T-ZEROWM (A): keep a head the pointer has just left resident while a pass
   * of it is in flight, under its own residency owner — acquired BEFORE the
   * caller releases or replaces the write-head owner, so the residency never
   * sees the head unleased. Synchronous: no await between the acquisition and
   * the map entry that hands it to {@link releaseRetiringHead}.
   *
   * NOT gated on `stopped`: `stop()` drains in-flight
   * rotations BEFORE releasing leases, and one activating during that drain
   * would otherwise evict the head under its pass — the original defect, at
   * shutdown. `stop()` releases every retiring lease after its drain. */
  private retainRetiringHead(descriptor: StaticDocumentDescriptor, documentId: string): void {
    if (!this.residency || this.retiringLeases.has(documentId) || !this.passBusy(documentId)) return
    // The listened handle, or else whatever handle the Repo holds for the
    // document (leases are per document id).
    const listened = this.listened.get(documentId)?.handle
    const held = this.repo.synchronizer.docSynchronizers[documentId as DocumentId]?.query.peek()
    const handle = listened?.state === 'ready' ? listened : held?.state === 'ready' ? held.handle : undefined
    if (!handle) return
    const workspace = keyOf(descriptor)
    const owner = `static-retiring:${workspace}:${documentId}`
    this.residency.acquire(handle as DocHandle<unknown>, owner, `${descriptor.landscapeId}/${descriptor.versionId}`)
    this.retiringLeases.set(documentId, { owner, workspace })
    // T-ZEROWM-3 (B1): how often a rotation retires a head
    // while the durable recovery re-projects it — the case whose eviction the
    // residency's eviction intent now carries out. Measured, not gated.
    const sweepLease = this.passLeases['zero-sweep'].get(documentId)
    if (this.passLeases.recovery.has(documentId) || (sweepLease && !sweepLease.evictOnRelease)) {
      this.retiringUnderRecovery += 1
      console.warn(JSON.stringify({
        event: 'read_model.static_retiring_under_recovery',
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
        documentId,
      }))
    }
  }

  /** Idempotent: drops the retiring lease of `documentId`, if any. The
   * residency evicts the head once no other owner holds it. */
  private releaseRetiringHead(documentId: string): void {
    const lease = this.retiringLeases.get(documentId)
    if (!lease) return
    this.retiringLeases.delete(documentId)
    this.residency?.release(documentId as DocumentId, lease.owner)
  }

  /** T-ZEROWM (B): wait — at most `stopDrainCeilingMs` — for every pass,
   * rotation, fold, repair and reload this projector has in flight. Loops,
   * because a settling task can queue another on a workspace tail (a pass's
   * publication behind a rotation); terminates because `stopped` is set and
   * nothing new starts. Never throws. True when everything settled, false
   * when the ceiling passed (logged). */
  private async drainInFlightWork(): Promise<boolean> {
    const deadline = Date.now() + this.stopDrainCeilingMs
    let seen = new Set<Promise<unknown>>()
    for (;;) {
      const pending = new Set<Promise<unknown>>([
        this.reloadTail, this.c4RepairChain, this.retiredRepairChain,
        ...this.workspaceTails.values(), ...this.inFlightRuns,
      ])
      if ([...pending].every((task) => seen.has(task))) return true
      seen = pending
      const remaining = deadline - Date.now()
      let timer: NodeJS.Timeout | undefined
      const timedOut = await Promise.race([
        Promise.allSettled([...pending]).then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), Math.max(0, remaining)) }),
      ])
      clearTimeout(timer)
      if (timedOut) {
        console.warn(JSON.stringify({
          event: 'read_model.static_stop_drain_overdue',
          ceilingMs: this.stopDrainCeilingMs,
          inFlightPasses: this.inFlightRuns.size,
          workspaces: this.workspaceTails.size,
        }))
        return false
      }
    }
  }

  private leaseCurrentWriteHead(
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
  ): void {
    if (!this.residency) return
    const workspace = keyOf(descriptor)
    const current = this.currentOverlayDocumentIds.get(workspace)
    const collection = descriptor.kind === 'object-overlay'
      ? 'object'
      : descriptor.kind === 'connection-overlay'
        ? 'connection'
        : null
    if (!collection || current?.[collection] !== handle.documentId) return
    const owner = `static-write-head:${workspace}:${collection}`
    this.residency.replaceOwner(
      handle,
      owner,
      `${descriptor.landscapeId}/${descriptor.versionId}`,
      collection === 'object' ? 'object-shard' : 'connection-shard',
    )
    // The pointer may be published before this child is hydrated into the
    // server Repo. Re-notify selective sync now that the ready handle exists;
    // otherwise shareConfigChanged() snapshots an absent document and cold
    // editors receive an immediate "unavailable" response.
    this.setPinnedCoreDocument?.(owner, handle.documentId)
  }

  private updateCurrentWriteHeadLeases(
    descriptor: StaticDocumentDescriptor,
    meta: StaticMetaLike,
  ): void {
    const workspace = keyOf(descriptor)
    const previous = this.currentOverlayDocumentIds.get(workspace) ?? {}
    const next = {
      object: meta.editsObjectShardUrl ? documentIdOf(meta.editsObjectShardUrl) : undefined,
      connection: meta.editsConnectionShardUrl ? documentIdOf(meta.editsConnectionShardUrl) : undefined,
    }
    for (const collection of ['object', 'connection'] as const) {
      if (previous[collection] === next[collection]) continue
      const owner = `static-write-head:${workspace}:${collection}`
      const nextId = next[collection]
      // T-ZEROWM (A): BEFORE the owner moves (released here, or replaced by
      // `leaseCurrentWriteHead` below): a head with a pass in flight stays
      // resident until that pass settles, so its certificate is decided
      // against the handle it sampled.
      const leavingId = previous[collection]
      if (leavingId && leavingId !== nextId) this.retainRetiringHead(descriptor, leavingId)
      // When the replacement is already resident, lease it first and retire
      // the former head atomically below. Otherwise release the obsolete head;
      // hydration will acquire the new one as soon as it becomes ready.
      if (!nextId || !this.listened.has(nextId)) this.residency?.releaseOwner(owner)
      this.setPinnedCoreDocument?.(owner, next[collection])
    }
    this.currentOverlayDocumentIds.set(workspace, next)
    for (const collection of ['object', 'connection'] as const) {
      const id = next[collection]
      const listened = id ? this.listened.get(id) : undefined
      const listenedDescriptor = id ? this.descriptors.get(id) : undefined
      if (listened && listenedDescriptor) this.leaseCurrentWriteHead(listenedDescriptor, listened.handle)
    }
  }

  /** Aggregate-only diagnostic used by residency regression tests and health tooling. */
  listenedCount(): number {
    return this.listened.size
  }

  private trigger(
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    immediate = false,
  ): Promise<void> | undefined {
    // T-ZEROWM-4: never on a handle the
    // Repo no longer holds — evicted (`detach` then forgets its entry), or
    // dropped without an announcement. A pass on it samples a stale in-memory
    // document and can acknowledge the durable revision with a refusal 0.
    // Several callers hand a handle they hold from before an await — a pass
    // asking itself to run again (`projectEffectiveOverlay`), a write head's
    // registration, a commit hook, a deferral, a listener of a dropped handle
    // — so the check is HERE, once, not at each of them; and a re-request
    // never creates or touches the entry of the document's live handle.
    if (!this.repoHolds(handle)) return undefined
    const state = this.docRuns.get(descriptor.documentId) ?? { running: false, pending: false }
    this.docRuns.set(descriptor.documentId, state)
    if (state.running) { state.pending = true; return undefined }
    /** The pass it started (never rejects), or undefined when none started. */
    const start = (): Promise<void> | undefined => {
      if (this.stopped || state.running) return undefined
      // A coalescing timer armed on a handle dropped since: nothing runs, and
      // nothing is left armed — or `passBusy` would stay true, and the leases
      // taken for this pass (an hydration's) would stay with it.
      if (!this.repoHolds(handle)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = undefined
        state.firstQueuedAt = undefined
        state.pending = false
        if (this.docRuns.get(descriptor.documentId) === state && !this.passBusy(descriptor.documentId)) {
          this.releaseRecoveryLeases(descriptor.documentId)
          this.releaseRetiringHead(descriptor.documentId)
        }
        return undefined
      }
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.firstQueuedAt = undefined
      state.running = true
      state.pending = false
      state.handle = handle
      const run = (async () => {
      try {
        await this.project(descriptor, handle)
      } catch (error) {
        // Ownership loss deliberately cancels queued/in-flight projection. A
        // final fenced flush may still reject while the lease handoff races;
        // that is an expected cancellation, not a broken projector.
        if (error instanceof StaleSyncCellWriteError || !this.ownsWorkspace(descriptor)) return
        console.error(`[read-model] static delta ${descriptor.kind} failed`, error)
      } finally {
        state.running = false
        state.run = undefined
        // `detach()` may have deleted this run's `docRuns` entry, and `state` is
        // a closure over the object it deleted. Re-entering `trigger` would
        // `set` a NEW entry for a descriptor that no longer exists: one Map
        // entry that survives to `stop()`, plus a `project()` call the plane
        // check then refuses. Reachable on every reconciliation.
        // A CONDITION, never a `return` — a `return` inside `finally` discards
        // whatever exception is propagating (eslint `no-unsafe-finally`).
        // T-ZEROWM-4: only while `state` IS the document's entry, and on
        // the handle listened NOW, when the Repo holds it — not on this pass's
        // own `handle` when that one is dead. A `detach` (an eviction) deleted
        // the entry; an `attach` of a new handle without one (a handle dropped
        // unannounced, then reloaded) swapped the listener under the same
        // entry. A re-run on the dead handle samples its in-memory document —
        // stale once the durable one moved on (another writer, the reloaded
        // handle) — then acknowledges the queue at the durable revision with a
        // refusal 0 (its sample is not the durable heads: a "true hole" no
        // sweep re-projects). Measured before the fix: stale, refused,
        // acknowledged for good. With no live listened handle the re-request
        // is DROPPED — `pending` cleared on the entry, or `passBusy` would
        // stay true for good: every recovery tick would skip the document and
        // its leases would never go. The
        // change it stood for is owed in the queue (its save bumped the queue
        // revision), so the durable recovery re-projects it on the handle it
        // resolves. (A ModelMeta or a root with no listener — after a `detach`
        // — is re-attached by the next tick's control hydration; one still
        // listened on a dead handle is not, until a live handle is attached:
        // by the scan once resident, by the recovery once owed.)
        const listened = this.listened.get(descriptor.documentId)?.handle
        const ours = this.docRuns.get(descriptor.documentId) === state
        if (this.descriptors.has(descriptor.documentId) && state.pending && !this.stopped
          && ours && listened && this.repoHolds(listened)) {
          this.trigger(descriptor, listened)
        } else if (ours) {
          state.pending = false
        }
        // T-ZEROWM (A): no pass of this document left (none re-triggered,
        // none scheduled) ⇒ a retiring lease taken for it goes, whatever this
        // pass's outcome — `finally`, so a throw cannot leak it.
        // T-ZEROWM-2 (3): the sweep's lease, by the same rule; T-ZEROWM-3
        // (1): and the durable recovery's.
        if (!this.passBusy(descriptor.documentId)) {
          this.releaseRecoveryLeases(descriptor.documentId)
          this.releaseRetiringHead(descriptor.documentId)
        }
      }
      })()
      // (Its `finally`, which clears it, comes after an await at the least.)
      state.run = run
      this.inFlightRuns.add(run)
      void run.finally(() => { this.inFlightRuns.delete(run) })
      return run
    }

    if (immediate || (descriptor.kind !== 'object-overlay' && descriptor.kind !== 'connection-overlay')) {
      return start()
    }

    // A reconnect burst can publish dozens of intermediate CRDT heads while
    // the durable queue only needs the latest revision. Trailing-edge
    // coalescing avoids repeatedly diffing/upserting obsolete snapshots; the
    // maximum delay prevents continuous traffic from starving projection.
    state.pending = true
    if (state.timer) clearTimeout(state.timer)
    const now = Date.now()
    state.firstQueuedAt ??= now
    const quietMs = OVERLAY_PROJECTION_QUIET_MS
    const maximumDelayMs = OVERLAY_PROJECTION_MAX_DELAY_MS
    const delayMs = Math.min(quietMs, Math.max(0, maximumDelayMs - (now - state.firstQueuedAt)))
    // The handle THIS timer's pass will run on (`start` closes over it).
    state.handle = handle
    state.timer = setTimeout(start, delayMs)
    state.timer.unref()
    return undefined
  }

  /**
   * ONE pass per document at a time: `trigger` (its `docRuns` entry) is the
   * only caller, and every entry point reaches it — the change listener,
   * `attach`, `recoverChangedDocuments`, `triggerIfDurablyPending`, the
   * deferral re-trigger. A second pass of the same revision therefore starts
   * after the first committed and returns at `metaSourceAlreadyProjected`,
   * publishing nothing: one ModelMeta change is ONE change event.
   *
   * Measured (G4-16f, real Postgres, a restarted projector with the
   * ModelMeta attached): three changes through the listener, three events,
   * one generation each. The "two events per change" a manual probe saw (2 and 3,
   * then 4 and 5) is reproduced only by calling `project()` directly WHILE the
   * attached listener runs its own pass of the same revision: two concurrent
   * passes, both past `metaSourceAlreadyProjected` before either commits, two
   * publishes (T-ZEROWM-4: no longer — that direct call now waits for the
   * pass in flight, see the watch below). A harness shape, not a production
   * one; pinned by staticDeltaProjector.unappliedPublish.integration 'a restart with N
   * APPLIED tombstones ...', which counts the events of a listener-driven
   * change.
   */
  private async project(descriptor: StaticDocumentDescriptor, handle: DocHandle<unknown>): Promise<void> {
    if (!this.ownsWorkspace(descriptor)) return Promise.resolve()
    // The PLANE, at the DISPATCHER. Gating only the timer-driven paths would
    // leave every CHANGE-driven path open, and two of them write the user's
    // documents before any SQL is reached: `pruneForwardedBatchIds` does
    // `handle.change` + `repo.flush` from four call sites in
    // `projectEffectiveOverlay`, and `healCurrentOverlayConflicts` reaches the
    // plane check through `transactionOnly` — which SWALLOWS the refusal and
    // returns normally, so its `handle.change` and `repo.flush` would run
    // anyway.
    //
    // One gate here covers `projectMeta`, `projectEffectiveOverlay`,
    // `projectRoot` and `projectRegistryShard` — every path a document change
    // can take. It does not replace `publish`'s own pre-check, which exists for
    // a different reason (keeping `beginReadModelProjection`'s irreversible
    // generation bump off a workspace this projector has lost) nor the
    // in-transaction assert, which is the only one that is atomic against the
    // other writer. Three lookups on a primary key, on a path that already
    // issues several queries and opens a transaction.
    // T-ZEROWM-2 (1): watched from the pass's first await to its end, so an
    // eviction in ANY of its awaits is heard — this plane check's included —
    // under this run of the projector (`life`). A SET per document: `detach` drops the `docRuns` entry, so a
    // second pass of the same document can start while the first still runs.
    let settle!: () => void
    let wake!: () => void
    const superseded = new Promise<void>((resolve) => { wake = resolve })
    const watch: PassWatch = {
      withdrawn: false, life: this.life, waiting: false, startedAt: Date.now(),
      done: new Promise<void>((resolve) => { settle = resolve }),
      supersede: () => { watch.superseded = true; wake() },
    }
    const watches = this.passWithdrawals.get(handle.documentId) ?? new Set<PassWatch>()
    // T-ZEROWM-4: ONE pass of a document at a time ACROSS a `detach` as well.
    // `detach` drops the `docRuns` entry while an evicted pass still runs, so
    // a change event on a reloaded handle starts a second pass beside it; the
    // evicted one, holding an OLDER sample, could then commit AFTER it — its
    // rows over the newer pass's (a DiagramDoc's upsert is unconditional), a
    // refusal 0 over its certificate (its sample is not the durable heads any
    // more: a "true hole" the orphan-zero sweep leaves alone), and the queue
    // acknowledged at the newer revision (`GREATEST`): stale for good
    // (measured, `zeroWatermarkRecovery` "(overlap)"). It also shared
    // `passStamps` with it — an acknowledgement could read the other pass's
    // stamp and record nothing. So a pass waits for the passes of its document
    // still in flight before its first read; its own watch is set first, so an
    // eviction meanwhile is heard, and a later pass waits for it in turn. A
    // pass that never ends keeps the next one waiting: see `passWatchCeilingMs`.
    const earlier = [...watches].map((inFlight) => inFlight.done)
    // BOUNDED: a pass still waiting whose handle was
    // evicted meanwhile (withdrawn) is superseded by this one — it ends
    // without reading anything, and lets its handle go. Safe: this pass, on
    // a handle the Repo holds, waits for everything in flight just as it did
    // and does after them what the superseded one would have (certifies, or
    // is withdrawn and re-opens the queue). So behind a zombie there is at
    // most one pass waiting on a live handle (later changes on that handle
    // fold into its entry's `pending`) plus, transiently, the evicted ones
    // until the next pass supersedes them.
    for (const inFlight of watches) if (inFlight.waiting && inFlight.withdrawn) inFlight.supersede()
    watches.add(watch)
    this.passWithdrawals.set(handle.documentId, watches)
    try {
      if (earlier.length) {
        watch.waiting = true
        await Promise.race([Promise.all(earlier), superseded])
        watch.waiting = false
        if (watch.superseded) return
        // Its own age from here: a pass waiting behind a zombie is not a
        // second zombie — the gauge and the log name the one in front.
        watch.startedAt = Date.now()
        // Its projector began to stop while it waited — during `stop()`'s
        // drain or past it (a zombie in front outliving the ceiling; or a
        // projector restarted since: another `life`) — or released the
        // workspace (`release`, a reload that dropped the document): it has
        // read nothing, and it starts nothing, not one query — the caller may
        // be ending the pools or dropping the schema (measured: a read after
        // `stop()` returned). What started it is owed in the queue; the next
        // owner, or the next boot, takes it.
        if (watch.life.leasesReleased || this.stopped || !this.stillProjects(descriptor)) return
        // Evicted while it waited, it still runs — withdrawn from its sample
        // on, and its withdrawal re-opens the queue (one failure on the book).
        // NOT skipped (weighed): the pass in front, evicted
        // too, may have read its revision after a later save and acknowledged
        // it with a refusal 0; this pass's re-opening is then what leaves the
        // document owed for the recovery.
      }
      if (!(await this.holdsStaticPlane(descriptor))) return
      await this.projectWatched(descriptor, handle, watch)
    } finally {
      watches.delete(watch)
      if (!watches.size && this.passWithdrawals.get(handle.documentId) === watches) this.passWithdrawals.delete(handle.documentId)
      settle()
    }
  }

  private async projectWatched(
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    watch: PassWatch,
  ): Promise<void> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    // Capture one immutable source revision, then flush that document before
    // reading its durable queue revision or publishing any derived rows/batch
    // acknowledgement. A takeover must never observe an acknowledged read-model
    // value whose Automerge source still existed only in the former owner's RAM.
    let phaseStartedAt = performance.now()
    // T-ZEROWM-2 (1): a handle the Repo no longer holds when the pass samples
    // it was taken away BEFORE the sample (an eviction between `trigger` and
    // here): withdrawn from the start — its certificate leaves the document
    // owed rather than refusing it with 0.
    const sampledState = this.repo.synchronizer.docSynchronizers[handle.documentId]?.query.peek()
    if (!(sampledState?.state === 'ready' && sampledState.handle === handle)) watch.withdrawn = true
    const liveDoc = handle.doc() as Record<string, unknown> | undefined
    const snapshot = plain<Record<string, unknown>>(liveDoc)
    timings.snapshotMs = performance.now() - phaseStartedAt
    if (!this.ownsWorkspace(descriptor)) return Promise.resolve()
    phaseStartedAt = performance.now()
    await this.repo.flush([handle.documentId])
    timings.flushMs = performance.now() - phaseStartedAt
    if (!this.ownsWorkspace(descriptor)) return Promise.resolve()
    // A save racing after the captured snapshot increments a newer revision and
    // remains pending; it cannot be hidden by publication of this older snapshot.
    phaseStartedAt = performance.now()
    const sourceRevision = await this.sourceRevision(descriptor)
    timings.sourceRevisionMs = performance.now() - phaseStartedAt
    if (!this.ownsWorkspace(descriptor)) return Promise.resolve()
    // T-SUM-2: the durable witness of THIS sample, prepared OUTSIDE every
    // projection transaction (`arrivalWatermark.ts`, the ordinary protocol:
    // capture wPost, drain in-flight saves, read and decode the durable
    // chunks). Its certificate is written only inside the transaction that
    // publishes or acknowledges this pass, and only when the sampled, durable
    // and current heads agree — otherwise it writes the refusal 0.
    //
    // A preparation that FAILS (a malformed chunk, a SQL blip) does not stop
    // the pass: the rows still project, and the pass simply writes no
    // certificate. That is the refusing direction — the document's previous
    // certificate is below the arrival this pass projects, so the proof stays
    // refused until a pass that can prove it — and it is said, not silent.
    phaseStartedAt = performance.now()
    const storage = this.repo.storageSubsystem
    let prepared: PreparedDocumentWatermarks | null = null
    try {
      prepared = await prepareDocumentWatermarkProofs(this.db, storage
        ? [{ documentId: handle.documentId, drainPendingSaves: () => storage.drainDocumentSaves(handle.documentId) }]
        : [], durableHeadsMemo)
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'read_model.static_watermark_proof_failed',
        kind: descriptor.kind,
        documentId: descriptor.documentId,
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    timings.watermarkProofMs = performance.now() - phaseStartedAt
    if (!this.ownsWorkspace(descriptor)) return Promise.resolve()
    const stamp = prepared ? {
      revision: sourceRevision,
      sampledHeads: automergeHeadsOrNull(liveDoc),
      readCurrentHeads: () => {
        // Refuse a handle replaced or removed since the sample, as the
        // ordinary shard stamp does (`projectorService.ts`).
        const state = this.repo.synchronizer.docSynchronizers[handle.documentId]?.query.peek()
        return state?.state === 'ready' && state.handle === handle ? automergeHeadsOrNull(handle.doc()) : null
      },
      prepared,
      headWithdrawn: () => watch.withdrawn || watch.life.leasesReleased,
    } : null
    if (stamp) this.passStamps.set(descriptor.documentId, stamp)
    try {
      await this.dispatchProjection(descriptor, handle, liveDoc, snapshot, sourceRevision, timings)
    } finally {
      // Only THIS pass's stamp (a second pass of the same document, after a
      // `detach`, must keep its own).
      if (stamp && this.passStamps.get(descriptor.documentId) === stamp) this.passStamps.delete(descriptor.documentId)
    }
    const durationMs = performance.now() - startedAt
    if (durationMs >= 50) console.warn(JSON.stringify({
      event: 'read_model.static_projection_slow',
      kind: descriptor.kind,
      documentId: descriptor.documentId,
      durationMs: Math.round(durationMs * 100) / 100,
      timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [
        key, Math.round(value * 100) / 100,
      ])),
    }))
  }

  private async dispatchProjection(
    descriptor: StaticDocumentDescriptor,
    handle: DocHandle<unknown>,
    liveDoc: Record<string, unknown> | undefined,
    snapshot: Record<string, unknown>,
    sourceRevision: number,
    timings: Record<string, number>,
  ): Promise<void> {
    let phaseStartedAt = performance.now()
    let result: Promise<void>
    if (descriptor.kind === 'object-overlay') {
      const conflicts = collectAutomergeEntityConflicts(
        liveDoc?.objects as Record<string, unknown> | undefined,
      )
      timings.conflictsMs = performance.now() - phaseStartedAt
      phaseStartedAt = performance.now()
      result = this.projectEffectiveOverlay(
        descriptor, 'object', snapshot as ObjectOverlayLike, sourceRevision,
        conflicts, handle, automergeHeadsOrNull(liveDoc),
      )
    } else if (descriptor.kind === 'connection-overlay') {
      const conflicts = collectAutomergeEntityConflicts(
        liveDoc?.connections as Record<string, unknown> | undefined,
      )
      timings.conflictsMs = performance.now() - phaseStartedAt
      phaseStartedAt = performance.now()
      result = this.projectEffectiveOverlay(
        descriptor, 'connection', snapshot as ConnectionOverlayLike, sourceRevision,
        conflicts, handle, automergeHeadsOrNull(liveDoc),
      )
    } else if (descriptor.kind === 'model-meta') {
      // The URL fields as their ruling values, plain strings.
      result = this.projectMeta(descriptor, withMetaUrlView(snapshot) as StaticMetaLike, sourceRevision)
    } else if (descriptor.kind === 'diagram' && descriptor.entityId) {
      result = this.projectDiagram(descriptor, snapshot as StaticDiagramLike, sourceRevision)
    } else if (descriptor.kind === 'registry-shard') {
      result = this.projectRegistryShard(descriptor, snapshot as RegistryShardLike, sourceRevision)
    } else if (descriptor.kind === 'root') {
      result = this.projectRoot(descriptor, snapshot as StaticRootLike)
        .then(() => this.stampRootPass(descriptor))
    } else {
      result = Promise.resolve()
    }
    await result
    timings.projectionMs = performance.now() - phaseStartedAt
  }

  /** The certificate of THIS pass, inside the caller's transaction — the one
   * that moves the document's queue row to `revision` (`publish`,
   * `acknowledgeOnly`). Nothing outside that transaction may write it: a
   * certificate committed before the rows it vouches for would prove an
   * absence the read model does not yet show. */
  private async recordPassWatermark(
    tx: Queryable,
    descriptor: StaticDocumentDescriptor,
    revision: number,
  ): Promise<void> {
    // T-ZEROWM-4: this transaction acknowledges `revision` — said,
    // once committed, to the recovery tick in progress (`acknowledgedThisTick`).
    this.onCommit(tx, () => this.noteAcknowledged(descriptor.documentId, revision))
    const stamp = this.passStamps.get(descriptor.documentId)
    if (!stamp || stamp.revision !== revision) return
    const outcome = await recordSampledDocumentWatermark(
      tx, descriptor, descriptor.documentId, stamp.sampledHeads, stamp.readCurrentHeads, stamp.prepared, stamp.headWithdrawn,
    )
    const documentId = descriptor.documentId
    if (outcome !== 'withdrawn') {
      // Applied once this transaction COMMITTED (`afterCommit`): a pass that
      // rolls back resets no count.
      this.onCommit(tx, () => {
        const healed = this.withdrawnReopens.get(documentId)
        this.withdrawnReopens.delete(documentId)
        // T-ZEROWM-3 (2): a pass that CERTIFIES the document heals the orphan-zero sweep's entry too
        // (left there, it kept a healed document in the gauge for good, kept
        // the book saturated, and made a later orphan skip its first steps).
        const swept = outcome === 'certified' ? this.zeroSweepAttempts.get(documentId) : undefined
        if (swept) this.zeroSweepAttempts.delete(documentId)
        if (healed?.backingOff || swept?.backingOff) console.warn(JSON.stringify({
          event: 'read_model.static_recovery_backoff_healed',
          workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
          documentId,
          kind: descriptor.kind,
          path: healed?.backingOff ? 'withdrawn_reopen' : 'zero_sweep',
          failures: healed?.backingOff ? healed.reopens : swept!.attempts,
          outcome,
        }))
      })
      return
    }
    // NEVER ABANDONED (T-ZEROWM-3 (2), owner's decision of 2026-11-24; until
    // then the document was left refused after WITHDRAWN_REOPEN_LIMIT
    // re-openings, until the next boot). The first `withdrawnReopenLimit`
    // re-openings are read at the next reload tick; beyond them,
    // `recoverChangedDocuments` leaves the re-opened revision alone for a
    // doubling backoff capped at `recoveryBackoffCapMs`, counted, and logged
    // once per backoff step. Never a 0 instead (T-ZEROWM-2's invariant): the
    // queue is re-opened below on EVERY withdrawal.
    //
    // ONLY `recoverChangedDocuments` honours that backoff:
    // a live change event, `triggerIfDurablyPending` (a document a third
    // party reloads) or the ModelMeta's re-run of deferred overlays still run
    // the document's pass at once. Defence in depth, not a gate: those are
    // real reasons to project, and a pass they run either certifies the
    // document (and heals the book) or is withdrawn and counted like any.
    this.noteWithdrawnCertificate(descriptor, outcome)
    // T-ZEROWM-2 (1): the row is kept, and its watermark is below the arrival this pass projected
    // (`exact_low`) — a refusal the orphan-zero sweep does not read (it reads
    // 0s), on a document nothing may write again (a retired head, an idle
    // diagram). So the document is left OWED, in this same transaction: its
    // queue row re-opened one revision past what this pass acknowledged, and
    // `recoverChangedDocuments` (every reload tick, and the next boot)
    // re-projects it with a fresh handle, whose pass certifies it. A queue
    // already ahead (a newer save pending) is left as it is: it is owed.
    // `enqueued_at` moves with it: the backlog ages, fsck's
    // quiescence and the lag metrics read it.
    // T-ZEROWM-3 (2): the revision it wrote is the one the backoff holds back
    // (none when the queue was already ahead: that newer save is read at once).
    const { rows: reopened } = await tx.query<{ revision: string }>(
      `UPDATE read_model_static_document_queue
          SET revision = projected_revision + 1, enqueued_at = now()
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3
          AND revision <= projected_revision
        RETURNING revision::text AS revision`,
      [descriptor.landscapeId, descriptor.versionId, descriptor.documentId],
    )
    const reopenedRevision = reopened[0]?.revision ?? null
    // The book, the counts and the step log once this transaction COMMITTED:
    // a rolled-back re-opening must not hold back a revision it never wrote — the next real save would take that very number.
    this.onCommit(tx, () => {
      // No entry for a document this projector stopped projecting meanwhile.
      if (!this.stillProjects(descriptor)) return
      const known = this.withdrawnReopens.get(documentId)
      // A document the book does not know while it is saturated may be one it
      // dropped while backing off: it enters at the cap (`staticRetryDecision`).
      // "Beyond 5" (aligned on the sweep): re-openings 1 to
      // `withdrawnReopenLimit` at the next tick, the backoff from the next one.
      const { count: reopens, backoffMs, backingOff, entering } = staticRetryDecision(
        known?.reopens, this.withdrawnReopens.saturated, {
          backoffFrom: this.withdrawnReopenLimit + 1, loggedFrom: this.withdrawnReopenLimit + 1,
          firstMs: this.withdrawnFirstBackoffMs, capMs: this.recoveryBackoffCapMs,
        })
      const logStep = backingOff && known?.loggedBackoffMs !== backoffMs
      this.withdrawnReopens.set(documentId, {
        reopens, nextAt: Date.now() + backoffMs, revision: reopenedRevision, backingOff,
        loggedBackoffMs: logStep ? backoffMs : known?.loggedBackoffMs,
        workspace: keyOf(descriptor),
      })
      if (backingOff) {
        this.withdrawnBackedOff += 1
        staticRecoveryBackoffRetries.withdrawn_reopen += 1
      }
      if (logStep) console.warn(JSON.stringify({
        event: 'read_model.static_withdrawn_reopen_backoff',
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
        documentId,
        kind: descriptor.kind,
        reopens,
        backoffMs,
        capped: backoffMs >= this.recoveryBackoffCapMs,
        assumedFromSaturation: entering,
      }))
    })
  }

  /** T-ZEROWM-3 (2): run `update` once the transaction of `tx` committed
   * ({@link afterCommit}); dropped with it when it rolls back. A `tx` of no
   * registered transaction (none today) applies it at once. */
  private onCommit(tx: Queryable, update: () => void): void {
    const updates = this.afterCommit.get(tx)
    if (updates) updates.push(update)
    else update()
  }

  /** Unregister a finished transaction's list from its pooled client — only
   * if the entry is still that list (the client may already serve another). */
  private forgetBookTx(tx: Queryable | undefined, updates: Array<() => void>): void {
    if (tx && this.afterCommit.get(tx) === updates) this.afterCommit.delete(tx)
  }

  /** The updates of a transaction that just committed. Never throws: a book
   * update is bookkeeping, not the commit. */
  private runAfterCommit(updates: Array<() => void>): void {
    for (const update of updates.splice(0)) {
      try {
        update()
      } catch (error) {
        console.error('[read-model] static recovery bookkeeping failed', error)
      }
    }
  }

  /** T-ZEROWM-2 (1): a certificate left as it was because the pass's head was
   * withdrawn under it — counted and said (it commits with the pass, or rolls
   * back with it; the count is of decisions). */
  private noteWithdrawnCertificate(descriptor: StaticDocumentDescriptor, outcome: 'certified' | 'refused' | 'withdrawn'): void {
    if (outcome !== 'withdrawn') return
    this.withdrawnCertificates += 1
    console.warn(JSON.stringify({
      event: 'read_model.static_certificate_withdrawn_head',
      workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
      documentId: descriptor.documentId,
      kind: descriptor.kind,
      // `stopped`, not "leases released": true from the start of `stop()`.
      stopping: this.stopped,
    }))
  }

  /** The root has no queue row (`READ_MODEL_QUEUE_DOCUMENT_KINDS`), and every
   * outcome of `projectRoot` is complete for the revision it read — the write
   * head registered, already known or deliberately preserved — so its pass
   * stamps in a transaction of its own once `projectRoot` returns. A pass
   * that THROWS stamps nothing. Every root change triggers a pass (`attach`
   * installs the listener and triggers once at attach time). */
  private async stampRootPass(descriptor: StaticDocumentDescriptor): Promise<void> {
    const stamp = this.passStamps.get(descriptor.documentId)
    if (!stamp) return
    // T-ZEROWM-2 (1): a WITHDRAWN root pass re-opens nothing (no queue row):
    // the root is leased while this projector lives, so only `stop()` can
    // withdraw it, and every next `attach` triggers a root pass that stamps.
    await this.transactionOnly(descriptor, async (tx) => this.noteWithdrawnCertificate(descriptor, await recordSampledDocumentWatermark(
      tx, descriptor, descriptor.documentId, stamp.sampledHeads, stamp.readCurrentHeads, stamp.prepared, stamp.headWithdrawn,
    )))
  }

  private async sourceRevision(descriptor: StaticDocumentDescriptor): Promise<number> {
    const { rows } = await this.db.query<{ revision: string | number }>(
      `SELECT revision FROM read_model_static_document_queue
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [descriptor.landscapeId, descriptor.versionId, descriptor.documentId],
    )
    return Math.max(0, Number(rows[0]?.revision ?? 0))
  }

  private async projectMeta(
    descriptor: StaticDocumentDescriptor,
    meta: StaticMetaLike,
    sourceRevision: number,
  ): Promise<void> {
    const startedAt = performance.now()
    let phaseStartedAt = startedAt
    const phaseTimings: Record<string, number> = {}
    this.setPinnedCoreDocument?.(
      `static-control:${keyOf(descriptor)}:model-meta`,
      descriptor.documentId,
    )
    this.updateCurrentWriteHeadLeases(descriptor, meta)
    const previousOverlayState = this.overlayState.get(keyOf(descriptor))
    const objectOverlayUrls = canonicalOverlayDocumentIds(
      unique(meta.editsObjectShardUrls ?? []),
      meta.editsObjectShardUrl,
    )
    const connectionOverlayUrls = canonicalOverlayDocumentIds(
      unique(meta.editsConnectionShardUrls ?? []),
      meta.editsConnectionShardUrl,
    )
    const documents = [
      ...objectOverlayUrls.map((url) => ({ documentId: documentIdOf(url), kind: 'object-overlay' })),
      ...connectionOverlayUrls.map((url) => ({ documentId: documentIdOf(url), kind: 'connection-overlay' })),
    ]
    const nextObjectDocumentIds = objectOverlayUrls.map(documentIdOf)
    const nextConnectionDocumentIds = connectionOverlayUrls.map(documentIdOf)
    const sameTombstones = (left: ReadonlySet<string> | undefined, right: readonly string[]) =>
      Boolean(left && left.size === right.length && right.every((id) => left.has(id)))
    const nextDeletedObjectIds = unique(meta.deletedObjectIds ?? [])
    const nextDeletedConnectionIds = unique(meta.deletedConnectionIds ?? [])
    const nextDeletedDiagramIds = unique(meta.deletedDiagramIds ?? [])
    const semanticFingerprint = JSON.stringify({
      groups: meta.groups ?? {},
      deletedObjectIds: nextDeletedObjectIds,
      deletedConnectionIds: nextDeletedConnectionIds,
      // Required, or the tombstone is "written but never read": leave this
      // out and `metadataUnchanged` short-circuits below, so a ModelMeta whose
      // ONLY change is a diagram tombstone returns without projecting anything
      // at all. The tombstone would be perfectly durable and perfectly inert.
      deletedDiagramIds: nextDeletedDiagramIds,
      decisionRecords: meta.decisionRecords ?? {},
      deletedDecisionRecordIds: unique(meta.deletedDecisionRecordIds ?? []),
    })
    const previousSemanticFingerprint = this.metaSemanticFingerprints.get(keyOf(descriptor))
    const previousObjectStateComplete = Boolean(previousOverlayState?.objectDocumentIds.every(
      (documentId) => previousOverlayState.objectSegments.has(documentId),
    ))
    const previousConnectionStateComplete = Boolean(previousOverlayState?.connectionDocumentIds.every(
      (documentId) => previousOverlayState.connectionSegments.has(documentId),
    ))
    const preserveObjectState = previousObjectStateComplete
      && isAppendOnlyOverlayOrder(previousOverlayState?.objectDocumentIds, nextObjectDocumentIds)
      && sameTombstones(previousOverlayState?.deletedObjectIds, nextDeletedObjectIds)
    const preserveConnectionState = previousConnectionStateComplete
      && isAppendOnlyOverlayOrder(previousOverlayState?.connectionDocumentIds, nextConnectionDocumentIds)
      && sameTombstones(previousOverlayState?.deletedConnectionIds, nextDeletedConnectionIds)
    const restoredObjectSegments = preserveObjectState
      ? previousOverlayState!.objectSegments
      : await overlaySegmentSnapshots(
        this.db, descriptor, 'object', nextObjectDocumentIds,
      ) as Map<string, Record<string, ObjectInput>>
    const restoredConnectionSegments = preserveConnectionState
      ? previousOverlayState!.connectionSegments
      : await overlaySegmentSnapshots(
        this.db, descriptor, 'connection', nextConnectionDocumentIds,
      ) as Map<string, Record<string, ConnectionInput>>
    phaseTimings.restoreStateMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    const deletedObjectSet = new Set(nextDeletedObjectIds)
    const deletedConnectionSet = new Set(nextDeletedConnectionIds)
    // An unseeded baseline stays unseeded (`undefined`): the publish seeds it
    // from the rows. Never `new Set()` — that is the replay-everything value.
    const stillTombstoned = (applied: ReadonlySet<string> | undefined, fact: ReadonlySet<string>) =>
      applied ? new Set([...applied].filter((id) => fact.has(id))) : undefined
    this.overlayState.set(keyOf(descriptor), {
      objectDocumentIds: nextObjectDocumentIds,
      connectionDocumentIds: nextConnectionDocumentIds,
      deletedObjectIds: deletedObjectSet,
      deletedConnectionIds: deletedConnectionSet,
      // CARRIED, never taken from this meta: this install precedes three
      // awaits and the publish, any of which can end the pass having applied
      // nothing. They advance after the commit, below.
      appliedDeletedObjectIds: stillTombstoned(previousOverlayState?.appliedDeletedObjectIds, deletedObjectSet),
      appliedDeletedConnectionIds: stillTombstoned(previousOverlayState?.appliedDeletedConnectionIds, deletedConnectionSet),
      // NOT `nextDeletedDiagramIds`. This map is written BEFORE the
      // `sourceAlreadyProjected || metadataUnchanged` short circuit below, and
      // that branch returns having applied NOTHING — so advancing the baseline
      // here would mark tombstones as projected that no `deleteDiagrams` ever
      // ran for, and `newlyDeletedDiagramIds` would be empty for them FOR EVER:
      // the client hides the cards, the server keeps serving them, and only
      // `fsck diagram-tombstone-honoured` can see it.
      //
      // The baseline advances after the publish instead (below), which makes
      // the next projection of a CHANGED meta pick the missed ids up. Replay is
      // safe by construction: `deleteDiagrams` returns the REAL row count and
      // the counter is adjusted by that, so re-deleting an applied id costs
      // zero rows and zero drift.
      //
      // `appliedDeletedObjectIds` / `appliedDeletedConnectionIds` above follow
      // the same rule (G4-16f C7).
      deletedDiagramIds: new Set(previousOverlayState?.deletedDiagramIds ?? []),
      // The OPPOSITE decision from the line above, on purpose.
      // This one carries no application semantics — nothing reads it to decide
      // what still has to be deleted — so writing it before the short circuit
      // cannot mark anything as done. What it does carry is the ModelMeta FACT,
      // and the registry-shard projection needs that fact even on the pass that
      // returns early, because `metaSourceAlreadyProjected` is true for every
      // untouched ModelMeta after a restart.
      metaDeletedDiagramIds: new Set(nextDeletedDiagramIds),
      objectSegments: restoredObjectSegments,
      connectionSegments: restoredConnectionSegments,
      effectiveObjects: preserveObjectState
        ? previousOverlayState!.effectiveObjects
        : effectiveOverlayState(nextObjectDocumentIds, restoredObjectSegments, deletedObjectSet),
      effectiveConnections: preserveConnectionState
        ? previousOverlayState!.effectiveConnections
        : effectiveOverlayState(nextConnectionDocumentIds, restoredConnectionSegments, deletedConnectionSet),
    })
    // The fact just installed may differ from the last APPLIED ModelMeta's,
    // and the overlay passes act on it from now on (an un-tombstoned id is
    // served again). So the witness `metadataUnchanged` compares against is
    // withdrawn until this pass applies or short-circuits: should it end
    // having applied nothing, a later revision whose content equals the last
    // applied one must still publish (its tombstones may need re-applying),
    // not be acknowledged on a fingerprint that no longer describes the rows.
    // `previousSemanticFingerprint` was read above, so this pass is unchanged.
    this.metaSemanticFingerprints.delete(keyOf(descriptor))
    this.retriggerOverlaysAwaitingMeta(keyOf(descriptor))
    // Descriptors come from the same durable allow-list maintained by overlay
    // admission. Re-register only references that ModelMeta introduced since
    // the last descriptor refresh. Rewriting hundreds of already-known
    // historical rows on every pointer change contended with interactive sync
    // writes and made a five-object projection take seconds.
    const newlyReferencedDocuments = documents.filter((document) => {
      const known = this.descriptors.get(document.documentId)
      return !known || keyOf(known) !== keyOf(descriptor) || known.kind !== document.kind
    })
    await registerStaticReadModelDocuments(this.db, descriptor, newlyReferencedDocuments)
    phaseTimings.registerDocumentsMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    for (const document of documents) {
      this.descriptors.set(document.documentId, { ...descriptor, ...document, entityId: null })
    }
    this.scanResidentHandles()

    const previousDocumentIds = new Set([
      ...(previousOverlayState?.objectDocumentIds ?? []),
      ...(previousOverlayState?.connectionDocumentIds ?? []),
    ])
    const documentsToHydrate = documents.filter((document) => {
      if (document.kind === 'object-overlay') {
        return !restoredObjectSegments.has(document.documentId)
          && (!previousDocumentIds.has(document.documentId) || !preserveObjectState)
      }
      return !restoredConnectionSegments.has(document.documentId)
        && (!previousDocumentIds.has(document.documentId) || !preserveConnectionState)
    })
    const sourceAlreadyProjected = await this.metaSourceAlreadyProjected(descriptor, sourceRevision)
    const metadataUnchanged = previousSemanticFingerprint === semanticFingerprint
    if (sourceAlreadyProjected || metadataUnchanged) {
      if (!sourceAlreadyProjected) {
        await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
          await synchronizeOverlayHead(
            tx, descriptor, 'object', meta.editsObjectShardUrl,
          )
          await synchronizeOverlayHead(
            tx, descriptor, 'connection', meta.editsConnectionShardUrl,
          )
        })
      }
      phaseTimings.publishMs = performance.now() - phaseStartedAt
      phaseStartedAt = performance.now()
      await this.hydrateOverlayDocuments(documentsToHydrate)
      phaseTimings.hydrateMs = performance.now() - phaseStartedAt
      this.metaSemanticFingerprints.set(keyOf(descriptor), semanticFingerprint)
      const durationMs = performance.now() - startedAt
      if (durationMs >= 50) console.warn(JSON.stringify({
        event: 'read_model.static_meta_phases_slow',
        documentId: descriptor.documentId,
        durationMs: Math.round(durationMs * 100) / 100,
        objectSegments: nextObjectDocumentIds.length,
        connectionSegments: nextConnectionDocumentIds.length,
        preserveObjectState,
        preserveConnectionState,
        sourceAlreadyProjected,
        metadataUnchanged,
        timings: Object.fromEntries(Object.entries(phaseTimings).map(([key, value]) => [
          key, Math.round(value * 100) / 100,
        ])),
      }))
      return
    }

    // One inner id under two map keys: the last occurrence kept, as the
    // ordinary ModelMeta pass does (`lastOccurrenceById`) — raw, two copies in
    // one `upsertGroups` chunk raise 21000 on every ModelMeta change.
    const { kept: groups, dropped: droppedGroups } = lastOccurrenceById('group', Object.values(meta.groups ?? {}))
    const previousGroups = await this.db.query<{ id: string }>(
      `SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2`,
      [descriptor.landscapeId, descriptor.versionId],
    )
    phaseTimings.loadGroupsMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    const groupIds = new Set(groups.map((group) => group.id))
    const deletedGroupIds = previousGroups.rows.map((row) => row.id).filter((id) => !groupIds.has(id))
    // Against the APPLIED baseline, never the previous pass's FACT: a pass
    // that installed its fact and then applied nothing (refused, or thrown at
    // any await before or inside the publish) must not make its tombstones
    // look done. Only what was not applied is replayed. Computed INSIDE the
    // publish's transaction, by the change planner below, because an
    // unseeded baseline is seeded from the rows (`unappliedTombstones`), and
    // the change payload (its `deleteIds`, and whether it is a `reset all`)
    // depends on the result.
    let newlyDeletedObjectIds: string[] = []
    let newlyDeletedConnectionIds: string[] = []
    // The DELTA, not the list. `deleteDiagrams` is idempotent on the ro_* rows,
    // but `adjustWorkspaceCount` is a running counter — replaying the full list
    // on every projection would walk the footer total down to zero and clamp
    // there, permanently lying about a workspace nothing was wrong with.
    const newlyDeletedDiagramIds = nextDeletedDiagramIds.filter((id) => !previousOverlayState?.deletedDiagramIds.has(id))
    const decisions = Object.values(meta.decisionRecords ?? {})
    const deletedDecisionIds = unique(meta.deletedDecisionRecordIds ?? [])
    const objectUpsertIds = groups.map((group) => group.id)
    // WHERE the seed is read, and why there: under the projection mutex, in
    // the transaction that deletes, after every earlier publish of this
    // workspace (`workspaceTails`). The mutex is PER WORKSPACE
    // (`pg_advisory_xact_lock(hashtextextended(projectionMutexKey(key), 0))`):
    // the seed SELECT delays only this workspace's other publishes, never
    // another workspace's. Read on the pool before `publish`, an
    // overlay publish queued ahead of this one (a self-only state's, whose
    // fact holds no tombstone) could still commit a row for a tombstoned id
    // between the read and this commit; the id would be taken as applied and
    // the row would stay. Under the mutex no static writer commits in between.
    // Reads only, on tables this transaction then writes: no new lock, no new
    // lock ORDER (the mutex is still taken first, as by every publish).
    const planChange = async (tx: Queryable): Promise<ReadModelChangePayload> => {
      newlyDeletedObjectIds = await unappliedTombstones(
        tx, descriptor, 'ro_objects', nextDeletedObjectIds, previousOverlayState?.appliedDeletedObjectIds,
      )
      newlyDeletedConnectionIds = await unappliedTombstones(
        tx, descriptor, 'ro_connections', nextDeletedConnectionIds, previousOverlayState?.appliedDeletedConnectionIds,
      )
      const objectDeleteIds = [...newlyDeletedObjectIds, ...deletedGroupIds]
      const hasObjectChanges = objectUpsertIds.length > 0 || objectDeleteIds.length > 0
      return hasObjectChanges && newlyDeletedConnectionIds.length
        ? { kind: 'reset', scope: 'all' }
        : hasObjectChanges
          ? { kind: 'objects', upsertIds: objectUpsertIds, deleteIds: objectDeleteIds }
          : newlyDeletedConnectionIds.length
            ? { kind: 'connections', upsertIds: [], deleteIds: newlyDeletedConnectionIds }
            : { kind: 'reset', scope: 'groups' }
    }
    // `false` and a throw are the same fact here: nothing this ModelMeta
    // carries reached the rows, and the queue row stays pending, so the next
    // tick re-projects it. Nothing to undo: every baseline below advances
    // only on `true`, and a seed read by a transaction that rolled back is
    // simply read again by the retry.
    const metaApplied = await this.publish(descriptor, 'metadata', planChange, async (tx, generation) => {
      await synchronizeOverlaySegments(
        tx, descriptor, 'object', objectOverlayUrls, meta.editsObjectShardUrl,
      )
      await synchronizeOverlaySegments(
        tx, descriptor, 'connection', connectionOverlayUrls, meta.editsConnectionShardUrl,
      )
      await captureSparseDraftEntityBases(
        tx, descriptor, 'group', [...groups.map((group) => group.id), ...deletedGroupIds],
      )
      await captureSparseDraftEntityBases(tx, descriptor, 'object', newlyDeletedObjectIds)
      await captureSparseDraftEntityBases(tx, descriptor, 'connection', newlyDeletedConnectionIds)
      // Before the delete, always: an active sparse child captures the parent's
      // OLD value once. Skip it and a child draft loses the base entity it
      // needs to render, and to compute its merge diff against.
      await captureSparseDraftEntityBases(tx, descriptor, 'diagram', newlyDeletedDiagramIds)
      await captureSparseDraftEntityBases(
        tx, descriptor, 'decision_record', [...Object.keys(meta.decisionRecords ?? {}), ...deletedDecisionIds],
      )
      // MUST run before the membership rows go, or the affected diagrams stop
      // being discoverable through them. The explicit `diagramIds` arm is for
      // tombstoned diagrams: without it `diagramRenderRedisCache` keeps serving a cached render of a
      // diagram that no longer exists.
      await bumpDiagramRenderGenerations(tx, descriptor, generation, {
        diagramIds: newlyDeletedDiagramIds,
        groupIds: [...groups.map((group) => group.id), ...deletedGroupIds],
        objectIds: newlyDeletedObjectIds,
        connectionIds: newlyDeletedConnectionIds,
      })
      await upsertGroups(tx, descriptor, descriptor.orgId, groups)
      await deleteGroups(tx, descriptor, deletedGroupIds)
      await deleteObjects(tx, descriptor, newlyDeletedObjectIds)
      await deleteConnections(tx, descriptor, newlyDeletedConnectionIds)
      // Diagram tombstones: six tables (no ON DELETE CASCADE exists anywhere in this schema)
      // plus the summaries purge, then the counter by the REAL number of rows
      // removed rather than by the size of the input.
      const removedDiagrams = await deleteDiagrams(tx, descriptor, newlyDeletedDiagramIds)
      await adjustWorkspaceCount(tx, descriptor, descriptor.orgId, 'diagram_count', -removedDiagrams)
      // T-DIAGDEF: a LIFTED tombstone (a re-created id) re-opens
      // its DiagramDoc — its passes were refused while the id was tombstoned,
      // and nothing else re-creates the row of a baseline diagram. Known only
      // against this process's previous fact (a lift across a restart waits
      // for the DiagramDoc's next save).
      const nextDeletedDiagramSet = new Set(nextDeletedDiagramIds)
      const liftedDiagramIds = [...(previousOverlayState?.metaDeletedDiagramIds ?? [])]
        .filter((id) => !nextDeletedDiagramSet.has(id))
      await this.reopenDiagramDocuments(tx, descriptor, liftedDiagramIds)
      // The same, DURABLY — by SQL, from no memory. No longer on EVERY
      // ModelMeta pass (a walk of every
      // DiagramDoc under the mutex) — only on a pass that LIFTS a tombstone;
      // the restart and the failed-publish cases are the repair tick's
      // (`repairRetiredDiagramRowsOf`, its pool-side read first).
      if (liftedDiagramIds.length) await this.reopenUnprojectedDiagramDocuments(tx, descriptor, nextDeletedDiagramIds)

      await upsertDecisionRecords(tx, descriptor, descriptor.orgId, decisions)
      await deleteDecisionRecords(tx, descriptor, descriptor.orgId, deletedDecisionIds)
      await recordStaticEntityDeltas(tx, descriptor, 'group', generation, groups, deletedGroupIds)
      await recordStaticEntityDeltas(tx, descriptor, 'object', generation, [], newlyDeletedObjectIds)
      await recordStaticEntityDeltas(tx, descriptor, 'connection', generation, [], newlyDeletedConnectionIds)
      await recordStaticEntityDeltas(tx, descriptor, 'diagram', generation, [], newlyDeletedDiagramIds)
      await recordStaticEntityDeltas(tx, descriptor, 'decision_record', generation, decisions, deletedDecisionIds)
    }, sourceRevision)
    if (metaApplied) {
      // Only a COMMITTED, owned publish projected the drops (`publish`).
      noteLiveDuplicateIds('model-meta', descriptor, `automerge:${descriptor.documentId}`, droppedGroups)
      // The tombstone baselines advance HERE, after the transaction committed
      // — never at the top of the pass, where a short circuit or a throw at
      // any later await could still end it having applied nothing (see the
      // note on `deletedDiagramIds` above), and never after a publish that
      // applied nothing.
      const publishedState = this.overlayState.get(keyOf(descriptor))
      if (publishedState) {
        publishedState.deletedDiagramIds = new Set(nextDeletedDiagramIds)
        publishedState.appliedDeletedObjectIds = new Set(nextDeletedObjectIds)
        publishedState.appliedDeletedConnectionIds = new Set(nextDeletedConnectionIds)
      }
    }
    phaseTimings.publishMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    await this.hydrateOverlayDocuments(documentsToHydrate)
    phaseTimings.hydrateMs = performance.now() - phaseStartedAt
    // The fingerprint is what `metadataUnchanged` short-circuits on, straight
    // to `acknowledgeOnly`: stored after a publish that applied nothing, it
    // made the retry of this very revision acknowledge it as projected.
    if (metaApplied) this.metaSemanticFingerprints.set(keyOf(descriptor), semanticFingerprint)
    const durationMs = performance.now() - startedAt
    if (durationMs >= 50) console.warn(JSON.stringify({
      event: 'read_model.static_meta_phases_slow',
      documentId: descriptor.documentId,
      durationMs: Math.round(durationMs * 100) / 100,
      objectSegments: nextObjectDocumentIds.length,
      connectionSegments: nextConnectionDocumentIds.length,
      preserveObjectState,
      preserveConnectionState,
      timings: Object.fromEntries(Object.entries(phaseTimings).map(([key, value]) => [
        key, Math.round(value * 100) / 100,
      ])),
    }))
  }

  private async metaSourceAlreadyProjected(
    descriptor: StaticDocumentDescriptor,
    sourceRevision: number,
  ): Promise<boolean> {
    if (sourceRevision <= 0) return true
    const { rows } = await this.db.query<{ projected: boolean }>(
      `SELECT projected_revision >= $4 AS projected
       FROM read_model_static_document_queue
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [descriptor.landscapeId, descriptor.versionId, descriptor.documentId, sourceRevision],
    )
    return rows[0]?.projected === true
  }

  private async hydrateOverlayDocuments(
    documents: readonly { documentId: string; kind: string }[],
  ): Promise<void> {
    for (const document of documents) {
      try {
        const handle = await resolveHandleWithRetry(
          this.repo, `automerge:${document.documentId}` as AutomergeUrl,
          { tries: 5, delayMs: 250 },
        )
        // T-ZEROWM-4 (1), the recovery's rule (T-ZEROWM-3 (1)): still the
        // Repo's handle — an eviction inside the resolve's awaits leaves a
        // dead one, and `attach` would swap a live listener for its own.
        const held = this.repo.synchronizer.docSynchronizers[document.documentId as DocumentId]?.query.peek()
        if (held?.state !== 'ready' || held.handle !== handle) continue
        this.attach(handle)
        // The hydration LOADS segments — retired heads among them, which
        // nothing leases — and the load's own change event, heard by the
        // 4 Hz scan's listener on the handle being loaded, starts or arms that
        // head's pass during the resolve: it used to run unleased (an
        // idle eviction free to take the head from under it). Such a pass,
        // on this handle, takes the recovery lease — synchronously, no await
        // since the check above — released by the usual rule (its `finally`
        // when no pass of the document is left, `detach`, `release`, `stop`).
        // The hydration starts no pass itself (a resident segment is replayed
        // only by a change or the durable recovery: see `attach`).
        this.leasePassStartedOn(handle)
      } catch (error) {
        console.error(`[read-model] static ${document.kind} hydration failed`, error)
      }
    }
  }

  /** Incrementally update the changed segment while preserving ModelMeta order.
   * An old segment change can never overwrite a newer segment's value, and a
   * partial initial set is never published as authoritative. */
  private async projectEffectiveOverlay(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    snapshot: ObjectOverlayLike | ConnectionOverlayLike,
    sourceRevision: number,
    sourceConflicts: AutomergeEntityConflicts = new Map(),
    handle?: DocHandle<unknown>,
    /** Heads of the document `snapshot` and `sourceConflicts` were read from;
     * the heal refuses to write when the live document has moved past them. */
    sampledHeads: readonly string[] | null = null,
  ): Promise<void> {
    const workspace = keyOf(descriptor)
    let state = this.overlayState.get(workspace)
    if (!state && this.deferUntilMetaState(descriptor)) return
    if (!state) {
      // No ModelMeta known for this workspace at all: the self-only state is
      // the only one there can be.
      state = {
        objectDocumentIds: kind === 'object' ? [descriptor.documentId] : [],
        connectionDocumentIds: kind === 'connection' ? [descriptor.documentId] : [],
        deletedObjectIds: new Set(),
        deletedDiagramIds: new Set(),
        deletedConnectionIds: new Set(),
        // NOT SEEDED (left undefined): this state knows no ModelMeta, so it
        // knows nothing about which tombstones were applied.
        objectSegments: new Map(),
        connectionSegments: new Map(),
        effectiveObjects: new Map(),
        effectiveConnections: new Map(),
      }
      this.overlayState.set(workspace, state)
    }
    const orderedIds = kind === 'object'
      ? state?.objectDocumentIds ?? [descriptor.documentId]
      : state?.connectionDocumentIds ?? [descriptor.documentId]
    const currentDocumentId = this.currentOverlayDocumentIds.get(workspace)?.[kind]
    if (currentDocumentId && currentDocumentId !== descriptor.documentId) {
      return this.forwardHistoricalOverlay(
        descriptor, kind, snapshot, sourceRevision, orderedIds, currentDocumentId, state,
        sourceConflicts,
      )
    }
    // Nested same-field conflicts already converge deterministically in
    // Automerge. Writing an extra server winner for each transient conflict
    // amplifies a hot burst and can race later client heads. Only `$` means
    // distinct whole-entity CRDT branches whose disjoint fields would be hidden
    // without an explicit structural merge — and only THOSE entities are
    // written (`overlayConflictHealing.ts`, shared with the ordinary projector).
    //
    // BEFORE the materialisation below (T-SUM-0b), so that no await separates
    // its state re-check from `updateStaticOverlaySegment`: the heal reads
    // only `effective`, and an await between the two would reopen the window
    // the re-check closes.
    if (sourceConflicts.size && handle) {
      const healed = await this.healCurrentOverlayConflicts(
        descriptor, kind, snapshot, sourceConflicts, state, handle, sampledHeads,
      )
      // The healing assignment resolves the Automerge conflicts and triggers a
      // fresh projection — as does the write that made a sample stale. Never
      // publish or acknowledge the lossy JSON winner.
      if (healed) return
    }
    // T-SUM-0b: the OTHER segments of the chain with no snapshot in memory
    // are read from their documents, here, rather than waited for. Nothing
    // else ever fills them: a historical segment's own pass forwards and never
    // touches `objectSegments`, `attach` deliberately projects no data
    // document, and on a workspace ENTERING the static plane no segment has a
    // projected snapshot at all (neither the promotion nor the performance
    // seed writes one). The startup rotation then made the chain
    // `[old, new]` and every pass of the new head returned at `!ready`, for
    // ever — measured: projected_revision 0 against a rising revision, the
    // rename in no `ro_objects` row, and the badge "Synced".
    const segmentsBefore: Map<string, Record<string, ObjectInput | ConnectionInput>> = kind === 'object'
      ? state.objectSegments
      : state.connectionSegments
    // Only on a pass of the KNOWN current head. With no current head named
    // (a ModelMeta without `edits*ShardUrl`), every segment's own pass lands
    // here rather than forwarding, so the set completes by accumulation and
    // the first-ready pass is the one the twin rules are pinned against
    // (`duplicateIds.integration`, "a CROSS-SEGMENT twin, first-ready ...").
    const holes = currentDocumentId === descriptor.documentId
      ? orderedIds.filter((documentId) => (
        documentId !== descriptor.documentId && !segmentsBefore.has(documentId)
      ))
      : []
    const materialised: MaterialisedOverlaySegment[] = []
    if (holes.length) {
      const found = await this.materialiseOverlaySegments(descriptor, kind, holes)
      // Every await above may have moved what was read before it: a ModelMeta
      // pass can install a new state, a rotation can append to (or replace)
      // this one, and this head can stop being current. Then this pass is
      // about a chain that no longer exists, so it asks to run again on the
      // fresh one instead of writing into it (`trigger` while running only
      // marks the run pending).
      const stateNow = this.overlayState.get(workspace)
      const orderNow = kind === 'object' ? stateNow?.objectDocumentIds : stateNow?.connectionDocumentIds
      const segmentsNow = kind === 'object' ? stateNow?.objectSegments : stateNow?.connectionSegments
      if (stateNow !== state || orderNow !== orderedIds || segmentsNow !== segmentsBefore
        || this.currentOverlayDocumentIds.get(workspace)?.[kind] !== currentDocumentId) {
        if (handle) this.trigger(descriptor, handle, true)
        return
      }
      for (const segment of found) {
        if (segmentsBefore.has(segment.documentId)) continue
        segmentsBefore.set(segment.documentId, segment.snapshot)
        materialised.push(segment)
      }
      // A segment read from its document was never in `effective`, so this
      // pass is a FULL one (`fullPass` below): every key of every segment, of
      // this head's replaced entry and of `effective` is diffed against
      // `effective`. An incremental diff would touch this head's keys only,
      // never the materialised ones. The diff still writes only what the
      // rows do not already hold.
    }
    // Every segment materialised by THIS pass, taken back out of memory when
    // the pass ends without recording it (a `!ready` return, a publish that
    // applied nothing): left in place, the next pass would find it present,
    // never record it, and it would stay a bookkeeping row — a `{}`
    // forwarding base, a hole again after a restart (measured).
    const forgetMaterialised = () => {
      for (const segment of materialised) {
        if (segmentsBefore.get(segment.documentId) === segment.snapshot) segmentsBefore.delete(segment.documentId)
      }
    }
    const fullPass = materialised.length > 0
    if (kind === 'object') {
      const overlayStartedAt = performance.now()
      const documentSnapshot = (snapshot as ObjectOverlayLike).objects ?? {}
      const batchIds = overlayBatchIds(snapshot)
      const segments = state?.objectSegments ?? new Map<string, Record<string, ObjectInput>>()
      const effective = state?.effectiveObjects ?? new Map<string, { fingerprint: string; value: ObjectInput }>()
      const segmentDelta = updateStaticOverlaySegment(
        orderedIds,
        segments,
        effective,
        descriptor.documentId,
        documentSnapshot,
        state?.deletedObjectIds ?? new Set(),
        fullPass,
      )
      // `segmentDelta` is keyed by MAP KEY; the rows by inner id, and one
      // inner id can sit under two keys. Every inner id it touched is
      // re-derived from all the segments (`resolveStaticOverlayInnerIds`):
      // the cold build's winner upserted, a row deleted only when no key
      // holds its id. The other holders are logged and counted after an
      // applied publish.
      const { dropped: droppedObjects, ...rows } = segmentDelta.ready
        ? resolveStaticOverlayInnerIds('object', orderedIds, segments, effective, segmentDelta.touchedInnerIds)
        : { upserts: [], deleteIds: [], dropped: [] }
      const delta = { ready: segmentDelta.ready, ...rows }
      const deltaMs = performance.now() - overlayStartedAt
      if (!delta.ready) {
        this.noteOverlayNotReady(descriptor, 'object', orderedIds.filter((id) => !segments.has(id)))
        forgetMaterialised()
        return
      }
      this.overlayHeadsNotReady.delete(`${workspace}\u0000object`)
      if (!delta.upserts.length && !delta.deleteIds.length) {
        await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
          await recordMaterialisedSegments(tx, descriptor, 'object', materialised)
          await recordOverlaySegmentProjection(
            tx, descriptor, 'object', descriptor.documentId, sourceRevision, documentSnapshot,
          )
          await acknowledgeOverlayBatches(
            tx, descriptor, 'object', descriptor.documentId, batchIds,
            'projected', sourceRevision, 0,
          )
        })
        await this.pruneForwardedBatchIds(handle, snapshot)
        await this.maybeRotateOverlayHead(descriptor, 'object', snapshot)
        return
      }
      const publishStartedAt = performance.now()
      // `updateStaticOverlaySegment` has already moved `segments` and
      // `effective` to this snapshot. Unless the publish APPLIED, they go
      // back (`revert`, through `appliedOrUndone`, so a throw takes the same
      // road): left moved, the retry of this revision finds nothing to write
      // and acknowledges it. Nothing after a non-applied publish runs either —
      // the batch prune and the rotation belong to the retry.
      // The materialised segments go back too (`forgetMaterialised`): left
      // in place, the retry would find them present and never RECORD them.
      const objectsApplied = await appliedOrUndone(() => { segmentDelta.revert(); forgetMaterialised() }, () => this.publish(descriptor, 'object_shard', {
        kind: 'objects', upsertIds: delta.upserts.map((object) => object.id), deleteIds: delta.deleteIds,
      }, async (tx, generation) => {
        await recordMaterialisedSegments(tx, descriptor, 'object', materialised)
        await recordOverlaySegmentProjection(
          tx, descriptor, 'object', descriptor.documentId, sourceRevision, documentSnapshot,
        )
        await acknowledgeOverlayBatches(
          tx, descriptor, 'object', descriptor.documentId, batchIds,
          'projected', sourceRevision, generation,
        )
        await captureSparseDraftEntityBases(
          tx, descriptor, 'object', [...delta.upserts.map((object) => object.id), ...delta.deleteIds],
        )
        await captureOverlayEntityBases(
          tx, descriptor, 'object', descriptor.documentId,
          [...delta.upserts.map((object) => object.id), ...delta.deleteIds],
        )
        await bumpDiagramRenderGenerations(tx, descriptor, generation, {
          objectIds: [...delta.upserts.map((object) => object.id), ...delta.deleteIds],
        })
        await upsertObjects(tx, descriptor, descriptor.orgId, delta.upserts)
        await deleteObjects(tx, descriptor, delta.deleteIds)
        await recordStaticEntityDeltas(tx, descriptor, 'object', generation, delta.upserts, delta.deleteIds)
      }, sourceRevision))
      if (!objectsApplied) return
      noteLiveDuplicateIds('object-shard', descriptor, `automerge:${descriptor.documentId}`, droppedObjects)
      const publishMs = performance.now() - publishStartedAt
      await this.pruneForwardedBatchIds(handle, snapshot)
      await this.maybeRotateOverlayHead(descriptor, 'object', snapshot)
      const durationMs = performance.now() - overlayStartedAt
      if (durationMs >= 50) console.warn(JSON.stringify({
        event: 'read_model.static_overlay_phases_slow',
        kind,
        documentId: descriptor.documentId,
        durationMs: Math.round(durationMs * 100) / 100,
        snapshotEntities: Object.keys(documentSnapshot).length,
        upserts: delta.upserts.length,
        deletes: delta.deleteIds.length,
        deltaMs: Math.round(deltaMs * 100) / 100,
        publishMs: Math.round(publishMs * 100) / 100,
      }))
      return
    }
    const overlayStartedAt = performance.now()
    const documentSnapshot = (snapshot as ConnectionOverlayLike).connections ?? {}
    const batchIds = overlayBatchIds(snapshot)
    const segments = state?.connectionSegments ?? new Map<string, Record<string, ConnectionInput>>()
    const effective = state?.effectiveConnections ?? new Map<string, { fingerprint: string; value: ConnectionInput }>()
    const segmentDelta = updateStaticOverlaySegment(
      orderedIds,
      segments,
      effective,
      descriptor.documentId,
      documentSnapshot,
      state?.deletedConnectionIds ?? new Set(),
      fullPass,
    )
    // As the object branch above: map keys are not inner ids.
    const { dropped: droppedConnections, ...rows } = segmentDelta.ready
      ? resolveStaticOverlayInnerIds('connection', orderedIds, segments, effective, segmentDelta.touchedInnerIds)
      : { upserts: [], deleteIds: [], dropped: [] }
    const delta = { ready: segmentDelta.ready, ...rows }
    const deltaMs = performance.now() - overlayStartedAt
    if (!delta.ready) {
      this.noteOverlayNotReady(descriptor, 'connection', orderedIds.filter((id) => !segments.has(id)))
      forgetMaterialised()
      return
    }
    this.overlayHeadsNotReady.delete(`${workspace}\u0000connection`)
    if (!delta.upserts.length && !delta.deleteIds.length) {
      await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
        await recordMaterialisedSegments(tx, descriptor, 'connection', materialised)
        await recordOverlaySegmentProjection(
          tx, descriptor, 'connection', descriptor.documentId, sourceRevision, documentSnapshot,
        )
        await acknowledgeOverlayBatches(
          tx, descriptor, 'connection', descriptor.documentId, batchIds,
          'projected', sourceRevision, 0,
        )
      })
      await this.pruneForwardedBatchIds(handle, snapshot)
      await this.maybeRotateOverlayHead(descriptor, 'connection', snapshot)
      return
    }
    const publishStartedAt = performance.now()
    // As the object branch: reverted unless the publish applied, the
    // materialised segments with it.
    const connectionsApplied = await appliedOrUndone(() => { segmentDelta.revert(); forgetMaterialised() }, () => this.publish(descriptor, 'connection_shard', {
      kind: 'connections', upsertIds: delta.upserts.map((connection) => connection.id), deleteIds: delta.deleteIds,
    }, async (tx, generation) => {
      await recordMaterialisedSegments(tx, descriptor, 'connection', materialised)
      await recordOverlaySegmentProjection(
        tx, descriptor, 'connection', descriptor.documentId, sourceRevision, documentSnapshot,
      )
      await acknowledgeOverlayBatches(
        tx, descriptor, 'connection', descriptor.documentId, batchIds,
        'projected', sourceRevision, generation,
      )
      await captureSparseDraftEntityBases(
        tx, descriptor, 'connection', [...delta.upserts.map((connection) => connection.id), ...delta.deleteIds],
      )
      await captureOverlayEntityBases(
        tx, descriptor, 'connection', descriptor.documentId,
        [...delta.upserts.map((connection) => connection.id), ...delta.deleteIds],
      )
      await bumpDiagramRenderGenerations(tx, descriptor, generation, {
        connectionIds: [...delta.upserts.map((connection) => connection.id), ...delta.deleteIds],
      })
      await upsertConnections(tx, descriptor, descriptor.orgId, delta.upserts)
      await deleteConnections(tx, descriptor, delta.deleteIds)
      await recordStaticEntityDeltas(tx, descriptor, 'connection', generation, delta.upserts, delta.deleteIds)
    }, sourceRevision))
    if (!connectionsApplied) return
    noteLiveDuplicateIds('connection-shard', descriptor, `automerge:${descriptor.documentId}`, droppedConnections)
    const publishMs = performance.now() - publishStartedAt
    await this.pruneForwardedBatchIds(handle, snapshot)
    await this.maybeRotateOverlayHead(descriptor, 'connection', snapshot)
    const durationMs = performance.now() - overlayStartedAt
    if (durationMs >= 50) console.warn(JSON.stringify({
      event: 'read_model.static_overlay_phases_slow',
      kind,
      documentId: descriptor.documentId,
      durationMs: Math.round(durationMs * 100) / 100,
      snapshotEntities: Object.keys(documentSnapshot).length,
      upserts: delta.upserts.length,
      deletes: delta.deleteIds.length,
      deltaMs: Math.round(deltaMs * 100) / 100,
      publishMs: Math.round(publishMs * 100) / 100,
    }))
  }

  /** Returns true when this projection must NOT publish: the document was
   * written (and will re-project) or had moved past the sample (and will
   * re-project from the write that moved it). */
  private async healCurrentOverlayConflicts(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    snapshot: ObjectOverlayLike | ConnectionOverlayLike,
    sourceConflicts: AutomergeEntityConflicts,
    state: StaticOverlayState,
    handle: DocHandle<unknown>,
    sampledHeads: readonly string[] | null,
  ): Promise<boolean> {
    const selected = kind === 'object'
      ? (snapshot as ObjectOverlayLike).objects ?? {}
      : (snapshot as ConnectionOverlayLike).connections ?? {}
    const effective = kind === 'object' ? state.effectiveObjects : state.effectiveConnections
    const outcome = await healWholeEntityConflicts<ObjectInput | ConnectionInput>({
      db: this.db,
      key: descriptor,
      collection: kind,
      handle,
      repo: this.repo,
      sourceConflicts,
      sampledHeads,
      current: (entityId) => effective.get(entityId)?.value,
      selected: (entityId) => selected[entityId] as ObjectInput | ConnectionInput | undefined,
      // The ledger a user resolves from: same-field conflicts found INSIDE the
      // `$` branches of the entities this heal writes.
      recordConflicts: async (recorded) => {
        await this.transactionOnly(descriptor, (tx) => recordOverlayConflicts(
          tx, descriptor, kind, descriptor.documentId, descriptor.documentId,
          overlayBatchIds(snapshot), recorded,
        ))
      },
    })
    return outcome !== 'none'
  }

  /** A client can reconnect with durable edits against a head that rotated
   * while it was offline. Never publish that retired segment directly: merge
   * its delta from the last projected snapshot into the current head, persist
   * a non-terminal forwarding acknowledgement, then advance the old queue only
   * after the forwarded Automerge documents are durable. */
  private async forwardHistoricalOverlay(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    snapshot: ObjectOverlayLike | ConnectionOverlayLike,
    sourceRevision: number,
    orderedIds: readonly string[],
    currentDocumentId: string,
    state: StaticOverlayState,
    sourceConflicts: AutomergeEntityConflicts,
  ): Promise<void> {
    // The plane, at ENTRY — see `rotateOverlayHead`. This path ends with
    // `currentHandle.change`, `metaHandle.change` and `repo.flush`, and only
    // THEN calls `acknowledgeOnly`, where the SQL gate lives; without this the
    // CRDT write would land and flush before the SQL was refused.
    if (!(await this.holdsStaticPlane(descriptor))) return
    const collectionSnapshot = kind === 'object'
      ? plain<Record<string, ObjectInput>>((snapshot as ObjectOverlayLike).objects ?? {})
      : plain<Record<string, ConnectionInput>>((snapshot as ConnectionOverlayLike).connections ?? {})
    const declaredBatchIds = overlayBatchIds(snapshot)
    // Protocol-v1 writers did not persist stable IDs. A deterministic revision
    // ID keeps their late write replayable/idempotent without pretending the
    // client can poll it.
    const sourceBatchIds = declaredBatchIds.length
      ? declaredBatchIds
      : [`legacy-${kind}-${descriptor.documentId}-${sourceRevision}`]
    const pendingBatchIds = await pendingOverlayBatchIds(this.db, descriptor, sourceBatchIds)
    if (!pendingBatchIds.length) {
      await this.acknowledgeOnly(descriptor, sourceRevision)
      return
    }

    const base = await overlaySegmentBase(
      this.db, descriptor, kind, descriptor.documentId,
    ) as Record<string, ObjectInput | ConnectionInput> | undefined
    if (!base) {
      const checkpoint = await overlayDocumentProjectionCheckpoint(
        this.db, descriptor, descriptor.documentId,
      )
      if (checkpoint.projectedRevision >= sourceRevision) {
        await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
          await recordOverlaySegmentProjection(
            tx, descriptor, kind, descriptor.documentId, sourceRevision, collectionSnapshot,
          )
          await acknowledgeOverlayBatches(
            tx, descriptor, kind, descriptor.documentId, sourceBatchIds,
            'projected', sourceRevision, 0,
          )
        })
        return
      }
      const conflicts: OverlayConflictInput[] = Object.entries(collectionSnapshot).map(([entityId, value]) => ({
        entityId,
        conflictPaths: ['$base-unavailable'],
        baseValue: undefined,
        historicalValue: value,
        currentValue: undefined,
        forwardedValue: undefined,
      }))
      if (!conflicts.length) conflicts.push({
        entityId: `$document:${descriptor.documentId}`,
        conflictPaths: ['$base-unavailable'],
        baseValue: undefined,
        historicalValue: collectionSnapshot,
        currentValue: undefined,
        forwardedValue: undefined,
      })
      await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
        await recordOverlayConflicts(
          tx, descriptor, kind, descriptor.documentId, currentDocumentId,
          pendingBatchIds, conflicts,
        )
        await acknowledgeOverlayBatches(
          tx, descriptor, kind, descriptor.documentId, pendingBatchIds,
          'conflict', sourceRevision, 0,
        )
      })
      return
    }

    const segmentSnapshots = new Map<string, Record<string, ObjectInput | ConnectionInput>>()
    for (const documentId of orderedIds) {
      if (documentId === descriptor.documentId) {
        segmentSnapshots.set(documentId, base)
        continue
      }
      const cached = kind === 'object'
        ? state.objectSegments.get(documentId)
        : state.connectionSegments.get(documentId)
      if (cached) {
        segmentSnapshots.set(documentId, cached)
        continue
      }
      const handle = await this.resolveDocumentHandle<ObjectOverlayLike | ConnectionOverlayLike>(documentId)
      const doc = plain<ObjectOverlayLike | ConnectionOverlayLike>(handle.doc())
      segmentSnapshots.set(documentId, kind === 'object'
        ? plain<Record<string, ObjectInput>>((doc as ObjectOverlayLike).objects ?? {})
        : plain<Record<string, ConnectionInput>>((doc as ConnectionOverlayLike).connections ?? {}))
    }
    const currentEffective = new Map<string, ObjectInput | ConnectionInput>()
    for (const documentId of orderedIds) {
      for (const [entityId, value] of Object.entries(segmentSnapshots.get(documentId) ?? {})) {
        currentEffective.set(entityId, value)
      }
    }
    const tombstones = kind === 'object' ? state.deletedObjectIds : state.deletedConnectionIds
    for (const entityId of tombstones) currentEffective.delete(entityId)

    // A retired overlay is an append/update journal, not the authoritative
    // deletion channel. A stale/degenerate peer can republish that historical
    // document as empty after rotation (the production auto-layout regression
    // did this with 89 routed connections). Treating keys that vanished from
    // the retired snapshot as deletes turns a transport failure into permanent
    // model tombstones. Explicit model deletes are already carried, merged and
    // projected through ModelMeta.deleted{Object,Connection}Ids, so historical
    // forwarding must consider only values that are actually present here.
    const changedEntityIds = new Set(Object.keys(collectionSnapshot))
    const upserts = new Map<string, ObjectInput | ConnectionInput>()
    const conflicts: OverlayConflictInput[] = []
    for (const entityId of changedEntityIds) {
      // ModelMeta tombstones are the authoritative deletion channel. A
      // retired segment can still contain the deleted entity (and even retain
      // nested Automerge conflicts) after its deletion was projected. Those
      // stale values must not be attributed to an unrelated later batch that
      // happens to land while this head rotates. Replaying them would both
      // resurrect the deletion and turn the later batch into a false conflict.
      if (tombstones.has(entityId)) continue
      const baseValue = base[entityId]
      const historicalValue = collectionSnapshot[entityId]
      const automergeConflicts = sourceConflicts.get(entityId) ?? {}
      const explicitConflictPaths = Object.keys(automergeConflicts)
      if (JSON.stringify(baseValue) === JSON.stringify(historicalValue)
        && !explicitConflictPaths.length) continue
      const currentValue = currentEffective.get(entityId)
      const merged = threeWayMergeOverlayEntity(baseValue, historicalValue, currentValue)
      const conflictPaths = [...new Set([...merged.conflicts, ...explicitConflictPaths])]
      const forwardedValue = preserveCurrentConflictPaths(
        merged.value, currentValue, explicitConflictPaths,
      )
      const forwardedChanged = JSON.stringify(forwardedValue) !== JSON.stringify(currentValue)
      if (forwardedValue !== undefined && forwardedChanged) upserts.set(entityId, forwardedValue)
      if (conflictPaths.length) conflicts.push({
        entityId,
        conflictPaths,
        baseValue,
        historicalValue: explicitConflictPaths.length
          ? { selected: historicalValue, automergeConflicts }
          : historicalValue,
        currentValue,
        forwardedValue,
      })
    }

    await this.transactionOnly(descriptor, async (tx) => {
      await recordOverlayConflicts(
        tx, descriptor, kind, descriptor.documentId, currentDocumentId,
        pendingBatchIds, conflicts,
      )
      await acknowledgeOverlayBatches(
        tx, descriptor, kind, currentDocumentId, pendingBatchIds,
        conflicts.length ? 'forwarding_conflict' : 'forwarding', sourceRevision, 0,
      )
    })

    const currentHandle = await this.resolveDocumentHandle<ObjectOverlayLike | ConnectionOverlayLike>(
      currentDocumentId,
    )
    currentHandle.change((doc) => {
      const mutable = doc as ObjectOverlayLike & ConnectionOverlayLike
      // Assign, then RE-READ: `(mutable.objects ??= {})` yields the plain `{}`
      // it assigned, not the document's map, and the forward would be lost
      // while its batch is acknowledged below.
      if (kind === 'object' && !mutable.objects) mutable.objects = {}
      if (kind === 'connection' && !mutable.connections) mutable.connections = {}
      const target = (kind === 'object' ? mutable.objects : mutable.connections) as
        Record<string, ObjectInput | ConnectionInput>
      for (const [entityId, value] of upserts) target[entityId] = plain(value)
      // Forwarded acknowledgements must reach the current projector, but they
      // are not new writes on this head. Counting them as local write batches
      // made every post-rotation forward immediately trigger another rotation.
      // In place (G4-16f): the ids already there are not re-created.
      addForwardedBatchIdsInPlace(mutable, pendingBatchIds)
    })

    const metaDescriptor = [...this.descriptors.values()].find((candidate) => (
      candidate.kind === 'model-meta' && keyOf(candidate) === keyOf(descriptor)
    ))
    if (!metaDescriptor) throw new Error('Historical overlay forwarding requires ModelMeta')
    const metaHandle = await this.resolveDocumentHandle<StaticMetaLike>(metaDescriptor.documentId)
    if (upserts.size) {
      metaHandle.change((doc) => {
        // In place (G4-16f): the tombstones that stay are not re-created.
        removeTombstonesInPlace(doc, kind === 'object' ? 'deletedObjectIds' : 'deletedConnectionIds', upserts.keys())
      })
    }
    await this.repo.flush([currentHandle.documentId, metaHandle.documentId])
    await this.acknowledgeOnly(descriptor, sourceRevision)
  }

  private async resolveDocumentHandle<T>(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<DocHandle<T>> {
    const resident = this.listened.get(documentId)?.handle
    // T-ZEROWM (B): the listened handle only while the Repo still holds IT —
    // an evicted handle stays `ready`, and a change made on it is saved by
    // nobody.
    const held = this.repo.synchronizer.docSynchronizers[documentId as DocumentId]?.query.peek()
    if (resident?.state === 'ready' && held?.state === 'ready' && held.handle === resident) {
      return resident as DocHandle<T>
    }
    const handle = await resolveHandleWithRetry(
      this.repo, `automerge:${documentId}` as AutomergeUrl,
      { tries: 5, delayMs: 250, signal },
    )
    this.attach(handle)
    return handle as DocHandle<T>
  }

  private async pruneForwardedBatchIds(
    handle: DocHandle<unknown> | undefined,
    snapshot: ObjectOverlayLike | ConnectionOverlayLike,
  ): Promise<void> {
    const acknowledged = new Set(unique(snapshot.forwardedBatchIds ?? []))
    if (!handle || !acknowledged.size) return
    handle.change((doc: unknown) => {
      // In place while ids remain; the key goes once none does (G4-16f).
      pruneForwardedBatchIdsInPlace(doc as ObjectOverlayLike & ConnectionOverlayLike, acknowledged)
    })
    await this.repo.flush([handle.documentId])
  }

  private async maybeRotateOverlayHead(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    snapshot: ObjectOverlayLike | ConnectionOverlayLike,
  ): Promise<void> {
    const current = this.currentOverlayDocumentIds.get(keyOf(descriptor))?.[kind]
    if (current !== descriptor.documentId) return
    const entityCount = kind === 'object'
      ? Object.keys((snapshot as ObjectOverlayLike).objects ?? {}).length
      : Object.keys((snapshot as ConnectionOverlayLike).connections ?? {}).length
    const batchCount = unique(snapshot.writeBatchIds ?? []).length
    if ((snapshot.writeHeadVersion ?? 0) >= 2
      && entityCount < OVERLAY_SEGMENT_SIZE
      && batchCount < OVERLAY_SEGMENT_SIZE) return
    this.scheduleOverlayRotation(descriptor, kind)
  }

  /**
   * Rotation is maintenance work, not part of the interactive write path.
   * Debounce it until the hot head is quiet, while retaining a maximum delay so
   * continuous traffic cannot defer rotation for ever.
   *
   * THE SECOND CLAUSE USED TO SAY "so continuous traffic cannot grow a segment
   * without bound", and that is false in the way rule 2 is about: the maximum
   * delay bounds how long a head stays CURRENT, not how many entities land in
   * it. Nothing here caps a segment's size, and nothing downstream did either —
   * `rotateOverlayHead` creates an EMPTY successor and retires the over-full
   * head WHOLE. On the reference landscape the browser writes all 11 935
   * objects into one head well inside the 5 s quiet window (it declines to
   * rotate and defers, `overlay.rotation.deferred`, `owner: 'server'`), so the
   * very next rotation makes an 11 935-entity document a permanent retired
   * segment.
   *
   * What actually bounds a segment is the fold: `OVERLAY_SEGMENT_ENTITY_CEILING`
   * plus `splitMergedOverlaySegment`, with `overlay-segment-bounded` as the
   * detector. Rotation is not a size mechanism.
   */
  private scheduleOverlayRotation(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
  ): void {
    const workspace = keyOf(descriptor)
    const rotationKey = `${workspace}\u0000${kind}`
    if (this.rotatingHeads.has(rotationKey) || this.stopped) return
    const existing = this.pendingRotations.get(rotationKey)
    if (existing) clearTimeout(existing.timer)
    const firstQueuedAt = existing?.firstQueuedAt ?? Date.now()
    const remainingMaxDelay = Math.max(0, this.overlayRotationMaxDelayMs - (Date.now() - firstQueuedAt))
    const delayMs = Math.min(this.overlayRotationQuietMs, remainingMaxDelay)
    const timer = setTimeout(() => {
      this.pendingRotations.delete(rotationKey)
      if (this.stopped || this.rotatingHeads.has(rotationKey)) return
      this.rotatingHeads.add(rotationKey)
      const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
      const task = previous.then(async () => {
        if (!this.stopped && this.ownsWorkspace(descriptor)) {
          await this.rotateOverlayHead(descriptor, kind)
        }
      }).catch((error) => {
        console.error(`[read-model] deferred ${kind} overlay rotation failed`, error)
      }).finally(() => {
        this.rotatingHeads.delete(rotationKey)
      })
      this.workspaceTails.set(workspace, task.then(() => undefined, () => undefined))
    }, delayMs)
    timer.unref()
    this.pendingRotations.set(rotationKey, { timer, firstQueuedAt, descriptor, kind })
  }

  /** Rotation is server-owned. The new child is assigned to the workspace and
   * durably flushed before an admitted recovery row is committed. Each database
   * transaction validates ownership at entry and immediately before commit,
   * without locking the ownership row. The session-level advisory lock
   * serializes competing projector instances across both commits and the
   * Automerge flush between them — by REFUSING a contender, not by queueing it:
   * see `overlayRotationLock.ts` for why, and for what the hand-back has to do. */
  private async rotateOverlayHead(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
  ): Promise<void> {
    const rotationStartedAt = performance.now()
    // The PLANE, before anything is created, claimed, locked or flushed.
    // Gating only `publish`/`acknowledgeOnly` would make a stale projector
    // harmless on the `ro_*` row plane but leave it writing the DOCUMENT plane:
    // this path `repo.create`s a new overlay, claims it, re-INSERTs the
    // `read_model_static_documents` rows a demotion just deleted, and mutates
    // the user's ModelMeta CRDT — all before the SQL gate at the end could
    // refuse anything. Cheapest possible placement: one primary-key lookup
    // before the first `db.connect()`, so a refusal costs no client and no lock.
    if (!(await this.holdsStaticPlane(descriptor))) return
    const metaDescriptor = [...this.descriptors.values()].find((candidate) => (
      candidate.kind === 'model-meta' && keyOf(candidate) === keyOf(descriptor)
    ))
    if (!metaDescriptor) throw new Error('Overlay rotation requires ModelMeta')
    const metaHandle = await this.resolveDocumentHandle<StaticMetaLike>(metaDescriptor.documentId)
    const client = await this.db.connect()
    const lockKey = overlayRotationLockKey(descriptor.landscapeId, descriptor.versionId, kind)
    // `unknown` and not `refused` is the safe start: the question is not "did
    // we take the lock" but "what do we know about whether this session holds
    // it", and a throw from the acquisition below leaves exactly that gap.
    let lock: OverlayRotationLockState = 'unknown'
    // HOLD TIME is recorded. A same-workspace publish waits on this key with
    // its ceiling deliberately disarmed (`projectionTransaction.ts`), so the
    // hold time here is the length of that wait — the figure the decision to
    // refuse rather than queue turns on. Measuring it costs one
    // `performance.now()` on a path that already logs.
    let lockAcquiredAt: number | undefined
    let inTransaction = false
    try {
      lock = await acquireOverlayRotationLock(client, lockKey)
      if (lock === 'acquired') lockAcquiredAt = performance.now()
      // `!== 'acquired'`, NOT `=== 'refused'`. There are three states and only
      // one of them licenses the work; testing for the negative one would let
      // `unknown` — the acquisition answered a shape nobody can read — fall
      // through and rotate a head this session may not hold the key for.
      if (lock !== 'acquired') {
        // The holder is another pod rotating or folding the SAME head, and the
        // obligation is not dropped: `recoverCurrentOverlayRotationObligations`
        // re-derives it from the head's own snapshot on every reload tick, which
        // is the same argument the claim-failure path below relies on.
        reportOverlayRotationLockContended({
          path: 'rotate',
          landscapeId: descriptor.landscapeId,
          versionId: descriptor.versionId,
          kind,
          state: lock,
        })
        return
      }
      if (!this.ownsWorkspace(descriptor)) return
      const field = kind === 'object' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl'
      const currentUrl = readMetaUrl(metaHandle.doc(), field)
      if (!currentUrl || documentIdOf(currentUrl) !== descriptor.documentId) return

      const child = kind === 'object'
        ? this.repo.create<ObjectOverlayLike>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
        : this.repo.create<ConnectionOverlayLike>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
      await child.whenReady()

      // The rotated head is claimed for its workspace BEFORE any pointer (the
      // read_model_static_documents row below, then the ModelMeta head) can
      // reach it. This is the ONE creator site where a claim failure must not
      // throw out of a loop — rotation runs inside the projector's health
      // machinery — so the failure de-covers the workspace instead of
      // propagating, and the rotated head is simply never published.
      //
      // It does NOT mark `read_model_projection_state` degraded. That would be
      // wrong as a FACT: this `catch` returns before `BEGIN` below, so
      // ModelMeta, the current write head and every `ro_*` row are untouched.
      // And wrong as a MECHANISM: `clearReadModelWorkspaceDegraded` has one
      // call site, inside the ordinary projector, which the fleet refuses to
      // attach to a static workspace — so the mark would have no lift, and
      // would block promotion, reference-integrity repair and `absenceProvable`
      // for ever, over a fault that heals itself.
      //
      // The de-cover is the RIGHT signal: it is durable, carries a reason, has
      // a real lift (the `invalidations` CAS in `coverWorkspace`), and already
      // blocks promotion (`claim-coverage-missing`). The obligation is not
      // dropped: `recoverCurrentOverlayRotationObligations` re-derives it from
      // durable state on every reload tick. `projectorService` stays the SINGLE
      // writer of the degraded triple.
      try {
        const claims = await claimWorkspaceDocuments(client, descriptor, [String(child.documentId)])
        if (claims.missingVersion || claims.foreign.length > 0) {
          // `landscapeId/versionId`, not `keyOf`: that joins with a NUL, right for
          // a Map key and wrong for a message a log pipeline reads.
          throw new Error(claims.missingVersion
            ? `overlay rotation for ${descriptor.landscapeId}/${descriptor.versionId} has no versions row`
            : `rotated ${kind} head is already owned by `
              + `${claims.foreign[0]!.winner.landscapeId}/${claims.foreign[0]!.winner.versionId}`)
        }
      } catch (claimError) {
        console.error(`[read-model] ${kind} overlay rotation could not claim its new head`, claimError)
        // The de-cover is the ONLY durable trace of this failure, so its own
        // failure is logged rather than swallowed. It still may not throw —
        // this runs inside the projector's health machinery. `version_id` has an ON DELETE CASCADE foreign key,
        // so a workspace whose version row is gone fails this with 23503; that
        // is the common case and it is worth seeing.
        await invalidateWorkspaceCoverage(
          client, descriptor, `overlay rotation claim failed: ${String((claimError as Error).message ?? claimError)}`,
        ).catch((coverageError) => {
          console.error(
            `[read-model] ${kind} overlay rotation could not de-cover its workspace either`, coverageError,
          )
        })
        return
      }

      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await registerStaticReadModelDocuments(client, descriptor, [{
        documentId: child.documentId,
        kind: kind === 'object' ? 'object-overlay' : 'connection-overlay',
      }])
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await client.query('COMMIT')
      inTransaction = false

      // Force one post-admission storage revision even when Repo.create already
      // persisted its initial change before the workspace assignment committed.
      child.change((doc: ObjectOverlayLike & ConnectionOverlayLike) => { doc.writeHeadVersion = 2 })
      await this.repo.flush([child.documentId])

      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      const stillCurrent = readMetaUrl(metaHandle.doc(), field)
      if (!stillCurrent || documentIdOf(stillCurrent) !== descriptor.documentId) {
        await client.query(
          `INSERT INTO read_model_overlay_rotations (
             landscape_id, version_id, collection, old_document_id,
             new_document_id, new_segment_url, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'superseded')
           ON CONFLICT DO NOTHING`,
          [descriptor.landscapeId, descriptor.versionId, kind, descriptor.documentId,
            child.documentId, child.url],
        )
        await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
        await client.query('COMMIT')
        inTransaction = false
        return
      }
      await client.query(
        `INSERT INTO read_model_overlay_segments (
           landscape_id, version_id, collection, document_id, segment_url, is_current
         ) VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE
         SET segment_url = EXCLUDED.segment_url`,
        [descriptor.landscapeId, descriptor.versionId, kind, child.documentId, child.url],
      )
      await client.query(
        `INSERT INTO read_model_overlay_rotations (
           landscape_id, version_id, collection, old_document_id,
           new_document_id, new_segment_url, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'admitted')
         ON CONFLICT (landscape_id, version_id, collection, new_document_id) DO NOTHING`,
        [descriptor.landscapeId, descriptor.versionId, kind, descriptor.documentId,
          child.documentId, child.url],
      )
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await client.query('COMMIT')
      inTransaction = false

      // Activated only once PUBLISHED (T-ZEROWM (B)): a publication left
      // `admitted` for lack of a durable ModelMeta is activated by nobody
      // here — the recovery tick publishes it, and the ModelMeta pass its
      // change triggers installs the head.
      if (await this.publishAdmittedRotation(
        client, descriptor, metaHandle, kind, descriptor.documentId, child.documentId, child.url,
      )) await this.activatePublishedOverlayHead(descriptor, kind, child, metaHandle)
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      // Taken BEFORE the release, which is the statement that ends the hold.
      const lockHeldMs = lockAcquiredAt === undefined
        ? null
        : Math.round((performance.now() - lockAcquiredAt) * 100) / 100
      await releaseOverlayRotationLock(client, lockKey, lock)
      const durationMs = performance.now() - rotationStartedAt
      if (durationMs >= 50) console.warn(JSON.stringify({
        event: 'read_model.overlay_rotation_slow',
        kind,
        previousDocumentId: descriptor.documentId,
        durationMs: Math.round(durationMs * 100) / 100,
        // NULL, never 0, when the lock was never taken: a zero here reads as
        // "held for no time", which is a different fact from "never held" and
        // the one that would quietly deflate any average taken over these.
        lockHeldMs,
      }))
    }
  }

  /** Repo.create emits its document event before the child descriptor is
   * committed, so the normal onDocument path cannot attach it. Activate the
   * published child explicitly; otherwise writes arriving before the next
   * descriptor-reload tick are durable but remain unprojected until restart. */
  private async activatePublishedOverlayHead(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    child: DocHandle<ObjectOverlayLike | ConnectionOverlayLike>,
    metaHandle: DocHandle<StaticMetaLike>,
  ): Promise<void> {
    const live = metaHandle.doc()
    if (!live) return
    const meta = withMetaUrlView(live)
    const currentUrl = kind === 'object'
      ? meta.editsObjectShardUrl
      : meta.editsConnectionShardUrl
    if (!currentUrl || documentIdOf(currentUrl) !== child.documentId) return
    const workspace = keyOf(descriptor)
    // `release()` must be a FIXED POINT. Everything below re-installs exactly
    // what `release` removes: a descriptor, a residency lease, a pinned core
    // document and a fresh `change` listener. A rotation that was past its
    // plane check when the workspace was released would therefore resurrect
    // it, and the next reload tick would re-stamp the health row.
    //
    // `attachedWorkspaces` is the single owner of that question: `release`
    // deletes the entry and ONLY a reload tick that saw the authority row puts
    // it back. What this does not distinguish is a release followed by a
    // re-promotion while this rotation was still in flight; that installs a
    // descriptor for a workspace which is once again static, and the
    // re-promotion's `markStaticReadModelWorkspace` DELETEs the whole
    // allow-list, so the next reconciliation sweeps it. Bounded by one tick,
    // not silent.
    if (!this.attachedWorkspaces.has(workspace)) return
    const state = this.overlayState.get(workspace)
    if (state) {
      if (kind === 'object') {
        const documentIds = canonicalOverlayDocumentIds(
          unique(meta.editsObjectShardUrls ?? []),
          meta.editsObjectShardUrl,
        ).map(documentIdOf)
        if (appendFreshStaticOverlayHead(
          state.objectDocumentIds, documentIds, state.objectSegments, child.documentId,
        )) {
          state.objectDocumentIds = documentIds
        } else {
          const segments = await overlaySegmentSnapshots(
            this.db, descriptor, 'object', documentIds,
          ) as Map<string, Record<string, ObjectInput>>
          segments.set(child.documentId, {})
          state.objectDocumentIds = documentIds
          state.objectSegments = segments
          state.effectiveObjects = effectiveOverlayState(
            documentIds, segments, state.deletedObjectIds,
          )
        }
      } else {
        const documentIds = canonicalOverlayDocumentIds(
          unique(meta.editsConnectionShardUrls ?? []),
          meta.editsConnectionShardUrl,
        ).map(documentIdOf)
        if (appendFreshStaticOverlayHead(
          state.connectionDocumentIds, documentIds, state.connectionSegments, child.documentId,
        )) {
          state.connectionDocumentIds = documentIds
        } else {
          const segments = await overlaySegmentSnapshots(
            this.db, descriptor, 'connection', documentIds,
          ) as Map<string, Record<string, ConnectionInput>>
          segments.set(child.documentId, {})
          state.connectionDocumentIds = documentIds
          state.connectionSegments = segments
          state.effectiveConnections = effectiveOverlayState(
            documentIds, segments, state.deletedConnectionIds,
          )
        }
      }
    }
    const childDescriptor: StaticDocumentDescriptor = {
      ...descriptor,
      documentId: child.documentId,
      kind: kind === 'object' ? 'object-overlay' : 'connection-overlay',
      entityId: null,
    }
    this.descriptors.set(child.documentId, childDescriptor)
    this.updateCurrentWriteHeadLeases(descriptor, meta)
    this.attach(child)
  }

  private expectedOwnershipFence(descriptor: StaticDocumentDescriptor): string | null {
    return this.ownership?.enabled ? this.ownership.fencingToken(descriptor) : null
  }

  private async publishAdmittedRotation(
    client: Queryable,
    descriptor: StaticDocumentDescriptor,
    metaHandle: DocHandle<StaticMetaLike>,
    kind: 'object' | 'connection',
    oldDocumentId: string,
    newDocumentId: string,
    newUrl: string,
  ): Promise<boolean> {
    const currentField = kind === 'object' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl'
    const segmentsField = kind === 'object' ? 'editsObjectShardUrls' : 'editsConnectionShardUrls'
    const shardsField = kind === 'object' ? 'objectShardUrls' : 'connectionShardUrls'
    let inTransaction = false
    try {
      // Never hold a relation/share lock on workspace ownership while Repo.flush
      // uses another pool connection to persist the Automerge document. A
      // concurrent additive schema migration queues an AccessExclusive lock;
      // keeping this transaction open would then create a cross-connection lock
      // inversion (transaction -> flush -> migration -> transaction).
      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      const currentUrl = readMetaUrl(metaHandle.doc(), currentField)
      const currentDocumentId = currentUrl ? documentIdOf(currentUrl) : undefined
      if (currentDocumentId !== oldDocumentId && currentDocumentId !== newDocumentId) {
        await client.query(
          `UPDATE read_model_overlay_rotations SET status = 'superseded'
           WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
             AND new_document_id = $4 AND status = 'admitted'`,
          [descriptor.landscapeId, descriptor.versionId, kind, newDocumentId],
        )
        // In the SAME transaction as the status change, because the two are
        // one fact. Abandoning the rotation without this leaves the child's
        // segment row at `retain_until IS NULL`, which the GC reads as a
        // reachability root with no expiry, and nothing in the tree ever
        // deletes such a row. See the helper for why NULL is right until
        // exactly here. Scope: the static branch of `gc.ts` pins this document
        // through its claim and its allow-list row regardless, so releasing the
        // segment matters after a demotion and not before.
        await releaseSupersededOverlaySegment(client, descriptor, kind, newDocumentId)
        await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
        await client.query('COMMIT')
        inTransaction = false
        return false
      }
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await client.query('COMMIT')
      inTransaction = false

      if (currentDocumentId === oldDocumentId) {
        metaHandle.change((meta) => {
          appendUniqueOverlayRoute(meta, segmentsField, newUrl)
          writeMetaUrl(meta, currentField, newUrl)
          appendUniqueOverlayRoute(meta, shardsField, newUrl)
          // The meta's PROTOCOL version — distinct from the per-document
          // `writeHeadVersion` that `rotateOverlayHead` promotes to 2 right
          // after the admission COMMIT. (`maybeRotateOverlayHead` only READS
          // that field as a rotation gate.) Same digit today, different fields,
          // free to diverge.
          meta.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
        })
        await this.repo.flush([metaHandle.documentId])
      }

      // T-ZEROWM (B): `published` means the DURABLE ModelMeta names the new
      // head, not this handle. Measured (`rotationShutdown.integration.test.ts`):
      // a handle evicted while the rotation held it (stop(), any lease release)
      // takes the change in memory only — `repo.flush` saves nothing for it —
      // and the URL read back below from that same handle said `published`.
      // Not durable: the row stays `admitted`, re-derived by
      // `recoverAdmittedOverlayRotations` on the next tick or boot, which
      // re-resolves the ModelMeta and redoes the change (or finds it durable).
      const requiredHeads = automergeHeadsOrNull(metaHandle.doc()) ?? []
      if (!(await this.metaChangeIsDurable(metaHandle, requiredHeads))) {
        console.warn(JSON.stringify({
          event: 'read_model.overlay_rotation_publish_not_durable',
          workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
          kind,
          oldDocumentId,
          newDocumentId,
        }))
        return false
      }

      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      const publishedUrl = readMetaUrl(metaHandle.doc(), currentField)
      const publishedDocumentId = publishedUrl ? documentIdOf(publishedUrl) : undefined
      if (publishedDocumentId !== newDocumentId) {
        await client.query(
          `UPDATE read_model_overlay_rotations SET status = 'superseded'
           WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
             AND new_document_id = $4 AND status = 'admitted'`,
          [descriptor.landscapeId, descriptor.versionId, kind, newDocumentId],
        )
        // The ModelMeta flush did not take, so this child never becomes
        // current and its retention pin has to go with the status. Same reason
        // as the branch above.
        await releaseSupersededOverlaySegment(client, descriptor, kind, newDocumentId)
        await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
        await client.query('COMMIT')
        inTransaction = false
        return false
      }
      await client.query(
        `UPDATE read_model_overlay_segments
         SET is_current = false,
             retired_at = COALESCE(retired_at, now()),
             retain_until = COALESCE(retain_until, now() + ($5::int * interval '1 day'))
         WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
           AND document_id <> $4 AND is_current`,
        [descriptor.landscapeId, descriptor.versionId, kind, newDocumentId,
          OVERLAY_RETENTION_DAYS],
      )
      await client.query(
        `UPDATE read_model_overlay_segments
         SET is_current = true, retired_at = NULL, retain_until = NULL
         WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
           AND document_id = $4`,
        [descriptor.landscapeId, descriptor.versionId, kind, newDocumentId],
      )
      await client.query(
        `UPDATE read_model_overlay_rotations
         SET status = 'published', published_at = COALESCE(published_at, now())
         WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
           AND new_document_id = $4`,
        [descriptor.landscapeId, descriptor.versionId, kind, newDocumentId],
      )
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await client.query('COMMIT')
      inTransaction = false
      return true
    } finally {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    }
  }

  /** T-ZEROWM (B): every change in `requiredHeads` (the ModelMeta's heads
   * right after the rotation's change — or, when the change was already made,
   * when this publication read it) is in the DURABLE ModelMeta. Durable heads
   * are strictly decoded from storage; the inclusion is read off the live
   * document: the durable heads must be known to it, and none of the changes
   * it holds beyond them may be a required one. Later changes (ModelMeta
   * churn) are irrelevant — the durable state only has to CONTAIN the
   * rotation's change, not equal the handle. A handle
   * evicted under the rotation saves nothing, so its change never appears in
   * storage: false, every attempt. Re-flushed and re-read at most
   * {@link ROTATION_DURABILITY_ATTEMPTS} times. A Repo without storage has
   * nothing to be durable in and answers true (tests' in-memory repos). A
   * failed read (the decoder closed at shutdown, a SQL error) is NOT a proof:
   * false. */
  private async metaChangeIsDurable(
    metaHandle: DocHandle<StaticMetaLike>,
    requiredHeads: readonly string[],
  ): Promise<boolean> {
    const storage = this.repo.storageSubsystem
    if (!storage) return true
    const documentId = metaHandle.documentId
    for (let attempt = 0; attempt < ROTATION_DURABILITY_ATTEMPTS; attempt += 1) {
      let durable: readonly string[] | undefined
      try {
        const prepared = await prepareDocumentWatermarkProofs(this.db, [{
          documentId, drainPendingSaves: () => storage.drainDocumentSaves(documentId),
        }], durableHeadsMemo)
        durable = prepared.durableHeadsById.get(documentId)
      } catch {
        return false
      }
      const live = metaHandle.doc() as Doc<unknown> | undefined
      if (durable && live) {
        try {
          if (hasHeads(live, [...durable])) {
            const beyondDurable = new Set(getChangesSince(live, [...durable]).map((change) => decodeChange(change).hash))
            if (requiredHeads.every((head) => !beyondDurable.has(head))) return true
          }
        } catch {
          // An unreadable comparison is not a proof; flush and read again.
        }
      }
      await this.repo.flush([documentId])
    }
    return false
  }

  private async recoverAdmittedOverlayRotations(): Promise<void> {
    // A HEAD guard as well as the per-row one below: with `start()` parked on
    // its first statement and `stop()` awaited to completion, this method's
    // close statement and its admitted-rotations SELECT would otherwise still
    // be issued afterwards.
    if (this.stopped) return
    // A merged/discarded Draft is no longer routable and deliberately has no
    // active descriptor or ownership lease. Any rotation admitted just before
    // that terminal transition can therefore never be published. Close those
    // historical intents explicitly so the recovery queue represents only
    // actionable active workspaces and operational health never stays yellow
    // forever because of an already-finished Draft.
    //
    // One statement, because closing the intent and releasing the child's
    // retention pin are one fact. A rotation left `admitted` when its version
    // stops being active can never be published, and its segment row carries
    // `retain_until IS NULL`, which the GC reads as a reachability root with no
    // expiry. This is the only one of the superseded exits that is set-based,
    // hence the CTE rather than a call to the helper.
    //
    // WHAT THIS DOES NOT DO: it does NOT make the abandoned child collectable. For a workspace
    // that still has its authority row, `gc.ts` marks reachability for a static
    // workspace from `automerge_document_workspace UNION
    // read_model_static_documents`, unconditionally and with no retention
    // predicate — and the child has a row in BOTH by the time it can be
    // superseded (`claimWorkspaceDocuments`, then `registerStaticReadModel-
    // Documents`). The segment row is one of THREE roots, and releasing it
    // frees nothing while the other two stand. What this buys is the state
    // AFTER a demotion, when the static branch of `gc.ts` no longer applies and
    // the segment root is the one that would otherwise never expire. Reaping
    // the other two would be a durable DELETE on a claim (precedent:
    // `degenerateRootRepair`, `staticRegistryReferenceRepair`) and is
    // deliberately not done here.
    //
    // ORDERING: this touches `read_model_overlay_rotations` and then
    // `read_model_overlay_segments`; `publishAdmittedRotation`'s success path
    // touches them the other way round under the overlay advisory lock, which
    // this statement does not hold. A data-modifying CTE gives no control over
    // intra-statement acquisition order, and splitting it would duplicate the
    // closable-rotation predicate — two copies that must agree, which is worse.
    // So the deadlock is TOLERATED rather than prevented: Postgres breaks it
    // with 40P01, the pass is idempotent, and the next tick redoes it.
    //
    // WHAT IS AND IS NOT BOUNDED. `SKIP LOCKED` is on the
    // `candidates` scan of `read_model_overlay_rotations` ONLY. The outer
    // `read_model_overlay_segments` UPDATE takes ordinary row locks, so a
    // publisher holding segment rows — `publishAdmittedRotation` holds them
    // before it touches the rotation row — is still waited on, and since this
    // statement holds the rotation row by then, that pairing is a genuine ABBA
    // resolved at `deadlock_timeout` with the 40P01 the catch tolerates. Under
    // contention 40P01 is the EXPECTED outcome here, not the exotic one.
    //
    // Residual: a RELATION lock —
    // an additive migration queueing AccessExclusive on either table — is
    // covered by neither `SKIP LOCKED` nor any ceiling on this path, and this
    // statement is reached from `start()`, which the caller awaits before
    // publishing readiness. What
    // must not happen is one aborted statement taking the rest of the tick —
    // and, from `start()`, projector startup — with it.
    await this.closeInactiveAdmittedRotations().catch((error: unknown) => {
      // Both tolerated codes mean "somebody else is mid-write" and nothing
      // more: the statement is idempotent, the rows stay `admitted`, and the
      // next tick re-derives them. Anything else is real and must not be
      // swallowed.
      //
      // Where each can still come from, given that `SKIP LOCKED` removes the
      // ROW-lock wait on the candidates:
      //   40P01  the segments UPDATE still takes row locks in the opposite
      //          order from `publishAdmittedRotation`'s success path, and a
      //          data-modifying CTE gives no control over that;
      //   55P03  this statement sets no ceiling of its own, so this arrives
      //          only if one is set OUTSIDE it — a role- or database-level
      //          `lock_timeout` — while it waits on a RELATION lock, which
      //          `SKIP LOCKED` does not cover. Rare, not impossible, and the
      //          right response is the same one.
      //
      // `(error as {code?: string}).code` is the right read: node-postgres
      // rejects with the raw `DatabaseError` carrying `code`, with no wrapping
      // layer between.
      const code = (error as { code?: string })?.code
      if (code !== '40P01' && code !== '55P03') throw error
      console.warn(`[read-model] admitted-rotation close gave up (${code}); the next pass redoes it`)
      return undefined
    })
    const { rows } = await this.db.query<{
      landscape_id: string
      version_id: string
      collection: 'object' | 'connection'
      old_document_id: string
      new_document_id: string
      new_segment_url: string
    }>(
      `SELECT landscape_id, version_id, collection, old_document_id,
              new_document_id, new_segment_url
       FROM read_model_overlay_rotations
       WHERE status = 'admitted'
       ORDER BY created_at
       LIMIT 1000`,
    )
    for (const row of rows) {
      // Per ROW, because this loop spans up to 1 000 rows each doing a
      // `db.connect()`, an advisory lock attempt and a `repo.flush`. A SIGTERM
      // landing in it would otherwise keep borrowing connections from a pool
      // `stop()` has already been told to let go of.
      if (this.stopped) return
      const descriptor = [...this.descriptors.values()].find((candidate) => (
        candidate.landscapeId === row.landscape_id
        && candidate.versionId === row.version_id
        && candidate.kind === 'model-meta'
      ))
      if (!descriptor || !this.ownsWorkspace(descriptor)) continue
      // The plane, PER ROW, on purpose: this loop spans up
      // to 1 000 admitted rotations across every workspace, so one demoted
      // workspace among them must be skipped rather than abort the pass.
      // `publishAdmittedRotation` mutates ModelMeta and flushes it, which the
      // SQL gate at the end cannot undo.
      if (!(await this.holdsStaticPlane(descriptor))) continue
      const metaHandle = await this.resolveDocumentHandle<StaticMetaLike>(descriptor.documentId)
      const client = await this.db.connect()
      const lockKey = overlayRotationLockKey(row.landscape_id, row.version_id, row.collection)
      let lock: OverlayRotationLockState = 'unknown'
      try {
        lock = await acquireOverlayRotationLock(client, lockKey)
        // `!== 'acquired'` — see `rotateOverlayHead` for why the negative test
        // is the wrong one with three states.
        if (lock !== 'acquired') {
          // Refuse, never wait. This pass runs on `reloadTail` and `start()`
          // AWAITS it before installing either interval, so a blocking wait
          // would leave a pod starting while another pod folds a long overlay
          // chain unable to finish starting, reconcile or publish readiness —
          // the holder spans `repo.create` and two `repo.flush`es, and a leaked
          // key would make it permanent.
          //
          // Skipping is exactly what `closeInactiveAdmittedRotations` does with
          // `SKIP LOCKED` above, for the same reason: the row is
          // re-selected by this function's own `status = 'admitted'` query on
          // the next reload tick.
          reportOverlayRotationLockContended({
            path: 'recover-admitted',
            landscapeId: row.landscape_id,
            versionId: row.version_id,
            kind: row.collection,
            state: lock,
          })
          continue
        }
        await this.publishAdmittedRotation(
          client, descriptor, metaHandle, row.collection, row.old_document_id,
          row.new_document_id, row.new_segment_url,
        )
      } catch (error) {
        // The "per row on purpose" contract above, for EVERY error — not only
        // authority losses. `publishAdmittedRotation`'s transactions carry
        // `SET LOCAL lock_timeout`, so it can raise **55P03** when the plane's
        // `FOR KEY SHARE` waits behind a demotion or a `clearWorkspace`, and
        // the CTE above can raise **40P01**. Neither is an authority loss.
        //
        // What escaping would cost is out of all proportion to the row: from the
        // tick it skips `recoverChangedDocuments`,
        // `recoverCurrentOverlayRotationObligations`, the fold scheduler and
        // the resident scan for EVERY workspace in the process; from `start()`
        // it rejects, and `index.ts` logs and swallows that — so the timers are
        // never installed, readiness is never published, and the pod is left
        // listening and never reconciling.
        //
        // Not `isProjectionMutexTimeout` either: its own docstring forbids that
        // use where several statements in the transaction can raise 55P03, and
        // here four plane checks and three UPDATEs can. Every other step in
        // this tick chain swallows per item; this one does too. The pass
        // is idempotent and re-derived from `read_model_overlay_rotations` on
        // every tick, so a rethrow buys nothing at all.
        if (!isReadModelAuthorityLoss(error)) {
          console.error(
            `[read-model] admitted rotation recovery failed for ${row.landscape_id}/${row.version_id}`,
            error,
          )
        }
      } finally {
        // `continue` above runs this too, which is the point of putting the
        // hand-back in a `finally` rather than beside each exit.
        await releaseOverlayRotationLock(client, lockKey, lock)
      }
    }
  }

  /**
   * SCHEDULE a chain fold for every overlay chain that has outgrown its
   * threshold. It deliberately does NOT await the work.
   *
   * Running the fold inline on the `reloadTail` chain would hold a SESSION
   * advisory lock while a ModelMeta projection asks for `pg_advisory_xact_lock`
   * on the same key from another connection of a pool capped at four — a
   * cross-connection wait that empties the pool instead of resolving. So the
   * task is installed on `workspaceTails` exactly as `scheduleOverlayRotation`
   * installs a rotation, and the caller moves on.
   *
   * It publishes NO health signal: a pass reporting from inside itself reports
   * only on how far it got.
   */
  private scheduleOverlayChainFolds(): void {
    if (this.stopped) return
    const minChain = this.overlayFoldMinChain ?? OVERLAY_CHAIN_FOLD_MIN
    for (const metaDescriptor of this.descriptors.values()) {
      if (metaDescriptor.kind !== 'model-meta') continue
      if (!this.ownsWorkspace(metaDescriptor)) continue
      const workspace = keyOf(metaDescriptor)
      const state = this.overlayState.get(workspace)
      if (!state) continue
      for (const kind of OVERLAY_KINDS) {
        const chainKey = `${workspace}\u0000${kind}`
        // Never race the rotation protocol: both take the same advisory key,
        // and a fold queued behind a rotation would plan against a list the
        // rotation is about to change. `foldingChains` is the fold's own twin
        // of `rotatingHeads`.
        if (this.foldingChains.has(chainKey)) continue
        if (this.rotatingHeads.has(chainKey) || this.pendingRotations.has(chainKey)) continue
        const chain = kind === 'object' ? state.objectDocumentIds : state.connectionDocumentIds
        // The RETIRED chain is everything but the write head — the same count
        // `planOverlayChainFold` will apply the threshold to. Testing the whole
        // list here would queue a task the planner then refuses, every tick.
        if (chain.length - 1 < minChain) continue
        this.foldingChains.add(chainKey)
        const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
        const task = previous.then(async () => {
          if (!this.stopped && this.ownsWorkspace(metaDescriptor)) {
            await this.foldOverlayChain(metaDescriptor, kind)
          }
        }).catch((error) => {
          console.error(`[read-model] ${kind} overlay chain fold failed`, error)
        }).finally(() => {
          this.foldingChains.delete(chainKey)
        })
        this.workspaceTails.set(workspace, task.then(() => undefined, () => undefined))
      }
    }
  }

  /**
   * Fold the oldest contiguous prefix of a workspace's retired overlay
   * segments into merged segment(s), and substitute them in ModelMeta.
   *
   * Everything else only ever appends to `editsObjectShardUrls`, so without
   * this a promoted workspace that is actually being edited grows ModelMeta, this projector's
   * in-memory `StaticOverlayState`, and the cost of a full rebuild without
   * bound — one Automerge document and three Postgres rows per 32 write
   * batches, for ever.
   *
   * This is NOT `compactOverlay`, and the difference is a data-loss defect:
   * that routine folds overlay values into the BASE shards and clears the
   * entries. This projector never opens a base shard, and a cleared entry makes
   * `updateStaticOverlaySegment` find no winner, which it turns into a DELETE —
   * the row leaves `ro_objects` while the CRDT stays perfectly correct. The
   * fold therefore stays inside the overlay world, where the effective set is
   * unchanged by construction and the pass emits no deletes at all.
   *
   * ORDER IS THE WHOLE DESIGN. Create, flush, prove durability against a
   * WITNESS, claim, admit, write the merged segment's row WITH its snapshot,
   * and only then publish ONE ModelMeta change. Every earlier step is
   * re-derivable from a pure function of ModelMeta, so a crash anywhere before
   * that change leaves the system correct and the next pass converges — which
   * is why there is no intent table here, unlike rotation.
   *
   * THE PRICE — an orphaned merged segment — needs no crash:
   *
   *  - `plan-moved` and the post-COMMIT `prefix-not-substitutable` are
   *    ORDINARY returns, and by then the merged segments are created, flushed,
   *    claimed, allow-listed, given `read_model_overlay_segments` rows carrying
   *    their full snapshots, and granted 30 days of retention — all committed,
   *    with nothing in ModelMeta pointing at them.
   *  - the window between COMMIT and the ModelMeta change contains
   *    `metaHandle.doc()`, a re-plan, an Automerge `change` on the workspace's
   *    hottest control document and `await this.repo.flush(...)` — at minimum
   *    one storage round trip.
   *
   * The re-plan compares DOCUMENT IDS rather than decorated url strings, so a
   * decoration alone cannot trigger `plan-moved`. A genuine concurrent
   * rotation moving the window still can, and the orphan it leaves is
   * PERMANENT rather than GC fodder, for the reason recorded at the retention
   * UPDATE below.
   */
  private async foldOverlayChain(
    metaDescriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
  ): Promise<void> {
    const startedAt = performance.now()
    // The plane, at ENTRY — see `rotateOverlayHead`. A fold creates a merged
    // segment, claims it and rewrites ModelMeta's overlay list, none of which
    // the SQL gate at the end can undo.
    if (!(await this.holdsStaticPlane(metaDescriptor))) return
    const currentField = kind === 'object' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl'
    const segmentsField = kind === 'object' ? 'editsObjectShardUrls' : 'editsConnectionShardUrls'
    const shardsField = kind === 'object' ? 'objectShardUrls' : 'connectionShardUrls'
    // The sizes that make sealing and the window budget possible, taken from
    // the projector's OWN in-memory segment map.
    //
    // Not `last_projected_snapshot` (a SQL round trip per pass for a number we
    // already hold), and not resolving the documents to measure them (the very
    // multi-second cold load the bound exists to prevent). `objectSegments` is already materialised — the
    // projector cannot project without it — so this is free.
    //
    // A segment this process has not yet materialised reads `undefined`, which
    // `planOverlayChainFold` treats as UNSEALED and as contributing zero to the
    // window. That direction is deliberate and documented at the option: the
    // opposite would make a cold projector unable to fold anything at all.
    const overlayStateForSizes = this.overlayState.get(keyOf(metaDescriptor))
    const liveSegments = overlayStateForSizes
      ? (kind === 'object' ? overlayStateForSizes.objectSegments : overlayStateForSizes.connectionSegments)
      : undefined
    // FROZEN, not a live reference. The map is
    // mutated in place by `updateStaticOverlaySegment` and replaced wholesale by
    // `projectMeta` and `rotateOverlayHead`, so holding the reference would let
    // the re-plan under the lock compute a DIFFERENT window because the
    // projector's in-memory state moved, with no ModelMeta change at all. A
    // differing window is `plan-moved`, which by then has committed the claim,
    // the allow-list rows, the snapshots and the retention — a permanent orphan
    // on the static plane. Both plans read this same snapshot, so only ModelMeta
    // can move the window, which is what the guard is about.
    const segmentSizes = liveSegments
      ? new Map([...liveSegments].map(([id, segment]) => [id, Object.keys(segment).length]))
      : undefined
    // ONE resolution of each, used by BOTH the planner and the split: if they
    // disagreed (e.g. the planner sealing at an injected 3 while the split cut
    // at the module's 1 024), a window of 4 entities would come back as ONE
    // document.
    const segmentCeiling = this.overlayFoldSegmentCeiling ?? OVERLAY_SEGMENT_ENTITY_CEILING
    const windowCeiling = this.overlayFoldWindowEntities ?? OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES
    const options = {
      minChain: this.overlayFoldMinChain,
      budget: this.overlayFoldBudget,
      segmentCeiling,
      windowEntities: windowCeiling,
      entityCountOf: (url: string): number | undefined => segmentSizes?.get(documentIdOf(url)),
    }
    const metaHandle = await this.resolveDocumentHandle<StaticMetaLike>(metaDescriptor.documentId)
    // The SAME advisory key as rotation, byte for byte. A key of its own would
    // let a fold and a rotation both try to write `read_model_overlay_segments`
    // and collide on `idx_read_model_overlay_segments_current`. One function
    // mints it.
    const lockKey = overlayRotationLockKey(metaDescriptor.landscapeId, metaDescriptor.versionId, kind)
    let inTransaction = false
    let chainBefore = 0
    let chainAfter = 0
    let chainBeforeRaw = 0
    let chainAfterRaw = 0
    let folded = 0
    let entities = 0
    let mergedDocumentId: string | undefined
    let skippedReason: string | undefined
    // ONE fold in flight per process, all workspaces together. `foldingChains`
    // only serialises one chain; a pod that regains six promoted workspaces
    // schedules six passes at once, and each would hold a connection of a pool
    // capped at four. Refusing is correct rather than queueing: the next
    // descriptor reload reschedules in 10 s.
    if (this.overlayFoldInFlight) return
    this.overlayFoldInFlight = true
    let client: PoolClient | undefined
    let lock: OverlayRotationLockState = 'unknown'
    // See `rotateOverlayHead`: the FOLD is the long holder — `repo.create` plus
    // two `repo.flush`es — and it is what a same-workspace publish waits behind
    // with no ceiling. This is that number, taken on every pass.
    let lockAcquiredAt: number | undefined
    try {
      if (!this.ownsWorkspace(metaDescriptor)) { skippedReason = 'not-owner'; return }
      const live = metaHandle.doc()
      if (!live) { skippedReason = 'no-model-meta'; return }
      const meta = withMetaUrlView(live)
      const rawListed = [...(meta[segmentsField] ?? [])]
      const listed = unique(rawListed)
      chainBefore = listed.length
      chainAfter = listed.length
      chainBeforeRaw = rawListed.length
      chainAfterRaw = rawListed.length
      const plan = planOverlayChainFold(listed, meta[currentField], options)
      if (!plan.fold.length) { skippedReason = plan.skippedReason ?? 'nothing-to-fold'; return }

      // DRY RUN, before anything durable exists. `substituteOverlayPrefix` can
      // refuse, and every step below it — create, flush, claim, admit, the
      // segment row, the 30-day retention — is unconditional. A refusal
      // discovered afterwards leaks one claimed, admitted, GC-PROTECTED
      // document per pass, every 10 s, for ever.
      if (!substituteOverlayPrefix(
        { [segmentsField]: [...rawListed] } as StaticMetaLike,
        segmentsField, plan.fold, ['automerge:dry-run'], true, true, meta[currentField],
      )) {
        skippedReason = 'prefix-not-substitutable'
        return
      }

      // THE CONTENT COMES FROM THE DOCUMENTS, never from
      // `last_projected_snapshot`. That column is fed by this very projector,
      // so reading it here would make the fold its own witness — and it is
      // `NOT NULL DEFAULT '{}'`, so a segment the projector had not yet
      // snapshotted would silently fold to EMPTY. One unresolvable document
      // aborts the whole pass for the same reason: treating it as `{}` drops
      // every entity that lived only there, invisibly, and the loss surfaces
      // days later one entity at a time.
      //
      // Resolved BEFORE the pool connection is taken. A retired segment's
      // content is immutable, and the re-planning under the lock below already
      // revalidates freshness — so there is no reason to hold one of four
      // read-model connections across a wait that is bounded only by 30 s.
      const deadline = AbortSignal.timeout(OVERLAY_CHAIN_FOLD_RESOLVE_MS)
      const contents: Record<string, ObjectInput | ConnectionInput>[] = []
      // THE BUDGET IS ENFORCED HERE, on TRUE counts, not only in the planner.
      //
      // The planner works from `entityCountOf`, which reads this projector's
      // in-memory snapshot map and answers `undefined` for any segment it has
      // not materialised — and the planner counts `undefined` as ZERO toward
      // the window. On a COLD projector — exactly the path this bound exists
      // for — a window planned as 992 entities can merge ~13 000, issuing a
      // dozen `repo.create` calls inside the advisory lock. The estimate is
      // unusable as a bound because the case it is wrong about is the case
      // that matters.
      //
      // Resolving is the first moment the true size is known, so it is the only
      // honest place to stop. Segments already resolved are kept — the window
      // is a contiguous run, so any PREFIX of it is also a contiguous run and
      // is still order-preserving.
      //
      // A one-segment window is the REPAIR pass (splitting an oversized
      // segment) and is taken whole: it cannot be made smaller by stopping
      // early, and refusing it would leave an over-ceiling segment permanently
      // unrepairable.
      const foldedUrls: string[] = []
      const seen = new Set<string>()
      for (const url of plan.fold) {
        const handle = await this.resolveDocumentHandle<ObjectOverlayLike & ConnectionOverlayLike>(
          documentIdOf(url), deadline,
        )
        const doc = plain<ObjectOverlayLike & ConnectionOverlayLike>(handle.doc())
        const segment = (kind === 'object' ? doc.objects : doc.connections) ?? {}
        const ids = Object.keys(segment)
        const wouldBe = new Set(seen)
        for (const id of ids) wouldBe.add(id)
        if (foldedUrls.length >= 2 && wouldBe.size > windowCeiling) break
        contents.push(segment)
        foldedUrls.push(url)
        for (const id of ids) seen.add(id)
      }
      if (foldedUrls.length === 0) { skippedReason = 'nothing-resolved'; return }
      const merged = foldOverlaySegmentContents(contents)
      entities = Object.keys(merged).length

      client = await this.db.connect()
      lock = await acquireOverlayRotationLock(client, lockKey)
      if (lock === 'acquired') lockAcquiredAt = performance.now()
      // `!== 'acquired'` — see `rotateOverlayHead`.
      if (lock !== 'acquired') {
        // A named `skippedReason` and not a silent return: this function's own
        // log line exists because "a pass that refuses for ever is otherwise
        // indistinguishable from a pass that is working", and a contended key
        // is precisely such a refusal. `scheduleOverlayChainFolds` re-derives
        // the obligation on the next tick, exactly as it does for
        // `overlayFoldInFlight` above.
        //
        // The PERMANENT case has a runnable detector: `npm run fsck`'s
        // `overlay-chain-bounded` is precisely "the chain folder is running",
        // which is what a fold starved for ever stops being true of.
        skippedReason = 'lock-contended'
        reportOverlayRotationLockContended({
          path: 'fold',
          landscapeId: metaDescriptor.landscapeId,
          versionId: metaDescriptor.versionId,
          kind,
          state: lock,
        })
        return
      }
      if (!this.ownsWorkspace(metaDescriptor)) { skippedReason = 'not-owner'; return }

      // Create → flush → WITNESS. The watermark is taken BEFORE the create, so
      // the witness proves OUR flush rather than the save `Repo.create` already
      // triggered. The chunk-type filter is not cosmetic either: a document can
      // carry a `/sync-state/` row and no content at all.
      const watermark = await captureArrivalWatermark(client)
      // The merge is cut into segments of at most
      // `OVERLAY_SEGMENT_ENTITY_CEILING` entities instead of becoming ONE
      // document. `plan.fold` already bounds the pass at
      // `OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES`, so this is normally one or two
      // parts; it is more only when the window admitted its mandatory two
      // segments and they were larger than the budget.
      const parts = splitMergedOverlaySegment(merged, segmentCeiling)
      const children = parts.map((part) => (kind === 'object'
        ? this.repo.create<ObjectOverlayLike>({
          objects: part as Record<string, ObjectInput>, writeHeadVersion: 2, writeBatchIds: [],
        })
        : this.repo.create<ConnectionOverlayLike>({
          connections: part as Record<string, ConnectionInput>, writeHeadVersion: 2, writeBatchIds: [],
        })))
      const childIds = children.map((child) => child.documentId)
      mergedDocumentId = childIds.join(',')
      await this.repo.flush(childIds)
      // EVERY part is witnessed, not the first. A partial durability result
      // that published anyway would drop precisely the entities that live only
      // in the unflushed part — the failure `foldOverlayChain` refuses a single
      // unresolvable input for, arriving through the output side instead.
      // `GROUP BY` and a count, never `WHERE ... IN` over one id: that is what
      // makes "one part missing" distinguishable from "all present".
      const { rows: witness } = await client.query<{ durable: string }>(
        `SELECT count(*) AS durable FROM (
           SELECT split_part(key, '/', 1) AS document_id
             FROM automerge_storage
            WHERE split_part(key, '/', 1) = ANY($1::text[])
              AND ${documentContentChunkFilter()}
            GROUP BY 1
           HAVING max(arrival_seq) >= $2::bigint
         ) AS durable_parts`,
        [childIds.map(String), watermark],
      )
      if (Number(witness[0]?.durable ?? 0) !== childIds.length) {
        skippedReason = 'merged-segment-not-durable'
        return
      }

      // Claim BEFORE any pointer can reach it, and outside a transaction —
      // same shape as the rotation's claim block, including its refusal to
      // throw: a fold runs inside the projector's health machinery, so a claim
      // failure de-covers the workspace and the merged segment is simply never
      // published. No health-row mark, for the reasons given there: this
      // `catch` returns before `BEGIN`, so the read model is complete, and no
      // code could ever retract the mark. `scheduleOverlayChainFolds`
      // re-derives the fold obligation on every reload tick.
      try {
        const claims = await claimWorkspaceDocuments(client, metaDescriptor, childIds.map(String))
        if (claims.missingVersion || claims.foreign.length > 0) {
          throw new Error(claims.missingVersion
            ? `overlay chain fold for ${metaDescriptor.landscapeId}/${metaDescriptor.versionId} has no versions row`
            : `folded ${kind} segment is already owned by `
              + `${claims.foreign[0]!.winner.landscapeId}/${claims.foreign[0]!.winner.versionId}`)
        }
      } catch (claimError) {
        console.error(`[read-model] ${kind} overlay chain fold could not claim its merged segment`, claimError)
        // Loud for the same reason as the rotation's: this is the only durable
        // trace, so swallowing its failure would make the incident invisible.
        await invalidateWorkspaceCoverage(
          client, metaDescriptor,
          `overlay chain fold claim failed: ${String((claimError as Error).message ?? claimError)}`,
        ).catch((coverageError) => {
          console.error(
            `[read-model] ${kind} overlay chain fold could not de-cover its workspace either`, coverageError,
          )
        })
        skippedReason = 'claim-failed'
        return
      }

      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, metaDescriptor, this.expectedOwnershipFence(metaDescriptor))
      await registerStaticReadModelDocuments(client, metaDescriptor, childIds.map((documentId) => ({
        documentId,
        kind: kind === 'object' ? 'object-overlay' as const : 'connection-overlay' as const,
      })))
      // Each merged segment's row carries ITS OWN snapshot, and this is the
      // single most important line of the pass. Substituting a window is not an
      // append-only change, so the next ModelMeta projection rebuilds
      // `objectSegments` and `effectiveObjects` EXCLUSIVELY from this column.
      // A rotation-shaped row (url only) would leave it at its `'{}'` default —
      // a value, not an absence — and the rebuild would silently drop every
      // entity that lived only in the folded window.
      //
      // PER PART, never `merged` for all of them: writing the whole map against
      // each part would make every part claim every entity, and the rebuild
      // would then read the LAST part as the winner for ids that belong to the
      // first — an inversion invisible to every existing assertion, because the
      // effective SET would still be complete.
      for (let at = 0; at < childIds.length; at += 1) {
        await recordOverlaySegmentProjection(
          client, metaDescriptor, kind, childIds[at]!, 0, parts[at]!,
        )
      }
      // Refresh retention BEFORE the substitution, never after. Extending a
      // retention too early is harmless; too late is not.
      //
      // NOTE the GC cannot collect these here anyway: this pass refuses unless
      // `holdsStaticPlane`, so the workspace is STATIC, and for a static root
      // reachability in `gc.ts` is
      // `automerge_document_workspace` union `read_model_static_documents` —
      // the ModelMeta walk and the `retain_until` root are never consulted. The
      // fold claims and allow-lists its output and removes the folded segments
      // from NEITHER table, and no production statement deletes from
      // `read_model_overlay_segments` at all. So a claimed document is a
      // self-sustaining GC root: nothing can collect it, expired retention or
      // not.
      //
      // Two consequences. `retain_until` has no reaper on this plane — every
      // reader treats it as a protection, never as an expiry — so this UPDATE
      // buys ordering safety on the ORDINARY plane and bookkeeping here. And
      // the orphan an abandoned pass leaves (see the docstring) is permanent.
      await client.query(
        `UPDATE read_model_overlay_segments
            SET retired_at = COALESCE(retired_at, now()),
                retain_until = GREATEST(COALESCE(retain_until, now()),
                  now() + ($5::int * interval '1 day'))
          WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
            AND document_id = ANY($4::text[]) AND NOT is_current`,
        [metaDescriptor.landscapeId, metaDescriptor.versionId, kind,
          [...childIds, ...foldedUrls.map(documentIdOf)], OVERLAY_RETENTION_DAYS],
      )
      await this.assertPlaneAndOwnership(client, metaDescriptor, this.expectedOwnershipFence(metaDescriptor))
      await client.query('COMMIT')
      inTransaction = false

      // Re-plan under the lock. Resolving documents and flushing took real
      // time; if the chain moved, this merged segment becomes an orphan and
      // the next pass re-derives a correct plan. Publishing a stale prefix
      // would reorder last-wins.
      const freshLive = metaHandle.doc()
      const freshMeta = freshLive ? withMetaUrlView(freshLive) : undefined
      const fresh = planOverlayChainFold(
        unique(freshMeta?.[segmentsField] ?? []), freshMeta?.[currentField], options,
      )
      // COMPARED BY DOCUMENT ID, not by the raw string.
      // `substituteOverlayPrefix` deliberately matches on `documentIdOf`
      // "because the lists can carry decorated urls (`automerge:xxx?foo`)", so a
      // raw-string comparison here is strictly STRICTER than the operation it
      // guards — and it would fail INTO the abandonment path below, which by
      // then has already committed the claim, the allow-list rows, the
      // snapshots and the retention extension, on a decoration alone.
      const sameWindow = fresh.fold.length === plan.fold.length
        && fresh.fold.every((url, at) => documentIdOf(url) === documentIdOf(plan.fold[at]!))
      if (!sameWindow) {
        skippedReason = 'plan-moved'
        return
      }

      // ONE change, on BOTH lists. Two changes would open a window in which the
      // folded entities are in no listed segment at all — and ModelMeta's own
      // change listener projects that window. Both lists, because rotation
      // appends to both and leaving `objectShardUrls` untouched would keep it
      // growing 1:1 while also keeping the folded ids reachable, which would
      // make `overlay-segment-retained` unreachable.
      const mergedUrls = children.map((child) => child.url)
      let substituted = false
      metaHandle.change((mutable) => {
        substituted = substituteOverlayPrefix(
          mutable, segmentsField, foldedUrls, mergedUrls, true, true, readMetaUrl(mutable, currentField),
        )
        if (!substituted) return
        // `requireContiguous: false` — see the parameter's docstring. This list
        // interleaves the MODEL base shards with overlay routes, so the folded
        // window is legitimately non-adjacent in it and a contiguity refusal
        // here would break every fold. It is not the last-wins authority.
        substituteOverlayPrefix(mutable, shardsField, foldedUrls, mergedUrls, false, false)
      })
      // The refusal must LEAVE the callback. Assigning `folded` unconditionally
      // would make the log announce `folded: N` for a pass that changed
      // nothing.
      if (!substituted) { skippedReason = 'prefix-not-substitutable'; return }
      await this.repo.flush([metaHandle.documentId])
      folded = foldedUrls.length
      chainAfter = unique(readMetaUrls(metaHandle.doc(), segmentsField) ?? []).length
      chainAfterRaw = (readMetaUrls(metaHandle.doc(), segmentsField) ?? []).length
    } catch (error) {
      if (inTransaction && client) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      this.overlayFoldInFlight = false
      const lockHeldMs = lockAcquiredAt === undefined
        ? null
        : Math.round((performance.now() - lockAcquiredAt) * 100) / 100
      if (client) await releaseOverlayRotationLock(client, lockKey, lock)
      const durationMs = performance.now() - startedAt
      // A pass that refuses for ever — `head-not-listed` is the realistic one —
      // is otherwise indistinguishable from a pass that is working. The
      // ordinary below-threshold refusal is the exception: it is the common
      // case and would drown the log, so it speaks only when it was slow.
      //
      // `lock-contended` is deliberately NOT in the quiet list, although a
      // contended fold then emits two records — this one and
      // `overlay_rotation_lock_contended`. Quieting it would make the
      // `skippedReason = 'lock-contended'` assignment unobservable (and so
      // untestable), and the two lines are not duplicates: this one carries
      // the chain lengths and `lockHeldMs`, the other the refusal streak and
      // its age.
      const noisy = folded > 0 || (skippedReason !== undefined
        && skippedReason !== 'chain-below-threshold' && skippedReason !== 'not-owner')
      if (noisy || durationMs >= 50) console.warn(JSON.stringify({
        event: 'read_model.overlay_chain_folded',
        kind,
        landscapeId: metaDescriptor.landscapeId,
        versionId: metaDescriptor.versionId,
        // The hold time, `null` when the key was never taken. This is what a
        // same-workspace publish waits behind with `lock_timeout = 0`.
        lockHeldMs,
        chainBefore,
        chainAfter,
        // The RAW lengths too. Both figures above pass through `unique()`, so a
        // duplicated url — a condition that can freeze a fold —
        // is invisible in them. An operator reading only the deduplicated pair
        // has no way to tell a healthy no-op from a jammed chain.
        chainBeforeRaw,
        chainAfterRaw,
        folded,
        entities,
        mergedDocumentId,
        skippedReason,
        durationMs: Math.round(durationMs * 100) / 100,
      }))
    }
  }

  /**
   * Register a registry write head the CLIENT provisioned.
   *
   * `read_model_static_documents` is written by promotion
   * (`promoteSummaryWorkspace`), by the offline repairs and by the sparse
   * draft. None of those is a live path. But the client bridge handles the
   * case where the declared head is not resolved when the first write happens
   * (a degraded or offline boot): `findOrCreateSummaryWriteShard` CREATES a
   * head and `publishNewRegistryShard` repoints `root.registryWriteUrl` at it.
   * With no row for that document, the queue filter matches nothing and
   * `attach()` returns before it can listen: every diagram written into it is
   * invisible on every server surface, for ever. The fsck check
   * `registry-head-projected` detects that; this is the repair.
   *
   * Deliberately narrow. Only `registryWriteUrl` is registered, never
   * `shardUrls`: the immutable baseline registries are projected by the static
   * baseline build, and enrolling thousands of them as live `registry-shard`
   * documents would put the whole baseline back on the incremental path.
   *
   * Deliberately outside the transaction machinery, too. Root documents are not
   * in the projection queue (`READ_MODEL_QUEUE_DOCUMENT_KINDS`), so there is no
   * revision to acknowledge and nothing to publish; this only writes the
   * admission row and hands the document to the ordinary shard path.
   */
  private async projectRoot(
    descriptor: StaticDocumentDescriptor,
    root: StaticRootLike,
  ): Promise<void> {
    const writeHeadUrl = typeof root.registryWriteUrl === 'string' ? root.registryWriteUrl : ''
    if (!writeHeadUrl) return
    const documentId = documentIdOf(writeHeadUrl)
    if (!documentId) return
    const known = this.descriptors.get(documentId)
    if (known) {
      // A head claimed by ANOTHER workspace is the `shared-root` disease, which
      // fsck reports; silently re-pointing the admission row here would move
      // the damage instead of surfacing it.
      if (keyOf(known) !== keyOf(descriptor)) console.warn(JSON.stringify({
        event: 'read_model.static_write_head_foreign',
        documentId,
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
      }))
      // Otherwise: ALREADY REGISTERED, and this branch does not get to change
      // its kind. A static workspace that is NOT summary can have its
      // `root.registryWriteUrl` registered as `registry`, i.e. an immutable
      // baseline. Re-registering it here would `ON CONFLICT DO UPDATE SET kind`
      // it into `registry-shard` and put a baseline document on the incremental
      // projection path, for no defect at all. Promotion already writes the
      // right kind for a real write head (`assertWriteHeadIsWritable` throws if
      // it cannot), so an existing row is a decision made on better
      // information. The only case this branch owns is NO ROW AT ALL.
      return
    }
    // And "no row at all" is a question for the DATABASE, not for the memo
    // above. `descriptors` is filled by `reloadDescriptors`, so it is a
    // SNAPSHOT of the registration record, not the record: promotion, the
    // static baseline build, the offline repairs and the sparse draft all
    // write `read_model_static_documents` from outside this object, and a row
    // written after this projector's last reload is present in the database
    // and absent here. Registering over it would `ON CONFLICT DO UPDATE SET
    // kind` exactly the baseline document the guard above exists to protect —
    // the same damage, reached through the other door.
    const { rows: existingRows } = await this.db.query<{ kind: string }>(
      `SELECT kind FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [descriptor.landscapeId, descriptor.versionId, documentId],
    )
    const existingKind = existingRows[0]?.kind ?? null
    if (existingKind !== null && existingKind !== 'registry-shard') {
      console.warn(JSON.stringify({
        event: 'read_model.static_write_head_kind_preserved',
        documentId,
        kind: existingKind,
        workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
      }))
      return
    }
    await registerStaticReadModelDocuments(this.db, descriptor, [
      { documentId, kind: 'registry-shard' },
    ])
    const shardDescriptor: StaticDocumentDescriptor = {
      ...descriptor, documentId, kind: 'registry-shard', entityId: null,
    }
    this.descriptors.set(documentId, shardDescriptor)
    console.warn(JSON.stringify({
      event: 'read_model.static_write_head_registered',
      documentId,
      workspace: `${descriptor.landscapeId}/${descriptor.versionId}`,
    }))
    const handle = await resolveHandleWithRetry(
      this.repo, `automerge:${documentId}` as AutomergeUrl,
      { tries: 5, delayMs: 250 },
    )
    this.attach(handle)
    // `immediate`: the head already carries the diagrams that were written into
    // it before anyone knew about it, and nothing else will enqueue them — the
    // queue row is created by the NEXT save, not by this registration.
    this.trigger(shardDescriptor, handle, true)
  }

  /**
   * The diagram tombstones, taken from a DURABILITY WITNESS.
   *
   * The witness is `ModelMeta.deletedDiagramIds` in the Automerge document. The
   * in-memory set is consulted first, but ONLY the one this projector fills
   * from that document on every ModelMeta pass ({@link
   * StaticOverlayState.metaDeletedDiagramIds}), and `undefined` there means
   * "not read yet", never "empty".
   *
   * NOT `overlayState.deletedDiagramIds`, the set of tombstones THIS PROCESS
   * HAS ALREADY APPLIED. That set is seeded empty and only advanced after a
   * publish, so after ANY restart it is empty — while a diagram deleted in an
   * earlier client session keeps its entry in the write head for ever
   * (`writeSummaryLocalRegistry` only walks `summaryLocalDiagramIds`, module
   * state that does not survive a reload). Reading it would let the next
   * creation reproject the whole shard and RESURRECT the deleted diagram,
   * breaking `diagram-tombstone-honoured` possibly for ever. A durability
   * decision must not consult a cache the recovering party feeds itself.
   *
   * Three outcomes, and the third one is the point:
   *  - a ModelMeta pass has run   → the cached fact, free.
   *  - no ModelMeta is registered → no tombstone CHANNEL exists for this
   *    workspace (monolith, or a fixture), so the empty set is the true answer.
   *  - a ModelMeta is registered but does not resolve → THROW. Abstaining costs
   *    one retry of a projection; guessing "no tombstones" costs a resurrected
   *    diagram that repairs itself never.
   *
   * The handle is read WITHOUT `attach()`: attaching a ModelMeta triggers a
   * meta projection, and a meta projection deletes tombstoned rows — so the
   * repair would race in and hide whether this branch honoured the tombstones
   * at all. Cheap in production regardless: the projector already leases
   * ModelMeta, so the resident lookup is a memory read.
   */
  /** The tombstones WITHOUT any resolution: the fact cached by the last
   * ModelMeta pass, the empty set when the workspace has no ModelMeta
   * descriptor (O(1), {@link StaticDescriptorMap.modelMetaOf}), `undefined`
   * when one is registered but not read yet. */
  private knownDiagramTombstones(descriptor: WorkspaceKey): ReadonlySet<string> | undefined {
    const known = this.overlayState.get(keyOf(descriptor))?.metaDeletedDiagramIds
    if (known) return known
    return this.descriptors.modelMetaOf(descriptor) ? undefined : EMPTY_DIAGRAM_TOMBSTONES
  }

  private async durableDeletedDiagramIds(
    descriptor: StaticDocumentDescriptor,
  ): Promise<ReadonlySet<string>> {
    const known = this.knownDiagramTombstones(descriptor)
    if (known) return known
    const metaDescriptor = this.descriptors.modelMetaOf(descriptor)!
    const resident = this.listened.get(metaDescriptor.documentId)?.handle
    const handle = (resident?.state === 'ready'
      ? resident
      : await resolveHandleWithRetry(
        this.repo, `automerge:${metaDescriptor.documentId}` as AutomergeUrl,
        { tries: 5, delayMs: 250 },
      )) as DocHandle<StaticMetaLike>
    return new Set(unique(handle.doc()?.deletedDiagramIds ?? []))
  }

  /**
   * Project a registry shard, i.e. the write head a summary workspace appends
   * new diagrams to.
   *
   * A RECONCILIATION OF THE SHARD, NEVER AN UPSERT, and never wider than the
   * shard. Both halves are load-bearing and each has a test:
   *
   * - Upsert-only would trade an invisible diagram for an INDESTRUCTIBLE one.
   *   `writeSummaryLocalRegistry` expresses an in-session deletion by
   *   `delete shard.diagrams[id]`, and `planDiagramTombstones` deliberately
   *   writes no ModelMeta tombstone for it — so `deletedDiagramIds` never
   *   carries the id and the client's ONLY card filter cannot hide it.
   * - Workspace-wide would be catastrophic. `syncDiagrams` is one call away and
   *   does `DELETE FROM ro_diagrams … WHERE id <> ALL($3)`, which would destroy
   *   every base diagram row on a diagram CREATION. The previous set therefore
   *   comes from THIS shard's own membership snapshot, keyed by its document
   *   id, so one shard's projection never deletes another's diagrams.
   *
   * The MEMBERSHIP TABLES (`ro_diagram_objects` and its siblings) are not
   * written here: the DiagramDoc owns them, and registering that document below
   * is what lets `projectDiagram` take it. (`ro_diagrams.data` DOES receive
   * `objectIds`/`connectionIds`/`groupIds` from the shard meta; both writers of
   * that column derive it from the same client-side composition, so they
   * agree.)
   *
   * SPARSE DRAFTS reach this branch too, intentionally: `draft/sparse.ts`
   * registers the draft's registry as `registry-shard`, so materialising a
   * diagram in a draft writes a `ro_diagrams` row for the DRAFT version and
   * moves that version's `diagram_count` — a draft is its own workspace. The
   * shard-scoped previous set guarantees a draft registry can never delete the
   * base rows the draft inherited.
   *
   * COST: the write head is NOT bounded — `findOrCreateSummaryWriteShard`
   * (client `bridge.ts`) reuses `root.registryWriteUrl` with no size test,
   * unlike `findOrCreateShardForNew`, and nothing rotates it — so it
   * accumulates every diagram ever created on the workspace. Two reads here are
   * O(N) in that count (the membership snapshot and the `ro_diagrams` SELECT);
   * everything that WRITES is O(changed).
   */
  private async projectRegistryShard(
    descriptor: StaticDocumentDescriptor,
    doc: RegistryShardLike,
    sourceRevision: number,
  ): Promise<void> {
    const tombstoned = await this.durableDeletedDiagramIds(descriptor)
    // The MAP KEY is the identity, not `meta.id`: the bridge deletes by key
    // (`delete shard.diagrams[id]`) and fsck reads `Object.keys`. They coincide
    // with `meta.id` for everything the bridge writes — but if they ever
    // diverged, the row would be created under one name and deleted under
    // another, i.e. an indestructible card.
    const seen = new Set<string>()
    const next: (DiagramInput & { docUrl?: string })[] = []
    for (const [id, meta] of Object.entries(doc.diagrams ?? {})) {
      if (!id || !meta || typeof meta !== 'object') continue
      if (tombstoned.has(id) || seen.has(id)) continue
      seen.add(id)
      next.push({ ...(meta as DiagramInput & { docUrl?: string }), id })
    }
    const nextIds = new Set(next.map((meta) => meta.id))

    await this.publish(descriptor, 'registry', { kind: 'reset', scope: 'diagrams' }, async (tx, generation) => {
      const previous = await registryShardMembershipValues(tx, descriptor, descriptor.documentId)
      const removed = previous.map((value) => value.entityId).filter((id) => !nextIds.has(id))

      // Before the delete, always: an active sparse child captures the parent's
      // OLD value once, or a child draft loses the base it renders and diffs
      // against (same rule as the ModelMeta pass).
      await captureSparseDraftEntityBases(tx, descriptor, 'diagram', removed)

      // Merge over whatever the row already holds, exactly as `projectDiagram`
      // does. A shard meta is a STUB; overwriting a fuller projection with it
      // would make a diagram lose fields every time its registry entry is
      // touched.
      const { rows: current } = nextIds.size
        ? await tx.query<{ id: string; data: Record<string, unknown>; org_id: string | null }>(
          `SELECT id, data, org_id FROM ro_diagrams
            WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
          [descriptor.landscapeId, descriptor.versionId, [...nextIds]],
        )
        : { rows: [] as { id: string; data: Record<string, unknown>; org_id: string | null }[] }
      const currentById = new Map(current.map((row) => [row.id, row]))
      const orgId = descriptor.orgId ?? current[0]?.org_id ?? null
      // The DELTA, not the shard. `bumpDiagramRenderGenerations`'s contract
      // (`diagramRenderGeneration.ts`): "Only a dependency mutation bumps this
      // token; unrelated workspace projections deliberately do not." Bumping
      // every id the head carries would invalidate 200 render caches every
      // time the 201st diagram was created.
      //
      // It also keeps the writes O(changed): the head is unbounded (see the
      // docstring), so only the two reads below are O(N); the upsert, the
      // summary refresh and the generation bump are O(changed).
      const changed = next.filter((meta) => {
        const row = currentById.get(meta.id)
        // A row that does not exist, or exists under another org, must be
        // written. `upsertDiagrams` derives `diagram_count` from
        // `diagrams.length - existing`, so skipping an unchanged row cannot
        // drift the counter: it was already counted.
        if (!row || (row.org_id ?? null) !== orgId) return true
        return diagramRowFingerprint(mergeRegistryMetaOverRow(row.data, meta))
          !== diagramRowFingerprint(row.data)
      })
      await bumpDiagramRenderGenerations(tx, descriptor, generation, {
        diagramIds: [...changed.map((meta) => meta.id), ...removed],
      })

      if (changed.length) {
        const merged = changed.map((meta) => mergeRegistryMetaOverRow(currentById.get(meta.id)?.data, meta))
        await upsertDiagrams(tx, descriptor, orgId, merged)
      }

      if (removed.length) {
        const gone = await deleteDiagrams(tx, descriptor, removed)
        // By the REAL number of rows removed, never by the size of the input:
        // the counter is clamped at zero and would drift down for ever.
        await adjustWorkspaceCount(tx, descriptor, descriptor.orgId, 'diagram_count', -gone)
      }

      // Registering each DiagramDoc breaks a circular catch-up:
      // `reloadDescriptors` fills `entity_id` for `kind='diagram'` rows by
      // joining `ro_diagrams` on `data->>'docUrl'`, and `project()` ignores a
      // diagram descriptor whose `entityId` is null — so a brand-new diagram
      // would presuppose the row it should create. With the identity written
      // here, `projectDiagram` takes over composition and renders.
      const documents = next
        .filter((meta) => typeof meta.docUrl === 'string' && meta.docUrl.length > 0)
        .map((meta) => ({ documentId: documentIdOf(meta.docUrl!), kind: 'diagram', entityId: meta.id }))
        .filter((entry) => entry.documentId.length > 0)
      if (documents.length) await registerStaticReadModelDocuments(tx, descriptor, documents)
      // T-DIAGDEF: an id whose row this pass (re)creates — back
      // in the head after an undo, or new — or whose document it repoints,
      // has its DiagramDoc re-opened: a pass of it refused while the id was
      // retired (or superseded) is projected again without a new save, and
      // the membership comes back with it.
      await this.reopenDiagramDocuments(tx, descriptor, changed
        .filter((meta) => {
          const row = currentById.get(meta.id)
          if (!row) return true
          const rowDocUrl = typeof row.data?.docUrl === 'string' ? row.data.docUrl : ''
          return typeof meta.docUrl === 'string' && meta.docUrl.length > 0
            && documentIdOf(meta.docUrl) !== documentIdOf(rowDocUrl)
        })
        .map((meta) => meta.id))

      // The shard-scoped previous/next diff. `recordStaticMembershipSnapshot`
      // tombstones what left, so the NEXT projection of this shard reads the
      // right previous set — this is the memory that makes shard-scoped
      // deletion possible without ever consulting the workspace.
      await recordStaticMembershipSnapshot(
        tx, descriptor, 'registry_shard_diagram', descriptor.documentId, generation,
        previous, [...nextIds].map((entityId) => ({ entityId })),
      )
      // No `recordStaticEntityDeltas` here on purpose: that journal has no
      // reader.
    }, sourceRevision)
  }

  /**
   * A DiagramDoc pass writes the `ro_diagrams` row (an upsert) and its
   * membership — but it is NEVER the authority on whether the diagram exists.
   * The registry is (the write head's entries, the ModelMeta tombstones), and
   * a DiagramDoc stays registered (`read_model_static_documents`, `entity_id`
   * set) after its diagram left: nothing unregisters it. So its next save — the
   * editor's last debounced flush, a reload's sync — reaches this pass AFTER
   * the registry pass removed the row, and an unconditional upsert RESURRECTED
   * it (T-DIAGDEF (3), the create-then-delete race a manual test found). Resurrected for
   * ever: an in-session deletion writes no ModelMeta tombstone and the head no
   * longer lists the id, so no later pass would ever delete it again.
   *
   * The refusal therefore takes the registry's own witnesses:
   *  - the id is in `ModelMeta.deletedDiagramIds` ({@link
   *    durableDeletedDiagramIds}, the same durability witness the head pass
   *    uses — it throws rather than guess);
   *  - or the id LEFT a write head (a tombstoned `registry_shard_diagram`
   *    membership row) and no head lists it now.
   * NOT "the row is absent": a sparse draft registers its registry and the
   * cloned DiagramDoc in one commit, and the DiagramDoc may well be projected
   * first — it must create the row and the membership then, as it always did.
   * An id that came BACK into a head (undo) is a live member again and
   * projects normally. Under the per-workspace projection mutex no registry
   * pass commits between this read and the transaction's write.
   *
   * T-DIAGDEF:
   *  - The ModelMeta tombstones are consulted ONLY when the row is absent:
   *    only an INSERT resurrects, an UPDATE of a present row cannot. A row
   *    present for a tombstoned id is the ModelMeta pass's to delete (it
   *    deletes every id it has not applied yet) and the retired-row sweep's
   *    ({@link repairRetiredDiagramRows}) for one it already applied. So a
   *    pass over a present row never needs ModelMeta, and one over an absent
   *    row whose ModelMeta is unread answers `needs-tombstones` (the caller
   *    resolves it; a ModelMeta that does not resolve throws: abstain, retry).
   *  - The registry names the diagram's document (`ro_diagrams.data.docUrl`,
   *    written by the registry pass). A DiagramDoc that is NOT that document — a
   *    diagram re-created under the same id with a new document, an epoch
   *    repoint — is `superseded`: it must not overwrite the current one.
   */
  /**
   * T-DIAGDEF: the DURABLE repair of `ro_diagrams` rows an earlier
   * resurrection left (before the `projectDiagram` guard, or written by an
   * older cell), without waiting for a save of their DiagramDoc — which may
   * never come. A row is an ORPHAN when its id is
   *  (a) in `ModelMeta.deletedDiagramIds` (the fact the last ModelMeta pass
   *      cached; an unread ModelMeta skips this half, never guesses), or
   *  (b) only TOMBSTONED in write heads (`registry_shard_diagram`, no live
   *      membership) AND listed by no baseline registry (`kind = 'registry'`,
   *      read from the documents; one that does not resolve makes this half
   *      abstain for the tick).
   * A sparse draft's rows have no head membership unless its own registry
   * removed them (R3's DiagramDoc-first row has none), so (b) never takes one.
   *
   * WHERE: the reload tick (every `descriptorReloadMs`), per attached
   * workspace, NOT the registry or ModelMeta pass — those run only when their
   * document changes, and after a restart an untouched ModelMeta is
   * short-circuited, so an orphan would wait for an edit that may never come.
   * The tick's cost on a clean workspace is one indexed read (the head
   * memberships, bounded by the head, plus a primary-key probe per cached
   * tombstone); the transaction — the projection mutex — is taken only when
   * that read finds a candidate, and re-judges it there. Idempotent: a
   * repaired row is gone, the next tick finds nothing.
   *
   * SCHEDULED, NEVER INLINE (the C4 repair's convention,
   * `scheduleC4ParentRepairs`): the tick only queues, on
   * `retiredRepairChain`, one repair at a time and at most one in flight per
   * workspace; the reload chain (descriptors, `recoverChangedDocuments`,
   * `relaunchOrphanZeroCertificates`) never waits for it. `stop()` drains the
   * chain within its ceiling (`drainInFlightWork`); a queued repair sees
   * `stopped` and returns, and the one in progress re-checks it before and
   * inside its transaction.
   */
  private scheduleRetiredDiagramRepairs(): void {
    for (const attached of [...this.attachedWorkspaces.values()]) {
      if (this.stopped) return
      const workspace = keyOf(attached)
      if (this.retiredRepairsInFlight.has(workspace)) continue
      this.retiredRepairsInFlight.add(workspace)
      const run = this.retiredRepairChain.then(async () => {
        if (this.stopped || !this.ownsWorkspace(attached)) return
        try {
          await this.repairRetiredDiagramRowsOf(attached)
        } catch (error) {
          console.error(
            `[read-model] retired diagram row repair failed for ${attached.landscapeId}/${attached.versionId}; `
            + 'the next descriptor reload retries it',
            error,
          )
        }
      })
      this.retiredRepairChain = run.finally(() => { this.retiredRepairsInFlight.delete(workspace) })
    }
  }

  /** Schedules the repairs and waits for THEM (tests, and an operator
   * script): the tick itself never awaits. */
  private async repairRetiredDiagramRows(): Promise<void> {
    this.scheduleRetiredDiagramRepairs()
    await this.retiredRepairChain
  }

  private async retiredDiagramRowCandidates(
    db: Queryable,
    key: WorkspaceKey,
    tombstones: readonly string[],
    onlyIds: readonly string[] | null,
  ): Promise<{ tombstoned: string[]; leftHead: string[] }> {
    const { rows } = await db.query<{ id: string; tombstoned: boolean }>(
      `SELECT diagram.id, diagram.id = ANY($3::text[]) AS tombstoned
         FROM ro_diagrams diagram
        WHERE diagram.landscape_id = $1 AND diagram.version_id = $2
          AND ($4::text[] IS NULL OR diagram.id = ANY($4::text[]))
          AND (diagram.id = ANY($3::text[])
               OR diagram.id IN (
                 SELECT membership.entity_id
                   FROM read_model_static_membership_deltas membership
                  WHERE membership.landscape_id = $1 AND membership.version_id = $2
                    AND membership.membership_kind = 'registry_shard_diagram'
                  GROUP BY membership.entity_id
                 HAVING bool_and(membership.tombstone)))`,
      [key.landscapeId, key.versionId, [...tombstones], onlyIds ? [...onlyIds] : null],
    )
    return {
      tombstoned: rows.filter((row) => row.tombstoned).map((row) => row.id),
      leftHead: rows.filter((row) => !row.tombstoned).map((row) => row.id),
    }
  }

  /** Of `ids`, those NO baseline registry of the workspace lists; `null`
   * when one of them does not resolve (abstain). */
  private async idsListedByNoBaseline(key: WorkspaceKey, ids: string[]): Promise<string[] | null> {
    if (!ids.length) return ids
    const baselines = [...this.descriptors.values()]
      .filter((candidate) => candidate.kind === 'registry' && keyOf(candidate) === keyOf(key))
    // The ids a baseline was found to list are
    // remembered per workspace, so they stop being re-judged — and every
    // baseline re-resolved — on each tick. A baseline is immutable; the memo
    // is keyed by the SET of baselines registered, so one added or removed
    // invalidates it. (A head that re-lists or drops such an id changes
    // nothing: it stays baseline-listed, hence never an orphan.)
    const signature = baselines.map((baseline) => baseline.documentId).sort().join(',')
    const memo = this.baselineListedIds.get(keyOf(key))
    const remembered = memo?.signature === signature ? memo.ids : new Set<string>()
    const unknown = ids.filter((id) => !remembered.has(id))
    if (!unknown.length) return []
    const listed = new Set<string>()
    for (const baseline of baselines) {
      let handle: DocHandle<RegistryShardLike>
      try {
        handle = await resolveHandleWithRetry(
          this.repo, `automerge:${baseline.documentId}` as AutomergeUrl, { tries: 3, delayMs: 100 },
        ) as DocHandle<RegistryShardLike>
      } catch {
        return null
      }
      const diagrams = handle.doc()?.diagrams ?? {}
      for (const id of unknown) if (Object.prototype.hasOwnProperty.call(diagrams, id)) listed.add(id)
    }
    this.baselineListedIds.set(keyOf(key), { signature, ids: new Set([...remembered, ...listed]) })
    return unknown.filter((id) => !listed.has(id))
  }

  /**
   * The durable re-open of unprojected DiagramDocs, ONCE
   * PER TICK in the repair chain (the first tick after a start included),
   * instead of on every ModelMeta pass. Read on the POOL first; the mutex is
   * taken only when there is a candidate, and the candidates re-read there.
   * Skipped while the workspace's ModelMeta is unread: without its tombstones
   * a tombstoned diagram's DiagramDoc could not be told apart.
   *
   * No longer on EVERY tick (10 s) — on the first one of
   * the workspace after a start, then at most every
   * {@link unprojectedReopenIntervalMs}. What it repairs is rare and
   * durable (a lift across a restart, a failed publish); a lift a ModelMeta
   * pass sees re-opens at once in that pass, whatever the interval.
   */
  private async reopenUnprojectedOnTick(attached: StaticDocumentDescriptor): Promise<void> {
    const tombstones = this.knownDiagramTombstones(attached)
    if (!tombstones || this.stopped) return
    const workspace = keyOf(attached)
    const last = this.unprojectedReopenedAt.get(workspace)
    if (last !== undefined && Date.now() - last < this.unprojectedReopenIntervalMs) return
    this.unprojectedReopenedAt.set(workspace, Date.now())
    if (!(await this.unprojectedDiagramIds(this.db, attached, [...tombstones])).length) return
    let reopened = 0
    await this.transactionOnly(attached, async (tx) => {
      if (this.stopped) return
      reopened = await this.reopenUnprojectedDiagramDocuments(tx, attached, [...(this.knownDiagramTombstones(attached) ?? tombstones)])
    })
    if (reopened) {
      console.warn(JSON.stringify({
        event: 'read_model.static_unprojected_diagram_documents_reopened',
        workspace: `${attached.landscapeId}/${attached.versionId}`,
        reopened,
      }))
    }
  }

  private async repairRetiredDiagramRowsOf(attached: StaticDocumentDescriptor): Promise<void> {
    await this.reopenUnprojectedOnTick(attached)
    const tombstones = [...(this.knownDiagramTombstones(attached) ?? [])]
    const found = await this.retiredDiagramRowCandidates(this.db, attached, tombstones, null)
    if (!found.tombstoned.length && !found.leftHead.length) return
    const leftHead = await this.idsListedByNoBaseline(attached, found.leftHead) ?? []
    const candidates = [...found.tombstoned, ...leftHead]
    if (!candidates.length || this.stopped) return
    let removed = 0
    await this.transactionOnly(attached, async (tx) => {
      if (this.stopped) return
      // The tombstones captured above are STALE here —
      // the baselines' resolution and the queue behind the mutex are awaits
      // in which a ModelMeta pass can LIFT a tombstone and the registry
      // re-create the diagram. Re-read under the mutex (the fact the last
      // ModelMeta pass cached, as `projectDiagram`'s late verdict does) and
      // keep only the ids tombstoned in BOTH; an unreadable fact keeps none.
      const fresh = this.knownDiagramTombstones(attached)
      const stillTombstoned = fresh ? tombstones.filter((id) => fresh.has(id)) : []
      const confirmed = await this.retiredDiagramRowCandidates(tx, attached, stillTombstoned, candidates)
      const ids = [...confirmed.tombstoned, ...confirmed.leftHead.filter((id) => leftHead.includes(id))]
      if (ids.length) removed = await this.removeRetiredDiagramRows(tx, attached, ids)
    })
    if (removed) {
      console.warn(JSON.stringify({
        event: 'read_model.static_retired_diagram_rows_repaired',
        workspace: `${attached.landscapeId}/${attached.versionId}`,
        removed,
      }))
    }
  }

  private async diagramDocVerdict(
    tx: Queryable,
    descriptor: StaticDocumentDescriptor,
    diagramId: string,
    tombstones: ReadonlySet<string> | undefined,
  ): Promise<DiagramDocVerdict> {
    const { rows } = await tx.query<{ doc_url: string | null; present: boolean; live: boolean | null; retired: boolean | null }>(
      `SELECT row.doc_url, row.present, membership.live, membership.retired
         FROM (SELECT max(data->>'docUrl') AS doc_url, count(*) > 0 AS present
                 FROM ro_diagrams
                WHERE landscape_id = $1 AND version_id = $2 AND id = $3) row,
              (SELECT bool_or(NOT tombstone) AS live, bool_or(tombstone) AS retired
                 FROM read_model_static_membership_deltas
                WHERE landscape_id = $1 AND version_id = $2
                  AND membership_kind = 'registry_shard_diagram' AND entity_id = $3) membership`,
      [descriptor.landscapeId, descriptor.versionId, diagramId],
    )
    const facts = rows[0]
    // The row's `docUrl` is the
    // authority only when a write HEAD lists the id (`live`) — the registry
    // pass wrote that `docUrl` from the live registry. A baseline-only
    // diagram's row keeps the FROZEN baseline's `docUrl`, which an operator's
    // repair (`repair-missing-diagram-documents`: a new DiagramDoc, the
    // registry meta repointed at it) or a repoint can leave behind; taken as
    // authority there, the live document would be `superseded` for ever.
    if (facts?.present && facts.live === true && facts.doc_url
      && documentIdOf(facts.doc_url) !== descriptor.documentId) {
      return { kind: 'superseded' }
    }
    if (facts?.retired === true && facts.live !== true) return { kind: 'retired', rowPresent: Boolean(facts.present) }
    if (facts?.present) return { kind: 'live' }
    if (!tombstones) return { kind: 'needs-tombstones' }
    return tombstones.has(diagramId) ? { kind: 'retired', rowPresent: false } : { kind: 'live' }
  }

  /**
   * The REFUSED pass: through `transactionOnly`, never `publish` — no
   * projection token, no reset, no generation — unless it removed a row
   * (a row an earlier resurrection left), which it announces like any
   * deletion. Then the queue row and the certificate move to this revision,
   * as `acknowledgeOnly` does. Returns the verdict taken UNDER the mutex, or
   * `null` when the transaction was refused (not owned, plane lost): nothing
   * happened. A `live` or `needs-tombstones` verdict commits nothing.
   */
  private async settleRefusedDiagramDoc(
    descriptor: StaticDocumentDescriptor,
    diagramId: string,
    sourceRevision: number,
    tombstones: ReadonlySet<string> | undefined,
  ): Promise<DiagramDocVerdict | null> {
    let verdict: DiagramDocVerdict | null = null
    // NOW, not queued: called as `publish`'s gate, already in the tail's slot.
    const committed = await this.transactionNow(descriptor, async (tx) => {
      verdict = await this.diagramDocVerdict(tx, descriptor, diagramId, tombstones)
      if (verdict.kind === 'live' || verdict.kind === 'needs-tombstones') return
      if (verdict.kind === 'retired' && verdict.rowPresent) {
        await this.removeRetiredDiagramRows(tx, descriptor, [diagramId])
      }
      if (sourceRevision > 0) {
        await tx.query(
          `UPDATE read_model_static_document_queue
           SET projected_revision = GREATEST(projected_revision, $4),
               projected_at = now()
           WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
          [descriptor.landscapeId, descriptor.versionId, descriptor.documentId, sourceRevision],
        )
        await this.recordPassWatermark(tx, descriptor, sourceRevision)
      }
    })
    return committed ? verdict : null
  }

  /** Delete retired diagrams' rows and memberships (the six tables and the
   * summaries, `deleteDiagrams`), adjust `diagram_count` by the rows REALLY
   * removed, invalidate their renders and announce it — under a generation
   * allocated INSIDE the caller's transaction, and only when a row went (the
   * C4 repair's rule: a pass that removes nothing leaves no generation). */
  private async removeRetiredDiagramRows(tx: Queryable, key: StaticDocumentDescriptor, ids: string[]): Promise<number> {
    await captureSparseDraftEntityBases(tx, key, 'diagram', ids)
    const removed = await deleteDiagrams(tx, key, ids)
    if (!removed) return 0
    await adjustWorkspaceCount(tx, key, key.orgId, 'diagram_count', -removed)
    const token = await advanceReadModelGenerationWithinTransaction(tx, key, key.orgId)
    await bumpDiagramRenderGenerations(tx, key, token.generation, { diagramIds: ids })
    await appendReadModelChange(tx, key, token, { kind: 'reset', scope: 'diagrams' })
    return removed
  }

  /**
   * Re-open the DiagramDoc registered for each id (`entity_id`), in the
   * caller's transaction, so a pass refused while the id was retired — or
   * whose row the registry pass just (re)created or repointed — is projected
   * again WITHOUT a new save of the DiagramDoc: durably (the queue row the
   * recovery tick reads) and, after the commit, at once for a resident one.
   */
  private async reopenDiagramDocuments(tx: Queryable, key: WorkspaceKey, diagramIds: string[]): Promise<void> {
    if (!diagramIds.length) return
    const { rows } = await tx.query<{ document_id: string }>(
      `INSERT INTO read_model_static_document_queue (
         landscape_id, version_id, document_id, revision, projected_revision, enqueued_at
       )
       SELECT landscape_id, version_id, document_id, 1, 0, now()
         FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND kind = 'diagram'
          AND entity_id = ANY($3::text[])
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET
         revision = GREATEST(read_model_static_document_queue.revision,
                             read_model_static_document_queue.projected_revision) + 1,
         enqueued_at = now()
       RETURNING document_id`,
      [key.landscapeId, key.versionId, unique(diagramIds)],
    )
    if (!rows.length) return
    this.onCommit(tx, () => {
      for (const { document_id: documentId } of rows) {
        const descriptor = this.descriptors.get(documentId)
        const handle = this.listened.get(documentId)?.handle
        if (descriptor?.entityId && handle && !this.stopped) void this.trigger(descriptor, handle, true)
      }
    })
  }

  /**
   * Re-open, idempotently, every registered DiagramDoc
   * whose diagram SHOULD have a row and has none — its `entity_id` is neither
   * tombstoned (`tombstones`, this ModelMeta's list) nor retired from a write
   * head (tombstoned and not live there), no `ro_diagrams` row exists, and no
   * pass of it is already owed. The in-memory lift detection above misses a
   * lift across a restart and one whose publish failed; this one reads only
   * durable facts, in the ModelMeta pass's transaction.
   *
   * IDEMPOTENT: a document already owed (`revision > projected_revision`) is
   * not touched, so repeated ModelMeta passes do not bump it again; once its
   * pass projects the row, it stops being a candidate. BOUNDED: at most
   * {@link REOPEN_UNPROJECTED_LIMIT} per pass (the rest on the next one), on
   * the `(landscape, version)` prefix of the documents' key and of each
   * probed table's.
   */
  private async reopenUnprojectedDiagramDocuments(
    tx: Queryable,
    key: WorkspaceKey,
    tombstones: readonly string[],
  ): Promise<number> {
    const ids = await this.unprojectedDiagramIds(tx, key, tombstones)
    await this.reopenDiagramDocuments(tx, key, ids)
    return ids.length
  }

  /** The candidates of {@link reopenUnprojectedDiagramDocuments} — read on
   * the POOL by the repair tick first, so the mutex is taken only when there
   * is something to re-open.
   *
   * Only a DiagramDoc that EXISTS — resident in this
   * Repo, or with durable content in `automerge_storage` (a snapshot or an
   * incremental chunk; `idx_automerge_storage_doc_updated`'s prefix). One
   * whose document is missing has nothing to project: re-opened, it stayed
   * owed for good, and every reload tick spent ~1 s failing to resolve it
   * (`recoverChangedDocuments`: five tries, 250 ms apart) and logged an error
   * (measured). It never moved
   * catching-up, a certificate nor `absenceProvable` — none of them reads the
   * static queue — only that cost. */
  private async unprojectedDiagramIds(db: Queryable, key: WorkspaceKey, tombstones: readonly string[]): Promise<string[]> {
    const resident = [...this.descriptors.values()]
      .filter((candidate) => candidate.kind === 'diagram' && keyOf(candidate) === keyOf(key)
        // READY, not merely known: a failed find of a missing document leaves
        // its synchronizer behind, unavailable.
        && this.repo.synchronizer.docSynchronizers[candidate.documentId as DocumentId]?.query.peek()?.state === 'ready')
      .map((candidate) => candidate.documentId)
    const { rows } = await db.query<{ entity_id: string }>(
      `SELECT document.entity_id
         FROM read_model_static_documents document
        WHERE document.landscape_id = $1 AND document.version_id = $2
          AND document.kind = 'diagram' AND document.entity_id IS NOT NULL
          AND NOT (document.entity_id = ANY($3::text[]))
          AND (document.document_id = ANY($4::text[])
               OR EXISTS (
                 SELECT 1 FROM automerge_storage storage
                  WHERE split_part(storage.key, '/', 1) = document.document_id
                    AND ${documentContentChunkFilter('storage.key')}))
          AND NOT EXISTS (
            SELECT 1 FROM ro_diagrams diagram
             WHERE diagram.landscape_id = $1 AND diagram.version_id = $2 AND diagram.id = document.entity_id)
          AND NOT EXISTS (
            SELECT 1 FROM read_model_static_membership_deltas membership
             WHERE membership.landscape_id = $1 AND membership.version_id = $2
               AND membership.membership_kind = 'registry_shard_diagram'
               AND membership.entity_id = document.entity_id
             GROUP BY membership.entity_id
            HAVING bool_and(membership.tombstone))
          AND NOT EXISTS (
            SELECT 1 FROM read_model_static_document_queue queue
             WHERE queue.landscape_id = $1 AND queue.version_id = $2
               AND queue.document_id = document.document_id
               AND queue.revision > queue.projected_revision)
        ORDER BY document.entity_id
        LIMIT ${REOPEN_UNPROJECTED_LIMIT}`,
      [key.landscapeId, key.versionId, [...tombstones], resident],
    )
    return rows.map((row) => row.entity_id)
  }

  private async projectDiagram(
    descriptor: StaticDocumentDescriptor,
    doc: StaticDiagramLike,
    sourceRevision: number,
  ): Promise<void> {
    const diagramId = descriptor.entityId!
    let tombstones = this.knownDiagramTombstones(descriptor)
    // The verdict is the publish's GATE, in the same tail
    // slot — no static writer of this workspace (a registry pass) can commit
    // between the verdict and the projection, so a refusal never takes a
    // token and never publishes a reset or a generation. Still TWO
    // transactions, on purpose: `publish` takes its token on the pool BEFORE
    // its transaction (`beginReadModelProjection`: the documented order, whose
    // `observed_generation` bump survives a rollback), so a verdict inside that
    // transaction would come after the generation it must not take.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let verdict: DiagramDocVerdict | null = null
      const gate = async () => {
        verdict = await this.settleRefusedDiagramDoc(descriptor, diagramId, sourceRevision, tombstones)
        return verdict?.kind === 'live'
      }
      await this.projectLiveDiagram(descriptor, doc, sourceRevision, diagramId, tombstones, gate)
      if ((verdict as DiagramDocVerdict | null)?.kind !== 'needs-tombstones' || attempt > 0) return
      // Throws when a registered ModelMeta does not resolve: the pass is not
      // acknowledged and the next tick retries it. Never guessed empty.
      tombstones = await this.durableDeletedDiagramIds(descriptor)
    }
  }

  private async projectLiveDiagram(
    descriptor: StaticDocumentDescriptor,
    doc: StaticDiagramLike,
    sourceRevision: number,
    diagramId: string,
    tombstones: ReadonlySet<string> | undefined,
    gate: () => Promise<boolean>,
  ): Promise<void> {
    await this.publish(descriptor, 'registry', { kind: 'reset', scope: 'diagrams' }, async (tx, generation) => {
      // An ASSERTION now (the gate ran in this tail slot): re-judged under the
      // mutex all the same; were it ever not `live`, this pass would write
      // nothing.
      const late = await this.diagramDocVerdict(tx, descriptor, diagramId, this.knownDiagramTombstones(descriptor) ?? tombstones)
      if (late.kind !== 'live') return
      await captureSparseDraftEntityBases(tx, descriptor, 'diagram', [diagramId])
      await bumpDiagramRenderGenerations(tx, descriptor, generation, { diagramIds: [diagramId] })
      const current = await tx.query<{ data: Record<string, unknown>; org_id: string | null }>(
        `SELECT data, org_id FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
        [descriptor.landscapeId, descriptor.versionId, diagramId],
      )
      const merged = mergeDiagramDocOverRow(current.rows[0]?.data, doc, diagramId)
      await upsertDiagrams(tx, descriptor, descriptor.orgId ?? current.rows[0]?.org_id ?? null, [merged])

      const previousObjects = await membershipValues(tx, 'ro_diagram_objects', 'object_id', descriptor, diagramId)
      const previousGroups = await membershipValues(tx, 'ro_diagram_groups', 'group_id', descriptor, diagramId)
      const previousConnections = await membershipValues(tx, 'ro_diagram_connections', 'connection_id', descriptor, diagramId)
      const previousFlows = await flowMembershipValues(tx, descriptor, diagramId)
      const objectIds = unique(doc.objectIds ?? [])
      const groupIds = unique(doc.groupIds ?? [])
      const connectionIds = unique(doc.connectionIds ?? [])
      const flows = Object.values(doc.flows ?? {})
      const flowRows = flows.flatMap((flow) => unique((flow.steps ?? []).map((step) => step.connectionId))
        .map((connectionId) => ({ entityId: connectionId, auxiliaryId: flow.id })))
      // Only a document that CARRIES a flows map may certify its flow set; one
      // without (treated as empty just above, as it always was) leaves the
      // diagram uncovered rather than covered-and-empty.
      const flowIndex = doc.flows && typeof doc.flows === 'object' && !Array.isArray(doc.flows) ? flows : null

      await replaceDiagramMembership(tx, descriptor, descriptor.orgId, diagramId, objectIds, groupIds, connectionIds, flowRows, flowIndex)
      await recordStaticEntityDeltas(tx, descriptor, 'diagram', generation, [merged])
      await recordStaticMembershipSnapshot(tx, descriptor, 'diagram_object', diagramId, generation, previousObjects, objectIds.map((entityId) => ({ entityId })))
      await recordStaticMembershipSnapshot(tx, descriptor, 'diagram_group', diagramId, generation, previousGroups, groupIds.map((entityId) => ({ entityId })))
      await recordStaticMembershipSnapshot(tx, descriptor, 'diagram_connection', diagramId, generation, previousConnections, connectionIds.map((entityId) => ({ entityId })))
      await recordStaticMembershipSnapshot(tx, descriptor, 'connection_flow', diagramId, generation, previousFlows, flowRows)
    }, sourceRevision, gate)
  }

  /** Resolves `true` only once `action`'s transaction COMMITTED; `false` when
   * the publish applied nothing and said so without throwing (the workspace
   * not this process's, no fence, the plane lost, the mutex yielded). A
   * caller with a post-commit side effect — the duplicate-id counter and log
   * (`noteLiveDuplicateIds`) — gates it on this.
   *
   * `change` may be a PLANNER, run inside the transaction under the mutex
   * before `action`, for a payload that depends on rows read there (the
   * ModelMeta pass's tombstone seed, `unappliedTombstones`). */
  private publish(
    descriptor: StaticDocumentDescriptor,
    kind: ProjectionKind,
    change: ReadModelChangePayload | ((tx: Queryable) => Promise<ReadModelChangePayload>),
    action: (tx: Queryable, generation: number) => Promise<void>,
    sourceRevision = 0,
    /** Run IN THIS TAIL SLOT, before any projection token
     * is taken; `false` ends the publish there — no token, no reset, no
     * generation. Static writers of a workspace serialise on its tail (and
     * other cells are fenced), so nothing commits between the gate and the
     * publish's own transaction. */
    gate?: () => Promise<boolean>,
  ): Promise<boolean> {
    const workspace = keyOf(descriptor)
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
    const task = previous.then(async (): Promise<boolean> => {
      if (gate && !(await gate())) return false
      if (!this.ownsWorkspace(descriptor)) return false
      const expectedFence = this.ownership?.enabled
        ? this.ownership.fencingToken(descriptor)
        : null
      if (this.ownership?.enabled && !expectedFence) return false
      // The PLANE pre-check. Not the gate — the in-transaction assert under
      // the mutex is — but `beginReadModelProjection` runs on the POOL, and
      // its `observed_generation` bump survives the rollback that follows.
      // Without this, every publish for a demoted workspace would bump the
      // ORDINARY projector's generation once per attempt, walking a healthy
      // workspace to `catching_up`, refusing `absenceProvable` and blocking
      // compaction — while every one of those attempts was going to roll back.
      // `runTracked` carries the same shape for the write fence, for the same
      // reason and with the same "this is not the gate" caveat.
      if (!(await this.holdsStaticPlane(descriptor))) return false
      const token = await beginReadModelProjection(this.db, descriptor, descriptor.orgId, kind)
      const committed: Array<() => void> = []
      let bookTx: Queryable | undefined
      try {
        await withReadModelProjectionTransaction(this.db, descriptor, 'static', async (tx) => {
          // T-ZEROWM-3: THIS transaction's book updates, in a list of its own
          // (a rolled-back one's are dropped with its list), unregistered from
          // the pooled client once the transaction is over (`forgetBookTx`).
          this.afterCommit.set(tx, committed)
          bookTx = tx
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
          // Every `objects` change this projector publishes names the ids it
          // wrote; the rows that write moves without naming them (children
          // whose c4ParentId/parentId follows a deleted or re-created parent)
          // are read here, under the mutex, BEFORE the write — the one place,
          // so no publish site can forget them (objectExplorer.ts).
          const planned = typeof change === 'function' ? await change(tx) : change
          const published = planned.kind === 'objects'
            ? await objectChangeWithCacheNeighbours(tx, descriptor, planned)
            : planned
          await action(tx, token.generation)
          await appendReadModelChange(tx, descriptor, token, published)
          await tx.query(
            `INSERT INTO read_model_static_document_state (
               landscape_id, version_id, document_id, source_updated_at,
               projected_generation, projected_at
             )
             SELECT $1, $2, $3, max(updated_at), $4, now()
             FROM automerge_storage
             WHERE split_part(key, '/', 1) = $3
             HAVING max(updated_at) IS NOT NULL
             ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET
               source_updated_at = GREATEST(
                 read_model_static_document_state.source_updated_at,
                 EXCLUDED.source_updated_at
               ),
               projected_generation = GREATEST(
                 read_model_static_document_state.projected_generation,
                 EXCLUDED.projected_generation
               ),
               projected_at = now()`,
            [descriptor.landscapeId, descriptor.versionId, descriptor.documentId, token.generation],
          )
          if (sourceRevision > 0) {
            await tx.query(
              `UPDATE read_model_static_document_queue
               SET projected_revision = GREATEST(projected_revision, $4),
                   projected_at = now()
               WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
              [descriptor.landscapeId, descriptor.versionId, descriptor.documentId, sourceRevision],
            )
            await this.recordPassWatermark(tx, descriptor, sourceRevision)
          }
          await completeReadModelProjection(tx, descriptor, token)
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
        })
        this.forgetBookTx(bookTx, committed)
        this.runAfterCommit(committed)
        return true
      } catch (error) {
        this.forgetBookTx(bookTx, committed)
        if (isProjectionMutexTimeout(error)) {
          // Another writer holds the mutex; it clears when they commit. Not
          // persisted (the row is theirs while they write) and not fatal — the
          // document stays pending and the next tick tries again.
          // `descriptor`, not `workspace`: `keyOf` joins with a NUL (`\u0000`),
          // which is right for a Map key and wrong for anything a human or a
          // log pipeline reads.
    console.warn(
      `[read-model] static projection yielded the mutex for `
      + `${descriptor.landscapeId}/${descriptor.versionId}`,
    )
          return false
        }
        if (isReadModelAuthorityLoss(error)) {
          // NOT failReadModelProjection. The health row belongs to the ORDINARY
          // projector now, and stamping `consecutive_failures` / `last_error_*`
          // onto it is the same forgery as writing its `ro_*` rows — it can walk
          // a healthy workspace's ladder to `failed` from outside.
          // `projectorService` refuses the identical write for a lost fence.
          // Not rethrown either: losing the plane is a correct refusal, not a
          // failed projection, and the file already returns rather than throws
          // for the neighbouring "not mine" case (`ownsWorkspace` above).
          this.notePlaneLost(descriptor)
          return false
        }
        await failReadModelProjection(this.db, descriptor, token, error).catch(() => undefined)
        throw error
      }
    })
    this.workspaceTails.set(workspace, task.then(() => undefined, () => undefined))
    return task
  }

  /**
   * Does this workspace still belong to the static plane?
   *
   * Reports the loss at most once per workspace per loss. The memo's purge site
   * is right here, on the success branch: a re-promotion makes the next check
   * pass and clears the entry, so a LATER loss is reported again. That is the
   * whole purge — there is no lifecycle hook to remember, which is deliberate,
   * because the mechanism that was supposed to remember this workspace's
   * lifecycle (`release()` from `onOwnershipLost`) never fires with
   * `SYNC_CELL_OWNERSHIP` unset.
   *
   * This does NOT drop descriptors and listeners; `reloadDescriptors`
   * reconciles against the authority and calls `release()` within one
   * ten-second tick. Refusing only at `publish`/`acknowledgeOnly` would not
   * make a stale projector harmless — those sit at the END of the write path —
   * so `rotateOverlayHead`, `foldOverlayChain`, `forwardHistoricalOverlay` and
   * `recoverAdmittedOverlayRotations` consult this method at their entry,
   * before they can create documents, claim them, re-INSERT
   * `read_model_static_documents` rows or flush the user's ModelMeta.
   */
  private async holdsStaticPlane(descriptor: StaticDocumentDescriptor): Promise<boolean> {
    const workspace = keyOf(descriptor)
    if (await isStaticReadModelWorkspace(this.db, descriptor)) {
      this.planeLostReported.delete(workspace)
      return true
    }
    this.notePlaneLost(descriptor)
    return false
  }

  /**
   * An overlay pass found no `overlayState` for its workspace. When the
   * workspace HAS a ModelMeta descriptor, building a self-only state instead
   * (the segment order `[this document]`, an empty effective view) projects
   * against no baseline: a key removed from this shard since its last
   * projection is in neither view, so no delete is ever computed for it, the
   * revision is acknowledged, and its row stays for good. Reachable on every
   * restart and takeover: `attach` triggers the ModelMeta pass and
   * `triggerIfDurablyPending` / `recoverChangedDocuments` trigger the pending
   * overlay row independently, and nothing orders the two.
   *
   * So the pass DEFERS: it returns with the queue row still pending, asks for
   * the ModelMeta pass, and is re-triggered by that pass the moment it
   * installs the state (`retriggerOverlaysAwaitingMeta`) — the ModelMeta pass
   * restores every segment from `read_model_overlay_segments`
   * (`overlaySegmentSnapshots`), the last PROJECTED snapshot of each, which is
   * the baseline the removed key is found missing against. Registration and
   * the check of `overlayState` are one synchronous step, as is the
   * ModelMeta's install and drain, so no wake-up falls between them. If the
   * ModelMeta handle is not resident yet, `hydrateControlDocuments` attaches
   * (and so triggers) it, and `recoverChangedDocuments` re-triggers this row
   * on the next reload tick.
   *
   * Returns false — build the self-only state — only when no ModelMeta is
   * known for the workspace at all.
   */
  private deferUntilMetaState(descriptor: StaticDocumentDescriptor): boolean {
    const workspace = keyOf(descriptor)
    const meta = [...this.descriptors.values()].find((candidate) => (
      candidate.kind === 'model-meta' && keyOf(candidate) === workspace
    ))
    if (!meta) return false
    let awaiting = this.overlaysAwaitingMeta.get(workspace)
    if (!awaiting) {
      awaiting = new Map()
      this.overlaysAwaitingMeta.set(workspace, awaiting)
    }
    const now = Date.now()
    if (!awaiting.has(descriptor.documentId)) awaiting.set(descriptor.documentId, now)
    const metaHandle = this.listened.get(meta.documentId)?.handle
    if (metaHandle) this.trigger(meta, metaHandle)
    this.warnOverlayDeferred(descriptor, awaiting, now, Boolean(metaHandle))
    return true
  }

  /**
   * The deferral is otherwise INVISIBLE: the overlay row stays pending, the
   * recovery tick re-triggers it every reload, it defers again, and nothing
   * says why, for as long as the ModelMeta document never becomes resident
   * (or its pass never installs the state). So once the oldest deferral of a
   * workspace is older than `STATIC_OVERLAY_DEFERRED_WARN_AFTER_MS`, each
   * deferral may log `read_model.static_overlay_deferred`, at most once per
   * `STATIC_OVERLAY_DEFERRED_WARN_INTERVAL_MS` per workspace. The short
   * deferral of an ordinary restart (the ModelMeta pass installs the state
   * within a second or two) logs nothing. Re-deferrals are the ticks that
   * reach this line, so the warn needs no timer of its own.
   */
  private warnOverlayDeferred(
    descriptor: StaticDocumentDescriptor,
    awaiting: ReadonlyMap<string, number>,
    now: number,
    metaResident: boolean,
  ): void {
    const workspace = keyOf(descriptor)
    const oldest = Math.min(...awaiting.values())
    const ageMs = now - oldest
    if (ageMs < STATIC_OVERLAY_DEFERRED_WARN_AFTER_MS) return
    const last = this.overlayDeferredWarnedAt.get(workspace)
    if (last !== undefined && now - last < STATIC_OVERLAY_DEFERRED_WARN_INTERVAL_MS) return
    this.overlayDeferredWarnedAt.set(workspace, now)
    console.warn(JSON.stringify({
      event: 'read_model.static_overlay_deferred',
      // Not `workspace`: `keyOf` joins with a NUL (`\u0000`).
      landscapeId: descriptor.landscapeId,
      versionId: descriptor.versionId,
      deferredOverlays: awaiting.size,
      oldestDeferredAgeMs: ageMs,
      modelMetaResident: metaResident,
    }))
  }

  /**
   * T-SUM-0b: read the listed historical segments of a chain from their
   * DOCUMENTS, for the segments that have no snapshot in memory.
   *
   * Only a segment whose queue shows nothing pending is read. Its content is
   * then settled — every write it received since the workspace entered the
   * static plane has been through its own pass — so taking the document as
   * its baseline publishes nothing the rows were not owed. A PENDING one is
   * left to its own pass (a historical head forwards its late writes into the
   * current head: taking its live content as the baseline here would record
   * those writes as already projected and the forward would find nothing to
   * carry). It stays a hole, the head stays `!ready`, and that is reported
   * (`noteOverlayNotReady`) until its pass acknowledges it and the next pass of
   * the current head reads it.
   *
   * The snapshot is taken BEFORE the queue is read, with a flush in between,
   * as `project()` does for its own document: a write that lands after the
   * snapshot then shows as pending and the segment is left alone, instead of
   * being recorded at a revision older than its content. A document that does
   * not resolve stays a hole, logged; the gauge reports the head.
   */
  private async materialiseOverlaySegments(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    documentIds: readonly string[],
  ): Promise<MaterialisedOverlaySegment[]> {
    const read: { documentId: string; handle: DocHandle<unknown>; snapshot: Record<string, ObjectInput | ConnectionInput> }[] = []
    for (const documentId of documentIds) {
      if (this.stopped) return []
      try {
        const handle = await this.resolveDocumentHandle<ObjectOverlayLike | ConnectionOverlayLike>(documentId)
        const doc = plain<ObjectOverlayLike | ConnectionOverlayLike>(handle.doc())
        read.push({
          documentId,
          handle,
          snapshot: kind === 'object'
            ? (doc as ObjectOverlayLike).objects ?? {}
            : (doc as ConnectionOverlayLike).connections ?? {},
        })
      } catch (error) {
        console.error(`[read-model] static ${kind} segment ${documentId} could not be read to complete its chain`, error)
      }
    }
    if (!read.length) return []
    let rows: { document_id: string; revision: string | number; projected_revision: string | number }[]
    try {
      await this.repo.flush(read.map((segment) => segment.handle.documentId))
      rows = (await this.db.query<{ document_id: string; revision: string | number; projected_revision: string | number }>(
        `SELECT document_id, revision, projected_revision FROM read_model_static_document_queue
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
        [descriptor.landscapeId, descriptor.versionId, read.map((segment) => segment.documentId)],
      )).rows
    } catch (error) {
      // Nothing read is trusted without its checkpoint: every segment stays a
      // hole, and the head's `!ready` is reported by the caller.
      console.error(`[read-model] static ${kind} segments could not be checkpointed to complete their chain`, error)
      return []
    }
    const checkpoints = new Map(rows.map((row) => [row.document_id, {
      revision: Number(row.revision), projected: Number(row.projected_revision),
    }]))
    const settled: MaterialisedOverlaySegment[] = []
    for (const segment of read) {
      const checkpoint = checkpoints.get(segment.documentId) ?? { revision: 0, projected: 0 }
      if (checkpoint.revision > checkpoint.projected) continue
      settled.push({ documentId: segment.documentId, snapshot: segment.snapshot, revision: Math.max(0, checkpoint.revision) })
    }
    return settled
  }

  /** T-SUM-0b: a pass of a CURRENT head stopped at `!ready`. Recorded for the
   * gauge at once, logged once the head has been blocked for
   * `STATIC_OVERLAY_NOT_READY_WARN_AFTER_MS`, at most once per
   * `STATIC_OVERLAY_NOT_READY_WARN_INTERVAL_MS`. Re-blocks are the passes
   * that reach this line (the reload tick re-triggers a pending head), so the
   * warn needs no timer of its own. */
  private noteOverlayNotReady(
    descriptor: StaticDocumentDescriptor,
    kind: 'object' | 'connection',
    missing: readonly string[],
    now = Date.now(),
  ): void {
    const key = `${keyOf(descriptor)}\u0000${kind}`
    const previous = this.overlayHeadsNotReady.get(key)
    const entry = previous?.documentId === descriptor.documentId
      ? { ...previous, missing: [...missing] }
      : {
        landscapeId: descriptor.landscapeId,
        versionId: descriptor.versionId,
        kind,
        documentId: descriptor.documentId,
        missing: [...missing],
        since: now,
      }
    this.overlayHeadsNotReady.set(key, entry)
    if (now - entry.since < STATIC_OVERLAY_NOT_READY_WARN_AFTER_MS) return
    if (entry.warnedAt !== undefined && now - entry.warnedAt < STATIC_OVERLAY_NOT_READY_WARN_INTERVAL_MS) return
    entry.warnedAt = now
    console.warn(JSON.stringify({
      event: 'read_model.static_overlay_not_ready',
      landscapeId: entry.landscapeId,
      versionId: entry.versionId,
      kind,
      documentId: entry.documentId,
      blockedForMs: now - entry.since,
      missingSegments: entry.missing.length,
      // Bounded: a chain is normally a handful of segments, never this many.
      missingSegmentIds: entry.missing.slice(0, 20),
    }))
  }

  /** What `/metrics` publishes about blocked heads. An entry whose head is
   * no longer the CURRENT one (it rotated) is dropped here: the new head's
   * first pass decides afresh, and a stale entry would page for a document
   * nobody writes to. */
  notReadyOverlaySnapshot(now = Date.now()): { heads: number; oldestAgeMs: number | null } {
    let heads = 0
    let oldest: number | null = null
    for (const [key, entry] of this.overlayHeadsNotReady) {
      const current = this.currentOverlayDocumentIds.get(keyOf(entry))?.[entry.kind]
      if (current !== entry.documentId) {
        this.overlayHeadsNotReady.delete(key)
        continue
      }
      heads += 1
      if (oldest === null || entry.since < oldest) oldest = entry.since
    }
    return { heads, oldestAgeMs: oldest === null ? null : Math.max(0, now - oldest) }
  }

  /** What `/metrics` publishes about the deferrals: how many overlay
   * documents wait for their ModelMeta state, and the age of the oldest. */
  deferredOverlaySnapshot(now = Date.now()): { overlays: number; oldestAgeMs: number | null } {
    let overlays = 0
    let oldest: number | null = null
    for (const awaiting of this.overlaysAwaitingMeta.values()) {
      for (const since of awaiting.values()) {
        overlays += 1
        if (oldest === null || since < oldest) oldest = since
      }
    }
    return { overlays, oldestAgeMs: oldest === null ? null : Math.max(0, now - oldest) }
  }

  /** The ModelMeta pass has just installed `overlayState`: re-run every
   * overlay pass that deferred for it (`deferUntilMetaState`). */
  private retriggerOverlaysAwaitingMeta(workspace: string): void {
    const awaiting = this.overlaysAwaitingMeta.get(workspace)
    if (!awaiting) return
    this.overlaysAwaitingMeta.delete(workspace)
    // The re-trigger ENDS a deferral episode, and the warn's rate limit
    // belongs to the episode: a later deferral (the state lost again) that
    // outlives the threshold warns even less than a minute after the previous
    // episode's warn. Pinned by 'a second deferral episode after a
    // re-trigger warns again ...'.
    this.overlayDeferredWarnedAt.delete(workspace)
    for (const documentId of awaiting.keys()) {
      const descriptor = this.descriptors.get(documentId)
      const handle = this.listened.get(documentId)?.handle
      if (!descriptor || !handle) continue
      // T-ZEROWM-3 (1): a deferred pass is re-run from the
      // ModelMeta pass (at boot or a tick) — a recovery like the others, so
      // under the same lease, on a handle the Repo still holds (a dead one is
      // left owed for `recoverChangedDocuments`).
      const held = this.repo.synchronizer.docSynchronizers[documentId as DocumentId]?.query.peek()
      if (held?.state === 'ready' && held.handle === handle) this.runUnderRecoveryLease('recovery', descriptor, handle)
    }
  }

  private notePlaneLost(descriptor: StaticDocumentDescriptor): void {
    const workspace = keyOf(descriptor)
    if (this.planeLostReported.has(workspace)) return
    this.planeLostReported.add(workspace)
    console.warn(
      `[read-model] static projection refused for ` +
        `${descriptor.landscapeId}/${descriptor.versionId}: the workspace has no ` +
        'read_model_static_workspaces row, so its ro_* plane belongs to the ordinary projector. ' +
        'The next descriptor reload releases it; seeing this repeat past one tick means ' +
        'reconciliation is not running.',
    )
  }

  private acknowledgeOnly(
    descriptor: StaticDocumentDescriptor,
    sourceRevision: number,
    action?: (tx: Queryable) => Promise<void>,
  ): Promise<void> {
    if (sourceRevision <= 0) return Promise.resolve()
    return this.transactionOnly(descriptor, async (tx) => {
      await action?.(tx)
      await tx.query(
        `UPDATE read_model_static_document_queue
         SET projected_revision = GREATEST(projected_revision, $4),
             projected_at = now()
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [descriptor.landscapeId, descriptor.versionId, descriptor.documentId, sourceRevision],
      )
      await this.recordPassWatermark(tx, descriptor, sourceRevision)
    }).then(() => undefined)
  }

  /** Resolves `true` only when the transaction COMMITTED; `false` for each
   * quiet refusal (not owned, no fencing token, mutex yielded, authority lost —
   * the last one after the action may already have run and been rolled back).
   * A caller that records "done" must read the result, not its own flag. */
  private transactionOnly(
    descriptor: StaticDocumentDescriptor,
    action: (tx: Queryable) => Promise<void>,
  ): Promise<boolean> {
    const workspace = keyOf(descriptor)
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
    const task = previous.then(() => this.transactionNow(descriptor, action))
    this.workspaceTails.set(workspace, task.then(() => undefined, () => undefined))
    return task
  }

  /** {@link transactionOnly}'s body, WITHOUT queueing on the workspace's tail:
   * only for a caller already running in that tail's slot (`publish`'s
   * gate) — queueing there would wait for itself. */
  private async transactionNow(
    descriptor: StaticDocumentDescriptor,
    action: (tx: Queryable) => Promise<void>,
  ): Promise<boolean> {
    {
      if (!this.ownsWorkspace(descriptor)) return false
      const expectedFence = this.ownership?.enabled
        ? this.ownership.fencingToken(descriptor)
        : null
      if (this.ownership?.enabled && !expectedFence) return false
      // No pre-check here: this path takes no projection token, so there is no
      // pool-side `observed_generation` bump to keep off a workspace it has
      // lost. The in-transaction assert under the mutex is the gate, and it is
      // enough on its own.
      const committed: Array<() => void> = []
      let bookTx: Queryable | undefined
      try {
        await withReadModelProjectionTransaction(this.db, descriptor, 'static', async (tx) => {
          // T-ZEROWM-3: THIS transaction's book updates, in a list of its own
          // (a rolled-back one's are dropped with its list), unregistered from
          // the pooled client once the transaction is over (`forgetBookTx`).
          this.afterCommit.set(tx, committed)
          bookTx = tx
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
          await action(tx)
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
        })
        this.forgetBookTx(bookTx, committed)
        this.runAfterCommit(committed)
        return true
      } catch (error) {
        this.forgetBookTx(bookTx, committed)
        if (isProjectionMutexTimeout(error)) {
          console.warn(
            `[read-model] static acknowledgement yielded the mutex for `
            + `${descriptor.landscapeId}/${descriptor.versionId}`,
          )
          return false
        }
        if (!isReadModelAuthorityLoss(error)) throw error
        this.notePlaneLost(descriptor)
        return false
      }
    }
  }

  /** Close every admitted rotation whose version is no longer active, and
   * release the retention pin of the child it can never publish, in ONE
   * statement — inside a bounded transaction on a BORROWED CLIENT. See the
   * caller for why the two halves are one fact, and the body for what
   * `SKIP LOCKED` does and does not bound.
   *
   * It borrows a connection BEFORE the caller's per-row loop, so an accounting
   * of which connection took the overlay key (as in
   * `staticPlaneReconciliation.test.ts`) has to exclude it. */
  private async closeInactiveAdmittedRotations(): Promise<void> {
    // `FOR UPDATE SKIP LOCKED` AND a bounded transaction: neither alone is
    // enough. This is reached from `start()`, so a plain wait behind another
    // pod's `publishAdmittedRotation` would hold one of four connections while
    // the pod never finishes starting.
    //
    // `SKIP LOCKED` handles the ROTATION half: a contended rotation is one
    // another writer is already publishing, the pass is idempotent, so there is
    // nothing to wait for. It does NOT reach the outer segments UPDATE, which
    // takes ordinary row locks — and the holder there is not hypothetical:
    // `synchronizeOverlaySegments` locks every segment row of a (workspace,
    // collection) inside `projectMeta`'s transaction, held under the projection
    // mutex for the whole ModelMeta projection (measured at 26-35 s on a first
    // build). Reached from `start()`, that would delay readiness with nothing
    // bounding it — hence the bounded transaction. The two halves must also
    // stay ATOMIC: closing a rotation whose segment stamp did not land would
    // leave that segment `retain_until IS NULL` and no longer selectable — the
    // permanent pin this whole method exists to remove, created by the method
    // itself. An expired ceiling rolls both back and the next tick redoes them.
    //
    // MEASURED against a real Postgres, two closable rotations with another
    // writer holding one of them, and a control that flips:
    //
    //   FOR UPDATE SKIP LOCKED : completed — free=superseded held=admitted,
    //                            free=released held=pinned
    //   FOR UPDATE (control)   : BLOCKED — NEITHER row closed
    //
    // The control is the argument: without `SKIP LOCKED` one contended row
    // stalls the whole pass, so the free rotation's child stays pinned too.
    // The skipped row keeps its `admitted` status and its pin, which is what
    // makes "the next tick re-derives it" true rather than hopeful.
    //
    // WHAT THAT MEASUREMENT DOES NOT COVER: the holder in it held the ROTATION
    // row. A holder of a SEGMENT row is not skipped — see the caller's note on
    // the outer UPDATE — so this pair of numbers speaks for the `candidates`
    // scan and for nothing below it.
    const client = await this.db.connect()
    let inTransaction = false
    try {
      await this.beginBoundedTransaction(client)
      inTransaction = true
      await client.query(
        `WITH candidates AS (
         SELECT rotation.landscape_id, rotation.version_id,
                rotation.collection, rotation.new_document_id
         FROM read_model_overlay_rotations rotation
         WHERE rotation.status = 'admitted'
           AND NOT EXISTS (
             SELECT 1 FROM versions version
             WHERE version.landscape_id = rotation.landscape_id
               AND version.id = rotation.version_id
               AND version.status = 'active'
           )
         FOR UPDATE SKIP LOCKED
       ), closed AS (
         UPDATE read_model_overlay_rotations rotation
         SET status = 'superseded'
         FROM candidates
         WHERE rotation.landscape_id = candidates.landscape_id
           AND rotation.version_id = candidates.version_id
           AND rotation.collection = candidates.collection
           AND rotation.new_document_id = candidates.new_document_id
         RETURNING rotation.landscape_id, rotation.version_id,
                   rotation.collection, rotation.new_document_id
       )
       UPDATE read_model_overlay_segments segment
          SET retired_at = COALESCE(segment.retired_at, now()),
              retain_until = COALESCE(segment.retain_until,
                now() + ($1::int * interval '1 day'))
         FROM closed
        WHERE segment.landscape_id = closed.landscape_id
          AND segment.version_id = closed.version_id
          AND segment.collection = closed.collection
          AND segment.document_id = closed.new_document_id
          AND NOT segment.is_current`,
        [OVERLAY_RETENTION_DAYS],
      )
      await client.query('COMMIT')
      inTransaction = false
    } finally {
      // Released WITH the error when the ROLLBACK itself failed: pg's
      // `_release` destroys the connection only when one is passed, and a bare
      // release would re-arm the idle listener and hand the same backend, still
      // inside a transaction, to the next borrower.
      let rollbackFailure: unknown
      if (inTransaction) {
        await client.query('ROLLBACK').catch((error: unknown) => { rollbackFailure = error ?? true })
      }
      client.release(rollbackFailure ? (rollbackFailure as Error) : undefined)
    }
  }

  /**
   * Open one of this class's bare transactions with a CEILING on its lock waits.
   *
   * `assertPlaneAndOwnership` is the first statement of each, and it takes
   * `FOR KEY SHARE` on the authority row. The holder on the other side is a
   * demotion or a re-promotion, which can hold that row through a full
   * allow-list DELETE plus bulk INSERT. A rotation parked there holds the
   * `overlay-rotation:…` advisory key at SESSION scope and one of the
   * read-model pool's four connections — and same-workspace publishes queue
   * behind that key with their own ceiling deliberately disarmed
   * (`synchronizeOverlaySegments`/`synchronizeOverlayHead` take it with the
   * blocking `pg_advisory_xact_lock` under
   * `withReadModelProjectionTransaction`'s `lock_timeout = 0`). Without this
   * ceiling the cascade would have no bound anywhere.
   *
   * SCOPE: `SET LOCAL lock_timeout` bounds the TRANSACTION, not the next
   * statement, so it also bounds the row locks
   * `registerStaticReadModelDocuments` takes later. Accepted: those waits are
   * on the same workspace's own rows and the pass retries on the next tick. It
   * is NOT set inside `assertPlaneAndOwnership`, because four of its call
   * sites run under `withReadModelProjectionTransaction`, which sets its own
   * ceiling.
   */
  private async beginBoundedTransaction(client: Queryable): Promise<void> {
    // ONE statement. As two, a `BEGIN` that succeeded followed by a `SET LOCAL`
    // that threw would leave the transaction OPEN while the caller's
    // `inTransaction` flag was still false — so the `catch` would skip its
    // `ROLLBACK` and the `finally` would hand a connection back to the pool
    // still inside a transaction.
    await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
  }

  /**
   * BOTH halves of "may this projector still write for this workspace", as one
   * call, at every site that asks it.
   *
   * The ownership half is FLAG-GATED: it returns on its first line unless
   * `SYNC_CELL_OWNERSHIP=on`, which is not the default. So
   * `assertReadModelPlane` goes FIRST, above that early return, for two
   * reasons:
   *
   *  - it is flag-free. It reads `read_model_static_workspaces`, the durable
   *    fact both lifecycle transitions commit, so it cannot be switched off;
   *  - it takes `FOR KEY SHARE`, so the verdict holds to the COMMIT rather than
   *    to the instant it was taken. A demotion's DELETE waits for this
   *    transaction, and a transaction that BEGINS after the demotion committed
   *    finds no row and throws having written nothing. `holdsStaticPlane` at
   *    each path's entry is a point-in-time verdict; this is a guarantee over
   *    the interval.
   *
   * Folded into one call so a new bare transaction cannot forget half. The
   * cost is a redundant key-share re-acquisition where the caller already holds
   * the row (via `withReadModelProjectionTransaction`), which does not queue.
   *
   * Measured: with a publish holding the authority row in key share, a
   * demotion's DELETE pending, and a rotation holding the overlay advisory the
   * publish wants, the rotation's own `FOR KEY SHARE` returns immediately — two
   * key-share holders are compatible and a PENDING exclusive request does not
   * queue them. No cycle forms through this call; the demotion's own
   * `lock_timeout` bounds the other direction.
   */
  private async assertPlaneAndOwnership(
    tx: Queryable,
    key: WorkspaceKey,
    expectedToken: string | null,
  ): Promise<void> {
    await assertReadModelPlane(tx, key, 'static')
    if (!this.ownership?.enabled) return
    if (!expectedToken || !this.ownsWorkspace(key)) {
      throw new Error('Static read-model projection lost workspace ownership')
    }
    const { rows } = await tx.query<{ fencing_token: string | number; released_at: Date | null }>(
      `SELECT fencing_token, released_at
       FROM sync_workspace_ownership
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    )
    const owner = rows[0]
    if (!owner || owner.released_at || String(owner.fencing_token) !== expectedToken) {
      throw new Error('Static read-model projection fencing rejected a stale owner')
    }
  }
}

/** The diagram ids THIS registry shard carried at its last projection.
 *
 * Read from the shard's own membership snapshot and nowhere else. The obvious
 * alternative — "every diagram of the workspace that is not in this shard" —
 * would make each shard's projection delete every
 * other shard's diagrams, and on a workspace whose registry is mostly baseline
 * it would delete the baseline.
 *
 * A cold projector legitimately reads an empty previous set and therefore
 * deletes nothing. That direction is the safe one: a removal that happened
 * while the projector was down is picked up at the next change of the shard,
 * and `registry-head-projected` reports the gap meanwhile. */
async function registryShardMembershipValues(
  db: Queryable,
  key: WorkspaceKey,
  shardDocumentId: string,
): Promise<StaticMembershipValue[]> {
  const { rows } = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM read_model_static_membership_deltas
      WHERE landscape_id = $1 AND version_id = $2
        AND membership_kind = 'registry_shard_diagram'
        AND owner_id = $3 AND tombstone = false`,
    [key.landscapeId, key.versionId, shardDocumentId],
  )
  return rows.map((row) => ({ entityId: row.entity_id }))
}

async function membershipValues(
  db: Queryable,
  table: 'ro_diagram_objects' | 'ro_diagram_groups' | 'ro_diagram_connections',
  column: 'object_id' | 'group_id' | 'connection_id',
  key: WorkspaceKey,
  diagramId: string,
): Promise<StaticMembershipValue[]> {
  const { rows } = await db.query<{ entity_id: string }>(
    `SELECT ${column} AS entity_id FROM ${table}
     WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
    [key.landscapeId, key.versionId, diagramId],
  )
  return rows.map((row) => ({ entityId: row.entity_id }))
}

async function flowMembershipValues(
  db: Queryable,
  key: WorkspaceKey,
  diagramId: string,
): Promise<StaticMembershipValue[]> {
  const { rows } = await db.query<{ entity_id: string; auxiliary_id: string }>(
    `SELECT connection_id AS entity_id, flow_id AS auxiliary_id
     FROM ro_connection_flows
     WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
    [key.landscapeId, key.versionId, diagramId],
  )
  return rows.map((row) => ({ entityId: row.entity_id, auxiliaryId: row.auxiliary_id }))
}

async function replaceDiagramMembership(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  diagramId: string,
  objectIds: string[],
  groupIds: string[],
  connectionIds: string[],
  flows: StaticMembershipValue[],
  flowIndex: readonly FlowInput[] | null,
): Promise<void> {
  const params = [key.landscapeId, key.versionId, diagramId]
  if (flowIndex) await replaceDiagramFlowIndex(db, key, orgId, diagramId, flowIndex)
  else await dropDiagramFlowIndex(db, key, diagramId)
  const previousConnectionIds = await db.query<{ connection_id: string }>(
    `SELECT connection_id FROM ro_diagram_connections
     WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3
     UNION
     SELECT connection_id FROM ro_connection_flows
     WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
    params,
  )
  await db.query(`DELETE FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`, params)
  await db.query(`DELETE FROM ro_diagram_groups WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`, params)
  await db.query(`DELETE FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`, params)
  await db.query(`DELETE FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`, params)
  if (objectIds.length) await db.query(
    `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
     SELECT $1, $2, $3, $4, id FROM unnest($5::text[]) AS id`,
    [key.landscapeId, key.versionId, orgId, diagramId, objectIds],
  )
  if (groupIds.length) await db.query(
    `INSERT INTO ro_diagram_groups (landscape_id, version_id, org_id, diagram_id, group_id)
     SELECT $1, $2, $3, $4, id FROM unnest($5::text[]) AS id`,
    [key.landscapeId, key.versionId, orgId, diagramId, groupIds],
  )
  if (connectionIds.length) await db.query(
    `INSERT INTO ro_diagram_connections (landscape_id, version_id, org_id, diagram_id, connection_id)
     SELECT $1, $2, $3, $4, id FROM unnest($5::text[]) AS id`,
    [key.landscapeId, key.versionId, orgId, diagramId, connectionIds],
  )
  if (flows.length) await db.query(
    `INSERT INTO ro_connection_flows (
       landscape_id, version_id, org_id, diagram_id, flow_id, connection_id
     )
     SELECT $2, $3, $4, $5, item."auxiliaryId", item."entityId"
     FROM jsonb_to_recordset($1::jsonb) AS item("entityId" text, "auxiliaryId" text)`,
    [JSON.stringify(flows), key.landscapeId, key.versionId, orgId, diagramId],
  )
  await refreshDiagramSummaries(db, key, [diagramId])
  await refreshConnectionStats(db, key, [
    ...previousConnectionIds.rows.map((row) => row.connection_id),
    ...connectionIds,
    ...flows.map((flow) => flow.entityId),
  ])
}
