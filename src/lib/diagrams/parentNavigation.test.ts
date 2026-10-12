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
import { resolveParentNavigation, type ParentNavigationInput } from './parentNavigation'
import type { Diagram } from '../../types'

const diagram = (over: Partial<Diagram> & { id: string }): Diagram => ({
  name: over.id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})

/** The resolver takes the shared `diagramById` index; the fixtures stay written
 *  as a plain list, which reads better and keeps the tests honest about what a
 *  landscape contains. */
type Over = Partial<Omit<ParentNavigationInput, 'diagramById'>> & { diagrams?: Diagram[] }

const input = (over: Over = {}): ParentNavigationInput => {
  const { diagrams = [diagram({ id: 'ctx', name: 'Landscape', type: 'context' })], ...rest } = over
  return {
    currentDiagram: diagram({ id: 'detail', name: 'Shop containers', parentObjectId: 'shop' }),
    objectToDiagramIds: new Map([['shop', new Set(['ctx'])]]),
    previousDiagramId: null,
    ...rest,
    diagramById: new Map(diagrams.map((d) => [d.id, d])),
  }
}

describe('resolveParentNavigation', () => {
  it('finds the way up from the MODEL, with no session history at all', () => {
    // The regression this exists for: `previousDiagramId` is null after any
    // reload and after a deep link, and the back chevron was gated on it — so
    // arriving at a detail diagram any way but drilling in left no way out.
    const target = resolveParentNavigation(input())
    expect(target).toMatchObject({ objectId: 'shop', diagramId: 'ctx', diagramName: 'Landscape' })
  })

  it('returns nothing for a diagram that details nothing', () => {
    expect(resolveParentNavigation(input({
      currentDiagram: diagram({ id: 'top', name: 'Landscape', type: 'context' }),
    }))).toBeNull()
  })

  it('returns nothing when there is no current diagram', () => {
    expect(resolveParentNavigation(input({ currentDiagram: null }))).toBeNull()
  })

  it('prefers the diagram the user actually came from', () => {
    const target = resolveParentNavigation(input({
      diagrams: [
        diagram({ id: 'ctx', name: 'Landscape', type: 'context' }),
        diagram({ id: 'other', name: 'Ops view', type: 'container' }),
      ],
      objectToDiagramIds: new Map([['shop', new Set(['ctx', 'other'])]]),
      previousDiagramId: 'other',
    }))
    // 'ctx' would win on rank; history overrides because that is the diagram
    // the user has actually seen.
    expect(target).toMatchObject({ diagramId: 'other' })
  })

  it('ignores history that the model does not corroborate', () => {
    // Stale history: the user came from a diagram that does not show the parent
    // (or that has since been deleted). Going "up" there would be a lie.
    const target = resolveParentNavigation(input({ previousDiagramId: 'deleted' }))
    expect(target).toMatchObject({ diagramId: 'ctx' })
  })

  it('goes up to the broadest view when several show the parent', () => {
    const target = resolveParentNavigation(input({
      diagrams: [
        diagram({ id: 'comp', name: 'A', type: 'component' }),
        diagram({ id: 'ctx', name: 'Z', type: 'context' }),
        diagram({ id: 'cont', name: 'M', type: 'container' }),
      ],
      objectToDiagramIds: new Map([['shop', new Set(['comp', 'ctx', 'cont'])]]),
    }))
    expect(target?.diagramId).toBe('ctx')
  })

  it('prefers a diagram that is not itself a drill-down, whatever its C4 level', () => {
    const target = resolveParentNavigation(input({
      diagrams: [
        diagram({ id: 'nestedCtx', name: 'A', type: 'context', parentObjectId: 'other' }),
        diagram({ id: 'plainComp', name: 'Z', type: 'component' }),
      ],
      objectToDiagramIds: new Map([['shop', new Set(['nestedCtx', 'plainComp'])]]),
    }))
    expect(target?.diagramId).toBe('plainComp')
  })

  it('picks the same diagram on every call when candidates tie', () => {
    const tied = input({
      diagrams: [diagram({ id: 'b', name: 'Same' }), diagram({ id: 'a', name: 'Same' })],
      objectToDiagramIds: new Map([['shop', new Set(['b', 'a'])]]),
    })
    // An affordance that points somewhere different each render is worse than none.
    expect(resolveParentNavigation(tied)?.diagramId).toBe('a')
    expect(resolveParentNavigation(tied)?.diagramId).toBe('a')
  })

  it('never offers the current diagram as its own parent', () => {
    // The current diagram must be IN `diagrams` for this to test the guard
    // rather than an incidental lookup miss.
    const current = diagram({ id: 'detail', name: 'Shop containers', parentObjectId: 'shop' })
    const target = resolveParentNavigation(input({
      currentDiagram: current,
      diagrams: [current],
      objectToDiagramIds: new Map([['shop', new Set(['detail'])]]),
    }))
    // No destination, no affordance: a glyph that goes nowhere is worse than none.
    expect(target).toBeNull()
  })

  it('does not treat the current diagram as history either', () => {
    const current = diagram({ id: 'detail', name: 'Shop containers', parentObjectId: 'shop' })
    const target = resolveParentNavigation(input({
      currentDiagram: current,
      diagrams: [current],
      objectToDiagramIds: new Map([['shop', new Set(['detail'])]]),
      previousDiagramId: 'detail',
    }))
    expect(target).toBeNull()
  })

})
