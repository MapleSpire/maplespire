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

import {
  Repo,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  interpretAsDocumentId,
  type BinaryDocumentId,
  type DocHandle,
  type AutomergeUrl,
  type DocumentId,
  type PeerId,
} from '@automerge/automerge-repo'
import { from as automergeFrom, save as automergeSave } from '@automerge/automerge'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import type {
  RootDoc,
  ModelDoc,
  DiagramDoc,
  RegistryShard,
  ModelMeta,
  ObjectShard,
  ConnectionShard,
} from './types'
import {
  DEFAULT_WORKSPACE_REF,
  CURRENT_VERSION_ID,
  currentWorkspaceRef,
  isDefaultWorkspaceRef,
  workspaceRefKey,
  type WorkspaceRef,
} from './workspace'
import { clonePlain } from './reconcile'
import { takeMintedDocumentIdBytes } from './mintedIdSupply'
import { rememberResolvedWorkspace } from './workspaceBinding'
import { WorkspaceNetworkRouter } from './networkRoute'
import { apiFetch } from '../api/http'
import { resolveInBatches } from './batchedResolve'
import { ceilingScheduleMs, resolveReadyHandleWithRetry, WAIVER_BUDGET_MS } from './handleRetry'
import { BOOT_RESOLVE_MAX_MS } from './progressBudget'
import { ActiveDocumentShare } from './activeDocumentShare'
import { serializeAutomergeDocumentMessages } from './serializeMessages'
import { AdaptiveWebSocketClientAdapter } from './adaptiveWebSocketClientAdapter'
import { repoPeerAwareness } from './peerAwareness'
import { createWaiverAllocation, type WaiverAllocation } from './waiverBudget'
import { mayUseCachedRootAfter, resolveRootUrlWithRetry, WorkspaceRootHttpError } from './rootFetchPolicy'

