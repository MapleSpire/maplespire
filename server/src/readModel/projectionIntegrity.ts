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

// Persist what one projection KNEW about itself, in the
// transaction that published it.
//
// Two facts are written here, and they answer different questions:
//
//   `defect_*`      — how many documents this extraction could not read.
//                     Answers "is the read model COMPLETE with respect to the
//                     model?", which no comparison can answer, because a
//                     document that failed to load is absent from both sides.
//
//   `content_digest` — the (count, XOR) of the id set the projector just wrote,
//                     per kind, stamped with the generation it was computed at.
//                     Answers "did the rows that were written SURVIVE?", which
//                     needs no Automerge access at all to check.
//
// Both go in the projection's own transaction, so neither can disagree with the
// rows it describes — unlike comparing two views captured at different times,
// which cannot distinguish lag from divergence.
//
// GENERATION SCOPE (a digest must never silently go stale): a digest is only
// comparable while `g` still equals `projected_generation`. Full projections
// (`cold_build`, `monolith`) know every id and stamp all four kinds; `registry`
// knows every diagram and `metadata` knows every group, so those stamp one kind
// each. The per-shard delta paths know only their own shard, so they stamp
// NOTHING, and the object/connection digests go un-comparable on the first edit
// after a cold build. `verifyDigest` reports that as `not-verifiable` with the
// two generations in the reason — never as a match.
//
// XOR was chosen so that this window can be widened later without changing the
// stored shape: a delta path that knows the ids it added and removed can XOR
// them in and out of the stored digest. That is not done here — the client's
// "edits" overlay shard holds copies of objects that also live in their original
// shard, so a naive per-shard XOR would double-count every edited id, and
// getting that wrong corrupts the digest silently. (The sound formulation is not per-shard at all: `upsertObjects` can return the
// ids that actually ENTERED the table via `RETURNING id, (xmax = 0)`, and
// `deleteObjects` the ones that left, which is exact regardless of overlays.)
//
// SCOPE LIMIT: `staticDeltaProjector.ts` is the OTHER
// production caller of `beginReadModelProjection` / `completeReadModelProjection`
// and passes no integrity at all. Every projection it makes therefore advances
// the generation past whatever was sealed, so a static-baseline workspace reads
// `not-verifiable` from its first delta onward — and since that projector has its
// own extractor and never calls `extractModelEntities`, its `defect_count` stays
// NULL and it is counted in `maplespire_read_model_workspaces_never_examined`
// forever.

import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { summarizeModelDefects, type ModelDefect } from './modelDefects.js'
import {
  DIGEST_KINDS,
  digestSql,
  parseDigestRow,
  summarizeDigestVerdicts,
  verifyDigest,
  type ContentDigest,
  type DigestKind,
  type DigestVerdict,
  type StampedDigest,
} from './contentDigest.js'

export interface ProjectionIntegrity {
  /** Present only when this projection performed a FULL extraction and therefore
   * saw every document. A per-shard delta must leave this undefined rather than
   * report its own narrow view as the workspace's. */
  defects?: readonly ModelDefect[]
  /** The kinds whose complete id set this projection knew and re-sealed. */
  digests?: Partial<Record<DigestKind, ContentDigest>>
  /**
   * Kinds this projection provably did NOT touch, whose existing seal therefore
   * still describes the rows and only needs its generation carried forward.
   *
   * Without this the feature would be useless: EVERY projection of ANY kind
   * bumps `projected_generation` (`beginReadModelProjection` /
   * `completeReadModelProjection`), so any projection that neither re-seals nor
   * carries a kind forward leaves it dated to a generation the read model has
   * already left. `reconcileDiagramDocs` runs at the end of every boot and
   * projects one `registry` generation per resolvable diagram document, so
   * every seal would go stale before `startReadModelProjector` returned.
   *
   * A kind in NEITHER list is deliberately invalidated: the projection changed
   * rows whose full id set it does not know.
   */
  unchanged?: readonly DigestKind[]
}

