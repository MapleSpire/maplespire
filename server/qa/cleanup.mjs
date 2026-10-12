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

// Remove ALL Automerge data (QA + the user's root) so the workspace is clean.
// The legacy `entities` table is untouched, so restarting the server re-migrates
// the user's workspace from it.
//
// Usage: node qa/cleanup.mjs   (then restart the server)
import { Client } from 'pg'
import { PG } from './lib.mjs'

const c = new Client({ connectionString: PG })
await c.connect()
const before = await c.query('select count(*) n from automerge_storage')
await c.query('TRUNCATE automerge_storage')
await c.query('DELETE FROM automerge_meta')
await c.end()
console.log(`QA cleanup: cleared ${before.rows[0].n} storage rows + meta. RESTART THE SERVER to re-migrate the user workspace.`)
process.exit(0)
