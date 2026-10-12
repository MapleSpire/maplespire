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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { ensureAuthSchema } from '../auth/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ICON_CATALOG } from '../ai/core/tools/iconCatalog.gen.js'
import { ensureTechnologySchema } from './schema.js'
import { SEEDED_TECHNOLOGY_CATALOG_REVISION, iconSeedId, seedTechnologyCatalog } from './seed.js'
import { TechnologyRepository } from './repository.js'

const connectionString = process.env.TEST_DATABASE_URL
const ORG_ID = 'org_seed_revision'
const ACTOR = 'system:technology-seed'

/** The re-artworked Oracle entries carry their own, higher seeded revision. */
const ORACLE = ICON_CATALOG.find((entry) => entry.name === 'Oracle Database')!
const ORACLE_ID = iconSeedId('Oracle Database')
const OLD_LIGHT = '/icons/light/QVbvGclh6usFM0yDtSDV.png'
const OLD_DARK = '/icons/dark/Uv2WHhtn5sx3KcrKNFLc.png'

/** A database as an earlier release left it: Oracle Database at the
 * catalog-wide revision, pointing at the old wordmark artwork. */
async function previousRelease(
  pool: Pool,
  extra?: (pool: Pool) => Promise<void>,
  options: { createdBy?: string; merged?: boolean } = {},
) {
  await ensureAuthSchema(pool)
  await ensureTechnologySchema(pool)
  await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Seed Revision', 'seed-revision')`, [ORG_ID])
  const base = SEEDED_TECHNOLOGY_CATALOG_REVISION
  if (options.merged) {
    await pool.query(
      `INSERT INTO technology_identities (id, scope, lifecycle_status, latest_revision, current_revision, created_by)
       VALUES ('tech_merge_target', 'public', 'active', 1, NULL, $1)`,
      [ACTOR],
    )
  }
  await pool.query(
    `INSERT INTO technology_identities
       (id, scope, lifecycle_status, canonical_technology_id, latest_revision, current_revision, created_by)
     VALUES ($1, 'public', $4, $5, $2, $2, $3)`,
    [ORACLE_ID, base, ACTOR, options.merged ? 'merged' : 'active', options.merged ? 'tech_merge_target' : null],
  )
  await pool.query(
    `INSERT INTO technology_revisions
       (technology_id, revision, name, normalized_name, icon_light_path, icon_dark_path, search_document, created_by)
     VALUES ($1, $2, 'Oracle Database', 'oracle database', $3, $4, 'oracle database', $5)`,
    [ORACLE_ID, base, OLD_LIGHT, OLD_DARK, options.createdBy ?? ACTOR],
  )
  await pool.query(
    `INSERT INTO technology_revision_workflows (technology_id, revision, status, decided_by, decided_at)
     VALUES ($1, $2, 'approved', $3, now())`,
    [ORACLE_ID, base, ACTOR],
  )
  await extra?.(pool)
}

async function current(pool: Pool) {
  const { rows } = await pool.query<{ current_revision: number; latest_revision: number; icon_light_path: string | null; description: string | null; website_url: string | null }>(
    `SELECT i.current_revision, i.latest_revision, r.icon_light_path, r.description, r.website_url
     FROM technology_identities i
     JOIN technology_revisions r ON r.technology_id = i.id AND r.revision = i.current_revision
     WHERE i.id = $1`,
    [ORACLE_ID],
  )
  return rows[0]
}

