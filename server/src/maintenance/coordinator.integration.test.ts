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

const connectionString = process.env.TEST_DATABASE_URL

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe.skipIf(!connectionString)('MaintenanceCoordinator PostgreSQL ownership', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  // Test-only namespace avoids contending with a live API sharing the database.
  const namespace = 1_700_000_000 + Math.floor(Math.random() * 100_000_000)

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'maintenance_coordinator')
    pool = db.pool
    await ensureMaintenanceSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  it('holds one pinned session lock and exposes cluster-wide status', async () => {
    const replicaA = new MaintenanceCoordinator(pool, 'replica-a', namespace)
    const replicaB = new MaintenanceCoordinator(pool, 'replica-b', namespace)
    const release = deferred<void>()
    const entered = deferred<void>()

    const owner = replicaA.run('automerge_gc', async () => {
      entered.resolve()
      await release.promise
      return { deleted: 4 }
    })
    await entered.promise

    await expect(replicaB.run('automerge_gc', async () => ({ deleted: 99 })))
      .resolves.toEqual({ status: 'skipped_locked', job: 'automerge_gc' })
    const active = await replicaB.clusterSnapshot()
    expect(active.jobs.find((job) => job.job === 'automerge_gc')).toMatchObject({
      status: 'running',
      lockHeld: true,
      runCount: 1,
      skipCount: 1,
    })

    release.resolve()
    await expect(owner).resolves.toMatchObject({ status: 'completed', value: { deleted: 4 } })
    const completed = await replicaB.clusterSnapshot()
    expect(completed.jobs.find((job) => job.job === 'automerge_gc')).toMatchObject({
      status: 'completed',
      lockHeld: false,
      runCount: 1,
      skipCount: 1,
      failureCount: 0,
    })
  })
})
