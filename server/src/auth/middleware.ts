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

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { clearSessionCookie, readSessionCookie, verifySession, type SessionClaims } from './tokens.js'
import { AsyncSingleFlight } from '../performance/asyncSingleFlight.js'

/**
 * `req.auth` is populated by `requireAuth()` whenever a valid session cookie
 * is present (stage 'dual' or 'on'). Declaration merging so every route
 * handler in the app can read `req.auth` without an import cycle.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: SessionClaims
    }
  }
}

export type AuthStage = 'off' | 'dual' | 'on'

const VALID_STAGES = new Set<AuthStage>(['off', 'dual', 'on'])

// Throttle the "invalid/missing session in dual stage" log to once/minute so
// an unconverted client hammering the API doesn't flood stdout — the signal
// ("some clients are still unauthenticated") doesn't need one line per request.
let lastDualWarnAt = 0
const DUAL_WARN_THROTTLE_MS = 60_000
const sessionVerificationFlights = new AsyncSingleFlight()

/**
 * Rollout stage from the `AUTH` env var. Defaults to 'off' (no
 * auth) and tolerates an unknown value by falling back to
 * 'off' with a one-time-per-process warning — a typo must never accidentally
 * enforce auth on a stack that isn't ready for it.
 */
let warnedUnknownStage = false
export function authStage(): AuthStage {
  const raw = process.env.AUTH
  if (!raw) return 'off'
  if (VALID_STAGES.has(raw as AuthStage)) return raw as AuthStage
  if (!warnedUnknownStage) {
    warnedUnknownStage = true
    console.warn(`Unknown AUTH="${raw}" — falling back to "off". Valid values: off | dual | on.`)
  }
  return 'off'
}

/**
 * Prefixes that are reachable with NO session even when `AUTH=on`: the auth
 * flow itself (dev-login/OIDC/logout/me/invite), health checks, the dev
 * outbox viewer, and share-link resolution (anonymous-by-design capability
 * tokens).
 *
 * IMPORTANT: this middleware is mounted as `app.use('/api', requireAuth())`,
 * so `req.path` INSIDE this handler does NOT include the `/api` prefix —
 * these entries are written relative to that mount point, not the public
 * URL. (Pinned by a test in authCore.test.ts.)
 */
const ALLOWLISTED_PREFIXES = ['/auth/', '/health', '/ready', '/dev/outbox']

/**
 * Impersonation is read-only: any non-GET request on an impersonation session is 403'd EXCEPT
 * the one mutating route an impersonated admin must always be able to reach:
 * exiting the impersonation. `req.path` is relative to the `/api` mount
 * point (see the ALLOWLISTED_PREFIXES comment above) — this compares against
 * that same relative shape, not the public `/api/...` URL.
 */
function isImpersonationWriteExempt(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true
  return req.path === '/auth/impersonate/exit'
}

/** Probes never act on `req.auth`: a cookie riding along must not put a
 * database read in front of a liveness or readiness answer. */
function isSessionCheckExempt(req: Request): boolean {
  return req.path === '/health' || req.path.startsWith('/health/') || req.path === '/ready'
}

/** Routes that read the session cookie themselves, so a failed epoch check
 * may proceed unauthenticated there instead of answering 503. */
function isSessionCheckFailurePassthrough(req: Request): boolean {
  return req.path === '/auth/logout' || req.path === '/auth/me'
}

let lastSessionCheckErrorAt = 0
function logSessionCheckFailure(err: unknown): void {
  const now = Date.now()
  if (now - lastSessionCheckErrorAt < DUAL_WARN_THROTTLE_MS) return
  lastSessionCheckErrorAt = now
  console.error('requireAuth: session epoch check failed (throttled to one line a minute):', err)
}

