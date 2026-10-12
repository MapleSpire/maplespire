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
import type { Diagram } from '../../types'
import type { DiagramDoc, DiagramMeta } from './types'
import { resolveDiagramProjection } from './projection'

const meta: DiagramMeta = {
  id: 'diagram-1',
  name: 'Performance baseline',
  type: 'context',
  docUrl: 'automerge:4w7fG7nD4n8i8wpJ7wB3JkzcnMn',
  objectIds: ['object-1'],
  connectionIds: [],
  groupIds: [],
}

const summary: Diagram = {
  id: meta.id,
  name: meta.name,
  type: meta.type,
  objectIds: meta.objectIds,
  connectionIds: [],
  groupIds: [],
  layouts: {
    'object-1': { position: { x: 100, y: 100 }, size: { width: 200, height: 120 } },
  },
}

const activeDoc: DiagramDoc = {
  name: meta.name,
  type: meta.type,
  objectIds: meta.objectIds,
  connectionIds: [],
  groupIds: [],
  layouts: {
    'object-1': { position: { x: 640, y: 480 }, size: { width: 200, height: 120 } },
  },
  comments: {},
  flows: {},
  checkpoints: [],
}

describe('resolveDiagramProjection', () => {
  it('prefers the hydrated active DiagramDoc over a stale server summary', () => {
    const projected = resolveDiagramProjection(meta, meta.id, activeDoc, summary)

    expect(projected.layouts?.['object-1']?.position).toEqual({ x: 640, y: 480 })
  })

  it('keeps the bounded server summary for a non-active diagram', () => {
    expect(resolveDiagramProjection(meta, 'diagram-2', activeDoc, summary)).toBe(summary)
  })
})
