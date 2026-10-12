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

/**
 * Classifying and TIMING the ceilings PostgreSQL applies. Not applying them.
 *
 * ── WHERE THE BOUND ACTUALLY LIVES, AND WHY NOT HERE ────────────────────────
 *
 * `syncCellDatabasePoolConfig` (`src/dbConfig.ts`) puts `statement_timeout` and
 * `lock_timeout` in the connection's STARTUP PACKET, so every statement on that
 * pool is bounded from its first byte at zero cost.
 *
 * Bounding each statement here instead (`BEGIN` / `SET LOCAL
 * statement_timeout` / statement / `COMMIT` on a checked-out client) is worse
 * on every axis:
 *
 *  - COST: x2–x4 on the warm pass and ~50 % longer cold passes.
 *  - A POISONED CONNECTION. On the failure path the client goes back after a
 *    `ROLLBACK` that may itself fail, and `pg-pool` neither rolls back nor
 *    resets a released client, so a connection stuck in `25P02` would reach
 *    unrelated `pool.query` callers.
 *  - NO REAL GUARANTEE. `Pool` is structurally a `Queryable`, so any call site
 *    can bypass a wrapper without the type checker noticing. A pool-level bound
 *    has no call site that can opt out.
 *
 * What is left here is what the pool cannot do: say WHICH ceiling fired, and
 * report how close ordinary work runs to it.
 */

/** PostgreSQL `query_canceled` — what `statement_timeout` raises.
 *
 *  NOT exclusively ours: `pg_cancel_backend()` and a client-side cancel raise
 *  the same code, so this means "the statement was cancelled", not "our ceiling
 *  fired". Stated because the difference matters to anyone reading a counter
 *  built on it. */
export const QUERY_CANCELED = '57014'

/** PostgreSQL `lock_not_available` — what `lock_timeout` raises. Distinct from
 *  the above on purpose: a lock wait and a slow statement are different
 *  failures with different remedies. */
export const LOCK_NOT_AVAILABLE = '55P03'

function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

export function isStatementTimeout(error: unknown): boolean {
  return sqlState(error) === QUERY_CANCELED
}

export function isLockTimeout(error: unknown): boolean {
  return sqlState(error) === LOCK_NOT_AVAILABLE
}

/** Either ceiling firing — the two together are "PostgreSQL stopped this for
 *  us", which is the class a caller usually wants to count. */
export function isServerImposedCeiling(error: unknown): boolean {
  return isStatementTimeout(error) || isLockTimeout(error)
}

export interface QuerySample {
  /** Wall clock for THE STATEMENT, and nothing else, so it is commensurable
   *  with `statement_timeout`. */
  elapsedMs: number
  text: string
  /** True when PostgreSQL stopped it — either ceiling. A cancelled statement's
   *  duration is the CEILING, not a measurement of the work, so a caller
   *  tracking "how close are we to the ceiling" must exclude these or its gauge
   *  saturates at the ceiling forever after the first incident. */
  cancelled: boolean
}

/**
 * Time every statement a `Queryable` runs, without touching how it runs.
 *
 * A pure decorator: no checkout, no transaction, no `finally` to get wrong. It
 * cannot leak a client because it never takes one.
 *
 * The observer is called on both paths and its own throw is contained: an
 * instrument that can fail the thing it measures is worse than no instrument.
 */
export function timedQueryable(db: Queryable, observe: (sample: QuerySample) => void): Queryable {
  const report = (sample: QuerySample): void => {
    try {
      observe(sample)
    } catch {
      // Deliberately swallowed, and this is the one place it is right: the
      // caller asked for a query, not for telemetry, and a broken gauge must not
      // become a failed statement.
    }
  }
  return {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      const startedAt = Date.now()
      try {
        const result = await db.query<R>(text, params)
        report({ elapsedMs: Date.now() - startedAt, text, cancelled: false })
        return result
      } catch (error) {
        report({ elapsedMs: Date.now() - startedAt, text, cancelled: isServerImposedCeiling(error) })
        throw error
      }
    },
  }
}

export interface EffectiveCeilings {
  statementTimeout: string
  lockTimeout: string
}

/**
 * Ask the SERVER what ceilings are actually in force on this pool.
 *
 * A pool-level bound cannot be bypassed per call site, but it CAN be silently
 * absent — a pool built from the wrong config, an operator setting
 * `SYNC_CELL_STATEMENT_TIMEOUT_MS=` to a blank (`0`, which in PostgreSQL means
 * NO timeout), a connection string whose options were dropped.
 *
 * So the coordinator asks, at start, instead of assuming, and refuses to run
 * when a ceiling reads as unbounded (see `ceilingIsUnbounded`).
 */
export async function readEffectiveCeilings(db: Queryable): Promise<EffectiveCeilings> {
  const { rows } = await db.query<{ statement_timeout: string; lock_timeout: string }>(
    `SELECT current_setting('statement_timeout') AS statement_timeout,
            current_setting('lock_timeout') AS lock_timeout`,
  )
  return {
    statementTimeout: rows[0]?.statement_timeout ?? '0',
    lockTimeout: rows[0]?.lock_timeout ?? '0',
  }
}

/** `'0'` and `'0ms'` are both how PostgreSQL renders "no ceiling"; anything else
 *  is a duration it will enforce. */
export function ceilingIsUnbounded(setting: string): boolean {
  const trimmed = setting.trim()
  return trimmed === '0' || /^0\s*(ms|s|min|h|d)$/.test(trimmed)
}
