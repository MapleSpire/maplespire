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
import type { Pool } from 'pg'
import { pool } from './db.js'
import { appendAudit } from './auth/audit.js'
import { createDistributedRateLimiter } from './runtime/rateLimiter.js'

/**
 * Public read-only share links.
 *
 * SECURITY: the server never reads Automerge to serve a share. The client
 * materialises a self-contained snapshot (only the diagram/landscape it wants to
 * share) and POSTs it; we store and serve that opaque JSON verbatim. The token is
 * the access capability — the public GET has no auth, so tokens are unguessable
 * (128-bit). Disabling or revoking makes the public GET 404.
 *
 * The snapshot model above is canonical — the server NEVER live-queries the
 * model for a share, which is the safer architecture. On top of it:
 *   - `landscapeId`/`versionId`/`org_id` columns, so a share is attributable to
 *     a workspace (analytics/RBAC-adjacent bookkeeping only — resolution of the
 *     public GET never depends on them, it only ever reads the stored snapshot).
 *   - per-token rate limiting on the public GET, audited on first crossing.
 *   - an `app_sharelink` NOLOGIN Postgres role, GRANTed SELECT on `ro_*` +
 *     `shared_links`, reserved for a future "live" share variant that would run
 *     queries as that role under `SET LOCAL app.sharelink_scope_id`. Nothing
 *     queries as this role today.
 */

export type ShareMode = 'latest' | 'pinned'
export type ShareScope = 'diagram' | 'landscape'

/**
 * WHO may resolve the public GET (the access boundary added on top of the
 * unguessable token):
 *  - 'public' — anyone with the link, no sign-in.
 *  - 'org'    — only members of the share's workspace org (`orgId`).
 *  - 'domain' — only signed-in users whose email is on `allowedEmailDomain`.
 * Org/domain are only enforceable at AUTH stage 'on' (identity requires a
 * verified session); below that they fail CLOSED at the resolver.
 */
export type ShareAudience = 'public' | 'org' | 'domain'

/** Full record incl. the (potentially large) snapshot — used by the public GET. */
export interface ShareRecord {
  token: string
  mode: ShareMode
  scope: ShareScope
  diagramId: string | null
  limitToDiagram: boolean
  enabled: boolean
  checkpointId: string | null
  checkpointLabel: string | null
  heads: unknown
  snapshot: unknown
  viewCount: number
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  landscapeId: string | null
  versionId: string | null
  orgId: string | null
  audience: ShareAudience
  allowedEmailDomain: string | null
  /** Whether visitors may switch the viewer to the 3D board render. */
  allow3d: boolean
}

/**
 * The audience a brand-new link gets when the creator didn't pick one.
 * Org-restricted the moment identity can be enforced (AUTH stage 'on'), so a
 * fresh link is never public-by-accident and "Anyone" is always a deliberate
 * choice. Below stage 'on' identity can't be checked and an 'org' link would be
 * unopenable (the resolver fails closed), so it stays 'public' — this keeps
 * offline/local dev and stage off/dual sharing working.
 * Passed the stage explicitly to keep this module free of the auth/middleware
 * import (the route in index.ts supplies `authStage()`).
 */
export function defaultShareAudience(stage: 'off' | 'dual' | 'on'): ShareAudience {
  return stage === 'on' ? 'org' : 'public'
}

/** Normalize a user-entered email domain: strip a leading '@', lowercase, trim.
 * Empty / non-string → null (no restriction). */
export function normalizeEmailDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const d = raw.trim().toLowerCase().replace(/^@+/, '')
  return d || null
}

/** Lightweight row without the heavy `snapshot` column — used by the manage list. */
export type ShareMeta = Omit<ShareRecord, 'snapshot'>

const MAX_SNAPSHOT = 25_000_000 // ~25MB JSON; express.json limit is 50MB

// Shared-contract defaults (src/lib/automerge/workspace.ts DEFAULT_WORKSPACE_REF /
// server/src/rbac/docScope.ts WorkspaceKey) — a share row without workspace
// columns predates multi-workspace and is a default-workspace share BY
// CONSTRUCTION, so backfill and un-scoped creates both resolve here, never to
// null.
const DEFAULT_LANDSCAPE_ID = 'default'
const DEFAULT_VERSION_ID = 'current'

