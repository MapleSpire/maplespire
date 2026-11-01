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

import type { Express, Request, Response } from 'express'
import { pool } from '../db.js'
import { findOrCreateUser, bootstrapPlatformAdmin } from './users.js'
import {
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  sessionEndedPending,
  rememberSessionEnded,
  sessionEndedCookieName,
  clearNamedCookie,
} from './tokens.js'
import { appendAudit } from './audit.js'
import { resolveLoginOrg } from './provisioning.js'
import { isSessionEpochCurrent, mintRefusalBody, signCurrentSession } from './sessionEpoch.js'
import { authStage } from './middleware.js'

// RFC 5322 is a whole universe; this is the same pragmatic "looks like an
// email" shape check used for invite addresses — good enough to reject
// obvious garbage without pretending to be a full validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 320 && EMAIL_RE.test(v)
}


/**
 * DEV-ONLY email/password-less login + the shared logout/me endpoints.
 *
 * `POST /api/auth/dev-login` is 404 unless `AUTH_DEV_LOGIN=on` — never
 * enable in production (docs/auth-setup.md). It exists so the app is
 * testable end-to-end without standing up a real IdP: it finds-or-creates a
 * `dev`-issuer user for the given email, makes them a member of the default
 * org (first-ever member becomes that org's admin), runs the platform-admin
 * bootstrap check, and mints a session cookie exactly like a real OIDC login
 * would.
 */
