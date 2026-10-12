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
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import type { Pool } from 'pg'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { ensureAuthSchema } from '../auth/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { requireTechnologyCapability } from './access.js'
import { ensureManagedTechnologyCatalog } from './bootstrap.js'
import { normalizeTechnologyTerm, validateTechnologyRevisionInput } from './normalize.js'
import { searchPublicTechnologies, TechnologyRepository, TechnologyRepositoryError } from './repository.js'
import { ensureTechnologySchema } from './schema.js'
import {
  SEEDED_TECHNOLOGY_CATALOG_REVISION,
  SEEDED_TECHNOLOGY_CATALOG_SIZE,
  SEEDED_TECHNOLOGY_IDS,
  seedTechnologyCatalog,
} from './seed.js'
import { registerTechnologyRoutes } from './routes.js'
import { gcStaleTechnologyAssets, storeGovernedTechnologyIcon } from './assets.js'
import { ICON_CATALOG } from '../ai/core/tools/iconCatalog.gen.js'

describe('technology normalization and validation', () => {
  it('normalizes accents, punctuation and whitespace deterministically', () => {
    expect(normalizeTechnologyTerm('  NÉST---JS  ')).toBe('nest js')
    expect(normalizeTechnologyTerm('C# / .NET')).toBe('c# .net')
  })

  it('accepts only immutable hashed catalog asset paths', () => {
    const uploadedPath = `/assets/technologies/${'a'.repeat(64)}.svg`
    expect(validateTechnologyRevisionInput({
      name: 'Example',
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
      iconLightPath: uploadedPath,
    }).iconLightPath).toBe(uploadedPath)
    const publicCatalogPath = ICON_CATALOG.find((icon) => icon.name === 'PostgreSQL')!.iconLight!
    expect(validateTechnologyRevisionInput({
      name: 'Public catalog artwork',
      recommendedShapeTypes: ['store'],
      defaultRole: 'database',
      iconLightPath: publicCatalogPath,
    }).iconLightPath).toBe(publicCatalogPath)

    expect(() => validateTechnologyRevisionInput({
      name: 'Example',
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
      iconLightPath: 'data:image/svg+xml,<svg/>',
    })).toThrow(/immutable governed/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Example',
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
      iconLightPath: `/assets/technologies/../${'a'.repeat(64)}.svg`,
    })).toThrow(/immutable governed/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Example',
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
      iconLightPath: `/assets/technologies/${'a'.repeat(64)}.js`,
    })).toThrow(/immutable governed/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Example',
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
      iconLightPath: '/assets/technologies/1a2b3c4d.svg',
    })).toThrow(/immutable governed/)
  })

  it('requires one or more supported recommendation targets and validates the governed default role', () => {
    expect(validateTechnologyRevisionInput({
      name: 'PostgreSQL profile',
      recommendedShapeTypes: ['store', 'app', 'store'],
      defaultRole: 'database',
    })).toMatchObject({
      recommendedShapeTypes: ['app', 'store'],
      defaultRole: 'database',
    })

    expect(() => validateTechnologyRevisionInput({ name: 'No recommendation' }))
      .toThrow(/between 1 and 5/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Actor recommendation', recommendedShapeTypes: ['actor'],
    })).toThrow(/system, app, store, component, group/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Missing role', recommendedShapeTypes: ['app'],
    })).toThrow(/defaultRole must be one of/)
    expect(() => validateTechnologyRevisionInput({
      name: 'Unknown role', recommendedShapeTypes: ['app'], defaultRole: 'cache',
    })).toThrow(/defaultRole must be one of/)
  })
})

