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

import type { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo'
import { isValidAutomergeUrl, parseAutomergeUrl, stringifyAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo'
import { getHeads, init as initDoc, loadIncremental, merge as mergeDocs, type Doc } from '@automerge/automerge'
import { randomUUID } from 'node:crypto'
import {
  headsEqual as watermarkHeadsEqual,
  recordSampledDocumentWatermark,
  recordSampledDocumentWatermarks,
  prepareDocumentWatermarkProofs,
  type PreparedDocumentWatermarks,
} from './arrivalWatermark.js'

/** `getHeads` throws on anything that is not a real Automerge document root
 * (fake test docs, plain objects from a fake resolver). No heads is always the
 * SAFE answer for its consumers: an explicit refusal, and a seeded boot shard
 * projects once rather than assuming there is no gap. */
function tryGetAutomergeHeads(doc: unknown): readonly string[] | null {
  if (!doc) return null
  try {
    return getHeads(doc as never)
  } catch {
    return null
  }
}
import { cachedHandles, syncedHandle } from '../automergeRepoCompat.js'
import { pool, storageWriteApplication } from '../db.js'
import { isStaticReadModelWorkspace } from './staticWorkspace.js'
import {
  assertReadModelWriteFence,
  beginReadModelProjection,
  claimReadModelWriteFence,
  clearReadModelWorkspaceDegraded,
  completeReadModelProjection,
  failReadModelProjection,
  markReadModelProjectorAttached,
  markReadModelProjectorDetached,
  markReadModelWorkspaceDegraded,
  ReadModelWriteFenceError,
  readWriteFence,
  type DegradationKind,
  type ProjectionKind,
} from './health.js'
import {
  coldBuildReadModel, applyObjectShardDelta, applyConnectionShardDelta, syncGroups, syncDiagrams,
  deleteObjects, deleteConnections, syncConnectionFlows,
  type WorkspaceKey,
} from './projector.js'
import type { Queryable, ObjectInput, ConnectionInput, GroupInput, DiagramInput, FlowInput } from './types.js'
import { resolveCooperatively, resolveInBatches } from './batchedResolve.js'
import {
  isUninformative,
  readEntityMap,
  readEntityMapOrDefect,
  summarizeModelDefects,
  type ModelDefect,
} from './modelDefects.js'
import { DIGEST_KINDS, digestOfIds } from './contentDigest.js'
import {
  hasIntegrityToStamp,
  recordRefusedProjection,
  stampProjectionIntegrity,
  type ProjectionIntegrity,
} from './projectionIntegrity.js'
import {
  classifyDocumentResolutionError,
  describeDocumentResolutionFailure,
  documentIdOf,
  documentRepoState,
  releaseUnavailableDocument,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution.js'
import { mayReleaseDocument } from './documentReleaseGuard.js'
import {
  DocumentRetryQueue,
  documentRetryRegistry,
  type DocumentRetryAbandonReason,
} from './documentRetryQueue.js'
import { appendReadModelChange, type ReadModelChangePayload } from './changeFeed.js'
import { servedObjectRowsChangedBy } from './objectExplorer.js'
import { connectionMembershipCounts, servedConnectionRowsChangedBy } from './offlineCache.js'
import { diagramIdsReferencing, servedDiagramRowsChangedBy } from './diagramOffline.js'
import { changedCacheRowIds, type ServedRowChanges } from './servedRowDigest.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import {
  ReadModelPlaneError,
  assertReadModelPlane,
  isProjectionMutexTimeout,
  isReadModelAuthorityLoss,
} from './projectionAuthority.js'
import { isPool } from './queryableShape.js'
import { rotateOrdinaryHead } from './ordinaryHeadRotator.js'
import { ordinaryRotationTelemetry } from './ordinaryRotationTelemetry.js'
import { foldOrdinaryChain, unrecordedFoldProductOf } from './ordinaryChainFoldWriter.js'
import { countDocumentLoad, DOCUMENT_LOAD_LOG_MS, type DocumentLoadCaller } from './documentLoadTelemetry.js'
import {
  advanceFoldedArrivalWatermark,
  arrivalAbove,
  databaseNow,
  documentContentArrivals,
  documentContentChunks,
  foldedHeadsWithArrivals,
  HANDOVER_BARRIER_WARN_MS,
  HANDOVER_RECHECK_MAX_ATTEMPTS,
  HANDOVER_RECHECK_PER_POLL,
  handoverBarrierBlockers,
  handoverRecheckDelay,
  laterArrival,
  noteHandoverBarrierTimeout,
  noteHandoverRecheckAbandoned,
  ordinaryHandoverBarrierMaxWaitMs,
  withHandoverRecheckPermit,
  ordinaryFoldArrivalPollMs,
  ordinaryHandoverRecheckMs,
  ordinaryRetiredHeadParkMs,
  parkedStampWait,
} from './ordinaryFoldedArrivals.js'
import {
  foldSourcesToDetach,
  hasOrdinaryFoldMarker,
  ORDINARY_FOLD_PRODUCT_CHANGED,
  ORDINARY_FOLD_SOURCES_NOT_SETTLED,
  ORDINARY_FOLD_SOURCES_NOT_WATCHED,
  ordinaryFoldRecordRefusal,
  ordinaryFoldSourcesOf,
  readOrdinaryChainFold,
} from './ordinaryChainFold.js'
import { createClaimedOverlaySegment, OverlaySegmentAbortedError, publishOverlaySegment, type OverlayMetaLike } from '../overlaySegments.js'
import {
  ColdBuildAdmission,
  ColdBuildAdmissionStoppedError,
  coldBuildAdmissionConfig,
  type ColdBuildAdmissionSnapshot,
} from './coldBuildAdmission.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { collectAutomergeEntityConflicts } from './overlayHistoryProtocol.js'
import { healWholeEntityConflicts } from './overlayConflictHealing.js'
import {
  DEFAULT_ORDINARY_HEAD_ROTATION_MAX_DEFER_MS,
  DEFAULT_ORDINARY_HEAD_ROTATION_QUIET_MS,
  ORDINARY_HEAD_ROTATION_OFF,
  OrdinaryHeadRotationObserver,
  ordinaryHeadRotationConfig,
  type OrdinaryHeadKind,
  type OrdinaryHeadRotationConfig,
} from './ordinaryHeadRotation.js'
import {
  acknowledgeOverlayBatches,
  captureOverlayEntityBases,
} from './overlayHistoryStore.js'
import {
  forwardRetiredHead,
  forwardsLateWrites,
  loadOrdinaryHeadRetirements,
  ordinaryHeadLateWritesPending,
  retirementKey,
  type OrdinaryHeadRetirement,
} from './ordinaryHeadForwarding.js'

/**
 * The live server-side projector, one per workspace.
 * Subscribes to the Automerge model docs the server already holds and keeps the
 * Postgres read model in sync:
 *   - cold build on start (O(model), once, scoped to one workspace's rows);
 *   - per-shard incremental on each shard's change (O(shard));
 *   - full group re-sync on ModelMeta change (groups aren't sharded).
 *
 * Idempotent + self-healing: the read model is a cache, never authoritative. Errors
 * are logged, never thrown — a projection failure must not take the sync peer down.
 * Enabled by READ_MODEL=on (off by default; the server is otherwise unchanged).
 *
 * A single process serves MANY workspaces (landscape+version pairs).
 * `ProjectorFleet` below is the multi-workspace supervisor built on top of the
 * single-root `startReadModelProjector` primitive — that primitive keeps its root URL in / stop() out contract; an optional residency
 * registry lets production lease listener documents without affecting direct
 * callers or tests.
 */

/** A doc shape read structurally (the server has no client types). */
interface RootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
// No `RegistryShardLike` structural type, deliberately: registry shards are
// read through `readEntityMap`, which takes `unknown` and reports what it found
// rather than letting an optional `diagrams?:` field quietly be absent.
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  groups?: Record<string, GroupInput>
  /** Delete tombstones written by boot-from-server clients (objects/connections whose
   * base shard the client couldn't load). Excluded from the read model + deleted on
   * meta change; the daily compaction removes them from the base shards + clears these. */
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
}
interface ModelLike {
  objects?: Record<string, ObjectInput>
  connections?: Record<string, ConnectionInput>
  groups?: Record<string, GroupInput>
}
/** `writeBatchIds` is the client's own list of the write batches it put into
 * this head (`bridge.ts` `writeEditsShards`, pushed in place), the ids it
 * later asks `/api/model/overlay-batches/status` about. */
interface ObjShardLike { objects?: Record<string, ObjectInput>; writeBatchIds?: string[]; forwardedBatchIds?: string[] }
interface ConnShardLike { connections?: Record<string, ConnectionInput>; writeBatchIds?: string[]; forwardedBatchIds?: string[] }
// Likewise no `DiagramDocLike`: diagram documents are read through
// `readEntityMapOrDefect`, so a missing `flows` is reported, not ignored.

type Resolve = (url: string) => Promise<unknown>

/** Diagram documents attempted at once. Matches the retry queue's default
 * concurrency so a registry of unresolvable references cannot exceed the same
 * bound on the direct path either. */
const DIAGRAM_ATTACH_CONCURRENCY = 4
/** Bounded reprojection budget after a PostgreSQL/projection failure. Never
 * unlimited: a database outage must not turn into perpetual background work. */
const DIAGRAM_REPROJECTION_ATTEMPTS = 5

/**
 * Wall-clock ceiling on ONE `repo.find()` attempt.
 *
 * `repo.find()` can never settle. With a network adapter attached and ZERO
 * connected peers — the shape of every production server between the moment it
 * binds and the moment the first browser connects — a document that is in
 * neither storage nor any peer leaves its `DocumentQuery` in `loading`
 * indefinitely: no source ever reports it unavailable, so `find` neither
 * resolves nor rejects. Measured against `@automerge/automerge-repo`
 * 2.6.0-alpha.2, same missing document, same storage:
 *
 *     no network adapter        -> rejects "is unavailable" after 2 ms
 *     ws adapter, zero peers    -> STILL PENDING at 10 000 ms
 *
 * Every projector resolution funnels through `resolveHandleWithRetry`, so
 * without a ceiling that is a hang, not a slow path: the cold build never
 * reaches `markReadModelProjectorAttached`, every `/api/model/*` route for the
 * workspace answers 503 forever, and one of only two cold-build admission slots
 * is held for the life of the process (until a browser attaches a peer).
 *
 * Rule: never await the resolution of a document a remote peer may be the only
 * holder of without a bound. The ceiling converts the hang into the outcome the rest of this file already knows
 * how to absorb: `unavailable`, hence the bounded per-workspace retry queue.
 *
 * Budget arithmetic, worst case, when NOTHING resolves: the boot diagram probe
 * runs `tries: 1` at `DIAGRAM_ATTACH_CONCURRENCY`, so a 34-diagram workspace
 * costs ceil(34/4) x deadline before it attaches with every document queued.
 * Control documents use the default 20 tries and so bound a doomed projector
 * start at 20 x (deadline + delay).
 */
const RESOLVE_DEADLINE_MS = 10_000
/** Attempts for a CONTROL document on the BOOT path (root, ModelMeta, the boot
 * shard list). See the call site in `resolveHandle` for why this is not the
 * twenty-attempt default. */
const CONTROL_DOCUMENT_TRIES = 3
/** Attempts for a shard a client published MID-SESSION and is still pushing.
 * Deliberately larger than the boot budget — see `resolveHandleRetry`. */
const SHARD_ARRIVAL_TRIES = 20
/** Cadence of the health beat when no resident sweep sets one. See its call
 * site: it is the only thing that re-decides a health report on a workspace
 * with no change traffic. */
const DEFAULT_HEALTH_BEAT_MS = 1_000

/**
 * The "a pass is in flight" guard that makes `publishHealthIfNothingOutstanding`
 * inert, as a testable object rather than a closure over a `let`.
 *
 * Every long-awaiting pass must raise it: a shard appended to ModelMeta or to
 * the root is resolved by POLLING for its arrival, and `degradedShards` stays
 * empty for the whole poll, so without the guard the 1 s health beat would
 * publish "nothing outstanding" in the middle of a pass that had not read a
 * byte.
 *
 * Exported at module scope so a unit test can drive both properties directly
 * (no production caller of `run` rejects, and the nested case needs two shard
 * arrivals gated independently): the depth must be a counter, not a boolean,
 * and `depth -= 1` must stay in the `finally` — one rejecting pass would
 * otherwise latch the depth at 1 and the workspace could never be reported
 * healthy again.
 */
export function createReconcilingGuard(): {
  readonly depth: number
  run: <T>(pass: () => Promise<T>) => Promise<T>
} {
  // DEPTH, not a boolean: the registry coalescer can start a pass while the boot
  // pass is still unwinding, and a boolean would let the inner one clear the
  // guard for both.
  let depth = 0
  return {
    get depth() { return depth },
    // `pass()` is called INSIDE the `try`, so a callback that throws
    // synchronously still reaches the `finally` — the `f().then()`
    // versus `try { await f() }` distinction, in the direction that is safe.
    run: async <T>(pass: () => Promise<T>): Promise<T> => {
      depth += 1
      try {
        return await pass()
      } finally {
        depth -= 1
      }
    },
  }
}
export function documentResolveDeadlineMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  // `>= 1`, and a blank string is UNSET, not zero. `Number('')` is 0 and 0 is
  // finite, so the obvious `Number.isFinite(v) && v >= 0` admits the one value
  // that disables the ceiling entirely — and a dangling `VAR=` in an env file or
  // a compose `environment:` entry produces exactly that. Matches
  // `boundedNumber` in documentRetryQueue.ts and `boundedInteger` in
  // coldBuildAdmission.ts.
  const raw = env.READ_MODEL_RESOLVE_DEADLINE_MS
  if (raw === undefined || raw.trim() === '') return RESOLVE_DEADLINE_MS
  const configured = Number(raw)
  return Number.isFinite(configured) && configured >= 1 ? configured : RESOLVE_DEADLINE_MS
}

const RESIDENT_SWEEP_MS = 1_000

/**
 * Interval of the resident re-attach sweep. An explicit `0` disables it; a
 * blank or invalid value is UNSET and keeps the default. `Number('')` is 0, so
 * without this a dangling `READ_MODEL_RESIDENT_SWEEP_MS=` would silently turn
 * the re-attach off and leave evicted diagrams unprojected.
 */
export function residentSweepIntervalMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.READ_MODEL_RESIDENT_SWEEP_MS
  if (raw === undefined || raw.trim() === '') return RESIDENT_SWEEP_MS
  const configured = Number(raw)
  return Number.isFinite(configured) && configured >= 0 ? configured : RESIDENT_SWEEP_MS
}

/**
 * A wall-clock bound on one awaited operation.
 *
 * `guard()` RACES rather than relying on the callee to honour `signal`. That
 * distinction is the whole guarantee: a ceiling that only works when the callee
 * cooperates is not a ceiling, and this one exists precisely because
 * automerge-repo's `find` can sit in a state nothing ever resolves. `signal` is
 * still handed to the callee so a cooperative one can stop early and clean up.
 *
 * Hand-rolled rather than `AbortSignal.any([signal, AbortSignal.timeout(ms)])`
 * for a second reason: the caller has to tell the two aborts apart. A deadline
 * means "not here yet, queue it"; the caller's own signal means "we are shutting
 * down, drop it" — and `AbortSignal.timeout` reports a `TimeoutError`, which
 * `classifyDocumentResolutionError` already reads as a cancellation.
 */
interface ResolveDeadline {
  signal: AbortSignal | undefined
  guard: <T>(promise: Promise<T>) => Promise<T>
  expired: () => boolean
  dispose: () => void
}

