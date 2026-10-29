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

import * as Automerge from '@automerge/automerge'
import {
  Repo,
  generateAutomergeUrl,
  type AutomergeUrl,
  type Chunk,
  type DocHandle,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  backfillMissingContainers,
  gatherContainerDocuments,
  hiddenListEntries,
  planContainerBackfill,
  writeContainerBackfill,
} from './containerBackfill.js'

class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()
  async load(key: StorageKey): Promise<Uint8Array | undefined> { return this.entries.get(key.join('/'))?.data.slice() }
  async save(key: StorageKey, data: Uint8Array): Promise<void> { this.entries.set(key.join('/'), { key: [...key], data: data.slice() }) }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(key.join('/')) }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => prefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) if (prefix.every((part, index) => key[index] === part)) this.entries.delete(text)
  }
}

const META = 'automerge:meta'
const fields = (entries: readonly { field: string }[]) => entries.map((entry) => entry.field).sort()

/** Two peers create `writeBatchIds` lazily from `base` and push one id each. */
function conflictedBatchIds(base: Record<string, unknown>) {
  const start = Automerge.from<Record<string, unknown>>(base)
  const push = (actor: string, id: string) => Automerge.change(Automerge.clone(start, { actor }), (d) => {
    if (!d.writeBatchIds) d.writeBatchIds = []
    ;(d.writeBatchIds as string[]).push(id)
  })
  return Automerge.merge(push('aaaaaa', 'batch-a'), push('bbbbbb', 'batch-b'))
}

describe('THE MEASUREMENT: why only an append-only list is backfilled, and why it must be healable', () => {
  it('a backfill concurrent with an offline lazy creator HIDES the offline entries', () => {
    // Architect lens, measured 5/6 configurations hidden; the commonest is
    // here: the server copy takes ops after the fork, the client goes offline,
    // creates the list lazily and pushes; the backfill writes `[]` meanwhile.
    const base = Automerge.from<Record<string, unknown>>({ objects: {} }, { actor: '000000' })
    let server = Automerge.change(Automerge.clone(base, { actor: 'ffffff' }), (d) => { d.marker = 1 })
    const client = Automerge.change(Automerge.clone(base, { actor: '111111' }), (d) => {
      if (!d.writeBatchIds) d.writeBatchIds = []
      ;(d.writeBatchIds as string[]).push('offline-batch')
    })
    server = Automerge.change(server, (d) => { d.writeBatchIds = [] })
    const merged = Automerge.merge(server, client)
    expect([...(merged.writeBatchIds as string[])]).toEqual([])
    // …but the hidden entry is still in the document, and appending it to the
    // winner restores it — the heal this module applies to `writeBatchIds`.
    expect(hiddenListEntries(merged, 'writeBatchIds')).toEqual(['offline-batch'])
  })
})

