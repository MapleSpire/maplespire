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
// each. A per-shard delta knows only its own shard's ids, so it cannot re-seal.
//
// G4-16f C6a — WHAT THE DELTA PATHS DO INSTEAD: they MAINTAIN the object and
// connection seals. Not per shard (the client's "edits" overlay shard holds
// copies of ids that also live in their original shard, so a per-shard XOR
// would double-count every edited id), but per TABLE: the four writers
// (`upsertObjects`, `deleteObjects`, `upsertConnections`,
// `deleteConnections`) record the ids that actually ENTERED (`splitUpsertIds`,
// the existing-row lookup that already fed the workspace counter) and LEFT
// (`DELETE … RETURNING id`) into the transaction's `IdSetDeltaRecorder`, and
// the stamp writes `old ⊕ delta` at the new generation — ONLY when the old
// seal is still current (`g = projected_generation`). A seal that had gone
// stale stays stale; `verifyDigest` reports it `not-verifiable` with the two
// generations in the reason, never as a match.
//
// FAILURE DIRECTION: every way of getting this wrong leaves the seal stale,
// absent or MISMATCHED, all of which refuse a verify-and-adopt and send the
// workspace to a cold build. A writer that forgets to record, a call site that
// forgets to declare `maintained` (the kind is then in neither list and goes
// stale), a projection with no health span (`invalidateContentDigests`), a
// skipped stamp (likewise). None can make an id-set seal match rows it does
// not describe: the stamp moves the seal by exactly what the recorded writers
// did to the table, so a seal that mismatched before still mismatches after,
// and an unrecorded id change leaves a lasting mismatch
// (`digestMaintenance.integration.test.ts`; the stray-DELETE arm of
// `projectorService.integration.test.ts`).
//
// WHAT A MAINTAINED SEAL CERTIFIES, which is narrower than a fresh one: "the
// id set changed only through recorded writers since the last full seal" —
// not "the rows equal an extraction". A delete records what `RETURNING` says
// left, so a delete that removed fewer rows than its caller meant is
// invisible here, exactly as an `ON CONFLICT` that updated instead of
// inserting already was. C6's verify-and-adopt check is this "no write
// bypassed the projector since the seal" property.
//
// THE STATIC PLANE binds no recorder and stamps nothing. Its publishes advance
// `projected_generation` (begin/complete), which un-dates any seal. Its one
// generation move that can stay put — `advanceReadModelGenerationWithinTransaction`
// on a workspace that is behind, used by the C4-parent repair — changes no id
// (an UPDATE of `c4_parent_id`).
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
import { isPool } from './queryableShape.js'
import type { WorkspaceKey } from './projector.js'
import type { MetricSample } from '../runtime/metrics.js'
import { duplicateIdDefectCount, summarizeModelDefects, type ModelDefect } from './modelDefects.js'
import {
  DIGEST_KINDS,
  digestSql,
  parseDigestRow,
  summarizeDigestVerdicts,
  verifyDigest,
  type ContentDigest,
  type DigestDelta,
  type DigestKind,
  type DigestVerdict,
  type IdSetDeltaRecorder,
  type MaintainedDigestKind,
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
  /**
   * Kinds this projection changed ONLY through the recording writers
   * (`upsertObjects` / `deleteObjects` / `upsertConnections` /
   * `deleteConnections`, see `IdSetDeltaRecorder`), so the seal is carried
   * forward with `deltas[kind]` XORed in (G4-16f C6a). Declared by the call
   * site — the shard deltas and the metadata pass's tombstones — because only
   * it knows that nothing else in its action wrote the table.
   *
   * Carried exactly like `unchanged`, under the same generation rule: a seal
   * that was already stale stays stale. `unchanged` kinds get their recorded
   * delta too: if a writer recorded on a kind declared untouched, the
   * recorder is the truth and the declaration was wrong.
   */
  maintained?: readonly MaintainedDigestKind[]
  /**
   * The id-set changes the recording writers made in THIS transaction.
   * Filled by the projection runner from its recorder (`withRecordedDeltas`),
   * never by a call site. Absent means zero.
   */
  deltas?: Partial<Record<MaintainedDigestKind, DigestDelta>>
}

export function hasIntegrityToStamp(integrity: ProjectionIntegrity | undefined): boolean {
  if (!integrity) return false
  return integrity.defects !== undefined
    || Object.keys(integrity.digests ?? {}).length > 0
    || (integrity.unchanged?.length ?? 0) > 0
    || (integrity.maintained?.length ?? 0) > 0
}

