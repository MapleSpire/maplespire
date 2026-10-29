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
 * A write into a container the document does not hold yet.
 *
 * Inside an Automerge change callback, `(d.f ??= {})` / `(d.f ??= []).push(v)`
 * evaluates to the PLAIN `{}` / `[]` that was assigned, not the proxy the
 * document now holds — so when `d.f` was absent, every write through that
 * value lands on a detached object and the document keeps an EMPTY container.
 * Silently: no throw, no warning, and the intent acknowledgement downstream
 * reads the flush as success. Measured with @automerge/automerge 3.2.6:
 * `A.change(d, x => { (x.c ??= []).push('v') })` persists `c: []`.
 *
 * Driven through the REAL bridge with REAL Automerge handles on the module
 * repo, repo resolvers spied (the bridgeSummaryDelete.test.ts pattern), and
 * every fixture starts from a document that LACKS the field. Each case reads
 * the DOCUMENT afterwards, never the store: the store is what the user typed,
 * the document is what a reload gets back.
 */

// @vitest-environment jsdom
// jsdom, not node: startBridge's success path wires real window/document
// listeners, and under node the bare `window` access reads as a boot failure.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { pendingEntityIntents, type EntityIntentKind } from './entityIntents'
import {
  __setClientTimelineEnabledForTest,
  readClientTimeline,
  resetClientTimeline,
} from '../observability/clientTimeline'
import type { ModelMeta, RegistryShard, RootDoc } from './types'

/** In-memory KvStore: the crash journal's durable surface, so what the second
 * session replays is exactly what a crash would have kept on disk. */
const kv = new Map<string, unknown>()
vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value) },
    del: async (key: string) => { kv.delete(key) },
    update: async (key: string, fn: (value: unknown) => unknown) => {
      kv.set(key, fn(kv.get(key)))
    },
  }),
}))

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
}))
vi.mock('../modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
vi.mock('../modelQuery/diagramMeta', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramMeta')>(),
  fetchDiagramMeta: mocks.fetchDiagramMeta,
}))
vi.mock('../modelQuery/diagramRender', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramRender')>(),
  fetchDiagramRender: mocks.fetchDiagramRender,
}))

const SERVER_OWNED = 'dg-server-owned'
const CLASSIC = 'dg-classic'
const BFS_FLAG = 'maplespire:bootFromServer'

function diagramMeta(id: string, name: string, docUrl = '') {
  return { id, name, type: 'container', docUrl, objectIds: [], connectionIds: [], groupIds: [] }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The write scheduler's `normal` trailing edge is 150 ms of REAL time. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await settle()
}

/** The journalled entity intents as a crash would find them on disk. */
function journaledIds(kind: string): string[] {
  const out: string[] = []
  for (const [key, value] of kv) {
    if (!key.includes('entity-intents') || !Array.isArray(value)) continue
    for (const intent of value as Array<{ kind: string; id: string }>) {
      if (intent.kind === kind) out.push(intent.id)
    }
  }
  return out
}

/**
 * A summary-only workspace whose overlay WRITE HEADS have never been written
 * by a batch: `{ objects: {} }` with no `writeBatchIds` — what a freshly
 * rotated head, or one minted before batch ids existed, looks like.
 */
function summaryFixture(options: {
  objectHead?: Record<string, unknown>
  connectionHead?: Record<string, unknown>
} = {}) {
  const objectBase = repo.create<Record<string, unknown>>({ objects: {} })
  const connectionBase = repo.create<Record<string, unknown>>({ connections: {} })
  const objectHead = repo.create<Record<string, unknown>>(options.objectHead ?? { objects: {}, writeHeadVersion: 1 })
  const connectionHead = repo.create<Record<string, unknown>>(
    options.connectionHead ?? { connections: {}, writeHeadVersion: 1 },
  )
  const meta = repo.create<ModelMeta>({
    objectShardUrls: [objectBase.url],
    connectionShardUrls: [connectionBase.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  } as unknown as ModelMeta)
  const writeHead = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const registryBase = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registryBase.url],
    registryWriteUrl: writeHead.url,
    registrySummaryOnly: true,
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { objectHead, connectionHead }
}