describe('planContainerBackfill — what is written, healed, or only reported', () => {
  it('writes `writeBatchIds` on BOTH current heads, and nothing on the ModelMeta', () => {
    const plan = planContainerBackfill([
      { role: 'model-meta', url: META, doc: { marker: 1 } },
      { role: 'object-head', url: 'automerge:oh', doc: { objects: {} } },
      { role: 'connection-head', url: 'automerge:ch', doc: { connections: {} } },
    ])
    expect(plan.writes.map((write) => [write.url, write.field, write.kind])).toEqual([
      ['automerge:oh', 'writeBatchIds', 'list'],
      ['automerge:ch', 'writeBatchIds', 'list'],
    ])
  })

  it('never writes a tombstone list, `groups`, a shard list or a head entity map — it reports each, with its reason', () => {
    const plan = planContainerBackfill([
      { role: 'model-meta', url: META, doc: { marker: 1 } },
      { role: 'object-head', url: 'automerge:oh', doc: { writeBatchIds: [] } },
      { role: 'connection-head', url: 'automerge:ch', doc: { writeBatchIds: [] } },
    ])
    expect(plan.writes).toEqual([])
    expect(fields(plan.reports)).toEqual([
      'connectionShardUrls', 'connections', 'deletedConnectionIds', 'deletedDecisionRecordIds', 'deletedDiagramIds',
      'deletedObjectIds', 'groups', 'objectShardUrls', 'objects',
    ])
    const tombstone = plan.reports.find((report) => report.field === 'deletedObjectIds')!
    expect(tombstone.reason).toMatch(/spliced out/)
    // Not checked at all: nothing in the read model reads them.
    expect(fields(plan.reports)).not.toContain('domains')
    expect(fields(plan.reports)).not.toContain('tagSnapshots')
  })

  it('a present value of the wrong kind is reported, never replaced', () => {
    const plan = planContainerBackfill([
      { role: 'object-head', url: 'automerge:oh', doc: { objects: {}, writeBatchIds: {} } },
      { role: 'connection-head', url: 'automerge:ch', doc: { connections: {}, writeBatchIds: null } },
    ])
    expect(plan.writes).toEqual([])
    expect(plan.reports.filter((report) => /not a list/.test(report.reason)).map((report) => report.url))
      .toEqual(['automerge:oh', 'automerge:ch'])
  })

  it('HEALS a conflicted `writeBatchIds`, and only REPORTS a conflicted tombstone list', () => {
    const head = conflictedBatchIds({ objects: {} })
    const metaStart = Automerge.from<Record<string, unknown>>({ marker: 1 })
    const deleteOne = (actor: string, id: string) => Automerge.change(Automerge.clone(metaStart, { actor }), (d) => {
      if (!d.deletedObjectIds) d.deletedObjectIds = []
      ;(d.deletedObjectIds as string[]).push(id)
    })
    const meta = Automerge.merge(deleteOne('aaaaaa', 'o-a'), deleteOne('bbbbbb', 'o-b'))
    const plan = planContainerBackfill([
      { role: 'model-meta', url: META, doc: meta },
      { role: 'object-head', url: 'automerge:oh', doc: head },
    ])
    expect(plan.heals).toEqual([{ url: 'automerge:oh', role: 'object-head', field: 'writeBatchIds', entries: [expect.any(String)] }])
    const conflict = plan.reports.find((report) => report.field === 'deletedObjectIds')!
    expect(conflict.reason).toMatch(/^conflicted: 1 tombstone/)
  })

  it('a healthy document plans nothing; an unresolved one is UNKNOWN, not healthy', () => {
    const plan = planContainerBackfill([
      { role: 'object-head', url: 'automerge:oh', doc: { objects: {}, writeBatchIds: [] } },
      { role: 'connection-head', url: 'automerge:gone', doc: undefined },
    ])
    expect(plan.writes).toEqual([])
    expect(plan.heals).toEqual([])
    expect(plan.reports).toEqual([])
    expect(plan.unresolved).toEqual([{ url: 'automerge:gone', role: 'connection-head' }])
  })
})

async function create<T extends Record<string, unknown>>(repo: Repo, value: T): Promise<DocHandle<T>> {
  const handle = repo.create<T>(value)
  await handle.whenReady()
  return handle
}

