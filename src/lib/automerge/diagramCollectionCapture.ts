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

import type { Comment, Flow } from '../../types'
import {
  DIAGRAM_COLLECTION_INTENT_KINDS,
  deepEqualPlain,
  isDiagramCollectionKind,
  mergeChangedFields,
  type DiagramCollectionIntentKind,
  type PendingEntityIntents,
  type SerializedEntityIntent,
} from './entityIntents'
import { stripUndefined } from './docSafe'

/**
 * The CAPTURE and ACK layers of the DIAGRAM-COLLECTION crash journal (phase
 * B): comments and flows, id-keyed maps on each per-diagram DiagramDoc. Pure
 * for the same structural reason `smallCollectionCapture.ts` is — the unit
 * tier is blind to bridge.ts, and both of round 8's CRITICALs lived in the
 * layer the tests could not see.
 *
 * Two properties distinguish these families from the small collections:
 *
 * 1. The store slices are WINDOWED to the active diagram and replaced
 *    wholesale by every projection of the active doc (a diagram switch, a
 *    remote change, a BFS attach). Every such replacement must reseed the
 *    baselines on the SAME synchronous tick — the ADR page-swap discipline —
 *    or the swap reads as a burst of user deletes.
 * 2. Each entity names its own carrier: a Comment/Flow value carries
 *    `diagramId`, and a delete intent records it explicitly (the id alone
 *    cannot say which DiagramDoc to delete from). Capture accepts entities of
 *    ANY diagramId present in the slice — a JSON import pushes flows of
 *    freshly created diagrams through the window, and journaling them is what
 *    closes their one-chance-to-land window.
 *
 * The BASELINE CONTRACT (same as the small-collection capture): seeded ONLY
 * from durable provenance (a doc projection, a completed flush, the replay's
 * own writes), NEVER from "this was a remote tick".
 */

export interface DiagramCollectionSlices {
  comment: readonly Comment[]
  flow: readonly Flow[]
}

export interface DiagramCollectionDiffOutcome {
  /** An id was journaled that held no live intent — the leading-edge
   * persistence trigger (a hard kill fires no pagehide). */
  newIntentKey: boolean
  /** Anything recorded at all — the coalesced-persist trigger. */
  recorded: boolean
  /** A delete was recorded (always persisted immediately), or an upsert
   * replaced a pending delete / vice versa (op flip). */
  persistImmediately: boolean
}

export class DiagramCollectionCapture {
  private readonly baselines: Record<DiagramCollectionIntentKind, Map<string, unknown>> = {
    comment: new Map(), flow: new Map(),
  }
  private readonly captured: Record<DiagramCollectionIntentKind, Map<string, unknown>> = {
    comment: new Map(), flow: new Map(),
  }

  /** True once ANY family has been seeded — same gate as the small
   * capture: before the first durable projection there is no baseline to
   * diff deletes against, and journaling every projected entity as
   * "created" would clobber colleague edits on replay. */
  seeded = false

  /** Reseed the given families' baselines wholesale from durable-provenance
   * values. Families absent from `slices` are left untouched. */
  seed(slices: Partial<DiagramCollectionSlices>): void {
    for (const kind of DIAGRAM_COLLECTION_INTENT_KINDS) {
      const items = slices[kind]
      if (items === undefined) continue
      const baseline = this.baselines[kind]
      baseline.clear()
      this.captured[kind].clear()
      for (const item of items) baseline.set(item.id, item)
      this.seeded = true
    }
  }

  reset(): void {
    for (const kind of DIAGRAM_COLLECTION_INTENT_KINDS) {
      this.baselines[kind].clear()
      this.captured[kind].clear()
    }
    this.seeded = false
  }

