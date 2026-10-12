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
 * T-B4q, FIRST HALF — does one blocked query freeze every later reconciliation,
 * and does anything in the telemetry say so?
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... \
 *     npx tsx qa/reconcile-wallclock-bench.mts ../reports/TB4q-raw.json
 *
 * THE ORDER IS THE TASK. T-B4q's exit criterion demands this measurement BEFORE
 * any remedy, because a remedy laid on a supposition is a remedy nobody can
 * falsify. So this file asserts nothing about what SHOULD happen; it reports
 * what does.
 *
 * WHY A REAL LOCK AND NOT A FAKE POOL. A stub whose `query` returns a promise
 * that never settles would demonstrate the single-flight freeze just as well,
 * and would be faster and deterministic. It would also be useless for the
 * second half: the remedy has to be a bound POSTGRES applies
 * (`statement_timeout`), and a fake pool cannot exercise one. `LOCK TABLE
 * versions IN ACCESS EXCLUSIVE MODE` from a second session blocks the pass's
 * `SELECT ... FROM versions` in the real server, which is the same hang the
 * remedy will have to survive.
 *
 * THE PREMISE THIS FILE IS ALLOWED TO CONTRADICT. The task's own note says
 * "rien dans la télémétrie ne dit « la réconciliation est coincée »". That may
 * be too strong: `reassertHeldFences` is the LAST step of `performReconcile`,
 * so a pass frozen before it stops advancing `fenceReadingObservedAt`, and
 * `fenceReadingCurrent` is derived from that — which an operator could act on
 * even though it names the wrong subject. Every snapshot field is therefore
 * diffed across the freeze and REPORTED, rather than the claim being repeated.
 * Reading a field list is how the last two tasks on this arc found their own
 * premises to be false.
 *
 * THE OBSERVATION WINDOW IS NOT A REMEDY. `Promise.race` against a timer is used
 * here only to answer "had it settled by T?", and the losing promise is left
 * attached and later drained by releasing the lock. It must NOT become the fix:
 * a race does not cancel a pg query, it orphans a borrowed client — the defect
 * already measured in `sessionAdvisoryLock.ts`.
 */
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { createClient } from 'redis'
import pg from 'pg'
import { envNumber } from '../src/envNumber.js'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { ensureSyncCellOwnershipSchema } from '../src/syncCells/ownership.js'
import { SyncCellOwnershipCoordinator } from '../src/syncCells/ownership.js'
import type { SyncCellOwnershipConfig } from '../src/syncCells/ownership.js'
import type { RedisRuntime } from '../src/runtime/redis.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const REDIS_URL = process.env.TEST_REDIS_URL
const OUT = process.argv[2]
if (!DATABASE_URL || !REDIS_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero.
  throw new Error('T-B4q needs TEST_DATABASE_URL and TEST_REDIS_URL; refusing to report nothing')
}
if (!OUT) throw new Error('usage: tsx qa/reconcile-wallclock-bench.mts <output.json>')

/** How long to wait before concluding "it had not settled". Generous relative to
 *  a warm pass, which M2 measures in single-digit milliseconds at this scale. */
const OBSERVE_MS = 5_000
const WORKSPACES = 8
/**
 * The per-statement ceiling under test. It MUST be settable, and the default
 * MUST be the unbounded-in-practice one, because this file has to be able to
 * report both halves of the task:
 *
 *  - at a ceiling far above the observation window (the 30 s production
 *    default), the freeze is still a freeze inside 5 s — that is the DEFECT,
 *    and it is what the first run of this bench recorded;
 *  - at a ceiling below it, the statement is cancelled by the server, the pass
 *    REJECTS, `reconcileNow`'s `.finally` runs, `reconcileFlight` clears, and
 *    the next pass runs — that is the exit witness.
 *
 * Same lock, same code, one number different. A witness that needed a different
 * fixture from the defect would not be a witness.
 */
const CEILING_MS = envNumber('SYNC_CELL_STATEMENT_TIMEOUT_MS', {
  fallback: 30_000,
  // The floor is not decoration here, and a repo lint rule is what forced this
  // to stop being `Number(...)`. A dangling `SYNC_CELL_STATEMENT_TIMEOUT_MS=`
  // is '', `Number('')` is 0, and `SET LOCAL statement_timeout = 0` means NO
  // TIMEOUT in PostgreSQL — so a blank would have made this bench measure the
  // DEFECT while reporting the remedy, which is the one lie it exists to
  // prevent.
  minimum: 100,
  maximum: 300_000,
  integer: true,
})

interface Settled { settled: boolean; ms: number; error: string | null }

