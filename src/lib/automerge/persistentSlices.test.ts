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
import { persistentSlicesChanged, type PersistentModelSlices } from './persistentSlices'

function slices(): PersistentModelSlices {
  return {
    objects: [],
    connections: [],
    diagrams: [],
    flows: [],
    tags: [],
    groups: [],
    domains: [],
    comments: [],
    decisionRecords: [],
    currentDiagramId: 'diagram-1',
  }
}

describe('persistentSlicesChanged', () => {
  it('ignores transient state that shares every persistent reference', () => {
    const previous = slices()
    const transientOnly = { ...previous, selectedItems: [{ id: 'A', type: 'object' }] }

    expect(persistentSlicesChanged(transientOnly, previous)).toBe(false)
  })

  it('detects a placement commit from the diagrams reference', () => {
    const previous = slices()
    const placement = { ...previous, diagrams: [...previous.diagrams] }

    expect(persistentSlicesChanged(placement, previous)).toBe(true)
  })

  it('ignores the local-only active diagram id', () => {
    const previous = slices()
    const switched = { ...previous, currentDiagramId: 'diagram-2' }

    expect(persistentSlicesChanged(switched, previous)).toBe(false)
  })
})
