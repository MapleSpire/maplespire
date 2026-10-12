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

import {
  claimDueWork,
  completeDueWork,
  enqueueDueWork,
  pruneCompletedDueWork,
  quantizeSlot,
  releaseDueWork,
  type DueWorkClaim,
} from './dueWork.js'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'

/**
 * THE COMPACTION QUEUE — a MUTATING job on the due-work queue, so every bound
 * below is chosen from the measured duration of a compaction pass.
 *
 * ## What the measurement says
 *
 * The fold is not the expensive part. At 200 000 objects the fold costs 241 ms
 * and the re-attach costs 30 565 ms — 99.2 % of the detached window — and the
 * lock the coordinator holds covers the WHOLE call, 69.7 s, which is 2.26x the
 * window. Two consequences run through this file:
 *
 *   1. A ceiling on how much there is to FOLD bounds the cheap half only. The
 *      expensive half scales with how big the WORKSPACE is. So there are two
 *      ceilings, not one, and the second is the load-bearing one.
 *   2. A pass that folds NOTHING pays the whole window anyway:
 *      `runWorkspaceCompaction` detaches before it can know there is no work.
 *      The preview answers that question in 0.2 ms, so this queue asks it
 *      BEFORE handing the workspace over.
 *
 * ## Where the re-attach happens (a judgement, not a derivation)
 *
 * The re-attach stays INSIDE the unit, under the same one-at-a-time gate as the
 * fold. A separate lane that re-attaches N workspaces while the folds continue
 * would put N concurrent cold builds against `ColdBuildAdmission`, which has
 * two slots; a window must leave `ColdBuildAdmission.snapshot().rejected`
 * unchanged.
 *
 * ## What this module does NOT do
 *
 * It does not implement the cadence policy in `cadence.ts`, and that policy's
 * hard staleness CEILING is not enforced here (nothing in production calls
 * `selectDueWorkspaces`).
 *
 * THE SLOT IS THE CADENCE. `completeDueWork` MARKS the row completed rather
 * than deleting it, and `pruneCompletedDueWork` only removes rows of earlier
 * slots, so the unique key on the quantized slot stops the same workspace being
 * proposed again inside its own window. The same key means two cells proposing
 * the same work IN ONE WINDOW write one row, so nobody has to be elected to
 * decide what is due.
 *
 * The `nothing_to_fold` gate below additionally refuses a workspace with an
 * empty overlay in 0.2 ms without detaching anything.
 */

export const COMPACTION_JOB = 'default_compaction' as const

/**
 * BOUND (ii) — HOW MANY WORKSPACES ONE WINDOW MAY COMPACT.
 *
 * A window is one `tick()`. Three is chosen against the largest scale that
 * completes IN THE SHIPPED CONFIGURATION: at 12 000 objects with the residency
 * registry attached, the call was measured at 3.21-3.26 s, and 6.92-6.99 s
 * when the pass has to cold-enter a non-resident workspace. So three units is
 * tens of seconds, not minutes.
 *
 * What happens to the workspaces that do not fit: they keep their row and are
 * claimed by a later window. Not "oldest first": one tick enqueues every
 * workspace at the SAME quantized slot, so ordering by slot alone orders
 * nothing. The claim orders by `(slot, attempts, landscape_id, version_id)`,
 * which is total, and which puts repeatedly-failing rows BEHIND fresh ones.
 */
export const DEFAULT_WINDOW_CAP = 3

/**
 * How many times one due-work row may be claimed before the queue gives up on it
 * for this slot.
 *
 * WITHOUT THIS THERE IS NO GIVING UP AT ALL. `claimDueWork` increments
 * `attempts`; a workspace that fails deterministically — a shard that never
 * becomes ready, the reproducible abort at 200 000 objects — would otherwise be
 * re-claimed every window for ever, and EACH ATTEMPT DETACHES ITS READ PLANE.
 * An immortal row also keeps its slot, so after
 * a few intervals one poisoned workspace's backlog fills every window and no
 * healthy workspace is ever claimed again.
 *
 * Giving up COMPLETES the row rather than parking it: the workspace is proposed
 * again at the next slot with a fresh attempt count, so this is a bound on
 * retries per interval, not an eviction.
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * How long a failed unit is held back before anyone may claim it again.
 *
 * The other half of the same argument. `releaseDueWork` with no deadline makes
 * the row instantly re-claimable, which on an hourly tick is a retry every hour
 * and on a one-minute tick is a retry every minute — on a job that takes the
 * read plane down while it runs.
 */