/** Answers "had it settled by OBSERVE_MS?" WITHOUT detaching the promise. The
 *  loser keeps running and is drained later; nothing here cancels anything. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<Settled> {
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  const sentinel = Symbol('not-settled')
  const outcome = await Promise.race([
    promise.then(() => null).catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
    new Promise<typeof sentinel>((resolve) => { timer = setTimeout(() => resolve(sentinel), ms) }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome === sentinel) return { settled: false, ms: performance.now() - started, error: null }
  return { settled: true, ms: performance.now() - started, error: outcome }
}

async function main(): Promise<void> {
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `sync_cell_tb4q_${randomBytes(4).toString('hex')}`)
  const prefix = `tb4q-${randomBytes(6).toString('hex')}`
  const redis = createClient({ url: REDIS_URL })
  await redis.connect()
  const runtime = {
    configured: true,
    get ready() { return redis.isReady },
    prefix,
    send<T>(args: string[]) { return redis.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

  // A SECOND connection, outside the coordinator's pool, whose only job is to
  // hold the lock. It must not come from `db.pool`: taking the lock there could
  // starve the very pool under measurement and would confound "blocked on a
  // lock" with "blocked waiting for a client".
  const blocker = new pg.Client({ connectionString: DATABASE_URL, options: `-c search_path=${db.schema}` })
  await blocker.connect()

  const report: Record<string, unknown> = {
    measureId: 'TB4q-raw',
    task: 'T-B4q',
    observeMs: OBSERVE_MS,
    statementCeilingMs: CEILING_MS,
    ceilingCanFireInsideTheObservationWindow: CEILING_MS < OBSERVE_MS,
    workspaces: WORKSPACES,
    schema: db.schema,
  }

  try {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        kind TEXT NOT NULL DEFAULT 'version'
      );
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', ['tb4q', 'tb4q'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
       SELECT 'v' || i, 'tb4q', 'v' || i, 'automerge:root-' || i, 'active', 'version'
         FROM generate_series(1, $1) AS i`,
      [WORKSPACES],
    )

    const config: SyncCellOwnershipConfig = {
      enabled: true,
      cellId: 'tb4q-cell',
      advertiseUrl: 'http://tb4q.internal:3001',
      leaseTtlMs: 600_000,
      renewIntervalMs: 300_000,
      partitionLeaseTtlMs: 60_000,
      partitionRenewIntervalMs: 20_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      // Long enough that no timer fires inside the measurement: a scheduled pass
      // landing mid-run would be attributed to the pass being observed.
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      reconcilePassDeadlineMs: 300_000,
      concurrency: 16,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: 'tb4q',
    } as SyncCellOwnershipConfig

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    await coordinator.start()

    const afterStart = coordinator.snapshot()
    // VOID rules, asserted rather than assumed: a coordinator that discovered
    // nothing would freeze just as convincingly while measuring nothing.
    if (afterStart.expectedWorkspaceCount !== WORKSPACES || afterStart.ownedWorkspaceCount !== WORKSPACES) {
      throw new Error(`VOID: expected=${afterStart.expectedWorkspaceCount} owned=${afterStart.ownedWorkspaceCount}`)
    }
    report.void = false

    // ── CONTROL ─────────────────────────────────────────────────────────────
    // Without the lock, two passes in a row settle. Without this arm, "it did
    // not settle" would not distinguish the freeze from a coordinator that
    // never reconciles at all.
    const controlFirst = await settledWithin(coordinator.reconcileNow(), OBSERVE_MS)
    const controlSecond = await settledWithin(coordinator.reconcileNow(), OBSERVE_MS)
    report.control = { first: controlFirst, second: controlSecond }

    const before = coordinator.snapshot() as unknown as Record<string, unknown>

    // ── THE FREEZE ──────────────────────────────────────────────────────────
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE versions IN ACCESS EXCLUSIVE MODE')

    const blocked = coordinator.reconcileNow()
    // Attach a handler NOW so that if it later rejects (which is what the remedy
    // will make it do) the process does not die on an unhandled rejection while
    // we are still observing.
    const blockedOutcome = blocked.then(() => null).catch((error: unknown) => (
      error instanceof Error ? error.message : String(error)
    ))
    const first = await settledWithin(blocked, OBSERVE_MS)

    // THE QUESTION THE TASK IS ABOUT: with the first pass still in flight, does
    // the NEXT call return? `reconcileNow` hands back `reconcileFlight`, and the
    // `.finally` that clears it cannot run while the promise is pending.
    const second = await settledWithin(coordinator.reconcileNow(), OBSERVE_MS)

    const during = coordinator.snapshot() as unknown as Record<string, unknown>
    const moved: Record<string, { before: unknown; during: unknown }> = {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(during)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(during[key])) {
        moved[key] = { before: before[key], during: during[key] }
      }
    }
    report.frozen = {
      firstPassSettledWithinObserveWindow: first.settled,
      firstPassError: first.error,
      // THE EXIT WITNESS, when the ceiling is below the observation window: the
      // blocked pass rejects, so `reconcileNow`'s `.finally` runs, so
      // `reconcileFlight` is cleared, so THIS returns. Under the defect it was
      // the same promise, pending forever.
      nextPassSettledWithinObserveWindow: second.settled,
      nextPassError: second.error,
      nextPassWaitedMs: Math.round(second.ms),
      slowestStatementMs: (during as { slowestStatementMs?: number }).slowestStatementMs ?? null,
      snapshotFieldsThatMovedDuringTheFreeze: moved,
      errorCountBefore: before.errorCount,
      errorCountDuring: during.errorCount,
      readyBefore: before.ready,
      readyDuring: during.ready,
    }

    // ── DRAIN ───────────────────────────────────────────────────────────────
    // Release the lock and record whether the frozen pass ever completes and
    // whether the coordinator recovers on its own. Nothing was cancelled, so
    // this is the honest end of the observation rather than a cleanup.
    const releasedAt = performance.now()
    await blocker.query('ROLLBACK')
    const drained = await settledWithin(blockedOutcome, OBSERVE_MS)
    const afterRelease = await settledWithin(coordinator.reconcileNow(), OBSERVE_MS)
    report.afterTheLockIsReleased = {
      frozenPassCompleted: drained.settled,
      frozenPassError: drained.error,
      msFromReleaseToCompletion: Math.round(performance.now() - releasedAt),
      nextPassSettled: afterRelease.settled,
      recovered: drained.settled && afterRelease.settled,
    }

    await coordinator.stop()
  } finally {
    await blocker.end().catch(() => undefined)
    await redis.quit().catch(() => undefined)
    await db.teardown().catch(() => undefined)
  }

  writeFileSync(OUT!, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`wrote ${OUT}`)
}

await main()
