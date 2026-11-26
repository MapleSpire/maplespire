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

/**
 * VERIFY-AND-ADOPT, THE CLAIM (G4-16f C6-1, C6-2a): may an attach keep the
 * read model the previous owner left instead of rebuilding it?
 *
 * The verifier runs the claim's checks S1-S5 inside the real projection
 * transaction — the mutex, the fence row FOR UPDATE, then the adopt row FOR
 * UPDATE (THE LOCK ORDER, `adoptState.ts`).
 *  - `READ_MODEL_ADOPT=shadow` (C6-1): then ROLLS BACK through a sentinel
 *    throw: no CAS, no `projector_attached` change, nothing written. The
 *    caller logs the verdict and cold-builds exactly as with the flag off.
 *  - `READ_MODEL_ADOPT=on` (C6-2a, {@link claimAdopt}): on an adoptable
 *    verdict, S6 CLAIMS in the same transaction — `stillClaiming()` (a
 *    release during the checks), the fence CAS from the observed fence to
 *    this instance, the fence assertion (the protocol marker), and
 *    `projector_attached = false` naming this instance — and COMMITS. The
 *    adopt row's binding is NOT armed (it stays the previous fence, so the
 *    row is unadoptable until the attach's last transaction binds it, B5),
 *    and no generation is opened. A refusal before S6 is the cold build's,
 *    in the same call (the caller's). The background attach B1-B5 is the
 *    projector's (`projectorService.ts`).
 *
 * The steps, each a refusal when its condition fails:
 *  - PRECHECK, no lock, before the mutex: `readAdoptPlane` + `adoptRefusal`
 *    (every row written before C6b, every unbound row, every row whose
 *    binding is not the current fence) and the current fence equal to the
 *    one this attach observed at its start; a lifecycle fence is named.
 *  - S1, the fence row: `assertReadModelWriteFence(tx, key, F_obs)` takes it
 *    FOR UPDATE, verifies `write_fence = F_obs` and the connection's
 *    protocol marker in one statement; then its health columns (same row,
 *    already held): `degraded_since` set, `last_error_generation >
 *    projected_generation` (failed) and `last_projected_at` NULL
 *    (uninitialized) refuse. `observed_generation > projected_generation`
 *    does NOT refuse: a pass abandoned by a crash rolled back whole and
 *    left only its observation behind.
 *  - S2, the adopt row (`readAdoptPlaneForUpdate`): `adoptRefusal` again
 *    under the locks, then the org, the seal and the posture against THIS
 *    projector's own.
 *  - S3: the protocol digests recomputed (`adoptProtocolDigests`) equal to
 *    the stored ones — a write made with the triggers disabled is seen here.
 *  - S4: the four id-set digests (`digestSql`) against the seals in
 *    `content_digest`, through `verifyDigest` with `projected_generation`:
 *    every kind must be `match`. What a match certifies is C6a's narrower
 *    property: the four `ro_*` primary-key sets changed only through the
 *    projector's recorded writers since the last full seal. NOT row content
 *    (`data`, `parent_id`, names), NOT the other `ro_*` tables. Certifying
 *    row content too (a content digest) is an open design decision.
 *  - S5: every listed shard classified (`classifyListedShards`) from its
 *    watermark, retirement and fold rows, in one statement.
 */

import { performance } from 'node:perf_hooks'
import { getHeads, hasHeads, view as viewDoc, type Doc } from '@automerge/automerge'
import {
  adoptPostureText,
  adoptProtocolDigests,
  adoptRefusal,
  readAdoptPlane,
  readAdoptPlaneForUpdate,
  type AdoptPosture,
} from './adoptState.js'
import { DIGEST_KINDS, digestSql, parseDigestRow, verifyDigest, type ContentDigest, type DigestKind } from './contentDigest.js'
import {
  ReadModelWriteFenceError,
  assertReadModelWriteFence,
  claimReadModelWriteFence,
  isLifecycleWriteFence,
  markReadModelProjectorAdopting,
} from './health.js'
import { isReadModelAuthorityLoss } from './projectionAuthority.js'
import { parseStamped } from './projectionIntegrity.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import { ReadModelProtocolMarkerError } from './protocolParticipant.js'
import { isPool } from './queryableShape.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

// ---------------------------------------------------------------- THE FLAG

