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

import { workspacePartition } from './assignment.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

/**
 * THE DIVERGENCE GATE between the stored `workspace_placement` mapping and the
 * hash `workspacePartition` computes.
 *
 * A workspace the table sends to partition 1 and the hash sends to partition 0
 * has two answers about who owns it; the shadow comparison exists to prove they
 * agree before anything switches over. The tests feed it a mapping that
 * disagrees, so "it reports zero" is a measurement rather than the only value
 * it can produce — a comparison of `workspacePartition` with itself can never
 * disagree.
 *
 * ## Why one partition is VOID and not zero
 *
 * `workspacePartition` returns 0 for EVERY key when `partitionCount === 1` — its
 * loop exits with `bucket = 0` before the hash is consulted at all
 * (assignment.ts). So at one partition a stored mapping that disagrees with the
 * hash is indistinguishable from one that agrees: both produce 0, and a
 * divergence count of 0 would mean "nothing to compare", not "they agree".
 *
 * Publishing that 0 is the failure this module is built to avoid: a gate
 * reporting clean over a comparison it could not make. `'void'` is a
 * different value from `0` and cannot be summed, averaged or thresholded by
 * accident.
 */

export type PlacementDivergence = number | 'void'

/**
 * How many workspaces the stored mapping and the hash disagree about.
 *
 * `placementOf` returns the STORED partition, or `null` when the mapping has no
 * row for that workspace. A missing row is counted as a divergence rather than
 * skipped: during the shadow migration "the table does not know about this
 * workspace" is exactly the state that would send it to the wrong cell, and
 * skipping it would let an empty table report perfect agreement.
 */
export function placementDivergence(
  workspaces: readonly WorkspaceKey[],
  partitionCount: number,
  placementOf: (workspace: WorkspaceKey) => number | null,
): PlacementDivergence {
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1) {
    throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`)
  }
  // See the header: at one partition every key hashes to 0, so a comparison
  // here has no discriminating power and its zero would be read as agreement.
  if (partitionCount === 1) return 'void'

  let divergent = 0
  for (const workspace of workspaces) {
    const stored = placementOf(workspace)
    if (stored === null || stored !== workspacePartition(workspace, partitionCount)) divergent += 1
  }
  return divergent
}