function withDeadline(signal: AbortSignal | undefined, ms: number): ResolveDeadline {
  if (ms <= 0) {
    return { signal, guard: (promise) => promise, expired: () => false, dispose: () => {} }
  }
  const controller = new AbortController()
  let expired = false
  let trip: ((reason: unknown) => void) | undefined
  const tripwire = new Promise<never>((_, reject) => { trip = reject })
  // Nothing ever awaits `tripwire` alone, so an unraced deadline would be an
  // unhandled rejection the moment it fires.
  tripwire.catch(() => {})
  const timer = setTimeout(() => {
    expired = true
    const reason = new Error(`document resolution exceeded ${ms} ms`)
    controller.abort(reason)
    trip?.(reason)
  }, ms)
  // Never hold the process open for a deadline that only bounds a wait.
  timer.unref?.()
  const onAbort = () => {
    controller.abort(signal?.reason)
    trip?.(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'))
  }
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    guard: (promise) => {
      // The loser of the race is abandoned, still pending; without this its
      // eventual rejection surfaces as an unhandled rejection and, under
      // `--unhandled-rejections=strict`, kills the server.
      promise.catch(() => {})
      return Promise.race([promise, tripwire])
    },
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

export interface ExtractedModel {
  objects: ObjectInput[]
  connections: ConnectionInput[]
  groups: GroupInput[]
  diagrams: DiagramInput[]
  objectShardUrls: string[]
  connectionShardUrls: string[]
  registryShardUrls: string[]
  /** RAW per-shard content, PRE-dedup, keyed by shard url. The boot watchers
   * seed their delta baseline (`snap`) from THIS — seeding from the live doc
   * at attach time would swallow every arrival between the extraction and the
   * attach forever (never projected, never re-emitted, and a later delta would
   * then record an arrival watermark that "covers" it).
   * With the extraction as the baseline, the first delta emits exactly the
   * gap. */
  objectsByShardUrl: Map<string, Record<string, ObjectInput>>
  connectionsByShardUrl: Map<string, Record<string, ConnectionInput>>
  /** The shard documents' heads AT EXTRACTION TIME (null when unknowable —
   * fake resolvers, unreadable docs). Attach compares them to the live heads:
   * equal heads mean no gap, so the seeded boot projection can be skipped
   * (the cold build's watermark already covers the shard) instead of burning
   * one no-op projection + generation per shard on every attach. */
  objectShardHeadsByUrl: Map<string, readonly string[] | null>
  connectionShardHeadsByUrl: Map<string, readonly string[] | null>
  /** Documents that resolved but could not be read. Empty means this extraction
   * saw everything it was pointed at — the only basis on which the read
   * model's own completeness can be claimed. See modelDefects.ts. */
  defects: ModelDefect[]
}

export { releaseUnavailableDocument }

/**
 * Resolve one Automerge document, retrying ONLY while automerge-repo actually
 * confirms the document is unavailable.
 *
 * Not every rejection means "not synced yet": a malformed URL, a deleted
 * document or a storage fault must not buy a retry budget and a cache eviction
 * they could never benefit from. So each outcome is classified: an unavailable
 * document is retried after clearing its terminal cache entry, a
 * permanently unresolvable reference fails fast as
 * `DocumentPermanentlyUnavailableError`, a cancellation propagates untouched,
 * and anything unexpected is logged structurally and re-thrown as-is instead of
 * being absorbed into a retry loop.
 */
export async function resolveHandleWithRetry(
  repo: Repo,
  url: string,
  options: {
    tries?: number
    delayMs?: number
    deadlineMs?: number
    sleep?: (ms: number) => Promise<void>
    signal?: AbortSignal
  } = {},
): Promise<DocHandle<unknown>> {
  const tries = Math.max(1, options.tries ?? 20)
  const delayMs = Math.max(0, options.delayMs ?? 1_000)
  const deadlineMs = Math.max(0, options.deadlineMs ?? documentResolveDeadlineMs())
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const signal = options.signal
  let lastError: unknown
  for (let attempt = 0; attempt < tries; attempt += 1) {
    signal?.throwIfAborted()
    const deadline = withDeadline(signal, deadlineMs)
    try {
      const handle = await deadline.guard(
        repo.find<unknown>(url as Parameters<Repo['find']>[0], { signal: deadline.signal }),
      )
      // NOT `await handle.whenReady()`. That method returns a FOREVER promise —
      // never a rejection — for any state but `ready`, so awaiting it blind
      // reintroduces exactly the hang the deadline above exists to remove.
      //
      // `DocHandle.state` is `deleted` or `ready` and nothing else in
      // automerge-repo 2.6.0-alpha.2 (`this.#document.deleted ? "deleted" :
      // "ready"`), so the only state reachable here is `deleted` — permanent,
      // and reporting it as *temporarily* unavailable would buy it the full
      // retry budget and end in a spurious degradation. Anything else is a
      // version whose state machine we do not know, which is not a licence to
      // retry either.
      if (handle.state !== 'ready') {
        throw new DocumentPermanentlyUnavailableError(url, {
          cause: new Error(`handle state is "${String(handle.state)}"`),
        })
      }
      return handle
    } catch (error) {
      lastError = error
      // A deadline abort is NOT a cancellation. The caller's own signal is still
      // live, so this is the ordinary "has not synced to us yet" case and the
      // document must reach the bounded retry queue — whereas `aborted` below
      // means the projector is going away and the document is dropped silently.
      if (deadline.expired() && !signal?.aborted) {
        console.warn(
          '[read-model] document resolution deadline exceeded',
          describeDocumentResolutionFailure(url, error, 'unavailable', attempt + 1),
        )
      } else {
        const outcome = classifyDocumentResolutionError(error, () => documentRepoState(repo, url))
        if (outcome === 'aborted') throw error
        if (outcome === 'invalid') {
          throw new DocumentPermanentlyUnavailableError(url, { cause: error })
        }
        if (outcome === 'unexpected') {
          console.error(
            '[read-model] unexpected document resolution failure',
            describeDocumentResolutionFailure(url, error, outcome, attempt + 1),
          )
          throw error
        }
      }
      // The release clears a terminal `unavailable` entry so the NEXT attempt
      // re-checks storage — and it detaches the document to do it. Both halves
      // are wrong for a document the sync gate refused: storage will never have
      // it while it is refused, and the detach deletes the synchronizer the
      // lift must traverse. See documentReleaseGuard.ts.
      if (mayReleaseDocument(url)) await releaseUnavailableDocument(repo, url)
      if (attempt < tries - 1) await sleep(delayMs)
    } finally {
      deadline.dispose()
    }
  }
  throw new DocumentTemporarilyUnavailableError(url, tries, { cause: lastError })
}

/** Merge the diagram registry (RegistryShard.diagrams across root.shardUrls). */
async function readDiagrams(
  rootDoc: RootLike,
  resolve: Resolve,
  defects: ModelDefect[],
): Promise<{ diagrams: DiagramInput[]; registryShardUrls: string[] }> {
  const registryShardUrls = rootDoc.shardUrls ?? []
  const shards = await resolveInBatches(registryShardUrls, resolve)
  const diagrams = shards.flatMap((shard, index) => Object.values(
    readEntityMap<DiagramInput>(shard, 'diagrams', 'registry-shard', registryShardUrls[index] ?? null, defects),
  ))
  return { diagrams, registryShardUrls }
}

/**
 * Read the whole model (objects/connections/groups + the diagram registry) from the
 * root doc, sharded (ModelMeta + shards) or monolithic (ModelDoc). Pure given a
 * `resolve` (url → doc), so it's unit-testable with a fake resolver.
 *
 * A document that resolves but carries nothing records a `ModelDefect` rather
 * than silently producing an empty result: an Automerge document with no data
 * chunk resolves happily (`repo.find` settles, the handle is `ready`, `doc()`
 * returns `{}`), and such documents do occur in real workspaces.
 *
 * Partial progress is deliberate: whatever could be read is still projected,
 * because refusing to project a whole workspace over one unopenable diagram
 * would be worse. The shortfall is reported instead of invisible.
 */
export async function extractModelEntities(rootDoc: RootLike | undefined, resolve: Resolve): Promise<ExtractedModel> {
  const defects: ModelDefect[] = []
  const empty = (): ExtractedModel => ({
    objects: [], connections: [], groups: [], diagrams: [],
    objectShardUrls: [], connectionShardUrls: [], registryShardUrls: [],
    objectsByShardUrl: new Map(), connectionsByShardUrl: new Map(),
    objectShardHeadsByUrl: new Map(), connectionShardHeadsByUrl: new Map(), defects,
  })
  if (!rootDoc) {
    defects.push({ kind: 'document-unreadable', source: 'root', url: null })
    return empty()
  }

  const { diagrams, registryShardUrls } = await readDiagrams(rootDoc, resolve, defects)

  if (rootDoc.modelMetaUrl) {
    const meta = (await resolve(rootDoc.modelMetaUrl)) as MetaLike | undefined
    if (!meta) {
      // This branch discards the ENTIRE model — every object, connection and
      // group — on a workspace that still reports a successful projection, so it
      // must record a defect.
      defects.push({ kind: 'document-unreadable', source: 'model-meta', url: rootDoc.modelMetaUrl })
      return { ...empty(), diagrams, registryShardUrls }
    }
    const objectShardUrls = meta.objectShardUrls ?? []
    const connectionShardUrls = meta.connectionShardUrls ?? []
    const objShards = await resolveCooperatively(objectShardUrls, resolve)
    const connShards = await resolveCooperatively(connectionShardUrls, resolve)
    // DEDUP by id, last shard wins. The client "edits" shard (appended LAST) holds
    // overlay copies of EDITED existing objects, so the same id appears in its
    // original shard AND the edits shard — flatMap would emit duplicates and the bulk
    // upsert ("ON CONFLICT … cannot affect row a second time") would crash. Object
    // .assign in shard order resolves the overlay to the edited (last) version.
    const objMap: Record<string, ObjectInput> = {}
    const objectsByShardUrl = new Map<string, Record<string, ObjectInput>>()
    const objectShardHeadsByUrl = new Map<string, readonly string[] | null>()
    objShards.forEach((shard, index) => {
      const perShard = readEntityMap<ObjectInput>(shard, 'objects', 'object-shard', objectShardUrls[index] ?? null, defects)
      if (objectShardUrls[index]) {
        objectsByShardUrl.set(objectShardUrls[index], perShard)
        objectShardHeadsByUrl.set(objectShardUrls[index], tryGetAutomergeHeads(shard))
      }
      Object.assign(objMap, perShard)
    })
    const connMap: Record<string, ConnectionInput> = {}
    const connectionsByShardUrl = new Map<string, Record<string, ConnectionInput>>()
    const connectionShardHeadsByUrl = new Map<string, readonly string[] | null>()
    connShards.forEach((shard, index) => {
      const perShard = readEntityMap<ConnectionInput>(shard, 'connections', 'connection-shard', connectionShardUrls[index] ?? null, defects)
      if (connectionShardUrls[index]) {
        connectionsByShardUrl.set(connectionShardUrls[index], perShard)
        connectionShardHeadsByUrl.set(connectionShardUrls[index], tryGetAutomergeHeads(shard))
      }
      Object.assign(connMap, perShard)
    })
    // Delete tombstones: a boot-from-server client deletes an object whose base shard it
    // can't load by recording the id here; exclude those ids from the read model (the
    // shard still contains them until the daily compaction removes them).
    for (const id of meta.deletedObjectIds ?? []) delete objMap[id]
    for (const id of meta.deletedConnectionIds ?? []) delete connMap[id]
    return {
      objects: Object.values(objMap),
      connections: Object.values(connMap),
      // Groups live on the ModelMeta itself. `splitModel` always writes the key
      // (`groups: model.groups`), and so does the server's `createEmptyRoot`, so
      // an absent one is a genuinely uninitialised document rather than a
      // workspace that happens to have no groups.
      groups: Object.values(readEntityMap<GroupInput>(meta, 'groups', 'model-meta', rootDoc.modelMetaUrl, defects)),
      diagrams,
      objectShardUrls,
      connectionShardUrls,
      registryShardUrls,
      objectsByShardUrl,
      connectionsByShardUrl,
      objectShardHeadsByUrl,
      connectionShardHeadsByUrl,
      defects,
    }
  }

  if (rootDoc.modelUrl) {
    const model = (await resolve(rootDoc.modelUrl)) as ModelLike | undefined
    const url = rootDoc.modelUrl
    return {
      objects: Object.values(readEntityMap<ObjectInput>(model, 'objects', 'model', url, defects)),
      connections: Object.values(readEntityMap<ConnectionInput>(model, 'connections', 'model', url, defects)),
      groups: Object.values(readEntityMap<GroupInput>(model, 'groups', 'model', url, defects)),
      diagrams,
      objectShardUrls: [],
      connectionShardUrls: [],
      registryShardUrls,
      objectsByShardUrl: new Map(),
      connectionsByShardUrl: new Map(),
      objectShardHeadsByUrl: new Map(),
      connectionShardHeadsByUrl: new Map(),
      defects,
    }
  }
  // Neither reference. `emptyRoot()` writes `modelUrl: ''` and a SEPARATE
  // `rootHandle.change()` fills it in — but `createEmptyRoot` does not return the
  // url until after `repo.flush()`, so no reader can observe the gap. A root that
  // reaches here has genuinely lost its model pointer.
  defects.push({ kind: 'root-no-model-reference', source: 'root', url: null })
  return { ...empty(), diagrams, registryShardUrls }
}

/**
 * The integrity facts a FULL extraction may seal.
 *
 * Only for `cold_build` and `monolith`, the two projections that write every
 * kind from an extraction that visited every document. Both are preceded by a
 * total rewrite of the workspace's rows (`coldBuildReadModel` deletes then
 * upserts), so the table ends up holding exactly these ids and the digest
 * describes it exactly.
 *
 * Objects, connections and groups come out of merge maps and are already unique.
 * DIAGRAMS ARE NOT: `readDiagrams` flatMaps across registry shards with no
 * dedup, so the same id appearing in two shards reaches here twice.
 * `bulkUpsert` only crashes on that WITHIN one 1000-row chunk; across chunks
 * PostgreSQL silently keeps one row, so on a >1000-diagram landscape the table
 * would hold one and the digest would count two — a permanent mismatch. Hence
 * `uniqueIds`.
 */
function uniqueIds(entities: ReadonlyArray<{ id: string }>): string[] {
  return [...new Set(entities.map((entity) => entity.id))]
}

export function fullExtractionIntegrity(model: ExtractedModel): ProjectionIntegrity {
  return {
    defects: model.defects,
    digests: {
      object: digestOfIds(uniqueIds(model.objects)),
      connection: digestOfIds(uniqueIds(model.connections)),
      group: digestOfIds(uniqueIds(model.groups)),
      diagram: digestOfIds(uniqueIds(model.diagrams)),
    },
  }
}

/** Resolve a workspace's org_id once (nullable — RBAC backfill may not cover a
 * brand-new workspace yet; see docScope.ts's scope registration). Never throws —
 * a lookup failure just leaves org_id null, which is a valid (if degraded) state
 * for the read model, not a projection-breaking error. */
async function resolveOrgId(db: Queryable, key: WorkspaceKey): Promise<string | null> {
  try {
    const { rows } = await db.query<{ org_id: string | null }>(
      `SELECT org_id FROM scopes WHERE kind = 'version' AND landscape_id = $1 AND version_id = $2 LIMIT 1`,
      [key.landscapeId, key.versionId]
    )
    return rows[0]?.org_id ?? null
  } catch (err) {
    console.warn('[read-model] org_id lookup failed for workspace', key, err)
    return null
  }
}

/**
 * The initial diagram probe of each workspace, while it is in flight.
 *
 * Because the probe is deferred, a workspace can be RESIDENT (core model committed, every shard watched, `/api/model/*` answering)
 * while its optional per-diagram flow projection is still running. Residency no
 * longer implies flows.
 *
 * Nothing in production waits on this — the whole point is that the core routes
 * do not. It exists so a caller that genuinely needs "fully warm" rather than
 * "core warm" can say so, and so tests can assert the settled state instead of
 * betting on a timer.
 */
const initialDiagramProbes = new Map<string, Promise<void>>()

/** Await the initial diagram probe for a workspace, if one is in flight. */
export async function awaitInitialDiagramProbe(key: WorkspaceKey): Promise<void> {
  await initialDiagramProbes.get(keyOf(key))
}

/** Start one workspace's live projector against an already migrated database.
 * The server prepares the schema under its startup migration lock; standalone
 * callers must prepare their own database before starting a projector. Cold
 * starts must not repeat the global DDL and queue cleanup in schema.ts.
 * Missing tables reject startup instead of being recreated implicitly.
 *
 * Returns a stop() that detaches listeners and retains projected rows.
 * Tests may inject a transaction-scoped client; residency is optional.
 */
export async function startReadModelProjector(
  repo: Repo,
  rootUrl: string,
  db: Queryable = pool,
  key: WorkspaceKey = DEFAULT_WORKSPACE_KEY,
  residency?: AutomergeResidencyLeases,
  /** Injectable so tests never bet on a fixed window, and so the re-attach poll
   * can be disabled in place without a rollback. 0 disables it. */
  residentSweepMs = residentSweepIntervalMs(),
  /** Wall-clock ceiling on one `repo.find()` attempt — see RESOLVE_DEADLINE_MS.
   * Injectable for the same reason as the sweep: a test that bets on the
   * production window either takes 10 s per document or proves nothing. */
  resolveDeadlineMs = documentResolveDeadlineMs(),
  /** Does this cell still serve this workspace? Supplied by `ProjectorFleet`
   * from its own `ownsWorkspace`. A cold build can outlive the ownership that
   * started it — `release()` only bumps a generation, it cannot cancel a build —
   * and a projector that has lost the workspace must not go on publishing
   * health for it. Defaults to yes for direct callers. */
  stillOwned: () => boolean = () => true,
  /** Fired at most once, when a pass aborts on a lost write fence. The fence
   * cannot come back for this instance — only a cold build claims it, and this
   * instance already ran its own — so without this hook a fence-lost resident
   * projector would sit attached and silently frozen forever.
   * The fleet wires it to a recycle: stop this projector and let the next
   * read's `ensure()` cold-build a claiming replacement. */
  onFenceLost?: () => void,
  /** Fired once with this projector's instance id, as soon as it is minted.
   *
   * The id is what `read_model_projection_state.projector_instance_id` carries,
   * and it is the ONLY way another subsystem can tell "the row was written by
   * the projector running right now" from "the row survived a previous
   * process". The promotion primitive's `projector-instance-mismatch`
   * precondition takes an `expectedProjectorInstanceId`; without this hook its
   * production caller could only pass `null`. The fleet records it per entry
   * and exposes it via `residentProjectorInstanceId`. */
  onAttached?: (projectorInstanceId: string) => void,
  /** `AM_ORDINARY_HEAD_ROTATION` as parsed at boot; OFF for direct callers.
   * The projector reads the current write heads' `A.stats` (`shadow` logs a
   * due head; `on` also rotates it, `ordinaryHeadRotator.ts`) — see
   * `ordinaryHeadRotation.ts`. */
  ordinaryHeadRotation: OrdinaryHeadRotationConfig = ORDINARY_HEAD_ROTATION_OFF,
): Promise<() => void> {
  const orgId = await resolveOrgId(db, key)
  const projectorInstanceId = randomUUID()
  onAttached?.(projectorInstanceId)
  const headRotation = new OrdinaryHeadRotationObserver(ordinaryHeadRotation, key)
  // The fence value this build must find unchanged when it claims (a CAS, not
  // a blind overwrite): between this read and the claim, any
  // OTHER cold build that commits changes the fence and this build's claim
  // matches zero rows, rolling the whole build back. This is what closes the
  // cross-cell theft `stillOwned` cannot see (a stale lease copy reporting
  // true) and the two-processes-one-database misconfiguration where ownership
  // is disabled and `stillOwned` is vacuously true on both sides.
  const fenceObservedAtStart = await readWriteFence(db, key)

  // Torn-down flag, declared HERE (above runTracked) because the cold build
  // calls runTracked before the function body reaches the retry-queue section
  // — a `let` read before its initializer is a TDZ ReferenceError. Full
  // rationale on the comment block down at that section.
  let stopped = false

  // Health persistence must never become a second failure mode for the
  // projector. A telemetry write can degrade independently while the actual
  // projection still runs; projection errors are nevertheless re-thrown after
  // a best-effort failure marker so existing logging/retry behavior is kept.
  let projectionTail: Promise<void> = Promise.resolve()
  // The projection mutex — rationale (a `//` block: it documents no
  // declaration).
  //
  // The workspace's projection mutex and this projector's PLANE check both
  // live in `withReadModelProjectionTransaction`, which opens every projection
  // transaction with them; `StaticDeltaProjector` uses the same helper, so the
  // `ro_*` plane has one protocol for both writers.
  //
  // What the mutex buys is the closure the fence alone cannot give (measured
  // live): under READ COMMITTED a takeover cold build's
  // blanket DELETE keeps its statement snapshot while BLOCKED on a straggler's
  // row locks, so a pure INSERT the straggler commits mid-build survives the
  // rebuild as a permanent phantom — certified by the cold build's own
  // watermark. With the mutex, whole projection transactions serialize per
  // workspace: the straggler either commits before the cold build's first
  // statement (and is fully rewritten) or waits and dies on its fence assert.
  // It also removes the claim-vs-change-feed-prune lock inversion, which can
  // deadlock (40P01): two fenced transactions never overlap at all.
  // Health writes and `beginReadModelProjection` run on the pool and never take
  // it — which is exactly why the plane pre-check below exists.
  /** Latch + hook for a lost fence. One projector fires it at most once: the
   * fence cannot come back for this instance (only a cold build claims, and
   * this instance already ran its own), so every later pass would abort too —
   * the fleet's recycle is the recovery, not a retry. Suppressed until the
   * boot returns: a cold build's own fence abort already fails the start and
   * the fleet accounts for it there; firing the recycle too would schedule a
   * generation bump that could invalidate the RETRY build mid-flight. */
  let bootComplete = false
  let fenceLostReported = false
  const reportFenceLost = (kind: ProjectionKind, error: unknown) => {
    // `unknown` rather than a union of the two authority errors: the union
    // would have to be widened by hand every time a third one appears, which
    // is the drift `isReadModelAuthorityLoss` exists to remove. Nothing here
    // reads anything but the message.
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[read-model] ${kind} projection rolled back: ${message}`)
    if (fenceLostReported || !bootComplete) return
    fenceLostReported = true
    try { onFenceLost?.() } catch (hookError) {
      console.error('[read-model] onFenceLost hook failed', hookError)
    }
  }
  const runTracked = <T>(
    kind: ProjectionKind,
    action: (tx: Queryable) => Promise<T>,
    /** A function when the ids are only known once the action has written —
     * it receives the action's result, inside the same transaction. */
    change: ReadModelChangePayload | ((result: T) => ReadModelChangePayload) = { kind: 'reset', scope: 'all' },
    /** What this projection knows about its own completeness and
     * about the id set it just wrote. Sealed in the SAME transaction as the rows,
     * which is the entire reason it can be trusted later. */
    integrity?: ProjectionIntegrity,
  ): Promise<T> => {
    const task = projectionTail.then(async () => {
      // Deliberately NOT aborted on `stopped`/`!stillOwned()`: an in-flight
      // projection may complete — its HEALTH writes are individually guarded,
      // and `stillOwned` is process-local and flickery (the renew cadence flips
      // it with no ownership-loss event), so it must never be a hard abort.
      // What IS a hard abort is the write fence: DB-level truth, asserted
      // inside the transaction — a disowned pass committing its ro_* rows
      // AFTER the takeover's cold build rolls back rows, watermark, change
      // feed and integrity stamp together instead of leaving stale rows under
      // a watermark the takeover recorded.
      //
      let token: Awaited<ReturnType<typeof beginReadModelProjection>> | null = null
      try {
        // The pre-check below is NOT the fence — the in-transaction assert
        // is. It exists because `beginReadModelProjection` runs on the pool,
        // outside the transaction, and a disowned pass's begin bumps the new
        // owner's `observed_generation` — which walks its status to
        // `catching_up`, refuses `absenceProvable` and blocks compaction
        // until the owner's next pass. Reading the fence first keeps a
        // known-dead pass from touching the row at all; the raced case (fence
        // taken between this read and the commit) still bumps once and is
        // repaired by the recycle. The cold build is exempt: claiming the
        // fence is its job. INSIDE the try, so the fence-lost latch below sees
        // this throw too and the recycle fires.
        if (kind !== 'cold_build') {
          const held = await readWriteFence(db, key)
          if (held !== projectorInstanceId) {
            throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
          }
        }
        // The PLANE pre-check, for the same reason and with the same standing:
        // not the gate (the in-transaction assert under the mutex is), but
        // `beginReadModelProjection` runs on the pool and its
        // `observed_generation` bump cannot be rolled back. Without this, a
        // projector still attached to a workspace that was promoted underneath
        // it bumps the STATIC projector's generation once per pass and walks a
        // healthy workspace to `catching_up` — refusing `absenceProvable` and
        // blocking compaction — while every one of those passes was going to
        // roll back anyway. The cold build is NOT exempt here (unlike the
        // fence, where claiming is its job): a cold build on a promoted
        // workspace is the fleet attaching to a plane it does not own.
        if (await isStaticReadModelWorkspace(db, key)) {
          throw new ReadModelPlaneError(key, 'ordinary')
        }
        token = await beginReadModelProjection(db, key, orgId, kind).catch((error) => {
          console.error('[read-model] failed to begin projection health span', error)
          return null
        })
        if (!token) {
          // The health span failed to begin, not the projection — but the rows
          // still must not land unfenced or un-atomically. Same transaction
          // shape as the tracked path, minus the bookkeeping it cannot have.
          return await withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
            const result = await action(tx)
            await assertReadModelWriteFence(tx, key, projectorInstanceId)
            return result
          })
        }
        const activeToken = token
        return await withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
          const result = await action(tx)
          await appendReadModelChange(tx, key, activeToken, typeof change === 'function' ? change(result) : change)
          // BEFORE completeReadModelProjection, deliberately: the row must still
          // carry the generation this projection supersedes, because that is what
          // `unchanged` is measured against. Inside the same transaction, so the
          // seal can never disagree with the rows it describes.
          //
          // Wrapped in a SAVEPOINT so that integrity BOOKKEEPING can never roll
          // back the PROJECTION. Without it, a schema drift or a rejected CHECK
          // on `defect_summary` would abort a whole cold build — observability
          // taking down correctness, which is the wrong way round.
          if (hasIntegrityToStamp(integrity)) {
            await tx.query('SAVEPOINT read_model_integrity')
            try {
              const stamped = await stampProjectionIntegrity(tx, key, activeToken.generation, integrity!)
              if (!stamped) {
                console.debug(
                  `[read-model] integrity stamp skipped for ${key.landscapeId}/${key.versionId} at generation ` +
                    `${activeToken.generation}: a newer projection already committed`)
              }
            } catch (error) {
              await tx.query('ROLLBACK TO SAVEPOINT read_model_integrity')
              console.error('[read-model] integrity stamp failed; projection kept', error)
            }
            await tx.query('RELEASE SAVEPOINT read_model_integrity')
          }
          // The row-write fence, immediately before completion. The projection
          // mutex above already serializes fenced transactions per workspace,
          // so by the time this runs, any adverse claim has either committed
          // (the assert sees it and this pass dies whole) or has not started
          // (this pass commits first and the cold build behind the mutex
          // rewrites everything it wrote).
          await assertReadModelWriteFence(tx, key, projectorInstanceId)
          await completeReadModelProjection(tx, key, activeToken)
          return result
        })
      } catch (error) {
        if (isReadModelAuthorityLoss(error)) {
          // NOT failReadModelProjection: the state row now belongs to somebody
          // else — the instance that took the fence, or the static projector
          // that now owns the plane — and a disowned pass writing failure
          // telemetry (consecutive_failures, last_error_*) onto it is the same
          // forgery as writing rows. It can walk that owner's health ladder to
          // `failed` from outside. Loud, latched, reported to the fleet (which
          // recycles this projector so the next read re-ensures), and rethrown.
          //
          // ONE branch for both, not two identical ones. The fence and the
          // plane share every property that matters here: neither can be
          // undone by a retry (only by a takeover or a demotion), so the latch
          // is correct for both, and for both the recycle IS the recovery —
          // for a plane loss the fleet's next `ensure()` refuses with
          // `ProjectorStaticWorkspaceError`, which is the right end state
          // rather than an error to report.
          reportFenceLost(kind, error)
          throw error
        }
        if (isProjectionMutexTimeout(error)) {
          // Another writer holds the mutex. NOT persisted, for the same reason
          // as above — the row belongs to whoever is writing right now — but
          // NOT latched either, because this one clears when they commit. The
          // next pass simply tries again.
          console.warn(
            `[read-model] ${kind} projection yielded the mutex for `
            + `${key.landscapeId}/${key.versionId}: another writer holds it`,
          )
          throw error
        }
        if (token) {
          await failReadModelProjection(db, key, token, error)
            .catch((healthError) => console.error('[read-model] failed to persist projection failure', healthError))
        }
        throw error
      }
    })
    // All source listeners for one workspace publish in generation order. A
    // failed item does not poison the queue; its snapshot remains retryable.
    projectionTail = task.then(() => undefined, () => undefined)
    return task
  }

  const coalescedProjection = (label: string, project: () => Promise<void>) => {
    let running = false
    let pending = false
    let disposed = false
    /** The run in flight, so `idle()` can wait for it. */
    let active: Promise<void> = Promise.resolve()
    const kick = () => {
      if (running || disposed) { pending = !disposed; return }
      active = run()
    }
    const run = async () => {
      running = true
      try {
        do {
          pending = false
          await project()
        } while (pending && !disposed)
      } catch (error) {
        console.error(`[read-model] ${label} failed`, error)
      } finally {
        running = false
        if (pending && !disposed) kick()
      }
    }
    return {
      trigger: () => { if (!disposed) kick() },
      dispose: () => { disposed = true; pending = false },
      /** Resolves once no run is in flight. After `dispose()` nothing starts
       * another, so dispose-then-idle is "this watcher has finished". */
      idle: async () => {
        let seen: Promise<void>
        do { seen = active; await seen } while (seen !== active)
      },
    }
  }

  const residencyOwner = `projector:${projectorInstanceId}`
  const leasedDocumentIds = new Set<string>()
  /** False until the attach returns: the cold build's loads are its own
   * work, counted under `phase: 'attach'` and summed in one line at its end. */
  let attachDone = false
  const attachLoads = { loads: 0, ms: 0 }
  /**
   * A NON-RESIDENT load (G4-16, M3, `documentLoadTelemetry.ts`): the document
   * was not in the Repo's cache, so `repo.find` read every chunk from storage
   * and `Automerge.load`ed it in ONE synchronous wasm call — 30–70 ms for a
   * fleet-shaped retired head, on the owner cell's event loop. Counted by
   * the path that asked; after the attach, one taking at least
   * `DOCUMENT_LOAD_LOG_MS` is logged with its document, so a stall in the
   * profile (whose stack ends at `StorageSubsystem.loadDoc`, the caller being
   * behind an await) can be traced to it. `ms` is the wall time of the
   * resolution (the storage read included), an upper bound on the
   * synchronous load. Cheap: one map lookup per resolution.
   */
  const noteDocumentLoad = (caller: DocumentLoadCaller, documentId: string, startedAt: number): void => {
    const ms = Math.round((performance.now() - startedAt) * 10) / 10
    countDocumentLoad(attachDone ? 'steady' : 'attach', caller)
    if (!attachDone) {
      attachLoads.loads += 1
      attachLoads.ms += ms
      return
    }
    if (ms < DOCUMENT_LOAD_LOG_MS) return
    console.warn(JSON.stringify({
      event: 'read_model.document_loaded',
      workspace: `${key.landscapeId}/${key.versionId}`,
      caller,
      documentId,
      ms,
    }))
  }
  const residentNow = (url: string): boolean => {
    const documentId = isValidAutomergeUrl(url) ? parseAutomergeUrl(url).documentId : null
    return !documentId || Boolean(syncedHandle(repo, documentId))
  }
  const resolveHandle = async (url: string, caller: DocumentLoadCaller = 'other'): Promise<DocHandle<unknown>> => {
    const resident = residentNow(url)
    const startedAt = performance.now()
    const handle = await resolveHandleWithRetry(repo, url, {
      deadlineMs: resolveDeadlineMs,
      // THREE, not the default twenty. The twenty was sized for attempts that
      // failed in milliseconds, where the patience actually came from the 1 s
      // delay between them — about 20 s in total. Each attempt now WAITS the
      // full deadline, so the same twenty would spend 20 x (10 s + 1 s) = 220 s
      // holding one of only two cold-build admission slots for a workspace whose
      // root or meta document is simply not there, starving every other
      // workspace behind it. Three attempts is ~33 s: more real patience than
      // the original, an order of magnitude less starvation.
      tries: CONTROL_DOCUMENT_TRIES,
    })
    if (!resident) noteDocumentLoad(caller, handle.documentId, startedAt)
    if (residency && !leasedDocumentIds.has(handle.documentId)) {
      leasedDocumentIds.add(handle.documentId)
      residency.acquire(handle, residencyOwner, `${key.landscapeId}/${key.versionId}`)
    }
    return handle
  }
  /** Retired heads this projector PARKED (fold off, see `parkRetiredHead`):
   * listed, not watched, not leased. url -> what the arrival poll needs. */
  const parkedRetiredHeads = new Map<string, {
    kind: 'object' | 'connection'
    documentId: string
    /** Highest content arrival already covered, as text (a BIGINT), or null. */
    watermark: string | null
    /** What the head serves, as plain JS: its entity map only (`objects` or
     * `connections`), copied from the live document at park time and again
     * every time the poll loads it. `resolve` answers from this. JS heap, and
     * NOT bounded: with the fold off, one per rotation for the projector's
     * life (O(rotations)), as is the per-head lookup every arrival poll runs
     * (`documentContentArrivals`). Only the fold, which unlists, bounds them. */
    snapshot: Record<string, unknown>
  }>()
  /** The plain copy a parked head is read from. A document without the map
   * gives `{}`, so a reader records the same defect the live one would. */
  const parkedSnapshotOf = (kind: 'object' | 'connection', doc: unknown): Record<string, unknown> => {
    const field = kind === 'object' ? 'objects' : 'connections'
    const value = (doc as Record<string, unknown> | undefined)?.[field]
    return value === undefined ? {} : { [field]: JSON.parse(JSON.stringify(value)) as unknown }
  }
  // A parked head is read (a full extraction on every registry edit,
  // `servedOutsideCurrentHead` on every forward) from its plain snapshot, NOT
  // from the document: loading it would bring every evicted parked head back
  // into memory, one storage read each, on the owner cell's event loop, and
  // keep it there until the idle sweep — the residency parking exists to
  // give back. The snapshot lags the document only by a late write the poll
  // has not loaded yet (one poll period). Its readers use the entity map
  // alone: the extraction's per-shard heads are null for it, and the only
  // extraction that runs once a head can be parked (`registryProjectLatest`)
  // keeps the diagrams and the defects, not the heads. The cold build, which
  // does use them, runs before anything is parked.
  const resolve: Resolve = async (url) => {
    const parked = parkedRetiredHeads.get(url)
    if (parked) return parked.snapshot
    return (await resolveHandle(url, 'extract')).doc()
  }
  // Prepare the durable witness before taking projection locks. A drain can
  // wait for active saves; it must neither write an older snapshot nor retain
  // a projection transaction while waiting. Recheck runtime identity at stamp.
  const prepareShardWatermarks = (documentIds: readonly DocumentId[]) => {
    const storage = repo.storageSubsystem
    return prepareDocumentWatermarkProofs(db, storage
      ? [...new Set(documentIds)].map(documentId => ({ documentId,
        drainPendingSaves: () => storage.drainDocumentSaves(documentId) }))
      : [])
  }

  // A shard a client CREATED mid-session may not have synced to us yet when we
  // see its url appended to the meta doc — repo.find then throws "unavailable".
  // Retry until it syncs (the client is pushing it), so the new shard's contents
  // reach the read model.
  //
  // NOT `resolveHandle`. `CONTROL_DOCUMENT_TRIES` is three to stop a doomed BOOT
  // from holding an admission slot for minutes, and that reasoning does not
  // transfer here: this call is not on the boot path,
  // and a shard that misses its window is recorded in `degradedShards`, which —
  // unlike a diagram document — has NO retry queue behind it and is re-attempted
  // only on the next meta or root change. A workspace that appends one shard and
  // then goes quiet would be left degraded with nothing scheduled. Waiting is the
  // whole point of this call, so it keeps a budget sized for waiting.
  const resolveHandleRetry = async (url: string, caller: DocumentLoadCaller = 'attach'): Promise<DocHandle<unknown>> => {
    const resident = residentNow(url)
    const startedAt = performance.now()
    const handle = await resolveHandleWithRetry(repo, url, {
      deadlineMs: resolveDeadlineMs,
      tries: SHARD_ARRIVAL_TRIES,
    })
    if (!resident) noteDocumentLoad(caller, handle.documentId, startedAt)
    if (residency && !leasedDocumentIds.has(handle.documentId)) {
      leasedDocumentIds.add(handle.documentId)
      residency.acquire(handle, residencyOwner, `${key.landscapeId}/${key.versionId}`)
    }
    return handle
  }

  // Cold watermarks are earned from the actual durable heads after flushing.
  // A capture before extraction alone is not a safe lower bound: an older
  // handle's write can mint its sequence before extraction but commit after it.
  // Everything from the first `resolveHandle` on acquires residency leases
  // under this build's owner id, and the stop() closure is only built AFTER the
  // cold build — so any throw in this region (a fence abort is a DESIGNED one,
  // firing on every ownership flap) must release the owner here, or every
  // lease would leak for the process lifetime: root, meta and all shards
  // permanently unevictable. Declared with `!`: every branch of the catch
  // throws, so the post-try code only runs when all four were assigned.
  let rootHandle!: DocHandle<unknown>
  let rootDoc!: RootLike
  let metaHandle!: DocHandle<unknown> | null
  let model!: Awaited<ReturnType<typeof extractModelEntities>>
  // A delta writes only one collection/baseline. It cannot certify a document
  // that was sampled through several references. Retain that refusal until a
  // new cold build: removing a duplicate URL does not remove phantom rows left
  // by its earlier fold, nor repair a watcher's last-occurrence snapshot.
  const ambiguousShardDocuments = new Set<string>()
  /** Retired write heads whose late writes are FORWARDED into the current head
   * rather than projected (`ordinaryHeadForwarding.ts`), by `retirementKey`.
   * A routing hint only — the forwarder re-reads its row. Loaded at attach and
   * again when a write-head pointer moves, never per change: the rotator must
   * commit the `retired` row WITH H_r BEFORE it repoints ModelMeta (the
   * contract in `ordinaryHeadForwarding.ts`), so reading the pointer first and
   * the rows second cannot miss the row for that pointer. A row changed
   * WITHOUT a pointer move (`admitted` promoted later) is not seen until the
   * next move or re-attach. */
  let retirements = new Map<string, OrdinaryHeadRetirement>()
  let retirementsPointer: string | null = null
  const writeHeadPointer = (meta: MetaLike | undefined): string =>
    `${meta?.editsObjectShardUrl ?? ''}|${meta?.editsConnectionShardUrl ?? ''}`
  const rememberShardReferences = (objectUrls: readonly string[], connectionUrls: readonly string[]) => {
    const counts = new Map<string, number>()
    for (const url of [...objectUrls, ...connectionUrls]) {
      const id = documentIdOf(url)
      const count = (counts.get(id) ?? 0) + 1
      counts.set(id, count)
      if (count > 1) ambiguousShardDocuments.add(id)
    }
    return counts
  }
  try {
    rootHandle = await resolveHandle(rootUrl)
    rootDoc = rootHandle.doc() as RootLike
    metaHandle = rootDoc.modelMetaUrl
      ? await resolveHandle(rootDoc.modelMetaUrl)
      : null
    // This map belongs only to the cold extraction, never to the long-lived
    // resolver used by later callbacks. Keep the exact handles sampled.
    const extractionHandles = new Map<string, DocHandle<unknown>>()
    model = await extractModelEntities(rootDoc, async (url) => {
      const handle = await resolveHandle(url)
      extractionHandles.set(url, handle)
      return handle.doc()
    })
    rememberShardReferences(model.objectShardUrls, model.connectionShardUrls)
    // ONLY the object/connection shard documents are stamped — and only the
    // ones whose read did not defect. (1) A stamped document with NO
    // re-stamping delta path (root, meta, registry shards, monolith — their
    // handlers record nothing) would enter the EXACT branch and any later write
    // to it would refuse the proof PERMANENTLY; unstamped, they stay on the
    // self-healing timestamp fallback. (2) A shard that resolved but could not
    // be READ projected nothing, so stamping it would claim coverage for
    // content that is not in ro_*.
    const documentIdOfUrl = (url: string) => url.replace(/^automerge:/, '').split('?')[0]
    const defectedIds = new Set(model.defects.flatMap((defect) => defect.url ? [documentIdOfUrl(defect.url)] : []))
    const sampledReferences = (urls: string[], headsByUrl: Map<string, readonly string[] | null>) => {
      const occurrences = new Map<string, number>()
      for (const url of urls) occurrences.set(url, (occurrences.get(url) ?? 0) + 1)
      return urls.map(url => ({ url,
        // This map retains only the last sample of an exact URL. It cannot
        // vouch for an earlier occurrence read at a different revision.
        sampledHeads: occurrences.get(url) === 1 ? headsByUrl.get(url) ?? null : null,
      }))
    }
    const sampledShards = [
      ...sampledReferences(model.objectShardUrls, model.objectShardHeadsByUrl),
      ...sampledReferences(model.connectionShardUrls, model.connectionShardHeadsByUrl),
    ].filter(({ url }) => !defectedIds.has(documentIdOfUrl(url))).map(sample => {
      const documentId = documentIdOfUrl(sample.url) as DocumentId
      const handle = extractionHandles.get(sample.url)
      const currentHandle = () => {
        const state = repo.synchronizer.docSynchronizers[documentId]?.query.peek()
        if (!handle || state?.state !== 'ready' || state.handle !== handle) {
          throw new Error(`cold-build document handle changed: ${documentId}`)
        }
        return handle
      }
      return { documentId, sampledHeads: sample.sampledHeads, currentHandle,
        readCurrentHeads: () => tryGetAutomergeHeads(currentHandle().doc()) }
    })
    for (const sample of sampledShards) sample.currentHandle()
    await repo.flush([...new Set(sampledShards.map(sample => sample.documentId))])
    const preparedWatermarks = await prepareShardWatermarks(sampledShards.map(sample => sample.documentId))
    for (const sample of sampledShards) sample.currentHandle()
    await runTracked('cold_build', async (tx) => {
      await coldBuildReadModel(tx, key, orgId, model.objects, model.connections, model.groups, model.diagrams)
      // Atomic with the rows they describe, and unconditional: if this
      // build is disowned, its claim below is skipped or its CAS misses, the
      // assert fails and the WHOLE transaction — these watermarks included —
      // rolls back. A separate ownership guard here could only drop a stamp the
      // fence already proves legitimate.
      await recordSampledDocumentWatermarks(tx, key, sampledShards, preparedWatermarks)
      // Claim the row-write fence atomically with the rows it will guard,
      // at the END of the action so the state-row lock is taken after the ro_*
      // locks. Two layers, each covering what the other cannot:
      //
      //  - the `stillOwned` fast-fail: a cold build the fleet has already
      //    released skips the claim, fails its own assert, and rolls back —
      //    instead of completing and being torn down after the fact;
      //  - the CAS (`fenceObservedAtStart`): claims only if no OTHER build
      //    claimed since this one began. `stillOwned` is process-local and can
      //    read true on a stale lease copy (or vacuously, with ownership
      //    disabled — the two-worktrees-one-database hazard); the CAS is
      //    DB-truth, so a released build that would otherwise commit LAST and
      //    steal the fence from the live takeover — wedging the workspace —
      //    misses zero rows and dies whole.
      if (!stopped && stillOwned()) {
        await claimReadModelWriteFence(tx, key, orgId, projectorInstanceId, fenceObservedAtStart)
      }
    }, { kind: 'reset', scope: 'all' }, fullExtractionIntegrity(model))
    // Inside the try, so a failed read releases the leases like every other
    // boot failure. A failure is NOT read as "no retirements": that would
    // project a retired head directly and hide its forwarded edits.
    const pointer = writeHeadPointer(metaHandle?.doc() as MetaLike | undefined)
    retirements = await loadOrdinaryHeadRetirements(db, key)
    retirementsPointer = pointer
  } catch (error) {
    if (residency) residency.releaseOwner(residencyOwner)
    throw error
  }
  console.log(
    `[read-model] cold build (${key.landscapeId}/${key.versionId}): ${model.objects.length} objects, ` +
      `${model.connections.length} connections, ${model.groups.length} groups, ${model.diagrams.length} diagrams ` +
      `across ${model.objectShardUrls.length}+${model.connectionShardUrls.length} model shards`
  )
  // A cold build is the one moment the whole read model is written from scratch,
  // so it is also the moment an unreadable document does the most damage: every
  // id it held is simply absent, and every later delta projection is relative to
  // that hole. Logged at WARN with the urls so the report is actionable without
  // a database query.
  if (model.defects.length > 0) {
    console.warn(
      `[read-model] cold build (${key.landscapeId}/${key.versionId}) could not read ` +
        `${model.defects.length} document(s): ${summarizeModelDefects(model.defects)}`
    )
  }

  const cleanups: Array<() => void> = []
  /** Widened from a bare disposer: the resident sweep needs the handle to tell
   * whether this watcher is still attached to the repo's CURRENT handle for that
   * document, and the diagram to re-attach with. */
  const diagramWatchers = new Map<string, { handle: DocHandle<unknown>; diagram: DiagramInput; stop: () => void }>()
  /** documentId -> url, populated at RESOLVE time rather than at watcher
   * registration. `attachDiagramDoc`'s retry closure retains a handle for a url
   * that may never reach a watcher, and the eviction hook has only a documentId
   * to go on. */
  const diagramUrlByDocumentId = new Map<string, string>()
  /** The diagram a url was last attached with, so the resident sweep can
   * re-attach without re-reading the registry. */
  const lastKnownDiagram = new Map<string, DiagramInput>()
  const diagramWatchInFlight = new Set<string>()
  const diagramWarned = new Set<string>()
  /** Sources this workspace knows it failed to project. Non-empty means the
   * read model is knowingly incomplete, so it must not report itself healthy. */
  const degradedDocuments = new Set<string>()
  const degradedShards = new Set<string>()
  let degradationPublished: DegradationKind | null = null
  /** Whether the ROW currently says healthy because THIS projector said so.
   * False on a fresh start even though nothing has been published, because the
   * row may carry a previous process's degradation — see
   * `publishHealthIfNothingOutstanding`. */
  let healthPublished = false
  /** Non-zero means a pass is in flight and "nothing outstanding" cannot yet be
   * read as a statement about the workspace — see `reconcileDiagramDocs`. Read
   * through `reconcilingGuard`, which owns the depth. */
  /**
   * Run an awaiting pass with the health guard raised.
   *
   * There is ONE implementation on purpose: every pass that awaits for a long
   * time must raise the guard. A shard appended to ModelMeta or to the root is
   * resolved by polling for its ARRIVAL, and `degradedShards` stays empty for
   * the whole poll, so an unguarded pass would let the 1 s health beat publish
   * "nothing outstanding" in the middle of a pass that had not read a byte.
   *
   * The two windows are NOT the same size. `resolveHandleWithRetry` sleeps
   * `if (attempt < tries - 1)`, so N attempts cost N deadlines and N MINUS ONE
   * delays:
   *   - meta path — `watchObjectShard`/`watchConnectionShard` with
   *     `applyInitial` go through `resolveHandleRetry`, `SHARD_ARRIVAL_TRIES`
   *     = 20, so 20 x 10 000 + 19 x 1 000 = **219 s**;
   *   - root path — `watchRegistryShard` goes through `resolveHandle`,
   *     `CONTROL_DOCUMENT_TRIES` = 3, so 3 x 10 000 + 2 x 1 000 = **32 s**.
   * Half a minute is still 32 health beats spent asserting a pass had finished,
   * which is why both are guarded.
   *
   * Written as a wrapper rather than as hand-placed `try/finally` pairs so
   * there is no per-site line to forget.
   *
   * It deliberately does NOT publish afterwards. Each caller decides, because
   * they mean different things — `reconcileDiagramDocs` has examined every
   * document and publishes, and `rootProjectLatest` has watched a shard whose
   * diagrams have NOT been examined and must not.
   */
  const reconcilingGuard = createReconcilingGuard()
  const withReconciling = reconcilingGuard.run
  /** A degradation decided while this cell did not own the workspace. Held so a
   * transient ownership blip cannot silently swallow it — see
   * `publishDegradation`. First one wins: the row records the incident, not
   * every document in it. */
  let pendingDegradation: { kind: DegradationKind; error: unknown } | null = null
  /**
   * Hoisted above the health publish deliberately, not just for the closure at
   * the bottom of this function.
   *
   * `stop()` clears `degradedDocuments`, clears `degradedShards` and stops the
   * retry queue — it removes every piece of state the publish consults. So an
   * async pass that was in flight when the projector was torn down resumes into
   * a world where nothing is outstanding and publishes a clear for a workspace it
   * no longer serves. `stillOwned` does not cover it: LRU eviction calls `stop()`
   * without bumping the fleet's generation, so the predicate is still true.
   *
   * (Declared further UP, above `runTracked` — the cold build calls `runTracked` before this point in the function body,
   * and a `let` read before its initializer is a TDZ ReferenceError.)
   */

  // ONE bounded scheduler per workspace replaces one timer + one retry loop per
  // missing document: dedup by url, at most `maxConcurrent` resolutions in
  // flight, a hard pending cap, a single wake timer, jittered exponential
  // backoff and a per-document wall-clock deadline.
  const documentRetries = new DocumentRetryQueue({}, {
    onAbandon: (docUrl, reason, error) => onDiagramRetryAbandoned(docUrl, reason, error),
    // The last document leaving the queue is the moment this workspace can first
    // be described as complete. Without it the health report waits for the next
    // registry change, which on a quiet workspace never comes.
    onIdle: () => publishHealthIfNothingOutstanding(),
  })
  const unregisterDocumentRetries = documentRetryRegistry.register(documentRetries)

  /**
   * ONE health write at a time, in the order they were decided.
   *
   * `db` is a `pg.Pool`. Two statements issued microseconds apart on different
   * connections can land in either order, so a fire-and-forget MARK and a
   * fire-and-forget CLEAR could commit backwards — and the loser is permanent,
   * because in-process `degradationPublished` and `healthPublished` both believe
   * the row already says what they last decided and neither will write again.
   * Chaining them onto a tail makes the row's final value match the last
   * decision, which is the only ordering this projector can promise.
   *
   * Deliberately its OWN tail, not `projectionTail`: health writes must not wait
   * behind a slow cold build, and a projection failure must not stall the
   * degradation that describes it.
   *
   * What this does NOT serialize is two projectors for the same workspace
   * (a fleet restart, a cross-replica handover).
   *
   * THE COST: one stalled write blocks every later
   * one for this projector's life, and the queue is uncapped. A flapping
   * document driven by the 1 s resident sweep can pile up a mark/clear pair per
   * tick behind a stuck head. That is the trade — a row that is briefly stale in
   * the direction the last decision intended, instead of one that is permanently
   * wrong in a direction nobody chose.
   */
  let healthTail: Promise<void> = Promise.resolve()
  const queueHealthWrite = (
    label: string,
    write: () => Promise<void>,
    /** Undo the in-memory bookkeeping the DECISION latched, so the next beat
     * decides again. Without it a refusal here is indistinguishable from a
     * successful write to everything upstream. */
    rollback: () => void,
  ): void => {
    healthTail = healthTail
      .then(() => {
        // Re-checked HERE, not only where the write was decided. Serializing
        // made the gap between decision and statement longer, not shorter: a
        // write can now sit behind the queue while the projector is evicted and
        // a replacement cold-builds the same workspace clean. The late write
        // then lands on the replacement's row — and the replacement will not
        // correct it, because its `degradationPublished`/`healthPublished`
        // already say what it last decided — a permanently stale row, in either
        // direction, on a row whose clear is deliberately unconditional.
        //
        // But a refusal must ROLL BACK, not merely skip. The caller latched
        // `degradationPublished`/`healthPublished` when it decided, so a silent
        // skip leaves this projector believing the row says something it does
        // not — and every later call short-circuits on those very flags. That is
        // the same permanent-stale row one layer further in, and it is reachable
        // without any teardown at all: `ownsWorkspace` reports false whenever
        // Redis is not `ready`, and a reconnect inside the renew cadence flips
        // it back with no ownership-loss event. With the rollback, the health
        // beat re-decides and re-issues.
        if (stopped || !stillOwned()) {
          rollback()
          return undefined
        }
        return write()
      })
      .catch((error) => {
        // A REJECTION rolls back for the same reason a refusal does, and it is
        // the half that is reachable without anything going wrong upstream: a
        // pool exhaustion, a reset connection, a statement timeout. The caller
        // latched `degradationPublished`/`healthPublished` when it DECIDED, so
        // logging alone leaves this projector believing the row says something
        // it does not, and every later call short-circuits on those very flags.
        // Without this rollback the beat would issue the statement exactly ONCE
        // and never again (pinned by `projectorService.test.ts`'s two "the
        // database REJECTED" cases), in both the mark and the clear direction —
        // a degradation no restart can lift, from one transient error.
        //
        // Re-issuing a write that COMMITTED and lost its ack is the price, and
        // it is affordable for the RETRY, which re-sends the same statement:
        // `degraded_since` is `COALESCE`d so a repeat cannot move an existing
        // incident's timestamp, and the clear is a plain assignment to NULL.
        // Not idempotent in general, and the distinction is worth keeping —
        // `degraded_kind` and `degraded_error_code` are `= EXCLUDED.*`
        // (`health.ts`), so a mark of a DIFFERENT kind does overwrite the
        // operator's "which subsystem" answer while `degraded_since` holds.
        //
        // No backoff, and the bound is the TAIL, not this rollback and not the
        // beat. Every write is chained on the previous one, so exactly one is
        // executing at a time and the sustained rate can never exceed
        // 1 / write-latency however many callers are asking. That is the
        // property that makes this safe under the first failure named above:
        // with the pool exhausted, each attempt costs `connectionTimeoutMillis`
        // before it rejects, so the retry self-throttles to ~0.1/s and — the
        // part that matters — can never stack a second connection request
        // behind an unanswered one.
        //
        // The beat is the FLOOR, not the cadence. `publishHealthIfNothingOutstanding` has
        // seven callers; the beat is merely the only one a quiet workspace is
        // guaranteed to have. Under fast rejection that floor is 1 statement/s
        // per projector, 8/s at the default fleet cap.
        rollback()
        console.error(`[read-model] failed to ${label}`, error)
      })
  }

  // One row write per incident, not per failing document: a registry with
  // hundreds of unresolvable references would otherwise amplify a single
  // degradation into hundreds of identical UPDATEs. The stored `degraded_since`
  // and the first error code describe the incident; the per-document detail
  // lives in the logs and in the retry-queue metrics.
  const publishDegradation = (kind: DegradationKind, error: unknown): void => {
    // The same two gates the health publish uses, for the same reason. A
    // projector that has been torn down, or that this cell no longer serves,
    // must not write ANYTHING about the workspace — a mark it leaves behind
    // outlives it exactly as a clear would, and the new owner will not retract
    // it because its own `degradationPublished` is null and its `healthPublished`
    // says the row is fine.
    if (stopped) return
    if (!stillOwned()) {
      // REMEMBERED, not dropped: there is no next call on the common path — `degrade`/`degradeShard` have
      // ALREADY recorded the url, so `publishHealthIfNothingOutstanding` is
      // blocked by the non-empty set, and `publishDegradation` only runs again
      // on a NEW incident. On a quiet workspace that never comes.
      //
      // And the window is not exotic. `ownsWorkspace` is `syncCellOwnership.owns`,
      // which reports false whenever Redis is not `ready`; a reconnect inside
      // the renew cadence flips it false->true with no ownership-loss event and
      // no generation bump. A document abandoned in that gap would have been
      // silently forgotten — the row saying healthy while the projector knows it
      // is not, which is the direction this whole section argues is the worse
      // one.
      pendingDegradation ??= { kind, error }
      return
    }
    // Before the dedup, not after: a degradation of the SAME kind still means
    // the row no longer says healthy, and a `healthPublished` left true here
    // would suppress the clear that should follow the recovery.
    healthPublished = false
    if (degradationPublished === kind) return
    degradationPublished = kind
    queueHealthWrite(
      'persist degraded state',
      () => markReadModelWorkspaceDegraded(db, key, orgId, kind, error),
      () => {
        // Record the failure and decide NOTHING here. Both judgements this
        // rollback could plausibly make — is the incident still real, and may
        // the dedup re-open — belong to `flushHeldDegradation`, the only reader
        // of a held incident.
        //
        // The reason is timing: the question can only be answered LATE. An
        // incident can resolve between the hold and the flush, and a check
        // evaluated here cannot see that — it would be a premature guard.
        //
        // `??=`, not `=`: first one wins, because the row records the incident
        // and not every document in it — the same rule as `publishDegradation`'s
        // own comment above. Not covered by a test (it needs two rejections of
        // DIFFERENT kinds settling with no flush between them); what it protects
        // is which incident's `kind` the row names, never whether the row is
        // degraded.
        //
        // Known limitation of the same kind: sets empty at rollback, a DIFFERENT
        // incident arriving before the flush, and the flush re-publishes the
        // held, resolved `kind` instead of the live one. `degraded_since` is
        // `COALESCE`d and stays right; only the diagnostic label is stale.
        //
        // The clear's rollback holds nothing, so it needs none of this. Its
        // redundant re-issue is a no-op at the database: the statement carries
        // `WHERE degraded_since IS NOT NULL`.
        pendingDegradation ??= { kind, error }
      },
    )
  }
  const degrade = (docUrl: string, kind: DegradationKind, error: unknown): void => {
    degradedDocuments.add(docUrl)
    publishDegradation(kind, error)
  }
  const degradeShard = (url: string, kind: DegradationKind, error: unknown): void => {
    degradedShards.add(url)
    publishDegradation(kind, error)
  }

  /**
   * Say "healthy" out loud.
   *
   * The condition is what this projector currently OWES the workspace:
   *
   *   - a document or shard it has given up on (`degraded*`), and
   *   - a document still sitting in the retry queue.
   *
   * `handleDiagramAttachFailure` puts an unavailable document into
   * `documentRetries` and adds it to `degradedDocuments` only if the queue
   * REFUSES it, so an empty degraded set says nothing about a workspace whose
   * documents are all still being fetched. Reporting healthy there would make
   * the degradation never visible, because under fleet LRU churn a projector
   * can be recycled before the queue's 120 s wall clock ever abandons anything.
   *
   * `healthPublished` — NOT `degradationPublished` — is what makes this idempotent.
   * A fresh projector starts with `degradationPublished === null` and yet may face
   * a row degraded by a previous process; it starts with `healthPublished ===
   * false` so it can retract that degradation — a claim about the ROW, not about
   * this process. Every `publishDegradation` resets it.
   *
   * `stillOwned` is the third guard (rather than a compare-and-set on
   * `projector_instance_id`, which is unreliable). What it has to express is "this cell still serves this workspace", which is
   * process-local knowledge the fleet already holds — not a database column that
   * `StaticDeltaProjector` also writes, and not a claim tied to whether some
   * other write happened to land. It defaults to true so a directly-started
   * projector (tests, the default workspace) behaves as before.
   */
  /**
   * Re-issue a degradation whose write did not land. Called by the BEAT and by
   * nothing else, and that restriction is the whole point.
   *
   * Not part of `publishHealthIfNothingOutstanding`: that function has SEVEN
   * callers — reconcile, meta sync, root sync, every successful diagram
   * reprojection, the eviction hook, the retry queue's `onIdle`, and the beat —
   * so with a mark rejecting, every change event would consume the hold,
   * re-open the dedup, re-publish, reject and hold again (measured: 40 change
   * events inside one beat interval produced 40 marks). That is the
   * amplification `publishDegradation` forbids — one row write per incident —
   * aimed at a database that is already refusing writes.
   *
   * On the beat alone the rate is the beat, by construction rather than by
   * argument, and a held incident is still re-issued within one interval.
   */
  const flushHeldDegradation = (): void => {
    if (pendingDegradation && !stopped && stillOwned()) {
      const held = pendingDegradation
      pendingDegradation = null
      // Re-open the dedup HERE, and deliberately not in the rollback that held
      // the incident. `degradationPublished` still names the kind whose write
      // did not land, so `publishDegradation` would return at its own dedup and
      // the retry would be swallowed — the held incident consumed by a call that
      // queues nothing.
      //
      // Doing it here rather than in the rollback keeps the dedup shut for
      // `degrade` and `degradeShard` (the health publish's own callers queue no
      // marks). So on a cold build against a refusing database, un-dedupping
      // in the rollback would let each rejection admit the next failing
      // document's own mark, approaching one write per failing document.
      degradationPublished = null
      // Does the incident still EXIST? Asked here and nowhere else, because
      // here is the only place late enough to know. A hold is created whenever
      // a mark fails, and both producers — the mark's rollback and the
      // ownership-gap hold in `publishDegradation` — are blind to what happens
      // next: the failure can resolve between the hold and this flush.
      // Publishing a resolved incident marks a workspace whose degraded sets
      // are both empty.
      //
      // The bound on how long that stays wrong is "until this workspace is
      // attached again", NOT "for ever": a fresh projector starts
      // `healthPublished === false` precisely so it can retract a previous
      // process's degradation.
      if (degradedDocuments.size || degradedShards.size) publishDegradation(held.kind, held.error)
    }
  }

  const publishHealthIfNothingOutstanding = (): void => {
    if (stopped || healthPublished || reconcilingGuard.depth > 0 || !stillOwned()) return
    if (degradedDocuments.size || degradedShards.size) return
    const queue = documentRetries.snapshot()
    if (queue.pendingDepth > 0 || queue.activeResolutions > 0) return
    healthPublished = true
    degradationPublished = null
    queueHealthWrite(
      'clear degraded state',
      () => clearReadModelWorkspaceDegraded(db, key),
      // The row never learned this workspace is healthy, so this projector must
      // not go on believing it did. The beat re-decides.
      () => { healthPublished = false },
    )
  }
  const clearDegradationIfRecovered = publishHealthIfNothingOutstanding

  const warnOnceAboutDiagram = (docUrl: string, message: string): void => {
    if (diagramWarned.has(docUrl)) return
    diagramWarned.add(docUrl)
    console.warn(`[read-model] ${key.landscapeId}/${key.versionId}: ${message}`)
  }

  const forgetDiagramDoc = (docUrl: string): void => {
    diagramWarned.delete(docUrl)
    degradedDocuments.delete(docUrl)
  }

  /** The diagram is no longer in the registry — stop offering it to the resident
   * sweep. Deliberately NOT part of `forgetDiagramDoc`, which means "clear the
   * failure bookkeeping" and runs after every SUCCESSFUL attach; folding this
   * into it wipes the re-attach mapping the instant it is created. */
  const forgetDiagramResidency = (docUrl: string): void => {
    lastKnownDiagram.delete(docUrl)
    for (const [documentId, url] of diagramUrlByDocumentId) {
      if (url === docUrl) diagramUrlByDocumentId.delete(documentId)
    }
  }

  function onDiagramRetryAbandoned(
    docUrl: string,
    reason: DocumentRetryAbandonReason,
    error: unknown,
  ): void {
    switch (reason) {
      case 'dropped':
      case 'stopped':
        // No longer referenced, or the projector is going away: nothing is owed.
        forgetDiagramDoc(docUrl)
        return
      case 'invalid':
        // A legacy registry entry pointing at a document that can never resolve
        // is tolerated, exactly as before: the diagram metadata stays queryable
        // and only its optional flows are absent.
        warnOnceAboutDiagram(docUrl, `diagram document ${documentIdOf(docUrl)} can never resolve; flows omitted`)
        degradedDocuments.delete(docUrl)
        return
      default:
        // deadline / exhausted / unexpected: the read model is knowingly
        // incomplete for this document.
        console.error(
          '[read-model] diagram document abandoned',
          { workspace: `${key.landscapeId}/${key.versionId}`, reason },
          describeDocumentResolutionFailure(docUrl, error, classifyDocumentResolutionError(error)),
        )
        // An authority loss can reach here by a non-obvious route: a queued
        // document is retried, `project()` correctly refuses to degrade and
        // rethrows, `projectThenWatch` wraps it in `DiagramFlowProjectionError`,
        // `classifyDocumentResolutionError` maps that to `unexpected`, the
        // default `retryOn` is `RETRY_ONLY_UNAVAILABLE`, and the entry is
        // abandoned — landing here. Without the filter below, a promotion
        // landing while the document is queued would write `degraded_since`
        // onto the other writer's row.
        //
        // That forgery would be sticky. On a static workspace the
        // mark has no lift — the only `clearReadModelWorkspaceDegraded` call
        // site is in this file, which the fleet refuses to attach there — and
        // `promoteSummaryWorkspace` refuses promotion on a non-healthy status.
        if (!isReadModelAuthorityLoss(error) && !isProjectionMutexTimeout(error)) {
          degrade(docUrl, reason === 'unexpected' ? 'registry' : 'document_resolution', error)
        }
    }
  }

  /**
   * A flow projection that reached PostgreSQL and failed there. It carries the
   * work needed to finish — the document is already resolved — so a database
   * outage is retried as a REPROJECTION and never as another `repo.find()`.
   */
  class DiagramFlowProjectionError extends Error {
    readonly code = 'read_model_diagram_flow_projection_failed'
    constructor(
      readonly diagramId: string,
      readonly reproject: () => Promise<void>,
      options?: { cause?: unknown },
    ) {
      super(`Diagram ${diagramId} flow projection failed`, options)
      this.name = 'DiagramFlowProjectionError'
    }
  }

  /**
   * Resolve, project and watch ONE diagram document. The change watcher is
   * registered only after the initial flow projection has committed, so a
   * document whose projection failed is never counted as ready.
   */
  const attachDiagramDoc = async (
    diagram: DiagramInput,
    docUrl: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const handle = await resolveHandleWithRetry(repo, docUrl, {
      tries: 1, signal, deadlineMs: resolveDeadlineMs,
    })
    diagramUrlByDocumentId.set(String(handle.documentId), docUrl)
    lastKnownDiagram.set(docUrl, diagram)
    // Later flow projections degrade the workspace too: a change that cannot be
    // written must not disappear into a log line.
    const project = async () => {
      try {
        // `syncConnectionFlows` DELETES every ro_connection_flows row for this
        // diagram before re-inserting, so an uninitialised diagram document
        // would wipe its flows silently. Diagram documents always carry `flows: {}` (client
        // `createDiagramHandle`, server `starterDiagramDoc`), so an absent key is
        // never a legitimately flow-less diagram.
        const readFlows = readEntityMapOrDefect<FlowInput>(handle.doc(), 'flows', 'registry-shard', docUrl)
        if (isUninformative(readFlows.defect)) {
          recordRefusedProjection()
          console.warn(
            `[read-model] refused a flow projection for ${key.landscapeId}/${key.versionId} diagram ` +
              `${diagram.id}: ${docUrl} carries no flows map; its flow rows are left untouched`)
          return
        }
        const flows = Object.values(readFlows.map)
        // The only served row a flow pass moves is a connection's `flow_count`,
        // for the connections this diagram's flows reference before or after.
        // It runs on EVERY change of the diagram document — a drag included —
        // so a reset here re-downloaded every offline copy per gesture.
        const flowConnectionIds = flows.flatMap((flow) => (flow.steps ?? [])
          .flatMap((step) => step.connectionId ? [step.connectionId] : []))
        await runTracked('registry', (tx) => servedConnectionRowsChangedBy(tx, key,
          // GROUP BY, not the DISTINCT `syncConnectionFlows` itself issues: the
          // projector suite counts that statement as "one flow projection".
          async () => [...flowConnectionIds, ...(await tx.query<{ connection_id: string }>(
            `SELECT connection_id FROM ro_connection_flows
             WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3
             GROUP BY connection_id`,
            [key.landscapeId, key.versionId, diagram.id],
          )).rows.map((row) => row.connection_id)],
          () => syncConnectionFlows(
            tx, key, orgId, diagram.id, flows,
            // Certify coverage only for a real flows map: a `field-not-a-map`
            // defect reads as `{}` and must not become "complete, no flows".
            readFlows.defect === null,
          )), (changes) => ({ kind: 'connections', ...changes }),
        // Writes ro_connection_flows, ro_flows, ro_flow_objects and
        // ro_diagram_flow_index — NOTHING a digest covers (DIGEST_KINDS is the
        // object/connection/group/diagram id sets), so all four seals stay
        // accurate and only their generation moves. Without this the boot's
        // per-diagram flow pass would invalidate every seal it walked past.
        { unchanged: DIGEST_KINDS })
        degradedDocuments.delete(docUrl)
        clearDegradationIfRecovered()
      } catch (error) {
        // A lost fence is not a degradation of THIS workspace's read model —
        // it is the end of this projector's authority over it. Publishing a
        // sticky degradation here would land `write_fence_lost` on the NEW
        // owner's row (the `stillOwned` gate cannot catch it: the whole
        // premise of the fence is that a stale lease copy can read true), and
        // the owner would never retract it because its own `healthPublished`
        // latch already says the row is fine. The retry queue must not chew
        // on it either — every reprojection would abort the same way, five
        // begins per document onto the owner's row. Rethrow only: runTracked
        // already latched the fence loss and the fleet recycle is on its way.
        //
        // `isReadModelAuthorityLoss`, not a bare `instanceof`: a lost PLANE has
        // every property this paragraph describes and one more: a degradation
        // on a static workspace has NO lift — the only
        // `clearReadModelWorkspaceDegraded` call site is in this file, and the
        // fleet refuses to attach this projector to a static workspace at all.
        // …and NOT for a busy mutex either: transient contention must not write
        // `degraded_since` onto the row `runTracked` already refuses to touch
        // with `failReadModelProjection`. The two predicates are deliberately
        // separate because they differ on RETRY, but they agree completely on
        // this: neither is a degradation of THIS workspace's read model.
        if (!isReadModelAuthorityLoss(error) && !isProjectionMutexTimeout(error)) {
          degrade(docUrl, 'registry', error)
        }
        throw error
      }
    }
    const projectThenWatch = async () => {
      await project()
      // An eviction landing between the resolve above and this line would leave
      // us watching a handle the repo has already dropped — installing the exact
      // orphan this design removes. And it costs more than a leaked listener:
      // the line below also writes `diagramWatchers`, which the resident sweep
      // reads as "already handled", so when the document comes back under a NEW
      // handle nothing ever re-attaches and THIS DIAGRAM STOPS PROJECTING,
      // silently and permanently. The resident sweep re-attaches; do not
      // register a watcher on a stale handle.
      //
      // O(1). Not `repo.handles[handle.documentId]`, a getter that rebuilds the
      // entire handle Record per access — a 30k-diagram cold build would pay
      // 30 000 of them. `syncedHandle` answers from
      // the sync layer's registry, whose key set equals the cache's in every
      // reachable state (`automergeRepoCompat.seam.test.ts`).
      // `stopped` FIRST. The signal threaded into `resolveHandleWithRetry`
      // above bounds only the RESOLVE (it is consulted at the loop head and
      // around `repo.find`, nowhere after the handle resolves) and leaves
      // `await project()` — a full `runTracked` transaction, the long phase —
      // unguarded. Passing a signal into a call does not make it cancellable.
      //
      // Without this guard, an attach parked inside `project()` across a
      // `stop()` would reach this line after `diagramWatchers.clear()` has
      // already run, register `onChange` into a map nothing will ever walk
      // again, and drive full `syncConnectionFlows` transactions for a
      // workspace this projector no longer serves (the input to
      // `automerge.orphaned_listener_evicted`). Three doors reach this line:
      // the sweep, `reconcilePass`, and the retry queue's task. Rule: put the
      // guard after the LONGEST await, not after the one that takes a signal.
      //
      // `stopped`, not `signal?.aborted`: the two are equivalent today (one
      // shared `AbortController` in the retry queue, aborted only by `stop()`),
      // but `stopped` is the fact itself and also holds for a caller that
      // forgets the signal.
      if (stopped) return
      if (syncedHandle(repo, handle.documentId) !== handle) return
      const coalescer = coalescedProjection('diagram flow projection', project)
      const onChange = coalescer.trigger
      handle.on('change', onChange)
      diagramWatchers.set(docUrl, {
        handle,
        diagram,
        stop: () => { coalescer.dispose(); handle.off('change', onChange) },
      })
    }
    try {
      await projectThenWatch()
    } catch (error) {
      throw new DiagramFlowProjectionError(diagram.id, projectThenWatch, { cause: error })
    }
  }

  /** One attempt for one diagram, never throwing. A document url is owned by
   * exactly one of: an attached watcher, an in-flight attempt, or the retry
   * queue — which is what keeps a url from being scheduled twice. */
  const tryAttachDiagramDoc = async (diagram: DiagramInput, signal?: AbortSignal): Promise<void> => {
    const docUrl = typeof diagram.docUrl === 'string' ? diagram.docUrl : null
    if (!docUrl) return
    if (diagramWatchers.has(docUrl) || diagramWatchInFlight.has(docUrl) || documentRetries.has(docUrl)) return
    diagramWatchInFlight.add(docUrl)
    try {
      await attachDiagramDoc(diagram, docUrl, signal)
      forgetDiagramDoc(docUrl)
    } catch (error) {
      handleDiagramAttachFailure(diagram, docUrl, error)
    } finally {
      diagramWatchInFlight.delete(docUrl)
    }
  }

  function handleDiagramAttachFailure(diagram: DiagramInput, docUrl: string, error: unknown): void {
    // The wrapped case (`DiagramFlowProjectionError` carrying the cause) is
    // unwrapped inside the predicate, so the two sites cannot disagree about
    // what counts.
    if (isReadModelAuthorityLoss(error)) {
      // This projector's authority over the workspace is gone; every retry
      // would abort identically. runTracked already latched the loss and the
      // fleet recycle is the recovery — scheduling reprojections here would
      // only burn the retry budget against a dead fence, or against a plane
      // this projector no longer owns.
      return
    }
    if (error instanceof DiagramFlowProjectionError) {
      // PostgreSQL or a projection fault. The document itself already resolved,
      // so this never re-enters document resolution: the workspace is marked
      // degraded (done by `project`) and a strictly bounded REPROJECTION of the
      // already-held handle is scheduled instead.
      console.error(
        `[read-model] diagram flow projection failed (${key.landscapeId}/${key.versionId}/${diagram.id})`,
        error.cause ?? error,
      )
      documentRetries.schedule(docUrl, () => error.reproject(), {
        maxAttempts: DIAGRAM_REPROJECTION_ATTEMPTS,
        retryOn: () => true,
      })
      return
    }
    const outcome = classifyDocumentResolutionError(error)
    if (outcome === 'aborted') return
    if (outcome === 'invalid') {
      onDiagramRetryAbandoned(docUrl, 'invalid', error)
      return
    }
    if (outcome === 'unavailable') {
      warnOnceAboutDiagram(
        docUrl,
        `diagram document ${documentIdOf(docUrl)} (${diagram.id}) has not synced yet; ` +
        'core projector remains available and the document is queued for bounded retries',
      )
      // A refusal means the pending cap is reached: say so instead of pretending
      // the document is on its way.
      const queued = documentRetries.schedule(
        docUrl,
        (signal) => attachDiagramDoc(diagram, docUrl, signal),
      )
      if (!queued) degrade(docUrl, 'document_resolution', error)
      return
    }
    console.error(
      '[read-model] unexpected diagram document failure',
      describeDocumentResolutionFailure(docUrl, error, outcome),
    )
    degrade(docUrl, 'document_resolution', error)
  }

  /**
   * Bring watchers in line with the registry. Documents that resolve are
   * attached immediately with bounded concurrency; only genuinely missing ones
   * enter the retry queue, and a reference removed while its document was still
   * pending stops consuming a slot at once.
   */
  const reconcileDiagramDocs = async (diagrams: DiagramInput[]): Promise<void> => {
    // Nothing may report this workspace healthy until the pass finishes.
    //
    // "Nothing outstanding" is only a statement about the workspace once every
    // document has been LOOKED AT. Mid-pass it means "nothing outstanding among
    // the ones examined so far", and the two differ in the way that matters:
    // `resolveInBatches` runs 4 at a time, `attachDiagramDoc`'s success path
    // calls the health publish, and a document that fails is queued only when
    // its own batch is reached. So diagram 1 succeeding while diagram 30's
    // document is still unexamined would publish "healthy" and LATCH it — and a
    // queued document never degrades, so nothing would retract it until the
    // queue's 120 s wall clock abandons it. (A race: it only shows when the
    // failing documents are not in the first batch.)
    await withReconciling(() => reconcilePass(diagrams))
    // Now it means what it says.
    publishHealthIfNothingOutstanding()
  }

  const reconcilePass = async (diagrams: DiagramInput[]): Promise<void> => {
    const wanted = new Set(diagrams.flatMap((diagram) => typeof diagram.docUrl === 'string' ? [diagram.docUrl] : []))
    for (const [url, watcher] of diagramWatchers) {
      if (!wanted.has(url)) {
        watcher.stop()
        diagramWatchers.delete(url)
        forgetDiagramDoc(url)
        forgetDiagramResidency(url)
      }
    }
    documentRetries.retain(wanted)
    for (const url of [...diagramWarned]) if (!wanted.has(url)) forgetDiagramDoc(url)
    for (const url of [...degradedDocuments]) if (!wanted.has(url)) forgetDiagramDoc(url)
    await resolveInBatches(
      diagrams,
      (diagram) => tryAttachDiagramDoc(diagram, documentRetries.signal),
      DIAGRAM_ATTACH_CONCURRENCY,
    )
    // The health call belongs to `reconcileDiagramDocs`, AFTER it lowers the
    // `reconciling` guard — issuing it here would be inside the guard and do
    // nothing.
  }

  // The diagram probe is NOT awaited here: its optional flow projection must
  // not hold every core read-model route in a 503. `ProjectorFleet.start` only
  // marks the workspace resident once this function resolves, and
  // `/api/model/*` answers 503 until then — awaiting would make every core
  // route wait for every diagram document to load (each unresolvable one
  // costing a full 10 s resolve deadline), for a projection those routes do not
  // read. It runs, unawaited, at the end of the attach sequence. See there.
  cleanups.push(() => {
    documentRetries.stop()
    unregisterDocumentRetries()
    for (const watcher of diagramWatchers.values()) watcher.stop()
    diagramWatchers.clear()
    diagramUrlByDocumentId.clear()
    lastKnownDiagram.clear()
    diagramWarned.clear()
    degradedDocuments.clear()
    degradedShards.clear()
  })

  // Per-shard incremental: snapshot each shard's id→entity map; on change, diff.
  // `applyInitial` cold-builds the shard's CURRENT contents into the read model — set
  // for shards appended MID-SESSION (a client created a new shard with new objects);
  // the boot shards are already covered by coldBuildReadModel above.
  //
  // Watermark-recording protocol shared by both shard watchers: flush, prepare a durable witness outside the transaction,
  // then require sampled/durable/current heads to agree before stamping.
  // A disagreement explicitly invalidates the old certificate; a sequence
  // minted before sampling need not have committed before it.
  const headsEqual = watermarkHeadsEqual
  // No heads means no verified certificate, including for plain test docs.
  const tryGetHeads = tryGetAutomergeHeads
  const recordShardWatermark = async (
    tx: Queryable,
    handle: DocHandle<unknown>,
    sampledHeads: readonly string[] | null,
    preparedWatermarks: PreparedDocumentWatermarks,
  ) => {
    // NOT gated on `stillOwned`: the write fence already makes a disowned
    // stamp impossible at the transaction level — a genuinely disowned pass
    // rolls back whole, stamp included — while a lease guard would only drop
    // legitimate upgrades whenever the flickery lease read false on an
    // instance that still holds the fence, deferring `absenceProvable` for that
    // document until the next delta (on a quiet workspace: indefinitely). A transaction already in flight can finish after stop: its
    // rows still need either a certificate or an explicit invalidation. A
    // missing/replaced handle refuses below; lost write authority rolls back
    // the complete transaction through the fence.
    // The certificate/refusal decision lives in recordSampledDocumentWatermark,
    // where real PostgreSQL/Automerge races exercise both outcomes.
    await recordSampledDocumentWatermark(
      tx, key, handle.documentId, sampledHeads, () => {
        const meta = metaHandle?.doc() as MetaLike | undefined
        const references = rememberShardReferences(meta?.objectShardUrls ?? [], meta?.connectionShardUrls ?? [])
        if (ambiguousShardDocuments.has(handle.documentId) || references.get(handle.documentId) !== 1) return null
        const state = repo.synchronizer.docSynchronizers[handle.documentId]?.query.peek()
        return state?.state === 'ready' && state.handle === handle ? tryGetHeads(handle.doc()) : null
      }, preparedWatermarks,
    )
  }
  /**
   * Acknowledge write batches whose rows are ALREADY published without a
   * projection. The cold build publishes a write head's objects through the
   * extraction and the shard then attaches with `applyInitial=false`; when the
   * live heads equal the extraction's there is no gap projection to carry the
   * acknowledgement, and without this the batches would stay unacknowledged
   * until the next client write (on a quiet workspace: never). Fenced and
   * atomic like `runTracked`, minus the bookkeeping a pass that wrote no row
   * must not have: no health span, no change-feed entry, no generation bump.
   *
   * ON `projectionTail`, like every other write of this closure: off the tail
   * it would take the per-workspace projection mutex concurrently with a
   * registry or diagram pass still running from the boot, and a mutex timeout
   * here is caught by the caller as "the next delta re-sends them" — a next
   * delta a quiet workspace never produces.
   * Authority loss is latched through `reportFenceLost` for the same reason
   * `runTracked` latches it: the recycle is the recovery.
   */
  const acknowledgeOnly = (
    collection: 'object' | 'connection',
    documentId: DocumentId,
    batchIds: readonly string[],
  ): Promise<void> => {
    if (!batchIds.length || stopped) return Promise.resolve()
    const task = projectionTail.then(async () => {
      try {
        const held = await readWriteFence(db, key)
        if (held !== projectorInstanceId) throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
        if (await isStaticReadModelWorkspace(db, key)) throw new ReadModelPlaneError(key, 'ordinary')
        await withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
          await acknowledgeOverlayBatches(tx, key, collection, documentId, batchIds, 'projected', 0, 0)
          await assertReadModelWriteFence(tx, key, projectorInstanceId)
        })
      } catch (error) {
        if (isReadModelAuthorityLoss(error)) reportFenceLost(collection === 'object' ? 'object_shard' : 'connection_shard', error)
        throw error
      }
    })
    projectionTail = task.then(() => undefined, () => undefined)
    return task
  }
  /** Re-read the retirement rows when a write-head pointer has moved since the
   * last read. Pointer first, rows second — see `retirements`. Single-flight,
   * and re-checked after waiting on someone else's load: that load may have
   * read its pointer, and its rows, before the move this caller saw. */
  let retirementsLoad: Promise<void> | null = null
  const freshRetirements = async (): Promise<void> => {
    for (;;) {
      const pointer = writeHeadPointer(metaHandle?.doc() as MetaLike | undefined)
      if (pointer === retirementsPointer) return
      if (!retirementsLoad) {
        retirementsLoad = (async () => {
          try {
            retirements = await loadOrdinaryHeadRetirements(db, key)
            retirementsPointer = pointer
          } finally {
            retirementsLoad = null
          }
        })()
      }
      await retirementsLoad
    }
  }
  /** Is `url` a retired head whose late writes this projector FORWARDS? Yes
   * only with a `retired` row carrying H_r and a current head that is another
   * document. No row — a head retired by compaction — or a row without H_r:
   * no, and the head is projected directly, exactly as before phase 2. */
  const isForwardedHead = (collection: 'object' | 'connection', documentId: string, url: string): boolean => {
    if (!forwardsLateWrites(retirements.get(retirementKey(collection, documentId)))) return false
    const meta = metaHandle?.doc() as MetaLike | undefined
    const current = collection === 'object' ? meta?.editsObjectShardUrl : meta?.editsConnectionShardUrl
    return Boolean(current) && current !== url
  }
  /** `forwardedBatchIds` exist in an ordinary head only once this projector's
   * forwarder wrote them, i.e. only when the workspace has a retirement row.
   * Reading them only then keeps a workspace without rows — every workspace
   * that has never been rotated — byte-identical to before. */
  const forwardedBatchIdsOf = (doc: ObjShardLike | ConnShardLike | undefined): string[] =>
    retirements.size ? doc?.forwardedBatchIds ?? [] : []
  /** What the segments OTHER than the current head serve for `ids`, ModelMeta
   * order, later wins — the cold build's `Object.assign` minus its last term. */
  const servedOutsideCurrentHead = async (
    collection: 'object' | 'connection',
    currentUrl: string,
    ids: readonly string[],
  ): Promise<Map<string, Record<string, unknown>>> => {
    const meta = metaHandle?.doc() as MetaLike | undefined
    const urls = (collection === 'object' ? meta?.objectShardUrls : meta?.connectionShardUrls) ?? []
    const field = collection === 'object' ? 'objects' : 'connections'
    const served = new Map<string, Record<string, unknown>>()
    for (const url of urls) {
      if (url === currentUrl) continue
      const entities = ((await resolve(url)) as Record<string, Record<string, unknown> | undefined> | undefined)?.[field]
      for (const id of ids) {
        const value = entities?.[id]
        if (value && typeof value === 'object') served.set(id, JSON.parse(JSON.stringify(value)))
      }
    }
    return served
  }
  /** documentId -> the projection trigger of its shard watcher, so one head's
   * work can ask another head's projection to run: a rotation asks the
   * retired head to forward what arrived after H_r, a forward asks its target
   * to publish (see `retiredHeadStamps`). */
  const shardTriggers = new Map<string, () => void>()
  /** url -> the teardown of its object/connection shard watcher, so ONE shard
   * can stop being watched while the projector runs (a folded source,
   * `ordinaryChainFold.ts`). Every entry still runs at `stop()`; a stop that
   * ran early is not run twice. */
  const shardStops = new Map<string, { documentId: DocumentId; stop: () => void; idle: () => Promise<void> }>()
  /** Fold sources whose detach has begun and not finished: neither watched
   * nor released yet, so the folded-head poll leaves them alone. */
  const foldSourcesDetaching = new Set<string>()
  /** Sources this projector detached. Never attached again: an attach pass
   * that started on an older ModelMeta (the retry runs beside the meta
   * pass) would otherwise re-apply one whole, older values over newer rows.
   * Never projected or forwarded by their old watcher again either: a pass
   * that starts after the detach took the source returns at once. */
  const detachedFoldSources = new Set<string>()
  const watchShardStop = (
    url: string,
    documentId: DocumentId,
    stop: () => void,
    idle: () => Promise<void>,
  ): void => {
    // The reference is dropped once run, so a watcher stopped early is not
    // kept alive (its snapshot, its handle) by `cleanups` until `stop()`.
    let pendingStop: (() => void) | null = stop
    const once = () => { const run = pendingStop; pendingStop = null; run?.() }
    shardStops.set(url, { documentId, stop: once, idle })
    cleanups.push(once)
  }
  /** The watcher body of a fold product: a change after its seed is never
   * projected (`ordinaryChainFold.ts`); it degrades the shard, and only a cold
   * build lifts that. */
  const refuseFoldProductChange = (url: string, kind: 'object_shard' | 'connection_shard') => async (): Promise<void> => {
    recordRefusedProjection()
    const error = new Error(
      `${ORDINARY_FOLD_PRODUCT_CHANGED}: fold product ${url} changed after it was attached; not projected`)
    console.error(JSON.stringify({
      event: 'read_model.ordinary_fold_product_changed',
      workspace: `${key.landscapeId}/${key.versionId}`,
      kind,
      url,
      error: error.message,
    }))
    degradeShard(url, kind, error)
  }
  /** documentId -> the heads of the last sample of that shard whose rows
   * COMMITTED (the cold build's extraction, an initial apply, a delta). The
   * rotator's H_r comes from here and from nowhere else: the live document,
   * and `A.stats`, can be ahead of what is published (phase-1 review). */
  const publishedHeadsByDocument = new Map<string, readonly string[]>()
  const notePublished = (documentId: string, heads: readonly string[] | null | undefined): void => {
    if (heads?.length) publishedHeadsByDocument.set(documentId, [...heads])
  }

  /**
   * ARRIVAL WATERMARKS OF FORWARDED HEADS. A retired head with a row is never
   * projected, so nothing re-stamps its `read_model_document_watermarks` row,
   * and one late write leaves `absenceProvable` refused until a cold build
   * (the phase-2 review's finding). Stamping it when the forward COMMITS would
   * be early: the forwarded values are then in the current head's document,
   * not yet in `ro_*`. So a forward leaves a STAMP here, keyed by the retired
   * head, naming the heads it forwarded up to and the head it wrote into; the
   * TARGET's next projection takes it AT SAMPLING (so the sample holds the
   * forwarded write, which was made synchronously before the stamp existed)
   * and records it in the SAME transaction as the rows that carry the values,
   * through the same certificate rule as every shard: durable, sampled and
   * live heads of the retired head must agree, or the certificate is 0.
   *
   * A stamp whose target is itself forwarded before it projects — rotated
   * again in between — follows the forward: when the target's own forward
   * commits, stamps registered before that forward began are re-keyed to ITS
   * target, whose projection then publishes both. A stamp that is never
   * consumed (a projector stopped first) leaves the proof refused — the safe
   * direction — until the next cold build stamps every shard.
   */
  const retiredHeadStamps = new Map<string, {
    handle: DocHandle<unknown>
    heads: string[]
    target: string
    seq: number
  }>()
  let retiredHeadStampSeq = 0
  /** Retired heads whose stamp a target's pass has TAKEN and not yet settled
   * (published, or put back): out of `retiredHeadStamps`, still owed. The
   * pass re-reads the retired handle when it commits (`liveHeadsForStamp`),
   * so a park must not evict it meanwhile. retired id -> passes holding one. */
  const stampsInFlight = new Map<string, number>()
  const takeRetiredHeadStamps = (targetDocumentId: string) => {
    const taken = [...retiredHeadStamps.entries()].filter(([, stamp]) => stamp.target === targetDocumentId)
    for (const [retiredId] of taken) {
      retiredHeadStamps.delete(retiredId)
      stampsInFlight.set(retiredId, (stampsInFlight.get(retiredId) ?? 0) + 1)
    }
    return taken.map(([, stamp]) => stamp)
  }
  /** The pass that took `stamps` is done with them (its `finally`). */
  const settleTakenStamps = (stamps: ReadonlyArray<{ handle: DocHandle<unknown> }>) => {
    for (const stamp of stamps) {
      const id = stamp.handle.documentId
      const held = (stampsInFlight.get(id) ?? 1) - 1
      if (held > 0) stampsInFlight.set(id, held)
      else stampsInFlight.delete(id)
    }
  }
  /** Put back stamps a pass took and did not publish — unless a newer stamp
   * for the same retired head arrived meanwhile. */
  const restoreRetiredHeadStamps = (stamps: ReadonlyArray<{ handle: DocHandle<unknown>; heads: string[]; target: string; seq: number }>) => {
    for (const stamp of stamps) {
      if (!retiredHeadStamps.has(stamp.handle.documentId)) retiredHeadStamps.set(stamp.handle.documentId, stamp)
    }
  }
  /** The live heads of a retired head for its certificate, under the same
   * refusals as `recordShardWatermark`: referenced once, not ambiguous, and
   * still the repo's ready handle. */
  const liveHeadsForStamp = (handle: DocHandle<unknown>): readonly string[] | null => {
    const meta = metaHandle?.doc() as MetaLike | undefined
    const references = rememberShardReferences(meta?.objectShardUrls ?? [], meta?.connectionShardUrls ?? [])
    if (ambiguousShardDocuments.has(handle.documentId) || references.get(handle.documentId) !== 1) return null
    const state = repo.synchronizer.docSynchronizers[handle.documentId]?.query.peek()
    return state?.state === 'ready' && state.handle === handle ? tryGetHeads(handle.doc()) : null
  }
  const recordRetiredHeadStamps = async (
    tx: Queryable,
    stamps: ReadonlyArray<{ handle: DocHandle<unknown>; heads: string[] }>,
    preparedWatermarks: PreparedDocumentWatermarks,
  ): Promise<void> => {
    for (const stamp of stamps) {
      await recordSampledDocumentWatermark(
        tx, key, stamp.handle.documentId, stamp.heads, () => liveHeadsForStamp(stamp.handle), preparedWatermarks,
      )
    }
  }

  /**
   * A FAILED FORWARD IS RETRIED, AND IT IS VISIBLE. Before this, a forward that
   * threw (the current head unresolvable, a SQL blip) was logged and then
   * waited for the retired head's NEXT change — on a head only offline
   * stragglers write, possibly never — with the late edit invisible in the
   * product the whole time. Now the retired head is marked in `degradedShards`
   * (the same signal a shard that failed to attach raises, published as the
   * workspace's degradation and lifted when it clears), and its projection is
   * re-triggered on a capped backoff until a forward commits.
   *
   * An `unknown-heads` refusal degrades too, and is NOT retried: the row names
   * heads the document does not hold, which no retry changes; it needs a
   * person (the refusal's own log line names the heads).
   *
   * Two failures are retried WITHOUT degrading (phase-3 review): a failed
   * read of the routing rows (`freshRetirements`), which is not a forward and
   * runs for heads that are not forwarded at all; and a projection-mutex
   * timeout, which clears when the other writer commits. And only a forward
   * that actually ran (`forwarded`, `superseded`, `nothing`) — or a head no
   * longer forwarded — lifts what this path raised; `not-owner` and
   * `not-retired` lift nothing.
   */
  const FORWARD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 60_000]
  const forwardRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>()
  const scheduleForwardRetry = (documentId: string): void => {
    if (stopped) return
    const previous = forwardRetries.get(documentId)
    if (previous) clearTimeout(previous.timer)
    const attempt = (previous?.attempt ?? 0) + 1
    const delay = FORWARD_RETRY_DELAYS_MS[Math.min(attempt, FORWARD_RETRY_DELAYS_MS.length) - 1]
    const timer = setTimeout(() => {
      if (!stopped) shardTriggers.get(documentId)?.()
    }, delay)
    timer.unref?.()
    forwardRetries.set(documentId, { timer, attempt })
  }
  /** The shard urls THIS path degraded, so that clearing one never lifts a
   * degradation another path raised for the same url. */
  const forwardDegradedUrls = new Set<string>()
  const forwardDegrade = (url: string, kind: DegradationKind, error: unknown): void => {
    forwardDegradedUrls.add(url)
    degradeShard(url, kind, error)
  }
  /** Nothing is owed for this head any more: a forward committed (or found
   * nothing to carry), or the head is no longer forwarded at all. */
  const forwardRecovered = (documentId: string, url: string): void => {
    const entry = forwardRetries.get(documentId)
    if (entry) {
      clearTimeout(entry.timer)
      forwardRetries.delete(documentId)
    }
    if (forwardDegradedUrls.delete(url) && degradedShards.delete(url)) clearDegradationIfRecovered()
  }
  cleanups.push(() => {
    for (const entry of forwardRetries.values()) clearTimeout(entry.timer)
    forwardRetries.clear()
    forwardDegradedUrls.clear()
  })

  /** Forward the late writes of a retired head (see `ordinaryHeadForwarding.ts`)
   * instead of projecting it. Same authority as every write of this closure:
   * `stillOwned` before the first byte and again synchronously before the
   * current head's change, the write fence and plane before the CRDT write,
   * and the `forwarded_heads` commit fenced and on `projectionTail`. */
  const forwardInsteadOfProjecting = async (
    collection: 'object' | 'connection',
    retired: DocHandle<unknown>,
    url: string,
    /** Told what `forwardRetiredHead` answered, when it ran: the folded-head
     * poll advances its watermark only on a forward that HAPPENED. */
    onOutcome?: (outcome: Awaited<ReturnType<typeof forwardRetiredHead>>) => void,
  ): Promise<boolean> => {
    const meta = metaHandle?.doc() as MetaLike | undefined
    const currentUrl = collection === 'object' ? meta?.editsObjectShardUrl : meta?.editsConnectionShardUrl
    // The current head, or no head at all: today's path, and no SQL.
    if (!currentUrl || currentUrl === url) return false
    const kind: ProjectionKind = collection === 'object' ? 'object_shard' : 'connection_shard'
    // Stamps registered before this forward begins were written INTO this
    // head before it reads itself; if it forwards, they follow it.
    const stampSeqAtEntry = retiredHeadStampSeq
    let settledTarget: string | null = null
    let outcome: Awaited<ReturnType<typeof forwardRetiredHead>>
    // The ROUTING read, outside the forward's try: a failure here is not a
    // failed forward, and on a head that turns out not to be forwarded (every
    // base shard, once any pointer moved — compaction's included, flag off)
    // nothing would ever clear a degradation raised for it: its retry returns
    // at `!isForwardedHead` below, before `forwardRecovered` (phase-3 review,
    // measured). Retried, so the edit this pass was carrying still lands;
    // not degraded.
    try {
      await freshRetirements()
    } catch (error) {
      if (isReadModelAuthorityLoss(error)) {
        reportFenceLost(kind, error)
        throw error
      }
      scheduleForwardRetry(retired.documentId)
      throw error
    }
    if (!isForwardedHead(collection, retired.documentId, url)) {
      // Projected directly from here on: a retry still pending for it is
      // spent, and a degradation THIS path raised for it (a forward that failed
      // before the head stopped being forwarded) is no longer owed.
      forwardRecovered(retired.documentId, url)
      return false
    }
    try {
      outcome = await forwardRetiredHead({
        db, key, collection, retired,
        current: () => resolveHandle(currentUrl, 'rotation-current'),
        servedElsewhere: (ids) => servedOutsideCurrentHead(collection, currentUrl, ids),
        tombstones: () => {
          const latest = metaHandle?.doc() as MetaLike | undefined
          return new Set(collection === 'object' ? latest?.deletedObjectIds ?? [] : latest?.deletedConnectionIds ?? [])
        },
        mayWrite: () => !stopped && stillOwned(),
        assertAuthority: async () => {
          const held = await readWriteFence(db, key)
          if (held !== projectorInstanceId) throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
          if (await isStaticReadModelWorkspace(db, key)) throw new ReadModelPlaneError(key, 'ordinary')
        },
        flush: (documentIds) => repo.flush(documentIds),
        commit: (write) => {
          const task = projectionTail.then(() => withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
            await write(tx)
            await assertReadModelWriteFence(tx, key, projectorInstanceId)
          }))
          projectionTail = task.then(() => undefined, () => undefined)
          return task
        },
        settled: ({ retiredHeads, targetDocumentId }) => {
          settledTarget = targetDocumentId
          for (const stamp of retiredHeadStamps.values()) {
            if (stamp.target === retired.documentId && stamp.seq <= stampSeqAtEntry) stamp.target = targetDocumentId
          }
          retiredHeadStamps.set(retired.documentId, {
            handle: retired, heads: retiredHeads, target: targetDocumentId, seq: ++retiredHeadStampSeq,
          })
        },
      })
    } catch (error) {
      if (isReadModelAuthorityLoss(error)) {
        reportFenceLost(kind, error)
        throw error
      }
      // Not lost authority: something this projector can try again.
      scheduleForwardRetry(retired.documentId)
      // A projection-mutex timeout is RETRIED but not degraded: another writer
      // holds the mutex and it clears when they commit — a cold build holds it
      // ~7-9 s against the 5 s ceiling. `runTracked` and the document paths
      // persist nothing on it either, for the same reason.
      if (!isProjectionMutexTimeout(error)) forwardDegrade(url, kind, error)
      throw error
    }
    onOutcome?.(outcome)
    if (outcome === 'unknown-heads') {
      forwardDegrade(url, kind, new Error(`retired head ${retired.documentId} cannot be forwarded: its row names heads the document does not hold`))
      return true
    }
    // A forward that did not HAPPEN — this projector no longer owns the
    // workspace, or the fresh row no longer asks for forwarding — proves
    // nothing about the one that failed: its degradation stays (pinned by
    // "a forward refused as NOT-RETIRED on its retry does not lift the
    // degradation…", `ordinaryHeadRotator.integration.test.ts`).
    if (outcome === 'not-owner' || outcome === 'not-retired') return true
    forwardRecovered(retired.documentId, url)
    // Even when the forward wrote nothing into the target (a removed key, a
    // same-field conflict the current head won): the stamp is consumed by the
    // target's next PROJECTION, and nothing else would run one.
    if (settledTarget) shardTriggers.get(settledTarget)?.()
    return true
  }

  /**
   * ROTATION (phase 3, `ordinaryHeadRotator.ts`), requested by a CURRENT head's
   * projection once that head is due and its sample has published, then
   * deferred to a quiet moment (`requestRotation` below). One per kind at a
   * time. A rotation that could not run — the lock held by another writer, a
   * transient error — is asked for again by the next pass of that head (the
   * observer keeps answering due, and the pass re-arms the deferral) and, for
   * a head nobody writes any more, by a capped backoff, which goes straight
   * to the rotator. A rotation that found the head no longer
   * current, or no longer this cell's, stops: there is nothing left to retry.
   */
  const ROTATION_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 60_000]
  /** ModelMeta's two lists for a kind, from the resident handle (G4-16e):
   * the read order and the overlay list, as the fold's pass line names them. */
  const listedChain = (kind: OrdinaryHeadKind): { shards: number | null; overlay: number | null } => {
    const doc = metaHandle?.doc() as Record<string, unknown> | undefined
    const length = (field: string) => (Array.isArray(doc?.[field]) ? (doc[field] as unknown[]).length : null)
    return kind === 'object'
      ? { shards: length('objectShardUrls'), overlay: length('editsObjectShardUrls') }
      : { shards: length('connectionShardUrls'), overlay: length('editsConnectionShardUrls') }
  }
  /** The fold-off chain alert (G4-16e step 3): logs once on the crossing.
   * Never throws: it runs on the rotation's success path. */
  const observeChainLength = (kind: OrdinaryHeadKind): void => {
    try {
      const listed = listedChain(kind)
      ordinaryRotationTelemetry.observeChain(key, kind, listed.overlay, ordinaryHeadRotation, listed.shards)
    } catch { /* telemetry only */ }
  }
  const rotationsInFlight = new Set<OrdinaryHeadKind>()
  const rotationRetries = new Map<OrdinaryHeadKind, {
    timer: ReturnType<typeof setTimeout> | null
    attempt: number
    /** The retry itself, so a fold that held the shared key can run it now. */
    fire?: () => void
  }>()
  /** A rotation waiting on its backoff runs NOW: called when a fold of the
   * kind lets go of the `overlay-rotation:` key it may have been refused on. */
  const kickRotationRetry = (kind: OrdinaryHeadKind): void => {
    const entry = rotationRetries.get(kind)
    if (!entry?.timer || !entry.fire) return
    clearTimeout(entry.timer)
    entry.fire()
  }
  cleanups.push(() => {
    for (const entry of rotationRetries.values()) if (entry.timer) clearTimeout(entry.timer)
    rotationRetries.clear()
  })
  const touchRotatedChild = (handle: DocHandle<unknown>): void => {
    if (residency && !leasedDocumentIds.has(handle.documentId)) {
      leasedDocumentIds.add(handle.documentId)
      residency.acquire(handle, residencyOwner, `${key.landscapeId}/${key.versionId}`)
    }
  }
  /**
   * A due head is not rotated mid-burst (`DEFAULT_ORDINARY_HEAD_ROTATION_QUIET_MS`,
   * `ordinaryHeadRotation.ts`, for the measurement): each pass of it while due
   * re-arms one timer per kind, which fires once its writes have been quiet
   * for `quietMs`, or `maxMs` after the head was first found due, so a head
   * written without pause is still rotated. On firing the head must still be
   * current and due, as for a retry. A rotation in flight or waiting on its
   * backoff is not deferred: it is already asked for.
   */
  const rotationDeferrals = new Map<OrdinaryHeadKind, {
    url: string
    firstAt: number
    resets: number
    timer: ReturnType<typeof setTimeout>
  }>()
  cleanups.push(() => {
    for (const entry of rotationDeferrals.values()) clearTimeout(entry.timer)
    rotationDeferrals.clear()
  })
  const requestRotation = (kind: OrdinaryHeadKind, handle: DocHandle<unknown>, url: string): void => {
    if (!headRotation.rotates || stopped || !metaHandle) return
    if (rotationsInFlight.has(kind) || rotationRetries.get(kind)?.timer) return
    const quietMs = ordinaryHeadRotation.deferral?.quietMs ?? DEFAULT_ORDINARY_HEAD_ROTATION_QUIET_MS
    const maxMs = ordinaryHeadRotation.deferral?.maxMs ?? DEFAULT_ORDINARY_HEAD_ROTATION_MAX_DEFER_MS
    if (quietMs <= 0) {
      startRotation(kind, handle, url)
      return
    }
    // Monotonic: a wall-clock step must not stretch or cut the cap.
    const now = performance.now()
    const prior = rotationDeferrals.get(kind)
    if (prior) clearTimeout(prior.timer)
    // A deferral armed for a head that is no longer this one starts over.
    const same = prior !== undefined && prior.url === url ? prior : undefined
    const firstAt = same ? same.firstAt : now
    const left = firstAt + maxMs - now
    const capped = left <= quietMs
    const meta = metaHandle
    const armed = {
      url,
      firstAt,
      resets: same ? same.resets + 1 : 0,
      timer: setTimeout(() => fire(), Math.max(0, Math.min(quietMs, left))),
    }
    const fire = (): void => {
      if (rotationDeferrals.get(kind) === armed) rotationDeferrals.delete(kind)
      if (stopped || !headRotation.rotates || !metaHandle) return
      // Nothing can be in flight or backing off here (requestRotation arms
      // neither alongside a deferral), so the line below names a rotation
      // startRotation does start.
      const latest = meta.doc() as MetaLike | undefined
      const current = kind === 'object' ? latest?.editsObjectShardUrl : latest?.editsConnectionShardUrl
      if (current !== url || !observeWriteHead(kind, url, handle.doc())) return
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_head_rotation_deferred',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        url,
        cause: capped ? 'max-wait' : 'quiet',
        waitedMs: Math.round(performance.now() - armed.firstAt),
        resets: armed.resets,
      }))
      startRotation(kind, handle, url)
    }
    armed.timer.unref?.()
    rotationDeferrals.set(kind, armed)
  }
  const startRotation = (kind: OrdinaryHeadKind, handle: DocHandle<unknown>, url: string): void => {
    if (!headRotation.rotates || stopped || !metaHandle) return
    if (rotationsInFlight.has(kind) || rotationRetries.get(kind)?.timer) return
    rotationsInFlight.add(kind)
    const meta = metaHandle
    const collection: 'objects' | 'connections' = kind === 'object' ? 'objects' : 'connections'
    const scheduleRetry = () => {
      if (stopped) return
      const attempt = (rotationRetries.get(kind)?.attempt ?? 0) + 1
      const delay = ROTATION_RETRY_DELAYS_MS[Math.min(attempt, ROTATION_RETRY_DELAYS_MS.length) - 1]
      const fire = () => {
        rotationRetries.set(kind, { timer: null, attempt })
        if (stopped) return
        const latest = meta.doc() as MetaLike | undefined
        const current = kind === 'object' ? latest?.editsObjectShardUrl : latest?.editsConnectionShardUrl
        // Straight to the rotator: the backoff already waited.
        if (current === url && observeWriteHead(kind, url, handle.doc())) startRotation(kind, handle, url)
      }
      const timer = setTimeout(fire, delay)
      timer.unref?.()
      rotationRetries.set(kind, { timer, attempt, fire })
    }
    void rotateOrdinaryHead({
      key,
      collection: kind,
      retired: { url, documentId: handle.documentId, doc: () => handle.doc() },
      meta: { documentId: meta.documentId, doc: () => meta.doc() as Record<string, unknown> | undefined },
      publishedHeads: () => publishedHeadsByDocument.get(handle.documentId) ?? null,
      mayWrite: () => !stopped && stillOwned(),
      assertAuthority: async () => {
        const held = await readWriteFence(db, key)
        if (held !== projectorInstanceId) throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
        if (await isStaticReadModelWorkspace(db, key)) throw new ReadModelPlaneError(key, 'ordinary')
      },
      connect: async () => {
        // A test that hands the projector one transaction-scoped client has no
        // second session to hold a session lock on: no rotation, loudly.
        if (!isPool(db)) throw new Error('ordinary head rotation needs a pool (a session-scoped advisory lock)')
        return db.connect()
      },
      createChild: async () => {
        const child = await createClaimedOverlaySegment(
          repo, collection, touchRotatedChild, { workspace: key, rootUrl, ownerPlacement: true },
        )
        return { url: child.url, documentId: child.documentId }
      },
      flush: (documentIds) => repo.flush(documentIds),
      assertTransactionAuthority: async (tx) => {
        await assertReadModelPlane(tx, key, 'ordinary')
        await assertReadModelWriteFence(tx, key, projectorInstanceId)
      },
      publish: (childUrl) => publishOverlaySegment(meta as DocHandle<OverlayMetaLike>, collection, childUrl),
    }).then((result) => {
      if (result.outcome === 'rotated') {
        rotationRetries.delete(kind)
        ordinaryRotationTelemetry.recordRotation(key, kind, headRotation.takeTrigger(url))
        observeChainLength(kind)
        // What arrived on the retired head after H_r and before the repoint
        // was projected directly or not at all; forwarding covers everything
        // after H_r, and its trigger is a change on the retired head that may
        // never come. Ask for it now.
        shardTriggers.get(handle.documentId)?.()
        // One more retired head: the chain may now be long enough to fold.
        requestFold(kind)
        return
      }
      if (result.outcome === 'lock-refused') scheduleRetry()
    }, (error: unknown) => {
      if (isReadModelAuthorityLoss(error)) {
        reportFenceLost(kind === 'object' ? 'object_shard' : 'connection_shard', error)
        return
      }
      console.error(JSON.stringify({
        event: 'read_model.ordinary_head_rotation_failed',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        url,
        error: error instanceof Error ? error.message : String(error),
      }))
      scheduleRetry()
    }).finally(() => {
      rotationsInFlight.delete(kind)
    })
  }

  /**
   * CHAIN FOLD (phase 4, `ordinaryChainFoldWriter.ts`), with
   * `AM_ORDINARY_CHAIN_FOLD=on` for a workspace rotation rotates. Asked for
   * after every rotation and once at attach; one per kind at a time. Another
   * fold is asked for right after one lands (a long chain converges a budget
   * at a time); a refused lock, a CAS conflict, a superseded or unpublishable
   * fold and a failure are retried on a capped backoff. A fold with nothing to
   * do waits for the next rotation.
   */
  const chainFold = headRotation.rotates ? ordinaryHeadRotation.chainFold : undefined
  const FOLD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 60_000]
  const foldsInFlight = new Set<OrdinaryHeadKind>()
  /** Kinds a SWEEP asked a pass of while one was in flight (G4-16d): that
   * pass may have read the hold, or the owed set, before they changed, and
   * `requestFold` drops a request made during a pass — so one more pass runs
   * when it ends (`requestSweepPass`). */
  const sweepPassPending = new Set<OrdinaryHeadKind>()
  /** Ask a fold pass of each kind for the row sweep — now, or right after the
   * pass in flight. A pending retry timer runs a fresh pass anyway. */
  const requestSweepPass = (): void => {
    if (!chainFold || stopped) return
    for (const kind of ['object', 'connection'] as const) {
      if (foldsInFlight.has(kind)) sweepPassPending.add(kind)
      else requestFold(kind)
    }
  }
  const foldRetries = new Map<OrdinaryHeadKind, { timer: ReturnType<typeof setTimeout> | null; attempt: number }>()
  cleanups.push(() => {
    for (const entry of foldRetries.values()) if (entry.timer) clearTimeout(entry.timer)
    foldRetries.clear()
  })
  const requestFold = (kind: OrdinaryHeadKind): void => {
    if (!chainFold || stopped || !metaHandle) return
    if (foldsInFlight.has(kind) || foldRetries.get(kind)?.timer) return
    foldsInFlight.add(kind)
    const meta = metaHandle as DocHandle<Record<string, unknown>>
    const collection: 'objects' | 'connections' = kind === 'object' ? 'objects' : 'connections'
    const scheduleRetry = () => {
      if (stopped) return
      const attempt = (foldRetries.get(kind)?.attempt ?? 0) + 1
      const delay = FOLD_RETRY_DELAYS_MS[Math.min(attempt, FOLD_RETRY_DELAYS_MS.length) - 1]
      const timer = setTimeout(() => {
        foldRetries.set(kind, { timer: null, attempt })
        requestFold(kind)
      }, delay)
      timer.unref?.()
      foldRetries.set(kind, { timer, attempt })
    }
    // A rotation in flight, waiting on its backoff or deferred to a quiet
    // moment goes FIRST: a fold holding the shared key would refuse it and
    // push its backoff out. The rotation asks for a fold once it lands.
    if (rotationsInFlight.has(kind) || rotationRetries.get(kind)?.timer || rotationDeferrals.has(kind)) {
      foldsInFlight.delete(kind)
      scheduleRetry()
      return
    }
    /** An orphan product (no row names it) keeps no residency lease. */
    const releaseProduct = (documentId: DocumentId): void => {
      if (residency && leasedDocumentIds.delete(documentId)) residency.release(documentId, residencyOwner)
    }
    let again = false
    const passStartedAt = Date.now()
    /** One line per pass, for the bench (G4-16b phase 4). `passMs` is the
     * whole pass (authority reads, the pool wait, the lock and after), so a
     * loose upper bound; the writer's `ordinary_chain_fold_lock_held` is the
     * lock itself. `chain` and `overlay` are ModelMeta's lists, what clients
     * load; `watched` is this projector's list, which follows ModelMeta
     * asynchronously (attach, then detach once settled). Never throws: a
     * failed log must not skip the retry below. */
    const logPass = (outcome: string, extra: Record<string, unknown> = {}): void => {
      try {
        const doc = meta.doc()
        const listed = (field: string) => (Array.isArray(doc?.[field]) ? (doc[field] as unknown[]).length : null)
        console.warn(JSON.stringify({
          event: 'read_model.ordinary_chain_fold_pass',
          workspace: `${key.landscapeId}/${key.versionId}`,
          kind,
          at: Date.now(),
          outcome,
          ...extra,
          passMs: Date.now() - passStartedAt,
          chain: listed(kind === 'object' ? 'objectShardUrls' : 'connectionShardUrls'),
          overlay: listed(kind === 'object' ? 'editsObjectShardUrls' : 'editsConnectionShardUrls'),
          watched: (kind === 'object' ? model.objectShardUrls : model.connectionShardUrls).length,
        }))
      } catch { /* the pass's outcome is handled below either way */ }
    }
    void foldOrdinaryChain({
      key,
      collection: kind,
      meta: {
        documentId: meta.documentId,
        doc: () => meta.doc(),
        change: (fn) => meta.change(fn),
      },
      minChain: chainFold.minChain,
      budget: chainFold.budget,
      retainMs: chainFold.retainMs,
      mayWrite: () => !stopped && stillOwned(),
      watched: (url) => (kind === 'object' ? model.objectShardUrls : model.connectionShardUrls).includes(url),
      // G4-16d: no fold row of a head owed a handover re-check goes — nor any,
      // before the re-check has run (`handoverSweepHold`).
      sweepKeep: () => {
        const announce = handoverSweepHold && !handoverSweepHoldLogged
        if (announce) handoverSweepHoldLogged = true
        return { hold: handoverSweepHold, announce, documentIds: handoverRecheck }
      },
      assertAuthority: async () => {
        const held = await readWriteFence(db, key)
        if (held !== projectorInstanceId) throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
        if (await isStaticReadModelWorkspace(db, key)) throw new ReadModelPlaneError(key, 'ordinary')
      },
      connect: async () => {
        if (!isPool(db)) throw new Error('ordinary chain fold needs a pool (a session-scoped advisory lock)')
        return db.connect()
      },
      assertTransactionAuthority: async (tx) => {
        await assertReadModelPlane(tx, key, 'ordinary')
        await assertReadModelWriteFence(tx, key, projectorInstanceId)
      },
      segment: async (url) => {
        const handle = await resolveHandle(url, 'fold-sample')
        return { documentId: handle.documentId, doc: () => handle.doc() }
      },
      createProduct: async (entities, fields) => {
        let built: DocumentId | null = null
        try {
          const product = await createClaimedOverlaySegment(
            repo, collection, (handle) => { built = handle.documentId; touchRotatedChild(handle) },
            { workspace: key, rootUrl, ownerPlacement: true },
            {
              entities, fields,
              // Stopped between two chunks: no more changes, no claim
              // (`OverlaySegmentAbortedError`). NOT `stillOwned()`: it is
              // process-local and flickers with the lease renewal (see
              // `runTracked`), and must never be a hard abort; the DATABASE's
              // answer is asked below and in the record's transaction.
              proceed: () => !stopped,
              // The write fence, read from the database once the product is
              // whole and flushed: a lost fence claims nothing (thrown as an
              // authority loss, reported like every other).
              beforeClaim: async () => {
                const held = await readWriteFence(db, key)
                if (held !== projectorInstanceId) throw new ReadModelWriteFenceError(key, projectorInstanceId, held)
              },
            },
          )
          return { url: product.url, documentId: product.documentId, doc: () => product.doc() }
        } catch (error) {
          // An unclaimed orphan nothing names, whatever stopped it: its lease
          // goes (after stop() `releaseOwner` took it already).
          if (built) releaseProduct(built)
          if (error instanceof OverlaySegmentAbortedError) return null
          throw error
        }
      },
      flush: (documentIds) => repo.flush(documentIds),
    }).then((result) => {
      logPass(result.outcome, {
        reason: 'reason' in result ? result.reason : undefined,
        state: 'state' in result ? result.state : undefined,
        stage: 'stage' in result ? result.stage : undefined,
      })
      if (result.outcome === 'folded') {
        foldRetries.delete(kind)
        again = true
        return
      }
      if (result.outcome === 'skipped' && result.reason !== 'sources-not-settled') {
        foldRetries.delete(kind)
        return
      }
      // `not-owner` is `mayWrite()`: `stillOwned()` is process-local and
      // flickers with the lease renewal, so it ends nothing here — retried on
      // the backoff while the projector runs. A REAL loss of the workspace
      // ends through the authority checks (`reportFenceLost`) and `stop()`.
      if (result.outcome === 'not-owner') {
        // From a FRESH attempt count: a flicker costs the first, short delay,
        // not the 30-60 s an attempt count carried over from the deferrals
        // behind a rotation would reach.
        foldRetries.delete(kind)
        if (!stopped) scheduleRetry()
        return
      }
      if (result.outcome === 'conflict' || result.outcome === 'superseded') releaseProduct(result.productDocumentId)
      scheduleRetry()
    }, (error: unknown) => {
      // Thrown after the product existed and before its record committed:
      // an orphan no row names, whose lease would otherwise stay for good —
      // one per failed retry.
      const unrecorded = unrecordedFoldProductOf(error)
      if (unrecorded) releaseProduct(unrecorded)
      if (isReadModelAuthorityLoss(error)) {
        logPass('authority-lost')
        reportFenceLost(kind === 'object' ? 'object_shard' : 'connection_shard', error)
        return
      }
      logPass('failed')
      console.error(JSON.stringify({
        event: 'read_model.ordinary_chain_fold_failed',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        error: error instanceof Error ? error.message : String(error),
      }))
      scheduleRetry()
    }).finally(() => {
      foldsInFlight.delete(kind)
      // A rotation refused while this fold held the key goes before the next fold.
      kickRotationRetry(kind)
      // `delete` first: a sweep asked during this pass gets its pass even
      // when the fold itself asks for another.
      const sweepAsked = sweepPassPending.delete(kind)
      if (again || sweepAsked) requestFold(kind)
    })
  }

  /**
   * LATE WRITES TO FOLDED HEADS (phase 4 step 4, `ordinaryFoldedArrivals.ts`).
   * A folded head is not watched: a poll of storage arrivals finds the ones a
   * client wrote into since their watermark, and each is forwarded through the
   * same path a watched retired head takes (`forwardInsteadOfProjecting`),
   * then its watermark advances. Started at attach when the workspace has a
   * folded row, and by the first detach; single-flight; one head's failure
   * does not stop the others, and its watermark stays, so the next poll tries
   * it again. A head loaded only for this gives its residency lease back.
   */
  const foldedArrivalPollMs = ordinaryFoldArrivalPollMs()
  let foldedArrivalTimer: ReturnType<typeof setInterval> | null = null
  let foldedArrivalPolling = false
  /** documentId -> when it may be tried again, and the delay that set it: a
   * head whose arrival could not be carried (a forward refused, degraded or
   * failed) backs off, doubling to ten minutes, instead of a full load every
   * period. Cleared when its watermark advances. */
  const foldedArrivalBackoff = new Map<string, { until: number; delay: number }>()
  const FOLDED_ARRIVAL_MAX_BACKOFF_MS = 600_000
  /** The watermark advance, fenced like every write of this closure: on
   * `projectionTail`, in a projection transaction that asserts the write
   * fence, after ownership is re-checked. A stale instance cannot move the
   * watermark the owner relies on. */
  const commitFoldedArrival = (hit: { collection: 'object' | 'connection'; documentId: string; watermark: string | null; arrivalSeq: string }) => {
    const task = projectionTail.then(() => withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
      if (stopped || !stillOwned()) return
      await advanceFoldedArrivalWatermark(tx, key, hit.collection, hit.documentId, hit.watermark, hit.arrivalSeq)
      await assertReadModelWriteFence(tx, key, projectorInstanceId)
    }))
    projectionTail = task.then(() => undefined, () => undefined)
    return task
  }
  /** Several advances from NULL in ONE transaction, fenced as above; the ids
   * whose CAS moved. */
  const commitDetachedWatermarks = (collection: 'object' | 'connection', hits: ReadonlyArray<{ documentId: string; arrivalSeq: string }>) => {
    const task = projectionTail.then(() => withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
      const moved = new Set<string>()
      if (stopped || !stillOwned()) return moved
      for (const hit of hits) {
        if (await advanceFoldedArrivalWatermark(tx, key, collection, hit.documentId, null, hit.arrivalSeq)) moved.add(hit.documentId)
      }
      await assertReadModelWriteFence(tx, key, projectorInstanceId)
      return moved
    }))
    projectionTail = task.then(() => undefined, () => undefined)
    return task
  }
  /**
   * THE DETACH SETS THE WATERMARK (G4-16, M3). A folded row is recorded with
   * a NULL `arrival_watermark`, and every content chunk is above NULL: the
   * first poll after the detach used to LOAD every source it had just
   * evicted — a full `Automerge.load` from storage per source, one
   * synchronous wasm call of 30–70 ms each on fleet-shaped heads (512
   * changes, 128 actors), eight in a row after every fold — only to forward
   * `nothing` and set the watermark to the arrival it read. The detach,
   * which still holds the resident, leased handles, sets that same watermark
   * itself, by the parking argument (`parkRetiredHead`, WHY NO LATE WRITE
   * IS LOST), for all the sources of one pass at once:
   *  1. the handles are FLUSHED, so what they hold has its chunks;
   *  2. S, each head's highest content arrival, is read;
   *  3. then its heads H are sampled, and H must be SETTLED: equal to the
   *     row's committed `forwarded_heads ?? H_r`, read fresh
   *     (`ordinaryHeadLateWritesPending`). Every change of a chunk at or
   *     below S was in the handle before S was read, so it is in H, so it
   *     has been forwarded. A change not in H entered the handle after the
   *     sample, so its chunk is saved with an arrival above S (CACHE 1
   *     sequence, `automergeStorage.ts`): the poll finds it;
   *  4. the watermark moves NULL -> S by the poll's fenced CAS, every head of
   *     the pass in one transaction (`commitDetachedWatermarks`), only where
   *     NULL is what the row holds;
   *  5. flushed again, so a change after H has its chunk (above S) before
   *     the eviction removes the save listener; the caller then releases
   *     the leases synchronously.
   * A head OWED THE HANDOVER RE-CHECK gets none (asked when the heads are
   * sampled and again just before the CAS is queued on `projectionTail`):
   * an old owner's save may sit in storage below S with nothing in the
   * handle to show it — the same single-writer break the re-check exists
   * for — and a NULL watermark keeps the poll's load, which reads storage
   * afresh. It is still FLUSHED, both times, like every resident source of
   * the pass: what its handle holds must have its chunk before the eviction.
   * Anything else — not resident, nothing stored, not settled, the CAS
   * refused, any failure — gets no watermark either and is left to the poll
   * exactly as before: the load this saves is an optimisation, never what
   * carries a write. A lost fence is reported.
   */
  const watermarkDetachedFoldSources = async (kind: 'object' | 'connection', documentIds: readonly string[]): Promise<Map<string, string>> => {
    const set = new Map<string, string>()
    if (!documentIds.length) return set
    const handles = new Map<string, DocHandle<unknown>>()
    for (const documentId of documentIds) {
      const handle = syncedHandle(repo, documentId)
      if (handle && handle.state === 'ready') handles.set(documentId, handle)
    }
    if (!handles.size) return set
    const ids = [...handles.keys()] as DocumentId[]
    const failed = (error: unknown) => {
      if (isReadModelAuthorityLoss(error)) {
        reportFenceLost(kind === 'object' ? 'object_shard' : 'connection_shard', error)
        return
      }
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_fold_source_watermark_failed',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        documentIds,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    try {
      await repo.flush(ids)
      if (stopped || foldedArrivalPollMs <= 0) return set
      const arrivals = await documentContentArrivals(db, ids)
      if (stopped) return set
      const sampled: Array<{ documentId: string; heads: string[]; current: false; arrival: string }> = []
      for (const documentId of ids) {
        if (handoverRecheck.has(documentId)) continue
        const arrival = arrivals.get(documentId) ?? null
        const heads = tryGetHeads(handles.get(documentId)!.doc())
        if (arrival !== null && heads) sampled.push({ documentId, heads: [...heads], current: false, arrival })
      }
      if (!sampled.length) return set
      const pending = new Set(await ordinaryHeadLateWritesPending(db, key, kind, sampled))
      const settled = sampled.filter((head) => !pending.has(head.documentId) && !handoverRecheck.has(head.documentId))
      if (!settled.length || stopped || !stillOwned()) return set
      const moved = await commitDetachedWatermarks(kind,
        settled.map((head) => ({ documentId: head.documentId, arrivalSeq: head.arrival })))
      for (const head of settled) {
        if (!moved.has(head.documentId)) continue
        detachedWatermarks.set(head.documentId, head.arrival)
        set.set(head.documentId, head.arrival)
      }
      return set
    } catch (error) {
      failed(error)
      return set
    } finally {
      // Whatever happened above: a change after the sample has its chunk
      // (above S) before the caller's synchronous release.
      try { await repo.flush(ids) } catch (error) { failed(error) }
    }
  }
  /** documentId -> the watermark a detach committed (above). A poll whose
   * query read the row BEFORE that commit returns it with the older NULL and
   * would load the head for nothing; the poll applies this floor to such a
   * hit. Only a poll whose query started after the commit can drop it, which
   * the next poll does: one entry per detach, for at most one poll. */
  const detachedWatermarks = new Map<string, string>()
  cleanups.push(() => {
    if (foldedArrivalTimer) clearInterval(foldedArrivalTimer)
    foldedArrivalTimer = null
  })
  /** The poll's cost (the query and the forwards it ran), logged every
   * FOLDED_ARRIVAL_SUMMARY_POLLS polls that ran (about five minutes at the
   * default period; a poll skipped while one is in flight is not counted),
   * and the remainder at stop, for the bench (G4-16b phase 4). `rows` is what
   * the query returned; `loaded` the heads it then loaded to forward.
   * `expiredRows` the rows among them past `retain_until` (GC keeps such a
   * head only for its uncarried arrival, `gc.ts`), `expiredCarried` those
   * whose watermark this projector then advanced (G4-16c). `recheckRows`
   * the rows listed only for the handover re-check (G4-16d), included in
   * `rows`, not in `expiredRows`. */
  const FOLDED_ARRIVAL_SUMMARY_POLLS = 60
  const emptyFoldedArrivalCost = () => ({ polls: 0, totalMs: 0, maxMs: 0, rows: 0, loaded: 0, expiredRows: 0, expiredCarried: 0, recheckRows: 0 })
  const foldedArrivalCost = emptyFoldedArrivalCost()
  const logFoldedArrivalCost = (): void => {
    if (!foldedArrivalCost.polls) return
    console.warn(JSON.stringify({
      event: 'read_model.ordinary_fold_arrival_poll_summary',
      workspace: `${key.landscapeId}/${key.versionId}`,
      at: Date.now(),
      ...foldedArrivalCost,
    }))
    Object.assign(foldedArrivalCost, emptyFoldedArrivalCost())
  }
  cleanups.push(logFoldedArrivalCost)

  /**
   * THE HANDOVER RE-CHECK (G4-16d; the why, the invariants and the rejected
   * alternatives are in `ordinaryFoldedArrivals.ts`, THE HANDOVER RESIDUAL).
   * `handoverRecheckMs` (plus jitter) after attach, and once THE BARRIER is
   * clear, every retired head of the workspace and both current write heads
   * are owed ONE re-check from storage: the document ids land here, and the
   * poll drains them, `HANDOVER_RECHECK_PER_POLL` a pass — a folded head
   * through the folded loop, a parked one through `pollParkedRetiredHeads`, a
   * still-watched one (current heads included) by a merge its own watcher then
   * forwards or projects. An id leaves on a forward that happened (as a
   * watermark advance does), when no such head exists any more, or after
   * `HANDOVER_RECHECK_MAX_ATTEMPTS` failures; a failure otherwise keeps it,
   * behind the same backoff as an arrival.
   */
  const handoverRecheckMs = ordinaryHandoverRecheckMs()
  const handoverRecheck = new Set<string>()
  /** documentId -> failed re-checks so far. */
  const handoverRecheckFailures = new Map<string, number>()
  let handoverRecheckTimer: ReturnType<typeof setTimeout> | null = null
  /** The database's clock when the attach ended (after the new fence), or
   * null if it could not be read: the barrier then reads the clock when it
   * starts, later, which only makes it wait for more. */
  let attachClock: Promise<string | null> | null = null
  /** True from the arm until the LAST owing of this attach (the follow-up
   * after a barrier timeout included): the fold's row sweep is held
   * meanwhile (`sweepKeep`). A late save of a previous owner sits below a
   * folded head's watermark, where nothing but this re-check can find it,
   * and only from the head's row: a row swept before the re-check ran would
   * take the write with it. */
  let handoverSweepHold = true
  /** The held line is logged once per hold, not on every fold pass. */
  let handoverSweepHoldLogged = false
  /** Release the hold, and run the fold pass (and so the sweep) it deferred. */
  const releaseHandoverSweepHold = (): void => {
    if (!handoverSweepHold) return
    handoverSweepHold = false
    handoverSweepHoldLogged = false
    requestSweepPass()
  }
  cleanups.push(() => {
    if (handoverRecheckTimer) clearTimeout(handoverRecheckTimer)
    handoverRecheckTimer = null
    handoverRecheck.clear()
  })
  /** Merge every content chunk storage holds for the head into `handle`: a
   * handle this Repo loaded before another process's save committed never
   * sees that save otherwise. Decoded apart first, so a malformed chunk
   * throws before the handle is touched; a no-op when nothing is missing.
   * Returns the highest arrival among the chunks merged, null when none was. */
  const mergeDurableContent = (handle: DocHandle<unknown>): Promise<string | null> => withHandoverRecheckPermit(async () => {
    const { chunks, maxSeq } = await documentContentChunks(db, handle.documentId)
    if (!chunks.length || stopped) return null
    const durable = chunks.reduce((doc, chunk) => loadIncremental(doc, chunk), initDoc<unknown>())
    handle.update((doc) => mergeDocs(doc as Doc<unknown>, durable))
    return maxSeq
  })
  /** One poll pass's re-check context: its budget, and "was this head in the
   * Repo's cache, i.e. would a load NOT re-read storage?" from ONE copy of
   * the cache taken the first time the pass asks (`cachedHandles`, O(resident
   * documents): once a pass, not once a head — `automergeRepoCompat.ts`).
   * The cache itself, not `syncedHandle`: a false "absent" would skip an owed
   * merge. A copy taken at the pass is enough: it is taken after the barrier,
   * so a head absent from it and loaded later reads storage after every old
   * save; a head present and evicted since is merged into a fresh load, a
   * no-op. */
  interface RecheckPass { left: number; resident: (documentId: string) => boolean }
  const recheckPass = (): RecheckPass => {
    let resident: Set<string> | null = null
    return {
      left: HANDOVER_RECHECK_PER_POLL,
      resident: (documentId) => (resident ??= new Set(Object.keys(cachedHandles(repo)))).has(documentId),
    }
  }
  /** An owed head's re-check did not complete: count it, give up at the cap. */
  const handoverRecheckFailed = (documentId: string): void => {
    if (!handoverRecheck.has(documentId)) return
    const failures = (handoverRecheckFailures.get(documentId) ?? 0) + 1
    if (failures < HANDOVER_RECHECK_MAX_ATTEMPTS) {
      handoverRecheckFailures.set(documentId, failures)
      return
    }
    handoverRecheck.delete(documentId)
    handoverRecheckFailures.delete(documentId)
    noteHandoverRecheckAbandoned()
    console.error(JSON.stringify({
      event: 'read_model.ordinary_handover_recheck_abandoned',
      workspace: `${key.landscapeId}/${key.versionId}`,
      documentId,
      failures,
    }))
  }
  const handoverRecheckDone = (documentId: string): void => {
    handoverRecheck.delete(documentId)
    handoverRecheckFailures.delete(documentId)
  }
  const handoverBarrierMaxWaitMs = ordinaryHandoverBarrierMaxWaitMs()
  /** THE BARRIER: 'clear' once no storage-write backend of another process
   * still runs a transaction older than the attach; 'timeout' after
   * `handoverBarrierMaxWaitMs` (logged and counted); 'stopped' on stop. Says
   * so every `HANDOVER_BARRIER_WARN_MS` it waits (`ordinaryFoldedArrivals.ts`,
   * THE BARRIER CANNOT STAY BLOCKED). */
  const handoverBarrier = async (): Promise<'clear' | 'timeout' | 'stopped'> => {
    const since = (await attachClock) ?? await databaseNow(db)
    const startedAt = Date.now()
    let warnings = 0
    for (;;) {
      if (stopped) return 'stopped'
      const blockers = await handoverBarrierBlockers(db, since, storageWriteApplication)
      if (!blockers.pids.length) return 'clear'
      const waited = Date.now() - startedAt
      const detail = {
        workspace: `${key.landscapeId}/${key.versionId}`,
        waitedMs: waited,
        since,
        blockers: blockers.pids.length,
        oldestXactStart: blockers.oldest,
      }
      if (waited >= handoverBarrierMaxWaitMs) {
        noteHandoverBarrierTimeout()
        console.error(JSON.stringify({ event: 'read_model.ordinary_handover_recheck_barrier_timeout', ...detail }))
        return 'timeout'
      }
      if (waited >= (warnings + 1) * HANDOVER_BARRIER_WARN_MS) {
        warnings = Math.floor(waited / HANDOVER_BARRIER_WARN_MS)
        console.warn(JSON.stringify({ event: 'read_model.ordinary_handover_recheck_barrier_waiting', ...detail }))
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, foldedArrivalPollMs).unref?.() })
    }
  }
  /** Fill the owed set: every retirement row read FRESH, every parked head,
   * both current write heads. */
  const oweHandoverRecheck = async (reason: string): Promise<void> => {
    // Read fresh, not from the cache: a head this projector folded or
    // retired since attach is owed the re-check too. An `admitted` row can
    // name the current head: merged on purpose, as the current heads are.
    const rows = await loadOrdinaryHeadRetirements(db, key)
    if (stopped) return
    for (const row of rows.values()) handoverRecheck.add(row.documentId)
    for (const entry of parkedRetiredHeads.values()) handoverRecheck.add(entry.documentId)
    // The current write heads have the same residual (a handle loaded before
    // the old save committed); one read each.
    const meta = metaHandle?.doc() as MetaLike | undefined
    for (const url of [meta?.editsObjectShardUrl, meta?.editsConnectionShardUrl]) {
      if (url) handoverRecheck.add(parseAutomergeUrl(url as AutomergeUrl).documentId)
    }
    console.log(JSON.stringify({
      event: 'read_model.ordinary_handover_recheck',
      workspace: `${key.landscapeId}/${key.versionId}`,
      reason,
      heads: handoverRecheck.size,
      retirements: rows.size,
      afterMs: handoverRecheckMs,
    }))
    if (handoverRecheck.size) startFoldedArrivalPoll()
  }
  /** Arm the re-check once per attach. Only where retired heads can exist:
   * a workspace that rotates, or holds retirement rows from an earlier life. */
  const armHandoverRecheck = (): void => {
    if (stopped || handoverRecheckTimer) return
    // Nothing to re-check (the poll or the re-check off, nothing that can
    // hold a retired head): the hold, on since the attach began, goes.
    if (foldedArrivalPollMs <= 0 || handoverRecheckMs <= 0 || (!headRotation.rotates && !chainFold && !retirements.size)) {
      releaseHandoverSweepHold()
      return
    }
    attachClock ??= databaseNow(db).catch(() => null)
    handoverSweepHold = true
    handoverRecheckTimer = setTimeout(() => {
      handoverRecheckTimer = null
      void (async () => {
        if (stopped || !stillOwned()) return
        try {
          const barrier = await handoverBarrier()
          if (barrier === 'stopped' || stopped) return
          await oweHandoverRecheck(barrier === 'clear' ? 'barrier-clear' : 'barrier-timeout')
          if (barrier === 'timeout') {
            // An old save may still commit: ONE more re-check, when the
            // barrier clears or after one more maximum wait.
            const again = await handoverBarrier()
            if (again === 'stopped' || stopped) return
            await oweHandoverRecheck(again === 'clear' ? 'follow-up' : 'follow-up-timeout')
          }
          // Owed from here on: the sweep keeps exactly those rows.
          releaseHandoverSweepHold()
        } catch (error) {
          console.error(JSON.stringify({
            event: 'read_model.ordinary_handover_recheck_failed',
            workspace: `${key.landscapeId}/${key.versionId}`,
            error: error instanceof Error ? error.message : String(error),
          }))
          armHandoverRecheck()
        }
      })()
    }, handoverRecheckDelay(handoverRecheckMs))
    handoverRecheckTimer.unref?.()
  }
  /** Still-watched heads owed the re-check: the merge only; a change it
   * brings is forwarded (retired head) or projected (current head) by the
   * head's own watcher, as any write is. Left owed while the head is being
   * folded or parked, or backing off. */
  const recheckWatchedRetiredHeads = async (budget: RecheckPass): Promise<void> => {
    for (const [url, entry] of [...shardStops]) {
      if (stopped || !stillOwned() || budget.left <= 0) return
      if (!handoverRecheck.has(entry.documentId)) continue
      if (foldSourcesDetaching.has(url) || retiredHeadsParking.has(url) || shardStops.get(url) !== entry) continue
      const backoff = foldedArrivalBackoff.get(entry.documentId)
      if (backoff && Date.now() < backoff.until) continue
      budget.left -= 1
      // Read before the merge: a head detached during it is in neither list
      // after. A watched head in neither list (being attached) is named by
      // its retirement row's collection, objects when it has none.
      const shardKind: ProjectionKind = model.objectShardUrls.includes(url) ? 'object_shard'
        : model.connectionShardUrls.includes(url) || retirements.has(retirementKey('connection', entry.documentId))
          ? 'connection_shard' : 'object_shard'
      try {
        await mergeDurableContent(await resolveHandle(url, 'handover-recheck'))
        // Detached (folded) or parked DURING the merge: its watcher, which
        // would have carried what the merge brought, was stopped first, and
        // the handle may already be evicted — merged into, it carries nothing.
        // Still owed: the folded or parked path re-checks it from storage.
        if (shardStops.get(url) !== entry) continue
        handoverRecheckDone(entry.documentId)
        foldedArrivalBackoff.delete(entry.documentId)
      } catch (error) {
        if (isReadModelAuthorityLoss(error)) {
          reportFenceLost(shardKind, error)
          return
        }
        const delay = Math.min(FOLDED_ARRIVAL_MAX_BACKOFF_MS, Math.max(foldedArrivalPollMs, (backoff?.delay ?? 0) * 2))
        foldedArrivalBackoff.set(entry.documentId, { until: Date.now() + delay, delay })
        handoverRecheckFailed(entry.documentId)
        console.error(JSON.stringify({
          event: 'read_model.ordinary_handover_recheck_failed',
          workspace: `${key.landscapeId}/${key.versionId}`,
          documentId: entry.documentId,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
  }
  /** The document ids some path of this projector answers for now: watched,
   * parked, or on its way between two of those. */
  const headsKnownNow = (): Set<string> => {
    const known = new Set<string>()
    for (const entry of shardStops.values()) known.add(entry.documentId)
    for (const entry of parkedRetiredHeads.values()) known.add(entry.documentId)
    for (const url of [...foldSourcesDetaching, ...retiredHeadsParking]) {
      known.add(parseAutomergeUrl(url as AutomergeUrl).documentId)
    }
    return known
  }
  /** Drop owed ids no head answers to any more. Only ids owed when the pass
   * STARTED (so sent to the folded query), not returned by it, and known to
   * no path at the start AND at the end of the pass: an id owed mid-pass
   * (the timer fired meanwhile) was never asked about, and a head that moved
   * between paths mid-pass (a fold that completed) was known at one end. */
  const forgetUnknownHandoverRechecks = (
    owedAtStart: ReadonlySet<string>,
    knownAtStart: ReadonlySet<string>,
    foldedIds: ReadonlySet<string>,
  ): void => {
    if (!owedAtStart.size) return
    const knownAtEnd = headsKnownNow()
    for (const id of owedAtStart) {
      if (!handoverRecheck.has(id) || foldedIds.has(id) || knownAtStart.has(id) || knownAtEnd.has(id)) continue
      handoverRecheckDone(id)
    }
  }

  /**
   * PARKED RETIRED HEADS (chain fold OFF, `ordinaryRetiredHeadParkMs`). With
   * the fold off nothing ever unlists a retired head, and its watcher's lease
   * kept it resident until `stop()`: one document per rotation, for the life
   * of the projector (`ordinaryHeadResidency.integration.test.ts`). A head
   * that has been forwarded for `retiredHeadParkMs` and owes nothing — its
   * live heads equal its committed `forwarded_heads ?? H_r` — is PARKED: still
   * listed (and still in `model.*ShardUrls`, so no attach pass re-watches it),
   * no longer watched, its lease given back. Its late writes are found in
   * storage by the folded-head poll (`pollParkedRetiredHeads`), against the
   * arrival read while it was still watched.
   *
   * WHY NO LATE WRITE IS LOST. `parkRetiredHead` reads the head's highest
   * content arrival S, THEN samples its heads H, THEN checks H is settled. A
   * change in H was forwarded already. A change not in H entered the handle
   * after the sample, so after S was read; its chunk is saved after it is in
   * the handle, with a `nextval` (`automergeStorage.ts`) issued after S was
   * returned, so above S: the poll finds it. That step holds because
   * `automerge_arrival_seq` has the default CACHE 1 (`db.ts`, `CREATE
   * SEQUENCE IF NOT EXISTS automerge_arrival_seq`): with a per-session cache
   * one session can be handed a value BELOW one another session has already
   * committed, and the argument would not survive it. Before the lease goes back the
   * head is FLUSHED, so a change still in the handle (saves are debounced) has
   * its chunk before eviction removes the handle's save listener
   * (`automergeResidency.ts`, `evict`). The ownership handover breaks the
   * single-writer step as it does for folded heads — the old owner's save
   * can commit below S, or below the poll's later watermark — and is covered
   * the same way, by the handover re-check (`ordinaryFoldedArrivals.ts`, THE
   * HANDOVER RESIDUAL; `armHandoverRecheck` here), behind the same barrier;
   * and a projector that stops forgets its parked set, but the next attach
   * watches every listed head again and forwards from `forwarded_heads`.
   *
   * Never with the fold ON: a fold refuses sources that are not watched
   * (`ORDINARY_FOLD_SOURCES_NOT_WATCHED`), and gives the lease back itself.
   *
   * WHEN: the sweep runs every `retiredHeadParkMs` and parks a head on the
   * first sweep that STARTS at least that long after the sweep that first
   * found it forwarded — so between one and two periods after its rotation
   * (10 to 20 minutes at the default), plus however long it takes to settle.
   *
   * AFTER STOP: every await that can load or lease is followed by a release
   * when `stopped` turned true meanwhile — `stop()`'s `releaseOwner` has run
   * by then, so a lease taken after it would be nobody's to give back.
   */
  const retiredHeadParkMs = ordinaryRetiredHeadParkMs()
  const parksRetiredHeads = !chainFold && headRotation.rotates && Boolean(residency)
    && foldedArrivalPollMs > 0 && retiredHeadParkMs > 0
  /** Heads whose park has begun and not finished: the poll leaves them alone. */
  const retiredHeadsParking = new Set<string>()
  /** url -> when a park sweep first found it forwarded (monotonic ms). */
  const forwardedSince = new Map<string, number>()
  /** Drop this projector's lease on `documentId`, idempotent. */
  const dropLease = (documentId: string): void => {
    if (residency && leasedDocumentIds.delete(documentId)) residency.release(documentId as DocumentId, residencyOwner)
  }
  /** How many times a park or a release has waited on the stamp keyed by a head. */
  const stampWaits = new Map<string, number>()
  /**
   * A stamp keyed BY `documentId` is pending: should a park, or a parked
   * head's release, wait for it? Yes — and its target is asked to project —
   * while that target is the CURRENT write head of the kind (the projection
   * that consumes stamps) and fewer than `PARKED_STAMP_MAX_WAITS` waits have
   * passed. Otherwise the stamp is DROPPED and nothing waits: a target that is
   * itself forwarded (its forward answering `nothing` re-keys nothing) would
   * otherwise hold the head resident, and re-trigger a projection, for ever.
   * A dropped stamp leaves the head's watermark refused — the safe direction,
   * and what an unconsumed stamp left before parking existed.
   */
  const waitForStamp = (kind: 'object' | 'connection', documentId: string): boolean => {
    const stamp = retiredHeadStamps.get(documentId)
    if (!stamp) {
      stampWaits.delete(documentId)
      return false
    }
    const meta = metaHandle?.doc() as MetaLike | undefined
    const currentUrl = kind === 'object' ? meta?.editsObjectShardUrl : meta?.editsConnectionShardUrl
    const targetProjects = Boolean(currentUrl) && shardStops.get(currentUrl!)?.documentId === stamp.target
    const waits = stampWaits.get(documentId) ?? 0
    if (parkedStampWait(waits, targetProjects) === 'drop') {
      retiredHeadStamps.delete(documentId)
      stampWaits.delete(documentId)
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_parked_head_stamp_dropped',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        documentId,
        target: stamp.target,
        reason: targetProjects ? 'max-waits' : 'target-not-current',
      }))
      return false
    }
    stampWaits.set(documentId, waits + 1)
    shardTriggers.get(stamp.target)?.()
    return true
  }
  /** Give a parked head's lease back, durable first. Only between polls: the
   * poll holds the lease across a forward that reads the handle, and an
   * eviction under it would replace the document with an empty one.
   * After `stop()`: released at once, unflushed, as `releaseOwner` does. */
  const releaseParkedLease = async (url: string): Promise<void> => {
    const entry = parkedRetiredHeads.get(url)
    if (!entry || !residency || !leasedDocumentIds.has(entry.documentId)) return
    if (stopped) { dropLease(entry.documentId); return }
    // A stamp keyed BY this head is consumed by its target's projection, which
    // re-reads THIS handle (`liveHeadsForStamp`): evicted first, it certifies
    // 0. Kept resident until then — ask for that projection — and the poll's
    // no-arrival branch tries the release again.
    // A stamp TAKEN by a pass in flight counts the same.
    if (stampsInFlight.has(entry.documentId) || waitForStamp(entry.kind, entry.documentId)) return
    await repo.flush([entry.documentId as DocumentId])
    // Synchronous from here to the eviction `release` starts: no change can
    // land between the flush and the removal of the save listener.
    if (parkedRetiredHeads.get(url) !== entry) return
    dropLease(entry.documentId)
  }
  /** A parked head that is no longer forwarded (no row asks for it, or it is
   * the current head again) is projected directly, by a watcher, as at attach.
   * Unreachable with the fold off as far as this tree goes — only a fold
   * deletes a row (`ordinaryChainFold.ts`), and a retired url never becomes
   * current again — and imperfect: the initial apply upserts, so an entity
   * removed from the head while it was parked keeps its row until a cold
   * build. */
  const unparkRetiredHead = async (url: string): Promise<void> => {
    const entry = parkedRetiredHeads.get(url)
    if (!entry || stopped) return
    parkedRetiredHeads.delete(url)
    console.warn(JSON.stringify({
      event: 'read_model.ordinary_retired_head_unparked',
      workspace: `${key.landscapeId}/${key.versionId}`,
      kind: entry.kind,
      url,
    }))
    try {
      if (entry.kind === 'object') await watchObjectShard(url, true)
      else await watchConnectionShard(url, true)
    } catch (error) {
      // Not watched (the watcher registers last and synchronously): parked
      // again, so the next arrival retries this.
      if (!shardStops.has(url)) parkedRetiredHeads.set(url, entry)
      throw error
    }
    if (stopped) {
      // `cleanups` ran before this watcher existed: stop it, and its lease.
      shardStops.get(url)?.stop()
      shardStops.delete(url)
      dropLease(entry.documentId)
    }
  }
  /** One read for every parked head; for each with an arrival above its
   * watermark, the ordinary forward, then the watermark — only on a forward
   * that HAPPENED, as for a folded head. */
  const pollParkedRetiredHeads = async (budget: RecheckPass): Promise<void> => {
    const parked = [...parkedRetiredHeads.entries()].filter(([url]) => !retiredHeadsParking.has(url))
    if (!parked.length) return
    const arrivals = await documentContentArrivals(db, parked.map(([, entry]) => entry.documentId))
    for (const [url, entry] of parked) {
      if (stopped || !stillOwned()) return
      if (parkedRetiredHeads.get(url) !== entry) continue
      const seq = arrivals.get(entry.documentId) ?? null
      // Owed the handover re-check (and within this pass's budget): loaded
      // whatever its watermark. Over budget, it stays owed for the next pass.
      const rechecking = handoverRecheck.has(entry.documentId) && budget.left > 0
      if (!rechecking && !arrivalAbove(seq, entry.watermark)) {
        // A release that failed earlier (its flush) is retried here.
        if (leasedDocumentIds.has(entry.documentId)) {
          try {
            await releaseParkedLease(url)
          } catch (error) {
            // Still leased and resident; the next poll tries again.
            console.error(JSON.stringify({
              event: 'read_model.ordinary_parked_head_release_failed',
              workspace: `${key.landscapeId}/${key.versionId}`,
              collection: entry.kind,
              documentId: entry.documentId,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        }
        continue
      }
      const backoff = foldedArrivalBackoff.get(entry.documentId)
      if (backoff && Date.now() < backoff.until) continue
      const backOff = () => {
        const delay = Math.min(FOLDED_ARRIVAL_MAX_BACKOFF_MS, Math.max(foldedArrivalPollMs, (backoff?.delay ?? 0) * 2))
        foldedArrivalBackoff.set(entry.documentId, { until: Date.now() + delay, delay })
        if (rechecking) handoverRecheckFailed(entry.documentId)
      }
      if (rechecking) budget.left -= 1
      // A handle loaded by `resolveHandle` below reflects storage already; one
      // resident before may predate an old owner's save.
      const residentBefore = rechecking && budget.resident(entry.documentId)
      foldedArrivalCost.loaded += 1
      try {
        const handle = await resolveHandle(url, 'parked-arrival')
        // A stop during that load: its `releaseOwner` has run, and the lease
        // `resolveHandle` just took would be nobody's to give back.
        if (stopped) {
          dropLease(entry.documentId)
          return
        }
        try {
          // The handover re-check: what storage holds, into the handle.
          const durableSeq = residentBefore ? await mergeDurableContent(handle) : null
          // Read from the live document while it is loaded: the forward's own
          // `servedOutsideCurrentHead` reads this head too.
          if (parkedRetiredHeads.get(url) === entry) entry.snapshot = parkedSnapshotOf(entry.kind, handle.doc())
          let outcome: string | undefined
          const forwarded = await forwardInsteadOfProjecting(entry.kind, handle, url, (answer) => { outcome = answer })
          if (parkedRetiredHeads.get(url) === entry) entry.snapshot = parkedSnapshotOf(entry.kind, handle.doc())
          if (!forwarded) {
            // Watched again from here; the merge above already happened.
            if (rechecking) handoverRecheckDone(entry.documentId)
            await unparkRetiredHead(url)
          } else if ((outcome === 'forwarded' || outcome === 'superseded' || outcome === 'nothing')
            && !forwardDegradedUrls.has(url)) {
            // The handle loaded (or resident) holds every arrival up to `seq`
            // (`ordinaryFoldedArrivals.ts`, WHY THAT ADVANCE SKIPS NOTHING),
            // and after a re-check every chunk it read. Never lowered.
            const next = laterArrival(seq, durableSeq)
            if (parkedRetiredHeads.get(url) === entry && arrivalAbove(next, entry.watermark)) entry.watermark = next
            foldedArrivalBackoff.delete(entry.documentId)
            if (rechecking) handoverRecheckDone(entry.documentId)
          } else {
            backOff()
          }
        } finally {
          await releaseParkedLease(url)
        }
      } catch (error) {
        if (isReadModelAuthorityLoss(error)) {
          reportFenceLost(entry.kind === 'object' ? 'object_shard' : 'connection_shard', error)
          return
        }
        backOff()
        console.error(JSON.stringify({
          event: 'read_model.ordinary_parked_head_arrival_failed',
          workspace: `${key.landscapeId}/${key.versionId}`,
          collection: entry.kind,
          documentId: entry.documentId,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
  }
  /**
   * Park one watched, forwarded, settled head. Every await between deciding
   * and handing the head to the poll, and what a throw there leaves:
   *   1. `resolveHandle` — the resident handle, already leased: nothing moved;
   *   2. `documentContentArrivals` (S) — nothing moved;
   *   3. `ordinaryHeadLateWritesPending` — nothing moved; pending: not parked.
   * Then, SYNCHRONOUSLY with the re-checks: out of `shardStops`, into
   * `parkedRetiredHeads` (from here the poll covers it), watcher stopped.
   *   4. `entry.idle()` — the pass in flight finishes (it may forward); it
   *      does not reject (`coalescedProjection`), and is caught regardless;
   *   5. `repo.flush` in `releaseParkedLease` — throws: the head stays parked
   *      AND leased (resident, its Repo save listener intact, so the change is
   *      saved and the poll finds it), and the poll retries the release. The
   *      same retry covers a release deferred for a stamp the pass in 4 left.
   * A stop during 1–3 returns at the re-check (the lease was taken before
   * and `releaseOwner` gave it back); during 4–5, `releaseParkedLease`
   * releases without a flush.
   */
  const parkRetiredHead = async (kind: 'object' | 'connection', url: string): Promise<boolean> => {
    const entry = shardStops.get(url)
    if (!entry || parkedRetiredHeads.has(url) || retiredHeadsParking.has(url)) return false
    const documentId = entry.documentId
    const owesNothing = () => !degradedShards.has(url) && !forwardRetries.has(documentId)
      // A stamp keyed BY this head — waiting, or TAKEN by a target's pass in
      // flight — is consumed by a projection that re-reads this handle
      // (`liveHeadsForStamp`): evicted, it certifies 0.
      && !retiredHeadStamps.has(documentId) && !stampsInFlight.has(documentId)
      // Owed the handover re-check: an old owner's save may be in storage and
      // not in this handle. Merged while watched, its watcher carries it; a
      // park meanwhile would stop that watcher and evict the handle under the
      // merge (G4-16 M3 review). Parked on a later sweep, once re-checked.
      && !handoverRecheck.has(documentId)
    if (waitForStamp(kind, documentId) || !owesNothing()) return false
    retiredHeadsParking.add(url)
    let parked = false
    try {
      const handle = await resolveHandle(url, 'park')
      const watermark = (await documentContentArrivals(db, [documentId])).get(documentId) ?? null
      const heads = tryGetHeads(handle.doc())
      if (!heads) return false
      const pending = await ordinaryHeadLateWritesPending(db, key, kind, [{ documentId, heads: [...heads], current: false }])
      if (pending.length) return false
      if (stopped || shardStops.get(url) !== entry || !isForwardedHead(kind, documentId, url) || !owesNothing()) return false
      shardStops.delete(url)
      parkedRetiredHeads.set(url, { kind, documentId, watermark, snapshot: parkedSnapshotOf(kind, handle.doc()) })
      parked = true
      entry.stop()
      try { await entry.idle() } catch { /* the pass's own handling ran */ }
      await releaseParkedLease(url)
      console.log(JSON.stringify({
        event: 'read_model.ordinary_retired_head_parked',
        workspace: `${key.landscapeId}/${key.versionId}`,
        kind,
        url,
        watermark,
      }))
      return true
    } finally {
      retiredHeadsParking.delete(url)
      forwardedSince.delete(url)
      if (parked) startFoldedArrivalPoll()
    }
  }
  let parkSweepTimer: ReturnType<typeof setInterval> | null = null
  let parkSweeping = false
  cleanups.push(() => {
    if (parkSweepTimer) clearInterval(parkSweepTimer)
    parkSweepTimer = null
  })
  /** Every `retiredHeadParkMs`: park the watched heads a previous sweep found
   * forwarded, so each has been retired at least that long (at most twice). */
  const sweepRetiredHeadsToPark = async (): Promise<void> => {
    if (parkSweeping || stopped || !metaHandle || !parksRetiredHeads) return
    parkSweeping = true
    // The sweep's START, before any await: two sweeps' starts are a whole
    // interval apart, so a head is parked on the sweep after the one that
    // first found it forwarded.
    const now = performance.now()
    try {
      await freshRetirements()
      const seen = new Set<string>()
      for (const [kind, urls] of [['object', model.objectShardUrls], ['connection', model.connectionShardUrls]] as const) {
        for (const url of [...urls]) {
          if (stopped) return
          const entry = shardStops.get(url)
          if (!entry || !isForwardedHead(kind, entry.documentId, url)) continue
          seen.add(url)
          const since = forwardedSince.get(url)
          if (since === undefined) { forwardedSince.set(url, now); continue }
          if (now - since < retiredHeadParkMs) continue
          try {
            await parkRetiredHead(kind, url)
          } catch (error) {
            if (isReadModelAuthorityLoss(error)) {
              reportFenceLost(kind === 'object' ? 'object_shard' : 'connection_shard', error)
              return
            }
            console.error(JSON.stringify({
              event: 'read_model.ordinary_retired_head_park_failed',
              workspace: `${key.landscapeId}/${key.versionId}`,
              kind,
              url,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        }
      }
      for (const url of forwardedSince.keys()) if (!seen.has(url)) forwardedSince.delete(url)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'read_model.ordinary_retired_head_park_sweep_failed',
        workspace: `${key.landscapeId}/${key.versionId}`,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      parkSweeping = false
    }
  }
  const startRetiredHeadParkSweep = (): void => {
    if (!chainFold && headRotation.rotates && residency && foldedArrivalPollMs <= 0 && retiredHeadParkMs > 0) {
      // Said once, at attach: without the poll nothing would find a parked
      // head's late writes, so every retired head stays watched and leased.
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_retired_head_parking_disabled',
        workspace: `${key.landscapeId}/${key.versionId}`,
        reason: 'AM_ORDINARY_FOLD_ARRIVAL_POLL_MS=0',
      }))
    }
    if (chainFold && foldedArrivalPollMs <= 0) {
      // Said once, at attach (G4-16c): no poll ever sets a folded head's
      // watermark, so nothing carries its late writes, and GC — which counts
      // a NULL watermark as a pending arrival — keeps every folded head for
      // good (`foldedArrivalPendingSql`). Safe, and unbounded.
      console.warn(JSON.stringify({
        event: 'read_model.ordinary_fold_arrival_poll_disabled',
        workspace: `${key.landscapeId}/${key.versionId}`,
        reason: 'AM_ORDINARY_FOLD_ARRIVAL_POLL_MS=0',
        consequence: 'folded-heads-kept-by-gc',
      }))
    }
    if (!parksRetiredHeads || stopped || parkSweepTimer) return
    parkSweepTimer = setInterval(() => { void sweepRetiredHeadsToPark() }, retiredHeadParkMs)
    parkSweepTimer.unref?.()
  }

  /** Any `folded` row in the cached retirement rows. */
  const hasFoldedRows = (): boolean => [...retirements.values()].some((row) => row.status === 'folded')
  const pollFoldedArrivals = async (): Promise<void> => {
    if (foldedArrivalPolling || stopped || !metaHandle) return
    foldedArrivalPolling = true
    const pollStartedAt = Date.now()
    try {
      // Fold off and no folded row from an earlier life (see the disarm
      // below for why the cached rows are enough): no folded head to ask
      // about, only parked ones.
      // Heads owed the handover re-check are listed whatever their watermark.
      // What was owed, and what was known, when this pass STARTED: only
      // those may be forgotten at its end (`forgetUnknownHandoverRechecks`).
      const owedAtStart = new Set(handoverRecheck)
      const knownAtStart = owedAtStart.size ? headsKnownNow() : new Set<string>()
      const budget = recheckPass()
      // Floors committed BEFORE this query are in the rows it reads: dropped
      // (unless a newer detach replaced one meanwhile). Those committed during
      // it may not be, and lift the stale NULL it returns (`detachedWatermarks`).
      const floorsBefore = [...detachedWatermarks]
      const read = !chainFold && !hasFoldedRows() ? [] : await foldedHeadsWithArrivals(db, key, [...owedAtStart])
      for (const [id, floor] of floorsBefore) if (detachedWatermarks.get(id) === floor) detachedWatermarks.delete(id)
      const hits = read.map((hit) => {
        const floor = detachedWatermarks.get(hit.documentId)
        return floor !== undefined && arrivalAbove(floor, hit.watermark) ? { ...hit, watermark: floor } : hit
      })
      foldedArrivalCost.rows += hits.length
      // A row listed only because it is owed the handover re-check (no arrival
      // above its watermark) is counted apart: no late write keeps it.
      foldedArrivalCost.expiredRows += hits.filter((hit) => hit.expired && arrivalAbove(hit.arrivalSeq, hit.watermark)).length
      foldedArrivalCost.recheckRows += hits.filter((hit) => !arrivalAbove(hit.arrivalSeq, hit.watermark)).length
      for (const hit of hits) {
        if (stopped || !stillOwned()) return
        const url = stringifyAutomergeUrl({ documentId: hit.documentId as DocumentId })
        // Still listed and watched: its own watcher forwards it. Being
        // detached: its watcher may still be forwarding it.
        if ((hit.collection === 'object' ? model.objectShardUrls : model.connectionShardUrls).includes(url)) continue
        if (foldSourcesDetaching.has(url)) continue
        const backoff = foldedArrivalBackoff.get(hit.documentId)
        if (backoff && Date.now() < backoff.until) continue
        // Owed the re-check and within this pass's budget; over budget, an
        // owed head with no arrival above its watermark waits for the next.
        const rechecking = handoverRecheck.has(hit.documentId) && budget.left > 0
        if (!rechecking && !arrivalAbove(hit.arrivalSeq, hit.watermark)) continue
        if (rechecking) budget.left -= 1
        const backOff = () => {
          const delay = Math.min(FOLDED_ARRIVAL_MAX_BACKOFF_MS, Math.max(foldedArrivalPollMs, (backoff?.delay ?? 0) * 2))
          foldedArrivalBackoff.set(hit.documentId, { until: Date.now() + delay, delay })
          if (rechecking) handoverRecheckFailed(hit.documentId)
        }
        const leasedBefore = leasedDocumentIds.has(hit.documentId)
        // A handle `resolveHandle` loads reflects storage already; one resident
        // before may predate an old owner's save.
        const residentBefore = rechecking && budget.resident(hit.documentId)
        foldedArrivalCost.loaded += 1
        try {
          const handle = await resolveHandle(url, 'folded-arrival')
          try {
            // The handover re-check: what storage holds, into the handle the
            // forward reads, when this Repo held it before.
            const durableSeq = residentBefore ? await mergeDurableContent(handle) : null
            let outcome: string | undefined
            await forwardInsteadOfProjecting(hit.collection, handle, url, (answer) => { outcome = answer })
            // Advanced only on a forward that HAPPENED (or found nothing to
            // carry) and did not degrade. `not-owner` and `not-retired`
            // carried nothing: advancing on them would hide the write from
            // every later poll, the next owner's included.
            if ((outcome === 'forwarded' || outcome === 'superseded' || outcome === 'nothing')
              && !forwardDegradedUrls.has(url)) {
              // Never lowered: a re-checked head may hold nothing above it.
              const next = laterArrival(hit.arrivalSeq, durableSeq)
              if (next !== null && arrivalAbove(next, hit.watermark)) await commitFoldedArrival({ ...hit, arrivalSeq: next })
              foldedArrivalBackoff.delete(hit.documentId)
              // An expired head listed only for the handover re-check (no
              // arrival above its watermark) carried nothing pending: not
              // counted as carried.
              if (hit.expired && arrivalAbove(hit.arrivalSeq, hit.watermark)) {
                // Past its retention, kept by GC for this arrival only: from
                // here the next GC pass may sweep it.
                foldedArrivalCost.expiredCarried += 1
                console.warn(JSON.stringify({
                  event: 'read_model.ordinary_fold_arrival_expired_carried',
                  workspace: `${key.landscapeId}/${key.versionId}`,
                  collection: hit.collection,
                  documentId: hit.documentId,
                  outcome,
                }))
              }
              if (rechecking) handoverRecheckDone(hit.documentId)
            } else {
              backOff()
            }
          } finally {
            if (!leasedBefore && residency && leasedDocumentIds.delete(handle.documentId)) {
              residency.release(handle.documentId, residencyOwner)
            }
          }
        } catch (error) {
          if (isReadModelAuthorityLoss(error)) {
            reportFenceLost(hit.collection === 'object' ? 'object_shard' : 'connection_shard', error)
            return
          }
          backOff()
          console.error(JSON.stringify({
            event: 'read_model.ordinary_fold_arrival_failed',
            workspace: `${key.landscapeId}/${key.versionId}`,
            collection: hit.collection,
            documentId: hit.documentId,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }
      if (handoverRecheck.size) await recheckWatchedRetiredHeads(budget)
      await pollParkedRetiredHeads(budget)
      forgetUnknownHandoverRechecks(owedAtStart, knownAtStart, new Set(hits.map((hit) => hit.documentId)))
      // Owed heads left the set: the fold's row sweep kept their rows
      // (`sweepKeep`) and nothing else would ask for a pass, so ask now —
      // at most once per pass that shrank the set, so bounded by its size.
      if (!handoverSweepHold && [...owedAtStart].some((id) => !handoverRecheck.has(id))) requestSweepPass()
    } catch (error) {
      console.error(JSON.stringify({
        event: 'read_model.ordinary_fold_arrival_poll_failed',
        workspace: `${key.landscapeId}/${key.versionId}`,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      foldedArrivalPolling = false
      const ms = Date.now() - pollStartedAt
      foldedArrivalCost.polls += 1
      foldedArrivalCost.totalMs += ms
      foldedArrivalCost.maxMs = Math.max(foldedArrivalCost.maxMs, ms)
      if (foldedArrivalCost.polls >= FOLDED_ARRIVAL_SUMMARY_POLLS) logFoldedArrivalCost()
      // Fold off, nothing parked or parking, no folded row from an earlier
      // life: nothing left to poll. Disarmed; the next park re-arms it. Only
      // with the fold off, where nothing makes a row `folded`, so the cached
      // rows (`retirements`, read at attach and on every pointer move) can
      // only overstate the folded set, never miss one.
      if (!chainFold && foldedArrivalTimer && !parkedRetiredHeads.size && !retiredHeadsParking.size && !hasFoldedRows()
        && !handoverRecheck.size) {
        clearInterval(foldedArrivalTimer)
        foldedArrivalTimer = null
      }
    }
  }
  /** Start the poll (once) and run one pass now. */
  const startFoldedArrivalPoll = (): void => {
    if (stopped || foldedArrivalPollMs <= 0) return
    if (!foldedArrivalTimer) {
      foldedArrivalTimer = setInterval(() => { void pollFoldedArrivals() }, foldedArrivalPollMs)
      foldedArrivalTimer.unref?.()
    }
    void pollFoldedArrivals()
  }

  /** The CURRENT write head only — a retired head is no rotation candidate —
   * and only while this projector still speaks for the workspace, the same
   * owner gate the health publish uses. Synchronous and read-only. Returns
   * whether the head is due (`ordinaryHeadRotation.ts`). */
  const observeWriteHead = (kind: OrdinaryHeadKind, url: string, doc: unknown): boolean => {
    if (stopped || !stillOwned()) return false
    return headRotation.observe(kind, url, doc)
  }
  const watchObjectShard = async (
    url: string,
    applyInitial = false,
    /** Boot shards seed their delta baseline from the EXTRACTION, not the live
     * doc — the live doc at attach time would swallow every arrival between
     * the cold build's sampling and the attach. The seeded watcher
     * fires one projection immediately WHEN A GAP IS POSSIBLE, emitting
     * exactly that gap. */
    extractionSeed?: Record<string, ObjectInput>,
    /** The shard's heads at extraction time — equal live heads at attach prove
     * there is no gap and the boot projection is skipped (the cold build's
     * watermark already covers the shard). Unknown heads fire the projection:
     * assuming no gap is the unsafe direction. */
    extractionHeads?: readonly string[] | null,
  ) => {
    const h = applyInitial ? await resolveHandleRetry(url) : await resolveHandle(url, 'attach')
    const attachDoc = h.doc()
    const attachHeads = tryGetHeads(attachDoc)
    // A fold product, mid-session or at boot, is never projected
    // (`ordinaryChainFold.ts`): a change after this is refused.
    const foldProduct = hasOrdinaryFoldMarker(attachDoc)
    // The initial snapshot of a shard appended MID-SESSION. Unlike the delta
    // path this cannot delete anything, so an uninitialised document is not a
    // data-loss risk here — but accepting it silently would still hide a
    // defect (see `extractModelEntities`), and it leaves `snap` empty so the FIRST later change computes
    // its delta against a baseline that was never really read.
    const readInitial = extractionSeed !== undefined
      ? { map: extractionSeed, defect: undefined }
      : readEntityMapOrDefect<ObjectInput>(attachDoc, 'objects', 'object-shard', url)
    if (readInitial.defect) {
      recordRefusedProjection()
      console.warn(
        `[read-model] object shard ${url} for ${key.landscapeId}/${key.versionId} carries no objects map ` +
          `at attach time: ${summarizeModelDefects([readInitial.defect])}`)
    }
    const initial = Object.values(readInitial.map)
    // EVERY PROJECTOR ACKNOWLEDGES.
    // The client journals every write batch it puts into this head and asks
    // `/api/model/overlay-batches/status` until each is terminal; if this
    // projector did not answer, no batch on an ordinary workspace would ever be
    // terminal — the journal would grow by one entry per flush for the life of
    // the browser profile, every reconciliation would POST the whole backlog,
    // and a retired write head would stay pinned in memory
    // (`edits-overlay-pending`) for the life of the tab. The acknowledgement is
    // written in the SAME transaction as the rows it vouches for, from the same
    // sample: the client puts the batch id and its objects in one change, so an
    // id in the sample means its objects are in the sample. Incremental — ids
    // acknowledged by this closure are not re-sent — because the list only
    // grows for the life of a head.
    //
    // EVERY head this closure projects, not only the CURRENT one.
    // A head is retired by
    // compaction — `compaction.ts` mints a fresh one (`nextHead`) and repoints
    // the meta; the ONLY rotator in the tree, since the client's
    // `shouldRotateOverlayWriteHead` merely defers to server maintenance
    // (`bridge.ts`, `overlay.rotation.deferred`) and keeps writing into the
    // current head — and stays in `objectShardUrls`, so this closure keeps
    // projecting it, while a client that was offline across the rotation
    // keeps writing into it. Gating the acknowledgement on
    // `editsObjectShardUrl === url` would leave those batches projected but
    // acknowledged by nobody, pinning the retired head
    // (`edits-overlay-pending`) for the life of the tab. "Projected" is literally true of every batch whose
    // objects this closure wrote, whichever head carried it; a base shard has
    // no `writeBatchIds` and sends nothing. Only the BASE capture and the heal
    // below stay tied to the current head — a CHOICE not to write into a
    // document offline clients still hold (the healer captures its own bases,
    // `overlayConflictHealing.ts`), not a technical constraint. Its cost:
    // a `$` conflict in a retired head is
    // not healed; when the CURRENT head also carries the entity the fold hides
    // it (`compaction.ts`, `Object.assign` oldest → newest), and when it does
    // NOT, the fold writes the JSON winner into the base shard and the
    // conditional clear drops the losing branch's fields for good. (The DELTA
    // path below has no such order: `applyObjectShardDelta` is a per-shard
    // upsert by id, so the LAST shard delta wins the `ro_*` row whichever head
    // it came from.) All of this describes a head retired by COMPACTION, which
    // has no retirement row. A head with a `retired` row and H_r is neither
    // projected nor acknowledged here: it is forwarded
    // (`ordinaryHeadForwarding.ts`, `forwardInsteadOfProjecting`).
    //
    // A head the forwarder owns (`isForwardedHead`) acknowledges NOTHING
    // itself: its late batches are acknowledged by the current head's
    // projection, from `forwardedBatchIds`, with the rows carrying their
    // values. Its batches before H_r were acknowledged while it was current.
    const acknowledgedBatchIds = new Set<string>()
    const unacknowledged = (doc: ObjShardLike | undefined): string[] =>
      [...new Set([...(doc?.writeBatchIds ?? []), ...forwardedBatchIdsOf(doc)])]
        .filter((batchId) => !acknowledgedBatchIds.has(batchId))
    // The attach sample vouches for the attach document's batches only when
    // what is published IS that document — the initial apply below, or the
    // cold build's extraction when the heads prove it equal to the live doc.
    // Otherwise the immediate gap projection acknowledges from its own,
    // fresher sample.
    const currentOverlayAtAttach = (metaHandle?.doc() as MetaLike | undefined)?.editsObjectShardUrl === url
    const dueAtAttach = currentOverlayAtAttach && observeWriteHead('object', url, attachDoc)
    // What the cold build published for a boot shard is its extraction.
    if (extractionSeed !== undefined) notePublished(h.documentId, extractionHeads)
    await freshRetirements()
    const forwardedAtAttach = isForwardedHead('object', h.documentId, url)
    const attachBatchIds = !forwardedAtAttach && (extractionSeed === undefined
      || (extractionHeads && attachHeads && headsEqual(extractionHeads, attachHeads)))
      ? unacknowledged(attachDoc as ObjShardLike | undefined)
      : []
    if (applyInitial && initial.length && !forwardedAtAttach) {
      const parentIds = initial.flatMap((object) => object.parentId ? [object.parentId] : [])
      const candidateIds = [...initial.map((object) => object.id), ...parentIds]
      await repo.flush([h.documentId])
      const preparedWatermarks = await prepareShardWatermarks([h.documentId])
      await runTracked(
        'object_shard',
        async (tx) => {
          if (currentOverlayAtAttach) {
            await captureOverlayEntityBases(
              tx, key, 'object', h.documentId, initial.map((object) => object.id),
            )
          }
          await acknowledgeOverlayBatches(tx, key, 'object', h.documentId, attachBatchIds, 'projected', 0, 0)
          const changes = await servedObjectRowsChangedBy(tx, key, candidateIds,
            () => applyObjectShardDelta(tx, key, orgId, [], initial))
          await recordShardWatermark(tx, h, attachHeads, preparedWatermarks)
          return changes
        },
        // See projectLatest below: only the ids whose served row changed.
        (changes) => ({ kind: 'objects', ...changes }),
        // One shard's ids are not the workspace's, so `object` cannot be
        // re-sealed here and goes un-comparable until the next full extraction.
        // The other three are untouched and keep theirs.
        { unchanged: ['connection', 'group', 'diagram'] },
      )
      notePublished(h.documentId, attachHeads)
      for (const batchId of attachBatchIds) acknowledgedBatchIds.add(batchId)
      // Deliberately NOT swallowed: a PostgreSQL failure here means the shard's
      // objects are absent from the read model. Propagating leaves the shard
      // unwatched and unrecorded, so the next meta change re-attempts it,
      // instead of logging past a silently incomplete projection.
    } else if (attachBatchIds.length) {
      // Rows already published (the cold build), nothing to project: the
      // acknowledgement alone. A failure here is loud but not fatal to the
      // attach — the ids stay out of the Set, so the next delta re-sends them.
      try {
        await acknowledgeOnly('object', h.documentId, attachBatchIds)
        for (const batchId of attachBatchIds) acknowledgedBatchIds.add(batchId)
      } catch (error) {
        console.error(
          `[read-model] ${attachBatchIds.length} write batch(es) of ${url} for ${key.landscapeId}/${key.versionId} ` +
            'not acknowledged at attach; the next delta re-sends them', error)
      }
    }
    let snap = new Map<string, ObjectInput>(initial.map((o) => [o.id, o]))
    const projectLatest = async () => {
      // Detached (folded): its late writes are the folded poll's. Defence in
      // depth only: the detach disposes this coalescer (`stop`) and awaits its
      // pass first, so no pass should start here after it; this return is not
      // what makes the detach safe.
      if (detachedFoldSources.has(url)) return
      // A retired head with H_r is never projected directly: its late writes
      // go to the current head, whose projection publishes them. Checked per
      // pass, because a head becomes retired under a running watcher.
      if (await forwardInsteadOfProjecting('object', h, url)) return
      // Capture one immutable Automerge snapshot, then make that exact revision
      // durable before exposing it through PostgreSQL. Without this ordering an
      // active owner could publish a value from memory, die, and let the takeover
      // cold-build the older persisted snapshot.
      const source = h.doc() as ObjShardLike
      const sampledHeads = tryGetHeads(source)
      // Taken in the SAME synchronous turn as the sample — see
      // `retiredHeadStamps` — and put back unless this pass publishes.
      const stamps = takeRetiredHeadStamps(h.documentId)
      let stampsPublished = false
      try {
        const sourceConflicts = collectAutomergeEntityConflicts(
          source?.objects as Record<string, unknown> | undefined,
        )
        const isCurrentOverlay = (metaHandle?.doc() as MetaLike | undefined)?.editsObjectShardUrl === url
        const due = isCurrentOverlay && observeWriteHead('object', url, source)
        // THE SERVER WRITES INTO THIS DOCUMENT IN ONE CASE: two clients put a
        // whole entity at the same key concurrently (`$`), and the other branch's
        // fields are invisible until one causal replacement carries their union.
        // Everything else — a same-field conflict on `hot` from 25 writers
        // included — converges deterministically in Automerge and is projected,
        // never touched. The rule, the heads guard and the reasons are ONE module
        // shared with the static projector (`overlayConflictHealing.ts`).
        //
        // Measured (25 writers on one field of 5 objects): healing EVERY conflict
        // by assigning the whole entity back puts a NEW map at the key, and a
        // peer whose field write has not yet reached the server keeps writing
        // into the previous, now unreferenced map — 23 of 25 users' own fields
        // were lost with no conflict to show for it. A sample-wide gate is wrong
        // too: it would heal a same-field-only entity alongside a `$` one and
        // DELETE its contested leaf. Hence per entity, `$` only.
        if (isCurrentOverlay && sourceConflicts.size) {
          const outcome = await healWholeEntityConflicts<ObjectInput>({
            db, key, collection: 'object', handle: h, repo,
            sourceConflicts, sampledHeads,
            current: (entityId) => snap.get(entityId),
            selected: (entityId) => source?.objects?.[entityId],
          })
          // `healed`: the heal itself re-triggers this projection, which then
          // publishes the healed value. `stale`: so does the write that moved the
          // heads. Never publish the lossy JSON winner of a `$` in either case —
          // a heal costs exactly ONE generation, the one that publishes the union
          // (arm 4 of `loadGateSeedProjection.integration.test.ts` counts it;
          // `=== 'stale'` here would publish the winner first and cost two).
          if (outcome !== 'none') return
        }
        // A shard delta DELETES every id that was in the previous snapshot and is
        // not in this one. `{ objects: {} }` legitimately means the user removed
        // them all and must still delete. A document with NO `objects` key was
        // never initialised — no writer in this product produces one — so acting
        // on it would destroy rows on the strength of a document that failed to
        // load. Refuse, record, leave the rows and the snapshot alone; the next
        // real change re-runs this with a readable document.
        const read = readEntityMapOrDefect<ObjectInput>(source, 'objects', 'object-shard', url)
        if (isUninformative(read.defect)) {
          recordRefusedProjection()
          console.warn(
            `[read-model] refused an object-shard delta for ${key.landscapeId}/${key.versionId}: ` +
              `${url} carries no objects map; ${snap.size} row(s) left untouched`)
          return
        }
        const objects = Object.values(read.map)
        await repo.flush([h.documentId])
        const preparedWatermarks = await prepareShardWatermarks([
          h.documentId, ...stamps.map((stamp) => stamp.handle.documentId as DocumentId),
        ])
        const oldIds = [...snap.keys()]
        const next = new Map(objects.map((o) => [o.id, o]))
        const deletedIds = oldIds.filter((id) => !next.has(id))
        const parentIds = [
          ...objects.flatMap((object) => object.parentId ? [object.parentId] : []),
          ...[...snap.values()].flatMap((object) => object.parentId ? [object.parentId] : []),
        ]
        const batchIds = unacknowledged(source)
        // The shard is rewritten whole, but the feed names only the candidates
        // whose SERVED row (`roObjectCacheByIds`) differs after the write — read
        // from the database, not from `snap`: an id can live in several shards
        // (base + overlay heads) and the last shard written wins its row, so this
        // closure's own snapshot cannot tell whether the row moved (the shared-id
        // arm of `projectorService.integration.test.ts` goes red on that diff).
        // Measured 2026-10-15 before this, 10-object workspace: one rename listed
        // all 10 ids, and every consumer filtering on them (inline expansions,
        // the offline cache's by-ids re-fetch) re-read for edits not theirs.
        // The candidates are this shard's ids, the parents it names, the ids it
        // deletes, and their neighbours read from the rows — children and groups
        // in OTHER shards, which the old whole-shard listing happened to refresh
        // on the shard's next edit and a precise feed would otherwise never name
        // (`servedObjectRowsChangedBy`).
        const candidateIds = [...objects.map((object) => object.id), ...parentIds, ...deletedIds]
        await runTracked(
          'object_shard',
          async (tx) => {
            // LOAD-BEARING for two online first writes into a fresh head after a
            // rotation (G4-16g): this captures the SERVED value as the heal base
            // before the first client's put is projected. Without it, a second
            // client's concurrent put heals against the first client's value
            // and the first edit is lost with no signal — the mutant that drops
            // this call turns `ordinaryHeadFirstWriteConflict.integration.test.ts`
            // (a-projected-first) red.
            if (isCurrentOverlay) {
              await captureOverlayEntityBases(
                tx, key, 'object', h.documentId, [...oldIds, ...objects.map((object) => object.id)],
              )
            }
            await acknowledgeOverlayBatches(tx, key, 'object', h.documentId, batchIds, 'projected', 0, 0)
            // `deleteObjects` also rewrites the manifests listing a deleted id.
            let objectChanges: ServedRowChanges = { upsertIds: [], deleteIds: [] }
            const diagramChanges = await servedDiagramRowsChangedBy(tx, key,
              () => diagramIdsReferencing(tx, key, deletedIds, []),
              async () => {
                objectChanges = await servedObjectRowsChangedBy(tx, key, candidateIds,
                  () => applyObjectShardDelta(tx, key, orgId, oldIds, objects))
              })
            await recordShardWatermark(tx, h, sampledHeads, preparedWatermarks)
            await recordRetiredHeadStamps(tx, stamps, preparedWatermarks)
            return { objects: objectChanges, diagrams: diagramChanges }
          },
          // A row that vanished is a delete; one that appeared or moved, an
          // upsert. Objects only — the plain event — unless a manifest moved.
          (changes): ReadModelChangePayload => ({ kind: 'exact', changes }),
          { unchanged: ['connection', 'group', 'diagram'] },
        )
        stampsPublished = true
        // Advance only after rows + feed + generation commit atomically.
        snap = next
        for (const batchId of batchIds) acknowledgedBatchIds.add(batchId)
        notePublished(h.documentId, sampledHeads)
        if (due) requestRotation('object', h, url)
      } finally {
        if (!stampsPublished) restoreRetiredHeadStamps(stamps)
        settleTakenStamps(stamps)
      }
    }
    const coalescer = coalescedProjection('object shard delta',
      foldProduct ? refuseFoldProductChange(url, 'object_shard') : projectLatest)
    const onChange = coalescer.trigger
    h.on('change', onChange)
    shardTriggers.set(h.documentId, coalescer.trigger)
    watchShardStop(url, h.documentId, () => {
      coalescer.dispose(); h.off('change', onChange); shardTriggers.delete(h.documentId)
    }, coalescer.idle)
    // Extraction-seeded boot shards project once immediately WHEN the live
    // heads differ from the extraction's (or either is unknown): the delta vs
    // the extraction baseline emits exactly the arrivals the cold build's
    // sampling missed. Read heads AFTER registration: an acknowledgement above
    // can await SQL while a new edit arrives before this listener is installed.
    // Equal current heads need no extra projection/generation.
    //
    // A forwarded head runs once at attach WHATEVER its heads: what it owes is
    // measured from `forwarded_heads`, not from the extraction — late writes
    // that arrived while no projector was attached.
    const watchedHeads = tryGetHeads(h.doc())
    const projectedHeads = extractionSeed !== undefined ? extractionHeads : attachHeads
    // A fold product has a `retired` row (so a later fold can take it) but is
    // never projected or forwarded: only a change since its seed fires, and
    // that is refused.
    if ((forwardedAtAttach && !foldProduct) || ((extractionSeed !== undefined || applyInitial)
      && !(projectedHeads && watchedHeads && headsEqual(projectedHeads, watchedHeads)))) {
      coalescer.trigger()
    } else if (dueAtAttach) {
      // Already due and nothing to project: rotate now rather than at the next
      // write. When a projection was triggered above, it asks itself.
      requestRotation('object', h, url)
    }
  }
  const watchConnectionShard = async (
    url: string,
    applyInitial = false,
    /** See watchObjectShard — the extraction is the only truthful baseline. */
    extractionSeed?: Record<string, ConnectionInput>,
    /** See watchObjectShard — equal heads at attach skip the boot projection. */
    extractionHeads?: readonly string[] | null,
  ) => {
    const h = applyInitial ? await resolveHandleRetry(url) : await resolveHandle(url, 'attach')
    const attachDoc = h.doc()
    const attachHeads = tryGetHeads(attachDoc)
    // A fold product, mid-session or at boot, is never projected
    // (`ordinaryChainFold.ts`): a change after this is refused.
    const foldProduct = hasOrdinaryFoldMarker(attachDoc)
    // See watchObjectShard: reported, not refused — this path cannot delete.
    const readInitial = extractionSeed !== undefined
      ? { map: extractionSeed, defect: undefined }
      : readEntityMapOrDefect<ConnectionInput>(attachDoc, 'connections', 'connection-shard', url)
    if (readInitial.defect) {
      recordRefusedProjection()
      console.warn(
        `[read-model] connection shard ${url} for ${key.landscapeId}/${key.versionId} carries no connections map ` +
          `at attach time: ${summarizeModelDefects([readInitial.defect])}`)
    }
    const initial = Object.values(readInitial.map)
    // See watchObjectShard: every projector acknowledges, every head it
    // projects, the retired ones included — same rule.
    // A forwarded head acknowledges nothing itself — see watchObjectShard.
    const acknowledgedBatchIds = new Set<string>()
    const unacknowledged = (doc: ConnShardLike | undefined): string[] =>
      [...new Set([...(doc?.writeBatchIds ?? []), ...forwardedBatchIdsOf(doc)])]
        .filter((batchId) => !acknowledgedBatchIds.has(batchId))
    const currentOverlayAtAttach = (metaHandle?.doc() as MetaLike | undefined)?.editsConnectionShardUrl === url
    const dueAtAttach = currentOverlayAtAttach && observeWriteHead('connection', url, attachDoc)
    if (extractionSeed !== undefined) notePublished(h.documentId, extractionHeads)
    await freshRetirements()
    const forwardedAtAttach = isForwardedHead('connection', h.documentId, url)
    const attachBatchIds = !forwardedAtAttach && (extractionSeed === undefined
      || (extractionHeads && attachHeads && headsEqual(extractionHeads, attachHeads)))
      ? unacknowledged(attachDoc as ConnShardLike | undefined)
      : []
    if (applyInitial && initial.length && !forwardedAtAttach) {
      await repo.flush([h.documentId])
      const preparedWatermarks = await prepareShardWatermarks([h.documentId])
      await runTracked(
        'connection_shard',
        async (tx) => {
          if (currentOverlayAtAttach) {
            await captureOverlayEntityBases(
              tx, key, 'connection', h.documentId, initial.map((connection) => connection.id),
            )
          }
          await acknowledgeOverlayBatches(tx, key, 'connection', h.documentId, attachBatchIds, 'projected', 0, 0)
          const changes = await servedConnectionRowsChangedBy(tx, key, initial.map((connection) => connection.id),
            () => applyConnectionShardDelta(tx, key, orgId, [], initial))
          await recordShardWatermark(tx, h, attachHeads, preparedWatermarks)
          return changes
        },
        // See watchObjectShard: only the ids whose served row changed.
        (changes) => ({ kind: 'connections', ...changes }),
        { unchanged: ['object', 'group', 'diagram'] },
      )
      notePublished(h.documentId, attachHeads)
      for (const batchId of attachBatchIds) acknowledgedBatchIds.add(batchId)
      // See watchObjectShard: an initial apply failure must not be absorbed.
    } else if (attachBatchIds.length) {
      // See watchObjectShard: rows already published, the acknowledgement alone.
      try {
        await acknowledgeOnly('connection', h.documentId, attachBatchIds)
        for (const batchId of attachBatchIds) acknowledgedBatchIds.add(batchId)
      } catch (error) {
        console.error(
          `[read-model] ${attachBatchIds.length} write batch(es) of ${url} for ${key.landscapeId}/${key.versionId} ` +
            'not acknowledged at attach; the next delta re-sends them', error)
      }
    }
    let snap = new Map<string, ConnectionInput>(initial.map((c) => [c.id, c]))
    const projectLatest = async () => {
      // See watchObjectShard: defence in depth behind the disposed coalescer.
      if (detachedFoldSources.has(url)) return
      // See watchObjectShard: a retired head with H_r is forwarded instead.
      if (await forwardInsteadOfProjecting('connection', h, url)) return
      // Sample the exact revision whose rows this pass will publish.
      const source = h.doc() as ConnShardLike
      const sampledHeads = tryGetHeads(source)
      // See watchObjectShard: stamps are taken with the sample.
      const stamps = takeRetiredHeadStamps(h.documentId)
      let stampsPublished = false
      try {
        const sourceConflicts = collectAutomergeEntityConflicts(
          source?.connections as Record<string, unknown> | undefined,
        )
        const isCurrentOverlay = (metaHandle?.doc() as MetaLike | undefined)?.editsConnectionShardUrl === url
        const due = isCurrentOverlay && observeWriteHead('connection', url, source)
        // Same rule and same measurement as `watchObjectShard` above, from the
        // same module: `$` entities only, one replacement each, heads guarded.
        if (isCurrentOverlay && sourceConflicts.size) {
          const outcome = await healWholeEntityConflicts<ConnectionInput>({
            db, key, collection: 'connection', handle: h, repo,
            sourceConflicts, sampledHeads,
            current: (entityId) => snap.get(entityId),
            selected: (entityId) => source?.connections?.[entityId],
          })
          if (outcome !== 'none') return
        }
        // See watchObjectShard: an uninitialised shard document is evidence of
        // nothing, and this delta deletes on the strength of it.
        const read = readEntityMapOrDefect<ConnectionInput>(source, 'connections', 'connection-shard', url)
        if (isUninformative(read.defect)) {
          recordRefusedProjection()
          console.warn(
            `[read-model] refused a connection-shard delta for ${key.landscapeId}/${key.versionId}: ` +
              `${url} carries no connections map; ${snap.size} row(s) left untouched`)
          return
        }
        const connections = Object.values(read.map)
        await repo.flush([h.documentId])
        const preparedWatermarks = await prepareShardWatermarks([
          h.documentId, ...stamps.map((stamp) => stamp.handle.documentId as DocumentId),
        ])
        const oldIds = [...snap.keys()]
        const next = new Map(connections.map((c) => [c.id, c]))
        const deletedIds = oldIds.filter((id) => !next.has(id))
        const batchIds = unacknowledged(source)
        await runTracked(
          'connection_shard',
          async (tx) => {
            if (isCurrentOverlay) {
              await captureOverlayEntityBases(
                tx, key, 'connection', h.documentId,
                [...oldIds, ...connections.map((connection) => connection.id)],
              )
            }
            await acknowledgeOverlayBatches(tx, key, 'connection', h.documentId, batchIds, 'projected', 0, 0)
            // Same rule as the object shard: the whole shard is rewritten, the
            // feed names the served rows that moved (a shared id included — a
            // base shard and an overlay head both carry an edited connection).
            // `deleteConnections` also rewrites the manifests listing a deleted id.
            let connectionChanges: ServedRowChanges = { upsertIds: [], deleteIds: [] }
            const diagramChanges = await servedDiagramRowsChangedBy(tx, key,
              () => diagramIdsReferencing(tx, key, [], deletedIds),
              async () => {
                connectionChanges = await servedConnectionRowsChangedBy(tx, key,
                  [...connections.map((connection) => connection.id), ...deletedIds],
                  () => applyConnectionShardDelta(tx, key, orgId, oldIds, connections))
              })
            await recordShardWatermark(tx, h, sampledHeads, preparedWatermarks)
            await recordRetiredHeadStamps(tx, stamps, preparedWatermarks)
            return { connections: connectionChanges, diagrams: diagramChanges }
          },
          (changes): ReadModelChangePayload => ({ kind: 'exact', changes }),
          { unchanged: ['object', 'group', 'diagram'] },
        )
        stampsPublished = true
        snap = next
        for (const batchId of batchIds) acknowledgedBatchIds.add(batchId)
        notePublished(h.documentId, sampledHeads)
        if (due) requestRotation('connection', h, url)
      } finally {
        if (!stampsPublished) restoreRetiredHeadStamps(stamps)
        settleTakenStamps(stamps)
      }
    }
    const coalescer = coalescedProjection('connection shard delta',
      foldProduct ? refuseFoldProductChange(url, 'connection_shard') : projectLatest)
    const onChange = coalescer.trigger
    h.on('change', onChange)
    shardTriggers.set(h.documentId, coalescer.trigger)
    watchShardStop(url, h.documentId, () => {
      coalescer.dispose(); h.off('change', onChange); shardTriggers.delete(h.documentId)
    }, coalescer.idle)
    // See watchObjectShard: seeded boot shards project the extraction gap once
    // — only when the heads say a gap is possible — and a forwarded head
    // forwards once, whatever its heads.
    const watchedHeads = tryGetHeads(h.doc())
    const projectedHeads = extractionSeed !== undefined ? extractionHeads : attachHeads
    // A fold product has a `retired` row (so a later fold can take it) but is
    // never projected or forwarded: only a change since its seed fires, and
    // that is refused.
    if ((forwardedAtAttach && !foldProduct) || ((extractionSeed !== undefined || applyInitial)
      && !(projectedHeads && watchedHeads && headsEqual(projectedHeads, watchedHeads)))) {
      coalescer.trigger()
    } else if (dueAtAttach) {
      requestRotation('connection', h, url)
    }
  }

  // Registry shards hold the diagram stubs (DiagramMeta). On any change re-read the
  // whole registry (small) and full-sync ro_diagrams.
  // ONE coalescer for the whole registry, hoisted out of the per-shard loop.
  //
  // `projectLatest` re-extracts the ENTIRE model and reconciles EVERY diagram,
  // so it is indifferent to WHICH shard changed. A coalescer per shard collapses
  // each shard's own burst correctly but nothing collapses the burst ACROSS
  // shards, and six shards changing in one tick — a rename sweep, an import —
  // would do six identical full passes (measured: 102 finds where 17 suffice).
  const registryProjectLatest = async () => {
    const m = await extractModelEntities(rootHandle.doc() as RootLike, resolve)
    // A full extraction, so its defect list describes the workspace — but only
    // the DIAGRAM digest is sealed: `syncDiagrams` is a full sync of ro_diagrams
    // and nothing else, so the object/connection/group rows this generation
    // leaves behind are the previous generation's and must keep their own stamp.
    // What a full registry sync moves in the served rows: diagram manifests
    // (all of them are candidates — it is a full sync, of every id before and
    // after) and two connection counts. Published as an `exact` change, which
    // a reader that predates the field still reads as the reset/all this
    // pass used to publish on every registry edit.
    await runTracked('registry', async (tx) => {
      const countsBefore = await connectionMembershipCounts(tx, key)
      const diagrams = await servedDiagramRowsChangedBy(tx, key,
        async () => [...m.diagrams.map((diagram) => diagram.id), ...(await tx.query<{ id: string }>(
          'SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2',
          [key.landscapeId, key.versionId],
        )).rows.map((row) => row.id)],
        () => syncDiagrams(tx, key, orgId, m.diagrams))
      const countsAfter = await connectionMembershipCounts(tx, key)
      const moved = changedCacheRowIds([...countsBefore.keys(), ...countsAfter.keys()], countsBefore, countsAfter)
      return { diagrams, connections: { upsertIds: moved, deleteIds: [] } }
    },
      (changes): ReadModelChangePayload => ({ kind: 'exact', changes }),
      {
        defects: m.defects,
        digests: { diagram: digestOfIds(uniqueIds(m.diagrams)) },
        // `syncDiagrams` rewrites ro_diagrams, the diagram membership join
        // tables and the summaries. It does not add or remove a single
        // ro_objects / ro_connections / ro_groups row, so those three seals
        // remain accurate and only move generation.
        unchanged: ['object', 'connection', 'group'],
      })
    await reconcileDiagramDocs(m.diagrams)
  }
  const registryCoalescer = coalescedProjection('registry sync', registryProjectLatest)
  cleanups.push(() => registryCoalescer.dispose())

  const watchRegistryShard = async (url: string) => {
    const h = await resolveHandle(url, 'attach')
    const onChange = registryCoalescer.trigger
    h.on('change', onChange)
    cleanups.push(() => { h.off('change', onChange) })
  }

  // Boot shards seed their delta baseline from the EXTRACTION the cold build
  // just projected — never from the live doc, which would swallow every
  // arrival of the ]extraction, attach[ gap forever. `?? {}`
  // covers a shard whose read defected: the cold build projected nothing for
  // it, so an empty baseline makes the first delta emit its whole content.
  for (const url of model.objectShardUrls) {
    await watchObjectShard(
      url, false,
      model.objectsByShardUrl.get(url) ?? {},
      model.objectShardHeadsByUrl.get(url) ?? null,
    )
  }
  for (const url of model.connectionShardUrls) {
    await watchConnectionShard(
      url, false,
      model.connectionsByShardUrl.get(url) ?? {},
      model.connectionShardHeadsByUrl.get(url) ?? null,
    )
  }
  for (const url of model.registryShardUrls) await watchRegistryShard(url)

  // ------------------------------------------------------------------
  // The ROOT is a live document, not boot configuration.
  //
  // Registry shard urls live on `root.shardUrls`, and the client appends one at
  // runtime (`bridge.ts` publishNewRegistryShard) on two reachable paths: a
  // rollover past SHARD_SIZE, and the first creation in a summary-only workspace
  // whose root has no registryWriteUrl yet.
  //
  // Object and connection shard urls live on ModelMeta, which is watched, and
  // the meta handler below reconciles newly-appended urls into the watched set.
  // The registry needs the same: without watching the root, a shard appended
  // after boot would stay invisible until the projector restarted — and on a
  // workspace where all new activity is in the new shard (exactly what a
  // rollover produces) nothing would ever fire.
  //
  // A dedicated Set rather than `model.registryShardUrls.includes()` (the shape
  // the meta path uses): O(1), and it does not capture `model`.
  // ------------------------------------------------------------------
  const watchedRegistryShards = new Set<string>(model.registryShardUrls)
  const rootProjectLatest = async () => {
    // `watchRegistryShard` resolves through `resolveHandle`, which polls for
    // the shard's ARRIVAL at `CONTROL_DOCUMENT_TRIES` (3), and `degradedShards`
    // stays empty until the last one fails. So without this guard the 1 s
    // health beat would publish "nothing outstanding" for ~32 s about a
    // workspace in the middle of picking up a shard it had not read a byte of.
    await withReconciling(async () => {
      const root = rootHandle.doc() as RootLike
      for (const url of root.shardUrls ?? []) {
        if (watchedRegistryShards.has(url)) continue
        try {
          await watchRegistryShard(url)
          watchedRegistryShards.add(url)
          degradedShards.delete(url)
        } catch (error) {
          // Left OUT of the watched set, so the next root change re-attempts it —
          // symmetric with the meta path's handling of a new object shard.
          console.error('[read-model] new registry shard watch failed', error)
          degradeShard(url, 'registry', error)
        }
      }
    })
    // DELIBERATELY NOT handled here: a workspace whose model KIND changes under
    // a running projector (`modelMetaUrl` appearing on a root that booted as a
    // monolith). That is a real defect — every later object/connection edit goes
    // to shards this projector never opened. `createEmptyRoot` is
    // unconditionally sharded and the client no longer splits models, so
    // `modelMetaUrl` appearing mid-life means a SERVER-side
    // maintenance/migration sharded the workspace under us — rare, legitimate,
    // and resolved the moment this projector is recycled. The right fix is a
    // fleet-level restart when maintenance shards a monolith, not a health flag
    // from this hook (which cannot tell that migration apart from a replayed
    // historical change).
    //
    // NO health call here. A shard that just came back has been
    // WATCHED, not projected: its diagrams reach `ro_diagrams` through the
    // registry pass triggered on the next line, and their documents are examined
    // only inside that pass. Reporting health here reports on the shard, which is
    // never what the row means — and it latches, so the documents the pass then
    // queues have nothing left to retract it for the queue's full 120 s.
    //
    // `reconcileDiagramDocs` publishes at the end of that pass, which is the same
    // edge at a moment when it is true.
    //
    // Unconditional: the appended shard's diagrams reach `ro_diagrams` through
    // the registry pass, which re-extracts from the root. Cheap — one
    // coalescer for the whole registry — and root writes are rare (there are
    // exactly two in the client: this append, and setting `modelMetaUrl`).
    registryCoalescer.trigger()
  }
  const rootCoalescer = coalescedProjection('root sync', rootProjectLatest)
  const onRootChange = rootCoalescer.trigger
  rootHandle.on('change', onRootChange)
  cleanups.push(() => { rootCoalescer.dispose(); rootHandle.off('change', onRootChange) })

  // Monolith fallback (not sharded): re-extract + cold build on the model doc's change.
  if (!rootDoc.modelMetaUrl && rootDoc.modelUrl) {
    const modelHandle = await resolveHandle(rootDoc.modelUrl)
    const projectLatest = async () => {
      const m = await extractModelEntities(rootHandle.doc() as RootLike, resolve)
      await runTracked('monolith', (tx) => coldBuildReadModel(
        tx, key, orgId, m.objects, m.connections, m.groups, m.diagrams,
      ), { kind: 'reset', scope: 'all' }, fullExtractionIntegrity(m))
    }
    const coalescer = coalescedProjection('monolith reproject', projectLatest)
    const onChange = coalescer.trigger
    modelHandle.on('change', onChange)
    cleanups.push(() => { coalescer.dispose(); modelHandle.off('change', onChange) })
  } else if (rootDoc.modelMetaUrl) {
    // Groups (+ new shard urls) live on the meta doc.
    if (!metaHandle) throw new Error('ModelMeta handle is unavailable')
    const projectLatest = async () => {
      const meta = metaHandle.doc() as MetaLike
      rememberShardReferences(meta.objectShardUrls ?? [], meta.connectionShardUrls ?? [])
      const readGroups = readEntityMapOrDefect<GroupInput>(
        meta, 'groups', 'model-meta', rootDoc.modelMetaUrl ?? null)
      // Same rule as the shard deltas, and for the same reason: `syncGroups` is a
      // FULL sync, so passing it an empty list deletes every group row. A
      // ModelMeta with no `groups` key was never initialised — `splitModel`
      // always writes `groups: model.groups` and the server's sharded
      // `createEmptyRoot` writes `groups: {}` — so it is evidence of nothing.
      // `{ groups: {} }` still means "the user deleted them all" and still syncs.
      if (isUninformative(readGroups.defect)) {
        recordRefusedProjection()
        console.warn(
          `[read-model] refused a metadata projection for ${key.landscapeId}/${key.versionId}: ` +
            'its ModelMeta carries no groups map; group rows left untouched')
        return
      }
      const groups = Object.values(readGroups.map)
      // Every change of ModelMeta lands here — a group renamed (a Structurizr
      // system's boundary group follows the system's name), a tombstone, a new
      // overlay head — and each used to publish reset/all. The served rows it
      // can move: groups (all of them, before and after: a full sync), their
      // members' effective parent (members before and after) and their
      // structural parents, tombstoned objects and their neighbours, tombstoned
      // connections, and the diagram manifests that listed a tombstone.
      const tombstonedObjectIds = meta.deletedObjectIds ?? []
      const tombstonedConnectionIds = meta.deletedConnectionIds ?? []
      await runTracked('metadata', async (tx) => {
        let connections: ServedRowChanges = { upsertIds: [], deleteIds: [] }
        let objects: ServedRowChanges = { upsertIds: [], deleteIds: [] }
        // The tombstone deletes also rewrite the manifests that list them.
        const diagrams = await servedDiagramRowsChangedBy(tx, key,
          () => diagramIdsReferencing(tx, key, tombstonedObjectIds, tombstonedConnectionIds),
          async () => { objects = await servedObjectRowsChangedBy(tx, key, [
          ...groups.map((group) => group.id),
          ...groups.flatMap((group) => group.objectIds ?? []),
          ...tombstonedObjectIds,
          ...(await tx.query<{ id: string }>(
            `SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2
             UNION SELECT object_id FROM ro_group_objects WHERE landscape_id = $1 AND version_id = $2`,
            [key.landscapeId, key.versionId],
          )).rows.map((row) => row.id),
        ], async () => {
          await syncGroups(tx, key, orgId, groups)
          // Apply delete tombstones (boot-from-server deletes): idempotent — deleting an
          // already-gone row is a no-op. Covers base-shard-only objects the client can't
          // remove directly; the overlay-resident ones are also deleted via their shard delta.
          await deleteObjects(tx, key, tombstonedObjectIds)
          connections = await servedConnectionRowsChangedBy(tx, key, tombstonedConnectionIds,
            () => deleteConnections(tx, key, tombstonedConnectionIds))
        }) })
        return { objects, connections, diagrams }
      }, (changes): ReadModelChangePayload => ({ kind: 'exact', changes }),
      // GROUPS are re-sealed: `syncGroups` is a full sync of ro_groups.
      //
      // Objects and connections are only carried forward when this pass applies
      // NO tombstones — `deleteObjects`/`deleteConnections` return immediately on
      // an empty list, so on the overwhelmingly common path nothing of theirs
      // changes and their seals stay good. When there ARE tombstones the ids
      // removed are known but the resulting full set is not, so those kinds are
      // deliberately left to go un-comparable rather than guessed at.
      //
      // No `defects`: this reads ONE document, so its view is not the
      // workspace's. A defect on it is logged below instead.
      {
        digests: { group: digestOfIds(groups.map((group) => group.id)) },
        unchanged: [
          'diagram',
          ...((meta.deletedObjectIds ?? []).length === 0 ? ['object' as const] : []),
          ...((meta.deletedConnectionIds ?? []).length === 0 ? ['connection' as const] : []),
        ],
      })
      // A `field-not-a-map` reaches here rather than the refusal above: the field
      // WAS written, so its shape is corruption rather than absence, and the full
      // sync is at least acting on something a writer really produced.
      if (readGroups.defect) {
        console.warn(
          `[read-model] ModelMeta for ${key.landscapeId}/${key.versionId} has an unusable groups field: ` +
            summarizeModelDefects([readGroups.defect]))
      }
      // Watch newly-appended shards only after publication. Their initial
      // projection is a new serialized generation, never a nested one.
      // A shard that fails is recorded as a degradation and left out of the
      // watched set so the next meta change re-attempts it; it must neither be
      // silently accepted nor block the shards behind it.
      //
      // The same guard as the root path, over the LONGER of the two windows:
      // `applyInitial` sends both calls through `resolveHandleRetry`, whose
      // budget is `SHARD_ARRIVAL_TRIES` (20) rather than the root path's 3 —
      // ~219 s during which `degradedShards` is empty. The health beat must
      // not read that silence as a finished pass.
      await attachNewShards(meta)
    }
    /** Shards whose attach is running now — the meta pass and the retry
     * below can overlap, and a shard must not get two watchers. */
    const attachingShards = new Set<string>()
    /**
     * A FAILED ATTACH IS RETRIED (phase-3 review). It used to wait for the
     * next ModelMeta change, which may never come — and after a rotation the
     * shard that failed is the CURRENT head, so every edit to it stayed out of
     * `ro_*` (its attach reads the retirement rows, `freshRetirements`, and a
     * transient SQL error there was enough). Same capped backoff as a failed
     * forward; retried until an attach of every listed shard succeeds or the
     * projector stops. The degradation stays until then.
     */
    let attachRetry: { timer: ReturnType<typeof setTimeout> | null; attempt: number } | null = null
    const scheduleAttachRetry = (): void => {
      if (stopped || attachRetry?.timer) return
      const attempt = (attachRetry?.attempt ?? 0) + 1
      const delay = FORWARD_RETRY_DELAYS_MS[Math.min(attempt, FORWARD_RETRY_DELAYS_MS.length) - 1]
      const timer = setTimeout(() => {
        attachRetry = { timer: null, attempt }
        if (stopped) return
        const latest = metaHandle.doc() as MetaLike | undefined
        if (latest) void attachNewShards(latest)
      }, delay)
      timer.unref?.()
      attachRetry = { timer, attempt }
    }
    cleanups.push(() => {
      if (attachRetry?.timer) clearTimeout(attachRetry.timer)
      attachRetry = null
    })
    /** product url -> the sources it replaces, for every fold product this
     * projector attached mid-session (`ordinaryChainFold.ts`). */
    const foldSourcesByProduct = new Map<string, string[]>()
    /** Sources whose writes are not all served yet (`ordinaryChainFold.ts`,
     * SETTLED). Called after the record check, so every source's row is
     * `folded` and forwards: a source is settled when its live heads equal
     * its committed `forwarded_heads` (or H_r), read FRESH after sampling
     * them (`ordinaryHeadLateWritesPending`; a forward in flight reads as
     * pending). The current write head, or a source whose heads cannot be
     * read, is never settled. */
    const unsettledFoldSources = async (kind: 'object' | 'connection', sources: readonly string[]): Promise<string[]> => {
      const latest = metaHandle.doc() as MetaLike | undefined
      const current = kind === 'object' ? latest?.editsObjectShardUrl : latest?.editsConnectionShardUrl
      const unsettled: string[] = []
      const sampled: Array<{ url: string; documentId: string; heads: string[]; current: false }> = []
      for (const source of sources) {
        const entry = shardStops.get(source)
        const heads = entry && source !== current ? tryGetHeads((await resolveHandle(source, 'fold-settle')).doc()) : null
        if (!entry || !heads) { unsettled.push(source); continue }
        sampled.push({ url: source, documentId: entry.documentId, heads: [...heads], current: false })
      }
      const pending = new Set(await ordinaryHeadLateWritesPending(db, key, kind, sampled))
      return [...unsettled, ...sampled.filter((source) => pending.has(source.documentId)).map((source) => source.url)]
    }
    /** A fold product is attached with its live content as the baseline,
     * never applied: see `ordinaryChainFold.ts`. Null: not a fold product. */
    const foldProductSeed = async <T>(
      url: string,
      field: 'objects' | 'connections',
      watched: readonly string[],
    ): Promise<{ map: Record<string, T>; heads: readonly string[] | null; sources: string[] } | null> => {
      const h = await resolveHandleRetry(url, 'fold-product')
      const doc = h.doc()
      const sources = ordinaryFoldSourcesOf(doc)
      if (!sources) return null
      const latest = metaHandle.doc() as MetaLike | undefined
      const current = field === 'objects' ? latest?.editsObjectShardUrl : latest?.editsConnectionShardUrl
      if (current === url) throw new Error(`fold product ${url} is the current write head`)
      const unwatched = sources.filter((source) => !watched.includes(source))
      if (unwatched.length) {
        throw new Error(`${ORDINARY_FOLD_SOURCES_NOT_WATCHED}: ${url} replaces ${unwatched.join(', ')}`)
      }
      // The marker is a claim in a client-writable document; the record is the
      // authority (`ordinaryChainFold.ts`, step 2).
      // Read FRESH, not from `retirements`: that cache reloads only when a
      // write-head pointer moves, and a fold moves none.
      const kind = field === 'objects' ? 'object' : 'connection'
      const sourceIds = sources.map((source) => shardStops.get(source)?.documentId ?? source)
      const record = await readOrdinaryChainFold(db, key, kind, h.documentId)
      const rows = await loadOrdinaryHeadRetirements(db, key)
      const refusal = ordinaryFoldRecordRefusal(record, sourceIds,
        (documentId) => rows.get(retirementKey(kind, documentId)))
      if (refusal) throw new Error(`${refusal}: ${url} replaces ${sources.join(', ')}`)
      const unsettled = await unsettledFoldSources(kind, sources)
      if (unsettled.length) {
        throw new Error(`${ORDINARY_FOLD_SOURCES_NOT_SETTLED}: ${url} replaces ${unsettled.join(', ')}`)
      }
      const read = readEntityMapOrDefect<T>(doc, field, field === 'objects' ? 'object-shard' : 'connection-shard', url)
      if (read.defect) throw new Error(`fold product ${url}: ${summarizeModelDefects([read.defect])}`)
      return { map: read.map, heads: tryGetHeads(doc), sources }
    }
    /** Stop watching a folded source and give its lease back. What reaches it
     * after this is not projected or forwarded by this projector (phase 4.4). */
    /** Is `url` in the LATEST ModelMeta, and not a source this projector
     * detached? A retry pass iterates the ModelMeta it started on. */
    const stillListed = (kind: 'object' | 'connection', url: string): boolean => {
      if (detachedFoldSources.has(url)) return false
      const latest = metaHandle.doc() as MetaLike | undefined
      return Boolean((kind === 'object' ? latest?.objectShardUrls : latest?.connectionShardUrls)?.includes(url))
    }
    /** The sources of one kind a pass detaches, TOGETHER: their watchers
     * stopped and waited for, their state cleared, ONE batch of watermark
     * statements for all of them (`watermarkDetachedFoldSources`), then
     * every lease given back in the same synchronous turn.
     *
     * Whatever throws on the way, every source already taken out of the
     * watched set is FINISHED in the `finally` — its state cleared, its lease
     * given back, out of `foldSourcesDetaching` (which the poll and the
     * re-check skip), the poll started — so a late write to it is still found
     * in storage. Without a watermark (the throw came first, or none could
     * be set) its row keeps NULL: the poll reloads it, the safe direction. */
    const detachFoldSources = async (urls: readonly string[], watched: string[], kind: 'object' | 'connection'): Promise<void> => {
      const detaching: Array<{ url: string; entry: ReturnType<typeof shardStops.get> }> = []
      let watermarks = new Map<string, string>()
      let idled = false
      /** The watermark step ran (it flushes, whatever happens inside it). */
      let watermarked = false
      const clearState = (url: string, entry: ReturnType<typeof shardStops.get>) => {
        degradedShards.delete(url)
        forwardDegradedUrls.delete(url)
        model.objectsByShardUrl.delete(url)
        model.connectionsByShardUrl.delete(url)
        model.objectShardHeadsByUrl.delete(url)
        model.connectionShardHeadsByUrl.delete(url)
        if (!entry) return
        const retry = forwardRetries.get(entry.documentId)
        if (retry) clearTimeout(retry.timer)
        forwardRetries.delete(entry.documentId)
        publishedHeadsByDocument.delete(entry.documentId)
        // A stamp waiting for THIS head's projection is never consumed now;
        // the watermark it would have certified stays refused (the safe
        // direction) until a cold build. A stamp keyed BY this head and
        // targeting another stays: `liveHeadsForStamp` refuses an unlisted
        // head, so it certifies 0.
        for (const [retiredId, stamp] of retiredHeadStamps) {
          if (stamp.target === entry.documentId) retiredHeadStamps.delete(retiredId)
        }
      }
      try {
        for (const url of urls) {
          const latest = metaHandle.doc() as MetaLike | undefined
          if ((kind === 'object' ? latest?.editsObjectShardUrl : latest?.editsConnectionShardUrl) === url) {
            degradeShard(url, kind === 'object' ? 'object_shard' : 'connection_shard',
              new Error(`fold source ${url} is the current write head; not detached`))
            continue
          }
          // Out of the watched set FIRST, synchronously: a concurrent attach
          // pass then skips it (`detachedFoldSources`) for the whole wait
          // below, and the folded-head poll skips it until the detach is done.
          detachedFoldSources.add(url)
          foldSourcesDetaching.add(url)
          const at = watched.indexOf(url)
          if (at >= 0) watched.splice(at, 1)
          const entry = shardStops.get(url)
          shardStops.delete(url)
          // Listed for the `finally` BEFORE its stop, which may throw.
          detaching.push({ url, entry })
          // Stop future passes; the one in flight is waited for below.
          entry?.stop()
        }
        // WAIT for the passes in flight — all of them, whatever one does: a
        // forward parked on an await would otherwise resume after the state
        // below is cleared — re-degrading, re-scheduling, re-noting it — and on
        // a document the release has just evicted.
        await Promise.allSettled(detaching.map(({ entry }) => entry?.idle()))
        idled = true
        for (const { url, entry } of detaching) clearState(url, entry)
        // Still resident and leased: the watermark set here spares the poll a
        // full reload of heads this detach is about to evict (G4-16, M3).
        watermarked = true
        watermarks = await watermarkDetachedFoldSources(kind,
          detaching.flatMap(({ entry }) => (entry ? [entry.documentId] : [])))
      } finally {
        // After a throw that came first, the same two duties as above before
        // any lease goes. Every pass in flight is waited for: one parked on an
        // await would resume on cleared state and an evicted document. (A pass
        // starting later returns at once: `detachedFoldSources`.)
        if (!idled) await Promise.allSettled(detaching.map(({ entry }) => entry?.idle()))
        // And every resident source is flushed: the eviction drops a change
        // whose save has not started (it refuses only a FAILED save).
        // Best-effort: what it cannot save stays to the eviction's own guard.
        if (!watermarked) {
          const ids = detaching.flatMap(({ entry }) =>
            (entry && syncedHandle(repo, entry.documentId)?.state === 'ready' ? [entry.documentId] : []))
          if (ids.length) {
            await repo.flush(ids).catch((error: unknown) => {
              console.warn(JSON.stringify({
                event: 'read_model.ordinary_fold_source_watermark_failed',
                workspace: `${key.landscapeId}/${key.versionId}`,
                kind,
                documentIds: ids,
                error: error instanceof Error ? error.message : String(error),
              }))
            })
          }
        }
        // Idempotent: cleared again after a throw that came before it.
        for (const { url, entry } of detaching) clearState(url, entry)
        // Synchronous from the last flush of the batch to every eviction
        // `release` starts.
        for (const { entry } of detaching) {
          if (entry && residency && leasedDocumentIds.delete(entry.documentId)) residency.release(entry.documentId, residencyOwner)
        }
        for (const { url, entry } of detaching) {
          foldSourcesDetaching.delete(url)
          console.log(JSON.stringify({
            event: 'read_model.ordinary_fold_source_detached',
            workspace: `${key.landscapeId}/${key.versionId}`,
            kind,
            url,
            // The watermark this detach KNOWS it set; null otherwise — also
            // after a commit that succeeded but threw on the client, whose
            // row then holds S while this says null (the poll reads the row).
            watermark: (entry && watermarks.get(entry.documentId)) ?? null,
          }))
        }
        // From here a late write to them is found in storage, not by a
        // watcher; one pass now covers what arrived between the settle check
        // and here.
        if (detaching.length) startFoldedArrivalPoll()
      }
    }
    const attachNewShards = async (meta: MetaLike): Promise<void> => {
      let failed = false
      await withReconciling(async () => {
        for (const url of meta.objectShardUrls ?? []) {
          // No `stopped` check here: the meta pass's behaviour after `stop()`
          // is unchanged (pinned by "does not MARK degraded after it is
          // stopped either", `projectorService.test.ts`); the RETRY checks it.
          if (model.objectShardUrls.includes(url) || attachingShards.has(url)) continue
          if (!stillListed('object', url)) continue
          attachingShards.add(url)
          try {
            const seed = await foldProductSeed<ObjectInput>(url, 'objects', model.objectShardUrls)
            if (seed) {
              await watchObjectShard(url, false, seed.map, seed.heads)
              foldSourcesByProduct.set(url, seed.sources)
            } else {
              await watchObjectShard(url, true)
            }
            model.objectShardUrls.push(url)
            degradedShards.delete(url)
          } catch (error) {
            console.error('[read-model] new object shard initial apply failed', error)
            degradeShard(url, 'object_shard', error)
            if (!isReadModelAuthorityLoss(error)) failed = true
          } finally {
            attachingShards.delete(url)
          }
        }
        for (const url of meta.connectionShardUrls ?? []) {
          if (model.connectionShardUrls.includes(url) || attachingShards.has(url)) continue
          if (!stillListed('connection', url)) continue
          attachingShards.add(url)
          try {
            const seed = await foldProductSeed<ConnectionInput>(url, 'connections', model.connectionShardUrls)
            if (seed) {
              await watchConnectionShard(url, false, seed.map, seed.heads)
              foldSourcesByProduct.set(url, seed.sources)
            } else {
              await watchConnectionShard(url, true)
            }
            model.connectionShardUrls.push(url)
            degradedShards.delete(url)
          } catch (error) {
            console.error('[read-model] new connection shard initial apply failed', error)
            degradeShard(url, 'connection_shard', error)
            if (!isReadModelAuthorityLoss(error)) failed = true
          } finally {
            attachingShards.delete(url)
          }
        }
        // After the attaches: a source is detached only once the product that
        // replaces it is attached, so no value is ever served by neither.
        // Against the LATEST ModelMeta, not the one this pass started on.
        const latest = metaHandle.doc() as MetaLike | undefined
        for (const product of foldSourcesByProduct.keys()) {
          if (!latest?.objectShardUrls?.includes(product) && !latest?.connectionShardUrls?.includes(product)) {
            foldSourcesByProduct.delete(product)
          }
        }
        await detachFoldSources(foldSourcesToDetach(model.objectShardUrls, latest?.objectShardUrls ?? [], foldSourcesByProduct),
          model.objectShardUrls, 'object')
        await detachFoldSources(foldSourcesToDetach(model.connectionShardUrls, latest?.connectionShardUrls ?? [], foldSourcesByProduct),
          model.connectionShardUrls, 'connection')
      })
      if (failed) scheduleAttachRetry()
      else if (!attachRetry?.timer) attachRetry = null
      // Outside the guard, and that is the point: inside it this call would
      // return at `reconciling > 0` and do nothing (see the end of
      // `reconcilePass`).
      clearDegradationIfRecovered()
    }
    const coalescer = coalescedProjection('meta sync', projectLatest)
    const onChange = coalescer.trigger
    metaHandle.on('change', onChange)
    cleanups.push(() => { coalescer.dispose(); metaHandle.off('change', onChange) })
  }

  // ------------------------------------------------------------------
  // Detach on evict, re-attach while resident.
  //
  // Diagram documents are deliberately NOT leased. Typical residency sits at
  // 17-18 resident handles; leasing a 30k-diagram workspace
  // would pin three orders of magnitude more against an unreclaimable WASM
  // high-water mark. It is also unnecessary: `evict()` already refuses any
  // document with an active peer, so a lease would only protect documents that
  // are idle AND peerless — exactly the ones that cannot be receiving changes.
  //
  // The contract instead is: let the sweep evict, drop our watcher when it does
  // (so the closure stops retaining the dead handle), and re-attach when the
  // document comes back. Detach without re-attach silently stops projecting;
  // re-attach without detach reclaims nothing, because the watcher closure still
  // holds the DocHandle. Neither half is meaningful alone.
  // ------------------------------------------------------------------
  if (residency) {
    // SYNCHRONOUS: the residency discards the return value and runs listeners
    // inside the caller's turn, so anything async here happens after the handle
    // is already gone.
    const untrack = residency.onBeforeEvict((documentId) => {
      const url = diagramUrlByDocumentId.get(documentId)
      if (!url) return
      // Key strictly on THIS projector's map. The listener set is process-wide —
      // one residency shared by the whole fleet — so another workspace's
      // eviction must not tear down our watcher.
      const watcher = diagramWatchers.get(url)
      if (!watcher) return
      watcher.stop()
      diagramWatchers.delete(url)
      // KEEP the documentId -> url mapping. It is what the resident sweep
      // iterates to notice the document has come back; deleting it here makes
      // the detach permanent and turns this half of the fix into the very bug
      // it removes. The mapping stays valid because a reopened document keeps
      // its documentId. `forgetDiagramResidency` drops it when the diagram is
      // genuinely unlinked.
      // Evicting the last document this workspace was known to owe leaves
      // nothing outstanding, so the health report has to be re-derived here.
      // Both lines are needed: the delete makes the statement true, and the
      // publish makes anyone else able to see it. Neither happens on its own —
      // the retry queue is not involved in an eviction, so `onIdle` does not
      // fire, and no change necessarily follows on a workspace being evicted.
      degradedDocuments.delete(url)
      clearDegradationIfRecovered()
    })
    // Pushed BEFORE releaseOwner below. Without this the shared residency
    // accumulates one closure per projector start, and under fleet LRU churn
    // (cap 8) that is a leak of its own.
    cleanups.push(untrack)

    if (residentSweepMs > 0) {
      // A POLL, not an event. `Repo` declares a `document` event and never
      // emits it, so `repo.on('document', ...)` would never fire.
      const residentSweep = setInterval(() => {
        // No hoisted handle table: `diagramWatchers.has(url)` below
        // `continue`s BEFORE any lookup, so at steady state — every diagram
        // watched — this tick does no work at all. Each surviving lookup is
        // O(1).
        for (const [documentId, url] of diagramUrlByDocumentId) {
          if (diagramWatchers.has(url)) continue
          // A document the bounded retry queue has already GIVEN UP on is not
          // this loop's business.
          //
          // Otherwise the queue's abandonment becomes reachable in a cycle:
          // `project()`'s catch degrades as `registry`,
          // `onDiagramRetryAbandoned` degrades as `document_resolution`, and
          // `publishDegradation` deduplicates by KIND — so the two alternating
          // kinds defeat the dedup and each cycle (~6-8 s) writes the health row
          // TWICE, unbounded, against "one row write per incident". Re-attaching
          // a failing document every tick would also silently defeat the
          // `DIAGRAM_REPROJECTION_ATTEMPTS` budget from outside.
          //
          // Consequence: a degraded document that is then evicted will NOT be
          // re-attached by this loop. It is already
          // reported degraded, and the recovery is a registry change (any
          // `reconcileDiagramDocs` pass re-attaches it and `forgetDiagramDoc`
          // clears the flag on success) or a restart. "Abandoned" means the same
          // thing here as it does everywhere else in this file.
          if (degradedDocuments.has(url)) continue
          // Never `repo.find()` a document this process does not already hold:
          // absent means unloaded, so nothing can be missed, and re-resolving
          // would fight the idle sweep for the handle it just reclaimed.
          const handle = syncedHandle(repo, documentId)
          if (!handle || handle.state !== 'ready') continue
          const diagram = lastKnownDiagram.get(url)
          if (!diagram) continue
          // Through `tryAttachDiagramDoc`, NOT `attachDiagramDoc`.
          //
          // A url is owned by exactly one of: an attached watcher, an in-flight
          // attempt, or the retry queue. Checking only the watcher is not
          // enough: `diagramWatchers.set` runs LAST, at the end of
          // `projectThenWatch` after `await project()`, so any projection slower
          // than a tick would let this loop re-enter every `residentSweepMs`,
          // and a document already in `documentRetries` would get a concurrent
          // attach on every tick.
          //
          // Each such attempt would register a DISTINCT `coalescer.trigger`
          // closure via `handle.on('change', …)` (`DocHandle.on` deduplicates by
          // IDENTITY), while `diagramWatchers` keeps only the last — so the
          // earlier listeners would survive `stop()` and keep projecting for a
          // workspace this projector no longer serves, and trip
          // `automerge.orphaned_listener_evicted` on the next eviction.
          //
          // `documentRetries.signal` is aborted by `stop()` and by nothing else
          // — the same signal `reconcilePass` hands its attaches. It does NOT
          // make the attach cancellable: it bounds the `repo.find` and nothing
          // after it, so the teardown window is closed by the `stopped` guard in
          // `projectThenWatch`. Its only effect is to let an in-flight
          // `repo.find` give up at `stop()` instead of running out its
          // `deadlineMs` — consistency with `reconcilePass`, not a safety
          // property.
          void tryAttachDiagramDoc(diagram, documentRetries.signal).catch((error) => {
            // Cannot fire today: `tryAttachDiagramDoc` catches, and every branch
            // of `handleDiagramAttachFailure` returns. It is here because this
            // is a `setInterval` callback, where an unhandled rejection ends the
            // process, and the contract it would be relying on lives in another
            // function that nothing stops a later edit from changing.
            warnOnceAboutDiagram(url, `re-attach after eviction failed: ${String(error)}`)
          })
        }
      }, residentSweepMs)
      residentSweep.unref?.()
      cleanups.push(() => clearInterval(residentSweep))
    }
  }

  // The workspace's only regular BEAT, and the health report needs one.
  //
  // Every other caller is driven by a change, and the case that needs this is a
  // workspace with NO changes: a degradation held back by a transient ownership
  // gap (see `publishDegradation`) would otherwise wait for a new incident that
  // never arrives, and a recovery that completes after the last change would go
  // unreported for the same reason.
  //
  // Its own timer, deliberately NOT folded into the resident sweep: that sweep
  // exists only when a residency is configured, and health reporting must not
  // depend on an unrelated subsystem being present. Nearly free — `stopped`,
  // `healthPublished` and the outstanding sets all short-circuit before any
  // statement is issued, so a healthy workspace costs one `stillOwned()` per
  // tick and zero SQL.
  //
  // NOT gated on `residentSweepMs > 0` either: that is the sweep's own disable
  // switch (and `Number('x') > 0` is false, so a typo
  // trips it too), and turning the re-attach poll off must not silently remove
  // the ONLY flush path a quiet workspace has. It borrows the sweep's cadence
  // when one is configured purely so tests can drive both from one knob.
  const healthBeatMs = residentSweepMs > 0 ? residentSweepMs : DEFAULT_HEALTH_BEAT_MS
  // The flush runs HERE and nowhere else — see `flushHeldDegradation` for why.
  // Order matters: a
  // re-issued mark lowers `healthPublished`, and the publish below must see
  // that, so the flush goes first.
  const healthBeat = setInterval(() => {
    flushHeldDegradation()
    publishHealthIfNothingOutstanding()
  }, healthBeatMs)
  healthBeat.unref?.()
  cleanups.push(() => clearInterval(healthBeat))

  // A degradation must not outlive the projector that recorded it: a FRESH
  // projector must be able to retract a row written by an earlier process.
  //
  // So the health publish does NOT depend on this write having landed. Gating
  // the clear on `projector_instance_id` naming this projector fails both
  // ways: `reconcileDiagramDocs` publishes health during the cold build,
  // before this line, and a write that fails (or commits and loses its ack)
  // would leave such a gate shut forever. Ownership is checked through
  // `stillOwned`, which is process-local and does not depend on any write
  // succeeding, so this call is telemetry only.
  await markReadModelProjectorAttached(db, key, orgId, projectorInstanceId)
    .catch((error) => console.error('[read-model] failed to mark projector attached', error))

  // A legacy registry can reference a DiagramDoc that was never durably
  // published. Its optional flow projection must not hold every core read-model
  // route in a perpetual 503, and must not cost one timer plus one unbounded
  // retry loop per missing document. Probe each one ONCE — the core model is
  // committed and every shard is watched by now — and hand the missing ones to
  // the queue.
  //
  // NOT AWAITED, deliberately. Nothing below depends on the diagram watchers:
  // the object, connection, registry and root watchers above are attached from
  // already-leased handles. What makes deferring safe is the `reconciling`
  // counter inside `reconcileDiagramDocs` — `publishHealthIfNothingOutstanding`
  // refuses to speak while a pass is in flight, so an in-progress probe can
  // never be read as a healthy workspace.
  initialDiagramProbes.set(keyOf(key), reconcileDiagramDocs(model.diagrams).catch((error) => {
    console.error(`[read-model] diagram reconcile failed for ${key.landscapeId}/${key.versionId}`, error)
  }))

  // Deliberately NOT unconditional. Reaching here means the cold build committed
  // and every shard is watched, but diagram documents that have not synced yet
  // are sitting in `documentRetries` — outstanding work, not a healthy
  // workspace — so this is a no-op until the queue drains, and `onIdle` calls it
  // again when it does.
  publishHealthIfNothingOutstanding()

  // From here on, a lost fence is a RESIDENT projector losing its workspace —
  // the recycle hook is the recovery. Before this line it was a failed boot,
  // which the throw already reports.
  bootComplete = true
  // A chain already long at attach folds without waiting for a rotation.
  requestFold('object')
  requestFold('connection')
  // Folded heads from an earlier life are never attached: poll them.
  if ([...retirements.values()].some((row) => row.status === 'folded')) startFoldedArrivalPoll()
  // Fold off: retired heads are parked once settled (`parkRetiredHead`).
  startRetiredHeadParkSweep()
  // G4-16e: what this projector already holds, published by the stats route
  // and /metrics (`ordinaryRotationTelemetry.ts`). Rotating workspaces only,
  // and only while this cell still owns it: a build that finished after its
  // ownership moved must neither publish the workspace nor log its chain
  // alert from a cell that no longer serves it (the fleet stops it next).
  if (headRotation.rotates && stillOwned()) {
    cleanups.push(ordinaryRotationTelemetry.register(key, {
      listed: listedChain,
      parkedHeads: (kind) => {
        let count = 0
        for (const entry of parkedRetiredHeads.values()) if (entry.kind === kind) count += 1
        return count
      },
      rows: (kind) => {
        let retired = 0
        let folded = 0
        const createdAtMs: number[] = []
        for (const row of retirements.values()) {
          if (row.collection !== kind) continue
          if (row.status === 'retired') retired += 1
          else if (row.status === 'folded') folded += 1
          else continue
          // A fold PRODUCT's row is no rotation (G4-16e); NULL (older rows)
          // counts as one — see the backfill in `schema.ts`.
          if (row.createdAtMs !== undefined && row.origin !== 'fold-product') createdAtMs.push(row.createdAtMs)
        }
        return { retired, folded, createdAtMs }
      },
      currentHead: (kind) => {
        const meta = metaHandle?.doc() as MetaLike | undefined
        return headRotation.lastObserved(kind, kind === 'object' ? meta?.editsObjectShardUrl : meta?.editsConnectionShardUrl)
      },
    }))
    observeChainLength('object')
    observeChainLength('connection')
  }
  // A previous owner's save may still commit below a watermark this
  // projector moves (G4-16d): every retired head is re-checked from storage
  // once, `handoverRecheckMs` from now.
  armHandoverRecheck()
  attachDone = true
  // One line for the attach's own loads (G4-16 M3, `documentLoadTelemetry.ts`).
  // `ms` is the SUM of each load's wall time (storage read included); loads
  // run concurrently during an attach, so it overstates the time they took.
  console.log(JSON.stringify({
    event: 'read_model.attach_document_loads',
    workspace: `${key.landscapeId}/${key.versionId}`,
    loads: attachLoads.loads,
    ms: Math.round(attachLoads.ms),
  }))

  return () => {
    if (stopped) return
    stopped = true
    for (const fn of cleanups) fn()
    residency?.releaseOwner(residencyOwner)
    void markReadModelProjectorDetached(db, key, projectorInstanceId)
      .catch((error) => console.error('[read-model] failed to mark projector detached', error))
  }
}

// =====================================================================
// ProjectorFleet — per-workspace supervisor (LRU-capped).
// =====================================================================

const DEFAULT_WORKSPACE_KEY: WorkspaceKey = { landscapeId: 'default', versionId: 'current' }

/** `READ_MODEL_MAX_PROJECTORS`: LRU of N concurrent per-workspace projectors,
 * cold-start-on-demand beyond the cap — bounded memory traded for first-query
 * latency. */
const DEFAULT_MAX_PROJECTORS = 8
function maxProjectors(): number {
  const n = Number(process.env.READ_MODEL_MAX_PROJECTORS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PROJECTORS
}

function keyOf(k: WorkspaceKey): string {
  return `${k.landscapeId}/${k.versionId}`
}

interface FleetEntry {
  key: WorkspaceKey
  stop: () => void
  /** This projector's `projector_instance_id` — see `residentProjectorInstanceId`. */
  projectorInstanceId: string | null
  /** Bumped on every `ensure()` hit — the LRU recency signal. */
  lastUsed: number
  /** Pinned entries are never fleet eviction candidates. Ownership loss still
   * detaches them. */
  pinned?: boolean
}

/** Resolves a workspace key to its Automerge root URL, or null if it doesn't
 * exist. Matches `resolveRootUrl`'s shape (server/src/landscapes.ts) without
 * this module importing it directly — landscapes.ts already imports
 * docScope.ts which the RBAC layer wires in, and projectorService.ts is a
 * lower-level primitive than landscapes.ts; injecting the resolver avoids a
 * layering/import-cycle risk while keeping the fleet trivially testable with a
 * fake resolver. `wireProjectorFleet` (below) is the production wiring that
 * passes the real `resolveRootUrl`. */
export type RootResolver = (landscapeId: string | undefined, versionId: string | undefined, fallbackRootUrl: string) => Promise<string | null>

export interface ProjectorFleetOptions {
  /** The legacy default root — same fallback `resolveRootUrl` already uses for
   * the (undefined, undefined) default-workspace lookup, so `ensure(defaultKey)`
   * keeps the default-workspace boot behaviour. */
  fallbackRootUrl: string
  db?: Queryable
  maxProjectors?: number
  /** Shared with the default-workspace boot/compaction paths in production so
   * every cross-workspace cold start consumes the same process-wide budget. */
  coldBuildAdmission?: ColdBuildAdmission
  /** Test seam for deterministic admission/shutdown tests. */
  startProjector?: typeof startReadModelProjector
  /** Shared document lease registry; production uses it to make projector
   * listener residency visible to the idle-eviction sweep. */
  residency?: AutomergeResidencyLeases
  /** Fail-closed ownership admission. Production injects the sync-cell lease
   * check; singleton/tests may omit it. It is checked before AND after each
   * cold build so a lease lost mid-build cannot attach listeners. */
  ownsWorkspace?: (key: WorkspaceKey) => boolean
  /** "Is this workspace served by the STATIC projector?" — the summary-world
   * refusal. Defaults to a
   * `read_model_static_workspaces` lookup on `db`; injectable so the refusal
   * can be tested without a schema. */
  isStaticWorkspace?: (key: WorkspaceKey) => Promise<boolean>
  /** Production passes the value `index.ts` parsed at boot, where an invalid
   * `AM_ORDINARY_HEAD_ROTATION` refuses to start; defaults to the same parse. */
  ordinaryHeadRotation?: OrdinaryHeadRotationConfig
}

export interface ProjectorFleetSnapshot extends ColdBuildAdmissionSnapshot {
  residentProjectors: number
  inFlightWorkspaces: number
  maxProjectors: number
  fleetStopped: boolean
  foreignResidentProjectors: number
  ownershipRejectedStarts: number
  ownershipEvictions: number
  /** Projection passes rolled back on a lost write fence. Non-zero
   * means another instance took a workspace this fleet still had resident —
   * each one also triggers a recycle of the losing projector. */
  writeFenceAborts: number
}

export class ProjectorOwnershipError extends Error {
  readonly code = 'read_model_workspace_not_owned'
  readonly retryable = true

  constructor() {
    super('Read-model workspace is not owned by this sync cell')
    this.name = 'ProjectorOwnershipError'
  }
}

/**
 * The ORDINARY projector refuses a STATIC (summary) workspace.
 *
 * Two writers on one workspace's `ro_*` rows is the sneaky failure of the
 * summary migration: the ordinary projector walks the Automerge graph and the
 * `StaticDeltaProjector` applies deltas over a materialised baseline, and their
 * generations advance independently — so a workspace with both resident sees
 * its read model rebuilt from a graph the summary contract no longer keeps
 * loaded, erasing exactly the rows the static world serves.
 *
 * The promotion primitive detaches the ordinary projector explicitly
 * (`promoteSummaryWorkspace` step 4); THIS is the half that stops a concurrent
 * `ensure()` from putting it straight back. Both are needed: the explicit
 * detach handles the projector that is already resident, the refusal handles
 * every attach after it.
 *
 * NOT retryable — unlike an ownership loss, no amount of waiting makes this
 * workspace ordinary again. Callers treat it as "nothing to attach here".
 */
export class ProjectorStaticWorkspaceError extends Error {
  readonly code = 'read_model_workspace_is_static'
  readonly retryable = false

  constructor(key: WorkspaceKey) {
    super(
      `Read-model workspace ${key.landscapeId}/${key.versionId} is static (summary): it is served by the `
      + 'StaticDeltaProjector, and an ordinary projector attached alongside would double-write its ro_* rows',
    )
    this.name = 'ProjectorStaticWorkspaceError'
  }
}

/**
 * Supervises one live projector per ACTIVE workspace, capped at
 * `READ_MODEL_MAX_PROJECTORS` (default 8) resident at a time. Beyond the cap,
 * the least-recently-used projector is evicted (listeners detached) to make
 * room — its Postgres rows are left in place (the read model is a durable
 * cache keyed by workspace, not something eviction should erase), and a later
 * `ensure()` of that workspace re-walks it (idempotent upsert + prune), so the
 * only cost of eviction is first-query latency on the next access, never data
 * loss.
 *
 * `ensure()` calls for the SAME key in flight share one promise (memoized),
 * so concurrent requests for a cold workspace don't cold-build it twice. A
 * projector is NEVER evicted mid-cold-build — eviction only considers entries
 * already resident in `byKey` (a cold build only registers itself there once
 * `startReadModelProjector` resolves), so an in-flight build always finishes
 * before it could be picked as the eviction victim.
 */
export class ProjectorFleet {
  private readonly repo: Repo
  private readonly resolveRoot: RootResolver
  private readonly db: Queryable
  private readonly fallbackRootUrl: string
  private readonly cap: number
  private readonly coldBuildAdmission: ColdBuildAdmission
  private readonly startProjector: typeof startReadModelProjector
  private readonly ownsWorkspace: (key: WorkspaceKey) => boolean
  private readonly isStaticWorkspace: (key: WorkspaceKey) => Promise<boolean>
  private readonly residency?: AutomergeResidencyLeases
  private readonly ordinaryHeadRotation: OrdinaryHeadRotationConfig

  private readonly byKey = new Map<string, FleetEntry>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly generations = new Map<string, number>()
  private readonly pinnedKeys = new Set<string>()
  private clock = 0
  private stopped = false
  private ownershipRejectedStarts = 0
  private ownershipEvictions = 0
  private writeFenceAborts = 0
  constructor(repo: Repo, resolveRoot: RootResolver, opts: ProjectorFleetOptions) {
    this.repo = repo
    this.resolveRoot = resolveRoot
    this.db = opts.db ?? pool
    this.fallbackRootUrl = opts.fallbackRootUrl
    this.cap = opts.maxProjectors ?? maxProjectors()
    this.coldBuildAdmission = opts.coldBuildAdmission ?? new ColdBuildAdmission(coldBuildAdmissionConfig())
    this.startProjector = opts.startProjector ?? startReadModelProjector
    this.ownsWorkspace = opts.ownsWorkspace ?? (() => true)
    this.isStaticWorkspace = opts.isStaticWorkspace ?? (async (key) => {
      // A `db` with no `query` is a unit-test double for a fleet that never
      // reaches SQL (ownership/admission suites); a schema with no static
      // tables (42P01) is a stack that HAS no static world. Neither is a
      // static workspace. Anything else propagates — a fleet that cannot tell
      // must not guess, and the caller of `ensure()` already handles a throw.
      if (typeof (this.db as { query?: unknown })?.query !== 'function') return false
      try {
        return await isStaticReadModelWorkspace(this.db, key)
      } catch (error) {
        if ((error as { code?: string }).code === '42P01') return false
        throw error
      }
    })
    this.residency = opts.residency
    this.ordinaryHeadRotation = opts.ordinaryHeadRotation ?? ordinaryHeadRotationConfig()
  }

  /** Keep a fleet-managed workspace resident across LRU pressure. Ownership
   * loss still overrides the pin and detaches it immediately. */
  pin(key: WorkspaceKey): void {
    const k = keyOf(key)
    this.pinnedKeys.add(k)
    const entry = this.byKey.get(k)
    if (entry) entry.pinned = true
  }

  /** Ensure a workspace has a live projector, starting one (cold build +
   * listeners) if needed. Returns false if the workspace doesn't resolve to a
   * root (caller should 404) — true otherwise, including when a projector was
   * already resident. Memoized per key: concurrent callers for the same
   * not-yet-resident workspace share one in-flight ensure. */
  async ensure(key: WorkspaceKey): Promise<boolean> {
    if (this.stopped) throw new ColdBuildAdmissionStoppedError()
    const k = keyOf(key)
    if (!this.ownsWorkspace(key)) {
      this.ownershipRejectedStarts += 1
      this.release(key, 'ownership-rejected')
      throw new ProjectorOwnershipError()
    }
    const existing = this.byKey.get(k)
    if (existing) {
      existing.lastUsed = ++this.clock
      return true
    }
    const inflight = this.inFlight.get(k)
    if (inflight) return inflight

    const generation = this.generations.get(k) ?? 0
    const p = this.coldBuildAdmission.run(() => this.start(key, k, generation)).finally(() => {
      if (this.inFlight.get(k) === p) this.inFlight.delete(k)
    })
    this.inFlight.set(k, p)
    return p
  }

  private async start(key: WorkspaceKey, k: string, generation: number): Promise<boolean> {
    this.assertStartAllowed(key, k, generation)
    // BEFORE resolving a root or admitting a cold build: a summary workspace
    // belongs to the StaticDeltaProjector, and two writers on one workspace's
    // ro_* rows advance generations independently (see
    // ProjectorStaticWorkspaceError). The promotion primitive's explicit
    // `release()` and this refusal are the two halves of the same guard.
    if (await this.isStaticWorkspace(key)) throw new ProjectorStaticWorkspaceError(key)
    // The public default 'current' sentinel resolves via the exact
    // (undefined, undefined) + fallback-root path `resolveRootUrl` has always
    // used. Production canonicalizes it before ensure(), so it follows the
    // explicit landscape/version resolution path instead.
    const isDefault = key.landscapeId === DEFAULT_WORKSPACE_KEY.landscapeId
      && key.versionId === DEFAULT_WORKSPACE_KEY.versionId
    const rootUrl = isDefault
      ? (await this.resolveRoot(undefined, undefined, this.fallbackRootUrl)) ?? this.fallbackRootUrl
      : await this.resolveRoot(key.landscapeId, key.versionId, this.fallbackRootUrl)
    if (!rootUrl) return false

    this.assertStartAllowed(key, k, generation)
    // The ownership check below runs only AFTER the build returns, and a build
    // cannot be cancelled — `release()` bumps a generation and nothing else. So
    // a projector that loses the workspace mid-build still runs to completion
    // and still writes. Health writes are the ones that matter (a stale clear
    // erases the real owner's degradation and `publishDegradation` will not
    // reissue it), so the predicate goes IN, live, rather than being consulted
    // once on the way out.
    const stillOwned = () => !this.stopped
      && this.ownsWorkspace(key)
      && (this.generations.get(k) ?? 0) === generation
    // A lost fence after attach means another instance's cold build owns the
    // rows now: this projector can never commit again (only a cold build
    // claims, and it already ran its own). Without a recycle it would sit
    // resident and silently frozen forever. Deferred with a
    // timer because the projector fires this from inside the aborting pass's
    // own promise chain, and release() re-enters stop() — tearing a projector
    // down from under its own in-flight pass is exactly the shape the health
    // teardown tests exist for. Generation-checked so a recycle that lost the
    // race to a successor never detaches the successor.
    const onFenceLost = () => {
      this.writeFenceAborts += 1
      const timer = setTimeout(() => {
        if (this.stopped) return
        if ((this.generations.get(k) ?? 0) !== generation) return
        this.release(key, 'write-fence-lost')
      }, 0)
      timer.unref?.()
    }
    let stop: () => void
    // Captured from the projector itself rather than re-read from SQL: the row
    // is exactly what the id is needed to VALIDATE, so reading it back would be
    // the witness-derives-from-the-claim shape.
    let projectorInstanceId: string | null = null
    try {
      stop = await this.startProjector(
        this.repo, rootUrl, this.db, key, this.residency, undefined, undefined, stillOwned, onFenceLost,
        (instanceId) => { projectorInstanceId = instanceId },
        this.ordinaryHeadRotation,
      )
    } catch (error) {
      if (isReadModelAuthorityLoss(error)) {
        // The build lost the workspace mid-flight: its fence claim was
        // skipped (or another instance claimed first) and the whole cold
        // build transaction rolled back. Same fact as the post-build
        // ownership check below, discovered earlier — same accounting.
        //
        // A lost PLANE lands here too: the plane pre-check is deliberately not
        // cold-build-exempt (unlike the fence, where claiming is the cold
        // build's own job), so a workspace promoted between `ensure()`'s static
        // check and the build's first transaction arrives as one of these, and
        // is accounted for like a lost lease.
        this.ownershipRejectedStarts += 1
        throw new ProjectorOwnershipError()
      }
      throw error
    }
    // stopAll() cannot interrupt a running Automerge/SQL cold start. If it
    // completes during shutdown, detach its freshly-created listeners instead
    // of resurrecting a resident projector after the fleet was drained.
    if (this.stopped) {
      stop()
      throw new ColdBuildAdmissionStoppedError()
    }
    if (!this.ownsWorkspace(key) || (this.generations.get(k) ?? 0) !== generation) {
      stop()
      this.ownershipRejectedStarts += 1
      throw new ProjectorOwnershipError()
    }
    // Evict only AFTER a replacement built successfully. A failed cold start
    // must not discard a healthy resident projector and reduce availability.
    this.evictIfOverCap()
    this.byKey.set(k, {
      key, stop, projectorInstanceId, lastUsed: ++this.clock, pinned: this.pinnedKeys.has(k),
    })
    return true
  }

  private assertStartAllowed(key: WorkspaceKey, k: string, generation: number): void {
    if (!this.ownsWorkspace(key) || (this.generations.get(k) ?? 0) !== generation) {
      this.ownershipRejectedStarts += 1
      throw new ProjectorOwnershipError()
    }
  }

  /** Evict the least-recently-used resident projector if adding one more would
   * exceed the cap. Only considers ALREADY-RESIDENT, UNPINNED entries (`byKey`),
   * never an in-flight cold build (so a build in progress can never be evicted
   * mid-way) and never a pinned entry. */
  private evictIfOverCap(): void {
    if (this.byKey.size < this.cap) return
    let victim: FleetEntry | null = null
    for (const entry of this.byKey.values()) {
      // THE PIN IS CONDITIONED ON OWNERSHIP. A pin is a standing instruction
      // taken at boot — `index.ts` pins the default workspace unconditionally,
      // on every cell — so without re-asking ownership here, a RESIDENT pinned
      // workspace whose ownership moved away would be an entry the LRU could
      // never reclaim (`foreignResidentProjectors` counts that state). The
      // ownership-loss listener normally detaches it promptly; this closes the
      // window locally rather than relying on another component.
      if (entry.pinned && this.ownsWorkspace(entry.key)) continue
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
    }
    if (victim) this.evict(victim.key)
  }

  /** Detach a resident projector's listeners WITHOUT touching its Postgres
   * rows — they stay queryable (stale-but-present) until a later `ensure()`
   * re-walks and catches them up. No-op if the key isn't resident. */
  private evict(key: WorkspaceKey): void {
    const k = keyOf(key)
    const entry = this.byKey.get(k)
    if (!entry) return
    // Bump the generation, exactly as `release()` does. `stillOwned` — the
    // predicate this fleet hands every projector — is composed of ownership AND
    // this counter, and an LRU eviction is every bit as much "you no longer
    // speak for this workspace" as a lost lease. Without it a torn-down
    // projector's in-flight pass still answers true and can publish health for a
    // workspace with no resident projector at all.
    this.generations.set(k, (this.generations.get(k) ?? 0) + 1)
    entry.stop()
    this.byKey.delete(k)
    console.log(`[read-model] evicted projector for ${k} (LRU cap ${this.cap}) — rows kept, listeners detached`)
  }

  /** For tests/diagnostics: is this workspace's projector currently resident
   * (listeners attached)? */
  isResident(key: WorkspaceKey): boolean {
    return this.byKey.has(keyOf(key))
  }

  /** For tests/diagnostics: how many projectors are currently resident. */
  size(): number {
    return this.byKey.size
  }

  /** The resident cap `evictIfOverCap` enforces (`READ_MODEL_MAX_PROJECTORS`). */
  capacity(): number {
    return this.cap
  }

  /**
   * Mark a RESIDENT projector as used — the recency the eviction reads.
   * `ensure()` bumps `lastUsed` only on an entry it finds already resident,
   * and callers guard `ensure()` behind `!isResident()`, so without this the
   * "LRU" would be FIFO. The read route and the live residency call this on
   * their resident branch. Returns false when the key is not resident.
   */
  touch(key: WorkspaceKey): boolean {
    const entry = this.byKey.get(keyOf(key))
    if (!entry) return false
    entry.lastUsed = ++this.clock
    return true
  }

  /** Invalidate a workspace generation and detach its resident projector. A
   * cold build already running cannot be force-cancelled, but its completion
   * observes the generation mismatch, calls its stop closure, and never enters
   * the resident map. */
  release(key: WorkspaceKey, reason = 'released'): void {
    const k = keyOf(key)
    this.generations.set(k, (this.generations.get(k) ?? 0) + 1)
    const entry = this.byKey.get(k)
    if (!entry) return
    entry.stop()
    this.byKey.delete(k)
    this.ownershipEvictions += 1
    console.log(`[read-model] detached projector for ${k} (${reason}); rows kept`)
  }

  /**
   * The `projector_instance_id` of the projector THIS fleet currently has
   * resident for `key`, or null when it has none.
   *
   * Exists for one caller: the promotion primitive's
   * `projector-instance-mismatch` precondition, which compares
   * `read_model_projection_state.projector_instance_id` against the run that
   * is happening NOW — the guard against a stale projection-state row from a
   * previous process looking exactly like data. Without this accessor its
   * production caller (the promote-summary route) could only pass `null`,
   * which disables the check.
   *
   * `null` is the honest "this process cannot name it" — an evicted or
   * never-attached workspace — and the precondition treats it as "skip", the
   * same as for the standalone script.
   */
  residentProjectorInstanceId(key: WorkspaceKey): string | null {
    return this.byKey.get(keyOf(key))?.projectorInstanceId ?? null
  }

  /** Aggregated process metrics only; workspace keys are deliberately omitted. */
  snapshot(): ProjectorFleetSnapshot {
    let foreignResidentProjectors = 0
    for (const entry of this.byKey.values()) {
      if (!this.ownsWorkspace(entry.key)) foreignResidentProjectors += 1
    }
    return {
      ...this.coldBuildAdmission.snapshot(),
      residentProjectors: this.byKey.size,
      inFlightWorkspaces: this.inFlight.size,
      maxProjectors: this.cap,
      fleetStopped: this.stopped,
      foreignResidentProjectors,
      ownershipRejectedStarts: this.ownershipRejectedStarts,
      ownershipEvictions: this.ownershipEvictions,
      writeFenceAborts: this.writeFenceAborts,
    }
  }

  /** Stop every resident projector (server shutdown / test teardown). Rows are
   * left in place, same as a single eviction. */
  stopAll(): void {
    if (this.stopped) return
    this.stopped = true
    this.coldBuildAdmission.stop()
    for (const entry of this.byKey.values()) entry.stop()
    this.byKey.clear()
  }
}

export { DEFAULT_WORKSPACE_KEY }
