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

import { randomBytes, createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { pool } from '../db.js'
import { appendAudit } from './audit.js'
import { signSession, setSessionCookie } from './tokens.js'
import { getEmailProvider } from '../email/index.js'
import { inviteEmail } from '../email/templates.js'

/**
 * Org invites: an org admin (or platform admin) invites an email to join with
 * a role; the invite is a bearer capability (the link IS the credential — see
 * `POST /invite/:token/accept`), tokenized and short-lived.
 *
 * Only `token_hash` (sha256 hex of the raw token) is ever persisted — the raw
 * token exists only in the email + the one JSON response to the creator (so
 * local/dev testing works without opening the outbox), exactly like a password
 * reset token. A DB read of `org_invites` can never be used to accept an invite.
 */

const VALID_ROLES = new Set(['admin', 'member'])

// Invite lifetime is an ORG SETTING (`orgs.settings.inviteTtlHours`, editable
// by an org admin via PATCH /api/orgs/:orgId) — default 24h, clamped to
// [1h, 720h]. `expires_at` is stamped at CREATION time; changing the setting
// later never retro-shortens (or extends) an already-issued invite.
export const DEFAULT_INVITE_TTL_HOURS = 24
export const MIN_INVITE_TTL_HOURS = 1
export const MAX_INVITE_TTL_HOURS = 720

export function clampInviteTtlHours(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_INVITE_TTL_HOURS
  return Math.min(MAX_INVITE_TTL_HOURS, Math.max(MIN_INVITE_TTL_HOURS, n))
}

async function orgInviteTtlMs(db: Pool, orgId: string): Promise<number> {
  const { rows } = await db.query<{ settings: { inviteTtlHours?: unknown } | null }>(
    'SELECT settings FROM orgs WHERE id = $1',
    [orgId]
  )
  return clampInviteTtlHours(rows[0]?.settings?.inviteTtlHours) * 60 * 60 * 1000
}

/** Validate a `teamIds` body field: every id must be a live (non-archived)
 * team of THIS org — cross-org or unknown ids reject the request rather than
 * silently dropping. */
async function validateTeamIds(
  db: Pool,
  orgId: string,
  raw: unknown
): Promise<{ ok: true; teamIds: string[] } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, teamIds: [] }
  if (!Array.isArray(raw) || raw.length > 100 || raw.some((t) => typeof t !== 'string')) {
    return { ok: false, error: 'teamIds must be an array of team ids' }
  }
  const ids = [...new Set(raw as string[])]
  if (ids.length === 0) return { ok: true, teamIds: [] }
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2) AND archived_at IS NULL',
    [orgId, ids]
  )
  if (rows.length !== ids.length) {
    return { ok: false, error: 'One or more teams do not exist in this organization (or are archived)' }
  }
  return { ok: true, teamIds: ids }
}

/** o***@example.com — enough for the "signed in with the wrong account" hint
 * without disclosing the full invited address to a link-holder. */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 320 && EMAIL_RE.test(email)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

function newInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

function appUrl(): string {
  return process.env.APP_URL || 'http://localhost:5173'
}

function acceptUrlFor(token: string): string {
  return `${appUrl()}/invite/${token}`
}

/** True iff `userId` is an admin of `orgId`, OR a platform admin (who can act
 * on any org). Platform-admin status is trusted from `req.auth` (signed by
 * us); org-admin status is re-checked in the DB on every call — never cached
 * on the token, since role changes must take effect immediately. */
async function canManageOrg(db: Pool, orgId: string, auth: { userId: string; isPlatformAdmin: boolean }): Promise<boolean> {
  if (auth.isPlatformAdmin) return true
  const { rows } = await db.query<{ role: string }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, auth.userId]
  )
  return rows[0]?.role === 'admin'
}