export const READ_MODEL_ADOPT_FLAG = 'READ_MODEL_ADOPT'

/** What this build can do with the flag (`on` since C6-2a). */
export type ReadModelAdoptMode = 'off' | 'shadow' | 'on'

/**
 * `READ_MODEL_ADOPT`, parsed once at boot (`index.ts`, beside
 * `ordinaryHeadRotationConfig`): unset, empty or `off` is off; `shadow` runs
 * the verifier and logs its verdict; `on` adopts what the verifier accepts
 * (C6-2a). Any other value THROWS, so a typo refuses to boot instead of
 * silently meaning off.
 */
export function readModelAdoptMode(env: Readonly<Record<string, string | undefined>> = process.env): ReadModelAdoptMode {
  const value = env[READ_MODEL_ADOPT_FLAG]?.trim()
  if (value === undefined || value === '' || value === 'off') return 'off'
  if (value === 'shadow') return 'shadow'
  if (value === 'on') return 'on'
  throw new Error(`invalid-${READ_MODEL_ADOPT_FLAG}`)
}

// ------------------------------------------------------- THE CLASSIFIER (S5)

export type ListedCollection = 'object' | 'connection'

/** One listed shard with its rows, as the S5 statement returns it. */
export interface ListedShardRow {
  collection: ListedCollection
  documentId: string
  /** 1-based position in its list. */
  position: number
  /** A `read_model_document_watermarks` row exists. */
  hasWatermark: boolean
  projectedHeads: string[] | null
  /** The `read_model_ordinary_head_retirements` row's status; null: no row. */
  status: string | null
  origin: string | null
  retirementHeads: string[] | null
  forwardedHeads: string[] | null
  foldedInto: string | null
  /** A `read_model_ordinary_chain_folds` record names it as its product. */
  isFoldProduct: boolean
}

/** Where an adopter would seed a listed shard's watcher from (C6-2, B3):
 *  - `retired`: a rotated-out head — `forwarded_heads ?? retirement_heads`;
 *  - `product`: a fold product — `retirement_heads`;
 *  - `projected`: no retirement row (or `admitted`, which is treated like
 *    none) and a watermark row — its `projected_heads`;
 *  - `new`: no row at all — attached like a new shard (`applyInitial`).
 * A retired head or a product NEVER seeds at `projected_heads`: on a retired
 * head those are a stamp's forwarded-up-to heads. */
export type ShardSeedSource = 'retired' | 'product' | 'projected' | 'new'

export interface ShardSeed {
  collection: ListedCollection
  documentId: string
  source: ShardSeedSource
  /** Null only for `new`. */
  heads: string[] | null
}

export interface ShardClassificationCounts {
  listed: number
  retired: number
  products: number
  projected: number
  newShards: number
}

export type ShardClassification =
  | { refusal: string; detail: string }
  | { refusal: null; seeds: ShardSeed[]; counts: ShardClassificationCounts }

const RETIRED_STATUSES = new Set(['retired', 'folded'])

/**
 * Pure. Refuses, in this order:
 *  - `duplicate-listing`: a document listed more than once, in one list or
 *    across both (the merge is last-wins over the list; its rows cannot be
 *    attributed to one revision);
 *  - `folded-product-unlisted`: a LISTED document whose row is `folded`
 *    into a product that is not listed in the same kind's list (a fold
 *    recorded whose ModelMeta splice the rows do not reflect);
 *  - `seed-heads`: a retired head or product without the heads its seed
 *    needs (the schema's CHECK makes this unreachable for `retired`);
 *  - `null-projected-heads`: a shard with no retirement row whose watermark
 *    row has NULL heads (a writer that had no sample, `arrivalWatermark.ts`).
 */
