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

import type { DocHandle, DocumentId, Repo } from '@automerge/automerge-repo'

/**
 * The handle THE SYNC LAYER holds for `documentId`, or undefined. O(1).
 *
 * The browser's half of the seam that `server/src/automergeRepoCompat.ts`
 * carries for the server. It exists twice on purpose and not by oversight: the
 * two are separate programs with separate module graphs, and the alternatives
 * were to exempt this file from the lint rule — which would make the rule stop
 * meaning "you bypassed the seam" on the side where it matters most — or to
 * leave the browser unguarded.
 *
 * Read this instead of `repo.handles[documentId]`. `Repo.get handles()`
 * is not a map: it allocates a fresh `Record` and copies every entry out of
 * the private `#queries` on each access (~0.2 ms at 1 000 resident documents,
 * ~3.4 ms at 10 000, on 2.6.0-alpha.2) — and it is read on the document-RETRY
 * path, exactly when the tab is already behind.
 *
 * `#docSynchronizers` is a SUBSET of `#queries`, equal in every reachable
 * state: `#ensureQuery` attaches every source synchronously as it registers the
 * query, and `removeFromCache` and `delete` drop both together. Verified across
 * create, import, findWithProgress mid-load, find, removeFromCache and re-find.
 * The single divergence is `CollectionSynchronizer.detach()`, which the browser
 * bundle never calls — `handleRetry.ts` evicts through `removeFromCache`.
 *
 * The server side carries the full argument, the counter-example, and the
 * regression gate that re-establishes the invariant on every dependency bump
 * (`server/src/automergeRepoCompat.seam.test.ts`). One copy of that reasoning
 * is enough; this is the pointer to it.
 *
 * No `as unknown as`: every hop is declared upstream, so `tsc` breaks the build
 * if automerge-repo renames one. A cast would turn that into a permanent silent
 * `undefined`.
 */
export function syncedHandle(repo: Repo, documentId: string): DocHandle<unknown> | undefined {
  return repo.synchronizer.docSynchronizers[documentId as DocumentId]?.query?.handle
}
