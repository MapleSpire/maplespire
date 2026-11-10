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

import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * V0-02 / security finding S1 ("nOAuth"): the public Microsoft provider signs
 * in any Entra tenant through `/common`, and a tenant controls the `email` it
 * presents. Before V0-02 `bootstrapPlatformAdmin` matched that email against
 * PLATFORM_ADMIN_BOOTSTRAP_EMAIL — an address committed in this repository —
 * so on a fresh deployment anyone could sign in through the Microsoft button
 * with it and become platform admin.
 *
 * These tests drive the REAL oidc.ts callback and the REAL users.ts bootstrap
 * (only the IdP exchange and the database are stubbed). The database is a
 * small state machine: `adminGranted` flips when the grant UPDATE is issued,
 * so "was platform admin granted?" is read from what the code asked the
 * database to do, not from a return value.
 */

const state = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  adminExists: false,
  adminGranted: [] as string[],
  tokenUses: new Set<string>(),
  calls: [] as string[],
}))

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  authorizationCodeGrant: vi.fn(async () => ({ claims: () => state.claims })),
}))

async function query(sql: unknown, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> {
  const s = String(sql)
  state.calls.push(s)
  if (s.includes('FROM users WHERE issuer = $1 AND subject = $2')) {
    // The identity the callback looks up: a fresh row per (issuer, subject).
    return {
      rows: [{
        id: `user:${String(params[1])}`, email: String(state.claims.email ?? ''), name: null,
        given_name: null, family_name: null, is_platform_admin: false, status: 'active',
      }],
    }
  }
  if (s.includes('count(*)::int AS n FROM users WHERE is_platform_admin = true')) {
    return { rows: [{ n: state.adminExists || state.adminGranted.length > 0 ? 1 : 0 }] }
  }
  if (s.includes('INSERT INTO platform_admin_bootstrap_token_uses')) {
    const digest = String(params[0])
    if (state.tokenUses.has(digest)) return { rows: [], rowCount: 0 }
    state.tokenUses.add(digest)
    return { rows: [], rowCount: 1 }
  }
  if (s.includes('UPDATE users SET is_platform_admin = true')) {
    state.adminGranted.push(String(params[0]))
    return { rows: [], rowCount: 1 }
  }
  if (s.includes('SELECT is_platform_admin FROM users')) {
    return { rows: [{ is_platform_admin: state.adminGranted.includes(String(params[0])) }] }
  }
  if (s.includes('FROM org_members om')) return { rows: [{ org_id: 'org-1', status: 'active', last_org_id: null }] }
  if (s.includes('LEFT JOIN auth_global_epochs')) {
    const ids = params[0] as string[]
    return {
      rows: ids.map((id) => ({ id, is_platform_admin: state.adminGranted.includes(id), status: 'active', gepoch: '1' })),
    }
  }
  if (s.includes('FROM orgs o')) return { rows: [{ status: 'active', epoch: '1', uepoch: '1', member: true }] }
  return { rows: [] }
}

vi.mock('../db.js', () => ({
  pool: {
    query: (sql: unknown, params?: unknown[]) => query(sql, params),
    connect: async () => ({ query: (sql: unknown, params?: unknown[]) => query(sql, params), release: () => {} }),
  },
}))
vi.mock('./audit.js', () => ({ appendAudit: vi.fn(async () => {}) }))

import { pool } from '../db.js'
import { registerOidcRoutes } from './oidc.js'
import { registerAuthRoutes } from './devLogin.js'
import { bootstrapPlatformAdmin, redeemPlatformAdminBootstrapToken } from './users.js'

const ENTRA_COMMON = 'https://login.microsoftonline.com/common/v2.0'
const OWNER_EMAIL = 'owner@maplespire.example'
const ATTACKER_TID = '99999999-8888-4777-8666-555555555555'
const TOKEN = 'b'.repeat(16) + 'ootstrap-token-of-32-chars-or-more'

async function withServer<T>(
  register: (app: express.Express) => void,
  run: (url: string) => Promise<T>,
  auth?: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number; imp?: { by: string } },
): Promise<T> {
  const app = express()
  app.use(express.json())
  if (auth) app.use((req, _res, next) => { req.auth = auth; next() })
  register(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function microsoftSignIn(claims: Record<string, unknown>): Promise<Response> {
  state.claims = claims
  return withServer(registerOidcRoutes, async (url) => {
    const attempt = Buffer.from(JSON.stringify({
      provider: 'microsoft', state: 's', nonce: 'n', codeVerifier: 'v', createdAt: Date.now(),
    }), 'utf8').toString('base64url')
    return fetch(`${url}/api/auth/callback/microsoft?code=abc&state=s`, {
      redirect: 'manual',
      headers: { Cookie: `maplespire_oidc=${attempt}` },
    })
  })
}

const saved = { ...process.env }
beforeEach(() => {
  state.claims = {}
  state.adminExists = false
  state.adminGranted = []
  state.tokenUses = new Set()
  state.calls = []
  process.env.MS_CLIENT_ID = 'ms-id'
  process.env.MS_CLIENT_SECRET = 'ms-secret'
  process.env.APP_URL = 'https://app.example.com'
  process.env.AUTH_SECRET = 'test-secret-for-bootstrap-noauth'
  delete process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL
  delete process.env.PLATFORM_ADMIN_BOOTSTRAP_ISSUER
  delete process.env.PLATFORM_ADMIN_BOOTSTRAP_SUBJECT
  delete process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN
})
afterEach(() => {
  process.env = { ...saved }
})

describe('platform-admin bootstrap never trusts an email (nOAuth)', () => {
  it('a spoofed, unverified Microsoft email equal to PLATFORM_ADMIN_BOOTSTRAP_EMAIL does NOT get platform admin', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL = OWNER_EMAIL
    const res = await microsoftSignIn({ sub: 'attacker-sub', email: OWNER_EMAIL, tid: ATTACKER_TID })
    // The sign-in itself proceeds (it is an ordinary account)…
    expect(res.headers.get('location')).toBe('https://app.example.com/auth/complete')
    // …but nothing was granted, and the bootstrap transaction never even opened.
    expect(state.adminGranted).toEqual([])
    expect(state.calls.some((s) => s.includes('LOCK TABLE users'))).toBe(false)
  })

  it('nor does the same email with xms_edov / email_verified true — an email is not an identity', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL = OWNER_EMAIL
    await microsoftSignIn({ sub: 'other-sub', email: OWNER_EMAIL, tid: ATTACKER_TID, xms_edov: true, email_verified: true })
    expect(state.adminGranted).toEqual([])
  })

  it('the explicit (issuer, subject) grants — and only that subject, whatever email another presents', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_ISSUER = ENTRA_COMMON
    process.env.PLATFORM_ADMIN_BOOTSTRAP_SUBJECT = 'owner-sub'

    await microsoftSignIn({ sub: 'attacker-sub', email: OWNER_EMAIL, tid: ATTACKER_TID })
    expect(state.adminGranted).toEqual([])

    const res = await microsoftSignIn({ sub: 'owner-sub', email: 'whatever@else.example', tid: ATTACKER_TID })
    expect(state.adminGranted).toEqual(['user:owner-sub'])
    expect(res.headers.get('location')).toBe('https://app.example.com/auth/complete')
  })

  it('grants nothing once a platform admin exists', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_ISSUER = ENTRA_COMMON
    process.env.PLATFORM_ADMIN_BOOTSTRAP_SUBJECT = 'owner-sub'
    state.adminExists = true
    await microsoftSignIn({ sub: 'owner-sub', email: OWNER_EMAIL, tid: ATTACKER_TID })
    expect(state.adminGranted).toEqual([])
  })

  it('deprecated PLATFORM_ADMIN_BOOTSTRAP_EMAIL still bootstraps the email-keyed dev and local identities only', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL = 'Owner@MapleSpire.example'
    expect(await bootstrapPlatformAdmin(pool, { id: 'g', issuer: 'https://accounts.google.com/', subject: OWNER_EMAIL })).toBe(false)
    expect(await bootstrapPlatformAdmin(pool, { id: 'm', issuer: ENTRA_COMMON, subject: OWNER_EMAIL })).toBe(false)
    expect(state.adminGranted).toEqual([])
    expect(await bootstrapPlatformAdmin(pool, { id: 'd', issuer: 'dev', subject: OWNER_EMAIL })).toBe(true)
    expect(state.adminGranted).toEqual(['d'])
    state.adminGranted = []
    expect(await bootstrapPlatformAdmin(pool, { id: 'l', issuer: 'local', subject: OWNER_EMAIL })).toBe(true)
    expect(state.adminGranted).toEqual(['l'])
  })
})

