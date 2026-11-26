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

import type { Pool, PoolClient } from 'pg'
import { meterPool } from './poolMeter.js'
import { READ_MODEL_PROTOCOL_SETTING, READ_MODEL_PROTOCOL_VERSION } from '../readModel/protocolParticipant.js'

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
  // THE MARKER'S HOOK, checked before anything is attached (installed
  // below). `onConnect` exists from pg-pool 3.13.0 (shipped with pg 8.20.0,
  // whose changelog adds it). An older pg-pool ignores the option without a
  // word and every connection would be a non-participant; what excludes it
  // is the floor in `server/package.json` (pg ^8.20.0, which requires
  // pg-pool ^3.13.0) — this check cannot tell an older pg-pool, which has an
  // `options` object too. What it refuses, HERE at creation, is a pool that
  // cannot carry the hook at all (no options object, a non-function
  // `onConnect`), rather than letting it surface at run time as every
  // read-model write refused (the fence assertion fails closed on an
  // unmarked connection). That the installed pg-pool really runs the hook is
  // proved against a database by `adoptState.integration.test.ts`, MIXED
  // VERSION 1 (a guarded pool's connection reads the marker back).
  const options = (pool as { options?: { onConnect?: (client: PoolClient) => unknown } }).options
  if (!options || typeof options !== 'object') {
    throw new Error(`guardIdleClientErrors(${label}): this pool has no options object to install the read-model `
      + 'protocol marker into (pg-pool onConnect, pg >= 8.20.0); refusing to build a pool whose connections would be '
      + 'non-participants (readModel/protocolParticipant.ts)')
  }
  const built = options.onConnect
  if (built !== undefined && typeof built !== 'function') {
    throw new Error(`guardIdleClientErrors(${label}): the pool's onConnect is not a function`)
  }

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

  // THE PROTOCOL PARTICIPANT MARKER (`readModel/protocolParticipant.ts`):
  // every connection of this pool belongs to a process that keeps the
  // read-model lock order, so the protocol tables' trigger enforces it on
  // them. Session scope, once per physical connection, through pg-pool's
  // `onConnect`, which the pool AWAITS before handing the client to its
  // first caller and which, when it rejects, ends the client and fails that
  // caller's `connect()` — so no connection of this pool is ever handed out
  // unmarked. Not a query from the `'connect'` listener above: that one is
  // not awaited, and queueing a query behind another is deprecated in pg 8
  // (a warning measured on this branch) and removed in pg 9. Runs before any
  // `onConnect` the pool was built with.
  //
  // (`options` and `built` are validated at the top of this function.)
  options.onConnect = async (client: PoolClient) => {
    await client.query(`SET ${READ_MODEL_PROTOCOL_SETTING} = '${READ_MODEL_PROTOCOL_VERSION}'`)
    if (built) await built(client)
  }

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
