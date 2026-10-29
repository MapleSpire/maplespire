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

import { randomUUID } from 'node:crypto'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'

export type ProjectionKind =
  | 'cold_build'
  | 'object_shard'
  | 'connection_shard'
  | 'registry'
  | 'metadata'
  | 'monolith'

/** Subsystems that can degrade independently of the main projection loop. */
export type DegradationKind = ProjectionKind | 'document_resolution'

export type ReadModelWorkspaceStatus =
  | 'healthy'
  | 'degraded'
  /** Durable writes the projector never noticed. See STALE_GRACE_MS. */
  | 'stale'
  | 'catching_up'
  | 'failed'
  | 'idle'
  | 'uninitialized'

/**
 * How long a durable write may sit unobserved before the workspace is `stale`.
 *
 * This is the out-of-band detector,
 * and the reason it cannot be built out of the generation counters: those are
 * incremented from inside the change watcher, so orphaning the watcher freezes
 * them and the workspace reports `healthy` forever. The detector's input is
 * produced by the path that failed. `automerge_storage.updated_at` is written by
 * the storage adapter regardless of any watcher, so it can contradict them.
 *
 * The grace exists because a write landing microseconds after a projection is
 * ordinary, not stale: the projector is about to see it, at which point
 * `observed > projected` and the workspace reads `catching_up` instead. Only a
 * write that is BOTH newer than the last projection AND old enough to have been
 * noticed indicates that nothing is coming.
 */
const DEFAULT_STALE_GRACE_MS = 60_000

export function staleGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.READ_MODEL_STALE_GRACE_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_GRACE_MS
  const parsed = Number(raw)
  // `>= 1`, not `>= 0`: `Number('') === 0`, so a dangling `VAR=` must not
  // parse as zero, and a zero grace would report every in-flight write as
  // stale.
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_STALE_GRACE_MS
}

export interface ProjectionToken {
  generation: number
  startedAtMs: number
}

export interface ReadModelWorkspaceHealth {
  landscapeId: string
  landscapeName: string
  versionId: string
  versionName: string
  status: ReadModelWorkspaceStatus
  projectorAttached: boolean
  observedGeneration: number
  projectedGeneration: number
  pendingGenerations: number
  lagMs: number
  stalenessMs: number | null
  lastProjectedAt: string | null
  lastDurationMs: number | null
  lastErrorAt: string | null
  lastErrorCode: string | null
  /** Set while the workspace serves its last coherent read model but a
   * subsystem could not complete its projection. */
  degradedSince: string | null
  degradedKind: DegradationKind | null
  degradedErrorCode: string | null
  /** Newest durable Automerge chunk write across this workspace's documents,
   * read straight from storage rather than from anything the projector reports
   * about itself. Null when no document is mapped to the workspace yet. */
  newestDurableWriteAt: string | null
}

export interface OrgReadModelHealth {
  enabled: boolean
  generatedAt: string
  counts: Record<ReadModelWorkspaceStatus, number>
  worstLagMs: number
  totalWorkspaceCount: number
  listedWorkspaceCount: number
  workspaces: ReadModelWorkspaceHealth[]
}

interface ProjectionRow extends Record<string, unknown> {
  landscape_id: string
  landscape_name: string | null
  version_id: string
  version_name: string | null
  has_state: boolean
  observed_generation: string | number | null
  projected_generation: string | number | null
  source_changed_at: Date | string | null
  last_projected_at: Date | string | null
  last_duration_ms: number | null
  last_error_at: Date | string | null
  last_error_generation: string | number | null
  last_error_code: string | null
  projector_attached: boolean | null
  degraded_since: Date | string | null
  degraded_kind: DegradationKind | null
  degraded_error_code: string | null
  newest_durable_write_at: Date | string | null
}

function boundedErrorCode(error: unknown): string {
  const candidate = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : typeof (error as { name?: unknown })?.name === 'string'
      ? (error as { name: string }).name
      : 'projection_failed'
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64)
  return normalized || 'projection_failed'
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function msSince(value: Date | string | null, nowMs: number): number | null {
  const timestamp = iso(value)
  return timestamp === null ? null : Math.max(0, nowMs - Date.parse(timestamp))
}

/** Atomically records one server-observed source event and allocates its
 * monotonic generation. This measures projector backlog after the server sees
 * a document change; it deliberately does not claim to measure client-to-server
 * network latency. */