function isAllowlisted(req: Request): boolean {
  const path = req.path
  if (ALLOWLISTED_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return true
  // Share-link resolution is GET-only and public; mutating a share must
  // still authenticate.
  if (req.method === 'GET' && path.startsWith('/shares/')) return true
  return false
}

/**
 * `app.use('/api', requireAuth())`.
 *
 * - `off`  → no-op, `next()` immediately (zero behavior change).
 * - `dual` → verifies the cookie if present; valid → `req.auth` set. Missing
 *   or invalid does NOT reject — it's logged (throttled) and the request
 *   proceeds unauthenticated, so unconverted clients keep working during a
 *   rollout.
 * - `on`   → same verification, but missing/invalid is a 401 UNLESS the
 *   path is allowlisted.
 *
 * `isSessionCurrent` (stage 'on' only, cookie sessions only — a bearer
 * identity is read fresh by its bridge) refuses a session revoked since it
 * was signed. HTTP routes trust signed claims — `isPlatformAdmin`
 * (workspaceGate.ts, orgRoutes.ts, shares.ts…) and `orgId`
 * (workspaceGate.ts requireLandscapeInOrg reads no membership) — so without
 * it a revoked platform admin's cookie kept cross-org admin for its 30-day
 * life, a deactivated user's kept working, and a removed member's kept
 * reading the org's landscape snapshots. A stale session is a 401
 * `session_stale` (an allowlisted path proceeds unauthenticated instead, so
 * logout, /auth/me and the sign-in routes still answer). A failed check is a
 * 503 — fail closed, never admitted — except on logout and /auth/me, which
 * read the cookie themselves. /health and /ready skip the check.
 */
export interface RequireAuthOptions {
  isSessionCurrent?: (claims: SessionClaims) => Promise<boolean>
}

export function requireAuth(options: RequireAuthOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const stage = authStage()
    if (stage === 'off') {
      next()
      return
    }

    // Already authenticated upstream (the AI bearer-token bridge sets
    // `req.auth` from a verified `bvr_` token) — same trust level as a
    // verified cookie, so pass through.
    if (req.auth) {
      next()
      return
    }

    const allowlisted = isAllowlisted(req)
    const token = readSessionCookie(req)
    if (!token) {
      if (stage === 'on' && !allowlisted) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }
      if (stage === 'dual' && !allowlisted) logDualMiss(req, 'missing session cookie')
      next()
      return
    }

    sessionVerificationFlights.run(token, () => verifySession(token))
      .then(async (claims) => {
        if (claims && stage === 'on' && options.isSessionCurrent && !isSessionCheckExempt(req)) {
          let current: boolean
          try {
            current = await options.isSessionCurrent(claims)
          } catch (err) {
            logSessionCheckFailure(err)
            // Logout and /auth/me read the cookie themselves; every other
            // route — allowlisted switch-org and invite accept included —
            // would answer a database blip as "signed out".
            if (isSessionCheckFailurePassthrough(req)) {
              next()
              return
            }
            res.status(503).json({ error: 'Session check unavailable' })
            return
          }
          if (!current) {
            if (allowlisted) {
              next()
              return
            }
            clearSessionCookie(res)
            res.status(401).json({ error: 'Session permissions changed; sign in again', code: 'session_stale' })
            return
          }
        }
        if (claims) {
          req.auth = claims
          if (claims.imp && !isImpersonationWriteExempt(req)) {
            res.status(403).json({ error: 'impersonation-read-only' })
            return
          }
          next()
          return
        }
        if (stage === 'on' && !allowlisted) {
          res.status(401).json({ error: 'Invalid or expired session' })
          return
        }
        if (stage === 'dual' && !allowlisted) logDualMiss(req, 'invalid or expired session')
        next()
      })
      .catch((err) => {
        // verifySession is documented to never throw, but a middleware must
        // not become an unhandled rejection regardless — fail the same way
        // an invalid session would.
        console.error('requireAuth: unexpected error verifying session:', err)
        if (stage === 'on' && !allowlisted) {
          res.status(401).json({ error: 'Invalid or expired session' })
          return
        }
        next()
      })
  }
}

function logDualMiss(req: Request, reason: string): void {
  const now = Date.now()
  if (now - lastDualWarnAt < DUAL_WARN_THROTTLE_MS) return
  lastDualWarnAt = now
  console.warn(`[auth:dual] unauthenticated request allowed through (${reason}): ${req.method} ${req.path}`)
}
