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
 * THE ADOPT PLANE (G4-16f): the facts a later attach would need to keep the
 * read model a previous owner left instead of rebuilding it. Since C6-1 the
 * verifier (`adoptVerify.ts`) reads these rows, in SHADOW mode only: it logs
 * a verdict and the attach cold-builds regardless. BUT since T-SUM-2c the
 * DURABILITY WITNESS reads `adopt_watermark` (`health.ts`,
 * `DOCUMENT_ARRIVAL_BRANCH_SQL`): a positive value at or above a control
 * document's newest arrival LIFTS `absenceProvable` for it, which the
 * client's replay acts on. So a positive value must keep meaning "every
 * arrival up to it is in rows a committed pass wrote". The one documented way
 * it can sit beside rows of a later revision (a failed refusal savepoint,
 * below) lifts nothing the timestamp branch would not lift in the same state:
 * that revision's save, if it lands, mints an arrival above the value. To
 * the witness a 0 is NO EVIDENCE (it falls to the timestamp), never a
 * refusal; to a future verifier it is a refusal.
 *
 *  - `read_model_adopt_watermarks`: per CONTROL document (root, ModelMeta,
 *    registry shards, a monolith model) the arrival watermark its projected
 *    content is certified up to — EXACT or 0, like
 *    `recordSampledDocumentWatermarks`: the prepared `watermarkPost` only
 *    when every sample of the document equals both its durable heads and its
 *    current runtime heads, otherwise 0 (a stored refusal). Never monotone: a
 *    previous positive value does not certify what THIS transaction wrote.
 *    A separate table so these documents never REFUSE through the exact
 *    freshness branch of `read_model_document_watermarks` (their handlers do
 *    not re-stamp every write, so a refusal there could be permanent); since
 *    T-SUM-2c the witness's adopt branch reads it, and only ever LIFTS.
 *  - `read_model_adopt_state`: one row per workspace — the projection
 *    format, the org, the TOPOLOGY digest, the PROTOCOL digests and the
 *    defect count of the cold build; since C6b also the fence binding, the
 *    topology as id lists, the seal and the posture
 *    (`ADOPT_STATE_VERSION`).
 *
 * THE TOPOLOGY DIGEST is root's model references and registry list plus
 * ModelMeta's shard lists AS THE LAST COLD BUILD, METADATA OR REGISTRY PASS
 * READ THEM (`adoptTopologyDigest`). It is NOT "the topology the rows were
 * built from": the metadata pass writes it before the shards it newly lists
 * are attached and projected (they attach after the pass, through
 * `rememberShardReferences` / the shard watchers), so a matching topology
 * says which documents the read model is MEANT to cover, never that it
 * covers them. A verifier must check each listed document's own watermark
 * (`read_model_document_watermarks` for shards, the adopt watermarks above
 * for control documents), never treat a topology match as coverage.
 *
 * THE PROTOCOL DIGESTS (`retirements_digest`, `folds_digest`) are
 * maintained BY THE DATABASE, in the transaction of every statement that
 * changes `read_model_ordinary_head_retirements` or
 * `read_model_ordinary_chain_folds` (the statement triggers
 * `ensureAdoptProtocolTriggers` installs, `schema.ts`): every writer — the
 * rotator, the compaction settle, the forwarder, the folded-arrival poll,
 * the fold record, its abandon and its sweep, and any writer added later —
 * leaves a row whose digests equal the tables at its commit, with no call
 * site to remember. They are computed by ONE function,
 * `read_model_adopt_protocol_digests`, which the cold build's row and a
 * verifier read too. What they certify, and what they do NOT:
 *  - stored == recomputed means no committed change of those tables
 *    bypassed the triggers (a restore or a replica with triggers disabled
 *    would not keep them); a verifier refuses on a mismatch;
 *  - read once when a verifier starts and again inside the transaction that
 *    claims the fence, an unchanged value means the old owner committed no
 *    protocol write between the two reads;
 *  - NOT that the `ro_*` rows reflect the protocol plane. No protocol write
 *    is atomic with an `ro_*` row: every consequence of one reaches the rows
 *    through a DOCUMENT — a fold's ModelMeta splice, a forward's write into
 *    the current head, a folded arrival forwarded the same way — so it is
 *    covered by that document's watermark or by nothing. A verifier must
 *    also check, from the rows themselves, that no retired head has late
 *    writes past `forwarded_heads ?? H_r` (`ordinaryHeadLateWritesPending`)
 *    and that no folded head has an arrival past its `arrival_watermark`.
 *
 * WHY A DIGEST, NOT A GENERATION COUNTER (or the adopt row's `xmin`). A
 * counter bumped by the same triggers, or the row version, proves the second
 * property above — nothing committed between two reads — at O(1). It cannot
 * prove the first: a write that bypassed the triggers (a restore or a
 * replica with them disabled, `session_replication_role = replica`) moves no
 * counter, and only a value RECOMPUTABLE from the tables lets a verifier see
 * that the rows are not the ones the row was kept over. The price, measured
 * at the aged corpus' shape (470 retirement rows, 426 fold rows;
 * `qa/g416f-trigger-cost.mts`): the digest costs
 * ~1.3-1.4 ms per protocol STATEMENT (a one-statement forward 0.24 ->
 * 1.55 ms, median), linear in the workspace's protocol rows. So every
 * multi-row protocol write is ONE statement: the fold record's sources
 * (8 sources 15.4 -> 5.5 ms) and the detach's watermarks (8 heads 12.0 ->
 * 1.6 ms) and the compaction settle's segments (at the aged shape, 426
 * products and the current head: ~840 -> ~7.8 ms, `workspaceCompaction.ts`).
 * Not batched: the folded-arrival poll's per-head advances (one statement
 * per transaction, each after its own forward).
 *
 * THE LOCK ORDER: the workspace's `read_model_projection_state` row (the
 * fence row), then its protocol rows, then its adopt row. Two halves:
 *  - the adopt row is only ever written while the fence row is held: the
 *    triggers' re-stamp takes it first, and so does `withAdoptSavepoint`
 *    for the projector's own adopt writes (a metadata pass holding the adopt
 *    row while waiting for the fence row, against a fold holding the fence
 *    row while its trigger waits for the adopt row, would deadlock);
 *  - a protocol row is only ever written by a transaction that ALREADY holds
 *    the fence row (a writer holding a retirement row while waiting for the
 *    fence row, against a fold holding the fence row and wanting that
 *    retirement row, would deadlock). This half is ENFORCED, not followed:
 *    `assertReadModelWriteFence` (`health.ts`) records the row it locks in
 *    a transaction-local setting in the same statement, and the protocol
 *    tables' statement trigger RAISES on a write to a workspace whose row
 *    this transaction has not taken that way — at the misordered statement,
 *    every time, contended or not (`schema.ts`, `ADOPT_PROTOCOL_TOUCHED_BODY`;
 *    `adoptState.integration.test.ts`, LOCK ORDER 2-4). No call site can
 *    omit or misplace it and still write: the projector's `commit`,
 *    `commitFoldedArrival`, `commitDetachedWatermarks` and deferred stamps,
 *    the rotator, the fold writer's record/abandon/sweep and the compaction
 *    settle each take it as their first statement after the plane check.
 *    What the enforcement does NOT cover, by design or by construction:
 *     - only WRITES are checked (the trigger fires on INSERT, UPDATE,
 *       DELETE). A `SELECT … FOR UPDATE / FOR SHARE` of protocol rows taken
 *       before the fence row is the same misorder and is not detected; no
 *       such read exists today (the protocol readers lock nothing);
 *     - a workspace with no fence row at all is not checked (nothing to
 *       order against; no production writer writes there, its fence
 *       assertion fails closed) — including one whose row its own
 *       transaction deleted before the write;
 *     - a TRUNCATE of a protocol table is admitted unfenced (it re-stamps
 *       every adopt row; tests only);
 *     - a connection whose participant VERSION (`protocolParticipant.ts`:
 *       the marker as an integer, 0 when absent or not a number) is below
 *       2 — a process of a version that does not know the protocol, the
 *       previous release, during a rolling deploy or after a rollback — is not
 *       checked at all: its digests are kept and nothing of it is refused.
 *       A higher version is checked. Every pool of this version marks its
 *       connections (`guardIdleClientErrors`), so a writer of this version
 *       that omits the fence is still refused, and one whose connection
 *       LOST its marker (a session reset) is refused by its own fence
 *       assertion (`ReadModelProtocolMarkerError`). The residual is a 40P01
 *       between a previous-release writer and one of this version, inside the
 *       window only (`schema.ts`, the release note on `ensureAdoptProtocolTriggers`);
 *     - test fixtures that seed rows by hand mark their transaction with
 *       the wildcard (`testing/protocolFixture.ts`), bound to that
 *       transaction's id so no role, database or session setting can preset
 *       it, and which no production module or `qa/` harness may name (LOCK
 *       ORDER 4, a source scan).
 *
 * A TRIGGER FAILURE ABORTS THE PROTOCOL WRITE IT RIDES ON. The digests (and
 * the lock-order check) run inside the statement that changed the protocol
 * rows, so their failure — the check's refusal, a missing function or table,
 * a lock timeout on the fence or adopt row — fails that statement and, with
 * it, the rotation, fold, forward or watermark advance's transaction.
 * `withAdoptSavepoint`'s "never fails the projection" covers only the
 * projector's OWN adopt writes (the cold build's row, the watermarks,
 * the topology), never this trigger work. Fail-safe in the sense that
 * nothing half-written commits; not free: a broken trigger stops every
 * protocol writer of the database until it is repaired.
 *
 * Every projector write goes through the caller's FENCED projection
 * transaction: a rolled-back projection leaves no adopt row behind. A stale
 * watermark can only make a future verifier refuse (and cold-build): the
 * watermarks are exact.
 */

