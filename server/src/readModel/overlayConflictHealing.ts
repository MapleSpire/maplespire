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

/**
 * ONE healer for the two projectors and the two collections.
 *
 * The ordinary projector (`projectorService.ts`) and the static delta projector
 * (`staticDeltaProjector.ts`) both write back into a user's Automerge document
 * in exactly one situation: two clients put a whole entity at the same map key
 * concurrently (a `$` conflict), JSON shows one branch, and the other branch's
 * fields are invisible to every reader until a structural merge puts their
 * union at the key. Everything else the server projects and never touches.
 *
 * Why one module: a policy that lives in two places drifts — one projector
 * gets the per-path rule while the other keeps re-putting whole entities for
 * any conflict, orphaning concurrent users' writes. Both projectors call this.
 *
 * Three rules, each guarding against a real data loss:
 *
 *  1. PER ENTITY, NOT PER SAMPLE. Only the entities whose KEY is in conflict are
 *     written. Healing every conflicting entity in a sample once any has a `$`
 *     conflict would let a same-field-only entity have its contested leaf
 *     DELETED from the document when the published row does not carry the
 *     field yet.
 *  2. NEVER DELETE. A resolution of `undefined` is skipped, not applied: entity
 *     deletion is the ModelMeta tombstones' channel, and at an explicit field
 *     conflict the document holds two SET values — absence in the read model is
 *     "not yet published", never "deleted" (`preserveCurrentConflictPaths`).
 *  3. HEAL WHAT WAS SAMPLED, OR COME BACK. Two `await`s (capture the bases, read
 *     them) separate the sample from `handle.change`; a write landing in that
 *     window would be overwritten by a heal computed from a sample that no
 *     longer describes the document. The heads are compared
 *     SYNCHRONOUSLY right before the change — no `await` between the two, so no
 *     interleaving is possible in a single-threaded runtime — and a moved head
 *     returns `'stale'`: the write that moved it has queued the next projection
 *     (automerge-repo emits `change` synchronously from `applyMutation`), which
 *     re-samples and heals then. One edge case: a change
 *     that moves the heads WITHOUT producing a patch (a concurrent write of an
 *     identical value) emits no `change`, so that tick is lost until the next
 *     patch-producing write — rare, bounded, and never a wrong write.
 *
 * What a `$` replacement still cannot save, by construction: a client that
 * keeps writing into its own branch between the server's sample and its receipt
 * of the heal writes into a map the heal has just superseded. That window is one
 * round trip; it is the price of "one causal replacement at `$`" and it is the
 * reason the replacement must happen ONCE per conflict, not once per tick.
 */

import { getHeads } from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import { headsEqual } from './arrivalWatermark.js'
import {
  applyResolvedEntityConflicts,
  mergeConcurrentAutomergeEntity,
  wholeEntityConflictIds,
  type AutomergeEntityConflicts,
  type OverlayCollection,
} from './overlayHistoryProtocol.js'
import {
  captureOverlayEntityBases,
  overlayEntityBases,
  type OverlayConflictInput,
  type OverlayEntityBase,
} from './overlayHistoryStore.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

export interface WholeEntityHealPlan<T> {
  /** The `$` entities, in sample order — the only ones the plan may write. */
  entityIds: string[]
  /** What each of them becomes. An entity whose merge produced no value is NOT
   * here: the server never deletes as a heal (rule 2); see `skipped`. */
  resolved: Map<string, T>
  /** Entities whose merge reported a same-field conflict inside the `$` branches
   * — for the projector that keeps a conflict ledger (`recordOverlayConflicts`). */
  recorded: OverlayConflictInput[]
  /** `$` entities whose merge produced no value. Structurally empty — a `$`
   * conflict carries at least one branch value and the merge starts from it —
   * and kept as a counter rather than a belief: the driver warns loudly when it
   * is not, because the caller then publishes the lossy JSON winner. */
  skipped: string[]
}

export interface WholeEntityHealInputs<T> {
  sourceConflicts: AutomergeEntityConflicts
  /** From `overlayEntityBases`: `existed=false` reads as "no base", which the
   * merge treats as the empty record for two concurrent creations. */
  bases: ReadonlyMap<string, OverlayEntityBase>
  /** The value the read model currently PUBLISHES for the entity — the
   * projector's last snapshot — or undefined when it never published it. */
  current: (entityId: string) => T | undefined
  /** The JSON winner in the sampled document. */
  selected: (entityId: string) => T | undefined
}

