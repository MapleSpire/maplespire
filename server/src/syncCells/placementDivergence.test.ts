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

import { describe, expect, it } from 'vitest'
import { placementDivergence } from './placementDivergence.js'
import { workspacePartition } from './assignment.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

/**
 * The divergence gate between the stored `workspace_placement` mapping and the
 * hash. Shadow mode rests entirely on a counter that says the two agree, so
 * this file makes that counter report non-zero before anybody trusts a zero
 * from it.
 */
const keys = (count: number): WorkspaceKey[] =>
  Array.from({ length: count }, (_, index) => ({
    landscapeId: `landscape-${index}`,
    versionId: `version-${index % 5}`,
  }))

describe('placement divergence gate (T-10a)', () => {
  it('counts a divergent placement at partitionCount=2', () => {
    // 24 keys, and the injected mapping agrees with the hash on 23 of them. The
    // one it disagrees about is chosen by INDEX rather than by value, so the
    // fixture does not depend on which bucket the hash happens to pick.
    const workspaces = keys(24)
    const odd = workspaces[7]!
    const injected = (workspace: WorkspaceKey): number => {
      const truth = workspacePartition(workspace, 2)
      // The disagreement is a FLIP, not a constant: returning a fixed number
      // would agree with the hash by accident on roughly half the keys and the
      // count would be a property of the fixture rather than of the mapping.
      if (workspace.landscapeId === odd.landscapeId && workspace.versionId === odd.versionId) {
        return truth === 0 ? 1 : 0
      }
      return truth
    }

    expect(placementDivergence(workspaces, 2, injected)).toBe(1)
  })

  it('MUTANT: a mapping that IS the hash cannot diverge, so the case above would pass over nothing', () => {
    // Replace the injected mapping with `workspacePartition`
    // itself — the shape a shadow implementation collapses into if it ever
    // "falls back to the hash" — and the divergence is necessarily zero,
    // however many keys are compared. A gate that stays green here is not a
    // gate; it is a comparison of a function with itself.
    const workspaces = keys(24)
    expect(placementDivergence(workspaces, 2, (workspace) => workspacePartition(workspace, 2))).toBe(0)

    // And the same 24 keys DO produce a non-zero under a mapping that is not
    // the hash — so the zero above is a property of the mapping, not of the
    // fixture being too small or too uniform to disagree.
    expect(placementDivergence(workspaces, 2, (workspace) => 1 - workspacePartition(workspace, 2)))
      .toBe(24)

    // A missing row counts as divergence rather than being skipped: an EMPTY
    // table must not report perfect agreement.
    expect(placementDivergence(workspaces, 2, () => null)).toBe(24)
  })

  it('reports VOID, not zero, at partitionCount=1', () => {
    const workspaces = keys(24)
    const result = placementDivergence(workspaces, 1, () => 1)

    // THE LITERAL STRING, and NOT the number. A mapping returning 1 disagrees
    // with the hash on every key, and the answer is still `'void'` — because at
    // one partition there is nothing to disagree about.
    expect(result).toBe('void')
    expect(result).not.toBe(0)
    expect(typeof result).toBe('string')

    // WHY, re-asserted here rather than cited: `workspacePartition` returns 0
    // for every key at one partition, so a divergence count of 0 would mean
    // "nothing to compare" and would be read as "they agree". A thousand
    // generated keys, so the claim is a measurement over the real function
    // rather than a reading of its loop.
    for (let index = 0; index < 1_000; index += 1) {
      expect(workspacePartition({ landscapeId: `l-${index}`, versionId: `v-${index % 7}` }, 1)).toBe(0)
    }
  })
})
