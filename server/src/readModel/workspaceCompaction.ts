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

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { DocHandle, Repo } from '@automerge/automerge-repo'
import type { Doc } from '@automerge/automerge'
import type { SnapshotCompactionOutcome } from '../automergeStorage.js'
import type { BaseShardStorageCompactionMode } from './baseShardStorageCompactionConfig.js'
import type { PoolClient } from 'pg'
import {
  compactOverlay,
  readProjectionAcknowledgement,
  type CompactionResult,
  type CompactionSegment,
  type CompactionSegmentRefusal,
} from './compaction.js'
import { isStaticReadModelWorkspace } from './staticWorkspace.js'
import { ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError } from './projectorService.js'
import {
  commitForwardedHeadsBatch,
  loadOrdinaryHeadRetirements,
  ordinaryHeadLateWritesPending,
  retirementKey,
  type OrdinaryHeadRetirement,
} from './ordinaryHeadForwarding.js'
import { commitOrdinaryHeadRetirements } from './ordinaryHeadRotator.js'
import { readOrdinaryChainFold } from './ordinaryChainFold.js'
import {
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  releaseOverlayRotationLock,
  reportOverlayRotationLockContended,
  type OverlayRotationLockState,
} from './overlayRotationLock.js'
import { assertReadModelPlane, STATIC_PLANE_LOCK_WAIT_MS } from './projectionAuthority.js'
import { assertReadModelWriteFence, ReadModelWriteFenceError } from './health.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { fencedOn, runModelEpochStep, type ModelEpochStepDeps, type ModelEpochStepOutcome } from './modelEpochStep.js'
import { forwardModelEpochLateWrites, type ForwarderReport } from './modelEpochForwarder.js'
import { modelEpochForwardPending, modelEpochRowsExist } from './modelEpochStore.js'
import { declinedOverrideWrites, overlayClearScanStore, rematerializeGraceMsFromEnv } from './overlayClearRematerialize.js'

/**
 * The overlay compaction pass for ONE workspace.
 *
 * It lives in its own module, rather than inside `main()` in `index.ts`, so that
 * its guards can be imported and executed by tests.
 *
 * Three guards, each re-asking a question whose answer can change while the
 * pass runs:
 *
 *   (a) OWNERSHIP AND ORDINARINESS, RE-ASKED MID-FOLD. Resolving every base
 *       shard is an unbounded await; meanwhile the lease can move to another
 *       cell, or the workspace can be PROMOTED to summary, which hands its base
 *       shards to `StaticDeltaProjector`. `stillOwnedAndOrdinary` is threaded
 *       into `compactOverlay` and consulted immediately before the first write
 *       and again before the destructive clear.
 *   (b) THE ACKNOWLEDGEMENT MUST BE THIS CELL'S. `projector_attached = true` with
 *       `projected >= observed` can have been published by a projector on
 *       ANOTHER cell after a failover. Reading only the numbers would turn another
 *       cell's progress into this cell's permission to clear the overlay.
 *   (c) A SKIPPED RE-ATTACH IS RECORDED. When the pass cannot re-attach the
 *       projector, the outcome is named and handed back, so a detached workspace
 *       always leaves a trace. A re-attach that FAILED (threw, or attached
 *       nothing) is also handed to `onReadPlaneLeftDetached`, which production
 *       wires to the retry supervisor (`compactionReattach.ts`): a transient
 *       refusal no longer leaves the read plane down until the next pass.
 *
 * And, for a workspace whose ordinary write heads rotate and whose chain folds
 * (G4-16i), three more. (d) and the settle's transaction run on EVERY
 * workspace — two pooled clients, two advisory keys, one flush of the
 * overlay segments and one transaction per collection that wrote; only the
 * ROWS are left unchanged on a workspace that has none:
 *
 *   (d) BOTH `overlay-rotation:` KEYS, HELD WHILE IT WRITES. Taken BEFORE the
 *       detach — so a contended skip costs neither a detach nor a cold build —
 *       object then connection, each on its own pooled client, by REFUSAL
 *       (`overlayRotationLock.ts`): anything but `acquired` skips the pass with
 *       `overlay_rotation_lock_contended`, nothing written, the projector
 *       still attached (`not_detached`). Held to the end of `compactOverlay`,
 *       given back (connection first) BEFORE the re-attach, so the cold build —
 *       which takes the projection mutex — never runs under them: the one
 *       global order is projection mutex BEFORE overlay-rotation
 *       (`projectionTransaction.ts`). Holding them while the projector is
 *       still attached is harmless — FROM CODE READING, no test drives it: on
 *       an ordinary workspace every other taker (the rotator, the fold writer
 *       and its recovery) takes them by refusal and retries on a backoff, and
 *       nothing the attached projector needs to make progress (projection,
 *       forwarding) takes them — the only blocking takers,
 *       `synchronizeOverlaySegments`/`synchronizeOverlayHead`, are the STATIC
 *       plane's (grep of every `overlayRotationLockKey` caller). Between the
 *       acquisitions and the detach, the resident instance is re-checked
 *       against the one guard (b) matched (`foreign_projector_instance`, nothing
 *       detached). What the keys prevent, built in
 *       `compactionOrdinaryFold.integration.test.ts` ("THE RACE"): a fold that
 *       sampled its sources BEFORE the clear and records and publishes its
 *       product BETWEEN the clear and the repoint — the product (older values)
 *       then outranks the base the pass just folded, and a newer value is
 *       served at an older one. With the keys, that fold holds one and the
 *       pass is refused. A rotation repointing in the same window is not
 *       reproduced by a test;
 *   (e) A FOLD RECORDED AND NOT PUBLISHED REFUSES (`ordinary_fold_unpublished`).
 *       Its sources are still listed, `folded`. Cleared by this pass, the
 *       forwarder then moves their `forwarded_heads` past the clear, the
 *       recovery (`ordinaryChainFoldWriter.ts`, step 3a) reads them as
 *       unchanged and publishes a product built from the content BEFORE the
 *       clear: a value written later, folded into the base, is then outranked
 *       by an older one (measured, `compactionOrdinaryFold.integration.test.ts`
 *       L1: `h1-0` served over `newer` after a cold restart). The re-attach
 *       publishes it; the next window folds;
 *   (f) THE SEGMENTS IT REWROTE ARE SETTLED before ModelMeta moves
 *       (`settleCompactedOrdinarySegments`, below).
 */

