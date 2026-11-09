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

import type { Express, Request, Response } from 'express'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { pool } from '../db.js'
import { appendAudit } from './audit.js'
import { MICROSOFT_PERSONAL_TENANT_ID, TENANT_ID_RE, orgRoleIfAdmitted, tenantAllowedSql } from './tenantPolicy.js'

/**
 * Org admin: the org's allowed Microsoft Entra tenants (tenantPolicy.ts).
 *
 *   GET    /api/orgs/:orgId/idp-tenants              list + policy + warning
 *   POST   /api/orgs/:orgId/idp-tenants              { tenantId }
 *   DELETE /api/orgs/:orgId/idp-tenants/:tenantId
 *   PATCH  /api/orgs/:orgId/idp-tenant-policy        { microsoftPersonalAccountsAllowed }
 *
 * Org-admin of :orgId (role read from the DB on every call, and only if the
 * tenant policy admits the admin — `orgRoleIfAdmitted`) or platform admin
 * (from the epoch-validated session claim). Every change runs in ONE transaction that locks the
 * org row (two admins editing the list serialize), refuses a change that
 * would lock the acting org admin out (409 `would_lock_out_self` — a platform
 * admin is exempt: they reach the org without a member session), and bumps
 * the per-user epoch of every member the change newly refuses — that bump is
 * what revokes their already-minted sessions (sessionEpoch.ts).
 */

const tenantIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TENANT_ID_RE, 'tenantId must be an Entra tenant id (a GUID)')

const addTenantSchema = z.object({ tenantId: tenantIdSchema }).strict()
const policySchema = z.object({ microsoftPersonalAccountsAllowed: z.boolean() }).strict()

type Auth = { userId: string; isPlatformAdmin: boolean }

function paramStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

async function canManageOrg(db: Pool, orgId: string, auth: Auth): Promise<boolean> {
  if (auth.isPlatformAdmin) return true
  // A refused admin is not an admin here — or they could re-list their own
  // tenant from a session pinned to another org.
  return (await orgRoleIfAdmitted(db, orgId, auth.userId)) === 'admin'
}

async function requireOrgAdmin(req: Request, res: Response): Promise<Auth | null> {
  const auth = req.auth
  if (!auth) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  try {
    if (!(await canManageOrg(pool, paramStr(req.params.orgId), auth))) {
      res.status(403).json({ error: 'Org admin access required' })
      return null
    }
  } catch (err) {
    console.error('[orgTenantRoutes] admin check failed:', err)
    res.status(500).json({ error: 'Failed to verify org admin access' })
    return null
  }
  return auth
}

export interface OrgTenantPolicy {
  tenants: Array<{ provider: 'microsoft'; tenantId: string; addedBy: string; addedAt: string }>
  microsoftPersonalAccountsAllowed: boolean
  /** 'no_tenant_restriction' while the list is empty: every Entra tenant (and
   * personal accounts) may join and use the org. */
  warning: 'no_tenant_restriction' | null
}

async function readPolicy(db: Pick<Pool, 'query'>, orgId: string): Promise<OrgTenantPolicy | null> {
  const { rows: orgRows } = await db.query<{ microsoft_personal_accounts_allowed: boolean }>(
    'SELECT microsoft_personal_accounts_allowed FROM orgs WHERE id = $1',
    [orgId]
  )
  if (orgRows.length === 0) return null
  const { rows } = await db.query<{ tenant_id: string; added_by: string; added_at: Date }>(
    `SELECT tenant_id, added_by, added_at FROM org_allowed_idp_tenants
     WHERE org_id = $1 AND provider = 'microsoft' ORDER BY added_at, tenant_id`,
    [orgId]
  )
  return {
    tenants: rows.map((r) => ({
      provider: 'microsoft',
      tenantId: r.tenant_id,
      addedBy: r.added_by,
      addedAt: new Date(r.added_at).toISOString(),
    })),
    microsoftPersonalAccountsAllowed: orgRows[0].microsoft_personal_accounts_allowed,
    warning: rows.length === 0 ? 'no_tenant_restriction' : null,
  }
}

