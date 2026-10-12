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
  isValidAutomergeUrl,
  type StorageAdapterInterface,
  type StorageKey,
  type Chunk,
} from '@automerge/automerge-repo'
import type { Pool, PoolClient } from 'pg'
import { isTransientDbError, pool, withDbRetry } from './db.js'
import {
  poolConcurrencyGate,
  PoolPermitTimeoutError,
  type PoolConcurrencyGate,
} from './db/poolConcurrencyGate.js'
import {
  StaleSyncCellWriteError,
  StoragePoolExhaustedError,
  type StorageFenceRejectionReason,
} from './automergeStorageErrors.js'
import type { WorkspaceKey } from './rbac/docScope.js'
import { provisionalPlacementFor } from './rbac/provisionalPlacementSource.js'
import { bootstrapPlacementFor, placementForFence } from './rbac/serverCreationPlacement.js'
import type { SyncCellOwnership } from './syncCells/ownership.js'

/**
 * Postgres-backed Automerge storage adapter.
 *
 * automerge-repo persists each document as a set of binary chunks (periodic
 * snapshots + incremental changes), addressed by a `StorageKey` — an array of
 * path-like string segments, e.g. `[documentId, "snapshot", <hash>]`. Segments
 * are documentIds/literals/hashes and never contain '/', so we join them with
 * '/' for the primary key and split back on read.
 *
 * Storing the chunks in Postgres (the DB this app already runs) makes the sync
 * server a DURABLE Automerge peer: documents survive restarts and new clients
 * catch up from here.
 */

const SEP = '/'

function keyToText(key: StorageKey): string {
  return key.join(SEP)
}

function textToKey(text: string): StorageKey {
  return text.split(SEP)
}

