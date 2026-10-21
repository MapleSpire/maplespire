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
import type { C4Object, Connection, Diagram, Group } from '../../types'
import { buildClipboardPayload, decodeClipboardPayload } from './canvasClipboard'
import { planPaste, type PasteContext } from './pastePlan'

// Defects found by the QA lens. Each test is RED against the change as reviewed.

const obj = (id: string): C4Object => ({
  id, type: 'app', name: `Name ${id}`, position: { x: 0, y: 0 }, size: { width: 100, height: 50 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
}) as C4Object
const place = (x: number, y = 0) => ({ position: { x, y }, size: { width: 100, height: 50 } })

const diagram = {
  id: 'd1', name: 'd', type: 'context', objectIds: ['A', 'B'], connectionIds: ['ab'], groupIds: [],
  layouts: { A: place(0), B: place(400) },
} as unknown as Diagram

let n = 0
const ctx = (over: Partial<PasteContext> = {}): PasteContext => ({
  workspaceKey: 'ws',
  target: diagram,
  objectExists: () => true,
  groupExists: () => true,
  connectionExists: () => true,
  knownTagIds: new Set(),
  forceCopy: false,
  offset: { x: 0, y: 0 },
  mintId: () => `new${++n}`,
  copyName: (name) => `${name} (copy)`,
  ...over,
})

describe('paste: connection bend points', () => {
  it('a pasted copy of a connection carries its bend points (world coordinates) WITH the shapes', () => {
    const source = {
      objects: [obj('A'), obj('B')],
      groups: [] as Group[],
      connections: [{ id: 'ab', fromId: 'A', toId: 'B', type: 'solid', waypoints: [{ x: 250, y: 200 }] } as Connection],
    }
    const payload = buildClipboardPayload(source, diagram, [{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }], '2d', 'ws', 'c')!
    // "Paste here", far from the originals.
    const plan = planPaste(payload, ctx({ offset: { x: 1000, y: 500 } }))
    expect(plan.mode).toBe('copy')
    // The shapes moved by (1000, 500); a bend point left at (250, 200) drags the
    // copied line back across the canvas through the ORIGINAL's route.
    expect(plan.newConnections[0].waypoints).toEqual([{ x: 1250, y: 700 }])
  })
})

describe('paste: an untrusted payload cannot mint duplicate ids', () => {
  const base = {
    app: 'maplespire', version: 1, copyId: 'c', workspaceKey: 'ws', sourceDiagramId: 'd1',
    connections: [], placements: {},
  }

  it('the same object twice', () => {
    const decoded = decodeClipboardPayload(JSON.stringify({ ...base, objects: [obj('X'), obj('X')], groups: [] }))!
    const plan = planPaste(decoded, ctx({ forceCopy: true }))
    const ids = [...plan.newObjects.map((o) => o.id), ...plan.newGroups.map((g) => g.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('an object and a group sharing one id', () => {
    const group = { id: 'X', name: 'G', color: '#000', objectIds: [], tagAssignments: {}, tagOrder: [] }
    const decoded = decodeClipboardPayload(JSON.stringify({ ...base, objects: [obj('X')], groups: [group] }))!
    const plan = planPaste(decoded, ctx({ forceCopy: true }))
    const ids = [...plan.newObjects.map((o) => o.id), ...plan.newGroups.map((g) => g.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