export function newToken(): string {
  // 16 bytes = 128 bits, base64url → ~22 url-safe chars, unguessable.
  return randomBytes(16).toString('base64url')
}

/**
 * Idempotent schema setup for the share-link surface: the workspace-scoping
 * columns + legacy backfill + the `app_sharelink` role. Called from every public
 * entry point below (createShare/getShare/listShares), same lazy-idempotent
 * pattern as readModel/schema.ts's `ensureReadModelSchema` — cheap
 * `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` statements, safe to re-run per call.
 * Memoized per-pool so the backfill UPDATE and role DO-block only ever run once
 * per process, not on every request.
 */
const schemaEnsured = new WeakSet<Pool>()
export async function ensureShareSchema(db: Pool): Promise<void> {
  if (schemaEnsured.has(db)) return
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS landscape_id TEXT`)
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS version_id TEXT`)
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS org_id TEXT`)
  // Audience gate. NOT NULL DEFAULT 'public' backfills every existing row to
  // public — no migration of tokens/URLs needed.
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'public'`)
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS allowed_email_domain TEXT`)
  // 3D board opt-out. Defaults TRUE (existing links gain the viewer's 3D toggle;
  // the render is the same data, just a different camera) — creators untick to
  // keep a link strictly 2D.
  await db.query(`ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS allow_3d BOOLEAN NOT NULL DEFAULT true`)
  // Legacy rows predate multi-workspace and were all created against the single
  // implicit (default, current) workspace — backfill is exact, not a guess.
  await db.query(
    `UPDATE shared_links SET landscape_id = $1 WHERE landscape_id IS NULL`,
    [DEFAULT_LANDSCAPE_ID]
  )
  await db.query(
    `UPDATE shared_links SET version_id = $1 WHERE version_id IS NULL`,
    [DEFAULT_VERSION_ID]
  )
  // org_id backfill: resolve via scopes when the version has been registered
  // there (see rbac/docScope.ts ensureScopesForExistingWorkspaces);
  // leave NULL otherwise rather than guessing, same posture as
  // readModel's resolveOrgId.
  await db.query(`
    UPDATE shared_links sl
    SET org_id = s.org_id
    FROM scopes s
    WHERE sl.org_id IS NULL
      AND s.kind = 'version'
      AND s.landscape_id = sl.landscape_id
      AND s.version_id = sl.version_id
      AND s.org_id IS NOT NULL
  `).catch((err) => {
    // `scopes` may not exist yet on a boot ordering where RBAC schema hasn't
    // run first — non-fatal, org_id just stays NULL until a later call succeeds.
    console.warn('[shares] org_id backfill skipped (scopes table not ready):', (err as Error).message)
  })

  await ensureSharelinkRole(db)
  schemaEnsured.add(db)
}

/**
 * Reserved for the future "live" share variant — NOLOGIN role, SELECT-only on the read
 * model + shared_links, scoped at query time via `SET LOCAL
 * app.sharelink_scope_id` derived from the validated token. Nothing queries as
 * this role today; the snapshot model above remains canonical. Role/grant DDL
 * can fail on a restricted/managed Postgres (no CREATEROLE) — that must never
 * block boot, so failures here are caught and logged once.
 */
async function ensureSharelinkRole(db: Pool): Promise<void> {
  try {
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sharelink') THEN
          CREATE ROLE app_sharelink NOLOGIN;
        END IF;
      END
      $$
    `)
    await db.query(`GRANT SELECT ON shared_links TO app_sharelink`)
    // ro_* tables are created by readModel/schema.ts's ensureReadModelSchema,
    // which may not have run yet on this boot path — GRANT on a not-yet-existing
    // table errors, so each is best-effort/individually caught rather than
    // aborting the whole grant set.
    for (const table of ['ro_objects', 'ro_connections', 'ro_groups', 'ro_diagrams']) {
      await db.query(`GRANT SELECT ON ${table} TO app_sharelink`).catch(() => {
        // table doesn't exist yet (READ_MODEL never enabled, or schema not
        // ensured yet on this boot) — the future live-share variant re-grants
        // once it actually needs the role, this is best-effort priming only.
      })
    }
  } catch (err) {
    console.warn('[shares] could not create/grant app_sharelink role (restricted DB?) — skipping; only needed by the future live-share variant:', (err as Error).message)
  }
}

