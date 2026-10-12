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

import type { Diagram } from '../../types'
import {
  deepEqualPlain,
  mergeChangedFields,
  type PendingEntityIntents,
  type SerializedEntityIntent,
} from './entityIntents'
import { stripUndefined } from './docSafe'

/**
 * The CAPTURE, REPLAY-PLANNING and ACK layers of the DIAGRAM-STUB crash
 * journal (phase B). A created diagram previously lived only in Zustand for
 * the whole write debounce — a hard kill erased it with no trace — and a
 * rename/delete crash simply reverted. Pure, same rationale as the two
 * sibling capture modules.
 *
 * SCOPE: the journal witnesses against the REGISTRY META, so it covers the
 * fields the registry carries — `name`, `type`, `parentObjectId` — plus
 * whole-diagram CREATION (the snapshot is the full store value: composition
 * and layouts are what the user made, and `ensureDiagramDoc` seeds the fresh
 * DiagramDoc from them on replay). Doc-only view settings (skinId,
 * sceneDecor, …) are NOT diffed: they have no registry witness, and an
 * unwitnessable intent is a wedged badge (documented residual).
 *
 * Baselines follow the round-8 contract: durable provenance only.
 */

/** The registry-witnessable identity fields — what capture DIFFS and what
 * replay/ack compare against the meta. */
export const DIAGRAM_STUB_FIELDS = ['name', 'type', 'parentObjectId'] as const

export function diagramStubOf(value: {
  name?: unknown
  type?: unknown
  parentObjectId?: unknown
}): Record<string, unknown> {
  const stub: Record<string, unknown> = {}
  for (const field of DIAGRAM_STUB_FIELDS) {
    const v = (value as Record<string, unknown>)[field]
    if (v !== undefined) stub[field] = v
  }
  return stub
}

export interface DiagramStubDiffOutcome {
  newIntentKey: boolean
  recorded: boolean
  persistImmediately: boolean
}

export class DiagramStubCapture {
  private readonly baseline = new Map<string, Diagram>()
  /** Last ref seen per id — the skip-fast-path memo (an unchanged ref, or a
   * ref whose stub compared equal, is not re-examined). */
  private readonly seen = new Map<string, Diagram>()
  seeded = false

  seed(diagrams: readonly Diagram[]): void {
    this.baseline.clear()
    this.seen.clear()
    for (const diagram of diagrams) this.baseline.set(diagram.id, diagram)
    this.seeded = true
  }

  reset(): void {
    this.baseline.clear()
    this.seen.clear()
    this.seeded = false
  }

  /**
   * Diff the diagrams slice against the baseline. USER ticks only. Composition
   * and layout churn never records (stub comparison), with ONE exception: a
   * PENDING CREATION (id absent from the baseline) re-records its full
   * snapshot on every ref change, so the journaled creation carries the
   * latest composition/layouts right up until the first durable ack.
   *
   * `canJournal` refuses ids the current write path cannot express AT ALL
   * (a server-owned diagram under a summary-only registry: the registry loops
   * walk only session-created ids there). Journaling an unexpressable intent
   * is a permanently wedged badge, strictly worse than a lossy no-op.
   *
   * Tombstoned ids are deliberately NOT admitted. A server-owned DELETE has a
   * durable carrier (`ModelMeta.deletedDiagramIds`), but it never arrives
   * through this diff: `captureExplicitDeletes` journals it from the explicit
   * intent, earlier in the same tick and ahead of any gate. Widening
   * `canJournal` for tombstoned ids could only add an intent derived from a
   * STALE WINDOW — see the call site's comment in `bridge.ts`.
   */
  diff(
    diagrams: readonly Diagram[],
    journal: PendingEntityIntents,
    workspaceKey: string,
    canJournal: (id: string) => boolean,
  ): DiagramStubDiffOutcome {
    const outcome: DiagramStubDiffOutcome = {
      newIntentKey: false, recorded: false, persistImmediately: false,
    }
    if (!this.seeded) return outcome
    const present = new Set<string>()
    for (const diagram of diagrams) {
      present.add(diagram.id)
      const base = this.baseline.get(diagram.id)
      if (base === diagram) { this.seen.delete(diagram.id); continue }
      if (this.seen.get(diagram.id) === diagram) continue
      this.seen.set(diagram.id, diagram)
      if (!canJournal(diagram.id)) continue
      // A pending CREATION re-records on EVERY ref change, as a creation
      // (full snapshot, no baseline): the journaled creation then carries the
      // latest composition/layouts right up to the first durable ack, and a
      // baseline adopted meanwhile cannot demote it to a field patch that
      // never recreates the diagram (see PendingEntityIntents.
      // pendingCreation). Established diagrams diff on stub fields only.
      const stillCreation = journal.pendingCreation(workspaceKey, 'diagram', diagram.id)
      if (!stillCreation
        && base !== undefined
        && deepEqualPlain(diagramStubOf(diagram), diagramStubOf(base))) {
        continue
      }
      const pendingOp = journal.pendingOp(workspaceKey, 'diagram', diagram.id)
      if (pendingOp === null) outcome.newIntentKey = true
      else if (pendingOp === 'delete') outcome.persistImmediately = true
      journal.recordUpsert(
        workspaceKey, 'diagram', diagram.id, diagram,
        stillCreation ? undefined : base,
      )
      outcome.recorded = true
    }
    for (const id of [...this.baseline.keys()]) {
      if (present.has(id)) continue
      this.baseline.delete(id)
      this.seen.delete(id)
      if (!canJournal(id)) continue
      journal.recordDelete(workspaceKey, 'diagram', id)
      outcome.persistImmediately = true
      outcome.recorded = true
    }
    // Create-then-delete inside the pre-ack window: a pending CREATION was never in the baseline, so its
    // disappearance records no delete — the survivor→replay path would
    // recreate the diagram the user just deleted, hold it and re-place its
    // meta: a PERMANENT resurrection. Retire the intent instead — the
    // diagram was durable nowhere. (Remote swaps cannot reach this: seed()
    // clears `seen`.)
    for (const id of [...this.seen.keys()]) {
      if (present.has(id)) continue
      this.seen.delete(id)
      if (!journal.pendingCreation(workspaceKey, 'diagram', id)) continue
      journal.acknowledge(workspaceKey, 'diagram', [id], journal.revisionNow)
      outcome.persistImmediately = true
      outcome.recorded = true
    }
    return outcome
  }
}