/** Everything the pass touches, injected so a test can drive each guard. */
export interface WorkspaceCompactionDeps {
  readonly repo: Repo
  readonly rootUrl: string
  readonly db: Queryable
  /** A pooled client of `db`'s cluster, for a session-scoped
   * `overlay-rotation:` key (guard (d)) and the settle transaction committed
   * on it. Two are held at once for the pass's write half. */
  readonly connect: () => Promise<ReleasableQueryable>
  readonly fleet: {
    isResident(key: WorkspaceKey): boolean
    /**
     * `ProjectorFleet.ensure` returns FALSE — without throwing — when the
     * workspace root does not resolve, so callers must read the boolean.
     * Unreachable for the default workspace, whose resolution falls back to
     * `fallbackRootUrl`; reachable for every non-default workspace.
     *
     * Every call here passes `{ adopt: false }` (G4-16f C6-2a): compaction
     * never ADOPTS. Its re-attach must re-derive the read model from the
     * documents it just rewrote, and the instance refresh needs the cold
     * build's acknowledgement the moment `ensure` returns — an adopting
     * attach is `projector_attached = false` until its B5, and keeps rows a
     * fold has just moved under it. The OTHER starts in the detached window
     * (a read's plain `ensure`, the live residency's) are the fleet's half:
     * `ProjectorFleet.release` with a `compaction…` reason makes every start
     * of the workspace `off` until this `{ adopt: false }` re-attach has
     * built, and with `compaction` itself (the fold's detach) REFUSES them
     * outright until `endCompactionWindow` (T-VANISH).
     */
    ensure(key: WorkspaceKey, options?: { adopt?: boolean }): Promise<boolean>
    release(key: WorkspaceKey, reason: string): void
    /**
     * T-VANISH: close the window `release(key, 'compaction')` opened. Called
     * once per detached pass, on every way out (`ProjectorFleet` ›
     * `endCompactionWindow`). REQUIRED: a fleet wrapper that
     * forgot it would compile and then refuse every start of the workspace
     * until the window's ceiling; a double without a window passes a no-op.
     */
    endCompactionWindow(key: WorkspaceKey): void
    /** The projector instance this cell has resident, for guard (b). */
    residentProjectorInstanceId(key: WorkspaceKey): string | null
  }
  readonly ownership: { owns(key: WorkspaceKey): boolean }
  readonly isShuttingDown: () => boolean
  readonly log?: (message: string) => void
  readonly warn?: (message: string) => void
  /** G4-16f epochs (`modelEpochStep.ts`, `modelEpochForwarder.ts`). Absent:
   * no epoch statement at all — the behaviour before epochs, statement for
   * statement. Present: one probe per pass (`modelEpochRowsExist`); a
   * workspace with NO epoch row runs nothing else, whatever the flag. With
   * rows, under EVERY value of the flag, the forwarder runs, an open journal
   * refuses the fold, and an attempt left in flight is recovered; only a NEW
   * roll needs `config.enabled`. */
  readonly modelEpochs?: Pick<ModelEpochStepDeps, 'config' | 'instanceId' | 'withLifecycleLock' | 'now'>
  /**
   * G4-16f diagnosis F1 + F2: compact one base shard's stored rows to one
   * snapshot (`PostgresStorageAdapter.compactToSnapshot`, the Repo's own
   * adapter). Run after a fold that applied, with the projector still
   * detached, under EVERY value of `AM_MODEL_EPOCHS` (it is storage
   * maintenance of the fold's own writes, not an epoch step). Absent: the
   * base shards keep their incrementals, as before.
   */
  readonly compactDocumentStorage?: (documentId: string, doc: Doc<unknown>) => Promise<SnapshotCompactionOutcome>
  /** `AM_BASE_SHARD_STORAGE_COMPACTION` (`baseShardStorageCompactionConfig.ts`).
   * `off`: nothing is compacted, and the pass's `compaction.base_storage`
   * line says so. Absent: `on`. */
  readonly baseShardStorageCompaction?: BaseShardStorageCompactionMode
  /**
   * G4-16f (3-year bench): the pass left the read plane DETACHED and this
   * cell may put it back later. Called once per pass, after the attempt
   * (here or in guard (b)'s instance refresh), with `reason`:
   *  - `reattach_failed`: the re-attach threw (measured: a
   *    `StoragePoolExhaustedError` from the cold build's flush);
   *  - `no_root`: it attached nothing (the root did not resolve);
   *  - `not_owned`: `owns()` answered false at the re-attach, or `ensure`
   *    threw `ProjectorOwnershipError` — possibly transient (a lease late to
   *    renew), so handed over too: the supervisor keeps it DORMANT and
   *    retries once this cell owns the workspace again.
   * NOT called when nothing of this cell's is left to put back: a shutdown
   * (`skipped_shutting_down`, or `ColdBuildAdmissionStoppedError`) or a
   * promotion to summary (`ProjectorStaticWorkspaceError`). Production:
   * `CompactionReattachSupervisor.noteDetached` (`compactionReattach.ts`,
   * wired by `compactionReattachWiring.ts`). Absent: nothing retries, as
   * before. A throw is caught and warned (it runs in the `finally`).
   */
  readonly onReadPlaneLeftDetached?: (key: WorkspaceKey, cause: unknown, reason: 'reattach_failed' | 'no_root' | 'not_owned') => void
  /**
   * G4-16f: the watchdog of each re-attach this pass runs. Called as
   * the `ensure` starts; the returned function as it settles. A cold build
   * waiting on a lock neither fails nor can be cancelled: this is how it is
   * seen (`..._running_seconds`, `read_model.compaction_reattach_slow`).
   */
  readonly watchReattach?: (key: WorkspaceKey) => () => void
}

/** The HTTP body of `POST /api/model/compact`: the fold's counts AND
 * how the pass left the read plane, so a manual compaction that left it
 * detached says so in its answer, not only in the log. */
export function compactionHttpBody(outcome: Pick<WorkspaceCompactionOutcome, 'result' | 'reattach'>): WorkspaceCompactionResult & { reattach: ReattachOutcome } {
  return { ...outcome.result, reattach: outcome.reattach }
}

