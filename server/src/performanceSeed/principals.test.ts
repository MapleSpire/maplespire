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
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureRbacSchema } from '../rbac/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import {
  DENSE_GOVERNANCE_TEAM_MEMBERS,
  performanceTeamIds,
  seedPerformancePrincipals,
} from './principals.js'
import { TEST_PERFORMANCE_SEED_SCALE } from './types.js'

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('performance seed principal batching', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  const orgId = 'org_performance_principals'

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'performance_principals')
    pool = db.pool
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
    await pool.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Performance principals', 'performance-principals')`,
      [orgId],
    )
  }, 30_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('creates exact reusable users and teams without duplicates on replay', async () => {
    const first = await seedPerformancePrincipals(pool, orgId, TEST_PERFORMANCE_SEED_SCALE)
    const replay = await seedPerformancePrincipals(pool, orgId, TEST_PERFORMANCE_SEED_SCALE)
    expect(first).toEqual(replay)
    expect(first.teamIds).toEqual(performanceTeamIds(orgId, TEST_PERFORMANCE_SEED_SCALE.teams))
    expect(first.memberships).toBeGreaterThan(TEST_PERFORMANCE_SEED_SCALE.users)

    const counts = await pool.query<{ users: string; teams: string; memberships: string }>(
      `SELECT
         (SELECT count(*) FROM org_members WHERE org_id = $1)::text AS users,
         (SELECT count(*) FROM teams WHERE org_id = $1)::text AS teams,
         (SELECT count(*) FROM team_members member
          JOIN teams team ON team.id = member.team_id WHERE team.org_id = $1)::text AS memberships`,
      [orgId],
    )
    expect(counts.rows[0]).toEqual({
      users: String(TEST_PERFORMANCE_SEED_SCALE.users),
      teams: String(TEST_PERFORMANCE_SEED_SCALE.teams),
      memberships: String(first.memberships),
    })
    const denseTeam = await pool.query<{ members: string }>(
      'SELECT count(*)::text AS members FROM team_members WHERE team_id = $1',
      [first.teamIds[0]],
    )
    expect(denseTeam.rows[0]?.members).toBe(String(Math.min(
      DENSE_GOVERNANCE_TEAM_MEMBERS,
      TEST_PERFORMANCE_SEED_SCALE.users,
    )))
  })
})
