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

import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Connection, Group } from '../types'
import type {
  ModelCacheViewerLevel,
  ModelReadCacheCommandInput,
  ModelReadCacheResponse,
} from '../lib/modelQuery/modelReadCacheProtocol'
import {
  MODEL_CACHE_STORES,
  MODEL_READ_CACHE_DB,
  ROOT_PARENT_KEY,
  type CachedConnectionInput,
  type CachedModelEntityInput,
} from '../lib/modelQuery/idbSchema'
import fixture from '../../server/src/readModel/viewerLevelParity.fixture.json'

/** The Model Viewer level served by the offline read-cache worker — the REAL
 * worker module, driven through its message protocol over an in-memory
 * IndexedDB. The server asserts the same levels from the same fixture
 * (server/src/readModel/viewerLevel.integration.test.ts). The worker used to
 * scan the explorer's group-first tree: offline, a container inside a boundary
 * group vanished from its system's level and the system showed no expand
 * affordance. */

interface FixtureObject { id: string; name: string; type: string; parentId?: string }
interface FixtureGroup { id: string; name: string; objectIds: string[] }

const WORKSPACE = 'ls-viewer:v1'
const GENERATION = 3

let nextId = 1
let responses = new Map<number, (response: ModelReadCacheResponse) => void>()
let workerScope: { onmessage: ((event: { data: unknown }) => void) | null }

async function loadWorker(): Promise<void> {
  vi.resetModules()
  responses = new Map()
  const scope = globalThis as unknown as {
    onmessage: ((event: { data: unknown }) => void) | null
    postMessage: (message: ModelReadCacheResponse) => void
  }
  scope.postMessage = (message) => {
    responses.get(message.id)?.(message)
    responses.delete(message.id)
  }
  await import('./modelReadCache.worker')
  workerScope = scope
}

function send<T>(command: ModelReadCacheCommandInput): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    responses.set(id, (response) => (response.ok ? resolve(response.result as T) : reject(new Error(response.error))))
    workerScope.onmessage!({ data: { ...command, id } })
  })
}

/** `c4Parent` undefined = a row from a feed without `c4ParentId` (an older
 * server, the explorer working set). */
function entity(object: FixtureObject, explorerParent: string | null, c4Parent?: string | null): CachedModelEntityInput {
  return {
    id: object.id,
    kind: 'object',
    name: object.name,
    type: object.type,
    parentId: explorerParent,
    ...(c4Parent !== undefined ? { c4ParentId: c4Parent } : {}),
    childCount: 0,
    searchText: object.name,
    payload: object as unknown as C4Object,
  }
}

function groupEntity(group: FixtureGroup): CachedModelEntityInput {
  return {
    id: group.id,
    kind: 'group',
    name: group.name,
    type: 'group',
    parentId: null,
    childCount: group.objectIds.length,
    searchText: group.name,
    payload: group as unknown as Group,
  }
}

function connectionEntity(connection: Connection): CachedConnectionInput {
  return { connection, fromName: connection.fromId, toName: connection.toId, diagramCount: 0, flowCount: 0 }
}

async function seed(
  objects: FixtureObject[],
  groups: FixtureGroup[],
  connections: Connection[],
  explorerParents: Record<string, string | null>,
  c4Parents?: Record<string, string | null>,
): Promise<void> {
  await send({ op: 'activateGeneration', workspaceKey: WORKSPACE, generation: GENERATION, serverGeneration: GENERATION, coverage: 'full' })
  await send({
    op: 'upsertObjects',
    workspaceKey: WORKSPACE,
    generation: GENERATION,
    items: [
      ...groups.map(groupEntity),
      ...objects.map((object) => entity(object, explorerParents[object.id] ?? null, c4Parents ? c4Parents[object.id] ?? null : undefined)),
    ],
  })
  await send({ op: 'upsertConnections', workspaceKey: WORKSPACE, generation: GENERATION, items: connections.map(connectionEntity) })
}

function level(parentId: string | null, extra: { limit?: number; after?: string | null; query?: string } = {}) {
  return send<ModelCacheViewerLevel>({
    op: 'queryViewerLevel',
    workspaceKey: WORKSPACE,
    parentId,
    limit: extra.limit ?? 200,
    connectionLimit: 1_000,
    after: extra.after ?? null,
    ...(extra.query !== undefined ? { query: extra.query } : {}),
  })
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  globalThis.IDBKeyRange = FakeIDBKeyRange
  await loadWorker()
})

afterEach(() => {
  vi.resetModules()
})

