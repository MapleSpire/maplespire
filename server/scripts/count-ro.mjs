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
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire' })
const tables = ['ro_objects', 'ro_connections', 'ro_groups', 'ro_diagrams']
for (const t of tables) {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`)
    console.log(`${t} = ${rows[0].n}`)
  } catch (e) {
    console.log(`${t} = ERROR ${e.message}`)
  }
}
// sample a couple ids
const { rows: sample } = await pool.query(`SELECT id, name FROM ro_objects ORDER BY id LIMIT 3`)
console.log('sample objects:', JSON.stringify(sample))
const { rows: meta } = await pool.query(`SELECT key, length(value) AS len FROM automerge_meta WHERE key='root_url'`).catch(() => ({ rows: [] }))
console.log('meta:', JSON.stringify(meta))
await pool.end()
