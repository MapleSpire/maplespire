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

import type { Pool } from 'pg'
import type { DocHandle, Repo, AutomergeUrl } from '@automerge/automerge-repo'
import { isValidAutomergeUrl, interpretAsDocumentId } from '@automerge/automerge-repo'
import type { SealedRepo } from './sealedRepo.js'
import {
  noteServerCreationPlacement,
  purgeServerCreationPlacement,
} from './serverCreationPlacement.js'
import { ensureDefaultOrg } from '../auth/schema.js'
import { envNumber } from '../envNumber.js'
import {
  verifyDocumentId, verifyDocumentIdWithDisplacement, displacedScanTruncationsTotal,
  DISPLACED_SCAN_MAX_CANDIDATES,
} from './documentIdMint.js'
import { claimWorkspaceDocuments, CLAIM_BATCH_SIZE, type ClaimBatchResult } from './documentClaims.js'
import {
  coverWorkspace,
  invalidateWorkspaceCoverage,
  isWorkspaceCoveredCached,
  isWorkspaceCoveredLocally,
  noteCoverageGapLocally,
  readWorkspaceCoverageInvalidations,
} from './claimCoverage.js'
import { upsertOrgScope, upsertLandscapeScope, upsertVersionScope } from './schema.js'
import type { SessionClaims } from '../auth/tokens.js'
import type { MetricSample } from '../runtime/metrics.js'
import { enumerateMaintainableWorkspaces } from '../maintenance/maintainableWorkspaces.js'

/**
 * The workspace doc index (Automerge WebSocket auth + scoping).
 *
 * Doc creation is CLIENT-side (`repo.create()`), so we can't register a doc's
 * workspace "at creation" server-side. Instead this module walks the
 * root -> {model, modelMeta, registry shards} -> {object/connection shards,
 * edits overlays} -> {per-diagram docs} graph OUTWARD from each version's root,
 * and records every doc id it finds as belonging to that version's
 * `(landscapeId, versionId)`. The walk is:
 *
 *   - LAZY per-workspace: built on first need (resolveDocWorkspace miss,
 *     allowedWorkspaceKeys build), not eagerly for every version at boot — a
 *     platform can have thousands of versions and most connections touch one.
 *   - INCREMENTAL after the first walk: a 'change' listener on the root, the
 *     modelMeta doc, and every registry shard re-walks THAT workspace only,
 *     so a brand-new client-created doc (a new object shard, a new diagram)
 *     becomes servable the moment its parent link syncs to the server — this
 *     is the default-deny boundary: unlinked docs are simply absent from the
 *     index until their parent link appears, so `resolveDocWorkspace` returns
 *     null for them and the access gate denies (see wsAuth.ts / selectiveSync.ts).
 *
 * This module does NOT enforce anything itself — `resolveDocWorkspace` and
 * `allowedWorkspaceKeys` are read-only lookups that `selectiveSync.ts`'s
 * `accessCheck` composes into an allow/deny decision.
 */

export interface WorkspaceKey {
  landscapeId: string
  versionId: string
}

function keyOf(k: WorkspaceKey): string {
  return `${k.landscapeId}/${k.versionId}`
}

interface RootLike {
  modelUrl?: string
  modelMetaUrl?: string
  shardUrls?: string[]
  registrySummaryOnly?: boolean
}
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
}
interface RegistryShardLike {
  diagrams?: Record<string, { docUrl?: string }>
}

/**
 * Idempotent backfill: for every `versions` row (+ its landscape), upsert the
 * org/landscape/version scope rows under the landscape's OWNING org
 * (`landscapes.org_id`; the Default Org only for pre-backfill NULL rows — the
 * same target `ensureDefaultOrg` provides for every other pre-auth resource).
 * Registering under the owning org is a CORRECTNESS requirement,
 * not hygiene: a duplicate scope row for the same version under the Default
 * Org would let Default-Org members read another org's workspace through
 * `allowedWorkspaceKeys`' scope join. Safe to call on every boot:
 * `upsert*Scope` is idempotent.
 */
export async function ensureScopesForExistingWorkspaces(pool: Pool): Promise<void> {
  const defaultOrgId = await ensureDefaultOrg(pool)
  const { rows } = await pool.query<{ id: string; landscape_id: string; org_id: string | null }>(
    'SELECT v.id, v.landscape_id, l.org_id FROM versions v JOIN landscapes l ON l.id = v.landscape_id'
  )
  for (const row of rows) {
    await upsertVersionScope(pool, row.org_id ?? defaultOrgId, row.landscape_id, row.id)
  }
  // Also make sure every landscape has a scope even if (edge case) it has zero
  // versions yet — upsertLandscapeScope is cheap and idempotent.
  const { rows: landscapes } = await pool.query<{ id: string; org_id: string | null }>(
    'SELECT id, org_id FROM landscapes'
  )
  for (const l of landscapes) {
    await upsertLandscapeScope(pool, l.org_id ?? defaultOrgId, l.id)
  }
  // And the org scope itself, in case an org has no landscapes at all yet.
  await upsertOrgScope(pool, defaultOrgId)
}

/**
 * Registration callback module, injected into `landscapes.ts` to avoid an
 * import cycle (landscapes.ts -> docScope.ts -> ... -> landscapes.ts). Call
 * `registerWorkspaceCreation(fn)` once at boot (see automergeServer.ts) with a
 * function that both upserts the scope rows AND primes the doc index for a
 * newly created (landscapeId, versionId, rootUrl) — landscapes.ts calls the
 * resulting no-op-if-unset function after createLandscape/createVersion/
 * createDraft persist their root, so a freshly created workspace is
 * immediately scoped + indexed instead of waiting for the next resolve miss.
 */
export type WorkspaceRegistration = (args: { landscapeId: string; versionId: string; rootUrl: string }) => void
type WorkspaceDocumentsRegistration = (args: {
  landscapeId: string
  versionId: string
  rootUrl: string
  documentIds: string[]
}) => Promise<ClaimBatchResult>

let registration: WorkspaceRegistration | null = null
let documentsRegistration: WorkspaceDocumentsRegistration | null = null
const registrationObservers = new Set<WorkspaceRegistration>()

/**
 * Whether server-created documents will be CLAIMED when their publisher calls
 * `notifyWorkspaceDocumentsCreated`. False only where no `WorkspaceDocIndex`
 * has been constructed (DB-free tests), and the hook then returns `false`
 * without recording anything. Since 2026-10-16 every server boot constructs
 * one whatever the auth stage (automergeServer.ts § shareConfig); before that,
 * an AUTH=off boot with routing unset did not.
 *
 * `bootstrapMint.ts` reads this before naming a document with a
 * workspace-bound id: a minted id whose claim would never be recorded is the
 * one shape the minted-orphan reaper would later mistake for an orphan. So
 * minting and claiming are switched by the SAME fact, and neither can be on
 * while the other is off.
 */
export function hasWorkspaceDocumentsRegistration(): boolean {
  return documentsRegistration !== null
}

/** TEST SEAM for suites that need the bootstrap family to mint without
 *  constructing a `WorkspaceDocIndex` (which needs a live Postgres). The
 *  production registration is written once by that constructor; this replaces
 *  it and returns a restore function. */
export function setWorkspaceDocumentsRegistrationForTest(
  fn: ((args: { landscapeId: string; versionId: string; rootUrl: string; documentIds: string[] }) => Promise<ClaimBatchResult>) | null,
): () => void {
  const previous = documentsRegistration
  documentsRegistration = fn
  return () => { documentsRegistration = previous }
}

export function registerWorkspaceCreation(fn: WorkspaceRegistration): void {
  registration = fn
}

/** Register a freshly-created, already-durable child document before its
 * trusted parent publishes the URL. Server-side HTTP/MCP writers do not pass
 * through the sync listener that normally discovers client-created docs, so
 * they need this explicit default-deny admission boundary. */
export async function notifyWorkspaceDocumentCreated(args: {
  landscapeId: string
  versionId: string
  rootUrl: string
  documentId: string
}): Promise<void> {
  const { documentId, ...workspace } = args
  await notifyWorkspaceDocumentsCreated({ ...workspace, documentIds: [documentId] })
}

/**
 * The batch twin, for creators that mint MANY documents before one
 * publication (bootstrap, fork, seed, merge). One `claimWorkspaceDocuments`
 * round trip per 1,000 ids instead of one per document, and the in-process
 * `byDoc` is fed alongside, saving the same N `resolveDurable`s.
 *
 * Returns false when no doc index is registered (DB-free tests; every server
 * boot registers one since 2026-10-16), matching the walk, which does not run
 * in that mode either. The return value is the
 * caller's licence for the coverage marker: no claims recorded means no marker
 * may claim they were.
 *
 * Throws on `foreign` and on `missingVersion` with distinct messages: a claim
 * attempted before its `INSERT versions` is an ordering bug, not a collision
 * (the FK + anti-spoof derivation make that order structural, see
 * documentClaims.ts).
 */
export async function notifyWorkspaceDocumentsCreated(args: {
  landscapeId: string
  versionId: string
  rootUrl: string
  documentIds: string[]
}): Promise<boolean> {
  if (!documentsRegistration) return false
  if (args.documentIds.length === 0) return true
  const result = await documentsRegistration(args)
  if (result.missingVersion) {
    throw new Error(
      `cannot claim ${args.documentIds.length} document(s) for ${args.landscapeId}/${args.versionId}: `
      + 'no versions row exists — the claim must FOLLOW the INSERT INTO versions, never precede it',
    )
  }
  if (result.foreign.length > 0) {
    const sample = result.foreign[0]!
    throw new Error(
      `${result.foreign.length} document(s) are already assigned to another workspace `
      + `(first: ${sample.documentId} -> ${sample.winner.landscapeId}/${sample.winner.versionId})`,
    )
  }
  // The durable row has landed, so the fence now reads
  // `automerge_document_workspace` (the authority) and the in-memory
  // `serverCreationPlacement` is a stale copy. Purging on the claim rather than
  // on a timer avoids guessing how long a claim takes to land.
  //
  // After the throws, deliberately: a refused or aborted claim did not land, so
  // the placement must survive to fence later saves of that handle.
  //
  // Over what actually landed (`claimed ∪ alreadyOurs`), not over the request:
  // an id can reach here in neither set with both guards passing (winner row
  // GC'd between INSERT and SELECT, booked `unaccounted`), and purging it would
  // forget a placement whose durable row does not exist.
  purgeServerCreationPlacement([...result.claimed, ...result.alreadyOurs])
  return true
}

/**
 * Creation wrapper for documents added to an existing workspace: child durable
 * → claimed → and only THEN may the caller publish the parent link. The wrapper
 * makes the right order shorter to write than the wrong one. NOT for the
 * bootstrap family — there is no `versions` row yet at create time there;
 * bootstrap traces ids and claims at publication instead.
 *
 * It takes a `SealedRepo` (whose type has no `create`, so a document nobody
 * claims cannot be written by accident) and is one of the places that widens
 * back to `Repo` to create. Taking `Repo` instead would force every caller to
 * hold an unsealed repo just to use the safe wrapper.
 */
export async function createClaimedDocument<T>(
  repo: SealedRepo,
  workspace: WorkspaceKey,
  rootUrl: string,
  value: T,
): Promise<DocHandle<T>> {
  // A widening back to `Repo` (the list is in `sealedRepo.ts`). Safe because the
  // document is made durable, then claimed, before it is returned to anyone who
  // could publish a link to it.
  const handle = (repo as Repo).create<T>(value)
  // Record where this document belongs BEFORE anything can save it, so the
  // storage fence has a lease to check (nothing routes server-minted documents
  // through the route gate).
  //
  // Must stay synchronous and before any await: `repo.create()` schedules the
  // first save on a timer, so one await here (an audit write, a metrics call)
  // can let that save land first, unfenced. `workspaceWriter.ordering.seam.test.ts`
  // covers this with a repo whose `whenReady` defers by one macrotask.
  noteServerCreationPlacement(String(handle.documentId), workspace)
  await handle.whenReady()
  // Durable BEFORE claimed: a claim row for a document a crash then loses is
  // an admission of nothing (fsck's document-present would flag it); claimed
  // BEFORE the caller's parent link: a published link must never point at an
  // unclaimed document.
  await repo.flush([handle.documentId])
  // The return value is discarded deliberately: it is `false` only when no
  // document index is registered (DB-free tests), and in that mode the catalog walk
  // does not run either. So "claimed" here means "claimed wherever a document
  // index is registered". `landscapes.ts` does honour the boolean before writing
  // its coverage marker.
  await notifyWorkspaceDocumentsCreated({ ...workspace, rootUrl, documentIds: [String(handle.documentId)] })
  return handle
}

/** Subscribe an additional lifecycle consumer without replacing the primary
 * doc-index registration. Sync-cell ownership uses this to acquire a lease for
 * a newly-created version immediately; the periodic reconciliation remains the
 * durable fallback if the process misses the notification. */
export function observeWorkspaceCreation(fn: WorkspaceRegistration): () => void {
  registrationObservers.add(fn)
  return () => registrationObservers.delete(fn)
}

/** Called by landscapes.ts after persisting a new version's root. No-op until
 * `registerWorkspaceCreation` has been called (e.g. in tests that never
 * construct a WorkspaceDocIndex) — registration is best-effort. */
export function notifyWorkspaceCreated(args: { landscapeId: string; versionId: string; rootUrl: string }): void {
  // Every creation path funnels through this hook after its scope row is
  // durable. Drop this process's negative cache immediately; sibling server
  // processes receive the matching PostgreSQL notification installed by
  // ensureRbacSchema.
  invalidateAllowedWorkspaceKeysCache()
  registration?.(args)
  for (const observer of registrationObservers) observer(args)
}

interface WorkspaceEntry {
  key: WorkspaceKey
  rootUrl: string
  /** Lazily resolved once for the root document only. Static/read-model roots
   * are server-owned control-plane manifests and must never accept CRDT writes
   * from a browser; their mutable children remain client-writable. */
  serverManagedRoot: boolean | null
  /** docId -> true, for O(1) membership; rebuilt on every re-walk of this workspace. */
  docIds: Set<string>
  /** Handles we've attached 'change' listeners to, so re-walk doesn't double-attach. */
  watched: WeakSet<object>
  /** ONE re-walk listener for the whole workspace, shared by every document it
   * watches. A closure per handle would be equivalent to attach and impossible
   * to DETACH — `off(event, fn)` needs the identity — and detaching is what
   * keeps the eviction census honest (see `trackResidency`). Created lazily
   * because it closes over the entry it lives on. */
  onChange: (() => void) | null
  building: Promise<void> | null
  /** Bumped every time one of this workspace's CONTROL documents is evicted. A
   * walk that began before the current generation cannot have re-attached the
   * listener that eviction just orphaned, so a later caller must start a fresh
   * walk instead of joining that one — otherwise a repair silently "succeeds"
   * by returning the very walk whose listeners are already dead. */
  staleGeneration: number
  /** The generation `building` was started at. */
  buildingGeneration: number
  /** Trailing-edge single flight for the change-driven re-walk. `rewalkPending`
   * means "a control document changed since the running walk began"; the runner
   * loops until it clears, so a burst of M changes costs one walk plus at most
   * one more, and never M at once. See `coalescedRewalk`. */
  rewalkPending: boolean
  rewalkInFlight: Promise<void> | null
  /** False when the last walk could not read every control document (`walk()`
   * swallows read failures by design, so a partially-completed walk is
   * indistinguishable from a good one without this). A repair that lands here
   * must be treated as failed, or the workspace is memoized as repaired while
   * a control listener is still missing. */
  controlDocsComplete: boolean
}

interface WorkspaceDocIndexOptions {
  /** DB-free Repo tests may disable the durable registry. Production keeps it
   * enabled so access control and storage fencing share one assignment. */
  durable?: boolean
  /** Workspaces re-walked concurrently during stale recovery (see
   * `trackResidency`). Bounds fan-out, not total work — the pass drains. */
  staleRepairConcurrency?: number
  /** Injectable so tests can drive the repair rate limit deterministically
   * rather than sleeping through it. */
  clock?: () => number
  /** Injectable so a wedged-walk test does not have to wait the production
   * deadline. */
  staleRepairDeadlineMs?: number
  /** Injectable so a multi-batch walk is testable with a small fixture instead
   * of thousands of documents. Production always uses {@link CLAIM_BATCH_SIZE}. */
  claimBatchSize?: number
  /** Injectable so the wedged-flight release test does not wait the production
   * ceiling. Production always uses {@link VERIFIED_CLAIM_DEADLINE_MS}. */
  verifiedClaimDeadlineMs?: number
  /** Injectable so the background-retry tests do not wait the production
   * pause. Production always uses {@link VERIFIED_CLAIM_RETRY_BACKOFF_MS}. */
  verifiedClaimRetryBackoffMs?: number
}

/** The slice of AutomergeResidencyLeases this index needs. Structural so tests
 * can drive eviction without a Repo, and so docScope does not depend on the
 * residency module (which would be a cycle through automergeServer). */
export interface DocumentEvictionSource {
  /** `handle` is supplied by every caller, which is already holding it —
   * `repo.handles` is a getter that rebuilds a whole `Record` per access, and
   * this runs inside the evicting turn. */
  onBeforeEvict(listener: (documentId: string, handle?: DocHandle<unknown>) => void): () => void
}

const DEFAULT_STALE_REPAIR_CONCURRENCY = 4
/** After this many consecutive failures a workspace stops being retried, so a
 * permanently failing repair cannot be re-attempted on every resolve miss. */
export const MAX_STALE_REPAIR_FAILURES = 3

/** Local retries inside `coalescedRewalk` before it hands the workspace to the
 * scheduled repair. The fault it is retrying is a database one (that is the only
 * thing a walk rejects on), so it is usually transient and usually short —
 * 100/200/400 ms covers a failover without holding the sync thread. Deliberately
 * plain constants, not `Number(process.env...)`: a blank env var would parse to
 * NaN and silently disable the retry. */
export const REWALK_MAX_ATTEMPTS = 4
export const REWALK_RETRY_BASE_MS = 100
/** Leaf claims buffered per durable INSERT during a walk. Unbatched, the walk
 * costs one autocommit (= one WAL fsync) per leaf, ~4.3 ms/doc; batching
 * amortizes it ~1000x, and beyond 1,000 there is nothing left to win. Kept
 * moderate on purpose: the batch interval bounds how long a peer pushing a
 * document mid-walk waits for its claim, and the work lost when a flush
 * rejects. Defined next to the SQL it slices (documentClaims.ts); re-exported
 * here because the walk's batching contract is pinned against this name. */
export { CLAIM_BATCH_SIZE }
/** A repair walk that has not finished by now is assumed wedged — `repo.find()`
 * never times out on its own. See `walkWithinDeadline`. */
export const STALE_REPAIR_DEADLINE_MS = envNumber('DOC_SCOPE_REPAIR_DEADLINE_MS', {
  fallback: 15_000, minimum: 1, maximum: 600_000,
})
/** Per-document deadline inside a walk. Must stay below the whole-walk deadline
 * so one unreachable document fails alone instead of consuming the entire budget.
 *
 * That relation is asserted in `docScope.envKnobs.test.ts` over the DEFAULTS.
 * Nothing at runtime clamps one against the other if an operator inverts them
 * through the environment; the cost is bounded and visible (one unreachable
 * document consumes the whole walk budget, and the walk reports its deadline). */
