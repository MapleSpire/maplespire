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
 * Does a storage-write connection carry what `storageWritePoolConfig` set?
 * The handover barrier (`readModel/ordinaryFoldedArrivals.ts`) relies on the
 * tag and on the ceilings, and both can be lost on the way without an error:
 *   - an `application_name` in `DATABASE_URL` (or `PGAPPNAME`) can override
 *     the one the pool passes;
 *   - a connection pooler in transaction mode (PgBouncer) multiplexes
 *     backends, and `ignore_startup_parameters` drops the startup options;
 *   - `track_activities = off` leaves `pg_stat_activity` without `xact_start`.
 * Any of them makes the barrier blind to this cell's saves. Asked once per new
 * connection (a pool of four), it LOGS LOUDLY (`automerge.storage_write_pool_misconfigured`)
 * and does not refuse the connection: refusing would stop every save to keep
 * a guard that only serves a handover.
 */
export interface StorageWriteConnectionFacts {
  applicationName: string
  statementTimeout: string
  trackActivities: string
}

type Queryable = { query<R>(sql: string): Promise<{ rows: R[] }> }

export async function readStorageWriteConnectionFacts(client: Queryable): Promise<StorageWriteConnectionFacts> {
  const { rows } = await client.query<{ a: string; s: string; t: string }>(
    `SELECT current_setting('application_name') AS a, current_setting('statement_timeout') AS s,
            current_setting('track_activities') AS t`,
  )
  return { applicationName: rows[0]!.a, statementTimeout: rows[0]!.s, trackActivities: rows[0]!.t }
}

/** What is wrong with these facts, or an empty list. `expectedTimeoutMs` 0 is
 * PostgreSQL's "no limit", which the operator chose: not reported. */
export function storageWriteConnectionProblems(
  facts: StorageWriteConnectionFacts,
  expectedName: string,
  expectedTimeoutMs: number,
): string[] {
  const problems: string[] = []
  if (facts.applicationName !== expectedName) problems.push('application_name')
  if (expectedTimeoutMs > 0 && facts.statementTimeout === '0') problems.push('statement_timeout')
  if (facts.trackActivities !== 'on') problems.push('track_activities')
  return problems
}

/** Check one new connection; log once per connection when something is off.
 * Never throws: a failed check is logged too. */
export async function checkStorageWriteConnection(
  client: Queryable,
  expectedName: string,
  expectedTimeoutMs: number,
  log: (line: string) => void = (line) => console.error(line),
): Promise<string[]> {
  try {
    const facts = await readStorageWriteConnectionFacts(client)
    const problems = storageWriteConnectionProblems(facts, expectedName, expectedTimeoutMs)
    if (problems.length) {
      log(JSON.stringify({
        event: 'automerge.storage_write_pool_misconfigured',
        problems,
        expectedApplicationName: expectedName,
        ...facts,
      }))
    }
    return problems
  } catch (error) {
    log(JSON.stringify({
      event: 'automerge.storage_write_pool_misconfigured',
      problems: ['unreadable'],
      error: error instanceof Error ? error.message : String(error),
    }))
    return ['unreadable']
  }
}