describe('offline worker Model Viewer level — parity with the server', () => {
  beforeEach(async () => {
    await seed(
      fixture.objects as FixtureObject[],
      fixture.groups as FixtureGroup[],
      fixture.connections as Connection[],
      fixture.explorerParents as Record<string, string | null>,
      fixture.c4Parents as Record<string, string | null>,
    )
  })

  for (const expected of fixture.levels) {
    it(`level ${expected.parentId ?? '(root)'}`, async () => {
      const page = await level(expected.parentId)
      expect(page.objects.map((record) => ({ id: record.id, expands: record.childCount > 0 })))
        .toEqual(expected.objects)
      expect(page.totalObjects).toBe(expected.totalObjects)
      expect(page.ancestors.map((record) => record.id)).toEqual(expected.ancestors)
      expect(page.connections.map((record) => record.id).sort()).toEqual(expected.connections)
    })
  }

  for (const expected of fixture.pages) {
    it(`pages level ${expected.parentId ?? '(root)'} by ${expected.limit}`, async () => {
      const pages: string[][] = []
      let after: string | null = null
      for (let index = 0; index < expected.pages.length + 1; index += 1) {
        const page: ModelCacheViewerLevel = await level(expected.parentId, { limit: expected.limit, after })
        pages.push(page.objects.map((record) => record.id))
        expect(page.totalObjects).toBe(expected.pages.flat().length)
        after = page.nextCursor
        if (!after) break
      }
      expect(pages).toEqual(expected.pages)
    })
  }

  it('filters within a C4 level, a grouped object included', async () => {
    const page = await level('sys', { query: 'app1' })
    expect(page.objects.map((record) => record.id)).toEqual(['app1'])
    expect(page.totalObjects).toBe(1)
  })

  it('a parent deleted on the server: the republished children move to the root, grouped or not', async () => {
    // What the change feed delivers when sys goes (pinned server-side in
    // viewerLevel.integration.test.ts): a tombstone for sys, and app1/app2
    // republished with c4ParentId null. app1 stays in its boundary group.
    const [app1, app2] = ['app1', 'app2'].map((id) => fixture.objects.find((o) => o.id === id) as FixtureObject)
    await send({ op: 'deleteEntities', workspaceKey: WORKSPACE, objectIds: ['sys'] })
    await send({
      op: 'upsertObjects', workspaceKey: WORKSPACE, generation: GENERATION,
      items: [entity(app1, 'boundary', null), entity(app2, null, null)],
    })
    const root = await level(null)
    expect(root.objects.map((record) => record.id)).toEqual(['actor', 'app1', 'app2', 'ghost', 'hub', 'orphan', 'vault'])
    expect(root.totalObjects).toBe(7)
    const app1Level = await level('app1')
    expect(app1Level.ancestors.map((record) => record.id)).toEqual(['app1'])
  })
})

describe('offline worker Model Viewer level — explorer working-set rows', () => {
  // src/lib/modelQuery/server.ts cacheExplorerWorkingSet builds the payload
  // from an explorer row: its parentId is the EXPLORER parent (the group, for a
  // grouped object). The row's c4ParentId must win over that payload.
  it('files a grouped object on its C4 level, not under its group', async () => {
    await send({ op: 'activateGeneration', workspaceKey: WORKSPACE, generation: GENERATION, serverGeneration: GENERATION, coverage: 'working-set' })
    const row = (id: string, name: string, explorerParent: string | null, c4Parent: string | null): CachedModelEntityInput => ({
      id, kind: 'object', name, type: 'app', parentId: explorerParent, c4ParentId: c4Parent, childCount: 0, searchText: name,
      payload: { id, name, type: 'app', ...(explorerParent ? { parentId: explorerParent } : {}) } as unknown as C4Object,
    })
    await send({
      op: 'upsertObjects', workspaceKey: WORKSPACE, generation: GENERATION,
      items: [
        groupEntity({ id: 'boundary', name: 'System1', objectIds: ['app1'] }),
        row('sys', 'System1', null, null),
        row('app1', 'app1', 'boundary', 'sys'),
      ],
    })
    expect((await level('sys')).objects.map((record) => record.id)).toEqual(['app1'])
    expect((await level(null)).objects.map((record) => ({ id: record.id, expands: record.childCount > 0 })))
      .toEqual([{ id: 'sys', expands: true }])
    expect((await level('boundary')).objects).toEqual([])
  })
})

