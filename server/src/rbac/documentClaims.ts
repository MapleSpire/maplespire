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

/**
 * Claim-at-write: the batch SQL core.
 *
 * Single owner of the claim statement shape: the walk (`flushLeafClaims` in
 * docScope.ts), the bootstrap publishers (landscapes/orgSeed/provisioning), the
 * seeds and the repair paths all record document→workspace assignments through
 * this function, so a fix to the SQL is the fix everywhere. Takes a `Queryable`
 * rather than the pool: bootstrap sites run it inside their own transaction
 * (versions row + claims + coverage marker commit or vanish together), and the
 * DB-gated suites run it under `isolatedSchema.ts`.
 */

/**
 * Versioned "claims-at-write" contract. Stored in `workspace_claim_coverage.
 * protocol` by whoever poses the marker; a stored value BELOW the current
 * constant reads as uncovered. Bumping it is the free platform-wide mass
 * invalidation for the day a forgotten creator site is discovered: no UPDATE
 * over every row, every workspace simply re-earns its marker on next attach.
 */
export const CLAIM_PROTOCOL_VERSION = 1

/** Ids per durable INSERT. See the rationale where docScope.ts re-exports
 * this constant: beyond 1,000
 * there is nothing left to amortize, and the batch interval bounds both the
 * wait of a peer racing the claim and the work lost when one flush rejects.
 * Plain constant, not `Number(process.env...)`: a blank env var parses to NaN. */
export const CLAIM_BATCH_SIZE = 1_000

export interface ClaimBatchResult {
  /** Inserted by THIS batch — first-owner rows that did not exist before. */
  claimed: string[]
  /** Conflicted, and the durable winner is OUR key (idempotent re-run). */
  alreadyOurs: string[]
  /** Conflicted, and another workspace holds the row (first-owner-wins). */
  foreign: { documentId: string; winner: WorkspaceKey }[]
  /** The `versions` row does not exist → the INSERT's JOIN matched nothing and
   * ZERO rows were inserted. Kept apart from `foreign` on purpose so callers
   * do not report a workspace collision that never happened. */
  missingVersion: boolean
}

/**
 * Record first-owner-wins claims for `documentIds` under `key`, in batches.
 *
 * Same discipline as `flushLeafClaims` (which delegates here):
 *
 *  - ids are DEDUPED and SORTED before batching, so two concurrent batches
 *    over overlapping sets acquire the unique-index locks in one monotonic
 *    order — unsorted, two multi-row autocommit INSERTs can interleave into a
 *    40P01 deadlock; sorted, the loser just waits;
 *  - the INSERT derives landscape/version from the `versions` row (JOIN, never
 *    caller literals), so a caller cannot bind a version to a foreign
 *    landscape and a deleted version inserts nothing and wins nothing;
 *  - TWO statements per batch, never one CTE: under READ COMMITTED,
 *    `ON CONFLICT` can conflict with a row committed AFTER this statement's
 *    snapshot, which the SELECT half of the same statement would not see —
 *    the loser SELECT takes a fresh snapshot and sees the winner the conflict
 *    waited on (see `flushLeafClaims` in docScope.ts);
 *  - `RETURNING` yields only actually-inserted rows and in no guaranteed
 *    order, so winners and losers are matched BY VALUE.
 *
 * An id that conflicts and then has no winner row (claimed-then-GC'd between
 * the two statements) lands in NO list — same contract as the walk, whose next
 * sight of the document re-claims it. `missingVersion` is probed only when
 * such unaccounted ids exist, because a missing `versions` row produces
 * exactly that shape for the whole batch.
 */
export async function claimWorkspaceDocuments(
  db: Queryable,
  key: WorkspaceKey,
  documentIds: string[],
): Promise<ClaimBatchResult> {
  const result: ClaimBatchResult = { claimed: [], alreadyOurs: [], foreign: [], missingVersion: false }
  const ids = [...new Set(documentIds)].sort()
  if (ids.length === 0) return result

  let unaccounted = 0
  for (let start = 0; start < ids.length; start += CLAIM_BATCH_SIZE) {
    const batch = ids.slice(start, start + CLAIM_BATCH_SIZE)
    const inserted = await db.query<{ document_id: string }>(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT u.document_id, v.landscape_id, v.id
       FROM unnest($1::text[]) AS u(document_id)
       JOIN versions v ON v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING
       RETURNING document_id`,
      [batch, key.landscapeId, key.versionId],
    )
    const insertedIds = new Set(inserted.rows.map((row) => row.document_id))
    result.claimed.push(...batch.filter((id) => insertedIds.has(id)))
    const losers = batch.filter((id) => !insertedIds.has(id))
    if (losers.length === 0) continue
    const { rows } = await db.query<{ document_id: string; landscape_id: string; version_id: string }>(
      `SELECT document_id, landscape_id, version_id
         FROM automerge_document_workspace
        WHERE document_id = ANY($1::text[])`,
      [losers],
    )
    const winners = new Map(rows.map((row) => [row.document_id, row]))
    for (const id of losers) {
      const winner = winners.get(id)
      if (!winner) { unaccounted += 1; continue }
      if (winner.landscape_id === key.landscapeId && winner.version_id === key.versionId) {
        result.alreadyOurs.push(id)
      } else {
        result.foreign.push({
          documentId: id,
          winner: { landscapeId: winner.landscape_id, versionId: winner.version_id },
        })
      }
    }
  }

  if (unaccounted > 0) {
    // Distinguish the two producers of "in neither set": a missing versions
    // row (caller error — claims can never precede INSERT versions) versus a
    // winner GC'd between the two statements (self-heals at next sight).
    const { rows } = await db.query<{ present: boolean }>(
      'SELECT true AS present FROM versions v WHERE v.id = $2 AND v.landscape_id = $1',
      [key.landscapeId, key.versionId],
    )
    result.missingVersion = rows.length === 0
  }
  return result
}