  /**
   * Diff the store slices against the baselines and record intents. USER
   * ticks only — the caller gates on `applyingRemote`. Deletes take their
   * `diagramId` from the BASELINE value (the deleted entity itself), so the
   * replay knows which carrier to delete from.
   */
  diff(
    slices: DiagramCollectionSlices,
    journal: PendingEntityIntents,
    workspaceKey: string,
  ): DiagramCollectionDiffOutcome {
    const outcome: DiagramCollectionDiffOutcome = {
      newIntentKey: false, recorded: false, persistImmediately: false,
    }
    if (!this.seeded) return outcome
    for (const kind of DIAGRAM_COLLECTION_INTENT_KINDS) {
      const baseline = this.baselines[kind]
      const captured = this.captured[kind]
      const present = new Set<string>()
      for (const item of slices[kind] as ReadonlyArray<Comment | Flow>) {
        const key = item.id
        present.add(key)
        const base = baseline.get(key)
        if (base === item) { captured.delete(key); continue }
        if (captured.get(key) === item) continue
        captured.set(key, item)
        const pendingOp = journal.pendingOp(workspaceKey, kind, key)
        if (pendingOp === null) outcome.newIntentKey = true
        else if (pendingOp === 'delete') outcome.persistImmediately = true
        // A pending CREATION must stay a creation: a baseline adopted from a
        // reseed that included the not-yet-acknowledged entity would demote
        // the intent to a field patch, and the replay would assert fields of
        // an entity it never recreates (see PendingEntityIntents.
        // pendingCreation). Only applies while the creation is unacked; the
        // ordinary edit path records the durable baseline as before.
        const stillCreation = journal.pendingCreation(workspaceKey, kind, key)
        journal.recordUpsert(
          workspaceKey, kind, key,
          item,
          stillCreation ? undefined : base as Comment | Flow | undefined,
        )
        outcome.recorded = true
      }
      for (const key of [...baseline.keys()]) {
        if (present.has(key)) continue
        const base = baseline.get(key) as { diagramId?: string } | undefined
        baseline.delete(key)
        captured.delete(key)
        journal.recordDelete(workspaceKey, kind, key, { diagramId: base?.diagramId })
        outcome.persistImmediately = true
        outcome.recorded = true
      }
      // Create-then-delete inside the pre-ack window: a pending CREATION was never in the baseline, so its
      // disappearance records no delete — the creation intent would survive
      // the full-set flush as a "clobbered" survivor and the replay would
      // RESURRECT the entity the user just deleted. A user tick (the caller
      // gates on applyingRemote) in which a captured-but-never-durable id
      // vanished from the slice is that deletion: retire the intent — the
      // entity was durable nowhere, there is nothing to delete or replay.
      // (Remote slice swaps cannot reach this: seed() clears `captured`.)
      for (const key of [...captured.keys()]) {
        if (present.has(key)) continue
        captured.delete(key)
        if (!journal.pendingCreation(workspaceKey, kind, key)) continue
        journal.acknowledge(workspaceKey, kind, [key], journal.revisionNow)
        outcome.persistImmediately = true
        outcome.recorded = true
      }
    }
    return outcome
  }
}

export interface DiagramCollectionAckPlan {
  ackByKind: Record<DiagramCollectionIntentKind, string[]>
  /** Intents for THIS diagram the flush did NOT express — a projection
   * clobbered the store slice between capture and flush. They stay
   * journaled; the caller schedules the replay. Intents for OTHER diagrams
   * are neither acked nor survivors: this flush never covered them. */
  survivors: boolean
}

/**
 * The VALUE-CHECKED acknowledgement decision for the DiagramDoc write of ONE
 * diagram (`flushWrite` step 3 for the active diagram, or `ensureDiagramDoc`
 * seeding a brand-new doc). `written` is read back from the doc AFTER the
 * write — the carrier is the witness. Deletes are expressed by ABSENCE from
 * the written map: the write is full-set for that diagram, so a key the doc
 * no longer carries was removed by it (or never landed — same outcome).
 */
export function planDiagramCollectionAck(
  intents: readonly SerializedEntityIntent[],
  written: Record<DiagramCollectionIntentKind, ReadonlyMap<string, unknown>>,
  diagramId: string,
  throughRevision: number,
): DiagramCollectionAckPlan {
  const plan: DiagramCollectionAckPlan = {
    ackByKind: { comment: [], flow: [] },
    survivors: false,
  }
  for (const intent of intents) {
    if (!isDiagramCollectionKind(intent.kind)) continue
    const kind = intent.kind
    if (intent.revision > throughRevision) continue
    const intentDiagramId = intent.op === 'delete'
      ? intent.diagramId
      : (intent.snapshot as { diagramId?: string }).diagramId
    if (intentDiagramId !== diagramId) continue
    const value = written[kind].get(intent.id)
    let expressed: boolean
    if (intent.op === 'delete') {
      expressed = value === undefined
    } else if (value === undefined) {
      expressed = false
    } else {
      // The MERGE predicate, not raw equality (round-8 livelock rationale).
      const snapshot = stripUndefined(intent.snapshot) as unknown as Record<string, unknown>
      const baseline = intent.baseline
        ? stripUndefined(intent.baseline) as unknown as Record<string, unknown>
        : undefined
      const writtenValue = stripUndefined(value) as Record<string, unknown>
      expressed = deepEqualPlain(mergeChangedFields(snapshot, baseline, writtenValue), writtenValue)
    }
    if (expressed) plan.ackByKind[kind].push(intent.id)
    else plan.survivors = true
  }
  return plan
}
