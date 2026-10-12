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
import type { Queryable } from '../../readModel/types.js'
import { hashToken } from './crypto.js'

/**
 * Bearer tokens for AI adapters (remote/local MCP, the tool REST API):
 * `bvr_<40 hex>` personal access tokens + OAuth-minted access/refresh pairs.
 * Only sha256 hashes are stored; the plaintext is returned exactly once at
 * mint time.
 */

export const TOKEN_PREFIX = 'bvr_'
export const DEFAULT_SCOPES = ['mcp'] as const

export interface AiTokenInfo {
  id: string
  kind: 'pat' | 'oauth'
  userId: string
  orgId: string | null
  name: string
  tokenPrefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface VerifiedAiToken {
  tokenId: string
  userId: string
  orgId: string | null
  scopes: string[]
  kind: 'pat' | 'oauth'
  expiresAt: Date | null
}

export function mintTokenString(): string {
  return `${TOKEN_PREFIX}${randomBytes(20).toString('hex')}`
}

function rowToInfo(r: Record<string, unknown>): AiTokenInfo {
  return {
    id: String(r.id),
    kind: (r.kind === 'oauth' ? 'oauth' : 'pat'),
    userId: String(r.user_id),
    orgId: (r.org_id as string | null) ?? null,
    name: String(r.name),
    tokenPrefix: String(r.token_prefix),
    scopes: (r.scopes as string[]) ?? [],
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }
}

export interface CreateTokenOpts {
  userId: string
  orgId: string | null
  name: string
  kind?: 'pat' | 'oauth'
  scopes?: string[]
  /** Absolute expiry; null/undefined = non-expiring (PATs default to this). */
  expiresAt?: Date | null
  clientId?: string | null
  refreshTokenHash?: string | null
}

/** Mint + persist a token. Returns the PLAINTEXT token (only time it exists). */
export async function createAiToken(db: Queryable, opts: CreateTokenOpts): Promise<{ token: string; info: AiTokenInfo }> {
  const token = mintTokenString()
  const id = randomBytes(12).toString('base64url')
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6) + '…'
  const { rows } = await db.query(
    `INSERT INTO ai_api_tokens (id, kind, user_id, org_id, name, token_hash, token_prefix, scopes, client_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      opts.kind ?? 'pat',
      opts.userId,
      opts.orgId,
      opts.name,
      hashToken(token),
      prefix,
      opts.scopes ?? [...DEFAULT_SCOPES],
      opts.clientId ?? null,
      opts.refreshTokenHash ?? null,
      opts.expiresAt ?? null,
    ]
  )
  return { token, info: rowToInfo(rows[0]) }
}

/**
 * Verify a presented bearer token: hash-lookup, revocation + expiry check.
 * Returns null for anything invalid — never throws on bad input. Touches
 * `last_used_at` at most once/minute (fire-and-forget) so verification stays
 * one indexed read on the hot path.
 */
export async function verifyAiToken(db: Queryable, token: string): Promise<VerifiedAiToken | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 20) return null
  const hash = hashToken(token)
  const { rows } = await db.query(
    `SELECT id, kind, user_id, org_id, scopes, expires_at, revoked_at, last_used_at
     FROM ai_api_tokens WHERE token_hash = $1`,
    [hash]
  )
  const r = rows[0]
  if (!r) return null
  if (r.revoked_at) return null
  const expiresAt = r.expires_at ? new Date(r.expires_at as string) : null
  if (expiresAt && expiresAt.getTime() < Date.now()) return null
  const lastUsed = r.last_used_at ? new Date(r.last_used_at as string).getTime() : 0
  if (Date.now() - lastUsed > 60_000) {
    void Promise.resolve(
      db.query(`UPDATE ai_api_tokens SET last_used_at = NOW() WHERE id = $1`, [r.id])
    ).catch(() => {})
  }
  return {
    tokenId: String(r.id),
    userId: String(r.user_id),
    orgId: (r.org_id as string | null) ?? null,
    scopes: (r.scopes as string[]) ?? [],
    kind: r.kind === 'oauth' ? 'oauth' : 'pat',
    expiresAt,
  }
}

export async function listAiTokens(db: Queryable, userId: string): Promise<AiTokenInfo[]> {
  const { rows } = await db.query(
    `SELECT * FROM ai_api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND kind = 'pat'
     ORDER BY created_at DESC`,
    [userId]
  )
  return rows.map(rowToInfo)
}

/** Revoke (soft-delete) one of the caller's own tokens. */
export async function revokeAiToken(db: Queryable, userId: string, tokenId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE ai_api_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId]
  )
  return (rowCount ?? 0) > 0
}

/** Look up an OAuth-minted access token row by its REFRESH token (for rotation). */
export async function findByRefreshToken(db: Queryable, refreshToken: string): Promise<VerifiedAiToken | null> {
  const { rows } = await db.query(
    `SELECT id, kind, user_id, org_id, scopes, expires_at, revoked_at FROM ai_api_tokens
     WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(refreshToken)]
  )
  const r = rows[0]
  if (!r) return null
  return {
    tokenId: String(r.id),
    userId: String(r.user_id),
    orgId: (r.org_id as string | null) ?? null,
    scopes: (r.scopes as string[]) ?? [],
    kind: r.kind === 'oauth' ? 'oauth' : 'pat',
    expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
  }
}

/** Revoke by id regardless of owner (OAuth rotation replaces the old row). */
export async function revokeTokenById(db: Queryable, tokenId: string): Promise<void> {
  await db.query(`UPDATE ai_api_tokens SET revoked_at = NOW() WHERE id = $1`, [tokenId])
}