/**
 * An ORDINARY sharded workspace, bootable both ways: boot-from-server when the
 * flag is set (the only mode that journals intents), resident without it.
 * Its one diagram's DiagramDoc lacks `comments` and `flows`; its ModelMeta
 * lacks `groups` — the shapes the replay must create, not assume. `metaOmit`
 * drops further ModelMeta maps; `objectShard` replaces the base object shard.
 */
function classicFixture(options: {
  metaOmit?: string[]
  metaExtra?: Record<string, unknown>
  objectShard?: Record<string, unknown>
} = {}) {
  const objectShard = repo.create<Record<string, unknown>>(options.objectShard ?? { objects: {} })
  const connectionShard = repo.create<Record<string, unknown>>({ connections: {} })
  const diagramDoc = repo.create<Record<string, unknown>>({
    name: 'Classic', type: 'container', objectIds: [], connectionIds: [], groupIds: [],
    layouts: {}, checkpoints: [],
  })
  // Usable overlay write heads, or boot-from-server is refused for this
  // workspace and session 1 would journal nothing.
  const objectHead = repo.create<Record<string, unknown>>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
  const connectionHead = repo.create<Record<string, unknown>>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
  const metaInit: Record<string, unknown> = {
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
    ...options.metaExtra,
  }
  for (const key of options.metaOmit ?? []) delete metaInit[key]
  const meta = repo.create<ModelMeta>(metaInit as unknown as ModelMeta)
  const registry = repo.create<RegistryShard>({
    diagrams: { [CLASSIC]: diagramMeta(CLASSIC, 'Classic', diagramDoc.url) },
  } as unknown as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registry.url],
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registry] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      if (url === objectShard.url) return objectShard
      if (url === connectionShard.url) return connectionShard
      if (url === objectHead.url) return objectHead
      if (url === connectionHead.url) return connectionHead
      throw new Error(`unexpected model shard url ${url}`)
    }) as any)
  return { meta, diagramDoc, objectShard }
}

function resetStores(): void {
  useModelStore.setState({
    objects: [], connections: [], groups: [], domains: [], tags: [],
    diagrams: [], comments: [], flows: [], decisionRecords: [],
    currentDiagramId: null, selectedItems: [], workspaceReadOnly: false,
    pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [], pendingDeletedDiagramIds: [],
    deletedDiagramIds: [],
  })
  useAutomergeStatus.setState({
    status: 'connecting', ready: false, visualReady: false, editReady: false,
    projectedWorkspace: null, error: null, bootFallbackActive: false,
    workspaceContractStale: false,
  })
}

const CLASSIC_REF = { landscapeId: 'absent-container', versionId: 'current' }

/**
 * Session 1 (boot-from-server, the mode that journals) records `act`'s intent
 * and never reaches durable storage; the kill is then reconstructed on the
 * DOCUMENTS by `wound` (the field the write created in memory is gone, so the
 * next process opens a document that never had it). Session 2 boots RESIDENT
 * on the same journal — the mode where a replayed intent is acknowledged
 * straight off the replay's own flush, so the replay write is the ONLY
 * expression the value will ever get.
 */
