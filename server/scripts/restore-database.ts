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
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { technologyAssetDirectory } from '../src/technologies/assets.js'
import {
  DockerPgTools,
  NativePgTools,
  restoreAndVerifyDatabase,
  restoreTargetPool,
  type PgTools,
} from '../src/backup/backupRestore.js'
import {
  resetSyncCellOwnershipClaims,
  SyncCellOwnershipSchemaMissingError,
} from '../src/syncCells/restoreRoutingReset.js'

/**
 * The database the reset actually TOUCHED, read from the server, for the
 * failure lines — the success path gets it from the reset's own
 * `sync.cell.restore_routing_reset` record.
 *
 * It is read rather than parsed out of the URL because that is this command
 * family's standing rule: `dotenv` makes an unset `RESTORE_DATABASE_URL` fall
 * through to `server/.env`, so the string an operator believes they passed and
 * the database they hit are two different facts, and only the second is worth
 * printing.
 *
 * Returns null rather than throwing, and that is the whole point of the inner
 * catch: this runs on a path that has already failed once, and a second failure
 * while fetching a LABEL must not replace the first. A null field says "could
 * not be read", which is true and is not the same as a wrong name.
 */
async function currentDatabase(pool: Pool): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ database: string }>('SELECT current_database() AS database')
    return rows[0]?.database ?? null
  } catch {
    return null
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function tools(): PgTools {
  const container = option('--docker-container') ?? process.env.BACKUP_POSTGRES_CONTAINER
  if (!container) return new NativePgTools()
  // Given together, these say the container holds only the client BINARIES and
  // the server is elsewhere — the form needed on a host with no client, or one
  // whose client is older than the server.
  const host = option('--docker-host') ?? process.env.BACKUP_POSTGRES_DOCKER_HOST
  const port = option('--docker-port') ?? process.env.BACKUP_POSTGRES_DOCKER_PORT
  if (!host && !port) return new DockerPgTools(container)
  const parsedPort = Number(port)
  if (!host || !Number.isInteger(parsedPort)) {
    throw new Error('--docker-host and --docker-port must be given together')
  }
  return new DockerPgTools(container, { host, port: parsedPort })
}

type RoutingResetOutcome =
  | {
    outcome: 'released'
    /** Echoed from the verification's own outcome — see the type fence on
     *  `releaseRestoredRoutingClaims`. It is in the line so the record says
     *  the reset ran after a PASSED verification, not merely after one. */
    afterVerification: 'passed'
    claimsReleased: number
    alreadyReleased: number
    claimingCells: string[]
    /** The number that WOULD have refused. Printed precisely because `force`
     *  below silences the refusal: a guard overridden in silence is the same
     *  thing as no guard. */
    recentlyAcquiredClaims: number
    /**
     * WHICH READING IT WAS. The number above cannot separate "a cell is
     * claiming this database right now" from "the dump was taken inside one
     * lease TTL"; those are an incident and a non-event. This discriminates
     * them: `writtenAfterEmptinessProof` counts rows whose
     * `acquired_at` is at or after the instant this target was PROVED to hold no
     * public table, and nothing carried in by `pg_restore` can be one of those.
     *
     * `null` is impossible on this path — the verification always returns the
     * instant — and the type keeps it only because `resetSyncCellOwnershipClaims`
     * is also reachable from `restore:reset-routing` run by hand, where there is
     * no proof to cite.
     */
    recentlyAcquiredBreakdown: { writtenAfterEmptinessProof: number; carriedByTheDump: number } | null
    highestFencingTokenBeforeReset: string | null
    forced: true
  }
  /** The bundle predates `ensureSyncCellOwnershipSchema`, so there is no
   *  `sync_workspace_ownership` to release and the restored copy is FINISHED.
   *  A separate outcome from `failed` because the exit codes differ — see the
   *  docblock below. */
  | { outcome: 'skipped'; reason: string; database: string | null }
  | { outcome: 'failed'; error: string; code: string | null; database: string | null }

/**
 * Release the routing claims the restore just reinstalled, keeping every
 * fencing token.
 *
 * ── WHERE THIS RUNS ──
 *
 * `restoreAndVerifyDatabase` issues no `UPDATE` and no `DELETE` against
 * `sync_workspace_ownership`: the restored table has to be comparable with the
 * source column for column, or the verification is checking its own writes.
 * This function writes to exactly that table, so the call must stay HERE, in
 * the script, after `restoreAndVerifyDatabase` has returned — never inside it
 * (`restoreRoutingReset.integration.test.ts` pins this).
 *
 * The `verifiedOutcome` parameter is a TYPE fence, not a runtime check:
 * `RestoreVerification['outcome']` is the single literal `'passed'` and
 * `restoreAndVerifyDatabase` THROWS on every failure, so a runtime
 * `if (outcome !== 'passed')` would be a dead branch. If a second outcome is
 * ever added, this call stops compiling.
 *
 * ── WHY IT FORCES, WHERE THE INTERACTIVE COMMAND DELIBERATELY DOES NOT ──
 *
 * `resetSyncCellOwnershipClaims` refuses without `force` when any unreleased row
 * carries an observed lease expiry in the FUTURE. At the command line that is
 * worth stopping for. Here it cannot mean the same thing.
 *
 * `restoreAndVerifyDatabase` refuses a target holding any public table
 * (`assertEmptyRestoreDatabase`), and that check runs BEFORE `pg_restore`. So
 * every ownership row here either came out of this process's own restore — with
 * an `acquired_at` copied from the source's past — or was written after that
 * emptiness was proven. Those are the only two possibilities, and the second is
 * the incident — which is possible, not excluded.
 *
 * A future expiry says the row was written less than one lease TTL ago (6-120 s,
 * 15 s default). After a dump-then-restore that is far more often "the dump was
 * taken inside that window" than "a cell has been pointed at the scratch copy
 * mid-restore" — and on a freshly restored copy, releasing is the right answer
 * under BOTH readings. Refusing would abort the reset on a restore that PASSED,
 * leave stale routing claims in place, and exit non-zero on a success. So:
 * force, and print `recentlyAcquiredClaims` so the number that would have
 * refused is on the operator's screen rather than swallowed by the flag that
 * overrode it.
 *
 * The two readings are separated by `acquired_at` against the instant
 * `assertEmptyRestoreDatabase` returned (`recentlyAcquiredBreakdown`). That
 * instant, not the manifest's `createdAt`: it is the tighter boundary (the two
 * differ by however long `pg_restore` ran), and reading it is permitted since
 * only UPDATE and DELETE are forbidden on this path.
 *
 * ── AND THE FAILURE IS REPORTED TWICE OVER, NEVER SWALLOWED ──
 *
 * The reset can fail for reasons that say nothing about the restore. Letting it
 * throw would report `backup.database.restore_failed` for a restore that
 * verified, which is a lie in the direction that loses work. So the outcome is
 * returned rather than thrown: `restore_verified` prints with every verification
 * fact, the outcome is inside it, and a dedicated stderr line carries the reason.
 *
 * BUT THE EXIT CODE HAS TO SPLIT THREE WAYS, NOT TWO. A bundle older than
 * `ensureSyncCellOwnershipSchema` has no `sync_workspace_ownership` at all. That
 * copy has nothing to release and is FINISHED; exiting non-zero and telling the
 * operator to run `restore:reset-routing --apply` would loop on the same
 * missing table, and the retry it invites would hit
 * `assertEmptyRestoreDatabase`.
 *
 * So: an explicit catalog observation that ownership is absent is `skipped`
 * and exits 0. It is an explicit check rather than a broad 42P01 catch:
 * another missing table must not make existing claims look absent. A copy with
 * ownership but no topology mirror still releases its claims. Every other error is `failed`
 * and exits 2, not 1, so that "restore
 * ok, post-step failed" stays distinguishable from "restore failed" for anything
 * reading the code. Nothing in this tree schedules this script (the drill calls
 * `restoreAndVerifyDatabase` directly, `drillRunner.ts`), so the audience for
 * that distinction is a human or an operator's own wrapper — which is a reason
 * to make it legible, not a reason to skip it.
 */
async function releaseRestoredRoutingClaims(
  targetDatabaseUrl: string,
  verifiedOutcome: 'passed',
  emptyAt: Date,
): Promise<RoutingResetOutcome> {
  // Built INSIDE the try. It cannot throw today — `parseDatabaseUrl` already
  // succeeded on this exact URL inside `restoreAndVerifyDatabase` — but with the
  // construction outside, a throw would reject this function instead of
  // returning an outcome, and `main`'s catch would print
  // `backup.database.restore_failed` for a restore that verified: exactly the
  // lie the paragraph above says this design prevents. Incidental safety made
  // structural, at the cost of one indent.
  let pool: Pool | null = null
  try {
    // The module's own builder, not a hand-rolled `new Pool`: same TLS posture
    // (`rejectUnauthorized: true` unless `sslmode=disable`) as the verification
    // pool that just ran against this very URL. Two pools onto one database with
    // different postures is a defect that only shows where TLS is real.
    pool = restoreTargetPool(targetDatabaseUrl)
    const report = await resetSyncCellOwnershipClaims(pool, { mode: 'apply', force: true, emptyAt })
    return {
      outcome: 'released',
      afterVerification: verifiedOutcome,
      claimsReleased: report.claimsReleased,
      alreadyReleased: report.alreadyReleased,
      claimingCells: report.claimingCells,
      recentlyAcquiredClaims: report.recentlyAcquiredClaims,
      recentlyAcquiredBreakdown: report.recentlyAcquiredBreakdown,
      highestFencingTokenBeforeReset: report.highestFencingToken,
      forced: true,
    }
  } catch (error) {
    // `code` is kept, not just `message`. `db/poolErrorGuard.ts` one directory
    // over says why in as many words: it is what an operator greps for — 57P01
    // admin shutdown, 57P02 crash shutdown, ECONNRESET a dropped socket — and
    // passing the error object alone buries it. The skip below instead needs
    // the named observation of ownership's absence, never a generic SQL code.
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : null
    const database = pool ? await currentDatabase(pool) : null
    if (error instanceof SyncCellOwnershipSchemaMissingError) {
      return {
        outcome: 'skipped',
        reason: 'this bundle predates sync_workspace_ownership, so the restored copy carries no routing claims',
        database,
      }
    }
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error), code, database }
  } finally {
    // Reported, not swallowed and not rethrown: a rejection here would REPLACE
    // the outcome above, which is the one the operator needs. Same shape as
    // `reset-sync-cell-routing.ts`.
    //
    // AND `pool.end()` IS LOAD-BEARING: pg-pool's `allowExitOnIdle` defaults to
    // false and is not set here, so the idle client and its timer hold the
    // process open. Measured spawn to exit: with `end()` ~175 ms; without it
    // ~10.2 s (pg-pool's default `idleTimeoutMillis` of 10 000 ms); without it
    // and with `idleTimeoutMillis: 0`, the process never exits.
    //
    // A CHECKED-OUT client would make `pool.end()` never resolve, but that does
    // not apply: `db.query()` checks out and gives back inside one call.
    if (pool) {
      await pool.end().catch((error: unknown) => { console.error('routing-reset pool teardown failed:', error) })
    }
  }
}

