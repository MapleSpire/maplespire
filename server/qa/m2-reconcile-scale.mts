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
 * M2 — how long `performReconcile` takes at 10 / 100 / 1 000 / 10 000 versions.
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... \
 *     npx tsx qa/m2-reconcile-scale.mts ../reports/M2-raw.json
 *
 * It writes the RAW series only. Interpretation belongs in a separate,
 * hand-written file, so that re-running the harness can never clobber a
 * conclusion.
 *
 * RUN BY NO GATE, deliberately: this is a MEASUREMENT, not a gate. It is still
 * typechecked (`server/tsconfig.check.json` covers `server/qa`), so a drifting
 * signature is a red `typecheck:all`. Re-run it by hand when the reconcile path
 * changes.
 *
 * The report goes to a FILE named on the command line, not to stdout: the
 * coordinator under measurement writes its own telemetry and four admission
 * lines per workspace to stdout, so at 10 000 workspaces a redirect captures
 * ~40 000 lines of subject with the report buried at the end.
 *
 * WHY THE NUMBER IS WANTED. `reconcileIntervalMs` defaults to 5 000 ms with a
 * 1 000 ms floor, so a pass that takes longer than its own interval never
 * stops running — and `reconcileNow()` is single-flight, so a slow pass also
 * silently swallows every scheduled and event-driven reconcile behind it
 * (`probePartition` after a re-acquisition, `handleWorkerPartitionLoss`). A
 * critical section is only safe if its duration is known.
 *
 * TWO NUMBERS, NOT ONE, and conflating them is the trap this harness exists to
 * avoid. The FIRST pass acquires every lease: N Redis round trips plus two
 * Postgres statements each, bounded by `admissionConcurrency` (4). Every pass
 * AFTER it acquires nothing and is the steady state that actually repeats every
 * interval. Reporting only the first would make the recurring cost look ~100x
 * worse than it is; reporting only the steady state would hide the admission
 * barrier entirely. Both are published.
 *
 * WHAT THIS MEASUREMENT IS ALSO FOR. Every pass ends with ONE query for all
 * held leases rather than one per lease, so that the pass scales to 10 000
 * versions. The warm figure at 10 000 is what keeps or breaks that claim.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient } from 'redis'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import type { RedisRuntime } from '../src/runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from '../src/syncCells/ownership.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const REDIS_URL = process.env.TEST_REDIS_URL
if (!DATABASE_URL || !REDIS_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero.
  throw new Error('M2 needs TEST_DATABASE_URL and TEST_REDIS_URL; refusing to report nothing')
}

const SCALES = [10, 100, 1_000, 10_000]
/** Warm passes per scale. The first warm pass still pays whatever the cold pass
 * left warm in the pool and the plan cache, so it is measured and DISCARDED. */
const WARM_PASSES = 6
const WARM_DISCARD = 1

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}

