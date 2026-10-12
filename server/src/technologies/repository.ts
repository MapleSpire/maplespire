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
import { referenceTechnologyIconAssets, TECHNOLOGY_ASSET_PUBLIC_PREFIX } from './assets.js'
import { normalizeTechnologyTerm, searchDocument } from './normalize.js'
import { getPlatformSettingsState } from '../platform/settings.js'
import type {
  CreateTechnologyDraftInput,
  CreateTechnologyRevisionInput,
  TechnologyCatalogFacets,
  TechnologyCatalogView,
  TechnologyLifecycle,
  PlatformTechnologyReviewPage,
  TechnologyListResult,
  TechnologyMergeFieldDecisions,
  TechnologyMergeInput,
  TechnologyOverrideState,
  TechnologyPolicy,
  TechnologyRevisionInput,
  TechnologyRole,
  TechnologySearchMatch,
  TechnologyShapeType,
  TechnologyView,
  TechnologyWorkflowStatus,
} from './types.js'
import { TECHNOLOGY_MERGE_FIELDS, TECHNOLOGY_SHAPE_TYPES } from './types.js'

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

interface TechnologyRow {
  id: string
  scope: 'public' | 'org_private'
  owner_org_id: string | null
  lifecycle_status: TechnologyLifecycle
  canonical_technology_id: string | null
  canonical_technology_name: string | null
  redirected_from_ids: string[]
  revision: number
  workflow_status: TechnologyWorkflowStatus
  private_approved: boolean
  submitted_by: string | null
  decision_note: string | null
  name: string
  description: string | null
  website_url: string | null
  documentation_url: string | null
  aliases: string[]
  category: string | null
  icon_light_path: string | null
  icon_dark_path: string | null
  publisher: string | null
  ecosystem: string | null
  recommended_shape_types: TechnologyShapeType[]
  default_role: TechnologyRole
  created_at: Date | string
  created_by: string
  normalized_name: string
  /** Present only on a ranked (searched) page — see `matchRankSql`. */
  match_rank?: number
  org_state: TechnologyOverrideState
  org_override: TechnologyOverrideState | null
  match_kind?: TechnologySearchMatch['matchKind']
  match_score?: number | string
}

interface IdentityRow {
  id: string
  scope: 'public' | 'org_private'
  owner_org_id: string | null
  lifecycle_status: TechnologyLifecycle
  canonical_technology_id: string | null
  latest_revision: number
  current_revision: number
}

export class TechnologyRepositoryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
  }
}

function id(prefix = 'tech'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapTechnology(row: TechnologyRow): TechnologyView {
  return {
    id: row.id,
    scope: row.scope,
    ownerOrgId: row.owner_org_id,
    lifecycleStatus: row.lifecycle_status,
    canonicalTechnologyId: row.canonical_technology_id,
    canonicalTechnologyName: row.canonical_technology_name,
    redirectedFromIds: row.redirected_from_ids ?? [],
    revision: {
      revision: Number(row.revision),
      status: row.workflow_status,
      privateApproved: row.private_approved,
      name: row.name,
      description: row.description,
      websiteUrl: row.website_url,
      documentationUrl: row.documentation_url,
      aliases: row.aliases ?? [],
      category: row.category,
      iconLightPath: row.icon_light_path,
      iconDarkPath: row.icon_dark_path,
      publisher: row.publisher,
      ecosystem: row.ecosystem,
      recommendedShapeTypes: row.recommended_shape_types ?? [],
      defaultRole: row.default_role,
      createdAt: asIso(row.created_at),
      createdBy: row.created_by,
      submittedBy: row.submitted_by,
      decisionNote: row.decision_note,
    },
    orgState: row.org_state,
    orgOverride: row.org_override,
  }
}

function mapSearchMatch(row: TechnologyRow): TechnologySearchMatch {
  return {
    ...mapTechnology(row),
    matchKind: row.match_kind ?? 'contains',
    score: Number(row.match_score ?? 0),
  }
}

function revisionInputFromRow(row: TechnologyRow): TechnologyRevisionInput {
  return {
    name: row.name,
    description: row.description,
    websiteUrl: row.website_url,
    documentationUrl: row.documentation_url,
    aliases: row.aliases ?? [],
    category: row.category,
    iconLightPath: row.icon_light_path,
    iconDarkPath: row.icon_dark_path,
    publisher: row.publisher,
    ecosystem: row.ecosystem,
    recommendedShapeTypes: row.recommended_shape_types ?? [],
    defaultRole: row.default_role,
  }
}

async function referencePublicTechnologyIconAssets(
  client: PoolClient,
  assetOwnerOrgId: string | undefined,
  input: TechnologyRevisionInput,
): Promise<void> {
  const governedPaths = [input.iconLightPath, input.iconDarkPath]
    .filter((value): value is string => Boolean(value?.startsWith(`${TECHNOLOGY_ASSET_PUBLIC_PREFIX}/`)))
  if (governedPaths.length === 0) return
  if (!assetOwnerOrgId) {
    throw new TechnologyRepositoryError(
      400,
      'platform_asset_org_required',
      'An organization context is required for governed platform technology icons',
    )
  }
  await referenceTechnologyIconAssets(client, assetOwnerOrgId, governedPaths)
}

/** Shared selector/read boundary; public review state and private org approval
 * are deliberately independent. */
export function isTechnologySelectableForOrg(technology: TechnologyView): boolean {
  if (!['active', 'deprecated'].includes(technology.lifecycleStatus)) return false
  if (technology.orgState !== 'enabled') return false
  return technology.scope === 'public'
    ? technology.revision.status === 'approved'
    : technology.revision.privateApproved
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return 50
  // Keep every catalog query bounded even if a caller bypasses the UI. Fifty
  // rows is enough for one virtualized/paginated page and prevents accidental
  // materialization of a 50k-entry catalog under concurrent load.
  return Math.min(Math.floor(limit), 50)
}

/**
 * A keyset position in `list()`.
 *
 * `rank` is carried only for a SEARCH page, whose sort leads with the relevance
 * rank; an unfiltered page still sorts by name alone. `q` is carried so the
 * cursor can be REFUSED when it does not belong to the request replaying it.
 *
 * Both are load-bearing, and neither is hypothetical:
 *
 *  - A rank-less cursor replayed WITH a query applies a name-only keyset to a
 *    rank-ordered page. Every rank-2 row sorts before an arbitrary browse
 *    position alphabetically, so the page comes back EMPTY with a null
 *    `nextCursor` — a clean, terminal, wrong "no results" for a query with 52
 *    matches. Not an error the caller can see.
 *  - The rank only means anything relative to the `q` that produced it, so
 *    paging with a cursor minted under a different `q` repeats rows the caller
 *    already has and skips ones it never saw.
 */
interface Cursor { name: string; id: string; rank?: number; q?: string }

/**
 * Lower is better, inverted from `searchWith`'s scores so every sort key runs
 * ascending and the keyset stays a single row comparison.
 *
 * NOT a mirror of `searchWith`, and the difference is user-visible: that one
 * also accepts the punctuation-compact form for an exact name or alias
 * (`regexp_replace(…, '[^a-z0-9+#]', '', 'g')`), matched against
 * `search_compact_document`. `list()` has never queried that column at all, so
 * "aspnet" finds ASP.NET through `/search` and nothing at all through the
 * picker. Widening the MATCH is a separate change from ordering it; this ranks
 * what `list()` already finds.
 */
/** The `ELSE` tier below — the widest rank `matchRankSql` can produce. */
const MAX_MATCH_RANK = 4

function matchRankSql(column: string, queryParam: number): string {
  return `CASE WHEN ${column}.normalized_name = $${queryParam} THEN 0
               WHEN $${queryParam} = ANY(${column}.normalized_aliases) THEN 1
               WHEN ${column}.normalized_name LIKE $${queryParam} || '%' THEN 2
               WHEN EXISTS (
                 SELECT 1 FROM unnest(${column}.normalized_aliases) a
                  WHERE a LIKE $${queryParam} || '%'
               ) THEN 3
               ELSE 4 END`
}
interface ReviewCursor { submittedAt: string; id: string; revision: number }

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof value.name !== 'string' || typeof value.id !== 'string') throw new Error('invalid')
    // Bounded to the ranks that exist, not merely to "a number": a fractional
    // rank reaches `$n::int` as a pg 22P02 and an out-of-int4 one as a 22003,
    // and the route maps both to a 500 rather than to the 400 this function
    // exists to produce. `2 ** 40` is a perfectly safe integer and still
    // overflows the column, so a range check is what actually closes it.
    if (value.rank !== undefined
      && (!Number.isSafeInteger(value.rank) || value.rank < 0 || value.rank > MAX_MATCH_RANK)) {
      throw new Error('invalid')
    }
    if (value.q !== undefined && typeof value.q !== 'string') throw new Error('invalid')
    return value.rank !== undefined
      ? { name: value.name, id: value.id, rank: value.rank, q: value.q ?? '' }
      : { name: value.name, id: value.id, q: value.q ?? '' }
  } catch {
    throw new TechnologyRepositoryError(400, 'invalid_cursor', 'after is not a valid technology cursor')
  }
}

function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeReviewCursor(raw: string | undefined): ReviewCursor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ReviewCursor>
    if (typeof value.submittedAt !== 'string' || typeof value.id !== 'string' || !Number.isSafeInteger(value.revision)) {
      throw new Error('invalid')
    }
    return { submittedAt: value.submittedAt, id: value.id, revision: value.revision! }
  } catch {
    throw new TechnologyRepositoryError(400, 'invalid_cursor', 'after is not a valid review cursor')
  }
}

