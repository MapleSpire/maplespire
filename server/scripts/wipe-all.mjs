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

// Dev utility (authorized): full workspace wipe for a clean re-seed. Deletes the
// shared root pointer (server rebuilds a fresh empty root on next start), clears all
// Automerge doc chunks, and truncates the read-model tables. `entities`,
// `theme_plugins`, `sync_state` and the automerge_meta migration keys are untouched.
import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10_000 })

try {
  const r1 = await pool.query("DELETE FROM automerge_meta WHERE key = 'root_url'")
  console.log(`deleted ${r1.rowCount} root_url row(s)`)
  const r2 = await pool.query('TRUNCATE automerge_storage')
  console.log('truncated automerge_storage', r2.command)
  await pool.query('TRUNCATE ro_objects, ro_connections, ro_groups, ro_diagrams')
  console.log('truncated read-model tables (ro_*)')
  // The landscape/version registry pins root urls (resolveRootUrl serves
  // versions.root_url). After the doc chunks above are gone those refs dangle, AND
  // leaving the registry would DESYNC the default workspace after a reseed (clients
  // resolve the default root through it while the projector follows the fresh
  // automerge_meta root). Wipe it too; the server re-registers the fresh root as
  // the default landscape on next start. Guarded: older DBs may predate the tables.
  try {
    await pool.query('TRUNCATE versions, landscapes, landscape_versions CASCADE')
    console.log('truncated landscape registry (landscapes, versions, landscape_versions)')
  } catch {
    console.log('landscape registry tables absent — skipped')
  }
  console.log('DONE — restart the sync server to create a fresh empty root.')
} catch (err) {
  console.error('wipe failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
