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

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import {
  BOOT_SWEEP_CEILING_MS,
  runBackupDrill, drillSummary, partialSweepMinimumAgeMs, sweepOrphanedRestoreDatabasesAtBoot,
} from './drillRunner.js'
import { runDrillTick } from './drillTick.js'
import { closeLockPoolWithCeiling } from './lockPoolTeardown.js'
import {
  abortGraceMs, bundleName, bundleRootFrom, deadlineMs, intervalMs, maxDrillHoldMs,
} from './drillSchedule.js'
import {
  createSchedulerHeartbeat, drillMetricsPort, schedulerPhaseBudgets,
} from './schedulerHeartbeat.js'
import { startMetricsListener } from '../runtime/metricsListener.js'
import { settleAbandonment } from './drillAbandonment.js'
import type { DrillAbandonment } from './drillTick.js'
import { pgToolsFromEnv } from './pgToolsFromEnv.js'
import { bundleBudgetBytes, drillHistoryBudgetBytes } from './retention.js'

/**
 * The container entrypoint: run the drill forever, on a cadence.
 *
 * Built as a supervised loop rather than a cron entry for three reasons:
 *
 *  - **A failed drill must not stop the schedule.** A crash-looping container is
 *    a container that produces no evidence, and the whole point of the
 *    last-success-age gauge is that it keeps rising while nobody notices. The
 *    loop logs the failure, records it, and waits for the next tick. Only a
 *    configuration error — a missing DATABASE_URL — exits non-zero, because that
 *    one will never fix itself.
 *  - **It runs once at boot.** A fresh deployment otherwise spends its first
 *    interval reporting NaN for last-success age, which is indistinguishable
 *    from an installation whose drill has never worked.
 *  - **An advisory lock, not an assumption.** Two schedulers — a rolling deploy,
 *    a `docker compose up` against a stack that was already running — must not
 *    dump concurrently. The lock is session-scoped and released when the holder
 *    dies, so a killed container does not wedge the next one.
 *
 *    Session-scoped means the lock must be taken on a checked-out client held
 *    for the whole run: taken through `pool.query`, it would die with the idle
 *    client `pg-pool` destroys after `idleTimeoutMillis` (10 s by default).
 *    `runDrillTick` holds the client and reports what the release returned;
 *    see `sessionAdvisoryLock.ts`. A held lock means a wedged holder would
 *    starve every rival, so liveness comes from a per-tick deadline and a
 *    process that ENDS, never from a lock that weakens. The argument is in
 *    `drillTick.ts`; the numbers are `deadline` and `grace` below, both
 *    printed at boot.
 */

const LOCK_KEY = 7_243_119_002

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }))
}

/**
 * Record the abandonment, return the key, then end the process — in that order.
 *
 * The ordering argument is on `settleAbandonment`: the key comes back LAST
 * because an abandoned drill is still running, so every second between the key
 * being free and this process dying is a second in which a rival may dump and
 * sweep the same bundle root.
 *
 * Everything here is best-effort and bounded. A witness that can hang is a new
 * way to hold the very key this path exists to return.
 */