describe('technology capabilities', () => {
  const oldAuth = process.env.AUTH
  afterAll(() => {
    if (oldAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = oldAuth
  })

  function response() {
    const state = { status: 200, body: undefined as unknown }
    const res = {
      status(code: number) { state.status = code; return this },
      json(body: unknown) { state.body = body; return this },
    } as unknown as Response
    return { res, state }
  }

  function request(role: 'admin' | 'member', platform = false): { req: Request; pool: Pool } {
    const req = {
      auth: { userId: 'user-1', orgId: 'org-1', isPlatformAdmin: platform, epoch: 1 },
    } as Request
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM users')) return { rows: [{ is_platform_admin: platform, status: 'active' }] }
        if (sql.includes('FROM org_members')) return { rows: [{ role, org_status: 'active' }] }
        throw new Error(`Unexpected query: ${sql}`)
      },
    } as unknown as Pool
    return { req, pool }
  }

  it('allows a member to view but not manage an organization catalog', async () => {
    process.env.AUTH = 'on'
    const { req, pool } = request('member')
    expect(await requireTechnologyCapability(pool, req, response().res, 'technology.view', 'org-1')).not.toBeNull()
    const denied = response()
    expect(await requireTechnologyCapability(pool, req, denied.res, 'technology.manage', 'org-1')).toBeNull()
    expect(denied.state.status).toBe(403)
  })

  it('requires a freshly verified platform flag for publication', async () => {
    process.env.AUTH = 'on'
    const { req, pool } = request('admin', false)
    req.auth!.isPlatformAdmin = true // stale signed claim must not be trusted
    const denied = response()
    expect(await requireTechnologyCapability(pool, req, denied.res, 'technology.platform_publish')).toBeNull()
    expect(denied.state.status).toBe(403)
  })
})

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('technology catalog PostgreSQL invariants', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  let repository: TechnologyRepository
  const orgId = 'org_technology_test'
  const actorId = 'user_technology_admin'
  const memberId = 'user_technology_member'

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'technology_catalog')
    pool = db.pool
    await ensureAuthSchema(pool)
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Technology Test', 'technology-test')`, [orgId])
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name)
       VALUES ($1, 'test', $1, 'technology-admin@example.test', 'Technology Admin')`,
      [actorId]
    )
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name)
       VALUES ($1, 'test', $1, 'technology-member@example.test', 'Technology Member')`,
      [memberId]
    )
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, actorId])
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId])
    repository = new TechnologyRepository(pool)
    await ensureManagedTechnologyCatalog(pool, orgId)
  }, 30_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('seeds an approved public catalog idempotently and exposes deterministic search', async () => {
    await seedTechnologyCatalog(pool, orgId, actorId)
    await seedTechnologyCatalog(pool, orgId, actorId)

    const identities = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM technology_identities')
    const audits = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM technology_audit WHERE action = 'technology.seeded'`
    )
    expect(Number(identities.rows[0].n)).toBe(SEEDED_TECHNOLOGY_CATALOG_SIZE)
    expect(Number(audits.rows[0].n)).toBe(SEEDED_TECHNOLOGY_CATALOG_SIZE)
    expect(SEEDED_TECHNOLOGY_CATALOG_SIZE).toBeGreaterThanOrEqual(3_900)

    const matches = await searchPublicTechnologies(pool, 'postgres', 5)
    expect(matches[0]).toMatchObject({
      id: SEEDED_TECHNOLOGY_IDS.PostgreSQL,
      scope: 'public',
      revision: {
        revision: SEEDED_TECHNOLOGY_CATALOG_REVISION,
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
        iconLightPath: expect.stringMatching(/^\/icons\/light\//),
        iconDarkPath: expect.stringMatching(/^\/icons\/dark\//),
      },
    })
    expect(matches.every((match) => match.revision.status === 'approved')).toBe(true)
  })

  it('gives a newly created organization the full platform-managed catalog without an org demo seed', async () => {
    const freshOrgId = 'org_technology_fresh'
    await pool.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Fresh Technology Org', 'fresh-technology-org')`,
      [freshOrgId],
    )

    const firstPage = await repository.list(freshOrgId, { selectable: true, limit: 50 })
    expect(firstPage.technologies).toHaveLength(50)
    expect(firstPage.nextCursor).toBeTruthy()
    expect(firstPage.policy).toBe('all')
    expect(firstPage.technologies.every((technology) => (
      technology.scope === 'public'
      && technology.orgState === 'enabled'
      && technology.orgOverride === null
    ))).toBe(true)

    const react = await repository.list(freshOrgId, { q: 'React', selectable: true, limit: 10 })
    expect(react.technologies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: SEEDED_TECHNOLOGY_IDS.React,
        orgState: 'enabled',
        orgOverride: null,
      }),
    ]))
  })

  it('serves the stable tenant API contract and enforces search-before-create', async () => {
    const previousAuth = process.env.AUTH
    process.env.AUTH = 'on'
    const app = express()
    const memberInvisibleDraft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Member Invisible Draft',
      aliases: [],
      duplicateCheck: { query: 'Member Invisible Draft', confirmedNoMatch: true },
    })
    const approvedWithNewDraft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Approved With Pending Revision',
      aliases: [],
      duplicateCheck: { query: 'Approved With Pending Revision', confirmedNoMatch: true },
    })
    await repository.approvePrivate(orgId, actorId, approvedWithNewDraft.id, 1)
    await repository.createRevision(orgId, actorId, approvedWithNewDraft.id, {
      name: 'Approved With Pending Revision v2',
      aliases: [],
      duplicateCheck: { query: 'Approved With Pending Revision v2', confirmedNoMatch: true },
    })
    app.use(express.json())
    app.use((req, _res, next) => {
      const userId = req.headers['x-test-member'] === '1' ? memberId : actorId
      req.auth = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      next()
    })
    registerTechnologyRoutes(app, pool)
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener))
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const listResponse = await fetch(`${url}/api/orgs/${orgId}/technologies?selectable=1&q=react&limit=10`)
      expect(listResponse.status).toBe(200)
      const list = await listResponse.json() as Record<string, unknown>
      expect(list).toMatchObject({
        technologies: expect.arrayContaining([expect.objectContaining({
          id: SEEDED_TECHNOLOGY_IDS.React,
          orgState: 'enabled',
          orgOverride: null,
          revision: expect.objectContaining({
            recommendedShapeTypes: ['app', 'component'],
            defaultRole: 'framework',
          }),
        })]),
        nextCursor: null,
        policy: 'all',
      })

      const filteredResponse = await fetch(
        `${url}/api/orgs/${orgId}/technologies?selectable=1&category=Database&shapeType=store&role=database&limit=50`
      )
      expect(filteredResponse.status).toBe(200)
      const filtered = await filteredResponse.json() as { technologies: Array<{ revision: { category: string; recommendedShapeTypes: string[]; defaultRole: string } }> }
      expect(filtered.technologies.length).toBeGreaterThan(0)
      expect(filtered.technologies.every((technology) =>
        technology.revision.category === 'Database'
        && technology.revision.recommendedShapeTypes.includes('store')
        && technology.revision.defaultRole === 'database'
      )).toBe(true)

      const facetsResponse = await fetch(`${url}/api/orgs/${orgId}/technologies/facets?selectable=true`)
      expect(facetsResponse.status).toBe(200)
      expect(await facetsResponse.json()).toMatchObject({
        categories: expect.arrayContaining([expect.objectContaining({ value: 'Database' })]),
        shapeTypes: expect.arrayContaining([expect.objectContaining({ value: 'store' })]),
        roles: expect.arrayContaining([expect.objectContaining({ value: 'database' })]),
      })

      const memberListResponse = await fetch(
        `${url}/api/orgs/${orgId}/technologies?q=Member%20Invisible%20Draft`,
        { headers: { 'x-test-member': '1' } }
      )
      expect(memberListResponse.status).toBe(200)
      expect(await memberListResponse.json()).toMatchObject({ technologies: [] })

      const adminListResponse = await fetch(`${url}/api/orgs/${orgId}/technologies?q=Member%20Invisible%20Draft`)
      expect(await adminListResponse.json()).toMatchObject({
        technologies: [expect.objectContaining({
          id: memberInvisibleDraft.id,
          revision: expect.objectContaining({ status: 'draft' }),
        })],
      })

      const memberDraftGet = await fetch(
        `${url}/api/orgs/${orgId}/technologies/${memberInvisibleDraft.id}`,
        { headers: { 'x-test-member': '1' } }
      )
      expect(memberDraftGet.status).toBe(404)

      const adminDraftGet = await fetch(`${url}/api/orgs/${orgId}/technologies/${memberInvisibleDraft.id}`)
      expect(adminDraftGet.status).toBe(200)

      const memberCurrentGet = await fetch(
        `${url}/api/orgs/${orgId}/technologies/${approvedWithNewDraft.id}`,
        { headers: { 'x-test-member': '1' } }
      )
      expect(memberCurrentGet.status).toBe(200)
      expect(await memberCurrentGet.json()).toMatchObject({
        technology: {
          id: approvedWithNewDraft.id,
          revision: { revision: 1, name: 'Approved With Pending Revision', privateApproved: true },
        },
      })

      const createResponse = await fetch(`${url}/api/orgs/${orgId}/technologies/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'React alternative',
          recommendedShapeTypes: ['app', 'component'],
          defaultRole: 'framework',
        }),
      })
      expect(createResponse.status).toBe(409)
      expect(await createResponse.json()).toMatchObject({
        error: 'public_catalog_search_required',
        details: { matches: expect.any(Array) },
      })

      const revisionResponse = await fetch(
        `${url}/api/orgs/${orgId}/technologies/${memberInvisibleDraft.id}/revisions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Member Invisible Draft v2',
            aliases: [],
            recommendedShapeTypes: ['app'],
            defaultRole: 'other',
          }),
        }
      )
      expect(revisionResponse.status).toBe(409)
      expect(await revisionResponse.json()).toMatchObject({ error: 'public_catalog_search_required' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (previousAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = previousAuth
    }
  })

  it('applies policy and sparse overrides to selectable results', async () => {
    await repository.setPolicy(orgId, actorId, 'none')
    let selectable = await repository.list(orgId, { selectable: true, scope: 'public', limit: 100 })
    expect(selectable.technologies).toHaveLength(0)

    await repository.setOverride(orgId, actorId, SEEDED_TECHNOLOGY_IDS.React, 'enabled')
    selectable = await repository.list(orgId, { selectable: true, scope: 'public', limit: 100 })
    expect(selectable.technologies).toEqual([
      expect.objectContaining({
        id: SEEDED_TECHNOLOGY_IDS.React,
        orgState: 'enabled',
        orgOverride: 'enabled',
      }),
    ])

    await repository.clearOverride(orgId, actorId, SEEDED_TECHNOLOGY_IDS.React)
    selectable = await repository.list(orgId, { selectable: true, scope: 'public', limit: 100 })
    expect(selectable.technologies).toHaveLength(0)
    await repository.setPolicy(orgId, actorId, 'all')
  })

  it('persists tenant-scoped asset metadata and an append-only upload audit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-pg-assets-'))
    try {
      const asset = await storeGovernedTechnologyIcon(pool, {
        orgId,
        actorUserId: actorId,
        raw: Buffer.from('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'),
        declaredContentType: 'image/svg+xml',
        directory,
      })
      const metadata = await pool.query(
        `SELECT path, content_type, bytes, created_by, reference_count
         FROM technology_assets WHERE org_id = $1 AND sha256 = $2`,
        [orgId, asset.sha256],
      )
      expect(metadata.rows).toEqual([expect.objectContaining({
        path: asset.path,
        content_type: 'image/svg+xml',
        bytes: asset.bytes,
        created_by: actorId,
        reference_count: 0,
      })])
      const audit = await pool.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM technology_audit
         WHERE org_id = $1 AND actor_user_id = $2 AND action = 'technology.asset_uploaded'
         ORDER BY created_at DESC LIMIT 1`,
        [orgId, actorId],
      )
      expect(audit.rows[0]?.detail).toMatchObject({ sha256: asset.sha256, path: asset.path, bytes: asset.bytes })

      const draft = await repository.createPrivateDraft(orgId, actorId, {
        name: 'Unique Uploaded Icon Candidate',
        aliases: [],
        iconLightPath: asset.path,
        iconDarkPath: asset.path,
        duplicateCheck: { query: 'Unique Uploaded Icon Candidate', confirmedNoMatch: true },
      })
      expect(draft.revision.iconLightPath).toBe(asset.path)
      expect((await pool.query<{ reference_count: number }>(
        'SELECT reference_count FROM technology_assets WHERE org_id = $1 AND sha256 = $2',
        [orgId, asset.sha256],
      )).rows[0]?.reference_count).toBe(1)

      await repository.createRevision(orgId, actorId, draft.id, {
        name: 'Unique Uploaded Icon Candidate v2',
        aliases: [],
        iconLightPath: asset.path,
        duplicateCheck: { query: 'Unique Uploaded Icon Candidate v2', confirmedNoMatch: true },
      })
      expect((await pool.query<{ reference_count: number }>(
        'SELECT reference_count FROM technology_assets WHERE org_id = $1 AND sha256 = $2',
        [orgId, asset.sha256],
      )).rows[0]?.reference_count).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('garbage collects stale unreferenced asset metadata and its quarantined blob atomically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maplespire-technology-pg-asset-gc-'))
    try {
      const asset = await storeGovernedTechnologyIcon(pool, {
        orgId,
        actorUserId: actorId,
        raw: Buffer.from('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'),
        declaredContentType: 'image/svg+xml',
        directory,
      })
      await pool.query(
        `UPDATE technology_assets
         SET last_uploaded_at = now() - interval '48 hours'
         WHERE org_id = $1 AND sha256 = $2`,
        [orgId, asset.sha256],
      )

      await expect(gcStaleTechnologyAssets(pool, { directory, ttlHours: 24, limit: 10 }))
        .resolves.toMatchObject({ metadataDeleted: 1, blobsDeleted: 1, deferred: 0 })
      expect((await pool.query(
        'SELECT 1 FROM technology_assets WHERE org_id = $1 AND sha256 = $2',
        [orgId, asset.sha256],
      )).rows).toHaveLength(0)
      expect((await pool.query(
        `SELECT 1 FROM technology_audit
         WHERE org_id = $1 AND action = 'technology.asset_gc_deleted'
           AND detail->>'sha256' = $2`,
        [orgId, asset.sha256],
      )).rows).toHaveLength(1)
      expect(await readdir(directory)).not.toContain(`${asset.sha256}.svg`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces duplicate confirmation, workflow transitions and canonical merge resolution', async () => {
    const input = {
      name: 'Nest JS',
      aliases: ['NestJS internal'],
      description: 'Organization-specific NestJS profile.',
      duplicateCheck: { query: 'Nest JS', confirmedNoMatch: true as const },
    }
    await expect(repository.createPrivateDraft(orgId, actorId, input)).rejects.toMatchObject({
      status: 409,
      code: 'probable_duplicate_requires_confirmation',
    })

    const draft = await repository.createPrivateDraft(orgId, actorId, {
      ...input,
      duplicateCheck: { ...input.duplicateCheck, overrideReason: 'Internal governed profile differs from public entry.' },
    })
    expect(draft.revision.status).toBe('draft')
    expect((await repository.approvePrivate(orgId, actorId, draft.id, 1)).revision).toMatchObject({
      status: 'approved', privateApproved: true,
    })
    expect((await repository.submitPublic(orgId, actorId, draft.id, 1)).revision).toMatchObject({
      status: 'in_review', privateApproved: true,
    })

    await repository.setPolicy(orgId, actorId, 'none')
    const targetBefore = (await repository.get(orgId, SEEDED_TECHNOLOGY_IDS.NestJS))!.technology
    const mergeResult = await repository.merge(actorId, draft.id, 1, SEEDED_TECHNOLOGY_IDS.NestJS, {
      mergedRevision: {
        ...targetBefore.revision,
        description: draft.revision.description,
        aliases: [...new Set([...targetBefore.revision.aliases, ...draft.revision.aliases])],
      },
      fieldDecisions: {
        name: 'keep_public',
        description: 'take_proposal',
        websiteUrl: 'keep_public',
        documentationUrl: 'keep_public',
        aliases: 'edit',
        category: 'keep_public',
        iconLightPath: 'keep_public',
        iconDarkPath: 'keep_public',
        recommendedShapeTypes: 'keep_public',
        defaultRole: 'keep_public',
      },
    })
    expect(mergeResult).toEqual({
      canonicalTechnologyId: SEEDED_TECHNOLOGY_IDS.NestJS,
      canonicalRevision: targetBefore.revision.revision + 1,
    })
    const latest = await repository.get(orgId, draft.id)
    expect(latest?.resolution).toMatchObject({
      requestedId: draft.id,
      canonicalTechnologyId: SEEDED_TECHNOLOGY_IDS.NestJS,
      redirected: true,
    })
    expect(latest?.technology.id).toBe(SEEDED_TECHNOLOGY_IDS.NestJS)
    expect(latest?.technology.revision).toMatchObject({
      revision: targetBefore.revision.revision + 1,
      description: 'Organization-specific NestJS profile.',
      aliases: expect.arrayContaining(['NestJS internal']),
    })

    // Effective catalogs contain only the canonical row, while audit/history
    // retains the submitted identity and names its merge target.
    const effective = await repository.list(orgId, { q: 'Nest JS', view: 'effective' })
    expect(effective.technologies).toEqual([
      expect.objectContaining({
        id: SEEDED_TECHNOLOGY_IDS.NestJS,
        redirectedFromIds: expect.arrayContaining([draft.id]),
        orgState: 'enabled',
        orgOverride: 'enabled',
      }),
    ])
    const history = await repository.list(orgId, { q: 'Nest JS', view: 'submissions' })
    expect(history.technologies).toEqual([
      expect.objectContaining({
        id: draft.id,
        lifecycleStatus: 'merged',
        canonicalTechnologyId: SEEDED_TECHNOLOGY_IDS.NestJS,
        canonicalTechnologyName: targetBefore.revision.name,
      }),
    ])

    // Availability actions starting from a legacy ID are always applied to
    // the canonical public identity.
    await repository.setOverride(orgId, actorId, draft.id, 'hidden')
    expect((await repository.get(orgId, SEEDED_TECHNOLOGY_IDS.NestJS))?.technology).toMatchObject({
      orgState: 'hidden',
      orgOverride: 'hidden',
    })
    await repository.clearOverride(orgId, actorId, draft.id)
    await repository.setPolicy(orgId, actorId, 'all')

    // A pinned use still resolves its immutable original revision and snapshot.
    const pinned = await repository.get(orgId, draft.id, 1)
    expect(pinned?.technology).toMatchObject({ id: draft.id, lifecycleStatus: 'merged' })
    expect(pinned?.technology.revision.name).toBe('Nest JS')
  })

  it('merges private identities at any workflow stage while keeping target content authoritative', async () => {
    const target = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Private Canonical Runtime',
      aliases: ['Canonical runtime'],
      description: 'The governed target content.',
      recommendedShapeTypes: ['app'],
      defaultRole: 'runtime',
      duplicateCheck: { query: 'Private Canonical Runtime', confirmedNoMatch: true },
    })
    await repository.approvePrivate(orgId, actorId, target.id, 1)
    const source = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Private Runtime Duplicate',
      aliases: ['Runtime duplicate alias'],
      description: 'Content that must not replace the target implicitly.',
      recommendedShapeTypes: ['component'],
      defaultRole: 'library',
      duplicateCheck: { query: 'Private Runtime Duplicate', confirmedNoMatch: true },
    })

    await expect(repository.mergePrivateIdentity(orgId, actorId, source.id, source.id))
      .rejects.toMatchObject({ code: 'merge_same_technology' })
    await expect(repository.mergePublicIdentity(actorId, source.id, target.id))
      .rejects.toMatchObject({ code: 'technology_not_found' })

    await expect(repository.mergePrivateIdentity(orgId, actorId, source.id, target.id))
      .resolves.toEqual({ canonicalTechnologyId: target.id })

    const resolved = await repository.get(orgId, source.id)
    expect(resolved?.resolution).toMatchObject({ redirected: true, canonicalTechnologyId: target.id })
    expect(resolved?.technology.revision).toMatchObject({
      revision: 1,
      name: 'Private Canonical Runtime',
      description: 'The governed target content.',
    })
    expect((await repository.search(orgId, 'Runtime duplicate alias', 10))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id }),
    ]))
    expect((await repository.list(orgId, { view: 'submissions', q: 'Private Runtime Duplicate' })).technologies)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: source.id,
        lifecycleStatus: 'merged',
        canonicalTechnologyId: target.id,
        canonicalTechnologyName: 'Private Canonical Runtime',
      })]))
  })

  it('removes directly merged submissions from review and activates their public canonical target', async () => {
    const source = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Direct Public Identity Duplicate',
      aliases: ['Direct duplicate'],
      recommendedShapeTypes: ['app'],
      defaultRole: 'framework',
      duplicateCheck: { query: 'Direct Public Identity Duplicate', confirmedNoMatch: true },
    })
    await repository.approvePrivate(orgId, actorId, source.id, 1)
    await repository.submitPublic(orgId, actorId, source.id, 1)
    await repository.setPolicy(orgId, actorId, 'none')

    await repository.mergePrivateIdentity(orgId, actorId, source.id, SEEDED_TECHNOLOGY_IDS.React)

    expect((await repository.listPublicReviews({ limit: 50 })).reviews)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ technology: expect.objectContaining({ id: source.id }) }),
      ]))
    expect((await repository.get(orgId, SEEDED_TECHNOLOGY_IDS.React))?.technology).toMatchObject({
      orgState: 'enabled',
      orgOverride: 'enabled',
    })
    await repository.clearOverride(orgId, actorId, SEEDED_TECHNOLOGY_IDS.React)
    await repository.setPolicy(orgId, actorId, 'all')
  })

  it('lets platform administrators merge public identities and migrates legacy organization overrides', async () => {
    const reviewerId = 'user_public_identity_merge_reviewer'
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name, is_platform_admin)
       VALUES ($1, 'test', $1, 'identity-merge-reviewer@example.test', 'Identity Merge Reviewer', true)`,
      [reviewerId],
    )
    const createPublic = async (name: string) => {
      const draft = await repository.createPublicDraft(actorId, {
        name,
        aliases: [],
        recommendedShapeTypes: ['app'],
        defaultRole: 'framework',
        duplicateCheck: { query: name, confirmedNoMatch: true },
      })
      await repository.submitPlatformReview(actorId, draft.id, 1)
      await repository.publish(reviewerId, draft.id, 1)
      return draft
    }
    const source = await createPublic('Public Identity Duplicate')
    const target = await createPublic('Public Identity Canonical')
    await repository.setOverride(orgId, actorId, source.id, 'hidden')

    await repository.mergePublicIdentity(reviewerId, source.id, target.id)

    expect((await repository.get(orgId, target.id))?.technology).toMatchObject({
      id: target.id,
      orgState: 'hidden',
      orgOverride: 'hidden',
    })
    expect((await repository.search(orgId, 'Public Identity Duplicate', 10))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id }),
    ]))
    expect((await repository.listPlatform({ q: 'Public Identity Duplicate' })).technologies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id }),
    ]))
    await repository.clearOverride(orgId, actorId, target.id)
  })

  it('publishes a new canonical public identity and records review rejection outcomes', async () => {
    const create = async (name: string) => {
      const draft = await repository.createPrivateDraft(orgId, actorId, {
        name,
        aliases: [],
        recommendedShapeTypes: ['system', 'app'],
        defaultRole: 'platform',
        duplicateCheck: { query: name, confirmedNoMatch: true },
      })
      await repository.approvePrivate(orgId, actorId, draft.id, 1)
      await repository.submitPublic(orgId, actorId, draft.id, 1)
      return draft.id
    }

    const publishSourceId = await create('Unique Publish Candidate')
    const reviewQueue = await repository.listPublicReviews({ limit: 50 })
    expect(reviewQueue.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technology: expect.objectContaining({
          id: publishSourceId,
          revision: expect.objectContaining({ status: 'in_review', privateApproved: true }),
        }),
        organization: { id: orgId, name: 'Technology Test' },
      }),
    ]))
    const published = await repository.publish(actorId, publishSourceId, 1, 'tech_public_unique_publish_candidate')
    expect(published.publicTechnologyId).toBe('tech_public_unique_publish_candidate')
    const resolved = await repository.get(orgId, publishSourceId)
    expect(resolved?.technology).toMatchObject({
      id: 'tech_public_unique_publish_candidate',
      scope: 'public',
      revision: {
        revision: 1,
        status: 'approved',
        privateApproved: false,
        name: 'Unique Publish Candidate',
        recommendedShapeTypes: ['system', 'app'],
        defaultRole: 'platform',
      },
    })

    const rejectedId = await create('Unique Rejection Candidate')
    await repository.reject(actorId, rejectedId, 1, 'changes_requested', 'Add an official documentation URL.')
    expect((await repository.get(orgId, rejectedId, 1))?.technology.revision).toMatchObject({
      status: 'changes_requested', privateApproved: true,
    })
    const selectablePrivate = await repository.list(orgId, { selectable: true, q: 'Unique Rejection Candidate' })
    expect(selectablePrivate.technologies).toEqual([
      expect.objectContaining({ id: rejectedId, revision: expect.objectContaining({ privateApproved: true }) }),
    ])
    const draftRevision = await repository.createRevision(orgId, actorId, rejectedId, {
      name: 'Unique Rejection Candidate v2',
      aliases: [],
      duplicateCheck: { query: 'Unique Rejection Candidate v2', confirmedNoMatch: true },
    })
    expect(draftRevision.revision).toMatchObject({ revision: 2, status: 'draft', privateApproved: false })
    const stillSelectable = await repository.list(orgId, { selectable: true, q: 'Unique Rejection Candidate' })
    expect(stillSelectable.technologies).toEqual([
      expect.objectContaining({
        id: rejectedId,
        revision: expect.objectContaining({ revision: 1, privateApproved: true }),
      }),
    ])
    await expect(repository.submitPublic(orgId, actorId, rejectedId, 1)).rejects.toBeInstanceOf(TechnologyRepositoryError)
  })

  it('never overwrites an explicit hidden decision during canonical auto-activation', async () => {
    const draft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Hidden Merge Availability Candidate',
      aliases: [],
      recommendedShapeTypes: ['app', 'component'],
      defaultRole: 'framework',
      duplicateCheck: { query: 'Hidden Merge Availability Candidate', confirmedNoMatch: true },
    })
    await repository.approvePrivate(orgId, actorId, draft.id, 1)
    await repository.submitPublic(orgId, actorId, draft.id, 1)
    await repository.setOverride(orgId, actorId, SEEDED_TECHNOLOGY_IDS.React, 'hidden')

    await repository.merge(actorId, draft.id, 1, SEEDED_TECHNOLOGY_IDS.React)

    expect((await repository.get(orgId, SEEDED_TECHNOLOGY_IDS.React))?.technology).toMatchObject({
      orgState: 'hidden',
      orgOverride: 'hidden',
    })
    await repository.clearOverride(orgId, actorId, SEEDED_TECHNOLOGY_IDS.React)
  })

  it('lets organization approvers request changes or reject a private draft with an auditable reason', async () => {
    const changesDraft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Private Review Changes Candidate',
      aliases: [],
      recommendedShapeTypes: ['app'],
      defaultRole: 'framework',
      duplicateCheck: { query: 'Private Review Changes Candidate', confirmedNoMatch: true },
    })
    const changed = await repository.decidePrivate(
      orgId,
      actorId,
      changesDraft.id,
      1,
      'changes_requested',
      'Clarify the internal support policy.',
    )
    expect(changed.revision).toMatchObject({
      status: 'changes_requested',
      privateApproved: false,
      decisionNote: 'Clarify the internal support policy.',
    })

    const rejectedDraft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Private Review Rejection Candidate',
      aliases: [],
      recommendedShapeTypes: ['component'],
      defaultRole: 'library',
      duplicateCheck: { query: 'Private Review Rejection Candidate', confirmedNoMatch: true },
    })
    expect((await repository.decidePrivate(
      orgId,
      actorId,
      rejectedDraft.id,
      1,
      'rejected',
      'Not approved for internal use.',
    )).revision).toMatchObject({ status: 'rejected', privateApproved: false })
  })

  it('enforces configurable independent review and bypasses it for a sole platform admin', async () => {
    const reviewerId = 'user_other_platform_admin'
    await pool.query('UPDATE users SET is_platform_admin = true, status = \'active\' WHERE id = $1', [actorId])
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name, is_platform_admin)
       VALUES ($1, 'test', $1, 'other-platform-admin@example.test', 'Other Platform Admin', true)
       ON CONFLICT (id) DO UPDATE SET is_platform_admin = true, status = 'active'`,
      [reviewerId],
    )
    const draft = await repository.createPublicDraft(actorId, {
      name: 'Platform Four Eyes Candidate',
      aliases: [],
      recommendedShapeTypes: ['system'],
      defaultRole: 'platform',
      duplicateCheck: { query: 'Platform Four Eyes Candidate', confirmedNoMatch: true },
    })
    expect(draft).toMatchObject({ scope: 'public', revision: { status: 'draft', createdBy: actorId } })
    expect((await repository.list(orgId, { q: 'Platform Four Eyes Candidate' })).technologies).toEqual([])

    await repository.submitPlatformReview(actorId, draft.id, 1)
    const queue = await repository.listPublicReviews({ limit: 50 })
    expect(queue.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'platform',
        submittedBy: actorId,
        technology: expect.objectContaining({ id: draft.id, revision: expect.objectContaining({ status: 'in_review' }) }),
      }),
    ]))
    await expect(repository.publish(actorId, draft.id, 1)).rejects.toMatchObject({ code: 'reviewer_must_differ' })
    await expect(repository.reject(actorId, draft.id, 1, 'rejected', 'Self review')).rejects.toMatchObject({ code: 'reviewer_must_differ' })

    await repository.publish(reviewerId, draft.id, 1)
    expect((await repository.list(orgId, { q: 'Platform Four Eyes Candidate' })).technologies).toEqual([
      expect.objectContaining({ id: draft.id, revision: expect.objectContaining({ status: 'approved' }) }),
    ])

    await pool.query('UPDATE users SET is_platform_admin = false WHERE id <> $1 AND is_platform_admin = true', [actorId])
    const soleAdminDraft = await repository.createPublicDraft(actorId, {
      name: 'Sole Platform Admin Candidate',
      aliases: [],
      recommendedShapeTypes: ['system'],
      defaultRole: 'platform',
      duplicateCheck: { query: 'Sole Platform Admin Candidate', confirmedNoMatch: true },
    })
    await repository.submitPlatformReview(actorId, soleAdminDraft.id, 1)
    await expect(repository.publish(actorId, soleAdminDraft.id, 1)).resolves.toMatchObject({
      publicTechnologyId: soleAdminDraft.id,
    })

    await pool.query('UPDATE users SET is_platform_admin = true, status = \'active\' WHERE id = $1', [reviewerId])
    await pool.query(
      `UPDATE platform_settings
       SET settings = jsonb_set(settings, '{requireIndependentTechnologyReview}', 'false'::jsonb, true)
       WHERE id = 'global'`,
    )
    const policyBypassDraft = await repository.createPublicDraft(actorId, {
      name: 'Policy Self Review Candidate',
      aliases: [],
      recommendedShapeTypes: ['app'],
      defaultRole: 'framework',
      duplicateCheck: { query: 'Policy Self Review Candidate', confirmedNoMatch: true },
    })
    await repository.submitPlatformReview(actorId, policyBypassDraft.id, 1)
    await expect(repository.reject(actorId, policyBypassDraft.id, 1, 'rejected', 'Policy allows this decision.')).resolves.toBeUndefined()
    await pool.query(
      `UPDATE platform_settings
       SET settings = jsonb_set(settings, '{requireIndependentTechnologyReview}', 'true'::jsonb, true)
       WHERE id = 'global'`,
    )
  })

  it('keeps uploaded platform technology artwork referenced through its owning organization', async () => {
    const asset = await storeGovernedTechnologyIcon(pool, {
      orgId,
      actorUserId: actorId,
      raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>'),
      declaredContentType: 'image/svg+xml',
    })
    const draft = await repository.createPublicDraft(actorId, {
      name: 'Platform Artwork Candidate',
      aliases: [],
      iconLightPath: asset.path,
      recommendedShapeTypes: ['app'],
      defaultRole: 'framework',
      duplicateCheck: { query: 'Platform Artwork Candidate', confirmedNoMatch: true },
    }, orgId)

    expect(draft.revision.iconLightPath).toBe(asset.path)
    const { rows } = await pool.query<{ reference_count: number }>(
      'SELECT reference_count FROM technology_assets WHERE org_id = $1 AND path = $2',
      [orgId, asset.path],
    )
    expect(rows[0]?.reference_count).toBe(1)
  })

  it('checks revision aliases for duplicates inside the revision transaction', async () => {
    const draft = await repository.createPrivateDraft(orgId, actorId, {
      name: 'Unique Alias Governance Entry',
      aliases: [],
      duplicateCheck: { query: 'Unique Alias Governance Entry', confirmedNoMatch: true },
    })
    const revision = {
      name: 'Unique Alias Governance Entry v2',
      aliases: ['React'],
      duplicateCheck: { query: 'Unique Alias Governance Entry v2', confirmedNoMatch: true as const },
    }
    await expect(repository.createRevision(orgId, actorId, draft.id, revision)).rejects.toMatchObject({
      status: 409,
      code: 'probable_duplicate_requires_confirmation',
    })
    const confirmed = await repository.createRevision(orgId, actorId, draft.id, {
      ...revision,
      duplicateCheck: {
        ...revision.duplicateCheck,
        overrideReason: 'The alias is intentionally reused for an internal compatibility profile.',
      },
    })
    expect(confirmed.revision).toMatchObject({ revision: 2, aliases: ['React'] })
  })

  it('keeps recommendation and default-role constraints strict and schema setup idempotent', async () => {
    await ensureTechnologySchema(pool)
    await ensureTechnologySchema(pool)
    await pool.query(
      `INSERT INTO technology_identities
         (id, scope, lifecycle_status, latest_revision, created_by)
       VALUES ('tech_constraint_probe', 'public', 'active', 1, $1)`,
      [actorId]
    )
    const insert = (recommendedShapeTypes: string[], defaultRole: string | null) => pool.query(
      `INSERT INTO technology_revisions
         (technology_id, revision, name, normalized_name, recommended_shape_types,
          default_role, search_document, created_by)
       VALUES ('tech_constraint_probe', 1, 'Constraint probe', 'constraint probe', $1, $2,
               'constraint probe', $3)`,
      [recommendedShapeTypes, defaultRole, actorId]
    )

    await expect(insert([], 'other')).rejects.toThrow(/recommended_shapes_check/)
    await expect(insert(['actor'], 'other')).rejects.toThrow(/recommended_shapes_check/)
    await expect(insert(['store', 'store'], 'database')).rejects.toThrow(/recommended_shapes_check/)
    await expect(insert(['app'], null)).rejects.toThrow(/default_role/)
    await expect(insert(['app'], 'cache')).rejects.toThrow(/default_role_check/)
  })

  it('enforces append-only content revisions and audit rows in PostgreSQL', async () => {
    await expect(pool.query(
      `UPDATE technology_revisions SET name = 'Tampered' WHERE technology_id = $1 AND revision = $2`,
      [SEEDED_TECHNOLOGY_IDS.React, SEEDED_TECHNOLOGY_CATALOG_REVISION]
    )).rejects.toThrow(/append-only/)

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM technology_audit LIMIT 1')
    await expect(pool.query('DELETE FROM technology_audit WHERE id = $1', [rows[0].id])).rejects.toThrow(/append-only/)
  })
})
