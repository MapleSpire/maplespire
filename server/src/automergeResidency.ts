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

import { type DocHandle, type DocumentId, Repo } from '@automerge/automerge-repo'
import { cachedHandles, syncedHandle } from './automergeRepoCompat.js'
import { currentProcessBootId } from './processIdentity.js'

export type AutomergeDocumentType =
  | 'root'
  | 'model-meta'
  | 'registry-shard'
  | 'object-shard'
  | 'connection-shard'
  | 'diagram'
  | 'monolith'
  | 'unknown'

interface LeaseOwner {
  workspace: string
  documentType: AutomergeDocumentType
}

interface DocumentLease {
  owners: Map<string, LeaseOwner>
}

export interface AutomergeResidencySnapshot {
  generatedAt: string
  /** Identity of the process that produced this snapshot, stable for its life.
   *
   * Every other counter here is CUMULATIVE, so a caller that grades a delta is
   * assuming one process spanned its window. This is the field that lets it
   * CHECK that assumption instead: two snapshots carrying different boot ids
   * describe two processes and cannot be subtracted. See `processIdentity.ts`
   * for why a restart reads as a valid pass without it. */
  processBootId: string
  handles: number
  leasedDocuments: number
  leaseOwners: number
  protectedDocuments: number
  evictedDocuments: number
  evictionSkippedActivePeer: number
  /** Evictions refused because the document the caller decided about is no
   * longer the one this process holds. Without it a refusal appears in
   * NEITHER `evicted` NOR any `skipped*`, and the sweep's payload stops adding
   * up — a systematic mismatch would reclaim nothing while every counter in
   * the log reported health. */
  evictionSkippedStaleHandle: number
  /** Documents evicted while a listener nobody accounted for was still attached
   * — the orphaned-watcher class, counted at the one place it must pass. */
  orphanedListenerEvictions: number
  orphanedListenersByType: Record<string, number>
  byState: Record<string, number>
  byType: Record<string, number>
  leasedByWorkspace: Record<string, number>
  durableChunkBytesByWorkspace: Record<string, number>
  durableChunkBytesByType: Record<string, number>
  residentDurableChunkBytes: number
  residentDurableBytesTrackedDocuments: number
  processMemory: NodeJS.MemoryUsage
}

export interface AutomergeRuntimeTypeSnapshot {
  handles: number
  activePeerDocuments: number
  peerReferences: number
  numOps: number
  maxDocumentOps: number
  numChanges: number
  durableChunkBytes: number
}

export interface AutomergeRuntimeSnapshot {
  generatedAt: string
  handles: number
  byType: Record<string, AutomergeRuntimeTypeSnapshot>
  processMemory: NodeJS.MemoryUsage
}

export interface AutomergeResidencyStorageProbe {
  snapshot(documentIds: readonly string[]): {
    trackedDocuments: number
    trackedChunkBytes: number
  }
  forget(documentId: string): void
}

function recordCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

/**
 * `'change'` listeners automerge-repo itself keeps on a ready handle.
 *
 * The census threshold is derived from this, so it is MEASURED rather than
 * assumed: `automergeResidency.test.ts` asserts it against a real Repo. If an
 * upstream release changes the number, that test fails — instead of the census
 * silently becoming noise, or, far worse, silently going quiet.
 */
export const REPO_BASELINE_CHANGE_LISTENERS = 0

export function classifyAutomergeDocument(value: unknown): AutomergeDocumentType {
  if (!value || typeof value !== 'object') return 'unknown'
  const doc = value as Record<string, unknown>
  if (Array.isArray(doc.shardUrls) && ('modelUrl' in doc || 'modelMetaUrl' in doc)) return 'root'
  if (Array.isArray(doc.objectShardUrls) && Array.isArray(doc.connectionShardUrls)) return 'model-meta'
  if ('diagrams' in doc) return 'registry-shard'
  if ('objects' in doc && 'connections' in doc) return 'monolith'
  if ('objects' in doc) return 'object-shard'
  if ('connections' in doc) return 'connection-shard'
  if ('layouts' in doc || 'comments' in doc || 'flows' in doc) return 'diagram'
  return 'unknown'
}

