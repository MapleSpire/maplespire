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

import type { Pool } from 'pg'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureBackupSchema } from '../backup/schema.js'
import { ensureMaintenanceSchema } from '../maintenance/schema.js'
import { backfillC4ParentIds, ensureReadModelSchema } from '../readModel/schema.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { ensureSyncTopologyContractSchema } from '../syncCells/topologyMirror.js'
import { ensurePlacementProposerSchema } from '../syncCells/placementProposerSchema.js'
import { ensureTagSchema } from '../tags/schema.js'
import { ensureTechnologySchema } from '../technologies/schema.js'
import { initSchema } from '../db.js'
import type { Migration } from './migrations.js'

/**
 * The migration list, in application order.
 *
 * **Adding one.** New DDL that is idempotent can still go in the module it
 * belongs to — the baseline re-runs every boot and will pick it up. Anything
 * that is NOT safe to re-run — a backfill, a column rename, a constraint that
 * must be validated once, a phase of a multi-deploy migration — gets its
 * own entry here with the next number and `repeatable` left off. Never renumber
 * or rename a shipped entry: the id is the ledger key, so a rename re-runs it.
 */
export function schemaMigrations(pool: Pool): Migration[] {
  return [
    {
      id: '0001-baseline',
      // Repeatable: these functions running on every boot is how columns get
      // added, and freezing them would silently disable the next
      // `ADD COLUMN IF NOT EXISTS` written inside one. Non-transactional:
      // `initSchema` issues `CREATE INDEX CONCURRENTLY`, which Postgres refuses
      // inside a transaction block.
      repeatable: true,
      transactional: false,
      // The client the runner passes is unused: each of these functions owns
      // its own connections.
      run: async () => {
        await initSchema()
        await ensureAuthSchema(pool)
        await ensureTechnologySchema(pool)
        await ensureTagSchema(pool)
        await ensureMaintenanceSchema(pool)
        await ensureSyncCellOwnershipSchema(pool)
        await ensureBackupSchema(pool)
        // Unconditional, not gated on READ_MODEL: empty tables cost nothing, and
        // gating schema on a runtime flag would make turning the flag on depend
        // on a schema change having happened first, which breaks rolling deploys.
        const client = await pool.connect()
        try {
          await ensureReadModelSchema(client)
        } finally {
          client.release()
        }
      },
    },
    {
      // The maintenance status and fence tables were keyed by job name only,
      // while runs are excluded per (job, workspace). Two workspaces running one
      // job then shared a row: the second run's upsert overwrote `runner_id`, so
      // the first run's terminal UPDATE (`WHERE job_name = $1 AND runner_id =
      // $2`) matched zero rows and its failure was never recorded — hiding the
      // `status = 'failed'` / rising `failure_count` alert conditions.
      //
      // NOT repeatable: dropping and re-adding a primary key on every boot is not
      // acceptable. The baseline already creates the new shape on a fresh
      // database; this entry upgrades databases that predate it.
      id: '0002-maintenance-workspace-keyed-status',
      run: async (client) => {
        for (const table of ['maintenance_job_status', 'maintenance_job_fence']) {
          await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS landscape_id TEXT NOT NULL DEFAULT ''`)
          await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS version_id TEXT NOT NULL DEFAULT ''`)
          // Existing rows are job-name-keyed runs and already carry the ''
          // sentinel from the column default, so there is no backfill: the
          // DEFAULT is the backfill, applied by the ALTER itself.
          await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`)
          await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (job_name, landscape_id, version_id)`)
        }
      },
    },
    {
      // The ownership bootstrap shares this idempotent DDL for fresh/isolated
      // schemas; the ledger also records the explicit upgrade.
      id: '0003-sync-topology-contract',
      run: ensureSyncTopologyContractSchema,
    },
    {
      // Run-once, so the ledger records a real capture origin rather than the
      // repeatable baseline's last-run timestamp.
      id: '0004-placement-proposer',
      run: ensurePlacementProposerSchema,
    },
    {
      // `ro_objects.c4_parent_id` (the Model Viewer's level) is added by the
      // baseline above, NULL on every existing row; this fills it once.
      // Transactional, so the backfill and its ledger row commit together.
      // Rows written by old-code cells after this has run are the residual
      // case — see `backfillC4ParentIds`.
      id: '0005-ro-objects-c4-parent',
      run: backfillC4ParentIds,
    },
  ]
}