/**
 * `integrity` with the recorder's deltas attached. `undefined` stays
 * `undefined`: a projection that declared nothing carries nothing forward, so
 * every kind goes stale at its generation, recorded or not.
 */
export function withRecordedDeltas(
  integrity: ProjectionIntegrity | undefined,
  recorder: IdSetDeltaRecorder,
): ProjectionIntegrity | undefined {
  if (!integrity) return undefined
  return { ...integrity, deltas: recorder.deltasByKind() }
}

/**
 * Remove `kinds` from the stored seals: "not comparable", in a form no later
 * carry-forward can revive (a seal absent is never carried). For a write that
 * changed rows and cannot date a seal — the projection runner's path with no
 * health span, which writes rows without advancing `projected_generation`,
 * so the old seal would otherwise stay comparable over rows it no longer
 * describes.
 *
 * Under a SAVEPOINT and never throwing, like the stamp: bookkeeping must not
 * roll back the projection. A failure is logged and leaves the old seal,
 * which then MISMATCHES the rows — an adopt refusal, not a false match.
 */
export async function invalidateContentDigests(
  tx: Queryable,
  key: WorkspaceKey,
  kinds: readonly DigestKind[],
): Promise<void> {
  const unique = [...new Set(kinds)]
  if (!unique.length) return
  const update = () => tx.query(
    `UPDATE read_model_projection_state
       SET content_digest = content_digest - $3::text[], updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2 AND content_digest IS NOT NULL`,
    [key.landscapeId, key.versionId, unique],
  )
  // On a POOL (a caller with no transaction — `stampProjectionIntegrity` is
  // called that way by its own tests) there is no transaction to protect and a
  // SAVEPOINT is an error: the single statement is its own transaction.
  if (isPool(tx)) {
    await update().catch((error: unknown) =>
      console.error('[read-model] content digest invalidation failed', error))
    return
  }
  await tx.query('SAVEPOINT read_model_integrity_invalidate')
  try {
    await update()
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT read_model_integrity_invalidate')
    console.error('[read-model] content digest invalidation failed; projection kept', error)
  }
  await tx.query('RELEASE SAVEPOINT read_model_integrity_invalidate')
}

/** The kinds a projection that wrote rows WITHOUT a stamp must invalidate:
 * every kind it did not declare `unchanged`, and every kind a writer
 * recorded on whatever it declared. */
