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

import type pg from 'pg'
import { PROTOCOL_FENCE_ROWS_SETTING } from '../readModel/health.js'
import type { Queryable } from '../readModel/types.js'

/**
 * TEST FIXTURES ONLY: writes to the protocol tables
 * (`read_model_ordinary_head_retirements`, `read_model_ordinary_chain_folds`)
 * that are not a production writer's.
 *
 * The tables' statement trigger refuses a write whose transaction has not
 * taken the workspace's `read_model_projection_state` row first
 * (`schema.ts`, THE LOCK ORDER of `adoptState.ts`). A fixture that seeds rows
 * by hand has no fence to take — often no projection-state row at all — so it
 * marks its transaction with the wildcard `<xid>:*`, which the trigger admits
 * for every workspace in that transaction only (the xid is this
 * transaction's, so the mark cannot outlive it nor be preset by a role or
 * database setting — `PROTOCOL_FENCE_ROWS_SETTING`, `health.ts`). The
 * digests are still re-stamped: only the lock-order check is waived, and
 * only for the statements run here.
 *
 * Production code never sets the wildcard; it takes the row through
 * `assertReadModelWriteFence` (`health.ts`), and
 * `adoptState.integration.test.ts` (LOCK ORDER 4) checks no production module
 * imports this helper or names the setting.
 */
export const PROTOCOL_FIXTURE_MARK =
  `SELECT set_config('${PROTOCOL_FENCE_ROWS_SETTING}', ',' || pg_current_xact_id()::text || ':*', true)`

/** Mark the transaction `tx` is ALREADY inside (a stub
 * `assertTransactionAuthority`, a fixture inside a test's own BEGIN). */
export async function markProtocolFixture(tx: Queryable): Promise<void> {
  await tx.query(PROTOCOL_FIXTURE_MARK)
}

/** Run `fn` in one marked transaction on its own client of `pool`. */
export async function withProtocolFixture<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let failed: Error | undefined
  try {
    await client.query('BEGIN')
    await markProtocolFixture(client)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      failed = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
    })
    throw error
  } finally {
    client.release(failed)
  }
}

/** One fixture statement (or several, in order) in one marked transaction. */
export async function protocolFixtureQuery(
  pool: pg.Pool,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult> {
  return withProtocolFixture(pool, (client) => client.query(text, values))
}

/** A `Queryable` over `pool` whose every statement runs in its own marked
 * transaction: what a fixture hands a ONE-statement production writer
 * (`recordOrdinaryHeadRetirement`, `commitForwardedHeads`, ...) in place of
 * the bare pool. Not for a writer that needs one transaction across
 * statements (use {@link withProtocolFixture}). */
export function protocolFixtureDb(pool: pg.Pool): Queryable {
  return {
    query: async <R extends Record<string, unknown>>(text: string, params?: unknown[]) => {
      const result = await protocolFixtureQuery(pool, text, params)
      return { rows: result.rows as R[], rowCount: result.rowCount }
    },
  }
}
