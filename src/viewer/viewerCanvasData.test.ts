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

import { describe, expect, it, vi } from 'vitest'
import type { CanvasEngine } from '../canvas/engine/CanvasEngine'
import type { ShareDiagram, ShareSnapshot } from '../lib/share/types'
import { feedViewerEngine } from './viewerCanvasData'

const diagram: ShareDiagram = {
  id: 'diagram-1',
  name: 'Shared diagram',
  type: 'context',
  objectIds: ['object-1'],
  connectionIds: [],
  groupIds: [],
  layouts: {},
}

const snapshot: ShareSnapshot = {
  version: 2,
  generatedAt: '2026-07-30T00:00:00.000Z',
  rootDiagramId: diagram.id,
  limitToDiagram: true,
  diagrams: [diagram],
  model: {
    objects: [{
      id: 'object-1',
      name: 'Payments',
      type: 'system',
      position: { x: 0, y: 0 },
      size: { width: 180, height: 96 },
      tagAssignments: {},
      tagOrder: [],
      scope: 'internal',
      status: 'live',
      properties: {},
    }],
    connections: [],
    groups: [],
    tags: [],
  },
  flowsByDiagram: { [diagram.id]: [] },
}

describe('feedViewerEngine', () => {
  it('forces the shared canvas into readonly presentation mode without a grid', () => {
    const renderer = {
      setData: vi.fn(),
      setReadonly: vi.fn(),
      setShowGrid: vi.fn(),
      setConnectionAnimationsEnabled: vi.fn(),
      setConnectionHighlightStyle: vi.fn(),
    } as unknown as CanvasEngine

    feedViewerEngine(renderer, diagram, snapshot)

    expect(renderer.setReadonly).toHaveBeenCalledWith(true)
    expect(renderer.setShowGrid).toHaveBeenCalledWith(false)
    expect(renderer.setData).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'object-1' })]),
      [],
      [],
      [],
      [],
    )
  })
})