export interface DiagramStubReplayInput {
  /** Only 'diagram' intents; the caller partitions. */
  intents: readonly SerializedEntityIntent[]
  /** STUB projections of the currently loaded registry metas, by diagram id. */
  currentMetaStubs: ReadonlyMap<string, Record<string, unknown>>
  /** True when `currentMetaStubs` covers the COMPLETE registry (classic mode,
   * all shards loaded). Under a summary-only registry the metas are a server
   * WINDOW plus the local shard, and absence proves nothing — absent-target
   * intents are RETAINED there instead of dropped/satisfied. */
  metasComplete: boolean
  /** `ModelMeta.deletedDiagramIds` as the client currently holds it. The
   * POSITIVE proof the summary window cannot give: a delete already tombstoned is
   * satisfied, and an EDIT whose target is tombstoned is satisfied too
   * (delete-wins — replaying the rename patch would re-place the meta and
   * resurrect the diagram permanently). A journaled CREATION is the one intent
   * that outranks a tombstone; it leaves through {@link
   * DiagramStubReplayPlan.replayLifts}. */
  tombstonedIds?: ReadonlySet<string>
  /** True when this session can EXPRESS a tombstone (a summary-only
   * registry with a resident ModelMeta). A journaled delete whose target is
   * absent and not yet tombstoned is then re-expressible instead of parked
   * for ever. */
  canTombstone?: boolean
}

export interface DiagramStubReplayPlan {
  /** Full snapshots to re-create (same id — recreation is idempotent at
   * registry-merge level, so a crash between the meta landing and the ack
   * persisting cannot produce a second diagram). */
  replayCreates: Diagram[]
  /** Present diagrams whose meta does not yet express the intent's stub
   * fields: the merged stub fields to assert (store + meta). */
  replayStubPatches: Array<{ id: string; fields: Record<string, unknown> }>
  /** Present diagrams with a pending delete: remove their meta. */
  replayDeletes: string[]
  /** Journaled deletes of SERVER-OWNED diagrams to re-express as
   * `ModelMeta.deletedDiagramIds` entries. Without this arm a delete made
   * offline (or lost to a crash before the flush) would be parked at every
   * boot for ever, badge included: the summary window can never prove
   * absence. */
  replayTombstones: string[]
  /** Tombstones to SPLICE OUT because a journaled CREATION of the same id
   * outranks them. Paired with an entry in {@link replayCreates}: replaying the
   * creation alone would write a meta that the tombstone filter hides anyway,
   * so the lift is the expression and the recreation rides on it. */
  replayLifts: string[]
  satisfied: Array<{ id: string; revision: number }>
  /** Kept journaled: absent targets whose absence the window cannot prove. */
  remaining: number
}