/** A legacy ordinary workspace: heads minted by the old createEmptyRoot, a meta with no tombstone lists. */
async function legacyWorkspace(repo: Repo, overrides: { objectHead?: Record<string, unknown> } = {}) {
  const objectHead = await create<Record<string, unknown>>(repo, overrides.objectHead ?? { objects: { o1: { id: 'o1' } } })
  const connectionHead = await create<Record<string, unknown>>(repo, { connections: {} })
  const meta = await create<Record<string, unknown>>(repo, {
    objectShardUrls: [objectHead.url], connectionShardUrls: [connectionHead.url],
    editsObjectShardUrl: objectHead.url, editsConnectionShardUrl: connectionHead.url,
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = await create<Record<string, unknown>>(repo, { modelUrl: '', modelMetaUrl: meta.url, shardUrls: [] })
  return { root, meta, objectHead, connectionHead }
}

/** Both heads already hold `writeBatchIds`, the object head's CONFLICTED: a heal and no write. */
async function healOnlyWorkspace(repo: Repo) {
  const objectHead = repo.import<Record<string, unknown>>(Automerge.save(conflictedBatchIds({ objects: {} })))
  await objectHead.whenReady()
  const connectionHead = await create<Record<string, unknown>>(repo, { connections: {}, writeBatchIds: [] })
  const meta = await create<Record<string, unknown>>(repo, {
    objectShardUrls: [objectHead.url], connectionShardUrls: [connectionHead.url],
    editsObjectShardUrl: objectHead.url, editsConnectionShardUrl: connectionHead.url,
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = await create<Record<string, unknown>>(repo, { modelUrl: '', modelMetaUrl: meta.url, shardUrls: [] })
  return { root, meta, objectHead, connectionHead }
}

const read = async (repo: Repo, url: string) => {
  const handle = await repo.find<Record<string, unknown>>(url as AutomergeUrl)
  await handle.whenReady()
  return handle.doc()!
}

describe('gather + write against real, stored Automerge documents', () => {
  it('creates `writeBatchIds` on both heads DURABLY, and touches nothing else', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 60_000 })
    const ws = await legacyWorkspace(repo)
    await repo.flush()
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    const result = await writeContainerBackfill(repo, plan, gathered.handleByUrl)
    expect(result).toMatchObject({ written: 2, healed: 0 })
    // Durable: a second Repo reads STORAGE (the save debounce is a minute, so
    // only the flush could have put it there — QA lens, mutant B19).
    const cold = new Repo({ storage, network: [] })
    expect([...((await read(cold, ws.objectHead.url)).writeBatchIds as string[])]).toEqual([])
    expect([...((await read(cold, ws.connectionHead.url)).writeBatchIds as string[])]).toEqual([])
    expect((await read(cold, ws.objectHead.url)).objects).toEqual({ o1: { id: 'o1' } })
    expect('deletedObjectIds' in (await read(cold, ws.meta.url))).toBe(false)
    await cold.shutdown()
    // Idempotent: nothing left to write.
    expect(planContainerBackfill((await gatherContainerDocuments(repo, ws.root.url)).documents).writes).toEqual([])
  })

  it('heals a conflicted head: the hidden batch id is appended to the winner, and a second pass is a no-op', async () => {
    const repo = new Repo({ network: [] })
    const conflicted = conflictedBatchIds({ objects: {} })
    const objectHead = repo.import<Record<string, unknown>>(Automerge.save(conflicted))
    await objectHead.whenReady()
    const ws = await legacyWorkspace(repo)
    ws.meta.change((m) => { m.editsObjectShardUrl = objectHead.url })
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    expect(plan.heals).toHaveLength(1)
    expect((await writeContainerBackfill(repo, plan, gathered.handleByUrl)).healed).toBe(1)
    expect([...(objectHead.doc()!.writeBatchIds as string[])].sort()).toEqual(['batch-a', 'batch-b'])
    expect(planContainerBackfill((await gatherContainerDocuments(repo, ws.root.url)).documents).heals).toEqual([])
  })

  it('an append a peer makes into the winner concurrently with the heal survives the merge', async () => {
    // The heal APPENDS to the winner rather than reassigning the key — the
    // property the module doc leans on. QA lens round 2, mutant B2.
    const repo = new Repo({ network: [] })
    const ws = await healOnlyWorkspace(repo)
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    expect(plan.heals).toHaveLength(1)
    const peer = Automerge.change(Automerge.clone(ws.objectHead.doc()!, { actor: 'cccccc' }), (d) => {
      ;(d.writeBatchIds as string[]).push('batch-c')
    })
    await writeContainerBackfill(repo, plan, gathered.handleByUrl)
    ws.objectHead.update((d) => Automerge.merge(d, peer))
    const head = ws.objectHead.doc()!
    expect([...(head.writeBatchIds as string[])].sort()).toEqual(['batch-a', 'batch-b', 'batch-c'])
    expect(hiddenListEntries(head, 'writeBatchIds')).toEqual([])
  })

  it('an entry that reached the winner between plan and write is not appended a second time', async () => {
    const repo = new Repo({ network: [] })
    const ws = await healOnlyWorkspace(repo)
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    const hidden = plan.heals[0]!.entries[0] as string
    ws.objectHead.change((d) => { (d.writeBatchIds as string[]).push(hidden) })
    const result = await writeContainerBackfill(repo, plan, gathered.handleByUrl)
    expect(result.healed).toBe(0)
    expect([...(ws.objectHead.doc()!.writeBatchIds as string[])].filter((id) => id === hidden)).toHaveLength(1)
  })

  it('a document whose every planned change was already made is neither flushed nor counted', async () => {
    const repo = new Repo({ network: [] })
    const ws = await legacyWorkspace(repo)
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    ws.objectHead.change((d) => { d.writeBatchIds = [] })
    const result = await writeContainerBackfill(repo, plan, gathered.handleByUrl)
    expect(result.documentIds).toEqual([ws.connectionHead.documentId])
  })

  it('a container another writer created between plan and write is neither overwritten nor counted', async () => {
    const repo = new Repo({ network: [] })
    const ws = await legacyWorkspace(repo)
    const gathered = await gatherContainerDocuments(repo, ws.root.url)
    const plan = planContainerBackfill(gathered.documents)
    expect(plan.writes).toHaveLength(2)
    ws.objectHead.change((head) => { head.writeBatchIds = ['b-peer'] })
    const result = await writeContainerBackfill(repo, plan, gathered.handleByUrl)
    expect(result.written).toBe(1)
    expect([...(ws.objectHead.doc()!.writeBatchIds as string[])]).toEqual(['b-peer'])
  })

  it('a head that does not resolve is UNKNOWN and planned nothing', async () => {
    const repo = new Repo({ network: [] })
    const ws = await legacyWorkspace(repo)
    const missing = generateAutomergeUrl()
    ws.meta.change((m) => { m.editsConnectionShardUrl = missing })
    const plan = planContainerBackfill((await gatherContainerDocuments(repo, ws.root.url, 300)).documents)
    expect(plan.unresolved).toEqual([{ url: missing, role: 'connection-head' }])
    expect(plan.writes.map((write) => write.url)).not.toContain(missing)
  })

  it('a monolith root has nothing on this pass', async () => {
    const repo = new Repo({ network: [] })
    const model = await create(repo, { objects: {}, connections: {} })
    const root = await create(repo, { modelUrl: model.url, shardUrls: [] as string[] })
    expect(await gatherContainerDocuments(repo, root.url)).toMatchObject({ monolith: true, documents: [] })
  })
})

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('backfillMissingContainers (live Postgres lifecycle lock + stored Automerge)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const WS = { landscapeId: 'L-containers', versionId: 'V1' }

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'container_backfill')
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL)`)
  })
  afterEach(async () => {
    await db?.pool.query('DELETE FROM versions')
    await db?.pool.query('DELETE FROM automerge_document_workspace')
  })
  afterAll(async () => { await db?.teardown() })

  /** Provision on a SHARED storage; every document is mapped to WS unless `unowned` names it. */
  async function provision(options: {
    unowned?: (ws: Awaited<ReturnType<typeof legacyWorkspace>>) => string[]
    shape?: 'legacy' | 'heal'
  } = {}) {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
    const ws = options.shape === 'heal' ? await healOnlyWorkspace(repo) : await legacyWorkspace(repo)
    await repo.flush()
    await db.pool.query('INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)', [WS.landscapeId, WS.versionId, ws.root.url])
    const unowned = new Set(options.unowned?.(ws) ?? [])
    for (const handle of [ws.root, ws.meta, ws.objectHead, ws.connectionHead]) {
      if (unowned.has(handle.url)) continue
      await db.pool.query('INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)',
        [handle.documentId, WS.landscapeId, WS.versionId])
    }
    const openRepo = () => new Repo({ storage, network: [], saveDebounceRate: 0 })
    return { storage, repo, ws, openRepo }
  }

  it('preview writes nothing; apply writes the plan under the lock, durably', async () => {
    const { storage, repo, ws, openRepo } = await provision()
    const preview = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS })
    expect(preview.applied).toBeNull()
    expect(preview.plan.writes).toHaveLength(2)
    expect('writeBatchIds' in ws.objectHead.doc()!).toBe(false)

    const applied = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(applied).toMatchObject({ refused: null, quiesce: 'operator-asserted' })
    expect(applied.applied).toMatchObject({ written: 2, healed: 0, exclusionProven: true })
    const cold = new Repo({ storage, network: [] })
    expect([...((await read(cold, ws.connectionHead.url)).writeBatchIds as string[])]).toEqual([])
    await cold.shutdown()
  })

  /** A sync cell's write reaching STORAGE after `repo` cached its copy: a third repo, flushed. */
  async function cellWrites(openRepo: () => Repo, url: string, mutate: (doc: Record<string, unknown>) => void) {
    const cell = openRepo()
    const handle = await cell.find<Record<string, unknown>>(url as AutomergeUrl)
    await handle.whenReady()
    handle.change(mutate)
    await cell.flush([handle.documentId])
    await cell.shutdown()
  }

  it('re-plans from STORAGE under the lock: a list a cell saved after the preview is not written a second time', async () => {
    // Reviewer lens B2: `repo` answers from its cache, so a re-plan through it
    // would see the stale copy and write a SECOND, concurrent list over the
    // cell's — the exact loss this pass exists to prevent.
    const { repo, ws, openRepo } = await provision()
    const preview = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS })
    expect(preview.plan.writes).toHaveLength(2)
    await cellWrites(openRepo, ws.objectHead.url, (head) => { head.writeBatchIds = ['b-cell'] })
    // Control: the preview's repo really is stale.
    expect('writeBatchIds' in ws.objectHead.doc()!).toBe(false)

    const applied = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(applied.refused).toBeNull()
    expect(applied.applied?.written).toBe(1)
    const cold = openRepo()
    const head = await read(cold, ws.objectHead.url)
    expect([...(head.writeBatchIds as string[])]).toEqual(['b-cell'])
    expect(hiddenListEntries(head, 'writeBatchIds')).toEqual([])
    await cold.shutdown()
  })

  it('REFUSES when the root changed shape between preview and apply (a promotion flips it in place)', async () => {
    const { repo, ws, openRepo } = await provision()
    await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS })
    await cellWrites(openRepo, ws.root.url, (root) => { root.registrySummaryOnly = true })
    const applied = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(applied.refused).toBe('workspace-moved')
    expect(applied.applied).toBeNull()
    const cold = openRepo()
    expect('writeBatchIds' in (await read(cold, ws.objectHead.url))).toBe(false)
    await cold.shutdown()
  })

  it('REFUSES while another lifecycle door holds the lock, and writes nothing', async () => {
    const { repo, ws, openRepo } = await provision()
    const { withLifecycleApplyLock } = await import('./lifecycleApplyLock.js')
    const held = await withLifecycleApplyLock(db.pool, WS, async () =>
      backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true }))
    expect(held.granted).toBe(true)
    if (!held.granted) return
    expect(held.value.refused).toBe('lock-unavailable')
    expect(held.value.applied).toBeNull()
    expect(held.value.plan.writes.length).toBeGreaterThan(0)
    expect('writeBatchIds' in ws.objectHead.doc()!).toBe(false)
  })

  it('REFUSES a document this workspace does not own, and writes nothing', async () => {
    const { repo, ws, openRepo } = await provision({ unowned: (w) => [w.connectionHead.url] })
    const result = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(result.refused).toBe('document-not-owned')
    expect(result.applied).toBeNull()
    const cold = openRepo()
    expect('writeBatchIds' in (await read(cold, ws.objectHead.url))).toBe(false)
    await cold.shutdown()
  })

  it('a HEAL-ONLY workspace is healed by apply, durably', async () => {
    // QA lens round 2, B15: the apply gate must not return early when there is
    // nothing to WRITE but something to HEAL.
    const { storage, repo, ws, openRepo } = await provision({ shape: 'heal' })
    const applied = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(applied.refused).toBeNull()
    expect(applied.applied).toMatchObject({ written: 0, healed: 1 })
    const cold = new Repo({ storage, network: [] })
    const head = await read(cold, ws.objectHead.url)
    expect([...(head.writeBatchIds as string[])].sort()).toEqual(['batch-a', 'batch-b'])
    await cold.shutdown()
  })

  it('a HEAL into a document this workspace does not own is refused', async () => {
    const { repo, ws, openRepo } = await provision({ shape: 'heal', unowned: (w) => [w.objectHead.url] })
    const result = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(result.refused).toBe('document-not-owned')
    const cold = openRepo()
    expect(hiddenListEntries(await read(cold, ws.objectHead.url), 'writeBatchIds')).toHaveLength(1)
    await cold.shutdown()
  })

  it('a root whose registryWriteUrl changed between preview and apply is refused', async () => {
    const { repo, ws, openRepo } = await provision()
    await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS })
    await cellWrites(openRepo, ws.root.url, (root) => { root.registryWriteUrl = ws.meta.url })
    const applied = await backfillMissingContainers({ db: db.pool, repo, openRepo, workspace: WS, apply: true })
    expect(applied.refused).toBe('workspace-moved')
  })

  it('a versions row repointed between the preview and the lock is refused', async () => {
    const { repo, openRepo } = await provision()
    const other = await legacyWorkspace(repo)
    await repo.flush()
    let moved = false
    // The repoint lands while the PREVIEW resolves (its first `find`), i.e.
    // after the preview read `root_url` and before the lock re-reads it.
    const watched = new Proxy(repo, {
      get(target, property) {
        if (property === 'find' && !moved) {
          moved = true
          return async (...args: Parameters<Repo['find']>) => {
            await db.pool.query('UPDATE versions SET root_url = $1 WHERE landscape_id = $2 AND id = $3',
              [other.root.url, WS.landscapeId, WS.versionId])
            return target.find(...args)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const applied = await backfillMissingContainers({ db: db.pool, repo: watched, openRepo, workspace: WS, apply: true })
    expect(moved).toBe(true)
    expect(applied.refused).toBe('workspace-moved')
  })

  /** The pool, with each borrowed client's `query` passed through `rewrite`. */
  function proxiedPool(rewrite: (text: unknown, run: () => Promise<{ rows: Record<string, unknown>[] }>) => Promise<unknown>): Pool {
    return new Proxy(db.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(clientTarget, clientProperty) {
                if (clientProperty === 'query') {
                  return (text: unknown, ...rest: unknown[]) => rewrite(text, () =>
                    (clientTarget.query as (...a: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>)(text, ...rest))
                }
                const value = Reflect.get(clientTarget, clientProperty, clientTarget)
                return typeof value === 'function' ? value.bind(clientTarget) : value
              },
            })
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Pool
  }

  it('a session that no longer holds the lock refuses as lock-not-held', async () => {
    const { repo, openRepo } = await provision()
    let lied = 0
    const lying = proxiedPool(async (text, run) => {
      if (lied === 0 && typeof text === 'string' && text.includes('pg_locks') && text.includes('pg_backend_pid()')) {
        lied += 1
        return { rows: [{ held: false }], rowCount: 1 }
      }
      return run()
    })
    const applied = await backfillMissingContainers({ db: lying, repo, openRepo, workspace: WS, apply: true })
    expect(lied).toBe(1)
    expect(applied.refused).toBe('lock-not-held')
  })

  it('an unlock that cannot prove exclusion is reported as exclusionProven: false', async () => {
    const { repo, openRepo } = await provision()
    let lied = 0
    const lying = proxiedPool(async (text, run) => {
      const real = await run()
      if (typeof text === 'string' && text.includes('pg_advisory_unlock(')) {
        lied += 1
        return { ...real, rows: real.rows.map((row) => ({ ...row, unlocked: false })) }
      }
      return real
    })
    const applied = await backfillMissingContainers({ db: lying, repo, openRepo, workspace: WS, apply: true })
    expect(lied).toBeGreaterThan(0)
    expect(applied.applied?.exclusionProven).toBe(false)
  })

  it('an unknown workspace is refused by name, not treated as clean', async () => {
    const repo = new Repo({ network: [] })
    const report = await backfillMissingContainers({
      db: db.pool, repo, openRepo: () => new Repo({ network: [] }),
      workspace: { landscapeId: 'nope', versionId: 'nope' }, apply: true,
    })
    expect(report.refused).toBe('workspace-unknown')
  })
})