export const DEFAULT_RETRY_AFTER_MS = 30 * 60 * 1_000

/**
 * BOUND (iii), FIRST TERM — the largest workspace this pass will enter.
 *
 * 12 000 objects+connections is THE LARGEST SCALE AT WHICH THE PASS HAS BEEN
 * MEASURED TO COMPLETE. That is the whole argument for the number, and it is
 * deliberately not dressed up as a performance target: in the configuration
 * production actually ships — residency registry attached — the 200 000-object
 * pass DID NOT COMPLETE, twice, in isolation. There is no measured
 * point between 12 000 and 200 000. A ceiling set anywhere above 12 000 is a
 * guess about a region where the only observation is a failure.
 */
export const DEFAULT_MAX_WORKSPACE_OBJECTS = 12_000

/**
 * BOUND (iii), SECOND TERM — the largest fold this pass will apply.
 *
 * Evaluated from the preview. On its own it would bound the wrong half: the fold is
 * 241 ms of a 30.8 s window. It is kept because it bounds something real — the
 * write burst into the base shards, which is what `stillSafeToWrite` is
 * re-consulted around — and because an overlay far larger than any observed one
 * is a reason to look before folding, not to fold faster.
 */
export const DEFAULT_MAX_FOLDABLE = 50_000

/**
 * How long a claimed row is respected.
 *
 * IT LIVES HERE BECAUSE IT IS RELATED TO `DEFAULT_WINDOW_CAP`. A window claims
 * `DEFAULT_WINDOW_CAP` rows AT ONCE and then runs them ONE AT A TIME, so the
 * last unit's lease has to cover its queue wait as well as its own work. The
 * relation is asserted in `compactionQueue.test.ts` against the measured
 * durations: the worst case
 * a unit can reach is the ceiling, 12 000 objects, measured at 6.92-6.99 s when
 * the pass has to cold-enter.
 * Three of those is ~21 s against a 15-minute lease.
 */
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1_000

/** Read at CLAIM time, never at boot — see `killSwitch` on the deps. */
export const COMPACTION_QUEUE_ENV = 'COMPACTION_QUEUE'

export interface CompactionQueueWorkspace {
  landscapeId: string
  versionId: string
}

/** What one unit did. `skipped` is a POLICY refusal and is not a failure. */
export type CompactionQueueSkipReason =
  | 'kill_switch'
  /** This cell does not hold the workspace's lease. Asked FIRST, because every
   *  gate after it costs a round trip and the preview costs a walk of every base
   *  shard — paid, on a foreign workspace, only to be refused at the lock. */
  | 'not_owned'
  /** This cell has no projector attached, so the pass would have to cold-BUILD
   *  the workspace inside the coordinator's lock before it could fold anything. */
  | 'not_resident'
  | 'too_many_attempts'
  | 'size_unknown'
  | 'oversize_workspace'
  | 'oversize_fold'
  | 'nothing_to_fold'
  | 'vanished'
  /** The pass declined to run, or refused itself. NOT `compacted` with zero
   *  counts, which would be a window reporting that it compacted a workspace it
   *  never touched. `detail` carries which refusal it was. */
  | 'not_run'

export interface CompactionQueueUnit extends CompactionQueueWorkspace {
  status: 'compacted' | 'skipped' | 'failed'
  reason?: CompactionQueueSkipReason
  /** The pass's own refusal, verbatim, when `reason` is `not_run`. */
  detail?: string
  objectsFolded: number
  connectionsFolded: number
  /** What the pass left the read plane as, verbatim from `runWorkspaceCompaction`. */
  reattach: string | null
  error?: string
}

