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
 * `restore:reset-routing` — invalidate the routing claims a restore
 * reinstalled, WITHOUT touching the fencing tokens.
 *
 * WHAT A RESTORE LEAVES BEHIND. `sync_workspace_ownership` is the DURABLE half
 * of the fence; Redis holds the live half and `pg_restore` does not touch it.
 * A dump taken before the current acquisitions therefore reinstalls rows that
 * name cells which may no longer exist, at tokens BELOW the ones the live
 * owners write under, and writes by the legitimate owner on the mapped path
 * are then refused with `fence-mismatch`.
 *
 * WHY RELEASE AND NOT DELETE — this is the whole design. `released_at` is what makes a claim
 * stale; `fencing_token` is the durable record of how high the sequence has
 * ever gone. `acquireMissing` reads that number and calls
 * `ensureMinimumToken(workspace, durable ?? 0)` before minting, so it is the
 * floor that keeps a rebuilt Redis from re-issuing a token some storage write
 * has already been fenced against. DELETE removes the row, the floor becomes
 * `0`, and a cluster that lost Redis as well as PostgreSQL would re-issue
 * tokens from the bottom — the one failure a fencing token exists to prevent.
 * So: release the claim, keep the number.
 *
 * WHAT THIS IS FOR, stated narrowly. A cell that STARTS after the restore repairs its own row without
 * help: `acquireMissing` reads the durable token, raises the Redis sequence to
 * at least it, and `persistLease` upserts under
 * `WHERE fencing_token <= EXCLUDED.fencing_token`. So this command is not what
 * makes restored rows harmless in general. It exists for the rows no restarted
 * cell will ever claim — a fleet that shrank, cells renamed, a partition count
 * changed — and for a restore that already happened under a LIVE fleet, where
 * the operator needs every claim invalidated before restarting.
 *
 * AND IT IS DESTRUCTIVE WHILE CELLS ARE RUNNING. The mutation gate admits only
 * on `released_at IS NULL`, so from the instant this commits, every cell still
 * holding a lease in memory is refused every mapped write — the same wedge,
 * caused deliberately, until those cells restart: `valid_fence` for the live
 * token is TRUE before the reset and FALSE after. The coordinator reports it as
 * `fenceDivergenceByCause.released`, which is why that cause is separated from
 * the total. Stop the cells first; the `--force` guard below exists because
 * "first" is easy to skip.
 *
 * It does not talk to Redis at all: re-minting upward is `acquireMissing`'s job.
 * It also clears the durable topology comparison witness in the same SQL
 * statement as releasing claims. This never deletes the durable token floors.
 */
import type { Queryable } from '../readModel/types.js'

/** Which database this ran against, read from the SERVER rather than parsed out
 * of a connection string. A destructive command whose output cannot name its
 * target is one an operator cannot audit after the fact — and the CLI's URL
 * resolution silently falls back to `server/.env`, so the string the operator
 * believes they passed and the database they hit are two different facts. */
export interface RestoreRoutingResetTarget {
  database: string
  /** `null` over a unix socket, which is not an error. */
  serverAddress: string | null
  serverPort: number | null
}

