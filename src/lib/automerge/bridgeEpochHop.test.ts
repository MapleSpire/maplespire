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
 * G4-16f: the bridge's wiring of the live epoch hop and the capability,
 * driven through the REAL bridge on a sharded resident workspace (the
 * bridgeModelShardOverflow.test.ts pattern): the root repoints to a new
 * ModelMeta, the spied server answers. Among others:
 *
 *  - the hop's `holdsTargets` port reads the tab's NEW handles — no swap
 *    while one lacks a forward head the server names;
 *  - the capability listener only takes answers about THIS session's
 *    workspace;
 *  - stopping the bridge leaves no capability probe pending;
 *  - a swap accepts the meta it left as a holder of held pointers only when
 *    the new meta names it as its epoch predecessor;
 *  - the tab's actors are journaled without the capability.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { generateAutomergeUrl, ImmutableString, type DocHandle } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import * as durableSyncModule from './durableSync'
import * as controllerModule from './epochOverridesController'
import * as repoCompatModule from './repoCompat'
import * as deniedRecoveryModule from './deniedDocumentRecovery'
import * as reconcileModule from './reconcile'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { withWorkspaceParams } from '../modelQuery/workspaceParams'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { KvStore } from '../modelQuery/kvStore'
import { OVERLAY_COMPACTION_CLEAR_MESSAGE } from './overlayClearRescue'
import { undoHistory } from '../history/undoHistory'

// Three objects fill a shard (so a roll can recreate a full one in place) (read by bridge.ts at import,
// which every test does dynamically, after this line).
vi.stubEnv('VITE_MODEL_SHARD_SIZE', '3')

vi.mock('../modelQuery/kvStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modelQuery/kvStore')>()
  let store = actual.createMemoryKvStore()
  return {
    ...actual,
    workspaceKvStore: () => store,
    __resetMemoryStore: () => { store = actual.createMemoryKvStore() },
    __memoryStore: () => store,
  }
})

async function memoryStore(): Promise<KvStore> {
  return ((await import('../modelQuery/kvStore')) as any).__memoryStore()
}

function objectEntity(id: string, name = `Container ${id}`) {
  return {
    id, type: 'container', name,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

function workspace() {
  const repo = repoModule.repo
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: {}, comments: {}, flows: {}, checkpoints: [],
  })
  const shard = repo.create<any>({
    diagrams: { d1: { id: 'd1', name: 'Diagram d1', type: 'container', docUrl: d1.url, objectIds: ['o1'], connectionIds: [], groupIds: [] } },
  })
  const objectShard = repo.create<any>({ objects: { o1: objectEntity('o1') } })
  const connectionShard = repo.create<any>({ connections: {} })
  const meta = (objects: DocHandle<any>, extra: Record<string, unknown> = {}) => repo.create<any>({
    objectShardUrls: [objects.url], connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, ...extra,
  })
  // No `modelEpoch`: the workspace has not rolled yet as far as m0 says.
  const m0 = meta(objectShard)
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: m0.url })
  // The NEXT epoch: its own base shard (the roll's), its meta naming m0.
  const nextShard = repo.create<any>({ objects: { o1: objectEntity('o1') } })
  const m1 = meta(nextShard, { modelEpoch: 1, epochPredecessorRef: new ImmutableString(m0.url) })
  // ANOTHER lineage (a repair, the slim script): no predecessor ref.
  const repairShard = repo.create<any>({ objects: { o1: objectEntity('o1') } })
  const repaired = meta(repairShard)
  return { root, shard, objectShard, connectionShard, m0, m1, nextShard, repaired, repairShard, d1 }
}

type Workspace = ReturnType<typeof workspace>

/** What the fake server answers: forwarded, with these target heads. */
let targetHeads: Array<{ documentId: string; heads: string[] }>
let epochsAnswer: boolean | undefined
/** Per document, what the fake server answers instead of "a forwarded epoch
 * document" (a random-id shard it never received, one it holds as an
 * ordinary document). */
let answers: Map<string, Record<string, unknown>>

async function boot(ws: Workspace, more: {
  extra?: DocHandle<any>[]; metas?: DocHandle<any>[]; held?: DocHandle<any>[]
  /** A meta only the network gives (the background walk). */
  findMeta?: (url: string) => Promise<DocHandle<any> | undefined>
  /** The active diagram's document is given only once this resolves. */
  diagramGate?: Promise<void>
  /** The registry shards are given only once this resolves. */
  registryGate?: Promise<void>
  /** G4-16l: the boot is expected to end on `error` (resolved, not rejected). */
  allowError?: boolean
} = {}): Promise<void> {
  const known: DocHandle<any>[] = [ws.objectShard, ws.connectionShard, ws.nextShard, ws.repairShard, ...(more.extra ?? [])]
  const metas: DocHandle<any>[] = [ws.m0, ws.m1, ws.repaired, ...(more.metas ?? [])]
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  if (more.registryGate) {
    const gate = more.registryGate
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockImplementation(async () => { await gate; return [ws.shard] as any })
  } else vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockImplementation(async (url: string) => {
    const remote = await more.findMeta?.(url)
    if (remote) return remote as any
    const handle = metas.find((h) => h.url === url)
    if (!handle) throw new Error(`unexpected meta ${url}`)
    return handle as any
  })
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      const handle = known.find((h) => h.url === url)
      if (!handle) throw new Error(`unexpected model shard url ${url}`)
      return handle
    }) as any)
  vi.spyOn(repoModule, 'findHeldModelShardHandle').mockImplementation(async (url: string) => {
    const handle = (more.held ?? []).find((h) => h.url === url)
    if (!handle) throw new Error('not in this browser')
    return handle as any
  })
  if (more.diagramGate) {
    const gate = more.diagramGate
    vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async () => { await gate; return ws.d1 as any })
  } else vi.spyOn(repoModule, 'findDiagramHandle').mockResolvedValue(ws.d1 as any)
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  if (more.allowError) return
  expect(useAutomergeStatus.getState().status, String(useAutomergeStatus.getState().error)).not.toBe('error')
}

async function probe() {
  const { epochHopProbe } = await import('./bridge')
  return epochHopProbe()
}

const POLL = { timeout: 8_000, interval: 25 }

/** Whether this session holds any lease on the document (it is announced). */
const leased = (documentId: string) => repoModule.activeDocumentShare.shareConfig.announce!('peer' as any, documentId as any) as Promise<boolean>


