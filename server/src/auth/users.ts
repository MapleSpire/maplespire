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
import { randomBytes } from 'node:crypto'
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

/**
 * Grants `is_platform_admin` to `userId` iff:
 *   1. `email` matches `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` (case-insensitive), and
 *   2. no platform admin exists yet anywhere.
 *
 * Idempotent and safe to call on every login — it's a no-op once a platform
 * admin exists (whether that admin is this user or someone else). Audited
 * with `actorUserId: 'system'`, so the grant is never an unaudited SQL backdoor.
 * Returns true iff it just granted the flag.
 */
export async function bootstrapPlatformAdmin(pool: Pool, userId: string, email: string): Promise<boolean> {
  const bootstrapEmail = process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL
  if (!bootstrapEmail) return false
  if (bootstrapEmail.toLowerCase() !== email.toLowerCase()) return false

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock out concurrent bootstrap attempts (two logins racing at boot) —
    // without this two requests could both see "no admin yet" and both grant.
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
    const { rows: existingAdmins } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE is_platform_admin = true'
    )
    if ((existingAdmins[0]?.n ?? 0) > 0) {
      await client.query('COMMIT')
      return false
    }
    const { rowCount } = await client.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [userId])
    await client.query('COMMIT')
    if ((rowCount ?? 0) === 0) return false
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  await appendAudit(pool, {
    orgId: null,
    actorUserId: 'system',
    action: 'platform_admin.bootstrap_grant',
    targetKind: 'user',
    targetId: userId,
    detail: { email },
  })
  return true
}
