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
 * The tier column, and WHAT BECOMES OF A DEDICATED CELL when the organisation
 * is suspended, downgraded, or deleted. Those three answers are decisions, so
 * they are written here as assertions rather than left for a cell solver's
 * author to rediscover.
 *
 * Per-suite isolated schema: this creates and drops organisations, and must
 * not touch the shared database's default org.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { landscapeIsolation } from './landscapeTier.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('landscape tier and the dedicated-cell lifecycle (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'landscape_tier')

    // The two tables the reader joins, in the shape the real schema builds them
    // — including the CHECK, which one arm below exercises directly.
    await db.pool.query(`
      CREATE TABLE orgs (
        id     TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'))
      )
    `)
    await db.pool.query(`
      CREATE TABLE landscapes (
        id     TEXT PRIMARY KEY,
        name   TEXT NOT NULL,
        org_id TEXT,
        tier   TEXT NOT NULL DEFAULT 'standard'
                 CONSTRAINT landscapes_tier_check CHECK (tier IN ('standard', 'enterprise'))
      )
    `)
  }, 60_000)

  afterAll(async () => {
    await db?.teardown()
  })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM landscapes')
    await db.pool.query('DELETE FROM orgs')
    await db.pool.query(`INSERT INTO orgs (id, status) VALUES ('org-1', 'active')`)
    await db.pool.query(
      `INSERT INTO landscapes (id, name, org_id, tier)
       VALUES ('ls-ent', 'Enterprise', 'org-1', 'enterprise'),
              ('ls-std', 'Standard',   'org-1', 'standard')`,
    )
  })

  it('an ENTERPRISE landscape in an active org is owed a dedicated cell', async () => {
    // The baseline every other arm is a departure from. Without it, each
    // "becomes soft" assertion below is equally satisfied by a reader that
    // never returns `hard` at all.
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'hard', tier: 'enterprise', orgStatus: 'active',
    })
  })

  it('a STANDARD landscape is not, which is D2’s soft/hard line', async () => {
    await expect(landscapeIsolation(db.pool, 'ls-std')).resolves.toMatchObject({
      isolation: 'soft', tier: 'standard',
    })
  })

  it('SUSPENDED: the grant is revoked while suspended, and RETURNS on un-suspension', async () => {
    // Revoked because suspension already means the org is not served at all —
    // login is refused and docScope excludes it — so a reserved cell would be
    // capacity held for a tenant that cannot use it.
    await db.pool.query(`UPDATE orgs SET status = 'suspended' WHERE id = 'org-1'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'soft', tier: 'enterprise', orgStatus: 'suspended',
    })

    // The tier is UNCHANGED throughout: what was bought did not move, only what
    // is owed. Asserting the round trip is what distinguishes "revoked" from
    // "downgraded", and those must not be the same operation.
    await db.pool.query(`UPDATE orgs SET status = 'active' WHERE id = 'org-1'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'hard', tier: 'enterprise',
    })
  })

  it('DOWNGRADED: soft, and it does NOT come back when the org is untouched', async () => {
    await db.pool.query(`UPDATE landscapes SET tier = 'standard' WHERE id = 'ls-ent'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'soft', tier: 'standard', orgStatus: 'active',
    })
  })

  it('DELETED: `absent`, which is deliberately not the same answer as `soft`', async () => {
    // A caller that cannot tell "wants no dedicated cell" from "is gone" keeps
    // a placement alive for a row that no longer exists.
    await db.pool.query(`DELETE FROM landscapes WHERE id = 'ls-ent'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'absent', tier: null, orgStatus: null,
    })
  })

  it('a landscape whose ORG row is gone is soft, not absent — the landscape still exists', async () => {
    // The LEFT JOIN's reason. An inner join would report `absent` here, and
    // `absent` means "stop placing this landscape" — which would strand a
    // landscape that is merely missing its org row.
    await db.pool.query(`UPDATE landscapes SET org_id = 'no-such-org' WHERE id = 'ls-ent'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'soft', tier: 'enterprise', orgStatus: null,
    })
  })

  it('a PRE-ORG landscape (null org_id) is soft', async () => {
    await db.pool.query(`UPDATE landscapes SET org_id = NULL WHERE id = 'ls-ent'`)
    await expect(landscapeIsolation(db.pool, 'ls-ent')).resolves.toMatchObject({
      isolation: 'soft', orgStatus: null,
    })
  })

  it('the CHECK constraint refuses a tier the solver would not understand', async () => {
    // The tier is "two values and nothing else". Without the constraint, a typo or a
    // future `'premium'` becomes a landscape the solver silently treats as
    // soft, which is a downgrade nobody ordered and nothing reports.
    await expect(
      db.pool.query(`UPDATE landscapes SET tier = 'premium' WHERE id = 'ls-std'`),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('defaults to standard, so an existing row cannot become enterprise by migration', async () => {
    // The column is added to a populated table. A default of `enterprise`
    // would hand every existing landscape a dedicated cell at deploy.
    await db.pool.query(`INSERT INTO landscapes (id, name, org_id) VALUES ('ls-new', 'New', 'org-1')`)
    await expect(landscapeIsolation(db.pool, 'ls-new')).resolves.toMatchObject({
      isolation: 'soft', tier: 'standard',
    })
  })
})