describe('offline worker Model Viewer level — rows without c4ParentId (older feed)', () => {
  // Rows an older server or the explorer working set wrote carry no
  // c4ParentId; the worker then reads the payload's parent, and the explorer
  // parent (the server's dangling repair) puts a dangling one at the root.
  // Resident.ts and levels.ts read a dangling parent as a root too.
  it('lists an object whose C4 parent does not exist at the root, in name order, without duplicates', async () => {
    await seed(
      [
        { id: 'b', name: 'Beta', type: 'system' },
        { id: 'orphan', name: 'Alpha', type: 'app', parentId: 'deleted' },
        { id: 'c', name: 'Gamma', type: 'app', parentId: 'b' },
      ],
      [],
      [],
      { b: null, orphan: null, c: 'b' },
    )
    const root = await level(null)
    expect(root.objects.map((record) => record.id)).toEqual(['orphan', 'b'])
    expect(root.totalObjects).toBe(2)
    const first = await level(null, { limit: 1 })
    const second = await level(null, { limit: 1, after: first.nextCursor })
    expect([first.objects.map((r) => r.id), second.objects.map((r) => r.id)]).toEqual([['orphan'], ['b']])
    expect(second.nextCursor).toBeNull()
    const orphanLevel = await level('orphan')
    expect(orphanLevel.ancestors.map((record) => record.id)).toEqual(['orphan'])
  })
})

describe('offline worker Model Viewer level — schema upgrade', () => {
  it('a version-7 cache keeps its rows and serves the C4 level, in name order, after the upgrade', async () => {
    // The cache exactly as the version-7 schema created it (every store and
    // index of the 430be165 fresh-create path), holding rows the v7 worker
    // wrote. Under sys: app1 sits in a boundary group; z1 is named "Alpha" and
    // a9 "Zeta", so an index ordered by id instead of name pages them wrongly.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(MODEL_READ_CACHE_DB, 7)
      open.onupgradeneeded = () => {
        const db = open.result
        const meta = db.createObjectStore(MODEL_CACHE_STORES.workspaceMeta, { keyPath: 'workspaceKey' })
        meta.createIndex('byLastAccess', 'lastAccessAt')
        meta.createIndex('byPinnedLastAccess', ['pinned', 'lastAccessAt'])
        const objects = db.createObjectStore(MODEL_CACHE_STORES.objects, { keyPath: ['workspaceKey', 'generation', 'id'] })
        objects.createIndex('byParent', ['workspaceKey', 'generation', 'parentKey', 'normalizedName', 'id'])
        objects.createIndex('byName', ['workspaceKey', 'generation', 'normalizedName', 'id'])
        objects.createIndex('byType', ['workspaceKey', 'generation', 'type', 'normalizedName', 'id'])
        objects.createIndex('byModelParent', ['workspaceKey', 'generation', 'modelParentKey', 'id'])
        objects.createIndex('bySearchTrigram', 'searchTrigramKeys', { multiEntry: true })
        const connections = db.createObjectStore(MODEL_CACHE_STORES.connections, { keyPath: ['workspaceKey', 'generation', 'id'] })
        connections.createIndex('byFrom', ['workspaceKey', 'generation', 'fromId', 'id'])
        connections.createIndex('byTo', ['workspaceKey', 'generation', 'toId', 'id'])
        connections.createIndex('byLabel', ['workspaceKey', 'generation', 'normalizedLabel', 'id'])
        connections.createIndex('byName', ['workspaceKey', 'generation', 'normalizedLabel', 'id'])
        connections.createIndex('bySender', ['workspaceKey', 'generation', 'normalizedFromName', 'id'])
        connections.createIndex('byReceiver', ['workspaceKey', 'generation', 'normalizedToName', 'id'])
        connections.createIndex('byDiagrams', ['workspaceKey', 'generation', 'diagramCount', 'id'])
        connections.createIndex('byFlows', ['workspaceKey', 'generation', 'flowCount', 'id'])
        const membership = db.createObjectStore(MODEL_CACHE_STORES.diagramMembership, { keyPath: ['workspaceKey', 'generation', 'diagramId', 'entityId'] })
        membership.createIndex('byEntity', ['workspaceKey', 'generation', 'entityId', 'diagramId'])
        db.createObjectStore(MODEL_CACHE_STORES.diagramRenders, { keyPath: ['workspaceKey', 'diagramId', 'generation'] })
        const postings = db.createObjectStore(MODEL_CACHE_STORES.searchPostings, { keyPath: ['workspaceKey', 'generation', 'trigram', 'entityId'] })
        postings.createIndex('byEntity', ['workspaceKey', 'generation', 'entityId', 'trigram'])
        postings.createIndex('byTrigramName', ['workspaceKey', 'generation', 'trigram', 'normalizedName', 'entityId'])
        const mutations = db.createObjectStore(MODEL_CACHE_STORES.localMutations, { keyPath: ['workspaceKey', 'mutationId'] })
        mutations.createIndex('byWorkspaceState', ['workspaceKey', 'state', 'createdAt'])
        db.createObjectStore(MODEL_CACHE_STORES.syncState, { keyPath: 'workspaceKey' })

        const base = { workspaceKey: WORKSPACE, generation: GENERATION, childCount: 0, searchTrigramKeys: [], accountedBytes: 1, normalizedSearchText: '' }
        const row = (id: string, kind: 'object' | 'group', name: string, parentKey: string, modelParentKey: string) => ({
          ...base, id, kind, name, type: kind === 'group' ? 'group' : 'app',
          parentId: parentKey === ROOT_PARENT_KEY ? null : parentKey, parentKey, modelParentKey,
          normalizedName: name.toLowerCase(),
          payload: { id, name, ...(modelParentKey !== ROOT_PARENT_KEY ? { parentId: modelParentKey } : {}) },
        })
        objects.put(row('sys', 'object', 'System1', ROOT_PARENT_KEY, ROOT_PARENT_KEY))
        objects.put(row('boundary', 'group', 'System1', ROOT_PARENT_KEY, ROOT_PARENT_KEY))
        objects.put(row('app1', 'object', 'app1', 'boundary', 'sys'))
        objects.put(row('z1', 'object', 'Alpha', 'sys', 'sys'))
        objects.put(row('a9', 'object', 'Zeta', 'sys', 'sys'))
        meta.put({ workspaceKey: WORKSPACE, activeGeneration: GENERATION, serverGeneration: GENERATION, coverage: 'full', pinned: false, lastAccessAt: 1, objectCount: 5, connectionCount: 0, accountedBytes: {}, generationStats: {} })
      }
      open.onsuccess = () => { open.result.close(); resolve() }
      open.onerror = () => reject(open.error)
    })

    const system = await level('sys')
    expect(system.objects.map((record) => ({ id: record.id, expands: record.childCount > 0 })))
      .toEqual([{ id: 'z1', expands: false }, { id: 'app1', expands: false }, { id: 'a9', expands: false }])
    const pages: string[][] = []
    let after: string | null = null
    for (let index = 0; index < 4; index += 1) {
      const page: ModelCacheViewerLevel = await level('sys', { limit: 1, after })
      pages.push(page.objects.map((record) => record.id))
      after = page.nextCursor
      if (!after) break
    }
    expect(pages).toEqual([['z1'], ['app1'], ['a9']])
    const root = await level(null)
    expect(root.objects.map((record) => ({ id: record.id, expands: record.childCount > 0 })))
      .toEqual([{ id: 'sys', expands: true }])
  })
})

