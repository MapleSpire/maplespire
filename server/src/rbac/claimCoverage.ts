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

import type { Queryable } from '../readModel/types.js'
import type { WorkspaceKey } from './docScope.js'
import { CLAIM_PROTOCOL_VERSION } from './documentClaims.js'

/**
 * The per-workspace claim-coverage marker (`workspace_claim_coverage`,
 * DDL in syncCells/ownership.ts beside the claims table it certifies).
 *
 * `covered(W)` means BOTH: (a) at `covered_at`, every document reachable from
 * W's root had its `automerge_document_workspace` row — proved by construction
 * (bootstrap: the claimed set IS the created set) or by ONE complete walk
 * (`controlDocsComplete`); and (b) every creator of W's documents since then
 * claims at write — a property of the CODE, versioned by `protocol`. A missing
 * row, `covered=false`, or a stored protocol below {@link
 * CLAIM_PROTOCOL_VERSION} all read as UNCOVERED: bumping the constant
 * invalidates every marker platform-wide if a creator site is found that does
 * not claim at write.
 *
 * Terminology: a "constat" is the route gate observing a document that should
 * have been claimed but was not — evidence the coverage is broken.
 *
 * SQL, never an Automerge document, deliberately: the marker gates admission
 * pre-warm decisions, and "no authorization decision on the inbound sync path
 * may await the resolution of an Automerge document" — a marker
 * living in a document would be that circularity by construction.
 *
 * The lifecycle is the F1/Spanner online-schema-change shape: claim-at-write
 * is *write-only*, the walk is the *backfill*, the marker is the promotion to
 * *public*, and the route-gate constat is the demotion. Three writers only:
 *
 *  - the BOOTSTRAP PUBLISHER covers, as its LAST write, after a claim batch
 *    with no foreign losers — the marker is the commit record, so a crash at
 *    any earlier point degrades to "uncovered", i.e. the lazy-walk fallback;
 *  - the CALLER of a complete repair walk re-covers, by CAS on
 *    `invalidations` observed BEFORE the walk began — never from inside a
 *    pass (a pass reporting from inside itself reports only how far it got),
 *    and an invalidation racing the walk wins;
 *  - the CONSTAT (route-gate miss) and the projector's folded claim failure
 *    de-cover, bumping `invalidations` so any in-flight re-cover loses.
 *
 * Reads go through a per-process TTL cache with single-flight: an attach storm
 * costs one SELECT, a read FAILURE is reported (never cached) and every caller
 * treats it as uncovered — the fallback is the walk, never a silent skip.
 */

export const CLAIM_COVERAGE_TTL_MS = 30_000
/** Bound on retained workspaces — fleet-sized, not attacker-sized (the keys
 * are server-assigned routes), same reasoning as the version-list cache. */
const CLAIM_COVERAGE_CACHE_MAX_ENTRIES = 5_000

interface LocalCoverage {
  covered: boolean
  expiresAt: number
  /** True when this entry was written by a local CONSTAT rather than a read —
   * `noteCoverageGapLocally` uses it to fire the durable invalidation once
   * per gap, not once per denied message. */
  gapMarked: boolean
}

const localCoverage = new Map<string, LocalCoverage>()
const coverageInFlight = new Map<string, Promise<boolean>>()
/** Bumped by every cross-process drop AND by every LOCAL constat writer, so a
 * read IN FLIGHT across either may not retain its (possibly pre-change) answer.
 * Same guard as docScope's version-list epoch, one module over; global for
 * the same reason (coverage changes are rare, a per-key map would be one more
 * unbounded structure, and the cost of coarseness is one extra SELECT). */
let coverageReadEpoch = 0

const keyOf = (key: WorkspaceKey): string => `${key.landscapeId}/${key.versionId}`

function remember(k: string, entry: LocalCoverage): void {
  while (localCoverage.size >= CLAIM_COVERAGE_CACHE_MAX_ENTRIES && !localCoverage.has(k)) {
    const oldest = localCoverage.keys().next().value as string | undefined
    if (oldest === undefined) break
    localCoverage.delete(oldest)
  }
  localCoverage.set(k, entry)
}

export interface WorkspaceCoverageRow {
  covered: boolean
  protocol: number
  /** BIGINT — kept as text end to end; it is only ever compared, never summed. */
  invalidations: string
}

