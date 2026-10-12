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

import type { WorkspaceRef } from './automerge/workspace'

/**
 * Decoupled bridge from the stores to the router: a STORE-LED workspace switch
 * (menu switch, new/duplicate version or landscape, open/exit draft) must move the
 * address bar to the new ref, or WorkspaceRoute would see the stale URL and switch
 * the store right back. The stores can't import the router (cycle), so router.tsx
 * registers the navigator here at module load and the stores call it. No-op before
 * registration (tests / SSR).
 */
type Navigator = (ref: WorkspaceRef) => void | Promise<void>

let impl: Navigator | null = null

export function setWorkspaceNavigator(fn: Navigator): void {
  impl = fn
}

/**
 * Navigate to a workspace ref's index URL (`/app/landscape/<lid>/version/<vid>`).
 * RouteSync then re-appends the open view/diagram within that ref.
 *
 * AWAITABLE on purpose. Router navigation lands a tick or more after the call, so a
 * store-led switch that released its `busy` guard first would leave a window in which
 * `WorkspaceRoute`'s effect reads the OLD URL params against the ALREADY-NEW
 * `currentWorkspaceRef()` and "corrects" the store back to the previous workspace —
 * a full stop/start of the old bridge, then another one forward when the URL finally
 * commits. Callers must await this BEFORE clearing `busy`.
 */
export async function navigateToWorkspaceRef(ref: WorkspaceRef): Promise<void> {
  await impl?.(ref)
}