export async function beginReadModelProjection(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  kind: ProjectionKind
): Promise<ProjectionToken> {
  const { rows } = await db.query<{ observed_generation: string | number }>(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, observed_generation,
       source_changed_at, projection_started_at, last_projection_kind, updated_at
     ) VALUES ($1, $2, $3, 1, now(), now(), $4, now())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, read_model_projection_state.org_id),
       observed_generation = read_model_projection_state.observed_generation + 1,
       source_changed_at = now(),
       projection_started_at = now(),
       last_projection_kind = EXCLUDED.last_projection_kind,
       updated_at = now()
     RETURNING observed_generation`,
    [key.landscapeId, key.versionId, orgId, kind]
  )
  return { generation: Number(rows[0].observed_generation), startedAtMs: Date.now() }
}

/** A generation for a change that projects NO source document — a repair of a
 * derived column (`StaticDeltaProjector.publishC4ParentRepair`) — allocated
 * and advanced in ONE statement, on the caller's transaction, so it commits or
 * rolls back with the rows and the change event it describes.
 *
 * Moves the two generation counters and nothing else. `begin`/`complete`
 * would also stamp `last_projected_at`, `source_changed_at` and the error
 * columns — freshness the caller did not earn: a pending durable write would
 * stop reading `stale`, an attach-only workspace (`last_projected_at` NULL)
 * would turn from `uninitialized` to `healthy`, a failed generation's error
 * would be cleared, and `absenceProvable`'s timestamp fallback would cover a
 * document nothing projected (`projectionStatusSql`,
 * `getWorkspaceProjectionFreshness`).
 *
 * `projected_generation` follows only when the workspace was CAUGHT UP. Behind
 * (a failed projection, or a former owner's pool-side token that never
 * committed), it stays where it is, and the status keeps saying
 * `catching_up` / `failed` rather than being advanced past a generation
 * nothing projected. The event is then NOT served when the backlog completes
 * — those tokens are all below it and `complete` takes their GREATEST — but
 * once a projection allocated AFTER it completes (`roReadModelChanges` serves
 * only `generation <= projected_generation`); a reader whose cursor sits
 * below the hole gets `resetRequired` either way. On a quiet workspace that
 * can be the next edit. Measured by "a workspace behind…" in
 * staticDeltaProjector.c4ParentRepair.integration.test.ts. */
export async function advanceReadModelGenerationWithinTransaction(
  tx: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
): Promise<ProjectionToken> {
  // Every right-hand side reads the row as it stood before this UPDATE
  // (PostgreSQL SET semantics), so `projected_generation` compares the OLD
  // counters.
  const { rows } = await tx.query<{ observed_generation: string | number }>(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, observed_generation, projected_generation, updated_at
     ) VALUES ($1, $2, $3, 1, 1, now())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, read_model_projection_state.org_id),
       observed_generation = read_model_projection_state.observed_generation + 1,
       projected_generation = CASE
         WHEN read_model_projection_state.projected_generation >= read_model_projection_state.observed_generation
           THEN GREATEST(read_model_projection_state.projected_generation, read_model_projection_state.observed_generation + 1)
         ELSE read_model_projection_state.projected_generation
       END,
       updated_at = now()
     RETURNING observed_generation`,
    [key.landscapeId, key.versionId, orgId],
  )
  return { generation: Number(rows[0].observed_generation), startedAtMs: Date.now() }
}

export async function completeReadModelProjection(
  db: Queryable,
  key: WorkspaceKey,
  token: ProjectionToken
): Promise<void> {
  const durationMs = Math.max(0, Math.round(Date.now() - token.startedAtMs))
  await db.query(
    `UPDATE read_model_projection_state SET
       projected_generation = GREATEST(projected_generation, $3),
       last_projected_at = CASE WHEN projected_generation <= $3 THEN now() ELSE last_projected_at END,
       last_duration_ms = CASE WHEN projected_generation <= $3 THEN $4 ELSE last_duration_ms END,
       last_error_at = CASE WHEN last_error_generation <= $3 THEN NULL ELSE last_error_at END,
       last_error_generation = CASE WHEN last_error_generation <= $3 THEN NULL ELSE last_error_generation END,
       last_error_code = CASE WHEN last_error_generation <= $3 THEN NULL ELSE last_error_code END,
       consecutive_failures = CASE WHEN last_error_generation <= $3 THEN 0 ELSE consecutive_failures END,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId, token.generation, durationMs]
  )
}

export async function failReadModelProjection(
  db: Queryable,
  key: WorkspaceKey,
  token: ProjectionToken,
  error: unknown
): Promise<void> {
  await db.query(
    `UPDATE read_model_projection_state SET
       last_error_at = CASE
         WHEN $3 > projected_generation AND (last_error_generation IS NULL OR $3 >= last_error_generation) THEN now()
         ELSE last_error_at
       END,
       last_error_generation = CASE
         WHEN $3 > projected_generation AND (last_error_generation IS NULL OR $3 >= last_error_generation) THEN $3
         ELSE last_error_generation
       END,
       last_error_code = CASE
         WHEN $3 > projected_generation AND (last_error_generation IS NULL OR $3 >= last_error_generation) THEN $4
         ELSE last_error_code
       END,
       consecutive_failures = CASE WHEN $3 > projected_generation THEN consecutive_failures + 1 ELSE consecutive_failures END,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId, token.generation, boundedErrorCode(error)]
  )
}

/**
 * Record that a workspace still serves its last coherent read model while one
 * subsystem could not complete its projection (a PostgreSQL outage, a
 * projection fault, a referenced document that exhausted its retry budget).
 *
 * Degradation is deliberately sticky: it is only cleared by
 * `clearReadModelWorkspaceDegraded` after a full successful projection, so a
 * partially-projected workspace can never report itself healthy. The first
 * degradation timestamp is kept — operators need the start of the incident,
 * not the newest repetition of it.
 *
 * ONE PRODUCTION CALLER, and that is load-bearing: `projectorService.ts`'s
 * `publishDegradation`, which is also the only caller of the clear below.
 * Stickiness is only safe while the writer that marks is the writer that can
 * clear.
 *
 * In particular `staticDeltaProjector.ts` must NOT call this: the fleet refuses
 * to attach an ordinary projector to a static workspace
 * (`ProjectorStaticWorkspaceError`), so the only clear would be unreachable for
 * those workspaces — a degradation with no lift, blocking promotion,
 * reference-integrity repair and `absenceProvable` for ever.
 * `invalidateWorkspaceCoverage` is the right signal there and has a real lift
 * (`coverWorkspace`'s CAS on the monotone `invalidations` counter).
 *
 * So before adding a second caller, say which mechanism clears what it writes —
 * and go READ that mechanism, at the site that would have to run for the
 * workspace you are marking. Pinned by `staticDeltaProjector.test.ts`
 * ("a failed rotation claim de-covers durably and NEVER touches the health
 * row") and `overlayChainFoldPass.test.ts` (the fold's twin).
 */
