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
import { pool } from '../db.js'
import { setSessionCookie } from './tokens.js'
import { mintRefusalBody, signCurrentSession } from './sessionEpoch.js'
import { appendAudit } from './audit.js'
import { provisionOrgWithLandscape } from './provisioning.js'
import { createDistributedRateLimiter } from '../runtime/rateLimiter.js'
import { RedisUnavailableError } from '../runtime/redis.js'

/**
 * Multi-org user-facing endpoints:
 *   - GET  /api/me/orgs        — the signed-in user's memberships (the org
 *     switcher + the client's boot-time workspace resolution).
 *   - POST /api/orgs           — create ANOTHER org (full provisioning:
 *     admin membership + landscape + starter diagram), rate-limited.
 *   - POST /api/auth/switch-org — re-pin the session to another org the user
 *     belongs to (fresh cookie carrying that org's epoch). The client hard-
 *     reloads afterwards: the Automerge WS claims are bound at upgrade time,
 *     so an in-place store swap would keep syncing under the old org.
 */

const ORG_CREATES_PER_DAY = 5
const ORG_CREATE_WINDOW_MS = 24 * 60 * 60 * 1_000
const orgCreateRateLimiter = createDistributedRateLimiter({ maxMemoryKeys: 25_000 })

async function checkOrgCreateRateLimit(userId: string) {
  return orgCreateRateLimiter.consume({
    namespace: 'org_create',
    identity: userId,
    limit: ORG_CREATES_PER_DAY,
    windowMs: ORG_CREATE_WINDOW_MS,
  })
}


export function registerOrgRoutes(app: Express): void {
  app.get('/api/me/orgs', async (req: Request, res: Response) => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    try {
      const { rows } = await pool.query<{
        id: string
        name: string
        status: string
        default_landscape_id: string | null
        role: string
      }>(
        `SELECT o.id, o.name, o.status, o.default_landscape_id, om.role
         FROM org_members om
         JOIN orgs o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY om.created_at`,
        [auth.userId]
      )
      res.json({
        orgs: rows.map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role,
          status: r.status,
          defaultLandscapeId: r.default_landscape_id,
          isCurrent: r.id === auth.orgId,
        })),
      })
    } catch (err) {
      console.error('GET /api/me/orgs error:', err)
      res.status(500).json({ error: 'Failed to list organizations' })
    }
  })

  // Create ANOTHER org for the signed-in user — the same full provisioning as
  // a first login (org + admin membership + landscape + starter diagram), so
  // the org is immediately usable after the switch.
  app.post('/api/orgs', async (req: Request, res: Response) => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    try {
      const { rows: userRows } = await pool.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [auth.userId]
      )
      if (userRows[0]?.status !== 'active') {
        res.status(403).json({ error: 'forbidden' })
        return
      }

      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      if (!name || name.length > 200) {
        res.status(400).json({ error: 'A name (1-200 characters) is required' })
        return
      }
      const rate = await checkOrgCreateRateLimit(auth.userId)
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds))
        res.status(429).json({ error: 'rate_limited', message: 'Too many new organizations today — try again tomorrow.' })
        return
      }

      const result = await provisionOrgWithLandscape(pool, { name, ownerUserId: auth.userId })
      if (!result) {
        // Unreachable without onlyIfNoMembership, but keep the contract honest.
        res.status(500).json({ error: 'Failed to create organization' })
        return
      }

      await appendAudit(pool, {
        orgId: result.orgId,
        actorUserId: auth.userId,
        impersonatorUserId: auth.imp?.by,
        action: 'org.created',
        targetKind: 'org',
        targetId: result.orgId,
        detail: { name },
      })

      res.status(201).json({ org: { id: result.orgId, name, defaultLandscapeId: result.landscapeId } })
    } catch (err) {
      if (err instanceof RedisUnavailableError) {
        res.status(503).setHeader('Retry-After', '1')
        res.json({ error: 'rate_limit_unavailable', message: 'Organization creation is temporarily unavailable.' })
        return
      }
      console.error('POST /api/orgs error:', err)
      res.status(500).json({ error: 'Failed to create organization' })
    }
  })

  // Re-pin the session to another org. Verifies a live, ACTIVE membership in
  // an ACTIVE org on every call (never trusts the token), refuses while
  // impersonating (an admin driving someone's session must not leave it in a
  // different org than they found it).
  app.post('/api/auth/switch-org', async (req: Request, res: Response) => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    if (auth.imp) {
      res.status(403).json({ error: 'forbidden_while_impersonating' })
      return
    }
    const orgId = typeof req.body?.orgId === 'string' ? req.body.orgId : ''
    if (!orgId) {
      res.status(400).json({ error: 'orgId is required' })
      return
    }
    try {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT o.status FROM org_members om JOIN orgs o ON o.id = om.org_id
         WHERE om.org_id = $1 AND om.user_id = $2`,
        [orgId, auth.userId]
      )
      if (rows.length === 0) {
        res.status(403).json({ error: 'not_a_member' })
        return
      }
      if (rows[0].status === 'suspended') {
        res.status(403).json({ error: 'org_suspended' })
        return
      }

      await pool.query('UPDATE users SET last_org_id = $2 WHERE id = $1', [auth.userId, orgId])
      const token = await signCurrentSession(pool, {
        userId: auth.userId,
        orgId,
        isPlatformAdmin: auth.isPlatformAdmin,
      })
      setSessionCookie(res, token)

      await appendAudit(pool, {
        orgId,
        actorUserId: auth.userId,
        action: 'auth.org-switched',
        targetKind: 'org',
        targetId: orgId,
        detail: { from: auth.orgId },
      })

      res.json({ orgId })
    } catch (err) {
      const refused = mintRefusalBody(err)
      if (refused) {
        res.status(403).json(refused)
        return
      }
      console.error('POST /api/auth/switch-org error:', err)
      res.status(500).json({ error: 'Failed to switch organization' })
    }
  })
}
