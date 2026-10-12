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

import type { Request, Response } from 'express'
import type { Pool } from 'pg'
import { authStage } from '../auth/middleware.js'
import type { TechnologyCapability } from './types.js'

export interface TechnologyActor {
  userId: string
  orgId: string | null
  isPlatformAdmin: boolean
  orgRole: 'admin' | 'member' | null
  capability: TechnologyCapability
}

const PLATFORM_CAPABILITIES = new Set<TechnologyCapability>([
  'technology.platform_publish',
  'technology.platform_merge',
  'technology.platform_reject',
])

const ORG_ADMIN_CAPABILITIES = new Set<TechnologyCapability>([
  'technology.manage',
  'technology.approve_private',
  'technology.submit_public',
  'technology.manage_policy',
])

/**
 * Fresh database authorization for every technology action. Session claims
 * identify the caller, but neither a stale platform flag nor an old org role
 * grants catalog capabilities.
 */
export async function requireTechnologyCapability(
  pool: Pool,
  req: Request,
  res: Response,
  capability: TechnologyCapability,
  orgId: string | null = null
): Promise<TechnologyActor | null> {
  const stage = authStage()
  if (stage === 'off') {
    return { userId: 'system:local-development', orgId, isPlatformAdmin: true, orgRole: null, capability }
  }

  const claims = req.auth
  if (!claims) {
    // Dual mode preserves the rollout contract of the rest of the server.
    if (stage === 'dual') {
      return { userId: 'system:dual-anonymous', orgId, isPlatformAdmin: false, orgRole: 'admin', capability }
    }
    res.status(401).json({ error: 'Authentication required' })
    return null
  }

  try {
    const { rows: users } = await pool.query<{ is_platform_admin: boolean; status: string }>(
      'SELECT is_platform_admin, status FROM users WHERE id = $1',
      [claims.userId]
    )
    const user = users[0]
    if (!user || user.status !== 'active') {
      res.status(403).json({ error: 'Active user required' })
      return null
    }

    if (user.is_platform_admin) {
      return { userId: claims.userId, orgId, isPlatformAdmin: true, orgRole: null, capability }
    }
    if (PLATFORM_CAPABILITIES.has(capability)) {
      res.status(403).json({ error: 'Platform admin access required' })
      return null
    }
    if (!orgId || claims.orgId !== orgId) {
      res.status(403).json({ error: 'Organization access required' })
      return null
    }

    const { rows: memberships } = await pool.query<{ role: string; org_status: string }>(
      `SELECT m.role, o.status AS org_status
       FROM org_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.org_id = $1 AND m.user_id = $2`,
      [orgId, claims.userId]
    )
    const membership = memberships[0]
    if (!membership || membership.org_status !== 'active') {
      res.status(403).json({ error: 'Organization membership required' })
      return null
    }
    if (ORG_ADMIN_CAPABILITIES.has(capability) && membership.role !== 'admin') {
      res.status(403).json({ error: 'Organization admin access required' })
      return null
    }

    return {
      userId: claims.userId,
      orgId,
      isPlatformAdmin: false,
      orgRole: membership.role === 'admin' ? 'admin' : 'member',
      capability,
    }
  } catch (error) {
    console.error('[technologies] capability check failed:', error)
    res.status(500).json({ error: 'Technology access check failed' })
    return null
  }
}
