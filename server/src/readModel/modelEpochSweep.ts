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
import type { ProcessExclusion } from '../maintenance/processExclusion.js'
import { forwardModelEpochLateWrites, purgeForwardWrites, type ForwarderReport, type ForwardYield, type UnyieldingPhase } from './modelEpochForwarder.js'
import { modelEpochLock } from './modelEpochRoll.js'
import { retireModelEpochDocs, reviveRequestedRetiring, type RetireConfig, type RetireReport } from './modelEpochRetire.js'
import { fencedOn, storageDurableHeads } from './modelEpochStep.js'
import { modelEpochRowsExist } from './modelEpochStore.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { OverlayRotationLockState } from './overlayRotationLock.js'
import { withOverlayRotationKeys } from './workspaceCompaction.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * THE EPOCH SWEEP between two compaction passes (G4-16f: late writes are
 * forwarded within one event or sweep): a late write on a
 * superseded epoch document no longer waits for the next nightly pass. Every
 * {@link MODEL_EPOCH_SWEEP_INTERVAL_MS}, for each workspace this cell owns
 * and holds resident:
 *  1. ONE probe (`modelEpochRowsExist`); a workspace that never rolled stops
 *     there — the flag-off cost;
 *  2. the forwarder, under both `overlay-rotation:` keys (a try: skipped when
 *     busy) and then the `model-epoch:` key, its fenced transactions
 *     asserting the RESIDENT projector's write fence (so a cell that lost the
 *     workspace writes nothing);
 *  3. retirement (`modelEpochRetire.ts`), still under the rotation keys, then
 *     the `model-epoch:` key; both fenced on the object key's client.
 * In a process, the whole sweep TRIES the pool-heavy-pass exclusion
 * (`processExclusion.ts`) and is skipped (`busy`) while a compaction pass
 * runs: together they would fill `DB_POOL_MAX`.
 * No projector detach: the forwarder writes live documents the attached
 * projector projects, as any writer does. The rotation keys exclude the fold
 * writer and compaction, which check for an open journal once and then fold
 * or clear. Like the forwarder, it runs whatever `AM_MODEL_EPOCHS` says: rows a previous `on`
 * created keep their late writes forwarded and their documents retired.
 */
export const MODEL_EPOCH_SWEEP_INTERVAL_MS = 10 * 60_000

/**
 * THE BUDGET of one workspace's sweep. A
 * compaction pass waiting on the pool-heavy slot (`processExclusion.ts`) used
 * to wait as long as a sweep lasted — unbounded: the dedupe loop over 14 days
 * of forward writes, any `repo.flush` — and that wait counts against the
 * pass's claim lease. Now the forwarder stops at its next SAFE POINT (between
 * two sources, between two dedupe rows, before the mirror) once this budget
 * is spent, or AT ONCE when a compaction pass is waiting: what is left
 * resumes on the next sweep. Each flush has its own ceiling
 * (`FORWARD_FLUSH_TIMEOUT_MS`), so a safe point is never further away than
 * one source's forward. Retirement is skipped on a yielded sweep.
 */
export const MODEL_EPOCH_SWEEP_BUDGET_MS = 60_000

/** A sweep skipped (`busy`) behind ONE hold of the pool-heavy slot for this
 * long is ALERTED — once per hold: a hung compaction pass must not silently
 * stop every workspace's late-write forwarding. Three sweep intervals. */
export const MODEL_EPOCH_SWEEP_STARVED_ALERT_MS = 3 * MODEL_EPOCH_SWEEP_INTERVAL_MS

const alertedHolds = new WeakMap<ProcessExclusion, number>()

export interface ModelEpochSweepDeps {
  repo: Repo
  db: Queryable
  connect: () => Promise<ReleasableQueryable>
  /** The resident projector instance of the workspace, or null. */
  residentProjectorInstanceId: (key: WorkspaceKey) => string | null
  owns: (key: WorkspaceKey) => boolean
  isShuttingDown: () => boolean
  instanceId: string
  retire: RetireConfig
  log?: (event: Record<string, unknown>) => void
  /** The process's pool-heavy-pass exclusion (`processExclusion.ts`): the
   * sweep TRIES it and answers `busy` while a compaction pass holds it. */
  exclusion?: ProcessExclusion
  /** Default {@link MODEL_EPOCH_SWEEP_BUDGET_MS}. */
  budgetMs?: number
  /** Forward only, no retirement walk (the event-driven pass): retirement decodes storage and is the periodic sweep's business. */
  forwardOnly?: boolean
  /** The forwarder's maintenance (dedupe sweep, text mirror; default true):
   * false for an event-driven pass that is not S9
   * (`ForwarderDeps.maintenance`). */
  maintenance?: boolean
  /** Wait this long for the pool-heavy slot as a waiter before answering
   * `busy` (the periodic sweep). Absent: try only. */
  exclusionWaitMs?: number
  /** Do not yield to a WAITER (`preempted`) before the pass
   * has held the slot this long. An URGENT event-driven pass (a latch, S9)
   * waits as a waiter itself; without a grace the next waiter of the
   * periodic loop would preempt it at its first safe point, before any
   * work. Absent: yield at once (the periodic sweep, an ordinary pass). */
  yieldGraceMs?: number
  /** Default {@link MODEL_EPOCH_SWEEP_STARVED_ALERT_MS}. */
  starvedAlertMs?: number
  /** Called once, the moment the sweep HOLDS the pool-heavy slot (the
   * event-driven trigger counts its budget from there, not from the wait). Never called for a sweep that did not get it. */
  onAcquired?: () => void
  /** Marks a phase with no safe
   * point — retirement, the purge, the text mirror — while it runs
   * (`UnyieldingHolds.during`), so a latch is not "ready" behind it. Absent:
   * the phase just runs. */
  unyielding?: <T>(phase: () => Promise<T>, name?: UnyieldingPhase) => Promise<T>
  now?: () => number
}

