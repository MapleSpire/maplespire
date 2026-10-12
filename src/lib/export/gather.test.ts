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

import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import type { C4Object, Connection, Diagram } from '../../types'
import type { DiagramDoc, ModelMeta, RootDoc } from '../automerge/types'
import type { WorkspaceRef } from '../automerge/workspace'

/**
 * The landscape-scope gatherer, against the topology a real workspace actually has.
 *
 * The defect these cover (modelled on a big-bank import): the model holds 30
 * objects / 41 connections in its shards, but a gatherer that reads only the
 * active diagram's resident window returns a handful, with most diagrams
 * missing their layout — and every downstream exporter (Structurizr JSON, DSL,
 * Mermaid, JSON, CSV, summaries) then emits a plausible-looking file missing
 * most of the model.
 */

const ACTIVE_REF: WorkspaceRef = { landscapeId: 'lsc-active', versionId: 'current' }

// Real, well-formed automerge URLs (captured from the running stack) — gather.ts
// gates on isValidAutomergeUrl, which is NOT mocked here.
const URL_MONOLITH = 'automerge:2mLwy4GsxTUV8mPvXKjbtVksEkAA'
const URL_META = 'automerge:3cd1WAntVXQJN1k7eEp44VZ2L1r8'
const URL_OBJECT_SHARD = 'automerge:4Mx5wXTSRxZtoPjXf9dyxtMVQhFt'
const URL_CONNECTION_SHARD = 'automerge:2VFRDfPZVwTnfnSJN9K5LuorcfRz'
const URL_DIAGRAM_DOC = 'automerge:2tNvNwWKR8vzNqo6PwzUSimr7nh9'

const getRootHandle = vi.fn()
const getModelHandle = vi.fn()
const getRegistryShardHandles = vi.fn()
const findDiagramHandle = vi.fn()
const findModelMetaHandle = vi.fn()
const getModelShardHandles = vi.fn()
const apiFetch = vi.fn()
const modelState = vi.fn()

vi.mock('../automerge/repo', () => ({
  getRootHandle: (ref?: WorkspaceRef) => getRootHandle(ref),
  getModelHandle: (ref?: WorkspaceRef) => getModelHandle(ref),
  getRegistryShardHandles: (ref?: WorkspaceRef) => getRegistryShardHandles(ref),
  findDiagramHandle: (url: string) => findDiagramHandle(url),
  findModelMetaHandle: (url: string) => findModelMetaHandle(url),
  getModelShardHandles: (urls: readonly string[]) => getModelShardHandles(urls),
}))
vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => modelState() },
}))
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ landscapes: [{ id: ACTIVE_REF.landscapeId, name: 'Big bank' }], ref: ACTIVE_REF }),
  },
}))
vi.mock('../automerge/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../automerge/workspace')>()),
  currentWorkspaceRef: () => ACTIVE_REF,
}))
vi.mock('../api/http', () => ({
  apiFetch: (url: string) => apiFetch(url),
  // gather.ts pages the ROUTED surface, so it uses the retrying variant now.
  workspaceApiFetch: (url: string) => apiFetch(url),
}))
// The suite runs in the node environment: `downloadBlob` touches `document`, so a
// real one would make every performExport call throw for a reason that has nothing
// to do with what is being asserted (a refusal that passes for the wrong reason).
vi.mock('./download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./download')>()),
  downloadBlob: vi.fn(),
  downloadText: vi.fn(),
}))

const { gatherExportBundle } = await import('./gather')
const { performExport, ExportModelIncompleteError } = await import('./index')
const i18n = (await import('../i18n')).default

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

// ── the model the workspace actually holds ────────────────────────────────────

const object = (id: string): C4Object =>
  ({ id, name: `Object ${id}`, type: 'system', position: { x: 0, y: 0 } }) as unknown as C4Object
const connection = (id: string): Connection =>
  ({ id, sourceId: 'o1', targetId: 'o2', label: '' }) as unknown as Connection

/** 30 objects / 41 connections — the big-bank import's counts. */
const ALL_OBJECTS = Array.from({ length: 30 }, (_, i) => object(`o${i + 1}`))
const ALL_CONNECTIONS = Array.from({ length: 41 }, (_, i) => connection(`c${i + 1}`))

