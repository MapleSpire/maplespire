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

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { Repo, isValidAutomergeUrl, type AutomergeUrl, type DocumentId } from '@automerge/automerge-repo'
import { remapModelMeta, forkRoot } from './forkRoot.js'
import { buildModelMeta, OVERLAY_WRITE_HEAD_VERSION } from './modelMeta.js'
import { ROOT_SHAPE_FIELDS } from './rootShape.js'
import { isMintedDocumentId, verifyDocumentId } from './rbac/documentIdMint.js'
import { setWorkspaceDocumentsRegistrationForTest } from './rbac/docScope.js'
import { installBootstrapOwnership, openBootstrapScope, resetBootstrapScopeCountersForTest } from './bootstrapScope.js'
import { bootstrapPlacementFor, bootstrapPlacementSnapshot, resetServerCreationPlacementForTest } from './rbac/serverCreationPlacement.js'
import { StaleSyncCellWriteError } from './automergeStorageErrors.js'

describe('remapModelMeta', () => {
  it('replaces the shard url arrays with the forked ones', () => {
    const meta = { objectShardUrls: ['o1', 'o2'], connectionShardUrls: ['c1'], decisionRecordShardUrls: ['d1'] }
    const out = remapModelMeta(meta, ['N1', 'N2'], ['M1'], ['D1'])
    expect(out.objectShardUrls).toEqual(['N1', 'N2'])
    expect(out.connectionShardUrls).toEqual(['M1'])
    expect(out.decisionRecordShardUrls).toEqual(['D1'])
  })

  it('remaps the edits-overlay pointers by their position in the source array', () => {
    const meta = {
      objectShardUrls: ['o1', 'oOld', 'oEdits'],
      connectionShardUrls: ['c1', 'cOld', 'cEdits'],
      editsObjectShardUrl: 'oEdits',
      editsObjectShardUrls: ['oOld', 'oEdits'],
      editsConnectionShardUrl: 'cEdits',
      editsConnectionShardUrls: ['cOld', 'cEdits'],
    }
    const out = remapModelMeta(meta, ['N1', 'NOld', 'NEdits'], ['M1', 'MOld', 'MEdits'])
    expect(out.editsObjectShardUrl).toBe('NEdits')
    expect(out.editsObjectShardUrls).toEqual(['NOld', 'NEdits'])
    expect(out.editsConnectionShardUrl).toBe('MEdits')
    expect(out.editsConnectionShardUrls).toEqual(['MOld', 'MEdits'])
  })

  it('drops an overlay pointer not present in the source array (no dangling ref)', () => {
    const meta = { objectShardUrls: ['o1'], connectionShardUrls: [], editsObjectShardUrl: 'missing' }
    const out = remapModelMeta(meta, ['N1'], [])
    expect(out.editsObjectShardUrl).toBeUndefined()
  })

  it('does not mutate the input meta', () => {
    const meta = { objectShardUrls: ['o1'], connectionShardUrls: ['c1'] }
    remapModelMeta(meta, ['N1'], ['M1'])
    expect(meta.objectShardUrls).toEqual(['o1'])
  })

  it('preserves the inline collections + tombstones', () => {
    const meta = {
      objectShardUrls: [],
      connectionShardUrls: [],
      groups: { g1: { id: 'g1' } },
      domains: { d1: {} },
      tagSnapshots: {},
      decisionRecords: {},
      deletedObjectIds: ['x'],
    }
    const out = remapModelMeta(meta, [], [])
    expect(out.groups).toEqual({ g1: { id: 'g1' } })
    expect(out.deletedObjectIds).toEqual(['x'])
  })
})

