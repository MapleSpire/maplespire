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
import {
  noteStorageWriteCeiling,
  STORAGE_WRITE_CEILING_RETRY_DELAYS_MS,
  storageWriteCeilingCode,
} from './automergeStorageCeiling.js'
import type { WorkspaceKey } from './rbac/docScope.js'
import { provisionalPlacementFor } from './rbac/provisionalPlacementSource.js'
import { bootstrapPlacementFor, placementForFence } from './rbac/serverCreationPlacement.js'
import type { SyncCellOwnership } from './syncCells/ownership.js'
import { durableHeadsMemo as processDurableHeadsMemo, durableHeadsScopeSql, type DurableHeadsMemo, type ScopedRowVersion } from './readModel/durableHeadsMemo.js'
import * as A from '@automerge/automerge'
import {
  partitionCoveredRows,
  snapshotStorageKey,
  type CompactionCandidateRow,
  type OwnSnapshotRow,
} from './storageSnapshotCompaction.js'

/** Bound of `PostgresStorageAdapter.ownSnapshots` (one small record per
 * document compacted by `compactToSnapshot`). */
const OWN_SNAPSHOT_RECORDS = 50_000

export type SnapshotCompactionSkip =
  | 'invalid-document' | 'missing-deps' | 'empty-document' | 'no-rows' | 'already-compact'
  | 'nothing-covered' | 'not-written'

/** What `compactToSnapshot` did to one document's rows. */
export interface SnapshotCompactionOutcome {
  outcome: 'compacted' | 'skipped'
  reason?: SnapshotCompactionSkip
  /** Content rows read before. */
  rowsBefore: number
  /** Rows deleted (covered by the snapshot). */
  removed: number
  /** Rows left beside the snapshot (not covered, or rewritten since the check). */
  kept: number
  snapshotOctets: number
  /** The written row was remembered in the durable-heads memo. */
  remembered: boolean
  ms: number
}

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
  /**
   * The pool the MUTATIONS borrow from (saves, removals: every operation
   * behind the permit gate); reads stay on `db`. Unset: `db` for both, as
   * before. The sync server passes `storageWritePool` (`db.ts`): tagged and
   * bounded so a new workspace owner can wait for this cell's in-flight saves
   * after a handover (`storageWritePoolConfig`, `dbConfig.ts`). The permit
   * bound is then taken against THIS pool, which only the adapter borrows.
   */
  writeDb?: Pool
  /** Where strict document loads are remembered for the read model's durable
   * proof (`readModel/durableHeadsMemo.ts`). Default: the process-wide memo;
   * `null` disables it. */
  durableHeadsMemo?: DurableHeadsMemo | null
  /** Test seam: the retry delays after a ceiling failure of a content save
   * (default `STORAGE_WRITE_CEILING_RETRY_DELAYS_MS`). */
  ceilingRetryDelaysMs?: readonly number[]
  /** How long a document's unsaved mark survives refusals that are NOT a
   * fence mismatch (`ownership-unavailable`: `fencingToken()` answered null,
   * which a transient `owns() === false` also does) before it is released.
   * Default `STORAGE_UNSAVED_OWNERSHIP_REFUSAL_GRACE_MS`. */
  ownershipRefusalGraceMs?: number
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
  /** Data-modifying CTEs the mutation reads, each `name AS (...)` and each
   * followed by a comma, placed before `mutation AS (...)` in the SAME
   * statement (a data-modifying CTE must be top-level). Parameters as `sql`;
   * the permission CTE gates them as it gates `sql`. Only
   * `compactToSnapshot` uses it. */
  ctes?(firstParameter: number, permissionCte: string | null): string
  /** Extra select-list items of the statement's final SELECT (they may read
   * `ctes`); the statement's row is returned by `withFencedMutation`. */
  returning?: string
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

/** A pending retry of a content save stopped by a ceiling. */
interface PendingCeilingRetry {
  /** The failed save's place in the start order. */
  seq: number
  timer: ReturnType<typeof setTimeout>
}

/** What of one document is not durable yet (`PostgresStorageAdapter.hasUnsavedWrite`). */
interface UnsavedDocumentState {
  /** Start order of its content saves in flight. */
  inFlight: Set<number>
  /** The latest start order a success covered: a failure that started
   * before it is covered already. */
  coveredUpTo: number
  /** key text -> start order of a failed content save not covered since. */
  failed: Map<string, number>
  /** key text -> its pending retry. */
  retries: Map<string, PendingCeilingRetry>
  /** When a refusal that is NOT a fence mismatch (ownership unavailable)
   * first met a save of it, or null: past the grace the mark is released. */
  refusedSince: number | null
}

/** A document's unsaved mark outlives an `ownership-unavailable` refusal this
 * long (a transient `owns() === false` resolves in seconds; a real loss of
 * the workspace does not, and must not hold the document for ever). */
