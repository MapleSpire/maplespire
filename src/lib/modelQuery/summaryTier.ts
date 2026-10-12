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
 * The per-workspace SUMMARY contract, published by the Automerge bridge at boot
 * (`registrySummaryOnly` on the workspace root document) and cleared by
 * `stopBridge`.
 *
 * Why it exists. A summary workspace keeps its baseline in the server read model
 * (`ro_*`): the client resolves only the registry write head, and the resident
 * store holds the ACTIVE diagram's window — nothing else. A client that boots
 * such a workspace on the resident read path would show the window and call it
 * the model (e.g. Model Connections rendering 4 rows out of 25, or a sparse draft
 * opened without the Vite flags showing only the touched entities).
 *
 * So the contract, not the build flag, decides. `isServerReadModelEnabled()`
 * (tierFlag.ts) consults this, which is what makes the two halves of the switch
 * inseparable: `getModelQuery()` reads the SAME predicate to pick
 * `pagedModelQuery`, and `pagedModelQuery` reads it again to put
 * `serverModelQuery` in front of its local rungs. There is one switch, so
 * bootFromServer WITHOUT serverReadModel (which silently truncates global
 * views) cannot happen by flipping half of it: the halves have no separate
 * state to disagree about.
 *
 * This is a BOOT CONTRACT, read once per session and never re-evaluated live:
 * every piece of bridge state (shard handles, baselines, captures, journals) is
 * built on it, so a promotion arriving mid-session is a reload, never a hot
 * re-switch (bridge.ts's epoch guard).
 *
 * Deliberately import-free — the bridge writes it and the read-model tier reads
 * it, and neither may pull the other into an import cycle. Same reason
 * `flag.ts`/`tierFlag.ts` are their own modules.
 */
let workspaceSummaryActive = false

/** True when the ACTIVE workspace's root declares `registrySummaryOnly`. */
export function isWorkspaceSummaryActive(): boolean {
  return workspaceSummaryActive
}

/** Bridge-only: publish (boot) / clear (stopBridge) the active workspace's
 * summary contract. Never called from a view. */
export function setWorkspaceSummaryActive(active: boolean): void {
  workspaceSummaryActive = active
}
