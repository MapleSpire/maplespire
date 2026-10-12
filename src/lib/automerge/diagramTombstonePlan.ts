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
 * The DIAGRAM delete tombstone planner (summary-only registries).
 *
 * WHY A FOURTH TOMBSTONE FAMILY. On a summary-only workspace the registry is
 * server-owned and the client store holds a bounded WINDOW. Without tombstones,
 * deleting a diagram the window does not hold would write nothing at all:
 * `planRegistryWrites` returns an empty plan, `flushWrite`'s `desiredMetas`
 * loop is skipped, and `writeSummaryLocalRegistry` walks only ids this client
 * CREATED.
 *
 * `ModelMeta.deletedDiagramIds` closes that gap with the same mechanism as
 * `deletedObjectIds` / `deletedConnectionIds` / `deletedDecisionRecordIds` one
 * level up: the entity lives in a baseline document the client cannot write, so
 * the client records the id in the one control document it *can* write and the
 * server read model excludes + deletes it.
 *
 * THE INVARIANT THIS MODULE EXISTS TO HOLD: a tombstone comes from an EXPLICIT
 * user deletion, never from the absence of an id in the resident window. The
 * window is never proof of absence (`registryWritePlan.ts`, and the comment at
 * the head of `flushWrite`) — a window-derived plan would tombstone 9 999
 * diagrams on the first flush of a 10 000-diagram workspace. That is why
 * `tombstonedIds` is the ONLY channel into `add`: the planner is not given the
 * registry at all, so the window-difference implementation cannot even be
 * typed here.
 *
 * The un-tombstone half mirrors `unTombObjects` (bridge.ts): a re-created id
 * (undo, a JSON import under "existing ids win") must SPLICE its entry out of
 * the meta, or the recreated diagram is invisible for ever.
 *
 * Do NOT suppress an add when the id is back in the RESIDENT WINDOW. That is
 * delete-LOSES, and it fires on the wrong event — the window is refilled by
 * projections, including the echo of the client's own delete and a remote
 * twin's re-publication, so a good deletion would silently produce no
 * tombstone (`bridgeSummaryDelete.test.ts` covers this). The lift belongs where
 * `unTombObjects`' does: on a USER tick, in `detectEdits`, which
 * `applyingRemote` excludes projections from by construction.
 *
 * This planner deliberately does NOT compact. The list is bounded by "diagrams
 * ever deleted on this workspace"; folding it is a server-side concern (as for
 * `deletedObjectIds`), and `workspaceFsck`'s `diagram-tombstone-honoured` check
 * monitors it meanwhile.
 */

export interface DiagramTombstonePlanInput {
  /** Only a summary-only registry has diagrams the client cannot remove from
   * their (frozen, server-owned) baseline shard. An ORDINARY workspace — even
   * one booted `bfsActive` by a VITE flag — reconciles its resident registry
   * and must never write a tombstone: that would be a second truth about a
   * registry the client already owns. `bfsActive ∧ ¬registrySummaryOnly` is a
   * reachable state, not a hypothesis. */
  registrySummaryOnly: boolean
  /** The EXPLICIT delete intents accumulated this session
   * (`deleteDiagram` → `pendingDeletedDiagramIds` → the bridge's tombstone
   * set). The ONLY channel into {@link DiagramTombstonePlan.add}. */
  tombstonedIds: readonly string[]
  /** Ids whose deletion was undone or re-created this session — the
   * `unTombObjects` half. */
  unTombstonedIds: readonly string[]
  /** Ids CREATED by this session. `writeSummaryLocalRegistry` really does
   * `delete shard.diagrams[id]` for those in the registry write head, so a
   * tombstone would be a second truth AND permanent growth for nothing. */
  summaryLocalDiagramIds: ReadonlySet<string>
  /** `ModelMeta.deletedDiagramIds` as currently written. */
  existingTombstones: readonly string[]
}

export interface DiagramTombstonePlan {
  /** Ids to append to `ModelMeta.deletedDiagramIds`. */
  add: string[]
  /** Ids to splice OUT of `ModelMeta.deletedDiagramIds` (re-created). */
  remove: string[]
  /** Session-created ids left to `writeSummaryLocalRegistry`, which removes
   * their entry from the write-head shard outright. Reported rather than
   * silently dropped so a caller can assert on the split. */
  deferredToLocalRegistry: string[]
}

const EMPTY_PLAN: DiagramTombstonePlan = Object.freeze({
  add: [], remove: [], deferredToLocalRegistry: [],
})

export function planDiagramTombstones(input: DiagramTombstonePlanInput): DiagramTombstonePlan {
  // An ordinary workspace deletes through `planRegistryWrites` →
  // `reconcile[].removeIds`; that path must stay the only one there.
  if (!input.registrySummaryOnly) return EMPTY_PLAN

  const existing = new Set(input.existingTombstones)
  // A lift always wins over an add for the same id in the same pass. The bridge
  // keeps the two sets disjoint (`detectEdits` moves an id from one to the
  // other), but a planner that could emit both would make the outcome depend on
  // the order of two loops.
  const lifting = new Set(input.unTombstonedIds)
  const add: string[] = []
  const deferredToLocalRegistry: string[] = []
  const seen = new Set<string>()
  for (const id of input.tombstonedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (input.summaryLocalDiagramIds.has(id)) {
      deferredToLocalRegistry.push(id)
      continue
    }
    if (lifting.has(id)) continue
    if (existing.has(id)) continue
    add.push(id)
  }

  const remove: string[] = []
  const lifted = new Set<string>()
  for (const id of input.unTombstonedIds) {
    if (lifted.has(id) || !existing.has(id)) continue
    lifted.add(id)
    remove.push(id)
  }

  if (add.length === 0 && remove.length === 0 && deferredToLocalRegistry.length === 0) {
    return EMPTY_PLAN
  }
  return { add, remove, deferredToLocalRegistry }
}
