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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'
import { createMemoryKvStore, __setWorkspaceKvBaseForTest, workspaceKvStore } from './kvStore'
import { indexAllObjects } from './modelIndex'
import {
  ensureIndexReady, isIndexReady, useIndexReady, __resetIndexReady,
} from './offlineIndex'
import type { C4Object } from '../../types'

const obj = (id: string): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})

/** Fake `/api/model/page-objects` / `page-connections`: one page, no cursor, and
 * records every request URL so the test can assert the workspace params. */
function stubPageApi(urls: string[], objects: C4Object[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    const u = new URL(url, 'http://localhost')
    const isObjects = u.pathname === '/api/model/page-objects'
    return new Response(
      JSON.stringify({
        objects: isObjects ? objects : undefined,
        connections: isObjects ? undefined : [],
        nextCursor: null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }))
}

beforeEach(() => {
  useModelStore.setState({ groups: [], diagrams: [] })
  __resetIndexReady()
  // In-memory base (the test env is node, with no IndexedDB) — a FRESH Map every
  // test, so "warm index" tests don't leak state across cases.
  __setWorkspaceKvBaseForTest(createMemoryKvStore())
})
afterEach(() => {
  vi.unstubAllGlobals()
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  __resetIndexReady()
  __setWorkspaceKvBaseForTest(null)
})

describe('offlineIndex — readiness and the paging index are namespaced per workspace', () => {
  it('two different workspaces get disjoint index storage and independent ready markers', async () => {
    const urlsA: string[] = []
    setActiveWorkspaceRef({ landscapeId: 'ls-A', versionId: 'v-1' })
    stubPageApi(urlsA, [obj('a1'), obj('a2')])
    await ensureIndexReady()
    expect(isIndexReady()).toBe(true)
    expect((await indexAllObjects(workspaceKvStore())).map((o) => o.id).sort()).toEqual(['a1', 'a2'])
    // Every page request for workspace A carried A's ids.
    for (const url of urlsA) {
      const q = new URL(url, 'http://localhost').searchParams
      expect(q.get('landscapeId')).toBe('ls-A')
      expect(q.get('versionId')).toBe('v-1')
    }

    // Switch to workspace B: readiness must NOT carry over.
    const urlsB: string[] = []
    setActiveWorkspaceRef({ landscapeId: 'ls-B', versionId: 'v-1' })
    expect(isIndexReady()).toBe(false)
    stubPageApi(urlsB, [obj('b1')])
    await ensureIndexReady()
    expect(isIndexReady()).toBe(true)
    expect((await indexAllObjects(workspaceKvStore())).map((o) => o.id)).toEqual(['b1'])
    for (const url of urlsB) {
      const q = new URL(url, 'http://localhost').searchParams
      expect(q.get('landscapeId')).toBe('ls-B')
    }

    // Switching BACK to A: still ready (A's build wasn't wiped by B's), and A's
    // index still holds exactly A's objects (no cross-contamination).
    setActiveWorkspaceRef({ landscapeId: 'ls-A', versionId: 'v-1' })
    expect(isIndexReady()).toBe(true)
    expect((await indexAllObjects(workspaceKvStore())).map((o) => o.id).sort()).toEqual(['a1', 'a2'])
  })

  it('isIndexReady() answers for the ACTIVE workspace only — a fresh unbuilt workspace is never ready', async () => {
    setActiveWorkspaceRef({ landscapeId: 'built', versionId: 'v1' })
    stubPageApi([], [obj('x')])
    await ensureIndexReady()
    expect(isIndexReady()).toBe(true)

    setActiveWorkspaceRef({ landscapeId: 'never-built', versionId: 'v1' })
    expect(isIndexReady()).toBe(false)
  })

  it('useIndexReady façade tracks the ACTIVE workspace', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v1' })
    expect(useIndexReady.getState().ready).toBe(false)
    stubPageApi([], [obj('x')])
    await ensureIndexReady()
    expect(useIndexReady.getState().ready).toBe(true)
    expect(useIndexReady.getState().source).toBe('server')

    setActiveWorkspaceRef({ landscapeId: 'ls-2', versionId: 'v1' })
    expect(useIndexReady.getState().ready).toBe(false)
  })

  it('a warm (previously-built) index for a workspace is reused without re-fetching', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-warm', versionId: 'v1' })
    const urls: string[] = []
    stubPageApi(urls, [obj('x')])
    await ensureIndexReady()
    expect(urls.length).toBeGreaterThan(0)

    // Simulate a fresh session: reset the in-memory ready map (but NOT the
    // underlying namespaced store, which is where "warm" persistence lives) and
    // re-run ensureIndexReady — it should find the BUILT_KEY marker and skip
    // assembleFromServer entirely (no new fetch calls).
    __resetIndexReady()
    const urlsAfterWarm: string[] = []
    stubPageApi(urlsAfterWarm)
    await ensureIndexReady()
    expect(isIndexReady()).toBe(true)
    expect(useIndexReady.getState().source).toBe('warm')
    expect(urlsAfterWarm.length).toBe(0)
  })

  it('single-flights concurrent ensureIndexReady() calls for the SAME workspace', async () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-sf', versionId: 'v1' })
    const urls: string[] = []
    stubPageApi(urls, [obj('x')])
    const [a, b] = await Promise.all([ensureIndexReady(), ensureIndexReady()])
    expect(a).toBe(undefined)
    expect(b).toBe(undefined)
    // page-objects + page-connections = 2 calls, not 4 (a second concurrent call
    // joined the same in-flight build rather than starting a duplicate).
    expect(urls.length).toBe(2)
  })
})