import { API_BASE } from '../api/base'
const WS_URL = import.meta.env.VITE_AUTOMERGE_URL || (typeof window === 'undefined'
  ? 'ws://127.0.0.1/automerge'
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/automerge`)

/**
 * The client Automerge repo: syncs over a WebSocket to our server peer and
 * persists locally in IndexedDB (offline-first for free). All document access in
 * the app goes through this repo.
 *
 * IndexedDB remains a backward-compatible offline cache, but cached documents
 * are not all replayed on reconnect. The active workspace explicitly leases the
 * root, metadata, shards and active/dirty diagram that it needs to announce.
 * `access: true` still lets a cold client request any authorized document by id.
 */
export const activeDocumentShare = new ActiveDocumentShare()

export const repo = new Repo({
  // Network is attached lazily by getRootHandle(), once the target workspace
  // is known. IndexedDB remains available immediately for offline boot.
  network: [],
  ...(typeof indexedDB !== 'undefined'
    ? { storage: new IndexedDBStorageAdapter('maplespire-automerge') }
    : {}),
  shareConfig: activeDocumentShare.shareConfig,
})
serializeAutomergeDocumentMessages(repo.synchronizer)
activeDocumentShare.bindLeaseChanged((documentIds) => {
  type TargetSynchronizer = {
    hasPeer(peerId: PeerId): boolean
    beginSync?: (peerIds: PeerId[]) => Promise<void>
    endSync?: (peerId: PeerId) => void
  }
  const synchronizers = (repo.synchronizer as unknown as {
    docSynchronizers: Record<DocumentId, TargetSynchronizer>
  }).docSynchronizers
  // Re-evaluate the collection-level policy first. Manipulating an existing
  // per-document synchronizer is insufficient for a cold document: repo.find()
  // may have created its handle after the lease changed, while the collection
  // synchronizer still holds the earlier "do not announce" decision.
  repo.shareConfigChanged()
  for (const documentId of documentIds) {
    const synchronizer = synchronizers[documentId]
    if (!synchronizer) continue // a later repo.find() evaluates the live policy
    // 2.6 reevaluates every peer inside shareConfigChanged(). The direct
    // begin/end calls only exist on 2.5 and remain as a compatibility path.
    if (!synchronizer.beginSync || !synchronizer.endSync) continue
    for (const peerId of repo.peers) {
      if (activeDocumentShare.isPinned(documentId)) {
        if (!synchronizer.hasPeer(peerId)) void synchronizer.beginSync([peerId])
      } else if (synchronizer.hasPeer(peerId)) {
        synchronizer.endSync(peerId)
      }
    }
  }
})

const workspaceNetwork = new WorkspaceNetworkRouter(
  repo.networkSubsystem,
  (url) => new AdaptiveWebSocketClientAdapter(url),
  WS_URL,
)

/** Route seam: tests of getRootHandle against the REAL module repo must keep
 * the network adapter detached — with an adapter attached and no peer
 * connected, `repo.find()` never settles, which turns every
 * fast unit rejection into a wall-clock hang. Production always delegates to
 * the real router. */
type WorkspaceNetworkRoute = (ref: WorkspaceRef, force: boolean) => Promise<void>
const productionWorkspaceNetworkRoute: WorkspaceNetworkRoute = (ref, force) =>
  workspaceNetwork.route(ref, force)
let workspaceNetworkRoute: WorkspaceNetworkRoute = productionWorkspaceNetworkRoute
export function __setWorkspaceNetworkRouteForTest(route: WorkspaceNetworkRoute | null): void {
  workspaceNetworkRoute = route ?? productionWorkspaceNetworkRoute
}

export function routeWorkspaceNetwork(ref: WorkspaceRef, force = false): Promise<void> {
  return workspaceNetworkRoute(ref, force)
}

/** Make one explicit `find()` eligible for synchronization without announcing
 * every document already present in IndexedDB. The lease lasts for the active
 * workspace session and is cleared on switch/bridge stop. */
export function prepareDocumentRequest(url: AutomergeUrl, role = 'requested'): void {
  activeDocumentShare.pin(parseAutomergeUrl(url).documentId, role)
}

// DEV/E2E: deterministically flush all pending Automerge changes to IndexedDB. Offline tests
// (no server to confirm against) call this before reloading to prove LOCAL durability.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __repoFlush?: () => Promise<void> }).__repoFlush = async () => {
    // Best-effort: offline, some handles can be in a non-ready state whose .doc() throws inside
    // repo.flush(); swallow so the test's durability wait still proceeds.
    try {
      await repo.flush()
    } catch (e) {
      console.warn('[repo] flush partial (offline handles)', e)
    }
  }
  // E2E probe (repoint-offline-create.spec.ts): decode the REAL id behind any
  // automerge url via the production parser, so the "this document is minted"
  // assertion rests on neither a length heuristic nor a store shortcut.
  // {bytes: 24, v0: 1} = a version-1 minted id.
  ;(window as unknown as { __docIdInfo?: (url: string) => { bytes: number; v0: number } }).__docIdInfo =
    (url: string) => {
      const { binaryDocumentId } = parseAutomergeUrl(url as AutomergeUrl)
      return { bytes: binaryDocumentId.length, v0: binaryDocumentId[0] ?? -1 }
    }
}

// Root/model handles are resolved and cached PER workspace (landscapeId,versionId).
const rootHandlePromises = new Map<string, Promise<DocHandle<RootDoc>>>()
const modelHandlePromises = new Map<string, Promise<DocHandle<ModelDoc>>>()

/**
 * Resolution budget for the BOOT-CRITICAL documents (root, registry shards,
 * ModelMeta): a boot frozen on one of these is a bricked app, so the allowance
 * is a WALL CLOCK before the bridge's resident fallback takes over.
 *
 * The figure is DERIVED, never typed. The wall CLAMPS the last escalating
 * window, so a budget shorter than the schedule it contains silently shortens
 * a window that a large queued document depends on (with eight concurrent
 * joiners on a 3 000-diagram landscape, five of eight boots died at 20 s and
 * none at 22 s). So the budget is `ceilingScheduleMs(...) + WAIVER_BUDGET_MS`,
 * computed from the fields below:
 *
 *   ceiling schedule  3 000 + 500 + 6 000 + 500 + 12 000 = 22 000 ms
 *   waiver allowance                                     +  2 000 ms
 *   ------------------------------------------------------------------
 *   budgetMs                                            =  24 000 ms
 *
 * `bootDocumentResolution.test.ts` asserts the relation, so raising
 * `findTimeoutMs` moves the budget with it.
 *
 * These documents are not necessarily small: registry shards can be several
 * MB and the sync server serves them ONE AT A TIME, so a 3 s window routinely
 * expires on a large shard. `npm run fsck` prints `bootCriticalBytes` and
 * `largestBootDocumentBytes` per workspace.
 *
 * The two allowances answer different questions:
 *
 *  - `tries` bounds the attempts that carried INFORMATION. A connected peer
 *    that answers "I do not have this document" says the same thing the
 *    fortieth time; retrying past three only delays the bridge's cached-root
 *    fallback, which is the recovery that works there.
 *  - `budgetMs` bounds the WALL. A rejection that arrives while the socket is
 *    still handshaking carries no information, is not counted against
 *    `tries`, and is bounded by this clock alone.
 *
 * `peers` is what makes that waiver possible: it tells a rejection from a
 * freshly routed, still-handshaking socket apart from a real verdict.
 *
 * A fired ceiling never evicts the pending query: on a serial server it means
 * the document is QUEUED, and evicting throws the request away (see
 * `handleRetry`).
 */
const BOOT_DOCUMENT_TRIES = 3
const BOOT_DOCUMENT_DELAY_MS = 500
const BOOT_DOCUMENT_FIND_TIMEOUT_MS = 3_000

/**
 * ONE waiver allowance for a whole boot.
 *
 * `BOOT_DOCUMENT_RESOLUTION` can reach ~18 documents (1 root + registry
 * shards + 1 ModelMeta), one `resolveReadyHandleWithRetry` call each. With a
 * per-call allowance and a waiver that can arm on a RECONNECTION, an
 * unreachable server would cost 18 × 2 000 = 36 s of hourglass.
 *
 * A FACADE over a swappable epoch, not the allocation itself, because
 * `BOOT_DOCUMENT_RESOLUTION` is a module const: a direct reference could never
 * be refilled, and an allowance spent once at the first boot of a session
 * would leave every later boot with nothing. `resetBootWaiverAllocation()`
 * swaps the epoch behind the facade.
 *
 * Refilled at each new ROOT resolution — a memo miss in `getRootHandle`, which
 * is exactly "a boot for this workspace starts", and which a failed boot's
 * `forgetWorkspaceHandles` re-arms so the failure panel's Retry button gets a
 * full allowance. Two workspaces booting at once would share one epoch and the
 * second's refill would top the first back up; that can only ever GIVE time,
 * never take it, and `budgetMs` bounds the resolution regardless.
 */
let bootWaiverEpoch: WaiverAllocation = createWaiverAllocation()
export function resetBootWaiverAllocation(): void {
  bootWaiverEpoch = createWaiverAllocation()
}
const bootWaiver: WaiverAllocation = {
  remainingMs: () => bootWaiverEpoch.remainingMs(),
  spend: (ms: number) => bootWaiverEpoch.spend(ms),
}

/**
 * What `budgetMs` means: it is counted not from the request but from the last
 * moment the sync transport was caught DELIVERING, and `maxBudgetMs` is the
 * absolute wall underneath (`progressBudget.ts` carries the derivation).
 *
 * A boot-critical document's wait is not its own transfer. `resolveInBatches`
 * issues registry shards three at a time and the sync server generates sync
 * messages for one document at a time, so a batch of multi-MB shards is served
 * serially while all three schedules run — plus every other joiner's turn on
 * the same server. A fixed wall from the request would abandon a document
 * while its bytes are still arriving.
 *
 * So there are three questions, each bounded by the one thing that can bound
 * it:
 *
 *  - `tries`      — how many INFORMATIVE answers. A connected peer saying "I
 *                   do not have this" says it the same way the fortieth time.
 *  - `budgetMs`   — how long the server may be QUIET. A silent server fails
 *                   this boot in 24 s.
 *  - `maxBudgetMs`— how long a boot may take even while the server is visibly
 *                   working. The safety net, never the operative bound; when
 *                   it fires, `progressTelemetry.hardCapped` counts it,
 *                   because the problem is then the deployment, not the client.
 */
export const BOOT_DOCUMENT_RESOLUTION = {
  budgetMs: ceilingScheduleMs(BOOT_DOCUMENT_TRIES, BOOT_DOCUMENT_FIND_TIMEOUT_MS, BOOT_DOCUMENT_DELAY_MS)
    + WAIVER_BUDGET_MS,
  maxBudgetMs: BOOT_RESOLVE_MAX_MS,
  tries: BOOT_DOCUMENT_TRIES,
  delayMs: BOOT_DOCUMENT_DELAY_MS,
  findTimeoutMs: BOOT_DOCUMENT_FIND_TIMEOUT_MS,
  peers: repoPeerAwareness(repo),
  waiver: bootWaiver,
} as const

// The shared root url is the SAME for every client and effectively immutable for a workspace,
// so we cache it. Without the cache, boot does an HTTP fetch to the server FIRST — which makes
// the whole app fail to start OFFLINE (the repo never gets a url to load the locally-cached
// root doc from IndexedDB). With the cache, a warm client boots fully offline.
const ROOT_URL_CACHE_KEY = 'maplespire:rootUrl'

/** localStorage key for a workspace's root url. The DEFAULT workspace keeps the
 * legacy key so warm OFFLINE boot for existing installs is byte-identical; other
 * workspaces get a per-ref key. */
function rootUrlCacheKey(ref: WorkspaceRef): string {
  return isDefaultWorkspaceRef(ref) ? ROOT_URL_CACHE_KEY : `${ROOT_URL_CACHE_KEY}:${workspaceRefKey(ref)}`
}

function readCachedRootUrl(ref: WorkspaceRef): AutomergeUrl | null {
  try {
    const v = localStorage.getItem(rootUrlCacheKey(ref))
    return v && isValidAutomergeUrl(v) ? (v as AutomergeUrl) : null
  } catch {
    return null
  }
}

/** Record a root url in the offline cache. Called from getRootHandle only after
 * the root DOCUMENT materialized locally — never from the url fetch. Caching an
 * unmaterialized root poisons the boot fallback: after a set-default repoint the
 * url fetch succeeds instantly with the NEW root while its graph may never
 * arrive (server still warming up), and overwriting the cache at that point
 * destroys the only locally-bootable root this workspace key has. */
function rememberMaterializedRootUrl(ref: WorkspaceRef, url: AutomergeUrl): void {
  try {
    localStorage.setItem(rootUrlCacheKey(ref), url)
  } catch {
    /* private mode / quota — non-fatal, just no offline cache */
  }
}

/** The last root url a resolution ATTEMPTED for a ref (materialized or not) —
 * the boot fallback compares it to the cached one so it never "falls back" to
 * the very root that just failed. */
const lastAttemptedRootUrls = new Map<string, AutomergeUrl>()

/** One-shot: the NEXT root resolution for `ref` uses the cached (last
 * materialized) root without asking the server — the boot fallback's re-entry
 * path. Consumed by fetchRootUrl; nothing is persisted, so the reload after
 * asks the server again (the fallback stays silently reversible). */
const preferCachedRootRefs = new Set<string>()
export function preferCachedRootForNextResolve(ref: WorkspaceRef): void {
  preferCachedRootRefs.add(workspaceRefKey(ref))
}

/** Drop an UNCONSUMED one-shot cached-root preference: the boot
 * fallback arms it just before re-entering startBridge, and a re-entry that
 * dies BEFORE fetchRootUrl runs (route failure, an earlier boot step) would
 * otherwise leave it armed — the next, unrelated resolve for the same ref
 * would then silently boot from the cache instead of asking the server.
 * Deleting a missing key is a no-op, so the bridge's terminal error path
 * calls this unconditionally. */
export function abandonPreferredCachedRoot(ref: WorkspaceRef): void {
  preferCachedRootRefs.delete(workspaceRefKey(ref))
}

/** The boot fallback's inputs (see shouldFallBackToCachedRoot). */
export function cachedRootUrlFor(ref: WorkspaceRef): string | null {
  return readCachedRootUrl(ref)
}
export function lastAttemptedRootUrlFor(ref: WorkspaceRef): string | null {
  return lastAttemptedRootUrls.get(workspaceRefKey(ref)) ?? null
}

/** Wall-clock ceiling on each boot-critical HTTP fetch: a request
 * the server accepts but never answers would otherwise hold the boot pipeline
 * hostage exactly like an unanswered `repo.find()`. The resulting TimeoutError
 * is classified like a transport failure — `resolveRootUrlWithRetry` does not
 * re-enter its loop for it (10s are already spent; another round trip only
 * delays the IndexedDB fallback) and `mayUseCachedRootAfter()` keeps the
 * cached/offline root available — so the timeout stays TRANSIENT, never
 * authoritative. Mirrored (not imported) by modelQuery/diagramRender.ts. */
const BOOT_HTTP_TIMEOUT_MS = 10_000

/** Root-url fetch test seam. Tests pin the cache contract against the REAL
 * fetchRootUrl/getRootHandle: a 200 from here must never touch the offline
 * root-url cache — only materialization may. */
type RootUrlFetch = (endpoint: string, init: { signal: AbortSignal }) => Promise<Response>
const productionRootUrlFetch: RootUrlFetch = (endpoint, init) => apiFetch(endpoint, init)
let rootUrlFetch: RootUrlFetch = productionRootUrlFetch
export function __setRootUrlFetchForTest(fetchImpl: RootUrlFetch | null): void {
  rootUrlFetch = fetchImpl ?? productionRootUrlFetch
}

/** Fetch a workspace's root document URL from the server, caching it so a warm
 * client can boot OFFLINE: if the server is unreachable we fall back to the
 * last-known url and the repo loads the root (and all docs) from IndexedDB. Only a
 * cold first-ever boot truly needs the server.
 *
 * A transient 5xx (server mid-boot / read model warming up after a repoint)
 * gets a short bounded retry BEFORE the cached fallback — the same route
 * typically answers 200 a few seconds later.
 *
 * The DEFAULT workspace keeps the legacy HTTP endpoint; a non-default ref carries its identity as query params. WebSocket
 * routing is stricter: every network adapter is always scoped to one ref. */
async function fetchRootUrl(ref: WorkspaceRef = DEFAULT_WORKSPACE_REF): Promise<AutomergeUrl> {
  const key = workspaceRefKey(ref)
  if (preferCachedRootRefs.delete(key)) {
    const cached = readCachedRootUrl(ref)
    if (cached) {
      console.warn('[repo] boot fallback: resolving the last locally materialized root for', key)
      lastAttemptedRootUrls.set(key, cached)
      return cached
    }
  }
  const endpoint = isDefaultWorkspaceRef(ref)
    ? `${API_BASE}/api/automerge/root`
    : `${API_BASE}/api/automerge/root?landscapeId=${encodeURIComponent(ref.landscapeId)}&versionId=${encodeURIComponent(ref.versionId)}`
  try {
    const url = await resolveRootUrlWithRetry(async () => {
      // No caller passes a signal of its own into this fetch, so there is
      // nothing to compose (use AbortSignal.any if one ever does).
      const res = await rootUrlFetch(endpoint, { signal: AbortSignal.timeout(BOOT_HTTP_TIMEOUT_MS) })
      if (!res.ok) throw new WorkspaceRootHttpError(res.status)
      const body = (await res.json()) as {
        url: string
        landscapeId?: string | null
        versionId?: string | null
      }
      const { url } = body
      if (!isValidAutomergeUrl(url)) throw new Error(`Server returned invalid root url: ${url}`)
      // The CONCRETE workspace this ref just resolved to. It is the only thing a
      // `'current'` tab can later compare the socket's binding against, and the
      // server already computed it to answer this very request. A
      // server that does not send it leaves the detector unarmed rather than
      // wrong — `rememberResolvedWorkspace` ignores a null.
      if (body.landscapeId && body.versionId) {
        rememberResolvedWorkspace(ref, { landscapeId: body.landscapeId, versionId: body.versionId })
      }
      return url as AutomergeUrl
    })
    lastAttemptedRootUrls.set(key, url)
    return url
  } catch (err) {
    if (!mayUseCachedRootAfter(err)) throw err
    const cached = readCachedRootUrl(ref)
    if (cached) {
      console.warn('[repo] root url fetch failed; using cached url for offline boot', err)
      lastAttemptedRootUrls.set(key, cached)
      return cached
    }
    throw err
  }
}

/**
 * Resolve (once per workspace) the shared root document handle.
 *
 * The default ref is the ACTIVE workspace, not `DEFAULT_WORKSPACE_REF`. This
 * function also ROUTES THE NETWORK, so resolving the wrong ref would re-point
 * the app's only sync socket at another landscape for the rest of the session.
 */
export function getRootHandle(ref: WorkspaceRef = currentWorkspaceRef()): Promise<DocHandle<RootDoc>> {
  const key = workspaceRefKey(ref)
  let promise = rootHandlePromises.get(key)
  if (!promise) {
    // A memo MISS is a boot starting: refill the allowance the whole boot set
    // shares. Here rather than in the bridge because this is the narrowest
    // place that means "the root is being resolved afresh", and because
    // `forgetWorkspaceHandles` (used by the failure panel's Retry) clears the
    // memo, so a retry gets a full allowance.
    resetBootWaiverAllocation()
    promise = (async () => {
      await routeWorkspaceNetwork(ref)
      const url = await fetchRootUrl(ref)
      prepareDocumentRequest(url, 'root')
      const handle = await resolveReadyHandleWithRetry<RootDoc>(repo, url, BOOT_DOCUMENT_RESOLUTION)
      // Only NOW is the url worth caching: the offline/boot fallback boots from
      // this cache, so it must only ever name a root this browser has actually
      // materialized (see rememberMaterializedRootUrl).
      rememberMaterializedRootUrl(ref, url)
      return handle
    })()
    rootHandlePromises.set(key, promise)
  }
  return promise
}

/** Resolve a workspace's ModelDoc handle: read the modelUrl from its root, then
 * find the document. Cached per workspace so the same handle is returned for all
 * callers. */
export function getModelHandle(ref: WorkspaceRef = currentWorkspaceRef()): Promise<DocHandle<ModelDoc>> {
  const key = workspaceRefKey(ref)
  let promise = modelHandlePromises.get(key)
  if (!promise) {
    promise = (async () => {
      const rootHandle = await getRootHandle(ref)
      // Wait until the root has a valid modelUrl (server writes it at boot).
      let modelUrl: string | undefined
      for (let i = 0; i < 50; i++) {
        const doc = rootHandle.doc()
        modelUrl = doc?.modelUrl
        if (modelUrl && isValidAutomergeUrl(modelUrl)) break
        await new Promise<void>((res) => setTimeout(res, 100))
      }
      if (!modelUrl || !isValidAutomergeUrl(modelUrl)) {
        throw new Error(`Root doc does not have a valid modelUrl (got: ${String(modelUrl)})`)
      }
      prepareDocumentRequest(modelUrl, 'model')
      // Unbudgeted, peer-blind: see the note on getModelShardHandles for the
      // 9 min 33 s this can cost.
      return resolveReadyHandleWithRetry<ModelDoc>(repo, modelUrl)
    })()
    modelHandlePromises.set(key, promise)
  }
  return promise
}

/**
 * Drop a workspace's cached root/model handle promises so the NEXT resolve
 * re-fetches from the server. Called on workspace switch: `versionId ===
 * 'current'` is a moving pointer (set-default repoints it), so a stale
 * in-memory promise would otherwise serve the OLD default version's root.
 *
 * The PERSISTED offline root url is KEPT by default. It records only
 * MATERIALIZED roots (rememberMaterializedRootUrl) and every online resolve
 * asks the server first, so all the persisted url can ever do is serve the
 * last locally materialized root — exactly what the offline boot and the
 * cached-root boot fallback need; deleting it would disarm both on every
 * in-app switch. `dropPersistedRootUrl: true` is for
 * callers abandoning a ref on an AUTHORITATIVE failure (a dangling/forbidden
 * root — bridge's dangling-ref rebounds): keeping a dead root's url would let
 * the boot fallback later resurrect deleted content offline. Concrete
 * (non-'current') versions never have their url dropped: those roots only
 * rotate during integrity recovery, and their persisted URL stays an offline
 * fallback.
 */
export function forgetWorkspace(
  ref: WorkspaceRef,
  options: { dropPersistedRootUrl?: boolean } = {},
): void {
  forgetWorkspaceHandles(ref)
  if (options.dropPersistedRootUrl !== true) return
  if (ref.versionId !== CURRENT_VERSION_ID) return
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(rootUrlCacheKey(ref))
  } catch {
    /* ignore */
  }
}

/** Drop ONLY the in-memory root/model promises (a rejected promise stays cached
 * otherwise, and every later resolve returns the same rejection). Unlike
 * forgetWorkspace this never touches the persisted offline root url — the boot
 * fallback calls this precisely because it is about to boot FROM that url. */
export function forgetWorkspaceHandles(ref: WorkspaceRef): void {
  const key = workspaceRefKey(ref)
  rootHandlePromises.delete(key)
  modelHandlePromises.delete(key)
}

export async function findDiagramHandle(url: string): Promise<DocHandle<DiagramDoc>> {
  if (!isValidAutomergeUrl(url)) throw new Error(`Invalid diagram doc url: ${url}`)
  prepareDocumentRequest(url, 'active-diagram')
  // Unbudgeted, peer-blind (see getModelShardHandles).
  return resolveReadyHandleWithRetry<DiagramDoc>(repo, url)
}

// ── Minted naming ─────────────────────────────────────────────────────────────
// The four factories below name their documents with server-minted ids when
// the reserve holds one, so the sync gate can admit them by recomputing a MAC
// instead of walking the workspace graph (server/src/rbac/documentIdMint.ts).

/** DocumentIds this tab has already imported under a minted name. `repo.import`
 * with an EXISTING id silently MERGES histories (Repo.js) — the one
 * corruption this scheme can produce — so a repeated id falls back to a random
 * name instead. Cross-tab reuse is impossible by construction (the reserve
 * draws its block by atomic REMOVAL — mintedIdReserve.ts); this set only
 * guards a double-spend bug in THIS tab. Not `repo.handles`: that getter is
 * O(all cached queries) per call. */
const namedThisSession = new Set<string>()

/**
 * The naming core, parameterized on the target repo so tests can pin its
 * storage behaviour against an adapter-backed Repo (repo.namedCreate.test.ts).
 *
 * `import` is the only public synchronous API that accepts a docId, and it
 * joins the SAME `#ensureQuery` as `create` — registration, announce policy,
 * and the storage listener capturing the initial data (Repo.js) — so
 * an import-named document persists and syncs exactly like a created one.
 * The save→load costs one extra WASM round trip on a NASCENT document (an
 * empty shard, a new diagram) — never on a 10k-scale path.
 *
 * Returns null when the id was already spent this session; the caller falls
 * back to an ordinary random id. If a future automerge-repo version grows a
 * stable named-create API, this function is the single swap point.
 */
export function importDocumentNamed<T>(target: Repo, initial: T, bytes: Uint8Array): DocHandle<T> | null {
  const docId = interpretAsDocumentId(bytes as BinaryDocumentId)
  if (namedThisSession.has(docId)) {
    console.warn('[repo] minted id already used this session; using a random id', docId)
    return null
  }
  namedThisSession.add(docId)
  // Add BEFORE import, no rollback on throw: the id was already consumed from
  // the reserve (the take IS the removal), so a burned entry only ever blocks
  // re-presenting an id nothing can hand out again. The order is indifferent.
  return target.import<T>(automergeSave(automergeFrom(initial as Record<string, unknown>)), { docId })
}

/**
 * Create a document, named with a minted id when one is available. The
 * fallback is always safe — an unminted random id is a normal browser
 * document, and the gate's `unminted` verdict falls back to the durable index.
 * Rules, in order:
 *  1. Empty reserve → `repo.create` (never block a creation).
 *  2. Any exception on the minted path → warn + `repo.create` (the warn plus
 *     the supply stats keep it observable rather than silent).
 *  3. A session-repeated id → fallback, never `import`'s merge branch.
 *  4. Nothing swallows the FALLBACK's own failure: if `repo.create` throws on
 *     an invalid value, the error propagates.
 */
function createHandleNamed<T>(initial: T): DocHandle<T> {
  const bytes = takeMintedDocumentIdBytes()
  if (bytes) {
    try {
      const named = importDocumentNamed<T>(repo, initial, bytes)
      if (named) return named
    } catch (error) {
      console.warn('[repo] minted naming failed; using a random id', error)
    }
  }
  return repo.create<T>(initial)
}

export function createDiagramHandle(initial: DiagramDoc): DocHandle<DiagramDoc> {
  // Automerge validates the initial value and THROWS on any `undefined` — and a
  // store-built diagram can legitimately carry optional fields as present-but-
  // undefined (a new diagram in a workspace with no domains has `domainId:
  // undefined`). clonePlain deep-copies and drops those keys; it applies to the
  // minted path (`A.from`) and the fallback (`repo.create`) alike.
  const handle = createHandleNamed<DiagramDoc>(clonePlain(initial))
  activeDocumentShare.pin(handle.documentId, 'dirty-created')
  return handle
}

/** Resolve all registry shard handles from a workspace's root shardUrls list. */
export async function getRegistryShardHandles(
  ref: WorkspaceRef = currentWorkspaceRef()
): Promise<DocHandle<RegistryShard>[]> {
  const rootHandle = await getRootHandle(ref)
  // Poll until shardUrls is non-empty (server may still be booting).
  let shardUrls: string[] | undefined
  for (let i = 0; i < 50; i++) {
    const doc = rootHandle.doc()
    shardUrls = doc?.shardUrls
    if (shardUrls && shardUrls.length > 0) break
    await new Promise<void>((res) => setTimeout(res, 100))
  }
  if (!shardUrls || shardUrls.length === 0) {
    throw new Error('Root doc has no shardUrls after waiting')
  }
  return resolveInBatches(
    shardUrls,
    async (url) => {
      if (!isValidAutomergeUrl(url)) throw new Error(`Invalid shard url: ${url}`)
      prepareDocumentRequest(url, 'registry-shard')
      return resolveReadyHandleWithRetry<RegistryShard>(repo, url, BOOT_DOCUMENT_RESOLUTION)
    },
  )
}

export function createRegistryShardHandle(initial: RegistryShard): DocHandle<RegistryShard> {
  const handle = createHandleNamed<RegistryShard>(initial)
  activeDocumentShare.pin(handle.documentId, 'dirty-created')
  return handle
}

// ── Sharded model handles ──────────────────────────────────────────────────────
// Object/connection shards reuse the registry-shard resolution pattern exactly:
// each shard is an independent Automerge doc whose URL lives in the ModelMeta's
// objectShardUrls/connectionShardUrls; the full collection is the union of shards.

export async function findModelMetaHandle(url: string): Promise<DocHandle<ModelMeta>> {
  if (!isValidAutomergeUrl(url)) throw new Error(`Invalid modelMeta url: ${url}`)
  prepareDocumentRequest(url, 'model-shard')
  return resolveReadyHandleWithRetry<ModelMeta>(repo, url, BOOT_DOCUMENT_RESOLUTION)
}

// There is deliberately NO createModelMetaHandle: a browser-built ModelMeta
// could lack overlay write heads, a shape that silently eats edits. The one
// legal constructor is the server's `buildModelMeta` (server/src/modelMeta.ts),
// where the heads are mandatory.

export function createObjectShardHandle(initial: ObjectShard): DocHandle<ObjectShard> {
  const handle = createHandleNamed<ObjectShard>(initial)
  activeDocumentShare.pin(handle.documentId, 'dirty-created')
  return handle
}

export function createConnectionShardHandle(initial: ConnectionShard): DocHandle<ConnectionShard> {
  const handle = createHandleNamed<ConnectionShard>(initial)
  activeDocumentShare.pin(handle.documentId, 'dirty-created')
  return handle
}

/**
 * Resolve a list of shard URLs to ready handles in batches (mirrors
 * getRegistryShardHandles). Shared by object + connection shards.
 *
 * KNOWN LIMITATION — the MODEL path is unbudgeted and peer-blind.
 * `BOOT_DOCUMENT_RESOLUTION` covers only the root, the registry shards and
 * the ModelMeta. The model shards, the model monolith, the active diagram and
 * the overlay heads take the defaults: `tries: 20`, `findTimeoutMs: 8_000`,
 * `delayMs: 500`, no `budgetMs`, no `peers`.
 *
 * On a classic boot (`bootFromServer` off, which resolves every model shard
 * here), a single shard whose `find()` goes SILENT holds the pipeline for
 * `ceilingScheduleMs(20, 8_000, 500)` = 573 500 ms (9 min 33 s), and the boot
 * status never reaches `'error'`, so the user just sees the loading screen.
 *
 * Deliberately not narrowed: the boot-critical schedule gives a document at
 * most a 12 s uninterrupted window where these sites give 30 s, and the
 * largest model shard has not been measured against either. The figure is
 * pinned in `handleRetry.test.ts` ('names what an UNBUDGETED caller is really
 * asking for').
 */
export async function getModelShardHandles<T>(urls: readonly string[]): Promise<DocHandle<T>[]> {
  return resolveInBatches(urls, async (url) => {
    if (!isValidAutomergeUrl(url)) throw new Error(`Invalid model shard url: ${url}`)
    prepareDocumentRequest(url, 'model-shard')
    return resolveReadyHandleWithRetry<T>(repo, url)
  })
}
