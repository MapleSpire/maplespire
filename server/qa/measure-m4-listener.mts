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
 * The pg_notify measure's cross-process listener. Spawned by
 * `qa/measure-m4.mts`; not useful alone.
 *
 * WHY A SECOND PROCESS EXISTS AT ALL. With the writer and the listener on ONE
 * event loop, latency reads ~0.03 ms with NEGATIVE minima — the notification
 * "arriving before" the write that caused it. That is not a fast channel, it is
 * two callbacks scheduled by the same event loop within the same poll phase,
 * and the negative values are the instrument saying its two endpoints are not
 * causally ordered by its clock.
 * It also does not resemble the deployment: the module exists precisely because
 * process B writes and process A listens. So the primary latency number is taken
 * across a real process boundary.
 *
 * The listener is the SHIPPED `startWorkspaceCacheInvalidation`. This file adds
 * a timestamp and a pipe, nothing else.
 *
 * `process.hrtime.bigint()` is used rather than `performance.now()` because its
 * origin is the machine, not the process — that is the ONLY reason the two
 * processes' timestamps can be subtracted, and the parent does not take it on
 * faith: it brackets a round trip around this process's clock and refuses the
 * cross-process number if the reading does not fall inside the bracket.
 *
 * stdout carries ONE newline-delimited JSON object per event and nothing else.
 * The listener module's own diagnostics go to `console.warn`, which is stderr,
 * so they cannot corrupt the stream.
 */
import pg from 'pg'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { envNumber } from '../src/envNumber.js'
import { startWorkspaceCacheInvalidation } from '../src/rbac/workspaceCacheInvalidation.js'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`measure-m4-listener needs ${name}`)
  return v
}

const DATABASE_URL = need('TEST_DATABASE_URL')
const SCHEMA = need('M4_SCHEMA')
const LANDSCAPE = need('M4_LANDSCAPE')
const APP_NAME = need('M4_APPNAME')
// Bounded rather than a bare `Number(... ?? '1000')`, which `local/no-bare-env-number`
// rejects for a specific reason that bites HERE more than anywhere: a dangling
// `M4_RECONNECT_MS=` parses to 0, and 0 is finite, so a blank would have set the
// reconnect cadence to "retry immediately, forever" — silently turning the arm
// that is supposed to measure a 60 s blackout into one that measures nothing.
// The floor is 1 ms and the ceiling a minute, which brackets both cadences this
// harness uses (the 1 s fast arm and the 60 s shipped default).
const RECONNECT_MS = envNumber('M4_RECONNECT_MS', {
  fallback: 1_000,
  minimum: 1,
  maximum: 60_000,
  integer: true,
})

const emit = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`)
}

process.on('uncaughtException', (err) => {
  emit({ fatal: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})

const pool = guardIdleClientErrors(
  new pg.Pool({
    connectionString: DATABASE_URL,
    max: 5,
    // Mirrors production (`databasePoolConfig`, src/dbConfig.ts). See the note
    // in measure-m4.mts: it changes nothing here, and is set so that nobody has
    // to wonder whether it would have.
    keepAlive: true,
    application_name: APP_NAME,
    options: `-c search_path=${SCHEMA}`,
  }),
  'm4:child-listener',
  (event, fields) => { emit({ poolEvent: event, fields }) },
)

const handle = startWorkspaceCacheInvalidation(
  pool,
  {
    onCoverageChanged: (key) => {
      // Timestamp FIRST, before any branching: the filter is bookkeeping, the
      // clock reading is the measurement.
      const at = process.hrtime.bigint()
      if (key.landscapeId !== LANDSCAPE) { emit({ foreign: 1 }); return }
      emit({ a: at.toString(), v: key.versionId })
    },
    onVersionCreated: () => { emit({ versionCreated: 1 }) },
  },
  { reconnectMs: RECONNECT_MS },
)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl < 0) break
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line === 'PING') {
      emit({ pong: process.hrtime.bigint().toString() })
    } else if (line === 'STOP') {
      void (async () => {
        await handle.stop().catch(() => {})
        await pool.end().catch(() => {})
        emit({ stopped: true })
        process.exit(0)
      })()
    }
  }
})

emit({ ready: true, pid: process.pid, clock: process.hrtime.bigint().toString() })
