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

import type { DecisionRecord, Domain, Group, Tag } from '../../types'
import {
  SMALL_COLLECTION_INTENT_KINDS,
  deepEqualPlain,
  mergeChangedFields,
  type PendingEntityIntents,
  type SerializedEntityIntent,
  type SmallCollectionIntentKind,
} from './entityIntents'
import { stripUndefined } from './docSafe'

/**
 * The CAPTURE and ACK layers of the small-collection crash journal, kept PURE
 * (outside bridge.ts) so they can be unit-tested: every test that touches
 * bridge.ts mocks it, so a capture that silently dropped every group delete
 * would otherwise run the whole suite green. This module touches no Automerge
 * handle and no store: bridge feeds it slices and a journal, tests feed it the
 * same.
 *
 * The BASELINE CONTRACT: a baseline is the last value BELIEVED DURABLE per id,
 * and it may be seeded ONLY from durable provenance — the pre-overlay
 * projection values, a completed flush, or the replay's just-written values.
 * It must NEVER be derived from "this was a remote tick":
 * `clearExplicitDeleteIntents` re-enters the store subscriber synchronously
 * under `applyingRemote` with the POST-DELETE slices, and a seed hooked there
 * would reseed the baseline out from under the delete diff, so deletes would
 * never be journaled.
 */

export interface SmallCollectionSlices {
  group: readonly Group[]
  domain: readonly Domain[]
  tagSnapshot: readonly Tag[]
  decisionRecord: readonly DecisionRecord[]
}

export const smallCollectionKeyOf: {
  [K in SmallCollectionIntentKind]: (item: SmallCollectionSlices[K][number]) => string
} = {
  group: (item) => item.id,
  domain: (item) => item.id,
  // Canonical catalog id — the key `writeSmallCollections` uses for the
  // ModelMeta map. TagSnapshot has no `id` field, so nothing can diverge.
  tagSnapshot: (item) => item.tagId,
  decisionRecord: (item) => item.id,
}

export interface SmallCollectionDiffOutcome {
  /** An id was journaled that held no live intent — the leading-edge
   * persistence trigger (a hard kill fires no pagehide). */
  newIntentKey: boolean
  /** Anything recorded at all — the coalesced-persist trigger. */
  recorded: boolean
  /** A delete was recorded — always persisted immediately, and also set when
   * an upsert REPLACED a pending delete (or vice versa): the disk would
   * otherwise hold the opposite op for up to the persist ceiling, and a hard
   * kill would replay a delete of an entity the user just restored. */
  persistImmediately: boolean
}

export class SmallCollectionCapture {
  private readonly baselines: Record<SmallCollectionIntentKind, Map<string, unknown>> = {
    group: new Map(), domain: new Map(), tagSnapshot: new Map(), decisionRecord: new Map(),
  }
  private readonly captured: Record<SmallCollectionIntentKind, Map<string, unknown>> = {
    group: new Map(), domain: new Map(), tagSnapshot: new Map(), decisionRecord: new Map(),
  }

  /** Reseed the given families' baselines wholesale from durable-provenance
   * values. Families absent from `slices` are left untouched — the replay
   * reseeds only what it wrote, so a pending domain edit is not adopted as
   * its own baseline by a group replay. */
  seed(slices: Partial<SmallCollectionSlices>): void {
    for (const kind of SMALL_COLLECTION_INTENT_KINDS) {
      const items = slices[kind]
      if (items === undefined) continue
      const keyOf = smallCollectionKeyOf[kind] as (item: unknown) => string
      const baseline = this.baselines[kind]
      baseline.clear()
      this.captured[kind].clear()
      for (const item of items) baseline.set(keyOf(item), item)
      this.seeded = true
    }
  }

  reset(): void {
    for (const kind of SMALL_COLLECTION_INTENT_KINDS) {
      this.baselines[kind].clear()
      this.captured[kind].clear()
    }
    this.seeded = false
  }

  /** True once ANY family has been seeded — the capture gate: before the
   * first durable projection there is no baseline to diff deletes against,
   * and journaling every projected entity as "created" (baseline undefined ⟹
   * whole-value replay) would clobber colleague edits on replay. */
  seeded = false