export async function collectAutomergeGarbage(
  collector: (() => void) | null | undefined = (globalThis as typeof globalThis & { gc?: () => void }).gc,
): Promise<boolean> {
  if (!collector) return false
  collector()
  await new Promise<void>((resolve) => setImmediate(resolve))
  collector()
  return true
}

/**
 * Reference-counted residency for live read-model projectors.
 *
 * A projector leases every document to which it attaches a listener. Idle
 * eviction can therefore remain enabled with READ_MODEL=on. Releasing the last
 * owner removes the ready handle from Repo's cache when no WebSocket peer is
 * using it; durable storage is untouched, so the next request can reload it.
 */
export class AutomergeResidencyLeases {
  private readonly leases = new Map<DocumentId, DocumentLease>()
  private readonly protectedIds = new Set<DocumentId>()
  private readonly pending = new Set<Promise<unknown>>()
  private evictedDocuments = 0
  private evictionSkippedActivePeer = 0
  private evictionSkippedStaleHandle = 0
  /** Documents carrying the idle sweep's ambient 'change' tracker. The sweep
   * attaches one to every ready handle it iterates, BEFORE the lease check, so
   * without this every releaseOwner/replaceOwner eviction would look like an
   * orphaned watcher and the census would be non-zero at steady state. */
  private readonly ambientListeners = new Set<string>()
  private orphanedListenerEvictions = 0
  private readonly orphanedListenersByType: Record<string, number> = {}
  private lastOrphanReportAt = 0
  private readonly beforeEvictListeners =
    new Set<(documentId: string, handle?: DocHandle<unknown>) => void>()

  constructor(
    private readonly repo: Repo,
    private readonly storageProbe?: AutomergeResidencyStorageProbe,
  ) {}

  protect(handle: DocHandle<unknown>): void {
    this.protectedIds.add(handle.documentId)
  }

  acquire(
    handle: DocHandle<unknown>,
    owner: string,
    workspace: string,
    documentType = classifyAutomergeDocument(handle.doc()),
  ): void {
    let lease = this.leases.get(handle.documentId)
    if (!lease) {
      lease = { owners: new Map() }
      this.leases.set(handle.documentId, lease)
    }
    lease.owners.set(owner, { workspace, documentType })
  }

  /**
   * Atomically move an exclusive owner (for example a static root or write-head
   * slot) to `handle`. Acquiring the replacement before scheduling eviction of
   * the retired document is essential: `releaseOwner()` starts `evict()`
   * synchronously, so a release-then-acquire sequence can remove the very same
   * handle while a descriptor is merely being refreshed.
   */
  replaceOwner(
    handle: DocHandle<unknown>,
    owner: string,
    workspace: string,
    documentType = classifyAutomergeDocument(handle.doc()),
  ): void {
    this.acquire(handle, owner, workspace, documentType)
    for (const [documentId, lease] of this.leases) {
      if (documentId === handle.documentId || !lease.owners.delete(owner)) continue
      if (lease.owners.size > 0) continue
      this.leases.delete(documentId)
      this.track(this.evict(documentId))
    }
  }

  releaseOwner(owner: string): void {
    for (const [documentId, lease] of this.leases) {
      if (!lease.owners.delete(owner)) continue
      if (lease.owners.size > 0) continue
      this.leases.delete(documentId)
      this.track(this.evict(documentId))
    }
  }

  /** Monotonic. DIFF IT across a window; the idle sweep does exactly that to
   *  report `skippedStaleHandle` for one pass. */
  staleHandleSkips(): number {
    return this.evictionSkippedStaleHandle
  }

  isLeased(documentId: string): boolean {
    return this.leases.has(documentId as DocumentId)
  }

  /** Release component-owned strong references before Repo drops a handle. */
  onBeforeEvict(listener: (documentId: string, handle?: DocHandle<unknown>) => void): () => void {
    this.beforeEvictListeners.add(listener)
    return () => this.beforeEvictListeners.delete(listener)
  }

  /** Declare a 'change' listener this process attaches to every handle it sees,
   * rather than to a document it is deliberately watching. Only the idle sweep
   * does this; it is ambient, not evidence of an owner. */
  noteAmbientListener(documentId: string): void {
    this.ambientListeners.add(documentId)
  }

  /** Forget an ambient marker for a document dropped by something that does not
   * run the census (partition failover). Left behind, it would suppress one real
   * orphan the next time that document is evicted through a path that does. */
  forgetAmbientListener(documentId: string): void {
    this.ambientListeners.delete(documentId)
  }