/** The active DEPLOYMENT diagram's window: 5 objects / 4 connections. */
const WINDOW_OBJECTS = ALL_OBJECTS.slice(0, 5)
const WINDOW_CONNECTIONS = ALL_CONNECTIONS.slice(0, 4)

const ACTIVE_DIAGRAM: Diagram = {
  id: 'dgDeployment',
  name: 'LiveDeployment',
  type: 'context', // a deployment view is stored as a context diagram
  objectIds: WINDOW_OBJECTS.map((o) => o.id),
  connectionIds: WINDOW_CONNECTIONS.map((c) => c.id),
  groupIds: [],
  layouts: { o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } } },
}

/** A non-active diagram as the store holds it: a layout-less registry stub whose
 * composition names objects the active window does not contain. */
const OTHER_STUB: Diagram = {
  id: 'dgContainers',
  name: 'Containers',
  type: 'container',
  objectIds: ['o6', 'o7', 'o8'],
  connectionIds: ['c5', 'c6'],
  groupIds: [],
}

const OTHER_DOC: DiagramDoc = {
  name: 'Containers',
  type: 'container',
  objectIds: ['o6', 'o7', 'o8'],
  connectionIds: ['c5', 'c6'],
  groupIds: [],
  layouts: { o6: { position: { x: 40, y: 50 }, size: { width: 160, height: 90 } } },
  comments: {},
  flows: {},
  checkpoints: [],
} as unknown as DiagramDoc

const windowedStore = () => ({
  objects: WINDOW_OBJECTS,
  connections: WINDOW_CONNECTIONS,
  groups: [],
  domains: [],
  tags: [],
  decisionRecords: [],
  diagrams: [ACTIVE_DIAGRAM, OTHER_STUB],
  flows: [],
  currentDiagramId: ACTIVE_DIAGRAM.id,
})

const byId = <T extends { id: string }>(items: readonly T[]) =>
  Object.fromEntries(items.map((e) => [e.id, e]))

const handleOf = <T>(doc: T, url = 'automerge:stub') => ({ url, doc: () => doc })

const SHARDED_ROOT: RootDoc = {
  // A sharded workspace keeps its pre-split monolith: a VALID url whose document
  // is frozen and (for a workspace born sharded) permanently EMPTY.
  modelUrl: URL_MONOLITH,
  modelMetaUrl: URL_META,
  shardUrls: ['automerge:2n6qXtMUNYXKDxp3TE7bSHFVwjEY'],
}

const META: ModelMeta = {
  objectShardUrls: [URL_OBJECT_SHARD],
  connectionShardUrls: [URL_CONNECTION_SHARD],
  groups: {},
  domains: {},
  tagSnapshots: {},
  decisionRecords: {},
}

/** The registry, as the shards hold it. */
const registryShard = () =>
  handleOf({
    diagrams: {
      [ACTIVE_DIAGRAM.id]: { ...ACTIVE_DIAGRAM, docUrl: 'automerge:45yuyNJhPLaPUq5aucTrpSU469wz' },
      [OTHER_STUB.id]: { ...OTHER_STUB, docUrl: URL_DIAGRAM_DOC },
    },
  })

