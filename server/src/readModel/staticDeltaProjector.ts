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
import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo'
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
  replaceDiagramFlowIndex,
  upsertConnections,
  upsertDiagrams,
  upsertGroups,
  upsertObjects,
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
import {
  recordStaticEntityDeltas,
  recordStaticMembershipSnapshot,
  type StaticMembershipValue,
} from './staticDeltaStore.js'
import { isStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { resolveHandleWithRetry } from './projectorService.js'
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
import { captureArrivalWatermark } from './arrivalWatermark.js'
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
  const routes = meta[field] ?? (meta[field] = [])
  if (!routes.includes(url)) routes.push(url)
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
  const routes = meta[field] ?? (meta[field] = [])
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
    return true
  }
  const insertAt = indices[0]
  for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) routes.splice(indices[cursor], 1)
  routes.splice(insertAt, 0, ...mergedUrls)
  return true
}
interface StaticDiagramLike extends DiagramInput {
  flows?: Record<string, FlowInput>
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
/** The answer for a workspace that has no ModelMeta, i.e. no tombstone
 * CHANNEL. Distinct from "tombstones not read yet", which is `undefined` and
 * sends the caller to the durable document.
 *
 * Shared, and read-only BY TYPE only — it is not `Object.freeze`d, so it must
 * never be handed anywhere that would write into it. */
const EMPTY_DIAGRAM_TOMBSTONES: ReadonlySet<string> = new Set<string>()
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

/** Incrementally update one bounded overlay segment. The first complete set of
 * segments performs one full projection; subsequent updates inspect only IDs
 * added/changed/removed in the source segment and scan the small segment list
 * to find each touched ID's newest winner. */
export function updateStaticOverlaySegment<T extends { id: string }>(
  orderedDocumentIds: readonly string[],
  segments: Map<string, Record<string, T>>,
  effective: Map<string, { fingerprint: string; value: T }>,
  documentId: string,
  nextSegment: Record<string, T>,
  tombstones: ReadonlySet<string>,
): { ready: boolean; upserts: T[]; deleteIds: string[] } {
  const wasReady = orderedDocumentIds.every((id) => segments.has(id))
  const previousSegment = segments.get(documentId) ?? {}
  segments.set(documentId, nextSegment)
  const ready = orderedDocumentIds.every((id) => segments.has(id))
  if (!ready) return { ready: false, upserts: [], deleteIds: [] }
  const touched = new Set<string>()
  if (!wasReady) {
    for (const segment of segments.values()) {
      for (const id of Object.keys(segment)) touched.add(id)
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
      if (prior) deleteIds.push(id)
      effective.delete(id)
      continue
    }
    const fingerprint = JSON.stringify(winner)
    if (!prior || prior.fingerprint !== fingerprint) {
      effective.set(id, { fingerprint, value: winner })
      upserts.push(winner)
    }
  }
  return { ready: true, upserts, deleteIds }
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
export class StaticDeltaProjector {
  private readonly instanceId = randomUUID()
  private readonly descriptors = new Map<string, StaticDocumentDescriptor>()
  private readonly listened = new Map<string, { handle: DocHandle<unknown>; stop: () => void }>()
  private readonly workspaceTails = new Map<string, Promise<void>>()
  private readonly docRuns = new Map<string, {
    running: boolean
    pending: boolean
    timer?: NodeJS.Timeout
    firstQueuedAt?: number
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
  private readonly overlayState = new Map<string, StaticOverlayState>()
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
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.stopEvictionListener ??= this.residency?.onBeforeEvict((documentId) => this.detach(documentId)) ?? null
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
    for (const pending of this.pendingRotations.values()) clearTimeout(pending.timer)
    this.pendingRotations.clear()
    for (const run of this.docRuns.values()) if (run.timer) clearTimeout(run.timer)
    this.docRuns.clear()
    this.scanTimer = null
    this.reloadTimer = null
    this.repo.off('document', this.onDocument)
    this.stopEvictionListener?.()
    this.stopEvictionListener = null
    for (const listener of this.listened.values()) listener.stop()
    this.listened.clear()
    const workspaces = new Set([
      ...this.attachedWorkspaces.keys(),
      ...this.currentOverlayDocumentIds.keys(),
    ])
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
    this.currentOverlayDocumentIds.clear()
    this.metaSemanticFingerprints.clear()
    // A descriptor refresh may already be inside a PostgreSQL query when the
    // interval is cleared. Drain it before the caller closes the shared pool.
    await this.reloadTail
    // Before the tails: a queued repair re-checks `stopped` and returns, and
    // the one in progress is inside a `transactionOnly` the tails then cover.
    await this.c4RepairChain
    await Promise.allSettled([...this.workspaceTails.values()])
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
    this.metaSemanticFingerprints.delete(workspace)
    this.currentOverlayDocumentIds.delete(workspace)
    for (const [rotationKey, pending] of this.pendingRotations) {
      if (!rotationKey.startsWith(`${workspace}\u0000`)) continue
      clearTimeout(pending.timer)
      this.pendingRotations.delete(rotationKey)
    }
    this.residency?.releaseOwner(`static-write-head:${workspace}:object`)
    this.residency?.releaseOwner(`static-write-head:${workspace}:connection`)
    this.residency?.releaseOwner(`static-control:${workspace}:root`)
    this.residency?.releaseOwner(`static-control:${workspace}:model-meta`)
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
    const { rows } = await this.db.query<{ document_id: string }>(
      `SELECT queue.document_id
       FROM read_model_static_document_queue queue
       JOIN read_model_static_documents document
         ON document.landscape_id = queue.landscape_id
        AND document.version_id = queue.version_id
        AND document.document_id = queue.document_id
       WHERE queue.revision > queue.projected_revision
       ORDER BY queue.enqueued_at
       LIMIT 1000`,
    )
    for (const row of rows) {
      // Per ROW as well as at the head: this loop is up to 1 000 iterations of
      // `resolveHandleWithRetry` (five tries, 250 ms apart) and a projection.
      if (this.stopped) return
      const descriptor = this.descriptors.get(row.document_id)
      if (!descriptor || !this.ownsWorkspace(descriptor)) continue
      try {
        const handle = await resolveHandleWithRetry(
          this.repo, `automerge:${row.document_id}` as AutomergeUrl,
          { tries: 5, delayMs: 250 },
        )
        this.attach(handle)
        // A current overlay can be observed before every historical segment is
        // hydrated. Its first projection then intentionally stops at
        // `delta.ready === false`, without advancing the durable queue. Once
        // hydration completes the handle is still resident, so attach() is a
        // no-op and no Automerge change event is guaranteed to replay it.
        // Explicitly retry durable pending work for an already-listened handle.
        this.trigger(descriptor, handle, true)
      } catch (error) {
        console.error('[read-model] static changed-document recovery failed', error)
      }
    }
    await Promise.allSettled([...this.workspaceTails.values()])
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
  ): void {
    const state = this.docRuns.get(descriptor.documentId) ?? { running: false, pending: false }
    this.docRuns.set(descriptor.documentId, state)
    if (state.running) { state.pending = true; return }
    const start = () => {
      if (this.stopped || state.running) return
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.firstQueuedAt = undefined
      state.running = true
      state.pending = false
      void (async () => {
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
        // `detach()` may have deleted this run's `docRuns` entry, and `state` is
        // a closure over the object it deleted. Re-entering `trigger` would
        // `set` a NEW entry for a descriptor that no longer exists: one Map
        // entry that survives to `stop()`, plus a `project()` call the plane
        // check then refuses. Reachable on every reconciliation.
        // A CONDITION, never a `return` — a `return` inside `finally` discards
        // whatever exception is propagating (eslint `no-unsafe-finally`).
        if (this.descriptors.has(descriptor.documentId) && state.pending && !this.stopped) {
          this.trigger(descriptor, handle)
        }
      }
      })()
    }

    if (immediate || (descriptor.kind !== 'object-overlay' && descriptor.kind !== 'connection-overlay')) {
      start()
      return
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
    state.timer = setTimeout(start, delayMs)
    state.timer.unref()
  }

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
    if (!(await this.holdsStaticPlane(descriptor))) return
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    // Capture one immutable source revision, then flush that document before
    // reading its durable queue revision or publishing any derived rows/batch
    // acknowledgement. A takeover must never observe an acknowledged read-model
    // value whose Automerge source still existed only in the former owner's RAM.
    let phaseStartedAt = performance.now()
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
    phaseStartedAt = performance.now()
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
      result = this.projectMeta(descriptor, snapshot as StaticMetaLike, sourceRevision)
    } else if (descriptor.kind === 'diagram' && descriptor.entityId) {
      result = this.projectDiagram(descriptor, snapshot as StaticDiagramLike, sourceRevision)
    } else if (descriptor.kind === 'registry-shard') {
      result = this.projectRegistryShard(descriptor, snapshot as RegistryShardLike, sourceRevision)
    } else if (descriptor.kind === 'root') {
      result = this.projectRoot(descriptor, snapshot as StaticRootLike)
    } else {
      result = Promise.resolve()
    }
    await result
    timings.projectionMs = performance.now() - phaseStartedAt
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
    this.overlayState.set(keyOf(descriptor), {
      objectDocumentIds: nextObjectDocumentIds,
      connectionDocumentIds: nextConnectionDocumentIds,
      deletedObjectIds: deletedObjectSet,
      deletedConnectionIds: deletedConnectionSet,
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
      // The `deletedObjectIds` / `deletedConnectionIds` twins above have the
      // same shape and are deliberately NOT changed here: their counters are
      // not fed by a row count, so replay would need its own measurement.
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

    const groups = Object.values(meta.groups ?? {})
    const previousGroups = await this.db.query<{ id: string }>(
      `SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2`,
      [descriptor.landscapeId, descriptor.versionId],
    )
    phaseTimings.loadGroupsMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    const groupIds = new Set(groups.map((group) => group.id))
    const deletedGroupIds = previousGroups.rows.map((row) => row.id).filter((id) => !groupIds.has(id))
    const deletedObjectIds = nextDeletedObjectIds
    const deletedConnectionIds = nextDeletedConnectionIds
    const newlyDeletedObjectIds = deletedObjectIds.filter((id) => !previousOverlayState?.deletedObjectIds.has(id))
    const newlyDeletedConnectionIds = deletedConnectionIds.filter((id) => !previousOverlayState?.deletedConnectionIds.has(id))
    // The DELTA, not the list. `deleteDiagrams` is idempotent on the ro_* rows,
    // but `adjustWorkspaceCount` is a running counter — replaying the full list
    // on every projection would walk the footer total down to zero and clamp
    // there, permanently lying about a workspace nothing was wrong with.
    const newlyDeletedDiagramIds = nextDeletedDiagramIds.filter((id) => !previousOverlayState?.deletedDiagramIds.has(id))
    const decisions = Object.values(meta.decisionRecords ?? {})
    const deletedDecisionIds = unique(meta.deletedDecisionRecordIds ?? [])
    const objectUpsertIds = groups.map((group) => group.id)
    const objectDeleteIds = [...newlyDeletedObjectIds, ...deletedGroupIds]
    const hasObjectChanges = objectUpsertIds.length > 0 || objectDeleteIds.length > 0
    const change: ReadModelChangePayload = hasObjectChanges && newlyDeletedConnectionIds.length
      ? { kind: 'reset', scope: 'all' }
      : hasObjectChanges
        ? { kind: 'objects', upsertIds: objectUpsertIds, deleteIds: objectDeleteIds }
        : newlyDeletedConnectionIds.length
          ? { kind: 'connections', upsertIds: [], deleteIds: newlyDeletedConnectionIds }
          : { kind: 'reset', scope: 'groups' }
    await this.publish(descriptor, 'metadata', change, async (tx, generation) => {
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

      await upsertDecisionRecords(tx, descriptor, descriptor.orgId, decisions)
      await deleteDecisionRecords(tx, descriptor, descriptor.orgId, deletedDecisionIds)
      await recordStaticEntityDeltas(tx, descriptor, 'group', generation, groups, deletedGroupIds)
      await recordStaticEntityDeltas(tx, descriptor, 'object', generation, [], newlyDeletedObjectIds)
      await recordStaticEntityDeltas(tx, descriptor, 'connection', generation, [], newlyDeletedConnectionIds)
      await recordStaticEntityDeltas(tx, descriptor, 'diagram', generation, [], newlyDeletedDiagramIds)
      await recordStaticEntityDeltas(tx, descriptor, 'decision_record', generation, decisions, deletedDecisionIds)
    }, sourceRevision)
    // The tombstone baseline advances HERE, after the transaction committed —
    // never at the top of the pass, where a short circuit could still return
    // having applied nothing (see the note on `deletedDiagramIds` above).
    const publishedState = this.overlayState.get(keyOf(descriptor))
    if (publishedState) publishedState.deletedDiagramIds = new Set(nextDeletedDiagramIds)
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
        this.attach(handle)
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
    if (!state) {
      state = {
        objectDocumentIds: kind === 'object' ? [descriptor.documentId] : [],
        connectionDocumentIds: kind === 'connection' ? [descriptor.documentId] : [],
        deletedObjectIds: new Set(),
        deletedDiagramIds: new Set(),
        deletedConnectionIds: new Set(),
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
    if (sourceConflicts.size && handle) {
      const healed = await this.healCurrentOverlayConflicts(
        descriptor, kind, snapshot, sourceConflicts, state, handle, sampledHeads,
      )
      // The healing assignment resolves the Automerge conflicts and triggers a
      // fresh projection — as does the write that made a sample stale. Never
      // publish or acknowledge the lossy JSON winner.
      if (healed) return
    }
    if (kind === 'object') {
      const overlayStartedAt = performance.now()
      const documentSnapshot = (snapshot as ObjectOverlayLike).objects ?? {}
      const batchIds = overlayBatchIds(snapshot)
      const segments = state?.objectSegments ?? new Map<string, Record<string, ObjectInput>>()
      const effective = state?.effectiveObjects ?? new Map<string, { fingerprint: string; value: ObjectInput }>()
      const delta = updateStaticOverlaySegment(
        orderedIds,
        segments,
        effective,
        descriptor.documentId,
        documentSnapshot,
        state?.deletedObjectIds ?? new Set(),
      )
      const deltaMs = performance.now() - overlayStartedAt
      if (!delta.ready) return
      if (!delta.upserts.length && !delta.deleteIds.length) {
        await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
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
      await this.publish(descriptor, 'object_shard', {
        kind: 'objects', upsertIds: delta.upserts.map((object) => object.id), deleteIds: delta.deleteIds,
      }, async (tx, generation) => {
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
      }, sourceRevision)
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
    const delta = updateStaticOverlaySegment(
      orderedIds,
      segments,
      effective,
      descriptor.documentId,
      documentSnapshot,
      state?.deletedConnectionIds ?? new Set(),
    )
    const deltaMs = performance.now() - overlayStartedAt
    if (!delta.ready) return
    if (!delta.upserts.length && !delta.deleteIds.length) {
      await this.acknowledgeOnly(descriptor, sourceRevision, async (tx) => {
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
    await this.publish(descriptor, 'connection_shard', {
      kind: 'connections', upsertIds: delta.upserts.map((connection) => connection.id), deleteIds: delta.deleteIds,
    }, async (tx, generation) => {
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
    }, sourceRevision)
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
      const target = kind === 'object'
        ? (mutable.objects ??= {}) as Record<string, ObjectInput | ConnectionInput>
        : (mutable.connections ??= {}) as Record<string, ObjectInput | ConnectionInput>
      for (const [entityId, value] of upserts) target[entityId] = plain(value)
      // Forwarded acknowledgements must reach the current projector, but they
      // are not new writes on this head. Counting them as local write batches
      // made every post-rotation forward immediately trigger another rotation.
      mutable.forwardedBatchIds = unique([
        ...(mutable.forwardedBatchIds ?? []),
        ...pendingBatchIds,
      ])
    })

    const metaDescriptor = [...this.descriptors.values()].find((candidate) => (
      candidate.kind === 'model-meta' && keyOf(candidate) === keyOf(descriptor)
    ))
    if (!metaDescriptor) throw new Error('Historical overlay forwarding requires ModelMeta')
    const metaHandle = await this.resolveDocumentHandle<StaticMetaLike>(metaDescriptor.documentId)
    if (upserts.size) {
      metaHandle.change((doc) => {
        const field = kind === 'object' ? 'deletedObjectIds' : 'deletedConnectionIds'
        const next = new Set(doc[field] ?? [])
        for (const entityId of upserts.keys()) next.delete(entityId)
        doc[field] = [...next]
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
    if (resident?.state === 'ready') return resident as DocHandle<T>
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
      const mutable = doc as ObjectOverlayLike & ConnectionOverlayLike
      const remaining = unique(mutable.forwardedBatchIds ?? [])
        .filter((batchId) => !acknowledged.has(batchId))
      if (remaining.length) mutable.forwardedBatchIds = remaining
      else delete mutable.forwardedBatchIds
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
      const currentUrl = metaHandle.doc()?.[field]
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
      const stillCurrent = metaHandle.doc()?.[field]
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

      await this.publishAdmittedRotation(
        client, descriptor, metaHandle, kind, descriptor.documentId, child.documentId, child.url,
      )
      await this.activatePublishedOverlayHead(descriptor, kind, child, metaHandle)
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
    const meta = metaHandle.doc()
    if (!meta) return
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
  ): Promise<void> {
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
      const currentUrl = metaHandle.doc()?.[currentField]
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
        return
      }
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      await client.query('COMMIT')
      inTransaction = false

      if (currentDocumentId === oldDocumentId) {
        metaHandle.change((meta) => {
          appendUniqueOverlayRoute(meta, segmentsField, newUrl)
          meta[currentField] = newUrl
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

      await this.beginBoundedTransaction(client)
      inTransaction = true
      await this.assertPlaneAndOwnership(client, descriptor, this.expectedOwnershipFence(descriptor))
      const publishedUrl = metaHandle.doc()?.[currentField]
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
        return
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
    } finally {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    }
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
      const meta = metaHandle.doc()
      if (!meta) { skippedReason = 'no-model-meta'; return }
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
      const freshMeta = metaHandle.doc()
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
          mutable, segmentsField, foldedUrls, mergedUrls, true, true, mutable[currentField],
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
      chainAfter = unique(metaHandle.doc()?.[segmentsField] ?? []).length
      chainAfterRaw = (metaHandle.doc()?.[segmentsField] ?? []).length
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
  private async durableDeletedDiagramIds(
    descriptor: StaticDocumentDescriptor,
  ): Promise<ReadonlySet<string>> {
    const known = this.overlayState.get(keyOf(descriptor))?.metaDeletedDiagramIds
    if (known) return known
    const metaDescriptor = [...this.descriptors.values()].find((candidate) => (
      candidate.kind === 'model-meta' && keyOf(candidate) === keyOf(descriptor)
    ))
    if (!metaDescriptor) return EMPTY_DIAGRAM_TOMBSTONES
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

    return this.publish(descriptor, 'registry', { kind: 'reset', scope: 'diagrams' }, async (tx, generation) => {
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
        return diagramRowFingerprint({ ...row.data, ...meta, id: meta.id })
          !== diagramRowFingerprint(row.data)
      })
      await bumpDiagramRenderGenerations(tx, descriptor, generation, {
        diagramIds: [...changed.map((meta) => meta.id), ...removed],
      })

      if (changed.length) {
        const merged = changed.map((meta) => ({
          ...(currentById.get(meta.id)?.data ?? {}),
          ...meta,
          id: meta.id,
        } as DiagramInput))
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

  private projectDiagram(
    descriptor: StaticDocumentDescriptor,
    doc: StaticDiagramLike,
    sourceRevision: number,
  ): Promise<void> {
    const diagramId = descriptor.entityId!
    return this.publish(descriptor, 'registry', { kind: 'reset', scope: 'diagrams' }, async (tx, generation) => {
      await captureSparseDraftEntityBases(tx, descriptor, 'diagram', [diagramId])
      await bumpDiagramRenderGenerations(tx, descriptor, generation, { diagramIds: [diagramId] })
      const current = await tx.query<{ data: Record<string, unknown>; org_id: string | null }>(
        `SELECT data, org_id FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
        [descriptor.landscapeId, descriptor.versionId, diagramId],
      )
      const merged: DiagramInput = { ...(current.rows[0]?.data ?? {}), ...doc, id: diagramId }
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
    }, sourceRevision)
  }

  private publish(
    descriptor: StaticDocumentDescriptor,
    kind: ProjectionKind,
    change: ReadModelChangePayload,
    action: (tx: Queryable, generation: number) => Promise<void>,
    sourceRevision = 0,
  ): Promise<void> {
    const workspace = keyOf(descriptor)
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
    const task = previous.then(async () => {
      if (!this.ownsWorkspace(descriptor)) return
      const expectedFence = this.ownership?.enabled
        ? this.ownership.fencingToken(descriptor)
        : null
      if (this.ownership?.enabled && !expectedFence) return
      // The PLANE pre-check. Not the gate — the in-transaction assert under
      // the mutex is — but `beginReadModelProjection` runs on the POOL, and
      // its `observed_generation` bump survives the rollback that follows.
      // Without this, every publish for a demoted workspace would bump the
      // ORDINARY projector's generation once per attempt, walking a healthy
      // workspace to `catching_up`, refusing `absenceProvable` and blocking
      // compaction — while every one of those attempts was going to roll back.
      // `runTracked` carries the same shape for the write fence, for the same
      // reason and with the same "this is not the gate" caveat.
      if (!(await this.holdsStaticPlane(descriptor))) return
      const token = await beginReadModelProjection(this.db, descriptor, descriptor.orgId, kind)
      try {
        await withReadModelProjectionTransaction(this.db, descriptor, 'static', async (tx) => {
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
          // Every `objects` change this projector publishes names the ids it
          // wrote; the rows that write moves without naming them (children
          // whose c4ParentId/parentId follows a deleted or re-created parent)
          // are read here, under the mutex, BEFORE the write — the one place,
          // so no publish site can forget them (objectExplorer.ts).
          const published = change.kind === 'objects'
            ? await objectChangeWithCacheNeighbours(tx, descriptor, change)
            : change
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
          }
          await completeReadModelProjection(tx, descriptor, token)
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
        })
      } catch (error) {
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
          return
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
          return
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
    const task = previous.then(async () => {
      if (!this.ownsWorkspace(descriptor)) return false
      const expectedFence = this.ownership?.enabled
        ? this.ownership.fencingToken(descriptor)
        : null
      if (this.ownership?.enabled && !expectedFence) return false
      // No pre-check here: this path takes no projection token, so there is no
      // pool-side `observed_generation` bump to keep off a workspace it has
      // lost. The in-transaction assert under the mutex is the gate, and it is
      // enough on its own.
      try {
        await withReadModelProjectionTransaction(this.db, descriptor, 'static', async (tx) => {
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
          await action(tx)
          await this.assertPlaneAndOwnership(tx, descriptor, expectedFence)
        })
        return true
      } catch (error) {
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
    })
    this.workspaceTails.set(workspace, task.then(() => undefined, () => undefined))
    return task
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
