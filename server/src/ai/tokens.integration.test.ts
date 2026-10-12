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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAiSchema } from './core/schema.js'
import { createAiToken, listAiTokens, revokeAiToken, verifyAiToken, findByRefreshToken } from './core/tokens.js'
import { verifyBearerIdentity } from './core/identity.js'
import { hashToken } from './core/crypto.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * DB-gated token/identity tests — per-suite isolated schema per the
 * db-gated-test-isolation rule (never touch the shared e2e database's rows).
 */
describe.skipIf(!TEST_DATABASE_URL)('ai tokens + bearer identity (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_tokens')
    await ensureAuthSchema(db.pool)
    await ensureAiSchema(db.pool)
    await db.pool.query(
      `INSERT INTO users (id, issuer, subject, email, name, status) VALUES
       ('u1', 'test', 'u1', 'u1@example.com', 'User One', 'active'),
       ('u2', 'test', 'u2', 'u2@example.com', NULL, 'deactivated')`
    )
  }, 60_000)

  afterAll(async () => {
    await db?.teardown()
  })

  it('mints, verifies, lists and revokes a PAT (hash-only storage)', async () => {
    const { token, info } = await createAiToken(db.pool, { userId: 'u1', orgId: 'org1', name: 'laptop' })
    expect(token.startsWith('bvr_')).toBe(true)
    expect(info.tokenPrefix.startsWith('bvr_')).toBe(true)

    // Only the hash is stored.
    const { rows } = await db.pool.query<{ token_hash: string }>(`SELECT token_hash FROM ai_api_tokens WHERE id = $1`, [info.id])
    expect(rows[0].token_hash).toBe(hashToken(token))
    expect(rows[0].token_hash).not.toContain(token.slice(4))

    const verified = await verifyAiToken(db.pool, token)
    expect(verified).toMatchObject({ userId: 'u1', orgId: 'org1', kind: 'pat' })

    const listed = await listAiTokens(db.pool, 'u1')
    expect(listed.map((t) => t.id)).toContain(info.id)

    expect(await revokeAiToken(db.pool, 'u1', info.id)).toBe(true)
    expect(await verifyAiToken(db.pool, token)).toBeNull()
    // revoking someone else's token fails
    expect(await revokeAiToken(db.pool, 'u2', info.id)).toBe(false)
  })

  it('rejects malformed, unknown and expired tokens', async () => {
    expect(await verifyAiToken(db.pool, 'not-a-token')).toBeNull()
    expect(await verifyAiToken(db.pool, 'bvr_0000000000000000000000000000000000000000')).toBeNull()
    const { token } = await createAiToken(db.pool, {
      userId: 'u1',
      orgId: null,
      name: 'expired',
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await verifyAiToken(db.pool, token)).toBeNull()
  })

  it('verifyBearerIdentity hydrates the user and refuses deactivated accounts', async () => {
    const { token } = await createAiToken(db.pool, { userId: 'u1', orgId: 'org1', name: 'id-test' })
    const identity = await verifyBearerIdentity(db.pool, token)
    expect(identity).toMatchObject({ userId: 'u1', orgId: 'org1', via: 'pat', label: 'User One' })

    const { token: deadToken } = await createAiToken(db.pool, { userId: 'u2', orgId: null, name: 'dead' })
    expect(await verifyBearerIdentity(db.pool, deadToken)).toBeNull()
  })

  it('supports OAuth-style rows with refresh lookup and rotation semantics', async () => {
    const refresh = 'bvrr_' + 'a'.repeat(40)
    const { token, info } = await createAiToken(db.pool, {
      userId: 'u1',
      orgId: 'org1',
      name: 'MCP: claude',
      kind: 'oauth',
      clientId: 'client1',
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect((await verifyAiToken(db.pool, token))?.kind).toBe('oauth')
    const byRefresh = await findByRefreshToken(db.pool, refresh)
    expect(byRefresh?.tokenId).toBe(info.id)
    // oauth rows never appear in the user's PAT list
    const listed = await listAiTokens(db.pool, 'u1')
    expect(listed.every((t) => t.kind === 'pat')).toBe(true)
  })
})