export function hasIntegrityToStamp(integrity: ProjectionIntegrity | undefined): boolean {
  if (!integrity) return false
  return integrity.defects !== undefined
    || Object.keys(integrity.digests ?? {}).length > 0
    || (integrity.unchanged?.length ?? 0) > 0
}

/**
 * Write the integrity facts for `generation`.
 *
 * Digests MERGE per kind (`||` on jsonb) so a `registry` projection updates the
 * diagram digest and leaves the object digest — and its older generation —
 * exactly as it was. Overwriting the whole column would silently destroy the
 * evidence of when the other kinds were last known good.
 *
 * Defect columns are only touched when `defects` is supplied, so a projection
 * that did not look cannot clear a count that a projection which did look
 * recorded.
 *
 * The `projected_generation < $6` predicate is not belt-and-braces. Its sibling
 * `completeReadModelProjection` advances with `GREATEST(projected_generation, …)`
 * precisely because a NEWER generation may already have committed — two
 * projectors can serve one workspace across a handover. On that path this
 * projection's rows have already been replaced, so stamping its digest would
 * date somebody else's rows with our id set and produce a mismatch that looks
 * like corruption. Writing nothing is correct: the newer projection stamps its
 * own, and until it does the kind reads `not-verifiable`.
 *
 * MUST be called INSIDE the projection transaction and BEFORE
 * `completeReadModelProjection`, so the row still carries the generation this
 * projection is superseding. Both predicates depend on that ordering.
 *
 * Returns whether a row was actually stamped, so a caller can tell a skip apart
 * from a write instead of leaving them indistinguishable.
 */
export async function stampProjectionIntegrity(
  tx: Queryable,
  key: WorkspaceKey,
  generation: number,
  integrity: ProjectionIntegrity,
): Promise<boolean> {
  const stamped: Record<string, StampedDigest> = {}
  for (const [kind, digest] of Object.entries(integrity.digests ?? {})) {
    if (digest) stamped[kind] = { ...digest, g: generation }
  }
  const defects = integrity.defects
  // Carry the untouched kinds' generation forward, THEN merge the freshly sealed
  // ones on top so a kind named in both lists resolves to the fresh seal.
  // `jsonb_object_agg` over an empty object yields NULL, hence the COALESCE; the
  // `jsonb_typeof` guard keeps a malformed stored entry from being concatenated
  // into something new rather than left for `parseStamped` to reject.
  //
  // `value->>'g' = projected_generation::text` IS THE WHOLE CORRECTNESS OF THE
  // CARRY-FORWARD; without it this produces a false `mismatch`:
  //
  //   g=2 cold build seals object {n:2}
  //   g=3 object-shard delta adds an id, correctly declines to re-seal  -> stale
  //   g=4 an unrelated GROUP edit truthfully says it did not touch objects
  //
  // Carrying forward at g=4 re-dates the g=2 digest onto rows that have since
  // gained an id, and a healthy read model reports corruption. `unchanged` means
  // "I changed nothing SINCE THE LAST GENERATION"; only a seal that was still
  // current one generation ago may inherit that. A seal that had already gone
  // stale must stay stale.
  //
  // This runs BEFORE `completeReadModelProjection` for exactly that reason: the
  // row still holds the PREVIOUS generation, which is the value the comparison
  // needs. Hence also `projected_generation < $6` below rather than `= $6` —
  // same intent as the sibling's `GREATEST`, expressed against the pre-state.
  const result = await tx.query(
    `UPDATE read_model_projection_state SET
       content_digest = COALESCE((
         SELECT jsonb_object_agg(key, CASE
           WHEN key = ANY($7::text[])
            AND jsonb_typeof(value) = 'object'
            AND value->>'g' = projected_generation::text
             THEN value || jsonb_build_object('g', $6::bigint)
           ELSE value END)
         FROM jsonb_each(COALESCE(content_digest, '{}'::jsonb))
       ), '{}'::jsonb) || $3::jsonb,
       defect_count = CASE WHEN $4::integer IS NULL THEN defect_count ELSE $4::integer END,
       defect_summary = CASE WHEN $4::integer IS NULL THEN defect_summary ELSE $5 END,
       defects_observed_at = CASE WHEN $4::integer IS NULL THEN defects_observed_at ELSE now() END,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2 AND projected_generation < $6`,
    [
      key.landscapeId,
      key.versionId,
      JSON.stringify(stamped),
      defects === undefined ? null : defects.length,
      defects === undefined ? null : summarizeModelDefects(defects),
      generation,
      [...(integrity.unchanged ?? [])],
    ],
  )
  // `rowCount` is null on some drivers/fakes; treat unknown as "wrote something"
  // so a test double does not manufacture a warning.
  return result.rowCount === null || result.rowCount > 0
}

