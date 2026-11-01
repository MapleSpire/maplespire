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
 * `sessionRootUrl()` is half of what `documentsWorkspaceFor` needs, and every
 * unit test of its two readers (the Spotlight server tier, the durability
 * witness) mocks it. Driven here through the REAL bridge (the
 * bridgeConnectWrite.test.ts harness): after a boot it names the root this
 * session holds, and after stopBridge it is null.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from './workspace'
import { __resetResolvedWorkspacesForTest, rememberResolvedWorkspace } from './workspaceBinding'
import { workspaceSearchParams } from '../modelQuery/workspaceParams'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    update: async () => undefined,
  }),
}))

function workspace() {
  const repo = repoModule.repo
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: { o1: { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } } },
    comments: {}, flows: {}, checkpoints: [],
  })
  const shard = repo.create<any>({
    diagrams: { d1: { id: 'd1', name: 'Diagram d1', type: 'container', docUrl: d1.url, objectIds: ['o1'], connectionIds: [], groupIds: [] } },
  })
  const objectShard = repo.create<any>({
    objects: {
      o1: {
        id: 'o1', type: 'container', name: 'Container o1', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        tagAssignments: {}, tagOrder: [], properties: {}, scope: 'internal', status: 'live',
      },
    },
  })
  const connectionShard = repo.create<any>({ connections: {} })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url], connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, d1 }
}

afterEach(async () => {
  const { stopBridge } = await import('./bridge')
  stopBridge()
  __resetResolvedWorkspacesForTest()
  vi.restoreAllMocks()
})

describe('sessionRootUrl', () => {
  it('names the root this session booted, and nothing once the session stops', async () => {
    const { sessionRootUrl, startBridge, stopBridge } = await import('./bridge')
    expect(sessionRootUrl()).toBeNull()
    const ws = workspace()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
    vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
      urls.map((url) => {
        if (url === ws.objectShard.url) return ws.objectShard
        if (url === ws.connectionShard.url) return ws.connectionShard
        throw new Error(`unexpected model shard url ${url}`)
      }) as any)
    vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
      if (url === ws.d1.url) return ws.d1
      throw new Error(`unexpected diagram url ${url}`)
    })
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
    await startBridge(DEFAULT_WORKSPACE_REF)
    // Guard against a void run: the boot really happened on this root.
    expect(useAutomergeStatus.getState().status).not.toBe('error')
    expect(useModelStore.getState().currentDiagramId).toBe('d1')
    expect(sessionRootUrl()).toBe(ws.root.url)

    // THE WIRE: `workspaceParams.ts` reaches this accessor only through the
    // source the bridge installs at module load. Without it every
    // `/api/model/*` read asks the alias again — the 2026-10-28 defect — and
    // the unit tests of the params, which install their own source, stay green.
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    rememberResolvedWorkspace(DEFAULT_WORKSPACE_REF, { landscapeId: DEFAULT_WORKSPACE_REF.landscapeId, versionId: 'v-booted' }, {
      from: 'root-fetch',
      rootUrl: ws.root.url,
    })
    expect(workspaceSearchParams().get('versionId')).toBe('v-booted')

    stopBridge()
    expect(sessionRootUrl()).toBeNull()
    // …and a stopped session names nothing, so the reads fall back to the ref.
    expect(workspaceSearchParams().get('versionId')).toBe(DEFAULT_WORKSPACE_REF.versionId)
  })
})