  /**
   * Diff the store slices against the baselines and record intents. USER
   * ticks only — the caller gates on `applyingRemote`. Upserts diff by ref
   * (immer gives an edited entity a new ref); deletes are baseline ids
   * missing from the slice, which is safe against ADR page swaps because
   * every remote slice replacement reseeds its family's baseline on the same
   * synchronous tick, before any user tick can diff.
   */
  diff(
    slices: SmallCollectionSlices,
    journal: PendingEntityIntents,
    workspaceKey: string,
  ): SmallCollectionDiffOutcome {
    const outcome: SmallCollectionDiffOutcome = {
      newIntentKey: false, recorded: false, persistImmediately: false,
    }
    if (!this.seeded) return outcome
    for (const kind of SMALL_COLLECTION_INTENT_KINDS) {
      const keyOf = smallCollectionKeyOf[kind] as (item: unknown) => string
      const baseline = this.baselines[kind]
      const captured = this.captured[kind]
      const present = new Set<string>()
      for (const item of slices[kind] as readonly unknown[]) {
        const key = keyOf(item)
        present.add(key)
        const base = baseline.get(key)
        if (base === item) { captured.delete(key); continue }
        if (captured.get(key) === item) continue
        captured.set(key, item)
        const pendingOp = journal.pendingOp(workspaceKey, kind, key)
        if (pendingOp === null) outcome.newIntentKey = true
        else if (pendingOp === 'delete') outcome.persistImmediately = true
        journal.recordUpsert(
          workspaceKey, kind, key,
          item as Group | Domain | Tag | DecisionRecord,
          base as Group | Domain | Tag | DecisionRecord | undefined,
        )
        outcome.recorded = true
      }
      for (const key of [...baseline.keys()]) {
        if (present.has(key)) continue
        baseline.delete(key)
        captured.delete(key)
        journal.recordDelete(workspaceKey, kind, key)
        outcome.persistImmediately = true
        outcome.recorded = true
      }
      // Create-then-delete inside the pre-ack window (same hole as the
      // diagram-scoped captures): a pending CREATION was never in the baseline, so its disappearance
      // records no delete and the replay would resurrect the entity the
      // user just deleted. Retire the intent — it was durable nowhere.
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

export interface SmallCollectionAckPlan {
  ackByKind: Record<SmallCollectionIntentKind, string[]>
  /** Intents the flush did NOT express — a projection clobbered the store
   * slice between capture and flush. They stay journaled; the caller
   * schedules the replay, which writes them straight into ModelMeta. */
  survivors: boolean
}

/**
 * The VALUE-CHECKED acknowledgement decision for `writeSmallCollections` —
 * pure, so the property "a full-set flush from a clobbered store must not
 * forget an intent whose newer value was never written" is unit-testable.
 *
 * `adrDeleteWitness` is the carrier-side predicate for decisionRecord
 * DELETES, read from the META DOC after the flush wrote it: on a delta/paged workspace the flush only removes/tombstones ids
 * present in the page baseline, so "absent from the store" does NOT imply
 * "expressed by the carrier" — a record opened outside the page would be
 * deleted in the store, untouched in the meta, and a store-witnessed ack
 * would throw away the delete intent the replay could still save. Null means
 * the caller could not read the meta doc: fail closed, keep the intent.
 */
export function planSmallCollectionAck(
  intents: readonly SerializedEntityIntent[],
  written: Record<SmallCollectionIntentKind, ReadonlyMap<string, unknown>>,
  throughRevision: number,
  adrDeleteWitness: ((id: string) => boolean) | null,
): SmallCollectionAckPlan {
  const plan: SmallCollectionAckPlan = {
    ackByKind: { group: [], domain: [], tagSnapshot: [], decisionRecord: [] },
    survivors: false,
  }
  for (const intent of intents) {
    const kind = intent.kind as SmallCollectionIntentKind
    if (!SMALL_COLLECTION_INTENT_KINDS.includes(kind)) continue
    if (intent.revision > throughRevision) continue
    const value = written[kind].get(intent.id)
    let expressed: boolean
    if (intent.op === 'delete') {
      expressed = kind === 'decisionRecord'
        ? adrDeleteWitness !== null && adrDeleteWitness(intent.id)
        : value === undefined
    } else if (value === undefined) {
      expressed = false
    } else {
      // The MERGE predicate, not raw equality: the flush expressed the intent
      // the moment the written value already carries every field the user
      // changed (snapshot vs baseline). Raw equality would never acknowledge
      // an intent whose replay MERGED colleague fields into the value — the
      // written value differs from the snapshot forever, the survivor
      // re-schedules the replay, the replay re-plans the same merge: a
      // livelock.
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