describe('forkRoot — forking a SHARDED source', () => {
  async function readDoc(repo: Repo, url: string): Promise<Record<string, unknown>> {
    const h = await repo.find(url as AutomergeUrl)
    await h.whenReady()
    return h.doc() as Record<string, unknown>
  }

  it('produces a BOOTABLE root: valid modelUrl placeholder + cloned meta/shards/registry', async () => {
    // Regression: a forked root with an EMPTY modelUrl (source had modelMetaUrl
    // set) makes a client that awaits the monolith throw ("Root doc does not
    // have a valid modelUrl"), and its dangling-ref handler silently bounces the
    // user to the DEFAULT workspace.
    const repo = new Repo({ network: [] })
    const objectShard = repo.create({ objects: { o1: { id: 'o1', name: 'Marker' } } })
    const connectionShard = repo.create({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url],
      connectionShardUrls: [connectionShard.url],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const diagramDoc = repo.create({ name: 'D1', type: 'context', objectIds: ['o1'], connectionIds: [], groupIds: [], layouts: {}, comments: {}, flows: {}, checkpoints: [] })
    const registryShard = repo.create({
      diagrams: { d1: { id: 'd1', name: 'D1', type: 'context', docUrl: diagramDoc.url, objectIds: ['o1'], connectionIds: [], groupIds: [] } },
    })
    // A sharded source: modelMetaUrl set, monolith EMPTY (mirrors a post-split fork source).
    const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })

    const { rootUrl: forkedUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    const forked = await readDoc(repo, forkedUrl)

    // Bootable by ANY reader: the monolith placeholder must be a valid doc url.
    expect(isValidAutomergeUrl(forked.modelUrl as string), 'forked root must carry a valid (empty) monolith').toBe(true)
    expect(isValidAutomergeUrl(forked.modelMetaUrl as string)).toBe(true)
    // Deep copy, not shared refs.
    expect(forked.modelMetaUrl).not.toBe(meta.url)
    const forkedMeta = await readDoc(repo, forked.modelMetaUrl as string)
    const forkedObjShardUrl = (forkedMeta.objectShardUrls as string[])[0]
    expect(forkedObjShardUrl).not.toBe(objectShard.url)
    const forkedObjShard = await readDoc(repo, forkedObjShardUrl)
    expect((forkedObjShard.objects as Record<string, { name: string }>).o1.name).toBe('Marker')
    // Registry + diagram doc cloned with the content intact.
    const forkedRegistry = await readDoc(repo, (forked.shardUrls as string[])[0])
    const d1 = (forkedRegistry.diagrams as Record<string, { docUrl: string; objectIds: string[] }>).d1
    expect(d1.objectIds).toEqual(['o1'])
    expect(d1.docUrl).not.toBe(diagramDoc.url)
    // The placeholder monolith is EMPTY (sharded readers ignore it; nothing leaks).
    const forkedMonolith = await readDoc(repo, forked.modelUrl as string)
    expect(Object.keys((forkedMonolith.objects as object) ?? {})).toHaveLength(0)
  })

  it('carries the overlay write heads of a buildModelMeta source through the fork (L8)', async () => {
    // The loss window this closes: remapModelMeta remaps heads by POSITION in the
    // base list, so a head absent from that list is silently dropped and the fork
    // is born head-less — the exact shape that eats every entity edit under
    // boot-from-server. buildModelMeta guarantees head-last; this test is the
    // end-to-end proof that a constructor-shaped source survives a fork with
    // BOTH heads intact, remapped to the CLONES.
    const repo = new Repo({ network: [] })
    const baseObjShard = repo.create({ objects: { o1: { id: 'o1', name: 'A' } } })
    const objHead = repo.create({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] as string[] })
    const connHead = repo.create({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] as string[] })
    const meta = repo.create({
      ...buildModelMeta({
        objectShardUrls: [baseObjShard.url],
        objectWriteHead: objHead.url,
        connectionWriteHead: connHead.url,
      }),
    })
    const registryShard = repo.create({ diagrams: {} })
    const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })

    const { rootUrl: forkedUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    const forked = await readDoc(repo, forkedUrl)
    const forkedMeta = await readDoc(repo, forked.modelMetaUrl as string)

    const objUrls = forkedMeta.objectShardUrls as string[]
    const connUrls = forkedMeta.connectionShardUrls as string[]
    const objEditsHead = forkedMeta.editsObjectShardUrl as string | undefined
    const connEditsHead = forkedMeta.editsConnectionShardUrl as string | undefined
    // Both heads survived, as valid urls pointing at the CLONES, not the source.
    expect(objEditsHead && isValidAutomergeUrl(objEditsHead)).toBe(true)
    expect(connEditsHead && isValidAutomergeUrl(connEditsHead)).toBe(true)
    expect(objEditsHead).not.toBe(objHead.url)
    expect(connEditsHead).not.toBe(connHead.url)
    // Position preserved: the head stays LAST in its base list (a re-fork of the
    // fork depends on it), and the bounded-segment lists follow the same remap.
    expect(objUrls.at(-1)).toBe(objEditsHead)
    expect(connUrls.at(-1)).toBe(connEditsHead)
    expect(forkedMeta.editsObjectShardUrls).toEqual([objEditsHead])
    expect(forkedMeta.editsConnectionShardUrls).toEqual([connEditsHead])
    expect(forkedMeta.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
    // The forked head documents exist and are empty (fresh overlay, no leak).
    const forkedObjHead = await readDoc(repo, objEditsHead!)
    expect(Object.keys((forkedObjHead.objects as object) ?? {})).toHaveLength(0)
  })
})