export function registerInviteRoutes(app: import('express').Express): void {
  // POST /api/orgs/:orgId/invites — create + email an invite. Requires a
  // session in ANY auth stage (dev/testing needs this reachable even before
  // AUTH=on enforces it globally) and org-admin/platform-admin authorization.
  app.post('/api/orgs/:orgId/invites', async (req, res) => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const orgId = req.params.orgId
    try {
      if (!(await canManageOrg(pool, orgId, auth))) {
        res.status(403).json({ error: 'Org admin access required' })
        return
      }

      const { email, role, teamIds } = (req.body ?? {}) as { email?: unknown; role?: unknown; teamIds?: unknown }
      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'A valid email is required' })
        return
      }
      if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
        res.status(400).json({ error: "Role must be 'admin' or 'member'" })
        return
      }
      const teams = await validateTeamIds(pool, orgId, teamIds)
      if (!teams.ok) {
        res.status(400).json({ error: teams.error })
        return
      }

      const { rows: orgRows } = await pool.query<{ name: string }>('SELECT name FROM orgs WHERE id = $1', [orgId])
      if (orgRows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }

      const { rows: inviterRows } = await pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [auth.userId]
      )
      const inviterEmail = inviterRows[0]?.email ?? 'an administrator'

      const token = newInviteToken()
      const tokenHash = hashToken(token)
      const id = newId()
      const expiresAt = new Date(Date.now() + (await orgInviteTtlMs(pool, orgId)))

      await pool.query(
        `INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, orgId, email, role, tokenHash, expiresAt, auth.userId]
      )
      for (const teamId of teams.teamIds) {
        await pool.query(
          `INSERT INTO invite_teams (invite_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, teamId]
        )
      }

      const acceptUrl = acceptUrlFor(token)
      const { subject, html, text } = inviteEmail({
        orgName: orgRows[0].name,
        inviterEmail,
        role,
        acceptUrl,
      })
      await getEmailProvider().send({ to: email, subject, html, text })

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'invite.created',
        targetKind: 'org_invite',
        targetId: id,
        detail: { email, role, teamIds: teams.teamIds },
      })

      res.status(201).json({ id, acceptUrl })
    } catch (err) {
      console.error('[invites] create failed:', err)
      res.status(500).json({ error: 'Failed to create invite' })
    }
  })

  // GET /api/auth/invite/:token — public preview (org name, role, inviter,
  // expired/accepted flags). Never returns the hash or any other invite row data.
  app.get('/api/auth/invite/:token', async (req, res) => {
    const token = req.params.token
    if (!token) {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    try {
      const tokenHash = hashToken(token)
      const { rows } = await pool.query<{
        org_name: string
        role: string
        inviter_email: string | null
        expires_at: string
        accepted_at: string | null
      }>(
        `SELECT o.name AS org_name, i.role, u.email AS inviter_email, i.expires_at, i.accepted_at
         FROM org_invites i
         JOIN orgs o ON o.id = i.org_id
         LEFT JOIN users u ON u.id = i.created_by
         WHERE i.token_hash = $1`,
        [tokenHash]
      )
      if (rows.length === 0) {
        res.status(404).json({ error: 'Invite not found' })
        return
      }
      const row = rows[0]
      res.json({
        orgName: row.org_name,
        role: row.role,
        inviterEmail: row.inviter_email,
        expired: new Date(row.expires_at).getTime() < Date.now(),
        accepted: row.accepted_at !== null,
      })
    } catch (err) {
      console.error('[invites] preview failed:', err)
      res.status(500).json({ error: 'Failed to load invite' })
    }
  })

  // POST /api/auth/invite/:token/accept — requires an existing session (the
  // user must sign in via dev-login/OIDC FIRST; the client redirects to login
  // with a return-to-invite path on 401).
  //
  // Hardened contract (invites v2):
  //   - one transaction with `SELECT … FOR UPDATE` on the invite — two racing
  //     accepts of the same link serialize, the loser sees accepted_at set;
  //   - EMAIL MATCH enforced: the session's email must equal the invited
  //     address (case-insensitive). The link is still required (capability),
  //     but forwarding it can no longer grant a bystander the invitee's
  //     pre-configured role/teams — 403 `email_mismatch` with a masked hint;
  //   - membership INSERT is `ON CONFLICT DO NOTHING`: accepting an invite
  //     NEVER rewrites an existing member's role (a stale 'member' invite
  //     can't demote an admin, a stale 'admin' invite can't self-promote) —
  //     `alreadyMember: true` reports it;
  //   - pre-assigned teams (invite_teams) are copied into team_members in the
  //     same transaction, so the invitee's fine-grained permissions are live
  //     the instant the membership is.
  app.post('/api/auth/invite/:token/accept', async (req, res) => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'sign_in_required' })
      return
    }
    const token = req.params.token
    if (!token) {
      res.status(400).json({ error: 'Missing token' })
      return
    }

    const tokenHash = hashToken(token)
    // Definitely assigned iff the transaction below COMMITs (every other path
    // returns out of the handler).
    let invite!: { id: string; org_id: string; email: string; role: string }
    let alreadyMember!: boolean
    let teamsApplied!: string[]

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{
        id: string
        org_id: string
        email: string
        role: string
        expires_at: string
        accepted_at: string | null
      }>(
        `SELECT id, org_id, email, role, expires_at, accepted_at
         FROM org_invites WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash]
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        res.status(404).json({ error: 'Invite not found' })
        return
      }
      const row = rows[0]
      if (row.accepted_at !== null) {
        await client.query('ROLLBACK')
        res.status(410).json({ error: 'Invite already accepted' })
        return
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query('ROLLBACK')
        res.status(410).json({ error: 'Invite expired' })
        return
      }

      const { rows: userRows } = await client.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [auth.userId]
      )
      const sessionEmail = userRows[0]?.email ?? ''
      if (sessionEmail.toLowerCase() !== row.email.toLowerCase()) {
        await client.query('ROLLBACK')
        res.status(403).json({ error: 'email_mismatch', invitedEmail: maskEmail(row.email) })
        return
      }

      const ins = await client.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [row.org_id, auth.userId, row.role]
      )
      alreadyMember = (ins.rowCount ?? 0) === 0

      const { rows: teamRows } = await client.query<{ team_id: string }>(
        `SELECT it.team_id FROM invite_teams it
         JOIN teams t ON t.id = it.team_id AND t.archived_at IS NULL
         WHERE it.invite_id = $1`,
        [row.id]
      )
      for (const t of teamRows) {
        await client.query(
          `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [t.team_id, auth.userId]
        )
      }
      teamsApplied = teamRows.map((t) => t.team_id)

      await client.query('UPDATE org_invites SET accepted_at = NOW() WHERE id = $1', [row.id])
      await client.query('UPDATE users SET last_org_id = $2 WHERE id = $1', [auth.userId, row.org_id])
      await client.query('COMMIT')
      invite = row
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('[invites] accept failed:', err)
      res.status(500).json({ error: 'Failed to accept invite' })
      return
    } finally {
      client.release()
    }

    try {
      await appendAudit(pool, {
        orgId: invite.org_id,
        actorUserId: auth.userId,
        action: 'invite.accepted',
        targetKind: 'org_invite',
        targetId: invite.id,
        detail: {
          invitedEmail: invite.email,
          acceptedByUserId: auth.userId,
          role: invite.role,
          teamIds: teamsApplied,
          alreadyMember,
        },
      })

      // Re-pin the session to the org just joined (and remember it for the
      // next login): an invite-intent login arrives here with an ORG-LESS
      // session that would otherwise have no working workspace at all. Epoch
      // is read POST-commit — the membership insert's trigger just bumped it,
      // and a pre-bump epoch would mint an already-revoked session. The client
      // hard-navigates after accepting, so the new cookie takes effect
      // immediately (fresh WS auth included).
      const { rows: epochRows } = await pool.query<{ epoch: number | string }>(
        'SELECT epoch FROM auth_epochs WHERE org_id = $1',
        [invite.org_id]
      )
      const epoch = epochRows[0] ? Number(epochRows[0].epoch) : 1
      const token2 = await signSession({
        userId: auth.userId,
        orgId: invite.org_id,
        isPlatformAdmin: auth.isPlatformAdmin,
        epoch,
      })
      setSessionCookie(res, token2)

      res.json({ orgId: invite.org_id, alreadyMember, teamsApplied: teamsApplied.length })
    } catch (err) {
      console.error('[invites] accept post-commit failed:', err)
      // Membership IS committed — report success without the re-pinned cookie
      // rather than a misleading failure; the next login lands in the org.
      res.json({ orgId: invite.org_id, alreadyMember, teamsApplied: teamsApplied.length })
    }
  })
}
