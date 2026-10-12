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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { MaintenanceCoordinator } from './coordinator.js'
import { ensureMaintenanceSchema } from './schema.js'
import { singleFlight } from './singleFlight.js'

/**
 * WHY TWO COMPACTORS CANNOT INTERLEAVE TODAY, written down.
 *
 * Before testing a race between two compactors, establish what currently
 * prevents it — otherwise a green concurrency test proves only that the race
 * was never reachable.
 *
 * TWO EXCLUSIONS, INDEPENDENT, EITHER SUFFICIENT:
 *
 *   1. CLUSTER-WIDE, between processes: `MaintenanceCoordinator` takes one
 *      advisory lock per JOB NAME. A second replica running `default_compaction`
 *      is refused with `skipped_locked` — it does not wait, it does not run.
 *   2. IN-PROCESS, within one replica: the compaction runners in `index.ts` are
 *      wrapped in `singleFlight`, which returns the in-flight promise, so two
 *      overlapping calls produce ONE invocation of the task.
 *
 * Per-workspace maintenance REMOVES the first exclusion: keying the lock by
 * workspace is precisely what stops compacting one workspace from blocking
 * every other, and it is also what makes an interleaving reachable. Pinning
 * both exclusions here means whoever removes one modifies this file
 * DELIBERATELY, with the losing interleaving in view.
 *
 * The per-workspace key exists —
 * `maintenance-workspace:<job>:<lid>:<vid>`, hashed in SQL — and
 * `MaintenanceCoordinator` will use it INSTEAD of the job-name key when a
 * workspace is supplied. Both tests below still describe the SHIPPED
 * configuration, because `MAINTENANCE_WORKSPACE_KEYED` defaults to `off`: a
 * workspace-keyed replica and a job-name-keyed replica take keys in different
 * advisory key spaces and would not exclude each other at all, so the mechanism
 * ships switched off and the cutover is a separate act on a homogeneous fleet.
 *
 * What changes the day that flag is turned on is EXCLUSION 1 only, and only for
 * jobs marked in `WORKSPACE_KEYABLE_JOBS`: a different workspace stops being
 * refused. `maintenanceWorkspaceLock.integration.test.ts` holds the assertions
 * for that mode, including the one that inverts. EXCLUSION 2 is unaffected — it
 * is per-process — which is exactly why it becomes the only remaining barrier
 * between two compactions in one replica.
 *
 * These tests assert TODAY. They are expected to change; the requirement is that
 * changing them is a decision.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe.skipIf(!TEST_DATABASE_URL)('what makes two compactors impossible today (T-23.2)', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  // A test-only namespace, so this cannot contend with a live API on the same
  // database — the idiom `coordinator.integration.test.ts` established.
  const namespace = 1_700_000_000 + Math.floor(Math.random() * 100_000_000)

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'compaction_exclusion_today')
    pool = db.pool
    await ensureMaintenanceSchema(pool)
  }, 120_000)

  afterAll(async () => { await db?.teardown() })

  it('EXCLUSION 1 — cluster-wide: the second replica is refused, not queued', async () => {
    // The exclusion workspace keying removes. While replica A is inside
    // `default_compaction`, replica B asking for the same JOB NAME is refused
    // outright — on any workspace: cluster-wide serialisation.
    const replicaA = new MaintenanceCoordinator(pool, 'replica-a', namespace)
    const replicaB = new MaintenanceCoordinator(pool, 'replica-b', namespace)
    const release = deferred<void>()
    const entered = deferred<void>()

    let invocations = 0
    const owner = replicaA.run('default_compaction', async () => {
      invocations += 1
      entered.resolve()
      await release.promise
      return { objectsFolded: 7 }
    })
    await entered.promise

    const refused = await replicaB.run('default_compaction', async () => {
      invocations += 1
      return { objectsFolded: 999 }
    })

    // REFUSED, not merely late: `skipped_locked` means B's task never ran.
    expect(refused).toEqual({ status: 'skipped_locked', job: 'default_compaction' })
    expect(invocations, 'the second replica ran its task anyway').toBe(1)

    // ...and the exclusion is keyed on the JOB NAME. A DIFFERENT job proceeds
    // WHILE `default_compaction` is still held — so what refuses a second
    // compaction is the name it shares, not the work it would do.
    //
    // THIS PROBE MUST RUN BEFORE THE RELEASE: with the lock already given back
    // there is no collision to observe, and two jobs sharing one lock key would
    // go unnoticed.
    const otherJob = await replicaB.run('automerge_gc', async () => ({ deleted: 1 }))
    expect(otherJob, 'a different job was refused — the lock is not keyed on the job name')
      .toMatchObject({ status: 'completed' })

    release.resolve()
    await expect(owner).resolves.toMatchObject({
      status: 'completed', value: { objectsFolded: 7 },
    })
  })

  it('EXCLUSION 2 — in-process: two overlapping calls are ONE invocation', async () => {
    // The compaction runner hands back the in-flight promise rather than
    // starting a second run. This exclusion survives workspace keying — it is
    // per-process, not per-cluster — so with keying on it is the ONLY thing
    // left between two compactions in one replica.
    //
    // THE REAL `singleFlight`, not a copy of it: the runners in index.ts are
    // inline closures that cannot be imported, so the latch lives in
    // `singleFlight.ts`. A test that re-typed the idiom locally would stay green
    // while the production latch was deleted.
    let invocations = 0
    const release = deferred<void>()
    const runCompaction = singleFlight(async (): Promise<number> => {
      invocations += 1
      await release.promise
      return invocations
    })

    const first = runCompaction()
    const second = runCompaction()
    release.resolve()
    const [a, b] = await Promise.all([first, second])

    expect(invocations, 'the overlapping call started a second compaction').toBe(1)
    // The follower JOINED the run — it did not get a stale value from a run it
    // missed. Same promise, so the same result object.
    expect(a).toBe(b)

    // AND THE LATCH CLEARS: one that never did would make compaction run exactly
    // once per process lifetime — a different bug wearing this same green test.
    const later = await runCompaction()
    expect(invocations, 'the in-flight latch never cleared — compaction can only ever run once').toBe(2)
    expect(later).toBe(2)

    // A FAILED PASS DOES NOT WEDGE THE JOB. If the latch were cleared only on
    // success, one thrown compaction would silently disable every later one for
    // the lifetime of the process — the quietest possible way to stop compacting.
    const boom = singleFlight(async (): Promise<number> => {
      invocations += 1
      throw new Error('compaction failed')
    })
    await expect(boom()).rejects.toThrow('compaction failed')
    await expect(boom()).rejects.toThrow('compaction failed')
    expect(invocations, 'a failed pass left the latch set — the job is wedged until restart').toBe(4)
  })
})
