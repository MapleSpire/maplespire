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

import { describe, it, expect, vi } from 'vitest'
import {
  computeLowerConnections,
  roDiagramRender,
  toFirstPaintDiagramRender,
  type MiniConn,
} from './diagramRender.js'

/**
 * Parity tests for the server-side lower-connection roll-up vs the client's
 * `syncLowerConnections` semantics. A two-level C4 hierarchy:
 *   System A → app a1 → component a1c
 *   System B → app b1 → component b1c
 * The diagram shows only A and B.
 */
const parentOf = new Map<string, string | undefined>([
  ['A', undefined], ['B', undefined],
  ['a1', 'A'], ['a1c', 'a1'],
  ['b1', 'B'], ['b1c', 'b1'],
  ['x', undefined], // an object outside both subtrees
  ['gObj', undefined], // a grouped object
])

describe('computeLowerConnections — parity with client syncLowerConnections', () => {
  const diagram = { objectIds: ['A', 'B'], connectionIds: ['direct1'], groupIds: [] }
  const noGroups = new Map<string, string[]>()

  it('rolls a deep edge up to the nearest visible ancestors', () => {
    const conns: MiniConn[] = [{ id: 'deep1', fromId: 'a1c', toId: 'b1c' }]
    expect(computeLowerConnections(diagram, parentOf, noGroups, conns)).toEqual([
      { id: 'lower:A→B', fromId: 'A', toId: 'B', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('skips an edge where both endpoints are already directly visible', () => {
    const conns: MiniConn[] = [{ id: 'direct1', fromId: 'A', toId: 'B' }]
    expect(computeLowerConnections(diagram, parentOf, noGroups, conns)).toEqual([])
  })

  it('skips self-loops after roll-up and dedupes a visible pair (first wins)', () => {
    const conns: MiniConn[] = [
      { id: 'self', fromId: 'a1', toId: 'a1c' }, // both → A ⇒ self-loop, skip
      { id: 'deep1', fromId: 'a1c', toId: 'b1c' }, // A→B
      { id: 'deep2', fromId: 'a1', toId: 'b1' }, // A→B again ⇒ deduped
    ]
    const lower = computeLowerConnections(diagram, parentOf, noGroups, conns)
    expect(lower.map((l) => l.id)).toEqual(['lower:A→B'])
  })

  it('skips an edge with an endpoint that has no visible representative', () => {
    const conns: MiniConn[] = [{ id: 'orphan', fromId: 'a1c', toId: 'x' }]
    expect(computeLowerConnections(diagram, parentOf, noGroups, conns)).toEqual([])
  })

  it('falls back to a containing group when that group is on the diagram', () => {
    // gObj is in group G; the diagram shows A and group G.
    const diagWithGroup = { objectIds: ['A'], connectionIds: [], groupIds: ['G'] }
    const groups = new Map<string, string[]>([['G', ['gObj']]])
    const conns: MiniConn[] = [{ id: 'e', fromId: 'a1c', toId: 'gObj' }] // a1c→A (ancestor), gObj→G (group)
    expect(computeLowerConnections(diagWithGroup, parentOf, groups, conns)).toEqual([
      { id: 'lower:A→G', fromId: 'A', toId: 'G', kind: 'lower', type: 'dashed', label: '' },
    ])
  })

  it('ignores a group that is NOT on the diagram (no fallback)', () => {
    const diag = { objectIds: ['A', 'B'], connectionIds: [], groupIds: [] } // group G not placed
    const groups = new Map<string, string[]>([['G', ['gObj']]])
    const conns: MiniConn[] = [{ id: 'e', fromId: 'a1c', toId: 'gObj' }] // gObj has no visible rep
    expect(computeLowerConnections(diag, parentOf, groups, conns)).toEqual([])
  })
})

describe('roDiagramRender static performance path', () => {
  it('loads only the persisted diagram composition and never scans the workspace', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM ro_diagrams')) return {
        rows: [{
          diagram_data: {
            connectionIds: ['c1'],
            groupIds: [],
            layouts: { o1: { position: { x: 42, y: 84 }, size: { width: 160, height: 90 } } },
          },
          projection_generation: 1,
          object_data: [{ id: 'o1', position: { x: 9000, y: 12000 }, size: { width: 1, height: 1 } }],
          connection_data: [{ id: 'c1' }],
          group_data: [],
        }],
      }
      throw new Error(`Unexpected unbounded query: ${sql}`)
    })

    await expect(roDiagramRender(
      { query } as never,
      { landscapeId: 'landscape', versionId: 'version' },
      'diagram',
      { computeLowerConnections: false },
    )).resolves.toEqual({
      projectionGeneration: 1,
      objects: [{ id: 'o1', position: { x: 42, y: 84 }, size: { width: 160, height: 90 } }],
      connections: [{ id: 'c1' }],
      groups: [],
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('jsonb_agg(object.data)')
    expect(query.mock.calls[0]?.[0]).toContain("diagram.data->'connectionIds'")
  })
})

describe('first-paint render DTO', () => {
  it('keeps every canvas field while deferring links, properties and editor-only technology metadata', () => {
    const render = toFirstPaintDiagramRender({
      projectionGeneration: 12,
      objects: [{
        id: 'o1', type: 'app', name: 'API', description: 'Visible subtitle',
        position: { x: 1, y: 2 }, size: { width: 3, height: 4 }, scope: 'internal', status: 'live',
        tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'], ownerTeamIds: ['team'], teamIds: ['team'],
        links: ['https://editor.example'], properties: { owner: 'platform' },
        technologyUsageOrder: ['u1'], technologyUsages: { u1: {
          id: 'u1', technologyId: 'tech-1', catalogRevision: 4, role: 'runtime', notes: 'editor only', usedVersion: '22',
          snapshot: { schemaVersion: 1, name: 'Node.js', iconLightPath: '/l.png', iconDarkPath: '/d.png', defaultRole: 'runtime', recommendedShapeTypes: ['app'] },
        } },
      }],
      connections: [{ id: 'c1', fromId: 'o1', toId: 'o2', type: 'solid', waypoints: [{ x: 1, y: 1 }] }],
      groups: [{ id: 'g1', name: 'Boundary', description: 'Visible group text', color: '#fff', objectIds: ['o1'], tagAssignments: {}, tagOrder: [] }],
    }, 7)

    expect(render).toMatchObject({
      schemaVersion: 1,
      projectionGeneration: 12,
      renderGeneration: 7,
      objects: [{
        id: 'o1', name: 'API', description: 'Visible subtitle', position: { x: 1, y: 2 },
        tagOrder: ['t1'], ownerTeamIds: ['team'], teamIds: ['team'],
        technologyUsages: { u1: { id: 'u1', technologyId: 'tech-1', catalogRevision: 4, role: 'runtime', snapshot: { name: 'Node.js' } } },
      }],
      connections: [{ id: 'c1', waypoints: [{ x: 1, y: 1 }] }],
      groups: [{ id: 'g1', description: 'Visible group text' }],
    })
    expect(render.objects[0]).not.toHaveProperty('links')
    expect(render.objects[0]).not.toHaveProperty('properties')
    expect((render.objects[0].technologyUsages as Record<string, Record<string, unknown>>).u1).not.toHaveProperty('notes')
    expect(((render.objects[0].technologyUsages as Record<string, Record<string, unknown>>).u1.snapshot as Record<string, unknown>)).not.toHaveProperty('recommendedShapeTypes')
  })
})
