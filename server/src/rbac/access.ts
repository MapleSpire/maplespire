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

/**
 * The decision layer future RLS policies will call from `SET LOCAL` context,
 * and that the API can call directly today (e.g. to gate a route by hand
 * before any policy exists). Backed by the `rbac_effective_access` SQL
 * function created in `ensureRbacSchema` (see `schema.ts`); keeping the
 * decision logic in SQL lets any server implementation share it.
 *
 * Semantics:
 *   - Deactivated users get no access at all.
 *   - An org admin of the target scope's org gets (read=true, write=true)
 *     via='org-admin', regardless of any team grant.
 *   - Otherwise: the best grant found across the target scope's ANCESTOR
 *     CHAIN (itself included) in `user_effective_permissions`. Read inherits
 *     DOWN from an ancestor grant (a landscape-level "View" grant makes every
 *     version/domain under it readable); write only counts when a grant
 *     itself allows it — write never comes from mere org MEMBERSHIP. An org
 *     member with no team grants anywhere gets no access at all (matches
 *     "matrix overrides hierarchy", with team grants as the matrix).
 */

export interface EffectiveAccessRow {
  canRead: boolean
  canWrite: boolean
  via: string
  grantScopeId: string | null
}

export interface ExplainAccessResult {
  allowed: boolean
  canRead: boolean
  canWrite: boolean
  /** 'org-admin' | 'team-grant' | 'none' */
  via: string
  /** The scope the winning grant actually lives on (may be an ancestor of `scopeId`), null when via='none'. */
  grantScopeId: string | null
  /** Raw rows returned by `rbac_effective_access`, for access-debugger UIs to show the full trace. */
  rawRows: EffectiveAccessRow[]
}

/**
 * TS wrapper around `rbac_effective_access(user_id, scope_id, resource_type)`.
 * Never throws for "no access" — that's a normal, expected result
 * (`allowed: false, via: 'none'`); it only throws on an actual DB/driver
 * error. Backs the org-admin "effective access preview" and the platform
 * "access debugger".
 */
export async function explainAccess(
  pool: Pool,
  userId: string,
  scopeId: string,
  resourceType: string = '*'
): Promise<ExplainAccessResult> {
  const { rows } = await pool.query<{ can_read: boolean; can_write: boolean; via: string; grant_scope_id: string | null }>(
    'SELECT can_read, can_write, via, grant_scope_id FROM rbac_effective_access($1, $2, $3)',
    [userId, scopeId, resourceType]
  )

  const rawRows: EffectiveAccessRow[] = rows.map((r) => ({
    canRead: r.can_read,
    canWrite: r.can_write,
    via: r.via,
    grantScopeId: r.grant_scope_id,
  }))

  if (rawRows.length === 0) {
    return { allowed: false, canRead: false, canWrite: false, via: 'none', grantScopeId: null, rawRows }
  }

  // rbac_effective_access returns at most one row today (org-admin short
  // circuits; the fallback path GROUP BYs into a single aggregate row), but
  // fold defensively in case that ever changes.
  const canRead = rawRows.some((r) => r.canRead)
  const canWrite = rawRows.some((r) => r.canWrite)
  const winning = rawRows.find((r) => r.canRead || r.canWrite) ?? rawRows[0]

  return {
    allowed: canRead || canWrite,
    canRead,
    canWrite,
    via: canRead || canWrite ? winning.via : 'none',
    grantScopeId: canRead || canWrite ? winning.grantScopeId : null,
    rawRows,
  }
}
