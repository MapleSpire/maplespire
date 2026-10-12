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
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureTagSchema } from './schema.js'
import { SEEDED_TAG_DEFINITIONS, SEEDED_TAG_GROUPS, seedTagCatalog } from './seed.js'

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('Tag catalog seed PostgreSQL invariants', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  const orgId = 'org_tag_seed_test'
  const actorId = 'user_tag_seed_admin'

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'tag_seed')
    pool = db.pool
    await ensureAuthSchema(pool)
    await pool.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Tag Seed Test', 'tag-seed-test')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name)
       VALUES ($1, 'test', $1, 'tag-seed-admin@example.test', 'Tag Seed Admin')`,
      [actorId],
    )
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [orgId, actorId],
    )
    await ensureTagSchema(pool)
  }, 30_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('reuses active semantic group and tag identities when their IDs are not seed-generated', async () => {
    const customGroupId = 'taggrp_existing_risk'
    const customTagId = 'tag_existing_risk_high'
    await pool.query(
      `INSERT INTO tag_groups (
         id, org_id, name, normalized_name, description, sort_key,
         lifecycle_status, version, created_by, updated_by
       ) VALUES ($1, $2, 'Risk', 'risk', 'User-managed group', '000000000000000777',
         'active', 1, $3, $3)`,
      [customGroupId, orgId, actorId],
    )
    await pool.query(
      `INSERT INTO tags (
         id, org_id, group_id, value, normalized_value, color, sort_key,
         lifecycle_status, version, created_by, updated_by
       ) VALUES ($1, $2, $3, 'High', 'high', '#112233', '000000000000000888',
         'active', 1, $4, $4)`,
      [customTagId, orgId, customGroupId, actorId],
    )

    await seedTagCatalog(pool, orgId, actorId)
    await seedTagCatalog(pool, orgId, actorId)

    const riskGroups = await pool.query<{ id: string; description: string; count: string }>(
      `SELECT min(id) AS id, min(description) AS description, count(*)::text AS count
       FROM tag_groups
       WHERE org_id = $1 AND normalized_name = 'risk' AND lifecycle_status = 'active'`,
      [orgId],
    )
    expect(riskGroups.rows[0]).toMatchObject({
      id: customGroupId,
      description: 'User-managed group',
      count: '1',
    })

    const highTags = await pool.query<{ id: string; color: string; count: string }>(
      `SELECT min(id) AS id, min(color) AS color, count(*)::text AS count
       FROM tags
       WHERE org_id = $1 AND group_id = $2 AND normalized_value = 'high'
         AND lifecycle_status = 'active'`,
      [orgId, customGroupId],
    )
    expect(highTags.rows[0]).toMatchObject({ id: customTagId, color: '#112233', count: '1' })

    const seededGroups = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tag_groups
       WHERE org_id = $1 AND lifecycle_status = 'active'
         AND normalized_name = ANY($2::text[])`,
      [orgId, SEEDED_TAG_GROUPS.map((name) => name.toLowerCase())],
    )
    const seededTags = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tags
       WHERE org_id = $1 AND lifecycle_status = 'active'`,
      [orgId],
    )
    expect(Number(seededGroups.rows[0].count)).toBe(SEEDED_TAG_GROUPS.length)
    expect(Number(seededTags.rows[0].count)).toBe(SEEDED_TAG_DEFINITIONS.length)
  })
})
