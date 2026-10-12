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
 * Append-only audit trail writer. `audit_log` itself enforces append-only at
 * the DB level (see schema.ts) — this is just the typed insert helper every
 * mutation in the auth/org/platform surfaces is expected to call.
 */
export interface AuditEvent {
  /** Null for platform-level events with no single owning org (org create, platform-admin grant, …). */
  orgId?: string | null
  actorUserId: string
  /** Set when the actor is a platform admin impersonating actorUserId — double-stamps the event. */
  impersonatorUserId?: string | null
  action: string
  targetKind: string
  targetId: string
  detail?: unknown
}

/**
 * Insert one audit event. Never throws a bare driver error upward — any
 * failure is wrapped with the action name so a caller's catch (or an
 * uncaught-rejection log) can tell which audited action failed to record,
 * without losing the underlying cause.
 */
export async function appendAudit(pool: Pool, e: AuditEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_user_id, impersonator_user_id, action, target_kind, target_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        e.orgId ?? null,
        e.actorUserId,
        e.impersonatorUserId ?? null,
        e.action,
        e.targetKind,
        e.targetId,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      ]
    )
  } catch (err) {
    throw new Error(`appendAudit failed for action "${e.action}": ${(err as Error).message}`, { cause: err })
  }
}
