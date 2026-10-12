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

import 'dotenv/config'
import { pool } from '../src/db.js'
import { repairPerformanceStaticManifests } from '../src/maintenance/staticManifestRepair.js'

async function main(): Promise<void> {
  const apply = process.env.STATIC_MANIFEST_APPLY === 'on'
  const result = await repairPerformanceStaticManifests(pool, { apply })
  console.log(JSON.stringify({ event: 'maintenance.static_manifest_repair', ...result }))
  if (!result.safeToApply) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[static-manifest-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