export async function markReadModelWorkspaceDegraded(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  kind: DegradationKind,
  error: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, degraded_since, degraded_kind, degraded_error_code, updated_at
     ) VALUES ($1, $2, $3, now(), $4, $5, now())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, read_model_projection_state.org_id),
       degraded_since = COALESCE(read_model_projection_state.degraded_since, now()),
       degraded_kind = EXCLUDED.degraded_kind,
       degraded_error_code = EXCLUDED.degraded_error_code,
       updated_at = now()`,
    [key.landscapeId, key.versionId, orgId, kind, boundedErrorCode(error)]
  )
}

/**
 * Return a workspace to a non-degraded state. Only call this after a complete
 * successful projection of the subsystem that degraded.
 *
 * Unconditional, DELIBERATELY — do not add a compare-and-set on
 * `projector_instance_id` to protect the true owner's degradation:
 *
 *   - the column does not identify "the projector that owns this workspace".
 *     `StaticDeltaProjector.reloadDescriptors` writes it too, with its own
 *     instance id, in the SAME process and after the fleet has attached — so on
 *     a static workspace such a CAS fails deterministically at every boot;
 *   - it would make the clear depend on a separate write having landed,
 *     putting the row permanently beyond repair whenever that write failed or
 *     its ack was lost.
 *
 * Ownership is process-local knowledge and is checked where it lives:
 * `ProjectorFleet.ownsWorkspace`, threaded into the projector as `stillOwned`
 * and consulted before any health write.
 */
export async function clearReadModelWorkspaceDegraded(
  db: Queryable,
  key: WorkspaceKey
): Promise<void> {
  await db.query(
    `UPDATE read_model_projection_state SET
       degraded_since = NULL,
       degraded_kind = NULL,
       degraded_error_code = NULL,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2 AND degraded_since IS NOT NULL`,
    [key.landscapeId, key.versionId]
  )
}

export async function markReadModelProjectorAttached(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  instanceId: string
): Promise<void> {
  await db.query(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, projector_attached, projector_instance_id, updated_at
     ) VALUES ($1, $2, $3, true, $4, now())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, read_model_projection_state.org_id),
       projector_attached = true,
       projector_instance_id = EXCLUDED.projector_instance_id,
       updated_at = now()`,
    [key.landscapeId, key.versionId, orgId, instanceId]
  )
}

/**
 * The ROW-WRITE fence. `write_fence` names the instance whose cold build most
 * recently rebuilt this workspace's ro_* rows. The contract:
 *
 *  - the cold build CLAIMS the fence inside the same transaction that writes
 *    its rows, at the END of the row writes, and the claim is a CAS: it only
 *    lands if the fence still holds the value this build observed when it
 *    began (`expectedPrevious`). A missed CAS throws and the whole build
 *    rolls back — this is what stops a released build that commits LAST from
 *    stealing the fence off the live takeover, including when the
 *    process-local lease check cannot see the takeover at all (a stale lease
 *    copy, or ownership disabled entirely — two processes on one database);
 *  - every projection transaction ASSERTS the fence `FOR UPDATE` immediately
 *    before it completes. A mismatch throws, rolling back rows, watermark,
 *    change feed and integrity stamp together — so a disowned pass cannot
 *    commit AFTER the takeover's cold build.
 *
 * The comparison alone is NOT the whole mechanism. A third interleaving is a
 * straggler whose transaction is ALREADY OPEN when the takeover's cold build
 * starts: under READ COMMITTED the cold build's blanket DELETE keeps its
 * statement snapshot while blocked on the straggler's row locks, so a pure
 * INSERT the straggler commits mid-build would survive the rebuild as a
 * phantom row, certified by the cold build's own watermark. What closes it is the
 * projection MUTEX (`pg_advisory_xact_lock`, taken as the first statement of
 * every fenced transaction — see runTracked in projectorService.ts): whole
 * projection transactions serialize per workspace, so the straggler either
 * commits before the cold build's first statement (and is fully rewritten)
 * or waits and dies on this assert. Fence for authority, mutex for
 * atomicity-against-concurrency; each is unsound alone.
 *
 * Deliberately NOT `projector_instance_id`: that column has a second writer
 * (`StaticDeltaProjector.reloadDescriptors`, same process, after the fleet
 * attaches) and a CAS on it fails deterministically at every boot on a static
 * workspace — see `clearReadModelWorkspaceDegraded` above.
 *
 * The invariant that makes the CAS sound: **every value ever written here is
 * globally unique, and no writer re-writes a value another writer may still be
 * comparing against.** Projectors mint a `randomUUID()` per claim; the
 * lifecycle transition ({@link claimLifecycleWriteFence}) mints per transition
 * for the same reason. One constant sentinel would be an ABA that lets a cold
 * build commit over a re-promoted workspace.
 *
 * Two cold builds racing (two cells booting the same workspace without fleet
 * coordination) resolve to FIRST-claim-wins: both observed the same previous
 * fence, the first committer moves it, the second's CAS matches zero rows and
 * its whole build rolls back loudly. That is the single-writer invariant of
 * arrivalWatermark.ts made enforceable instead of assumed. The lifecycle writer
 * is the one participant that does NOT compare — it means "nobody ordinary owns
 * this any more", so it has no previous value to be right about — and a reader
 * who checks this header and stops must not conclude the fence is always
 * CAS-protected.
 */