/** Returns an error string, or null if the payload is acceptable to create.
 * Unknown extra fields (e.g. a client sending landscapeId/versionId before this
 * server understood them, or any future addition) are always tolerated — never
 * a 400 — per the shared contract. */
export function validateCreateShare(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'invalid body'
  const b = body as Record<string, unknown>
  if (b.mode !== undefined && b.mode !== 'latest' && b.mode !== 'pinned') return 'mode must be "latest" or "pinned"'
  if (b.scope !== undefined && b.scope !== 'diagram' && b.scope !== 'landscape') return 'scope must be "diagram" or "landscape"'
  if (b.diagramId !== undefined && b.diagramId !== null && typeof b.diagramId !== 'string') return 'diagramId must be a string'
  if (!b.snapshot || typeof b.snapshot !== 'object') return 'snapshot required'
  if (JSON.stringify(b.snapshot).length > MAX_SNAPSHOT) return 'snapshot too large'
  if (b.heads !== undefined && b.heads !== null && !Array.isArray(b.heads)) return 'heads must be an array'
  if (b.landscapeId !== undefined && b.landscapeId !== null && typeof b.landscapeId !== 'string') return 'landscapeId must be a string'
  if (b.versionId !== undefined && b.versionId !== null && typeof b.versionId !== 'string') return 'versionId must be a string'
  if (b.audience !== undefined && b.audience !== 'public' && b.audience !== 'org' && b.audience !== 'domain')
    return 'audience must be "public", "org" or "domain"'
  if (b.audience === 'domain' && !normalizeEmailDomain(b.allowedEmailDomain))
    return 'allowedEmailDomain required for a domain-restricted share'
  if (b.allow3d !== undefined && typeof b.allow3d !== 'boolean') return 'allow3d must be a boolean'
  return null
}