const VIEW_SELECT = `
  SELECT i.id, i.scope, i.owner_org_id, i.lifecycle_status, i.canonical_technology_id,
         r.revision, w.status AS workflow_status, r.name, r.description, r.website_url,
         r.documentation_url, r.aliases, r.category, r.icon_light_path, r.icon_dark_path,
         r.publisher, r.ecosystem, r.recommended_shape_types, r.default_role,
         r.created_at, r.created_by, r.normalized_name,
         (w.private_approved_at IS NOT NULL) AS private_approved,
         w.submitted_by, w.decision_note,
         (SELECT cr.name
            FROM technology_identities ci
            JOIN technology_revisions cr
              ON cr.technology_id = ci.id AND cr.revision = ci.current_revision
           WHERE ci.id = i.canonical_technology_id) AS canonical_technology_name,
         COALESCE((
           SELECT array_agg(tr.source_technology_id ORDER BY tr.source_technology_id)
             FROM technology_redirects tr
             JOIN technology_identities si ON si.id = tr.source_technology_id
            WHERE tr.target_technology_id = i.id
              AND (si.scope = 'public' OR si.owner_org_id = $1)
         ), ARRAY[]::text[]) AS redirected_from_ids,
         CASE WHEN i.scope = 'org_private' THEN 'enabled'
              ELSE COALESCE(ov.state, CASE WHEN COALESCE(pol.policy, 'all') = 'all' THEN 'enabled' ELSE 'hidden' END)
         END AS org_state,
         CASE WHEN i.scope = 'public' THEN ov.state ELSE NULL END AS org_override
  FROM technology_identities i
  JOIN technology_revisions r ON r.technology_id = i.id AND r.revision = i.latest_revision
  JOIN technology_revision_workflows w ON w.technology_id = r.technology_id AND w.revision = r.revision
  LEFT JOIN technology_org_policies pol ON pol.org_id = $1
  LEFT JOIN technology_org_overrides ov ON ov.org_id = $1 AND ov.technology_id = i.id
`

// Organization readers see the latest private revision, but only the current
// approved revision of a public identity. Platform drafts must never leak into
// organization catalogs before the four-eyes review completes.
const ORG_VIEW_SELECT = VIEW_SELECT.replace(
  'r.revision = i.latest_revision',
  "r.revision = CASE WHEN i.scope = 'public' THEN i.current_revision ELSE i.latest_revision END",
)

async function audit(
  db: Queryable,
  actorUserId: string,
  orgId: string | null,
  action: string,
  technologyId: string | null,
  revision: number | null,
  detail?: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO technology_audit
       (id, actor_user_id, org_id, action, technology_id, revision, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id('techaudit'), actorUserId, orgId, action, technologyId, revision, detail === undefined ? null : JSON.stringify(detail)]
  )
}

