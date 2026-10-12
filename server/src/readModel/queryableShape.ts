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

import type { Queryable } from './types.js'

/** A `Queryable` that hands itself back — a pg `PoolClient`. */
export interface ReleasableQueryable extends Queryable {
  /** pg's `PoolClient.release`. The argument is the half that matters: released
   * with a truthy value, the pool DESTROYS the connection instead of handing it
   * to the next borrower. */
  release(destroy?: Error | boolean): void
}

/** A `Queryable` that can hand out its own clients — a pg `Pool`. */
export interface ConnectableQueryable extends Queryable {
  connect(): Promise<ReleasableQueryable>
}

/**
 * Is this a POOL — i.e. may a helper open its own transaction on it?
 *
 * Use this single predicate everywhere; the conjunction is load-bearing:
 *
 *  - `connect` ALONE is wrong for a real `PoolClient`. pg-pool hands back the
 *    `Client` itself with `release` monkey-patched on, so the client inherits
 *    `Client.prototype.connect`, and calling it a second time throws
 *    `Client has already been connected. You cannot reuse a client.`;
 *  - "no `release`" ALONE is wrong for a bare `{ query }` recording fake, which
 *    has no `connect` either.
 *
 * Checked against pg 8.21.0, the five shapes this tree passes:
 *
 *   | object                    | connect | release | is a Pool |
 *   |---------------------------|---------|---------|-----------|
 *   | Pool                      | yes     | no      | YES       |
 *   | PoolClient                | yes     | YES     | no        |
 *   | a test's pool fake        | yes     | no      | YES       |
 *   | a test's client fake      | no      | yes     | no        |
 *   | a bare `{ query }` fake   | no      | no      | no        |
 */
export function isPool(db: Queryable): db is ConnectableQueryable {
  const candidate = db as Partial<ConnectableQueryable> & { release?: unknown }
  return typeof candidate.connect === 'function' && typeof candidate.release !== 'function'
}

/**
 * Run `work` so that its statements are ATOMIC, whoever handed us the handle.
 *
 * Given a Pool this opens a transaction of its own. Given anything else the
 * caller owns the transaction and this runs in it — an obligation this
 * function cannot check; a caller that is not in one gets the statements
 * un-atomically.
 *
 * The point is that a multi-statement write must not depend on every call site
 * remembering to open a transaction (see `markStaticReadModelWorkspace` for
 * what a torn allow-list rewrite costs).
 *
 * On a failed ROLLBACK the client is released WITH the failure so the pool
 * destroys it: a connection returned still inside its transaction holds every
 * row lock it took, and the next borrower inherits them behind a calm log.
 */
export async function withAtomicStatements<T>(
  db: Queryable,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) return work(db)
  const client = await db.connect()
  let rollbackFailure: Error | true | undefined
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rollbackFailure = rollbackError instanceof Error ? rollbackError : true
    })
    throw error
  } finally {
    client.release(rollbackFailure)
  }
}
