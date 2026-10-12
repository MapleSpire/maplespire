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
import { pool } from '../db.js'
import { appendAudit } from '../auth/audit.js'
import { clampInviteTtlHours } from '../auth/invites.js'
import { explainAccess } from './access.js'
import { getOrgReadModelHealth } from '../readModel/health.js'

/**
 * Org Admin console REST endpoints. Every route here requires `req.auth` (401 otherwise) and
 * org-admin-of-:orgId OR platform-admin (403 otherwise) — the exact
 * `canManageOrg` re-check-in-DB pattern from `../auth/invites.ts` (duplicated
 * here so this router does not depend on that module's internals).
 *
 * Every endpoint in this file is admin-only by design. A read-only member
 * directory reachable by every org member would need its own,
 * differently-authorized endpoint.
 *
 * Pagination: all list endpoints are keyset-paginated (`?after=<lastId>`,
 * `?limit=` capped at 100, default 50) ordered by a stable id column — same
 * shape as `readModel/queries.ts`'s `roPageObjects` (fetch limit+1, slice,
 * derive `nextCursor` from the extra row).
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

function parseLimit(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/** Express types a route param as `string | string[]` (repeated query-string-
 * style params); every param this router reads is a single path segment, so
 * this just narrows — a real array (malformed request) collapses to its
 * first entry rather than throwing, matching how Express itself would join
 * it into the path in practice. */
function paramStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

/** Wrap a raw driver/SQL error so it never leaks to the client — mirrors the
 * `invites.ts` `console.error` + generic-message convention. */
function fail(res: import('express').Response, context: string, err: unknown, status = 500): void {
  console.error(`[orgRoutes] ${context} failed:`, err)
  res.status(status).json({ error: context })
}

/** True iff `userId` is an admin of `orgId`, OR a platform admin (who can act
 * on any org). Platform-admin status is trusted from `req.auth` (signed by
 * us); org-admin status is re-checked in the DB on every call — see
 * `invites.ts`'s identical helper for the rationale (role changes must take
 * effect immediately, so it is never cached on the token). */
async function canManageOrg(db: Pool, orgId: string, auth: { userId: string; isPlatformAdmin: boolean }): Promise<boolean> {
  if (auth.isPlatformAdmin) return true
  const { rows } = await db.query<{ role: string }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, auth.userId]
  )
  return rows[0]?.role === 'admin'
}

type OrgAdminRequest = import('express').Request
type OrgAdminResponse = import('express').Response

/** Shared guard: 401 if no session, 403 if not org-admin/platform-admin, 404
 * if the org doesn't exist. Returns the validated auth claims, or null if the
 * response has already been sent. */
async function requireOrgAdmin(
  req: OrgAdminRequest,
  res: OrgAdminResponse
): Promise<{ userId: string; isPlatformAdmin: boolean } | null> {
  const auth = req.auth
  if (!auth) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  const orgId = paramStr(req.params.orgId)
  try {
    if (!(await canManageOrg(pool, orgId, auth))) {
      res.status(403).json({ error: 'Org admin access required' })
      return null
    }
  } catch (err) {
    fail(res, 'Failed to verify org admin access', err)
    return null
  }
  return auth
}

