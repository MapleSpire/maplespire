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

import type { DocHandle } from '@automerge/automerge-repo'
import { createClaimedDocument } from './docScope.js'
import type { SealedRepo } from './sealedRepo.js'
import { WriteAuthorityLostError, type WriteAuthority } from '../syncCells/writeAuthority.js'

/**
 * Creating a document under a write authority.
 *
 * `WriteAuthority` answers "may this process write this workspace, and under
 * which fencing token"; the sealed repo guarantees no document is minted
 * unclaimed. This module combines both so they cannot be used apart.
 *
 * Over calling `createClaimedDocument` directly it adds two things:
 *
 *  1. The authority is re-asked at the mint. `WriteAuthority` is a reading of a
 *     moment, not a lock; a handler that took one and awaited before creating
 *     may be writing under a lease that has moved. `stillHeld()` immediately
 *     before `repo.create` mirrors `runWorkspaceCompaction`'s `stillSafeToWrite`.
 *  2. The workspace comes from the authority, not from a second argument, so a
 *     caller cannot write across a tenant boundary by passing a workspace other
 *     than the one it was authorised for.
 *
 * It does not route: a refused authority is an error here, not a proxy hop.
 * Routing belongs to the routing layer alone.
 */

export interface WorkspaceWriterDeps {
  repo: SealedRepo
  authority: WriteAuthority
  rootUrl: string
}

/** Thrown when the authority moved between its grant and the mint. Defined in
 *  `syncCells/writeAuthority.ts` (a leaf the HTTP error mapping can import)
 *  and re-exported here for existing callers. */
export { WriteAuthorityLostError }

/**
 * Mint a document into the workspace this authority speaks for, durable and
 * claimed before it returns.
 *
 * The ordering `createClaimedDocument` guarantees — minted → placement noted →
 * durable → claimed → only then may the caller publish a link — is what makes
 * the returned handle safe to point at. `workspaceWriter.ordering.seam.test.ts`
 * drives that through a REAL `Repo` rather than asserting it here.
 */
export async function createDocumentForWorkspace<T>(
  deps: WorkspaceWriterDeps,
  value: T,
): Promise<DocHandle<T>> {
  // RE-ASKED HERE, not trusted from the grant. Everything between the two is an
  // await the caller made, and ownership does not pause for it.
  if (!deps.authority.stillHeld()) throw new WriteAuthorityLostError(deps.authority.workspace)
  return createClaimedDocument<T>(deps.repo, deps.authority.workspace, deps.rootUrl, value)
}
