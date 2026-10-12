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

import type { ModelCacheWorkspaceMeta } from './idbSchema'

type CachePolicyMeta = Pick<
  ModelCacheWorkspaceMeta,
  'coverage' | 'pinned' | 'serverGeneration'
>

/**
 * Bounded online pages must never replace an explicitly pinned, complete
 * generation with a partial generation. The durable change feed owns updates
 * to a complete copy; ordinary explorer pages remain display-only in that case.
 */
export function shouldCacheBoundedServerPage(meta: CachePolicyMeta | undefined): boolean {
  return !(meta?.pinned && meta.coverage === 'full')
}

export function pinnedCacheNeedsRefresh(
  meta: CachePolicyMeta | undefined,
  pageGeneration: number,
): boolean {
  return Boolean(
    meta?.pinned
    && meta.coverage === 'full'
    && Number.isFinite(pageGeneration)
    && pageGeneration > meta.serverGeneration,
  )
}