export interface CompactionQueueTick {
  /** False when the whole window was refused before any work was claimed. */
  ran: boolean
  refused?: 'tick_in_flight' | 'kill_switch'
  enqueued: number
  claimed: number
  compacted: number
  skipped: number
  failed: number
  /**
   * Units that folded successfully and left the READ PLANE DOWN.
   *
   * Aggregated rather than left inside each unit's log line, because a window
   * that prints `compacted 3, failed 0` while three workspaces answer 503 is a
   * green report over an outage — and `reattach` is a string the caller had to
   * know to look at. A non-zero value here is the thing to alert on.
   */
  reattachFailed: number
  units: CompactionQueueUnit[]
}

/**
 * What the pass did, and `ran: false` is not a failure.
 *
 * A UNION AND NOT A NULLABLE COUNT. `runWorkspaceCompaction` returns NORMALLY
 * with `objectsFolded: 0` and a `skippedReason` for four of its own refusals —
 * `summary_workspace`, `projection_not_acknowledged`, `foreign_projector_instance`
 * and `ownership_lost_mid_fold` — and the coordinator stamps every one of them
 * `status: 'completed'`. A caller that read only the status would book all four
 * as a successful compaction of zero, DELETE the due-work row, and report a
 * green window; in the `projection_not_acknowledged` case — the normal state of
 * a workspace with a fat overlay — the workspace would lose its turn for ever.
 */
export type CompactionPassOutcome =
  | { ran: true; objectsFolded: number; connectionsFolded: number; reattach: string }
  | { ran: false; reason: string }

/**
 * The queue operations, injected.
 *
 * Separated from the SQL so the bounds can be driven by a unit test with no
 * database at all, and so the integration test drives the same code path through
 * the real `dueWork.ts`. The alternative — a fake that pattern-matches SQL text
 * — tests the test's copy of the query.
 */
export interface CompactionQueueSeam {
  maintainable(): Promise<CompactionQueueWorkspace[]>
  /** Delete completed rows from earlier slots. The other half of marking rather
   *  than deleting on completion — see `pruneCompletedDueWork`. */
  prune(beforeSlot: Date): Promise<number>
  enqueue(workspace: CompactionQueueWorkspace, slot: Date): Promise<boolean>
  claim(limit: number): Promise<DueWorkClaim[]>
  complete(claim: DueWorkClaim): Promise<void>
  /** `retryAfterMs` holds the row back before anyone may claim it again. Omitted
   *  means immediately, which is right for a policy refusal and wrong for a
   *  failure — see `DEFAULT_RETRY_AFTER_MS`. */
  release(claim: DueWorkClaim, error: string, retryAfterMs?: number): Promise<void>
}

