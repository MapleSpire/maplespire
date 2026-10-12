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
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Request, Response } from 'express'
import type { Pool } from 'pg'
import { ensureAuthSchema } from '../auth/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { requireTagCapability } from './access.js'
import {
  normalizeTagIdentity,
  validateTagGroupInput,
  validateTagGroupPatchInput,
  validateTagInput,
  validateTagMoveInput,
  validateTagPatchInput,
  validateWorkspaceContext,
} from './normalize.js'
import { TagRepository, TagRepositoryError } from './repository.js'
import { registerTagRoutes } from './routes.js'
import { ensureTagSchema } from './schema.js'
import {
  consumeTagRateLimit,
  gcTagOperationalState,
  recordTagOperationEvents,
  tagOperationSummary,
} from './operations.js'

describe('Tag catalog normalization', () => {
  it('normalizes Unicode compatibility forms and whitespace deterministically', () => {
    expect(normalizeTagIdentity('  Ｒisk\t\nHigh  ')).toBe('risk high')
    expect(validateTagGroupInput({ name: '  Déploiement  ' })).toMatchObject({
      name: 'Déploiement',
      normalizedName: 'déploiement',
    })
  })

  it('rejects controls, bidi overrides, oversized labels, and unsafe colors', () => {
    expect(() => validateTagGroupInput({ name: 'Risk\u202EAdmin' })).toThrow(/control/)
    expect(() => validateTagGroupInput({ name: 'x'.repeat(81) })).toThrow(/too long/)
    expect(() => validateTagInput({ groupId: 'g', value: 'High', color: 'red' })).toThrow(/#RRGGBB/)
    expect(() => validateTagInput({ groupId: 'g', value: 'High', color: '#F28C28;background:url(x)' })).toThrow(/#RRGGBB/)
    expect(() => validateTagInput({ clientId: 'tag_client_unsafe', groupId: 'g', value: 'High', color: '#F28C28' })).toThrow(/client-generated/)
  })

  it('accepts only namespace-scoped stable client IDs for offline replay', () => {
    const clientId = `tag_client_${'a'.repeat(32)}`
    expect(validateTagInput({ clientId, groupId: 'g', value: 'High', color: '#F28C28' }).clientId).toBe(clientId)
    const clientGroupId = `taggrp_client_${'b'.repeat(32)}`
    expect(validateTagGroupInput({ clientId: clientGroupId, name: 'Offline group' }).clientId).toBe(clientGroupId)
  })

  it('canonicalizes colors while preserving a Unicode display value', () => {
    expect(validateTagInput({ groupId: 'taggrp_1', value: 'Élevé', color: '#a1b2c3' })).toEqual({
      groupId: 'taggrp_1',
      value: 'Élevé',
      normalizedValue: 'élevé',
      color: '#A1B2C3',
    })
  })

  it('requires both workspace identifiers when a context is supplied', () => {
    expect(validateWorkspaceContext(undefined)).toBeNull()
    expect(validateWorkspaceContext({ landscapeId: 'landscape', versionId: 'current' })).toEqual({
      landscapeId: 'landscape',
      versionId: 'current',
    })
    expect(() => validateWorkspaceContext({ landscapeId: 'landscape' })).toThrow(/versionId/)
  })

  it('validates partial catalog patches and one-sided reorder anchors', () => {
    expect(validateTagGroupPatchInput({ description: null })).toEqual({ description: null })
    expect(validateTagPatchInput({ value: '  Medium ', color: '#abcdef' })).toEqual({
      value: 'Medium',
      normalizedValue: 'medium',
      color: '#ABCDEF',
    })
    expect(validateTagMoveInput({ beforeId: 'tag_2' })).toEqual({ beforeId: 'tag_2', afterId: null })
    expect(() => validateTagMoveInput({})).toThrow(/exactly one/)
    expect(() => validateTagMoveInput({ beforeId: 'a', afterId: 'b' })).toThrow(/exactly one/)
  })
})
describe('Tag catalog development access', () => {
  const previousAuth = process.env.AUTH
  afterAll(() => {
    if (previousAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = previousAuth
  })

  it('keeps the explicit auth-off local development contract', async () => {
    process.env.AUTH = 'off'
    const response = {} as Response
    const actor = await requireTagCapability({} as Pool, {} as Request, response, 'tag.manage_policy', 'org_local')
    expect(actor).toMatchObject({
      userId: 'system:local-development',
      orgId: 'org_local',
      orgRole: 'admin',
      capability: 'tag.manage_policy',
    })
  })
})

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('Tag catalog PostgreSQL invariants', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  let repository: TagRepository
  const orgId = 'org_tag_test'
  const otherOrgId = 'org_tag_other'
  const actorId = 'user_tag_admin'

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connectionString!, 'tag_catalog')
    pool = db.pool
    await ensureAuthSchema(pool)
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Tag Test', 'tag-test'), ($2, 'Other', 'tag-other')`, [orgId, otherOrgId])
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name)
       VALUES ($1, 'test', $1, 'tag-admin@example.test', 'Tag Admin')`,
      [actorId],
    )
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, actorId])
    await ensureTagSchema(pool)
    await ensureTagSchema(pool)
    // Minimal sparse postings owned by this isolated suite. The full read-model
    // schema needs public.pg_trgm, while the isolation helper intentionally has
    // no public search-path fallback.
    await pool.query(`CREATE TABLE ro_object_tags (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, org_id TEXT,
      object_id TEXT NOT NULL, tag_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (landscape_id, version_id, object_id, tag_id)
    )`)
    await pool.query(`CREATE TABLE ro_group_tags (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, org_id TEXT,
      group_id TEXT NOT NULL, tag_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (landscape_id, version_id, group_id, tag_id)
    )`)
    await pool.query(`CREATE TABLE landscapes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, org_id TEXT
    )`)
    await pool.query(`CREATE TABLE versions (
      id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL
    )`)
    await pool.query(`CREATE TABLE ro_objects (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, org_id TEXT,
      id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )`)
    await pool.query(`CREATE TABLE ro_groups (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL, org_id TEXT,
      id TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )`)
    repository = new TagRepository(pool)
  }, 30_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('persists default settings lazily and audits policy changes in the same transaction', async () => {
    expect(await repository.getSettings(orgId)).toMatchObject({
      allowMemberTagCreation: true,
      allowEditorTagGroupCreation: false,
      version: 0,
    })
    const changed = await repository.updateSettings(orgId, {
      allowMemberTagCreation: false,
      allowEditorTagGroupCreation: true,
    }, 0, { actorUserId: actorId, requestId: 'request-settings-1' })
    expect(changed).toMatchObject({
      allowMemberTagCreation: false,
      allowEditorTagGroupCreation: true,
      version: 1,
    })
    const audit = await pool.query<{ detail: { requestId: string } }>(
      `SELECT detail FROM audit_log WHERE action = 'tag.settings.update' AND target_id = $1`, [orgId],
    )
    expect(audit.rows[0].detail.requestId).toBe('request-settings-1')
    await expect(repository.updateSettings(orgId, {
      allowMemberTagCreation: true,
      allowEditorTagGroupCreation: false,
    }, 0, { actorUserId: actorId, requestId: 'stale' })).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('keeps audit actors and cross-workspace assignment names admin-only', async () => {
    const memberId = 'user_tag_member'
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name)
       VALUES ($1, 'test', $1, 'tag-member@example.test', 'Tag Member')`,
      [memberId],
    )
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId])
    const previousAuth = process.env.AUTH
    process.env.AUTH = 'on'
    let statusCode = 200
    let responseBody: unknown = null
    const response = {
      status(code: number) { statusCode = code; return this },
      json(body: unknown) { responseBody = body; return this },
    } as unknown as Response
    const request = { auth: { userId: memberId, orgId } } as unknown as Request
    try {
      expect(await requireTagCapability(pool, request, response, 'tag.view', orgId)).toMatchObject({ orgRole: 'member' })
      expect(await requireTagCapability(pool, request, response, 'tag.audit_view', orgId)).toBeNull()
      expect(statusCode).toBe(403)
      expect(responseBody).toEqual({ error: 'organization_admin_required' })
    } finally {
      if (previousAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = previousAuth
    }
  })

  it('replays a concurrent idempotent mutation once and rejects key reuse for another request', async () => {
    const input = validateTagGroupInput({ name: 'Idempotent group', description: 'Created exactly once' })
    const firstContext = {
      actorUserId: actorId,
      requestId: 'idempotency-first',
      idempotency: {
        key: 'tag-group-create-1',
        operation: 'tag_group.create',
        requestHash: 'a'.repeat(64),
      },
    }
    const replayContext = { ...firstContext, requestId: 'idempotency-replay' }
    const [first, replay] = await Promise.all([
      repository.createGroup(orgId, input, firstContext),
      repository.createGroup(orgId, input, replayContext),
    ])
    expect(replay).toEqual(first)
    const groups = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tag_groups WHERE org_id = $1 AND normalized_name = 'idempotent group'`,
      [orgId],
    )
    expect(Number(groups.rows[0].count)).toBe(1)
    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
       WHERE org_id = $1 AND action = 'tag_group.create' AND target_id = $2`,
      [orgId, first.id],
    )
    expect(Number(audits.rows[0].count)).toBe(1)
    await expect(repository.createGroup(orgId, validateTagGroupInput({ name: 'Different request' }), {
      ...replayContext,
      idempotency: { ...replayContext.idempotency, requestHash: 'b'.repeat(64) },
    })).rejects.toMatchObject({ code: 'idempotency_key_conflict' })
  })

  it('enforces distributed actor and organization rate buckets and garbage-collects expired state', async () => {
    const limits = { actorLimit: 2, orgLimit: 10, windowSeconds: 60 }
    expect((await consumeTagRateLimit(pool, {
      orgId, actorUserId: actorId, bucket: 'mutation', limits,
    })).allowed).toBe(true)
    expect((await consumeTagRateLimit(pool, {
      orgId, actorUserId: actorId, bucket: 'mutation', limits,
    })).allowed).toBe(true)
    const limited = await consumeTagRateLimit(pool, {
      orgId, actorUserId: actorId, bucket: 'mutation', limits,
    })
    expect(limited.allowed).toBe(false)
    expect(limited.retryAfterSeconds).toBeGreaterThan(0)
    await consumeTagRateLimit(pool, {
      orgId, actorUserId: actorId, bucket: 'mutation', limits,
    })
    const rateAudits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
       WHERE org_id = $1 AND actor_user_id = $2 AND action = 'tag.rate_limited'`,
      [orgId, actorId],
    )
    expect(Number(rateAudits.rows[0].count)).toBe(1)

    await pool.query(
      `INSERT INTO tag_idempotency_keys (
         org_id, actor_user_id, idempotency_key, operation, request_hash, expires_at
       ) VALUES ($1, $2, 'expired-key', 'test', $3, now() - interval '1 minute')`,
      [orgId, actorId, 'c'.repeat(64)],
    )
    await pool.query(
      `INSERT INTO tag_rate_limit_buckets (
         org_id, scope_kind, scope_id, bucket, window_start, request_count
       ) VALUES ($1, 'actor', 'old-actor', 'read', now() - interval '3 days', 1)`,
      [orgId],
    )
    const deleted = await gcTagOperationalState(pool)
    expect(deleted.idempotencyKeysDeleted).toBeGreaterThanOrEqual(1)
    expect(deleted.rateBucketsDeleted).toBeGreaterThanOrEqual(1)
  })

  it('deduplicates privacy-minimized outbox telemetry and isolates organization summaries', async () => {
    const now = new Date().toISOString()
    const events = [
      {
        id: `tagop_client_${'e'.repeat(32)}`,
        eventType: 'queued' as const,
        itemKind: 'tag' as const,
        reasonCode: null,
        ageMs: 0,
        attemptCount: 0,
        occurredAt: now,
      },
      {
        id: `tagop_client_${'f'.repeat(32)}`,
        eventType: 'attention' as const,
        itemKind: 'tag' as const,
        reasonCode: 'duplicate_tag',
        ageMs: 1_234,
        attemptCount: 1,
        occurredAt: now,
      },
    ]
    expect(await recordTagOperationEvents(pool, { orgId, actorUserId: actorId, events }))
      .toEqual({ received: 2, inserted: 2 })
    expect(await recordTagOperationEvents(pool, { orgId, actorUserId: actorId, events }))
      .toEqual({ received: 2, inserted: 0 })

    await recordTagOperationEvents(pool, {
      orgId: otherOrgId,
      actorUserId: actorId,
      events: [{
        ...events[0],
        id: `tagop_client_${'a'.repeat(32)}`,
        eventType: 'discarded',
      }],
    })
    const summary = await tagOperationSummary(pool, orgId, '24h')
    expect(summary).toMatchObject({
      window: '24h',
      counts: {
        queued: 1,
        replay_succeeded: 0,
        attention: 1,
        discarded: 0,
        reconciled: 0,
      },
      topAttentionReasons: [{ code: 'duplicate_tag', count: 1 }],
      lastEventAt: expect.any(String),
    })

    await pool.query(
      `INSERT INTO tag_operation_events (
         id, org_id, actor_user_id, event_type, item_kind, reason_code,
         age_ms, attempt_count, occurred_at
       ) VALUES ($1, $2, $3, 'discarded', 'group', 'abandoned', 10, 1, now() - interval '40 days')`,
      [`tagop_client_${'b'.repeat(32)}`, orgId, actorId],
    )
    expect((await gcTagOperationalState(pool)).telemetryEventsDeleted).toBeGreaterThanOrEqual(1)

    const stored = await pool.query<{ columns: string[] }>(
      `SELECT array_agg(column_name ORDER BY ordinal_position)::text[] AS columns
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'tag_operation_events'`,
    )
    expect(stored.rows[0].columns).not.toEqual(expect.arrayContaining([
      'tag_value', 'group_name', 'local_tag_id', 'document_id', 'automerge_payload',
    ]))
  })

  it('enforces active normalized uniqueness but permits the same value in different Groups', async () => {
    const context = { actorUserId: actorId, requestId: 'request-catalog' }
    const risk = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Risk' }), context)
    const security = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Security' }), context)
    await expect(repository.createGroup(orgId, validateTagGroupInput({ name: '  RISK ' }), context))
      .rejects.toMatchObject({ code: 'duplicate_tag_group' })

    const riskHigh = await repository.createTag(orgId, validateTagInput({
      groupId: risk.id, value: 'High', color: '#F05252',
    }), context)
    const securityHigh = await repository.createTag(orgId, validateTagInput({
      groupId: security.id, value: 'High', color: '#F59E0B',
    }), context)
    expect(riskHigh.groupId).not.toBe(securityHigh.groupId)
    await expect(repository.createTag(orgId, validateTagInput({
      groupId: risk.id, value: ' HIGH ', color: '#000000',
    }), context)).rejects.toMatchObject({ code: 'duplicate_tag' })
  })

  it('uses bounded keyset pages and structurally refuses cross-tenant Group IDs', async () => {
    const first = await repository.listGroups({ orgId, limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await repository.listGroups({ orgId, limit: 1, after: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.items[0].id).not.toBe(first.items[0].id)

    const foreign = await repository.createGroup(otherOrgId, validateTagGroupInput({ name: 'Foreign' }), {
      actorUserId: actorId,
      requestId: 'foreign-group',
    })
    await expect(repository.createTag(orgId, validateTagInput({
      groupId: foreign.id, value: 'Leak', color: '#000000',
    }), { actorUserId: actorId, requestId: 'cross-tenant' })).rejects.toBeInstanceOf(TagRepositoryError)
  })

  it('uses optimistic lifecycle mutations and refuses to archive a non-empty Group', async () => {
    const context = { actorUserId: actorId, requestId: 'lifecycle' }
    const group = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Lifecycle' }), context)
    const tag = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'Candidate', color: '#2563EB',
    }), context)
    const renamed = await repository.updateGroup(
      orgId,
      group.id,
      validateTagGroupPatchInput({ name: 'Release lifecycle' }),
      group.version,
      context,
    )
    expect(renamed).toMatchObject({ name: 'Release lifecycle', version: 2 })
    await expect(repository.updateGroup(
      orgId,
      group.id,
      validateTagGroupPatchInput({ name: 'Stale' }),
      group.version,
      context,
    )).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(repository.setGroupLifecycle(orgId, group.id, 'archived', renamed.version, context))
      .rejects.toMatchObject({ code: 'tag_group_not_empty', details: { activeTagCount: 1 } })

    const archivedTag = await repository.setTagLifecycle(orgId, tag.id, 'archived', tag.version, context)
    const archivedGroup = await repository.setGroupLifecycle(orgId, group.id, 'archived', renamed.version, context)
    expect(archivedGroup.lifecycleStatus).toBe('archived')
    await expect(repository.setTagLifecycle(orgId, tag.id, 'active', archivedTag.version, context))
      .rejects.toMatchObject({ code: 'tag_group_archived' })
    const restoredGroup = await repository.setGroupLifecycle(orgId, group.id, 'active', archivedGroup.version, context)
    const restoredTag = await repository.setTagLifecycle(orgId, tag.id, 'active', archivedTag.version, context)
    expect(restoredGroup.lifecycleStatus).toBe('active')
    expect(restoredTag.lifecycleStatus).toBe('active')
  })

  it('moves entries by relative anchors without loading the full catalog', async () => {
    const context = { actorUserId: actorId, requestId: 'reorder' }
    const first = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Order A' }), context)
    const second = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Order B' }), context)
    const third = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Order C' }), context)
    await pool.query(
      `UPDATE tag_groups SET sort_key = CASE id
         WHEN $2 THEN '000000000000000001'
         WHEN $3 THEN '000000000000000002'
         ELSE sort_key END
       WHERE org_id = $1 AND id = ANY($4::text[])`,
      [orgId, first.id, second.id, [first.id, second.id]],
    )
    await repository.moveGroup(orgId, third.id, { beforeId: second.id, afterId: null }, third.version, context)
    const groups = await repository.listGroups({ orgId, status: 'active', limit: 100 })
    const ordered = groups.items.map((item) => item.id)
    expect(ordered.indexOf(first.id)).toBeLessThan(ordered.indexOf(third.id))
    expect(ordered.indexOf(third.id)).toBeLessThan(ordered.indexOf(second.id))

    const a = await repository.createTag(orgId, validateTagInput({ groupId: first.id, value: 'Order 1', color: '#111111' }), context)
    const b = await repository.createTag(orgId, validateTagInput({ groupId: first.id, value: 'Order 2', color: '#222222' }), context)
    const c = await repository.createTag(orgId, validateTagInput({ groupId: first.id, value: 'Order 3', color: '#333333' }), context)
    await repository.moveTag(orgId, c.id, { beforeId: b.id, afterId: null }, c.version, context)
    const tags = await repository.listTags({ orgId, groupIds: [first.id], status: 'active', limit: 100 })
    expect(tags.items.map((item) => item.id)).toEqual([a.id, c.id, b.id])
  })

  it('applies versioned bulk mutations atomically and reports sparse assignment impact', async () => {
    const context = { actorUserId: actorId, requestId: 'batch-mutation' }
    const group = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Bulk operations' }), context)
    const first = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'Bulk first', color: '#111111',
    }), context)
    const second = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'Bulk second', color: '#222222',
    }), context)
    await pool.query(
      `INSERT INTO landscapes (id, name, org_id) VALUES ('bulk-landscape', 'Bulk landscape', $1)`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO versions (id, landscape_id, label) VALUES ('current', 'bulk-landscape', 'Main')`,
    )
    await pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, org_id, id, type, name)
       VALUES ('bulk-landscape', 'current', $1, 'object-1', 'app', 'Checkout API'),
              ('bulk-landscape', 'current', $1, 'object-2', 'store', 'Orders DB')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO ro_groups (landscape_id, version_id, org_id, id, name)
       VALUES ('bulk-landscape', 'current', $1, 'group-1', 'Checkout boundary')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO ro_object_tags (landscape_id, version_id, org_id, object_id, tag_id, ordinal)
       VALUES ('bulk-landscape', 'current', $1, 'object-1', $2, 0),
              ('bulk-landscape', 'current', $1, 'object-2', $2, 0)`,
      [orgId, first.id],
    )
    await pool.query(
      `INSERT INTO ro_group_tags (landscape_id, version_id, org_id, group_id, tag_id, ordinal)
       VALUES ('bulk-landscape', 'current', $1, 'group-1', $2, 0)`,
      [orgId, first.id],
    )

    expect(await repository.tagUsageSummary(orgId, [first.id, second.id])).toEqual([
      { tagId: first.id, objectAssignments: 2, groupAssignments: 1, totalAssignments: 3 },
      { tagId: second.id, objectAssignments: 0, groupAssignments: 0, totalAssignments: 0 },
    ])

    const recolored = await repository.batchMutateTags(orgId, {
      action: 'recolor',
      color: '#ABCDEF',
      items: [
        { id: first.id, expectedVersion: first.version },
        { id: second.id, expectedVersion: second.version },
      ],
    }, context)
    expect(recolored.map((tag) => tag.color)).toEqual(['#ABCDEF', '#ABCDEF'])

    await expect(repository.batchMutateTags(orgId, {
      action: 'archive',
      items: [
        { id: first.id, expectedVersion: recolored[0].version },
        { id: second.id, expectedVersion: second.version },
      ],
    }, { ...context, requestId: 'batch-stale' })).rejects.toMatchObject({ code: 'version_conflict' })
    const afterRollback = await repository.resolveTags(orgId, [first.id, second.id])
    expect(afterRollback.resolved.map((entry) => entry.tag.lifecycleStatus)).toEqual(['active', 'active'])

    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
       WHERE org_id = $1 AND action = 'tag.batch.recolor' AND target_id = ANY($2::text[])`,
      [orgId, [first.id, second.id]],
    )
    expect(Number(audits.rows[0].count)).toBe(2)

    const firstAssignmentPage = await repository.listTagAssignments({
      orgId, tagId: first.id, kind: 'object', limit: 1,
    })
    expect(firstAssignmentPage.items).toEqual([expect.objectContaining({
      kind: 'object', entityName: 'Checkout API', entityType: 'app',
      landscapeName: 'Bulk landscape', versionName: 'Main',
    })])
    expect(firstAssignmentPage.nextCursor).toBeTruthy()
    expect((await repository.listTagAssignments({
      orgId, tagId: first.id, kind: 'object', after: firstAssignmentPage.nextCursor!, limit: 1,
    })).items).toEqual([expect.objectContaining({ entityName: 'Orders DB', entityType: 'store' })])

    const auditPage = await repository.listTagAudit({
      orgId, tagId: first.id, action: 'tag.batch.', limit: 10,
    })
    expect(auditPage.items).toEqual([expect.objectContaining({
      action: 'tag.batch.recolor', actorEmail: 'tag-admin@example.test', targetId: first.id,
    })])
    await expect(repository.listTagAudit({
      orgId, tagId: first.id, after: '99999999999999999999',
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('merges identities append-only and resolves redirect chains without cross-tenant disclosure', async () => {
    const context = { actorUserId: actorId, requestId: 'merge' }
    const group = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Merge' }), context)
    const source = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'US East', color: '#22C55E',
    }), context)
    const middle = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'US-East', color: '#16A34A',
    }), context)
    const canonical = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'us-east-1', color: '#15803D',
    }), context)

    const firstMerge = await repository.mergeTags(
      orgId, source.id, middle.id, source.version, middle.version, context,
    )
    expect(firstMerge.source).toMatchObject({ lifecycleStatus: 'merged', canonicalTagId: middle.id })
    const secondMerge = await repository.mergeTags(
      orgId, middle.id, canonical.id, middle.version, canonical.version, context,
    )
    expect(secondMerge.source.canonicalTagId).toBe(canonical.id)

    const resolved = await repository.resolveTags(orgId, [source.id, middle.id, canonical.id, 'unknown', source.id])
    expect(resolved.resolved).toHaveLength(3)
    expect(resolved.resolved.every((item) => item.canonicalTagId === canonical.id)).toBe(true)
    expect(resolved.unresolvedIds).toEqual(['unknown'])
    expect((await repository.listTagAudit({ orgId, tagId: canonical.id, action: 'tag.merge' })).items)
      .toHaveLength(2)
    await pool.query(
      `INSERT INTO landscapes (id, name, org_id) VALUES ('merge-landscape', 'Merge landscape', $1)`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO versions (id, landscape_id, label) VALUES ('merge-current', 'merge-landscape', 'Main')`,
    )
    await pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, org_id, id, type, name)
       VALUES ('merge-landscape', 'merge-current', $1, 'merge-object', 'app', 'Legacy tagged object')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO ro_object_tags (landscape_id, version_id, org_id, object_id, tag_id, ordinal)
       VALUES ('merge-landscape', 'merge-current', $1, 'merge-object', $2, 0)`,
      [orgId, source.id],
    )
    expect((await repository.listTagAssignments({ orgId, tagId: canonical.id })).items)
      .toEqual([expect.objectContaining({ entityName: 'Legacy tagged object' })])
    await expect(repository.updateTag(
      orgId,
      source.id,
      validateTagPatchInput({ color: '#FFFFFF' }),
      firstMerge.source.version,
      context,
    )).rejects.toMatchObject({ code: 'tag_is_merged' })
    await expect(pool.query(`UPDATE tag_redirects SET target_tag_id = $1 WHERE source_tag_id = $2`, [canonical.id, source.id]))
      .rejects.toThrow(/append-only/)

    const foreignGroup = await repository.createGroup(otherOrgId, validateTagGroupInput({ name: 'Foreign resolve' }), context)
    const foreignTag = await repository.createTag(otherOrgId, validateTagInput({
      groupId: foreignGroup.id, value: 'Secret', color: '#000000',
    }), context)
    expect((await repository.resolveTags(orgId, [foreignTag.id])).unresolvedIds).toEqual([foreignTag.id])
    await expect(repository.listTagAudit({ orgId, tagId: foreignTag.id })).rejects.toMatchObject({ code: 'tag_not_found' })
    await expect(repository.listTagAssignments({ orgId, tagId: foreignTag.id })).rejects.toMatchObject({ code: 'tag_not_found' })
  })

  it('reconciles offline identities to canonical Tags and audits local Tag Group mappings', async () => {
    const context = { actorUserId: actorId, requestId: 'outbox-reconcile' }
    const group = await repository.createGroup(orgId, validateTagGroupInput({ name: 'Offline reconciliation' }), context)
    const canonical = await repository.createTag(orgId, validateTagInput({
      groupId: group.id, value: 'Canonical value', color: '#2563EB',
    }), context)
    const localTagId = `tag_client_${'c'.repeat(32)}`
    const localTag = validateTagInput({
      clientId: localTagId, groupId: group.id, value: 'Local duplicate', color: '#60A5FA',
    })

    const reconciled = await repository.reconcileLocalTag(orgId, localTag, canonical.id, context)
    expect(reconciled.source).toMatchObject({
      id: localTagId,
      lifecycleStatus: 'merged',
      canonicalTagId: canonical.id,
    })
    expect(reconciled.canonical.id).toBe(canonical.id)
    expect(await repository.reconcileLocalTag(orgId, localTag, canonical.id, context)).toEqual(reconciled)
    expect(await repository.resolveTags(orgId, [localTagId])).toMatchObject({
      resolved: [expect.objectContaining({ requestedId: localTagId, canonicalTagId: canonical.id })],
      unresolvedIds: [],
    })
    expect((await repository.listTagAudit({ orgId, tagId: canonical.id, action: 'tag.outbox.reconcile' })).items)
      .toEqual([expect.objectContaining({ action: 'tag.outbox.reconcile', actorUserId: actorId })])

    const localGroupId = `taggrp_client_${'d'.repeat(32)}`
    const mappedGroup = await repository.reconcileLocalGroup(orgId, validateTagGroupInput({
      clientId: localGroupId,
      name: 'Local group duplicate',
      description: 'Created while offline',
    }), group.id, context)
    expect(mappedGroup.id).toBe(group.id)
    const groupAudit = await pool.query<{ detail: { local: { id: string }; target: { id: string } } }>(
      `SELECT detail FROM audit_log WHERE action = 'tag_group.outbox.reconcile' AND target_id = $1`,
      [group.id],
    )
    expect(groupAudit.rows.at(-1)?.detail).toMatchObject({
      local: { id: localGroupId },
      target: { id: group.id },
    })
  })

  it('exposes the mutation and resolution contract through the HTTP routes', async () => {
    const previousAuth = process.env.AUTH
    process.env.AUTH = 'off'
    const app = express()
    app.use(express.json())
    registerTagRoutes(app, pool)
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener))
    })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orgs/${orgId}`
    try {
      const createGroupResponse = await fetch(`${base}/tag-groups`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'http-create-group',
          'idempotency-key': 'http-group-create-1',
        },
        body: JSON.stringify({ name: 'HTTP group', description: 'Stable request' }),
      })
      expect(createGroupResponse.status).toBe(201)
      const createdGroup = await createGroupResponse.json() as { group: { id: string; version: number } }
      const replayGroupResponse = await fetch(`${base}/tag-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'http-group-create-1' },
        body: JSON.stringify({ description: 'Stable request', name: 'HTTP group' }),
      })
      expect(replayGroupResponse.status).toBe(201)
      expect(await replayGroupResponse.json()).toEqual(createdGroup)
      const conflictingReplay = await fetch(`${base}/tag-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'http-group-create-1' },
        body: JSON.stringify({ name: 'Different HTTP group' }),
      })
      expect(conflictingReplay.status).toBe(409)
      expect(await conflictingReplay.json()).toMatchObject({ error: 'idempotency_key_conflict' })

      const createTagResponse = await fetch(`${base}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: createdGroup.group.id, value: 'HTTP tag', color: '#336699' }),
      })
      expect(createTagResponse.status).toBe(201)
      const createdTag = await createTagResponse.json() as { tag: { id: string; version: number } }

      const patchResponse = await fetch(`${base}/tags/${createdTag.tag.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ color: '#123456', expectedVersion: createdTag.tag.version }),
      })
      expect(patchResponse.status).toBe(200)
      const patched = await patchResponse.json() as { tag: { color: string; version: number } }
      expect(patched.tag).toMatchObject({ color: '#123456', version: 2 })

      const batchResponse = await fetch(`${base}/tags/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'http-tag-batch-1' },
        body: JSON.stringify({
          action: 'recolor',
          color: '#654321',
          items: [{ id: createdTag.tag.id, expectedVersion: patched.tag.version }],
        }),
      })
      expect(batchResponse.status).toBe(200)
      expect(await batchResponse.json()).toMatchObject({ tags: [{ id: createdTag.tag.id, color: '#654321', version: 3 }] })

      const usageResponse = await fetch(`${base}/tags/usage-summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tagIds: [createdTag.tag.id] }),
      })
      expect(usageResponse.status).toBe(200)
      expect(await usageResponse.json()).toMatchObject({
        usage: [{ tagId: createdTag.tag.id, totalAssignments: expect.any(Number) }],
      })

      const auditResponse = await fetch(`${base}/tags/${createdTag.tag.id}/audit?action=tag.batch.`)
      expect(auditResponse.status).toBe(200)
      expect(await auditResponse.json()).toMatchObject({
        items: [expect.objectContaining({ action: 'tag.batch.recolor', targetId: createdTag.tag.id })],
      })

      const assignmentsResponse = await fetch(`${base}/tags/${createdTag.tag.id}/assignments?kind=object`)
      expect(assignmentsResponse.status).toBe(200)
      expect(await assignmentsResponse.json()).toMatchObject({ items: [], nextCursor: null })

      const resolveResponse = await fetch(`${base}/tags/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tagIds: [createdTag.tag.id, 'missing'] }),
      })
      expect(resolveResponse.status).toBe(200)
      expect(await resolveResponse.json()).toMatchObject({
        resolved: [expect.objectContaining({ requestedId: createdTag.tag.id, canonicalTagId: createdTag.tag.id })],
        unresolvedIds: ['missing'],
      })

      const operationResponse = await fetch(`${base}/tag-operations/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{
          id: `tagop_client_${'c'.repeat(32)}`,
          eventType: 'replay_succeeded',
          itemKind: 'group',
          reasonCode: null,
          ageMs: 2_500,
          attemptCount: 2,
          occurredAt: new Date().toISOString(),
        }] }),
      })
      expect(operationResponse.status).toBe(202)
      expect(await operationResponse.json()).toEqual({ received: 1, inserted: 1 })

      const operationSummaryResponse = await fetch(`${base}/tag-operations/summary?window=24h`)
      expect(operationSummaryResponse.status).toBe(200)
      expect(await operationSummaryResponse.json()).toMatchObject({
        summary: {
          window: '24h',
          counts: { replay_succeeded: 1 },
          p50ResolutionMs: 2_500,
          p95ResolutionMs: 2_500,
        },
      })

      const invalidOperationResponse = await fetch(`${base}/tag-operations/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{
          id: 'unsafe', eventType: 'queued', itemKind: 'tag', ageMs: 0, attemptCount: 0,
          occurredAt: new Date().toISOString(),
        }] }),
      })
      expect(invalidOperationResponse.status).toBe(400)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (previousAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = previousAuth
    }
  })
})
