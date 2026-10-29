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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object } from '../../types'
import type { DiagramDoc } from '../automerge/types'

// The WIRE between buildShareSnapshot and bakeShareScopes: the bake must run
// against the full model BEFORE the slice drops the ancestors the boundary rule
// walks. bakeShareScopes has its own tests; this pins that the snapshot calls it.
const active = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('../automerge/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../automerge/bridge')>()),
  getActiveDiagramHandle: () => ({ doc: () => active.doc }),
}))

const { buildShareSnapshot } = await import('./snapshot')
const { useModelStore } = await import('../../stores/modelStore')

const obj = (id: string, parentId?: string): C4Object => ({
  id, name: id, type: 'app', position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  ...(parentId ? { parentId } : {}),
} as C4Object)

beforeEach(() => {
  // Container view of shop: ledger belongs to bank, which is NOT on the diagram.
  active.doc = {
    name: 'Shop', type: 'container', parentObjectId: 'shop',
    objectIds: ['web', 'ledger', 'api'], connectionIds: [], groupIds: [], layouts: {},
    objectScopes: { api: 'external' }, comments: {}, flows: {}, checkpoints: [],
  } as unknown as DiagramDoc
  useModelStore.setState({
    objects: [obj('shop'), obj('web', 'shop'), obj('api', 'shop'), obj('bank'), obj('ledger', 'bank')],
    connections: [], groups: [], domains: [], tags: [], decisionRecords: [],
  })
})

describe('buildShareSnapshot — per-diagram scope', () => {
  it('bakes the editor-resolved scope of every object into the shared diagram', async () => {
    const snap = await buildShareSnapshot({ rootDiagramId: 'shop-c', limitToDiagram: true })
    expect(snap.model.objects.some((o) => o.id === 'bank')).toBe(false)
    expect(snap.diagrams[0].objectScopes).toEqual({ web: 'internal', ledger: 'external', api: 'external' })
  })
})
