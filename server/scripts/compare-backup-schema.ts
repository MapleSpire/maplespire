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
import { Pool } from 'pg'
import { collectSchemaDefinitions } from '../src/backup/backupRestore.js'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL
  const restoredUrl = process.env.RESTORE_DATABASE_URL
  if (!sourceUrl || !restoredUrl) throw new Error('DATABASE_URL and RESTORE_DATABASE_URL are required')
  const source = guardIdleClientErrors(new Pool({ connectionString: sourceUrl, max: 1 }), 'compareBackupSchema:source')
  const restored = guardIdleClientErrors(new Pool({ connectionString: restoredUrl, max: 1 }), 'compareBackupSchema:restored')
  try {
    const sourceDefinitions = new Set(await collectSchemaDefinitions(source))
    const restoredDefinitions = new Set(await collectSchemaDefinitions(restored))
    const sourceOnly = [...sourceDefinitions].filter((definition) => !restoredDefinitions.has(definition))
    const restoredOnly = [...restoredDefinitions].filter((definition) => !sourceDefinitions.has(definition))
    console.log(JSON.stringify({
      event: 'backup.database.schema_comparison',
      sourceDefinitions: sourceDefinitions.size,
      restoredDefinitions: restoredDefinitions.size,
      sourceOnly,
      restoredOnly,
    }, null, 2))
    if (sourceOnly.length > 0 || restoredOnly.length > 0) process.exitCode = 1
  } finally {
    await Promise.all([source.end(), restored.end()])
  }
}

main().catch((error) => {
  console.error('[backup-schema-comparison] failed:', error)
  process.exitCode = 1
})