export const WALK_FIND_TIMEOUT_MS = envNumber('DOC_SCOPE_FIND_TIMEOUT_MS', {
  fallback: 10_000, minimum: 1, maximum: 600_000,
})
/** Floor between repair passes. Passes are kicked off by resolve misses, which
 * any connected peer can produce at will, and a pass walks EVERY stale
 * workspace — including other tenants'. This keeps that rate bounded by the
 * clock rather than by inbound message volume. */
export const STALE_REPAIR_MIN_INTERVAL_MS = envNumber('DOC_SCOPE_REPAIR_MIN_INTERVAL_MS', {
  fallback: 5_000, minimum: 1, maximum: 3_600_000,
})

/** How often a gate FAULT (as opposed to a deny) may request a share-policy
 * re-evaluation. The fault may not be transient — a database that stays down
 * would otherwise turn every inbound document message into another full
 * fan-out, at exactly the moment the process can least afford it. */
const GATE_FAULT_REEVAL_MIN_INTERVAL_MS = envNumber('DOC_SCOPE_GATE_FAULT_INTERVAL_MS', {
  fallback: 5_000, minimum: 1, maximum: 3_600_000,
})

/** How long a landscape's version-id list stays cached for the displaced scan.
 * Short on purpose: within this window a version created by a concurrent
 * repoint is invisible to OTHER processes' scans (this process invalidates on
 * `notifyWorkspaceCreated`), and an id minted for it would transiently read
 * `foreign` instead of `displaced`. Repoints create versions rarely, and the
 * single-flight — not the TTL — is what absorbs a mismatch burst. Plain
 * literal, not `Number(process.env...)`: same NaN trap as above. */
export const LANDSCAPE_VERSIONS_TTL_MS = 3_000
/** Ceiling on the version-list SQL itself, so the single-flight map can never
 * memoize a promise that NEVER SETTLES (see the `docScope.gateLiveness.test.ts`
 * header): like `routeBackfills` and `entry.building`, it is evicted only on
 * rejection, and a wedged `pool.query` rejects never. The
 * deadline turns a hang into a rejection, the rejection clears the in-flight
 * entry, and the next mismatch retries. Plain literal — same NaN trap. */
export const LANDSCAPE_VERSIONS_QUERY_DEADLINE_MS = 5_000
/** Bound on distinct landscapes retained by the version-list cache. The key is
 * the ROUTE's landscape — server-assigned at upgrade, never peer-chosen — so
 * this bounds memory against fleet size, not against an attacker. */
const LANDSCAPE_VERSIONS_CACHE_MAX_ENTRIES = 5_000
/** Wall-clock ceiling on the whole displaced branch of the route gate (version
 * list + durable claim). The branch is SQL-only — tolerated on the admission
 * path, `resolveDocWorkspace` is the precedent — but the gate runs inside
 * per-socket FIFOs and share-policy resolution, where "slow" is "every message
 * behind me waits". Past the ceiling the branch REJECTS and `gateFault` turns
 * that into a fail-closed verdict plus a re-evaluation request: a verdict of
 * fault, never a hang and never an escaped exception. Injectable per gate
 * (`displacedScanDeadlineMs`) so the liveness table can drive it without
 * waiting two real seconds. Plain literal — same NaN trap. */
export const DISPLACED_SCAN_DEADLINE_MS = 2_000
/** Ceiling on ONE verified-claim flight (versions row + INSERT + winner
 * SELECT). The single-flight map is evicted in the starter's `finally`, which
 * only runs when the flight SETTLES — and a wedged `pool.query` settles never.
 * Unbounded, a stuck INSERT would pin a dead flight in the map for the life of
 * the process: every later presentation of that document joins it and is
 * denied, even after the pool recovers. The deadline turns the hang into a
 * rejection, the rejection runs the finally, and the next presentation starts a
 * FRESH flight. Plain literal — same NaN trap. */
export const VERIFIED_CLAIM_DEADLINE_MS = 5_000

/** Ceiling on the RBAC grant lookup — the last await on both gate chains. */
export const WORKSPACE_KEY_SETS_DEADLINE_MS = envNumber('DOC_SCOPE_KEY_SETS_DEADLINE_MS', {
  fallback: 5_000, minimum: 1, maximum: 600_000,
})
/** Pause before the ONE detached retry a ceiling-evicted claim flight earns.
 * Short on purpose: the eviction proved SQL was slower than the 5 s ceiling, so
 * retrying in the same tick re-queues onto the very pool that just wedged,
 * while anything longer needlessly delays the lift this retry provides
 * (otherwise ~30 s via the denyLedger's reconcile, or the reconnection). Plain
 * literal — same NaN trap. */
export const VERIFIED_CLAIM_RETRY_BACKOFF_MS = 500

/** The ceiling's OWN rejection, distinguishable from the wrapped work failing
 * or refusing. The distinction carries a decision: a flight evicted by its
 * ceiling reached NO verdict (retryable in the background — see
 * `scheduleVerifiedClaimRetry`), while a resolved `false` is a legitimate
 * first-owner-wins refusal and a plain SQL rejection already has its lift
 * (gateFault's re-evaluation + the denyLedger). Collapsing the three into one
 * error shape is what would make the background retry fire on refusals. */
class DeadlineExceededError extends Error {}

/** Reject `promise` after `ms` if it has not settled. The underlying work is
 * not cancelled — like `walkWithinDeadline`, this only stops the WAIT; a
 * late settlement lands on already-attached handlers and cannot become an
 * unhandled rejection. */
function settleWithinDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError(`${label} exceeded ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

const gateFaultLoggedAt = new Map<string, number>()

/**
 * Turn a gate fault into a fail-closed verdict that is not permanent.
 *
 * A gate that rejects is worse than one that denies. `stageAwareAccessCheck`
 * awaits the raw check, so a rejection escapes the "stage dual never enforces"
 * contract; and automerge-repo resolves the share policy once per (document,
 * peer), so whatever the library makes of a rejected policy promise is pinned
 * for the life of the socket. Deny, and ask for a re-evaluation so the deny
 * lasts only as long as the fault does. `syncWriteGate.ts` has always done this
 * per message — it could afford to, because its verdict is not cached.
 */
export type GateFaultReporter = (
  peerId: string,
  documentId: string,
  workspace: WorkspaceKey | null | undefined,
) => void

function gateFault(
  index: WorkspaceDocIndex,
  route: WorkspaceKey | null | undefined,
  gate: string,
  peerId: string,
  documentId: string,
  error: unknown,
  onFault: GateFaultReporter | undefined,
): false {
  const now = Date.now()
  const key = `${gate}/${documentId}`
  if (now - (gateFaultLoggedAt.get(key) ?? 0) >= 10_000) {
    if (gateFaultLoggedAt.size > 1_000) gateFaultLoggedAt.clear()
    gateFaultLoggedAt.set(key, now)
    console.warn(`[docScope] ${gate} gate failed for ${documentId} (denying, will re-evaluate):`, error)
  }
  index.requestShareReevaluation(route)
  // The caller cannot tell this `false` from a real refusal, and on an indexed
  // document it will classify it as a permanent RBAC denial. Say so here, while
  // the information still exists.
  try {
    onFault?.(peerId, documentId, route)
  } catch (reportError) {
    console.warn('[docScope] gate-fault reporter failed:', reportError)
  }
  return false
}

/** Bounded walk statistics for `/metrics`. A ring, not a growing array: this
 * counter is incremented on every watched document's change, so an unbounded
 * buffer would be a leak on exactly the busiest workspaces. */
const WALK_SAMPLE_CAPACITY = 512
const walkDurations: number[] = []
let walkCursor = 0
let walkTotal = 0
let walkTotalMs = 0

function recordDocScopeWalk(durationMs: number): void {
  walkTotal += 1
  walkTotalMs += durationMs
  if (walkDurations.length < WALK_SAMPLE_CAPACITY) walkDurations.push(durationMs)
  else {
    walkDurations[walkCursor] = durationMs
    walkCursor = (walkCursor + 1) % WALK_SAMPLE_CAPACITY
  }
}

/** Counts route-gate admissions that fell back to the durable index for an
 * UNMINTED id and found no row — the event browser-side id minting exists to
 * eliminate. Counted at the gate's miss site only (every occurrence, not only
 * the ones `noteRouteGateMiss` turns into a durable invalidation), never at the
 * upgrade pre-warm or a direct `scheduleWorkspaceRouteBackfill` call, so "zero
 * misses during creation/repoint" is measurable; `walks_total` cannot tell. */
let gateIndexMissTotal = 0
export function recordDocScopeGateMiss(): void {
  gateIndexMissTotal += 1
}
export function docScopeGateMissTotal(): number {
  return gateIndexMissTotal
}

/**
 * Provisional placements dropped by `PROVISIONAL_PLACEMENT_MAX_ENTRIES`.
 *
 * Process-lifetime and module-scoped, like the two counters above and for the
 * same reason: `docScopeMetricSamples()` is a module function with no index to
 * ask.
 *
 * Tests must read it as a DELTA across the work under test, never as an
 * absolute: nothing resets it, so an assertion on its value would depend on
 * test ORDER. The same applies to every counter in this module.
 */
let provisionalPlacementOverflowTotal = 0
export function recordProvisionalPlacementOverflow(): void {
  provisionalPlacementOverflowTotal += 1
}
export function provisionalPlacementOverflowsTotal(): number {
  return provisionalPlacementOverflowTotal
}

/** Snapshot for the metrics route. p99 over the retained window; the counters
 * are process-lifetime so a rate() over them is meaningful. */
export function docScopeWalkStats(): {
  total: number
  totalMs: number
  sampleCount: number
  p50Ms: number | null
  p99Ms: number | null
  maxMs: number | null
} {
  const sorted = [...walkDurations].sort((a, b) => a - b)
  const at = (q: number): number | null =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
  return {
    total: walkTotal,
    totalMs: Number(walkTotalMs.toFixed(3)),
    sampleCount: sorted.length,
    p50Ms: at(0.5),
    p99Ms: at(0.99),
    maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
  }
}

/** The /metrics samples this module owns, built HERE so their presence is
 * unit-testable (docScope.test.ts): nothing in CI mounts index.ts's /metrics
 * route, so a line that exists only inside it is covered by nothing —
 * removing one would surface first as a dashboard series silently going
 * absent. index.ts spreads these into its payload. */
export function docScopeMetricSamples(): MetricSample[] {
  const walk = docScopeWalkStats()
  return [
    {
      name: 'maplespire_docscope_walks_total',
      help: 'Reference walks performed since process start.',
      type: 'counter',
      values: [{ value: walk.total }],
    },
    {
      name: 'maplespire_docscope_walk_seconds_total',
      help: 'Cumulative time spent in the reference walk since process start.',
      type: 'counter',
      values: [{ value: Number((walk.totalMs / 1000).toFixed(6)) }],
    },
    {
      name: 'maplespire_docscope_walk_duration_seconds',
      help: 'Reference-walk duration over the retained sample window. NaN before any walk has run — absent data must not read as zero.',
      type: 'gauge',
      values: [
        { labels: { quantile: '0.5' }, value: walk.p50Ms === null ? Number.NaN : walk.p50Ms / 1000 },
        { labels: { quantile: '0.99' }, value: walk.p99Ms === null ? Number.NaN : walk.p99Ms / 1000 },
        { labels: { quantile: 'max' }, value: walk.maxMs === null ? Number.NaN : walk.maxMs / 1000 },
      ],
    },
    // walks_total cannot isolate route-gate misses (change-listener walks fire
    // on every edit, the pre-warm schedules on every socket, and the
    // routeBackfills memo dedupes the miss's schedule), so the misses are
    // counted at their own site.
    {
      name: 'maplespire_docscope_gate_misses_total',
      help: 'Route-gate admissions that had to consult the durable index for an unminted id and missed.',
      type: 'counter',
      values: [{ value: docScopeGateMissTotal() }],
    },
    // The observability half of the displaced-scan candidate ceiling: a
    // non-zero rate means some landscape's version list exceeds
    // DISPLACED_SCAN_MAX_CANDIDATES and its beyond-cut siblings read foreign.
    {
      name: 'maplespire_docscope_displaced_scan_truncations_total',
      help: 'Displaced scans whose candidate list exceeded DISPLACED_SCAN_MAX_CANDIDATES and was truncated to the newest candidates.',
      type: 'counter',
      values: [{ value: displacedScanTruncationsTotal() }],
    },
    // The witness for the storage fence's fail-open. A provisional placement
    // dropped by the ceiling returns that document to the unfenced admission,
    // so a non-zero rate here is the only signal distinguishing "the fence
    // checked a lease" from "there was nobody to check".
    {
      name: 'maplespire_docscope_provisional_placement_overflows_total',
      help: 'Provisional placements evicted by the ceiling; each one returns a document to the unfenced storage admission until its claim lands.',
      type: 'counter',
      values: [{ value: provisionalPlacementOverflowsTotal() }],
    },
  ]
}

/**
 * Ceiling on `provisionalPlacements`. One entry per document admitted on the
 * mint whose claim has not landed yet — `forgetProvisionalPlacement` removes it
 * the moment `claimDocument` learns a durable row — so the steady state IS
 * empty and the peak is one bulk import's burst, the largest measured being 36
 * documents. 4 096 is two orders above that and a few hundred kB. The steady
 * state is empty only because removal happens at the claim; eviction on the
 * fence's read alone would leave every entry in place (the fence stops asking
 * once the claim lands) and saturate the map.
 *
 * OVERFLOW FAILS OPEN, deliberately. Dropping the oldest entry returns that
 * document to unfenced admission rather than refusing writes for a document
 * whose only crime is that the process is busy — the fence exists to stop a
 * LEASELESS cell writing, not a healthy one, and refusing on memory pressure
 * would drop unrecoverable bytes. Observable via
 * `maplespire_docscope_provisional_placement_overflows_total`.
 */
const PROVISIONAL_PLACEMENT_MAX_ENTRIES = 4_096

/**
 * The doc->workspace index. One instance is constructed per server process
 * (automergeServer.ts) and shared by `resolveDocWorkspace` (access.ts's
 * `docScope` gate) and `allowedWorkspaceKeys` callers.
 */
export class WorkspaceDocIndex {
  private readonly repo: Repo
  private readonly pool: Pool
  private readonly durable: boolean
  /** workspaceKey string -> entry */
  private readonly byWorkspace = new Map<string, WorkspaceEntry>()
  /** docId -> workspaceKey string (reverse index for O(1) resolve). */
  private readonly byDoc = new Map<string, string>()
  /**
   * docId -> workspaceKey string, for documents this process has ADMITTED on
   * the mint but whose durable row does not exist yet.
   *
   * Not a second `byDoc`, and the difference is the whole point: `byDoc` is
   * what the index KNOWS (durable, first-owner-wins), this is what the route
   * gate has PROVISIONALLY decided one microtask ago and has not managed to
   * write down. Its single consumer is the storage fence, which without it
   * treats "no mapping row" as "no owner to check" and admits the mutation
   * unconditionally — including `removeRange`, which deletes every chunk of a
   * document. A freshly created document is exactly a document with no mapping
   * row, so the window the mint opened on the admission path is also a window
   * on the durability path.
   *
   * Insertion is SYNCHRONOUS and happens in the route gate's `bound` branch,
   * beside the unawaited claim it races. Removal happens in `claimDocument`
   * (via `forgetProvisionalPlacement`) as soon as it learns a durable row: from
   * then on the durable answer supersedes this one.
   */
  private readonly provisionalPlacements = new Map<string, string>()
  /** One bounded, manifest-only repair per routed workspace. Older workspaces
   * may have durable parent links created before the document-assignment
   * registry existed. After a process restart those leaf documents must be
   * admitted from the browser that still owns them without turning every
   * unknown protocol id into a platform-wide graph scan. */
  private readonly routeBackfills = new Map<string, Promise<void>>()
  /** documentId -> workspace key, for CONTROL documents only: the root, the
   * ModelMeta and the registry shards. Those are the documents whose 'change'
   * listener discovers new document references, so those are the only ones
   * whose eviction can orphan this index. Deliberately not `byDoc`, which holds
   * every document in the workspace — see `trackResidency`. */
  private readonly controlDocWorkspace = new Map<string, string>()
  /** Workspaces whose control-document watchers were orphaned by eviction. */
  private readonly staleWorkspaces = new Map<string, WorkspaceKey>()
  private readonly staleRepairFailures = new Map<string, number>()
  private staleRepairInFlight: Promise<void> | null = null
  private lastStaleRepairAt = Number.NEGATIVE_INFINITY
  private readonly routeBackfillAttemptedAt = new Map<string, number>()
  /** Consecutive failed route backfills per workspace; cleared on success and
   * whenever eviction marks the workspace stale (a fresh chance is exactly what
   * a residency change means). */
  private readonly routeBackfillFailures = new Map<string, number>()
  /** In-flight durable coverage invalidation per workspace, started when a route
   * gate records a coverage gap. The repair IIFE awaits it (already caught)
   * BEFORE reading its CAS witness, so the witness always observes the bump;
   * the GATE never awaits it. Entries self-delete on settle. */
  private readonly pendingCoverageInvalidations = new Map<string, Promise<unknown>>()
  /**
   * Called when the index ADMITTED something for a workspace — either a repair
   * restored its control documents, or an ordinary walk claimed a document that
   * was not indexed before.
   *
   * It does NOT mean the workspace is healthy: the walk-driven call fires
   * without consulting `controlDocsComplete`, deliberately, because its only
   * consumer needs "re-evaluate the share policy", not "everything is fine".
   * `runStaleRepair` and `scheduleWorkspaceRouteBackfill` do gate on
   * completeness; a future consumer that reads this as a health signal will be
   * wrong.
   *
   * Load-bearing, not a notification nicety. automerge-repo caches
   * `shareConfig.access` per (document, peer): `#resolveSharePolicy` runs once
   * inside `addPeer` and the result is stored in `peer.sharePolicyState`
   * (`DocSynchronizer.js`), which is only ever recomputed by
   * `reevaluateSharePolicy` — reachable solely from `Repo.shareConfigChanged()`.
   * A denied peer is skipped thereafter and its subsequent changes are
   * DISCARDED. So without this hook, denying-and-scheduling would convert a
   * rare deadlock into a permanent silent "document unavailable" for the life
   * of the connection — strictly worse than the bug it replaces.
   */
  onWorkspaceIndexRepaired: ((key: WorkspaceKey) => void) | null = null

  private lastGateFaultReevalAt = Number.NEGATIVE_INFINITY

  /**
   * Ask the sync layer to re-evaluate its cached share-policy verdicts, without
   * claiming anything was repaired.
   *
   * Used only by `gateFault`. A fail-closed verdict is pinned per (document,
   * peer) exactly like a real deny, so without this a five-second database blip
   * costs the peer that document until it reconnects. Throttled by the same
   * reasoning as `scheduleStaleRepair`: the trigger is inbound message volume,
   * which a peer controls, and the fan-out is expensive.
   */
  requestShareReevaluation(key: WorkspaceKey | null | undefined): void {
    if (!key) return
    const now = this.clock()
    if (now - this.lastGateFaultReevalAt < GATE_FAULT_REEVAL_MIN_INTERVAL_MS) return
    this.lastGateFaultReevalAt = now
    this.announceIndexRepaired(key)
  }

  private announceIndexRepaired(key: WorkspaceKey): void {
    try {
      this.onWorkspaceIndexRepaired?.(key)
    } catch (err) {
      console.warn('[docScope] index-repaired listener failed for', key, err)
    }
  }
  private readonly staleRepairConcurrency: number
  private readonly clock: () => number
  private readonly staleRepairDeadlineMs: number
  private readonly claimBatchSize: number
  private readonly verifiedClaimDeadlineMs: number
  private readonly verifiedClaimRetryBackoffMs: number

  /** landscapeId -> cached version-id list for the displaced scan. Mirrors
   * `createSingleFlightWorkspaceRouteResolver` (syncCells/workspaceRoute.ts):
   * coalesce concurrent reads, retain answers briefly, never cache a failure. */
  private readonly landscapeVersionsCache = new Map<string, { ids: string[]; expiresAt: number }>()
  private readonly landscapeVersionsInFlight = new Map<string, Promise<string[]>>()
  /** The version-cache epoch. Bumped by EVERY invalidation of the version-list
   * cache (the in-process creation hook and the cross-process NOTIFY handler);
   * a list fetch records the epoch it observed BEFORE issuing its SQL and may
   * only populate the cache if that epoch is still current when it resolves.
   * Otherwise a fetch in flight across an invalidation would re-populate the
   * cache with the PRE-invalidation catalog, and the displaced scan would read
   * `foreign` for a brand-new version's minted ids for up to another TTL.
   * GLOBAL rather than per-landscape on purpose: version creations are rare,
   * the coarseness costs at most one extra SELECT, and a per-landscape map
   * would be one more unbounded structure. The flight's RESULT is still served
   * to its joiners; only the CACHE must never outlive a known invalidation. */
  private landscapeVersionsEpoch = 0

  /** documentId -> in-flight verified claim. One durable INSERT for a burst,
   * however many gate calls race on a freshly minted id. */
  private readonly verifiedClaimsInFlight = new Map<string, Promise<boolean>>()
  /** documentIds with a background claim retry scheduled or running. Guarantees "one background attempt per document at a time"; entries
   * self-delete when the retry settles, so the set is bounded by concurrent
   * ceiling evictions, not by peer-supplied id volume. */
  private readonly verifiedClaimRetryPending = new Set<string>()

  constructor(repo: Repo, pool: Pool, options: WorkspaceDocIndexOptions = {}) {
    this.repo = repo
    this.pool = pool
    this.durable = options.durable !== false
    this.staleRepairConcurrency = options.staleRepairConcurrency ?? DEFAULT_STALE_REPAIR_CONCURRENCY
    this.clock = options.clock ?? Date.now
    this.staleRepairDeadlineMs = options.staleRepairDeadlineMs ?? STALE_REPAIR_DEADLINE_MS
    this.claimBatchSize = options.claimBatchSize ?? CLAIM_BATCH_SIZE
    this.verifiedClaimDeadlineMs = options.verifiedClaimDeadlineMs ?? VERIFIED_CLAIM_DEADLINE_MS
    this.verifiedClaimRetryBackoffMs = options.verifiedClaimRetryBackoffMs ?? VERIFIED_CLAIM_RETRY_BACKOFF_MS
    registerWorkspaceCreation(({ landscapeId, versionId, rootUrl }) => {
      // A new version invalidates this landscape's cached version list, or ids
      // minted for it would scan `foreign` — a hard deny — for up to the TTL in
      // THIS process. Sibling processes are notified through the versions
      // trigger (workspaceCacheInvalidation.ts) and stay TTL-bounded without
      // it; that window is why LANDSCAPE_VERSIONS_TTL_MS is short.
      this.invalidateLandscapeVersionsCache(landscapeId)
      // A workspace whose bootstrap just claimed-and-covered needs no priming
      // walk — the claimed set IS the created set. Consulted LOCALLY and
      // synchronously on purpose: the only marker that can exist at this
      // instant is the one the publisher wrote moments ago in this process
      // (cover write-through); the cross-process attach consults durably in
      // `preWarmWorkspaceRoute`.
      // The entry is still created: a root ROTATION funnels through this hook
      // too, and `ensureEntry` is what repoints `entry.rootUrl`.
      if (this.durable && isWorkspaceCoveredLocally({ landscapeId, versionId }, this.clock)) {
        this.ensureEntry({ landscapeId, versionId }, rootUrl)
        return
      }
      // Fire-and-forget: prime the index for the new workspace so it's
      // servable immediately. A failure here just means the lazy path in
      // resolveDocWorkspace/allowedWorkspaceKeys picks it up on first need.
      void this.ensureWorkspace({ landscapeId, versionId }, rootUrl).catch((err) => {
        console.warn('[docScope] failed to prime newly created workspace:', keyOf({ landscapeId, versionId }), err)
      })
    })
    documentsRegistration = ({ landscapeId, versionId, rootUrl, documentIds }) => {
      const entry = this.ensureEntry({ landscapeId, versionId }, rootUrl)
      return this.claimDocumentsBatch(entry, documentIds)
    }
  }

  /**
   * Batch admission for server-created documents (the plural notify
   * hook). Same semantics as `claimDocument` per id — first-owner-wins, byDoc
   * fed for every resolved winner — with the SQL amortized through
   * `claimWorkspaceDocuments`. byDoc hits are answered without SQL so an
   * idempotent re-run (seeds) costs one round trip for the misses only.
   */
  private async claimDocumentsBatch(entry: WorkspaceEntry, documentIds: string[]): Promise<ClaimBatchResult> {
    const k = keyOf(entry.key)
    const result: ClaimBatchResult = { claimed: [], alreadyOurs: [], foreign: [], missingVersion: false }
    const misses: string[] = []
    for (const id of new Set(documentIds)) {
      const cached = this.byDoc.get(id)
      if (cached === undefined) { misses.push(id); continue }
      if (cached === k) { result.alreadyOurs.push(id); continue }
      const slash = cached.indexOf('/')
      result.foreign.push({
        documentId: id,
        winner: { landscapeId: cached.slice(0, slash), versionId: cached.slice(slash + 1) },
      })
    }
    if (misses.length === 0) return result
    if (!this.durable) {
      for (const id of misses) { this.byDoc.set(id, k); result.claimed.push(id) }
      return result
    }
    const batch = await claimWorkspaceDocuments(this.pool, entry.key, misses)
    for (const id of batch.claimed) this.byDoc.set(id, k)
    for (const id of batch.alreadyOurs) this.byDoc.set(id, k)
    for (const loser of batch.foreign) this.byDoc.set(loser.documentId, keyOf(loser.winner))
    result.claimed.push(...batch.claimed)
    result.alreadyOurs.push(...batch.alreadyOurs)
    result.foreign.push(...batch.foreign)
    result.missingVersion = batch.missingVersion
    return result
  }

  /**
   * Follow document residency, so idle eviction cannot silently disable this
   * index.
   *
   * `walk()` attaches a 'change' listener to every control document it reads,
   * and that listener is the ONLY mechanism by which a document a browser just
   * created becomes servable: the re-walk calls `claimDocument()`. None of
   * those documents are leased, so the idle sweep evicts them once they go
   * quiet. Eviction drops the handle from the Repo but not the listener — when
   * a client reopens the document, `repo.find()` mints a NEW handle and the
   * orphaned listener never fires again. The workspace then permanently rejects
   * every newly created document: the access gate asks `resolveDocWorkspace`,
   * which misses, and in production returns null without a graph fallback.
   * Symptom: "Cannot capture base manifest: document unavailable".
   *
   * The recovery machinery already exists — `backfillWorkspaceRoute` performs a
   * bounded, manifest-only re-walk that re-attaches exactly the listeners that
   * matter. It just never ran twice, because success is memoized per workspace.
   * So eviction marks the workspace stale and clears that memo, and the next
   * resolve miss repairs it.
   *
   * The listener must stay synchronous and allocation-cheap: `evict()` runs it
   * inside its own turn, discards the return value, and one residency instance
   * is shared process-wide, so this fires for every workspace's documents.
   */
  trackResidency(residency: DocumentEvictionSource): () => void {
    return residency.onBeforeEvict((documentId, handle) => {
      // FIRST, for every document we watch — leaf or control: drop our listener
      // from the handle that is about to be discarded.
      //
      // Functionally a no-op: a listener on a dropped handle never fires again,
      // and a returning document is a NEW handle the next walk re-attaches to.
      // What it buys is the eviction census, which counts any listener still
      // attached after this hook as an orphan; leaving ours behind would make it
      // fire for every idle document in every walked workspace.
      //
      // Correct only because `evict()` runs every refusal check BEFORE
      // announcing. An announcement for an eviction that does not happen would
      // tear down a live watcher.
      this.detachWatcher(documentId, handle)

      // CONTROL documents only. `byDoc` would be wrong here: it holds every
      // document in the workspace, but a manifest-only repair re-watches only
      // root/ModelMeta/registry shards, so marking a workspace stale because a
      // diagram or object shard was evicted schedules a walk that restores
      // nothing — while dropping the routeBackfills memo that exists to stop
      // repeated traversal, and re-hydrating documents the sweep just evicted.
      // Eviction is also not only the idle sweep: releaseOwner/replaceOwner
      // evict synchronously on routine projector write-head rotation, projector
      // detach and draft merges, none of which orphan a listener here.
      const workspace = this.controlDocWorkspace.get(documentId)
      if (workspace === undefined) return
      const entry = this.byWorkspace.get(workspace)
      if (!entry) return
      this.staleWorkspaces.set(workspace, entry.key)
      // Any walk in flight right now watched the handle being evicted, so it
      // must not be joined as if it were a repair (see ensureWorkspace).
      entry.staleGeneration += 1
      // The memoized repair reflects a walk whose listeners are now orphaned.
      this.routeBackfills.delete(workspace)
      // A residency change is new information, so a workspace that had used up
      // its retry budget gets it back rather than staying written off.
      this.routeBackfillFailures.delete(workspace)
    })
  }

  /**
   * Remove this index's re-walk listener from a handle the repo is about to
   * discard. Synchronous and allocation-free, as `evict()` requires: two map
   * lookups and an `off`.
   *
   * The handle is PASSED IN rather than read from `repo.handles`, which is a
   * getter that rebuilds a whole `Record` per access (~36 ms/sweep/projector
   * when read in a loop, measured in `projectorService.ts`). Every caller is
   * already holding it, and this runs inside `evict()`'s synchronous turn, once
   * per evicted document, plus every `releaseOwner`/`replaceOwner` rotation.
   *
   * Keyed on `byDoc` — every document in the workspace — deliberately, unlike
   * the stale-repair bookkeeping above, which is control-documents-only. The
   * distinction there is about which evictions can ORPHAN the index; this is
   * about which listeners are OURS, and all of them are.
   */
  private detachWatcher(documentId: string, handle: DocHandle<unknown> | undefined): void {
    if (!handle) return
    const workspace = this.byDoc.get(documentId)
    if (workspace === undefined) return
    const entry = this.byWorkspace.get(workspace)
    if (!entry?.onChange) return
    handle.off('change', entry.onChange)
    entry.watched.delete(handle)
  }

  /**
   * Start a repair pass if one is not already running.
   *
   * Deliberately NOT awaited by its caller. `resolveDocWorkspace` runs inside
   * the per-socket write-gate FIFO (`syncWriteGate.ts` chains every sync/request
   * onto a per-socket tail), and a repair walk calls `repo.find()`, which has no
   * timeout and resolves only when some peer supplies the document. For a
   * document the CLIENT just created, that peer is the very socket whose queue
   * is blocked on this check — so awaiting here deadlocks the connection
   * permanently, and `entry.building` never clears, wedging the workspace too.
   *
   * Returning null immediately is correct: the repair exists to restore the
   * change listeners, not to answer this particular call. Once the listeners are
   * back, the client's retry — Automerge re-requests unresolved documents — is
   * answered normally.
   */
  private scheduleStaleRepair(): void {
    if (this.staleRepairInFlight || this.staleWorkspaces.size === 0) return
    // Rate-limited because the trigger is attacker-influenced: `automergeServer`
    // resolves a document id even on the denial-logging path, so any peer can
    // produce resolve misses at will, and a pass walks every stale workspace
    // regardless of which tenant the requester belongs to. Deferring costs
    // nothing — the repair is asynchronous and the caller is denied either way.
    const now = this.clock()
    if (now - this.lastStaleRepairAt < STALE_REPAIR_MIN_INTERVAL_MS) return
    this.lastStaleRepairAt = now
    this.staleRepairInFlight = this.runStaleRepair()
      .catch((err) => console.warn('[docScope] stale-workspace repair pass failed', err))
      .finally(() => { this.staleRepairInFlight = null })
  }

  /**
   * Bound a repair walk in time.
   *
   * `repo.find()` has NO timeout — it settles only when some peer supplies the
   * document, and for a document a client just created the only peer may be a
   * socket whose message queue is blocked behind this very check
   * (`syncWriteGate` serialises per socket). Without a deadline one such walk
   * would hold `staleRepairInFlight` forever and disable stale recovery for
   * every workspace in the process.
   *
   * The underlying walk is not cancellable, so it keeps running; this only
   * stops the repair pass waiting on it. The workspace is reported as failed,
   * which is correct — its listeners are not known to be restored.
   */
  private walkWithinDeadline(walk: Promise<void>, workspace: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`repair walk for ${workspace} exceeded ${this.staleRepairDeadlineMs}ms`))
      }, this.staleRepairDeadlineMs)
      timer.unref?.()
      walk.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  /**
   * Re-walk every workspace orphaned by eviction, `staleRepairConcurrency` at a
   * time. Bounded on both axes: a workspace is removed from the queue before its
   * walk (so a re-eviction during the walk re-queues it rather than being
   * swallowed), and a workspace that keeps failing is abandoned after
   * `MAX_STALE_REPAIR_FAILURES` so a persistent fault cannot be retried on every
   * miss. Failures are re-queued only after the drain completes, never inside
   * it, so a failing workspace cannot spin this loop.
   *
   * The walk itself is delegated to `backfillWorkspaceRoute`, which re-reads
   * `root_url` from Postgres (so a rotated root is picked up rather than the
   * retired in-memory one). The walk re-reads and re-watches root, ModelMeta
   * and the registry shards — the only documents whose changes introduce new
   * references — and claims leaf ids from those manifests without loading them.
   */
  private async runStaleRepair(): Promise<void> {
    const requeue = new Map<string, WorkspaceKey>()
    while (this.staleWorkspaces.size > 0) {
      const batch: [string, WorkspaceKey][] = []
      for (const pending of this.staleWorkspaces) {
        if (batch.length >= this.staleRepairConcurrency) break
        batch.push(pending)
      }
      for (const [workspace] of batch) this.staleWorkspaces.delete(workspace)
      await Promise.all(batch.map(async ([workspace, key]) => {
        try {
          // CAS witness observed before the walk — see the twin note in
          // `scheduleWorkspaceRouteBackfill`. Read failure skips only the
          // re-cover, never the repair.
          const observed = this.durable
            ? await readWorkspaceCoverageInvalidations(this.pool, key).catch(() => null)
            : null
          await this.walkWithinDeadline(this.backfillWorkspaceRoute(key), workspace)
          // `walk()` swallows unreadable documents, so "did not throw" is not
          // "repaired". If a control document was missed, the listener this
          // pass existed to restore is still gone — treat it as a failure so
          // the workspace stays queued instead of being memoized as healthy.
          const entry = this.byWorkspace.get(workspace)
          if (entry && !entry.controlDocsComplete) {
            throw new Error(`repair walk could not read every control document of ${workspace}`)
          }
          this.staleRepairFailures.delete(workspace)
          // Same stickiness applies to the eviction-driven repair path.
          this.announceIndexRepaired(key)
          // Coverage may only be written by the caller of a complete pass.
          this.coverAfterCompleteWalk(key, observed)
        } catch (err) {
          // Drop the memo. `backfillWorkspaceRoute` only clears it when the walk
          // itself rejects — but a walk that merely failed to READ a control
          // document resolves normally, so without this the memo would survive
          // and every retry would return the cached failed walk instead of
          // re-walking. Same for a deadline: the memo would hold a promise that
          // may never settle.
          this.routeBackfills.delete(workspace)
          const failures = (this.staleRepairFailures.get(workspace) ?? 0) + 1
          this.staleRepairFailures.set(workspace, failures)
          if (failures >= MAX_STALE_REPAIR_FAILURES) {
            console.warn(
              `[docScope] giving up repairing ${workspace} after ${failures} failures;`
              + ' newly created documents there stay quarantined until it is walked again',
              err,
            )
            return
          }
          requeue.set(workspace, key)
          console.warn('[docScope] stale-workspace repair failed for', key, err)
        }
      }))
    }
    for (const [workspace, key] of requeue) this.staleWorkspaces.set(workspace, key)
  }

  /** All known (landscapeId, versionId, rootUrl) rows from Postgres. */
  private async listVersionRows(): Promise<{ landscapeId: string; versionId: string; rootUrl: string }[]> {
    // The shared maintenance enumeration; do not inline a copy of the query.
    return enumerateMaintainableWorkspaces(this.pool)
  }

  /**
   * Ensure a specific workspace has been walked at least once (lazy build).
   * Concurrent callers for the same workspace share one in-flight build.
   */
  private async ensureWorkspace(
    key: WorkspaceKey,
    rootUrl: string,
  ): Promise<void> {
    const entry = this.ensureEntry(key, rootUrl)
    // Join an in-flight walk only if it is of the current generation: a walk
    // that began before the newest staleness marking watched handles that have
    // since been evicted, so joining it would report a repair that did not
    // happen. Any caller may otherwise join, which also keeps two concurrent
    // walks from racing on `entry.controlDocsComplete`.
    if (
      entry.building
      && entry.buildingGeneration >= entry.staleGeneration
    ) return entry.building
    entry.buildingGeneration = entry.staleGeneration
    const walk = this.walk(entry).finally(() => {
      if (entry.building === walk) entry.building = null
    })
    entry.building = walk
    return walk
  }

  /**
   * The change-driven re-walk, coalesced.
   *
   * `entry.onChange` is ONE listener shared by every control document in the
   * workspace. Calling `this.walk(entry)` directly would start M concurrent
   * traversals when M registry shards change in one tick: M times the load on
   * the sync thread, and a flapping `entry.controlDocsComplete` (a rewalk that
   * transiently missed a shard and landed last turns a successful
   * `backfillWorkspaceRoute` into a throw and backoff). Admission itself is
   * safe either way: `byDoc` is only ever added to, under first-owner-wins.
   *
   * Trailing edge, not leading: a change arriving DURING a walk cannot be
   * dropped, because that walk may already have passed the shard it touched and
   * the document it announces would stay unclaimed until something unrelated
   * re-walked. So `rewalkPending` is set unconditionally and the runner loops
   * until it clears — a burst of M costs one walk plus at most one more.
   *
   * Note this deliberately does NOT reuse `ensureWorkspace`'s join: that one
   * returns an in-flight walk to its caller, which is right for "make sure this
   * workspace is indexed" and wrong here, where the caller is a change that the
   * in-flight walk may predate.
   */
  private coalescedRewalk(entry: WorkspaceEntry): Promise<void> {
    entry.rewalkPending = true
    if (entry.rewalkInFlight) return entry.rewalkInFlight
    const run = (async () => {
      try {
        // A throwing walk must not spin this loop, and must not SWALLOW the
        // backlog either: exiting with `rewalkPending` still true and nothing
        // armed to run it would leave documents unclaimed and denied forever.
        //
        // The only thing that rejects out of a walk is `claimDocument`'s
        // `pool.query` (`find()` swallows read failures; the walk then returns
        // with `controlDocsComplete = false`). A database fault is transient,
        // which is exactly the case where giving up is wrong.
        let consecutiveFailures = 0
        while (entry.rewalkPending) {
          entry.rewalkPending = false
          try {
            await this.walk(entry)
            consecutiveFailures = 0
            continue
          } catch (err) {
            consecutiveFailures += 1
            // The work did NOT happen. Put it back before doing anything else,
            // so no exit path from here can lose it.
            entry.rewalkPending = true
            console.warn(
              `[docScope] re-walk attempt ${consecutiveFailures} failed for`,
              entry.key, err,
            )
          }
          if (consecutiveFailures >= REWALK_MAX_ATTEMPTS) {
            // Out of local retries. Hand the workspace to the scheduled repair
            // AND drop its route memo, because `backfillWorkspaceRoute` returns
            // the cached promise otherwise and the repair would be a no-op.
            // `rewalkPending` stays true so a later control-document change
            // re-arms this runner too — two independent ways back, because the
            // failure mode is a permanent deny.
            const workspace = keyOf(entry.key)
            this.routeBackfills.delete(workspace)
            this.staleWorkspaces.set(workspace, entry.key)
            this.scheduleStaleRepair()
            break
          }
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, REWALK_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1))
            timer.unref?.()
          })
        }
      } finally {
        entry.rewalkInFlight = null
      }
    })()
    entry.rewalkInFlight = run
    return run
  }

  private ensureEntry(key: WorkspaceKey, rootUrl: string): WorkspaceEntry {
    const k = keyOf(key)
    let entry = this.byWorkspace.get(k)
    if (!entry) {
      entry = {
        key,
        rootUrl,
        serverManagedRoot: null,
        docIds: new Set(),
        watched: new WeakSet(),
        onChange: null,
        building: null,
        staleGeneration: 0,
        buildingGeneration: -1,
        rewalkPending: false,
        rewalkInFlight: null,
        controlDocsComplete: false,
      }
      this.byWorkspace.set(k, entry)
    } else if (entry.rootUrl !== rootUrl) {
      // Root rotation is a supported recovery operation. Keeping the old URL
      // here would protect the retired root while allowing writes to the new
      // canonical control document.
      entry.rootUrl = rootUrl
      entry.serverManagedRoot = null
    }
    return entry
  }

  /**
   * Every version id of one landscape, for the displaced scan. Single-flight + short TTL, mirroring
   * `createSingleFlightWorkspaceRouteResolver`: a reconnect storm's worth of
   * mismatches costs one `SELECT`, and a null/failed read is never cached.
   *
   * SQL only, and that is a design property, not an implementation detail: this
   * is consulted by the route gate, where the standing rule forbids awaiting an
   * Automerge document but tolerates a database read (`resolveDocWorkspace` is
   * the precedent). The query itself runs under
   * `LANDSCAPE_VERSIONS_QUERY_DEADLINE_MS` so the in-flight memo can never hold
   * a promise that never settles — a wedged pool becomes a rejection, the memo
   * clears, and the next mismatch retries instead of joining a permanent hang.
   */
  listLandscapeVersionIds(landscapeId: string): Promise<string[]> {
    const cached = this.landscapeVersionsCache.get(landscapeId)
    if (cached && cached.expiresAt > this.clock()) return Promise.resolve(cached.ids)
    if (cached) this.landscapeVersionsCache.delete(landscapeId)

    const existing = this.landscapeVersionsInFlight.get(landscapeId)
    if (existing) return existing

    // Epoch observed BEFORE the SQL is issued: an invalidation
    // landing while this fetch is in flight bumps past it, and the stale list
    // below is then served to THIS flight's joiners but never retained.
    const epochAtFetch = this.landscapeVersionsEpoch
    // ORDER BY is part of the displaced scan's contract, not cosmetics: the
    // scan consumes only the first DISPLACED_SCAN_MAX_CANDIDATES entries
    // (documentIdMint.ts), so the list must be in preference order — newest
    // version first, `id` as the deterministic tiebreak within one timestamp.
    // LIMIT cap+1: the scan never reads past the cap, and ONE row
    // beyond it is exactly what its truncation detection (`length > cap`)
    // needs — an unbounded SELECT would ship a pathological landscape's whole
    // tail across the wire just to drop it. Corollary, documented where the
    // warn is emitted (recordDisplacedScanTruncation): a truncated landscape's
    // candidateCount reads "at least cap+1", never the exact total.
    const pending = settleWithinDeadline(
      this.pool.query<{ id: string }>(
        `SELECT id FROM versions WHERE landscape_id = $1
         ORDER BY created_at DESC, id
         LIMIT ${DISPLACED_SCAN_MAX_CANDIDATES + 1}`,
        [landscapeId],
      ).then(({ rows }) => rows.map((row) => row.id)),
      LANDSCAPE_VERSIONS_QUERY_DEADLINE_MS,
      `landscape version list for ${landscapeId}`,
    )
    this.landscapeVersionsInFlight.set(landscapeId, pending)
    const clear = () => {
      if (this.landscapeVersionsInFlight.get(landscapeId) === pending) {
        this.landscapeVersionsInFlight.delete(landscapeId)
      }
    }
    void pending.then((ids) => {
      clear()
      if (epochAtFetch !== this.landscapeVersionsEpoch) return
      while (this.landscapeVersionsCache.size >= LANDSCAPE_VERSIONS_CACHE_MAX_ENTRIES) {
        const oldest = this.landscapeVersionsCache.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.landscapeVersionsCache.delete(oldest)
      }
      this.landscapeVersionsCache.set(landscapeId, { ids, expiresAt: this.clock() + LANDSCAPE_VERSIONS_TTL_MS })
    }, clear)
    return pending
  }

  /** One owner for both invalidation triggers of the version-list cache (the
   * in-process creation hook and the cross-process NOTIFY), so neither can
   * drop the entry without bumping the epoch the in-flight guard checks. */
  private invalidateLandscapeVersionsCache(landscapeId: string): void {
    this.landscapeVersionsEpoch += 1
    this.landscapeVersionsCache.delete(landscapeId)
  }

  /** The cross-process half of the version-list invalidation, wired by
   * automergeServer to the `workspace_version_created` NOTIFY channel (a
   * sibling process committed an INSERT INTO versions for this landscape).
   * COMFORT, not a dependency: a process with no LISTEN client stays correct,
   * merely TTL-bounded (≤ LANDSCAPE_VERSIONS_TTL_MS of `foreign` for ids
   * minted against the new version). */
  noteRemoteVersionCreated(landscapeId: string): void {
    this.invalidateLandscapeVersionsCache(landscapeId)
  }

  /**
   * Record the durable claim for a document whose id VERIFIED as bound to this
   * workspace by the mint MAC.
   *
   * The MAC alone is enough to ADMIT — that is the point of it — so this write
   * is not on the authorization path and is deliberately not awaited by the
   * gate. What it is for is everything else that reads
   * `automerge_document_workspace` without knowing the mint scheme exists: the
   * read-model projector, the residency snapshot, the reference-integrity scan,
   * and `resolveDocWorkspace` for callers that need "which workspace" rather
   * than "is it this one".
   *
   * Written HERE, on first verified sight, rather than when the id was minted.
   * Three reasons, in order of how much they matter:
   *
   *  1. At mint time the server has only the raw bytes, and `binaryToDocumentId`
   *     is not exported by automerge-repo. Encoding them here would mean
   *     depending on its transitive `bs58check` and silently producing wrong
   *     ids if it ever changed encoder. On this path the canonical string
   *     arrived on the wire.
   *  2. A minted id that is never used — and the offline pool exists precisely
   *     to mint ahead of use — would otherwise leave a row for a document that
   *     does not exist.
   *  3. It self-heals. A lost write is retried on the next sight of the
   *     document, whereas a one-shot write at mint time is lost for good.
   *
   * Safe because it runs only after `verifyDocumentId` returned `bound`: the id
   * is not the peer's assertion, it is the server's own signature — and on the
   * `displaced` branch only after the sibling-version scan proved the binding
   * is to this route's own landscape, where the table (not the MAC) decides
   * version placement, first-owner-wins.
   *
   * Returns whether the document is OURS afterwards: inserted here, or already
   * durably assigned to `key`. `false` means another workspace holds the row —
   * the displaced route gate turns that into its deny.
   *
   * SINGLE-FLIGHTED per documentId. The bound fast path
   * fires one of these per inbound message for a document the process has not
   * cached yet, and a freshly created document arrives as a burst — without the
   * flight map that is N identical INSERT round trips racing each other.
   * Joiners re-test `byDoc` AFTER the await rather than trusting the joined
   * flight's boolean: the flight may have been started under another route's
   * key (two routes racing one displaced id), and its answer is about ITS key.
   *
   * ANNOUNCES ON CLAIM. A deny for this document may already be pinned per
   * (document, peer) inside automerge-repo — `resolveDocWorkspace` misses and
   * denies until the row exists — and only `Repo.shareConfigChanged()` lifts
   * it. Relying on the workspace walk to announce fails whenever the walk does
   * not cover the path (eviction, coverage skipping it), leaving a deny with no
   * lift. So the announcement lives HERE, with the admission it pairs with:
   * a winning claim announces `key`; a losing claim that just LEARNED the
   * durable winner announces the winner's workspace, whose peers may be
   * sitting on exactly such a pinned deny.
   */
  async claimVerifiedDocument(key: WorkspaceKey, documentId: string): Promise<boolean> {
    const k = keyOf(key)
    const cached = this.byDoc.get(documentId)
    if (cached) return cached === k
    const joined = this.verifiedClaimsInFlight.get(documentId)
    if (joined) {
      // The flight's rejection belongs to its starter (who logs it); a joiner
      // only needs "it settled".
      await joined.catch(() => {})
      const settled = this.byDoc.get(documentId)
      if (settled) return settled === k
      // The joined flight decided nothing — its versions row was missing, the
      // winner row vanished, or it rejected. Run our own claim below.
    }
    // Wrapped BEFORE it is stored: the map entry must be a promise that is
    // GUARANTEED to settle, or the finally below never runs and every later
    // caller joins a dead flight (see VERIFIED_CLAIM_DEADLINE_MS). The
    // underlying claim is not cancelled — a late win still claims, announces
    // and self-heals; only the wait (and the map tenure) is bounded.
    const flight = settleWithinDeadline(
      this.runVerifiedClaim(key, documentId),
      this.verifiedClaimDeadlineMs,
      `verified claim for ${documentId}`,
    )
    this.verifiedClaimsInFlight.set(documentId, flight)
    try {
      return await flight
    } catch (error) {
      // A flight evicted BY ITS CEILING — and ONLY by its ceiling — reached no
      // verdict, and every joiner it had was answered `false` without an
      // announcement: that deny stays pinned per (document, peer) until the
      // denyLedger's ~30 s reconcile or a reconnection. Schedule ONE detached
      // background retry whose success ANNOUNCES (runVerifiedClaim's own
      // announce), so the lift need not wait. A resolved `false` is a
      // legitimate first-owner-wins refusal (nothing to retry), and a plain SQL rejection already pairs with gateFault's
      // re-evaluation; neither reaches this branch. The schedule itself is
      // synchronous — nothing new is awaited on the admission path.
      if (error instanceof DeadlineExceededError) {
        this.scheduleVerifiedClaimRetry(key, documentId)
      }
      throw error
    } finally {
      if (this.verifiedClaimsInFlight.get(documentId) === flight) {
        this.verifiedClaimsInFlight.delete(documentId)
      }
    }
  }

  /**
   * ONE detached retry for a ceiling-evicted claim flight — never in a
   * verdict, never awaited by anything.
   *
   * Bounded on both axes the standing rules require:
   *  - one background attempt per document at a time (`verifiedClaimRetryPending`);
   *  - a permanently dead pool stops after the SECOND failure: the retry runs
   *    through `claimVerifiedDocument`, so its own ceiling eviction lands back
   *    in the catch above — where the pending entry, still present, suppresses
   *    a re-schedule. That ordering is load-bearing, not luck: the inner catch
   *    runs while this method's `finally` below has not yet deleted the entry,
   *    because the runner's `.finally` only executes once the inner promise
   *    has fully settled. After the abandon, the denyLedger's reconcile and
   *    the peer's own re-presentations remain the net — a later presentation
   *    that evicts again earns a fresh single retry, which keeps the retry
   *    rate coupled to (already rate-bounded) presentations, never to a timer.
   */
  private scheduleVerifiedClaimRetry(key: WorkspaceKey, documentId: string): void {
    if (this.verifiedClaimRetryPending.has(documentId)) return
    this.verifiedClaimRetryPending.add(documentId)
    const timer = setTimeout(() => {
      void this.claimVerifiedDocument(key, documentId)
        .catch(() => {
          // Second failure — abandoned (see the method comment). The rejection
          // is already logged by the gate path when a peer re-presents.
        })
        .finally(() => {
          this.verifiedClaimRetryPending.delete(documentId)
        })
    }, this.verifiedClaimRetryBackoffMs)
    timer.unref?.()
  }

  /** Release witness for the verified-claim single-flight map: tests assert the
   * map RETURNS TO EMPTY after a burst — asserting on the release, not on
   * having called the API that releases. */
  _verifiedClaimsInFlightCountForTests(): number {
    return this.verifiedClaimsInFlight.size
  }

  /** Release witness for the background-retry guard: tests
   * assert the set returns to empty after the bounded retries — and that a
   * legitimate refusal never populates it at all. */
  _verifiedClaimRetryPendingCountForTests(): number {
    return this.verifiedClaimRetryPending.size
  }

  private async runVerifiedClaim(key: WorkspaceKey, documentId: string): Promise<boolean> {
    const k = keyOf(key)
    let entry = this.byWorkspace.get(k)
    if (!entry) {
      const { rows } = await this.pool.query<{ root_url: string }>(
        'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
        [key.landscapeId, key.versionId],
      )
      const rootUrl = rows[0]?.root_url
      // A key with no versions row cannot claim (deleted version — same
      // derive-from-versions rule as the INSERT itself).
      if (!rootUrl) return false
      // Re-test after the await: a concurrent walk or a rival flight may
      // have settled this document while the versions row was being read.
      const settled = this.byDoc.get(documentId)
      if (settled) return settled === k
      entry = this.ensureEntry(key, rootUrl)
    }
    const knownBefore = this.byDoc.has(documentId)
    const claimed = await this.claimDocument(entry, documentId)
    // Nothing new was learned on a cache hit; the announcement below is owed
    // only when this call ADMITTED something (win) or first RESOLVED the
    // durable winner into this process (loss) — see the method comment.
    if (knownBefore) return claimed
    if (claimed) {
      this.announceIndexRepaired(key)
      return true
    }
    const winner = this.byDoc.get(documentId)
    if (winner !== undefined && winner !== k) {
      this.announceIndexRepaired(this.workspaceFromKey(winner))
    }
    return false
  }

  /** Immutable first-owner-wins registration. The INSERT derives from the
   * versions row so a caller cannot bind a version to a foreign landscape. */
  private async claimDocument(entry: WorkspaceEntry, documentId: string): Promise<boolean> {
    const k = keyOf(entry.key)
    const cached = this.byDoc.get(documentId)
    if (cached) return cached === k
    if (!this.durable) {
      this.byDoc.set(documentId, k)
      return true
    }
    const inserted = await this.pool.query<{ document_id: string }>(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT $1, v.landscape_id, v.id
       FROM versions v
       WHERE v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING
       RETURNING document_id`,
      [documentId, entry.key.landscapeId, entry.key.versionId],
    )
    if ((inserted.rowCount ?? inserted.rows.length) > 0) {
      this.byDoc.set(documentId, k)
      this.forgetProvisionalPlacement(documentId)
      return true
    }
    const { rows } = await this.pool.query<{ landscape_id: string; version_id: string }>(
      `SELECT landscape_id, version_id
       FROM automerge_document_workspace
       WHERE document_id = $1`,
      [documentId],
    )
    const winner = rows[0]
    if (!winner) return false
    const winnerKey = keyOf({ landscapeId: winner.landscape_id, versionId: winner.version_id })
    this.byDoc.set(documentId, winnerKey)
    this.forgetProvisionalPlacement(documentId)
    return winnerKey === k
  }

  /**
   * The provisional placement's ONE purge site. Not on the fence's read
   * (`peekProvisionalPlacement`): the fence only reads when its durable SELECT
   * missed, so once a claim lands the entry would never be read — or evicted —
   * again, the map would saturate, and the overflow counter would stop meaning
   * "something fell back to the unfenced admission".
   *
   * Called from the two places `claimDocument` learns a DURABLE row — the
   * INSERT it won, and the winner it read after losing. Deliberately NOT from
   * `walkFrom`'s tail loop, which also writes `byDoc` but for ids
   * `claimDocument` DECLINED: there is no row there, so forgetting the
   * placement would hand exactly those documents back to the unfenced
   * admission.
   */
  private forgetProvisionalPlacement(documentId: string): void {
    this.provisionalPlacements.delete(documentId)
  }

  /**
   * One durable INSERT for a batch of leaf claims.
   *
   * Two statements ON PURPOSE, never a single CTE: under READ COMMITTED,
   * `ON CONFLICT` can conflict with a row committed by a concurrent transaction
   * AFTER this statement's snapshot was taken, and the SELECT half of the same
   * statement would not see that row — the document would be in neither set,
   * indistinguishable from "versions row missing". The second statement takes a
   * fresh snapshot and sees the winner `ON CONFLICT` waited on.
   *
   * `RETURNING` yields ONLY actually-inserted rows (conflicted rows are not
   * returned under DO NOTHING — pinned by the durable integration test, not
   * trusted from documentation), and its order is not guaranteed, so both
   * result sets are matched BY VALUE.
   *
   * The INSERT derives landscape/version from the `versions` row, exactly like
   * `claimDocument`: a deleted version inserts nothing and wins nothing, so its
   * documents stay unadmitted. A batch id that conflicts and then has no winner
   * row (claimed then GC'd between the two statements) stays out of `byDoc` —
   * the walk's tail commit loop admits it in-process, matching
   * `claimDocument`'s vanished-winner behaviour.
   */
  private async flushLeafClaims(
    entry: WorkspaceEntry,
    pending: string[],
    admitted: { value: boolean },
  ): Promise<void> {
    if (pending.length === 0) return
    const k = keyOf(entry.key)
    // Re-filter at flush time: `claimVerifiedDocument` or another workspace's
    // walk may have settled an id since it was buffered. A hit resolved to us
    // is already admitted (no announcement owed — same as `claimDocument`'s
    // cache short-circuit); a hit resolved to a foreign key must not be
    // re-inserted, and its byDoc entry already points at the winner.
    //
    // Sorted so two concurrent walks claiming overlapping sets acquire the
    // unique-index locks in one monotonic order. Unsorted, a crafted root (or
    // the shared-root defect fsck hunts) can interleave two multi-row
    // autocommit INSERTs into a 40P01 deadlock; sorted, the loser just waits.
    const ids = pending.filter((id) => !this.byDoc.has(id))
    if (ids.length === 0) return
    // Sort, batch slicing, the two-statements rule and the by-value loser
    // resolution all live in `claimWorkspaceDocuments` (documentClaims.ts).
    const result = await claimWorkspaceDocuments(this.pool, entry.key, ids)
    for (const id of result.claimed) this.byDoc.set(id, k)
    // Every id here was a byDoc miss when buffered, so a successful claim is a
    // NEW admission and must announce (the deny-pairing half of the walk).
    if (result.claimed.length > 0) admitted.value = true
    for (const id of result.alreadyOurs) {
      // The restart shape: every row already durably OURS, every INSERT
      // conflicts — and the announcement must still go out, or the whole
      // workspace re-boots into pinned denies that nothing lifts.
      this.byDoc.set(id, k)
      admitted.value = true
    }
    for (const loser of result.foreign) this.byDoc.set(loser.documentId, keyOf(loser.winner))
  }

  /** O(1) durable lookup on a cache miss. Avoids both a platform-wide eager
   * hydration and an all-workspace graph walk after every process restart. */
  private async resolveDurable(documentId: string): Promise<WorkspaceKey | null> {
    if (!this.durable) return null
    const { rows } = await this.pool.query<{
      landscape_id: string
      version_id: string
      root_url: string
      static_source: string | null
      static_allowed: boolean
    }>(
      `SELECT d.landscape_id, d.version_id, v.root_url,
              static_workspace.source AS static_source,
              EXISTS (
                SELECT 1 FROM read_model_static_documents allowed
                WHERE allowed.landscape_id = d.landscape_id
                  AND allowed.version_id = d.version_id
                  AND allowed.document_id = d.document_id
              ) AS static_allowed
       FROM automerge_document_workspace d
       JOIN versions v ON v.id = d.version_id AND v.landscape_id = d.landscape_id
       LEFT JOIN read_model_static_workspaces static_workspace
         ON static_workspace.landscape_id = d.landscape_id
        AND static_workspace.version_id = d.version_id
       WHERE d.document_id = $1`,
      [documentId],
    )
    const row = rows[0]
    if (!row) return null
    if (row.static_source && !row.static_allowed) return null
    const key = { landscapeId: row.landscape_id, versionId: row.version_id }
    const entry = this.ensureEntry(key, row.root_url)
    entry.docIds.add(documentId)
    this.byDoc.set(documentId, keyOf(key))
    return key
  }

  /** Walk root -> model/meta/registry -> shards/diagrams for one workspace entry,
   * replacing its doc set and (re)attaching 'change' listeners for incremental
   * re-walks. Never throws — a doc it can't read just isn't walked DEEPER yet.
   *
   * REFERENCED-BUT-UNREADABLE docs are still INDEXED (by the doc id parsed from
   * the URL): a workspace doc the CLIENT just created (e.g. the ModelMeta a
   * sharding-enabled client adds to a fresh root, or a new object shard) does
   * not exist server-side yet. Indexing only readable docs would deadlock it:
   * the access gate would deny the client's upload because the doc is not
   * indexed, and it could never become indexed because the only copy is the
   * client's. The URL reference inside an already-trusted workspace doc IS the
   * authorization; once the upload lands, the next re-walk reads it and indexes
   * whatever it references in turn.
   *
   * Timed into `recordDocScopeWalk` so the walk's cost (the largest per-change
   * term on large workspaces) is visible in `/metrics`. */
  private async walk(entry: WorkspaceEntry): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.walkImpl(entry)
    } finally {
      recordDocScopeWalk(Date.now() - startedAt)
    }
  }

  private async walkImpl(entry: WorkspaceEntry): Promise<void> {
    // A document admitted during this pass is one the gates may already have
    // DENIED, and automerge-repo pins that verdict per (document, peer) at
    // `#activatePeer` — only `Repo.shareConfigChanged()` can lift it. Announcing
    // is therefore not bookkeeping, it is the other half of every deny.
    //
    // Nothing else covers the ordinary case. On a healthy workspace
    // `routeBackfills` is already memoized from the socket-upgrade pre-warm, so
    // the gate's `scheduleWorkspaceRouteBackfill` returns without scheduling
    // anything, and `runStaleRepair` only announces for workspaces that eviction
    // marked stale.
    //
    // The `finally` is load-bearing, not defensive. `reference()` claims a URL
    // BEFORE the read is attempted, so an unreadable root aborts the pass with
    // the announcement already earned — and the peer holding that root is the
    // one the pending deny is blocking, so announcing is what lets it upload
    // the document the walk needed.
    const admitted = { value: false }
    try {
      await this.walkFrom(entry, admitted)
    } finally {
      if (admitted.value) this.announceIndexRepaired(entry.key)
    }
  }

  private async walkFrom(
    entry: WorkspaceEntry,
    admitted: { value: boolean },
  ): Promise<void> {
    const newDocIds = new Set<string>()
    const k = keyOf(entry.key)
    /** Cleared whenever a CONTROL document could not be read on this pass.
     * `find()` swallows read failures and returns null by design, so without
     * this a walk that missed ModelMeta is indistinguishable from a complete
     * one — and a repair built on it would be memoized as successful while the
     * listener it was supposed to restore is still missing. */
    let controlDocsComplete = true
    /** Index a referenced doc id even before its content is fetchable — and
     * commit it to the reverse index IMMEDIATELY (first-owner-wins), not only
     * at the end of the walk. The walk's own `find()` below asks connected
     * peers for referenced docs; the access gate evaluates those inbound
     * responses against `byDoc`, so an end-of-walk-only commit deadlocks a
     * client-created doc: the find can never be answered by the only peer
     * holding it (symptom: "Cannot capture base manifest: document
     * unavailable"). */
    const reference = async (url: string | undefined): Promise<boolean> => {
      if (!url || !isValidAutomergeUrl(url)) return false
      // NOT `url.replace(/^automerge:/, '')`: that is a cross-workspace
      // capture. `isValidAutomergeUrl` accepts a heads section and a path
      // (`automerge:<id>/`, `automerge:<id>#`, `automerge:<id>/x` all resolve
      // to the bare `<id>`), so stripping only the prefix yields a string that
      // is NOT the document id. The first-owner-wins claim would then be keyed
      // on a string no other workspace collides with, while `find()` and the
      // tail loop admit the REAL id into `byDoc` — letting a registry shard
      // carrying `docUrl: "automerge:<foreign-id>/"` capture another
      // workspace's document for read and write. `interpretAsDocumentId` is
      // what `selectiveSync.ts` uses too.
      const id = String(interpretAsDocumentId(url as AutomergeUrl))
      newDocIds.add(id)
      // `claimDocument` short-circuits on a `byDoc` hit, so testing `byDoc`
      // first is exactly "was not already admitted" — not merely "the claim
      // succeeded", which is also true every time a known document is re-seen.
      const knownBefore = this.byDoc.has(id)
      const claimed = await this.claimDocument(entry, id)
      if (claimed && !knownBefore) admitted.value = true
      return claimed
    }
    /** `control` marks the documents whose own changes introduce NEW document
     * references — the root, ModelMeta and registry shards. Only those can
     * orphan this index when evicted, so only those drive stale recovery
     * (`trackResidency`). Leaves are recorded in `entry.watched` but get no
     * listener: they reference nothing. */
    const watch = (handle: DocHandle<unknown>, control = false) => {
      newDocIds.add(String(handle.documentId))
      if (control) this.controlDocWorkspace.set(String(handle.documentId), k)
      if (!entry.watched.has(handle)) {
        entry.watched.add(handle)
        // ONLY control documents re-walk. A re-walk is a full traversal of the
        // workspace on the thread that generates every peer's sync messages,
        // so arming it on leaves would make every shape drag re-walk.
        //
        // Restricting it loses nothing: references are extracted from exactly
        // three places — the root (`modelUrl`, `modelMetaUrl`, `shardUrls`),
        // ModelMeta (the shard url lists) and the registry shards
        // (`diagrams[].docUrl`) — and those are the ones passed `control = true`.
        // A change to any other document introduces no new reference. Leaves
        // stay in `newDocIds`, so they are still indexed and admitted.
        //
        // This bounds WHICH documents trigger a walk, not the walk itself. A
        // walk that has to load its leaves costs ~17 ms per diagram (57 s at
        // 3,000 diagrams, measured with full roots), and loading every
        // document at 10,000 diagrams exhausts automerge's WASM heap. Leaves are
        // therefore claimed from manifests without being resolved (`findLeaf`).
        if (control) {
          // One shared listener per workspace, so eviction can detach it by
          // identity. Re-walks this workspace only (incremental — see class doc).
          entry.onChange ??= () => { void this.coalescedRewalk(entry) }
          handle.on('change', entry.onChange)
        }
      }
    }

    const find = async (url: string | undefined): Promise<DocHandle<unknown> | null> => {
      if (!url || !isValidAutomergeUrl(url)) return null
      if (!(await reference(url))) {
        console.warn('[docScope] refused foreign or unscoped document reference', entry.key)
        return null
      }
      try {
        // A deadline is mandatory, not defensive. `find()`/`whenReady()` install
        // no timeout of their own, and a document's query cannot even fall
        // through to `unavailable` while any peer is still `sharePolicyState:
        // 'loading'` — so a walk for a document only a connected browser holds
        // can hang forever. That matters beyond this call: `routeBackfills` and
        // `entry.building` are evicted only when the walk REJECTS, so a walk
        // that merely never settles is memoized permanently and quarantines
        // every newly created document in the workspace, process-wide, until
        // restart. With a deadline the walk rejects, both memos clear, and the
        // workspace self-heals.
        //
        // This is a caller-side deadline, not cancellation: `findWithProgress`
        // ignores the signal, so the underlying query keeps running. We only
        // need to stop *waiting*.
        const handle = await this.repo.find(url as AutomergeUrl, {
          signal: AbortSignal.timeout(WALK_FIND_TIMEOUT_MS),
        })
        // NOT `await handle.whenReady()`: it returns a promise that never
        // settles for any state but `ready`, and it runs after `find` resolved,
        // so the deadline above could not bound it.
        if (handle.state !== 'ready') {
          throw new Error(`document ${url} resolved in state "${String(handle.state)}"`)
        }
        return handle
      } catch (err) {
        console.warn('[docScope] could not read doc while walking workspace (indexed by reference)', entry.key, url, err)
        return null
      }
    }
    /**
     * A leaf is CLAIMED, never RESOLVED.
     *
     * The index needs only the id in `newDocIds` and the durable claim, and
     * that claim is what makes a document servable — `resolveDocWorkspace`
     * reads `byDoc` then the durable table, and no authorization path in this
     * file, in `documentAccess.ts` or in `selectiveSync.ts` ever opens a
     * document. Resolving leaves would cost a full document load each (a cold
     * walk is ~45 s at 3,000 diagrams, and at 10,000 the WASM heap runs out)
     * for no benefit, since leaves get no listener.
     *
     * A leaf claim is BUFFERED, not awaited one by one: one autocommit round
     * trip per leaf costs ~4.3 ms/doc, and `flushLeafClaims` amortizes it in
     * batches of `claimBatchSize`. Control documents (root, ModelMeta,
     * registry shards) still claim synchronously through `reference()` inside
     * `find()` — their verdict gates the descent. Flushes are AWAITED and a
     * rejected flush rejects the walk: `coalescedRewalk`'s backoff and the
     * stale-repair path re-cover the lost batch, whereas catching and logging
     * here would let a walk resolve "clean" with documents never claimed and
     * nothing left to lift the deny.
     */
    const pendingLeafClaims: string[] = []
    const pendingLeafSeen = new Set<string>()
    const findLeaf = async (url: string | undefined): Promise<null> => {
      // DB-free mode never buffers: `claimDocument` is synchronous-in-effect
      // there (byDoc only), and an unconditional flush would call pool.query
      // in suites that run without a database.
      if (!this.durable) {
        await reference(url)
        return null
      }
      if (!url || !isValidAutomergeUrl(url)) return null
      // Same canonicalisation as `reference()` — `automerge:<id>/` and its
      // decorated twins must collapse to one claim, never reach the batch.
      const id = String(interpretAsDocumentId(url as AutomergeUrl))
      newDocIds.add(id)
      if (this.byDoc.has(id) || pendingLeafSeen.has(id)) return null
      pendingLeafSeen.add(id)
      pendingLeafClaims.push(id)
      if (pendingLeafClaims.length >= this.claimBatchSize) {
        await this.flushLeafClaims(entry, pendingLeafClaims.splice(0), admitted)
      }
      return null
    }

    const rootHandle = await find(entry.rootUrl)
    if (!rootHandle) {
      // Root itself unreadable — leave the previous doc set intact (don't
      // blank out a previously-good index on a transient read failure).
      entry.controlDocsComplete = false
      return
    }
    watch(rootHandle, true)
    const root = rootHandle.doc() as RootLike | undefined
    if (!root) {
      entry.controlDocsComplete = false
      return
    }
    const summaryOnly = root.registrySummaryOnly === true

    if (!summaryOnly) await findLeaf(root.modelUrl)

    const metaHandle = await find(root.modelMetaUrl)
    if (!metaHandle && root.modelMetaUrl) controlDocsComplete = false
    if (metaHandle) {
      watch(metaHandle, true)
      const meta = metaHandle.doc() as MetaLike | undefined
      if (meta) {
        if (summaryOnly) {
          // Static clients need only the tiny current overlay documents. Index
          // their trusted references without opening them during the walk.
          await reference(meta.editsObjectShardUrl)
          await reference(meta.editsConnectionShardUrl)
        } else {
          for (const u of meta.objectShardUrls ?? []) {
            await findLeaf(u)
          }
          for (const u of meta.connectionShardUrls ?? []) {
            await findLeaf(u)
          }
          for (const u of meta.decisionRecordShardUrls ?? []) {
            await findLeaf(u)
          }
          await findLeaf(meta.editsObjectShardUrl)
          await findLeaf(meta.editsConnectionShardUrl)
          for (const url of meta.editsObjectShardUrls ?? []) {
            await findLeaf(url)
          }
          for (const url of meta.editsConnectionShardUrls ?? []) {
            await findLeaf(url)
          }
        }
      }
    }

    if (!summaryOnly) {
      for (const shardUrl of root.shardUrls ?? []) {
        const shardHandle = await find(shardUrl)
        if (!shardHandle) { controlDocsComplete = false; continue }
        watch(shardHandle, true)
        const shard = shardHandle.doc() as RegistryShardLike | undefined
        if (!shard) continue
        for (const diagram of Object.values(shard.diagrams ?? {})) {
          await findLeaf(diagram.docUrl)
        }
      }
    }

    // The FINAL flush must land here — before the commit loop below, not
    // merely before walkFrom returns. The loop's only guard is `byDoc`, so an
    // unflushed leaf durably owned by ANOTHER workspace would have no entry yet
    // and be committed to `k`: an in-process cross-workspace capture. It also
    // precedes the entry assignments so a rejected flush leaves the previous
    // doc set intact, like every other walk failure.
    if (this.durable) {
      await this.flushLeafClaims(entry, pendingLeafClaims.splice(0), admitted)
    }

    // Commit the currently-linked set for diagnostics. Durable assignments are
    // intentionally not deleted when a document is unlinked: immutable
    // first-owner-wins prevents a stale/foreign root from capturing it later.
    entry.controlDocsComplete = controlDocsComplete
    entry.docIds = newDocIds
    for (const id of newDocIds) {
      // First-owner-wins: never let one workspace's walk RE-ASSIGN a doc that
      // is already indexed under another workspace (a crafted root referencing
      // a foreign doc URL must not capture — or shadow — the real owner).
      const existing = this.byDoc.get(id)
      if (existing && existing !== k) continue
      // Second admission path: `claimDocument` can decline (returning false
      // without touching `byDoc`) while this loop still makes the id resolvable
      // in-process. Track it here too, or that admission announces nothing.
      if (!existing) admitted.value = true
      this.byDoc.set(id, k)
    }
  }

  /**
   * The workspace a `byDoc` value names.
   *
   * `byWorkspace` is NOT a reliable lookup for it: entries are created only by
   * `ensureEntry`, while `byDoc` is given a FOREIGN winner's key by loser paths
   * that hold a key string and no `rootUrl` (`claimDocument`'s conflict
   * branch, `flushLeafClaims`, `claimDocumentsBatch`). So `byDoc` can know the
   * answer when `byWorkspace` does not.
   *
   * Reconstructing the key is exact: `keyOf` joins with '/', and neither id may
   * contain one (`syncCells/workspaceRoute.ts` WORKSPACE_ID).
   */
  private workspaceFromKey(key: string): WorkspaceKey {
    const entry = this.byWorkspace.get(key)
    if (entry) return entry.key
    const slash = key.indexOf('/')
    return { landscapeId: key.slice(0, slash), versionId: key.slice(slash + 1) }
  }

  /**
   * The index's answer from PROCESS MEMORY ONLY — no SQL, no repair, no await.
   *
   * `resolveDocWorkspace` cannot be used on the admission path for two separate
   * reasons: it awaits (and no authorization decision may await),
   * and on a miss it calls `scheduleStaleRepair()`, so consulting it for every
   * newly created document would schedule a parasitic workspace walk per
   * document.
   *
   * `null` means ONLY "this process has never placed that document". It must
   * not be conflated with `resolveDocWorkspace`'s `null`: there `null` DENIES,
   * here it ADMITS. Hence `workspaceFromKey` rather than a `byWorkspace`
   * lookup, which would answer null for a document `byDoc` has placed.
   *
   * Known limit: the FIRST presentation of a document this process has not yet
   * placed is still admitted, because a cache-only read cannot see a durable
   * row nobody has read. automerge-repo caches that allow per (document, peer).
   * At stage 'on' the composed check catches it anyway — `buildAccessCheck`
   * resolves durable-first — so what this changes on its own is the standalone
   * callers: the ownership gate, and stages 'off'/'dual'.
   */
  peekDocWorkspace(docId: string): WorkspaceKey | null {
    const hit = this.byDoc.get(docId)
    return hit === undefined ? null : this.workspaceFromKey(hit)
  }

  /**
   * Record that the route gate admitted `documentId` for `key` on the MAC
   * alone, before any durable row exists.
   *
   * Synchronous by contract — it is called on the admission path, where
   * no authorization decision may await anything.
   *
   * The `provisionalPlacements.has` guard matters at the CEILING: without it,
   * re-presenting a document already in a FULL map would evict the oldest
   * entry and then re-set an existing key, losing a placement and bumping the
   * overflow counter for no gain. A sync burst re-presents the same document
   * on every frame, so that is not a corner case.
   *
   * Known limit of the `byDoc` guard: `walkFrom`'s tail loop writes `byDoc` for
   * ids `claimDocument` DECLINED, so for those this returns without recording
   * and their storage mutations stay unfenced. Recording them instead would
   * leave an entry no purge site can remove, since the purge is on the durable
   * claim they never got.
   */
  noteProvisionalPlacement(key: WorkspaceKey, documentId: string): void {
    if (this.byDoc.has(documentId)) return
    if (this.provisionalPlacements.has(documentId)) return
    if (this.provisionalPlacements.size >= PROVISIONAL_PLACEMENT_MAX_ENTRIES) {
      const oldest = this.provisionalPlacements.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.provisionalPlacements.delete(oldest)
      recordProvisionalPlacementOverflow()
    }
    this.provisionalPlacements.set(documentId, keyOf(key))
  }

  /**
   * The workspace whose lease the storage fence must check for a document with
   * NO durable mapping row, or null to keep the unfenced admission.
   *
   * A PURE READ, and it must stay one: it is called inside `withDbRetry`'s
   * retryable closure and inside an open transaction, where neither a retry
   * nor a ROLLBACK would restore a deleted entry. It also must not consult
   * `byDoc`: the caller reaches it only because its durable SELECT missed, and
   * `byDoc.has` does NOT imply a durable row (`walkFrom`'s tail loop sets it
   * for ids `claimDocument` declined).
   *
   * The entry's lifetime belongs to the CLAIM, not to this read: `claimDocument`
   * purges it at both sites where it learns a durable row.
   */
  peekProvisionalPlacement(documentId: string): WorkspaceKey | null {
    const hit = this.provisionalPlacements.get(documentId)
    return hit === undefined ? null : this.workspaceFromKey(hit)
  }

  /**
   * Resolve a docId to its workspace. Returns null (default-deny) when the doc
   * is neither in memory nor in the durable registry. On such a miss the
   * durable path schedules a stale-workspace repair; the DB-free path kicks a
   * background walk of ALL workspaces. Neither is awaited.
   */
  async resolveDocWorkspace(docId: string): Promise<WorkspaceKey | null> {
    const hit = this.byDoc.get(docId)
    // Not `byWorkspace.get(hit)?.key ?? null`: that answers `null` for a
    // document a loser path placed in `byDoc` (no winner entry exists), and
    // the gates would then fall back to the mint and serve a document durably
    // owned by another workspace.
    if (hit !== undefined) return this.workspaceFromKey(hit)
    const durable = await this.resolveDurable(docId)
    if (durable) return durable
    // Production has an immutable durable doc -> workspace registry. A miss in
    // that registry is an unlinked document and must remain quarantined. Do not
    // hydrate every Automerge graph as a fallback: one protocol-level unknown
    // id would otherwise materialize all versions and consume gigabytes. The
    // graph walk remains available to DB-free/legacy callers; live parent
    // changes register newly linked documents through claimDocument().
    if (this.durable) {
      // ...with one exception: if a workspace's control-document watchers were
      // orphaned by eviction, "live parent changes register newly linked
      // documents" is no longer true for it and the quarantine would be
      // permanent. Kick off the repair WITHOUT awaiting it — this call runs
      // inside the per-socket write-gate FIFO and awaiting a graph walk here
      // deadlocks the connection (see scheduleStaleRepair) — and still deny
      // this request. The retry after the listeners are restored succeeds.
      this.scheduleStaleRepair()
      return null
    }
    // Miss on the DB-free path: kick the lazy "build on first need" catalog walk
    // but DO NOT await it — this function is a gate, and the walk resolves
    // documents that may only exist on the peer being gated (see
    // `scheduleWorkspaceRouteBackfill`). Deny now; the repair's completion hook
    // re-opens the door. Memoized in `allWalked`, so this costs one walk per
    // process no matter how many unknown ids arrive.
    void this.ensureAllWorkspacesWalked()
      .then(() => { for (const entry of this.byWorkspace.values()) this.announceIndexRepaired(entry.key) })
      .catch((err) => console.warn('[docScope] workspace catalog walk failed', err))
    return null
  }

  /**
   * The attach-time pre-warm, gated on the coverage marker.
   *
   * A COVERED workspace schedules nothing: every document it references was
   * claimed at write (bootstrap by construction, or one complete walk since),
   * so admission is answered by `byDoc`/`resolveDurable` alone and the walk
   * is only a repair path (see `noteRouteGateMiss`), never an attach cost.
   * Consulted through the per-process TTL cache (one SELECT per attach storm);
   * a read FAILURE falls back to scheduling the walk — the conservative side —
   * never to a silent skip. Nothing here is awaited by the upgrade.
   */
  preWarmWorkspaceRoute(key: WorkspaceKey): void {
    if (!this.durable) {
      this.scheduleWorkspaceRouteBackfill(key)
      return
    }
    void isWorkspaceCoveredCached(this.pool, key, this.clock)
      .then((covered) => {
        if (!covered) this.scheduleWorkspaceRouteBackfill(key)
      })
      .catch(() => this.scheduleWorkspaceRouteBackfill(key))
  }

  /**
   * The route gate met a document its route should have been able to place
   * and could not. Under claim-at-write that hole proves the coverage marker
   * wrong (a client creation with an unminted id, a forgotten creator site, a
   * lost claim), so the marker is durably de-covered — fire-and-forget, NEVER
   * awaited in the verdict (pinned by `docScope.gateLiveness.test.ts`) — and
   * ONE repair walk is scheduled.
   *
   * `routeBackfills.delete` is load-bearing: the memo exists to stop
   * peer-driven re-traversal, and left in place it would make the scheduled
   * repair a silent no-op on a workspace that had already walked once. The
   * purges run under a licence per (workspace, DOCUMENT) from
   * `noteCoverageGapLocally`: a document that already reported a gap in this
   * process re-triggers NOTHING (a stuck client re-presents the same doc every
   * ~30 s, and each would otherwise buy a full walk); a NEW document still
   * does, rate-capped by the per-workspace TTL. Other misses only re-schedule,
   * subject to memo and cooldown.
   *
   * The miss branch's deny is lifted by repair walk → `admitted` announce
   * (plus the denyLedger's periodic re-evaluation).
   */
  noteRouteGateMiss(route: WorkspaceKey, documentId: string): void {
    if (this.durable && noteCoverageGapLocally(route, documentId, this.clock)) {
      const workspace = keyOf(route)
      // Expose the write so the repair IIFE can sequence behind it
      // before reading its CAS witness. Caught HERE: the gate never awaits
      // this, and a rejection must never escape as an unhandledRejection.
      const invalidation = invalidateWorkspaceCoverage(
        this.pool,
        route,
        'route-gate miss: a document presented on this route has no claim row',
      ).catch((err) => {
        console.warn('[docScope] coverage invalidation failed for', workspace, err)
      })
      this.pendingCoverageInvalidations.set(workspace, invalidation)
      void invalidation.finally(() => {
        if (this.pendingCoverageInvalidations.get(workspace) === invalidation) {
          this.pendingCoverageInvalidations.delete(workspace)
        }
      })
      this.routeBackfills.delete(workspace)
      // Under the same once-per-(doc, gap) licence, ALSO drop the
      // backoff stamp: a real coverage gap must schedule its repair NOW, not
      // after the up-to-160 s (32×5 s) cooldown that a string of unrelated
      // backfill failures may have accumulated.
      this.routeBackfillAttemptedAt.delete(workspace)
    }
    this.scheduleWorkspaceRouteBackfill(route)
  }

  /** Re-cover after a COMPLETE walk, from the walk's CALLER only.
   * CAS against the counter observed before the walk began:
   * an invalidation that raced the walk wins, and the marker stays down until
   * the walk that invalidation scheduled completes in turn. */
  private coverAfterCompleteWalk(key: WorkspaceKey, observedInvalidations: string | null): void {
    if (!this.durable || observedInvalidations === null) return
    void coverWorkspace(this.pool, key, observedInvalidations).catch((err) => {
      console.warn('[docScope] failed to pose the coverage marker for', keyOf(key), err)
    })
  }

  /**
   * Fire-and-forget form of `backfillWorkspaceRoute`, for the sync gates.
   *
   * The `void` return type is the guard: awaiting a repair from inside a gate
   * is the deadlock this whole design exists to prevent, and a `void` return
   * makes reintroducing that a type error rather than a silent hang.
   * `docScope.gateLiveness.test.ts` enforces the same rule behaviourally.
   *
   * Rate-limited per workspace: the trigger is peer-driven (automergeServer
   * resolves a document id even on the denial-logging path), so without a
   * cooldown any peer could drive repeated graph walks at will.
   */
  scheduleWorkspaceRouteBackfill(key: WorkspaceKey): void {
    const workspace = keyOf(key)
    if (this.routeBackfills.has(workspace)) return
    // Back off on repeated failure — but NEVER latch off permanently. When the
    // root is readable only by the connecting browser, `walkFrom` returns
    // before `watch(rootHandle, true)`, so the workspace never reaches
    // `staleWorkspaces` and no eviction event would ever clear a failure cap;
    // giving up would deny every document there for the life of the process.
    // Exponential backoff bounds the retry cost instead.
    const failures = this.routeBackfillFailures.get(workspace) ?? 0
    const cooldown = STALE_REPAIR_MIN_INTERVAL_MS * Math.min(2 ** failures, 32)
    const now = this.clock()
    if (now - (this.routeBackfillAttemptedAt.get(workspace) ?? Number.NEGATIVE_INFINITY) < cooldown) return
    this.routeBackfillAttemptedAt.set(workspace, now)
    void (async () => {
      // Sequence behind a pending gate-miss invalidation (the stored promise
      // is already caught): the CAS witness below must observe the bump, or
      // the re-cover would CAS against a stale counter, refuse, and leave the
      // workspace de-covered until its next attach.
      await this.pendingCoverageInvalidations.get(workspace)
      // The CAS witness is observed BEFORE the walk starts, so an
      // invalidation landing mid-walk bumps past it and the re-cover below
      // refuses. A failed read only skips the re-cover (conservative), never
      // the walk itself.
      const observed = this.durable
        ? await readWorkspaceCoverageInvalidations(this.pool, key).catch(() => null)
        : null
      await this.walkWithinDeadline(this.backfillWorkspaceRoute(key), workspace)
      return observed
    })()
      .then((observed) => {
        this.routeBackfillFailures.delete(workspace)
        // Belt and braces: `backfillWorkspaceRoute` already rejects an
        // incomplete walk, but `walk()` swallows unreadable documents, so a
        // resolved walk is not automatically a complete one.
        if (this.byWorkspace.get(workspace)?.controlDocsComplete) {
          this.announceIndexRepaired(key)
          // The coverage marker is posed by the walk's CALLER, after the pass
          // completed in full (a pass reporting from inside itself reports only
          // how far it got), and only when every control document was read.
          this.coverAfterCompleteWalk(key, observed)
        }
      })
      .catch((err) => {
        this.routeBackfills.delete(workspace)
        const failures = (this.routeBackfillFailures.get(workspace) ?? 0) + 1
        this.routeBackfillFailures.set(workspace, failures)
        console.warn(
          `[docScope] workspace route backfill failed for ${workspace} (attempt ${failures}, `
          + `next retry in ${STALE_REPAIR_MIN_INTERVAL_MS * Math.min(2 ** failures, 32)}ms):`,
          err,
        )
      })
  }

  /** Repair legacy assignment gaps from one socket's already-authenticated,
   * canonical route. Only trusted control documents are hydrated: root,
   * ModelMeta and registry shards. Leaf model/shard/diagram URLs are claimed
   * from those manifests without loading their content, allowing the browser
   * that still has the leaf in IndexedDB to upload it after a cold restart.
   * A successful scan is memoized per workspace so arbitrary unknown document
   * ids cannot repeatedly force graph traversal. */
  async backfillWorkspaceRoute(key: WorkspaceKey): Promise<void> {
    const workspace = keyOf(key)
    const existing = this.routeBackfills.get(workspace)
    if (existing) return existing

    const repair = (async () => {
      const { rows } = await this.pool.query<{ root_url: string }>(
        `SELECT root_url FROM versions
         WHERE landscape_id = $1 AND id = $2`,
        [key.landscapeId, key.versionId],
      )
      const rootUrl = rows[0]?.root_url
      if (!rootUrl) return
      await this.ensureWorkspace(key, rootUrl)
      // A walk that could not read the control documents attached no listeners,
      // so there is nothing to memoize. `walk()` never throws on an unreadable
      // document — `find()` records the failure and returns null — so without
      // this check the promise RESOLVES, the memo below survives, and
      // `scheduleWorkspaceRouteBackfill` becomes a permanent no-op for a
      // workspace that is in exactly the state that most needs repairing.
      if (!this.byWorkspace.get(workspace)?.controlDocsComplete) {
        throw new Error(`docScope: walk for ${workspace} did not restore its control documents`)
      }
    })()
    this.routeBackfills.set(workspace, repair)
    try {
      await repair
    } catch (error) {
      if (this.routeBackfills.get(workspace) === repair) {
        this.routeBackfills.delete(workspace)
      }
      throw error
    }
  }

  /** Whether `documentId` is the canonical root of a static/read-model-backed
   * workspace. The common child-document path is an in-memory comparison; only
   * the rare root path performs one cached SQL existence check. */
  async isServerManagedRoot(documentId: string, workspace?: WorkspaceKey | null): Promise<boolean> {
    const resolved = workspace ?? await this.resolveDocWorkspace(documentId)
    if (!resolved) return false
    const entry = this.byWorkspace.get(keyOf(resolved))
    // Canonicalise, for the same reason `reference()` does: `isValidAutomergeUrl`
    // accepts a heads section and a path, so stripping only the prefix yields a
    // string that is not the document id. Here the comparison direction makes the
    // consequence FAIL-OPEN — a decorated `root_url` would read as "not
    // server-managed" and let a browser overwrite a static workspace's root,
    // erasing `modelMetaUrl`/`shardUrls` (see `buildWriteCheck`). Every current
    // writer of `versions.root_url` stores a server-generated `handle.url`, so
    // this is latent, but the rule must hold in both places.
    if (!entry) return false
    const canonicalRoot = isValidAutomergeUrl(entry.rootUrl)
      ? String(interpretAsDocumentId(entry.rootUrl as AutomergeUrl))
      : entry.rootUrl.replace(/^automerge:/, '')
    if (canonicalRoot !== documentId) return false
    if (entry.serverManagedRoot !== null) return entry.serverManagedRoot
    if (!this.durable) return false
    const { rows } = await this.pool.query<{ managed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM read_model_static_workspaces
         WHERE landscape_id = $1 AND version_id = $2
       ) AS managed`,
      [resolved.landscapeId, resolved.versionId],
    )
    entry.serverManagedRoot = rows[0]?.managed === true
    return entry.serverManagedRoot
  }

  private allWalked: Promise<void> | null = null

  /** Walk every version's workspace at least once. Memoized per-process (the
   * incremental listeners keep things fresh after this first pass); a caller
   * that wants to force a re-check of a specific workspace should rely on the
   * 'change' listeners rather than calling this repeatedly. */
  private async ensureAllWorkspacesWalked(): Promise<void> {
    if (this.allWalked) return this.allWalked
    const scan = (async () => {
      const rows = await this.listVersionRows()
      await Promise.all(rows.map((r) => this.ensureWorkspace({ landscapeId: r.landscapeId, versionId: r.versionId }, r.rootUrl)))
    })()
    this.allWalked = scan
    try {
      await scan
    } catch (error) {
      // Retry only after a failed catalog walk. Successful negative lookups
      // must stay memoized: Automerge can ask repeatedly about an unlinked doc,
      // and replaying every workspace graph for each miss causes unbounded
      // handle churn and memory growth. New workspaces are primed directly by
      // notifyWorkspaceCreated through the constructor registration above.
      if (this.allWalked === scan) this.allWalked = null
      throw error
    }
  }

  /** For tests/diagnostics: the doc ids currently indexed for a workspace. */
  docIdsFor(key: WorkspaceKey): Set<string> {
    return new Set(this.byWorkspace.get(keyOf(key))?.docIds ?? [])
  }
}

// =====================================================================
// allowedWorkspaceKeys / writableWorkspaceKeys — per-user access
// resolution, cached briefly. One query computes BOTH the readable and the
// writable key sets (rbac_effective_access returns can_read + can_write in
// the same row), so adding the write dimension costs no extra round trip.
// =====================================================================

interface WorkspaceKeySets {
  read: Set<string>
  write: Set<string>
}

interface CacheEntry {
  keys: WorkspaceKeySets
  expiresAt: number
}

const ALLOWED_KEYS_TTL_MS = 30_000
const allowedKeysCache = new Map<string, CacheEntry>()
const allowedKeysInFlight = new Map<string, { generation: number; promise: Promise<WorkspaceKeySets> }>()
let allowedKeysGeneration = 0

function cacheKey(userId: string, epoch: number): string {
  return `${userId}#${epoch}`
}

/** Clear the cache — exported for tests only (no production caller needs this;
 * grant changes bump the epoch, which naturally changes the cache key). */
export function _clearAllowedWorkspaceKeysCacheForTests(): void {
  allowedKeysGeneration += 1
  allowedKeysCache.clear()
  allowedKeysInFlight.clear()
}

/**
 * Drop every cached per-user allowed-keys entry. Called when a WORKSPACE IS
 * CREATED (landscape / version / draft): the creator's cached set predates the
 * new scope row, and the epoch-bump invalidation only helps on reconnect — the
 * live session's next HTTP call still carries the old epoch, so without this
 * the creator 403s out of their own brand-new workspace for up to the TTL
 * (e.g. `GET /api/automerge/root` right after creating a landscape). Cheap: creates are rare and the cache rebuilds in one query per user.
 */
export function invalidateAllowedWorkspaceKeysCache(): void {
  allowedKeysGeneration += 1
  allowedKeysCache.clear()
  allowedKeysInFlight.clear()
}

async function workspaceKeySets(pool: Pool, claims: SessionClaims): Promise<WorkspaceKeySets> {
  const ck = cacheKey(claims.userId, claims.epoch)
  for (;;) {
    const cached = allowedKeysCache.get(ck)
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached.keys

    const generation = allowedKeysGeneration
    let flight = allowedKeysInFlight.get(ck)
    if (!flight || flight.generation !== generation) {
      const promise = computeWorkspaceKeySets(pool, claims)
      flight = { generation, promise }
      allowedKeysInFlight.set(ck, flight)
      const clear = () => {
        if (allowedKeysInFlight.get(ck) === flight) allowedKeysInFlight.delete(ck)
      }
      void promise.then(clear, clear)
    }

    const keys = await flight.promise
    // A grant/workspace invalidation that raced the SQL read must not put its
    // stale answer back in cache or return it to the upgrade being admitted.
    if (flight.generation !== allowedKeysGeneration) continue
    allowedKeysCache.set(ck, { keys, expiresAt: Date.now() + ALLOWED_KEYS_TTL_MS })
    return keys
  }
}

/**
 * Resolve the set of workspace keys (`"landscapeId/versionId"`) a session may
 * READ, given its claims. Platform admin -> every version in the DB. Otherwise:
 * for each version's scope, `rbac_effective_access` decides (org-admin of that
 * version's org, or a team grant with can_read anywhere on the ancestor chain).
 *
 * Cached per (userId, epoch) for ALLOWED_KEYS_TTL_MS — short enough that a
 * revoked grant is reflected quickly, and grant changes bump the org's
 * auth_epoch anyway (which changes the session's epoch on reconnect, which
 * changes the cache key), so staleness is bounded by the smaller of the TTL
 * or the epoch-revocation path in wsAuth.ts.
 *
 * Bounded by a deadline, as a gate-liveness requirement: this is the LAST
 * await on both RBAC gate chains, and brand-new documents (a bulk import's
 * burst) reach it. Against a hung pool, an unbounded wait gives NO VERDICT AT
 * ALL — worse than a refusal, because `stageAwareAccessCheck` awaits the raw
 * check and automerge-repo pins whatever it makes of a policy promise that
 * never settles.
 *
 * The ceiling is applied HERE and not inside `workspaceKeySets`, because the
 * in-flight entry there is SHARED: wrapping it would make whichever caller
 * happened to create the flight impose its deadline on everyone who joins it.
 * A timeout leaves the underlying flight running, so it still populates the
 * cache for the next caller. The rejection lands in the gates' `gateFault`,
 * which denies AND requests re-evaluation, so the deny lasts only as long as
 * the fault does.
 */
export async function allowedWorkspaceKeys(
  pool: Pool,
  claims: SessionClaims,
  deadlineMs: number = WORKSPACE_KEY_SETS_DEADLINE_MS,
): Promise<Set<string>> {
  return (await settleWithinDeadline(
    workspaceKeySets(pool, claims), deadlineMs, 'workspace key sets (read)',
  )).read
}

/**
 * The workspace keys a session may WRITE — the enforcement input for the sync
 * write gate (automergeServer.ts) and the REST write gates (workspaceGate.ts).
 * Same source of truth as the read set (`rbac_effective_access`): org admins
 * and platform admins write everywhere in their reach; otherwise a team grant
 * with `can_write` (on the version scope or any ancestor) is required — write
 * NEVER comes from mere org membership, and a read-only ("View") grant never
 * confers it. Shares the read set's cache entry and epoch semantics.
 */
export async function writableWorkspaceKeys(
  pool: Pool,
  claims: SessionClaims,
  deadlineMs: number = WORKSPACE_KEY_SETS_DEADLINE_MS,
): Promise<Set<string>> {
  return (await settleWithinDeadline(
    workspaceKeySets(pool, claims), deadlineMs, 'workspace key sets (write)',
  )).write
}

async function computeWorkspaceKeySets(pool: Pool, claims: SessionClaims): Promise<WorkspaceKeySets> {
  const out: WorkspaceKeySets = { read: new Set<string>(), write: new Set<string>() }

  // Suspended-org exclusion: a suspended org's workspaces are unreadable even
  // for a PLATFORM ADMIN's own session bound to that org — platform admins
  // still see every OTHER org's workspaces via the branch below, matching the
  // "platform admin -> every version" behavior for orgs that aren't suspended.
  // (Login itself is separately refused for a suspended org — see
  // devLogin.ts/oidc.ts — this is the belt-and-suspenders read path.) LEFT
  // JOIN (not INNER) on scopes/orgs: a version whose scope row hasn't been
  // registered yet (e.g. before `ensureScopesForExistingWorkspaces` ran)
  // must still be visible to a platform admin — "no scope row" is not the
  // same signal as "org is suspended", and the whole point of the platform
  // admin bypass is to never depend on the RBAC grant machinery being
  // fully populated.
  if (claims.isPlatformAdmin) {
    const { rows } = await pool.query<{ id: string; landscape_id: string }>(
      `SELECT v.id, v.landscape_id
       FROM versions v
       LEFT JOIN scopes s ON s.kind = 'version' AND s.landscape_id = v.landscape_id AND s.version_id = v.id
       LEFT JOIN orgs o ON o.id = s.org_id
       WHERE o.status IS NULL OR o.status <> 'suspended'`
    )
    for (const r of rows) {
      const k = keyOf({ landscapeId: r.landscape_id, versionId: r.id })
      out.read.add(k)
      out.write.add(k)
    }
    return out
  }

  // rbac_effective_access(user, scope, resourceType) already encodes the
  // org-admin bypass AND the team-grant/ancestor-inheritance fallback (see
  // rbac/schema.ts). One query per version keeps this simple and correct;
  // callers hit the cache above on the hot (per-connection) path so this
  // cost is amortized, not per-message. `o.status <> 'suspended'` excludes a
  // suspended org's workspaces regardless of what the grant table says.
  const { rows } = await pool.query<{ id: string; landscape_id: string; can_read: boolean; can_write: boolean }>(
    `SELECT v.id, v.landscape_id,
            bool_or(coalesce(a.can_read, false)) AS can_read,
            bool_or(coalesce(a.can_write, false)) AS can_write
     FROM versions v
     LEFT JOIN scopes s ON s.kind = 'version' AND s.landscape_id = v.landscape_id AND s.version_id = v.id
     LEFT JOIN orgs o ON o.id = s.org_id
     LEFT JOIN LATERAL rbac_effective_access($1, s.id, '*') a ON true
     WHERE o.status IS NULL OR o.status <> 'suspended'
     GROUP BY v.id, v.landscape_id`,
    [claims.userId]
  )
  for (const r of rows) {
    const k = keyOf({ landscapeId: r.landscape_id, versionId: r.id })
    if (r.can_read) out.read.add(k)
    if (r.can_write) out.write.add(k)
  }
  return out
}

// =====================================================================
// accessCheck composer — wires the doc index + identity registry into the
// raw `(peerId, documentId) -> allowed?` shape `selectiveSync.ts` expects.
// =====================================================================

/** Structural subset of `ConnectionRegistry` (auth/wsAuth.ts) — declared here
 * instead of importing that module to avoid a cycle (wsAuth.ts doesn't import
 * docScope.ts, but automergeServer.ts wires both together; keeping this
 * interface local means docScope.ts has zero dependency on wsAuth.ts either
 * way, which is the safer direction — the doc index is the more fundamental
 * piece). */
export interface PeerIdentityLookup {
  identityForPeer(peerId: string): SessionClaims | null | undefined
  workspaceForPeer?(peerId: string): WorkspaceKey | null | undefined
}

/**
 * Where `documentId` is PLACED for a peer routed to `route`: the durable index,
 * or — only when the index has no answer — the mint, whose MAC is the server's
 * own signature that it named this document for this workspace.
 *
 * PLACEMENT, NEVER PERMISSION. Every caller runs its RBAC chain afterwards;
 * this decides only WHICH workspace those grants are checked against.
 *
 * `if (durable) return durable` FIRST is load-bearing security, not an
 * optimisation. The durable row is first-owner-wins, so letting a MAC override
 * it would attach one document to two versions: an id minted for (L,V1) and
 * first presented on a socket canonicalised to (L,V2) is claimed for V2 by the
 * route gate's `displaced` path, and a peer later routed to V1 still carries a
 * MAC that reads `bound`. The index answer wins; the mint only fills a HOLE.
 *
 * Synchronous verification only. `verifyDocumentIdWithDisplacement` would settle
 * that repoint case too, but it needs SQL and a claim write, and this runs on
 * the write gate's PER-MESSAGE path where no authorization decision may await
 * it. A displaced id therefore reads `foreign` here and is refused — handled
 * instead by the route gate, which resolves once per document rather than once
 * per message.
 *
 * Keep this rule in this one function; copies of it drift.
 */
export async function resolveDocumentPlacement(
  index: Pick<WorkspaceDocIndex, 'resolveDocWorkspace'>,
  route: WorkspaceKey | null | undefined,
  documentId: string,
): Promise<WorkspaceKey | null> {
  const durable = await index.resolveDocWorkspace(documentId)
  if (durable) return durable
  return route && verifyDocumentId(route, documentId).kind === 'bound' ? route : null
}

function sameWorkspace(a: WorkspaceKey, b: WorkspaceKey): boolean {
  return a.landscapeId === b.landscapeId && a.versionId === b.versionId
}

/** Transport-level isolation, independent of RBAC: a routed socket may only
 * exchange documents durably assigned to its canonical workspace. */
export function buildWorkspaceRouteCheck(
  index: WorkspaceDocIndex,
  registry: Pick<PeerIdentityLookup, 'workspaceForPeer'>,
  routeRequired: boolean,
  /** Faults are reported here so a fail-closed verdict is not mistaken for a
   * refusal. See `gateFault`. `displacedScanDeadlineMs` bounds the displaced
   * branch's SQL wait — injectable so the liveness table can drive it; the
   * production default is {@link DISPLACED_SCAN_DEADLINE_MS}. */
  options: { onFault?: GateFaultReporter; displacedScanDeadlineMs?: number } = {},): (peerId: string, documentId: string) => Promise<boolean> {
  const displacedDeadlineMs = options.displacedScanDeadlineMs ?? DISPLACED_SCAN_DEADLINE_MS
  return async (peerId, documentId) => {
    const route = registry.workspaceForPeer?.(peerId)
    if (route === undefined || route === null) return !routeRequired
    // NEVER await the backfill here. This function runs inside three callers
    // that cannot tolerate it: `syncWriteGate`'s per-socket FIFO,
    // `diagramPresenceGate`'s FIFO, and automerge-repo's
    // `DocSynchronizer.#resolveSharePolicy` (awaited by `addPeer` while the
    // peer's first message waits in `pendingMessages`). The backfill walks the
    // workspace graph with `repo.find()`, and for a document the browser just
    // created the only supplier is that same peer — whose reply is queued
    // behind this decision. Awaiting here wedges the connection permanently.
    // Schedule the repair, deny this message, and let the repair's completion
    // hook re-open the door (see `onWorkspaceIndexRepaired`).
    try {
      // Workspace-bound document ids: the fast path.
      //
      // `route` is the workspace the SERVER assigned this socket at
      // authentication, not something the peer asserts, so recomputing the tag
      // over it answers "is this document bound to the workspace this peer is
      // actually on" with no database read, no graph, and nothing to await —
      // the rule that no authorization decision on the inbound sync path may
      // await an Automerge document, satisfied by construction.
      //
      // Note what this decides and what it does not: WHICH WORKSPACE a document
      // belongs to. Whether this peer may read or write that workspace stays
      // entirely in `buildAccessCheck` / `buildWriteCheck` / RBAC — which is what
      // keeps revocation working, and why a minted id in a removed member's hands
      // grants nothing.
      //
      // `foreign` must not fall through. An id that CLAIMS a binding, to a
      // workspace other than this peer's, is answered — consulting the index
      // after that could only ever admit it for some unrelated reason.
      const minted = verifyDocumentId(route, documentId)
      if (minted.kind === 'bound') {
        // THE INDEX ANSWER WINS; THE MINT ONLY FILLS A HOLE (the
        // `resolveDocumentPlacement` rule). The case it guards is a repoint:
        // the `current` alias moves from V1 to V2, a socket routed to V2 claims
        // a V1-minted id for V2 (the `displaced` branch), and then a socket
        // still routed to V1 presents that same id. The MAC still verifies
        // `bound` for V1, so without this check a peer scoped to V1 would be
        // served a document durably owned by V2.
        //
        // Synchronous and cache-only: `peekDocWorkspace` reads process memory,
        // so this adds no await to the admission path. A document THIS PROCESS
        // has never placed reads `null` and is admitted; that limit is
        // described on `peekDocWorkspace`.
        const placed = index.peekDocWorkspace(documentId)
        if (placed && !sameWorkspace(placed, route)) return false
        // Hand the STORAGE FENCE the placement this gate just decided, before
        // the claim below has had a chance to write it down. Synchronous, and
        // it must stay above the claim: `withFencedMutation` reads "no mapping
        // row" as "nobody to check the lease against" and admits the mutation
        // unconditionally — `removeRange` included, which deletes every chunk
        // of the document. A document admitted here is a document with no row
        // yet, so this branch is precisely the one that opens that window.
        //
        // Only HERE, not in the displaced branch below: that one AWAITS its
        // claim, so the durable row exists before it returns and the fence has
        // its own operand.
        index.noteProvisionalPlacement(route, documentId)
        // Not awaited, and not part of the verdict: the MAC already decided.
        // This backfills the durable row for every OTHER reader of
        // `automerge_document_workspace` — the projector, the residency snapshot,
        // the reference-integrity scan. Awaiting it here would put a database
        // round trip back on the admission path.
        void index.claimVerifiedDocument(route, documentId).catch((error) => {
          console.warn('[docScope] could not record a verified minted document', route, documentId, error)
        })
        return true
      }
      if (minted.kind === 'foreign') {
        // The mismatch splits in two (foreign vs displaced). The scan runs only
        // AFTER `verifyDocumentId`'s anti-DoS guards (length, type, bounded
        // decode, version byte) already proved this a well-formed minted id:
        // garbage stays O(1) `unminted` above and never reaches this branch.
        // Everything awaited here is SQL under a wall-clock ceiling — never an
        // Automerge document — and a rejection (deadline included) falls to the
        // gateFault catch below: a fail-closed verdict plus a re-evaluation
        // request, never an escaped exception.
        return await settleWithinDeadline((async () => {
          const refined = await verifyDocumentIdWithDisplacement(
            route, documentId, (landscapeId) => index.listLandscapeVersionIds(landscapeId))
          if (refined.kind !== 'displaced') {
            // INTER-LANDSCAPE (or the list raced a deletion): the hard deny,
            // answered without consulting the index. No lift is owed: this
            // verdict holds for as long as the id exists, and the same id
            // verifies `bound` the moment its holder connects routed to the
            // landscape it was minted for.
            return false
          }
          // DISPLACED: same landscape, sibling version — the repoint shape. The
          // MAC has answered WHICH LANDSCAPE; version placement inside it
          // belongs to the durable first-owner-wins table, seeded by the route
          // its first presenter arrived on. `claimVerifiedDocument` is that
          // consultation and that seed in one atomic step:
          //  - no row yet -> claimed for THIS socket's canonical route, admit,
          //    and the claim ANNOUNCES (repo.shareConfigChanged) so any deny
          //    pinned before the row existed is lifted;
          //  - row held by a sibling version -> deny. Deny pairing: lifted by
          //    the peer RECONNECTING on the owning route (a fresh peerId gets a
          //    virgin share-policy cache) — the same lift as the legacy
          //    `sameWorkspace` mismatch below — and the losing claim has just
          //    announced for the winner's workspace, whose peers may hold the
          //    pinned denies that row's arrival resolves.
          return index.claimVerifiedDocument(route, documentId)
        })(), displacedDeadlineMs, `displaced scan for ${documentId} on ${route.landscapeId}/${route.versionId}`)
      }
      const documentWorkspace = await index.resolveDocWorkspace(documentId)
      if (!documentWorkspace) {
        // Counted HERE, at the miss site — every occurrence, including repeats
        // the licence in `noteRouteGateMiss` will dedupe.
        recordDocScopeGateMiss()
        // Under claim-at-write, a document this route presents and the index
        // cannot place means the coverage marker is wrong. `noteRouteGateMiss`
        // de-covers durably (void, never in the verdict), purges the repair
        // memo and schedules the walk. The deny is lifted by the repair's
        // announce, or the denyLedger's re-evaluation.
        index.noteRouteGateMiss(route, documentId)
        return false
      }
      return sameWorkspace(route, documentWorkspace)
    } catch (error) {
      return gateFault(index, route, 'workspace-route', peerId, documentId, error, options.onFault)
    }
  }
}

/**
 * Build the raw RBAC decision function for `createSelectiveSync`'s
 * `accessCheck` param (wrap with `stageAwareAccessCheck` from selectiveSync.ts
 * before passing it in — this function itself is stage-agnostic, it always
 * computes the "true" RBAC answer):
 *
 *   1. `identityForPeer(peerId)` — unknown peer (never authenticated a socket
 *      for it) -> DENY. `undefined` here specifically means "we have no idea
 *      who this is", distinct from `null` (authenticated at stage off/dual
 *      with no session — see below).
 *   2. claims === null (stage off/dual, no session) -> DENY under a strict
 *      read of "default-deny at the sync boundary" UNLESS the caller is
 *      running at stage 'off'/'dual', in which case `stageAwareAccessCheck`
 *      never even asks this function (short-circuits to true) — so reaching
 *      this function with null claims only happens transiently between
 *      "stage just flipped to on" and "the socket reconnects", where denying
 *      is correct.
 *   3. Platform admin (claims.isPlatformAdmin) -> ALLOW inside the socket's
 *      routed workspace (legacy sockets retain the pre-routing behavior).
 *   4. `resolveDocWorkspace(documentId)` -> null (doc not yet indexed / not
 *      linked into any known workspace) -> DENY (this IS the default-deny
 *      quarantine for unplaceable docs the plan calls for — the doc becomes
 *      servable the moment its parent link syncs and the incremental walker
 *      picks it up).
 *   5. Otherwise: `allowedWorkspaceKeys(pool, claims)` must contain the
 *      resolved workspace's key.
 */
export function buildAccessCheck(
  pool: Pool,
  index: WorkspaceDocIndex,
  registry: PeerIdentityLookup,
  /** Faults are reported here so a fail-closed verdict is not mistaken for a
   * refusal. See `gateFault`. */
  options: { onFault?: GateFaultReporter; keySetsDeadlineMs?: number } = {},): (peerId: string, documentId: string) => Promise<boolean> {
  return async (peerId, documentId) => {
    const claims = registry.identityForPeer(peerId)
    if (claims === undefined) return false // unknown peer — never authenticated
    if (claims === null) return false // authenticated with no session (stage off/dual reaching here is transient)
    const route = registry.workspaceForPeer?.(peerId)
    try {
      // Placement honours the mint (`resolveDocumentPlacement`) — and this is
      // the gate where that matters most, because automerge-repo caches THIS
      // verdict per (document, peer) at `#activatePeer`.
      //
      // `createDocumentAccessCheck` composes routeCheck THEN this one. The
      // route check admits a `bound` id and fires `claimVerifiedDocument`
      // WITHOUT awaiting it, deliberately, so that no database round trip sits
      // on the admission path — which makes the row this gate reads the one
      // still in flight. Without the mint here, this gate would withdraw the
      // route gate's placement a microtask later. That deny would self-lift
      // (the claim announces), but at the cost of one whole-repo policy
      // fan-out per created document — the storm during a bulk import — and
      // with a misclassification risk: `createDocumentAccessCheck` takes a
      // SECOND lookup after the denial, so a claim landing in that window
      // files the deny as a permanent `rbac` one (denyLedger.ts).
      const workspace = await resolveDocumentPlacement(index, route, documentId)
      if (workspace && route && !sameWorkspace(route, workspace)) return false
      if (claims.isPlatformAdmin && (!route || workspace)) return true
      if (!workspace) return false // unindexed/unlinked doc — quarantined by default

      const allowed = await allowedWorkspaceKeys(pool, claims, options.keySetsDeadlineMs)
      return allowed.has(keyOf(workspace))
    } catch (error) {
      return gateFault(index, route, 'rbac-read', peerId, documentId, error, options.onFault)
    }
  }
}

/**
 * The WRITE-side twin of `buildAccessCheck`, consumed by the sync write gate
 * (`syncWriteGate.ts` via automergeServer.ts): may this peer MUTATE this doc?
 * Same resolution chain (peer -> claims -> doc -> workspace) with the same
 * default-deny posture — unknown peer, sessionless socket, or unindexed doc
 * can never write — but the final membership test is against
 * `writableWorkspaceKeys`, so a read-only ("View") grant passes the read gate
 * yet fails here. Stage-agnostic like its twin: it always computes the true
 * RBAC answer, and the caller decides whether to enforce or only log it.
 */
export function buildWriteCheck(
  pool: Pool,
  index: WorkspaceDocIndex,
  registry: PeerIdentityLookup,
  /** Faults are reported here so a fail-closed verdict is not mistaken for a
   * refusal. See `gateFault`. */
  options: { onFault?: GateFaultReporter; keySetsDeadlineMs?: number } = {},): (peerId: string, documentId: string) => Promise<boolean> {
  return async (peerId, documentId) => {
    const claims = registry.identityForPeer(peerId)
    if (claims === undefined) return false // unknown peer — never authenticated
    if (claims === null) return false // sessionless socket — reads may pass at off/dual, writes never
    const route = registry.workspaceForPeer?.(peerId)
    try {
      // Placement honours the mint (`resolveDocumentPlacement`). The write side
      // needs it for a different reason than the read side: ORDER.
      // `AuthenticatedWSServerAdapter.emit` runs ownership -> fence -> WRITE ->
      // repo, and the route check lives in the share policy INSIDE the repo. So
      // for any frame that CARRIES CHANGES this gate answers first, before
      // anything has had the chance to place the document, and at stage 'on' a
      // denial DROPS that frame: never applied, never persisted, never relayed.
      // A brand-new document's first change-bearing frames are precisely the
      // ones at risk.
      //
      // (The OPENING sync frame is heads+bloom with no changes, so it passes
      // `messageCarriesChanges` and reaches the route check first.)
      //
      // Placement must stay ABOVE `isServerManagedRoot` below. On a static or
      // promoted workspace `resolveDurable` answers null for EVERY document
      // absent from `read_model_static_documents`, so the mint branch fires
      // there for ordinary documents too — and the server-managed-root refusal
      // is then the only thing standing between a minted id and a stale root
      // snapshot erasing `modelMetaUrl`/`shardUrls`. The ordering is pinned by
      // docScope.writeMinted.test.ts ("placement runs BEFORE the
      // server-managed-root refusal").
      const workspace = await resolveDocumentPlacement(index, route, documentId)
      if (workspace && route && !sameWorkspace(route, workspace)) return false
      // Summary-only/static roots are server-owned manifests. Browser writes to
      // their diagram/model/registry children remain allowed, but accepting a
      // stale root snapshot can erase modelMetaUrl/shardUrls and corrupt every
      // subsequent cold load. This invariant also applies to platform admins.
      if (workspace && await index.isServerManagedRoot(documentId, workspace)) return false
      if (claims.isPlatformAdmin && (!route || workspace)) return true
      if (!workspace) return false // unindexed/unlinked doc — quarantined by default

      const writable = await writableWorkspaceKeys(pool, claims, options.keySetsDeadlineMs)
      return writable.has(keyOf(workspace))
    } catch (error) {
      return gateFault(index, route, 'rbac-write', peerId, documentId, error, options.onFault)
    }
  }
}

// ============================================================================
// The BASELINE WRITE FENCE — the server-side lock for summary workspaces (the
// client flag alone is not enough).
//
// On a workspace that has a `read_model_static_workspaces` row (sparse draft,
// performance fixture, or a promoted ordinary landscape), the BASELINE
// documents — the base model shards and the frozen registry shards — are
// server-owned: the read model serves their content, the client edits through
// overlays and the registry write head, and nothing legitimate ever mutates
// the baseline over the sync socket. A stale classic tab, a client built
// without the flags, or a downgraded client would "reconcile" its windowed
// store into those documents and destroy the baseline — so the fence refuses
// those mutations at the wire.
//
// What this is NOT: an admission/share-policy deny. The refusal is a
// per-message DROP inside `syncWriteGate` — reads stay fully alive, nothing is
// pinned per (document, peer), so no `shareConfigChanged()` lift is owed (the
// "lift" is simply the next sync round). The refusal is still VISIBLE: the
// server never applies the change, so it never announces heads containing it,
// the client's durable ack never arrives, and the sync badge stays in its
// "saving" state.
// ============================================================================

/**
 * The ONE predicate for "is this static-allow-list kind part of the frozen
 * baseline?". Kinds are written by the static allow-list producers (the
 * performance seed, sparse drafts, root repair): baseline = the base model shards
 * (`object-base`, `connection-base`, `decision-record-base`, and any future
 * `*-base`) plus the frozen baseline registry shards (`registry`). Everything
 * else stays writable: `registry-shard` (the write head), the edit overlays,
 * `diagram`, `model-meta`, `root` (the root has its own server-managed-root
 * refusal), `model-legacy`, and any document absent from the allow-list —
 * an unlisted document is by definition not baseline.
 */
export function isBaselineDocumentKind(kind: string): boolean {
  return kind === 'registry' || kind.endsWith('-base')
}

/** Uniform TTL for both fence caches. Short on purpose: it is the arming bound
 * after a promotion commits its allow-list (≤ one TTL for the static-world
 * bit + one for the doc verdict) and the disarming bound after a de-promotion
 * deletes it. Plain literal — same NaN trap as above. */
export const BASELINE_FENCE_TTL_MS = 5_000
/** Bound on the per-document verdict cache. Cleared wholesale when exceeded —
 * the deniedAt precedent: it is a cache, losing it costs one re-read per doc. */
export const BASELINE_FENCE_MAX_ENTRIES = 20_000
/** Grace for serving the last SUCCESSFULLY observed static-world bit while
 * its refresh is FAULTING — 10×{@link BASELINE_FENCE_TTL_MS}. Only the
 * "no static world" value is ever served stale (see `anyStaticWorkspace`),
 * and only within this window; past it, or for the per-document lookup, the
 * fence stays strictly fail-closed. Long enough to ride out a pool failover,
 * bounded because the fault may be OURS alone — this process partitioned from
 * a healthy database that another server is still promoting into. Plain
 * literal — same NaN trap. */
export const BASELINE_FENCE_STALE_BIT_GRACE_MS = 50_000
/** Wall ceiling on each fence SQL statement. The fence runs inside
 * `syncWriteGate`'s per-socket FIFO, so a wedged pool must become a bounded
 * fail-closed verdict, never a frozen connection (the liveness invariant of
 * docScope.gateLiveness.test.ts). Plain literal — same NaN trap. */
export const BASELINE_FENCE_LOOKUP_DEADLINE_MS = 5_000

/**
 * How long after a promotion's COMMIT this fence may still be answering from
 * PRE-commit state — i.e. the window a promotion must wait out before it flips
 * the root (`promoteSummaryWorkspace`, step 5). Exported from HERE, next to the
 * caches it is derived from, so a change to either TTL cannot leave the
 * promotion waiting the wrong length.
 *
 * NOT one TTL, which would be too short. Two caches sit in series in front of a baseline write, and neither refresh is
 * synchronised with the promotion's commit:
 *
 *  - the GLOBAL static-world bit, cached for one {@link BASELINE_FENCE_TTL_MS}.
 *    Refreshed a moment before the commit it answers "no static world" — so
 *    `isFencedDocument` is not even consulted — for up to one full TTL after it.
 *  - the PER-DOCUMENT verdict, also cached for one TTL, but its expiry is
 *    stamped when its in-flight query SETTLES, and that flight has its own
 *    ceiling of {@link BASELINE_FENCE_LOOKUP_DEADLINE_MS}. A lookup started an
 *    instant before the commit can therefore cache "not fenced" until
 *    commit + deadline + TTL.
 *
 * Summing the two is deliberately CONSERVATIVE: on any single message only one
 * of the branches is taken (an "absent" bit skips the document lookup entirely),
 * so the true worst case is `TTL + LOOKUP_DEADLINE` on a stack that already has
 * a static world and `TTL` on one that does not. The sum costs one extra TTL,
 * once, per promotion — and it removes the need to prove which branch every
 * server in the fleet happened to be on at the moment of the commit.
 *
 * ⚠ NOT covered, deliberately: {@link BASELINE_FENCE_STALE_BIT_GRACE_MS}. A
 * server whose static-world refresh is FAULTING may serve its last good
 * "absent" bit for up to the grace (+ one TTL) — 55 s. Waiting that out on
 * every promotion would price the healthy path at the faulting one's cost, and
 * the grace only ever applies to an instance that cannot reach this database at
 * all — the same instance that cannot see the promotion by any other means
 * either. A promotion run while a server is partitioned from the database is
 * not made safe by waiting; it is made safe by that server failing closed when
 * it reconnects.
 */
export const BASELINE_FENCE_ARMING_BOUND_MS =
  2 * BASELINE_FENCE_TTL_MS + BASELINE_FENCE_LOOKUP_DEADLINE_MS

/** Postgres undefined_table. A stack whose schema migrations never created the
 * static tables HAS no static workspaces — allowing is correct, not lenient. */
function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '42P01'
}