import { createHash } from 'node:crypto'
import { headsEqual, type PreparedDocumentWatermarks } from './arrivalWatermark.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { readMetaUrlView } from '../modelMetaUrls.js'

/** The shape of what the ordinary projection writes. Bump it when a change
 * makes rows (or cached extracts) written before it unusable as they are:
 * every reader compares it with its own. */
export const PROJECTION_FORMAT_VERSION = 1

/**
 * THE ADOPT PLANE'S OWN VERSION (G4-16f C6b), apart from
 * {@link PROJECTION_FORMAT_VERSION} on purpose: the sealed-product extract
 * cache is keyed by the projection version (`sealedProductCache.ts`), so
 * bumping that one to retire adopt rows would also throw away every cached
 * extract. A row whose `adopt_version` is not this one — NULL on every row
 * written before C6b — is not adoptable ({@link adoptRefusal}).
 *
 * Version 2 adds, on `read_model_adopt_state`:
 *  - `fence_binding`: the write fence the row was written under (THE FENCE
 *    BINDING, below);
 *  - the topology as ID LISTS (`root_document_id`, `meta_document_id`,
 *    `object_shard_ids`, `connection_shard_ids`, `registry_shard_ids`;
 *    order and duplicates kept, in the statement that writes the digest), so
 *    a verifier can name every listed document without loading ModelMeta;
 *  - `sealed_ceiling` and `posture`: the seal and the projector posture the
 *    rows were built under;
 * and on `read_model_document_watermarks`, `projected_heads`
 * (`arrivalWatermark.ts`).
 *
 * THE FENCE BINDING (an invariant of the adopt protocol): `fence_binding = F`
 * is only ever written by {@link bindAdoptFence}, which locks the fence row
 * and refuses unless `write_fence = F` IN THE WRITING TRANSACTION. Fence
 * values are unique (a projector's `randomUUID`, a lifecycle value minted per
 * transition, `health.ts`), and every ordinary claim of the fence is a cold
 * build. So `fence_binding = write_fence` means the fence has not moved since
 * the row was bound: every fenced write since was made by the binder itself.
 * Any other process that wrote — the previous release, an older build that
 * does not maintain these columns, a lifecycle transition — had to
 * claim the fence first, which leaves the binding behind. A row whose
 * binding is NULL is never adoptable.
 *
 * What the binding does NOT cover: a write made WITHOUT the fence. The
 * ordinary projector writes nothing unfenced (`runTracked`), but the
 * `ro_*` plane has other writers (`derivedStats` inside projections, the
 * static plane behind its lifecycle fence, `performanceSeed` as a tool) and
 * a hand edit is a hand edit; a verifier still checks the rows themselves
 * (the content digests) and does not read a binding as a content proof.
 */
