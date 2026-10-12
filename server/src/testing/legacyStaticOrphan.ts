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

/** Anything that can run SQL — a `pg.Pool`, a `PoolClient`, a test wrapper. */
interface Runs {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

export const STATIC_ALLOW_LIST_FK = 'read_model_static_documents_workspace_fk'

/** Is the constraint on the table `search_path` resolves to right now? */
export async function staticAllowListFkPresent(db: Runs): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT convalidated FROM pg_constraint
      WHERE conrelid = to_regclass('read_model_static_documents')
        AND conname = $1`,
    [STATIC_ALLOW_LIST_FK],
  )
  return rows.length > 0
}

/**
 * Write `read_model_static_documents` rows for a workspace that has NO
 * `read_model_static_workspaces` row, with the foreign key lifted for the
 * duration.
 *
 * **This is a reproduction of legacy data, not a workaround.**
 * `read_model_static_documents_workspace_fk` refuses such a write now — that
 * refusal is the constraint's entire purpose and is asserted directly in
 * `staticPlaneReconciliation.integration.test.ts` (A10-i9, A10-i10). But the
 * constraint is installed `NOT VALID`, so rows written before it existed survive
 * untouched; `ensureReadModelSchema` runs on every boot and a validated
 * constraint would refuse to install on any database holding one, wedging the
 * deploy. Those survivors belong to `npm run fsck`
 * (`static-allow-list-orphaned`) and to the demotion door's explicit sweep.
 *
 * So three suites still have to construct the orphan — the reader's robustness
 * to it (A10), the baseline write fence's half-state, and fsck's own detector —
 * and the honest way is the sequence that produced it: drop the constraint,
 * write, put it back `NOT VALID`. Inventing the row any other way would test a
 * shape a live database cannot reach.
 *
 * **RESTORES ONLY WHAT IT REMOVED, and that conditional is the whole reason this
 * helper is safe to call from a test file that also tests the constraint.**
 * Re-adding it unconditionally would mean every later test in the file ran
 * against a constraint the HELPER supplied rather than
 * `ensureReadModelSchema` — testing this module's DDL literal instead of
 * production's. With the check, a database whose production DDL never
 * installed the constraint keeps it absent, and those tests fail as they
 * should.
 *
 * The re-add is still in a `finally`: a suite that lost the constraint half way
 * through would report green for every test after it, against a schema
 * production does not have, and nothing in the output would say so.
 */
export async function asLegacyStaticOrphan(db: Runs, write: () => Promise<unknown>): Promise<void> {
  const present = await staticAllowListFkPresent(db)
  if (present) {
    await db.query(`ALTER TABLE read_model_static_documents DROP CONSTRAINT ${STATIC_ALLOW_LIST_FK}`)
  }
  try {
    await write()
  } finally {
    if (present) {
      await db.query(`ALTER TABLE read_model_static_documents
        ADD CONSTRAINT ${STATIC_ALLOW_LIST_FK}
        FOREIGN KEY (landscape_id, version_id)
        REFERENCES read_model_static_workspaces (landscape_id, version_id)
        ON DELETE CASCADE NOT VALID`)
    }
  }
}
