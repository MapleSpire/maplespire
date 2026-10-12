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

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { Repo } from '@automerge/automerge-repo'
import { mintDocumentIdBytes } from './documentIdMint.js'
import { WorkspaceDocIndex, buildAccessCheck, buildWorkspaceRouteCheck, allowedWorkspaceKeys, ensureScopesForExistingWorkspaces, notifyWorkspaceCreated, docScopeGateMissTotal, docScopeMetricSamples, MAX_STALE_REPAIR_FAILURES, STALE_REPAIR_MIN_INTERVAL_MS, type PeerIdentityLookup } from './docScope.js'
import { renderPrometheus } from '../runtime/metrics.js'
import { ensureAuthSchema, ensureDefaultOrg } from '../auth/schema.js'
import { ensureRbacSchema, upsertVersionScope } from './schema.js'
import type { SessionClaims } from '../auth/tokens.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { AutomergeResidencyLeases, REPO_BASELINE_CHANGE_LISTENERS } from '../automergeResidency.js'
import { evictWorkspaceDocumentCache } from '../syncCells/repoFreshness.js'

/**
 * Testing gates: the docScope walk on in-memory Repo docs, and the access gate
 * matrix (off/dual/on x known/unknown peer x allowed/denied doc). The doc-graph WALK itself is exercised purely
 * in-memory (a `Repo` with no network, built the same way
 * forkRoot.test.ts / selectiveSync.integration.test.ts build fixture trees) —
 * no DB needed for that part. `allowedWorkspaceKeys` / the end-to-end
 * `buildAccessCheck` matrix need the real `versions`/RBAC tables, so those
 * are gated on TEST_DATABASE_URL like rbac.test.ts.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

// ---------------------------------------------------------------------
// In-memory doc-graph walk (DB-free)
// ---------------------------------------------------------------------

describe('WorkspaceDocIndex — doc graph walk (in-memory Repo, no DB)', () => {
  /** A pool double satisfying only the `listVersionRows` query shape used by
   * `ensureAllWorkspacesWalked` — never called in these tests since every
   * workspace is primed via the constructor's `notifyWorkspaceCreated` path,
   * but typed so `new WorkspaceDocIndex(repo, pool)` compiles without a real pg.Pool. */
  function fakePool(): pg.Pool {
    return { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  }

  it('indexes root + model + meta + shards + registry + diagram docs for one workspace', async () => {
    const repo = new Repo({})
    const objShard = repo.create({ objects: { o1: {} } })
    const connShard = repo.create({ connections: {} })
    const decisionRecordShard = repo.create({ decisionRecords: { adr1: {} } })
    const meta = repo.create({
      objectShardUrls: [objShard.url],
      connectionShardUrls: [connShard.url],
      decisionRecordShardUrls: [decisionRecordShard.url],
    })
    const diagram = repo.create({ name: 'D1' })
    const registry = repo.create({ diagrams: { d1: { docUrl: diagram.url } } })
    const monolith = repo.create({ objects: {} })
    const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await Promise.all([objShard, connShard, decisionRecordShard, meta, diagram, registry, monolith, root].map((h) => h.whenReady()))

    const index = new WorkspaceDocIndex(repo, fakePool(), { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L1', versionId: 'V1', rootUrl: root.url })
    // notifyWorkspaceCreated fires the walk asynchronously (fire-and-forget);
    // resolveDocWorkspace awaits ensureAllWorkspacesWalked as a fallback, but
    // that reads from the (empty) fake pool — so poll resolveDocWorkspace
    // directly on each doc id, which triggers/awaits the SAME in-flight walk
    // via the byWorkspace entry the constructor's callback created.
    const expectResolves = async (docId: string) => {
      const deadline = Date.now() + 2000
      let last: unknown = null
      while (Date.now() < deadline) {
        last = await index.resolveDocWorkspace(docId)
        if (last) return last
        await new Promise((r) => setTimeout(r, 20))
      }
      return last
    }

    await expect(expectResolves(String(root.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(meta.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(objShard.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(connShard.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(decisionRecordShard.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(registry.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(diagram.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(expectResolves(String(monolith.documentId))).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('a doc never linked into any workspace resolves to null (default-deny quarantine)', async () => {
    const repo = new Repo({})
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await root.whenReady()
    const orphan = repo.create({ objects: {} })
    await orphan.whenReady()

    const index = new WorkspaceDocIndex(repo, fakePool(), { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L2', versionId: 'V2', rootUrl: root.url })
    // Give the walk a moment; the orphan must never appear regardless.
    await new Promise((r) => setTimeout(r, 200))
    expect(await index.resolveDocWorkspace(String(orphan.documentId))).toBeNull()
  })

  it('walks the workspace catalog only once across repeated unknown-document misses', async () => {
    const repo = new Repo({})
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await root.whenReady()
    let catalogReads = 0
    const pool = {
      query: async (sql: string) => {
        // MATCHED ON THE TABLE, not on a column order: the catalog read goes
        // through a shared enumerator whose exact SELECT spelling may change,
        // and a counter keyed on one spelling would silently stay at zero.
        if (sql.includes('FROM versions')) {
          catalogReads += 1
          return { rows: [{ id: 'V-bounded', landscape_id: 'L-bounded', root_url: root.url }] }
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(repo, pool, { durable: false })

    await expect(index.resolveDocWorkspace('unknown-a')).resolves.toBeNull()
    await expect(index.resolveDocWorkspace('unknown-a')).resolves.toBeNull()
    await expect(index.resolveDocWorkspace('unknown-b')).resolves.toBeNull()
    expect(catalogReads).toBe(1)
  })

  it('does not hydrate workspace graphs after an unknown durable-registry miss', async () => {
    const repo = new Repo({})
    let durableReads = 0
    let catalogReads = 0
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM automerge_document_workspace')) {
          durableReads += 1
          return { rows: [] }
        }
        // MATCHED ON THE TABLE, not on a column order (see the test above).
        if (sql.includes('FROM versions')) {
          catalogReads += 1
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(repo, pool)

    await expect(index.resolveDocWorkspace('protocol-unknown')).resolves.toBeNull()
    expect(durableReads).toBe(1)
    expect(catalogReads).toBe(0)
  })

  /**
   * Regression: idle eviction silently disabled this index.
   *
   * `walk()` watches control documents it never leases, so the idle sweep
   * evicts them once quiet. Eviction drops the handle but not the listener —
   * the client's reopen mints a NEW handle and the orphaned listener never
   * fires again. `claimDocument()` then stops running for newly created
   * documents and the access gate denies the client's upload forever
   * ("Cannot capture base manifest: document unavailable").
   *
   * These run the PRODUCTION path (`durable: true`) against an in-memory
   * stand-in for `automerge_document_workspace`, and evict for real through
   * `repo.removeFromCache` so the reopened handle is genuinely a new object.
   */
  describe('idle eviction orphaning the index watchers', () => {
    class MemoryStorage {
      private readonly chunks = new Map<string, Uint8Array>()
      private key(key: readonly string[]): string { return key.join('/') }
      async load(key: readonly string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.key(key)) }
      async save(key: readonly string[], data: Uint8Array): Promise<void> { this.chunks.set(this.key(key), data) }
      async remove(key: readonly string[]): Promise<void> { this.chunks.delete(this.key(key)) }
      async loadRange(prefix: readonly string[]): Promise<{ key: string[]; data: Uint8Array }[]> {
        const p = this.key(prefix)
        return [...this.chunks.entries()]
          .filter(([k]) => k === p || k.startsWith(`${p}/`))
          .map(([k, data]) => ({ key: k.split('/'), data }))
      }
      async removeRange(prefix: readonly string[]): Promise<void> {
        const p = this.key(prefix)
        for (const k of [...this.chunks.keys()]) if (k === p || k.startsWith(`${p}/`)) this.chunks.delete(k)
      }
    }

    interface FakeVersion { landscapeId: string; versionId: string; rootUrl: string }

    /**
     * Stand-in for the durable document->workspace registry, honouring the same
     * first-owner-wins semantics as the real INSERT ... ON CONFLICT.
     *
     * `repairWalks` counts `backfillWorkspaceRoute`'s per-workspace `root_url`
     * lookup, which runs exactly once per repair walk. That is the observable
     * these tests need: counting durable assignments instead would prove
     * nothing, because a re-walk re-claims already-cached documents and
     * short-circuits, so the assignment count is identical whether the repair
     * ran once or twenty times.
     */
    function durableRegistry(
      versions: FakeVersion[],
      options: {
        failRootLookup?: (workspace: string) => boolean
        rootLookupDelayMs?: number
        /** Hold the walk open at a chosen document's claim INSERT. The walk
         * awaits claimDocument for every reference, so this is a deterministic
         * way to keep `entry.building` in flight without timing guesses. */
        gateClaimOf?: () => string | null
        claimGate?: Promise<void>
      } = {},
    ) {
      const assignments = new Map<string, { landscapeId: string; versionId: string }>()
      const repairWalks = new Map<string, number>()
      let graphWalkCatalogReads = 0
      let inFlightRootLookups = 0
      let maxConcurrentRootLookups = 0
      const find = (landscapeId: string, versionId: string) =>
        versions.find((v) => v.landscapeId === landscapeId && v.versionId === versionId)
      const pool = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO automerge_document_workspace')) {
            // Both statement forms: the batched unnest form for leaves, the
            // single-row form for control documents. Supporting only one would
            // let batched leaves in solely through the walk's tail commit loop,
            // masking every flush mutant.
            if (sql.includes('unnest')) {
              const [ids, landscapeId, versionId] = params as [string[], string, string]
              const rows: { document_id: string }[] = []
              for (const documentId of ids) {
                if (options.claimGate && options.gateClaimOf?.() === documentId) {
                  await options.claimGate
                }
                if (!find(landscapeId, versionId)) continue
                if (assignments.has(documentId)) continue
                assignments.set(documentId, { landscapeId, versionId })
                rows.push({ document_id: documentId })
              }
              return { rows, rowCount: rows.length }
            }
            const [documentId, landscapeId, versionId] = params as string[]
            if (options.claimGate && options.gateClaimOf?.() === documentId) {
              await options.claimGate
            }
            if (!find(landscapeId!, versionId!)) return { rows: [], rowCount: 0 }
            if (assignments.has(documentId!)) return { rows: [], rowCount: 0 }
            assignments.set(documentId!, { landscapeId: landscapeId!, versionId: versionId! })
            return { rows: [{ document_id: documentId }], rowCount: 1 }
          }
          if (sql.includes('FROM automerge_document_workspace d')) {
            const hit = assignments.get(params[0] as string)
            const version = hit && find(hit.landscapeId, hit.versionId)
            if (!hit || !version) return { rows: [], rowCount: 0 }
            return {
              rows: [{
                landscape_id: hit.landscapeId,
                version_id: hit.versionId,
                root_url: version.rootUrl,
                static_source: null,
                static_allowed: false,
              }],
              rowCount: 1,
            }
          }
          if (sql.includes('FROM automerge_document_workspace')) {
            const target = params[0]
            if (Array.isArray(target)) {
              const rows = target.flatMap((id) => {
                const hit = assignments.get(String(id))
                return hit
                  ? [{ document_id: String(id), landscape_id: hit.landscapeId, version_id: hit.versionId }]
                  : []
              })
              return { rows, rowCount: rows.length }
            }
            const hit = assignments.get(target as string)
            return hit
              ? { rows: [{ landscape_id: hit.landscapeId, version_id: hit.versionId }], rowCount: 1 }
              : { rows: [], rowCount: 0 }
          }
          // backfillWorkspaceRoute's root lookup — one per repair walk.
          if (sql.includes('SELECT root_url FROM versions')) {
            const [landscapeId, versionId] = params as string[]
            const workspace = `${landscapeId}/${versionId}`
            repairWalks.set(workspace, (repairWalks.get(workspace) ?? 0) + 1)
            if (options.failRootLookup?.(workspace)) throw new Error(`simulated root lookup failure for ${workspace}`)
            inFlightRootLookups += 1
            maxConcurrentRootLookups = Math.max(maxConcurrentRootLookups, inFlightRootLookups)
            try {
              // Hold the lookup open so overlapping repair passes are
              // observable; without a delay every walk would serialise by luck.
              if (options.rootLookupDelayMs) {
                await new Promise((r) => setTimeout(r, options.rootLookupDelayMs))
              }
              const version = find(landscapeId!, versionId!)
              return version ? { rows: [{ root_url: version.rootUrl }] } : { rows: [] }
            } finally {
              inFlightRootLookups -= 1
            }
          }
          // MATCHED ON THE TABLE, not on a column order: the catalog read's
          // exact SELECT spelling is owned by a shared enumerator.
        if (sql.includes('FROM versions')) {
            graphWalkCatalogReads += 1
            return { rows: versions.map((v) => ({ id: v.versionId, landscape_id: v.landscapeId, root_url: v.rootUrl })) }
          }
          return { rows: [], rowCount: 0 }
        },
      } as unknown as pg.Pool
      return {
        pool,
        assignments,
        catalogReads: () => graphWalkCatalogReads,
        repairsOf: (workspace: string) => repairWalks.get(workspace) ?? 0,
        totalRepairs: () => [...repairWalks.values()].reduce((a, b) => a + b, 0),
        maxConcurrentRepairs: () => maxConcurrentRootLookups,
      }
    }

    /** The repair is deliberately fire-and-forget (awaiting it inside the
     * write-gate FIFO deadlocks the socket), so settle it before asserting a
     * count. Polls until the walk counter stops moving. */
    const settleRepairs = async (db: { totalRepairs(): number }, timeoutMs = 12_000) => {
      const deadline = Date.now() + timeoutMs
      let stableFor = 0
      let previous = -1
      // Require several consecutive unchanged polls: a walk that has to declare
      // a document unavailable is far slower than one served from storage, so a
      // single unchanged sample would return while a pass is still in flight
      // and the next assertion would race the in-flight latch.
      while (Date.now() < deadline && stableFor < 6) {
        const current = db.totalRepairs()
        stableFor = current === previous ? stableFor + 1 : 0
        previous = current
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    /** Repair passes are rate-limited against the clock. Drive it explicitly so
     * these tests assert the bound rather than sleeping through it. */
    function testClock() {
      let value = 1_000_000
      return { now: () => value, advance: (ms: number) => { value += ms } }
    }
    const PAST_RATE_LIMIT = 10_000

    /** The slice of AutomergeResidencyLeases the index subscribes to. */
    function fakeResidency() {
      const listeners = new Set<(documentId: string) => void>()
      return {
        source: {
          onBeforeEvict(listener: (documentId: string) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
        evictNotify(documentId: string) { for (const l of listeners) l(documentId) },
      }
    }

    async function buildWorkspace(repo: Repo) {
      const diagram1 = repo.create({ name: 'D1' })
      await diagram1.whenReady()
      const registry = repo.create({ diagrams: { d1: { docUrl: diagram1.url } } })
      const meta = repo.create({ objectShardUrls: [] as string[], connectionShardUrls: [] as string[] })
      const monolith = repo.create({ objects: {} })
      const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: meta.url, shardUrls: [registry.url] })
      await Promise.all([registry, meta, monolith, root].map((h) => h.whenReady()))
      return { diagram1, registry, meta, monolith, root }
    }

    async function workspaceFixture() {
      const repo = new Repo({ storage: new MemoryStorage() })
      return { repo, ...(await buildWorkspace(repo)) }
    }

    const KEY = { landscapeId: 'L-evict', versionId: 'V-evict' }
    const WS = `${KEY.landscapeId}/${KEY.versionId}`

    it('re-indexes documents linked after the watched parent was evicted', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const registryDocId = String(registry.documentId)
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const residency = fakeResidency()

      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency.source)
      notifyWorkspaceCreated({ ...KEY, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(registryDocId)).toEqual(KEY)
      }, { timeout: 5_000 })

      // Control: while the watcher is live, a newly linked diagram is claimed.
      const liveDiagram = repo.create({ name: 'D-live' })
      await liveDiagram.whenReady()
      registry.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dLive = { docUrl: liveDiagram.url }
      })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(liveDiagram.documentId))).toEqual(KEY)
      }, { timeout: 5_000 })

      // Evict the registry shard the way the idle sweep does.
      residency.evictNotify(registryDocId)
      await repo.flush()
      await repo.removeFromCache(registry.documentId)

      // The client reopens it — a genuinely different handle, so the listener
      // attached by the original walk can never fire again.
      const reopened = await repo.find(registry.url)
      await reopened.whenReady()
      expect(reopened).not.toBe(registry)

      // ...and links a new diagram, exactly as creating one in the UI does.
      const afterEviction = repo.create({ name: 'D-after' })
      await afterEviction.whenReady()
      reopened.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dAfter = { docUrl: afterEviction.url }
      })

      // If the orphaned listener is not replaced, this stays null forever and
      // the upload is denied.
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(afterEviction.documentId))).toEqual(KEY)
      }, { timeout: 5_000 })
    }, 30_000)

    /**
     * Regression: the ORDINARY admission path must ANNOUNCE, not just index.
     *
     * automerge-repo pins the share-policy verdict per (document, peer) at
     * `#activatePeer` and only recomputes it through `reevaluateSharePolicy`,
     * which nothing but `Repo.shareConfigChanged()` reaches. So a gate's deny is
     * sticky for the life of the socket unless something announces the repair.
     *
     * The class doc comment names the change-listener re-walk — not the
     * backfill — as what makes "a brand-new client-created doc servable the
     * moment its parent link syncs". On a healthy workspace
     * `scheduleWorkspaceRouteBackfill` is already memoized, so if `walk()`
     * claimed the document without announcing it, the deny that the
     * create/link race produces would be permanent.
     *
     * NO eviction anywhere in this test — that is the point. The watcher is
     * live and the index ends up correct, which is exactly the state in which
     * a missing announcement is invisible. Assert on the announcement, not on
     * `resolveDocWorkspace`.
     */
    it('announces a repair when the live change listener admits a newly linked document', async () => {
      const LIVE = { landscapeId: 'L-live', versionId: 'V-live' }
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...LIVE, rootUrl: root.url }])

      const index = new WorkspaceDocIndex(repo, db.pool)
      const announced: string[] = []
      index.onWorkspaceIndexRepaired = (key) => { announced.push(`${key.landscapeId}/${key.versionId}`) }
      notifyWorkspaceCreated({ ...LIVE, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(registry.documentId))).toEqual(LIVE)
      }, { timeout: 5_000 })

      // Everything from here is driven only by the registry's live listener.
      announced.length = 0

      const created = repo.create({ name: 'D-created' })
      await created.whenReady()
      registry.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dCreated = { docUrl: created.url }
      })

      // The re-walk indexes it...
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(created.documentId))).toEqual(LIVE)
      }, { timeout: 5_000 })

      // ...and announces it: without that `shareConfigChanged()` never
      // runs and a peer already denied for `created` stays denied.
      await vi.waitFor(() => {
        expect(announced).toContain(`${LIVE.landscapeId}/${LIVE.versionId}`)
      }, { timeout: 5_000 })

      // The other half of the guard: a re-walk that admits NOTHING must stay
      // silent. Every edit to a control document re-walks, so announcing
      // unconditionally would fire `shareConfigChanged()` — which re-resolves
      // the share policy across every document and peer — on every rename.
      //
      // Counted rather than slept on: rename first, then link a second new
      // document and wait for ITS announcement. Exactly one announcement must
      // have landed. Drop the `admittedNewDocument` guard and the rename
      // announces too, making it two.
      announced.length = 0
      registry.change((d: { diagrams: Record<string, { docUrl: string; name?: string }> }) => {
        d.diagrams.dCreated!.name = 'renamed, same docUrl'
      })

      const second = repo.create({ name: 'D-second' })
      await second.whenReady()
      registry.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dSecond = { docUrl: second.url }
      })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(second.documentId))).toEqual(LIVE)
      }, { timeout: 5_000 })
      await vi.waitFor(() => { expect(announced.length).toBeGreaterThan(0) }, { timeout: 5_000 })
      expect(announced).toEqual([`${LIVE.landscapeId}/${LIVE.versionId}`])
    }, 30_000)

    /**
     * Regression: a walk that BAILS must still announce what it already admitted.
     *
     * `find()` calls `reference()` — which claims the id — BEFORE it attempts the
     * read, so by the time an unreadable root aborts the walk, the announcement
     * has already been earned. Dropping it on that exit path is the one place
     * where the missing announcement is self-inflicted AND unrecoverable:
     *
     *   1. Cold process. The workspace root exists only in the connecting
     *      browser's IndexedDB (created offline, or restored without its
     *      `automerge_storage` rows).
     *   2. The browser's first frame for the root loses the race to the
     *      socket-upgrade pre-warm's walk, so the route gate denies it and
     *      automerge-repo pins `sharePolicyState: 'denied'` for that pair.
     *   3. The walk claims the root, then `repo.find` can never resolve — the
     *      only holder is the peer just denied — and the walk returns early.
     *   4. `controlDocsComplete` is false, so the backfill's completion hook
     *      declines to announce, and its `routeBackfills` memo holds a RESOLVED
     *      promise, so every later schedule is a no-op. No eviction ever happens,
     *      so `runStaleRepair` never sees the workspace either.
     *
     * The workspace is then wedged for the life of the process. Announcing here
     * is self-healing: `byDoc` already has the root, so the re-evaluation admits
     * the peer, the browser uploads the root, and the next walk succeeds.
     */
    it('announces what it admitted even when the walk aborts on an unreadable root', async () => {
      const COLD = { landscapeId: 'L-coldroot', versionId: 'V-coldroot' }
      const { repo, root } = await workspaceFixture()
      const rootDocId = String(root.documentId)
      // Readable enough to be claimed, unreadable from this process — exactly
      // "the only supplier is the peer whose messages this decision blocks".
      const blindRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'find') {
            return async (url: string, opts?: unknown) => {
              if (String(url).includes(rootDocId)) throw new Error('root unavailable: only the gated peer holds it')
              return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const db = durableRegistry([{ ...COLD, rootUrl: root.url }])
      const index = new WorkspaceDocIndex(blindRepo, db.pool)
      const announced: string[] = []
      index.onWorkspaceIndexRepaired = (key) => { announced.push(`${key.landscapeId}/${key.versionId}`) }
      notifyWorkspaceCreated({ ...COLD, rootUrl: root.url })

      // The root IS admitted — `reference()` runs before the read is attempted.
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(rootDocId)).toEqual(COLD)
      }, { timeout: 5_000 })

      await vi.waitFor(() => {
        expect(announced).toContain(`${COLD.landscapeId}/${COLD.versionId}`)
      }, { timeout: 5_000 })
    }, 30_000)

    /**
     * Regression: a repair that restored NOTHING must not be memoized as done.
     *
     * `walk()` never throws on an unreadable document — `find()` records the
     * failure and returns null — so `backfillWorkspaceRoute`'s promise RESOLVES
     * even when the walk attached no listeners at all. The memo in
     * `routeBackfills` is only dropped on rejection, so such a resolution would
     * make `scheduleWorkspaceRouteBackfill` a permanent no-op for the workspace.
     *
     * Worst case is the root branch: zero listeners attached, the memo claiming
     * the repair is done, no eviction to mark the workspace stale, and therefore
     * every document in it denied for the life of the process — with no
     * in-process path back.
     *
     * Asserts the observable consequence — a second attempt walks again — rather
     * than how the walk reports itself.
     */
    it('does not memoize a repair whose walk never restored the control documents', async () => {
      const BAD = { landscapeId: 'L-incomplete', versionId: 'V-incomplete' }
      const WS_BAD = `${BAD.landscapeId}/${BAD.versionId}`
      const { repo, root } = await workspaceFixture()
      const rootDocId = String(root.documentId)
      const blindRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'find') {
            return async (url: string, opts?: unknown) => {
              if (String(url).includes(rootDocId)) throw new Error('root unreadable')
              return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const db = durableRegistry([{ ...BAD, rootUrl: root.url }])
      const index = new WorkspaceDocIndex(blindRepo, db.pool)

      await index.backfillWorkspaceRoute(BAD).catch(() => {})
      expect(db.repairsOf(WS_BAD)).toBe(1)

      await index.backfillWorkspaceRoute(BAD).catch(() => {})
      expect(db.repairsOf(WS_BAD)).toBe(2)
    }, 30_000)

    /**
     * Regression, composition-level: partition failover must repair the index.
     *
     * The unit test in `syncCells/repoFreshness.test.ts` proves
     * `evictWorkspaceDocumentCache` CALLS a before-evict listener. It does not
     * prove that the real `WorkspaceDocIndex` reacts, and "the spy was called"
     * is not the property that matters. This wires the three real collaborators
     * together — `AutomergeResidencyLeases`, `WorkspaceDocIndex.trackResidency`
     * and the failover eviction itself — and asserts the outcome a user would
     * notice: after a takeover, a newly created diagram is still admitted.
     *
     * An eviction path that reaches `repo.removeFromCache` directly would never
     * tell the index its control-document watchers had been orphaned:
     * `staleWorkspaces` would stay empty and the `routeBackfills` memo would
     * still hold a complete walk, arming neither recovery path.
     */
    it('repairs the index after a partition-failover eviction, not just the idle sweep', async () => {
      const FAILOVER = { landscapeId: 'L-failover', versionId: 'V-failover' }
      const { repo, registry, root } = await workspaceFixture()
      const registryDocId = String(registry.documentId)
      const db = durableRegistry([{ ...FAILOVER, rootUrl: root.url }])

      const residency = new AutomergeResidencyLeases(repo)
      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency)
      notifyWorkspaceCreated({ ...FAILOVER, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(registryDocId)).toEqual(FAILOVER)
      }, { timeout: 5_000 })

      // Failover evicts documents that are already durable — it detaches the
      // persistence listener precisely so `unload()` cannot save an empty doc
      // over them. Flush first or the reopen below has nothing to load, which
      // is a property of the fixture, not of the code under test.
      await repo.flush()

      // The takeover path, called exactly as index.ts calls it. The SQL excludes
      // the root, so what goes is ModelMeta and the registry shard — precisely
      // the documents `walk()` watches as control documents.
      const evicted = await evictWorkspaceDocumentCache(
        repo,
        { query: async () => ({ rows: [{ document_id: registryDocId }], rowCount: 1 }) } as never,
        FAILOVER,
        residency,
      )
      expect(evicted).toBe(1)

      // The client reopens the shard — a genuinely different handle, so the
      // listener the original walk attached can never fire again.
      const reopened = await repo.find(registry.url)
      await reopened.whenReady()
      expect(reopened).not.toBe(registry)

      const afterFailover = repo.create({ name: 'D-after-failover' })
      await afterFailover.whenReady()
      reopened.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dAfterFailover = { docUrl: afterFailover.url }
      })

      // Without the notification this stays null forever and the user's new
      // diagram is denied for the life of the process.
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(afterFailover.documentId))).toEqual(FAILOVER)
      }, { timeout: 10_000 })
    }, 30_000)

    /**
     * This index must not make the eviction census cry wolf.
     *
     * The census counts any listener still attached after the before-evict hook
     * as an orphan. On any stack where this index is live (AUTH=on, or
     * AM_WORKSPACE_ROUTING=on) a leftover listener would be reported as an
     * orphan once per document per sweep, and a detector which always fires
     * cannot report what it was built for.
     *
     * The rule: everyone who knows about eviction cleans up in the hook —
     * listeners included, not just bookkeeping. Detaching costs nothing — a
     * listener on a dropped handle can never fire again, and a document that
     * comes back comes back as a NEW handle, which `entry.watched` (a WeakSet)
     * does not contain, so the next walk re-attaches.
     */
    it('leaves no listener behind for the census to count as an orphan', async () => {
      const CENSUS = { landscapeId: 'L-census', versionId: 'V-census' }
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...CENSUS, rootUrl: root.url }])
      const residency = new AutomergeResidencyLeases(repo)
      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency)
      notifyWorkspaceCreated({ ...CENSUS, rootUrl: root.url })
      // Wait for the WATCH, not for the claim. `claimDocument` completes inside
      // `reference()`, two awaits before `watch()` — so polling on
      // resolveDocWorkspace can win the race and fail the guard below as if it
      // were a real defect.
      // Wait on a CONTROL document's listener, not a leaf's. Only control
      // documents carry `entry.onChange` — a leaf change cannot introduce a
      // reference, so re-walking on one is pure cost — so a leaf's listener
      // count is not a readiness signal at all.
      await vi.waitFor(() => {
        expect(registry.listenerCount('change')).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)
      }, { timeout: 10_000 })
      // The leaf is still INDEXED, which is what this suite is really about.
      expect(await index.resolveDocWorkspace(String(diagram1.documentId))).toEqual(CENSUS)

      // A LEAF: idle, peerless, unleased. Nothing is wrong with this workspace.
      await expect(residency.evict(String(diagram1.documentId))).resolves.toBe(true)
      // And a CONTROL document, whose watcher this index recovers by re-walking
      // rather than by holding on to a dead listener.
      await expect(residency.evict(String(registry.documentId))).resolves.toBe(true)

      const snapshot = await residency.snapshot()
      expect(snapshot.orphanedListenersByType).toEqual({})
      expect(snapshot.orphanedListenerEvictions).toBe(0)
    }, 30_000)

    it('re-attaches after an eviction that was announced but did not happen', async () => {
      // `evict()` announces, then drops. If the DROP fails — storage error,
      // upstream throw — the document stays resident with our listener already
      // detached, and no further eviction is coming to mark it stale, because it
      // was never evicted. The walk has to be able to re-attach, which it can
      // only do if the handle also left `entry.watched`.
      const STUCK = { landscapeId: 'L-stuck', versionId: 'V-stuck' }
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...STUCK, rootUrl: root.url }])
      // Spied rather than proxied: `hasActivePeers` reaches into the repo's
      // private synchronizer fields, and a Proxy receiver cannot read those.
      const removeFromCache = vi.spyOn(repo, 'removeFromCache')
        .mockRejectedValueOnce(new Error('storage unavailable'))
      const residency = new AutomergeResidencyLeases(repo)
      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency)
      notifyWorkspaceCreated({ ...STUCK, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(diagram1.documentId))).toEqual(STUCK)
      }, { timeout: 10_000 })

      await expect(residency.evict(String(registry.documentId))).rejects.toThrow('storage unavailable')

      // Still resident, and ours is gone — the announcement was honoured.
      expect(repo.handles[registry.documentId]).toBeDefined()
      expect(registry.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS)

      // A resolve miss schedules the repair the stale marking armed. Its walk
      // must put the listener back on this very handle.
      removeFromCache.mockRestore()
      await index.resolveDocWorkspace('a-document-nobody-has-indexed')
      await vi.waitFor(() => {
        expect(registry.listenerCount('change')).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)
      }, { timeout: 10_000 })
    }, 30_000)

    it('keeps watching a document whose eviction was refused', async () => {
      // The detach above is correct only because it runs on the far side of
      // every refusal check in `evict()`. Announcing an eviction that does not
      // happen would tear down a live watcher — and, for a control document,
      // would also drop the routeBackfills memo on every write-head rotation,
      // turning a bounded repair into a repeated workspace walk.
      const REFUSED = { landscapeId: 'L-refused', versionId: 'V-refused' }
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...REFUSED, rootUrl: root.url }])
      const residency = new AutomergeResidencyLeases(repo)
      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency)
      notifyWorkspaceCreated({ ...REFUSED, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(diagram1.documentId))).toEqual(REFUSED)
      }, { timeout: 10_000 })

      // Every refusal, not just the convenient one. `evict()` has five, and
      // pinning only the lease check leaves the announcement free to move above
      // the ACTIVE-PEER check — which would tear down the live watcher of the
      // busiest documents in the process, on every sweep, and drop the
      // routeBackfills memo with it. That is the one most worth protecting and
      // the one a lease-only test cannot see.
      // The subject is a CONTROL document. Leaves carry no
      // `entry.onChange` at all, so a leaf has no watcher to tear down and
      // could not detect the regression this test exists for. The registry is
      // also the honest subject: it is exactly the "live watcher of the busiest
      // documents" the comment above is protecting.
      const watchedAtStart = registry.listenerCount('change')
      expect(watchedAtStart).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)

      // A case per fixture, because two of these arm irreversibly and would
      // otherwise decide the cases after them: `protect()` has no undo, so every
      // later refusal would be the PROTECTED one, and `releaseOwner` evicts
      // synchronously, so disarming the lease destroys the document under the
      // next case. Sharing one fixture here passes for the wrong reason.
      const arms: Array<[string, (r: AutomergeResidencyLeases, h: typeof diagram1) => void]> = [
        ['leased', (r, h) => r.acquire(h, 'someone-else', `${REFUSED.landscapeId}/${REFUSED.versionId}`)],
        ['protected', (r, h) => r.protect(h)],
        ['active peer', (r) => { vi.spyOn(r, 'hasActivePeers').mockReturnValue(true) }],
        ['not ready', (_r, h) => { vi.spyOn(h, 'state', 'get').mockReturnValue('requesting') }],
      ]

      for (const [name, arm] of arms) {
        const fixture = await workspaceFixture()
        const ws = { landscapeId: `L-refused-${name.replace(/\W/g, '')}`, versionId: 'V1' }
        const localDb = durableRegistry([{ ...ws, rootUrl: fixture.root.url }])
        const localResidency = new AutomergeResidencyLeases(fixture.repo)
        const localIndex = new WorkspaceDocIndex(fixture.repo, localDb.pool)
        localIndex.trackResidency(localResidency)
        notifyWorkspaceCreated({ ...ws, rootUrl: fixture.root.url })
        await vi.waitFor(() => {
          expect(fixture.registry.listenerCount('change')).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)
        }, { timeout: 10_000 })
        const watched = fixture.registry.listenerCount('change')

        arm(localResidency, fixture.registry)
        await expect(
          localResidency.evict(String(fixture.registry.documentId)),
          `${name} should refuse the eviction`,
        ).resolves.toBe(false)

        // Still resident, and still watched — the announcement must not have run.
        expect(fixture.repo.handles[fixture.registry.documentId], `${name}: dropped`).toBeDefined()
        expect(fixture.registry.listenerCount('change'), `${name}: watcher torn down`).toBe(watched)
        vi.restoreAllMocks()
      }
    }, 60_000)

    it('arms the re-walk on CONTROL documents only, while still indexing the leaves', async () => {
      /**
       * A re-walk traverses the whole workspace — measured at p99 1329 ms over
       * 10 s of ordinary editing on a 34-diagram workspace, on the same single
       * thread that generates every peer's sync messages. Armed on every
       * watched document, each shape drag would pay for one.
       *
       * A leaf-triggered re-walk could never find anything: references are
       * extracted from the root, ModelMeta and the registry shards, and from
       * nowhere else. Diagram documents, object/connection shards and overlay
       * segments are found and never read from.
       *
       * Structural rather than timing-based on purpose — a walk COUNT is
       * process-global and other suites' idle indexes can move it, which is how
       * a test like this becomes flaky and then ignored. Removing the `control`
       * guard fails this immediately and deterministically.
       */
      const ARMED = { landscapeId: 'L-armed', versionId: 'V-armed' }
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...ARMED, rootUrl: root.url }])
      const index = new WorkspaceDocIndex(repo, db.pool)
      notifyWorkspaceCreated({ ...ARMED, rootUrl: root.url })
      await vi.waitFor(() => {
        expect(registry.listenerCount('change')).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)
      }, { timeout: 10_000 })

      // The control document drives re-walks…
      expect(registry.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS + 1)
      // …and the leaf does not, because a change to it cannot introduce a
      // reference this index does not already hold.
      expect(diagram1.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS)
      // But it is still INDEXED — dropping the listener must not drop admission,
      // which would deny the peer that holds it.
      expect(await index.resolveDocWorkspace(String(diagram1.documentId))).toEqual(ARMED)
    }, 30_000)

    it('stays detachable after repeated re-walks', async () => {
      /**
       * The property that matters for the eviction census, and the one that is
       * actually falsifiable here.
       *
       * It is tempting to assert "a re-walk does not stack a second listener",
       * on the theory that `DocHandle` extends eventemitter3, where
       * `on(f); on(f)` fires twice. MEASURED, it does not: `DocHandle` defines
       * its own `on`, which deduplicates by
       * identity — `on(f); on(f); on(g)` leaves two listeners, `f` fires once
       * per change, and a single `off(f)` removes it. So a redundant re-watch
       * of the SAME shared `entry.onChange` cannot double-fire, and no
       * listener-count assertion can distinguish a guarded walk from an
       * unguarded one.
       *
       * What dedup does NOT guarantee is that one `off` still clears the
       * workspace after many re-walks — that depends on every registration
       * being the same identity, which is precisely what the shared
       * `entry.onChange` buys and what a per-handle closure would break.
       */
      const REWALK = { landscapeId: 'L-rewalk', versionId: 'V-rewalk' }
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...REWALK, rootUrl: root.url }])
      const residency = new AutomergeResidencyLeases(repo)
      const index = new WorkspaceDocIndex(repo, db.pool)
      index.trackResidency(residency)
      notifyWorkspaceCreated({ ...REWALK, rootUrl: root.url })
      await vi.waitFor(() => {
        expect(registry.listenerCount('change')).toBeGreaterThan(REPO_BASELINE_CHANGE_LISTENERS)
      }, { timeout: 10_000 })
      const afterFirstWalk = registry.listenerCount('change')
      expect(afterFirstWalk).toBe(REPO_BASELINE_CHANGE_LISTENERS + 1)
      // A leaf carries no docScope listener at all — it is indexed, not
      // watched — so the eviction below exercises the announcement path on a
      // document with nothing attached (it must not be counted as an orphan).
      expect(diagram1.listenerCount('change')).toBe(REPO_BASELINE_CHANGE_LISTENERS)

      // Five re-walks, driven the way production drives them: a control
      // document changes, which is exactly what `entry.onChange` reacts to.
      for (let i = 0; i < 5; i += 1) {
        const extra = repo.create({ name: `D-rewalk-${i}` })
        await extra.whenReady()
        registry.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
          d.diagrams[`dRewalk${i}`] = { docUrl: extra.url }
        })
        await vi.waitFor(async () => {
          expect(await index.resolveDocWorkspace(String(extra.documentId))).toEqual(REWALK)
        }, { timeout: 10_000 })
      }

      // One eviction announcement must still leave the workspace clean — for a
      // leaf and for a control document alike. A per-handle closure would have
      // survived every one of those re-walks and shown up here as a census
      // orphan.
      await expect(residency.evict(String(diagram1.documentId))).resolves.toBe(true)
      await expect(residency.evict(String(registry.documentId))).resolves.toBe(true)

      const snapshot = await residency.snapshot()
      expect(snapshot.orphanedListenersByType).toEqual({})
      expect(snapshot.orphanedListenerEvictions).toBe(0)
    }, 30_000)

    /**
     * Repeated failure must back off, never latch off.
     *
     * A retry cap is wrong in exactly the state that produces repeated
     * failures. When the root is readable only by the connecting browser,
     * `walkFrom` returns before `watch(rootHandle, true)`, so the workspace
     * never enters `controlDocWorkspace`, never reaches `staleWorkspaces`, and
     * therefore never gets the eviction event that clears the counter. Both
     * clearing paths are unreachable precisely when it matters, so a cap would
     * keep every document in the workspace denied for the life of the process
     * — and the browser uploading its root, the normal resolution, could no
     * longer be picked up.
     */
    it('backs off after repeated failures but never stops retrying', async () => {
      const COLD = { landscapeId: 'L-backoff', versionId: 'V-backoff' }
      const WS_COLD = `${COLD.landscapeId}/${COLD.versionId}`
      const { repo, root } = await workspaceFixture()
      const rootDocId = String(root.documentId)
      let rootReadable = false
      const blindRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'find') {
            return async (url: string, opts?: unknown) => {
              if (!rootReadable && String(url).includes(rootDocId)) throw new Error('root unreadable')
              return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const db = durableRegistry([{ ...COLD, rootUrl: root.url }])
      const clock = testClock()
      const index = new WorkspaceDocIndex(blindRepo, db.pool, { clock: clock.now })

      // First failure, then assert the window actually WIDENS. Advancing a
      // generous fixed amount every time would make the cooldown irrelevant
      // and leave the backoff itself unasserted (a constant
      // `cooldown = STALE_REPAIR_MIN_INTERVAL_MS` would pass).
      index.scheduleWorkspaceRouteBackfill(COLD)
      await settleRepairs(db)
      expect(db.repairsOf(WS_COLD)).toBe(1)

      // One base interval is no longer enough after a failure.
      clock.advance(STALE_REPAIR_MIN_INTERVAL_MS + 1)
      index.scheduleWorkspaceRouteBackfill(COLD)
      await settleRepairs(db)
      expect(db.repairsOf(WS_COLD), 'window did not widen after a failure').toBe(1)

      // Two are.
      clock.advance(STALE_REPAIR_MIN_INTERVAL_MS + 1)
      index.scheduleWorkspaceRouteBackfill(COLD)
      await settleRepairs(db)
      expect(db.repairsOf(WS_COLD)).toBe(2)

      // Now well past any cap, to prove it never latches off.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        clock.advance(10 * 60_000)
        index.scheduleWorkspaceRouteBackfill(COLD)
        await settleRepairs(db)
      }
      const failedAttempts = db.repairsOf(WS_COLD)
      expect(failedAttempts).toBeGreaterThan(MAX_STALE_REPAIR_FAILURES)

      // The browser finally uploads the root — the normal resolution, and the
      // one a permanent write-off would have made unreachable.
      rootReadable = true
      clock.advance(10 * 60_000)
      index.scheduleWorkspaceRouteBackfill(COLD)
      await settleRepairs(db)

      // The load-bearing assertion. NOT `resolveDocWorkspace`: `walkFrom`'s
      // `find()` claims the url before attempting the read, so the very first
      // FAILED attempt already cached the root in `byDoc` and it would resolve
      // whether or not this walk ran.
      expect(db.repairsOf(WS_COLD)).toBeGreaterThan(failedAttempts)
    }, 30_000)

    /** Build an index whose workspace has been fully walked once. */
    async function primedIndex(
      repo: Repo,
      db: ReturnType<typeof durableRegistry>,
      rootUrl: string,
      probe: string,
      options?: { staleRepairConcurrency?: number },
    ) {
      const clock = testClock()
      const index = new WorkspaceDocIndex(repo, db.pool, { ...options, clock: clock.now })
      const untrack = index.trackResidency(fakeResidencyShared.source)
      notifyWorkspaceCreated({ ...KEY, rootUrl })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(probe)).toEqual(KEY)
      }, { timeout: 5_000 })
      return { index, untrack, clock }
    }
    let fakeResidencyShared: ReturnType<typeof fakeResidency>
    beforeEach(() => { fakeResidencyShared = fakeResidency() })

    it('repairs an evicted workspace once, not once per unknown document id', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index } = await primedIndex(repo, db, root.url, String(registry.documentId))

      fakeResidencyShared.evictNotify(String(registry.documentId))

      // A burst of unknown ids must produce exactly ONE repair walk. This is the
      // bounded-hydration guarantee the durable-miss quarantine rests on, and
      // the reason a graph-walk fallback was allowed onto that path at all.
      for (const unknown of ['unknown-1', 'unknown-2', 'unknown-3', 'unknown-4']) {
        expect(await index.resolveDocWorkspace(unknown)).toBeNull()
      }
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)
    }, 30_000)

    it('does not repair when the evicted document is a leaf, not a control document', async () => {
      const { repo, diagram1, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index } = await primedIndex(repo, db, root.url, String(registry.documentId))

      // Diagrams and object/connection shards are the bulk of what the idle
      // sweep evicts, and a manifest-only repair would not re-watch them
      // anyway — so evicting one must NOT schedule a walk, or every sweep
      // would re-hydrate documents it just evicted and fight the memory
      // control this exists alongside.
      fakeResidencyShared.evictNotify(String(diagram1.documentId))
      expect(await index.resolveDocWorkspace('unknown-after-leaf-eviction')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(0)
    }, 30_000)

    it('repairs after the ROOT is evicted, not only a registry shard', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index } = await primedIndex(repo, db, root.url, String(registry.documentId))

      // The root carries modelMetaUrl/shardUrls, so losing its listener is the
      // most damaging case of all.
      fakeResidencyShared.evictNotify(String(root.documentId))
      expect(await index.resolveDocWorkspace('unknown-after-root-eviction')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)
    }, 30_000)

    it('ignores eviction of a document belonging to no known workspace', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index } = await primedIndex(repo, db, root.url, String(registry.documentId))

      fakeResidencyShared.evictNotify('never-indexed-document')
      expect(await index.resolveDocWorkspace('another-unknown')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(0)
    }, 30_000)

    it('stops following residency once untracked', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index, untrack } = await primedIndex(repo, db, root.url, String(registry.documentId))

      untrack()
      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-after-untrack')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(0)
    }, 30_000)

    it('retries a workspace whose repair walk failed', async () => {
      const { repo, registry, root } = await workspaceFixture()
      let failNext = false
      const db = durableRegistry(
        [{ ...KEY, rootUrl: root.url }],
        { failRootLookup: () => failNext },
      )
      const { index, clock } = await primedIndex(repo, db, root.url, String(registry.documentId))

      failNext = true
      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-during-failure')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)

      // The failure must leave the workspace queued, not silently quarantined
      // forever — otherwise a transient storage blip permanently disables the
      // very recovery this whole mechanism provides.
      failNext = false
      clock.advance(PAST_RATE_LIMIT)
      expect(await index.resolveDocWorkspace('unknown-after-failure')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(2)
    }, 30_000)

    it('rate-limits repair passes so a peer cannot drive them on demand', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const { index, clock } = await primedIndex(repo, db, root.url, String(registry.documentId))

      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-a')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)

      // A second eviction immediately after must NOT get an immediate pass:
      // resolve misses are attacker-influenced (the denial-logging path resolves
      // document ids too) and a pass walks every stale workspace, other tenants
      // included.
      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-b')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)

      // ...but it is a delay, not a drop.
      clock.advance(PAST_RATE_LIMIT)
      expect(await index.resolveDocWorkspace('unknown-c')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(2)
    }, 30_000)

    it('stops retrying a workspace that keeps failing', async () => {
      const { repo, registry, root } = await workspaceFixture()
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }], { failRootLookup: () => true })
      const { index, clock } = await primedIndex(repo, db, root.url, String(registry.documentId))

      fakeResidencyShared.evictNotify(String(registry.documentId))
      for (let i = 0; i < 8; i += 1) {
        clock.advance(PAST_RATE_LIMIT)
        expect(await index.resolveDocWorkspace(`unknown-${i}`)).toBeNull()
        await settleRepairs(db)
      }
      // Bounded by MAX_STALE_REPAIR_FAILURES, not by how many misses arrive.
      expect(db.repairsOf(WS)).toBe(3)
    }, 30_000)

    it('repairs several workspaces evicted at once, bounded by the concurrency cap', async () => {
      const repo = new Repo({ storage: new MemoryStorage() })
      const a = await buildWorkspace(repo)
      const b = await buildWorkspace(repo)
      const c = await buildWorkspace(repo)
      const versions = [
        { landscapeId: 'L-multi', versionId: 'V-a', rootUrl: a.root.url },
        { landscapeId: 'L-multi', versionId: 'V-b', rootUrl: b.root.url },
        { landscapeId: 'L-multi', versionId: 'V-c', rootUrl: c.root.url },
      ]
      const db = durableRegistry(versions)
      const index = new WorkspaceDocIndex(repo, db.pool, { staleRepairConcurrency: 2 })
      index.trackResidency(fakeResidencyShared.source)
      for (const v of versions) notifyWorkspaceCreated(v)
      await vi.waitFor(async () => {
        for (const [i, w] of [a, b, c].entries()) {
          expect(await index.resolveDocWorkspace(String(w.registry.documentId)))
            .toEqual({ landscapeId: 'L-multi', versionId: versions[i]!.versionId })
        }
      }, { timeout: 10_000 })

      for (const w of [a, b, c]) fakeResidencyShared.evictNotify(String(w.registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-multi')).toBeNull()
      await settleRepairs(db)

      // A concurrency cap of 2 must still drain all three — it bounds fan-out,
      // not total work.
      for (const v of versions) {
        expect(db.repairsOf(`${v.landscapeId}/${v.versionId}`)).toBe(1)
      }
    }, 30_000)

    it('does not report success when the walk could not read every control document', async () => {
      // walk() swallows unreadable documents and returns normally, so "did not
      // throw" is not "repaired". A repair that missed ModelMeta must stay
      // queued rather than being memoized as healthy — otherwise every shard
      // created afterwards is denied forever with no retry.
      const repo = new Repo({ storage: new MemoryStorage() })
      const registry = repo.create({ diagrams: {} })
      const monolith = repo.create({ objects: {} })
      // A well-formed URL for a document that exists nowhere: with no peers to
      // ask, the walk's find() reports it unavailable and returns null.
      const missingMeta = `automerge:${'4'.repeat(32)}`
      const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: missingMeta, shardUrls: [registry.url] })
      await Promise.all([registry, monolith, root].map((h) => h.whenReady()))

      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const clock = testClock()
      const index = new WorkspaceDocIndex(repo, db.pool, { clock: clock.now, staleRepairDeadlineMs: 1_500 })
      index.trackResidency(fakeResidencyShared.source)
      notifyWorkspaceCreated({ ...KEY, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(registry.documentId))).toEqual(KEY)
      }, { timeout: 10_000 })

      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-partial-1')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(1)

      // Wait past the injected deadline: an unreadable document can leave the
      // walk pending without touching the counter, so counter-stability alone
      // does not mean the pass has released its in-flight latch.
      await new Promise((r) => setTimeout(r, 2_500))

      // Still queued because the walk was incomplete: a second miss retries.
      clock.advance(PAST_RATE_LIMIT)
      expect(await index.resolveDocWorkspace('unknown-partial-2')).toBeNull()
      await settleRepairs(db)
      expect(db.repairsOf(WS)).toBe(2)
    }, 60_000)

    it('a wedged repair walk does not disable repair for every other workspace', async () => {
      // repo.find() has no timeout, and the repair pass holds a process-wide
      // in-flight latch. Without a deadline, one walk waiting on a document
      // only a blocked socket can supply would kill stale recovery permanently.
      const { repo, registry, root } = await workspaceFixture()
      let hang = true
      let rootLookupAttempts = 0
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }])
      const basePool = db.pool
      const pool = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT root_url FROM versions')) {
            rootLookupAttempts += 1
            if (hang) {
              hang = false
              await new Promise(() => {}) // never settles, like an unanswered find()
            }
          }
          return (basePool as unknown as { query: (s: string, p?: unknown[]) => Promise<unknown> }).query(sql, params)
        },
      } as unknown as pg.Pool
      const clock = testClock()
      const index = new WorkspaceDocIndex(repo, pool, { clock: clock.now, staleRepairDeadlineMs: 500 })
      index.trackResidency(fakeResidencyShared.source)
      notifyWorkspaceCreated({ ...KEY, rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(registry.documentId))).toEqual(KEY)
      }, { timeout: 5_000 })

      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-wedged')).toBeNull()
      await new Promise((r) => setTimeout(r, 1_500)) // past the injected deadline

      // The latch must have been released, so a later pass can still run. The
      // wedged attempt never reaches the counting pool, so assert on attempts:
      // one hung + at least one that completed afterwards.
      clock.advance(PAST_RATE_LIMIT)
      fakeResidencyShared.evictNotify(String(registry.documentId))
      expect(await index.resolveDocWorkspace('unknown-after-wedge')).toBeNull()
      await settleRepairs(db)
      expect(rootLookupAttempts).toBeGreaterThanOrEqual(2)
      expect(db.repairsOf(WS)).toBeGreaterThanOrEqual(1)
    }, 60_000)

    it('does not treat a walk that began before the eviction as a repair', async () => {
      // The nastiest failure mode. `ensureWorkspace` shares one in-flight walk
      // per workspace, so a repair starting while an earlier walk is still
      // running would JOIN it — and that walk watched the handle that has since
      // been evicted. The repair would report success, dequeue the workspace and
      // memoize it as healthy while its listener is dead — the orphaned-watcher
      // failure this suite guards against. Asserted end-to-end, because "a walk ran" is not the
      // property that matters — "a document linked afterwards is servable" is.
      const repo = new Repo({ storage: new MemoryStorage() })
      const { registry, diagram1, root } = await buildWorkspace(repo)
      let release: (() => void) | null = null
      const claimGate = new Promise<void>((resolve) => { release = resolve })
      let gateTarget: string | null = String(diagram1.documentId)
      const db = durableRegistry([{ ...KEY, rootUrl: root.url }], {
        gateClaimOf: () => gateTarget,
        claimGate,
      })
      const clock = testClock()
      const index = new WorkspaceDocIndex(repo, db.pool, { clock: clock.now })
      index.trackResidency(fakeResidencyShared.source)
      notifyWorkspaceCreated({ ...KEY, rootUrl: root.url })

      // The registry shard is claimed and watched before the gated diagram
      // claim, so this resolves while the initial walk is still in flight.
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(registry.documentId))).toEqual(KEY)
      }, { timeout: 5_000 })

      // Evict for real, WHILE that walk is still running.
      fakeResidencyShared.evictNotify(String(registry.documentId))
      await repo.flush()
      await repo.removeFromCache(registry.documentId)

      gateTarget = null
      release?.()
      expect(await index.resolveDocWorkspace('unknown-during-walk')).toBeNull()
      await settleRepairs(db)

      // A client reopens the shard and links a new diagram. Only a walk that
      // started AFTER the eviction watches this handle.
      const reopened = await repo.find(registry.url)
      await reopened.whenReady()
      const late = repo.create({ name: 'D-late' })
      await late.whenReady()
      reopened.change((d: { diagrams: Record<string, { docUrl: string }> }) => {
        d.diagrams.dLate = { docUrl: late.url }
      })

      await vi.waitFor(async () => {
        clock.advance(PAST_RATE_LIMIT)
        expect(await index.resolveDocWorkspace(String(late.documentId))).toEqual(KEY)
      }, { timeout: 10_000 })
    }, 60_000)

    it('never exceeds the concurrency cap when staleness arrives mid-pass', async () => {
      const repo = new Repo({ storage: new MemoryStorage() })
      const spaces = [await buildWorkspace(repo), await buildWorkspace(repo),
        await buildWorkspace(repo), await buildWorkspace(repo)]
      const versions = spaces.map((w, i) => ({
        landscapeId: 'L-conc', versionId: `V-${i}`, rootUrl: w.root.url,
      }))
      const db = durableRegistry(versions, { rootLookupDelayMs: 40 })
      const clock = testClock()
      const index = new WorkspaceDocIndex(repo, db.pool, { staleRepairConcurrency: 2, clock: clock.now })
      index.trackResidency(fakeResidencyShared.source)
      for (const v of versions) notifyWorkspaceCreated(v)
      await vi.waitFor(async () => {
        for (const [i, w] of spaces.entries()) {
          expect(await index.resolveDocWorkspace(String(w.registry.documentId)))
            .toEqual({ landscapeId: 'L-conc', versionId: versions[i]!.versionId })
        }
      }, { timeout: 10_000 })

      for (const w of spaces) fakeResidencyShared.evictNotify(String(w.registry.documentId))
      // Repeated misses while a pass is already draining must JOIN it, not
      // start a second one — otherwise each miss multiplies the fan-out and
      // the cap stops bounding anything.
      for (let i = 0; i < 6; i += 1) {
        // Advance past the rate limit each time, so what stops a second pass
        // is the in-flight guard under test and not the rate limiter.
        clock.advance(PAST_RATE_LIMIT)
        expect(await index.resolveDocWorkspace(`unknown-conc-${i}`)).toBeNull()
        await new Promise((r) => setTimeout(r, 10))
      }
      await settleRepairs(db)

      expect(db.maxConcurrentRepairs()).toBeLessThanOrEqual(2)
      for (const v of versions) {
        expect(db.repairsOf(`${v.landscapeId}/${v.versionId}`)).toBe(1)
      }
    }, 30_000)
  })

  it('recognizes only the canonical static root as server-managed and caches the lookup', async () => {
    const repo = new Repo({})
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await root.whenReady()
    let managedReads = 0
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM automerge_document_workspace')) {
          return {
            rows: [{
              landscape_id: 'L-static-root',
              version_id: 'V-static-root',
              root_url: root.url,
              static_source: 'sparse-draft',
              static_allowed: true,
            }],
          }
        }
        if (sql.includes('FROM read_model_static_workspaces')) {
          managedReads += 1
          return { rows: [{ managed: true }] }
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(repo, pool)
    const workspace = await index.resolveDocWorkspace(String(root.documentId))

    expect(workspace).toEqual({ landscapeId: 'L-static-root', versionId: 'V-static-root' })
    await expect(index.isServerManagedRoot(String(root.documentId), workspace)).resolves.toBe(true)
    await expect(index.isServerManagedRoot(String(root.documentId), workspace)).resolves.toBe(true)
    await expect(index.isServerManagedRoot('child', workspace)).resolves.toBe(false)
    expect(managedReads).toBe(1)
  })

  it('a summary-only workspace indexes only root, metadata, and editable overlays', async () => {
    const repo = new Repo({})
    const objectShard = repo.create({ objects: { o1: {} } })
    const overlay = repo.create({ objects: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url, overlay.url],
      connectionShardUrls: [],
      decisionRecordShardUrls: [],
      editsObjectShardUrl: overlay.url,
      editsConnectionShardUrl: overlay.url,
    })
    const diagram = repo.create({ name: 'large diagram' })
    const registry = repo.create({ diagrams: { d1: { docUrl: diagram.url } } })
    const root = repo.create({
      modelMetaUrl: meta.url,
      shardUrls: [registry.url],
      registrySummaryOnly: true,
    })
    await Promise.all([objectShard, overlay, meta, diagram, registry, root].map((handle) => handle.whenReady()))

    const index = new WorkspaceDocIndex(repo, fakePool(), { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L-static', versionId: 'V-static', rootUrl: root.url })
    const deadline = Date.now() + 2_000
    let resolvedRoot: { landscapeId: string; versionId: string } | null = null
    while (Date.now() < deadline && !resolvedRoot) {
      resolvedRoot = await index.resolveDocWorkspace(String(root.documentId))
      if (!resolvedRoot) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(resolvedRoot).toEqual({ landscapeId: 'L-static', versionId: 'V-static' })
    const resolveEventually = async (documentId: string) => {
      const childDeadline = Date.now() + 2_000
      let resolved: { landscapeId: string; versionId: string } | null = null
      while (Date.now() < childDeadline && !resolved) {
        resolved = await index.resolveDocWorkspace(documentId)
        if (!resolved) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return resolved
    }
    expect(await resolveEventually(String(meta.documentId))).toEqual(resolvedRoot)
    expect(await resolveEventually(String(overlay.documentId))).toEqual(resolvedRoot)
    expect(await index.resolveDocWorkspace(String(objectShard.documentId))).toBeNull()
    expect(await index.resolveDocWorkspace(String(registry.documentId))).toBeNull()
    expect(await index.resolveDocWorkspace(String(diagram.documentId))).toBeNull()
  })

  it('incremental re-walk: a NEW diagram doc linked into the registry AFTER the first walk becomes resolvable', async () => {
    const repo = new Repo({})
    const registry = repo.create({ diagrams: {} as Record<string, { docUrl?: string }> })
    const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([registry, root].map((h) => h.whenReady()))

    const index = new WorkspaceDocIndex(repo, fakePool(), { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L3', versionId: 'V3', rootUrl: root.url })
    // Wait for the first walk to settle (registry has zero diagrams yet).
    await new Promise((r) => setTimeout(r, 200))

    // Simulate a client linking a new diagram into the registry shard AFTER
    // the server's first walk — the "default-deny until the parent link
    // syncs" scenario.
    const diagram = repo.create({ name: 'late' })
    await diagram.whenReady()
    registry.change((r: { diagrams: Record<string, { docUrl: string }> }) => {
      r.diagrams.late = { docUrl: diagram.url }
    })

    const deadline = Date.now() + 2000
    let resolved: unknown = null
    while (Date.now() < deadline) {
      resolved = await index.resolveDocWorkspace(String(diagram.documentId))
      if (resolved) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(resolved).toEqual({ landscapeId: 'L3', versionId: 'V3' })
  })
})

describe('buildWorkspaceRouteCheck', () => {
  const wsA = { landscapeId: 'L1', versionId: 'V1' }
  const wsB = { landscapeId: 'L2', versionId: 'V2' }
  const index = {
    resolveDocWorkspace: async (docId: string) => docId === 'a' ? wsA : docId === 'b' ? wsB : null,
    // Fire-and-forget by design: the gate reports the miss (coverage
    // invalidation + repair) and denies. It must never await either — see
    // docScope.gateLiveness.test.ts.
    noteRouteGateMiss: () => undefined,
    scheduleWorkspaceRouteBackfill: () => undefined,
  } as unknown as WorkspaceDocIndex

  it('allows only documents in the peer route and defaults closed when routing is required', async () => {
    const routed = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => wsA }, true)
    expect(await routed('peer', 'a')).toBe(true)
    expect(await routed('peer', 'b')).toBe(false)
    expect(await routed('peer', 'unknown')).toBe(false)

    const missing = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => null }, true)
    expect(await missing('peer', 'a')).toBe(false)
  })

  // The MAC fast path on the admission gate.
  describe('workspace-bound document ids on the route gate', () => {
    const SECRET = 'route-gate-mint-secret'
    const wsMint = { landscapeId: 'L-mint', versionId: 'V-mint' }
    const wsOther = { landscapeId: 'L-other', versionId: 'V-other' }
    let saved: string | undefined

    beforeEach(() => { saved = process.env.AUTH_SECRET; process.env.AUTH_SECRET = SECRET })
    afterEach(() => {
      if (saved === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = saved
    })

    /** Produced the way the client will produce them: through `create2`. */
    async function mintedId(workspace: { landscapeId: string; versionId: string }): Promise<string> {
      const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace) })
      return String((await repo.create2({ hi: 1 })).documentId)
    }

    /** An index that would DENY everything, so a pass can only come from the MAC. */
    function denyingIndex(): WorkspaceDocIndex {
      const repo = new Repo({})
      const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool
      return new WorkspaceDocIndex(repo, pool, { durable: false })
    }

    it('admits a document minted for the peer route without consulting the index', async () => {
      const id = await mintedId(wsMint)
      const gate = buildWorkspaceRouteCheck(denyingIndex(), { workspaceForPeer: () => wsMint }, true)
      expect(await gate('peer', id)).toBe(true)
    })

    it('refuses a document minted for another workspace', async () => {
      const id = await mintedId(wsOther)
      const gate = buildWorkspaceRouteCheck(denyingIndex(), { workspaceForPeer: () => wsMint }, true)
      expect(await gate('peer', id)).toBe(false)
    })

    // THE REASON `foreign` IS A VERDICT AND NOT JUST "not bound". The test
    // above cannot tell a deny from a fall-through, because its index denies
    // everything anyway. Here the index would ADMIT — as it would after a
    // first-owner-wins race, a stale claim, or a poisoned row — and the refusal
    // can only come from the MAC. Delete the `foreign` branch and this passes
    // the id straight through to a wrong-but-affirmative index answer.
    it('refuses a foreign minted id even when the index would admit it', async () => {
      const id = await mintedId(wsOther)
      const admitting = {
        resolveDocWorkspace: async () => wsMint,
        scheduleWorkspaceRouteBackfill: () => {},
        // The mismatch runs the displaced scan before settling on
        // `foreign`. Hand it a POISONED list containing the very version the
        // id was minted for — the inter-landscape refusal must hold anyway,
        // because the tag binds (landscape, version) jointly and the scan only
        // ever recomputes under the ROUTE's landscape.
        listLandscapeVersionIds: async () => [wsMint.versionId, wsOther.versionId],
        claimVerifiedDocument: async () => true,
      } as unknown as WorkspaceDocIndex
      const gate = buildWorkspaceRouteCheck(admitting, { workspaceForPeer: () => wsMint }, true)
      expect(
        await gate('peer', id),
        'an id bound to another workspace must be refused whatever the index says',
      ).toBe(false)
    })

    // The fast path must be exactly that — a fast path. A legacy id has to keep
    // reaching the durable index, or every document created before this scheme
    // becomes unservable.
    it('falls through to the index for an ordinary random id', async () => {
      const repo = new Repo({})
      const doc = repo.create({ legacy: true })
      await doc.whenReady()
      const legacyId = String(doc.documentId)

      const denied = buildWorkspaceRouteCheck(denyingIndex(), { workspaceForPeer: () => wsMint }, true)
      expect(await denied('peer', legacyId)).toBe(false)

      const admitting = {
        resolveDocWorkspace: async () => wsMint,
        scheduleWorkspaceRouteBackfill: () => {},
      } as unknown as WorkspaceDocIndex
      const allowed = buildWorkspaceRouteCheck(admitting, { workspaceForPeer: () => wsMint }, true)
      expect(await allowed('peer', legacyId)).toBe(true)
    })

    // With no key configured nothing can have been minted, so verification must
    // degrade to the index rather than throw inside the gate — an exception
    // there is a fault, not a verdict. This is also the key-rotation story:
    // ids minted under a retired key stop verifying and fall back, they do not
    // start being denied.
    it('degrades to the index when no signing key is configured', async () => {
      const id = await mintedId(wsMint)
      delete process.env.AUTH_SECRET
      const admitting = {
        resolveDocWorkspace: async () => wsMint,
        scheduleWorkspaceRouteBackfill: () => {},
      } as unknown as WorkspaceDocIndex
      const gate = buildWorkspaceRouteCheck(admitting, { workspaceForPeer: () => wsMint }, true)
      expect(await gate('peer', id)).toBe(true)
    })

    // The promise this design rests on: the MAC says WHICH WORKSPACE, never
    // WHETHER THIS PEER MAY. An unrouted peer is still refused under strict
    // routing even holding a perfectly valid minted id.
    it('does not admit an unrouted peer holding a valid minted id', async () => {
      const id = await mintedId(wsMint)
      const gate = buildWorkspaceRouteCheck(denyingIndex(), { workspaceForPeer: () => null }, true)
      expect(await gate('peer', id)).toBe(false)
    })

    // The gate-miss counter. It counts AT THE MISS SITE in
    // buildWorkspaceRouteCheck (every occurrence), never inside
    // noteRouteGateMiss (whose per-(doc, gap) licence dedupes the durable
    // INVALIDATION, not the observation) and never inside
    // scheduleWorkspaceRouteBackfill (which the upgrade pre-warm calls on
    // every socket). `walks_total` cannot isolate index misses — the
    // change-listener walk fires on every edit and the routeBackfills memo
    // dedupes the miss's schedule — so this counter is the instrument for
    // "zero index misses" in the create/repoint e2e.
    it('the route gate counts exactly one index miss per unminted unknown document', async () => {
      const index = denyingIndex()
      const missSpy = vi.spyOn(index, 'noteRouteGateMiss')
      const repo = new Repo({})
      const doc = repo.create({ legacy: true })
      await doc.whenReady()
      const legacyId = String(doc.documentId)
      const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => wsMint }, true)

      const before = docScopeGateMissTotal()
      expect(await gate('peer', legacyId)).toBe(false)
      expect(docScopeGateMissTotal() - before, 'one miss, one count').toBe(1)
      expect(missSpy).toHaveBeenCalledTimes(1)

      // A REPEATED miss on the same document still counts: the licence inside
      // noteRouteGateMiss gates the invalidation, never the observation.
      expect(await gate('peer', legacyId)).toBe(false)
      expect(docScopeGateMissTotal() - before).toBe(2)

      // Mutant guard: a counter incremented inside the scheduling machinery
      // would be inflated by the upgrade pre-warm (a direct schedule on every
      // socket) and by the constat helper — neither is a gate miss.
      index.scheduleWorkspaceRouteBackfill(wsMint)
      index.noteRouteGateMiss(wsMint, legacyId)
      expect(docScopeGateMissTotal() - before, 'only the gate site counts').toBe(2)
    })

    it('a bound minted id never touches the miss counter', async () => {
      const index = denyingIndex()
      const resolveSpy = vi.spyOn(index, 'resolveDocWorkspace')
      const id = await mintedId(wsMint)
      const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => wsMint }, true)
      const before = docScopeGateMissTotal()
      expect(await gate('peer', id)).toBe(true)
      expect(docScopeGateMissTotal() - before).toBe(0)
      // Branch order pinned: the MAC answers FIRST. An index-first mutant
      // would consult resolveDocWorkspace even for a bound id.
      expect(resolveSpy).not.toHaveBeenCalled()
    })

    // The DISPLACED branch is not a miss either. A
    // sibling-version minted id is answered by the MAC + the durable
    // first-owner-wins claim; the index-miss counter must stay untouched
    // whether the claim admits or refuses. Mutant: recordDocScopeGateMiss
    // added on the displaced scan path → the repoint e2e's "zero misses"
    // criterion (repoint-offline-create.spec.ts test 2) reads noise instead
    // of the invariant it exists to measure. resolveDocWorkspace answers null
    // on purpose: a mutant that routes displaced through the index-miss
    // fallback would count a miss and trip the same delta.
    it('a displaced minted id never touches the miss counter', async () => {
      const wsSibling = { landscapeId: wsMint.landscapeId, versionId: 'V-sibling' }
      const id = await mintedId(wsSibling) // minted for the SIBLING version…
      const displacedIndex = (claimAnswer: boolean) => ({
        resolveDocWorkspace: async () => null,
        scheduleWorkspaceRouteBackfill: () => {},
        noteRouteGateMiss: () => {},
        listLandscapeVersionIds: async () => [wsMint.versionId, wsSibling.versionId],
        claimVerifiedDocument: async () => claimAnswer,
      }) as unknown as WorkspaceDocIndex

      const before = docScopeGateMissTotal()
      // …presented on the wsMint route: displaced, ADMITTED via the claim…
      const admitting = buildWorkspaceRouteCheck(displacedIndex(true), { workspaceForPeer: () => wsMint }, true)
      expect(await admitting('peer', id)).toBe(true)
      // …and displaced-REFUSED (a sibling already owns the durable row).
      const refusing = buildWorkspaceRouteCheck(displacedIndex(false), { workspaceForPeer: () => wsMint }, true)
      expect(await refusing('peer', id)).toBe(false)
      expect(docScopeGateMissTotal() - before, 'displaced is never an index miss').toBe(0)
    })
  })

  it('keeps the legacy socket path only when strict routing is disabled', async () => {
    const legacy = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => null }, false)
    expect(await legacy('peer', 'a')).toBe(true)
  })

  it('repairs legacy durable assignments from the routed workspace manifest after restart', async () => {
    const repo = new Repo({})
    const diagram = repo.create({ name: 'browser-owned diagram' })
    const registry = repo.create({ diagrams: { legacy: { docUrl: diagram.url } } })
    const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([diagram, registry, root].map((handle) => handle.whenReady()))

    const assignments = new Map<string, { landscapeId: string; versionId: string }>()
    let versionReads = 0
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        const documentId = String(params[0] ?? '')
        if (sql.includes('INSERT INTO automerge_document_workspace')) {
          if (assignments.has(documentId)) return { rows: [], rowCount: 0 }
          assignments.set(documentId, wsA)
          return { rows: [{ document_id: documentId }], rowCount: 1 }
        }
        if (sql.includes('SELECT d.landscape_id')) {
          const assignment = assignments.get(documentId)
          return {
            rows: assignment ? [{
              landscape_id: assignment.landscapeId,
              version_id: assignment.versionId,
              root_url: root.url,
              static_source: null,
              static_allowed: true,
            }] : [],
          }
        }
        if (sql.includes('SELECT landscape_id, version_id')) {
          const assignment = assignments.get(documentId)
          return {
            rows: assignment ? [{
              landscape_id: assignment.landscapeId,
              version_id: assignment.versionId,
            }] : [],
          }
        }
        if (sql.includes('SELECT root_url FROM versions')) {
          versionReads += 1
          return { rows: [{ root_url: root.url }] }
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
    const durableIndex = new WorkspaceDocIndex(repo, pool)
    const routed = buildWorkspaceRouteCheck(
      durableIndex,
      { workspaceForPeer: () => wsA },
      true,
    )

    // The repaired workspace must announce itself, or the gate's first denial
    // would be sticky for the life of the connection (automerge-repo caches the
    // share-policy verdict per document+peer).
    const asKey = (k: { landscapeId: string; versionId: string }) => `${k.landscapeId}/${k.versionId}`
    const repaired: string[] = []
    durableIndex.onWorkspaceIndexRepaired = (key) => { repaired.push(asKey(key)) }

    expect(await durableIndex.resolveDocWorkspace(String(diagram.documentId))).toBeNull()

    // FIRST CONTACT IS DENIED, deliberately: the gate
    // runs inside a per-socket FIFO and inside automerge-repo's share-policy
    // resolution, so awaiting the repair here would wedge the connection that
    // holds the only copy of the document being resolved.
    expect(await routed('peer', String(diagram.documentId))).toBe(false)

    // ...but the repair it scheduled still lands, and admission follows.
    await vi.waitFor(() => {
      expect(assignments.get(String(diagram.documentId))).toEqual(wsA)
    }, { timeout: 5_000 })
    expect(await routed('peer', String(diagram.documentId))).toBe(true)
    expect(repaired).toContain(asKey(wsA))

    expect(await routed('peer', 'unreferenced-protocol-id')).toBe(false)
    // Still exactly one walk: the memo, not the await, is what bounds it.
    expect(versionReads).toBe(1)
  })

  // The structural pin for "claim leaves, do not resolve them".
  //
  // Measured cost of resolving them: a cold walk is ~45 s at 3,000 diagrams, a
  // fully-evicted re-walk 29.7 s, and at 10,000 diagrams the walk does not finish
  // at all — automerge's WASM heap is exhausted around 9,000 documents, ~5 GB RSS.
  // Resolving a leaf buys nothing: a leaf is watched with `control = false`, so
  // no listener is attached, and `reference()` has already done the two things
  // that matter — the id and the durable claim.
  //
  // The test asserts BOTH halves on purpose. "No leaf resolved" alone would pass
  // for an implementation that simply dropped the leaves from the index, which is
  // a default-deny outage. "Every leaf resolvable" alone would pass for an
  // implementation that loads every leaf. Only together do they say: same index,
  // without the loads.
  it('indexes every leaf while resolving only the root, ModelMeta and registry shards', async () => {
    const repo = new Repo({})
    const leaves = await Promise.all(Array.from({ length: 25 }, async (_, i) => {
      const h = repo.create({ name: `leaf-${i}` })
      await h.whenReady()
      return h
    }))
    const objShard = repo.create({ objects: {} })
    const meta = repo.create({ objectShardUrls: [objShard.url], connectionShardUrls: [] as string[] })
    const registry = repo.create({
      diagrams: Object.fromEntries(leaves.map((h, i) => [`d${i}`, { docUrl: h.url }])),
    })
    const monolith = repo.create({ objects: {} })
    const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await Promise.all([objShard, meta, registry, monolith, root].map((h) => h.whenReady()))

    const found: string[] = []
    const countingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'find') {
          return (url: string, opts?: unknown) => {
            found.push(String(url))
            return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('SELECT root_url FROM versions')) return { rows: [{ root_url: root.url }] }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(countingRepo, pool, { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L-pin', versionId: 'V-pin', rootUrl: root.url })

    // Half one: every leaf is INDEXED — the walk must still admit them all.
    for (const leaf of leaves) {
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(leaf.documentId)))
          .toEqual({ landscapeId: 'L-pin', versionId: 'V-pin' })
      }, { timeout: 5_000 })
    }
    // The model-side leaves too, so this pins all `findLeaf` sites, not just diagrams.
    expect(await index.resolveDocWorkspace(String(objShard.documentId))).toBeTruthy()
    expect(await index.resolveDocWorkspace(String(monolith.documentId))).toBeTruthy()

    // Half two: only the three control kinds were RESOLVED.
    const resolvedLeaves = found.filter((u) =>
      leaves.some((h) => h.url === u) || u === objShard.url || u === monolith.url)
    expect(resolvedLeaves, `the walk resolved ${resolvedLeaves.length} leaf documents; it needs none of them`)
      .toEqual([])
    expect(new Set(found)).toEqual(new Set([root.url, meta.url, registry.url]))
  }, 30_000)

  // The change-driven re-walk must be single-flight.
  //
  // Every registry shard shares one `entry.onChange` listener, so M shards
  // changing in one tick would start M concurrent traversals of the same entry
  // if the listener called `this.walk(entry)` directly. That is not merely M
  // times the work: each traversal builds its own local `newDocIds` and then
  // assigns `entry.docIds = newDocIds` and `entry.controlDocsComplete`, so the
  // LAST one to finish wins — an index that decides admission, overwritten by
  // whichever partial view finished last.
  //
  // Both halves are asserted. Bounding concurrency alone would pass for an
  // implementation that DROPS changes arriving mid-walk; that would leave a
  // newly created document unclaimed until something else happened to re-walk,
  // which is the outage this listener exists to prevent.
  it('coalesces a burst into a bounded number of walks, losing no change', async () => {
    const repo = new Repo({})
    const shards = await Promise.all(Array.from({ length: 6 }, async () => {
      const h = repo.create({ diagrams: {} as Record<string, { docUrl: string }> })
      await h.whenReady()
      return h
    }))
    const root = repo.create({ modelUrl: '', shardUrls: shards.map((h) => h.url) })
    await root.whenReady()
    const late = await Promise.all(Array.from({ length: 6 }, async (_v, i) => {
      const h = repo.create({ name: `late-${i}` })
      await h.whenReady()
      return h
    }))

    // Count walk STARTS, not overlapping root-finds: two fully concurrent walks
    // whose root-find windows happen not to overlap would score a peak of 1.
    let walkStarts = 0
    let burstFired = false
    let ambushed = false
    const trackingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'find') {
          return async (url: string, opts?: unknown) => {
            if (url === root.url) walkStarts += 1
            // THE AMBUSH. Change a shard the walk has ALREADY passed, from
            // inside its request for an earlier one. Without this the burst
            // lands while the walk is still suspended before reading any shard,
            // so even a leading-edge implementation that DROPS mid-walk changes
            // sees all of them in pass 1 — and the test cannot tell the two
            // apart.
            // Fire from shard 4's request and mutate shard 0 — a shard this
            // pass has ALREADY read. Mutating a LATER shard proves nothing: the
            // walk reads them in order and would pick it up in the same pass.
            if (burstFired && !ambushed && url === shards[4]!.url) {
              ambushed = true
              shards[0]!.change((doc: { diagrams: Record<string, { docUrl: string }> }) => {
                doc.diagrams.ambush = { docUrl: late[5]!.url }
              })
            }
            await new Promise((r) => setTimeout(r, 30))
            return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('SELECT root_url FROM versions')) return { rows: [{ root_url: root.url }] }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(trackingRepo, pool, { durable: false })
    notifyWorkspaceCreated({ landscapeId: 'L-coalesce', versionId: 'V-coalesce', rootUrl: root.url })
    await vi.waitFor(async () => {
      expect(await index.resolveDocWorkspace(String(shards[5]!.documentId))).toBeTruthy()
    }, { timeout: 10_000 })
    const startsBeforeBurst = walkStarts

    burstFired = true
    shards.slice(0, 5).forEach((shard, i) => {
      shard.change((doc: { diagrams: Record<string, { docUrl: string }> }) => {
        doc.diagrams[`late-${i}`] = { docUrl: late[i]!.url }
      })
    })

    // Half one: no change is lost — including the ambush, which landed behind
    // the walk's read cursor and can only be picked up by a trailing pass.
    for (const doc of late) {
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(doc.documentId)))
          .toEqual({ landscapeId: 'L-coalesce', versionId: 'V-coalesce' })
      }, { timeout: 20_000 })
    }
    expect(ambushed, 'the ambush never fired — the test proves nothing about trailing changes').toBe(true)

    // Half two: bounded. 6 changes must not cost 6 traversals. Trailing-edge
    // single flight allows the one in progress plus one more; the ambush can
    // add a third. Anything at or above the change count means no coalescing.
    await new Promise((r) => setTimeout(r, 800))
    const burstWalks = walkStarts - startsBeforeBurst
    expect(burstWalks, `${burstWalks} walks for a 6-change burst`).toBeLessThanOrEqual(3)
  }, 60_000)

  // A transient database fault during a coalesced burst must not swallow the
  // backlog. If `coalescedRewalk` gave up after N consecutive failures while
  // `rewalkPending` is still true and `rewalkInFlight` cleared, nothing would be
  // armed to run the walk the flag still asks for: the burst's documents stay
  // unclaimed and the route check keeps returning false — an unlifted deny,
  // which the sync path must never leave behind.
  //
  // `walkFrom` does not reject on an unreadable root — `find()` swallows read
  // failures and the walk returns with `controlDocsComplete = false`. The only
  // thing that rejects out of a walk is `claimDocument`'s `pool.query`, i.e.
  // exactly this scenario.
  it('recovers a coalesced burst after a transient database fault', async () => {
    const repo = new Repo({})
    const registry = repo.create({ diagrams: {} as Record<string, { docUrl: string }> })
    const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
    const late = repo.create({ name: 'created during the outage' })
    await Promise.all([registry, root, late].map((h) => h.whenReady()))

    const owned = new Map<string, string>()
    let failClaims = false
    let claimAttemptsDuringOutage = 0
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT root_url FROM versions')) return { rows: [{ root_url: root.url }] }
        if (sql.includes('automerge_document_workspace')) {
          if (failClaims) {
            claimAttemptsDuringOutage += 1
            throw new Error('remaining connection slots are reserved')
          }
          const id = String((params ?? [])[0])
          if (sql.trim().startsWith('INSERT')) {
            if (owned.has(id)) return { rows: [], rowCount: 0 }
            owned.set(id, 'L-outage')
            return { rows: [{ document_id: id }], rowCount: 1 }
          }
          const landscape = owned.get(id)
          return { rows: landscape ? [{ landscape_id: landscape, version_id: 'V-outage' }] : [], rowCount: landscape ? 1 : 0 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as pg.Pool

    const index = new WorkspaceDocIndex(repo, pool)
    notifyWorkspaceCreated({ landscapeId: 'L-outage', versionId: 'V-outage', rootUrl: root.url })
    await vi.waitFor(async () => {
      expect(await index.resolveDocWorkspace(String(registry.documentId))).toBeTruthy()
    }, { timeout: 5_000 })

    // The database goes away, then a diagram is created.
    failClaims = true
    registry.change((doc: { diagrams: Record<string, { docUrl: string }> }) => {
      doc.diagrams.late = { docUrl: late.url }
    })
    await vi.waitFor(() => { expect(claimAttemptsDuringOutage).toBeGreaterThan(0) }, { timeout: 10_000 })
    // Let the retry budget be spent while the fault persists.
    await new Promise((r) => setTimeout(r, 1_500))

    // The database comes back, and NOTHING else happens — no further edit, no
    // eviction, no reconnect. Recovery has to come from the re-walk itself.
    failClaims = false
    await vi.waitFor(async () => {
      expect(await index.resolveDocWorkspace(String(late.documentId)))
        .toEqual({ landscapeId: 'L-outage', versionId: 'V-outage' })
    }, { timeout: 30_000 })
  }, 60_000)

  // Leaf claims are BATCHED, and every batching mutant that
  // matters has a test aimed at it. The fake pool emulates BOTH claim shapes
  // (claimDocument's single-row INSERT for control documents, flushLeafClaims'
  // unnest batch for leaves) against one first-owner-wins map, so the tests
  // discriminate rather than mirror.
  describe('batched leaf claims (T2 step 2c)', () => {
    function claimTablePool(rootUrl: string, opts: { failing?: () => boolean } = {}) {
      const owned = new Map<string, { landscape: string; version: string }>()
      const batchInserts: string[][] = []
      const singleInserts: string[] = []
      // The durable FALLBACK must be switchable off, so a
      // test can prove byDoc alone answers — with it always on, a mutant that
      // drops the byDoc refill is rescued by resolveDurable and never dies.
      const control = { durableFallback: true }
      const pool = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('SELECT root_url FROM versions')) return { rows: [{ root_url: rootUrl }] }
          if (!sql.includes('automerge_document_workspace')) return { rows: [], rowCount: 0 }
          if (opts.failing?.()) throw new Error('remaining connection slots are reserved')
          const isInsert = sql.trim().startsWith('INSERT')
          if (isInsert && sql.includes('unnest')) {
            const ids = params?.[0] as string[]
            const landscape = String(params?.[1])
            const version = String(params?.[2])
            batchInserts.push([...ids])
            const rows: { document_id: string }[] = []
            for (const id of ids) {
              if (!owned.has(id)) {
                owned.set(id, { landscape, version })
                rows.push({ document_id: id })
              }
            }
            return { rows, rowCount: rows.length }
          }
          if (isInsert) {
            const id = String(params?.[0])
            singleInserts.push(id)
            if (owned.has(id)) return { rows: [], rowCount: 0 }
            owned.set(id, { landscape: String(params?.[1]), version: String(params?.[2]) })
            return { rows: [{ document_id: id }], rowCount: 1 }
          }
          // resolveDurable's shape carries root_url — dispatch it on the SQL,
          // not on the parameter type, so it is distinguishable from
          // claimDocument's winner SELECT (sharing a branch would give a
          // truncated answer that masks byDoc-refill mutants).
          if (sql.includes('root_url')) {
            if (!control.durableFallback) return { rows: [], rowCount: 0 }
            const hit = owned.get(String(params?.[0]))
            return hit
              ? {
                  rows: [{
                    landscape_id: hit.landscape,
                    version_id: hit.version,
                    root_url: rootUrl,
                    static_source: null,
                    static_allowed: false,
                  }],
                  rowCount: 1,
                }
              : { rows: [], rowCount: 0 }
          }
          const target = params?.[0]
          if (Array.isArray(target)) {
            const rows = target.filter((id) => owned.has(String(id))).map((id) => ({
              document_id: String(id),
              landscape_id: owned.get(String(id))!.landscape,
              version_id: owned.get(String(id))!.version,
            }))
            return { rows, rowCount: rows.length }
          }
          const winner = owned.get(String(target))
          return {
            rows: winner ? [{ landscape_id: winner.landscape, version_id: winner.version }] : [],
            rowCount: winner ? 1 : 0,
          }
        },
      } as unknown as pg.Pool
      return { pool, owned, batchInserts, singleInserts, control }
    }

    /** monolith + objShard + 5 diagram leaves = 7 leaf claims; with
     * claimBatchSize 2 that is 3 full batches plus a final partial one —
     * never a multiple of the batch size, so a dropped final flush shows. */
    async function leafFixture(repo: Repo) {
      const monolith = repo.create({ objects: {} })
      const objShard = repo.create({ objects: {} })
      const meta = repo.create({ objectShardUrls: [objShard.url], connectionShardUrls: [] as string[] })
      const diagrams = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
        const h = repo.create({ name: `d-${i}` })
        await h.whenReady()
        return h
      }))
      const registry = repo.create({
        diagrams: Object.fromEntries(diagrams.map((h, i) => [`d${i}`, { docUrl: h.url }])),
      })
      const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: meta.url, shardUrls: [registry.url] })
      await Promise.all([monolith, objShard, meta, registry, root].map((h) => h.whenReady()))
      return { monolith, objShard, meta, diagrams, registry, root }
    }

    const key = (l: string, v: string) => ({ landscapeId: l, versionId: v })

    it('the batched walk claims exactly the set the sequential walk claimed', async () => {
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned, batchInserts, singleInserts } = claimTablePool(fx.root.url)
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      notifyWorkspaceCreated({ landscapeId: 'L-b1', versionId: 'V-b1', rootUrl: fx.root.url })

      const leafIds = [fx.monolith, fx.objShard, ...fx.diagrams].map((h) => String(h.documentId))
      const controlIds = [fx.root, fx.meta, fx.registry].map((h) => String(h.documentId))
      for (const id of [...leafIds, ...controlIds]) {
        await vi.waitFor(async () => {
          expect(await index.resolveDocWorkspace(id)).toEqual(key('L-b1', 'V-b1'))
        }, { timeout: 5_000 })
      }
      // The durable set is exactly the reachable set — nothing dropped by a
      // cleared-before-send buffer, nothing left behind by a missing final
      // flush (7 leaves at batch size 2 leaves one id in the final partial).
      expect(new Set(owned.keys())).toEqual(new Set([...leafIds, ...controlIds]))
      // Leaves went through batches; control documents stayed single-row.
      expect(new Set(batchInserts.flat())).toEqual(new Set(leafIds))
      expect(new Set(singleInserts)).toEqual(new Set(controlIds))
      // The batch SHAPE is part of the contract: 7 leaves at
      // size 2 is exactly 2+2+2+1 — an off-by-one threshold or a splice that
      // withholds one id changes the count or overflows a batch.
      expect(batchInserts.map((b) => b.length)).toEqual([2, 2, 2, 1])
      // And each batch is SORTED — the cross-walk 40P01 deadlock guard: two
      // concurrent walks over overlapping sets must acquire index locks in one
      // monotonic order.
      for (const batch of batchInserts) {
        expect([...batch].sort()).toEqual(batch)
      }
    }, 30_000)

    it('a leaf already owned by another workspace stays the winner\'s — byDoc points at the winner after the walk', async () => {
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned } = claimTablePool(fx.root.url)
      // The LAST diagram sits in the final partial batch on purpose: with the
      // final flush moved after the commit loop (the capture mutant), it is
      // exactly the id the loop would commit to this workspace unguarded.
      const foreign = String(fx.diagrams[4]!.documentId)
      owned.set(foreign, { landscape: 'L-other', version: 'V-other' })
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      // Register the winner workspace FIRST so `resolveDocWorkspace` can name
      // it: a byDoc hit resolves through `byWorkspace`, and an unknown winner
      // yields null (deny) — correct, but indistinguishable from a dropped
      // claim in this test.
      const otherRoot = repo.create({ modelUrl: '', shardUrls: [] as string[] })
      await otherRoot.whenReady()
      notifyWorkspaceCreated({ landscapeId: 'L-other', versionId: 'V-other', rootUrl: otherRoot.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(otherRoot.documentId)))
          .toEqual(key('L-other', 'V-other'))
      }, { timeout: 5_000 })

      // Wait for the WHOLE walk (the announcement fires after the tail commit
      // loop): asserting mid-walk would let the capture mutant pass through
      // the durable fallback's answer instead of byDoc's.
      let walkAnnounced = false
      index.onWorkspaceIndexRepaired = (k2) => {
        if (k2.landscapeId === 'L-b2') walkAnnounced = true
      }
      notifyWorkspaceCreated({ landscapeId: 'L-b2', versionId: 'V-b2', rootUrl: fx.root.url })
      await vi.waitFor(() => { expect(walkAnnounced).toBe(true) }, { timeout: 5_000 })

      // First-owner-wins, in the durable table AND in the in-process index.
      expect(await index.resolveDocWorkspace(foreign)).toEqual(key('L-other', 'V-other'))
      expect(owned.get(foreign)).toEqual({ landscape: 'L-other', version: 'V-other' })
      expect(await index.resolveDocWorkspace(String(fx.diagrams[0]!.documentId)))
        .toEqual(key('L-b2', 'V-b2'))
    }, 30_000)

    it('a foreign leaf FOLLOWED by a fresh insert in the SAME batch: the winner mapping is by value, not position', async () => {
      // In the base winner test the foreign leaf sits ALONE in the final
      // partial batch, so a positional rows[i]<->ids[i] mapping degenerates to
      // the empty set and survives. Here the batch is [d2, d3] with d2
      // foreign: positionally, RETURNING=[d3] maps onto ids[0]=d2 and captures
      // the foreign document for this workspace.
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned } = claimTablePool(fx.root.url)
      // d2 and d3 share a batch. The flush SORTS its batch, so pick as foreign
      // whichever of the two sorts FIRST: RETURNING then holds only the
      // second, and a positional mapping assigns it to ids[0] — the foreign
      // document — deterministically, not on the luck of random ids.
      const pair = [String(fx.diagrams[2]!.documentId), String(fx.diagrams[3]!.documentId)].sort()
      const foreign = pair[0]!
      const fresh = pair[1]!
      owned.set(foreign, { landscape: 'L-other2', version: 'V-other2' })
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      const otherRoot = repo.create({ modelUrl: '', shardUrls: [] as string[] })
      await otherRoot.whenReady()
      notifyWorkspaceCreated({ landscapeId: 'L-other2', versionId: 'V-other2', rootUrl: otherRoot.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(otherRoot.documentId)))
          .toEqual(key('L-other2', 'V-other2'))
      }, { timeout: 5_000 })

      let walkAnnounced = false
      index.onWorkspaceIndexRepaired = (k2) => {
        if (k2.landscapeId === 'L-b8') walkAnnounced = true
      }
      notifyWorkspaceCreated({ landscapeId: 'L-b8', versionId: 'V-b8', rootUrl: fx.root.url })
      await vi.waitFor(() => { expect(walkAnnounced).toBe(true) }, { timeout: 5_000 })

      expect(await index.resolveDocWorkspace(foreign)).toEqual(key('L-other2', 'V-other2'))
      expect(owned.get(foreign)).toEqual({ landscape: 'L-other2', version: 'V-other2' })
      expect(await index.resolveDocWorkspace(fresh)).toEqual(key('L-b8', 'V-b8'))
    }, 30_000)

    it('an incremental re-walk whose ONLY admissions are batched leaves still announces', async () => {
      // Deny pairing: every admission must announce. On an incremental re-walk every CONTROL document is a byDoc
      // hit (admitting nothing), so the flush's inserted branch is the SOLE
      // source of `admitted`. Remove its flip and the new document's pinned
      // deny is never lifted — while every full-walk fixture passes, because
      // there the controls co-admit through reference().
      const repo = new Repo({})
      const registry = repo.create({ diagrams: {} as Record<string, { docUrl: string }> })
      const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
      const late = repo.create({ name: 'created after the first walk' })
      await Promise.all([registry, root, late].map((h) => h.whenReady()))
      const { pool } = claimTablePool(root.url)
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      let announced = 0
      index.onWorkspaceIndexRepaired = (k2) => {
        if (k2.landscapeId === 'L-b9') announced += 1
      }
      notifyWorkspaceCreated({ landscapeId: 'L-b9', versionId: 'V-b9', rootUrl: root.url })
      await vi.waitFor(() => { expect(announced).toBeGreaterThan(0) }, { timeout: 5_000 })

      const announcesAfterFirstWalk = announced
      registry.change((doc: { diagrams: Record<string, { docUrl: string }> }) => {
        doc.diagrams.late = { docUrl: late.url }
      })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(late.documentId)))
          .toEqual(key('L-b9', 'V-b9'))
      }, { timeout: 10_000 })
      await vi.waitFor(() => {
        expect(announced, 'the re-walk admitted a leaf and announced nothing — its deny stays pinned')
          .toBeGreaterThan(announcesAfterFirstWalk)
      }, { timeout: 5_000 })
    }, 30_000)

    it('conflicts won by self are admissions even when every CONTROL document is already warm', async () => {
      // The conflict branch. Pre-warm byDoc for
      // the three control documents through the durable fallback BEFORE the
      // walk, so reference() admits nothing for them; every leaf row is
      // already durably ours, so RETURNING is empty and the loser SELECT's
      // won-by-self branch is the ONLY possible source of the announcement.
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned } = claimTablePool(fx.root.url)
      const controlIds = [fx.root, fx.meta, fx.registry].map((h) => String(h.documentId))
      const leafIds = [fx.monolith, fx.objShard, ...fx.diagrams].map((h) => String(h.documentId))
      for (const id of [...controlIds, ...leafIds]) owned.set(id, { landscape: 'L-b10', version: 'V-b10' })
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      // Warm the controls via resolveDurable (the restart shape: the browser
      // asks for root/meta/registry first, before any walk).
      for (const id of controlIds) {
        expect(await index.resolveDocWorkspace(id)).toEqual(key('L-b10', 'V-b10'))
      }
      let announced = 0
      index.onWorkspaceIndexRepaired = (k2) => {
        if (k2.landscapeId === 'L-b10') announced += 1
      }
      notifyWorkspaceCreated({ landscapeId: 'L-b10', versionId: 'V-b10', rootUrl: fx.root.url })
      await vi.waitFor(() => {
        expect(announced, 'won-by-self conflicts admitted nothing — the re-booted workspace stays denied')
          .toBeGreaterThan(0)
      }, { timeout: 5_000 })
    }, 30_000)

    it('a flush failure rejects the walk and the backlog survives to the retried walk', async () => {
      const repo = new Repo({})
      const registry = repo.create({ diagrams: {} as Record<string, { docUrl: string }> })
      const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
      const late = await Promise.all(Array.from({ length: 3 }, async (_, i) => {
        const h = repo.create({ name: `late-${i}` })
        await h.whenReady()
        return h
      }))
      await Promise.all([registry, root].map((h) => h.whenReady()))
      let failing = false
      let attemptsDuringOutage = 0
      const table = claimTablePool(root.url, {
        failing: () => {
          if (failing) attemptsDuringOutage += 1
          return failing
        },
      })
      const index = new WorkspaceDocIndex(repo, table.pool, { claimBatchSize: 2 })
      notifyWorkspaceCreated({ landscapeId: 'L-b3', versionId: 'V-b3', rootUrl: root.url })
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(String(registry.documentId))).toBeTruthy()
      }, { timeout: 5_000 })

      failing = true
      registry.change((doc: { diagrams: Record<string, { docUrl: string }> }) => {
        for (const [i, h] of late.entries()) doc.diagrams[`late-${i}`] = { docUrl: h.url }
      })
      await vi.waitFor(() => { expect(attemptsDuringOutage).toBeGreaterThan(0) }, { timeout: 10_000 })
      // Let the local retry budget burn while the fault persists — a walk that
      // caught-and-logged its flush would already have resolved "clean" here.
      await new Promise((r) => setTimeout(r, 1_500))

      failing = false
      // NOTHING else happens: recovery must come from the re-walk machinery.
      for (const h of late) {
        await vi.waitFor(async () => {
          expect(await index.resolveDocWorkspace(String(h.documentId)))
            .toEqual(key('L-b3', 'V-b3'))
        }, { timeout: 30_000 })
      }
      // The DURABLE table, not just the in-process index. A flush that
      // catches-and-logs its own throw resolves the walk "clean", the tail
      // commit loop then admits the leaves into byDoc — so the resolve
      // assertions above pass — and byDoc now shadows the loss: the next walk
      // skips buffering ids it finds in byDoc, so the row is never inserted
      // for the life of the process. resolveDocWorkspace is the wrong witness
      // for durability; the table is the witness.
      for (const h of late) {
        await vi.waitFor(() => {
          expect(table.owned.has(String(h.documentId)), `late doc ${h.documentId} has no durable claim`).toBe(true)
        }, { timeout: 30_000 })
      }
    }, 60_000)

    it('the final flush lands before the repaired announcement — the last batch\'s denies are liftable', async () => {
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned } = claimTablePool(fx.root.url)
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      const leafIds = [fx.monolith, fx.objShard, ...fx.diagrams].map((h) => String(h.documentId))
      // Snapshot the DURABLE table at announcement time. The announcement is
      // what lifts pinned share-policy denies (deny pairing); if the final
      // batch has not landed by then, its documents were denied and nothing
      // re-announces for them — the fire-and-forget-flush mutant.
      const ownedAtAnnounce: string[][] = []
      index.onWorkspaceIndexRepaired = () => { ownedAtAnnounce.push([...owned.keys()]) }
      notifyWorkspaceCreated({ landscapeId: 'L-b4', versionId: 'V-b4', rootUrl: fx.root.url })

      await vi.waitFor(() => { expect(ownedAtAnnounce.length).toBeGreaterThan(0) }, { timeout: 5_000 })
      const first = new Set(ownedAtAnnounce[0])
      for (const id of leafIds) expect(first, `leaf ${id} unclaimed at announce time`).toContain(id)
    }, 30_000)

    it('intra-batch duplicate references collapse to one claim — decorated twins included', async () => {
      const repo = new Repo({})
      const target = repo.create({ name: 'shared' })
      await target.whenReady()
      const registry = repo.create({
        diagrams: {
          d0: { docUrl: target.url },
          d1: { docUrl: target.url },
          // A decorated twin: same document, different string.
          d2: { docUrl: `${target.url}/` },
        },
      })
      const root = repo.create({ modelUrl: '', shardUrls: [registry.url] })
      await Promise.all([registry, root].map((h) => h.whenReady()))
      const { pool, owned, batchInserts } = claimTablePool(root.url)
      const index = new WorkspaceDocIndex(repo, pool)
      notifyWorkspaceCreated({ landscapeId: 'L-b5', versionId: 'V-b5', rootUrl: root.url })

      const id = String(target.documentId)
      await vi.waitFor(async () => {
        expect(await index.resolveDocWorkspace(id)).toEqual(key('L-b5', 'V-b5'))
      }, { timeout: 5_000 })
      // EXACT equality, not an occurrence count:
      // a de-canonicalised buffer ships the bare id AND its decorated twin
      // "<id>/" — counting only exact matches of the bare id stays at 1 and
      // misses the parasite claim entirely.
      expect(batchInserts.flat()).toEqual([id])
      const rootId = String(root.documentId)
      const registryId = String(registry.documentId)
      expect(new Set(owned.keys())).toEqual(new Set([rootId, registryId, id]))
    }, 30_000)

    it('restart re-claim: rows already durably ours still announce and refill byDoc', async () => {
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      const { pool, owned, control } = claimTablePool(fx.root.url)
      const allIds = [fx.root, fx.meta, fx.registry, fx.monolith, fx.objShard, ...fx.diagrams]
        .map((h) => String(h.documentId))
      // The restart shape: every row already exists and is OURS, so every
      // batch INSERT conflicts and RETURNING is empty. The announcement must
      // still fire — a workspace that re-boots into pinned denies that
      // nothing lifts is exactly what the deny-pairing rule bans.
      for (const id of allIds) owned.set(id, { landscape: 'L-b6', version: 'V-b6' })
      const index = new WorkspaceDocIndex(repo, pool, { claimBatchSize: 2 })
      let announced = 0
      index.onWorkspaceIndexRepaired = () => { announced += 1 }
      notifyWorkspaceCreated({ landscapeId: 'L-b6', versionId: 'V-b6', rootUrl: fx.root.url })

      await vi.waitFor(() => { expect(announced).toBeGreaterThan(0) }, { timeout: 5_000 })
      // With the walk done, byDoc ALONE must answer: the durable fallback
      // is switched off so a dropped byDoc refill cannot be rescued by
      // resolveDurable answering in its place.
      control.durableFallback = false
      for (const id of allIds) {
        expect(await index.resolveDocWorkspace(id)).toEqual(key('L-b6', 'V-b6'))
      }
    }, 30_000)

    it('durable:false walks never touch the pool and admit synchronously', async () => {
      const repo = new Repo({})
      const fx = await leafFixture(repo)
      let claimQueries = 0
      const pool = {
        query: async (sql: string) => {
          if (sql.includes('automerge_document_workspace')) claimQueries += 1
          if (sql.includes('SELECT root_url FROM versions')) return { rows: [{ root_url: fx.root.url }] }
          return { rows: [], rowCount: 0 }
        },
      } as unknown as pg.Pool
      const index = new WorkspaceDocIndex(repo, pool, { durable: false, claimBatchSize: 2 })
      notifyWorkspaceCreated({ landscapeId: 'L-b7', versionId: 'V-b7', rootUrl: fx.root.url })
      for (const h of [fx.monolith, ...fx.diagrams]) {
        await vi.waitFor(async () => {
          expect(await index.resolveDocWorkspace(String(h.documentId))).toEqual(key('L-b7', 'V-b7'))
        }, { timeout: 5_000 })
      }
      expect(claimQueries).toBe(0)
    }, 30_000)
  })

  it('denies without walking, and repeated unknown ids do not multiply walks', async () => {
    const repo = new Repo({})
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await root.whenReady()
    let versionReads = 0
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('SELECT root_url FROM versions')) {
          versionReads += 1
          return { rows: [{ root_url: root.url }] }
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
    const durableIndex = new WorkspaceDocIndex(repo, pool)
    const routed = buildWorkspaceRouteCheck(durableIndex, { workspaceForPeer: () => wsA }, true)

    // A burst of unknown ids is exactly what a hostile or confused peer
    // produces; the scheduler's cooldown, not an await, is the limiter.
    for (let i = 0; i < 10; i += 1) {
      expect(await routed('peer', `unknown-${i}`)).toBe(false)
    }
    await new Promise((r) => setTimeout(r, 200))
    expect(versionReads).toBe(1)
  })

  it('does not let a platform admin cross the workspace declared by its socket', async () => {
    const claims: SessionClaims = { userId: 'platform', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const registry: PeerIdentityLookup = {
      identityForPeer: () => claims,
      workspaceForPeer: () => wsA,
    }
    const check = buildAccessCheck({} as pg.Pool, index, registry)
    expect(await check('peer', 'a')).toBe(true)
    expect(await check('peer', 'b')).toBe(false)
    expect(await check('peer', 'unknown')).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Access gate matrix (live Postgres — off/dual/on x known/unknown peer x
// allowed/denied doc). buildAccessCheck itself is stage-agnostic (always
// computes the true RBAC answer); the off/dual/on behavior is layered on by
// `stageAwareAccessCheck` in selectiveSync.ts, tested separately there. This
// suite exercises buildAccessCheck's own "true answer" cases exhaustively.
// ---------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)('buildAccessCheck — access gate matrix (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'docscope_matrix')
    pool = db.pool
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, `docScope test org ${id}`, id])
    return id
  }
  async function makeUser(): Promise<string> {
    const id = rid('user')
    await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`, [
      id, id, `${id}@example.com`,
    ])
    return id
  }
  async function makeWorkspace(orgId: string): Promise<{ landscapeId: string; versionId: string }> {
    const landscapeId = rid('landscape')
    const versionId = rid('version')
    await pool.query(`INSERT INTO landscapes (id, name) VALUES ($1, $2)`, [landscapeId, 'L'])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:fake')`, [
      versionId, landscapeId,
    ])
    await upsertVersionScope(pool, orgId, landscapeId, versionId)
    return { landscapeId, versionId }
  }
  async function dropOrg(orgId: string): Promise<void> {
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }
  async function dropLandscape(landscapeId: string): Promise<void> {
    await pool.query(`DELETE FROM landscapes WHERE id = $1`, [landscapeId])
  }

  function fakeIndex(resolved: Record<string, { landscapeId: string; versionId: string } | null>) {
    return {
      resolveDocWorkspace: async (docId: string) => resolved[docId] ?? null,
    } as unknown as import('./docScope.js').WorkspaceDocIndex
  }

  it('unknown peer (never authenticated) -> DENY regardless of doc', async () => {
    const registry: PeerIdentityLookup = { identityForPeer: () => undefined }
    const check = buildAccessCheck(pool, fakeIndex({}), registry)
    expect(await check('peer-unknown', 'doc-1')).toBe(false)
  })

  it('authenticated with null claims (stage off/dual, no session) -> DENY', async () => {
    const registry: PeerIdentityLookup = { identityForPeer: () => null }
    const check = buildAccessCheck(pool, fakeIndex({}), registry)
    expect(await check('peer-anon', 'doc-1')).toBe(false)
  })

  it('platform admin -> ALLOW unconditionally, even for an unindexed doc', async () => {
    const claims: SessionClaims = { userId: 'admin1', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const registry: PeerIdentityLookup = { identityForPeer: () => claims }
    const check = buildAccessCheck(pool, fakeIndex({}), registry)
    expect(await check('peer-admin', 'doc-unindexed')).toBe(true)
  })

  it('unindexed doc -> DENY even for an org-admin (default-deny quarantine)', async () => {
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, userId])
      const claims: SessionClaims = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      const registry: PeerIdentityLookup = { identityForPeer: () => claims }
      const check = buildAccessCheck(pool, fakeIndex({}), registry) // doc resolves to null
      expect(await check('peer-orgadmin', 'doc-unindexed')).toBe(false)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('org-admin -> ALLOW for a doc indexed to a workspace in their org', async () => {
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, userId])
      const ws = await makeWorkspace(orgId)
      const claims: SessionClaims = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      const registry: PeerIdentityLookup = { identityForPeer: () => claims }
      const check = buildAccessCheck(pool, fakeIndex({ 'doc-x': ws }), registry)
      expect(await check('peer-orgadmin2', 'doc-x')).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('plain member with NO team grant -> DENY even for an indexed doc in their own org', async () => {
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, userId])
      const ws = await makeWorkspace(orgId)
      const claims: SessionClaims = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      const registry: PeerIdentityLookup = { identityForPeer: () => claims }
      const check = buildAccessCheck(pool, fakeIndex({ 'doc-y': ws }), registry)
      expect(await check('peer-member', 'doc-y')).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('member with a team read grant on the version scope -> ALLOW', async () => {
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, userId])
      const ws = await makeWorkspace(orgId)
      const teamId = rid('team')
      await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'T')`, [teamId, orgId])
      await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM scopes WHERE org_id = $1 AND kind = 'version' AND landscape_id = $2 AND version_id = $3`,
        [orgId, ws.landscapeId, ws.versionId]
      )
      await pool.query(
        `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, false)`,
        [teamId, rows[0].id]
      )
      const claims: SessionClaims = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      const registry: PeerIdentityLookup = { identityForPeer: () => claims }
      const check = buildAccessCheck(pool, fakeIndex({ 'doc-z': ws }), registry)
      expect(await check('peer-granted', 'doc-z')).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('member of a DIFFERENT org (no grant there) -> DENY, proving org isolation', async () => {
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    try {
      const userB = await makeUser()
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgB, userB])
      const wsA = await makeWorkspace(orgA) // workspace lives in org A
      const claims: SessionClaims = { userId: userB, orgId: orgB, isPlatformAdmin: false, epoch: 1 }
      const registry: PeerIdentityLookup = { identityForPeer: () => claims }
      const check = buildAccessCheck(pool, fakeIndex({ 'doc-cross': wsA }), registry)
      expect(await check('peer-crossorg', 'doc-cross')).toBe(false)
      await dropLandscape(wsA.landscapeId)
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
    }
  })
})

