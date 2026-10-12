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
 * The cache-invalidation triggers against REAL Postgres
 * LISTEN/NOTIFY. The unit twin pins payload routing over a fake client; a
 * fake cannot prove the DDL fires, carries the right payload shape, or that
 * NOTIFY only surfaces on COMMIT — those live in the trigger SQL and pg's
 * delivery, so they are pinned here.
 *
 * NOTIFY isolation note: channels are per-DATABASE, not per-schema, so a live
 * dev server (or a sibling suite) listening on the same database receives our
 * payloads and vice versa. That is exactly why every id here is suite-unique
 * (`L-wci-…`): a foreign notification matches no assertion, our notifications
 * no-op in foreign handlers (dropping an uncached key is free), and the
 * assertions below use `toHaveBeenCalledWith`, never bare call counts over
 * the shared channel. Same accepted leak isolatedSchema.ts documents for
 * `bump_auth_epoch`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startWorkspaceCacheInvalidation, type WorkspaceCacheInvalidationHandle } from './workspaceCacheInvalidation.js'
import { invalidateWorkspaceCoverage, coverWorkspace } from './claimCoverage.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('workspace cache invalidation (live LISTEN/NOTIFY)', () => {
  let db: IsolatedSchemaDb
  let handle: WorkspaceCacheInvalidationHandle | null = null
  const onCoverageChanged = vi.fn()
  const onVersionCreated = vi.fn()

  const L = 'L-wci-live'
  const V = 'V-wci-live-1'

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'workspace_cache_inval')
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [L])
    await db.pool.query(
      "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:wci-root')",
      [V, L],
    )
    // Installs the coverage table AND both notify triggers — the versions
    // trigger attaches to THIS schema's versions table, so an insert below
    // fires our DDL, not a shared one.
    await ensureSyncCellOwnershipSchema(db.pool)
  })

  afterAll(async () => {
    await handle?.stop()
    await db?.teardown()
  })

  it('coverage writes and version creations NOTIFY a live listener with the workspace ids', async () => {
    handle = startWorkspaceCacheInvalidation(db.pool, { onCoverageChanged, onVersionCreated })

    // LISTEN is established asynchronously and pg offers no readiness signal
    // worth trusting; ping with real invalidations until one lands. Each ping
    // is a legitimate durable write (the counter just bumps), so the loop
    // proves delivery rather than assuming it.
    await vi.waitFor(async () => {
      await invalidateWorkspaceCoverage(db.pool, { landscapeId: L, versionId: V }, 'listener ping')
      expect(onCoverageChanged).toHaveBeenCalledWith({ landscapeId: L, versionId: V })
    }, { timeout: 10_000, interval: 200 })

    // The cover path (UPDATE half) notifies too — any committed write to the
    // marker does, the trigger watches the table, not the writers.
    onCoverageChanged.mockClear()
    const { rows } = await db.pool.query<{ invalidations: string }>(
      'SELECT invalidations::text AS invalidations FROM workspace_claim_coverage WHERE landscape_id = $1 AND version_id = $2',
      [L, V],
    )
    expect(await coverWorkspace(db.pool, { landscapeId: L, versionId: V }, rows[0]!.invalidations)).toBe(true)
    await vi.waitFor(() => {
      expect(onCoverageChanged).toHaveBeenCalledWith({ landscapeId: L, versionId: V })
    }, { timeout: 10_000 })

    // A committed INSERT INTO versions notifies the landscape id — whoever the
    // writer is (this covers version creators that never call
    // notifyWorkspaceCreated, since the TABLE emits).
    await db.pool.query(
      "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('V-wci-live-2', $1, 'Snapshot', 'automerge:wci-root-2')",
      [L],
    )
    await vi.waitFor(() => {
      expect(onVersionCreated).toHaveBeenCalledWith(L)
    }, { timeout: 10_000 })
  })
})