export class ReadModelWriteFenceError extends Error {
  /** Bounded, snake_case, and NEVER persisted by `failReadModelProjection` —
   * a disowned pass writing failure telemetry onto the new owner's row is the
   * same forgery as writing rows, one table over. The code exists for logs. */
  readonly code = 'write_fence_lost'
  constructor(key: WorkspaceKey, expected: string, actual: string | null | undefined) {
    // Name the LIFECYCLE holder for what it is. This message exists for logs by
    // its own docstring, and `held by lifecycle:promote:<uuid>` reads to an
    // operator as another projector instance unless it says otherwise — which
    // sends them hunting for a second cell that does not exist, on the one
    // occasion where the rollback is entirely correct and expected.
    const holder = isLifecycleWriteFence(actual)
      ? `a workspace lifecycle transition (${actual}) — this workspace was promoted or demoted while `
        + 'this projection was running, so rolling back is the correct outcome, not a fault'
      : actual ?? 'nobody'
    super(
      `read-model write fence lost for ${key.landscapeId}/${key.versionId}: ` +
        `held by ${holder}, this instance is ${expected}`,
    )
    this.name = 'ReadModelWriteFenceError'
  }
}

/** Read the fence without locking it. Used for the observation a claim's CAS
 * compares against, and for the cheap pre-`begin` check that keeps a
 * known-dead pass from bumping the new owner's `observed_generation` (the
 * begin runs on the pool, outside the transaction, so a rollback cannot undo
 * it). Null when the row does not exist yet OR carries no
 * fence; the two mean the same thing to a claimer. */
export async function readWriteFence(
  db: Queryable,
  key: WorkspaceKey
): Promise<string | null> {
  const { rows } = await db.query<{ write_fence: string | null }>(
    `SELECT write_fence FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId]
  )
  return rows[0]?.write_fence ?? null
}

/**
 * The prefix every LIFECYCLE-written fence value carries.
 *
 * A promotion writes the fence to hand the `ro_*` plane over: any ordinary
 * projection already in flight then fails its own end-of-transaction assert and
 * rolls back its whole cold build. Two properties of the value are load-bearing
 * and neither is decoration:
 *
 *  - it is SELF-DESCRIBING. A bare uuid here is indistinguishable from a
 *    projector instance id, and `ReadModelWriteFenceError` renders the holder
 *    into a log line that an operator reads as "another projector took it";
 *  - it is UNIQUE PER TRANSITION, minted with `randomUUID`. A constant sentinel
 *    would be an ABA against the CAS below, which compares by VALUE: the
 *    demotion does not clear the fence, so a projector attaching afterwards
 *    observes the sentinel as its `expectedPrevious`, and a re-promotion
 *    landing mid-build would write the SAME value and let that build's CAS
 *    match and commit — the exact erasure the sentinel exists to stop. See the
 *    uniqueness invariant on {@link ReadModelWriteFenceError}'s header above.
 *
 * `lifecycleWriteFenceValue()` is the only way to build one, and
 * `writeFence.integration.test.ts` asserts uniqueness across transitions.
 */
export const LIFECYCLE_WRITE_FENCE_PREFIX = 'lifecycle:promote:'

/** A fresh, self-describing fence value for a lifecycle transition. Never a
 * constant: see {@link LIFECYCLE_WRITE_FENCE_PREFIX}. */
export function lifecycleWriteFenceValue(): string {
  return `${LIFECYCLE_WRITE_FENCE_PREFIX}${randomUUID()}`
}

/** Is this fence held by a lifecycle transition rather than by a projector? */
export function isLifecycleWriteFence(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(LIFECYCLE_WRITE_FENCE_PREFIX)
}

/** CAS, not an overwrite: the claim lands only if the fence still holds
 * `expectedPrevious` (the value the claiming cold build observed when it
 * began). Zero rows moved means another build claimed in between — throw, so
 * the caller's whole transaction rolls back.
 *
 * NOTE for any second writer: the `WHERE` lives in the `DO UPDATE` clause, so
 * on a MISSING row the INSERT fires unconditionally and `expectedPrevious` is
 * ignored. That is correct for a claiming projector (nothing to lose a race
 * to), and it is why a lifecycle writer must not express its takeover as a
 * plain `UPDATE … WHERE landscape_id/version_id`: on a workspace with no
 * `read_model_projection_state` row that is a silent no-op with no error, and a
 * gate that cannot fail is not a gate. `claimLifecycleWriteFence` upserts and
 * checks `rowCount`. */
export async function claimReadModelWriteFence(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  instanceId: string,
  expectedPrevious: string | null
): Promise<void> {
  const result = await db.query(
    `INSERT INTO read_model_projection_state (
       landscape_id, version_id, org_id, write_fence, updated_at
     ) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, read_model_projection_state.org_id),
       write_fence = EXCLUDED.write_fence,
       updated_at = now()
     WHERE read_model_projection_state.write_fence IS NOT DISTINCT FROM $5`,
    [key.landscapeId, key.versionId, orgId, instanceId, expectedPrevious]
  )
  if ((result.rowCount ?? 0) === 0) {
    // Read who actually holds it so the error names the winner, not the value
    // this loser expected. Same transaction; it is rolling back anyway.
    const holder = await readWriteFence(db, key).catch(() => null)
    throw new ReadModelWriteFenceError(key, instanceId, holder)
  }
}

/**
 * Take the write fence for a LIFECYCLE transition, and return the value taken.
 *
 * The one mechanism that stops an ordinary cold build already in flight from
 * committing over a plane it no longer owns. `assertReadModelPlane` cannot: it
 * runs at the START of the projection transaction, and the ordinary plane's
 * authority is the ABSENCE of a row, which is not lockable. So this carries the
 * ordinary direction alone, and it works because
 * `read_model_projection_state` has a row that EXISTS — that is the
 * load-bearing fact, not the fence's semantics.
 *
 * MUST run in the SAME transaction that publishes the static row. Split them
 * and the gap between the two commits is a resurrection window: a projector
 * attaching in it reads the sentinel as its `expectedPrevious` and its own CAS
 * then succeeds. `promoteSummaryWorkspace.integration.test.ts` asserts they
 * commit together.
 *
 * MUST run LAST in that transaction, after the document claims and the
 * allow-list. `read_model_projection_state` is the terminal lock for both
 * projectors too, so a resource that is always terminal cannot appear in a
 * cycle. Taken FIRST it closes one immediately: this transaction would hold the
 * state row and want `read_model_static_documents` while a static publish holds
 * `read_model_static_documents` and wants the state row — 40P01 on a single
 * workspace with no fan-out needed.
 *
 * An `UPDATE` with the `rowCount` CHECKED — deliberately not the upsert that
 * {@link claimReadModelWriteFence} uses; both obvious choices are wrong in
 * opposite directions.
 *
 * A plain unchecked `UPDATE` is a SILENT NO-OP on a workspace with no
 * `read_model_projection_state` row: the promotion would believe it had fenced
 * a projection it had not, which is a gate that cannot fail. An upsert avoids
 * that but INVENTS a row — with a null `org_id`, `projector_attached = false`
 * and `last_projected_at = NULL`, which the status ladder reads as
 * `uninitialized` and which then joins the fleet's status counts and the
 * divergence scheduler's work list — a manufactured health row with no
 * natural lift.
 *
 * The third option is the right one, because the row's existence is a
 * PRECONDITION here rather than an accident: the promotion refuses unless
 * `getWorkspaceProjectionFreshness` returns healthy, caught-up and
 * absence-provable, and that function reads this very row — a missing one is
 * already `unreadable` and already blocks. So zero rows means the row vanished
 * between the verdict and here, and refusing loudly is the only honest answer.
 */
export async function claimLifecycleWriteFence(
  tx: Queryable,
  key: WorkspaceKey,
): Promise<string> {
  const fence = lifecycleWriteFenceValue()
  const result = await tx.query(
    `UPDATE read_model_projection_state
        SET write_fence = $3, updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId, fence],
  )
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(
      `could not take the read-model write fence for ${key.landscapeId}/${key.versionId}: no `
      + 'read_model_projection_state row. The promotion refuses unless projection freshness is healthy, '
      + 'which reads that row — so it existed at the verdict and is gone now. An ordinary projection in '
      + 'flight would not be fenced out of the plane this transition is handing over.',
    )
  }
  return fence
}

