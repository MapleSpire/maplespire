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

import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

// Server-side test config. Node env (the server uses `pg` + node APIs). Pure
// logic tests run anywhere; the DB integration tests connect to a real Postgres
// (DATABASE_URL or the dev default) and skip themselves when none is reachable,
// so the suite stays green without a database while still catching regressions
// when one is present.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Run the schema migrations once (test files run in parallel; concurrent
    // CREATE TABLE races on pg_type). No-op without a database.
    globalSetup: ['./vitest.global-setup.ts'],
    // Per-file harness: AUTH_SECRET is PRESENT for every suite, so the
    // verification bodies that key off it actually run (see vitest.setup.ts).
    // Tests that need its absence delete it explicitly.
    setupFiles: ['./vitest.setup.ts'],
    // Isolated schemas/databases still share PostgreSQL's checkpointer. On
    // Docker Desktop, 31 and 16 workers exhausted cleanup bounds; the complete
    // suite passes at 8. Bound test-process concurrency while preserving the
    // timeouts and the run-mode default on hosts with at most nine CPUs.
    maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)),
    // The embedded/dev Postgres connect can take a moment on a cold pool.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // @automerge/automerge ships WASM/ESM that Vitest's transform must inline (the
    // projector wiring test drives an in-process Automerge repo).
    server: { deps: { inline: [/@automerge\//] } },
  },
})