/** Members of `orgId` the CURRENT policy (as this transaction sees it) refuses. */
async function refusedMembers(client: PoolClient, orgId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT m.user_id FROM org_members m
     JOIN users u ON u.id = m.user_id
     JOIN orgs o ON o.id = m.org_id
     WHERE m.org_id = $1 AND NOT ${tenantAllowedSql('u', 'o')}`,
    [orgId]
  )
  return new Set(rows.map((r) => r.user_id))
}

class Refusal {
  constructor(readonly status: number, readonly error: string) {}
}

/**
 * Run one policy change: lock the org, snapshot who is refused, `apply`, then
 * refuse a self-lockout, and bump every newly refused member's epoch — all in
 * one transaction, so no session can be minted between the policy change and
 * the revocation of what it forbids. Answers the revoked user ids.
 */
async function changePolicy(
  orgId: string,
  auth: Auth,
  apply: (client: PoolClient) => Promise<void>
): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE', [orgId])
    if (rows.length === 0) throw new Refusal(404, 'Org not found')
    const before = await refusedMembers(client, orgId)
    await apply(client)
    const after = await refusedMembers(client, orgId)
    if (!auth.isPlatformAdmin && after.has(auth.userId)) throw new Refusal(409, 'would_lock_out_self')
    const revoked = [...after].filter((id) => !before.has(id))
    for (const userId of revoked) {
      await client.query('SELECT bump_auth_user_epoch($1, $2)', [orgId, userId])
    }
    await client.query('COMMIT')
    return revoked
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function answerError(res: Response, context: string, err: unknown): void {
  if (err instanceof Refusal) {
    res.status(err.status).json({ error: err.error })
    return
  }
  console.error(`[orgTenantRoutes] ${context} failed:`, err)
  res.status(500).json({ error: context })
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ')
}

export function registerOrgTenantRoutes(app: Express): void {
  app.get('/api/orgs/:orgId/idp-tenants', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    try {
      const policy = await readPolicy(pool, paramStr(req.params.orgId))
      if (!policy) {
        res.status(404).json({ error: 'Org not found' })
        return
      }
      res.json(policy)
    } catch (err) {
      answerError(res, 'Failed to load allowed tenants', err)
    }
  })

  app.post('/api/orgs/:orgId/idp-tenants', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const parsed = addTenantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_tenant', message: zodMessage(parsed.error) })
      return
    }
    const { tenantId } = parsed.data
    if (tenantId === MICROSOFT_PERSONAL_TENANT_ID) {
      // Personal accounts are a policy switch, not a list entry — one place
      // decides them, so the two can never disagree.
      res.status(400).json({ error: 'personal_tenant_is_a_policy' })
      return
    }
    const orgId = paramStr(req.params.orgId)
    try {
      const revoked = await changePolicy(orgId, auth, async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO org_allowed_idp_tenants (org_id, provider, tenant_id, added_by)
           VALUES ($1, 'microsoft', $2, $3) ON CONFLICT DO NOTHING`,
          [orgId, tenantId, auth.userId]
        )
        if ((rowCount ?? 0) === 0) throw new Refusal(409, 'already_allowed')
      })
      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'org.idp_tenant_added',
        targetKind: 'org',
        targetId: orgId,
        detail: { provider: 'microsoft', tenantId, revokedUserIds: revoked },
      })
      res.status(201).json({ ...(await readPolicy(pool, orgId)), revokedMembers: revoked.length })
    } catch (err) {
      answerError(res, 'Failed to add allowed tenant', err)
    }
  })

  app.delete('/api/orgs/:orgId/idp-tenants/:tenantId', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const parsed = tenantIdSchema.safeParse(paramStr(req.params.tenantId))
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_tenant', message: zodMessage(parsed.error) })
      return
    }
    const tenantId = parsed.data
    const orgId = paramStr(req.params.orgId)
    try {
      const revoked = await changePolicy(orgId, auth, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM org_allowed_idp_tenants WHERE org_id = $1 AND provider = 'microsoft' AND tenant_id = $2`,
          [orgId, tenantId]
        )
        if ((rowCount ?? 0) === 0) throw new Refusal(404, 'tenant_not_listed')
      })
      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'org.idp_tenant_removed',
        targetKind: 'org',
        targetId: orgId,
        detail: { provider: 'microsoft', tenantId, revokedUserIds: revoked },
      })
      res.json({ ...(await readPolicy(pool, orgId)), revokedMembers: revoked.length })
    } catch (err) {
      answerError(res, 'Failed to remove allowed tenant', err)
    }
  })

  app.patch('/api/orgs/:orgId/idp-tenant-policy', async (req, res) => {
    const auth = await requireOrgAdmin(req, res)
    if (!auth) return
    const parsed = policySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_policy', message: zodMessage(parsed.error) })
      return
    }
    const allowed = parsed.data.microsoftPersonalAccountsAllowed
    const orgId = paramStr(req.params.orgId)
    try {
      const revoked = await changePolicy(orgId, auth, async (client) => {
        await client.query('UPDATE orgs SET microsoft_personal_accounts_allowed = $2 WHERE id = $1', [orgId, allowed])
      })
      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'org.idp_tenant_policy_changed',
        targetKind: 'org',
        targetId: orgId,
        detail: { microsoftPersonalAccountsAllowed: allowed, revokedUserIds: revoked },
      })
      res.json({ ...(await readPolicy(pool, orgId)), revokedMembers: revoked.length })
    } catch (err) {
      answerError(res, 'Failed to update tenant policy', err)
    }
  })
}
