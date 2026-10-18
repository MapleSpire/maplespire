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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  TEST_POSTGRES_SETTINGS,
  testPostgresStatements,
  tunePostgresForTests,
} from './ci-local-postgres.mjs'

/**
 * Regression: the DB-gated suites' hook timeouts under a busy `ci:local` run.
 * Their fixtures create/drop databases, every DROP DATABASE waits for a
 * checkpoint, and the checkpoint's disk syncs were the whole cost (see
 * ci-local-postgres.mjs for the measurement). The container must run with those
 * syncs off, including a container that was already running.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ciLocal = readFileSync(path.join(ROOT, 'scripts', 'ci-local.mjs'), 'utf8')

describe('ci:local Postgres is tuned for throwaway test data', () => {
  it('turns off exactly the three disk-sync knobs, and nothing that changes results', () => {
    assert.deepEqual(TEST_POSTGRES_SETTINGS, {
      fsync: 'off',
      synchronous_commit: 'off',
      full_page_writes: 'off',
    })
  })

  it('applies them with ALTER SYSTEM and reloads LAST, so a running container picks them up', () => {
    assert.deepEqual(testPostgresStatements(), [
      "ALTER SYSTEM SET fsync = 'off'",
      "ALTER SYSTEM SET synchronous_commit = 'off'",
      "ALTER SYSTEM SET full_page_writes = 'off'",
      'SELECT pg_reload_conf()',
    ])
  })

  it('runs every statement, in order, and lets a failure propagate', () => {
    const seen = []
    tunePostgresForTests((sql) => seen.push(sql))
    assert.deepEqual(seen, testPostgresStatements())

    assert.throws(
      () => tunePostgresForTests((sql) => {
        if (sql.startsWith('ALTER SYSTEM SET synchronous_commit')) throw new Error('psql refused')
      }),
      /psql refused/,
    )
  })

  it('is wired into ci-local, after the containers are healthy and before the database is recreated', () => {
    const code = ciLocal.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    const tune = code.indexOf('tunePostgresForTests((sql)')
    assert.ok(tune > 0, 'ci-local.mjs must call tunePostgresForTests')
    assert.ok(code.indexOf('await waitHealthy(PG_CONTAINER)') < tune, 'tune only after Postgres is healthy')
    assert.ok(tune < code.lastIndexOf('freshDatabase()'), 'tune before freshDatabase(), whose DROP already pays the checkpoint')
    assert.match(code, /import \{ tunePostgresForTests \} from '\.\/ci-local-postgres\.mjs'/)
  })
})