async function main(): Promise<void> {
  const sourceDatabaseUrl = process.env.DATABASE_URL
  const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL
  const bundleDirectory = option('--bundle') ?? process.env.BACKUP_DIRECTORY
  if (!sourceDatabaseUrl) throw new Error('DATABASE_URL is required for the source safety check')
  if (!targetDatabaseUrl) throw new Error('RESTORE_DATABASE_URL is required')
  if (!bundleDirectory) throw new Error('BACKUP_DIRECTORY or --bundle is required')

  // The icon volume goes back too, by default onto the volume the server
  // serves from. A disaster recovery that restored only PostgreSQL would come
  // back up with a catalog whose every logo 404s — and would look fine in every
  // check that only reads the database. Blobs are immutable under their content
  // hash, so this can only add files; an existing one is left untouched.
  const verification = await restoreAndVerifyDatabase({
    sourceDatabaseUrl,
    targetDatabaseUrl,
    bundleDirectory: resolve(bundleDirectory),
    pgTools: tools(),
    assetTargetDirectory: option('--asset-target') ?? technologyAssetDirectory(),
  })
  // AFTER the verification, never inside it. See `releaseRestoredRoutingClaims`:
  // the position is what keeps the verification free of its own writes, and
  // `verification.outcome` is passed so the compiler holds
  // the "only once it passed" half of the condition.
  const routingReset = await releaseRestoredRoutingClaims(
    targetDatabaseUrl,
    verification.outcome,
    // The instant the target was proved EMPTY, carried from the precheck rather
    // than re-read here: a clock read at this point is after `pg_restore`, and
    // would classify a claim written DURING the restore as benign.
    verification.emptyAt,
  )
  console.log(JSON.stringify({
    event: 'backup.database.restore_verified',
    ...verification,
    bundleDirectory: resolve(bundleDirectory),
    routingReset,
  }))
  if (routingReset.outcome === 'skipped') {
    // NOT a failure and NOT exit non-zero. There is no table to release, so the
    // restored copy carries no routing claims and is finished. Printed anyway,
    // on stderr, because "the reset did nothing" and "the reset did not run"
    // must not look the same in an incident record.
    console.error(JSON.stringify({
      event: 'backup.database.routing_reset_skipped',
      reason: routingReset.reason,
      database: routingReset.database,
    }))
    return
  }
  if (routingReset.outcome === 'failed') {
    // The restore itself verified and the line above says so. This one says the
    // restored copy still carries the dump's routing claims, so an operator who
    // brings cells up against it gets a `fence-mismatch` wedge. Exit 2, not 1: `main`'s catch uses 1 for "the restore failed", and
    // collapsing "restore ok, post-step failed" onto the same code throws away
    // the only distinction anything reading the code could act on.
    console.error(JSON.stringify({
      event: 'backup.database.routing_reset_failed',
      error: routingReset.error,
      code: routingReset.code,
      database: routingReset.database,
      remedy: 'RESET_DATABASE_URL=<target> npm --prefix server run restore:reset-routing -- --apply',
    }))
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'backup.database.restore_failed',
    outcome: 'failed',
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
