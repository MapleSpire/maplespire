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
 * Strip a dangling link out of one decision record's `related`, in place.
 *
 * ## Why a splice and not a whole-record write
 *
 * The obvious repair is to read the materialized record, filter `related`, and
 * assign it back through `upsertInlineEntities`. It WORKS on every read path —
 * the inline `ModelMeta.decisionRecords` overlay wins per whole record over the
 * baseline shards, `deletedDecisionRecordIds` wins over both, and four readers
 * implement that identically. It resurrects nothing, because the value written
 * is the materialized record rather than the shard record.
 *
 * It is still wrong, and the reason has nothing to do with shards. Measured on
 * real Automerge, both merge directions:
 *
 *   whole-record assign + peer edits `content` -> content = BASE      (peer LOST)
 *   splice in place     + peer edits `content` -> content = PEER EDIT (both kept)
 *   whole-record assign + peer appends a link  -> ["l1"]              (link LOST)
 *   splice in place     + peer appends a link  -> ["l1","l3"]         (both kept)
 *
 * `map[id] = {...}` is the ONLY write to that key, so there is no conflict for
 * Automerge to resolve: the assignment wins unconditionally and the peer's whole
 * subtree becomes unreachable. A repair tool that silently eats concurrent edits
 * is the worst possible shape, so this module never reassigns a record it found.
 *
 * ## Why the match is on target + type, not on `link.id`
 *
 * That is the scan's own predicate (`referenceIntegrityScan.ts`), so repair and
 * scan stay provably in step; it removes duplicates of the same dead target in
 * one pass; and it survives the id-less links the paged read-model path can
 * produce, which a key-by-id match would silently skip.
 */

import { clonePlain } from '../ai/core/modelOps.js'

export interface DecisionRecordLike {
  related?: Array<{ type?: unknown; targetId?: unknown } | null>
  [key: string]: unknown
}

export interface MetaLike {
  decisionRecords?: Record<string, DecisionRecordLike>
  deletedDecisionRecordIds?: string[]
  [key: string]: unknown
}

export interface AdrLinkRemoval {
  adrId: string
  /** The id the link points at, which does not resolve. */
  targetId: string
  /** Link types this removal covers — `['diagram']` or `['adr','draft']`. */
  types: readonly string[]
}

/**
 * What actually happened, per removal. Reported so the caller can count
 * `applied` from EFFECTS rather than from intentions — reporting the plan count
 * is how a repair in this codebase already claimed success while changing
 * nothing.
 */
export type AdrLinkOutcome =
  /** Links were spliced out. */
  | 'removed'
  /** The record was found but held no matching link — already repaired, or the
   *  finding was stale. Not an error, and not an `applied`. */
  | 'not-found'
  /** The record is tombstoned. Touch nothing: materializing an overlay entry for
   *  a deleted record would resurrect it. */
  | 'tombstoned'
  /** No overlay entry and no baseline to seed one from. */
  | 'absent'

export interface AdrLinkRemovalResult {
  adrId: string
  targetId: string
  outcome: AdrLinkOutcome
  removed: number
}

function matches(link: unknown, targetId: string, types: readonly string[]): boolean {
  if (!link || typeof link !== 'object') return false
  const candidate = link as { type?: unknown; targetId?: unknown }
  // The `typeof` test NARROWS; it does not filter. `includes` compares with
  // SameValueZero, so no non-string value can ever match a string element —
  // measured, including `new String('diagram')`. Deleting it changes no
  // behaviour, only whether this compiles, so do not read it as a live guard.
  return candidate.targetId === targetId
    && typeof candidate.type === 'string'
    && types.includes(candidate.type)
}

/**
 * Mutate an Automerge change draft of ModelMeta.
 *
 * `baselineById` supplies the MATERIALIZED record for ids that have no overlay
 * entry yet — materialized, not the shard copy, so nothing edited or deleted
 * since the baseline is rolled back. Seeding happens at most once per record and
 * only when the entry is genuinely absent; that first materialization is the one
 * unavoidable whole-record write, and it is the same window
 * `update_decision_record` and the draft merge have always had.
 */
export function removeDecisionRecordLinks(
  meta: MetaLike,
  removals: readonly AdrLinkRemoval[],
  baselineById: ReadonlyMap<string, DecisionRecordLike>,
): AdrLinkRemovalResult[] {
  const tombstoned = new Set(meta.deletedDecisionRecordIds ?? [])
  const results: AdrLinkRemovalResult[] = []

  for (const removal of removals) {
    const { adrId, targetId, types } = removal
    if (tombstoned.has(adrId)) {
      results.push({ adrId, targetId, outcome: 'tombstoned', removed: 0 })
      continue
    }

    const records = meta.decisionRecords ?? (meta.decisionRecords = {})
    let record = records[adrId]
    if (!record) {
      const baseline = baselineById.get(adrId)
      if (!baseline) {
        results.push({ adrId, targetId, outcome: 'absent', removed: 0 })
        continue
      }
      // The one whole-record write, and only because there is nothing to splice.
      records[adrId] = clonePlain(baseline)
      record = records[adrId]
    }

    const related = record.related
    if (!Array.isArray(related)) {
      results.push({ adrId, targetId, outcome: 'not-found', removed: 0 })
      continue
    }
    // Tail-first: each splice leaves the lower indices valid. A head-first walk
    // skips the second of two adjacent matches.
    let removed = 0
    for (let i = related.length - 1; i >= 0; i--) {
      if (!matches(related[i], targetId, types)) continue
      related.splice(i, 1)
      removed++
    }
    results.push({ adrId, targetId, outcome: removed > 0 ? 'removed' : 'not-found', removed })
  }

  return results
}

/** Link types a finding kind covers. */
export function linkTypesForKind(kind: string): readonly string[] {
  return kind === 'decisionRecord.related.diagram' ? ['diagram'] : ['adr', 'draft']
}
