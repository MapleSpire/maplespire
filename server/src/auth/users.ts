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

import type { Pool, PoolClient } from 'pg'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendAudit } from './audit.js'

function newId(): string {
  return randomBytes(12).toString('base64url')
}

export type UserRecord = {
  id: string
  email: string
  isPlatformAdmin: boolean
  status: string
  givenName: string | null
  familyName: string | null
}

/** Split a display name into (given, family) on the FIRST space — the
 * fallback when the IdP sends `name` but not `given_name`/`family_name`.
 * "Olivier Albertini" → ("Olivier", "Albertini"); a single token is all
 * given-name. Only ever used to FILL missing values, never to overwrite. */
export function deriveNameParts(name: string | undefined): { givenName?: string; familyName?: string } {
  const trimmed = name?.trim()
  if (!trimmed) return {}
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { givenName: trimmed }
  return { givenName: trimmed.slice(0, idx), familyName: trimmed.slice(idx + 1).trim() }
}

/**
 * Find a user by `(issuer, subject)` — the real identity key (see
 * schema.ts) — creating one on first sight. On an existing user, refreshes
 * `email`/`name` when the IdP reports a change (e.g. the user renamed
 * themselves at Google) so our copy doesn't go stale, without touching
 * `status` or `is_platform_admin`. `given_name`/`family_name` are different:
 * they belong to the user once set (PATCH /api/me), so they're only FILLED
 * when currently NULL (COALESCE keeps the stored value) — an IdP refresh must
 * never clobber a profile edit. Missing given/family fall back to a split of
 * the display name.
 */
export async function findOrCreateUser(
  pool: Pool,
  a: { issuer: string; subject: string; email: string; name?: string; givenName?: string; familyName?: string }
): Promise<UserRecord> {
  const derived = deriveNameParts(a.name)
  const givenName = a.givenName?.trim() || derived.givenName || null
  const familyName = a.familyName?.trim() || derived.familyName || null

  const { rows } = await pool.query<{
    id: string
    email: string
    name: string | null
    given_name: string | null
    family_name: string | null
    is_platform_admin: boolean
    status: string
  }>(
    'SELECT id, email, name, given_name, family_name, is_platform_admin, status FROM users WHERE issuer = $1 AND subject = $2',
    [a.issuer, a.subject]
  )

  if (rows.length > 0) {
    const existing = rows[0]
    const name = a.name ?? null
    const needsFill = (existing.given_name === null && givenName !== null) || (existing.family_name === null && familyName !== null)
    if (existing.email !== a.email || existing.name !== name || needsFill) {
      await pool.query(
        `UPDATE users SET email = $2, name = $3,
           given_name = COALESCE(given_name, $4),
           family_name = COALESCE(family_name, $5)
         WHERE id = $1`,
        [existing.id, a.email, name, givenName, familyName]
      )
    }
    return {
      id: existing.id,
      email: a.email,
      isPlatformAdmin: existing.is_platform_admin,
      status: existing.status,
      givenName: existing.given_name ?? givenName,
      familyName: existing.family_name ?? familyName,
    }
  }

  const id = newId()
  const { rows: inserted } = await pool.query<{
    id: string
    email: string
    given_name: string | null
    family_name: string | null
    is_platform_admin: boolean
    status: string
  }>(
    `INSERT INTO users (id, issuer, subject, email, name, given_name, family_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (issuer, subject) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       given_name = COALESCE(users.given_name, EXCLUDED.given_name),
       family_name = COALESCE(users.family_name, EXCLUDED.family_name)
     RETURNING id, email, given_name, family_name, is_platform_admin, status`,
    [id, a.issuer, a.subject, a.email, a.name ?? null, givenName, familyName]
  )
  const row = inserted[0]
  return {
    id: row.id,
    email: row.email,
    isPlatformAdmin: row.is_platform_admin,
    status: row.status,
    givenName: row.given_name,
    familyName: row.family_name,
  }
}

/** A sign-in identity — the real key (`UNIQUE (issuer, subject)`). */
export type IdentityKey = { id: string; issuer: string; subject: string }

/**
 * The identities the operator named for the first platform admin. NEVER an
 * email claim (V0-02 / finding S1: the public Microsoft provider's email is
 * not proof of anything, so an email match let any Entra tenant claim the
 * bootstrap address):
 *   - `PLATFORM_ADMIN_BOOTSTRAP_ISSUER` + `PLATFORM_ADMIN_BOOTSTRAP_SUBJECT`
 *     — the explicit `(issuer, subject)` as stored in `users` (shown to the
 *     signed-in user by `GET /api/auth/me` → `user.identity`);
 *   - deprecated `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` — kept for existing dev
 *     scripts and stacks, but read as a SUBJECT on the two issuers whose
 *     subject IS the email by construction: `dev` (dev-login, lower-cased)
 *     and `local` (password accounts, lower-cased, and unable to sign in
 *     before the address is confirmed). It no longer matches any OIDC
 *     identity, whatever email that identity presents.
 */