export interface CompactionQueueDeps {
  readonly queue: CompactionQueueSeam
  /**
   * BOUND (iv) — READ HERE, ON EVERY CLAIM AND BEFORE EVERY UNIT.
   *
   * A switch read once at boot is not a switch: turning compaction off would
   * need a deploy, and a deploy is the thing an operator reaches for the switch
   * to avoid. It is called again before each unit so that flipping it MID-WINDOW
   * stops the units that have not started — which is the only moment at which an
   * operator who has just seen something go wrong can act.
   */
  readonly killSwitch: () => boolean
  /**
   * Does this cell hold the workspace's lease?
   *
   * ASKED BEFORE ANYTHING EXPENSIVE, and that ordering is the whole point.
   * `enumerateMaintainableWorkspaces` returns every row in `versions` with no
   * ownership filter (deliberately), `claimDueWork` has no ownership
   * predicate, and the allow-list does not carry one either — so without this
   * gate, the first thing to consult ownership would be `admitRepoMaintenance`
   * INSIDE the pass. By then the unit would already have run the preview, and a
   * preview on a non-empty overlay resolves EVERY BASE SHARD — hundreds of
   * documents at large scale — pulled into this cell's Repo, on a workspace it
   * may not touch, on every tick.
   *
   * Default: owns everything, which is what a deployment with sync cells
   * disabled actually is.
   */
  readonly owns?: (workspace: CompactionQueueWorkspace) => boolean
  /**
   * Does this cell already have a projector attached?
   *
   * `runWorkspaceCompaction` cold-BUILDS a non-resident workspace before folding
   * — inside the coordinator's lock. That pre-flight is the difference between
   * `totalCallMs` and `coldEntryTotalCallMs`: 3.2 s -> 7.0 s at 12 000 objects,
   * 30.8 s -> 69.7 s at 200 000. Refusing a non-resident workspace is what makes `totalCallMs` the
   * applicable number rather than the one that is 2.26x larger.
   *
   * It is also what makes `measure` meaningful: the size is counted from `ro_*`,
   * which the cold build writes, so a workspace that has never been projected
   * counts ZERO and would sail under any ceiling.
   */
  readonly isResident?: (workspace: CompactionQueueWorkspace) => boolean
  /**
   * How big the workspace is, for bound (iii)'s first term. `null` means the
   * question could not be answered, which is refused rather than assumed small:
   * the whole point of the ceiling is that the region above it has never been
   * observed to terminate. ZERO is treated the same way — a resident workspace
   * with no read-model rows is a workspace whose size this instrument cannot see.
   */
  readonly measure: (
    workspace: CompactionQueueWorkspace,
  ) => Promise<{ objects: number; connections: number } | null>
  /**
   * The preview — a fold count without a fold. `null` means the workspace
   * went away between enqueue and claim.
   */
  readonly preview: (
    workspace: CompactionQueueWorkspace,
  ) => Promise<{ folded: number; deleted: number } | null>
  /**
   * `ran: false` means THE PASS DID NOT RUN — the coordinator gave the job to
   * another replica, ownership moved, or the pass refused itself. The row is
   * released, because the work is still due. See `CompactionPassOutcome` for the
   * defect this shape exists to make unrepresentable.
   */
  readonly compact: (workspace: CompactionQueueWorkspace) => Promise<CompactionPassOutcome>
  /**
   * THE SECOND SWITCH, and both must be set before anything is compacted.
   * `COMPACTION_QUEUE=on` says the queue may run; this says WHICH workspaces it
   * may propose, and the production wiring reads it from the same
   * `COMPACTION_WORKSPACE_ALLOWLIST` the manual route uses
   * (`readModel/compactionAllowlist.ts`). That list is EMPTY by default, so
   * turning the queue on against an unprepared deployment enqueues nothing —
   * which is the point: an unattended destructive pass over every workspace must
   * not be one environment variable away.
   *
   * Applied at ENQUEUE, so a workspace that may not be compacted never occupies
   * a row, a claim or one of the window's slots.
   */
  readonly admit?: (workspace: CompactionQueueWorkspace) => boolean
  readonly maxWorkspaceObjects?: number
  readonly maxFoldable?: number
  readonly windowCap?: number
  readonly maxAttempts?: number
  readonly retryAfterMs?: number
  /** Dedup window AND cadence: one row per workspace per interval. */
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly log?: (message: string) => void
  readonly warn?: (message: string) => void
}