export async function readWorkspaceCoverage(db: Queryable, key: WorkspaceKey): Promise<WorkspaceCoverageRow | null> {
  const { rows } = await db.query<{ covered: boolean; protocol: number; invalidations: string }>(
    `SELECT covered, protocol, invalidations::text AS invalidations
       FROM workspace_claim_coverage
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  return row ? { covered: row.covered === true, protocol: Number(row.protocol), invalidations: row.invalidations } : null
}

/** The CAS witness value to observe BEFORE a walk: the row's invalidation
 * counter, '0' when no row exists yet (the first cover's INSERT branch). */
export async function readWorkspaceCoverageInvalidations(db: Queryable, key: WorkspaceKey): Promise<string> {
  return (await readWorkspaceCoverage(db, key))?.invalidations ?? '0'
}

function rowReadsCovered(row: WorkspaceCoverageRow | null): boolean {
  // `>=`, not `===`, deliberately: after a deployment ROLLBACK the older build
  // reads a newer-protocol marker as still covered — assumed, because a strict
  // equality would mass-invalidate the fleet on BOTH sides of every deploy
  // boundary and pay a walk storm for a contract that only strengthens.
  return row !== null && row.covered && row.protocol >= CLAIM_PROTOCOL_VERSION
}

export interface CoverWorkspaceOptions {
  /** For TRANSACTIONAL callers: skip the local cover write-through so the
   * caller replays it (`noteCoveredLocally`) AFTER its COMMIT. Inside the
   * transaction the marker is not durable yet — a rollback would otherwise
   * leave this process serving "covered" from cache for up to the TTL while
   * the durable truth is that no marker ever existed. */
  deferLocalWriteThrough?: boolean
}

/**
 * Pose (or re-pose) the marker — CAS on the invalidation counter observed
 * before whatever proved the coverage. A constat that landed in between bumped
 * the counter, so this refuses rather than certify a coverage the gate just
 * disproved; the loser's walk is already scheduled and its caller will CAS
 * again with the fresh counter. Returns whether the marker was posed.
 *
 * Only a `'0'` witness may INSERT, and the INSERT stores `invalidations = 0`:
 * a non-zero witness on a missing row means the row was deleted under our feet
 * — we do not fabricate one carrying a counter nothing observed; that CAS is
 * simply lost, like any other.
 */
export async function coverWorkspace(
  db: Queryable,
  key: WorkspaceKey,
  expectedInvalidations: string,
  options: CoverWorkspaceOptions = {},
): Promise<boolean> {
  const { rows } = expectedInvalidations === '0'
    ? await db.query<{ covered: boolean }>(
        `INSERT INTO workspace_claim_coverage (
           landscape_id, version_id, covered, protocol, invalidations, covered_at
         ) VALUES ($1, $2, true, $3, 0, now())
         ON CONFLICT (landscape_id, version_id) DO UPDATE SET
           covered = true,
           protocol = EXCLUDED.protocol,
           covered_at = now()
         WHERE workspace_claim_coverage.invalidations = 0
         RETURNING covered`,
        [key.landscapeId, key.versionId, CLAIM_PROTOCOL_VERSION],
      )
    : await db.query<{ covered: boolean }>(
        `UPDATE workspace_claim_coverage SET
           covered = true,
           protocol = $3,
           covered_at = now()
         WHERE landscape_id = $1 AND version_id = $2
           AND invalidations = $4::bigint
         RETURNING covered`,
        [key.landscapeId, key.versionId, CLAIM_PROTOCOL_VERSION, expectedInvalidations],
      )
  const won = rows.length > 0
  if (won && !options.deferLocalWriteThrough) noteCoveredLocally(key)
  return won
}

/**
 * Durably de-cover — the constat, and the projector's folded claim failure.
 * An UPSERT, not an UPDATE: with no row yet, a bare UPDATE would touch nothing
 * and an in-flight first cover (CAS expecting '0') would then win AFTER the
 * gate disproved it. Inserting `invalidations = 1` makes that CAS lose.
 */
export async function invalidateWorkspaceCoverage(db: Queryable, key: WorkspaceKey, reason: string): Promise<void> {
  // Local write-through FIRST: even if the durable write fails, this process
  // stops trusting the marker for the retention window (conservative — the
  // walk is the fallback), and a re-fired constat retries the durable write
  // once the window lapses.
  // The LOCAL constat bumps the read epoch too. A read already in flight when
  // this lands would otherwise `remember` its pre-constat "covered" answer OVER
  // the gap-marked entry — re-arming the constat licence and serving "covered"
  // for up to the TTL. The NOTIFY echo cannot be the guard
  // here: it needs a live LISTEN client (comfort, never a dependency) and it
  // arrives only after the durable round trip, a window the in-flight read
  // fits inside.
  coverageReadEpoch += 1
  remember(keyOf(key), { covered: false, expiresAt: Date.now() + CLAIM_COVERAGE_TTL_MS, gapMarked: true })
  await db.query(
    `INSERT INTO workspace_claim_coverage (
       landscape_id, version_id, covered, protocol, invalidations, invalidated_at, invalidated_reason
     ) VALUES ($1, $2, false, $3, 1, now(), $4)
     ON CONFLICT (landscape_id, version_id) DO UPDATE SET
       covered = false,
       invalidations = workspace_claim_coverage.invalidations + 1,
       invalidated_at = now(),
       invalidated_reason = EXCLUDED.invalidated_reason`,
    [key.landscapeId, key.versionId, CLAIM_PROTOCOL_VERSION, reason.slice(0, 500)],
  )
}

/**
 * Cached read for the attach path. Single-flight per workspace; a fulfilled
 * read is retained for {@link CLAIM_COVERAGE_TTL_MS}; a FAILED read rejects to
 * the caller and is never cached — the caller's catch schedules the walk, so
 * a database blip degrades to the walk, never to a silent skip.
 */
export function isWorkspaceCoveredCached(db: Queryable, key: WorkspaceKey, clock: () => number = Date.now): Promise<boolean> {
  const k = keyOf(key)
  const cached = localCoverage.get(k)
  if (cached && cached.expiresAt > clock()) return Promise.resolve(cached.covered)
  const joined = coverageInFlight.get(k)
  if (joined) return joined
  // Epoch observed BEFORE the SELECT: a cross-process drop landing while this
  // read is in flight bumps past it, so the answer is served to THIS read's
  // callers but never retained — the cache must not outlive a known change.
  const epochAtRead = coverageReadEpoch
  const pending = readWorkspaceCoverage(db, key).then((row) => {
    const covered = rowReadsCovered(row)
    if (epochAtRead === coverageReadEpoch) {
      remember(k, { covered, expiresAt: clock() + CLAIM_COVERAGE_TTL_MS, gapMarked: false })
    }
    return covered
  })
  coverageInFlight.set(k, pending)
  const clear = () => {
    if (coverageInFlight.get(k) === pending) coverageInFlight.delete(k)
  }
  pending.then(clear, clear)
  return pending
}

/**
 * Cache-only, synchronous. True only for a FRESH locally-known cover — the
 * shape `notifyWorkspaceCreated`'s registration needs: the marker it may skip
 * the priming walk for is the one the bootstrap publisher just wrote in this
 * very process (cover write-through). Anything else — absent, stale, gapped —
 * reads false and the registration runs the priming walk.
 */
export function isWorkspaceCoveredLocally(key: WorkspaceKey, clock: () => number = Date.now): boolean {
  const cached = localCoverage.get(keyOf(key))
  return cached !== undefined && cached.covered && cached.expiresAt > clock()
}

/** Local cover write-through (also called by `coverWorkspace` on a won CAS). */
export function noteCoveredLocally(key: WorkspaceKey, clock: () => number = Date.now): void {
  remember(keyOf(key), { covered: true, expiresAt: clock() + CLAIM_COVERAGE_TTL_MS, gapMarked: false })
}

/**
 * The cross-process invalidation handler, wired by automergeServer to the `workspace_coverage_changed` NOTIFY channel
 * (trigger in syncCells/ownership.ts: ANY committed write to the durable
 * marker, by any process). An optimisation, not a dependency: a process with no LISTEN client stays correct, merely
 * TTL-bounded — the route-gate constat and the denyLedger remain the net.
 *
 * DROPS the entry rather than writing a value: the payload carries only the
 * workspace key, and the next read consults the durable row (re-read, never
 * trust the out-of-band value). Two deliberate
 * exceptions:
 *
 *  - a `gapMarked` entry is KEPT. It is this process's own constat record —
 *    and NOTIFY echoes back to its emitter, so dropping it would let our own
 *    invalidation's echo re-arm the once-per-TTL workspace ceiling that
 *    `noteCoverageGapLocally` enforces. Keeping it is conservative
 *    either way: it reads "uncovered", whose worst case is a walk.
 *  - the epoch bumps even when nothing is cached, so a read IN FLIGHT across
 *    the change cannot retain its answer (see `isWorkspaceCoveredCached`).
 */
export function dropWorkspaceCoverageLocally(key: WorkspaceKey): void {
  coverageReadEpoch += 1
  const k = keyOf(key)
  const cached = localCoverage.get(k)
  if (!cached || cached.gapMarked) return
  localCoverage.delete(k)
}

/** The per-(workspace, document) half of the constat licence. A stuck client
 * re-presents the SAME unminted document on every denyLedger reconcile
 * (~30 s) — which is exactly the workspace gap TTL — so a workspace-level
 * licence alone would re-buy an invalidation + memo purge + FULL repair walk
 * (~33 s for a 10k-document workspace) on every pass, forever. A document that
 * already fired a constat can prove nothing new; only a NEW document can.
 * Bounded LRU, and the bound is MANDATORY: the keys carry peer-supplied
 * document ids, so an unbounded set is attacker-growable memory — same
 * reasoning as WALK_SAMPLE_CAPACITY (docScope.ts). Eviction merely re-arms an
 * old document's licence, costing at worst one extra walk. */
const CONSTATED_DOCUMENTS_CAPACITY = 512
const constatedDocuments = new Map<string, true>()

function rememberConstatedDocument(docKey: string): void {
  constatedDocuments.delete(docKey)
  constatedDocuments.set(docKey, true)
  while (constatedDocuments.size > CONSTATED_DOCUMENTS_CAPACITY) {
    const oldest = constatedDocuments.keys().next().value as string | undefined
    if (oldest === undefined) break
    constatedDocuments.delete(oldest)
  }
}

/**
 * Mark a local coverage gap; returns true when the caller holds the licence to
 * fire the durable invalidation and purge the repair memo. The licence is per
 * (workspace, DOCUMENT), with the per-workspace gap TTL as the global ceiling:
 *
 *  - a document that already fired a constat in this process NEVER re-fires —
 *    re-presenting it proves nothing the first constat did not (the
 *    stuck-client loop, see `constatedDocuments`);
 *  - a NEW document is a new hole and must still fire — but at most once per
 *    workspace per TTL window (the ceiling). A new document denied by the
 *    ceiling is deliberately NOT recorded: the in-flight repair usually claims
 *    it, and if not, its licence is intact once the window lapses.
 *
 * Denied callers only re-schedule (memo/cooldown dedupe), so a peer spamming
 * unknown ids can drive neither an UPDATE per message nor a walk per message.
 */
export function noteCoverageGapLocally(key: WorkspaceKey, documentId: string, clock: () => number = Date.now): boolean {
  const k = keyOf(key)
  const prior = localCoverage.get(k)
  const alreadyGapped = prior !== undefined && prior.gapMarked && !prior.covered && prior.expiresAt > clock()
  // Same epoch bump as invalidateWorkspaceCoverage — and MORE necessary
  // here: a denied licence writes no durable row at all, so no NOTIFY echo
  // ever exists to fence the in-flight read that would overwrite this entry.
  coverageReadEpoch += 1
  remember(k, { covered: false, expiresAt: clock() + CLAIM_COVERAGE_TTL_MS, gapMarked: true })
  const docKey = `${k}\u0000${documentId}`
  if (constatedDocuments.has(docKey)) return false
  if (alreadyGapped) return false
  rememberConstatedDocument(docKey)
  return true
}

/** Tests only — the cache is module-level (one doc index per process). */
export function _resetWorkspaceClaimCoverageForTests(): void {
  localCoverage.clear()
  coverageInFlight.clear()
  constatedDocuments.clear()
}