export type ModelEpochSweepOutcome =
  | { outcome: 'no_epoch_rows' }
  | { outcome: 'not_owned' }
  | { outcome: 'not_resident' }
  | { outcome: 'busy'; heldForMs?: number }
  | { outcome: 'swept'; forwarded: ForwarderReport | SweepRotationContended; retired: RetireReport | { outcome: 'model_epoch_lock_contended' } | { outcome: 'yielded'; reason: ForwardYield } | { outcome: 'skipped_forward_only' } | SweepRotationContended; purgedWrites?: number }

/** The sweep's forwarder skipped: a rotation key was busy (or unanswered). */
export interface SweepRotationContended {
  outcome: 'overlay_rotation_lock_contended'
  kind: OverlayCollection
  state: OverlayRotationLockState
}

export async function sweepModelEpochs(key: WorkspaceKey, deps: ModelEpochSweepDeps): Promise<ModelEpochSweepOutcome> {
  if (!(await modelEpochRowsExist(deps.db, key))) return { outcome: 'no_epoch_rows' }
  const mayWrite = () => !deps.isShuttingDown() && deps.owns(key)
  if (!mayWrite()) return { outcome: 'not_owned' }
  // A cheap first look: a workspace not resident does not queue for the slot
  // — unless the slot is HELD: a compaction
  // detaches the workspace's projector while it holds the slot and attaches
  // a new one at its end, so "not resident" then means "not YET". The pass
  // queues like any other (a latch's waits as a waiter, an ordinary one is
  // `busy`, a refusal) and reads the residency again under the slot. Before,
  // the three latch passes a workspace may start in 2 s ended `not_resident`
  // in a few ms behind a compaction, the rest of the latch's asks waited for
  // nothing, and the tabs backed off together: no hop in 150 s, 1 run in 3.
  if (!deps.residentProjectorInstanceId(key) && !deps.exclusion?.hold()) return { outcome: 'not_resident' }
  // THE FENCE HOLDER IS READ UNDER THE SLOT:
  // an urgent pass (a latch, S9) or the periodic sweep that WAITED for the
  // slot behind a compaction must not use the projector instance it saw
  // before the wait — the compaction detached that projector and rebuilt
  // the read model under a NEW instance, and every fenced transaction of
  // the pass would fail `write fence lost`. Nothing else detaches a
  // projector for a compaction while the slot is held.
  const underSlot = (): Promise<ModelEpochSweepOutcome> => {
    deps.onAcquired?.()
    if (!mayWrite()) return Promise.resolve({ outcome: 'not_owned' })
    const fenceHolder = deps.residentProjectorInstanceId(key)
    if (!fenceHolder) return Promise.resolve({ outcome: 'not_resident' })
    return sweepUnderKeys(key, deps, mayWrite, fenceHolder)
  }
  if (!deps.exclusion) return underSlot()
  // ONE POOL-HEAVY PASS AT A TIME in this process:
  // a compaction pass running now forwards late writes itself.
  const exclusion = deps.exclusion
  // The PERIODIC sweep waits a bounded while, as a waiter — a
  // running event-driven pass yields to it at its next safe point instead of
  // making it skip its turn; the event-driven pass only tries.
  const ran = deps.exclusionWaitMs !== undefined && deps.exclusionWaitMs > 0
    ? await exclusion.runWithin(underSlot, deps.exclusionWaitMs)
    : await exclusion.tryRun(underSlot)
  if (ran.ran) return ran.value
  // SKIPPED. Silent once is right (a nightly pass forwards itself); silent
  // for as long as one hold lasts is not: alert once per hold past the bound.
  const hold = exclusion.hold()
  const heldForMs = hold ? (deps.now ?? Date.now)() - hold.sinceMs : undefined
  if (hold && heldForMs !== undefined && heldForMs >= (deps.starvedAlertMs ?? MODEL_EPOCH_SWEEP_STARVED_ALERT_MS)
    && alertedHolds.get(exclusion) !== hold.seq) {
    alertedHolds.set(exclusion, hold.seq)
    deps.log?.({ event: 'model_epoch.sweep.starved', alert: true, heldForMs, waiting: exclusion.waiting(),
      landscapeId: key.landscapeId, versionId: key.versionId,
      detail: 'one pool-heavy pass (a compaction) has held the slot this long: every epoch sweep of this process is skipped until it ends' })
  }
  return { outcome: 'busy', ...(heldForMs !== undefined ? { heldForMs } : {}) }
}