export function classifyListedShards(rows: readonly ListedShardRow[]): ShardClassification {
  const seen = new Map<string, number>()
  for (const row of rows) seen.set(row.documentId, (seen.get(row.documentId) ?? 0) + 1)
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id)
  if (duplicated.length) return { refusal: 'duplicate-listing', detail: duplicated.slice(0, 5).join(',') }
  const listedOf = (collection: ListedCollection) =>
    new Set(rows.filter((row) => row.collection === collection).map((row) => row.documentId))
  const listed = { object: listedOf('object'), connection: listedOf('connection') }
  const seeds: ShardSeed[] = []
  const counts: ShardClassificationCounts = { listed: rows.length, retired: 0, products: 0, projected: 0, newShards: 0 }
  for (const row of rows) {
    const base = { collection: row.collection, documentId: row.documentId }
    if (row.status !== null && RETIRED_STATUSES.has(row.status)) {
      if (row.status === 'folded' && (row.foldedInto === null || !listed[row.collection].has(row.foldedInto))) {
        return { refusal: 'folded-product-unlisted', detail: `${row.collection}:${row.documentId}->${row.foldedInto ?? 'null'}` }
      }
      const product = row.origin === 'fold-product' || row.isFoldProduct
      const heads = product ? row.retirementHeads : (row.forwardedHeads ?? row.retirementHeads)
      if (heads === null) return { refusal: 'seed-heads', detail: `${row.collection}:${row.documentId}` }
      seeds.push({ ...base, source: product ? 'product' : 'retired', heads: [...heads] })
      if (product) counts.products += 1
      else counts.retired += 1
      continue
    }
    if (row.hasWatermark) {
      if (row.projectedHeads === null) return { refusal: 'null-projected-heads', detail: `${row.collection}:${row.documentId}` }
      seeds.push({ ...base, source: 'projected', heads: [...row.projectedHeads] })
      counts.projected += 1
      continue
    }
    seeds.push({ ...base, source: 'new', heads: null })
    counts.newShards += 1
  }
  return { refusal: null, seeds, counts }
}

/** The S5 statement: every listed id (object list, then connection list, in
 * list order, duplicates kept) with its watermark, retirement and fold rows. */
const LISTED_SHARDS_SQL = `
  WITH listed AS (
    SELECT 'object'::text AS collection, l.id, l.ord FROM unnest($3::text[]) WITH ORDINALITY AS l(id, ord)
    UNION ALL
    SELECT 'connection'::text, l.id, l.ord FROM unnest($4::text[]) WITH ORDINALITY AS l(id, ord)
  )
  SELECT listed.collection, listed.id, listed.ord::int AS position,
         (watermark.document_id IS NOT NULL) AS has_watermark, watermark.projected_heads,
         retirement.status, retirement.origin, retirement.retirement_heads, retirement.forwarded_heads,
         retirement.folded_into, (fold.product_document_id IS NOT NULL) AS is_fold_product
    FROM listed
    LEFT JOIN read_model_document_watermarks AS watermark
      ON watermark.landscape_id = $1 AND watermark.version_id = $2 AND watermark.document_id = listed.id
    LEFT JOIN read_model_ordinary_head_retirements AS retirement
      ON retirement.landscape_id = $1 AND retirement.version_id = $2
     AND retirement.collection = listed.collection AND retirement.document_id = listed.id
    LEFT JOIN read_model_ordinary_chain_folds AS fold
      ON fold.landscape_id = $1 AND fold.version_id = $2
     AND fold.collection = listed.collection AND fold.product_document_id = listed.id
   ORDER BY listed.collection = 'connection', listed.ord`

// --------------------------------------------------------------- THE VERDICT

export type AdoptStage = 'precheck' | 'open' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export interface AdoptVerdict {
  mode: 'shadow' | 'on'
  /** `error`: the verifier could not answer (a SQL error, a mutex timeout,
   * a lost plane) — never read as adoptable. `claimed` (`on` only): S6
   * committed; this instance holds the fence and must attach (B1-B5). */
  verdict: 'adoptable' | 'refused' | 'error' | 'claimed'
  reason: string | null
  /** The step that decided (for `adoptable`, the last one: S5). */
  stage: AdoptStage
  detail?: string
  verifyMs: number
  stepMs: Partial<Record<AdoptStage, number>>
  /** S4's live aggregates, every kind it read (also on a mismatch); null
   * when S4 did not run. */
  keptDigests: Partial<Record<DigestKind, ContentDigest | null>> | null
  /** The kept row's topology digest (S2); null when S2 did not pass.
   * `adoptable` means S1-S5 passed: the LIVE topology is not compared here
   * (C6-2 checks it when it loads ModelMeta), so the caller compares it
   * after its build. */
  keptTopologyDigest: string | null
  /** S5's seeds; null when S5 did not run or refused. */
  seeds: ShardSeed[] | null
  counts: ShardClassificationCounts | null
  /** The kept row's id lists (S2), what the seeds are keyed by; null when
   * S2 did not pass. */
  keptLists: { objectShardIds: string[]; connectionShardIds: string[]; registryShardIds: string[] } | null
}

