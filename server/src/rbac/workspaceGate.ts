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

import type { Pool } from 'pg'
import type { Request, Response } from 'express'
import type { WorkspaceKey } from '../readModel/projector.js'
import { authStage } from '../auth/middleware.js'
import { ensureDefaultOrg } from '../auth/schema.js'
import { allowedWorkspaceKeys, writableWorkspaceKeys } from './docScope.js'
import { explainAccess } from './access.js'

/**
 * Shared org/workspace access gates for the landscape + Automerge-root + read
 * model HTTP surface. Everything here honors the staged-auth rollout
 * (auth/middleware.ts `authStage`) with the SAME semantics as `requireAuth`:
 *
 *   - 'off'          → always allow (byte-identical pre-auth behavior).
 *   - claims absent  → allow (stage 'off'/'dual' with no cookie; stage 'on'
 *                      never reaches here since requireAuth 401s first).
 *   - claims present → enforce, except 'dual' logs a warning and allows
 *                      (telemetry to find misscoped clients without breaking
 *                      them).
 */

/**
 * Resolve the 'current' version sentinel to the landscape's REAL default
 * version id (landscapes.default_version_id — the same resolution
 * resolveRootUrl does). Everything downstream is keyed CANONICALLY: ro_* rows,
 * the fleet's LRU entries, and the access check all use real version ids, so
 *   - the same workspace addressed as 'current' and by its real id never
 *     splits into two disjoint row-sets, and
 *   - `allowedWorkspaceKeys` (built from the scopes table's real ids) matches —
 *     with alias keys the check denied EVERYONE, platform admins included.
 * Also means a set-default repoint naturally switches 'current' callers to the
 * new head's rows instead of serving rows projected from the old head.
 * Returns null when the landscape doesn't exist (caller 404s).
 */
export async function canonicalWorkspaceKey(pool: Pool, key: WorkspaceKey): Promise<WorkspaceKey | null> {
  if (key.versionId !== 'current') return key
  try {
    const { rows } = await pool.query<{ default_version_id: string | null }>(
      'SELECT default_version_id FROM landscapes WHERE id = $1',
      [key.landscapeId]
    )
    const vid = rows[0]?.default_version_id
    return vid ? { landscapeId: key.landscapeId, versionId: vid } : null
  } catch (err) {
    console.error('[workspace-gate] canonicalWorkspaceKey failed:', err)
    return null
  }
}

/** Stage-aware workspace READ gate (see module doc): true = allowed. `key`
 * must be canonical (real version id, not 'current'). */
export async function checkWorkspaceAccess(pool: Pool, req: Request, key: WorkspaceKey): Promise<boolean> {
  const stage = authStage()
  if (stage === 'off') return true
  const claims = req.auth
  if (!claims) return true
  const allowed = await allowedWorkspaceKeys(pool, claims)
  if (allowed.has(`${key.landscapeId}/${key.versionId}`)) return true
  if (stage === 'dual') {
    console.warn(`[workspace-gate] dual: ${claims.userId} lacks read on ${key.landscapeId}/${key.versionId}`)
    return true
  }
  return false // stage 'on'
}

/**
 * The org a request acts AS for resource creation:
 *   - stage 'off' or no claims → the Default Org (legacy single-tenant world);
 *   - a session → its pinned org, which may be NULL (an invite-intent login
 *     that never joined an org) — callers must refuse creation in that case
 *     rather than silently landing resources in the Default Org.
 */
export async function sessionOrgId(pool: Pool, req: Request): Promise<string | null> {
  if (authStage() === 'off' || !req.auth) return ensureDefaultOrg(pool)
  return req.auth.orgId
}

/**
 * Landscape-in-session-org gate for every `/api/landscapes/:landscapeId/*`
 * mutation/list endpoint. Returns true when the caller may proceed; writes the
 * 403 itself otherwise. A MISSING landscape passes the gate — the endpoint's
 * own lookup 404s exactly as before, and doing it here would duplicate (and
 * risk diverging from) that behavior. Platform admins bypass (their console
 * legitimately operates across orgs).
 */