describe('offline worker Model Viewer level — cancellation', () => {
  // What this does NOT cover: the double-abort guard in queryViewerLevel.
  // fake-indexeddb never delivers a queued success event after abort(), so
  // removing the guard leaves this test green (measured); it pins the cancel
  // contract — nothing posted, nothing uncaught, the worker still serves.
  it('a cancelled root level, scanned by two cursors, settles as cancelled without an uncaught error', async () => {
    await seed(
      fixture.objects as FixtureObject[],
      fixture.groups as FixtureGroup[],
      fixture.connections as Connection[],
      fixture.explorerParents as Record<string, string | null>,
      fixture.c4Parents as Record<string, string | null>,
    )
    const id = nextId++
    const answered = new Promise<ModelReadCacheResponse | 'none'>((resolve) => {
      responses.set(id, resolve)
      setTimeout(() => resolve('none'), 200)
    })
    const uncaught: unknown[] = []
    const onError = (error: unknown) => { uncaught.push(error) }
    process.on('uncaughtException', onError)
    try {
      workerScope.onmessage!({ data: { op: 'queryViewerLevel', workspaceKey: WORKSPACE, parentId: null, limit: 200, connectionLimit: 1_000, id } })
      workerScope.onmessage!({ data: { op: 'cancel', id: nextId++, targetId: id } })
      // a cancelled request posts nothing back
      expect(await answered).toBe('none')
      // ... and the worker still serves the next request
      expect((await level(null)).objects.map((record) => record.id))
        .toEqual(fixture.levels[0].objects.map((object) => object.id))
    } finally {
      process.off('uncaughtException', onError)
    }
    expect(uncaught).toEqual([])
  })
})

