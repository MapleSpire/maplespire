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
 * A cached parent summary can outlive the page that supplied its children.
 * The parent index is the authority for what the current local generation can
 * actually disclose: a chevron must never promise rows that are unavailable.
 * When the server/full download later supplies those rows, the indexed count
 * becomes positive again without relying on the stale summary.
 */
export function reconciledCachedChildCount(
  summaryCount: number,
  hasIndexedChild: boolean,
): number {
  return hasIndexedChild ? Math.max(1, summaryCount) : 0
}