/** Throws `ReadModelWriteFenceError` unless this instance holds the fence.
 * MUST be called inside the projection transaction, after the row writes and
 * before `completeReadModelProjection`. A missing row fails closed: it means
 * the workspace's state was wiped underneath this projector, and rows written
 * into that void would belong to nobody. */
export async function assertReadModelWriteFence(
  db: Queryable,
  key: WorkspaceKey,
  instanceId: string
): Promise<void> {
  const { rows } = await db.query<{ write_fence: string | null }>(
    `SELECT write_fence FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2
     FOR UPDATE`,
    [key.landscapeId, key.versionId]
  )
  const held = rows[0]?.write_fence
  if (rows.length === 0 || held !== instanceId) {
    throw new ReadModelWriteFenceError(key, instanceId, rows.length === 0 ? undefined : held)
  }
}

/** Compare-and-set detach: a late stop from an old projector cannot mark its
 * already-attached replacement idle. */
export async function markReadModelProjectorDetached(
  db: Queryable,
  key: WorkspaceKey,
  instanceId: string
): Promise<void> {
  await db.query(
    `UPDATE read_model_projection_state SET
       projector_attached = false,
       projector_instance_id = NULL,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2 AND projector_instance_id = $3`,
    [key.landscapeId, key.versionId, instanceId]
  )
}

/**
 * The single definition of a workspace's status. Expects `p` bound to
 * `read_model_projection_state` and `d` to a newest-durable-write row.
 *
 * Shared by the org view and the fleet-wide metrics rollup rather than written
 * twice: two copies of this ladder would drift, and the drift would be invisible
 * — both queries would keep returning plausible statuses, just different ones
 * for the same workspace. Same reason `unaccountedChangeListeners()` is shared
 * between the eviction census and the residency gauge.
 *
 * `graceParam` is the placeholder holding the stale grace in milliseconds ('$1',
 * '$2', …) — a literal written by the two call sites below, never anything that
 * reaches this from a request. The two queries number their parameters
 * differently and Postgres rejects a statement that binds one it never
 * mentions, so a fixed `$2` here cannot serve both.
 */
const projectionStatusSql = (graceParam: string): string => `CASE
           WHEN p.landscape_id IS NULL OR p.last_projected_at IS NULL THEN
             CASE WHEN p.last_error_generation > COALESCE(p.projected_generation, 0) THEN 'failed' ELSE 'uninitialized' END
           WHEN p.last_error_generation > p.projected_generation THEN 'failed'
           WHEN NOT p.projector_attached THEN 'idle'
           -- Ranked above catching_up: a partially-projected workspace serving
           -- its last coherent snapshot is actionable, a transient backlog is not.
           WHEN p.degraded_since IS NOT NULL THEN 'degraded'
           -- catching_up is checked FIRST on purpose. A workspace whose
           -- projector knows it is behind is not stale — the unobserved write is
           -- very likely the one it is projecting right now. Stale is
           -- specifically the case where the projector believes it is CAUGHT UP
           -- and durable storage disagrees, which is what an orphaned watcher
           -- looks like and what no generation counter can report.
           WHEN p.observed_generation > p.projected_generation THEN 'catching_up'
           WHEN d.newest_durable_write_at > p.last_projected_at
             AND d.newest_durable_write_at < now() - (${graceParam} || ' milliseconds')::interval THEN 'stale'
           ELSE 'healthy'
         END`