export function registerOrgAdminRoutes(app: import('express').Express): void {
  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/overview
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/overview', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    try {
      const { rows: orgRows } = await pool.query<{
        id: string
        name: string
        slug: string
        status: string
        settings: Record<string, unknown>
      }>('SELECT id, name, slug, status, settings FROM orgs WHERE id = $1', [orgId])
      if (orgRows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }

      const [memberCountRes, teamCountRes, pendingInviteCountRes, landscapeCountRes, auditRes] = await Promise.all([
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM org_members WHERE org_id = $1', [orgId]),
        pool.query<{ n: string }>('SELECT count(*)::text AS n FROM teams WHERE org_id = $1 AND archived_at IS NULL', [orgId]),
        pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
          [orgId]
        ),
        // Counted from the scope tree (registered via upsertLandscapeScope),
        // which only holds non-deleted landscapes this org knows about.
        pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM scopes WHERE org_id = $1 AND kind = 'landscape' AND deleted_at IS NULL`,
          [orgId]
        ),
        pool.query(
          `SELECT id, at, actor_user_id, impersonator_user_id, action, target_kind, target_id, detail
           FROM audit_log WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT 20`,
          [orgId]
        ),
      ])

      res.json({
        org: {
          id: orgRows[0].id,
          name: orgRows[0].name,
          slug: orgRows[0].slug,
          status: orgRows[0].status,
          settings: orgRows[0].settings ?? {},
        },
        memberCount: Number(memberCountRes.rows[0].n),
        teamCount: Number(teamCountRes.rows[0].n),
        pendingInviteCount: Number(pendingInviteCountRes.rows[0].n),
        landscapeCount: Number(landscapeCountRes.rows[0].n),
        recentAudit: auditRes.rows.map((r) => ({
          id: String(r.id),
          at: r.at,
          actorUserId: r.actor_user_id,
          impersonatorUserId: r.impersonator_user_id,
          action: r.action,
          targetKind: r.target_kind,
          targetId: r.target_id,
          detail: r.detail,
        })),
      })
    } catch (err) {
      fail(res, 'Failed to load org overview', err)
    }
  })

  // -------------------------------------------------------------------
  // Operations — read-model/projector freshness (admin-only metadata).
  // No object, Tag or Automerge payload is returned; the response contains
  // only workspace labels, generations, timestamps and bounded error codes.
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/read-model-health', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    try {
      const { rows: orgRows } = await pool.query('SELECT 1 FROM orgs WHERE id = $1', [orgId])
      if (orgRows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }
      res.json(await getOrgReadModelHealth(pool, orgId))
    } catch (err) {
      fail(res, 'Failed to load read model health', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/members
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/members', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null
    const excludeTeamId = typeof req.query.excludeTeamId === 'string' && req.query.excludeTeamId
      ? req.query.excludeTeamId
      : null

    try {
      const params: unknown[] = [orgId]
      const where: string[] = ['om.org_id = $1']
      if (after) {
        params.push(after)
        where.push(`u.id > $${params.length}`)
      }
      if (q) {
        params.push(`%${q.toLowerCase()}%`)
        where.push(`(lower(u.email) LIKE $${params.length} OR lower(coalesce(u.name, '')) LIKE $${params.length})`)
      }
      if (excludeTeamId) {
        params.push(excludeTeamId)
        where.push(`NOT EXISTS (
          SELECT 1 FROM team_members excluded_member
          JOIN teams excluded_team ON excluded_team.id = excluded_member.team_id
          WHERE excluded_member.user_id = u.id
            AND excluded_member.team_id = $${params.length}
            AND excluded_team.org_id = $1
        )`)
      }
      params.push(limit + 1)

      const { rows } = await pool.query<{
        user_id: string
        email: string
        name: string | null
        role: string
        status: string
      }>(
        `SELECT u.id AS user_id, u.email, u.name, om.role, u.status
         FROM org_members om
         JOIN users u ON u.id = om.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY u.id
         LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].user_id : null

      const userIds = page.map((r) => r.user_id)
      const teamsByUser = new Map<string, Array<{ id: string; name: string }>>()
      if (userIds.length > 0) {
        const { rows: teamRows } = await pool.query<{ user_id: string; id: string; name: string }>(
          `SELECT tm.user_id, t.id, t.name
           FROM team_members tm
           JOIN teams t ON t.id = tm.team_id
           WHERE t.org_id = $1 AND t.archived_at IS NULL AND tm.user_id = ANY($2::text[])
           ORDER BY t.name`,
          [orgId, userIds]
        )
        for (const r of teamRows) {
          const list = teamsByUser.get(r.user_id) ?? []
          list.push({ id: r.id, name: r.name })
          teamsByUser.set(r.user_id, list)
        }
      }

      res.json({
        members: page.map((r) => ({
          userId: r.user_id,
          email: r.email,
          name: r.name,
          role: r.role,
          status: r.status,
          teams: teamsByUser.get(r.user_id) ?? [],
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load org members', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/orgs/:orgId/members/:userId  { role }
  // Last-admin protection enforced in SQL inside a transaction (SELECT ...
  // FOR UPDATE on the org's admin rows) — not just app logic.
  // -------------------------------------------------------------------
  app.patch('/api/orgs/:orgId/members/:userId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const targetUserId = paramStr(req.params.userId)

    const { role } = (req.body ?? {}) as { role?: unknown }
    if (role !== 'admin' && role !== 'member') {
      res.status(400).json({ error: "Role must be 'admin' or 'member'" })
      return
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Lock every admin row of this org for the duration of the tx so a
      // concurrent demote/remove of a DIFFERENT admin can't race this one
      // into leaving the org with zero admins.
      const { rows: adminRows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'admin' FOR UPDATE`,
        [orgId]
      )

      const { rows: targetRows } = await client.query<{ role: string }>(
        `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetUserId]
      )
      if (targetRows.length === 0) {
        await client.query('ROLLBACK')
        res.status(404).json({ error: 'Member not found' })
        return
      }

      const targetIsOnlyAdmin = targetRows[0].role === 'admin' && adminRows.length === 1 && adminRows[0].user_id === targetUserId
      if (targetIsOnlyAdmin && role !== 'admin') {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'last-admin' })
        return
      }

      await client.query(`UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3`, [role, orgId, targetUserId])
      await client.query('COMMIT')

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'member.role-changed',
        targetKind: 'org_member',
        targetId: targetUserId,
        detail: { from: targetRows[0].role, to: role },
      })

      res.json({ userId: targetUserId, role })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fail(res, 'Failed to change member role', err)
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/members/:userId
  // Same last-admin protection; also refuses removing yourself if you are
  // the last admin (covered by the same FOR UPDATE check since "yourself"
  // is just another target user id).
  // -------------------------------------------------------------------
  app.delete('/api/orgs/:orgId/members/:userId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const targetUserId = paramStr(req.params.userId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: adminRows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'admin' FOR UPDATE`,
        [orgId]
      )

      const { rows: targetRows } = await client.query<{ role: string }>(
        `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetUserId]
      )
      if (targetRows.length === 0) {
        await client.query('ROLLBACK')
        res.status(404).json({ error: 'Member not found' })
        return
      }

      const targetIsOnlyAdmin = targetRows[0].role === 'admin' && adminRows.length === 1 && adminRows[0].user_id === targetUserId
      if (targetIsOnlyAdmin) {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'last-admin' })
        return
      }

      await client.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, targetUserId])
      await client.query('COMMIT')

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'member.removed',
        targetKind: 'org_member',
        targetId: targetUserId,
        detail: { role: targetRows[0].role },
      })

      res.status(204).end()
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fail(res, 'Failed to remove member', err)
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/orgs/:orgId — rename + org settings (admin-editable, key-by-key
  // WHITELIST: only `inviteTtlHours` today; unknown settings keys are
  // rejected, never stored). Slug is immutable.
  // -------------------------------------------------------------------
  app.patch('/api/orgs/:orgId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const body = (req.body ?? {}) as { name?: unknown; settings?: unknown }

    let name: string | null = null
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) {
        res.status(400).json({ error: 'name must be a non-empty string of at most 200 characters' })
        return
      }
      name = body.name.trim()
    }

    let settingsPatch: Record<string, unknown> | null = null
    if (body.settings !== undefined) {
      if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
        res.status(400).json({ error: 'settings must be an object' })
        return
      }
      const allowed = new Set(['inviteTtlHours'])
      const keys = Object.keys(body.settings as Record<string, unknown>)
      const unknown = keys.filter((k) => !allowed.has(k))
      if (unknown.length > 0) {
        res.status(400).json({ error: `Unknown settings: ${unknown.join(', ')}` })
        return
      }
      settingsPatch = {}
      if ('inviteTtlHours' in (body.settings as Record<string, unknown>)) {
        const raw = (body.settings as Record<string, unknown>).inviteTtlHours
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          res.status(400).json({ error: 'inviteTtlHours must be a number (hours)' })
          return
        }
        settingsPatch.inviteTtlHours = clampInviteTtlHours(raw)
      }
    }

    if (name === null && (settingsPatch === null || Object.keys(settingsPatch).length === 0)) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    try {
      const { rows: beforeRows } = await pool.query<{ name: string }>('SELECT name FROM orgs WHERE id = $1', [orgId])
      if (beforeRows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }
      const previousName = beforeRows[0].name

      const { rows } = await pool.query<{ name: string; settings: Record<string, unknown> }>(
        `UPDATE orgs SET
           name = COALESCE($2, name),
           settings = settings || $3::jsonb
         WHERE id = $1
         RETURNING name, settings`,
        [orgId, name, JSON.stringify(settingsPatch ?? {})]
      )

      if (name !== null && name !== previousName) {
        await appendAudit(pool, {
          orgId,
          actorUserId: auth.userId,
          action: 'org.renamed',
          targetKind: 'org',
          targetId: orgId,
          detail: { from: previousName, to: name },
        })
      }
      if (settingsPatch && Object.keys(settingsPatch).length > 0) {
        await appendAudit(pool, {
          orgId,
          actorUserId: auth.userId,
          action: 'org.settings-changed',
          targetKind: 'org',
          targetId: orgId,
          detail: settingsPatch,
        })
      }

      res.json({ org: { id: orgId, name: rows[0].name, settings: rows[0].settings } })
    } catch (err) {
      fail(res, 'Failed to update org', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/invites — pending by default, ?all=1 for full history
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/invites', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null
    const all = req.query.all === '1' || req.query.all === 'true'

    try {
      const params: unknown[] = [orgId]
      const where: string[] = ['org_id = $1']
      if (!all) {
        where.push('accepted_at IS NULL', 'expires_at > now()')
      }
      if (after) {
        params.push(after)
        where.push(`id > $${params.length}`)
      }
      params.push(limit + 1)

      const { rows } = await pool.query<{
        id: string
        email: string
        role: string
        expires_at: string
        accepted_at: string | null
        created_at: string
      }>(
        `SELECT id, email, role, expires_at, accepted_at, created_at
         FROM org_invites WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].id : null

      // Pre-assigned teams per invite (invites v2) — one query for the page.
      const teamsByInvite = new Map<string, { id: string; name: string }[]>()
      if (page.length > 0) {
        const { rows: teamRows } = await pool.query<{ invite_id: string; id: string; name: string }>(
          `SELECT it.invite_id, t.id, t.name
           FROM invite_teams it JOIN teams t ON t.id = it.team_id
           WHERE it.invite_id = ANY($1)
           ORDER BY t.name`,
          [page.map((r) => r.id)]
        )
        for (const t of teamRows) {
          const list = teamsByInvite.get(t.invite_id) ?? []
          list.push({ id: t.id, name: t.name })
          teamsByInvite.set(t.invite_id, list)
        }
      }

      res.json({
        invites: page.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          expiresAt: r.expires_at,
          acceptedAt: r.accepted_at,
          createdAt: r.created_at,
          expired: new Date(r.expires_at).getTime() < Date.now(),
          teams: teamsByInvite.get(r.id) ?? [],
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load invites', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/orgs/:orgId/invites/:inviteId — edit a PENDING invite's role
  // and/or pre-assigned teams ("configure the account before they accept").
  // Accepted/expired invites are immutable (409/410).
  // -------------------------------------------------------------------
  app.patch('/api/orgs/:orgId/invites/:inviteId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const inviteId = paramStr(req.params.inviteId)
    const body = (req.body ?? {}) as { role?: unknown; teamIds?: unknown }

    let role: string | null = null
    if (body.role !== undefined) {
      if (typeof body.role !== 'string' || !['admin', 'member'].includes(body.role)) {
        res.status(400).json({ error: "Role must be 'admin' or 'member'" })
        return
      }
      role = body.role
    }

    let teamIds: string[] | null = null
    if (body.teamIds !== undefined) {
      if (!Array.isArray(body.teamIds) || body.teamIds.length > 100 || body.teamIds.some((t) => typeof t !== 'string')) {
        res.status(400).json({ error: 'teamIds must be an array of team ids' })
        return
      }
      const ids = [...new Set(body.teamIds as string[])]
      if (ids.length > 0) {
        const { rows } = await pool.query<{ id: string }>(
          'SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2) AND archived_at IS NULL',
          [orgId, ids]
        )
        if (rows.length !== ids.length) {
          res.status(400).json({ error: 'One or more teams do not exist in this organization (or are archived)' })
          return
        }
      }
      teamIds = ids
    }

    if (role === null && teamIds === null) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    try {
      const { rows } = await pool.query<{ accepted_at: string | null; expires_at: string }>(
        'SELECT accepted_at, expires_at FROM org_invites WHERE id = $1 AND org_id = $2',
        [inviteId, orgId]
      )
      if (rows.length === 0) {
        res.status(404).json({ error: 'Invite not found' })
        return
      }
      if (rows[0].accepted_at !== null) {
        res.status(409).json({ error: 'already-accepted' })
        return
      }
      if (new Date(rows[0].expires_at).getTime() < Date.now()) {
        res.status(410).json({ error: 'expired' })
        return
      }

      if (role !== null) {
        await pool.query('UPDATE org_invites SET role = $3 WHERE id = $1 AND org_id = $2', [inviteId, orgId, role])
      }
      if (teamIds !== null) {
        await pool.query('DELETE FROM invite_teams WHERE invite_id = $1', [inviteId])
        for (const teamId of teamIds) {
          await pool.query(
            'INSERT INTO invite_teams (invite_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [inviteId, teamId]
          )
        }
      }

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'invite.updated',
        targetKind: 'org_invite',
        targetId: inviteId,
        detail: {
          ...(role !== null ? { role } : {}),
          ...(teamIds !== null ? { teamIds } : {}),
        },
      })

      res.json({ success: true })
    } catch (err) {
      fail(res, 'Failed to update invite', err)
    }
  })

  // -------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/invites/:inviteId — revoke (only pending)
  // -------------------------------------------------------------------
  app.delete('/api/orgs/:orgId/invites/:inviteId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const inviteId = paramStr(req.params.inviteId)

    try {
      const { rows } = await pool.query<{ accepted_at: string | null }>(
        `SELECT accepted_at FROM org_invites WHERE id = $1 AND org_id = $2`,
        [inviteId, orgId]
      )
      if (rows.length === 0) {
        res.status(404).json({ error: 'Invite not found' })
        return
      }
      if (rows[0].accepted_at !== null) {
        res.status(409).json({ error: 'already-accepted' })
        return
      }

      await pool.query(`DELETE FROM org_invites WHERE id = $1 AND org_id = $2`, [inviteId, orgId])

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'invite.revoked',
        targetKind: 'org_invite',
        targetId: inviteId,
      })

      res.status(204).end()
    } catch (err) {
      fail(res, 'Failed to revoke invite', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/teams
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/teams', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null

    try {
      const params: unknown[] = [orgId]
      const where: string[] = ['t.org_id = $1']
      if (after) {
        params.push(after)
        where.push(`t.id > $${params.length}`)
      }
      params.push(limit + 1)

      const { rows } = await pool.query<{ id: string; name: string; archived_at: string | null; member_count: string }>(
        `SELECT t.id, t.name, t.archived_at, count(tm.user_id)::text AS member_count
         FROM teams t
         LEFT JOIN team_members tm ON tm.team_id = t.id
         WHERE ${where.join(' AND ')}
         GROUP BY t.id, t.name, t.archived_at
         ORDER BY t.id
         LIMIT $${params.length}`,
        params
      )

      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].id : null

      res.json({
        teams: page.map((r) => ({
          id: r.id,
          name: r.name,
          archivedAt: r.archived_at,
          memberCount: Number(r.member_count),
        })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load teams', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/teams/:teamId
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/teams/:teamId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const teamId = paramStr(req.params.teamId)
    const limit = parseLimit(req.query.limit)
    const after = typeof req.query.after === 'string' ? req.query.after : null

    try {
      const { rows: teamRows } = await pool.query<{ id: string; name: string; archived_at: string | null }>(
        `SELECT id, name, archived_at FROM teams WHERE id = $1 AND org_id = $2`,
        [teamId, orgId]
      )
      if (teamRows.length === 0) {
        res.status(404).json({ error: 'Team not found' })
        return
      }

      const { rows: memberRows } = await pool.query<{ user_id: string; email: string; name: string | null }>(
        `SELECT tm.user_id, u.email, u.name
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
           AND ($2::text IS NULL OR tm.user_id > $2)
         ORDER BY tm.user_id
         LIMIT $3`,
        [teamId, after, limit + 1]
      )
      const page = memberRows.slice(0, limit)
      const nextCursor = memberRows.length > limit ? page.at(-1)!.user_id : null

      res.json({
        team: { id: teamRows[0].id, name: teamRows[0].name, archivedAt: teamRows[0].archived_at },
        members: page.map((r) => ({ userId: r.user_id, email: r.email, name: r.name })),
        nextCursor,
      })
    } catch (err) {
      fail(res, 'Failed to load team', err)
    }
  })

  // -------------------------------------------------------------------
  // POST /api/orgs/:orgId/teams  { name }
  // -------------------------------------------------------------------
  app.post('/api/orgs/:orgId/teams', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const { name } = (req.body ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      res.status(400).json({ error: 'A non-empty team name (<=200 chars) is required' })
      return
    }

    try {
      const { rows: orgRows } = await pool.query('SELECT id FROM orgs WHERE id = $1', [orgId])
      if (orgRows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }

      const id = newId()
      await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)`, [id, orgId, name.trim()])

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'team.created',
        targetKind: 'team',
        targetId: id,
        detail: { name: name.trim() },
      })

      res.status(201).json({ id, name: name.trim(), archivedAt: null, memberCount: 0 })
    } catch (err) {
      fail(res, 'Failed to create team', err)
    }
  })

  // -------------------------------------------------------------------
  // PATCH /api/orgs/:orgId/teams/:teamId  { name?, archived? }
  // -------------------------------------------------------------------
  app.patch('/api/orgs/:orgId/teams/:teamId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const teamId = paramStr(req.params.teamId)
    const { name, archived } = (req.body ?? {}) as { name?: unknown; archived?: unknown }

    if (name === undefined && archived === undefined) {
      res.status(400).json({ error: 'Nothing to update: provide name and/or archived' })
      return
    }
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > 200)) {
      res.status(400).json({ error: 'A non-empty team name (<=200 chars) is required' })
      return
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }

    try {
      const { rows: existing } = await pool.query<{ id: string; name: string; archived_at: string | null }>(
        `SELECT id, name, archived_at FROM teams WHERE id = $1 AND org_id = $2`,
        [teamId, orgId]
      )
      if (existing.length === 0) {
        res.status(404).json({ error: 'Team not found' })
        return
      }

      const sets: string[] = []
      const params: unknown[] = []
      if (typeof name === 'string') {
        params.push(name.trim())
        sets.push(`name = $${params.length}`)
      }
      if (typeof archived === 'boolean') {
        params.push(archived ? new Date() : null)
        sets.push(`archived_at = $${params.length}`)
      }
      params.push(teamId, orgId)
      await pool.query(
        `UPDATE teams SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
        params
      )

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: typeof archived === 'boolean' ? (archived ? 'team.archived' : 'team.unarchived') : 'team.renamed',
        targetKind: 'team',
        targetId: teamId,
        detail: { name: typeof name === 'string' ? name.trim() : undefined, archived },
      })

      const { rows: updated } = await pool.query<{ id: string; name: string; archived_at: string | null }>(
        `SELECT id, name, archived_at FROM teams WHERE id = $1`,
        [teamId]
      )
      res.json({ id: updated[0].id, name: updated[0].name, archivedAt: updated[0].archived_at })
    } catch (err) {
      fail(res, 'Failed to update team', err)
    }
  })

  // -------------------------------------------------------------------
  // PUT /api/orgs/:orgId/teams/:teamId/members/:userId — add (target must be
  // an org member)
  // -------------------------------------------------------------------
  app.put('/api/orgs/:orgId/teams/:teamId/members/:userId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const teamId = paramStr(req.params.teamId)
    const targetUserId = paramStr(req.params.userId)

    try {
      const { rows: teamRows } = await pool.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [teamId, orgId])
      if (teamRows.length === 0) {
        res.status(404).json({ error: 'Team not found' })
        return
      }
      const { rows: memberRows } = await pool.query(
        'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
        [orgId, targetUserId]
      )
      if (memberRows.length === 0) {
        res.status(400).json({ error: 'not-an-org-member' })
        return
      }

      await pool.query(
        `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT (team_id, user_id) DO NOTHING`,
        [teamId, targetUserId]
      )

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'team.member-added',
        targetKind: 'team',
        targetId: teamId,
        detail: { userId: targetUserId },
      })

      res.status(204).end()
    } catch (err) {
      fail(res, 'Failed to add team member', err)
    }
  })

  // -------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/teams/:teamId/members/:userId — remove
  // -------------------------------------------------------------------
  app.delete('/api/orgs/:orgId/teams/:teamId/members/:userId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const teamId = paramStr(req.params.teamId)
    const targetUserId = paramStr(req.params.userId)

    try {
      const { rows: teamRows } = await pool.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [teamId, orgId])
      if (teamRows.length === 0) {
        res.status(404).json({ error: 'Team not found' })
        return
      }

      await pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, targetUserId])

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'team.member-removed',
        targetKind: 'team',
        targetId: teamId,
        detail: { userId: targetUserId },
      })

      res.status(204).end()
    } catch (err) {
      fail(res, 'Failed to remove team member', err)
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/access — the matrix
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/access', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)

    try {
      const [scopesRes, teamsRes, grantsRes] = await Promise.all([
        pool.query<{
          id: string
          kind: string
          landscape_id: string | null
          version_id: string | null
          domain_id: string | null
          parent_id: string | null
        }>(
          `SELECT id, kind, landscape_id, version_id, domain_id, parent_id
           FROM scopes WHERE org_id = $1 AND deleted_at IS NULL ORDER BY kind, id`,
          [orgId]
        ),
        pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM teams WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`,
          [orgId]
        ),
        pool.query<{
          team_id: string
          scope_id: string
          resource_type: string
          can_read: boolean
          can_write: boolean
          updated_at: string
        }>(
          `SELECT tsp.team_id, tsp.scope_id, tsp.resource_type, tsp.can_read, tsp.can_write, tsp.updated_at
           FROM team_scope_permissions tsp
           JOIN scopes s ON s.id = tsp.scope_id
           WHERE s.org_id = $1`,
          [orgId]
        ),
      ])

      res.json({
        scopes: scopesRes.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          landscapeId: r.landscape_id,
          versionId: r.version_id,
          domainId: r.domain_id,
          parentId: r.parent_id,
        })),
        teams: teamsRes.rows,
        grants: grantsRes.rows.map((r) => ({
          teamId: r.team_id,
          scopeId: r.scope_id,
          resourceType: r.resource_type,
          canRead: r.can_read,
          canWrite: r.can_write,
          updatedAt: r.updated_at,
        })),
      })
    } catch (err) {
      fail(res, 'Failed to load access matrix', err)
    }
  })

  // -------------------------------------------------------------------
  // PUT /api/orgs/:orgId/access — batched review-and-apply
  // -------------------------------------------------------------------
  interface AccessChange {
    teamId: string
    scopeId: string
    resourceType: string
    canRead: boolean
    canWrite: boolean
    expectedUpdatedAt: string | null
  }

  function isValidChange(c: unknown): c is AccessChange {
    if (!c || typeof c !== 'object') return false
    const o = c as Record<string, unknown>
    return (
      typeof o.teamId === 'string' &&
      typeof o.scopeId === 'string' &&
      typeof o.resourceType === 'string' &&
      typeof o.canRead === 'boolean' &&
      typeof o.canWrite === 'boolean' &&
      (o.expectedUpdatedAt === null || typeof o.expectedUpdatedAt === 'string')
    )
  }

  app.put('/api/orgs/:orgId/access', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)

    const { changes } = (req.body ?? {}) as { changes?: unknown }
    if (!Array.isArray(changes) || changes.length === 0 || !changes.every(isValidChange)) {
      res.status(400).json({ error: 'changes must be a non-empty array of valid grant changes' })
      return
    }
    const validChanges = changes as AccessChange[]

    // Every team/scope referenced must belong to this org — never let a
    // batch reach across org boundaries even if the client sent a foreign id.
    const teamIds = [...new Set(validChanges.map((c) => c.teamId))]
    const scopeIds = [...new Set(validChanges.map((c) => c.scopeId))]

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: ownedTeams } = await client.query<{ id: string }>(
        `SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2::text[])`,
        [orgId, teamIds]
      )
      if (ownedTeams.length !== teamIds.length) {
        await client.query('ROLLBACK')
        res.status(400).json({ error: 'One or more teams do not belong to this org' })
        return
      }
      const { rows: ownedScopes } = await client.query<{ id: string }>(
        `SELECT id FROM scopes WHERE org_id = $1 AND id = ANY($2::text[])`,
        [orgId, scopeIds]
      )
      if (ownedScopes.length !== scopeIds.length) {
        await client.query('ROLLBACK')
        res.status(400).json({ error: 'One or more scopes do not belong to this org' })
        return
      }

      const conflicts: Array<{ teamId: string; scopeId: string; resourceType: string }> = []
      const diff: Array<{ teamId: string; scopeId: string; resourceType: string; before: unknown; after: unknown }> = []

      for (const change of validChanges) {
        // Row-level lock so a concurrent batch touching the same
        // (team,scope,resource_type) can't interleave with this one's CAS
        // check — the whole point of expectedUpdatedAt.
        const { rows: currentRows } = await client.query<{ can_read: boolean; can_write: boolean; updated_at: string }>(
          `SELECT can_read, can_write, updated_at FROM team_scope_permissions
           WHERE team_id = $1 AND scope_id = $2 AND resource_type = $3 FOR UPDATE`,
          [change.teamId, change.scopeId, change.resourceType]
        )
        const current = currentRows[0] ?? null

        const currentUpdatedAtIso = current ? new Date(current.updated_at).toISOString() : null
        const expectedIso = change.expectedUpdatedAt ? new Date(change.expectedUpdatedAt).toISOString() : null

        const mismatch =
          (current === null && change.expectedUpdatedAt !== null) ||
          (current !== null && change.expectedUpdatedAt === null) ||
          (current !== null && change.expectedUpdatedAt !== null && currentUpdatedAtIso !== expectedIso)

        if (mismatch) {
          conflicts.push({ teamId: change.teamId, scopeId: change.scopeId, resourceType: change.resourceType })
          continue
        }

        const wantsDelete = !change.canRead && !change.canWrite
        if (wantsDelete) {
          if (current !== null) {
            await client.query(
              `DELETE FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2 AND resource_type = $3`,
              [change.teamId, change.scopeId, change.resourceType]
            )
            diff.push({
              teamId: change.teamId,
              scopeId: change.scopeId,
              resourceType: change.resourceType,
              before: { canRead: current.can_read, canWrite: current.can_write },
              after: null,
            })
          }
          continue
        }

        await client.query(
          `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (team_id, scope_id, resource_type)
           DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [change.teamId, change.scopeId, change.resourceType, change.canRead, change.canWrite, auth.userId]
        )
        diff.push({
          teamId: change.teamId,
          scopeId: change.scopeId,
          resourceType: change.resourceType,
          before: current ? { canRead: current.can_read, canWrite: current.can_write } : null,
          after: { canRead: change.canRead, canWrite: change.canWrite },
        })
      }

      if (conflicts.length > 0) {
        await client.query('ROLLBACK')
        res.status(409).json({ error: 'stale', conflicts })
        return
      }

      // Guardrail: warn (never block) about landscapes left with zero
      // write-capable teams after this batch. Computed from the
      // POST-transaction state within the same transaction (read-your-writes).
      const { rows: warnRows } = await client.query<{ landscape_id: string }>(
        `SELECT s.landscape_id
         FROM scopes s
         WHERE s.org_id = $1 AND s.kind = 'landscape' AND s.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM scope_ancestors sa
             JOIN team_scope_permissions tsp ON tsp.scope_id = sa.ancestor_id
             JOIN teams t ON t.id = tsp.team_id AND t.archived_at IS NULL
             WHERE sa.scope_id = s.id AND tsp.can_write = true
           )`,
        [orgId]
      )

      await client.query('COMMIT')

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'access.batch-applied',
        targetKind: 'team_scope_permissions',
        targetId: orgId,
        detail: { diff },
      })

      res.json({
        applied: diff.length,
        warnings: warnRows.map((r) => ({
          type: 'no-write-capable-team',
          landscapeId: r.landscape_id,
        })),
      })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fail(res, 'Failed to apply access changes', err)
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------
  // GET /api/orgs/:orgId/access/preview?userId=&scopeId=&resourceType=*
  // -------------------------------------------------------------------
  app.get('/api/orgs/:orgId/access/preview', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const orgId = paramStr(req.params.orgId)
    const userId = typeof req.query.userId === 'string' ? req.query.userId : null
    const scopeId = typeof req.query.scopeId === 'string' ? req.query.scopeId : null
    const resourceType = typeof req.query.resourceType === 'string' && req.query.resourceType ? req.query.resourceType : '*'

    if (!userId || !scopeId) {
      res.status(400).json({ error: 'userId and scopeId are required' })
      return
    }

    try {
      const { rows: memberRows } = await pool.query(
        'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
        [orgId, userId]
      )
      if (memberRows.length === 0) {
        res.status(404).json({ error: 'User is not a member of this org' })
        return
      }
      const { rows: scopeRows } = await pool.query('SELECT id FROM scopes WHERE id = $1 AND org_id = $2', [scopeId, orgId])
      if (scopeRows.length === 0) {
        res.status(404).json({ error: 'Scope not found in this org' })
        return
      }

      const result = await explainAccess(pool, userId, scopeId, resourceType)
      res.json(result)
    } catch (err) {
      fail(res, 'Failed to compute access preview', err)
    }
  })
}
