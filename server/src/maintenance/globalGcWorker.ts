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
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { initSchema, pool } from '../db.js'
import { gcOrphanedDocs } from '../gc.js'
import { MaintenanceCoordinator } from './coordinator.js'
import { ensureMaintenanceSchema } from './schema.js'
import { withMigrationLock } from '../db/migrations.js'

/** One-shot global GC worker for ECS RunTask / Kubernetes CronJob. It owns no
 * WebSockets or workspace projectors; its Repo is a read-only graph walker over
 * shared PostgreSQL storage. Every destructive batch verifies the fencing token
 * acquired under the cluster advisory lock. */
async function main(): Promise<void> {
  // DDL (initSchema re-runs the ADD COLUMN IF NOT EXISTS of the baseline) from
  // a cron job that can start mid-backup: under the migration key, see
  // withMigrationLock.
  await withMigrationLock(pool, async () => {
    await initSchema()
    await ensureMaintenanceSchema(pool)
  })
  const coordinator = new MaintenanceCoordinator(pool, `global-gc-${process.pid}`)
  const repo = new Repo({
    network: [],
    storage: new PostgresStorageAdapter({ db: pool }),
  })

  try {
    const reportOnly = process.env.GC_REPORT_ONLY === 'on'
    const includeCandidateDocumentIds = reportOnly && process.env.GC_REPORT_INCLUDE_CANDIDATES === 'on'
    const expectedCandidateDigest = process.env.GC_EXPECTED_CANDIDATE_DIGEST?.trim() || undefined
    const outcome = await coordinator.runFenced('automerge_gc', async (fence) => (
      gcOrphanedDocs(repo, {
        db: pool,
        fence,
        reportOnly,
        includeCandidateDocumentIds,
        expectedCandidateDigest,
      })
    ))
    const aborted = outcome.status === 'completed' && outcome.value.aborted
    const failed = aborted || outcome.status === 'skipped_stopping'
    console.log(JSON.stringify({
      event: 'maintenance.global_gc_worker',
      outcome: aborted ? 'aborted' : outcome.status,
      success: outcome.status === 'completed' && !aborted ? 1 : 0,
      failure: failed ? 1 : 0,
      ...(outcome.status === 'completed' ? { result: outcome.value } : {}),
    }))
    if (failed) process.exitCode = 1
  } finally {
    coordinator.stopAccepting()
    await coordinator.drain()
    await repo.shutdown().catch((error) => console.warn('[global-gc] Repo shutdown failed:', error))
    await pool.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'maintenance.global_gc_worker',
    outcome: 'failed',
    success: 0,
    failure: 1,
  }))
  console.error('[global-gc] worker failed:', error)
  process.exitCode = 1
})