/**
 * Fleet-wide status counts, for `/metrics`. No tenant filter: an operator alerts
 * on "three workspaces are stale", not on whose they are, and scoping per org
 * would mean one scrape per org.
 */
export async function getFleetReadModelStatusCounts(db: Queryable): Promise<Record<ReadModelWorkspaceStatus, number>> {
  const counts = emptyCounts()
  const { rows } = await db.query<{ status: ReadModelWorkspaceStatus; total: string }>(
    `WITH durable_writes AS (
       SELECT dw.landscape_id, dw.version_id, max(newest.updated_at) AS newest_durable_write_at
       FROM automerge_document_workspace dw
       CROSS JOIN LATERAL (
         SELECT s.updated_at FROM automerge_storage s
         WHERE split_part(s.key, '/', 1) = dw.document_id
         ORDER BY s.updated_at DESC LIMIT 1
       ) newest
       GROUP BY dw.landscape_id, dw.version_id
     )
     SELECT ${projectionStatusSql('$1')} AS status, count(*)::text AS total
     FROM read_model_projection_state p
     LEFT JOIN durable_writes d
       ON d.landscape_id = p.landscape_id AND d.version_id = p.version_id
     GROUP BY 1`,
    [String(Math.round(staleGraceMs()))]
  )
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = Number(row.total)
  }
  return counts
}

function emptyCounts(): Record<ReadModelWorkspaceStatus, number> {
  return { healthy: 0, degraded: 0, stale: 0, catching_up: 0, failed: 0, idle: 0, uninitialized: 0 }
}

export interface WorkspaceProjectionFreshness {
  status: ReadModelWorkspaceStatus
  projectedGeneration: number
  /** Documents mapped to this workspace in `automerge_document_workspace`. */
  admittedDocuments: number
  /** True only when the status ladder lands on `healthy` AND at least one
   * document is admitted. The admission requirement exists because the `stale`
   * detector's out-of-band probe walks `automerge_document_workspace`: a
   * durable write to an UNADMITTED document is invisible to it, so a workspace
   * whose docs never got admitted (the sync-stall pathology) would read
   * `healthy` while arbitrarily behind. Zero admissions ⇒ never a proof of
   * absence. Display-grade signal;
   * the absence PROOF is `absenceProvable` below. */
  caughtUp: boolean
  /** The write-checkpoint rule, on a MINTED ORDER (see arrivalWatermark.ts):
   * `caughtUp` AND, per admitted document, its newest content-chunk
   * `arrival_seq` is covered by the watermark the last projection of THAT
   * document captured at sampling (EXACT branch); documents the clock does
   * not cover yet (legacy rows, docs never watermark-projected) fall back to
   * a timestamp clause — and the fallback can never override an exact
   * refusal. `absenceProvable ⊆ caughtUp` always.
   *
   * Exactness is scoped to the object/connection shard documents (where the
   * entities this witness proves live): they are stamped by the cold build
   * and re-stamped by every shard delta. Root, meta, registry shards,
   * monolith and DiagramDocs are deliberately NOT stamped — their handlers
   * record no watermark, so stamping them once would turn any later write
   * into a PERMANENT exact refusal; on the fallback they stay self-healing.
   * sync-state chunks are excluded from both clocks: protocol bookkeeping
   * that never moves heads would freeze the proof. Remaining residuals:
   * fallback-scope documents keep the timestamp clause's grace windows;
   * writes to UNADMITTED documents are outside
   * the clock (fsck `document-admitted` is that detector); a document whose
   * storage vanished entirely reads covered (fsck `document-present`'s
   * domain); the single-process heads argument is documented in
   * arrivalWatermark.ts. */
  absenceProvable: boolean
}

/**
 * The one-workspace freshness read behind the durability-witness endpoint.
 * Same status ladder as the org view and the fleet rollup (`projectionStatusSql`)
 * — a third private copy would drift invisibly. The grace-window residual the
 * ladder carries (a young unobserved write still reads `healthy`) is closed
 * FOR THE PROOF by `absenceProvable`'s arrival clause; `caughtUp` keeps the
 * ladder semantics and stays display-grade. The arrival clause's own inherited
 * windows are inventoried on the `absenceProvable` field above.
 */
