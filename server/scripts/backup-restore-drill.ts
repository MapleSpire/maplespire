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

/**
 * One-shot drill from a source checkout. The orchestration itself lives in
 * `src/backup/drillRunner.ts` so that the scheduled container — which has no
 * tsx and no `scripts/` — runs exactly this code path rather than a second
 * implementation of it.
 */

import 'dotenv/config'
import { resolve } from 'node:path'
import { drillSummary, runBackupDrill } from '../src/backup/drillRunner.js'
import { pgToolsFromEnv } from '../src/backup/pgToolsFromEnv.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function documentProbeCount(): number {
  const value = option('--document-probes')
  if (value === undefined) return 64
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    throw new Error('--document-probes must be an integer between 0 and 1000')
  }
  return parsed
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const bundleDirectory = option('--output') ?? process.env.BACKUP_DIRECTORY
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!bundleDirectory) throw new Error('BACKUP_DIRECTORY or --output is required')

  const outcome = await runBackupDrill({
    databaseUrl,
    bundleDirectory: resolve(bundleDirectory),
    pgTools: pgToolsFromEnv(process.env, {
      container: option('--docker-container'),
      host: option('--docker-host'),
      port: option('--docker-port'),
    }),
    applicationRevision: process.env.BACKUP_APP_REVISION ?? process.env.APP_REVISION,
    maxDocumentProbes: documentProbeCount(),
    assetDirectory: option('--asset-directory') ?? process.env.TECHNOLOGY_ASSET_DIR,
    coldApi: process.argv.includes('--cold-api'),
    keepRestoreDatabase: process.argv.includes('--keep-target'),
    reportPath: option('--report') ?? process.env.BACKUP_DRILL_REPORT,
    // A one-shot run from a checkout does not own the operator's history or
    // their bundle directory; the scheduled container does. `--prune` opts in.
    retention: process.argv.includes('--prune')
      ? { bundleRoot: option('--prune-bundles') }
      : false,
  })

  // `restoreDatabaseDropped` comes out of the outcome, set only on the far side
  // of the drop — never from argv, which would state an intention and print it
  // as an observation.
  console.log(drillSummary(outcome, { keepTargetRequested: process.argv.includes('--keep-target') }))
  if (outcome.failure) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'backup.database.drill_failed',
    outcome: 'failed',
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