export const STORAGE_UNSAVED_OWNERSHIP_REFUSAL_GRACE_MS = 300_000

/** The fence REFUSED this cell: another cell holds the workspace's token.
 * Not `ownership-unavailable`, which a transient lease blip also raises. */
function isFenceMismatch(error: unknown): boolean {
  return error instanceof StaleSyncCellWriteError && error.reason === 'fence-mismatch'
}

export class PostgresStorageAdapter implements StorageAdapterInterface {
  private readonly db: Pool
  /** Where mutations borrow: `writeDb`, else `db`. */
  private readonly writeDb: Pool
  private readonly ceilingRetryDelaysMs: readonly number[]
  /** The start order of content saves, over the adapter: a success covers
   * only what STARTED before it. */
  private contentSaveSeq = 0
  /** documentId -> what of it is not durable yet, and the saves in flight
   * that decide it (`hasUnsavedWrite`). Removed when empty: bounded by the
   * documents with a save in flight or a failure not yet covered. */
  private readonly unsaved = new Map<string, UnsavedDocumentState>()
  /** `close()` ran: no retry is scheduled any more. */
  private closed = false
  private readonly ownershipRefusalGraceMs: number
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
  /** The row version each chunk `loadRange` returned was read at, keyed by
   * the returned bytes' identity: what `noteStrictDecode` binds. Weak, so it
   * lives exactly as long as the caller keeps the chunk. */
  private readonly loadedRowVersions = new WeakMap<Uint8Array, ScopedRowVersion>()
  private readonly durableHeadsMemo: DurableHeadsMemo | null
  /** documentId -> the snapshot row `compactToSnapshot` last wrote for it
   * (its exact version and heads), so the next compaction need not re-check
   * its bytes. Least recently written evicted past `OWN_SNAPSHOT_RECORDS`;
   * a missing record only costs a check. */
  private readonly ownSnapshots = new Map<string, OwnSnapshotRow>()

