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

/**
 * `defaultDerivedEdgeSources` — the REAL wiring. The behaviour tests inject
 * their own sources, so without this file the tier gate and the offline chain
 * could be rewired with every test green (QA lens 2026-10-16: three survivors,
 * one of them the "confidently partial" windowed roll-up the code exists to avoid).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  query: { tier: 'paged' } as object,
  readCachedDiagramRender: vi.fn(),
  buildLocalDiagramRender: vi.fn(),
  isIndexReady: vi.fn(),
}))
vi.mock('../modelQuery', () => ({ getModelQuery: () => deps.query }))
vi.mock('../modelQuery/resident', () => ({ residentModelQuery: { tier: 'resident' } }))
vi.mock('../modelQuery/diagramRender', () => ({
  fetchDiagramRender: vi.fn(),
  readCachedDiagramRender: (...args: unknown[]) => deps.readCachedDiagramRender(...args),
}))
vi.mock('../modelQuery/diagramRenderLocal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modelQuery/diagramRenderLocal')>()),
  buildLocalDiagramRender: (...args: unknown[]) => deps.buildLocalDiagramRender(...args),
}))
vi.mock('../modelQuery/offlineIndex', () => ({ isIndexReady: () => deps.isIndexReady() }))
vi.mock('../modelQuery/kvStore', () => ({ workspaceKvStore: () => 'kv' }))
vi.mock('../../stores/modelStore', () => ({ useModelStore: { getState: () => ({}) } }))

const { defaultDerivedEdgeSources: sources } = await import('./derivedEdges')
const { residentModelQuery } = await import('../modelQuery/resident')

const RENDER = { projectionGeneration: 1, objects: [], connections: [], groups: [] }

beforeEach(() => {
  vi.clearAllMocks()
  deps.query = { tier: 'paged' }
})

describe('defaultDerivedEdgeSources', () => {
  it('counts as resident only when the resident query is the active one', () => {
    expect(sources.resident()).toBe(false)
    deps.query = residentModelQuery
    expect(sources.resident()).toBe(true)
  })

  it('offline, a cached render comes first and the index is not rebuilt', async () => {
    deps.readCachedDiagramRender.mockResolvedValue(RENDER)
    deps.isIndexReady.mockReturnValue(true)
    expect(await sources.offlineRender('d')).toBe(RENDER)
    expect(deps.readCachedDiagramRender).toHaveBeenCalledWith('d')
    expect(deps.buildLocalDiagramRender).not.toHaveBeenCalled()
  })

  it('offline with nothing cached, rebuilds from a COMPLETE local index', async () => {
    deps.readCachedDiagramRender.mockResolvedValue(undefined)
    deps.isIndexReady.mockReturnValue(true)
    deps.buildLocalDiagramRender.mockResolvedValue(RENDER)
    expect(await sources.offlineRender('d')).toBe(RENDER)
    expect(deps.buildLocalDiagramRender).toHaveBeenCalledWith('kv', 'd')
  })

  it('offline with nothing cached and no complete index, knows nothing', async () => {
    deps.readCachedDiagramRender.mockResolvedValue(undefined)
    deps.isIndexReady.mockReturnValue(false)
    expect(await sources.offlineRender('d')).toBeUndefined()
    expect(deps.buildLocalDiagramRender).not.toHaveBeenCalled()
  })
})