export function planDiagramStubReplay(input: DiagramStubReplayInput): DiagramStubReplayPlan {
  const plan: DiagramStubReplayPlan = {
    replayCreates: [], replayStubPatches: [], replayDeletes: [], replayTombstones: [],
    replayLifts: [], satisfied: [], remaining: 0,
  }
  const tombstoned = input.tombstonedIds ?? new Set<string>()
  for (const intent of input.intents) {
    if (intent.kind !== 'diagram') continue
    const meta = input.currentMetaStubs.get(intent.id)
    // DELETE-WINS, checked before anything else. A rename patch replayed over a
    // tombstoned target would re-place its registry meta — a permanent
    // resurrection of a diagram someone deliberately deleted.
    if (tombstoned.has(intent.id)) {
      // …with ONE exception, and it is data loss the other way round: a
      // journaled CREATION (an upsert with no baseline) is not a stale edit of
      // something that got deleted, it is the LATER intention — the user put
      // this id back (undo, a JSON import under "existing ids win") after the
      // deletion, and only the tombstone stands between them and their
      // diagram. Marking it `satisfied` here dropped the intent while the
      // diagram stayed hidden and the badge went green: a re-creation lost
      // with no trace, which is the exact failure this journal exists to
      // prevent.
      //
      // Replaying the create ALONE is not the cure either — the recreated meta
      // is filtered out by `summaryRegistryMetas()` and re-deleted by the
      // server projector, an invisible diagram plus a write loop. So the LIFT
      // is the expression and the create rides on it. Note what this trades:
      // a colleague's concurrent delete of an id this client is re-creating
      // resolves in favour of the re-creation. That is the same call the
      // no-tombstone branch below already makes (a creation intent outranks
      // registry absence even under `metasComplete`), it is recoverable (the
      // colleague deletes again) and it is the only direction that is not
      // silent.
      if (intent.op !== 'delete' && intent.baseline === undefined) {
        plan.replayLifts.push(intent.id)
        plan.replayCreates.push(stripUndefined(intent.snapshot) as unknown as Diagram)
        continue
      }
      plan.satisfied.push({ id: intent.id, revision: intent.revision })
      continue
    }
    if (intent.op === 'delete') {
      if (meta !== undefined) plan.replayDeletes.push(intent.id)
      else if (input.metasComplete) plan.satisfied.push({ id: intent.id, revision: intent.revision })
      else if (input.canTombstone) plan.replayTombstones.push(intent.id)
      else plan.remaining += 1
      continue
    }
    const snapshot = stripUndefined(intent.snapshot) as unknown as Diagram
    if (meta === undefined) {
      if (intent.baseline === undefined) {
        // A creation that never became durable — replay it whole.
        plan.replayCreates.push(snapshot)
      } else if (input.metasComplete) {
        // An EDIT of a diagram the complete registry no longer holds: the
        // diagram was deleted (remotely or by a later local action) — a
        // rename of a deleted diagram has nothing left to assert.
        plan.satisfied.push({ id: intent.id, revision: intent.revision })
      } else {
        plan.remaining += 1
      }
      continue
    }
    const snapshotStub = diagramStubOf(snapshot)
    const baselineStub = intent.baseline ? diagramStubOf(stripUndefined(intent.baseline)) : undefined
    const merged = mergeChangedFields(snapshotStub, baselineStub, meta as Record<string, unknown>)
    if (deepEqualPlain(merged, meta)) {
      plan.satisfied.push({ id: intent.id, revision: intent.revision })
      continue
    }
    plan.replayStubPatches.push({ id: intent.id, fields: merged })
  }
  return plan
}

export interface DiagramStubAckPlan {
  ackIds: string[]
  survivors: boolean
}

/**
 * The flush-side acknowledgement for diagram-stub intents, witnessed against
 * the registry metas as written. An upsert is expressed when the meta carries
 * every stub field the user changed (merge predicate); a delete when the id
 * is absent. `metasComplete` gates delete-by-absence exactly like the replay
 * planner. The creation-ordering gate (a meta is only placed after its
 * DiagramDoc's local flush) is what lets this ack vouch for the DOC too.
 *
 * A FOURTH witness, `tombstonedIds`, is the one that makes a
 * summary-only delete acknowledgeable at all: `metasComplete` is
 * `allShardsLoaded && !registrySummaryOnly`, i.e. permanently FALSE there, so
 * `meta === undefined && metasComplete` can never be true and a perfectly
 * successful deletion would leave the badge on "Saving…" for ever. The
 * tombstone proves the delete by PRESENCE instead of by absence — which is also
 * the honest direction: absence in a window proves nothing.
 *
 * The caller must build `tombstonedIds` from the DOCUMENT (ModelMeta's
 * `deletedDiagramIds` as the pending change leaves it), never from the
 * session's intent set: an intent is the claim, not the witness.
 */
export function planDiagramStubAck(
  intents: readonly SerializedEntityIntent[],
  currentMetaStubs: ReadonlyMap<string, Record<string, unknown>>,
  metasComplete: boolean,
  throughRevision: number,
  tombstonedIds: ReadonlySet<string> = new Set(),
): DiagramStubAckPlan {
  const plan: DiagramStubAckPlan = { ackIds: [], survivors: false }
  for (const intent of intents) {
    if (intent.kind !== 'diagram') continue
    if (intent.revision > throughRevision) continue
    const meta = currentMetaStubs.get(intent.id)
    let expressed: boolean
    if (intent.op === 'delete') {
      expressed = tombstonedIds.has(intent.id) || (meta === undefined && metasComplete)
    } else if (meta === undefined) {
      expressed = false
    } else {
      const snapshotStub = diagramStubOf(stripUndefined(intent.snapshot))
      const baselineStub = intent.baseline
        ? diagramStubOf(stripUndefined(intent.baseline))
        : undefined
      expressed = deepEqualPlain(
        mergeChangedFields(snapshotStub, baselineStub, meta as Record<string, unknown>),
        meta,
      )
    }
    if (expressed) plan.ackIds.push(intent.id)
    else plan.survivors = true
  }
  return plan
}
