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

/** Merge one bounded server page without duplicating entities already loaded.
 * Existing positions stay stable; a repeated id refreshes the row in place. */
export function mergeUniquePageItems<T>(
  current: readonly T[],
  incoming: readonly T[],
  replace = false,
  keyOf: (item: T) => string = (item) => (item as { id: string }).id,
): T[] {
  const merged: T[] = replace ? [] : [...current]
  const indexById = new Map<string, number>()

  for (let index = 0; index < merged.length; index += 1) {
    indexById.set(keyOf(merged[index]), index)
  }
  for (const item of incoming) {
    const id = keyOf(item)
    const existing = indexById.get(id)
    if (existing === undefined) {
      indexById.set(id, merged.length)
      merged.push(item)
    } else {
      merged[existing] = item
    }
  }
  return merged
}

/** Merge a cursor window while enforcing an explicit resident-row product
 * limit. Once full, callers stop advancing the cursor and ask the user to
 * refine the server query instead of retaining an unbounded result set. */
export function mergeBoundedPageItems<T>(
  current: readonly T[],
  incoming: readonly T[],
  maxItems: number,
  replace = false,
  keyOf: (item: T) => string = (item) => (item as { id: string }).id,
): { items: T[]; limited: boolean } {
  const merged = mergeUniquePageItems(current, incoming, replace, keyOf)
  const limit = Math.max(1, Math.floor(maxItems))
  return {
    items: merged.slice(0, limit),
    limited: merged.length > limit,
  }
}