describe('the live epoch hop, through the bridge', () => {
  let listener: ((epochs: boolean, params: string) => void) | null = null

  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    ;((await import('../modelQuery/kvStore')) as any).__resetMemoryStore()
    useModelStore.setState({ objects: [], connections: [], groups: [], diagrams: [], comments: [], flows: [], currentDiagramId: null })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    targetHeads = []
    epochsAnswer = undefined
    answers = new Map()
    listener = null
    const setListener = durableSyncModule.setEpochCapabilityListener
    vi.spyOn(durableSyncModule, 'setEpochCapabilityListener').mockImplementation((l) => { listener = l; setListener(l) })
    vi.spyOn(durableSyncModule, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) => {
      if (epochsAnswer !== undefined) listener?.(epochsAnswer, withWorkspaceParams(''))
      return documents.map(({ documentId }) => answers.get(documentId) ?? ({ documentId, durable: true, forwarded: true, targetHeads })) as any
    })
  })

  afterEach(async () => {
    const { stopBridge, __injectFaultOnceForTest, __pauseWritesAsByHopForTest } = await import('./bridge')
    // The seams first: one left armed must not fire inside the stop and
    // cascade into the rest of the file.
    __injectFaultOnceForTest(null)
    __pauseWritesAsByHopForTest(false)
    stopBridge()
    vi.restoreAllMocks()
  })

  /** A colleague's change to the object shard, merged in (the server's copy). */
  const remoteChange = (ws: Workspace, fn: (d: any) => void) => {
    const theirs = A.change(A.clone(ws.objectShard.doc()!, { actor: 'ee'.repeat(16) }), fn)
    ws.objectShard.update((d: any) => A.merge(d, theirs))
  }
  const storeObject = (id: string) => useModelStore.getState().objects.find((o) => o.id === id)
  const shardObject = (ws: Workspace, id: string) => (ws.objectShard.doc() as any).objects?.[id]

  it('an object CREATED in the store survives a shard change landing before its write — and reaches the document; owed until then', async () => {
    const ws = workspace()
    await boot(ws)
    const id = useModelStore.getState().addObject({ ...objectEntity('x'), name: 'Created just now' } as any)
    // Owed: no document holds it yet.
    expect((await probe()).residentPendingWrites).toBe(1)
    // Same tick, before the debounced write: a colleague's change re-projects.
    remoteChange(ws, (d) => { d.objects.o1.description = 'Colleague' })
    expect(storeObject(id)?.name).toBe('Created just now')
    await expect.poll(() => shardObject(ws, id)?.name, POLL).toBe('Created just now')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    expect(storeObject('o1')?.description).toBe('Colleague')
  })

  it('an EDIT keeps its own field; a colleague\'s change to ANOTHER field of the same object stands — in the store and in the document', async () => {
    const ws = workspace()
    await boot(ws)
    useModelStore.getState().updateObject('o1', { name: 'Mine' } as any)
    remoteChange(ws, (d) => { d.objects.o1.description = 'Theirs' })
    expect(storeObject('o1')).toMatchObject({ name: 'Mine', description: 'Theirs' })
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Mine')
    expect(shardObject(ws, 'o1')?.description).toBe('Theirs')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  it('a DELETE does not come back through a projection before its write', async () => {
    const ws = workspace()
    await boot(ws)
    useModelStore.getState().addObject({ ...objectEntity('y'), name: 'Kept' } as any)
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    useModelStore.getState().deleteObject('o1')
    remoteChange(ws, (d) => { d.objects.o1.description = 'Theirs, concurrent' })
    expect(storeObject('o1')).toBeUndefined()
    await expect.poll(() => shardObject(ws, 'o1'), POLL).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(storeObject('o1')).toBeUndefined()
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  for (const remote of [false, true]) {
    it(`an edit made while the boot still awaits the active diagram is written${remote ? ' — through a colleague\'s change landing before the boot ends' : ''}`, async () => {
      const ws = workspace()
      let release!: () => void
      const diagramGate = new Promise<void>((resolve) => { release = resolve })
      const booting = boot(ws, { diagramGate })
      // The store is projected (the editor shows it) while the boot waits.
      await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
      // The edit alone (an edit and a creation would share a shard, and the
      // creation alone would make that shard's slice differ from its baseline).
      useModelStore.getState().updateObject('o1', { name: 'Paul, online, during the boot' } as any)
      const created = remote ? useModelStore.getState().addObject({ ...objectEntity('w'), name: 'Created during the boot' } as any) : null
      // Owed: never "Synced" over it.
      expect((await probe()).residentPendingWrites).toBe(remote ? 2 : 1)
      if (remote) {
        remoteChange(ws, (d) => { d.objects.o1.description = 'Colleague' })
        expect(storeObject('o1')).toMatchObject({ name: 'Paul, online, during the boot', description: 'Colleague' })
      }
      release()
      await booting
      await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Paul, online, during the boot')
      if (created) await expect.poll(() => shardObject(ws, created)?.name, POLL).toBe('Created during the boot')
      await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
      if (remote) expect(shardObject(ws, 'o1')?.description).toBe('Colleague')
    })
  }

  it('a stop while the boot still runs (a workspace switch, a remount) writes the edit made in that window — the lifecycle flush reads the resident debt', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    useModelStore.getState().updateObject('o1', { name: 'Renamed, then the tab switched away' } as any)
    expect((await probe()).residentPendingWrites).toBe(1)
    const { stopBridge } = await import('./bridge')
    stopBridge()
    expect(shardObject(ws, 'o1')?.name).toBe('Renamed, then the tab switched away')
    release()
    await booting
  })

  it('an edit made while the boot still runs reaches its document BEFORE the boot ends — a boot that stalls (offline) holds nothing back', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    useModelStore.getState().updateObject('o1', { name: 'Written while the boot waits' } as any)
    // The boot is still waiting for the active diagram.
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Written while the boot waits')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    release()
    await booting
    expect(shardObject(ws, 'o1')?.name).toBe('Written while the boot waits')
  })

  it('the boot-window write reconciles only the shard her edit touched, and leaves the meta alone', async () => {
    const ws = workspace()
    // A second object shard the boot projects too.
    const other = repoModule.repo.create<any>({ objects: { o2: objectEntity('o2'), o3: objectEntity('o3') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(other.url) })
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { extra: [other], diagramGate })
    await expect.poll(() => storeObject('o2')?.name, POLL).toBe('Container o2')
    const metaHeads = A.getHeads(ws.m0.doc()!)
    const plans = vi.spyOn(reconcileModule, 'planCollectionReconcile')
    useModelStore.getState().updateObject('o1', { name: 'Only this shard' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Only this shard')
    // One planned bucket: o1's shard. Every bucket before the baselines were seeded.
    expect(plans.mock.calls.length).toBe(1)
    expect(A.getHeads(ws.m0.doc()!)).toEqual(metaHeads)
    release()
    await booting
    // The subscription replays her edit alone: its flush
    // plans o1's shard again, never the shard she did not touch.
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const planned = new Set(plans.mock.calls.map(([materialized]) => Object.keys(materialized as object).sort().join(',')))
    expect([...planned]).toEqual(['o1'])
  })

  it('a boot superseded while it awaited the active diagram neither stops nor takes the next boot\'s edit watch', async () => {
    const ws = workspace()
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const bootA = boot(ws, { diagramGate: gateA }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    const { stopBridge } = await import('./bridge')
    stopBridge()
    // Boot B: its own gate, its own watch.
    let releaseB!: () => void
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    const bootB = boot(ws, { diagramGate: gateB })
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(1)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    // An edit in B's window, then A resumes at once (before B's 50 ms write).
    useModelStore.getState().updateObject('o1', { name: 'Edited in the second boot' } as any)
    releaseA()
    await bootA
    expect((await probe()).residentPendingWrites).toBe(1)
    releaseB()
    await bootB
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Edited in the second boot')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  it('no boot-window write while the store is not yet the projection of the loaded shards — tried again, and written once it is', async () => {
    const ws = workspace()
    await boot(ws)
    const { stopBridge } = await import('./bridge')
    stopBridge()
    // While no session runs, a colleague adds o2 to the shard.
    const theirs = A.change(A.clone(ws.objectShard.doc()!, { actor: 'ee'.repeat(16) }), (d: any) => { d.objects.o2 = objectEntity('o2', 'Colleague') })
    ws.objectShard.update((d: any) => A.merge(d, theirs))
    // The next boot holds at the placement journal's read — after the model is
    // sharded, before it is projected: the store still shows the last session.
    const store = await memoryStore()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const get = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementation(async (key: string) => {
      if (key === 'pending-placement-intents:v1') await readGate
      return get(key) as never
    })
    let releaseDiagram!: () => void
    const diagramGate = new Promise<void>((resolve) => { releaseDiagram = resolve })
    const booting = boot(ws, { diagramGate })
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(storeObject('o2')).toBeUndefined()
    useModelStore.getState().updateObject('o1', { name: 'Edited on the stale store' } as any)
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Nothing written from the stale store: the colleague's object stays.
    expect(shardObject(ws, 'o2')?.name).toBe('Colleague')
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    // Projected: the boot-window write runs again, before the boot ends.
    releaseRead()
    await expect.poll(() => storeObject('o2')?.name, POLL).toBe('Colleague')
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Edited on the stale store')
    expect(shardObject(ws, 'o2')?.name).toBe('Colleague')
    releaseDiagram()
    await booting
  })

  it('an entity edited here and deleted remotely is released when its grace ENDS, in a quiet workspace — the badge says "Synced" again', async () => {
    const { __setAbsentDeleteGraceMsForTest } = await import('./residentPendingWrites')
    __setAbsentDeleteGraceMsForTest(300)
    try {
      const ws = workspace()
      await boot(ws)
      await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
      useModelStore.getState().updateObject('o1', { name: 'Mine, then deleted by a colleague' } as any)
      // Before her write: a colleague deletes it.
      remoteChange(ws, (d) => { delete d.objects.o1 })
      expect(storeObject('o1')).toBeUndefined()
      expect((await probe()).residentPendingWrites).toBe(1)
      // Then nothing at all happens in the workspace.
      await expect.poll(async () => (await probe()).residentPendingWrites, { timeout: 3_000, interval: 50 }).toBe(0)
      await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
      expect(shardObject(ws, 'o1')).toBeUndefined()
      expect(storeObject('o1')).toBeUndefined()
    } finally {
      __setAbsentDeleteGraceMsForTest(null)
    }
  })

  it('a boot that FAILS after an edit in its window writes the edit before it cleans up', async () => {
    const ws = workspace()
    let fail!: () => void
    const failure = new Promise<void>((_, reject) => { fail = () => reject(new Error('the active diagram could not be resolved')) })
    failure.catch(() => undefined)
    const booting = boot(ws, { diagramGate: failure }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    useModelStore.getState().updateObject('o1', { name: 'Edited, then the boot failed' } as any)
    // The failure lands before the 50 ms boot write.
    fail()
    await booting
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('error')
    expect(shardObject(ws, 'o1')?.name).toBe('Edited, then the boot failed')
  })

  it('a window write already ran (baselines seeded), a SECOND window edit, then the boot fails before its 50 ms write — the second edit is written', async () => {
    const ws = workspace()
    let fail!: () => void
    const failure = new Promise<void>((_, reject) => { fail = () => reject(new Error('the active diagram could not be resolved')) })
    failure.catch(() => undefined)
    const booting = boot(ws, { diagramGate: failure }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    useModelStore.getState().updateObject('o1', { name: 'First window edit' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('First window edit')
    useModelStore.getState().updateObject('o1', { name: 'Second window edit' } as any)
    fail()
    await booting
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('error')
    expect(shardObject(ws, 'o1')?.name).toBe('Second window edit')
  })

  it('a boot that fails AFTER its subscription replayed a window edit keeps that edit — the failed boot\'s write does not re-seed the baselines from a store holding it', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    // One throw in the boot's tail, after the subscription (inside its try).
    let thrown = false
    const original = useAutomergeStatus.getState().setBootFallbackActive
    useAutomergeStatus.setState({
      setBootFallbackActive: (active: boolean) => {
        if (!thrown) { thrown = true; throw new Error('the boot tail throws') }
        return original(active)
      },
    } as any)
    try {
      useModelStore.getState().updateObject('o1', { name: 'Window edit, then the tail threw' } as any)
      // Released before the 50 ms boot write: the subscription replays it.
      release()
      await booting
      expect(thrown).toBe(true)
      await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Window edit, then the tail threw')
      await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    } finally {
      useAutomergeStatus.setState({ setBootFallbackActive: original } as any)
    }
  })

  it('past the window, the failed boot does not write over a contract latched stale — the flush\'s freeze holds', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    // In the boot's tail (after the subscription and the root listener): the
    // workspace is promoted to the server-registry contract, then the tail throws.
    let thrown = false
    const original = useAutomergeStatus.getState().setBootFallbackActive
    useAutomergeStatus.setState({
      setBootFallbackActive: (active: boolean) => {
        if (!thrown) {
          thrown = true
          ws.root.change((d: any) => { d.registrySummaryOnly = true })
          throw new Error('the boot tail throws')
        }
        return original(active)
      },
    } as any)
    try {
      useModelStore.getState().updateObject('o1', { name: 'Not over a stale contract' } as any)
      release()
      await booting
      expect(thrown).toBe(true)
      expect(useAutomergeStatus.getState().workspaceContractStale).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    } finally {
      useAutomergeStatus.setState({ setBootFallbackActive: original } as any)
    }
  })

  // ── G4-16l: the resident debt driver, owned by the session ────────────────
  // G4-16l tests 1-7; test 8 is in `residentDebtDriver.test.ts`.

  it('G4-16l: the test seams are inert by default — no fault armed, writes not paused, a plain edit written', async () => {
    const bridge = await import('./bridge')
    expect(bridge.__armedFaultsForTest()).toEqual([])
    const ws = workspace()
    await boot(ws)
    expect(bridge.__armedFaultsForTest()).toEqual([])
    // A booted session: the driver lives, and its listener has handed over to
    // the session's own (one lifecycle owner at a time).
    expect(bridge.epochHopProbe().residentDebt).toMatchObject({ stopped: false, writer: 'session', lifecycleInstalled: false })
    useModelStore.getState().updateObject('o1', { name: 'No seam armed' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('No seam armed')
    // A fault fires ONCE: armed, it throws at the next edit and not at the one after.
    bridge.__injectFaultOnceForTest('onStoreChangeAfterNote')
    expect(() => useModelStore.getState().updateObject('o1', { name: 'Thrown once' } as any)).toThrow('injected fault')
    expect(bridge.__armedFaultsForTest()).toEqual([])
    expect(() => useModelStore.getState().updateObject('o1', { name: 'Not thrown again' } as any)).not.toThrow()
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Not thrown again')
  })

  it('G4-16l test 1 (case 1, the store not the projection at the failure; mutant: the window\'s close stops the attempt again): the failed boot\'s debt is written once a shard change re-projects', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    await boot(ws)
    bridge.stopBridge()
    // While no session runs, a colleague adds o2 to the shard.
    const theirs = A.change(A.clone(ws.objectShard.doc()!, { actor: 'ee'.repeat(16) }), (d: any) => { d.objects.o2 = objectEntity('o2', 'Colleague') })
    ws.objectShard.update((d: any) => A.merge(d, theirs))
    // The next boot holds after the sharding, before the projection: the store
    // still shows the last session (the harness of "no boot-window write while
    // the store is not yet the projection" above).
    const store = await memoryStore()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const get = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementation(async (key: string) => {
      if (key === 'pending-placement-intents:v1') await readGate
      return get(key) as never
    })
    const booting = boot(ws, { allowError: true })
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(storeObject('o2')).toBeUndefined()
    useModelStore.getState().updateObject('o1', { name: 'Edited on the stale store, then the boot failed' } as any)
    expect((await probe()).residentPendingWrites).toBe(1)
    // The boot's projection throws: the store is never the projection at the failure.
    bridge.__injectFaultOnceForTest('projectAll')
    releaseRead()
    await booting
    expect(bridge.__armedFaultsForTest()).toEqual([])
    expect(useAutomergeStatus.getState().status).toBe('error')
    // Refused, not dropped: nothing written from the stale store, still owed and armed.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    expect(shardObject(ws, 'o2')?.name).toBe('Colleague')
    expect((await probe()).residentPendingWrites).toBe(1)
    expect((await probe()).residentDebt).toMatchObject({ armed: true, writer: 'boot', lifecycleInstalled: true })
    // A colleague's change: the shard listener (the catch leaves it) re-projects.
    remoteChange(ws, (d) => { d.objects.o2.description = 'Colleague, again' })
    await expect.poll(() => storeObject('o2')?.name, POLL).toBe('Colleague')
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Edited on the stale store, then the boot failed')
    expect(shardObject(ws, 'o2')).toMatchObject({ name: 'Colleague', description: 'Colleague, again' })
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  it('G4-16l test 2 (case 1, writes paused by a latch at the failure, then pagehide; mutant: the catch removes the driver\'s listener): the page hidden after the failure writes the edit', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    let fail!: () => void
    const failure = new Promise<void>((_, reject) => { fail = () => reject(new Error('the active diagram could not be resolved')) })
    failure.catch(() => undefined)
    const booting = boot(ws, { diagramGate: failure, allowError: true })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    bridge.__pauseWritesAsByHopForTest(true)
    useModelStore.getState().updateObject('o1', { name: 'Edited under a latch, then the boot failed' } as any)
    fail()
    await booting
    expect(useAutomergeStatus.getState().status).toBe('error')
    // Refused while paused: nothing written, still owed, the driver's listener still there.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    expect((await probe()).residentPendingWrites).toBe(1)
    expect((await probe()).residentDebt).toMatchObject({ lifecycleInstalled: true })
    window.dispatchEvent(new Event('pagehide'))
    // The lifecycle plan lifts the pause for its own write.
    expect(shardObject(ws, 'o1')?.name).toBe('Edited under a latch, then the boot failed')
  })

  it('G4-16l test 3 (case 2 at the boot; mutant: the finally removed): a throw in the subscription\'s replay after the note — the edit is still written, with no further edit', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate, allowError: true })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    let shardAtThrow: string | undefined = 'not thrown'
    let debtAtThrow = -1
    useModelStore.getState().updateObject('o1', { name: 'Window edit, then the replay threw' } as any)
    // The next onStoreChange is the subscription's replay of the window edit.
    bridge.__injectFaultOnceForTest('onStoreChangeAfterNote', () => {
      shardAtThrow = shardObject(ws, 'o1')?.name
      debtAtThrow = bridge.epochHopProbe().residentPendingWrites
    })
    release()
    await booting
    expect(bridge.__armedFaultsForTest()).toEqual([])
    // The throw came before any write of the edit, with the edit owed.
    expect(shardAtThrow).toBe('Container o1')
    expect(debtAtThrow).toBe(1)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Window edit, then the replay threw')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  it('G4-16l test 4 (case 2 in the steady state; mutant: the finally removed): a throw in onStoreChange after the note, on an ordinary edit — written with no further edit, and the throw is not masked', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    await boot(ws)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
    bridge.__injectFaultOnceForTest('onStoreChangeAfterNote')
    expect(() => useModelStore.getState().updateObject('o1', { name: 'Edited, then onStoreChange threw' } as any)).toThrow('injected fault')
    expect(storeObject('o1')?.name).toBe('Edited, then onStoreChange threw')
    expect((await probe()).residentPendingWrites).toBe(1)
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Edited, then onStoreChange threw')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  // The status this pins is the one the CATCH ends on. It does not stay
  // `error`: the session goes on (its listeners, its driver), and the next
  // durable acknowledgement sets `ready` — a known behaviour, older than
  // G4-16l and not changed by it, and not covered here. The catch's
  // `arm()` is not pinned either: the window's note already armed the
  // driver, so a mutant that removes it survives today.
  it('G4-16l test 5 (case 3; mutant: the try removed): the catch\'s write throws — the catch still reaches its end and `error`, no window watch is left, and the driver writes the edit after the fault', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    let fail!: () => void
    const failure = new Promise<void>((_, reject) => { fail = () => reject(new Error('the active diagram could not be resolved')) })
    failure.catch(() => undefined)
    const booting = boot(ws, { diagramGate: failure, allowError: true })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    let startedAtThrow: boolean | null = null
    let watchAtThrow: boolean | null = null
    useModelStore.getState().updateObject('o1', { name: 'Edited, then the boot write threw' } as any)
    bridge.__injectFaultOnceForTest('writeModelShards', () => {
      const p = bridge.epochHopProbe()
      startedAtThrow = p.bridgeStarted
      watchAtThrow = p.bootEditWatchActive
    })
    // The failure lands before the driver's first (50 ms) attempt.
    fail()
    // Resolved: the catch reached its end (before the fix, the second throw rejected it).
    await expect(booting).resolves.toBeUndefined()
    // The fault hit the CATCH's write: the boot already marked stopped, the window still open.
    expect(startedAtThrow).toBe(false)
    expect(watchAtThrow).toBe(true)
    expect(useAutomergeStatus.getState().status).toBe('error')
    expect((await probe()).bootEditWatchActive).toBe(false)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Edited, then the boot write threw')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
  })

  it('G4-16l: a throw out of the stop\'s lifecycle flush no longer aborts the stop — the driver is stopped and the next boot runs', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    await boot(ws)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
    const first = bridge.__residentDebtDriverForTest()!
    // An edit whose write is still in its debounce: the stop's flush writes it, and throws.
    useModelStore.getState().updateObject('o1', { name: 'Owed at the stop' } as any)
    bridge.__injectFaultOnceForTest('writeModelShards')
    expect(() => bridge.stopBridge()).not.toThrow()
    expect(bridge.__armedFaultsForTest()).toEqual([])
    expect(first.state()).toMatchObject({ stopped: true, armed: false })
    expect(bridge.epochHopProbe().bridgeStarted).toBe(false)
    // A next session boots (before the fix `started` stayed true: it returned at once).
    await boot(ws)
    expect(bridge.__residentDebtDriverForTest()).not.toBe(first)
    useModelStore.getState().updateObject('o1', { name: 'Written by the next session' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Written by the next session')
  })

  it('G4-16l: a boot failed inside its window does not write its debt into base shards once the root says the server owns the registry', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    let fail!: () => void
    const failure = new Promise<void>((_, reject) => { fail = () => reject(new Error('the active diagram could not be resolved')) })
    failure.catch(() => undefined)
    const booting = boot(ws, { diagramGate: failure, allowError: true })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    bridge.__pauseWritesAsByHopForTest(true)
    useModelStore.getState().updateObject('o1', { name: 'Owed, then the workspace was promoted' } as any)
    fail()
    await booting
    expect(useAutomergeStatus.getState().status).toBe('error')
    // No root handler latches it on this path: the root alone says it.
    ws.root.change((d: any) => { d.registrySummaryOnly = true })
    bridge.__pauseWritesAsByHopForTest(false)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect((await probe()).residentDebt).toMatchObject({ writer: 'boot', lastOutcome: 'refused' })
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
  })

  it('G4-16l test 7 (a superseded session; mutants: the stop removed from stopBridge, with and without the token guard): the old session\'s driver is stopped at the stop and never attempts in the next session', async () => {
    const bridge = await import('./bridge')
    const ws = workspace()
    let release1!: () => void
    const gate1 = new Promise<void>((resolve) => { release1 = resolve })
    const boot1 = boot(ws, { diagramGate: gate1 }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    const first = bridge.__residentDebtDriverForTest()!
    bridge.__pauseWritesAsByHopForTest(true)
    useModelStore.getState().updateObject('o1', { name: 'Session 1 edit' } as any)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Owed and refused: the first driver is armed and has attempted.
    expect(first.state()).toMatchObject({ armed: true, stopped: false })
    expect(first.state().totalAttempts).toBeGreaterThan(0)
    bridge.stopBridge()
    // The stop's lifecycle flush wrote session 1's edit; its driver is gone with it.
    expect(shardObject(ws, 'o1')?.name).toBe('Session 1 edit')
    expect(first.state()).toMatchObject({ armed: false, stopped: true, lifecycleInstalled: false })
    const attemptsAtStop = first.state().totalAttempts
    release1()
    await boot1
    // Session 2: its own driver, and a debt it cannot pay (paused again).
    let release2!: () => void
    const gate2 = new Promise<void>((resolve) => { release2 = resolve })
    const boot2 = boot(ws, { diagramGate: gate2 })
    await expect.poll(() => bridge.__residentDebtDriverForTest()?.state().lifecycleInstalled, POLL).toBe(true)
    const second = bridge.__residentDebtDriverForTest()!
    expect(second).not.toBe(first)
    bridge.__pauseWritesAsByHopForTest(true)
    useModelStore.getState().updateObject('o1', { name: 'Session 2 edit' } as any)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(second.state().totalAttempts).toBeGreaterThan(0)
    expect(first.state().totalAttempts).toBe(attemptsAtStop)
    bridge.__pauseWritesAsByHopForTest(false)
    release2()
    await boot2
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Session 2 edit')
  })

  it('a boot superseded while it awaited the registry does not shard the model over the next session\'s', async () => {
    const ws = workspace()
    let releaseA!: () => void
    const registryGate = new Promise<void>((resolve) => { releaseA = resolve })
    const bootA = boot(ws, { registryGate }).catch(() => undefined)
    await expect.poll(() => vi.mocked(repoModule.getRegistryShardHandles).mock.calls.length, POLL).toBe(1)
    const { stopBridge } = await import('./bridge')
    stopBridge()
    await boot(ws)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
    const metaFinds = vi.mocked(repoModule.findModelMetaHandle).mock.calls.length
    const diagramFinds = vi.mocked(repoModule.findDiagramHandle).mock.calls.length
    releaseA()
    await bootA
    await new Promise((resolve) => setTimeout(resolve, 100))
    // A stopped at its check: no ModelMeta resolved, no diagram opened.
    expect(vi.mocked(repoModule.findModelMetaHandle).mock.calls.length).toBe(metaFinds)
    expect(vi.mocked(repoModule.findDiagramHandle).mock.calls.length).toBe(diagramFinds)
    useModelStore.getState().updateObject('o1', { name: 'Written by the second session' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Written by the second session')
  })

  it('a boot superseded while it awaited the placement journal neither projects nor opens a diagram for the next session', async () => {
    const ws = workspace()
    const store = await memoryStore()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const get = store.get.bind(store)
    let gated = 0
    vi.spyOn(store, 'get').mockImplementation(async (key: string) => {
      // Only the first boot's read waits.
      if (key === 'pending-placement-intents:v1' && gated++ === 0) await readGate
      return get(key) as never
    })
    const bootA = boot(ws).catch(() => undefined)
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { stopBridge } = await import('./bridge')
    stopBridge()
    await boot(ws)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
    const diagramFinds = vi.mocked(repoModule.findDiagramHandle).mock.calls.length
    releaseRead()
    await bootA
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(vi.mocked(repoModule.findDiagramHandle).mock.calls.length).toBe(diagramFinds)
    useModelStore.getState().updateObject('o1', { name: 'Written by the second session' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('Written by the second session')
  })

  it('two entities deleted remotely 150 ms apart in a quiet workspace — the timer\'s release arms the NEXT deadline, both are released', async () => {
    const { __setAbsentDeleteGraceMsForTest } = await import('./residentPendingWrites')
    __setAbsentDeleteGraceMsForTest(300)
    try {
      const ws = workspace()
      ws.objectShard.change((d: any) => { d.objects.o2 = objectEntity('o2') })
      await boot(ws)
      await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
      await expect.poll(() => storeObject('o2')?.name, POLL).toBe('Container o2')
      useModelStore.getState().updateObject('o1', { name: 'Mine 1' } as any)
      remoteChange(ws, (d) => { delete d.objects.o1 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      useModelStore.getState().updateObject('o2', { name: 'Mine 2' } as any)
      remoteChange(ws, (d) => { delete d.objects.o2 })
      expect((await probe()).residentPendingWrites).toBe(2)
      // Nothing else happens: the first timer releases o1, and must arm o2's deadline.
      await expect.poll(async () => (await probe()).residentPendingWrites, { timeout: 3_000, interval: 50 }).toBe(0)
      expect(shardObject(ws, 'o1')).toBeUndefined()
      expect(shardObject(ws, 'o2')).toBeUndefined()
    } finally {
      __setAbsentDeleteGraceMsForTest(null)
    }
  })

  it('a stop during the boot leaves no edit watch behind', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate }).catch(() => undefined)
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    const { stopBridge } = await import('./bridge')
    stopBridge()
    useModelStore.getState().updateObject('o1', { name: 'After the stop' } as any)
    expect((await probe()).residentPendingWrites).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(shardObject(ws, 'o1')?.name).toBe('Container o1')
    release()
    await booting
  })

  it('the page hidden while the boot still runs writes the edit made in that window — before the session\'s own listeners exist', async () => {
    const ws = workspace()
    let release!: () => void
    const diagramGate = new Promise<void>((resolve) => { release = resolve })
    const booting = boot(ws, { diagramGate })
    await expect.poll(() => storeObject('o1')?.name, POLL).toBe('Container o1')
    useModelStore.getState().updateObject('o1', { name: 'Edited, then the tab closed' } as any)
    window.dispatchEvent(new Event('pagehide'))
    expect(shardObject(ws, 'o1')?.name).toBe('Edited, then the tab closed')
    release()
    await booting
  })

  it('a derived "lower" connection is never owed — it is never written, so it would hold the badge on "Saving" for good', async () => {
    const ws = workspace()
    await boot(ws)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
    const lower = { id: 'lower:o1:o1', kind: 'lower', sourceId: 'o1', targetId: 'o1', label: '' }
    useModelStore.setState({ connections: [...useModelStore.getState().connections, lower as any] })
    expect((await probe()).residentPendingWrites).toBe(0)
    useModelStore.getState().updateObject('o1', { name: 'An edit beside it' } as any)
    await expect.poll(() => shardObject(ws, 'o1')?.name, POLL).toBe('An edit beside it')
    await expect.poll(async () => (await probe()).residentPendingWrites, POLL).toBe(0)
    await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
  })

  it('the page hidden while a write is owed writes it at once (the lifecycle flush), before any reload', async () => {
    const ws = workspace()
    await boot(ws)
    const id = useModelStore.getState().addObject({ ...objectEntity('z'), name: 'Before the reload' } as any)
    remoteChange(ws, (d) => { d.objects.o1.description = 'Colleague' })
    window.dispatchEvent(new Event('pagehide'))
    expect(shardObject(ws, id)?.name).toBe('Before the reload')
  })

  it('no swap while the tab\'s NEW base shard lacks a forward head the server names; it swaps once it holds it', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    await boot(ws)
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    // The forward the server wrote into the new base shard, not synced here yet.
    const serverCopy = A.change(A.clone(ws.nextShard.doc()!), (d: any) => { d.objects.o1.name = 'Forwarded' })
    targetHeads = [{ documentId: ws.nextShard.documentId, heads: A.getHeads(serverCopy) }]
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    // The forward reaches the tab's copy: the hop swaps, inside its latch.
    ws.nextShard.update((d: any) => A.merge(d, serverCopy))
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).toBe('Forwarded')
  })

  it('the meta left is a holder of held pointers only when the new meta names it as its predecessor', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    await boot(ws)
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect((await probe()).predecessorMetas).toContain(ws.m0.documentId)
    // A repoint to ANOTHER lineage: followed, but m1 is not its predecessor.
    ws.root.change((r: any) => { r.modelMetaUrl = ws.repaired.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.repaired.url)
    expect((await probe()).predecessorMetas).not.toContain(ws.m1.documentId)
  })

  it('a hop: a shard resumed at boot (held on an older epoch) stays projected after the hop to a meta that does not list it yet', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    // Booted on m1 (its predecessor m0 holds the offline pointer); the root
    // then names `repaired`… no: a third epoch m2 whose predecessor is m1.
    const store = await memoryStore()
    const held = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Offline O9') } })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: held.url, unminted: true }])
    const m2Shard = repoModule.repo.create<any>({ objects: { o1: objectEntity('o1') } })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m1.url),
    })
    // Created offline: the server never received the shard.
    answers.set(held.documentId, { documentId: held.documentId, durable: false })
    await boot(ws, { extra: [held, m2Shard], metas: [m2], held: [held] })
    expect((await probe()).bootedMetaUrl).toBe(ws.m1.url)
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    // The pointer written into m1 reached the server: it holds the shard, an
    // ORDINARY document (m2 was cut before the pointer existed).
    answers.set(held.documentId, { documentId: held.documentId, durable: true })
    ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
    expect(useModelStore.getState().objects.some((o) => o.id === 'o9')).toBe(true)
    expect((await probe()).objectShards).toContain(held.documentId)
  })

  it('a hop after a boot on the OLD meta itself (the cached root): the random-id shard it lists is carried by the hop', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const held = repoModule.repo.create<any>({ objects: { o8: objectEntity('o8', 'Offline O8') } })
    // m0 lists the shard (the offline write in this browser); m1, the next
    // epoch, does not yet.
    ws.m0.change((m: any) => { m.objectShardUrls.push(held.url) })
    await (await memoryStore()).set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: held.url, unminted: true }])
    // The server has not received the shard yet: not an epoch document.
    answers.set(held.documentId, { documentId: held.documentId, durable: false })
    await boot(ws, { extra: [held], held: [held] })
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o8'), POLL).toBe(true)
    // Still queued: the server has not acknowledged the shard.
    expect(await (await memoryStore()).get('deferred-references:v1')).toHaveLength(1)
    // m0's pointer reaches the server: it holds the shard, an ORDINARY
    // document (m1 was cut before it) — not a late source, so carried.
    answers.set(held.documentId, { documentId: held.documentId, durable: true })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect(useModelStore.getState().objects.some((o) => o.id === 'o8')).toBe(true)
    // Re-entered in the ledger at the resume, so the round asked about it and the entry left the queue once it was durable.
    await expect.poll(async () => (await memoryStore()).get('deferred-references:v1'), POLL).toEqual([])
  })

  it('the shard created offline and written into a meta RETIRED since — never durable, it no longer holds the hop: the retired path swaps, the shard is carried, its pointer is written into the NEW meta, and the entry leaves once durable', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const x = repoModule.repo.create<any>({ objects: { o8: objectEntity('o8', 'Offline O8') } })
    // m0 lists X (the offline write in this browser), its entry still queued.
    ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    // TWO rolls since: m2's predecessor is m1, whose predecessor is m0.
    const m2Shard = repoModule.repo.create<any>({ objects: { o1: objectEntity('o1') } })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m1.url),
    })
    // m0's epoch is RETIRED; X was claimed by no meta the server reads: an
    // ordinary answer, never durable.
    const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
    answers.set(ws.m0.documentId, retired(ws.m0.documentId))
    answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
    answers.set(x.documentId, { documentId: x.documentId, durable: false })
    const resetSync = vi.spyOn(deniedRecoveryModule, 'resetDocumentSyncState')
    const acknowledged = vi.spyOn(deniedRecoveryModule.DeniedDocumentRecovery.prototype, 'noteAcknowledged')
    await boot(ws, { extra: [x, m2Shard], metas: [m2], held: [x] })
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o8'), POLL).toBe(true)
    // An offline edit to the retired base shard: the export's line.
    useModelStore.getState().updateObject('o1', { name: 'Edited offline' } as any)
    await new Promise((resolve) => setTimeout(resolve, 100))
    ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    // The hop's export is persisted too: the hop's retired path would
    // otherwise lose it to a reload, like the boot's.
    await expect.poll(async () => ((await store.get('epoch-retired-export:v1')) as any)?.differences.map((d: any) => d.id), POLL).toEqual(['o1'])
    // Carried: X stays on the screen and the tab's own…
    expect((await probe()).objectShards).toContain(x.documentId)
    expect(useModelStore.getState().objects.some((o) => o.id === 'o8')).toBe(true)
    // …and the server, asked about it, does not know it: its pointer goes into m2.
    await expect.poll(() => [...((m2.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
    // Claimable only now: X is presented again at once, a new episode (its
    // earlier refusals may have spent the re-presentation budget).
    expect(resetSync).toHaveBeenCalledWith(expect.anything(), x.documentId)
    // …its re-presentation budget reset too.
    expect(acknowledged).toHaveBeenCalledWith(x.documentId)
    expect(await store.get('deferred-references:v1')).toHaveLength(1)
    // Claimed through m2, then durable: the entry leaves the queue.
    answers.set(x.documentId, { documentId: x.documentId, durable: true })
    await expect.poll(async () => store.get('deferred-references:v1'), POLL).toEqual([])
  })

  /** The offline-shard world: X created offline,
   * listed in m0, m0's epoch retired, two rolls since. `entry` overrides the
   * queued entry; `xAnswer` the server's answer about X; `m2ListsX` puts
   * X's pointer in m2 already. Returns after the hop swapped. */
  async function o3Hop(options: {
    /** A SECOND entry about X, beside the ordinary one. */
    entry?: (ws: Workspace, x: DocHandle<any>) => Record<string, unknown>
    xAnswer?: (x: DocHandle<any>) => Record<string, unknown>
    m2ListsX?: boolean
    beforeRepoint?: () => void
    /** m0 answered as a LIVE superseded meta (forwarded), not retired. */
    m0Live?: boolean
  } = {}) {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const x = repoModule.repo.create<any>({ objects: { o8: objectEntity('o8', 'Offline O8') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
    const entry = { holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }
    await store.set('deferred-references:v1', options.entry ? [entry, options.entry(ws, x)] : [entry])
    const m2Shard = repoModule.repo.create<any>({ objects: { o1: objectEntity('o1') } })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: options.m2ListsX ? [m2Shard.url, x.url] : [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m1.url),
    })
    const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
    if (!options.m0Live) {
      answers.set(ws.m0.documentId, retired(ws.m0.documentId))
      answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
    }
    answers.set(x.documentId, options.xAnswer?.(x) ?? { documentId: x.documentId, durable: false })
    await boot(ws, { extra: [x, m2Shard], metas: [m2], held: [x] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o8'), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    options.beforeRepoint?.()
    ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
    return { ws, x, m2, store }
  }
  const decisionsOf = async (x: DocHandle<any>) => (await probe()).carriedDecisions
    .filter((d) => d.startsWith(`${x.documentId}:`)).map((d) => d.slice(x.documentId.length + 1))

  /** The QUESTION after the repoint is answered `answer` (durable at X's
   * first change); the ledger's and the hop's asks still see X not durable,
   * so its entry is still queued when the swap decides. */
  function questionAnswers(answerOf: (documentId: string) => Record<string, unknown>) {
    const state = { on: false }
    const answer = vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).getMockImplementation()!
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) =>
      (state.on && documents.length === 1 && new Error().stack?.includes('serverHoldsShard')
        ? documents.map(({ documentId }) => answerOf(documentId)) as any
        : answer(documents, options)))
    return state
  }

  it('HELD behind a LIVE old meta — its forward adopts the pointer: NOT written into the new meta, X stays carried', async () => {
    const question = questionAnswers((documentId) => ({ documentId, durable: true }))
    const { x, m2 } = await o3Hop({ m0Live: true, beforeRepoint: () => { question.on = true } })
    await expect.poll(() => decisionsOf(x), POLL).toContain('held')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((m2.doc() as any).objectShardUrls).not.toContain(x.url)
    expect(await decisionsOf(x)).not.toContain('written')
    expect((await probe()).objectShards).toContain(x.documentId)
  })

  it('HELD as a plain claim behind a RETIRED old meta — no forward will come: the pointer IS written into the new meta', async () => {
    const question = questionAnswers((documentId) => ({ documentId, durable: true }))
    const { x, m2 } = await o3Hop({ beforeRepoint: () => { question.on = true } })
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    await expect.poll(() => [...((m2.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
    expect(await decisionsOf(x)).toEqual(expect.arrayContaining(['claimed', 'written']))
  })

  it('behind a RETIRED old meta, X answered as a live superseded epoch document (`forwarded`) is still not written — a full roll\'s copy may hold it', async () => {
    const question = questionAnswers((documentId) => ({ documentId, durable: true, forwarded: true }))
    const { x, m2 } = await o3Hop({ beforeRepoint: () => { question.on = true } })
    await expect.poll(() => decisionsOf(x), POLL).toContain('held')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((m2.doc() as any).objectShardUrls).not.toContain(x.url)
  })

  it('a shard created in THIS session whose entry left the queue (the reconnect wrote its pointer into the old meta — a minted shard\'s path, AUTH on) is decided too behind a RETIRED old meta: written into the new meta', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const m2Shard = repoModule.repo.create<any>({ objects: { o1: objectEntity('o1') } })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m1.url),
    })
    const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
    answers.set(ws.m0.documentId, retired(ws.m0.documentId))
    answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
    await boot(ws, { extra: [m2Shard], metas: [m2] })
    const before = (await probe()).objectShards
    // Three objects overflow the 3-object shard into a NEW shard X.
    for (const id of ['n1', 'n2', 'n3']) useModelStore.getState().addObject({ ...objectEntity(id), id } as any)
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(before.length + 1)
    const xId = (await probe()).objectShards.find((d) => !before.includes(d))!
    const x = repoModule.repo.handles[xId as never] as DocHandle<any>
    await expect.poll(() => [...((ws.m0.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
    // The pointer is in m0 and the server claims X (a plain claim): the
    // entry leaves the queue, as a minted shard's held pointer does.
    answers.set(xId, { documentId: xId, durable: true })
    await store.set('deferred-references:v1', [])
    ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    await expect.poll(() => [...((m2.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
    expect((await probe()).carriedDecisions.filter((d) => d.startsWith(`${xId}:`)).map((d) => d.slice(xId.length + 1)))
      .toEqual(expect.arrayContaining(['unqueued', 'claimed', 'written']))
  })

  it('a reload onto the CURRENT epoch whose ledger still owes a document the server answers RETIRED — her offline edit in it is offered as an export, then it leaves the ledger', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    // The hop never settled: the tab was reloaded onto m1 with m0's base
    // shard still owed — her offline edit in it, never forwarded.
    ws.objectShard.change((d: any) => { d.objects.o1.name = 'Offline, never forwarded' })
    await store.set('pending-durable-heads:v1', [{ documentId: ws.objectShard.documentId, heads: A.getHeads(ws.objectShard.doc()!) }])
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: false, forwarded: false, epochRetired: true })
    await boot(ws)
    expect((await probe()).bootedMetaUrl).toBe(ws.m1.url)
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => ((await store.get('epoch-retired-export:v1')) as any)?.differences.map((d: any) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
  })

  /** The net's world: reloaded onto m1, the ledger owing m0's base shard, her edit in it. */
  async function netWorld(options: { notReadyRounds?: number; actorsKnown?: boolean; evictedWriter?: boolean; failPersist?: boolean } = {}) {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    ws.objectShard.change((d: any) => { d.objects.o1.name = 'Offline, never forwarded' })
    const mine = A.getActorId(ws.objectShard.doc()!)
    let writers: string[] | undefined
    if (options.actorsKnown || options.evictedWriter) {
      // Another actor's edit of o0 (absent from the current epoch too).
      const other = A.change(A.clone(ws.objectShard.doc()!, { actor: 'cd'.repeat(16) }), (d: any) => { d.objects.o0 = objectEntity('o0', 'Colleague') })
      ws.objectShard.update((d: any) => A.merge(d, other))
    }
    if (options.actorsKnown) {
      // The entry's writer is the actor of her edit; o0's is another user's.
      writers = [mine]
      await store.set('epoch-actors:v1', [mine])
    }
    if (options.evictedWriter) {
      // BOTH are hers — o1 under an old
      // page load's actor the 256-actor journal has since evicted, o0 under a
      // recent one it still holds. The entry names both writers.
      writers = [mine, 'cd'.repeat(16)]
      await store.set('epoch-actors:v1', ['cd'.repeat(16)])
    }
    await store.set('pending-durable-heads:v1', [{ documentId: ws.objectShard.documentId, heads: A.getHeads(ws.objectShard.doc()!), ...(writers ? { actors: writers } : {}) }])
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: false, forwarded: false, epochRetired: true })
    let notReady = (options.notReadyRounds ?? 0) > 0
    let reads = 0
    if (notReady) {
      // The local copy not ready when the acknowledgements come back (the
      // boot's `repo.find` still running), until the test lets it be.
      const realSynced = repoCompatModule.syncedHandle
      vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === ws.objectShard.documentId && notReady ? undefined : realSynced(r, id)) as any)
      const realFind = repoModule.repo.find.bind(repoModule.repo)
      vi.spyOn(repoModule.repo, 'find').mockImplementation(((url: any, ...rest: any[]) => {
        if (String(url).endsWith(ws.objectShard.documentId) && notReady) { reads += 1; return Promise.reject(new Error('not ready yet')) }
        return (realFind as any)(url, ...rest)
      }) as any)
    }
    if (options.failPersist) {
      const update = store.update.bind(store)
      vi.spyOn(store, 'update').mockImplementation((async (key: string, fn: any) => {
        if (key === 'epoch-retired-export:v1') throw new Error('no IndexedDB')
        return update(key, fn)
      }) as any)
    }
    await boot(ws)
    expect((await probe()).bootedMetaUrl).toBe(ws.m1.url)
    return { ws, store, reads: () => reads, release: () => { notReady = false } }
  }

  it('the local copy NOT READY at the first acknowledgement — nothing forgotten, nothing marked; offered at a later round, forgotten only then', async () => {
    const { ws, reads, release } = await netWorld({ notReadyRounds: 1 })
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    // The rounds so far read nothing: still owed, nothing offered.
    await expect.poll(reads, POLL).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await probe()).durablePending).toContain(ws.objectShard.documentId)
    expect(useEpochHopStore.getState().retired).toBeFalsy()
    release()
    // A later round (her next edit asks the ledger again) reads it.
    useModelStore.getState().updateObject('o1', { name: 'Typing on m1' } as any)
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
  })

  it('only what HER changes touched is offered — not an entity another user changed', async () => {
    const { ws } = await netWorld({ actorsKnown: true })
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
  })

  /** Local copies NOT ready (the boot's `repo.find` still running) for `ids`, until released. */
  function notReadyUntilReleased(ids: () => readonly string[]) {
    let notReady = true
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (notReady && ids().includes(id) ? undefined : realSynced(r, id)) as any)
    const realFind = repoModule.repo.find.bind(repoModule.repo)
    vi.spyOn(repoModule.repo, 'find').mockImplementation(((url: any, ...rest: any[]) => {
      if (notReady && ids().some((id) => String(url).endsWith(id))) return Promise.reject(new Error('not ready yet'))
      return (realFind as any)(url, ...rest)
    }) as any)
    return () => { notReady = false }
  }

  it('ONLY the documents read are marked offered — one unreadable at the first round is offered at a later one', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    ws.objectShard.change((d: any) => { d.objects.o1.name = 'Offline, never forwarded' })
    // A second retired document the ledger owes, its copy not ready yet.
    const y = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5', 'Offline in Y') } })
    await store.set('pending-durable-heads:v1', [ws.objectShard, y].map((h) => ({ documentId: h.documentId, heads: A.getHeads(h.doc()!) })))
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    for (const h of [ws.objectShard, y]) answers.set(h.documentId, { documentId: h.documentId, durable: false, forwarded: false, epochRetired: true })
    const release = notReadyUntilReleased(() => [y.documentId])
    await boot(ws)
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
    expect((await probe()).durablePending).toContain(y.documentId)
    release()
    // A later round reads Y: offered, then forgotten.
    useModelStore.getState().updateObject('o1', { name: 'Typing on m1' } as any)
    await expect.poll(() => [...(useEpochHopStore.getState().retired?.differences.map((d) => d.id) ?? [])].sort(), POLL).toEqual(['o1', 'o5'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(y.documentId)
  })

  it('a retired META waits for EVERY shard it lists that the current meta does not — read, then offered with them', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    // Offline: a shard X created, its pointer written into m0 only.
    const x = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7', 'Created offline in X') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
    await store.set('pending-durable-heads:v1', [{ documentId: ws.m0.documentId, heads: A.getHeads(ws.m0.doc()!) }])
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    answers.set(ws.m0.documentId, { documentId: ws.m0.documentId, durable: false, forwarded: false, epochRetired: true })
    const release = notReadyUntilReleased(() => [x.documentId])
    await boot(ws)
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    // X unreadable: the meta is neither offered nor forgotten.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(useEpochHopStore.getState().retired).toBeFalsy()
    expect((await probe()).durablePending).toContain(ws.m0.documentId)
    release()
    useModelStore.getState().updateObject('o1', { name: 'Typing on m1' } as any)
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toContain('o7')
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.m0.documentId)
  })

  it('a CREATED shard\'s entry has unknown writers (nothing filtered by actor); a local edit of an existing shard names its writer', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await boot(ws)
    // Nothing acknowledged: the entries stay owed (and persisted).
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: false })) as any)
    const before = (await probe()).objectShards
    useModelStore.getState().updateObject('o1', { name: 'Edited here' } as any)
    for (const id of ['n1', 'n2', 'n3']) useModelStore.getState().addObject({ ...objectEntity(id), id } as any)
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(before.length + 1)
    const xId = (await probe()).objectShards.find((d) => !before.includes(d))!
    const entries = async () => ((await store.get<any[]>('pending-durable-heads:v1')) ?? [])
    await expect.poll(async () => (await entries()).some((e) => e.documentId === xId), POLL).toBe(true)
    await expect.poll(async () => (await entries()).find((e) => e.documentId === ws.objectShard.documentId)?.actors, POLL)
      .toEqual([A.getActorId(ws.objectShard.doc()!)])
    expect((await entries()).find((e) => e.documentId === xId)).not.toHaveProperty('actors')
  })

  it('an edit under an actor the journal EVICTED is offered — the filter reads the ledger entry\'s writers, not the bounded journal', async () => {
    const { ws } = await netWorld({ evictedWriter: true })
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => [...(useEpochHopStore.getState().retired?.differences.map((d) => d.id) ?? [])].sort(), POLL).toEqual(['o0', 'o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
  })

  it('the document the net forgets is UNPINNED — no longer shared and synced for the session', async () => {
    const pinned: string[] = []
    const pin = repoModule.activeDocumentShare.pin.bind(repoModule.activeDocumentShare)
    vi.spyOn(repoModule.activeDocumentShare, 'pin').mockImplementation((id: any, role: string) => { if (role === 'durability-pending') pinned.push(id); pin(id, role) })
    const { ws } = await netWorld()
    const pinnedSeen = () => pinned.includes(ws.objectShard.documentId)
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
    // Pinned while the net read it (`readLocalCopy`)…
    expect(pinnedSeen()).toBe(true)
    // …and by nothing once forgotten.
    await expect.poll(() => repoModule.activeDocumentShare.isPinned(ws.objectShard.documentId), POLL).toBe(false)
  })

  it('the export NOT persisted (no IndexedDB) — shown, but the document stays owed', async () => {
    const { ws } = await netWorld({ failPersist: true })
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await probe()).durablePending).toContain(ws.objectShard.documentId)
  })

  it('a retired document the tab HOLDS is left to the hop — nothing offered outside it', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    await boot(ws)
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: false, forwarded: false, epochRetired: true })
    useModelStore.getState().updateObject('o1', { name: 'Held edit' } as any)
    await expect.poll(async () => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
      .some(([documents]) => documents.some((d) => d.documentId === ws.objectShard.documentId)), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    expect(useEpochHopStore.getState().retired).toBeFalsy()
    // Still owed: the hop, not the net, decides a held document.
    expect((await probe()).durablePending).toContain(ws.objectShard.documentId)
  })

  it('a remote change arriving DURING a latch is projected once the latch ends — not inside it', async () => {
    const { __setEpochHopOptionsForTest } = await import('./bridge')
    __setEpochHopOptionsForTest({ latchMs: 700, backoffMs: [60_000], busyDrainMaxMs: 0 })
    try {
      const ws = workspace()
      await (await memoryStore()).set('epoch-capability:v1', true)
      // m0 never proven: every latch runs its whole 700 ms.
      answers.set(ws.m0.documentId, { documentId: ws.m0.documentId, durable: true })
      await boot(ws)
      const { useEpochHopStore } = await import('../../stores/epochHopStore')
      ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
      await expect.poll(() => useEpochHopStore.getState().latched, POLL).toBe(true)
      // A colleague's edit reaches the held shard while input is blocked.
      ws.objectShard.change((d: any) => { d.objects.o1.name = 'Remote, during the latch' })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(useEpochHopStore.getState().latched).toBe(true)
      expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).not.toBe('Remote, during the latch')
      // The latch ends: projected.
      await expect.poll(() => useEpochHopStore.getState().latched, POLL).toBe(false)
      await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o1')?.name, POLL).toBe('Remote, during the latch')
      expect((await probe()).reprojectionsDeferredByLatch).toBeGreaterThan(0)
    } finally {
      __setEpochHopOptionsForTest(null)
    }
  })

  it('the bridge STOPPED during a latch with a projection queued — the next session\'s latch still queues and runs its own (the latch fails: no swap projects)', async () => {
    const { __setEpochHopOptionsForTest, stopBridge } = await import('./bridge')
    __setEpochHopOptionsForTest({ latchMs: 700, backoffMs: [60_000], busyDrainMaxMs: 0 })
    try {
      const { useEpochHopStore } = await import('../../stores/epochHopStore')
      const latchWithRemoteEdit = async (name: string) => {
        const ws = workspace()
        await (await memoryStore()).set('epoch-capability:v1', true)
        // m0 never proven: the latch expires, nothing is swapped.
        answers.set(ws.m0.documentId, { documentId: ws.m0.documentId, durable: true })
        await boot(ws)
        ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
        await expect.poll(() => useEpochHopStore.getState().latched, POLL).toBe(true)
        ws.objectShard.change((d: any) => { d.objects.o1.name = name })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).not.toBe(name)
      }
      // Session 1: stopped inside its latch, its queued projection dropped.
      await latchWithRemoteEdit('Remote, session 1')
      expect(useEpochHopStore.getState().latched).toBe(true)
      stopBridge()
      // Session 2 in the same page: its latch's remote change is projected
      // once the latch ends.
      await latchWithRemoteEdit('Remote, session 2')
      await expect.poll(() => useEpochHopStore.getState().latched, POLL).toBe(false)
      await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o1')?.name, POLL).toBe('Remote, session 2')
    } finally {
      __setEpochHopOptionsForTest(null)
    }
  })

  /** A hop to m1 that gives up on the S7 proof (m0 answered without the bit). */
  async function abandonedHop(abandonedRetryMs: number) {
    const { __setEpochHopOptionsForTest, __setEpochHopAbandonedRetryForTest } = await import('./bridge')
    __setEpochHopOptionsForTest({ latchMs: 60, backoffMs: [20], s7ProofMaxAttempts: 2, busyDrainMaxMs: 0 })
    __setEpochHopAbandonedRetryForTest(abandonedRetryMs)
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    // Between S6b and S7: m0 has no epoch row yet, so no `forwarded` bit.
    answers.set(ws.m0.documentId, { documentId: ws.m0.documentId, durable: true })
    await boot(ws)
    // The trace is the module's, kept across tests: only this test's events.
    const since = Date.now()
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).hopTrace
      .some((e) => e.event === 'epoch_hop.s7_unproven' && Number(e.t) >= since), POLL).toBe(true)
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    return ws
  }
  async function resetHopTimings() {
    const { __setEpochHopOptionsForTest, __setEpochHopAbandonedRetryForTest } = await import('./bridge')
    __setEpochHopOptionsForTest(null)
    __setEpochHopAbandonedRetryForTest(null)
  }

  it('a hop that gave up on the S7 proof starts again on its slow timer — the root never changes again', async () => {
    try {
      const ws = await abandonedHop(300)
      // The server's resume passes S7: the proof comes, the root unchanged.
      answers.delete(ws.m0.documentId)
      await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    } finally {
      await resetHopTimings()
    }
  })

  it('the abandoned hop starts again AT ONCE when the durable ledger answers the held epoch retired — the retired path offers the edits as an export', async () => {
    try {
      const ws = await abandonedHop(600_000)
      const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
      answers.set(ws.m0.documentId, retired(ws.m0.documentId))
      answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
      // The tab keeps writing its epoch: the ledger asks about the shard.
      useModelStore.getState().updateObject('o1', { name: 'Written after the abandon' } as any)
      await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
      expect(((await probe()).state as { phase: string }).phase).toBe('retired')
      const { useEpochHopStore } = await import('../../stores/epochHopStore')
      await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o1'])
    } finally {
      await resetHopTimings()
    }
  })

  const latchesSince = async (since: number) => (await probe()).hopTrace.filter((e) => e.event === 'epoch_hop.latch' && Number(e.t) >= since).length
  const oldMetaProbes = (metaId: string) => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
    .filter(([documents, options]) => documents.length === 1 && documents[0]!.documentId === metaId && !(options as { latch?: boolean } | undefined)?.latch).length

  it('the probe\'s backoff starts AGAIN after a resume — a later abandon probes at the base delay, not the doubled one', async () => {
    try {
      const ws = await abandonedHop(80)
      // Backed off: 80, 160, 320, 640 ms…
      await new Promise((resolve) => setTimeout(resolve, 700))
      // ONE probe proves S7 (the hop resumes), the latches do not (abandoned again).
      let proveOnce = true
      const ack = vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).getMockImplementation()!
      vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
        if (proveOnce && documents.length === 1 && documents[0]!.documentId === ws.m0.documentId && !(options as { latch?: boolean } | undefined)?.latch) {
          proveOnce = false
          return [{ documentId: ws.m0.documentId, durable: true, forwarded: false }] as any
        }
        return ack(documents, options)
      })
      await expect.poll(() => proveOnce, POLL).toBe(false)
      const resumedAt = Date.now()
      await expect.poll(async () => (await probe()).hopTrace
        .some((e) => e.event === 'epoch_hop.s7_unproven' && Number(e.t) >= resumedAt), POLL).toBe(true)
      // At the base delay again: probes within 400 ms (not after 1 280).
      const before = oldMetaProbes(ws.m0.documentId)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(oldMetaProbes(ws.m0.documentId) - before).toBeGreaterThanOrEqual(2)
    } finally {
      await resetHopTimings()
    }
  })

  it('S7 still unproven — the timer PROBES the old meta (no latch) and backs off; no latch, no blocked input, until the proof comes', async () => {
    const { EPOCH_HOP_ABANDONED_RETRY_MS } = await import('./bridge')
    expect(EPOCH_HOP_ABANDONED_RETRY_MS).toBe(10 * 60_000)
    try {
      const ws = await abandonedHop(80)
      const since = Date.now()
      const probesBefore = oldMetaProbes(ws.m0.documentId)
      await new Promise((resolve) => setTimeout(resolve, 900))
      // 80, 160, 320 ms: probes, backed off; not one latch.
      const probes = oldMetaProbes(ws.m0.documentId) - probesBefore
      expect(probes).toBeGreaterThanOrEqual(2)
      expect(probes).toBeLessThanOrEqual(4)
      expect(await latchesSince(since)).toBe(0)
      // The proof comes: the next probe restarts the hop.
      answers.delete(ws.m0.documentId)
      await expect.poll(async () => (await probe()).bootedMetaUrl, { timeout: 8_000, interval: 25 }).toBe(ws.m1.url)
    } finally {
      await resetHopTimings()
    }
  })

  it('an `epochRetired` answer about a document the tab does NOT hold does not restart the abandoned hop', async () => {
    try {
      const store = await memoryStore()
      const y = repoModule.repo.create<any>({ objects: { y1: objectEntity('y1') } })
      await store.set('pending-durable-heads:v1', [{ documentId: y.documentId, heads: A.getHeads(y.doc()!) }])
      answers.set(y.documentId, { documentId: y.documentId, durable: false, forwarded: false, epochRetired: true })
      const ws = await abandonedHop(600_000)
      const since = Date.now()
      useModelStore.getState().updateObject('o1', { name: 'After the abandon' } as any)
      await expect.poll(() => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
        .some(([documents]) => documents.some((d) => d.documentId === y.documentId)), POLL).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await latchesSince(since)).toBe(0)
      expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    } finally {
      await resetHopTimings()
    }
  })

  it('the bridge stopped, the abandoned hop\'s timer is gone — no probe after the stop', async () => {
    try {
      await abandonedHop(300)
      const { stopBridge } = await import('./bridge')
      stopBridge()
      // Another session starts before the old timer's delay: it must not
      // probe (nor restart a hop in) the new session.
      const next = workspace()
      await boot(next)
      const before = oldMetaProbes(next.m0.documentId)
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(oldMetaProbes(next.m0.documentId)).toBe(before)
    } finally {
      await resetHopTimings()
    }
  })

  it('behind a RETIRED old meta, the question UNANSWERED once (the reconnect storm) is asked again WITH `claims` — the plain claim the retry hears is written into the new meta', async () => {
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [20, 20, 20, 20, 20, 20] })
    try {
      let asked = 0
      // The first question gets no answer about X (`null`: asked again); the
      // retry hears a plain claim (durable, no epoch row).
      const question = questionAnswers((documentId) => {
        asked += 1
        return asked === 1 ? { documentId: 'not-x' } : { documentId, durable: true }
      })
      const { x, m2 } = await o3Hop({ beforeRepoint: () => { question.on = true } })
      expect(((await probe()).state as { phase: string }).phase).toBe('retired')
      await expect.poll(() => [...((m2.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
      expect(asked).toBeGreaterThanOrEqual(2)
      expect(await decisionsOf(x)).toEqual(expect.arrayContaining(['claimed', 'written']))
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('behind a LIVE old meta, a shard of this session with NO queued entry is not decided — no question, nothing written into the new meta (the live meta\'s forward adopts its pointer)', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    await boot(ws)
    const before = (await probe()).objectShards
    for (const id of ['n1', 'n2', 'n3']) useModelStore.getState().addObject({ ...objectEntity(id), id } as any)
    await expect.poll(async () => (await probe()).objectShards.length, POLL).toBe(before.length + 1)
    const xId = (await probe()).objectShards.find((d) => !before.includes(d))!
    const x = repoModule.repo.handles[xId as never] as DocHandle<any>
    await expect.poll(() => [...((ws.m0.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
    // Unknown to the server: were it asked, the answer would write it.
    answers.set(xId, { documentId: xId, durable: false })
    await store.set('deferred-references:v1', [])
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const decisions = (await probe()).carriedDecisions.filter((d) => d.startsWith(`${xId}:`)).map((d) => d.slice(xId.length + 1))
    expect(decisions).toContain('swap')
    expect(decisions).not.toContain('unqueued')
    expect(decisions).not.toContain('asked')
    expect((ws.m1.doc() as any).objectShardUrls).not.toContain(x.url)
  })

  it('X already listed in the new meta is not asked about after the swap', async () => {
    const { x } = await o3Hop({ m2ListsX: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await decisionsOf(x)).not.toContain('swap')
  })

  it('a second entry about X HELD ON ANOTHER meta (neither the one left nor an epoch predecessor) is not asked about — only the one held on the meta left', async () => {
    const { x } = await o3Hop({ entry: (_ws, x) => ({ holderDocumentId: '4xKgE7kDzk3AyaXfSvhk8yWvvNcY', field: 'objectShardUrls', url: x.url, unminted: true }) })
    await expect.poll(() => decisionsOf(x), POLL).toContain('written')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await decisionsOf(x)).filter((d) => d === 'asked')).toHaveLength(1)
  })

  it('a second entry about X not marked `unminted` (a minted id: the server claims it by its MAC) is not asked about', async () => {
    const { x } = await o3Hop({ entry: (ws, x) => ({ holderDocumentId: ws.m0.documentId, field: 'connectionShardUrls', url: x.url }) })
    await expect.poll(() => decisionsOf(x), POLL).toContain('written')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await decisionsOf(x)).filter((d) => d === 'asked')).toHaveLength(1)
  })

  it('the question about X answered "HTTP 401" twice in a row stops — through the bridge\'s own ask', async () => {
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [20, 20, 20, 20, 20, 20] })
    let expired = false
    let asksAfter = 0
    /** X's first change: what the "does the server hold it" question asks with. */
    const firstOf = new Map<string, string>()
    const answer = vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).getMockImplementation()!
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (expired && documents.length === 1 && documents.some((d) => answers.has(`expire:${d.documentId}`) && d.heads.join() === firstOf.get(d.documentId))) {
        // The question (`serverHoldsShard`), not the durable ledger's ask,
        // which X's one change makes look the same.
        if (new Error().stack?.includes('serverHoldsShard')) asksAfter += 1
        throw new Error('durable-heads HTTP 401')
      }
      return answer(documents, options)
    })
    try {
      // Expired from the repoint on: the carried decision's question (one
      // document, its first change — the hop's own asks batch them all).
      const { x } = await o3Hop({
        xAnswer: (x) => {
          answers.set(`expire:${x.documentId}`, {})
          firstOf.set(x.documentId, A.decodeChange(A.getAllChanges(x.doc()!)[0]!).hash!)
          return { documentId: x.documentId, durable: false }
        },
        beforeRepoint: () => { expired = true },
      })
      await expect.poll(() => asksAfter, POLL).toBeGreaterThanOrEqual(1)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(asksAfter).toBe(2)
      expect(await decisionsOf(x)).not.toContain('written')
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('the walk to the holder CUT SHORT once (a meta between not given in time) is walked again — the pointer still reaches the new meta', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const x = repoModule.repo.create<any>({ objects: { o8: objectEntity('o8', 'Offline O8') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    const m2Shard = repoModule.repo.create<any>({ objects: { o1: objectEntity('o1') } })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m1.url),
    })
    const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
    answers.set(ws.m0.documentId, retired(ws.m0.documentId))
    answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
    answers.set(x.documentId, { documentId: x.documentId, durable: false })
    // m1 (between m2 and m0) is not in this browser; the server fails to give it ONCE.
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === ws.m1.documentId ? undefined : realSynced(r, id)) as any)
    let m1Loads = 0
    const findMeta = async (url: string) => {
      if (url !== ws.m1.url) return undefined
      m1Loads += 1
      if (m1Loads === 1) throw new Error('not given in time')
      return ws.m1
    }
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [50] })
    try {
      await boot(ws, { extra: [x, m2Shard], metas: [m2], held: [x], findMeta })
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o8'), POLL).toBe(true)
      ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
      await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
      await expect.poll(() => [...((m2.doc() as any).objectShardUrls ?? [])], POLL).toContain(x.url)
      expect(m1Loads).toBeGreaterThanOrEqual(2)
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('a base shard a compaction inserts into the CURRENT meta is projected, the segment it folded cleared', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    // The segment the tab writes into (listed among its object shards).
    const segment = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(segment.url) })
    const n = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
    await boot(ws, { extra: [segment, n] })
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o7'])
    // The compaction: o7 folded into a NEW base shard, the segment cleared.
    ws.m0.change((m: any) => { m.objectShardUrls.splice(1, 0, n.url) })
    segment.change((d: any) => { delete d.objects.o7 })
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), POLL).toEqual(['o1', 'o7'])
    expect((await probe()).objectShards).toContain(n.documentId)
  })

  it('one listed shard NOT served (X) no longer holds back the others — B is projected; X\'s lease goes back, X is retried with a backoff and BOUNDED, not on every change of the meta', async () => {
    const { __setFollowRetryDelaysForTest } = await import('./bridge')
    // The first retry well after B's adoption is checked: a retry is per url,
    // so an all-or-nothing load would adopt B on it.
    __setFollowRetryDelaysForTest([2_000, 150])
    try {
      const ws = workspace()
      await (await memoryStore()).set('epoch-capability:v1', true)
      const b = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
      const x = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })
      await boot(ws, { extra: [b] })
      const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
      let xAsks = 0
      vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
        if (urls.includes(x.url)) {
          xAsks += 1
          // `getModelShardHandles` pins the lease before it resolves.
          repoModule.prepareDocumentRequest(x.url, 'model-shard')
          throw new Error('unavailable')
        }
        return load(urls)
      })
      ws.m0.change((m: any) => { m.objectShardUrls.push(x.url, b.url) })
      await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), { timeout: 1_500, interval: 25 }).toEqual(['o1', 'o7'])
      expect(xAsks).toBe(1)
      expect((await probe()).objectShards).not.toContain(x.documentId)
      await expect.poll(() => leased(x.documentId), POLL).toBe(false)
      // Changes of the meta while X waits for its retry ask nothing more.
      const asked = xAsks
      for (let i = 0; i < 3; i++) ws.m0.change((m: any) => { m.groups[`g${i}`] = { id: `g${i}`, name: `G${i}` } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(xAsks).toBe(asked)
      // Two retries, then given up for the session.
      await expect.poll(() => xAsks, POLL).toBe(3)
      await expect.poll(async () => (await probe()).followFailures, POLL).toEqual([`${x.url}:2:given-up`])
      await new Promise((resolve) => setTimeout(resolve, 400))
      ws.m0.change((m: any) => { m.groups.g9 = { id: 'g9', name: 'G9' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(xAsks).toBe(3)
      // The stop forgets the
      // failures, so a bridge started again in this page follows X anew.
      const { stopBridge } = await import('./bridge')
      stopBridge()
      expect((await probe()).followFailures).toEqual([])
    } finally {
      __setFollowRetryDelaysForTest(null)
    }
  })

  it('a follow\'s find left UNANSWERED (the server answered nothing to a request made before it held the shard) presents the document again — and the shard is projected', async () => {
    const { __setFollowFindRepresentForTest, FOLLOW_FIND_REPRESENT_MS } = await import('./bridge')
    expect(FOLLOW_FIND_REPRESENT_MS).toBe(4_000)
    __setFollowFindRepresentForTest(60)
    try {
      const ws = workspace()
      const x = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })
      await boot(ws)
      const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
      // The request for X goes unanswered until it is made again.
      let answer!: () => void
      const presentedAgain = new Promise<void>((resolve) => { answer = resolve })
      vi.spyOn(deniedRecoveryModule, 'resetDocumentSyncState').mockImplementation((_repo, documentId) => {
        if (documentId === x.documentId) answer()
        return 1
      })
      vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
        if (urls.includes(x.url)) { await presentedAgain; return [x] as any }
        return load(urls)
      })
      ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
      expect((await probe()).followRepresentations).toBeGreaterThan(0)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  for (const listed of [true, false]) {
    it(`an edit made inside an overlay entry the compaction CLEARED meanwhile ${listed ? 'is written back' : '— in a shard that is NOT an overlay segment — is left to Automerge'}`, async () => {
      const ws = workspace()
      // An overlay segment AFTER the base shard, holding o9 (an entity an
      // earlier session created there).
      const overlay = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Created earlier') } })
      ws.m0.change((m: any) => {
        m.objectShardUrls.push(overlay.url)
        if (listed) m.editsObjectShardUrls = [overlay.url]
      })
      await boot(ws, { extra: [overlay] })
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
      // An undo history that records (the rescue is not hers to undo).
      undoHistory.configure({ scope: () => 'or1', apply: () => ({}) as never } as never)
      const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
      const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
      // Her edit, a field INSIDE the entry, the server never saw…
      overlay.change((d: any) => { d.objects.o9.description = 'Her offline edit' })
      // …and the compaction: o9 folded into the base shard, then cleared
      // from the overlay — without her edit.
      const folded = A.change(serverBase, (d: any) => { d.objects.o9 = objectEntity('o9', 'Created earlier') })
      // A colleague renames it after the fold (her rescue must not put her
      // older name back).
      const renamed = A.change(folded, (d: any) => { d.objects.o9.name = 'Renamed by Paul' })
      ws.objectShard.update((d: any) => A.merge(d, renamed))
      const cleared = A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d: any) => { delete d.objects.o9 })
      overlay.update((d: any) => A.merge(d, cleared))
      if (listed) {
        // Applied again where o9 lives now, and kept.
        await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o9')?.description, POLL).toBe('Her offline edit')
        expect((await probe()).overlayClearRescues).toBeGreaterThan(0)
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(useModelStore.getState().objects.find((o) => o.id === 'o9')?.description).toBe('Her offline edit')
        // Only her unseen field: the colleague's later rename stands.
        expect(useModelStore.getState().objects.find((o) => o.id === 'o9')?.name).toBe('Renamed by Paul')
        // Outside the undo history.
        expect(undoHistory.sizes('or1').undo).toBe(0)
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(useModelStore.getState().objects.find((o) => o.id === 'o9')?.description).toBeUndefined()
      }
      undoHistory.configure(null)
    })
  }

  it('a rescue still waiting for its entity is PERSISTED, survives a reload, keeps the badge on "Saving", and is applied once the folded copy arrives', async () => {
    const ws = workspace()
    const store = await memoryStore()
    const overlay = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Created earlier') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(overlay.url); m.editsObjectShardUrls = [overlay.url] })
    await boot(ws, { extra: [overlay] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
    const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
    overlay.change((d: any) => { d.objects.o9.description = 'Hers, offline' })
    // The clear arrives; its folded base copy does NOT yet (a slow shard).
    overlay.update((d: any) => A.merge(d, A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d2: any) => { delete d2.objects.o9 })))
    await expect.poll(async () => ((await store.get<any[]>('overlay-clear-rescues:v1')) ?? []).map((r) => r.id), POLL).toEqual(['o9'])
    // Owed: never "Synced" over it (ORs).
    useModelStore.getState().updateObject('o1', { name: 'Typing meanwhile' } as any)
    // Its write acknowledged, the badge still says "Saving" (the rescue).
    await expect.poll(() => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
      .some(([documents]) => documents.some((d) => d.documentId === ws.objectShard.documentId)), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(useAutomergeStatus.getState().status).toBe('saving')
    // A reload before the copy arrives (ORp: read back at boot).
    const { stopBridge } = await import('./bridge')
    stopBridge()
    await boot(ws, { extra: [overlay] })
    await expect.poll(async () => (await probe()).overlayRescuesPending, POLL).toBe(1)
    // The folded copy arrives: her field applied, the entry dropped.
    ws.objectShard.update((d: any) => A.merge(d, A.change(serverBase, (d2: any) => { d2.objects.o9 = objectEntity('o9', 'Created earlier') })))
    await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o9')?.description, POLL).toBe('Hers, offline')
    await expect.poll(async () => (await probe()).overlayRescuesPending, POLL).toBe(0)
    await expect.poll(async () => (await store.get<any[]>('overlay-clear-rescues:v1')) ?? [], POLL).toEqual([])
  })

  it('a rescue found BEFORE the boot has read the persisted ones neither wipes them nor is overwritten by them', async () => {
    const ws = workspace()
    const store = await memoryStore()
    const KEY = 'overlay-clear-rescues:v1'
    const overlay = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Created earlier') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(overlay.url); m.editsObjectShardUrls = [overlay.url] })
    // The previous session left two: one for an entity not here yet (o8), and
    // an OLDER finding for o9 — her value of that time.
    const earlier = Date.now() - 60_000
    await store.set(KEY, [
      { collection: 'objects', id: 'o8', value: objectEntity('o8'), seen: objectEntity('o8'), since: earlier },
      { collection: 'objects', id: 'o9', value: { ...objectEntity('o9', 'Created earlier'), description: 'Stale, previous session' }, seen: objectEntity('o9', 'Created earlier'), since: earlier + 1 },
    ])
    // The boot's read of the key returns what was stored WHEN it was issued,
    // held until the test lets it go (an IndexedDB read issued before a write).
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const get = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementation(async (key: string) => {
      const value = await get(key)
      if (key === KEY) await gate
      return value as never
    })
    await boot(ws, { extra: [overlay] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
    const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
    overlay.change((d: any) => { d.objects.o9.description = 'Hers, live' })
    overlay.update((d: any) => A.merge(d, A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d2: any) => { delete d2.objects.o9 })))
    // Found live and persisted while the read is still held: ADDED to what is stored.
    await expect.poll(async () => ((await get<any[]>(KEY)) ?? []).find((r) => r.id === 'o9')?.value?.description, POLL).toBe('Hers, live')
    expect(((await get<any[]>(KEY)) ?? []).map((r) => r.id).sort()).toEqual(['o8', 'o9'])
    release()
    await expect.poll(async () => (await probe()).overlayRescuesPending, POLL).toBe(2)
    // The folded copy arrives: the LIVE finding is applied, not the stored one.
    ws.objectShard.update((d: any) => A.merge(d, A.change(serverBase, (d2: any) => { d2.objects.o9 = objectEntity('o9', 'Created earlier') })))
    await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o9')?.description, POLL).toBe('Hers, live')
    await expect.poll(async () => ((await get<any[]>(KEY)) ?? []).map((r) => r.id), POLL).toEqual(['o8'])
  })

  it('a rescue this session FINISHED before the boot read the key is not taken back from it — a colleague\'s later revert stays', async () => {
    const ws = workspace()
    const store = await memoryStore()
    const KEY = 'overlay-clear-rescues:v1'
    const overlay = repoModule.repo.create<any>({ objects: { o9: { ...objectEntity('o9', 'Created earlier'), description: 'Seen' } } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(overlay.url); m.editsObjectShardUrls = [overlay.url] })
    // The boot's read returns what is stored when it is RELEASED (this session's finding in it).
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const get = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementation(async (key: string) => { if (key === KEY) await gate; return get(key) as never })
    await boot(ws, { extra: [overlay] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
    const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
    overlay.change((d: any) => { d.objects.o9.description = 'Hers' })
    // Folded (with what the clear saw), then cleared.
    ws.objectShard.update((d: any) => A.merge(d, A.change(serverBase, (d2: any) => { d2.objects.o9 = { ...objectEntity('o9', 'Created earlier'), description: 'Seen' } })))
    overlay.update((d: any) => A.merge(d, A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d2: any) => { delete d2.objects.o9 })))
    await expect.poll(() => shardObject(ws, 'o9')?.description, POLL).toBe('Hers')
    // Finished: her value is in the documents.
    await expect.poll(async () => (await probe()).overlayRescuesPending, { timeout: 8_000, interval: 50 }).toBe(0)
    // A colleague sets it back to what the clear saw.
    remoteChange(ws, (d) => { d.objects.o9.description = 'Seen' })
    expect(storeObject('o9')?.description).toBe('Seen')
    release()
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(storeObject('o9')?.description).toBe('Seen')
    expect(shardObject(ws, 'o9')?.description).toBe('Seen')
  })

  it('a tab removes only the findings it finished — another tab\'s persisted rescue stays', async () => {
    const ws = workspace()
    const store = await memoryStore()
    const KEY = 'overlay-clear-rescues:v1'
    const overlay = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Created earlier') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(overlay.url); m.editsObjectShardUrls = [overlay.url] })
    await boot(ws, { extra: [overlay] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
    const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
    overlay.change((d: any) => { d.objects.o9.description = 'Hers, this tab' })
    overlay.update((d: any) => A.merge(d, A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d2: any) => { delete d2.objects.o9 })))
    await expect.poll(async () => ((await store.get<any[]>(KEY)) ?? []).map((r) => r.id), POLL).toEqual(['o9'])
    // Another tab of the workspace persists ITS finding — and the same entity
    // found again there (a later finding: another `since`).
    const theirs = Date.now() + 1
    await store.update<any[]>(KEY, (stored) => [...(stored ?? []).filter((r) => r.id !== 'o9'),
      { collection: 'objects', id: 'o7', value: objectEntity('o7'), seen: objectEntity('o7'), since: Date.now() - 1_000 },
      { collection: 'objects', id: 'o9', value: { ...objectEntity('o9', 'Created earlier'), description: 'Theirs, another tab' }, seen: objectEntity('o9', 'Created earlier'), since: theirs }])
    // This tab finishes its own: the folded copy arrives, her field applied.
    ws.objectShard.update((d: any) => A.merge(d, A.change(serverBase, (d2: any) => { d2.objects.o9 = objectEntity('o9', 'Created earlier') })))
    await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o9')?.description, POLL).toBe('Hers, this tab')
    await expect.poll(async () => (await probe()).overlayRescuesPending, POLL).toBe(0)
    // Its own finding of o9 left; the other tab's — o7, and its own later finding of o9 — stay.
    await expect.poll(async () => ((await store.get<any[]>(KEY)) ?? []).map((r) => `${r.id}:${r.since === theirs ? 'theirs' : 'other'}`).sort(), POLL)
      .toEqual(['o7:other', 'o9:theirs'])
  })

  it('the rescue never puts an OLDER value over a later write of the same field', async () => {
    const ws = workspace()
    const overlay = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Created earlier') } })
    ws.m0.change((m: any) => { m.objectShardUrls.push(overlay.url); m.editsObjectShardUrls = [overlay.url] })
    await boot(ws, { extra: [overlay] })
    await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
    const serverOverlay = A.clone(overlay.doc()!, { actor: 'cc'.repeat(16) })
    const serverBase = A.clone(ws.objectShard.doc()!, { actor: 'cc'.repeat(16) })
    overlay.change((d: any) => { d.objects.o9.description = 'Hers, older' })
    // Folded, then the SAME field written again by the writer who keeps
    // typing (a later value the clear did not see either).
    const folded = A.change(serverBase, (d: any) => { d.objects.o9 = objectEntity('o9', 'Created earlier') })
    const later = A.change(folded, (d: any) => { d.objects.o9.description = 'Later, from the typist' })
    ws.objectShard.update((d: any) => A.merge(d, later))
    overlay.update((d: any) => A.merge(d, A.change(serverOverlay, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d2: any) => { delete d2.objects.o9 })))
    await expect.poll(() => useModelStore.getState().objects.find((o) => o.id === 'o9')?.description, POLL).toBe('Later, from the typist')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(useModelStore.getState().objects.find((o) => o.id === 'o9')?.description).toBe('Later, from the typist')
  })

  /** A follow of X whose find stays unanswered until `serve()`; the follow's
   * own network listener captured, so a test can play the server's frames. */
  async function unansweredFollow(options: { empty?: boolean } = {}) {
    const ws = workspace()
    // `empty`: this browser holds nothing of X yet (no heads).
    const emptyUrl = generateAutomergeUrl()
    const x: DocHandle<any> = options.empty
      ? ({ url: emptyUrl, documentId: emptyUrl.slice('automerge:'.length) } as unknown as DocHandle<any>)
      : repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })
    await boot(ws)
    const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
    const presented: number[] = []
    vi.spyOn(deniedRecoveryModule, 'resetDocumentSyncState').mockImplementation((_repo, documentId) => {
      if (documentId === x.documentId) presented.push(Date.now())
      return 1
    })
    const listeners: Array<(message: any) => void> = []
    const network = repoModule.repo.networkSubsystem as any
    const on = network.on.bind(network)
    vi.spyOn(network, 'on').mockImplementation((event: any, listener: any) => { if (event === 'message') listeners.push(listener); return on(event, listener) })
    let serve!: () => void
    const served = new Promise<void>((resolve) => { serve = resolve })
    vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
      if (urls.includes(x.url)) { await served; return [x] as any }
      return load(urls)
    })
    ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
    const frame = (type: string, documentId: string = x.documentId) => { for (const l of listeners) l({ type, documentId, senderId: 'server' }) }
    return { ws, x, presented, serve, frame }
  }

  it('the re-presentation is spaced EXPONENTIALLY and stopped by the answer', async () => {
    const { __setFollowFindRepresentForTest, FOLLOW_FIND_REPRESENT_MAX_DELAY_MS } = await import('./bridge')
    expect(FOLLOW_FIND_REPRESENT_MAX_DELAY_MS).toBe(30_000)
    __setFollowFindRepresentForTest(20, 10_000)
    try {
      // 20, 40, 80, 160 ms… — not every 20 ms. The waits the bridge ARMED
      // are asserted, not the machine's timing (on a loaded CI
      // machine, measured gaps were flaky).
      const spaced = await unansweredFollow()
      await expect.poll(() => spaced.presented.length, POLL).toBeGreaterThanOrEqual(4)
      expect((await probe()).followRepresentWaits.slice(0, 4)).toEqual([20, 40, 80, 160])
      // Stopped by the answer: nothing after it.
      spaced.serve()
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
      const atAnswer = spaced.presented.length
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(spaced.presented.length).toBe(atAnswer)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  it('only the document\'s SYNC frames hold it; one frame then silence is presented again; its listener leaves with the answer', async () => {
    const { __setFollowFindRepresentForTest } = await import('./bridge')
    __setFollowFindRepresentForTest(150, 150)
    try {
      const network = repoModule.repo.networkSubsystem as any
      const follow = await unansweredFollow()
      // One sync frame, then silence: held ONCE, then presented (DDh).
      follow.frame('sync')
      // The follow's own listener among the bridge's.
      const during = network.listenerCount('message')
      await expect.poll(() => follow.presented.length, POLL).toBeGreaterThanOrEqual(2)
      // Ephemeral and remote-heads traffic for it, and sync frames for
      // ANOTHER document, say nothing about this request (DDf).
      const before = follow.presented.length
      const other = setInterval(() => {
        follow.frame('ephemeral')
        follow.frame('remote-heads-changed')
        follow.frame('sync', 'another-document')
      }, 10)
      await expect.poll(() => follow.presented.length, POLL).toBeGreaterThanOrEqual(before + 2)
      clearInterval(other)
      // Answered: its listener is removed (DDg).
      follow.serve()
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
      await expect.poll(() => network.listenerCount('message'), POLL).toBe(during - 1)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  it('sync frames that bring NOTHING (the server\'s empty answer) do not hold the re-presentation', async () => {
    const { __setFollowFindRepresentForTest } = await import('./bridge')
    __setFollowFindRepresentForTest(60, 60)
    try {
      const follow = await unansweredFollow({ empty: true })
      const feeding = setInterval(() => follow.frame('sync'), 10)
      await expect.poll(() => follow.presented.length, POLL).toBeGreaterThanOrEqual(2)
      clearInterval(feeding)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  it('the re-presentation is BOUNDED — 15, however long the find stays unanswered', async () => {
    const { __setFollowFindRepresentForTest, FOLLOW_FIND_REPRESENT_MAX } = await import('./bridge')
    expect(FOLLOW_FIND_REPRESENT_MAX).toBe(15)
    __setFollowFindRepresentForTest(5, 5)
    try {
      const capped = await unansweredFollow()
      await expect.poll(() => capped.presented.length, POLL).toBe(15)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(capped.presented.length).toBe(15)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  it('held while sync frames arrive (a large shard on a slow link), presented on `doc-unavailable`, ended by the bridge\'s stop', async () => {
    const { __setFollowFindRepresentForTest, stopBridge } = await import('./bridge')
    __setFollowFindRepresentForTest(60, 60)
    try {
      const streaming = await unansweredFollow()
      const feeding = setInterval(() => streaming.frame('sync'), 10)
      await new Promise((resolve) => setTimeout(resolve, 400))
      clearInterval(feeding)
      expect(streaming.presented).toHaveLength(0)
      streaming.frame('sync')
      streaming.frame('doc-unavailable')
      await expect.poll(() => streaming.presented.length, POLL).toBe(1)
      // Bound to the session: the stop ends it (no frame comes any more).
      stopBridge()
      const atStop = streaming.presented.length
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(streaming.presented.length).toBe(atStop)
    } finally {
      __setFollowFindRepresentForTest(null)
    }
  })

  it('a given-up url is re-armed after FIVE minutes by default', async () => {
    const { FOLLOW_GIVEN_UP_REARM_MS } = await import('./bridge')
    expect(FOLLOW_GIVEN_UP_REARM_MS).toBe(5 * 60_000)
  })

  it('a url GIVEN UP is followed again at a change of the meta once the re-arm delay has passed — not before', async () => {
    const { __setFollowRetryDelaysForTest } = await import('./bridge')
    __setFollowRetryDelaysForTest([50], 600)
    try {
      const ws = workspace()
      await (await memoryStore()).set('epoch-capability:v1', true)
      const x = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })
      await boot(ws)
      const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
      let xAsks = 0
      let served = false
      vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
        if (urls.includes(x.url)) {
          xAsks += 1
          if (served) return [x] as any
          throw new Error('unavailable')
        }
        return load(urls)
      })
      ws.m0.change((m: any) => { m.objectShardUrls.push(x.url) })
      await expect.poll(async () => (await probe()).followFailures, POLL).toEqual([`${x.url}:1:given-up`])
      expect(xAsks).toBe(2)
      // Too soon: a change of the meta asks nothing.
      ws.m0.change((m: any) => { m.groups.g1 = { id: 'g1', name: 'G1' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(xAsks).toBe(2)
      // The server holds X now (claimed minutes later); past the delay, the
      // next change of the meta follows it.
      served = true
      await new Promise((resolve) => setTimeout(resolve, 650))
      ws.m0.change((m: any) => { m.groups.g2 = { id: 'g2', name: 'G2' } })
      await expect.poll(() => useModelStore.getState().objects.some((o) => o.id === 'o9'), POLL).toBe(true)
      expect(xAsks).toBe(3)
    } finally {
      __setFollowRetryDelaysForTest(null)
    }
  })

  it('a follow\'s load in flight when the hop swaps resolves AFTER it — the old meta\'s shard is not projected in the new epoch, its lease goes back', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const old = repoModule.repo.create<any>({ objects: { o6: objectEntity('o6') } })
    await boot(ws, { extra: [old] })
    const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
      if (urls.includes(old.url)) { repoModule.prepareDocumentRequest(old.url, 'model-shard'); await gate }
      return load(urls)
    })
    ws.m0.change((m: any) => { m.objectShardUrls.push(old.url) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    release()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await probe()).objectShards).not.toContain(old.documentId)
    expect(useModelStore.getState().objects.some((o) => o.id === 'o6')).toBe(false)
    expect(await leased(old.documentId)).toBe(false)
  })

  it('a shard listed between the boot\'s read of the list and its listener\'s attach is projected', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const n = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
    const spy = vi.spyOn(repoModule, 'getModelShardHandles')
    let listed = false
    const realBoot = boot(ws, { extra: [n] })
    // The boot's first load (m0's object shards): the compaction lands right after it.
    const load = await vi.waitFor(() => { const impl = spy.getMockImplementation(); if (!impl) throw new Error('not yet'); return impl })
    spy.mockImplementation(async (urls) => {
      const handles = await load(urls)
      if (!listed && urls.includes(ws.objectShard.url)) {
        listed = true
        ws.m0.change((m: any) => { m.objectShardUrls.push(n.url) })
      }
      return handles
    })
    await realBoot
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), POLL).toEqual(['o1', 'o7'])
  })

  it('the hop\'s invariant — an object in the store when the hop started, neither projected nor exported after it, is reported; a clean hop reports none', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    ws.objectShard.change((d: any) => { d.objects.o2 = objectEntity('o2') })
    await boot(ws)
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2'])
    // The new epoch lacks o2 (what the invariant exists to catch).
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect((await probe()).hopUnaccountedObjects).toEqual([])
    await expect.poll(async () => (await probe()).hopUnaccountedObjects, { ...POLL, timeout: 10_000 }).toEqual(['o2'])
  }, 20_000)

  it('deletes in the new epoch within the 5 s — another user\'s, and hers — are not reported; a loss still is', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const both = (d: any) => { d.objects.o2 = objectEntity('o2'); d.objects.o3 = objectEntity('o3') }
    ws.objectShard.change(both)
    ws.nextShard.change(both)
    ws.objectShard.change((d: any) => { d.objects.o4 = objectEntity('o4') })
    await boot(ws)
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    // Paul deletes o2 in the new epoch; Marie deletes o3.
    ws.nextShard.change((d: any) => { delete d.objects.o2 })
    useModelStore.getState().deleteObject('o3')
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), POLL).toEqual(['o1'])
    // o4, absent from the new epoch (a loss), is the only alert.
    await expect.poll(async () => (await probe()).hopUnaccountedObjects, { ...POLL, timeout: 10_000 }).toEqual(['o4'])
  }, 20_000)

  it('on the RETIRED path, an object only a retired shard held is an export line, not an alert', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    ws.objectShard.change((d: any) => { d.objects.o2 = objectEntity('o2') })
    for (const doc of [ws.m0, ws.objectShard]) answers.set(doc.documentId, { documentId: doc.documentId, durable: false, forwarded: false, epochRetired: true })
    await boot(ws)
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    expect(useModelStore.getState().objects.map((o) => o.id)).toEqual(['o1'])
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    expect((await probe()).hopUnaccountedObjects).toEqual([])
  }, 20_000)

  it('a shard a compaction lists in the NEW meta between the hop\'s load and its swap is projected after the swap', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const n = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
    await boot(ws, { extra: [n] })
    const load = vi.mocked(repoModule.getModelShardHandles).getMockImplementation()!
    vi.mocked(repoModule.getModelShardHandles).mockImplementation(async (urls) => {
      const handles = await load(urls)
      // The hop's load of m1's list: the compaction lands right after it.
      if (urls.includes(ws.nextShard.url) && !(ws.m1.doc() as any).objectShardUrls.includes(n.url)) {
        ws.m1.change((m: any) => { m.objectShardUrls.push(n.url) })
      }
      return handles
    })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), POLL).toEqual(['o1', 'o7'])
  })

  it('between S6b and S7 (the root on the new meta, no `superseded` row yet) the hop does not swap — an own shard not durable would be carried over its copy; it swaps once the old meta is answered `forwarded`', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const entities = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, objectEntity(id)]))
    const full = repoModule.repo.create<any>({ objects: entities(['o1']) })
    const x = repoModule.repo.create<any>({ objects: entities(['o4']) })
    ws.m0.change((m: any) => { m.objectShardUrls.splice(0, m.objectShardUrls.length, full.url, x.url) })
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    const fullCopy = repoModule.repo.create<any>({ objects: entities(['o1']) })
    const xPrime = repoModule.repo.create<any>({ objects: entities(['o4']) })
    const m1 = repoModule.repo.create<any>({
      objectShardUrls: [fullCopy.url, xPrime.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 1, epochPredecessorRef: new ImmutableString(ws.m0.url),
    })
    await boot(ws, { extra: [full, x, fullCopy, xPrime], metas: [m1], held: [x] })
    // The window: no epoch row, so no bit on any answer; X not durable.
    answers.set(ws.m0.documentId, { documentId: ws.m0.documentId, durable: true } as any)
    answers.set(full.documentId, { documentId: full.documentId, durable: true } as any)
    answers.set(x.documentId, { documentId: x.documentId, durable: false } as any)
    ws.root.change((r: any) => { r.modelMetaUrl = m1.url })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect((await probe()).bootedMetaUrl).toBe(ws.m0.url)
    // S7: every old document superseded — X a source the roll cut.
    answers.clear()
    await expect.poll(async () => (await probe()).bootedMetaUrl, { ...POLL, timeout: 20_000 }).toBe(m1.url)
    expect((await probe()).objectShards).not.toContain(x.documentId)
  }, 30_000)

  it('an OWN shard a full roll recreated (X → X′ in place) is not carried over its copy — retained as a late source, and the next object keeps X′ whole', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const entities = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, objectEntity(id)]))
    const full = repoModule.repo.create<any>({ objects: entities(['o1', 'o2', 'o3']) })
    // X: this browser's overflow (random id), listed in m0 — the offline
    // write's entry still queued, so the boot takes it as the tab's own.
    const x = repoModule.repo.create<any>({ objects: entities(['o4']) })
    ws.m0.change((m: any) => { m.objectShardUrls.splice(0, m.objectShardUrls.length, full.url, x.url) })
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    // The FULL roll: every base shard of the list recreated, X included.
    const fullCopy = repoModule.repo.create<any>({ objects: entities(['o1', 'o2', 'o3']) })
    const xPrime = repoModule.repo.create<any>({ objects: entities(['o4']) })
    const m1 = repoModule.repo.create<any>({
      objectShardUrls: [fullCopy.url, xPrime.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 1, epochPredecessorRef: new ImmutableString(ws.m0.url),
    })
    await boot(ws, { extra: [full, x, fullCopy, xPrime], metas: [m1], held: [x] })
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4'])
    ws.root.change((r: any) => { r.modelMetaUrl = m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m1.url)
    // The server answered X `forwarded` (a superseded epoch document).
    expect((await probe()).objectShards).not.toContain(x.documentId)
    const id = useModelStore.getState().addObject({
      type: 'container', name: 'After the hop', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    } as any)
    await expect.poll(() => Object.keys((xPrime.doc() as any).objects).sort(), POLL).toEqual([id, 'o4'].sort())
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual([id, 'o1', 'o2', 'o3', 'o4'].sort())
  })

  it('an answer about ANOTHER workspace never sets the capability; this session\'s does', async () => {
    const ws = workspace()
    await boot(ws)
    expect((await probe()).epochCapability).toBe(false)
    expect(listener).not.toBeNull()
    listener!(true, 'landscapeId=other&versionId=elsewhere')
    expect((await probe()).epochCapability).toBe(false)
    listener!(true, withWorkspaceParams(''))
    expect((await probe()).epochCapability).toBe(true)
  })

  it('a persisted retired export is raised when the capability is learned from an ack — the boot did not know it', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-retired-export:v1', {
      version: 1, metaUrl: '', collectedAt: 'then',
      differences: [{ kind: 'object', id: 'o9', local: { name: 'Lost?' }, current: null }],
    })
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    await boot(ws)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useEpochHopStore.getState().retired).toBeNull()
    listener!(true, withWorkspaceParams(''))
    await expect.poll(() => useEpochHopStore.getState().retired?.differences.map((d) => d.id), POLL).toEqual(['o9'])
  })

  it('the hop\'s retired documents leave the durable ledger once their export\'s write has SETTLED — not while it runs; and when it FAILS (a private window, no IndexedDB) too: the export is shown for the session, and the badge no longer stays "Saving" asking every 750 ms', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const retired = (documentId: string) => ({ documentId, durable: false, forwarded: false, epochRetired: true })
    answers.set(ws.m0.documentId, retired(ws.m0.documentId))
    answers.set(ws.objectShard.documentId, retired(ws.objectShard.documentId))
    const update = store.update.bind(store)
    let refuse!: (error: Error) => void
    const write = new Promise<never>((_resolve, reject) => { refuse = reject })
    vi.spyOn(store, 'update').mockImplementation(((key: string, updater: unknown) =>
      (key === 'epoch-retired-export:v1' ? write : update(key, updater as never))) as never)
    await boot(ws)
    useModelStore.getState().updateObject('o1', { name: 'Edited offline' } as any)
    await new Promise((resolve) => setTimeout(resolve, 100))
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The write still running: still owed (a crash now loses neither).
    expect((await probe()).durablePending).toContain(ws.objectShard.documentId)
    refuse(new Error('no IndexedDB'))
    // Failed: shown for the session, and no longer owed.
    await expect.poll(async () => (await probe()).durablePending, POLL).not.toContain(ws.objectShard.documentId)
    const { useEpochHopStore } = await import('../../stores/epochHopStore')
    expect(useEpochHopStore.getState().retired?.differences.map((d) => d.id)).toEqual(['o1'])
  })

  it('a repoint with the capability unknown probes the server; stopping the bridge leaves no probe pending', async () => {
    const ws = workspace()
    await boot(ws)
    const asks = () => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls.length
    const before = asks()
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(asks, POLL).toBeGreaterThan(before)
    expect((await probe()).repointProbePending).toBe(true) // the 2 s step is armed
    const { stopBridge } = await import('./bridge')
    stopBridge()
    expect((await probe()).repointProbePending).toBe(false)
  })

  it('the tab\'s actors are journaled WITHOUT the capability (an offline edit before the first roll stays reviewable)', async () => {
    const ws = workspace()
    await boot(ws)
    expect((await probe()).epochCapability).toBe(false)
    useModelStore.getState().updateObject('o1', { name: 'Offline edit' })
    await expect.poll(() => (ws.objectShard.doc() as any).objects.o1.name, POLL).toBe('Offline edit')
    await expect.poll(async () => ((await (await memoryStore()).get<string[]>('epoch-actors:v1')) ?? []).length, POLL).toBeGreaterThan(0)
  })

  it('the swap PERSISTS its lineage link (a reload walks it without a load)', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    await boot(ws)
    const key = (await probe()).lineageKey
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    await expect.poll(async () => (await memoryStore()).get(key), POLL).toMatchObject({ [ws.m1.documentId]: ws.m0.documentId })
  })

  it('the override ports — `serverHolds` says RETIRED for a retired carrier, and `carrierHeads` reads a carrier the tab projects even when the repo cache does not name it', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const install = vi.spyOn(controllerModule, 'installEpochOverrides')
    await boot(ws)
    await expect.poll(() => install.mock.calls.length, POLL).toBeGreaterThan(0)
    const ports = install.mock.calls.at(-1)![0]
    const heads = [{ documentId: ws.objectShard.documentId, heads: A.getHeads(ws.objectShard.doc()!) }]
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: false, forwarded: false, epochRetired: true })
    expect(await ports.serverHolds(heads)).toBe('retired')
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: true })
    expect(await ports.serverHolds(heads)).toBe(true)
    answers.set(ws.objectShard.documentId, { documentId: ws.objectShard.documentId, durable: false })
    expect(await ports.serverHolds(heads)).toBe(false)
    // A projected carrier the repo cache lookup misses is still read.
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === ws.objectShard.documentId ? undefined : realSynced(r, id)) as any)
    expect(ports.carrierHeads([ws.objectShard.documentId])).toEqual(heads)
  })

  it('the override port `signedIn` — true with a user under an auth stage other than `off`, false with auth off or no user', async () => {
    const ws = workspace()
    await (await memoryStore()).set('epoch-capability:v1', true)
    const install = vi.spyOn(controllerModule, 'installEpochOverrides')
    await boot(ws)
    await expect.poll(() => install.mock.calls.length, POLL).toBeGreaterThan(0)
    const ports = install.mock.calls.at(-1)![0]
    const { useAuthStore } = await import('../../stores/authStore')
    const before = useAuthStore.getState()
    const user = { id: 'u-1', email: 'marie@example.test' } as any
    try {
      useAuthStore.setState({ config: { ...(before.config ?? {}), stage: 'on' } as any, user })
      expect(await ports.signedIn!()).toBe(true)
      useAuthStore.setState({ config: { ...(before.config ?? {}), stage: 'off' } as any, user })
      expect(await ports.signedIn!()).toBe(false)
      useAuthStore.setState({ config: { ...(before.config ?? {}), stage: 'on' } as any, user: null })
      expect(await ports.signedIn!()).toBe(false)
    } finally {
      useAuthStore.setState({ config: before.config, user: before.user })
    }
  })

  it('the override port reads the profile\'s actor journal AGAIN at each refresh — an actor another open tab of Marie recorded since this one booted is asked with', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const install = vi.spyOn(controllerModule, 'installEpochOverrides')
    await boot(ws)
    await expect.poll(() => install.mock.calls.length, POLL).toBeGreaterThan(0)
    const ports = install.mock.calls.at(-1)![0]
    const before = await ports.actorIds()
    const otherTab = 'ab'.repeat(16)
    expect(before).not.toContain(otherTab)
    // Marie's other tab journals its actor (the same profile's store).
    await store.update<string[]>('epoch-actors:v1', (old) => [...(old ?? []), otherTab])
    const after = await ports.actorIds()
    expect(after).toContain(otherTab)
    expect(after).toEqual(expect.arrayContaining(before))
  })

  it('the actor journal is MERGED in one atomic update — never read, then written (two tabs would drop each other\'s actor)', async () => {
    const ws = workspace()
    const store = await memoryStore()
    const otherTab = 'ab'.repeat(16)
    await store.set('epoch-actors:v1', [otherTab])
    const set = vi.spyOn(store, 'set')
    const update = vi.spyOn(store, 'update')
    await boot(ws)
    useModelStore.getState().updateObject('o1', { name: 'Edit' })
    await expect.poll(async () => ((await store.get<string[]>('epoch-actors:v1')) ?? []).length, POLL).toBeGreaterThan(1)
    expect((await store.get<string[]>('epoch-actors:v1'))).toContain(otherTab)
    expect(update.mock.calls.some(([key]) => key === 'epoch-actors:v1')).toBe(true)
    expect(set.mock.calls.some(([key]) => key === 'epoch-actors:v1')).toBe(false)
  })

  /** An own shard a full roll recreated in place: X, this browser's
   * random-id overflow listed in m0, and a FULL roll m1 that recreated it as
   * X′. */
  function ownShardCutByRoll(ws: Workspace) {
    const entities = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, objectEntity(id)]))
    const full = repoModule.repo.create<any>({ objects: entities(['o1', 'o2', 'o3']) })
    const x = repoModule.repo.create<any>({ objects: entities(['o4']) })
    ws.m0.change((m: any) => { m.objectShardUrls.splice(0, m.objectShardUrls.length, full.url, x.url) })
    const fullCopy = repoModule.repo.create<any>({ objects: entities(['o1', 'o2', 'o3']) })
    const xPrime = repoModule.repo.create<any>({ objects: entities(['o4']) })
    const m1 = repoModule.repo.create<any>({
      objectShardUrls: [fullCopy.url, xPrime.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 1, epochPredecessorRef: new ImmutableString(ws.m0.url),
    })
    return { full, x, fullCopy, xPrime, m1 }
  }

  it('on the RETIRED path too — an own shard the server answers `epochRetired` is not carried over its copy', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { full, x, fullCopy, xPrime, m1 } = ownShardCutByRoll(ws)
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    // Retired: not durable, no `forwarded` bit — only `epochRetired` names it.
    answers.set(x.documentId, { documentId: x.documentId, durable: false, epochRetired: true })
    await boot(ws, { extra: [full, x, fullCopy, xPrime], metas: [m1], held: [x] })
    // A RETIRED shard is never durable — its entry leaves at once.
    await expect.poll(async () => store.get('deferred-references:v1'), POLL).toEqual([])
    ws.root.change((r: any) => { r.modelMetaUrl = m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m1.url)
    expect(((await probe()).state as { phase: string }).phase).toBe('retired')
    expect((await probe()).objectShards).not.toContain(x.documentId)
    expect((await probe()).objectShards).toContain(xPrime.documentId)
  })

  it('a late source named by a hop that never swapped does not count for the NEXT hop — the own shard is carried there', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { full, x, fullCopy, xPrime, m1 } = ownShardCutByRoll(ws)
    await store.set('deferred-references:v1', [{ holderDocumentId: ws.m0.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    const m2Shard = repoModule.repo.create<any>({ objects: Object.fromEntries(['o1', 'o2', 'o3'].map((id) => [id, objectEntity(id)])) })
    const m2 = repoModule.repo.create<any>({
      objectShardUrls: [m2Shard.url], connectionShardUrls: [ws.connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, modelEpoch: 2, epochPredecessorRef: new ImmutableString(ws.m0.url),
    })
    // Hop 1 (to m1): X is answered `forwarded` (a late source), and the latch
    // is never acknowledged — no swap.
    let phase = 1
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (phase === 1 && options?.latch) return new Promise<never>(() => undefined)
      return documents.map(({ documentId }) => (phase === 2 && documentId === x.documentId
        ? { documentId, durable: true } // hop 2: an ordinary document
        : { documentId, durable: true, forwarded: true, targetHeads: [] })) as any
    })
    await boot(ws, { extra: [full, x, fullCopy, xPrime, m2Shard], metas: [m1, m2], held: [x] })
    ws.root.change((r: any) => { r.modelMetaUrl = m1.url })
    await expect.poll(async () => ((await probe()).state as { phase: string }).phase, POLL).toBe('backoff')
    // The root goes back (hop 1 cancelled), then on to m2.
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m0.url })
    await expect.poll(async () => ((await probe()).state as { phase: string }).phase, POLL).toBe('idle')
    phase = 2
    ws.root.change((r: any) => { r.modelMetaUrl = m2.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(m2.url)
    expect((await probe()).objectShards).toContain(x.documentId)
    expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o4')
  }, 15_000)

  /** m0's predecessor `ePrev` is a meta only the NETWORK has; a MINTED
   * pointer is held on ITS predecessor `holder` — set aside at the boot (the
   * local walk stops at ePrev), resumed after the background walk. */
  function pointerHeldOnNetworkMeta(ws: Workspace) {
    const holder = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url] })
    const ePrev = repoModule.repo.create<any>({
      objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(holder.url),
    })
    ws.m0.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(ePrev.url) })
    ws.m1.change((m: any) => { m.modelEpoch = 3 })
    const held = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9', 'Held O9') } })
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === ePrev.documentId ? undefined : realSynced(r, id)) as any)
    let release: () => void = () => undefined
    const arrives = new Promise<void>((resolve) => { release = resolve })
    const findMeta = async (url: string) => { if (url !== ePrev.url) return undefined; await arrives; return ePrev }
    return { ePrev: holder, held, releaseWalk: () => release(), findMeta }
  }

  it('a hop that swaps DURING the walk — the entry is resumed against the NEW meta, its shard adopted there and its pointer written into it', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { ePrev, held, releaseWalk, findMeta } = pointerHeldOnNetworkMeta(ws)
    await store.set('deferred-references:v1', [{ holderDocumentId: ePrev.documentId, field: 'objectShardUrls', url: held.url }])
    await boot(ws, { extra: [held], held: [held], findMeta })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o9')
    releaseWalk()
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o9')
    expect((await probe()).objectShards.filter((id) => id === held.documentId)).toHaveLength(1)
    // Acknowledged (every document is, here): published into m1, the meta projected now.
    await expect.poll(() => [...(ws.m1.doc() as any).objectShardUrls], POLL).toContain(held.url)
    expect((ws.m0.doc() as any).objectShardUrls).not.toContain(held.url)
  })

  it('a REPOINT to another lineage during the walk resurrects nothing — the entry stays for the next boot, uncounted, its shard never adopted nor written', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { ePrev, held, releaseWalk, findMeta } = pointerHeldOnNetworkMeta(ws)
    const reference = { holderDocumentId: ePrev.documentId, field: 'objectShardUrls', url: held.url }
    await store.set('deferred-references:v1', [reference])
    await boot(ws, { extra: [held], held: [held], findMeta })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.repaired.url })
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.repaired.url)
    releaseWalk()
    await expect.poll(async () => (await probe()).predecessorMetas, POLL).toContain(ePrev.documentId)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o9')
    expect((await probe()).objectShards).not.toContain(held.documentId)
    expect((ws.repaired.doc() as any).objectShardUrls).not.toContain(held.url)
    expect(await store.get('deferred-references:v1')).toEqual([reference])
  })

  /** m0 (epoch 1) succeeds `oldMeta`, which lists X — this browser's
   * random-id overflow, its entry still queued — and m1 (epoch 2) succeeds m0.
   * Neither m0 nor m1 lists X. */
  function provisionalX(ws: Workspace) {
    const x = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4', 'Only in X') } })
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url, x.url], connectionShardUrls: [ws.connectionShard.url] })
    ws.m0.change((m: any) => { m.modelEpoch = 1; m.epochPredecessorRef = new ImmutableString(oldMeta.url) })
    ws.m1.change((m: any) => { m.modelEpoch = 2 })
    const reference = { holderDocumentId: oldMeta.documentId, field: 'objectShardUrls', url: x.url, unminted: true }
    return { x, reference }
  }

  it('a hop while X is PROVISIONAL — X stays on the screen, still provisional and not the tab\'s own, its pointer written into neither meta; the late "held" then takes it off against the NEW meta', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { x, reference } = provisionalX(ws)
    await store.set('deferred-references:v1', [reference])
    let answerX = false
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      // X: no line (no answer) until `answerX`; then held as an ordinary document.
      return documents.filter(({ documentId }) => documentId !== x.documentId || answerX)
        .map(({ documentId }) => (documentId === x.documentId ? { documentId, durable: true } : { documentId, durable: true, forwarded: true, targetHeads: [] })) as any
    })
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [400] })
    try {
      await boot(ws, { extra: [x], held: [x] })
      await expect.poll(async () => (await probe()).provisionalShards, POLL).toEqual([x.url])
      ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
      await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
      // Carried by the swap (its author keeps seeing it), still PROVISIONAL.
      expect((await probe()).objectShards).toContain(x.documentId)
      expect((await probe()).provisionalShards).toEqual([x.url])
      expect(useModelStore.getState().objects.find((o) => o.id === 'o4')?.name).toBe('Only in X')
      expect((ws.m0.doc() as any).objectShardUrls).not.toContain(x.url)
      expect((ws.m1.doc() as any).objectShardUrls).not.toContain(x.url)
      // A new object after the hop does not go into X either.
      const id = useModelStore.getState().addObject({
        type: 'container', name: 'After the hop', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
      } as any)
      await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain(id)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(Object.keys((x.doc() as any).objects)).toEqual(['o4'])
      // The late answer: held — m1 does not list X: off the screen.
      answerX = true
      await expect.poll(async () => (await probe()).objectShards, POLL).not.toContain(x.documentId)
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o4')
      expect((ws.m1.doc() as any).objectShardUrls).not.toContain(x.url)
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('the provisional show and the late "held" BOTH held back by one latch run in their order — X is not on the screen after the swap', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { x, reference } = provisionalX(ws)
    await store.set('deferred-references:v1', [reference])
    let openGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let releaseLatch: () => void = () => undefined
    const latchAnswered = new Promise<void>((resolve) => { releaseLatch = resolve })
    let xAsks = 0
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (options?.latch) await latchAnswered
      if (documents.length === 1 && documents[0]!.documentId === x.documentId) {
        await gate
        xAsks += 1
        // The first question finds nobody; the retry: held.
        return (xAsks === 1 ? [] : [{ documentId: x.documentId, durable: true }]) as any
      }
      return documents.map(({ documentId }) => ({ documentId, durable: true, forwarded: true, targetHeads: [] })) as any
    })
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [20], timeoutMs: 60_000 })
    try {
      await boot(ws, { extra: [x], held: [x] })
      ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
      await expect.poll(async () => ((await probe()).state as { phase: string }).phase, { timeout: 5_000, interval: 5 }).toBe('latched')
      openGate()
      await expect.poll(() => xAsks, { timeout: 1_500, interval: 5 }).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 30))
      // Both held back: nothing changed yet.
      expect((await probe()).objectShards).not.toContain(x.documentId)
      releaseLatch()
      await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect((await probe()).objectShards).not.toContain(x.documentId)
      expect((await probe()).provisionalShards).toEqual([])
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o4')
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('an adoption that comes DURING a hop\'s latch waits for the swap — and a write made by code in the latch reaches the old epoch, not lost under the adoption\'s projection', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set('epoch-capability:v1', true)
    const { ePrev, held, releaseWalk, findMeta } = pointerHeldOnNetworkMeta(ws)
    await store.set('deferred-references:v1', [{ holderDocumentId: ePrev.documentId, field: 'objectShardUrls', url: held.url }])
    let releaseLatch: () => void = () => undefined
    const latchAnswered = new Promise<void>((resolve) => { releaseLatch = resolve })
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (options?.latch) await latchAnswered
      return documents.map(({ documentId }) => ({ documentId, durable: true, forwarded: true, targetHeads: [] })) as any
    })
    await boot(ws, { extra: [held], held: [held], findMeta })
    ws.root.change((r: any) => { r.modelMetaUrl = ws.m1.url })
    await expect.poll(async () => ((await probe()).state as { phase: string }).phase, { timeout: 5_000, interval: 5 }).toBe('latched')
    // A write by code (input is blocked): deferred by the latch.
    useModelStore.getState().updateObject('o1', { name: 'Written in the latch' })
    await expect.poll(async () => (await probe()).writesDeferredByLatch, { timeout: 1_000, interval: 5 }).toBeGreaterThan(0)
    // The walk ends now: its adoption is held back.
    releaseWalk()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o9')
    expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).toBe('Written in the latch')
    releaseLatch()
    await expect.poll(async () => (await probe()).bootedMetaUrl, POLL).toBe(ws.m1.url)
    // The swap wrote the deferred write to the OLD epoch (retained, forwarded).
    expect((ws.objectShard.doc() as any).objects.o1.name).toBe('Written in the latch')
    // Then the held-back adoption ran, in the new epoch.
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o9')
    expect((await probe()).objectShards.filter((id) => id === held.documentId)).toHaveLength(1)
  })
})
