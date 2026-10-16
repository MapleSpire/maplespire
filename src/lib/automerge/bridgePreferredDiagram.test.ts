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
 * Defect 2026-10-16: creating a Draft from "FoodDash - Containers" landed the
 * canvas on "Order Service - Components" — the switch into the Draft parked no
 * diagram, so the boot took its default pick. Merging back did the same.
 *
 * The fix parks the diagram being viewed as a PREFERENCE. These tests pin the
 * boot's side of that contract on the resident path (the bridgeBootFallback
 * pattern: repo-module seams spied, the rest of startBridge real):
 *  - a preferred diagram the version has is opened;
 *  - a preferred diagram the version lacks (made in the Draft, never merged)
 *    falls back to the default pick instead of stranding the user on
 *    not-found;
 *  - a REQUESTED diagram (a deep link) the version lacks still stays parked —
 *    not-found is the honest answer to "open this diagram".
 */

// @vitest-environment jsdom
// jsdom: the success path runs wireConnectionStatus(), which needs `window`.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
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

function fakeHandle<T>(documentId: string, doc: T) {
  return {
    documentId,
    url: `automerge:${documentId}`,
    doc: () => doc,
    on: vi.fn(),
    off: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  } as any
}

/** Two diagrams: `d1` has content, so it is the default pick; `d2` is blank.
 * docUrl is empty so the open takes the doc-less classic branch. */
function workspaceFakes() {
  const rootHandle = fakeHandle('root', {
    modelUrl: 'automerge:model',
    shardUrls: ['automerge:shard'],
  })
  const modelHandle = fakeHandle('model', {
    objects: {
      o1: {
        id: 'o1', type: 'system', name: 'System',
        position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        tagAssignments: {}, tagOrder: [], properties: {},
        scope: 'internal', status: 'live',
      },
    },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shardHandle = fakeHandle('shard', {
    diagrams: {
      d1: {
        id: 'd1', name: 'Default diagram', type: 'context', docUrl: '',
        objectIds: ['o1'], connectionIds: [], groupIds: [],
      },
      d2: {
        id: 'd2', name: 'The one being viewed', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      },
    },
  })
  return { rootHandle, modelHandle, shardHandle }
}

async function bootParked(parked: string, prefer: boolean): Promise<string | null> {
  const { preferInitialDiagram, startBridge } = await import('./bridge')
  // What switchWorkspace's loadWorkspace does: park, then mark it a preference
  // (or not), then boot.
  useModelStore.setState({ currentDiagramId: parked })
  preferInitialDiagram(prefer ? parked : null)
  await startBridge(DEFAULT_WORKSPACE_REF)
  return useModelStore.getState().currentDiagramId
}

describe('the boot honours a preferred diagram only when the version has it', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle, modelHandle, shardHandle } = workspaceFakes()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
  })

  afterEach(async () => {
    const { stopBridge, preferInitialDiagram } = await import('./bridge')
    stopBridge()
    preferInitialDiagram(null)
    vi.restoreAllMocks()
  })

  it('control: with nothing parked the boot opens the default diagram', async () => {
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe('d1')
  })

  it('a preferred diagram the version has is the one opened, not the default', async () => {
    expect(await bootParked('d2', true)).toBe('d2')
    expect(useAutomergeStatus.getState().status).not.toBe('error')
  })

  it('a preferred diagram the version lacks falls back to the default pick', async () => {
    expect(await bootParked('made-in-the-draft', true)).toBe('d1')
  })

  it('a REQUESTED (deep-linked) diagram the version lacks stays parked — not-found is honest there', async () => {
    expect(await bootParked('made-in-the-draft', false)).toBe('made-in-the-draft')
  })

  it('the preference is consumed by one boot and does not leak into the next', async () => {
    const { stopBridge, startBridge, preferInitialDiagram } = await import('./bridge')
    expect(await bootParked('made-in-the-draft', true)).toBe('d1')
    stopBridge()
    // A later deep link to the same missing id is a request, not a preference.
    useModelStore.setState({ currentDiagramId: 'made-in-the-draft' })
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe('made-in-the-draft')
    preferInitialDiagram(null)
  })
})