export interface AdoptVerifyInput {
  orgId: string | null
  /** The fence this attach read at its start (`fenceObservedAtStart`). */
  fenceObserved: string | null
  sealedCeiling: number
  posture: AdoptPosture
  /** TEST SEAM: awaited after each step, inside the transaction (the lock
   * probes, injected faults). Production passes none. */
  afterStep?: (stage: AdoptStage, tx: Queryable) => Promise<void> | void
}

/** The sentinel that ends the verify transaction: carries the verdict out
 * through `withReadModelProjectionTransaction`'s ROLLBACK. */
class ShadowVerdict extends Error {
  constructor(readonly reason: string | null, readonly stage: AdoptStage, readonly detail?: string) {
    super(`adopt shadow verdict: ${reason ?? 'adoptable'} at ${stage}`)
    this.name = 'ShadowVerdict'
  }
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10

/** `statement_timeout` inside the verify transaction. A bound chosen, not
 * measured against the aged corpus: S4's scans there are unmeasured;
 * on its 8-object test corpus the whole verify
 * measured 4.4-10.2 ms over 18 samples, which says nothing about scale. */
export const ADOPT_VERIFY_STATEMENT_TIMEOUT_MS = 5_000

/** The fence row's health columns S1 reads (generations as text). */
export interface FenceStateRow extends Record<string, unknown> {
  observed_generation: string | null
  projected_generation: string | null
  last_error_generation: string | null
  last_projected_at: Date | string | null
  degraded_since: Date | string | null
  content_digest: unknown
}

/** S1's health rules, pure: `degraded` (a degradation is recorded), `failed`
 * (`last_error_generation > projected_generation`, the status ladder's own
 * rule, `health.ts`), `uninitialized` (never projected). An observation
 * ahead of the projection is NOT a refusal: a pass a crash abandoned rolled
 * back whole and left only its `observed_generation` behind. */
export function fenceRowRefusal(state: FenceStateRow | undefined): string | null {
  if (!state || state.projected_generation === null) return 'no-fence-row'
  if (state.degraded_since !== null) return 'degraded'
  if (state.last_error_generation !== null && BigInt(state.last_error_generation) > BigInt(state.projected_generation)) return 'failed'
  if (state.last_projected_at === null) return 'uninitialized'
  return null
}

/**
 * Run the claim's checks for `key` in SHADOW mode and return the verdict.
 * NEVER THROWS: a failure is the verdict `error`, with the error's code or
 * name as its reason — the caller logs it and cold-builds either way.
 *
 * Only on a POOL: the checks run in a transaction of their own, which is
 * then rolled back. On a client the caller is already inside a transaction
 * (tests), where a failed statement would abort the caller's own work; the
 * verdict is `refused`/`not-a-pool` without a statement.
 *
 * EVERY AWAIT, and what a throw there leaves (bounded, and loud):
 *  - `readAdoptPlane` (precheck, on the pool, no transaction): nothing held;
 *    the verdict is `error`.
 *  - `withReadModelProjectionTransaction`: `db.connect()` — nothing held
 *    yet; then BEGIN, `SET LOCAL lock_timeout`, the mutex, the plane check,
 *    the disarm, and the run below. Any throw from BEGIN onward reaches the
 *    helper's catch: ROLLBACK (a failed ROLLBACK destroys the connection),
 *    then `release`, which also destroys a connection whose protocol marker
 *    S1 found lost. The sentinel is such a throw: every verdict reached
 *    inside the transaction leaves it rolled back and its client returned.
 *  - inside the run — the `statement_timeout` SET, `assertReadModelWriteFence`, the S1 SELECT, S2, S3,
 *    the four S4 aggregates, S5, and each `afterStep` — all on the one
 *    client the helper holds; a throw is the same rollback.
 * Nothing in this function holds a resource outside that helper.
 */
export async function verifyAdoptShadow(db: Queryable, key: WorkspaceKey, input: AdoptVerifyInput): Promise<AdoptVerdict> {
  return runAdoptVerify(db, key, input, null)
}

/** What {@link claimAdopt} needs beyond the checks. */
export interface AdoptClaimInput extends AdoptVerifyInput {
  /** The instance that claims (the attach's `projectorInstanceId`). */
  instanceId: string
  /** SYNCHRONOUS, evaluated right before the CAS, inside the claim
   * transaction: false abandons the claim as an AUTHORITY LOSS (a release,
   * a stop or a lost ownership during the checks; `ReadModelWriteFenceError`,
   * which the fleet maps to `ProjectorOwnershipError`). */
  stillClaiming: () => boolean
}

/** The claim's COMMIT failed after S6's statements ran: whether the fence
 * moved to this instance is unknown. Thrown, never a verdict: the attach
 * fails, and the next one heals either way — it observes this instance's
 * fence with the previous binding (`adoptRefusal`: `fence-moved`) and
 * cold-builds, or the previous fence unchanged. */
export class AdoptClaimOutcomeUnknownError extends Error {
  constructor(key: WorkspaceKey, cause: unknown) {
    super(`adopt claim for ${key.landscapeId}/${key.versionId}: the commit failed after the claim; outcome unknown`, { cause })
    this.name = 'AdoptClaimOutcomeUnknownError'
  }
}

/**
 * The CLAIM (`READ_MODEL_ADOPT=on`, G4-16f C6-2a): S1-S5 exactly as
 * {@link verifyAdoptShadow}, then, on an adoptable verdict, S6 in the same
 * transaction, which COMMITS:
 *  1. `stillClaiming()` (synchronous): false throws `ReadModelWriteFenceError`;
 *  2. `claimReadModelWriteFence` — the CAS from the fence S1 asserted (the
 *     one this attach observed at its start) to `instanceId`; a miss throws
 *     (it cannot miss under S1's lock: defence in depth);
 *  3. `assertReadModelWriteFence(instanceId)` — the fence is ours and the
 *     connection is a protocol participant (a lost marker is the refusal
 *     `protocol-marker`, the connection destroyed by the helper);
 *  4. `markReadModelProjectorAdopting` — `projector_attached = false`.
 * NOT the binding (the adopt row stays bound to the previous fence, so no
 * other attach can adopt it while this one attaches), and no generation.
 *
 * Returns the verdict: `claimed`, or `refused` / `error` before S6 (nothing
 * written; the caller cold-builds). THROWS on an authority loss at any step
 * (S6's release check or CAS, or a plane lost under the helper — a cold
 * build would lose it too) and on any failure after S6's first statement
 * ran ({@link AdoptClaimOutcomeUnknownError}: conservative, since some of
 * those certainly rolled back; it costs one cold build).
 */
export async function claimAdopt(db: Queryable, key: WorkspaceKey, input: AdoptClaimInput): Promise<AdoptVerdict> {
  return runAdoptVerify(db, key, input, input)
}

async function runAdoptVerify(
  db: Queryable,
  key: WorkspaceKey,
  input: AdoptVerifyInput,
  claim: AdoptClaimInput | null,
): Promise<AdoptVerdict> {
  const mode = claim ? 'on' : 'shadow'
  /** S6's statements ran: from here a failure is not a verdict. */
  let claimIssued = false
  let claimed = false
  const startedAt = performance.now()
  const stepMs: Partial<Record<AdoptStage, number>> = {}
  let stage: AdoptStage = 'precheck'
  let stepStartedAt = startedAt
  const enter = (next: AdoptStage) => {
    stepMs[stage] = roundMs(performance.now() - stepStartedAt)
    stage = next
    stepStartedAt = performance.now()
  }
  let keptDigests: AdoptVerdict['keptDigests'] = null
  let keptTopologyDigest: string | null = null
  let seeds: ShardSeed[] | null = null
  let counts: ShardClassificationCounts | null = null
  let keptLists: AdoptVerdict['keptLists'] = null
  const verdictOf = (verdict: AdoptVerdict['verdict'], reason: string | null, detail?: string): AdoptVerdict => {
    stepMs[stage] = roundMs(performance.now() - stepStartedAt)
    return {
      mode, verdict, reason, stage, ...(detail === undefined ? {} : { detail }),
      verifyMs: roundMs(performance.now() - startedAt), stepMs, keptDigests, keptTopologyDigest, seeds, counts, keptLists,
    }
  }
  try {
    if (!isPool(db)) return verdictOf('refused', 'not-a-pool')
    if (input.fenceObserved === null) return verdictOf('refused', 'no-fence')
    if (isLifecycleWriteFence(input.fenceObserved)) return verdictOf('refused', 'lifecycle-fence')
    const pre = await readAdoptPlane(db, key)
    const preRefusal = adoptRefusal(pre)
    if (preRefusal) return verdictOf('refused', preRefusal)
    if (pre!.writeFence !== input.fenceObserved) return verdictOf('refused', 'fence-moved', 'the fence moved since this attach observed it')
    const fence = input.fenceObserved
    enter('open')
    await withReadModelProjectionTransaction(db, key, 'ordinary', async (tx) => {
      // A ceiling on every statement of the verify (the helper disarmed its
      // lock_timeout): S4's aggregates hold the fence row while they scan,
      // and their cost at the aged corpus is not measured. Transaction-local;
      // an expiry is the verdict `error` (57014), never the cold build's.
      await tx.query(`SET LOCAL statement_timeout = '${ADOPT_VERIFY_STATEMENT_TIMEOUT_MS}ms'`)
      // ---- S1: the fence row FIRST (THE LOCK ORDER) and the marker.
      enter('S1')
      try {
        await assertReadModelWriteFence(tx, key, fence)
      } catch (error) {
        if (error instanceof ReadModelWriteFenceError) throw new ShadowVerdict('fence-moved', 'S1')
        if (error instanceof ReadModelProtocolMarkerError) throw new ShadowVerdict('protocol-marker', 'S1')
        throw error
      }
      const state = (await tx.query<FenceStateRow>(
        `SELECT observed_generation::text AS observed_generation, projected_generation::text AS projected_generation,
                last_error_generation::text AS last_error_generation, last_projected_at, degraded_since, content_digest
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
        [key.landscapeId, key.versionId],
      )).rows[0]
      const fenceRefusal = fenceRowRefusal(state)
      if (fenceRefusal) throw new ShadowVerdict(fenceRefusal, 'S1')
      await input.afterStep?.('S1', tx)
      // ---- S2: the adopt row, second.
      enter('S2')
      const plane = await readAdoptPlaneForUpdate(tx, key)
      const refusal = adoptRefusal(plane)
      if (refusal) throw new ShadowVerdict(refusal, 'S2')
      keptTopologyDigest = plane!.topologyDigest
      keptLists = {
        objectShardIds: [...plane!.objectShardIds!],
        connectionShardIds: [...plane!.connectionShardIds!],
        registryShardIds: [...plane!.registryShardIds!],
      }
      if (plane!.orgId !== input.orgId) throw new ShadowVerdict('org', 'S2')
      if (plane!.sealedCeiling !== input.sealedCeiling) {
        throw new ShadowVerdict('sealed-ceiling', 'S2', `${plane!.sealedCeiling} vs ${input.sealedCeiling}`)
      }
      const posture = adoptPostureText(input.posture)
      if (plane!.posture !== posture) throw new ShadowVerdict('posture', 'S2', `${plane!.posture} vs ${posture}`)
      await input.afterStep?.('S2', tx)
      // ---- S3: the protocol digests, recomputed.
      enter('S3')
      const protocol = await adoptProtocolDigests(tx, key)
      if (protocol.retirements !== plane!.retirementsDigest || protocol.folds !== plane!.foldsDigest) {
        throw new ShadowVerdict('protocol-digests', 'S3')
      }
      await input.afterStep?.('S3', tx)
      // ---- S4: the id-set digests, every kind read before any verdict.
      enter('S4')
      const projectedGeneration = Number(state.projected_generation)
      const sealed = (typeof state.content_digest === 'object' && state.content_digest !== null)
        ? state.content_digest as Record<string, unknown>
        : {}
      const kept: Partial<Record<DigestKind, ContentDigest | null>> = {}
      keptDigests = kept
      // A MISMATCH (the ids differ from the seal: an unrecorded writer) is
      // named before a seal that is merely not comparable (absent, or dated
      // to another generation: a maintenance gap), so the two stay apart in
      // the shadow data: `digest-mismatch-<kind>` / `digest-stale-<kind>`.
      const failures: Array<{ kind: DigestKind; outcome: string; text: string }> = []
      for (const kind of DIGEST_KINDS) {
        const actual = parseDigestRow((await tx.query<{ n: string; x: string }>(digestSql(kind),
          [key.landscapeId, key.versionId])).rows[0])
        kept[kind] = actual
        const verdict = verifyDigest(kind, parseStamped(sealed[kind]), actual, projectedGeneration)
        if (verdict.outcome !== 'match') {
          failures.push({ kind, outcome: verdict.outcome, text: `${kind}:${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}` })
        }
      }
      if (failures.length) {
        const mismatch = failures.find((failure) => failure.outcome === 'mismatch')
        const reason = mismatch ? `digest-mismatch-${mismatch.kind}` : `digest-stale-${failures[0]!.kind}`
        throw new ShadowVerdict(reason, 'S4', failures.map((failure) => failure.text).join('; '))
      }
      await input.afterStep?.('S4', tx)
      // ---- S5: every listed shard, classified.
      enter('S5')
      const { rows } = await tx.query<{
        collection: ListedCollection; id: string; position: number; has_watermark: boolean
        projected_heads: string[] | null; status: string | null; origin: string | null
        retirement_heads: string[] | null; forwarded_heads: string[] | null; folded_into: string | null
        is_fold_product: boolean
      }>(LISTED_SHARDS_SQL, [key.landscapeId, key.versionId, plane!.objectShardIds, plane!.connectionShardIds])
      const classification = classifyListedShards(rows.map((row) => ({
        collection: row.collection, documentId: row.id, position: row.position, hasWatermark: row.has_watermark,
        projectedHeads: row.projected_heads, status: row.status, origin: row.origin,
        retirementHeads: row.retirement_heads, forwardedHeads: row.forwarded_heads, foldedInto: row.folded_into,
        isFoldProduct: row.is_fold_product,
      })))
      if (classification.refusal !== null) throw new ShadowVerdict(classification.refusal, 'S5', classification.detail)
      seeds = classification.seeds
      counts = classification.counts
      await input.afterStep?.('S5', tx)
      // SHADOW: nothing is claimed. The sentinel rolls the transaction back.
      if (!claim) throw new ShadowVerdict(null, 'S5')
      // ---- S6 (`on`): the claim, then COMMIT (the helper's).
      enter('S6')
      // A release or a stop during the checks: abandoned as an authority
      // loss, before the CAS writes anything.
      if (!claim.stillClaiming()) throw new ReadModelWriteFenceError(key, claim.instanceId, fence)
      claimIssued = true
      await claimReadModelWriteFence(tx, key, input.orgId, claim.instanceId, fence)
      try {
        await assertReadModelWriteFence(tx, key, claim.instanceId)
      } catch (error) {
        if (error instanceof ReadModelProtocolMarkerError) throw new ShadowVerdict('protocol-marker', 'S6')
        throw error
      }
      await markReadModelProjectorAdopting(tx, key, claim.instanceId)
      await input.afterStep?.('S6', tx)
    })
    if (!claim) return verdictOf('error', 'no-verdict')
    claimed = true
    return verdictOf('claimed', null)
  } catch (error) {
    if (error instanceof ShadowVerdict) {
      return verdictOf(error.reason === null ? 'adoptable' : 'refused', error.reason, error.detail)
    }
    // `on`: an authority loss at S6 (the release check, the CAS) is thrown,
    // as a cold build's is; so is a failure after S6's statements ran (the
    // COMMIT: whether the fence moved is unknown).
    if (claim && !claimed && isReadModelAuthorityLoss(error)) throw error
    if (claim && claimIssued) throw new AdoptClaimOutcomeUnknownError(key, error)
    const e = error as { code?: unknown; name?: unknown; message?: unknown }
    const reason = typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'error'
    return verdictOf('error', reason, String(e?.message ?? error).slice(0, 300))
  }
}

// ------------------------------------------- THE BACKGROUND ATTACH (C6-2a)

export type AdoptAttachStage = 'B1' | 'B2' | 'B3' | 'B4' | 'B5'

/**
 * An adopting attach (B1-B5, `projectorService.ts`) that failed after its
 * claim committed. `aborted`: the attach was released, stopped, disowned or
 * lost its fence while it ran; any other reason is the attach's own
 * failure (`topology-moved`, `seed-heads-unknown`, `gap-failed`, …). Either
 * way the F4 cleanup ran and the row is left `projector_attached = false`;
 * the adopt row is still bound to the PREVIOUS fence — unless B5's own
 * commit landed and only its acknowledgement was lost, when it is bound to
 * this instance (a later adopt of it is then legitimate) — so the next
 * attach's precheck refuses it (`fence-moved`) and cold-builds: no adopt
 * loop. The fleet does that cold build at once (`ProjectorFleet.start`).
 */
export class ReadModelAdoptAttachError extends Error {
  constructor(readonly stage: AdoptAttachStage, readonly reason: string, options?: { cause?: unknown }) {
    super(`read-model adopt attach failed at ${stage}: ${reason}`, options)
    this.name = 'ReadModelAdoptAttachError'
  }
}

// ------------------------------------------------ THE SEED (C6-2a, B2/B3)

/** A seed head the document's history does not have: the attach fails. */
export class AdoptSeedHeadsUnknownError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`adopt seed: ${missing.length} seed head(s) absent from the document's history (${missing.slice(0, 3).join(',')})`)
    this.name = 'AdoptSeedHeadsUnknownError'
  }
}

/** Sorted-set equality of two head lists. */
export function seedHeadsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((head, index) => head === y[index])
}

/**
 * The content a seed's rows were projected from: `doc` AT `heads`. Pure.
 *  - live heads equal to `heads` (as sets): the live document itself (an
 *    immutable revision; `atLive: true`), no copy;
 *  - otherwise every head must be in the document's history (`hasHeads`),
 *    else {@link AdoptSeedHeadsUnknownError}: `view` with heads it does not
 *    know returns an EMPTY document without a word, and an empty seed would
 *    leave every stale row in place for ever (the gap delta deletes only
 *    what the seed held). Then `view(doc, heads)`, still an Automerge view:
 *    the caller copies what it keeps.
 */
export function adoptSeedContent(doc: Doc<unknown>, heads: readonly string[]): { content: Doc<unknown>; atLive: boolean } {
  if (seedHeadsEqual(getHeads(doc), heads)) return { content: doc, atLive: true }
  if (!hasHeads(doc, [...heads])) {
    throw new AdoptSeedHeadsUnknownError(heads.filter((head) => !hasHeads(doc, [head])))
  }
  return { content: viewDoc(doc, [...heads]), atLive: false }
}

/** The entity map (`objects` / `connections`) of {@link adoptSeedContent},
 * as the watcher's baseline: the live map itself at live heads (as the cold
 * build's extraction hands it), a plain copy of the view's otherwise. Null:
 * the field is absent or not a map at the seed heads — the attach fails
 * rather than seed `{}`. */
export function adoptSeedMap(doc: Doc<unknown>, heads: readonly string[], field: 'objects' | 'connections'): Record<string, unknown> | null {
  const { content, atLive } = adoptSeedContent(doc, heads)
  const value = (content as Record<string, unknown>)[field]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return atLive ? value as Record<string, unknown> : JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

// ---------------------------------------------------- AFTER THE COLD BUILD

/** The seed heads of `seeds` against the heads the cold build just recorded
 * (`read_model_document_watermarks.projected_heads`, written in the build's
 * transaction from what it sampled): how many listed shards an adopter
 * would have had to catch up (`differ`) or could not compare (`unknown`: no
 * row, or NULL heads, after the build). `new` shards are not counted.
 * Heads compared as sets (sorted). */
export async function seedHeadsAgainstBuild(
  db: Queryable,
  key: WorkspaceKey,
  seeds: readonly ShardSeed[],
): Promise<{ compared: number; differ: number; unknown: number }> {
  const seeded = seeds.filter((seed) => seed.source !== 'new')
  if (!seeded.length) return { compared: 0, differ: 0, unknown: 0 }
  const { rows } = await db.query<{ id: string; heads: string[] | null }>(
    `SELECT document_id AS id, projected_heads AS heads FROM read_model_document_watermarks
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, seeded.map((seed) => seed.documentId)],
  )
  const built = new Map(rows.map((row) => [row.id, row.heads]))
  const sorted = (heads: readonly string[]) => JSON.stringify([...heads].sort())
  let differ = 0
  let unknown = 0
  for (const seed of seeded) {
    const heads = built.get(seed.documentId)
    if (heads === undefined || heads === null) unknown += 1
    else if (sorted(heads) !== sorted(seed.heads!)) differ += 1
  }
  return { compared: seeded.length - unknown, differ, unknown }
}
