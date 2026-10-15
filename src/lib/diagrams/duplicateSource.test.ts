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

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Diagram } from '../../types'
import type { DiagramDoc } from '../automerge/types'

const findDiagramHandle = vi.fn()
const getRegistryShardHandles = vi.fn()
const fetchDiagramMeta = vi.fn()
const getState = vi.fn()

vi.mock('../automerge/repo', () => ({
  findDiagramHandle: (url: string) => findDiagramHandle(url),
  getRegistryShardHandles: () => getRegistryShardHandles(),
}))
vi.mock('../modelQuery/diagramMeta', () => ({
  fetchDiagramMeta: (id: string) => fetchDiagramMeta(id),
}))
vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => getState() },
}))

const { loadDiagramDuplicateSource, loadDiagramLayouts } = await import('./duplicateSource')

const PLACED = {
  o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } },
}

const doc = (over: Partial<DiagramDoc> = {}): DiagramDoc => ({
  name: 'Containers',
  type: 'container',
  objectIds: ['o1'],
  connectionIds: [],
  groupIds: [],
  layouts: PLACED,
  comments: {},
  flows: {},
  checkpoints: [],
  ...over,
} as DiagramDoc)

/** What the registry knows: composition, and where the document lives. */
const meta = (over: Record<string, unknown> = {}) => ({
  id: 'dg1',
  name: 'Containers',
  type: 'container',
  docUrl: 'automerge:abc',
  objectIds: ['o1'],
  connectionIds: [],
  groupIds: [],
  ...over,
})

const storeState = (over: Record<string, unknown> = {}) => ({
  currentDiagramId: null,
  diagrams: [] as Diagram[],
  flows: [],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  getState.mockReturnValue(storeState())
  getRegistryShardHandles.mockResolvedValue([])
  fetchDiagramMeta.mockResolvedValue(undefined)
  findDiagramHandle.mockRejectedValue(new Error('not stubbed'))
})

