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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __setDiagramMetaFetchForTest, fetchDiagramMeta } from './diagramMeta'

afterEach(() => __setDiagramMetaFetchForTest(null))

describe('fetchDiagramMeta', () => {
  it('returns one complete static diagram bootstrap without its transport fields', async () => {
    const diagram = {
      id: 'd1', name: 'Context', type: 'context', docUrl: 'automerge:doc1',
      objectIds: ['o1'], connectionIds: ['c1'], groupIds: [],
      layouts: { o1: { position: { x: 20, y: 40 }, size: { width: 180, height: 110 } } },
      comments: { note1: { id: 'note1', text: 'Review boundary' } },
      flows: { flow1: { id: 'flow1', name: 'Checkout' } },
      shapeCount: 1,
    }
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({ diagram }), { status: 200 }))
    __setDiagramMetaFetchForTest(fetcher)

    await expect(fetchDiagramMeta('d1')).resolves.toMatchObject({
      meta: diagram,
      diagram: { id: 'd1', name: 'Context', objectIds: ['o1'], layouts: diagram.layouts },
      comments: [{ id: 'note1', text: 'Review boundary' }],
      flows: [{ id: 'flow1', name: 'Checkout' }],
    })
    expect((await fetchDiagramMeta('d1'))?.diagram).not.toHaveProperty('docUrl')
    expect((await fetchDiagramMeta('d1'))?.diagram).not.toHaveProperty('shapeCount')
    expect(fetcher.mock.calls[0][0]).toContain('/api/model/diagram-meta?')
    expect(fetcher.mock.calls[0][0]).toContain('id=d1')
  })

  it('returns undefined for an unknown diagram', async () => {
    __setDiagramMetaFetchForTest(async () => new Response('{}', { status: 404 }))
    await expect(fetchDiagramMeta('missing')).resolves.toBeUndefined()
  })
})
