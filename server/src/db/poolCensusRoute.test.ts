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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The route that publishes the pool census is part of the instrument, so it
 * gets its own gate.
 *
 * `poolMeter.test.ts` and `poolMeter.integration.test.ts` prove the counters
 * are right. Neither notices if the endpoint is deleted, moved behind a token,
 * or rewritten to take a database connection — each of which breaks the
 * requirement that the census be readable without authentication from the
 * cell itself.
 *
 * `server/src/index.ts` cannot be imported in a unit test (it opens listeners,
 * connects pools and starts timers at module scope), so this reads it as
 * SOURCE, like the gate in `poolErrorGuard.test.ts`: it checks the text, not
 * the behaviour. The behaviour is covered by `auth/authCore.test.ts`, which
 * drives the real `requireAuth()` middleware against `/health/pools`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(path.join(HERE, '..', 'index.ts'), 'utf8')
const NGINX = readFileSync(path.join(HERE, '..', '..', '..', 'docker', 'nginx', 'nginx.conf'), 'utf8')

/** The registration line plus everything up to the closing `})` of its handler. */
function censusHandler(): string {
  const start = INDEX.indexOf("app.get('/api/health/pools'")
  expect(start, 'the pool census route is not registered in index.ts').toBeGreaterThan(-1)
  const end = INDEX.indexOf('\n})', start)
  expect(end, 'could not find the end of the census handler').toBeGreaterThan(start)
  return INDEX.slice(start, end)
}

describe('the pool census route', () => {
  it('is registered under /api/health, which is the prefix that makes it unauthenticated', () => {
    // Not `/api/platform/...` and not `/metrics`: `ALLOWLISTED_PREFIXES` in
    // `auth/middleware.ts` admits `/health`, and nothing else here would.
    expect(INDEX).toContain("app.get('/api/health/pools'")
  })

  it('serves the meter, not something reconstructed beside it', () => {
    expect(censusHandler()).toContain('poolMeterSnapshots()')
  })

  it('takes no admin guard and no metrics token', () => {
    // The two ways this endpoint could quietly stop being readable from the
    // cell. `/metrics` beside it requires a token deliberately, because it
    // publishes workspace counts and process memory; this one publishes only
    // pool counts and ages.
    const handler = censusHandler()
    expect(handler).not.toContain('METRICS_TOKEN')
    expect(handler).not.toContain('requirePlatformAdmin')
    expect(handler).not.toContain('req.header(')
  })

  it('does no I/O, so it can answer for a pool that has nothing left to give', () => {
    // The property the endpoint exists for: a census that had to borrow a
    // connection would fail on precisely the exhausted pool it describes.
    const handler = censusHandler()
    for (const forbidden of ['pool.', 'await', '.query(', '.connect(', 'redis']) {
      expect(handler, `census handler must not reference ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('is NOT reachable through the public edge', () => {
    // Unauthenticated is acceptable only from the cell itself.
    // `docker/nginx/nginx.conf` proxies the `/api/` prefix to the backend, so
    // without an exact-match rule the census would be published to the
    // internet. An exact-match `location` outranks a prefix one regardless of
    // order in the file.
    expect(NGINX).toMatch(/location\s*=\s*\/api\/health\/pools\s*\{[^}]*return\s+404;/)
  })

  it('the gate can fail — the negative control', () => {
    // Without this, every assertion above passes against an `INDEX` that failed
    // to load, or a `censusHandler()` that returned the empty string: `not
    // .toContain` is true of nothing at all, and most tests here are negative
    // assertions.
    expect(INDEX.length).toBeGreaterThan(1000)
    expect(censusHandler().length).toBeGreaterThan(20)
    expect(censusHandler()).toContain('res.json')
    // The nginx arm's control: the file loaded, and the prefix it has to
    // outrank is really there.
    expect(NGINX).toContain('location /api/ {')
  })
})