async function insertRevision(
  db: Queryable,
  technologyId: string,
  revision: number,
  input: TechnologyRevisionInput,
  actorUserId: string,
  status: TechnologyWorkflowStatus
): Promise<void> {
  const searchable = searchDocument(input)
  await db.query(
    `INSERT INTO technology_revisions
       (technology_id, revision, name, normalized_name, description, website_url, documentation_url,
        aliases, normalized_aliases, category, icon_light_path, icon_dark_path, publisher, ecosystem,
        recommended_shape_types, default_role, search_document, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      technologyId, revision, input.name, searchable.normalizedName, input.description ?? null,
      input.websiteUrl ?? null, input.documentationUrl ?? null, input.aliases ?? [], searchable.normalizedAliases,
      input.category ?? null, input.iconLightPath ?? null, input.iconDarkPath ?? null, input.publisher ?? null,
      input.ecosystem ?? null, input.recommendedShapeTypes ?? [...TECHNOLOGY_SHAPE_TYPES], input.defaultRole ?? 'other',
      searchable.searchText, actorUserId,
    ]
  )
  await db.query(
    `INSERT INTO technology_revision_workflows (technology_id, revision, status, decided_by, decided_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'approved' THEN $4 ELSE NULL END,
             CASE WHEN $3 = 'approved' THEN now() ELSE NULL END)`,
    [technologyId, revision, status, actorUserId]
  )
}

async function identityForUpdate(db: Queryable, technologyId: string): Promise<IdentityRow> {
  const { rows } = await db.query<IdentityRow>(
    `SELECT id, scope, owner_org_id, lifecycle_status, canonical_technology_id, latest_revision, current_revision
     FROM technology_identities WHERE id = $1 FOR UPDATE`,
    [technologyId]
  )
  if (!rows[0]) throw new TechnologyRepositoryError(404, 'technology_not_found', 'Technology not found')
  return rows[0]
}

function assertPrivateOwned(identity: IdentityRow, orgId: string): void {
  if (identity.scope !== 'org_private' || identity.owner_org_id !== orgId) {
    throw new TechnologyRepositoryError(404, 'technology_not_found', 'Private technology not found in organization')
  }
  if (identity.lifecycle_status === 'merged') {
    throw new TechnologyRepositoryError(409, 'technology_merged', 'Merged technology cannot be changed')
  }
}

export class TechnologyRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /** Preserve any explicit decision made on either a legacy or canonical ID.
   * With explicit-only policy, publication must opt the source organization in
   * without ever overwriting an explicit hidden decision. */
  private async activateCanonicalForOrg(
    client: PoolClient,
    actorUserId: string,
    orgId: string | null,
    canonicalTechnologyId: string,
    legacyTechnologyIds: string[] = [],
  ): Promise<void> {
    if (!orgId) return
    const ids = [...new Set([canonicalTechnologyId, ...legacyTechnologyIds])]
    const { rows } = await client.query<{ technology_id: string; state: TechnologyOverrideState }>(
      `SELECT technology_id, state
         FROM technology_org_overrides
        WHERE org_id = $1 AND technology_id = ANY($2::text[])
        FOR UPDATE`,
      [orgId, ids],
    )
    const canonicalOverride = rows.find((row) => row.technology_id === canonicalTechnologyId)
    const preserved = canonicalOverride ?? rows.find((row) => row.state === 'hidden') ?? rows[0]
    if (preserved) {
      await client.query(
        `INSERT INTO technology_org_overrides (org_id, technology_id, state, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, technology_id) DO UPDATE
           SET state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [orgId, canonicalTechnologyId, preserved.state, actorUserId],
      )
      await client.query(
        `DELETE FROM technology_org_overrides
          WHERE org_id = $1 AND technology_id = ANY($2::text[]) AND technology_id <> $3`,
        [orgId, ids, canonicalTechnologyId],
      )
      await audit(client, actorUserId, orgId, 'technology.canonical_availability_preserved', canonicalTechnologyId, null, {
        state: preserved.state,
        previousTechnologyId: preserved.technology_id,
      })
      return
    }

    const policy = await this.getPolicy(orgId, client)
    if (policy === 'none') {
      await client.query(
        `INSERT INTO technology_org_overrides (org_id, technology_id, state, updated_by)
         VALUES ($1, $2, 'enabled', $3)
         ON CONFLICT (org_id, technology_id) DO NOTHING`,
        [orgId, canonicalTechnologyId, actorUserId],
      )
    }
    await audit(client, actorUserId, orgId, 'technology.canonical_auto_activated', canonicalTechnologyId, null, {
      policy,
      explicitOverrideCreated: policy === 'none',
      legacyTechnologyIds,
    })
  }

  private duplicateTerms(input: TechnologyRevisionInput): string[] {
    return [...new Set([input.name, ...(input.aliases ?? [])]
      .map(normalizeTechnologyTerm)
      .filter(Boolean))].sort()
  }

  private async lockDuplicateTerms(client: PoolClient, input: TechnologyRevisionInput): Promise<void> {
    // Stable ordering prevents two concurrent requests with overlapping aliases
    // from acquiring the advisory locks in opposite order.
    for (const term of this.duplicateTerms(input)) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [term])
    }
  }

  private async duplicateMatchesWith(
    db: Queryable,
    orgId: string,
    input: TechnologyRevisionInput,
    excludeTechnologyId?: string,
    platform = false,
  ): Promise<TechnologySearchMatch[]> {
    const byId = new Map<string, TechnologySearchMatch>()
    for (const term of this.duplicateTerms(input)) {
      for (const match of await this.searchWith(db, orgId, term, 10, false, platform)) {
        if (match.id === excludeTechnologyId) continue
        const existing = byId.get(match.id)
        if (!existing || match.score > existing.score) byId.set(match.id, match)
      }
    }
    return [...byId.values()]
      .sort((a, b) => b.score - a.score || a.revision.name.localeCompare(b.revision.name) || a.id.localeCompare(b.id))
      .slice(0, 20)
  }

  async getPolicy(orgId: string, db: Queryable = this.pool): Promise<TechnologyPolicy> {
    const { rows } = await db.query<{ policy: TechnologyPolicy }>(
      'SELECT policy FROM technology_org_policies WHERE org_id = $1',
      [orgId]
    )
    return rows[0]?.policy ?? 'all'
  }

  async list(orgId: string, options: {
    q?: string
    scope?: 'public' | 'org_private' | 'all'
    status?: TechnologyWorkflowStatus
    lifecycle?: TechnologyLifecycle
    after?: string
    limit?: number
    selectable?: boolean
    category?: string
    shapeType?: TechnologyShapeType
    role?: TechnologyRole
    platform?: boolean
    view?: TechnologyCatalogView
  } = {}): Promise<TechnologyListResult> {
    const limit = clampLimit(options.limit)
    const cursor = decodeCursor(options.after)
    const params: unknown[] = [options.platform ? '__platform__' : orgId]
    const view = options.view ?? 'effective'
    const where = [options.platform
      ? `i.scope = 'public'${options.lifecycle === 'merged' ? '' : " AND i.lifecycle_status <> 'merged'"}`
      : view === 'submissions'
        ? `i.scope = 'org_private' AND i.owner_org_id = $1`
        : `(i.scope = 'public' OR i.owner_org_id = $1) AND i.lifecycle_status <> 'merged'`]
    const revisionWhere: string[] = []

    if (!options.platform && options.scope && options.scope !== 'all') {
      params.push(options.scope)
      where.push(`i.scope = $${params.length}`)
    }
    if (options.status) {
      params.push(options.status)
      where.push(`w.status = $${params.length}`)
    }
    if (options.lifecycle) {
      params.push(options.lifecycle)
      where.push(`i.lifecycle_status = $${params.length}`)
    }
    if (options.category) {
      params.push(options.category)
      revisionWhere.push(`candidate_revision.category = $${params.length}`)
    }
    if (options.shapeType) {
      params.push(options.shapeType)
      revisionWhere.push(`candidate_revision.recommended_shape_types @> ARRAY[$${params.length}]::text[]`)
    }
    if (options.role) {
      params.push(options.role)
      revisionWhere.push(`candidate_revision.default_role = $${params.length}`)
    }
    const q = normalizeTechnologyTerm(options.q ?? '')
    let queryParam: number | null = null
    let rankParam: number | null = null
    if (q) {
      params.push(`%${q}%`)
      queryParam = params.length
      // The bare term, for the equality/prefix comparisons the rank is made of.
      params.push(q)
      rankParam = params.length
    }
    if (cursor) {
      // A cursor belongs to the query that minted it. Replaying one from a
      // different `q` — or from a rank-less browse — pages against a sort it was
      // never ordered by, which produces a wrong answer rather than an error:
      // rows repeated, rows skipped, or an empty terminal page. Refuse it.
      if ((cursor.q ?? '') !== q) {
        throw new TechnologyRepositoryError(
          400,
          'invalid_cursor',
          'after belongs to a different search query',
        )
      }
      // A ranked page leads its sort with the rank, so the keyset has to lead
      // with it too or page 2 repeats and skips rows.
      if (rankParam !== null && cursor.rank !== undefined) {
        params.push(cursor.rank, cursor.name, cursor.id)
        // `::int` is load-bearing: a parameter arrives untyped, Postgres
        // resolves an unknown inside a row constructor to `text`, and the
        // comparison then fails with "operator does not exist: integer > text".
        where.push(`(r.match_rank, r.normalized_name, i.id) > ($${params.length - 2}::int, $${params.length - 1}, $${params.length})`)
      } else {
        params.push(cursor.name, cursor.id)
        where.push(`(r.normalized_name, i.id) > ($${params.length - 1}, $${params.length})`)
      }
    }
    if (options.selectable) {
      where.push(`(
        (i.scope = 'public' AND w.status = 'approved') OR
        (i.scope = 'org_private' AND w.private_approved_at IS NOT NULL)
      )`)
      where.push(`i.lifecycle_status IN ('active', 'deprecated')`)
      where.push(`(
        i.scope = 'org_private' OR
        COALESCE(ov.state, CASE WHEN COALESCE(pol.policy, 'all') = 'all' THEN 'enabled' ELSE 'hidden' END) = 'enabled'
      )`)
    }
    params.push(limit + 1)
    let select = options.selectable
      ? VIEW_SELECT.replace('r.revision = i.latest_revision', 'r.revision = i.current_revision')
      : options.platform ? VIEW_SELECT : ORG_VIEW_SELECT
    let revisionCte = ''
    if (revisionWhere.length > 0 || queryParam !== null) {
      const sharedRevisionWhere = revisionWhere.length > 0
        ? ` AND ${revisionWhere.join(' AND ')}`
        : ''
      if (queryParam !== null) {
        // The rank is computed IN the CTE, not in the outer ORDER BY, so the
        // keyset above can compare against it by name. Both arms of the UNION
        // carry it because a UNION needs matching column lists — and because a
        // row reached through a redirect deserves the same ranking as one
        // matched directly.
        const rank = `${matchRankSql('candidate_revision', rankParam!)} AS match_rank`
        revisionCte = `
          WITH redirect_matches AS MATERIALIZED (
            SELECT DISTINCT search_redirect.target_technology_id
              FROM technology_revisions source_revision
              JOIN technology_identities source_identity
                ON source_identity.id = source_revision.technology_id
               AND source_revision.revision = source_identity.latest_revision
              JOIN technology_redirects search_redirect
                ON search_redirect.source_technology_id = source_identity.id
             WHERE (source_identity.scope = 'public' OR source_identity.owner_org_id = $1)
               AND source_revision.search_document LIKE $${queryParam}
          ), filtered_revisions AS MATERIALIZED (
            SELECT candidate_revision.*, ${rank}
              FROM technology_revisions candidate_revision
             WHERE candidate_revision.search_document LIKE $${queryParam}${sharedRevisionWhere}
            UNION
            SELECT candidate_revision.*, ${rank}
              FROM technology_revisions candidate_revision
              JOIN redirect_matches
                ON redirect_matches.target_technology_id = candidate_revision.technology_id
             WHERE TRUE${sharedRevisionWhere}
          )`
      } else {
        revisionCte = `
          WITH filtered_revisions AS MATERIALIZED (
            SELECT candidate_revision.*
              FROM technology_revisions candidate_revision
             WHERE ${revisionWhere.join(' AND ')}
          )`
      }
      select = select.replace('JOIN technology_revisions r', 'JOIN filtered_revisions r')
    }
    // Relevance first when there is something to be relevant to; a plain browse
    // stays alphabetical, which is what a catalog with no query should be.
    //
    // Ties inside a rank stay alphabetical too. A shorter-name-first tie-break
    // was tried and measured worse on the running catalog: "kub" put Kuberun (7)
    // and Kubecost (8) above Kubernetes (10). Without a popularity signal
    // nothing sorts Kubernetes to the top of "kub", and length only trades one
    // arbitrary order for another while demoting long canonical names.
    const ranked = rankParam !== null
    if (ranked) {
      select = select.replace(
        'FROM technology_identities i',
        ', r.match_rank\n       FROM technology_identities i',
      )
    }
    const orderBy = ranked
      ? 'ORDER BY r.match_rank, r.normalized_name, i.id'
      : 'ORDER BY r.normalized_name, i.id'
    const { rows } = await this.pool.query<TechnologyRow>(
      `${revisionCte}
       ${select}
       WHERE ${where.join(' AND ')}
       ${orderBy}
       LIMIT $${params.length}`,
      params
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const tail = page.at(-1)
    const nextCursor = hasMore && tail
      ? encodeCursor(ranked
        ? { name: tail.normalized_name, id: tail.id, rank: tail.match_rank!, q }
        : { name: tail.normalized_name, id: tail.id, q })
      : null
    return {
      technologies: page.map(mapTechnology),
      nextCursor,
      policy: options.platform ? 'all' : await this.getPolicy(orgId),
    }
  }

  listPlatform(options: {
    q?: string
    status?: TechnologyWorkflowStatus
    lifecycle?: TechnologyLifecycle
    after?: string
    limit?: number
  } = {}): Promise<TechnologyListResult> {
    return this.list('__platform__', { ...options, platform: true })
  }

  async facets(orgId: string, selectable = true): Promise<TechnologyCatalogFacets> {
    const select = selectable
      ? VIEW_SELECT.replace('r.revision = i.latest_revision', 'r.revision = i.current_revision')
      : ORG_VIEW_SELECT
    const selectableWhere = selectable ? `
      AND ((i.scope = 'public' AND w.status = 'approved') OR
           (i.scope = 'org_private' AND w.private_approved_at IS NOT NULL))
      AND i.lifecycle_status IN ('active', 'deprecated')
      AND (i.scope = 'org_private' OR
           COALESCE(ov.state, CASE WHEN COALESCE(pol.policy, 'all') = 'all' THEN 'enabled' ELSE 'hidden' END) = 'enabled')
    ` : ''
    const visible = `${select}
      WHERE (i.scope = 'public' OR i.owner_org_id = $1)
        AND i.lifecycle_status <> 'merged'
      ${selectableWhere}`
    const [categories, shapeTypes, roles] = await Promise.all([
      this.pool.query<{ value: string; count: string }>(
        `WITH visible AS (${visible})
         SELECT category AS value, count(*)::text AS count
         FROM visible WHERE category IS NOT NULL AND category <> ''
         GROUP BY category ORDER BY category`,
        [orgId],
      ),
      this.pool.query<{ value: TechnologyShapeType; count: string }>(
        `WITH visible AS (${visible})
         SELECT shape_type AS value, count(*)::text AS count
         FROM visible, unnest(recommended_shape_types) AS shape_type
         GROUP BY shape_type ORDER BY shape_type`,
        [orgId],
      ),
      this.pool.query<{ value: TechnologyRole; count: string }>(
        `WITH visible AS (${visible})
         SELECT default_role AS value, count(*)::text AS count
         FROM visible GROUP BY default_role ORDER BY default_role`,
        [orgId],
      ),
    ])
    return {
      categories: categories.rows.map((row) => ({ value: row.value, count: Number(row.count) })),
      shapeTypes: shapeTypes.rows.map((row) => ({ value: row.value, count: Number(row.count) })),
      roles: roles.rows.map((row) => ({ value: row.value, count: Number(row.count) })),
    }
  }

  async listPublicReviews(options: { after?: string; limit?: number } = {}): Promise<PlatformTechnologyReviewPage> {
    const limit = clampLimit(options.limit)
    const cursor = decodeReviewCursor(options.after)
    const params: unknown[] = []
    const where = [
      `i.scope IN ('org_private', 'public')`,
      `i.lifecycle_status <> 'merged'`,
      `w.status = 'in_review'`,
    ]
    if (cursor) {
      params.push(cursor.submittedAt, cursor.id, cursor.revision)
      where.push(`(w.submitted_at, i.id, r.revision) < ($1::timestamptz, $2, $3)`)
    }
    params.push(limit + 1)
    const { rows } = await this.pool.query<TechnologyRow & { org_name: string; submitted_at: Date | string }>(
      `SELECT i.id, i.scope, i.owner_org_id, i.lifecycle_status, i.canonical_technology_id,
              r.revision, w.status AS workflow_status, r.name, r.description, r.website_url,
              r.documentation_url, r.aliases, r.category, r.icon_light_path, r.icon_dark_path,
              r.publisher, r.ecosystem, r.recommended_shape_types, r.default_role,
              r.created_at, r.created_by, r.normalized_name,
              (w.private_approved_at IS NOT NULL) AS private_approved,
              w.submitted_by, w.decision_note,
              NULL::text AS canonical_technology_name,
              ARRAY[]::text[] AS redirected_from_ids,
              'enabled'::text AS org_state, NULL::text AS org_override,
              COALESCE(o.name, 'Platform catalog') AS org_name, w.submitted_at
       FROM technology_identities i
       JOIN technology_revisions r ON r.technology_id = i.id
       JOIN technology_revision_workflows w ON w.technology_id = r.technology_id AND w.revision = r.revision
       LEFT JOIN orgs o ON o.id = i.owner_org_id
       WHERE ${where.join(' AND ')}
       ORDER BY w.submitted_at DESC, i.id DESC, r.revision DESC
       LIMIT $${params.length}`,
      params,
    )
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const tail = page.at(-1)
    return {
      reviews: page.map((row) => ({
        technology: mapTechnology(row),
        organization: { id: row.owner_org_id ?? 'platform', name: row.org_name },
        source: row.scope === 'public' ? 'platform' : 'organization',
        submittedAt: asIso(row.submitted_at),
        submittedBy: row.submitted_by!,
      })),
      nextCursor: hasMore && tail
        ? encodeReviewCursor({ submittedAt: asIso(tail.submitted_at), id: tail.id, revision: Number(tail.revision) })
        : null,
    }
  }

  private async searchWith(
    db: Queryable,
    orgId: string,
    query: string,
    limit = 20,
    selectable = false,
    platform = false,
  ): Promise<TechnologySearchMatch[]> {
    const q = normalizeTechnologyTerm(query)
    if (!q) return []
    const compact = q.replace(/[^a-z0-9+#]/g, '')
    const safeLimit = Math.min(clampLimit(limit), 50)
    const selectableSql = selectable ? `
      AND ((i.scope = 'public' AND w.status = 'approved') OR
           (i.scope = 'org_private' AND w.private_approved_at IS NOT NULL))
      AND i.lifecycle_status IN ('active', 'deprecated')
      AND (i.scope = 'org_private' OR
           COALESCE(ov.state, CASE WHEN COALESCE(pol.policy, 'all') = 'all' THEN 'enabled' ELSE 'hidden' END) = 'enabled')
    ` : ''
    const baseSelect = (selectable
      ? VIEW_SELECT.replace('r.revision = i.latest_revision', 'r.revision = i.current_revision')
      : platform ? VIEW_SELECT : ORG_VIEW_SELECT)
      .replace('JOIN technology_revisions r', 'JOIN filtered_revisions r')
    const { rows } = await db.query<TechnologyRow>(
      `WITH redirect_matches AS MATERIALIZED (
         SELECT DISTINCT search_redirect.target_technology_id
           FROM technology_revisions source_revision
           JOIN technology_identities source_identity
             ON source_identity.id = source_revision.technology_id
            AND source_revision.revision = source_identity.latest_revision
           JOIN technology_redirects search_redirect
             ON search_redirect.source_technology_id = source_identity.id
          WHERE (source_identity.scope = 'public' OR source_identity.owner_org_id = $1)
            AND (source_revision.search_document LIKE '%' || $2 || '%'
                 OR source_revision.search_compact_document LIKE '%' || $3 || '%')
       ), filtered_revisions AS MATERIALIZED (
         SELECT candidate_revision.*
           FROM technology_revisions candidate_revision
          WHERE candidate_revision.search_document LIKE '%' || $2 || '%'
             OR candidate_revision.search_compact_document LIKE '%' || $3 || '%'
         UNION
         SELECT candidate_revision.*
           FROM technology_revisions candidate_revision
           JOIN redirect_matches
             ON redirect_matches.target_technology_id = candidate_revision.technology_id
       )
       ${baseSelect.replace('FROM technology_identities i', `,
         CASE WHEN r.normalized_name = $2 OR regexp_replace(r.normalized_name, '[^a-z0-9+#]', '', 'g') = $3 THEN 'exact_name'
              WHEN $2 = ANY(r.normalized_aliases)
                   OR EXISTS (SELECT 1 FROM unnest(r.normalized_aliases) a WHERE regexp_replace(a, '[^a-z0-9+#]', '', 'g') = $3)
                THEN 'exact_alias'
              WHEN r.normalized_name LIKE $2 || '%' THEN 'name_prefix'
              WHEN EXISTS (SELECT 1 FROM unnest(r.normalized_aliases) a WHERE a LIKE $2 || '%') THEN 'alias_prefix'
              ELSE 'contains' END AS match_kind,
         CASE WHEN r.normalized_name = $2 OR regexp_replace(r.normalized_name, '[^a-z0-9+#]', '', 'g') = $3 THEN 100
              WHEN $2 = ANY(r.normalized_aliases)
                   OR EXISTS (SELECT 1 FROM unnest(r.normalized_aliases) a WHERE regexp_replace(a, '[^a-z0-9+#]', '', 'g') = $3)
                THEN 95
              WHEN r.normalized_name LIKE $2 || '%' THEN 80
              WHEN EXISTS (SELECT 1 FROM unnest(r.normalized_aliases) a WHERE a LIKE $2 || '%') THEN 75
              ELSE 50 END AS match_score
       FROM technology_identities i`)}
       WHERE ${platform ? "i.scope = 'public'" : "(i.scope = 'public' OR i.owner_org_id = $1)"}
         AND i.lifecycle_status <> 'merged'
         ${selectableSql}
       ORDER BY match_score DESC, r.normalized_name, i.id
       LIMIT $4`,
      [orgId, q, compact, safeLimit]
    )
    return rows.map(mapSearchMatch)
  }

  search(orgId: string, query: string, limit = 20, selectable = false): Promise<TechnologySearchMatch[]> {
    return this.searchWith(this.pool, orgId, query, limit, selectable)
  }

  searchPlatform(query: string, limit = 20): Promise<TechnologySearchMatch[]> {
    return this.searchWith(this.pool, '__platform__', query, limit, false, true)
  }

  async getPlatform(technologyId: string): Promise<{
    technology: TechnologyView
    resolution: { requestedId: string; canonicalTechnologyId: string; redirected: boolean; path: string[] }
  } | null> {
    const resolution = await this.resolveCanonicalId(technologyId)
    const technology = await this.platformViewById(this.pool, resolution.id)
    if (!technology) return null
    return {
      technology,
      resolution: {
        requestedId: technologyId,
        canonicalTechnologyId: resolution.id,
        redirected: resolution.id !== technologyId,
        path: resolution.path,
      },
    }
  }

  private async viewById(
    db: Queryable,
    orgId: string,
    technologyId: string,
    revision?: number,
    selectable = false
  ): Promise<TechnologyView | null> {
    const revisionJoin = revision === undefined
      ? selectable
        ? 'r.revision = i.current_revision'
        : "r.revision = CASE WHEN i.scope = 'public' THEN i.current_revision ELSE i.latest_revision END"
      : 'r.revision = $3'
    const params: unknown[] = [orgId, technologyId]
    if (revision !== undefined) params.push(revision)
    const { rows } = await db.query<TechnologyRow>(
      `${VIEW_SELECT.replace('r.revision = i.latest_revision', revisionJoin)}
       WHERE i.id = $2 AND (i.scope = 'public' OR i.owner_org_id = $1)
         ${revision === undefined ? '' : "AND (i.scope = 'org_private' OR w.status = 'approved')"}`,
      params
    )
    return rows[0] ? mapTechnology(rows[0]) : null
  }

  private async platformViewById(
    db: Queryable,
    technologyId: string,
    revision?: number,
  ): Promise<TechnologyView | null> {
    const params: unknown[] = ['__platform__', technologyId]
    const revisionJoin = revision === undefined ? 'r.revision = i.latest_revision' : 'r.revision = $3'
    if (revision !== undefined) params.push(revision)
    const { rows } = await db.query<TechnologyRow>(
      `${VIEW_SELECT.replace('r.revision = i.latest_revision', revisionJoin)}
       WHERE i.id = $2 AND i.scope = 'public'`,
      params,
    )
    return rows[0] ? mapTechnology(rows[0]) : null
  }

  async resolveCanonicalId(technologyId: string, db: Queryable = this.pool): Promise<{ id: string; path: string[] }> {
    const path = [technologyId]
    let current = technologyId
    for (let depth = 0; depth < 20; depth++) {
      const { rows } = await db.query<{ target_technology_id: string }>(
        'SELECT target_technology_id FROM technology_redirects WHERE source_technology_id = $1',
        [current]
      )
      const next = rows[0]?.target_technology_id
      if (!next) return { id: current, path }
      if (path.includes(next)) throw new TechnologyRepositoryError(500, 'redirect_cycle', 'Technology redirect cycle detected')
      path.push(next)
      current = next
    }
    throw new TechnologyRepositoryError(500, 'redirect_depth', 'Technology redirect chain is too deep')
  }

  async get(
    orgId: string,
    technologyId: string,
    revision?: number,
    options: { selectable?: boolean } = {}
  ): Promise<{
    technology: TechnologyView
    resolution: { requestedId: string; canonicalTechnologyId: string; redirected: boolean; path: string[] }
  } | null> {
    // A pinned revision resolves against its original identity for historical
    // reproducibility. Unpinned lookups follow permanent redirects.
    const resolution = await this.resolveCanonicalId(technologyId)
    const lookupId = revision === undefined ? resolution.id : technologyId
    const technology = await this.viewById(this.pool, orgId, lookupId, revision, options.selectable === true)
    if (!technology || (options.selectable && !isTechnologySelectableForOrg(technology))) return null
    return {
      technology,
      resolution: {
        requestedId: technologyId,
        canonicalTechnologyId: resolution.id,
        redirected: resolution.id !== technologyId,
        path: resolution.path,
      },
    }
  }

  async createPrivateDraft(orgId: string, actorUserId: string, input: CreateTechnologyDraftInput): Promise<TechnologyView> {
    const normalizedName = normalizeTechnologyTerm(input.name)
    if (normalizeTechnologyTerm(input.duplicateCheck.query) !== normalizedName || input.duplicateCheck.confirmedNoMatch !== true) {
      const matches = await this.duplicateMatchesWith(this.pool, orgId, input)
      throw new TechnologyRepositoryError(
        409, 'public_catalog_search_required',
        'Search the public catalog and confirm the result before creating a technology',
        { matches }
      )
    }

    const technologyId = id()
    await this.transaction(async (client) => {
      // Serializes same-name creations, closing the gap between duplicate
      // search and insert without imposing false uniqueness on legitimate
      // same-name technologies from different publishers/ecosystems.
      await this.lockDuplicateTerms(client, input)
      const matches = await this.duplicateMatchesWith(client, orgId, input)
      if (matches.length && !input.duplicateCheck.overrideReason?.trim()) {
        throw new TechnologyRepositoryError(
          409, 'probable_duplicate_requires_confirmation',
          'A probable catalog match must be selected or explicitly overridden',
          { matches }
        )
      }
      await client.query(
        `INSERT INTO technology_identities
           (id, scope, owner_org_id, lifecycle_status, latest_revision, created_by)
         VALUES ($1, 'org_private', $2, 'active', 1, $3)`,
        [technologyId, orgId, actorUserId]
      )
      await referenceTechnologyIconAssets(client, orgId, [input.iconLightPath, input.iconDarkPath])
      await insertRevision(client, technologyId, 1, input, actorUserId, 'draft')
      await audit(client, actorUserId, orgId, 'technology.draft_created', technologyId, 1, {
        duplicateQuery: input.duplicateCheck.query,
        duplicateOverrideReason: input.duplicateCheck.overrideReason ?? null,
        probableMatchIds: matches.map((match) => match.id),
        iconPaths: [...new Set([input.iconLightPath, input.iconDarkPath].filter(Boolean))],
      })
    })
    return (await this.viewById(this.pool, orgId, technologyId))!
  }

  async createPublicDraft(
    actorUserId: string,
    input: CreateTechnologyDraftInput,
    assetOwnerOrgId?: string,
  ): Promise<TechnologyView> {
    const normalizedName = normalizeTechnologyTerm(input.name)
    if (normalizeTechnologyTerm(input.duplicateCheck.query) !== normalizedName || input.duplicateCheck.confirmedNoMatch !== true) {
      const matches = await this.duplicateMatchesWith(this.pool, '__platform__', input, undefined, true)
      throw new TechnologyRepositoryError(
        409, 'public_catalog_search_required',
        'Search the public catalog and confirm the result before creating a public technology',
        { matches },
      )
    }

    const technologyId = id()
    await this.transaction(async (client) => {
      await this.lockDuplicateTerms(client, input)
      const matches = await this.duplicateMatchesWith(client, '__platform__', input, undefined, true)
      if (matches.length && !input.duplicateCheck.overrideReason?.trim()) {
        throw new TechnologyRepositoryError(
          409, 'probable_duplicate_requires_confirmation',
          'A probable public catalog match must be selected or explicitly overridden',
          { matches },
        )
      }
      await client.query(
        `INSERT INTO technology_identities
           (id, scope, owner_org_id, lifecycle_status, latest_revision, current_revision, created_by)
         VALUES ($1, 'public', NULL, 'active', 1, NULL, $2)`,
        [technologyId, actorUserId],
      )
      await referencePublicTechnologyIconAssets(client, assetOwnerOrgId, input)
      await insertRevision(client, technologyId, 1, input, actorUserId, 'draft')
      await audit(client, actorUserId, null, 'technology.platform_draft_created', technologyId, 1, {
        duplicateQuery: input.duplicateCheck.query,
        duplicateOverrideReason: input.duplicateCheck.overrideReason ?? null,
        probableMatchIds: matches.map((match) => match.id),
        iconPaths: [...new Set([input.iconLightPath, input.iconDarkPath].filter(Boolean))],
        assetOwnerOrgId: assetOwnerOrgId ?? null,
      })
    })
    return (await this.platformViewById(this.pool, technologyId))!
  }

  async createRevision(
    orgId: string,
    actorUserId: string,
    technologyId: string,
    input: CreateTechnologyRevisionInput
  ): Promise<TechnologyView> {
    const normalizedName = normalizeTechnologyTerm(input.name)
    if (normalizeTechnologyTerm(input.duplicateCheck.query) !== normalizedName || input.duplicateCheck.confirmedNoMatch !== true) {
      const matches = await this.duplicateMatchesWith(this.pool, orgId, input, technologyId)
      throw new TechnologyRepositoryError(
        409, 'public_catalog_search_required',
        'Search the public catalog and confirm the result before creating a technology revision',
        { matches }
      )
    }
    const revision = await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      assertPrivateOwned(identity, orgId)
      const { rows: current } = await client.query<{ status: TechnologyWorkflowStatus }>(
        `SELECT status FROM technology_revision_workflows WHERE technology_id = $1 AND revision = $2`,
        [technologyId, identity.latest_revision]
      )
      if (current[0]?.status === 'in_review') {
        throw new TechnologyRepositoryError(409, 'revision_in_review', 'Create a revision only after the review is decided')
      }
      await this.lockDuplicateTerms(client, input)
      const matches = await this.duplicateMatchesWith(client, orgId, input, technologyId)
      if (matches.length && !input.duplicateCheck.overrideReason?.trim()) {
        throw new TechnologyRepositoryError(
          409, 'probable_duplicate_requires_confirmation',
          'A probable catalog match in the revision name or aliases must be selected or explicitly overridden',
          { matches }
        )
      }
      const next = identity.latest_revision + 1
      await referenceTechnologyIconAssets(client, orgId, [input.iconLightPath, input.iconDarkPath])
      await insertRevision(client, technologyId, next, input, actorUserId, 'draft')
      await client.query(
        'UPDATE technology_identities SET latest_revision = $2, updated_at = now() WHERE id = $1',
        [technologyId, next]
      )
      await audit(client, actorUserId, orgId, 'technology.revision_created', technologyId, next, {
        duplicateQuery: input.duplicateCheck.query,
        duplicateOverrideReason: input.duplicateCheck.overrideReason ?? null,
        probableMatchIds: matches.map((match) => match.id),
        iconPaths: [...new Set([input.iconLightPath, input.iconDarkPath].filter(Boolean))],
      })
      return next
    })
    return (await this.viewById(this.pool, orgId, technologyId, revision))!
  }

  async createPublicRevision(
    actorUserId: string,
    technologyId: string,
    input: CreateTechnologyRevisionInput,
    assetOwnerOrgId?: string,
  ): Promise<TechnologyView> {
    const normalizedName = normalizeTechnologyTerm(input.name)
    if (normalizeTechnologyTerm(input.duplicateCheck.query) !== normalizedName || input.duplicateCheck.confirmedNoMatch !== true) {
      const matches = await this.duplicateMatchesWith(this.pool, '__platform__', input, technologyId, true)
      throw new TechnologyRepositoryError(
        409, 'public_catalog_search_required',
        'Search the public catalog and confirm the result before creating a public technology revision',
        { matches },
      )
    }
    const revision = await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      if (identity.scope !== 'public' || identity.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(404, 'technology_not_found', 'Public technology not found')
      }
      const { rows: current } = await client.query<{ status: TechnologyWorkflowStatus }>(
        `SELECT status FROM technology_revision_workflows WHERE technology_id = $1 AND revision = $2`,
        [technologyId, identity.latest_revision],
      )
      if (current[0]?.status === 'draft' || current[0]?.status === 'in_review') {
        throw new TechnologyRepositoryError(409, 'revision_pending', 'Finish the pending public revision before creating another')
      }
      await this.lockDuplicateTerms(client, input)
      const matches = await this.duplicateMatchesWith(client, '__platform__', input, technologyId, true)
      if (matches.length && !input.duplicateCheck.overrideReason?.trim()) {
        throw new TechnologyRepositoryError(
          409, 'probable_duplicate_requires_confirmation',
          'A probable public catalog match must be selected or explicitly overridden',
          { matches },
        )
      }
      const next = identity.latest_revision + 1
      await referencePublicTechnologyIconAssets(client, assetOwnerOrgId, input)
      await insertRevision(client, technologyId, next, input, actorUserId, 'draft')
      await client.query(
        'UPDATE technology_identities SET latest_revision = $2, updated_at = now() WHERE id = $1',
        [technologyId, next],
      )
      await audit(client, actorUserId, null, 'technology.platform_revision_created', technologyId, next, {
        duplicateQuery: input.duplicateCheck.query,
        duplicateOverrideReason: input.duplicateCheck.overrideReason ?? null,
        probableMatchIds: matches.map((match) => match.id),
        iconPaths: [...new Set([input.iconLightPath, input.iconDarkPath].filter(Boolean))],
        assetOwnerOrgId: assetOwnerOrgId ?? null,
      })
      return next
    })
    return (await this.platformViewById(this.pool, technologyId, revision))!
  }

  async approvePrivate(orgId: string, actorUserId: string, technologyId: string, revision: number): Promise<TechnologyView> {
    await this.transitionPrivate(orgId, actorUserId, technologyId, revision, ['draft'], 'approved', 'technology.private_approved')
    return (await this.viewById(this.pool, orgId, technologyId, revision))!
  }

  async decidePrivate(
    orgId: string,
    actorUserId: string,
    technologyId: string,
    revision: number,
    outcome: 'changes_requested' | 'rejected',
    reason: string,
  ): Promise<TechnologyView> {
    if (!reason.trim()) throw new TechnologyRepositoryError(400, 'reason_required', 'A review reason is required')
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      assertPrivateOwned(identity, orgId)
      if (revision !== identity.latest_revision) {
        throw new TechnologyRepositoryError(409, 'not_latest_revision', 'Only the latest revision may be reviewed')
      }
      const { rows } = await client.query<{ status: TechnologyWorkflowStatus; private_approved: boolean }>(
        `SELECT status, (private_approved_at IS NOT NULL) AS private_approved
         FROM technology_revision_workflows
         WHERE technology_id = $1 AND revision = $2 FOR UPDATE`,
        [technologyId, revision],
      )
      const workflow = rows[0]
      if (!workflow || workflow.status !== 'draft' || workflow.private_approved) {
        throw new TechnologyRepositoryError(409, 'not_private_review', 'Technology revision is not awaiting organization review')
      }
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [technologyId, revision, outcome, actorUserId, reason.trim()],
      )
      await audit(client, actorUserId, orgId, `technology.private_${outcome}`, technologyId, revision, {
        reason: reason.trim(),
      })
    })
    return (await this.viewById(this.pool, orgId, technologyId, revision))!
  }

  async submitPublic(orgId: string, actorUserId: string, technologyId: string, revision: number): Promise<TechnologyView> {
    await this.transitionPrivate(orgId, actorUserId, technologyId, revision, ['approved'], 'in_review', 'technology.public_submitted')
    return (await this.viewById(this.pool, orgId, technologyId, revision))!
  }

  async submitPlatformReview(actorUserId: string, technologyId: string, revision: number): Promise<TechnologyView> {
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      if (identity.scope !== 'public' || identity.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(404, 'technology_not_found', 'Public technology not found')
      }
      if (revision !== identity.latest_revision) {
        throw new TechnologyRepositoryError(409, 'not_latest_revision', 'Only the latest revision may be submitted')
      }
      const { rows } = await client.query<{ status: TechnologyWorkflowStatus }>(
        `SELECT status FROM technology_revision_workflows
         WHERE technology_id = $1 AND revision = $2 FOR UPDATE`,
        [technologyId, revision],
      )
      if (rows[0]?.status !== 'draft') {
        throw new TechnologyRepositoryError(409, 'invalid_workflow_transition', 'Only a public draft can be submitted for review')
      }
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = 'in_review', submitted_by = $3, submitted_at = now(),
             decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [technologyId, revision, actorUserId],
      )
      await audit(client, actorUserId, null, 'technology.platform_review_submitted', technologyId, revision)
    })
    return (await this.platformViewById(this.pool, technologyId, revision))!
  }

  private async transitionPrivate(
    orgId: string,
    actorUserId: string,
    technologyId: string,
    revision: number,
    from: TechnologyWorkflowStatus[],
    to: TechnologyWorkflowStatus,
    action: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      assertPrivateOwned(identity, orgId)
      if (revision !== identity.latest_revision) {
        throw new TechnologyRepositoryError(409, 'not_latest_revision', 'Only the latest revision may change workflow state')
      }
      const { rows } = await client.query<{ status: TechnologyWorkflowStatus }>(
        `SELECT status FROM technology_revision_workflows
         WHERE technology_id = $1 AND revision = $2 FOR UPDATE`,
        [technologyId, revision]
      )
      const current = rows[0]?.status
      if (!current) throw new TechnologyRepositoryError(404, 'revision_not_found', 'Technology revision not found')
      if (!from.includes(current)) {
        throw new TechnologyRepositoryError(409, 'invalid_workflow_transition', `Cannot transition ${current} to ${to}`)
      }
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = $3,
             submitted_by = CASE WHEN $3 = 'in_review' THEN $4 ELSE submitted_by END,
             submitted_at = CASE WHEN $3 = 'in_review' THEN now() ELSE submitted_at END,
             private_approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE private_approved_by END,
             private_approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE private_approved_at END,
             updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [technologyId, revision, to, actorUserId]
      )
      if (to === 'approved') {
        await client.query(
          'UPDATE technology_identities SET current_revision = $2, updated_at = now() WHERE id = $1',
          [technologyId, revision]
        )
      }
      await audit(client, actorUserId, orgId, action, technologyId, revision, { from: current, to })
    })
  }

  async setPolicy(orgId: string, actorUserId: string, policy: TechnologyPolicy): Promise<TechnologyPolicy> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO technology_org_policies (org_id, policy, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE
           SET policy = EXCLUDED.policy, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [orgId, policy, actorUserId]
      )
      await audit(client, actorUserId, orgId, 'technology.policy_changed', null, null, { policy })
    })
    return policy
  }

  async setOverride(
    orgId: string,
    actorUserId: string,
    technologyId: string,
    state: TechnologyOverrideState,
  ): Promise<{ canonicalTechnologyId: string }> {
    return this.transaction(async (client) => {
      const resolution = await this.resolveCanonicalId(technologyId, client)
      const { rows } = await client.query<{ scope: string }>(
        `SELECT scope FROM technology_identities WHERE id = $1 AND scope = 'public'`,
        [resolution.id]
      )
      if (!rows[0]) throw new TechnologyRepositoryError(404, 'public_technology_not_found', 'Public technology not found')
      await client.query(
        `INSERT INTO technology_org_overrides (org_id, technology_id, state, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, technology_id) DO UPDATE
           SET state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [orgId, resolution.id, state, actorUserId]
      )
      if (resolution.path.length > 1) {
        await client.query(
          `DELETE FROM technology_org_overrides
            WHERE org_id = $1 AND technology_id = ANY($2::text[]) AND technology_id <> $3`,
          [orgId, resolution.path, resolution.id],
        )
      }
      await audit(client, actorUserId, orgId, 'technology.override_set', resolution.id, null, {
        state,
        requestedTechnologyId: technologyId,
        resolutionPath: resolution.path,
      })
      return { canonicalTechnologyId: resolution.id }
    })
  }

  async clearOverride(
    orgId: string,
    actorUserId: string,
    technologyId: string,
  ): Promise<{ canonicalTechnologyId: string }> {
    return this.transaction(async (client) => {
      const resolution = await this.resolveCanonicalId(technologyId, client)
      await client.query(
        'DELETE FROM technology_org_overrides WHERE org_id = $1 AND technology_id = ANY($2::text[])',
        [orgId, resolution.path]
      )
      await audit(client, actorUserId, orgId, 'technology.override_cleared', resolution.id, null, {
        requestedTechnologyId: technologyId,
        resolutionPath: resolution.path,
      })
      return { canonicalTechnologyId: resolution.id }
    })
  }

  async publish(
    actorUserId: string,
    sourceTechnologyId: string,
    revision: number,
    requestedPublicId?: string
  ): Promise<{ sourceId: string; publicTechnologyId: string }> {
    let publicTechnologyId = requestedPublicId?.trim() || id()
    await this.transaction(async (client) => {
      const source = await identityForUpdate(client, sourceTechnologyId)
      if (!['org_private', 'public'].includes(source.scope) || source.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(409, 'not_publishable', 'Technology revision cannot be published')
      }
      if (revision !== source.latest_revision) throw new TechnologyRepositoryError(409, 'not_latest_revision', 'Only the latest revision can be published')
      const { rows } = await client.query<TechnologyRow & { normalized_aliases: string[]; search_document: string }>(
        `SELECT r.*, w.status AS workflow_status, w.submitted_by, w.decision_note,
                (w.private_approved_at IS NOT NULL) AS private_approved
         FROM technology_revisions r JOIN technology_revision_workflows w
           ON w.technology_id = r.technology_id AND w.revision = r.revision
         WHERE r.technology_id = $1 AND r.revision = $2 FOR UPDATE OF w`,
        [sourceTechnologyId, revision]
      )
      const row = rows[0]
      if (!row || row.workflow_status !== 'in_review') {
        throw new TechnologyRepositoryError(409, 'not_in_review', 'Technology revision is not in public review')
      }
      if (source.scope === 'public') {
        const reviewPolicy = await getPlatformSettingsState(client)
        if (
          reviewPolicy.independentTechnologyReviewEffective
          && (row.created_by === actorUserId || row.submitted_by === actorUserId)
        ) {
          throw new TechnologyRepositoryError(
            409,
            'reviewer_must_differ',
            'A different platform administrator must review this public technology',
          )
        }
        publicTechnologyId = sourceTechnologyId
        await client.query(
          `UPDATE technology_revision_workflows
           SET status = 'approved', decided_by = $3, decided_at = now(), decision_note = NULL, updated_at = now()
           WHERE technology_id = $1 AND revision = $2`,
          [sourceTechnologyId, revision, actorUserId],
        )
        await client.query(
          `UPDATE technology_identities
           SET current_revision = $2, updated_at = now()
           WHERE id = $1`,
          [sourceTechnologyId, revision],
        )
        await audit(client, actorUserId, null, 'technology.platform_public_approved', sourceTechnologyId, revision, {
          createdBy: row.created_by,
          submittedBy: row.submitted_by,
          independentReviewRequired: reviewPolicy.independentTechnologyReviewEffective,
        })
        return
      }
      await client.query(
        `INSERT INTO technology_identities
           (id, scope, owner_org_id, lifecycle_status, latest_revision, current_revision, created_by)
         VALUES ($1, 'public', NULL, 'active', 1, 1, $2)`,
        [publicTechnologyId, actorUserId]
      )
      await insertRevision(client, publicTechnologyId, 1, {
        name: row.name, description: row.description, websiteUrl: row.website_url,
        documentationUrl: row.documentation_url, aliases: row.aliases, category: row.category,
        iconLightPath: row.icon_light_path, iconDarkPath: row.icon_dark_path,
        publisher: row.publisher, ecosystem: row.ecosystem,
        recommendedShapeTypes: row.recommended_shape_types ?? [], defaultRole: row.default_role,
      }, actorUserId, 'approved')
      await client.query(
        `INSERT INTO technology_redirects (source_technology_id, target_technology_id, created_by)
         VALUES ($1, $2, $3)`,
        [sourceTechnologyId, publicTechnologyId, actorUserId]
      )
      await client.query(
        `UPDATE technology_identities
         SET lifecycle_status = 'merged', canonical_technology_id = $2, updated_at = now()
         WHERE id = $1`,
        [sourceTechnologyId, publicTechnologyId]
      )
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = 'approved', decided_by = $3, decided_at = now(), updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [sourceTechnologyId, revision, actorUserId]
      )
      await audit(client, actorUserId, source.owner_org_id, 'technology.public_published', sourceTechnologyId, revision, {
        publicTechnologyId,
      })
      await audit(client, actorUserId, null, 'technology.public_identity_created', publicTechnologyId, 1, {
        sourceTechnologyId,
      })
      await this.activateCanonicalForOrg(
        client,
        actorUserId,
        source.owner_org_id,
        publicTechnologyId,
        [sourceTechnologyId],
      )
    })
    return { sourceId: sourceTechnologyId, publicTechnologyId }
  }

  async merge(
    actorUserId: string,
    sourceTechnologyId: string,
    revision: number,
    targetTechnologyId: string,
    mergeInput: TechnologyMergeInput = {},
  ): Promise<{ canonicalTechnologyId: string; canonicalRevision: number }> {
    return this.transaction(async (client) => {
      const source = await identityForUpdate(client, sourceTechnologyId)
      if (source.scope !== 'org_private' || source.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(409, 'not_mergeable', 'Only an unmerged private technology can be merged')
      }
      if (revision !== source.latest_revision) throw new TechnologyRepositoryError(409, 'not_latest_revision', 'Only the latest revision can be merged')
      const resolvedTarget = await this.resolveCanonicalId(targetTechnologyId, client)
      const target = await identityForUpdate(client, resolvedTarget.id)
      if (target.scope !== 'public' || target.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(409, 'invalid_merge_target', 'Merge target must be a canonical public technology')
      }
      if (target.latest_revision !== target.current_revision) {
        throw new TechnologyRepositoryError(
          409,
          'merge_target_revision_pending',
          'Finish the pending public revision before merging content into this technology',
        )
      }
      const revisionFields = `r.name, r.description, r.website_url, r.documentation_url, r.aliases,
        r.category, r.icon_light_path, r.icon_dark_path, r.publisher, r.ecosystem,
        r.recommended_shape_types, r.default_role, w.status AS workflow_status`
      const [sourceRevisionResult, targetRevisionResult] = await Promise.all([
        client.query<TechnologyRow>(
          `SELECT ${revisionFields}
             FROM technology_revisions r
             JOIN technology_revision_workflows w
               ON w.technology_id = r.technology_id AND w.revision = r.revision
            WHERE r.technology_id = $1 AND r.revision = $2
            FOR UPDATE OF w`,
          [sourceTechnologyId, revision],
        ),
        client.query<TechnologyRow>(
          `SELECT ${revisionFields}
             FROM technology_revisions r
             JOIN technology_revision_workflows w
               ON w.technology_id = r.technology_id AND w.revision = r.revision
            WHERE r.technology_id = $1 AND r.revision = $2
            FOR UPDATE OF w`,
          [target.id, target.current_revision],
        ),
      ])
      const sourceRevision = sourceRevisionResult.rows[0]
      const targetRevision = targetRevisionResult.rows[0]
      if (sourceRevision?.workflow_status !== 'in_review') {
        throw new TechnologyRepositoryError(409, 'not_in_review', 'Technology revision is not in public review')
      }
      if (!targetRevision || targetRevision.workflow_status !== 'approved') {
        throw new TechnologyRepositoryError(409, 'invalid_merge_target', 'Merge target has no approved public revision')
      }

      const sourceInput = revisionInputFromRow(sourceRevision)
      const targetInput = revisionInputFromRow(targetRevision)
      const combinedAliases = [...new Set([...(targetInput.aliases ?? []), ...(sourceInput.aliases ?? [])])]
      const fieldDecisions: TechnologyMergeFieldDecisions = mergeInput.fieldDecisions
        ?? Object.fromEntries(TECHNOLOGY_MERGE_FIELDS.map((field) => [
          field,
          field === 'aliases' ? 'edit' : 'keep_public',
        ])) as TechnologyMergeFieldDecisions
      let mergedRevision: TechnologyRevisionInput = mergeInput.mergedRevision ?? {
        ...targetInput,
        aliases: combinedAliases,
      }
      // Decisions are authoritative; the client-supplied materialized value is
      // used only for fields explicitly marked Edit. This makes audit
      // provenance tamper-resistant at the HTTP boundary.
      for (const field of TECHNOLOGY_MERGE_FIELDS) {
        if (fieldDecisions[field] === 'edit') continue
        const selected = fieldDecisions[field] === 'take_proposal' ? sourceInput : targetInput
        mergedRevision = { ...mergedRevision, [field]: selected[field] } as TechnologyRevisionInput
      }
      // Publisher/ecosystem are not part of the comparator.
      mergedRevision = {
        ...mergedRevision,
        publisher: targetInput.publisher,
        ecosystem: targetInput.ecosystem,
      }
      const canonicalRevision = target.latest_revision + 1
      await insertRevision(client, target.id, canonicalRevision, mergedRevision, actorUserId, 'approved')
      await client.query(
        `UPDATE technology_identities
            SET latest_revision = $2, current_revision = $2, updated_at = now()
          WHERE id = $1`,
        [target.id, canonicalRevision],
      )
      await client.query(
        `INSERT INTO technology_redirects (source_technology_id, target_technology_id, created_by)
         VALUES ($1, $2, $3)`,
        [sourceTechnologyId, target.id, actorUserId]
      )
      await client.query(
        `UPDATE technology_identities SET lifecycle_status = 'merged', canonical_technology_id = $2, updated_at = now()
         WHERE id = $1`,
        [sourceTechnologyId, target.id]
      )
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = 'approved', decided_by = $3, decided_at = now(), updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [sourceTechnologyId, revision, actorUserId]
      )
      await audit(client, actorUserId, source.owner_org_id, 'technology.public_merged', sourceTechnologyId, revision, {
        canonicalTechnologyId: target.id,
        canonicalRevision,
        sourceRevision: revision,
        previousCanonicalRevision: target.current_revision,
        fieldDecisions,
      })
      await audit(client, actorUserId, null, 'technology.public_merge_revision_created', target.id, canonicalRevision, {
        sourceTechnologyId,
        sourceOrganizationId: source.owner_org_id,
        sourceRevision: revision,
        previousCanonicalRevision: target.current_revision,
        fieldDecisions,
      })
      await this.activateCanonicalForOrg(
        client,
        actorUserId,
        source.owner_org_id,
        target.id,
        [sourceTechnologyId, ...resolvedTarget.path.slice(0, -1)],
      )
      return { canonicalTechnologyId: target.id, canonicalRevision }
    })
  }

  /**
   * De-duplicates two organization-private identities without changing the
   * target's governed content. The source name and aliases remain searchable
   * through the redirect, while every new selection resolves to the canonical
   * target. Public targets are allowed; private targets must belong to the
   * same organization.
   */
  async mergePrivateIdentity(
    orgId: string,
    actorUserId: string,
    sourceTechnologyId: string,
    targetTechnologyId: string,
  ): Promise<{ canonicalTechnologyId: string }> {
    return this.mergeIdentity(actorUserId, sourceTechnologyId, targetTechnologyId, {
      sourceScope: 'org_private',
      orgId,
    })
  }

  /** Platform-only identity de-duplication for two public technologies. */
  async mergePublicIdentity(
    actorUserId: string,
    sourceTechnologyId: string,
    targetTechnologyId: string,
  ): Promise<{ canonicalTechnologyId: string }> {
    return this.mergeIdentity(actorUserId, sourceTechnologyId, targetTechnologyId, {
      sourceScope: 'public',
      orgId: null,
    })
  }

  private async mergeIdentity(
    actorUserId: string,
    sourceTechnologyId: string,
    targetTechnologyId: string,
    authorization: { sourceScope: 'org_private' | 'public'; orgId: string | null },
  ): Promise<{ canonicalTechnologyId: string }> {
    if (!sourceTechnologyId.trim() || !targetTechnologyId.trim()) {
      throw new TechnologyRepositoryError(400, 'merge_target_required', 'Source and target technologies are required')
    }
    if (sourceTechnologyId === targetTechnologyId) {
      throw new TechnologyRepositoryError(409, 'merge_same_technology', 'A technology cannot be merged into itself')
    }

    return this.transaction(async (client) => {
      // A pair-scoped transaction lock serializes A→B and B→A attempts before
      // row locks are acquired, preventing redirect cycles under concurrency.
      const pair = [sourceTechnologyId, targetTechnologyId].sort().join(':')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`technology-identity-merge:${pair}`])

      const resolvedTarget = await this.resolveCanonicalId(targetTechnologyId, client)
      if (resolvedTarget.id === sourceTechnologyId) {
        throw new TechnologyRepositoryError(409, 'merge_cycle', 'Technology merge would create a redirect cycle')
      }
      const source = await identityForUpdate(client, sourceTechnologyId)
      const target = await identityForUpdate(client, resolvedTarget.id)

      if (source.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(409, 'technology_merged', 'Merged technology cannot be merged again')
      }
      if (source.scope !== authorization.sourceScope) {
        throw new TechnologyRepositoryError(404, 'technology_not_found', 'Merge source is not available in this catalog')
      }
      if (authorization.sourceScope === 'org_private' && source.owner_org_id !== authorization.orgId) {
        throw new TechnologyRepositoryError(404, 'technology_not_found', 'Private technology not found in organization')
      }
      if (!['active', 'deprecated'].includes(target.lifecycle_status)) {
        throw new TechnologyRepositoryError(409, 'invalid_merge_target', 'Merge target must be an active canonical technology')
      }

      if (authorization.sourceScope === 'public') {
        if (target.scope !== 'public') {
          throw new TechnologyRepositoryError(409, 'invalid_merge_target', 'A public technology can merge only into another public technology')
        }
      } else if (target.scope === 'org_private' && target.owner_org_id !== authorization.orgId) {
        throw new TechnologyRepositoryError(409, 'invalid_merge_target', 'Private merge target must belong to the same organization')
      }

      await client.query(
        `INSERT INTO technology_redirects (source_technology_id, target_technology_id, created_by)
         VALUES ($1, $2, $3)`,
        [sourceTechnologyId, target.id, actorUserId],
      )
      await client.query(
        `UPDATE technology_identities
            SET lifecycle_status = 'merged', canonical_technology_id = $2, updated_at = now()
          WHERE id = $1`,
        [sourceTechnologyId, target.id],
      )

      if (source.scope === 'public') {
        // Preserve explicit organization decisions. An existing decision on
        // the canonical target wins; otherwise the legacy decision is moved.
        await client.query(
          `INSERT INTO technology_org_overrides (org_id, technology_id, state, updated_by)
           SELECT org_id, $2, state, $3
             FROM technology_org_overrides
            WHERE technology_id = $1
           ON CONFLICT (org_id, technology_id) DO NOTHING`,
          [sourceTechnologyId, target.id, actorUserId],
        )
        await client.query(
          'DELETE FROM technology_org_overrides WHERE technology_id = $1',
          [sourceTechnologyId],
        )
      } else if (target.scope === 'public') {
        await this.activateCanonicalForOrg(
          client,
          actorUserId,
          source.owner_org_id,
          target.id,
          [sourceTechnologyId, ...resolvedTarget.path.slice(0, -1)],
        )
      }

      await audit(
        client,
        actorUserId,
        source.owner_org_id,
        'technology.identity_merged',
        sourceTechnologyId,
        source.latest_revision,
        {
          canonicalTechnologyId: target.id,
          requestedTargetTechnologyId: targetTechnologyId,
          targetScope: target.scope,
          contentStrategy: 'keep_target',
          resolutionPath: resolvedTarget.path,
        },
      )
      return { canonicalTechnologyId: target.id }
    })
  }

  async reject(
    actorUserId: string,
    technologyId: string,
    revision: number,
    outcome: 'changes_requested' | 'rejected',
    reason: string
  ): Promise<void> {
    if (!reason.trim()) throw new TechnologyRepositoryError(400, 'reason_required', 'A rejection reason is required')
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      if (!['org_private', 'public'].includes(identity.scope) || identity.lifecycle_status === 'merged') {
        throw new TechnologyRepositoryError(409, 'not_reviewable', 'Technology is not reviewable')
      }
      const { rows } = await client.query<{
        status: TechnologyWorkflowStatus
        submitted_by: string | null
        created_by: string
      }>(
        `SELECT w.status, w.submitted_by, r.created_by
         FROM technology_revision_workflows w
         JOIN technology_revisions r ON r.technology_id = w.technology_id AND r.revision = w.revision
         WHERE w.technology_id = $1 AND w.revision = $2 FOR UPDATE OF w`,
        [technologyId, revision]
      )
      const workflow = rows[0]
      if (workflow?.status !== 'in_review') throw new TechnologyRepositoryError(409, 'not_in_review', 'Technology revision is not in public review')
      if (identity.scope === 'public') {
        const reviewPolicy = await getPlatformSettingsState(client)
        if (
          reviewPolicy.independentTechnologyReviewEffective
          && (workflow.created_by === actorUserId || workflow.submitted_by === actorUserId)
        ) {
          throw new TechnologyRepositoryError(
            409,
            'reviewer_must_differ',
            'A different platform administrator must review this public technology',
          )
        }
      }
      await client.query(
        `UPDATE technology_revision_workflows
         SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now()
         WHERE technology_id = $1 AND revision = $2`,
        [technologyId, revision, outcome, actorUserId, reason.trim()]
      )
      await audit(
        client,
        actorUserId,
        identity.owner_org_id,
        identity.scope === 'public' ? `technology.platform_${outcome}` : `technology.public_${outcome}`,
        technologyId,
        revision,
        { reason: reason.trim() },
      )
    })
  }

  async setLifecycle(actorUserId: string, technologyId: string, lifecycle: Exclude<TechnologyLifecycle, 'merged'>): Promise<void> {
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      if (identity.lifecycle_status === 'merged') throw new TechnologyRepositoryError(409, 'technology_merged', 'Merged technology lifecycle is fixed')
      await client.query(
        'UPDATE technology_identities SET lifecycle_status = $2, updated_at = now() WHERE id = $1',
        [technologyId, lifecycle]
      )
      await audit(client, actorUserId, identity.owner_org_id, 'technology.lifecycle_changed', technologyId, null, { lifecycle })
    })
  }

  async setPrivateLifecycle(
    orgId: string,
    actorUserId: string,
    technologyId: string,
    lifecycle: 'active' | 'retired',
  ): Promise<void> {
    await this.transaction(async (client) => {
      const identity = await identityForUpdate(client, technologyId)
      assertPrivateOwned(identity, orgId)
      await client.query(
        'UPDATE technology_identities SET lifecycle_status = $2, updated_at = now() WHERE id = $1',
        [technologyId, lifecycle],
      )
      await audit(client, actorUserId, orgId, 'technology.private_catalog_lifecycle_changed', technologyId, null, {
        lifecycle,
      })
    })
  }
}

/**
 * Shared read-only public-catalog search for Admin Technologies AI Assist.
 * It intentionally has no organization context and can never expose private
 * drafts, hidden workflow states, or mutation methods.
 */
export async function searchPublicTechnologies(
  pool: Pool,
  query: string,
  limit = 20
): Promise<TechnologySearchMatch[]> {
  const readerOrgId = '__public_catalog_reader__'
  const matches = await new TechnologyRepository(pool).search(readerOrgId, query, limit, true)
  return matches.filter((match) => match.scope === 'public')
}