describe('forkRoot — forking a SUMMARY root (D1)', () => {
  // NOTE: publishing the twin's static row + `read_model_static_documents`
  // allow-list needs a summary fork publisher that does not exist yet, so what
  // is pinned HERE is what `forkRoot` delivers: the summary contract fields
  // survive the fork, and the write head is remapped to the twin's own clone.
  async function readDoc(repo: Repo, url: string): Promise<Record<string, unknown>> {
    const h = await repo.find(url as AutomergeUrl)
    await h.whenReady()
    return h.doc() as Record<string, unknown>
  }

  function summaryFixture(repo: Repo) {
    const meta = repo.create({
      objectShardUrls: [], connectionShardUrls: [],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const baseline = repo.create({
      diagrams: { d1: { id: 'd1', name: 'D1', type: 'context', objectIds: [], connectionIds: [], groupIds: [] } },
    })
    const writeHead = repo.create({ diagrams: {} })
    return { meta, baseline, writeHead }
  }

  it('yields a summary twin with a REMAPPED write head and every contract field round-tripped', async () => {
    const repo = new Repo({ network: [] })
    const { meta, baseline, writeHead } = summaryFixture(repo)
    const srcRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [baseline.url, writeHead.url],
      registryWriteUrl: writeHead.url,
      registrySummaryOnly: true,
      diagramCount: 7,
      sparseDraftBaseVersionId: 'parent-v',
      sparseDraftBaseRootUrl: 'automerge:3Gv8m8A7Ym5MCv71jGAXvfXZ47RC',
    })

    const { rootUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    const forked = await readDoc(repo, rootUrl)

    // The summary contract fields round-trip; an ORDINARY twin (no flag, no
    // count, no write head) would re-materialise the whole registry on boot.
    expect(forked.registrySummaryOnly, 'summary flag must survive the fork').toBe(true)
    expect(forked.diagramCount).toBe(7)
    expect(forked.sparseDraftBaseVersionId).toBe('parent-v')
    expect(forked.sparseDraftBaseRootUrl).toBe('automerge:3Gv8m8A7Ym5MCv71jGAXvfXZ47RC')

    // The write head is REMAPPED: same position, but the TWIN's clone. Copying
    // srcRoot.registryWriteUrl raw would make the twin write into the SOURCE's
    // shard (a shared-doc leak).
    const forkedShards = forked.shardUrls as string[]
    expect(forkedShards).toHaveLength(2)
    expect(forked.registryWriteUrl).toBe(forkedShards[1])
    expect(forked.registryWriteUrl).not.toBe(writeHead.url)
    expect(isValidAutomergeUrl(forked.registryWriteUrl as string)).toBe(true)
    // And the clone really is the write head's copy (empty diagrams map).
    const forkedHead = await readDoc(repo, forked.registryWriteUrl as string)
    expect(forkedHead.diagrams).toEqual({})

    // The twin's root never carries a key outside the closed list.
    const foreign = Object.keys(forked).filter((key) => !(ROOT_SHAPE_FIELDS as readonly string[]).includes(key))
    expect(foreign).toEqual([])
  })

  it('a source without a write head forks a twin without one — nothing invented, nothing leaked', async () => {
    const repo = new Repo({ network: [] })
    const { meta, baseline } = summaryFixture(repo)
    const srcRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [baseline.url],
    })

    const { rootUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    const forked = await readDoc(repo, rootUrl)

    // An ORDINARY source stays ordinary: no summary field appears from nowhere.
    expect(forked).not.toHaveProperty('registryWriteUrl')
    expect(forked).not.toHaveProperty('registrySummaryOnly')
    expect(forked).not.toHaveProperty('diagramCount')
  })

  it('a write head pointing OUTSIDE shardUrls is dropped WITH an operator warning, never inherited from the source', async () => {
    // The damaged-source case: registryWriteUrl names a shard that is not in
    // shardUrls. The remap cannot resolve it; the only safe twin is one with NO
    // write head. Falling back to the source's value would share the source's
    // document with the twin. Fork is an explicit operator/user action, so the
    // drop must also be SAID (a silent drop is a defect waiting for a human to
    // stumble on the head-less twin later).
    const repo = new Repo({ network: [] })
    const { meta, baseline, writeHead } = summaryFixture(repo)
    const srcRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [baseline.url],
      registryWriteUrl: writeHead.url, // valid doc, but NOT a member of shardUrls
      registrySummaryOnly: true,
      diagramCount: 1,
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { rootUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
      const forked = await readDoc(repo, rootUrl)

      expect(forked).not.toHaveProperty('registryWriteUrl')
      expect(forked.registrySummaryOnly).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('non-remappable registry write head')
      expect(String(warn.mock.calls[0][0])).toContain(writeHead.url)
    } finally {
      warn.mockRestore()
    }
  })

  it('an INVALID shardUrls entry BEFORE the write head shifts clone positions — the head still maps to ITS clone (S3)', async () => {
    // The raison d'être of the url-keyed `shardCloneBySourceUrl` map: forkRoot
    // SKIPS invalid shard urls while cloning, so the clone array is SHORTER
    // than the source array and positions shift. The remapModelMeta pattern
    // (indexOf in the SOURCE array, index into the clone array) reads source
    // index 2 here, past the end of the 2-entry clone array — a twin with a
    // silently dropped (or wrong) write head. The map lands on the head's own
    // clone regardless of position.
    const repo = new Repo({ network: [] })
    const { meta, baseline, writeHead } = summaryFixture(repo)
    const srcRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: ['not-a-valid-automerge-url', baseline.url, writeHead.url],
      registryWriteUrl: writeHead.url, // source position 2; clone position 1
      registrySummaryOnly: true,
      diagramCount: 2,
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { rootUrl } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
      const forked = await readDoc(repo, rootUrl)

      const forkedShards = forked.shardUrls as string[]
      expect(forkedShards, 'the invalid entry is skipped, not cloned').toHaveLength(2)
      expect(forked.registryWriteUrl).toBe(forkedShards[1])
      expect(forked.registryWriteUrl).not.toBe(writeHead.url)
      // And it is genuinely the WRITE HEAD's copy, not the baseline's: the
      // write head is empty while the baseline carries d1.
      const forkedHead = await readDoc(repo, forked.registryWriteUrl as string)
      expect(forkedHead.diagrams).toEqual({})
      const forkedBaseline = await readDoc(repo, forkedShards[0])
      expect(Object.keys(forkedBaseline.diagrams as Record<string, unknown>)).toEqual(['d1'])
      // A successful remap is not the drop case: no operator warning.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('forkRoot — a failed fork takes its documents back with it', () => {
  /**
   * THE WIRING, not the module. `forkRollback.test.ts` proves
   * `rollbackForkedDocuments` behaves; these arms prove `forkRoot` calls it,
   * awaits it, hands it the right ids, and keeps the ORIGINAL error when the
   * rollback leaves residue.
   */

  /** Minimal in-memory StorageAdapter: enough for the repo to persist, and
   *  readable by the test so "was it actually removed" is a fact, not a spy. */
  class MemoryStorage {
    readonly chunks = new Map<string, Uint8Array>()
    /** Set to reject, to model the exhausted pool that triggers a rollback. */
    removeRejects = false
    private text(key: readonly string[]): string { return key.join('/') }
    async load(key: string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.text(key)) }
    async save(key: string[], data: Uint8Array): Promise<void> { this.chunks.set(this.text(key), data) }
    async remove(key: string[]): Promise<void> { this.chunks.delete(this.text(key)) }
    async loadRange(prefix: string[]): Promise<{ key: string[]; data: Uint8Array }[]> {
      const p = this.text(prefix)
      return [...this.chunks.entries()]
        .filter(([k]) => k === p || k.startsWith(`${p}/`))
        .map(([k, data]) => ({ key: k.split('/'), data }))
    }
    async removeRange(prefix: string[]): Promise<void> {
      if (this.removeRejects) throw new Error('timeout exceeded when trying to connect')
      const p = this.text(prefix)
      for (const k of [...this.chunks.keys()]) if (k === p || k.startsWith(`${p}/`)) this.chunks.delete(k)
    }
    /** Document ids with at least one surviving chunk. */
    documentIds(): string[] { return [...new Set([...this.chunks.keys()].map((k) => k.split('/')[0]!))] }
  }

  function sourceGraph(storage: MemoryStorage): { repo: Repo; srcRootUrl: string } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new Repo({ network: [], storage: storage as any })
    const objectShard = repo.create({ objects: { o1: { id: 'o1', name: 'Marker' } } })
    const meta = repo.create({
      objectShardUrls: [objectShard.url], connectionShardUrls: [],
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const registryShard = repo.create({ diagrams: {} })
    const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })
    return { repo, srcRootUrl: srcRoot.url }
  }

  /** Fail AFTER every document is created and PERSISTED — the post-flush window.
   *
   *  ⚠ The real flush must run FIRST. A plain `mockRejectedValue` rejects
   *  before the debounced save fires, so no document is ever durable, there is
   *  nothing for a rollback to remove, and every arm would pass with the
   *  rollback DELETED. */
  async function forkFailingAtFlush(): Promise<{ storage: MemoryStorage; before: string[]; error: unknown }> {
    const storage = new MemoryStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const before = storage.documentIds()
    expect(before.length, 'the source must be durable, or these arms assert nothing').toBeGreaterThan(0)

    const realFlush = repo.flush.bind(repo)
    const flush = vi.spyOn(repo, 'flush').mockImplementation(async (ids?: DocumentId[]) => {
      await realFlush(ids)
      throw new Error('timeout exceeded when trying to connect')
    })
    let error: unknown
    try { await forkRoot(repo, srcRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' })) } catch (err) { error = err }
    flush.mockRestore()
    return { storage, before, error }
  }

  it('removes the documents it created, and rethrows the ORIGINAL failure', async () => {
    const { storage, before, error } = await forkFailingAtFlush()
    expect((error as Error).message, 'the fork failure must survive the rollback').toMatch(/timeout exceeded/)
    const leaked = storage.documentIds().filter((id) => !before.includes(id))
    expect(leaked, 'a failed fork must leave no document behind').toEqual([])
  })

  it('keeps the ORIGINAL failure even when the rollback leaves residue', async () => {
    // The scenario the module exists for: the fork fails AND its cleanup
    // fails. The cleanup's error must never replace the fork's.
    const storage = new MemoryStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: DocumentId[]) => {
      await realFlush(ids)
      throw new Error('timeout exceeded when trying to connect')
    })
    storage.removeRejects = true

    await expect(forkRoot(repo, srcRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' })))
      .rejects.toThrow(/timeout exceeded/)
  })

  it('AWAITS the rollback — the fork does not reject while removals are in flight', async () => {
    // Reading storage AFTER awaiting the rejection cannot see the difference:
    // the await itself gives an un-awaited rollback enough microtask turns to
    // finish. Suspending the removal is what makes `void` vs `await`
    // observable.
    const storage = new MemoryStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()

    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const realRemoveRange = storage.removeRange.bind(storage)
    storage.removeRange = async (prefix: string[]): Promise<void> => {
      await held
      await realRemoveRange(prefix)
    }

    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: DocumentId[]) => {
      await realFlush(ids)
      throw new Error('timeout exceeded when trying to connect')
    })

    const forking = forkRoot(repo, srcRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))
    let settled = false
    void forking.catch(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled, 'forkRoot must not settle while its rollback is suspended').toBe(false)

    release()
    await expect(forking).rejects.toThrow(/timeout exceeded/)
  })

  it('hands the rollback EVERY document it created — not an empty list', async () => {
    // Passing `[]` to the rollback would leave every other arm green.
    const storage = new MemoryStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const torn: string[] = []
    const realRemove = repo.removeFromCache.bind(repo)
    vi.spyOn(repo, 'removeFromCache').mockImplementation(async (id) => {
      torn.push(String(id))
      await realRemove(id)
    })
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: DocumentId[]) => {
      await realFlush(ids)
      throw new Error('boom')
    })
    try { await forkRoot(repo, srcRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' })) } catch { /* expected */ }
    expect(torn.length, 'the fork creates several documents; all must be torn down').toBeGreaterThan(3)
  })

  it('leaves the SOURCE documents untouched — the rollback removes its own, not the graph it copied', async () => {
    const { storage, before } = await forkFailingAtFlush()
    expect(before.length, 'an empty source set would make this arm vacuous').toBeGreaterThan(0)
    for (const id of before) {
      expect(storage.documentIds(), `source document ${id} must survive a failed fork`).toContain(id)
    }
  })

  it('KNOWN GAP, pinned — a fork failing BEFORE its flush is written back by the armed save; the reaper, not this rollback, reclaims it', async () => {
    // Every document Automerge creates has a save armed immediately, and
    // `StorageSource.detach` cannot cancel it (forkRollback.ts, § the armed
    // save). This arm asserts the gap EXISTS — presence, not absence — so that
    // no rollback can claim it away without turning this red, and so that the
    // day automerge-repo grows a cancel this arm says so.
    //
    // The first three reads pass through (root, ModelMeta, one object shard —
    // THREE documents created by then) and the fourth throws; failing on the
    // first read would create nothing and prove nothing.
    const storage = new MemoryStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const before = storage.documentIds()
    expect(before.length).toBeGreaterThan(0)

    // HOLD every adapter save from here on. Otherwise the arm depends on the
    // rollback's removal finishing inside the 100 ms debounce, and a slow box
    // lets the save land first and the removal delete it (a false red).
    // Gating the adapter makes the order a fact, not a race:
    // removal runs against an empty store, the armed save is parked at the
    // adapter, and releasing it AFTER the rollback is what lands the write.
    let releaseSaves!: () => void
    const savesHeld = new Promise<void>((resolve) => { releaseSaves = resolve })
    const realSave = storage.save.bind(storage)
    storage.save = async (key: string[], data: Uint8Array): Promise<void> => {
      await savesHeld
      await realSave(key, data)
    }

    const torn: string[] = []
    const realRemove = repo.removeFromCache.bind(repo)
    vi.spyOn(repo, 'removeFromCache').mockImplementation(async (id) => {
      torn.push(String(id))
      await realRemove(id)
    })
    const realFind = repo.find.bind(repo)
    let reads = 0
    vi.spyOn(repo, 'find').mockImplementation(((...args: Parameters<Repo['find']>) => {
      reads += 1
      if (reads > 3) throw new Error('source read failed mid-fork')
      return realFind(...args)
    }) as Repo['find'])
    await expect(forkRoot(repo, srcRootUrl, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-fork' }, { kind: 'unfenced', reason: 'no-forker' }))).rejects.toThrow(/source read failed mid-fork/)

    // PRESENCE FIRST: documents existed and were torn down.
    expect(torn.length, 'the fork must have created documents before failing, or this arm proves nothing').toBe(3)
    expect(storage.documentIds().filter((id) => !before.includes(id)), 'nothing durable at the instant of rollback').toEqual([])

    // Past the debounce, so every armed timer has fired into the held adapter;
    // then release, and the parked saves land on a store the rollback already
    // swept.
    await new Promise((resolve) => setTimeout(resolve, 300))
    releaseSaves()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const leaked = storage.documentIds().filter((id) => !before.includes(id))
    expect(leaked.length, 'the armed save writes the torn-down documents back — the measured gap this suite pins').toBe(3)
    expect(leaked.sort()).toEqual([...torn].sort())
  })
})

describe('forkRoot — every document is NAMED for the target (B2-5h)', () => {
  it('with a mint key and a documents registration, every created id verifies BOUND to the target and to nothing else', async () => {
    const savedSecret = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'forkRoot-named-test-secret'
    const restore = setWorkspaceDocumentsRegistrationForTest(async () => ({ claimed: [], alreadyOurs: [], foreign: [], missingVersion: false }))
    try {
      const repo = new Repo({ network: [] })
      const objectShard = repo.create({ objects: { o1: { id: 'o1' } } })
      const meta = repo.create({ objectShardUrls: [objectShard.url], connectionShardUrls: [], groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
      const diagramDoc = repo.create({ name: 'D1', type: 'context', objectIds: [], connectionIds: [], groupIds: [], checkpoints: [] })
      const registryShard = repo.create({ diagrams: { d1: { id: 'd1', name: 'D1', type: 'context', docUrl: diagramDoc.url } } })
      const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })
      const target = { landscapeId: 'L-named', versionId: 'V-child' }
      const sibling = { landscapeId: 'L-named', versionId: 'V-parent' }

      const { createdDocumentIds } = await forkRoot(repo, srcRoot.url, openBootstrapScope(target, { kind: 'unfenced', reason: 'no-forker' }))
      // root + meta + monolith + object shard + registry shard + diagram = 6
      expect(createdDocumentIds).toHaveLength(6)
      for (const id of createdDocumentIds) {
        expect(isMintedDocumentId(id), `${id} must be a minted id`).toBe(true)
        expect(verifyDocumentId(target, id).kind, `${id} must be bound to the target`).toBe('bound')
        expect(verifyDocumentId(sibling, id).kind, `${id} must not verify for the parent`).toBe('foreign')
      }
      // The SOURCE keeps its legacy names: nothing was renamed, only copied.
      for (const handle of [objectShard, meta, diagramDoc, registryShard, srcRoot]) {
        expect(isMintedDocumentId(String(handle.documentId))).toBe(false)
      }
    } finally {
      restore()
      if (savedSecret === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = savedSecret
    }
  })

  it('control — without a mint key the same fork creates legacy ids, and still six of them', async () => {
    const savedSecret = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    try {
      const repo = new Repo({ network: [] })
      const objectShard = repo.create({ objects: {} })
      const meta = repo.create({ objectShardUrls: [objectShard.url], connectionShardUrls: [], groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
      const diagramDoc = repo.create({ name: 'D1', type: 'context', objectIds: [], connectionIds: [], groupIds: [], checkpoints: [] })
      const registryShard = repo.create({ diagrams: { d1: { id: 'd1', name: 'D1', type: 'context', docUrl: diagramDoc.url } } })
      const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })
      const { createdDocumentIds } = await forkRoot(repo, srcRoot.url, openBootstrapScope({ landscapeId: 'L', versionId: 'V' }, { kind: 'unfenced', reason: 'no-forker' }))
      expect(createdDocumentIds).toHaveLength(6)
      for (const id of createdDocumentIds) expect(isMintedDocumentId(id)).toBe(false)
    } finally {
      if (savedSecret !== undefined) process.env.AUTH_SECRET = savedSecret
    }
  })
})

/**
 * THE FENCE'S HALF, at the fork: every document a fenced scope mints
 * carries the forker's key at the instant Automerge writes it, a fork the
 * fence refuses is torn down without a durable pass, and a failed fork's
 * notes are RETIRED, never purged.
 */
describe('forkRoot — under a fenced scope (B2-5d)', () => {
  const FORKER = { landscapeId: 'L-fenced', versionId: 'V-parent' }
  const TARGET = { landscapeId: 'L-fenced', versionId: 'V-child' }
  let uninstall: (() => void) | null = null
  beforeEach(() => {
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
    uninstall = installBootstrapOwnership({
      required: () => true,
      current: () => ({ enabled: true, owns: () => true, fencingToken: () => '7' }),
    })
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
    vi.restoreAllMocks()
  })

  /** Records the fence's read at every save and every removal. */
  class FenceProbeStorage {
    readonly chunks = new Map<string, Uint8Array>()
    readonly saves: { documentId: string; placement: string | null }[] = []
    readonly removals: string[] = []
    /** Refuse every save of a document whose id is in this set — the fence. */
    refuse = new Set<string>()
    private text(key: readonly string[]): string { return key.join('/') }
    async load(key: string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.text(key)) }
    async save(key: string[], data: Uint8Array): Promise<void> {
      const placement = bootstrapPlacementFor(key[0]!)
      this.saves.push({ documentId: key[0]!, placement: placement ? `${placement.landscapeId}/${placement.versionId}` : null })
      if (this.refuse.has(key[0]!)) throw new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')
      this.chunks.set(this.text(key), data)
    }
    async remove(key: string[]): Promise<void> { this.chunks.delete(this.text(key)) }
    async loadRange(prefix: string[]): Promise<{ key: string[]; data: Uint8Array }[]> {
      const p = this.text(prefix)
      return [...this.chunks.entries()].filter(([k]) => k === p || k.startsWith(`${p}/`)).map(([k, data]) => ({ key: k.split('/'), data }))
    }
    async removeRange(prefix: string[]): Promise<void> {
      this.removals.push(prefix[0]!)
      const p = this.text(prefix)
      for (const k of [...this.chunks.keys()]) if (k === p || k.startsWith(`${p}/`)) this.chunks.delete(k)
    }
  }

  function sourceGraph(storage: FenceProbeStorage): { repo: Repo; srcRootUrl: string } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new Repo({ network: [], storage: storage as any, saveDebounceRate: 0 })
    const objectShard = repo.create({ objects: { o1: { id: 'o1' } } })
    const meta = repo.create({ objectShardUrls: [objectShard.url], connectionShardUrls: [], groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
    const diagramDoc = repo.create({ name: 'D1', type: 'context', objectIds: [], connectionIds: [], groupIds: [], checkpoints: [] })
    const registryShard = repo.create({ diagrams: { d1: { id: 'd1', name: 'D1', type: 'context', docUrl: diagramDoc.url } } })
    const srcRoot = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registryShard.url] })
    return { repo, srcRootUrl: srcRoot.url }
  }

  it('every save of every created document sees the FORKER — the storage fence has its key before the first chunk', async () => {
    const storage = new FenceProbeStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const scope = openBootstrapScope(TARGET, { kind: 'forker', workspace: FORKER })
    const { createdDocumentIds } = await forkRoot(repo, srcRootUrl, scope)
    expect(createdDocumentIds).toHaveLength(6)
    const created = new Set(createdDocumentIds)
    const saves = storage.saves.filter((save) => created.has(save.documentId))
    expect(saves.length, 'the repo never saved a forked document — this arm proved nothing').toBeGreaterThanOrEqual(6)
    expect(saves.map((save) => save.placement)).toEqual(saves.map(() => `${FORKER.landscapeId}/${FORKER.versionId}`))
    // The SOURCE keeps no note: only what the scope minted is fenced under it.
    for (const save of storage.saves.filter((save) => !created.has(save.documentId))) {
      expect(save.placement).toBeNull()
    }
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 6, retired: 0 })
  })

  it('KILLS the durable pass on a fence refusal: torn down, nothing removed, notes RETIRED and still answering', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = new FenceProbeStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const before = [...storage.chunks.keys()]
    // Refuse the FIRST forked save: the fence's `ownership-unavailable`, from
    // inside the adapter, exactly where a lease-less cell meets it.
    const scope = openBootstrapScope(TARGET, { kind: 'forker', workspace: FORKER })
    const originalCreate = scope.create.bind(scope)
    const created: string[] = []
    scope.create = <T extends object>(r: Repo, value: T) => {
      const handle = originalCreate(r, value)
      created.push(String(handle.documentId))
      storage.refuse.add(String(handle.documentId))
      return handle
    }
    await expect(forkRoot(repo, srcRootUrl, scope)).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(created.length, 'the fork minted before it was refused, or this arm proves nothing').toBeGreaterThan(0)
    // Nothing of the fork is durable, and the SOURCE is intact.
    expect([...storage.chunks.keys()].filter((k) => !before.includes(k))).toEqual([])
    // No removal was even attempted: the rollback classified the cause.
    expect(storage.removals.filter((id) => created.includes(id))).toEqual([])
    expect(String(warn.mock.calls.map((c) => c[0]).find((line) => /refused by the storage fence/.test(String(line))))).toMatch(/removal not attempted/)
    // RETIRED, not purged: the write-back of a torn-down document still meets
    // the fence with the forker's key.
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: created.length })
    for (const id of created) expect(bootstrapPlacementFor(id)).toEqual(FORKER)
  })

  it('a fork that fails for ANOTHER reason keeps its durable pass, and its notes are retired too', async () => {
    const storage = new FenceProbeStorage()
    const { repo, srcRootUrl } = sourceGraph(storage)
    await repo.flush()
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: DocumentId[]) => {
      await realFlush(ids)
      throw new Error('timeout exceeded when trying to connect')
    })
    const scope = openBootstrapScope(TARGET, { kind: 'forker', workspace: FORKER })
    await expect(forkRoot(repo, srcRootUrl, scope)).rejects.toThrow(/timeout exceeded/)
    expect(storage.removals.length, 'the durable pass ran').toBeGreaterThan(0)
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: 6 })
  })
})
