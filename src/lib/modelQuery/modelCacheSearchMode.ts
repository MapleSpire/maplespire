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

export type ModelCacheSearchMode = 'browse' | 'too-short' | 'search'

/** Empty input is a bounded, cursor-paged browse. One character is deliberately
 * held back to avoid a huge low-selectivity search; two or more use the index. */
export function modelCacheSearchMode(normalizedQuery: string): ModelCacheSearchMode {
  if (normalizedQuery.length === 0) return 'browse'
  if (normalizedQuery.length === 1) return 'too-short'
  return 'search'
}