/**
 * BOUND (i) — AT MOST ONE COMPACTION IN FLIGHT IN THIS QUEUE.
 *
 * Runs one function at a time, in submission order, whatever the previous one
 * did. The units are dispatched together, so THIS is what serialises them:
 * dropping the `gate.run` wrapper at the dispatch site makes a test with two due
 * workspaces observe two overlapping runs.
 *
 * WHY ONE AND NOT TWO: a single pass holds a pooled client and an advisory
 * lock for 69.7 s at 200 000 objects, of which the re-attach is a cold
 * build. Two concurrent units are two concurrent cold builds, which is the whole
 * of `ColdBuildAdmission`'s capacity spent on maintenance while user traffic
 * needs it — and `server/qa/t28f-window.mts` asserts that admission's `rejected`
 * counter is unchanged across a window.
 *
 * "IN THIS QUEUE" AND NOT "ON THIS CELL". What excludes a second compaction
 * beyond this object is the coordinator's advisory lock, and which lock that is
 * depends on `MAINTENANCE_WORKSPACE_KEYED` (see `coordinator.ts`): with it OFF —
 * the shipped default — the key is the JOB NAME, cluster-wide, so a second
 * compaction is excluded everywhere. With it ON the key is the workspace, and
 * this gate is what stops one cell overlapping two workspaces. The wiring in
 * `index.ts` refuses to tick while the flag is off, for a separate reason
 * recorded there.
 *
 * THE SECOND LINE IS THE WHOLE MECHANISM: `tail` is advanced to a promise that
 * swallows BOTH settlements, so it is never rejected and `then(fn)` needs no
 * rejection handler.
 *
 * Every `await` between acquisition and hand-off, walked. There is no acquired flag to get out of step with:
 * the slot is the tail of a chain, not a resource that can be handed back, so
 * there is nothing to leak. `fn` throwing SYNCHRONOUSLY becomes a rejection of
 * `next` because it is invoked from inside a `then` callback, so that path is
 * the same as an async rejection. What a caller receives is `next`, which
 * carries the real settlement; what the gate keeps is the swallowed copy.
 */
class OneAtATime {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn)
    // Both settlements swallowed, so the NEXT `run` chains off a promise that is
    // always fulfilled. Assigning `next` itself here would wedge the gate for
    // the life of the process on the first unit that rejected, and the units
    // after it would resolve to that same rejection without ever being invoked —
    // a window that looks like it ran and did nothing.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

export interface CompactionQueue {
  tick(): Promise<CompactionQueueTick>
}

