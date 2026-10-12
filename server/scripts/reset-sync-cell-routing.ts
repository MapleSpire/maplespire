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
 * Release the routing claims a restore reinstalled, keeping every fencing
 * token. The same statement also clears the PostgreSQL topology mirror; old
 * copies without the mirror table still have their claims released.
 *
 *   npm --prefix server run restore:reset-routing              # preview, writes nothing
 *   npm --prefix server run restore:reset-routing -- --apply   # releases the claims
 *   npm --prefix server run restore:reset-routing -- --apply --force
 *
 * PREVIEW IS THE DEFAULT and `--apply` is not optional sugar: this command
 * invalidates every routing claim in the database, and the operator running it
 * is by definition in the middle of a restore. Printing what it would do, and
 * requiring a second invocation to do it, is the difference between a tool and
 * a trap.
 *
 * `--force` is required when any unreleased claim carries an observed lease
 * expiry still in the FUTURE — which means it was written less than one lease
 * TTL ago (6–120 s, 15 s by default). That is either something already serving
 * this database, or a dump taken inside that window and restored fast (the
 * integration fixture in `restoreRoutingReset.integration.test.ts` constructs
 * the latter); the count cannot tell them apart. Releasing a claim
 * something holds refuses every write it makes until it restarts, so the refusal
 * is the point rather than an inconvenience. It is NOT a general "are cells
 * running" check and cannot be: the column it reads is written only on
 * acquisition, never on renewal.
 *
 * `restore:database` calls the same reset with `force`, because after a restore
 * into a verified-EMPTY target the benign reading is the likely one. That
 * arbitration is in `restore-database.ts`, not here.
 *
 * EVERY RUN PRINTS THE DATABASE IT TOUCHED, read from the server with
 * `current_database()`. `import 'dotenv/config'` means an unset
 * `RESET_DATABASE_URL` and `DATABASE_URL` silently fall through to
 * `server/.env` (typically the local developer stack). The connection string an
 * operator believes they passed and the database they hit are two different
 * facts, and only the second one is printed here.
 *
 * This command does NOT stop the cells before `pg_restore` — that step, part of
 * the full restore procedure, is what actually prevents the wedge.
 */
import 'dotenv/config'
import { Pool } from 'pg'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import {
  LiveLeasesPresentError,
  resetSyncCellOwnershipClaims,
} from '../src/syncCells/restoreRoutingReset.js'

async function main(): Promise<void> {
  const databaseUrl = process.env.RESET_DATABASE_URL ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('RESET_DATABASE_URL or DATABASE_URL is required')
  const apply = process.argv.includes('--apply')
  const force = process.argv.includes('--force')

  const pool = guardIdleClientErrors(new Pool({ connectionString: databaseUrl, max: 2 }), 'resetSyncCellRouting')
  try {
    const report = await resetSyncCellOwnershipClaims(pool, { mode: apply ? 'apply' : 'preview', force })
    console.log(JSON.stringify(report, null, 2))
    if (!apply) {
      console.log(
        `\nPREVIEW ONLY — nothing was written to ${report.target.database}. `
        + `${report.claimsReleased} live claim(s) would be released across `
        + `${report.claimingCells.length} cell id(s); every fencing_token would be left exactly as it is. `
        + 'Re-run with --apply to perform it.',
      )
      if (report.recentlyAcquiredClaims > 0) {
        console.log(
          `\n${report.recentlyAcquiredClaims} claim(s) carry an observed lease expiry in the future, so they `
          + 'were written less than one lease TTL ago — something is already serving this database, or the '
          + 'dump was taken inside that window. --apply will refuse without --force.',
        )
      }
    }
  } finally {
    // Reported, not swallowed and not rethrown: a rejection here would REPLACE
    // the real error from the block above, which is the one the operator needs.
    await pool.end().catch((error: unknown) => { console.error('pool teardown failed:', error) })
  }
}

main().catch((error: unknown) => {
  if (error instanceof LiveLeasesPresentError) {
    console.error(`\nREFUSED: ${error.message}`)
    console.error(JSON.stringify(error.report, null, 2))
  } else {
    console.error(error)
  }
  // `exitCode`, not `exit()`: `process.exit` tears the process down before a
  // piped or redirected stdout has flushed, so the report above is truncated
  // exactly when it is being captured for an incident record. Matches
  // `restore-database.ts`.
  process.exitCode = 1
})
