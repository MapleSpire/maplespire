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
import type { Pool } from 'pg'
import type { Queryable } from '../../readModel/types.js'
import { appendAudit } from '../../auth/audit.js'
import { hashToken } from './crypto.js'
import { tenantAllowedSql } from '../../auth/tenantPolicy.js'

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

/**
 * PAT lifetime. A new PAT expires after `DEFAULT_PAT_TTL_DAYS` unless the org
 * sets `orgs.settings.aiTokenMaxDays` (integer, `MIN..MAX_PAT_TTL_DAYS`). That
 * value is both the default lifetime and the ceiling: a caller may ask for a
 * shorter expiry, a longer one is REFUSED (`PatExpiryTooLongError`), never
 * silently shortened. Tokens minted before this default existed keep whatever
 * `expires_at` they have (possibly NULL).
 */
export const DEFAULT_PAT_TTL_DAYS = 90
export const MIN_PAT_TTL_DAYS = 1
export const MAX_PAT_TTL_DAYS = 365

/** An org's stored setting → a valid ceiling; anything invalid reads as the default. */
export function normalizePatMaxDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PAT_TTL_DAYS
  return Math.min(MAX_PAT_TTL_DAYS, Math.max(MIN_PAT_TTL_DAYS, Math.floor(raw)))
}

export class PatExpiryTooLongError extends Error {
  constructor(readonly maxDays: number) {
    super(`expiresInDays exceeds the organization maximum of ${maxDays} days`)
    this.name = 'PatExpiryTooLongError'
  }
}

/**
 * The `expires_at` for a new PAT. `requestedDays` undefined → the org's
 * ceiling (default 90). Throws `PatExpiryTooLongError` above the ceiling and
 * RangeError for a non-positive / non-finite request (an absent expiry is no
 * longer expressible through this path).
 */
export async function resolvePatExpiry(
  db: Queryable,
  orgId: string | null,
  requestedDays: number | undefined,
  now: number = Date.now()
): Promise<Date> {
  let maxDays = DEFAULT_PAT_TTL_DAYS
  if (orgId) {
    const { rows } = await db.query<{ settings: { aiTokenMaxDays?: unknown } | null }>(
      `SELECT settings FROM orgs WHERE id = $1`,
      [orgId]
    )
    maxDays = normalizePatMaxDays(rows[0]?.settings?.aiTokenMaxDays)
  }
  if (requestedDays !== undefined && (!Number.isFinite(requestedDays) || requestedDays <= 0)) {
    throw new RangeError('expiresInDays must be a positive number')
  }
  const days = requestedDays ?? maxDays
  if (days > maxDays) throw new PatExpiryTooLongError(maxDays)
  return new Date(now + days * 24 * 60 * 60 * 1000)
}

/** Epochs a token was minted under (see ensureAiSchema); org/user are null only for org-less tokens. */
export interface TokenEpochPins {
  org: number | null
  user: number | null
  global: number | null
}

export interface VerifiedAiToken {
  tokenId: string
  userId: string
  orgId: string | null
  scopes: string[]
  kind: 'pat' | 'oauth'
  expiresAt: Date | null
  pins: TokenEpochPins
}