export function registerAuthRoutes(app: Express): void {
  app.post('/api/auth/dev-login', async (req: Request, res: Response) => {
    if (process.env.AUTH_DEV_LOGIN !== 'on') {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const email = req.body?.email
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'A valid "email" is required' })
      return
    }

    try {
      const subject = email.toLowerCase()
      const user = await findOrCreateUser(pool, { issuer: 'dev', subject, email })

      // Session org selection + first-login provisioning — the SAME shared
      // logic as the OIDC callback (provisioning.ts resolveLoginOrg): a
      // brand-new user without invite intent gets a personal org (admin
      // membership + landscape + starter diagram) here; an invite-intent
      // login stays org-less until acceptance re-pins the session.
      const resolution = await resolveLoginOrg(pool, user, {
        inviteIntent: req.body?.intent === 'invite',
      })
      if (resolution.kind === 'suspended') {
        res.status(403).json({ error: 'org_suspended' })
        return
      }
      const orgId = resolution.kind === 'org' ? resolution.orgId : null

      await bootstrapPlatformAdmin(pool, user.id, user.email)

      // Re-read: bootstrap or the membership insert above may have changed
      // is_platform_admin / role since `user` was fetched.
      const { rows: freshRows } = await pool.query<{ is_platform_admin: boolean }>(
        'SELECT is_platform_admin FROM users WHERE id = $1',
        [user.id]
      )
      const isPlatformAdmin = freshRows[0]?.is_platform_admin ?? user.isPlatformAdmin

      const token = await signCurrentSession(pool, { userId: user.id, orgId, isPlatformAdmin })
      setSessionCookie(res, token)
      res.json({ user: { id: user.id, email: user.email, isPlatformAdmin }, orgId })
    } catch (err) {
      const refused = mintRefusalBody(err)
      if (refused) {
        res.status(403).json(refused)
        return
      }
      console.error('POST /api/auth/dev-login error:', err)
      res.status(500).json({ error: 'Failed to sign in' })
    }
  })

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res)
    // A deliberate sign-out is not "your session ended": drop the marker too.
    clearNamedCookie(res, sessionEndedCookieName())
    res.json({ success: true })
  })

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    const token = readSessionCookie(req)
    if (!token) {
      // No session cookie. If a STALE one was cleared a moment ago (another
      // request of the same page load, or another tab, got there first), say
      // so: the client tells "your access changed" from "never signed in" by
      // this code. The marker is left to expire, so every tab gets the answer.
      if (sessionEndedPending(req)) {
        res.status(401).json({ error: 'Session permissions changed; sign in again', code: 'session_stale' })
        return
      }
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    try {
      const claims = await verifySession(token)
      if (!claims) {
        res.status(401).json({ error: 'Invalid or expired session' })
        return
      }
      if (authStage() === 'on' && !(await isSessionEpochCurrent(pool, claims))) {
        rememberSessionEnded(res)
        clearSessionCookie(res)
        res.status(401).json({ error: 'Session permissions changed; sign in again', code: 'session_stale' })
        return
      }
      const { rows }= await pool.query(
        'SELECT id, email, name, given_name, family_name, locale, is_platform_admin, status FROM users WHERE id = $1',
        [claims.userId]
      )
      if (rows.length === 0) {
        res.status(401).json({ error: 'User no longer exists' })
        return
      }
      const row = rows[0]
      res.json({
        claims,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          givenName: row.given_name,
          familyName: row.family_name,
          locale: row.locale,
          isPlatformAdmin: row.is_platform_admin,
          status: row.status,
        },
      })
    } catch (err) {
      console.error('GET /api/auth/me error:', err)
      res.status(500).json({ error: 'Failed to load session' })
    }
  })

  // Profile edit — given/family name belong to the USER from here on:
  // findOrCreateUser only fills them when NULL, so an IdP refresh can never
  // undo this. A field is updated only when present in the body; an empty
  // string (or null) clears it back to NULL.
  app.patch('/api/me', async (req: Request, res: Response) => {
    const token = readSessionCookie(req)
    if (!token) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    try {
      const claims = await verifySession(token)
      if (!claims) {
        res.status(401).json({ error: 'Invalid or expired session' })
        return
      }

      const normalize = (v: unknown, field: string): string | null | undefined => {
        if (v === undefined) return undefined
        if (v === null) return null
        if (typeof v !== 'string') throw new Error(`"${field}" must be a string`)
        const trimmed = v.trim()
        if (trimmed.length > 100) throw new Error(`"${field}" must be 100 characters or fewer`)
        return trimmed === '' ? null : trimmed
      }
      // Language preference: only our two supported codes, or '' / null to clear
      // (fall back to browser detection). Kept strict so a bad value can't wedge
      // the UI into an unknown locale.
      const normalizeLocale = (v: unknown): string | null | undefined => {
        if (v === undefined) return undefined
        if (v === null) return null
        if (typeof v !== 'string') throw new Error('"locale" must be a string')
        const val = v.trim().toLowerCase()
        if (val === '') return null
        if (val !== 'en' && val !== 'fr') throw new Error('"locale" must be one of: en, fr')
        return val
      }
      let givenName: string | null | undefined
      let familyName: string | null | undefined
      let locale: string | null | undefined
      try {
        givenName = normalize(req.body?.givenName, 'givenName')
        familyName = normalize(req.body?.familyName, 'familyName')
        locale = normalizeLocale(req.body?.locale)
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      if (givenName === undefined && familyName === undefined && locale === undefined) {
        res.status(400).json({ error: 'Nothing to update' })
        return
      }

      const { rows } = await pool.query<{
        id: string
        email: string
        name: string | null
        given_name: string | null
        family_name: string | null
        locale: string | null
        is_platform_admin: boolean
        status: string
      }>(
        `UPDATE users SET
           given_name = CASE WHEN $2 THEN $3 ELSE given_name END,
           family_name = CASE WHEN $4 THEN $5 ELSE family_name END,
           locale = CASE WHEN $6 THEN $7 ELSE locale END
         WHERE id = $1
         RETURNING id, email, name, given_name, family_name, locale, is_platform_admin, status`,
        [
          claims.userId,
          givenName !== undefined,
          givenName ?? null,
          familyName !== undefined,
          familyName ?? null,
          locale !== undefined,
          locale ?? null,
        ]
      )
      if (rows.length === 0) {
        res.status(401).json({ error: 'User no longer exists' })
        return
      }
      const row = rows[0]

      await appendAudit(pool, {
        orgId: claims.orgId,
        actorUserId: claims.userId,
        impersonatorUserId: claims.imp?.by,
        action: 'user.profile-updated',
        targetKind: 'user',
        targetId: claims.userId,
        detail: {
          ...(givenName !== undefined ? { givenName } : {}),
          ...(familyName !== undefined ? { familyName } : {}),
          ...(locale !== undefined ? { locale } : {}),
        },
      })

      res.json({
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          givenName: row.given_name,
          familyName: row.family_name,
          locale: row.locale,
          isPlatformAdmin: row.is_platform_admin,
          status: row.status,
        },
      })
    } catch (err) {
      console.error('PATCH /api/me error:', err)
      res.status(500).json({ error: 'Failed to update profile' })
    }
  })
}