/** The fence verdict function, plus a test witness: the per-document verdict
 * cache bound (`maxDocVerdicts` / {@link BASELINE_FENCE_MAX_ENTRIES}) is only
 * real if a test can watch the cache actually shrink. Test-only — production
 * consumes the call signature exclusively. */
export interface BaselineWriteFence {
  (peerId: string, documentId: string): Promise<boolean>
  _docVerdictCountForTests(): number
}

/**
 * Build the baseline write fence: `(peerId, documentId) -> may this mutation
 * pass?` — consumed by `createSyncWriteGate` (automergeServer.ts) as an
 * ALWAYS-ON gate, independent of the AUTH stage: the fence is a property of
 * the DOCUMENT, not of the peer, and it must hold for exactly the clients that
 * predate the flags (RBAC's `buildWriteCheck` only enforces at stage 'on').
 *
 * The verdict is reached from PostgreSQL and process memory ONLY — never from
 * an Automerge document (the standing rule; the gateLiveness table enforces
 * it), and every statement runs under a wall-clock ceiling:
 *
 *   1. the STATIC-WORLD BIT — "does any `read_model_static_workspaces` row
 *      exist at all?" — cached process-wide for the TTL. A stack with no
 *      static workspaces (any ordinary deployment) answers every
 *      message from this one cached bit: zero per-document SQL, which is what
 *      "an ordinary workspace is untouched by the fence" means in cost.
 *   2. only when static workspaces exist: the per-document kind lookup against
 *      `read_model_static_documents` JOIN `read_model_static_workspaces`
 *      (the join makes a de-promotion — workspace row deleted, doc rows going —
 *      disarm the fence even mid-delete), cached per documentId for the TTL.
 *
 * Faults FAIL CLOSED per message (a broken lookup must not let a baseline
 * write through) and are reported through `onFault` for VISIBILITY only — in
 * production that is a throttled log-only reporter (automergeServer.ts),
 * deliberately never the deny ledger: unlike an admission deny nothing is
 * pinned, the client re-offers the change on the next sync round and a healed
 * pool answers it, so there is nothing a `shareConfigChanged()` could lift.
 * The ONE softening is the global bit's stale-while-fault (see
 * `anyStaticWorkspace`): a stack whose last good answer was "no static world"
 * keeps allowing for a bounded grace while the refresh faults, because
 * otherwise a pool outage longer than one TTL would fence EVERY write of
 * EVERY workspace — a global regression on ordinary stacks whose writes never
 * consulted SQL before the fence existed. A missing table (42P01) is not a
 * fault: no schema, no static world.
 */