export interface RestoreRoutingResetReport {
  /** 'preview' read and wrote nothing; 'apply' released the claims. */
  mode: 'preview' | 'apply'
  target: RestoreRoutingResetTarget
  /** EPOCH: in `apply` this is the UPDATE's own `rowCount` — what was DONE. In
   * `preview` it is the survey count — what was SEEN. The two differ whenever a
   * writer lands between the survey and the UPDATE, which the integration suite
   * reproduces deterministically through the `Queryable` seam. */
  claimsReleased: number
  /** EPOCH: read BEFORE the write. Rows already released when this started, so
   * a second run is legible as "nothing left to do" rather than as a failure. */
  alreadyReleased: number
  /** EPOCH: read BEFORE the write. Every distinct `cell_id` naming a live claim
   * — on a restored database, the cells the DUMP knew about, which is usually
   * not the fleet about to start. Deduplicated and sorted. */
  claimingCells: string[]
  /** EPOCH: read BEFORE the write, and that is the whole caveat.
   *
   * This is NOT a check that the tokens were preserved. The value is computed
   * from the survey that runs before the UPDATE and is never re-read, so in
   * `apply` mode it is identical to the preview's BY CONSTRUCTION, whatever the
   * UPDATE did.
   *
   * Token preservation is pinned by `restoreRoutingReset.integration.test.ts`,
   * which RE-READS the rows after the apply. If an operator wants an
   * after-value, it comes from another run in preview mode once the apply has
   * finished. */
  highestFencingToken: string | null
  /** EPOCH: read BEFORE the write. Unreleased claims whose observed lease expiry
   * is still in the FUTURE.
   *
   * READ THE MECHANISM BEFORE TRUSTING THE NUMBER — it is NOT evidence that
   * cells are still running. `lease_observed_expires_at` is written by exactly
   * one function, `persistLease`, reached from three episodic call sites: the
   * two ACQUISITION paths (`acquireMissing`, `recoverWorkspaceLease`) and the
   * fence REPAIR. Renewal updates the lease's validity in memory and writes
   * nothing. So with `leaseTtlMs` at its 15 s default, a cell that has been
   * serving for an hour carries an observed expiry an hour in the PAST and is
   * not counted here at all.
   *
   * WHAT THE NUMBER MEANS IS BOUNDED, NOT IMPOSSIBLE: a dump CAN carry a future
   * expiry (`restoreRoutingReset.integration.test.ts` seeds one).
   * `persistLease` writes `NOW() + leaseTtlMs`, clamped to 6–120 s with a 15 s
   * default (`ownership.ts`, `boundedInteger`), so a future expiry says the row
   * was written LESS THAN ONE LEASE TTL AGO. On a restored database that is
   * either something acquiring or repairing after the restore — the incident —
   * or a dump taken inside that window and restored fast, which is benign. This
   * count cannot separate them; `recentlyAcquiredBreakdown` can, given an
   * emptiness proof.
   *
   * In practice the restore outlives the TTL and the number is zero. It is used
   * only to refuse without `force`, never to decide anything silently — and
   * `restore-database.ts` passes `force` precisely because at ITS call site the
   * benign reading is the likely one. See that file's arbitration. */
  recentlyAcquiredClaims: number
  /**
   * The split `recentlyAcquiredClaims` cannot make. `null` when the caller
   * supplied no emptiness instant, which is the
   * honest answer rather than a zero: "nobody wrote after the proof" and "there
   * was no proof to compare against" are different facts, and only the first is
   * reassuring.
   *
   * `writtenAfterEmptinessProof` IS THE INCIDENT. `assertEmptyRestoreDatabase`
   * proved the target held no public table at instant T; any ownership row with
   * `acquired_at >= T` was therefore written by something that arrived after
   * the restore began, not carried in by `pg_restore` from the source's past.
   * That is a cell claiming a database an operator is in the middle of
   * restoring.
   *
   * `carriedByTheDump` is the benign half — a dump taken inside one lease TTL
   * and restored fast.
   */
  recentlyAcquiredBreakdown: { writtenAfterEmptinessProof: number; carriedByTheDump: number } | null
}

export class LiveLeasesPresentError extends Error {
  readonly code = 'sync_cell_reset_live_leases'
  constructor(readonly report: RestoreRoutingResetReport) {
    // The refusal does not depend on the breakdown: a diagnostic must not
    // loosen a safety gate as a side effect. The breakdown only changes what
    // the operator is TOLD.
    const breakdown = report.recentlyAcquiredBreakdown
    super(
      `${report.recentlyAcquiredClaims} claim(s) on ${report.target.database} carry an observed lease `
      + 'expiry in the future, so they were written less than one lease TTL ago. '
      + (breakdown === null
        ? 'Either something is already serving this database, or the dump was taken inside that window '
          + 'and restored fast; with no emptiness proof to compare against, this count cannot tell those '
          + 'apart. '
        : `${breakdown.writtenAfterEmptinessProof} of them were written AFTER this database was proved `
          + `empty, so something is claiming it right now; ${breakdown.carriedByTheDump} came in with the `
          + 'dump and are benign. ')
      + 'Releasing a claim something holds refuses every write it makes until it restarts. '
      + 'Stop the cells, or pass force:true if that is what you intend.',
    )
    this.name = 'LiveLeasesPresentError'
  }
}

/** Only an explicit catalog observation may classify a pre-ownership dump.
 * An arbitrary 42P01 can name another missing relation and must still fail. */
export class SyncCellOwnershipSchemaMissingError extends Error {
  readonly code = 'sync_cell_ownership_schema_missing'
  constructor() {
    super('The restored schema has no sync_workspace_ownership table')
    this.name = 'SyncCellOwnershipSchemaMissingError'
  }
}

const TARGET = 'SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port'

const SCHEMA = `SELECT
  to_regclass('sync_workspace_ownership') IS NOT NULL AS ownership_present,
  to_regclass('sync_topology_contract') IS NOT NULL AS topology_present`

const SURVEY = `
  SELECT cell_id,
         (released_at IS NOT NULL) AS released,
         (released_at IS NULL AND lease_observed_expires_at > NOW()) AS recently_acquired,
         -- B4-6b's discriminant. FALSE when the caller has no emptiness proof to
         -- compare against; the report then carries the whole breakdown as null
         -- rather than folding it into a zero. (No backticks in this comment:
         -- it lives inside a template literal, where one would end the string.)
         ($1::timestamptz IS NOT NULL AND acquired_at >= $1::timestamptz) AS written_after_emptiness_proof,
         fencing_token::text AS fencing_token
    FROM sync_workspace_ownership
   ORDER BY landscape_id, version_id
`

/**
 * Release every live routing claim and clear the topology mirror atomically,
 * preserving every fencing token. A dump older than the topology mirror has no
 * mirror to clear.
 *
 * `mode` has NO DEFAULT on purpose: a caller that has not said which side it is
 * on does not compile.
 */
