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

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureAiSchema } from './schema.js'
import { deleteOrgAiConfig, saveOrgAiConfig } from './config.js'
import { guardIdleClientErrors } from '../../db/poolErrorGuard.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const pool = DATABASE_URL ? guardIdleClientErrors(new pg.Pool({ connectionString: DATABASE_URL, max: 2 }), 'config') : null
const suite = pool ? describe : describe.skip

suite('org AI config persistence (Postgres)', () => {
  const previousSecret = process.env.AI_KEY_SECRET
  const previousAllowlist = process.env.AI_ALLOWED_BASE_URLS
  let orgId = ''

  beforeAll(async () => {
    await ensureAiSchema(pool!)
  })

  beforeEach(() => {
    orgId = `config-test-${randomUUID()}`
    process.env.AI_KEY_SECRET = 'config-integration-test-secret'
    process.env.AI_ALLOWED_BASE_URLS = 'http://models.example.test/v1,http://other.example.test/v1'
  })

  afterEach(async () => {
    await deleteOrgAiConfig(pool!, orgId)
  })

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.AI_KEY_SECRET
    else process.env.AI_KEY_SECRET = previousSecret
    if (previousAllowlist === undefined) delete process.env.AI_ALLOWED_BASE_URLS
    else process.env.AI_ALLOWED_BASE_URLS = previousAllowlist
    await pool!.end()
  })

  it('preserves a key for a canonically equivalent URL and clears it for a different target', async () => {
    await saveOrgAiConfig(pool!, orgId, {
      provider: 'openai-compatible',
      model: 'model-a',
      baseUrl: 'HTTP://MODELS.EXAMPLE.TEST:80/v1/',
      apiKey: 'pg-canary-key',
    }, 'test-user')
    const { rows: before } = await pool!.query<{ api_key_enc: string }>(
      'SELECT api_key_enc FROM org_ai_config WHERE org_id = $1',
      [orgId]
    )

    const equivalent = await saveOrgAiConfig(pool!, orgId, {
      provider: 'openai-compatible',
      model: 'model-b',
      baseUrl: 'http://models.example.test/v1',
    }, 'test-user')
    const { rows: afterEquivalent } = await pool!.query<{ api_key_enc: string }>(
      'SELECT api_key_enc FROM org_ai_config WHERE org_id = $1',
      [orgId]
    )

    expect(equivalent.hasKey).toBe(true)
    expect(afterEquivalent[0].api_key_enc).toBe(before[0].api_key_enc)

    const changed = await saveOrgAiConfig(pool!, orgId, {
      provider: 'openai-compatible',
      model: 'model-c',
      baseUrl: 'http://other.example.test/v1',
    }, 'test-user')
    expect(changed.hasKey).toBe(false)
  })
})
