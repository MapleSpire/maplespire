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
import { buildStructurizrDsl } from './structurizr'
import { mapWorkspace } from '../structurizr/mapper'
import { parseWorkspace } from '../structurizr/parser'
import type { ExportBundle } from './types'
import type { C4Object } from '../../types'

const base = (over: Partial<C4Object>): C4Object => ({
  id: over.id ?? 'o1',
  type: over.type ?? 'app',
  name: over.name ?? 'Thing',
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status: 'live',
  properties: {},
  ...over,
})

const bundleOf = (objects: C4Object[]): ExportBundle => ({
  landscapeName: 'Art',
  generatedAt: '2026-08-08T00:00:00.000Z',
  diagrams: [],
  activeDiagramId: null,
  flowsByDiagram: {},
  objects,
  connections: [],
  groups: [],
  domains: [],
  tags: [],
  decisionRecords: [],
})

/**
 * Without styles, a MapleSpire landscape re-opens in Structurizr as uniformly
 * blue rounded boxes: no technology icons, no cylinders for datastores, no
 * person shapes. Every icon the user chose was dropped at export.
 */
describe('exported element styles', () => {
  const withIcon = () => bundleOf([
    base({
      id: 'o1',
      name: 'Web',
      iconAssignment: {
        source: 'technology',
        mode: 'automatic',
        displayName: 'React',
        iconLightPath: '/icons/light/abc123.png',
      },
    }),
  ])

  it('tags the shape with its artwork and gives that tag an icon style', () => {
    const dsl = buildStructurizrDsl(withIcon(), { iconOrigin: 'https://maple.example.com' })
    expect(dsl).toContain('tags "ms-icon-react"')
    expect(dsl).toContain('element "ms-icon-react" {')
    expect(dsl).toContain('icon "https://maple.example.com/icons/light/abc123.png"')
  })

  it('absolutises the same-origin icon path against the deployment origin', () => {
    // A bare `/icons/...` is unfetchable from any other renderer.
    const dsl = buildStructurizrDsl(withIcon(), { iconOrigin: 'https://maple.example.com/' })
    expect(dsl).toContain('"https://maple.example.com/icons/light/abc123.png"')
    expect(dsl).not.toContain('icon "/icons/light/abc123.png"')
  })

  it('leaves an already-absolute icon url alone', () => {
    const dsl = buildStructurizrDsl(
      bundleOf([base({
        iconAssignment: {
          source: 'generic', mode: 'explicit', displayName: 'Cdn',
          iconLightPath: 'https://cdn.example.com/x.png',
        },
      })]),
      { iconOrigin: 'https://maple.example.com' },
    )
    expect(dsl).toContain('icon "https://cdn.example.com/x.png"')
  })

  it('emits the canonical shapes so people and datastores are not boxes', () => {
    const dsl = buildStructurizrDsl(bundleOf([
      base({ id: 'a', type: 'actor', name: 'Customer' }),
      base({ id: 'b', type: 'store', name: 'Ledger' }),
      base({ id: 'c', type: 'component', name: 'Controller' }),
    ]))
    expect(dsl).toContain('element "Person" {')
    expect(dsl).toContain('shape Person')
    expect(dsl).toContain('element "Database" {')
    expect(dsl).toContain('shape Cylinder')
    expect(dsl).toContain('element "Component" {')
  })

  it('omits the styles block entirely when there is nothing to style', () => {
    const dsl = buildStructurizrDsl(bundleOf([base({ type: 'system', name: 'Plain' })]))
    expect(dsl).not.toContain('styles {')
  })

  it('emits one style per distinct artwork, not per shape using it', () => {
    const icon = {
      source: 'technology' as const, mode: 'automatic' as const,
      displayName: 'React', iconLightPath: '/icons/light/abc123.png',
    }
    const dsl = buildStructurizrDsl(
      bundleOf([base({ id: 'a', name: 'One', iconAssignment: icon }), base({ id: 'b', name: 'Two', iconAssignment: icon })]),
      { iconOrigin: 'https://maple.example.com' },
    )
    expect(dsl.match(/element "ms-icon-react"/g)).toHaveLength(1)
  })

  it('does not let the synthetic icon tag leak back in as a user tag', () => {
    // Re-importing our own export must not surface `ms-icon-react` in the tag
    // perspective, and must not make a second export differ from the first.
    const first = buildStructurizrDsl(withIcon(), { iconOrigin: 'https://maple.example.com' })
    const reimported = mapWorkspace(parseWorkspace(first), {
      idFactory: (() => { let n = 0; return () => `r${++n}` })(),
    })
    expect(reimported.tags.map((t) => t.value)).not.toContain('ms-icon-react')
    expect(reimported.objects[0].tagOrder).toHaveLength(0)
  })
})