export interface WorkspaceIntegrity {
  workspace: WorkspaceKey
  checkedAt: string
  projectedGeneration: number | null
  /** From the last FULL extraction, not from the last projection. */
  defectCount: number | null
  defectSummary: string | null
  defectsObservedAt: string | null
  verdicts: DigestVerdict[]
  /** `mismatch` if any kind mismatched; otherwise `verified` if at least one kind
   * was comparable; otherwise `not-verifiable`. Deliberately NOT "clean": a run
   * that compared nothing must not share a word with a run that compared
   * everything and found it correct. */
  outcome: 'verified' | 'mismatch' | 'not-verifiable'
  summary: string
}

interface IntegrityRow extends Record<string, unknown> {
  projected_generation: string | number | null
  content_digest: unknown
  defect_count: number | null
  defect_summary: string | null
  defects_observed_at: Date | string | null
}

function parseStamped(value: unknown): StampedDigest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const n = Number(record.n)
  const g = Number(record.g)
  if (!Number.isFinite(n) || !Number.isFinite(g)) return null
  if (typeof record.x !== 'string' || !/^[0-9a-f]{16}$/.test(record.x)) return null
  return { n, x: record.x, g }
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * Compare every sealed digest against the rows that are there now.
 *
 * One aggregate per kind, each an indexed scan of that workspace's rows — no
 * Automerge repo, no document resolution, nothing that could rehydrate a
 * document the residency evictor just released. That is what makes this safe to
 * run on demand against any workspace, resident or not.
 */