  /**
   * Announce an imminent eviction to before-evict listeners. Also called for
   * evictions this class did not perform: partition failover drops a whole
   * workspace through `evictWorkspaceDocumentCache` straight to
   * `repo.removeFromCache`, and without this announcement its watchers (e.g.
   * `WorkspaceDocIndex.trackResidency`) would be orphaned unnoticed.
   *
   * `handle` is passed because every caller already holds it, and a listener
   * would otherwise reach for `repo.handles` — a GETTER that rebuilds a whole
   * `Record` per access (~36 ms/sweep/projector inside a loop versus ~0.18 ms
   * hoisted). Optional so the failover path, which looks handles up by id, can
   * pass what it has.
   */
  notifyBeforeEvict(documentId: string, handle?: DocHandle<unknown>): void {
    for (const listener of this.beforeEvictListeners) {
      try {
        listener(documentId, handle)
      } catch (error) {
        console.warn('[automerge-residency] before-evict listener failed', error)
      }
    }
  }

  hasActivePeers(documentId: string): boolean {
    try {
      const source = this.repo.synchronizer as unknown as {
        peers: string[]
        docSynchronizers: Record<string, { hasPeer(peerId: string): boolean }>
      }
      const synchronizer = source.docSynchronizers?.[documentId]
      return !!synchronizer && source.peers.some((peerId) => synchronizer.hasPeer(peerId))
    } catch {
      return true
    }
  }

  /**
   * `expected` is the handle the CALLER was holding when it decided to evict.
   *
   * Pass it whenever you have one. The idle sweep decides from a snapshot taken
   * at the start of its pass; by the time this runs another path may have
   * dropped that document and someone may have re-resolved it under a NEW
   * handle object (a `find` after `removeFromCache` does not return the same
   * object). Evicting then would discard a document somebody just asked for and
   * run the orphan census over a dead object. `expected` says what the caller
   * BELIEVED, the lookup says what is true, and eviction proceeds only where
   * they agree. `releaseOwner`/`replaceOwner` pass nothing, because a lease
   * release is a decision about the id, not about a particular handle.
   */
  async evict(documentId: string, expected?: DocHandle<unknown>): Promise<boolean> {
    const id = documentId as DocumentId
    if (this.protectedIds.has(id) || this.leases.has(id)) return false
    // O(1). Not `this.repo.handles[id]`, a getter that rebuilds a whole Record
    // per access: the idle sweep calls this once per candidate, so that would
    // cost 2.65 s at 3 000 documents and 34.5 s at 10 000.
    const handle = syncedHandle(this.repo, id)
    if (!handle) return false
    if (expected !== undefined && expected !== handle) {
      // Counted, not merely refused. What lifts this refusal is the NEXT sweep
      // interval: `lastActive.delete` only runs on a successful eviction, so the
      // document stays idle-eligible and is reconsidered against whatever handle
      // is resident then.
      this.evictionSkippedStaleHandle += 1
      return false
    }
    // Catches `deleted` only (`DocHandle.state` is `deleted` or `ready`).
    // `repo.delete` drops the cache entry synchronously, but `DocHandle.delete()`
    // called on its own leaves a `deleted` handle cached (pinned in the seam
    // test), so the guard stays.
    if (handle.state !== 'ready') return false
    if (this.hasActivePeers(documentId)) {
      this.evictionSkippedActivePeer += 1
      return false
    }
    // A lease may have been acquired while the peer check was in flight.
    if (this.leases.has(id)) return false
    // Notify FIRST, then count. An orphan is a listener still attached after
    // everyone who knows about eviction has cleaned up — so the census has to
    // run after the announcement, not before it: the read-model projector
    // watches diagram documents WITHOUT leasing them (by design) and detaches
    // from this very hook, so counting first would flag every one of them.
    this.notifyBeforeEvict(documentId, handle)
    this.census(documentId, handle)
    // automerge-repo's experimental removeFromCache() unloads the handle by
    // replacing its document with A.init(). That transition emits
    // `heads-changed`; if the Repo persistence listener is still attached it
    // durably saves the empty document and destroys the workspace on the next
    // cold load. Detach that listener from this discarded handle before the
    // unload. Do not flush here: a cell may be evicting a cache copy immediately
    // after losing its fence, and cleanup must never attempt another mutation.
    handle.removeAllListeners('heads-changed')
    await this.repo.removeFromCache(id)
    this.storageProbe?.forget(documentId)
    this.ambientListeners.delete(documentId)
    this.evictedDocuments += 1
    return true
  }

