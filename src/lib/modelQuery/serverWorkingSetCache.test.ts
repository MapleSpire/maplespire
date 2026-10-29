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
import type { CachedModelEntityInput } from './idbSchema'

const upsertObjects = vi.fn(async (_input: { items: CachedModelEntityInput[] }) => ({ count: 0 }))
const storageStatus = vi.fn(async () => [{ pinned: false, coverage: 'working-set' }])

vi.mock('./workerClient', () => ({
  getModelReadCacheWorker: () => ({ upsertObjects, storageStatus }),
}))

const { serverModelQuery, __setServerFetchForTest } = await import('./server')

afterEach(() => {
  __setServerFetchForTest(null)
  upsertObjects.mockClear()
})

/** The explorer page a working-set cache is filled from carries the EXPLORER
 * parent (a group, for a grouped object) — and the server's c4ParentId, which
 * the offline worker files the row's Model Viewer level on. Dropping it here
 * puts every grouped object of an unpinned cache under its group. */
describe('serverModelQuery explorer pages -> browser working-set cache', () => {
  it('passes c4ParentId through to the worker, null included', async () => {
    __setServerFetchForTest(async () => new Response(JSON.stringify({
      projectionGeneration: 4,
      nextCursor: null,
      total: 2,
      items: [
        { id: 'app1', name: 'app1', kind: 'object', type: 'app', parentId: 'boundary', c4ParentId: 'sys', childCount: 0, hasChildren: false, canAcceptChildren: true, appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0, inDiagram: false, breadcrumb: [] },
        { id: 'ghost', name: 'Ghost', kind: 'object', type: 'system', parentId: 'zone', c4ParentId: null, childCount: 0, hasChildren: false, canAcceptChildren: true, appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0, inDiagram: false, breadcrumb: [] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await serverModelQuery.objectTreePage({ parentId: 'boundary', limit: 50 })
    await vi.waitFor(() => expect(upsertObjects).toHaveBeenCalledTimes(1))

    const items = upsertObjects.mock.calls[0][0].items
    expect(Object.fromEntries(items.map((item) => [item.id, item.c4ParentId]))).toEqual({ app1: 'sys', ghost: null })
  })
})
