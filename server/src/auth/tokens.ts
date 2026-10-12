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

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import type { Request, Response } from 'express'

/**
 * Session JWT issue/verify + httpOnly cookie helpers.
 *
 * The SPA never holds a bearer token in JS-readable storage — the session
 * lives ONLY in the `maplespire_session` httpOnly cookie (docs/auth-setup.md
 * "Sessions/tokens"). `AUTH_SECRET` is read lazily (not at module load) so
 * importing this module with no auth env set has zero side effects; the
 * error only fires the moment something actually tries to sign a session.
 */

export const SESSION_COOKIE_NAME = 'maplespire_session'

/** Stashes the impersonating platform admin's PRE-impersonation session token
 * while `maplespire_session` is overwritten with the target's impersonation
 * session ("View as user"). Same attributes as the main session cookie,
 * always 3600s — never longer-lived than the impersonation session itself. */
export const ADMIN_STASH_COOKIE_NAME = 'maplespire_admin_session'

const DEFAULT_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60 // 30 days

/** Claims carried in the session JWT. `epoch` pins the org's auth_epochs
 * value at issuance — a bump invalidates every session minted before it.
 * `imp` is set ONLY on an impersonation session — its absence means "a normal
 * session", so every cookie minted before impersonation existed still
 * verifies unchanged (backward compatible by construction: an old payload
 * simply has no `imp` property, which parses as `undefined`). */
export type SessionClaims = {
  userId: string
  orgId: string | null
  isPlatformAdmin: boolean
  epoch: number
  /** Set iff this session was minted by POST /api/platform/impersonate.
   * `by` is the impersonating (platform admin) user's id. */
  imp?: { by: string }
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required to sign a session (set it whenever AUTH != off — see docs/auth-setup.md)'
    )
  }
  return new TextEncoder().encode(secret)
}

function sessionMaxAgeS(): number {
  const raw = process.env.AUTH_SESSION_MAX_AGE_S
  if (!raw) return DEFAULT_SESSION_MAX_AGE_S
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_MAX_AGE_S
}

/**
 * Sign a session JWT (HS256) for the given claims. Throws immediately if
 * `AUTH_SECRET` is unset — a missing secret must fail loud at the point
 * something tries to mint a session, not silently produce an unverifiable
 * token.
 *
 * `maxAgeS` overrides the normal `AUTH_SESSION_MAX_AGE_S`-derived lifetime —
 * used by impersonation sessions, which always expire in 3600s regardless of
 * how long a normal session lives (impersonation auto-expires after 60 min).
 */
export async function signSession(c: SessionClaims, maxAgeS?: number): Promise<string> {
  const secret = getSecret()
  const payload: Record<string, unknown> = {
    userId: c.userId,
    orgId: c.orgId,
    isPlatformAdmin: c.isPlatformAdmin,
    epoch: c.epoch,
  }
  if (c.imp) payload.imp = c.imp
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (maxAgeS ?? sessionMaxAgeS()))
    .sign(secret)
}

/**
 * Verify a session JWT. Returns null on ANY failure — missing/rotated
 * secret, expired token, malformed token, wrong algorithm — never throws.
 * Callers (middleware, /api/auth/me) treat null as "not authenticated".
 */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  let secret: Uint8Array
  try {
    secret = getSecret()
  } catch {
    return null
  }
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.isPlatformAdmin !== 'boolean' ||
      typeof payload.epoch !== 'number' ||
      (payload.orgId !== null && typeof payload.orgId !== 'string')
    ) {
      return null
    }
    // `imp` is OPTIONAL — absent on every session minted before impersonation
    // existed (and on every normal session today), so old cookies keep
    // verifying unchanged. When present it must have the expected shape;
    // anything else (tampered/malformed) rejects the whole token rather than
    // silently dropping just the impersonation marker.
    let imp: { by: string } | undefined
    if (payload.imp !== undefined) {
      const rawImp = payload.imp as Record<string, unknown> | null
      if (!rawImp || typeof rawImp.by !== 'string') return null
      imp = { by: rawImp.by }
    }
    return {
      userId: payload.userId,
      orgId: (payload.orgId as string | null) ?? null,
      isPlatformAdmin: payload.isPlatformAdmin,
      epoch: payload.epoch,
      ...(imp ? { imp } : {}),
    }
  } catch (err) {
    // JWTExpired, JWSSignatureVerificationFailed, JWTInvalid, etc. all mean
    // "not a valid live session" — swallow the specific jose error type,
    // there's nothing a caller can do differently for any of them.
    if (err instanceof joseErrors.JOSEError) return null
    return null
  }
}

/** Manual `Cookie` header parse (no cookie-parser dependency per contract). */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      // Malformed percent-encoding: keep the raw value rather than dropping
      // the cookie outright — verifySession will just reject it as invalid.
      out[name] = value
    }
  }
  return out
}

/** Read the session token from the request's `Cookie` header, or null if absent. */
export function readSessionCookie(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie)
  return cookies[SESSION_COOKIE_NAME] ?? null
}

/** Read an arbitrary named cookie (e.g. `ADMIN_STASH_COOKIE_NAME`) from the
 * request's `Cookie` header, or null if absent. */
export function readNamedCookie(req: Request, name: string): string | null {
  const cookies = parseCookies(req.headers.cookie)
  return cookies[name] ?? null
}

/**
 * `AUTH_COOKIE_SECURE`: `'on'` forces `Secure`; anything else (including the
 * default `'auto'`) derives it from `APP_URL` being https — so local http
 * dev keeps working without the cookie being silently dropped by browsers
 * that require Secure to accept it over http.
 */
function cookieSecure(): boolean {
  const mode = process.env.AUTH_COOKIE_SECURE ?? 'auto'
  if (mode === 'on') return true
  if (mode === 'off') return false
  const appUrl = process.env.APP_URL ?? 'http://localhost:5173'
  try {
    return new URL(appUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function cookieAttrs(maxAgeS?: number): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax']
  if (cookieSecure()) attrs.push('Secure')
  if (maxAgeS !== undefined) attrs.push(`Max-Age=${maxAgeS}`)
  return attrs.join('; ')
}

/** Set the session cookie on the response, honoring `AUTH_SESSION_MAX_AGE_S`. */
export function setSessionCookie(res: Response, token: string): void {
  res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttrs(sessionMaxAgeS())}`)
}

/** Clear the session cookie (logout) — same attributes, immediate expiry. */
export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=; ${cookieAttrs(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}

/** Set an arbitrary named cookie with the same attributes (HttpOnly,
 * SameSite=Lax, conditionally Secure) as the session cookie, for a caller-
 * supplied `maxAgeS`. Used for the impersonation admin-stash cookie
 * (`ADMIN_STASH_COOKIE_NAME`), which is never the main session cookie but
 * must be exactly as unreadable-from-JS and as scoped. */
export function setNamedCookie(res: Response, name: string, token: string, maxAgeS: number): void {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(token)}; ${cookieAttrs(maxAgeS)}`)
}

/** Clear an arbitrary named cookie (mirrors `clearSessionCookie`). */
export function clearNamedCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; ${cookieAttrs(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}
