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

import { isWorkspaceSummaryActive } from './summaryTier'

/**
 * Premium server-read-model tier flag. When on, global
 * cross-diagram reads are served by the server's Postgres read model
 * (`serverModelQuery`) instead of the resident store / IndexedDB index — so the
 * client never materializes the full model. OFF by default (free tier). Enabled by
 * build-time `VITE_SERVER_READ_MODEL=true` or a runtime localStorage toggle.
 *
 * Orthogonal to the paging + sharding flags: the IndexedDB index stays the offline
 * cache (and answers relatedDiagrams), while the server answers the heavy queries.
 *
 * The server's `ro_*` tables are keyed by (org, landscape, version) and every
 * request carries the active workspace (`workspaceParams.ts`), so any workspace
 * can use the server tier.
 *
 * The tier is also entered PER WORKSPACE, without any flag, when the active
 * workspace's root declares `registrySummaryOnly` (`summaryTier.ts`). There the
 * server read model is not a premium option but the only place the baseline
 * exists, so the contract outranks the flags — see summaryTier.ts for why the
 * two halves of that switch share this single predicate.
 */
const LS_KEY = 'maplespire:serverReadModel'

export function isServerReadModelEnabled(): boolean {
  if (isWorkspaceSummaryActive()) return true
  if (import.meta.env.VITE_SERVER_READ_MODEL === 'true') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === 'true'
  } catch {
    return false
  }
}

export function setServerReadModel(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, String(on))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}