export const ADOPT_STATE_VERSION = 2

/**
 * Run adopt writes inside the caller's projection transaction under a
 * SAVEPOINT, so a failure among them (a constraint, a table the digest
 * cannot read) rolls back THEM and never the projection they ride on — the
 * same rule as the integrity stamp in `runTracked`. A missing or rolled-back
 * row refuses a future adopt and, to the durability witness (T-SUM-2c),
 * leaves the timestamp to decide — never a wrong lift. The protocol triggers'
 * work is NOT under it (it rides on the protocol write, header: A TRIGGER
 * FAILURE ABORTS THE PROTOCOL WRITE IT RIDES ON).
 *
 * Inside the savepoint and before `write`, the workspace's
 * `read_model_projection_state` row is taken FOR UPDATE (THE LOCK ORDER in
 * the header): the transaction holds it to its commit anyway (its fence
 * assertion), so this only moves the acquisition before the adopt row.
 *
 * Returns whether the writes are kept. A failure is logged; if the rollback
 * to the savepoint fails too, the ORIGINAL failure is logged first and the
 * rollback's is thrown (the transaction is then unusable, and the caller's
 * rollback must see it).
 */
export async function withAdoptSavepoint(tx: Queryable, key: WorkspaceKey, write: () => Promise<void>): Promise<boolean> {
  await tx.query('SAVEPOINT read_model_adopt')
  try {
    await tx.query(
      `SELECT 1 FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
      [key.landscapeId, key.versionId],
    )
    await write()
  } catch (error) {
    try {
      await tx.query('ROLLBACK TO SAVEPOINT read_model_adopt')
    } catch (rollbackError) {
      console.error('[read-model] adopt bookkeeping failed, and so did its rollback to the savepoint', error)
      throw rollbackError
    }
    await tx.query('RELEASE SAVEPOINT read_model_adopt')
    console.error('[read-model] adopt bookkeeping failed; projection kept', error)
    return false
  }
  await tx.query('RELEASE SAVEPOINT read_model_adopt')
  return true
}

export interface AdoptSample {
  documentId: string
  /** Heads of the revision the projection read; null refuses. */
  sampledHeads: readonly string[] | null
  /** Heads of the live document at the stamp; null refuses. */
  readCurrentHeads: () => readonly string[] | null
}

/** Write exact-or-0 adopt watermarks for `samples` (a document sampled more
 * than once is certified only when every sample agrees). Returns the ids
 * certified positive. */
export async function recordAdoptWatermarks(
  tx: Queryable,
  key: WorkspaceKey,
  samples: readonly AdoptSample[],
  prepared: PreparedDocumentWatermarks,
): Promise<Set<string>> {
  const stableById = new Map<string, boolean>()
  for (const sample of samples) {
    if (!sample.documentId) continue
    const durable = prepared.durableHeadsById.get(sample.documentId)
    const current = sample.readCurrentHeads()
    const stable = sample.sampledHeads !== null && current !== null && durable !== undefined
      && headsEqual(sample.sampledHeads, current) && headsEqual(sample.sampledHeads, durable)
    stableById.set(sample.documentId, (stableById.get(sample.documentId) ?? true) && stable)
  }
  const certified = new Set<string>()
  if (!stableById.size) return certified
  // Sorted: every writer takes the row locks in the same order.
  const ids = [...stableById.keys()].sort()
  const watermarks = ids.map((id) => (stableById.get(id) ? prepared.watermarkPost : '0'))
  await writeAdoptWatermarks(tx, key, ids, watermarks)
  for (const [at, id] of ids.entries()) if (watermarks[at] !== '0') certified.add(id)
  return certified
}

/** Write 0 — a stored refusal — for `documentIds`: what a delta pass does
 * IN ITS OWN TRANSACTION for every control document whose projected
 * revision is no longer the one its positive certificate names, so no
 * positive value outlives the rows it described — unless this write's own
 * savepoint fails, the case `projectorService.ts` (THE DELTA PASSES' ADOPT
 * STAMPS) states. The exact value follows off the pass (the projector's
 * deferred adopt stamps). */
export async function refuseAdoptWatermarks(tx: Queryable, key: WorkspaceKey, documentIds: readonly string[]): Promise<void> {
  const ids = [...new Set(documentIds)].sort()
  if (ids.length) await writeAdoptWatermarks(tx, key, ids, ids.map(() => '0'))
}

async function writeAdoptWatermarks(tx: Queryable, key: WorkspaceKey, ids: readonly string[], watermarks: readonly string[]): Promise<void> {
  await tx.query(
    `INSERT INTO read_model_adopt_watermarks (landscape_id, version_id, document_id, adopt_watermark)
     SELECT $1, $2, doc.id, doc.w::bigint
     FROM unnest($3::text[], $4::text[]) AS doc(id, w)
     ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
     SET adopt_watermark = EXCLUDED.adopt_watermark, updated_at = now()`,
    [key.landscapeId, key.versionId, ids, watermarks],
  )
}

interface RootTopology { modelMetaUrl?: unknown; modelUrl?: unknown; shardUrls?: unknown }
interface MetaTopology {
  objectShardUrls?: unknown
  connectionShardUrls?: unknown
  editsObjectShardUrl?: unknown
  editsObjectShardUrls?: unknown
  editsConnectionShardUrl?: unknown
  editsConnectionShardUrls?: unknown
}

const listOf = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.map((item) => String(item)) : null
const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** sha256 over the root's model references and registry shard list, and
 * ModelMeta's object/connection shard lists (order AND duplicates kept: the
 * merge is last-wins over the list as written) and write-head urls. */
export function adoptTopologyDigest(root: RootTopology | undefined, raw: MetaTopology | undefined): string {
  // The ruling URL fields as strings — the same digest whichever field
  // rules, since the cut-over mirrors the old values exactly.
  const meta: MetaTopology | undefined = raw ? readMetaUrlView(raw) : undefined
  return createHash('sha256').update(JSON.stringify([
    stringOf(root?.modelMetaUrl), stringOf(root?.modelUrl), listOf(root?.shardUrls),
    listOf(meta?.objectShardUrls), listOf(meta?.connectionShardUrls),
    stringOf(meta?.editsObjectShardUrl), listOf(meta?.editsObjectShardUrls),
    stringOf(meta?.editsConnectionShardUrl), listOf(meta?.editsConnectionShardUrls),
  ])).digest('hex')
}

/** The workspace's protocol digests as the tables hold them now, read in
 * `tx` through `read_model_adopt_protocol_digests` (`schema.ts`), the one
 * definition the triggers and the cold build use too. */
export async function adoptProtocolDigests(
  tx: Queryable,
  key: WorkspaceKey,
): Promise<{ retirements: string; folds: string }> {
  const { rows } = await tx.query<{ retirements: string; folds: string }>(
    'SELECT retirements, folds FROM read_model_adopt_protocol_digests($1, $2)',
    [key.landscapeId, key.versionId],
  )
  return { retirements: rows[0]!.retirements, folds: rows[0]!.folds }
}

/** A document id from an Automerge url as the lists hold it (the prefix and
 * any query dropped), the same rule the projector's `documentIdOf` uses. */
const documentIdOfReference = (url: string): string => url.replace(/^automerge:/, '').split('?')[0]!
const idListOf = (value: unknown): string[] | null => listOf(value)?.map(documentIdOfReference) ?? null

/** The topology one pass read, as the DIGEST and as ID LISTS — built from the
 * SAME two objects by one call, so a row can never carry a digest of one
 * read and the lists of another. Lists keep the order and the duplicates of
 * the documents (the merge is last-wins over the list as written; a
 * verifier refuses a duplicate, it must be able to see one). A list the
 * document does not carry (no ModelMeta, a monolith, no `shardUrls`) is
 * null, never empty. */
export interface AdoptTopology {
  digest: string
  rootDocumentId: string | null
  metaDocumentId: string | null
  objectShardIds: string[] | null
  connectionShardIds: string[] | null
  registryShardIds: string[] | null
}

export function adoptTopology(
  rootDocumentId: string | null,
  root: RootTopology | undefined,
  raw: MetaTopology | undefined,
): AdoptTopology {
  const metaUrl = stringOf(root?.modelMetaUrl)
  const meta: MetaTopology | undefined = raw ? readMetaUrlView(raw) : undefined
  return {
    digest: adoptTopologyDigest(root, raw),
    rootDocumentId,
    metaDocumentId: metaUrl ? documentIdOfReference(metaUrl) : null,
    objectShardIds: idListOf(meta?.objectShardUrls),
    connectionShardIds: idListOf(meta?.connectionShardUrls),
    registryShardIds: idListOf(root?.shardUrls),
  }
}

/** How the projector that built the rows was configured, as far as an
 * adopter must match it: whether it rotates write heads, folds chains,
 * parks sealed products and writes the extract cache. */
export interface AdoptPosture {
  rotation: boolean
  fold: boolean
  parking: boolean
  extractCache: boolean
}

/** The canonical text of a posture: what `posture` stores and what an
 * adopter compares, by equality, with its own. */
export function adoptPostureText(posture: AdoptPosture): string {
  const flag = (on: boolean) => (on ? 'on' : 'off')
  return `rotation=${flag(posture.rotation)};fold=${flag(posture.fold)};parking=${flag(posture.parking)};cache=${flag(posture.extractCache)}`
}

/** The cold build's row: every field, the protocol digests computed in the
 * same statement. Inside `withAdoptSavepoint` (the fence row held), so no
 * protocol writer can commit between the digests and this transaction's
 * commit; after it, the triggers keep them.
 *
 * `fence_binding` is written NULL here, whatever the row held: a binding
 * left over from an earlier owner must not survive a rewrite of the row it
 * described. {@link bindAdoptFence} sets it, after the build's claim, as the
 * last write of the same savepoint (`projectorService.ts`, the cold build),
 * so a binding exists only beside the row this transaction wrote. */
export async function writeAdoptState(
  tx: Queryable,
  key: WorkspaceKey,
  state: {
    orgId: string | null
    topology: AdoptTopology
    defects: number
    sealedCeiling: number
    posture: AdoptPosture
  },
): Promise<void> {
  const { topology } = state
  await tx.query(
    `INSERT INTO read_model_adopt_state (landscape_id, version_id, format_version, org_id,
       topology_digest, retirements_digest, folds_digest, defects,
       adopt_version, fence_binding, root_document_id, meta_document_id,
       object_shard_ids, connection_shard_ids, registry_shard_ids, sealed_ceiling, posture)
     SELECT $1, $2, $3, $4, $5, digests.retirements, digests.folds, $6,
            $7, NULL, $8, $9, $10::text[], $11::text[], $12::text[], $13, $14
       FROM read_model_adopt_protocol_digests($1, $2) AS digests
     ON CONFLICT (landscape_id, version_id) DO UPDATE
     SET format_version = EXCLUDED.format_version, org_id = EXCLUDED.org_id,
         topology_digest = EXCLUDED.topology_digest, retirements_digest = EXCLUDED.retirements_digest,
         folds_digest = EXCLUDED.folds_digest, defects = EXCLUDED.defects,
         adopt_version = EXCLUDED.adopt_version, fence_binding = NULL,
         root_document_id = EXCLUDED.root_document_id, meta_document_id = EXCLUDED.meta_document_id,
         object_shard_ids = EXCLUDED.object_shard_ids, connection_shard_ids = EXCLUDED.connection_shard_ids,
         registry_shard_ids = EXCLUDED.registry_shard_ids, sealed_ceiling = EXCLUDED.sealed_ceiling,
         posture = EXCLUDED.posture, updated_at = now()`,
    [key.landscapeId, key.versionId, PROJECTION_FORMAT_VERSION, state.orgId, topology.digest, state.defects,
      ADOPT_STATE_VERSION, topology.rootDocumentId, topology.metaDocumentId,
      topology.objectShardIds, topology.connectionShardIds, topology.registryShardIds,
      state.sealedCeiling, adoptPostureText(state.posture)],
  )
}

/** A delta pass's topology: an UPDATE only — no row (a workspace built
 * before this table) stays no row, which only a cold build writes. The
 * digest and the id lists in ONE statement, from one {@link adoptTopology}. */
export async function updateAdoptTopology(tx: Queryable, key: WorkspaceKey, topology: AdoptTopology): Promise<void> {
  await tx.query(
    `UPDATE read_model_adopt_state
        SET topology_digest = $3, root_document_id = $4, meta_document_id = $5,
            object_shard_ids = $6::text[], connection_shard_ids = $7::text[], registry_shard_ids = $8::text[],
            updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId, topology.digest, topology.rootDocumentId, topology.metaDocumentId,
      topology.objectShardIds, topology.connectionShardIds, topology.registryShardIds],
  )
}

