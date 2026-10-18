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
import type { Express, Request, Response } from 'express'
import type { Pool } from 'pg'
import { pool } from '../db.js'
import { appendAudit } from './audit.js'
import { explainAccess } from '../rbac/access.js'
import { liveConnectionCount } from './wsAuth.js'
import { getPlatformSettingsState, updatePlatformSettings } from '../platform/settings.js'
import {
  signSession,
  verifySession,
  setSessionCookie,
  setNamedCookie,
  clearNamedCookie,
  readSessionCookie,
  readNamedCookie,
  adminStashCookieName,
} from './tokens.js'

/**
 * Platform Admin console REST endpoints.
 *
 * EVERY route here re-checks `users.is_platform_admin` FRESH from the DB on
 * every call — `req.auth.isPlatformAdmin` is signed by us and therefore
 * trustworthy at the moment of issuance, but a platform admin can be demoted
 * mid-session (PATCH .../platform-admin) and that demotion must take effect
 * immediately, not merely once the token expires or the org's epoch bumps
 * (platform-admin status isn't epoch-scoped — it's not an org membership).
 * Trusting only the cookie here would let a just-revoked operator keep using
 * god-mode endpoints for up to the session's remaining lifetime.
 *
 * Pagination/validation/audit conventions mirror `rbac/orgRoutes.ts` exactly
 * (keyset `?after=`, `?limit=` capped at 100, `randomBytes` ids, `fail()`
 * wrapping raw driver errors) — duplicated rather than imported so this file
 * does not depend on another route module's internals.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const IMPERSONATION_MAX_AGE_S = 3600

function parseLimit(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

function paramStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

function fail(res: Response, context: string, err: unknown, status = 500): void {
  console.error(`[platformRoutes] ${context} failed:`, err)
  res.status(status).json({ error: context })
}

const SLUG_RE = /^[a-z0-9-]{2,40}$/

/**
 * Fresh-from-DB platform-admin re-check — the ONE authorization gate every
 * route in this file goes through. Never trusts `req.auth.isPlatformAdmin`
 * alone (see file header). Returns the caller's userId on success, or null
 * after having already written the 401/403 response.
 */
async function requirePlatformAdmin(req: Request, res: Response): Promise<{ userId: string } | null> {
  const auth = req.auth
  if (!auth) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  try {
    const { rows } = await pool.query<{ is_platform_admin: boolean; status: string }>(
      'SELECT is_platform_admin, status FROM users WHERE id = $1',
      [auth.userId]
    )
    if (rows.length === 0 || !rows[0].is_platform_admin || rows[0].status !== 'active') {
      res.status(403).json({ error: 'Platform admin access required' })
      return null
    }
  } catch (err) {
    fail(res, 'Failed to verify platform admin access', err)
    return null
  }
  return { userId: auth.userId }
}

