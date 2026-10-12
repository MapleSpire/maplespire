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

import pg from 'pg'

/**
 * Build the schema ONCE before any test worker runs — test files execute in
 * parallel, and concurrent `CREATE TABLE IF NOT EXISTS` races on Postgres's
 * pg_type catalog. No-op (and integration suites skip themselves) when no
 * database is reachable.
 *
 * The TEST_DATABASE_URL-gated auth/RBAC suites don't need serializing here: each
 * one runs its DDL inside its own isolated schema (src/testing/isolatedSchema.ts),
 * so parallel workers never touch the same catalog objects (concurrent
 * DROP/CREATE TRIGGER runs otherwise deadlock).
 *
 * **This runs the same migrations `main()` runs**, via `schemaMigrations()`, so
 * there is no second list to fall behind the first. A hand-picked subset would
 * work only against a database some server had already booted against; on a
 * fresh one (what CI gets) the read-model SQL fails because it reads, e.g., the
 * tags tables directly.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
  const probe = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 })
  let reachable = false
  try {
    await probe.query('SELECT 1')
    reachable = true
  } catch {
    /* no DB — integration suites skip via their own probe */
  } finally {
    await probe.end().catch(() => {})
  }
  if (!reachable) return

  // Imported only once the database has answered: `db.js` builds its pool at
  // import time from DATABASE_URL, and there is no reason to open one for a run
  // that has no database.
  const { pool } = await import('./src/db.js')
  const { runMigrations } = await import('./src/db/migrations.js')
  const { schemaMigrations } = await import('./src/db/schemaMigrations.js')

  // Past this point the database answered, so a DDL failure is a real failure and
  // must not be swallowed: a silent one leaves every suite to fail later with a
  // missing-relation error that names a symptom instead of the cause.
  try {
    await runMigrations(pool, schemaMigrations(pool), { appliedBy: 'vitest', log: () => {} })
  } finally {
    await pool.end().catch(() => {})
  }
}
