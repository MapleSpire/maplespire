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
import { hashPassword } from './passwordCrypto.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  send: vi.fn(),
  findOrCreateUser: vi.fn(),
  bootstrapPlatformAdmin: vi.fn(),
  resolveLoginOrg: vi.fn(),
  signSession: vi.fn(),
  setSessionCookie: vi.fn(),
}))

vi.mock('../db.js', () => ({ pool: { query: mocks.query, connect: mocks.connect } }))
vi.mock('../email/index.js', () => ({ getEmailProvider: () => ({ send: mocks.send }) }))
vi.mock('./users.js', () => ({
  findOrCreateUser: mocks.findOrCreateUser,
  bootstrapPlatformAdmin: mocks.bootstrapPlatformAdmin,
}))
vi.mock('./provisioning.js', () => ({ resolveLoginOrg: mocks.resolveLoginOrg }))
vi.mock('./tokens.js', () => ({ signSession: mocks.signSession, setSessionCookie: mocks.setSessionCookie }))

import { registerPasswordAuthRoutes } from './passwordAuth.js'

async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json())
  registerPasswordAuthRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

describe('email/password auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_PASSWORD_LOGIN = 'on'
    process.env.APP_URL = 'https://maplespire.ca'
    mocks.send.mockResolvedValue({ id: 'mail-1' })
    mocks.findOrCreateUser.mockResolvedValue({
      id: 'user-1', email: 'person@example.com', isPlatformAdmin: false,
      status: 'active', givenName: null, familyName: null,
    })
  })

  afterEach(() => {
    delete process.env.AUTH_PASSWORD_LOGIN
    delete process.env.AUTH_LEGAL_ACCEPTANCE
    delete process.env.APP_URL
  })

  it('rejects authentication unless the current legal version was explicitly accepted when enforcement is enabled', async () => {
    process.env.AUTH_LEGAL_ACCEPTANCE = 'on'

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/auth/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'a secure password' }),
      })
      expect(response.status).toBe(428)
      expect(await response.json()).toMatchObject({ code: 'legal_acceptance_required' })
    })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('records the exact terms and privacy version during registration', async () => {
    process.env.AUTH_LEGAL_ACCEPTANCE = 'on'
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 })

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'a secure password', legalVersion: '2026-08-02' }),
      })
      expect(response.status).toBe(202)
    })

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('terms_accepted_at = now()'), ['user-1', '2026-08-02'])
  })

  it('creates a local credential and emails a raw token while storing only its hash', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 })

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Person@Example.com', password: 'a secure password' }),
      })
      expect(response.status).toBe(202)
    })

    expect(mocks.findOrCreateUser).toHaveBeenCalledWith(expect.anything(), {
      issuer: 'local', subject: 'person@example.com', email: 'person@example.com',
    })
    const tokenInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO email_verification_tokens'))
    expect(tokenInsert).toBeTruthy()
    const storedHash = tokenInsert?.[1]?.[2] as string
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/)
    const sent = mocks.send.mock.calls[0][0] as { to: string; html: string }
    expect(sent.to).toBe('person@example.com')
    expect(sent.html).toContain('https://maplespire.ca/api/auth/verify-email?token=')
    expect(sent.html).not.toContain(storedHash)
  })

  it('refuses a valid password until the email is confirmed', async () => {
    const passwordHash = await hashPassword('a secure password')
    mocks.query.mockResolvedValue({
      rows: [{
        id: 'user-1', email: 'person@example.com', is_platform_admin: false,
        status: 'active', given_name: null, family_name: null,
        password_hash: passwordHash, email_verified_at: null,
      }],
      rowCount: 1,
    })

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/auth/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'a secure password' }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'email_not_verified' })
    })
    expect(mocks.signSession).not.toHaveBeenCalled()
  })

  // QA lens round 2 (2026-10-17): the 403 mapping survived its deletion. The
  // credential check read the user as active; the mint's own read finds them
  // deactivated since — a refusal, answered as one, and no session.
  it('a user deactivated between the credential check and the mint gets a 403 user_inactive and no session', async () => {
    const passwordHash = await hashPassword('a secure password')
    mocks.resolveLoginOrg.mockResolvedValue({ kind: 'org', orgId: 'org-1' })
    mocks.bootstrapPlatformAdmin.mockResolvedValue(undefined)
    mocks.query.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('FROM users u JOIN local_auth_credentials')) {
        return { rows: [{
          id: 'user-1', email: 'person@example.com', is_platform_admin: false,
          status: 'active', given_name: null, family_name: null,
          password_hash: passwordHash, email_verified_at: new Date(),
        }], rowCount: 1 }
      }
      if (s.includes('SELECT is_platform_admin FROM users')) return { rows: [{ is_platform_admin: false }], rowCount: 1 }
      if (s.includes('LEFT JOIN auth_global_epochs')) {
        return { rows: [{ id: 'user-1', is_platform_admin: false, status: 'deactivated', gepoch: '2' }], rowCount: 1 }
      }
      if (s.includes('FROM orgs o')) return { rows: [{ status: 'active', epoch: '1', uepoch: '1', member: true }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/auth/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'a secure password' }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'user_inactive' })
    })
    expect(mocks.signSession).not.toHaveBeenCalled()
    expect(mocks.setSessionCookie).not.toHaveBeenCalled()
  })
})