export function registerPlatformRoutes(app: Express): void {
  // -------------------------------------------------------------------
  // GET /api/platform/overview
  // -------------------------------------------------------------------
  app.get('/api/platform/overview', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    try {
      const [orgsRes, usersRes, landscapesRes, versionsRes, activeImpRes] = await Promise.all([
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs'),
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users'),
        pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM scopes WHERE kind = 'landscape' AND deleted_at IS NULL`
        ),
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM versions'),
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM impersonations WHERE ended_at IS NULL'),
      ])

      res.json({
        orgs: Number(orgsRes.rows[0].n),
        users: Number(usersRes.rows[0].n),
        landscapes: Number(landscapesRes.rows[0].n),
        versions: Number(versionsRes.rows[0].n),
        liveConnections: liveConnectionCount(),
        activeImpersonations: Number(activeImpRes.rows[0].n),
      })
    } catch (err) {
      fail(res, 'Failed to load platform overview', err)
    }
  })

  // -------------------------------------------------------------------
  // Platform settings — global, operator-owned and audit logged.
  // -------------------------------------------------------------------
  app.get('/api/platform/settings', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    try {
      res.json(await getPlatformSettingsState(pool))
    } catch (err) {
      fail(res, 'Failed to load platform settings', err)
    }
  })

  app.patch('/api/platform/settings', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid-platform-settings' })
      return
    }
    const keys = Object.keys(body)
    if (
      keys.length !== 1
      || keys[0] !== 'requireIndependentTechnologyReview'
      || typeof body.requireIndependentTechnologyReview !== 'boolean'
    ) {
      res.status(400).json({ error: 'invalid-platform-settings' })
      return
    }
    try {
      const before = await getPlatformSettingsState(pool)
      await updatePlatformSettings(pool, auth.userId, {
        requireIndependentTechnologyReview: body.requireIndependentTechnologyReview,
      })
      const after = await getPlatformSettingsState(pool)
      await appendAudit(pool, {
        actorUserId: auth.userId,
        action: 'platform.settings-updated',
        targetKind: 'platform-settings',
        targetId: 'global',
        detail: {
          changed: 'requireIndependentTechnologyReview',
          previous: before.requireIndependentTechnologyReview,
          current: after.requireIndependentTechnologyReview,
          effective: after.independentTechnologyReviewEffective,
          activePlatformAdminCount: after.activePlatformAdminCount,
        },
      })
      res.json(after)
    } catch (err) {
      fail(res, 'Failed to update platform settings', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/platform/orgs?q=&after=&limit=
  // -------------------------------------------------------------------
  app.get('/api/platform/orgs', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null

    try {
      const params: unknown[] = []
      const where: string[] = []
      if (after) {
        params.push(after)
        where.push(`o.id > $${params.length}`)
      }
      if (q) {
        params.push(`%${q.toLowerCase()}%`)
        where.push(`(lower(o.name) LIKE $${params.length} OR lower(o.slug) LIKE $${params.length})`)
      }
      params.push(limit + 1)

      const { rows } = await pool.query<{
        id: string
        name: string
        slug: string
        status: string
        created_at: string
        member_count: string
      }>(
        `SELECT o.id, o.name, o.slug, o.status, o.created_at, count(om.user_id)::text AS member_count
         FROM orgs o
         LEFT JOIN org_members om ON om.org_id = o.id
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY o.id, o.name, o.slug, o.status, o.created_at
         ORDER BY o.id
         LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].id : null

      res.json({
        orgs: page.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status,
          memberCount: Number(r.member_count),
          createdAt: r.created_at,
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load orgs', err)
    }
  })

  // -------------------------------------------------------------------
  // POST /api/platform/orgs { name, slug }
  // -------------------------------------------------------------------
  app.post('/api/platform/orgs', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return

    const { name, slug } = (req.body ?? {}) as { name?: unknown; slug?: unknown }
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      res.status(400).json({ error: 'A non-empty org name (<=200 chars) is required' })
      return
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'slug must match [a-z0-9-]{2,40}' })
      return
    }

    try {
      const { rows: existing } = await pool.query('SELECT 1 FROM orgs WHERE slug = $1', [slug])
      if (existing.length > 0) {
        res.status(409).json({ error: 'slug-taken' })
        return
      }

      const id = newId()
      await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, name.trim(), slug])

      await appendAudit(pool, {
        orgId: id,
        actorUserId: auth.userId,
        action: 'platform.org-created',
        targetKind: 'org',
        targetId: id,
        detail: { name: name.trim(), slug },
      })

      res.status(201).json({ id, name: name.trim(), slug, status: 'active', memberCount: 0, createdAt: new Date().toISOString() })
    } catch (err) {
      // A racing duplicate-slug insert lands here as a unique-violation — the
      // pre-check above handles the common case, this is the concurrent-race
      // fallback so it still surfaces as 409, not 500.
      const pgErr = err as { code?: string }
      if (pgErr?.code === '23505') {
        res.status(409).json({ error: 'slug-taken' })
        return
      }
      fail(res, 'Failed to create org', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/platform/orgs/:orgId  { status: 'active' | 'suspended' }
  // -------------------------------------------------------------------
  app.patch('/api/platform/orgs/:orgId', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)

    const { status } = (req.body ?? {}) as { status?: unknown }
    if (status !== 'active' && status !== 'suspended') {
      res.status(400).json({ error: "status must be 'active' or 'suspended'" })
      return
    }

    try {
      const { rows: existing } = await pool.query<{ status: string }>('SELECT status FROM orgs WHERE id = $1', [orgId])
      if (existing.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }

      await pool.query('UPDATE orgs SET status = $2 WHERE id = $1', [orgId, status])
      // Bump the org's auth_epoch (reusing the same SQL function the RBAC
      // triggers call — see auth/wsAuth.ts's ensureEpochTriggers) so every
      // live session/socket for this org is invalidated on the next check,
      // regardless of direction (suspend OR unsuspend re-syncs epoch-pinned
      // clients either way).
      await pool.query('SELECT bump_auth_epoch($1)', [orgId])

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: status === 'suspended' ? 'platform.org-suspended' : 'platform.org-unsuspended',
        targetKind: 'org',
        targetId: orgId,
        detail: { from: existing[0].status, to: status },
      })

      res.json({ id: orgId, status })
    } catch (err) {
      fail(res, 'Failed to update org status', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/teams/:teamId lives in
  // rbac/orgRoutes.ts — not duplicated here.
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // GET /api/platform/users?q=&after=&limit=
  // -------------------------------------------------------------------
  app.get('/api/platform/users', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null

    try {
      const params: unknown[] = []
      const where: string[] = []
      if (after) {
        params.push(after)
        where.push(`u.id > $${params.length}`)
      }
      if (q) {
        params.push(`%${q.toLowerCase()}%`)
        where.push(`(lower(u.email) LIKE $${params.length} OR lower(coalesce(u.name, '')) LIKE $${params.length})`)
      }
      params.push(limit + 1)

      const { rows } = await pool.query<{
        id: string
        email: string
        name: string | null
        status: string
        is_platform_admin: boolean
      }>(
        `SELECT u.id, u.email, u.name, u.status, u.is_platform_admin
         FROM users u
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY u.id
         LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].id : null

      const userIds = page.map((r) => r.id)
      const orgsByUser = new Map<string, Array<{ orgId: string; role: string; name: string | null; slug: string | null }>>()
      if (userIds.length > 0) {
        // Join the org NAME/slug — the console renders memberships for a human;
        // ids alone read as noise. LEFT JOIN keeps a membership visible even if
        // its org row vanished (dangling dev data must not hide the user).
        const { rows: memberRows } = await pool.query<{
          user_id: string
          org_id: string
          role: string
          name: string | null
          slug: string | null
        }>(
          `SELECT m.user_id, m.org_id, m.role, o.name, o.slug
           FROM org_members m
           LEFT JOIN orgs o ON o.id = m.org_id
           WHERE m.user_id = ANY($1::text[])`,
          [userIds]
        )
        for (const r of memberRows) {
          const list = orgsByUser.get(r.user_id) ?? []
          list.push({ orgId: r.org_id, role: r.role, name: r.name, slug: r.slug })
          orgsByUser.set(r.user_id, list)
        }
      }

      res.json({
        users: page.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          status: r.status,
          isPlatformAdmin: r.is_platform_admin,
          orgs: orgsByUser.get(r.id) ?? [],
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load users', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/platform/users/:userId  { status: 'active' | 'deactivated' }
  // Bumps the epoch of every org the user belongs to (their live
  // sessions/sockets in EVERY org must drop, not just one).
  // -------------------------------------------------------------------
  app.patch('/api/platform/users/:userId', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const targetUserId = paramStr(req.params.userId)

    const { status } = (req.body ?? {}) as { status?: unknown }
    if (status !== 'active' && status !== 'deactivated') {
      res.status(400).json({ error: "status must be 'active' or 'deactivated'" })
      return
    }

    try {
      const { rows: existing } = await pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [targetUserId])
      if (existing.length === 0) {
        res.status(404).json({ error: 'User not found' })
        return
      }

      await pool.query('UPDATE users SET status = $2 WHERE id = $1', [targetUserId, status])

      const { rows: orgRows } = await pool.query<{ org_id: string }>(
        'SELECT org_id FROM org_members WHERE user_id = $1',
        [targetUserId]
      )
      for (const r of orgRows) {
        await pool.query('SELECT bump_auth_epoch($1)', [r.org_id])
      }

      await appendAudit(pool, {
        orgId: null,
        actorUserId: auth.userId,
        action: status === 'deactivated' ? 'platform.user-deactivated' : 'platform.user-reactivated',
        targetKind: 'user',
        targetId: targetUserId,
        detail: { from: existing[0].status, to: status },
      })

      res.json({ id: targetUserId, status })
    } catch (err) {
      fail(res, 'Failed to update user status', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/platform/users/:userId/platform-admin  { grant: boolean }
  // Last-platform-admin protection enforced in SQL (FOR UPDATE lock over
  // every platform-admin row, mirroring orgRoutes.ts's last-org-admin guard).
  // -------------------------------------------------------------------
  app.patch('/api/platform/users/:userId/platform-admin', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const targetUserId = paramStr(req.params.userId)

    const { grant } = (req.body ?? {}) as { grant?: unknown }
    if (typeof grant !== 'boolean') {
      res.status(400).json({ error: 'grant must be a boolean' })
      return
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: adminRows } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE is_platform_admin = true FOR UPDATE`
      )

      const { rows: targetRows } = await client.query<{ is_platform_admin: boolean }>(
        'SELECT is_platform_admin FROM users WHERE id = $1',
        [targetUserId]
      )
      if (targetRows.length === 0) {
        await client.query('ROLLBACK')
        res.status(404).json({ error: 'User not found' })
        return
      }

      const targetIsOnlyAdmin =
        targetRows[0].is_platform_admin && adminRows.length === 1 && adminRows[0].id === targetUserId
      if (!grant && targetIsOnlyAdmin) {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'last-platform-admin' })
        return
      }

      await client.query('UPDATE users SET is_platform_admin = $2 WHERE id = $1', [targetUserId, grant])
      await client.query('COMMIT')

      await appendAudit(pool, {
        orgId: null,
        actorUserId: auth.userId,
        action: grant ? 'platform.admin-granted' : 'platform.admin-revoked',
        targetKind: 'user',
        targetId: targetUserId,
      })

      res.json({ id: targetUserId, isPlatformAdmin: grant })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fail(res, 'Failed to update platform-admin flag', err)
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------
  // POST /api/platform/impersonate  { userId }
  // -------------------------------------------------------------------
  app.post('/api/platform/impersonate', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return

    const { userId: targetUserId } = (req.body ?? {}) as { userId?: unknown }
    if (typeof targetUserId !== 'string' || !targetUserId) {
      res.status(400).json({ error: 'userId is required' })
      return
    }

    try {
      const { rows: targetRows } = await pool.query<{ id: string; email: string; status: string }>(
        'SELECT id, email, status FROM users WHERE id = $1',
        [targetUserId]
      )
      if (targetRows.length === 0) {
        res.status(404).json({ error: 'Target user not found' })
        return
      }
      if (targetRows[0].status !== 'active') {
        res.status(400).json({ error: 'target-not-active' })
        return
      }

      const { rows: membershipRows } = await pool.query<{ org_id: string }>(
        'SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY org_id LIMIT 1',
        [targetUserId]
      )
      const targetOrgId = membershipRows[0]?.org_id ?? null

      let epoch = 1
      if (targetOrgId) {
        const { rows: epochRows } = await pool.query<{ epoch: number | string }>(
          'SELECT epoch FROM auth_epochs WHERE org_id = $1',
          [targetOrgId]
        )
        epoch = epochRows[0] ? Number(epochRows[0].epoch) : 1
      }

      // Stash the CALLER's current session BEFORE overwriting the cookie —
      // if the caller's own cookie is somehow missing/invalid at this point
      // (shouldn't happen, requirePlatformAdmin already verified req.auth),
      // fall back to minting a fresh non-impersonation session for them so
      // exit still has something valid to restore.
      const currentToken = readSessionCookie(req)
      const stashToken =
        currentToken ??
        (await signSession({ userId: auth.userId, orgId: req.auth!.orgId, isPlatformAdmin: true, epoch: req.auth!.epoch }))
      setNamedCookie(res, adminStashCookieName(), stashToken, IMPERSONATION_MAX_AGE_S)

      // isPlatformAdmin is ALWAYS false during impersonation — the "read-only
      // WYSIWYG debugging" contract means the impersonated view must
      // behave exactly like the target's own session, never elevated.
      const impSession = await signSession(
        {
          userId: targetUserId,
          orgId: targetOrgId,
          isPlatformAdmin: false,
          epoch,
          imp: { by: auth.userId },
        },
        IMPERSONATION_MAX_AGE_S
      )
      setSessionCookie(res, impSession)

      const impersonationId = newId()
      await pool.query(
        `INSERT INTO impersonations (id, admin_user_id, target_user_id) VALUES ($1, $2, $3)`,
        [impersonationId, auth.userId, targetUserId]
      )

      await appendAudit(pool, {
        orgId: targetOrgId,
        actorUserId: targetUserId,
        impersonatorUserId: auth.userId,
        action: 'impersonation.started',
        targetKind: 'user',
        targetId: targetUserId,
        detail: { impersonationId },
      })

      res.json({ target: { id: targetRows[0].id, email: targetRows[0].email } })
    } catch (err) {
      fail(res, 'Failed to start impersonation', err)
    }
  })

  // -------------------------------------------------------------------
  // POST /api/auth/impersonate/exit — restore the stashed admin
  // session. Requires an active imp session + the stash cookie.
  // -------------------------------------------------------------------
  app.post('/api/auth/impersonate/exit', async (req, res) => {
    const auth = req.auth
    if (!auth || !auth.imp) {
      res.status(400).json({ error: 'not-impersonating' })
      return
    }

    const stashToken = readNamedCookie(req, adminStashCookieName())
    if (!stashToken) {
      res.status(400).json({ error: 'no-stashed-session' })
      return
    }
    const stashedClaims = await verifySession(stashToken)
    if (!stashedClaims) {
      res.status(400).json({ error: 'stashed-session-invalid' })
      return
    }

    try {
      setSessionCookie(res, stashToken)
      clearNamedCookie(res, adminStashCookieName())

      await pool.query(
        `UPDATE impersonations SET ended_at = now()
         WHERE admin_user_id = $1 AND target_user_id = $2 AND ended_at IS NULL`,
        [auth.imp.by, auth.userId]
      )

      await appendAudit(pool, {
        orgId: stashedClaims.orgId,
        actorUserId: auth.userId,
        impersonatorUserId: auth.imp.by,
        action: 'impersonation.ended',
        targetKind: 'user',
        targetId: auth.userId,
      })

      res.json({ success: true })
    } catch (err) {
      fail(res, 'Failed to exit impersonation', err)
    }
  })

  // -------------------------------------------------------------------
  // DELETE /api/platform/impersonations/:id — force-end any row
  // (platform admin, no active imp session required). This does NOT close the
  // impersonated connection's live socket or bump an epoch: the impersonation session itself still expires within IMPERSONATION_MAX_AGE_S
  // regardless, bounding the blast radius of a force-stop that doesn't also
  // kill a live socket immediately.
  // -------------------------------------------------------------------
  app.delete('/api/platform/impersonations/:id', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const id = paramStr(req.params.id)

    try {
      const { rows } = await pool.query<{ admin_user_id: string; target_user_id: string; ended_at: string | null }>(
        'SELECT admin_user_id, target_user_id, ended_at FROM impersonations WHERE id = $1',
        [id]
      )
      if (rows.length === 0) {
        res.status(404).json({ error: 'Impersonation not found' })
        return
      }
      if (rows[0].ended_at !== null) {
        res.status(409).json({ error: 'already-ended' })
        return
      }

      await pool.query('UPDATE impersonations SET ended_at = now() WHERE id = $1', [id])

      await appendAudit(pool, {
        orgId: null,
        actorUserId: rows[0].target_user_id,
        impersonatorUserId: rows[0].admin_user_id,
        action: 'impersonation.force-ended',
        targetKind: 'impersonation',
        targetId: id,
        detail: { forcedBy: auth.userId },
      })

      res.status(204).end()
    } catch (err) {
      fail(res, 'Failed to force-end impersonation', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/platform/impersonations?active=1
  // -------------------------------------------------------------------
  app.get('/api/platform/impersonations', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const activeOnly = req.query.active === '1' || req.query.active === 'true'
    const limit = parseLimit(req.query.limit)

    try {
      const { rows } = await pool.query<{
        id: string
        admin_user_id: string
        admin_email: string
        target_user_id: string
        target_email: string
        started_at: string
        ended_at: string | null
      }>(
        `SELECT i.id, i.admin_user_id, au.email AS admin_email, i.target_user_id, tu.email AS target_email,
                i.started_at, i.ended_at
         FROM impersonations i
         LEFT JOIN users au ON au.id = i.admin_user_id
         LEFT JOIN users tu ON tu.id = i.target_user_id
         ${activeOnly ? 'WHERE i.ended_at IS NULL' : ''}
         ORDER BY i.started_at DESC
         LIMIT $1`,
        [limit]
      )

      res.json({
        impersonations: rows.map((r) => ({
          id: r.id,
          adminUserId: r.admin_user_id,
          adminEmail: r.admin_email,
          targetUserId: r.target_user_id,
          targetEmail: r.target_email,
          startedAt: r.started_at,
          endedAt: r.ended_at,
        })),
      })
    } catch (err) {
      fail(res, 'Failed to load impersonations', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/platform/access-debug?userId=&scopeId=&resourceType=*
  // Cross-org — deliberately NO org-membership requirement (unlike
  // /api/orgs/:orgId/access/preview), since a platform admin debugging
  // access may not themselves belong to the target's org.
  // -------------------------------------------------------------------
  app.get('/api/platform/access-debug', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const userId = typeof req.query.userId === 'string' ? req.query.userId : null
    const scopeId = typeof req.query.scopeId === 'string' ? req.query.scopeId : null
    const resourceType = typeof req.query.resourceType === 'string' && req.query.resourceType ? req.query.resourceType : '*'

    if (!userId || !scopeId) {
      res.status(400).json({ error: 'userId and scopeId are required' })
      return
    }

    try {
      const [{ rows: userRows }, { rows: scopeRows }] = await Promise.all([
        pool.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = $1', [userId]),
        pool.query(
          `SELECT id, org_id, kind, landscape_id, version_id, domain_id, parent_id, deleted_at
           FROM scopes WHERE id = $1`,
          [scopeId]
        ),
      ])
      if (userRows.length === 0) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      if (scopeRows.length === 0) {
        res.status(404).json({ error: 'Scope not found' })
        return
      }

      const result = await explainAccess(pool, userId, scopeId, resourceType)
      const scopeRow = scopeRows[0] as Record<string, unknown>
      res.json({
        ...result,
        user: { id: userRows[0].id, email: userRows[0].email },
        scope: {
          id: scopeRow.id,
          orgId: scopeRow.org_id,
          kind: scopeRow.kind,
          landscapeId: scopeRow.landscape_id,
          versionId: scopeRow.version_id,
          domainId: scopeRow.domain_id,
          parentId: scopeRow.parent_id,
          deletedAt: scopeRow.deleted_at,
        },
      })
    } catch (err) {
      fail(res, 'Failed to compute access debug', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/platform/audit?orgId=&action=&after=&limit=
  // -------------------------------------------------------------------
  app.get('/api/platform/audit', async (req, res) => {
    const auth = await requirePlatformAdmin(req, res)
    if (!auth) return
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null
    const orgId = typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : null
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : null

    try {
      const params: unknown[] = []
      const where: string[] = []
      if (orgId) {
        params.push(orgId)
        where.push(`org_id = $${params.length}`)
      }
      if (action) {
        params.push(action)
        where.push(`action = $${params.length}`)
      }
      if (after) {
        params.push(after)
        where.push(`id < $${params.length}`)
      }
      params.push(limit + 1)

      // Resolve actor/impersonator EMAILS and the org NAME in the same query —
      // the audit view is read by a human; raw ids are a last resort, not the
      // default. LEFT JOINs: an audit row must render even when its user/org
      // has since been deleted (append-only history outlives its subjects).
      const { rows } = await pool.query<{
        id: string
        at: string
        org_id: string | null
        org_name: string | null
        actor_user_id: string
        actor_email: string | null
        impersonator_user_id: string | null
        impersonator_email: string | null
        action: string
        target_kind: string
        target_id: string
        detail: unknown
      }>(
        `SELECT a.id, a.at, a.org_id, o.name AS org_name,
                a.actor_user_id, ua.email AS actor_email,
                a.impersonator_user_id, ui.email AS impersonator_email,
                a.action, a.target_kind, a.target_id, a.detail
         FROM audit_log a
         LEFT JOIN orgs o ON o.id = a.org_id
         LEFT JOIN users ua ON ua.id = a.actor_user_id
         LEFT JOIN users ui ON ui.id = a.impersonator_user_id
         ${where.length > 0 ? `WHERE ${where.map((w) => `a.${w}`).join(' AND ')}` : ''}
         ORDER BY a.id DESC
         LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].id : null

      // The key must stay `entries`: the client (src/lib/platform/api.ts
      // AuditPage) and the org-admin audit list both read that name.
      res.json({
        entries: page.map((r) => ({
          id: String(r.id),
          at: r.at,
          orgId: r.org_id,
          orgName: r.org_name,
          actorUserId: r.actor_user_id,
          actorEmail: r.actor_email,
          impersonatorUserId: r.impersonator_user_id,
          impersonatorEmail: r.impersonator_email,
          action: r.action,
          targetKind: r.target_kind,
          targetId: r.target_id,
          detail: r.detail,
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load platform audit log', err)
    }
  })
}

// Re-exported for tests.
export type { Pool }