export async function requireLandscapeInOrg(
  pool: Pool,
  req: Request,
  res: Response,
  landscapeId: string
): Promise<boolean> {
  const stage = authStage()
  if (stage === 'off') return true
  const claims = req.auth
  if (!claims) return true
  if (claims.isPlatformAdmin) return true
  try {
    const { rows } = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM landscapes WHERE id = $1',
      [landscapeId]
    )
    if (rows.length === 0) return true // let the endpoint's own lookup 404
    const owner = rows[0].org_id
    if (owner !== null && owner === claims.orgId) return true
    if (stage === 'dual') {
      console.warn(
        `[workspace-gate] dual: ${claims.userId} (org ${claims.orgId ?? 'none'}) touched landscape ${landscapeId} owned by ${owner ?? 'none'}`
      )
      return true
    }
    res.status(403).json({ error: 'forbidden' })
    return false
  } catch (err) {
    console.error('[workspace-gate] requireLandscapeInOrg failed:', err)
    res.status(500).json({ error: 'access check failed' })
    return false
  }
}

/** Operational endpoints (stats/GC/compaction): platform admin only once auth
 * is enforced; open below stage 'on' (unchanged legacy/dev behavior). */
export function requirePlatformAdminAtStageOn(req: Request, res: Response): boolean {
  if (authStage() !== 'on') return true
  if (req.auth?.isPlatformAdmin) return true
  res.status(403).json({ error: 'forbidden' })
  return false
}

// =====================================================================
// WRITE gates — org membership (requireLandscapeInOrg above) only proves the
// caller belongs to the owning org; these prove the caller may MUTATE. A
// read-only ("View") team grant passes the org gate and must fail these.
// Same staged semantics as everything else in this module: off/no-claims ->
// allow, dual -> warn + allow, on -> 403. Callers stack them AFTER
// requireLandscapeInOrg (org isolation first, then privilege level).
// =====================================================================

/** The winning scope row for a landscape (its owning org's landscape scope). */
async function landscapeScopeId(pool: Pool, landscapeId: string, orgId: string | null): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM scopes
     WHERE kind = 'landscape' AND landscape_id = $1 AND org_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
    [landscapeId, orgId]
  )
  return rows[0]?.id ?? null
}

interface WriteDecisionTarget {
  landscapeId: string
  /** When set, the check runs against the VERSION scope (which inherits
   * landscape/org grants via the ancestor chain) instead of the landscape
   * scope — so a team granted write on a single version passes for that
   * version's mutations without holding landscape-wide write. */
  versionId?: string
}

/** Shared body of requireLandscapeWrite / requireVersionWrite. */
async function requireWorkspaceWrite(
  pool: Pool,
  req: Request,
  res: Response,
  target: WriteDecisionTarget
): Promise<boolean> {
  const stage = authStage()
  if (stage === 'off') return true
  const claims = req.auth
  if (!claims) return true
  if (claims.isPlatformAdmin) return true
  try {
    const { rows } = await pool.query<{ org_id: string | null; status: string | null }>(
      `SELECT l.org_id, o.status FROM landscapes l LEFT JOIN orgs o ON o.id = l.org_id WHERE l.id = $1`,
      [target.landscapeId]
    )
    if (rows.length === 0) return true // missing landscape: the endpoint's own lookup 404s
    const ownerOrgId = rows[0].org_id
    const suspended = rows[0].status === 'suspended'

    let canWrite = false
    if (!suspended) {
      let scopeId: string | null = null
      if (target.versionId) {
        const { rows: vs } = await pool.query<{ id: string }>(
          `SELECT id FROM scopes
           WHERE kind = 'version' AND landscape_id = $1 AND version_id = $2
             AND org_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
          [target.landscapeId, target.versionId, ownerOrgId]
        )
        scopeId = vs[0]?.id ?? null
      }
      // Version scope not registered (or landscape-level target): decide on
      // the landscape scope — grants inherit DOWN, so this is never more
      // permissive than the version scope would have been.
      if (!scopeId) scopeId = await landscapeScopeId(pool, target.landscapeId, ownerOrgId)

      if (scopeId) {
        canWrite = (await explainAccess(pool, claims.userId, scopeId)).canWrite
      } else if (ownerOrgId) {
        // No scope row at all (pre-backfill edge): fail closed for members,
        // but an org admin of the owning org still writes.
        const { rows: admin } = await pool.query(
          `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin'`,
          [ownerOrgId, claims.userId]
        )
        canWrite = admin.length > 0
      }
    }

    if (canWrite) return true
    if (stage === 'dual') {
      console.warn(
        `[workspace-gate] dual: ${claims.userId} lacks WRITE on landscape ${target.landscapeId}` +
          (target.versionId ? `/${target.versionId}` : '')
      )
      return true
    }
    res.status(403).json({ error: 'forbidden' })
    return false
  } catch (err) {
    console.error('[workspace-gate] write gate failed:', err)
    res.status(500).json({ error: 'access check failed' })
    return false
  }
}

