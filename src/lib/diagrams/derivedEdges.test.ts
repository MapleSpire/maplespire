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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readDerivedEdges, readEdgeEnds, type DerivedEdgeSources } from './derivedEdges'
import type { DiagramRenderResult } from '../modelQuery/diagramRender'
import type { C4Object, Connection, Group } from '../../types'

const edge = (id: string, fromId: string, toId: string, kind?: 'lower'): Connection =>
  ({ id, fromId, toId, ...(kind ? { kind } : {}) } as Connection)
const render = (connections: Connection[]): DiagramRenderResult =>
  ({ projectionGeneration: 1, objects: [], connections, groups: [] })

/** FoodDash, smallest: Mobile App -> Order API (a component of Order Service). */
const MODEL = {
  objects: [
    { id: 'mobile' }, { id: 'orders' }, { id: 'api', parentId: 'orders' },
  ] as C4Object[],
  connections: [
    edge('mobile-api', 'mobile', 'api'),
    // A stored roll-up from elsewhere is never an input to the roll-up.
    edge('stale-lower', 'api', 'mobile', 'lower'),
  ],
  groups: [] as Group[],
}
const CONTAINERS = { objectIds: ['mobile', 'orders'], groupIds: [] }

function sources(over: Partial<DerivedEdgeSources> = {}): DerivedEdgeSources {
  return {
    resident: () => false,
    model: () => MODEL,
    fetchRender: async () => undefined,
    offlineRender: async () => undefined,
    ...over,
  }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { warn.mockRestore() })

describe('readDerivedEdges', () => {
  it('takes the derived edges of the server\'s render, not its own', async () => {
    const lower = edge('lower:mobile→orders', 'mobile', 'orders', 'lower')
    const got = await readDerivedEdges('containers', CONTAINERS, sources({
      fetchRender: async () => render([edge('mobile-delivery', 'mobile', 'delivery'), lower]),
    }))
    expect(got).toEqual([lower])
  })

  it('falls back to the offline copy when the server is unreachable', async () => {
    const lower = edge('lower:mobile→orders', 'mobile', 'orders', 'lower')
    const offlineRender = vi.fn(async () => render([lower]))
    const got = await readDerivedEdges('containers', CONTAINERS, sources({
      fetchRender: async () => { throw new TypeError('Failed to fetch') },
      offlineRender,
    }))
    expect(offlineRender).toHaveBeenCalledWith('containers')
    expect(got).toEqual([lower])
  })

  it('a reachable server is not second-guessed by the offline copy', async () => {
    const offlineRender = vi.fn(async () => render([]))
    await readDerivedEdges('containers', CONTAINERS, sources({ fetchRender: async () => render([]), offlineRender }))
    expect(offlineRender).not.toHaveBeenCalled()
  })

  // No read model on the server (404): only the resident tier has the whole
  // model to roll up.
  it('rolls the edges up itself on the resident tier when there is no render', async () => {
    const got = await readDerivedEdges('containers', CONTAINERS, sources({ resident: () => true }))
    expect(got).toEqual([expect.objectContaining({ fromId: 'mobile', toId: 'orders', kind: 'lower' })])
  })

  it('does not roll up over a windowed store: unknown, not empty', async () => {
    expect(await readDerivedEdges('containers', CONTAINERS, sources())).toBeUndefined()
  })

  it('a render found offline wins over the resident roll-up', async () => {
    const got = await readDerivedEdges('containers', CONTAINERS, sources({
      resident: () => true,
      fetchRender: async () => { throw new Error('down') },
      offlineRender: async () => render([]),
    }))
    expect(got).toEqual([])
  })

  it('never rejects: a failing offline copy is unknown', async () => {
    const got = await readDerivedEdges('containers', CONTAINERS, sources({
      fetchRender: async () => { throw new Error('down') },
      offlineRender: async () => { throw new Error('IndexedDB blocked') },
    }))
    expect(got).toBeUndefined()
  })
})

describe('readEdgeEnds', () => {
  // FoodDash: Order API and Checkout are components of Order Service, itself in FoodDash.
  const entities = new Map<string, { id: string; parentId?: string }>([
    ['api', { id: 'api', parentId: 'orders' }], ['checkout', { id: 'checkout', parentId: 'orders' }],
    ['orders', { id: 'orders', parentId: 'foodDash' }], ['foodDash', { id: 'foodDash' }],
    ['mobile', { id: 'mobile', parentId: 'foodDash' }],
  ])
  const query = (connections: Connection[]) => ({
    connectionsMany: vi.fn(async (ids: string[]) =>
      new Map(connections.filter((c) => ids.includes(c.id)).map((c) => [c.id, c]))),
    lookupMany: vi.fn(async (ids: string[]) =>
      new Map(ids.flatMap((id) => (entities.has(id) ? [[id, entities.get(id)!]] : [])))),
  })

  it('gives each end with every ancestor above it, one lookup per level', async () => {
    const q = query([edge('mobile-api', 'mobile', 'api')])
    const ends = await readEdgeEnds(['mobile-api'], q as never)
    expect(ends.get('mobile-api')).toEqual({ from: ['mobile', 'foodDash'], to: ['api', 'orders', 'foodDash'] })
    expect(q.connectionsMany).toHaveBeenCalledOnce()
    expect(q.lookupMany.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('a connection that cannot be read (deleted) is null, not left out', async () => {
    const ends = await readEdgeEnds(['gone'], query([]) as never)
    expect(ends.has('gone')).toBe(true)
    expect(ends.get('gone')).toBeNull()
  })

  it('never rejects: a failed read makes every connection unknown', async () => {
    const q = { connectionsMany: async () => { throw new Error('down') }, lookupMany: async () => new Map() }
    const ends = await readEdgeEnds(['a', 'b'], q as never)
    expect([...ends.values()]).toEqual([null, null])
  })

  it('stops on a parent cycle in bad data', async () => {
    entities.set('loopA', { id: 'loopA', parentId: 'loopB' })
    entities.set('loopB', { id: 'loopB', parentId: 'loopA' })
    const ends = await readEdgeEnds(['x'], query([edge('x', 'loopA', 'mobile')]) as never)
    expect(ends.get('x')!.from).toEqual(['loopA', 'loopB'])
  })
})
