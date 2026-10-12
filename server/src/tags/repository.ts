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

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { normalizeTagIdentity } from './normalize.js'
import type {
  KeysetPage,
  ResolveTagsResult,
  TagAssignmentKind,
  TagAssignmentView,
  TagAuditEntry,
  TagBatchInput,
  TagGroupInput,
  TagGroupLifecycle,
  TagGroupPatchInput,
  TagGroupView,
  TagInput,
  TagLifecycle,
  TagMoveInput,
  TagPatchInput,
  TagSettings,
  TagUsageCount,
  TagView,
} from './types.js'

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}
interface MutationContext {
  actorUserId: string
  requestId: string
  idempotency?: {
    key: string
    operation: string
    requestHash: string
  }
}

interface PageCursor { keys: string[]; id: string }

interface GroupRow {
  id: string; org_id: string; name: string; description: string | null; icon_key: string | null
  lifecycle_status: TagGroupLifecycle; version: number; created_at: Date | string; updated_at: Date | string
  normalized_name: string; sort_key: string
  tag_count?: number | string
}

interface TagRow {
  id: string; org_id: string; group_id: string; group_name: string; value: string; color: string
  lifecycle_status: TagLifecycle; canonical_tag_id: string | null; version: number
  created_at: Date | string; updated_at: Date | string; normalized_value: string
  sort_key: string; group_sort_key: string
}

const MAX_GROUPS_PER_ORG = 500
const MAX_ACTIVE_TAGS_PER_ORG = 50_000

export class TagRepositoryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

