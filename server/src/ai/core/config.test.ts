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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiConfigInputError,
  effectiveAiBaseUrl,
  getOrgAiConfigStatus,
  sameAiCredentialTarget,
  saveOrgAiConfig,
  validateAiConfig,
} from './config.js'
import type { Queryable } from '../../readModel/types.js'

describe('validateAiConfig', () => {
  const saved = process.env.AI_KEY_SECRET
  const savedAllowlist = process.env.AI_ALLOWED_BASE_URLS
  beforeEach(() => {
    process.env.AI_KEY_SECRET = 'test-secret'
    process.env.AI_ALLOWED_BASE_URLS = 'http://10.5.0.2:1234/v1,https://models.example.test/v1'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_KEY_SECRET
    else process.env.AI_KEY_SECRET = saved
    if (savedAllowlist === undefined) delete process.env.AI_ALLOWED_BASE_URLS
    else process.env.AI_ALLOWED_BASE_URLS = savedAllowlist
  })

  it('accepts a complete keyed provider config', () => {
    expect(validateAiConfig({ provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-x' }, false)).toBeNull()
  })

  it('rejects unknown providers and missing model', () => {
    expect(validateAiConfig({ provider: 'skynet', model: 'x' }, false)).toMatch(/unknown provider/)
    expect(validateAiConfig({ provider: 'openai', model: '  ' }, false)).toMatch(/model/)
  })

  it('requires a key for hosted providers, but not for local/compatible endpoints', () => {
    expect(validateAiConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, false)).toMatch(/API key/)
    // stored key satisfies the requirement without re-sending it
    expect(validateAiConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, true)).toBeNull()
    // clearing the stored key on a keyed provider is rejected
    expect(validateAiConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: null }, true)).toMatch(/API key/)
    expect(validateAiConfig({ provider: 'lmstudio', model: 'google/gemma-4-12b-qat' }, false)).toMatch(/allowlist/i)
    process.env.AI_ALLOWED_BASE_URLS += ',http://localhost:1234/v1'
    expect(validateAiConfig({ provider: 'lmstudio', model: 'google/gemma-4-12b-qat' }, false)).toBeNull()
  })

  it('requires a valid base URL for openai-compatible', () => {
    expect(validateAiConfig({ provider: 'openai-compatible', model: 'm' }, false)).toMatch(/base URL/i)
    expect(
      validateAiConfig({ provider: 'openai-compatible', model: 'm', baseUrl: 'not a url' }, false)
    ).toMatch(/not a valid URL/)
    expect(
      validateAiConfig({ provider: 'openai-compatible', model: 'm', baseUrl: 'ftp://x' }, false)
    ).toMatch(/http/)
    expect(
      validateAiConfig(
        { provider: 'openai-compatible', model: 'google/gemma-4-12b-qat', baseUrl: 'http://10.5.0.2:1234/v1' },
        false
      )
    ).toBeNull()
    expect(
      validateAiConfig(
        { provider: 'openai-compatible', model: 'm', baseUrl: 'https://unapproved.example/v1' },
        false
      )
    ).toMatch(/allowlist/i)
    expect(
      validateAiConfig({ provider: 'openai', model: 'gpt-5.2', baseUrl: 'https://models.example.test/v1', apiKey: 'sk-x' }, false)
    ).toMatch(/not allowed/i)
  })

  it('normalizes an LM Studio host root to its exact allowlisted /v1 endpoint', () => {
    expect(effectiveAiBaseUrl('lmstudio', 'http://10.5.0.2:1234')).toBe('http://10.5.0.2:1234/v1')
    expect(validateAiConfig({
      provider: 'lmstudio', model: 'google/gemma-4-12b-qat', baseUrl: 'http://10.5.0.2:1234',
    }, false)).toBeNull()
    expect(effectiveAiBaseUrl('openai-compatible', 'http://10.5.0.2:1234')).toBe('http://10.5.0.2:1234')
  })

  it('does not reuse a stored key after the provider or endpoint changes', () => {
    const existing = { provider: 'openai' as const, baseUrl: null }
    expect(validateAiConfig({ provider: 'openai', model: 'gpt-5.2' }, true, existing)).toBeNull()
    expect(validateAiConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, true, existing)).toMatch(/API key/)
    expect(
      validateAiConfig(
        { provider: 'openai-compatible', model: 'm', baseUrl: 'https://models.example.test/v1' },
        true,
        existing
      )
    ).toBeNull()
  })

  it('compares credential endpoints canonically, including the LM Studio effective default', () => {
    expect(sameAiCredentialTarget(
      { provider: 'openai-compatible', baseUrl: 'HTTPS://MODELS.EXAMPLE.TEST:443/v1/' },
      { provider: 'openai-compatible', baseUrl: 'https://models.example.test/v1' }
    )).toBe(true)
    expect(sameAiCredentialTarget(
      { provider: 'lmstudio', baseUrl: null },
      { provider: 'lmstudio', baseUrl: 'http://LOCALHOST:1234/v1/' }
    )).toBe(true)
    expect(sameAiCredentialTarget(
      { provider: 'lmstudio', baseUrl: 'http://10.5.0.2:1234' },
      { provider: 'lmstudio', baseUrl: 'http://10.5.0.2:1234/v1' }
    )).toBe(true)
  })

  it('reports an enabled but newly-disallowed saved config as unconfigured without exposing its URL', async () => {
    const row = {
      provider: 'lmstudio',
      model: 'local-model',
      base_url: null,
      key_hint: null,
      api_key_enc: null,
      enabled: true,
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    }
    const db = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) } as unknown as Queryable
    const status = await getOrgAiConfigStatus(db, 'org-1')
    expect(status).toMatchObject({ configured: false, configurationError: expect.any(String) })
    expect(JSON.stringify(status)).not.toContain('localhost:1234')
  })

  it('preserves an encrypted key under lock when old and new endpoint text is canonically equivalent', async () => {
    const current = {
      provider: 'openai-compatible',
      model: 'old-model',
      base_url: 'HTTPS://MODELS.EXAMPLE.TEST:443/v1/',
      key_hint: '…nary',
      api_key_enc: 'encrypted-canary',
      enabled: true,
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    }
    let writeParams: unknown[] | undefined
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rows: [current], rowCount: 1 }
      if (sql.includes('INSERT INTO org_ai_config')) {
        writeParams = params
        return {
          rows: [{
            ...current,
            model: String(params?.[2]),
            base_url: params?.[3] as string,
            api_key_enc: params?.[4] as string,
            key_hint: params?.[5] as string,
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: null }
    })
    const client = { query, release: vi.fn() }
    const pool = { query, connect: vi.fn(async () => client) } as unknown as Queryable

    const saved = await saveOrgAiConfig(pool, 'org-1', {
      provider: 'openai-compatible',
      model: 'new-model',
      baseUrl: 'https://models.example.test/v1',
    }, 'user-1')

    expect(saved.hasKey).toBe(true)
    expect(writeParams?.[4]).toBe('encrypted-canary')
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']))
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true)
  })

  it('revalidates against the locked row and refuses stale credential reuse', async () => {
    const current = {
      provider: 'anthropic',
      model: 'claude-model',
      base_url: null,
      key_hint: '…nary',
      api_key_enc: 'encrypted-canary',
      enabled: true,
      updated_at: new Date(),
    }
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [current], rowCount: 1 }
      return { rows: [], rowCount: null }
    })
    const client = { query, release: vi.fn() }
    const pool = { query, connect: vi.fn(async () => client) } as unknown as Queryable

    await expect(saveOrgAiConfig(pool, 'org-1', {
      provider: 'openai',
      model: 'gpt-5.2',
    }, 'user-1')).rejects.toBeInstanceOf(AiConfigInputError)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO org_ai_config'))).toBe(false)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('refuses to store a key when the server has no encryption secret', () => {
    delete process.env.AI_KEY_SECRET
    delete process.env.AUTH_SECRET
    expect(validateAiConfig({ provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-x' }, false)).toMatch(
      /AI_KEY_SECRET/
    )
  })
})
