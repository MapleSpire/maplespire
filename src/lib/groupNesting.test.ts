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

// QA lens 2026-10-25: negative cases for the nesting relation and the drag carry.
import { describe, expect, it } from 'vitest'
import { autoSizedInnerGroupIds, storedGroupsCarriedBy } from './groupNesting'
import { deriveGroupBoxes, nestGroups } from './layout/graph'
import type { Diagram, Group } from '../types'

const group = (id: string, objectIds: string[], extra: Partial<Group> = {}): Group =>
  ({ id, name: id, color: '#fff', objectIds, ...extra }) as Group
const stored = (id: string, objectIds: string[]) =>
  group(id, objectIds, { autoSize: false, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } })
const onDiagram = (ids: string[]) => { const s = new Set(ids); return (id: string) => s.has(id) }

describe('autoSizedInnerGroupIds — what is NOT nested', () => {
  it('a group sharing only some members, or none, is not inner', () => {
    const outer = group('outer', ['a', 'b'])
    const groups = [outer, group('overlap', ['b', 'c']), group('disjoint', ['c']), group('sub', ['a'])]
    expect(autoSizedInnerGroupIds(outer, groups, onDiagram(['a', 'b', 'c']))).toEqual(['sub'])
  })

  it('a group with no member on the diagram is not inner, even a stored one', () => {
    const outer = group('outer', ['a', 'b'])
    const groups = [outer, stored('empty', []), stored('offscreen', ['z'])]
    expect(autoSizedInnerGroupIds(outer, groups, onDiagram(['a', 'b']))).toEqual([])
  })
})

describe('storedGroupsCarriedBy — only stored boxes nested in the dragged group', () => {
  const dragged = group('dragged', ['a', 'b'])
  const isOn = onDiagram(['a', 'b', 'c'])

  it('does not carry a stored box with no member on the diagram', () => {
    expect(storedGroupsCarriedBy(dragged, [dragged, stored('empty', []), stored('offscreen', ['z'])], isOn)).toEqual([])
  })

  it('does not carry a stored box that only overlaps the dragged group', () => {
    expect(storedGroupsCarriedBy(dragged, [dragged, stored('overlap', ['b', 'c'])], isOn)).toEqual([])
  })

  it('reads membership on the diagram: off-diagram members do not stop the carry', () => {
    expect(storedGroupsCarriedBy(dragged, [dragged, stored('inner', ['a', 'z'])], isOn)).toEqual(['inner'])
  })
})

describe('deriveGroupBoxes — nesting read from ON-DIAGRAM members, as the canvas does', () => {
  it('two auto-sized groups whose on-diagram members are equal nest by id, whatever off-diagram members they hold', () => {
    const objectBoxes = new Map([
      ['a', { x: 0, y: 200, width: 100, height: 60 }],
      ['b', { x: 0, y: 300, width: 100, height: 60 }],
    ])
    const groups = [group('g1', ['a', 'b', 'x']), group('g2', ['a', 'b', 'y'])]
    const d = { id: 'v', name: 'v', type: 'container', objectIds: ['a', 'b'], connectionIds: [], groupIds: ['g1', 'g2'], layouts: {} } as unknown as Diagram
    // The canvas: g2 is drawn inside g1 (equal on-diagram sets, smaller id outside).
    expect(autoSizedInnerGroupIds(groups[0], groups, onDiagram(['a', 'b']))).toEqual(['g2'])
    const boxes = deriveGroupBoxes(nestGroups(d, groups, new Set(['a', 'b'])), groups, objectBoxes)
    expect(boxes.get('g1')!.y).toBeLessThan(boxes.get('g2')!.y)
  })
})
