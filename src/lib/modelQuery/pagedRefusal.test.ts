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
import { useModelStore } from '../../stores/modelStore'
import { pagedModelQuery, __setPagedStoreForTest } from './paged'
import { __setServerFetchForTest } from './server'
import { createMemoryKvStore } from './kvStore'
import { buildModelIndex } from './modelIndex'
import type { C4Object, Connection, Group } from '../../types'

// QA lens, 2026-10-11 (account-switch leak): pinning by sample let two
// mutants survive — viewerLevel swallowing a 401/403, and a read that stops on
// ANY HTTP error (a 503 would break offline-first on that page). These arms
// enumerate EVERY server-first read. The split is deliberate (see paged.ts
// `stopsFallback`): the page ladders end on a refusal; the point lookups keep
// their offline fallback, because some callers leave a rejection unhandled.

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  }
}
function conn(id: string, fromId: string, toId: string): Connection {
  return { id, fromId, toId, type: 'solid' }
}
function grp(id: string): Group {
  return { id, name: id, color: '#888888', objectIds: [], tagAssignments: {}, tagOrder: [] }
}
function fixture() {
  return {
    objects: [obj('A'), obj('B'), obj('C')],
    groups: [grp('G1')],
    connections: [conn('c1', 'B', 'A'), conn('c2', 'A', 'C')],
  }
}

function serverAnswers(status: number) {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
  })
  vi.stubGlobal('navigator', { onLine: true })
  __setServerFetchForTest(async () => new Response(JSON.stringify({ error: 'x' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/** Page ladders: a refusal ends them. */
const PAGE_READS: Record<string, () => Promise<unknown>> = {
  objectTreePage: () => pagedModelQuery.objectTreePage({ limit: 50 }),
  objectSearchPage: () => pagedModelQuery.objectSearchPage({ query: 'A', limit: 50 }),
  connectionPage: () => pagedModelQuery.connectionPage({ limit: 50 }),
  dependencyPage: () => pagedModelQuery.dependencyPage({ focusId: 'A', direction: 'incoming', limit: 50 }),
  viewerLevel: () => pagedModelQuery.viewerLevel({ parentId: null, limit: 50 }),
}
/** Point lookups: offline fallback even on a refusal. */
const POINT_READS: Record<string, () => Promise<unknown>> = {
  object: () => pagedModelQuery.object('A'),
  group: () => pagedModelQuery.group('G1'),
  lookupMany: () => pagedModelQuery.lookupMany(['A']),
  relatedDiagrams: () => pagedModelQuery.relatedDiagrams('A'),
  relatedDiagramObjectIds: () => pagedModelQuery.relatedDiagramObjectIds(['A']),
}
const READS = { ...PAGE_READS, ...POINT_READS }

beforeEach(async () => {
  const store = createMemoryKvStore()
  __setPagedStoreForTest(store)
  await buildModelIndex(store, fixture())
  const f = fixture()
  useModelStore.setState({ objects: f.objects, connections: f.connections, groups: f.groups, diagrams: [] })
})
afterEach(() => {
  __setPagedStoreForTest(null)
  __setServerFetchForTest(null)
  vi.unstubAllGlobals()
})

describe('server-first reads, per method (QA)', () => {
  for (const status of [401, 403]) {
    for (const [name, read] of Object.entries(PAGE_READS)) {
      it(`HTTP ${status}: ${name} rejects with the refusal`, async () => {
        serverAnswers(status)
        await expect(read()).rejects.toMatchObject({ status })
      })
    }
    for (const [name, read] of Object.entries(POINT_READS)) {
      it(`HTTP ${status}: ${name} keeps its offline fallback`, async () => {
        serverAnswers(status)
        await expect(read()).resolves.toBeDefined()
      })
    }
  }

  for (const status of [500, 503]) {
    for (const [name, read] of Object.entries(READS)) {
      it(`HTTP ${status}: ${name} still falls back to this device`, async () => {
        serverAnswers(status)
        await expect(read()).resolves.toBeDefined()
      })
    }
  }

  it('a transport failure (fetch rejects) still falls back on every read', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'maplespire:serverReadModel' ? 'true' : null,
    })
    vi.stubGlobal('navigator', { onLine: true })
    __setServerFetchForTest(async () => { throw new TypeError('Failed to fetch') })
    for (const [name, read] of Object.entries(READS)) {
      await expect(read(), name).resolves.toBeDefined()
    }
  })
})