export function kindsChangedWithoutStamp(
  integrity: ProjectionIntegrity | undefined,
  recorded: readonly MaintainedDigestKind[],
): DigestKind[] {
  const unchanged = new Set<DigestKind>(integrity?.unchanged ?? [])
  return [...new Set<DigestKind>([...DIGEST_KINDS.filter((kind) => !unchanged.has(kind)), ...recorded])]
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
  //
  // C6a — A CARRIED KIND WITH A RECORDED DELTA ($9) is stamped `old ⊕ delta`
  // at $6, under the SAME generation predicate: the XOR is only meaningful
  // against a seal that described the rows one generation ago. A stale seal
  // with a delta stays stale (`ELSE value`), and so does a malformed one (the
  // `x`/`n` shape guards come before any cast, so a bad stored value cannot
  // abort the savepoint either). `bit(64) # bit(64)` is the XOR;
  // `::bigint` + `to_hex` + `lpad` render it exactly as `digestSql` does.
  const carried = [...new Set<string>([...(integrity.unchanged ?? []), ...(integrity.maintained ?? [])])]
  const deltas: Record<string, DigestDelta> = {}
  for (const [kind, delta] of Object.entries(integrity.deltas ?? {})) {
    if (delta) deltas[kind] = delta
  }
  const result = await tx.query(
    `UPDATE read_model_projection_state SET
       content_digest = COALESCE((
         SELECT jsonb_object_agg(key, CASE
           WHEN key = ANY($7::text[])
            AND jsonb_typeof(value) = 'object'
            AND value->>'g' = projected_generation::text
            AND ($9::jsonb -> key) IS NULL
             THEN value || jsonb_build_object('g', $6::bigint)
           WHEN key = ANY($7::text[])
            AND jsonb_typeof(value) = 'object'
            AND value->>'g' = projected_generation::text
            AND jsonb_typeof(value->'n') = 'number'
            AND (value->>'n') ~ '^-?[0-9]{1,18}$'
            AND (value->>'x') ~ '^[0-9a-f]{16}$'
             THEN value || jsonb_build_object(
               'n', (value->>'n')::bigint + ($9::jsonb -> key ->> 'n')::bigint,
               'x', lpad(to_hex((('x' || (value->>'x'))::bit(64)
                       # ('x' || ($9::jsonb -> key ->> 'x'))::bit(64))::bigint), 16, '0'),
               'g', $6::bigint)
           ELSE value END)
         FROM jsonb_each(COALESCE(content_digest, '{}'::jsonb))
       ), '{}'::jsonb) || $3::jsonb,
       defect_count = CASE WHEN $4::integer IS NULL THEN defect_count ELSE $4::integer END,
       duplicate_id_count = CASE WHEN $4::integer IS NULL THEN duplicate_id_count ELSE $8::integer END,
       defect_summary = CASE WHEN $4::integer IS NULL THEN defect_summary ELSE $5 END,
       defects_observed_at = CASE WHEN $4::integer IS NULL THEN defects_observed_at ELSE now() END,
       duplicate_ids_observed_at = CASE WHEN $4::integer IS NULL THEN duplicate_ids_observed_at ELSE now() END,
       updated_at = now()
     WHERE landscape_id = $1 AND version_id = $2 AND projected_generation < $6`,
    [
      key.landscapeId,
      key.versionId,
      JSON.stringify(stamped),
      defects === undefined ? null : defects.length,
      defects === undefined ? null : summarizeModelDefects(defects),
      generation,
      carried,
      defects === undefined ? null : duplicateIdDefectCount(defects),
      JSON.stringify(deltas),
    ],
  )
  // `rowCount` is null on some drivers/fakes; treat unknown as "wrote something"
  // so a test double does not manufacture a warning.
  const wrote = result.rowCount === null || result.rowCount > 0
  // Skipped (a newer generation already committed): this transaction's rows
  // still land, after that generation's seal was taken, so a kind this
  // projection moved would read as comparable over rows it no longer
  // describes. Not comparable instead — by the same rule as the runner's
  // no-health-span path: every kind not declared `unchanged`, plus every kind
  // a writer recorded on (a zero-count swap of one id for another included).
  if (!wrote) {
    await invalidateContentDigests(tx, key,
      kindsChangedWithoutStamp(integrity, Object.keys(deltas) as MaintainedDigestKind[]))
  }
  return wrote
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

/** One kind's seal as `content_digest` stores it, or null when absent or
 * malformed (`adoptVerify.ts` reads the same column through it). */
export function parseStamped(value: unknown): StampedDigest | null {
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

/**
 * The split of `defect_count` into dropped duplicate ids and unreadable
 * documents, as SQL over a `read_model_projection_state` row. EVERY reader of
 * the split goes through these two (`fleetDefectSummary`, its `worst`, the
 * reference-integrity refusal), so a mixed-version fleet cannot make them
 * disagree.
 *
 * `duplicate_id_count` is TRUSTED ONLY when `duplicate_ids_observed_at`
 * equals `defects_observed_at`, i.e. when the UPDATE that wrote the current
 * `defect_count` also wrote it (`stampProjectionIntegrity` sets both to one
 * `now()`). The previous release's stamp — a rollback, or a mixed-version
 * fleet — rewrites
 * `defect_count` and `defects_observed_at` and knows neither duplicate
 * column: this version stamps defect 2 / dup 2, the previous release then
 * stamps defect 1,
 * and `defect_count - duplicate_id_count` would be -1 — a workspace dropped
 * from `workspaces_with_defects` that also cancels another workspace's real
 * unreadable document out of the sum, and two ghost duplicates for ever.
 * Untrusted, the count is unknown, so every defect counts as a document:
 * the previous release has no `duplicate-id` defect, so its `defect_count` IS documents.
 * A row stamped before the columns existed (both NULL) reads the same way.
 *
 * The residue of that equality: two stamps by different transactions whose
 * `now()` (transaction start, microseconds) is identical would pass it.
 *
 * `LEAST(defect_count, …)` bounds the duplicates by the count they are part
 * of, so `defect_count - duplicates` cannot go negative and cancel another
 * workspace's documents out of a fleet sum. No writer in this tree produces a
 * trusted `duplicate_id_count` above `defect_count`; the bound is for the one
 * that will. (With it, `defect_count - duplicates` is >= 0 by construction,
 * so no outer `GREATEST(0, …)` is added: it could never change a result.)
 */
export const DUPLICATE_IDS_SQL = `LEAST(defect_count, COALESCE(
  CASE WHEN duplicate_ids_observed_at = defects_observed_at THEN duplicate_id_count END, 0))`
/** `defect_count` less the trusted duplicates (`DUPLICATE_IDS_SQL`): the
 * documents a full extraction resolved and could not read. NULL when
 * `defect_count` is (never examined). */
export const UNREADABLE_DOCUMENTS_SQL = `(defect_count - ${DUPLICATE_IDS_SQL})`

export interface FleetDefectSummary {
  /** Workspaces whose last full extraction could not read at least one
   * document. Duplicate ids are NOT counted here (`workspacesWithDuplicateIds`):
   * `defect_count` includes them, `UNREADABLE_DOCUMENTS_SQL` does not. */
  workspacesWithDefects: number
  /** Documents, summed fleet-wide (duplicate ids excluded, as above). */
  totalDefects: number
  /** Workspaces whose last full extraction dropped at least one duplicate
   * id (`duplicate_id_count`, the last occurrence kept). Data present in the
   * documents twice, not data missing from the read model. */
  workspacesWithDuplicateIds: number
  /** Duplicate ids dropped, summed fleet-wide. */
  totalDuplicateIds: number
  /** Workspaces with NO defect column value at all: never fully extracted
   * since defect tracking existed. Reported separately and never
   * folded into "0 defects" — "not looked at" and "looked at, found nothing"
   * are different facts, and conflating them is how a detector comes to report
   * a fleet-wide clean bill of health it never earned. */
  workspacesNeverExamined: number
  /**
   * Every workspace with `defect_count > 0` — every one the
   * reference-integrity refusal refuses, duplicate-only ones included —
   * ranked by UNREADABLE DOCUMENTS first (missing data outranks a copy
   * dropped from the documents), then by `defect_count`. So its filter is
   * wider than `workspacesWithDefects` on purpose: a duplicate-only workspace
   * is listed (after the ones missing data) with `unreadableDocuments: 0`.
   * `defectCount` is the raw column; the two split fields sum to it.
   */
  worst: Array<{
    landscapeId: string
    versionId: string
    defectCount: number
    unreadableDocuments: number
    duplicateIds: number
    summary: string | null
  }>
}

type WorstRow = {
  landscape_id: string
  version_id: string
  defect_count: number
  unreadable_documents: number
  duplicate_ids: number
  defect_summary: string | null
}

export async function fleetDefectSummary(
  db: Queryable,
  /** `worstLimit: 0` skips the second query entirely — `/metrics` scrapes only
   * the three totals and must not pay for a ranked scan it would discard. */
  { worstLimit = 5 }: { worstLimit?: number } = {},
): Promise<FleetDefectSummary> {
  // The split is `DUPLICATE_IDS_SQL` / `UNREADABLE_DOCUMENTS_SQL`, which say
  // when `duplicate_id_count` is believed (a row stamped before the column,
  // or last stamped by the previous release, counts every defect as a document).
  const { rows } = await db.query<{
    workspaces_with_defects: string
    total_defects: string
    workspaces_with_duplicate_ids: string
    total_duplicate_ids: string
    workspaces_never_examined: string
  }>(
    `SELECT
       count(*) FILTER (WHERE ${UNREADABLE_DOCUMENTS_SQL} > 0)::bigint AS workspaces_with_defects,
       COALESCE(sum(${UNREADABLE_DOCUMENTS_SQL}), 0)::bigint         AS total_defects,
       count(*) FILTER (WHERE ${DUPLICATE_IDS_SQL} > 0)::bigint       AS workspaces_with_duplicate_ids,
       COALESCE(sum(${DUPLICATE_IDS_SQL}), 0)::bigint                 AS total_duplicate_ids,
       count(*) FILTER (WHERE defect_count IS NULL)::bigint           AS workspaces_never_examined
     FROM read_model_projection_state`,
  )
  const limit = Number.isFinite(worstLimit) ? Math.max(0, Math.floor(worstLimit)) : 5
  const { rows: worst } = limit === 0
    ? { rows: [] as WorstRow[] }
    : await db.query<WorstRow>(
      `SELECT landscape_id, version_id, defect_count,
              ${UNREADABLE_DOCUMENTS_SQL} AS unreadable_documents,
              ${DUPLICATE_IDS_SQL} AS duplicate_ids,
              defect_summary
         FROM read_model_projection_state
        WHERE defect_count > 0
        ORDER BY unreadable_documents DESC, defect_count DESC, landscape_id, version_id
        LIMIT $1`,
      [limit],
    )
  const head = rows[0]
  return {
    workspacesWithDefects: Number(head?.workspaces_with_defects ?? 0),
    totalDefects: Number(head?.total_defects ?? 0),
    workspacesWithDuplicateIds: Number(head?.workspaces_with_duplicate_ids ?? 0),
    totalDuplicateIds: Number(head?.total_duplicate_ids ?? 0),
    workspacesNeverExamined: Number(head?.workspaces_never_examined ?? 0),
    worst: worst.map((row) => ({
      landscapeId: row.landscape_id,
      versionId: row.version_id,
      defectCount: row.defect_count,
      unreadableDocuments: Number(row.unreadable_documents),
      duplicateIds: Number(row.duplicate_ids),
      summary: row.defect_summary,
    })),
  }
}

/**
 * The `/metrics` samples for the defect split and the live drop counter,
 * built from a `fleetDefectSummary` (`worstLimit: 0`) and
 * `liveDuplicateIdDropCount()`. Pure, so the wiring — which total goes under
 * which name and scope — is unit-tested (`projectionIntegrity.test.ts`)
 * rather than read off index.ts.
 */
export function readModelDefectMetricSamples(
  defects: Pick<FleetDefectSummary,
    'totalDefects' | 'workspacesWithDefects' | 'totalDuplicateIds' | 'workspacesWithDuplicateIds' | 'workspacesNeverExamined'>,
  liveDuplicateIdDrops: number,
): MetricSample[] {
  return [
    {
      name: 'maplespire_read_model_unreadable_documents',
      help: 'Documents a full extraction resolved but could not read. Each one is data missing from the read model with no error anywhere. Duplicate ids are not counted here (maplespire_read_model_duplicate_ids).',
      type: 'gauge',
      values: [
        { labels: { scope: 'documents' }, value: defects.totalDefects },
        { labels: { scope: 'workspaces' }, value: defects.workspacesWithDefects },
      ],
    },
    {
      name: 'maplespire_read_model_duplicate_ids',
      help: 'Entity ids a full extraction found twice (two map keys, or two registry shards, one inner id) and projected once, the last occurrence kept. Not missing data: the documents hold a copy the read model does not serve.',
      type: 'gauge',
      values: [
        { labels: { scope: 'ids' }, value: defects.totalDuplicateIds },
        { labels: { scope: 'workspaces' }, value: defects.workspacesWithDuplicateIds },
      ],
    },
    {
      name: 'maplespire_read_model_live_duplicate_ids_dropped_total',
      help: 'Duplicate ids dropped by a live pass (the ModelMeta pass, an object or connection shard delta) over the one document it read, the last occurrence kept. Counts passes x ids, not distinct ids.',
      type: 'counter',
      values: [{ value: liveDuplicateIdDrops }],
    },
    {
      name: 'maplespire_read_model_workspaces_never_examined',
      help: 'Workspaces with no defect count recorded. NOT the same as zero defects — these have never been fully extracted since T1.3a shipped.',
      type: 'gauge',
      values: [{ value: defects.workspacesNeverExamined }],
    },
  ]
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

/**
 * Duplicate ids a LIVE pass dropped — the ModelMeta pass (groups) and the
 * object/connection shard deltas, each over the one document it read
 * (`lastOccurrenceById`). Process-scoped and monotonic, like
 * `refusedProjections` and for the same reason: one document's view must
 * not overwrite `defect_count`/`duplicate_id_count`, which only a full
 * extraction writes. A pass that sees the same duplicate again counts it
 * again; this is a rate of passes that had to drop something, not a census.
 */
let liveDuplicateIdDrops = 0

export function recordLiveDuplicateIdDrops(count: number): void {
  liveDuplicateIdDrops += count
}

export function liveDuplicateIdDropCount(): number {
  return liveDuplicateIdDrops
}

/** Test-only reset; the counter is process-scoped by design. */
export function resetRefusedProjections(): void {
  refusedProjections = 0
}