function mapRow(r: Record<string, unknown>): ShareRecord {
  return {
    token: r.token as string,
    mode: r.mode as ShareMode,
    scope: r.scope as ShareScope,
    diagramId: (r.diagram_id as string | null) ?? null,
    limitToDiagram: Boolean(r.limit_to_diagram),
    enabled: Boolean(r.enabled),
    checkpointId: (r.checkpoint_id as string | null) ?? null,
    checkpointLabel: (r.checkpoint_label as string | null) ?? null,
    heads: r.heads ?? null,
    snapshot: r.snapshot,
    viewCount: Number(r.view_count ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    landscapeId: (r.landscape_id as string | null) ?? null,
    versionId: (r.version_id as string | null) ?? null,
    orgId: (r.org_id as string | null) ?? null,
    audience: ((r.audience as string | null) ?? 'public') as ShareAudience,
    allowedEmailDomain: (r.allowed_email_domain as string | null) ?? null,
    allow3d: r.allow_3d === undefined || r.allow_3d === null ? true : Boolean(r.allow_3d),
  }
}

const META_COLUMNS = `token, mode, scope, diagram_id, limit_to_diagram, enabled,
  checkpoint_id, checkpoint_label, heads, view_count, created_at, updated_at, expires_at,
  landscape_id, version_id, org_id, audience, allowed_email_domain, allow_3d`

function mapMeta(r: Record<string, unknown>): ShareMeta {
  const { snapshot: _snapshot, ...rest } = mapRow({ ...r, snapshot: {} })
  return rest
}

export interface CreateShareInput {
  mode?: ShareMode
  scope?: ShareScope
  diagramId?: string | null
  limitToDiagram?: boolean
  checkpointId?: string | null
  checkpointLabel?: string | null
  heads?: unknown
  snapshot: unknown
  /** Optional per the shared contract — defaults to the default workspace. */
  landscapeId?: string | null
  versionId?: string | null
  audience?: ShareAudience
  allowedEmailDomain?: string | null
  allow3d?: boolean
  /** Not part of the request body — the route handler passes `req.auth?.userId`
   * when a session is present, else the audit event is stamped 'system' (share
   * creation is reachable without auth in stage off/dual, same as every other
   * unauthenticated-tolerant route). */
  actorUserId?: string
  /** The creator's pinned org (`req.auth?.orgId`), used as the fallback owner for
   * an org-restricted share when the workspace has no scope row yet — so 'org'
   * audience always has a concrete org to check membership against. */
  sessionOrgId?: string | null
}

/** Resolve a workspace's org_id once at share-creation time (nullable — a
 * brand-new workspace may not have a scope row registered yet). Never throws —
 * matches readModel/projectorService.ts's resolveOrgId posture: a lookup
 * failure just leaves org_id null rather than failing the share creation. */
async function resolveOrgId(db: Pool, landscapeId: string, versionId: string): Promise<string | null> {
  try {
    const { rows } = await db.query<{ org_id: string | null }>(
      `SELECT org_id FROM scopes WHERE kind = 'version' AND landscape_id = $1 AND version_id = $2 LIMIT 1`,
      [landscapeId, versionId]
    )
    return rows[0]?.org_id ?? null
  } catch (err) {
    console.warn('[shares] org_id lookup failed for workspace', { landscapeId, versionId }, err)
    return null
  }
}

export async function createShare(input: CreateShareInput): Promise<ShareRecord> {
  await ensureShareSchema(pool)
  const landscapeId = input.landscapeId || DEFAULT_LANDSCAPE_ID
  const versionId = input.versionId || DEFAULT_VERSION_ID
  // Prefer the workspace's registered org; fall back to the creator's session org
  // so an org-restricted share always has a concrete org to gate on.
  const orgId = (await resolveOrgId(pool, landscapeId, versionId)) ?? input.sessionOrgId ?? null
  const audience: ShareAudience = input.audience ?? 'public'
  const allowedEmailDomain = audience === 'domain' ? normalizeEmailDomain(input.allowedEmailDomain) : null
  // Retry on the (astronomically unlikely) token collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newToken()
    try {
      const { rows } = await pool.query(
        `INSERT INTO shared_links
           (token, mode, scope, diagram_id, limit_to_diagram, checkpoint_id, checkpoint_label, heads, snapshot,
            landscape_id, version_id, org_id, audience, allowed_email_domain, allow_3d)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING token, mode, scope, diagram_id, limit_to_diagram, enabled,
           checkpoint_id, checkpoint_label, heads, snapshot, view_count, created_at, updated_at, expires_at,
           landscape_id, version_id, org_id, audience, allowed_email_domain, allow_3d`,
        [
          token,
          input.mode ?? 'latest',
          input.scope ?? 'diagram',
          input.diagramId ?? null,
          input.limitToDiagram ?? true,
          input.checkpointId ?? null,
          input.checkpointLabel ?? null,
          input.heads != null ? JSON.stringify(input.heads) : null,
          JSON.stringify(input.snapshot),
          landscapeId,
          versionId,
          orgId,
          audience,
          allowedEmailDomain,
          input.allow3d ?? true,
        ],
      )
      const share = mapRow(rows[0])
      void appendAudit(pool, {
        orgId: share.orgId,
        actorUserId: input.actorUserId ?? 'system',
        action: 'share.created',
        targetKind: 'share',
        targetId: share.token,
        detail: { scope: share.scope, mode: share.mode, landscapeId: share.landscapeId, versionId: share.versionId },
      }).catch((err) => console.warn('[shares] audit "share.created" failed:', err))
      return share
    } catch (err) {
      if ((err as { code?: string }).code === '23505') continue // unique_violation
      throw err
    }
  }
  throw new Error('could not allocate a unique share token')
}

