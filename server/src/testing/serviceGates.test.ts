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

import { createClient } from 'redis'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * Assert the services the gated suites need are actually there.
 *
 * A fifth of this suite skips itself when `TEST_DATABASE_URL` / `TEST_REDIS_URL`
 * is unset — correct on a laptop, a false PASS in CI, where dropping the service
 * container silently removes those suites and the run stays green. Nothing in
 * the output distinguishes "ran everything" from "ran two thirds of it".
 *
 * So an environment that intends to run them says so, with `REQUIRE_DB_TESTS` /
 * `REQUIRE_REDIS_TESTS`, and this file fails fast and by name when the intent
 * and the reality disagree. It is deliberately paired with
 * `scripts/check-test-skips.mjs`, and each covers the other's blind spot: drop
 * the service and this fails in seconds with the connection error; drop
 * `REQUIRE_DB_TESTS` itself and this file goes quiet — but then it skips in
 * full, is not in the skip allowlist, and the post-run check fails instead.
 * Defeating both takes two deliberate edits, which is the point.
 */
describe('CI service gates', () => {
  it.skipIf(!process.env.REQUIRE_DB_TESTS)('TEST_DATABASE_URL is set and reachable', async () => {
    const url = process.env.TEST_DATABASE_URL
    expect(
      url,
      'REQUIRE_DB_TESTS is set, so this run intends to exercise the DB-gated suites, ' +
        'but TEST_DATABASE_URL is empty — every one of them would have skipped and the run ' +
        'would still have been green.',
    ).toBeTruthy()

    const pool = guardIdleClientErrors(new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 }), 'serviceGates')
    try {
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok')
      expect(rows[0]?.ok).toBe(1)
    } finally {
      await pool.end().catch(() => {})
    }
  })

  it.skipIf(!process.env.REQUIRE_REDIS_TESTS)('TEST_REDIS_URL is set and reachable', async () => {
    const url = process.env.TEST_REDIS_URL
    expect(
      url,
      'REQUIRE_REDIS_TESTS is set, so this run intends to exercise the Redis-gated suites, ' +
        'but TEST_REDIS_URL is empty — every one of them would have skipped silently.',
    ).toBeTruthy()

    const client = createClient({ url, socket: { connectTimeout: 5_000 } })
    try {
      await client.connect()
      expect(await client.ping()).toBe('PONG')
    } finally {
      await client.quit().catch(() => {})
    }
  })
})