export type WorkspaceCompactionSkip =
  | 'summary_workspace'
  | 'projection_not_acknowledged'
  | 'foreign_projector_instance'
  | 'ownership_lost_mid_fold'
  /** A retired ordinary write head holds a late write the forwarder has not
   * carried yet (`compaction.ts`, `lateWritesPending`). Nothing was written,
   * in EITHER collection: both are asked before either writes. The re-attach
   * forwards it and the next window folds. */
  | 'retired_head_forward_pending'
  /** Guard (e): a listed segment is a source of a fold recorded and not
   * published. Nothing was written; the re-attach's recovery publishes it. */
  | 'ordinary_fold_unpublished'
  /** A segment seen for the first time could not have its scan row
   * saved — folding now would clear before its starting point is recorded.
   * The rematerialization may have written; nothing was folded or cleared. */
  | 'rematerialize_cursor_unsaved'
  /** Guard (d): another session holds an `overlay-rotation:` key of the
   * workspace (a rotation or a fold, here or on another cell). Nothing was
   * written; the next window retries. */
  | 'overlay_rotation_lock_contended'
  /** G4-16f, guard (g): a model epoch forward journal is open —
   * it names documents this pass would fold and clear. Nothing was detached
   * or written; the journal is finished by the next forwarder run. */
  | 'epoch_forward_pending'

/** How the pass left the workspace's listeners. `skipped_*` is not a failure —
 *  it is the fact that the read plane is now DETACHED and this pass did not put
 *  it back. */
export type ReattachOutcome =
  | 'reattached'
  | 'skipped_shutting_down'
  | 'skipped_not_owned'
  /** The re-attach was attempted and THREW. */
  | 'skipped_reattach_failed'
  /** The re-attach was attempted, did not throw, and ATTACHED NOTHING:
   *  `ProjectorFleet.ensure` answers `false` rather than throwing when the
   *  workspace root does not resolve. */
  | 'skipped_reattach_no_root'
  | 'not_detached'

/**
 * Force this cell's projector to re-publish its identity, once.
 *
 * `release()` then `ensure()` is the only thing that rewrites
 * `read_model_projection_state.projector_instance_id`, because `ensure()`
 * short-circuits on an already-resident workspace. Returns false when the
 * re-attach threw — which it does, by design, for a workspace that has been
 * promoted to summary (`ProjectorStaticWorkspaceError`) — AND when it did not
 * throw but attached nothing, which `ensure` reports by returning false rather
 * than raising. This function detaches before it re-attaches, so both outcomes
 * leave the read plane down.
 */