function shardedWorkspace(overrides: { meta?: Partial<ModelMeta> } = {}) {
  getRootHandle.mockResolvedValue(handleOf(SHARDED_ROOT))
  getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
  getRegistryShardHandles.mockResolvedValue([registryShard()])
  findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
  findModelMetaHandle.mockResolvedValue(handleOf({ ...META, ...overrides.meta }))
  getModelShardHandles.mockImplementation((urls: readonly string[]) =>
    Promise.resolve(
      urls.map((url) =>
        url === URL_OBJECT_SHARD
          ? handleOf({ objects: byId(ALL_OBJECTS) })
          : handleOf({ connections: byId(ALL_CONNECTIONS) }),
      ),
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  modelState.mockImplementation(windowedStore)
  apiFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
})

describe('gatherExportBundle — landscape scope', () => {
  it('gathers the WHOLE model from the shards, not the active diagram window', async () => {
    // The regression. `root.modelUrl` is a valid url on a sharded workspace, so the
    // gatherer resolved the EMPTY pre-split monolith, merged nothing, and never
    // reached its own read-model fallback. Live: 5 objects exported out of 30.
    shardedWorkspace()

    const bundle = await gatherExportBundle('landscape')

    expect(bundle.objects).toHaveLength(30)
    expect(bundle.connections).toHaveLength(41)
    expect(bundle.model?.source).toBe('shards')
    expect(bundle.model?.missing).toEqual({ objects: 0, connections: 0, groups: 0 })
  })

  it('resolves every document for the ACTIVE workspace, never the default one', async () => {
    // The gatherer must pass the ACTIVE ref explicitly. Resolving the 'default'
    // landscape's documents from another landscape would also — because
    // getRootHandle routes the network — tear the live sync socket off the
    // active workspace and re-point it at `landscapeId=default`.
    shardedWorkspace()

    await gatherExportBundle('landscape')

    expect(getRootHandle).toHaveBeenCalled()
    for (const call of getRootHandle.mock.calls) expect(call[0]).toEqual(ACTIVE_REF)
    for (const call of getRegistryShardHandles.mock.calls) expect(call[0]).toEqual(ACTIVE_REF)
  })

  it('drops shard entities the ModelMeta tombstones as deleted', async () => {
    shardedWorkspace({ meta: { deletedObjectIds: ['o30'], deletedConnectionIds: ['c41', 'c40'] } })

    const bundle = await gatherExportBundle('landscape')

    expect(bundle.objects.map((o) => o.id)).not.toContain('o30')
    expect(bundle.connections).toHaveLength(39)
  })

  it('materialises every diagram, so non-active diagrams keep their layouts', async () => {
    shardedWorkspace()

    const bundle = await gatherExportBundle('landscape')

    const other = bundle.diagrams.find((d) => d.id === OTHER_STUB.id)
    expect(Object.keys(other?.layouts ?? {})).toEqual(['o6'])
  })

  it('pages the read model for the ACTIVE workspace when there are no shards', async () => {
    // Monolith topology whose document never materialised: the server read model is
    // the fallback — but the request has to say WHICH workspace, or it answers for
    // the default landscape (live: 30 rows scoped, 0 unscoped).
    getRootHandle.mockResolvedValue(handleOf({ modelUrl: URL_MONOLITH, shardUrls: [] } as RootDoc))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          url.includes('page-objects')
            ? { objects: ALL_OBJECTS, nextCursor: null }
            : { connections: ALL_CONNECTIONS, nextCursor: null },
      }),
    )

    const bundle = await gatherExportBundle('landscape')

    for (const [url] of apiFetch.mock.calls) {
      expect(url).toContain(`landscapeId=${ACTIVE_REF.landscapeId}`)
      expect(url).toContain(`versionId=${ACTIVE_REF.versionId}`)
    }
    expect(bundle.objects).toHaveLength(30)
    expect(bundle.model?.source).toBe('read-model')
  })

  it('REFUSES the gather when a later page is refused, rather than exporting a truncated model (T-MC)', async () => {
    // The arm above is this one's control: identical setup, complete paging,
    // 30 objects and `source: 'read-model'`. Here page 2 of objects is refused.
    //
    // The old loop did `if (!res.ok) break` and returned page 1, which the
    // ladder merged over the resident window and wrote to disk — JSON, CSV,
    // Markdown, Structurizr, PDF — with no error anywhere. A file that looks
    // complete and is not is worse than a failed export, because nothing ever
    // tells the user which one they have.
    getRootHandle.mockResolvedValue(handleOf({ modelUrl: URL_MONOLITH, shardUrls: [] } as RootDoc))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))

    let objectPages = 0
    apiFetch.mockImplementation((url: string) => {
      if (url.includes('page-connections')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ connections: ALL_CONNECTIONS, nextCursor: null }),
        })
      }
      objectPages += 1
      if (objectPages === 1) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ objects: ALL_OBJECTS.slice(0, 10), nextCursor: 'cur-1' }),
        })
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'moved' }) })
    })

    await expect(gatherExportBundle('landscape')).rejects.toMatchObject({
      name: 'IncompleteCollectionError',
      pagesFetched: 1,
    })
    // The fault really fired — without this the arm would pass on a build where
    // the ladder never reached the read model at all.
    expect(objectPages).toBeGreaterThan(1)
  })

  it('KEEPS the offline fallback when the FIRST page is refused', async () => {
    // The other half, and the one that must not regress: nothing arrived, so
    // the read-model rung simply cannot answer and the ladder falls through to
    // the resident window. That is what makes an export work offline at all,
    // and a fix that turned this into an error would have broken it.
    getRootHandle.mockResolvedValue(handleOf({ modelUrl: URL_MONOLITH, shardUrls: [] } as RootDoc))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
    apiFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'offline' }) })

    const bundle = await gatherExportBundle('landscape')

    expect(bundle.model?.source).toBe('window')
  })

  it('reports the resident window as INCOMPLETE when no whole-model source answers', async () => {
    getRootHandle.mockResolvedValue(handleOf(SHARDED_ROOT))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
    findModelMetaHandle.mockRejectedValue(new Error('document unavailable'))

    const bundle = await gatherExportBundle('landscape')

    expect(bundle.model?.source).toBe('window')
    // The diagrams themselves prove what is missing: they name o6..o8 / c5..c6.
    expect(bundle.model?.missing.objects).toBeGreaterThan(0)
    expect(bundle.model?.missing.connections).toBeGreaterThan(0)
  })

  it('never hangs the export on a document that never resolves', async () => {
    // repo.find() with a network adapter and no connected peer never settles
    // on its own. Degrading loudly beats a dialog that spins forever.
    vi.useFakeTimers()
    try {
      getRootHandle.mockResolvedValue(handleOf(SHARDED_ROOT))
      getModelHandle.mockReturnValue(new Promise(() => {}))
      getRegistryShardHandles.mockReturnValue(new Promise(() => {}))
      findModelMetaHandle.mockReturnValue(new Promise(() => {}))

      const pending = gatherExportBundle('landscape')
      await vi.advanceTimersByTimeAsync(30_000)
      const bundle = await pending
      expect(bundle.model?.source).toBe('window')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('performExport — a partial landscape bundle is refused, not emitted', () => {
  it('refuses every landscape-wide format when the model could not be gathered', async () => {
    getRootHandle.mockResolvedValue(handleOf(SHARDED_ROOT))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
    findModelMetaHandle.mockRejectedValue(new Error('document unavailable'))

    const bundle = await gatherExportBundle('landscape')

    // A file that looks complete and is not is the worst outcome of the three.
    const refused = ExportModelIncompleteError
    await expect(performExport({ type: 'structurizr-json', scope: 'landscape' }, bundle)).rejects.toThrow(refused)
    await expect(performExport({ type: 'structurizr', scope: 'landscape' }, bundle)).rejects.toThrow(refused)
    await expect(performExport({ type: 'json', scope: 'landscape' }, bundle)).rejects.toThrow(refused)
    await expect(performExport({ type: 'mermaid', scope: 'landscape' }, bundle)).rejects.toThrow(refused)
    await expect(performExport({ type: 'csv', contents: 'objects' }, bundle)).rejects.toThrow(refused)
    await expect(performExport({ type: 'markdown', scope: 'landscape' }, bundle)).rejects.toThrow(refused)
  })

  it('still exports the ACTIVE DIAGRAM from the same degraded bundle', async () => {
    // The window is always complete for the diagram the editor has open, so a
    // diagram-scope export stays available — that is the honest way out.
    getRootHandle.mockResolvedValue(handleOf(SHARDED_ROOT))
    getModelHandle.mockResolvedValue(handleOf({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }))
    getRegistryShardHandles.mockResolvedValue([registryShard()])
    findDiagramHandle.mockResolvedValue(handleOf(OTHER_DOC))
    findModelMetaHandle.mockRejectedValue(new Error('document unavailable'))

    const bundle = await gatherExportBundle('landscape')

    await expect(performExport({ type: 'json', scope: 'diagram' }, bundle)).resolves.toBeTruthy()
  })

  it('exports a complete bundle without complaint', async () => {
    shardedWorkspace()
    const bundle = await gatherExportBundle('landscape')
    await expect(performExport({ type: 'json', scope: 'landscape' }, bundle)).resolves.toBeTruthy()
  })
})