export function createCompactionQueue(deps: CompactionQueueDeps): CompactionQueue {
  const log = deps.log ?? ((message: string) => console.log(message))
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? 24 * 60 * 60 * 1_000
  const windowCap = deps.windowCap ?? DEFAULT_WINDOW_CAP
  const maxWorkspaceObjects = deps.maxWorkspaceObjects ?? DEFAULT_MAX_WORKSPACE_OBJECTS
  const maxFoldable = deps.maxFoldable ?? DEFAULT_MAX_FOLDABLE
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryAfterMs = deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
  const owns = deps.owns ?? (() => true)
  const isResident = deps.isResident ?? (() => true)

  // BOUND (i) lives on the QUEUE, not on the tick, so two overlapping ticks
  // still cannot overlap two compactions.
  const gate = new OneAtATime()
  // A second concurrent tick is REFUSED, not joined. Joining would hand the
  // caller another window's counts as if they were this window's — the exact
  // substitution `compactionAllowlist.ts` was written to end, one layer up.
  let tickInFlight = false

  const label = (workspace: CompactionQueueWorkspace): string =>
    `${workspace.landscapeId}/${workspace.versionId}`

  async function runUnit(claim: DueWorkClaim): Promise<CompactionQueueUnit> {
    const workspace = { landscapeId: claim.landscapeId, versionId: claim.versionId }
    const base = { ...workspace, objectsFolded: 0, connectionsFolded: 0, reattach: null }

    // EVERY AWAIT WALKED, AND THE GUARD TRACKS THE RIGHT PROPOSITION: not "did
    // we finish" but "has the row been handed back". Every await between the
    // claim and the hand-off can throw: `killSwitch` is called, `measure` and
    // `preview` are round trips on the app pool and on Automerge storage, and
    // `complete`/`release` are themselves round trips. Without this guard a
    // throw from any of them would leave the row CLAIMED for the whole
    // 15-minute lease with no `last_error`.
    let settled = false
    const complete = async (): Promise<void> => {
      await deps.queue.complete(claim)
      settled = true
    }
    const release = async (reason: string, delayMs?: number): Promise<void> => {
      await deps.queue.release(claim, reason, delayMs)
      settled = true
    }

    try {
      // BOUND (iv), the mid-window reading. RELEASED rather than completed: the
      // work is still due, and the switch being off means the next tick will not
      // claim at all, so a row kept at the head of the queue starves nothing.
      if (!deps.killSwitch()) {
        await release('compaction queue switched off mid-window')
        log(`[compaction-queue] ${label(workspace)}: skipped, switched off mid-window`)
        return { ...base, status: 'skipped', reason: 'kill_switch' }
      }

      // OWNERSHIP FIRST — see the dep's docstring. Released, not completed:
      // ownership moves, and this cell may hold the lease again by the next
      // window. The attempt ceiling below is what stops that being for ever.
      if (!owns(workspace)) {
        await release('this cell does not own the workspace')
        log(`[compaction-queue] ${label(workspace)}: skipped, not owned by this cell`)
        return { ...base, status: 'skipped', reason: 'not_owned' }
      }

      // GIVING UP. `attempts` is incremented by the claim itself, so this is
      // the Nth time this row has been handed to somebody.
      if (claim.attempts > maxAttempts) {
        await complete()
        warn(
          `[compaction-queue] ${label(workspace)}: GIVING UP for this window — ${claim.attempts} `
          + `attempts, ceiling ${maxAttempts}. It is proposed again at the next slot.`,
        )
        return { ...base, status: 'skipped', reason: 'too_many_attempts' }
      }

      // NOT RESIDENT — refusing keeps the pass out of the cold-entry path, the
      // larger half of the lock hold, and keeps `measure`
      // from counting the rows of a read model that was never built.
      if (!isResident(workspace)) {
        await release('this cell has no projector attached to the workspace')
        log(`[compaction-queue] ${label(workspace)}: skipped, no projector resident on this cell`)
        return { ...base, status: 'skipped', reason: 'not_resident' }
      }

      // BOUND (iii), first term.
      const size = await deps.measure(workspace)
      if (size === null || size.objects + size.connections === 0) {
        // COMPLETED, not released, and the difference is starvation. A released
        // row keeps its slot, so a workspace whose size is permanently
        // unanswerable would consume one of the window's `windowCap` slots every
        // window. Completing returns it to the next slot's proposal, where it
        // costs one more COUNT and blocks nobody.
        //
        // ZERO IS THE SAME ANSWER AS `null`. The count comes from `ro_*`, which
        // the cold build writes; a resident workspace reporting zero rows is an
        // instrument that cannot see its subject, not a small workspace. And a
        // genuinely empty workspace has nothing to fold, so nothing is lost by
        // refusing it here.
        await complete()
        warn(`[compaction-queue] ${label(workspace)}: refused, workspace size could not be read`)
        return { ...base, status: 'skipped', reason: 'size_unknown' }
      }
      const total = size.objects + size.connections
      if (total > maxWorkspaceObjects) {
        await complete()
        warn(
          `[compaction-queue] ${label(workspace)}: refused, ${total} objects+connections is above the `
          + `ceiling of ${maxWorkspaceObjects} — the largest scale at which this pass has been measured `
          + 'to complete',
        )
        return { ...base, status: 'skipped', reason: 'oversize_workspace' }
      }

      const preview = await deps.preview(workspace)
      if (preview === null) {
        await complete()
        log(`[compaction-queue] ${label(workspace)}: vanished between enqueue and claim`)
        return { ...base, status: 'skipped', reason: 'vanished' }
      }
      // THE EMPTY-FOLD GATE. `runWorkspaceCompaction` detaches
      // the read plane unconditionally, before it can know whether there is
      // anything to fold, and the re-attach costs the same either way — ~30 s at
      // 200 000 objects for zero work. The preview answers the question for 0.2 ms
      // on an empty overlay, because `foldCollection` returns before it resolves a
      // single base shard when the overlay is empty.
      if (preview.folded + preview.deleted === 0) {
        await complete()
        log(`[compaction-queue] ${label(workspace)}: nothing to fold; the read plane was never detached`)
        return { ...base, status: 'skipped', reason: 'nothing_to_fold' }
      }
      // BOUND (iii), second term.
      if (preview.folded > maxFoldable) {
        await complete()
        warn(
          `[compaction-queue] ${label(workspace)}: refused, a fold of ${preview.folded} entries is above `
          + `the ceiling of ${maxFoldable}`,
        )
        return { ...base, status: 'skipped', reason: 'oversize_fold' }
      }

      const result = await deps.compact(workspace)
      if (!result.ran) {
        // RELEASED: the pass never ran, so the work is still due and another
        // cell — or this one, next window — should get it. Completing here would
        // silently drop a workspace's turn every time a replica lost the race,
        // or every time the projector was one generation behind.
        await release(`the compaction pass declined to run: ${result.reason}`)
        log(`[compaction-queue] ${label(workspace)}: the pass declined to run (${result.reason})`)
        return { ...base, status: 'skipped', reason: 'not_run', detail: result.reason }
      }
      // THE COUNTS ARE CAPTURED BEFORE THE BOOK-KEEPING. A `complete()` that
      // throws must not turn a fold that HAPPENED into a report of zero: the
      // pass is the subject, the row is not.
      const unit: CompactionQueueUnit = {
        ...workspace,
        status: 'compacted',
        objectsFolded: result.objectsFolded,
        connectionsFolded: result.connectionsFolded,
        reattach: result.reattach,
      }
      if (result.reattach !== 'reattached') {
        warn(
          `[compaction-queue] ${label(workspace)}: folded, but THE READ PLANE IS DOWN `
          + `(${result.reattach}) — this workspace answers 503 until something re-attaches it`,
        )
      }
      await complete()
      log(
        `[compaction-queue] ${label(workspace)}: folded ${result.objectsFolded} object(s) + `
        + `${result.connectionsFolded} connection(s); read plane ${result.reattach}`,
      )
      return unit
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // HELD BACK, not handed straight back. An immediate release on a mutating
      // job is a retry every tick on a pass that takes the read plane down while
      // it runs — see `DEFAULT_RETRY_AFTER_MS`.
      await release(message, retryAfterMs).catch((releaseError: unknown) => {
        warn(`[compaction-queue] ${label(workspace)}: could not release the claim: ${String(releaseError)}`)
      })
      warn(`[compaction-queue] ${label(workspace)}: FAILED — ${message}`)
      return { ...base, status: 'failed', error: message }
    } finally {
      // THE ROW IS ALWAYS HANDED BACK. Reached when a `complete()` or a
      // `release()` threw, or when a gate threw between the claim and its own
      // hand-off. Its own failure is logged rather than thrown: the lease is the
      // remaining recovery at that point, and replacing the real error with a
      // book-keeping one would hide the reason the unit failed.
      if (!settled) {
        await deps.queue
          .release(claim, 'the unit ended without handing its claim back', retryAfterMs)
          .catch((releaseError: unknown) => {
            warn(
              `[compaction-queue] ${label(workspace)}: the claim was NOT handed back and could not be `
              + `released either (${String(releaseError)}); it is held until the lease expires`,
            )
          })
      }
    }
  }

  return {
    async tick(): Promise<CompactionQueueTick> {
      const empty = {
        enqueued: 0, claimed: 0, compacted: 0, skipped: 0, failed: 0, reattachFailed: 0, units: [],
      }
      if (tickInFlight) return { ran: false, refused: 'tick_in_flight', ...empty }
      // BOUND (iv), the claim-time reading. Nothing is enqueued and nothing is
      // claimed while the switch is off, so turning it off leaves no rows behind
      // that a later window would have to work through.
      if (!deps.killSwitch()) return { ran: false, refused: 'kill_switch', ...empty }

      tickInFlight = true
      try {
        const slot = quantizeSlot(now(), intervalMs)
        // Yesterday's completed rows, before today's proposals. One statement,
        // on the same schedule as the work it cleans up after.
        await deps.queue.prune(slot)
        const admit = deps.admit ?? (() => true)
        let enqueued = 0
        for (const workspace of await deps.queue.maintainable()) {
          // THE ALLOW-LIST FILTERS THE PROPOSAL, not the execution. A refused
          // workspace never gets a row, so it never gets a claim, never holds a
          // lease and never spends one of the window's `windowCap` slots on
          // being turned away.
          if (!admit(workspace)) continue
          if (await deps.queue.enqueue(workspace, slot)) enqueued += 1
        }

        // BOUND (ii): the cap is the claim limit, so the workspaces beyond it are
        // never claimed and never hold a lease they are not being worked under.
        const claims = await deps.queue.claim(windowCap)
        // Dispatched together and serialised by the gate. Written this way ON
        // PURPOSE rather than as a sequential `for await`: a sequential loop is
        // an exclusion nobody can delete, so nobody can show it holds. Here the
        // gate is a named thing, and removing it makes the units overlap.
        //
        // THE `catch` IS NOT DECORATION — it is `fsckQueue.ts`'s rule, which
        // that file states as "one workspace's failure does not sink the batch",
        // applied to the failures `runUnit` cannot catch itself: the queue seam.
        // `complete`, `release`, `measure` and `preview` are round trips on the
        // app pool, so a statement timeout in ONE unit's book-keeping would
        // otherwise reject `Promise.all` and discard every other unit's outcome
        // — including units that had already compacted successfully, whose rows
        // are gone and whose counts would never be reported.
        const units = await Promise.all(
          claims.map((claim) =>
            gate.run(() => runUnit(claim)).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              // THE ONE HANDLER IN THIS FILE THAT MUST NOT THROW, so it does not
              // call anything that can without catching it. `warn` is injected;
              // a `warn` that throws here rejects `Promise.all` and discards
              // every other unit's outcome — including units that already
              // compacted, whose rows are gone and whose counts would never be
              // reported. Pinned by a test.
              try {
                warn(`[compaction-queue] ${label(claim)}: FAILED outside the pass — ${message}`)
              } catch { /* a broken logger must not cost the window its results */ }
              return {
                landscapeId: claim.landscapeId,
                versionId: claim.versionId,
                status: 'failed' as const,
                objectsFolded: 0,
                connectionsFolded: 0,
                reattach: null,
                error: message,
              }
            }),
          ),
        )

        return {
          ran: true,
          enqueued,
          claimed: claims.length,
          compacted: units.filter((unit) => unit.status === 'compacted').length,
          skipped: units.filter((unit) => unit.status === 'skipped').length,
          failed: units.filter((unit) => unit.status === 'failed').length,
          // A fold that succeeded and left the read plane DOWN. Counted apart
          // from `failed` because it is not a failure of the window — the fold
          // happened — and apart from `compacted` because a reader served 503
          // does not care which of those it was.
          reattachFailed: units.filter(
            (unit) => unit.status === 'compacted' && unit.reattach !== 'reattached',
          ).length,
          units,
        }
      } finally {
        tickInFlight = false
      }
    },
  }
}