function pinOf(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

function pinsOf(r: Record<string, unknown>): TokenEpochPins {
  return { org: pinOf(r.pin_org_epoch), user: pinOf(r.pin_user_epoch), global: pinOf(r.pin_global_epoch) }
}

export interface LiveTokenOwner {
  name: string | null
  email: string
  isPlatformAdmin: boolean
}

/**
 * The same refusals sessions apply, for a bearer token: owner missing or not
 * `active`; org missing or `suspended`; and any pinned epoch that is no longer
 * the current one (`isSessionEpochCurrent`'s equality rule: the user's global
 * epoch, then, for an org-scoped token, the org's and the user's-in-org).
 * Epochs are compared by equality with the value pinned at mint, not by
 * timestamp: the epoch tables carry no time, and a session pins the same way.
 * An org-scoped token is also refused when the org's Entra tenant allowlist
 * refuses its owner (auth/tenantPolicy.ts).
 * Returns the owner on success, null on any refusal.
 */
export async function loadLiveTokenOwner(
  db: Queryable,
  t: Pick<VerifiedAiToken, 'userId' | 'orgId' | 'pins'>
): Promise<LiveTokenOwner | null> {
  const { rows } = await db.query<{
    name: string | null
    email: string
    is_platform_admin: boolean
    status: string
    gepoch: number | string
    org_status: string | null
    epoch: number | string
    uepoch: number | string
    tenant_ok: boolean
  }>(
    `SELECT u.name, u.email, u.is_platform_admin, u.status,
            COALESCE(g.epoch, 1) AS gepoch,
            o.status AS org_status,
            COALESCE(e.epoch, 1) AS epoch,
            COALESCE(ue.epoch, 1) AS uepoch,
            ${tenantAllowedSql('u', 'o')} AS tenant_ok
     FROM users u
     LEFT JOIN auth_global_epochs g ON g.user_id = u.id
     LEFT JOIN orgs o ON o.id = $2::text
     LEFT JOIN auth_epochs e ON e.org_id = $2::text
     LEFT JOIN auth_user_epochs ue ON ue.org_id = $2::text AND ue.user_id = u.id
     WHERE u.id = $1`,
    [t.userId, t.orgId]
  )
  const r = rows[0]
  if (!r || r.status !== 'active') return null
  // A missing pin FAILS CLOSED. ensureAiSchema backfills every pre-existing row
  // and createAiToken always writes the pins, so a NULL global pin, or a NULL
  // org/user pin on an org-scoped token, means a row that bypassed both.
  if (t.pins.global === null || Number(r.gepoch) !== t.pins.global) return null
  if (t.orgId) {
    if (!r.org_status || r.org_status === 'suspended') return null
    if (t.pins.org === null || Number(r.epoch) !== t.pins.org) return null
    if (t.pins.user === null || Number(r.uepoch) !== t.pins.user) return null
    // V0-02: the org's Entra tenant allowlist, evaluated live in the same
    // statement as the pins — beside the per-user epoch a policy change bumps,
    // not instead of it. Also covers the MCP refresh grant (oauth.ts), which
    // calls this before rotating. Strictly `false`: the
    // column is COALESCEd, so Postgres never answers NULL; DB-free tests stub
    // this read without it.
    if (r.tenant_ok === false) return null
  }
  return { name: r.name, email: r.email, isPlatformAdmin: !!r.is_platform_admin }
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
  /** Absolute expiry; null/undefined = non-expiring. PAT routes pass `resolvePatExpiry(...)`. */
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
    // Epochs are pinned by subselect in the same statement as the insert (one
    // snapshot), like signCurrentSession reads them with the facts they vouch for.
    `INSERT INTO ai_api_tokens (id, kind, user_id, org_id, name, token_hash, token_prefix, scopes, client_id, refresh_token_hash, expires_at,
                                pin_global_epoch, pin_org_epoch, pin_user_epoch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             COALESCE((SELECT epoch FROM auth_global_epochs WHERE user_id = $3), 1),
             CASE WHEN $4::text IS NULL THEN NULL
                  ELSE COALESCE((SELECT epoch FROM auth_epochs WHERE org_id = $4::text), 1) END,
             CASE WHEN $4::text IS NULL THEN NULL
                  ELSE COALESCE((SELECT epoch FROM auth_user_epochs WHERE org_id = $4::text AND user_id = $3), 1) END)
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
    `SELECT id, kind, user_id, org_id, scopes, expires_at, revoked_at, last_used_at,
            pin_org_epoch, pin_user_epoch, pin_global_epoch
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
    pins: pinsOf(r),
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

/**
 * Who revokes. `owner` may only revoke their own token (the id is matched
 * together with `user_id`); `admin` and `system` revoke whoever owns it, so
 * the CALLER must have authorised them. `system` is the server acting on the
 * owner's behalf (OAuth refresh rotation) and records the owner as actor.
 */
export type RevokeActor =
  | { role: 'owner'; userId: string; impersonatorUserId?: string | null }
  | { role: 'admin'; userId: string; impersonatorUserId?: string | null }
  | { role: 'system'; userId: string }

export const SELF_REVOKE_REASON = 'revoked by owner'
const MAX_REVOKE_REASON = 500

export interface RevokedToken {
  tokenId: string
  ownerUserId: string
  orgId: string | null
  kind: 'pat' | 'oauth'
  revokedAt: string
}

/**
 * THE revocation path: every token revocation goes through here so each one
 * leaves an `audit_log` event (`ai_token.revoked`: actor, impersonator, token
 * id as target, owner + reason + role + kind + revokedAt in detail, `at` =
 * the same transaction timestamp as `revoked_at`).
 *
 * The UPDATE and the audit insert share one transaction: a revocation is
 * never committed unaudited, and an audit failure leaves the token live and
 * throws (the caller answers 500 and can retry). Returns null when there is
 * nothing to revoke (unknown id, already revoked, or — for `owner` — someone
 * else's token); nothing is written then.
 *
 * `reason`: required non-empty for `admin` and `system` (RangeError
 * otherwise); for `owner` an empty one becomes `SELF_REVOKE_REASON`.
 * Trimmed, and capped at 500 characters.
 */
export async function revokeToken(
  db: Pool,
  tokenId: string,
  reason: string | null | undefined,
  actor: RevokeActor
): Promise<RevokedToken | null> {
  let why = (reason ?? '').trim()
  if (!why) {
    if (actor.role !== 'owner') throw new RangeError(`a ${actor.role} token revocation requires a reason`)
    why = SELF_REVOKE_REASON
  }
  why = why.slice(0, MAX_REVOKE_REASON)

  const client = await db.connect()
  // Set when ROLLBACK itself failed: the connection's state is unknown, so it
  // is destroyed on release instead of returned to the pool.
  let discard: Error | undefined
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string; user_id: string; org_id: string | null; kind: string; revoked_at: Date }>(
      `UPDATE ai_api_tokens SET revoked_at = NOW()
       WHERE id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR user_id = $2::text)
       RETURNING id, user_id, org_id, kind, revoked_at`,
      [tokenId, actor.role === 'owner' ? actor.userId : null]
    )
    const r = rows[0]
    if (!r) {
      await client.query('ROLLBACK')
      return null
    }
    const revoked: RevokedToken = {
      tokenId: r.id,
      ownerUserId: r.user_id,
      orgId: r.org_id ?? null,
      kind: r.kind === 'oauth' ? 'oauth' : 'pat',
      revokedAt: new Date(r.revoked_at).toISOString(),
    }
    await appendAudit(client, {
      orgId: revoked.orgId,
      actorUserId: actor.userId,
      impersonatorUserId: actor.role === 'system' ? null : (actor.impersonatorUserId ?? null),
      action: 'ai_token.revoked',
      targetKind: 'ai_token',
      targetId: revoked.tokenId,
      detail: {
        ownerUserId: revoked.ownerUserId,
        reason: why,
        actorRole: actor.role,
        tokenKind: revoked.kind,
        revokedAt: revoked.revokedAt,
      },
    })
    await client.query('COMMIT')
    return revoked
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      discard = rollbackErr as Error
    }
    throw err
  } finally {
    client.release(discard)
  }
}

/** Look up an OAuth-minted access token row by its REFRESH token (for rotation). */
export async function findByRefreshToken(db: Queryable, refreshToken: string): Promise<VerifiedAiToken | null> {
  const { rows } = await db.query(
    `SELECT id, kind, user_id, org_id, scopes, expires_at, revoked_at,
            pin_org_epoch, pin_user_epoch, pin_global_epoch FROM ai_api_tokens
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
    pins: pinsOf(r),
  }
}
