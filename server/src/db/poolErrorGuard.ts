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

import type { Pool } from 'pg'
import { meterPool } from './poolMeter.js'

/**
 * Make an idle-client failure survivable, for every pg pool in the server.
 *
 * An idle pooled client that loses its backend emits `'error'` on the POOL, and
 * an EventEmitter with no `'error'` listener THROWS. Parts of this server
 * manufacture that event deliberately: `DROP DATABASE ... WITH (FORCE)` calls
 * `pg_terminate_backend` on every other connection to its target, and
 * `sessionAdvisoryLock` terminates a lock holder by design.
 *
 * Measured against a scratch database dropped `WITH (FORCE)` while one client
 * sat idle:
 *
 *     no listener .... `Unhandled 'error' event`, exit 1, process dead
 *     listener ....... survived, handler fired once, exit 0
 *
 * In a test run this surfaces as uncaught exceptions with SQLSTATE `57P01`
 * outside any test file while every test passes.
 *
 * Every pool goes through this one function (a source gate in the test enforces
 * it) so the policy cannot drift between copies.
 *
 * Warned, never swallowed: not crashing is the job, silence is not part of it.
 * A query that fails still rejects its own promise — pg-pool detaches the pool
 * listener at checkout and re-attaches on release, so it only ever sees the
 * idle case.
 */
export function guardIdleClientErrors<T extends Pool>(
  pool: T,
  label: string,
  /**
   * Where to report it. Optional so no call site can omit the guard for want of
   * a logger; entrypoints with a structured logger pass it here instead of
   * hand-writing their own listeners.
   */
  log: (event: string, fields: Record<string, unknown>) => void = defaultLog,
): T {
  pool.on('error', (error) => {
    // `error.code` is what an operator greps for — `57P01` admin shutdown,
    // `57P02` crash shutdown, `ECONNRESET` a dropped socket. Passing the error
    // object alone buries it in a dump.
    log('pg.idle_client_error', {
      pool: label,
      code: (error as { code?: unknown } | null)?.code ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  // THE CHECKED-OUT HALF. Because pg-pool detaches the pool listener at
  // checkout, a checked-out client has NO error listener until release.
  // Measured by terminating the backend of a checked-out client with no query
  // in flight:
  //
  //     pool guard only ......  0 listeners on the client, then TWO uncaught
  //                             exceptions — `57P01` and
  //                             `Connection terminated unexpectedly`
  //     + this listener ......  1 listener, both errors delivered to it, none
  //                             uncaught
  //
  // Without it, test runs fail intermittently on an uncaught exception outside
  // every test file.
  //
  // `'connect'` rather than `'acquire'`: it fires ONCE per physical connection,
  // so each client gets exactly one listener. Attaching per checkout would add
  // one every time the client is reused and trip the max-listeners warning.
  //
  // An idle failure now logs TWICE — once here and once above — because pg's
  // own idle listener lives on the client too and re-emits on the pool. The
  // distinct event names keep them apart for an operator.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      log('pg.client_error', {
        pool: label,
        code: (error as { code?: unknown } | null)?.code ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })

  // THE METER, registered here because this function is the single seam every
  // pg pool enters the server through: the source gate in this file's test
  // ("every pg Pool under server/src and server/scripts is guarded") already
  // rejects a `new Pool(` that bypasses it, so metering gets the same coverage
  // for free.
  //
  // Purely observational: no wrapper on `connect`, `query` or `release`, so
  // nothing here sits between a checkout and its release. See `poolMeter.ts`.
  meterPool(pool, label)
  return pool
}

function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.warn(`[pg] ${event}`, fields)
}
