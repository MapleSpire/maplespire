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

import type { DecisionRecord } from '../../types'
import type { ModelMeta } from './types'
import { usesDecisionRecordDelta } from './decisionRecordDelta'

/** Just enough of ModelMeta to decide, so a test can build one by hand. */
export type ReseedMeta = Pick<
  ModelMeta,
  'staticBaseline' | 'decisionRecordShardUrls' | 'decisionRecords' | 'deletedDecisionRecordIds'
>

/**
 * Which paged ADRs the ModelMeta overlay has moved on from, and this client may
 * safely absorb.
 *
 * Extracted from `bridge.ts` so its test drives THIS code rather than a
 * transcription of it — a copy in a test file proves the algorithm and says
 * nothing about what ships, which a mutation run makes obvious immediately.
 *
 * ## Why absorbing is needed at all
 *
 * `changedDecisionRecords` re-emits any id that is already an overlay key (the
 * `|| overlayIds.has(record.id)` term), so once a platform repair creates that
 * entry, reference-identity with the page baseline stops protecting the record
 * and the next `writeSmallCollections` flush reconciles this client's STALE copy
 * straight back over the repaired one. The trigger is not an edit to that ADR:
 * all four small collections are guarded together, so renaming a group is enough.
 *
 * ## The four refusals, and why each one is not optional
 *
 * A re-seed writes the store. Writing the store on a remote event is exactly the
 * shape of the dropped-letters defect `suppressEchoUntil` was introduced for, so
 * the safe set is defined by what CANNOT be a local edit:
 *
 * - **Not in delta mode.** Inline mode needs nothing — `projectAll` re-projects
 *   `decisionRecords` straight out of this document on the same change. Running
 *   here would be pure cost, and cost paid per meta change.
 * - **Tombstoned.** `deletedDecisionRecordIds` wins over the overlay everywhere
 *   else; re-seeding a deleted record would resurrect it in the store.
 * - **Absent from the store.** Either it was never paged, or the user just
 *   deleted it and the flush has not landed. Re-adding turns that pending delete
 *   into a no-op, because `reconcileDecisionRecordCollection` only tombstones a
 *   baseline id that is MISSING from the store.
 * - **Store copy is not reference-identical to the baseline.** That is precisely
 *   the local-edit predicate the write path uses. A differing reference means an
 *   unflushed edit (or one already flushed — the baseline is not advanced by the
 *   write path), and the user's copy wins. The consequence is deliberate and
 *   conservative: once a client edits an ADR it stops absorbing remote repairs to
 *   that record until it re-pages. The alternative is overwriting keystrokes.
 *
 * Iterating the OVERLAY rather than the baseline keeps the cost proportional to
 * the edit overlay (small in delta mode) instead of to the 2 000-record page.
 */
export function overlayRecordsToReseed(
  meta: ReseedMeta | undefined,
  baseline: ReadonlyMap<string, DecisionRecord>,
  store: ReadonlyMap<string, DecisionRecord>,
): DecisionRecord[] {
  if (!meta || !usesDecisionRecordDelta(meta)) return []
  const overlay = meta.decisionRecords
  if (!overlay || baseline.size === 0) return []
  const tombstoned = new Set(meta.deletedDecisionRecordIds ?? [])
  const refreshed: DecisionRecord[] = []
  for (const id of Object.keys(overlay)) {
    if (tombstoned.has(id)) continue
    const base = baseline.get(id)
    // Subsumed by the identity test below — if `base` is undefined then `mine`
    // either is too, or differs from it. Kept for the narrowing and because
    // "not on this client's page" is a distinct reason worth reading; it is not
    // an independent guard, and a mutation run shows it as equivalent.
    if (base === undefined) continue
    const mine = store.get(id)
    if (mine === undefined || mine !== base) continue
    const remote = overlay[id] as unknown
    if (!remote) continue
    // Deep clone: `remote` is owned by the Automerge document and is frozen.
    // Handing it to the store would put a frozen, doc-lifetime object where
    // Immer expects a plain one.
    const plain = JSON.parse(JSON.stringify(remote)) as DecisionRecord
    if (JSON.stringify(plain) !== JSON.stringify(base)) refreshed.push(plain)
  }
  return refreshed
}