export async function resetSyncCellOwnershipClaims(
  db: Queryable,
  options: {
    mode: 'preview' | 'apply'
    force?: boolean
    /**
     * The instant `assertEmptyRestoreDatabase` proved the target held no public
     * table. Optional, because this function is also reachable from
     * `restore:reset-routing` run by hand against a database nobody just
     * restored — there is no proof to cite there, and inventing one would
     * classify every row as benign.
     */
    emptyAt?: Date
  },
): Promise<RestoreRoutingResetReport> {
  const { rows: target } = await db.query<{
    database: string
    address: string | null
    port: number | string | null
  }>(TARGET)
  const { rows: schema } = await db.query<{
    ownership_present: boolean
    topology_present: boolean
  }>(SCHEMA)
  const catalog = schema[0]
  if (typeof catalog?.ownership_present !== 'boolean' || typeof catalog.topology_present !== 'boolean') {
    throw new Error('Routing reset could not determine the restored schema')
  }
  if (!catalog.ownership_present) throw new SyncCellOwnershipSchemaMissingError()
  const { rows } = await db.query<{
    cell_id: string
    released: boolean
    recently_acquired: boolean
    written_after_emptiness_proof: boolean
    fencing_token: string
  }>(SURVEY, [options.emptyAt ?? null])

  const live = rows.filter((row) => !row.released)
  const report: RestoreRoutingResetReport = {
    mode: options.mode,
    target: {
      database: target[0]?.database ?? '<unknown>',
      serverAddress: target[0]?.address ?? null,
      serverPort: target[0]?.port === null || target[0]?.port === undefined ? null : Number(target[0].port),
    },
    claimsReleased: live.length,
    alreadyReleased: rows.length - live.length,
    claimingCells: [...new Set(live.map((row) => row.cell_id))].sort(),
    highestFencingToken: rows.length === 0
      ? null
      : rows.map((row) => row.fencing_token)
        // BigInt, not Number: two BIGINTs one apart above 2^53 are the SAME
        // double, so `Number()` cannot order them at all.
        .reduce((highest, token) => (BigInt(token) > BigInt(highest) ? token : highest)),
    recentlyAcquiredClaims: rows.filter((row) => row.recently_acquired).length,
    recentlyAcquiredBreakdown: options.emptyAt === undefined
      ? null
      : {
        writtenAfterEmptinessProof: rows
          .filter((row) => row.recently_acquired && row.written_after_emptiness_proof).length,
        // Derived by SUBTRACTION from the same filtered set, so the two halves
        // sum to `recentlyAcquiredClaims` by construction. Counting them
        // independently would let a predicate drift and produce a breakdown
        // that does not add up — a report whose own arithmetic is the first
        // thing a reader would have to check.
        carriedByTheDump: rows
          .filter((row) => row.recently_acquired && !row.written_after_emptiness_proof).length,
      },
  }
  // FAIL-SAFE, not fail-open: only the exact string `'apply'` writes. A gate on
  // `=== 'preview'` would let `'Preview'` WRITE, and TypeScript does not reach
  // a JavaScript caller, a JSON config, or a CLI flag.
  if (options.mode !== 'apply') return report

  if (report.recentlyAcquiredClaims > 0 && options.force !== true) {
    throw new LiveLeasesPresentError(report)
  }

  // `fencing_token` is absent from the SET list, and that absence is the
  // feature. `updated_at` moves because the row did change; `acquired_at` does
  // NOT, because nothing acquired anything, and `lease_observed_expires_at` is
  // an observation about an acquisition that already happened.
  // Queryable may be a Pool: BEGIN/COMMIT around separate queries would not
  // own one connection. A data-modifying CTE makes both writes one statement,
  // including rollback when either write fails. Keep UPDATE as the principal
  // command so rowCount remains the number of claims actually released.
  // Old dumps legitimately lack the mirror. Detect that without applying DDL
  // to the restored copy; an error after this census is a real reset failure.
  const clearTopology = catalog.topology_present
    ? 'WITH cleared_topology AS (DELETE FROM sync_topology_contract RETURNING singleton)'
    : ''
  const updated = await db.query(`
    ${clearTopology}
    UPDATE sync_workspace_ownership
       SET released_at = NOW(),
           updated_at = NOW()
     WHERE released_at IS NULL
  `)
  // The survey and the UPDATE are two statements, so a writer can land between
  // them. Reporting the UPDATE's own count rather than the survey's is the
  // difference between "what was seen" and "what was done", and only the
  // second is a durable claim. The other fields keep their pre-write epoch, documented above.
  report.claimsReleased = updated.rowCount ?? 0
  console.log(JSON.stringify({
    event: 'sync.cell.restore_routing_reset',
    target: report.target,
    claimsReleased: report.claimsReleased,
    alreadyReleased: report.alreadyReleased,
    claimingCells: report.claimingCells,
    highestFencingTokenBeforeReset: report.highestFencingToken,
    recentlyAcquiredClaims: report.recentlyAcquiredClaims,
    forced: options.force === true,
  }))
  return report
}