function configuredBootstrapIdentities(): Array<{ issuer: string; subject: string }> {
  const out: Array<{ issuer: string; subject: string }> = []
  const issuer = process.env.PLATFORM_ADMIN_BOOTSTRAP_ISSUER?.trim()
  const subject = process.env.PLATFORM_ADMIN_BOOTSTRAP_SUBJECT?.trim()
  if (issuer && subject) out.push({ issuer, subject })
  const legacyEmail = process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase()
  if (legacyEmail) {
    out.push({ issuer: 'dev', subject: legacyEmail }, { issuer: 'local', subject: legacyEmail })
  }
  return out
}

/**
 * Grants `is_platform_admin` to `user` iff:
 *   1. `(user.issuer, user.subject)` is a configured bootstrap identity
 *      (`configuredBootstrapIdentities` — exact match, never by email), and
 *   2. no platform admin exists yet anywhere.
 *
 * Idempotent and safe to call on every login — it's a no-op once a platform
 * admin exists (whether that admin is this user or someone else). Audited
 * with `actorUserId: 'system'`, so the grant is never an unaudited SQL backdoor.
 * Returns true iff it just granted the flag.
 */
export async function bootstrapPlatformAdmin(pool: Pool, user: IdentityKey): Promise<boolean> {
  const match = configuredBootstrapIdentities().some(
    (c) => c.issuer === user.issuer && c.subject === user.subject,
  )
  if (!match) return false
  const granted = await grantFirstPlatformAdmin(pool, user.id)
  if (!granted) return false
  await appendAudit(pool, {
    orgId: null,
    actorUserId: 'system',
    action: 'platform_admin.bootstrap_grant',
    targetKind: 'user',
    targetId: user.id,
    detail: { via: 'identity', issuer: user.issuer, subject: user.subject },
  })
  return true
}

/** Minimum length of `PLATFORM_ADMIN_BOOTSTRAP_TOKEN`; a shorter value is
 * ignored (and the redemption route answers as if none were configured). */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export type BootstrapTokenOutcome = 'granted' | 'not_configured' | 'invalid_token' | 'already_used' | 'admin_exists'

/**
 * The out-of-band bootstrap: the operator sets `PLATFORM_ADMIN_BOOTSTRAP_TOKEN`
 * (≥ 32 chars, e.g. `openssl rand -base64 32`), signs in with any identity,
 * and presents the token (`POST /api/auth/bootstrap-platform-admin`). Grants
 * only while no platform admin exists, and only once per token: the digest
 * is inserted into `platform_admin_bootstrap_token_uses` in the same
 * transaction as the grant, so a second redemption — even after every admin
 * was later removed — is refused until the operator configures a new token.
 */
export async function redeemPlatformAdminBootstrapToken(
  pool: Pool,
  userId: string,
  presented: unknown,
): Promise<BootstrapTokenOutcome> {
  const configured = process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN ?? ''
  if (configured.length < MIN_BOOTSTRAP_TOKEN_LENGTH) return 'not_configured'
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 1024) return 'invalid_token'
  const expected = sha256(configured)
  if (!timingSafeEqual(sha256(presented), expected)) return 'invalid_token'
  const digest = expected.toString('hex')

  const outcome = await grantFirstPlatformAdmin(pool, userId, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO platform_admin_bootstrap_token_uses (token_sha256, user_id) VALUES ($1, $2)
       ON CONFLICT (token_sha256) DO NOTHING`,
      [digest, userId],
    )
    return (rowCount ?? 0) > 0
  })
  if (outcome === 'precondition_failed') return 'already_used'
  if (!outcome) return 'admin_exists'
  await appendAudit(pool, {
    orgId: null,
    actorUserId: 'system',
    action: 'platform_admin.bootstrap_grant',
    targetKind: 'user',
    targetId: userId,
    detail: { via: 'token' },
  })
  return 'granted'
}

/**
 * Set `is_platform_admin` on `userId` iff no platform admin exists, under a
 * table lock so two racing bootstraps cannot both see "no admin yet".
 * `precondition` runs inside the same transaction after the no-admin check;
 * answering false rolls everything back. Returns true on a grant, false when
 * an admin already exists (or the user row is gone), and 'precondition_failed'
 * when `precondition` refused.
 */
async function grantFirstPlatformAdmin(
  pool: Pool,
  userId: string,
  precondition?: (client: PoolClient) => Promise<boolean>,
): Promise<boolean | 'precondition_failed'> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
    const { rows: existingAdmins } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE is_platform_admin = true'
    )
    if ((existingAdmins[0]?.n ?? 0) > 0) {
      await client.query('ROLLBACK')
      return false
    }
    if (precondition && !(await precondition(client))) {
      await client.query('ROLLBACK')
      return 'precondition_failed'
    }
    const { rowCount } = await client.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [userId])
    if ((rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