/** Landscape-level mutations (rename, create version/draft, set default,
 * snapshots): requires can_write on the landscape scope (org admins pass via
 * rbac_effective_access; a version-only grant does NOT restructure the
 * landscape). */
export async function requireLandscapeWrite(
  pool: Pool,
  req: Request,
  res: Response,
  landscapeId: string
): Promise<boolean> {
  return requireWorkspaceWrite(pool, req, res, { landscapeId })
}

/** Version-level mutations (rename/delete a version, merge a draft into its
 * parent): requires can_write on THAT version's scope — satisfied by a grant
 * on the version itself or any ancestor (landscape/org). */
export async function requireVersionWrite(
  pool: Pool,
  req: Request,
  res: Response,
  landscapeId: string,
  versionId: string
): Promise<boolean> {
  return requireWorkspaceWrite(pool, req, res, { landscapeId, versionId })
}

/**
 * Org-admin gate for org-shaping actions (create/delete a landscape): these
 * change what exists for EVERY team in the org — scope rows, grants, version
 * history — so a per-scope write grant is not enough. Suspended orgs are
 * refused outright at stage 'on'.
 */
export async function requireOrgAdmin(pool: Pool, req: Request, res: Response): Promise<boolean> {
  const stage = authStage()
  if (stage === 'off') return true
  const claims = req.auth
  if (!claims) return true
  if (claims.isPlatformAdmin) return true
  try {
    let allowed = false
    if (claims.orgId) {
      const { rows } = await pool.query<{ role: string; status: string | null }>(
        `SELECT m.role, o.status FROM org_members m JOIN orgs o ON o.id = m.org_id
         WHERE m.org_id = $1 AND m.user_id = $2`,
        [claims.orgId, claims.userId]
      )
      allowed = rows.length > 0 && rows[0].role === 'admin' && rows[0].status !== 'suspended'
    }
    if (allowed) return true
    if (stage === 'dual') {
      console.warn(`[workspace-gate] dual: ${claims.userId} is not an admin of org ${claims.orgId ?? 'none'}`)
      return true
    }
    res.status(403).json({ error: 'forbidden' })
    return false
  } catch (err) {
    console.error('[workspace-gate] org-admin gate failed:', err)
    res.status(500).json({ error: 'access check failed' })
    return false
  }
}

/**
 * The session's effective access to one canonical workspace key — the payload
 * of `GET /api/me/workspace-access`, which the client uses to lock its editor
 * UI read-only. `enforced` tells the client whether the server actually drops
 * writes (stage 'on'): below that, the UI must not lock anything (dual keeps
 * legacy behavior while telemetry runs).
 */
export async function workspaceAccessForRequest(
  pool: Pool,
  req: Request,
  key: WorkspaceKey
): Promise<{ canRead: boolean; canWrite: boolean; enforced: boolean }> {
  const stage = authStage()
  if (stage === 'off' || !req.auth) return { canRead: true, canWrite: true, enforced: false }
  const claims = req.auth
  const k = `${key.landscapeId}/${key.versionId}`
  const [readable, writable] = await Promise.all([
    allowedWorkspaceKeys(pool, claims),
    writableWorkspaceKeys(pool, claims),
  ])
  return { canRead: readable.has(k), canWrite: writable.has(k), enforced: stage === 'on' }
}