describe('loadDiagramDuplicateSource', () => {
  it('uses the resident store for the ACTIVE diagram — it can be ahead of storage', async () => {
    const active: Diagram = {
      id: 'dg1', name: 'Containers', type: 'container',
      objectIds: ['o1'], connectionIds: [], groupIds: [], layouts: PLACED,
    }
    getState.mockReturnValue(storeState({
      currentDiagramId: 'dg1',
      diagrams: [active],
      flows: [{ id: 'f1', name: 'Flow', diagramId: 'dg1', steps: [] }, { id: 'f2', name: 'Other', diagramId: 'dg2', steps: [] }],
    }))

    const source = await loadDiagramDuplicateSource('dg1')
    expect(source?.via).toBe('store')
    expect(source?.diagram.layouts).toEqual(PLACED)
    expect(source?.flows.map((f) => f.id)).toEqual(['f1'])
    expect(getRegistryShardHandles).not.toHaveBeenCalled()
  })

  it('reads the DiagramDoc for a diagram nobody has open', async () => {
    getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
    findDiagramHandle.mockResolvedValue({ doc: () => doc({ flows: { f1: { id: 'f1', name: 'Flow', diagramId: 'dg1', steps: [] } } }) })

    const source = await loadDiagramDuplicateSource('dg1')
    expect(findDiagramHandle).toHaveBeenCalledWith('automerge:abc')
    expect(source?.via).toBe('document')
    expect(source?.diagram.layouts).toEqual(PLACED)
    expect(source?.flows).toHaveLength(1)
  })

  it('falls back to the server for the docUrl when the registry shards are not resident', async () => {
    // Boot-from-server and any server-paged list: `s.diagrams` are stubs and the
    // registry is summary-only, so the shard walk finds nothing.
    getRegistryShardHandles.mockResolvedValue([])
    fetchDiagramMeta.mockResolvedValue({ meta: meta(), diagram: {}, comments: [], flows: [] })
    findDiagramHandle.mockResolvedValue({ doc: () => doc() })

    const source = await loadDiagramDuplicateSource('dg1')
    expect(source?.via).toBe('document')
    expect(source?.diagram.layouts).toEqual(PLACED)
  })

  it('REFUSES a diagram-meta payload as the source — it carries no placement', async () => {
    // The regression. `/api/model/diagram-meta` returns the REGISTRY ENTRY:
    // id, name, type, the three composition arrays, parentObjectId. It looks
    // enough like a Diagram to destructure as one, and duplicating from it
    // produced a copy whose every shape collapsed to the model-level 0,0
    // default — with nothing in the result saying so.
    fetchDiagramMeta.mockResolvedValue({ meta: meta(), diagram: meta(), comments: [], flows: [] })
    findDiagramHandle.mockRejectedValue(new Error('document unavailable'))

    expect(await loadDiagramDuplicateSource('dg1')).toBeNull()
  })

  it('refuses when the ACTIVE store entry is a layout-less stub', async () => {
    // Reachable while a diagram is opening: it is already `currentDiagramId`
    // but its document has not been projected yet.
    getState.mockReturnValue(storeState({
      currentDiagramId: 'dg1',
      diagrams: [{ id: 'dg1', name: 'C', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [] } as Diagram],
    }))
    expect(await loadDiagramDuplicateSource('dg1')).toBeNull()
  })

  it('copies an EMPTY diagram, which legitimately has nothing to place', async () => {
    getRegistryShardHandles.mockResolvedValue([
      { doc: () => ({ diagrams: { dg1: meta({ objectIds: [] }) } }) },
    ])
    findDiagramHandle.mockResolvedValue({
      doc: () => doc({ objectIds: [], layouts: {} }),
    })

    const source = await loadDiagramDuplicateSource('dg1')
    expect(source?.via).toBe('document')
    expect(source?.diagram.objectIds).toEqual([])
  })

  it('gives up rather than hanging when the document never resolves', async () => {
    // `repo.find()` with a network adapter and no connected peer never settles
    // on its own. A click that hangs forever is the worse failure.
    vi.useFakeTimers()
    try {
      getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
      findDiagramHandle.mockReturnValue(new Promise(() => {}))

      const pending = loadDiagramDuplicateSource('dg1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// The inline expansion's source of placement (`expandInline.ts`). Same document,
// different contract: "unknown" and "nothing placed" are different answers.
describe('loadDiagramLayouts', () => {
  it('reads the placement from the document, not the server stub', async () => {
    // The 2026-10-15 shape of it: the server answers, with composition and NO
    // layouts — trusting it drew a whole expansion on one point.
    fetchDiagramMeta.mockResolvedValue({ meta: meta(), diagram: meta(), comments: [], flows: [] })
    findDiagramHandle.mockResolvedValue({ doc: () => doc() })

    expect(await loadDiagramLayouts('dg1')).toEqual(PLACED)
    expect(findDiagramHandle).toHaveBeenCalledWith('automerge:abc')
  })

  // Runs on every "Expand here". On a summary-only registry the shard walk
  // resolves and pins every registry shard — the cost that mode avoids.
  it('asks the server for the document before walking the registry shards', async () => {
    fetchDiagramMeta.mockResolvedValue({ meta: meta(), diagram: meta(), comments: [], flows: [] })
    findDiagramHandle.mockResolvedValue({ doc: () => doc() })

    expect(await loadDiagramLayouts('dg1')).toEqual(PLACED)
    expect(getRegistryShardHandles).not.toHaveBeenCalled()
  })

  it('walks the registry shards when the server cannot answer (offline)', async () => {
    fetchDiagramMeta.mockRejectedValue(new Error('offline'))
    getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
    findDiagramHandle.mockResolvedValue({ doc: () => doc() })

    expect(await loadDiagramLayouts('dg1')).toEqual(PLACED)
    expect(findDiagramHandle).toHaveBeenCalledWith('automerge:abc')
  })

  it('hands back a copy, never the document snapshot itself', async () => {
    getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
    const snapshot = doc()
    findDiagramHandle.mockResolvedValue({ doc: () => snapshot })

    const layouts = await loadDiagramLayouts('dg1')
    expect(layouts).toEqual(PLACED)
    expect(layouts!.o1).not.toBe(snapshot.layouts!.o1)
  })

  it('answers {} for a reachable document that places nothing', async () => {
    getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
    findDiagramHandle.mockResolvedValue({ doc: () => doc({ layouts: undefined }) })

    expect(await loadDiagramLayouts('dg1')).toEqual({})
  })

  it('answers null when the document cannot be reached', async () => {
    fetchDiagramMeta.mockRejectedValue(new Error('offline'))
    expect(await loadDiagramLayouts('dg1')).toBeNull()
    // No URL from either source: nothing to ask the repo for.
    expect(findDiagramHandle).not.toHaveBeenCalled()

    getRegistryShardHandles.mockResolvedValue([{ doc: () => ({ diagrams: { dg1: meta() } }) }])
    findDiagramHandle.mockRejectedValue(new Error('document unavailable'))
    expect(await loadDiagramLayouts('dg1')).toBeNull()
  })
})