export async function getWorkspaceProjectionFreshness(
  db: Queryable,
  key: { landscapeId: string; versionId: string },
): Promise<WorkspaceProjectionFreshness> {
  const { rows } = await db.query<{
    status: ReadModelWorkspaceStatus
    projected_generation: string
    admitted_count: string
    arrival_covered: boolean
  }>(
    `SELECT ${projectionStatusSql('$3')} AS status,
            COALESCE(p.projected_generation, 0)::text AS projected_generation,
            COALESCE(d.admitted_count, 0)::text AS admitted_count,
            COALESCE(d.arrival_covered, false) AS arrival_covered
     FROM (VALUES (1)) AS anchor(one)
     LEFT JOIN read_model_projection_state p
       ON p.landscape_id = $1 AND p.version_id = $2
     LEFT JOIN LATERAL (
       -- Per-DOCUMENT arrival coverage (plan §2quinquies), aggregated over the
       -- admitted set. EXACT when both sides of the ORDER exist: the newest
       -- minted arrival_seq vs the watermark the last projection of THIS
       -- document captured at sampling — a per-workspace value would let one
       -- kind's completion vouch for another's backlog (round-5 Y1). The
       -- wall-clock clause survives ONLY as the fallback for documents the
       -- clock does not cover yet (legacy rows, or arrivals to a document not
       -- yet watermark-projected since the deploy): exactness grows one
       -- projection at a time and the fallback can never override an exact
       -- refusal. Cost: two backwards index probes per admitted document
       -- (idx_automerge_storage_doc_updated / _doc_arrival) plus a PK join.
       SELECT count(dw.document_id) AS admitted_count,
              max(newest.newest_at) AS newest_durable_write_at,
              bool_and(
                CASE
                  -- Explicit refusal wins even for legacy/absent content whose
                  -- arrival sequence is NULL. A timestamp cannot certify it.
                  WHEN wm.projected_watermark = 0 THEN false
                  WHEN newest.max_seq IS NOT NULL AND wm.projected_watermark IS NOT NULL
                    THEN wm.projected_watermark >= newest.max_seq
                  ELSE COALESCE(newest.newest_at IS NULL OR newest.newest_at < p.last_projected_at, false)
                END
              ) AS arrival_covered
       FROM automerge_document_workspace dw
       LEFT JOIN LATERAL (
         -- sync-state chunks are protocol bookkeeping written on every peer
         -- round-trip WITHOUT the document changing: no change event, no
         -- projection, no covering watermark ever — counting them froze the
         -- proof permanently on healthy quiet workspaces (round-6 C1,
         -- measured live). Excluded on BOTH clocks; the mint side also stops
         -- stamping them, this filter additionally covers already-polluted
         -- legacy rows and any foreign writer.
         SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq
         FROM automerge_storage s
         WHERE split_part(s.key, '/', 1) = dw.document_id
           AND split_part(s.key, '/', 2) <> 'sync-state'
       ) newest ON true
       LEFT JOIN read_model_document_watermarks wm
         ON wm.landscape_id = dw.landscape_id
        AND wm.version_id = dw.version_id
        AND wm.document_id = dw.document_id
       WHERE dw.landscape_id = $1 AND dw.version_id = $2
     ) d ON true`,
    [key.landscapeId, key.versionId, String(Math.round(staleGraceMs()))],
  )
  const row = rows[0]
  const status = (row?.status ?? 'uninitialized') as ReadModelWorkspaceStatus
  const admittedDocuments = Number(row?.admitted_count ?? 0)
  const caughtUp = status === 'healthy' && admittedDocuments > 0
  return {
    status,
    projectedGeneration: Number(row?.projected_generation ?? 0),
    admittedDocuments,
    caughtUp,
    absenceProvable: caughtUp && row?.arrival_covered === true,
  }
}

/** Org-admin aggregate. Scope rows define the tenant boundary and ensure a
 * workspace that has never been projected is still visible as uninitialized. */
