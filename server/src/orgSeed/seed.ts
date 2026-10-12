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

import { randomBytes } from 'node:crypto'
import type { Repo } from '@automerge/automerge-repo'
import { pool } from '../db.js'
import { createVersion, claimAndCoverNewWorkspace } from '../landscapes.js'
import { upsertLandscapeScope, upsertVersionScope } from '../rbac/schema.js'
import { notifyWorkspaceCreated } from '../rbac/docScope.js'
import { generateSeedModel } from './generator.js'
import { seedTechnologyCatalog } from '../technologies/seed.js'
import { seedTagCatalog } from '../tags/seed.js'
import { createSeedWorkspaceRoot } from './workspace.js'

/**
 * Seed a COMPLETE test environment into an org (ORG_SEED=on + org admin):
 *   - a fresh org-scoped landscape whose 'Main' version carries the demo C4
 *     model (sharded form — meta + object/connection shards — so every doc is
 *     server-resident from birth and works for sharding and non-sharding
 *     clients alike, plus 3 diagrams with layouts);
 *   - a second version ('Snapshot v1') forked from Main, so the version
 *     switcher has something to switch to;
 *   - three teams (Architecture/Platform rw, Viewers read-only) granted on
 *     the landscape scope;
 *   - five fake members (issuer 'seed') spread across the teams.
 *
 * Every id is prefixed 'seed-'/'Demo' so the environment is recognizable and
 * disposable. Repeated runs create a NEW landscape each time (fresh docs);
 * teams/users are reused per org when they already exist.
 */

function newId(): string {
  return randomBytes(12).toString('base64url')
}

export interface SeedResult {
  landscapeId: string
  landscapeName: string
  versions: number
  diagrams: number
  objects: number
  connections: number
  teams: number
  users: number
}

export async function seedOrgEnvironment(repo: Repo, orgId: string, actorUserId: string): Promise<SeedResult> {
  // The catalog is the source of truth. Object usages are published only after
  // every referenced deterministic technology identity/revision is durable.
  await seedTechnologyCatalog(pool, orgId, actorUserId)
  await seedTagCatalog(pool, orgId, actorUserId)
  const model = generateSeedModel(orgId)

  // ── Automerge docs (sharded skeleton + content) ─────────────────────────
  const { rootUrl, createdDocumentIds } = await createSeedWorkspaceRoot(repo, model)

  // ── Landscape + Main version ─────────────────────────────────────────────
  const landscapeId = newId()
  const versionId = newId()
  const landscapeName = `Demo landscape ${randomBytes(2).toString('hex')}`
  await pool.query(`INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $2, $3, $4)`, [
    landscapeId,
    landscapeName,
    versionId,
    orgId,
  ])
  await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`, [
    versionId,
    landscapeId,
    rootUrl,
  ])
  // Order: versions row → batch document claims → marker → notify. A re-run
  // seeds a FRESH landscape, so an already-ours claim is the idempotent case
  // and a foreign claim throws rather than being swallowed.
  await claimAndCoverNewWorkspace(landscapeId, versionId, rootUrl, createdDocumentIds)
  try {
    await upsertVersionScope(pool, orgId, landscapeId, versionId)
  } catch (err) {
    console.warn('[orgSeed] scope registration failed (self-heals at boot):', err)
  }
  try {
    notifyWorkspaceCreated({ landscapeId, versionId, rootUrl })
  } catch (err) {
    console.warn('[orgSeed] doc-index notification failed (lazy walk covers it):', err)
  }

  // Second version — a fork of the freshly-seeded Main.
  let versions = 1
  try {
    const forked = await createVersion(repo, landscapeId, 'Snapshot v1', versionId)
    if (forked) versions = 2
  } catch (err) {
    console.warn('[orgSeed] fork of Snapshot v1 failed (landscape still usable):', err)
  }

  // ── Teams + grants on the landscape scope ────────────────────────────────
  const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
  const teamsSpec: Array<{ name: string; canRead: boolean; canWrite: boolean }> = [
    { name: 'Architecture', canRead: true, canWrite: true },
    { name: 'Platform', canRead: true, canWrite: true },
    { name: 'Viewers', canRead: true, canWrite: false },
  ]
  const teamIds: string[] = []
  for (const spec of teamsSpec) {
    const { rows: existing } = await pool.query<{ id: string }>(
      'SELECT id FROM teams WHERE org_id = $1 AND name = $2 AND archived_at IS NULL LIMIT 1',
      [orgId, spec.name]
    )
    let teamId = existing[0]?.id
    if (!teamId) {
      teamId = newId()
      await pool.query('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)', [teamId, orgId, spec.name])
    }
    teamIds.push(teamId)
    await pool.query(
      `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write, updated_by)
       VALUES ($1, $2, '*', $3, $4, $5)
       ON CONFLICT (team_id, scope_id, resource_type)
       DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write, updated_by = EXCLUDED.updated_by`,
      [teamId, landscapeScopeId, spec.canRead, spec.canWrite, actorUserId]
    )
  }

  // ── Fake members across the teams ───────────────────────────────────────
  const teamForUser = [teamIds[0], teamIds[0], teamIds[1], teamIds[1], teamIds[2]]
  let users = 0
  for (let n = 1; n <= 5; n++) {
    const suffix = randomBytes(3).toString('hex')
    const userId = newId()
    const email = `seed-${n}-${suffix}@example.test`
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name, given_name, family_name)
       VALUES ($1, 'seed', $2, $3, $4, $5, $6)`,
      [userId, `seed-${suffix}-${n}`, email, `Seed User ${n}`, 'Seed', `User ${n}`]
    )
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [orgId, userId]
    )
    await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      teamForUser[n - 1],
      userId,
    ])
    users++
  }

  return {
    landscapeId,
    landscapeName,
    versions,
    diagrams: model.diagrams.length,
    objects: model.objects.length,
    connections: model.connections.length,
    teams: teamsSpec.length,
    users,
  }
}

/** Guard against concurrent seeds of the same org (the doc/DB writes are not
 * idempotent within one run). */
const inFlight = new Set<string>()

export function beginSeed(orgId: string): boolean {
  if (inFlight.has(orgId)) return false
  inFlight.add(orgId)
  return true
}

export function endSeed(orgId: string): void {
  inFlight.delete(orgId)
}