describe('one-time out-of-band bootstrap token', () => {
  it('is inert unless configured with at least 32 characters', async () => {
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u1', TOKEN)).toBe('not_configured')
    process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN = 'short-token'
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u1', 'short-token')).toBe('not_configured')
    expect(state.adminGranted).toEqual([])
  })

  it('refuses a wrong token without touching the database', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN = TOKEN
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u1', `${TOKEN}x`)).toBe('invalid_token')
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u1', undefined)).toBe('invalid_token')
    expect(state.calls).toEqual([])
  })

  it('grants once; a second redemption is refused even after the admin is gone', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN = TOKEN
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u1', TOKEN)).toBe('granted')
    expect(state.adminGranted).toEqual(['u1'])
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u2', TOKEN)).toBe('admin_exists')
    state.adminGranted = [] // every platform admin removed later
    expect(await redeemPlatformAdminBootstrapToken(pool, 'u2', TOKEN)).toBe('already_used')
    expect(state.adminGranted).toEqual([])
  })

  it('POST /api/auth/bootstrap-platform-admin: session required, grants and re-mints the session', async () => {
    process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN = TOKEN
    const post = (url: string, token: string) => fetch(`${url}/api/auth/bootstrap-platform-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const anon = await withServer(registerAuthRoutes, (url) => post(url, TOKEN))
    expect(anon.status).toBe(401)

    const auth = { userId: 'u1', orgId: 'org-1', isPlatformAdmin: false, epoch: 1 }
    const wrong = await withServer(registerAuthRoutes, (url) => post(url, 'nope'), auth)
    expect(wrong.status).toBe(403)
    expect(state.adminGranted).toEqual([])

    const ok = await withServer(registerAuthRoutes, (url) => post(url, TOKEN), auth)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ isPlatformAdmin: true })
    expect(ok.headers.get('set-cookie')).toContain('maplespire_session=')
    expect(state.adminGranted).toEqual(['u1'])

    const impersonating = await withServer(registerAuthRoutes, (url) => post(url, TOKEN), { ...auth, imp: { by: 'admin' } })
    expect(impersonating.status).toBe(403)
  })
})