export async function getOrgReadModelHealth(db: Queryable, orgId: string): Promise<OrgReadModelHealth> {
  const generatedAt = new Date()
  try {
    // Counts stay in SQL and the detail payload is capped. An enterprise org
    // can own thousands of versions; the Operations dialog must never load one
    // JavaScript object per workspace simply to display five aggregate counts.
    const stateCte = `WITH scope_versions AS (
       SELECT DISTINCT ON (s.landscape_id, s.version_id)
         s.landscape_id,
         COALESCE(l.name, s.landscape_id) AS landscape_name,
         s.version_id,
         COALESCE(v.label, s.version_id) AS version_name,
         s.created_at
       FROM scopes s
       LEFT JOIN landscapes l ON l.id = s.landscape_id
       LEFT JOIN versions v ON v.landscape_id = s.landscape_id AND v.id = s.version_id
       WHERE s.org_id = $1 AND s.kind = 'version' AND s.deleted_at IS NULL
       ORDER BY s.landscape_id, s.version_id, s.created_at DESC
     ), durable_writes AS (
       -- Out-of-band freshness: the newest durable chunk write per workspace,
       -- read from storage rather than from the projector's own counters.
       --
       -- LATERAL rather than a GROUP BY over automerge_storage: with
       -- idx_automerge_storage_doc_updated — (split_part(key,'/',1), updated_at)
       -- — each document costs one backwards index probe that stops at the first
       -- row, so this is proportional to the org's DOCUMENT count and never
       -- scans the chunk table. A grouped scan of every chunk would be the
       -- obvious way to write this and would not survive an enterprise storage
       -- table.
       SELECT dw.landscape_id, dw.version_id, max(newest.updated_at) AS newest_durable_write_at
       FROM automerge_document_workspace dw
       -- Cost bound, not a filter on the answer: the states CTE below LEFT JOINs
       -- this by workspace, so rows belonging to another org would be discarded
       -- anyway. Without it every call probes every document in the INSTALLATION
       -- to compute rows nobody reads. Removing it therefore changes no test and
       -- makes this query scale with the fleet rather than with the tenant — said
       -- here because a reviewer looking only at results will conclude it is
       -- redundant, and a mutation test agrees with them.
       JOIN scope_versions sv
         ON sv.landscape_id = dw.landscape_id AND sv.version_id = dw.version_id
       CROSS JOIN LATERAL (
         SELECT s.updated_at
         FROM automerge_storage s
         WHERE split_part(s.key, '/', 1) = dw.document_id
         ORDER BY s.updated_at DESC
         LIMIT 1
       ) newest
       GROUP BY dw.landscape_id, dw.version_id
     ), states AS (
       SELECT
         sv.landscape_id,
         sv.landscape_name,
         sv.version_id,
         sv.version_name,
         (p.landscape_id IS NOT NULL) AS has_state,
         d.newest_durable_write_at,
         p.observed_generation,
         p.projected_generation,
         p.source_changed_at,
         p.last_projected_at,
         p.last_duration_ms,
         p.last_error_at,
         p.last_error_generation,
         p.last_error_code,
         p.projector_attached,
         p.degraded_since,
         p.degraded_kind,
         p.degraded_error_code,
         ${projectionStatusSql('$2')} AS status,
         GREATEST(0, COALESCE(p.observed_generation, 0) - COALESCE(p.projected_generation, 0)) AS pending_generations,
         CASE WHEN COALESCE(p.observed_generation, 0) > COALESCE(p.projected_generation, 0)
           THEN GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - p.source_changed_at)) * 1000))::bigint
           ELSE 0::bigint
         END AS lag_ms
       FROM scope_versions sv
       LEFT JOIN read_model_projection_state p
         ON p.landscape_id = sv.landscape_id AND p.version_id = sv.version_id
       LEFT JOIN durable_writes d
         ON d.landscape_id = sv.landscape_id AND d.version_id = sv.version_id
     )`
    const graceMs = String(Math.round(staleGraceMs()))
    const { rows: aggregateRows } = await db.query<{
      healthy: string
      catching_up: string
      failed: string
      idle: string
      uninitialized: string
      degraded: string
      stale: string
      total: string
      worst_lag_ms: string
    }>(
      `${stateCte}
       SELECT
         count(*) FILTER (WHERE status = 'healthy')::text AS healthy,
         count(*) FILTER (WHERE status = 'degraded')::text AS degraded,
         count(*) FILTER (WHERE status = 'stale')::text AS stale,
         count(*) FILTER (WHERE status = 'catching_up')::text AS catching_up,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'idle')::text AS idle,
         count(*) FILTER (WHERE status = 'uninitialized')::text AS uninitialized,
         count(*)::text AS total,
         COALESCE(max(lag_ms), 0)::text AS worst_lag_ms
       FROM states`,
      [orgId, graceMs]
    )
    const { rows } = await db.query<ProjectionRow & { status: ReadModelWorkspaceStatus; pending_generations: string; lag_ms: string }>(
      `${stateCte}
       SELECT * FROM states
       WHERE status <> 'healthy'
       ORDER BY
         CASE status
           WHEN 'failed' THEN 0 WHEN 'degraded' THEN 1 WHEN 'stale' THEN 2
           WHEN 'catching_up' THEN 3 WHEN 'idle' THEN 4 ELSE 5
         END,
         lag_ms DESC,
         landscape_name,
         version_name
       LIMIT 50`,
      [orgId, graceMs]
    )

    const nowMs = generatedAt.getTime()
    const aggregate = aggregateRows[0] ?? {
      healthy: '0', degraded: '0', stale: '0', catching_up: '0', failed: '0',
      idle: '0', uninitialized: '0', total: '0', worst_lag_ms: '0',
    }
    const counts = {
      healthy: Number(aggregate.healthy),
      degraded: Number(aggregate.degraded),
      stale: Number(aggregate.stale),
      catching_up: Number(aggregate.catching_up),
      failed: Number(aggregate.failed),
      idle: Number(aggregate.idle),
      uninitialized: Number(aggregate.uninitialized),
    }
    const workspaces = rows.map((row): ReadModelWorkspaceHealth => {
      const observed = Number(row.observed_generation ?? 0)
      const projected = Number(row.projected_generation ?? 0)
      const pending = Number(row.pending_generations)
      const unresolvedFailure = row.last_error_generation !== null && Number(row.last_error_generation) > projected
      const attached = row.projector_attached === true
      return {
        landscapeId: row.landscape_id,
        landscapeName: row.landscape_name ?? row.landscape_id,
        versionId: row.version_id,
        versionName: row.version_name ?? row.version_id,
        status: row.status,
        projectorAttached: attached,
        observedGeneration: observed,
        projectedGeneration: projected,
        pendingGenerations: pending,
        lagMs: Number(row.lag_ms),
        stalenessMs: msSince(row.last_projected_at, nowMs),
        lastProjectedAt: iso(row.last_projected_at),
        lastDurationMs: row.last_duration_ms,
        lastErrorAt: unresolvedFailure ? iso(row.last_error_at) : null,
        lastErrorCode: unresolvedFailure ? row.last_error_code : null,
        degradedSince: iso(row.degraded_since),
        degradedKind: row.degraded_kind,
        degradedErrorCode: row.degraded_error_code,
        newestDurableWriteAt: iso(row.newest_durable_write_at),
      }
    })
    return {
      enabled: true,
      generatedAt: generatedAt.toISOString(),
      counts,
      worstLagMs: Number(aggregate.worst_lag_ms),
      totalWorkspaceCount: Number(aggregate.total),
      listedWorkspaceCount: workspaces.length,
      workspaces,
    }
  } catch (error) {
    // READ_MODEL may be disabled, in which case its derived schema is absent.
    // Treat that as an explicit disabled state; every other SQL failure must be
    // surfaced so operators do not get a falsely reassuring empty dashboard.
    if ((error as { code?: unknown })?.code === '42P01') {
      return {
        enabled: false,
        generatedAt: generatedAt.toISOString(),
        counts: emptyCounts(),
        worstLagMs: 0,
        totalWorkspaceCount: 0,
        listedWorkspaceCount: 0,
        workspaces: [],
      }
    }
    throw error
  }
}