export async function verifyWorkspaceIntegrity(
  db: Queryable,
  workspace: WorkspaceKey,
): Promise<WorkspaceIntegrity> {
  const params = [workspace.landscapeId, workspace.versionId]
  const { rows } = await db.query<IntegrityRow>(
    `SELECT projected_generation, content_digest, defect_count, defect_summary, defects_observed_at
       FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    params,
  )
  const row = rows[0]
  const projectedGeneration = row?.projected_generation === undefined || row?.projected_generation === null
    ? null
    : Number(row.projected_generation)
  const sealed = (typeof row?.content_digest === 'object' && row.content_digest !== null)
    ? row.content_digest as Record<string, unknown>
    : {}

  const verdicts: DigestVerdict[] = []
  for (const kind of DIGEST_KINDS) {
    const expected = parseStamped(sealed[kind])
    // Skipped when nothing was ever sealed for this kind: running four table
    // aggregates to compare against nothing is pure cost, and `verifyDigest`
    // reaches the same verdict from `expected === null`.
    const actual = expected === null
      ? null
      : parseDigestRow((await db.query<{ n: string; x: string }>(digestSql(kind), params)).rows[0])
    verdicts.push(verifyDigest(kind, expected, actual, projectedGeneration))
  }

  const outcome: WorkspaceIntegrity['outcome'] = verdicts.some((v) => v.outcome === 'mismatch')
    ? 'mismatch'
    : verdicts.some((v) => v.outcome === 'match') ? 'verified' : 'not-verifiable'

  return {
    workspace,
    checkedAt: new Date().toISOString(),
    projectedGeneration,
    defectCount: row?.defect_count ?? null,
    defectSummary: row?.defect_summary ?? null,
    defectsObservedAt: isoOrNull(row?.defects_observed_at ?? null),
    verdicts,
    outcome,
    summary: summarizeDigestVerdicts(verdicts),
  }
}

export interface FleetDefectSummary {
  /** Workspaces whose last full extraction could not read at least one document. */
  workspacesWithDefects: number
  /** Documents, summed fleet-wide. */
  totalDefects: number
  /** Workspaces with NO defect column value at all: never fully extracted
   * since defect tracking existed. Reported separately and never
   * folded into "0 defects" — "not looked at" and "looked at, found nothing"
   * are different facts, and conflating them is how a detector comes to report
   * a fleet-wide clean bill of health it never earned. */
  workspacesNeverExamined: number
  worst: Array<{ landscapeId: string; versionId: string; defectCount: number; summary: string | null }>
}

export async function fleetDefectSummary(
  db: Queryable,
  /** `worstLimit: 0` skips the second query entirely — `/metrics` scrapes only
   * the three totals and must not pay for a ranked scan it would discard. */
  { worstLimit = 5 }: { worstLimit?: number } = {},
): Promise<FleetDefectSummary> {
  const { rows } = await db.query<{
    workspaces_with_defects: string
    total_defects: string
    workspaces_never_examined: string
  }>(
    `SELECT
       count(*) FILTER (WHERE defect_count > 0)::bigint    AS workspaces_with_defects,
       COALESCE(sum(defect_count), 0)::bigint              AS total_defects,
       count(*) FILTER (WHERE defect_count IS NULL)::bigint AS workspaces_never_examined
     FROM read_model_projection_state`,
  )
  const limit = Number.isFinite(worstLimit) ? Math.max(0, Math.floor(worstLimit)) : 5
  const { rows: worst } = limit === 0
    ? { rows: [] as Array<{ landscape_id: string; version_id: string; defect_count: number; defect_summary: string | null }> }
    : await db.query<{
      landscape_id: string; version_id: string; defect_count: number; defect_summary: string | null
    }>(
      `SELECT landscape_id, version_id, defect_count, defect_summary
         FROM read_model_projection_state
        WHERE defect_count > 0
        ORDER BY defect_count DESC, landscape_id, version_id
        LIMIT $1`,
      [limit],
    )
  const head = rows[0]
  return {
    workspacesWithDefects: Number(head?.workspaces_with_defects ?? 0),
    totalDefects: Number(head?.total_defects ?? 0),
    workspacesNeverExamined: Number(head?.workspaces_never_examined ?? 0),
    worst: worst.map((row) => ({
      landscapeId: row.landscape_id,
      versionId: row.version_id,
      defectCount: row.defect_count,
      summary: row.defect_summary,
    })),
  }
}

/**
 * Full-sync projections REFUSED because their source document carried no entity
 * map — an object/connection shard delta, or a `metadata` pass whose ModelMeta
 * has no `groups`. All three compute "delete everything not in this list", so an
 * uninitialised source would delete every row it owns.
 *
 * Process-scoped and monotonic: a counter, not a workspace fact. One document's
 * view must never overwrite what a full extraction recorded about the workspace,
 * which is why this does not touch `defect_count`.
 *
 * Non-zero means the projector declined to delete rows on evidence that failed
 * to load. See `isUninformative` in modelDefects.ts for why refusing is the safe
 * direction.
 */
let refusedProjections = 0

export function recordRefusedProjection(): void {
  refusedProjections += 1
}

export function refusedProjectionCount(): number {
  return refusedProjections
}

/** Test-only reset; the counter is process-scoped by design. */
export function resetRefusedProjections(): void {
  refusedProjections = 0
}
