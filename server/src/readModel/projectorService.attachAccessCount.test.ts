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

import { describe, it, expect, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { awaitInitialDiagramProbe, startReadModelProjector } from './projectorService.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * `attachDiagramDoc` and `repo.handles`: the anti-orphan guard runs once per
 * attached diagram.
 *
 * `Repo.get handles()` is not a table: it ALLOCATES a fresh `Record` and copies
 * every entry of `#queries` on each access (~0.2 ms at 1 000 documents,
 * ~3.4 ms at 10 000). The guard in `projectThenWatch` runs once per diagram,
 * attaches are concurrent (`resolveInBatches`) and also start from the
 * resident sweep, so there is no loop to hoist the read out of. On a
 * 30k-diagram workspace that would be O(n) per attach, quadratic over a boot.
 *
 * The guard therefore uses the O(1) `syncedHandle` seam
 * (`automergeRepoCompat.ts`), proved equivalent in every reachable state by
 * `automergeRepoCompat.seam.test.ts`. The two tests below pin both sides:
 *
 *  1. COST — a test observing only the result would pass against the O(n)
 *     getter, which returns exactly the same answer. Only the ACCESS COUNT
 *     separates them;
 *  2. SEMANTICS — the guard protects more than a leaked listener. Installing
 *     the watcher also writes `diagramWatchers.set(docUrl, …)`, and the
 *     resident sweep skips every url present in `diagramWatchers`. A watcher
 *     installed on an already-evicted handle therefore dooms the diagram: when
 *     the document becomes resident again under a NEW handle object, nothing
 *     re-attaches and the diagram stops projecting, permanently and silently.
 *
 * No database: the `Queryable` is an in-memory fake, so this file runs
 * identically without Postgres or Redis and needs no entry in
 * `test-skip-allowlist.json`.
 */
describe('T11.3bis site B — les attaches de diagrammes et repo.handles', () => {
  /**
   * A real Repo, with `handles` instrumented to count reads.
   *
   * Duplicated from `automergeServer.residentHeads.test.ts` rather than
   * imported: a `*.test.ts` must not import from another
   * `*.test.ts`, and server production code must never import from a shared
   * testing directory — so the eight lines are copied on purpose.
   *
   * COUNT, not timing: a timing assertion on a 50-document repo is noise, and
   * this repository bans them for this purpose. The access count is the only
   * observable that separates the O(n) getter from the O(1) seam.
   */
  function countingRepo(options: ConstructorParameters<typeof Repo>[0] = { network: [] }) {
    const repo = new Repo(options)
    let handlesReads = 0
    const original = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(repo), 'handles',
    )
    expect(original?.get, 'repo.handles must still be a getter').toBeTypeOf('function')
    Object.defineProperty(repo, 'handles', {
      configurable: true,
      get() { handlesReads += 1; return original!.get!.call(repo) },
    })
    return { repo, reads: () => handlesReads }
  }

  /**
   * Minimal in-memory StorageAdapter, so an evicted document can be RELOADED.
   * That reload is what makes the production failure observable at all: it
   * produces a NEW DocHandle, and a listener left on the old one never fires
   * again. (Copied from the residency block of `projectorService.test.ts` for
   * the same no-cross-test-import reason as above.)
   */
  class MemoryStorage {
    private readonly chunks = new Map<string, Uint8Array>()
    private key(key: readonly string[]): string { return key.join('/') }
    async load(key: readonly string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.key(key)) }
    async save(key: readonly string[], data: Uint8Array): Promise<void> { this.chunks.set(this.key(key), data) }
    async remove(key: readonly string[]): Promise<void> { this.chunks.delete(this.key(key)) }
    async loadRange(prefix: readonly string[]): Promise<Array<{ key: string[]; data: Uint8Array }>> {
      const head = this.key(prefix)
      return [...this.chunks.entries()]
        .filter(([key]) => key.startsWith(head))
        .map(([key, data]) => ({ key: key.split('/'), data }))
    }
    async removeRange(prefix: readonly string[]): Promise<void> {
      const head = this.key(prefix)
      for (const key of [...this.chunks.keys()]) if (key.startsWith(head)) this.chunks.delete(key)
    }
  }

  /** Statement unique to `syncConnectionFlows` — one flow projection, one row. */
  const FLOW_PROJECTION = /SELECT DISTINCT connection_id FROM ro_connection_flows/

  /**
   * A `Queryable` that records every statement, ticks the two sequences the
   * projector consumes, and honours the write-fence CAS. Trimmed copy of
   * `fakeDb()` in `projectorService.test.ts`: answering `rows: []` to the fence
   * reads would abort every tracked projection, and answering nothing to
   * `nextval` would crash the arrival watermark on `rows[0]`.
   */
  function fakeDb() {
    const queries: string[] = []
    let generation = 0
    let arrivalSeq = 0
    let fence: string | null = null
    const db: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        queries.push(text)
        if (/RETURNING observed_generation/.test(text)) {
          generation += 1
          return { rows: [{ observed_generation: generation }] as never[], rowCount: 1 }
        }
        if (/nextval\('automerge_arrival_seq'\)/.test(text)) {
          arrivalSeq += 1
          return { rows: [{ w: String(arrivalSeq) }] as never[], rowCount: 1 }
        }
        if (/write_fence = EXCLUDED\.write_fence/.test(text)) {
          const expectedPrevious = (params?.[4] as string | null | undefined) ?? null
          if (fence !== expectedPrevious) return { rows: [], rowCount: 0 }
          fence = (params?.[3] as string | undefined) ?? null
          return { rows: [], rowCount: 1 }
        }
        if (/SELECT write_fence FROM read_model_projection_state/.test(text)) {
          return { rows: [{ write_fence: fence }] as never[], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    return {
      db,
      queries,
      flowProjections: () => queries.filter((text) => FLOW_PROJECTION.test(text)).length,
    }
  }

  /** A sharded workspace whose registry references `count` diagram documents. */
  async function workspaceOf(repo: Repo, count: number) {
    const diagramHandles = Array.from({ length: count }, (_, index) => repo.create({
      flows: { [`f${index}`]: { id: `f${index}`, steps: [{ connectionId: `c${index}` }] } },
    }))
    const diagrams = Object.fromEntries(diagramHandles.map((handle, index) => [
      `d${index}`,
      { id: `d${index}`, name: `D${index}`, docUrl: handle.url, objectIds: [] },
    ]))
    const objectShard = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const connectionShard = repo.create({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url], connectionShardUrls: [connectionShard.url], groups: {},
    })
    const registry = repo.create({ diagrams })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([
      ...diagramHandles, objectShard, connectionShard, meta, registry, root,
    ].map((handle) => handle.whenReady()))
    return { diagramHandles, root }
  }

  /**
   * Count 'change' registration ATTEMPTS on ONE handle object.
   *
   * Deliberately not `handle.listenerCount('change')`: the vendored
   * `patch-automerge-peer-sync-state.mjs` leaves one internal listener on every
   * ready handle, so a perfect detach lands on 1 and the count is unreadable.
   * Shadowing `on` on this instance counts only what happens AFTER the spy is
   * installed, and it is per-object — a watcher installed on a re-opened handle
   * is a different object and cannot be mistaken for one on the dead one.
   */
  type ChangeWatchable = { on: (event: string, fn: (...args: unknown[]) => void) => void }
  function spyChangeWatchers(handle: DocHandle<unknown>): () => number {
    const target = handle as unknown as ChangeWatchable
    const inherited = target.on.bind(target)
    let installs = 0
    target.on = (event, fn) => {
      if (event === 'change') installs += 1
      return inherited(event, fn)
    }
    return () => installs
  }

  const ATTACHES = 50

  /**
   * TEST 1 — the access count.
   *
   * Catches `if (repo.handles[handle.documentId] !== handle) return` in place
   * of `syncedHandle`. That form returns the RIGHT answer, so any test on the
   * outcome (watcher installed, flows projected, diagram healthy) passes
   * against it; it costs a full rebuild of the resident-document `Record` per
   * attached diagram, and that cost alone is what this assertion sees. Same
   * for `Object.keys(repo.handles).includes(id)` or a local alias hoisted out
   * of the function (which would also be stale at guard time).
   */
  it('n\'ouvre JAMAIS repo.handles, sur 50 attaches de diagrammes concurrentes', async () => {
    const key: WorkspaceKey = { landscapeId: 'ls-attach-count', versionId: 'v1' }
    const { repo, reads } = countingRepo()
    const { diagramHandles, root } = await workspaceOf(repo, ATTACHES)
    const installs = diagramHandles.map((handle) => spyChangeWatchers(handle))
    const store = fakeDb()

    const before = reads()
    // No residency and no resident sweep (0 disables it): the sweep legitimately
    // reads `repo.handles` once per tick, hoisted out of its loop. Letting it
    // run would mix its read with the ones being measured.
    const stop = await startReadModelProjector(repo, root.url, store.db, key, undefined, 0)
    // The projector does not await the initial diagram probe.
    await awaitInitialDiagramProbe(key)
    try {
      // LOAD GUARD — without it, "0 reads" would also be the score of a run
      // where nothing attached. An installed watcher PROVES the guard line ran
      // and passed, once per diagram.
      const watchersInstalled = installs.reduce((total, count) => total + count(), 0)
      expect(watchersInstalled, 'les 50 attaches doivent avoir eu lieu').toBe(ATTACHES)
      expect(store.flowProjections(), 'chaque diagramme doit avoir projeté ses flows')
        .toBeGreaterThanOrEqual(ATTACHES)

      // Not "few": ZERO. A site that runs once per diagram has no budget for a
      // getter that is O(n) in resident documents.
      expect(
        reads() - before,
        'la garde anti-orphelin doit passer par la couture O(1) syncedHandle',
      ).toBe(0)
    } finally {
      stop()
    }
  }, 60_000)

  /**
   * TEST 2 — the guard still protects, and does not over-protect.
   *
   * Catches both: a guard that ALWAYS returns (the diagram silently never
   * projects again — control arm) and a guard that NEVER returns (the orphan:
   * watcher on a dead handle + a `diagramWatchers` entry that blinds the
   * resident sweep forever — eviction arm). An O(1) substitution breaking
   * either half would pass a test that held only one.
   */
  it('n\'installe ni watcher ni entrée diagramWatchers sur un handle évincé pendant l\'attache', async () => {
    // ----------------------------------------------------------------- arm 1:
    // the eviction lands BETWEEN `project()` and the watcher install. The
    // window is opened deliberately — the flow projection is held open until
    // the eviction has happened — rather than raced for.
    const key: WorkspaceKey = { landscapeId: 'ls-attach-evicted', versionId: 'v1' }
    const repo = new Repo({ storage: new MemoryStorage() as never })
    const { diagramHandles: [diagramDoc], root } = await workspaceOf(repo, 1)
    const residency = new AutomergeResidencyLeases(repo)
    const store = fakeDb()
    // Durable first, like production storage: otherwise the eviction discards
    // the only copy and the reload below finds the document unavailable.
    await repo.flush()
    const installsOnDeadHandle = spyChangeWatchers(diagramDoc)

    let releaseFlow: (() => void) | null = null
    const entered = new Promise<void>((resolveEntered) => {
      const inner = store.db.query.bind(store.db)
      store.db.query = (async (text: string, params?: unknown[]) => {
        if (FLOW_PROJECTION.test(text) && !releaseFlow) {
          const gate = new Promise<void>((release) => { releaseFlow = release })
          resolveEntered()
          await gate
        }
        return inner(text, params)
      }) as typeof store.db.query
    })

    const starting = startReadModelProjector(repo, root.url, store.db, key, residency, 20)
    await entered

    // The idle sweep reclaims the document while the attach is still in
    // flight. It holds no lease (by design), so it is evicted.
    await expect(residency.evict(diagramDoc.documentId)).resolves.toBe(true)
    releaseFlow!()
    const stop = await starting
    // `startReadModelProjector` does NOT await the diagram probe: without this,
    // the absence assertion below could be read before the guard line even
    // ran — an absence no code produced.
    await awaitInitialDiagramProbe(key)

    try {
      expect(
        installsOnDeadHandle(),
        'aucun watcher ne doit être posé sur le handle que le repo a déjà lâché',
      ).toBe(0)

      // ...and above all: NO `diagramWatchers` entry for this url. The map is
      // private to the projector; the resident sweep reveals it exactly, since
      // it skips every url in it. The document comes back and we wait for the
      // RE-ATTACH itself (which re-projects) without causing any change: a
      // projection that restarts proves the sweep was not blinded.
      const reloaded = await repo.find(diagramDoc.url)
      expect(reloaded, 'un document rouvert est un NOUVEL objet handle').not.toBe(diagramDoc)
      const beforeReattach = store.flowProjections()
      await vi.waitFor(() => {
        expect(store.flowProjections()).toBeGreaterThan(beforeReattach)
      }, { timeout: 5_000 })

      // And the change stream is live on the new handle. The sweep has just
      // registered the url in `diagramWatchers` and now skips it, so this
      // second increase can only come from the watcher.
      const beforeChange = store.flowProjections()
      await vi.waitFor(() => {
        reloaded.change((doc: { flows: Record<string, unknown> }) => {
          doc.flows.f2 = { id: 'f2', steps: [{ connectionId: 'c2' }] }
        })
        expect(store.flowProjections()).toBeGreaterThan(beforeChange)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }

    // ----------------------------------------------------------------- arm 2:
    // the control. Without eviction the watcher MUST be installed — this arm
    // catches a guard that always returns, which arm 1 cannot, since "no
    // watcher" is exactly arm 1's expected result.
    const controlKey: WorkspaceKey = { landscapeId: 'ls-attach-control', versionId: 'v1' }
    const controlRepo = new Repo({ storage: new MemoryStorage() as never })
    const control = await workspaceOf(controlRepo, 1)
    const controlDoc = control.diagramHandles[0]
    const controlStore = fakeDb()
    const controlInstalls = spyChangeWatchers(controlDoc)

    // Resident sweep disabled (0) DELIBERATELY: with it, a guard that always
    // returns would still re-project the document every tick
    // (`attachDiagramDoc` projects BEFORE guarding), and "it projects" would
    // stop discriminating. Here the only possible path is the watcher.
    const stopControl = await startReadModelProjector(
      controlRepo, control.root.url, controlStore.db, controlKey, undefined, 0,
    )
    await awaitInitialDiagramProbe(controlKey)
    try {
      expect(controlInstalls(), 'sans éviction, le watcher DOIT être posé, une fois').toBe(1)
      const beforeChange = controlStore.flowProjections()
      expect(beforeChange, 'garde de charge : l\'attache initiale a bien projeté')
        .toBeGreaterThan(0)
      await vi.waitFor(() => {
        controlDoc.change((doc: { flows: Record<string, unknown> }) => {
          doc.flows.f9 = { id: 'f9', steps: [{ connectionId: 'c9' }] }
        })
        expect(controlStore.flowProjections()).toBeGreaterThan(beforeChange)
      }, { timeout: 5_000 })
    } finally {
      stopControl()
    }
  }, 60_000)
})
