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
 * The OIDC callback's SUCCESS path up to the mint, with the IdP exchange
 * stubbed: a deactivated user holding a live IdP session must be refused
 * (signCurrentSession → user_inactive → `?error=account_inactive`), and an org
 * suspended between resolveLoginOrg and the mint answers `?error=org_suspended`
 * — never `exchange_failed`, and never a session cookie. QA lens, 2026-10-17:
 * the refusal mapping in oidc.ts had no test at all (oidcInvites.test.ts only
 * reaches the error paths before the network).
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  setSessionCookie: vi.fn(),
}))

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
  authorizationCodeGrant: vi.fn(async () => ({
    claims: () => ({ sub: 'idp-sub-1', email: 'person@example.com', email_verified: true }),
  })),
}))
vi.mock('../db.js', () => ({ pool: { query: mocks.query } }))
vi.mock('./users.js', () => ({
  findOrCreateUser: vi.fn(async () => ({ id: 'user-1', email: 'person@example.com', isPlatformAdmin: false, status: 'active' })),
  bootstrapPlatformAdmin: vi.fn(async () => {}),
}))
vi.mock('./provisioning.js', () => ({ resolveLoginOrg: vi.fn(async () => ({ kind: 'org', orgId: 'org-1' })) }))
vi.mock('./audit.js', () => ({ appendAudit: vi.fn(async () => {}) }))
vi.mock('./legal.js', () => ({
  isCurrentLegalVersion: () => true,
  legalRequestAccepted: () => true,
  recordLegalAcceptance: vi.fn(async () => {}),
}))
vi.mock('./tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tokens.js')>()),
  setSessionCookie: mocks.setSessionCookie,
}))

import { registerOidcRoutes } from './oidc.js'

/** The mint's two reads, answered as the database would after the change
 * under test committed; every other query answers empty. */
function database(facts: { userStatus: string; orgStatus: string }) {
  mocks.query.mockImplementation(async (sql: string) => {
    const s = String(sql)
    if (s.includes('SELECT is_platform_admin FROM users')) return { rows: [{ is_platform_admin: false }] }
    if (s.includes('LEFT JOIN auth_global_epochs')) {
      return { rows: [{ id: 'user-1', is_platform_admin: false, status: facts.userStatus, gepoch: '1' }] }
    }
    if (s.includes('FROM orgs o')) return { rows: [{ status: facts.orgStatus, epoch: '1', uepoch: '1', member: true }] }
    return { rows: [] }
  })
}

async function callback(): Promise<Response> {
  const app = express()
  registerOidcRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const attempt = Buffer.from(JSON.stringify({
      provider: 'google', state: 'the-state', nonce: 'n', codeVerifier: 'v', createdAt: Date.now(),
    }), 'utf8').toString('base64url')
    return await fetch(`http://127.0.0.1:${port}/api/auth/callback/google?code=abc&state=the-state`, {
      redirect: 'manual',
      headers: { Cookie: `maplespire_oidc=${attempt}` },
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('GET /api/auth/callback/:provider — a refused mint', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.APP_URL = 'https://app.example.com'
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('control: an active user in an active org completes the sign-in with a session cookie', async () => {
    database({ userStatus: 'active', orgStatus: 'active' })
    const res = await callback()
    expect(res.headers.get('location')).toBe('https://app.example.com/auth/complete')
    expect(mocks.setSessionCookie).toHaveBeenCalledTimes(1)
  })

  it('a deactivated user with a live IdP session is sent to ?error=account_inactive, with no session', async () => {
    database({ userStatus: 'deactivated', orgStatus: 'active' })
    const res = await callback()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://app.example.com/login?error=account_inactive')
    expect(mocks.setSessionCookie).not.toHaveBeenCalled()
  })

  it('an org suspended before the mint is sent to ?error=org_suspended, with no session', async () => {
    database({ userStatus: 'active', orgStatus: 'suspended' })
    const res = await callback()
    expect(res.headers.get('location')).toBe('https://app.example.com/login?error=org_suspended')
    expect(mocks.setSessionCookie).not.toHaveBeenCalled()
  })
})
