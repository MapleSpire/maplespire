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
 * The seed publisher's document-claim path, at 1,000+ documents.
 *
 * Drives the exact path `seedOrgEnvironment` publishes through — a real
 * `createSeedWorkspaceRoot` graph, an INSERT INTO versions, then
 * `claimAndCoverNewWorkspace` — with a synthetic 1,200-diagram model, so the
 * batch discipline is measured where it matters: the statement count comes
 * from a wrapper around the REAL pool, and the claims are verified by their
 * persisted effect (every row queried back), never by the API having been
 * called.
 *
 * The full `seedOrgEnvironment` (teams, users, catalogs) is exercised by its
 * route; this file covers only the publisher slice.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { CLAIM_BATCH_SIZE, CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
import type { SeedModel } from './generator.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/** A model with `diagramCount` empty diagrams — enough documents to need two
 * claim batches (diagrams + monolith + 2 shards + 2 overlays + meta +
 * registry + root). */
function syntheticModel(diagramCount: number): SeedModel {
  return {
    domains: {},
    objects: [],
    connections: [],
    groups: {},
    tagSnapshots: {},
    diagrams: Array.from({ length: diagramCount }, (_v, i) => ({
      id: `d-${String(i).padStart(5, '0')}`,
      name: `Diagram ${i}`,
      type: 'context' as const,
      objectIds: [],
      connectionIds: [],
      groupIds: [],
      layouts: {},
    })),
  }
}

describe.skipIf(!TEST_DATABASE_URL)('É4-F — seed publisher batch claims (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let claimStatements = 0

  let landscapes: typeof import('../landscapes.js')
  let docScope: typeof import('../rbac/docScope.js')
  let workspaceModule: typeof import('./workspace.js')

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'org_seed_claims')
    realPool = db.pool
    vi.doMock('../db.js', () => ({ pool: realPool }))
    vi.doMock('./db.js', () => ({ pool: realPool }))
    vi.resetModules()

    const authSchema = await import('../auth/schema.js')
    const rbacSchema = await import('../rbac/schema.js')
    await authSchema.ensureAuthSchema(realPool)
    await rbacSchema.ensureRbacSchema(realPool)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT,
        org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())
    `)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())
    `)
    const ownership = await import('../syncCells/ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(realPool)

    landscapes = await import('../landscapes.js')
    docScope = await import('../rbac/docScope.js')
    workspaceModule = await import('./workspace.js')

    const indexPool = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO automerge_document_workspace')) claimStatements += 1
        return realPool.query(sql, params)
      },
    } as unknown as pg.Pool
    new docScope.WorkspaceDocIndex(new Repo({}), indexPool)
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.doUnmock('./db.js')
    vi.resetModules()
  })

  it('a seeded workspace with 1,000+ documents is claimed in ceil(n/1000) batches and covered', async () => {
    const repo = new Repo({})
    const { rootUrl, createdDocumentIds } = await workspaceModule.createSeedWorkspaceRoot(
      repo, syntheticModel(1_200),
    )
    // 1,200 diagrams + monolith + object shard + object overlay + connection
    // shard + connection overlay + meta + registry + root.
    expect(createdDocumentIds).toHaveLength(1_208)

    await realPool.query("INSERT INTO landscapes (id, name) VALUES ('L-seed', 'Seed')")
    await realPool.query(
      "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('V-seed', 'L-seed', 'Main', $1)",
      [rootUrl],
    )

    claimStatements = 0
    await landscapes.claimAndCoverNewWorkspace('L-seed', 'V-seed', rootUrl, createdDocumentIds)

    // ⌈1208/1000⌉ = 2 batch statements; a unitary loop explodes this to 1,208.
    expect(claimStatements).toBe(Math.ceil(createdDocumentIds.length / CLAIM_BATCH_SIZE))

    // Verified by its persisted effect: every id has a row.
    const { rows } = await realPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automerge_document_workspace
        WHERE landscape_id = 'L-seed' AND version_id = 'V-seed' AND document_id = ANY($1::text[])`,
      [createdDocumentIds],
    )
    expect(rows[0]!.n).toBe(String(createdDocumentIds.length))

    const { rows: markerRows } = await realPool.query<{ covered: boolean; protocol: number }>(
      "SELECT covered, protocol FROM workspace_claim_coverage WHERE landscape_id = 'L-seed' AND version_id = 'V-seed'",
    )
    expect(markerRows[0]?.covered).toBe(true)
    expect(Number(markerRows[0]?.protocol)).toBe(CLAIM_PROTOCOL_VERSION)

    // Re-run idempotence (the seed re-run shape): alreadyOurs, never a throw.
    await expect(
      landscapes.claimAndCoverNewWorkspace('L-seed', 'V-seed', rootUrl, createdDocumentIds),
    ).resolves.toBeUndefined()
  }, 120_000)
})