async function sweepUnderKeys(key: WorkspaceKey, deps: ModelEpochSweepDeps, mayWrite: () => boolean, fenceHolder: string): Promise<ModelEpochSweepOutcome> {
  {
    // UNDER BOTH `overlay-rotation:` KEYS: the fold writer
    // and compaction check `modelEpochForwardPending` ONCE, then fold or
    // clear; a forwarder opening a journal and writing into the head or a
    // base shard in between is exactly what that check exists to exclude.
    // A TRY, in the order compaction takes them (object, connection, then
    // the forwarder's `model-epoch:` key — `lockEdgeScan.ts`,
    // `modelEpochRotationEdges`): busy means a rotation, a fold or a pass is
    // running, and the sweep skips this round; the pass forwards itself.
    //
    // THE FENCED TRANSACTIONS RUN ON THE OBJECT KEY'S CLIENT, as compaction's
    // do: no extra pooled connection for them. At
    // most four at once — object, connection, `model-epoch:`, a plain query.
    // Retirement runs under the same keys, after the forwarder released its
    // `model-epoch:` hold.
    return withOverlayRotationKeys<ModelEpochSweepOutcome>(key, deps.connect,
      (kind, state) => {
        deps.log?.({ event: 'model_epoch.sweep.overlay_rotation_lock_contended', kind, state,
          landscapeId: key.landscapeId, versionId: key.versionId })
        const contended: SweepRotationContended = { outcome: 'overlay_rotation_lock_contended', kind, state }
        return { outcome: 'swept', forwarded: contended, retired: contended }
      },
      async (clients) => {
        const fenced = fencedOn(clients.object, key, fenceHolder)
        const now = deps.now ?? Date.now
        const startedAt = now()
        const deadline = startedAt + (deps.budgetMs ?? MODEL_EPOCH_SWEEP_BUDGET_MS)
        const graceUntil = startedAt + (deps.yieldGraceMs ?? 0)
        // A waiting compaction pass first: it is the one whose claim lease runs
        // — after the urgent pass's grace.
        const shouldYield = (): ForwardYield | null => {
          const at = now()
          if ((deps.exclusion?.waiting() ?? 0) > 0 && at >= graceUntil) return 'preempted'
          return at >= deadline ? 'budget' : null
        }
        const unyielding = deps.unyielding ?? (<T>(phase: () => Promise<T>, _name?: UnyieldingPhase) => phase())
        // The `retiring`/`pinned`
        // documents the durable-heads route saw written past their cursor are
        // sources again before this pass loads its sources.
        await fenced((tx) => reviveRequestedRetiring(tx, key, deps.log)).catch((error) => {
          deps.log?.({ event: 'model_epoch.sweep.revive_failed', landscapeId: key.landscapeId, versionId: key.versionId,
            error: error instanceof Error ? error.message : String(error) })
        })
        const forwarded = await forwardModelEpochLateWrites({
          repo: deps.repo, key, db: deps.db, connect: deps.connect, fenced,
          instanceId: deps.instanceId, mayWrite, log: deps.log, shouldYield,
          ...(deps.maintenance === false ? { maintenance: false } : {}),
          ...(deps.unyielding ? { unyielding: deps.unyielding } : {}),
        })
        // The writes log keeps only what a
        // reader still needs — purged by the PERIODIC sweep even when its
        // forwarder yielded (a workspace whose sweep always yields would
        // otherwise never purge). One DELETE under the fence.
        const purge = async (): Promise<number> => unyielding(() => fenced((tx) => purgeForwardWrites(tx, key)), 'purge').catch((error) => {
          deps.log?.({ event: 'model_epoch.sweep.purge_failed', landscapeId: key.landscapeId, versionId: key.versionId,
            error: error instanceof Error ? error.message : String(error) })
          return 0
        })
        if (forwarded.outcome === 'ran' && forwarded.yielded) {
          const purgedWrites = deps.forwardOnly ? 0 : await purge()
          return { outcome: 'swept', forwarded, retired: { outcome: 'yielded', reason: forwarded.yielded }, ...(purgedWrites > 0 ? { purgedWrites } : {}) }
        }
        if (deps.forwardOnly) return { outcome: 'swept', forwarded, retired: { outcome: 'skipped_forward_only' } }
        const lock = modelEpochLock({ connect: deps.connect as never }, key)
        const state = await lock.acquire().catch(() => 'unknown' as const)
        let retired: RetireReport | { outcome: 'model_epoch_lock_contended' }
        try {
          retired = state === 'acquired'
            ? await unyielding(() => retireModelEpochDocs({ db: deps.db, fenced, key, config: deps.retire,
              durableHeads: (id) => storageDurableHeads(deps.db, id), log: deps.log }), 'retire')
            : { outcome: 'model_epoch_lock_contended' }
        } finally {
          await lock.release(state)
        }
        const purgedWrites = await purge()
        return { outcome: 'swept', forwarded, retired, ...(purgedWrites > 0 ? { purgedWrites } : {}) }
      })
  }
}