/** Refused: the transaction asked to bind a fence it does not hold. */
export class AdoptFenceBindingError extends Error {
  constructor(key: WorkspaceKey, fence: string, held: string | null) {
    super(`adopt fence binding refused for ${key.landscapeId}/${key.versionId}: `
      + `the write fence is ${held ?? 'absent'}, not ${fence}`)
    this.name = 'AdoptFenceBindingError'
  }
}

/**
 * Bind the workspace's adopt row to `fence` (THE FENCE BINDING, on
 * {@link ADOPT_STATE_VERSION}): the ONLY writer of a non-NULL
 * `fence_binding`. First statement: the fence row, `FOR UPDATE` (THE LOCK
 * ORDER: fence row, then adopt row), read in THIS transaction — so a claim
 * this transaction made is seen, and nobody can move the fence until it
 * commits. Throws {@link AdoptFenceBindingError} unless it holds `fence`;
 * nothing is written then. Returns whether a row was bound (false: no adopt
 * row, e.g. its own savepoint rolled it back).
 *
 * The cold build calls it after its claim, in the claim's transaction; an
 * attach that adopts (C6) calls it when its attach completes, under its
 * fence assertion.
 */
export async function bindAdoptFence(tx: Queryable, key: WorkspaceKey, fence: string): Promise<boolean> {
  const { rows } = await tx.query<{ write_fence: string | null }>(
    `SELECT write_fence FROM read_model_projection_state
      WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
    [key.landscapeId, key.versionId],
  )
  const held = rows[0]?.write_fence ?? null
  if (held !== fence) throw new AdoptFenceBindingError(key, fence, held)
  const result = await tx.query(
    `UPDATE read_model_adopt_state SET fence_binding = $3, updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId, fence],
  )
  return (result.rowCount ?? 0) === 1
}