describe.skipIf(!TEST_DATABASE_URL)('ensureScopesForExistingWorkspaces (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    // Isolated schema is load-bearing here: `ensureScopesForExistingWorkspaces`
    // backfills a scope row for EVERY version it can see, and `ensureDefaultOrg`
    // upserts a default org — both must only ever see this suite's fixtures,
    // never a shared database's real workspaces or its real default org.
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'docscope_backfill')
    pool = db.pool
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  it('backfills a scope row for every existing version under the Default Org, idempotently', async () => {
    const landscapeId = rid('landscape')
    const versionId = rid('version')
    await pool.query(`INSERT INTO landscapes (id, name) VALUES ($1, 'L')`, [landscapeId])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:fake')`, [
      versionId, landscapeId,
    ])
    try {
      await ensureScopesForExistingWorkspaces(pool)
      const orgId = await ensureDefaultOrg(pool)
      const { rows } = await pool.query(
        `SELECT id FROM scopes WHERE org_id = $1 AND kind = 'version' AND landscape_id = $2 AND version_id = $3`,
        [orgId, landscapeId, versionId]
      )
      expect(rows).toHaveLength(1)

      // Idempotent: calling again does not error or duplicate.
      await ensureScopesForExistingWorkspaces(pool)
      const { rows: rows2 } = await pool.query(
        `SELECT id FROM scopes WHERE org_id = $1 AND kind = 'version' AND landscape_id = $2 AND version_id = $3`,
        [orgId, landscapeId, versionId]
      )
      expect(rows2).toHaveLength(1)
      expect(rows2[0].id).toBe(rows[0].id)
    } finally {
      await pool.query(`DELETE FROM landscapes WHERE id = $1`, [landscapeId])
    }
  })
})