function newId(prefix: 'taggrp' | 'tag'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function groupView(row: GroupRow): TagGroupView {
  const view: TagGroupView = {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    iconKey: row.icon_key,
    lifecycleStatus: row.lifecycle_status,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
  if (row.tag_count !== undefined) view.tagCount = Number(row.tag_count)
  return view
}

function tagView(row: TagRow): TagView {
  return {
    id: row.id,
    orgId: row.org_id,
    groupId: row.group_id,
    groupName: row.group_name,
    value: row.value,
    color: row.color,
    lifecycleStatus: row.lifecycle_status,
    canonicalTagId: row.canonical_tag_id,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeTagCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PageCursor>
    if (!Array.isArray(parsed.keys) || !parsed.keys.every((key) => typeof key === 'string') || parsed.keys.length < 1
      || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid')
    return { keys: parsed.keys, id: parsed.id }
  } catch {
    throw new TagRepositoryError(400, 'invalid_cursor', 'after must be a valid keyset cursor')
  }
}

async function appendAudit(
  db: Queryable,
  ctx: MutationContext,
  orgId: string,
  action: string,
  targetKind: string,
  targetId: string,
  detail: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_user_id, action, target_kind, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, ctx.actorUserId, action, targetKind, targetId, JSON.stringify({ requestId: ctx.requestId, ...detail as object })],
  )
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function beginIdempotency<T>(
  client: PoolClient,
  orgId: string,
  ctx: MutationContext,
): Promise<{ replayed: false } | { replayed: true; response: T }> {
  const idempotency = ctx.idempotency
  if (!idempotency) return { replayed: false }
  await client.query(
    `DELETE FROM tag_idempotency_keys
     WHERE org_id = $1 AND actor_user_id = $2 AND idempotency_key = $3 AND expires_at <= now()`,
    [orgId, ctx.actorUserId, idempotency.key],
  )
  const inserted = await client.query(
    `INSERT INTO tag_idempotency_keys (
       org_id, actor_user_id, idempotency_key, operation, request_hash
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, actor_user_id, idempotency_key) DO NOTHING
     RETURNING 1`,
    [orgId, ctx.actorUserId, idempotency.key, idempotency.operation, idempotency.requestHash],
  )
  if (inserted.rowCount === 1) return { replayed: false }
  const { rows } = await client.query<{
    operation: string
    request_hash: string
    state: 'pending' | 'completed'
    response_body: T | null
  }>(
    `SELECT operation, request_hash, state, response_body
     FROM tag_idempotency_keys
     WHERE org_id = $1 AND actor_user_id = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [orgId, ctx.actorUserId, idempotency.key],
  )
  const stored = rows[0]
  if (!stored) throw new TagRepositoryError(409, 'idempotency_retry', 'Retry the idempotent request')
  if (stored.operation !== idempotency.operation || stored.request_hash !== idempotency.requestHash) {
    throw new TagRepositoryError(
      409,
      'idempotency_key_conflict',
      'This Idempotency-Key was already used for a different request',
    )
  }
  if (stored.state !== 'completed' || stored.response_body === null) {
    throw new TagRepositoryError(409, 'idempotency_in_progress', 'The idempotent request is still in progress', {
      retryAfterSeconds: 1,
    })
  }
  return { replayed: true, response: stored.response_body }
}

async function completeIdempotency(
  client: PoolClient,
  orgId: string,
  ctx: MutationContext,
  response: unknown,
): Promise<void> {
  const idempotency = ctx.idempotency
  if (!idempotency) return
  await client.query(
    `UPDATE tag_idempotency_keys SET state = 'completed', response_body = $4,
       completed_at = now()
     WHERE org_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
    [orgId, ctx.actorUserId, idempotency.key, JSON.stringify(response)],
  )
}

async function idempotentTransaction<T>(
  pool: Pool,
  orgId: string,
  ctx: MutationContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(pool, async (client) => {
    const claim = await beginIdempotency<T>(client, orgId, ctx)
    if (claim.replayed) return claim.response
    const response = await work(client)
    await completeIdempotency(client, orgId, ctx, response)
    return response
  })
}

function translateDbError(error: unknown, duplicateCode: string): never {
  const dbError = error as { code?: string; constraint?: string }
  if (dbError.code === '23505') {
    throw new TagRepositoryError(409, duplicateCode, 'An active catalog entry with the same normalized value already exists')
  }
  if (dbError.code === '23503') throw new TagRepositoryError(404, 'tag_group_not_found', 'The active Tag Group was not found')
  throw error
}

function assertVersion(current: { version: number }, expectedVersion: number, label: string): void {
  if (current.version !== expectedVersion) {
    throw new TagRepositoryError(409, 'version_conflict', `${label} changed since it was loaded`, { current })
  }
}

function paddedRank(value: bigint): string {
  const rank = value.toString()
  if (rank.length > 18) throw new TagRepositoryError(409, 'rank_space_exhausted', 'Catalog order requires maintenance')
  return rank.padStart(18, '0')
}

export class TagRepository {
  constructor(private readonly pool: Pool) {}

  private async lockedGroup(client: PoolClient, orgId: string, groupId: string): Promise<GroupRow> {
    const { rows } = await client.query<GroupRow>(
      `SELECT id, org_id, name, normalized_name, description, icon_key, sort_key, lifecycle_status,
              version, created_at, updated_at
       FROM tag_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, groupId],
    )
    if (!rows[0]) throw new TagRepositoryError(404, 'tag_group_not_found', 'Tag Group not found')
    return rows[0]
  }

  private async lockedTag(client: PoolClient, orgId: string, tagId: string): Promise<TagRow> {
    const { rows } = await client.query<TagRow>(
      `SELECT t.id, t.org_id, t.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
              t.value, t.normalized_value, t.color, t.sort_key, t.lifecycle_status,
              t.canonical_tag_id, t.version, t.created_at, t.updated_at
       FROM tags t JOIN tag_groups g ON g.org_id = t.org_id AND g.id = t.group_id
       WHERE t.org_id = $1 AND t.id = $2 FOR UPDATE OF t`,
      [orgId, tagId],
    )
    if (!rows[0]) throw new TagRepositoryError(404, 'tag_not_found', 'Tag not found')
    return rows[0]
  }

  private async groupMoveRank(
    client: PoolClient,
    orgId: string,
    sourceId: string,
    move: TagMoveInput,
    mayRebalance = true,
  ): Promise<string> {
    const targetId = move.beforeId ?? move.afterId!
    if (targetId === sourceId) throw new TagRepositoryError(400, 'invalid_reorder_target', 'An entry cannot be moved relative to itself')
    const target = await this.lockedGroup(client, orgId, targetId)
    if (target.lifecycle_status !== 'active') throw new TagRepositoryError(409, 'reorder_target_inactive', 'The reorder target must be active')
    const before = move.beforeId !== null
    const { rows } = await client.query<{ sort_key: string }>(
      before
        ? `SELECT sort_key FROM tag_groups
           WHERE org_id = $1 AND lifecycle_status = 'active' AND id <> $2 AND sort_key < $3
           ORDER BY sort_key DESC, id DESC LIMIT 1`
        : `SELECT sort_key FROM tag_groups
           WHERE org_id = $1 AND lifecycle_status = 'active' AND id <> $2 AND sort_key > $3
           ORDER BY sort_key, id LIMIT 1`,
      [orgId, sourceId, target.sort_key],
    )
    const targetRank = BigInt(target.sort_key)
    const lower = before ? BigInt(rows[0]?.sort_key ?? '0') : targetRank
    const upper = before ? targetRank : BigInt(rows[0]?.sort_key ?? (targetRank + 2048n).toString())
    if (upper - lower <= 1n) {
      if (!mayRebalance) throw new TagRepositoryError(409, 'rank_space_exhausted', 'Unable to allocate a catalog rank')
      await client.query(
        `WITH ranked AS (
           SELECT id, row_number() OVER (ORDER BY sort_key, id) * 1024 AS rank
           FROM tag_groups WHERE org_id = $1 AND lifecycle_status = 'active'
         )
         UPDATE tag_groups g SET sort_key = lpad(ranked.rank::text, 18, '0')
         FROM ranked WHERE g.id = ranked.id`,
        [orgId],
      )
      return this.groupMoveRank(client, orgId, sourceId, move, false)
    }
    return paddedRank((lower + upper) / 2n)
  }

  private async tagMoveRank(
    client: PoolClient,
    orgId: string,
    groupId: string,
    sourceId: string,
    move: TagMoveInput,
    mayRebalance = true,
  ): Promise<string> {
    const targetId = move.beforeId ?? move.afterId!
    if (targetId === sourceId) throw new TagRepositoryError(400, 'invalid_reorder_target', 'An entry cannot be moved relative to itself')
    const target = await this.lockedTag(client, orgId, targetId)
    if (target.group_id !== groupId || target.lifecycle_status !== 'active') {
      throw new TagRepositoryError(409, 'reorder_target_invalid', 'The reorder target must be an active Tag in the same Group')
    }
    const before = move.beforeId !== null
    const { rows } = await client.query<{ sort_key: string }>(
      before
        ? `SELECT sort_key FROM tags
           WHERE org_id = $1 AND group_id = $2 AND lifecycle_status = 'active'
             AND id <> $3 AND sort_key < $4
           ORDER BY sort_key DESC, id DESC LIMIT 1`
        : `SELECT sort_key FROM tags
           WHERE org_id = $1 AND group_id = $2 AND lifecycle_status = 'active'
             AND id <> $3 AND sort_key > $4
           ORDER BY sort_key, id LIMIT 1`,
      [orgId, groupId, sourceId, target.sort_key],
    )
    const targetRank = BigInt(target.sort_key)
    const lower = before ? BigInt(rows[0]?.sort_key ?? '0') : targetRank
    const upper = before ? targetRank : BigInt(rows[0]?.sort_key ?? (targetRank + 2048n).toString())
    if (upper - lower <= 1n) {
      if (!mayRebalance) throw new TagRepositoryError(409, 'rank_space_exhausted', 'Unable to allocate a catalog rank')
      await client.query(
        `WITH ranked AS (
           SELECT id, row_number() OVER (ORDER BY sort_key, id) * 1024 AS rank
           FROM tags WHERE org_id = $1 AND group_id = $2 AND lifecycle_status = 'active'
         )
         UPDATE tags t SET sort_key = lpad(ranked.rank::text, 18, '0')
         FROM ranked WHERE t.id = ranked.id`,
        [orgId, groupId],
      )
      return this.tagMoveRank(client, orgId, groupId, sourceId, move, false)
    }
    return paddedRank((lower + upper) / 2n)
  }

  async getSettings(orgId: string, db: Queryable = this.pool): Promise<TagSettings> {
    const { rows } = await db.query<{
      allow_member_tag_creation: boolean
      allow_editor_tag_group_creation: boolean
      version: number
      updated_at: Date | string
      updated_by: string
    }>(
      `SELECT allow_member_tag_creation, allow_editor_tag_group_creation, version, updated_at, updated_by
       FROM org_tag_settings WHERE org_id = $1`,
      [orgId],
    )
    const row = rows[0]
    return row ? {
      allowMemberTagCreation: row.allow_member_tag_creation,
      allowEditorTagGroupCreation: row.allow_editor_tag_group_creation,
      version: Number(row.version),
      updatedAt: iso(row.updated_at),
      updatedBy: row.updated_by,
    } : {
      allowMemberTagCreation: true,
      allowEditorTagGroupCreation: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    }
  }

  async updateSettings(
    orgId: string,
    input: Pick<TagSettings, 'allowMemberTagCreation' | 'allowEditorTagGroupCreation'>,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagSettings> {
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-settings:${orgId}`])
      const before = await this.getSettings(orgId, client)
      if (before.version !== expectedVersion) {
        throw new TagRepositoryError(409, 'version_conflict', 'Tag settings changed since they were loaded', { current: before })
      }
      await client.query(
        `INSERT INTO org_tag_settings (
           org_id, allow_member_tag_creation, allow_editor_tag_group_creation, version, updated_by
         ) VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (org_id) DO UPDATE SET
           allow_member_tag_creation = EXCLUDED.allow_member_tag_creation,
           allow_editor_tag_group_creation = EXCLUDED.allow_editor_tag_group_creation,
           version = org_tag_settings.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [orgId, input.allowMemberTagCreation, input.allowEditorTagGroupCreation, ctx.actorUserId],
      )
      const after = await this.getSettings(orgId, client)
      await appendAudit(client, ctx, orgId, 'tag.settings.update', 'tag_settings', orgId, { before, after })
      return after
    })
  }

  async listGroups(args: {
    orgId: string; q?: string; status?: TagGroupLifecycle; after?: string; limit?: number
  }): Promise<KeysetPage<TagGroupView>> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
    const cursor = decodeTagCursor(args.after)
    const q = args.q ? normalizeTagIdentity(args.q) : ''
    const { rows } = await this.pool.query<GroupRow>(
      `SELECT g.id, g.org_id, g.name, g.normalized_name, g.description, g.icon_key,
              g.sort_key, g.lifecycle_status, g.version, g.created_at, g.updated_at,
              (SELECT count(*) FROM tags t
               WHERE t.org_id = g.org_id AND t.group_id = g.id
                 AND t.lifecycle_status = 'active')::integer AS tag_count
       FROM tag_groups g
       WHERE g.org_id = $1
         AND ($2::text IS NULL OR g.lifecycle_status = $2)
         AND ($3 = '' OR g.normalized_name LIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR (g.sort_key, g.id) > ($4, $5))
       ORDER BY g.sort_key, g.id
       LIMIT $6`,
      [args.orgId, args.status ?? null, q, cursor?.keys[0] ?? null, cursor?.id ?? null, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map(groupView),
      nextCursor: hasMore && last ? encodeCursor({ keys: [last.sort_key], id: last.id }) : null,
    }
  }

  async createGroup(orgId: string, input: TagGroupInput, ctx: MutationContext): Promise<TagGroupView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-groups:${orgId}`])
        const { rows: counts } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM tag_groups WHERE org_id = $1 AND lifecycle_status = 'active'`, [orgId],
        )
        if (Number(counts[0]?.count ?? 0) >= MAX_GROUPS_PER_ORG) {
          throw new TagRepositoryError(409, 'tag_group_quota_exceeded', `An organization can have at most ${MAX_GROUPS_PER_ORG} active Tag Groups`)
        }
        const id = input.clientId ?? newId('taggrp')
        const { rows } = await client.query<GroupRow>(
          `INSERT INTO tag_groups (
             id, org_id, name, normalized_name, description, icon_key, sort_key, created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             (SELECT lpad((COALESCE(max(sort_key::bigint), 0) + 1024)::text, 18, '0') FROM tag_groups WHERE org_id = $2),
             $7, $7
           )
           RETURNING id, org_id, name, normalized_name, description, icon_key, sort_key, lifecycle_status,
                     version, created_at, updated_at`,
          [id, orgId, input.name, input.normalizedName, input.description, input.iconKey, ctx.actorUserId],
        )
        const created = groupView(rows[0])
        await appendAudit(client, ctx, orgId, 'tag_group.create', 'tag_group', id, { before: null, after: created })
        return created
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag_group')
    }
  }

  async listTags(args: {
    orgId: string; q?: string; groupIds?: string[]; status?: TagLifecycle; after?: string; limit?: number
  }): Promise<KeysetPage<TagView>> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
    const cursor = decodeTagCursor(args.after)
    const q = args.q ? normalizeTagIdentity(args.q) : ''
    const groupIds = args.groupIds?.filter(Boolean) ?? []
    const { rows } = await this.pool.query<TagRow>(
      `SELECT t.id, t.org_id, t.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
              t.value, t.normalized_value, t.color, t.sort_key, t.lifecycle_status,
              t.canonical_tag_id, t.version, t.created_at, t.updated_at
       FROM tags t JOIN tag_groups g ON g.org_id = t.org_id AND g.id = t.group_id
       WHERE t.org_id = $1
         AND ($2::text IS NULL OR t.lifecycle_status = $2)
         AND (cardinality($3::text[]) = 0 OR t.group_id = ANY($3::text[]))
         AND ($4 = '' OR t.normalized_value LIKE '%' || $4 || '%' OR g.normalized_name LIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR (g.sort_key, t.sort_key, t.id) > ($5, $6, $7))
       ORDER BY g.sort_key, t.sort_key, t.id
       LIMIT $8`,
      [
        args.orgId, args.status ?? null, groupIds, q,
        cursor?.keys[0] ?? null, cursor?.keys[1] ?? null, cursor?.id ?? null, limit + 1,
      ],
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map(tagView),
      nextCursor: hasMore && last ? encodeCursor({ keys: [last.group_sort_key, last.sort_key], id: last.id }) : null,
    }
  }

  /**
   * Resolve the complete identity family for a Tag. Reading a canonical Tag
   * therefore includes audit and assignments still carrying a merged source
   * ID, while asking for a source follows it to the same canonical family.
   */
  private async tagFamilyIds(orgId: string, tagId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `WITH RECURSIVE upwards(id, canonical_tag_id, depth, path) AS (
         SELECT t.id, t.canonical_tag_id, 0, ARRAY[t.id]::text[]
         FROM tags t WHERE t.org_id = $1 AND t.id = $2
         UNION ALL
         SELECT next.id, next.canonical_tag_id, upwards.depth + 1, upwards.path || next.id
         FROM upwards
         JOIN tags next ON next.org_id = $1 AND next.id = upwards.canonical_tag_id
         WHERE upwards.depth < 31 AND NOT next.id = ANY(upwards.path)
       ), canonical AS (
         SELECT id FROM upwards ORDER BY depth DESC LIMIT 1
       ), family(id, depth, path) AS (
         SELECT id, 0, ARRAY[id]::text[] FROM canonical
         UNION ALL
         SELECT child.id, family.depth + 1, family.path || child.id
         FROM family
         JOIN tags child ON child.org_id = $1 AND child.canonical_tag_id = family.id
         WHERE family.depth < 31 AND NOT child.id = ANY(family.path)
       )
       SELECT DISTINCT id FROM family ORDER BY id`,
      [orgId, tagId],
    )
    if (rows.length === 0) throw new TagRepositoryError(404, 'tag_not_found', 'Tag not found')
    return rows.map((row) => row.id)
  }

  async listTagAudit(args: {
    orgId: string; tagId: string; action?: string; after?: string; limit?: number
  }): Promise<KeysetPage<TagAuditEntry>> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
    if (args.after) {
      try {
        if (!/^\d{1,19}$/.test(args.after) || BigInt(args.after) > 9_223_372_036_854_775_807n) throw new Error('invalid')
      } catch {
        throw new TagRepositoryError(400, 'invalid_cursor', 'after must be a valid audit cursor')
      }
    }
    const familyIds = await this.tagFamilyIds(args.orgId, args.tagId)
    const { rows } = await this.pool.query<{
      id: string
      at: Date | string
      actor_user_id: string
      actor_email: string | null
      impersonator_user_id: string | null
      impersonator_email: string | null
      action: string
      target_kind: string
      target_id: string
      detail: unknown
    }>(
      `SELECT a.id, a.at, a.actor_user_id, actor.email AS actor_email,
              a.impersonator_user_id, impersonator.email AS impersonator_email,
              a.action, a.target_kind, a.target_id, a.detail
       FROM audit_log a
       LEFT JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users impersonator ON impersonator.id = a.impersonator_user_id
       WHERE a.org_id = $1 AND a.target_kind = 'tag' AND a.target_id = ANY($2::text[])
         AND ($3 = '' OR a.action LIKE $3 || '%')
         AND ($4::bigint IS NULL OR a.id < $4::bigint)
       ORDER BY a.id DESC
       LIMIT $5`,
      [args.orgId, familyIds, args.action ?? '', args.after ?? null, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      items: page.map((row) => ({
        id: String(row.id),
        at: iso(row.at),
        actorUserId: row.actor_user_id,
        actorEmail: row.actor_email,
        impersonatorUserId: row.impersonator_user_id,
        impersonatorEmail: row.impersonator_email,
        action: row.action,
        targetKind: row.target_kind,
        targetId: row.target_id,
        detail: row.detail,
      })),
      nextCursor: hasMore ? String(page.at(-1)!.id) : null,
    }
  }

  async listTagAssignments(args: {
    orgId: string; tagId: string; kind?: TagAssignmentKind; after?: string; limit?: number
  }): Promise<KeysetPage<TagAssignmentView>> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
    const cursor = decodeTagCursor(args.after)
    if (cursor && (cursor.keys.length !== 3 || !['group', 'object'].includes(cursor.keys[0]))) {
      throw new TagRepositoryError(400, 'invalid_cursor', 'after must be a valid Tag assignment cursor')
    }
    const familyIds = await this.tagFamilyIds(args.orgId, args.tagId)
    const tables = await this.pool.query<{
      object_tags: string | null
      group_tags: string | null
      objects: string | null
      groups: string | null
    }>(
      `SELECT to_regclass('ro_object_tags')::text AS object_tags,
              to_regclass('ro_group_tags')::text AS group_tags,
              to_regclass('ro_objects')::text AS objects,
              to_regclass('ro_groups')::text AS groups`,
    )
    if (Object.values(tables.rows[0] ?? {}).some((table) => !table)) return { items: [], nextCursor: null }

    const { rows } = await this.pool.query<{
      kind: TagAssignmentKind
      landscape_id: string
      landscape_name: string
      version_id: string
      version_name: string
      entity_id: string
      entity_name: string
      entity_type: string | null
    }>(
      `WITH object_rows AS (
         SELECT DISTINCT 'object'::text AS kind, postings.landscape_id,
                COALESCE(NULLIF(landscape.name, ''), postings.landscape_id) AS landscape_name,
                postings.version_id,
                COALESCE(NULLIF(version.label, ''), postings.version_id) AS version_name,
                postings.object_id AS entity_id,
                COALESCE(NULLIF(entity.name, ''), postings.object_id) AS entity_name,
                NULLIF(entity.type, '') AS entity_type
         FROM ro_object_tags postings
         LEFT JOIN ro_objects entity
           ON entity.landscape_id = postings.landscape_id AND entity.version_id = postings.version_id
          AND entity.id = postings.object_id AND entity.org_id = $1
         LEFT JOIN landscapes landscape ON landscape.id = postings.landscape_id AND landscape.org_id = $1
         LEFT JOIN versions version ON version.id = postings.version_id AND version.landscape_id = postings.landscape_id
         WHERE postings.org_id = $1 AND postings.tag_id = ANY($2::text[])
       ), group_rows AS (
         SELECT DISTINCT 'group'::text AS kind, postings.landscape_id,
                COALESCE(NULLIF(landscape.name, ''), postings.landscape_id) AS landscape_name,
                postings.version_id,
                COALESCE(NULLIF(version.label, ''), postings.version_id) AS version_name,
                postings.group_id AS entity_id,
                COALESCE(NULLIF(entity.name, ''), postings.group_id) AS entity_name,
                NULL::text AS entity_type
         FROM ro_group_tags postings
         LEFT JOIN ro_groups entity
           ON entity.landscape_id = postings.landscape_id AND entity.version_id = postings.version_id
          AND entity.id = postings.group_id AND entity.org_id = $1
         LEFT JOIN landscapes landscape ON landscape.id = postings.landscape_id AND landscape.org_id = $1
         LEFT JOIN versions version ON version.id = postings.version_id AND version.landscape_id = postings.landscape_id
         WHERE postings.org_id = $1 AND postings.tag_id = ANY($2::text[])
       ), assignments AS (
         SELECT * FROM object_rows UNION ALL SELECT * FROM group_rows
       )
       SELECT kind, landscape_id, landscape_name, version_id, version_name,
              entity_id, entity_name, entity_type
       FROM assignments
       WHERE ($3::text IS NULL OR kind = $3)
         AND ($4::text IS NULL OR (kind, landscape_id, version_id, entity_id) > ($4, $5, $6, $7))
       ORDER BY kind, landscape_id, version_id, entity_id
       LIMIT $8`,
      [
        args.orgId, familyIds, args.kind ?? null,
        cursor?.keys[0] ?? null, cursor?.keys[1] ?? null, cursor?.keys[2] ?? null, cursor?.id ?? null,
        limit + 1,
      ],
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => ({
        kind: row.kind,
        landscapeId: row.landscape_id,
        landscapeName: row.landscape_name,
        versionId: row.version_id,
        versionName: row.version_name,
        entityId: row.entity_id,
        entityName: row.entity_name,
        entityType: row.entity_type,
      })),
      nextCursor: hasMore && last ? encodeCursor({
        keys: [last.kind, last.landscape_id, last.version_id],
        id: last.entity_id,
      }) : null,
    }
  }

  async createTag(orgId: string, input: TagInput, ctx: MutationContext): Promise<TagView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tags:${orgId}`])
        const { rows: groups } = await client.query(
          `SELECT 1 FROM tag_groups WHERE org_id = $1 AND id = $2 AND lifecycle_status = 'active' FOR SHARE`,
          [orgId, input.groupId],
        )
        if (groups.length === 0) throw new TagRepositoryError(404, 'tag_group_not_found', 'The active Tag Group was not found')
        const { rows: counts } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM tags WHERE org_id = $1 AND lifecycle_status = 'active'`, [orgId],
        )
        if (Number(counts[0]?.count ?? 0) >= MAX_ACTIVE_TAGS_PER_ORG) {
          throw new TagRepositoryError(409, 'tag_quota_exceeded', `An organization can have at most ${MAX_ACTIVE_TAGS_PER_ORG} active Tags`)
        }
        const id = input.clientId ?? newId('tag')
        const { rows } = await client.query<TagRow>(
          `WITH inserted AS (
             INSERT INTO tags (
               id, org_id, group_id, value, normalized_value, color, sort_key, created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               (SELECT lpad((COALESCE(max(sort_key::bigint), 0) + 1024)::text, 18, '0')
                FROM tags WHERE org_id = $2 AND group_id = $3),
               $7, $7
             )
             RETURNING *
           )
           SELECT i.id, i.org_id, i.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                  i.value, i.normalized_value, i.color, i.sort_key, i.lifecycle_status,
                  i.canonical_tag_id, i.version, i.created_at, i.updated_at
           FROM inserted i JOIN tag_groups g ON g.org_id = i.org_id AND g.id = i.group_id`,
          [id, orgId, input.groupId, input.value, input.normalizedValue, input.color, ctx.actorUserId],
        )
        const created = tagView(rows[0])
        await appendAudit(client, ctx, orgId, 'tag.create', 'tag', id, { before: null, after: created })
        return created
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag')
    }
  }

  async updateGroup(
    orgId: string,
    groupId: string,
    patch: TagGroupPatchInput,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagGroupView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        const row = await this.lockedGroup(client, orgId, groupId)
        const before = groupView(row)
        assertVersion(before, expectedVersion, 'Tag Group')
        const { rows } = await client.query<GroupRow>(
          `UPDATE tag_groups SET
             name = CASE WHEN $3 THEN $4 ELSE name END,
             normalized_name = CASE WHEN $3 THEN $5 ELSE normalized_name END,
             description = CASE WHEN $6 THEN $7 ELSE description END,
             icon_key = CASE WHEN $8 THEN $9 ELSE icon_key END,
             version = version + 1,
             updated_by = $10,
             updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING id, org_id, name, normalized_name, description, icon_key, sort_key,
                     lifecycle_status, version, created_at, updated_at`,
          [
            orgId, groupId,
            patch.name !== undefined, patch.name ?? null, patch.normalizedName ?? null,
            patch.description !== undefined, patch.description ?? null,
            patch.iconKey !== undefined, patch.iconKey ?? null,
            ctx.actorUserId,
          ],
        )
        const after = groupView(rows[0])
        await appendAudit(client, ctx, orgId, 'tag_group.update', 'tag_group', groupId, { before, after })
        return after
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag_group')
    }
  }

  async setGroupLifecycle(
    orgId: string,
    groupId: string,
    lifecycle: TagGroupLifecycle,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagGroupView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-groups:${orgId}`])
        const row = await this.lockedGroup(client, orgId, groupId)
        const before = groupView(row)
        assertVersion(before, expectedVersion, 'Tag Group')
        if (before.lifecycleStatus === lifecycle) return before
        if (lifecycle === 'archived') {
          const { rows: counts } = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM tags
             WHERE org_id = $1 AND group_id = $2 AND lifecycle_status = 'active'`,
            [orgId, groupId],
          )
          const activeTagCount = Number(counts[0]?.count ?? 0)
          if (activeTagCount > 0) {
            throw new TagRepositoryError(
              409,
              'tag_group_not_empty',
              'Archive or move the active Tags before archiving this Tag Group',
              { activeTagCount },
            )
          }
        } else {
          const { rows: counts } = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM tag_groups WHERE org_id = $1 AND lifecycle_status = 'active'`, [orgId],
          )
          if (Number(counts[0]?.count ?? 0) >= MAX_GROUPS_PER_ORG) {
            throw new TagRepositoryError(409, 'tag_group_quota_exceeded', `An organization can have at most ${MAX_GROUPS_PER_ORG} active Tag Groups`)
          }
        }
        const { rows } = await client.query<GroupRow>(
          `UPDATE tag_groups SET lifecycle_status = $3, version = version + 1,
             updated_by = $4, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING id, org_id, name, normalized_name, description, icon_key, sort_key,
                     lifecycle_status, version, created_at, updated_at`,
          [orgId, groupId, lifecycle, ctx.actorUserId],
        )
        const after = groupView(rows[0])
        await appendAudit(client, ctx, orgId, `tag_group.${lifecycle === 'active' ? 'restore' : 'archive'}`, 'tag_group', groupId, { before, after })
        return after
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag_group')
    }
  }

  async updateTag(
    orgId: string,
    tagId: string,
    patch: TagPatchInput,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tags:${orgId}`])
        const row = await this.lockedTag(client, orgId, tagId)
        const before = tagView(row)
        assertVersion(before, expectedVersion, 'Tag')
        if (before.lifecycleStatus === 'merged') {
          throw new TagRepositoryError(409, 'tag_is_merged', 'Merged Tags are immutable; edit the canonical Tag instead', {
            canonicalTagId: before.canonicalTagId,
          })
        }
        const targetGroupId = patch.groupId ?? before.groupId
        if (patch.groupId !== undefined) {
          const { rows: groups } = await client.query(
            `SELECT 1 FROM tag_groups WHERE org_id = $1 AND id = $2 AND lifecycle_status = 'active' FOR SHARE`,
            [orgId, targetGroupId],
          )
          if (groups.length === 0) throw new TagRepositoryError(404, 'tag_group_not_found', 'The active Tag Group was not found')
        }
        const moved = targetGroupId !== before.groupId
        const { rows } = await client.query<TagRow>(
          `WITH changed AS (
             UPDATE tags SET
               group_id = $3,
               value = CASE WHEN $4 THEN $5 ELSE value END,
               normalized_value = CASE WHEN $4 THEN $6 ELSE normalized_value END,
               color = CASE WHEN $7 THEN $8 ELSE color END,
               sort_key = CASE WHEN $9 THEN (
                 SELECT lpad((COALESCE(max(sort_key::bigint), 0) + 1024)::text, 18, '0')
                 FROM tags WHERE org_id = $1 AND group_id = $3
               ) ELSE sort_key END,
               version = version + 1,
               updated_by = $10,
               updated_at = now()
             WHERE org_id = $1 AND id = $2
             RETURNING *
           )
           SELECT c.id, c.org_id, c.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                  c.value, c.normalized_value, c.color, c.sort_key, c.lifecycle_status,
                  c.canonical_tag_id, c.version, c.created_at, c.updated_at
           FROM changed c JOIN tag_groups g ON g.org_id = c.org_id AND g.id = c.group_id`,
          [
            orgId, tagId, targetGroupId,
            patch.value !== undefined, patch.value ?? null, patch.normalizedValue ?? null,
            patch.color !== undefined, patch.color ?? null,
            moved, ctx.actorUserId,
          ],
        )
        const after = tagView(rows[0])
        await appendAudit(client, ctx, orgId, 'tag.update', 'tag', tagId, { before, after })
        return after
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag')
    }
  }

  async setTagLifecycle(
    orgId: string,
    tagId: string,
    lifecycle: 'active' | 'archived',
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagView> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tags:${orgId}`])
        const row = await this.lockedTag(client, orgId, tagId)
        const before = tagView(row)
        assertVersion(before, expectedVersion, 'Tag')
        if (before.lifecycleStatus === 'merged') {
          throw new TagRepositoryError(409, 'tag_is_merged', 'Merged Tags cannot be archived or restored', {
            canonicalTagId: before.canonicalTagId,
          })
        }
        if (before.lifecycleStatus === lifecycle) return before
        if (lifecycle === 'active') {
          const { rows: groups } = await client.query(
            `SELECT 1 FROM tag_groups WHERE org_id = $1 AND id = $2 AND lifecycle_status = 'active' FOR SHARE`,
            [orgId, before.groupId],
          )
          if (groups.length === 0) throw new TagRepositoryError(409, 'tag_group_archived', 'Restore the Tag Group before restoring this Tag')
          const { rows: counts } = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM tags WHERE org_id = $1 AND lifecycle_status = 'active'`, [orgId],
          )
          if (Number(counts[0]?.count ?? 0) >= MAX_ACTIVE_TAGS_PER_ORG) {
            throw new TagRepositoryError(409, 'tag_quota_exceeded', `An organization can have at most ${MAX_ACTIVE_TAGS_PER_ORG} active Tags`)
          }
        }
        const { rows } = await client.query<TagRow>(
          `WITH changed AS (
             UPDATE tags SET lifecycle_status = $3, version = version + 1,
               updated_by = $4, updated_at = now()
             WHERE org_id = $1 AND id = $2
             RETURNING *
           )
           SELECT c.id, c.org_id, c.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                  c.value, c.normalized_value, c.color, c.sort_key, c.lifecycle_status,
                  c.canonical_tag_id, c.version, c.created_at, c.updated_at
           FROM changed c JOIN tag_groups g ON g.org_id = c.org_id AND g.id = c.group_id`,
          [orgId, tagId, lifecycle, ctx.actorUserId],
        )
        const after = tagView(rows[0])
        await appendAudit(client, ctx, orgId, `tag.${lifecycle === 'active' ? 'restore' : 'archive'}`, 'tag', tagId, { before, after })
        return after
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag')
    }
  }

  /**
   * Applies one Admin Tags bulk command atomically. All identities are locked in
   * deterministic order and every optimistic version is verified before the
   * first update, so a stale or foreign item rolls the complete batch back.
   */
  async batchMutateTags(
    orgId: string,
    input: TagBatchInput,
    ctx: MutationContext,
  ): Promise<TagView[]> {
    try {
      return await idempotentTransaction(this.pool, orgId, ctx, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tags:${orgId}`])
        const orderedIds = input.items.map((item) => item.id).sort()
        const { rows } = await client.query<TagRow>(
          `SELECT t.id, t.org_id, t.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                  t.value, t.normalized_value, t.color, t.sort_key, t.lifecycle_status,
                  t.canonical_tag_id, t.version, t.created_at, t.updated_at
           FROM tags t JOIN tag_groups g ON g.org_id = t.org_id AND g.id = t.group_id
           WHERE t.org_id = $1 AND t.id = ANY($2::text[])
           ORDER BY t.id FOR UPDATE OF t`,
          [orgId, orderedIds],
        )
        if (rows.length !== orderedIds.length) {
          throw new TagRepositoryError(404, 'tag_not_found', 'One or more Tags were not found')
        }
        const rowsById = new Map(rows.map((row) => [row.id, row]))
        for (const item of input.items) {
          const current = tagView(rowsById.get(item.id)!)
          assertVersion(current, item.expectedVersion, 'Tag')
          if (current.lifecycleStatus === 'merged') {
            throw new TagRepositoryError(409, 'tag_is_merged', 'Merged Tags are immutable; edit the canonical Tag instead', {
              canonicalTagId: current.canonicalTagId,
            })
          }
        }

        let nextTargetRank: bigint | null = null
        if (input.action === 'move') {
          const targetGroup = await this.lockedGroup(client, orgId, input.groupId!)
          if (targetGroup.lifecycle_status !== 'active') {
            throw new TagRepositoryError(409, 'tag_group_archived', 'Tags can only be moved into an active Tag Group')
          }
          const rank = await client.query<{ max_rank: string }>(
            `SELECT COALESCE(max(sort_key::bigint), 0)::text AS max_rank
             FROM tags WHERE org_id = $1 AND group_id = $2`,
            [orgId, input.groupId],
          )
          nextTargetRank = BigInt(rank.rows[0]?.max_rank ?? '0')
        }

        if (input.action === 'restore') {
          const restoreRows = rows.filter((row) => row.lifecycle_status === 'archived')
          const restoreGroupIds = [...new Set(restoreRows.map((row) => row.group_id))]
          if (restoreGroupIds.length > 0) {
            const groups = await client.query<{ id: string }>(
              `SELECT id FROM tag_groups
               WHERE org_id = $1 AND id = ANY($2::text[]) AND lifecycle_status = 'active' FOR SHARE`,
              [orgId, restoreGroupIds],
            )
            if (groups.rows.length !== restoreGroupIds.length) {
              throw new TagRepositoryError(409, 'tag_group_archived', 'Restore every Tag Group before restoring its Tags')
            }
            const counts = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM tags WHERE org_id = $1 AND lifecycle_status = 'active'`,
              [orgId],
            )
            if (Number(counts.rows[0]?.count ?? 0) + restoreRows.length > MAX_ACTIVE_TAGS_PER_ORG) {
              throw new TagRepositoryError(409, 'tag_quota_exceeded', `An organization can have at most ${MAX_ACTIVE_TAGS_PER_ORG} active Tags`)
            }
          }
        }

        const changedById = new Map<string, TagView>()
        for (const item of input.items) {
          const before = tagView(rowsById.get(item.id)!)
          const noChange =
            (input.action === 'recolor' && before.color === input.color) ||
            (input.action === 'move' && before.groupId === input.groupId) ||
            (input.action === 'archive' && before.lifecycleStatus === 'archived') ||
            (input.action === 'restore' && before.lifecycleStatus === 'active')
          if (noChange) {
            changedById.set(item.id, before)
            continue
          }

          let updateSql: string
          let values: unknown[]
          if (input.action === 'recolor') {
            updateSql = `UPDATE tags SET color = $3, version = version + 1,
              updated_by = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`
            values = [orgId, item.id, input.color, ctx.actorUserId]
          } else if (input.action === 'move') {
            nextTargetRank = nextTargetRank! + 1024n
            updateSql = `UPDATE tags SET group_id = $3, sort_key = $4, version = version + 1,
              updated_by = $5, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`
            values = [orgId, item.id, input.groupId, paddedRank(nextTargetRank), ctx.actorUserId]
          } else {
            const lifecycle = input.action === 'archive' ? 'archived' : 'active'
            updateSql = `UPDATE tags SET lifecycle_status = $3, version = version + 1,
              updated_by = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`
            values = [orgId, item.id, lifecycle, ctx.actorUserId]
          }
          const changed = await client.query<TagRow>(
            `WITH changed AS (${updateSql})
             SELECT c.id, c.org_id, c.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                    c.value, c.normalized_value, c.color, c.sort_key, c.lifecycle_status,
                    c.canonical_tag_id, c.version, c.created_at, c.updated_at
             FROM changed c JOIN tag_groups g ON g.org_id = c.org_id AND g.id = c.group_id`,
            values,
          )
          const after = tagView(changed.rows[0])
          await appendAudit(client, ctx, orgId, `tag.batch.${input.action}`, 'tag', item.id, {
            batch: { action: input.action, size: input.items.length },
            before,
            after,
          })
          changedById.set(item.id, after)
        }
        return input.items.map((item) => changedById.get(item.id)!)
      })
    } catch (error) {
      translateDbError(error, 'duplicate_tag')
    }
  }

  /** Counts current read-model assignments only when the sparse postings exist. */
  async tagUsageSummary(orgId: string, tagIds: string[]): Promise<TagUsageCount[]> {
    const ids = [...new Set(tagIds)].slice(0, 100)
    if (ids.length === 0) return []
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM tags WHERE org_id = $1 AND id = ANY($2::text[])`,
      [orgId, ids],
    )
    if (existing.rows.length !== ids.length) {
      throw new TagRepositoryError(404, 'tag_not_found', 'One or more Tags were not found')
    }
    const tables = await this.pool.query<{ objects: string | null; groups: string | null }>(
      `SELECT to_regclass('ro_object_tags')::text AS objects,
              to_regclass('ro_group_tags')::text AS groups`,
    )
    if (!tables.rows[0]?.objects || !tables.rows[0]?.groups) {
      return ids.map((tagId) => ({ tagId, objectAssignments: 0, groupAssignments: 0, totalAssignments: 0 }))
    }
    const { rows } = await this.pool.query<{
      tag_id: string
      object_assignments: string
      group_assignments: string
    }>(
      `WITH RECURSIVE aliases(requested_id, tag_id, path) AS (
         SELECT t.id, t.id, ARRAY[t.id]::text[]
         FROM tags t WHERE t.org_id = $1 AND t.id = ANY($2::text[])
         UNION ALL
         SELECT aliases.requested_id, redirects.source_tag_id, aliases.path || redirects.source_tag_id
         FROM aliases
         JOIN tag_redirects redirects
           ON redirects.org_id = $1 AND redirects.target_tag_id = aliases.tag_id
         WHERE NOT redirects.source_tag_id = ANY(aliases.path)
       ), object_counts AS (
         SELECT aliases.requested_id, count(*)::text AS count
         FROM aliases JOIN ro_object_tags postings
           ON postings.org_id = $1 AND postings.tag_id = aliases.tag_id
         GROUP BY aliases.requested_id
       ), group_counts AS (
         SELECT aliases.requested_id, count(*)::text AS count
         FROM aliases JOIN ro_group_tags postings
           ON postings.org_id = $1 AND postings.tag_id = aliases.tag_id
         GROUP BY aliases.requested_id
       )
       SELECT requested.id AS tag_id,
              COALESCE(object_counts.count, '0') AS object_assignments,
              COALESCE(group_counts.count, '0') AS group_assignments
       FROM unnest($2::text[]) WITH ORDINALITY AS requested(id, ordinal)
       LEFT JOIN object_counts ON object_counts.requested_id = requested.id
       LEFT JOIN group_counts ON group_counts.requested_id = requested.id
       ORDER BY requested.ordinal`,
      [orgId, ids],
    )
    return rows.map((row) => {
      const objectAssignments = Number(row.object_assignments)
      const groupAssignments = Number(row.group_assignments)
      return {
        tagId: row.tag_id,
        objectAssignments,
        groupAssignments,
        totalAssignments: objectAssignments + groupAssignments,
      }
    })
  }

  async moveGroup(
    orgId: string,
    groupId: string,
    move: TagMoveInput,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagGroupView> {
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-group-order:${orgId}`])
      const row = await this.lockedGroup(client, orgId, groupId)
      const before = groupView(row)
      assertVersion(before, expectedVersion, 'Tag Group')
      if (before.lifecycleStatus !== 'active') throw new TagRepositoryError(409, 'tag_group_inactive', 'Only active Tag Groups can be reordered')
      const sortKey = await this.groupMoveRank(client, orgId, groupId, move)
      const { rows } = await client.query<GroupRow>(
        `UPDATE tag_groups SET sort_key = $3, version = version + 1, updated_by = $4, updated_at = now()
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, name, normalized_name, description, icon_key, sort_key,
                   lifecycle_status, version, created_at, updated_at`,
        [orgId, groupId, sortKey, ctx.actorUserId],
      )
      const after = groupView(rows[0])
      await appendAudit(client, ctx, orgId, 'tag_group.reorder', 'tag_group', groupId, {
        before,
        after,
        beforeId: move.beforeId,
        afterId: move.afterId,
      })
      return after
    })
  }

  async moveTag(
    orgId: string,
    tagId: string,
    move: TagMoveInput,
    expectedVersion: number,
    ctx: MutationContext,
  ): Promise<TagView> {
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-order:${orgId}`])
      const row = await this.lockedTag(client, orgId, tagId)
      const before = tagView(row)
      assertVersion(before, expectedVersion, 'Tag')
      if (before.lifecycleStatus !== 'active') throw new TagRepositoryError(409, 'tag_inactive', 'Only active Tags can be reordered')
      const sortKey = await this.tagMoveRank(client, orgId, before.groupId, tagId, move)
      const { rows } = await client.query<TagRow>(
        `WITH changed AS (
           UPDATE tags SET sort_key = $3, version = version + 1, updated_by = $4, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING *
         )
         SELECT c.id, c.org_id, c.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                c.value, c.normalized_value, c.color, c.sort_key, c.lifecycle_status,
                c.canonical_tag_id, c.version, c.created_at, c.updated_at
         FROM changed c JOIN tag_groups g ON g.org_id = c.org_id AND g.id = c.group_id`,
        [orgId, tagId, sortKey, ctx.actorUserId],
      )
      const after = tagView(rows[0])
      await appendAudit(client, ctx, orgId, 'tag.reorder', 'tag', tagId, {
        before,
        after,
        beforeId: move.beforeId,
        afterId: move.afterId,
      })
      return after
    })
  }

  async mergeTags(
    orgId: string,
    sourceTagId: string,
    targetTagId: string,
    expectedSourceVersion: number,
    expectedTargetVersion: number,
    ctx: MutationContext,
  ): Promise<{ source: TagView; canonical: TagView }> {
    if (sourceTagId === targetTagId) throw new TagRepositoryError(400, 'invalid_merge_target', 'A Tag cannot be merged into itself')
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-merge:${orgId}`])
      const { rows } = await client.query<TagRow>(
        `SELECT t.id, t.org_id, t.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                t.value, t.normalized_value, t.color, t.sort_key, t.lifecycle_status,
                t.canonical_tag_id, t.version, t.created_at, t.updated_at
         FROM tags t JOIN tag_groups g ON g.org_id = t.org_id AND g.id = t.group_id
         WHERE t.org_id = $1 AND t.id = ANY($2::text[])
         ORDER BY t.id FOR UPDATE OF t`,
        [orgId, [sourceTagId, targetTagId]],
      )
      const sourceRow = rows.find((row) => row.id === sourceTagId)
      const targetRow = rows.find((row) => row.id === targetTagId)
      if (!sourceRow || !targetRow) throw new TagRepositoryError(404, 'tag_not_found', 'Source or target Tag not found')
      const sourceBefore = tagView(sourceRow)
      const canonical = tagView(targetRow)
      assertVersion(sourceBefore, expectedSourceVersion, 'Source Tag')
      assertVersion(canonical, expectedTargetVersion, 'Target Tag')
      if (sourceBefore.lifecycleStatus === 'merged') {
        throw new TagRepositoryError(409, 'tag_is_merged', 'The source Tag is already merged', {
          canonicalTagId: sourceBefore.canonicalTagId,
        })
      }
      if (canonical.lifecycleStatus !== 'active' || canonical.canonicalTagId !== null) {
        throw new TagRepositoryError(409, 'merge_target_not_canonical', 'The merge target must be an active canonical Tag')
      }
      await client.query(
        `UPDATE tags SET lifecycle_status = 'merged', canonical_tag_id = $3,
           version = version + 1, updated_by = $4, updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, sourceTagId, targetTagId, ctx.actorUserId],
      )
      await client.query(
        `INSERT INTO tag_redirects (source_tag_id, org_id, target_tag_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [sourceTagId, orgId, targetTagId, ctx.actorUserId],
      )
      const sourceAfter = tagView(await this.lockedTag(client, orgId, sourceTagId))
      await appendAudit(client, ctx, orgId, 'tag.merge', 'tag', sourceTagId, {
        before: sourceBefore,
        after: sourceAfter,
        canonical,
      })
      return { source: sourceAfter, canonical }
    })
  }

  /**
   * Materialize an offline client ID as an append-only redirect. Existing
   * Automerge assignments may already carry this ID, so resolving a duplicate
   * must be durable on the server rather than a browser-only cache alias.
   */
  async reconcileLocalTag(
    orgId: string,
    input: TagInput,
    targetTagId: string,
    ctx: MutationContext,
  ): Promise<{ source: TagView; canonical: TagView }> {
    if (!input.clientId) throw new TagRepositoryError(400, 'local_tag_id_required', 'A client-generated Tag ID is required')
    const localTagId = input.clientId
    if (localTagId === targetTagId) throw new TagRepositoryError(400, 'invalid_reconcile_target', 'A local Tag cannot map to itself')
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-merge:${orgId}`])
      const canonicalRow = await this.lockedTag(client, orgId, targetTagId)
      const canonical = tagView(canonicalRow)
      if (canonical.lifecycleStatus !== 'active' || canonical.canonicalTagId !== null) {
        throw new TagRepositoryError(409, 'reconcile_target_not_canonical', 'The reconciliation target must be an active canonical Tag')
      }

      const existing = await client.query<TagRow>(
        `SELECT t.id, t.org_id, t.group_id, g.name AS group_name, g.sort_key AS group_sort_key,
                t.value, t.normalized_value, t.color, t.sort_key, t.lifecycle_status,
                t.canonical_tag_id, t.version, t.created_at, t.updated_at
         FROM tags t JOIN tag_groups g ON g.org_id = t.org_id AND g.id = t.group_id
         WHERE t.id = $1 FOR UPDATE OF t`,
        [localTagId],
      )
      const existingSource = existing.rows[0]
      if (existingSource) {
        if (existingSource.org_id === orgId && existingSource.lifecycle_status === 'merged'
          && existingSource.canonical_tag_id === canonical.id) {
          return { source: tagView(existingSource), canonical }
        }
        throw new TagRepositoryError(409, 'local_tag_already_published', 'The local Tag ID is already present in the catalog')
      }

      await client.query(
        `INSERT INTO tags (
           id, org_id, group_id, value, normalized_value, color, sort_key,
           lifecycle_status, canonical_tag_id, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'merged', $8, $9, $9)`,
        [
          localTagId,
          orgId,
          canonical.groupId,
          input.value,
          input.normalizedValue,
          input.color,
          canonicalRow.sort_key,
          canonical.id,
          ctx.actorUserId,
        ],
      )
      await client.query(
        `INSERT INTO tag_redirects (source_tag_id, org_id, target_tag_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [localTagId, orgId, canonical.id, ctx.actorUserId],
      )
      const source = tagView(await this.lockedTag(client, orgId, localTagId))
      await appendAudit(client, ctx, orgId, 'tag.outbox.reconcile', 'tag', localTagId, {
        local: {
          id: localTagId,
          groupId: input.groupId,
          value: input.value,
          color: input.color,
        },
        canonical,
      })
      return { source, canonical }
    })
  }

  /**
   * Tag Groups are not assigned directly in Automerge. Reconciliation is
   * therefore an audited choice of an existing target; dependent local Tag
   * commands are rewritten by the client before their next idempotent replay.
   */
  async reconcileLocalGroup(
    orgId: string,
    input: TagGroupInput,
    targetGroupId: string,
    ctx: MutationContext,
  ): Promise<TagGroupView> {
    if (!input.clientId) throw new TagRepositoryError(400, 'local_tag_group_id_required', 'A client-generated Tag Group ID is required')
    const localGroupId = input.clientId
    if (localGroupId === targetGroupId) throw new TagRepositoryError(400, 'invalid_reconcile_target', 'A local Tag Group cannot map to itself')
    return idempotentTransaction(this.pool, orgId, ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-groups:${orgId}`])
      const target = groupView(await this.lockedGroup(client, orgId, targetGroupId))
      if (target.lifecycleStatus !== 'active') {
        throw new TagRepositoryError(409, 'reconcile_target_inactive', 'The reconciliation target must be an active Tag Group')
      }
      const existing = await client.query<{ org_id: string }>(
        `SELECT org_id FROM tag_groups WHERE id = $1 FOR UPDATE`, [localGroupId],
      )
      if (existing.rows[0]) {
        throw new TagRepositoryError(409, 'local_tag_group_already_published', 'The local Tag Group ID is already present in the catalog')
      }
      await appendAudit(client, ctx, orgId, 'tag_group.outbox.reconcile', 'tag_group', target.id, {
        local: {
          id: localGroupId,
          name: input.name,
          description: input.description,
          iconKey: input.iconKey,
        },
        target,
      })
      return target
    })
  }

  async resolveTags(orgId: string, requestedIds: string[]): Promise<ResolveTagsResult> {
    const uniqueIds = [...new Set(requestedIds)].slice(0, 100)
    if (uniqueIds.length === 0) return { resolved: [], unresolvedIds: [] }
    const { rows } = await this.pool.query<TagRow & { requested_id: string; depth: number }>(
      `WITH RECURSIVE walk AS (
         SELECT requested.id AS requested_id, t.*, 0 AS depth, ARRAY[t.id]::text[] AS path
         FROM unnest($2::text[]) AS requested(id)
         JOIN tags t ON t.org_id = $1 AND t.id = requested.id
         UNION ALL
         SELECT walk.requested_id, next.*, walk.depth + 1, walk.path || next.id
         FROM walk
         JOIN tags next ON next.org_id = $1 AND next.id = walk.canonical_tag_id
         WHERE walk.canonical_tag_id IS NOT NULL
           AND walk.depth < 31
           AND NOT next.id = ANY(walk.path)
       ), terminal AS (
         SELECT DISTINCT ON (requested_id) * FROM walk
         ORDER BY requested_id, depth DESC
       )
       SELECT terminal.requested_id, terminal.id, terminal.org_id, terminal.group_id,
              g.name AS group_name, g.sort_key AS group_sort_key,
              terminal.value, terminal.normalized_value, terminal.color, terminal.sort_key,
              terminal.lifecycle_status, terminal.canonical_tag_id, terminal.version,
              terminal.created_at, terminal.updated_at, terminal.depth
       FROM terminal
       JOIN tag_groups g ON g.org_id = terminal.org_id AND g.id = terminal.group_id
       ORDER BY array_position($2::text[], terminal.requested_id)`,
      [orgId, uniqueIds],
    )
    const found = new Set(rows.map((row) => row.requested_id))
    return {
      resolved: rows.map((row) => ({
        requestedId: row.requested_id,
        canonicalTagId: row.id,
        redirected: row.requested_id !== row.id,
        tag: tagView(row),
      })),
      unresolvedIds: uniqueIds.filter((id) => !found.has(id)),
    }
  }
}