interface CompactionQueueDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

/** The production seam: the due-work table, reached through `dueWork.ts`. */
export function dueWorkSeam(db: CompactionQueueDb, cellId: string, leaseMs: number): CompactionQueueSeam {
  return {
    maintainable: () => enumerateMaintainableWorkspaces(db),
    prune: (beforeSlot) => pruneCompletedDueWork(db, COMPACTION_JOB, beforeSlot),
    enqueue: (workspace, slot) =>
      enqueueDueWork(
        db,
        { job: COMPACTION_JOB, landscapeId: workspace.landscapeId, versionId: workspace.versionId },
        slot,
      ),
    claim: (limit) => claimDueWork(db, COMPACTION_JOB, cellId, leaseMs, limit),
    complete: (claim) => completeDueWork(db, claim),
    release: (claim, error, retryAfterMs) => releaseDueWork(db, claim, error, retryAfterMs),
  }
}

/**
 * OFF unless the environment says otherwise, and read on every call.
 *
 * Default off is the same reason `compactionAllowlist.ts` gives: this rewrites
 * base shards in place, on workspaces that have never seen the code, and a
 * deployment that upgrades must not acquire a nightly destructive job as a side
 * effect of the upgrade.
 */
export function compactionQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMPACTION_QUEUE_ENV] ?? '').trim().toLowerCase() === 'on'
}