export function buildBaselineWriteFence(
  pool: Pool,
  options: {
    onFault?: GateFaultReporter
    /** Injectable for tests; production uses {@link BASELINE_FENCE_TTL_MS}. */
    ttlMs?: number
    /** Injectable for the liveness table; production uses
     * {@link BASELINE_FENCE_LOOKUP_DEADLINE_MS}. */
    lookupDeadlineMs?: number
    /** Injectable for tests; production uses
     * {@link BASELINE_FENCE_STALE_BIT_GRACE_MS}. */
    staleBitGraceMs?: number
    /** Injectable for tests; production uses
     * {@link BASELINE_FENCE_MAX_ENTRIES}. */
    maxDocVerdicts?: number
  } = {},
): BaselineWriteFence {
  const ttlMs = options.ttlMs ?? BASELINE_FENCE_TTL_MS
  const deadlineMs = options.lookupDeadlineMs ?? BASELINE_FENCE_LOOKUP_DEADLINE_MS
  const staleBitGraceMs = options.staleBitGraceMs ?? BASELINE_FENCE_STALE_BIT_GRACE_MS
  const maxDocVerdicts = options.maxDocVerdicts ?? BASELINE_FENCE_MAX_ENTRIES

  let staticWorld: { present: boolean; expiresAt: number } | null = null
  let lastGoodStaticWorld: { present: boolean; observedAt: number } | null = null
  let staticWorldFlight: Promise<boolean> | null = null
  const docVerdicts = new Map<string, { fenced: boolean; expiresAt: number }>()
  const docFlights = new Map<string, Promise<boolean>>()

  const anyStaticWorkspace = async (): Promise<boolean> => {
    if (staticWorld && staticWorld.expiresAt > Date.now()) return staticWorld.present
    let flight = staticWorldFlight
    if (!flight) {
      flight = settleWithinDeadline(
        pool.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM read_model_static_workspaces) AS present`,
        ).then(({ rows }) => rows[0]?.present === true),
        deadlineMs,
        'baseline-fence static-world bit',
      )
      staticWorldFlight = flight
      const clear = (): void => {
        // Evict on settlement ONLY if still current — the single-flight rule:
        // a rejected flight must not pin itself forever, and
        // a fresh flight must not be discarded by a late loser.
        if (staticWorldFlight === flight) staticWorldFlight = null
      }
      void flight.then(clear, clear)
    }
    let present: boolean
    try {
      present = await flight
    } catch (error) {
      // STALE-WHILE-FAULT — for the GLOBAL bit only, never the per-document
      // lookup. When the refresh faults, serve the last bit observed WITH
      // SUCCESS, but only if it said "no static world" and only within a
      // bounded grace. Sound because the static world can only BECOME present
      // through a COMMIT into this very database, which is unreachable for
      // exactly as long as this refresh keeps faulting — a stale "absent"
      // cannot mask a concurrent promotion. Without this, a pool outage
      // longer than one TTL would turn the fence into a GLOBAL write freeze,
      // dropping every inbound write of every workspace, ordinary stacks
      // included. The grace is bounded ({@link BASELINE_FENCE_STALE_BIT_GRACE_MS},
      // 10×TTL) because the fault may be OURS alone — this process
      // partitioned from a healthy database another server keeps promoting
      // into. If the last good bit said "static world PRESENT", nothing is
      // served stale: the per-document verdict is what protects the baseline
      // and it stays strictly fail-closed.
      if (
        lastGoodStaticWorld !== null
        && lastGoodStaticWorld.present === false
        && Date.now() - lastGoodStaticWorld.observedAt <= staleBitGraceMs
      ) {
        // Cache the stale verdict for one TTL so a HANGING pool costs one
        // bounded deadline per TTL, not one per message. `lastGoodStaticWorld`
        // is only ever advanced by a SUCCESS, so this cannot extend the grace:
        // the total stale-allow window is ≤ grace + one TTL.
        staticWorld = { present: false, expiresAt: Date.now() + ttlMs }
        const now = Date.now()
        if (now - (gateFaultLoggedAt.get('baseline-fence/static-bit-stale') ?? 0) >= 10_000) {
          if (gateFaultLoggedAt.size > 1_000) gateFaultLoggedAt.clear()
          gateFaultLoggedAt.set('baseline-fence/static-bit-stale', now)
          console.warn(
            '[docScope] baseline-fence static-world refresh faulted; serving last good "absent" bit under grace:',
            error,
          )
        }
        return false
      }
      throw error
    }
    staticWorld = { present, expiresAt: Date.now() + ttlMs }
    lastGoodStaticWorld = { present, observedAt: Date.now() }
    return present
  }

  const isFencedDocument = async (documentId: string): Promise<boolean> => {
    const cached = docVerdicts.get(documentId)
    if (cached && cached.expiresAt > Date.now()) return cached.fenced
    let flight = docFlights.get(documentId)
    if (!flight) {
      flight = settleWithinDeadline(
        pool.query<{ kind: string }>(
          `SELECT document.kind
             FROM read_model_static_documents document
             JOIN read_model_static_workspaces workspace
               ON workspace.landscape_id = document.landscape_id
              AND workspace.version_id = document.version_id
            WHERE document.document_id = $1`,
          [documentId],
        ).then(({ rows }) => rows.some((row) => isBaselineDocumentKind(row.kind))),
        deadlineMs,
        'baseline-fence document lookup',
      )
      docFlights.set(documentId, flight)
      const clear = (): void => {
        if (docFlights.get(documentId) === flight) docFlights.delete(documentId)
      }
      void flight.then(clear, clear)
    }
    const fenced = await flight
    if (docVerdicts.size >= maxDocVerdicts) docVerdicts.clear() // bounded — it's a cache
    docVerdicts.set(documentId, { fenced, expiresAt: Date.now() + ttlMs })
    return fenced
  }

  const verdict = async (peerId: string, documentId: string): Promise<boolean> => {
    try {
      if (!(await anyStaticWorkspace())) return true
      return !(await isFencedDocument(documentId))
    } catch (error) {
      if (isUndefinedTableError(error)) {
        staticWorld = { present: false, expiresAt: Date.now() + ttlMs }
        return true
      }
      // Fail closed and say it was a FAULT (not a refusal) through `onFault` —
      // which in production is a throttled LOG-ONLY reporter
      // (automergeServer.ts), never the deny ledger: this verdict is consumed
      // per message by `syncWriteGate`, nothing caches it, so the next sync
      // round IS the lift and no share-policy re-evaluation is owed.
      const now = Date.now()
      const key = `baseline-fence/${documentId}`
      if (now - (gateFaultLoggedAt.get(key) ?? 0) >= 10_000) {
        if (gateFaultLoggedAt.size > 1_000) gateFaultLoggedAt.clear()
        gateFaultLoggedAt.set(key, now)
        console.warn(`[docScope] baseline write fence failed for ${documentId} (denying this message):`, error)
      }
      try {
        options.onFault?.(peerId, documentId, null)
      } catch (reportError) {
        console.warn('[docScope] baseline-fence fault reporter failed:', reportError)
      }
      return false
    }
  }
  const fence = verdict as BaselineWriteFence
  fence._docVerdictCountForTests = () => docVerdicts.size
  return fence
}
