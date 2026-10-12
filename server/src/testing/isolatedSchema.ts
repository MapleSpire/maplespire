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
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * Per-suite isolated Postgres schema for DB-gated tests (the suites behind
 * `describe.skipIf(!process.env.TEST_DATABASE_URL)`).
 *
 * THE RULE: a DB-gated test suite must never read or write rows it did not
 * create — TEST_DATABASE_URL usually points at a database shared with a live
 * dev/e2e stack (see docs/auth-setup.md "Running the DB-gated tests"). Two
 * incidents motivated hard isolation instead of per-test cleanup discipline:
 *
 *  - Suites that resolved "the org" via `ensureDefaultOrg` mutated the REAL
 *    default org (suspend + epoch bump = every live session invalidated) and
 *    backfilled scope rows for every real workspace; one run left the shared
 *    default org recreated under a new id, orphaning existing sessions.
 *  - Five suites re-ran the same `ensureAuthSchema`/`ensureRbacSchema` DDL
 *    (DROP TRIGGER + CREATE TRIGGER inside transactions) on the same tables
 *    from parallel vitest workers → 'deadlock detected'.
 *
 * This helper gives each suite its own schema in whatever database
 * TEST_DATABASE_URL points at: `test_<name>` is dropped and recreated on
 * setup, and every pool connection pins `search_path` to it EXCLUSIVELY (no
 * `public` fallback — a query against a table the suite didn't create fails
 * loudly instead of silently hitting shared data). All `ensure*Schema` DDL,
 * `ensureDefaultOrg`, trigger functions, and sequences resolve into the
 * suite's schema, so suites can freely suspend "the default org", flip
 * platform admins, or backfill scopes without touching anything shared, and
 * parallel workers never contend on the same DDL locks.
 *
 * Known cross-schema leak: `pg_notify` channels are database-global, so
 * `bump_auth_epoch`'s NOTIFY reaches a live server listening on the same
 * database. Payloads are test-schema org ids that match no real org, so the
 * listener no-ops — acceptable noise. If even that must go, point
 * TEST_DATABASE_URL at a dedicated database.
 *
 * The schema name is fixed per suite (not random) so a crashed run leaves at
 * most one stale schema, self-healed by the next run's DROP … CASCADE.
 */
export interface IsolatedSchemaDb {
  /** Pool whose every connection has `search_path` pinned to the test schema. */
  pool: pg.Pool
  /** The schema name, e.g. `test_rbac_schema`. */
  schema: string
  /** End the pool and drop the schema. Call from `afterAll`. */
  teardown: () => Promise<void>
}

export async function createIsolatedSchemaDb(connectionString: string, name: string): Promise<IsolatedSchemaDb> {
  if (!/^[a-z][a-z0-9_]{0,48}$/.test(name)) {
    throw new Error(`isolated schema name must be a short snake_case identifier, got: ${name}`)
  }
  const schema = `test_${name}`

  const admin = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1 }), 'isolatedSchema:admin')
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.query(`CREATE SCHEMA ${schema}`)
  } finally {
    await admin.end()
  }

  // `options` rides the Postgres startup packet, so search_path is set before
  // the first query on EVERY pooled connection — no on('connect') race.
  const pool = guardIdleClientErrors(new pg.Pool({
    connectionString,
    max: 5,
    options: `-c search_path=${schema}`,
  }), 'isolatedSchema:pool')

  return {
    pool,
    schema,
    teardown: async () => {
      await pool.end().catch(() => {})
      const cleanup = guardIdleClientErrors(new pg.Pool({ connectionString, max: 1 }), 'isolatedSchema:cleanup')
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }
}
