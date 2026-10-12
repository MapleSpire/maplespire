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
import { planRegistryWrites } from './registryWritePlan'

describe('planRegistryWrites', () => {
  it('does not mutate registry membership from a summary-only store window', () => {
    const plan = planRegistryWrites({
      registrySummaryOnly: true,
      // Only the active diagram is resident. It is not evidence that the
      // remaining 29,999 diagrams were deleted, nor that it needs a new shard.
      storeDiagramIds: ['active-diagram'],
      shards: [],
    })

    expect(plan).toEqual({ reconcile: [], placeIds: [] })
  })

  it('does not delete unloaded diagrams when a summary-only shard is partial', () => {
    const plan = planRegistryWrites({
      registrySummaryOnly: true,
      storeDiagramIds: ['active-diagram'],
      shards: [{ diagramIds: ['active-diagram', 'off-window-diagram'] }],
    })

    expect(plan).toEqual({ reconcile: [], placeIds: [] })
  })

  it('reconciles and places diagrams for a fully resident registry', () => {
    const plan = planRegistryWrites({
      registrySummaryOnly: false,
      storeDiagramIds: ['kept', 'new'],
      shards: [{ diagramIds: ['kept', 'deleted'] }],
    })

    expect(plan).toEqual({
      reconcile: [{ shardIndex: 0, removeIds: ['deleted'], updateIds: ['kept'] }],
      placeIds: ['new'],
    })
  })
})
