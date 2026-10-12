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
import { randomBytes } from 'node:crypto'
import { pool } from '../db.js'
import { getEmailProvider } from '../email/index.js'
import { verifyEmailAddressEmail } from '../email/templates.js'
import { createDistributedRateLimiter } from '../runtime/rateLimiter.js'
import { RedisUnavailableError } from '../runtime/redis.js'
import { bootstrapPlatformAdmin, findOrCreateUser, type UserRecord } from './users.js'
import { hashPassword, verificationTokenHash, verifyPassword } from './passwordCrypto.js'
import { resolveLoginOrg } from './provisioning.js'
import { setSessionCookie, signSession } from './tokens.js'
import { legalRequestAccepted, recordLegalAcceptance } from './legal.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const VERIFY_TTL_MS = 24 * 60 * 60 * 1_000
const limiter = createDistributedRateLimiter({ maxMemoryKeys: 50_000 })
// Always perform one scrypt check, even for an unknown address, so the most
// obvious account-enumeration timing signal is removed.
const dummyPasswordHash = hashPassword(randomBytes(24).toString('base64url'))

function enabled(): boolean {
  return process.env.AUTH_PASSWORD_LOGIN === 'on'
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 320 && EMAIL_RE.test(email) ? email : null
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128
}

function requestIdentity(req: Request): string {
  const cf = req.header('cf-connecting-ip')
  return cf?.trim() || req.ip || req.socket.remoteAddress || 'unknown'
}

async function rateLimit(req: Request, res: Response, action: string, email?: string): Promise<boolean> {
  const decisions = await Promise.all([
    limiter.consume({ namespace: `password_${action}_ip`, identity: requestIdentity(req), limit: action === 'login' ? 20 : 8, windowMs: 15 * 60_000 }),
    ...(email ? [limiter.consume({ namespace: `password_${action}_email`, identity: email, limit: action === 'login' ? 10 : 4, windowMs: 15 * 60_000 })] : []),
  ])
  const denied = decisions.find((decision) => !decision.allowed)
  if (!denied) return false
  res.setHeader('Retry-After', String(denied.retryAfterSeconds))
  res.status(429).json({ error: 'Too many attempts. Please try again later.', code: 'rate_limited' })
  return true
}

function appUrl(path: string): string {
  return `${(process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}${path}`
}

async function issueVerification(userId: string, email: string): Promise<void> {
  const token = randomBytes(32).toString('base64url')
  const id = randomBytes(12).toString('base64url')
  const hash = verificationTokenHash(token)
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS)
  // Opportunistic maintenance keeps expired/consumed verification metadata
  // from accumulating indefinitely without ever storing the raw token.
  await pool.query(
    `DELETE FROM email_verification_tokens
     WHERE expires_at < now() - interval '30 days'
        OR consumed_at < now() - interval '30 days'`,
  )
  await pool.query('UPDATE email_verification_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [userId])
  await pool.query(
    'INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, hash, expiresAt],
  )
  const message = verifyEmailAddressEmail({
    verificationUrl: appUrl(`/api/auth/verify-email?token=${encodeURIComponent(token)}`),
  })
  await getEmailProvider().send({ to: email, ...message })
}

async function localUser(email: string): Promise<(UserRecord & { passwordHash: string; verified: boolean }) | null> {
  const { rows } = await pool.query<{
    id: string; email: string; is_platform_admin: boolean; status: string
    given_name: string | null; family_name: string | null; password_hash: string; email_verified_at: Date | null
  }>(
    `SELECT u.id, u.email, u.is_platform_admin, u.status, u.given_name, u.family_name,
            c.password_hash, c.email_verified_at
     FROM users u JOIN local_auth_credentials c ON c.user_id = u.id
     WHERE u.issuer = 'local' AND u.subject = $1`,
    [email],
  )
  const row = rows[0]
  return row ? {
    id: row.id, email: row.email, isPlatformAdmin: row.is_platform_admin, status: row.status,
    givenName: row.given_name, familyName: row.family_name, passwordHash: row.password_hash,
    verified: row.email_verified_at !== null,
  } : null
}