describe.skipIf(!connectionString)('seeded revision of a re-artworked catalog entry', () => {
  let db: IsolatedSchemaDb | undefined

  afterEach(async () => {
    await db?.teardown()
    db = undefined
  })

  it('the catalog entry carries a revision above the catalog-wide one', () => {
    expect(ORACLE.revision).toBeGreaterThan(SEEDED_TECHNOLOGY_CATALOG_REVISION)
    expect(ORACLE.iconLight).not.toBe(OLD_LIGHT)
    // Non-empty, so the assertions below cannot pass on null === undefined.
    expect(ORACLE.description?.trim()).toBeTruthy()
    expect(ORACLE.website?.startsWith('https://')).toBe(true)
  })

  it('moves a database that holds the old artwork onto the new revision', async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_seed_upgrade')
    await previousRelease(db.pool)
    expect((await current(db.pool)).icon_light_path).toBe(OLD_LIGHT)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTechnologyCatalog(db.pool, ORG_ID)
      await seedTechnologyCatalog(db.pool, ORG_ID)
      expect(warn.mock.calls.filter(([line]) => String(line).includes('seed_revision_not_current'))).toEqual([])
    } finally {
      warn.mockRestore()
    }

    expect(await current(db.pool)).toEqual({
      current_revision: ORACLE.revision,
      latest_revision: ORACLE.revision,
      icon_light_path: ORACLE.iconLight,
      description: ORACLE.description,
      website_url: ORACLE.website,
    })
    const { rows } = await db.pool.query<{ action: string }>(
      `SELECT action FROM technology_audit WHERE technology_id = $1`, [ORACLE_ID],
    )
    expect(rows.map((row) => row.action)).toEqual(['technology.seed_revision_added'])
  }, 60_000)

  it('never publishes a platform admin\'s draft that took the same revision number', async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_seed_draft_guard')
    const draftRevision = ORACLE.revision!
    await previousRelease(db.pool, async (pool) => {
      // createPublicRevision takes latest_revision + 1 as a DRAFT.
      await pool.query(
        `INSERT INTO technology_revisions
           (technology_id, revision, name, normalized_name, icon_light_path, search_document, created_by)
         VALUES ($1, $2, 'Oracle Database (draft)', 'oracle database draft', '/assets/technologies/draft.png', 'draft', 'user_platform_admin')`,
        [ORACLE_ID, draftRevision],
      )
      await pool.query(
        `INSERT INTO technology_revision_workflows (technology_id, revision, status) VALUES ($1, $2, 'draft')`,
        [ORACLE_ID, draftRevision],
      )
      await pool.query(`UPDATE technology_identities SET latest_revision = $2 WHERE id = $1`, [ORACLE_ID, draftRevision])
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTechnologyCatalog(db.pool, ORG_ID)
      const after = await current(db.pool)
      expect(after.current_revision).toBe(SEEDED_TECHNOLOGY_CATALOG_REVISION)
      expect(after.icon_light_path).toBe(OLD_LIGHT)
      const { rows } = await db.pool.query<{ status: string }>(
        `SELECT status FROM technology_revision_workflows WHERE technology_id = $1 AND revision = $2`,
        [ORACLE_ID, draftRevision],
      )
      expect(rows).toEqual([{ status: 'draft' }])
      expectReportedBehind(warn, SEEDED_TECHNOLOGY_CATALOG_REVISION)
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  it('never replaces a revision a platform admin curated and published', async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_seed_admin_curated')
    await previousRelease(db.pool, undefined, { createdBy: 'user_platform_admin' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTechnologyCatalog(db.pool, ORG_ID)
      const after = await current(db.pool)
      expect(after.current_revision).toBe(SEEDED_TECHNOLOGY_CATALOG_REVISION)
      expect(after.icon_light_path).toBe(OLD_LIGHT)
      // The seed's revision is stored, not made current — and latest_revision
      // covers it, so the admin's next revision number cannot collide with it.
      expect(after.latest_revision).toBe(ORACLE.revision)
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM technology_revisions WHERE technology_id = $1 AND revision = $2`,
        [ORACLE_ID, ORACLE.revision],
      )
      expect(rows[0].n).toBe('1')
      expectReportedBehind(warn, SEEDED_TECHNOLOGY_CATALOG_REVISION)
    } finally {
      warn.mockRestore()
    }

    // Found by the QA lens: with latest_revision left behind, this threw a
    // duplicate key on (technology_id, revision) on every attempt.
    const created = await new TechnologyRepository(db.pool).createPublicRevision('user_platform_admin', ORACLE_ID, {
      name: 'Oracle Database',
      duplicateCheck: { query: 'Oracle Database', confirmedNoMatch: true, overrideReason: 'admin keeps curating' },
    } as never)
    expect(created.revision.revision).toBe(ORACLE.revision! + 1)
  }, 60_000)

  it('leaves a merged identity where it is', async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_seed_merged')
    await previousRelease(db.pool, undefined, { merged: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTechnologyCatalog(db.pool, ORG_ID)
      expect((await current(db.pool)).current_revision).toBe(SEEDED_TECHNOLOGY_CATALOG_REVISION)
      expectReportedBehind(warn, SEEDED_TECHNOLOGY_CATALOG_REVISION)
    } finally {
      warn.mockRestore()
    }
  }, 60_000)
})

/** The skip is logged with the entry, its current and its seeded revision. */
function expectReportedBehind(warn: { mock: { calls: unknown[][] } }, currentRevision: number) {
  const events = warn.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)) } catch { return null } })
    .filter((event) => event?.event === 'technology.seed_revision_not_current')
  expect(events).toHaveLength(1)
  expect(events[0].entries).toEqual(expect.arrayContaining([
    { name: 'Oracle Database', current: currentRevision, seeded: ORACLE.revision, lifecycle: expect.any(String) },
  ]))
}
