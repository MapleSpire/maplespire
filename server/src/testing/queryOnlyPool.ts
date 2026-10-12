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
 * A `Pool` double for a test that only cares what SQL was issued.
 *
 * WHY THIS EXISTS RATHER THAN `{ query } as never`: that double models a pool
 * that cannot `connect()`, and no such pool exists. `PostgresStorageAdapter`
 * borrows clients explicitly (it must, to tell a failure to BORROW apart from
 * a failure to EXECUTE — see `withBoundedClient`), and a test double which
 * omits the capability under test cannot witness it.
 *
 * Every statement still lands on the SAME `query` function the caller passed,
 * so assertions written against `pool.query` calls keep working unchanged.
 */
import type { Pool, PoolClient } from 'pg'

type QueryFn = (...args: never[]) => unknown

export function queryOnlyPool(query: QueryFn): Pool {
  const client = {
    query,
    release: () => undefined,
    // `executeLegacyFencedMutation` attaches and removes an `error` listener
    // around its transaction. A double without them throws inside the `finally`
    // and masks the assertion the test was written to make.
    on: () => client,
    off: () => client,
  }
  return {
    query,
    connect: async () => client as unknown as PoolClient,
  } as unknown as Pool
}
