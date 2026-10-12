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

import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './isolatedSchema.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { ensurePlacementProposerSchema } from '../syncCells/placementProposerSchema.js'
import { placementProposerConfig, type ProposerConfig } from '../syncCells/placementProposerConfig.js'
import { placementProposerGrants } from '../syncCells/placementProposerRole.js'
import { readPlacementProposerSnapshot, type ProposerSnapshot } from '../syncCells/placementProposerSnapshot.js'
import type { PlacementObservation } from '../syncCells/placementHysteresis.js'

export const PROPOSER_FIXTURE_TOPOLOGY = 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved='

/** Synthetic catalogue/claim/content rows, using the shipped ownership and
 * proposer DDL. Not an Automerge boot or a certificate of six hours elapsed.
 * Restricted readers use actual password LOGIN connections, never SET ROLE. */
export async function createPlacementProposerFixture(connectionString: string, name: string): Promise<{
  db: IsolatedSchemaDb; reader: Pool; config: ProposerConfig; env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>; reset: () => Promise<void>
}> {
  const db = await createIsolatedSchemaDb(connectionString, name)
  const role = 't14d_' + randomBytes(10).toString('hex')
  const password = randomBytes(24).toString('hex')
  let reader: Pool | null = null
  let roleCreated = false
  const cleanup = async () => {
    const failures: unknown[] = []
    try { await reader?.end() } catch (error) { failures.push(error) }
    if (roleCreated) {
      try {
        await db.pool.query(`DROP OWNED BY "${role}"`)
        await db.pool.query(`DROP ROLE "${role}"`)
      } catch (error) { failures.push(error) }
    }
    try { await db.teardown() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'proposer fixture cleanup failed')
  }
  try {
    await db.pool.query(`
      CREATE TABLE orgs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, tier TEXT NOT NULL, org_id TEXT, default_version_id TEXT);
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id),
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE automerge_storage (key TEXT PRIMARY KEY, data BYTEA, updated_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX idx_proposer_fixture_content ON automerge_storage((split_part(key,'/',1)), updated_at);
      CREATE TABLE read_model_static_workspaces (landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
        status TEXT NOT NULL, PRIMARY KEY(landscape_id,version_id));
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    const client = await db.pool.connect()
    let destroy = false
    try {
      await client.query('BEGIN')
      await ensurePlacementProposerSchema(client)
      await client.query('COMMIT')
    } catch (error) {
      try { await client.query('ROLLBACK') }
      catch (rollbackError) {
        destroy = true
        throw new AggregateError([error, rollbackError], 'fixture installation rollback failed', { cause: rollbackError })
      }
      throw error
    } finally { client.release(destroy) }
    await db.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`)
    roleCreated = true
    await db.pool.query(placementProposerGrants(db.schema, role))
    const url = new URL(connectionString)
    url.username = role; url.password = password; url.search = ''
    const env: NodeJS.ProcessEnv = {
      SYNC_CELL_PLACEMENT_PROPOSER: 'on',
      SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL: url.href,
      SYNC_CELL_PLACEMENT_PROPOSER_ROLE: role,
      SYNC_CELL_PLACEMENT_PROPOSER_SCHEMA: db.schema,
      SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: PROPOSER_FIXTURE_TOPOLOGY,
    }
    const config = placementProposerConfig(env)!
    reader = guardIdleClientErrors(new Pool(config.pool), 't14d-fixture-reader')
    const reset = async () => {
      await db.pool.query(`TRUNCATE sync_placement_proposals, sync_workspace_placement_moves,
        read_model_static_workspaces, workspace_placement, sync_workspace_ownership,
        workspace_claim_coverage, automerge_document_workspace, automerge_storage,
        versions, landscapes, orgs CASCADE`)
      await db.pool.query(`INSERT INTO orgs VALUES ('org','active');
        INSERT INTO landscapes(id,tier,org_id) VALUES ('subject','standard','org'),('one','standard','org'),
          ('two','standard','org'),('three','standard','org');
        INSERT INTO versions(id,landscape_id,kind) VALUES ('s1','subject','version'),
          ('s2','subject','draft'),('s3','subject','version'),
          ('one-v','one','version'),('two-v','two','version'),('three-v','three','version');
        INSERT INTO workspace_placement(landscape_id,version_id,partition,topology_generation)
          SELECT landscape_id,id,CASE WHEN id='s3' THEN 1 ELSE 0 END,'v1.ce1461953e2b8ac2' FROM versions;
        INSERT INTO workspace_claim_coverage(landscape_id,version_id,covered,protocol)
          SELECT landscape_id,id,true,1 FROM versions;
        INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id)
          SELECT 'doc-' || id,landscape_id,id FROM versions;
        INSERT INTO automerge_storage(key,updated_at)
          SELECT 'doc-' || id || '/snapshot/chunk',statement_timestamp() - interval '10 minutes' FROM versions;
        INSERT INTO sync_workspace_ownership(landscape_id,version_id,cell_id,fencing_token,lease_observed_expires_at)
          SELECT landscape_id,id,'cell-a',1,statement_timestamp() + interval '1 minute' FROM versions;
        INSERT INTO read_model_static_workspaces VALUES ('subject','s1','ready');`)
      await db.pool.query(`INSERT INTO sync_topology_contract(singleton,value,written_by) VALUES (true,$1,'t14d-fixture')
        ON CONFLICT(singleton) DO UPDATE SET value=EXCLUDED.value`, [PROPOSER_FIXTURE_TOPOLOGY])
      // CONTROLLED HISTORY. The test's six-hour coverage is seeded, not waited.
      // No production function or executable is allowed to perform this UPDATE.
      await db.pool.query(`UPDATE sync_placement_history_coverage
        SET from_at = statement_timestamp() - interval '7 hours',
          from_beginning = (kind = 'proposals'), origin = gen_random_uuid()`)
    }
    await reset()
    return { db, reader, config, env, reset, cleanup }
  } catch (error) {
    try { await cleanup() }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture setup and cleanup failed', { cause: cleanupError })
    }
    throw error
  }
}

/** Literal past observations for fast transaction fixtures. The executable
 * NEVER calls this; a native run must collect real samples through pass(). */
export async function controlledPlacementObservations(
  db: Pool, schema: string, spanMs = 310_000, stepMs = 5_000,
): Promise<{ snapshot: ProposerSnapshot; observations: PlacementObservation[] }> {
  const snapshot = await readPlacementProposerSnapshot(db, schema)
  const observations: PlacementObservation[] = []
  const origin = 'controlled-fixture:' + randomUUID()
  for (let offset = spanMs, count = 1; offset >= 0; offset -= stepMs, count++) {
    const atUs = snapshot.atUs - BigInt(offset) * 1_000n
    const observedAt = new Date(Number(atUs / 1_000n) - 1).toISOString()
    observations.push({ atUs, origin, complete: true, topology: snapshot.topology, grants: [],
      workspaces: snapshot.workspaces.map((w, index) => ({
        ...w, activity: { witnessId: origin, verdict: {
          workspace: { landscapeId: w.landscapeId, versionId: w.versionId },
          sampleCount: count * snapshot.workspaces.length + index,
          kind: 'idle', ageMs: 1, requestStartedAt: observedAt, observedAt,
          facts: { workspaceStatus: 'active', claimCoverageCurrent: true, admittedDocuments: 1,
            missingContentDocuments: 0, observedAt,
            latestContentAt: new Date(Date.parse(observedAt) - 600_000).toISOString() },
        } },
      })) })
  }
  return { snapshot, observations }
}