async function crashThenReplay(options: {
  act: () => string
  kind: EntityIntentKind
  /** Remove the container from the carrier, as the next process would open it. */
  wound: () => void
  /** The container on the carrier DOCUMENT (undefined while absent). */
  container: () => Record<string, unknown> | undefined
}): Promise<{ id: string; carriedWhenForgotten: unknown; containerWhenForgotten: string; forgotten: boolean }> {
  const { act, kind, wound, container } = options
  const carried = (id: string) => container()?.[id]
  localStorage.setItem(BFS_FLAG, 'true')
  const blockedFlush = vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>(() => {}))
  const bridge = await import('./bridge')
  await bridge.startBridge(CLASSIC_REF)
  // Anti-void guard: session 1 really is the journaling mode on CLASSIC.
  expect(bridge.isBootFromServerActive()).toBe(true)
  expect(useModelStore.getState().currentDiagramId).toBe(CLASSIC)
  const id = act()
  await settleWrites()
  bridge.stopBridge()
  blockedFlush.mockRestore()
  // Anti-void guards: the intent survived the session on disk, and the
  // carrier the next process opens really lacks the container.
  expect(journaledIds(kind)).toContain(id)
  wound()
  expect(container()).toBeUndefined()

  // THE WITNESS RULE, read at the only moment it matters: when the journal
  // forgets the intent, the document must already hold the value. An
  // end-state read alone is not enough — in resident mode a LATER flushWrite
  // re-expresses comments/flows from the store the replay injected, which
  // hides an empty replay write behind a green end state while the intent was
  // forgotten over a document that held nothing (measured on the unfixed
  // bridge: the replay's change left `comments: {}`, the 150 ms flushWrite
  // filled it). Read through the journal's own `acknowledge`, the one place
  // an intent is forgotten, with the call passed through untouched.
  let carriedWhenForgotten: unknown
  let containerWhenForgotten = 'never forgotten'
  let forgotten = false
  const acknowledge = pendingEntityIntents.acknowledge.bind(pendingEntityIntents)
  vi.spyOn(pendingEntityIntents, 'acknowledge').mockImplementation((workspaceKey, ackKind, ids, through) => {
    const before = pendingEntityIntents.has(workspaceKey, kind, id)
    acknowledge(workspaceKey, ackKind, ids, through)
    if (!forgotten && before && !pendingEntityIntents.has(workspaceKey, kind, id)) {
      forgotten = true
      carriedWhenForgotten = carried(id)
      containerWhenForgotten = `${kind} container when forgotten: ${JSON.stringify(container())}`
    }
  })
  localStorage.removeItem(BFS_FLAG)
  resetStores()
  await bridge.startBridge(CLASSIC_REF)
  // Anti-void guard: session 2 is resident, the replay's acknowledging mode.
  expect(bridge.isBootFromServerActive()).toBe(false)
  expect(useModelStore.getState().currentDiagramId).toBe(CLASSIC)
  await settleWrites()
  return { id, carriedWhenForgotten, containerWhenForgotten, forgotten }
}