export async function getShare(token: string): Promise<ShareRecord | null> {
  await ensureShareSchema(pool)
  const { rows } = await pool.query(
    `SELECT token, mode, scope, diagram_id, limit_to_diagram, enabled,
       checkpoint_id, checkpoint_label, heads, snapshot, view_count, created_at, updated_at, expires_at,
       landscape_id, version_id, org_id, audience, allowed_email_domain, allow_3d
     FROM shared_links WHERE token = $1`,
    [token],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/** Light existence + workspace/org lookup for the manage gate — avoids loading
 * the (up to ~25MB) snapshot column just to authorize a patch/delete. Returns the
 * share's workspace (landscape/version) so the caller can run the RBAC write gate. */
export async function getShareGateInfo(
  token: string
): Promise<{ exists: boolean; orgId: string | null; landscapeId: string | null; versionId: string | null }> {
  await ensureShareSchema(pool)
  const { rows } = await pool.query<{ org_id: string | null; landscape_id: string | null; version_id: string | null }>(
    `SELECT org_id, landscape_id, version_id FROM shared_links WHERE token = $1`,
    [token]
  )
  const r = rows[0]
  return r
    ? { exists: true, orgId: r.org_id ?? null, landscapeId: r.landscape_id ?? null, versionId: r.version_id ?? null }
    : { exists: false, orgId: null, landscapeId: null, versionId: null }
}

export async function listShares(diagramId?: string): Promise<ShareMeta[]> {
  await ensureShareSchema(pool)
  const { rows } = diagramId
    ? await pool.query(`SELECT ${META_COLUMNS} FROM shared_links WHERE diagram_id = $1 ORDER BY updated_at DESC`, [diagramId])
    : await pool.query(`SELECT ${META_COLUMNS} FROM shared_links ORDER BY updated_at DESC LIMIT 200`)
  return rows.map(mapMeta)
}

export interface UpdateShareInput {
  enabled?: boolean
  limitToDiagram?: boolean
  mode?: ShareMode
  scope?: ShareScope
  checkpointId?: string | null
  checkpointLabel?: string | null
  heads?: unknown
  snapshot?: unknown
  audience?: ShareAudience
  allowedEmailDomain?: string | null
  allow3d?: boolean
  /** Fallback org owner (creator's session org) applied when switching a share to
   * 'org' audience and it has no org_id yet — mirrors createShare. */
  sessionOrgId?: string | null
}

export async function updateShare(token: string, patch: UpdateShareInput): Promise<ShareMeta | null> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  const add = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); vals.push(val) }

  if (patch.enabled !== undefined) add('enabled', patch.enabled)
  if (patch.limitToDiagram !== undefined) add('limit_to_diagram', patch.limitToDiagram)
  if (patch.mode !== undefined) add('mode', patch.mode)
  if (patch.scope !== undefined) add('scope', patch.scope)
  if (patch.checkpointId !== undefined) add('checkpoint_id', patch.checkpointId)
  if (patch.checkpointLabel !== undefined) add('checkpoint_label', patch.checkpointLabel)
  if (patch.heads !== undefined) add('heads', patch.heads != null ? JSON.stringify(patch.heads) : null)
  if (patch.snapshot !== undefined) add('snapshot', JSON.stringify(patch.snapshot))
  if (patch.audience !== undefined) {
    add('audience', patch.audience)
    // Keep the domain column consistent with the audience: only 'domain' keeps one.
    if (patch.audience !== 'domain' && patch.allowedEmailDomain === undefined) add('allowed_email_domain', null)
    // Switching to 'org' with no org yet → adopt the creator's session org so the
    // gate has something to check. COALESCE never overwrites an already-set org.
    if (patch.audience === 'org' && patch.sessionOrgId) {
      sets.push(`org_id = COALESCE(org_id, $${i++})`)
      vals.push(patch.sessionOrgId)
    }
  }
  if (patch.allowedEmailDomain !== undefined) add('allowed_email_domain', normalizeEmailDomain(patch.allowedEmailDomain))
  if (patch.allow3d !== undefined) add('allow_3d', patch.allow3d)
  if (sets.length === 0) {
    const { rows } = await pool.query(`SELECT ${META_COLUMNS} FROM shared_links WHERE token = $1`, [token])
    return rows[0] ? mapMeta(rows[0]) : null
  }
  sets.push('updated_at = NOW()')
  vals.push(token)
  const { rows } = await pool.query(
    `UPDATE shared_links SET ${sets.join(', ')} WHERE token = $${i} RETURNING ${META_COLUMNS}`,
    vals,
  )
  return rows[0] ? mapMeta(rows[0]) : null
}

