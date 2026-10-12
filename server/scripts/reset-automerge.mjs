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

// Dev utility (authorized by the user): clear ONLY the corrupted shared-root
// pointer so the sync server rebuilds a clean root (with a valid modelUrl) on
// next start. Document chunks in `automerge_storage` are left intact (the old
// root just becomes orphaned); the frontend re-seeds the demo workspace when it
// finds the new model empty. `entities`, `theme_plugins`, `sync_state` untouched.
import { Pool } from 'pg'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10_000 })

try {
  const before = await pool.query("SELECT value FROM automerge_meta WHERE key = 'root_url'")
  console.log('current root_url:', before.rows[0]?.value ?? '(none)')
  const res = await pool.query("DELETE FROM automerge_meta WHERE key = 'root_url'")
  console.log(`deleted ${res.rowCount} root_url row(s). Restart the sync server to rebuild a fresh root.`)
} catch (err) {
  console.error('reset failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
