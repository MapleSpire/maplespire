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
import type { C4Object, Diagram } from '../types'
import { collectRelatedDiagramObjectIds } from './relatedDiagramAffordances'

const object = (id: string, parentId?: string) => ({ id, parentId } as C4Object)
const diagram = (id: string, objectIds: string[], parentObjectId?: string) => ({
  id,
  objectIds,
  parentObjectId,
} as Diagram)

describe('collectRelatedDiagramObjectIds', () => {
  it('marks detail, reference and parent associations while excluding the current diagram', () => {
    const objects = [
      object('detail'),
      object('reference'),
      object('parent-child', 'parent'),
      object('current-only'),
      object('unrelated'),
    ]
    const diagrams = [
      diagram('current', ['detail', 'reference', 'parent-child', 'current-only', 'unrelated']),
      diagram('detail-diagram', [], 'detail'),
      diagram('reference-diagram', ['reference']),
      diagram('parent-diagram', [], 'parent'),
    ]
    const memberships = new Map<string, Set<string>>([
      ['detail', new Set(['current'])],
      ['reference', new Set(['current', 'reference-diagram'])],
      ['parent-child', new Set(['current'])],
      ['current-only', new Set(['current'])],
      ['unrelated', new Set(['current'])],
    ])

    expect([...collectRelatedDiagramObjectIds(objects, diagrams, 'current', memberships)].sort()).toEqual([
      'detail',
      'parent-child',
      'reference',
    ])
  })
})
