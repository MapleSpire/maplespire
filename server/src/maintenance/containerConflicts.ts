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
 * What a conflicted list key HIDES. Shared by fsck's `container-conflict`
 * (which reports it) and `containerBackfill.ts` (which heals it for the one
 * append-only list, `writeBatchIds`). Kept free of database and lock imports
 * so fsck can use it without pulling either in.
 *
 * Two concurrent first writers of `if (!d.f) d.f = []` create two lists under
 * one key; Automerge materialises one and keeps the other only as a conflict
 * value (`Automerge.getConflicts`) — measured in `modelMeta.test.ts`.
 */

import * as Automerge from '@automerge/automerge'

/** The ModelMeta tombstone lists: reported when they hide ids, never healed. */
export const TOMBSTONE_LISTS = [
  'deletedObjectIds', 'deletedConnectionIds', 'deletedDecisionRecordIds', 'deletedDiagramIds',
] as const

/** Identity of a list entry for set comparison: ids are strings, other entries plain values. */
export const entryKey = (entry: unknown): string => JSON.stringify(entry)

/**
 * The entries some LOSING value of a conflicted list key holds and the
 * materialised (winning) value lacks — what no reader can see. Empty when the
 * key is not conflicted, when every loser's entries are already in the winner
 * (a healed conflict, which stays conflicted for ever by design), or when
 * `doc` is not an Automerge document (a plain test value, a materialised copy).
 * Order follows the losers, deduplicated.
 */
export function hiddenListEntries(doc: unknown, field: string): unknown[] {
  if (!doc || typeof doc !== 'object') return []
  let conflicts: Record<string, unknown> | undefined
  try {
    conflicts = Automerge.getConflicts(doc as Automerge.Doc<Record<string, unknown>>, field) as
      Record<string, unknown> | undefined
  } catch {
    return []
  }
  if (!conflicts || Object.keys(conflicts).length < 2) return []
  const winner = (doc as Record<string, unknown>)[field]
  const have = new Set((Array.isArray(winner) ? winner : []).map(entryKey))
  const hidden: unknown[] = []
  for (const value of Object.values(conflicts)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const key = entryKey(entry)
      if (have.has(key)) continue
      have.add(key)
      hidden.push(JSON.parse(key))
    }
  }
  return hidden
}
