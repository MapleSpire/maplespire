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

import type { Repo } from '@automerge/automerge-repo'
import { compactOverlay, readProjectionAcknowledgement, type CompactionResult } from './compaction.js'
import { isStaticReadModelWorkspace } from './staticWorkspace.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'

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
 *       always leaves a trace.
 */

/** Everything the pass touches, injected so a test can drive each guard. */
export interface WorkspaceCompactionDeps {
  readonly repo: Repo
  readonly rootUrl: string
  readonly db: Queryable
  readonly fleet: {
    isResident(key: WorkspaceKey): boolean
    /**
     * `ProjectorFleet.ensure` returns FALSE — without throwing — when the
     * workspace root does not resolve, so callers must read the boolean.
     * Unreachable for the default workspace, whose resolution falls back to
     * `fallbackRootUrl`; reachable for every non-default workspace.
     */
    ensure(key: WorkspaceKey): Promise<boolean>
    release(key: WorkspaceKey, reason: string): void
    /** The projector instance this cell has resident, for guard (b). */
    residentProjectorInstanceId(key: WorkspaceKey): string | null
  }
  readonly ownership: { owns(key: WorkspaceKey): boolean }
  readonly isShuttingDown: () => boolean
  readonly log?: (message: string) => void
  readonly warn?: (message: string) => void
}

export type WorkspaceCompactionSkip =
  | 'summary_workspace'
  | 'projection_not_acknowledged'
  | 'foreign_projector_instance'
  | 'ownership_lost_mid_fold'

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
  try {
    const attached = await deps.fleet.ensure(key)
    if (!attached) {
      warn(
        `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
        + 'the projector-instance refresh did not throw, but the workspace root did not resolve',
      )
    }
    return attached
  } catch (error) {
    warn(
      `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
      + `re-attach failed during the projector-instance refresh: ${String(error)}`,
    )
    return false
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
}

const NOTHING = {
  objectsFolded: 0, connectionsFolded: 0, objectsKept: 0, connectionsKept: 0,
  objectsDeleted: 0, connectionsDeleted: 0,
} as const

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
  if (!deps.fleet.isResident(key)) await deps.fleet.ensure(key)

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

  // Detach listeners before compaction writes. The restart's cold build
  // re-derives the authoritative read model afterwards.
  deps.fleet.release(key, 'compaction')
  let result: WorkspaceCompactionResult
  let reattach: ReattachOutcome
  try {
    // The rotated heads and overflow shards are claimed at write.
    // `mode: 'apply'` is stated, not defaulted — this is the call site that
    // rewrites base shards.
    result = await compactOverlay(deps.repo, deps.rootUrl, {
      workspace: key, mode: 'apply', stillSafeToWrite: stillOwnedAndOrdinary,
    })
  } finally {
    // GUARD (c). Every way of NOT re-attaching is named in the returned outcome
    // and warned, so a detached workspace never goes unrecorded.
    if (deps.isShuttingDown()) {
      reattach = 'skipped_shutting_down'
      warn(`[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: shutting down`)
    } else if (!deps.ownership.owns(key)) {
      reattach = 'skipped_not_owned'
      warn(`[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: ownership lost`)
    } else {
      // THIS `await` MUST NOT THROW OUT OF THE `finally`. A workspace promoted
      // to summary mid-fold makes `ensure()` throw
      // `ProjectorStaticWorkspaceError`; uncaught, that would discard the
      // compaction result, leave `reattach` unassigned and REPLACE any error
      // `compactOverlay` was already throwing.
      try {
        // `ensure` answers false, without throwing, for a workspace whose root
        // does not resolve — see the `ensure` signature above.
        const attached = await deps.fleet.ensure(key)
        reattach = attached ? 'reattached' : 'skipped_reattach_no_root'
        if (!attached) {
          warn(
            `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
            + 'the re-attach did not throw, but the workspace root did not resolve, so no projector was started',
          )
        }
      } catch (error) {
        reattach = 'skipped_reattach_failed'
        warn(
          `[compaction] read plane left DETACHED for ${key.landscapeId}/${key.versionId}: `
          + `re-attach threw: ${String(error)}`,
        )
      }
    }
  }

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
    + '; read model rebuilt',
  )
  return { result, reattach }
}
