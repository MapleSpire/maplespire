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
import { buildDuplicateDiagram, buildDuplicateFlows, DUPLICATE_DROPPED_FIELDS } from './duplicate'
import type { Diagram, Flow } from '../../types'

/** Every optional field populated, so "what got dropped" is observable. */
const fullSource = (): Diagram => ({
  id: 'dg-src',
  name: 'Containers',
  type: 'container',
  description: 'The banking system, one level down',
  objectIds: ['o1', 'o2'],
  connectionIds: ['c1'],
  groupIds: ['g1'],
  parentObjectId: 'sys1',
  sourceViewKey: 'BankingContainers',
  domainId: 'dom1',
  connectionHighlightStyle: 'lightning',
  connectionAnimationsEnabled: true,
  defaultConnectionShape: 'straight',
  readonly: true,
  skinId: 'studio',
  layouts: {
    o1: { position: { x: 10, y: 20 }, size: { width: 200, height: 120 } },
    g1: { position: { x: 0, y: 0 }, size: { width: 600, height: 400 } },
  },
  layouts3d: {
    o1: { position: { x: 1, y: 2 }, size: { width: 20, height: 12 } },
  },
})

describe('buildDuplicateDiagram', () => {
  it('references the SAME model entities instead of cloning them', () => {
    const source = fullSource()
    const copy = buildDuplicateDiagram(source, 'Containers (copy)')
    // The whole point: one object, two views.
    expect(copy.objectIds).toEqual(['o1', 'o2'])
    expect(copy.connectionIds).toEqual(['c1'])
    expect(copy.groupIds).toEqual(['g1'])
  })

  it('carries the placement so the copy opens arranged the same way', () => {
    const copy = buildDuplicateDiagram(fullSource(), 'Copy')
    expect(copy.layouts).toEqual(fullSource().layouts)
    expect(copy.layouts3d).toEqual(fullSource().layouts3d)
  })

  it('carries every other view field', () => {
    const copy = buildDuplicateDiagram(fullSource(), 'Copy')
    expect(copy.type).toBe('container')
    expect(copy.description).toBe('The banking system, one level down')
    expect(copy.parentObjectId).toBe('sys1')
    expect(copy.domainId).toBe('dom1')
    expect(copy.connectionHighlightStyle).toBe('lightning')
    expect(copy.connectionAnimationsEnabled).toBe(true)
    expect(copy.defaultConnectionShape).toBe('straight')
    expect(copy.skinId).toBe('studio')
  })

  it('drops the Structurizr view key so an export cannot emit two views under one key', () => {
    // `buildStructurizrDsl` prefers `sourceViewKey` for the view key. Two
    // diagrams carrying 'BankingContainers' would emit two blocks with the same
    // key — a .dsl that does not parse.
    expect(buildDuplicateDiagram(fullSource(), 'Copy').sourceViewKey).toBeUndefined()
  })

  it('drops the per-diagram edit lock — a copy is made to be worked in', () => {
    expect(buildDuplicateDiagram(fullSource(), 'Copy').readonly).toBeUndefined()
  })

  it('drops exactly the documented fields and nothing else', () => {
    const source = fullSource()
    const copy = buildDuplicateDiagram(source, 'Copy') as Record<string, unknown>
    const missing = Object.keys(source).filter((key) => copy[key] === undefined)
    expect(missing.sort()).toEqual([...DUPLICATE_DROPPED_FIELDS].sort())
  })

  it('takes the new name rather than the source name', () => {
    expect(buildDuplicateDiagram(fullSource(), 'Containers (copy)').name).toBe('Containers (copy)')
  })

  it('shares no structure with the source — the source is often a live document proxy', () => {
    const source = fullSource()
    const copy = buildDuplicateDiagram(source, 'Copy')
    copy.objectIds.push('o3')
    copy.layouts!.o1.position.x = 999
    copy.layouts3d!.o1.size.width = 999
    expect(source.objectIds).toEqual(['o1', 'o2'])
    expect(source.layouts!.o1.position.x).toBe(10)
    expect(source.layouts3d!.o1.size.width).toBe(20)
  })

  it('leaves layouts3d absent when the source never forked its 3D placement', () => {
    // Present-but-empty would fork the copy's 3D layer from its 2D one at birth.
    const { layouts3d: _drop, ...noFork } = fullSource()
    expect('layouts3d' in buildDuplicateDiagram(noFork, 'Copy')).toBe(false)
  })
})

describe('buildDuplicateFlows', () => {
  const flows = (): Flow[] => [
    {
      id: 'f1',
      name: 'Sign in',
      diagramId: 'dg-src',
      domainId: 'dom1',
      steps: [
        { id: 's1', order: 0, type: 'introduction', title: 'Start' },
        { id: 's2', order: 1, type: 'message', title: 'Call', fromObjectId: 'o1', toObjectId: 'o2', connectionId: 'c1' },
      ],
    },
  ]

  it('re-points the flows at the copy', () => {
    let n = 0
    const copied = buildDuplicateFlows(flows(), 'dg-copy', () => `n${++n}`)
    expect(copied[0].diagramId).toBe('dg-copy')
    expect(copied[0].name).toBe('Sign in')
  })

  it('gives every flow AND every step a fresh id', () => {
    let n = 0
    const copied = buildDuplicateFlows(flows(), 'dg-copy', () => `n${++n}`)
    // Colliding ids would make the two diagrams' flows indistinguishable in the
    // store's flat `flows` array.
    expect(copied[0].id).not.toBe('f1')
    expect(copied[0].steps.map((s) => s.id)).not.toContain('s1')
    expect(new Set(copied[0].steps.map((s) => s.id)).size).toBe(2)
  })

  it('keeps the step references pointing at the shared model entities', () => {
    const copied = buildDuplicateFlows(flows(), 'dg-copy', () => 'x')
    const step = copied[0].steps[1]
    expect(step).toMatchObject({ fromObjectId: 'o1', toObjectId: 'o2', connectionId: 'c1' })
  })

  it('does not mutate the source flows', () => {
    const source = flows()
    buildDuplicateFlows(source, 'dg-copy', () => 'x')
    expect(source[0].diagramId).toBe('dg-src')
    expect(source[0].steps[0].id).toBe('s1')
  })
})
