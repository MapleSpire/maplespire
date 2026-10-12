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
import { computeWindow, type WindowReader } from './window'
import type { C4Object } from '../../types'

function obj(id: string, parentId?: string): C4Object {
  return {
    id, type: 'app', name: id,
    position: { x: 0, y: 0 }, size: { width: 160, height: 100 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...(parentId ? { parentId } : {}),
  }
}

interface Fixture {
  objects: C4Object[]
  diagrams: { id: string; objectIds: string[]; connectionIds: string[]; groupIds: string[] }[]
  incident?: Record<string, string[]>
}

function reader(f: Fixture): WindowReader {
  const objById = new Map(f.objects.map((o) => [o.id, o]))
  const diagById = new Map(f.diagrams.map((d) => [d.id, d]))
  return {
    async diagramComposition(id) {
      const d = diagById.get(id)
      return d ? { objectIds: d.objectIds, connectionIds: d.connectionIds, groupIds: d.groupIds } : undefined
    },
    async object(id) {
      return objById.get(id)
    },
    async incidentConnectionIds(oid) {
      return (f.incident ?? {})[oid] ?? []
    },
  }
}

const sorted = (s: Set<string>) => [...s].sort()

describe('computeWindow', () => {
  it('returns empty sets for an unknown diagram', async () => {
    const w = await computeWindow(reader({ objects: [], diagrams: [] }), 'missing')
    expect(w.objectIds.size).toBe(0)
    expect(w.connectionIds.size).toBe(0)
    expect(w.groupIds.size).toBe(0)
  })

  it('includes the diagram composition (objects/connections/groups)', async () => {
    const f: Fixture = {
      objects: [obj('o1'), obj('o2')],
      diagrams: [{ id: 'd', objectIds: ['o1', 'o2'], connectionIds: ['c1'], groupIds: ['g1'] }],
    }
    const w = await computeWindow(reader(f), 'd', { includeAncestors: false, includeIncident: false })
    expect(sorted(w.objectIds)).toEqual(['o1', 'o2'])
    expect(sorted(w.connectionIds)).toEqual(['c1'])
    expect(sorted(w.groupIds)).toEqual(['g1'])
  })

  it('walks the C4 ancestor chain of diagram objects', async () => {
    // o3 → parent o2 → parent o1 (root). The diagram shows only o3.
    const f: Fixture = {
      objects: [obj('o1'), obj('o2', 'o1'), obj('o3', 'o2')],
      diagrams: [{ id: 'd', objectIds: ['o3'], connectionIds: [], groupIds: [] }],
    }
    const w = await computeWindow(reader(f), 'd', { includeIncident: false })
    expect(sorted(w.objectIds)).toEqual(['o1', 'o2', 'o3']) // self + 2 ancestors
  })

  it('dedupes shared ancestors across multiple seed objects', async () => {
    // o2 and o3 both under o1.
    const f: Fixture = {
      objects: [obj('o1'), obj('o2', 'o1'), obj('o3', 'o1')],
      diagrams: [{ id: 'd', objectIds: ['o2', 'o3'], connectionIds: [], groupIds: [] }],
    }
    const w = await computeWindow(reader(f), 'd', { includeIncident: false })
    expect(sorted(w.objectIds)).toEqual(['o1', 'o2', 'o3'])
  })

  it('does not loop on a parentId cycle', async () => {
    // o1 → o2 → o1 (corrupt cycle). Must terminate.
    const f: Fixture = {
      objects: [obj('o1', 'o2'), obj('o2', 'o1')],
      diagrams: [{ id: 'd', objectIds: ['o1'], connectionIds: [], groupIds: [] }],
    }
    const w = await computeWindow(reader(f), 'd', { includeIncident: false })
    expect(sorted(w.objectIds)).toEqual(['o1', 'o2'])
  })

  it('adds connections incident to window objects (including ancestors)', async () => {
    const f: Fixture = {
      objects: [obj('o1'), obj('o2', 'o1')],
      diagrams: [{ id: 'd', objectIds: ['o2'], connectionIds: ['cDiagram'], groupIds: [] }],
      incident: { o2: ['cDiagram', 'cIncident'], o1: ['cAncestorEdge'] },
    }
    const w = await computeWindow(reader(f), 'd')
    // composition cDiagram + o2's incident cIncident + ancestor o1's incident cAncestorEdge
    expect(sorted(w.connectionIds)).toEqual(['cAncestorEdge', 'cDiagram', 'cIncident'])
    expect(sorted(w.objectIds)).toEqual(['o1', 'o2'])
  })

  it('honors includeAncestors:false / includeIncident:false', async () => {
    const f: Fixture = {
      objects: [obj('o1'), obj('o2', 'o1')],
      diagrams: [{ id: 'd', objectIds: ['o2'], connectionIds: ['c1'], groupIds: [] }],
      incident: { o2: ['c1', 'cX'] },
    }
    const noExtras = await computeWindow(reader(f), 'd', { includeAncestors: false, includeIncident: false })
    expect(sorted(noExtras.objectIds)).toEqual(['o2'])
    expect(sorted(noExtras.connectionIds)).toEqual(['c1'])

    const incidentOnly = await computeWindow(reader(f), 'd', { includeAncestors: false })
    expect(sorted(incidentOnly.objectIds)).toEqual(['o2'])
    expect(sorted(incidentOnly.connectionIds)).toEqual(['c1', 'cX'])
  })

  it('stays O(window): reads scale with the window, not the model', async () => {
    // 10k-object model, but the diagram shows 3 (+1 ancestor). Count reads.
    const objects: C4Object[] = []
    for (let i = 0; i < 10000; i++) objects.push(obj('o' + i, i < 3 ? 'root' : undefined))
    objects.push(obj('root'))
    let objectReads = 0
    const base = reader({
      objects,
      diagrams: [{ id: 'd', objectIds: ['o0', 'o1', 'o2'], connectionIds: [], groupIds: [] }],
    })
    const counting: WindowReader = {
      diagramComposition: base.diagramComposition,
      object: (id) => { objectReads++; return base.object(id) },
      incidentConnectionIds: base.incidentConnectionIds,
    }
    const w = await computeWindow(counting, 'd')
    expect(sorted(w.objectIds)).toEqual(['o0', 'o1', 'o2', 'root'])
    // 3 seeds × (self + root) walks = at most ~6 object reads — nowhere near 10000.
    expect(objectReads).toBeLessThan(20)
  })
})