async function measure(scale: number): Promise<Record<string, unknown>> {
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `sync_cell_m2_${scale}`)
  const prefix = `m2-${randomBytes(6).toString('hex')}`
  const client = createClient({ url: REDIS_URL })
  await client.connect()
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

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
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', ['m2', 'm2'])
    // One statement, not N: seeding is not the subject and an N-statement seed
    // at 10 000 dominates the wall clock of the whole run.
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
       SELECT 'v' || i, 'm2', 'v' || i, 'automerge:root-' || i, 'active', 'version'
         FROM generate_series(1, $1) AS i`,
      [scale],
    )

    const config: SyncCellOwnershipConfig = {
      enabled: true,
      cellId: `m2-cell-${scale}`,
      advertiseUrl: 'http://m2.internal:3001',
      leaseTtlMs: 600_000,
      renewIntervalMs: 300_000,
      partitionLeaseTtlMs: 60_000,
      partitionRenewIntervalMs: 20_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      // Long enough that no timer fires inside the measurement: a scheduled
      // pass landing mid-run would be attributed to the pass being timed.
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      reconcilePassDeadlineMs: 300_000,
      concurrency: 16,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: `m2-${scale}`,
    } as SyncCellOwnershipConfig

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    const coldStarted = performance.now()
    await coordinator.start()
    const coldMs = performance.now() - coldStarted

    const snapshot = coordinator.snapshot()
    // VOID rules, asserted rather than assumed. A pass that discovered nothing,
    // or that holds fewer leases than it expected, has not measured this scale
    // — and would otherwise report a very fast number.
    if (snapshot.expectedWorkspaceCount !== scale) {
      throw new Error(`VOID at ${scale}: expectedWorkspaceCount=${snapshot.expectedWorkspaceCount}`)
    }
    if (snapshot.ownedWorkspaceCount !== scale) {
      throw new Error(`VOID at ${scale}: ownedWorkspaceCount=${snapshot.ownedWorkspaceCount}`)
    }
    if (snapshot.fenceDivergencesSeen !== 0) {
      throw new Error(`VOID at ${scale}: fenceDivergencesSeen=${snapshot.fenceDivergencesSeen}`)
    }

    const warm: number[] = []
    for (let pass = 0; pass < WARM_PASSES; pass += 1) {
      const started = performance.now()
      await coordinator.reconcileNow()
      warm.push(performance.now() - started)
    }
    const kept = warm.slice(WARM_DISCARD)
    const after = coordinator.snapshot()
    if (after.acquisitionCount !== snapshot.acquisitionCount) {
      throw new Error(`VOID at ${scale}: a warm pass acquired ${after.acquisitionCount - snapshot.acquisitionCount} lease(s)`)
    }
    await coordinator.stop()

    return {
      versions: scale,
      coldPassMs: Number(coldMs.toFixed(1)),
      warmPassMs: {
        p50: Number(percentile(kept, 0.5).toFixed(1)),
        p99: Number(percentile(kept, 0.99).toFixed(1)),
        min: Number(Math.min(...kept).toFixed(1)),
        max: Number(Math.max(...kept).toFixed(1)),
      },
      warmSamples: kept.length,
      discardedFirstWarmPassMs: Number(warm[0]!.toFixed(1)),
      acquisitions: snapshot.acquisitionCount,
      fenceDivergencesSeen: after.fenceDivergencesSeen,
      // The per-statement ceiling has to sit above the slowest
      // legitimate STATEMENT, and the number people reach for is the pass —
      // 18 939 ms cold at 10 000 versions — which is twenty thousand-odd
      // statements at `admissionConcurrency` 4, not one query. A ceiling picked
      // from the pass would bound nothing; one picked below this would kill a
      // cold start, and the cell would then never acquire a lease at all.
      slowestStatementMs: after.slowestStatementMs,
    }
  } finally {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    for (let offset = 0; offset < keys.length; offset += 500) {
      await client.sendCommand(['DEL', ...keys.slice(offset, offset + 500)])
    }
    await client.close()
    await db.teardown()
  }
}

const results: Array<Record<string, unknown>> = []
// SERIALLY, not with Promise.all: four coordinators racing the same Redis and
// the same Postgres would measure the contention rather than the pass.
for (const scale of SCALES) results.push(await measure(scale))

const warmAt = (versions: number) =>
  (results.find((row) => row.versions === versions) as { warmPassMs: { p50: number } }).warmPassMs.p50

// THE CONTROL. An instrument that returned the same number at 10 and at 10 000
// would be measuring itself rather than the pass, and every figure above would
// be worthless. This is asserted, not eyeballed: the run fails rather than
// publishing a flat series.
const smallest = warmAt(10)
const largest = warmAt(10_000)
if (!(largest > smallest)) {
  throw new Error(`VOID: the warm pass does not grow with scale (10 -> ${smallest} ms, 10 000 -> ${largest} ms)`)
}

const OUTPUT = process.argv[2]
if (!OUTPUT) throw new Error('usage: tsx qa/m2-reconcile-scale.mts <output.json>')
writeFileSync(OUTPUT, `${JSON.stringify({
  measureId: 'M2',
  task: 'T-M2',
  takenOn: new Date().toISOString().slice(0, 10),
  harness: 'server/qa/m2-reconcile-scale.mts',
  method: 'Un SyncCellOwnershipCoordinator réel, un Redis réel (préfixe aléatoire par échelle) et un schéma Postgres isolé par échelle. `start()` fait la passe FROIDE, qui admet les N espaces ; les passes suivantes n\'admettent rien et sont l\'état permanent qui se répète à chaque intervalle. La première passe tiède est mesurée puis JETÉE (elle paie encore ce que la passe froide a laissé chaud). Les minuteries sont réglées à une heure pour qu\'aucune passe programmée n\'atterrisse au milieu d\'une mesure.',
  control: 'DEUX témoins, tous deux ASSERTÉS et non lus à l\'œil. (1) Le harnais refuse de publier si la passe tiède ne CROÎT pas entre 10 et 10 000 espaces : un instrument qui rend le même nombre aux deux bouts se mesure lui-même. (2) Règles VOID par échelle : `expectedWorkspaceCount` et `ownedWorkspaceCount` doivent valoir N, `fenceDivergencesSeen` doit valoir 0, et aucune passe tiède ne doit avoir admis de bail — une passe qui n\'a rien découvert rendrait un très petit nombre et le rendrait pour de mauvaises raisons.',
  samples: (WARM_PASSES - WARM_DISCARD) * SCALES.length,
  warmPassesPerScale: WARM_PASSES - WARM_DISCARD,
  scales: results,
}, null, 2)}\n`, 'utf8')
console.log(`M2 written to ${OUTPUT}`)
