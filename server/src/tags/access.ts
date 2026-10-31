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
import { explainAccess } from '../rbac/access.js'
import { canonicalWorkspaceKey, workspaceAccessForRequest } from '../rbac/workspaceGate.js'
import { sendDependencyOutage } from '../runtime/dependencyOutageResponse.js'
import type { TagActor, TagCapability, TagWorkspaceContext } from './types.js'

const ADMIN_ONLY = new Set<TagCapability>(['tag.audit_view', 'tag.archive', 'tag.merge', 'tag.restore', 'tag.manage_policy'])

async function hasCatalogWrite(pool: Pool, userId: string, orgId: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM scopes WHERE org_id = $1 AND kind = 'org' AND deleted_at IS NULL LIMIT 1`,
    [orgId],
  )
  if (!rows[0]) return false
  return (await explainAccess(pool, userId, rows[0].id, 'tag_catalog')).canWrite
}
async function hasWorkspaceWrite(
  pool: Pool,
  req: Request,
  orgId: string,
  workspace: TagWorkspaceContext | null,
): Promise<boolean> {
  if (!workspace) return false
  const canonical = await canonicalWorkspaceKey(pool, workspace)
  if (!canonical) return false
  const { rows } = await pool.query<{ org_id: string | null }>(
    `SELECT org_id FROM landscapes WHERE id = $1`, [canonical.landscapeId],
  )
  if (rows[0]?.org_id !== orgId) return false
  return (await workspaceAccessForRequest(pool, req, canonical)).canWrite
}

/**
 * Authorizes every catalog request from fresh database state. Platform admin
 * status alone deliberately grants no tenant catalog access: the actor must
 * be an active member of the target organization.
 */
export async function requireTagCapability(
  pool: Pool,
  req: Request,
  res: Response,
  capability: TagCapability,
  orgId: string,
  workspace: TagWorkspaceContext | null = null,
): Promise<TagActor | null> {
  const stage = authStage()
  if (stage === 'off') {
    return { userId: 'system:local-development', orgId, orgRole: 'admin', capability }
  }
  const claims = req.auth
  if (!claims) {
    if (stage === 'dual') return { userId: 'system:dual-anonymous', orgId, orgRole: 'admin', capability }
    res.status(401).json({ error: 'authentication_required' })
    return null
  }

  try {
    const { rows } = await pool.query<{
      user_status: string
      org_status: string
      role: string
    }>(
      `SELECT u.status AS user_status, o.status AS org_status, m.role
       FROM users u
       JOIN org_members m ON m.user_id = u.id AND m.org_id = $2
       JOIN orgs o ON o.id = m.org_id
       WHERE u.id = $1`,
      [claims.userId, orgId],
    )
    const membership = rows[0]
    if (!membership || membership.user_status !== 'active' || membership.org_status !== 'active' || claims.orgId !== orgId) {
      res.status(403).json({ error: 'organization_membership_required' })
      return null
    }
    const orgRole = membership.role === 'admin' ? 'admin' : 'member'
    const actor: TagActor = { userId: claims.userId, orgId, orgRole, capability }
    if (orgRole === 'admin' || capability === 'tag.view') return actor
    if (ADMIN_ONLY.has(capability)) {
      res.status(403).json({ error: 'organization_admin_required' })
      return null
    }

    const catalogWrite = await hasCatalogWrite(pool, claims.userId, orgId)
    if (capability === 'tag.catalog_edit') {
      if (catalogWrite) return actor
      res.status(403).json({ error: 'tag_catalog_write_required' })
      return null
    }

    const { rows: settingsRows } = await pool.query<{
      allow_member_tag_creation: boolean
      allow_editor_tag_group_creation: boolean
    }>(
      `SELECT allow_member_tag_creation, allow_editor_tag_group_creation
       FROM org_tag_settings WHERE org_id = $1`,
      [orgId],
    )
    const settings = settingsRows[0] ?? {
      allow_member_tag_creation: true,
      allow_editor_tag_group_creation: false,
    }
    const policyAllows = capability === 'tag.create'
      ? settings.allow_member_tag_creation
      : settings.allow_editor_tag_group_creation
    if (!policyAllows) {
      res.status(403).json({ error: 'tag_creation_disabled_by_policy' })
      return null
    }
    if (catalogWrite || await hasWorkspaceWrite(pool, req, orgId, workspace)) return actor

    res.status(403).json({ error: 'writable_workspace_required' })
    return null
  } catch (error) {
    // A dependency outage — the registry read that canonicalises the
    // workspace of a workspace-scoped write (`hasWorkspaceWrite`) — is the
    // shared 503, not a failed check.
    if (sendDependencyOutage(res, error)) return null
    console.error('[tags] capability check failed:', error)
    res.status(500).json({ error: 'tag_access_check_failed' })
    return null
  }
}
