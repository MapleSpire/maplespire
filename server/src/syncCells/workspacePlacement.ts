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

import type { WorkspaceKey } from '../rbac/docScope.js'
import type { Queryable } from '../readModel/types.js'
import { workspacePartition } from './assignment.js'
import type { TopologyContract } from './topologyContract.js'

export const WORKSPACE_PLACEMENT_CHANNEL = 'workspace_placement_changed'

export function placementWorkspaceKey(workspace: WorkspaceKey): string {
  return JSON.stringify([workspace.landscapeId, workspace.versionId])
}

/** One generation-scoped read, shared by the cell's shadow comparison and the
 * router. A failed or malformed read is not evidence for an empty mapping.
 * Publication belongs to the caller's reconciliation, after its stop check. */
export async function readWorkspacePlacement(
  db: Queryable,
  generation: string,
  partitionCount: number,
): Promise<ReadonlyMap<string, number>> {
  const { rows } = await db.query<{
    landscape_id: string; version_id: string; partition: number | string
  }>(`SELECT landscape_id, version_id, partition
           FROM workspace_placement
          WHERE topology_generation = $1`, [generation])
  const result = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.landscape_id !== 'string' || !row.landscape_id
      || typeof row.version_id !== 'string' || !row.version_id
      || !['number', 'string'].includes(typeof row.partition)
      || (typeof row.partition === 'string' && !/^(0|[1-9][0-9]*)$/.test(row.partition))) {
      throw new Error('Malformed workspace placement row')
    }
    const partition = Number(row.partition)
    if (!Number.isSafeInteger(partition) || partition < 0 || partition >= partitionCount) {
      throw new Error(`Workspace placement outside partition count ${partitionCount}`)
    }
    const key = placementWorkspaceKey({ landscapeId: row.landscape_id, versionId: row.version_id })
    if (result.has(key)) throw new Error('Duplicate workspace placement row')
    result.set(key, partition)
  }
  return result
}

/** Reads are synchronous and have no connection to a database. Before a
 * placed snapshot has loaded, absence is unknown and must not fall back to the
 * hash.
 * Shadow remains hash-only, including when its diagnostic SELECT has failed. */
export class StoredPlacementResolver {
  private snapshot: ReadonlyMap<string, number> | null = null

  constructor(private readonly mode: TopologyContract['placementMode'] = 'shadow') {}

  get loaded(): boolean { return this.snapshot !== null }

  publish(snapshot: ReadonlyMap<string, number>): void {
    this.snapshot = new Map(snapshot)
  }

  partitionOf(workspace: WorkspaceKey, partitionCount: number): number {
    if (this.mode === 'placed') {
      if (!this.snapshot) throw new Error('Workspace placement has not loaded')
      const placed = this.snapshot.get(placementWorkspaceKey(workspace))
      if (placed !== undefined) return placed
    }
    return workspacePartition(workspace, partitionCount)
  }
}
