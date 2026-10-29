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
 * Measured 2026-10-18 (e2e/diagram-duplicate.spec.ts, then by hand): a
 * two-view DSL import into a new landscape gave EACH view two DiagramDocs, and
 * opening the second view stacked its six shapes on their model positions.
 *
 * The chain: `ensureDiagramDoc` records the new doc's url in `docUrlById`
 * while the create→flush→publish gate holds the registry meta back. A
 * registry-shard change in that window makes `projectAll` rebuild
 * `docUrlById` from the shards alone — and the new diagram is in none of them
 * yet, so its url was dropped. The next flush then created a second doc, and a
 * meta placed in the gap carried `docUrl: ''`, which the open path reads as
 * "no document" and projects as a layout-less stub.
 *
 * Driven through the REAL bridge on a sharded classic workspace (the
 * bridgeConnectWrite.test.ts harness); `repo.flush` is held so the gate stays
 * shut while a peer's shard change lands.
 */

// @vitest-environment jsdom

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

function objectEntity(id: string) {
  return {
    id, type: 'container', name: `Container ${id}`,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

const LAYOUTS = {
  o1: { position: { x: 40, y: 60 }, size: { width: 200, height: 100 } },
  o2: { position: { x: 400, y: 60 }, size: { width: 200, height: 100 } },
}

function workspace() {
  const repo = repoModule.repo
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: { o1: LAYOUTS.o1 }, comments: {}, flows: {}, checkpoints: [],
  })
  const d2 = repo.create<any>({
    name: 'Diagram d2', type: 'container', objectIds: ['o2'], connectionIds: [], groupIds: [],
    layouts: { o2: LAYOUTS.o2 }, comments: {}, flows: {}, checkpoints: [],
  })
  const meta = (id: string, docUrl: string, objectIds: string[]) =>
    ({ id, name: `Diagram ${id}`, type: 'container', docUrl, objectIds, connectionIds: [], groupIds: [] })
  const shard = repo.create<any>({ diagrams: { d1: meta('d1', d1.url, ['o1']), d2: meta('d2', d2.url, ['o2']) } })
  const objectShard = repo.create<any>({ objects: { o1: objectEntity('o1'), o2: objectEntity('o2') } })
  const connectionShard = repo.create<any>({ connections: {} })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, docs: { d1, d2 } as Record<string, any> }
}

const read = (handle: { doc(): unknown }) => handle.doc() as any

describe('a diagram doc created while its meta is gated survives a registry rebuild', () => {
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
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  /** Boot, hold every local flush, and create one laid-out non-active diagram
   * the way an import lands one. Returns with the gate SHUT on its meta. */
  async function bootAndCreate() {
    const ws = workspace()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
    vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
      urls.map((url) => (url === ws.objectShard.url ? ws.objectShard : ws.connectionShard)) as any)
    vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
      for (const handle of Object.values(ws.docs)) if (handle.url === url) return handle
      throw new Error(`unexpected diagram url ${url}`)
    })
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe('d1')
    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['d1', 'd2'])

    // Hold every local flush: the gate stays shut until released.
    const releases: Array<() => void> = []
    vi.spyOn(repoModule.repo, 'flush').mockImplementation(() =>
      new Promise<void>((resolve) => { releases.push(resolve) }))
    const created = vi.spyOn(repoModule, 'createDiagramHandle')

    // A non-active, laid-out diagram arrives the way an import lands one.
    useModelStore.getState().importModel({
      objects: [], connections: [], groups: [],
      diagrams: [{
        id: 'dNew', name: 'Imported view', type: 'container',
        objectIds: ['o1', 'o2'], connectionIds: [], groupIds: [], layouts: LAYOUTS,
      }],
    })
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    const newDoc = created.mock.results[0]!.value as any
    expect(Object.keys(read(newDoc).layouts).sort(), 'the doc is created laid out').toEqual(['o1', 'o2'])
    expect(read(ws.shard).diagrams.dNew, 'the gate holds the meta back').toBeUndefined()
    const openGate = async () => {
      for (const release of releases.splice(0)) release()
      await vi.waitFor(() => expect(read(ws.shard).diagrams.dNew?.docUrl).toBeTruthy())
      for (const release of releases.splice(0)) release()
    }
    return { ws, created, newDoc, openGate }
  }

  it('one document per new diagram, and the published meta points at it (RED: two docs / an empty docUrl)', async () => {
    const { ws, created, newDoc, openGate } = await bootAndCreate()

    // A peer's registry write inside the window: the shard listener re-projects
    // and rebuilds the id → url index from the shards.
    ws.shard.change((doc: any) => { doc.diagrams.d2.name = 'Renamed by a peer' })
    await vi.waitFor(() =>
      expect(useModelStore.getState().diagrams.find((d) => d.id === 'd2')?.name).toBe('Renamed by a peer'))

    // Any later flush in the window.
    useModelStore.getState().updateDiagram('d1', { name: 'Edited here' })
    await vi.waitFor(() => expect(read(ws.shard).diagrams.d1.name).toBe('Edited here'))
    expect(created, 'that flush minted a second document for the same diagram').toHaveBeenCalledTimes(1)

    // Open the gate (every held flush), and let the meta land.
    await openGate()

    expect(created, 'a second document for the same diagram').toHaveBeenCalledTimes(1)
    expect(read(ws.shard).diagrams.dNew.docUrl).toBe(newDoc.url)
  })

  // Both review lenses, 2026-10-18: a shard meta whose docUrl is EMPTY — the
  // very shape the defect persisted — must not count as "the shard resolves
  // it". Retiring on mere presence put '' back into the index, which
  // ensureDiagramDoc reads as "no doc" and mints again.
  it('a shard meta with an EMPTY docUrl does not retire our url (RED: a second doc)', async () => {
    const { ws, created, newDoc, openGate } = await bootAndCreate()

    ws.shard.change((doc: any) => {
      doc.diagrams.dNew = {
        id: 'dNew', name: 'Imported view', type: 'container', docUrl: '',
        objectIds: ['o1', 'o2'], connectionIds: [], groupIds: [],
      }
    })
    await vi.waitFor(() => expect(read(ws.shard).diagrams.dNew).toBeDefined())
    useModelStore.getState().updateDiagram('d1', { name: 'Edited here' })
    await vi.waitFor(() => expect(read(ws.shard).diagrams.d1.name).toBe('Edited here'))
    expect(created, 'the empty meta made the flush mint a second document').toHaveBeenCalledTimes(1)

    await openGate()
    expect(created).toHaveBeenCalledTimes(1)
    expect(read(ws.shard).diagrams.dNew.docUrl, 'the empty meta is healed with OUR doc').toBe(newDoc.url)
  })
})
