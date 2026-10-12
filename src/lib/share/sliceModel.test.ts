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

import { describe, it, expect } from 'vitest'
import { toShareDiagram, sliceModelForShare } from './sliceModel'
import type { C4Object, Connection, Group, Tag, Diagram } from '../../types'

const obj = (id: string, tagOrder: string[] = []): C4Object => ({
  id,
  type: 'system',
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 10, height: 10 },
  tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
  tagOrder,
  scope: 'internal',
  status: 'live',
  properties: {},
})
const conn = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid' })
const grp = (id: string, objectIds: string[] = []): Group => ({ id, name: id, color: '#fff', objectIds, tagAssignments: {}, tagOrder: [] })
const tag = (tagId: string): Tag => ({ tagId, value: tagId, color: '#FF0000', groupId: 'g', groupName: 'Test', catalogRevision: 1 })
const dg = (id: string, objectIds: string[], connectionIds: string[] = [], groupIds: string[] = []) => ({
  id,
  name: id,
  type: 'context' as const,
  objectIds,
  connectionIds,
  groupIds,
})

describe('toShareDiagram', () => {
  it('copies only safe display fields and never leaks sensitive ones', () => {
    const diagram: Diagram = {
      id: 'd1',
      name: 'D1',
      type: 'context',
      objectIds: ['o1'],
      connectionIds: ['c1'],
      groupIds: ['g1'],
      layouts: { o1: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } },
      skinId: 'sk',
      parentObjectId: 'p1',
      // must NOT appear in a public snapshot:
      description: 'internal notes',
      domainId: 'dom1',
      readonly: true,
    }
    const sd = toShareDiagram(diagram)
    expect(sd).toMatchObject({ id: 'd1', name: 'D1', type: 'context', skinId: 'sk', parentObjectId: 'p1' })
    expect(sd.layouts).toEqual(diagram.layouts)
    expect(sd).not.toHaveProperty('description')
    expect(sd).not.toHaveProperty('domainId')
    expect(sd).not.toHaveProperty('readonly')
  })

  it('omits absent optional fields (no undefined values emitted)', () => {
    const sd = toShareDiagram(dg('d', [], [], []) as Diagram)
    expect(sd).not.toHaveProperty('skinId')
    expect(sd).not.toHaveProperty('parentObjectId')
    expect(Object.values(sd)).not.toContain(undefined)
  })

  it('carries the 3D board layer when the diagram has one (and omits it otherwise)', () => {
    const layouts3d = { o1: { position: { x: 9, y: 9 }, size: { width: 3, height: 4 } } }
    const withLayer = toShareDiagram({ ...(dg('d', ['o1']) as Diagram), layouts3d })
    expect(withLayer.layouts3d).toEqual(layouts3d)
    const without = toShareDiagram(dg('d', ['o1']) as Diagram)
    expect(without).not.toHaveProperty('layouts3d')
  })

  it('carries the scene decoration so the shared link shows the dressed board', () => {
    const sceneDecor = { packId: 'maquette-people', density: 'rich' as const, seed: 7 }
    const withDecor = toShareDiagram({ ...(dg('d', ['o1']) as Diagram), sceneDecor })
    expect(withDecor.sceneDecor).toEqual(sceneDecor)
    const without = toShareDiagram(dg('d', ['o1']) as Diagram)
    expect(without).not.toHaveProperty('sceneDecor')
  })
})

describe('sliceModelForShare', () => {
  const model = {
    objects: [obj('o1', ['t1']), obj('o2'), obj('o3-unref', ['t2'])],
    connections: [conn('c1', 'o1', 'o2'), conn('c2-unref', 'o2', 'o3-unref')],
    groups: [grp('g1', ['o1']), grp('g2-unref', ['o3-unref'])],
    tags: [tag('t1'), tag('t2'), tag('t3-unref')],
  }

  it('includes only referenced objects / connections / groups', () => {
    const s = sliceModelForShare([dg('d1', ['o1', 'o2'], ['c1'], ['g1'])], model)
    expect(s.objects.map((o) => o.id)).toEqual(['o1', 'o2'])
    expect(s.connections.map((c) => c.id)).toEqual(['c1'])
    expect(s.groups.map((g) => g.id)).toEqual(['g1'])
  })

  it('includes only tags used by the included objects', () => {
    const s = sliceModelForShare([dg('d1', ['o1', 'o2'], ['c1'], ['g1'])], model)
    expect(s.tags.map((t) => t.tagId)).toEqual(['t1'])
  })

  it('includes tags assigned directly to an included connection', () => {
    const connectionTag = tag('t-connection')
    const taggedConnection: Connection = {
      ...conn('c1', 'o1', 'o2'),
      tagAssignments: { 't-connection': { tagId: 't-connection' } },
      tagOrder: ['t-connection'],
    }
    const s = sliceModelForShare(
      [dg('d1', ['o1', 'o2'], ['c1'], [])],
      { ...model, connections: [taggedConnection], tags: [...model.tags, connectionTag] },
    )
    expect(s.tags.map((entry) => entry.tagId)).toEqual(['t1', 't-connection'])
  })

  it('emits exactly the model keys — no comments / decision records / domains', () => {
    const s = sliceModelForShare([dg('d1', ['o1'], [], [])], model)
    expect(Object.keys(s).sort()).toEqual(['connections', 'groups', 'objects', 'tags'])
  })

  it('unions composition across multiple diagrams (landscape)', () => {
    const s = sliceModelForShare([dg('d1', ['o1'], [], []), dg('d2', ['o2'], ['c1'], [])], model)
    expect(s.objects.map((o) => o.id).sort()).toEqual(['o1', 'o2'])
    expect(s.connections.map((c) => c.id)).toEqual(['c1'])
  })
})
