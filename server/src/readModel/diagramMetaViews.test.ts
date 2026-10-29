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
import { toDiagramEditorMeta, toFirstPaintDiagramMeta } from './diagramMetaViews.js'

describe('diagram meta views', () => {
  const diagram = {
    id: 'd1', name: 'System', type: 'context', docUrl: 'automerge:doc',
    objectIds: ['o1'], connectionIds: ['c1'], groupIds: [], layouts: { o1: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } },
    sceneDecor: { packId: 'maquette-people', density: 'rich', seed: 7 },
    lowerRouting: { 'o1→o2': { fromAnchor: 4, lockedToAnchors: true } },
    comments: { cm1: { text: 'lazy' } }, flows: { f1: { name: 'lazy' } }, checkpoints: [{ id: 'cp1' }],
    description: 'editor', shapeCount: 1,
  }

  it('keeps composition and layouts paint-critical while excluding editor metadata', () => {
    expect(toFirstPaintDiagramMeta(diagram)).toMatchObject({ id: 'd1', docUrl: 'automerge:doc', objectIds: ['o1'], layouts: diagram.layouts })
    // the 3D scene decoration is paint-critical too: a cold boot must dress
    // the board on first render, not after the full doc loads
    expect(toFirstPaintDiagramMeta(diagram)).toMatchObject({ sceneDecor: diagram.sceneDecor })
    // so is the routing of the diagram's derived (lower) connections: it is
    // placement, like `layouts` (no client requests this view today)
    expect(toFirstPaintDiagramMeta(diagram)).toMatchObject({ lowerRouting: diagram.lowerRouting })
    expect(toFirstPaintDiagramMeta(diagram)).not.toHaveProperty('comments')
    expect(toFirstPaintDiagramMeta(diagram)).not.toHaveProperty('flows')
  })

  it('returns the complementary lazy editor metadata', () => {
    expect(toDiagramEditorMeta(diagram)).toEqual({
      id: 'd1', description: 'editor', comments: diagram.comments, flows: diagram.flows,
      checkpoints: diagram.checkpoints, shapeCount: 1,
    })
  })
})
