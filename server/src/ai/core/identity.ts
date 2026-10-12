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

import type { Queryable } from '../../readModel/types.js'
import type { SessionClaims } from '../../auth/tokens.js'
import { verifyAiToken } from './tokens.js'

/**
 * The ONE place caller identity is normalized for the AI feature. Every
 * adapter resolves whoever is calling — SPA session cookie, `bvr_` PAT, or an
 * OAuth-minted MCP token — into the same `AiIdentity`, and the core only ever
 * sees that. Keeps the core express-free and makes "who can this adapter act
 * as" a single audited code path.
 */
export interface AiIdentity {
  userId: string
  orgId: string | null
  isPlatformAdmin: boolean
  via: 'session' | 'pat' | 'oauth'
  scopes: string[]
  /** Set for bearer identities (revocation/audit handle). */
  tokenId?: string
  /** Display name/email for authored artifacts (comments, ADRs). */
  label?: string
}

/** Session cookie claims (auth/middleware) → identity. */
export function identityFromClaims(claims: SessionClaims, label?: string): AiIdentity {
  return {
    userId: claims.userId,
    orgId: claims.orgId,
    isPlatformAdmin: claims.isPlatformAdmin,
    via: 'session',
    scopes: ['mcp'],
    ...(label ? { label } : {}),
  }
}

/**
 * Identity → the claims shape the existing RBAC gates read (`req.auth`).
 * `epoch: 0` is fine here: the epoch check belongs to session/WS verification;
 * bearer tokens are validated against the live DB row on every call instead.
 */
export function identityToClaims(id: AiIdentity): SessionClaims {
  return {
    userId: id.userId,
    orgId: id.orgId,
    isPlatformAdmin: id.isPlatformAdmin,
    epoch: 0,
  }
}

/**
 * Verify a presented bearer token and hydrate the owning user (must still be
 * active). Returns null for anything invalid — adapters answer 401 on null.
 */
export async function verifyBearerIdentity(db: Queryable, token: string): Promise<AiIdentity | null> {
  const verified = await verifyAiToken(db, token)
  if (!verified) return null
  const { rows } = await db.query<{ name: string | null; email: string; is_platform_admin: boolean; status: string }>(
    `SELECT name, email, is_platform_admin, status FROM users WHERE id = $1`,
    [verified.userId]
  )
  const user = rows[0]
  if (!user || user.status !== 'active') return null
  return {
    userId: verified.userId,
    orgId: verified.orgId,
    isPlatformAdmin: !!user.is_platform_admin,
    via: verified.kind === 'oauth' ? 'oauth' : 'pat',
    scopes: verified.scopes,
    tokenId: verified.tokenId,
    label: user.name ?? user.email,
  }
}