describe('a write into a container the document does not hold yet', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({
      items: [diagramMeta(SERVER_OWNED, 'Owned by the server')],
      nextCursor: null,
      total: 10_000,
    })
    mocks.fetchDiagramMeta.mockResolvedValue({
      meta: diagramMeta(SERVER_OWNED, 'Owned by the server'),
      diagram: {
        id: SERVER_OWNED, name: 'Owned by the server', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      },
      comments: [],
      flows: [],
    })
    resetStores()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('an object edit on an overlay head with no `writeBatchIds` records its batch id in the document', async () => {
    // The batch id is the replay's crash witness: a tab that dies after the
    // doc write but before the acknowledgement finds `batchId ∈ writeBatchIds`
    // and acknowledges instead of re-asserting a stale value. A batch id pushed
    // onto a detached `[]` is a witness that was never written.
    const { objectHead } = summaryFixture()
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
    // Anti-void guard: the premise — the head really lacks the field.
    expect('writeBatchIds' in (objectHead.doc() as any)).toBe(false)

    const id = useModelStore.getState().addObject({
      type: 'system', name: 'Billing', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    } as any)
    await settleWrites()

    const head = objectHead.doc() as any
    // The value landed (that branch never went through the detached array)…
    expect(head.objects[id]).toMatchObject({ id, name: 'Billing' })
    // …and so did the witness of the batch that carried it.
    expect([...(head.writeBatchIds ?? [])]).toHaveLength(1)
  })

  it('a connection edit on an overlay head with no `writeBatchIds` records its batch id in the document', async () => {
    const { connectionHead } = summaryFixture()
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
    expect('writeBatchIds' in (connectionHead.doc() as any)).toBe(false)

    const store = useModelStore.getState()
    const size = { width: 200, height: 100 }
    const from = store.addObject({ type: 'system', name: 'A', position: { x: 0, y: 0 }, size } as any)
    const to = store.addObject({ type: 'system', name: 'B', position: { x: 300, y: 0 }, size } as any)
    const id = useModelStore.getState().addConnection({ fromId: from, toId: to, type: 'solid' } as any)
    await settleWrites()

    const head = connectionHead.doc() as any
    expect(head.connections[id]).toMatchObject({ id, fromId: from, toId: to })
    expect([...(head.writeBatchIds ?? [])]).toHaveLength(1)
  })

  it('a replayed GROUP lands in a ModelMeta that has no `groups` map', async () => {
    // Resident mode never runs writeSmallCollections, so nothing after the
    // replay re-expresses the group: the replay write is its only expression,
    // and the end state shows the loss directly.
    const { meta } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      act: () => useModelStore.getState().addGroup({
        name: 'Payments', color: '#336699', objectIds: [],
      } as any),
      kind: 'group',
      wound: () => meta.change((m: any) => { delete m.groups }),
      container: () => (meta.doc() as any).groups,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, name: 'Payments' })
    expect((meta.doc() as any).groups?.[id]).toMatchObject({ id, name: 'Payments' })
  })

  it('a replayed DOMAIN lands in a ModelMeta that has no `domains` map', async () => {
    const { meta } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      act: () => useModelStore.getState().addDomain({ name: 'Billing' }),
      kind: 'domain',
      wound: () => meta.change((m: any) => { delete m.domains }),
      container: () => (meta.doc() as any).domains,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, name: 'Billing' })
    expect((meta.doc() as any).domains?.[id]).toMatchObject({ id, name: 'Billing' })
  })

  it('a replayed TAG SNAPSHOT lands in a ModelMeta that has no `tagSnapshots` map', async () => {
    const { meta } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      // No store action creates a bare tag snapshot; this is the slice tick
      // the tag editor produces, and detectEdits captures it like any other.
      act: () => {
        useModelStore.setState((s) => ({ tags: [...s.tags, { tagId: 'qa-tag', label: 'QA' } as any] }))
        return 'qa-tag'
      },
      kind: 'tagSnapshot',
      wound: () => meta.change((m: any) => { delete m.tagSnapshots }),
      container: () => (meta.doc() as any).tagSnapshots,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ tagId: id, label: 'QA' })
    expect((meta.doc() as any).tagSnapshots?.[id]).toMatchObject({ tagId: id, label: 'QA' })
  })

  it('a replayed ADR lands in a ModelMeta that has no `decisionRecords` map', async () => {
    const { meta } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      act: () => useModelStore.getState().addDecisionRecord({
        title: 'Use Postgres', summary: 's', status: 'proposed', author: 'You', content: '',
      } as any),
      kind: 'decisionRecord',
      wound: () => meta.change((m: any) => { delete m.decisionRecords }),
      container: () => (meta.doc() as any).decisionRecords,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, title: 'Use Postgres' })
    expect((meta.doc() as any).decisionRecords?.[id]).toMatchObject({ id, title: 'Use Postgres' })
  })

  it('a replayed COMMENT lands in a DiagramDoc that has no `comments` map before its intent is forgotten', async () => {
    const { diagramDoc } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      act: () => useModelStore.getState().addComment({
        diagramId: CLASSIC, type: 'idea', text: 'Split this service',
        position: { x: 10, y: 20 }, author: 'You', resolved: false, pinned: false, replies: [],
      } as any),
      kind: 'comment',
      wound: () => diagramDoc.change((d: any) => { delete d.comments }),
      container: () => (diagramDoc.doc() as any).comments,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, text: 'Split this service' })
    expect((diagramDoc.doc() as any).comments?.[id]).toMatchObject({ id, text: 'Split this service' })
  })

  it('a replayed FLOW lands in a DiagramDoc that has no `flows` map before its intent is forgotten', async () => {
    const { diagramDoc } = classicFixture()
    const { id, carriedWhenForgotten, containerWhenForgotten, forgotten } = await crashThenReplay({
      act: () => useModelStore.getState().addFlow({ name: 'Checkout', diagramId: CLASSIC, steps: [] } as any),
      kind: 'flow',
      wound: () => diagramDoc.change((d: any) => { delete d.flows }),
      container: () => (diagramDoc.doc() as any).flows,
    })

    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, name: 'Checkout' })
    expect((diagramDoc.doc() as any).flows?.[id]).toMatchObject({ id, name: 'Checkout' })
  })

  // ── Full-set writes: a bare `reconcile` on an ABSENT map is a silent no-op ──
  // Reviewer lens, measured: resident addGroup on a meta without `groups` →
  // `groups-in-doc=undefined journaled=[] storeHas=true` — lost on reload,
  // with no journal entry left to replay it.

  /** Boot RESIDENT (no flag) on the classic fixture and let the writes land. */
  async function residentEdit(act: () => void): Promise<void> {
    const bridge = await import('./bridge')
    await bridge.startBridge(CLASSIC_REF)
    expect(bridge.isBootFromServerActive()).toBe(false)
    expect(useModelStore.getState().currentDiagramId).toBe(CLASSIC)
    act()
    await settleWrites()
  }

  it('resident: a new GROUP lands in a ModelMeta that has no `groups` map (writeModelShards)', async () => {
    const { meta } = classicFixture()
    expect((meta.doc() as any).groups).toBeUndefined()
    let id = ''
    await residentEdit(() => {
      id = useModelStore.getState().addGroup({ name: 'Payments', color: '#336699', objectIds: [] } as any)
    })
    expect((meta.doc() as any).groups?.[id]).toMatchObject({ id, name: 'Payments' })
  })

  it('resident: a new DOMAIN lands in a ModelMeta that has no `domains` map (writeModelShards)', async () => {
    const { meta } = classicFixture({ metaOmit: ['domains'] })
    expect((meta.doc() as any).domains).toBeUndefined()
    let id = ''
    await residentEdit(() => { id = useModelStore.getState().addDomain({ name: 'Billing' }) })
    expect((meta.doc() as any).domains?.[id]).toMatchObject({ id, name: 'Billing' })
  })

  it('resident: a new ADR lands in an INLINE ModelMeta that has no `decisionRecords` map', async () => {
    const { meta } = classicFixture({ metaOmit: ['decisionRecords'] })
    let id = ''
    await residentEdit(() => {
      id = useModelStore.getState().addDecisionRecord({
        title: 'Use Postgres', summary: '', status: 'proposed', author: 'You', content: '',
      } as any)
    })
    expect((meta.doc() as any).decisionRecords?.[id]).toMatchObject({ id, title: 'Use Postgres' })
  })

  it('resident: a new ADR lands in a DELTA ModelMeta that has no `decisionRecords` map (the write threw)', async () => {
    // `staticBaseline: true` selects the delta branch, whose
    // `meta.decisionRecords[record.id]` read threw on an absent map — aborting
    // the whole small-collection change, groups and domains included.
    const { meta } = classicFixture({ metaOmit: ['decisionRecords'], metaExtra: { staticBaseline: true } })
    let id = ''
    await residentEdit(() => {
      id = useModelStore.getState().addDecisionRecord({
        title: 'Use Kafka', summary: '', status: 'proposed', author: 'You', content: '',
      } as any)
    })
    expect((meta.doc() as any).decisionRecords?.[id]).toMatchObject({ id, title: 'Use Kafka' })
  })

  it('resident: a new object lands in a model shard that has no `objects` map (reconcileModelShardBucket)', async () => {
    const { objectShard } = classicFixture({ objectShard: {} })
    let id = ''
    await residentEdit(() => {
      id = useModelStore.getState().addObject({
        type: 'system', name: 'Ledger', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
      } as any)
    })
    expect((objectShard.doc() as any).objects?.[id]).toMatchObject({ id, name: 'Ledger' })
  })

  it('boot-from-server: a new GROUP is in the ModelMeta when its intent is forgotten (writeSmallCollections)', async () => {
    // The witness, not the end state — and not the replay either. Measured on
    // the unfixed flush: the full-set write no-ops, its value-checked ack
    // leaves a survivor, the scheduled small-collection replay writes the group
    // and only then is the intent forgotten, so "in the doc when forgotten"
    // alone passes over the defect. The replay must not have had to run.
    const { meta } = classicFixture()
    __setClientTimelineEnabledForTest(true)
    localStorage.setItem(BFS_FLAG, 'true')
    const bridge = await import('./bridge')
    await bridge.startBridge(CLASSIC_REF)
    expect(bridge.isBootFromServerActive()).toBe(true)
    // Warm-up: the overlay write heads resolve lazily on the first edit, and
    // their arrival is a replay junction that would run the replay ALONGSIDE
    // the flush by design. Take that junction first, then measure.
    useModelStore.getState().addObject({
      type: 'system', name: 'Warm-up', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    } as any)
    await settleWrites()
    resetClientTimeline()
    let id = ''
    let forgotten = false
    let carriedWhenForgotten: unknown
    let containerWhenForgotten = 'never forgotten'
    const acknowledge = pendingEntityIntents.acknowledge.bind(pendingEntityIntents)
    vi.spyOn(pendingEntityIntents, 'acknowledge').mockImplementation((workspaceKey, kind, ids, through) => {
      const before = id !== '' && pendingEntityIntents.has(workspaceKey, 'group', id)
      acknowledge(workspaceKey, kind, ids, through)
      if (!forgotten && before && !pendingEntityIntents.has(workspaceKey, 'group', id)) {
        forgotten = true
        const groups = (meta.doc() as any).groups
        carriedWhenForgotten = groups?.[id]
        containerWhenForgotten = `groups when forgotten: ${JSON.stringify(groups)}`
      }
    })

    id = useModelStore.getState().addGroup({ name: 'Payments', color: '#336699', objectIds: [] } as any)
    await settleWrites()

    const replays = readClientTimeline().entries.filter((entry) => entry.name === 'entity-intents.small-replay')
    __setClientTimelineEnabledForTest(null)
    expect(forgotten).toBe(true)
    expect(carriedWhenForgotten, containerWhenForgotten).toMatchObject({ id, name: 'Payments' })
    expect(replays, 'the small-collection replay had to express the group').toHaveLength(0)
  })

  it('an object edit on an overlay head with no `objects` map lands instead of aborting the batch', async () => {
    const { objectHead } = summaryFixture({ objectHead: { writeHeadVersion: 1, writeBatchIds: [] } })
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
    expect((objectHead.doc() as any).objects).toBeUndefined()

    const id = useModelStore.getState().addObject({
      type: 'system', name: 'Billing', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    } as any)
    await settleWrites()

    expect((objectHead.doc() as any).objects?.[id]).toMatchObject({ id, name: 'Billing' })
  })

  it('a connection edit on an overlay head with no `connections` map lands instead of aborting the batch', async () => {
    const { connectionHead } = summaryFixture({ connectionHead: { writeHeadVersion: 1, writeBatchIds: [] } })
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
    expect((connectionHead.doc() as any).connections).toBeUndefined()

    const store = useModelStore.getState()
    const size = { width: 200, height: 100 }
    const from = store.addObject({ type: 'system', name: 'A', position: { x: 0, y: 0 }, size } as any)
    const to = store.addObject({ type: 'system', name: 'B', position: { x: 300, y: 0 }, size } as any)
    const id = useModelStore.getState().addConnection({ fromId: from, toId: to, type: 'solid' } as any)
    await settleWrites()

    const head = connectionHead.doc() as any
    expect(head.connections?.[id]).toMatchObject({ id, fromId: from, toId: to })
    // The batch that carried it is witnessed too: the throw aborted the whole
    // change, batch id included.
    expect([...(head.writeBatchIds ?? [])]).toHaveLength(1)
  })

  it('resident: a new TAG SNAPSHOT lands in a ModelMeta that has no `tagSnapshots` map (writeModelShards)', async () => {
    const { meta } = classicFixture({ metaOmit: ['tagSnapshots'] })
    expect((meta.doc() as any).tagSnapshots).toBeUndefined()
    await residentEdit(() => {
      // No store action creates a bare tag snapshot; this is the slice tick
      // the tag editor produces (the replay test above uses the same one).
      useModelStore.setState((s) => ({ tags: [...s.tags, { tagId: 'qa-tag', label: 'QA' } as any] }))
    })
    expect((meta.doc() as any).tagSnapshots?.['qa-tag']).toMatchObject({ tagId: 'qa-tag', label: 'QA' })
  })

  it('resident: deleting a paged ADR on a DELTA ModelMeta with no `decisionRecords` map still tombstones it', async () => {
    // Delta branch: a baseline ADR that left the store is deleted from the
    // overlay map AND tombstoned. On an absent map the `delete` threw, which
    // aborted the whole small-collection change — the tombstone with it, so
    // the ADR came back from its immutable baseline on the next load.
    const { meta } = classicFixture({ metaOmit: ['decisionRecords'], metaExtra: { staticBaseline: true } })
    const bridge = await import('./bridge')
    await bridge.startBridge(CLASSIC_REF)
    expect(bridge.isBootFromServerActive()).toBe(false)
    const paged = {
      id: 'adr-paged', title: 'From the server page', summary: '', status: 'accepted',
      author: 'Server', content: '', related: [], createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as any
    // The seam the ADR page loader (DecisionRecordsView) feeds a fetched page through.
    bridge.projectDecisionRecordPage([paged], [paged], true)
    await settleWrites()
    expect(useModelStore.getState().decisionRecords.map((record) => record.id)).toEqual(['adr-paged'])

    useModelStore.getState().deleteDecisionRecord('adr-paged')
    await settleWrites()

    expect([...((meta.doc() as any).deletedDecisionRecordIds ?? [])]).toContain('adr-paged')
  })
})