/** The adopt row's v2 columns beside the workspace's current write fence,
 * as one statement reads them. Absent: no adopt row. */
export interface AdoptPlaneRow {
  formatVersion: number
  adoptVersion: number | null
  fenceBinding: string | null
  writeFence: string | null
  rootDocumentId: string | null
  metaDocumentId: string | null
  objectShardIds: string[] | null
  connectionShardIds: string[] | null
  registryShardIds: string[] | null
  sealedCeiling: number | null
  posture: string | null
  defects: number
}

/** Read the adopt row with the fence (no lock: a verifier that acts on it
 * re-reads under its own locks). */
export async function readAdoptPlane(db: Queryable, key: WorkspaceKey): Promise<AdoptPlaneRow | undefined> {
  const { rows } = await db.query<{
    format_version: number; adopt_version: number | null; fence_binding: string | null; write_fence: string | null
    root_document_id: string | null; meta_document_id: string | null; object_shard_ids: string[] | null
    connection_shard_ids: string[] | null; registry_shard_ids: string[] | null; sealed_ceiling: number | null
    posture: string | null; defects: number
  }>(
    `SELECT adopt.format_version, adopt.adopt_version, adopt.fence_binding, fence.write_fence,
            adopt.root_document_id, adopt.meta_document_id, adopt.object_shard_ids,
            adopt.connection_shard_ids, adopt.registry_shard_ids, adopt.sealed_ceiling, adopt.posture,
            adopt.defects
       FROM read_model_adopt_state AS adopt
       LEFT JOIN read_model_projection_state AS fence
         ON fence.landscape_id = adopt.landscape_id AND fence.version_id = adopt.version_id
      WHERE adopt.landscape_id = $1 AND adopt.version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    formatVersion: row.format_version, adoptVersion: row.adopt_version, fenceBinding: row.fence_binding,
    writeFence: row.write_fence, rootDocumentId: row.root_document_id, metaDocumentId: row.meta_document_id,
    objectShardIds: row.object_shard_ids, connectionShardIds: row.connection_shard_ids,
    registryShardIds: row.registry_shard_ids, sealedCeiling: row.sealed_ceiling, posture: row.posture,
    defects: row.defects,
  }
}

/** {@link AdoptPlaneRow} plus what only a verifier inside its claim
 * transaction compares: the org, the topology digest and the stored protocol
 * digests. */
export interface AdoptPlaneRowForUpdate extends AdoptPlaneRow {
  orgId: string | null
  topologyDigest: string
  retirementsDigest: string
  foldsDigest: string
}

/** The adopt row with the fence, the adopt row taken `FOR UPDATE` (the fence
 * row is NOT locked by this statement: THE LOCK ORDER puts the fence row
 * first, so the caller must already hold it — `adoptVerify.ts` takes it in
 * the statement before). Absent: no adopt row. */
export async function readAdoptPlaneForUpdate(tx: Queryable, key: WorkspaceKey): Promise<AdoptPlaneRowForUpdate | undefined> {
  const { rows } = await tx.query<{
    format_version: number; adopt_version: number | null; fence_binding: string | null; write_fence: string | null
    root_document_id: string | null; meta_document_id: string | null; object_shard_ids: string[] | null
    connection_shard_ids: string[] | null; registry_shard_ids: string[] | null; sealed_ceiling: number | null
    posture: string | null; defects: number; org_id: string | null; topology_digest: string
    retirements_digest: string; folds_digest: string
  }>(
    `SELECT adopt.format_version, adopt.adopt_version, adopt.fence_binding, fence.write_fence,
            adopt.root_document_id, adopt.meta_document_id, adopt.object_shard_ids,
            adopt.connection_shard_ids, adopt.registry_shard_ids, adopt.sealed_ceiling, adopt.posture,
            adopt.defects, adopt.org_id, adopt.topology_digest, adopt.retirements_digest, adopt.folds_digest
       FROM read_model_adopt_state AS adopt
       LEFT JOIN read_model_projection_state AS fence
         ON fence.landscape_id = adopt.landscape_id AND fence.version_id = adopt.version_id
      WHERE adopt.landscape_id = $1 AND adopt.version_id = $2
      FOR UPDATE OF adopt`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    formatVersion: row.format_version, adoptVersion: row.adopt_version, fenceBinding: row.fence_binding,
    writeFence: row.write_fence, rootDocumentId: row.root_document_id, metaDocumentId: row.meta_document_id,
    objectShardIds: row.object_shard_ids, connectionShardIds: row.connection_shard_ids,
    registryShardIds: row.registry_shard_ids, sealedCeiling: row.sealed_ceiling, posture: row.posture,
    defects: row.defects, orgId: row.org_id, topologyDigest: row.topology_digest,
    retirementsDigest: row.retirements_digest, foldsDigest: row.folds_digest,
  }
}

/** Why a row read by {@link readAdoptPlane} cannot be adopted on the
 * plane's own terms, or null. The FIRST reason in this order; a NULL is
 * always a refusal (a row written before C6b has NULL in every v2 column).
 * Not the whole verification: the protocol and content digests, the
 * watermarks and the posture an adopter compares with ITS OWN are C6's. */
export function adoptRefusal(row: AdoptPlaneRow | undefined): string | null {
  if (!row) return 'no-adopt-row'
  if (row.formatVersion !== PROJECTION_FORMAT_VERSION) return 'format-version'
  if (row.adoptVersion !== ADOPT_STATE_VERSION) return 'adopt-version'
  if (row.fenceBinding === null) return 'fence-unbound'
  if (row.writeFence === null || row.fenceBinding !== row.writeFence) return 'fence-moved'
  if (row.rootDocumentId === null || row.metaDocumentId === null || row.objectShardIds === null
    || row.connectionShardIds === null || row.registryShardIds === null) return 'topology-lists'
  if (row.sealedCeiling === null || row.posture === null) return 'posture'
  // LOAD-BEARING: a shard the cold build read with a defect is listed but
  // not re-stamped (`projectorService.ts`, `sampledShards` drops defected
  // ids), so its `read_model_document_watermarks` row may still carry an
  // EARLIER build's watermark and heads for rows this build deleted. Only
  // a cold build writes `defects`; any defect refuses until the next one.
  if (row.defects !== 0) return 'defects'
  return null
}