async function sessionFor(user: UserRecord, inviteIntent: boolean, res: Response): Promise<{ orgId: string | null; isPlatformAdmin: boolean } | 'suspended'> {
  const resolution = await resolveLoginOrg(pool, user, { inviteIntent })
  if (resolution.kind === 'suspended') return 'suspended'
  const orgId = resolution.kind === 'org' ? resolution.orgId : null
  await bootstrapPlatformAdmin(pool, user.id, user.email)
  const { rows: fresh } = await pool.query<{ is_platform_admin: boolean }>('SELECT is_platform_admin FROM users WHERE id = $1', [user.id])
  const isPlatformAdmin = fresh[0]?.is_platform_admin ?? user.isPlatformAdmin
  let epoch = 1
  if (orgId) {
    const { rows } = await pool.query<{ epoch: number | string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
    epoch = rows[0] ? Number(rows[0].epoch) : 1
  }
  setSessionCookie(res, await signSession({ userId: user.id, orgId, isPlatformAdmin, epoch }))
  return { orgId, isPlatformAdmin }
}

export function registerPasswordAuthRoutes(app: Express): void {
  app.post('/api/auth/register', async (req, res) => {
    if (!enabled()) return void res.status(404).json({ error: 'Not found' })
    if (!legalRequestAccepted(req.body?.legalVersion)) {
      return void res.status(428).json({ error: 'Accept the current Terms of Use and acknowledge the Privacy Statement.', code: 'legal_acceptance_required' })
    }
    const email = normalizedEmail(req.body?.email)
    if (!email || !validPassword(req.body?.password)) {
      return void res.status(400).json({ error: 'A valid email and a password of 12 to 128 characters are required.', code: 'invalid_registration' })
    }
    try {
      if (await rateLimit(req, res, 'register', email)) return
      const existing = await localUser(email)
      let userId = existing?.id ?? null
      if (!existing) {
        const user = await findOrCreateUser(pool, { issuer: 'local', subject: email, email })
        userId = user.id
        await pool.query(
          `INSERT INTO local_auth_credentials (user_id, password_hash) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, await hashPassword(req.body.password)],
        )
        await issueVerification(user.id, email)
      } else if (!existing.verified) {
        await pool.query('UPDATE local_auth_credentials SET password_hash = $2, updated_at = now() WHERE user_id = $1', [existing.id, await hashPassword(req.body.password)])
        await issueVerification(existing.id, email)
      }
      if (userId) await recordLegalAcceptance(pool, userId, req.body?.legalVersion)
      res.status(202).json({ success: true })
    } catch (err) {
      console.error('POST /api/auth/register error:', err)
      res.status(503).json({ error: 'We could not send the confirmation email. Please try again.', code: 'email_send_failed' })
    }
  })

  app.post('/api/auth/resend-verification', async (req, res) => {
    if (!enabled()) return void res.status(404).json({ error: 'Not found' })
    const email = normalizedEmail(req.body?.email)
    if (!email) return void res.status(202).json({ success: true })
    try {
      if (await rateLimit(req, res, 'resend', email)) return
      const user = await localUser(email)
      if (user && !user.verified) await issueVerification(user.id, email)
      res.status(202).json({ success: true })
    } catch (err) {
      console.error('POST /api/auth/resend-verification error:', err)
      res.status(202).json({ success: true })
    }
  })

  app.get('/api/auth/verify-email', async (req, res) => {
    if (!enabled()) return void res.status(404).json({ error: 'Not found' })
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    const client = await pool.connect()
    let verified = false
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM email_verification_tokens
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
        [verificationTokenHash(token)],
      )
      if (rows[0]) {
        await client.query('UPDATE email_verification_tokens SET consumed_at = now() WHERE id = $1', [rows[0].id])
        await client.query('UPDATE local_auth_credentials SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE user_id = $1', [rows[0].user_id])
        verified = true
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      console.error('GET /api/auth/verify-email error:', err)
    } finally {
      client.release()
    }
    res.redirect(303, appUrl(verified ? '/login?verified=1' : '/login?error=verification_failed'))
  })

  app.post('/api/auth/password-login', async (req, res) => {
    if (!enabled()) return void res.status(404).json({ error: 'Not found' })
    if (!legalRequestAccepted(req.body?.legalVersion)) {
      return void res.status(428).json({ error: 'Accept the current Terms of Use and acknowledge the Privacy Statement.', code: 'legal_acceptance_required' })
    }
    const email = normalizedEmail(req.body?.email)
    const password = req.body?.password
    if (!email || typeof password !== 'string' || password.length > 128) {
      try {
        if (!(await rateLimit(req, res, 'login'))) res.status(401).json({ error: 'Invalid email or password.', code: 'invalid_credentials' })
      } catch (err) {
        if (err instanceof RedisUnavailableError) {
          res.status(503).setHeader('Retry-After', '1')
          res.json({ error: 'rate_limit_unavailable', message: 'Sign-in is temporarily unavailable.' })
          return
        }
        throw err
      }
      return
    }
    try {
      if (await rateLimit(req, res, 'login', email)) return
      const user = await localUser(email)
      const passwordMatches = await verifyPassword(password, user?.passwordHash ?? await dummyPasswordHash)
      if (!user || user.status !== 'active' || !passwordMatches) {
        return void res.status(401).json({ error: 'Invalid email or password.', code: 'invalid_credentials' })
      }
      if (!user.verified) return void res.status(403).json({ error: 'Please confirm your email before signing in.', code: 'email_not_verified' })
      await recordLegalAcceptance(pool, user.id, req.body?.legalVersion)
      const session = await sessionFor(user, req.body?.intent === 'invite', res)
      if (session === 'suspended') return void res.status(403).json({ error: 'org_suspended' })
      res.json({ user: { id: user.id, email: user.email, isPlatformAdmin: session.isPlatformAdmin }, orgId: session.orgId })
    } catch (err) {
      console.error('POST /api/auth/password-login error:', err)
      res.status(500).json({ error: 'Failed to sign in.' })
    }
  })
}