function toUint8Array(data: Buffer): Uint8Array {
  // pg returns BYTEA as a Buffer (already a Uint8Array), but copy into a plain
  // Uint8Array so callers can't observe Buffer-specific behaviour.
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Storage keys automerge-repo writes for its OWN bookkeeping — not documents.
 *
 * There is exactly one today: `StorageSubsystem.id()` persists a per-repo uuid
 * under `["storage-adapter-id"]` when storage has none
 * (`dist/storage/StorageSubsystem.js`). It is minted from an async IIFE in the
 * `Repo` CONSTRUCTOR (`dist/Repo.js`, building `myPeerMetadata`) that NOTHING
 * awaits, so the write lands at an arbitrary moment after `new Repo(...)`
 * returns.
 *
 * Every consumer that enumerates `automerge_storage` by key prefix
 * (`split_part(key, '/', 1)`) sees that row and, without this predicate, calls
 * it a document. Three copies of the knowledge already existed, none shared:
 * `backup/backupRestore.ts`, `automergeBackgroundSave.test.ts`, and the fsck
 * integration fixture. The fourth site had no copy at all and is production —
 * `gcOrphanedDocs` counted the key in `stored` and, since nothing can ever make
 * it reachable, queued it for DELETION on any complete sweep.
 */
const NON_DOCUMENT_STORAGE_KEY_PREFIXES: ReadonlySet<string> = new Set(['storage-adapter-id'])

/**
 * Does this storage key address a DOCUMENT's data?
 *
 * Accepts either a full {@link StorageKey} or the first segment alone, because
 * the SQL sites only ever have the prefix (`split_part(key, '/', 1)`).
 *
 * Deliberately a NEGATIVE test rather than "is the prefix a valid Automerge
 * document id": a positive shape test would also silently exempt every
 * malformed/legacy row from the GC sweep, which is a much larger change of
 * blast radius than the defect being fixed and would hide real corruption.
 */
export function isDocumentStorageKey(key: StorageKey | string): boolean {
  const prefix = typeof key === 'string' ? key.split(SEP)[0] : key[0]
  return prefix !== undefined && prefix !== '' && !NON_DOCUMENT_STORAGE_KEY_PREFIXES.has(prefix)
}

const DOCUMENT_CHUNK_TYPES = new Set(['snapshot', 'incremental', 'sync-state'])

export { DOCUMENT_CONTENT_CHUNK_TYPES, documentContentChunkFilter } from './documentContent.js'

/**
 * Which document kinds a write enqueues for the static read-model projector.
 *
 * ONE constant, shared by the CTE form and the standalone form: duplicated, a
 * fix to one copy leaves the other silently dropping writes, and nothing
 * reports it — a kind missing here means writes to that document increment no
 * revision, the catch-up paths never see it, and (for `registry-shard`) a
 * brand-new diagram reaches no server table at all.
 *
 * `registry-shard` belongs here because it is the ONE registry document an
 * interactive summary client writes through. The immutable baseline `registry`
 * shards do NOT: nothing ever writes them, so enqueuing them would only add
 * work.
 */
const READ_MODEL_QUEUE_DOCUMENT_KINDS = [
  'model-meta', 'object-overlay', 'connection-overlay', 'diagram', 'registry-shard',
] as const

/** The kind filter as a SQL fragment, shared by both statements that enqueue. */
const readModelQueueKindFilter = (): string => (
  `document.kind IN (${READ_MODEL_QUEUE_DOCUMENT_KINDS.map((kind) => `'${kind}'`).join(', ')})`
)

function documentIdFromKey(key: StorageKey, allowDocumentPrefix = false): string | null {
  if (key.length === 1 && !allowDocumentPrefix) return null
  if (key.length > 1 && !DOCUMENT_CHUNK_TYPES.has(key[1])) return null
  if (key.length === 0) return null
  const documentId = key[0]
  return isValidAutomergeUrl(`automerge:${documentId}`) ? documentId : null
}

// Defined in a leaf module and re-exported here so the HTTP error mapping can
// name it in an `instanceof` without importing this file — which would build
// three connection pools through `./db.js`. See `automergeStorageErrors.ts`.
export { StaleSyncCellWriteError }

export interface StorageFenceSnapshot {
  enabled: boolean
  mappedMutationCount: number
  quarantinedMutationCount: number
  /**
   * The subset of `quarantinedMutationCount` whose lease WAS checked — against
   * the workspace the route gate provisionally placed the document in, because
   * its durable row had not landed yet.
   *
   * The difference between the two is the honest measure of the remaining hole:
   * `quarantined - provisionallyFenced` mutations were admitted with no lease
   * check at all. Reported separately rather than folded in, because a single
   * "quarantined" number cannot distinguish "fenced against a provisional
   * owner" from "nobody asked".
   */
  provisionallyFencedMutationCount: number
  /**
   * The subset of `quarantinedMutationCount` whose lease WAS checked against a
   * BOOTSTRAP placement — the forker's lease a `BootstrapScope` noted at the
   * mint. Its own field because the unplaced-creation census counts the owner
   * tier, and a bootstrap save folded into `provisionallyFencedMutationCount`
   * would be counted as an "unplaced creation" it is not. On the
   * outage bench this is the PRESENCE witness — a fork of six documents on the
   * owner must move it by six, or the 200 was admitted by a fence that never
   * looked.
   */
  bootstrapFencedMutationCount: number
  /**
   * Refusals — either reason — whose operand came from a bootstrap placement.
   * `rejectedMutationsByReason` pools the three placement sources, so a delta
   * there says "some fence refused"; this one says WHICH, which is what lets a
   * 503 on the bench be attributed to this mechanism rather than to a pool
   * timeout wearing the same status.
   */
  bootstrapFenceRejectionCount: number
  /** A locally-created document became assigned after the initial mapping
   * lookup but before its atomic write. The rejected no-op was resampled once
   * so the now-mapped write could use the workspace's current local token. */
  mappingAdmissionRetryCount: number
  rejectedMutationCount: number
  rejectedDocumentCount: number
  /** Number of distinct storage keys rejected. The keys themselves are never
   * exposed because incremental/snapshot suffixes are protocol identifiers. */
  rejectedMutationIdentityCount: number
  repeatedRejectedMutationCount: number
  /** Exact immutable chunk retries suppressed during the short ownership
   * handoff window. They still fail locally and never perform a durable mutation. */
  coalescedStaleFenceRetryCount: number
  coalescedFenceMismatchCount: number
  coalescedStaleFenceRetryCacheSize: number
  coalescedStaleFenceRetryEvictions: number
  maxCoalescedStaleFenceRetriesPerMutation: number
  /** Compatibility counters retained for existing diagnostics consumers. */
  coalescedOwnershipUnavailableCount: number
  coalescedOwnershipUnavailableCacheSize: number
  coalescedOwnershipUnavailableEvictions: number
  maxCoalescedOwnershipUnavailablePerMutation: number
  rejectedMutationsByKind: Record<StorageMutationKind, number>
  rejectedMutationsByReason: Record<StorageFenceRejectionReason, number>
}

type StorageMutationKind = 'snapshot' | 'incremental' | 'sync-state' | 'document-range' | 'other'
// The union lives in `automergeStorageErrors.ts` beside the error that carries
// it: once a reason reaches an HTTP client it is a wire contract, and both ends
// of that contract have to be able to see it without importing this file.
export type { StorageFenceRejectionReason }

const emptyRejectedMutationKinds = (): Record<StorageMutationKind, number> => ({
  snapshot: 0,
  incremental: 0,
  'sync-state': 0,
  'document-range': 0,
  other: 0,
})

const emptyRejectionReasons = (): Record<StorageFenceRejectionReason, number> => ({
  'ownership-unavailable': 0,
  'fence-mismatch': 0,
})

function storageMutationKind(key: StorageKey, allowDocumentPrefix: boolean): StorageMutationKind {
  if (allowDocumentPrefix && key.length === 1) return 'document-range'
  if (key[1] === 'snapshot' || key[1] === 'incremental' || key[1] === 'sync-state') return key[1]
  return 'other'
}

export interface StorageResidencySnapshot {
  trackedDocuments: number
  trackedChunkBytes: number
}

interface PostgresStorageAdapterOptions {
  db?: Pool
  ownership?: Pick<SyncCellOwnership, 'fencingToken'>
  /**
   * Maximum time PostgreSQL may leave a fenced write idle inside its open
   * transaction. This is deliberately shorter than the workspace takeover
   * budget: if a sync-cell process is paused after acquiring the ownership
   * share lock, PostgreSQL rolls the abandoned transaction back and releases
   * the lock for the replacement cell.
   */
  fencedTransactionIdleTimeoutMs?: number
  /**
   * How many connections this adapter may hold from `db` at once.
   *
   * NOT a pool size — a bound on this borrower's share of a pool it does not
   * own. The default is derived in the constructor from `db`'s own `max`, so it
   * is stated once, there, with the measurement behind it. Passing it here is
   * for tests that need the bound to bind at a width they can drive.
   */
  dbConcurrency?: number
  /**
   * How long a mutation may wait for one of `dbConcurrency` permits before it
   * is refused with `StoragePoolExhaustedError('queue-timeout')`. Test seam:
   * the default is a two-second policy and no unit test should sleep for it.
   */
  dbConcurrencyWaitMs?: number
  /** Enqueue static read-model work atomically with durable Automerge writes.
   * Enabled only after ensureReadModelSchema has created the queue. */
  trackStaticReadModel?: boolean
  /**
   * TEST SEAM ONLY — production leaves this unset.
   *
   * The workspace a document has been ADMITTED to but not yet durably mapped
   * to. It defaults to `provisionalPlacementFor`, the process-wide source
   * `automergeServer` installs from the doc index, and that default is
   * deliberate: an option every construction site has to remember to pass is a
   * wire no test pins. With the default there is no per-site line to forget.
   *
   * Null from the source means no owner to check, which keeps the
   * unconditional admission — what every SERVER-created document (fork roots,
   * projector documents) relies on, since nothing routes them through a gate
   * before their first save.
   */
  provisionalPlacement?: (documentId: string) => WorkspaceKey | null
  /**
   * TEST SEAM ONLY — production leaves this unset.
   *
   * The lease a BOOTSTRAP document is being written under — the forker's, noted
   * by `bootstrapScope.ts` in the frame that minted it — consulted only when
   * the durable row is absent AND the two sources above answered nothing.
   * Defaults to `bootstrapPlacementFor`, the FORKER tier of
   * `serverCreationPlacement.ts`, for the same reason `provisionalPlacement`
   * defaults: a per-construction option is a wire.
   */
  bootstrapPlacement?: (documentId: string) => WorkspaceKey | null
  /** Test seam: runs while the ownership row is share-locked and before the
   * chunk mutation. It proves a token handoff cannot commit across this write. */
  afterFenceLocked?: () => Promise<void>
  /** Test seam for the bounded exact-mutation circuit breaker. */
  ownershipUnavailableCoalescingLimit?: number
  /** Test seam for the short in-flight failover coalescing window. */
  ownershipUnavailableCoalescingWindowMs?: number
}

interface StorageMutation {
  sql(firstParameter: number, permissionCte: string | null): string
  params: unknown[]
  enqueueDocumentId?: string
}

interface DocumentMapping {
  landscape_id: string
  version_id: string
}

interface CoalescedStaleFenceMutation {
  repetitions: number
  expiresAt: number
}

const DEFAULT_OWNERSHIP_UNAVAILABLE_COALESCING_LIMIT = 4_096
const DEFAULT_OWNERSHIP_UNAVAILABLE_COALESCING_WINDOW_MS = 1_000

/** See the constructor for the derivation of this number. */
const DEFAULT_STORAGE_DB_CONCURRENCY = 4
/**
 * HOW LONG A MUTATION MAY WAIT FOR A PERMIT BEFORE IT IS REFUSED.
 *
 * An untimed queue would turn a 10 s failure into an unbounded one.
 * `pg-pool`'s own pending queue has no depth cap, so its ONLY ceiling is the
 * per-waiter timer, and a bound placed in front of it must put a ceiling back.
 *
 * 2 000 ms is `lifecycleApplyPool`'s `connectionTimeoutMillis`
 * (`dbConfig.ts`), reused deliberately rather than picked: it is the same
 * question — how long a lifecycle-scale operation should wait for a contended
 * database resource before answering 503 (measured on a saturation bench: a
 * 10 040 ms 500 became a 2 040 ms 503). It is a POLICY, not a measured recovery time; no run has been timed from a permit
 * refusal to the first success after it.
 */
const DEFAULT_STORAGE_DB_CONCURRENCY_WAIT_MS = 2_000
/**
 * Only reached when `db.options.max` is absent — a hand-built test double, never
 * a real `Pool`, which always carries its resolved options. It matches
 * `databasePoolConfig`'s own default so the two cannot drift into disagreeing
 * about what "the pool we are bounded against" is.
 */
const DEFAULT_DB_POOL_MAX_ASSUMED = 10

/**
 * A FAILURE TO BORROW, kept distinguishable from a failure to EXECUTE while it
 * travels through `withDbRetry`.
 *
 * It is private to this module and never reaches a caller: `withClient`
 * converts it to `StoragePoolExhaustedError` on the way out. Its only job is to
 * survive the retry with the pg `code` intact, so that `isTransientDbError`
 * makes the same decision it made before the adapter borrowed explicitly.
 */
class StorageBorrowFailure extends Error {
  /** Mirrored from the cause so `withDbRetry` sees what `pg` reported. */
  readonly code: string | undefined

  constructor(readonly borrowCause: unknown) {
    super('the Automerge storage adapter could not borrow a client')
    this.name = 'StorageBorrowFailure'
    const code = (borrowCause as { code?: unknown } | null)?.code
    this.code = typeof code === 'string' ? code : undefined
  }
}

export class PostgresStorageAdapter implements StorageAdapterInterface {
  private readonly db: Pool
  private readonly gate: PoolConcurrencyGate
  private readonly gateWaitMs: number
  private readonly ownership: Pick<SyncCellOwnership, 'fencingToken'> | undefined
  private readonly fencedTransactionIdleTimeoutMs: number
  private readonly afterFenceLocked: (() => Promise<void>) | undefined
  private readonly trackStaticReadModel: boolean
  private readonly provisionalPlacement: (documentId: string) => WorkspaceKey | null
  private readonly bootstrapPlacement: (documentId: string) => WorkspaceKey | null
  private provisionallyFencedMutationCount = 0
  private bootstrapFencedMutationCount = 0
  private bootstrapFenceRejectionCount = 0
  private readonly ownershipUnavailableCoalescingLimit: number
  private readonly ownershipUnavailableCoalescingWindowMs: number
  private mappedMutationCount = 0
  private quarantinedMutationCount = 0
  private mappingAdmissionRetryCount = 0
  private rejectedMutationCount = 0
  private readonly rejectedDocuments = new Set<string>()
  private readonly rejectedMutationIdentities = new Set<string>()
  private readonly rejectedMutationsByKind = emptyRejectedMutationKinds()
  private readonly rejectedMutationsByReason = emptyRejectionReasons()
  private coalescedOwnershipUnavailableCount = 0
  private coalescedFenceMismatchCount = 0
  private coalescedOwnershipUnavailableEvictions = 0
  private maxCoalescedOwnershipUnavailablePerMutation = 0
  private readonly coalescedStaleFenceMutations = new Map<
    string,
    CoalescedStaleFenceMutation
  >()
  private readonly loadedChunkBytes = new Map<string, Map<string, number>>()

  constructor(options: PostgresStorageAdapterOptions = {}) {
    this.db = options.db ?? pool
    // THE BOUND, and where its number comes from.
    //
    // `DB_POOL_MAX` is 10 and THREE of those clients are held for the process's
    // lifetime by the dedicated LISTEN subscribers
    // (`readModel/changeNotifications.ts`, `auth/wsAuth.ts`,
    // `rbac/workspaceCacheInvalidation.ts`), leaving SEVEN. The widest
    // concurrent borrow any other borrower makes is five —
    // `promoteSummaryWorkspace`'s preflight `Promise.all` (measured on the
    // failover bench as a source of pool timeouts under saturation).
    // Four leaves three clients free at all times, so that fan-out waits on an
    // adapter operation (milliseconds) rather than on `connectionTimeoutMillis`
    // (ten seconds).
    //
    // It is not `DB_POOL_MAX` divided by anything: the three LISTEN clients are
    // a fixed count, not a fraction, so a ratio would drift wrong in both
    // directions as the pool is resized. `poolMax - 1` is an upper CLAMP for
    // small TEST pools — it keeps an adapter from being the sole borrower able
    // to fill a pool of 2, which would make the gate's own tests unable to
    // observe a queue.
    const poolMax = this.db.options?.max ?? DEFAULT_DB_POOL_MAX_ASSUMED
    this.gate = poolConcurrencyGate(
      this.db,
      options.dbConcurrency ?? Math.max(1, Math.min(DEFAULT_STORAGE_DB_CONCURRENCY, poolMax - 1)),
    )
    this.gateWaitMs = Math.max(
      1,
      Math.trunc(options.dbConcurrencyWaitMs ?? DEFAULT_STORAGE_DB_CONCURRENCY_WAIT_MS),
    )
    this.ownership = options.ownership
    this.fencedTransactionIdleTimeoutMs = Math.max(
      250,
      Math.min(10_000, Math.trunc(options.fencedTransactionIdleTimeoutMs ?? 1_000)),
    )
    this.afterFenceLocked = options.afterFenceLocked
    this.trackStaticReadModel = options.trackStaticReadModel ?? false
    // THREE SOURCES. `provisionalPlacementFor` answers
    // for documents a route gate admitted; `placementForFence` answers for the
    // ones this process MINTED through `createClaimedDocument`; and the third,
    // held in its own field below, answers for the BOOTSTRAP family — the
    // documents a `BootstrapScope` minted for a workspace that has no row yet,
    // keyed on the lease that authorises the write rather than on the
    // document's own workspace.
    //
    // DISJOINT TODAY. The gate notes only ids a PEER presented and
    // MAC-verified in `noteProvisionalPlacement`'s `bound` branch;
    // `createClaimedDocument` mints with plain `repo.create`, whose random id
    // fails `verifyDocumentId` on length; and a bootstrap document is published
    // to a registry — hence presentable by a peer — only AFTER its claim, when
    // the durable row answers first (applyMerge.ts's copies, sparse.ts's clone).
    // So no document is answerable by two sources and `??` in any order is a
    // no-op today. The order is written
    // down so a future overlap has a declared winner — and the winner this
    // order declares is the GATE, while the argument runs the other way (the
    // gate's answer is derived from the request, the half an attacker can
    // influence; the process's own record should win). If that day comes, flip
    // the order and this sentence together.
    //
    // `placementForFence`, NOT `serverCreationPlacementFor`. The second source
    // ARMS A REFUSAL — a non-null `fenceWorkspace` with no local token throws
    // below — so arming it is double-gated on
    // `SYNC_CELL_UNPLACED_CREATION=refuse` plus `ownership.enabled`, to be set
    // once the unplaced-creation census reads zero. `placementForFence` is that
    // gate; it answers null under the default `observe`. The bootstrap source
    // is NOT behind that gate: its refusal is always on, and the flag cannot
    // reach the family it is for.
    //
    // DEFAULTED rather than passed per construction, for the reason the option's
    // own docblock gives: an option every construction site must remember is a
    // wire no test pins.
    this.provisionalPlacement = options.provisionalPlacement
      ?? ((documentId) => provisionalPlacementFor(documentId) ?? placementForFence(documentId))
    this.bootstrapPlacement = options.bootstrapPlacement ?? bootstrapPlacementFor
    this.ownershipUnavailableCoalescingLimit = Math.max(
      1,
      Math.min(
        100_000,
        Math.trunc(
          options.ownershipUnavailableCoalescingLimit
            ?? DEFAULT_OWNERSHIP_UNAVAILABLE_COALESCING_LIMIT,
        ),
      ),
    )
    this.ownershipUnavailableCoalescingWindowMs = Math.max(
      50,
      Math.min(
        10_000,
        Math.trunc(
          options.ownershipUnavailableCoalescingWindowMs
            ?? DEFAULT_OWNERSHIP_UNAVAILABLE_COALESCING_WINDOW_MS,
        ),
      ),
    )
  }

  /** Cumulative refusals, excluding coalesced retries. Reading does not prune
   * the retry cache as the operational snapshot does. */
  readRejectedMutationCount(): number {
    return this.rejectedMutationCount
  }

  snapshot(): StorageFenceSnapshot {
    this.pruneExpiredOwnershipUnavailableMutations()
    const coalescedStaleFenceRetryCount =
      this.coalescedOwnershipUnavailableCount + this.coalescedFenceMismatchCount
    return {
      enabled: Boolean(this.ownership),
      mappedMutationCount: this.mappedMutationCount,
      quarantinedMutationCount: this.quarantinedMutationCount,
      provisionallyFencedMutationCount: this.provisionallyFencedMutationCount,
      bootstrapFencedMutationCount: this.bootstrapFencedMutationCount,
      bootstrapFenceRejectionCount: this.bootstrapFenceRejectionCount,
      mappingAdmissionRetryCount: this.mappingAdmissionRetryCount,
      rejectedMutationCount: this.rejectedMutationCount,
      rejectedDocumentCount: this.rejectedDocuments.size,
      rejectedMutationIdentityCount: this.rejectedMutationIdentities.size,
      repeatedRejectedMutationCount: Math.max(
        0,
        this.rejectedMutationCount - this.rejectedMutationIdentities.size,
      ),
      coalescedStaleFenceRetryCount,
      coalescedFenceMismatchCount: this.coalescedFenceMismatchCount,
      coalescedStaleFenceRetryCacheSize: this.coalescedStaleFenceMutations.size,
      coalescedStaleFenceRetryEvictions: this.coalescedOwnershipUnavailableEvictions,
      maxCoalescedStaleFenceRetriesPerMutation:
        this.maxCoalescedOwnershipUnavailablePerMutation,
      coalescedOwnershipUnavailableCount: this.coalescedOwnershipUnavailableCount,
      coalescedOwnershipUnavailableCacheSize: this.coalescedStaleFenceMutations.size,
      coalescedOwnershipUnavailableEvictions: this.coalescedOwnershipUnavailableEvictions,
      maxCoalescedOwnershipUnavailablePerMutation:
        this.maxCoalescedOwnershipUnavailablePerMutation,
      rejectedMutationsByKind: { ...this.rejectedMutationsByKind },
      rejectedMutationsByReason: { ...this.rejectedMutationsByReason },
    }
  }

  residencySnapshot(documentIds: readonly string[]): StorageResidencySnapshot {
    let trackedDocuments = 0
    let trackedChunkBytes = 0
    for (const documentId of documentIds) {
      const chunks = this.loadedChunkBytes.get(documentId)
      if (!chunks) continue
      trackedDocuments += 1
      for (const bytes of chunks.values()) trackedChunkBytes += bytes
    }
    return { trackedDocuments, trackedChunkBytes }
  }

  forgetResidency(documentId: string): void {
    this.loadedChunkBytes.delete(documentId)
  }

  /**
   * EVERY DATABASE OPERATION THIS ADAPTER PERFORMS GOES THROUGH HERE.
   *
   * 1. Via `withBoundedClient`, mutations TAKE A PERMIT, bounding how many
   *    clients this adapter holds from a pool it shares. See
   *    `db/poolConcurrencyGate.ts` for why this is a permit queue and not
   *    another `Pool`.
   * 2. BORROWS EXPLICITLY, so that a failure to borrow is distinguishable from
   *    a failure to execute. `this.db.query()` folds the two together, which
   *    would reach HTTP clients as `500 {"error":"read model query failed"}`
   *    — a permanent-sounding answer naming a subsystem that had not failed.
   *    Only `connect()` is inside the `try`, so nothing else can be mistaken
   *    for a borrow failure; the same shape as `acquireLifecycleApplyLock`.
   * 3. RELEASES THE CLIENT ON EVERY PATH, including the one where `fn` throws
   *    synchronously before its first `await`.
   *
   * THE ORDER OF THE THREE WRAPPERS IS LOAD-BEARING, and rule 3 is why.
   * `withDbRetry` is INSIDE the permit and OUTSIDE the borrow: its whole
   * contract is that "the pool discards the dead client before the retry, so
   * the second attempt runs on a healthy connection" (`db.ts`).
   * Hoisting the borrow above it would hand the retry the same dead client and
   * silently delete that property. The
   * permit is held across both attempts on purpose — a retrying operation is
   * still one operation's worth of pool pressure.
   */
  private async withClient<T>(
    operation: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDbRetry(async () => {
        let client: PoolClient
        try {
          client = await this.db.connect()
        } catch (error) {
          // NOT converted here, and that is the whole reason this wrapper class
          // exists. `withDbRetry` decides on `err.code`, so throwing
          // `StoragePoolExhaustedError` (whose `code` is its own token) from
          // INSIDE the retry silently removes every connect-time transient —
          // `ECONNREFUSED`, `ETIMEDOUT`, `57P03`, `08006` — from the retry set
          // (which `pool.query` would get for free). The sentinel carries the pg
          // code through so the retry decision is unchanged, and the conversion
          // happens once, outside, where a second failure is final.
          throw new StorageBorrowFailure(error)
        }
        let failure: Error | undefined
        try {
          return await fn(client)
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
          throw error
        } finally {
          // POISON THE CLIENT ONLY WHEN WE WOULD RETRY IT, and only then.
          //
          // Releasing with a truthy argument makes pg-pool DISCARD the client;
          // a bare release puts it back on `_idle` for the next `connect()`.
          // Both are wrong as a blanket rule and in opposite directions. Always
          // poisoning would destroy a healthy connection on every fence
          // refusal (one outage can quarantine thousands of mutations). Never
          // poisoning hands `withDbRetry`'s second attempt the same dead client
          // for exactly the codes it retries on, because a server-sent `57P01`
          // leaves the client looking `_queryable`.
          //
          // Sharing `isTransientDbError` with `withDbRetry` is what keeps "we
          // will retry this" and "so the connection must go" the same set.
          client.release(failure !== undefined && isTransientDbError(failure) ? failure : undefined)
        }
      })
    } catch (error) {
      if (error instanceof StorageBorrowFailure) {
        throw new StoragePoolExhaustedError(operation, 'borrow-timeout', error.borrowCause)
      }
      throw error
    }
  }

  /**
   * As `withClient`, plus a permit — for the operations that MUTATE.
   *
   * WHY ONLY THE MUTATIONS ARE GATED. Under pool saturation, the adapter
   * operations measured holding the pool were all mutations —
   * `withFencedMutation` under `save`, and `removeRange` under
   * `StorageSubsystem.removeDoc`; no `load` or `loadRange` appeared.
   *
   * Gating the reads at the same bound would cost on a hot path:
   * `StorageSubsystem.loadDocData` issues two `loadRange` per document, so boot
   * and `materializeRegistryDiagrams` would multiply the bound by the document
   * count. Reads keep the pool's own 10 s ceiling, so the adapter's READ
   * concurrency is unbounded; if reads are ever shown holding the pool, they
   * get their own budget, not this one.
   */
  private async withBoundedClient<T>(
    operation: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    // `gate.run` RATHER THAN acquire/try/finally BY HAND, so no call site has
    // to get the release right. The conversion sits OUTSIDE, where it cannot land between the permit
    // arriving and the `finally` that returns it (rule 3), and it is
    // unambiguous because `PoolPermitTimeoutError` has exactly one thrower.
    try {
      return await this.gate.run(this.gateWaitMs, () => this.withClient(operation, fn))
    } catch (error) {
      if (error instanceof PoolPermitTimeoutError) {
        throw new StoragePoolExhaustedError(operation, 'queue-timeout', error)
      }
      throw error
    }
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.withClient('load', async (client) => {
      const { rows } = await client.query<{ data: Buffer }>(
        'SELECT data FROM automerge_storage WHERE key = $1',
        [keyToText(key)]
      )
      const data = rows[0] ? toUint8Array(rows[0].data) : undefined
      if (data) this.recordLoadedChunk(key, data.byteLength)
      return data
    })
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const documentId = documentIdFromKey(key)
    // `arrival_seq` is the ARRIVAL WATERMARK clock: a
    // monotone order minted at every durable CONTENT write (snapshot /
    // incremental). The read model's absence proof compares this order
    // against the watermark each projection captured at SAMPLING time.
    //
    // `sync-state` chunks are protocol bookkeeping, NOT arrivals: they are
    // written on every peer round-trip WITHOUT the document's heads ever
    // moving, so no change event fires and no projection would ever record a
    // covering watermark — minting a sequence for them would make a healthy,
    // quiet workspace's absence proof refuse PERMANENTLY. They must insert an explicit NULL: the column DEFAULT
    // would mint one otherwise.
    const isContentChunk = key[1] === 'snapshot' || key[1] === 'incremental'
    await this.withFencedMutation(key, {
      sql: isContentChunk
        ? (first, permission) => permission
          ? `INSERT INTO automerge_storage (key, data)
             SELECT $${first}, $${first + 1} FROM ${permission}
             ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW(),
                 arrival_seq = nextval('automerge_arrival_seq')
             RETURNING 1`
          : `INSERT INTO automerge_storage (key, data) VALUES ($${first}, $${first + 1})
             ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW(),
                 arrival_seq = nextval('automerge_arrival_seq')
             RETURNING 1`
        : (first, permission) => permission
          ? `INSERT INTO automerge_storage (key, data, arrival_seq)
             SELECT $${first}, $${first + 1}, NULL FROM ${permission}
             ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()
             RETURNING 1`
          : `INSERT INTO automerge_storage (key, data, arrival_seq)
             VALUES ($${first}, $${first + 1}, NULL)
             ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()
             RETURNING 1`,
      params: [keyToText(key), Buffer.from(data)],
      enqueueDocumentId: this.trackStaticReadModel && isContentChunk
        ? documentId ?? undefined
        : undefined,
    }, false, isContentChunk)
    this.recordLoadedChunk(key, data.byteLength)
  }

  async remove(key: StorageKey): Promise<void> {
    await this.withFencedMutation(key, {
      sql: (first, permission) => `DELETE FROM automerge_storage
        WHERE key = $${first}${permission ? ` AND EXISTS (SELECT 1 FROM ${permission})` : ''}
        RETURNING 1`,
      params: [keyToText(key)],
    })
    this.removeLoadedChunk(key)
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return this.withClient('loadRange', async (client) => {
      const prefix = keyToText(keyPrefix)
      // Match the prefix exactly OR any deeper key under it. `LIKE` needs the
      // prefix's special chars escaped; storage keys are alphanumeric/base58/hex
      // so the only realistic specials are none, but escape defensively.
      const escaped = prefix.replace(/([%_\\])/g, '\\$1')
      const { rows } = await client.query<{ key: string; data: Buffer }>(
        `SELECT key, data FROM automerge_storage
         WHERE key = $1 OR key LIKE $2 || '/%' ESCAPE '\\'`,
        [prefix, escaped]
      )
      return rows.map((row) => {
        const key = textToKey(row.key)
        const data = toUint8Array(row.data)
        this.recordLoadedChunk(key, data.byteLength)
        return { key, data }
      })
    })
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = keyToText(keyPrefix)
    const escaped = prefix.replace(/([%_\\])/g, '\\$1')
    await this.withFencedMutation(keyPrefix, {
      sql: (first, permission) => `DELETE FROM automerge_storage
        WHERE (key = $${first} OR key LIKE $${first + 1} || '/%' ESCAPE '\\')
          ${permission ? `AND EXISTS (SELECT 1 FROM ${permission})` : ''}
        RETURNING 1`,
      params: [prefix, escaped],
    }, true)
    this.removeLoadedRange(keyPrefix)
  }

  private recordLoadedChunk(key: StorageKey, byteLength: number): void {
    const documentId = documentIdFromKey(key)
    if (!documentId) return
    let chunks = this.loadedChunkBytes.get(documentId)
    if (!chunks) {
      chunks = new Map()
      this.loadedChunkBytes.set(documentId, chunks)
    }
    chunks.set(keyToText(key), byteLength)
  }

  private removeLoadedChunk(key: StorageKey): void {
    const documentId = documentIdFromKey(key)
    if (!documentId) return
    const chunks = this.loadedChunkBytes.get(documentId)
    if (!chunks) return
    chunks.delete(keyToText(key))
    if (chunks.size === 0) this.loadedChunkBytes.delete(documentId)
  }

  private removeLoadedRange(keyPrefix: StorageKey): void {
    const documentId = documentIdFromKey(keyPrefix, true)
    if (!documentId) return
    if (keyPrefix.length === 1) {
      this.loadedChunkBytes.delete(documentId)
      return
    }
    const chunks = this.loadedChunkBytes.get(documentId)
    if (!chunks) return
    const prefix = `${keyToText(keyPrefix)}/`
    const exact = keyToText(keyPrefix)
    for (const key of chunks.keys()) {
      if (key === exact || key.startsWith(prefix)) chunks.delete(key)
    }
    if (chunks.size === 0) this.loadedChunkBytes.delete(documentId)
  }

  /** Lock-order guarantee:
   *
   * - a stale chunk write that gets the ownership share lock first commits
   *   before the next owner can persist/activate its higher token;
   * - a handoff that updates the token first makes this comparison fail;
   * - therefore an old token cannot commit after the new owner is active.
   *
   * Unmapped document chunks are allowed as quarantined local provisioning
   * writes. The WebSocket admission gate denies inbound mutations until a
   * trusted parent reference has durably registered the document. */
  private async withFencedMutation(
    key: StorageKey,
    mutation: StorageMutation,
    allowDocumentPrefix = false,
    coalesceOwnershipUnavailable = false,
  ): Promise<void> {
    const documentId = documentIdFromKey(key, allowDocumentPrefix)
    const ownership = this.ownership
    const mutationKind = storageMutationKind(key, allowDocumentPrefix)
    const mutationIdentity = keyToText(key)
    if (!documentId || !ownership) {
      await this.executeUnfencedMutation(mutation)
      return
    }

    // The test seam deliberately holds a transaction open to prove lock order
    // and timeout behaviour. Production never takes this path: its fence check,
    // chunk mutation, and optional read-model enqueue are one PostgreSQL
    // statement and therefore contain no JavaScript idle gap. The production
    // statement deliberately does not lock the ownership row: a process paused
    // by the orchestrator must not prevent the replacement cell from advancing
    // the fence. PostgreSQL evaluates the validation and mutation from the same
    // statement snapshot, so a concurrent handoff orders the mutation before
    // the new fence or rejects it after the new fence becomes visible.
    if (this.afterFenceLocked) {
      await this.executeLegacyFencedMutation(
        documentId,
        mutationIdentity,
        mutation,
        ownership,
        mutationKind,
        coalesceOwnershipUnavailable,
      )
      return
    }

    // ONE PERMIT AND ONE CLIENT FOR THE WHOLE OPERATION, including the resample.
    // The loop is bounded to two passes — its only `continue` is guarded by
    // `resampledAdmission`, which is set immediately above it — so the permit
    // cannot be held indefinitely by a spin. The two statements were previously
    // two separate borrows; they are now one, which also removes a window in
    // which the adapter could hold two clients per mutation.
    await this.withBoundedClient('fenced-mutation', async (client) => {
      let resampledAdmission = false
      // Carried ACROSS the resample: pass 2 reads the durable row, so its
      // operand is no longer the bootstrap entry — but a refusal there is
      // still a refusal of a write that STARTED as a bootstrap save, and the
      // bench attributes a 503 by this counter. Without the flag the one race
      // the loop exists for would go uncounted.
      let startedAsBootstrap = false
      while (true) {
        const { rows: mappings } = await client.query<DocumentMapping>(
          `SELECT landscape_id, version_id
           FROM automerge_document_workspace
           WHERE document_id = $1`,
          [documentId],
        )
        const expectedMapping = mappings[0]
        const expectedWorkspace: WorkspaceKey | null = expectedMapping
          ? {
              landscapeId: expectedMapping.landscape_id,
              versionId: expectedMapping.version_id,
            }
          : null
        // No durable row means no workspace to check a lease against, which
        // would admit the mutation unconditionally — `removeRange` included,
        // which deletes every chunk of a document. A document with no row is
        // exactly a freshly created one. The route gate names
        // the placement it just admitted on the MAC; consulted ONLY when the
        // durable row is absent, because when it is present that row is the
        // authority and a second opinion could only weaken it.
        const provisionalWorkspace = expectedWorkspace
          ? null
          : this.provisionalPlacement(documentId)
        // THE THIRD SOURCE: the lease a bootstrap document is being
        // written under, consulted only when nothing else could name one. The
        // SQL below does not know which of the two placed sources answered —
        // both fill the `provisional_*` slots and check the same
        // `sync_workspace_ownership` row at the same token — so the distinction
        // lives in the counters, not in the statement.
        const bootstrapWorkspace = expectedWorkspace || provisionalWorkspace
          ? null
          : this.bootstrapPlacement(documentId)
        const placedWorkspace = provisionalWorkspace ?? bootstrapWorkspace
        const fenceWorkspace = expectedWorkspace ?? placedWorkspace
        if (bootstrapWorkspace) startedAsBootstrap = true
        let localToken: string | null = null
        if (fenceWorkspace) {
          localToken = ownership.fencingToken(fenceWorkspace)
          if (!localToken) {
            if (startedAsBootstrap) this.bootstrapFenceRejectionCount += 1
            throw coalesceOwnershipUnavailable
              ? this.coalesceStaleImmutableMutation(
                documentId,
                mutationIdentity,
                mutationKind,
                fenceWorkspace,
                'ownership-unavailable',
              )
              : this.staleWrite(
                documentId, mutationIdentity, mutationKind, 'ownership-unavailable',
              )
          }
        }

        // THE FIXED PARAMETER BLOCK, NAMED ONCE.
        //
        // `durable` is the DURABLE mapping's pair and `provisional` the one the
        // route gate named. Two pairs rather than one overloaded pair on
        // purpose: a single pair whose meaning depends on which case produced
        // it is a parameter that reads correctly and can only be verified by
        // tracing the caller, and the resample loop below deliberately re-enters
        // this with a different case than the one it started in.
        //
        // Everything positional derives from THIS array — the mutation's
        // offset, the queue CTE's document marker, and every `$n` in the
        // statement below. Never hand-count them: a wrong count raises `08P01`
        // on every fenced write, and a REORDER is silent — the count stays
        // right while the fence compares the wrong column and the queue
        // enqueues the wrong document. An arity check cannot see a permutation
        // (see `automergeStorage.parameterArity.test.ts`).
        const fixed = [
          ['document_id', documentId],
          ['fencing_token', localToken],
          ['durable_landscape_id', expectedMapping?.landscape_id ?? null],
          ['durable_version_id', expectedMapping?.version_id ?? null],
          ['provisional_landscape_id', placedWorkspace?.landscapeId ?? null],
          ['provisional_version_id', placedWorkspace?.versionId ?? null],
        ] as const satisfies ReadonlyArray<readonly [string, unknown]>

        type FixedSlot = (typeof fixed)[number][0]
        /** `$n` for a named slot.
         *
         *  The throw is UNREACHABLE and is kept as a belt: `FixedSlot` is a
         *  closed union (`as const satisfies` does not widen — checked with the
         *  repo's own tsc, where a typo is TS2345 against the six literals),
         *  and this file is inside `server/tsconfig.json`'s `src/**\/*`, which
         *  `ci:local --static` builds. Without it, `findIndex` returning -1
         *  would silently emit `$0`. */
        const p = (slot: FixedSlot): string => {
          const index = fixed.findIndex(([name]) => name === slot)
          if (index < 0) throw new Error(`unknown fenced-mutation slot "${slot}"`)
          return `$${index + 1}`
        }

        const parameters: unknown[] = [...fixed.map(([, value]) => value), ...mutation.params]
        const mutationSql = mutation.sql(fixed.length + 1, 'mutation_permission')
        const queueCte = mutation.enqueueDocumentId
          ? this.readModelQueueCte(p('document_id'))
          : ''
        const { rows } = await client.query<{
          mapped: boolean
          fence_valid: boolean
          permitted: boolean
        }>(
           `WITH document_mapping AS MATERIALIZED (
             SELECT landscape_id, version_id
             FROM automerge_document_workspace
             WHERE document_id = ${p('document_id')}
           ),
           valid_fence AS MATERIALIZED (
             SELECT 1
             FROM document_mapping mapping
             JOIN sync_workspace_ownership ownership
               ON ownership.landscape_id = mapping.landscape_id
              AND ownership.version_id = mapping.version_id
             WHERE mapping.landscape_id = ${p('durable_landscape_id')}
               AND mapping.version_id = ${p('durable_version_id')}
               AND ownership.fencing_token = ${p('fencing_token')}::bigint
               AND ownership.released_at IS NULL
           ),
           -- The lease check for a document with NO durable row, against the
           -- workspace the route gate provisionally placed it in.
           --
           -- The two IS NULL tests on the DURABLE pair are not belt and braces.
           -- The exclusion between the two pairs is enforced sixty lines up in
           -- JavaScript, and a differential over all 160 combinations of the
           -- two pairs against a real Postgres found SIX inputs where this CTE
           -- is more permissive than the pre-fix predicate — every one of them
           -- requiring both pairs non-null, i.e. exactly what that JS line
           -- forbids today. Zero are reachable now; a comment cannot notice an
           -- edit, and the resample loop below deliberately re-enters this
           -- statement in a different case than the one it started in.
           --
           -- The IS NOT NULL guards on the PROVISIONAL pair this used to carry
           -- are gone: a mutation run showed removing them changes nothing,
           -- because comparing a column to NULL yields NULL and therefore no
           -- rows. Dead defensive SQL reads as a check and is not one.
           provisional_fence AS MATERIALIZED (
             SELECT 1
             FROM sync_workspace_ownership ownership
             WHERE ${p('durable_landscape_id')}::text IS NULL
               AND ${p('durable_version_id')}::text IS NULL
               AND ownership.landscape_id = ${p('provisional_landscape_id')}
               AND ownership.version_id = ${p('provisional_version_id')}
               AND ownership.fencing_token = ${p('fencing_token')}::bigint
               AND ownership.released_at IS NULL
           ),
           mutation_permission AS MATERIALIZED (
             SELECT 1
             WHERE EXISTS (SELECT 1 FROM valid_fence)
               OR (
                 NOT EXISTS (SELECT 1 FROM document_mapping)
                 AND (
                   -- Nobody could name a workspace for this document, so there
                   -- is no lease to check: the pre-fix admission, kept because
                   -- every SERVER-created document (fork roots, projector
                   -- documents) reaches its first save this way — nothing
                   -- routes them through a gate.
                   (${p('durable_landscape_id')}::text IS NULL
                    AND ${p('durable_version_id')}::text IS NULL
                    AND ${p('provisional_landscape_id')}::text IS NULL
                    AND ${p('provisional_version_id')}::text IS NULL)
                   -- The route gate DID name one. Then this cell must hold that
                   -- workspace's lease, exactly as if the row already existed.
                   -- Note the join-free shape of provisional_fence: valid_fence
                   -- starts FROM document_mapping, so on an empty mapping it is
                   -- empty no matter what the token says — supplying the pair
                   -- THERE would REFUSE the write rather than fence it, which
                   -- is the opposite of the intent and would drop the very
                   -- bytes this guards.
                   OR EXISTS (SELECT 1 FROM provisional_fence)
                 )
               )
           ),
           mutation AS (
             ${mutationSql}
           )
           ${queueCte}
           SELECT
             EXISTS (SELECT 1 FROM document_mapping) AS mapped,
             EXISTS (SELECT 1 FROM valid_fence) AS fence_valid,
             EXISTS (SELECT 1 FROM mutation_permission) AS permitted`,
          parameters,
        )
        const result = rows[0]
        if (!result?.permitted) {
          // Repo.create may start its initial quarantined save immediately.
          // If the server admits that document between the lookup above and
          // this atomic statement, no mutation ran: mutation_permission was
          // empty. Resample the now-authoritative assignment exactly once and
          // require its current local fencing token on the second statement.
          // A genuinely stale owner still fails ownership/fence validation.
          if (!resampledAdmission && !expectedMapping && result?.mapped) {
            resampledAdmission = true
            this.mappingAdmissionRetryCount += 1
            continue
          }
          if (startedAsBootstrap) this.bootstrapFenceRejectionCount += 1
          throw coalesceOwnershipUnavailable && fenceWorkspace
            ? this.coalesceStaleImmutableMutation(
              documentId,
              mutationIdentity,
              mutationKind,
              fenceWorkspace,
              'fence-mismatch',
            )
            : this.staleWrite(
              documentId, mutationIdentity, mutationKind, 'fence-mismatch',
            )
        }
        if (coalesceOwnershipUnavailable && fenceWorkspace) {
          this.coalescedStaleFenceMutations.delete(
            this.coalescingIdentity(fenceWorkspace, mutationIdentity),
          )
        }
        if (result.mapped) this.mappedMutationCount += 1
        // `quarantined` means written with no durable mapping, which covers two
        // different facts the residency snapshot must tell apart: a write the
        // fence CHECKED against a placed workspace, and one it could not check
        // at all.
        else {
          this.quarantinedMutationCount += 1
          if (provisionalWorkspace) this.provisionallyFencedMutationCount += 1
          if (bootstrapWorkspace) this.bootstrapFencedMutationCount += 1
        }
        return
      }
    })
  }

  private async executeUnfencedMutation(mutation: StorageMutation): Promise<void> {
    await this.withBoundedClient('unfenced-mutation', async (client) => {
      const parameters = [...mutation.params]
      let documentParameter = ''
      if (mutation.enqueueDocumentId) {
        parameters.push(mutation.enqueueDocumentId)
        documentParameter = `$${parameters.length}`
      }
      const queueCte = documentParameter ? this.readModelQueueCte(documentParameter) : ''
      await client.query(
        `WITH mutation AS (
           ${mutation.sql(1, null)}
         )
         ${queueCte}
         SELECT EXISTS (SELECT 1 FROM mutation) AS mutated`,
        parameters,
      )
    })
  }

  private readModelQueueCte(documentParameter: string): string {
    return `, read_model_queue AS (
      INSERT INTO read_model_static_document_queue (
        landscape_id, version_id, document_id, revision,
        projected_revision, enqueued_at
      )
      SELECT document.landscape_id, document.version_id,
             document.document_id, 1, 0, now()
      FROM read_model_static_documents document
      JOIN read_model_static_workspaces workspace
        ON workspace.landscape_id = document.landscape_id
       AND workspace.version_id = document.version_id
      WHERE document.document_id = ${documentParameter}
        AND ${readModelQueueKindFilter()}
        AND EXISTS (SELECT 1 FROM mutation)
      ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET
        revision = read_model_static_document_queue.revision + 1,
        enqueued_at = now()
      RETURNING 1
    )`
  }

  private async executeLegacyFencedMutation(
    documentId: string,
    mutationIdentity: string,
    mutation: StorageMutation,
    ownership: Pick<SyncCellOwnership, 'fencingToken'>,
    mutationKind: StorageMutationKind,
    coalesceOwnershipUnavailable: boolean,
  ): Promise<void> {

    // The borrow, the permit and the release belong to `withBoundedClient`
    // (do not duplicate them here, and never release the client again). What
    // stays here is the only part that is this branch's own: the transaction, and the `error`
    // listener that must be removed before the client goes back to the pool.
    await this.withBoundedClient('legacy-fenced-mutation', async (client) => {
      let connectionError: Error | undefined
      const rememberConnectionError = (error: Error) => {
        connectionError ??= error
      }
      // PostgreSQL emits an `error` event when
      // idle_in_transaction_session_timeout terminates the backend. An acquired
      // pg client has no pool-level listener at that point; retain the first
      // server error so it becomes the rejected write instead of an uncaught
      // process exception.
      client.on('error', rememberConnectionError)
      try {
        await client.query('BEGIN')
        await client.query(
          "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
          [`${this.fencedTransactionIdleTimeoutMs}ms`],
        )
        const { rows: mappings } = await client.query<DocumentMapping>(
          `SELECT landscape_id, version_id
           FROM automerge_document_workspace
           WHERE document_id = $1
           FOR SHARE`,
          [documentId],
        )
        const mapping = mappings[0]
        // Same widening as the production path, and it belongs here for the
        // reason the seam exists: this branch is what proves lock ORDER, so a
        // seam that skips the fence in the case the production path fences
        // would be a fixture asserting the absence of the thing under test.
        // The `FOR SHARE` on the mapping row has nothing to lock when there is
        // no row, but the lock that carries the ordering guarantee is the one
        // on `sync_workspace_ownership` below, which is taken either way.
        // The same three sources as the production path, in the same order,
        // and the same counters — the seam's own arm counts them, so a branch
        // that folded bootstrap writes into the provisional counter would
        // miscount exactly what the unplaced-creation census reads.
        const provisional = mapping ? null : this.provisionalPlacement(documentId)
        const bootstrap = mapping || provisional ? null : this.bootstrapPlacement(documentId)
        const workspace: WorkspaceKey | null = mapping
          ? { landscapeId: mapping.landscape_id, versionId: mapping.version_id }
          : (provisional ?? bootstrap)
        if (workspace) {
          const localToken = ownership.fencingToken(workspace)
          if (!localToken) {
            if (bootstrap) this.bootstrapFenceRejectionCount += 1
            throw coalesceOwnershipUnavailable
              ? this.coalesceStaleImmutableMutation(
                documentId,
                mutationIdentity,
                mutationKind,
                workspace,
                'ownership-unavailable',
              )
              : this.staleWrite(
                documentId, mutationIdentity, mutationKind, 'ownership-unavailable',
              )
          }
          const { rows: owners } = await client.query<{
            fencing_token: string
            released_at: Date | null
          }>(
            `SELECT fencing_token, released_at
             FROM sync_workspace_ownership
             WHERE landscape_id = $1 AND version_id = $2
             FOR SHARE`,
            [workspace.landscapeId, workspace.versionId],
          )
          const owner = owners[0]
          if (!owner || owner.released_at || String(owner.fencing_token) !== localToken) {
            if (bootstrap) this.bootstrapFenceRejectionCount += 1
            throw coalesceOwnershipUnavailable
              ? this.coalesceStaleImmutableMutation(
                documentId,
                mutationIdentity,
                mutationKind,
                workspace,
                'fence-mismatch',
              )
              : this.staleWrite(
                documentId, mutationIdentity, mutationKind, 'fence-mismatch',
              )
          }
          await this.afterFenceLocked?.()
        }
        await client.query(mutation.sql(1, null), mutation.params)
        if (mutation.enqueueDocumentId) {
          await this.enqueueReadModelRevision(client, mutation.enqueueDocumentId)
        }
        await client.query('COMMIT')
        if (workspace && coalesceOwnershipUnavailable) {
          this.coalescedStaleFenceMutations.delete(
            this.coalescingIdentity(workspace, mutationIdentity),
          )
        }
        if (mapping) this.mappedMutationCount += 1
        else {
          this.quarantinedMutationCount += 1
          if (provisional) this.provisionallyFencedMutationCount += 1
          if (bootstrap) this.bootstrapFencedMutationCount += 1
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw connectionError ?? error
      } finally {
        // NOT `client.release()` — `withBoundedClient` owns that now, and
        // releasing twice returns a client the pool may already have lent to
        // someone else. The listener removal stays: it is this branch's, and it
        // must happen before the client is recycled either way.
        client.off('error', rememberConnectionError)
      }
    })
  }

  private async enqueueReadModelRevision(client: PoolClient, documentId: string): Promise<void> {
    await client.query(
      `INSERT INTO read_model_static_document_queue (
         landscape_id, version_id, document_id, revision,
         projected_revision, enqueued_at
       )
       SELECT document.landscape_id, document.version_id,
              document.document_id, 1, 0, now()
       FROM read_model_static_documents document
       JOIN read_model_static_workspaces workspace
         ON workspace.landscape_id = document.landscape_id
        AND workspace.version_id = document.version_id
       WHERE document.document_id = $1
         AND ${readModelQueueKindFilter()}
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET
         revision = read_model_static_document_queue.revision + 1,
         enqueued_at = now()`,
      [documentId],
    )
  }

  private staleWrite(
    documentId: string,
    mutationIdentity: string,
    mutationKind: StorageMutationKind,
    reason: StorageFenceRejectionReason,
  ): StaleSyncCellWriteError {
    const repeated = this.rejectedMutationIdentities.has(mutationIdentity)
    this.rejectedMutationCount += 1
    this.rejectedDocuments.add(documentId)
    this.rejectedMutationIdentities.add(mutationIdentity)
    this.rejectedMutationsByKind[mutationKind] += 1
    this.rejectedMutationsByReason[reason] += 1
    console.warn(JSON.stringify({
      event: 'sync.cell.storage_fence_rejected',
      mutationKind,
      reason,
      repeated,
      // The document, so a refusal can be attributed after the fact — to the
      // mapping row it had, or to none — and the storage KEY,
      // which for a snapshot/incremental chunk is content-addressed: a refused
      // key that already sits in `automerge_storage` was a duplicate write and
      // lost nothing; one that does not is a chunk the durable plane lacks.
      documentId,
      key: mutationIdentity,
    }))
    return new StaleSyncCellWriteError(mutationKind, reason, documentId)
  }

  /**
   * A content-addressed snapshot/incremental chunk can be requested by both
   * StorageSource and Repo.flush() after this cell loses ownership. Record the
   * first rejected identity, then fail exact repeats locally while ownership is
   * still absent. The current mapping and live token are re-read before every
   * lookup, so a repaired mapping or reacquired workspace always reaches the
   * database fence again. Mutable sync-state and delete operations never use
   * this circuit breaker.
   */
  private coalesceStaleImmutableMutation(
    documentId: string,
    mutationIdentity: string,
    mutationKind: StorageMutationKind,
    workspace: WorkspaceKey,
    reason: StorageFenceRejectionReason,
  ): StaleSyncCellWriteError {
    const identity = this.coalescingIdentity(workspace, mutationIdentity)
    const now = performance.now()
    const existing = this.coalescedStaleFenceMutations.get(identity)
    if (existing && existing.expiresAt > now) {
      existing.repetitions += 1
      if (reason === 'ownership-unavailable') {
        this.coalescedOwnershipUnavailableCount += 1
      } else {
        this.coalescedFenceMismatchCount += 1
      }
      this.maxCoalescedOwnershipUnavailablePerMutation = Math.max(
        this.maxCoalescedOwnershipUnavailablePerMutation,
        existing.repetitions,
      )
      return new StaleSyncCellWriteError(mutationKind, reason, documentId)
    }
    if (existing) this.coalescedStaleFenceMutations.delete(identity)

    this.pruneExpiredOwnershipUnavailableMutations(now)
    if (
      this.coalescedStaleFenceMutations.size
      >= this.ownershipUnavailableCoalescingLimit
    ) {
      const oldest = this.coalescedStaleFenceMutations.keys().next().value
      if (oldest !== undefined) {
        this.coalescedStaleFenceMutations.delete(oldest)
        this.coalescedOwnershipUnavailableEvictions += 1
      }
    }
    this.coalescedStaleFenceMutations.set(identity, {
      repetitions: 0,
      expiresAt: now + this.ownershipUnavailableCoalescingWindowMs,
    })
    return this.staleWrite(
      documentId,
      mutationIdentity,
      mutationKind,
      reason,
    )
  }

  private coalescingIdentity(workspace: WorkspaceKey, mutationIdentity: string): string {
    return `${workspace.landscapeId}\u0000${workspace.versionId}\u0000${mutationIdentity}`
  }

  private pruneExpiredOwnershipUnavailableMutations(now = performance.now()): void {
    for (const [identity, entry] of this.coalescedStaleFenceMutations) {
      if (entry.expiresAt > now) break
      this.coalescedStaleFenceMutations.delete(identity)
    }
  }
}
