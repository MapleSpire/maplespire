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

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { storageWriteApplicationName, storageWritePoolConfig } from './dbConfig.js'

/**
 * G4-16d: the storage WRITE pool's ceilings do what `storageWritePoolConfig`
 * says, against a real PostgreSQL — they ride the startup packet, so a
 * connection is born with them. What the handover barrier relies on: an old
 * owner's save cannot run, nor sit open, for ever, and its connection is
 * recognisable by name. TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)

function client(env: Record<string, string>) {
  const name = storageWriteApplicationName(randomUUID(), { SYNC_CELL_ID: 'g416d-test' })
  const config = storageWritePoolConfig(name, { DATABASE_URL: connection!, ...env })
  const errors: Error[] = []
  const c = new pg.Client(config)
  // A server-side termination arrives as an 'error' event; unhandled, it
  // would crash the run.
  c.on('error', (error) => { errors.push(error) })
  return { c, name, errors }
}

suite('storage write pool ceilings — real PostgreSQL', () => {
  it('a transaction left IDLE past idle_in_transaction_session_timeout is ended by the server', async () => {
    const { c, errors } = client({ AM_STORAGE_WRITE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '300' })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query('SELECT txid_current()')
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      // The session is gone: the next statement fails, and the open
      // transaction was rolled back with it.
      await expect(c.query('SELECT 1')).rejects.toThrow()
      expect(errors.map((error) => (error as { code?: string }).code ?? error.message).join(' '))
        .toMatch(/25P03|idle-in-transaction|terminat/i)
    } finally {
      await c.end().catch(() => undefined)
    }
  }, 30_000)

  it('a statement past statement_timeout is cancelled (57014), and the connection is tagged', async () => {
    const { c, name } = client({ AM_STORAGE_WRITE_STATEMENT_TIMEOUT_MS: '300' })
    await c.connect()
    try {
      const seen = await c.query<{ application_name: string; s: string; l: string; i: string }>(
        `SELECT application_name, current_setting('statement_timeout') AS s,
                current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i
           FROM pg_stat_activity WHERE pid = pg_backend_pid()`,
      )
      expect(seen.rows[0]).toEqual({ application_name: name, s: '300ms', l: '10s', i: '30s' })
      await expect(c.query('SELECT pg_sleep(3)')).rejects.toMatchObject({ code: '57014' })
    } finally {
      await c.end().catch(() => undefined)
    }
  }, 30_000)
})
