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
 * The single enumeration of workspaces that maintenance (fsck, GC, docScope
 * sweeps) may walk.
 *
 * Ownership and maintenance walk DIFFERENT SETS, and the difference is the
 * filter: ownership enumerates `WHERE status = 'active'` (`ownership.ts`),
 * maintenance takes every row of `versions`. A `merged` draft is therefore
 * swept by maintenance yet owned by no cell.
 *
 * That is deliberate: narrowing maintenance to `active` would stop fsck and GC
 * from ever visiting a merged draft, which is a durability decision. The two
 * sets are compared at boot by `workspaceSetParity.ts`, where any difference
 * has to be justified.
 */

export interface MaintainableWorkspace {
  landscapeId: string
  versionId: string
  rootUrl: string
}

interface EnumerableDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

/**
 * ORDERED by `(landscape_id, id)` so every report has the same row order
 * regardless of caller (`fsckSharedRoots` groups by root and reads differently
 * otherwise), and two runs of the same sweep are diffable.
 */
const MAINTAINABLE_WORKSPACES_SQL =
  'SELECT landscape_id, id, root_url FROM versions ORDER BY landscape_id, id'

export async function enumerateMaintainableWorkspaces(
  db: EnumerableDb,
): Promise<MaintainableWorkspace[]> {
  const { rows } = await db.query<{ landscape_id: string; id: string; root_url: string }>(
    MAINTAINABLE_WORKSPACES_SQL,
  )
  return rows.map((row) => ({
    landscapeId: row.landscape_id,
    versionId: row.id,
    rootUrl: row.root_url,
  }))
}

/**
 * The SQL, exported for the gate that proves this is the only enumeration.
 *
 * `maintainableWorkspaces.test.ts` scans the server sources for any other
 * whole-table read of `versions` and fails on one, since TypeScript cannot
 * express "nobody else may write this query".
 */
export const MAINTAINABLE_WORKSPACES_QUERY = MAINTAINABLE_WORKSPACES_SQL
