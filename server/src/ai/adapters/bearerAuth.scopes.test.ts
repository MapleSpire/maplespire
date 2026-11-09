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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiIdentity } from '../core/identity.js'

/**
 * A `bvr_` bearer token used to
 * authenticate the WHOLE of `/api` as its owning user — its stored `mcp`
 * scope was never checked, so a PAT minted for an MCP host could reach
 * `/api/platform/*`, org administration and token minting. The bridge now
 * honours the scope: `mcp` reaches the AI surface (`/api/ai/*`, the routes
 * the stdio adapter, MCP hosts and documented scripts use) and nothing else,
 * and no scope ever reaches platform administration or token minting.
 */

const verifyBearerIdentity = vi.fn<(db: unknown, token: string) => Promise<AiIdentity | null>>()

vi.mock('../../db.js', () => ({ pool: {} }))
vi.mock('../core/identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/identity.js')>()
  return { ...actual, verifyBearerIdentity: (db: unknown, token: string) => verifyBearerIdentity(db, token) }
})

const { aiBearerBridge } = await import('./bearerAuth.js')
const { routeAllowedForScopes } = await import('../core/tokenScopes.js')

function identity(scopes: string[], isPlatformAdmin = false): AiIdentity {
  return { userId: 'u1', orgId: 'o1', isPlatformAdmin, via: 'pat', scopes, tokenId: 't1' }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/api', aiBearerBridge())
  // Echo who the request was authenticated as; every path answers 200 so a
  // non-200 can only come from the bridge.
  app.use((req, res) => {
    res.json({ auth: req.auth ?? null })
  })
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  verifyBearerIdentity.mockReset()
})

async function call(method: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers })
  const body = (await res.json().catch(() => null)) as { auth?: unknown; error?: string } | null
  return { status: res.status, body, wwwAuthenticate: res.headers.get('www-authenticate') }
}

const BEARER = { Authorization: 'Bearer bvr_test_token' }

describe('bearer bridge honours token scopes', () => {
  it.each([
    ['GET', '/api/landscapes'],
    ['GET', '/api/model/objects'],
    ['GET', '/api/platform/orgs'],
    ['POST', '/api/platform/orgs/o1/suspend'],
    ['GET', '/api/orgs/o1/admin/members'],
    ['PUT', '/api/orgs/o1/ai-config'],
    ['POST', '/api/me/ai-tokens'],
    ['GET', '/api/PLATFORM/orgs'],
  ])('an mcp token is refused on %s %s with 403 insufficient_scope', async (method, path) => {
    verifyBearerIdentity.mockResolvedValue(identity(['mcp']))
    const r = await call(method, path, BEARER)
    expect(r.status).toBe(403)
    expect(r.body?.error).toBe('insufficient_scope')
    expect(r.wwwAuthenticate).toMatch(/^Bearer .*error="insufficient_scope"/)
  })

  it.each([
    ['GET', '/api/ai/tools?format=mcp'],
    ['POST', '/api/ai/tools/get_model'],
    ['POST', '/api/ai/run'],
    ['GET', '/api/ai/skill'],
    ['GET', '/api/ai/status'],
  ])('an mcp token still authenticates %s %s', async (method, path) => {
    verifyBearerIdentity.mockResolvedValue(identity(['mcp']))
    const r = await call(method, path, BEARER)
    expect(r.status).toBe(200)
    expect(r.body?.auth).toMatchObject({ userId: 'u1' })
  })

  it('a platform admin token is still refused on /api/platform', async () => {
    verifyBearerIdentity.mockResolvedValue(identity(['mcp'], true))
    const r = await call('GET', '/api/platform/orgs', BEARER)
    expect(r.status).toBe(403)
  })

  it('a token with no scope reaches nothing', async () => {
    verifyBearerIdentity.mockResolvedValue(identity([]))
    const r = await call('GET', '/api/ai/tools', BEARER)
    expect(r.status).toBe(403)
  })

  it('an unknown scope grants nothing', async () => {
    verifyBearerIdentity.mockResolvedValue(identity(['admin', 'everything']))
    expect((await call('GET', '/api/landscapes', BEARER)).status).toBe(403)
    expect((await call('GET', '/api/ai/tools', BEARER)).status).toBe(403)
  })

  it('requests without a bearer token are untouched', async () => {
    const r = await call('GET', '/api/platform/orgs')
    expect(r.status).toBe(200)
    expect(r.body?.auth).toBeNull()
    expect(verifyBearerIdentity).not.toHaveBeenCalled()
  })

  it('an invalid bvr_ token still passes through unauthenticated (requireAuth answers)', async () => {
    verifyBearerIdentity.mockResolvedValue(null)
    const r = await call('GET', '/api/platform/orgs', BEARER)
    expect(r.status).toBe(200)
    expect(r.body?.auth).toBeNull()
  })
})

describe('routeAllowedForScopes', () => {
  it('allows the AI surface for mcp, case-insensitively like Express routing', () => {
    expect(routeAllowedForScopes('GET', '/api/ai/tools', ['mcp'])).toBe(true)
    expect(routeAllowedForScopes('POST', '/api/AI/tools/x', ['mcp'])).toBe(true)
    expect(routeAllowedForScopes('GET', '/api/ai', ['mcp'])).toBe(true)
  })

  it('matches whole segments, not prefixes', () => {
    expect(routeAllowedForScopes('GET', '/api/aim/x', ['mcp'])).toBe(false)
    expect(routeAllowedForScopes('GET', '/api/ai-config', ['mcp'])).toBe(false)
  })

  it('refuses dot segments, encoded separators and backslashes', () => {
    for (const p of [
      '/api/ai/../platform/orgs',
      '/api/ai/./tools',
      '/api/ai/%2e%2e/platform/orgs',
      '/api/ai/%2E%2E/platform',
      '/api/ai%2fplatform',
      '/api/ai/tools%2F..%2Fplatform',
      '/api/ai\\..\\platform',
    ]) {
      expect(routeAllowedForScopes('GET', p, ['mcp']), p).toBe(false)
    }
  })

  it('never allows platform administration or token minting, even for a scope covering all of /api', () => {
    const wide = { everything: ['/api'] }
    expect(routeAllowedForScopes('GET', '/api/landscapes', ['everything'], wide)).toBe(true)
    for (const p of [
      '/api/platform',
      '/api/platform/impersonate',
      '/api/Platform/audit',
      '/api/me/ai-tokens',
      '/api/me/ai-tokens/t1',
    ]) {
      expect(routeAllowedForScopes('GET', p, ['everything'], wide), p).toBe(false)
    }
    expect(routeAllowedForScopes('GET', '/api/platformer', ['everything'], wide)).toBe(true)
    expect(routeAllowedForScopes('GET', '/api/me/profile', ['everything'], wide)).toBe(true)
  })

  it('does not resolve scope names through the object prototype', () => {
    expect(routeAllowedForScopes('GET', '/api/ai/tools', ['constructor', 'toString', '__proto__'])).toBe(false)
  })
})
