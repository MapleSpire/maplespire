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

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { C4Object, Connection, Diagram } from '../../types'
import type { ExportBundle } from './types'
import { sceneFromBundle } from './image'

const obj = (id: string): C4Object => ({
  id, type: 'system', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})

describe('sceneFromBundle — what the image exporters (PNG/SVG/PDF) draw', () => {
  it('routes a derived (lower) connection as its diagram does — from `lowerRouting`, not the shared object', () => {
    const lower: Connection = { id: 'lower:S→P', fromId: 'S', toId: 'P', type: 'dashed', kind: 'lower', label: '' }
    const diagram: Diagram = {
      id: 'd1', name: 'Context', type: 'context', objectIds: ['S', 'P'], connectionIds: ['lower:S→P'], groupIds: [],
      lowerRouting: { 'S→P': { fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 300, y: 10 }] } },
    }
    const bundle: ExportBundle = {
      landscapeName: 'L', generatedAt: '2026-10-22T00:00:00.000Z',
      diagrams: [diagram], activeDiagramId: 'd1', flowsByDiagram: {},
      objects: [obj('S'), obj('P')], connections: [lower], groups: [], domains: [], tags: [], decisionRecords: [],
    }

    const scene = sceneFromBundle(bundle, 'd1')

    expect(scene?.connections).toEqual([
      { ...lower, fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 300, y: 10 }] },
    ])
  })
})
