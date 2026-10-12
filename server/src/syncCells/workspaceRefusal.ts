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

import { OWNABLE_WORKSPACES_SQL } from './ownership.js'

/**
 * WHY A CELL IS NOT SERVING A WORKSPACE — and whether waiting can ever help.
 *
 * Ownership can only ever own a version whose status is `active`
 * (`OWNABLE_WORKSPACES_SQL`), while `canonicalWorkspaceKey` resolves only the
 * moving `current` alias — a CONCRETE version id passes through unexamined. So
 * a request for a retired or merged version reaches the ownership gate and
 * finds that no cell owns it.
 *
 * A `503 retryable` for that would never lift: no cell will ever own that
 * version. A client honouring `retryable` would retry for ever, and the wire
 * shape would be indistinguishable from ordinary contention while a lease
 * moves. A merged draft is exactly such a version.
 *
 * THE SPLIT:
 *   - `owner-moved`   — temporary. Some cell owns this workspace, or will; the
 *                       one you reached does not. 503, retryable, Retry-After.
 *   - `not-servable`  — permanent. This version is not `active`, so no cell can
 *                       ever own it. 410 Gone, NOT retryable, no Retry-After.
 *
 * 410 rather than 404 on purpose: 404 says "no such thing", which is wrong and
 * would make a client discard a workspace it may legitimately still read through
 * another route. 410 says "this existed and is not served any more", which is
 * what a retired version is.
 */

export type WorkspaceRefusal =
  | { kind: 'owner-moved'; status: 503; retryable: true }
  | { kind: 'not-servable'; status: 410; retryable: false; versionStatus: string }

interface RefusalDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

export interface WorkspaceRefusalKey {
  landscapeId: string
  versionId: string
}

/**
 * Classify a refusal by asking whether the version could EVER be owned.
 *
 * ONE QUERY, on the refusal path only. Refusals are rare relative to service, so
 * the cost lands where it is affordable; putting this on the success path to
 * save it would tax every request to speed up the ones that fail.
 *
 * FAIL TOWARD RETRYABLE. If the status cannot be read — the database is
 * unreachable, the row raced away — the answer is `owner-moved`. Calling
 * something permanently gone on the strength of a failed query would tell a
 * client to discard a workspace that may be perfectly alive, and a wrong
 * permanent refusal is unrecoverable in a way a wrong temporary one is not.
 */
export async function classifyWorkspaceRefusal(
  db: RefusalDb,
  key: WorkspaceRefusalKey,
): Promise<WorkspaceRefusal> {
  try {
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM versions WHERE landscape_id = $1 AND id = $2',
      [key.landscapeId, key.versionId],
    )
    const status = rows[0]?.status
    // No row at all is NOT this function's business: `ensureWorkspace` answers
    // 404 for an unknown workspace long before ownership is consulted. Reaching
    // here with no row means it vanished mid-request, which is a race, which is
    // retryable.
    if (status === undefined) return { kind: 'owner-moved', status: 503, retryable: true }
    if (isOwnableStatus(status)) return { kind: 'owner-moved', status: 503, retryable: true }
    return { kind: 'not-servable', status: 410, retryable: false, versionStatus: status }
  } catch {
    return { kind: 'owner-moved', status: 503, retryable: true }
  }
}

/**
 * Whether a version's status is one ownership can own.
 *
 * DERIVED FROM THE OWNERSHIP QUERY, not restated. `OWNABLE_WORKSPACES_SQL` is
 * the single definition of the ownable set; writing `'active'` again
 * here would be a second copy that agrees until the day ownership's filter
 * changes — at which point this classifier would start calling live workspaces
 * permanently gone, which is the worst direction for this particular mistake.
 */
export function isOwnableStatus(status: string): boolean {
  const match = /status\s*=\s*'([^']+)'/.exec(OWNABLE_WORKSPACES_SQL)
  if (!match) {
    // The ownership query no longer filters by a single literal status. Refusing
    // to guess: every status is treated as ownable, so this classifier degrades
    // to "always retryable" rather than inventing a permanent refusal.
    return true
  }
  return status === match[1]
}
