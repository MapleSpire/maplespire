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

/**
 * The `backup_drill_runs` column list, exported so the overlap suite's fixture
 * cannot drift from production. See the call site for why that matters.
 *
 * `abandoned` is a STORED GENERATED column rather than a value a writer sets,
 * for performance. The overlap detector reads one boolean per row on every
 * `/metrics` scrape; reading it out of the JSONB means detoasting the whole
 * report history. Measured on PG 16, 5 000 rows with incompressible reports:
 *
 * ```
 *   reading (report ->> 'abandoned') ....  53.3 ms   TOAST 41 MB of a 42 MB table
 *   reading a stored generated column ...   2.67 ms  0 disagreements over 5 000 rows
 * ```
 *
 * Generated rather than plain so the report stays the single source of truth
 * and no writer has to remember to keep a copy in step.
 */
export const BACKUP_DRILL_RUNS_COLUMNS = `
      id            TEXT PRIMARY KEY,
      started_at    TIMESTAMPTZ NOT NULL,
      finished_at   TIMESTAMPTZ NOT NULL,
      outcome       TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
      rto_ms        BIGINT NOT NULL CHECK (rto_ms >= 0),
      report_sha256 TEXT NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
      signature     TEXT,
      signing_key_id TEXT,
      report        JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ${'abandoned     BOOLEAN GENERATED ALWAYS AS '
        + "(COALESCE((report ->> 'abandoned') = 'true', false)) STORED"}
`

/** The same column, for a table that predates it. `COALESCE` rather than a bare
 *  comparison so a report with no such key reads `false` instead of NULL — the
 *  aggregate would treat NULL as not-matching either way, but a nullable
 *  three-state boolean is a trap for the next reader. */
export const ADD_ABANDONED_COLUMN = "ADD COLUMN IF NOT EXISTS abandoned BOOLEAN "
  + "GENERATED ALWAYS AS (COALESCE((report ->> 'abandoned') = 'true', false)) STORED"

/**
 * Durable state the backup drill owns.
 *
 * Both tables are deliberately authoritative rather than derived: they are not
 * prefixed `ro_`/`read_model_`, so `collectAuthoritativeTableFingerprints`
 * fingerprints their contents and a restore that loses a retirement decision or
 * a drill history fails verification instead of quietly starting over.
 */
export async function ensureBackupSchema(pool: Pool): Promise<void> {
  // A workspace whose root document cannot be cold-loaded blocks every backup,
  // because the cold-load gate is what makes a backup worth having. Repairing it
  // is the first choice; when it is genuinely unrecoverable this table records
  // the decision to stop gating on it — WHO decided, WHEN, and WHY. An exclusion
  // that lives in a config file or a `--skip` flag is an exclusion nobody
  // reviews; one that lives in the dump is restored, fingerprinted and visible.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_retired_workspaces (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      root_url     TEXT NOT NULL,
      reason       TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      retired_by   TEXT NOT NULL CHECK (length(btrim(retired_by)) > 0),
      retired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id)
    )
  `)

  // The same decision, one level down. A root is not the only thing that can be
  // unrecoverable: a diagram document can be listed in
  // `automerge_document_workspace` with chunks in storage that do not add up to
  // a loadable document — a sync that never completed. Retiring the WORKSPACE
  // for that would exempt a whole landscape's root and registry to excuse one
  // diagram, which is exactly the over-broad exemption the workspace table
  // exists to avoid.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_retired_documents (
      document_id TEXT PRIMARY KEY,
      reason      TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      retired_by  TEXT NOT NULL CHECK (length(btrim(retired_by)) > 0),
      retired_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // One row per drill, signed. `outcome` is not a boolean because "the drill
  // never ran" and "the drill ran and failed" call for different alerts, and a
  // last-success age alone cannot distinguish them.
  //
  // The column list is EXPORTED and shared with the overlap suite's fixture.
  // That suite builds a temp table shadowing this one, and a hand-written copy
  // of these columns would be free to drift — a future `CHECK (finished_at >=
  // started_at)` here would silently turn its backwards-row test into an
  // assertion about a state production cannot reach.
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_drill_runs (${BACKUP_DRILL_RUNS_COLUMNS})`)
  // …and for a table created before `abandoned` existed. Idempotent.
  await pool.query(`ALTER TABLE backup_drill_runs ${ADD_ABANDONED_COLUMN}`)
  // The operational query — "how old is the newest success?" — must not
  // degrade into a sequential scan as history accumulates.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_backup_drill_runs_success
    ON backup_drill_runs (finished_at DESC)
    WHERE outcome = 'passed'
  `)
}