describe.skipIf(!TEST_DATABASE_URL)('allowedWorkspaceKeys (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'docscope_awk')
    pool = db.pool
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  it('platform admin sees every workspace; a plain member with no grants sees none', async () => {
    const orgId = `org_${randomBytes(6).toString('base64url')}`
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'AWK org', orgId])
    const landscapeId = rid('landscape')
    const versionId = rid('version')
    await pool.query(`INSERT INTO landscapes (id, name) VALUES ($1, 'L')`, [landscapeId])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:fake')`, [
      versionId, landscapeId,
    ])
    try {
      const memberId = rid('user')
      await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $1, $1, $1)`, [memberId])
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId])

      const platformClaims: SessionClaims = { userId: 'nobody', orgId: null, isPlatformAdmin: true, epoch: 1 }
      const platformKeys = await allowedWorkspaceKeys(pool, platformClaims)
      expect(platformKeys.has(`${landscapeId}/${versionId}`)).toBe(true)

      const memberClaims: SessionClaims = { userId: memberId, orgId, isPlatformAdmin: false, epoch: 1 }
      const memberKeys = await allowedWorkspaceKeys(pool, memberClaims)
      expect(memberKeys.has(`${landscapeId}/${versionId}`)).toBe(false)
    } finally {
      await pool.query(`DELETE FROM landscapes WHERE id = $1`, [landscapeId])
      await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
    }
  })
})

describe('docScope /metrics samples', () => {
  // Nothing in CI mounts index.ts's /metrics route, so
  // the docscope lines' presence is pinned against the builder the route
  // spreads in. Mutant: either line removed from the block → the series
  // silently disappears from every dashboard AND the repoint e2e's scrape
  // (repoint-offline-create.spec.ts) starts failing at "line missing" instead
  // of measuring a delta.
  it('the payload carries the walk and gate-miss counter lines', () => {
    const rendered = renderPrometheus(docScopeMetricSamples())
    expect(rendered).toMatch(/^maplespire_docscope_walks_total \d+$/m)
    expect(rendered).toMatch(/^maplespire_docscope_gate_misses_total \d+$/m)
    // The displaced-scan truncation trace must reach /metrics,
    // or a beyond-cap landscape's foreign denies would be invisible.
    expect(rendered).toMatch(/^maplespire_docscope_displaced_scan_truncations_total \d+$/m)
  })
})
