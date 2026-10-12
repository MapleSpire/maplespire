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
 * Make a value safe to write into an Automerge document.
 *
 * Automerge throws `RangeError: Cannot assign undefined value` if any property holds
 * `undefined`. A freshly-created entity routinely carries undefined optional fields
 * (parentId/icon/links/technologyUsages/…), so writing it straight into a doc/shard would
 * throw and the entity would never persist — surfacing to the user as an add/edit that
 * silently "reverts". `stripUndefined` returns a deep copy with every undefined-valued
 * key dropped (recursing through arrays + nested objects). Dropping a key also lets a
 * subsequent `reconcile` delete a field the user cleared (e.g. removed an icon).
 */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue
      out[k] = stripUndefined(val)
    }
    return out as T
  }
  return v
}
