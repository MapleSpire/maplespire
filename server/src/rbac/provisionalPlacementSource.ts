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
 * THE SEAM BETWEEN THE ROUTE GATE'S PLACEMENT AND THE STORAGE FENCE.
 *
 * The fence must check a lease for a document whose durable
 * `automerge_document_workspace` row has not landed yet; the only party that
 * knows where such a document belongs is the route gate that just admitted it
 * on the mint. This module is how the second reaches the first.
 *
 * It is a module rather than inline wiring in `startAutomergeSync` (which no
 * test boots) so the mechanism is testable end to end — the same pattern as
 * `installDenyLedgerReleaseGuard`:
 *
 *  - `PostgresStorageAdapter` DEFAULTS to `provisionalPlacementFor`, so there
 *    is no per-construction option to forget. A process that never installs a
 *    source reads null and keeps unfenced admission, which is what non-sync
 *    processes (the gc worker, the backup restore repo) want.
 *  - the install is one call with one argument, and the second describe block
 *    of `automergeStorage.provisionalFence.integration.test.ts` drives a real
 *    `WorkspaceDocIndex` into a real `PostgresStorageAdapter` through it.
 *
 * Known gap: nothing covers the production call site in `automergeServer.ts`;
 * that would need a boot test for `startAutomergeSync`.
 */

import type { WorkspaceKey } from './docScope.js'

type PlacementSource = (documentId: string) => WorkspaceKey | null

let source: PlacementSource | null = null

/**
 * Point the storage fence at `index`'s provisional placements. Returns the
 * uninstaller, so a process that tears its sync server down stops answering —
 * a stale index would otherwise keep naming workspaces for a repo that no
 * longer exists.
 *
 * Passing null clears the source, which is not a refusal: the fence has no
 * owner to check and admits.
 */
export function installProvisionalPlacementSource(
  index: { peekProvisionalPlacement(documentId: string): WorkspaceKey | null } | null,
): () => void {
  source = index ? (documentId) => index.peekProvisionalPlacement(documentId) : null
  return () => { source = null }
}

/**
 * The fence's read. Null means "nobody has named a workspace for this
 * document", which keeps the unconditional admission — the state every
 * server-created document (fork roots, projector documents) is in, since
 * nothing routes them through a gate before their first save.
 *
 * A faulting source must not be able to refuse a write: the fence would then
 * turn an unrelated defect into dropped user bytes, which is strictly worse
 * than the hole it is closing. Same reasoning as `mayReleaseDocument`'s catch.
 */
export function provisionalPlacementFor(documentId: string): WorkspaceKey | null {
  if (!source) return null
  try {
    return source(documentId)
  } catch {
    return null
  }
}