/** Pure. Decide which entities a heal writes and what it writes there. */
export function planWholeEntityHealing<T extends Record<string, unknown>>(
  inputs: WholeEntityHealInputs<T>,
): WholeEntityHealPlan<T> {
  const entityIds = wholeEntityConflictIds(inputs.sourceConflicts)
  const resolved = new Map<string, T>()
  const recorded: OverlayConflictInput[] = []
  const skipped: string[] = []
  for (const entityId of entityIds) {
    const automergeConflicts = inputs.sourceConflicts.get(entityId) ?? {}
    const base = inputs.bases.get(entityId)?.data as T | undefined
    const current = inputs.current(entityId) ?? base
    const selected = inputs.selected(entityId)
    const merged = mergeConcurrentAutomergeEntity(base, current, selected, automergeConflicts)
    if (merged.value === undefined) {
      skipped.push(entityId)
      continue
    }
    resolved.set(entityId, merged.value)
    if (merged.conflicts.length) recorded.push({
      entityId,
      conflictPaths: merged.conflicts,
      baseValue: base,
      historicalValue: { selected, automergeConflicts },
      currentValue: current,
      forwardedValue: merged.value,
    })
  }
  return { entityIds, resolved, recorded, skipped }
}

/** Inside `handle.change`: one replacement per planned entity, at `$` only
 * (`applyResolvedEntityConflicts` replaces the map exactly when `$` is among
 * the entity's conflict paths, which is true of every planned entity). */
export function applyWholeEntityHealing<T>(
  target: Record<string, T>,
  plan: WholeEntityHealPlan<T>,
  sourceConflicts: AutomergeEntityConflicts,
): void {
  for (const [entityId, value] of plan.resolved) {
    applyResolvedEntityConflicts(target, entityId, value, sourceConflicts.get(entityId) ?? {})
  }
}

export type WholeEntityHealOutcome =
  /** No entity in the sample has a `$` conflict; the caller projects as usual. */
  | 'none'
  /** The document moved between the sample and the change; nothing was written.
   * The caller returns — the change that moved it re-triggers the projection. */
  | 'stale'
  /** Written and flushed. The caller returns — the heal itself re-triggers the
   * projection, which publishes the healed value. */
  | 'healed'

export interface HealableHandle {
  documentId: DocumentId
  doc(): unknown
  change(callback: (doc: unknown) => void): void
}

export interface WholeEntityHealArgs<T> extends Omit<WholeEntityHealInputs<T>, 'bases'> {
  db: Queryable
  key: WorkspaceKey
  collection: OverlayCollection
  handle: HealableHandle
  repo: { flush(documentIds?: DocumentId[]): Promise<unknown> }
  /** Heads of the document the sample was taken from, or null when unknown. */
  sampledHeads: readonly string[] | null
  /** The static projector's conflict ledger; the ordinary projector keeps none. */
  recordConflicts?: (recorded: OverlayConflictInput[]) => Promise<void>
}

/** The heads of an Automerge document, or null for anything that is not one. */
export function automergeHeadsOrNull(doc: unknown): readonly string[] | null {
  try {
    return doc ? getHeads(doc as never) : null
  } catch {
    return null
  }
}

/** The driver both projectors call from their overlay branch. */
export async function healWholeEntityConflicts<T extends Record<string, unknown>>(
  args: WholeEntityHealArgs<T>,
): Promise<WholeEntityHealOutcome> {
  const entityIds = wholeEntityConflictIds(args.sourceConflicts)
  if (!entityIds.length) return 'none'
  await captureOverlayEntityBases(args.db, args.key, args.collection, args.handle.documentId, entityIds)
  const bases = await overlayEntityBases(args.db, args.key, args.collection, args.handle.documentId, entityIds)
  const plan = planWholeEntityHealing<T>({
    sourceConflicts: args.sourceConflicts,
    bases,
    current: args.current,
    selected: args.selected,
  })
  if (plan.recorded.length && args.recordConflicts) await args.recordConflicts(plan.recorded)
  if (plan.skipped.length) {
    console.warn(
      `[read-model] ${plan.skipped.length} whole-entity conflict(s) on ${args.collection} ${args.handle.documentId} ` +
        `for ${args.key.landscapeId}/${args.key.versionId} produced no merged value and were left as they are: ` +
        plan.skipped.join(', '))
  }
  if (!plan.resolved.size) return 'none'
  // Rule 3. No `await` from here to `handle.change`. Heads that cannot be read
  // (not an Automerge document) are not evidence of movement: proceed, as the
  // change itself will fail on such a value anyway.
  const liveHeads = automergeHeadsOrNull(args.handle.doc())
  if (args.sampledHeads && liveHeads && !headsEqual(args.sampledHeads, liveHeads)) return 'stale'
  const field = args.collection === 'object' ? 'objects' : 'connections'
  args.handle.change((doc: unknown) => {
    const mutable = doc as Record<string, Record<string, T> | undefined>
    // Assign, then RE-READ: `(mutable[field] ??= {})` yields the plain `{}` it
    // assigned, not the document's map, and the heal would be lost.
    if (!mutable[field]) mutable[field] = {}
    applyWholeEntityHealing(mutable[field], plan, args.sourceConflicts)
  })
  await args.repo.flush([args.handle.documentId])
  return 'healed'
}
