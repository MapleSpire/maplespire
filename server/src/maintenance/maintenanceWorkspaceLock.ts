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

import type { PoolClient } from 'pg'

/** The workspace a maintenance job runs against. Structural, so it accepts any
 *  of the tree's `WorkspaceKey` shapes without importing one of them and
 *  dragging the read-model graph into the maintenance path. */
export interface MaintenanceWorkspaceKey {
  readonly landscapeId: string
  readonly versionId: string
}

/**
 * The per-workspace maintenance lock.
 *
 * ## Why a hashed TEXT key and not `acquireSessionAdvisoryLock`
 *
 * `sessionAdvisoryLock.ts` takes `key: number` and guards it with
 * `assertSafeAdvisoryKey`, which rejects anything `Number.isSafeInteger` refuses.
 * `hashtextextended` returns the full int64 range, so almost no key can survive
 * that parameter. Measured on the CI cluster:
 *
 * ```
 *   hashtextextended('maintenance-workspace:default_compaction:land:ver', 0)
 *     pg type            bigint
 *     reaches JS as      the STRING "5142318902553526705"
 *     safe integer?      NO
 *   over 2000 distinct keys: min -9211123275969860099, max 9221548777043671781
 * ```
 *
 * So the hash is computed IN SQL and the int64 never crosses into JavaScript —
 * the idiom already used for `read-model-projection:` and `overlay-rotation:`.
 *
 * ## Why this cannot collide with the coordinator's per-job lock
 *
 * The job lock uses the TWO-argument `pg_try_advisory_lock(int4, int4)`; this one
 * uses the ONE-argument `bigint` form. Those are separate key spaces:
 *
 * ```
 *   session A holds 1-arg 424242
 *   session B asks  1-arg 424242  -> false   (CONTROL: the lock does refuse)
 *   session B asks  2-arg (424242, 0) -> TRUE (so the spaces do not overlap)
 *   pg_locks: locktype=advisory classid=0 objid=424242 objsubid=1
 * ```
 *
 * `objsubid` is what distinguishes them, and it is why a hash that happens to
 * equal a namespace/job pair still cannot refuse that job.
 *
 * ## Lifetime
 *
 * SESSION scope, on a client the caller ALREADY holds for the whole job — zero
 * extra connections and zero extra open-transaction time. Session scope is only
 * safe *because* the client is checked out: taken through `pool.query` the
 * connection goes back to the pool idle and `pg-pool` destroys it after
 * `idleTimeoutMillis`, taking the lock with it (see `sessionAdvisoryLock.ts`).
 *
 * The mirror hazard is the reason `release` returns what Postgres SAID. A session
 * advisory lock does NOT die when the client is returned to the pool — only when
 * the backend ends. So an unlock that failed, or that answered `false`, leaves the
 * key held on a connection that is about to be handed to somebody else, and every
 * later job on it is refused for ever. `pg_advisory_unlock` RETURNS false rather
 * than raising when the session does not hold the key, so a swallowed result and a
 * clean release are indistinguishable. The caller is handed the answer and must
 * destroy the client when it is not `true`.
 */
export function maintenanceWorkspaceLockKeyText(
  job: string,
  workspace: MaintenanceWorkspaceKey,
): string {
  return `maintenance-workspace:${job}:${workspace.landscapeId}:${workspace.versionId}`
}

/** `true` when this session now holds the key. Never blocks: the blocking form
 *  has no timeout and would park a maintenance tick behind a neighbour's whole
 *  run, a hang the caller cannot tell from a wedged pool. Refusing is the honest
 *  answer, and it is what the coordinator reports as `skipped_locked`. */
export async function acquireMaintenanceWorkspaceLock(
  client: PoolClient,
  keyText: string,
): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    [keyText],
  )
  return rows[0]?.locked === true
}

/**
 * How many BACKENDS hold this key right now, asked of `pg_locks` — an authority
 * independent of "our connection object still exists".
 *
 * This exists because the obvious probe does not work. An advisory lock is
 * COUNTED per session and `pg_try_advisory_lock` on a key your own session
 * already holds returns `true`; `pg-pool` hands the most recently released client
 * back first, so "acquire it again through the pool and see if you get it" is
 * satisfied by the pooling layer whether or not the key leaked: a job that
 * leaked the key is handed the SAME backend on the next `pool.connect()`, its
 * re-acquire returns `true`, while an independent session is refused.
 *
 * `pg_locks` splits a one-argument bigint key across two 32-bit columns, so the
 * key is reassembled in SQL. Verified for a POSITIVE key
 * (`5142318902553526705` → classid 1197289419, objid 4101685681) and a
 * NEGATIVE one (`-6502381154250196561`); the sign matters because the shift is
 * where this arithmetic would quietly be wrong.
 *
 * It counts ROWS, not the reference count: a session that acquired twice and
 * released once still appears, which is precisely the half-released leak worth
 * catching. Call it from a session that is NOT the holder.
 */
export async function maintenanceWorkspaceLockHolders(
  client: Pick<PoolClient, 'query'>,
  keyText: string,
): Promise<number> {
  const { rows } = await client.query<{ holders: number }>(
    `SELECT count(*)::int AS holders
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 1
        AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::bigint::oid
        AND objid   = (hashtextextended($1, 0) & 4294967295)::bigint::oid
        AND granted`,
    [keyText],
  )
  return Number(rows[0]?.holders ?? 0)
}

export interface MaintenanceWorkspaceLockRelease {
  /** What `pg_advisory_unlock` actually returned. `false` means this session did
   *  not hold the key at release time — never a normal outcome. */
  readonly confirmed: boolean
  /** The unlock statement itself failed. Distinct from `confirmed: false`: one is
   *  Postgres answering "no", the other is Postgres not answering. */
  readonly error: string | null
}

/**
 * Give the key back, and report what happened.
 *
 * Deliberately does not throw: it runs in a `finally` beside other cleanup, and a
 * throw there would replace the caller's real error with this one. The caller
 * inspects the result instead — and when it is not `confirmed`, must destroy the
 * connection rather than return it to the pool.
 */
export async function releaseMaintenanceWorkspaceLock(
  client: PoolClient,
  keyText: string,
): Promise<MaintenanceWorkspaceLockRelease> {
  try {
    const { rows } = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
      [keyText],
    )
    return { confirmed: rows[0]?.released === true, error: null }
  } catch (error) {
    return { confirmed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