  constructor(options: PostgresStorageAdapterOptions = {}) {
    this.db = options.db ?? pool
    this.durableHeadsMemo = options.durableHeadsMemo === undefined ? processDurableHeadsMemo : options.durableHeadsMemo
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
    this.writeDb = options.writeDb ?? this.db
    this.ownershipRefusalGraceMs = Math.max(0, options.ownershipRefusalGraceMs ?? STORAGE_UNSAVED_OWNERSHIP_REFUSAL_GRACE_MS)
    this.ceilingRetryDelaysMs = options.ceilingRetryDelaysMs?.length
      ? options.ceilingRetryDelaysMs
      : STORAGE_WRITE_CEILING_RETRY_DELAYS_MS
    // A dedicated write pool is borrowed by this adapter alone: no clamp
    // against other borrowers, so the bound IS its `max`
    // (`AM_STORAGE_WRITE_DB_POOL_MAX`, 4 by default — the shared-pool bound).
    const writeBound = options.writeDb
      ? options.writeDb.options?.max ?? DEFAULT_STORAGE_DB_CONCURRENCY
      : Math.min(DEFAULT_STORAGE_DB_CONCURRENCY, poolMax - 1)
    this.gate = poolConcurrencyGate(
      this.writeDb,
      options.dbConcurrency ?? Math.max(1, writeBound),
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
    /** `writeDb` for the mutations (`withBoundedClient`), `db` otherwise. */
    from: Pool = this.db,
  ): Promise<T> {
    try {
      return await withDbRetry(async () => {
        let client: PoolClient
        try {
          client = await from.connect()
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
      return await this.gate.run(this.gateWaitMs, () => this.withClient(operation, fn, this.writeDb))
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
    const mutation: StorageMutation = {
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
    }
    const seq = isContentChunk && documentId ? this.contentSaveStarted(documentId) : 0
    try {
      await this.withFencedMutation(key, mutation, false, isContentChunk)
    } catch (error) {
      this.noteWriteFailure(isContentChunk ? 'save' : 'save-sync-state', key, error)
      if (isContentChunk && documentId) this.contentSaveFailed(key, documentId, seq, mutation, data.byteLength, error)
      throw error
    }
    if (isContentChunk && documentId) this.contentSaveSucceeded(documentId, seq)
    this.recordLoadedChunk(key, data.byteLength)
  }

  /**
   * True while a CONTENT save of this document failed and nothing covered it
   * since — no save STARTED after it succeeded (the Repo's next save writes
   * everything since its last success), its own retry did not land, no fence
   * refusal said the document is no longer this cell's, no removal took the
   * document away. Its delta then lives only in the Repo's memory, so eviction
   * must refuse it (`AutomergeResidencyLeases.evict`, through the storage
   * probe). O(1).
   */
  hasUnsavedWrite(documentId: string): boolean {
    const state = this.unsaved.get(documentId)
    if (!state || !(state.failed.size || state.retries.size)) return false
    if (state.refusedSince !== null && Date.now() - state.refusedSince >= this.ownershipRefusalGraceMs) {
      // Refused as not-owner for the whole grace: a lost workspace, not a blip.
      console.warn(JSON.stringify({
        event: 'automerge.unsaved_write_released',
        documentId,
        reason: 'ownership-unavailable',
        refusedForMs: Date.now() - state.refusedSince,
      }))
      this.forgetUnsaved(documentId)
      return false
    }
    return true
  }

  /** Where the start order is now: what a flush that resolves will cover. */
  saveCursor(): number {
    return this.contentSaveSeq
  }

  /**
   * A `repo.flush([documentId])` begun at `cursor` RESOLVED: every save it
   * waited for succeeded, or the Repo had nothing to save (its stored heads
   * are the document's). Either way a failed save that started before the
   * flush is no longer only in memory — or no longer in memory at all (the
   * handle was dropped and re-read from storage: `repoFreshness.ts`, a
   * fork's rollback, `documentResolution.ts`), where its mark protects
   * nothing. Those marks go. Pending ceiling RETRIES stay: their bytes may be
   * the only copy left of a delta whose handle was dropped.
   */
  flushSettled(documentId: string, cursor: number): void {
    const state = this.unsaved.get(documentId)
    if (!state) return
    for (const [key, failedSeq] of [...state.failed]) {
      if (failedSeq <= cursor && !state.retries.has(key)) state.failed.delete(key)
    }
    if (!state.failed.size && !state.retries.size) state.refusedSince = null
    this.settleUnsavedState(documentId)
  }

  /** Stop every pending retry: at shutdown, before the pools end. Idempotent. */
  close(): void {
    this.closed = true
    for (const state of this.unsaved.values()) {
      for (const retry of state.retries.values()) clearTimeout(retry.timer)
      state.retries.clear()
    }
  }

  private unsavedState(documentId: string): UnsavedDocumentState {
    let state = this.unsaved.get(documentId)
    if (!state) {
      state = { inFlight: new Set(), coveredUpTo: 0, failed: new Map(), retries: new Map(), refusedSince: null }
      this.unsaved.set(documentId, state)
    }
    return state
  }

  /** Drop the document's entry once nothing in it is left. */
  private settleUnsavedState(documentId: string): void {
    const state = this.unsaved.get(documentId)
    if (state && !state.inFlight.size && !state.failed.size && !state.retries.size) this.unsaved.delete(documentId)
  }

  /** A content save of the document starts: its place in the start order. */
  private contentSaveStarted(documentId: string): number {
    const seq = ++this.contentSaveSeq
    this.unsavedState(documentId).inFlight.add(seq)
    return seq
  }

  /**
   * Everything that STARTED before `seq` is covered: a content save writes
   * every change since the Repo's last successful save, so a later-started
   * save that succeeds (or the retry of one, `inclusive`) makes the delta of
   * every earlier failed one durable. Their marks go, their retries are
   * cancelled (an older retry landing later would only add a redundant chunk,
   * and spend a 120 s attempt on a four-permit pool). A failure that started
   * AFTER `seq` is untouched.
   */
  private coverUpTo(documentId: string, seq: number, inclusive: boolean): void {
    const state = this.unsaved.get(documentId)
    if (!state) return
    const covered = (other: number) => (inclusive ? other <= seq : other < seq)
    state.coveredUpTo = Math.max(state.coveredUpTo, seq)
    for (const [key, failedSeq] of [...state.failed]) if (covered(failedSeq)) state.failed.delete(key)
    for (const [key, retry] of [...state.retries]) {
      if (!covered(retry.seq)) continue
      clearTimeout(retry.timer)
      state.retries.delete(key)
    }
  }

  private contentSaveSucceeded(documentId: string, seq: number): void {
    const state = this.unsaved.get(documentId)
    if (!state) return
    state.inFlight.delete(seq)
    state.refusedSince = null
    this.coverUpTo(documentId, seq, false)
    this.settleUnsavedState(documentId)
  }

  private contentSaveFailed(
    key: StorageKey,
    documentId: string,
    seq: number,
    mutation: StorageMutation,
    byteLength: number,
    error: unknown,
  ): void {
    const state = this.unsavedState(documentId)
    state.inFlight.delete(seq)
    if (isFenceMismatch(error)) {
      // Fenced out: another cell holds the token; the document is no longer
      // this cell's to write.
      this.forgetUnsaved(documentId)
      return
    }
    if (seq < state.coveredUpTo) {
      // A save that started after this one already succeeded: covered.
      this.settleUnsavedState(documentId)
      return
    }
    const keyText = keyToText(key)
    state.failed.set(keyText, seq)
    // Refused as not-owner (`ownership-unavailable`): possibly a blip. The
    // mark stays, for at most the grace (`hasUnsavedWrite`).
    if (error instanceof StaleSyncCellWriteError) state.refusedSince ??= Date.now()
    // The bytes are held for a retry only when a ceiling stopped the save; a
    // sync-state chunk is never here (the next round trip rewrites it).
    if (storageWriteCeilingCode(error)) this.scheduleCeilingRetry(key, documentId, mutation, byteLength, seq, 1)
  }

  /** Nothing of this document is this cell's to make durable any more (a
   * fence refusal, a removal of its content): marks gone, retries cancelled. */
  private forgetUnsaved(documentId: string): void {
    const state = this.unsaved.get(documentId)
    if (!state) return
    for (const retry of state.retries.values()) clearTimeout(retry.timer)
    state.retries.clear()
    state.failed.clear()
    state.refusedSince = null
    // Every save of it started so far is covered: one still in flight that
    // fails later (a removed document, a cell fenced out) neither marks it
    // again nor schedules a retry that would write the chunk back.
    state.coveredUpTo = Math.max(state.coveredUpTo, this.contentSaveSeq + 1)
    this.settleUnsavedState(documentId)
  }

  /** Count and log a failed mutation stopped by a ceiling. */
  private noteWriteFailure(operation: 'save' | 'save-sync-state' | 'remove' | 'removeRange', key: StorageKey, error: unknown): void {
    const documentId = documentIdFromKey(key, operation === 'removeRange')
    if (operation !== 'save' && documentId && isFenceMismatch(error)) {
      // A fence mismatch on any mutation of the document: not this cell's.
      this.forgetUnsaved(documentId)
    }
    const code = storageWriteCeilingCode(error)
    if (!code) return
    noteStorageWriteCeiling(code)
    console.error(JSON.stringify({
      event: 'automerge.storage_write_ceiling',
      code,
      operation,
      documentId,
      chunk: key[1] ?? null,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  /**
   * A content save stopped by a ceiling is retried with the SAME bytes, on a
   * backoff (`ceilingRetryDelaysMs`), through the whole fenced path again.
   * Nobody else would: the Repo saves a document again only on its next edit
   * or flush, and an idle eviction does not flush. The same key carries the
   * same content (content-addressed), so the upsert is idempotent. A retry
   * ends when it lands (and covers what started before it), when a later save
   * of the document covers it, when a fence refusal or a removal of the
   * document cancels it, at `close()`, or past the last delay — logged, the
   * document still unsaved (eviction refuses it and flushes it, see
   * `AutomergeResidencyLeases.evict`). A pool refusal
   * (`StoragePoolExhaustedError`) spends no attempt: it backs off at the last
   * delay and tries again.
   */
  private scheduleCeilingRetry(
    key: StorageKey,
    documentId: string,
    mutation: StorageMutation,
    byteLength: number,
    seq: number,
    attempt: number,
  ): void {
    if (this.closed) return
    const state = this.unsavedState(documentId)
    const keyText = keyToText(key)
    const previous = state.retries.get(keyText)
    if (previous) clearTimeout(previous.timer)
    const delays = this.ceilingRetryDelaysMs
    const delay = delays[Math.min(attempt, delays.length) - 1]!
    const retry: PendingCeilingRetry = { seq, timer: setTimeout(() => {
      const current = () => this.unsaved.get(documentId)?.retries.get(keyText) === retry
      if (!current()) return
      void this.withFencedMutation(key, mutation, false, true).then(() => {
        if (!current()) return
        this.unsaved.get(documentId)!.retries.delete(keyText)
        // THESE bytes are durable, and they cover what started before them.
        this.unsaved.get(documentId)!.refusedSince = null
        this.coverUpTo(documentId, seq, true)
        this.settleUnsavedState(documentId)
        this.recordLoadedChunk(key, byteLength)
        console.warn(JSON.stringify({
          event: 'automerge.storage_write_ceiling_recovered',
          documentId,
          chunk: key[1] ?? null,
          attempt,
        }))
      }, (error: unknown) => {
        if (!current()) return
        this.unsaved.get(documentId)!.retries.delete(keyText)
        this.noteWriteFailure('save', key, error)
        if (isFenceMismatch(error)) {
          this.forgetUnsaved(documentId)
          return
        }
        if (error instanceof StaleSyncCellWriteError) {
          // Not owner for now (possibly a blip): back off without spending an
          // attempt; the grace bounds how long this can hold the document.
          this.unsaved.get(documentId)!.refusedSince ??= Date.now()
          // Past the grace, `hasUnsavedWrite` releases the document: stop.
          if (!this.hasUnsavedWrite(documentId)) return
          this.scheduleCeilingRetry(key, documentId, mutation, byteLength, seq, Math.max(attempt, delays.length))
          return
        }
        if (error instanceof StoragePoolExhaustedError) {
          this.scheduleCeilingRetry(key, documentId, mutation, byteLength, seq, Math.max(attempt, delays.length))
          return
        }
        if (storageWriteCeilingCode(error) && attempt < delays.length) {
          this.scheduleCeilingRetry(key, documentId, mutation, byteLength, seq, attempt + 1)
          return
        }
        this.settleUnsavedState(documentId)
        console.error(JSON.stringify({
          event: 'automerge.storage_write_ceiling_retry_exhausted',
          documentId,
          chunk: key[1] ?? null,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    }, delay) }
    retry.timer.unref?.()
    state.retries.set(keyText, retry)
  }

  async remove(key: StorageKey): Promise<void> {
    try {
      await this.withFencedMutation(key, {
        sql: (first, permission) => `DELETE FROM automerge_storage
          WHERE key = $${first}${permission ? ` AND EXISTS (SELECT 1 FROM ${permission})` : ''}
          RETURNING 1`,
        params: [keyToText(key)],
      })
    } catch (error) {
      // Counted, not retried: a chunk left behind is redundant (a snapshot
      // that covers it is already durable), and the next compaction removes it.
      this.noteWriteFailure('remove', key, error)
      throw error
    }
    // That chunk is gone: a retry of it would put it back, its mark is moot.
    const documentId = documentIdFromKey(key)
    const state = documentId ? this.unsaved.get(documentId) : undefined
    if (documentId && state) {
      const keyText = keyToText(key)
      const retry = state.retries.get(keyText)
      if (retry) clearTimeout(retry.timer)
      state.retries.delete(keyText)
      state.failed.delete(keyText)
      this.settleUnsavedState(documentId)
    }
    this.removeLoadedChunk(key)
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return this.withClient('loadRange', async (client) => {
      const prefix = keyToText(keyPrefix)
      // Match the prefix exactly OR any deeper key under it. `LIKE` needs the
      // prefix's special chars escaped; storage keys are alphanumeric/base58/hex
      // so the only realistic specials are none, but escape defensively.
      const escaped = prefix.replace(/([%_\\])/g, '\\$1')
      // `arrival_seq` comes from the SAME row version as `data` (one
      // statement), so (key, arrival_seq, byte length) names these bytes —
      // within the table the row is in, which `durable_scope` names
      // (`readModel/durableHeadsMemo.ts`, THE SCOPE).
      const { rows } = await client.query<{ key: string; data: Buffer; arrival_seq: string | null; durable_scope: string | null }>(
        `SELECT key, data, arrival_seq::text AS arrival_seq,
           ${durableHeadsScopeSql('automerge_storage')} AS durable_scope
         FROM automerge_storage
         WHERE key = $1 OR key LIKE $2 || '/%' ESCAPE '\\'`,
        [prefix, escaped]
      )
      return rows.map((row) => {
        const key = textToKey(row.key)
        const data = toUint8Array(row.data)
        this.recordLoadedChunk(key, data.byteLength)
        this.loadedRowVersions.set(data, {
          key: row.key, arrivalSeq: row.arrival_seq ?? null, octets: data.byteLength, scope: row.durable_scope ?? null,
        })
        return { key, data }
      })
    })
  }

  /**
   * Called by the patched `StorageSubsystem.loadDoc`
   * (`patch-automerge-strict-decode.mjs`) ONLY when `A.load` accepted the
   * merged chunks without the `loadIncremental` fallback and
   * `getMissingDeps(doc, [])` was empty. Binds those heads to the exact row
   * versions `loadRange` read; any chunk this adapter did not read, a
   * non-content key, another document's key or a NULL `arrival_seq` binds
   * nothing. Synchronous and never throws into the load.
   */
  noteStrictDecode(documentId: string, chunks: readonly { key: StorageKey; data?: Uint8Array }[], heads: readonly string[]): void {
    const memo = this.durableHeadsMemo
    if (!memo) return
    // Each version keeps the scope its row was read with; the memo refuses a
    // set whose rows disagree on it.
    const rows: ScopedRowVersion[] = []
    for (const chunk of chunks) {
      const version = chunk.data ? this.loadedRowVersions.get(chunk.data) : undefined
      if (!version || version.arrivalSeq === null || chunk.key[0] !== documentId
        || (chunk.key[1] !== 'snapshot' && chunk.key[1] !== 'incremental')
        || version.key !== keyToText(chunk.key)) {
        memo.forget(documentId)
        return
      }
      rows.push(version)
    }
    memo.remember(documentId, rows, heads)
  }

  /**
   * Replace the stored rows of `documentId` that `doc` covers by ONE snapshot
   * row, `A.save(doc)`, in ONE fenced statement (G4-16f; the coverage rule
   * and its argument: `storageSnapshotCompaction.ts`).
   *
   * Crash safety: the snapshot's upsert and the deletes are data-modifying
   * CTEs of the same statement, so they commit together or not at all —
   * before it, the old rows; after it, the snapshot (plus any row not
   * covered). There is no instant at which neither is readable. A covered
   * row is deleted by its exact version (key, arrival_seq, octet length): a
   * row rewritten since the check is not. The fence is `save`'s (the same
   * statement shape, `withFencedMutation`).
   *
   * The memo entry, and why it is sound: on success the durable-heads memo
   * is told that the ONE row version this statement wrote — read back from
   * its own RETURNING,
   * scope included — decodes to `A.getHeads(doc)`: the heads this process
   * just made durable itself, never heads read from anywhere else. The
   * proof's lookup still needs the CURRENT row set to EQUAL that one row.
   *
   * Never throws for coverage reasons; a storage error (a fence refusal, a
   * pool refusal) propagates and changes nothing.
   */
  async compactToSnapshot(documentId: string, doc: A.Doc<unknown>): Promise<SnapshotCompactionOutcome> {
    const started = performance.now()
    const skipped = (reason: SnapshotCompactionSkip, rowsBefore = 0): SnapshotCompactionOutcome => ({
      outcome: 'skipped', reason, rowsBefore, removed: 0, kept: rowsBefore, snapshotOctets: 0, remembered: false,
      ms: Math.round(performance.now() - started),
    })
    if (!isValidAutomergeUrl(`automerge:${documentId}`)) return skipped('invalid-document')
    // PINNED, before any await: `doc` is a
    // handle's value, and once the handle changes it is an OUTDATED view —
    // automerge 3.2.6's `getHeads`/`clone` honour its frozen heads while
    // `save`, `hasHeads` and `getMissingDeps` read the LIVE wasm state
    // (measured). A clone is a document of its own at exactly `doc`'s heads,
    // so every question below (missing deps, heads, coverage, the bytes)
    // is asked of ONE state. Freed in the `finally`.
    let pinned: A.Doc<unknown>
    try {
      pinned = A.clone(doc)
    } catch {
      return skipped('invalid-document')
    }
    try {
      return await this.compactPinned(documentId, pinned, skipped, started)
    } finally {
      A.free(pinned)
    }
  }

  private async compactPinned(
    documentId: string,
    doc: A.Doc<unknown>,
    skipped: (reason: SnapshotCompactionSkip, rowsBefore?: number) => SnapshotCompactionOutcome,
    started: number,
  ): Promise<SnapshotCompactionOutcome> {
    // A document with a queued change (a missing dependency) is not one whose
    // save we can vouch for: leave its storage alone.
    if (A.getMissingDeps(doc, []).length) return skipped('missing-deps')
    const heads = A.getHeads(doc)
    if (!heads.length) return skipped('empty-document')
    const own = this.ownSnapshots.get(documentId)
    const { rows } = await this.withClient('compact-read', (client) => client.query<{
      key: string; arrival_seq: string | null; octets: number; digest: string; durable_scope: string | null; data: Buffer | null
    }>(
      `SELECT key, arrival_seq::text AS arrival_seq, octet_length(data) AS octets, md5(data) AS digest,
         ${durableHeadsScopeSql('automerge_storage')} AS durable_scope,
         CASE WHEN key = $2 AND arrival_seq::text = $3 AND md5(data) = $4 THEN NULL ELSE data END AS data
       FROM automerge_storage
       WHERE split_part(key, '/', 1) = $1
         AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
      [documentId, own?.key ?? '', own?.arrivalSeq ?? '', own?.digest ?? ''],
    ))
    if (!rows.length) return skipped('no-rows')
    if (rows.length === 1 && rows[0]!.key.split('/')[1] === 'snapshot') return skipped('already-compact', 1)
    const candidates: CompactionCandidateRow[] = rows.map((row) => ({
      key: row.key,
      arrivalSeq: row.arrival_seq ?? null,
      octets: Number(row.octets),
      digest: row.digest,
      scope: row.durable_scope ?? null,
      ...(row.data ? { data: toUint8Array(row.data) } : {}),
    }))
    const { covered, kept: notCovered } = partitionCoveredRows(doc, heads, candidates, own)
    if (!covered.length) return skipped('nothing-covered', rows.length)
    const bytes = A.save(doc)
    const key = snapshotStorageKey(documentId, heads)
    const keyText = keyToText(key)
    // The snapshot's own key is upserted, never deleted.
    const deletions = covered.filter((row) => row.key !== keyText)
    const result = await this.withFencedMutation(key, {
      ctes: (first, permission) => `compaction_insert AS (
          INSERT INTO automerge_storage (key, data)
          SELECT $${first}, $${first + 1}${permission ? ` FROM ${permission}` : ''}
          ON CONFLICT (key) DO UPDATE
          SET data = EXCLUDED.data, updated_at = NOW(),
              arrival_seq = nextval('automerge_arrival_seq')
          RETURNING key, arrival_seq::text AS arrival_seq, octet_length(data) AS octets, md5(data) AS digest,
            ${durableHeadsScopeSql('automerge_storage')} AS durable_scope
        ),
        compaction_delete AS (
          DELETE FROM automerge_storage AS storage
          USING unnest($${first + 2}::text[], $${first + 3}::text[], $${first + 4}::int[], $${first + 5}::text[])
            AS covered(key, arrival_seq, octets, digest)
          WHERE storage.key = covered.key
            AND storage.arrival_seq::text IS NOT DISTINCT FROM covered.arrival_seq
            AND octet_length(storage.data) = covered.octets
            -- The bytes too: a write that kept the sequence (a NULL
            -- one, a hand edit, a restore) must not pass for the checked row.
            AND md5(storage.data) = covered.digest
            AND storage.key <> $${first}
            AND EXISTS (SELECT 1 FROM compaction_insert)
          RETURNING storage.key
        ),`,
      sql: () => 'SELECT 1 FROM compaction_insert',
      params: [
        keyText,
        Buffer.from(bytes),
        deletions.map((row) => row.key),
        deletions.map((row) => row.arrivalSeq),
        deletions.map((row) => row.octets),
        deletions.map((row) => row.digest ?? ''),
      ],
      returning: `(SELECT row_to_json(inserted) FROM compaction_insert AS inserted) AS compaction_inserted,
        (SELECT coalesce(array_agg(deleted.key), '{}') FROM compaction_delete AS deleted) AS compaction_deleted`,
      enqueueDocumentId: this.trackStaticReadModel ? documentId : undefined,
    })
    const inserted = result?.compaction_inserted as
      { key: string; arrival_seq: string | null; octets: number; digest: string; durable_scope: string | null } | null | undefined
    const deletedKeys = (result?.compaction_deleted as string[] | undefined) ?? []
    for (const deleted of deletedKeys) this.removeLoadedChunk(textToKey(deleted))
    if (!inserted || inserted.key !== keyText || inserted.arrival_seq === null) {
      // Not written (cannot happen once the statement returned: a refusal
      // throws). Nothing to remember.
      this.ownSnapshots.delete(documentId)
      return { ...skipped('not-written', rows.length), removed: deletedKeys.length, kept: rows.length - deletedKeys.length }
    }
    this.recordLoadedChunk(key, bytes.byteLength)
    const version: ScopedRowVersion = {
      key: inserted.key, arrivalSeq: inserted.arrival_seq, octets: Number(inserted.octets), scope: inserted.durable_scope ?? null,
    }
    this.rememberOwnSnapshot(documentId, { ...version, arrivalSeq: inserted.arrival_seq, digest: inserted.digest, heads })
    // Rows left beside the snapshot (derived from the partition): not
    // covered — a row of the snapshot's own key is overwritten by the
    // upsert, not left — or covered and changed since the check, so not
    // deleted by the statement.
    const kept = notCovered.filter((row) => row.key !== keyText).length + (deletions.length - deletedKeys.length)
    // The memo entry: the heads of the row version THIS statement wrote,
    // which are the heads of `bytes` — `A.save` of the pinned, dependency-complete `doc`
    // (checked above) loads strictly to exactly them. Only when nothing is
    // left beside it: otherwise the current set cannot equal
    // `{that row}` and the entry could never answer (sound either way).
    const remembered = kept === 0 ? (this.durableHeadsMemo?.remember(documentId, [version], heads) ?? false) : false
    return {
      outcome: 'compacted',
      rowsBefore: rows.length,
      removed: deletedKeys.length,
      kept,
      snapshotOctets: bytes.byteLength,
      remembered,
      ms: Math.round(performance.now() - started),
    }
  }

  private rememberOwnSnapshot(documentId: string, row: OwnSnapshotRow): void {
    this.ownSnapshots.delete(documentId)
    this.ownSnapshots.set(documentId, row)
    while (this.ownSnapshots.size > OWN_SNAPSHOT_RECORDS) {
      this.ownSnapshots.delete(this.ownSnapshots.keys().next().value as string)
    }
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = keyToText(keyPrefix)
    const escaped = prefix.replace(/([%_\\])/g, '\\$1')
    try {
      await this.withFencedMutation(keyPrefix, {
        sql: (first, permission) => `DELETE FROM automerge_storage
          WHERE (key = $${first} OR key LIKE $${first + 1} || '/%' ESCAPE '\\')
            ${permission ? `AND EXISTS (SELECT 1 FROM ${permission})` : ''}
          RETURNING 1`,
        params: [prefix, escaped],
      }, true)
    } catch (error) {
      this.noteWriteFailure('removeRange', keyPrefix, error)
      throw error
    }
    // The document's content removed (`removeDoc`, a fork's rollback): a
    // pending retry would resurrect a chunk of it — and queue a read-model
    // revision for a document that no longer exists.
    const documentId = documentIdFromKey(keyPrefix, true)
    if (documentId && (keyPrefix.length === 1 || keyPrefix[1] === 'snapshot' || keyPrefix[1] === 'incremental')) {
      this.forgetUnsaved(documentId)
      // Memory only: a removed row already changes the set and misses.
      this.durableHeadsMemo?.forget(documentId)
      // Hygiene, not soundness: an own-snapshot record only ever matches the
      // exact row version it wrote.
      this.ownSnapshots.delete(documentId)
    }
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
  ): Promise<Record<string, unknown> | undefined> {
    const documentId = documentIdFromKey(key, allowDocumentPrefix)
    const ownership = this.ownership
    const mutationKind = storageMutationKind(key, allowDocumentPrefix)
    const mutationIdentity = keyToText(key)
    if (!documentId || !ownership) {
      return this.executeUnfencedMutation(mutation)
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
      return this.executeLegacyFencedMutation(
        documentId,
        mutationIdentity,
        mutation,
        ownership,
        mutationKind,
        coalesceOwnershipUnavailable,
      )
    }

    // ONE PERMIT AND ONE CLIENT FOR THE WHOLE OPERATION, including the resample.
    // The loop is bounded to two passes — its only `continue` is guarded by
    // `resampledAdmission`, which is set immediately above it — so the permit
    // cannot be held indefinitely by a spin. The two statements were previously
    // two separate borrows; they are now one, which also removes a window in
    // which the adapter could hold two clients per mutation.
    return this.withBoundedClient('fenced-mutation', async (client) => {
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
        const extraCtes = mutation.ctes?.(fixed.length + 1, 'mutation_permission') ?? ''
        const returning = mutation.returning ? `,\n             ${mutation.returning}` : ''
        const { rows } = await client.query<{
          mapped: boolean
          fence_valid: boolean
          permitted: boolean
        } & Record<string, unknown>>(
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
           ${extraCtes}
           mutation AS (
             ${mutationSql}
           )
           ${queueCte}
           SELECT
             EXISTS (SELECT 1 FROM document_mapping) AS mapped,
             EXISTS (SELECT 1 FROM valid_fence) AS fence_valid,
             EXISTS (SELECT 1 FROM mutation_permission) AS permitted${returning}`,
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
        return result
      }
    })
  }

  private async executeUnfencedMutation(mutation: StorageMutation): Promise<Record<string, unknown> | undefined> {
    return this.withBoundedClient('unfenced-mutation', async (client) => {
      const parameters = [...mutation.params]
      let documentParameter = ''
      if (mutation.enqueueDocumentId) {
        parameters.push(mutation.enqueueDocumentId)
        documentParameter = `$${parameters.length}`
      }
      const queueCte = documentParameter ? this.readModelQueueCte(documentParameter) : ''
      const { rows } = await client.query<Record<string, unknown>>(
        `WITH ${mutation.ctes?.(1, null) ?? ''} mutation AS (
           ${mutation.sql(1, null)}
         )
         ${queueCte}
         SELECT EXISTS (SELECT 1 FROM mutation) AS mutated${mutation.returning ? `, ${mutation.returning}` : ''}`,
        parameters,
      )
      return rows[0]
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
  ): Promise<Record<string, unknown> | undefined> {

    // The borrow, the permit and the release belong to `withBoundedClient`
    // (do not duplicate them here, and never release the client again). What
    // stays here is the only part that is this branch's own: the transaction, and the `error`
    // listener that must be removed before the client goes back to the pool.
    return this.withBoundedClient('legacy-fenced-mutation', async (client) => {
      let result: Record<string, unknown> | undefined
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
        if (mutation.ctes || mutation.returning) {
          const { rows } = await client.query<Record<string, unknown>>(
            `WITH ${mutation.ctes?.(1, null) ?? ''} mutation AS (${mutation.sql(1, null)})
             SELECT EXISTS (SELECT 1 FROM mutation) AS mutated${mutation.returning ? `, ${mutation.returning}` : ''}`,
            mutation.params,
          )
          result = rows[0]
        } else {
          await client.query(mutation.sql(1, null), mutation.params)
        }
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
        return result
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