export async function revokeShare(token: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM shared_links WHERE token = $1`, [token])
  return (rowCount ?? 0) > 0
}

export async function bumpViewCount(token: string): Promise<void> {
  await pool.query(`UPDATE shared_links SET view_count = view_count + 1 WHERE token = $1`, [token])
}

// =====================================================================
// Audience gate (who may RESOLVE the public GET) + manage gate (who may
// list/patch/delete a share). Both are inert for `audience='public'` /
// AUTH stage below 'on' — the resolver only calls the audience gate for a
// non-public share, and the route only calls the manage gate at stage 'on'.
// =====================================================================

export type ShareAudienceDecision = 'allow' | 'unauthenticated' | 'forbidden'

/** May the caller RESOLVE this (non-public) share? `claims` is the verified
 * session (`req.auth`) or undefined for an anonymous caller. Platform admins pass.
 * Fails CLOSED: an org share with no `orgId`, or a domain share with no domain,
 * denies everyone rather than leaking. */
export async function checkShareAudienceAccess(
  db: Pool,
  share: Pick<ShareRecord, 'audience' | 'orgId' | 'allowedEmailDomain'>,
  claims: { userId: string; isPlatformAdmin: boolean } | undefined
): Promise<ShareAudienceDecision> {
  if (share.audience === 'public') return 'allow'
  if (!claims) return 'unauthenticated'
  if (claims.isPlatformAdmin) return 'allow'

  if (share.audience === 'org') {
    if (!share.orgId) return 'forbidden'
    const { rows } = await db.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [share.orgId, claims.userId]
    )
    return rows.length > 0 ? 'allow' : 'forbidden'
  }

  if (share.audience === 'domain') {
    if (!share.allowedEmailDomain) return 'forbidden'
    const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [claims.userId])
    const email = (rows[0]?.email ?? '').toLowerCase()
    const at = email.lastIndexOf('@')
    const domain = at >= 0 ? email.slice(at + 1) : ''
    return domain !== '' && domain === share.allowedEmailDomain ? 'allow' : 'forbidden'
  }

  return 'forbidden'
}

// NOTE: MANAGING a share (create/patch/delete) is gated by RBAC WRITE access to the
// share's workspace — see index.ts's requireVersionWrite gate + getShareGateInfo. A
// bare org-membership check would let a View-only member publish/revoke links, so
// there is deliberately no org-only manage helper here.

// =====================================================================
// Per-token rate limiting on the public GET (rate limiting with backoff +
// audit on threshold for share resolution).
// =====================================================================

function shareRateLimitPerMin(): number {
  const n = Number(process.env.SHARE_RATE_LIMIT_PER_MIN)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120
}

const RATE_WINDOW_MS = 60_000
const shareRateLimiter = createDistributedRateLimiter({ maxMemoryKeys: 10_000 })

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the current window rolls over — for the `Retry-After` header. */
  retryAfterS: number
}

/**
 * Check + record one GET against `token`'s per-minute window. Rolls the window
 * over (resets the count) once `RATE_WINDOW_MS` has elapsed since it opened.
 * On the FIRST request that crosses the limit within a window, fires (fire-
 * and-forget) an audit row — never blocks the caller on the audit write, and
 * never re-audits the same window on subsequent over-limit requests.
 */
export async function checkShareRateLimit(token: string, orgId: string | null): Promise<RateLimitResult> {
  const limit = shareRateLimitPerMin()
  const decision = await shareRateLimiter.consume({
    namespace: 'share_public',
    identity: token,
    limit,
    windowMs: RATE_WINDOW_MS,
  })

  if (decision.justExceeded) {
    void appendAudit(pool, {
      orgId,
      actorUserId: 'system',
      action: 'share.rate_limited',
      targetKind: 'share',
      targetId: token,
      detail: { limitPerMin: limit },
    }).catch((err) => console.warn('[shares] audit "share.rate_limited" failed:', err))
  }
  return {
    allowed: decision.allowed,
    retryAfterS: decision.allowed ? 0 : decision.retryAfterSeconds,
  }
}

/** Test-only: clear all in-memory rate-limit state between test cases. */
export function _resetRateLimitStateForTests(): void {
  shareRateLimiter.resetMemoryForTests()
}
