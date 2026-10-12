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
  PROJECTION_MUTEX_WAIT_MS,
  assertReadModelPlane,
  projectionMutexKey,
  type ReadModelPlane,
} from './projectionAuthority.js'
import { isPool } from './queryableShape.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

// The pool-vs-client shape predicate lives in `queryableShape.ts`, the single
// copy for this directory; see that file for the shapes it distinguishes.

/**
 * Run a projection publication atomically, serialized against the workspace's
 * OTHER writer, and only if this writer still owns the workspace.
 *
 * The opening statements are the whole point of this function: keeping them
 * here rather than at each call site leaves no per-caller line to forget (the
 * ownership fence alone is a no-op unless `SYNC_CELL_OWNERSHIP=on`), and the
 * `plane` parameter makes a new caller declare its side of the `ro_*` plane
 * rather than inherit a default.
 *
 * ORDER IS LOAD-BEARING. `projectionTransaction.test.ts` asserts the steps as a
 * whole sequence rather than by presence, so a step that MOVES fails too:
 *
 *  1. `SET LOCAL lock_timeout` — bounds the wait below, server-side, so an
 *     expired wait actually returns its client instead of parking it;
 *  2. the projection MUTEX, `pg_advisory_xact_lock`, FIRST — before the
 *     authority check and before any row lock, so a transaction waiting for it
 *     holds nothing;
 *  3. the authority check, so a writer that has lost the plane rolls back
 *     after one primary-key lookup rather than after a whole cold build.
 *
 * There is exactly ONE global lock order in this subsystem —
 * `read-model-projection:` before `overlay-rotation:` — and it holds only
 * because nothing that takes an `overlay-rotation` lock ever asks for this
 * one. `StaticDeltaProjector`'s rotation, fold and admitted-rotation recovery
 * hold `overlay-rotation` at SESSION scope across `repo.flush`, and run their
 * transactions on their own client with a bare `BEGIN` — deliberately NOT
 * through this function. Routing any of them through it would invert the
 * order and deadlock (40P01) on a single workspace. The order is asserted by
 * `projectionLockOrderViolations` in `overlayChainFoldPass.test.ts`, where
 * those paths are driven end to end.
 *
 * A caller that is ALREADY inside a transaction hands in its own client (see
 * {@link isPool}) and this function issues the statements on it without
 * opening a second one. That holds only if the caller really is inside a
 * transaction: outside one the statements are INERT — `SET LOCAL` only warns
 * and leaves `lock_timeout` at 0, and `pg_advisory_xact_lock` is released by
 * its own implicit commit. That is the caller's obligation; this function
 * cannot check it.
 */
export async function withReadModelProjectionTransaction<T>(
  db: Queryable,
  key: WorkspaceKey,
  plane: ReadModelPlane,
  run: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const open = async (tx: Queryable): Promise<T> => {
    await tx.query(`SET LOCAL lock_timeout = '${PROJECTION_MUTEX_WAIT_MS}ms'`)
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [projectionMutexKey(key)])
    // The plane check runs INSIDE the ceiling: `assertReadModelPlane` takes
    // `FOR KEY SHARE` on the authority row, which a demotion's `DELETE`
    // contends, and it must not wait unbounded while this transaction holds
    // the projection mutex.
    //
    // The ceiling is then disarmed before `run`. `SET LOCAL lock_timeout`
    // scopes to the whole TRANSACTION, not the next statement. A static
    // publish takes a SECOND advisory lock inside its action
    // (`overlay-rotation:…`, via `synchronizeOverlaySegments`) which rotation,
    // fold and recovery hold at SESSION scope across `repo.flush`; left armed,
    // the ceiling would abort that publish, and an aborted publish increments
    // `consecutive_failures`, walking a healthy workspace toward `failed` under
    // mere contention. Only the wait for the mutex is bounded.
    await assertReadModelPlane(tx, key, plane)
    await tx.query('SET LOCAL lock_timeout = 0')
    return run(tx)
  }
  if (!isPool(db)) return open(db)
  const client = await db.connect()
  // A ROLLBACK that FAILS is the one outcome this function must not hand back
  // to the pool. The connection is then still inside the transaction and still
  // holding `pg_advisory_xact_lock` for this workspace, so the next borrower
  // inherits both: every subsequent projection AND every lifecycle transition
  // for that workspace waits on a lock nobody can see, behind a calm log.
  // Releasing with the failure DESTROYS the connection instead, and ending the
  // session is the only mechanism that returns an advisory lock.
  //
  // Kept as a separate binding rather than re-thrown: the caller's error is the
  // one that explains what happened, and a rollback failure must not replace it.
  let rollbackFailure: Error | true | undefined
  try {
    await client.query('BEGIN')
    const result = await open(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rollbackFailure = rollbackError instanceof Error ? rollbackError : true
      console.warn(
        `[read-model] ROLLBACK failed for ${key.landscapeId}/${key.versionId}; destroying the connection ` +
          'rather than returning it to the pool holding the projection mutex:',
        rollbackError,
      )
    })
    throw error
  } finally {
    client.release(rollbackFailure)
  }
}