  /**
   * How many `'change'` listeners on this document nobody has claimed.
   *
   * Returns 0 when the count cannot be read — an unreadable handle is not
   * evidence of a violation.
   */
  private unaccountedChangeListeners(documentId: string, handle: DocHandle<unknown>): number {
    let attached: number
    try {
      attached = handle.listenerCount?.('change') ?? 0
    } catch {
      return 0
    }
    const ambient = this.ambientListeners.has(documentId) ? 1 : 0
    return Math.max(0, attached - REPO_BASELINE_CHANGE_LISTENERS - ambient)
  }

  /** Best-effort document classification; a document mid-transition still counts. */
  private classify(handle: DocHandle<unknown>): AutomergeDocumentType {
    try {
      return classifyAutomergeDocument(handle.doc())
    } catch {
      return 'unknown'
    }
  }

  /**
   * Count listeners nobody can account for, at the moment the document goes.
   *
   * Reaching here means the document is UNLEASED, so any `'change'` listener
   * beyond the repo's baseline and the ambient sweep tracker belongs to a
   * component watching a document it never leased; it will stay attached to a
   * dropped handle and never fire again. The read-model health signal cannot
   * see this (`observed_generation` only advances from inside the watcher), so
   * this census is the detector for the whole class.
   *
   * It has to run here, and only here: the projector deliberately watches
   * diagram documents without leasing them, so `watched ⊆ leased` only holds
   * right after `notifyBeforeEvict`, once deliberate watchers have detached. A
   * resident (snapshot-time) gauge would measure the design, not a defect.
   */
  private census(documentId: string, handle: DocHandle<unknown>): void {
    const unaccounted = this.unaccountedChangeListeners(documentId, handle)
    if (unaccounted <= 0) return

    const attached = unaccounted + REPO_BASELINE_CHANGE_LISTENERS + (this.ambientListeners.has(documentId) ? 1 : 0)
    const documentType = this.classify(handle)
    this.orphanedListenerEvictions += 1
    this.orphanedListenersByType[documentType] = (this.orphanedListenersByType[documentType] ?? 0) + 1

    // Throttled: one orphaning bug produces one line per evicted document,
    // potentially dozens in a single sweep.
    const now = Date.now()
    if (now - this.lastOrphanReportAt < 10_000) return
    this.lastOrphanReportAt = now
    console.warn(JSON.stringify({
      event: 'automerge.orphaned_listener_evicted',
      documentId,
      documentType,
      changeListeners: attached,
      unaccounted,
      totalOrphanedListenerEvictions: this.orphanedListenerEvictions,
    }))
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  async snapshot(): Promise<AutomergeResidencySnapshot> {
    // `cachedHandles`, NOT `syncedHandle`: this is the baseline the memory
    // soak compares against, so an under-report here shows a leak gate green.
    // One O(n) read on an admin/scrape path is the right trade.
    const handles = Object.values(cachedHandles(this.repo))
    const byState: Record<string, number> = {}
    const byType: Record<string, number> = {}
    const leasedByWorkspaceSets = new Map<string, Set<DocumentId>>()
    const documentsByType = new Map<AutomergeDocumentType, Set<DocumentId>>()
    let leaseOwners = 0

    // No resident `watched ⊆ leased` gauge here, deliberately — see `census`.
    // Watched-and-unleased is the NORMAL state of every resident diagram
    // document.
    for (const handle of handles) {
      recordCount(byState, handle.state)
    }
    for (const [documentId, lease] of this.leases) {
      const documentTypes = new Set<AutomergeDocumentType>()
      for (const owner of lease.owners.values()) {
        leaseOwners += 1
        documentTypes.add(owner.documentType)
        let typeIds = documentsByType.get(owner.documentType)
        if (!typeIds) {
          typeIds = new Set()
          documentsByType.set(owner.documentType, typeIds)
        }
        typeIds.add(documentId)
        let ids = leasedByWorkspaceSets.get(owner.workspace)
        if (!ids) {
          ids = new Set()
          leasedByWorkspaceSets.set(owner.workspace, ids)
        }
        ids.add(documentId)
      }
      for (const documentType of documentTypes) recordCount(byType, documentType)
    }
    const leasedByWorkspace = Object.fromEntries(
      [...leasedByWorkspaceSets].map(([workspace, ids]) => [workspace, ids.size]),
    )
    const durableChunkBytesByWorkspace = Object.fromEntries(
      [...leasedByWorkspaceSets].map(([workspace, ids]) => [
        workspace,
        this.storageProbe?.snapshot([...ids]).trackedChunkBytes ?? 0,
      ]),
    )
    const durableChunkBytesByType = Object.fromEntries(
      [...documentsByType].map(([documentType, ids]) => [
        documentType,
        this.storageProbe?.snapshot([...ids]).trackedChunkBytes ?? 0,
      ]),
    )
    const storage = this.storageProbe?.snapshot(handles.map((handle) => handle.documentId)) ?? {
      trackedDocuments: 0,
      trackedChunkBytes: 0,
    }
    return {
      generatedAt: new Date().toISOString(),
      processBootId: currentProcessBootId(),
      handles: handles.length,
      leasedDocuments: this.leases.size,
      leaseOwners,
      protectedDocuments: this.protectedIds.size,
      evictedDocuments: this.evictedDocuments,
      evictionSkippedActivePeer: this.evictionSkippedActivePeer,
      evictionSkippedStaleHandle: this.evictionSkippedStaleHandle,
      orphanedListenerEvictions: this.orphanedListenerEvictions,
      orphanedListenersByType: { ...this.orphanedListenersByType },
      byState,
      byType,
      leasedByWorkspace,
      durableChunkBytesByWorkspace,
      durableChunkBytesByType,
      residentDurableChunkBytes: storage.trackedChunkBytes,
      residentDurableBytesTrackedDocuments: storage.trackedDocuments,
      processMemory: process.memoryUsage(),
    }
  }

  /**
   * Expensive, platform-admin-only runtime diagnostic. Unlike `snapshot()`,
   * this intentionally inspects already-materialized documents and their
   * synchronizer metrics so a high-memory incident can be attributed to a
   * bounded document type without exposing document, peer, user or workspace
   * identifiers.
   */
  runtimeSnapshot(): AutomergeRuntimeSnapshot {
    const documents = this.repo.metrics().documents
    const byType: Record<string, AutomergeRuntimeTypeSnapshot> = {}
    // Cache authority again, and free: `repo.metrics()` above is already O(n).
    const handles = Object.values(cachedHandles(this.repo))
    for (const handle of handles) {
      const type = handle.state === 'ready'
        ? classifyAutomergeDocument(handle.doc())
        : 'unknown'
      const metrics = documents[handle.documentId]
      const peers = metrics?.peers.length ?? 0
      const numOps = metrics?.size.numOps ?? 0
      byType[type] ??= {
        handles: 0,
        activePeerDocuments: 0,
        peerReferences: 0,
        numOps: 0,
        maxDocumentOps: 0,
        numChanges: 0,
        durableChunkBytes: 0,
      }
      const bucket = byType[type]
      // `bucket` is a per-type tally in this snapshot, not a Repo. The rule
      // keys on the property NAME, so it cannot tell; saying so here is
      // cheaper than narrowing the rule and letting an aliased `repo` through.
      // eslint-disable-next-line no-restricted-syntax
      bucket.handles += 1
      bucket.activePeerDocuments += peers > 0 ? 1 : 0
      bucket.peerReferences += peers
      bucket.numOps += numOps
      bucket.maxDocumentOps = Math.max(bucket.maxDocumentOps, numOps)
      bucket.numChanges += metrics?.size.numChanges ?? 0
      bucket.durableChunkBytes += this.storageProbe?.snapshot([handle.documentId]).trackedChunkBytes ?? 0
    }
    return {
      generatedAt: new Date().toISOString(),
      handles: handles.length,
      byType,
      processMemory: process.memoryUsage(),
    }
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise)
    void promise
      .catch((error) => console.warn('[automerge-residency] eviction failed', error))
      .finally(() => this.pending.delete(promise))
  }
}
