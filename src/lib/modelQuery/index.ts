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

import type { ModelQuery } from './types'
import { residentModelQuery } from './resident'
import { pagedModelQuery } from './paged'
import { isModelPagingEnabled, setModelPaging, isBootFromServerEnabled, setBootFromServer } from './flag'
import { isServerReadModelEnabled, setServerReadModel } from './tierFlag'
import { isIndexReady } from './offlineIndex'

let override: ModelQuery | null = null

/**
 * The active global-read model query. Selection order (independent of which
 * workspace is active — the local paging index is namespaced per workspace and the
 * server's ro_* tables are keyed per workspace):
 *  - the COMPLETE local index for the ACTIVE workspace, once its background build
 *    has finished → paged (the offline/resilient destination: whole model, no
 *    server needed);
 *  - else premium server read model (tier flag) → server-backed (zero-wait while the
 *    index builds);
 *  - else IndexedDB index (paging flag) → paged;
 *  - else the resident store (default, zero behavior change).
 *
 * The SUMMARY contract enters here through `isServerReadModelEnabled()`, on
 * purpose. A workspace whose root says `registrySummaryOnly` keeps its baseline
 * in the server read model, so the resident store answers with the active
 * diagram's window and nothing else; that middle rung is the ONLY correct
 * answer for it, flags or no flags. Routing the contract through the same
 * predicate `pagedModelQuery` consults for `serverModelQuery` makes truncation
 * (bootFromServer without serverReadModel) impossible by construction: picking
 * `paged` here and putting the server in front of its rungs are one decision
 * with one state, not two that can drift apart (`summaryTier.ts`).
 */
export function getModelQuery(): ModelQuery {
  if (override) return override
  if (isIndexReady() || isServerReadModelEnabled() || isModelPagingEnabled()) return pagedModelQuery
  return residentModelQuery
}

/** Test-only: swap the active implementation (pass null to reset to the flag default). */
export function __setModelQueryForTest(q: ModelQuery | null): void {
  override = q
}

// DEV console helpers to flip backends without restarting the dev server:
//   __modelPaging.on()/off()/enabled()         — IndexedDB index
//   __serverReadModel.on()/off()/enabled()     — premium server read model
//
// `__serverReadModel.off()` is a LOCALSTORAGE toggle, not a kill switch (T5).
// On a workspace whose root declares `registrySummaryOnly` the contract
// outranks it — `isServerReadModelEnabled()` consults `summaryTier` FIRST — so
// `off()` reloads the page and `enabled()` still reports true. That is
// deliberate: there is no resident baseline to turn off to there, and a
// half-disabled switch silently truncates the global views. Leave the contract by
// opening a workspace that does not declare it.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  w.__modelPaging = {
    on: () => setModelPaging(true),
    off: () => setModelPaging(false),
    enabled: isModelPagingEnabled,
  }
  w.__serverReadModel = {
    on: () => setServerReadModel(true),
    off: () => setServerReadModel(false),
    enabled: isServerReadModelEnabled,
  }
  w.__bootFromServer = {
    on: () => setBootFromServer(true),
    off: () => setBootFromServer(false),
    enabled: isBootFromServerEnabled,
  }
}

export type { ModelQuery, PeerEdge } from './types'
export { residentModelQuery } from './resident'
export { pagedModelQuery } from './paged'
export { serverModelQuery } from './server'
export { isModelPagingEnabled, setModelPaging, isBootFromServerEnabled, setBootFromServer } from './flag'
export { isServerReadModelEnabled, setServerReadModel } from './tierFlag'
// READ half only. `setWorkspaceSummaryActive` is the bridge's to
// call and the bridge imports it straight from `./summaryTier`; re-exporting the
// setter here would advertise a writer to every view that pulls the barrel, and
// the contract has exactly one writer by design.
export { isWorkspaceSummaryActive } from './summaryTier'
