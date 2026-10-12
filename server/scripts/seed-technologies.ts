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

import { pool } from '../src/db.js'
import { ensureAuthSchema } from '../src/auth/schema.js'
import { ensureTechnologySchema } from '../src/technologies/schema.js'
import {
  SEEDED_TECHNOLOGY_CATALOG_SIZE,
  seedTechnologyCatalog,
} from '../src/technologies/seed.js'

async function main(): Promise<void> {
  await ensureAuthSchema(pool)
  await ensureTechnologySchema(pool)

  const { rows: organizations } = await pool.query<{ id: string }>(
    `SELECT id FROM orgs WHERE status = 'active' ORDER BY id`,
  )

  for (const organization of organizations) {
    await seedTechnologyCatalog(pool, organization.id)
  }

  console.info(
    `[technology-seed] catalog=${SEEDED_TECHNOLOGY_CATALOG_SIZE} organizations=${organizations.length}`,
  )
}

main()
  .catch((error: unknown) => {
    console.error('[technology-seed] failed', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