async function abandonAndExit(report: DrillAbandonment, startedAt: number): Promise<void> {
  const env = process.env
  // Set before the first await, not after the last one. Every timer on this
  // path is unref'd — deliberately, so none of them can delay the exit — which
  // means the loop can legitimately drain while this function is still in
  // flight. Node would then exit on its own, and with the assignment at the
  // bottom it would exit **0**: an abandoned drill reporting success to the
  // orchestrator, which is the one outcome that must not be reachable.
  process.exitCode = 1
  // Guarded at construction, not afterwards: an unhandled idle-client `'error'`
  // kills the process, and this path exists precisely because a connection has
  // already misbehaved. Logged rather than swallowed, since this path's purpose
  // is to leave a record; not thrown, since the exit code is already 1.
  const pool = guardIdleClientErrors(new Pool({
    connectionString: env.DATABASE_URL,
    // TWO, and this is not a spare. `settleAbandonment` runs two bounded steps,
    // and `withCeiling` bounds a statement without CANCELLING it — an abandoned
    // query keeps its client for good. On `max: 1` a stalled first step would
    // therefore guarantee the second fails on a connection timeout, in exactly
    // the black-holed-socket case this whole path exists for: the durable
    // record lost, or the key not returned, precisely when it matters.
    max: 2,
    connectionTimeoutMillis: 10_000,
  }), 'drill-abandonment', log)
  try {
    await settleAbandonment(pool, report, {
      startedAt: new Date(startedAt),
      bundleDirectory: resolve(bundleRootFrom(env)),
      applicationRevision: env.BACKUP_APP_REVISION ?? env.APP_REVISION,
    }, { log })
  } catch (error) {
    // `settleAbandonment` catches both of its own steps, so nothing should
    // reach here. It is kept because what follows it is `process.exit(1)`, and
    // a throw that skipped that would leave a scheduler alive with a drill it
    // has already declared abandoned — the stall, reached through the machinery
    // added to end it.
    log('backup.drill_abandonment_settle_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  // NOT awaited, and that is the point of the ordering above. The key has just
  // come back and the abandoned drill is still running unprotected, so the
  // distance from here to `exit` is the window a rival can dump inside. Closing
  // the pool politely would add up to ten seconds to it for no benefit — the
  // process is about to die and the kernel closes the sockets. The `catch` is
  // only so an unhandled rejection cannot outlive it.
  void pool.end().catch(() => undefined)
  // Flushed before exiting: on POSIX a pipe stdout is asynchronous and
  // `process.exit` may truncate it, and these lines are the only account of
  // why the container restarted.
  process.stdout.write('', () => { process.exit(1) })
  const floor = setTimeout(() => { process.exit(1) }, 2_000)
  floor.unref?.()
}

async function main(): Promise<void> {
  const env = process.env
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  // BACKUP_BUNDLE_ROOT, not BACKUP_DIRECTORY — the argument and its guard are
  // on `bundleRootFrom`, which has a test.
  const bundleRoot = resolve(bundleRootFrom(env))
  const interval = intervalMs(env)
  const deadline = deadlineMs(env, interval)
  const grace = abortGraceMs(env)
  const maxDrillHold = maxDrillHoldMs(env, interval, grace)
  const coldApi = env.BACKUP_DRILL_COLD_API !== 'off'
  const historyBudgetBytes = drillHistoryBudgetBytes(env)
  const bundleBudget = bundleBudgetBytes(env)

  // Bound BEFORE `mkdir`, on purpose. `mkdir` is an await on a filesystem this
  // process does not own — the bundle root is a volume — and if it neither
  // returns nor throws, no log line is ever written and no row is ever
  // inserted. Bound first, that window reads as `phase="starting"` with a
  // climbing age, which separates it from a container that is merely young.
  // (See `schedulerHeartbeat.ts` for the listener answering while the loop is
  // stuck.)
  const heartbeat = createSchedulerHeartbeat(schedulerPhaseBudgets({
    bootSweepCeilingMs: BOOT_SWEEP_CEILING_MS,
    deadlineMs: deadline,
    abortGraceMs: grace,
    intervalMs: interval,
  }))
  const metricsPort = drillMetricsPort(env, log)
  // Not awaited into a variable that anything depends on, and never fatal: this
  // container's contract is that nothing observational may prevent a drill.
  // A null listener means the port could not be bound; the drill runs unwatched
  // and `BackupDrillContainerDown` fires, which is the correct report.
  const metrics = await startMetricsListener({
    port: metricsPort,
    token: env.METRICS_TOKEN,
    collect: () => heartbeat.samples(),
    // The PREFIX is applied here, not in the module: `runtime/metricsListener`
    // is generic and must not stamp `backup.drill_*` on another caller's events.
    log: (event, fields) => log(`backup.drill_${event}`, fields),
  })

  await mkdir(bundleRoot, { recursive: true })
  log('backup.drill_scheduler_started', {
    // Printed because an operator debugging a dead `up{job="backup-drill"}`
    // needs to know whether this process ever bound anything, and because an
    // unset METRICS_TOKEN produces the same 404 the API's route does — which
    // reaches Prometheus as a failed scrape, indistinguishable from a dead
    // container.
    metricsPort: metrics?.port ?? null,
    // 0.0.0.0 or 127.0.0.1 decides whether the `prometheus` container can reach
    // this at all, and the two fail identically from the outside.
    metricsAddress: metrics?.address ?? null,
    metricsTokenSet: Boolean(env.METRICS_TOKEN),
    intervalHours: interval / 3_600_000,
    // Printed so an operator can answer "how long can one drill hold the key".
    deadlineHours: deadline / 3_600_000,
    abortGraceSeconds: grace / 1000,
    // Printed because the boot sweep below derives its age gate from it, and a
    // number a sweep deletes databases by should not be invisible.
    maxDrillHoldHours: maxDrillHold / 3_600_000,
    bundleRoot,
    coldApi,
    historyBudgetBytes,
    bundleBudgetBytes: bundleBudget,
    signed: Boolean(env.BACKUP_DRILL_SIGNING_KEY),
  })
  if (!env.BACKUP_DRILL_SIGNING_KEY) {
    // Loud, but not fatal: an unsigned record of a real restore beats no record.
    log('backup.drill_reports_unsigned', {
      detail: 'BACKUP_DRILL_SIGNING_KEY is not set; reports will be stored unsigned',
    })
  }

  let stopping = false
  let wake: (() => void) | null = null
  // The in-flight tick's stop. `wake` is only non-null while the loop SLEEPS,
  // so without this a SIGTERM during a drill would do nothing until the drill
  // finished on its own — never, if it is wedged — and SIGKILL would take the
  // container mid-dump. Aborting gives `pg_dump` a chance to die and the drill
  // a chance to tear down first.
  const stopper = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopping = true
      log('backup.drill_scheduler_stopping', { signal })
      // GUARDED: the handler is installed for SIGTERM *and* SIGINT, so a second
      // delivery — an orchestrator retry, or an operator reaching for
      // `docker compose kill -s INT` — would otherwise re-enter `stopping`,
      // reset its age and rewind the teardown clock to zero.
      //
      // The listener deliberately stays UP through all of this. A drill
      // aborting into its grace is the state an operator most needs a number
      // for, and `phase="stopping"` with a climbing age is that number; closing
      // the port here would replace it with a bare `up == 0` that says only
      // "gone". It is closed after the loop instead.
      if (!stopper.signal.aborted) {
        heartbeat.enter('stopping')
        stopper.abort(new Error(`received ${signal}`))
      }
      wake?.()
    })
  }

  // Before the first tick, and after the signal handlers above — which means the
  // handlers EXIST while it runs, not that the sweep observes them: it cannot be
  // cancelled, and a stop arriving here is answered by the loop below refusing
  // to start rather than by the sweep stopping. That is bounded because the
  // sweep's budget stops it STARTING new drops well before its ceiling.
  //
  // It reclaims restore databases a previous PROCESS left behind — the runs
  // whose teardown never happened because they were abandoned, SIGKILLed, or
  // lost with the host. On a healthy deployment the next drill's own teardown
  // would have done it; the case this covers is a deterministic wedge under
  // `restart: always`, where teardown never runs again at all.
  //
  // `.catch` even though the function is documented never to throw: a
  // rejection here would escape `main()`, exit non-zero before a single byte is
  // dumped, and under `restart: always` become a crash loop with no backups. A
  // janitorial step may not veto the copy — enforced at the call site rather
  // than trusted at the definition.
  heartbeat.enter('boot_sweep')
  await sweepOrphanedRestoreDatabasesAtBoot({
    databaseUrl,
    // The longest a live drill elsewhere can still own one, under this
    // deployment's configuration. Passed rather than re-derived inside so the
    // two numbers cannot drift from the ones printed at boot.
    maxDrillHoldMs: maxDrillHold,
    log,
  }).catch((error: unknown) => {
    log('backup.drill_boot_sweep_escaped', {
      detail: 'the boot sweep rejected despite its own guarantee; the drill starts anyway',
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })

  while (!stopping) {
    const startedAt = Date.now()
    // Set here rather than around `runDrillTick` alone: the pool construction
    // and its `connectionTimeoutMillis` are part of the tick's cost, and a
    // scheduler that cannot reach Postgres at all is precisely a wedge this is
    // meant to name.
    heartbeat.enter('running')
    // The LOCK's pool, and nothing else's. `runBackupDrill` opens its own
    // connections from `databaseUrl` and never touches this one.
    //
    // TWO clients. The first is checked out and held for the whole drill — that
    // is the exclusion. The second exists for a single question: when the
    // lock's heartbeat reports a loss it cannot substantiate, `runDrillTick`
    // asks an INDEPENDENT session whether the key is still ours, and the answer
    // decides between aborting a six-hour dump and letting it run without a
    // verified exclusion.
    //
    // Guarded because, with no listener, node-postgres lets an idle-client
    // error surface as an UNCAUGHT exception, and this standalone entrypoint
    // has no `uncaughtException` handler — that would be the whole container.
    const lockPool = guardIdleClientErrors(new Pool({
      connectionString: databaseUrl,
      max: 2,
      // A ceiling, so an unreachable Postgres is an ERROR rather than a silent
      // wedge.
      connectionTimeoutMillis: 30_000,
      // The CLIENT's keepalive — a second line of defence only. The connection
      // sits silent for the drill's whole duration, the shape a stateful
      // firewall or NAT drops without telling either end, but this flag cannot
      // be the detector: `socket.setKeepAlive(true)` with no delay leaves
      // Linux's `tcp_keepalive_time` at 7 200 s, and a client whose heartbeat is
      // in flight has unacked data, so the kernel hands it to retransmission
      // (`tcp_retries2`, ~15 min) instead. It is kept for the case the
      // heartbeat is off.
      //
      // What brings the key back is the other end: `acquireSessionAdvisoryLock`
      // lowers the SERVER's keepalives on the lock's own session, and the idle
      // server reaps the backend within `DEFAULT_KEEPALIVES` (about six minutes).
      keepAlive: true,
      // So `pg_stat_activity` names the holder when an operator asks who is
      // sitting on the key.
      application_name: 'maplespire-backup-drill',
    }), 'drill-lock', log)
    try {
      const outcome = await runDrillTick({
        pool: lockPool,
        lockKey: LOCK_KEY,
        log,
        deadlineMs: deadline,
        abortGraceMs: grace,
        signal: stopper.signal,
        // An abandoned tick means the key is STILL HELD by this session and the
        // drill may still be dumping, so the only way to return the key without
        // letting a rival dump concurrently is for this backend to die. The
        // default `abandon` already ends the process; this one first leaves a
        // durable record, because a terminal state recorded only on stdout is
        // easily lost.
        abandon: (report) => { void abandonAndExit(report, startedAt) },
        drill: async (signal) => {
          const outcome = await runBackupDrill({
            signal,
            databaseUrl,
            bundleDirectory: join(bundleRoot, bundleName(new Date())),
            pgTools: pgToolsFromEnv(env),
            applicationRevision: env.BACKUP_APP_REVISION ?? env.APP_REVISION,
            assetDirectory: env.TECHNOLOGY_ASSET_DIR,
            coldApi,
            reportPath: join(bundleRoot, 'latest-report.json'),
            retention: {
              historyBudgetBytes,
              bundleRoot,
              bundleBudgetBytes: bundleBudget,
              // Derived from `maxDrillHold`, never a literal: it is the longest
              // a drill can hold the key, so it is exactly the age below which
              // an unfinished bundle may still be receiving bytes from a
              // `pg_dump` whose scheduler process has already exited. The
              // one-shot CLI passes nothing here and therefore deletes none.
              partialMaxAgeMs: partialSweepMinimumAgeMs(maxDrillHold),
            },
          })
          console.log(drillSummary(outcome, { scheduled: true }))
        },
      })
      if (outcome.status === 'abandoned') {
        // Belt AND braces. `abandon` above already ends the process, but
        // through an asynchronous stdout flush, and callers of an `abandoned`
        // outcome must not carry on: break the loop rather than sleep and take
        // another tick against a key this same live session is sitting on.
        log('backup.drill_scheduler_abandoning', { ...outcome.abandonment })
        break
      }
    } catch (error) {
      // Deliberately swallowed. See the header: the schedule outliving one bad
      // run is the property that makes the age gauge meaningful.
      log('backup.drill_scheduler_error', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // A ceiling, because `connectionTimeoutMillis` above does NOT cover
      // `end()`: pg-pool's `ending` branch waits for every client to come back
      // and arms no timer. One checked-out client that is never given back
      // makes `end()` never resolve, so this `finally` would eat the loop and
      // no further tick would ever run, with a live process and a calm log. An
      // orphaned pool costs a socket; a scheduler that stops silently costs
      // every backup after it.
      //
      // The behaviour and its test live in `lockPoolTeardown.ts`, because
      // importing this module starts a scheduler and nothing here can be tested
      // in place.
      await closeLockPoolWithCeiling(lockPool, log)
    }

    if (stopping) break
    // From the START of the run, so a slow drill does not push the schedule
    // later every day; a run that overran its interval starts the next one
    // immediately rather than accumulating drift.
    const delay = Math.max(60_000, interval - (Date.now() - startedAt))
    heartbeat.enter('sleeping')
    log('backup.drill_scheduler_sleeping', { seconds: Math.round(delay / 1000) })
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, delay)
      wake = () => {
        clearTimeout(timer)
        resolveSleep()
      }
    })
    wake = null
  }
  // LAST, so the port answers for as long as this process runs — including the
  // whole teardown, where `phase="stopping"` is the number worth having.
  //
  // This is NOT what keeps the listener from delaying the exit — the listening
  // handle and every accepted socket are unref'd for that, which also covers
  // paths that never reach this line (`mkdir` throwing, `main()` rejecting).
  // See `metricsListener.ts`. What this buys is that `up == 0` becomes true
  // when the scheduler is done rather than whenever the process finally goes.
  await metrics?.stop()
  log('backup.drill_scheduler_stopped')
}

main().catch((error) => {
  // Only configuration errors reach here, and they do not fix themselves —
  // exiting non-zero lets the orchestrator's restart policy surface it.
  console.error(JSON.stringify({
    event: 'backup.drill_scheduler_failed',
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