async function refreshProjectorAttachment(
  key: WorkspaceKey,
  deps: WorkspaceCompactionDeps,
  warn: (message: string) => void,
): Promise<boolean> {
  deps.fleet.release(key, 'compaction-instance-refresh')
  const unwatch = deps.watchReattach?.(key)
  try {
    const attached = await deps.fleet.ensure(key, { adopt: false })
    if (!attached) {
      warn(
        `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
        + 'the projector-instance refresh did not throw, but the workspace root did not resolve',
      )
      leftDetached(key, deps, warn, new Error('the workspace root did not resolve'), 'no_root')
    }
    return attached
  } catch (error) {
    warn(
      `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
      + `re-attach failed during the projector-instance refresh: ${String(error)}`,
    )
    leftDetached(key, deps, warn, error)
    return false
  } finally {
    unwatch?.()
  }
}

/**
 * Hands a re-attach this cell may still put back to `onReadPlaneLeftDetached`
 * (the retry), never throwing: it runs in the pass's `finally`. A thrown
 * re-attach is classified here: a shutdown or a promotion is not handed over
 * (the supervisor would only abandon it, after a `pending` line
 * and a gauge at 1), a lost ownership is handed over as `not_owned`.
 */
function leftDetached(
  key: WorkspaceKey,
  deps: WorkspaceCompactionDeps,
  warn: (message: string) => void,
  cause: unknown,
  reason?: 'no_root' | 'not_owned',
): void {
  if (!deps.onReadPlaneLeftDetached) return
  if (cause instanceof ColdBuildAdmissionStoppedError || cause instanceof ProjectorStaticWorkspaceError) return
  const handed = reason ?? (cause instanceof ProjectorOwnershipError ? 'not_owned' : 'reattach_failed')
  try {
    deps.onReadPlaneLeftDetached(key, cause, handed)
    warn(`[compaction] re-attach of ${key.landscapeId}/${key.versionId} handed to the retry (${handed})`)
  } catch (error) {
    warn(`[compaction] could not schedule the re-attach retry for ${key.landscapeId}/${key.versionId}: ${String(error)}`)
  }
}

/**
 * GUARD (c), the pass's `finally`: put the read plane back after the fold.
 * Every way of NOT re-attaching is named in the returned outcome and warned,
 * so a detached workspace never goes unrecorded. A pass that never detached
 * (a contended key, a failed acquisition) has nothing to put back:
 * `not_detached`, and no cold build. Its caller closes the compaction window
 * after it, whatever it does (T-VANISH).
 */
async function reattachAfterFold(
  key: WorkspaceKey,
  deps: WorkspaceCompactionDeps,
  warn: (message: string) => void,
  detached: boolean,
): Promise<ReattachOutcome> {
  if (!detached) return 'not_detached'
  if (deps.isShuttingDown()) {
    warn(`[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: shutting down`)
    return 'skipped_shutting_down'
  }
  if (!deps.ownership.owns(key)) {
    warn(`[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: ownership lost`)
    // Review A2: `owns()` can be false for a moment (a lease late to
    // renew). Handed over DORMANT: retried once this cell owns it again.
    leftDetached(key, deps, warn, new Error('owns() answered false at the re-attach'), 'not_owned')
    return 'skipped_not_owned'
  }
  const unwatch = deps.watchReattach?.(key)
  // THIS `await` MUST NOT THROW OUT OF THE `finally`. A workspace promoted
  // to summary mid-fold makes `ensure()` throw
  // `ProjectorStaticWorkspaceError`; uncaught, that would discard the
  // compaction result, leave `reattach` unassigned and REPLACE any error
  // `compactOverlay` was already throwing.
  try {
    // `ensure` answers false, without throwing, for a workspace whose root
    // does not resolve — see the `ensure` signature above.
    const attached = await deps.fleet.ensure(key, { adopt: false })
    if (!attached) {
      warn(
        `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
        + 'the re-attach did not throw, but the workspace root did not resolve, so no projector was started',
      )
      leftDetached(key, deps, warn, new Error('the workspace root did not resolve'), 'no_root')
      return 'skipped_reattach_no_root'
    }
    return 'reattached'
  } catch (error) {
    warn(
      `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
      + `re-attach threw: ${String(error)}`,
    )
    // G4-16f (3-year bench): a TRANSIENT refusal here (a storage permit
    // not granted within 2 s on slow storage) used to be a PERMANENT
    // outage. The retry is the supervisor's, outside this pass, under its
    // exclusion (`compactionReattach.ts`).
    leftDetached(key, deps, warn, error)
    return 'skipped_reattach_failed'
  } finally {
    unwatch?.()
  }
}

/** `Omit` and not an intersection: intersecting a union field NARROWS it, so
 *  `CompactionResult & { skippedReason?: … }` would reduce the two sets to their
 *  overlap and reject the reasons this module adds. */
export type WorkspaceCompactionResult =
  Omit<CompactionResult, 'skippedReason'>
  & { skippedReason?: WorkspaceCompactionSkip | 'static_baseline' }

export interface WorkspaceCompactionOutcome {
  readonly result: WorkspaceCompactionResult
  readonly reattach: ReattachOutcome
  /** G4-16f: what the epoch step did after a successful fold (absent when
   * the pass never reached it: a skip, a refusal, a throw). */
  readonly epoch?: ModelEpochStepOutcome | { outcome: 'failed'; error: string }
  /** G4-16f: what the epoch forwarder did before the fold (absent when it
   * did not run). */
  readonly forwarded?: ForwarderReport
}

const NOTHING = {
  objectsFolded: 0, connectionsFolded: 0, objectsKept: 0, connectionsKept: 0,
  objectsDeleted: 0, connectionsDeleted: 0,
} as const

/**
 * F1 + F2 (G4-16f diagnosis): each base shard the pass resolved, compacted to
 * one stored snapshot, one at a time, while the projector is still detached
 * (so the re-attach's cold build reads one row per shard, and its proof hits
 * the memo entry F2 left). Stops at the first sign the cell may no longer
 * write; a shard that fails is reported and skipped. Never throws: the fold
 * already stands, this is maintenance of its storage. One log line,
 * `compaction.base_storage`.
 */
async function compactBaseShardStorage(
  handles: ReadonlyArray<DocHandle<unknown>>,
  deps: WorkspaceCompactionDeps,
  log: (message: string) => void,
  warn: (message: string) => void,
  /** `stillOwnedAndOrdinary` of the pass: ownership, shutdown AND
   * a promotion to summary, which hands the base shards to the static
   * projector. Asked before every shard. */
  mayWrite: () => Promise<boolean>,
): Promise<void> {
  const compact = deps.compactDocumentStorage
  if (!compact) return
  const mode = deps.baseShardStorageCompaction ?? 'on'
  if (mode === 'off') {
    log(JSON.stringify({ event: 'compaction.base_storage', mode, shards: handles.length, compacted: 0 }))
    return
  }
  const started = performance.now()
  const totals = { mode, shards: handles.length, compacted: 0, skipped: 0, failed: 0, rowsBefore: 0, removed: 0, kept: 0, remembered: 0, octets: 0, stopped: false }
  let first = true
  for (const handle of new Set(handles)) {
    // Each shard's save and checks are synchronous CPU: let I/O in between,
    // as `resolveCooperatively` does for cold loads.
    if (!first) await yieldToEventLoop()
    first = false
    if (!(await mayWrite())) { totals.stopped = true; break }
    try {
      const doc = handle.doc()
      if (!doc) { totals.skipped += 1; continue }
      const outcome = await compact(String(handle.documentId), doc)
      totals.rowsBefore += outcome.rowsBefore
      totals.removed += outcome.removed
      totals.kept += outcome.kept
      totals.octets += outcome.snapshotOctets
      if (outcome.remembered) totals.remembered += 1
      if (outcome.outcome === 'compacted') totals.compacted += 1
      else totals.skipped += 1
    } catch (error) {
      totals.failed += 1
      warn(`[compaction] base shard storage compaction failed for ${String(handle.documentId)} (the fold stands): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(JSON.stringify({ event: 'compaction.base_storage', ...totals, ms: Math.round(performance.now() - started) }))
}

export async function runWorkspaceCompaction(
  key: WorkspaceKey,
  deps: WorkspaceCompactionDeps,
): Promise<WorkspaceCompactionOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  log('[compaction] starting overlay compaction…')

  // A PROMOTED (summary) workspace has no ordinary projector and its overlay
  // rotation belongs to the StaticDeltaProjector. Folding overlays here would
  // race that owner, so the whole pass steps aside — with a named reason, never
  // a silent no-op.
  if (await isStaticReadModelWorkspace(deps.db, key)) {
    log('[compaction] skipped: the workspace is summary/static')
    return { result: { ...NOTHING, skippedReason: 'summary_workspace' }, reattach: 'not_detached' }
  }
  if (!deps.fleet.isResident(key)) await deps.fleet.ensure(key, { adopt: false })

  const ack = await readProjectionAcknowledgement(deps.db, key)
  if (!ack.acknowledged) {
    warn('[compaction] skipped: read-model projection has not acknowledged every observed generation')
    return { result: { ...NOTHING, skippedReason: 'projection_not_acknowledged' }, reattach: 'not_detached' }
  }
  // GUARD (b). Compared to the instance THIS cell has resident, not merely to
  // "some instance is attached".
  //
  // `resident === null` REFUSES; it must not be read as "skip the check".
  // `residentProjectorInstanceId` returns null for an evicted or never-attached
  // workspace, and when a projector loses its write fence the fleet schedules
  // `release()` on a macrotask — so `resident` can go null between the
  // acknowledgement read and this line while the lease is still held and the
  // workspace is still ordinary (guard (a) sees nothing wrong). Not being able
  // to name our own projector is not permission to clear an overlay on someone
  // else's acknowledgement.
  if (ack.projectorInstanceId !== deps.fleet.residentProjectorInstanceId(key)) {
    // ONE SELF-HEAL BEFORE REFUSING, because refusing alone can latch for the
    // life of the process. `markReadModelProjectorAttached` is best-effort
    // (`.catch` + log, "so this call is telemetry again"), so a single lost
    // UPDATE leaves the row naming a DEAD process from this same cell. That is
    // indistinguishable here from another cell's acknowledgement — and since a
    // refusal returns before the release/re-attach below, nothing would ever
    // rewrite the row. The default workspace is pinned, so eviction cannot
    // re-attach it either: compaction would be off for good and the overlay
    // would grow without bound, which is the exact cost compaction exists to cap.
    const refreshed = await refreshProjectorAttachment(key, deps, warn)
    const after = refreshed ? await readProjectionAcknowledgement(deps.db, key) : null
    const residentAfter = deps.fleet.residentProjectorInstanceId(key)
    if (!after || !after.acknowledged || after.projectorInstanceId !== residentAfter) {
      warn(
        '[compaction] skipped: read_model_projection_state names projector instance '
        + `${after?.projectorInstanceId ?? ack.projectorInstanceId}, and this cell's resident is `
        + `${residentAfter ?? 'unknown'} — the acknowledgement is not this projector's, `
        + 'and a re-attach did not make it so',
      )
      return {
        result: { ...NOTHING, skippedReason: 'foreign_projector_instance' },
        reattach: refreshed ? 'reattached' : 'skipped_reattach_failed',
      }
    }
  }

  // GUARD (a), the predicate itself. Both halves are re-read, not just
  // ownership: `isStaticReadModelWorkspace` is what a promotion flips.
  const stillOwnedAndOrdinary = async (): Promise<boolean> => {
    if (deps.isShuttingDown()) return false
    if (!deps.ownership.owns(key)) return false
    try {
      return !(await isStaticReadModelWorkspace(deps.db, key))
    } catch (error) {
      // CANNOT TELL IS NOT PERMISSION. This is a live round trip on the app pool
      // between resolving the shards and writing them, so a statement timeout or
      // an exhausted pool is a real outcome. Letting it throw would be fail-safe
      // by accident — nothing would be cleared — but it would arrive as a job
      // failure with a stack trace instead of a named refusal, and a throw from
      // the connections pass would discard the objects pass's counts entirely.
      // Refusing turns an unanswerable question into `ownership_lost_mid_fold`,
      // which is what actually happened: we could not confirm it was still safe.
      warn(`[compaction] treating an unanswerable staticness check as unsafe: ${String(error)}`)
      return false
    }
  }

  // The fence the settle asserts (guard (f)): the projector instance guard (b)
  // just matched. Its stop does not clear `write_fence`; only another cold
  // build (another cell taking the workspace) or a promotion moves it.
  const fenceHolder = deps.fleet.residentProjectorInstanceId(key)
  let result: WorkspaceCompactionResult
  let reattach: ReattachOutcome
  let epoch: WorkspaceCompactionOutcome['epoch']
  let forwarded: ForwarderReport | undefined
  let detached = false
  try {
    // GUARD (d), taken BEFORE the detach. Every `await` from the first
    // acquisition to its hand-back, and what each `finally` does if it throws
    // (bounded, and loud):
    //  1. `connect()` (object): nothing taken, nothing detached; the throw
    //     propagates, the projector still attached.
    //  2. the object acquisition: its state still `unknown`, so the hand-back
    //     DESTROYS the session (the server may have granted the key and lost
    //     the reply). Not detached.
    //  3. `connect()` (connection): the object key is given back. Not detached.
    //  4. the connection acquisition: as 2, on its own client; the object key
    //     is given back after it. Not detached.
    //  5. the detach (synchronous) and `compactOverlay` (with the settle it
    //     runs on these clients): both keys are given back, connection first,
    //     and only THEN does this `finally` re-attach.
    //  6. the hand-backs do not throw (`releaseOverlayRotationLock` turns a
    //     failed unlock into a destroyed session), so the outer one always
    //     runs, and so does the re-attach.
    // The cold build is therefore never run under a rotation key.
    result = await withRotationKeys(key, deps, warn, async (clients) => {
      // GUARD (b), RE-ASKED: the acquisitions above are four awaits after its
      // identity match, and the resident projector can have been recycled in
      // between (a lost fence, an eviction). Synchronous from here to the
      // detach; nothing detached, the keys given back.
      const residentNow = deps.fleet.residentProjectorInstanceId(key)
      if (residentNow !== fenceHolder) {
        warn(
          `[compaction] skipped: the resident projector instance moved from ${fenceHolder ?? 'unknown'} to `
          + `${residentNow ?? 'unknown'} while the overlay-rotation keys were taken; nothing was detached or written`,
        )
        return { ...NOTHING, skippedReason: 'foreign_projector_instance' }
      }
      // G4-16f: FORWARD FIRST, then refuse on what is still open. The epoch
      // forwarder carries late writes on superseded epoch documents into the
      // current base shards and head — which this pass is about to fold and
      // clear — so it runs before the fold, with the projector still
      // attached. It runs under every value of AM_MODEL_EPOCHS: rows a
      // previous `on` created keep their late writes.
      const epochRows = deps.modelEpochs ? await modelEpochRowsExist(deps.db, key) : false
      if (deps.modelEpochs && epochRows) {
        try {
          forwarded = await forwardModelEpochLateWrites({
            repo: deps.repo, key, db: deps.db, connect: deps.connect,
            fenced: fencedOn(clients.object, key, fenceHolder),
            instanceId: deps.modelEpochs.instanceId,
            mayWrite: () => !deps.isShuttingDown() && deps.ownership.owns(key),
            log: (event) => log(JSON.stringify(event)),
          })
        } catch (error) {
          warn(`[compaction] model epoch forwarder failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // GUARD (g), R4-a: an OPEN forward journal names documents this pass
      // would fold and clear (a crash between two targets, a ceiling). It
      // lives seconds; the next window folds.
      if (epochRows && await modelEpochForwardPending(deps.db, key)) {
        warn('[compaction] skipped: a model epoch forward journal is open; nothing was detached or written')
        return { ...NOTHING, skippedReason: 'epoch_forward_pending' }
      }
      // Detach listeners before compaction writes. The restart's cold build
      // re-derives the authoritative read model afterwards. The flag BEFORE
      // the call: it tracks "release was called", so a release that throws
      // part-way still gets the re-attach.
      detached = true
      deps.fleet.release(key, 'compaction')
      // The rotated heads and overflow shards are claimed at write.
      // `mode: 'apply'` is stated, not defaulted — this is the call site that
      // rewrites base shards.
      const folded = await compactOverlay(deps.repo, deps.rootUrl, {
        workspace: key, mode: 'apply', stillSafeToWrite: stillOwnedAndOrdinary,
        // G4-16k: where each segment's rematerialization scan stopped.
        clearScans: overlayClearScanStore(deps.db, key),
        // A day for the browser's own rescue before the server writes back.
        rematerializeGraceMs: rematerializeGraceMsFromEnv(),
        // What she unchecked in the batch re-apply is never written back.
        declinedEdits: (collection, ids) => declinedOverrideWrites(deps.db, key, collection, ids),
        // Rows are read AFTER the fold's snapshot, from the database: the
        // projector that would forward is detached for the whole pass.
        lateWritesPending: (collection, segments) => compactionSegmentRefusal(deps.db, key, collection, segments),
        // On the key's own client, as the rotator commits its row: never
        // through `withReadModelProjectionTransaction`, whose mutex would be
        // taken under the key (the inverted order, 40P01).
        settleRewrittenSegments: async (collection, segments) => {
          await settleCompactedOrdinarySegments(clients[collection], key, collection, segments, fenceHolder)
        },
        ...(deps.compactDocumentStorage
          ? { compactBaseShardStorage: (handles: ReadonlyArray<DocHandle<unknown>>) => compactBaseShardStorage(handles, deps, log, warn, stillOwnedAndOrdinary) }
          : {}),
      })
      // G4-16f, THE EPOCH STEP: after a SUCCESSFUL fold, with
      // both rotation keys still held and the projector still detached, so
      // the re-attach below reads whatever root the step leaves. Off unless
      // `AM_MODEL_EPOCHS=on` for a NEW roll; with epoch rows, it runs under
      // every value of the flag to recover an attempt left in flight. Its
      // failure never discards the fold's result: the roll is crash-safe on
      // its own (a later pass recovers or abandons its row), so it is
      // reported, not rethrown.
      if (!folded.skippedReason && deps.modelEpochs && (deps.modelEpochs.config.enabled || epochRows) && await stillOwnedAndOrdinary()) {
        try {
          epoch = await runModelEpochStep(key, {
            ...deps.modelEpochs,
            repo: deps.repo, rootUrl: deps.rootUrl, db: deps.db, connect: deps.connect,
            rowClient: clients.object, fenceHolder,
            mayWrite: () => !deps.isShuttingDown() && deps.ownership.owns(key),
            log: (event) => log(JSON.stringify(event)),
          })
          log(`[compaction] model epoch step: ${JSON.stringify(epoch)}`)
        } catch (error) {
          epoch = { outcome: 'failed', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
          warn(`[compaction] model epoch step failed (the fold stands): ${epoch.error}`)
        }
      }
      return folded
    })
  } finally {
    try {
      reattach = await reattachAfterFold(key, deps, warn, detached)
    } finally {
      // T-VANISH: the window `release(key, 'compaction')` opened closes on
      // EVERY way out of the detached span — re-attached, the re-attach
      // refused or thrown, shutting down, ownership lost, the fold thrown —
      // and only AFTER the re-attach, so no start of another window can be
      // joined by it. Left open, every later start of the workspace would be
      // refused for the life of the process. Idempotent, synchronous.
      // `?.`: the DB-free suites build their fleet doubles through casts,
      // without a window to close; the type keeps the method REQUIRED for
      // every typed adapter (`compactionFleet`).
      if (detached) deps.fleet.endCompactionWindow?.(key)
    }
  }

  if (result.skippedReason === 'retired_head_forward_pending') {
    warn('[compaction] refused: a retired write head holds late writes not yet forwarded; nothing was written')
    return { result, reattach }
  }
  if (result.skippedReason === 'ordinary_fold_unpublished') {
    warn('[compaction] refused: a chain fold is recorded and not published yet; nothing was written')
    return { result, reattach }
  }
  // Warned once, naming the key (or the moved instance), where they skipped.
  if (result.skippedReason === 'overlay_rotation_lock_contended') return { result, reattach }
  if (result.skippedReason === 'epoch_forward_pending') return forwarded ? { result, reattach, forwarded } : { result, reattach }
  if (result.skippedReason === 'foreign_projector_instance') return { result, reattach }
  if (result.skippedReason === 'ownership_lost_mid_fold') {
    warn('[compaction] aborted mid-fold: ownership or ordinariness was lost after the shards were resolved')
    return { result, reattach }
  }

  const deleted = result.objectsDeleted + result.connectionsDeleted
  const keptN = result.objectsKept + result.connectionsKept
  log(
    `[compaction] folded ${result.objectsFolded} object(s) + ${result.connectionsFolded} connection(s)`
    + (deleted ? `, deleted ${result.objectsDeleted} object(s) + ${result.connectionsDeleted} connection(s)` : '')
    + (keptN ? `, kept ${keptN} concurrently-edited` : '')
    // Finding D1: "rebuilt" only when the re-attach's cold build ran and attached.
    + (reattach === 'reattached' ? '; read model rebuilt' : `; read model NOT rebuilt: the read plane is detached (${reattach})`),
  )
  return { result, reattach, ...(epoch ? { epoch } : {}), ...(forwarded ? { forwarded } : {}) }
}

/**
 * GUARD (d): run `work` holding both `overlay-rotation:` keys of the workspace,
 * object then connection, each on its own client — or skip it. The await walk
 * is at the call site, in `runWorkspaceCompaction`.
 */
async function withRotationKeys(
  key: WorkspaceKey,
  deps: WorkspaceCompactionDeps,
  warn: (message: string) => void,
  work: (clients: Record<OverlayCollection, ReleasableQueryable>) => Promise<WorkspaceCompactionResult>,
): Promise<WorkspaceCompactionResult> {
  return withOverlayRotationKeys(key, deps.connect, (kind, state): WorkspaceCompactionResult => {
    reportOverlayRotationLockContended({
      path: 'compaction', landscapeId: key.landscapeId, versionId: key.versionId, kind, state,
    })
    warn(`[compaction] skipped: the ${kind} overlay-rotation key of ${key.landscapeId}/${key.versionId} is ${state} `
      + '(held elsewhere, or unanswered); nothing was written and the projector was not detached')
    return { ...NOTHING, skippedReason: 'overlay_rotation_lock_contended' }
  }, work)
}

/** Guard (d)'s acquisition, generic over what the work returns: also the
 * meta-only epoch job's (`runModelEpochMetaJob`). */
export async function withOverlayRotationKeys<T>(
  key: WorkspaceKey,
  connect: () => Promise<ReleasableQueryable>,
  contended: (kind: OverlayCollection, state: OverlayRotationLockState) => T,
  work: (clients: Record<OverlayCollection, ReleasableQueryable>) => Promise<T>,
): Promise<T> {
  const deps = { connect }
  const objectKey = overlayRotationLockKey(key.landscapeId, key.versionId, 'object')
  const connectionKey = overlayRotationLockKey(key.landscapeId, key.versionId, 'connection')
  const objectClient = await deps.connect()
  // `unknown`, not `refused`, is the safe start: a throw from the acquisition
  // leaves exactly that gap, and its hand-back destroys the session.
  let objectLock: OverlayRotationLockState = 'unknown'
  try {
    objectLock = await acquireOverlayRotationLock(objectClient as unknown as PoolClient, objectKey)
    // `!== 'acquired'`: three states, one licence.
    if (objectLock !== 'acquired') return contended('object', objectLock)
    const connectionClient = await deps.connect()
    let connectionLock: OverlayRotationLockState = 'unknown'
    try {
      connectionLock = await acquireOverlayRotationLock(connectionClient as unknown as PoolClient, connectionKey)
      if (connectionLock !== 'acquired') return contended('connection', connectionLock)
      return await work({ object: objectClient, connection: connectionClient })
    } finally {
      await releaseOverlayRotationLock(connectionClient as unknown as PoolClient, connectionKey, connectionLock)
    }
  } finally {
    await releaseOverlayRotationLock(objectClient as unknown as PoolClient, objectKey, objectLock)
  }
}

/** A fold product's row: written by the fold record (`origin`), or a product
 * still recorded (a row older than `origin`). */
async function isFoldProduct(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  row: OrdinaryHeadRetirement,
): Promise<boolean> {
  if (row.origin === 'fold-product') return true
  return (await readOrdinaryChainFold(db, key, collection, row.documentId)) !== undefined
}

const sameHeads = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((head, index) => head === b[index])
}

/**
 * What the pass must not fold over, given each listed segment's heads AS IT
 * SAMPLED THEM (`CompactionOptions.lateWritesPending`). Rows are read after the
 * sample. In this order:
 *
 *  1. a non-current segment whose row is `folded` is the source of a fold
 *     RECORDED and not published — once published its sources leave ModelMeta,
 *     so a LISTED one is pending (guard (e)): `ordinary_fold_unpublished`;
 *  2. the shared predicate (`ordinaryHeadLateWritesPending`, which the
 *     projector uses too and which is not changed here): a retired head whose
 *     heads differ from `forwarded_heads ?? H_r` holds a late write not
 *     forwarded yet — EXCEPT a fold product. A product's heads DO move: a
 *     compaction's clear and tombstone deletes, and a client deleting an
 *     entity from every listed segment (`deleteObjectFromOverlaySegments` /
 *     `deleteConnectionFromOverlaySegments`, `src/lib/automerge/bridge.ts`)
 *     write it, and it is never a write head. What makes the exclusion safe is
 *     not that it is unwritten but that NOTHING IS EVER CARRIED OUT OF IT: the
 *     forwarder never forwards a product (the projector attaches it from its
 *     own content and refuses its changes, `ordinaryChainFold.ts`), so a moved
 *     product holds no "late write the forwarder will carry" for this pass to
 *     destroy — "pending" is the question of a head whose changes are still
 *     owed to the current head, and a product's never are. Its live content is
 *     all it will ever contribute, the cold build serves it in ModelMeta order,
 *     and that is this pass's fold order: folding it now serves what a cold
 *     build serves, and the settle then records its post-clear heads.
 *     Refusing it would refuse every pass for ever (a product moved by a
 *     settle that threw, an `ownership_lost_mid_fold` after the tombstone
 *     deletes, a client delete) — the defect G4-16i exists to remove.
 */
export async function compactionSegmentRefusal(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  segments: ReadonlyArray<CompactionSegment>,
): Promise<readonly string[] | { reason: CompactionSegmentRefusal; segments: readonly string[] }> {
  const listed = segments.filter((segment) => !segment.current)
  if (!listed.length) return []
  const rows = await loadOrdinaryHeadRetirements(db, key)
  const unpublished = listed
    .filter((segment) => rows.get(retirementKey(collection, segment.documentId))?.status === 'folded')
    .map((segment) => segment.documentId)
  if (unpublished.length) return { reason: 'ordinary_fold_unpublished', segments: unpublished }
  const pending: string[] = []
  for (const documentId of await ordinaryHeadLateWritesPending(db, key, collection, segments)) {
    const row = rows.get(retirementKey(collection, documentId))
    if (row && row.status === 'retired' && await isFoldProduct(db, key, collection, row)) continue
    pending.push(documentId)
  }
  return pending
}

export interface SettledCompactedSegments {
  /** The current head, retired at its post-clear heads. */
  retired: string[]
  /** Fold products whose `forwarded_heads` moved to their post-clear heads. */
  forwarded: string[]
  /** Listed non-current heads that had no row (a compaction head from before
   * G4-16i), given one: the fold's runs no longer split on them. */
  adopted: string[]
}

/**
 * G4-16i (f): record what a compaction did to the segments it rewrote, after
 * its clear and BEFORE its ModelMeta change (`CompactionOptions.
 * settleRewrittenSegments`), on the client that holds this collection's
 * `overlay-rotation:` key, in a bare BEGIN — never the projection mutex,
 * which would be taken under the key (the inverted order). `heads` are each
 * segment's heads in the same synchronous turn as the clear, flushed.
 *
 * AUTHORITY, inside the transaction, the same two checks the rotator's and
 * the fold writer's `assertTransactionAuthority` make: the plane (`FOR KEY
 * SHARE` on the static row) FIRST, then the WRITE FENCE
 * (`read_model_projection_state` FOR UPDATE, held to COMMIT) BEFORE the first
 * retirement row is read or written — THE LOCK ORDER every protocol writer
 * keeps (`adoptState.ts`), which the protocol tables' trigger enforces: a
 * row write made before it is refused — against `fenceHolder`, the projector
 * instance this cell had resident when the pass detached it, which guard (b)
 * matched to the acknowledgement. A projector's stop does not clear `write_fence`; another
 * cell's cold build (a lease that moved after the last `stillSafeToWrite`) or
 * a promotion's lifecycle fence does, and then this throws
 * `ReadModelWriteFenceError` and rolls back: no DB row committed and ModelMeta
 * not repointed — the base writes and the overlay clear in Automerge have
 * already happened (they are what the next pass, or the cold build, reads).
 * The order is the rotator's: overlay-rotation key, then the
 * `read_model_projection_state` row, no mutex. A null `fenceHolder` (no
 * resident instance could be named) refuses.
 *
 * A workspace with NO retirement row at all (rotation never ran) gets no row
 * (the transaction, the plane and the fence checks still run). A row there
 * would refuse its promotion to the static plane for ever
 * (`promoteSummaryWorkspace.ts`).
 *
 * Otherwise, per segment:
 *  - the CURRENT head (the one this pass replaces) is retired at its post-clear
 *    heads (the rotator's own upsert, for all such segments in one statement:
 *    `commitOrdinaryHeadRetirements`): H_r is
 *    "already published" because the re-attach's cold build publishes it, and
 *    a write that arrives after the clear is after H_r, so it is forwarded
 *    into the fresh head. Without it the head stays listed with no row and
 *    splits every fold run that crosses it;
 *  - a fold PRODUCT whose heads moved has its `forwarded_heads` advanced, by
 *    compare-and-set, to the post-clear heads: nothing else ever settles a
 *    product. A CAS that does not move throws, and the pass ends unrepointed;
 *  - a non-current head with NO row is adopted the same way as the current one
 *    (heals the split chains earlier compactions left);
 *  - every other row is left alone: a retired head's clear is carried by the
 *    forwarder at the re-attach (its removals are ignored and its
 *    `forwarded_heads` advances), a `folded` one cannot be listed here (the
 *    pass refused, guard (e)), an `admitted` one is the rotator's.
 *
 * NOTE: the rows this writes carry `origin = 'rotation'` (the column's CHECK
 * admits `rotation` and `fold-product` only), so the durable rotation rate
 * (`ordinaryRotationTelemetry.ts`) counts one extra rotation per collection
 * per compaction for the head it replaces, PLUS one per adopted rowless head
 * — on the first compaction after the upgrade, one per compaction head
 * earlier passes left listed.
 */
export async function settleCompactedOrdinarySegments(
  client: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  segments: ReadonlyArray<CompactionSegment>,
  fenceHolder: string | null,
): Promise<SettledCompactedSegments> {
  const settled: SettledCompactedSegments = { retired: [], forwarded: [], adopted: [] }
  let inTransaction = false
  try {
    // ONE statement for BEGIN + the bound, as the rotator does: as two, a
    // BEGIN that succeeded and a SET that threw would leave the transaction
    // open while `inTransaction` still said false.
    await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
    inTransaction = true
    await assertReadModelPlane(client, key, 'ordinary')
    // Refused before any statement when no instance can be named at all.
    if (!fenceHolder) throw new ReadModelWriteFenceError(key, '(no resident projector instance)', undefined)
    // The fence FIRST, before the first retirement row is locked: every
    // writer of the protocol rows takes the `read_model_projection_state`
    // row before its own row locks (`adoptState.ts`, THE LOCK ORDER; the
    // protocol tables' trigger refuses a row write made before this
    // statement). Its FOR UPDATE holds the fence row to COMMIT, and a
    // mismatch throws into the ROLLBACK below before anything is written.
    await assertReadModelWriteFence(client, key, fenceHolder)
    const rows = await loadOrdinaryHeadRetirements(client, key)
    if (rows.size > 0) {
      // Decided from the rows as read above, then written in at most TWO
      // protocol statements (the retirements, the forwards) rather than one
      // per segment: each pays the trigger's digest while this transaction
      // holds the fence row (measured). The
      // decisions cannot depend on each other's writes — every segment is a
      // distinct document — and a refusal anywhere rolls the whole
      // transaction back, as the per-segment loop did.
      const retire: Array<{ documentId: string; retirementHeads: readonly string[] }> = []
      const forward: Array<{ documentId: string; expected: readonly string[] | null; next: readonly string[] }> = []
      for (const segment of segments) {
        if (!segment.heads.length) {
          throw new Error(`compaction settle of ${key.landscapeId}/${key.versionId} ${collection} `
            + `${segment.documentId}: no heads (an empty H_r would forward the whole history)`)
        }
        const row = rows.get(retirementKey(collection, segment.documentId))
        if (segment.current || !row) {
          retire.push({ documentId: segment.documentId, retirementHeads: segment.heads })
          ;(segment.current ? settled.retired : settled.adopted).push(segment.documentId)
          continue
        }
        if (row.status !== 'retired' || !row.retirementHeads) continue
        if (sameHeads(segment.heads, row.forwardedHeads ?? row.retirementHeads)) continue
        if (!(await isFoldProduct(client, key, collection, row))) continue
        forward.push({ documentId: segment.documentId, expected: row.forwardedHeads, next: segment.heads })
        settled.forwarded.push(segment.documentId)
      }
      await commitOrdinaryHeadRetirements(client, key, collection, retire)
      const moved = await commitForwardedHeadsBatch(client, key, collection, forward)
      const stale = forward.find((move) => !moved.has(move.documentId))
      if (stale) {
        throw new Error(`compaction settle of ${key.landscapeId}/${key.versionId} ${collection} `
          + `fold product ${stale.documentId}: forwarded_heads moved under the pass`)
      }
    }
    await client.query('COMMIT')
    inTransaction = false
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  if (settled.retired.length || settled.forwarded.length || settled.adopted.length) {
    console.warn(JSON.stringify({
      event: 'read_model.compaction_segments_settled',
      workspace: `${key.landscapeId}/${key.versionId}`,
      collection,
      ...settled,
    }))
  }
  return settled
}

/**
 * THE META-ONLY EPOCH JOB (G4-16f): a workspace whose
 * ordinary heads ROTATE but which the compaction does not admit still grows
 * its ModelMeta's history with every rotation, and no pass ever rolls it. This
 * job rolls a `meta` epoch for it — the base shards CARRIED, never rebuilt —
 * on the same period, under the same keys as the pass's step: both
 * `overlay-rotation:` keys (so no rotation rewrites the meta lists under the
 * roll), the lifecycle lock (inside the step), the `model-epoch:` key (inside
 * the roll). Nothing is detached: the repoint makes the attached projector
 * ask to be recycled (R4-d). Off unless `AM_MODEL_EPOCHS=on`, except the
 * recovery of an attempt left in flight, as in the pass.
 */
export async function runModelEpochMetaJob(
  key: WorkspaceKey,
  deps: Pick<WorkspaceCompactionDeps, 'repo' | 'rootUrl' | 'db' | 'connect' | 'fleet' | 'ownership' | 'isShuttingDown'>
    & { modelEpochs: NonNullable<WorkspaceCompactionDeps['modelEpochs']>; log?: (event: Record<string, unknown>) => void },
): Promise<ModelEpochStepOutcome | { outcome: 'not_owned' | 'not_resident' | 'overlay_rotation_lock_contended' | 'no_epoch_rows' }> {
  const mayWrite = () => !deps.isShuttingDown() && deps.ownership.owns(key)
  if (!mayWrite()) return { outcome: 'not_owned' }
  if (!deps.modelEpochs.config.enabled && !(await modelEpochRowsExist(deps.db, key))) return { outcome: 'no_epoch_rows' }
  const fenceHolder = deps.fleet.residentProjectorInstanceId(key)
  if (!fenceHolder) return { outcome: 'not_resident' }
  type Outcome = ModelEpochStepOutcome | { outcome: 'overlay_rotation_lock_contended' }
  return withOverlayRotationKeys<Outcome>(key, deps.connect, () => ({ outcome: 'overlay_rotation_lock_contended' }), (clients) =>
    runModelEpochStep(key, {
      ...deps.modelEpochs, repo: deps.repo, rootUrl: deps.rootUrl, db: deps.db, connect: deps.connect,
      rowClient: clients.object, fenceHolder, mayWrite, log: deps.log,
    }, 'meta'))
}
